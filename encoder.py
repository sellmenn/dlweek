import torch
from PIL import Image
from transformers import CLIPProcessor, CLIPModel
from typing import List

from clustering import Cluster

# Embedding dimension for CLIP ViT-B/32
CLIP_DIM = 512
# Concatenated dimension: image_emb + caption_emb
FEATURE_DIM = CLIP_DIM * 2


class CLIPEncoder:
    """Encodes images and text using CLIP ViT-B/32."""

    def __init__(self, device: str = None):
        if device is None:
            device = "cuda" if torch.cuda.is_available() else "mps" if torch.backends.mps.is_available() else "cpu"
        self.device = device
        self.model = CLIPModel.from_pretrained("openai/clip-vit-base-patch32").to(device)
        self.processor = CLIPProcessor.from_pretrained("openai/clip-vit-base-patch32")
        self.model.eval()

    @torch.no_grad()
    def encode_image(self, image_path: str) -> torch.Tensor:
        """Encode a single image to a 512-dim vector."""
        image = Image.open(image_path).convert("RGB")
        inputs = self.processor(images=image, return_tensors="pt").to(self.device)
        emb = self.model.get_image_features(**inputs)
        emb = emb / emb.norm(dim=-1, keepdim=True)
        return emb.squeeze(0).cpu()

    @torch.no_grad()
    def encode_text(self, text: str) -> torch.Tensor:
        """Encode a single text string to a 512-dim vector."""
        inputs = self.processor(text=[text], return_tensors="pt", truncation=True, max_length=77).to(self.device)
        emb = self.model.get_text_features(**inputs)
        emb = emb / emb.norm(dim=-1, keepdim=True)
        return emb.squeeze(0).cpu()

    @torch.no_grad()
    def encode_texts(self, texts: List[str]) -> torch.Tensor:
        """Encode multiple texts, returns (N, 512) tensor."""
        if not texts:
            return torch.zeros(0, CLIP_DIM)
        inputs = self.processor(text=texts, return_tensors="pt", padding=True, truncation=True, max_length=77).to(self.device)
        emb = self.model.get_text_features(**inputs)
        emb = emb / emb.norm(dim=-1, keepdim=True)
        return emb.cpu()

    def encode_cluster(self, cluster: Cluster) -> torch.Tensor:
        """
        Encode a cluster into a 1024-dim feature vector by concatenating
        mean-pooled image embeddings and caption embeddings.

        Returns:
            Tensor of shape (1024,). Zero-padded if a modality is missing.
        """
        # Image embeddings
        if cluster.posts:
            img_embs = torch.stack([self.encode_image(p.image_path) for p in cluster.posts])
            img_mean = img_embs.mean(dim=0)
        else:
            img_mean = torch.zeros(CLIP_DIM)

        # Caption embeddings
        captions = [p.caption for p in cluster.posts if p.caption]
        if captions:
            cap_embs = self.encode_texts(captions)
            cap_mean = cap_embs.mean(dim=0)
        else:
            cap_mean = torch.zeros(CLIP_DIM)

        return torch.cat([img_mean, cap_mean], dim=0)
