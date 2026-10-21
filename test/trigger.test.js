import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  shouldTriggerReturned,
  formatReturnedPrompt,
  createSelfMessage,
  maybeTrigger,
  readTrigger,
  writeTrigger,
} from '../lib/trigger.js'
import { findActiveAgent, clearSessionMtimesCache } from '../lib/target.js'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'heart-trigger-test-'))

test('shouldTriggerReturned 边界条件判定', () => {
  const day = new Date('2026-10-21T19:20:00')
  const recentAt = new Date(day.getTime() - 60 * 1000).toISOString() // 1分钟前

  // 1. 禁用 triggerOnReturn
  assert.equal(
    shouldTriggerReturned({
      prev: { presence: 'away', at: recentAt },
      next: { presence: 'present' },
      triggerState: {},
      config: { triggerOnReturn: false },
      now: day,
    }).reason,
    'disabled'
  )

  // 2. 首次启动（prev 为空）
  assert.equal(
    shouldTriggerReturned({
      prev: null,
      next: { presence: 'present' },
      triggerState: {},
      config: {},
      now: day,
    }).reason,
    'startup'
  )

  // 3. 当前不是 present
  assert.equal(
    shouldTriggerReturned({
      prev: { presence: 'away', at: recentAt },
      next: { presence: 'away' },
      triggerState: {},
      config: {},
      now: day,
    }).reason,
    'not-present'
  )

  // 4. 前一状态不是 away 或 asleep（例如 present -> present）
  assert.equal(
    shouldTriggerReturned({
      prev: { presence: 'present', at: recentAt },
      next: { presence: 'present' },
      triggerState: {},
      config: {},
      now: day,
    }).reason,
    'not-from-away'
  )

  // 5. 安静时段（23:00 - 08:00）
  const night = new Date('2026-10-21T23:30:00')
  assert.equal(
    shouldTriggerReturned({
      prev: { presence: 'away', at: new Date(night.getTime() - 60000).toISOString(), awaySince: new Date(night.getTime() - 40 * 60000).toISOString() },
      next: { presence: 'present' },
      triggerState: {},
      config: {},
      speakState: { quietFrom: '23:00', quietTo: '08:00' },
      now: night,
    }).reason,
    'quiet-hours'
  )

  // 6. 离开时长不足 awayMinutes
  const awaySince15 = new Date(day.getTime() - 15 * 60 * 1000).toISOString()
  assert.equal(
    shouldTriggerReturned({
      prev: { presence: 'away', at: recentAt, awaySince: awaySince15 },
      next: { presence: 'present' },
      triggerState: {},
      config: { awayMinutes: 30 },
      now: day,
    }).reason,
    'duration-too-short'
  )

  // 7. 冷却期内（上次触发距今不足 cooldown）
  const recentlyTriggered = new Date(day.getTime() - 60 * 60 * 1000).toISOString() // 1小时前
  const awaySince45 = new Date(day.getTime() - 45 * 60 * 1000).toISOString()
  assert.equal(
    shouldTriggerReturned({
      prev: { presence: 'away', at: recentAt, awaySince: awaySince45 },
      next: { presence: 'present' },
      triggerState: { lastTriggerAt: recentlyTriggered, cooldownMinutes: 360 },
      config: { awayMinutes: 30, triggerCooldownMinutes: 360 },
      now: day,
    }).reason,
    'cooldown'
  )

  // 8. 满足所有条件：away -> present
  const awaySince47 = new Date(day.getTime() - 47 * 60 * 1000).toISOString()
  const result1 = shouldTriggerReturned({
    prev: { presence: 'away', at: recentAt, awaySince: awaySince47 },
    next: { presence: 'present' },
    triggerState: { lastTriggerAt: null },
    config: { awayMinutes: 30, triggerCooldownMinutes: 360 },
    now: day,
  })
  assert.equal(result1.ok, true)
  assert.equal(result1.awayDuration, 47)

  // 9. 满足所有条件：asleep -> present（早晨醒来）
  const morning = new Date('2026-10-22T08:30:00')
  const morningRecentAt = new Date(morning.getTime() - 60 * 1000).toISOString()
  const awaySince500 = new Date(morning.getTime() - 500 * 60 * 1000).toISOString()
  const result2 = shouldTriggerReturned({
    prev: { presence: 'asleep', at: morningRecentAt, awaySince: awaySince500 },
    next: { presence: 'present' },
    triggerState: { lastTriggerAt: null },
    config: { awayMinutes: 30, triggerCooldownMinutes: 360 },
    speakState: { quietFrom: '23:00', quietTo: '08:00' },
    now: morning,
  })
  assert.equal(result2.ok, true)
  assert.equal(result2.awayDuration, 500)
})

