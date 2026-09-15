/** 兜底恢复：spill 原文丢失（清理/磁盘满/换机器）时，从 DSH 会话日志找回。
 *
 * 原理：剪枝只 **append 一条替换事件**，原始事件仍在会话日志里（append-only）。
 * 替换事件带 `sourceEventSeqs`（指向被替换的源 seq），紧邻的 `compaction/prune`
 * 影价事件带 `shadowedSeqs`；两者都能定位到原文所在的那个事件。
 *
 * 会话日志格式：<sessionsDir>/<项目目录>/<会话 id>/session.jsonl.zstd
 * —— **多帧 zstd**（每帧一次追加），必须流式解码，zstdDecompressSync 只解第一帧。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * 解多帧 zstd。DSH 会话日志是**逐次追加的多帧** zstd，而 node:zlib 的解码器
 * （sync 与 stream 皆然）只解第一帧 —— 实测确认，因此这里按魔数切帧后逐帧解。
 * @param buf - 完整文件内容。
 * @returns 全部帧拼接后的文本；帧边界不可信时退化为单帧解码。
 */
export function decompressZstdFrames(buf) {
  const offsets = []
  let i = buf.indexOf(ZSTD_MAGIC, 0)
  while (i !== -1) { offsets.push(i); i = buf.indexOf(ZSTD_MAGIC, i + 4) }
  if (offsets.length <= 1) return zstdDecompressSync(buf).toString('utf8')
  const parts = []
  for (const off of offsets) {
    try {
      parts.push(zstdDecompressSync(buf.subarray(off)).toString('utf8'))
    } catch { /* 压缩数据里偶然出现的伪魔数：跳过 */ }
  }
  return parts.join('')
}

/** 读取会话日志全文（.jsonl 明文 / .jsonl.zstd 多帧）。 */
export function readSessionLog(path) {
  const buf = readFileSync(path)
  return path.endsWith('.zstd') ? decompressZstdFrames(buf) : buf.toString('utf8')
}

/** 递归收集会话日志文件（.jsonl / .jsonl.zstd），按 mtime 从新到旧。 */
/** 收集会话日志，mtime 新→旧。sinceMs：只收更新于该时刻之后的文件（增量扫描窗口）。 */
export function sessionLogFiles(sessionsDir, limit = 200, { sinceMs = 0 } = {}) {
  const out = []
  const walk = (dir, depth) => {
    if (depth > 3 || !existsSync(dir)) return
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, name.name)
      if (name.isDirectory()) walk(path, depth + 1)
      else if (name.name.endsWith('.jsonl.zstd') || name.name.endsWith('.jsonl')) {
        try {
          const mtimeMs = statSync(path).mtimeMs
          if (mtimeMs >= sinceMs) out.push({ path, mtimeMs })
        } catch { /* 忽略 */ }
      }
    }
  }
  walk(sessionsDir, 0)
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit)
}

/** 从事件里收集所有文本块（tool/result 的 message.content 可能是嵌套 callid 包装）。 */
function textOfEvent(event) {
  const parts = []
  const walk = (node) => {
    if (node === null || typeof node !== 'object') return
    if (Array.isArray(node)) { node.forEach(walk); return }
    if (node.type === 'text' && typeof node.text === 'string') parts.push(node.text)
    else for (const v of Object.values(node)) walk(v)
  }
  walk(event?.data ?? event)
  return parts.join('')
}

/**
 * 在会话日志里按 handle 找原文。
 * @param handle - `spill:<hash>` 或裸 hash 前缀。
 * @returns {{found:boolean, path?:string, seq?:number, shadowedSeq?:number, text?:string, reason?:string}}
 */
export function recoverByHandle(handle, { sessionsDir, limit = 200 } = {}) {
  const needle = String(handle).trim().replace(/^spill:/, '')
  if (!/^[0-9a-f]{6,64}$/.test(needle)) return { found: false, reason: 'invalid handle' }
  const files = sessionLogFiles(sessionsDir, limit)

  for (const { path } of files) {
    let lines
    try { lines = readSessionLog(path).split('\n') } catch { continue }

    let hit = null           // 替换事件所在 seq
    let shadowedSeq = null   // 被替换的源 seq
    let lastPruneSeqs = null
    for (const line of lines) {
      if (!line) continue
      if (!line.includes(needle)) {
        // 只跟踪紧邻的影价事件（记录被剪的源 seq）
        if (line.includes('"compaction/prune"')) {
          try { lastPruneSeqs = JSON.parse(line)?.data?.shadowedSeqs ?? null } catch { /* 坏行 */ }
        }
        continue
      }
      let j
      try { j = JSON.parse(line) } catch { continue }
      hit = j?.seq ?? -1
      shadowedSeq = j?.sourceEventSeqs?.[0] ?? lastPruneSeqs?.[0] ?? null
      break
    }
    if (hit === null) continue
    if (shadowedSeq === null) return { found: false, reason: 'handle found but no shadowed seq', path }

    for (const line of lines) {
      if (!line.includes(`"seq":${shadowedSeq}`)) continue
      let j
      try { j = JSON.parse(line) } catch { continue }
      if (j?.seq !== shadowedSeq) continue
      const text = textOfEvent(j)
      if (text !== null) return { found: true, path, seq: hit, shadowedSeq, text }
    }
  }
  return { found: false, reason: 'handle not found in session logs' }
}
