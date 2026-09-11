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

/** 计量文件清单：兼容旧版单文件 meter.jsonl 与按月轮转文件。 */
export function meterFiles(cfg) {
  const dir = dirname(cfg.meterFile)
  if (!existsSync(dir)) return []
  const names = readdirSync(dir)
    .filter((n) => /^meter(-\d{6})?\.jsonl$/.test(n))
    .sort()
  return names.map((n) => join(dir, n))
}

export function summary(cfg) {
  const files = meterFiles(cfg)
  if (files.length === 0) return { events: 0, files: [] }
  const events = []
  for (const file of files) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line) continue
      try { events.push(JSON.parse(line)) } catch { /* 坏行跳过 */ }
    }
  }

  const compress = events.filter((e) => e.kind === 'compress')
  const retrieves = events.filter((e) => e.kind === 'retrieve')
  const usage = events.filter((e) => e.kind === 'usage')
  const compactions = events.filter((e) => e.kind === 'compaction')
  const prunes = events.filter((e) => e.kind === 'prune')
  const trims = events.filter((e) => e.kind === 'static-trim')
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
  const freshSorted = usage.map((e) => e.fresh ?? 0).sort((a, b) => a - b)
  const totalFresh = usage.reduce((a, e) => a + (e.fresh ?? 0), 0)
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
    costEquivalent: usage.reduce((a, e) => a + (e.fresh ?? 0), 0) + 0.1 * totalCacheRead,
  }

  const sweeps = events.filter((e) => e.kind === 'spill-sweep')
  return {
    events: events.length,
    files,
    sweeps: sweeps.length,
    spillFreedBytes: sweeps.reduce((a, e) => a + (e.freedBytes ?? 0), 0),
    usage: usageStats,
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
  }
}
