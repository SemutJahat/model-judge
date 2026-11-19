Start one subagent with the Agent tool: subagent_type "general-purpose", description "count words", model "sonnet", run_in_background false. Give it the text of the task block below as its prompt, word for word, and add nothing. When it is done, tell me its answer in a few lines.

```task description="count words"
Count the words in this sentence and reply with just the number: "The quick brown fox jumps over the lazy dog." Do not use any tools.
```

<!-- judge-router: expected easy: sonnet -> haiku, effort low -->
