# ResNet — Post-Crisis Resource Allocation System

![Architecture Diagram](architecture.png)

An end-to-end machine learning system that analyzes social media posts during and right after disasters to predict emergency resource needs from differing clusters and visualize them on an interactive map for better resource strategization (e.g. how to distribute limited personnel across different victim clusters). Combines multimodal deep learning (CLIP), spatial clustering (DBSCAN), and a trained neural network classifier with a React + Leaflet frontend and LLM-powered crisis summaries.

## Tech Stack

**Backend:** Python, Flask, PyTorch, CLIP ViT-B/32, ViT (damage severity), scikit-learn (DBSCAN), OpenAI API
**Frontend:** React 19, TypeScript, Vite 7, Tailwind CSS 4, Leaflet, Zustand

## Quick Start

### Prerequisites

- Python 3.10+
- Node.js 18+
- (Optional) CUDA-capable GPU or Apple Silicon for faster inference

### Installation

```bash
# Python dependencies
pip install -r requirements.txt

# Frontend dependencies
cd resnet
npm install
```

### Running the Demo

```bash
# Terminal 1 — Backend API server
python demo_backend.py --sample 500 --model checkpoints/model.pt --severity-model checkpoints/vit-crisis-damage-final --port 8000

# Terminal 2 — Frontend dev server
cd resnet
npm run dev
# Open http://localhost:5173
```

### Training a New Model

```bash
# 1. Prepare data from CrisisMMD dataset
python prepare_data.py --crisismmd CrisisMMD_v2.0 --output data/posts.csv

# 2. Generate pseudo-labels with GPT-4o (requires OPENAI_API_KEY in .env)
python generate_labels.py --data-dir CrisisMMD_v2.0 --csv data/posts.csv --output data/labels.json

# 3. Train the resource classifier (leave-one-disaster-out CV + final retrain on all data)
python train.py --labels data/labels.json --data-dir CrisisMMD_v2.0 --epochs 200 --output checkpoints/model.pt

# 4. Train informativeness classifiers (image + text, LODO CV)
python train_informativeness.py --crisismmd CrisisMMD_v2.0 --epochs 100
```

## Architecture

```
Crisis Social Media Posts (image + caption + coordinates)
        │
        ├──────────────────────────────────┐
        ▼                                  ▼
   DBSCAN Clustering                  Per-post inference (streamed via SSE)
   (geographic grouping               ├── CLIP ViT-B/32 Encoder
    at load time)                     │   ├── Image  → 512-dim embedding
                                      │   └── Caption → 512-dim embedding
                                      │         │
                                      │         ▼ concatenate (1024-dim)
                                      │         │
                                      │   ResourceClassifier (MLP: 1024→512→256→5)
                                      │   → [infrastructure, food, shelter,
                                      │      sanitation_water, medication]
                                      │
                                      ├── ViT Damage Severity Classifier (3-class)
                                      │   → little_or_none | mild | severe
                                      │
                                      └── Informativeness Classifiers (512→128→1)
                                          ├── Image informative?  (CLIP image emb)
                                          └── Text informative?   (CLIP text emb)
        │                                  │
        └──────────────────────────────────┘
                        │
                        ▼
          Cluster-level aggregation + weighted severity
          (only informative posts contribute to scores)
                        │
                        ▼
          Flask API (REST + SSE streaming)
                        │
                        ▼
          React Frontend (Leaflet map + real-time visualization)
```

## Key Innovations

1. **GPT-4o Pseudo-Labeling** — Generates continuous (0.0–1.0) resource need scores from crisis images without manual annotation, using carefully designed prompts with scoring guidelines and examples.

2. **Multimodal CLIP Encoding** — Concatenates image and text embeddings from CLIP ViT-B/32 into a 1024-dim feature vector, capturing both visual damage and textual context.

3. **ViT Damage Severity Classification** — A fine-tuned Vision Transformer classifies each post's image into three damage severity levels (little_or_none, mild, severe), replacing heuristic-based severity estimation with learned visual features.

4. **Real-Time SSE Streaming** — Server-Sent Events stream inference progress to the frontend, enabling live marker animation as posts are analyzed.

