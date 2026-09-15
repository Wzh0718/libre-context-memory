/**
 * dsh-lcm — libre-context-memory 的 DSH 适配器（薄壳，进程内直调核心）。
 *
 * 挂 `tools/post-execute` 瀑布：纯文本工具结果超过 maxInlineChars 时，
 * 进程内直调核心引擎（compress + spill + meter），
 * 把模型可见结果替换为「摘要 + 句柄」。
 *
 * 薄壳纪律：本文件只做事件翻译（字段提取 → 调核心 → 包装返回）+ 失败静默。
 * 压缩/存储/计量逻辑一律不在壳内。核心与壳同仓库（core/*.mjs），零额外运行时
 * （DSH 宿主即 Node，不需要 Python）。
 *
 * 与 dsh-spill-policy 的关系：二者占同一个替换通道，**不要同时生效**
 * （spill-policy 在未配置 maxInlineBytes 时是 no-op，默认不冲突）。
 *
 * 模式：
 * - shadow（默认）：完整跑一次压缩（不落 spill），决策记 meter（backend=shadow）
 *   + 日志，模型可见结果原样透传。
 * - active：替换模型可见结果为摘要+句柄；任何异常都回退原文——压缩故障
 *   绝不让成功调用变错误。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

import { compress } from '../../../core/compress.mjs'
import { loadConfig } from '../../../core/config.mjs'
import * as meter from '../../../core/meter.mjs'
import * as memory from '../../../core/memory.mjs'
import * as profile from '../../../core/profile.mjs'
import * as spill from '../../../core/spill.mjs'

export const name = 'dsh-lcm'

/** 与 docs/03 对齐的默认阈值：p90 工具输出 19,865 字符，多数调用不打扰。 */
const DEFAULTS = {
  mode: 'shadow',
  maxInlineChars: 20_000,
  lcmRoot: undefined, // 数据根（.lcm/ 落点）：默认取会话 cwd / 进程 cwd
  meterRoot: undefined, // 计量根：默认全局 ~/.lcm（事件带 project 字段）；此处可覆盖
  // —— 主动预算剪枝臂 ——
  // 用户拍板：不按单条内容的尺寸/年龄设死规则（第一轮就可能来超大输出，
  // 尺寸/年龄与语义价值无关）。驱动 = 会话总 token 预算；超预算时按
  // 「最大者优先」批量替换，一次击穿办多件事。
  budgetTokens: 100_000,   // 会话总量（tokenMeter）超过此值触发剪枝
  targetTokens: 60_000,    // 剪到此值以下停手（滞回带，避免每轮都剪）
  pruneMinChars: 4_000,    // 候选下限：比这小的剪了也没收益（摘要本身 ~1k 字符）
  // 冷却：一次剪枝会击穿前缀缓存，剪完立刻又剪 = 反复击穿（实测踩到过）。
  // 剪枝后要等会话再长这么多 token 才允许下一次——这是「臂的节流」，
  // 不是对单条内容设尺寸/年龄规则。
  pruneCooldownTokens: 10_000,
  // 剪枝时机：
  // - piggyback（默认）：只在缓存本来要失效时动手（compaction 事件后 / 观测到击穿后 /
  //   继承会话首请求前），改写历史免费；触发权交给 DSH 内置折叠与必然冷启动，
  //   避免主动制造昂贵的缓存击穿。
  // - proactive：仍由 budgetTokens 主动触发，只在超长会话显式开（回本需要 ≥104 请求/次，
  //   实测窗口默认开导致净负 3.2%）。
  pruneProactive: false,
  bustThresholdTokens: 50_000, // fresh 超过此值视为「前缀已冷」
  // —— 记忆臂（Phase 3：本地 ~/.lcm/memories + OpenViking 双写）——
  memoryExtract: true,         // compaction/summary → 确定性提取入库（搭 DSH 内置摘要便车，零 LLM 调用）
  memoryExtractIncremental: true, // 增量熔炼臂：pre-step 水位线扫新增 user/assistant 轮次提取入库
  foldMode: 'shadow',           // warm folding：off|shadow|active——把已蒸馏旧轮次折叠成指针行（记忆替代 token）
  foldMinChars: 200,            // 短于此不折（指针行本身有成本，折叠不划算）
  foldKeepLastTurns: 4,         // 最新 N 个对话节点永不折叠（活跃上下文）
  memoryInjectMode: 'shadow',  // 记忆注入单独模式：shadow 只记账；active 在请求尾部追加检索块（前缀安全）
  memoryInjectMaxEntries: 6,   // 注入块条目上限（预算纪律：注入自身不能成为体积源）
  // —— 静态层裁剪臂（system-prompt/assemble）——
  // 工具定义在 ordinal 1–73，是缓存前缀最前端：**会话中途改动 = 击穿整个前缀**。
  // 因此策略必须是「会话无关的确定性规则」（同输入必得同输出 → 天然稳定）。
  staticTrimMode: null,       // null = 跟随 mode；'shadow'/'active' 可单独控制该臂（描述降噪有削掉操作性规则的风险，建议先 shadow）
  toolMaxDescriptionChars: 0, // 0 = 不裁剪描述；>0 = 描述压到该字符数内（首段优先，句末截断）
  dropToolFamilies: [],       // 例：['mcp__mnemon','mcp__dbx']，按 MCP 族整族不注入
}

