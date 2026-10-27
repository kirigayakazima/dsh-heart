// dsh-heart 的 Dream（离线经验沉淀与成长层）MVP 实现。
//
// 核心原则（Step 3B MVP）：
// 1. 手动调用 heart_dream，零后台定时器，不增加自动触发；
// 2. 只读取当前会话内存切片，不读取历史会话压缩包；
// 3. 严格限制输入与输出长度（最多 3 条候选）；
// 4. 候选经验在 <root>/dream/insights.json 独立保存，绝不自动修改 facts/notebook/voice；
// 5. 采用完整 SHA-256 内容哈希作为 ID，相同内容去重不重复保存；
// 6. 锁内重新读取最新数据，整文件原子写回，损坏文件写保护绝不覆写。

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import {
  resolveRoot,
  acquireDirLock,
  releaseDirLock,
  isDirLockHeld,
  safeAtomicReplace,
} from './store.js'

export const DREAM_DIR = 'dream'
export const INSIGHTS_FILE = 'insights.json'
export const INSIGHTS_LOCK = 'insights.lock'

export const INSIGHT_CATEGORIES = Object.freeze([
  'communication',
  'workflow',
  'environment',
  'general',
])

export const INSIGHT_TYPES = Object.freeze([
  'fact',
  'observation',
  'inference',
  'hypothesis',
])

export const INSIGHT_STATUSES = Object.freeze([
  'candidate',
  'confirmed',
  'rejected',
])

/**
 * 规范化经验正文：去除多余空白字符
 */
export function normalizeStatement(statement) {
  if (typeof statement !== 'string') return ''
  return statement.trim().replace(/\s+/g, ' ')
}

/**
 * 生成经验的完整 SHA-256 确定性内容 ID
 */
export function generateInsightId(category, statement) {
  const normCategory = String(category || '').trim().toLowerCase()
  const normStatement = normalizeStatement(statement)
  return crypto
    .createHash('sha256')
    .update(`${normCategory}:${normStatement}`, 'utf8')
    .digest('hex')
}

/**
 * 校验候选经验的 Schema 合法性
 */
export function validateCandidateInsight(candidate) {
  if (!candidate || typeof candidate !== 'object') {
    return { ok: false, reason: 'invalid-object', message: '候选经验必须是非空对象' }
  }

  const category = String(candidate.category || '').trim().toLowerCase()
  if (!INSIGHT_CATEGORIES.includes(category)) {
    return {
      ok: false,
      reason: 'invalid-category',
      message: `非法分类 "${candidate.category}"，必须是 ${INSIGHT_CATEGORIES.join(', ')} 之一`,
    }
  }

  const type = String(candidate.type || '').trim().toLowerCase()
  if (!INSIGHT_TYPES.includes(type)) {
    return {
      ok: false,
      reason: 'invalid-type',
      message: `非法认识论类型 "${candidate.type}"，必须是 ${INSIGHT_TYPES.join(', ')} 之一`,
    }
  }

  const normStatement = normalizeStatement(candidate.statement)
  if (!normStatement) {
    return { ok: false, reason: 'empty-statement', message: '经验陈述正文不能为空' }
  }
  if (normStatement.length > 200) {
    return {
      ok: false,
      reason: 'statement-too-long',
      message: `经验陈述正文超过 200 字限制（当前 ${normStatement.length} 字）`,
    }
  }

  let confidence = candidate.confidence
  if (confidence === undefined || confidence === null) {
    confidence = 0.8
  } else {
    confidence = Number(confidence)
    if (isNaN(confidence) || !isFinite(confidence) || confidence < 0.0 || confidence > 1.0) {
      return {
        ok: false,
        reason: 'invalid-confidence',
        message: '置信度必须是 0.0 到 1.0 之间的数值',
      }
    }
  }

  return {
    ok: true,
    normalized: {
      category,
      type,
      statement: normStatement,
      confidence: Math.round(confidence * 100) / 100,
    },
  }
}

/**
 * 提取并清洗当前会话的最近消息切片。
 *
 * 规则：
 * 1. 仅提取 role 为 'user' 与 'assistant' 的有效消息；
 * 2. 过滤系统内部注入消息；
 * 3. 工具输出强力清洗截断；
 * 4. 轮次上限 15 轮，字符上限 maxChars（默认 4000 字），超限从最早轮次裁剪。
 */
