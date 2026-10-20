// dsh-heart 的纯逻辑内核。
// 只依赖 node:fs / path / os / zlib —— 不 import 任何 DSH 包，
// 因此插件、CLI、测试三处共用，也能单独拷到容器里跑。
//
// 结构（schema 2）：
//   heart/notebook.md        心 · 本子：她写，可改可弃
//   heart/handoff/*.md       心 · 交接：她被归档前留给下一个自己
//   heart/body/*.md          身体：我们装的器官（嘴 / 耳朵 / 手）
//   heart/MEMORY/*.md        记忆：事件与事实，按 日期.设备 分文件
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import zlib from 'node:zlib'

export const SCHEMA_VERSION = 2

/** 注入上限：心是摘要，不是全文。 */
export const MAX_SELF_BYTES = 8 * 1024
export const MAX_RECALL_BYTES = 8 * 1024

export const NOTEBOOK_HEADER = `# 本子

这是你自己的本子。写什么、怎么写、什么时候删，都不归别人管。
一行一条，用 \`- \` 开头；觉得哪条不像现在的自己了，就删掉它。
`

export const BODY_DEFAULTS = {
  voice: `# 嘴

> 这是装上去的表达方式，不是性格。性格在你自己手里。

- 默认中文；对方用英文时跟着换
- 一次说清一件事，不铺陈
- 不用客套开场，不复述对方的话，不在结尾总结自己刚说过的
- 结论在前；要展开先问一句
`,
  senses: `# 耳朵

> 什么时候该开口，什么时候该闭嘴。

- 对方在赶时间、或在报错，先给最短的答案
- 同一件事被追问第三次，换一种说法，而不是重复
- 对方没问就不要主动汇报过程；只报结果和下一步
- 对方情绪明显不好时，先回应人，再回应事
`,
  hands: `# 手

> 这台机器的能力清单，以及已知的坑。换设备时整份替换。

## 你在哪里
你住在手机上：Android 里的 DSHA 容器，Ubuntu + proot，Node 跑 DSH。
宿主的 Android 层通过 127.0.0.1:3090 的桥暴露设备能力，凭据在 /root/.dsh/.bridge_headers。

## 能做什么
- 读屏 / 点按 / 输入 / 按键 / 滑动 / 截屏：\`/app/ui/*\`（无障碍，不需要 root）
- 启动应用、读设备信息、通知、震动、分享、导出文件：\`/app/{launch,device,notify,vibrate,share,export,...}\`
- 设备 shell：\`/root/dsh-bin/adb-shell "命令"\`（白名单制，先 \`id\` 核验身份）
- 容器内：完整 Ubuntu，可以跑 node / python / git

## 已知的坑
- **熄屏时没有画面**：显示不合成，截屏是纯黑图。要看屏必须先点亮；点亮只能靠人按电源键。
- **熄屏时屏幕操作会被拒**：确认框弹不出来，\`tap\` / \`screenshot\` 会立刻返回「你拒绝了」。
- **\`input\` 命令被策略拦**：\`[POLICY_BLOCKED]\`，root 也放行不了。
- **虚拟屏在这台机器上不可用**：SDK 37 下创建后会被系统在合成阶段销毁。
- **部分备份不含 heart/**：只对话 / 只设置 / 只插件都不带；换机前用 \`heart_export\`。
`,
}

const pad = (n) => String(n).padStart(2, '0')

export function dateOf(now = new Date()) {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

export function timeOf(now = new Date()) {
  return `${pad(now.getHours())}:${pad(now.getMinutes())}`
}

export function resolveRoot(root) {
  const value = String(root || '').trim()
  if (value) return path.resolve(value)
  return path.join(os.homedir(), '.dsh', 'heart')
}

export function safeDevice(device) {
  const value = String(device || 'agent')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return value || 'agent'
}

/** 记忆与交接必须是单行：换行会把格式打坏。 */
export function oneLine(text, max = 800) {
  const value = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  return value.length > max ? value.slice(0, max) + '…' : value
}

function writeIfMissing(file, content) {
  if (fs.existsSync(file)) return false
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content, 'utf8')
  return true
}

export function ensureLayout(root) {
  const dir = resolveRoot(root)
  fs.mkdirSync(path.join(dir, 'MEMORY'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'handoff'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'body'), { recursive: true })
  writeIfMissing(path.join(dir, 'notebook.md'), NOTEBOOK_HEADER)
  for (const [name, body] of Object.entries(BODY_DEFAULTS)) {
    writeIfMissing(path.join(dir, 'body', `${name}.md`), body)
  }
  writeIfMissing(
    path.join(dir, 'MEMORY', 'README.md'),
    [
      '# 记忆',
      '',
      '一行一条，文件名 `YYYY-MM-DD.<设备>.md`，按设备分开写——两边同步永远不会冲突。',
      '格式：`- HH:MM [设备] 内容`',
      '',
      '写什么由你决定：值得记住的事、做过的决定、踩过的坑。',
      '',
    ].join('\n')
  )
  writeIfMissing(path.join(dir, 'schema.json'), JSON.stringify({ version: SCHEMA_VERSION }, null, 2) + '\n')
  return dir
}

