/** 画像层：习惯画像（user talk 提炼）+ 行为画像（meter 统计）→ 常驻注入块。
 *
 * 设计（2026-09-15 定稿，四层画像体系中的 ②③ 层，全确定性零 LLM）：
 * - 习惯画像：只扫 user 的 talk（跳过插件注入 + harness 伪装消息），提炼
 *   意图分布/开场模式/确认习惯/句式指纹/推进链——「用户怎么推进 session」
 * - 行为画像：meter 事件统计——活跃节奏/项目注意力/会话深度——「用户的工作指纹」
 * - 预算纪律（token 不爆炸的硬约束）：常驻块 ≤ PROFILE_MAX_CHARS，
 *   内容按价值密度排序截断；缓存到 ~/.lcm/profile.json，按天刷新（扫描全量
 *   会话日志是分钟级操作，不进热路径）
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import * as meter from './meter.mjs'
import { readSessionLog, sessionLogFiles } from './recover.mjs'

/** 常驻块硬预算（chars）。画像块的生存权 = 换来的对齐轮次 > 这点开销。 */
export const PROFILE_MAX_CHARS = 900

/** harness 伪装成 user 的自动消息（必须过滤，否则是最大的假「习惯」）。 */
const HARNESS_TEMPLATES = [
  'Review the inherited completed checkpoint',
  'automatically generated checkpoint',
]

// ---------------------------------------------------------------- user talk 收集

/** harness 伪装消息过滤：内容包含已知模板即弃。 */
export function isHarnessTalk(text) {
  return HARNESS_TEMPLATES.some((t) => text.includes(t)) || /^<continue/i.test(text)
}

/** 从一个会话日志提取真人 user talk（跳过插件注入与 harness 模板）。 */
export function userTalksOf(logPath) {
  const out = []
  let text
  try { text = readSessionLog(logPath) } catch { return out }
  for (const line of text.split('\n')) {
    if (!line.trim().startsWith('{') || !line.includes('user/message')) continue
    let ev; try { ev = JSON.parse(line) } catch { continue }
    if (ev.data?.source?.kind !== 'user') continue
    const t = (ev.data?.content ?? []).filter((b) => b?.type === 'text').map((b) => b.text).join('\n').trim()
    if (t && !isHarnessTalk(t)) out.push(t)
  }
  return out
}

// ---------------------------------------------------------------- 意图分类

const INTENT_RULES = [
  ['确认', /(能理解|你能理解|对吗|可以吗|是吗|理解吗|明白吗|你觉得|你说)/],
  ['验证', /(测试|benchmark|跑一下|对比|验证|评测|检验)/],
  ['理解', /(理解|分析|看看|研究|为什么|怎么|什么|是否|梳理|读一下|了解)/],
  ['行动', /(修复|开始|实现|直接做|动手|加上|写一个|改|提交|推送|开工)/],
]

/** 单条 talk 的意图分类（确定性关键词，顺序即优先级）。 */
export function intentOf(talk) {
  for (const [name, re] of INTENT_RULES) if (re.test(talk)) return name
  return '扩展'
}

/** 意图序列压缩去重：[理解,理解,行动,行动,验证] → 理解→行动→验证。 */
export function compressChain(intents) {
  const out = []
  for (const x of intents) if (out[out.length - 1] !== x) out.push(x)
  return out
}

// ---------------------------------------------------------------- 句式指纹

const WORD_RE = /[\u4e00-\u9fa5]{2,}|[a-zA-Z]{3,}/g
const STOP = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'have', 'not', 'are', 'was', 'you', 'your',
  'can', 'now', 'com', 'www', 'https', 'http', 'name', 'message', 'token', 'tokens', 'user', 'test',
  'will', 'all', 'out', 'get', 'set', 'use', 'one', 'two', 'review', 'inherited', 'completed',
  'checkpoint', 'continue', 'condensing', 'earlier', 'span', 'then', 'when', 'what', 'how', 'why',
])

/**
 * 跨会话重复句式：词级 bigram + 长词，≥minSessions 个**去重后 talk**出现才算。
 * 关键：talk 文本全局去重——DSH checkpoint 续接会重放历史消息，同一 talk
 * 在多个分段会话逐字重现，不去重会虚高（实测同一开场白重现 22 次）。
 */
