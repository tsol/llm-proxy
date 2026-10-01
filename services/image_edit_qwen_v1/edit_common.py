"""Shared runner for WanGP instruction-edit services."""

import glob
import json
import os
import shutil
import subprocess
import time

JOB_DIR = os.environ["JOB_DIR"]
JOB_INPUT = os.environ.get("JOB_INPUT", os.path.join(JOB_DIR, "input.json"))
JOB_SETTINGS = os.environ.get("JOB_SETTINGS", os.path.join(JOB_DIR, "settings.json"))
IMAGE_EXTS = (".png", ".jpg", ".jpeg", ".webp")


def emit(obj: dict) -> None:
    print(json.dumps(obj), flush=True)


def load_json(path: str) -> dict:
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def newest_image(out_dir: str, since: float) -> str | None:
    found: list[str] = []
    for ext in IMAGE_EXTS:
        found.extend(glob.glob(os.path.join(out_dir, f"*{ext}")))
    found = [p for p in found if os.path.getmtime(p) >= since - 1]
    if not found:
        return None
    return max(found, key=os.path.getmtime)


def run_edit(model_key: str) -> int:
    inp = load_json(JOB_INPUT)
    settings = load_json(JOB_SETTINGS) if os.path.isfile(JOB_SETTINGS) else {}
    root = settings.get("videogen_root", "/home/harry/hermes/workspace/code/videogen")
    script = os.path.join(root, "edit_image.sh")
    prompt = inp["prompt"]
    image = inp["image_path"]
    seed = inp.get("seed")
    if not os.path.isfile(script):
        emit({"type": "log", "message": f"missing {script}"})
        return 1
    refs = inp.get("ref_image_paths") or []
    if not isinstance(refs, list):
        refs = []
    refs = [str(path) for path in refs if path][:3]
    cmd = [script, model_key, prompt, image]
    if seed is not None:
        cmd.append(str(seed))
    cmd.extend(refs)
    log_path = os.path.join(JOB_DIR, "edit.log")
    emit({"type": "progress", "ratio": 0.05, "stage": "edit", "message": f"starting edit_image.sh {model_key}"})
    t0 = time.time()
    with open(log_path, "w", encoding="utf-8") as logf:
        proc = subprocess.Popen(cmd, cwd=root, stdout=logf, stderr=subprocess.STDOUT)
        emit(
            {
                "type": "progress",
                "ratio": 0.1,
                "stage": "edit",
                "message": f"edit_image.sh running pid={proc.pid}",
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
    latest = newest_image(os.path.join(root, "outputs"), t0)
    if not latest:
        emit({"type": "log", "message": "no image in videogen outputs"})
        return 1
    ext = os.path.splitext(latest)[1].lower() or ".png"
    dest_name = f"image{ext}"
    dest = os.path.join(JOB_DIR, dest_name)
    if os.path.abspath(latest) != os.path.abspath(dest):
        shutil.copy2(latest, dest)
    kind = "image/png" if ext == ".png" else "image/jpeg" if ext in (".jpg", ".jpeg") else "image/webp"
    emit(
        {
            "type": "result",
            "outputs": [{"path": dest_name, "kind": kind}],
            "data": {"source": latest, "elapsed_sec": round(time.time() - t0, 1), "model": model_key},
        }
    )
    return 0