5. **Interactive Timeline Slider** — After analysis, scrub through posts chronologically to see how resource demands evolve over time, with on-the-fly severity recomputation.

6. **LLM Crisis Summary** — After inference, the `/api/summarize` endpoint sends cluster-level resource scores to an LLM to generate a natural-language situation analysis with actionable insights.

## Training Methodology

### 1. Resource Classifier (`train.py`)

Predicts 5 continuous resource need scores (infrastructure, food, shelter, sanitation/water, medication) per post.

- **Labels:** GPT-4o pseudo-labels — each post is scored 0.0–1.0 per category by prompting GPT-4o with the image and caption (`generate_labels.py`).
- **Features:** CLIP ViT-B/32 image embedding (512-dim) concatenated with text embedding (512-dim) → 1024-dim input vector, precomputed and cached to `data/cached_features.pt`.
- **Architecture:** MLP with layers 1024 → 512 → 256 → 5, ReLU activations, 0.3 dropout, sigmoid output.
- **Loss:** Binary Cross-Entropy (BCE) between pseudo-labels and sigmoid outputs.
- **Validation:** Leave-one-disaster-out (LODO) cross-validation — trains on all disasters except one, validates on the held-out disaster, rotating through all disasters.
- **Sampling:** Disaster-balanced `WeightedRandomSampler` — each sample's weight is the inverse of its disaster's count, ensuring all disasters contribute equally regardless of size.
- **Optimizer:** Adam (lr=1e-3, weight_decay=1e-3) with `ReduceLROnPlateau` (factor=0.5, patience=7).
- **Early stopping:** Patience of 20 epochs on validation loss.
- **Final model:** After CV, retrained on all data and saved to `checkpoints/model.pt`.

### 2. ViT Damage Severity Classifier

Classifies each post's image into three damage severity levels: `little_or_none`, `mild`, `severe`.

- **Architecture:** Fine-tuned Vision Transformer (ViT) saved in HuggingFace format at `checkpoints/vit-crisis-damage-final/`.
- **Training:** Fine-tuned on CrisisMMD damage severity annotations using standard image classification with cross-entropy loss.
- **Inference:** Loaded via HuggingFace `transformers` pipeline at runtime. Severity scores are weighted (0.1, 0.3, 1.0) and averaged per cluster to produce a combined cluster severity.

### 3. Informativeness Classifiers (`train_informativeness.py`)

Two separate binary classifiers determine whether a post's image or text is informative for crisis response. Only posts classified as informative on both modalities contribute to cluster-level resource aggregation.

- **Labels:** CrisisMMD TSV columns `image_info` and `text_info` ("informative" / "not_informative").
- **Features:** CLIP ViT-B/32 embeddings — image classifier uses the 512-dim image embedding, text classifier uses the 512-dim text embedding. Precomputed and cached to `data/cached_info_features.pt`.
- **Architecture:** MLP with layers 512 → 128 → 1, ReLU activation, 0.3 dropout, sigmoid output.
- **Loss:** Binary Cross-Entropy (BCE).
- **Validation:** Leave-one-disaster-out (LODO) cross-validation, same as the resource classifier.
- **Sampling:** Disaster-balanced `WeightedRandomSampler`, same approach as the resource classifier.
- **Optimizer:** Adam (lr=1e-3, weight_decay=1e-3) with `ReduceLROnPlateau` (factor=0.5, patience=7).
- **Early stopping:** Patience of 20 epochs on validation loss.
- **Final models:** Retrained on all data, saved to `checkpoints/info_image.pt` and `checkpoints/info_text.pt`.

## Formulas

**Training Loss — Binary Cross-Entropy (BCE):**

$$\mathcal{L} = -\frac{1}{N} \sum_{i=1}^{N} \sum_{c=1}^{5} \left[ y_{ic} \log(\hat{y}_{ic}) + (1 - y_{ic}) \log(1 - \hat{y}_{ic}) \right]$$

where $y_{ic} \in [0, 1]$ is the GPT-4o pseudo-label and $\hat{y}_{ic}$ is the model's sigmoid output for post $i$, category $c$.

**Balanced Sampling Weight:**

$$w_i = \frac{1}{|\{j : d_j = d_i\}|}$$

