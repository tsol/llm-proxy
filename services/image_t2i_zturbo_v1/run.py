#!/usr/bin/env python3
"""Z-Image Turbo exec service — ComfyUI must already be up (proxy scheduler)."""

import json
import os
import random
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

JOB_DIR = os.environ["JOB_DIR"]
JOB_INPUT = os.environ.get("JOB_INPUT", os.path.join(JOB_DIR, "input.json"))
JOB_SETTINGS = os.environ.get("JOB_SETTINGS", os.path.join(JOB_DIR, "settings.json"))
SERVICE_DIR = os.environ["SERVICE_DIR"]
COMFY = os.environ.get("COMFY_API_URL", "http://127.0.0.1:8188").rstrip("/")
JOB_ID = os.environ.get("JOB_ID", "job")


def emit(obj: dict) -> None:
    print(json.dumps(obj), flush=True)


def load_json(path: str) -> dict:
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def comfy_get(path: str) -> dict:
    with urllib.request.urlopen(f"{COMFY}{path}", timeout=30) as r:
        return json.loads(r.read().decode())


def comfy_post(path: str, payload: dict) -> dict:
    data = json.dumps(payload).encode()
    req = urllib.request.Request(
        f"{COMFY}{path}",
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode())


def patch_workflow(wf: dict, prompt: str, seed: int, steps: int, cfg: float, w: int, h: int, prefix: str):
    for node in wf.values():
        if not isinstance(node, dict):
            continue
        ct = node.get("class_type", "")
        inp = node.get("inputs", {})
        if ct == "CLIPTextEncode" and "text" in inp:
            inp["text"] = prompt
        if ct == "KSampler":
            if "seed" in inp:
                inp["seed"] = seed
            if "steps" in inp:
                inp["steps"] = steps
            if "cfg" in inp:
                inp["cfg"] = cfg
        if isinstance(inp, dict) and "width" in inp and "height" in inp:
            inp["width"] = w
            inp["height"] = h
        if ct == "SaveImage" and "filename_prefix" in inp:
            inp["filename_prefix"] = f"{prefix}_{JOB_ID}"
        node.pop("_meta", None)


def download_image(meta: dict, out_path: str) -> None:
    q = urllib.parse.urlencode(
        {
            "filename": meta["filename"],
            "subfolder": meta.get("subfolder") or "",
            "type": meta.get("type") or "output",
        }
    )
    with urllib.request.urlopen(f"{COMFY}/view?{q}", timeout=120) as r:
        data = r.read()
    with open(out_path, "wb") as f:
        f.write(data)


def wait_history(prompt_id: str, timeout_sec: int) -> dict:
    deadline = time.time() + timeout_sec
    while time.time() < deadline:
        try:
            history = comfy_get(f"/history/{prompt_id}")
        except Exception:
            time.sleep(1.5)
            continue
        entry = history.get(prompt_id)
        if not isinstance(entry, dict):
            time.sleep(1.5)
            continue
        st = entry.get("status", {})
        if st.get("status_str") == "error":
            raise RuntimeError(json.dumps(entry))
        if st.get("completed"):
            return entry
        emit({"type": "progress", "ratio": 0.5, "stage": "sampling", "message": "ComfyUI running"})
        time.sleep(1.5)
    raise TimeoutError(f"ComfyUI timeout ({timeout_sec}s)")


def main() -> int:
    inp = load_json(JOB_INPUT)
    settings = load_json(JOB_SETTINGS) if os.path.isfile(JOB_SETTINGS) else {}
    wf_path = os.path.join(SERVICE_DIR, settings.get("workflow_file", "workflow.json"))
    wf_base = load_json(wf_path)

    prompt = str(inp["prompt"])
    width = int(inp.get("width", 1024))
    height = int(inp.get("height", 1024))
    count = int(inp.get("count", 1))
    steps = int(inp.get("steps") or settings.get("default_steps", 8))
    cfg = float(settings.get("default_cfg", 1.0))
    poll_timeout = int(settings.get("poll_timeout_sec", 300))
    prefix = str(settings.get("filename_prefix", "zturbo"))

    seeds = []
    outputs = []
    prompt_ids = []

    for i in range(count):
        seed = int(inp.get("seed", -1))
        if seed == -1:
            seed = random.randint(0, 2**63 - 1)
        if i > 0:
            seed = seed + i
        seeds.append(seed)

        wf = json.loads(json.dumps(wf_base))
        patch_workflow(wf, prompt, seed, steps, cfg, width, height, prefix)
        emit({"type": "progress", "ratio": i / max(count, 1), "stage": "submit", "message": f"image {i+1}/{count}"})
        queued = comfy_post("/prompt", {"prompt": wf})
        prompt_id = queued.get("prompt_id")
        if not prompt_id:
            raise RuntimeError(f"no prompt_id: {queued}")
        prompt_ids.append(prompt_id)
        entry = wait_history(prompt_id, poll_timeout)
        images = []
        for out in entry.get("outputs", {}).values():
            images.extend(out.get("images", []))
        if not images:
            raise RuntimeError("no images in Comfy output")
        out_name = f"img_{i}.png"
        download_image(images[0], os.path.join(JOB_DIR, out_name))
        outputs.append({"path": out_name, "kind": "image/png"})

    emit(
        {
            "type": "result",
            "outputs": outputs,
            "data": {"seeds": seeds, "prompt": prompt, "comfy_prompt_ids": prompt_ids},
        }
    )
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:
        print(str(e), file=sys.stderr)
        sys.exit(1)
