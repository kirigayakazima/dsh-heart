// dsh-heart 的 CLI：不装插件也能用。
//   node bin/heart.js core
//   node bin/heart.js write "用户偏好：回复要短"
//   node bin/heart.js recall "偏好"
//   node bin/heart.js stats
//   node bin/heart.js export [文件]    打包成一个自包含文件
//   node bin/heart.js import <文件>    合并回来
import fs from 'node:fs'
import {
  appendMemory,
  dateOf,
  exportBundleToFile,
  importBundle,
  migrate,
  readCore,
  recall,
  resolveRoot,
  stats,
} from '../lib/store.js'

const [cmd, ...rest] = process.argv.slice(2)
const root = process.env.HEART_ROOT || ''
const device = process.env.HEART_DEVICE || 'agent'

function usage() {
  console.error(`用法:
  heart core                 打印要注入上下文的「心」
  heart write <内容>          追加一条记忆
  heart recall <关键词>       检索记忆
  heart stats                看规模
  heart export [文件]         打包（默认 heart-export-<日期>.json.gz）
  heart import <文件>         合并回来（记忆求并集，不覆盖 CORE）
  heart migrate              迁移数据格式

环境变量: HEART_ROOT(默认 ~/.dsh/heart)  HEART_DEVICE(默认 agent)`)
}

try {
  switch (cmd) {
    case 'core':
      console.log(readCore(root))
      break
    case 'write': {
      const text = rest.join(' ').trim()
      if (!text) throw new Error('write 需要内容')
      const out = appendMemory(root, device, text)
      console.log(`已写入 ${out.file}`)
      console.log(out.line)
      break
    }
    case 'recall': {
      const query = rest.join(' ').trim()
      const result = recall(root, query)
      console.log(result.count ? result.text : '（没有匹配的记忆）')
      break
    }
    case 'stats':
      console.log(JSON.stringify(stats(root), null, 2))
      break
    case 'export': {
      const file = rest[0] || `heart-export-${dateOf()}.json.gz`
      const out = exportBundleToFile(root, file)
      console.log(`已导出 ${out.file}（${out.bytes} 字节）`)
      break
    }
    case 'import': {
      const file = rest[0]
      if (!file) throw new Error('import 需要文件路径')
      const result = importBundle(root, fs.readFileSync(file))
      console.log(JSON.stringify(result, null, 2))
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
