# Adding a GPU exec service to the proxy

Exec services are folders under `services/<service_id>/`. The scheduler admits jobs by VRAM/RAM, starts required **residents** (ComfyUI, LM Studio), runs `entry`, and collects artifacts from `JOB_DIR`.

## Contract checklist

| Item | Rule |
|------|------|
| **Folder name** | Must equal `id` in `service.yaml` (e.g. `my_task_v1`). |
| **id** | `^[a-z][a-z0-9_]{2,63}$` |
| **kind** | Only `exec` today. |
| **entry** | Non-empty argv, e.g. `["python3", "run.py"]`. **cwd** = service folder. |
| **input_schema** | JSON Schema; validated on `POST /v1/services/:id/jobs` (Ajv, defaults + coercion). |
| **settings.schema.json** | Optional; persisted per service under `store/services/`. Exposed in UI. |
| **residents** | `requires`: who must be running (`comfyui`, `lmstudio`, or `[]`). `evicts`: idle residents to stop before run (`["*"]` = all). |
| **resources** | `vram_mb`, `ram_mb`, `cpu`; optional `min_free_vram_mb` for admission. |
| **estimate.duration_sec** | Used for queue ordering / UI ETA. |
| **timeout_sec** | Hard kill on the child process. |
| **run.py exit code** | `0` only on success; non-zero → job `failed`. |
| **Stdout protocol** | One JSON object per line (see below). |
| **Artifacts** | Final `result.outputs[]` paths are **relative to `JOB_DIR`**; runner resolves URLs under `~/hermes/outputs/<service_id>/<job_id>/`. |
| **MCP** | `mcp.expose: true` registers a tool named like `id`; optional `legacy_tool_names` for aliases. |

## Environment (injected by runner)

| Variable | Meaning |
|----------|---------|
| `JOB_ID` | Job id (`j_…`) |
| `JOB_DIR` | Writable output directory for this job |
| `JOB_INPUT` | Path to validated input JSON (`input.json`) |
| `JOB_SETTINGS` | Merged service settings JSON |
| `SERVICE_DIR` | Service package directory |
| `PROXY_URL` | `http://127.0.0.1:<port>` — use for `/v1/gpu/*` if needed |
| `COMFY_API_URL` / `LMSTUDIO_URL` | Host URLs from proxy config |

Do **not** manage GPU eviction inside the service when scheduled through the proxy — admission + residents already ran.

## Stdout JSON protocol

Print **one JSON object per line** to stdout (flush after each line).

### Progress (optional, repeatable)

```json
{"type": "progress", "ratio": 0.35, "stage": "encode", "message": "frame 120/300"}
```

- `ratio`: 0..1 (float)
- `stage` / `message`: shown in UI and SSE

### Final result (required once)

```json
{
  "type": "result",
  "outputs": [
    {"path": "out.mp4", "kind": "video/mp4"},
    {"path": "thumb.png", "kind": "image/png"}
  ],
  "data": {"any": "extra fields for clients"}
}
```

- Write files under `JOB_DIR` using the same relative `path` names.
- Job **fails** if process exits non-zero or no `result` line was parsed.

### Logging

```json
{"type": "log", "message": "human-readable line"}
```

Non-JSON stdout is appended to `job.log` only.

## Minimal `service.yaml`

```yaml
id: my_task_v1
title: "My GPU task"
description: "One-line description for UI/MCP."
version: "1.0.0"
kind: exec
entry: ["python3", "run.py"]
timeout_sec: 600
residents:
  requires: [comfyui]   # or [] if no resident
  evicts: ["*"]
resources:
  vram_mb: 6000
  ram_mb: 12000
  cpu: 2
estimate:
  duration_sec: 60
priority_default: normal
input_schema:
  type: object
  required: [prompt]
  additionalProperties: false
  properties:
    prompt: { type: string, minLength: 1 }
mcp:
  expose: true
  default_wait_sec: 120
```

## Minimal `run.py`

```python
#!/usr/bin/env python3
import json, os, sys

JOB_DIR = os.environ["JOB_DIR"]
JOB_INPUT = os.environ["JOB_INPUT"]

def emit(obj): print(json.dumps(obj), flush=True)

def main():
    inp = json.load(open(JOB_INPUT))
    emit({"type": "progress", "ratio": 0.1, "stage": "start", "message": "working"})
    out_name = "out.txt"
    open(os.path.join(JOB_DIR, out_name), "w").write(inp["prompt"])
    emit({"type": "result", "outputs": [{"path": out_name, "kind": "text/plain"}], "data": {}})
    return 0

if __name__ == "__main__":
    sys.exit(main())
```

## Register and test

1. Put the folder in `services/<id>/`.
2. `npm run build` && restart proxy (or `POST /v1/services/reload` if supported).
3. `GET /v1/services` — service listed.
4. `POST /v1/services/<id>/jobs` with body `{ "input": { ... }, "wait_sec": 60, "priority": "normal" }` and header `X-Principal: hermes`.
5. `node tests/admission.test.js` patterns for resource math.
6. Optional: `ui/Settings.vue` for custom settings tab (glob `services/*/ui/Settings.vue`).

## Patterns in this repo

| Pattern | Example |
|---------|---------|
| ComfyUI workflow | `image_t2i_zturbo_v1` |
| External shell (whitelist) | `video_exec_v1` → videogen scripts with `VIDEOGEN_PROXY_INNER=1` |
| Dedicated CLI wrapper | `video_i2v_v1`, `motion_photo_object_v1` |
| LLM / vision (not exec) | `POST /v1/chat/completions` + local LLM lease |

## Residents

Define idle footprint in `services/_residents/<id>/resident.yaml`. Scheduler uses these for admission and eviction — keep `idle_vram_mb` realistic.

## Hermes / Docker

- Host outputs: `~/hermes/outputs` → container `/opt/host-resources/outputs` (ro).
- MCP: `http://host.docker.internal:5001/mcp` (`local-services`).
- Thin CLI clients should call REST or MCP, not `gpu_prep` orchestrators.
