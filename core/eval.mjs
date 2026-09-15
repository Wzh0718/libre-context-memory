/** 金标评测：记忆检索质量的可放行依据（全确定性，零 LLM）。
 *
 * 为什么需要它：memoryInjectMode / foldMode 从 shadow 切 active 不能凭感觉——
 * 必须有「检索能不能召回该召回的、会不会召回不该召回」的量化证据。
 *
 * 指标（阈值即放行条件）：
 * - recall@k ≥ 0.8：正例对（真实用户消息 → 该会话熔炼出的条目）命中率
 * - 反例击穿 = 0：已死条目（被取代/被推翻）绝不浮出；无意义查询绝不返回内容
 *
 * 金标集构造（确定性，从真实数据）：
 * - 正例：会话日志里的真人 user talk × 该会话产出的最佳条目（1:1，每会话上限 4 条），
 *   按 token 重叠 ≥2 配对——「用户再次谈到这个话题 → 系统应能召回当时学到的东西」
 * - 兜底正例（无会话日志时）：条目自身 keywords 当查询（标 self，单独统计，
 *   因为它只测检索管道不测提取质量）
 * - 反例 1（死条目）：query 取自被取代/被推翻条目的文本，禁止该 id 出现
 * - 反例 2（空查询）：确定性伪随机 token 串，期望零结果
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import * as memory from './memory.mjs'
import { userTalksOf } from './profile.mjs'
import { sessionLogFiles } from './recover.mjs'

export const EVAL_K = 6
export const RECALL_TARGET = 0.8
/** 会话配对样本 ≥ 此值才用主指标判放行（否则样本太小，回退总体）。 */
export const MIN_SESSION_PAIRS = 10
/** 查询留存上限；打分与存储必须用同一文本（不变量）。 */
export const QUERY_MAX_CHARS = 2_000
const GOLDEN_VERSION = 1

/** 确定性伪随机 token（不用 Math.random——金标集必须可复现）。 */
function gibberish(i) {
  const syllables = ['zor', 'qux', 'vlim', 'trax', 'norp', 'yek', 'frib', 'wast', 'glum', 'plen']
  let s = ''
  let n = i * 2654435761 % 4294967296
  for (let j = 0; j < 4; j++) { s += syllables[n % syllables.length]; n = Math.floor(n / syllables.length) || 7 }
  return s + 'x' + i
}

/** 正例配对打分：subject/keywords 命中 1 分，claim 命中 1/3 分（claim 长，弱信号）。 */
function pairScore(talk, entry) {
  const q = memory.tokensOf(talk)
  if (q.size === 0) return 0
  let overlap = 0
  for (const t of memory.tokensOf(entry.subject)) if (q.has(t)) overlap += 1
  for (const w of entry.keywords ?? []) if (q.has(String(w).toLowerCase())) overlap += 1
  let claimHits = 0
  for (const t of memory.tokensOf(entry.claim)) if (q.has(t)) claimHits += 1
  return overlap + Math.floor(claimHits / 3)
}

/**
 * 构造金标集。返回 {builtAt, version, positives, negatives, stats}。
 * positives: {query, expectId, sessionId, project, kind:'session'|'self', overlap}
 * negatives: {query, forbidId|null, expectEmpty, kind:'dead'|'gibberish', note}
 */
/** 从会话日志路径推项目名：<sessionsDir>/--home-libre-project-x--/<sessionId>/session.jsonl.zstd */
function projectOfDir(logPath) {
  return normalizeProject(logPath.split('/').at(-3))
}

/** 项目键规范化：条目存的是 cwd（/home/libre/project/x），会话目录名是短横线形
 *  （--home-libre-project-x--）。不归一 → 跨会话配对恒为 0（生产环境踩点）。 */
