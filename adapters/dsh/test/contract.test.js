/** dsh-lcm 契约测试：伪造 ctx/exec/result 重放，不烧 token、不需要 harness。 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 测试密封：绝不读真实 ~/.openviking / ~/.config（ovcli 兜底会发真实网络请求）
process.env.LCM_OPENVIKING_DISABLED = '1'

import { apply } from '../src/index.js'
import { loadConfig as loadConfigRaw } from '../../../core/config.mjs'
import { read as spillRead, usage as spillUsage } from '../../../core/spill.mjs'
import { meterFiles, summary } from '../../../core/meter.mjs'

/** meter 根隔离：测试内计量一律落临时目录（真实全局根是 ~/.lcm，绝不能碰）。 */
const lcfg = (root) => loadConfigRaw(root, { meterRoot: join(root, '.lcm') })
function applyT(ctx, opts = {}) {
  const root = opts.lcmRoot
  return apply(ctx, root ? { ...opts, meterRoot: join(root, '.lcm') } : opts)
}

/** 读 meter 文件里指定 kind 的原始事件（summary 不透出的字段用这个查）。 */
function readMeterEvents(root, kind) {
  const dir = join(root, '.lcm')
  const out = []
  for (const name of readdirSync(dir)) {
    if (!/^meter(-\d{6})?\.jsonl$/.test(name)) continue
    for (const line of readFileSync(join(dir, name), 'utf8').split('\n')) {
      if (!line) continue
      try { const e = JSON.parse(line); if (e.kind === kind) out.push(e) } catch { /* skip */ }
    }
  }
  return out
}

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
      if (opts?.surfaceOp?.op === 'replace') {
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

function emitSessionEvent(ctx, session, event) {
  const { fn } = ctx.listeners.find((l) => l.event === 'session/event')
  assert.ok(fn, '缺少 session/event 监听')
  if (!event.sessionId) event.sessionId = session.header.id
  return fn(session, event)
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
  applyT(ctx, { mode: 'active' })
  const d = await runPostExecute(ctx, fakeExec(), acceptDecision('小结果'))
  assert.equal(d.content[0].text, '小结果')
})

test('非 accept / read / 子调用：全部透传', async () => {
  const ctx = fakeCtx()
  applyT(ctx, { mode: 'active' })
  const big = 'x'.repeat(50_000)
  assert.equal((await runPostExecute(ctx, fakeExec(), { kind: 'block', feedback: 'no' })).kind, 'block')
  const d = acceptDecision(big)
  assert.equal((await runPostExecute(ctx, fakeExec('read'), d)).content[0].text, big)
  assert.equal((await runPostExecute(ctx, { ...fakeExec(), parent: {} }, d)).content[0].text, big)
})

test('shadow 模式：记录决策但不替换', async () => {
  const ctx = fakeCtx()
  const lcmRoot = mkdtempSync(join(tmpdir(), 'lcm-shadow-'))
  applyT(ctx, { mode: 'shadow', lcmRoot })
  const text = bigLog()
  const d = await runPostExecute(ctx, fakeExec(), acceptDecision(text))
  assert.equal(d.content[0].text, text)  // 原文透传
  assert.ok(ctx.logs.info.some((m) => m.includes('[shadow]')), '应有 shadow 日志')
  // shadow 记了 meter 但不落 spill
  assert.ok(meterFiles(lcfg(lcmRoot)).length > 0, 'meter 应有记录（按月轮转文件）')
  assert.ok(!existsSync(join(lcmRoot, '.lcm', 'spill')), 'shadow 不落 spill')
})

test('active 模式：替换为摘要+句柄，句柄可回取', async () => {
  const ctx = fakeCtx()
  const lcmRoot = mkdtempSync(join(tmpdir(), 'lcm-active-'))
  applyT(ctx, { mode: 'active', lcmRoot })
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
  const handle = replaced.match(/spill:[0-9a-f]{12}/)[0]      // 用模型实际拿到的句柄回取
  assert.equal(spillRead(lcfg(lcmRoot), handle).text, text)
})

test('active 模式失败静默：核心抛错时透传原文', async () => {
  const ctx = fakeCtx()
  // lcmRoot 指向一个文件而非目录 → spill.put 的 mkdir 必抛 ENOTDIR → 应回退原文
  const fileAsRoot = join(tmpdir(), `lcm-notdir-${process.pid}`)
  const { writeFileSync } = await import('node:fs')
  writeFileSync(fileAsRoot, 'x')
  applyT(ctx, { mode: 'active', lcmRoot: fileAsRoot })
  const big = 'y'.repeat(50_000)
  const d = await runPostExecute(ctx, fakeExec(), acceptDecision(big))
  assert.equal(d.content[0].text, big)
  assert.ok(ctx.logs.warn.some((m) => m.includes('compress failed')))
})