test('shouldTriggerReturned 真实场景用例（awaySince 精度与重启防误判）', () => {
  const now = new Date('2026-10-21T19:50:00+08:00')

  // A. 离开 2 小时，回来先打字（sinceMsgMin=0）→ 仍触发，时长 120
  const twoHoursAgo = new Date(now.getTime() - 120 * 60 * 1000).toISOString()
  const resA = shouldTriggerReturned({
    prev: { presence: 'away', at: '2026-10-21T19:49:00+08:00', awaySince: twoHoursAgo },
    next: { presence: 'present', sinceMsgMin: 0 },
    triggerState: {},
    config: { awayMinutes: 30, pulseSeconds: 60 },
    now,
  })
  assert.equal(resA.ok, true)
  assert.equal(resA.awayDuration, 120)

  // B. 在电脑前沉默 2 小时、真离开 5 分钟，回来（sinceMsgMin=125）→ 不触发，时长 5
  const fiveMinAgo = new Date(now.getTime() - 5 * 60 * 1000).toISOString()
  const resB = shouldTriggerReturned({
    prev: { presence: 'away', at: '2026-10-21T19:49:00+08:00', awaySince: fiveMinAgo },
    next: { presence: 'present', sinceMsgMin: 125 },
    triggerState: {},
    config: { awayMinutes: 30, pulseSeconds: 60 },
    now,
  })
  assert.equal(resB.ok, false)
  assert.equal(resB.reason, 'duration-too-short')
  assert.equal(resB.awayDuration, 5)

  // C. 重启后可能拿两天前的 sense.json → prev.at 超时，视为 startup，不误触发
  const resC = shouldTriggerReturned({
    prev: { presence: 'away', at: '2026-10-19T10:00:00+08:00', awaySince: '2026-10-19T10:00:00+08:00' },
    next: { presence: 'present', sinceMsgMin: 0 },
    triggerState: {},
    config: { awayMinutes: 30, pulseSeconds: 60 },
    now,
  })
  assert.equal(resC.ok, false)
  assert.equal(resC.reason, 'startup')

  // D. 显式启动标识 isStartup 为 true → 不触发
  const resD = shouldTriggerReturned({
    prev: { presence: 'away', at: '2026-10-21T19:49:00+08:00', awaySince: twoHoursAgo },
    next: { presence: 'present' },
    triggerState: {},
    config: { awayMinutes: 30 },
    now,
    isStartup: true,
  })
  assert.equal(resD.ok, false)
  assert.equal(resD.reason, 'startup')
})

test('formatReturnedPrompt 生成规范消息模板', () => {
  const at = new Date('2026-10-21T19:20:00')
  const prompt = formatReturnedPrompt(47, at)
  assert.equal(prompt, '【感知】他离开了 47 分钟，刚回来（现在 19:20）。手上有没做完的事就接着说；没有就别硬找话。')
})

test('createSelfMessage 组装合法的 UserMessage 对象', () => {
  const msg = createSelfMessage('test-prompt')
  assert.ok(msg.id)
  assert.equal(msg.role, 'user')
  assert.deepEqual(msg.content, [{ type: 'text', text: 'test-prompt' }])
  assert.deepEqual(msg.source, { kind: 'schedule' })
})

