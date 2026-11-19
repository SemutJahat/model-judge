// model-judge's hooks module: applies the PreToolUse hook's decision without rewriting the tool call.
//
// Why: auto mode reviews a tool call as the model wrote it. A PreToolUse hook that rewrites the call's input
// (updatedInput) voids that review, and Claude Code refuses the call ("a hook changed this call's input after
// auto mode reviewed it") and has the model send it again. So scripts/route.mjs only judges, logs and shows its
// line, and leaves the decision (model, effort) keyed by tool_use_id; this module sets them where they belong:
//   agent.spawn  -> the subagent's model (a spawn rewrite, after the permission check; the call is unchanged)
//   turn.step    -> the effort of each model request of that subagent
import type { Register } from 'claude-code'

type Decision = { model?: string; effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' }

// agentId -> effort for that subagent's requests. Module memory: a reload forgets it (the model stays set).
const effortFor: Record<string, NonNullable<Decision['effort']>> = {}
const reported = new Set<string>()

async function helper($: any, cmd: 'take' | 'applied', payload: unknown): Promise<any> {
  try {
    const r = await $.process.run(['node', `${$.plugin.root}/scripts/spawn.mjs`, cmd], {
      stdin: JSON.stringify(payload),
      timeoutMs: 10000,
    })
    return r.exitCode === 0 ? JSON.parse(r.stdout || '{}') : {}
  } catch {
    return {}
  }
}

export const register: Register = on => {
  on('agent.spawn', async ($, e, next) => {
    // Forks inherit the parent's model; resumed agents keep theirs; a workflow's agents are not Agent tool calls.
    if (e.fork || e.resume || e.workflow || !e.tool_use_id) return next(e)
    const d: Decision = await helper($, 'take', { tool_use_id: e.tool_use_id })
    if (!d.model) return next(e)
    const r = await next({ ...e, model: d.model })
    if (r.agentId && d.effort) effortFor[r.agentId] = d.effort
    let sessionId: string | undefined
    try { sessionId = await $.session.id() } catch {}
    await helper($, 'applied', { tool_use_id: e.tool_use_id, agentId: r.agentId, model: r.model, effort: d.effort, session_id: sessionId,
      ...(r.deny !== undefined ? { error: r.deny } : {}) })
    return r
  // If anything above throws, start the subagent as asked: model-judge never blocks one.
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    const id = e.agentId
    const effort = id ? effortFor[id] : undefined
    const r = yield* next(effort ? { ...e, effort } : e)
    // Once per subagent: log what its first request really carried ($.agent.list's lastRequest is the request
    // as it went out, past caps, fallbacks and hooks), the evidence the decision was applied.
    if (id && effort && !reported.has(id)) {
      reported.add(id)
      try {
        const row = (await $.agent.list()).find(a => a.id === id)
        const sent = row?.lastRequest
        await helper($, 'applied', { kind: 'request', agentId: id, model: sent?.model ?? row?.model, effort: sent?.effort ?? null, wanted: effort })
      } catch {}
    }
    return r
  })
}
