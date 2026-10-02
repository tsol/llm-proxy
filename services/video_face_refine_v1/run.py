#!/usr/bin/env python3
"""Exec wrapper for videogen/face_refine.sh."""

import glob
import json
import os
import shutil
import subprocess
import sys
import time

JOB_DIR = os.environ["JOB_DIR"]
JOB_INPUT = os.environ.get("JOB_INPUT", os.path.join(JOB_DIR, "input.json"))
JOB_SETTINGS = os.environ.get("JOB_SETTINGS", os.path.join(JOB_DIR, "settings.json"))
os.environ["VIDEOGEN_USE_PROXY_QUEUE"] = "0"


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
    script = os.path.join(root, "face_refine.sh")
    if not os.path.isfile(script):
        emit({"type": "log", "message": f"missing {script}"})
        return 1
    cmd = [script]
    if inp.get("quality"):
        cmd.extend(["--quality", str(inp["quality"])])
    if inp.get("strength") is not None:
        cmd.extend(["--strength", str(inp["strength"])])
    if inp.get("faces") is not None:
        cmd.extend(["--faces", str(inp["faces"])])
    refs = []
    raw_refs = inp.get("ref_image_paths")
    if isinstance(raw_refs, list):
        refs.extend(str(path).strip() for path in raw_refs if str(path).strip())
    single = str(inp.get("ref_image_path") or "").strip()
    if single and single not in refs:
        refs.append(single)
    for ref in refs:
        cmd.extend(["--ref", ref])
    if inp.get("prompt"):
        cmd.extend(["--prompt", str(inp["prompt"])])
    cmd.append(str(inp["video_path"]))
    if inp.get("seed") is not None:
        cmd.append(str(inp["seed"]))
    log_path = os.path.join(JOB_DIR, "face_refine.log")
    emit({"type": "progress", "ratio": 0.05, "stage": "face_refine", "message": "starting face_refine.sh"})
    t0 = time.time()
    with open(log_path, "w", encoding="utf-8") as logf:
        proc = subprocess.Popen(cmd, cwd=root, stdout=logf, stderr=subprocess.STDOUT)
        returncode = proc.wait()
    if returncode != 0:
        with open(log_path, encoding="utf-8", errors="replace") as f:
            emit({"type": "log", "message": f.read()[-2000:]})
        return returncode
    candidates = sorted(glob.glob(os.path.join(root, "outputs", "*.mp4")), key=os.path.getmtime)
    if not candidates:
        emit({"type": "log", "message": "no mp4 in videogen outputs"})
        return 1
    latest = candidates[-1]
    dest = os.path.join(JOB_DIR, "video.mp4")
    if os.path.abspath(latest) != os.path.abspath(dest):
        shutil.copy2(latest, dest)
    emit({
        "type": "result",
        "outputs": [{"path": "video.mp4", "kind": "video/mp4"}],
        "data": {"source_mp4": latest, "elapsed_sec": round(time.time() - t0, 1)},
    })
    return 0


if __name__ == "__main__":
    sys.exit(main())
