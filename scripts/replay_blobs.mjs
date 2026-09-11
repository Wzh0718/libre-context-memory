#!/usr/bin/env node
/** Phase 0 回放测试（Node 版）：用 codex-lifecycle-data 的真实大工具输出验证压缩器。
 *
 * 运行：node --experimental-sqlite scripts/replay_blobs.mjs
 * - 数据集：blobs 中 kind ∈ (custom_tool_call_output, function_call_output)
 *   high 带 raw_bytes > 100k 全量；mid 带 20k–100k 按 content_hash 抽样 50 个（可复现）
 * - 断言：确定性（同输入两次输出逐字节相同）；压缩比下限（docs/03 §3，中位口径）
 * - 产出：reports/phase0-compression-report.md
 * - 不落 spill、不写 meter（纯离线测量）
 */

import { existsSync } from 'node:fs'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { inflateSync } from 'node:zlib'

import { compress } from '../core/compress.mjs'

const REPO = new URL('..', import.meta.url).pathname
const DATA_DB = join(REPO, '..', 'codex-lifecycle-data', 'index.sqlite')

// docs/03 §3 压缩比区间下限
const LOWER_BOUNDS = { log: 10, filelist: 20, json: 10, jsonl: 10, table: 20, diff: 5, code: 3, generic: 10 }

function loadBlobs() {
  const db = new DatabaseSync(DATA_DB, { readOnly: true })
  const high = db.prepare(
    `SELECT content_hash, raw_bytes, path FROM blobs
     WHERE kind IN ('response_item/custom_tool_call_output','response_item/function_call_output')
       AND raw_bytes > 100000 ORDER BY raw_bytes DESC`,
  ).all()
  const mid = db.prepare(
    `SELECT content_hash, raw_bytes, path FROM blobs
     WHERE kind IN ('response_item/custom_tool_call_output','response_item/function_call_output')
       AND raw_bytes BETWEEN 20000 AND 100000
     ORDER BY content_hash LIMIT 50`,
  ).all()
  db.close()
  return [...high.map((r) => ({ ...r, band: 'high' })), ...mid.map((r) => ({ ...r, band: 'mid' }))]
}

async function main() {
  const rows = loadBlobs()
  const nHigh = rows.filter((r) => r.band === 'high').length
  console.log(`回放 ${rows.length} 个 blob（high 带 ${nHigh} + mid 带 ${rows.length - nHigh}）`)

  const stats = new Map()
  const failures = []
  const t0 = Date.now()

  for (let i = 0; i < rows.length; i++) {
    const { content_hash, path, band } = rows[i]
    let text
    try {
      text = inflateSync(await readFile(path)).toString('utf8')
    } catch (e) {
      failures.push(`${String(content_hash).slice(0, 12)} 解压失败: ${e}`)
      continue
    }
    const r1 = compress(text)
    const r2 = compress(text)
    if (r1.summary !== r2.summary) failures.push(`${String(content_hash).slice(0, 12)} 确定性失败（类型 ${r1.type}）`)
    const key = `${band}|${r1.type}`
    if (!stats.has(key)) stats.set(key, { n: 0, orig: 0, comp: 0, ratios: [] })
    const s = stats.get(key)
    s.n++; s.orig += r1.originalChars; s.comp += [...r1.summary].length; s.ratios.push(r1.ratio)
    if ((i + 1) % 40 === 0) console.log(`  进度 ${i + 1}/${rows.length}`)
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
  const totalOrig = [...stats.values()].reduce((a, s) => a + s.orig, 0)
  const totalComp = [...stats.values()].reduce((a, s) => a + s.comp, 0)

  const lines = [
    '# Phase 0 · 压缩比报告（真实数据回放）',
    '',
    `> 数据源：\`../codex-lifecycle-data\` 工具输出 blob：high 带 >100k 字符 ${nHigh} 个 + mid 带 20k–100k 抽样 ${rows.length - nHigh} 个，共 ${(totalOrig / 1e6).toFixed(1)}M 字符`,
    `> Node 版核心引擎；耗时 ${elapsed}s；确定性校验全部通过=${failures.length === 0}；预处理含信封解包 + base64 剥离（占大头的确定性收益）`,
    '',
    '| 带 | 类型 | 样本数 | 原始字符 | 压缩后字符 | 整体压缩比 | 中位压缩比 | 最小压缩比 | 区间下限 | 达标 |',
    '|---|---|---|---|---|---|---|---|---|---|',
  ]
  let allOk = true
  for (const [key, s] of [...stats.entries()].sort((a, b) => b[1].orig - a[1].orig)) {
    const [band, type] = key.split('|')
    const ratios = [...s.ratios].sort((a, b) => a - b)
    const med = ratios[Math.floor(ratios.length / 2)]
    const overall = s.orig / Math.max(1, s.comp)
    if (type === 'passthrough') {
      lines.push(`| ${band} | ${type} | ${s.n} | ${s.orig.toLocaleString()} | ${s.comp.toLocaleString()} | 1.0× | 1.0× | 1.0× | — | ⏭️直通 |`)
      continue
    }
    const bound = LOWER_BOUNDS[type] ?? 10
    const ok = med >= bound && ratios[0] >= 1.0
    allOk &&= ok
    lines.push(`| ${band} | ${type} | ${s.n} | ${s.orig.toLocaleString()} | ${s.comp.toLocaleString()} | **${overall.toFixed(1)}×** | ${med.toFixed(1)}× | ${ratios[0].toFixed(1)}× | ${bound}× | ${ok ? '✅' : '❌'} |`)
  }
  lines.push('', `**整体：${totalOrig.toLocaleString()} → ${totalComp.toLocaleString()} 字符 = ${(totalOrig / Math.max(1, totalComp)).toFixed(1)}×**`, '')
  if (failures.length) {
    lines.push('## 失败明细', '', ...failures.map((f) => `- ${f}`))
  } else {
    lines.push('## 失败明细', '', '无（确定性 100% 通过）')
  }

  const reportPath = join(REPO, 'reports', 'phase0-compression-report.md')
  await mkdir(join(REPO, 'reports'), { recursive: true })
  await writeFile(reportPath, lines.join('\n') + '\n', 'utf8')
  console.log(lines.slice(0, 20).join('\n'))
  console.log(`\n报告已写入 ${reportPath}`)
  return failures.length === 0 && allOk ? 0 : 1
}

process.exit(await main())