/** MCP 工具族：mcp__<server>__<tool> → mcp__<server>。 */
function familyOf(name) {
  if (typeof name !== 'string' || !name.startsWith('mcp__')) return null
  const parts = name.split('__')
  return parts.length >= 3 ? `${parts[0]}__${parts[1]}` : null
}

/** 描述降噪：优先保留首段；超预算时在句末截断。纯函数 → 输出稳定。 */
function trimDescription(text, maxChars) {
  const points = [...text]
  if (points.length <= maxChars) return text
  const firstBreak = text.indexOf('\n\n')
  const firstPara = firstBreak === -1 ? text : text.slice(0, firstBreak)
  if ([...firstPara].length <= maxChars) return firstPara
  const head = points.slice(0, maxChars).join('')
  const lastStop = Math.max(head.lastIndexOf('. '), head.lastIndexOf('。'), head.lastIndexOf('\n'))
  return (lastStop > maxChars * 0.5 ? head.slice(0, lastStop + 1) : head).trimEnd()
}

/**
 * 确定性裁剪工具集：同输入必得同输出（缓存前缀安全的唯一前提）。
 * @returns {{tools: object[], stats: object, pairs: Array<{name: string, before: string, after: string|null}>}}
 *   pairs 供 trim-diff 复核工件：after=null 表示整族丢弃，before===after 表示未动。
 */
export function trimTools(tools, cfg) {
  const maxChars = cfg.toolMaxDescriptionChars
  const drop = new Set(cfg.dropToolFamilies ?? [])
  const familiesDropped = new Set()
  const out = []
  const pairs = []
  let charsBefore = 0
  let charsAfter = 0
  let descTrimmed = 0
  for (const tool of tools) {
    const family = familyOf(tool?.name)
    if (family !== null && drop.has(family)) {
      familiesDropped.add(family)
      pairs.push({ name: tool?.name ?? '?', before: tool?.description ?? '', after: null })
      continue
    }
    const desc = typeof tool?.description === 'string' ? tool.description : ''
    charsBefore += [...desc].length
    let next = desc
    if (maxChars > 0 && [...desc].length > maxChars) {
      next = trimDescription(desc, maxChars)
      if (next !== desc) descTrimmed++
    }
    charsAfter += [...next].length
    out.push(next === desc ? tool : { ...tool, description: next })
    pairs.push({ name: tool?.name ?? '?', before: desc, after: next })
  }
  return {
    tools: out,
    pairs,
    stats: {
      toolsBefore: tools.length, toolsAfter: out.length,
      charsBefore, charsAfter, descTrimmed,
      families: [...familiesDropped],
      changed: tools.length - out.length + descTrimmed,
    },
  }
}

/** 文本块拼接（宽松版：混入图片等非文本块时只取文本部分；全无文本返回 null）。 */
function flattenTextBlocks(content) {
  if (!Array.isArray(content)) return null
  const text = content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n').trim()
  return text || null
}

/** 全部文本块拼成一个字符串；含任何非文本块则返回 undefined（不处理）。 */
function flattenPlainText(content) {
  if (!Array.isArray(content)) return undefined
  let text = ''
  for (const block of content) {
    if (block?.type !== 'text' || typeof block.text !== 'string') return undefined
    text += block.text
  }
  return text
}

/**
 * 落 trim-diff 复核工件（<meterRoot>/trim-preview.json）：裁剪前后逐工具对照。
 * 内容寻址节流：裁剪结果的 digest 没变就不重写。失败静默（复核件绝不影响主流程）。
 * `lcm trim-diff` CLI 读取此文件渲染给人看——shadow 观察期的人工复核就靠它。
 */
export function writeTrimPreview(meterCfg, { trimMode, stats, pairs }) {
  const previewPath = join(meterCfg.meterDir, 'trim-preview.json')
  const changed = pairs
    .filter((p) => p.after === null || p.before !== p.after)
    .map((p) => ({ name: p.name, dropped: p.after === null, before: p.before, after: p.after ?? '' }))
  const digest = createHash('sha256')
    .update(JSON.stringify({ mode: trimMode, changed }))
    .digest('hex')
  try {
    if (existsSync(previewPath)) {
      try {
        if (JSON.parse(readFileSync(previewPath, 'utf8'))?.digest === digest) return false
      } catch { /* 损坏则重写 */ }
    }
    writeFileSync(previewPath, JSON.stringify({
      digest, savedAt: Date.now(), mode: trimMode,
      toolsBefore: stats.toolsBefore, toolsAfter: stats.toolsAfter,
      charsBefore: stats.charsBefore, charsAfter: stats.charsAfter,
      families: stats.families,
      tools: changed,
    }))
    return true
  } catch {
    return false
  }
}

