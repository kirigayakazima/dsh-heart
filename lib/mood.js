// dsh-heart 的 Mood（情绪感知层）状态机与持久化。
//
// 核心原则（Step 2 规范）：
// 1. Mood 负责让表达具有轻微、自然、随时间变化的状态感；
// 2. 不增加专门的 LLM 请求，不启动后台定时器，不进行主动唤醒或任务调度；
// 3. 采用惰性指数衰减（计算时评估，无定时写盘）；
// 4. 严格校验状态与原因的映射约束，无证据时不写盘；
// 5. tired 仅代表表达风格舒缓简洁，严禁以此作为拒绝任务或推诿的理由。

import fs from 'node:fs'
import path from 'node:path'
import {
  ensureLayout,
  resolveRoot,
  acquireDirLock,
  releaseDirLock,
  isDirLockHeld,
  safeAtomicReplace,
} from './store.js'

export const MOOD_FILE = 'mood.json'
export const MOOD_SCHEMA_VERSION = 1

export const MOOD_STATES = Object.freeze(['calm', 'engaged', 'cheerful', 'excited', 'tired'])
export const MOOD_REASONS = Object.freeze([
  'baseline',
  'task_completed',
  'positive_interaction',
  'focus',
  'deep_work',
])

export const DEFAULT_HALF_LIFE_MS = 2 * 60 * 60 * 1000 // 2小时半衰期
export const LOW_INTENSITY_THRESHOLD = 0.15           // 低于此阈值有效状态回归 calm

/**
 * 状态与原因映射矩阵 (State-Reason Matrix)：
 * 严格限制原因能够触发的状态及强度范围，杜绝无事实依据的越权状态跳转。
 */
export const STATE_REASON_MATRIX = Object.freeze({
  baseline: Object.freeze({
    allowedStates: Object.freeze(['calm']),
    minIntensity: 0.0,
    maxIntensity: 0.0,
  }),
  task_completed: Object.freeze({
    allowedStates: Object.freeze(['engaged', 'cheerful', 'excited']),
    minIntensity: 0.3,
    maxIntensity: 1.0,
    stateConstraints: Object.freeze({
      excited: Object.freeze({ minIntensity: 0.7 }),
    }),
  }),
  positive_interaction: Object.freeze({
    allowedStates: Object.freeze(['cheerful', 'excited']),
    minIntensity: 0.3,
    maxIntensity: 0.9,
    stateConstraints: Object.freeze({
      excited: Object.freeze({ minIntensity: 0.7 }),
    }),
  }),
  focus: Object.freeze({
    allowedStates: Object.freeze(['engaged']),
    minIntensity: 0.4,
    maxIntensity: 0.9,
  }),
  deep_work: Object.freeze({
    allowedStates: Object.freeze(['tired']),
    minIntensity: 0.2,
    maxIntensity: 0.6,
  }),
})

/**
 * 预定义提示词文案（严格限制输出内容，避免模型自由发挥或泄漏内部字段）
 */
export const MOOD_PROMPT_DESCRIPTIONS = Object.freeze({
  engaged: Object.freeze({
    label: '投入、专注',
    advice: '清晰、积极推进，保持专注节奏。',
  }),
  cheerful: Object.freeze({
    label: '轻快、愉悦',
    advice: '可以适度活泼、亲切，但保持自然。',
  }),
  excited: Object.freeze({
    label: '兴奋、活跃',
    advice: '更有活力与热情，但避免过度夸张。',
  }),
  tired: Object.freeze({
    label: '低活跃、舒缓',
    advice: '简洁、柔和，不刻意拖沓，不作为拒绝任务的理由。',
  }),
})

/**
 * 默认基准状态工厂函数。
 */
export function createDefaultMood(now = new Date()) {
  const dateStr = now instanceof Date && !isNaN(now.getTime()) ? now.toISOString() : new Date().toISOString()
  return {
    schemaVersion: MOOD_SCHEMA_VERSION,
    state: 'calm',
    intensity: 0.0,
    updatedAt: dateStr,
    reason: 'baseline',
  }
}

/**
 * 指数衰减纯函数：
 * I(t) = I_0 * 2^(-t / H)
 * 具备时间倒退防御：若 elapsedMs < 0，视为 0，绝不放大强度。
 */
