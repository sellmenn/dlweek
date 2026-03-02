"""
Post-Crisis Resource Allocation System

Usage:
    python main.py --model checkpoints/model.pt

    This runs a demo with sample data. In production, you would integrate
    the DataCollector with real social media feeds and emergency call systems.
"""

import argparse

import torch

from data_collector import DataCollector
from clustering import cluster_data
from encoder import CLIPEncoder
from model import ResourceClassifier, RESOURCE_CATEGORIES, load_model


def run_allocation(collector: DataCollector, encoder: CLIPEncoder, model: ResourceClassifier, eps: float = 0.01, min_samples: int = 2):
    """
    Run the full allocation pipeline:
    1. Cluster collected posts and calls by location
    2. Encode each cluster with CLIP
    3. Predict resource needs per cluster
    """
    posts = collector.get_posts()
    calls = collector.get_calls()

    print(f"\nCollected data: {len(posts)} posts, {len(calls)} calls")

    # Step 1: Cluster by location
    clusters = cluster_data(posts, calls, eps=eps, min_samples=min_samples)
    print(f"Found {len(clusters)} clusters")

    if not clusters:
        print("No clusters formed. Try adjusting eps or min_samples, or add more data.")
        return []

    # Step 2 & 3: Encode and predict for each cluster
    results = []
    model.eval()
    device = next(model.parameters()).device

    for i, cluster in enumerate(clusters):
        # Encode cluster data
        features = encoder.encode_cluster(cluster)
        features = features.unsqueeze(0).to(device)

        # Predict resource needs
        with torch.no_grad():
            scores = model(features).squeeze(0).cpu()

        result = {
            "cluster_id": i + 1,
            "centroid": (cluster.centroid_lat, cluster.centroid_lon),
            "num_posts": cluster.num_posts,
            "num_calls": cluster.num_calls,
            "resource_needs": {cat: round(scores[j].item(), 3) for j, cat in enumerate(RESOURCE_CATEGORIES)},
        }
        results.append(result)

    # Display results
    print("\n" + "=" * 60)
    print("RESOURCE ALLOCATION RESULTS")
    print("=" * 60)

    for r in results:
        print(f"\nCluster {r['cluster_id']}:")
        print(f"  Location:  ({r['centroid'][0]:.4f}, {r['centroid'][1]:.4f})")
        print(f"  Posts: {r['num_posts']}, Calls: {r['num_calls']}")
        print(f"  Resource Needs:")
        for cat, score in r["resource_needs"].items():
            bar = "#" * int(score * 20)
            print(f"    {cat:<20s} {score:.3f} |{bar}")

    return results


def demo():
    """Run a demo with synthetic data to verify the pipeline works."""
    parser = argparse.ArgumentParser(description="Post-Crisis Resource Allocation System")
    parser.add_argument("--model", required=True, help="Path to trained model checkpoint")
    parser.add_argument("--eps", type=float, default=0.01, help="DBSCAN eps in degrees (~0.01 = 1km)")
    parser.add_argument("--min-samples", type=int, default=2, help="DBSCAN min_samples")
    args = parser.parse_args()

    device = "cuda" if torch.cuda.is_available() else "mps" if torch.backends.mps.is_available() else "cpu"

    print("Loading CLIP encoder...")
    encoder = CLIPEncoder(device=device)

    print("Loading trained model...")
    model = load_model(args.model, device=device)

    # In production, this would be connected to real data sources.
    # For demo purposes, you would add posts and calls like:
    #
    #   collector = DataCollector()
    #   collector.add_post("path/to/image.jpg", "Building collapsed downtown", 37.7749, -122.4194)
    #   collector.add_call("We need medical supplies urgently", 37.7750, -122.4190)
    #
    # Then run:
    #   results = run_allocation(collector, encoder, model, eps=args.eps, min_samples=args.min_samples)

    collector = DataCollector()
    print("\nNo data loaded. To use the system:")
    print("  1. Add posts via collector.add_post(image_path, caption, lat, lon)")
    print("  2. Add calls via collector.add_call(transcription, lat, lon)")
    print("  3. Call run_allocation(collector, encoder, model)")


if __name__ == "__main__":
    demo()
