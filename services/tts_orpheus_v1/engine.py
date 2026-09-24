#!/usr/bin/env python3
"""Orpheus TTS host engine — LM Studio API + SNAC audio decode.

This is the heart of the Orpheus proxy service (tts_orpheus_v1). It is meant
to run on the HOST under the user that runs the LLM proxy (harry), where LM
Studio lives at ~/.lmstudio. The proxy scheduler already guarantees LM Studio
is running and the Orpheus GGUF model is loaded before this is invoked, but
we stay defensive and (re)trigger loading ourselves if needed.

How it works (verified against canopylabs/orpheus, isaiahbjork/orpheus-tts-local):
  1. format_prompt(text, voice) wraps text in the Llama-chat prefix with the
     voice tag:  <|audio|><|tara|>...<|eot_id|>
  2. LM Studio /v1/completions with stream=True returns one audio token string
     per delta. Orpheus emits integers (SNAC codes) in groups of 7.
  3. Decode tokens -> frames via the `snac` package (multi-scale residual VQ
     codec) -> 16-bit PCM -> write wav, then optionally re-encode to
     ogg/mp3 with ffmpeg.

Autonomous setup (best-effort, one place to tune = this file's CONFIG below):
  - Ensures the Orpheus GGUF is present under the LM Studio models dir,
    downloading it from HuggingFace if missing.
  - Ensures a python venv with `snac` (+ optional `torch`) exists.
"""

import argparse
import json
import os
import subprocess
import sys
import tempfile
import time
import wave
from pathlib import Path

# ---------------------------------------------------------------- CONFIG (tune here)
LMS_BIN = os.path.expanduser("~/.lmstudio/bin/lms")
LMS_MODELS_DIR = os.path.expanduser("~/.lmstudio/models")
LM_NATIVE_URL = os.environ.get("LM_NATIVE_URL", "http://127.0.0.1:1234")
LM_COMPLETIONS_URL = os.path.join(LM_NATIVE_URL, "v1", "completions")
LM_LOAD_URL = os.path.join(LM_NATIVE_URL, "api", "v1", "models", "load")
MODEL_KEY = os.environ.get("MODEL_KEY", "unsloth/orpheus-3b-0.1-ft-GGUF")
# Where to download a fresh GGUF if not present. MUST match LM Studio naming
# so the model shows up as MODEL_KEY under /api/v1/models.
MODEL_URL = os.environ.get(
    "MODEL_URL",
    "https://huggingface.co/isaiahbjork/orpheus-3b-0.1-ft-Q4_K_M-GGUF/resolve/main/orpheus-3b-0.1-ft-q4_k_m.gguf",
)
# Place under <LMS_MODELS_DIR>/<MODEL_URL-subdir>/<...>.gguf so LM Studio indexes it.
MODEL_LOCAL_SUBDIR = "unsloth"           # -> ~/.lmstudio/models/unsloth/<fname>
MODEL_LOCAL_FNAME = "orpheus-3b-0.1-ft-q4_k_m.gguf"

VOICES = ("tara", "leah", "jess", "leo", "dan", "mia", "zac", "zoe")
SAMPLE_RATE = 24000      # Orpheus/SNAC output rate
DEFAULT_TEMPERATURE = 0.6
DEFAULT_TOP_P = 0.9
DEFAULT_REPETITION_PENALTY = 1.1
MAX_TOKENS = 2048

# llm_proxy injects these env vars from the scheduler (runner-exec)
PROXY_URL = os.environ.get("PROXY_URL", "")
LMSTUDIO_URL = os.environ.get("LMSTUDIO_URL", LM_NATIVE_URL)


def log(msg: str) -> None:
    print(f"[orpheus-engine] {msg}", file=sys.stderr, flush=True)


# ---------------------------------------------------------------- prompt
def format_prompt(text: str, voice: str) -> str:
    if voice not in VOICES:
        raise ValueError(f"unknown voice {voice!r}; choose from {', '.join(VOICES)}")
    return (f"<|audio|><|{voice}|><|audio|><|text_start|>"
            f"{text}<|text_end|><|eot_id|>")


# ---------------------------------------------------------------- LM Studio helpers
def lm_models():  # -> list[dict]
    import urllib.request
    with urllib.request.urlopen(f"{LM_NATIVE_URL}/api/v1/models", timeout=10) as r:
        data = json.load(r)
    return data.get("data", [])


def lm_server_up() -> bool:
    try:
        lm_models()
        return True
    except Exception:
        return False


