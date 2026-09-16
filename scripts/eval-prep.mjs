#!/usr/bin/env node
/** 历史会话批量蒸馏：把真实会话按增量熔炼同款链路灌入记忆库（带 sessionId/project）。
 *
 * 用途：
 * 1) 金标评测的准备（eval 需要「会话 → 该会话条目」的配对，直连提取器没有 sessionId）
 * 2) 回填：增量熔炼臂上线前跑过的历史会话，一次性补进记忆库
 *
 * 用法：LCM_METER_ROOT=.eval-lcm node scripts/eval-prep.mjs [sessionLimit]
 * 环境：LCM_OPENVIKING_DISABLED=1（默认在此脚本内置，避免污染远端）
 */

import { join } from 'node:path'
import { homedir } from 'node:os'
import { loadConfig } from '../core/config.mjs'
import * as memory from '../core/memory.mjs'
import { userTalksOf } from '../core/profile.mjs'
import { readSessionLog } from '../core/recover.mjs'
import { sessionLogFiles } from '../core/recover.mjs'

process.env.LCM_OPENVIKING_DISABLED = '1'
const ROOT = process.env.LCM_METER_ROOT ?? join(process.cwd(), '.eval-lcm')
const cfg = loadConfig(process.cwd(), { meterRoot: ROOT })
const limit = Number(process.argv[2] ?? 60)
const sessionsDir = join(homedir(), '.dsh', 'sessions')

let sessions = 0, turns = 0, candidates = 0
let added = 0, noop = 0, rejected = 0
for (const log of sessionLogFiles(sessionsDir, limit)) {
  const logPath = typeof log === 'string' ? log : log.path
  const sessionId = logPath.split('/').at(-2)
  const project = logPath.split('/').at(-3)?.replace(/^--+|--+$/g, '') ?? null
  const userTurns = userTalksOf(logPath).map((t) => ({ text: t, role: 'user' }))
  const assistantTurns = []
  const text = readSessionLog(logPath)
  for (const line of text.split('\n')) {
    if (!line.trim().startsWith('{') || !line.includes('assistant/message')) continue
    let ev; try { ev = JSON.parse(line) } catch { continue }
    if (ev.type !== 'assistant/message') continue
    const t = (ev.data?.message?.content ?? []).filter((b) => b?.type === 'text').map((b) => b.text).join('\n').trim()
    if (t) assistantTurns.push({ text: t, role: 'assistant' })
  }
  const all = [...userTurns, ...assistantTurns]
  if (all.length === 0) continue
  sessions++
  for (const { text: t, role } of all) {
    turns++
    for (const c of memory.extractCandidates(t, { role })) {
      candidates++
      const r = memory.record(cfg, { ...c, source: 'incremental', sessionId, project })
      if (r.action === 'ADD' || r.action === 'UPDATE') added++
      else if (r.action === 'REJECT') rejected++
      else noop++
    }
  }
}

const live = memory.activeEntries(cfg)
console.log(`历史会话蒸馏 · ${sessions} 会话 / ${turns} 轮 → 候选 ${candidates}`)
console.log(`  ADD ${added} ｜ NOOP ${noop} ｜ REJECT ${rejected}（低分门槛）→ 活跃 ${live.length} 条`)
console.log(`  记忆库：${join(cfg.memoryDir, 'memories.jsonl')}`)
