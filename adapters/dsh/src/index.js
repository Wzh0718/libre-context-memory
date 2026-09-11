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

import { compress } from '../../../core/compress.mjs'
import { loadConfig } from '../../../core/config.mjs'
import * as meter from '../../../core/meter.mjs'
import * as spill from '../../../core/spill.mjs'

export const name = 'dsh-lcm'

/** 与 docs/03 对齐的默认阈值：p90 工具输出 19,865 字符，多数调用不打扰。 */
const DEFAULTS = {
  mode: 'shadow',
  maxInlineChars: 20_000,
  lcmRoot: undefined, // 数据根（.lcm/ 落点）：默认取会话 cwd / 进程 cwd
  // —— 主动预算剪枝臂 ——
  // 用户拍板：不按单条内容的尺寸/年龄设死规则（第一轮就可能来超大输出，
  // 尺寸/年龄与语义价值无关）。驱动 = 会话总 token 预算；超预算时按
  // 「最大者优先」批量替换，一次击穿办多件事。
  budgetTokens: 100_000,   // 会话总量（tokenMeter）超过此值触发剪枝
  targetTokens: 60_000,    // 剪到此值以下停手（滞回带，避免每轮都剪）
  pruneMinChars: 2_000,    // 候选下限：比这小的剪了也没收益
  // 冷却：一次剪枝会击穿前缀缓存，剪完立刻又剪 = 反复击穿（实测踩到过）。
  // 剪枝后要等会话再长这么多 token 才允许下一次——这是「臂的节流」，
  // 不是对单条内容设尺寸/年龄规则。
  pruneCooldownTokens: 10_000,
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
 * @returns {{tools: object[], stats: object}}
 */
export function trimTools(tools, cfg) {
  const maxChars = cfg.toolMaxDescriptionChars
  const drop = new Set(cfg.dropToolFamilies ?? [])
  const familiesDropped = new Set()
  const out = []
  let charsBefore = 0
  let charsAfter = 0
  let descTrimmed = 0
  for (const tool of tools) {
    const family = familyOf(tool?.name)
    if (family !== null && drop.has(family)) { familiesDropped.add(family); continue }
    const desc = typeof tool?.description === 'string' ? tool.description : ''
    charsBefore += [...desc].length
    let next = desc
    if (maxChars > 0 && [...desc].length > maxChars) {
      next = trimDescription(desc, maxChars)
      if (next !== desc) descTrimmed++
    }
    charsAfter += [...next].length
    out.push(next === desc ? tool : { ...tool, description: next })
  }
  return {
    tools: out,
    stats: {
      toolsBefore: tools.length, toolsAfter: out.length,
      charsBefore, charsAfter, descTrimmed,
      families: [...familiesDropped],
      changed: tools.length - out.length + descTrimmed,
    },
  }
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
      meter.record(lcmCfg, {
        kind: 'compress', type: r.type,
        originalChars: r.originalChars, compressedChars: [...r.summary].length,
        ratio: Number(r.ratio.toFixed(2)),
        spillId: ref?.spillId ?? null, backend: ref?.backend ?? 'shadow',
        storedBytes: ref?.bytes ?? null, compressed: ref?.compressed ?? null,
        harness: 'dsh', sessionId: sessionId ?? null,
      })
      if (ref?.sweep && (ref.sweep.removed > 0 || ref.sweep.reason)) {
        meter.record(lcmCfg, {
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
  ctx.on('system-prompt/assemble', async (assembly, _context, next) => {
    const out = await next()
    try {
      const tools = out?.tools
      if (!Array.isArray(tools) || tools.length === 0) return out
      const trimMode = cfg.staticTrimMode ?? cfg.mode
      const { tools: trimmed, stats } = trimTools(tools, cfg)
      if (stats.changed === 0) return out
      const lcmCfg = loadConfig(cfg.lcmRoot ?? process.cwd())
      meter.record(lcmCfg, {
        kind: 'static-trim', mode: trimMode,
        toolsBefore: stats.toolsBefore, toolsAfter: stats.toolsAfter,
        charsBefore: stats.charsBefore, charsAfter: stats.charsAfter,
        descTrimmed: stats.descTrimmed, families: stats.families,
      })
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
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    try {
      const session = agent?.session
      // ctx.get() 免 inject 读取：cordis 对未声明 inject 的服务属性访问会抛错
      // （实测：ctx.tokenMeter 抛 "cannot get property without inject"，被 try/catch 吞掉
      //  → 剪枝臂静默失效）。用 ctx.get 既不硬依赖该服务，也不误伤启动。
      const tokenMeter = ctx.get?.('tokenMeter')
      if (!session?.surface || typeof session.append !== 'function') return next()
      if (!tokenMeter) {
        if (!warnedNoMeter) {
          warnedNoMeter = true
          ctx.logger.warn('dsh-lcm: tokenMeter 不可用，剪枝臂停用（压缩与观测臂不受影响）')
          console.warn('[dsh-lcm] tokenMeter 不可用，剪枝臂停用')
        }
        return next()
      }
      const measurement = tokenMeter.measure(session)
      if (!measurement || measurement.totalTokens <= cfg.budgetTokens) return next()
      const sessionKey = session.header?.id ?? 'unknown'
      const armedAt = pruneArmedAt.get(sessionKey)
      if (armedAt !== undefined && measurement.totalTokens < armedAt) return next()   // 冷却中

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
      if (candidates.length === 0) return next()

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
      if (picks.length === 0) return next()

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
      meter.record(lcmCfg, {
        kind: 'prune', sessionId, mode: cfg.mode,
        tokensBefore: measurement.totalTokens, budgetTokens: cfg.budgetTokens,
        nodes: picks.length, charsBefore, charsAfter,
        savedTokens, rearmAt: pruneArmedAt.get(sessionKey),
      })
      ctx.logger.info(
        `dsh-lcm ${isShadow ? '[shadow] ' : ''}prune: ${picks.length} 节点 ${charsBefore.toLocaleString()}→${charsAfter.toLocaleString()} 字符`
        + `（压力 ${measurement.totalTokens.toLocaleString()} > 预算 ${cfg.budgetTokens.toLocaleString()}）`,
      )
    } catch (error) {
      ctx.logger.warn(`dsh-lcm: prune failed: ${String(error?.message ?? error)}; continuing the turn`)
    }
    return next()
  }, { prepend: true })

  ctx.on('session/event', (session, event) => {
    try {
      const type = event?.type
      const lcmRoot = cfg.lcmRoot ?? session?.header?.cwd ?? process.cwd()
      const lcmCfg = loadConfig(lcmRoot)
      const sessionId = session?.header?.id ?? null

      if (type === 'assistant/message' && event?.data?.usage) {
        const u = event.data.usage
        // DSH usage 口径（实测验算：input+cacheRead+output = totalTokens）：
        // inputTokens 本身就不含 cacheRead → fresh = input，总量 = input + cacheRead
        const fresh = u.inputTokens ?? 0
        const cacheRead = u.cacheReadTokens ?? 0
        const total = fresh + cacheRead
        meter.record(lcmCfg, {
          kind: 'usage', sessionId,
          input: fresh, cacheRead, fresh,
          hitRate: total > 0 ? Number((cacheRead / total).toFixed(4)) : null,
          output: u.outputTokens ?? null,
          // 击穿苗头：新增很小却大额 fresh（阈值对齐 docs/01：fresh>50k）
          cacheBust: fresh > 50_000,
        })
      } else if (typeof type === 'string' && type.startsWith('compaction/')) {
        meter.record(lcmCfg, {
          kind: 'compaction', sessionId, op: type,
          shadowedTokens: event?.data?.shadowedTokenCount ?? null,
        })
      }
    } catch { /* 观测臂失败静默 */ }
  })

  ctx.logger.info(`dsh-lcm loaded: mode=${cfg.mode} maxInlineChars=${cfg.maxInlineChars}`)
  // 终端可见性：ctx.logger 不进 stdout，启动确认行直接 console（与其他 dsh 插件一致）
  console.log(`[dsh-lcm] loaded, mode=${cfg.mode}, maxInlineChars=${cfg.maxInlineChars}`)
}
