"""
Training pipeline for the ResourceClassifier.

Usage:
    python train.py --labels data/labels.json --data-dir data/ --epochs 50 --output checkpoints/model.pt

Uses leave-one-disaster-out cross-validation: trains on 3 disasters, validates
on the held-out 1, rotating through all 4. The final model is retrained on all data.
"""

import argparse
import json
import os
import re

import numpy as np
import torch
import torch.nn as nn
from collections import Counter
from torch.utils.data import DataLoader, Dataset, Subset, WeightedRandomSampler

from encoder import CLIPEncoder, FEATURE_DIM
from model import ResourceClassifier, RESOURCE_CATEGORIES, NUM_CATEGORIES


class CrisisDataset(Dataset):
    """Dataset of CLIP-encoded crisis posts with resource need labels."""

    def __init__(self, features: torch.Tensor, labels: torch.Tensor, disasters: list[str]):
        self.features = features
        self.labels = labels
        self.disasters = disasters

    def __len__(self):
        return len(self.features)

    def __getitem__(self, idx):
        return self.features[idx], self.labels[idx]


def extract_disaster(image_path: str) -> str:
    """Extract disaster name from image_path like 'data_image/california_wildfires/...'."""
    match = re.match(r"data_image/([^/]+)/", image_path)
    return match.group(1) if match else "unknown"


def balanced_sampler(disasters: list[str]) -> WeightedRandomSampler:
    """Create a WeightedRandomSampler that balances across disaster types."""
    counts = Counter(disasters)
    weights = [1.0 / counts[d] for d in disasters]
    return WeightedRandomSampler(weights, num_samples=len(disasters), replacement=True)


def precompute_features(labels_file: str, data_dir: str, encoder: CLIPEncoder,
                        cache_path: str = "data/cached_features.pt") -> tuple:
    """
    Load labeled data, encode with CLIP, return (features, labels, disasters) tensors/lists.
    Caches the result to cache_path so subsequent runs skip CLIP encoding.

    Each sample is encoded as:
    - image embedding (512) + caption embedding (512) = 1024-dim
    """
    if os.path.exists(cache_path):
        print(f"  Loading cached features from {cache_path}")
        cached = torch.load(cache_path, weights_only=True)
        disasters = cached.get("disasters", [])
        if isinstance(disasters, torch.Tensor):
            disasters = disasters.tolist()
        return cached["features"], cached["labels"], disasters

    with open(labels_file, "r") as f:
        samples = json.load(f)

    all_features = []
    all_labels = []
    all_disasters = []

    for i, sample in enumerate(samples):
        image_path = os.path.join(data_dir, sample["image_path"])
        if not os.path.exists(image_path):
            continue

        print(f"  Encoding [{i+1}/{len(samples)}] {sample['image_path']}...")

        img_emb = encoder.encode_image(image_path)
        cap_emb = encoder.encode_text(sample["caption"]) if sample["caption"] else torch.zeros(512)

        feature = torch.cat([img_emb, cap_emb], dim=0)
        all_features.append(feature)

        label = torch.tensor([sample["labels"][cat] for cat in RESOURCE_CATEGORIES], dtype=torch.float32)
        all_labels.append(label)

        all_disasters.append(extract_disaster(sample["image_path"]))

    features = torch.stack(all_features)
    labels = torch.stack(all_labels)

    os.makedirs(os.path.dirname(cache_path) or ".", exist_ok=True)
    torch.save({"features": features, "labels": labels, "disasters": all_disasters}, cache_path)
    print(f"  Cached features to {cache_path}")

    return features, labels, all_disasters


