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
                "cluster_scores": {"0": {"infrastructure": 0.75, "weighted_severity": 0.403, "combined_severity": "mild", ...}, ...}
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

from PIL import Image
from transformers import ViTForImageClassification, ViTImageProcessor

from encoder import CLIPEncoder
from model import RESOURCE_CATEGORIES, load_model
from train_informativeness import InformativenessClassifier

from flask_cors import CORS

app = Flask(__name__)
CORS(app, supports_credentials=True)

# ── Twitter snowflake helpers ─────────────────────────────────────────────────

TWITTER_EPOCH_MS = 1288834974657


def extract_tweet_id(image_path: str) -> int:
    filename = Path(image_path).stem
    match = re.match(r"(\d+)_\d+", filename)
    return int(match.group(1)) if match else 0


def tweet_id_to_timestamp(tweet_id: int) -> float:
    ms = (tweet_id >> 22) + TWITTER_EPOCH_MS
    return ms / 1000.0


# ── Per-disaster geographic configs ───────────────────────────────────────────

DISASTER_CONFIGS = {
    "hurricane_maria": {
        "label": "Hurricane Maria",
        "tsv": "hurricane_maria_final_data.tsv",
        "image_dir": "hurricane_maria",
        "map_center": [18.45, -66.07],
        "map_zoom": 9,
        "eps": 0.06,
        "cluster_centers": [
            (18.4500, -66.0700, "San Juan",      2200000, 0.22),
            (18.0111, -66.6141, "Ponce",          160000,  0.14),
            (18.2013, -67.1397, "Mayagüez",       90000,   0.12),
            (18.4725, -66.7156, "Arecibo",        87000,   0.12),
            (18.2341, -66.0485, "Caguas",         130000,  0.14),
            (18.1496, -65.7994, "Humacao",        55000,   0.10),
            (18.3358, -65.6602, "Fajardo",        35000,   0.08),
            (18.1745, -66.9905, "San Germán",     33000,   0.08),
        ],
        "polygon": [
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
        ],
    },
    "hurricane_irma": {
        "label": "Hurricane Irma",
        "tsv": "hurricane_irma_final_data.tsv",
        "image_dir": "hurricane_irma",
        "map_center": [25.76, -80.19],
        "map_zoom": 7,
        "eps": 0.15,
        "cluster_centers": [
            (25.7617, -80.1918, "Miami",           470000, 0.30),
            (26.1224, -80.1373, "Fort Lauderdale",  183000, 0.20),
            (26.7153, -80.0534, "West Palm Beach",  111000, 0.18),
            (24.5551, -81.7800, "Key West",          25000, 0.10),
            (25.0343, -80.9473, "Key Largo",         10000, 0.10),
            (26.6406, -81.8723, "Fort Myers",        87000, 0.18),
            (27.3364, -82.5307, "Sarasota",          57000, 0.15),
            (27.9506, -82.4572, "Tampa",            400000, 0.25),
        ],
        "polygon": [
            (30.75, -87.60), (30.70, -86.50), (30.50, -85.00), (30.20, -83.50),
            (29.80, -82.00), (29.50, -81.20), (28.80, -80.60), (27.60, -80.30),
            (26.50, -80.05), (25.80, -80.10), (25.20, -80.20), (24.55, -81.80),
            (24.50, -82.10), (25.00, -81.60), (26.00, -81.90), (26.60, -82.20),
            (27.50, -82.80), (28.20, -82.80), (28.90, -83.00), (29.60, -83.50),
            (29.90, -84.50), (30.10, -85.50), (30.40, -86.50), (30.75, -87.60),
        ],
    },
    "mexico_earthquake": {
        "label": "Mexico Earthquake",
        "tsv": "mexico_earthquake_final_data.tsv",
        "image_dir": "mexico_earthquake",
        "map_center": [19.43, -99.13],
        "map_zoom": 8,
        "eps": 0.08,
        "cluster_centers": [
            (19.4326, -99.1332, "Mexico City",  9200000, 0.25),
            (18.8500, -99.2000, "Cuernavaca",    366000, 0.14),
            (19.0500, -98.2000, "Puebla",       1700000, 0.18),
            (18.3400, -99.5100, "Iguala",        140000, 0.12),
            (18.9200, -99.2300, "Jojutla",        58000, 0.10),
            (19.2900, -99.6600, "Toluca",        900000, 0.15),
        ],
        "polygon": [
            (20.20, -100.50), (20.20, -98.00), (19.80, -97.50), (19.20, -97.00),
            (18.20, -97.50), (17.80, -98.50), (17.80, -99.50), (18.00, -100.50),
            (18.50, -101.00), (19.50, -101.00), (20.20, -100.50),
        ],
    },
}

