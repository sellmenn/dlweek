"""
Hurricane Maria Demo — Backend API Server

A standalone Flask server that provides REST API endpoints for the
Post-Crisis Resource Allocation demo. Can be run independently for
integration with any frontend or plugin.

Usage:
    python demo_backend.py [--sample 500] [--model checkpoints/model.pt] [--port 8000]

API Endpoints:
    GET  /api/posts     — Returns all posts with coordinates, captions, timestamps,
                          image URLs, and pre-computed DBSCAN cluster labels.
    GET  /api/predict   — Server-Sent Events (SSE) stream that runs CLIP encoding
                          and model inference on all posts. Streams progress updates,
                          then sends final per-post and per-cluster resource scores.
    GET  /images/<path> — Serves crisis images from the hurricane_maria directory.
    GET  /              — Serves the frontend HTML from demo_output/index.html.

Response Formats:
    GET /api/posts
        {
            "posts": [
                {
                    "lat": 18.45,
                    "lon": -66.07,
                    "caption": "...",
                    "timestamp": 1506000000.0,
                    "date": "2017-09-21 12:00",
                    "image": "/images/25_9_2017/901646074527535105_0.jpg",
                    "cluster": 0
                }, ...
            ],
            "categories": ["infrastructure", "food", "shelter", "sanitation_water", "medication"],
            "clusters": {
                "0": {"name": "San Juan", "centroid": [18.45, -66.07], "count": 120},
                ...
            }
        }

    GET /api/predict  (SSE stream)
        Progress events:
            data: {"type": "progress", "current": 1, "total": 500}
        Final event:
            data: {
                "type": "done",
                "post_scores": [{"infrastructure": 0.82, ...}, ...],
                "cluster_scores": {"0": {"infrastructure": 0.75, ...}, ...}
            }
"""

import argparse
import csv
import hashlib
import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from flask import Flask, jsonify, Response, send_from_directory, send_file
from sklearn.cluster import DBSCAN
import torch

from encoder import CLIPEncoder
from model import RESOURCE_CATEGORIES, load_model

# ── Twitter snowflake helpers ─────────────────────────────────────────────────

TWITTER_EPOCH_MS = 1288834974657


def extract_tweet_id(image_path: str) -> int:
    filename = Path(image_path).stem
    match = re.match(r"(\d+)_\d+", filename)
    return int(match.group(1)) if match else 0


def tweet_id_to_timestamp(tweet_id: int) -> float:
    ms = (tweet_id >> 22) + TWITTER_EPOCH_MS
    return ms / 1000.0


# ── Coordinate assignment ─────────────────────────────────────────────────────

CLUSTER_CENTERS = [
    (18.4500, -66.0700, "San Juan",      2200000, 0.08),
    (18.0111, -66.6141, "Ponce",          160000,  0.04),
    (18.2013, -67.1397, "Mayagüez",       90000,   0.035),
    (18.4725, -66.7156, "Arecibo",        87000,   0.03),
    (18.2341, -66.0485, "Caguas",         130000,  0.04),
    (18.1496, -65.7994, "Humacao",        55000,   0.025),
    (18.3358, -65.6602, "Fajardo",        35000,   0.02),
    (18.1745, -66.9905, "San Germán",     33000,   0.02),
]

# Simplified Puerto Rico coastline polygon (clockwise, ~30 vertices)
PR_POLYGON = [
    (18.515, -67.165), (18.510, -67.030), (18.490, -66.940), (18.500, -66.850),
    (18.485, -66.750), (18.490, -66.600), (18.480, -66.450), (18.475, -66.300),
    (18.470, -66.150), (18.465, -66.050), (18.455, -65.960), (18.445, -65.880),
    (18.400, -65.790), (18.360, -65.640), (18.340, -65.590),
    (18.260, -65.600), (18.160, -65.750), (18.120, -65.840),
    (18.050, -65.900), (17.970, -66.050), (17.960, -66.200), (17.955, -66.400),
    (17.980, -66.560), (17.990, -66.600), (17.970, -66.800), (17.960, -66.950),
    (18.060, -67.100), (18.110, -67.160), (18.170, -67.200), (18.250, -67.190),
    (18.340, -67.200), (18.400, -67.190), (18.460, -67.180),
    (18.515, -67.165),
]


def point_in_polygon(lat, lon, polygon):
    """Ray-casting algorithm for point-in-polygon check."""
    n = len(polygon)
    inside = False
    j = n - 1
    for i in range(n):
        yi, xi = polygon[i]
        yj, xj = polygon[j]
        if ((yi > lat) != (yj > lat)) and (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi):
            inside = not inside
        j = i
    return inside


