#!/usr/bin/env python3
"""Exec wrapper for videogen/i2v.sh (GPU prep via proxy scheduler)."""

import glob
import json
import os
import subprocess
import sys
import time

JOB_DIR = os.environ["JOB_DIR"]
JOB_INPUT = os.environ.get("JOB_INPUT", os.path.join(JOB_DIR, "input.json"))
JOB_SETTINGS = os.environ.get("JOB_SETTINGS", os.path.join(JOB_DIR, "settings.json"))
os.environ["VIDEOGEN_USE_PROXY_QUEUE"] = "0"


def emit(obj: dict) -> None:
    print(json.dumps(obj), flush=True)


def load_json(path: str) -> dict:
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def extend_h3(cmd: list, inp: dict) -> None:
    mapping = [
        ("music", "--music"),
        ("speech", "--speech"),
        ("soundscape", "--soundscape"),
        ("steps", "--steps"),
        ("flow_shift", "--flow-shift"),
        ("solver", "--solver"),
        ("attention_sparsity", "--sparsity"),
        ("cache_threshold", "--cache"),
        ("audio_refine", "--audio-refine"),
        ("resolution", "--resolution"),
    ]
    for key, flag in mapping:
        value = inp.get(key)
        if value is None:
            continue
        text = str(value).strip()
        if text == "" or text.lower() == "auto":
            continue
        cmd.extend([flag, text])


def main() -> int:
    inp = load_json(JOB_INPUT)
    settings = load_json(JOB_SETTINGS) if os.path.isfile(JOB_SETTINGS) else {}
    root = settings.get("videogen_root", "/home/harry/hermes/workspace/code/videogen")
    script = os.path.join(root, "i2v.sh")
    prompt = inp["prompt"]
    image = str(inp.get("image_path") or "").strip()
    end = str(inp.get("end_image_path") or "").strip()
    seed = inp.get("seed")
    if not image and not end:
        emit({"type": "log", "message": "image_path or end_image_path is required"})
        return 1
    if not os.path.isfile(script):
        emit({"type": "log", "message": f"missing {script}"})
        return 1
    cmd = [script]
    if end:
        cmd.extend(["--end", end])
    if inp.get("duration_sec") not in (None, ""):
        cmd.extend(["--seconds", str(inp["duration_sec"])])
    extend_h3(cmd, inp)
    cmd.append(prompt)
    if image:
        cmd.append(image)
    if seed is not None:
        cmd.append(str(seed))
    log_path = os.path.join(JOB_DIR, "i2v.log")
    emit({"type": "progress", "ratio": 0.05, "stage": "i2v", "message": "starting i2v.sh"})
    t0 = time.time()
    with open(log_path, "w", encoding="utf-8") as logf:
        proc = subprocess.Popen(cmd, cwd=root, stdout=logf, stderr=subprocess.STDOUT)
        emit(
            {
                "type": "progress",
                "ratio": 0.1,
                "stage": "i2v",
                "message": f"i2v.sh running pid={proc.pid}",
            }
        )
        returncode = proc.wait()
    log_text = ""
    if os.path.isfile(log_path):
        with open(log_path, encoding="utf-8", errors="replace") as f:
            log_text = f.read()
    if returncode != 0:
        emit({"type": "log", "message": log_text[-2000:]})
        return returncode
    out_dir = os.path.join(root, "outputs")
    candidates = sorted(glob.glob(os.path.join(out_dir, "*.mp4")), key=os.path.getmtime)
    if not candidates:
        emit({"type": "log", "message": "no mp4 in videogen outputs"})
        return 1
    latest = candidates[-1]
    dest = os.path.join(JOB_DIR, "video.mp4")
    if os.path.abspath(latest) != os.path.abspath(dest):
        import shutil

        shutil.copy2(latest, dest)
    elapsed = round(time.time() - t0, 1)
    emit(
        {
            "type": "result",
            "outputs": [{"path": "video.mp4", "kind": "video/mp4"}],
            "data": {"source_mp4": latest, "elapsed_sec": elapsed},
        }
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
