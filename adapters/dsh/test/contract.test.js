/** dsh-lcm 契约测试：伪造 ctx/exec/result 重放，不烧 token、不需要 harness。 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readdirSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../src/index.js'

function fakeCtx() {
  const listeners = []
  const logs = { info: [], warn: [] }
  const services = {}
  return {
    listeners,
    logs,
    services,
    on(event, fn, opts) { listeners.push({ event, fn, opts }) },
    get(name) { return services[name] },          // 对齐 cordis ctx.get：免 inject 读取
    logger: {
      info: (m) => logs.info.push(m),
      warn: (m) => logs.warn.push(m),
    },
  }
}

/** 伪造 session：surface 节点 + 事件查取 + append 记录。 */
function fakeSession(lcmRoot, entries) {
  const events = new Map(entries.map((e, i) => [i + 1, e]))
  const appends = []
  return {
    appends,
    header: { id: 'sess-prune', cwd: lcmRoot },
    surface: { nodes: [...events.keys()] },
    eventAt: (seq) => events.get(seq),
    append(type, data, opts) {
      appends.push({ type, data, opts })
      // 模拟真实 surface 替换：被替换的节点在 surface 上换成新内容
      if (type === 'tool/result' && opts?.surfaceOp?.op === 'replace') {
        const seq = opts.surfaceOp.start
        events.set(seq, { type, data, seq })
      }
      return { seq: 10_000 + appends.length }
    },
  }
}

function toolResultEvent(text) {
  return {
    type: 'tool/result',
    data: { message: { source: { callId: 'c1' }, content: [{ role: 'tool', content: [{ type: 'text', text }] }] } },
  }
}

function withTokenMeter(ctx, totalTokens) {
  ctx.services.tokenMeter = { measure: () => ({ totalTokens }), estimateMessage: () => 100 }
}

async function runPreStep(ctx, session) {
  const { fn } = ctx.listeners.find((l) => l.event === 'agent/pre-step')
  let nextCalled = false
  await fn({ agent: { session } }, async () => { nextCalled = true })
  assert.ok(nextCalled, 'pre-step 必须放行 next()')
}

function fakeExec(name = 'bash', sessionId = 'sess-test') {
  return {
    name,
    callId: 'call-1',
    parent: undefined,
    agent: { session: { header: { id: sessionId } } },
  }
}

function acceptDecision(text) {
  return { kind: 'accept', content: [{ type: 'text', text }] }
}

async function runPostExecute(ctx, exec, decision) {
  const { fn } = ctx.listeners.find((l) => l.event === 'tools/post-execute')
  return fn(exec, { content: decision.content }, async () => decision)
}

const bigLog = () => Array.from({ length: 3000 }, (_, i) =>
  `2026-09-11T01:${String(i % 60).padStart(2, '0')}:00Z INFO worker heartbeat ${i % 3}`).join('\n')

test('小输出直通：不触发压缩', async () => {
  const ctx = fakeCtx()
  apply(ctx, { mode: 'active' })
  const d = await runPostExecute(ctx, fakeExec(), acceptDecision('小结果'))
  assert.equal(d.content[0].text, '小结果')
})

test('非 accept / read / 子调用：全部透传', async () => {
  const ctx = fakeCtx()
  apply(ctx, { mode: 'active' })
  const big = 'x'.repeat(50_000)
  assert.equal((await runPostExecute(ctx, fakeExec(), { kind: 'block', feedback: 'no' })).kind, 'block')
  const d = acceptDecision(big)
  assert.equal((await runPostExecute(ctx, fakeExec('read'), d)).content[0].text, big)
  assert.equal((await runPostExecute(ctx, { ...fakeExec(), parent: {} }, d)).content[0].text, big)
})

test('shadow 模式：记录决策但不替换', async () => {
  const ctx = fakeCtx()
  const lcmRoot = mkdtempSync(join(tmpdir(), 'lcm-shadow-'))
  apply(ctx, { mode: 'shadow', lcmRoot })
  const text = bigLog()
  const d = await runPostExecute(ctx, fakeExec(), acceptDecision(text))
  assert.equal(d.content[0].text, text)  // 原文透传
  assert.ok(ctx.logs.info.some((m) => m.includes('[shadow]')), '应有 shadow 日志')
  // shadow 记了 meter 但不落 spill
  const { meterFiles } = await import('../../../core/meter.mjs')
  const { loadConfig: lc } = await import('../../../core/config.mjs')
  assert.ok(meterFiles(lc(lcmRoot)).length > 0, 'meter 应有记录（按月轮转文件）')
  assert.ok(!existsSync(join(lcmRoot, '.lcm', 'spill')), 'shadow 不落 spill')
})

