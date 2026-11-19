Start one subagent with the Agent tool: subagent_type "general-purpose", description "slugify with tests", model "sonnet", run_in_background false. Give it the text of the task block below as its prompt, word for word, and add nothing. When it is done, tell me its answer in a few lines.

```task description="slugify with tests"
Write a Python function slugify(title: str) -> str that turns a title into a URL slug: lowercase, ASCII only (strip accents), words joined by single hyphens, no leading or trailing hyphens, and an empty result for input with no letters or digits. Handle edge cases (unicode, repeated separators, emoji, empty string) and include pytest tests for them. Do not use any tools: reply with the code only.
```

<!-- judge-router: expected medium: sonnet -> sonnet, effort medium -->
