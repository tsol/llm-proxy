#!/usr/bin/env python3
"""Exec wrapper for videogen/cutout_image.sh."""

import json
import os
import subprocess
import time

JOB_DIR = os.environ["JOB_DIR"]
JOB_INPUT = os.environ.get("JOB_INPUT", os.path.join(JOB_DIR, "input.json"))
JOB_SETTINGS = os.environ.get("JOB_SETTINGS", os.path.join(JOB_DIR, "settings.json"))


def emit(obj: dict) -> None:
    print(json.dumps(obj), flush=True)


def main() -> int:
    with open(JOB_INPUT, encoding="utf-8") as f:
        inp = json.load(f)
    settings = {}
    if os.path.isfile(JOB_SETTINGS):
        with open(JOB_SETTINGS, encoding="utf-8") as f:
            settings = json.load(f)
    root = settings.get("videogen_root", "/home/harry/hermes/workspace/code/videogen")
    script = os.path.join(root, "cutout_image.sh")
    if not os.path.isfile(script):
        emit({"type": "log", "message": f"missing {script}"})
        return 1
    dest_name = "cutout.png"
    dest = os.path.join(JOB_DIR, dest_name)
    prompt = str(inp["prompt"]).strip()
    image = str(inp["image_path"])
    log_path = os.path.join(JOB_DIR, "cutout.log")
    emit({"type": "progress", "ratio": 0.05, "stage": "cutout", "message": "starting cutout_image.sh"})
    t0 = time.time()
    with open(log_path, "w", encoding="utf-8") as logf:
        proc = subprocess.Popen(
            [script, prompt, image, dest],
            cwd=root,
            stdout=logf,
            stderr=subprocess.STDOUT,
        )
        emit({"type": "progress", "ratio": 0.1, "stage": "cutout", "message": f"cutout_image.sh running pid={proc.pid}"})
        returncode = proc.wait()
    if returncode != 0 or not os.path.isfile(dest):
        text = ""
        if os.path.isfile(log_path):
            with open(log_path, encoding="utf-8", errors="replace") as f:
                text = f.read()[-2000:]
        emit({"type": "log", "message": text or "cutout produced no PNG"})
        return returncode or 1
    emit(
        {
            "type": "result",
            "outputs": [{"path": dest_name, "kind": "image/png"}],
            "data": {"elapsed_sec": round(time.time() - t0, 1)},
        }
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