ACTIVE_DISASTER = "hurricane_maria"


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


def assign_coordinates(posts, config, seed=42):
    centers = config["cluster_centers"]
    polygon = config["polygon"]
    rng = np.random.RandomState(seed)
    pops = np.array([c[3] for c in centers], dtype=float)
    weights = pops / pops.sum()
    cum = np.cumsum(weights)

    for post in posts:
        h = int(hashlib.md5(str(post["tweet_id"]).encode()).hexdigest(), 16)
        frac = (h % 10000) / 10000.0
        idx = min(int(np.searchsorted(cum, frac)), len(centers) - 1)
        lat, lon, _, _, spread = centers[idx]
        for _ in range(50):
            new_lat = lat + rng.normal(0, spread)
            new_lon = lon + rng.normal(0, spread)
            if point_in_polygon(new_lat, new_lon, polygon):
                break
        else:
            new_lat = lat + rng.normal(0, 0.005)
            new_lon = lon + rng.normal(0, 0.005)
        post["latitude"] = new_lat
        post["longitude"] = new_lon
        post["assigned_center"] = idx
    return posts


def load_disaster_posts(tsv_path, image_base, sample_n=1000, seed=42):
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


def nearest_city(lat, lon, config):
    """Return (name, population) of the nearest cluster center."""
    centers = config["cluster_centers"]
    dists = [((lat - c[0])**2 + (lon - c[1])**2, c[2], c[3]) for c in centers]
    best = min(dists, key=lambda x: x[0])
    return best[1], best[2]


# ── Global state ──────────────────────────────────────────────────────────────

POSTS = []
ENCODER = None
MODEL = None
SEVERITY_MODEL = None
SEVERITY_PROCESSOR = None
INFO_IMAGE_MODEL = None
INFO_TEXT_MODEL = None
DEVICE = "cpu"
CLUSTER_META = {}
SAMPLE_N = 500
ANNOTATIONS_DIR = ""

FRONTEND_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "demo_output")


# ── DBSCAN ────────────────────────────────────────────────────────────────────

def run_dbscan(config, min_samples=3):
    """Run DBSCAN on all posts and store labels + cluster metadata."""
    global CLUSTER_META
    eps = config.get("eps", 0.15)
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
        name, population = nearest_city(mean_lat, mean_lon, config)
        CLUSTER_META[str(cid)] = {
            "name": name,
            "centroid": [mean_lat, mean_lon],
            "count": len(members),
            "population": population,
        }
    n_clusters = len(cluster_ids)
    n_noise = int(np.sum(labels == -1))
    print(f"  DBSCAN: {n_clusters} clusters, {n_noise} noise points")


def switch_disaster(disaster_key):
    """Load posts for a disaster and run clustering."""
    global POSTS, ACTIVE_DISASTER, CLUSTER_META
    config = DISASTER_CONFIGS[disaster_key]
    ACTIVE_DISASTER = disaster_key

    tsv_path = os.path.join(ANNOTATIONS_DIR, config["tsv"])
    image_base = os.path.abspath(config["image_dir"])

    print(f"Switching to {config['label']}...")
    POSTS = load_disaster_posts(tsv_path, image_base, sample_n=SAMPLE_N)
    POSTS = assign_coordinates(POSTS, config)
    CLUSTER_META = {}
    run_dbscan(config)


# ── API routes ────────────────────────────────────────────────────────────────

@app.route("/")
def index():
    """Serve the frontend HTML page."""
    return send_file(os.path.join(FRONTEND_DIR, "index.html"))


@app.route("/images/<path:filepath>")
def serve_image(filepath):
    """Serve crisis images from the active disaster's image directory."""
    config = DISASTER_CONFIGS[ACTIVE_DISASTER]
    image_dir = os.path.abspath(config["image_dir"])
    return send_from_directory(image_dir, filepath)


def count_available_posts(config):
    """Count how many posts have valid images for a disaster config."""
    tsv_path = os.path.join(ANNOTATIONS_DIR, config["tsv"])
    image_base = os.path.abspath(config["image_dir"])
    count = 0
    try:
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
                if os.path.exists(local_path):
                    count += 1
    except FileNotFoundError:
        pass
    return count