def ensure_lm_server():
    if lm_server_up():
        return
    log(f"LM Studio server down — starting via {LMS_BIN} server start")
    subprocess.run([LMS_BIN, "server", "start"], check=False, timeout=120)


def model_loaded() -> bool:
    try:
        names = [m.get("id", "") for m in lm_models()]
        # LM Studio models list reports loaded model as id (e.g. model name or path)
        return len(names) > 0 and any(MODEL_KEY in n or "orpheus" in n.lower() for n in names)
    except Exception:
        return False


def ensure_model_loaded():
    if model_loaded():
        return
    log(f"loading model {MODEL_KEY}")
    import urllib.request
    req = urllib.request.Request(
        LM_LOAD_URL,
        data=json.dumps({"model": MODEL_KEY}).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=300) as r:
        json.load(r)


def generate_tokens(prompt: str, temperature, top_p, repetition_penalty, max_tokens=MAX_TOKENS):
    """Yield audio token strings from LM Studio /v1/completions (streaming)."""
    import urllib.request
    payload = {
        "prompt": prompt,
        "max_tokens": max_tokens,
        "temperature": temperature,
        "top_p": top_p,
        "repeat_penalty": repetition_penalty,
        "stream": True,
    }
    req = urllib.request.Request(
        LM_COMPLETIONS_URL,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json", "Authorization": "Bearer lm-studio"},
    )
    with urllib.request.urlopen(req, timeout=540) as r:
        for raw in r:
            if not raw:
                continue
            line = raw.strip()
            if isinstance(line, bytes):
                line = line.decode("utf-8", errors="replace")
            if not line.startswith("data: "):
                continue
            s = line[6:]
            if s.strip() == "[DONE]":
                break
            try:
                d = json.loads(s)
                tok = d["choices"][0].get("text", "")
            except Exception:
                continue
            if tok:
                yield tok


def turn_token_into_id(token_str: str, index: int) -> int:
    """Standard Orpheus helper — maps a raw float-string token to an int code."""
    s = token_str.strip()
    try:
        f = float(s)
    except Exception:
        return -1
    return round(f) % 8192 if f > 0 else round(f) % 8192


# ---------------------------------------------------------------- decode via snac
def decode_frames(tokens, snac_model):
    """Group consecutive ints into frames of 7 SNAC codes, decode -> float samples."""
    import numpy as np
    import torch

    raw = []
    for t in tokens:
        v = round(float(t)) if _is_num(t) else None
        if v is not None and v > 0:
            raw.append(v)
    # Orpheus emits 7 codes per frame (root + 3 levels x2)
    frame_size = 7
    frames = [raw[i:i + frame_size] for i in range(0, len(raw) - (len(raw) % frame_size), frame_size)]
    if not frames:
        return np.zeros(0, dtype=np.float32)
    codes = torch.tensor(frames, dtype=torch.int64, device=snac_model.device)
    with torch.no_grad():
        audio_float = snac_model.decode(codes).cpu().numpy().flatten()
    return audio_float


def _is_num(s: str) -> bool:
    try:
        float(s)
        return True
    except Exception:
        return False


# ---------------------------------------------------------------- wav / encode
def write_wav(path: str, samples, sample_rate: int = SAMPLE_RATE) -> None:
    import numpy as np
    pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype(np.int16)
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        w.writeframes(pcm.tobytes())


def encode(out_dir: str, out_format: str) -> str:
    wav_path = os.path.join(out_dir, "speech.wav")
    if out_format == "wav":
        return wav_path
    out_path = os.path.join(out_dir, f"speech.{out_format}")
    codec = {"ogg": "libvorbis", "mp3": "libmp3lame"}[out_format]
    subprocess.run(
        ["ffmpeg", "-y", "-i", wav_path, "-c:a", codec, "-q:a", "4", out_path],
        check=True, capture_output=True, timeout=300,
    )
    return out_path


# ---------------------------------------------------------------- autonomous setup
def ensure_snac_venv(venv_dir: str) -> str:
    """Return python path of a venv with snac+torch+numpy, creating if needed."""
    py = os.path.join(venv_dir, "bin", "python")
    if os.path.isfile(py):
        # verify snac importable
        ok = subprocess.run([py, "-c", "import snac"], capture_output=True)
        if ok.returncode == 0:
            return py
    Path(venv_dir).mkdir(parents=True, exist_ok=True)
    log(f"creating venv {venv_dir}")
    subprocess.run([sys.executable, "-m", "venv", venv_dir], check=True, timeout=300)
    subprocess.run([py, "-m", "pip", "install", "--upgrade", "pip"], check=True, timeout=300)
    # snac pulls in torch; fall back if torch already present
    subprocess.run([py, "-m", "pip", "install", "snac", "numpy"], check=False, timeout=1200)
    subprocess.run([py, "-m", "pip", "install", "numpy"], check=False, timeout=300)
    return py


