#!/usr/bin/env node
// Ask only the judge, no subagent started: prints the verdict and the model/effort judge-router would set.
//
//   node examples/dry-run.mjs "Count the words in: the quick brown fox"
//   echo "Design a distributed rate limiter" | node examples/dry-run.mjs
//   node examples/dry-run.mjs --file examples/prompts/mixed.md     # judges each ```task block of the file
//   options: --model sonnet (what the caller requested)  --description TEXT  --type AGENT_TYPE  --json  --log
//            --cache (use the verdict cache, as the hook does; off by default so each run asks the judge)
//
// It runs lib.mjs's decide() exactly as the hook does (same config, same judge, same threshold), but writes
// nothing to the decisions log unless --log is given.
import { readFileSync } from 'node:fs';
import { decide, writeLog, loadConfig } from '../scripts/lib.mjs';

const argv = process.argv.slice(2);
const opt = { model: undefined, description: 'dry run', type: 'general-purpose', json: false, log: false, file: undefined, cache: false };
const words = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--model') opt.model = argv[++i];
  else if (a === '--description') opt.description = argv[++i];
  else if (a === '--type') opt.type = argv[++i];
  else if (a === '--file') opt.file = argv[++i];
  else if (a === '--json') opt.json = true;
  else if (a === '--log') opt.log = true;
  else if (a === '--cache') opt.cache = true;
  else if (a === '-h' || a === '--help') {
    console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 10).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
    process.exit(0);
  } else words.push(a);
}

// A prompt file's ```task description="…" blocks are the subagent prompts; without such blocks, the whole text is one.
export function tasksOf(text, fallbackDescription) {
  const tasks = [...text.matchAll(/```task(?:[ \t]+description="([^"]*)")?[^\n]*\n([\s\S]*?)\n```/g)]
    .map((m) => ({ description: m[1] || fallbackDescription, prompt: m[2].trim() }));
  return tasks.length ? tasks : [{ description: fallbackDescription, prompt: text.trim() }];
}

let text;
if (opt.file) text = readFileSync(opt.file, 'utf8');
else if (words.length) text = words.join(' ');
else if (!process.stdin.isTTY) { text = ''; for await (const c of process.stdin) text += c; }
if (!text || !text.trim()) { console.error('give a prompt as an argument, on stdin, or with --file'); process.exit(2); }

const cfg = loadConfig();
const tasks = opt.file ? tasksOf(text, opt.description) : [{ description: opt.description, prompt: text.trim() }];
const results = await Promise.all(tasks.map(async (t) => {
  const hookInput = {
    session_id: 'dry-run', tool_use_id: 'dry-run', hook_event_name: 'PreToolUse', tool_name: 'Agent',
    tool_input: { description: t.description, prompt: t.prompt, subagent_type: opt.type, ...(opt.model ? { model: opt.model } : {}) },
  };
  // A dry run asks the judge every time unless --cache: repeated runs are how you check it is stable.
  const { output, log } = await decide(hookInput, { cfg: opt.cache ? cfg : { ...cfg, cacheTtlMs: 0 } });
  if (opt.log) writeLog(log);
  return log;
}));

if (opt.json) { console.log(JSON.stringify(results.length === 1 ? results[0] : results, null, 2)); process.exit(0); }
for (const r of results) {
  const verdict = r.difficulty ? `${r.difficulty} (confidence ${r.confidence})` : 'no verdict';
  const change = r.action === 'override'
    ? `would set model ${r.model_before ?? '(none)'} -> ${r.model_after}, effort ${r.effort_before ?? '(none)'} -> ${r.effort_after}`
    : `would leave it unchanged (model stays ${r.model_before ?? '(default)'}): ${r.reason}`;
  console.log(`- ${r.description}`);
  console.log(`  verdict: ${verdict}${r.judge ? `, judge ${r.judge}, ${r.judge_ms} ms` : ''}`);
  if (r.why) console.log(`  why:     ${r.why}`);
  console.log(`  ${change}`);
}
if (results.some((r) => r.action !== 'override')) console.log(`(threshold ${cfg.confidenceThreshold}, from config.json)`);
