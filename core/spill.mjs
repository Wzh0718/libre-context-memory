/** spill 存储（Node 版）：内容寻址 + 压缩落盘 + 卫生策略（TTL/容量上限）+ 双后端。
 *
 * 设计要点：
 * - hash 跨后端一致 → local → viking 回填时 spill ID 不变
 * - 本地后端：<root>/.lcm/spill/<hash>.txt.br（brotli 压缩，这类文本实测压 3~5×）；
 *   压缩失败则退化为 <hash>.txt 明文——绝不因为压缩问题丢掉原文
 * - 卫生策略：写入时机会性清扫（TTL + 容量上限，最旧优先），每次写入后记录计量
 * - viking 后端为预留接口（未接 HTTP API），配置后暂走本地缓存目录并标记 backend=viking
 */

import { createHash } from 'node:crypto'
import { brotliCompressSync, brotliDecompressSync, constants as zlibConstants } from 'node:zlib'
import {
  existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

export const SPILL_ID_RE = /^spill:([0-9a-f]{12,64})$/

/** 机会性清扫节流：进程内最多每 N 次写入/每 intervalMs 扫一次目录。 */
const SWEEP_EVERY_WRITES = 20
const SWEEP_MIN_INTERVAL_MS = 10 * 60 * 1000
let sweepState = { writes: 0, lastSweepAt: 0 }

export function digestOf(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** brotli 压缩文本；失败返回 null（调用方退化明文）。 */
function compressText(text) {
  try {
    return brotliCompressSync(Buffer.from(text, 'utf8'), {
      params: {
        [zlibConstants.BROTLI_PARAM_QUALITY]: 5,
        [zlibConstants.BROTLI_PARAM_SIZE_HINT]: Buffer.byteLength(text, 'utf8'),
      },
    })
  } catch {
    return null
  }
}

/** 按扩展名解码 spill 文件内容（.br = brotli，其余明文）。 */
export function decodeSpill(path) {
  return path.endsWith('.br')
    ? brotliDecompressSync(readFileSync(path)).toString('utf8')
    : readFileSync(path, 'utf8')
}

export function put(cfg, text) {
  const digest = digestOf(text)
  const backend = cfg.openvikingConfigured ? 'viking' : 'local'
  // TODO(phase≥1): viking 后端上传 viking://resources/spill/<project>/<hash>.txt
  // （processing_mode=vectors_only / no_split，不参与语义索引）；当前统一落本地。
  mkdirSync(cfg.spillDir, { recursive: true })

  const packed = compressText(text)
  const path = packed === null
    ? join(cfg.spillDir, `${digest}.txt`)
    : join(cfg.spillDir, `${digest}.txt.br`)
  let bytes = packed === null ? Buffer.byteLength(text, 'utf8') : packed.length
  // 内容寻址：同内容只写一次（跨会话去重）
  if (!existsSync(path)) {
    if (packed === null) writeFileSync(path, text, 'utf8')
    else writeFileSync(path, packed)
  } else {
    try { bytes = statSync(path).size } catch { /* 读取失败按本次估算 */ }
  }

  const sweep = maybeSweep(cfg)
  return {
    spillId: `spill:${digest.slice(0, 12)}`,
    digest,
    backend,
    path,
    bytes,
    compressed: packed !== null,
    chars: [...text].length,
    lines: text.length ? text.split('\n').length : 0,
    sweep,
  }
}

/** 目录用量统计：{ files, bytes }。 */
export function usage(cfg) {
  if (!existsSync(cfg.spillDir)) return { files: 0, bytes: 0 }
  let files = 0
  let bytes = 0
  for (const name of readdirSync(cfg.spillDir)) {
    if (!name.endsWith('.txt') && !name.endsWith('.txt.br')) continue
    try {
      bytes += statSync(join(cfg.spillDir, name)).size
      files++
    } catch { /* 竞争删除：忽略 */ }
  }
  return { files, bytes }
}

/**
 * 清扫：TTL 过期 + 容量超限（最旧优先）。只删 spill 原文；
 * 摘要/锚点仍在上下文里，且原始事件仍在 DSH 会话日志中（可用 `lcm recover` 找回）。
 * @returns {{removed:number, freedBytes:number, bytes:number, reason:string|null}}
 */
export function sweep(cfg, { now = Date.now(), force = false } = {}) {
  const result = { removed: 0, freedBytes: 0, bytes: 0, reason: null }
  if (!existsSync(cfg.spillDir)) return result
  const entries = []
  for (const name of readdirSync(cfg.spillDir)) {
    if (!name.endsWith('.txt') && !name.endsWith('.txt.br')) continue
    const path = join(cfg.spillDir, name)
    try {
      const st = statSync(path)
      entries.push({ path, size: st.size, mtimeMs: st.mtimeMs })
    } catch { /* 竞争删除：忽略 */ }
  }
  entries.sort((a, b) => a.mtimeMs - b.mtimeMs)      // 最旧优先
  const ttlMs = (cfg.spillTtlDays ?? 30) * 24 * 60 * 60 * 1000
  const cap = cfg.spillMaxBytes ?? 512 * 1024 * 1024

  const doomed = new Set()
  if (ttlMs > 0) {
    for (const e of entries) {
      if (now - e.mtimeMs > ttlMs) { doomed.add(e.path); result.reason = 'ttl' }
    }
  }
  let liveBytes = entries.filter((e) => !doomed.has(e.path)).reduce((a, e) => a + e.size, 0)
  if (liveBytes > cap) {
    for (const e of entries) {
      if (liveBytes <= cap) break
      if (doomed.has(e.path)) continue
      doomed.add(e.path)
      liveBytes -= e.size
      result.reason = result.reason === 'ttl' ? 'ttl+cap' : 'cap'
    }
  }
  if (force && doomed.size === 0 && cfg.spillTtlDays === 0 && liveBytes <= cap) result.reason = null

  for (const e of entries) {
    if (!doomed.has(e.path)) continue
    try {
      rmSync(e.path, { force: true })
      result.removed++
      result.freedBytes += e.size
      liveBytes -= e.size
    } catch { /* 删除失败：留待下次 */ }
  }
  result.bytes = Math.max(0, liveBytes)
  return result
}

/** 机会性清扫：节流后执行；返回本次统计或 null（未触发）。 */
export function maybeSweep(cfg) {
  sweepState.writes++
  const now = Date.now()
  const dueByWrites = sweepState.writes >= SWEEP_EVERY_WRITES
  const dueByTime = now - sweepState.lastSweepAt >= SWEEP_MIN_INTERVAL_MS
  if (!dueByWrites && !dueByTime) return null
  sweepState.writes = 0
  sweepState.lastSweepAt = now
  return sweep(cfg, { now })
}

/** 测试用：重置清扫节流状态。 */
export function resetSweepThrottle() {
  sweepState = { writes: 0, lastSweepAt: 0 }
}

export function resolve(cfg, spillId) {
  const m = SPILL_ID_RE.exec(String(spillId).trim())
  if (!m) return null
  const prefix = m[1]
  for (const dir of [cfg.spillDir, join(cfg.localDir, 'spill-cache')]) {
    if (!existsSync(dir)) continue
    for (const f of readdirSync(dir)) {
      const isSpill = f.endsWith('.txt') || f.endsWith('.txt.br')
      if (!isSpill || !f.startsWith(prefix)) continue
      const path = join(dir, f)
      const text = decodeSpill(path)
      const digest = f.replace(/\.txt(\.br)?$/, '')
      return {
        spillId: `spill:${digest.slice(0, 12)}`,
        digest,
        backend: cfg.openvikingConfigured ? 'viking' : 'local',
        path,
        chars: [...text].length,
        lines: text.split('\n').length,
      }
    }
  }
  return null
}

/** 读取句柄原文（供 CLI read 使用）；找不到返回 null。 */
export function read(cfg, spillId) {
  const found = resolve(cfg, spillId)
  if (found === null) return null
  return { ...found, text: decodeSpill(found.path) }
}

/** 测试辅助：把文件 mtime 设到过去（模拟陈旧文件）。 */
export function touchAge(path, ageMs) {
  const t = (Date.now() - ageMs) / 1000
  utimesSync(path, t, t)
}
