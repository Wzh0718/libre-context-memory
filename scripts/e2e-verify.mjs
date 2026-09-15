#!/usr/bin/env node
/** 端到端真实数据验证：把真实会话日志回放进**真实适配器**（apply + 事件监听），
 * 验证五臂协同：提取入库 → 增量熔炼 → 注入（shadow/active）→ 画像常驻 → 折叠记账。
 *
 * 与单测的区别：单测用构造数据验证逻辑；这里用真实会话（真实长度、真实噪声、
 * 真实 tool/result 体量）验证「装配在一起还成立」——暴露的是一致性问题。
 *
 * 用法：node scripts/e2e-verify.mjs [sessionLimit] 
 */

import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { apply } from '../adapters/dsh/src/index.js'
import { readSessionLog } from '../core/recover.mjs'
import { loadConfig } from '../core/config.mjs'
import * as meter from '../core/meter.mjs'
import * as memory from '../core/memory.mjs'

process.env.LCM_OPENVIKING_DISABLED = '1'
const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '.e2e-lcm')
const SESSIONS = join(homedir(), '.dsh', 'sessions')

// ---------------------------------------------------------------- 找真实会话
function pickSession() {
  const found = []
  for (const proj of readdirSync(SESSIONS)) {
    const pdir = join(SESSIONS, proj)
    if (!statSync(pdir).isDirectory()) continue
    for (const sid of readdirSync(pdir)) {
      const dir = join(pdir, sid)
      if (!statSync(dir).isDirectory()) continue
      for (const name of readdirSync(dir)) {
        if (!name.includes('jsonl')) continue
        const p = join(dir, name)
        const size = statSync(p).size
        if (size > 20_000) found.push({ path: p, project: proj, sessionId: sid, size })
      }
    }
  }
  return found.sort((a, b) => b.size - a.size)[0] ?? null
}

const target = pickSession()
if (!target) { console.error('找不到真实会话日志'); process.exit(1) }
rmSync(ROOT, { recursive: true, force: true })
mkdirSync(join(ROOT, '.lcm'), { recursive: true })
const cfg = loadConfig(ROOT, { meterRoot: join(ROOT, '.lcm') })

// ---------------------------------------------------------------- 真实事件回放
const events = []
for (const line of readSessionLog(target.path).split('\n')) {
  if (!line.trim().startsWith('{')) continue
  try { events.push(JSON.parse(line)) } catch { /* 坏行 */ }
}
const chatEvents = events.filter((e) => e.type === 'user/message' || e.type === 'assistant/message' || e.type === 'tool/result')
console.log(`真实会话：${target.project}/${target.sessionId.slice(0, 8)} · 事件 ${events.length}（对话/工具 ${chatEvents.length}）`)

// ---------------------------------------------------------------- 适配器装配
const logs = []
const ctx = {
  listeners: [],
  logger: {
    info: (m) => logs.push(['info', m]),
    warn: (m) => logs.push(['warn', m]),
  },
  services: {},
  on(event, fn, opts) { this.listeners.push({ event, fn, opts }) },
  get(name) { return this.services[name] },
}
apply(ctx, {
  mode: 'active',
  lcmRoot: ROOT,
  meterRoot: cfg.meterDir,
  memoryInjectMode: 'active',      // 端到端要看到真实注入
  foldMode: 'active',              // 折叠也要真做（冷窗口时）
  memoryExtract: true,
  memoryExtractIncremental: true,
})
const preStep = ctx.listeners.find((l) => l.event === 'agent/pre-step').fn
const sessionEvent = ctx.listeners.find((l) => l.event === 'session/event').fn

// 模拟 session：surface 随回放增长；append 的 replace 语义与 DSH 一致
const surface = new Map()
let chars = 0
const appends = []
const session = {
  header: { id: target.sessionId, cwd: ROOT },
  surface: { get nodes() { return [...surface.keys()] } },
  eventAt: (seq) => surface.get(seq),
  append(type, data, opts) {
    appends.push({ type, data, opts })
    if (opts?.surfaceOp?.op === 'replace') surface.set(opts.surfaceOp.start, { type, data, seq: opts.surfaceOp.start })
    return { seq: 100_000 + appends.length }
  },
}
ctx.services.tokenMeter = {
  measure: () => ({ totalTokens: Math.ceil(chars / 2) }),
  estimateMessage: (m) => Math.ceil(JSON.stringify(m ?? '').length / 2),
}

