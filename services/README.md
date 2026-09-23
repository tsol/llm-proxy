# Proxy exec services

GPU work runs as `kind: exec` jobs under the shared scheduler (eviction, queue, MCP).

**How to add a service:** [docs/adding-a-gpu-service.md](../docs/adding-a-gpu-service.md) · Hermes skill `workspace/skills/mlops/proxy-gpu-service/SKILL.md`

| Service | Source |
|---------|--------|
| `image_t2i_zturbo_v1` | ComfyUI Z-Turbo |
| `video_i2v_v1` | `videogen/i2v.sh` (`VIDEOGEN_USE_PROXY_QUEUE=1`) |
| `video_t2v_v1` | `videogen/t2v.sh` |
| `video_r2v_v1` | `videogen/r2v.sh` |
| `video_exec_v1` | Whitelisted `face_refine`, `bg_replace`, `scene_cinematic`, `dance_scene/*` |
| `motion_photo_object_v1` | `photo_to_object.py` |
| `motion_photo_scene_v1` | `photo_to_scene.py` |
| `motion_photo_avatar_v1` | `photo_to_avatar.py` |
| `motion_photos_avatar_v1` | `photos_to_avatar.py` |
| `motion_process_project_v1` | `process_project.py` |

Motion server: `USE_PROXY_GPU_QUEUE=1` (default) submits these instead of `freeGpuForLocalJob`.

Local LLM / vision: `POST /v1/chat/completions` (aliases `vision`, `gemma-4-12b`, …) uses `acquireLocalLlmLease`.
