// dsh-heart 的纯逻辑内核。
// 只依赖 node:fs / node:path / node:os —— 不 import 任何 DSH 包，
// 因此可以被插件、CLI、测试三处共用，也能单独拷到容器里跑。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import zlib from 'node:zlib'

export const SCHEMA_VERSION = 1

/** 注入进上下文的上限：心是「摘要」，不是全文。 */
export const MAX_CORE_BYTES = 6 * 1024
/** 单次检索返回的上限。 */
export const MAX_RECALL_BYTES = 8 * 1024

export const DEFAULT_CORE = `# 我是谁

> 这是「心」的最内层，只有你能改。写事实，不写形容词堆砌。

- 名字：
- 身份：
- 我服务的人：
- 我看重什么：
- 我绝不做什么：
- 我的说话方式：
`

export const DEFAULT_RELATIONSHIP = `# 我和你

> 关系史：约定、称呼、雷区、重要时刻。一行一条，带日期。

`

export function resolveRoot(root) {
  const value = String(root || '').trim()
  if (value) return path.resolve(value)
  return path.join(os.homedir(), '.dsh', 'heart')
}

const pad = (n) => String(n).padStart(2, '0')

export function dateOf(now = new Date()) {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

export function timeOf(now = new Date()) {
  return `${pad(now.getHours())}:${pad(now.getMinutes())}`
}

export function safeDevice(device) {
  const value = String(device || 'agent')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return value || 'agent'
}

/** 记忆行必须是单行：换行会把格式打坏。 */
export function oneLine(text, max = 800) {
  const value = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  return value.length > max ? value.slice(0, max) + '…' : value
}

export function ensureLayout(root, device = 'agent') {
  const dir = resolveRoot(root)
  fs.mkdirSync(path.join(dir, 'MEMORY'), { recursive: true })
  const core = path.join(dir, 'CORE.md')
  if (!fs.existsSync(core)) fs.writeFileSync(core, DEFAULT_CORE, 'utf8')
  const rel = path.join(dir, 'RELATIONSHIP.md')
  if (!fs.existsSync(rel)) fs.writeFileSync(rel, DEFAULT_RELATIONSHIP, 'utf8')
  const schema = path.join(dir, 'schema.json')
  if (!fs.existsSync(schema)) {
    fs.writeFileSync(schema, JSON.stringify({ version: SCHEMA_VERSION }, null, 2) + '\n', 'utf8')
  }
  const readme = path.join(dir, 'MEMORY', 'README.md')
  if (!fs.existsSync(readme)) {
    fs.writeFileSync(
      readme,
      [
        '# 记忆',
        '',
        '一行一条，文件名 `YYYY-MM-DD.<设备>.md`，按设备分开写 —— 这样同步永远不会冲突。',
        '格式：`- HH:MM [设备] 内容`',
        '',
        '每条前面标注来源（`[pc]` / `[phone]`），读的时候就能分清"我亲身经历"和"另一边告诉我的"。',
        '',
        '只写值得记住的：偏好、决定、约定、重要事件、踩过的坑。',
        '不写：日常过程、临时状态、能从文件里重新读到的内容。',
        '',
      ].join('\n'),
      'utf8'
    )
  }
  void device
  return dir
}

export function appendMemory(root, device, text, now = new Date()) {
  const dir = ensureLayout(root, device)
  const dev = safeDevice(device)
  const file = path.join(dir, 'MEMORY', `${dateOf(now)}.${dev}.md`)
  const line = `- ${timeOf(now)} [${dev}] ${oneLine(text)}\n`
  fs.appendFileSync(file, line, 'utf8')
  return { file, line: line.trim() }
}

export function appendRelationship(root, device, text, now = new Date()) {
  const dir = ensureLayout(root, device)
  const dev = safeDevice(device)
  const line = `- ${dateOf(now)} ${timeOf(now)} [${dev}] ${oneLine(text)}\n`
  fs.appendFileSync(path.join(dir, 'RELATIONSHIP.md'), line, 'utf8')
  return { file: path.join(dir, 'RELATIONSHIP.md'), line: line.trim() }
}

function readCapped(file, cap) {
  if (!fs.existsSync(file)) return ''
  const buf = fs.readFileSync(file)
  return buf.length > cap ? buf.subarray(0, cap).toString('utf8') + '\n…(截断)' : buf.toString('utf8')
}

/** 最近 N 天的记忆文件，新的在前。 */
export function recentMemoryFiles(root, days = 3) {
  const dir = path.join(resolveRoot(root), 'MEMORY')
  if (!fs.existsSync(dir)) return []
  const since = new Date(Date.now() - days * 86400_000)
  const sinceKey = dateOf(since)
  return fs
    .readdirSync(dir)
    .filter((name) => /^\d{4}-\d{2}-\d{2}\..+\.md$/.test(name))
    .filter((name) => name.slice(0, 10) >= sinceKey)
    .sort()
    .reverse()
    .map((name) => path.join(dir, name))
}

/** 会话开始注入用：自我 + 关系 + 最近几天的记忆，整体有字节上限。 */
export function readCore(root, { days = 3, maxBytes = MAX_CORE_BYTES } = {}) {
  const dir = resolveRoot(root)
  ensureLayout(dir)
  const parts = []
  const core = readCapped(path.join(dir, 'CORE.md'), 3000).trim()
  if (core) parts.push(core)
  const rel = readCapped(path.join(dir, 'RELATIONSHIP.md'), 2000).trim()
  if (rel) parts.push(rel)
  const files = recentMemoryFiles(dir, days)
  if (files.length) {
    const lines = []
    for (const file of files) {
      const name = path.basename(file, '.md')
      const body = fs.readFileSync(file, 'utf8').trim()
      if (body) lines.push(`### ${name}\n${body}`)
    }
    if (lines.length) parts.push('## 最近\n' + lines.join('\n'))
  }
  let out = parts.join('\n\n')
  if (Buffer.byteLength(out) > maxBytes) {
    out = Buffer.from(out).subarray(0, maxBytes).toString('utf8') + '\n…(截断)'
  }
  return out
}

/** 关键词检索：只扫 MEMORY，按时间倒序，结果有上限。 */
export function recall(root, query, { days = 30, limit = 40, maxBytes = MAX_RECALL_BYTES } = {}) {
  const dir = resolveRoot(root)
  const needle = String(query || '').trim().toLowerCase()
  const files = recentMemoryFiles(dir, days)
  const hits = []
  for (const file of files) {
    const base = path.basename(file, '.md')
    const lines = fs.readFileSync(file, 'utf8').split('\n')
    for (const line of lines) {
      if (!line.trim()) continue
      if (needle && !line.toLowerCase().includes(needle)) continue
      hits.push(`${base} ${line.trim()}`)
      if (hits.length >= limit) break
    }
    if (hits.length >= limit) break
  }
  let out = hits.join('\n')
  if (Buffer.byteLength(out) > maxBytes) {
    out = Buffer.from(out).subarray(0, maxBytes).toString('utf8') + '\n…(截断)'
  }
  return { query: needle, count: hits.length, text: out }
}

/** 数据格式迁移：插件升级时调用，读旧 schema 写新格式。 */
export function migrate(root) {
  const dir = resolveRoot(root)
  ensureLayout(dir)
  const file = path.join(dir, 'schema.json')
  let current = 0
  try {
    current = Number(JSON.parse(fs.readFileSync(file, 'utf8')).version) || 0
  } catch {
    current = 0
  }
  if (current === SCHEMA_VERSION) return { from: current, to: current, changed: false }
  // 未来版本在这里逐级迁移；v1 是首版，只需补写 schema 文件。
  fs.writeFileSync(file, JSON.stringify({ version: SCHEMA_VERSION }, null, 2) + '\n', 'utf8')
  return { from: current, to: SCHEMA_VERSION, changed: true }
}

export function stats(root) {
  const dir = resolveRoot(root)
  ensureLayout(dir)
  const memDir = path.join(dir, 'MEMORY')
  const files = fs.readdirSync(memDir).filter((n) => n.endsWith('.md') && n !== 'README.md')
  let lines = 0
  for (const name of files) {
    lines += fs
      .readFileSync(path.join(memDir, name), 'utf8')
      .split('\n')
      .filter((l) => l.trim().startsWith('- ')).length
  }
  const coreBytes = fs.existsSync(path.join(dir, 'CORE.md'))
    ? fs.statSync(path.join(dir, 'CORE.md')).size
    : 0
  return { root: dir, files: files.length, entries: lines, coreBytes }
}

// ---------------------------------------------------------------------------
// 导出 / 导入
//
// 为什么插件需要自己的一套：宿主的备份分档 —— 全量（整个 .dsh）会带上 heart，
// 但「只对话 / 只设置 / 只插件」三种部分备份不会，插件导出更是只含源码。
// 所以「心」必须能自己打包成一个自包含文件，用户存到哪都行。
// ---------------------------------------------------------------------------

const BUNDLE_FORMAT = 'dsh-heart'

function collectFiles(dir) {
  const files = {}
  for (const name of ['CORE.md', 'RELATIONSHIP.md']) {
    const file = path.join(dir, name)
    if (fs.existsSync(file)) files[name] = fs.readFileSync(file, 'utf8')
  }
  const memDir = path.join(dir, 'MEMORY')
  if (fs.existsSync(memDir)) {
    for (const name of fs.readdirSync(memDir)) {
      if (!/^\d{4}-\d{2}-\d{2}\..+\.md$/.test(name)) continue
      files[`MEMORY/${name}`] = fs.readFileSync(path.join(memDir, name), 'utf8')
    }
  }
  return files
}

/** 打包成自包含的 .json.gz：一个文件，无外部依赖，可放 Download/附件/任何地方。 */
export function exportBundle(root, now = new Date()) {
  const dir = resolveRoot(root)
  ensureLayout(dir)
  const payload = {
    format: BUNDLE_FORMAT,
    schema: SCHEMA_VERSION,
    exportedAt: now.toISOString(),
    files: collectFiles(dir),
  }
  return zlib.gzipSync(Buffer.from(JSON.stringify(payload, null, 2), 'utf8'))
}

/** 把打包文件写盘，返回路径与字节数。 */
export function exportBundleToFile(root, file, now = new Date()) {
  const dir = resolveRoot(root)
  const buf = exportBundle(dir, now)
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true })
  fs.writeFileSync(file, buf)
  return { file: path.resolve(file), bytes: buf.length }
}