// ---------------------------------------------------------------- 回放 + 逐步 pre-step
let seq = 0
let turns = 0
const injections = []
const budgetTokens = 100_000   // 与默认 cfg 一致：真实会话体量小，不会触顶
void budgetTokens
for (const ev of chatEvents) {
  seq++
  surface.set(seq, { ...ev, seq })
  const text = ev.type === 'user/message'
    ? (ev.data?.content ?? []).map((b) => b?.text ?? '').join('')
    : ev.type === 'assistant/message'
      ? (ev.data?.message?.content ?? []).map((b) => b?.text ?? '').join('')
      : (ev.data?.message?.content?.[0]?.content ?? []).map((b) => b?.text ?? '').join('')
  chars += text.length
  // 会话事件：计量（驱动冷窗口判定）
  await sessionEvent(session, {
    type: 'token/usage', sessionId: target.sessionId,
    data: { inputTokens: Math.ceil(text.length / 4), cacheReadTokens: 0, outputTokens: 20 },
  })
  if (ev.type === 'user/message' || ev.type === 'assistant/message') turns++
  // 每 4 个对话轮做一次 pre-step（模拟真实请求节奏）
  if (turns > 0 && turns % 4 === 0) {
    const messages = [...surface.values()].slice(-30).map((e) => {
      if (e.type === 'user/message') return { role: 'user', content: e.data?.content ?? [], source: e.data?.source }
      if (e.type === 'assistant/message') return { role: 'assistant', content: e.data?.message?.content ?? [] }
      return { role: 'user', content: [{ type: 'text', text: '[tool result]' }], source: { kind: 'tool' } }
    })
    const out = await preStep({ agent: { session } }, async () => ({ kind: 'run', messages }))
    if (out.messages.length > messages.length) {
      injections.push(out.messages.at(-1).content[0].text)
    }
  }
}
// 结尾触发一次 compaction（冷窗口）→ 折叠臂应记账并替换
await sessionEvent(session, { type: 'compaction/summary', sessionId: target.sessionId, data: { summary: [{ type: 'text', text: '摘要：本会话为端到端验证' }] } })
ctx.services.tokenMeter = { measure: () => ({ totalTokens: 150_000 }), estimateMessage: () => 50 }
const finalMessages = [...surface.values()].slice(-20).map((e) => ({ role: 'user', content: e.data?.content ?? [{ type: 'text', text: 'x' }], source: e.data?.source }))
const finalOut = await preStep({ agent: { session } }, async () => ({ kind: 'run', messages: finalMessages }))
void finalOut

// ---------------------------------------------------------------- 报告
const live = memory.activeEntries(cfg)
const folds = meter.readMeterEvents?.(cfg, 'fold') ?? []
const injects = []
const files = existsSync(cfg.meterDir) ? readdirSync(cfg.meterDir).filter((f) => f.startsWith('meter-')) : []
for (const f of files) {
  for (const line of (await import('node:fs')).readFileSync(join(cfg.meterDir, f), 'utf8').split('\n')) {
    if (!line.trim()) continue
    try { const e = JSON.parse(line); if (e.kind === 'memory-inject') injects.push(e) } catch { /* 忽略 */ }
  }
}
console.log('─'.repeat(66))
console.log(`记忆库：活跃 ${live.length} 条（${live.filter((e) => e.profile).length} 条画像）`)
console.log(`注入：${injects.length} 次（含画像常驻段 ${injects.filter((e) => e.profile).length} 次），末次 ${injects.at(-1)?.chars ?? 0} 字符`)
console.log(`折叠：${folds.length} 次记账；surface 替换 ${appends.filter((a) => a.opts?.surfaceOp?.op === 'replace').length} 次`)
console.log(`会话累计：${turns} 个对话轮 / ${chars.toLocaleString()} 字符（≈${Math.ceil(chars / 2).toLocaleString()} tok）`)
const sample = injections.at(-1)
if (sample) {
  console.log('─'.repeat(66))
  console.log('末次注入块：')
  console.log(sample.split('\n').slice(0, 10).join('\n'))
}
// 诊断：把折叠/熔炼相关的 info 日志打出来（LCM_DEBUG_FOLD=1 时含内部细节）
const keyLogs = logs.filter(([, m]) => /fold|熔炼|内存|memory/.test(m))
if (keyLogs.length) {
  console.log('关键日志：')
  for (const [, m] of keyLogs.slice(-12)) console.log(`  ${m}`)
}
const warns = logs.filter(([lvl]) => lvl === 'warn')
console.log('─'.repeat(66))
console.log(`日志：info ${logs.length - warns.length} 条｜warn ${warns.length} 条${warns.length ? '：' + warns.map(([, m]) => m).join('；') : ''}`)
console.log(`产物：${ROOT}`)
