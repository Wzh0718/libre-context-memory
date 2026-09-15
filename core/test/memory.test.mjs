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
