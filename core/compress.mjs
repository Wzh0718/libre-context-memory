/** 确定性压缩器：预处理（信封解包 + base64 剥离 + 超长行收缩）→ 类型分流。
 *
 * 原则（docs/03 §3）：
 * - < 20k 字符：直通不动
 * - 确定性：同输入 → 同输出（逐字节）
 * - originalChars 始终指完整原文（含信封/二进制），即它在上下文里真实占的体积
 * - 字符数按 Unicode code point 计（与 docs 口径一致）
 */

export const PASSTHROUGH_CHARS = 20_000
const LONG_LINE_CAP = 500

const LOG_LINE_RE = /^(\[?\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}|\[?(DEBUG|INFO|WARN|WARNING|ERROR|TRACE|FATAL)\b|\d{2}:\d{2}:\d{2})/
const TS_RE = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?/g
const DIFF_RE = /^(diff --git |@@ |\+\+\+ |--- |\*\*\* (Begin|End) Patch)/m
const CODE_RE = /^\s*(def |class |function |const |let |var |import |from |export |public |private |interface |type |fn |func |package |#include|async |return\b)/
const PATH_RE = /^[\w\-./\\~]+[/\\][\w\-./\\~]*$|^[\w\-]+\.(py|js|ts|tsx|jsx|go|rs|java|kt|c|cc|cpp|h|hpp|css|scss|html|vue|json|ya?ml|toml|md|sql|sh|txt|log)$/
const ERROR_RE = /\bERROR\b|\bError\b|\bException\b|\bTraceback\b|\bFATAL\b|\bpanic\b|\bFAILED\b|\bSegmentation fault\b/
const WORD_RE = /[A-Za-z_][A-Za-z0-9_./:-]{3,}/g
const DATA_URL_RE = /data:([\w.+-]+\/[\w.+-]+)?;base64,([A-Za-z0-9+/=\s]{512,})/g

const ENVELOPE_TYPES = new Set(['custom_tool_call_output', 'function_call_output'])
const STOP_WORDS = new Set(['true', 'false', 'null', 'none', 'this', 'that', 'with', 'from'])

export const codePointLength = (s) => [...s].length

// ---------------------------------------------------------------- 预处理

/** 剥 harness 工具输出信封；非信封原样返回 [text, []]。 */
export function unwrapEnvelope(text) {
  const stripped = text.trim()
  if (!stripped.startsWith('{')) return [text, []]
  let obj
  try { obj = JSON.parse(stripped) } catch { return [text, []] }
  if (!(obj && typeof obj === 'object' && ENVELOPE_TYPES.has(obj.type) && Array.isArray(obj.output))) {
    return [text, []]
  }
  const parts = []
  const notes = [`信封: ${obj.type}`]
  for (const part of obj.output) {
    if (part && typeof part === 'object' && part.text != null) {
      parts.push(String(part.text))
    } else if (part && typeof part === 'object' && part.image_url) {
      notes.push(`内联图片 ${String(part.image_url).length.toLocaleString()} 字符（base64）已剥离，完整内容在句柄原文`)
    } else {
      parts.push(JSON.stringify(part)?.slice(0, 500) ?? '')
    }
  }
  return [parts.join('\n'), notes]
}

/** 剥离长 base64 段（内联图片/二进制），替换为占位说明。 */
export function stripBase64(text) {
  const notes = []
  const out = text.replace(DATA_URL_RE, (_m, mime, b64) => {
    const n = b64.length
    notes.push(`base64 ${mime ?? 'unknown'} ${n.toLocaleString()} 字符已剥离，完整内容在句柄原文`)
    return `[base64 ${mime ?? 'unknown'} ${n.toLocaleString()} chars stripped → 句柄原文]`
  })
  return [out, notes]
}

// ---------------------------------------------------------------- 类型检测

export function detectType(text) {
  const head = text.slice(0, 64_000)
  const stripped = head.trim()
  if (stripped.startsWith('{') || stripped.startsWith('[')) {
    try { JSON.parse(text.trim()); return 'json' } catch { /* fallthrough */ }
  }
  const lines = text.split('\n')
  const sample = lines.length > 500 ? lines.slice(0, 500) : lines
  if (sample.length === 0) return 'generic'
  // jsonl：前 20 个非空行都以 {/[ 开头且至少 10 行解析成功
  const first20 = sample.slice(0, 20).filter((l) => l.trim())
  if (lines.length > 3 && first20.length > 0 && first20.every((l) => l.trim().startsWith('{') || l.trim().startsWith('['))) {
    let ok = 0
    for (const l of first20) { try { JSON.parse(l); ok++ } catch { break } }
    if (ok >= Math.min(10, first20.length)) return 'jsonl'
  }
  if (DIFF_RE.test(head)) return 'diff'
  const n = sample.length
  const ratio = (pred) => sample.filter(pred).length / n
  if (ratio((l) => LOG_LINE_RE.test(l)) >= 0.5) return 'log'
  if (ratio((l) => l.includes('|') || l.includes('\t')) >= 0.6) return 'table'
  if (ratio((l) => PATH_RE.test(l.trim())) >= 0.6) return 'filelist'
  if (ratio((l) => CODE_RE.test(l)) >= 0.2) return 'code'
  return 'generic'
}

// ---------------------------------------------------------------- 共用件

function keywords(text, cap = 8) {
  const counts = new Map()
  for (const m of text.slice(0, 200_000).matchAll(WORD_RE)) {
    const w = m[0]
    // 关键词上限 40 字符：一条 80k 无空格的行会成为一个「关键词」，
    // 不截断会把原文经关键词通道漏回上下文（真实 bug，契约测试抓获）
    if (w.length > 40) continue
    if (!STOP_WORDS.has(w.toLowerCase())) counts.set(w, (counts.get(w) ?? 0) + 1)
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 200).map(([w]) => w).slice(0, cap)
}

function errorAnchors(lines, cap = 5) {
  const out = []
  for (let i = 0; i < lines.length && out.length < cap; i++) {
    if (ERROR_RE.test(lines[i])) {
      out.push(`ERROR 类内容首现于第 ${i + 1} 行：${lines[i].trim().slice(0, 100)}`)
    }
  }
  return out
}

function jsonSchema(obj, depth = 0) {
  if (depth > 4) return '…'
  if (Array.isArray(obj)) return obj.length ? `[${jsonSchema(obj[0], depth + 1)}]×${obj.length}` : '[]'
  if (obj && typeof obj === 'object') {
    const keys = Object.keys(obj)
    const inner = keys.slice(0, 20).map((k) => `${k}: ${jsonSchema(obj[k], depth + 1)}`).join(', ')
    return `{${inner}${keys.length > 20 ? ', …' : ''}}`
  }
  return obj === null ? 'null' : typeof obj
}

function jsonNumericStats(items) {
  const nums = new Map()
  for (const it of items.slice(0, 5000)) {
    if (it && typeof it === 'object' && !Array.isArray(it)) {
      for (const [k, v] of Object.entries(it)) {
        if (typeof v === 'number' && Number.isFinite(v)) {
          if (!nums.has(k)) nums.set(k, [])
          nums.get(k).push(v)
        }
      }
    }
  }
  const out = []
  for (const [k, vs] of [...nums.entries()].slice(0, 15)) {
    const mean = vs.reduce((a, b) => a + b, 0) / vs.length
    out.push(`${k}: n=${vs.length} min=${Math.min(...vs).toPrecision(4)} max=${Math.max(...vs).toPrecision(4)} mean=${mean.toPrecision(4)}`)
  }
  return out
}

function shrinkLongLine(line, cap = LONG_LINE_CAP) {
  if (line.length <= cap) return line
  const s = line.trim()
  if (s.startsWith('{') || s.startsWith('[')) {
    try {
      return `[单行 JSON ${line.length.toLocaleString()} 字符] schema: ${jsonSchema(JSON.parse(s))}`
    } catch { /* fallthrough */ }
  }
  return `${line.slice(0, cap)} …[本行共 ${line.length.toLocaleString()} 字符，已截断，完整见句柄原文]`
}

const result = (type, text, summary, extra = {}) => ({
  type,
  originalChars: codePointLength(text),
  originalLines: text.length ? text.split('\n').length : 0,
  summary,
  keywords: extra.keywords ?? [],
  anchors: extra.anchors ?? [],
  compressed: true,
})

// ---------------------------------------------------------------- 各类型压缩

function compressLog(text) {
  const lines = text.split('\n')
  // 时间戳归一 + 连续重复行折叠
  const folded = []
  let prev = null
  let cnt = 0
  const flush = () => { if (prev !== null) folded.push(cnt === 1 ? prev : `${prev}  ⏎(×${cnt})`) }
  for (const l of lines) {
    const norm = l.replace(TS_RE, '<ts>')
    if (norm === prev) { cnt++; continue }
    flush(); prev = norm; cnt = 1
  }
  flush()

  const head = folded.slice(0, 15)
  const tail = folded.slice(-10)
  const body = [
    `[日志] 原 ${lines.length} 行；时间戳已归一为 <ts>；连续重复行已折叠（⏎×N），折叠后 ${folded.length} 行。`,
    '--- 头部 ---', ...head.map((l) => shrinkLongLine(l)),
    `--- 中部折叠省略 ${Math.max(0, folded.length - 25)} 行（完整内容见句柄原文）---`,
    '--- 尾部 ---', ...tail.map((l) => shrinkLongLine(l)),
  ]
  return result('log', text, body.join('\n'), { keywords: keywords(text), anchors: errorAnchors(lines) })
}

function compressFilelist(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
  const byDir = new Map()
  for (const l of lines) {
    const d = l.includes('/') ? l.slice(0, l.lastIndexOf('/')) : '.'
    if (!byDir.has(d)) byDir.set(d, [])
    byDir.get(d).push(l)
  }
  const ext = new Map()
  for (const l of lines) {
    const base = l.slice(l.lastIndexOf('/') + 1)
    if (base.includes('.')) {
      const e = base.split('.').pop().toLowerCase()
      ext.set(e, (ext.get(e) ?? 0) + 1)
    }
  }
  const body = [`[文件列表] 共 ${lines.length} 条，分布于 ${byDir.size} 个目录。`]
  if (ext.size) {
    body.push('扩展名分布: ' + [...ext.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([e, c]) => `${e}×${c}`).join(', '))
  }
  body.push('--- 目录聚合（每目录至多 3 个样本）---')
  const dirs = [...byDir.entries()].sort((a, b) => b[1].length - a[1].length)
  for (const [d, files] of dirs.slice(0, 50)) {
    body.push(`${d}/  ×${files.length}  例: ${files.slice(0, 3).join('; ')}`)
  }
  if (dirs.length > 50) body.push(`... 其余 ${dirs.length - 50} 个目录见句柄原文`)
  return result('filelist', text, body.join('\n'), { keywords: keywords(text) })
}

function compressJson(text) {
  const obj = JSON.parse(text)
  const body = [`[JSON] 顶层类型 ${Array.isArray(obj) ? 'array' : typeof obj}。`, 'schema: ' + jsonSchema(obj)]
  if (Array.isArray(obj)) {
    body.push(`数组长度 ${obj.length}，前 3 条样本:`)
    body.push(...obj.slice(0, 3).map((x) => JSON.stringify(x)?.slice(0, 300) ?? ''))
    const stats = jsonNumericStats(obj)
    if (stats.length) { body.push('数值字段统计:'); body.push(...stats) }
  } else if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      if (Array.isArray(v) && v.length && v[0] && typeof v[0] === 'object') {
        body.push(`字段 ${k}: [${v.length} 条对象]，样本: ${JSON.stringify(v[0])?.slice(0, 300)}`)
        const stats = jsonNumericStats(v)
        body.push(...stats.map((s) => `  ${s}`))
      }
    }
  }
  return result('json', text, body.join('\n'), { keywords: keywords(text) })
}

