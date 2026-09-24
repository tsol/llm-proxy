#!/usr/bin/env python3
"""Helper that decodes Orpheus audio tokens with SNAC inside the engine venv.

Invoked as a subprocess by engine.py when `snac` is not importable in-process
(the proxy's python may lack torch/snac). Reads a JSON array of token strings
from argv[1], writes speech.wav into argv[2] (24kHz mono s16le), and prints the
result file path on stdout (or nothing on failure).
"""

import json
import os
import sys
import wave

import numpy as np
import torch
from snac import SNAC

SAMPLE_RATE = 24000
FRAME_SIZE = 7


def main() -> int:
    tokens_file, out_dir = sys.argv[1], sys.argv[2]
    with open(tokens_file, encoding="utf-8") as f:
        tokens = json.load(f)

    raw = []
    for t in tokens:
        s = str(t).strip()
        if not s:
            continue
        try:
            v = round(float(s))
        except Exception:
            continue
        if v > 0:
            raw.append(v)

    if not raw:
        return 1

    frames = [raw[i:i + FRAME_SIZE] for i in range(0, len(raw) - len(raw) % FRAME_SIZE, FRAME_SIZE)]
    snac = SNAC.from_pretrained(
        "hubertsiuzdak/snac_24khz",
        device="cuda" if torch.cuda.is_available() else "cpu",
    )
    snac.eval()
    codes = torch.tensor(frames, dtype=torch.int64, device=snac.device)
    with torch.no_grad():
        audio = snac.decode(codes).cpu().numpy().flatten()

    pcm = (np.clip(audio, -1.0, 1.0) * 32767).astype(np.int16)
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
