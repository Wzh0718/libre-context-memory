/** 金标评测测试：金标集构造不变量 + recall/击穿判定 + 放行 gate。 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadConfig } from '../config.mjs'
import * as memory from '../memory.mjs'
import * as ev from '../eval.mjs'

process.env.LCM_OPENVIKING_DISABLED = '1'

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'lcm-eval-'))
  const cfg = loadConfig(root, { meterRoot: join(root, '.lcm') })
  const sessionsRoot = join(root, 'sessions')
  mkdirSync(cfg.memoryDir, { recursive: true })
  return { root, cfg, sessionsRoot }
}

/** 造一个会话日志（plain jsonl——readSessionLog 原生支持）。 */
function writeSession(sessionsRoot, projectDir, sessionId, talks) {
  const dir = join(sessionsRoot, projectDir, sessionId)
  mkdirSync(dir, { recursive: true })
  const lines = talks.map((t) => JSON.stringify({
    type: 'user/message', seq: 1,
    data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: t }] },
  }))
  writeFileSync(join(dir, 'session.jsonl'), lines.join('\n') + '\n', 'utf8')
  return join(dir, 'session.jsonl')
}

test('金标构造不变量：查询文本与配对打分同源（截断不得作废配对）', () => {
  const { cfg, sessionsRoot } = setup()
  // 长 talk：关键 token 在 200 字符之后（旧实现存截断文本 → 配对分 0 的假对）
  const longTalk = '前置无关内容。'.repeat(40) + '决定采用 outbox 模式做 OpenViking 同步'
  memory.record(cfg, {
    type: 'decision', subject: 'outbox 模式', claim: '决定采用 outbox 模式做 OpenViking 同步，保证本地优先',
    keywords: ['outbox', 'openviking'], source: 'manual', sessionId: 's1', project: 'proj-x',
  })
  writeSession(sessionsRoot, '--proj-x--', 's1', [longTalk])
  const g = ev.buildGolden(cfg, { sessionsDir: sessionsRoot })
  const pair = g.positives.find((p) => p.kind === 'session')
  assert.ok(pair, '应产出同会话配对')
  assert.equal(pair.query, longTalk.slice(0, ev.QUERY_MAX_CHARS), '查询必须与打分文本同源')
  assert.ok(pair.overlap >= 2, `配对重叠必须达标（实际 ${pair.overlap}）`)
})

test('跨会话配对：要求来自不同会话 + 项目键归一（cwd vs 短横线目录名）', () => {
  const { cfg, sessionsRoot } = setup()
  // 条目 project 存 cwd 形（生产形态），会话目录名是短横线形
  memory.record(cfg, {
    type: 'decision', subject: '记忆库落盘', claim: '决定记忆库落盘在 ~/.lcm 作为唯一真相源，远端双写走 outbox',
    keywords: ['lcm', 'outbox'], source: 'manual', sessionId: 'sess-old', project: '/home/u/proj-x',
  })
  writeSession(sessionsRoot, '--home-u-proj-x--', 'sess-new', ['记忆库落盘在 ~/.lcm 还是远端？outbox 双写怎么处理'])
  const g = ev.buildGolden(cfg, { sessionsDir: sessionsRoot })
  const cross = g.positives.filter((p) => p.kind === 'cross')
  assert.equal(cross.length, 1, '跨会话配对必须产出（项目键 cwd 与目录名归一后相等）')
  assert.equal(cross[0].fromSession, 'sess-new')
  assert.notEqual(cross[0].sessionId, 'sess-new', '跨会话必须来自别的会话')
})

test('runEval：recall 计算 + 主指标优先级 + 放行 gate', () => {
  const { cfg, sessionsRoot } = setup()
  const a = memory.record(cfg, {
    type: 'decision', subject: '折叠臂', claim: '决定折叠臂只折已蒸馏轮次，指针行替代原文',
    keywords: ['折叠', '蒸馏'], source: 'manual', sessionId: 'sess-a', project: 'p',
  })
  writeSession(sessionsRoot, '--p--', 'sess-a', ['折叠臂只折已蒸馏轮次的观点你怎么看'])
  const g = ev.buildGolden(cfg, { sessionsDir: sessionsRoot })
  const r = ev.runEval(cfg, g)
  assert.equal(r.total, g.positives.length)
  assert.ok(r.hits >= 1, '自身话题的查询必须命中')
  // 样本不足 → 回退总体口径
  assert.equal(r.primary.metric, 'overall')
  assert.ok(r.recall >= ev.RECALL_TARGET)
  assert.equal(r.penetration, 0)
  assert.equal(r.ok, true, '达标应放行')
})