test('观测臂：每请求 usage 与折叠事件落 meter（不改行为）', async () => {
  const ctx = fakeCtx()
  const lcmRoot = mkdtempSync(join(tmpdir(), 'lcm-usage-'))
  applyT(ctx, { mode: 'shadow', lcmRoot })
  const { fn } = ctx.listeners.find((l) => l.event === 'session/event')
  const session = { header: { id: 'sess-u', cwd: lcmRoot } }
  // DSH 口径：inputTokens = fresh（不含 cacheRead）
  fn(session, { type: 'assistant/message', data: { usage: { inputTokens: 6_000, cacheReadTokens: 94_000, outputTokens: 500 } } })
  fn(session, { type: 'assistant/message', data: { usage: { inputTokens: 60_000, cacheReadTokens: 0, outputTokens: 100 } } })
  fn(session, { type: 'compaction/prune', data: { shadowedTokenCount: 3383 } })
  fn(session, { type: 'session/other', data: {} })  // 无关事件忽略

  const s = summary(lcfg(lcmRoot))
  assert.equal(s.usage.requests, 2)
  assert.ok(Math.abs(s.usage.hitRate - 94_000 / 160_000) < 1e-3)   // (6k fresh + 94k cached + 60k fresh)
  assert.equal(s.usage.totalFresh, 66_000)
  assert.equal(s.usage.cacheBusts, 1)             // 第二条 fresh=60k>50k
  assert.equal(s.compactions, 1)
})

test('剪枝臂：预算内不动', async () => {
  const ctx = fakeCtx()
  const lcmRoot = mkdtempSync(join(tmpdir(), 'lcm-prune-'))
  applyT(ctx, { mode: 'active', lcmRoot })
  withTokenMeter(ctx, 50_000)  // < budgetTokens 100k
  const session = fakeSession(lcmRoot, [toolResultEvent('x'.repeat(80_000))])
  await runPreStep(ctx, session)
  assert.equal(session.appends.length, 0)
})

test('剪枝臂 shadow：超预算完整计算+记账，但不改写历史', async () => {
  const ctx = fakeCtx()
  const lcmRoot = mkdtempSync(join(tmpdir(), 'lcm-prune-'))
  applyT(ctx, { mode: 'shadow', lcmRoot })
  withTokenMeter(ctx, 150_000)
  const session = fakeSession(lcmRoot, [toolResultEvent('x'.repeat(80_000)), toolResultEvent('y'.repeat(80_000))])
  emitSessionEvent(ctx, session, { type: 'compaction/basic' })
  await runPreStep(ctx, session)
  assert.equal(session.appends.length, 0)  // 影子不改写
  const s = summary(lcfg(lcmRoot))
  assert.equal(s.prunes, 1)
  assert.equal(s.pruneShadow, 1)
  assert.equal(s.pruneNodes, 1)            // 最大者优先 + 最新保留 → 只剪 seq1
})

test('剪枝臂 active：shadow-price + replace 成对落地，最新节点跳过', async () => {
  const ctx = fakeCtx()
  const lcmRoot = mkdtempSync(join(tmpdir(), 'lcm-prune-'))
  applyT(ctx, { mode: 'active', lcmRoot })
  withTokenMeter(ctx, 150_000)
  const session = fakeSession(lcmRoot, [
    toolResultEvent('a'.repeat(80_000)),   // seq1 最老最大 → 被剪
    toolResultEvent('b'.repeat(80_000)),   // seq2 最新 → 保留
  ])
  emitSessionEvent(ctx, session, { type: 'compaction/basic' })
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
  applyT(ctx, { mode: 'shadow', lcmRoot, toolMaxDescriptionChars: 200 })
  const asm = fakeAssembly()
  const out = await runAssemble(ctx, asm)
  assert.equal(out, asm)                                   // 影子严格不改写
  const s = summary(lcfg(lcmRoot))
  assert.equal(s.trims, 1)
  assert.equal(s.trimToolsBefore, 4)
  assert.ok(s.trimCharsAfter < s.trimCharsBefore)
})

test('静态层裁剪 active：描述压到预算内 + 整族丢弃，且逐字节确定', async () => {
  const ctx = fakeCtx()
  const lcmRoot = mkdtempSync(join(tmpdir(), 'lcm-trim-'))
  applyT(ctx, { mode: 'active', lcmRoot, toolMaxDescriptionChars: 200, dropToolFamilies: ['mcp__mnemon'] })
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
  applyT(ctx, { mode: 'active', lcmRoot })
  withTokenMeter(ctx, 150_000)
  const mid = ('INFO worker heartbeat line with some payload\n').repeat(120)   // ≈5k 字符
  assert.ok([...mid].length > 2_000 && [...mid].length < 20_000)
  const session = fakeSession(lcmRoot, [toolResultEvent(mid), toolResultEvent('x'.repeat(40_000))])
  emitSessionEvent(ctx, session, { type: 'compaction/basic' })
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
  applyT(ctx, { mode: 'active', staticTrimMode: 'shadow', lcmRoot, toolMaxDescriptionChars: 100 })
  const asm = fakeAssembly()
  const out = await runAssemble(ctx, asm)
  assert.equal(out, asm, '静态层裁剪臂保持 shadow → 工具集必须原样返回')
  const s = summary(lcfg(lcmRoot))
  assert.equal(s.trims, 1)
  assert.equal(s.trimShadow, 1, '计量里应标为 shadow')
})

