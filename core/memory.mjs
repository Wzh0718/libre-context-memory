/** 记忆引擎：本地库（~/.lcm/memories）+ 写入决策四选一 + 禁写过滤 + 检索注入 + OpenViking 同步。
 *
 * 设计（docs/04 Phase 3）：
 * - 本地永远是 source of truth：没配 OpenViking 体验不缩水；配了则双写（best-effort + outbox）
 * - 写入不是 append，而是决策：ADD / UPDATE / DELETE / NOOP（防污染的核心机制）
 * - 禁写硬过滤：secrets、瞬态、过短内容——提取器挡在库门外，不是靠自觉
 * - 检索零依赖：关键词打分（无 embedding），预算有界，注入块确定性渲染（尾部追加纪律）
 * - 幂等键 = sha256(type+subject+claim)：hook 重试/双写/flush 不产生重复
 *
 * 存储形态：memories.jsonl 追加写。UPDATE 不改旧行，追加新行并给旧行补 superseded 标记行
 * （重写文件一次性完成，进程内串行安全——与 meter 相同的「单写者」假设）。
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import * as meter from './meter.mjs'

export const MEMORY_TYPES = ['fact', 'decision', 'preference', 'open_thread', 'conclusion', 'anti_pattern']
const TYPE_RE = new RegExp(`^(${MEMORY_TYPES.join('|')})$`)

// ---------------------------------------------------------------- 基础件

export function entryId(type, subject, claim) {
  return createHash('sha256').update(`${type}\u0000${subject}\u0000${claim}`, 'utf8').digest('hex').slice(0, 16)
}

/** claim 规范化 token 集（小写、去标点；中文按字符切分为 bigram 保持区分度）。 */
export function tokensOf(text) {
  const s = String(text ?? '').toLowerCase()
  const ascii = s.match(/[a-z0-9_./-]{2,}/g) ?? []
  const cjk = [...s.replace(/[^\p{Script=Han}]/gu, '')]
  const bigrams = []
  for (let i = 0; i + 1 < cjk.length; i++) bigrams.push(cjk[i] + cjk[i + 1])
  return new Set([...ascii, ...bigrams])
}

/** Jaccard 相似度（0~1）：UPDATE/NOOP 判断用。 */
export function similarity(a, b) {
  const ta = tokensOf(a); const tb = tokensOf(b)
  if (ta.size === 0 || tb.size === 0) return 0
  let inter = 0
  for (const t of ta) if (tb.has(t)) inter++
  return inter / (ta.size + tb.size - inter)
}

// ---------------------------------------------------------------- 禁写过滤

const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{16,}/,                       // OpenAI 风格 key
  /AKIA[0-9A-Z]{16}/,                            // AWS access key
  /gh[pousr]_[A-Za-z0-9]{30,}/,                  // GitHub token
  /(api[_-]?key|secret|password|passwd|token|bearer)\s*[:=]\s*['"]?[A-Za-z0-9+/=_-]{12,}/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /xox[bpars]-[A-Za-z0-9-]{10,}/,                // Slack token
]

/** 禁写判定：返回原因字符串；可写返回 null。 */
export function forbiddenReason(claim) {
  const s = String(claim ?? '')
  if ([...s.trim()].length < 8) return 'too-short'
  if (SECRET_PATTERNS.some((re) => re.test(s))) return 'secret-like'
  // 纯时间戳/纯数字——瞬态内容不是记忆
  if (/^[\d\s:.\-TZ+/()年月日时分秒,]+$/.test(s.trim())) return 'transient'
  return null
}

// ---------------------------------------------------------------- 存储

function storePath(cfg) { return join(cfg.memoryDir, 'memories.jsonl') }

/** 读全部条目（含被取代的），坏行跳过。 */
export function loadAll(cfg) {
  const file = storePath(cfg)
  if (!existsSync(file)) return []
  const out = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue
    try { out.push(JSON.parse(line)) } catch { /* 坏行跳过 */ }
  }
  return out
}

/** 当前有效视图：未被取代的条目。 */
export function activeEntries(cfg) {
  return activeEntriesFrom(loadAll(cfg))
}

function activeEntriesFrom(all) {
  const dead = new Set()
  for (const e of all) if (e.superseded_by) dead.add(e.id)   // e.id 被取代 → 死；取代者本身活着
  return all.filter((e) => !dead.has(e.id) && e.status !== 'refuted')
}

