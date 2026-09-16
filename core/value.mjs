/** 价值记账模型（core/value.mjs）——把「lcm 到底省了多少」算成账本上可复核的硬账。
 *
 * 设计：docs/06-value-accounting.md。本实现含 review 修正：
 *
 * 【定价修正】首版试算把臂动作省下的 delta 按 1.0× fresh 计入**每一个**后续请求，
 * 虚高约 7 倍（54.8% → 修正后约一位数~十几 %）。修正后按内容实际所处缓存档计价：
 * - prune/fold：被剪内容早已躺在缓存前缀里 → 后续请求按折价计；**击穿请求**
 *   （cacheBust 或 fresh ≥ bustMinFreshTokens，整段前缀重发）按 1.0× 计
 * - compress：reshape 发生在执行时——无臂世界里完整内容会作为**新内容**进入下一个
 *   请求（tail append = fresh）→ 首个后续请求按 1.0× 计，之后同 prune 规则
 * - 注入：负项；同会话首次 1.0×、重复按折价（digest 稳定假设，块内容不变时进缓存前缀）
 *
 * 【窗口修正】不夹窗口会算出「节省 > 实际花费」（不可能）。反事实 delta 必须夹在
 * ceiling − 实际载荷 以内；ceiling = max(会话实际最大载荷, min(全局反事实水位 L,
 * 模型窗口 − 输出预留))；L = 各会话 compaction 事件前载荷的中位（DSH 内置压缩的
 * 实测触发水位——无 lcm 时载荷也会被控制在这附近），无观测时退到 compactionCeiling。
 *
 * 【守恒不变量】（测试锁定）：反事实 ≥ 实际（逐请求由构造保证，总量断言）｜
 * 节省 ≤ 反事实｜无动作时节省恰为 0｜确定性（同输入逐字节同输出）｜单调性。
 *
 * 【归因边界】本模型是 lcm 单独贡献的**上界**：反事实假设内容会一直留在历史中，
 * 而 DSH 内置压缩也会动手。报告必须标注口径，并与 bench-all 载荷口径交叉验证。
 *
 * 纯函数、零 IO——输入 meter 事件数组，输出价值模型；CLI 负责收集事件与排版。
 */

export const VALUE_DEFAULTS = {
  cacheFactor: 0.1,             // 缓存折价（对齐 05 记分卡 fresh + 0.1×cached）
  windowTokens: 1_000_000,      // 模型上下文窗口（request/context 实测 1M）
  reserveTokens: 60_000,        // 输出预留
  bustMinFreshTokens: 50_000,   // fresh ≥ 此值视为缓存击穿（与适配器 bustThreshold 一致）
  compactionCeiling: 500_000,   // 无 compaction 观测时的反事实水位兜底
}

