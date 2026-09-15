#!/usr/bin/env node
/** 真实会话实时体检：确认运行中的 DSH 到底加载了哪版插件、五臂是否在写数据。
 *
 * 用法：node scripts/live-check.mjs [分钟数，默认 30]
 *
 * 判据（新代码 vs 旧代码）：
 * - 新代码：事件写**全局根** ~/.lcm，且 kind 里会出现 memory/memory-inject/fold/memory-profile
 * - 旧代码：事件散落在 <会话 cwd>/.lcm，只有 usage/compress/compaction/prune
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const WINDOW_MIN = Number(process.argv[2] ?? 30)
const GLOBAL_ROOT = process.env.LCM_METER_ROOT ?? join(homedir(), '.lcm')
const since = Date.now() - WINDOW_MIN * 60_000

function readEvents(dir) {
  const out = []
  if (!existsSync(dir)) return out
  for (const f of readdirSync(dir)) {
    if (!f.startsWith('meter-') || !f.endsWith('.jsonl')) continue
    const p = join(dir, f)
    try {
      for (const line of readFileSync(p, 'utf8').split('\n')) {
        if (!line.trim()) continue
        try { out.push({ ...JSON.parse(line), _file: f }) } catch { /* 坏行 */ }
      }
    } catch { /* 跳过 */ }
  }
  return out.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0))
}

/** 扫描所有可能的事件落点：全局根 + 各项目 .lcm（找出「事件写到哪」）。 */
function findRoots() {
  const roots = [GLOBAL_ROOT]
  const projBase = join(homedir(), 'project')
  if (existsSync(projBase)) {
    for (const p of readdirSync(projBase)) {
      const d = join(projBase, p, '.lcm')
      if (existsSync(d) && statSync(d).isDirectory()) roots.push(d)
    }
  }
  const cwdLcm = join(process.cwd(), '.lcm')
  if (existsSync(cwdLcm) && !roots.includes(cwdLcm)) roots.push(cwdLcm)
  return roots
}

console.log(`实时体检 · 窗口 ${WINDOW_MIN} 分钟 · 全局根 ${GLOBAL_ROOT}`)
console.log('═'.repeat(68))

// 1) 事件落点：新代码应写全局根
const roots = findRoots()
const recentByRoot = []
for (const r of roots) {
  const evs = readEvents(r).filter((e) => (e.ts ?? 0) >= since)
  if (evs.length > 0) recentByRoot.push({ root: r, events: evs })
}
if (recentByRoot.length === 0) {
  console.log(`近 ${WINDOW_MIN} 分钟无任何插件事件——DSH 可能没在跑，或插件未加载。`)
  process.exit(0)
}
for (const { root, events } of recentByRoot) {
  const kinds = {}
  for (const e of events) kinds[e.kind] = (kinds[e.kind] ?? 0) + 1
  const mark = root === GLOBAL_ROOT ? '★ 全局根' : '（项目根·旧代码落点）'
  console.log(`${root}  ${mark}`)
  console.log(`  近窗口事件 ${events.length} 条：${Object.entries(kinds).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}×${n}`).join('  ')}`)
}

const inGlobal = recentByRoot.some((r) => r.root === GLOBAL_ROOT)
const allRecent = recentByRoot.flatMap((r) => r.events)
const hasNewKinds = allRecent.some((e) => ['memory-inject', 'fold', 'memory-profile', 'memory-capacity'].includes(e.kind) || (e.kind === 'memory' && e.seen != null))

console.log('═'.repeat(68))
// 2) 记忆臂状态
const memDir = join(GLOBAL_ROOT, 'memories')
const memFile = join(memDir, 'memories.jsonl')
if (existsSync(memFile)) {
  const lines = readFileSync(memFile, 'utf8').split('\n').filter(Boolean)
  const entries = lines.map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  const live = entries.filter((e) => e.status !== 'archived' && e.status !== 'refuted' && !e.superseded_by)
  const prof = live.filter((e) => e.profile === true)
  console.log(`记忆库：${live.length} 条活跃 / ${prof.length} 条画像（共 ${entries.length} 条记录）`)
  const bySource = {}
  for (const e of live) bySource[e.source ?? '?'] = (bySource[e.source ?? '?'] ?? 0) + 1
  console.log(`  来源分布：${Object.entries(bySource).map(([k, n]) => `${k}×${n}`).join('  ')}`)
  const recentEntries = live.filter((e) => (e.ts ?? 0) >= since)
  if (recentEntries.length > 0) {
    console.log(`  近窗口新增 ${recentEntries.length} 条：`)
    for (const e of recentEntries.slice(-6)) console.log(`    [${e.type}] ${(e.subject || e.claim).slice(0, 56)}`)
  }
} else {
  console.log(`记忆库：不存在（${memFile}）——记忆臂还没产出过条目`)
}

// 3) 注入与折叠记账
const inj = allRecent.filter((e) => e.kind === 'memory-inject')
const folds = allRecent.filter((e) => e.kind === 'fold')
const extractions = allRecent.filter((e) => e.kind === 'memory')
console.log(`注入记账：${inj.length} 次（其中带画像常驻段 ${inj.filter((e) => e.profile).length} 次）`
  + `｜折叠：${folds.length} 次｜熔炼：${extractions.length} 条动作`)
if (inj.length > 0) {
  const last = inj.at(-1)
  console.log(`  末次注入：${last.entries} 条 / ${last.chars} 字符（mode=${last.mode}）查询「${String(last.query ?? '').slice(0, 40)}」`)
}

// 4) 窗口内 token 概况
const usage = allRecent.filter((e) => e.kind === 'usage' && e.input != null)
if (usage.length > 0) {
  const fresh = usage.reduce((n, e) => n + (e.input ?? 0), 0)
  const cached = usage.reduce((n, e) => n + (e.cacheRead ?? 0), 0)
  const total = fresh + cached
  console.log(`窗口内请求 ${usage.length} 次｜fresh ${fresh.toLocaleString()} tok｜缓存命中 ${(total ? (cached / total * 100).toFixed(1) : '0')}%`)
}

console.log('═'.repeat(68))
console.log(inGlobal && hasNewKinds
  ? '✅ 判定：新代码在跑（事件落全局根，且出现新事件类型）——可以开始真实会话测试'
  : inGlobal
    ? '⚠️ 判定：事件已落全局根，但未见新事件类型（可能窗口内还没触发记忆臂；多聊几轮再看）'
    : '❌ 判定：仍是旧代码（事件写在项目根）——需要重启 DSH 才能加载新插件')
