#!/usr/bin/env node
/** warm-folding 对比 demo：用真实会话日志展示「记忆替代 token」的效果。
 *
 * 用法：node scripts/fold-demo.mjs [会话日志路径] [--keep N 最近保留轮数]
 *
 * 对比三个状态下，一次 LLM 请求要带的对话体积：
 *   A 原始    —— 全部 user/assistant 轮次原样进请求
 *   B 折叠后  —— 已熔炼的旧轮次替换为指针行 + 尾部记忆块（warm folding 后的形态）
 *
 * 折掉的每一段都会先过真实提取器（core/memory.mjs extractCandidates）——
 * 展示「信息去哪了」：折掉的不是丢了，是换成了便宜表示。
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readSessionLog } from '../core/recover.mjs'
import * as memory from '../core/memory.mjs'
import { loadConfig } from '../core/config.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))

// ---------- 参数 ----------
const argv = process.argv.slice(2)
const KEEP = Number(argv.find((a, i) => argv[i - 1] === '--keep') ?? 6) // 最近 N 轮保留原文
const LOG = argv.find((a) => !a.startsWith('--'))
  ?? resolve(HERE, '../../../.dsh/sessions/--home-libre-project-libre-context-memory--/session-f5d28feb-3721-4eff-a0d1-55a8bbd41fca/session.jsonl.zstd')

// ---------- 解析真实会话 ----------
const text = readSessionLog(LOG)
const lines = text.split('\n').filter((l) => l.trim().startsWith('{'))
const turns = []        // { role, text, seq, time }
for (const line of lines) {
  let ev; try { ev = JSON.parse(line) } catch { continue }
  if (ev.type === 'user/message') {
    // 只认真人消息：插件注入（openviking-context 等）不是对话知识
    if (ev.data?.source?.kind !== 'user') continue
    const blocks = Array.isArray(ev.data?.content) ? ev.data.content : []
    const t = blocks.filter((b) => b?.type === 'text').map((b) => b.text).join('\n').trim()
    if (t) turns.push({ role: 'user', text: t, seq: ev.seq, time: ev.time })
  } else if (ev.type === 'assistant/message') {
    // assistant 文本在 data.message.content（与 usage 同层的是元信息）
    const blocks = Array.isArray(ev.data?.message?.content) ? ev.data.message.content : []
    const t = blocks.filter((b) => b?.type === 'text').map((b) => b.text).join('\n').trim()
    if (t) turns.push({ role: 'assistant', text: t, seq: ev.seq, time: ev.time })
  }
}
if (turns.length === 0) { console.error('该会话没有可展示的文本轮次'); process.exit(1) }

// ---------- 体积统计 ----------
const charsOf = (s) => [...s].length
// 粗估 token：中文 ≈1.5 字符/token，ASCII ≈4 字符/token（观测臂同口径的简化版）
const estTokens = (s) => {
  let cjk = 0, ascii = 0
  for (const ch of s) { if (ch.charCodeAt(0) > 0x2e80) cjk++; else ascii++ }
  return Math.round(cjk / 1.5 + ascii / 4)
}
const fmt = (n) => n.toLocaleString('en-US')

// ---------- A. 原始状态 ----------
const origChars = turns.reduce((a, t) => a + charsOf(t.text) + 8, 0)

// ---------- B. 熔炼（真实提取器） ----------
// demo 隔离：不读写真实记忆库
process.env.LCM_OPENVIKING_DISABLED = '1'
const cfg = loadConfig(resolve(HERE, '..'), { meterRoot: resolve(HERE, '../.demo-lcm') })

const foldFrom = Math.max(0, turns.length - KEEP)   // 保留最近 KEEP 轮
const folded = turns.slice(0, foldFrom)
const kept = turns.slice(foldFrom)

const candidates = []
for (const t of folded) {
  for (const c of memory.extractCandidates(t.text)) candidates.push({ ...c, from: t.role })
}

// 入库（真实四选一决策；demo 库是干净的 → 大多 ADD）
for (const c of candidates) {
  try { memory.record(cfg, { ...c, source: 'incremental' }) } catch { /* 禁写等 */ }
}
const live = memory.activeEntries(cfg).sort((a, b) => (b.score ?? 0) - (a.score ?? 0))

