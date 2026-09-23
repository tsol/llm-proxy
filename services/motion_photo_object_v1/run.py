#!/usr/bin/env python3
"""Exec wrapper for motion photo_to_object.py."""

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
    root = settings.get(
        "motion_root", "/home/harry/hermes/workspace/topics/video-motion-pipeline"
    )
    py = settings.get(
        "python_bin",
        os.path.join(root, "gem-x", ".venv", "bin", "python"),
    )
    script = os.path.join(root, "photo_to_object.py")
    photo = inp["photo_path"]
    backend = inp.get("backend", "auto")
    project_dir = inp.get("project_dir") or os.path.join(JOB_DIR, "project")
    os.makedirs(project_dir, exist_ok=True)
    if not os.path.isfile(photo):
        emit({"type": "log", "message": f"photo not found: {photo}"})
        return 1
    emit({"type": "progress", "ratio": 0.1, "stage": "photo_object", "message": "running SF3D/TripoSR"})
    cmd = [
        py,
        script,
        "--project-dir",
        project_dir,
        "--photo",
        photo,
        "--backend",
        backend,
    ]
    log_path = os.path.join(JOB_DIR, "object.log")
    proc = subprocess.Popen(
        cmd,
        cwd=root,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    log_lines: list[str] = []
    for line in proc.stdout or []:
        log_lines.append(line)
        s = line.strip()
        if s.startswith("{") and '"type"' in s:
            try:
                ev = json.loads(s)
                if ev.get("type") == "progress":
                    emit(ev)
            except json.JSONDecodeError:
                pass
    code = proc.wait()
    with open(log_path, "w", encoding="utf-8") as f:
        f.writelines(log_lines)
    glb = os.path.join(project_dir, "object.glb")
    if code != 0 or not os.path.isfile(glb):
        emit({"type": "log", "message": "".join(log_lines)[-2000:]})
        return code or 1
    dest = os.path.join(JOB_DIR, "object.glb")
    if os.path.abspath(glb) != os.path.abspath(dest):
        shutil.copy2(glb, dest)
    emit(
        {
            "type": "result",
            "outputs": [{"path": "object.glb", "kind": "model/gltf-binary"}],
            "data": {"backend": backend, "project_dir": project_dir},
        }
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
