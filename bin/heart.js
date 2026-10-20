// dsh-heart 的 CLI：不装插件也能用。
//   heart self                    打印「你自己」（本子 + 交接 + 最近记忆）
//   heart write [-k notebook|memory|handoff] <内容>
//   heart revise <原文片段> <改成什么>
//   heart discard <原文片段>
//   heart recall <关键词>
//   heart body [voice|senses|hands]
//   heart stats | export [文件] | import <文件> | migrate
import fs from 'node:fs'
import {
  appendMemory,
  appendNotebook,
  dateOf,
  discardNotebook,
  exportBundleToFile,
  importBundle,
  migrate,
  readBody,
  readSelf,
  recall,
  resolveRoot,
  reviseNotebook,
  stats,
} from '../lib/store.js'

const argv = process.argv.slice(2)
const root = process.env.HEART_ROOT || ''
const device = process.env.HEART_DEVICE || 'agent'

function usage() {
  console.error(`用法:
  heart self                     打印「你自己」
  heart write [-k notebook|memory] <内容>
  heart revise <原文片段> <改成什么>
  heart discard <原文片段>
  heart recall <关键词>
  heart body [voice|senses|hands]
  heart stats | export [文件] | import <文件> | migrate | root

环境变量: HEART_ROOT(默认 ~/.dsh/heart)  HEART_DEVICE(默认 agent)`)
}

let cmd = argv.shift()
let kind = 'notebook'
if (cmd === 'write' && argv[0] === '-k') {
  argv.shift()
  kind = argv.shift() || 'notebook'
}

try {
  switch (cmd) {
    case 'self':
      console.log(readSelf(root))
      break
    case 'write': {
      const text = argv.join(' ').trim()
      if (!text) throw new Error('write 需要内容')
      if (kind === 'memory') {
        const out = appendMemory(root, device, text)
        console.log(`已写入记忆 ${out.file}`)
        console.log(out.line)
      } else {
        const out = appendNotebook(root, text)
        console.log(`已写入本子 ${out.line}`)
      }
      break
    }
    case 'revise': {
      const [match, ...rest] = argv
      if (!match || !rest.length) throw new Error('revise 需要 <原文片段> <改成什么>')
      const result = reviseNotebook(root, match, rest.join(' '))
      console.log(result.changed ? '改好了' : '没找到匹配的那条')
      break
    }
    case 'discard': {
      const match = argv.join(' ').trim()
      if (!match) throw new Error('discard 需要 <原文片段>')
      const result = discardNotebook(root, match)
      console.log(result.changed ? '已弃用' : '没找到匹配的那条')
      break
    }
    case 'recall': {
      const result = recall(root, argv.join(' ').trim())
      console.log(result.count ? result.text : '（没有匹配的记忆）')
      break
    }
    case 'body': {
      const organ = (argv[0] || 'hands').trim()
      console.log(readBody(root, organ) || `没有这个器官：${organ}`)
      break
    }
    case 'stats':
      console.log(JSON.stringify(stats(root), null, 2))
      break
    case 'export': {
      const file = argv[0] || `heart-export-${dateOf()}.json.gz`
      const out = exportBundleToFile(root, file)
      console.log(`已导出 ${out.file}（${out.bytes} 字节）`)
      break
    }
    case 'import': {
      const file = argv[0]
      if (!file) throw new Error('import 需要文件路径')
      console.log(JSON.stringify(importBundle(root, fs.readFileSync(file)), null, 2))
      break
    }
    case 'migrate':
      console.log(JSON.stringify(migrate(root), null, 2))
      break
    case 'root':
      console.log(resolveRoot(root))
      break
    default:
      usage()
      process.exitCode = 2
  }
} catch (error) {
  console.error('heart:', error?.message || error)
  process.exitCode = 1
}