export function filterSessionMessages(messages, options = {}) {
  const maxTurns = Number(options.maxTurns) || 12
  const maxChars = Number(options.maxChars) || 4000

  if (!Array.isArray(messages) || messages.length === 0) {
    return {
      turns: 0,
      totalChars: 0,
      messages: [],
      formattedText: '',
    }
  }

  const rawValid = []
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue
    const role = m.role
    if (role !== 'user' && role !== 'assistant') continue

    // 剔除系统内部注入消息
    if (m.source && typeof m.source.kind === 'string') {
      const kind = m.source.kind.toLowerCase()
      if (kind.includes('system') || kind.includes('inject') || kind.includes('context')) {
        continue
      }
    }

    let text = ''
    if (typeof m.content === 'string') {
      text = m.content
    } else if (Array.isArray(m.content)) {
      text = m.content
        .map((part) => {
          if (typeof part === 'string') return part
          if (part && typeof part.text === 'string') return part.text
          return ''
        })
        .join(' ')
    }

    text = text.trim()
    if (!text) continue

    // 工具输出与长消息截断
    const limit = role === 'user' ? 500 : 800
    if (text.length > limit) {
      text = text.slice(0, limit) + ' ...[截断]'
    }

    rawValid.push({
      role,
      content: text,
      timestamp: m.timestamp || m.createdAt || null,
    })
  }

  // 截取最近若干轮（1 轮 = 1 问 + 1 答，最多 maxTurns * 2 条消息）
  const slice = rawValid.slice(-maxTurns * 2)

  // 限制总字符预算
  let charCount = 0
  const kept = []
  for (let i = slice.length - 1; i >= 0; i--) {
    const item = slice[i]
    if (charCount + item.content.length > maxChars && kept.length > 0) {
      break
    }
    charCount += item.content.length
    kept.unshift(item)
  }

  // 计算轮数并生成格式化纯文本
  const formattedLines = kept.map((m) => {
    const label = m.role === 'user' ? '用户' : '助手'
    return `[${label}]: ${m.content}`
  })

  // 估算轮数：以 user 消息数量计算
  const turnCount = kept.filter((m) => m.role === 'user').length

  return {
    turns: turnCount,
    totalChars: charCount,
    messages: kept,
    formattedText: formattedLines.join('\n\n'),
  }
}

/**
 * 解析并校验模型输出的候选经验。
 *
 * 容错支持：
 * 1. 数组结构；
 * 2. Markdown 代码块包裹的 JSON 文本；
 * 3. 严格禁止过度猜测，格式错乱或缺失核心字段直接拒绝。
 */
export function parseModelInsights(rawInput) {
  if (!rawInput) {
    return { ok: false, reason: 'empty-input', message: '输入内容为空' }
  }

  let candidates = rawInput
  if (typeof rawInput === 'string') {
    let clean = rawInput.trim()
    // 剥离 ```json ... ``` 或 ``` ... ```
    if (clean.startsWith('```')) {
      clean = clean.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
    }
    try {
      candidates = JSON.parse(clean)
    } catch {
      return {
        ok: false,
        reason: 'invalid-json',
        message: '模型输出不是合法的 JSON 格式，无法解析为候选经验',
      }
    }
  }

  if (!Array.isArray(candidates)) {
    return {
      ok: false,
      reason: 'not-an-array',
      message: '候选经验必须是 JSON 数组结构',
    }
  }

  if (candidates.length === 0) {
    return { ok: true, insights: [] }
  }

  // 限制单次最多提炼 3 条
  const limited = candidates.slice(0, 3)
  const validated = []

  for (let i = 0; i < limited.length; i++) {
    const check = validateCandidateInsight(limited[i])
    if (!check.ok) {
      return {
        ok: false,
        reason: check.reason,
        message: `第 ${i + 1} 条经验校验失败: ${check.message}`,
      }
    }
    validated.push(check.normalized)
  }

  return { ok: true, insights: validated }
}

/**
 * 校验已持久化的 Insight 对象完整性
 */
export function isValidPersistedInsight(obj) {
  if (!obj || typeof obj !== 'object') return false
  if (typeof obj.id !== 'string' || obj.id.length !== 64) return false
  if (!INSIGHT_CATEGORIES.includes(obj.category)) return false
  if (!INSIGHT_TYPES.includes(obj.type)) return false
  if (!INSIGHT_STATUSES.includes(obj.status)) return false
  if (typeof obj.statement !== 'string' || !obj.statement.trim()) return false
  if (typeof obj.createdAt !== 'string' || typeof obj.updatedAt !== 'string') return false
  return true
}

/**
 * 读取本地 insights.json 数据。
 *
 * 损坏现场保护：
 * 若解析失败或非数组，返回 { ok: false, corrupted: true, items: [] }，
 * 供写操作触发写保护，坚决不覆写损坏文件！
 */
