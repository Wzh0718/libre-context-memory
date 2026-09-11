#!/usr/bin/env node
/** lcm CLI（Node 版）：compress / read / report / stat。
 *
 * hook 契约友好：compress 从 stdin 读原文，stdout 吐「摘要+句柄」文本（--json 换结构化输出）。
 * 用法：node core/cli.mjs <cmd> 或 npm bin 链接后 `lcm <cmd>`。
 */

import { writeFileSync } from 'node:fs'

import { compress } from './compress.mjs'
import { loadConfig } from './config.mjs'
import * as meter from './meter.mjs'
import * as spill from './spill.mjs'

function fmtSummary(result, ref) {
  if (!result.compressed) return result.summary // 直通
  if (!ref) {
    return `[影子] 未落盘 · ${result.originalChars.toLocaleString()} 字符 · 类型 ${result.type} · 压缩 ${result.ratio.toFixed(1)}×\n--- 摘要 ---\n${result.summary}`
  }
  const header = [
    `[归档] ${ref.spillId} · ${result.originalChars.toLocaleString()} 字符 · ${result.originalLines.toLocaleString()} 行 · 类型 ${result.type} · 压缩 ${result.ratio.toFixed(1)}× · 后端 ${ref.backend}`,
    `回取: lcm read ${ref.spillId} [--from A --to B] [--grep PAT]`,
    `本地原文: ${ref.path}`,
  ]
  if (result.keywords.length) header.push('关键词: ' + result.keywords.join(', '))
  if (result.anchors.length) {
    header.push('锚点:')
    header.push(...result.anchors.map((a) => `  ${a}`))
  }
  header.push('--- 摘要 ---')
  return header.join('\n') + '\n' + result.summary
}