function persist(cfg, all) {
  mkdirSync(cfg.memoryDir, { recursive: true })
  writeFileSync(storePath(cfg), all.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8')
}

/** 校验并规范化候选条目；非法返回 null。 */
function normalizeCandidate(cand) {
  const type = TYPE_RE.test(cand?.type ?? '') ? cand.type : 'fact'
  const subject = String(cand?.subject ?? '').trim().slice(0, 80)
  const claim = String(cand?.claim ?? '').trim().slice(0, 400)
  if (!claim) return null   // subject 允许为空（无锚点条目——显示与检索都已适配）
  return {
    type, subject, claim,
    keywords: (cand.keywords ?? []).map(String).slice(0, 8),
    confidence: Number.isFinite(cand.confidence) ? Math.min(1, Math.max(0, cand.confidence)) : 0.7,
    ttl: cand.ttl === 'session' ? 'session' : 'durable',
    source: String(cand.source ?? 'manual').slice(0, 60),
    project: cand.project ?? null,
    sessionId: cand.sessionId ?? null,
    evidence: (cand.evidence ?? []).map(String).slice(0, 4),
  }
}

/**
 * 写入决策（mem0 式四选一）。
 * @returns {{action:'ADD'|'UPDATE'|'NOOP'|'DELETE'|'REJECT', id?:string, reason?:string, entry?:object}}
 */
/** 质量门槛按来源分层：LLM 蒸馏过的 summary 宽松；原始对话轮严格（噪声大）；手动不设限。 */
const QUALITY_GATE = { 'compaction/summary': 0.45, manual: 0 }
const DEFAULT_QUALITY_GATE = 0.6

export function record(cfg, cand, { now = Date.now() } = {}) {
  const c = normalizeCandidate(cand)
  if (c === null) return { action: 'REJECT', reason: 'invalid' }
  const blocked = forbiddenReason(c.claim)
  if (blocked) {
    meter.record(cfg, { kind: 'memory', action: 'REJECT', reason: blocked, type: c.type, subject: c.subject })
    return { action: 'REJECT', reason: blocked }
  }
  // 质量门槛：低分候选挡在库门外（原因带分数，benchmark/report 可观测）
  const score = typeof cand.score === 'number' ? cand.score : qualityScore(c)
  const gate = QUALITY_GATE[c.source ?? ''] ?? DEFAULT_QUALITY_GATE
  if (score < gate) {
    meter.record(cfg, { kind: 'memory', action: 'REJECT', reason: 'low-quality', score, gate, type: c.type, subject: c.subject })
    return { action: 'REJECT', reason: `low-quality(score ${score} < gate ${gate})`, score, gate }
  }
  const id = entryId(c.type, c.subject, c.claim)
  const all = loadAll(cfg)
  const dup = all.find((e) => e.id === id)
  if (dup) {
    // 重现证据：同一知识再次被提出 → 记会话来源与次数（晋升判据：≥2 独立会话）
    dup.seenCount = (dup.seenCount ?? 1) + 1
    dup.lastSeenAt = now
    if (c.sessionId) {
      const seen = new Set([...(dup.seenSessions ?? []), ...(dup.sessionId ? [dup.sessionId] : []), c.sessionId])
      dup.seenSessions = [...seen].slice(-5)
    }
    persist(cfg, all)
    meter.record(cfg, { kind: 'memory', action: 'NOOP', id, type: c.type, subject: c.subject, seen: dup.seenCount })
    return { action: 'NOOP', id, reason: 'id-exists', seen: dup.seenCount }
  }
  // 同 subject 的有效旧条目 → 按 claim 相似度分流
  const live = activeEntriesFrom(all)
  const sameSubject = live.filter((e) => e.subject === c.subject && e.type === c.type)
  let action = 'ADD'
  let supersedes = null
  for (const old of sameSubject) {
    const sim = similarity(old.claim, c.claim)
    if (sim >= 0.75) {
      meter.record(cfg, { kind: 'memory', action: 'NOOP', id, type: c.type, subject: c.subject, sim: Number(sim.toFixed(2)) })
      return { action: 'NOOP', id, reason: 'equivalent', sim }
    }
    if (sim >= 0.25) { action = 'UPDATE'; supersedes = old.id }
  }
  const entry = { id, ...c, score, ts: now, status: action === 'DELETE' ? 'refuted' : 'active', supersedes }
  if (action === 'UPDATE') {
    const old = all.find((e) => e.id === supersedes)
    if (old) old.superseded_by = id
  }
  all.push(entry)
  persist(cfg, all)
  meter.record(cfg, { kind: 'memory', action, id, type: c.type, subject: c.subject })
  queueSync(cfg, entry)
  return { action, id, entry }
}

/** 显式证伪：新证据推翻旧条目（DELETE 语义，旧条目进历史不丢）。 */
export function refute(cfg, { subject, claim, type = null }, { now = Date.now() } = {}) {
  const live = activeEntries(cfg)
  const hit = live.find((e) => e.subject === subject && (type === null || e.type === type))
  if (!hit) return { action: 'NOOP', reason: 'not-found' }
  const all = loadAll(cfg)
  const row = all.find((e) => e.id === hit.id)
  const refutation = {
    id: entryId('anti_pattern', subject, claim ?? `refuted:${hit.id}`),
    type: 'anti_pattern', subject, claim: String(claim ?? `已证伪：${hit.claim}`).slice(0, 400),
    keywords: [], confidence: 0.9, ttl: 'durable', source: 'refute',
    project: hit.project ?? null, sessionId: null, evidence: [hit.id],
    ts: now, status: 'active', supersedes: null,
  }
  if (row) row.superseded_by = refutation.id
  all.push(refutation)
  persist(cfg, all)
  meter.record(cfg, { kind: 'memory', action: 'DELETE', id: hit.id, by: refutation.id, subject })
  queueSync(cfg, refutation)
  return { action: 'DELETE', id: hit.id, by: refutation.id }
}

// ---------------------------------------------------------------- 检索与注入

/**
 * 关键词检索（零依赖）：subject 命中 ×3、claim ×1、keywords ×0.5，时间新近度做次级排序。
 * @returns 预算内的 top-k 条目（带 score）
 */
/** 读分权重：subject 命中远比 claim 命中重要；keyword 是弱信号。 */
export const READ_WEIGHTS = { subject: 3, claim: 1, keyword: 0.5 }
/** 读分模式（A/B 用）：default 由评测决定，不靠直觉。 */
export const SCORE_MODES = ['legacy', 'rel', 'rel-quality', 'rel-quality-mild', 'rel-quality-sqrt', 'rel-recency', 'two-layer', 'lexicographic']
// 默认模式由评测 A/B 决定（scripts/score-ab 结论，勿凭直觉改）：
// rel-quality-mild 在跨会话 MRR 0.783 / top1 65.6% / recall 98.4% 三项全胜 baseline（0.781/63.9%/96.7%）；
// 而 two-layer（饱和归一×三因子）显著变差（0.681/50.8%/95.1%）——归一化与多因子连乘都是噪声。
export const DEFAULT_SCORE_MODE = 'rel-quality-mild'
/** 质量因子下限：质量差可以降权，但不至于让条目彻底消失（召回优先）。 */
const QUALITY_FLOOR = 0.3
/** recency 半衰期（天）——只做温和调制，不让新条目无脑压过旧结论。 */
const RECENCY_HALF_LIFE_DAYS = 30

/**
 * 两层读分（用户拍板）：readScore = relevance × quality × recency。
 * - relevance：token 重叠饱和归一（rel/(rel+4)）——避免长条目靠字数刷分
 * - quality：写分（TYPE_WEIGHT × signalDensity）作排序因子，下限 0.3
 * - recency：有界衰减 [0.7, 1.0]——老条目降权但不淘汰
 * 纯函数、确定性（同输入同输出），注入块逐字节稳定的前提。
 */
/** 原始相关度（未归一）：subject×3 + claim×1 + keyword×0.5。 */
export function relevanceOf(e, q) {
  let rel = 0
  for (const t of tokensOf(e.subject)) if (q.has(t)) rel += READ_WEIGHTS.subject
  for (const t of tokensOf(e.claim)) if (q.has(t)) rel += READ_WEIGHTS.claim
  for (const w of e.keywords ?? []) if (q.has(String(w).toLowerCase())) rel += READ_WEIGHTS.keyword
  return rel
}

export function readScore(e, q, { now = Date.now(), qualityBoost = 1, mode = DEFAULT_SCORE_MODE } = {}) {
  const rel = relevanceOf(e, q)
  if (rel <= 0) return 0
  const rawQuality = typeof e.score === 'number' ? e.score : 0.6
  const quality = Math.min(1, Math.max(QUALITY_FLOOR, rawQuality))
  const ageDays = Math.max(0, (now - (e.ts ?? 0)) / 86_400_000)
  const recency = 0.7 + 0.3 * 2 ** (-ageDays / RECENCY_HALF_LIFE_DAYS)
  switch (mode) {
    case 'rel': return rel
    case 'rel-quality': return rel * quality * qualityBoost
    case 'rel-quality-mild': return rel * (0.7 + 0.3 * quality) * qualityBoost   // 默认：温和调制
    case 'rel-quality-sqrt': return rel * Math.sqrt(quality) * qualityBoost
    case 'rel-recency': return rel * recency * qualityBoost
    case 'two-layer': return (rel / (rel + 4)) * quality * recency * qualityBoost
    case 'legacy':   // 旧口径：原始相关度 + 24h 内新鲜奖励 0.5
    default:
      return rel + (ageDays < 1 ? 0.5 : 0)
  }
}

// ---------------------------------------------------------------- 画像条目（A3/B4）
// 用户画像 = 记忆库里被「晋升」的条目：跨会话复现（≥2 独立会话）且质量达标，
// 或用户手动 pin。用途：① 常驻注入 ② 读时加成 ③ 名额与字符预算封顶。

/** 画像预算：条目数与字符数双封顶（常驻注入不能成为体积源）。 */
export const PROFILE_MAX_ENTRIES = 20
export const PROFILE_MAX_CHARS = 800
export const PROFILE_PROMOTE_MIN_SESSIONS = 2
export const PROFILE_PROMOTE_MIN_QUALITY = 0.8
export const PROFILE_DEMOTE_DAYS = 30
export const PROFILE_READ_BOOST = 1.2

/** 画像条目（活跃）：profile=true 且未被取代。 */
export function profileEntries(cfg, { now = Date.now() } = {}) {
  return activeEntries(cfg)
    .filter((e) => e.profile === true)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || (b.ts ?? 0) - (a.ts ?? 0))
}