export function phraseFingerprint(sessionTalks, { minSessions = 3 } = {}) {
  // sessionTalks: Array<{project, talks:string[]}>
  const phraseSess = new Map()   // phrase → Set(convIdx)，conv = 去重后的对话
  const talkOwner = new Map()    // talkText → convIdx（全局去重：重放只归属首个对话）
  for (const [ci, s] of sessionTalks.entries()) {
    for (const t of s.talks) {
      if (!talkOwner.has(t)) talkOwner.set(t, ci)
    }
  }
  for (const [t, ci] of talkOwner) {
    const words = t.match(WORD_RE) ?? []
    const grams = new Set()
    for (let i = 0; i + 1 < words.length; i++) {
      const g = words[i] + words[i + 1]
      if ([...g].length >= 4) grams.add(g)
    }
    for (const w of words) if ([...w].length >= 3) grams.add(w)
    for (const g of grams) {
      if (!phraseSess.has(g)) phraseSess.set(g, new Set())
      phraseSess.get(g).add(ci)
    }
  }
  const repeated = [...phraseSess.entries()]
    .filter(([g, set]) => set.size >= minSessions && !isFragment(g))
    .sort((a, b) => b[1].size - a[1].size)
  const cjk = []
  const terms = []
  for (const [g, set] of repeated) {
    const bucket = /[\u4e00-\u9fa5]/.test(g) ? cjk : terms
    if (bucket.some(([p]) => p.includes(g) || g.includes(p))) continue
    bucket.push([g, set.size])
  }
  return { phrases: cjk.slice(0, 8), terms: terms.slice(0, 10) }
}

/** 碎片判定：纯英文短词且无信息量（停用词/单位词）。 */
function isFragment(g) {
  if (/[\u4e00-\u9fa5]/.test(g)) return [...g].length < 4
  return STOP.has(g.toLowerCase()) || g.length < 4
}

// ---------------------------------------------------------------- 画像计算

/** 习惯画像：从多个会话的 user talk 统计（全确定性）。 */
export function habitProfile(sessionTalks) {
  const allTalks = sessionTalks.flatMap((s) => s.talks)
  if (allTalks.length === 0) return null
  const intents = { 确认: 0, 验证: 0, 理解: 0, 行动: 0, 扩展: 0 }
  const openers = {}
  const chains = {}
  let total = 0
  for (const s of sessionTalks) {
    if (s.talks.length === 0) continue
    const seq = s.talks.map(intentOf)
    openers[seq[0]] = (openers[seq[0]] ?? 0) + 1
    const sig = compressChain(seq).join('→')
    chains[sig] = (chains[sig] ?? 0) + 1
    for (const it of seq) { intents[it] = (intents[it] ?? 0) + 1; total++ }
  }
  const topChain = Object.entries(chains).sort((a, b) => b[1] - a[1])[0]?.[0] ?? ''
  const confirmRate = total > 0 ? intents['确认'] / total : 0
  return {
    talks: allTalks.length,
    sessions: sessionTalks.filter((s) => s.talks.length > 0).length,
    intents,
    intentOrder: Object.entries(intents).sort((a, b) => b[1] - a[1]).map(([k]) => k),
    openers: Object.fromEntries(Object.entries(openers).sort((a, b) => b[1] - a[1])),
    confirmRate: Math.round(confirmRate * 100) / 100,
    topChain,
    ...phraseFingerprint(sessionTalks),
  }
}

