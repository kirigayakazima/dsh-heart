// dsh-heart 的插件入口（host 半边）。
// 只做注册：真正的读写逻辑在 ./store.js，保持零 DSH 依赖，方便单测和 CLI 复用。
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import fs from 'node:fs'
import {
  appendMemory,
  appendRelationship,
  dateOf,
  ensureLayout,
  exportBundleToFile,
  importBundle,
  migrate,
  readCore,
  recall,
  resolveRoot,
  stats,
} from './store.js'

export const name = 'dsh-heart'

/** 只注入工具注册表，不碰会话、模型或设备能力。 */
export const inject = ['tools']

export const Config = z.object({
  /** 数据目录；留空 = ~/.dsh/heart。数据永远在插件包之外。 */
  root: z.string().default(''),
  /** 本设备标识，写进每条记忆的 [device] 标记，如 pc / phone。 */
  device: z.string().default(''),
})

const textOutput = (pick) => ({
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: { message: { type: 'string', required: true } },
  },
  render: (_args, value) => [{ type: 'text', text: pick ? pick(value) : value.message }],
})

export function apply(ctx, config) {
  const root = resolveRoot(config.root)
  const device = String(config.device || process.env.DSH_HEART_DEVICE || 'agent').trim() || 'agent'

  // 首次加载时建目录、补齐 schema，并跑一次数据迁移。
  ctx.effect(() => {
    ensureLayout(root, device)
    migrate(root)
  })

  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: 'heart_write',
        description:
          '往「心」里追加一条记忆。只写值得记住的：用户的偏好、做过的决定、约定、重要事件、踩过的坑。不要写日常过程、临时状态或能从文件里重新读到的内容；一次一条，控制在 800 字以内。数据落在本机 ~/.dsh/heart，不随插件包或备份外流。',
        parameters: {
          text: { type: 'string', required: true, description: '要记住的那一件事，一句话说清。' },
          kind: {
            type: 'string',
            required: false,
            description: 'memory = 当天日记（默认）；relationship = 关系史（称呼、约定、雷区、重要时刻）。',
          },
        },
        output: textOutput(),
        async execute(args) {
          const kind = String(args.kind || 'memory')
          if (kind === 'relationship') {
            const out = appendRelationship(root, device, args.text)
            return { message: `已写入关系史 ${out.file}\n${out.line}` }
          }
          const out = appendMemory(root, device, args.text)
          return { message: `已写入记忆 ${out.file}\n${out.line}` }
        },
      })
    )
  )

  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: 'heart_recall',
        description:
          '按关键词检索「心」里的记忆。不确定过去发生过什么、或用户提到"上次""之前"时用它，而不是凭印象回答。返回按时间倒序的匹配行，带日期与来源设备标记。',
        parameters: {
          query: { type: 'string', required: true, description: '关键词，大小写不敏感；留空则返回最近记录。' },
          days: {
            type: 'number',
            required: false,
            description: '往前检索多少天，默认 30。',
          },
        },
        output: textOutput(),
        async execute(args) {
          const result = recall(root, args.query, { days: Number(args.days) || 30 })
          if (!result.count) return { message: `没有匹配「${result.query}」的记忆。` }
          return { message: result.text }
        },
      })
    )
  )

  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: 'heart_core',
        description:
          '读取「心」的当前全貌：自我描述 + 关系史 + 最近几天的记忆（有字节上限）。会话开始或需要确认"我是谁、我们之间有什么约定"时调用。',
        parameters: {
          days: { type: 'number', required: false, description: '带最近几天的记忆，默认 3。' },
        },
        output: textOutput(),
        async execute(args) {
          const body = readCore(root, { days: Number(args.days) || 3 })
          return { message: body || '（心还是空的：先写 CORE.md）' }
        },
      })
    )
  )

  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: 'heart_stats',
        description: '看「心」的规模：目录、记忆文件数、条目数、CORE.md 字节数。用来判断是不是该整理了。',
        parameters: {},
        output: textOutput(),
        async execute() {
          return { message: JSON.stringify(stats(root), null, 2) }
        },
      })
    )
  )

  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: 'heart_export',
        description:
          '把「心」打包成一个自包含的 .json.gz 文件（CORE + 关系史 + 全部记忆），方便用户保存、换设备或交给宿主备份。注意：DSHA 的全量备份（整个 .dsh）本来就包含 heart/，但「只对话 / 只设置 / 只插件」三种部分备份不包含，插件导出也不含数据 —— 换机或卸载重装前用它兜底。',
        parameters: {
          path: {
            type: 'string',
            required: false,
            description: '导出路径；留空 = 当前目录 heart-export-<日期>.json.gz。手机上建议放到 /sdcard 或 Download。',
          },
        },
        output: textOutput(),
        async execute(args) {
          const file = String(args.path || '').trim() || `heart-export-${dateOf()}.json.gz`
          const out = exportBundleToFile(root, file)
          return { message: `已导出 ${out.file}（${out.bytes} 字节）` }
        },
      })
    )
  )

  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: 'heart_import',
        description:
          '把 heart_export 产出的文件合并回本机：记忆按行求并集（不丢、不重复），CORE.md 与关系史已存在则跳过、不覆盖本机写的心。换设备或恢复后用。',
        parameters: {
          path: { type: 'string', required: true, description: '要导入的 .json.gz 路径。' },
        },
        output: textOutput(),
        async execute(args) {
          const file = String(args.path || '').trim()
          if (!file) return { message: '需要提供文件路径' }
          const result = importBundle(root, fs.readFileSync(file))
          return { message: JSON.stringify(result, null, 2) }
        },
      })
    )
  )
}
