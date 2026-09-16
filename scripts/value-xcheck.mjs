#!/usr/bin/env node
/** 价值模型交叉验证门（P4）：在真实台账上跑 computeValue，
 * 断言「成本当量口径 vs 载荷口径」同向同量级（ratio ∈ [0.3, 3]）。
 *
 * 这是首版定价 bug（54.8% vs bench-all 11.9%，差 4.6 倍）的自动防线——
 * 人工比对变成退出码：一致 0，不一致 1。
 *
 * 用法：node scripts/value-xcheck.mjs [--days N]
 */

import { loadConfig } from '../core/config.mjs'
import { computeValue } from '../core/value.mjs'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

process.env.LCM_OPENVIKING_DISABLED = '1'

const daysArg = process.argv.find((a) => a === '--days')
const days = daysArg ? Number(process.argv[process.argv.indexOf('--days') + 1]) : 0

const cfg = loadConfig(process.cwd(), { meterRoot: join(homedir(), '.lcm') })

// 多根收集（与 CLI 同规则：全局根 + 全项目 .lcm）
const roots = new Set([cfg.meterDir])
const projBase = join(homedir(), 'project')
if (existsSync(projBase)) {
  for (const p of readdirSync(projBase)) {
    const d = join(projBase, p, '.lcm')
    if (existsSync(d)) roots.add(d)
  }
}
const events = []
for (const dir of roots) {
  for (const n of readdirSync(dir)) {
    if (!/^meter(-\d{6})?\.jsonl$/.test(n)) continue
    for (const line of readFileSync(join(dir, n), 'utf8').split('\n')) {
      if (!line.trim()) continue
      try { events.push(JSON.parse(line)) } catch { /* 坏行 */ }
    }
  }
}
const since = days > 0 ? Date.now() - days * 86_400_000 : 0
const windowed = since > 0 ? events.filter((e) => (e.ts ?? 0) >= since) : events

// provenance：只统计真实会话
const known = new Set()
const sessionsDir = join(homedir(), '.dsh', 'sessions')
if (existsSync(sessionsDir)) {
  for (const proj of readdirSync(sessionsDir)) {
    try {
      for (const sid of readdirSync(join(sessionsDir, proj))) known.add(sid)
    } catch { /* 非目录 */ }
  }
}

const v = computeValue(windowed, { knownSessions: known })
const M = (n) => Math.abs(n) >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1e3)}k`

console.log(`交叉验证门（${v.sessions} 会话 / ${v.requests} 请求${days > 0 ? ` / 近 ${days} 天` : ''}）`)
console.log(`  成本当量口径：净省 ${M(v.net)} = ${(v.netPct * 100).toFixed(2)}%（占反事实 ${M(v.counterfactualEq)}）`)
console.log(`  载荷口径：    净省 ${M(v.payload.saved)} = ${(v.payload.pct * 100).toFixed(2)}%（占反事实载荷）`)
console.log(`  ratio = ${v.xcheck.ratio == null ? '—（载荷侧无节省）' : v.xcheck.ratio.toFixed(3)}，要求 ∈ [${v.xcheck.band.join(', ')}] 且同向`)

if (!v.xcheck.consistent) {
  console.error('✗ 不一致——价值模型有 bug（定价或窗口逻辑回归），此账不可信')
  process.exit(1)
}
console.log('✓ 同向同量级——两口径互证通过')
