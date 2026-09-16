/** 价值记账模型测试：三档定价 + 夹窗口 + 守恒不变量 + 归因 + provenance。
 *
 * 定价规则（review 修正版——首版把 delta 按 1.0× 计入每个后续请求，虚高约 7 倍）：
 * - prune/fold：被剪内容早已在缓存前缀里 → 后续请求按折价计，击穿请求按 1.0× 计
 * - compress：reshape 的内容在无臂世界会作为**新内容**进下一个请求 → 首个后续请求
 *   按 1.0× 计，之后同上（折价 / 击穿 1.0×）
 * - 注入：负项；同会话首次按 1.0×，重复按折价（digest 稳定假设）
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { computeValue, VALUE_DEFAULTS } from '../value.mjs'

const SID = 'session-real-1'
let clock = 0
const ts = () => (clock += 100)

function usage(sid, { input = 100, cacheRead = 900, bust = false } = {}) {
  return { ts: ts(), kind: 'usage', sessionId: sid, input, cacheRead, cacheBust: bust }
}
function prune(sid, charsBefore, charsAfter) {
  return { ts: ts(), kind: 'prune', sessionId: sid, charsBefore, charsAfter, tokensBefore: charsBefore / 2 }
}
function fold(sid, charsBefore, charsAfter) {
  return { ts: ts(), kind: 'fold', sessionId: sid, charsBefore, charsAfter }
}
function compressEvt(sid, originalChars, compressedChars) {
  return { ts: ts(), kind: 'compress', sessionId: sid, originalChars, compressedChars }
}
function inject(sid, chars, entries = 1) {
  return { ts: ts(), kind: 'memory-inject', sessionId: sid, chars, entries }
}
function compactionEvt(sid) {
  return { ts: ts(), kind: 'compaction', sessionId: sid, op: 'compaction/summary' }
}

const OPTS = { compactionCeiling: 500_000 }

test('空输入 → 全零', () => {
  const v = computeValue([], OPTS)
  assert.equal(v.requests, 0)
  assert.equal(v.actualEq, 0)
  assert.equal(v.counterfactualEq, 0)
  assert.equal(v.realized.total, 0)
  assert.equal(v.net, 0)
})

test('只有 usage、无臂动作 → 节省恰为 0，反事实 = 实际', () => {
  const v = computeValue([usage(SID), usage(SID), usage(SID)], OPTS)
  assert.equal(v.requests, 3)
  assert.equal(v.realized.total, 0)
  assert.equal(v.counterfactualEq, v.actualEq)
  assert.equal(v.net, 0)
  // 实际成本当量 = 3 × (100 + 900×0.1) = 570
  assert.equal(v.actualEq, 570)
})

test('prune：缓存命中请求按折价计价', () => {
  clock = 0
  const v = computeValue([
    prune(SID, 5000, 1000),          // S = 2000 tok
    usage(SID), usage(SID), usage(SID),
  ], OPTS)
  // 3 个命中请求 × 2000 × 0.1 = 600
  assert.equal(v.realized.prune, 600)
  assert.equal(v.realized.total, 600)
  assert.equal(v.counterfactualEq, v.actualEq + 600)
})

test('prune：击穿请求按 1.0× 计价（cacheBust 字段与 fresh 阈值两条路径）', () => {
  clock = 0
  const v = computeValue([
    prune(SID, 5000, 1000),                       // S = 2000
    usage(SID, { input: 200, cacheRead: 0, bust: true }),   // 字段路径
    usage(SID, { input: 200_000, cacheRead: 0 }),           // 阈值路径（≥50k fresh）
    usage(SID),                                             // 命中
  ], OPTS)
  // 2000×1.0 + 2000×1.0 + 2000×0.1 = 4200
  assert.equal(v.realized.prune, 4200)
})

test('compress：首个后续请求按 1.0×，之后按折价', () => {
  clock = 0
  const v = computeValue([
    compressEvt(SID, 60_000, 20_000),   // S = 20_000 tok
    usage(SID),                          // 首个 → 1.0× → 20_000
    usage(SID),                          // 之后 → 0.1× → 2_000
    usage(SID),                          //      → 0.1× → 2_000
  ], OPTS)
  assert.equal(v.realized.compress, 24_000)
})

test('夹窗口：delta 不超过 ceiling − 实际载荷', () => {
  clock = 0
  const v = computeValue([
    prune(SID, 202_000, 2000),           // S = 100_000 tok，远超窗口余量
    usage(SID), usage(SID),
  ], { ...OPTS, compactionCeiling: 5000 })
  // ceiling = max(会话最大载荷 1000, min(5000, 窗口)) = 5000；room = 5000−1000 = 4000
  // 2 个命中请求 × 4000 × 0.1 = 800；两个请求都被夹
  assert.equal(v.realized.prune, 800)
  assert.equal(v.cappedRequests, 2)
})

test('ceiling 不低于会话实际最大载荷（反事实逐请求 ≥ 实际）', () => {
  clock = 0
  const v = computeValue([
    usage(SID, { input: 8000, cacheRead: 0 }),   // 实际载荷 8000 > compactionCeiling 5000
    prune(SID, 5000, 1000),                       // S = 2000
    usage(SID, { input: 8000, cacheRead: 0 }),   // room = 8000−8000 = 0 → 此请求无节省
    usage(SID),                                   // room = 8000−1000 → delta 2000
  ], { ...OPTS, compactionCeiling: 5000 })
  assert.equal(v.realized.prune, 200)   // 只有最后一个请求受益（2000×0.1）
  assert.ok(v.counterfactualEq >= v.actualEq)
})

test('确定性：同一输入两次运行逐字节一致', () => {
  clock = 0
  const events = [
    compressEvt(SID, 80_000, 10_000), prune(SID, 9000, 1000), usage(SID),
    usage(SID, { input: 60_000, cacheRead: 0 }), fold(SID, 4000, 200), usage(SID),
    inject(SID, 1000), inject(SID, 1000),
  ]
  const a = computeValue(events, OPTS)
  const b = computeValue(events, OPTS)
  assert.equal(JSON.stringify(a), JSON.stringify(b))
})

test('单调性：多加一个臂动作，节省不减少', () => {
  clock = 0
  const base = [prune(SID, 5000, 1000), usage(SID), usage(SID)]
  clock = 0
  const more = [prune(SID, 5000, 1000), fold(SID, 4000, 200), usage(SID), usage(SID)]
  const v1 = computeValue(base, OPTS)
  const v2 = computeValue(more, OPTS)
  assert.ok(v2.realized.total >= v1.realized.total)
})

test('注入为负项：同会话首次 1.0×、重复折价', () => {
  clock = 0
  const v = computeValue([
    inject(SID, 2000),    // 1000 tok × 1.0 = 1000
    inject(SID, 2000),    // 1000 tok × 0.1 = 100
    inject(SID, 4000),    // 2000 tok × 0.1 = 200
    usage(SID),
  ], OPTS)
  assert.equal(v.injectionCost, 1300)
  assert.equal(v.net, -1300)
  assert.equal(v.memory.injects, 3)
})

test('分臂归因之和 = 总节省', () => {
  clock = 0
  const v = computeValue([
    compressEvt(SID, 60_000, 20_000),
    prune(SID, 5000, 1000),
    fold(SID, 4000, 200),
    usage(SID), usage(SID),
  ], OPTS)
  const parts = v.realized.compress + v.realized.prune + v.realized.fold
  assert.equal(parts, v.realized.total)
  assert.ok(v.realized.fold > 0)
})

test('avoidedBust 单列、不计入净节省', () => {
  clock = 0
  const v = computeValue([
    usage(SID, { input: 10_000, cacheRead: 30_000 }),   // 载荷 40_000（动作前最近一次）
    prune(SID, 5000, 1000),                              // avoided += 40_000
    usage(SID),
  ], OPTS)
  assert.equal(v.avoidedBust, 40_000)
  // 净节省只来自 realized − 注入，与 avoided 无关
  assert.equal(v.net, v.realized.total - v.injectionCost)
})

test('provenance：未知会话与无 sessionId 的事件被排除', () => {
  clock = 0
  const v = computeValue([
    prune('session-synthetic-9', 50_000, 1000),   // 不在 known 集合 → 排除
    usage('session-synthetic-9'),
    prune(SID, 5000, 1000),
    usage(SID),
    { ts: ts(), kind: 'prune', charsBefore: 99999, charsAfter: 1 },   // 无 sessionId → 排除
  ], { ...OPTS, knownSessions: new Set([SID]) })
  assert.equal(v.requests, 1)
  assert.equal(v.realized.prune, 200)   // 只有 SID 的 2000×0.1
})

test('坏事件被跳过（缺 input 的 usage、非对象、未知 kind）', () => {
  clock = 0
  const v = computeValue([
    null, undefined, 42, 'x',
    { ts: ts(), kind: 'usage', sessionId: SID },          // 无 input → 跳过
    { ts: ts(), kind: 'mystery', sessionId: SID },
    prune(SID, 5000, 1000), usage(SID),
  ], OPTS)
  assert.equal(v.requests, 1)
  assert.equal(v.realized.prune, 200)
})

test('static-trim 只进估算行（不计入净节省）', () => {
  clock = 0
  const v = computeValue([
    { ts: ts(), kind: 'static-trim', mode: 'active', charsBefore: 27_466, charsAfter: 12_511 },
    usage(SID), usage(SID),
  ], OPTS)
  assert.equal(v.realized.total, 0)
  assert.equal(v.net, 0)
  assert.ok(v.estimated.staticTrimPerRequest > 0)
})

test('compaction 事件用于估计全局反事实水位', () => {
  clock = 0
  // 两个会话的 compaction 前载荷 300k / 500k → 中位 400k 作为 L
  const v = computeValue([
    usage('s1', { input: 300_000, cacheRead: 0, bust: true }), compactionEvt('s1'),
    usage('s2', { input: 500_000, cacheRead: 0, bust: true }), compactionEvt('s2'),
  ], OPTS)
  assert.equal(v.ceiling.global, 400_000)
  assert.equal(v.ceiling.source, 'compaction')
})

test('默认值常量存在且保守', () => {
  assert.equal(VALUE_DEFAULTS.cacheFactor, 0.1)
  assert.ok(VALUE_DEFAULTS.windowTokens > 0)
  assert.ok(VALUE_DEFAULTS.bustMinFreshTokens > 0)
})

test('avoided 兜底：无前置 usage 时用动作自带载荷（prune.tokensBefore）', () => {
  clock = 0
  const v = computeValue([
    prune(SID, 5000, 1000),    // tokensBefore = 2500（helper 按 charsBefore/2 记）
    usage(SID),
  ], OPTS)
  assert.equal(v.avoidedBust, 2500)
})

test('avoided 兜底：fold 用 payloadTokens 字段', () => {
  clock = 0
  const v = computeValue([
    { ts: ts(), kind: 'fold', sessionId: SID, charsBefore: 4000, charsAfter: 200, payloadTokens: 88_000 },
    usage(SID),
  ], OPTS)
  assert.equal(v.avoidedBust, 88_000)
})

test('载荷口径与成本当量口径同向同量级（内置交叉验证）', () => {
  clock = 0
  const v = computeValue([
    prune(SID, 50_000, 1000),     // S = 24_500
    usage(SID, { input: 200, cacheRead: 9_800 }),
    usage(SID, { input: 200, cacheRead: 9_800 }),
  ], OPTS)
  assert.ok(v.payload.saved > 0)
  assert.ok(v.payload.pct > 0)
  assert.equal(v.xcheck.consistent, true)
  assert.ok(v.xcheck.ratio >= 0.3 && v.xcheck.ratio <= 3)
})

test('无臂动作时交叉验证不误报（注入开销不构成矛盾）', () => {
  clock = 0
  const v = computeValue([inject(SID, 2000), usage(SID)], OPTS)
  assert.equal(v.xcheck.ratio, null)
  assert.equal(v.xcheck.consistent, true)
})