export function readInsights(root) {
  const dir = resolveRoot(root)
  const file = path.join(dir, DREAM_DIR, INSIGHTS_FILE)

  if (!fs.existsSync(file)) {
    return { ok: true, corrupted: false, items: [] }
  }

  try {
    const content = fs.readFileSync(file, 'utf8')
    if (!content.trim()) {
      return { ok: true, corrupted: false, items: [] }
    }
    const parsed = JSON.parse(content)
    if (!Array.isArray(parsed)) {
      return { ok: false, corrupted: true, items: [] }
    }
    // 逐条检查合法性，若有损坏行记录为 corrupted
    const valid = []
    for (const item of parsed) {
      if (!isValidPersistedInsight(item)) {
        return { ok: false, corrupted: true, items: [] }
      }
      valid.push(item)
    }
    return { ok: true, corrupted: false, items: valid }
  } catch {
    return { ok: false, corrupted: true, items: [] }
  }
}

/**
 * 校验并持久化保存候选经验到 <root>/dream/insights.json。
 *
 * 核心安全特性：
 * 1. 跨进程目录锁保护；
 * 2. 锁内重新读取最新数据；
 * 3. 损坏文件写保护（若原有文件存在损坏，立即拒绝覆盖）；
 * 4. 纯内容完整 SHA-256 去重；
 * 5. 安全原子替换 safeAtomicReplace。
 */
