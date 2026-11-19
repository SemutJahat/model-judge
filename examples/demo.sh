#!/usr/bin/env bash
# One-command demo of model-judge: ./examples/demo.sh [PROMPT_FILE]
# In a throwaway temp folder, a headless `claude -p --plugin-dir <this repo>` session (nothing installed, no
# settings files read, no MCP) runs examples/prompts/mixed.md: three subagents in one go, all requesting
# model "sonnet", with an easy, a medium and a hard task. Then it prints, per subagent: the requested model,
# the judge's verdict, what the hook set, and what the subagent actually ran with (from its transcript).
# Costs a few cents (one short Opus answer). Give another prompt file to run that one instead.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROMPT_FILE="${1:-$ROOT/examples/prompts/mixed.md}"
RUN="$(mktemp -d "${TMPDIR:-/tmp}/model-judge-demo.XXXXXX")"
echo "running $(basename "$PROMPT_FILE") headless in $RUN (about a minute)..."
"$ROOT/test/headless-run.sh" "$PROMPT_FILE" "$RUN"
echo
node "$ROOT/test/run-report.mjs" "$RUN"