test('剪枝冷却：剪过一次后要等会话再长够 token 才允许再剪（防反复击穿）', async () => {
  const ctx = fakeCtx()
  const lcmRoot = mkdtempSync(join(tmpdir(), 'lcm-cooldown-'))
  applyT(ctx, { mode: 'active', lcmRoot, budgetTokens: 100_000, targetTokens: 60_000, pruneCooldownTokens: 10_000 })
  const { fn } = ctx.listeners.find((l) => l.event === 'agent/pre-step')
  const entries = [toolResultEvent('a'.repeat(40_000)), toolResultEvent('b'.repeat(40_000)), toolResultEvent('c'.repeat(40_000))]
  const session = fakeSession(lcmRoot, entries)
  emitSessionEvent(ctx, session, { type: 'compaction/basic' })
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
  // piggyback 模式下，光长够不会触发；需要再来一次 free-cold 事件
  overhead += 40_000
  await fn({ agent: { session } }, async () => {})
  assert.equal(session.appends.length, before, '没有新的免费窗口时不得再次剪枝')
  // 新的 compaction 事件触发 → 冷却已过期 → 允许再次剪枝
  emitSessionEvent(ctx, session, { type: 'compaction/basic' })
  await fn({ agent: { session } }, async () => {})
  assert.ok(session.appends.length > before, '新的免费窗口 + 超过冷却水位后应重新允许剪枝')
})

test('piggyback：没有免费窗口时，即使超预算也不主动制造击穿', async () => {
  const ctx = fakeCtx()
  const lcmRoot = mkdtempSync(join(tmpdir(), 'lcm-piggyback-'))
  applyT(ctx, { mode: 'active', lcmRoot, budgetTokens: 100_000 })
  withTokenMeter(ctx, 150_000)
  const session = fakeSession(lcmRoot, [toolResultEvent('a'.repeat(80_000)), toolResultEvent('b'.repeat(80_000))])
  await runPreStep(ctx, session)
  assert.equal(session.appends.length, 0, '默认 proactive=false 且没有 cold 事件 → 不剪')
})

test('piggyback：compaction 事件后但低于 budgetTokens 守卫 → 不剪，且 cold 标记被消费', async () => {
  const ctx = fakeCtx()
  const lcmRoot = mkdtempSync(join(tmpdir(), 'lcm-piggyback-guard-'))
  applyT(ctx, { mode: 'active', lcmRoot, budgetTokens: 100_000 })
  withTokenMeter(ctx, 80_000) // 低于 budget
  const session = fakeSession(lcmRoot, [toolResultEvent('a'.repeat(40_000))])
  emitSessionEvent(ctx, session, { type: 'compaction/basic' })
  await runPreStep(ctx, session)
  assert.equal(session.appends.length, 0, '低于守卫 → 不剪')
  // cold 标记应已被消费；即使现在压力涨上来，没有新事件也不能剪
  withTokenMeter(ctx, 150_000)
  await runPreStep(ctx, session)
  assert.equal(session.appends.length, 0, '过期 cold 标记不得复用')
})

test('piggyback：观测到击穿后下一次 pre-step 可免费剪枝', async () => {
  const ctx = fakeCtx()
  const lcmRoot = mkdtempSync(join(tmpdir(), 'lcm-piggyback-bust-'))
  applyT(ctx, { mode: 'active', lcmRoot, budgetTokens: 100_000, bustThresholdTokens: 50_000 })
  withTokenMeter(ctx, 150_000)
  const session = fakeSession(lcmRoot, [toolResultEvent('a'.repeat(80_000)), toolResultEvent('b'.repeat(80_000))])
  // 模拟一次击穿：usage.fresh > 阈值（前缀已冷）
  emitSessionEvent(ctx, session, {
    type: 'assistant/message',
    data: { usage: { inputTokens: 60_000, cacheReadTokens: 10_000 } },
  })
  await runPreStep(ctx, session)
  assert.ok(session.appends.length > 0, '击穿后应触发免费剪枝')
})

test('proactive=true 时仍可按原主动预算路径触发', async () => {
  const ctx = fakeCtx()
  const lcmRoot = mkdtempSync(join(tmpdir(), 'lcm-proactive-'))
  applyT(ctx, { mode: 'active', lcmRoot, budgetTokens: 100_000, pruneProactive: true })
  withTokenMeter(ctx, 150_000)
  const session = fakeSession(lcmRoot, [toolResultEvent('a'.repeat(80_000)), toolResultEvent('b'.repeat(80_000))])
  await runPreStep(ctx, session)
  assert.ok(session.appends.length > 0, '显式开 proactive 后无 cold 事件也应剪枝')
})

test('非法 mode 在加载期拒绝', () => {
  assert.throws(() => apply(fakeCtx(), { mode: 'bogus' }), /mode must be/)
})