export function calculateDecayedIntensity(initialIntensity, elapsedMs, halfLifeMs = DEFAULT_HALF_LIFE_MS) {
  if (typeof initialIntensity !== 'number' || isNaN(initialIntensity) || initialIntensity <= 0) {
    return 0.0
  }
  if (typeof elapsedMs !== 'number' || isNaN(elapsedMs) || elapsedMs <= 0) {
    return Math.min(1.0, Math.max(0.0, initialIntensity))
  }
  const h = typeof halfLifeMs === 'number' && halfLifeMs > 0 ? halfLifeMs : DEFAULT_HALF_LIFE_MS
  const decayed = initialIntensity * Math.pow(2, -elapsedMs / h)
  return Math.min(1.0, Math.max(0.0, decayed))
}

/**
 * 校验持久化（或待计算有效状态）的 Mood 记录结构与字段合法性（Pure Function）。
 *
 * 严格规则：
 * 1. 必须为非空普通对象且非数组；
 * 2. schemaVersion 必须严格等于 MOOD_SCHEMA_VERSION (1)；
 * 3. state 必须为合法的离散状态 (MOOD_STATES)；
 * 4. intensity 必须为 [0.0, 1.0] 闭区间内的有限数值；
 * 5. reason 必须为合法的触发原因 (MOOD_REASONS)；
 * 6. updatedAt 必须为非空字符串，且能被 Date.parse() 成功解析为有效时间戳。
 */
export function isValidPersistedMood(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return false
  }
  const { schemaVersion, state, intensity, reason, updatedAt } = record
  if (schemaVersion !== MOOD_SCHEMA_VERSION) {
    return false
  }
  if (typeof state !== 'string' || !MOOD_STATES.includes(state)) {
    return false
  }
  if (typeof intensity !== 'number' || !isFinite(intensity) || intensity < 0.0 || intensity > 1.0) {
    return false
  }
  if (typeof reason !== 'string' || !MOOD_REASONS.includes(reason)) {
    return false
  }
  if (typeof updatedAt !== 'string' || !updatedAt.trim() || isNaN(Date.parse(updatedAt))) {
    return false
  }
  return true
}

/**
 * 计算给定时间点的有效状态（Pure Function）：
 * 1. 验证对象结构与字段合法性；
 * 2. calm 状态强度规范化为 0.0；
 * 3. 惰性计算时间衰减；
 * 4. 强度低于阈值时有效状态回归 calm。
 */
export function getEffectiveMood(
  persistedMood,
  now = new Date(),
  { halfLifeMs = DEFAULT_HALF_LIFE_MS, lowThreshold = LOW_INTENSITY_THRESHOLD } = {}
) {
  if (!isValidPersistedMood(persistedMood)) {
    return createDefaultMood(now)
  }
  const { state, intensity, updatedAt, reason } = persistedMood

  // calm 状态规范化为 intensity = 0
  if (state === 'calm') {
    return {
      schemaVersion: MOOD_SCHEMA_VERSION,
      state: 'calm',
      intensity: 0.0,
      updatedAt,
      reason,
    }
  }

  const updatedTime = Date.parse(updatedAt)
  const currentTime = (now instanceof Date ? now : new Date(now)).getTime()
  // 时钟倒退防御：若时间倒退，经过时间按 0 处理，绝不放大强度
  const elapsedMs = isNaN(currentTime) ? 0 : Math.max(0, currentTime - updatedTime)
  const currentI = calculateDecayedIntensity(intensity, elapsedMs, halfLifeMs)

  const roundedI = Math.round(currentI * 100) / 100

  // 强度降到低影响阈值以下，有效状态回归 calm
  if (roundedI <= lowThreshold) {
    return {
      schemaVersion: MOOD_SCHEMA_VERSION,
      state: 'calm',
      intensity: 0.0,
      updatedAt,
      reason,
    }
  }

  return {
    schemaVersion: MOOD_SCHEMA_VERSION,
    state,
    intensity: roundedI,
    updatedAt,
    reason,
  }
}

/**
 * 校验候选更新的基础数据格式。
 */
export function validateMoodCandidate(candidate) {
  if (!candidate || typeof candidate !== 'object') {
    return { ok: false, reason: 'invalid-input', message: '候选状态必须是非空对象' }
  }
  const { state, intensity, reason } = candidate
  if (typeof state !== 'string' || !MOOD_STATES.includes(state)) {
    return {
      ok: false,
      reason: 'invalid-state',
      message: `非法情绪状态: ${state}，必须是 ${MOOD_STATES.join(', ')} 之一`,
    }
  }
  if (typeof intensity !== 'number' || isNaN(intensity) || !isFinite(intensity) || intensity < 0.0 || intensity > 1.0) {
    return { ok: false, reason: 'invalid-intensity', message: '强度必须是 0.0 到 1.0 之间的有限数值' }
  }
  if (typeof reason !== 'string' || !MOOD_REASONS.includes(reason)) {
    return {
      ok: false,
      reason: 'invalid-reason',
      message: `非法触发原因: ${reason}，必须是 ${MOOD_REASONS.join(', ')} 之一`,
    }
  }
  return { ok: true }
}

