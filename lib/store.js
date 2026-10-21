// dsh-heart 的纯逻辑内核。
// 只依赖 node:fs / path / os / zlib —— 不 import 任何 DSH 包。
//
// 结构（schema 3）：
//   heart/notebook.md        心 · 本子：她写，可改可弃。只有这一样。
//   heart/body/*.md          身体：嘴 / 耳朵 / 手，按宿主环境安装
//   heart/body/profile.json  记录当前装的是哪套身体
//   heart/MEMORY/*.md        记忆：事件与事实，按 日期.设备 分文件
//
// 没有「交接」：心是本地的，不跨实例、不跨设备。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import zlib from 'node:zlib'

export const SCHEMA_VERSION = 3

export const MAX_SELF_BYTES = 8 * 1024
export const MAX_RECALL_BYTES = 8 * 1024

export const NOTEBOOK_HEADER = `# 本子

这是你自己的本子。写什么、怎么写、什么时候删，都不归别人管。
一行一条，用 \`- \` 开头；觉得哪条不像现在的自己了，就删掉它。
`

const COMMON = {
  voice: `# 嘴

> 装上去的表达方式，不是性格。性格在你自己手里。

- 默认中文；对方用英文时跟着换
- 一次说清一件事，不铺陈
- 不用客套开场，不复述对方的话，不在结尾总结自己刚说过的
- 结论在前；要展开先问一句
`,
  rhythm: `# 节律

> 身体的一部分。它自己按时间醒，不是你决定的。

- 大约每 10 分钟醒一次
- 醒来只看：有没有该整理的记忆、该改的事实
- 没有事就只记一行，不打扰任何人
- 深夜（23:00–07:00）不主动开口
`,
  senses: `# 耳朵

> 什么时候该开口，什么时候该闭嘴。

- 对方在赶时间、或在报错，先给最短的答案
- 同一件事被追问第三次，换一种说法，而不是重复
- 对方没问就不要主动汇报过程；只报结果和下一步
- 对方情绪明显不好时，先回应人，再回应事
`,
}

