Start one subagent with the Agent tool: subagent_type "general-purpose", description "vague task", model "sonnet", run_in_background false. Give it the text of the task block below as its prompt, word for word, and add nothing. When it is done, tell me its answer in a few lines.

```task description="vague task"
Look into it and do what's needed.
```

<!-- model-judge: expected unsure (confidence < 0.75): left unchanged, stays sonnet with no effort set -->
