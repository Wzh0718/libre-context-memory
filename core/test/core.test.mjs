/** core 层测试：spill 卫生策略 / 计量轮转 / 会话日志兜底恢复。
 * 运行：node --test core/test/*.test.mjs
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadConfig } from '../config.mjs'
import * as spill from '../spill.mjs'
import * as meter from '../meter.mjs'
import { recoverByHandle, sessionLogFiles } from '../recover.mjs'

function makeCfg(over = {}) {
  const root = mkdtempSync(join(tmpdir(), 'lcm-core-'))
  return { ...loadConfig(root), ...over }
}

const BIG_TEXT = ('2026-09-11T01:00:00Z INFO worker processing item\n').repeat(2_000)

test('spill：压缩落盘 + 读取往返一致', () => {
  const cfg = makeCfg()
  const ref = spill.put(cfg, BIG_TEXT)
  assert.ok(ref.path.endsWith('.br'), '应走 brotli 压缩存储')
  assert.ok(ref.bytes < Buffer.byteLength(BIG_TEXT, 'utf8') / 2, '压缩后应显著小于原文')
  const got = spill.read(cfg, ref.spillId)
  assert.equal(got.text, BIG_TEXT, '读取必须与原文逐字节一致')
})

test('spill：内容寻址去重（同内容不写第二份）', () => {
  const cfg = makeCfg()
  const a = spill.put(cfg, BIG_TEXT)
  const b = spill.put(cfg, BIG_TEXT)
  assert.equal(a.path, b.path)
  assert.equal(readdirSync(cfg.spillDir).length, 1)
})

test('spill：中文/多字节文本往返无损（按 code point 计）', () => {
  const cfg = makeCfg()
  const text = ('决策：把压缩放在入库时刻，而不是定时。\n' + '日志行 🚀 emoji 测试\n').repeat(500)
  const ref = spill.put(cfg, text)
  const got = spill.read(cfg, ref.spillId)
  assert.equal(got.text, text)
  assert.equal(ref.chars, [...text].length)
})

test('spill：TTL 清扫删除陈旧文件，保留新文件', () => {
  const cfg = makeCfg({ spillTtlDays: 30 })
  const oldRef = spill.put(cfg, BIG_TEXT + 'old')
  const newRef = spill.put(cfg, BIG_TEXT + 'new')
  spill.touchAge(oldRef.path, 31 * 24 * 60 * 60 * 1000)
  const r = spill.sweep(cfg)
  assert.equal(r.removed, 1)
  assert.equal(r.reason, 'ttl')
  assert.equal(existsSync(oldRef.path), false)
  assert.equal(existsSync(newRef.path), true)
})

test('spill：容量上限按最旧优先清理', () => {
  const cfg = makeCfg({ spillTtlDays: 0 })
  const refs = []
  for (let i = 0; i < 4; i++) {
    const ref = spill.put(cfg, BIG_TEXT + `chunk-${i}`)
    // 人为拉开 mtime，确定「最旧」顺序
    spill.touchAge(ref.path, (4 - i) * 60 * 60 * 1000)
    refs.push(ref)
  }
  const total = spill.usage(cfg).bytes
  cfg.spillMaxBytes = Math.floor(total / 2)     // 压到一半
  const r = spill.sweep(cfg)
  assert.ok(r.removed >= 1)
  assert.equal(r.reason, 'cap')
  assert.ok(spill.usage(cfg).bytes <= cfg.spillMaxBytes)
  assert.equal(existsSync(refs[0].path), false, '最旧的应被删除')
  assert.equal(existsSync(refs[3].path), true, '最新的应保留')
})

test('spill：写入节流后自动触发清扫（maybeSweep）', () => {
  const cfg = makeCfg({ spillTtlDays: 1 })
  spill.resetSweepThrottle()
  let swept = null
  for (let i = 0; i < 21; i++) {
    const ref = spill.put(cfg, BIG_TEXT + `auto-${i}`)
    if (i < 20) spill.touchAge(ref.path, 2 * 24 * 60 * 60 * 1000)
    if (ref.sweep) swept = ref.sweep
  }
  assert.ok(swept, '第 20 次写入应触发清扫')
  assert.ok(swept.removed > 0)
})

test('meter：按月轮转 + 汇总读取多文件（兼容旧单文件）', () => {
  const cfg = makeCfg()
  const july = new Date('2026-07-15T00:00:00Z')
  const august = new Date('2026-08-15T00:00:00Z')
  meter.record({ ...cfg, meterMonthly: true }, { kind: 'usage', input: 10, cacheRead: 90, fresh: 10 })
  const julyPath = meter.meterPathFor(cfg, july)
  const augustPath = meter.meterPathFor(cfg, august)
  assert.ok(julyPath.endsWith('meter-202607.jsonl'))
  assert.ok(augustPath.endsWith('meter-202608.jsonl'))
  // 旧版单文件也要被读到
  writeFileSync(cfg.meterFile, JSON.stringify({ ts: Date.now(), kind: 'usage', input: 5, cacheRead: 45, fresh: 5 }) + '\n')
  const s = meter.summary(cfg)
  assert.equal(s.usage.requests, 2, '轮转文件 + 旧单文件都要计入')
  assert.equal(s.files.length, 2)
})

test('compare：反事实对比与击穿归因（只在真剪枝/真压缩时计入治理量）', async () => {
  const cfg = makeCfg()
  const base = { sessionId: 's1' }
  // 三次请求：前两次缓存命中良好，第三次是剪枝引起的击穿
  meter.record(cfg, { kind: 'usage', ...base, fresh: 200, cacheRead: 100_000 })
  meter.record(cfg, { kind: 'usage', ...base, fresh: 300, cacheRead: 120_000 })
  // shadow 剪枝不算治理量
  meter.record(cfg, { kind: 'prune', ...base, mode: 'shadow', charsBefore: 90_000, charsAfter: 10_000 })
  meter.record(cfg, { kind: 'usage', ...base, fresh: 250, cacheRead: 130_000 })
  // active 剪枝 → 随后一次请求应被判为 lcm 引起的击穿
  meter.record(cfg, { kind: 'prune', ...base, mode: 'active', charsBefore: 100_000, charsAfter: 20_000 })
  meter.record(cfg, { kind: 'usage', ...base, fresh: 200_000, cacheRead: 10_000 })

  const { compare } = await import('../compare.mjs')
  const c = compare(cfg)
  assert.equal(c.requests, 4)
  assert.equal(c.savings.trimmedEvents, 1, '只有 active 剪枝计入治理量')
  assert.equal(c.savings.trimmedTokensTotal, 40_000, '(100,000-20,000)/2')
  // 反事实：只有最后一次请求带着 40k 已治理 tokens（前三次发生治理之前）
  assert.equal(c.counterfactual.cached - c.actual.cached, 40_000, '最后一次请求应多带 40k tokens')
  // 事实账户
  assert.equal(c.actual.fresh, 200_750)
  assert.equal(c.busts.count, 1)
  assert.equal(c.busts.lcmCount, 1, '击穿应归因于 lcm 剪枝')
  assert.equal(Math.round(c.busts.lcmExtraEquivalent), Math.round(200_000 * 0.9))
  assert.equal(c.net.breakevenRequests, Math.ceil((200_000 * 0.9) / (40_000 * 0.1)))
  assert.ok(c.net.equivalent < c.savings.equivalent, '净收益必须扣掉击穿成本')
})

test('compare：无 usage 数据时如实返回空结果', async () => {
  const cfg = makeCfg()
  const { compare } = await import('../compare.mjs')
  assert.equal(compare(cfg).requests, 0)
})

test('recover：从会话日志找回被剪枝替换的原文', async () => {
  const cfg = makeCfg()
  const original = 'ORIGINAL-TOOL-OUTPUT ' + 'x'.repeat(50_000)
  const handle = 'spill:abcdef123456'
  const sessionsDir = mkdtempSync(join(tmpdir(), 'lcm-sess-'))
  const projDir = join(sessionsDir, '--home-libre-project--', 'session-abc')
  const { mkdirSync } = await import('node:fs')
  mkdirSync(projDir, { recursive: true })
  const lines = [
    { type: 'session', seq: 0, data: {} },
    // 原始 tool/result（被剪的那个）
    { type: 'tool/result', seq: 42, data: { message: { content: [{ role: 'tool', content: [{ type: 'text', text: original }] }] } } },
    // 影价事件：记录被剪 seq
    { type: 'compaction/prune', seq: 43, data: { shadowedSeqs: [42], shadowedTokenCount: 100 } },
    // 替换事件：内容里带句柄
    { type: 'tool/result', seq: 44, sourceEventSeqs: [42], data: { message: { content: [{ role: 'tool', content: [{ type: 'text', text: `[归档] ${handle} 摘要…` }] }] } } },
  ]
  writeFileSync(join(projDir, 'session.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')

  assert.equal(sessionLogFiles(sessionsDir).length, 1)
  const r = recoverByHandle(handle, { sessionsDir })
  assert.equal(r.found, true)
  assert.equal(r.shadowedSeq, 42)
  assert.equal(r.text, original, '必须精确恢复原文')
})

test('recover：句柄不存在时如实报告未找到', async () => {
  const sessionsDir = mkdtempSync(join(tmpdir(), 'lcm-sess-empty-'))
  const r = recoverByHandle('spill:000000000000', { sessionsDir })
  assert.equal(r.found, false)
  assert.ok(r.reason)
})

test('recover：非法句柄直接拒绝', async () => {
  const r = recoverByHandle('not-a-handle', { sessionsDir: tmpdir() })
  assert.equal(r.found, false)
  assert.equal(r.reason, 'invalid handle')
})

test('recover：多帧 zstd 会话日志也能读（真实 DSH 格式）', async () => {
  const { createZstdCompress } = await import('node:zlib')
  const { pipeline } = await import('node:stream/promises')
  const { Readable } = await import('node:stream')
  const sessionsDir = mkdtempSync(join(tmpdir(), 'lcm-sess-zstd-'))
  const projDir = join(sessionsDir, '--proj--', 'session-z')
  const { mkdirSync } = await import('node:fs')
  mkdirSync(projDir, { recursive: true })
  const original = 'ZSTD-ORIGINAL ' + 'y'.repeat(10_000)
  const frames = [
    JSON.stringify({ type: 'session', seq: 0 }),
    JSON.stringify({ type: 'tool/result', seq: 7, data: { message: { content: [{ type: 'text', text: original }] } } }),
    JSON.stringify({ type: 'tool/result', seq: 8, sourceEventSeqs: [7], data: { message: { content: [{ type: 'text', text: '[归档] spill:123456abcdef' }] } } }),
  ]
  const chunks = []
  for (const frame of frames) {
    const comp = createZstdCompress()
    const parts = []
    comp.on('data', (c) => parts.push(c))
    const done = new Promise((res) => comp.on('end', res))
    comp.end(frame + '\n')
    await done
    chunks.push(Buffer.concat(parts))
  }
  writeFileSync(join(projDir, 'session.jsonl.zstd'), Buffer.concat(chunks))   // 逐帧追加 = 多帧

  const r = recoverByHandle('spill:123456abcdef', { sessionsDir })
  assert.equal(r.found, true)
  assert.equal(r.text, original)
})
