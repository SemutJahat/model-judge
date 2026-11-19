#!/usr/bin/env node
// judge-router's decisions as a compact table.
//   node scripts/log.mjs              the last 10 decisions
//   node scripts/log.mjs 25           the last 25 (also -n 25)
//   node scripts/log.mjs --watch      the last 10, then each new decision as it happens (Ctrl-C to stop)
//   node scripts/log.mjs --session ID only that session's    --json  the raw log lines
// Reads ~/.claude/judge-router/decisions.jsonl (or $JUDGE_ROUTER_DIR/decisions.jsonl).
import { existsSync, readFileSync, statSync, openSync, readSync, closeSync, watchFile } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from './lib.mjs';

const argv = process.argv.slice(2);
let n = 10, watch = false, session, json = false;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '-n') n = parseInt(argv[++i], 10);
  else if (a === '--watch' || a === '-f') watch = true;
  else if (a === '--session') session = argv[++i];
  else if (a === '--json') json = true;
  else if (/^\d+$/.test(a)) n = parseInt(a, 10);
}
if (!Number.isFinite(n) || n < 1) n = 10;

const FILE = join(dataDir(), 'decisions.jsonl');
const parse = (text) => text.split('\n').filter(Boolean)
  .map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .filter((e) => e && e.status !== 'guard' && e.status !== 'not-agent' && (!session || e.session_id === session));

const COLS = [
  ['time', 8], ['subagent', 28], ['verdict', 7], ['conf', 4], ['model', 17], ['effort', 13], ['judge', 6], ['result', 9],
];
const fit = (s, w) => { s = String(s ?? ''); return s.length > w ? s.slice(0, w - 1) + '…' : s.padEnd(w); };
const hhmmss = (ts) => { const d = new Date(ts); return Number.isNaN(+d) ? '' : d.toTimeString().slice(0, 8); };

function row(e) {
  const result = e.action === 'override' ? 'override' : e.status === 'unsure' ? 'unsure' : e.status === 'failed' ? 'failed' : 'skipped';
  return {
    time: hhmmss(e.ts),
    subagent: e.description ?? '',
    verdict: e.difficulty ?? '-',
    conf: typeof e.confidence === 'number' ? e.confidence.toFixed(2) : '-',
    model: `${e.model_before ?? 'default'}→${e.model_after ?? 'default'}`,
    effort: e.effort_before === e.effort_after ? (e.effort_after ?? '-') : `${e.effort_before ?? '-'}→${e.effort_after ?? '-'}`,
    judge: typeof e.judge_ms === 'number' ? `${(e.judge_ms / 1000).toFixed(1)}s` : '-',
    result,
  };
}
const line = (r) => COLS.map(([k, w]) => fit(r[k], w)).join('  ').trimEnd();
const header = () => line(Object.fromEntries(COLS.map(([k]) => [k, k]))) + '\n' + COLS.map(([, w]) => '─'.repeat(w)).join('  ');
const print = (e) => console.log(json ? JSON.stringify(e) : line(row(e)));

const all = existsSync(FILE) ? parse(readFileSync(FILE, 'utf8')) : [];
if (!json) {
  if (!all.length && !watch) {
    console.log(`no decisions yet in ${FILE}${session ? ` for session ${session}` : ''}`);
    process.exit(0);
  }
  console.log(header());
}
all.slice(-n).forEach(print);
if (!json && !watch && all.length) console.log(`(${Math.min(n, all.length)} of ${all.length}, from ${FILE})`);

if (watch) {
  if (!json) console.error(`watching ${FILE} (Ctrl-C to stop)`);
  let offset = existsSync(FILE) ? statSync(FILE).size : 0;
  let partial = '';
  watchFile(FILE, { interval: 500 }, (cur) => {
    if (cur.size < offset) offset = 0; // truncated or replaced
    if (cur.size === offset) return;
    const fd = openSync(FILE, 'r');
    const buf = Buffer.alloc(cur.size - offset);
    readSync(fd, buf, 0, buf.length, offset);
    closeSync(fd);
    offset = cur.size;
    const text = partial + buf.toString('utf8');
    const cut = text.lastIndexOf('\n');
    partial = text.slice(cut + 1);
    parse(text.slice(0, cut + 1)).forEach(print);
  });
}
