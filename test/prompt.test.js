import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildVoiceSection, buildSelfSection, buildPromptBundle } from '../lib/prompt.js'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'heart-prompt-test-'))

function write(root, rel, text) {
  const file = path.join(root, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text, 'utf8')
}

function seedBody(root) {
  // 先占位：ensureLayout 只在文件缺失时装默认身体，空文件也是“存在”。
  write(root, 'body/voice.md', '')
  write(root, 'body/senses.md', '')
}

test('buildVoiceSection：读嘴和耳朵；空文件返回空串', () => {
  const root = tmp()
  seedBody(root)
  assert.equal(buildVoiceSection(root), '')

  write(root, 'body/voice.md', '# 嘴\n\n- 一句说完\n- 先给结论\n')
  write(root, 'body/senses.md', '# 耳\n\n- 不问就不展开\n')
  const text = buildVoiceSection(root)
  assert.ok(text.includes('一句说完'))
  assert.ok(text.includes('先给结论'))
  assert.ok(text.includes('不问就不展开'))
  assert.ok(text.includes('你自己的嘴和耳朵'))
})

test('buildSelfSection：本子取最近 N 条，事实可关，空则空串', () => {
  const root = tmp()
  write(
    root,
    'notebook.md',
    '# 本子\n\n' + Array.from({ length: 10 }, (_, i) => `- 2026-10-2${i % 9} 第 ${i + 1} 条`).join('\n') + '\n'
  )
  write(
    root,
    'facts.md',
    '# 事实\n\n' + Array.from({ length: 20 }, (_, i) => `- 事实 ${i + 1}`).join('\n') + '\n'
  )

  const text = buildSelfSection(root, { promptNotebookLines: 3, promptFactsLines: 4 })
  assert.ok(text.includes('第 8 条'))
  assert.ok(text.includes('第 10 条'))
  assert.ok(!text.includes('第 7 条'))
  assert.ok(text.includes('事实 20'))
  assert.ok(text.includes('事实 17'))
  assert.ok(!text.includes('事实 16'))

  const noFacts = buildSelfSection(root, { promptNotebookLines: 2, promptFacts: false })
  assert.ok(noFacts.includes('第 10 条'))
  assert.ok(!noFacts.includes('事实'))

  const emptyRoot = tmp()
  write(emptyRoot, 'notebook.md', '# 本子\n\n')
  write(emptyRoot, 'facts.md', '# 事实\n\n')
  assert.equal(buildSelfSection(emptyRoot), '')
})

test('buildPromptBundle：两节一起返回', () => {
  const root = tmp()
  seedBody(root)
  write(root, 'body/voice.md', '- 短句\n')
  write(root, 'notebook.md', '# 本子\n\n- 一条\n')
  write(root, 'facts.md', '# 事实\n\n- 一件\n')
  const bundle = buildPromptBundle(root, { promptNotebookLines: 3 })
  assert.ok(bundle.voice.includes('短句'))
  assert.ok(bundle.self.includes('一条'))
  assert.ok(bundle.self.includes('一件'))
})
