#!/usr/bin/env bash
# Runs the whole free-model task list unattended: up to 3 tasks in parallel,
# up to 3 attempts per task on rotating free models, each attempt gated by
# orchestration/accept.mjs. Output: $RUNS/pipeline.log and $RUNS/<task>/accept.json
#   bash orchestration/pipeline.sh [task ...]      (default: every task in tasks.json)
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export AQOS_AGENT_RUNS="${AQOS_AGENT_RUNS:-$ROOT/../aqos-agent-runs}"
export AGENT_TIMEOUT="${AGENT_TIMEOUT:-2100}"
RUNS="$AQOS_AGENT_RUNS"; mkdir -p "$RUNS"
LOG="$RUNS/pipeline.log"
MODELS=("kilo-auto/free" "qwen/qwen3.8-27b:free" "nvidia/nemotron-3-ultra-550b-a55b:free")

if [ "$#" -gt 0 ]; then TASKS=("$@"); else TASKS=($(node -e 'console.log(Object.keys(require("./orchestration/tasks.json")).join(" "))')); fi

run_task() {
  local t="$1"
  for i in 0 1 2; do
    echo "[$(date -u +%T)] $t attempt $((i+1)) model ${MODELS[$i]}" >> "$LOG"
    bash "$ROOT/orchestration/dispatch.sh" "$t" kilo "${MODELS[$i]}" > /dev/null 2>&1
    if node "$ROOT/orchestration/accept.mjs" "$t" "$RUNS" >> "$LOG" 2>&1; then return 0; fi
  done
  echo "[$(date -u +%T)] $t GAVE UP after 3 attempts" >> "$LOG"
  return 1
}
export -f run_task; export ROOT LOG RUNS; export MODELS_STR="${MODELS[*]}"

cd "$ROOT"
printf '%s\n' "${TASKS[@]}" | xargs -P 3 -I{} bash -c 'MODELS=($MODELS_STR); run_task {}'
echo "[$(date -u +%T)] pipeline finished" >> "$LOG"
