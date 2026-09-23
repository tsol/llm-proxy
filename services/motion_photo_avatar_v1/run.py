#!/usr/bin/env python3
import json
import os
import shutil
import subprocess
import sys

JOB_DIR = os.environ["JOB_DIR"]
JOB_INPUT = os.environ.get("JOB_INPUT", os.path.join(JOB_DIR, "input.json"))
JOB_SETTINGS = os.environ.get("JOB_SETTINGS", os.path.join(JOB_DIR, "settings.json"))


def emit(obj: dict) -> None:
    print(json.dumps(obj), flush=True)


def load_json(path: str) -> dict:
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def main() -> int:
    inp = load_json(JOB_INPUT)
    settings = load_json(JOB_SETTINGS) if os.path.isfile(JOB_SETTINGS) else {}
    root = settings.get("motion_root", "/home/harry/hermes/workspace/topics/video-motion-pipeline")
    py = settings.get("python_bin", os.path.join(root, "gem-x", ".venv", "bin", "python"))
    script = os.path.join(root, "photo_to_avatar.py")
    project_dir = inp["project_dir"]
    cmd = [py, script, "--project-dir", project_dir, "--photo", inp["photo_path"]]
    proc = subprocess.run(cmd, cwd=root, capture_output=True, text=True)
    with open(os.path.join(JOB_DIR, "avatar.log"), "w", encoding="utf-8") as f:
        f.write(proc.stdout)
        f.write(proc.stderr)
    glb = os.path.join(project_dir, "avatar.glb")
    if proc.returncode != 0 or not os.path.isfile(glb):
        emit({"type": "log", "message": (proc.stderr or proc.stdout)[-2000:]})
        return proc.returncode or 1
    dest = os.path.join(JOB_DIR, "avatar.glb")
    shutil.copy2(glb, dest)
    emit({"type": "result", "outputs": [{"path": "avatar.glb", "kind": "model/gltf-binary"}], "data": {}})
    return 0


if __name__ == "__main__":
    sys.exit(main())