/** 行为画像：meter 事件统计（活跃节奏/项目注意力/会话深度）。 */
export function behaviorProfile(cfg) {
  const events = []
  for (const f of meter.meterFiles(cfg)) {
    try {
      for (const line of readFileSync(f, 'utf8').split('\n')) {
        if (!line.trim()) continue
        try { events.push(JSON.parse(line)) } catch { /* 坏行 */ }
      }
    } catch { /* 文件轮转中 */ }
  }
  const usage = events.filter((e) => e.kind === 'usage' && e.input != null)
  if (usage.length < 10) return null
  const hours = {}
  const byProj = {}
  const bySess = {}
  for (const e of usage) {
    hours[new Date(e.ts).getHours()] = (hours[new Date(e.ts).getHours()] ?? 0) + 1
    const p = (e.project ?? '?').split('/').pop() ?? '?'
    byProj[p] = (byProj[p] ?? 0) + 1
    bySess[e.sessionId] = (bySess[e.sessionId] ?? 0) + 1
  }
  const peak = Object.entries(hours).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([h]) => `${h}点`)
  const depths = Object.values(bySess).sort((a, b) => a - b)
  return {
    requests: usage.length,
    peakHours: peak.join('+'),
    attention: Object.entries(byProj).sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([p, n]) => `${p} ${Math.round((n / usage.length) * 100)}%`),
    sessionMedian: depths[Math.floor(depths.length / 2)] ?? 0,
    deepSessions: depths.filter((d) => d > 100).length,
  }
}

// ---------------------------------------------------------------- 渲染（预算纪律）

/** 画像 → 常驻注入块。硬预算 PROFILE_MAX_CHARS，按价值密度排序截断。 */
export function renderProfileBlock(cfg, { habit, behavior } = {}) {
  if (!habit && !behavior) return null
  const lines = ['<lcm-profile>']
  if (behavior) {
    lines.push(`工作指纹：活跃 ${behavior.peakHours}｜注意力 ${behavior.attention.join('、')}`
      + `｜会话中位 ${behavior.sessionMedian} 请求（深潜 >100 的 ${behavior.deepSessions} 个）`)
  }
  if (habit) {
    const opener = Object.entries(habit.openers)[0]?.[0] ?? ''
    lines.push(`协作习惯：开场多为${opener}式｜确认类 talk ${Math.round(habit.confirmRate * 100)}%`
      + `｜推进链 ${habit.topChain.slice(0, 30)}`)
    if (habit.phrases.length) {
      lines.push(`口头禅：${habit.phrases.slice(0, 5).map(([p]) => p).join('、')}`)
    }
  }
  lines.push('（据历史会话统计，供对齐协作方式参考）')
  lines.push('</lcm-profile>')
  let block = lines.join('\n')
  if (block.length > PROFILE_MAX_CHARS) {
    // 截断保闭合标签（预算纪律是硬约束）
    block = block.slice(0, PROFILE_MAX_CHARS - '</lcm-profile>'.length - 1).trimEnd() + '\n</lcm-profile>'
  }
  return block
}

// ---------------------------------------------------------------- 缓存（不进热路径）

const DAY_MS = 24 * 60 * 60 * 1000

/** 画像计算入口：缓存按天刷新；force 或缓存缺失时全量重扫（分钟级，离线操作）。 */
export function getProfile(cfg, { force = false, allowScan = true, sessionsDir, scanLimit = 400 } = {}) {
  const file = join(cfg.meterDir, 'profile.json')
  try {
    if (existsSync(file)) {
      const cached = JSON.parse(readFileSync(file, 'utf8'))
      if (!force && Date.now() - cached.builtAt < DAY_MS) return cached
      if (!allowScan) return { ...cached, stale: true }   // 热路径：过期也给旧的，绝不在线扫描
    }
  } catch { /* 缓存损坏 → 重算 */ }
  if (!allowScan) return null

  const dir = sessionsDir ?? cfg.sessionsDir
  const logs = sessionLogFiles(dir, scanLimit)
  const sessionTalks = []
  for (const log of logs) {
    const logPath = typeof log === 'string' ? log : log.path   // sessionLogFiles 返回 {path, mtimeMs}
    const talks = userTalksOf(logPath)
    if (talks.length > 0) {
      const project = logPath.split('/').at(-3)?.replace(/^--+|--+$/g, '').split('--').pop() ?? ''
      sessionTalks.push({ project, talks })
    }
  }
  const profile = {
    builtAt: Date.now(),
    habit: habitProfile(sessionTalks),
    behavior: behaviorProfile(cfg),
  }
  try {
    mkdirSync(cfg.meterDir, { recursive: true })
    writeFileSync(file, JSON.stringify(profile), 'utf8')
  } catch { /* 只读环境：内存返回 */ }
  return profile
}