/** 手动晋升/降级（pin 的条目不会被自动降级）。 */
export function setProfile(cfg, id, on, { by = 'pin', now = Date.now() } = {}) {
  const all = loadAll(cfg)
  const e = all.find((x) => x.id === id)
  if (!e) return { ok: false, reason: 'not-found' }
  if (on) { e.profile = true; e.promotedAt = now; e.promotedBy = by } else {
    delete e.profile; delete e.promotedAt; delete e.promotedBy
  }
  persist(cfg, all)
  meter.record(cfg, { kind: 'memory', action: on ? 'PROMOTE' : 'DEMOTE', id, by, type: e.type, subject: e.subject })
  return { ok: true, entry: e }
}

/**
 * 自动晋升 + 自动降级（幂等，按需调用）。
 * 晋升：跨会话复现（seenSessions ≥2）+ 质量 ≥0.8 + 类型属于画像候选（preference/decision/conclusion）
 * 降级：仅自动晋升的条目，且 30 天未再出现（手动 pin 永久保留）
 * 预算：晋升后超限 → 按（pin 优先保留，其次分数/新鲜度）裁到上限
 */
export function autoProfile(cfg, { now = Date.now() } = {}) {
  const all = loadAll(cfg)
  const live = activeEntriesFrom(all)
  let promoted = 0, demoted = 0
  const PROFILE_TYPES = new Set(['preference', 'decision', 'conclusion'])
  for (const e of live) {
    const sessions = new Set([...(e.seenSessions ?? []), ...(e.sessionId ? [e.sessionId] : [])])
    const eligible = PROFILE_TYPES.has(e.type)
      && sessions.size >= PROFILE_PROMOTE_MIN_SESSIONS
      && (e.score ?? 0) >= PROFILE_PROMOTE_MIN_QUALITY
    if (e.profile !== true && eligible) {
      e.profile = true; e.promotedAt = now; e.promotedBy = 'auto'; promoted++
    }
  }
  for (const e of live) {
    if (e.profile !== true || e.promotedBy !== 'auto') continue
    const lastSeen = Math.max(e.lastSeenAt ?? 0, e.ts ?? 0)
    if (now - lastSeen > PROFILE_DEMOTE_DAYS * 86_400_000) {
      delete e.profile; delete e.promotedAt; delete e.promotedBy; demoted++
    }
  }
  // 预算裁剪：pin 永久保留；auto 条目按分数×新鲜度裁掉弱者
  const prof = live.filter((e) => e.profile === true)
    .sort((a, b) => (b.promotedBy === 'pin' ? 1 : 0) - (a.promotedBy === 'pin' ? 1 : 0)
      || (b.score ?? 0) - (a.score ?? 0) || (b.ts ?? 0) - (a.ts ?? 0))
  const keep = new Set()
  let chars = 0
  for (const e of prof) {
    const cost = (e.subject?.length ?? 0) + (e.claim?.length ?? 0) + 4
    if (keep.size >= PROFILE_MAX_ENTRIES || chars + cost > PROFILE_MAX_CHARS) continue
    keep.add(e.id); chars += cost
  }
  let trimmed = 0
  for (const e of prof) {
    if (!keep.has(e.id)) { delete e.profile; delete e.promotedAt; delete e.promotedBy; trimmed++ }
  }
  if (promoted || demoted || trimmed) persist(cfg, all)
  if (promoted || demoted || trimmed) {
    meter.record(cfg, { kind: 'memory-profile', action: 'auto', promoted, demoted, trimmed, kept: keep.size })
  }
  return { promoted, demoted, trimmed, kept: keep.size }
}

