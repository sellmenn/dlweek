"""
Train binary informativeness classifiers for crisis social media posts.

Trains two separate models:
  - Image informativeness: CLIP image embedding (512-dim) → MLP → sigmoid
  - Text informativeness:  CLIP text embedding  (512-dim) → MLP → sigmoid

Labels come from CrisisMMD TSV columns `image_info` and `text_info`
("informative" vs "not_informative").

Usage:
    python train_informativeness.py --crisismmd CrisisMMD_v2.0 --epochs 100 \
        --output-image checkpoints/info_image.pt --output-text checkpoints/info_text.pt
"""

import argparse
import csv
import os
import re
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
from collections import Counter
from torch.utils.data import DataLoader, Dataset, Subset, WeightedRandomSampler

from encoder import CLIPEncoder, CLIP_DIM


class InformativenessClassifier(nn.Module):
    """Small MLP: 512 → 128 → 1 with sigmoid."""

    def __init__(self, input_dim: int = CLIP_DIM):
        super().__init__()
        self.net = nn.Sequential(
            nn.Linear(input_dim, 128),
            nn.ReLU(),
            nn.Dropout(0.3),
            nn.Linear(128, 1),
            nn.Sigmoid(),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.net(x).squeeze(-1)


def extract_disaster(image_path: str) -> str:
    match = re.match(r"data_image/([^/]+)/", image_path)
    return match.group(1) if match else "unknown"


def load_tsv_labels(crisismmd_dir: str):
    """Read all TSVs and return (image_path, caption, image_info, text_info, disaster) tuples."""
    annotations_dir = os.path.join(crisismmd_dir, "annotations")
    samples = []
    for tsv_file in sorted(Path(annotations_dir).glob("*.tsv")):
        with open(tsv_file, "r", encoding="utf-8") as f:
            reader = csv.DictReader(f, delimiter="\t")
            for row in reader:
                image_rel = row.get("image_path", "").strip()
                caption = row.get("tweet_text", "").strip()
                image_info = row.get("image_info", "").strip()
                text_info = row.get("text_info", "").strip()
                if not image_rel or not caption:
                    continue
                if image_info not in ("informative", "not_informative"):
                    continue
                if text_info not in ("informative", "not_informative"):
                    continue
                full_path = os.path.join(crisismmd_dir, image_rel)
                if not os.path.exists(full_path):
                    continue
                disaster = extract_disaster(image_rel)
                samples.append({
                    "image_path": full_path,
                    "image_rel": image_rel,
                    "caption": caption,
                    "image_label": 1 if image_info == "informative" else 0,
                    "text_label": 1 if text_info == "informative" else 0,
                    "disaster": disaster,
                })
    return samples


class EmbeddingDataset(Dataset):
    def __init__(self, features: torch.Tensor, labels: torch.Tensor):
        self.features = features
        self.labels = labels

    def __len__(self):
        return len(self.features)

    def __getitem__(self, idx):
        return self.features[idx], self.labels[idx]


def precompute(samples, encoder, crisismmd_dir, cache_path="data/cached_info_features.pt"):
    """Encode all samples with CLIP and cache results."""
    if os.path.exists(cache_path):
        print(f"  Loading cached features from {cache_path}")
        cached = torch.load(cache_path, weights_only=True)
        return cached["image_feats"], cached["text_feats"], cached["image_labels"], cached["text_labels"], cached["disasters"]

    image_feats, text_feats = [], []
    image_labels, text_labels = [], []
    disasters = []

    for i, s in enumerate(samples):
        print(f"  Encoding [{i+1}/{len(samples)}] {s['image_rel']}...")
        img_emb = encoder.encode_image(s["image_path"])
        txt_emb = encoder.encode_text(s["caption"])
        image_feats.append(img_emb)
        text_feats.append(txt_emb)
        image_labels.append(s["image_label"])
        text_labels.append(s["text_label"])
        disasters.append(s["disaster"])

    image_feats = torch.stack(image_feats)
    text_feats = torch.stack(text_feats)
    image_labels = torch.tensor(image_labels, dtype=torch.float32)
    text_labels = torch.tensor(text_labels, dtype=torch.float32)

    os.makedirs(os.path.dirname(cache_path) or ".", exist_ok=True)
    torch.save({
        "image_feats": image_feats, "text_feats": text_feats,
        "image_labels": image_labels, "text_labels": text_labels,
        "disasters": disasters,
    }, cache_path)
    print(f"  Cached to {cache_path}")
    return image_feats, text_feats, image_labels, text_labels, disasters


def balanced_sampler(disasters: list[str]) -> WeightedRandomSampler:
    """Disaster-balanced sampler (same as train.py)."""
    counts = Counter(disasters)
    weights = [1.0 / counts[d] for d in disasters]
    return WeightedRandomSampler(weights, num_samples=len(disasters), replacement=True)


def train_one(model, train_loader, val_loader, epochs, lr, device, patience=20):
    """Train a single model with early stopping + LR scheduling (mirrors train.py)."""
    optimizer = torch.optim.Adam(model.parameters(), lr=lr, weight_decay=1e-3)
    scheduler = torch.optim.lr_scheduler.ReduceLROnPlateau(optimizer, mode="min", factor=0.5, patience=7)
    criterion = nn.BCELoss()
    model.to(device)

    best_val_loss = float("inf")
    best_state = None
    no_improve = 0

    for epoch in range(epochs):
        model.train()
        for feats, lbls in train_loader:
            feats, lbls = feats.to(device), lbls.to(device)
            optimizer.zero_grad()
            loss = criterion(model(feats), lbls)
            loss.backward()
            optimizer.step()

        model.eval()
        val_loss = 0.0
        correct = 0
        total_val = 0
        with torch.no_grad():
            for feats, lbls in val_loader:
                feats, lbls = feats.to(device), lbls.to(device)
                preds = model(feats)
                val_loss += criterion(preds, lbls).item() * len(feats)
                correct += ((preds >= 0.5).float() == lbls).sum().item()
                total_val += len(feats)
        val_loss /= total_val
        acc = correct / total_val
        scheduler.step(val_loss)

        current_lr = optimizer.param_groups[0]["lr"]
        if (epoch + 1) % 20 == 0 or epoch == 0:
            print(f"    Epoch {epoch+1}/{epochs} - Val Loss: {val_loss:.4f} - Acc: {acc:.4f} - LR: {current_lr:.1e}")

        if val_loss < best_val_loss:
            best_val_loss = val_loss
            best_state = {k: v.clone() for k, v in model.state_dict().items()}
            no_improve = 0
        else:
            no_improve += 1
            if no_improve >= patience:
                print(f"    Early stopping at epoch {epoch+1} (no improvement for {patience} epochs)")
                break

    if best_state:
        model.load_state_dict(best_state)
    return model, best_val_loss, acc


def train_classifier(name, features, labels, disasters, epochs, lr, device):
    """Train a single informativeness classifier with LODO CV, return best model state."""
    unique_disasters = sorted(set(disasters))
    print(f"\n{'='*60}")
    print(f"Training {name} informativeness classifier")
    print(f"  Samples: {len(labels)} ({int(labels.sum())}/{len(labels)} informative)")
    print(f"  Disasters: {unique_disasters}")
    print(f"{'='*60}")

    fold_metrics = []

    for fold, held_out in enumerate(unique_disasters):
        train_idx = [i for i, d in enumerate(disasters) if d != held_out]
        val_idx = [i for i, d in enumerate(disasters) if d == held_out]

        if not val_idx:
            continue

        dataset = EmbeddingDataset(features, labels)
        train_disasters = [disasters[i] for i in train_idx]
        train_loader = DataLoader(Subset(dataset, train_idx), batch_size=64, sampler=balanced_sampler(train_disasters))
        val_loader = DataLoader(Subset(dataset, val_idx), batch_size=256)

        print(f"\n  Fold {fold+1}/{len(unique_disasters)}: held out = {held_out}")
        print(f"    Train: {len(train_idx)}, Val: {len(val_idx)}")

        model = InformativenessClassifier()
        model, val_loss, acc = train_one(model, train_loader, val_loader, epochs, lr, device)

        print(f"    Final: val_loss={val_loss:.4f}, acc={acc:.4f}")
        fold_metrics.append(acc)

    mean_acc = np.mean(fold_metrics)
    print(f"\n  Mean LODO accuracy: {mean_acc:.4f}")

    # Final model: retrain on all data
    print(f"\n  Retraining final model on all {len(labels)} samples...")
    dataset = EmbeddingDataset(features, labels)
    all_loader = DataLoader(dataset, batch_size=64, sampler=balanced_sampler(disasters))
    model = InformativenessClassifier()
    model, _, _ = train_one(model, all_loader, all_loader, epochs, lr, device)

    return model.state_dict()


def main():
    parser = argparse.ArgumentParser(description="Train informativeness classifiers")
    parser.add_argument("--crisismmd", default="CrisisMMD_v2.0", help="Path to CrisisMMD_v2.0 directory")
    parser.add_argument("--epochs", type=int, default=100)
    parser.add_argument("--lr", type=float, default=1e-3)
    parser.add_argument("--output-image", default="checkpoints/info_image.pt")
    parser.add_argument("--output-text", default="checkpoints/info_text.pt")
    args = parser.parse_args()

    device = "cuda" if torch.cuda.is_available() else "mps" if torch.backends.mps.is_available() else "cpu"
    print(f"Device: {device}")

    print("Loading TSV labels...")
    samples = load_tsv_labels(args.crisismmd)
    print(f"  {len(samples)} valid samples")

    print("Encoding with CLIP...")
    encoder = CLIPEncoder(device)
    image_feats, text_feats, image_labels, text_labels, disasters = precompute(
        samples, encoder, args.crisismmd
    )

    # Train image informativeness classifier
    image_state = train_classifier(
        "image", image_feats, image_labels, disasters,
        args.epochs, args.lr, device
    )
    os.makedirs(os.path.dirname(args.output_image) or ".", exist_ok=True)
    torch.save(image_state, args.output_image)
    print(f"\n  Saved image model to {args.output_image}")

    # Train text informativeness classifier
    text_state = train_classifier(
        "text", text_feats, text_labels, disasters,
        args.epochs, args.lr, device
    )
    os.makedirs(os.path.dirname(args.output_text) or ".", exist_ok=True)
    torch.save(text_state, args.output_text)
    print(f"\n  Saved text model to {args.output_text}")


if __name__ == "__main__":
    main()
