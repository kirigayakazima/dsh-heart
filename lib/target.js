// 会话路由：把一句待发的话送回它被说出来的那个窗口。
//
// 这里放两件容易出错、又必须单独测的事：
//   1. 会话 id 有两种写法：日志/目录里是 `session-<uuid>`，人和 URL 常只写 `<uuid>`；
//   2. 「指定了窗口但找不到」绝不能退回 `agents.list()[0]`——那往往是最老的窗口，
//      话会跑进用户没在看的会话里（0.8.2 及以前就是这样投错的）。

/** 一个 id 的所有合法写法，先原样再补/去前缀。 */
export function sessionIdCandidates(id) {
  const raw = String(id ?? '').trim()
  if (!raw) return []
  const bare = raw.startsWith('session-') ? raw.slice('session-'.length) : raw
  return raw.startsWith('session-') ? [raw, bare] : [raw, `session-${bare}`]
}

/** 按任意一种写法找 agent；找不到返回 null，不抛错。 */
export function resolveAgent(agents, id) {
  if (!agents || typeof agents.get !== 'function') return null
  for (const candidate of sessionIdCandidates(id)) {
    try {
      const found = agents.get(candidate)
      if (found) return found
    } catch {
      // 非法 id 只跳过：宁可这一轮不说，也不能把话投进错的窗口
    }
  }
  return null
}

/**
 * 选一个 agent 来开口。
 * @param agents - `ctx.agents`
 * @param target - 明确指定的会话；给了就必须找到，找不到返回 null（让话继续排队）
 */
export function pickAgent(agents, target) {
  if (!agents) return null
  if (target) return resolveAgent(agents, target)
  const list = typeof agents.list === 'function' ? agents.list() : []
  return list.find((agent) => agent && agent.status === 'running') || list[0] || null
}
