#!/usr/bin/env node
// judge-router PreToolUse hook for the Agent (Task) tool.
// Reads the hook input on stdin; prints updatedInput with the judge's model/effort, or nothing.
// Whatever happens it exits 0: it never blocks a subagent.
import { decide, writeLog } from './lib.mjs';

async function readStdin() {
  let s = '';
  for await (const chunk of process.stdin) s += chunk;
  return s;
}

try {
  if (process.env.JUDGE_ROUTER_INNER === '1') process.exit(0);
  const raw = await readStdin();
  let hookInput;
  try { hookInput = JSON.parse(raw); } catch { process.exit(0); }
  const { output, log } = await decide(hookInput);
  writeLog(log);
  if (output) process.stdout.write(JSON.stringify(output));
} catch (e) {
  try { writeLog({ ts: new Date().toISOString(), action: 'unchanged', reason: `hook error: ${e?.message || e}` }); } catch {}
}
process.exit(0);
