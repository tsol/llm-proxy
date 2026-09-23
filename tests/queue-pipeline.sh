#!/usr/bin/env bash
# Mixed GPU queue: zgen → vision (proxy alias) → local text → optional heavy jobs (queued).
set -euo pipefail
BASE="${GPU_PROXY_URL:-http://127.0.0.1:5001}"
BASE="${BASE%/}"
TOOLS="/home/harry/hermes/workspace/tools"
OUT="/home/harry/hermes/outputs"
export GPU_PROXY_URL="$BASE"
export PATH="$TOOLS:$PATH"

snap() {
  curl -sf "$BASE/v1/scheduler" | jq -c '{running: [.running[].key], queued: [.queued[] | {key, score, wait: .wait_reason}]}'
}

# Release ComfyUI VRAM if a prior zgen left it resident (scheduler will restart when needed).
curl -sf -X POST "$BASE/v1/gpu/comfy/stop" -H 'content-type: application/json' -d '{"force":true}' >/dev/null || true
sleep 2

echo "=== scheduler (idle) ==="
snap

echo "=== 1) zgen image ==="
Z=$(zgen "queue test orange circle" --width 256 --height 256 --steps 4)
echo "$Z" | jq -c '{status, job_id, files}'
IMG=$(echo "$Z" | jq -r '.host_files[0] // .files[0]')
[[ -f "$IMG" ]] || { echo "missing image $IMG"; exit 1; }

echo "=== 2) vision alias (queued LLM) ==="
snap
CONTAINER_IMG="/opt/host-resources/outputs/${IMG#/home/harry/hermes/outputs/}"
if docker ps --format '{{.Names}}' | grep -qx hermes-agent; then
  V=$(docker exec -e GPU_PROXY_URL=http://host.docker.internal:5001 hermes-agent \
    python3 /opt/data/workspace/tools/vision_qwen2vl.py "$CONTAINER_IMG" \
    --prompt "One sentence: main color and shape?" 2>&1 | tail -1)
else
  V=$(python3 "$TOOLS/vision_qwen2vl.py" "$IMG" --prompt "One sentence: main color and shape?" 2>&1 | tail -1)
fi
echo "$V" | jq -c '{status, via_proxy, model_alias, content: (.content // .error | tostring | .[0:120])}' || { echo "$V"; exit 1; }

echo "=== 3) local text (gemma-4-12b if configured) ==="
snap
T=$(curl -sf "$BASE/v1/chat/completions" \
  -H 'Content-Type: application/json' -H 'X-Principal: queue-test' \
  -d '{"model":"gemma-4-12b","messages":[{"role":"user","content":"Reply with one word: ok"}],"max_tokens":8}' \
  2>/dev/null || echo '{"error":"chat failed"}')
echo "$T" | jq -c '{model: .model, content: (.choices[0].message.content // .error.message // .error)}'

echo "=== 4) enqueue i2v + t2v + motion object (no wait) ==="
TJOB=$(curl -sf -X POST "$BASE/v1/services/video_t2v_v1/jobs" \
  -H 'content-type: application/json' \
  -d '{"input":{"prompt":"a red ball rolling"},"wait_sec":0}' | jq -r '.job.id // .id')
echo "t2v_job=$TJOB"
echo "=== 4b) i2v + object ==="
IMG_ABS="$IMG"
curl -sf -X POST "$BASE/v1/services/reload" >/dev/null || true
VJOB=$(curl -sf -X POST "$BASE/v1/services/video_i2v_v1/jobs" \
  -H 'content-type: application/json' \
  -d "{\"input\":{\"prompt\":\"gentle zoom\",\"image_path\":\"$IMG_ABS\"},\"wait_sec\":0}" | jq -r '.job.id // .id')
OJOB=$(curl -sf -X POST "$BASE/v1/services/motion_photo_object_v1/jobs" \
  -H 'content-type: application/json' \
  -d "{\"input\":{\"photo_path\":\"$IMG_ABS\"},\"wait_sec\":0}" | jq -r '.job.id // .id')
echo "video_job=$VJOB object_job=$OJOB"
sleep 2
echo "=== scheduler (after enqueue) ==="
snap
curl -sf "$BASE/v1/jobs/$VJOB" | jq -c '{id: .job.id, status: .job.status, wait: .job.wait_reason}'
curl -sf "$BASE/v1/jobs/$OJOB" | jq -c '{id: .job.id, status: .job.status, wait: .job.wait_reason}'

echo "=== cancel heavy jobs (smoke test only) ==="
curl -sf -X DELETE "$BASE/v1/jobs/$TJOB" | jq -r '.job.status' || true
curl -sf -X DELETE "$BASE/v1/jobs/$VJOB" | jq -r '.job.status' || true
curl -sf -X DELETE "$BASE/v1/jobs/$OJOB" | jq -r '.job.status' || true
echo "=== done ==="
