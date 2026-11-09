"""Compose the upstream FreyaTTS components with explicitly installed local weights.

No hub lookup or modification of third-party source is required at runtime.
Loading follows the component interfaces of pinned Apache-2.0 FreyaTTS.
"""
import json
from pathlib import Path


def load_local_freya(model_dir: str, vae_path: str, device: str):
    import torch
    from freyatts import FreyaTTS
    from freyatts.model import FreyaDiT
    from freyatts import pipeline
    from safetensors.torch import load_file
    from voxcpm.modules.audiovae import AudioVAEV2, AudioVAEConfigV2

    folder = Path(model_dir)
    config = json.loads((folder / "config.json").read_text())
    network = FreyaDiT(**{key: config[key] for key in ("vocab", "d", "depth", "heads", "ff")})
    network.load_state_dict(load_file(str(folder / "model.safetensors")), strict=True)
    network = network.to(device).eval()
    vae = AudioVAEV2(AudioVAEConfigV2())
    checkpoint = torch.load(vae_path, map_location="cpu", weights_only=True)
    vae.load_state_dict(checkpoint.get("state_dict", checkpoint), strict=False)
    vae = vae.to(device).float().eval()
    for parameter in vae.parameters():
        parameter.requires_grad = False
    vocabulary = Path(pipeline.__file__).parent / "char_vocab.json"
    return FreyaTTS(network, vae, json.loads(vocabulary.read_text()), device=device)