test('继承冷启动：subagent fork 首个 pre-step 免费剪枝（无需 compaction/击穿事件）', async () => {
  const ctx = fakeCtx()
  const lcmRoot = mkdtempSync(join(tmpdir(), 'lcm-inherit-'))
  applyT(ctx, { mode: 'active', lcmRoot })
  withTokenMeter(ctx, 150_000)
  const session = fakeSession(lcmRoot, [toolResultEvent('a'.repeat(80_000)), toolResultEvent('b'.repeat(80_000))])
  session.header = { ...session.header, origin: 'subagent', parentSession: 'session-parent' }
  await runPreStep(ctx, session)
  assert.ok(session.appends.length > 0, 'fork 首请求前应免费剪枝（继承转写无缓存可打穿）')
  const prunes = readMeterEvents(lcmRoot, 'prune')
  assert.equal(prunes.length, 1)
  assert.equal(prunes[0].trigger, 'inherited-cold')
  assert.equal(prunes[0].project, lcmRoot, '剪枝事件应带 project 标签')
  // 第二个 pre-step：继承窗口只在首个 pre-step 有效 → 冷却水位内不得再剪
  const before = session.appends.length
  await runPreStep(ctx, session)
  assert.equal(session.appends.length, before, '继承窗口一次性，不得重复触发')
})

test('继承冷启动守卫：普通会话（非 fork）首个 pre-step 不得凭空剪枝', async () => {
  const ctx = fakeCtx()
  const lcmRoot = mkdtempSync(join(tmpdir(), 'lcm-inherit-guard-'))
  applyT(ctx, { mode: 'active', lcmRoot })
  withTokenMeter(ctx, 150_000)
  const session = fakeSession(lcmRoot, [toolResultEvent('a'.repeat(80_000))])
  session.header = { ...session.header }   // 无 origin / parentSession
  await runPreStep(ctx, session)
  assert.equal(session.appends.length, 0, '普通新会话首请求可能命中缓存，不得凭空改写历史')
})

test('继承冷启动守卫：fork 但低于 budgetTokens 也不剪', async () => {
  const ctx = fakeCtx()
  const lcmRoot = mkdtempSync(join(tmpdir(), 'lcm-inherit-budget-'))
  applyT(ctx, { mode: 'active', lcmRoot })
  withTokenMeter(ctx, 50_000)   // < budgetTokens 100k
  const session = fakeSession(lcmRoot, [toolResultEvent('a'.repeat(80_000))])
  session.header = { ...session.header, origin: 'subagent', parentSession: 'session-parent' }
  await runPreStep(ctx, session)
  assert.equal(session.appends.length, 0, '低于守卫水位的小 fork 不值得一剪')
})

test('trim-diff 复核工件：assemble 自动落盘 + 内容寻址节流', async () => {
  const ctx = fakeCtx()
  const lcmRoot = mkdtempSync(join(tmpdir(), 'lcm-trimpv-'))
  applyT(ctx, { mode: 'shadow', lcmRoot, toolMaxDescriptionChars: 100 })
  await runAssemble(ctx, fakeAssembly())
  const pv = join(lcmRoot, '.lcm', 'trim-preview.json')
  assert.ok(existsSync(pv), '复核工件应落在 meter 根')
  const data = JSON.parse(readFileSync(pv, 'utf8'))
  assert.ok(data.tools.length > 0, '只记录被改动的工具')
  assert.ok(data.tools.every((t) => typeof t.before === 'string' && typeof t.after === 'string'))
  assert.ok(data.charsBefore > data.charsAfter)
  // 同输入再跑：digest 不变 → 不重写（savedAt 不变）
  await runAssemble(ctx, fakeAssembly())
  const again = JSON.parse(readFileSync(pv, 'utf8'))
  assert.equal(again.savedAt, data.savedAt, '同输入不得重写复核工件')
  // 静态层计量事件带 project: null 且落 meter 根（此前落错根的修复）
  const trims = readMeterEvents(lcmRoot, 'static-trim')
  assert.equal(trims.length, 2)   // 两次 assemble 各记一次
  assert.equal(trims[0].project, null)
})

// ---------------------------------------------------------------- 记忆臂（Phase 3）

const SUMMARY_EVENT = {
  type: 'compaction/summary',
  data: {
    summary: [{ type: 'text', text: `## Primary Request and Intent
- Original goal: 通过 dsh 采集 session 数据，研究 memory 管理
- 下一步：验证 docs/04-memory.md 的注入检索质量（当前命中 87%）

## Key Technical Concepts
- 记忆库位置 /home/libre/.lcm/memories 全局共享
- 决定：本地库为 source of truth，OpenViking 只做同步副本` }],
  },
}

async function runPreStepWithDecision(ctx, session, decision) {
  const { fn } = ctx.listeners.find((l) => l.event === 'agent/pre-step')
  return fn({ agent: { session } }, async () => decision)
}

