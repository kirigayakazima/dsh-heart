import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import {
  appendMemory,
  appendNotebook,
  dateOf,
  detectBodyProfile,
  discardNotebook,
  ensureLayout,
  exportBundle,
  exportBundleToFile,
  importBundle,
  migrate,
  oneLine,
  readBody,
  readProfile,
  readSelf,
  recall,
  reviseNotebook,
  safeDevice,
  SCHEMA_VERSION,
  stats,
} from '../lib/store.js'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'heart-test-'))

test('首次布局：本子是空的，器官装好，身体按宿主判定', () => {
  const root = tmp()
  const s = stats(root)
  assert.equal(s.notebookEntries, 0)
  assert.deepEqual(s.organs.sort(), ['hands', 'senses', 'voice'])
  assert.ok(['win', 'phone', 'linux'].includes(s.body))
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'schema.json'), 'utf8')).version, SCHEMA_VERSION)
})

test('环境判定：显式 > 环境变量 > 自动探测', () => {
  assert.equal(detectBodyProfile({ explicit: 'phone', platform: 'win32' }), 'phone')
  assert.equal(detectBodyProfile({ env: { DSH_HEART_BODY: 'linux' }, platform: 'win32' }), 'linux')
  assert.equal(detectBodyProfile({ env: {}, platform: 'win32' }), 'win')
  // Linux + 宿主写了桥凭据 → 手机容器
  const base = tmp()
  const heart = path.join(base, '.dsh', 'heart')
  fs.mkdirSync(heart, { recursive: true })
  fs.writeFileSync(path.join(base, '.dsh', '.bridge_headers'), 'x', 'utf8')
  assert.equal(detectBodyProfile({ env: {}, platform: 'linux', dir: heart }), 'phone')
  assert.equal(detectBodyProfile({ env: {}, platform: 'linux', dir: tmp() }), 'linux')
})

test('两套身体内容不同，都写明自己住在哪', () => {
  const phone = tmp()
  ensureLayout(phone, { explicit: 'phone' })
  assert.match(readBody(phone, 'hands'), /住在手机上/)
  assert.equal(readProfile(phone).profile, 'phone')

  const win = tmp()
  ensureLayout(win, { explicit: 'win' })
  assert.match(readBody(win, 'hands'), /住在 Windows 电脑上/)
  assert.equal(readProfile(win).profile, 'win')
})

test('换环境不会静默覆盖：旧手保留为 hands.md.previous', () => {
  const root = tmp()
  ensureLayout(root, { explicit: 'phone' })
  ensureLayout(root, { explicit: 'win' })
  assert.match(readBody(root, 'hands'), /Windows/)
  assert.ok(fs.existsSync(path.join(root, 'body', 'hands.md.previous')))
  assert.match(fs.readFileSync(path.join(root, 'body', 'hands.md.previous'), 'utf8'), /手机上/)
})

test('本子：可写、可改、可弃用', () => {
  const root = tmp()
  appendNotebook(root, '说话前先想清楚再说')
  assert.equal(stats(root).notebookEntries, 1)
  reviseNotebook(root, '说话前先想清楚', '说话前先想清楚，但别想太久')
  assert.match(fs.readFileSync(path.join(root, 'notebook.md'), 'utf8'), /别想太久/)
  discardNotebook(root, '别想太久')
  assert.equal(stats(root).notebookEntries, 0)
})

test('记忆按 日期.设备 分文件', () => {
  const root = tmp()
  const a = appendMemory(root, 'pc', '第一条')
  const b = appendMemory(root, 'phone', '第二条')
  assert.notEqual(a.file, b.file)
  assert.ok(a.file.endsWith(`${dateOf()}.pc.md`))
  assert.match(a.line, /^- \d{2}:\d{2} \[pc\] 第一条$/)
})

