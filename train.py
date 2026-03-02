"""
Training pipeline for the ResourceClassifier.

Usage:
    python train.py --labels data/labels.json --data-dir data/ --epochs 50 --output checkpoints/model.pt
"""

import argparse
import json
import os

import numpy as np
import torch
import torch.nn as nn
from torch.utils.data import Dataset, DataLoader, random_split

from encoder import CLIPEncoder, FEATURE_DIM
from model import ResourceClassifier, RESOURCE_CATEGORIES, NUM_CATEGORIES


class CrisisDataset(Dataset):
    """Dataset of CLIP-encoded crisis posts with resource need labels."""

    def __init__(self, features: torch.Tensor, labels: torch.Tensor):
        self.features = features
        self.labels = labels

    def __len__(self):
        return len(self.features)

    def __getitem__(self, idx):
        return self.features[idx], self.labels[idx]


def precompute_features(labels_file: str, data_dir: str, encoder: CLIPEncoder) -> tuple:
    """
    Load labeled data, encode with CLIP, return (features, labels) tensors.

    Each sample is encoded as:
    - image embedding (512) + caption embedding (512) + zeros (512) = 1536-dim
    (Transcription slot is zeroed since training data is social media posts only.)
    """
    with open(labels_file, "r") as f:
        samples = json.load(f)

    all_features = []
    all_labels = []

    for i, sample in enumerate(samples):
        image_path = os.path.join(data_dir, sample["image_path"])
        if not os.path.exists(image_path):
            continue

        print(f"  Encoding [{i+1}/{len(samples)}] {sample['image_path']}...")

        img_emb = encoder.encode_image(image_path)
        cap_emb = encoder.encode_text(sample["caption"]) if sample["caption"] else torch.zeros(512)
        trans_emb = torch.zeros(512)  # no transcription in training data

        feature = torch.cat([img_emb, cap_emb, trans_emb], dim=0)
        all_features.append(feature)

        label = torch.tensor([sample["labels"][cat] for cat in RESOURCE_CATEGORIES], dtype=torch.float32)
        all_labels.append(label)

    return torch.stack(all_features), torch.stack(all_labels)


def train(model, train_loader, val_loader, epochs, lr, device):
    optimizer = torch.optim.Adam(model.parameters(), lr=lr)
    criterion = nn.BCELoss()
    model.to(device)

    best_val_loss = float("inf")
    best_state = None

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

        print(f"  Epoch {epoch+1}/{epochs} - Train Loss: {train_loss:.4f} - Val Loss: {val_loss:.4f} - Val MAE: {mae_overall:.4f}")

        if val_loss < best_val_loss:
            best_val_loss = val_loss
            best_state = {k: v.clone() for k, v in model.state_dict().items()}

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
    parser.add_argument("--epochs", type=int, default=500)
    parser.add_argument("--batch-size", type=int, default=32)
    parser.add_argument("--lr", type=float, default=1e-3)
    parser.add_argument("--val-split", type=float, default=0.2)
    args = parser.parse_args()

    device = "cuda" if torch.cuda.is_available() else "mps" if torch.backends.mps.is_available() else "cpu"
    print(f"Using device: {device}")

    print("Loading CLIP encoder...")
    encoder = CLIPEncoder(device=device)

    print("Encoding training data...")
    features, labels = precompute_features(args.labels, args.data_dir, encoder)
    print(f"Encoded {len(features)} samples")

    # Split into train/val
    dataset = CrisisDataset(features, labels)
    val_size = int(len(dataset) * args.val_split)
    train_size = len(dataset) - val_size
    train_dataset, val_dataset = random_split(dataset, [train_size, val_size])

    train_loader = DataLoader(train_dataset, batch_size=args.batch_size, shuffle=True)
    val_loader = DataLoader(val_dataset, batch_size=args.batch_size)

    print(f"Train: {train_size}, Val: {val_size}")

    model = ResourceClassifier()
    print("Training...")
    model, history = train(model, train_loader, val_loader, args.epochs, args.lr, device)

    os.makedirs(os.path.dirname(args.output) or ".", exist_ok=True)
    torch.save(model.state_dict(), args.output)
    print(f"Model saved to {args.output}")

    # Plot training metrics
    plot_dir = os.path.join(os.path.dirname(args.output) or ".", "plots")
    plot_training(history, plot_dir)


if __name__ == "__main__":
    main()