export function normalizeProject(p) {
  if (!p) return '__none__'
  const s = String(p).replace(/^[-\/]+|[-\/]+$/g, '')   // 斜杠与短横线都要剥（否则 cwd 形残留前导 -）
  return s.replace(/\//g, '-')
}

export function buildGolden(cfg, { sessionsDir, maxPerSession = 6, logLimit = 200, crossMaxPerEntry = 3, crossMinOverlap = 2 } = {}) {
  const all = memory.loadAll(cfg)
  const live = memory.activeEntries(cfg)
  const dead = all.filter((e) => !live.some((l) => l.id === e.id))
  const positives = []
  const seen = new Set()
  const crossCount = new Map()   // entryId → 已配跨会话对数

  // ---- 正例：从会话日志找真人 talk × 该会话条目 ----
  const bySession = new Map()
  const byProject = new Map()
  for (const e of live) {
    if (e.sessionId) {
      if (!bySession.has(e.sessionId)) bySession.set(e.sessionId, [])
      bySession.get(e.sessionId).push(e)
    }
    const proj = normalizeProject(e.project)
    if (!byProject.has(proj)) byProject.set(proj, [])
    byProject.get(proj).push(e)
  }
  if (bySession.size > 0 && (sessionsDir ?? cfg.sessionsDir)) {
    const logs = sessionLogFiles(sessionsDir ?? cfg.sessionsDir, logLimit)
    for (const log of logs) {
      const logPath = typeof log === 'string' ? log : log.path
      const sessionId = logPath.split('/').at(-2)   // <sessionsDir>/<project>/<sessionId>/session.jsonl.zstd
      const entries = bySession.get(sessionId)
      // 同会话配对只对本会话产出过条目的日志做；跨会话配对对所有会话做
      // （曾因 `if (!entries) continue` 把自身无条目的会话整个跳过 → 跨会话对恒少）
      // 1 条查询 → 只配 1 个最佳条目（一个话题只有一个正解；一对多必然假 miss：
      // 实测一条粘贴日志曾配到 7 个不同条目，而 top-6 装不下 → recall 被冤枉）
      // 不变量：查询存的就是打分用的文本（曾因存 200 字符截断、打分用全文，
      // 造出 4 个「配对分 0」的假对——长日志的关键 token 在截断点之后）
      let made = 0
      for (const rawTalk of entries ? userTalksOf(logPath) : []) {
        const talk = rawTalk.slice(0, QUERY_MAX_CHARS)
        if (talk.length < 12) continue                 // 太短的寒暄没有区分度
        if (made >= maxPerSession) break
        let best = null
        for (const e of entries) {
          const overlap = pairScore(talk, e)
          if (overlap < 2) continue
          if (!best || overlap > best.overlap || (overlap === best.overlap && e.id < best.entry.id)) {
            best = { entry: e, overlap }
          }
        }
        if (!best) continue
        const key = `${best.entry.id}::${talk.slice(0, 40)}`
        if (seen.has(key)) continue
        seen.add(key)
        made++
        positives.push({
          query: talk, expectId: best.entry.id, sessionId, project: best.entry.project ?? null,
          kind: 'session', overlap: best.overlap,
        })
      }

      // 跨会话召回（真正的使用场景）：本会话重提**其它会话**学过的话题 →
      // 应召回那条旧记忆。同会话配对只是「刚说过马上再问」，跨会话才检验长期记忆。
      if (crossMaxPerEntry > 0) {
        const proj = projectOfDir(logPath)
        const others = (byProject.get(proj) ?? []).filter((e) => e.sessionId !== sessionId)
        for (const rawTalk of userTalksOf(logPath).slice(0, 40)) {
          const q = rawTalk.slice(0, QUERY_MAX_CHARS)
          if (q.length < 16) continue
          let bestCross = null
          for (const e of others) {
            const hitCount = crossCount.get(e.id) ?? 0
            if (hitCount >= crossMaxPerEntry) continue
            const overlap = pairScore(q, e)
            if (overlap < crossMinOverlap) continue        // 跨会话重叠下限（可调，默认 2）
            if (!bestCross || overlap > bestCross.overlap || (overlap === bestCross.overlap && e.id < bestCross.entry.id)) {
              bestCross = { entry: e, overlap }
            }
          }
          if (!bestCross) continue
          const key = `x:${bestCross.entry.id}::${q.slice(0, 40)}`
          if (seen.has(key)) continue
          seen.add(key)
          crossCount.set(bestCross.entry.id, (crossCount.get(bestCross.entry.id) ?? 0) + 1)
          positives.push({
            // sessionId 语义统一 = 条目所属会话；跨会话另记 fromSession（查询来自哪）
            query: q, expectId: bestCross.entry.id,
            sessionId: bestCross.entry.sessionId ?? null, fromSession: sessionId,
            project: bestCross.entry.project ?? null,
            kind: 'cross', overlap: bestCross.overlap,
          })
        }
      }
    }
  }

  // ---- 兜底正例：无配对条目用自身 keywords 当查询（标 self，单独看） ----
  const paired = new Set(positives.map((p) => p.expectId))
  for (const e of live) {
    if (paired.has(e.id)) continue
    const q = [e.subject, ...(e.keywords ?? [])].filter(Boolean).join(' ').trim()
    if (q.length < 6) continue
    positives.push({ query: q, expectId: e.id, sessionId: e.sessionId ?? null, project: e.project ?? null, kind: 'self', overlap: pairScore(q, e) })
  }

  // ---- 反例 ----
  const negatives = []
  for (const e of dead.slice(0, 50)) {
    const q = [e.subject, ...(e.keywords ?? []).slice(0, 3)].filter(Boolean).join(' ').trim()
    if (q.length < 6) continue
    negatives.push({
      query: q, forbidId: e.id, expectEmpty: false, kind: 'dead',
      note: e.superseded_by ? 'superseded' : (e.source === 'refute' ? 'refuted' : 'inactive'),
    })
  }
  for (let i = 0; i < 10; i++) {
    negatives.push({ query: `${gibberish(i)} ${gibberish(i + 100)}`, forbidId: null, expectEmpty: true, kind: 'gibberish', note: 'noise' })
  }

  const stats = {
    entries: all.length, live: live.length, dead: dead.length,
    positiveSession: positives.filter((p) => p.kind === 'session').length,
    positiveCross: positives.filter((p) => p.kind === 'cross').length,
    positiveSelf: positives.filter((p) => p.kind === 'self').length,
    negativeDead: negatives.filter((n) => n.kind === 'dead').length,
    negativeGibberish: negatives.filter((n) => n.kind === 'gibberish').length,
  }
  return { builtAt: Date.now(), version: GOLDEN_VERSION, stats, positives, negatives }
}

/** 跑评测。返回 {recall, hits, total, penetration, misses, penetrationDetails, byKind, ok}。 */
export function runEval(cfg, golden, { k = EVAL_K, mode = memory.DEFAULT_SCORE_MODE } = {}) {
  const results = new Map()   // query → id 列表
  const queryIds = (q) => {
    if (!results.has(q)) results.set(q, memory.search(cfg, q, { k, mode }).map((e) => e.id))
    return results.get(q)
  }
  let hits = 0
  const misses = []
  const byKind = {}
  const rankSum = { all: 0, n: 0, cross: 0, nCross: 0 }   // MRR 累加（1/rank，未命中记 0）
  let top1 = { all: 0, cross: 0 }
  for (const p of golden.positives) {
    const ids = queryIds(p.query)
    const rank = ids.indexOf(p.expectId)          // -1 = 未命中
    const hit = rank >= 0
    const rr = hit ? 1 / (rank + 1) : 0
    rankSum.all += rr; rankSum.n++
    if (rank === 0) top1.all++
    if (p.kind === 'cross') { rankSum.cross += rr; rankSum.nCross++; if (rank === 0) top1.cross++ }
    byKind[p.kind] ??= { total: 0, hits: 0 }
    byKind[p.kind].total++
    if (hit) { hits++; byKind[p.kind].hits++ } else {
      misses.push({ query: p.query.slice(0, 80), expectId: p.expectId, got: ids.slice(0, 3) })
    }
  }
  const penetrationDetails = []
  for (const n of golden.negatives) {
    const ids = queryIds(n.query)
    if (n.expectEmpty && ids.length > 0) penetrationDetails.push({ kind: 'gibberish-returned', query: n.query, got: ids.length })
    if (n.forbidId && ids.includes(n.forbidId)) penetrationDetails.push({ kind: 'dead-surfaced', query: n.query.slice(0, 60), forbidId: n.forbidId })
  }
  const total = golden.positives.length
  const recall = total === 0 ? null : hits / total
  // 主指标：会话配对 recall（真实用户消息 → 应召回该会话学到的条目）。
  // 自查询正例只测检索管道（同词面必中），样本足量时不进放行判据。
  // 主指标优先级：跨会话（长期记忆的真实场景）> 同会话 > 总体
  const cross = byKind.cross ?? { total: 0, hits: 0 }
  const sess = byKind.session ?? { total: 0, hits: 0 }
  const primary = cross.total >= MIN_SESSION_PAIRS
    ? { metric: 'cross-session', recall: Number((cross.hits / cross.total).toFixed(4)), total: cross.total }
    : (sess.total >= MIN_SESSION_PAIRS
      ? { metric: 'session-pair', recall: Number((sess.hits / sess.total).toFixed(4)), total: sess.total }
      : { metric: 'overall', recall: recall === null ? null : Number(recall.toFixed(4)), total })
  const mrr = rankSum.n === 0 ? null : Number((rankSum.all / rankSum.n).toFixed(4))
  const mrrCross = rankSum.nCross === 0 ? null : Number((rankSum.cross / rankSum.nCross).toFixed(4))
  const top1Rate = rankSum.n === 0 ? null : Number((top1.all / rankSum.n).toFixed(4))
  const top1Cross = rankSum.nCross === 0 ? null : Number((top1.cross / rankSum.nCross).toFixed(4))
  return {
    k, total, hits,
    recall: recall === null ? null : Number(recall.toFixed(4)),
    mrr, mrrCross, top1: top1Rate, top1Cross,
    primary,
    penetration: penetrationDetails.length,
    penetrationDetails: penetrationDetails.slice(0, 10),
    misses: misses.slice(0, 10),
    byKind: Object.fromEntries(Object.entries(byKind).map(([kk, v]) => [kk, { ...v, recall: Number((v.hits / v.total).toFixed(4)) }])),
    ok: primary.recall !== null && primary.recall >= RECALL_TARGET && penetrationDetails.length === 0,
  }
}

/** 金标集缓存：条目 id 稳定 → 缓存可复用；--rebuild 强制重建。 */
export function goldenPath(cfg) { return join(cfg.meterDir, 'eval-golden.json') }

export function loadGolden(cfg, { rebuild = false, sessionsDir, logLimit = 400 } = {}) {
  const file = goldenPath(cfg)
  if (!rebuild && existsSync(file)) {
    try {
      const g = JSON.parse(readFileSync(file, 'utf8'))
      if (g.version === GOLDEN_VERSION) return g
    } catch { /* 损坏 → 重建 */ }
  }
  const g = buildGolden(cfg, { sessionsDir, logLimit })
  try {
    mkdirSync(cfg.meterDir, { recursive: true })
    writeFileSync(file, JSON.stringify(g), 'utf8')
  } catch { /* 只读环境：内存返回 */ }
  return g
}

/** 评测报告（人读）。 */
export function renderEvalReport(r, golden) {
  const lines = []
  lines.push(`记忆检索评测（recall@${r.k}，目标 ≥${RECALL_TARGET}，反例击穿目标 0）`)
  lines.push(`  金标集：${golden.stats.positiveSession} 会话配对 + ${golden.stats.positiveSelf} 自查询正例`
    + ` ｜ ${golden.stats.negativeDead} 死条目 + ${golden.stats.negativeGibberish} 噪声反例`
    + `（记忆库 ${golden.stats.live} 活跃 / ${golden.stats.dead} 已死）`)
  const pr = r.primary
  const prLabel = pr.metric === 'cross-session' ? '跨会话' : pr.metric === 'session-pair' ? '同会话' : '总体（配对样本不足）'
  lines.push(`  排序质量：MRR ${r.mrr === null ? 'n/a' : r.mrr.toFixed(3)}（全）/ ${r.mrrCross === null ? 'n/a' : r.mrrCross.toFixed(3)}（跨会话）`
    + ` ｜ top1 命中 ${r.top1 === null ? 'n/a' : (r.top1 * 100).toFixed(1) + '%'}（跨会话 ${r.top1Cross === null ? 'n/a' : (r.top1Cross * 100).toFixed(1) + '%'}）`)
  lines.push(`  主指标（${prLabel}）recall@${r.k}：`
    + `${pr.recall === null ? 'n/a' : (pr.recall * 100).toFixed(1) + '%'}（${pr.total} 条）`
    + ` ｜ 反例击穿：${r.penetration}`)
  for (const [kind, v] of Object.entries(r.byKind)) {
    const label = kind === 'cross' ? '跨会话（最有价值）' : kind === 'session' ? '同会话' : '自查询（仅测管道，不计放行）'
    lines.push(`    ${label}：${(v.recall * 100).toFixed(1)}%（${v.hits}/${v.total}）`)
  }
  if (r.penetrationDetails.length) {
    lines.push('  击穿明细：')
    for (const d of r.penetrationDetails) lines.push(`    - [${d.kind}] ${d.query}${d.forbidId ? ` → ${d.forbidId}` : ''}`)
  }
  if (r.misses.length) {
    lines.push(`  未命中样例（前 ${r.misses.length} 条）：`)
    for (const m of r.misses) lines.push(`    - 期望 ${m.expectId}；查询「${m.query}」→ 实得 ${m.got.join(',') || '(空)'}`)
  }
  lines.push(r.ok ? '  ✅ 达标（可作 shadow→active 放行依据）' : '  ❌ 未达标（保持 shadow，先修质量）')
  return lines.join('\n')
}
