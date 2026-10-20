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
  discardNotebook,
  exportBundle,
  exportBundleToFile,
  importBundle,
  latestHandoff,
  listHandoffs,
  migrate,
  oneLine,
  readBody,
  readSelf,
  recall,
  reviseNotebook,
  safeDevice,
  SCHEMA_VERSION,
  stats,
  writeHandoff,
} from '../lib/store.js'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'heart-test-'))

test('首次布局：本子是空的，器官已装好', () => {
  const root = tmp()
  const s = stats(root)
  assert.equal(s.notebookEntries, 0)
  assert.deepEqual(s.organs.sort(), ['hands', 'senses', 'voice'])
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'schema.json'), 'utf8')).version, SCHEMA_VERSION)
})

test('本子：可写、可改、可弃用', () => {
  const root = tmp()
  appendNotebook(root, '说话前先想清楚再说')
  let s = stats(root)
  assert.equal(s.notebookEntries, 1)

  reviseNotebook(root, '说话前先想清楚', '说话前先想清楚，但别想太久')
  const text = fs.readFileSync(path.join(root, 'notebook.md'), 'utf8')
  assert.match(text, /但别想太久/)

  discardNotebook(root, '但别想太久')
  s = stats(root)
  assert.equal(s.notebookEntries, 0)
})

test('记忆按 日期.设备 分文件，两台设备互不覆盖', () => {
  const root = tmp()
  const a = appendMemory(root, 'pc', '第一条')
  const b = appendMemory(root, 'phone', '第二条')
  assert.notEqual(a.file, b.file)
  assert.ok(a.file.endsWith(`${dateOf()}.pc.md`))
  assert.match(a.line, /^- \d{2}:\d{2} \[pc\] 第一条$/)
})

test('检索命中关键词；关系史已并入记忆，不再单独存在', () => {
  const root = tmp()
  appendMemory(root, 'pc', '用户偏好：回复要短')
  assert.equal(recall(root, '偏好').count, 1)
  assert.equal(recall(root, '不存在').count, 0)
})

test('交接：能写、能取最近一份', () => {
  const root = tmp()
  writeHandoff(root, 'pc', '这一段时间我们做了心模块')
  writeHandoff(root, 'pc', '第二轮：把身体模块特化到手机')
  assert.equal(listHandoffs(root).length, 2)
  assert.match(latestHandoff(root).text, /身体模块/)
})

test('readSelf：本子为空时只给一句「还是空的」，不补默认内容', () => {
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

test('身体模块默认按手机特化', () => {
  const root = tmp()
  const hands = readBody(root, 'hands')
  assert.match(hands, /住在手机上/)
  assert.match(hands, /熄屏/)
  assert.match(readBody(root, 'voice'), /嘴/)
  assert.match(readBody(root, 'senses'), /耳朵/)
})

test('导出包含本子/交接/器官/记忆，导入按行并集合并', () => {
  const source = tmp()
  appendNotebook(source, '来源设备的想法')
  appendMemory(source, 'phone', '手机上的记忆')
  writeHandoff(source, 'phone', '旧交接')
  const bundle = exportBundle(source)

  const payload = JSON.parse(zlib.gunzipSync(bundle).toString('utf8'))
  assert.equal(payload.format, 'dsh-heart')
  assert.equal(payload.schema, SCHEMA_VERSION)
  assert.ok(payload.files['notebook.md'])
  assert.ok(payload.files['body/hands.md'])
  assert.ok(Object.keys(payload.files).some((k) => k.startsWith('handoff/')))

  const target = tmp()
  appendNotebook(target, '本机的想法')
  const result = importBundle(target, bundle)
  assert.ok(result.merged > 0)
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

test('migrate：v1 的 CORE/RELATIONSHIP 改名为 legacy-，不删数据', () => {
  const root = tmp()
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(path.join(root, 'CORE.md'), '# 旧的人设\n', 'utf8')
  fs.writeFileSync(path.join(root, 'schema.json'), JSON.stringify({ version: 1 }), 'utf8')
  const result = migrate(root)
  assert.equal(result.to, SCHEMA_VERSION)
  assert.ok(fs.existsSync(path.join(root, 'legacy-CORE.md')))
  assert.equal(fs.existsSync(path.join(root, 'CORE.md')), false)
})

test('oneLine 压平换行；设备名限制成安全字符', () => {
  assert.equal(oneLine('a\n\nb\tc'), 'a b c')
  assert.equal(safeDevice('My Phone/1'), 'my-phone-1')
})

test('工具 schema 不使用 required: false（DSH 方言要求省略该键）', () => {
  const src = fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.equal(src.includes('required: false'), false)
})