test('死条目反例：被取代条目绝不可浮出（击穿即不放行）', () => {
  const { cfg, sessionsRoot } = setup()
  const first = memory.record(cfg, {
    type: 'preference', subject: '注入模式', claim: '注入模式偏好：使用 active 模式直接注入，不做 shadow 观察',
    keywords: ['注入', 'active'], source: 'manual', sessionId: 'sess-x', project: 'p',
  })
  assert.ok(first.id)
  // 同 subject 不同 claim → UPDATE（旧条目被取代，成为死条目）
  memory.record(cfg, {
    type: 'preference', subject: '注入模式', claim: '注入模式偏好：改用 shadow 模式先观察再切换，不直接 active',
    keywords: ['注入', 'shadow'], source: 'manual', sessionId: 'sess-x', project: 'p',
  })
  const g = ev.buildGolden(cfg, { sessionsDir: sessionsRoot })
  const deadNeg = g.negatives.filter((n) => n.kind === 'dead')
  assert.ok(deadNeg.length >= 1, '被取代条目必须进反例集')
  const r = ev.runEval(cfg, g)
  assert.equal(r.penetration, 0, '死条目不得浮出')
})

test('噪声反例：无意义查询必须零返回（返回即击穿）', () => {
  const { cfg, sessionsRoot } = setup()
  memory.record(cfg, {
    type: 'fact', subject: '计量根', claim: '计量统一落全局根 ~/.lcm，事件带 project 字段', source: 'manual', project: 'p',
  })
  writeSession(sessionsRoot, '--p--', 's1', ['计量根在哪里'])
  const g = ev.buildGolden(cfg, { sessionsDir: sessionsRoot })
  assert.ok(g.negatives.some((n) => n.kind === 'gibberish' && n.expectEmpty))
  const r = ev.runEval(cfg, g)
  assert.equal(r.penetration, 0)
  const report = ev.renderEvalReport(r, g)
  assert.match(report, /反例击穿：0/)
  assert.match(report, /主指标/)
})

test('放行 gate：跨会话样本充足时以跨会话为准；不达标必须拒绝放行', () => {
  const { cfg } = setup()
  memory.record(cfg, {
    type: 'fact', subject: '计量根', claim: '计量统一落全局根 ~/.lcm，事件带 project 字段',
    keywords: ['lcm', '计量'], source: 'manual', project: 'p',
  })
  // 直接构造 golden：12 条跨会话正例，期望的 id 都不存在 → recall 0 → 不放行
  const golden = {
    builtAt: Date.now(), version: 1,
    stats: { entries: 1, live: 1, dead: 0, positiveSession: 0, positiveCross: 12, positiveSelf: 0, negativeDead: 0, negativeGibberish: 0 },
    positives: Array.from({ length: 12 }, (_, i) => ({
      query: `不存在的主题 ${i}`, expectId: `deadbeef${i}`, kind: 'cross', overlap: 9,
      sessionId: 's-old', fromSession: `s-new-${i}`, project: 'p',
    })),
    negatives: [],
  }
  const r = ev.runEval(cfg, golden)
  assert.equal(r.primary.metric, 'cross-session', '跨会话样本充足时必须用它当主指标')
  assert.equal(r.primary.recall, 0)
  assert.equal(r.ok, false, '未达标不得放行')
  const report = ev.renderEvalReport(r, golden)
  assert.match(report, /主指标（跨会话）/)
  assert.match(report, /未达标/)
  // 击穿不为 0 时同样不放行
  const golden2 = { ...golden, negatives: [{ query: '噪音查询', forbidId: null, expectEmpty: false, kind: 'gibberish', note: 'noise' }], positives: [{ query: '计量根 lcm', expectId: memory.activeEntries(cfg)[0].id, kind: 'cross', overlap: 9, sessionId: 's', fromSession: 't', project: 'p' }] }
  const r2 = ev.runEval(cfg, golden2)
  assert.equal(r2.penetration, 0, '无 expectEmpty/forbidId 的反例不构成击穿')
})

test('污染率：池化口径出现外项目槽位，生产口径（同项目）为 0', () => {
  const { cfg } = setup()
  memory.record(cfg, { type: 'fact', subject: 'quant 策略', claim: 'libre_quant 回测用 walk-forward 验证', project: '/p/quant' })
  memory.record(cfg, { type: 'fact', subject: 'html 转换', claim: 'html_to_md 正文抽取用 cheerio 回测验证', project: '/p/html' })
  const quantId = memory.activeEntries(cfg).find((e) => e.subject === 'quant 策略').id
  const golden = {
    positives: [{ query: '回测 验证', expectId: quantId, project: '/p/quant', kind: 'cross' }],
    negatives: [],
  }
  const pooled = ev.runEval(cfg, golden, { projectScope: 'all' })
  const scoped = ev.runEval(cfg, golden, { projectScope: 'same' })
  assert.ok(pooled.contamination > 0, '池化口径下必须观测到外项目槽位')
  assert.equal(scoped.contamination, 0, '生产口径下外项目槽位必须为 0')
  assert.equal(scoped.excludedByScope > 0, true, '必须报告被隔离的候选数（可观测）')
  // 同项目条目在两种口径下都必须召回
  assert.equal(pooled.recall, 1)
  assert.equal(scoped.recall, 1)
})