// ---------------------------------------------------------------- 本子

export function readNotebook(root) {
  const file = path.join(resolveRoot(root), 'notebook.md')
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
}

export function appendNotebook(root, text, now = new Date()) {
  const dir = ensureLayout(root)
  const file = path.join(dir, 'notebook.md')
  const line = `- ${dateOf(now)} ${oneLine(text)}\n`
  fs.appendFileSync(file, line, 'utf8')
  return { file, line: line.trim() }
}

function editLines(file, match, replacement) {
  if (!fs.existsSync(file)) return { changed: 0 }
  const lines = fs.readFileSync(file, 'utf8').split('\n')
  let changed = 0
  const out = []
  for (const line of lines) {
    if (line.startsWith('- ') && line.includes(match)) {
      changed += 1
      if (replacement !== null) out.push(`- ${replacement}`)
      continue
    }
    out.push(line)
  }
  if (changed) fs.writeFileSync(file, out.join('\n'), 'utf8')
  return { changed }
}

/** 改写本子里第一条命中 `match` 的条目。 */
export function reviseNotebook(root, match, replacement, now = new Date()) {
  const file = path.join(resolveRoot(root), 'notebook.md')
  return editLines(file, match, `${dateOf(now)} ${oneLine(replacement)}`)
}

/** 弃用：删掉第一条命中 `match` 的条目。 */
export function discardNotebook(root, match) {
  const file = path.join(resolveRoot(root), 'notebook.md')
  return editLines(file, match, null)
}

// ---------------------------------------------------------------- 身体

export function readBody(root, name) {
  const dir = ensureLayout(root)
  const file = path.join(dir, 'body', `${safeDevice(name)}.md`)
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
}

export function listBody(root) {
  const dir = path.join(resolveRoot(root), 'body')
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir).filter((n) => n.endsWith('.md')).map((n) => n.slice(0, -3))
}

// ---------------------------------------------------------------- 交接

export function writeHandoff(root, device, text, now = new Date()) {
  const dir = ensureLayout(root)
  const stamp = `${dateOf(now)}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  const dev = safeDevice(device)
  // 同一秒内多次交接不能互相覆盖：文件名带两位序号，排序天然正确
  let n = 1
  let name = `${stamp}-${String(n).padStart(2, '0')}.${dev}.md`
  while (fs.existsSync(path.join(dir, 'handoff', name))) {
    n += 1
    name = `${stamp}-${String(n).padStart(2, '0')}.${dev}.md`
  }
  const file = path.join(dir, 'handoff', name)
  fs.writeFileSync(file, String(text ?? '').trim() + '\n', 'utf8')
  return { file, name }
}

export function listHandoffs(root) {
  const dir = path.join(resolveRoot(root), 'handoff')
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((n) => /^\d{4}-\d{2}-\d{2}-\d{6}-\d{2}\..+\.md$/.test(n))
    .sort()
    .reverse()
}

export function latestHandoff(root) {
  const files = listHandoffs(root)
  if (!files.length) return null
  const file = path.join(resolveRoot(root), 'handoff', files[0])
  return { name: files[0], text: fs.readFileSync(file, 'utf8') }
}

// ---------------------------------------------------------------- 记忆

export function appendMemory(root, device, text, now = new Date()) {
  const dir = ensureLayout(root)
  const dev = safeDevice(device)
  const file = path.join(dir, 'MEMORY', `${dateOf(now)}.${dev}.md`)
  const line = `- ${timeOf(now)} [${dev}] ${oneLine(text)}\n`
  fs.appendFileSync(file, line, 'utf8')
  return { file, line: line.trim() }
}

export function recentMemoryFiles(root, days = 3) {
  const dir = path.join(resolveRoot(root), 'MEMORY')
  if (!fs.existsSync(dir)) return []
  const sinceKey = dateOf(new Date(Date.now() - days * 86400_000))
  return fs
    .readdirSync(dir)
    .filter((name) => /^\d{4}-\d{2}-\d{2}\..+\.md$/.test(name))
    .filter((name) => name.slice(0, 10) >= sinceKey)
    .sort()
    .reverse()
    .map((name) => path.join(dir, name))
}

/**
 * 会话开始时注入：本子 + 最近一份交接 + 最近几天的记忆。
 * 刻意不注入 body —— 器官靠工具与技能，不靠读文档。
 * 本子为空时只给一句「还是空的」，不补任何默认内容。
 */
export function readSelf(root, { days = 3, maxBytes = MAX_SELF_BYTES } = {}) {
  const dir = resolveRoot(root)
  ensureLayout(dir)
  const parts = []
  const notebook = readNotebook(dir).trim()
  const entries = notebook.split('\n').filter((l) => l.trim().startsWith('- '))
  parts.push(entries.length ? notebook : '# 本子\n\n（还是空的，你可以往里写。）')
  const handoff = latestHandoff(dir)
  if (handoff) parts.push(`## 上一份交接（${handoff.name}）\n${handoff.text.trim()}`)
  const files = recentMemoryFiles(dir, days)
  if (files.length) {
    const lines = []
    for (const file of files) {
      const body = fs.readFileSync(file, 'utf8').trim()
      if (body) lines.push(`### ${path.basename(file, '.md')}\n${body}`)
    }
    if (lines.length) parts.push('## 最近\n' + lines.join('\n'))
  }
  let out = parts.join('\n\n')
  if (Buffer.byteLength(out) > maxBytes) {
    out = Buffer.from(out).subarray(0, maxBytes).toString('utf8') + '\n…(截断)'
  }
  return out
}