/** 剪枝兜底：不够压缩阈值的文本做首尾保留（type-agnostic，永不失败）。 */
function shrinkHeadTail(text, budget) {
  const points = [...text]
  const head = Math.max(200, Math.floor(budget / 4))
  const tail = Math.max(200, Math.floor(budget / 4))
  if (points.length <= head + tail + 64) return text
  return points.slice(0, head).join('')
    + `\n…[lcm 已剪枝：中间 ${(points.length - head - tail).toLocaleString()} 字符，原文在会话历史/日志可查]…\n`
    + points.slice(points.length - tail).join('')
}

/** 与 core/cli.mjs 相同的「摘要+句柄」排版（壳内只有这一小段展示逻辑）。 */
function fmtSummary(result, ref) {
  if (!ref) {
    return `[影子] 未落盘 · ${result.originalChars.toLocaleString()} 字符 · 类型 ${result.type} · 压缩 ${result.ratio.toFixed(1)}×\n--- 摘要 ---\n${result.summary}`
  }
  const header = [
    `[归档] ${ref.spillId} · ${result.originalChars.toLocaleString()} 字符 · ${result.originalLines.toLocaleString()} 行 · 类型 ${result.type} · 压缩 ${result.ratio.toFixed(1)}× · 后端 ${ref.backend}`,
    `回取: lcm read ${ref.spillId} [--from A --to B] [--grep PAT]（或 node <lcm>/core/cli.mjs read ${ref.spillId}）`,
    `本地原文: ${ref.path}`,
  ]
  if (result.keywords.length) header.push('关键词: ' + result.keywords.join(', '))
  if (result.anchors.length) {
    header.push('锚点:')
    header.push(...result.anchors.map((a) => `  ${a}`))
  }
  header.push('--- 摘要 ---')
  return header.join('\n') + '\n' + result.summary
}

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...config }
  if (!['shadow', 'active'].includes(cfg.mode)) {
    throw new Error(`dsh-lcm: mode must be shadow|active (got ${cfg.mode})`)
  }
  let warnedNoMeter = false
  const pruneArmedAt = new Map()   // sessionId → 下一次允许剪枝的 token 水位
  const coldSession = new Set()    // 刚发生 compaction/击穿 → 下次 pre-step 可免费改写历史
  const preStepSeen = new Set()    // 已经历过 pre-step 的会话（继承冷启动窗口只在首个 pre-step 有效）
  const lastInjectDigest = new Map() // sessionId → 上次注入的条目 digest（内容没变不重复注入）
  const extractWatermark = new Map() // sessionId → 已熔炼到的最大 seq（持久化在 meterDir，重启不重扫）
  let watermarkLoaded = false
  // 计量统一落全局根（默认 ~/.lcm，LCM_METER_ROOT / cordis 配置可覆盖），
  // 事件带 project 字段（会话 cwd）——此前按会话 cwd + 服务器 cwd 分散落点，
  // report/compare 只能看到一个项目的零头数据（实测 85% 的事件落在别的根）。
  // 显式传 root 避免 loadConfig 内部的 git 探测。
  const meterBase = loadConfig(cfg.lcmRoot ?? process.cwd(), { meterRoot: cfg.meterRoot })

  ctx.on('tools/post-execute', async (exec, result, next) => {
    // 先放行下游（hook 等）落定结果；我们只 reshape 被 accept 的纯文本结果。
    const decision = await next()
    try {
      if (decision.kind !== 'accept' || Object.hasOwn(decision, 'value')) return decision
      if (exec.parent !== undefined) return decision        // 嵌套子调用不动（日志臂另议）
      if (exec.name === 'read') return decision             // 防 read → spill → read 循环

      const content = decision.content ?? result?.content
      const text = flattenPlainText(content)
      if (text === undefined) return decision
      if ([...text].length <= cfg.maxInlineChars) return decision

      const lcmRoot = cfg.lcmRoot
        ?? exec.agent?.session?.header?.cwd
        ?? process.cwd()
      const lcmCfg = loadConfig(lcmRoot)
      const sessionId = exec.agent?.session?.header?.id
      const r = compress(text)
      if (!r.compressed) return decision

      const isShadow = cfg.mode === 'shadow'
      const ref = isShadow ? null : spill.put(lcmCfg, text)
      meter.record(meterBase, {
        kind: 'compress', type: r.type,
        originalChars: r.originalChars, compressedChars: [...r.summary].length,
        ratio: Number(r.ratio.toFixed(2)),
        spillId: ref?.spillId ?? null, backend: ref?.backend ?? 'shadow',
        storedBytes: ref?.bytes ?? null, compressed: ref?.compressed ?? null,
        harness: 'dsh', sessionId: sessionId ?? null,
        project: exec.agent?.session?.header?.cwd ?? null,
      })
      if (ref?.sweep && (ref.sweep.removed > 0 || ref.sweep.reason)) {
        meter.record(meterBase, {
          kind: 'spill-sweep', removed: ref.sweep.removed,
          freedBytes: ref.sweep.freedBytes, bytes: ref.sweep.bytes, reason: ref.sweep.reason,
        })
      }

      if (isShadow) {
        ctx.logger.info(
          `dsh-lcm [shadow] ${exec.name}: ${r.originalChars} chars 类型 ${r.type}，可压缩 ${r.ratio.toFixed(1)}×（未替换）`,
        )
        return decision
      }

      // active：替换模型可见结果为「摘要+句柄」（非错误、非 block —— 成功结果的归档视图）
      ctx.logger.info(`dsh-lcm ${exec.name}: ${r.originalChars} chars → ${r.ratio.toFixed(1)}×（${ref?.spillId ?? 'no-spill'}）`)
      return {
        kind: 'accept',
        content: [{ type: 'text', text: fmtSummary(r, ref) }],
        ...(decision.additionalContexts ? { additionalContexts: decision.additionalContexts } : {}),
      }
    } catch (error) {
      // 失败静默：原文透传，绝不让压缩故障污染工具调用
      ctx.logger.warn(`dsh-lcm: compress failed for ${exec?.name}: ${String(error?.message ?? error)}; keeping original`)
      return decision
    }
  }, { prepend: true })

  // ---- 静态层裁剪臂（system-prompt/assemble）----
  // 工具定义在请求最前端（ordinal 1–73）→ 会话中途改动会击穿整个前缀缓存。
  // 所以这里只做「会话无关的确定性裁剪」：同输入 → 逐字节相同的输出 → 零额外击穿。
  // 计量/复核工件一律落 meterBase（全局计量根）——本钩子没有会话上下文，
  // 此前用 process.cwd() 落点导致事件全部写进服务器 cwd 的 .lcm（实测 bug）。
  ctx.on('system-prompt/assemble', async (assembly, _context, next) => {
    const out = await next()
    try {
      const tools = out?.tools
      if (!Array.isArray(tools) || tools.length === 0) return out
      const trimMode = cfg.staticTrimMode ?? cfg.mode
      const { tools: trimmed, stats, pairs } = trimTools(tools, cfg)
      if (stats.changed === 0) return out
      meter.record(meterBase, {
        kind: 'static-trim', mode: trimMode,
        toolsBefore: stats.toolsBefore, toolsAfter: stats.toolsAfter,
        charsBefore: stats.charsBefore, charsAfter: stats.charsAfter,
        descTrimmed: stats.descTrimmed, families: stats.families,
        project: null,   // 工具集是 profile 级的，不属于任何项目会话
      })
      writeTrimPreview(meterBase, { trimMode, stats, pairs })
      if (trimMode === 'shadow') {
        ctx.logger.info(
          `dsh-lcm [shadow] static-trim: 工具 ${stats.toolsBefore}→${stats.toolsAfter}，`
          + `描述 ${stats.charsBefore.toLocaleString()}→${stats.charsAfter.toLocaleString()} 字符（未替换）`,
        )
        return out
      }
      ctx.logger.info(
        `dsh-lcm static-trim: 工具 ${stats.toolsBefore}→${stats.toolsAfter}，`
        + `描述 ${stats.charsBefore.toLocaleString()}→${stats.charsAfter.toLocaleString()} 字符`,
      )
      return { ...out, tools: trimmed }
    } catch (error) {
      ctx.logger.warn(`dsh-lcm: static-trim failed: ${String(error?.message ?? error)}; keeping assembly`)
      return out
    }
  }, { prepend: true })

  // ---- 每请求缓存/压缩观测臂（只记账，不改行为）----
  // 「重复写」的账不该等大输出才记：每轮的 fresh/cached/命中率 + 折叠事件，
  // 都落 meter.jsonl，lcm report 直接看趋势与击穿。
  // ---- 主动预算剪枝臂（prepend：跑在内置折叠之前，便宜的先来）----
  // 会话总量（tokenMeter 实测/估算）超过 budgetTokens 时：
  // 把当前 surface 里的 tool/result 按字符数降序批量替换为「摘要+句柄」，
  // 直到低于 targetTokens（滞回带）。最新一条 tool/result 不动（当前推理要用）。
  // shadow 模式完整计算并记账，但不改写历史。任何异常 → 放行（next()）。
  /** 剪枝臂主体（独立函数：早退不影响注入流程）。 */
  // ---- warm folding 折叠臂：把「已蒸馏至记忆库」的旧轮次折叠成指针行 ----
  // 纪律：只折 seq ≤ 熔炼水位线的轮次（信息已在记忆库，折叠=替代而非丢失）；
  // 只在冷窗口调用（piggyback）；最新 foldKeepLastTurns 轮永不折叠（活跃上下文）；
  // 指针行替换走 surfaceOp replace——只改模型可见层，持久日志完好可回放。
  const runFold = (agent, sessionKey) => {
    if (cfg.foldMode === 'off') return
    const session = agent?.session
    if (!session?.surface || typeof session.append !== 'function') return
    const watermark = extractWatermark.get(sessionKey) ?? -1
    if (watermark < 0) return                        // 熔炼臂没跑过 → 无可折叠对象（安全默认）
    const chatSeqs = [...session.surface.nodes]
      .filter((seq) => {
        if (seq > watermark) return false            // 未蒸馏的不折
        const e = session.eventAt?.(seq)
        return e?.type === 'user/message' || e?.type === 'assistant/message'
      })
      .sort((a, b) => a - b)
    const keep = new Set(chatSeqs.slice(-cfg.foldKeepLastTurns))   // 最新 N 轮永不折叠
    const isShadow = cfg.foldMode !== 'active'
    let folded = 0, charsBefore = 0, charsAfter = 0
    for (const seq of chatSeqs) {
      if (keep.has(seq)) continue
      const event = session.eventAt(seq)
      const isUser = event.type === 'user/message'
      if (isUser && event.data?.source?.kind !== 'user') continue  // 插件注入消息不折（本来也小）
      const t = isUser ? flattenTextBlocks(event.data?.content) : flattenTextBlocks(event.data?.message?.content)
      if (!t) continue
      const chars = [...t].length
      if (chars < cfg.foldMinChars) continue
      const pointer = `[轮 ${seq}·${isUser ? 'user' : 'assistant'} 已蒸馏至记忆库；原文 ${chars} 字符在会话日志完好]`
      folded++; charsBefore += chars; charsAfter += [...pointer].length
      if (isShadow) continue
      if (isUser) {
        session.append('user/message', {
          ...event.data,
          content: [{ type: 'text', text: pointer }],
          source: { kind: 'plugin', plugin: 'dsh-lcm', form: 'fold-pointer' },
        }, { surfaceOp: { op: 'replace', start: seq, end: seq }, sourceEventSeqs: [seq] })
      } else {
        session.append('assistant/message', {
          ...event.data,
          message: { ...event.data.message, content: [{ type: 'text', text: pointer }] },
        }, { surfaceOp: { op: 'replace', start: seq, end: seq }, sourceEventSeqs: [seq] })
      }
    }
    if (folded === 0) return
    meter.record(meterBase, {
      kind: 'fold', sessionId: sessionKey, mode: cfg.foldMode,
      nodes: folded, charsBefore, charsAfter,
      savedTokens: Math.max(0, Math.ceil((charsBefore - charsAfter) / 2)),
      watermark,
      project: session.header?.cwd ?? null,
    })
    ctx.logger.info(`dsh-lcm ${isShadow ? '[shadow] ' : ''}fold: ${folded} 轮 ${charsBefore.toLocaleString()}→${charsAfter.toLocaleString()} 字符（已蒸馏至记忆库）`)
  }

  const runPrune = async (agent) => {

      const session = agent?.session
      // ctx.get() 免 inject 读取：cordis 对未声明 inject 的服务属性访问会抛错
      // （实测：ctx.tokenMeter 抛 "cannot get property without inject"，被 try/catch 吞掉
      //  → 剪枝臂静默失效）。用 ctx.get 既不硬依赖该服务，也不误伤启动。
      const tokenMeter = ctx.get?.('tokenMeter')
      if (!session?.surface || typeof session.append !== 'function') return
      if (!tokenMeter) {
        if (!warnedNoMeter) {
          warnedNoMeter = true
          ctx.logger.warn('dsh-lcm: tokenMeter 不可用，剪枝臂停用（压缩与观测臂不受影响）')
          console.warn('[dsh-lcm] tokenMeter 不可用，剪枝臂停用')
        }
        return
      }
      const measurement = tokenMeter.measure(session)
      if (!measurement) return
      const sessionKey = session.header?.id ?? 'unknown'
      const firstPreStep = !preStepSeen.has(sessionKey)
      preStepSeen.add(sessionKey)
      const armedAt = pruneArmedAt.get(sessionKey)
      if (armedAt !== undefined && measurement.totalTokens < armedAt) {
        coldSession.delete(sessionKey) // 冷却中，错过本次免费窗口也不保留
        return
      }

      const isCold = coldSession.has(sessionKey)
      // 继承冷启动：subagent fork（origin=subagent / parentSession 存在）的转写来自父会话，
      // 首请求无可命中的缓存（实测 cached≈3k/250k+）→ 首个 pre-step 改写历史免费，
      // 且直接缩小那个必然全价的请求。该免费窗口只在首个 pre-step 有效。
      const inherited = session.header?.origin === 'subagent'
        || typeof session.header?.parentSession === 'string'
      const inheritedCold = firstPreStep && inherited
      // 搭便车：只在缓存本来要失效时才改写历史（compaction 事件后 / 观测到击穿后 /
      // 继承会话首请求前），并设 budgetTokens 守卫：太小的会话不值得一剪
      const piggybackOk = (isCold || inheritedCold) && measurement.totalTokens > cfg.budgetTokens
      // 主动路径：显式开，且仍要越过预算守卫
      const proactiveOk = cfg.pruneProactive && measurement.totalTokens > cfg.budgetTokens
      if (!piggybackOk && !proactiveOk) {
        coldSession.delete(sessionKey)
        return
      }

      if (piggybackOk) {
        try { runFold(agent, sessionKey) } catch (error) {
          ctx.logger.warn(`dsh-lcm: fold failed: ${String(error?.message ?? error)}; continuing`)
        }
      }

      const candidates = []
      for (const seq of [...session.surface.nodes]) {
        const event = session.eventAt(seq)
        if (event?.type !== 'tool/result') continue
        const result = event.data?.message?.content?.[0]
        const text = flattenPlainText(result?.content)
        if (text === undefined) continue
        const chars = [...text].length
        if (chars <= cfg.pruneMinChars) continue
        candidates.push({ seq, event, result, text, chars })
      }
      if (candidates.length === 0) return

      candidates.sort((a, b) => b.chars - a.chars)          // 最大者优先
      const freshestSeq = Math.max(...candidates.map((c) => c.seq))
      const need = Math.max(0, measurement.totalTokens - cfg.targetTokens)
      const picks = []
      let savedTokens = 0
      for (const c of candidates) {
        if (savedTokens >= need) break
        if (c.seq === freshestSeq && candidates.length > 1) continue  // 留最新
        picks.push(c)
        savedTokens += Math.ceil(c.chars / 2)               // 保守 ≈2 字符/token
      }
      if (picks.length === 0) return

      const lcmRoot = cfg.lcmRoot ?? session.header?.cwd ?? process.cwd()
      const lcmCfg = loadConfig(lcmRoot)
      const sessionId = session.header?.id ?? null
      const isShadow = cfg.mode === 'shadow'
      let charsBefore = 0
      let charsAfter = 0
      for (const c of picks) {
        const r = compress(c.text)
        const body = r.compressed
          ? fmtSummary(r, isShadow ? null : spill.put(lcmCfg, c.text))
          : shrinkHeadTail(c.text, cfg.pruneMinChars)
        if (process.env.LCM_DEBUG) console.error(`[dbg] seq=${c.seq} chars=${c.chars} compressed=${r.compressed} summaryLen=${[...r.summary].length} bodyLen=${[...body].length}`)
        charsBefore += c.chars
        charsAfter += [...body].length
        if (isShadow) continue
        // 影价协议（与内置 pruner 一致）：先记 shadow-price，再紧邻替换，
        // 回放可还原，纯消费者可减去影子节点价格。
        session.append('compaction/prune', {
          shadowedRange: { start: c.seq, end: c.seq },
          shadowedSeqs: [c.seq],
          shadowedTokenCount: tokenMeter.estimateMessage?.(c.event.data.message) ?? Math.ceil(c.chars / 2),
        })
        session.append('tool/result', {
          ...c.event.data,
          message: {
            ...c.event.data.message,
            content: [{ ...c.result, content: [{ type: 'text', text: body }] }],
          },
        }, { surfaceOp: { op: 'replace', start: c.seq, end: c.seq }, sourceEventSeqs: [c.seq] })
      }
      // 剪完**重新实测**再设下次允许水位：用估算的 savedTokens 会和真实压力对不上
      // （实测踩到：剪完测量值仍高于推算水位 → 冷却形同虚设）
      const after = tokenMeter.measure(session)?.totalTokens ?? (measurement.totalTokens - savedTokens)
      pruneArmedAt.set(sessionKey, after + cfg.pruneCooldownTokens)
      coldSession.delete(sessionKey) // 本次免费/主动窗口已用完
      meter.record(meterBase, {
        kind: 'prune', sessionId, mode: cfg.mode,
        trigger: inheritedCold && !isCold ? 'inherited-cold' : (isCold ? 'cold' : 'proactive'),
        tokensBefore: measurement.totalTokens, budgetTokens: cfg.budgetTokens,
        nodes: picks.length, charsBefore, charsAfter,
        savedTokens, rearmAt: pruneArmedAt.get(sessionKey),
        project: session.header?.cwd ?? null,
      })
      ctx.logger.info(
        `dsh-lcm ${isShadow ? '[shadow] ' : ''}prune: ${picks.length} 节点 ${charsBefore.toLocaleString()}→${charsAfter.toLocaleString()} 字符`
        + `（压力 ${measurement.totalTokens.toLocaleString()} > 预算 ${cfg.budgetTokens.toLocaleString()}）`,
      )
  }

  // ---- 增量熔炼臂：水位线扫「本步新增」的 user/assistant 轮次 → 提取入库 ----
  // 纪律：只扫 seq > 水位线的节点（每步增量，O(新增)）；无候选零 IO（提取器纯内存，
  // 有候选才 record 读库）；插件注入与 harness 伪装消息必须过滤（实测污染第一）；
  // 低分门槛（incremental 来源 0.6）挡噪声；幂等键兜住重扫/双写。
  const runExtract = (agent) => {
    if (!cfg.memoryExtractIncremental) return
    const session = agent?.session
    if (!session?.surface || typeof session.eventAt !== 'function') return
    if (!watermarkLoaded) { loadWatermarks(); watermarkLoaded = true }
    const sessionKey = session.header?.id ?? 'unknown'
    const lastSeq = extractWatermark.get(sessionKey) ?? -1
    let maxSeq = lastSeq
    let stored = 0, rejected = 0, scanned = 0
    const capLeft = { n: 24 }   // 每步候选总上限（防多 step 爆发）
    for (const seq of [...session.surface.nodes]) {
      if (seq <= lastSeq) continue
      maxSeq = Math.max(maxSeq, seq)
      const event = session.eventAt(seq)
      let t = null
      if (event?.type === 'user/message') {
        if (event.data?.source?.kind !== 'user') continue          // 插件注入/harness 伪装
        t = flattenTextBlocks(event.data?.content)
        if (t && profile.isHarnessTalk(t)) t = null
      } else if (event?.type === 'assistant/message') {
        t = flattenTextBlocks(event.data?.message?.content)
      }
      if (!t || capLeft.n <= 0) continue
      scanned++
      for (const c of memory.extractCandidates(t)) {               // 纯内存，零 IO
        if (capLeft.n-- <= 0) break
        const r = memory.record(meterBase, {
          ...c, source: 'incremental', sessionId: sessionKey,
          project: session.header?.cwd ?? null,
        })
        if (r.action === 'ADD' || r.action === 'UPDATE') stored++
        else if (r.action === 'REJECT') rejected++
      }
    }
    if (maxSeq !== lastSeq) {
      extractWatermark.set(sessionKey, maxSeq)
      saveWatermarks()
    }
    if (scanned > 0 && (stored > 0 || rejected > 0)) {
      ctx.logger.info(`dsh-lcm memory: 增量熔炼扫 ${scanned} 轮 → 入库 ${stored} 条（低分拒 ${rejected}）`)
    }
  }

  const watermarkFile = () => join(meterBase.meterDir, 'extract-watermark.json')
  function loadWatermarks() {
    try {
      const data = JSON.parse(readFileSync(watermarkFile(), 'utf8'))
      for (const [k, v] of Object.entries(data)) if (Number.isFinite(v)) extractWatermark.set(k, v)
    } catch { /* 无水位线文件：从头扫（幂等兜住重扫） */ }
  }
  function saveWatermarks() {
    try {
      mkdirSync(meterBase.meterDir, { recursive: true })
      writeFileSync(watermarkFile(), JSON.stringify(Object.fromEntries(extractWatermark)), 'utf8')
    } catch { /* 只读环境静默 */ }
  }

  ctx.on('agent/pre-step', async ({ agent }, next) => {
    try {
      await runPrune(agent)
    } catch (error) {
      ctx.logger.warn(`dsh-lcm: prune failed: ${String(error?.message ?? error)}; continuing the turn`)
    }
    try {
      runExtract(agent)
    } catch (error) {
      ctx.logger.warn(`dsh-lcm: incremental extract failed: ${String(error?.message ?? error)}; continuing`)
    }
    // ---- 记忆注入（拿住 decision，请求尾部追加稳定块；同 dsh-time-context 的注入模式）----
    // 纪律：尾部追加绝不插中间（前缀安全）；digest 没变不重复注入（注入自身不能成为体积源）；
    // 检索查询 = 最近一条真实用户消息（当前任务意图）。
    const decision = await next()
    try {
      if (cfg.memoryInjectMode !== 'active' && cfg.memoryInjectMode !== 'shadow') return decision
      if (!decision || decision.kind === 'reject' || !Array.isArray(decision.messages)) return decision
      const sessionKey2 = agent?.session?.header?.id ?? 'unknown'
      // 常驻画像块：只读缓存（allowScan:false——全量扫描是分钟级，绝不进请求热路径）。
      // 自动刷新：画像过期（>6h）→ 后台 fire-and-forget 重扫最近 14 天窗口，
      // 本次请求仍用旧缓存，下一次请求自动拿到新画像（无手动 refresh）。
      profile.maybeAutoRefresh(meterBase)
      let profileBlock = null
      try {
        const prof = profile.getProfile(meterBase, { allowScan: false })
        profileBlock = profile.renderProfileBlock(meterBase, prof ?? {})
      } catch { /* 画像缺失静默 */ }
      let query = lastUserQuery(decision.messages)
      if (query && cfg.memoryQueryBlend) {
        // 混合会话画像（默认关；A/B 实测略降排序，见 memory.blendQuery 注释）
        try {
          const prof = memory.sessionProfileOf(meterBase, sessionKey2)
          if (prof) {
            const mine = memory.sessionProfileOf(meterBase, sessionKey2, { maxChars: 1 })  // 触发一次计数即可
            void mine
            query = memory.blendQuery(query, prof, { share: 0.2 })
          }
        } catch { /* 混合失败退回纯用户消息 */ }
      }
      const entries = query ? memory.search(meterBase, query, { k: cfg.memoryInjectMaxEntries }) : []
      const block = entries.length > 0 ? memory.renderInjectBlock(query, entries) : null
      const text = [profileBlock, block].filter(Boolean).join('\n')
      if (!text) return decision
      const digest = createHash('sha256').update(text).digest('hex').slice(0, 12)
      if (lastInjectDigest.get(sessionKey2) === digest) return decision   // 内容没变，不重复注入
      lastInjectDigest.set(sessionKey2, digest)
      meter.record(meterBase, {
        kind: 'memory-inject', mode: cfg.memoryInjectMode,
        query: query?.slice(0, 80) ?? '', entries: entries.length, chars: [...text].length,
        profile: Boolean(profileBlock),
        sessionId: sessionKey2, project: agent?.session?.header?.cwd ?? null,
      })
      if (cfg.memoryInjectMode === 'shadow') {
        ctx.logger.info(`dsh-lcm [shadow] memory-inject: ${entries.length} 条（${(query ?? '(画像常驻)').slice(0, 40)}…，未注入）`)
        return decision
      }
      ctx.logger.info(`dsh-lcm memory-inject: ${entries.length} 条（${(query ?? '(画像常驻)').slice(0, 40)}…）`)
      return {
        ...decision,
        messages: [...decision.messages, {
          role: 'user',
          content: [{ type: 'text', text }],
          source: { kind: 'plugin', plugin: 'dsh-lcm', form: 'snapshot', sections: [{ name: 'lcm-memory', text }] },
        }],
      }
    } catch (error) {
      ctx.logger.warn(`dsh-lcm: memory-inject failed: ${String(error?.message ?? error)}; keeping decision`)
      return decision
    }
  }, { prepend: true })

  /** 最近一条真实用户消息文本（跳过插件注入的 snapshot），做检索查询。 */
  function lastUserQuery(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m?.role !== 'user') continue
      if (m?.source?.kind === 'plugin') continue   // 自己/别人的注入块不是用户意图
      const block = Array.isArray(m?.content) ? m.content.find((b) => b?.type === 'text' && typeof b.text === 'string') : null
      if (block && block.text.trim()) return block.text.trim().slice(0, 400)
      return null
    }
    return null
  }

  ctx.on('session/event', (session, event) => {
    try {
      const type = event?.type
      const sessionId = session?.header?.id ?? null

      if (type === 'assistant/message' && event?.data?.usage) {
        const u = event.data.usage
        // DSH usage 口径（实测验算：input+cacheRead+output = totalTokens）：
        // inputTokens 本身就不含 cacheRead → fresh = input，总量 = input + cacheRead
        const fresh = u.inputTokens ?? 0
        const cacheRead = u.cacheReadTokens ?? 0
        const total = fresh + cacheRead
        // 前缀已冷 = 可以免费改写历史的时机（compaction/击穿）
        if (sessionId && fresh > cfg.bustThresholdTokens) coldSession.add(sessionId)
        meter.record(meterBase, {
          kind: 'usage', sessionId,
          input: fresh, cacheRead, fresh,
          hitRate: total > 0 ? Number((cacheRead / total).toFixed(4)) : null,
          output: u.outputTokens ?? null,
          // 击穿苗头：新增很小却大额 fresh（阈值对齐 cfg.bustThresholdTokens）
          cacheBust: fresh > cfg.bustThresholdTokens,
          project: session?.header?.cwd ?? null,
        })
      } else if (typeof type === 'string' && type.startsWith('compaction/')) {
        coldSession.add(sessionId)
        meter.record(meterBase, {
          kind: 'compaction', sessionId, op: type,
          shadowedTokens: event?.data?.shadowedTokenCount ?? null,
          project: session?.header?.cwd ?? null,
        })
        // 记忆提取臂：搭 DSH 内置摘要的便车——compaction/summary 的产物已经是
        // LLM 蒸馏过的结构化 markdown，确定性提取器零成本挑出记忆候选入库。
        if (type === 'compaction/summary' && cfg.memoryExtract) {
          try {
            const text = (Array.isArray(event?.data?.summary) ? event.data.summary : [])
              .map((b) => (typeof b?.text === 'string' ? b.text : '')).join('\n')
            const cands = memory.extractCandidates(text)
            let stored = 0; let idem = 0; let blocked = 0
            for (const c of cands) {
              const r = memory.record(meterBase, {
                ...c, source: 'compaction/summary',
                sessionId, project: session?.header?.cwd ?? null,
              })
              if (r.action === 'ADD' || r.action === 'UPDATE') stored++
              else if (r.action === 'NOOP') idem++
              else blocked++
            }
            if (cands.length > 0) {
              ctx.logger.info(
                `dsh-lcm memory: 从折叠摘要提取 ${cands.length} 条（入库 ${stored}，幂等 ${idem}，禁写 ${blocked}）`,
              )
            }
            // 配置了 OpenViking：顺手冲 outbox（异步、失败静默——本地库才是 source of truth）
            if (meterBase.openvikingConfigured) {
              memory.flushOutbox(meterBase).catch(() => {})
            }
          } catch (error) {
            ctx.logger.warn(`dsh-lcm: memory extract failed: ${String(error?.message ?? error)}`)
          }
        }
      }
    } catch { /* 观测臂失败静默 */ }
  })

  ctx.logger.info(`dsh-lcm loaded: mode=${cfg.mode} maxInlineChars=${cfg.maxInlineChars} pruneProactive=${cfg.pruneProactive} memoryInject=${cfg.memoryInjectMode}`)
  // 终端可见性：ctx.logger 不进 stdout，启动确认行直接 console（与其他 dsh 插件一致）
  console.log(`[dsh-lcm] loaded, mode=${cfg.mode}, maxInlineChars=${cfg.maxInlineChars}, pruneProactive=${cfg.pruneProactive}, memoryInject=${cfg.memoryInjectMode}`)
}
