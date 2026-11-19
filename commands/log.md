---
description: Show model-judge's last subagent decisions (verdict, confidence, model, effort, judge time)
argument-hint: "[N]"
allowed-tools: Bash(node:*)
---
model-judge's decisions log (latest last):

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/log.mjs" $ARGUMENTS`

Show the table above to the user exactly as printed, inside a code block, and add nothing else: no summary, no commentary.
