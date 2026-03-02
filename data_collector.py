from dataclasses import dataclass, field
from typing import List


@dataclass
class Post:
    """A social media post with an image-caption pair and geolocation."""
    image_path: str
    caption: str
    latitude: float
    longitude: float
    timestamp: float = 0.0  # Unix timestamp in seconds


@dataclass
class Call:
    """An emergency call transcription with geolocation."""
    transcription: str
    latitude: float
    longitude: float
    timestamp: float = 0.0  # Unix timestamp in seconds


class DataCollector:
    """Collects and stores disaster-related posts and emergency calls."""

    def __init__(self):
        self.posts: List[Post] = []
        self.calls: List[Call] = []

    def add_post(self, image_path: str, caption: str, latitude: float, longitude: float):
        self.posts.append(Post(image_path, caption, latitude, longitude))

    def add_call(self, transcription: str, latitude: float, longitude: float):
        self.calls.append(Call(transcription, latitude, longitude))

    def get_posts(self) -> List[Post]:
        return self.posts

    def get_calls(self) -> List[Call]:
        return self.calls

    def total_count(self) -> int:
        return len(self.posts) + len(self.calls)

    def clear(self):
        self.posts.clear()
        self.calls.clear()