/** 事件数组 → 价值模型。opts.knownSessions: Set 时只统计集合内的会话（provenance 过滤）。 */
export function computeValue(events, opts = {}) {
  const cfg = { ...VALUE_DEFAULTS, ...opts }
  const known = opts.knownSessions ?? null

  // 1) 过滤 + 按会话分组（value 模型必须按会话归因；无 sessionId 的事件无法归因）。
  // 例外：static-trim 是全局事件（真实数据里就没有 sessionId）——无法归因到会话，
  // 这正是它只进「估算行」的原因；在分组前单独收集。
  const byS = new Map()
  const staticTrimSamples = []
  for (const e of events) {
    if (!e || typeof e !== 'object') continue
    if (e.kind === 'static-trim' && e.mode === 'active') {
      if (known && typeof e.sessionId === 'string' && !known.has(e.sessionId)) continue
      const T = Math.round(((e.charsBefore ?? 0) - (e.charsAfter ?? 0)) / 2)
      if (T > 0) staticTrimSamples.push(T)
      continue
    }
    const sid = e.sessionId
    if (typeof sid !== 'string' || sid.length === 0) continue
    if (known && !known.has(sid)) continue
    if (!byS.has(sid)) byS.set(sid, [])
    byS.get(sid).push(e)
  }
  for (const arr of byS.values()) arr.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0))

  // 2) 全局反事实水位 L：各会话「compaction 事件前最近一次 usage 的载荷」的中位
  const levels = []
  for (const arr of byS.values()) {
    let lastPayload = null
    for (const e of arr) {
      if (e.kind === 'usage' && typeof e.input === 'number') {
        lastPayload = (e.input ?? 0) + (e.cacheRead ?? 0)
      } else if (e.kind === 'compaction' && lastPayload != null) {
        levels.push(lastPayload)
        lastPayload = null
      }
    }
  }
  const L = levels.length > 0 ? median(levels) : cfg.compactionCeiling
  const hardCeiling = Math.min(L, cfg.windowTokens - cfg.reserveTokens)

  // 3) 逐会话累加
  let requests = 0, actualEq = 0, counterfactualEq = 0, cappedRequests = 0
  let injectionCost = 0, avoidedBust = 0
  let injects = 0, injectEntries = 0
  const freshSaved = { compress: 0, prune: 0, fold: 0 }    // 按 1.0× 计的部分
  const cachedSaved = { compress: 0, prune: 0, fold: 0 }   // 按折价计的部分（成本，已乘档价）

  for (const arr of byS.values()) {
    const usages = arr.filter((e) => e.kind === 'usage' && typeof e.input === 'number')
    const sessionMaxPayload = Math.max(0, ...usages.map((u) => (u.input ?? 0) + (u.cacheRead ?? 0)))
    const ceiling = Math.max(sessionMaxPayload, hardCeiling)

    // 臂动作（按 ts 序）：S = 省下的 token 数
    const actions = []
    for (const e of arr) {
      if (e.kind === 'prune' || e.kind === 'fold') {
        const S = Math.round(((e.charsBefore ?? 0) - (e.charsAfter ?? 0)) / 2)
        if (S > 0) actions.push({ ts: e.ts ?? 0, arm: e.kind, S, firstFresh: false })
      } else if (e.kind === 'compress') {
        const S = Math.round(((e.originalChars ?? 0) - (e.compressedChars ?? 0)) / 2)
        if (S > 0) actions.push({ ts: e.ts ?? 0, arm: 'compress', S, firstFresh: true })
      }
    }
    actions.sort((a, b) => a.ts - b.ts)

    // avoidedBust（单列）：每个动作时刻的载荷 = 动作前最近一次 usage 的载荷。
    // 含义：同样的改写若发生在热窗口，需整段前缀全价重发一次；piggyback 让它落在
    // 冷窗口（缓存本就要重建，边际成本 ≈ 0）——这是「设计避免的损失」，不计入净节省。
    for (const a of actions) {
      let priorPayload = 0
      for (const u of usages) {
        if ((u.ts ?? 0) <= a.ts) priorPayload = (u.input ?? 0) + (u.cacheRead ?? 0)
        else break
      }
      avoidedBust += priorPayload
    }

    // 注入：负项；同会话首次 1.0×、重复折价
    let firstInject = true
    for (const e of arr) {
      if (e.kind !== 'memory-inject') continue
      const T = Math.round((e.chars ?? 0) / 2)
      injectionCost += T * (firstInject ? 1 : cfg.cacheFactor)
      firstInject = false
      injects++
      injectEntries += e.entries ?? 0
    }

    // 逐请求：delta = min(active 累计节省, 窗口余量)，按动作 ts 序（老者先）填充归因
    let ai = 0
    const active = []
    for (const u of usages) {
      requests++
      const input = u.input ?? 0
      const cacheRead = u.cacheRead ?? 0
      const payload = input + cacheRead
      const price = (u.cacheBust === true || input >= cfg.bustMinFreshTokens) ? 1 : cfg.cacheFactor
      const act = input + cacheRead * cfg.cacheFactor
      actualEq += act

      while (ai < actions.length && actions[ai].ts <= (u.ts ?? 0)) active.push(actions[ai++])

      const room = Math.max(0, ceiling - payload)
      let activeTotal = 0
      for (const a of active) activeTotal += a.S
      if (activeTotal > room) cappedRequests++

      let remaining = room
      let deltaCost = 0
      for (const a of active) {
        if (remaining <= 0) break
        const take = Math.min(a.S, remaining)
        if (take <= 0) continue
        if (a.firstFresh) {
          a.firstFresh = false
          freshSaved[a.arm] += take
          deltaCost += take
        } else {
          cachedSaved[a.arm] += take * price   // price 已是 1 或折价，直接入成本
          deltaCost += take * price
        }
        remaining -= take
      }
      counterfactualEq += act + deltaCost
    }
  }

  // 4) 汇总（整数 tok-当量；浮点误差在出口统一收拢）
  const realized = { compress: 0, prune: 0, fold: 0, total: 0 }
  for (const arm of ['compress', 'prune', 'fold']) {
    realized[arm] = Math.round(freshSaved[arm] + cachedSaved[arm])
  }
  realized.total = realized.compress + realized.prune + realized.fold

  actualEq = Math.round(actualEq)
  counterfactualEq = Math.round(counterfactualEq)
  injectionCost = Math.round(injectionCost)

  const net = realized.total - injectionCost
  return {
    sessions: byS.size,
    requests,
    factor: cfg.cacheFactor,
    actualEq,
    counterfactualEq,
    realized,
    injectionCost,
    net,
    netPct: counterfactualEq > 0 ? net / counterfactualEq : 0,
    avoidedBust,
    cappedRequests,
    memory: { injects, entries: injectEntries },
    estimated: { staticTrimPerRequest: staticTrimSamples.length > 0 ? Math.round(median(staticTrimSamples)) : 0 },
    ceiling: {
      global: Math.round(L),
      source: levels.length > 0 ? 'compaction' : 'fallback',
      samples: levels.length,
    },
  }
}

function median(nums) {
  const s = [...nums].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}