/**
 * 状态转移规则判定：
 * 结合当前有效状态，验证原因与状态映射矩阵，以及微小变化抑制。
 */
export function shouldUpdateMood(currentEffectiveMood, candidate) {
  const valid = validateMoodCandidate(candidate)
  if (!valid.ok) return valid

  const { state, intensity, reason } = candidate
  const rule = STATE_REASON_MATRIX[reason]
  if (!rule) {
    return { ok: false, reason: 'unknown-reason-rule', message: `未定义原因规则: ${reason}` }
  }

  // 1. 检查 state 是否在该 reason 的允许目标集合内
  if (!rule.allowedStates.includes(state)) {
    return {
      ok: false,
      reason: 'state-reason-mismatch',
      message: `原因 "${reason}" 不能触发状态 "${state}"（允许目标: ${rule.allowedStates.join(', ')}）`,
    }
  }

  // 2. 检查 intensity 是否在该 reason 的允许区间内
  if (intensity < rule.minIntensity || intensity > rule.maxIntensity) {
    return {
      ok: false,
      reason: 'intensity-out-of-range',
      message: `状态 "${state}" 在原因 "${reason}" 下强度必须在 ${rule.minIntensity} ~ ${rule.maxIntensity} 之间（当前 ${intensity}）`,
    }
  }

  // 3. 检查特定状态的细分约束（例如 excited 要求 intensity >= 0.7）
  if (rule.stateConstraints && rule.stateConstraints[state]) {
    const sub = rule.stateConstraints[state]
    if (typeof sub.minIntensity === 'number' && intensity < sub.minIntensity) {
      return {
        ok: false,
        reason: 'intensity-too-low-for-state',
        message: `状态 "${state}" 在原因 "${reason}" 下要求强度至少为 ${sub.minIntensity}（当前 ${intensity}）`,
      }
    }
  }

  // 4. 规范化 calm 状态强度为 0.0
  const normalizedIntensity = state === 'calm' ? 0.0 : Math.round(intensity * 100) / 100

  // 5. 微小变化判定：与当前【有效状态】对比
  // 若状态相同、原因相同，且有效强度变化 < 0.05，判定为无显著新事件，不写盘
  if (
    currentEffectiveMood &&
    currentEffectiveMood.state === state &&
    currentEffectiveMood.reason === reason &&
    Math.abs((currentEffectiveMood.intensity || 0) - normalizedIntensity) < 0.05
  ) {
    return {
      ok: false,
      reason: 'no-significant-change',
      message: '与当前有效状态相比无显著新事件变化，保持自然衰减即可',
    }
  }

  return { ok: true, normalizedState: state, normalizedIntensity, reason }
}

/**
 * 只读获取当前有效状态（内存实时计算衰减，不写盘）。
 * 文件缺失或损坏时安全回退至默认 calm，绝不覆写损坏文件。
 */
export function readMood(root, now = new Date()) {
  const dir = resolveRoot(root)
  const file = path.join(dir, 'body', MOOD_FILE)
  try {
    if (!fs.existsSync(file)) {
      return createDefaultMood(now)
    }
    const raw = fs.readFileSync(file, 'utf8')
    const parsed = JSON.parse(raw)
    if (!isValidPersistedMood(parsed)) {
      // 损坏或非法数据：只读内存安全回退，绝不覆盖破坏磁盘现有现场
      return createDefaultMood(now)
    }
    return getEffectiveMood(parsed, now)
  } catch {
    // I/O 或语法解析异常：只读安全回退
    return createDefaultMood(now)
  }
}

/**
 * 读取磁盘持久化保存的原始对象（无衰减计算）。供诊断与白盒测试使用。
 */
