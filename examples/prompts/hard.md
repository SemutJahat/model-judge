Start one subagent with the Agent tool: subagent_type "general-purpose", description "distributed rate limiter", model "sonnet", run_in_background false. Give it the text of the task block below as its prompt, word for word, and add nothing. When it is done, tell me its answer in a few lines.

```task description="distributed rate limiter"
Without using any tools, design a concurrency-safe rate limiter for a distributed API gateway running on many nodes: compare token bucket, sliding window and GCRA, choose where state lives (Redis, gossip, local with sync), handle clock skew, node failure and hot keys, and explain the trade-offs between accuracy, latency and availability. Keep it under 400 words.
```

<!-- judge-router: expected hard: sonnet -> opus, effort high -->
