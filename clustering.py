from dataclasses import dataclass, field
from typing import List

import numpy as np
from sklearn.cluster import DBSCAN

from data_collector import Post, Call


@dataclass
class Cluster:
    """A geographic cluster of posts and calls."""
    centroid_lat: float
    centroid_lon: float
    posts: List[Post] = field(default_factory=list)
    calls: List[Call] = field(default_factory=list)

    @property
    def num_posts(self) -> int:
        return len(self.posts)

    @property
    def num_calls(self) -> int:
        return len(self.calls)


def cluster_data(posts: List[Post], calls: List[Call], eps: float = 0.01, min_samples: int = 2) -> List[Cluster]:
    """
    Cluster posts and calls by geographic coordinates using DBSCAN.

    Args:
        posts: List of social media posts.
        calls: List of emergency call transcriptions.
        eps: Maximum distance between points in a cluster (in degrees, ~0.01 ≈ 1km).
        min_samples: Minimum number of points to form a cluster.

    Returns:
        List of Cluster objects. Noise points (label=-1) are discarded.
    """
    # Collect all coordinates and track source type
    items = []  # (lat, lon, 'post'|'call', original_object)
    for p in posts:
        items.append((p.latitude, p.longitude, "post", p))
    for c in calls:
        items.append((c.latitude, c.longitude, "call", c))

    if not items:
        return []

    coords = np.array([[lat, lon] for lat, lon, _, _ in items])

    db = DBSCAN(eps=eps, min_samples=min_samples, metric="euclidean")
    labels = db.fit_predict(coords)

    # Group by cluster label
    cluster_map = {}  # label -> Cluster
    for idx, label in enumerate(labels):
        if label == -1:
            continue  # skip noise

        if label not in cluster_map:
            cluster_map[label] = Cluster(centroid_lat=0.0, centroid_lon=0.0)

        cluster = cluster_map[label]
        item_type = items[idx][2]
        item_obj = items[idx][3]

        if item_type == "post":
            cluster.posts.append(item_obj)
        else:
            cluster.calls.append(item_obj)

    # Compute centroids
    for label, cluster in cluster_map.items():
        lats = [p.latitude for p in cluster.posts] + [c.latitude for c in cluster.calls]
        lons = [p.longitude for p in cluster.posts] + [c.longitude for c in cluster.calls]
        cluster.centroid_lat = np.mean(lats)
        cluster.centroid_lon = np.mean(lons)

    return list(cluster_map.values())
