#!/usr/bin/env python3
import glob
import json
import os
import subprocess
import sys

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
    script = os.path.join(root, "r2v.sh")
    cmd = [script]
    if inp.get("cutout"):
        cmd.append("--cutout")
    if inp.get("resolution"):
        cmd.extend(["--resolution", inp["resolution"]])
    cmd.append(inp["prompt"])
    cmd.extend(inp["image_paths"])
    if inp.get("seed") is not None:
        cmd.append(str(inp["seed"]))
    proc = subprocess.run(cmd, cwd=root, capture_output=True, text=True)
    with open(os.path.join(JOB_DIR, "r2v.log"), "w", encoding="utf-8") as f:
        f.write(proc.stdout)
        f.write(proc.stderr)
    if proc.returncode != 0:
        emit({"type": "log", "message": proc.stderr[-2000:]})
        return proc.returncode
    out_dir = os.path.join(root, "outputs")
    mp4s = sorted(glob.glob(os.path.join(out_dir, "*.mp4")), key=os.path.getmtime)
    if not mp4s:
        return 1
    import shutil
    shutil.copy2(mp4s[-1], os.path.join(JOB_DIR, "video.mp4"))
    emit({"type": "result", "outputs": [{"path": "video.mp4", "kind": "video/mp4"}], "data": {}})
    return 0


if __name__ == "__main__":
    sys.exit(main())
