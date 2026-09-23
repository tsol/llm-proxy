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


def main() -> int:
    inp = load_json(JOB_INPUT)
    settings = load_json(JOB_SETTINGS) if os.path.isfile(JOB_SETTINGS) else {}
    root = settings.get("videogen_root", "/home/harry/hermes/workspace/code/videogen")
    script = os.path.join(root, "i2v.sh")
    prompt = inp["prompt"]
    image = inp["image_path"]
    seed = inp.get("seed")
    if not os.path.isfile(script):
        emit({"type": "log", "message": f"missing {script}"})
        return 1
    cmd = [script, prompt, image]
    if seed is not None:
        cmd.append(str(seed))
    emit({"type": "progress", "ratio": 0.05, "stage": "i2v", "message": "starting i2v.sh"})
    t0 = time.time()
    proc = subprocess.run(cmd, cwd=root, capture_output=True, text=True)
    log_path = os.path.join(JOB_DIR, "i2v.log")
    with open(log_path, "w", encoding="utf-8") as f:
        f.write(proc.stdout)
        f.write(proc.stderr)
    if proc.returncode != 0:
        emit({"type": "log", "message": proc.stderr[-2000:]})
        return proc.returncode
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
