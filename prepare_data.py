"""
Converts CrisisMMD TSV annotations into the CSV format needed by generate_labels.py.

Usage:
    python prepare_data.py --crisismmd CrisisMMD_v2.0 --output data/posts.csv [--sample 1000]
"""

import argparse
import csv
import os
import random
import re
from pathlib import Path

# Twitter snowflake epoch offset (milliseconds)
TWITTER_EPOCH_MS = 1288834974657


def tweet_id_to_timestamp(tweet_id: int) -> float:
    """Convert a Twitter snowflake ID to a Unix timestamp in seconds."""
    ms = (tweet_id >> 22) + TWITTER_EPOCH_MS
    return ms / 1000.0


def extract_tweet_id(image_path: str) -> int:
    """Extract the tweet ID from an image filename like '901646074527535105_0.jpg'."""
    filename = Path(image_path).stem  # e.g. '901646074527535105_0'
    match = re.match(r"(\d+)_\d+", filename)
    if match:
        return int(match.group(1))
    return 0


def main():
    parser = argparse.ArgumentParser(description="Prepare CrisisMMD data for pseudo-labeling")
    parser.add_argument("--crisismmd", default="CrisisMMD_v2.0", help="Path to CrisisMMD_v2.0 directory")
    parser.add_argument("--output", default="data/posts.csv", help="Output CSV path")
    parser.add_argument("--sample", type=int, default=0, help="Random sample size (0 = use all)")
    parser.add_argument("--seed", type=int, default=42, help="Random seed for sampling")
    args = parser.parse_args()

    annotations_dir = os.path.join(args.crisismmd, "annotations")
    tsv_files = sorted(Path(annotations_dir).glob("*.tsv"))

    if not tsv_files:
        print(f"No TSV files found in {annotations_dir}")
        return

    rows = []
    for tsv_file in tsv_files:
        with open(tsv_file, "r", encoding="utf-8") as f:
            reader = csv.DictReader(f, delimiter="\t")
            for row in reader:
                image_path = row.get("image_path", "").strip()
                caption = row.get("tweet_text", "").strip()

                if not image_path or not caption:
                    continue

                # Check that the image file actually exists
                full_path = os.path.join(args.crisismmd, image_path)
                if not os.path.exists(full_path):
                    continue

                tweet_id = extract_tweet_id(image_path)
                timestamp = tweet_id_to_timestamp(tweet_id) if tweet_id else 0.0

                rows.append({"image_path": image_path, "caption": caption, "timestamp": timestamp})

    print(f"Found {len(rows)} valid samples across {len(tsv_files)} TSV files")

    # Sort chronologically
    rows.sort(key=lambda r: r["timestamp"])
    print(f"Sorted by timestamp: {rows[0]['timestamp']:.0f} -> {rows[-1]['timestamp']:.0f}")

    if args.sample > 0 and args.sample < len(rows):
        random.seed(args.seed)
        rows = random.sample(rows, args.sample)
        rows.sort(key=lambda r: r["timestamp"])  # re-sort after sampling
        print(f"Sampled {len(rows)} samples")

    os.makedirs(os.path.dirname(args.output) or ".", exist_ok=True)
    with open(args.output, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=["image_path", "caption", "timestamp"])
        writer.writeheader()
        writer.writerows(rows)

    print(f"Saved to {args.output}")


if __name__ == "__main__":
    main()
