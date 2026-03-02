"""
One-time script to generate pseudo-labeled training data using OpenAI GPT-4o.

Usage:
    1. Place crisis images in a directory (e.g., data/images/)
    2. Create a CSV file (e.g., data/posts.csv) with columns: image_path, caption
       - image_path should be relative to the data directory
       - caption is the social media text accompanying the image
    3. Set OPENAI_API_KEY in .env file
    4. Run: python generate_labels.py --data-dir data/ --csv data/posts.csv --output data/labels.json

    You can obtain crisis images/captions from CrisisMMD:
    https://crisisnlp.qcri.org/crisismmd

    The script sends each image+caption to GPT-4o and asks it to classify
    resource needs into 5 binary categories.
"""

import argparse
import base64
import csv
import json
import os
import time
from pathlib import Path

from dotenv import load_dotenv
from openai import OpenAI

load_dotenv()

CATEGORIES = ["infrastructure", "food", "shelter", "sanitation_water", "medication"]

PROMPT = """You are analyzing a social media post from a disaster/crisis zone.
Given the image and caption below, rate how strongly each resource need is indicated.

Caption: "{caption}"

For each category, output a precise score between 0.00 and 1.00 using two decimal places.
Use the FULL continuous range — do NOT round to 0, 0.5, or 1. Use values like 0.12, 0.38, 0.63, 0.87.

Scale:
- 0.00 = absolutely no indication
- 0.01-0.25 = very weak/unlikely
- 0.26-0.50 = some indirect or mild indication
- 0.51-0.75 = clear moderate need
- 0.76-0.99 = strong/urgent need
- 1.00 = extreme, undeniable

Categories explained:
- infrastructure: roads, bridges, buildings, power lines, utilities damaged or destroyed
- food: hunger, food shortages, supply disruption, people lacking meals
- shelter: homelessness, displacement, destroyed housing, people sleeping outdoors or in tents
- sanitation_water: contaminated water, flooding, sewage, lack of clean drinking water, sanitation breakdown
- medication: injuries, medical emergencies, hospital damage, disease outbreaks, need for medical supplies

Examples:
- Flooded neighborhood with people on rooftops: {{"infrastructure": 0.72, "food": 0.41, "shelter": 0.88, "sanitation_water": 0.83, "medication": 0.29}}
- Collapsed building with rescue crews: {{"infrastructure": 0.93, "food": 0.18, "shelter": 0.76, "sanitation_water": 0.22, "medication": 0.67}}
- Family in tent after earthquake: {{"infrastructure": 0.55, "food": 0.62, "shelter": 0.91, "sanitation_water": 0.47, "medication": 0.15}}
- Wildfire burning through homes: {{"infrastructure": 0.81, "food": 0.27, "shelter": 0.85, "sanitation_water": 0.33, "medication": 0.44}}
- People wading through floodwater with belongings: {{"infrastructure": 0.58, "food": 0.52, "shelter": 0.79, "sanitation_water": 0.86, "medication": 0.21}}
- Injured person being carried to safety: {{"infrastructure": 0.31, "food": 0.14, "shelter": 0.43, "sanitation_water": 0.16, "medication": 0.92}}

Respond ONLY with a JSON object, no other text:
{{"infrastructure": 0.00, "food": 0.00, "shelter": 0.00, "sanitation_water": 0.00, "medication": 0.00}}"""


def encode_image_base64(image_path: str) -> str:
    with open(image_path, "rb") as f:
        return base64.b64encode(f.read()).decode("utf-8")


def get_media_type(image_path: str) -> str:
    ext = Path(image_path).suffix.lower()
    return {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp"}.get(ext, "image/jpeg")


def label_post(client: OpenAI, image_path: str, caption: str) -> dict:
    """Send image+caption to GPT-4o and get resource need labels."""
    img_data = encode_image_base64(image_path)
    media_type = get_media_type(image_path)
    data_url = f"data:{media_type};base64,{img_data}"

    response = client.chat.completions.create(
        model="gpt-4o-mini",
        max_tokens=256,
        messages=[{
            "role": "user",
            "content": [
                {"type": "image_url", "image_url": {"url": data_url}},
                {"type": "text", "text": PROMPT.format(caption=caption)},
            ],
        }],
    )

    response_text = response.choices[0].message.content.strip()
    try:
        labels = json.loads(response_text)
        for cat in CATEGORIES:
            if cat not in labels or not isinstance(labels[cat], (int, float)):
                labels[cat] = 0.0
            labels[cat] = max(0.0, min(1.0, float(labels[cat])))
        return {cat: labels[cat] for cat in CATEGORIES}
    except json.JSONDecodeError:
        print(f"  Warning: Could not parse response for {image_path}, defaulting to all zeros")
        return {cat: 0 for cat in CATEGORIES}


def main():
    parser = argparse.ArgumentParser(description="Generate pseudo-labels for crisis data using GPT-4o")
    parser.add_argument("--data-dir", required=True, help="Base directory containing images")
    parser.add_argument("--csv", required=True, help="CSV file with columns: image_path, caption")
    parser.add_argument("--output", default="data/labels.json", help="Output JSON file path")
    parser.add_argument("--delay", type=float, default=1.0, help="Delay between API calls in seconds")
    args = parser.parse_args()

    client = OpenAI()

    samples = []
    with open(args.csv, "r") as f:
        reader = csv.DictReader(f)
        for row in reader:
            samples.append({"image_path": row["image_path"], "caption": row["caption"]})

    print(f"Loaded {len(samples)} samples from {args.csv}")

    # Resume from existing progress if output file exists
    os.makedirs(os.path.dirname(args.output) or ".", exist_ok=True)
    already_labeled = set()
    results = []
    if os.path.exists(args.output):
        with open(args.output, "r") as f:
            results = json.load(f)
        already_labeled = {r["image_path"] for r in results}
        print(f"Resuming: {len(results)} samples already labeled, skipping those")

    for i, sample in enumerate(samples):
        if sample["image_path"] in already_labeled:
            continue

        full_image_path = os.path.join(args.data_dir, sample["image_path"])
        if not os.path.exists(full_image_path):
            print(f"  [{i+1}/{len(samples)}] Skipping {sample['image_path']} (file not found)")
            continue

        print(f"  [{i+1}/{len(samples)}] Labeling {sample['image_path']}...")
        labels = label_post(client, full_image_path, sample["caption"])

        results.append({
            "image_path": sample["image_path"],
            "caption": sample["caption"],
            "labels": labels,
        })

        # Save after every sample so progress is never lost
        with open(args.output, "w") as f:
            json.dump(results, f, indent=2)

        if args.delay > 0:
            time.sleep(args.delay)

    print(f"\nDone. {len(results)} total labeled samples in {args.output}")


if __name__ == "__main__":
    main()
