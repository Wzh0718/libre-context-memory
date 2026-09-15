#!/usr/bin/env node
/** 真实会话总 benchmark：把 N 个真实会话日志回放进真实适配器（五臂 active），
 * 统计**累计请求载荷 token** 的减少量与各臂贡献。
 *
 * 为什么这样度量：五臂改的是「每一轮请求发出去的载荷」——剪枝/折叠改历史，
 * 压缩改单条，注入加固定块。真实成本 = Σ(每轮载荷) 在缓存规则下的计费；
 * 这里先给上界口径（未计缓存命中），并单列注入的固定开销（诚实计负项）。
 *
 * 用法：node scripts/bench-all.mjs [会话数=8] [每几步做一次 pre-step=4]
 */

import { mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../adapters/dsh/src/index.js'
import { readSessionLog } from '../core/recover.mjs'
import { loadConfig } from '../core/config.mjs'

process.env.LCM_OPENVIKING_DISABLED = '1'
const SESSIONS = join(homedir(), '.dsh', 'sessions')
const LIMIT = Number(process.argv[2] ?? 8)
const STEP_EVERY = Number(process.argv[3] ?? 4)
// 生产里 DSH 内置压缩很频繁（实测 15 分钟 61 次）——回放必须复现这个节奏，
// 否则剪枝/折叠只能等到会话末尾才动手，收益全被「没有后续请求」吃掉
const COMPACT_AT_TOKENS = Number(process.env.LCM_BENCH_COMPACT_AT ?? 150_000)
const COMPACT_REARM_RATIO = 0.6
const est = (chars) => Math.ceil(chars / 2)   // 保守 ≈2 字符/token

// ---------------------------------------------------------------- 挑选真实会话
function listSessions() {
  const out = []
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
        if (size < 50_000) continue                 // 太小的会话没有工具输出可剪
        out.push({ path: p, project: proj.replace(/^--+|--+$/g, ''), sessionId: sid, size })
      }
    }
  }
  // 大中小混合取样（只取最大者会偏向极端），按大小分层
  out.sort((a, b) => b.size - a.size)
  const picks = []
  const stride = Math.max(1, Math.floor(out.length / LIMIT))
  for (let i = 0; i < out.length && picks.length < LIMIT; i += stride) picks.push(out[i])
  return picks
}

function eventsOf(path) {
  const out = []
  for (const line of readSessionLog(path).split('\n')) {
    if (!line.trim().startsWith('{')) continue
    try { out.push(JSON.parse(line)) } catch { /* 坏行 */ }
  }
  return out
}

function textOf(ev) {
  if (ev.type === 'user/message') return (ev.data?.content ?? []).map((b) => b?.text ?? '').join('')
  if (ev.type === 'assistant/message') return (ev.data?.message?.content ?? []).map((b) => b?.text ?? '').join('')
  const content = ev.data?.message?.content ?? []
  // 嵌套形状（日志）：content[0].content；扁平形状（运行时压缩臂产出）：content
  const blocks = Array.isArray(content[0]?.content) ? content[0].content : content
  return blocks.map((b) => b?.text ?? '').join('')
}

