#!/usr/bin/env node
// Status line: judge-router's last decision in this session, e.g.  ⚖ opus/high · hard 0.85 · "rate limiter"
// Opt in with one line in a settings file (see README):
//   "statusLine": { "type": "command", "command": "node /path/to/judge-router/scripts/statusline.mjs" }
// Claude Code passes the session as JSON on stdin; prints nothing until the session's first subagent.
// JUDGE_ROUTER_STATUS_PREFIX / _SUFFIX wrap it, so it can sit next to an existing status line.
import { existsSync, openSync, readSync, closeSync, fstatSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from './lib.mjs';

export function statusText(e) {
  if (!e) return '';
  const name = e.description ? ` · "${e.description.length > 24 ? e.description.slice(0, 23) + '…' : e.description}"` : '';
  const conf = typeof e.confidence === 'number' ? ` ${e.confidence.toFixed(2)}` : '';
  if (e.action === 'override') return `⚖ ${e.model_after}${e.effort_after ? '/' + e.effort_after : ''} · ${e.difficulty}${conf}${name}`;
  if (e.status === 'unsure') return `⚖ ${e.model_before ?? 'default'} (unsure${conf})${name}`;
  if (e.status === 'failed') return `⚖ ${e.model_before ?? 'default'} (judge failed)${name}`;
  return `⚖ ${e.model_before ?? 'default'} (skipped)${name}`;
}

// The last decision of a session: read only the file's tail.
export function lastDecision(file, sessionId) {
  if (!existsSync(file)) return undefined;
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    const len = Math.min(size, 256 * 1024);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n').reverse();
    for (const l of lines) {
      let e;
      try { e = JSON.parse(l); } catch { continue; }
      if (e.event || e.status === 'guard' || e.status === 'not-agent') continue;
      if (!sessionId || e.session_id === sessionId) return e;
    }
  } finally { closeSync(fd); }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let input = '';
  try { for await (const c of process.stdin) input += c; } catch {}
  let sessionId;
  try { sessionId = JSON.parse(input).session_id; } catch {}
  let text = '';
  try { text = statusText(lastDecision(join(dataDir(), 'decisions.jsonl'), sessionId)); } catch {}
  if (text) process.stdout.write(`${process.env.JUDGE_ROUTER_STATUS_PREFIX ?? ''}${text}${process.env.JUDGE_ROUTER_STATUS_SUFFIX ?? ''}`);
}