function compressJsonl(text) {
  const lines = text.split('\n').filter((l) => l.trim())
  const objs = []
  for (const l of lines.slice(0, 5000)) { try { objs.push(JSON.parse(l)) } catch { /* skip */ } }
  const keyFreq = new Map()
  for (const o of objs) {
    if (o && typeof o === 'object' && !Array.isArray(o)) {
      for (const k of Object.keys(o)) keyFreq.set(k, (keyFreq.get(k) ?? 0) + 1)
    }
  }
  const body = [`[JSONL] 共 ${lines.length} 行（解析成功 ${objs.length}）。`]
  body.push('字段频次: ' + [...keyFreq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([k, c]) => `${k}×${c}`).join(', '))
  body.push('前 3 行样本:')
  body.push(...lines.slice(0, 3).map((l) => l.slice(0, 300)))
  const stats = jsonNumericStats(objs)
  if (stats.length) { body.push('数值字段统计:'); body.push(...stats) }
  return result('jsonl', text, body.join('\n'), { keywords: keywords(text), anchors: errorAnchors(text.split('\n')) })
}

function compressTable(text) {
  const lines = text.split('\n').filter((l) => l.trim())
  const sep = lines[0].includes('|') ? '|' : '\t'
  const rows = lines.map((l) => l.split(sep).map((c) => c.trim()))
  const [header, ...data] = rows
  const body = [`[表格] ${data.length} 行 × ${header.length} 列；分隔符 ${JSON.stringify(sep)}。`,
    '表头: ' + header.slice(0, 20).join(' | ')]
  body.push('前 5 行:')
  body.push(...data.slice(0, 5).map((r) => r.join(' | ').slice(0, 300)))
  for (let ci = 0; ci < Math.min(header.length, 10); ci++) {
    const name = header[ci]
    const col = data.filter((r) => ci < r.length).map((r) => r[ci])
    const nums = col.filter(Boolean).map((c) => Number(c.replace(/,/g, ''))).filter((v) => Number.isFinite(v))
    if (col.length && nums.length / col.length >= 0.8 && nums.length) {
      const mean = nums.reduce((a, b) => a + b, 0) / nums.length
      body.push(`列 ${name}: n=${nums.length} min=${Math.min(...nums).toPrecision(4)} max=${Math.max(...nums).toPrecision(4)} mean=${mean.toPrecision(4)}`)
    } else {
      body.push(`列 ${name}: 去重值 ${new Set(col).size} 个`)
    }
  }
  return result('table', text, body.join('\n'), { keywords: keywords(text) })
}