test('记忆提取臂：compaction/summary → 确定性提取入库 + meter 记账', async () => {
  const ctx = fakeCtx()
  const lcmRoot = mkdtempSync(join(tmpdir(), 'lcm-memext-'))
  applyT(ctx, { mode: 'active', lcmRoot })
  const session = { header: { id: 'sess-mem', cwd: lcmRoot } }
  emitSessionEvent(ctx, session, SUMMARY_EVENT)

  const { activeEntries } = await import('../../../core/memory.mjs')
  const live = activeEntries(lcfg(lcmRoot))
  assert.ok(live.length >= 3, `应有提取产出（实际 ${live.length}）`)
  assert.ok(live.every((e) => e.source === 'compaction/summary'))
  assert.ok(live.some((e) => e.type === 'open_thread'), '「下一步」→ open_thread（有文件名锚）')
  assert.ok(live.some((e) => e.type === 'fact' || e.type === 'decision'))
  // 质量纪律：无锚的 Original goal（纯散文 intent，0.6×0.5=0.3 < 0.45）必须被低分拒绝
  const rejects = readMeterEvents(lcmRoot, 'memory').filter((e) => e.action === 'REJECT' && e.reason === 'low-quality')
  assert.equal(rejects.length, 1, '无锚 open_thread 恰好一条被质量门槛拒绝' + JSON.stringify(readMeterEvents(lcmRoot, 'memory').map((e) => e.action + e.reason)))
  // 分层门槛：无锚的纯散文候选即使在 summary 里也会被低分拒绝（质量纪律）
  {
    const cfg0 = lcfg(lcmRoot)
    const weak = { type: 'open_thread', subject: '', claim: '接下来要慢慢验证还有很多事情', source: 'compaction/summary' }
    const mem0 = await import('../../../core/memory.mjs')
    const r = mem0.record(cfg0, { ...weak, score: mem0.qualityScore(weak) })
    assert.equal(r.action, 'REJECT', '无锚 open_thread 的质量分必须低于 summary 门槛 0.45')
  }
  // meter 有 memory 事件
  const mem = readMeterEvents(lcmRoot, 'memory')
  assert.ok(mem.length >= 3)
  // 重放同一 summary：全部幂等，不重复入库
  emitSessionEvent(ctx, session, SUMMARY_EVENT)
  assert.equal(activeEntries(lcfg(lcmRoot)).length, live.length, '重放必须幂等')
})

test('记忆注入臂 active：请求尾部追加 plugin 消息 + digest 节流', async () => {
  const ctx = fakeCtx()
  const lcmRoot = mkdtempSync(join(tmpdir(), 'lcm-meminj-'))
  applyT(ctx, { mode: 'active', lcmRoot, memoryInjectMode: 'active' })
  const { record } = await import('../../../core/memory.mjs')
  record(lcfg(lcmRoot), { type: 'fact', subject: '记忆库根', claim: '记忆统一存 ~/.lcm/memories，按类型分文件' })
  record(lcfg(lcmRoot), { type: 'decision', subject: '记忆同步', claim: '配置 OpenViking 后记忆双写同步到云端副本' })

  const session = fakeSession(lcmRoot, [])
  session.header = { ...session.header }
  const base = {
    kind: 'run',
    messages: [
      { role: 'user', content: [{ type: 'text', text: '记忆库 存在哪里，同步策略是什么' }], source: { kind: 'user' } },
    ],
  }
  const out = await runPreStepWithDecision(ctx, session, base)
  assert.equal(out.messages.length, 2, '应尾部追加一条注入消息')
  const injected = out.messages[1]
  assert.equal(injected.role, 'user')
  assert.equal(injected.source.kind, 'plugin')
  assert.equal(injected.source.plugin, 'dsh-lcm')
  assert.equal(injected.source.form, 'snapshot')
  assert.ok(injected.content[0].text.startsWith('<lcm-memory query="'))
  assert.ok(injected.content[0].text.includes('记忆库根'))
  assert.equal(out.messages[0], base.messages[0], '原消息数组不得被改动')

  // meter 记账
  const inj = readMeterEvents(lcmRoot, 'memory-inject')
  assert.equal(inj.length, 1)
  assert.equal(inj[0].mode, 'active')

  // digest 节流：同样条目再跑一次 pre-step → 不重复注入
  const out2 = await runPreStepWithDecision(ctx, session, { ...base, messages: [...base.messages] })
  assert.equal(out2.messages.length, 1, '记忆未变化时不得重复注入')
  assert.equal(readMeterEvents(lcmRoot, 'memory-inject').length, 1)
})

test('记忆注入臂 shadow：decision 原样返回，只记账', async () => {
  const ctx = fakeCtx()
  const lcmRoot = mkdtempSync(join(tmpdir(), 'lcm-meminj-s-'))
  applyT(ctx, { mode: 'active', lcmRoot, memoryInjectMode: 'shadow' })
  const { record } = await import('../../../core/memory.mjs')
  record(lcfg(lcmRoot), { type: 'fact', subject: '注入纪律', claim: '注入块只能尾部追加，绝不插中间破坏前缀缓存' })
  const session = fakeSession(lcmRoot, [])
  const base = {
    kind: 'run',
    messages: [
      { role: 'user', content: [{ type: 'text', text: '注入 纪律 尾部追加是什么规则' }], source: { kind: 'user' } },
    ],
  }
  const out = await runPreStepWithDecision(ctx, session, base)
  assert.equal(out.messages.length, 1, 'shadow 不得改写 messages')
  assert.equal(readMeterEvents(lcmRoot, 'memory-inject')[0].mode, 'shadow')
})