/**
 * 读时加成因子：画像条目 ×1.2（接 search 的 qualityBoostOf）。
 *
 * 受控实验（金标 61 对跨会话，2026-09-15）：
 * - 晋升「正确」条目（= 金标期望条目）38 条：MRR 0.783→0.802，top1 65.6%→67.2%，recall 持平
 * - 晋升「干扰项」（= 无关高分条目）38 条：MRR 0.783→0.772，recall 98.4%→96.7%
 * 结论：加成方向正确但价值取决于晋升精度（故有 ≥2 会话 + 质量 0.8 + 预算 20 条的门槛）；
 * ×1.2 足够温和——画像不准确时只轻微劣化，不会毁掉检索。
 */
export function profileBoostOf(cfg) {
  const ids = new Set(profileEntries(cfg).map((e) => e.id))
  if (ids.size === 0) return null
  return (e) => (ids.has(e.id) ? PROFILE_READ_BOOST : 1)
}

/** 命中查询的画像条目（常驻注入用）：按 query 打分取前 N，受字符预算约束。 */
export function profileInjectLines(cfg, query, { maxEntries = 8, maxChars = PROFILE_MAX_CHARS } = {}) {
  const prof = profileEntries(cfg)
  if (prof.length === 0) return []
  const q = query ? tokensOf(query) : new Set()
  const ranked = prof
    .map((e) => ({ e, rel: q.size ? relevanceOf(e, q) : 0 }))
    .sort((a, b) => b.rel - a.rel || (b.e.score ?? 0) - (a.e.score ?? 0) || (b.e.ts ?? 0) - (a.e.ts ?? 0))
  const out = []
  let chars = 0
  for (const { e } of ranked.slice(0, maxEntries)) {
    const line = renderEntryLine(e)
    if (chars + line.length > maxChars) break
    out.push(line); chars += line.length
  }
  return out
}

