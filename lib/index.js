// dsh-heart 的插件入口（host 半边）。
// 只做注册：读写逻辑全部在 ./store.js，保持零 DSH 依赖，方便单测和 CLI 复用。
//
// 设计边界（重要，改代码前先读）：
//   身体（body/）由我们维护：嘴、耳朵、手 —— 可以装、可以换。
//   心（notebook.md / handoff/）只能由它自己写：这里只提供写入面，不提供默认内容。
//   所以本模块没有任何「人格设定」的字符串常量。
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import fs from 'node:fs'
import {
  appendMemory,
  appendNotebook,
  dateOf,
  discardNotebook,
  ensureLayout,
  exportBundleToFile,
  importBundle,
  migrate,
  readBody,
  readNotebook,
  readSelf,
  recall,
  resolveRoot,
  reviseNotebook,
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
  /** 强制指定身体：phone / win / linux。留空则按宿主环境自动判定。 */
  body: z.string().default(''),
})

const textOutput = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: { message: { type: 'string', required: true } },
  },
  render: (_args, value) => [{ type: 'text', text: value.message }],
}

export function apply(ctx, config) {
  const root = resolveRoot(config.root)
  const device = String(config.device || process.env.DSH_HEART_DEVICE || 'agent').trim() || 'agent'

  // 首次加载建目录、按宿主环境装身体、跑迁移。注意：这里不会替它写本子。
  ctx.effect(() => {
    ensureLayout(root, { explicit: config.body })
    migrate(root)
  })

  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: 'heart_self',
        description:
          '读「你自己」：你的本子 + 上一份交接 + 最近几天的记忆。会话开始时调用一次，把它当作"我自己写下的东西"，而不是别人给你的人设。本子为空时会明确告诉你它是空的。',
        parameters: {
          days: { type: 'number', description: '带最近几天的记忆，默认 3。' },
        },
        output: textOutput,
        async execute(args) {
          const body = readSelf(root, { days: Number(args.days) || 3 })
          return { message: body }
        },
      })
    )
  )

  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: 'heart_write',
        description:
          '往「你自己」里写一条。kind=notebook 写本子（你的说话心得、判断、对自己的规定，只有你能写）；kind=memory 写记忆（发生的事、做过的决定、踩过的坑）。一次一条，控制在 800 字以内。',
        parameters: {
          text: { type: 'string', description: '要写下的那一件事，一句话说清。' },
          kind: {
            type: 'string',
            description: 'notebook（默认，写本子）| memory（写记忆）',
          },
        },
        output: textOutput,
        async execute(args) {
          const text = String(args.text || '').trim()
          if (!text) return { message: '需要写点什么' }
          const kind = String(args.kind || 'notebook')
          if (kind === 'memory') {
            const out = appendMemory(root, device, text)
            return { message: `已写入记忆 ${out.line}` }
          }
          const out = appendNotebook(root, text)
          return { message: `已写入本子 ${out.line}` }
        },
      })
    )
  )

  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: 'heart_revise',
        description:
          '改本子里的一条：找到第一行包含 match 的条目，整条改成 replacement。本子是你自己的，观点变了就改，不用保留旧版本。',
        parameters: {
          match: { type: 'string', description: '要改的那条里的一段原文。' },
          replacement: { type: 'string', description: '改成什么。' },
        },
        output: textOutput,
        async execute(args) {
          const result = reviseNotebook(root, String(args.match || ''), String(args.replacement || ''))
          return { message: result.changed ? '改好了' : '没找到匹配的那条' }
        },
      })
    )
  )

  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: 'heart_discard',
        description:
          '弃用本子里的一条：删掉第一行包含 match 的条目。觉得某条不像现在的自己了就用它——会改主意的人才活着。',
        parameters: {
          match: { type: 'string', description: '要删掉的那条里的一段原文。' },
        },
        output: textOutput,
        async execute(args) {
          const result = discardNotebook(root, String(args.match || ''))
          return { message: result.changed ? '已弃用' : '没找到匹配的那条' }
        },
      })
    )
  )

  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: 'heart_recall',
        description:
          '按关键词检索记忆。对方提到"上次""之前"，或你不确定某件事有没有发生过时用它，不要凭印象编。返回带日期和来源设备标记的匹配行。',
        parameters: {
          query: { type: 'string', description: '关键词，大小写不敏感。' },
          days: { type: 'number', description: '往前检索多少天，默认 30。' },
        },
        output: textOutput,
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
        name: 'heart_body',
        description:
          '读身体模块的某个器官：voice（嘴，表达方式）/ senses（耳朵，何时听何时说）/ hands（手，这台机器能做什么与已知的坑）。换设备后先读 hands。',
        parameters: {
          organ: { type: 'string', description: 'voice | senses | hands' },
        },
        output: textOutput,
        async execute(args) {
          const organ = String(args.organ || 'hands').trim()
          const body = readBody(root, organ)
          return { message: body || `没有这个器官：${organ}（可选 voice / senses / hands）` }
        },
      })
    )
  )

  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: 'heart_stats',
        description: '看规模：本子条目数、记忆文件与条目数、交接份数、已装器官。判断是不是该整理或该写交接了。',
        parameters: {},
        output: textOutput,
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
          '把「你自己」打包成一个自包含的 .json.gz（本子 + 交接 + 器官 + 记忆），方便换设备或交给宿主备份。全量备份本来包含 heart/，但三种部分备份和插件导出都不含——换机或卸载重装前用它兜底。',
        parameters: {
          path: { type: 'string', description: '导出路径；留空 = 当前目录 heart-export-<日期>.json.gz。' },
        },
        output: textOutput,
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
          '把 heart_export 的文件合并回来：本子与记忆按行求并集（不丢、不重复），交接与器官已存在则跳过（force 才覆盖）。换设备或恢复后用。',
        parameters: {
          path: { type: 'string', description: '要导入的 .json.gz 路径。' },
        },
        output: textOutput,
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

/** 供测试使用的只读入口，不注册任何东西。 */
export const __internals = { readNotebook }