def train(model, train_loader, val_loader, epochs, lr, device, patience=20):
    optimizer = torch.optim.Adam(model.parameters(), lr=lr, weight_decay=1e-3)
    scheduler = torch.optim.lr_scheduler.ReduceLROnPlateau(optimizer, mode="min", factor=0.5, patience=7)
    criterion = nn.BCELoss()
    model.to(device)

    best_val_loss = float("inf")
    best_state = None
    epochs_without_improvement = 0

    history = {
        "train_loss": [],
        "val_loss": [],
        "val_mae": [],  # overall MAE
        "val_mae_per_cat": {cat: [] for cat in RESOURCE_CATEGORIES},
    }

    for epoch in range(epochs):
        # Train
        model.train()
        train_loss = 0.0
        for features, labels in train_loader:
            features, labels = features.to(device), labels.to(device)
            optimizer.zero_grad()
            preds = model(features)
            loss = criterion(preds, labels)
            loss.backward()
            optimizer.step()
            train_loss += loss.item() * features.size(0)
        train_loss /= len(train_loader.dataset)

        # Validate
        model.eval()
        val_loss = 0.0
        all_preds = []
        all_labels = []
        with torch.no_grad():
            for features, labels in val_loader:
                features, labels = features.to(device), labels.to(device)
                preds = model(features)
                loss = criterion(preds, labels)
                val_loss += loss.item() * features.size(0)
                all_preds.append(preds.cpu())
                all_labels.append(labels.cpu())
        val_loss /= len(val_loader.dataset)

        scheduler.step(val_loss)

        # Compute MAE per category
        all_preds = torch.cat(all_preds, dim=0).numpy()
        all_labels = torch.cat(all_labels, dim=0).numpy()
        mae_per_cat = np.mean(np.abs(all_preds - all_labels), axis=0)
        mae_overall = np.mean(mae_per_cat)

        history["train_loss"].append(train_loss)
        history["val_loss"].append(val_loss)
        history["val_mae"].append(mae_overall)
        for j, cat in enumerate(RESOURCE_CATEGORIES):
            history["val_mae_per_cat"][cat].append(mae_per_cat[j])

        current_lr = optimizer.param_groups[0]["lr"]
        print(f"  Epoch {epoch+1}/{epochs} - Train Loss: {train_loss:.4f} - Val Loss: {val_loss:.4f} - Val MAE: {mae_overall:.4f} - LR: {current_lr:.1e}")

        if val_loss < best_val_loss:
            best_val_loss = val_loss
            best_state = {k: v.clone() for k, v in model.state_dict().items()}
            epochs_without_improvement = 0
        else:
            epochs_without_improvement += 1
            if epochs_without_improvement >= patience:
                print(f"  Early stopping at epoch {epoch+1} (no improvement for {patience} epochs)")
                break

    if best_state:
        model.load_state_dict(best_state)
    return model, history


def plot_training(history: dict, output_dir: str):
    """Plot training metrics and save to output directory."""
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    os.makedirs(output_dir, exist_ok=True)
    epochs = range(1, len(history["train_loss"]) + 1)

    # 1. Train vs Val Loss
    fig, ax = plt.subplots(figsize=(10, 6))
    ax.plot(epochs, history["train_loss"], label="Train Loss", linewidth=2)
    ax.plot(epochs, history["val_loss"], label="Val Loss", linewidth=2)
    ax.set_xlabel("Epoch")
    ax.set_ylabel("BCE Loss")
    ax.set_title("Training vs Validation Loss")
    ax.legend()
    ax.grid(True, alpha=0.3)
    fig.tight_layout()
    fig.savefig(os.path.join(output_dir, "loss_curve.png"), dpi=150)
    plt.close(fig)

    # 2. Overall Val MAE
    fig, ax = plt.subplots(figsize=(10, 6))
    ax.plot(epochs, history["val_mae"], label="Val MAE", linewidth=2, color="tab:orange")
    ax.set_xlabel("Epoch")
    ax.set_ylabel("Mean Absolute Error")
    ax.set_title("Validation MAE Over Training")
    ax.legend()
    ax.grid(True, alpha=0.3)
    fig.tight_layout()
    fig.savefig(os.path.join(output_dir, "mae_curve.png"), dpi=150)
    plt.close(fig)

    # 3. Per-category Val MAE
    fig, ax = plt.subplots(figsize=(10, 6))
    for cat in RESOURCE_CATEGORIES:
        ax.plot(epochs, history["val_mae_per_cat"][cat], label=cat, linewidth=2)
    ax.set_xlabel("Epoch")
    ax.set_ylabel("Mean Absolute Error")
    ax.set_title("Validation MAE Per Resource Category")
    ax.legend()
    ax.grid(True, alpha=0.3)
    fig.tight_layout()
    fig.savefig(os.path.join(output_dir, "mae_per_category.png"), dpi=150)
    plt.close(fig)

    # 4. Final per-category MAE bar chart
    final_mae = {cat: history["val_mae_per_cat"][cat][-1] for cat in RESOURCE_CATEGORIES}
    fig, ax = plt.subplots(figsize=(10, 6))
    bars = ax.bar(final_mae.keys(), final_mae.values(), color=["#e74c3c", "#f39c12", "#3498db", "#2ecc71", "#9b59b6"])
    ax.set_ylabel("Mean Absolute Error")
    ax.set_title("Final Validation MAE Per Category")
    ax.grid(True, alpha=0.3, axis="y")
    for bar, val in zip(bars, final_mae.values()):
        ax.text(bar.get_x() + bar.get_width() / 2, bar.get_height() + 0.005, f"{val:.3f}", ha="center", fontsize=10)
    fig.tight_layout()
    fig.savefig(os.path.join(output_dir, "final_mae_bar.png"), dpi=150)
    plt.close(fig)

    print(f"  Plots saved to {output_dir}/")


