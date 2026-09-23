#!/usr/bin/env python3
"""Run whitelisted videogen shell scripts under proxy scheduler."""

import json
import os
import re
import subprocess
import sys

JOB_DIR = os.environ["JOB_DIR"]
JOB_INPUT = os.environ.get("JOB_INPUT", os.path.join(JOB_DIR, "input.json"))
JOB_SETTINGS = os.environ.get("JOB_SETTINGS", os.path.join(JOB_DIR, "settings.json"))

ALLOWED = re.compile(
    r"^(face_refine|bg_replace|scene_cinematic)\.sh$"
    r"|^dance_scene/(vace_bg_replace|ref2va_replace|vace_char_replace)\.sh$"
)


def emit(obj: dict) -> None:
    print(json.dumps(obj), flush=True)


def load_json(path: str) -> dict:
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def main() -> int:
    inp = load_json(JOB_INPUT)
    settings = load_json(JOB_SETTINGS) if os.path.isfile(JOB_SETTINGS) else {}
    root = settings.get("videogen_root", "/home/harry/hermes/workspace/code/videogen")
    script_rel = inp["script"].replace("\\", "/").lstrip("/")
    if not ALLOWED.match(script_rel):
        emit({"type": "log", "message": f"script not allowed: {script_rel}"})
        return 1
    script = os.path.realpath(os.path.join(root, script_rel))
    if not script.startswith(os.path.realpath(root) + os.sep) and script != os.path.realpath(root):
        emit({"type": "log", "message": "path escape"})
        return 1
    if not os.path.isfile(script):
        emit({"type": "log", "message": f"missing {script}"})
        return 1
    argv = [str(a) for a in inp.get("argv") or []]
    env = {**os.environ, "VIDEOGEN_USE_PROXY_QUEUE": "0", "VIDEOGEN_PROXY_INNER": "1"}
    emit({"type": "progress", "ratio": 0.05, "stage": "videogen", "message": script_rel})
    proc = subprocess.run(["bash", script, *argv], cwd=root, capture_output=True, text=True, env=env)
    with open(os.path.join(JOB_DIR, "exec.log"), "w", encoding="utf-8") as f:
        f.write(proc.stdout)
        f.write(proc.stderr)
    if proc.returncode != 0:
        emit({"type": "log", "message": (proc.stderr or proc.stdout)[-2000:]})
        return proc.returncode
    emit(
        {
            "type": "result",
            "outputs": [],
            "data": {"script": script_rel, "argv": argv, "log_tail": (proc.stdout + proc.stderr)[-500:]},
        }
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
