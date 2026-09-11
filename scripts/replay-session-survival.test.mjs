/** 会话存活验证：用 DSH **自己的** foldSurface 回放含 lcm 替换事件的日志。
 *
 * 这是在切 active 之前必须过的一关：如果我们的 surface 替换不满足 DSH 的
 * 校验规则，会话在重启/恢复时会加载失败（= 会话「死掉」）。
 *
 * 校验来源（packages/core/session/src/surface.ts）：
 * - shadowedSeqs 必须恰好一个，且指向当前 surface 上的 tool/result
 * - 替换事件与原事件**只能差 content**（其余字段深比较必须相等）
 * - sourceEventSeqs 必须覆盖被替换的节点
 *
 * 运行：node --test scripts/replay-session-survival.test.mjs
 * 需要 DSH 源码已构建（packages/core/session/lib/index.js）。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

const HARNESS = process.env.DSH_SOURCE
  ?? '/home/libre/project/deepseek-harness'
const SESSION_LIB = resolve(HARNESS, 'packages/core/session/lib/index.js')

const skip = !existsSync(SESSION_LIB)
  ? '需要 DSH 源码构建产物（packages/core/session/lib/index.js）'
  : false

const ORIGINAL = 'LOG-ORIGINAL ' + 'z'.repeat(50_000)
const SUMMARY = '[归档] spill:abcdef123456 · 50,011 字符 · 压缩 3000×\n--- 摘要 ---\nINFO 行 ×20000'

/** 与 dsh-lcm 剪枝臂完全一致的替换事件形状。 */
function lcmEvents(seqBase = 0) {
  const originalResult = {
    role: 'tool',
    content: [{ type: 'text', text: ORIGINAL }],
    callId: 'call-1',
  }
  const replacementResult = { ...originalResult, content: [{ type: 'text', text: SUMMARY }] }
  return [
    { type: 'turn/start', seq: seqBase + 0, data: { turn: 1 } },
    { type: 'step/start', seq: seqBase + 1, data: { turn: 1, step: 1 } },
    {
      type: 'tool/result', seq: seqBase + 2, surfaceOp: 'append',
      data: { turn: 1, step: 1, message: { source: { callId: 'call-1', kind: 'tool' }, content: [originalResult] } },
    },
    // ↓ 我们剪枝臂写的两条（影价 + 紧邻替换）
    { type: 'compaction/prune', seq: seqBase + 3, data: { shadowedRange: { start: seqBase + 2, end: seqBase + 2 }, shadowedSeqs: [seqBase + 2], shadowedTokenCount: 20_000 } },
    {
      type: 'tool/result', seq: seqBase + 4,
      sourceEventSeqs: [seqBase + 2],
      surfaceOp: { op: 'replace', start: seqBase + 2, end: seqBase + 2 },
      data: { turn: 1, step: 1, message: { source: { callId: 'call-1', kind: 'tool' }, content: [replacementResult] } },
    },
    { type: 'step/end', seq: seqBase + 5, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: seqBase + 6, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
}

test('会话存活：DSH 折叠接受 lcm 的 surface 替换，且 surface 只留替换节点', { skip }, async () => {
  const { foldSurface } = await import(SESSION_LIB)
  const events = lcmEvents()
  const result = foldSurface(events)
  assert.equal(result.replacements.length, 1, '折叠应记录一次替换')
  const rep = result.replacements[0]
  assert.deepEqual(rep.shadowedSeqs, [2], '被替换的是原始 tool/result seq=2')
  assert.equal(rep.seq, 4, '替换事件自身 seq=4')
  // 关键：surface 上只剩替换节点（seq 4），原始节点（seq 2）已不在 surface
  assert.deepEqual([...result.nodes], [4], 'surface 应指向替换后的节点')
})

test('会话存活：模型可见内容是摘要，原文仍留在日志里（可恢复）', { skip }, async () => {
  const { foldSurface } = await import(SESSION_LIB)
  const events = lcmEvents()
  const result = foldSurface(events)
  const textAt = (seq) => {
    const parts = []
    const walk = (n) => {
      if (n === null || typeof n !== 'object') return
      if (Array.isArray(n)) { n.forEach(walk); return }
      if (n.type === 'text' && typeof n.text === 'string') parts.push(n.text)
      else for (const v of Object.values(n)) walk(v)
    }
    walk(events[seq]?.data)
    return parts.join('')
  }
  const visible = [...result.nodes].map(textAt).join('')
  assert.ok(visible.includes('spill:abcdef123456'), '模型可见内容里必须有句柄')
  assert.ok(!visible.includes(ORIGINAL), '原文不应出现在模型可见 surface 上')
  // append-only：原始事件仍在日志中 → `lcm recover` 能兜底
  assert.ok(textAt(2).includes(ORIGINAL), '原文必须仍在日志里（兜底恢复的前提）')
})

test('会话存活：折叠是确定性的（同日志两次折叠结果一致）', { skip }, async () => {
  const { foldSurface } = await import(SESSION_LIB)
  const a = foldSurface(lcmEvents())
  const b = foldSurface(lcmEvents())
  assert.equal(JSON.stringify(a.nodes), JSON.stringify(b.nodes))
})

test('会话存活：非法替换会被 DSH 当场拒绝（反向校验生效）', { skip }, async () => {
  const { foldSurface } = await import(SESSION_LIB)
  const events = lcmEvents()
  // 篡改：替换时顺手改了 message.source.callId（只允许改 content）
  events[4] = {
    ...events[4],
    data: { ...events[4].data, message: { ...events[4].data.message, source: { callId: 'DIFFERENT', kind: 'tool' } } },
  }
  assert.throws(() => foldSurface(events), /may change only content/, '校验必须挡住越界改写')
})

test('会话存活：不带 sourceEventSeqs 的替换会被拒绝', { skip }, async () => {
  const { foldSurface } = await import(SESSION_LIB)
  const events = lcmEvents()
  delete events[4].sourceEventSeqs
  assert.throws(() => foldSurface(events), /sourceEventSeqs/, '必须引用被替换的源事件')
})
