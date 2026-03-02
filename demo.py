"""
Hurricane Maria Demo: Interactive 3-phase resource allocation pipeline.

Usage:
    python demo.py [--sample 500] [--model checkpoints/model.pt] [--port 8000]

Opens a browser with:
    Phase 1: Social media posts appear sequentially on a real map (unclustered)
    Phase 2: Click "Run DBSCAN" to cluster posts by location
    Phase 3: Click "Run Model" to encode with CLIP and predict resource demands
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
from flask import Flask, jsonify, Response, send_from_directory
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


# Puerto Rico land bounding box (tight)
PR_LAT_MIN, PR_LAT_MAX = 17.92, 18.52
PR_LON_MIN, PR_LON_MAX = -67.27, -65.59


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
        # Keep retrying until point lands on land (within PR bounding box)
        for _ in range(20):
            dlat = rng.normal(0, spread)
            dlon = rng.normal(0, spread)
            new_lat = lat + dlat
            new_lon = lon + dlon
            if PR_LAT_MIN <= new_lat <= PR_LAT_MAX and PR_LON_MIN <= new_lon <= PR_LON_MAX:
                break
        post["latitude"] = np.clip(new_lat, PR_LAT_MIN, PR_LAT_MAX)
        post["longitude"] = np.clip(new_lon, PR_LON_MIN, PR_LON_MAX)
        post["assigned_center"] = idx
    return posts


def load_hurricane_maria(tsv_path, image_base, sample_n=500, seed=42):
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

POSTS = []       # list of post dicts (populated at startup)
ENCODER = None   # CLIPEncoder (loaded at startup)
MODEL = None     # ResourceClassifier (loaded at startup)
DEVICE = "cpu"

app = Flask(__name__)


# ── API routes ────────────────────────────────────────────────────────────────

@app.route("/")
def index():
    return FRONTEND_HTML


@app.route("/api/posts")
def api_posts():
    """Return all posts (no cluster info, no scores)."""
    out = []
    for p in POSTS:
        ts = p["timestamp"]
        date_str = datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%d %H:%M") if ts > 0 else "N/A"
        out.append({
            "lat": round(p["latitude"], 6),
            "lon": round(p["longitude"], 6),
            "caption": p["caption"],
            "timestamp": ts,
            "date": date_str,
        })
    return jsonify({"posts": out, "categories": RESOURCE_CATEGORIES})


@app.route("/api/cluster", methods=["POST"])
def api_cluster():
    """Run DBSCAN and return cluster labels + metadata."""
    coords = np.array([[p["latitude"], p["longitude"]] for p in POSTS])
    db = DBSCAN(eps=0.15, min_samples=3, metric="euclidean")
    labels = db.fit_predict(coords)

    for i, p in enumerate(POSTS):
        p["cluster_label"] = int(labels[i])

    # Build cluster metadata
    cluster_ids = sorted(set(int(l) for l in labels if l != -1))
    clusters = {}
    for cid in cluster_ids:
        members = [p for p in POSTS if p.get("cluster_label") == cid]
        mean_lat = float(np.mean([p["latitude"] for p in members]))
        mean_lon = float(np.mean([p["longitude"] for p in members]))
        clusters[str(cid)] = {
            "name": nearest_city(mean_lat, mean_lon),
            "centroid": [mean_lat, mean_lon],
            "count": len(members),
        }

    # Per-post labels
    post_labels = [int(l) for l in labels]

    return jsonify({
        "labels": post_labels,
        "clusters": clusters,
        "n_clusters": len(cluster_ids),
        "n_noise": int(np.sum(labels == -1)),
    })


@app.route("/api/predict")
def api_predict():
    """Stream CLIP encoding + model inference progress via SSE."""
    def generate():
        total = len(POSTS)
        MODEL.eval()

        for i, post in enumerate(POSTS):
            img_emb = ENCODER.encode_image(post["image_path"])
            cap_emb = ENCODER.encode_text(post["caption"]) if post["caption"] else torch.zeros(512)
            trans_emb = torch.zeros(512)
            feature = torch.cat([img_emb, cap_emb, trans_emb], dim=0).unsqueeze(0).to(DEVICE)

            with torch.no_grad():
                scores = MODEL(feature).squeeze(0).cpu().numpy()

            post["resource_scores"] = {cat: round(float(scores[j]), 4) for j, cat in enumerate(RESOURCE_CATEGORIES)}

            # Send progress update
            yield f"data: {json.dumps({'type': 'progress', 'current': i + 1, 'total': total})}\n\n"

        # Compute final per-cluster averages
        cluster_ids = sorted(set(p.get("cluster_label", -1) for p in POSTS if p.get("cluster_label", -1) != -1))
        cluster_scores = {}
        for cid in cluster_ids:
            members = [p for p in POSTS if p.get("cluster_label") == cid]
            avg = {}
            for cat in RESOURCE_CATEGORIES:
                avg[cat] = round(float(np.mean([p["resource_scores"][cat] for p in members])), 4)
            cluster_scores[str(cid)] = avg

        # Per-post scores
        post_scores = []
        for p in POSTS:
            post_scores.append(p.get("resource_scores", {cat: 0 for cat in RESOURCE_CATEGORIES}))

        yield f"data: {json.dumps({'type': 'done', 'post_scores': post_scores, 'cluster_scores': cluster_scores})}\n\n"

    return Response(generate(), mimetype="text/event-stream")


# ── Frontend HTML ─────────────────────────────────────────────────────────────

FRONTEND_HTML = r"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Hurricane Maria — Resource Allocation Demo</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f1117; color: #e0e0e0; display: flex; height: 100vh; overflow: hidden; }

#sidebar { width: 400px; min-width: 400px; background: #161922; display: flex; flex-direction: column; border-right: 1px solid #2a2d3a; overflow: hidden; }
#sidebar-header { padding: 14px 20px; border-bottom: 1px solid #2a2d3a; }
#sidebar-header h1 { font-size: 16px; font-weight: 700; color: #fff; margin-bottom: 2px; }
#sidebar-header p { font-size: 11px; color: #888; }

/* Pipeline steps */
#pipeline { padding: 8px 20px; border-bottom: 1px solid #2a2d3a; display: flex; gap: 6px; }
.step { display: flex; align-items: center; gap: 6px; flex: 1; padding: 6px 8px; border-radius: 6px; background: #1e2130; }
.step-num { width: 22px; height: 22px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 700; flex-shrink: 0; border: 2px solid #3a3d4a; color: #555; background: transparent; transition: all 0.3s; }
.step.active .step-num { border-color: #6c63ff; color: #6c63ff; background: rgba(108,99,255,0.1); }
.step.done .step-num { border-color: #2ecc71; color: #fff; background: #2ecc71; }
.step-body { flex: 1; }
.step-title { font-size: 10px; font-weight: 600; color: #555; transition: color 0.3s; line-height: 1.3; }
.step.active .step-title, .step.done .step-title { color: #e0e0e0; }
.step-desc { display: none; }

/* Controls */
#controls { padding: 10px 20px; border-bottom: 1px solid #2a2d3a; }
#controls label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: #888; display: block; margin-bottom: 6px; }
#timeline-slider { width: 100%; accent-color: #6c63ff; cursor: pointer; }
#timeline-info { display: flex; justify-content: space-between; margin-top: 6px; font-size: 12px; color: #aaa; }
.btn-row { display: flex; gap: 8px; margin-top: 8px; }
.btn { flex: 1; padding: 6px 12px; border: 1px solid #3a3d4a; border-radius: 6px; background: #1e2130; color: #e0e0e0; font-size: 12px; cursor: pointer; text-align: center; transition: all 0.15s; }
.btn:hover:not(.disabled) { background: #2a2d40; border-color: #6c63ff; }
.btn.active { background: #6c63ff; border-color: #6c63ff; color: #fff; }
.btn.disabled { opacity: 0.35; cursor: not-allowed; pointer-events: none; }
.btn-accent { background: #6c63ff; border-color: #6c63ff; color: #fff; font-weight: 600; }
.btn-accent:hover { background: #5a52e0; }
.btn-accent.disabled { background: #3a3d4a; border-color: #3a3d4a; }
.speed-row { display: flex; gap: 4px; margin-top: 8px; }
.speed-btn { padding: 4px 10px; border: 1px solid #3a3d4a; border-radius: 4px; background: #1e2130; color: #aaa; font-size: 11px; cursor: pointer; }
.speed-btn.active { background: #6c63ff; border-color: #6c63ff; color: #fff; }

/* Progress */
.progress-bar { width: 100%; height: 6px; background: #262938; border-radius: 3px; margin-top: 8px; overflow: hidden; display: none; }
.progress-bar.visible { display: block; }
.progress-fill { height: 100%; background: #6c63ff; border-radius: 3px; transition: width 0.2s; width: 0%; }
.progress-text { font-size: 11px; color: #888; margin-top: 4px; display: none; }
.progress-text.visible { display: block; }

/* Cluster cards */
#cluster-list { flex: 1; overflow-y: auto; padding: 10px 20px; min-height: 0; }
.cluster-card { background: #1e2130; border: 1px solid #2a2d3a; border-radius: 8px; padding: 14px; margin-bottom: 10px; transition: all 0.3s; cursor: pointer; }
.cluster-card:hover { border-color: #6c63ff; }
.cluster-card.highlighted { border-color: #6c63ff; box-shadow: 0 0 12px rgba(108,99,255,0.3); }
.cluster-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
.cluster-name { font-weight: 600; font-size: 14px; }
.cluster-badge { display: flex; align-items: center; gap: 6px; }
.cluster-dot { width: 10px; height: 10px; border-radius: 50%; }
.cluster-count { font-size: 12px; color: #888; background: #262938; padding: 2px 8px; border-radius: 10px; }
.bar-row { display: flex; align-items: center; margin-bottom: 4px; }
.bar-label { width: 100px; font-size: 11px; color: #aaa; text-transform: capitalize; }
.bar-track { flex: 1; height: 8px; background: #262938; border-radius: 4px; overflow: hidden; }
.bar-fill { height: 100%; border-radius: 4px; transition: width 0.6s ease; }
.bar-value { width: 40px; text-align: right; font-size: 11px; color: #aaa; font-variant-numeric: tabular-nums; }

/* Map */
#map-container { flex: 1; position: relative; }
#map { width: 100%; height: 100%; }
#stats-overlay { position: absolute; top: 12px; right: 12px; z-index: 1000; background: rgba(22,25,34,0.92); backdrop-filter: blur(8px); border: 1px solid #2a2d3a; border-radius: 8px; padding: 12px 16px; font-size: 12px; }
#stats-overlay .stat { margin-bottom: 4px; }
#stats-overlay .stat-val { font-weight: 600; color: #6c63ff; }

.leaflet-popup-content-wrapper { background: #1e2130; color: #e0e0e0; border-radius: 8px; border: 1px solid #3a3d4a; }
.leaflet-popup-tip { background: #1e2130; }
.leaflet-popup-content { font-size: 12px; line-height: 1.5; }
.popup-caption { color: #aaa; font-style: italic; margin-bottom: 6px; }
.popup-score { display: flex; justify-content: space-between; font-size: 11px; }

::-webkit-scrollbar { width: 6px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: #3a3d4a; border-radius: 3px; }
</style>
</head>
<body>

<div id="sidebar">
  <div id="sidebar-header">
    <h1>Hurricane Maria</h1>
    <p>Post-Crisis Resource Allocation Demo</p>
  </div>

  <div id="pipeline">
    <div class="step active" id="step-1">
      <div class="step-num">1</div>
      <div class="step-body">
        <div class="step-title">Collect Social Media Posts</div>
        <div class="step-desc">Posts appear on the map chronologically</div>
      </div>
    </div>
    <div class="step" id="step-2">
      <div class="step-num">2</div>
      <div class="step-body">
        <div class="step-title">Run DBSCAN Clustering</div>
        <div class="step-desc">Group nearby posts into geographic clusters</div>
      </div>
    </div>
    <div class="step" id="step-3">
      <div class="step-num">3</div>
      <div class="step-body">
        <div class="step-title">CLIP Encode + Model Inference</div>
        <div class="step-desc">Predict resource demands per cluster</div>
      </div>
    </div>
  </div>

  <div id="controls">
    <label>Timeline</label>
    <input type="range" id="timeline-slider" min="0" max="100" value="0">
    <div id="timeline-info">
      <span id="post-count">0 posts</span>
      <span id="current-date">&mdash;</span>
    </div>
    <div class="btn-row">
      <div class="btn" id="btn-play">&#9654; Play</div>
      <div class="btn" id="btn-reset">Reset</div>
    </div>
    <div class="speed-row">
      <div class="speed-btn" data-speed="200">0.5x</div>
      <div class="speed-btn active" data-speed="100">1x</div>
      <div class="speed-btn" data-speed="50">2x</div>
      <div class="speed-btn" data-speed="20">4x</div>
    </div>

    <div class="btn-row" style="margin-top:10px">
      <div class="btn btn-accent disabled" id="btn-dbscan">Run DBSCAN</div>
      <div class="btn btn-accent disabled" id="btn-model">Run Model</div>
    </div>
    <div class="progress-bar" id="model-progress"><div class="progress-fill" id="model-progress-fill"></div></div>
    <div class="progress-text" id="model-progress-text"></div>
  </div>

  <div id="cluster-list"></div>
</div>

<div id="map-container">
  <div id="map"></div>
  <div id="stats-overlay">
    <div class="stat">Total Posts: <span class="stat-val" id="stat-total">0</span></div>
    <div class="stat">Clusters: <span class="stat-val" id="stat-clusters">&mdash;</span></div>
    <div class="stat">Phase: <span class="stat-val" id="stat-phase">Collecting</span></div>
  </div>
</div>

<script>
const COLORS = ['#e74c3c','#3498db','#2ecc71','#f39c12','#9b59b6','#1abc9c','#e67e22','#e84393','#00cec9','#fd79a8'];
const BAR_COLORS = { infrastructure:'#e74c3c', food:'#f39c12', shelter:'#3498db', sanitation_water:'#2ecc71', medication:'#9b59b6' };
const UNCLUSTERED_COLOR = '#8899aa';

let posts = [], categories = [];
let clusterData = null;   // null until DBSCAN runs
let postScores = null;    // null until model runs
let clusterScores = null; // null until model runs
let markers = [], clusterCircles = {};
let currentIndex = 0, playing = false, animTimer = null, speed = 100;
let phase = 1;  // 1=collecting, 2=clustered, 3=predicted

// Map
const map = L.map('map', { zoomControl: false }).setView([18.25, -66.5], 9);
L.control.zoom({ position: 'bottomright' }).addTo(map);
L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
  attribution: '&copy; OpenStreetMap &copy; CARTO', maxZoom: 19
}).addTo(map);

function clusterColor(label) {
  if (label == null || label < 0) return UNCLUSTERED_COLOR;
  return COLORS[label % COLORS.length];
}

function getPostColor(idx) {
  if (!clusterData) return UNCLUSTERED_COLOR;
  return clusterColor(clusterData.labels[idx]);
}

function showPosts(n) {
  markers.forEach(m => map.removeLayer(m));
  markers = [];

  for (let i = 0; i < n; i++) {
    const p = posts[i];
    const isNew = i >= n - 10;
    const color = getPostColor(i);

    const marker = L.circleMarker([p.lat, p.lon], {
      radius: 6,
      fillColor: color,
      color: isNew ? '#fff' : color,
      weight: isNew ? 2 : 0.5,
      fillOpacity: isNew ? 0.95 : 0.7,
    }).addTo(map);

    let popupHtml = `<div class="popup-caption">${p.caption.substring(0, 140)}${p.caption.length > 140 ? '...' : ''}</div>`;
    popupHtml += `<div style="font-size:11px;color:#888">${p.date}</div>`;

    if (clusterData) {
      const cid = clusterData.labels[i];
      const cname = cid >= 0 ? clusterData.clusters[String(cid)]?.name : 'Noise';
      popupHtml = `<div style="font-weight:600;margin-bottom:4px;color:#fff">Cluster: ${cname}</div>` + popupHtml;
    }

    if (postScores && postScores[i]) {
      popupHtml += '<div style="margin-top:6px">';
      categories.forEach(cat => {
        popupHtml += `<div class="popup-score"><span>${cat.replace('_',' ')}</span><span>${postScores[i][cat].toFixed(2)}</span></div>`;
      });
      popupHtml += '</div>';
    }

    marker.bindPopup(popupHtml, { maxWidth: 280 });
    markers.push(marker);
  }

  const last = n > 0 ? posts[n - 1] : null;
  document.getElementById('post-count').textContent = `${n} posts`;
  document.getElementById('current-date').textContent = last ? last.date : '\u2014';
  document.getElementById('stat-total').textContent = n;
  document.getElementById('timeline-slider').value = n;

  // Enable DBSCAN button once all posts are shown
  if (n >= posts.length && phase === 1) {
    document.getElementById('btn-dbscan').classList.remove('disabled');
  }

  renderClusterCards();
}

function renderClusterCards() {
  const list = document.getElementById('cluster-list');
  list.innerHTML = '';
  if (!clusterData) return;

  const visible = posts.slice(0, currentIndex);
  const clusterIds = Object.keys(clusterData.clusters).map(Number).sort((a,b) => a-b);
  let activeCount = 0;

  // Remove old circles
  Object.values(clusterCircles).forEach(c => map.removeLayer(c));
  clusterCircles = {};

  clusterIds.forEach(cid => {
    const memberIndices = [];
    for (let i = 0; i < currentIndex; i++) {
      if (clusterData.labels[i] === cid) memberIndices.push(i);
    }
    if (memberIndices.length === 0) return;
    activeCount++;

    const meta = clusterData.clusters[String(cid)];

    // Cluster circle
    clusterCircles[cid] = L.circle(meta.centroid, {
      radius: 4000, color: clusterColor(cid), fillColor: clusterColor(cid),
      fillOpacity: 0.08, weight: 1.5, opacity: 0.4, dashArray: '6 4',
    }).addTo(map);

    const card = document.createElement('div');
    card.className = 'cluster-card';

    let barsHtml = '';
    if (clusterScores && clusterScores[String(cid)]) {
      const scores = clusterScores[String(cid)];
      categories.forEach(cat => {
        const val = scores[cat];
        const pct = (val * 100).toFixed(1);
        barsHtml += `<div class="bar-row">
          <span class="bar-label">${cat.replace('_',' ')}</span>
          <div class="bar-track"><div class="bar-fill" style="width:${pct}%;background:${BAR_COLORS[cat]}"></div></div>
          <span class="bar-value">${val.toFixed(2)}</span>
        </div>`;
      });
    }

    card.innerHTML = `
      <div class="cluster-header">
        <div class="cluster-badge">
          <div class="cluster-dot" style="background:${clusterColor(cid)}"></div>
          <span class="cluster-name">${meta.name}</span>
        </div>
        <span class="cluster-count">${memberIndices.length} posts</span>
      </div>
      ${barsHtml}
    `;

    card.addEventListener('click', () => {
      map.flyTo(meta.centroid, 12, { duration: 0.8 });
      document.querySelectorAll('.cluster-card').forEach(c => c.classList.remove('highlighted'));
      card.classList.add('highlighted');
    });

    list.appendChild(card);
  });

  document.getElementById('stat-clusters').textContent = activeCount;
}

function setPhase(p) {
  phase = p;
  for (let i = 1; i <= 3; i++) {
    const el = document.getElementById(`step-${i}`);
    el.classList.remove('active', 'done');
    if (i < p) el.classList.add('done');
    else if (i === p) el.classList.add('active');
  }
  const phases = ['', 'Collecting', 'Clustered', 'Predicted'];
  document.getElementById('stat-phase').textContent = phases[p] || '';
}

// Timeline controls
function step() {
  if (currentIndex >= posts.length) { stopPlay(); return; }
  currentIndex = Math.min(currentIndex + 5, posts.length);
  showPosts(currentIndex);
}
function startPlay() {
  playing = true;
  document.getElementById('btn-play').textContent = '\u23F8 Pause';
  document.getElementById('btn-play').classList.add('active');
  animTimer = setInterval(step, speed);
}
function stopPlay() {
  playing = false;
  document.getElementById('btn-play').textContent = '\u25B6 Play';
  document.getElementById('btn-play').classList.remove('active');
  if (animTimer) { clearInterval(animTimer); animTimer = null; }
}

document.getElementById('btn-play').addEventListener('click', () => {
  if (playing) stopPlay(); else startPlay();
});
document.getElementById('btn-reset').addEventListener('click', () => {
  stopPlay();
  currentIndex = 0;
  clusterData = null; postScores = null; clusterScores = null;
  setPhase(1);
  document.getElementById('btn-dbscan').classList.add('disabled');
  document.getElementById('btn-model').classList.add('disabled');
  document.getElementById('model-progress').classList.remove('visible');
  document.getElementById('model-progress-text').classList.remove('visible');
  showPosts(0);
});
document.getElementById('timeline-slider').addEventListener('input', e => {
  stopPlay();
  currentIndex = parseInt(e.target.value);
  showPosts(currentIndex);
});
document.querySelectorAll('.speed-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.speed-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    speed = parseInt(btn.dataset.speed);
    if (playing) { clearInterval(animTimer); animTimer = setInterval(step, speed); }
  });
});

// DBSCAN button
document.getElementById('btn-dbscan').addEventListener('click', async () => {
  const btn = document.getElementById('btn-dbscan');
  if (btn.classList.contains('disabled')) return;
  btn.classList.add('disabled');
  btn.textContent = 'Clustering...';

  const res = await fetch('/api/cluster', { method: 'POST' });
  clusterData = await res.json();

  setPhase(2);
  btn.textContent = 'DBSCAN Done';
  document.getElementById('btn-model').classList.remove('disabled');
  showPosts(currentIndex);
});

// Model button
document.getElementById('btn-model').addEventListener('click', () => {
  const btn = document.getElementById('btn-model');
  if (btn.classList.contains('disabled')) return;
  btn.classList.add('disabled');
  btn.textContent = 'Encoding...';

  const progressBar = document.getElementById('model-progress');
  const progressFill = document.getElementById('model-progress-fill');
  const progressText = document.getElementById('model-progress-text');
  progressBar.classList.add('visible');
  progressText.classList.add('visible');

  const evtSource = new EventSource('/api/predict');
  evtSource.onmessage = (event) => {
    const data = JSON.parse(event.data);

    if (data.type === 'progress') {
      const pct = ((data.current / data.total) * 100).toFixed(1);
      progressFill.style.width = pct + '%';
      progressText.textContent = `Encoding post ${data.current} / ${data.total}`;
    }

    if (data.type === 'done') {
      evtSource.close();
      postScores = data.post_scores;
      clusterScores = data.cluster_scores;
      setPhase(3);
      btn.textContent = 'Inference Done';
      progressFill.style.width = '100%';
      progressText.textContent = 'Complete — resource demands predicted';
      showPosts(currentIndex);
    }
  };
});

// Load posts on startup
fetch('/api/posts')
  .then(r => r.json())
  .then(data => {
    posts = data.posts;
    categories = data.categories;
    document.getElementById('timeline-slider').max = posts.length;
    setPhase(1);
    showPosts(0);
  });
</script>
</body>
</html>"""


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Hurricane Maria demo server")
    parser.add_argument("--sample", type=int, default=500)
    parser.add_argument("--model", default="checkpoints/model.pt")
    parser.add_argument("--tsv", default="CrisisMMD_v2.0/annotations/hurricane_maria_final_data.tsv")
    parser.add_argument("--image-dir", default="hurricane_maria")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()

    global POSTS, ENCODER, MODEL, DEVICE

    DEVICE = "cuda" if torch.cuda.is_available() else "mps" if torch.backends.mps.is_available() else "cpu"
    print(f"Device: {DEVICE}")

    print("Loading data...")
    POSTS = load_hurricane_maria(args.tsv, args.image_dir, sample_n=args.sample)
    POSTS = assign_coordinates(POSTS)

    print("Loading CLIP encoder...")
    ENCODER = CLIPEncoder(device=DEVICE)

    print("Loading trained model...")
    MODEL = load_model(args.model, device=DEVICE)

    print(f"\nServer starting on http://localhost:{args.port}")
    app.run(host="0.0.0.0", port=args.port, debug=False, threaded=True)


if __name__ == "__main__":
    main()