function compressDiff(text) {
  const lines = text.split('\n')
  const files = new Map()
  let cur = null
  for (const l of lines) {
    if (l.startsWith('diff --git')) {
      cur = l.split(' b/').pop()
      files.set(cur, { add: 0, del: 0 })
    } else if (l.startsWith('*** Update File:') || l.startsWith('*** Add File:')) {
      cur = l.split(':').slice(1).join(':').trim()
      files.set(cur, { add: 0, del: 0 })
    } else if (cur && l.startsWith('+') && !l.startsWith('+++')) {
      files.get(cur).add++
    } else if (cur && l.startsWith('-') && !l.startsWith('---')) {
      files.get(cur).del++
    }
  }
  const body = [`[diff/patch] 涉及 ${files.size} 个文件，共 ${lines.length} 行。`]
  for (const [f, s] of [...files.entries()].slice(0, 50)) body.push(`${f}: +${s.add} −${s.del}`)
  if (files.size > 50) body.push(`... 其余 ${files.size - 50} 个文件见句柄原文`)
  return result('diff', text, body.join('\n'), { keywords: keywords(text) })
}

function compressCode(text) {
  const lines = text.split('\n')
  const keep = []
  lines.forEach((l, i) => { if (CODE_RE.test(l)) keep.push(`${i + 1}: ${l.trim().slice(0, 120)}`) })
  const body = [`[代码] 共 ${lines.length} 行；保留签名/声明类行 ${keep.length} 行（带行号锚点）。`]
  body.push(...keep.slice(0, 200))
  if (keep.length > 200) body.push(`... 其余 ${keep.length - 200} 行签名见句柄原文`)
  return result('code', text, body.join('\n'), { keywords: keywords(text) })
}

