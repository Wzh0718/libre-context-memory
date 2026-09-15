/** meter（Node 版）：压缩/回取/注入事件追加写 JSONL，记分卡数据源（docs/05）。
 *
 * 选 JSONL 而非 sqlite：目标机零依赖（node:sqlite 在 Node 22 仍需 experimental flag），
 * 追加写天然适合 hook 场景，多写者并发安全（append-only）。
 * 失败静默：计量绝不阻塞主流程。
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 计量文件名：按月轮转（meter-YYYYMM.jsonl），避免单文件无限增长。 */
export function meterPathFor(cfg, now = new Date()) {
  if (cfg.meterMonthly === false) return cfg.meterFile
  const ym = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`
  return join(dirname(cfg.meterFile), `meter-${ym}.jsonl`)
}

export function record(cfg, event) {
  try {
    const file = meterPathFor(cfg)
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, JSON.stringify({ ts: Date.now(), ...event }) + '\n', 'utf8')
  } catch { /* 静默 */ }
}

/** 计量文件清单：全局 meterDir + 旧版按项目 <root>/.lcm（兼容历史落点）。 */
export function meterFiles(cfg) {
  const dirs = [...new Set([dirname(cfg.meterFile), cfg.legacyMeterDir].filter(Boolean))]
  const out = []
  for (const dir of dirs) {
    if (!existsSync(dir)) continue
    for (const n of readdirSync(dir)) {
      if (/^meter(-\d{6})?\.jsonl$/.test(n)) out.push(join(dir, n))
    }
  }
  return out.sort()
}

/**
 * usage 事件的 fresh 归一化：
 * 旧版把 fresh 记成别口径（常为 0，真实值在 input），新版 input===fresh。
 * fresh 缺失或为 0 而 input>0 时用 input，避免旧数据低估实际 fresh。
 */
export function freshOf(e) {
  if (typeof e?.fresh === 'number' && e.fresh > 0) return e.fresh
  if (typeof e?.input === 'number') return e.input
  return typeof e?.fresh === 'number' ? e.fresh : 0
}

export function summary(cfg, { project } = {}) {
  const files = meterFiles(cfg)
  if (files.length === 0) return { events: 0, files: [] }
  const events = []
  for (const file of files) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line) continue
      try { events.push(JSON.parse(line)) } catch { /* 坏行跳过 */ }
    }
  }
  const filtered = project
    ? events.filter((e) => e.project === project || (typeof e.project === 'string' && e.project.endsWith('/' + project)))
    : events

  const compress = filtered.filter((e) => e.kind === 'compress')
  const retrieves = filtered.filter((e) => e.kind === 'retrieve')
  const usage = filtered.filter((e) => e.kind === 'usage')
  const compactions = filtered.filter((e) => e.kind === 'compaction')
  const prunes = filtered.filter((e) => e.kind === 'prune')
  const trims = filtered.filter((e) => e.kind === 'static-trim')
  const memEvents = filtered.filter((e) => e.kind === 'memory')
  const memInjects = filtered.filter((e) => e.kind === 'memory-inject')
  const memSyncs = filtered.filter((e) => e.kind === 'memory-sync')
  const byType = new Map()
  for (const e of compress) {
    const k = `${e.backend === 'shadow' ? 'shadow:' : ''}${e.type ?? '?'}`
    if (!byType.has(k)) byType.set(k, { n: 0, orig: 0, comp: 0, ratios: [] })
    const s = byType.get(k)
    s.n++; s.orig += e.originalChars ?? 0; s.comp += e.compressedChars ?? 0
    if (e.ratio) s.ratios.push(e.ratio)
  }

  // 缓存账本：每请求的 fresh/cached/命中率 + 击穿苗头
  // 口径：DSH 的 inputTokens 不含 cacheRead（实测验算 input+cacheRead+output=totalTokens），
  // 所以总量 = fresh + cacheRead，命中率 = cacheRead / 总量
  const freshSorted = usage.map(freshOf).sort((a, b) => a - b)
  const totalFresh = usage.reduce((a, e) => a + freshOf(e), 0)
  const totalCacheRead = usage.reduce((a, e) => a + (e.cacheRead ?? 0), 0)
  const totalVolume = totalFresh + totalCacheRead
  const usageStats = usage.length === 0 ? null : {
    requests: usage.length,
    totalInput: totalVolume,
    totalCacheRead,
    totalFresh,
    hitRate: totalVolume > 0 ? totalCacheRead / totalVolume : null,
    freshMedian: freshSorted[Math.floor(freshSorted.length / 2)],
    freshP90: freshSorted[Math.floor(freshSorted.length * 0.9)],
    cacheBusts: usage.filter((e) => e.cacheBust).length,
    // 成本当量 = fresh + 0.1×cached（docs/02 口径）
    costEquivalent: totalFresh + 0.1 * totalCacheRead,
  }

  // 按项目分组（全局计量根下的事件带 project 字段；旧数据无 project 记为 legacy）
  const byProjectMap = new Map()
  for (const e of usage) {
    const key = e.project ?? '(legacy)'
    if (!byProjectMap.has(key)) byProjectMap.set(key, { project: key, requests: 0, fresh: 0, cached: 0, busts: 0 })
    const s = byProjectMap.get(key)
    s.requests++; s.fresh += freshOf(e); s.cached += e.cacheRead ?? 0
    if (e.cacheBust) s.busts++
  }
  const byProject = [...byProjectMap.values()].sort((a, b) => b.requests - a.requests)

  const sweeps = filtered.filter((e) => e.kind === 'spill-sweep')
  return {
    events: filtered.length,
    files,
    sweeps: sweeps.length,
    spillFreedBytes: sweeps.reduce((a, e) => a + (e.freedBytes ?? 0), 0),
    usage: usageStats,
    byProject,
    trims: trims.length,
    trimShadow: trims.filter((e) => e.mode === 'shadow').length,
    trimToolsBefore: trims.reduce((a, e) => a + (e.toolsBefore ?? 0), 0),
    trimToolsAfter: trims.reduce((a, e) => a + (e.toolsAfter ?? 0), 0),
    trimCharsBefore: trims.reduce((a, e) => a + (e.charsBefore ?? 0), 0),
    trimCharsAfter: trims.reduce((a, e) => a + (e.charsAfter ?? 0), 0),
    prunes: prunes.length,
    pruneNodes: prunes.reduce((a, e) => a + (e.nodes ?? 0), 0),
    pruneCharsBefore: prunes.reduce((a, e) => a + (e.charsBefore ?? 0), 0),
    pruneCharsAfter: prunes.reduce((a, e) => a + (e.charsAfter ?? 0), 0),
    pruneShadow: prunes.filter((e) => e.mode === 'shadow').length,
    compactions: compactions.length,
    compactionOps: compactions.map((e) => `${e.op}${e.shadowedTokens ? `(${e.shadowedTokens}tok)` : ''}`),
    compressCount: compress.length,
    totalOrig: compress.reduce((a, e) => a + (e.originalChars ?? 0), 0),
    totalComp: compress.reduce((a, e) => a + (e.compressedChars ?? 0), 0),
    byType: [...byType.entries()].map(([type, s]) => ({
      type, n: s.n, orig: s.orig, comp: s.comp,
      avgRatio: s.ratios.length ? s.ratios.reduce((a, b) => a + b, 0) / s.ratios.length : 0,
    })).sort((a, b) => b.orig - a.orig),
    retrieveCount: retrieves.length,
    retrieveHandles: new Set(retrieves.map((e) => e.spillId)).size,
    memory: {
      stored: memEvents.filter((e) => e.action === 'ADD' || e.action === 'UPDATE').length,
      noop: memEvents.filter((e) => e.action === 'NOOP').length,
      rejected: memEvents.filter((e) => e.action === 'REJECT').length,
      refuted: memEvents.filter((e) => e.action === 'DELETE').length,
      injects: memInjects.length,
      injectShadow: memInjects.filter((e) => e.mode === 'shadow').length,
      injectChars: memInjects.reduce((a, e) => a + (e.chars ?? 0), 0),
      syncOk: memSyncs.filter((e) => e.ok).length,
      syncFail: memSyncs.filter((e) => !e.ok).length,
    },
  }
}