/** 单条条目的一行渲染（画像块/注入块共用，确定性）。 */
export function renderEntryLine(e) {
  const date = new Date(e.ts ?? 0).toISOString().slice(0, 10)
  return `- [${e.type}] ${displayOf(e)}（${date}，id:${e.id}）`
}

/** 会话画像文本：本会话已入库条目的主题/内容摘要（注入查询的混合源）。 */
export function sessionProfileOf(cfg, sessionId, { maxChars = 300, maxEntries = 8 } = {}) {
  if (!sessionId) return ''
  const mine = activeEntries(cfg).filter((e) => e.sessionId === sessionId)
  if (mine.length === 0) return ''
  mine.sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0))          // 最近的优先
  const parts = []
  let used = 0
  for (const e of mine.slice(0, maxEntries)) {
    const t = e.subject ? `${e.subject} ${e.claim}` : e.claim
    if (used + t.length > maxChars) break
    parts.push(t)
    used += t.length
  }
  return parts.join(' ')
}

/** 画像占比：随会话条目数增长，上限 maxShare（用户拍板 70%）。 */
export function profileShareOf(entryCount, { maxShare = 0.7 } = {}) {
  if (entryCount <= 0) return 0
  return Math.min(maxShare, 0.2 + 0.1 * (entryCount - 1))
}