export function readPersistedMood(root) {
  const dir = resolveRoot(root)
  const file = path.join(dir, 'body', MOOD_FILE)
  try {
    if (!fs.existsSync(file)) return null
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/**
 * 校验并持久化更新情绪状态。
 *
 * 契约规范：
 * - 业务拒绝：返回 { ok: false, reason, message }
 * - 锁超时：返回 { ok: false, reason: 'lock-timeout', message }
 * - 存储故障：清理临时文件后抛出异常（由调用层捕获并提供可诊断反馈）
 */
export function updateMood(root, candidate, now = new Date()) {
  const dir = ensureLayout(root)
  const bodyDir = path.join(dir, 'body')
  const file = path.join(bodyDir, MOOD_FILE)
  const lockDir = path.join(bodyDir, `${MOOD_FILE}.lock`)

  // 1. 获取当前有效状态，做前置状态转移判定
  const currentEffective = readMood(root, now)
  const decision = shouldUpdateMood(currentEffective, candidate)
  if (!decision.ok) {
    return decision
  }

  // 2. 获取跨进程互斥锁
  const lockToken = acquireDirLock(lockDir)
  if (!lockToken) {
    return { ok: false, reason: 'lock-timeout', message: '获取文件锁超时，可能有其他并发写入操作' }
  }

  let tmpFile = null
  try {
    // 3. 锁内重新读取并校验，防并发时序竞争
    const freshEffective = readMood(root, now)
    const freshDecision = shouldUpdateMood(freshEffective, candidate)
    if (!freshDecision.ok) {
      return freshDecision
    }

    // 4. 构造落盘持久化数据
    const record = {
      schemaVersion: MOOD_SCHEMA_VERSION,
      state: freshDecision.normalizedState,
      intensity: freshDecision.normalizedIntensity,
      updatedAt: (now instanceof Date ? now : new Date(now)).toISOString(),
      reason: freshDecision.reason,
    }

    // 5. 写入唯一临时文件
    const rand = Math.random().toString(36).slice(2, 8)
    tmpFile = path.join(bodyDir, `${MOOD_FILE}.tmp.${process.pid}.${Date.now()}.${rand}`)
    fs.writeFileSync(tmpFile, JSON.stringify(record, null, 2) + '\n', 'utf8')

    // 6. Fencing Check 校验锁依然持有
    if (!isDirLockHeld(lockDir, lockToken)) {
      throw new Error('写盘前锁凭据校验失败：锁已被其他操作接管或失效')
    }

    // 7. 安全原子替换
    safeAtomicReplace(tmpFile, file)
    return { ok: true, mood: record }
  } catch (err) {
    if (tmpFile && fs.existsSync(tmpFile)) {
      try { fs.unlinkSync(tmpFile) } catch {}
    }
    throw err
  } finally {
    releaseDirLock(lockDir, lockToken)
  }
}

/**
 * 重置情绪状态至默认 baseline。
 * 同样采用互斥锁与原子替换，杜绝并发竞争。
 */
export function resetMood(root, now = new Date()) {
  const dir = ensureLayout(root)
  const bodyDir = path.join(dir, 'body')
  const file = path.join(bodyDir, MOOD_FILE)
  const lockDir = path.join(bodyDir, `${MOOD_FILE}.lock`)

  const lockToken = acquireDirLock(lockDir)
  if (!lockToken) {
    return { ok: false, reason: 'lock-timeout', message: '获取文件锁超时' }
  }

  let tmpFile = null
  try {
    const record = createDefaultMood(now)
    const rand = Math.random().toString(36).slice(2, 8)
    tmpFile = path.join(bodyDir, `${MOOD_FILE}.tmp.${process.pid}.${Date.now()}.${rand}`)
    fs.writeFileSync(tmpFile, JSON.stringify(record, null, 2) + '\n', 'utf8')

    if (!isDirLockHeld(lockDir, lockToken)) {
      throw new Error('写盘前锁凭据校验失败：锁已被其他操作接管或失效')
    }

    safeAtomicReplace(tmpFile, file)
    return { ok: true, mood: record }
  } catch (err) {
    if (tmpFile && fs.existsSync(tmpFile)) {
      try { fs.unlinkSync(tmpFile) } catch {}
    }
    throw err
  } finally {
    releaseDirLock(lockDir, lockToken)
  }
}

/**
 * 格式化提示词小节文本。
 * 低侵入原则：有效状态为 calm 或强度 <= 0.15 时返回空串，不注入提示词。
 */
export function formatMoodPrompt(effectiveMood) {
  if (!effectiveMood || typeof effectiveMood !== 'object') return ''
  const { state, intensity } = effectiveMood
  if (state === 'calm' || typeof intensity !== 'number' || intensity <= LOW_INTENSITY_THRESHOLD) {
    return ''
  }
  const desc = MOOD_PROMPT_DESCRIPTIONS[state]
  if (!desc) return ''
  return [
    '### 当前表达状态',
    `当前倾向：${desc.label}。`,
    `表达建议：${desc.advice}`,
    '该状态是短期表达参考，不是固定人格规则。',
  ].join('\n')
}
