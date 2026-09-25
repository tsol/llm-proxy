"""Orpheus audio-token → PCM via SNAC (hubertsiuzdak/snac_24khz).

Matches canopyai/Orpheus-TTS and isaiahbjork/orpheus-tts-local decoder layout.
"""

from __future__ import annotations

import re
from typing import Iterable, List, Optional

import numpy as np
import torch

CUSTOM_TOKEN_RE = re.compile(r"<custom_token_(\d+)>")


def turn_token_into_id(token_string: str, index: int) -> Optional[int]:
    s = token_string.strip()
    if not s:
        return None
    m = CUSTOM_TOKEN_RE.search(s)
    if m:
        try:
            return int(m.group(1)) - 10 - ((index % 7) * 4096)
        except ValueError:
            return None
    try:
        f = float(s)
        v = round(f)
        return v if v > 0 else None
    except ValueError:
        return None


def token_strings_to_ids(token_strings: Iterable[str]) -> List[int]:
    """Match orpheus-tts-local: index for decode is count of accepted audio codes."""
    ids: List[int] = []
    count = 0
    for tok in token_strings:
        v = turn_token_into_id(tok, count)
        if v is not None and v > 0:
            ids.append(v)
            count += 1
    return ids


def _convert_multiframe_to_int16(multiframe: List[int], device: torch.device, snac_model) -> Optional[np.ndarray]:
    if len(multiframe) < 7:
        return None
    num_frames = len(multiframe) // 7
    frame = multiframe[: num_frames * 7]

    codes_0 = torch.tensor([], device=device, dtype=torch.int32)
    codes_1 = torch.tensor([], device=device, dtype=torch.int32)
    codes_2 = torch.tensor([], device=device, dtype=torch.int32)

    for j in range(num_frames):
        i = 7 * j
        codes_0 = torch.cat([codes_0, torch.tensor([frame[i]], device=device, dtype=torch.int32)])
        codes_1 = torch.cat(
            [codes_1, torch.tensor([frame[i + 1], frame[i + 4]], device=device, dtype=torch.int32)]
        )
        codes_2 = torch.cat(
            [
                codes_2,
                torch.tensor(
                    [frame[i + 2], frame[i + 3], frame[i + 5], frame[i + 6]],
                    device=device,
                    dtype=torch.int32,
                ),
            ]
        )

    codes = [codes_0.unsqueeze(0), codes_1.unsqueeze(0), codes_2.unsqueeze(0)]
    if (
        torch.any(codes[0] < 0)
        or torch.any(codes[0] > 4096)
        or torch.any(codes[1] < 0)
        or torch.any(codes[1] > 4096)
        or torch.any(codes[2] < 0)
        or torch.any(codes[2] > 4096)
    ):
        return None

    with torch.inference_mode():
        audio_hat = snac_model.decode(codes)
    audio_slice = audio_hat[:, :, 2048:4096].detach().cpu().numpy()
    return (audio_slice.flatten() * 32767).astype(np.int16)


def _snac_device(snac_model) -> torch.device:
    try:
        return next(snac_model.parameters()).device
    except StopIteration:
        return torch.device("cpu")


def decode_token_ids_to_samples(token_ids: List[int], snac_model) -> np.ndarray:
    """Decode full token stream; returns float32 mono samples in [-1, 1]."""
    device = _snac_device(snac_model)
    chunks: List[np.ndarray] = []
    buffer: List[int] = []
    count = 0
    for tid in token_ids:
        buffer.append(tid)
        count += 1
        if count % 7 == 0 and count > 27:
            pcm = _convert_multiframe_to_int16(buffer[-28:], device, snac_model)
            if pcm is not None and pcm.size:
                chunks.append(pcm)

    if not chunks:
        pcm = _convert_multiframe_to_int16(buffer, device, snac_model)
        if pcm is not None and pcm.size:
            chunks.append(pcm)

    if not chunks:
        return np.zeros(0, dtype=np.float32)
    pcm_all = np.concatenate(chunks)
    return (pcm_all.astype(np.float32) / 32767.0).clip(-1.0, 1.0)
