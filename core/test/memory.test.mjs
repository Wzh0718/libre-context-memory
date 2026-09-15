/** 记忆引擎测试：写入决策 / 禁写过滤 / 检索注入 / 确定性提取 / outbox + viking 同步。
 * 运行：node --test core/test/*.test.mjs
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 测试密封：绝不读真实 ~/.openviking / ~/.config（ovcli 兜底会发真实网络请求）
process.env.LCM_OPENVIKING_DISABLED = '1'

import { loadConfig } from '../config.mjs'
import * as memory from '../memory.mjs'

function makeCfg(over = {}) {
  const root = mkdtempSync(join(tmpdir(), 'lcm-mem-'))
  // meter/memory 根固定在临时目录：测试绝不读写真实 ~/.lcm
  return { ...loadConfig(root, { meterRoot: join(root, '.lcm') }), ...over }
}

const SUMMARY_MD = `## Primary Request and Intent
- Original goal: 通过 dsh 采集 session 数据，研究 memory + token 压缩。
- 下一步：验证 fork 继承转写的折叠收益。

## Key Technical Concepts
- compaction contract: summary message inside compaction/start-end bracket, replayable from session log（实测 命中率 93.9%）
- 源码位置 \`/home/libre/project/deepseek-harness/packages/core\`

## Notes
- 决定：静态层裁剪切 active，300 字符上限
- api_key = "sk-abcdef1234567890abcdef" 不要记录这个
- 2026-09-15 10:30:00`

test('写入决策：ADD → 等价 NOOP → 更新 UPDATE（旧条目保留历史）', () => {
  const cfg = makeCfg()
  const a = memory.record(cfg, { type: 'fact', subject: 'meter 根', claim: '计量数据统一落全局 ~/.lcm 根，事件带 project 字段' })
  assert.equal(a.action, 'ADD')

  // 完全相同 → 幂等 NOOP
  const b = memory.record(cfg, { type: 'fact', subject: 'meter 根', claim: '计量数据统一落全局 ~/.lcm 根，事件带 project 字段' })
  assert.equal(b.action, 'NOOP')
  assert.equal(memory.activeEntries(cfg).length, 1)

  // 同 subject、相似但不同 → UPDATE：新条目有效，旧条目被取代但仍在文件里
  const c = memory.record(cfg, { type: 'fact', subject: 'meter 根', claim: '计量数据统一落全局 ~/.lcm/memories 根，事件带 project 标签' })
  assert.equal(c.action, 'UPDATE')
  const live = memory.activeEntries(cfg)
  assert.equal(live.length, 1)
  assert.equal(live[0].id, c.id)
  assert.ok(memory.loadAll(cfg).length === 2, '旧条目保留在历史（append-only，不丢）')
})

test('写入决策：同 subject 但语义无关 → 独立 ADD 不误合并', () => {
  const cfg = makeCfg()
  memory.record(cfg, { type: 'fact', subject: 'meter 根', claim: '计量数据统一落全局 ~/.lcm 根，事件带 project 字段' })
  const b = memory.record(cfg, { type: 'fact', subject: 'meter 根', claim: '报告命令支持 --project 按项目过滤输出' })
  assert.equal(b.action, 'ADD')
  assert.equal(memory.activeEntries(cfg).length, 2)
})

test('禁写过滤：secrets / 过短 / 纯时间戳全部拒之门外', () => {
  const cfg = makeCfg()
  const r1 = memory.record(cfg, { type: 'fact', subject: 'x', claim: 'api_key = "sk-abcdef1234567890abcdef"' })
  assert.equal(r1.action, 'REJECT')
  assert.equal(r1.reason, 'secret-like')
  assert.equal(memory.record(cfg, { type: 'fact', subject: 'x', claim: '太短' }).reason, 'too-short')
  assert.equal(memory.record(cfg, { type: 'fact', subject: 'x', claim: '2026-09-15 10:30:00' }).reason, 'transient')
  assert.equal(memory.loadAll(cfg).length, 0, '禁写内容一条都不落库')
})

test('refute：证伪旧条目 → DELETE 语义，旧条目进历史', () => {
  const cfg = makeCfg()
  const a = memory.record(cfg, { type: 'conclusion', subject: '剪枝收益', claim: '主动剪枝净收益为正 3.2%' })
  const r = memory.refute(cfg, { subject: '剪枝收益', claim: '主动剪枝实测净负 3.2%，击穿成本大于节省' })
  assert.equal(r.action, 'DELETE')
  const live = memory.activeEntries(cfg)
  assert.equal(live.length, 1)
  assert.equal(live[0].type, 'anti_pattern')
  assert.ok(memory.loadAll(cfg).some((e) => e.id === a.id && e.superseded_by === r.by))
})

test('检索：subject/claim/keywords 分层打分 + 预算有界', () => {
  const cfg = makeCfg()
  memory.record(cfg, { type: 'fact', subject: 'lcm meter root', claim: '计量根是 ~/.lcm，全局聚合', keywords: ['meter', 'root'] })
  memory.record(cfg, { type: 'decision', subject: 'static trim', claim: '静态层裁剪 300 字符切 active', keywords: ['trim'] })
  memory.record(cfg, { type: 'open_thread', subject: 'phase3', claim: '对话轮折叠尚未实现', keywords: [] })

  const hits = memory.search(cfg, 'meter root 计量根')
  assert.ok(hits.length >= 1)
  assert.equal(hits[0].subject, 'lcm meter root', 'subject 命中应排最前')
  assert.ok(!memory.search(cfg, '完全无关的查询词').length, '无命中返回空')

  const bounded = memory.search(cfg, 'lcm meter root 计量 static trim phase3 折叠', { k: 10, maxChars: 60 })
  assert.ok(bounded.length < 3, '预算约束必须生效（60 字符装不下全部）')
})

test('注入块：确定性渲染（同输入逐字节相同）+ 空结果返回 null', () => {
  const cfg = makeCfg()
  memory.record(cfg, { type: 'fact', subject: 's1', claim: '用于注入块渲染测试的条目内容' })
  const e1 = memory.search(cfg, 's1')
  const a = memory.renderInjectBlock('s1', e1)
  const b = memory.renderInjectBlock('s1', memory.search(cfg, 's1'))
  assert.equal(a, b)
  assert.ok(a.startsWith('<lcm-memory query="s1">'))
  assert.ok(a.includes('[fact] s1：用于注入块渲染测试的条目内容'))
  assert.ok(a.endsWith('</lcm-memory>'))
  assert.equal(memory.renderInjectBlock('q', []), null)
})

test('确定性提取：compaction/summary 分节 markdown → 类型化候选（含禁写拦截）', () => {
  const cands = memory.extractCandidates(SUMMARY_MD)
  const types = cands.map((c) => c.type)
  assert.ok(types.includes('open_thread'), '「下一步」应识别为 open_thread')
  assert.ok(types.includes('fact'), '路径/URL 行应识别为 fact')
  assert.ok(types.includes('decision') || types.includes('conclusion'), '决定/实测行应有产出')
  // secrets 行必须被提取器拦截
  assert.ok(!cands.some((c) => /sk-abcdef/.test(c.claim)), '禁写行不得成为候选')
  assert.ok(!cands.some((c) => /^\d{4}-\d{2}-\d{2}/.test(c.claim)), '纯时间戳行不得成为候选')
  // 幂等：同文本再提取结果一致
  assert.deepEqual(cands, memory.extractCandidates(SUMMARY_MD))
})

test('OpenViking 未配置：不产生 outbox，入库即终点', () => {
  const cfg = makeCfg()
  assert.equal(cfg.openvikingConfigured, false)
  memory.record(cfg, { type: 'fact', subject: 's', claim: '本地优先的记忆条目内容' })
  assert.ok(existsSync(join(cfg.memoryDir, 'memories.jsonl')))
  assert.equal(memory.outboxPending(cfg).length, 0)
})

test('OpenViking 同步：不可达落 outbox → mock 服务恢复后 flush 清空', async () => {
  const cfg = makeCfg({ openvikingConfigured: true, openvikingUrl: 'http://127.0.0.1:1', openvikingApiKey: 'test-key' })
  const r = memory.record(cfg, { type: 'decision', subject: 'sync', claim: '配置 OpenViking 后记忆双写同步' })
  assert.equal(r.action, 'ADD')
  assert.equal(memory.outboxPending(cfg).length, 1, '不可达时应入 outbox')

  // 起 mock 服务并指向它
  const received = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      received.push({ url: req.url, key: req.headers['x-api-key'], ua: req.headers['user-agent'], body: JSON.parse(body) })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok', result: { uri: JSON.parse(body).uri } }))
    })
  })
  server.on('connection', (sock) => sock.setNoDelay(true))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const fixed = { ...cfg, openvikingUrl: `http://127.0.0.1:${port}` }

  const flush = await memory.flushOutbox(fixed)
  assert.equal(flush.sent, 1)
  assert.equal(flush.remaining, 0)
  assert.equal(memory.outboxPending(fixed).length, 0, '成功后 outbox 清空')
  assert.equal(received.length, 1)
  assert.equal(received[0].url, '/api/v1/content/write')
  assert.equal(received[0].key, 'test-key')
  assert.match(received[0].ua, /^dsh-lcm\//, '自定义 UA 必须携带（CF 拦截 node 默认 UA）')
  assert.equal(received[0].body.mode, 'replace')
  assert.match(received[0].body.uri, /viking:\/\/user\/libre\/memories\/lcm\/decision\/[0-9a-f]{16}\.md$/)
  assert.ok(received[0].body.content.includes('# [decision] sync'))
  server.closeAllConnections()
  server.close()
})

test('OpenViking 同步：单条失败留在 outbox（不拖累其他条目）', async () => {
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      const parsed = JSON.parse(body)
      if (parsed.uri.includes('willfail')) { res.writeHead(500); res.end('{}'); return }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok' }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const cfg = makeCfg({ openvikingConfigured: true, openvikingUrl: `http://127.0.0.1:${port}`, openvikingApiKey: 'k' })
  // 直接构造 outbox 模拟两条待发（一条注定失败）
  mkdirSync(cfg.memoryDir, { recursive: true })
  writeFileSync(join(cfg.memoryDir, 'outbox.jsonl'), [
    JSON.stringify({ id: 'ok1', uri: `viking://user/libre/memories/lcm/fact/ok1.md`, content: 'ok' }),
    JSON.stringify({ id: 'bad1', uri: `viking://user/libre/memories/lcm/fact/willfail.md`, content: 'bad' }),
  ].join('\n') + '\n', 'utf8')
  const flush = await memory.flushOutbox(cfg)
  assert.equal(flush.sent, 1)
  assert.equal(flush.remaining, 1)
  assert.equal(memory.outboxPending(cfg)[0].id, 'bad1')
  server.closeAllConnections()
  server.close()
})

test('端到端：summary 提取 → 逐条入库（四选一去重）→ 可检索', () => {
  const cfg = makeCfg()
  let added = 0
  for (let round = 0; round < 2; round++) {   // 模拟同一 summary 被处理两次（hook 重试）
    for (const cand of memory.extractCandidates(SUMMARY_MD)) {
      const r = memory.record(cfg, cand)
      if (round === 0 && r.action === 'ADD') added++
      if (round === 1) assert.equal(r.action, 'NOOP', '重放必须全部幂等')
    }
  }
  assert.ok(added >= 3, `第一轮应有产出（实际 ${added}）`)
  assert.equal(memory.activeEntries(cfg).length, added)
  assert.ok(memory.search(cfg, 'compaction summary 折叠').length > 0)
})

// ---------------------------------------------------------------- 提取质量（benchmark 驱动修复）

test('提取质量：表格行不提取、引用前缀清理、无锚 subject 不冒充', () => {
  const cfg = makeCfg()
  // 表格行（benchmark 实测 25.5% 噪声源）：脱离表头没有独立语义
  const cands = memory.extractCandidates(`
| **重复付费**：缓存击穿 | 4,039 次「零新内容全价」= 455M fresh |
| **体积失控**：0.3% 工具输出占 55.5% | 84 次大输出 |
- 实测：Codex 每请求新增内容中位数只有 679 est tokens（98.6% 请求与上轮逐字节同前缀）
> 结论：压缩必须入库即做，不能等窗口
`)
  assert.equal(cands.filter((c) => c.claim.startsWith('|')).length, 0, '表格行必须整行跳过')
  const quoted = cands.find((c) => c.claim.startsWith('结论'))
  assert.ok(quoted, '引用块内容要提取：' + JSON.stringify(cands.map((c) => c.claim.slice(0, 20))))
  // 无锚点（无路径/反引号/URL）→ subject 为空，不得截断 claim 冒充
  const noAnchor = memory.extractCandidates('- 实测：这个结论没有任何路径锚点 87% 但有百分比')[0]
  assert.equal(noAnchor.subject, '', '无锚 subject 必须为空（benchmark 冗余 53.4% 的根因）')
  // 有锚（反引号）→ subject 是锚
  const anchored = memory.extractCandidates('- 决定：改用 `core/memory.mjs` 做提取入口')[0]
  assert.equal(anchored.subject, 'core/memory.mjs')
})

test('质量门槛：低分候选挡在库门外，门槛按来源分层', () => {
  const cfg = makeCfg()
  // 无任何信号锚的纯散文碎片：density 0.5 × 类型权重 → 低分
  const weak = { type: 'open_thread', subject: '', claim: '接下来要做的事情还有很多需要慢慢验证', score: 0.3, source: 'incremental' }
  const r = memory.record(cfg, weak)
  assert.equal(r.action, 'REJECT')
  assert.match(r.reason, /low-quality/)
  assert.ok(r.score < r.gate, '拒绝原因必须带分数')
  // 同样内容来自 LLM 蒸馏的 summary（门槛 0.45）+ 过线分数 → 入库
  const ok = memory.record(cfg, { ...weak, score: 0.5, source: 'compaction/summary' })
  assert.equal(ok.action, 'ADD')
  // 手动写入不设限（不同 claim 避开上面的幂等键）
  const manual = memory.record(cfg, { ...weak, claim: '另一个低分内容但用户手动指定入库的条目', source: 'manual' })
  assert.equal(manual.action, 'ADD')
  // 分数持久化在条目上（画像晋升的依据）
  assert.equal(manual.entry.score, 0.3)
  // 同 claim 重复写入 → 幂等 NOOP（不管来源）
  assert.equal(memory.record(cfg, { ...weak, score: 0.5, source: 'compaction/summary' }).action, 'NOOP')
})

test('质量分：类型权重 × 信号密度，序关系稳定', () => {
  const claim = '实测 `core/mjs` 路径 v1.2 与 95% 百分比锚'
  const d = memory.qualityScore({ type: 'decision', claim })
  const o = memory.qualityScore({ type: 'open_thread', claim })
  assert.ok(d > o, '同密度下 decision > open_thread')
  const rich = memory.qualityScore({ type: 'fact', claim })
  const plain = memory.qualityScore({ type: 'fact', claim: '这是一个没有任何具体锚点的普通描述句子' })
  assert.ok(rich > plain, '有信号锚 > 纯散文')
  assert.ok(plain <= 0.5, '纯散文分数压在门槛下')
})

test('显示去重：claim 已含 subject 信息时不重复拼接', () => {
  const cfg = makeCfg()
  memory.record(cfg, { type: 'fact', subject: '', claim: '实测显示去重：没有锚点的条目直接显示 claim 全文', source: 'manual' })
  const [e] = memory.activeEntries(cfg)
  const block = memory.renderInjectBlock('显示 去重', [e])
  assert.ok(block.includes(e.claim))
  assert.ok(!block.includes(`${e.subject}：${e.claim}`), 'subject 为空不得拼出「：」前缀')
})

test('两层读分：默认模式（rel-quality-mild）性质与确定性', async () => {
  const mem = await import('../memory.mjs')
  const q = mem.tokensOf('记忆库 落盘 决定')
  // 相关度为零 → 0（不参与排序）
  assert.equal(mem.readScore({ subject: '完全无关', claim: '别的主题', ts: Date.now() }, q), 0)
  // 质量高者 > 质量低者（同相关度）；且倍数有界 [0.7, 1.0]——不会让质量淹没相关度
  const low = mem.readScore({ subject: '记忆库', claim: '落盘', score: 0.3, ts: 0 }, q)
  const high = mem.readScore({ subject: '记忆库', claim: '落盘', score: 1.0, ts: 0 }, q)
  assert.ok(high > low)
  assert.ok(high / low <= 1 / 0.79 + 1e-9, 'quality 调制倍数必须有界')
  // 同输入同输出（注入块逐字节稳定的前提）
  const e = { subject: '记忆库', claim: '落盘 决定', score: 0.8, ts: 1700000000000 }
  assert.equal(mem.readScore(e, q, { now: 1700000000000 }), mem.readScore(e, q, { now: 1700000000000 }))
  // 默认模式就是评测选出的那个（防回退到直觉选择）
  assert.equal(mem.DEFAULT_SCORE_MODE, 'rel-quality-mild')
  // 画像加成作为独立因子（A3）：boost>1 提升，1 不变
  const base = mem.readScore(e, q, { now: 1700000000000 })
  assert.ok(mem.readScore(e, q, { now: 1700000000000, qualityBoost: 1.2 }) > base)
})

test('search：模式可选 + 结果确定性（同查询两次逐条相同）', async () => {
  const mem = await import('../memory.mjs')
  const { cfg, root } = (() => {
    const r = mkdtempSync(join(tmpdir(), 'lcm-score-'))
    const c = loadConfig(r, { meterRoot: join(r, '.lcm') })
    mkdirSync(c.memoryDir, { recursive: true })
    return { cfg: c, root: r }
  })()
  mem.record(cfg, { type: 'decision', subject: '读分模式', claim: '读分默认用 rel-quality-mild，由评测 A/B 选出', score: 0.9, source: 'manual' })
  mem.record(cfg, { type: 'fact', subject: '读分模式', claim: '读分模式候选包括 two-layer 与 lexicographic', score: 0.4, source: 'manual' })
  const a = mem.search(cfg, '读分模式 选择', { k: 5 })
  const b = mem.search(cfg, '读分模式 选择', { k: 5 })
  assert.deepEqual(a.map((e) => e.id), b.map((e) => e.id), '同查询必须确定')
  assert.ok(a.length >= 2)
  assert.ok(a[0].score >= 0.9, '质量高的条目应排前（同 subject 相关度下）')
  // 指定模式仍然可用（A/B 与回归用）
  const legacy = mem.search(cfg, '读分模式 选择', { k: 5, mode: 'legacy' })
  assert.equal(legacy.length, a.length)
})

test('A2 会话画像混合：占比上限/冷启动/确定性语义', async () => {
  const mem = await import('../memory.mjs')
  const r = mkdtempSync(join(tmpdir(), 'lcm-blend-'))
  const cfg = loadConfig(r, { meterRoot: join(r, '.lcm') })
  mkdirSync(cfg.memoryDir, { recursive: true })
  assert.equal(mem.profileShareOf(0), 0, '无条目 → 零占比（冷启动只用用户消息）')
  assert.equal(mem.profileShareOf(1), 0.2)
  assert.equal(mem.profileShareOf(100), 0.7, '占比上限 70%（用户拍板）')
  assert.equal(mem.blendQuery('继续', ''), '继续', '无画像 → 纯用户消息')
  assert.equal(mem.blendQuery('继续', '画' * 999, { share: 0 }), '继续', '占比 0 → 纯用户消息')
  // 占比决定画像字符质量：share=0.5 时画像 ≈ 用户消息长度
  const blended = mem.blendQuery('用户消息内容', '画像内容啊啊啊', { share: 0.5 })
  assert.ok(blended.startsWith('用户消息内容'))
  assert.ok(blended.length > '用户消息内容'.length)
  // 会话画像：只取本会话条目、最近优先、有界
  mem.record(cfg, { type: 'fact', subject: '会话甲主题', claim: '甲会话里定下来的完整结论内容足够长', source: 'manual', sessionId: 's1' })
  mem.record(cfg, { type: 'fact', subject: '会话乙主题', claim: '乙会话里定下来的完整结论内容足够长', source: 'manual', sessionId: 's2' })
  const prof = mem.sessionProfileOf(cfg, 's1')
  assert.ok(prof.includes('会话甲主题'))
  assert.ok(!prof.includes('会话乙主题'), '画像只含本会话条目')
  assert.equal(mem.sessionProfileOf(cfg, 's-unknown'), '')
})

test('B4 重现证据：同一条目再次提出 → seenCount/seenSessions 记录', async () => {
  const mem = await import('../memory.mjs')
  const r = mkdtempSync(join(tmpdir(), 'lcm-seen-'))
  const cfg = loadConfig(r, { meterRoot: join(r, '.lcm') })
  mkdirSync(cfg.memoryDir, { recursive: true })
  const cand = {
    type: 'decision', subject: '落盘策略', claim: '决定记忆库以 ~/.lcm 为唯一真相源，远端只做异步双写备份',
    source: 'manual',
  }
  const a = mem.record(cfg, { ...cand, sessionId: 's1' })
  assert.equal(a.action, 'ADD')
  const b = mem.record(cfg, { ...cand, sessionId: 's2' })
  assert.equal(b.action, 'NOOP')
  assert.equal(b.seen, 2, '重现次数必须被记录')
  const e = mem.loadAll(cfg).find((x) => x.id === a.id)
  assert.deepEqual(e.seenSessions.sort(), ['s1', 's2'], '跨会话来源必须去重记录')
})

test('B4 自动晋升/降级：跨会话复现 + 质量达标；pin 条目免疫自动降级', async () => {
  const mem = await import('../memory.mjs')
  const r = mkdtempSync(join(tmpdir(), 'lcm-promo-'))
  const cfg = loadConfig(r, { meterRoot: join(r, '.lcm') })
  mkdirSync(cfg.memoryDir, { recursive: true })
  // 达标：preference 类型 + 2 个会话 + 高分
  const good = mem.record(cfg, {
    type: 'preference', subject: '输出偏好', claim: '用户偏好：结论先行，附带可复核的数据与命令，不用空话',
    score: 0.9, source: 'manual', sessionId: 's1',
  })
  mem.record(cfg, {
    type: 'preference', subject: '输出偏好', claim: '用户偏好：结论先行，附带可复核的数据与命令，不用空话',
    score: 0.9, source: 'manual', sessionId: 's2',
  })
  // 不达标：只在一个会话出现
  const solo = mem.record(cfg, {
    type: 'preference', subject: '临时偏好', claim: '用户在这一次会话里提到想要更长的解释，但没有复现',
    score: 0.9, source: 'manual', sessionId: 's3',
  })
  // 不达标：质量分低
  const lowQ = mem.record(cfg, {
    type: 'decision', subject: '低分决策', claim: '某个跨会话复现但质量分偏低的决策内容，用于验证门控',
    score: 0.5, source: 'manual', sessionId: 's4',
  })
  mem.record(cfg, {
    type: 'decision', subject: '低分决策', claim: '某个跨会话复现但质量分偏低的决策内容，用于验证门控',
    score: 0.5, source: 'manual', sessionId: 's5',
  })
  const res = mem.autoProfile(cfg)
  assert.ok(res.promoted >= 1)
  const profIds = mem.profileEntries(cfg).map((e) => e.id)
  assert.ok(profIds.includes(good.id), '跨会话+高质量必须晋升')
  assert.ok(!profIds.includes(solo.id), '单会话不得晋升')
  assert.ok(!profIds.includes(lowQ.id), '质量不达标不得晋升')

  // 再来一个自动晋升且不 pin 的条目，用于对照降级
  const other = mem.record(cfg, {
    type: 'preference', subject: '另一个偏好', claim: '用户偏好：批量改动要一次性给出可核对的清单而不是零散说明',
    score: 0.9, source: 'manual', sessionId: 's6',
  })
  mem.record(cfg, {
    type: 'preference', subject: '另一个偏好', claim: '用户偏好：批量改动要一次性给出可核对的清单而不是零散说明',
    score: 0.9, source: 'manual', sessionId: 's7',
  })
  mem.autoProfile(cfg)
  assert.ok(mem.profileEntries(cfg).some((e) => e.id === other.id), '对照条目应先被自动晋升')

  // 30 天未再出现 → 自动晋升条目降级；pin 条目免疫
  mem.setProfile(cfg, good.id, true)   // good 转为手动 pin
  const later = Date.now() + 31 * 86_400_000
  const res2 = mem.autoProfile(cfg, { now: later })
  assert.ok(res2.demoted >= 1, '久未出现的自动画像条目应被降级')
  const profIds2 = mem.profileEntries(cfg).map((e) => e.id)
  assert.ok(profIds2.includes(good.id), 'pin 的条目不得被自动降级')
  assert.ok(!profIds2.includes(other.id), '自动晋升且久未出现 → 应被降级')
})

test('B4 画像预算：条目数与字符数双封顶，pin 优先保留', async () => {
  const mem = await import('../memory.mjs')
  const r = mkdtempSync(join(tmpdir(), 'lcm-budget-'))
  const cfg = loadConfig(r, { meterRoot: join(r, '.lcm') })
  mkdirSync(cfg.memoryDir, { recursive: true })
  const ids = []
  for (let i = 0; i < 30; i++) {
    const rec = mem.record(cfg, {
      type: 'preference', subject: `偏好主题${i}`,
      claim: `用户偏好第 ${i} 条：内容足够长以便占用预算，验证双封顶行为是否生效`,
      score: 0.9, source: 'manual', sessionId: 's1',
    })
    ids.push(rec.id)
    mem.setProfile(cfg, rec.id, true)
  }
  const auto = mem.autoProfile(cfg)
  const prof = mem.profileEntries(cfg)
  assert.ok(prof.length <= mem.PROFILE_MAX_ENTRIES, `条目数必须 ≤${mem.PROFILE_MAX_ENTRIES}（实际 ${prof.length}）`)
  const chars = prof.reduce((n, e) => n + e.subject.length + e.claim.length + 4, 0)
  assert.ok(chars <= mem.PROFILE_MAX_CHARS, `字符数必须 ≤${mem.PROFILE_MAX_CHARS}（实际 ${chars}）`)
  assert.ok(auto.trimmed > 0 || auto.kept > 0)
})

test('A3 读时加成：画像条目 ×1.2 提升排序，未晋升条目不受影响', async () => {
  const mem = await import('../memory.mjs')
  const r = mkdtempSync(join(tmpdir(), 'lcm-boost-'))
  const cfg = loadConfig(r, { meterRoot: join(r, '.lcm') })
  mkdirSync(cfg.memoryDir, { recursive: true })
  const a = mem.record(cfg, { type: 'fact', subject: '读分加成', claim: '画像条目的读分加成是 1.2 倍系数，用于提升排序', score: 0.7, source: 'manual' })
  mem.record(cfg, { type: 'fact', subject: '读分加成', claim: '第二个同样相关的条目用于对比加成效果是否生效', score: 0.7, source: 'manual' })
  const before = mem.search(cfg, '读分加成', { k: 5 }).map((e) => e.id)
  assert.equal(before[0], a.id)
  mem.setProfile(cfg, a.id, true)
  const boost = mem.profileBoostOf(cfg)
  assert.ok(typeof boost === 'function')
  assert.equal(boost({ id: a.id }), mem.PROFILE_READ_BOOST)
  assert.equal(boost({ id: 'other' }), 1)
  const after = mem.search(cfg, '读分加成', { k: 5, qualityBoostOf: boost }).map((e) => e.id)
  assert.equal(after[0], a.id, '晋升后仍应保持首位（加成不得反向）')
  // 无常驻画像时返回 null（避免无谓的每查询 Set 构建）
  const empty = mkdtempSync(join(tmpdir(), 'lcm-boost0-'))
  const cfg2 = loadConfig(empty, { meterRoot: join(empty, '.lcm') })
  mkdirSync(cfg2.memoryDir, { recursive: true })
  assert.equal(mem.profileBoostOf(cfg2), null)
})

test('A3 画像常驻注入段：预算内渲染 + 查询相关优先 + 确定性', async () => {
  const mem = await import('../memory.mjs')
  const r = mkdtempSync(join(tmpdir(), 'lcm-plines-'))
  const cfg = loadConfig(r, { meterRoot: join(r, '.lcm') })
  mkdirSync(cfg.memoryDir, { recursive: true })
  assert.deepEqual(mem.profileInjectLines(cfg, '任意查询'), [], '无画像条目 → 空段（不注入）')
  const p1 = mem.record(cfg, { type: 'preference', subject: '提交习惯', claim: '用户偏好：改动先跑全量测试再提交，提交信息用中文正文', score: 0.9, source: 'manual' })
  const p2 = mem.record(cfg, { type: 'preference', subject: '输出习惯', claim: '用户偏好：回答用表格与数据说话，避免空泛描述', score: 0.9, source: 'manual' })
  mem.setProfile(cfg, p1.id, true)
  mem.setProfile(cfg, p2.id, true)
  const lines = mem.profileInjectLines(cfg, '这次提交要注意什么')
  assert.equal(lines.length, 2)
  assert.ok(lines[0].includes('提交习惯'), '与查询相关的画像条目排前')
  const again = mem.profileInjectLines(cfg, '这次提交要注意什么')
  assert.deepEqual(lines, again, '同输入必须同输出（注入块逐字节稳定）')
  const capped = mem.profileInjectLines(cfg, '提交', { maxChars: 40 })
  assert.ok(capped.length < 2, '字符预算必须生效')
})

test('B5 容量上限：超限归档最弱者（保留画像/pin）、幂等、未超限零改动', async () => {
  const mem = await import('../memory.mjs')
  const r = mkdtempSync(join(tmpdir(), 'lcm-cap-'))
  const cfg = loadConfig(r, { meterRoot: join(r, '.lcm') })
  mkdirSync(cfg.memoryDir, { recursive: true })
  const now = Date.now()
  // 20 条条目：一条 pin 的画像 + 一条 session TTL + 其余普通
  const ids = []
  for (let i = 0; i < 18; i++) {
    const rec = mem.record(cfg, {
      type: 'fact', subject: `容量主题${i}`, claim: `容量测试条目 ${i}：内容足够长以通过禁写过滤的长度限制`,
      score: i < 3 ? 0.4 : 0.9, source: 'manual', sessionId: 's1',
    }, { now: now - (30 - i) * 86_400_000 })   // 越靠前越旧
    ids.push(rec.id)
  }
  const pinned = mem.record(cfg, {
    type: 'preference', subject: '容量 pin 条目', claim: '这条被手动 pin，容量治理时绝不能被归档',
    score: 0.9, source: 'manual', sessionId: 's1',
  }, { now })
  mem.setProfile(cfg, pinned.id, true)
  const sess = mem.record(cfg, {
    type: 'fact', subject: '容量会话条目', claim: '这条是 session TTL，容量治理时应优先归档',
    ttl: 'session', score: 0.9, source: 'manual', sessionId: 's1',
  }, { now })

  // 未超限：零改动（幂等）
  const r0 = mem.enforceCapacity(cfg, { now, maxEntries: 100 })
  assert.equal(r0.archived, 0)
  assert.equal(r0.over, false)

  // 超限：归档到低水位
  const r1 = mem.enforceCapacity(cfg, { now, maxEntries: 10 })
  assert.ok(r1.over && r1.archived > 0, '超限必须归档')
  const live = mem.activeEntries(cfg)
  assert.ok(live.length <= 10, `活跃数必须降到上限内（实际 ${live.length}）`)
  const liveIds = live.map((e) => e.id)
  assert.ok(liveIds.includes(pinned.id), 'pin 的画像条目不得被归档')
  assert.ok(!liveIds.includes(sess.id), 'session TTL 条目应优先归档')
  // 归档而非删除：记录仍在（可审计）
  const all = mem.loadAll(cfg)
  assert.ok(all.some((e) => e.id === sess.id && e.status === 'archived'), '归档保留审计，不物理删除')
  // dry-run 不落盘
  const before = mem.activeEntries(cfg).length
  mem.enforceCapacity(cfg, { now, maxEntries: 5, dryRun: true })
  assert.equal(mem.activeEntries(cfg).length, before, 'dry-run 不得改动')
})

test('B5 容量：字节超限也会触发（条目数未超）', async () => {
  const mem = await import('../memory.mjs')
  const r = mkdtempSync(join(tmpdir(), 'lcm-cap2-'))
  const cfg = loadConfig(r, { meterRoot: join(r, '.lcm') })
  mkdirSync(cfg.memoryDir, { recursive: true })
  for (let i = 0; i < 12; i++) {
    mem.record(cfg, {
      type: 'fact', subject: `字节主题${i}`, claim: `字节容量测试条目 ${i}，内容刻意写长一些以便触发字节上限路径`,
      score: 0.8, source: 'manual', sessionId: 's1',
    })
  }
  const res = mem.enforceCapacity(cfg, { maxEntries: 10_000, maxBytes: 500 })
  assert.ok(res.over && res.archived > 0, '字节超限也必须治理')
})
