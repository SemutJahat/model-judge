#!/usr/bin/env node
// model-judge PreToolUse hook for the Agent (Task) tool.
// Reads the hook input on stdin; asks the judge; logs; prints a systemMessage for the user. With apply "spawn"
// (default) it leaves its decision for hooks/register.ts, which applies it at agent.spawn; with apply "input"
// (legacy) it prints updatedInput instead.
// Whatever happens it exits 0: it never blocks a subagent.
import { decide, writeLog, writeHandoff } from './lib.mjs';

async function readStdin() {
  let s = '';
  for await (const chunk of process.stdin) s += chunk;
  return s;
}

try {
  if (process.env.MODEL_JUDGE_INNER === '1') process.exit(0);
  const raw = await readStdin();
  let hookInput;
  try { hookInput = JSON.parse(raw); } catch { process.exit(0); }
  const { output, log, handoff } = await decide(hookInput);
  // apply "spawn": the decision goes to the hooks module, which applies it at agent.spawn; the call stays as written.
  if (handoff && !writeHandoff(hookInput.tool_use_id, handoff)) log.note = 'could not write the hand-off: not applied';
  writeLog(log);
  if (output) process.stdout.write(JSON.stringify(output));
} catch (e) {
  try { writeLog({ ts: new Date().toISOString(), action: 'unchanged', reason: `hook error: ${e?.message || e}` }); } catch {}
}
process.exit(0);