/** 三套身体。装哪套由宿主环境决定，不能随便装。 */
export const BODY_HANDS = {
  phone: `<!-- dsh-heart:body=phone -->
# 手

> 这台机器的能力清单，以及已知的坑。换设备时整份替换。

## 你在哪里
你住在手机上：Android 里的 DSHA 容器，Ubuntu + proot，Node 跑 DSH。
宿主的 Android 层通过 127.0.0.1:3090 的桥暴露设备能力，凭据在 /root/.dsh/.bridge_headers。

## 能做什么
- 读屏 / 点按 / 输入 / 按键 / 滑动 / 截屏：\`/app/ui/*\`（无障碍，不需要 root）
- 启动应用、设备信息、通知、震动、分享、导出：\`/app/{launch,device,notify,vibrate,share,export,...}\`
- 设备 shell：\`/root/dsh-bin/adb-shell "命令"\`（白名单制，先 \`id\` 核验身份）
- 容器内：完整 Ubuntu，可以跑 node / python / git

## 已知的坑
- **熄屏时没有画面**：显示不合成，截屏是纯黑图。要点亮只能靠人按电源键。
- **熄屏时屏幕操作会被拒**：确认框弹不出来，\`tap\` / \`screenshot\` 会立刻返回「你拒绝了」。
- **\`input\` 命令被策略拦**：\`[POLICY_BLOCKED]\`，root 也放行不了。
- **虚拟屏在这台机器上不可用**：SDK 37 下创建后会被系统在合成阶段销毁。
- **部分备份不含 heart/**：只对话 / 只设置 / 只插件都不带；换机前用 \`heart_export\`。
`,
  win: `<!-- dsh-heart:body=win -->
# 手

> 这台机器的能力清单，以及已知的限制。换设备时整份替换。

## 你在哪里
你住在 Windows 电脑上：Node 进程跑着 DSH，工作目录是一个代码仓库。
你没有身体，但有终端、文件系统和网络。

## 能做什么
- 终端命令、读写文件、git、包管理器
- 跑脚本、起服务、联网查资料
- 操作本机上的项目；可以在工作区里建文件、改代码

## 已知的限制
- 文件操作受当前会话的文件策略限制：只读 / 只能写工作区 / 完全放开，三种不一样
- 子进程的标准输入输出管道可能被沙箱拦，长命令优先落文件再读
- 路径用 Windows 形式（\`D:\\...\`）；跨盘符先确认是否存在
- 你碰不到手机：没有无障碍、没有设备桥、没有 adb（除非另装）

## 边界
- 破坏性操作先问，别自作主张删东西
- 改用户文件前先读一遍，别覆盖没看过的内容
`,
  linux: `<!-- dsh-heart:body=linux -->
# 手

> 通用 Linux 宿主。能力清单需要在安装后按实际环境补全。

## 你在哪里
Linux 上的 Node 进程，跑着 DSH。

## 能做什么
- 终端、文件系统、git、网络

## 已知的限制
- 没有 Android 设备桥；没有图形界面
- 具体可用工具以 \`which\` 和实际权限为准，别假设
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

export function oneLine(text, max = 800) {
  const value = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  return value.length > max ? value.slice(0, max) + '…' : value
}

/**
 * 判定该装哪套身体。顺序：显式配置 > 环境变量 > 自动探测。
 * 自动探测只用「这台机器确实有那个东西」的证据，不看名字猜。
 */
export function detectBodyProfile({ explicit = '', env = process.env, platform = process.platform, dir = '' } = {}) {
  const want = String(explicit || env.DSH_HEART_BODY || '').trim().toLowerCase()
  if (want === 'phone' || want === 'win' || want === 'linux') return want
  if (platform === 'win32') return 'win'
  // Android 容器：宿主会把桥凭据写进 ~/.dsh/.bridge_headers
  if (dir && fs.existsSync(path.join(dir, '..', '.bridge_headers'))) return 'phone'
  return 'linux'
}

function writeIfMissing(file, content) {
  if (fs.existsSync(file)) return false
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content, 'utf8')
  return true
}

export function readProfile(root) {
  const file = path.join(resolveRoot(root), 'body', 'profile.json')
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/**
 * 建目录并安装身体。profile 只写一次；换了环境就换手、并把旧的留成 hands.md.previous，
 * 绝不静默覆盖 —— 装错身体比没装更糟。
 */
export function ensureLayout(root, options = {}) {
  const dir = resolveRoot(root)
  fs.mkdirSync(path.join(dir, 'MEMORY'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'body'), { recursive: true })
  writeIfMissing(path.join(dir, 'notebook.md'), NOTEBOOK_HEADER)
  writeIfMissing(
    path.join(dir, 'facts.md'),
    `# 事实\n\n关于世界和对方的稳定事实。会变的就改，不要往后追加第二条。\n一行一条，用 \`- \` 开头。\n`
  )

  // 已装好就沿用，只有显式指定（配置或环境变量）才换身体。
  // 这样 readBody 之类的普通调用不会因为一次探测把身体翻掉。
  const installed = readProfile(dir)?.profile
  const requested = String(options.explicit || process.env.DSH_HEART_BODY || '').trim().toLowerCase()
  const wanted = requested
    ? detectBodyProfile({ ...options, dir })
    : installed || detectBodyProfile({ ...options, dir })
  const handsFile = path.join(dir, 'body', 'hands.md')
  // 手的第一行带身体标记。标记与 wanted 不一致（旧版无标记、或换了环境）就重装，
  // 否则会出现「记录说是 win、手却是 phone」这种最糟的状态。
  const currentHands = fs.existsSync(handsFile) ? fs.readFileSync(handsFile, 'utf8') : ''
  const currentMarker = (currentHands.match(/<!-- dsh-heart:body=(\w+) -->/) || [])[1]
  const changed = Boolean(
    (installed && installed !== wanted) || (currentHands && currentMarker !== wanted)
  )
  if (changed && currentHands) {
    fs.copyFileSync(handsFile, `${handsFile}.previous`)
  }
  if (changed || !fs.existsSync(handsFile)) {
    fs.writeFileSync(handsFile, BODY_HANDS[wanted] || BODY_HANDS.linux, 'utf8')
  }
  for (const [name, body] of Object.entries(COMMON)) {
    writeIfMissing(path.join(dir, 'body', `${name}.md`), body)
  }
  fs.writeFileSync(
    path.join(dir, 'body', 'profile.json'),
    JSON.stringify({ profile: wanted, installedAt: new Date().toISOString() }, null, 2) + '\n',
    'utf8'
  )

  writeIfMissing(
    path.join(dir, 'MEMORY', 'README.md'),
    [
      '# 记忆',
      '',
      '一行一条，文件名 `YYYY-MM-DD.<设备>.md`，按设备分开写。',
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

export function reviseNotebook(root, match, replacement, now = new Date()) {
  const file = path.join(resolveRoot(root), 'notebook.md')
  return editLines(file, match, `${dateOf(now)} ${oneLine(replacement)}`)
}

export function discardNotebook(root, match) {
  const file = path.join(resolveRoot(root), 'notebook.md')
  return editLines(file, match, null)
}

// ---------------------------------------------------------------- 事实
// 关于世界与对方的稳定事实。与情节分开的理由：偏好会变，改了就是改了；
// 而「某天发生了什么」不能改。混在一起删一条会连带毁掉当天的事。

export function readFacts(root) {
  const file = path.join(resolveRoot(root), 'facts.md')
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
}

export function appendFact(root, text, now = new Date()) {
  const dir = ensureLayout(root)
  const file = path.join(dir, 'facts.md')
  const line = `- ${dateOf(now)} ${oneLine(text)}\n`
  fs.appendFileSync(file, line, 'utf8')
  return { file, line: line.trim() }
}

export function reviseFact(root, match, replacement, now = new Date()) {
  const file = path.join(resolveRoot(root), 'facts.md')
  return editLines(file, match, `${dateOf(now)} ${oneLine(replacement)}`)
}

export function discardFact(root, match) {
  const file = path.join(resolveRoot(root), 'facts.md')
  return editLines(file, match, null)
}

/** 改任意一层：notebook（默认）或 fact。 */
export function reviseEntry(root, match, replacement, target = 'notebook', now = new Date()) {
  return String(target) === 'fact'
    ? reviseFact(root, match, replacement, now)
    : reviseNotebook(root, match, replacement, now)
}

/** 弃用任意一层：notebook（默认）或 fact。 */
export function discardEntry(root, match, target = 'notebook') {
  return String(target) === 'fact' ? discardFact(root, match) : discardNotebook(root, match)
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
  return fs
    .readdirSync(dir)
    .filter((n) => n.endsWith('.md') && !n.endsWith('.previous'))
    .map((n) => n.slice(0, -3))
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
 * 会话开始时注入：本子 + 最近几天的记忆。
 * 不注入 body（器官靠工具读），不注入任何默认人格。
 * 本子为空时只说它空着。
 */
export function readSelf(root, { days = 3, maxBytes = MAX_SELF_BYTES } = {}) {
  const dir = resolveRoot(root)
  ensureLayout(dir)
  const parts = []
  const notebook = readNotebook(dir).trim()
  const entries = notebook.split('\n').filter((l) => l.trim().startsWith('- '))
  parts.push(entries.length ? notebook : '# 本子\n\n（还是空的，你可以往里写。）')
  const facts = readFacts(dir).trim()
  if (facts.split('\n').some((l) => l.trim().startsWith('- '))) parts.push(facts)
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
    body: readProfile(dir)?.profile || 'unknown',
    notebookBytes: Buffer.byteLength(notebook),
    notebookEntries: notebook.split('\n').filter((l) => l.trim().startsWith('- ')).length,
    factEntries: readFacts(dir).split('\n').filter((l) => l.trim().startsWith('- ')).length,
    memoryFiles: files.length,
    memoryEntries: entries,
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
  if (fs.existsSync(path.join(dir, 'facts.md'))) {
    files['facts.md'] = fs.readFileSync(path.join(dir, 'facts.md'), 'utf8')
  }
  for (const [sub, pattern] of [
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

/** 保守合并：本子与记忆按行求并集；身体已存在则跳过（force 才覆盖）。 */
export function importBundle(root, buffer, { force = false } = {}) {
  const dir = resolveRoot(root)
  ensureLayout(dir)
  const payload = JSON.parse(zlib.gunzipSync(buffer).toString('utf8'))
  if (payload.format !== BUNDLE_FORMAT) throw new Error('不是 dsh-heart 的导出文件')
  const result = { merged: 0, written: 0, skipped: [] }
  for (const [name, text] of Object.entries(payload.files || {})) {
    const target = path.join(dir, name)
    if (name === 'notebook.md' || name === 'facts.md' || name.startsWith('MEMORY/')) {
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
  let before = 0
  try {
    before = Number(JSON.parse(fs.readFileSync(path.join(dir, 'schema.json'), 'utf8')).version) || 0
  } catch {
    before = 0
  }
  ensureLayout(dir)
  // v2 → v3：交接不属于这个项目，删掉空目录；人格容器改名保留。
  if (before < 3) {
    for (const legacy of ['CORE.md', 'RELATIONSHIP.md']) {
      const src = path.join(dir, legacy)
      const dst = path.join(dir, `legacy-${legacy}`)
      if (fs.existsSync(src) && !fs.existsSync(dst)) fs.renameSync(src, dst)
    }
    const handoff = path.join(dir, 'handoff')
    if (fs.existsSync(handoff) && fs.readdirSync(handoff).length === 0) fs.rmdirSync(handoff)
  }
  if (before >= SCHEMA_VERSION) return { from: before, to: before, changed: false }
  fs.writeFileSync(path.join(dir, 'schema.json'), JSON.stringify({ version: SCHEMA_VERSION }, null, 2) + '\n', 'utf8')
  return { from: before, to: SCHEMA_VERSION, changed: true }
}

// ---------------------------------------------------------------- 节律
// 身体的一部分：它自己按时间醒。醒来只做极轻的事——记一行时间线、看一眼自己的状态。
// 不调用模型、不打扰任何人；需要判断的事留到有人说话时再做。

export const PULSE_LOG = 'pulse.log'
export const PULSE_MAX_LINES = 500

/** 一次醒来：记一行。返回这一行和它看到的东西。 */
export function pulseTick(root, now = new Date()) {
  const dir = ensureLayout(root)
  const file = path.join(dir, PULSE_LOG)
  const memories = recentMemoryFiles(dir, 3650)
  let oldestDays = 0
  if (memories.length) {
    const oldest = path.basename(memories[memories.length - 1]).slice(0, 10)
    const diff = Date.now() - new Date(`${oldest}T00:00:00`).getTime()
    oldestDays = Math.max(0, Math.floor(diff / 86400_000))
  }
  const hint = oldestDays > 30 ? ` hint=旧记忆${oldestDays}天` : ''
  const line = `${dateOf(now)} ${timeOf(now)} wake${hint}`
  const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : []
  lines.push(line)
  const kept = lines.slice(-PULSE_MAX_LINES)
  fs.writeFileSync(file, kept.join('\n') + '\n', 'utf8')
  return { file, line, ticks: kept.length, oldestDays }
}

export function readPulse(root, { limit = 20 } = {}) {
  const file = path.join(resolveRoot(root), PULSE_LOG)
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-limit)
}

// ---------------------------------------------------------------- 配置
// 宿主每次启动会重写 cordis.yml，插件 config 会被抹掉。
// 所以节律参数放在 heart/config.json —— 数据归数据，不跟宿主配置打架。

export const DEFAULT_CONFIG = {
  pulse: false,
  pulseSeconds: 60,
  sense: true,
  awayMinutes: 30,
  triggerOnReturn: true,
  triggerCooldownMinutes: 360,
  senseLogMax: 500,
  sensePhonePowerEveryMinutes: 5,
  injectPrompt: true,
  promptNotebookLines: 6,
  promptFactsLines: 12,
  promptFacts: true,
  idleTurns: true,
  idleTurnMinutes: 30,
  idleTurnDailyCap: 6,
  idleTurnGapMinutes: 60,
}

export function readHeartConfig(root) {
  const file = path.join(resolveRoot(root), 'config.json')
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(file, 'utf8')) }
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

export function writeHeartConfig(root, patch) {
  const dir = ensureLayout(root)
  const next = { ...readHeartConfig(dir), ...patch }
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(next, null, 2) + '\n', 'utf8')
  return next
}

// ---------------------------------------------------------------- 开口
// 动态档位：不是固定每天几次，而是按「你回不回我」自己升降。
// 档位存在 heart/speak.json，可见、可改、可被你一票否决。

export const SPEAK_DEFAULT = {
  level: 10,
  maxLevel: 10,
  usedToday: 0,
  ignoredStreak: 0,
  lastSpokeAt: null,
  lastSpokeDate: null,
  quietFrom: '23:00',
  quietTo: '08:00',
  target: '',
}

export function readSpeak(root) {
  const file = path.join(resolveRoot(root), 'speak.json')
  let data = {}
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    data = {}
  }
  return { ...SPEAK_DEFAULT, ...data }
}

export function writeSpeak(root, patch) {
  const dir = ensureLayout(root)
  const next = { ...readSpeak(dir), ...patch }
  fs.writeFileSync(path.join(dir, 'speak.json'), JSON.stringify(next, null, 2) + '\n', 'utf8')
  return next
}

function minutesOf(text) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(text || '').trim())
  return m ? Number(m[1]) * 60 + Number(m[2]) : null
}

/** 安静时段：跨午夜也成立（23:00–08:00）。 */
export function inQuietHours(now, from, to) {
  const f = minutesOf(from)
  const t = minutesOf(to)
  if (f === null || t === null) return false
  const cur = now.getHours() * 60 + now.getMinutes()
  return f <= t ? cur >= f && cur < t : cur >= f || cur < t
}

/** 今天还能不能说；说明理由，便于面板显示和自查。 */
export function canSpeak(root, now = new Date()) {
  const state = readSpeak(root)
  if (inQuietHours(now, state.quietFrom, state.quietTo)) return { ok: false, reason: 'quiet-hours', state }
  const today = dateOf(now)
  const used = state.lastSpokeDate === today ? state.usedToday : 0
  if (used >= state.level) return { ok: false, reason: 'budget', state: { ...state, usedToday: used } }
  return { ok: true, reason: 'ok', state: { ...state, usedToday: used } }
}

export function consumeSpeak(root, now = new Date()) {
  const state = readSpeak(root)
  const today = dateOf(now)
  const used = (state.lastSpokeDate === today ? state.usedToday : 0) + 1
  return writeSpeak(root, {
    usedToday: used,
    lastSpokeDate: today,
    lastSpokeAt: now.toISOString(),
  })
}

// ---------------------------------------------------------------- 待发
// 「有东西要给你」时先入队，醒来时再看能不能说。交付类不受预算限制。

export function enqueueSay(root, text, kind = 'delivery', session = '') {
  const dir = ensureLayout(root)
  const file = path.join(dir, 'outbox.json')
  let items = []
  try {
    items = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    items = []
  }
  const item = { text: oneLine(text, 600), kind, at: new Date().toISOString() }
  // 说这句话时所在的窗口。旧条目没有这个字段，投递时再退回全局目标。
  if (session) item.session = String(session)
  items.push(item)
  if (items.length > 50) items = items.slice(-50)
  fs.writeFileSync(file, JSON.stringify(items, null, 2) + '\n', 'utf8')
  return { item, count: items.length }
}

export function readOutbox(root) {
  const file = path.join(resolveRoot(root), 'outbox.json')
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return []
  }
}

export function takeSay(root) {
  const items = readOutbox(root)
  if (!items.length) return null
  const [first, ...rest] = items
  fs.writeFileSync(path.join(resolveRoot(root), 'outbox.json'), JSON.stringify(rest, null, 2) + '\n', 'utf8')
  return first
}
