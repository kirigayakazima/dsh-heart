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
import { findActiveAgent } from '../lib/target.js'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'heart-trigger-test-'))

test('shouldTriggerReturned 边界条件判定', () => {
  const day = new Date('2026-10-21T19:20:00')

  // 1. 禁用 triggerOnReturn
  assert.equal(
    shouldTriggerReturned({
      prev: { presence: 'away' },
      next: { presence: 'present', sinceMsgMin: 40 },
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
      next: { presence: 'present', sinceMsgMin: 40 },
      triggerState: {},
      config: {},
      now: day,
    }).reason,
    'startup'
  )

  // 3. 当前不是 present
  assert.equal(
    shouldTriggerReturned({
      prev: { presence: 'away' },
      next: { presence: 'away', sinceMsgMin: 40 },
      triggerState: {},
      config: {},
      now: day,
    }).reason,
    'not-present'
  )

  // 4. 前一状态不是 away 或 asleep（例如 present -> present）
  assert.equal(
    shouldTriggerReturned({
      prev: { presence: 'present' },
      next: { presence: 'present', sinceMsgMin: 40 },
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
      prev: { presence: 'away' },
      next: { presence: 'present', sinceMsgMin: 40 },
      triggerState: {},
      config: {},
      speakState: { quietFrom: '23:00', quietTo: '08:00' },
      now: night,
    }).reason,
    'quiet-hours'
  )

  // 6. 离开时长不足 awayMinutes
  assert.equal(
    shouldTriggerReturned({
      prev: { presence: 'away' },
      next: { presence: 'present', sinceMsgMin: 15 },
      triggerState: {},
      config: { awayMinutes: 30 },
      now: day,
    }).reason,
    'duration-too-short'
  )

  // 7. 冷却期内（上次触发距今不足 cooldown）
  const recentlyTriggered = new Date(day.getTime() - 60 * 60 * 1000).toISOString() // 1小时前
  assert.equal(
    shouldTriggerReturned({
      prev: { presence: 'away' },
      next: { presence: 'present', sinceMsgMin: 45 },
      triggerState: { lastTriggerAt: recentlyTriggered, cooldownMinutes: 360 },
      config: { awayMinutes: 30, triggerCooldownMinutes: 360 },
      now: day,
    }).reason,
    'cooldown'
  )

  // 8. 满足所有条件：away -> present
  const result1 = shouldTriggerReturned({
    prev: { presence: 'away' },
    next: { presence: 'present', sinceMsgMin: 47 },
    triggerState: { lastTriggerAt: null },
    config: { awayMinutes: 30, triggerCooldownMinutes: 360 },
    now: day,
  })
  assert.equal(result1.ok, true)
  assert.equal(result1.awayDuration, 47)

  // 9. 满足所有条件：asleep -> present（早晨醒来）
  const morning = new Date('2026-10-22T08:30:00')
  const result2 = shouldTriggerReturned({
    prev: { presence: 'asleep' },
    next: { presence: 'present', sinceMsgMin: 500 },
    triggerState: { lastTriggerAt: null },
    config: { awayMinutes: 30, triggerCooldownMinutes: 360 },
    speakState: { quietFrom: '23:00', quietTo: '08:00' },
    now: morning,
  })
  assert.equal(result2.ok, true)
  assert.equal(result2.awayDuration, 500)
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
  fs.utimesSync(fileA, (now - 60000) / 1000, (now - 60000) / 1000)
  assert.equal(findActiveAgent(agents, sessionsRoot), null)

  // 找不到匹配文件：返回 null，绝不退回 list[0]
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

  const prev = { presence: 'away', at: new Date(Date.now() - 40 * 60 * 1000).toISOString() }
  const next = { presence: 'present', sinceMsgMin: 40 }
  const config = {
    sessionsRoot,
    awayMinutes: 30,
    triggerCooldownMinutes: 360,
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