test('findActiveAgent：根据 session 文件 mtime 找最新窗口', () => {
  const sessionsRoot = tmp()
  const now = Date.now()

  // 模拟目录结构：
  // sessionsRoot/ws1/session-aaa/session.v4.jsonl.zstd (旧)
  // sessionsRoot/ws1/session-bbb/session.v4.jsonl.zstd (新)
  const dirA = path.join(sessionsRoot, 'ws1', 'session-aaa')
  const dirB = path.join(sessionsRoot, 'ws1', 'session-bbb')
  fs.mkdirSync(dirA, { recursive: true })
  fs.mkdirSync(dirB, { recursive: true })

  const fileA = path.join(dirA, 'session.v4.jsonl.zstd')
  const fileB = path.join(dirB, 'session.v4.jsonl.zstd')
  fs.writeFileSync(fileA, 'data-a')
  fs.writeFileSync(fileB, 'data-b')

  // 修改 mtime：A 为 10 分钟前，B 为 1 分钟前
  fs.utimesSync(fileA, (now - 600000) / 1000, (now - 600000) / 1000)
  fs.utimesSync(fileB, (now - 60000) / 1000, (now - 60000) / 1000)

  const agentA = { id: 'session-aaa', followup: () => {} }
  const agentB = { id: 'bbb', followup: () => {} } // 测试无 session- 前缀

  const agents = {
    list: () => [agentA, agentB],
  }

  // 命中最新 agentB
  const found = findActiveAgent(agents, sessionsRoot)
  assert.equal(found, agentB)

  // 并列情况（Tie）：mtime 相同，返回 null，绝不退回 list[0]
  clearSessionMtimesCache()
  fs.utimesSync(fileA, (now - 60000) / 1000, (now - 60000) / 1000)
  assert.equal(findActiveAgent(agents, sessionsRoot), null)

  // 找不到匹配文件：返回 null，绝不退回 list[0]
  clearSessionMtimesCache()
  const agentC = { id: 'session-ccc', followup: () => {} }
  assert.equal(findActiveAgent({ list: () => [agentC] }, sessionsRoot), null)
  assert.equal(findActiveAgent({ list: () => [] }, sessionsRoot), null)
  assert.equal(findActiveAgent(null, sessionsRoot), null)
})

test('maybeTrigger 触发开口、记录状态并防止重复触发', async () => {
  const root = tmp()
  const sessionsRoot = path.join(root, 'sessions')
  const dirA = path.join(sessionsRoot, 'ws', 'session-active')
  fs.mkdirSync(dirA, { recursive: true })
  const fileA = path.join(dirA, 'session.v4.jsonl.zstd')
  fs.writeFileSync(fileA, 'active-session')

  let followedUp = null
  const agent = {
    id: 'session-active',
    followup: (msg) => {
      followedUp = msg
    },
  }
  const ctx = {
    agents: {
      list: () => [agent],
    },
  }

  const nowMs = Date.now()
  const prev = {
    presence: 'away',
    at: new Date(nowMs - 50 * 1000).toISOString(),
    awaySince: new Date(nowMs - 40 * 60 * 1000).toISOString(),
  }
  const next = { presence: 'present', sinceMsgMin: 40 }
  const config = {
    sessionsRoot,
    awayMinutes: 30,
    triggerCooldownMinutes: 360,
    pulseSeconds: 60,
  }

  const ok = await maybeTrigger(ctx, root, prev, next, config)
  assert.equal(ok, true)
  assert.ok(followedUp)
  assert.equal(followedUp.role, 'user')
  assert.ok(followedUp.content[0].text.includes('【感知】他离开了 40 分钟'))

  // trigger.json 已记录
  const triggerState = readTrigger(root)
  assert.equal(triggerState.lastEvent, 'returned')
  assert.ok(triggerState.lastTriggerAt)

  // 冷却内再次调用 -> 不触发
  const okAgain = await maybeTrigger(ctx, root, prev, next, config)
  assert.equal(okAgain, false)
})