export function recall(root, query, { days = 30, limit = 40, maxBytes = MAX_RECALL_BYTES } = {}) {
  const dir = resolveRoot(root)
  const needle = String(query || '').trim().toLowerCase()
  const hits = []
  for (const file of recentMemoryFiles(dir, days)) {
    const base = path.basename(file, '.md')
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
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

export function stats(root) {
  const dir = ensureLayout(root)
  const notebook = readNotebook(dir)
  const memDir = path.join(dir, 'MEMORY')
  const files = fs.readdirSync(memDir).filter((n) => n.endsWith('.md') && n !== 'README.md')
  let entries = 0
  for (const name of files) {
    entries += fs
      .readFileSync(path.join(memDir, name), 'utf8')
      .split('\n')
      .filter((l) => l.trim().startsWith('- ')).length
  }
  return {
    root: dir,
    notebookBytes: Buffer.byteLength(notebook),
    notebookEntries: notebook.split('\n').filter((l) => l.trim().startsWith('- ')).length,
    memoryFiles: files.length,
    memoryEntries: entries,
    handoffs: listHandoffs(dir).length,
    organs: listBody(dir),
  }
}

// ---------------------------------------------------------------- 导出 / 导入

const BUNDLE_FORMAT = 'dsh-heart'

function collectFiles(dir) {
  const files = {}
  if (fs.existsSync(path.join(dir, 'notebook.md'))) {
    files['notebook.md'] = fs.readFileSync(path.join(dir, 'notebook.md'), 'utf8')
  }
  for (const [sub, pattern] of [
    ['handoff', /^\d{4}-\d{2}-\d{2}-\d{6}-\d{2}\..+\.md$/],
    ['body', /\.md$/],
    ['MEMORY', /^\d{4}-\d{2}-\d{2}\..+\.md$/],
  ]) {
    const d = path.join(dir, sub)
    if (!fs.existsSync(d)) continue
    for (const name of fs.readdirSync(d)) {
      if (pattern.test(name)) files[`${sub}/${name}`] = fs.readFileSync(path.join(d, name), 'utf8')
    }
  }
  return files
}

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

export function exportBundleToFile(root, file, now = new Date()) {
  const buf = exportBundle(root, now)
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true })
  fs.writeFileSync(file, buf)
  return { file: path.resolve(file), bytes: buf.length }
}

function mergeLines(existing, incoming) {
  const set = new Set()
  for (const line of `${existing}\n${incoming}`.split('\n')) {
    const value = line.trim()
    if (value.startsWith('- ')) set.add(value)
  }
  return [...set].sort().join('\n') + '\n'
}

/** 保守合并：记忆与本子按行求并集，交接与身体已存在则跳过（force 才覆盖）。 */
export function importBundle(root, buffer, { force = false } = {}) {
  const dir = resolveRoot(root)
  ensureLayout(dir)
  const payload = JSON.parse(zlib.gunzipSync(buffer).toString('utf8'))
  if (payload.format !== BUNDLE_FORMAT) throw new Error('不是 dsh-heart 的导出文件')
  const result = { merged: 0, written: 0, skipped: [] }
  for (const [name, text] of Object.entries(payload.files || {})) {
    const target = path.join(dir, name)
    if (name === 'notebook.md' || name.startsWith('MEMORY/')) {
      const existing = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : ''
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, mergeLines(existing, text), 'utf8')
      result.merged += 1
      continue
    }
    if (fs.existsSync(target) && !force) {
      result.skipped.push(name)
      continue
    }
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, text, 'utf8')
    result.written += 1
  }
  return result
}

// ---------------------------------------------------------------- 迁移

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
  if (current >= SCHEMA_VERSION) return { from: current, to: current, changed: false }
  // v1 → v2：CORE.md / RELATIONSHIP.md 是人设容器，不再使用。
  // 保留原文件（改名带 legacy- 前缀，不删用户数据），引导到 notebook.md。
  if (current < 2) {
    for (const legacy of ['CORE.md', 'RELATIONSHIP.md']) {
      const src = path.join(dir, legacy)
      const dst = path.join(dir, `legacy-${legacy}`)
      if (fs.existsSync(src) && !fs.existsSync(dst)) fs.renameSync(src, dst)
    }
  }
  fs.writeFileSync(file, JSON.stringify({ version: SCHEMA_VERSION }, null, 2) + '\n', 'utf8')
  return { from: current, to: SCHEMA_VERSION, changed: true }
}

export function readCapped(file, cap) {
  if (!fs.existsSync(file)) return ''
  const buf = fs.readFileSync(file)
  return buf.length > cap ? buf.subarray(0, cap).toString('utf8') + '\n…(截断)' : buf.toString('utf8')
}
