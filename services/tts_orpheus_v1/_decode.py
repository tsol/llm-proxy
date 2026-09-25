#!/usr/bin/env python3
"""Decode Orpheus token strings with SNAC inside the engine venv."""

import json
import os
import sys
import wave

import torch
from snac import SNAC

from _snac_decode import decode_token_ids_to_samples, token_strings_to_ids

SAMPLE_RATE = 24000


def main() -> int:
    tokens_file, out_dir = sys.argv[1], sys.argv[2]
    with open(tokens_file, encoding="utf-8") as f:
        tokens = json.load(f)

    ids = token_strings_to_ids(tokens)
    if not ids:
        return 1

    device = "cuda" if torch.cuda.is_available() else "cpu"
    snac = SNAC.from_pretrained("hubertsiuzdak/snac_24khz").eval().to(device)
    samples = decode_token_ids_to_samples(ids, snac)
    if samples.size == 0:
        return 1

    import numpy as np

    pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype(np.int16)
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, "speech.wav")
    with wave.open(out_path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SAMPLE_RATE)
        w.writeframes(pcm.tobytes())
    print(out_path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