/**
 * 混合查询：用户消息 ⊕ 会话画像。占比靠**字符质量比**控制（画像长度按
 * share/(1-share) 缩放），保持确定性、可测；无画像时退回纯用户消息（冷启动）。
 *
 * ⚠ A/B 实测（金标 74 对跨/同会话，2026-09-15）：混合**不提升且略降排序**
 * （MRR 0.799→0.765，top1 67.6%→62.2%，recall 持平）。设计初衷（短追问如
 * 「继续」缺主题词）在金标里无法覆盖——配对本身要求 ≥2 token 重叠，短消息
 * 配不上对。结论：默认不启用（memoryQueryBlend: false），仅供真实会话出现
 * 短追问场景时手工开启验证。
 */
export function blendQuery(userQuery, profileText, { share = 0, maxShare = 0.7 } = {}) {
  const u = String(userQuery ?? '').trim()
  const p = String(profileText ?? '').trim()
  const sh = Math.min(maxShare, Math.max(0, share))
  if (!u || !p || sh <= 0) return u
  const profileChars = Math.round((sh / (1 - sh)) * [...u].length)
  if (profileChars <= 0) return u
  const cut = [...p].slice(0, profileChars).join('')
  return `${u} ${cut}`
}

export function search(cfg, query, { k = 6, maxChars = 2_500, qualityBoostOf = null, mode = DEFAULT_SCORE_MODE } = {}) {
  const q = tokensOf(query)
  if (q.size === 0) return []
  const now = Date.now()
  const scored = []
  for (const e of activeEntries(cfg)) {
    const boost = qualityBoostOf ? qualityBoostOf(e) : 1      // 画像加成等外部因子
    const score = readScore(e, q, { now, qualityBoost: boost, mode })
    if (score > 0) scored.push({ ...e, score, _rel: relevanceOf(e, q) })
  }
  if (mode === 'lexicographic') {
    // 相关度优先、质量次之——不做乘法混合（乘法在真实数据上被证明是噪声，见 score-ab）
    scored.sort((a, b) => b._rel - a._rel
      || (b.score ?? 0) - (a.score ?? 0)
      || (b.ts ?? 0) - (a.ts ?? 0) || (a.id < b.id ? -1 : 1))
  } else {
    scored.sort((a, b) => b.score - a.score || (b.ts ?? 0) - (a.ts ?? 0) || (a.id < b.id ? -1 : 1))
  }
  const out = []
  let used = 0
  for (const e of scored.slice(0, k)) {
    const cost = e.subject.length + e.claim.length + 40
    if (used + cost > maxChars) break
    out.push(e)
    used += cost
  }
  return out
}

/** 注入块确定性渲染：同条目集 → 逐字节相同（尾部追加纪律的前提）。 */
/** 显示文本：claim 已含 subject 信息（或 subject 为空）时只显示 claim，避免「X：X…」冗余。 */
function displayOf(e) {
  if (!e.subject) return e.claim
  return e.claim.startsWith(e.subject.slice(0, 20)) ? e.claim : `${e.subject}：${e.claim}`
}

export function renderInjectBlock(query, entries) {
  if (entries.length === 0) return null
  const lines = [`<lcm-memory query="${String(query).slice(0, 80).replace(/"/g, '\'')}">`]
  for (const e of entries) lines.push(renderEntryLine(e))
  lines.push('</lcm-memory>')
  return lines.join('\n')
}

// ---------------------------------------------------------------- OpenViking 同步（outbox 模式）

function outboxPath(cfg) { return join(cfg.memoryDir, 'outbox.jsonl') }

export function outboxPending(cfg) {
  const file = outboxPath(cfg)
  if (!existsSync(file)) return []
  const out = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue
    try { out.push(JSON.parse(line)) } catch { /* 坏行跳过 */ }
  }
  return out
}

