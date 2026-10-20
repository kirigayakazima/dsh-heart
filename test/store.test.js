import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import {
  appendMemory,
  appendRelationship,
  dateOf,
  exportBundle,
  exportBundleToFile,
  importBundle,
  migrate,
  oneLine,
  readCore,
  recall,
  safeDevice,
  SCHEMA_VERSION,
  stats,
} from '../lib/store.js'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'heart-test-'))

test('记忆按 日期.设备 分文件，两台设备互不覆盖', () => {
  const root = tmp()
  const a = appendMemory(root, 'pc', '第一条')
  const b = appendMemory(root, 'phone', '第二条')
  assert.notEqual(a.file, b.file)
  assert.ok(a.file.endsWith(`${dateOf()}.pc.md`))
  assert.ok(b.file.endsWith(`${dateOf()}.phone.md`))
  assert.match(a.line, /^- \d{2}:\d{2} \[pc\] 第一条$/)
})

test('同一文件内追加，不覆盖旧内容', () => {
  const root = tmp()
  appendMemory(root, 'pc', 'A')
  appendMemory(root, 'pc', 'B')
  const body = fs.readFileSync(path.join(root, 'MEMORY', `${dateOf()}.pc.md`), 'utf8')
  assert.equal(body.split('\n').filter(Boolean).length, 2)
})

test('检索：命中关键词、结果带日期前缀、无匹配时返回 0', () => {
  const root = tmp()
  appendMemory(root, 'pc', '用户偏好：回复要短')
  appendMemory(root, 'pc', '无关内容')
  const hit = recall(root, '偏好')
  assert.equal(hit.count, 1)
  assert.match(hit.text, /\.pc - \d{2}:\d{2} \[pc\] 用户偏好/)
  assert.equal(recall(root, '不存在的词').count, 0)
})

test('oneLine 压平换行并按上限截断', () => {
  assert.equal(oneLine('a\n\nb\tc'), 'a b c')
  assert.equal(oneLine('x'.repeat(20), 10).length, 11) // 10 + 省略号
})

test('设备名被限制成安全字符', () => {
  assert.equal(safeDevice('My Phone/1'), 'my-phone-1')
  assert.equal(safeDevice(''), 'agent')
})

test('core 注入包含自我、关系与最近记忆，且遵守字节上限', () => {
  const root = tmp()
  appendMemory(root, 'pc', '今天做了插件骨架')
  appendRelationship(root, 'pc', '称呼：清羽')
  const body = readCore(root, { days: 3 })
  assert.match(body, /我是谁/)
  assert.match(body, /称呼：清羽/)
  assert.match(body, /今天做了插件骨架/)
  const tiny = readCore(root, { days: 3, maxBytes: 50 })
  assert.ok(Buffer.byteLength(tiny) < 120)
})

test('migrate 补齐 schema 并可重复调用', () => {
  const root = tmp()
  const first = migrate(root)
  assert.equal(first.to, SCHEMA_VERSION)
  const second = migrate(root)
  assert.equal(second.changed, false)
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'schema.json'), 'utf8')).version, SCHEMA_VERSION)
})

test('stats 统计条目数', () => {
  const root = tmp()
  appendMemory(root, 'pc', '1')
  appendMemory(root, 'phone', '2')
  const s = stats(root)
  assert.equal(s.entries, 2)
  assert.equal(s.files, 2)
})

test('导出是可解压的自包含包，含 CORE/关系/记忆', () => {
  const root = tmp()
  appendMemory(root, 'pc', '导出测试')
  appendRelationship(root, 'pc', '约定：称呼清羽')
  const bundle = exportBundle(root)
  const payload = JSON.parse(zlib.gunzipSync(bundle).toString('utf8'))
  assert.equal(payload.format, 'dsh-heart')
  assert.ok(payload.files['CORE.md'])
  assert.ok(payload.files['RELATIONSHIP.md'])
  const memKey = Object.keys(payload.files).find((k) => k.startsWith('MEMORY/'))
  assert.ok(memKey)
  assert.match(payload.files[memKey], /导出测试/)
})

test('导入按行求并集：不丢本机行、不重复、不覆盖 CORE', () => {
  const source = tmp()
  appendMemory(source, 'phone', '手机上的记忆')
  const bundle = exportBundle(source)

  const target = tmp()
  appendMemory(target, 'pc', '电脑上的记忆')
  fs.writeFileSync(path.join(target, 'CORE.md'), '# 本机的心\n', 'utf8')

  const result = importBundle(target, bundle)
  assert.equal(result.skipped.includes('CORE.md'), true)

  const all = fs
    .readdirSync(path.join(target, 'MEMORY'))
    .filter((n) => n.endsWith('.md') && n !== 'README.md')
    .map((n) => fs.readFileSync(path.join(target, 'MEMORY', n), 'utf8'))
    .join('\n')
  assert.match(all, /电脑上的记忆/)
  assert.match(all, /手机上的记忆/)
  assert.equal(fs.readFileSync(path.join(target, 'CORE.md'), 'utf8').trim(), '# 本机的心')

  // 二次导入不产生重复行
  importBundle(target, bundle)
  const lines = all.split('\n').filter((l) => l.trim().startsWith('- '))
  for (const line of lines) {
    assert.equal(all.split(line).length - 1, 1, `重复行: ${line}`)
  }
})

test('force 导入才会覆盖 CORE', () => {
  const source = tmp()
  fs.writeFileSync(path.join(source, 'CORE.md'), '# 别人的心\n', 'utf8')
  const bundle = exportBundle(source)
  const target = tmp()
  fs.writeFileSync(path.join(target, 'CORE.md'), '# 我的心\n', 'utf8')
  importBundle(target, bundle, { force: true })
  assert.equal(fs.readFileSync(path.join(target, 'CORE.md'), 'utf8').trim(), '# 别人的心')
})

test('导出的文件能被 exportBundleToFile 落盘并重新导入', () => {
  const root = tmp()
  appendMemory(root, 'pc', '往返测试')
  const out = exportBundleToFile(root, path.join(root, 'dump.json.gz'))
  assert.ok(out.bytes > 0)
  const again = tmp()
  const result = importBundle(again, fs.readFileSync(out.file))
  assert.ok(result.memoryFiles >= 1)
  assert.match(readCore(again), /往返测试/)
})