def assign_coordinates(posts, seed=42):
    rng = np.random.RandomState(seed)
    pops = np.array([c[3] for c in CLUSTER_CENTERS], dtype=float)
    weights = pops / pops.sum()
    cum = np.cumsum(weights)

    for post in posts:
        h = int(hashlib.md5(str(post["tweet_id"]).encode()).hexdigest(), 16)
        frac = (h % 10000) / 10000.0
        idx = min(int(np.searchsorted(cum, frac)), len(CLUSTER_CENTERS) - 1)
        lat, lon, _, _, spread = CLUSTER_CENTERS[idx]
        for _ in range(50):
            new_lat = lat + rng.normal(0, spread)
            new_lon = lon + rng.normal(0, spread)
            if point_in_polygon(new_lat, new_lon, PR_POLYGON):
                break
        else:
            new_lat = lat + rng.normal(0, 0.005)
            new_lon = lon + rng.normal(0, 0.005)
        post["latitude"] = new_lat
        post["longitude"] = new_lon
        post["assigned_center"] = idx
    return posts


def load_hurricane_maria(tsv_path, image_base, sample_n=1000, seed=42):
    posts = []
    with open(tsv_path, "r", encoding="utf-8") as f:
        reader = csv.DictReader(f, delimiter="\t")
        for row in reader:
            image_rel = row.get("image_path", "").strip()
            caption = row.get("tweet_text", "").strip()
            if not image_rel or not caption:
                continue
            parts = image_rel.split("/")
            if len(parts) < 3:
                continue
            local_path = os.path.join(image_base, *parts[2:])
            if not os.path.exists(local_path):
                continue
            tweet_id = extract_tweet_id(image_rel)
            timestamp = tweet_id_to_timestamp(tweet_id) if tweet_id else 0.0
            posts.append({
                "image_path": local_path,
                "caption": caption,
                "tweet_id": tweet_id,
                "timestamp": timestamp,
            })

    posts.sort(key=lambda p: p["timestamp"])
    if 0 < sample_n < len(posts):
        rng = np.random.RandomState(seed)
        indices = sorted(rng.choice(len(posts), sample_n, replace=False))
        posts = [posts[i] for i in indices]

    print(f"Loaded {len(posts)} posts")
    return posts


def nearest_city(lat, lon):
    dists = [((lat - c[0])**2 + (lon - c[1])**2, c[2]) for c in CLUSTER_CENTERS]
    return min(dists, key=lambda x: x[0])[1]


# ── Global state ──────────────────────────────────────────────────────────────

POSTS = []
ENCODER = None
MODEL = None
DEVICE = "cpu"
IMAGE_DIR = "hurricane_maria"
CLUSTER_META = {}

FRONTEND_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "demo_output")

app = Flask(__name__)


# ── DBSCAN ────────────────────────────────────────────────────────────────────

def run_dbscan(eps=0.15, min_samples=3):
    """Run DBSCAN on all posts and store labels + cluster metadata."""
    global CLUSTER_META
    coords = np.array([[p["latitude"], p["longitude"]] for p in POSTS])
    db = DBSCAN(eps=eps, min_samples=min_samples, metric="euclidean")
    labels = db.fit_predict(coords)

    for i, p in enumerate(POSTS):
        p["cluster_label"] = int(labels[i])

    cluster_ids = sorted(set(int(l) for l in labels if l != -1))
    CLUSTER_META = {}
    for cid in cluster_ids:
        members = [p for p in POSTS if p.get("cluster_label") == cid]
        mean_lat = float(np.mean([p["latitude"] for p in members]))
        mean_lon = float(np.mean([p["longitude"] for p in members]))
        CLUSTER_META[str(cid)] = {
            "name": nearest_city(mean_lat, mean_lon),
            "centroid": [mean_lat, mean_lon],
            "count": len(members),
        }
    n_clusters = len(cluster_ids)
    n_noise = int(np.sum(labels == -1))
    print(f"  DBSCAN: {n_clusters} clusters, {n_noise} noise points")


# ── API routes ────────────────────────────────────────────────────────────────

@app.route("/")
def index():
    """Serve the frontend HTML page."""
    return send_file(os.path.join(FRONTEND_DIR, "index.html"))


@app.route("/images/<path:filepath>")
def serve_image(filepath):
    """
    Serve crisis images from the hurricane_maria directory.

    Args:
        filepath: Relative path within the hurricane_maria image directory
                  (e.g., "25_9_2017/901646074527535105_0.jpg")

    Returns:
        The image file with appropriate MIME type.
    """
    return send_from_directory(IMAGE_DIR, filepath)