/** 记忆条目 → viking markdown。 */
export function entryMarkdown(e) {
  const rows = [
    `# [${e.type}] ${e.subject}`, '',
    `- claim: ${e.claim}`,
    `- score: ${e.score ?? '-'} ｜ ttl: ${e.ttl ?? 'durable'} ｜ id: ${e.id}`,
    `- source: ${e.source}${e.project ? ` ｜ project: ${e.project}` : ''}`,
  ]
  if (e.supersedes) rows.push(`- supersedes: ${e.supersedes}`)
  if (e.evidence?.length) rows.push(`- evidence: ${e.evidence.join(', ')}`)
  return rows.join('\n') + '\n'
}

export function vikingUriFor(cfg, e) {
  return `viking://user/${cfg.openvikingUser}/memories/lcm/${e.type}/${e.id}.md`
}

/** 入库即入 outbox（配置了 OpenViking 才有同步语义）；真正发送由 flushOutbox 完成。 */
function queueSync(cfg, entry) {
  if (!cfg.openvikingConfigured) return
  try {
    mkdirSync(cfg.memoryDir, { recursive: true })
    const file = outboxPath(cfg)
    const pending = outboxPending(cfg).filter((p) => p.id !== entry.id)
    pending.push({ id: entry.id, uri: vikingUriFor(cfg, entry), content: entryMarkdown(entry), ts: Date.now() })
    writeFileSync(file, pending.map((p) => JSON.stringify(p)).join('\n') + '\n', 'utf8')
  } catch { /* outbox 失败静默：本地库才是 source of truth */ }
}

/** 单次写入 OpenViking（content/write，X-API-Key）。始终读完响应体再返回，避免连接滞留。
 * User-Agent 必须自定义：服务器前的 Cloudflare 按 UA 拦截，undici 默认 UA "node" 会 403
 * （实测：自定义 UA 200，node 403——与记忆中「sandbox 出口被拦」的旧结论不同，真因是 UA）。 */