test('记忆注入臂：无真实用户消息（全是插件注入）→ 不检索不注入', async () => {
  const ctx = fakeCtx()
  const lcmRoot = mkdtempSync(join(tmpdir(), 'lcm-meminj-nq-'))
  applyT(ctx, { mode: 'active', lcmRoot, memoryInjectMode: 'active' })
  const { record } = await import('../../../core/memory.mjs')
  record(lcfg(lcmRoot), { type: 'fact', subject: 's', claim: '一条足以被检索到的记忆条目内容样例' })
  const session = fakeSession(lcmRoot, [])
  const base = {
    kind: 'run',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'plugin snapshot' }], source: { kind: 'plugin', plugin: 'other' } }],
  }
  const out = await runPreStepWithDecision(ctx, session, base)
  assert.equal(out.messages.length, 1)
  assert.equal(readMeterEvents(lcmRoot, 'memory-inject').length, 0, '无查询不得记账')
})

// ---------------------------------------------------------------- 画像常驻注入

test('画像块常驻注入：有缓存时即使无检索命中（甚至无查询）也注入 <lcm-profile>', async () => {
  const ctx = fakeCtx()
  const lcmRoot = mkdtempSync(join(tmpdir(), 'lcm-profinj-'))
  applyT(ctx, { mode: 'active', lcmRoot, memoryInjectMode: 'active' })
  // 预置画像缓存（适配器热路径只读缓存，绝不在线扫描）
  mkdirSync(join(lcmRoot, '.lcm'), { recursive: true })
  writeFileSync(join(lcmRoot, '.lcm', 'profile.json'), JSON.stringify({
    builtAt: Date.now(),
    habit: { sessions: 9, talks: 90, confirmRate: 0.3, openers: { 确认: 5 }, topChain: '理解→行动', phrases: [['你能理解吗', 7]], terms: [] },
    behavior: { requests: 100, peakHours: '10点+17点', attention: ['lcm 60%'], sessionMedian: 3, deepSessions: 2 },
  }))

  // 场景 1：无记忆库命中，但 profile 存在 → 仍注入
  const session1 = fakeSession(lcmRoot, [])
  const out1 = await runPreStepWithDecision(ctx, session1, {
    kind: 'run',
    messages: [{ role: 'user', content: [{ type: 'text', text: '一个全新话题' }], source: { kind: 'user' } }],
  })
  assert.equal(out1.messages.length, 2, 'profile 常驻：无检索命中也要注入')
  assert.ok(out1.messages[1].content[0].text.includes('<lcm-profile>'))
  assert.ok(out1.messages[1].content[0].text.includes('协作习惯'))
  assert.equal(out1.messages[1].source.plugin, 'dsh-lcm')

  // 场景 2：另一个会话、连查询都没有（全是插件消息）→ profile 仍常驻。
  // （同一会话内重复注入被 digest 节流——那是设计行为，上一场景已覆盖）
  const session2 = { ...session1, header: { ...session1.header, id: 'sess-profile-2' } }
  const out2 = await runPreStepWithDecision(ctx, session2, {
    kind: 'run',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'plugin snapshot' }], source: { kind: 'plugin', plugin: 'other' } }],
  })
  assert.equal(out2.messages.length, 2)
  assert.ok(out2.messages[1].content[0].text.startsWith('<lcm-profile>'))

  // meter 记账带 profile 标记
  const inj = readMeterEvents(lcmRoot, 'memory-inject')
  assert.equal(inj.length, 2)
  assert.ok(inj.every((e) => e.profile === true))

  // digest 节流：profile + 检索内容都没变 → 不重复注入
  const out3 = await runPreStepWithDecision(ctx, session1, {
    kind: 'run',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'plugin snapshot' }], source: { kind: 'plugin', plugin: 'other' } }],
  })
  assert.equal(out3.messages.length, 1, '内容未变不得重复注入')
})

test('画像热路径纪律：无缓存时不注入不阻塞（allowScan:false 的意义）', async () => {
  const ctx = fakeCtx()
  const lcmRoot = mkdtempSync(join(tmpdir(), 'lcm-profinj-n-'))
  applyT(ctx, { mode: 'active', lcmRoot, memoryInjectMode: 'active' })
  const session = fakeSession(lcmRoot, [])
  const out = await runPreStepWithDecision(ctx, session, {
    kind: 'run',
    messages: [{ role: 'user', content: [{ type: 'text', text: '任意内容' }], source: { kind: 'user' } }],
  })
  assert.equal(out.messages.length, 1, '无画像缓存、无记忆命中 → 原样放行')
})

// ---------------------------------------------------------------- 增量熔炼臂

function userMsgEvent(text, kind = 'user') {
  return { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text }], source: { kind } } }
}
function assistantMsgEvent(text) {
  return { type: 'assistant/message', data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text }] } } }
}