@app.route("/api/disasters")
def api_disasters():
    """Return available disasters and the currently active one."""
    return jsonify({
        "disasters": [
            {"key": k, "label": v["label"], "max_posts": count_available_posts(v)}
            for k, v in DISASTER_CONFIGS.items()
        ],
        "active": ACTIVE_DISASTER,
        "sample": SAMPLE_N,
    })


@app.route("/api/load")
def api_load():
    """Switch disaster and/or sample size. Query params: ?disaster=...&sample=..."""
    from flask import request
    global SAMPLE_N
    disaster = request.args.get("disaster", "").strip()
    sample = request.args.get("sample", "").strip()
    if disaster and disaster not in DISASTER_CONFIGS:
        return jsonify({"error": f"Unknown disaster: {disaster}"}), 400
    if sample:
        SAMPLE_N = max(50, min(5000, int(sample)))
    if disaster:
        switch_disaster(disaster)
    else:
        switch_disaster(ACTIVE_DISASTER)
    return jsonify({"status": "ok", "active": ACTIVE_DISASTER, "sample": SAMPLE_N})


@app.route("/api/posts")
def api_posts():
    """Return all posts with pre-computed DBSCAN cluster labels."""
    config = DISASTER_CONFIGS[ACTIVE_DISASTER]
    image_dir_name = config["image_dir"]
    out = []
    for p in POSTS:
        ts = p["timestamp"]
        date_str = datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%d %H:%M") if ts > 0 else "N/A"
        img_rel = p["image_path"].replace("\\", "/")
        needle = f"{image_dir_name}/"
        if needle in img_rel:
            img_rel = img_rel.split(needle, 1)[1]
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
        "map_center": config["map_center"],
        "map_zoom": config["map_zoom"],
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

            # Informativeness classification
            with torch.no_grad():
                img_info = float(INFO_IMAGE_MODEL(img_emb.unsqueeze(0).to(DEVICE)).item())
                txt_info = float(INFO_TEXT_MODEL(cap_emb.unsqueeze(0).to(DEVICE)).item())
            post["informative"] = (img_info >= 0.5 and txt_info >= 0.5)

            # ViT severity classification
            pil_img = Image.open(post["image_path"]).convert("RGB")
            sev_inputs = SEVERITY_PROCESSOR(images=pil_img, return_tensors="pt").to(DEVICE)
            with torch.no_grad():
                sev_logits = SEVERITY_MODEL(**sev_inputs).logits
            sev_probs = torch.softmax(sev_logits, dim=-1).squeeze(0).cpu().numpy()
            sev_pred = int(sev_probs.argmax())
            severity_label = SEVERITY_MODEL.config.id2label[sev_pred]
            severity_score = float(sev_probs[sev_pred])
            post["severity_score"] = round(severity_score, 4)
            post["severity_label"] = severity_label

            yield f"data: {json.dumps({'type': 'progress', 'current': i + 1, 'total': total, 'cluster': post.get('cluster_label', -1), 'severity_label': severity_label, 'scores': post['resource_scores'], 'informative': post['informative']})}\n\n"

        # Per-cluster averaged scores + severity
        SEVERITY_WEIGHTS = {"little_or_none": 0.1, "mild": 0.3, "severe": 1.0}
        cluster_ids = sorted(set(p.get("cluster_label", -1) for p in POSTS if p.get("cluster_label", -1) != -1))
        cluster_scores = {}
        for cid in cluster_ids:
            all_members = [p for p in POSTS if p.get("cluster_label") == cid]
            members = [p for p in all_members if p.get("informative", False)]
            if not members:
                members = all_members  # fallback if no informative posts in cluster
            avg = {}
            for cat in RESOURCE_CATEGORIES:
                avg[cat] = round(float(np.mean([p["resource_scores"][cat] for p in members])), 4)

            # Weighted severity: average of numeric severity weights across members
            weighted_severity = float(np.mean([SEVERITY_WEIGHTS[p["severity_label"]] for p in members]))
            avg["weighted_severity"] = round(weighted_severity, 4)
            if weighted_severity < 0.20:
                avg["combined_severity"] = "little_or_none"
            elif weighted_severity < 0.30:
                avg["combined_severity"] = "mild"
            else:
                avg["combined_severity"] = "severe"

            cluster_scores[str(cid)] = avg

        yield f"data: {json.dumps({'type': 'done', 'cluster_scores': cluster_scores})}\n\n"

    return Response(generate(), mimetype="text/event-stream", headers={
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
    })