test('检索命中关键词，不命中返回 0', () => {
  const root = tmp()
  appendMemory(root, 'pc', '用户偏好：回复要短')
  assert.equal(recall(root, '偏好').count, 1)
  assert.equal(recall(root, '不存在').count, 0)
})

test('readSelf：本子为空时只说它空着，不补默认人格', () => {
  const root = tmp()
  const body = readSelf(root)
  assert.match(body, /还是空的/)
  assert.doesNotMatch(body, /你是|你的名字|性格/)
})

test('readSelf：写过的本子与最近记忆都会出现', () => {
  const root = tmp()
  appendNotebook(root, '我自己决定：先给结论')
  appendMemory(root, 'pc', '今天把插件重建了')
  const body = readSelf(root)
  assert.match(body, /先给结论/)
  assert.match(body, /今天把插件重建了/)
})

test('导出包含本子/器官/记忆，导入按行并集合并', () => {
  const source = tmp()
  appendNotebook(source, '来源设备的想法')
  appendMemory(source, 'phone', '手机上的记忆')
  const payload = JSON.parse(zlib.gunzipSync(exportBundle(source)).toString('utf8'))
  assert.equal(payload.format, 'dsh-heart')
  assert.equal(payload.schema, SCHEMA_VERSION)
  assert.ok(payload.files['notebook.md'])
  assert.ok(payload.files['body/hands.md'])
  assert.equal(Object.keys(payload.files).some((k) => k.startsWith('handoff/')), false)

  const target = tmp()
  appendNotebook(target, '本机的想法')
  importBundle(target, exportBundle(source))
  const notebook = fs.readFileSync(path.join(target, 'notebook.md'), 'utf8')
  assert.match(notebook, /本机的想法/)
  assert.match(notebook, /来源设备的想法/)
})

test('导出文件可落盘并重新导入', () => {
  const root = tmp()
  appendNotebook(root, '往返测试')
  const out = exportBundleToFile(root, path.join(root, 'dump.json.gz'))
  assert.ok(out.bytes > 0)
  const again = tmp()
  importBundle(again, fs.readFileSync(out.file))
  assert.match(readSelf(again), /往返测试/)
})

test('migrate：v2 的 CORE/RELATIONSHIP 改名保留，空 handoff 目录清掉', () => {
  const root = tmp()
  fs.mkdirSync(path.join(root, 'handoff'), { recursive: true })
  fs.writeFileSync(path.join(root, 'CORE.md'), '# 旧的人设\n', 'utf8')
  fs.writeFileSync(path.join(root, 'schema.json'), JSON.stringify({ version: 2 }), 'utf8')
  const result = migrate(root)
  assert.equal(result.to, SCHEMA_VERSION)
  assert.ok(fs.existsSync(path.join(root, 'legacy-CORE.md')))
  assert.equal(fs.existsSync(path.join(root, 'CORE.md')), false)
  assert.equal(fs.existsSync(path.join(root, 'handoff')), false)
})

test('oneLine 压平换行；设备名限制成安全字符', () => {
  assert.equal(oneLine('a\n\nb\tc'), 'a b c')
  assert.equal(safeDevice('My Phone/1'), 'my-phone-1')
})

test('工具 schema 不使用 required: false（DSH 方言要求省略该键）', () => {
  const src = fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.equal(src.includes('required: false'), false)
})

test('旧版遗留的 hands.md（无身体标记）会被重装并保留 previous', () => {
  const root = tmp()
  fs.mkdirSync(path.join(root, 'body'), { recursive: true })
  fs.writeFileSync(path.join(root, 'body', 'hands.md'), '# 手\n\n住在手机上\n', 'utf8')
  ensureLayout(root, { explicit: 'win' })
  assert.match(readBody(root, 'hands'), /Windows/)
  assert.ok(fs.existsSync(path.join(root, 'body', 'hands.md.previous')))
  assert.match(fs.readFileSync(path.join(root, 'body', 'hands.md.previous'), 'utf8'), /手机上/)
})