test('增量熔炼臂：水位线只扫新增轮次，过滤插件注入与 harness 模板', async () => {
  const ctx = fakeCtx()
  const lcmRoot = mkdtempSync(join(tmpdir(), 'lcm-incr-'))
  applyT(ctx, { mode: 'active', lcmRoot })
  const session = fakeSession(lcmRoot, [
    userMsgEvent('插件注入的上下文不该被熔炼 source 是 plugin', 'plugin'),       // seq1 过滤
    userMsgEvent('Review the inherited completed checkpoint now.'),            // seq2 harness 模板过滤
    userMsgEvent('我们决定：记忆臂搭 DSH 内置 summary 便车，零 LLM 调用，v1.2 上线'),  // seq3 入库
    assistantMsgEvent('- 实测：增量提取窗口比 summary 覆盖率高 92%，benchmark 在 core/meter.mjs'), // seq4 入库
  ])
  await runPreStep(ctx, session)

  const { activeEntries } = await import('../../../core/memory.mjs')
  const live = activeEntries(lcfg(lcmRoot))
  assert.ok(live.length >= 2, `应入库 ≥2 条（实际 ${live.length}）`)
  assert.ok(live.every((e) => e.source === 'incremental'))
  assert.ok(live.some((e) => e.type === 'decision'), '决定句入库')
  assert.ok(!live.some((e) => e.claim.includes('插件注入的上下文')), '插件注入不得入库')
  assert.ok(!live.some((e) => e.claim.includes('checkpoint')), 'harness 模板不得入库')

  // 水位线推进：同样的消息再跑一次 → 零新增（不再扫描，更不改库）
  const before = readFileSync(join(lcmRoot, '.lcm', 'memories', 'memories.jsonl'), 'utf8')
  await runPreStep(ctx, session)
  assert.equal(readFileSync(join(lcmRoot, '.lcm', 'memories', 'memories.jsonl'), 'utf8'), before, '水位线后重扫不得产生任何写入')
})

test('增量熔炼臂：水位线持久化——重启（新 apply）后不重复处理', async () => {
  const lcmRoot = mkdtempSync(join(tmpdir(), 'lcm-incr-wm-'))
  const ctx1 = fakeCtx()
  applyT(ctx1, { mode: 'active', lcmRoot })
  const session = fakeSession(lcmRoot, [
    userMsgEvent('决定：采用 outbox 模式做 OpenViking 同步，v2.0 前上线'),
  ])
  await runPreStep(ctx1, session)
  const { activeEntries } = await import('../../../core/memory.mjs')
  const live1 = activeEntries(lcfg(lcmRoot))
  assert.ok(live1.length >= 1)
  // 水位线文件存在
  const wm = JSON.parse(readFileSync(join(lcmRoot, '.lcm', 'extract-watermark.json'), 'utf8'))
  assert.ok(wm['sess-prune'].seq >= 1, '水位线必须持久化（{seq, distilled} 格式）')
  assert.ok(Array.isArray(wm['sess-prune'].distilled), '已蒸馏 seq 随水位线一起持久化（折叠依据）')

  // 「重启」：新 apply（新 Map），同会话同消息 → 从文件恢复水位线，零新写入
  const ctx2 = fakeCtx()
  applyT(ctx2, { mode: 'active', lcmRoot })
  const before = readFileSync(join(lcmRoot, '.lcm', 'memories', 'memories.jsonl'), 'utf8')
  await runPreStep(ctx2, session)
  assert.equal(readFileSync(join(lcmRoot, '.lcm', 'memories', 'memories.jsonl'), 'utf8'), before,
    '重启后水位线恢复，不得重复熔炼')
})

test('增量熔炼臂：无新增轮次零副作用；关闭开关后完全停用', async () => {
  const lcmRoot = mkdtempSync(join(tmpdir(), 'lcm-incr-off-'))
  const ctx = fakeCtx()
  applyT(ctx, { mode: 'active', lcmRoot, memoryExtractIncremental: false })
  const session = fakeSession(lcmRoot, [
    userMsgEvent('决定：这条本来该入库的内容因为开关关闭而不能入库 v9.9'),
  ])
  await runPreStep(ctx, session)
  assert.ok(!existsSync(join(lcmRoot, '.lcm', 'memories')), '开关关闭不得产生记忆库')
})

// ---------------------------------------------------------------- warm folding 折叠臂

// 可产出条目的长文本（含量化信号与路径 → 过增量熔炼的质量门槛）：
// 折叠的前提是「该轮确实产出了记忆条目」，纯长文本（无信号）不该被折叠——测试锁这条
const DISTILL = '决定：折叠臂只折已蒸馏轮次，阈值 120 字符（依据 core/memory.mjs 分位数据），v0.3 上线。'
const LONG_A = DISTILL + '补充：' + '内容填充用于超过长度门槛，同时保持可提取的信号密度。'.repeat(6)
const LONG_B = DISTILL + '回复：' + '助手侧的详细展开说明，含数据与结论，用于验证折叠保护集。'.repeat(6)
const PLAIN_LONG = '这是一条足够长但没有任何可提取信号的普通文本，不应该被折叠。'.repeat(12)

