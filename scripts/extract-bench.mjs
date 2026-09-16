#!/usr/bin/env node
/** 提取器质量 benchmark：真实会话批量跑 extractCandidates + record 四选一，
 * 输出修复前后可对比的质量指标。噪声特征全部自动判定（无需人工标注）。
 *
 * 用法：node scripts/extract-bench.mjs [--sessions N] [--only-md]
 * 指标：
 *   候选总数 / 每轮密度        —— 打分门槛的调节对象
 *   表格行噪声率               —— claim 以 | 开头（脱离表头无语义）
 *   引用前缀率                 —— claim 以 > 开头（引用块标记未清理）
 *   冗余 subject 率            —— subject === claim 前 40 字（零信息锚点）
 *   低信号率                   —— 无路径/数字/版本/代码锚的纯散文碎片
 *   REJECT 率                  —— record 阶段被拒（禁写/低分）比例
 */

import { readdirSync, statSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readSessionLog } from '../core/recover.mjs'
import * as memory from '../core/memory.mjs'
import { loadConfig } from '../core/config.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const SESSIONS_DIR = resolve(HERE, '../../../.dsh/sessions/--home-libre-project-libre-context-memory--')
const argv = process.argv.slice(2)
const N = Number(argv.find((a, i) => argv[i - 1] === '--sessions') ?? 6)

// ---------- 收集真实轮次（与 fold-demo 同款过滤：跳过插件注入）----------
function turnsOf(logPath) {
  const turns = []
  let text
  try { text = readSessionLog(logPath) } catch { return turns }
  for (const line of text.split('\n')) {
    if (!line.trim().startsWith('{')) continue
    let ev; try { ev = JSON.parse(line) } catch { continue }
    if (ev.type === 'user/message' && ev.data?.source?.kind === 'user') {
      const t = (ev.data.content ?? []).filter((b) => b?.type === 'text').map((b) => b.text).join('\n').trim()
      if (t) turns.push({ text: t, role: 'user' })
    } else if (ev.type === 'assistant/message') {
      const t = (ev.data?.message?.content ?? []).filter((b) => b?.type === 'text').map((b) => b.text).join('\n').trim()
      if (t) turns.push({ text: t, role: 'assistant' })
    }
  }
  return turns
}

const dirs = readdirSync(SESSIONS_DIR)
  .map((d) => join(SESSIONS_DIR, d))
  .filter((d) => statSync(d).isDirectory())
  .map((d) => join(d, 'session.jsonl.zstd'))
  .filter(existsSync)
  .sort((a, b) => statSync(b).size - statSync(a).size)
  .slice(0, N)

let totalTurns = 0
const allCands = []
for (const log of dirs) {
  const turns = turnsOf(log)
  totalTurns += turns.length
  for (const { text, role } of turns) for (const c of memory.extractCandidates(text, { role })) allCands.push(c)
}

// ---------- record 四选一（隔离库）----------
process.env.LCM_OPENVIKING_DISABLED = '1'
const root = resolve(HERE, '../.bench-lcm')
const cfg = loadConfig(resolve(HERE, '..'), { meterRoot: root })
const actions = { ADD: 0, UPDATE: 0, NOOP: 0, DELETE: 0, REJECT: 0 }
for (const c of allCands) {
  const r = memory.record(cfg, { ...c, source: 'incremental' })
  actions[r.action] = (actions[r.action] ?? 0) + 1
}
const live = memory.activeEntries(cfg)

// ---------- 噪声特征判定 ----------
const is = {
  tableRow: (c) => c.claim.trimStart().startsWith('|'),
  quotePrefix: (c) => c.claim.trimStart().startsWith('>'),
  redundantSubject: (c) => c.subject.length >= 20 && c.claim.startsWith(c.subject.slice(0, 20)),
  lowSignal: (c) => !/(\/[\w.-]{2,}|\d+(?:\.\d+)?%?|v?\d+\.\d+|`[^`]+`|https?:\/\/)/.test(c.claim),
}
const pct = (n) => ((n / Math.max(1, allCands.length)) * 100).toFixed(1) + '%'
const count = (pred) => allCands.filter(pred).length

// ---------- 输出 ----------
console.log(`benchmark · ${dirs.length} 个真实会话 · ${totalTurns} 轮 · 候选 ${allCands.length} 条 · 入库存活 ${live.length} 条`)
console.log('─────────────────────────────────────────────────────')
console.log(`  密度        ${ (allCands.length / Math.max(1, totalTurns)).toFixed(2) } 候选/轮`)
console.log(`  表格行噪声  ${pct(count(is.tableRow))}（${count(is.tableRow)} 条）`)
console.log(`  引用前缀    ${pct(count(is.quotePrefix))}（${count(is.quotePrefix)} 条）`)
console.log(`  冗余subject ${pct(count(is.redundantSubject))}（${count(is.redundantSubject)} 条）`)
console.log(`  低信号碎片  ${pct(count(is.lowSignal))}（${count(is.lowSignal)} 条）`)
console.log(`  四选一      ` + Object.entries(actions).map(([k, v]) => `${k}:${v}`).join(' '))
console.log(`  类型分布    ` + Object.entries(allCands.reduce((a, c) => (a[c.type] = (a[c.type] ?? 0) + 1, a), {})).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}×${v}`).join(' '))
console.log(`  候选样例（前 6 条）`)
for (const c of allCands.slice(0, 6)) {
  console.log(`    [${c.type}·${c.score}] ${c.claim.slice(0, 55).replace(/\n/g, ' ')}…`)
}
console.log(`  入库存活 ${live.length} 条（benchmark 的真正产出）`)
for (const e of live.slice(0, 10)) {
  console.log(`    [${e.type}·${e.score}] ${e.claim.slice(0, 55).replace(/\n/g, ' ')}…`)
}