// ---------------------------------------------------------------- 单会话回放
async function replay(target, idx) {
  const ROOT = join(process.cwd(), '.bench-all', `s${idx}`)
  rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(join(ROOT, '.lcm'), { recursive: true })
  const cfg = loadConfig(ROOT, { meterRoot: join(ROOT, '.lcm') })

  const ctx = {
    listeners: [],
    logger: { info: () => {}, warn: (m) => warns.push(m) },
    services: {},
    on(event, fn) { this.listeners.push({ event, fn }) },
    get(n) { return this.services[n] },
  }
  const warns = []
  apply(ctx, {
    mode: 'active', lcmRoot: ROOT, meterRoot: cfg.meterDir,
    memoryInjectMode: 'active', foldMode: 'active',
    memoryExtract: true, memoryExtractIncremental: true,
    // 预算守卫按真实会话体量给足（否则剪枝不触发，测不出贡献）
    budgetTokens: 60_000,
  })
  const preStep = ctx.listeners.find((l) => l.event === 'agent/pre-step').fn
  const sessionEvent = ctx.listeners.find((l) => l.event === 'session/event').fn
  const postExec = ctx.listeners.find((l) => l.event === 'tools/post-execute')?.fn

  const events = eventsOf(target.path).filter((e) => ['user/message', 'assistant/message', 'tool/result'].includes(e.type))
  const surface = new Map()
  const appends = []
  const session = {
    header: { id: target.sessionId, cwd: ROOT },
    surface: { get nodes() { return [...surface.keys()] } },
    eventAt: (seq) => surface.get(seq),
    append(type, data, opts) {
      appends.push({ type, opts })
      if (opts?.surfaceOp?.op === 'replace') surface.set(opts.surfaceOp.start, { type, data, seq: opts.surfaceOp.start })
      return { seq: 1e6 + appends.length }
    },
  }

  // 累计请求载荷：每 STEP_EVERY 个事件算一次「这一轮发出去的历史总量」
  let surfaceChars = 0          // 当前 surface 上所有节点的字符数（含被替换后的）
  let injectedChars = 0         // 注入块累计（固定开销，计入现值）
  let baselineSum = 0           // 无臂：历史原样全量
  let actualSum = 0             // 有臂：surface 现值 + 注入
  let requests = 0
  let payload = 0               // 无臂口径下的当前载荷（原样累计）
  let seq = 0
  let turns = 0
  let compactions = 0
  let compactArmed = false
  let compressBefore = 0
  let compressAfter = 0
  const injectionLog = []

  ctx.services.tokenMeter = {
    measure: () => ({ totalTokens: est(payload) }),
    estimateMessage: (m) => est(JSON.stringify(m ?? '').length),
  }

  for (let ev of events) {
    seq++
    let text = textOf(ev)
    const rawChars = text.length          // baseline 口径：无臂时的原始长度
    let chars = rawChars
    // 压缩臂：真实工具输出过一遍 tools/post-execute（DSH 的真实调用点）
    if (ev.type === 'tool/result' && postExec) {
      // 运行时形状：decision.content = 扁平文本块数组
      const original = ev.data?.message?.content ?? []
      const flat = [{ type: 'text', text }]
      const decision = await postExec(
        { name: 'bash', agent: { session }, parent: undefined },   // 不能传 'read'：那是防 spill 循环的守卫名
        { content: flat },
        async () => ({ kind: 'accept', content: flat }),
      )
      const after = decision?.content
      if (Array.isArray(after)) {
        const afterText = after.map((b) => b?.text ?? '').join('')
        if (afterText && afterText !== text) {
          compressBefore += chars
          compressAfter += afterText.length
          text = afterText
          chars = afterText.length
          // 存回表面：保持嵌套外壳（tool 角色），内容换成压缩后的文本
          ev = { ...ev, data: { ...ev.data, message: { ...ev.data?.message, content: [{ ...(original[0] ?? {}), content: after }] } } }
        }
      }
    }
    surface.set(seq, { ...ev, seq })
    if (ev.type === 'user/message' || ev.type === 'assistant/message') turns++
    // baseline（无臂）= 原始长度全量累计；actual = surface 现值（含压缩/剪枝/折叠后的值）
    payload += rawChars
    surfaceChars += chars
    await sessionEvent(session, {
      type: 'token/usage', sessionId: target.sessionId,
      data: { inputTokens: est(chars), cacheReadTokens: 0, outputTokens: 10 },
    })

    if (turns > 0 && turns % STEP_EVERY === 0) {
      // 一次请求：载荷 = 当前 surface 字符 + 已注入块
      baselineSum += payload
      actualSum += surfaceChars + injectedChars
      requests++
      // 真实压缩节奏：载荷超阈值 → 发 compaction 事件（打开冷窗口，剪枝/折叠的合法时机）
      const payloadTokens = est(payload)
      if (payloadTokens >= COMPACT_AT_TOKENS && !compactArmed) {
        compactArmed = true
        await sessionEvent(session, { type: 'compaction/summary', sessionId: target.sessionId, data: {} })
        compactions++
      } else if (compactArmed && payloadTokens < COMPACT_AT_TOKENS * COMPACT_REARM_RATIO) {
        compactArmed = false
      }
      const messages = [...surface.values()].slice(-40).map((e) => ({
        role: e.type === 'assistant/message' ? 'assistant' : 'user',
        content: e.type === 'assistant/message' ? (e.data?.message?.content ?? []) : (e.data?.content ?? [{ type: 'text', text: '…' }]),
        source: e.data?.source,
      }))
      const out = await preStep({ agent: { session } }, async () => ({ kind: 'run', messages }))
      const injected = out.messages.length > messages.length ? out.messages.at(-1)?.content?.[0]?.text ?? '' : ''
      if (injected) {
        injectedChars = injected.length     // 现值口径：注入块是每轮都带的固定开销
        injectionLog.push(injected.length)
      }
      // 重算 surfaceChars（剪枝/折叠可能刚替换过节点）
      surfaceChars = 0
      for (const e of surface.values()) surfaceChars += textOf(e).length
    }
  }

  // 冷窗口收尾：触发一次 compaction，让折叠臂有机会动手
  await sessionEvent(session, { type: 'compaction/basic', sessionId: target.sessionId, data: {} })
  ctx.services.tokenMeter = { measure: () => ({ totalTokens: 999_999 }), estimateMessage: () => 20 }
  const tailMessages = [...surface.values()].slice(-20).map((e) => ({
    role: 'user', content: e.data?.content ?? [{ type: 'text', text: '…' }], source: e.data?.source,
  }))
  await preStep({ agent: { session } }, async () => ({ kind: 'run', messages: tailMessages }))

  // 收尾统计：从隔离根的 meter 里读各臂动作
  const meter = []
  for (const f of readdirSync(cfg.meterDir)) {
    if (!f.startsWith('meter-')) continue
    for (const line of readFileSync(join(cfg.meterDir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue
      try { meter.push(JSON.parse(line)) } catch { /* 坏行 */ }
    }
  }
  const sum = (k, f) => meter.filter((e) => e.kind === k).reduce((n, e) => n + (e[f] ?? 0), 0)
  const beforeAfter = (k) => meter.filter((e) => e.kind === k)
    .reduce((acc, e) => ({ before: acc.before + (e.charsBefore ?? 0), after: acc.after + (e.charsAfter ?? 0) }), { before: 0, after: 0 })

  const compress = beforeAfter('compress')
  const prune = beforeAfter('prune')
  const fold = beforeAfter('fold')

  return {
    project: target.project, sessionId: target.sessionId.slice(0, 12),
    events: events.length, turns, requests, compactions,
    baselineTokens: est(baselineSum), actualTokens: est(actualSum),
    savedTokens: est(baselineSum - actualSum),
    savedPct: baselineSum > 0 ? (1 - actualSum / baselineSum) : 0,
    arms: {
      compressChars: compressBefore - compressAfter,
      compressEvents: compress.before > 0 ? meter.filter((e) => e.kind === 'compress').length : 0,
      pruneChars: prune.before - prune.after,
      pruneNodes: sum('prune', 'nodes'),
      foldChars: fold.before - fold.after,
      foldNodes: sum('fold', 'nodes'),
      injectChars: injectionLog.reduce((a, b) => a + b, 0),
      injectCount: injectionLog.length,
      entries: (() => {
        const p = join(cfg.memoryDir, 'memories.jsonl')
        if (!statSync(join(cfg.memoryDir), { throwIfNoEntry: false })) return 0
        if (!statSync(p, { throwIfNoEntry: false })) return 0
        return readFileSync(p, 'utf8').split('\n').filter(Boolean).length
      })(),
    },
    warns: warns.length,
  }
}

// ---------------------------------------------------------------- 跑
const picks = listSessions()
console.log(`真实会话 benchmark · ${picks.length} 个会话（按体量分层取样）· pre-step 每 ${STEP_EVERY} 步`)
console.log('═'.repeat(96))
const rows = []
for (const [i, t] of picks.entries()) {
  const r = await replay(t, i)
  rows.push(r)
  console.log(`${String(i + 1).padStart(2)}. ${r.project.slice(-28).padEnd(28)} ${String(r.turns).padStart(4)} 轮 `
    + `${String(r.compactions).padStart(3)} 次压缩 `
    + `载荷 ${r.baselineTokens.toLocaleString().padStart(9)} → ${r.actualTokens.toLocaleString().padStart(9)} tok`
    + `  省 ${(r.savedPct * 100).toFixed(1).padStart(5)}%  `
    + `[压缩 ${est(r.arms.compressChars).toLocaleString()} / 剪枝 ${est(r.arms.pruneChars).toLocaleString()}(${r.arms.pruneNodes}节点) `
    + `/ 折叠 ${est(r.arms.foldChars).toLocaleString()}(${r.arms.foldNodes}轮) / 注入 +${est(r.arms.injectChars).toLocaleString()}]`
    + (r.warns ? ` ⚠warn×${r.warns}` : ''))
}

const tot = rows.reduce((a, r) => ({
  base: a.base + r.baselineTokens, act: a.act + r.actualTokens,
  compress: a.compress + r.arms.compressChars, prune: a.prune + r.arms.pruneChars,
  fold: a.fold + r.arms.foldChars, inject: a.inject + r.arms.injectChars,
  pruneNodes: a.pruneNodes + r.arms.pruneNodes, foldNodes: a.foldNodes + r.arms.foldNodes,
  entries: a.entries + r.arms.entries, requests: a.requests + r.requests,
  compactions: a.compactions + r.compactions,
}), { base: 0, act: 0, compress: 0, prune: 0, fold: 0, inject: 0, pruneNodes: 0, foldNodes: 0, entries: 0, requests: 0, compactions: 0 })

console.log('═'.repeat(96))
console.log(`合计 ${rows.length} 会话 / ${tot.requests} 次请求 / ${tot.compactions} 次压缩窗口`)
console.log(`  累计载荷：${tot.base.toLocaleString()} → ${tot.act.toLocaleString()} tok `
  + `（省 ${est(tot.base - tot.act).toLocaleString()} tok = ${((1 - tot.act / tot.base) * 100).toFixed(1)}%）`)
console.log(`  各臂贡献（估 tok）：压缩 ${est(tot.compress).toLocaleString()} ｜ 剪枝 ${est(tot.prune).toLocaleString()}（${tot.pruneNodes} 节点）`
  + ` ｜ 折叠 ${est(tot.fold).toLocaleString()}（${tot.foldNodes} 轮）｜ 注入固定开销 −${est(tot.inject).toLocaleString()}`)
console.log(`  记忆熔炼：${tot.entries} 条入库（低分门槛拦下的不计）`)
console.log('注：上界口径（未计缓存命中）。真实计费里缓存命中 97%+ 时，改历史只在冷窗口才便宜——')
console.log('    剪枝/折叠已按 piggyback 纪律只在冷窗口动手。')