// ---------- 记忆块（注入形态） ----------
const query = kept.filter((t) => t.role === 'user').at(-1)?.text.slice(0, 120) ?? '会话主题'
const hits = memory.search(cfg, query, { k: 6 })
const block = memory.renderInjectBlock(query, hits) ?? ''

// ---------- 折叠后的请求形态 ----------
const pointer = (t, i) => `[轮 ${i + 1}·${t.role === 'user' ? '用户' : '助手'} 已蒸馏至记忆库（${charsOf(t.text)} 字符 → 记忆条目）]`
const foldedChars =
  folded.reduce((a, t, i) => a + charsOf(pointer(t, i)) + 8, 0)   // 指针行
  + kept.reduce((a, t) => a + charsOf(t.text) + 8, 0)             // 最近轮原文
  + charsOf(block) + 8                                             // 记忆块

// ---------- 输出 ----------
const sessionName = LOG.split('/').slice(-2, -1)[0]
const dt = new Date(turns[0].time).toISOString().slice(0, 16).replace('T', ' ')

console.log('╔══════════════════════════════════════════════════════════════════════════╗')
console.log(`║  warm-folding demo · 真实会话：${sessionName.slice(0, 20)}`)
console.log(`║  ${dt} 起 · ${turns.length} 个文本轮次（user ${turns.filter((t) => t.role === 'user').length} / assistant ${turns.filter((t) => t.role === 'assistant').length}）`)
console.log('╚══════════════════════════════════════════════════════════════════════════╝')
console.log()
console.log('── 一次请求携带的对话体积对比 ─────────────────────────────────────────────')
console.log(`  A 原始            ${fmt(origChars).padStart(9)} chars ≈ ${fmt(estTokens('a'.repeat(0) + turns.map((t) => t.text).join(''))).padStart(7)} tok`)
console.log(`  B 折叠后          ${fmt(foldedChars).padStart(9)} chars ≈ ${fmt(estTokens('a'.repeat(0) + folded.map((t, i) => pointer(t, i)).join('') + kept.map((t) => t.text).join('') + block)).padStart(7)} tok`)
const savedPct = ((1 - foldedChars / origChars) * 100).toFixed(1)
const savedTok = estTokens(turns.map((t) => t.text).join('')) - estTokens(folded.map((t, i) => pointer(t, i)).join('') + kept.map((t) => t.text).join('') + block)
console.log('  ─────────────────────────────────────────────')
console.log(`  省 ${savedPct}%  ≈ ${fmt(savedTok)} tok/请求`)
console.log()
console.log(`  折叠构成：旧轮次 ${folded.length} 个 → 指针行 ｜ 最近 ${kept.length} 轮保留原文 ｜ 记忆块 ${charsOf(block)} chars`)
console.log()
console.log(`── 熔炼产出（真实提取器跑 ${folded.length} 个旧轮次，四选一决策后存活 ${live.length} 条）──`)
for (const e of live.slice(0, 10)) {
  console.log(`  [${e.type}] ${e.subject}：${e.claim.slice(0, 60)}${e.claim.length > 60 ? '…' : ''}`)
}
if (live.length > 10) console.log(`  … 共 ${live.length} 条`)
console.log()
console.log('── 尾部注入块（旧轮次的「活表示」，请求最尾部）──')
console.log(block.split('\n').map((l) => '  ' + l).join('\n'))
console.log()
console.log('── 前缀缓存视角（为什么只在冷窗口折）──')
console.log('  · 热缓存时折叠 = 改写前缀 = 主动击穿：省的 token < 击穿重付 → 净亏')
console.log('  · 冷窗口（compaction 后/击穿后/fork 首请求）本来就要全量重付 → 折叠后付「小的版本」= 净赚')
console.log('  · 折叠还会压低会话总量 → 推迟/避免 DSH compaction（省一次 LLM 蒸馏 + 全量重付）')