@app.route("/api/summarize", methods=["POST"])
def api_summarize():
    """Use OpenAI LLM to summarize crisis analysis data and provide actionable items."""
    from dotenv import load_dotenv
    load_dotenv()
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        return jsonify({"summary": "OpenAI API key not configured."}), 500

    import openai

    data = __import__("flask").request.get_json(force=True)

    disaster_label = DISASTER_CONFIGS[ACTIVE_DISASTER]["label"]
    prompt = f"""You are a crisis response analyst. Based on the following post-disaster analysis data from {disaster_label}, provide a concise situation report with actionable recommendations.

Data:
- Total posts analyzed: {data.get('totalPosts', 0)}
- Number of clusters: {data.get('clusterCount', 0)}
- Severity distribution: {json.dumps(data.get('severityDistribution', {}))}
- Cluster details: {json.dumps(data.get('clusters', []))}

Write a brief situation report (3-5 sentences) followed by 3-5 actionable bullet points. Focus on which areas need the most urgent attention, what types of aid are most needed, and priority recommendations.

Example output:
**Situation Report**
Analysis of 500 social media posts reveals significant damage concentration in the San Juan metropolitan area, with severe infrastructure and water/sanitation needs. Three of eight identified clusters show severe conditions requiring immediate intervention.

**Priority Actions**
- Deploy emergency water purification units to Ponce cluster (highest sanitation_water score at 78%)
- Prioritize infrastructure repair crews for San Juan area (65% of severe-rated posts)
- Establish mobile medical stations in Humacao region (medication need score 72%)
- Coordinate food distribution to Mayaguez cluster (food need score 68%)"""

    try:
        client = openai.OpenAI(api_key=api_key)
        response = client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[{"role": "user", "content": prompt}],
            max_tokens=600,
            temperature=0.3,
        )
        summary = response.choices[0].message.content
        return jsonify({"summary": summary})
    except Exception as e:
        return jsonify({"summary": f"Failed to generate summary: {str(e)}"}), 500


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Crisis demo API server")
    parser.add_argument("--sample", type=int, default=500)
    parser.add_argument("--model", default="checkpoints/model.pt")
    parser.add_argument("--severity-model", default="checkpoints/vit-crisis-damage-final")
    parser.add_argument("--info-image-model", default="checkpoints/info_image.pt")
    parser.add_argument("--info-text-model", default="checkpoints/info_text.pt")
    parser.add_argument("--annotations-dir", default="CrisisMMD_v2.0/annotations")
    parser.add_argument("--disaster", default="hurricane_maria", choices=list(DISASTER_CONFIGS.keys()))
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()

    global ENCODER, MODEL, SEVERITY_MODEL, SEVERITY_PROCESSOR, INFO_IMAGE_MODEL, INFO_TEXT_MODEL, DEVICE, SAMPLE_N, ANNOTATIONS_DIR

    DEVICE = "cuda" if torch.cuda.is_available() else "mps" if torch.backends.mps.is_available() else "cpu"
    print(f"Device: {DEVICE}")

    SAMPLE_N = args.sample
    ANNOTATIONS_DIR = args.annotations_dir

    print("Loading data...")
    switch_disaster(args.disaster)

    print("Loading CLIP encoder...")
    ENCODER = CLIPEncoder(device=DEVICE)

    print("Loading trained model...")
    MODEL = load_model(args.model, device=DEVICE)

    print("Loading severity model...")
    SEVERITY_PROCESSOR = ViTImageProcessor.from_pretrained(args.severity_model)
    SEVERITY_MODEL = ViTForImageClassification.from_pretrained(args.severity_model).to(DEVICE)
    SEVERITY_MODEL.eval()

    print("Loading informativeness models...")
    INFO_IMAGE_MODEL = InformativenessClassifier().to(DEVICE)
    INFO_IMAGE_MODEL.load_state_dict(torch.load(args.info_image_model, map_location=DEVICE, weights_only=True))
    INFO_IMAGE_MODEL.eval()
    INFO_TEXT_MODEL = InformativenessClassifier().to(DEVICE)
    INFO_TEXT_MODEL.load_state_dict(torch.load(args.info_text_model, map_location=DEVICE, weights_only=True))
    INFO_TEXT_MODEL.eval()

    print(f"\nServer starting on http://localhost:{args.port}")
    app.run(host="0.0.0.0", port=args.port, debug=False, threaded=True)


if __name__ == "__main__":
    main()
