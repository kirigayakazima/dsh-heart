// 触发层：纯逻辑（事件判定、冷却、安静时段、目标会话选择与开口触发）。
// 零 DSH 依赖。
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { ensureLayout, inQuietHours, readSpeak, resolveRoot } from './store.js'
import { findActiveAgent } from './target.js'

export const TRIGGER_DEFAULT = {
  lastTriggerAt: null,
  lastEvent: null,
  cooldownMinutes: 360,
}

const pad = (n) => String(n).padStart(2, '0')

function trace(root, msg) {
  try {
    fs.appendFileSync(path.join(resolveRoot(root), 'plugin-trace.log'), new Date().toISOString() + ' ' + msg + '\n')
  } catch {}
}

export function readTrigger(root) {
  const file = path.join(resolveRoot(root), 'trigger.json')
  try {
    return { ...TRIGGER_DEFAULT, ...JSON.parse(fs.readFileSync(file, 'utf8')) }
  } catch {
    return { ...TRIGGER_DEFAULT }
  }
}

export function writeTrigger(root, patch) {
  const dir = ensureLayout(root)
  const current = readTrigger(dir)
  const next = { ...current, ...patch }
  fs.writeFileSync(path.join(dir, 'trigger.json'), JSON.stringify(next, null, 2) + '\n', 'utf8')
  return next
}

/**
 * 判定 returned 事件：
 * 条件：
 *   1. previous 是 away 或 asleep；
 *   2. current 是 present；
 *   3. 离开时长 >= awayMinutes（默认 30）；
 *   4. 不在安静时段；
 *   5. 距上次触发 >= triggerCooldownMinutes（默认 360）。
 */
export function shouldTriggerReturned({ prev, next, triggerState, config = {}, speakState = {}, now = new Date() }) {
  if (config.triggerOnReturn === false) {
    return { ok: false, reason: 'disabled' }
  }

  // 进程刚启动时 previous 未知，不触发
  if (!prev || !prev.presence) {
    return { ok: false, reason: 'startup' }
  }

  if (next?.presence !== 'present') {
    return { ok: false, reason: 'not-present' }
  }

  if (prev.presence !== 'away' && prev.presence !== 'asleep') {
    return { ok: false, reason: 'not-from-away' }
  }

  const quietFrom = speakState.quietFrom || '23:00'
  const quietTo = speakState.quietTo || '08:00'
  if (inQuietHours(now, quietFrom, quietTo)) {
    return { ok: false, reason: 'quiet-hours' }
  }

  const awayMinutes = Number(config.awayMinutes) || 30
  let awayDuration = awayMinutes
  if (next.sinceMsgMin !== null && next.sinceMsgMin !== undefined && next.sinceMsgMin > 0) {
    awayDuration = next.sinceMsgMin
  } else if (prev.at) {
    awayDuration = Math.max(0, Math.floor((now.getTime() - new Date(prev.at).getTime()) / 60000))
  }

  if (awayDuration < awayMinutes) {
    return { ok: false, reason: 'duration-too-short', awayDuration }
  }

  const cooldown = Number(config.triggerCooldownMinutes) || triggerState.cooldownMinutes || 360
  if (triggerState.lastTriggerAt) {
    const elapsedMinutes = (now.getTime() - new Date(triggerState.lastTriggerAt).getTime()) / 60000
    if (elapsedMinutes < cooldown) {
      return { ok: false, reason: 'cooldown', diffMin: Math.floor(elapsedMinutes), cooldown }
    }
  }

  return { ok: true, awayDuration }
}

/**
 * 组装给模型的消息模板（供模型感知后自行决定开口内容）。
 */
export function formatReturnedPrompt(awayDuration, now = new Date()) {
  const timeStr = `${pad(now.getHours())}:${pad(now.getMinutes())}`
  return `【感知】他离开了 ${awayDuration} 分钟，刚回来（现在 ${timeStr}）。手上有没做完的事就接着说；没有就别硬找话。`
}

/**
 * 构造合法的 UserMessage 对象。
 * agent.followup 必须收完整对象，不能传裸字符串。
 */
export function createSelfMessage(text) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: String(text) }],
    source: { kind: 'schedule' },
  }
}

/**
 * 节律唤醒时的触发调度：
 * 只有条件满足时才开口；找不到目标会话或并列时不开口。
 */
export async function maybeTrigger(ctx, root, prev, next, config = {}, now = new Date()) {
  const dir = resolveRoot(root)
  const speakState = readSpeak(dir)
  const triggerState = readTrigger(dir)

  const decision = shouldTriggerReturned({
    prev,
    next,
    triggerState,
    config,
    speakState,
    now,
  })

  if (!decision.ok) {
    return false
  }

  const agent = findActiveAgent(ctx && ctx.agents, config.sessionsRoot)
  if (!agent || typeof agent.followup !== 'function') {
    trace(dir, 'trigger:skip no-agent')
    return false
  }

  const prompt = formatReturnedPrompt(decision.awayDuration, now)
  const message = createSelfMessage(prompt)

  try {
    agent.followup(message)
    writeTrigger(dir, {
      lastTriggerAt: now.toISOString(),
      lastEvent: 'returned',
      cooldownMinutes: Number(config.triggerCooldownMinutes) || 360,
    })
    trace(dir, 'trigger:returned to=' + agent.id + ' away=' + decision.awayDuration + 'm')
    return true
  } catch (error) {
    trace(dir, 'trigger:error ' + String((error && error.message) || error))
    return false
  }
}
