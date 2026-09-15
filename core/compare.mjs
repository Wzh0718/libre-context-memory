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

import { meterFiles, freshOf } from './meter.mjs'
import { readFileSync } from 'node:fs'

export const CHARS_PER_TOKEN = 2
export const CACHED_PRICE = 0.1

/** 读取全部计量事件并按时间排序（多个轮转文件合并；usage 事件归一化 fresh）。 */
export function loadEvents(cfg, { project } = {}) {
  const events = []
  for (const file of meterFiles(cfg)) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line) continue
      try { events.push(JSON.parse(line)) } catch { /* 坏行跳过 */ }
    }
  }
  const filtered = project
    ? events.filter((e) => e.project === project || (typeof e.project === 'string' && e.project.endsWith('/' + project)))
    : events
  for (const e of filtered) {
    if (e.kind === 'usage') e.fresh = freshOf(e)   // 旧口径 fresh=0/input=N 归一
  }
  return filtered.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0))
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
export function compare(cfg, { bustThresholdTokens = 50_000, project } = {}) {
  const events = loadEvents(cfg, { project })
  const usage = events.filter((e) => e.kind === 'usage')
  if (usage.length === 0) return { requests: 0 }

  const perSession = new Map()   // sessionId → 累计已治理字符数
  // 击穿归因：记录自上个 usage 以来该会话发生过什么。
  // compaction 优先于剪枝——搭便车剪枝总是紧跟折叠发生，同一间隔里的击穿是折叠造成的，
  // 只有「间隔内只有剪枝、没有折叠」的击穿才归因 lcm（主动模式才会产生这种）。
  const sinceUsage = new Map()   // sessionId → Set('compaction'|'prune')
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
      if (!sinceUsage.has(id)) sinceUsage.set(id, new Set())
      sinceUsage.get(id).add('prune')
      continue
    }
    if (event.kind === 'compaction') {
      const id = event.sessionId ?? 'unknown'
      if (!sinceUsage.has(id)) sinceUsage.set(id, new Set())
      sinceUsage.get(id).add('compaction')
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
      const causes = sinceUsage.get(id) ?? new Set()
      const attributedToLcm = causes.has('prune') && !causes.has('compaction')
      busts.push({
        ts: event.ts, fresh, extra: fresh * (1 - CACHED_PRICE), sessionId: id,
        attributedToLcm,
        cause: attributedToLcm ? 'lcm剪枝' : (causes.has('compaction') ? 'compaction' : '重启/换会话'),
      })
    }
    sinceUsage.delete(id)
  }

  const equivalent = totalFresh + CACHED_PRICE * totalCached
  const counterfactual = cfFresh + CACHED_PRICE * cfCached
  const savings = counterfactual - equivalent
  const bustExtra = busts.reduce((a, b) => a + b.extra, 0)
  const lcmBusts = busts.filter((b) => b.attributedToLcm)
  const lcmBustExtra = lcmBusts.reduce((a, b) => a + b.extra, 0)
  const byCause = {}
  for (const b of busts) byCause[b.cause] = (byCause[b.cause] ?? 0) + 1
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
      // 归因（compaction 优先）：间隔内只有剪枝没有折叠才算 lcm；
      // 折叠造成的算 DSH 内置行为；两者都没有的是重启/换会话
      lcmCount: lcmBusts.length,
      lcmExtraEquivalent: lcmBustExtra,
      byCause,
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
