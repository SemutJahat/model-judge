#!/usr/bin/env node
// After test/headless-run.sh: one row per subagent the session started, joining by tool_use_id
//   - what the main agent requested (its Agent tool call, in RUN_DIR/stream.jsonl),
//   - the judge's verdict and what the hook set (RUN_DIR/log/decisions.jsonl),
//   - what the subagent ran with (its agent-*.meta.json and the model on its responses in agent-*.jsonl,
//     in the session's transcript folder under ~/.claude/projects/).
//   node test/run-report.mjs RUN_DIR [--json]
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const run = process.argv[2];
if (!run) { console.error('usage: run-report.mjs RUN_DIR [--json]'); process.exit(2); }
const jsonl = (f) => existsSync(f)
  ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
  : [];

const stream = jsonl(join(run, 'stream.jsonl'));
const decisions = jsonl(join(run, 'log', 'decisions.jsonl'));
const sessionId = stream.find((m) => m.type === 'system' && m.subtype === 'init')?.session_id;
const result = stream.find((m) => m.type === 'result');

const calls = stream
  .filter((m) => m.type === 'assistant' && !m.parent_tool_use_id)
  .flatMap((m) => m.message.content.filter((b) => b.type === 'tool_use' && (b.name === 'Agent' || b.name === 'Task')));

// The session's transcript folder: <config dir>/projects/<encoded cwd>/<session id>/subagents
function subagentsDir() {
  const projects = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects');
  if (!sessionId || !existsSync(projects)) return undefined;
  for (const p of readdirSync(projects)) {
    const d = join(projects, p, sessionId, 'subagents');
    if (existsSync(d)) return d;
  }
}
const subDir = subagentsDir();
const subagents = {};
if (subDir) {
  for (const f of readdirSync(subDir).filter((f) => f.endsWith('.meta.json'))) {
    const meta = JSON.parse(readFileSync(join(subDir, f), 'utf8'));
    const models = [...new Set(jsonl(join(subDir, f.replace(/\.meta\.json$/, '.jsonl')))
      .filter((m) => m.type === 'assistant' && m.message?.model).map((m) => m.message.model))];
    subagents[meta.toolUseId] = { meta, models };
  }
}

const rows = calls.map((c) => {
  const d = decisions.find((x) => x.tool_use_id === c.id) || {};
  const s = subagents[c.id] || {};
  return {
    subagent: c.input.description,
    requested: [c.input.model ?? '(none)', c.input.effort].filter(Boolean).join(' / '),
    verdict: d.difficulty ? `${d.difficulty} ${d.confidence}` : '-',
    hook: d.action === 'override' ? `${d.model_after} / ${d.effort_after}` : d.action ? 'unchanged' : '(no hook run)',
    started_with: s.meta ? `${s.meta.model ?? '(default)'} / ${s.meta.effort ?? '(default)'}` : '?',
    ran_on: s.models?.join(', ') || '?',
    why: d.why || d.reason || '',
  };
});

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ session: sessionId, rows, modelUsage: result?.modelUsage }, null, 2));
  process.exit(0);
}

const cols = [
  ['subagent', 'Subagent'], ['requested', 'Requested'], ['verdict', 'Judge verdict'],
  ['hook', 'Hook set'], ['started_with', 'Started with (meta)'], ['ran_on', 'Ran on (transcript)'],
];
const width = cols.map(([k, h]) => Math.max(h.length, ...rows.map((r) => String(r[k]).length)));
const line = (vals) => '| ' + vals.map((v, i) => String(v).padEnd(width[i])).join(' | ') + ' |';
console.log(line(cols.map(([, h]) => h)));
console.log('|' + width.map((w) => '-'.repeat(w + 2)).join('|') + '|');
for (const r of rows) console.log(line(cols.map(([k]) => r[k])));
console.log('');
for (const r of rows) console.log(`judge on "${r.subagent}": ${r.why}`);
if (result?.modelUsage) {
  console.log('');
  console.log('models billed in the session: ' + Object.entries(result.modelUsage)
    .map(([m, u]) => `${m} (${u.outputTokens} output tokens, $${u.costUSD.toFixed(4)})`).join(', '));
}
console.log('');
console.log(`session ${sessionId ?? '?'}; transcripts: ${subDir ?? '(not found)'}`);
console.log(`judge-router log: ${join(run, 'log', 'decisions.jsonl')}`);
if (!calls.length) console.log('the main agent started no subagent: see ' + join(run, 'stream.jsonl'));