def ensure_model_downloaded() -> str:
    """Return local gguf path, downloading from HF if absent."""
    local_dir = os.path.join(LMS_MODELS_DIR, MODEL_LOCAL_SUBDIR)
    local_path = os.path.join(local_dir, MODEL_LOCAL_FNAME)
    if os.path.isfile(local_path):
        return local_path
    Path(local_dir).mkdir(parents=True, exist_ok=True)
    log(f"downloading GGUF -> {local_path} (this can be slow, ~2GB)")
    import urllib.request
    req = urllib.request.Request(MODEL_URL, headers={"User-Agent": "orpheus-proxy-engine"})
    with urllib.request.urlopen(req, timeout=3600) as r, open(local_path, "wb") as f:
        shutil_copyfileobj(r, f)
    log("GGUF download done")
    return local_path


def shutil_copyfileobj(src, dst, length=1024 * 1024):
    while True:
        buf = src.read(length)
        if not buf:
            break
        dst.write(buf)


# ---------------------------------------------------------------- main
def main() -> int:
    ap = argparse.ArgumentParser(description="Orpheus TTS engine")
    ap.add_argument("--text", required=True)
    ap.add_argument("--voice", default="tara")
    ap.add_argument("--out_dir", required=True)
    ap.add_argument("--format", choices=["ogg", "mp3", "wav"], default="ogg")
    ap.add_argument("--temperature", type=float, default=DEFAULT_TEMPERATURE)
    ap.add_argument("--top_p", type=float, default=DEFAULT_TOP_P)
    ap.add_argument("--repetition_penalty", type=float, default=DEFAULT_REPETITION_PENALTY)
    args = ap.parse_args()

    os.makedirs(args.out_dir, exist_ok=True)
    t0 = time.time()

    # 0) autonomous setup
    ensure_model_downloaded()
    venv = ensure_snac_venv(os.path.join(args.out_dir, "..", ".orpheus-venv"))
    venv = os.path.abspath(venv)

    # 1) server + model
    ensure_lm_server()
    ensure_model_loaded()

    # 2) generate tokens via LM Studio
    prompt = format_prompt(args.text, args.voice)
    log(f"voice={args.voice} len={len(args.text)} prompt={prompt[:60]}...")
    token_gen = generate_tokens(prompt, args.temperature, args.top_p, args.repetition_penalty)

    # 3) decode via snac (run in the engine venv as a subprocess to isolate deps)
    #    Simpler: import snac in-process if available, else spawn venv helper.
    helper = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_decode.py")
    import traceback
    try:
        from snac import SNAC  # in-process
        snac_model = SNAC.from_pretrained(
            "hubertsiuzdak/snac_24khz",
            device="cuda" if os.environ.get("ORPHEUS_DEVICE") != "cpu" else "cpu",
        )
    except Exception as e:
        log(f"in-process snac unavailable ({e}) — spawning venv helper")
        samples = _run_helper(venv, helper, token_gen, args.out_dir)
        if samples is None:
            log("helper failed to decode")
            return 1
    else:
        samples = decode_frames(token_gen, snac_model)

    # 4) write wav + encode
    if samples is None or len(samples) == 0:
        log("no audio samples produced")
        return 1
    write_wav(os.path.join(args.out_dir, "speech.wav"), samples)
    out = encode(args.out_dir, args.format)
    log(f"done in {time.time()-t0:.1f}s -> {out}")

    # 5) emit result in JOB_DIR-compatible JSON (engine logs only; run.py reads files)
    print(json.dumps({"ok": True, "output": out, "elapsed_sec": round(time.time()-t0, 1)}))
    return 0


def _run_helper(venv_py, helper_path, token_gen, out_dir):
    """Serializes token generator into a temp file for the venv subprocess."""
    fd, tmp = tempfile.mkstemp(suffix=".tokens.json")
    with os.fdopen(fd, "w") as f:
        json.dump(list(token_gen), f)
    r = subprocess.run(
        [venv_py, helper_path, tmp, out_dir],
        capture_output=True, text=True, timeout=540,
    )
    os.unlink(tmp)
    if r.returncode != 0:
        log(r.stderr[-2000:])
        return None
    return r.stdout.strip("\n") or None


if __name__ == "__main__":
    sys.exit(main())