def main():
    parser = argparse.ArgumentParser(description="Train ResourceClassifier")
    parser.add_argument("--labels", required=True, help="Path to labels.json from generate_labels.py")
    parser.add_argument("--data-dir", required=True, help="Base directory containing images")
    parser.add_argument("--output", default="checkpoints/model.pt", help="Output model checkpoint path")
    parser.add_argument("--epochs", type=int, default=200)
    parser.add_argument("--batch-size", type=int, default=32)
    parser.add_argument("--lr", type=float, default=1e-3)
    args = parser.parse_args()

    device = "cuda" if torch.cuda.is_available() else "mps" if torch.backends.mps.is_available() else "cpu"
    print(f"Using device: {device}")

    print("Loading CLIP encoder...")
    encoder = CLIPEncoder(device=device)

    print("Encoding training data...")
    features, labels, disasters = precompute_features(args.labels, args.data_dir, encoder)
    print(f"Encoded {len(features)} samples")

    dataset = CrisisDataset(features, labels, disasters)
    unique_disasters = sorted(set(disasters))
    print(f"Disasters: {unique_disasters}")

    # Leave-one-disaster-out cross-validation
    fold_results = []
    for fold, held_out in enumerate(unique_disasters):
        train_idx = [i for i, d in enumerate(disasters) if d != held_out]
        val_idx = [i for i, d in enumerate(disasters) if d == held_out]

        train_disasters = [disasters[i] for i in train_idx]
        train_loader = DataLoader(Subset(dataset, train_idx), batch_size=args.batch_size, sampler=balanced_sampler(train_disasters))
        val_loader = DataLoader(Subset(dataset, val_idx), batch_size=args.batch_size)

        print(f"\n{'='*60}")
        print(f"Fold {fold+1}/{len(unique_disasters)}: held out = {held_out}")
        print(f"  Train: {len(train_idx)}, Val: {len(val_idx)}")

        model = ResourceClassifier()
        model, history = train(model, train_loader, val_loader, args.epochs, args.lr, device)

        final_mae = history["val_mae"][-1] if history["val_mae"] else float("inf")
        fold_results.append({"disaster": held_out, "val_mae": final_mae, "history": history})
        print(f"  Final Val MAE: {final_mae:.4f}")

        # Plot per-fold metrics
        plot_dir = os.path.join(os.path.dirname(args.output) or ".", "plots", f"fold_{held_out}")
        plot_training(history, plot_dir)

    # Summary
    print(f"\n{'='*60}")
    print("Leave-one-disaster-out results:")
    for r in fold_results:
        print(f"  {r['disaster']:30s} Val MAE: {r['val_mae']:.4f}")
    avg_mae = np.mean([r["val_mae"] for r in fold_results])
    print(f"  {'Average':30s} Val MAE: {avg_mae:.4f}")

    # Final model: retrain on all data
    print(f"\n{'='*60}")
    print("Retraining final model on all data...")
    all_loader = DataLoader(dataset, batch_size=args.batch_size, sampler=balanced_sampler(disasters))
    final_model = ResourceClassifier()
    final_model, final_history = train(final_model, all_loader, all_loader, args.epochs, args.lr, device)

    os.makedirs(os.path.dirname(args.output) or ".", exist_ok=True)
    torch.save(final_model.state_dict(), args.output)
    print(f"Model saved to {args.output}")

    plot_dir = os.path.join(os.path.dirname(args.output) or ".", "plots", "final")
    plot_training(final_history, plot_dir)


if __name__ == "__main__":
    main()
