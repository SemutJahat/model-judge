# Changelog

## 0.4.0

- Delegation nudge, opt-in (`"delegationNudge": "on"`, off by default): a `UserPromptSubmit` hook
  (`scripts/nudge.mjs`) asks the same judge whether the prompt is a medium/hard task that splits into parts that
  can run independently, and if so adds context suggesting the main agent delegate them to subagents (with the
  model and effort model-judge will likely pick), plus one line for the user (`⚖ model-judge: suggested
  delegation: N parts (…)`). Never blocks or forces. Skips short prompts (`nudgeMinChars`, 80), slash commands,
  prompts Claude Code submits itself (subagent hand-backs, notifications) and the judge's own runs; cached by
  prompt; logged as `"kind": "nudge"` and shown by `/model-judge:log`. Thresholds: `nudgeMinDifficulty`,
  `nudgeMinConfidence`, `nudgeMinParts`.

## 0.3.0

- Renamed from `judge-router` to `model-judge`: plugin `model-judge@semutjahat`, command `/model-judge:log`,
  data folder `~/.claude/model-judge/`, environment variables `MODEL_JUDGE_*` (the old names are no longer
  read). To keep an old log, move `~/.claude/judge-router/` to `~/.claude/model-judge/`.

## 0.2.0

- The decision is applied at `agent.spawn` and `turn.step` (hooks module) instead of rewriting the Agent call,
  so auto mode no longer refuses routed calls. Verdict cache. Steadier judge rubric.

## 0.1.0

- First version.
