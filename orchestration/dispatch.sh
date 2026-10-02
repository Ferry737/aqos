#!/usr/bin/env bash
# Dispatches one task to one worker agent in an isolated copy of the repo.
#
#   orchestration/dispatch.sh <task-file-stem> <agent> [model]
#
#   agent: hermes-gemini  (Hermes Agent, Google Gemini free tier, default gemini-3.8-flash)
#          hermes-glm     (Hermes Agent, Z.AI GLM free tier,      default glm-4.7-flash)
#          opencode-codestral (OpenCode, Mistral free tier,       default codestral-latest)
#
# Each run gets its own workspace under $AQOS_AGENT_RUNS (default ../aqos-agent-runs):
#   <runs>/<task>/ws    copy of the repo (no node_modules/docs) + AGENTS.md + TASK.md
#   <runs>/<task>/log   agent stdout/stderr
# The orchestrator reviews the workspace, then copies accepted deliverables back.
# Secrets: Hermes runs with the Cerebras/Mistral keys removed from its environment;
# OpenCode receives only the Mistral key (it needs it for the provider).
set -euo pipefail

TASK="${1:?task file stem, e.g. T-A-risk-core-tests}"
AGENT="${2:?agent: hermes-gemini | hermes-glm | opencode-codestral}"
MODEL="${3:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUNS="${AQOS_AGENT_RUNS:-$ROOT/../aqos-agent-runs}"
RUN="$RUNS/$TASK"
WS="$RUN/ws"
LOG="$RUN/log"
LOCAL="$(cygpath "${LOCALAPPDATA:-$HOME/AppData/Local}" 2>/dev/null || echo "$HOME/AppData/Local")"
HERMES_BIN="$LOCAL/hermes/bin"
OPENCODE_BIN="$LOCAL/Programs/@opencodedesktop/resources/opencode-cli.exe"

rm -rf "$RUN"; mkdir -p "$WS"
( cd "$ROOT" && tar cf - --exclude=node_modules --exclude=docs --exclude=orchestration . ) | ( cd "$WS" && tar xf - )
cp "$ROOT/orchestration/AGENTS.worker.md" "$WS/AGENTS.md"
cp "$ROOT/orchestration/tasks/$TASK.md" "$WS/TASK.md"; cp "$ROOT/orchestration/CONTRACTS.md" "$WS/CONTRACTS.md"
mkdir -p "$WS/tools/tests"

PROMPT="You are a worker agent. Read AGENTS.md and TASK.md in the current directory and do exactly what TASK.md says. Run the acceptance command and iterate until it passes. End with the short report that AGENTS.md requires."
export PATH="$PATH:$HERMES_BIN"

case "$AGENT" in
  hermes-gemini)
    CMD=(env -u CEREBRAS_API_KEY -u MISTRAL_API_KEY hermes -z "$PROMPT" --provider gemini -m "${MODEL:-gemini-3.8-flash}" --reasoning "${REASONING:-medium}" --usage-file "$RUN/usage.json") ;;
  hermes-glm)
    CMD=(env -u CEREBRAS_API_KEY -u MISTRAL_API_KEY hermes -z "$PROMPT" --provider zai -m "${MODEL:-glm-4.7-flash}" --usage-file "$RUN/usage.json") ;;
  opencode-codestral)
    CMD=(env -u CEREBRAS_API_KEY XDG_DATA_HOME="$RUN/oc-data" XDG_CONFIG_HOME="$RUN/oc-config" "$OPENCODE_BIN" run --standalone --auto -m "mistral/${MODEL:-codestral-latest}" "$PROMPT") ;;
  kilo)
    KILO="$(npm prefix -g)/kilo.cmd"
    CMD=(env -u CEREBRAS_API_KEY -u MISTRAL_API_KEY "$KILO" run --auto -m "kilo/${MODEL:-kilo-auto/free}" "$PROMPT") ;;
  *) echo "unknown agent: $AGENT" >&2; exit 2 ;;
esac

echo "[$(date -u +%FT%TZ)] dispatch $TASK -> $AGENT ${MODEL:-default}" | tee "$LOG"
set +e
( cd "$WS" && timeout "${AGENT_TIMEOUT:-1800}" "${CMD[@]}" ) >> "$LOG" 2>&1
echo "[$(date -u +%FT%TZ)] exit=$?" >> "$LOG"