export async function vikingWrite(cfg, { uri, content, timeoutMs = 8_000 }) {
  const res = await fetch(`${cfg.openvikingUrl.replace(/\/$/, '')}/api/v1/content/write`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-API-Key': String(cfg.openvikingApiKey),
      'User-Agent': `dsh-lcm/${globalThis.LCM_VERSION ?? '0.1'}`,
    },
    body: JSON.stringify({ uri, content, mode: 'replace' }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  await res.text()
  if (!res.ok) throw new Error(`viking write ${res.status}`)
  return true
}

/** 冲 outbox：逐条发送，成功即移除；返回 {sent, remaining}。 */
export async function flushOutbox(cfg) {
  if (!cfg.openvikingConfigured) return { sent: 0, remaining: 0, reason: 'not-configured' }
  const pending = outboxPending(cfg)
  let sent = 0
  const remain = []
  for (const p of pending) {
    try {
      await vikingWrite(cfg, p)
      sent++
      meter.record(cfg, { kind: 'memory-sync', id: p.id, uri: p.uri, ok: true })
    } catch (error) {
      meter.record(cfg, { kind: 'memory-sync', id: p.id, uri: p.uri, ok: false, error: String(error?.message ?? error).slice(0, 120) })
      remain.push(p)
    }
  }
  try {
    writeFileSync(outboxPath(cfg), remain.map((p) => JSON.stringify(p)).join('\n') + (remain.length ? '\n' : ''), 'utf8')
  } catch { /* 静默 */ }
  return { sent, remaining: remain.length }
}

// ---------------------------------------------------------------- 确定性提取

const DECISION_RE = /(决定|拍板|选定|选择|改用|换成|放弃|不用|采用|已切|decided|chose|switch(?:ed)? to|settled on|adopted|we use|改为)/
const THREAD_RE = /(TODO|待办|待验证|未完成|下一步|接下来要|next step|pending|follow-up|遗留)/
// 结论需要显式结论词或百分比——纯 4 位数字（日期/序号）不算量化证据
const CONCLUSION_RE = /(实测|验证了|结论[是是：:]|表明|证明|发现[一一个]?|measured|verified|turned out|confirms?)|\d+(?:\.\d+)?%/
const FACT_PATH_RE = /(?:\/[\w.-]+){2,}|[\w.-]+\.(?:md|json|ya?ml|toml|py|js|mjs|ts|go|rs)\b/

/** 类型权重（用户确认：decision 1.0 / conclusion 0.9 / preference 0.85 / fact 0.8 / open_thread 0.6）。 */
export const TYPE_WEIGHT = { decision: 1.0, conclusion: 0.9, preference: 0.85, fact: 0.8, open_thread: 0.6 }

/** 信号密度：路径/代码锚/百分比/版本号加分；表格残片/超长碎片减分。全部确定性。 */
export function signalDensity(claim) {
  let s = 0.5
  if (/(?:\/[\w.-]+){2,}|[\w.-]+\.(?:md|json|ya?ml|toml|py|js|mjs|ts|go|rs)\b/.test(claim)) s += 0.2   // 文件路径/文件名（与 FACT_PATH_RE 同口径）
  if (/`[^`]{3,}`/.test(claim)) s += 0.15              // 代码锚
  if (/\d+(?:\.\d+)?%/.test(claim)) s += 0.15          // 百分比（量化证据）
  if (/v?\d+\.\d+/.test(claim)) s += 0.1               // 版本号
  if (/https?:\/\//.test(claim)) s += 0.1              // URL
  if ((claim.match(/\|/g) ?? []).length >= 2) s -= 0.3 // 表格残片
  if (claim.length > 320) s -= 0.2                     // 超长碎片
  return Math.min(1, Math.max(0.1, s))
}

/** 写入质量分 = 类型权重 × 信号密度。这是入库门槛和将来画像晋升的依据。 */
export function qualityScore(c) {
  return Math.round((TYPE_WEIGHT[c.type] ?? 0.7) * signalDensity(c.claim) * 100) / 100
}

/**
 * 确定性提取：从（折叠摘要/对话）文本里挑记忆候选，零 LLM 调用。
 * compaction/summary 的分节 markdown 尤其友好：小节标题映射类型，列表项即候选。
 * 质量纪律（benchmark 驱动）：表格行整行跳过（脱离表头无语义）、引用前缀清理、
 * 无锚点不再截断 claim 当 subject（零信息且检索重复计权）、每候选带质量分。
 * @returns Array<{type, subject, claim, keywords, evidence, score}>
 */
export function extractCandidates(text) {
  const src = String(text ?? '')
  if (!src) return []
  const lines = src.split('\n')
  const candidates = []
  let section = ''
  const seen = new Set()
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    const heading = /^(#{1,4})\s+(.*)$/.exec(line)
    if (heading) { section = heading[2].toLowerCase(); continue }
    if (line.startsWith('|')) continue   // 表格行：脱离表头的单元格没有独立语义
    const isListItem = /^[-*•]\s+/.test(line)
    if (!isListItem && line.length > 240) continue   // 只要列表项（摘要形态）或短行
    const body = line.replace(/^[-*•]\s+/, '').replace(/^>\s?/, '').trim()   // 清引用块标记
    if (!body) continue
    const type = classify(body, section)
    if (type === null) continue
    const claim = body.slice(0, 400)
    const key = claim.toLowerCase().replace(/\s+/g, '')
    if (seen.has(key)) continue
    seen.add(key)
    const cand = {
      type,
      subject: subjectOf(body) || section || '',
      claim,
      keywords: [],
      evidence: [],
      score: 0,
    }
    cand.score = qualityScore(cand)
    candidates.push(cand)
    if (candidates.length >= 12) break
  }
  return candidates
}

function classify(body, section) {
  if (forbiddenReason(body)) return null
  if (/intent|目标|请求与意图/.test(section) || THREAD_RE.test(body)) return 'open_thread'
  if (DECISION_RE.test(body)) return 'decision'
  if (CONCLUSION_RE.test(body)) return 'conclusion'
  if (FACT_PATH_RE.test(body) || /https?:\/\//.test(body)) return 'fact'
  if (/prefer|偏好|always|never|一律/.test(body)) return 'preference'
  return null
}

function subjectOf(body) {
  // 取路径/URL/反引号片段做主题锚；无锚返回 null（不截断 claim 冒充 subject——
  // 那是零信息锚点，且检索时 subject×3 权重会重复放大 claim 头部）
  const anchor = /`([^`]{3,60})`/.exec(body) ?? FACT_PATH_RE.exec(body) ?? /https?:\/\/[\w./-]+/.exec(body)
  if (anchor) return String(anchor[1] ?? anchor[0]).slice(0, 60)
  return null
}
