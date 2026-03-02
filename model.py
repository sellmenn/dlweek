import torch
import torch.nn as nn

from encoder import FEATURE_DIM

RESOURCE_CATEGORIES = ["infrastructure", "food", "shelter", "sanitation_water", "medication"]
NUM_CATEGORIES = len(RESOURCE_CATEGORIES)


class ResourceClassifier(nn.Module):
    """
    MLP that takes concatenated CLIP embeddings (1536-dim) and outputs
    a 0-1 score for each of the 5 resource need categories.
    """

    def __init__(self, input_dim: int = FEATURE_DIM):
        super().__init__()
        self.net = nn.Sequential(
            nn.Linear(input_dim, 512),
            nn.ReLU(),
            nn.Dropout(0.3),
            nn.Linear(512, 256),
            nn.ReLU(),
            nn.Dropout(0.3),
            nn.Linear(256, NUM_CATEGORIES),
            nn.Sigmoid(),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.net(x)


def load_model(checkpoint_path: str, device: str = "cpu") -> ResourceClassifier:
    """Load a trained model from a checkpoint file."""
    model = ResourceClassifier()
    model.load_state_dict(torch.load(checkpoint_path, map_location=device, weights_only=True))
    model.to(device)
    model.eval()
    return model
