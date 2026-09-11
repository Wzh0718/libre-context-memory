/** token 消耗对比：实际（装了 lcm）vs 反事实（不装 lcm）。
 *
 * 方法论（为什么只能这么做）：
 * - 真实 usage 只告诉我们**现在**的账：fresh / cached（DSH 口径：input 不含 cacheRead）。
 * - 想知道「不装 lcm 会花多少」，只能做反事实：lcm 从上下文里剪掉的体积，如果不剪，
 *   就会留在前缀里被后续每一轮重发。剪枝/压缩事件本身记录了被剪掉的字符数，
 *   所以可以逐请求累加「此刻已治理掉的存量」，再按缓存价折算。
 * - 口径与报价：当量 = fresh + 0.1 × cached；字符→token 用 2 字符/token（保守，
 *   混合中英文文本实测约 1.9~2.2）。
 * - 保守之处：反事实里被剪掉的体积按**缓存价**计（实际还会在缓存击穿时按全价重发），
 *   所以这里的节省是**下界**。
 * - 击穿成本单独列出并计入净收益：lcm 每次剪枝会打穿一次前缀，代价 ≈ 该次 fresh × 0.9
 *   （相对缓存价多付的部分）。
 */

import { meterFiles } from './meter.mjs'
import { readFileSync } from 'node:fs'

export const CHARS_PER_TOKEN = 2
export const CACHED_PRICE = 0.1

/** 读取全部计量事件并按时间排序（多个轮转文件合并）。 */
export function loadEvents(cfg) {
  const events = []
  for (const file of meterFiles(cfg)) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line) continue
      try { events.push(JSON.parse(line)) } catch { /* 坏行跳过 */ }
    }
  }
  return events.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0))
}

/** 事件是否代表「真的动了上下文」（shadow 只记账，不算治理量）。 */
function isRealTrim(event) {
  if (event.kind === 'prune') return event.mode === 'active'
  if (event.kind === 'compress') return event.backend !== 'shadow' && event.backend !== null
  return false
}

/** 单次治理事件削掉的字符数。 */
function trimmedCharsOf(event) {
  if (event.kind === 'prune') return Math.max(0, (event.charsBefore ?? 0) - (event.charsAfter ?? 0))
  if (event.kind === 'compress') return Math.max(0, (event.originalChars ?? 0) - (event.compressedChars ?? 0))
  return 0
}

/**
 * 对比分析。
 * @returns 结构化结果：窗口/分组统计/反事实对比/击穿成本/净收益
 */
export function compare(cfg, { bustThresholdTokens = 50_000 } = {}) {
  const events = loadEvents(cfg)
  const usage = events.filter((e) => e.kind === 'usage')
  if (usage.length === 0) return { requests: 0 }

  const perSession = new Map()   // sessionId → 累计已治理字符数
  const pendingTrim = new Set()  // 刚发生过真剪枝、尚未结算的会话（用于击穿归因）
  let totalFresh = 0
  let totalCached = 0
  let cfFresh = 0
  let cfCached = 0
  let trimmedTokensTotal = 0
  let trimmedEvents = 0
  const beforeTrim = []          // 该会话「尚未被治理」时的请求（自然对照组）
  const afterTrim = []           // 已被治理后的请求
  const busts = []

  for (const event of events) {
    if (isRealTrim(event)) {
      const id = event.sessionId ?? 'unknown'
      const chars = trimmedCharsOf(event)
      perSession.set(id, (perSession.get(id) ?? 0) + chars)
      trimmedTokensTotal += Math.ceil(chars / CHARS_PER_TOKEN)
      trimmedEvents++
      if (chars > 0) pendingTrim.add(id)
      continue
    }
    if (event.kind !== 'usage') continue

    const id = event.sessionId ?? 'unknown'
    const trimmedTokens = Math.ceil((perSession.get(id) ?? 0) / CHARS_PER_TOKEN)
    const fresh = event.fresh ?? 0
    const cached = event.cacheRead ?? 0
    totalFresh += fresh
    totalCached += cached
    // 反事实：被剪掉的存量若不剪，仍在前缀里（保守按缓存价）
    cfFresh += fresh
    cfCached += cached + trimmedTokens
    const equivalent = fresh + CACHED_PRICE * cached
    const row = { ts: event.ts, equivalent, fresh, cached, trimmedTokens }
    if (trimmedTokens > 0) afterTrim.push(row)
    else beforeTrim.push(row)
    if (fresh > bustThresholdTokens) {
      const entry = { ts: event.ts, fresh, extra: fresh * (1 - CACHED_PRICE), sessionId: id, attributedToLcm: pendingTrim.has(id) }
      busts.push(entry)
      if (entry.attributedToLcm) pendingTrim.delete(id)
    }
  }

  const equivalent = totalFresh + CACHED_PRICE * totalCached
  const counterfactual = cfFresh + CACHED_PRICE * cfCached
  const savings = counterfactual - equivalent
  const bustExtra = busts.reduce((a, b) => a + b.extra, 0)
  const lcmBusts = busts.filter((b) => b.attributedToLcm)
  const lcmBustExtra = lcmBusts.reduce((a, b) => a + b.extra, 0)
  const avg = (rows, field = 'equivalent') => (rows.length ? rows.reduce((a, r) => a + r[field], 0) / rows.length : 0)
  const averagePerRequest = equivalent / usage.length

  return {
    requests: usage.length,
    sessions: new Set(usage.map((e) => e.sessionId)).size,
    window: {
      from: usage[0]?.ts ?? null,
      to: usage[usage.length - 1]?.ts ?? null,
    },
    actual: {
      fresh: totalFresh,
      cached: totalCached,
      equivalent,
      perRequest: equivalent / usage.length,
      hitRate: (totalFresh + totalCached) > 0 ? totalCached / (totalFresh + totalCached) : null,
    },
    counterfactual: {
      fresh: cfFresh,
      cached: cfCached,
      equivalent: counterfactual,
      perRequest: counterfactual / usage.length,
    },
    savings: {
      equivalent: savings,
      percent: counterfactual > 0 ? savings / counterfactual : 0,
      trimmedTokensTotal,
      trimmedEvents,
    },
    busts: {
      count: busts.length,
      extraEquivalent: bustExtra,
      // 归因：剪枝后该会话的第一次请求才算 lcm 引起；其余（内置折叠/重启/其他插件）不计
      lcmCount: lcmBusts.length,
      lcmExtraEquivalent: lcmBustExtra,
      list: busts.slice(-5),
    },
    net: {
      equivalent: savings - lcmBustExtra,
      percent: counterfactual > 0 ? (savings - lcmBustExtra) / counterfactual : 0,
      // 盈亏平衡：改写历史会打穿一次前缀（代价 ≈ 全价重发整段），
      // 之后每轮省下「已治理体积 × 缓存价」。需要多少个后续请求才回本：
      breakevenRequests: trimmedTokensTotal > 0
        ? Math.ceil(lcmBustExtra / (trimmedTokensTotal * CACHED_PRICE))
        : null,
      // 每次剪枝的击穿代价（等价于多少个稳态请求的钱）
      bustCostInRequests: lcmBusts.length > 0 && averagePerRequest > 0
        ? lcmBustExtra / lcmBusts.length / averagePerRequest
        : null,
    },
    groups: {
      beforeTrim: { requests: beforeTrim.length, perRequest: avg(beforeTrim) },
      afterTrim: { requests: afterTrim.length, perRequest: avg(afterTrim), avgTrimmedTokens: avg(afterTrim, 'trimmedTokens') },
    },
  }
}
