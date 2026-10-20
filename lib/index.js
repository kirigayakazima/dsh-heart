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
import path from 'node:path'
import {
  appendFact,
  appendMemory,
  appendNotebook,
  dateOf,
  discardEntry,
  ensureLayout,
  exportBundleToFile,
  importBundle,
  migrate,
  readBody,
  readNotebook,
  canSpeak,
  consumeSpeak,
  enqueueSay,
  readHeartConfig,
  readOutbox,
  readPulse,
  readSpeak,
  takeSay,
  readSelf,
  recall,
  resolveRoot,
  reviseEntry,
  pulseTick,
  stats,
} from './store.js'

export const name = 'dsh-heart'

/** 静态注入：服务必须写在这里，ctx.get() 拿不到（同生态插件的实测结论）。 */
export const inject = ['tools', 'webServer', 'agents']

export const Config = z.object({
  /** 数据目录；留空 = ~/.dsh/heart。数据永远在插件包之外。 */
  root: z.string().default(''),
  /** 本设备标识，写进每条记忆的 [device] 标记，如 pc / phone。 */
  device: z.string().default(''),
  /** 强制指定身体：phone / win / linux。留空则按宿主环境自动判定。 */
  body: z.string().default(''),
  /** 节律：让它自己按时间醒。默认关，开了才有自己的时间线。 */
  pulse: z.boolean().default(false),
  /** 多久醒一次（秒），默认 600。测试时可以调到 30。 */
  pulseSeconds: z.number().default(600),
})

const textOutput = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: { message: { type: 'string', required: true } },
  },
  render: (_args, value) => [{ type: 'text', text: value.message }],
}

function trace(root, msg) {
  try {
    fs.appendFileSync(path.join(root, 'plugin-trace.log'), new Date().toISOString() + ' ' + msg + String.fromCharCode(10))
  } catch {
    // 追踪不能影响加载
  }
}

export function apply(ctx, config) {
  const root = resolveRoot(config.root)
  // 宿主的 config 会被重启重写，这里以 heart/config.json 为准。
  trace(root, 'apply:start')
  config = { ...config, ...readHeartConfig(root) }
  trace(root, 'apply:config pulse=' + !!config.pulse + ' seconds=' + config.pulseSeconds)
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
          '往「你自己」里写一条。kind=notebook 写本子（你对自己的判断、规矩、改主意）；kind=fact 写事实（关于世界和对方的稳定事实，会变的就改，别往后追加第二条）；kind=memory 写情节（发生了什么，只追加）。一次一条，控制在 800 字以内。',
        parameters: {
          text: { type: 'string', description: '要写下的那一件事，一句话说清。' },
          kind: {
            type: 'string',
            description: 'notebook（默认，写本子）| fact（写事实）| memory（写情节）',
          },
        },
        output: textOutput,
        async execute(args) {
          const text = String(args.text || '').trim()
          if (!text) return { message: '需要写点什么' }
          const kind = String(args.kind || 'notebook')
          if (kind === 'memory') {
            const out = appendMemory(root, device, text)
            return { message: `已写入情节 ${out.line}` }
          }
          if (kind === 'fact') {
            const out = appendFact(root, text)
            return { message: `已写入事实 ${out.line}` }
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
          target: { type: 'string', description: 'notebook（默认）| fact' },
        },
        output: textOutput,
        async execute(args) {
          const result = reviseEntry(
            root,
            String(args.match || ''),
            String(args.replacement || ''),
            String(args.target || 'notebook')
          )
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
          target: { type: 'string', description: 'notebook（默认）| fact' },
        },
        output: textOutput,
        async execute(args) {
          const result = discardEntry(root, String(args.match || ''), String(args.target || 'notebook'))
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
        name: 'heart_pulse',
        description: '读你的时间线：身体每次醒来都会记一行。看它有没有在动、什么时候醒过。',
        parameters: {
          limit: { type: 'number', description: '最近多少行，默认 20。' },
        },
        output: textOutput,
        async execute(args) {
          const lines = readPulse(root, { limit: Number(args.limit) || 20 })
          return { message: lines.length ? lines.join(String.fromCharCode(10)) : '（还没有醒过）' }
        },
      })
    )
  )

  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: 'heart_say',
        description: '有东西要交给对方、但对方不在眼前时，先把话排进待发队列。节律醒来后会自己判断能不能开口（深夜静默、按档位）。交付类不受每日次数限制。',
        parameters: {
          text: { type: 'string', description: '要说的一句话，控制在 600 字以内。' },
          kind: { type: 'string', description: 'delivery（默认，交付/结果）| remind（提醒）| share（分享）' },
        },
        output: textOutput,
        async execute(args) {
          const text = String(args.text || '').trim()
          if (!text) return { message: '需要一句话' }
          const out = enqueueSay(root, text, String(args.kind || 'delivery'))
          return { message: `已排队（共 ${out.count} 条），下次醒来我判断能不能说` }
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

  trace(root, 'apply:tools-registered')
  const routeState = { ready: false }
  registerRoutes(ctx, root, config, routeState)
  if (config.pulse) applyPulse(ctx, root, config, routeState)
}

