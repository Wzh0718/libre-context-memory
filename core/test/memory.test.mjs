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