test('active 模式：替换为摘要+句柄，句柄可回取', async () => {
  const ctx = fakeCtx()
  const lcmRoot = mkdtempSync(join(tmpdir(), 'lcm-active-'))
  apply(ctx, { mode: 'active', lcmRoot })
  const text = bigLog()
  const d = await runPostExecute(ctx, fakeExec(), acceptDecision(text))
  const replaced = d.content[0].text
  assert.ok(replaced.length < text.length / 10, '替换后应显著变小')
  assert.match(replaced, /spill:[0-9a-f]{12}/)
  assert.match(replaced, /lcm read spill:/)
  // 句柄真实可回取（本地后端）
  const spillDir = join(lcmRoot, '.lcm', 'spill')
  const files = readdirSync(spillDir)
  assert.equal(files.length, 1)
  const { read } = await import('../../../core/spill.mjs')
  const { loadConfig } = await import('../../../core/config.mjs')
  const handle = replaced.match(/spill:[0-9a-f]{12}/)[0]      // 用模型实际拿到的句柄回取
  assert.equal(read(loadConfig(lcmRoot), handle).text, text)
})

test('active 模式失败静默：核心抛错时透传原文', async () => {
  const ctx = fakeCtx()
  // lcmRoot 指向一个文件而非目录 → spill.put 的 mkdir 必抛 ENOTDIR → 应回退原文
  const fileAsRoot = join(tmpdir(), `lcm-notdir-${process.pid}`)
  const { writeFileSync } = await import('node:fs')
  writeFileSync(fileAsRoot, 'x')
  apply(ctx, { mode: 'active', lcmRoot: fileAsRoot })
  const big = 'y'.repeat(50_000)
  const d = await runPostExecute(ctx, fakeExec(), acceptDecision(big))
  assert.equal(d.content[0].text, big)
  assert.ok(ctx.logs.warn.some((m) => m.includes('compress failed')))
})

test('观测臂：每请求 usage 与折叠事件落 meter（不改行为）', async () => {
  const ctx = fakeCtx()
  const lcmRoot = mkdtempSync(join(tmpdir(), 'lcm-usage-'))
  apply(ctx, { mode: 'shadow', lcmRoot })
  const { fn } = ctx.listeners.find((l) => l.event === 'session/event')
  const session = { header: { id: 'sess-u', cwd: lcmRoot } }
  // DSH 口径：inputTokens = fresh（不含 cacheRead）
  fn(session, { type: 'assistant/message', data: { usage: { inputTokens: 6_000, cacheReadTokens: 94_000, outputTokens: 500 } } })
  fn(session, { type: 'assistant/message', data: { usage: { inputTokens: 60_000, cacheReadTokens: 0, outputTokens: 100 } } })
  fn(session, { type: 'compaction/prune', data: { shadowedTokenCount: 3383 } })
  fn(session, { type: 'session/other', data: {} })  // 无关事件忽略

  const { summary } = await import('../../../core/meter.mjs')
  const { loadConfig } = await import('../../../core/config.mjs')
  const s = summary(loadConfig(lcmRoot))
  assert.equal(s.usage.requests, 2)
  assert.ok(Math.abs(s.usage.hitRate - 94_000 / 160_000) < 1e-3)   // (6k fresh + 94k cached + 60k fresh)
  assert.equal(s.usage.totalFresh, 66_000)
  assert.equal(s.usage.cacheBusts, 1)             // 第二条 fresh=60k>50k
  assert.equal(s.compactions, 1)
})

test('剪枝臂：预算内不动', async () => {
  const ctx = fakeCtx()
  const lcmRoot = mkdtempSync(join(tmpdir(), 'lcm-prune-'))
  apply(ctx, { mode: 'active', lcmRoot })
  withTokenMeter(ctx, 50_000)  // < budgetTokens 100k
  const session = fakeSession(lcmRoot, [toolResultEvent('x'.repeat(80_000))])
  await runPreStep(ctx, session)
  assert.equal(session.appends.length, 0)
})