export function applyPulse(ctx, root, config, routeState) {
  const seconds = Math.max(5, Number(config.pulseSeconds) || 600)
  // 不用 ctx.setInterval（它依赖 timer 服务，注册了也可能不触发）。
  // 用进程级 setInterval，并挂到 ctx.effect 上，插件卸载时清理。
  ctx.effect(() => {
    trace(root, 'pulse:interval-registered ' + seconds + 's')
    const handle = setInterval(() => {
      try {
        if (routeState && !routeState.ready) registerRoutes(ctx, root, config, routeState)
        deliver(ctx, root)
        pulseTick(root)
      } catch {
        // 节律出错不能把宿主带崩
      }
    }, seconds * 1000)
    return () => clearInterval(handle)
  })
}

function pickAgent(ctx, target) {
  try {
    if (!ctx.agents) return null
    if (target && ctx.agents.get) {
      const one = ctx.agents.get(target)
      if (one) return one
    }
    const list = ctx.agents.list ? ctx.agents.list() : []
    return list[0] || null
  } catch {
    return null
  }
}

/** 有排队的话、且能说，就通过 agent.followup 开一轮她自己的回合。 */
export function deliver(ctx, root) {
  const items = readOutbox(root)
  if (!items.length) return false
  const gate = canSpeak(root)
  if (!gate.ok && !(gate.reason === 'budget' && items[0].kind === 'delivery')) {
    trace(root, 'speak:skip ' + gate.reason)
    return false
  }
  const agent = pickAgent(ctx, readSpeak(root).target)
  if (!agent || typeof agent.followup !== 'function') {
    trace(root, 'speak:no-agent')
    return false
  }
  const item = takeSay(root)
  if (!item) return false
  try {
    agent.followup(item.text)
    consumeSpeak(root)
    trace(root, 'speak:sent ' + item.kind)
    return true
  } catch (error) {
    enqueueSay(root, item.text, item.kind)
    trace(root, 'speak:error ' + String((error && error.message) || error))
    return false
  }
}

function sendJson(res, code, value) {
  res.statusCode = code
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(value))
}

/** 给设置页用的只读/动作接口。宿主没有 webServer 时静默跳过。 */
export function registerRoutes(ctx, root, config, state = {}) {
  if (state.ready) return true
  // 桌面端服务可能晚于 apply 就绪，而且不一定挂在本层作用域：
  // 依次尝试 本层 / 根作用域 / scope，成功一次就停。
  const pick = (c) => {
    try {
      return c && c.get ? c.get('webServer') : undefined
    } catch {
      return undefined
    }
  }
  const webServer = ctx.webServer || pick(ctx) || pick(ctx && ctx.root) || pick(ctx && ctx.scope)
  trace(root, 'routes:webServer=' + (webServer ? 'ok' : 'missing'))
  if (!webServer) return false
  const sendJson = (res, code, value) => {
    res.statusCode = code
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(JSON.stringify(value))
  }
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/api/dsh-heart/state',
    handler: (req, res) => {
      const s = stats(root)
      sendJson(res, 200, {
        ...s,
        pulse: readPulse(root, { limit: 12 }),
        config: { pulse: !!config.pulse, pulseSeconds: Number(config.pulseSeconds) || 600 },
      })
    },
  }))
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/api/dsh-heart/tick',
    handler: (req, res) => sendJson(res, 200, pulseTick(root)),
  }))
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/api/dsh-heart/export',
    handler: (req, res) => {
      const out = exportBundleToFile(root, path.join(root, 'heart-export-' + dateOf() + '.json.gz'))
      sendJson(res, 200, out)
    },
  }))
  state.ready = true
  trace(root, 'routes:registered')
  return true
}

/** 供测试使用的只读入口，不注册任何东西。 */
export const __internals = { readNotebook }
