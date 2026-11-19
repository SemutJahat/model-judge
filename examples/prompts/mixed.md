Start three subagents with the Agent tool, all three in one message so they run at the same time. For each: subagent_type "general-purpose", model "sonnet", run_in_background false, the description given on its task block, and the text of its task block below as its prompt, word for word, adding nothing. When all three are done, give me each one's answer in one or two lines.

```task description="count words"
Count the words in this sentence and reply with just the number: "The quick brown fox jumps over the lazy dog." Do not use any tools.
```

```task description="slugify with tests"
Write a Python function slugify(title: str) -> str that turns a title into a URL slug: lowercase, ASCII only (strip accents), words joined by single hyphens, no leading or trailing hyphens, and an empty result for input with no letters or digits. Handle edge cases (unicode, repeated separators, emoji, empty string) and include pytest tests for them. Do not use any tools: reply with the code only.
```

```task description="distributed rate limiter"
Without using any tools, design a concurrency-safe rate limiter for a distributed API gateway running on many nodes: compare token bucket, sliding window and GCRA, choose where state lives (Redis, gossip, local with sync), handle clock skew, node failure and hot keys, and explain the trade-offs between accuracy, latency and availability. Keep it under 400 words.
```

<!-- model-judge: all three request sonnet; expected easy -> haiku/low, medium -> sonnet/medium, hard -> opus/high -->
