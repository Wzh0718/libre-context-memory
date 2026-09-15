#!/usr/bin/env node
/** 用户画像拼接 demo：跨项目扫真实会话 → 每会话独立熔炼 → 聚合跨会话重复主题。
 *
 * 验证两件事：
 * 1. 不同 session 的提取结果里，是否存在「跨会话重复/高度相似」的主题
 *    （= 用户画像晋升机制「≥2 会话印证」的数据基础）
 * 2. 拼出来的画像长什么样、边界在哪（确定性提取器能拼「工作画像」，
 *    拼不出「性格画像」——后者需要语义层）
 *
 * 用法：node scripts/profile-demo.mjs [--per-project N]
 */

import { readdirSync, statSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readSessionLog } from '../core/recover.mjs'
import * as memory from '../core/memory.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const SESSIONS_ROOT = resolve(HERE, '../../../.dsh/sessions')
const argv = process.argv.slice(2)
const PER_PROJECT = Number(argv.find((a, i) => argv[i - 1] === '--per-project') ?? 3)

// ---------- 收集会话（每项目取最大的 N 个） ----------
function turnsOf(logPath) {
  const turns = []
  let text
  try { text = readSessionLog(logPath) } catch { return turns }
  for (const line of text.split('\n')) {
    if (!line.trim().startsWith('{')) continue
    let ev; try { ev = JSON.parse(line) } catch { continue }
    if (ev.type === 'user/message' && ev.data?.source?.kind === 'user') {
      const t = (ev.data.content ?? []).filter((b) => b?.type === 'text').map((b) => b.text).join('\n').trim()
      if (t) turns.push(t)
    } else if (ev.type === 'assistant/message') {
      const t = (ev.data?.message?.content ?? []).filter((b) => b?.type === 'text').map((b) => b.text).join('\n').trim()
      if (t) turns.push(t)
    }
  }
  return turns
}

const projects = readdirSync(SESSIONS_ROOT)
  .filter((d) => statSync(join(SESSIONS_ROOT, d)).isDirectory())

const sessions = []   // {project, log, size}
for (const proj of projects) {
  const dir = join(SESSIONS_ROOT, proj)
  const logs = readdirSync(dir)
    .filter((d) => statSync(join(dir, d)).isDirectory())
    .map((d) => join(dir, d, 'session.jsonl.zstd'))
    .filter(existsSync)
    .sort((a, b) => statSync(b).size - statSync(a).size)
    .slice(0, PER_PROJECT)
  for (const log of logs) sessions.push({ project: proj.replace(/^--|—/g, '').replace(/--/g, '/').split('/').pop(), log, size: statSync(log).size })
}

// ---------- 每会话独立熔炼，记录「哪条候选出自哪个会话」 ----------
const keyOf = (c) => memory.entryId(c.type, c.subject, c.claim)   // 幂等键（与 record 同口径）
const byKey = new Map()   // key → {cand, sessions:Set, projects:Set}
let totalCands = 0
for (const s of sessions) {
  const turns = turnsOf(s.log)
  s.turns = turns.length
  for (const t of turns) {
    for (const c of memory.extractCandidates(t)) {
      if (c.score < 0.6) continue    // 原始轮次门槛（与增量熔炼一致）
      totalCands++
      const k = keyOf(c)
      const slot = byKey.get(k) ?? { cand: c, sessions: new Set(), projects: new Set() }
      slot.sessions.add(s.log)
      slot.projects.add(s.project)
      byKey.set(k, slot)
    }
  }
}

// ---------- 相似度聚类：Jaccard ≥0.5 的 claim 归入同主题簇 ----------
const all = [...byKey.values()]
const clusters = []   // [{lead, members:Set(key), sessions:Set, projects:Set}]
for (const slot of all) {
  let hit = null
  for (const cl of clusters) {
    if (memory.similarity(cl.lead.cand.claim, slot.cand.claim) >= 0.5) { hit = cl; break }
  }
  if (hit) {
    hit.members.add(slot.cand.claim)
    for (const x of slot.sessions) hit.sessions.add(x)
    for (const x of slot.projects) hit.projects.add(x)
  } else {
    clusters.push({ lead: slot, members: new Set([slot.cand.claim]), sessions: new Set(slot.sessions), projects: new Set(slot.projects) })
  }
}

// ---------- 画像素材分层 ----------
const crossSession = clusters.filter((c) => c.sessions.size >= 2)
  .sort((a, b) => b.sessions.size - a.sessions.size || b.projects.size - a.projects.size)
const crossProject = crossSession.filter((c) => c.projects.size >= 2)
const prefs = all.filter((s) => s.cand.type === 'preference')

const fmt = (n) => n.toLocaleString('en-US')
console.log(`画像拼接 demo · ${projects.length} 个项目 · ${sessions.length} 个会话（每项目 top${PER_PROJECT}）· ${fmt(sessions.reduce((a, s) => a + s.turns, 0))} 轮`)
console.log(`过门槛候选 ${fmt(totalCands)} 条 → 幂等去重 ${all.length} 条 → 主题簇 ${clusters.length} 个`)
console.log('═'.repeat(72))
console.log()
console.log(`── 跨会话重复主题（≥2 会话印证 → 画像晋升候选）：${crossSession.length} 个 ──`)
for (const c of crossSession.slice(0, 12)) {
  const tag = c.projects.size >= 2 ? ` ★跨${c.projects.size}项目` : ''
  console.log(`  [${c.sessions.size}会话${tag}] ${c.lead.cand.type}｜${c.lead.cand.claim.slice(0, 58).replace(/\n/g, ' ')}${c.lead.cand.claim.length > 58 ? '…' : ''}`)
}
console.log()
console.log(`── 其中跨项目印证（画像核心——项目无关的长期事实）：${crossProject.length} 个 ──`)
for (const c of crossProject.slice(0, 8)) {
  console.log(`  [${c.sessions.size}会话/${c.projects.size}项目] ${c.lead.cand.claim.slice(0, 58).replace(/\n/g, ' ')}…`)
}
console.log()
console.log(`── 偏好声明（preference 类，画像的直接素材）：${prefs.length} 条 ──`)
for (const p of prefs.slice(0, 6)) {
  console.log(`  ${p.cand.claim.slice(0, 66).replace(/\n/g, ' ')}${p.cand.claim.length > 66 ? '…' : ''}`)
}
console.log()
console.log('── 边界（确定性提取器拼不出的部分）──')
console.log('  · 能拼：工作画像——长期项目、反复出现的技术决策、明确声明的偏好、高频文件/路径锚')
console.log('  · 不能拼：性格/风格画像（「沟通直接」「喜欢极简」）——那是语义层结论，')
console.log('    需要将来 LLM 兜底蒸馏或手动 pin；确定性层只给它供证据（高频主题 + 偏好原文）')