test('剪枝臂 shadow：超预算完整计算+记账，但不改写历史', async () => {
  const ctx = fakeCtx()
  const lcmRoot = mkdtempSync(join(tmpdir(), 'lcm-prune-'))
  apply(ctx, { mode: 'shadow', lcmRoot })
  withTokenMeter(ctx, 150_000)
  const session = fakeSession(lcmRoot, [toolResultEvent('x'.repeat(80_000)), toolResultEvent('y'.repeat(80_000))])
  await runPreStep(ctx, session)
  assert.equal(session.appends.length, 0)  // 影子不改写
  const { summary } = await import('../../../core/meter.mjs')
  const { loadConfig } = await import('../../../core/config.mjs')
  const s = summary(loadConfig(lcmRoot))
  assert.equal(s.prunes, 1)
  assert.equal(s.pruneShadow, 1)
  assert.equal(s.pruneNodes, 1)            // 最大者优先 + 最新保留 → 只剪 seq1
})

test('剪枝臂 active：shadow-price + replace 成对落地，最新节点跳过', async () => {
  const ctx = fakeCtx()
  const lcmRoot = mkdtempSync(join(tmpdir(), 'lcm-prune-'))
  apply(ctx, { mode: 'active', lcmRoot })
  withTokenMeter(ctx, 150_000)
  const session = fakeSession(lcmRoot, [
    toolResultEvent('a'.repeat(80_000)),   // seq1 最老最大 → 被剪
    toolResultEvent('b'.repeat(80_000)),   // seq2 最新 → 保留
  ])
  await runPreStep(ctx, session)
  const ops = session.appends.filter((a) => a.type === 'tool/result')
  const prices = session.appends.filter((a) => a.type === 'compaction/prune')
  assert.equal(ops.length, 1)
  assert.equal(prices.length, 1)
  assert.deepEqual(ops[0].opts.surfaceOp, { op: 'replace', start: 1, end: 1 })
  assert.deepEqual(prices[0].data.shadowedSeqs, [1])
  const body = ops[0].data.message.content[0].content[0].text
  assert.ok(body.includes('[归档]') || body.includes('已剪枝'))
  assert.ok([...body].length < 80_000)
})

function fakeAssembly() {
  return {
    sections: [{ name: 's', text: 'x' }], contexts: [], variables: {},
    tools: [
      { name: 'bash', description: 'Bash tool.\n\n长内部说明'.repeat(60), parameters: { type: 'object' } },
      { name: 'read', description: 'Read a file.', parameters: { type: 'object' } },
      { name: 'mcp__mnemon__remember', description: 'Store insight.\n\n细节'.repeat(40), parameters: { type: 'object' } },
      { name: 'mcp__dbx__dbx_execute_query', description: 'Run SQL.', parameters: { type: 'object' } },
    ],
  }
}

async function runAssemble(ctx, assembly) {
  const { fn } = ctx.listeners.find((l) => l.event === 'system-prompt/assemble')
  assert.ok(fn, '缺少 system-prompt/assemble 监听')
  return fn(assembly, {}, async () => assembly)
}

test('静态层裁剪 shadow：只记账，工具集原样返回', async () => {
  const ctx = fakeCtx()
  const lcmRoot = mkdtempSync(join(tmpdir(), 'lcm-trim-'))
  apply(ctx, { mode: 'shadow', lcmRoot, toolMaxDescriptionChars: 200 })
  const asm = fakeAssembly()
  const out = await runAssemble(ctx, asm)
  assert.equal(out, asm)                                   // 影子严格不改写
  const { summary } = await import('../../../core/meter.mjs')
  const { loadConfig } = await import('../../../core/config.mjs')
  const s = summary(loadConfig(lcmRoot))
  assert.equal(s.trims, 1)
  assert.equal(s.trimToolsBefore, 4)
  assert.ok(s.trimCharsAfter < s.trimCharsBefore)
})

test('静态层裁剪 active：描述压到预算内 + 整族丢弃，且逐字节确定', async () => {
  const ctx = fakeCtx()
  const lcmRoot = mkdtempSync(join(tmpdir(), 'lcm-trim-'))
  apply(ctx, { mode: 'active', lcmRoot, toolMaxDescriptionChars: 200, dropToolFamilies: ['mcp__mnemon'] })
  const out1 = await runAssemble(ctx, fakeAssembly())
  const out2 = await runAssemble(ctx, fakeAssembly())
  assert.deepEqual(out1, out2)                              // 确定性 = 缓存前缀安全
  assert.deepEqual(out1.sections, fakeAssembly().sections)  // 只动 tools
  const names = out1.tools.map((t) => t.name)
  assert.ok(!names.includes('mcp__mnemon__remember'))       // 整族丢弃
  assert.ok(names.includes('mcp__dbx__dbx_execute_query'))
  for (const tool of out1.tools) {
    assert.ok([...tool.description].length <= 200, `${tool.name} 描述未压到预算内`)
  }
  assert.equal(out1.tools.find((t) => t.name === 'read').description, 'Read a file.') // 短描述不动
  assert.deepEqual(out1.tools[0].parameters, { type: 'object' })                     // 参数 schema 绝不改
})