function foldSession(lcmRoot, n = 8) {
  const entries = []
  for (let i = 0; i < n; i++) entries.push(i % 2 === 0 ? userMsgEvent(LONG_A + i) : assistantMsgEvent(LONG_B + i))
  return fakeSession(lcmRoot, entries)
}

test('折叠臂 shadow（默认）：冷窗口记账但不替换 surface', async () => {
  const ctx = fakeCtx()
  const lcmRoot = mkdtempSync(join(tmpdir(), 'lcm-fold-sh-'))
  applyT(ctx, { mode: 'active', lcmRoot })
  withTokenMeter(ctx, 150_000)
  const session = foldSession(lcmRoot)
  await runPreStep(ctx, session)                                  // 建熔炼水位线 + 已蒸馏 seq
  emitSessionEvent(ctx, session, { type: 'compaction/basic' })    // 打开冷窗口
  await runPreStep(ctx, session)
  const folds = readMeterEvents(lcmRoot, 'fold')
  assert.equal(folds.length, 1, '冷窗口应记一次 fold')
  assert.equal(folds[0].mode, 'shadow')
  assert.equal(folds[0].nodes, 4, '8 轮 - 最新 4 轮 = 可折 4 轮')
  assert.ok(folds[0].savedTokens > 0)
  assert.equal(session.appends.length, 0, 'shadow 不得改写 surface')
})

test('折叠臂 active：指针行替换 + 最新 4 轮保留 + 短消息与插件消息不折', async () => {
  const ctx = fakeCtx()
  const lcmRoot = mkdtempSync(join(tmpdir(), 'lcm-fold-act-'))
  applyT(ctx, { mode: 'active', lcmRoot, foldMode: 'active' })
  withTokenMeter(ctx, 150_000)
  const entries = [
    userMsgEvent(LONG_A + '一'),                    // seq1 可折
    assistantMsgEvent(LONG_B + '二'),               // seq2 可折
    userMsgEvent('短消息'),                          // seq3 太短不折
    userMsgEvent(LONG_A + '插件注入版本', 'plugin'),  // seq4 插件消息不折
    assistantMsgEvent(LONG_B + '五'),                // seq5 可折
    userMsgEvent(LONG_A + '六'),                    // seq6 可折
    assistantMsgEvent(LONG_B + '七'), userMsgEvent(LONG_A + '八'),  // seq7-10 最新 4 轮保留
    assistantMsgEvent(LONG_B + '九'), userMsgEvent(LONG_A + '十'),
  ]
  const session = fakeSession(lcmRoot, entries)
  await runPreStep(ctx, session)                                  // 水位线 = 10
  emitSessionEvent(ctx, session, { type: 'compaction/basic' })
  await runPreStep(ctx, session)

  const foldAppends = session.appends.filter((a) => a.opts?.surfaceOp?.op === 'replace')
  assert.equal(foldAppends.length, 4, 'seq 1/2/5/6 应折叠（3 太短、4 插件、7-10 保留）')
  const foldedSeqs = foldAppends.map((a) => a.opts.surfaceOp.start).sort((a, b) => a - b)
  assert.deepEqual(foldedSeqs, [1, 2, 5, 6])
  for (const a of foldAppends) {
    const text = a.type === 'user/message' ? a.data.content[0].text : a.data.message.content[0].text
    assert.ok(/^\[轮 \d+·(user|assistant) 已蒸馏至记忆库/.test(text), '必须是指针行')
    if (a.type === 'user/message') {
      assert.equal(a.data.source.kind, 'plugin', '指针行不得伪装成真人消息（防熔炼/检索误回收）')
    }
  }
  const fold = readMeterEvents(lcmRoot, 'fold')[0]
  assert.equal(fold.mode, 'active')
  assert.equal(fold.nodes, 4)
  // 折叠后重跑：surface 上已是指针行（<200 chars）→ 零可折对象 → 不再重复折叠、
  // 也不记账（无操作不产生噪音事件）
  emitSessionEvent(ctx, session, { type: 'compaction/basic' })
  await runPreStep(ctx, session)
  assert.equal(readMeterEvents(lcmRoot, 'fold').length, 1, '无可折对象的冷窗口不得记账')
  assert.equal(session.appends.filter((a) => a.opts?.surfaceOp?.op === 'replace').length, 4, '不得二次替换')
})

test('折叠臂安全默认：熔炼臂关闭（无水位线）→ 冷窗口也不折叠', async () => {
  const ctx = fakeCtx()
  const lcmRoot = mkdtempSync(join(tmpdir(), 'lcm-fold-off-'))
  applyT(ctx, { mode: 'active', lcmRoot, foldMode: 'active', memoryExtractIncremental: false })
  withTokenMeter(ctx, 150_000)
  const session = foldSession(lcmRoot)
  await runPreStep(ctx, session)
  emitSessionEvent(ctx, session, { type: 'compaction/basic' })
  await runPreStep(ctx, session)
  assert.equal(readMeterEvents(lcmRoot, 'fold').length, 0, '无水位线 = 无蒸馏依据 = 绝不折叠')
  assert.equal(session.appends.length, 0)
})