function compressGeneric(text) {
  const lines = text.split('\n')
  const uniq = new Set(lines).size
  const freq = new Map()
  for (const l of lines) { const t = l.trim(); if (t) freq.set(t, (freq.get(t) ?? 0) + 1) }
  const dupRate = lines.length ? Math.round((1 - uniq / lines.length) * 100) : 0
  const body = [
    `[通用] ${lines.length} 行 / ${codePointLength(text)} 字符；唯一行 ${uniq}（重复率 ${dupRate}%）。`,
    '--- 头部 30 行 ---', ...lines.slice(0, 30).map((l) => shrinkLongLine(l)),
    '--- 尾部 15 行 ---', ...lines.slice(-15).map((l) => shrinkLongLine(l)),
    '--- 高频行 top5 ---',
    ...[...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([l, c]) => `×${c}  ${shrinkLongLine(l, 100)}`),
  ]
  return result('generic', text, body.join('\n'), { keywords: keywords(text), anchors: errorAnchors(lines) })
}

export const COMPRESSORS = {
  log: compressLog,
  filelist: compressFilelist,
  json: compressJson,
  jsonl: compressJsonl,
  table: compressTable,
  diff: compressDiff,
  code: compressCode,
  generic: compressGeneric,
}

/**
 * 入口：<20k 直通；否则 预处理（信封/base64）→ 类型检测 → 对应压缩器。
 * 返回 { type, originalChars, originalLines, summary, keywords, anchors, compressed, ratio }。
 */
