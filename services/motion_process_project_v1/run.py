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
    script = os.path.join(root, "process_project.py")
    project_dir = inp["project_dir"]
    cmd = [py, script, "--project-dir", project_dir]
    if inp.get("static_cam", True):
        cmd.append("--static-cam")
    else:
        cmd.append("--no-static-cam")
    if inp.get("full_reprocess"):
        cmd.append("--full-reprocess")
    proc = subprocess.Popen(cmd, cwd=root, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    log: list[str] = []
    for line in proc.stdout or []:
        log.append(line)
        s = line.strip()
        if s.startswith("{") and '"type"' in s:
            try:
                ev = json.loads(s)
                if ev.get("type") == "progress":
                    emit(ev)
            except json.JSONDecodeError:
                pass
    code = proc.wait()
    with open(os.path.join(JOB_DIR, "process.log"), "w", encoding="utf-8") as f:
        f.writelines(log)
    motion = os.path.join(project_dir, "motion.json")
    if code != 0 or not os.path.isfile(motion):
        emit({"type": "log", "message": "".join(log)[-2000:]})
        return code or 1
    dest = os.path.join(JOB_DIR, "motion.json")
    shutil.copy2(motion, dest)
    emit({"type": "result", "outputs": [{"path": "motion.json", "kind": "application/json"}], "data": {}})
    return 0


if __name__ == "__main__":
    sys.exit(main())
