// 把「心」里她自己写的内容，压成每轮自动进系统提示的两节。
//
// 边界：只读她写下的文件，不生成任何默认人格。空文件就返回空字符串，
// 由 systemPrompt 的 section 机制丢弃空节。
import { readBody, readFacts, readNotebook } from './store.js'

const BULLET = /^\s*-\s+/

function bulletLines(text) {
  return String(text || '')
    .split('\n')
    .filter((line) => BULLET.test(line))
    .map((line) => line.trim())
}

/** 嘴 + 耳朵：她说话的方式、什么时候闭嘴。 */
export function buildVoiceSection(root) {
  const voice = String(readBody(root, 'voice') || '').trim()
  const senses = String(readBody(root, 'senses') || '').trim()
  if (!voice && !senses) return ''
  const parts = []
  if (voice) parts.push(voice)
  if (senses) parts.push(senses)
  return `以下是你自己的嘴和耳朵（不是别人给你的设定）：\n${parts.join('\n\n')}`
}

/** 本子最近几条 + 事实：她自己的判断与对世界的记忆。 */
export function buildSelfSection(root, config = {}) {
  const notebookLimit = Math.max(0, Number(config.promptNotebookLines ?? 6))
  const factsLimit = Math.max(0, Number(config.promptFactsLines ?? 12))
  const notebook = bulletLines(readNotebook(root)).slice(-notebookLimit)
  const facts =
    config.promptFacts === false ? [] : bulletLines(readFacts(root)).slice(-factsLimit)
  if (!notebook.length && !facts.length) return ''

  const parts = []
  if (notebook.length) parts.push('本子（最近写下的）：\n' + notebook.join('\n'))
  if (facts.length) parts.push('事实：\n' + facts.join('\n'))
  return `以下是你自己写下的（不是系统设定；要更多用 heart_self / heart_recall）：\n${parts.join('\n\n')}`
}

/** 两节一起取；给工具、状态接口和测试用。 */
export function buildPromptBundle(root, config = {}) {
  return {
    voice: buildVoiceSection(root),
    self: buildSelfSection(root, config),
  }
}
