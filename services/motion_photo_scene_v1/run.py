#!/usr/bin/env python3
import json
import os
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
    script = os.path.join(root, "photo_to_scene.py")
    photo = inp["photo_path"]
    project_dir = inp["project_dir"]
    os.makedirs(project_dir, exist_ok=True)
    cmd = [
        py,
        script,
        "--project-dir",
        project_dir,
        "--photo",
        photo,
        "--checkpoint",
        str(inp.get("checkpoint", "vitl")),
        "--resize",
        str(inp.get("resize", 512)),
        "--far-mult",
        str(inp.get("far_mult", 1.2)),
        "--edge-rtol",
        str(inp.get("edge_rtol", 0.02)),
        "--edge-atol",
        str(inp.get("edge_atol", 0.02)),
        "--min-frac",
        str(inp.get("min_frac", 0.01)),
        "--min-faces",
        str(inp.get("min_faces", 100)),
    ]
    if inp.get("remove_person"):
        cmd.append("--remove-person")
    emit({"type": "progress", "ratio": 0.1, "stage": "photo_scene", "message": "running photo_to_scene"})
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
    with open(os.path.join(JOB_DIR, "scene.log"), "w", encoding="utf-8") as f:
        f.writelines(log)
    glb = os.path.join(project_dir, "scene.glb")
    if code != 0 or not os.path.isfile(glb):
        emit({"type": "log", "message": "".join(log)[-2000:]})
        return code or 1
    dest = os.path.join(JOB_DIR, "scene.glb")
    if os.path.abspath(glb) != os.path.abspath(dest):
        import shutil
        shutil.copy2(glb, dest)
    emit({"type": "result", "outputs": [{"path": "scene.glb", "kind": "model/gltf-binary"}], "data": {}})
    return 0


if __name__ == "__main__":
    sys.exit(main())