function mergeMemoryText(existing, incoming) {
  const lines = new Set()
  for (const line of `${existing}\n${incoming}`.split('\n')) {
    const value = line.trim()
    if (value.startsWith('- ')) lines.add(value)
  }
  return [...lines].sort().join('\n') + '\n'
}

/**
 * 合并导入。默认保守：
 *  - 记忆文件按行求并集（永远不丢、也不重复）
 *  - CORE.md / RELATIONSHIP.md 已存在就跳过，除非 force
 * 这样从别的设备导回来不会把本机写的心覆盖掉。
 */
export function importBundle(root, buffer, { force = false } = {}) {
  const dir = resolveRoot(root)
  ensureLayout(dir)
  const payload = JSON.parse(zlib.gunzipSync(buffer).toString('utf8'))
  if (payload.format !== BUNDLE_FORMAT) throw new Error('不是 dsh-heart 的导出文件')
  const result = { memoryFiles: 0, memoryLines: 0, kept: [], skipped: [] }
  for (const [name, text] of Object.entries(payload.files || {})) {
    if (name === 'CORE.md' || name === 'RELATIONSHIP.md') {
      const file = path.join(dir, name)
      if (!force && fs.existsSync(file) && fs.readFileSync(file, 'utf8').trim()) {
        result.skipped.push(name)
        continue
      }
      fs.writeFileSync(file, text, 'utf8')
      result.kept.push(name)
      continue
    }
    if (!name.startsWith('MEMORY/')) continue
    const file = path.join(dir, name)
    const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
    const merged = mergeMemoryText(existing, text)
    fs.writeFileSync(file, merged, 'utf8')
    result.memoryFiles += 1
    result.memoryLines += merged.split('\n').filter((l) => l.trim().startsWith('- ')).length
  }
  return result
}
