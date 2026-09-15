/** 画像层测试：习惯画像（user talk 提炼）+ 行为画像（meter 统计）+ 预算纪律。 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadConfig } from '../config.mjs'
import * as profile from '../profile.mjs'

process.env.LCM_OPENVIKING_DISABLED = '1'

function makeCfg(extra = {}) {
  const root = mkdtempSync(join(tmpdir(), 'lcm-profile-'))
  const cfg = loadConfig(root, { meterRoot: join(root, '.lcm'), ...extra })
  mkdirSync(cfg.meterDir, { recursive: true })
  return { root, cfg }
}

test('harness 伪装消息过滤：checkpoint 模板必须被识别', () => {
  assert.ok(profile.isHarnessTalk('Review the inherited completed checkpoint now.'))
  assert.ok(profile.isHarnessTalk('前缀 Review the inherited completed checkpoint 变体'))
  assert.ok(profile.isHarnessTalk('This is an automatically generated checkpoint condensing...'))
  assert.ok(!profile.isHarnessTalk('你能理解吗？我觉得这个方案可以'))
  assert.ok(!profile.isHarnessTalk('Review the code and fix the bug'))   // 正常英文指令不算模板
})

test('意图分类：确认/验证/理解/行动/扩展', () => {
  assert.equal(profile.intentOf('这个你能理解吗'), '确认')
  assert.equal(profile.intentOf('先修复然后跑一下 benchmark'), '验证')
  assert.equal(profile.intentOf('理解一下当前的代码结构'), '理解')
  assert.equal(profile.intentOf('开始修复，直接动手'), '行动')
  assert.equal(profile.intentOf('另外还有一个想法'), '扩展')
})

test('推进链压缩：连续同类去重', () => {
  assert.equal(profile.compressChain(['理解', '理解', '行动', '行动', '验证']).join('→'), '理解→行动→验证')
  assert.equal(profile.compressChain(['扩展']).join('→'), '扩展')
})

test('句式指纹：续接重放去重（同一 talk 只归属首个对话）', () => {
  // DSH checkpoint 续接会把历史消息重放进分段会话——同一 talk 文本在两个「会话」
  // 逐字重现，必须只算一次，否则习惯计数虚高（实测同一开场白重现 22 次）
  const replayed = '你能理解吗？我觉得这个方案是对的'
  const sessions = [
    { project: 'a', talks: [replayed, '开始修复吧'] },
    { project: 'a', talks: [replayed] },   // 续接分段：重放
  ]
  const fp = profile.phraseFingerprint(sessions, { minSessions: 2 })
  assert.ok(!fp.phrases.some(([p]) => p.includes('你能理解吗')), '重放 talk 不得制造跨会话假习惯')
  // 真实的跨会话习惯：短语作为独立段（前后有标点/换行）在 ≥3 会话出现
  // 已知局限：确定性层无分词，「这个你能理解吗」连体段检不出内部短语——留给语义层
  const real = profile.phraseFingerprint([
    { project: 'a', talks: ['你能理解吗，方案一'] },
    { project: 'b', talks: ['你能理解吗？方案二'] },
    { project: 'c', talks: ['你能理解吗，方案三'] },
  ], { minSessions: 3 })
  assert.ok(real.phrases.some(([p]) => p.includes('你能理解吗')))
})

test('习惯画像：确认率/开场/推进链', () => {
  const h = profile.habitProfile([
    { project: 'a', talks: ['理解一下代码', '你能理解吗', '开始修复'] },
    { project: 'a', talks: ['分析一下数据', '你觉得呢', '跑一下测试'] },
  ])
  assert.equal(h.sessions, 2)
  assert.equal(h.talks, 6)
  assert.ok(h.confirmRate > 0 && h.confirmRate < 1)
  assert.equal(h.openers['理解'], 2)   // 「理解一下」「分析一下」都归理解意图
  assert.ok(h.topChain.length > 0)
})

test('渲染预算：硬上限 + 截断保闭合标签；空输入 → null', () => {
  assert.equal(profile.renderProfileBlock({}, {}), null)
  const tiny = profile.renderProfileBlock({}, {
    habit: { sessions: 1, talks: 1, confirmRate: 0.5, openers: { 确认: 1 }, topChain: '确认→扩展', phrases: [['你能理解吗', 9]], terms: [] },
  })
  assert.ok(tiny.startsWith('<lcm-profile>') && tiny.endsWith('</lcm-profile>'))
  assert.ok([...tiny].length <= profile.PROFILE_MAX_CHARS)
  // 超长输入也必须封顶且闭合
  const huge = profile.renderProfileBlock({}, {
    habit: { sessions: 1, talks: 1, confirmRate: 0.5, openers: { 确认: 1 }, topChain: 'x'.repeat(3000), phrases: Array.from({ length: 50 }, (_, i) => ['短语指纹' + i, 9]), terms: [] },
  })
  assert.ok([...huge].length <= profile.PROFILE_MAX_CHARS, '超长画像必须截断到预算内')
  assert.ok(huge.endsWith('</lcm-profile>'), '截断后闭合标签必须完好')
})

test('getProfile 热路径纪律：无缓存且 allowScan:false → null（绝不在线扫描）', () => {
  const { cfg } = makeCfg()
  assert.equal(profile.getProfile(cfg, { allowScan: false }), null)
})

test('getProfile 热路径：过期缓存也返回（标 stale），不重扫', () => {
  const { cfg } = makeCfg()
  const stale = { builtAt: Date.now() - 10 * 24 * 3600 * 1000, habit: { sessions: 1 }, behavior: null }
  writeFileSync(join(cfg.meterDir, 'profile.json'), JSON.stringify(stale))
  const p = profile.getProfile(cfg, { allowScan: false })
  assert.equal(p.stale, true)
  assert.equal(p.habit.sessions, 1)
})