test('剪枝臂 active：介于压缩直通区（2k–20k）的节点也必须变小', async () => {
  const ctx = fakeCtx()
  const lcmRoot = mkdtempSync(join(tmpdir(), 'lcm-prune-mid-'))
  apply(ctx, { mode: 'active', lcmRoot })
  withTokenMeter(ctx, 150_000)
  const mid = ('INFO worker heartbeat line with some payload\n').repeat(120)   // ≈5k 字符
  assert.ok([...mid].length > 2_000 && [...mid].length < 20_000)
  const session = fakeSession(lcmRoot, [toolResultEvent(mid), toolResultEvent('x'.repeat(40_000))])
  await runPreStep(ctx, session)
  const ops = session.appends.filter((a) => a.type === 'tool/result')
  // 最大的恰好是最新节点（seq2）→ 受保护跳过；被剪的是老的中等节点（seq1）
  assert.equal(ops.length, 1)
  assert.equal(ops[0].opts.surfaceOp.start, 1)
  const body1 = ops[0].data.message.content[0].content[0].text
  assert.ok([...body1].length < [...mid].length, `直通区节点也必须变小（${[...body1].length} < ${[...mid].length}）`)
})

test('分臂模式：mode=active 时静态层裁剪仍可单独保持 shadow', async () => {
  const ctx = fakeCtx()
  const lcmRoot = mkdtempSync(join(tmpdir(), 'lcm-trim-scope-'))
  apply(ctx, { mode: 'active', staticTrimMode: 'shadow', lcmRoot, toolMaxDescriptionChars: 100 })
  const asm = fakeAssembly()
  const out = await runAssemble(ctx, asm)
  assert.equal(out, asm, '静态层裁剪臂保持 shadow → 工具集必须原样返回')
  const { summary } = await import('../../../core/meter.mjs')
  const { loadConfig } = await import('../../../core/config.mjs')
  const s = summary(loadConfig(lcmRoot))
  assert.equal(s.trims, 1)
  assert.equal(s.trimShadow, 1, '计量里应标为 shadow')
})

test('剪枝冷却：剪过一次后要等会话再长够 token 才允许再剪（防反复击穿）', async () => {
  const ctx = fakeCtx()
  const lcmRoot = mkdtempSync(join(tmpdir(), 'lcm-cooldown-'))
  apply(ctx, { mode: 'active', lcmRoot, budgetTokens: 100_000, targetTokens: 60_000, pruneCooldownTokens: 10_000 })
  const { fn } = ctx.listeners.find((l) => l.event === 'agent/pre-step')
  const entries = [toolResultEvent('a'.repeat(40_000)), toolResultEvent('b'.repeat(40_000)), toolResultEvent('c'.repeat(40_000))]
  const session = fakeSession(lcmRoot, entries)
  // 假 meter：压力随会话**当前内容**变化（压缩/剪枝后自然下降），贴近真实 tokenMeter 语义
  let overhead = 60_000
  ctx.services.tokenMeter = {
    measure: (s) => {
      let chars = 0
      for (const seq of s.surface.nodes) {
        let text = ''
        const walk = (n) => {
          if (n === null || typeof n !== 'object') return
          if (Array.isArray(n)) { n.forEach(walk); return }
          if (n.type === 'text' && typeof n.text === 'string') text += n.text
          else for (const v of Object.values(n)) walk(v)
        }
        walk(s.eventAt(seq)?.data)
        chars += text.length
      }
      return { totalTokens: overhead + Math.ceil(chars / 2) }
    },
    estimateMessage: () => 100,
  }
  await fn({ agent: { session } }, async () => {})
  assert.ok(session.appends.length > 0, '首次应剪枝（压力远超预算）')
  // 再走一步：会话只长了一点点（overhead +1k），仍应在冷却窗口内
  overhead += 1_000
  const before = session.appends.length
  await fn({ agent: { session } }, async () => {})
  assert.equal(session.appends.length, before, '冷却窗口内不得再次剪枝（避免反复击穿前缀）')
  // 会话真长够了 → 重新允许
  overhead += 40_000
  await fn({ agent: { session } }, async () => {})
  assert.ok(session.appends.length > before, '超过冷却水位后应重新允许剪枝')
})

test('非法 mode 在加载期拒绝', () => {
  assert.throws(() => apply(fakeCtx(), { mode: 'bogus' }), /mode must be/)
})
