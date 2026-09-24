#!/usr/bin/env python3
"""Exec wrapper for the Orpheus TTS host engine.

Contract with the engine (see HANDOFF.md / PLAN.md):
  <engine_root>/tts.sh [--text "STR"] [--voice NAME] [--out_dir DIR]
                       [--format ogg|mp3|wav]
                       [--temperature F] [--top_p F] [--repetition_penalty F]
  - Engine is responsible for: auto-downloading the Orpheus GGUF if missing,
    ensuring LM Studio model catalog paths, and decoding audio tokens via SNAC.
  - Engine must write exactly one file named `speech.<format>` into --out_dir.
  - LM Studio server is already up and the model loaded by the scheduler
    (this service requires resident `lmstudio`).

All tunable host paths live in ONE place: the service settings
(settings.schema.json -> store/services/tts_orpheus_v1.json), not hard-coded
here. This wrapper only falls back to repo defaults.
"""

import json
import os
import shutil
import subprocess
import sys
import time

JOB_DIR = os.environ.get("JOB_DIR")
JOB_INPUT = os.environ.get("JOB_INPUT", os.path.join(JOB_DIR or ".", "input.json"))
JOB_SETTINGS = os.environ.get("JOB_SETTINGS", os.path.join(JOB_DIR or ".", "settings.json"))

DEFAULT_ENGINE_ROOT = "/home/harry/hermes/workspace/code/orpheus-tts"
VOICES = ("tara", "leah", "jess", "leo", "dan", "mia", "zac", "zoe")


def emit(obj: dict) -> None:
    print(json.dumps(obj), flush=True)


def load_json(path: str) -> dict:
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def fail(message: str) -> int:
    emit({"type": "log", "message": message})
    return 1


def main() -> int:
    if not JOB_DIR:
        return fail("JOB_DIR not set — must run under the proxy executor")
    inp = load_json(JOB_INPUT)
    settings = (
        load_json(JOB_SETTINGS) if os.path.isfile(JOB_SETTINGS) else {}
    )

    engine_root = settings.get("engine_root", DEFAULT_ENGINE_ROOT)
    output_format = settings.get("output_format", "ogg")
    default_voice = settings.get("default_voice", "tara")
    lm_native_url = settings.get("lm_native_url", "http://127.0.0.1:1234")
    model_key = settings.get("model_key", "unsloth/orpheus-3b-0.1-ft-GGUF")

    if output_format not in ("ogg", "mp3", "wav"):
        return fail(f"unsupported output_format {output_format!r}")

    text = inp.get("text", "")
    if not text or not str(text).strip():
        return fail("input text is empty")

    voice = str(inp.get("voice", default_voice))
    if voice not in VOICES:
        return fail(f"unknown voice {voice!r}; choose from {', '.join(VOICES)}")

    script = os.path.join(engine_root, "tts.sh")
    if not os.path.isfile(script):
        return fail(
            f"engine script not found: {script}. "
            "The host agent must scaffold the Orpheus engine here "
            "(see HANDOFF.md). Fix 'engine_root' setting if it lives elsewhere."
        )

    cmd = [
        "bash", script,
        "--text", str(text),
        "--voice", voice,
        "--out_dir", JOB_DIR,
        "--format", output_format,
    ]
    for flag, key in (
        ("--temperature", "temperature"),
        ("--top_p", "top_p"),
        ("--repetition_penalty", "repetition_penalty"),
    ):
        if inp.get(key) is not None:
            cmd += [flag, str(inp[key])]

    emit({"type": "progress", "ratio": 0.05, "stage": "tts", "message": f"starting tts.sh voice={voice} format={output_format}"})
    t0 = time.time()
    try:
        proc = subprocess.run(cmd, cwd=engine_root, capture_output=True, text=True, timeout=540)
    except subprocess.TimeoutExpired:
        return fail("tts.sh timed out (>540s)")
    log_path = os.path.join(JOB_DIR, "tts.log")
    with open(log_path, "w", encoding="utf-8") as f:
        f.write(proc.stdout)
        f.write("\n--- stderr ---\n")
        f.write(proc.stderr)
    if proc.returncode != 0:
        emit({"type": "log", "message": (proc.stderr or proc.stdout)[-2000:]})
        return proc.returncode

    dest = os.path.join(JOB_DIR, "speech.%s" % output_format)
    if not os.path.isfile(dest):
        # Engine may have written speech.wav and skipped re-encode; accept known names.
        fallback = os.path.join(JOB_DIR, "speech.wav")
        if os.path.isfile(fallback):
            dest = fallback
        else:
            emit({"type": "log", "message": f"engine produced no speech.{output_format} in {JOB_DIR}"})
            return 1

    elapsed = round(time.time() - t0, 1)
    mime = {
        "ogg": "audio/ogg",
        "mp3": "audio/mpeg",
        "wav": "audio/wav",
    }[dest.split(".")[-1]]
    emit({
        "type": "result",
        "outputs": [{"path": os.path.basename(dest), "kind": mime}],
        "data": {
            "voice": voice,
            "engine_root": engine_root,
            "engine_exit": proc.returncode,
            "elapsed_sec": elapsed,
        },
    })
    return 0


if __name__ == "__main__":
    sys.exit(main())