Each training sample's weight is the inverse of its disaster's count, so all disasters contribute equally regardless of dataset size.

**Cluster Weighted Severity:**

$$S_k = \frac{1}{|C_k|} \sum_{i \in C_k} w(s_i)$$

where $w(\text{little\_or\_none}) = 0.1$, $w(\text{mild}) = 0.3$, $w(\text{severe}) = 1.0$, and $C_k$ is the set of posts in cluster $k$.

The combined severity label is then:

$$\text{severity}_k = \begin{cases} \text{little\_or\_none} & S_k < 0.20 \\ \text{mild} & 0.20 \leq S_k < 0.30 \\ \text{severe} & S_k \geq 0.30 \end{cases}$$

**Per-Cluster Resource Score:**

$$R_{kc} = \frac{1}{|C_k|} \sum_{i \in C_k} \hat{y}_{ic}$$

The mean of individual post scores per resource category $c$ across all posts in cluster $k$.

**Validation Metric — Mean Absolute Error (MAE):**

$$\text{MAE} = \frac{1}{5} \sum_{c=1}^{5} \frac{1}{N} \sum_{i=1}^{N} |y_{ic} - \hat{y}_{ic}|$$

Averaged first per category, then across all 5 categories.

## Project Structure

```
├── train.py              # Resource classifier training (LODO CV, BCE loss, balanced sampling)
├── train_informativeness.py  # Informativeness classifiers training (image + text, LODO CV)
├── model.py              # ResourceClassifier MLP (1024→512→256→5 with sigmoid)
├── encoder.py            # CLIP ViT-B/32 wrapper for image/text encoding
├── clustering.py         # DBSCAN spatial clustering
├── data_collector.py     # Post/Call data structures
├── prepare_data.py       # CrisisMMD TSV → CSV conversion
├── generate_labels.py    # GPT-4o pseudo-labeling script
├── demo_backend.py       # Flask API server with SSE streaming
├── main.py               # Standalone demo script
├── requirements.txt      # Python dependencies
├── resnet/               # React + TypeScript frontend
│   ├── src/
│   │   ├── components/
│   │   │   ├── map/           # Map, PostMarkers, ClusterPopup, AnalysisSidebar, HeatMap
│   │   │   └── widgets/       # GlassCard, StatCard, TimerCard, InferenceWidgets
│   │   ├── types/           # TypeScript interfaces (Post, Cluster, Crisis)
│   │   ├── store/           # Zustand stores (posts, predict, map, filter, crisis)
│   │   └── hooks/           # Custom hooks (usePosts, useCrisisData)
│   ├── package.json
│   └── vite.config.ts
├── CrisisMMD_v2.0/       # Dataset (not included)
├── checkpoints/
│   ├── model.pt                    # ResourceClassifier weights
│   ├── info_image.pt               # Image informativeness classifier weights
│   ├── info_text.pt                # Text informativeness classifier weights
│   └── vit-crisis-damage-final/    # ViT severity classifier (HuggingFace format)
└── documentation/        # LaTeX documentation
```

## Dataset

Uses [CrisisMMD](https://crisisnlp.qcri.org/crisismmd), a multimodal crisis dataset covering 7 major 2017 disasters: Hurricane Harvey, Hurricane Irma, Hurricane Maria, Mexico Earthquake, Iraq-Iran Earthquake, California Wildfires, and Sri Lanka Floods.

## API Endpoints

| Endpoint         | Method | Description                                                       |
| ---------------- | ------ | ----------------------------------------------------------------- |
| `/api/disasters` | GET    | Lists available disasters with max post counts                    |
| `/api/load`      | GET    | Switches active disaster and sample size (`?disaster=...&sample=...`) |
| `/api/posts`     | GET    | Returns all posts with cluster assignments                        |
| `/api/predict`   | GET    | SSE stream — runs inference on all posts, streams progress events |
| `/api/summarize` | POST   | Generates an LLM-powered crisis situation summary                 |
| `/images/<path>` | GET    | Serves post images from the dataset                               |

## Environment Variables

```
OPENAI_API_KEY=sk-...   # Required for generate_labels.py and /api/summarize
```