@app.route("/api/posts")
def api_posts():
    """
    Return all posts with pre-computed DBSCAN cluster labels.

    Returns JSON:
        posts: List of post objects with lat, lon, caption, timestamp, date,
               image URL, and cluster label.
        categories: List of resource category names.
        clusters: Dict mapping cluster ID to metadata (name, centroid, count).
    """
    out = []
    for p in POSTS:
        ts = p["timestamp"]
        date_str = datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%d %H:%M") if ts > 0 else "N/A"
        img_rel = p["image_path"]
        if "hurricane_maria/" in img_rel:
            img_rel = img_rel.split("hurricane_maria/", 1)[1]
        out.append({
            "lat": round(p["latitude"], 6),
            "lon": round(p["longitude"], 6),
            "caption": p["caption"],
            "timestamp": ts,
            "date": date_str,
            "image": f"/images/{img_rel}",
            "cluster": p.get("cluster_label", -1),
        })
    return jsonify({
        "posts": out,
        "categories": RESOURCE_CATEGORIES,
        "clusters": CLUSTER_META,
    })


@app.route("/api/predict")
def api_predict():
    """
    Stream CLIP encoding + model inference via Server-Sent Events (SSE).

    Encodes each post's image and caption with CLIP, runs the trained
    ResourceClassifier, and streams progress. When complete, sends
    per-post scores and per-cluster averaged resource demands.

    SSE Events:
        progress: {"type": "progress", "current": N, "total": M}
        done:     {"type": "done", "post_scores": [...], "cluster_scores": {...}}
    """
    def generate():
        total = len(POSTS)
        MODEL.eval()

        for i, post in enumerate(POSTS):
            img_emb = ENCODER.encode_image(post["image_path"])
            cap_emb = ENCODER.encode_text(post["caption"]) if post["caption"] else torch.zeros(512)
            feature = torch.cat([img_emb, cap_emb], dim=0).unsqueeze(0).to(DEVICE)

            with torch.no_grad():
                scores = MODEL(feature).squeeze(0).cpu().numpy()

            post["resource_scores"] = {cat: round(float(scores[j]), 4) for j, cat in enumerate(RESOURCE_CATEGORIES)}
            yield f"data: {json.dumps({'type': 'progress', 'current': i + 1, 'total': total})}\n\n"

        # Per-cluster averaged scores
        cluster_ids = sorted(set(p.get("cluster_label", -1) for p in POSTS if p.get("cluster_label", -1) != -1))
        cluster_scores = {}
        for cid in cluster_ids:
            members = [p for p in POSTS if p.get("cluster_label") == cid]
            avg = {}
            for cat in RESOURCE_CATEGORIES:
                avg[cat] = round(float(np.mean([p["resource_scores"][cat] for p in members])), 4)
            cluster_scores[str(cid)] = avg

        post_scores = []
        for p in POSTS:
            post_scores.append(p.get("resource_scores", {cat: 0 for cat in RESOURCE_CATEGORIES}))

        yield f"data: {json.dumps({'type': 'done', 'post_scores': post_scores, 'cluster_scores': cluster_scores})}\n\n"

    return Response(generate(), mimetype="text/event-stream")


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Hurricane Maria demo API server")
    parser.add_argument("--sample", type=int, default=1000)
    parser.add_argument("--model", default="checkpoints/model.pt")
    parser.add_argument("--tsv", default="CrisisMMD_v2.0/annotations/hurricane_maria_final_data.tsv")
    parser.add_argument("--image-dir", default="hurricane_maria")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()

    global POSTS, ENCODER, MODEL, DEVICE, IMAGE_DIR

    DEVICE = "cuda" if torch.cuda.is_available() else "mps" if torch.backends.mps.is_available() else "cpu"
    print(f"Device: {DEVICE}")

    IMAGE_DIR = os.path.abspath(args.image_dir)

    print("Loading data...")
    POSTS = load_hurricane_maria(args.tsv, args.image_dir, sample_n=args.sample)
    POSTS = assign_coordinates(POSTS)

    print("Running DBSCAN...")
    run_dbscan()

    print("Loading CLIP encoder...")
    ENCODER = CLIPEncoder(device=DEVICE)

    print("Loading trained model...")
    MODEL = load_model(args.model, device=DEVICE)

    print(f"\nServer starting on http://localhost:{args.port}")
    app.run(host="0.0.0.0", port=args.port, debug=False, threaded=True)


if __name__ == "__main__":
    main()
