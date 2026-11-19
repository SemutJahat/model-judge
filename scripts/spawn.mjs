#!/usr/bin/env node
// Helper of the hooks module (hooks/register.ts), which has no Node of its own and runs this with $.process.run.
//   node scripts/spawn.mjs take      stdin {tool_use_id}  -> stdout the PreToolUse hook's decision for that call, or {}
//   node scripts/spawn.mjs applied   stdin {tool_use_id, agentId, model, effort, session_id}  -> logs what was applied
//                                    ({kind: "request", agentId, model, effort, wanted}: what a request carried)
// Always exits 0 and prints JSON: a failure here must never stop a subagent.
import { takeHandoff, writeLog } from './lib.mjs';

let input = {};
try {
  let s = '';
  for await (const c of process.stdin) s += c;
  input = JSON.parse(s || '{}');
} catch {}
const cmd = process.argv[2];
try {
  if (cmd === 'take') {
    process.stdout.write(JSON.stringify(takeHandoff(input.tool_use_id) ?? {}));
  } else if (cmd === 'applied') {
    // kind "spawn" (default): the model the subagent started on; kind "request": its first model request as sent.
    const event = input.kind === 'request' ? 'request' : 'applied';
    writeLog({ ts: new Date().toISOString(), event, session_id: input.session_id, tool_use_id: input.tool_use_id,
      agent_id: input.agentId ?? null, model: input.model ?? null, effort: input.effort ?? null,
      ...(input.wanted ? { wanted: input.wanted } : {}), ...(input.error ? { error: input.error } : {}) });
    process.stdout.write('{}');
  } else {
    process.stdout.write('{}');
  }
} catch {
  process.stdout.write('{}');
}