export function saveInsights(root, candidates, sessionInfo = {}, now = new Date()) {
  const dir = resolveRoot(root)
  const dreamDir = path.join(dir, DREAM_DIR)
  const file = path.join(dreamDir, INSIGHTS_FILE)
  const lockDir = path.join(dreamDir, INSIGHTS_LOCK)

  // 1. 前置校验候选经验
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return { ok: true, saved: [], skipped: [], message: '没有需要保存的候选经验' }
  }

  const nowIso = (now instanceof Date && !isNaN(now.getTime()) ? now : new Date()).toISOString()

  // 确保 dream 目录存在
  if (!fs.existsSync(dreamDir)) {
    fs.mkdirSync(dreamDir, { recursive: true })
  }

  // 2. 获取跨进程独占锁
  const lockToken = acquireDirLock(lockDir, { staleMs: 15000 })
  if (!lockToken) {
    return {
      ok: false,
      reason: 'lock-timeout',
      message: '获取 Dream 文件锁超时，可能有其他并发写入操作',
    }
  }

  let tmpFile = null
  try {
    // 3. 锁内重新读取最新数据
    const current = readInsights(root)
    if (current.corrupted) {
      // 触发写保护：坚决不覆写破坏磁盘现场！
      return {
        ok: false,
        reason: 'corrupted-data',
        message: '检测到 insights.json 数据损坏，已触发写保护以保留磁盘现场，拒绝覆写',
      }
    }

    const itemsMap = new Map()
    for (const item of current.items) {
      itemsMap.set(item.id, item)
    }

    const saved = []
    const skipped = []

    for (const c of candidates) {
      const id = generateInsightId(c.category, c.statement)
      if (itemsMap.has(id)) {
        skipped.push({ id, statement: c.statement, reason: 'duplicate' })
        continue
      }

      const record = {
        id,
        category: c.category,
        statement: c.statement,
        type: c.type,
        status: 'candidate',
        confidence: c.confidence !== undefined ? c.confidence : 0.8,
        source: {
          session: sessionInfo.session || '',
          turnCount: Number(sessionInfo.turnCount) || 0,
          timestamp: nowIso,
        },
        createdAt: nowIso,
        updatedAt: nowIso,
      }

      itemsMap.set(id, record)
      saved.push(record)
    }

    // 若无任何新增，无需写盘
    if (saved.length === 0) {
      return {
        ok: true,
        saved: [],
        skipped,
        message: '所有候选经验均已存在，无需重复保存',
      }
    }

    // 4. 写入临时文件并通过原子替换落盘
    const rand = Math.random().toString(36).slice(2, 8)
    tmpFile = path.join(dreamDir, `${INSIGHTS_FILE}.tmp.${process.pid}.${Date.now()}.${rand}`)
    const fullList = Array.from(itemsMap.values())
    fs.writeFileSync(tmpFile, JSON.stringify(fullList, null, 2) + '\n', 'utf8')

    // 5. Fencing Check 锁凭据有效性校验
    if (!isDirLockHeld(lockDir, lockToken)) {
      throw new Error('写盘前锁凭据校验失败：锁已被接管或失效')
    }

    // 6. 原子替换
    safeAtomicReplace(tmpFile, file)
    return {
      ok: true,
      saved,
      skipped,
      totalCount: fullList.length,
      message: `成功保存 ${saved.length} 条候选经验${skipped.length > 0 ? `（${skipped.length} 条已存在跳过）` : ''}`,
    }
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
 * 审核状态流转纯函数：根据当前状态与动作执行流转判定
 */
export function applyInsightTransition(current, action, options = {}, now = new Date()) {
  if (!current || !current.status) {
    return { ok: false, reason: 'not-found', message: '条目不存在' }
  }

  const curStatus = current.status
  const nowIso = (now instanceof Date && !isNaN(now.getTime()) ? now : new Date()).toISOString()

  if (action === 'confirm') {
    if (curStatus === 'confirmed') {
      return { ok: true, changed: false, insight: current, message: '该条目已经是确认状态' }
    }
    if (curStatus === 'rejected') {
      return {
        ok: false,
        reason: 'illegal-transition',
        message: '已驳回的条目不能直接确认',
      }
    }
    // candidate -> confirmed
    return {
      ok: true,
      changed: true,
      insight: {
        ...current,
        status: 'confirmed',
        updatedAt: nowIso,
      },
      message: '经验已成功确认为有效条目',
    }
  }

  if (action === 'reject') {
    if (curStatus === 'rejected') {
      return { ok: true, changed: false, insight: current, message: '该条目已经是驳回状态' }
    }
    if (curStatus === 'confirmed') {
      return {
        ok: false,
        reason: 'illegal-transition',
        message: '已确认的条目不能直接驳回',
      }
    }
    // candidate -> rejected
    return {
      ok: true,
      changed: true,
      insight: {
        ...current,
        status: 'rejected',
        statusReason: options.reason ? String(options.reason).trim() : '',
        updatedAt: nowIso,
      },
      message: '经验已标记驳回',
    }
  }

  return {
    ok: false,
    reason: 'invalid-action',
    message: `不支持的审核操作 "${action}"（首版支持 confirm / reject）`,
  }
}

/**
 * 更新单条经验的审核状态并持久化。
 */
export function updateInsightStatus(root, id, action, options = {}, now = new Date()) {
  if (!id || typeof id !== 'string') {
    return { ok: false, reason: 'invalid-id', message: '必须提供经验条目 ID' }
  }

  const dir = resolveRoot(root)
  const dreamDir = path.join(dir, DREAM_DIR)
  const file = path.join(dreamDir, INSIGHTS_FILE)
  const lockDir = path.join(dreamDir, INSIGHTS_LOCK)

  // 1. 获取互斥锁
  const lockToken = acquireDirLock(lockDir, { staleMs: 15000 })
  if (!lockToken) {
    return {
      ok: false,
      reason: 'lock-timeout',
      message: '获取 Dream 文件锁超时，请稍后重试',
    }
  }

  let tmpFile = null
  try {
    // 2. 锁内重新读取
    const currentData = readInsights(root)
    if (currentData.corrupted) {
      return {
        ok: false,
        reason: 'corrupted-data',
        message: '检测到 insights.json 损坏，已触发写保护拒绝覆盖',
      }
    }

    const items = currentData.items
    const targetId = id.trim()
    // 支持完整 64 位哈希，或至少 8 位前缀匹配
    const matchIndex = items.findIndex((it) => it.id === targetId || (targetId.length >= 8 && it.id.startsWith(targetId)))

    if (matchIndex === -1) {
      return {
        ok: false,
        reason: 'not-found',
        message: `未找到匹配 ID "${targetId}" 的经验条目`,
      }
    }

    const targetItem = items[matchIndex]
    const transition = applyInsightTransition(targetItem, action, options, now)
    if (!transition.ok) {
      return transition
    }

    if (!transition.changed) {
      return transition
    }

    // 3. 替换数组中的项
    items[matchIndex] = transition.insight

    // 4. 原子安全写回
    const rand = Math.random().toString(36).slice(2, 8)
    tmpFile = path.join(dreamDir, `${INSIGHTS_FILE}.tmp.${process.pid}.${Date.now()}.${rand}`)
    fs.writeFileSync(tmpFile, JSON.stringify(items, null, 2) + '\n', 'utf8')

    if (!isDirLockHeld(lockDir, lockToken)) {
      throw new Error('写盘前锁凭据校验失败：锁已被接管或失效')
    }

    safeAtomicReplace(tmpFile, file)
    return {
      ok: true,
      changed: true,
      insight: transition.insight,
      message: transition.message,
    }
  } catch (err) {
    if (tmpFile && fs.existsSync(tmpFile)) {
      try { fs.unlinkSync(tmpFile) } catch {}
    }
    throw err
  } finally {
    releaseDirLock(lockDir, lockToken)
  }
}