function parseArgs(argv) {
  const args = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      if (['json', 'no-spill'].includes(key)) args[key] = true
      else args[key] = argv[++i]
    } else args._.push(a)
  }
  return args
}

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2)
  const args = parseArgs(rest)
  const cfg = loadConfig()

  if (cmd === 'compress') {
    const text = await readStdin()
    const result = compress(text, args.type ?? null)
    let ref = null
    if (result.compressed && !args['no-spill']) ref = spill.put(cfg, text)
    if (result.compressed) {
      meter.record(cfg, {
        kind: 'compress', type: result.type,
        originalChars: result.originalChars, compressedChars: [...result.summary].length,
        ratio: Number(result.ratio.toFixed(2)),
        spillId: ref?.spillId ?? null, backend: ref?.backend ?? 'shadow',
        harness: args.harness ?? null, sessionId: args.session ?? null,
      })
    }
    if (args.json) {
      console.log(JSON.stringify({
        compressed: result.compressed, type: result.type,
        originalChars: result.originalChars, originalLines: result.originalLines,
        ratio: result.compressed ? Number(result.ratio.toFixed(2)) : 1,
        keywords: result.keywords, anchors: result.anchors,
        spill: ref ? { id: ref.spillId, backend: ref.backend, path: ref.path } : null,
        summary: fmtSummary(result, ref),
      }, null, 2))
    } else {
      console.log(fmtSummary(result, ref))
    }
    return 0
  }

  if (cmd === 'read') {
    const ref = spill.read(cfg, args._[0] ?? '')
    if (!ref) {
      console.error(`[lcm] 未找到 ${args._[0]}（本地无此 spill；可用 \`lcm recover ${args._[0]}\` 从会话日志找回，或配置 OpenViking 同步）`)
      return 1
    }
    meter.record(cfg, { kind: 'retrieve', spillId: ref.spillId, backend: ref.backend })
    const text = ref.text
    const lines = text.split('\n')
    if (args.grep) {
      const hits = []
      lines.forEach((l, i) => { if (l.includes(args.grep)) hits.push(`${i + 1}: ${l}`) })
      console.log(hits.slice(0, Number(args.head ?? 50)).join('\n'))
      return 0
    }
    const from = Number(args.from ?? 1)
    const to = Number(args.to ?? lines.length)
    if (from === 1 && to >= lines.length) {
      console.error(`[lcm] ${ref.path} · ${[...text].length.toLocaleString()} 字符 · ${lines.length.toLocaleString()} 行`)
      process.stdout.write(text)
    } else {
      console.log(lines.slice(from - 1, to).map((l, i) => `${from + i}: ${l}`).join('\n'))
    }
    return 0
  }

  if (cmd === 'compare') {
    const { compare: runCompare } = await import('./compare.mjs')
    const c = runCompare(cfg)
    if (c.requests === 0) { console.log('[lcm] 暂无 usage 计量，无法对比'); return 0 }
    if (args.json) { console.log(JSON.stringify(c, null, 2)); return 0 }
    const n = (x) => Math.round(x).toLocaleString()
    const pct = (x) => `${(x * 100).toFixed(1)}%`
    const ts = (v) => (v === null ? '-' : new Date(v).toLocaleString('sv-SE'))
    console.log(`对比窗口：${ts(c.window.from)} → ${ts(c.window.to)}（${c.requests} 请求 / ${c.sessions} 会话）`)
    console.log('')
    console.log('实际（装 lcm）：')
    console.log(`  总当量 ${n(c.actual.equivalent)} ｜ 每请求 ${n(c.actual.perRequest)} ｜ 命中率 ${pct(c.actual.hitRate)}`)
    console.log(`  fresh ${n(c.actual.fresh)} ／ cached ${n(c.actual.cached)}`)
    console.log('')
    console.log('反事实（不装 lcm，被剪掉的存量仍在上下文里）：')
    console.log(`  总当量 ${n(c.counterfactual.equivalent)} ｜ 每请求 ${n(c.counterfactual.perRequest)}`)
    console.log('')
    console.log(`治理掉的存量：${c.savings.trimmedEvents} 次剪枝/压缩，累计 ${n(c.savings.trimmedTokensTotal)} tokens 退出热区`)
    console.log(`毛节省：${n(c.savings.equivalent)} 当量（${pct(c.savings.percent)}）`)
    console.log(`击穿成本：窗口内共 ${c.busts.count} 次前缀打穿（多付 ${n(c.busts.extraEquivalent)} 当量）`)
    console.log(`  成因分解：${JSON.stringify(c.busts.byCause)}（compaction 优先归因）`)
    console.log(`  其中归因于 lcm 剪枝的：${c.busts.lcmCount} 次，${n(c.busts.lcmExtraEquivalent)} 当量`)
    console.log(`净收益：${n(c.net.equivalent)} 当量（${pct(c.net.percent)}）`)
    if (c.net.breakevenRequests !== null && c.busts.lcmCount > 0) {
      console.log(`  盈亏平衡：改写历史需后续 ≥${c.net.breakevenRequests} 个请求才回本；`
        + `每次剪枝的击穿代价 ≈ ${c.net.bustCostInRequests?.toFixed(1) ?? '-'} 个稳态请求的钱`)
    } else if (c.busts.lcmCount === 0) {
      console.log('  盈亏平衡：本窗口 lcm 未制造任何击穿（搭便车生效），无需回本')
    }
    console.log('')
    console.log('分组（仅供参考：剪枝后的请求上下文天然更大，存在增长偏差，非对照实验）：')
    console.log(`  剪枝前 ${c.groups.beforeTrim.requests} 请求 ｜ 每请求 ${n(c.groups.beforeTrim.perRequest)}`)
    console.log(`  剪枝后 ${c.groups.afterTrim.requests} 请求 ｜ 每请求 ${n(c.groups.afterTrim.perRequest)} ｜ 平均已治理 ${n(c.groups.afterTrim.avgTrimmedTokens)} tokens`)
    return 0
  }

  if (cmd === 'recover') {
    const { recoverByHandle } = await import('./recover.mjs')
    const r = await recoverByHandle(args._[0] ?? '', { sessionsDir: args.sessions ?? cfg.sessionsDir })
    if (!r.found) {
      console.error(`[lcm] 未能从会话日志恢复 ${args._[0]}：${r.reason}`)
      return 1
    }
    if (args.out) {
      writeFileSync(args.out, r.text, 'utf8')
      console.error(`[lcm] 已恢复 ${[...r.text].length.toLocaleString()} 字符 → ${args.out}（源：${r.path} seq ${r.shadowedSeq}）`)
    } else {
      console.error(`[lcm] 从会话日志恢复（源：${r.path} seq ${r.shadowedSeq}，替换事件 seq ${r.seq}）`)
      process.stdout.write(r.text)
    }
    return 0
  }

  if (cmd === 'sweep') {
    const before = spill.usage(cfg)
    const r = spill.sweep(cfg, { force: true })
    meter.record(cfg, { kind: 'spill-sweep', removed: r.removed, freedBytes: r.freedBytes, bytes: r.bytes, reason: r.reason })
    console.log(`[lcm] spill 清扫：删除 ${r.removed} 个（原因 ${r.reason ?? '无需清理'}），释放 ${(r.freedBytes / 1024).toFixed(1)} KB；`
      + `${(before.bytes / 1024 / 1024).toFixed(1)} MB → ${(r.bytes / 1024 / 1024).toFixed(1)} MB`)
    return 0
  }

  if (cmd === 'report') {
    const s = meter.summary(cfg)
    if (s.events === 0) { console.log('[lcm] 暂无计量事件'); return 0 }
    if (s.usage) {
      const u = s.usage
      console.log(`缓存账本（${u.requests} 个请求）：`)
      console.log(`  命中率 ${(u.hitRate * 100).toFixed(1)}% ｜ fresh 中位 ${u.freshMedian.toLocaleString()} / p90 ${u.freshP90.toLocaleString()} ｜ 击穿苗头 ${u.cacheBusts} 次（fresh>50k）`)
      console.log(`  成本当量 ${Math.round(u.costEquivalent).toLocaleString()}（fresh ${u.totalFresh.toLocaleString()} + 0.1×cached ${u.totalCacheRead.toLocaleString()}）`)
    }
    if (s.trims) {
      const saved = s.trimCharsBefore - s.trimCharsAfter
      console.log(`静态层裁剪 ${s.trims} 次（影子 ${s.trimShadow ?? 0} 次）：工具 ${(s.trimToolsBefore / s.trims).toFixed(0)}→${(s.trimToolsAfter / s.trims).toFixed(0)}，描述 ${s.trimCharsBefore.toLocaleString()}→${s.trimCharsAfter.toLocaleString()} 字符（省 ${saved.toLocaleString()}）`)
    }
    if (s.prunes) {
      console.log(`剪枝事件 ${s.prunes} 次（影子 ${s.pruneShadow} 次）：${s.pruneNodes} 个节点，${s.pruneCharsBefore.toLocaleString()} → ${s.pruneCharsAfter.toLocaleString()} 字符`)
    }
    if (s.compactions) {
      console.log(`折叠事件 ${s.compactions} 次：${s.compactionOps.join(', ')}`)
    }
    if (s.compressCount) {
      console.log(`压缩事件 ${s.compressCount} 次：${s.totalOrig.toLocaleString()} → ${s.totalComp.toLocaleString()} 字符`)
      for (const r of s.byType) {
        console.log(`  ${r.type.padEnd(16)} ×${String(r.n).padEnd(5)} 平均 ${r.avgRatio.toFixed(1)}×  共 ${r.orig.toLocaleString()} → ${r.comp.toLocaleString()}`)
      }
    }
    console.log(`回取事件 ${s.retrieveCount} 次（涉及 ${s.retrieveHandles} 个句柄）`)
    const u = spill.usage(cfg)
    const cap = (cfg.spillMaxBytes / 1024 / 1024).toFixed(0)
    console.log(`spill 存储：${u.files} 个文件 / ${(u.bytes / 1024 / 1024).toFixed(1)} MB（上限 ${cap} MB，保留 ${cfg.spillTtlDays} 天）`
      + (s.sweeps ? ` ｜ 已清扫 ${s.sweeps} 次，释放 ${(s.spillFreedBytes / 1024 / 1024).toFixed(1)} MB` : ''))
    console.log(`计量文件：${s.files.length ? s.files.map((f) => f.split('/').pop()).join(', ') : '（无）'}`)
    return 0
  }

  if (cmd === 'stat') {
    const u = spill.usage(cfg)
    console.log(JSON.stringify({
      root: cfg.root,
      backend: cfg.openvikingConfigured ? 'viking' : 'local',
      spillDir: cfg.spillDir,
      spillFiles: u.files,
      spillBytes: u.bytes,
      spillMaxBytes: cfg.spillMaxBytes,
      spillTtlDays: cfg.spillTtlDays,
      meterFiles: meter.meterFiles(cfg),
      sessionsDir: cfg.sessionsDir,
    }, null, 2))
    return 0
  }

  console.error('用法: lcm <compress|read|recover|report|compare|sweep|stat>')
  return 2
}

main().then((code) => process.exit(code)).catch((e) => {
  console.error(`[lcm] ${String(e?.message ?? e)}`)
  process.exit(1)
})
