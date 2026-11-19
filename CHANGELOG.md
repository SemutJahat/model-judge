# Changelog

## 0.3.0

- Renamed from `judge-router` to `model-judge`: plugin `model-judge@semutjahat`, command `/model-judge:log`,
  data folder `~/.claude/model-judge/`, environment variables `MODEL_JUDGE_*` (the old names are no longer
  read). To keep an old log, move `~/.claude/judge-router/` to `~/.claude/model-judge/`.

## 0.2.0

- The decision is applied at `agent.spawn` and `turn.step` (hooks module) instead of rewriting the Agent call,
  so auto mode no longer refuses routed calls. Verdict cache. Steadier judge rubric.

## 0.1.0

- First version.