export function compress(text, forceType = null) {
  if (codePointLength(text) < PASSTHROUGH_CHARS && forceType === null) {
    return {
      type: 'passthrough',
      originalChars: codePointLength(text),
      originalLines: text.length ? text.split('\n').length : 1,
      summary: text, keywords: [], anchors: [], compressed: false, ratio: 1,
    }
  }
  let [payload, notes] = unwrapEnvelope(text)
  let b64Notes
  [payload, b64Notes] = stripBase64(payload)
  notes = notes.concat(b64Notes)
  const t = forceType ?? detectType(payload)
  let r
  try {
    r = (COMPRESSORS[t] ?? compressGeneric)(payload)
  } catch {
    r = compressGeneric(payload)
  }
  // originalChars/Lines 指完整原文（含信封/二进制）——上下文里真实占的体积
  r.originalChars = codePointLength(text)
  r.originalLines = text.split('\n').length
  if (notes.length) r.summary = notes.map((n) => `[预处理] ${n}`).join('\n') + '\n' + r.summary
  // 不变式（对齐内置 pruner 的纪律）：压缩产物必须小于原文；
  // 任何类型的压缩器违反它（如关键词通道漏原文）时兜底为首尾保留。
  if (codePointLength(r.summary) >= r.originalChars) {
    const points = [...text]
    const half = 500
    r = {
      type: r.type, originalChars: r.originalChars, originalLines: r.originalLines,
      summary: points.slice(0, half).join('')
        + `\n…[lcm 兜底：中间 ${(points.length - half * 2).toLocaleString()} 字符省略]…\n`
        + points.slice(points.length - half).join(''),
      keywords: r.keywords.filter((w) => w.length <= 40), anchors: r.anchors,
      compressed: true, ratio: 0,
    }
  }
  r.ratio = r.originalChars / Math.max(1, codePointLength(r.summary))
  return r
}
