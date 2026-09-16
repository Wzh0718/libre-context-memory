#!/usr/bin/env node
/** lcm CLI（Node 版）：compress / read / report / stat。
 *
 * hook 契约友好：compress 从 stdin 读原文，stdout 吐「摘要+句柄」文本（--json 换结构化输出）。
 * 用法：node core/cli.mjs <cmd> 或 npm bin 链接后 `lcm <cmd>`。
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

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
      if (['json', 'no-spill', 'dry-run', 'rebuild', 'all', 'refresh', 'blend'].includes(key)) args[key] = true
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

/** 多根收集全部 meter 事件：全局根 + 历史散落的全项目根（实测 85% 的事件落在别的根）。 */
async function collectMeterEvents(cfg) {
  const { homedir } = await import('node:os')
  const roots = new Set([cfg.meterDir, cfg.legacyMeterDir].filter(Boolean))
  const projBase = join(homedir(), 'project')
  if (existsSync(projBase)) {
    for (const p of readdirSync(projBase)) {
      const d = join(projBase, p, '.lcm')
      if (existsSync(d)) roots.add(d)
    }
  }
  const events = []
  for (const dir of roots) {
    for (const n of readdirSync(dir)) {
      if (!/^meter(-\d{6})?\.jsonl$/.test(n)) continue
      for (const line of readFileSync(join(dir, n), 'utf8').split('\n')) {
        if (!line.trim()) continue
        try { events.push(JSON.parse(line)) } catch { /* 坏行跳过 */ }
      }
    }
  }
  return events
}

/** 真实会话集合（provenance 过滤用）：sessionsDir 下存在的 sessionId。 */
function knownSessionIds(cfg) {
  const known = new Set()
  if (cfg.sessionsDir && existsSync(cfg.sessionsDir)) {
    for (const proj of readdirSync(cfg.sessionsDir)) {
      try {
        for (const sid of readdirSync(join(cfg.sessionsDir, proj))) known.add(sid)
      } catch { /* 非目录跳过 */ }
    }
  }
  return known
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
    const c = runCompare(cfg, { project: args.project })
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
    const s = meter.summary(cfg, { project: args.project })
    if (s.events === 0) { console.log('[lcm] 暂无计量事件'); return 0 }
    if (s.usage) {
      const u = s.usage
      console.log(`缓存账本（${u.requests} 个请求）：`)
      console.log(`  命中率 ${(u.hitRate * 100).toFixed(1)}% ｜ fresh 中位 ${u.freshMedian.toLocaleString()} / p90 ${u.freshP90.toLocaleString()} ｜ 击穿苗头 ${u.cacheBusts} 次（fresh>50k）`)
      console.log(`  成本当量 ${Math.round(u.costEquivalent).toLocaleString()}（fresh ${u.totalFresh.toLocaleString()} + 0.1×cached ${u.totalCacheRead.toLocaleString()}）`)
    }
    if (s.byProject && s.byProject.length > 1) {
      console.log(`按项目（${s.byProject.length} 个，--project <名称> 过滤）：`)
      for (const p of s.byProject) {
        const name = p.project === '(legacy)' ? '(legacy)' : p.project.split('/').pop()
        console.log(`  ${name.padEnd(24)} ${String(p.requests).padStart(5)} 请求 ｜ fresh ${p.fresh.toLocaleString()} ｜ 命中 ${(p.cached / Math.max(1, p.fresh + p.cached) * 100).toFixed(1)}% ｜ 击穿 ${p.busts}`)
      }
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
    // 价值段（P4）：三行硬账，细节见 lcm value
    try {
      const { computeValue } = await import('./value.mjs')
      const v = computeValue(await collectMeterEvents(cfg), { knownSessions: knownSessionIds(cfg) })
      if (v.requests > 0) {
        const M = (n) => Math.abs(n) >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1e3)}k`
        console.log(`价值记账：净省 ${M(v.net)} = ${(v.netPct * 100).toFixed(1)}%（压缩 ${M(v.realized.compress)} / 剪枝 ${M(v.realized.prune)} / 折叠 ${M(v.realized.fold)} / 注入 −${M(v.injectionCost)}）`
          + `｜ 避免的击穿 ${M(v.avoidedBust)}｜ 交叉验证 ${v.xcheck.consistent ? '✓' : '✗ 不一致'}（lcm value 详看）`)
      }
    } catch { /* 价值段失败不影响 report 主体 */ }
    if (s.memory && (s.memory.stored || s.memory.injects)) {
      const m = s.memory
      console.log(`记忆事件：入库 ${m.stored} ｜ 幂等 ${m.noop} ｜ 禁写 ${m.rejected} ｜ 证伪 ${m.refuted}`
        + ` ｜ 注入 ${m.injects} 次（影子 ${m.injectShadow}，累计 ${m.injectChars.toLocaleString()} 字符）`
        + (m.syncOk || m.syncFail ? ` ｜ 同步 ok:${m.syncOk} fail:${m.syncFail}` : ''))
    }
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

  if (cmd === 'trim-diff') {
    const previewPath = join(cfg.meterDir, 'trim-preview.json')
    if (!existsSync(previewPath)) {
      console.error(`[lcm] 未找到复核工件 ${previewPath}`)
      console.error('     需先在 staticTrimMode: shadow 下跑一次会话（system-prompt/assemble 钩子自动落盘）')
      return 1
    }
    const preview = JSON.parse(readFileSync(previewPath, 'utf8'))
    if (args.json) { console.log(JSON.stringify(preview, null, 2)); return 0 }
    const out = []
    out.push(`静态层裁剪复核（模式 ${preview.mode}，${new Date(preview.savedAt).toLocaleString('sv-SE')}）`)
    out.push(`工具 ${preview.toolsBefore}→${preview.toolsAfter}，描述字符 ${preview.charsBefore.toLocaleString()}→${preview.charsAfter.toLocaleString()}`
      + `（省 ${(preview.charsBefore - preview.charsAfter).toLocaleString()}，${((1 - preview.charsAfter / preview.charsBefore) * 100).toFixed(0)}%）`)
    if (preview.families?.length) out.push(`整族丢弃: ${preview.families.join(', ')}`)
    out.push('')
    const trimmed = preview.tools.filter((t) => !t.dropped)
    const dropped = preview.tools.filter((t) => t.dropped)
    for (const t of trimmed) {
      const cut = t.before.length > t.after.length ? t.before.slice(t.after.length) : ''
      out.push(`■ ${t.name}  ${t.before.length.toLocaleString()}→${t.after.length.toLocaleString()} 字符（裁掉 ${cut.length.toLocaleString()}）`)
      out.push(`  [保留] ${t.after.replace(/\n/g, '\\n')}`)
      out.push(`  [裁掉] ${cut.slice(0, 400).replace(/\n/g, '\\n')}${cut.length > 400 ? ` …（共 ${cut.length.toLocaleString()} 字符）` : ''}`)
      out.push('')
    }
    for (const t of dropped) {
      out.push(`✂ ${t.name}  整族丢弃（原描述 ${t.before.length.toLocaleString()} 字符）`)
      out.push('')
    }
    out.push(`复核通过后：把 cordis.patch.yml 的 staticTrimMode 改为 active（裁剪是确定性的，同输入同输出）。`)
    const text = out.join('\n')
    if (args.out) { writeFileSync(args.out, text, 'utf8'); console.error(`[lcm] 已写入 ${args.out}`); return 0 }
    console.log(text)
    return 0
  }

  if (cmd === 'migrate') {
    // 导入旧版按项目落的 <root>/.lcm/meter*.jsonl 到全局计量根：
    // 事件补 project 字段（原样保留 ts），写入 meter-000000.jsonl（排序最前的归档段），
    // 成功后把源文件改名为 *.imported（防重复导入；report/compare 不会再读到它）。
    const bases = String(args.base ?? cfg.root).split(',').map((s) => s.trim()).filter(Boolean)
    const dryRun = Boolean(args['dry-run'])
    const found = []
    const candidates = [cfg.meterDir]
    for (const base of bases) {
      candidates.push(base)
      try {
        for (const d1 of readdirSync(base, { withFileTypes: true })) {
          if (!d1.isDirectory()) continue
          candidates.push(join(base, d1.name))
          try {
            for (const d2 of readdirSync(join(base, d1.name), { withFileTypes: true })) {
              if (d2.isDirectory()) candidates.push(join(base, d1.name, d2.name))
            }
          } catch { /* 深层不可读：跳过 */ }
        }
      } catch { /* base 不可读：跳过 */ }
    }
    const seen = new Set()
    for (const dir of candidates) {
      const lcmDir = dir.endsWith('/.lcm') ? dir : join(dir, '.lcm')
      if (seen.has(lcmDir)) continue
      seen.add(lcmDir)
      if (resolve(lcmDir) === resolve(cfg.meterDir)) continue   // 全局根自身不导入
      if (!existsSync(lcmDir)) continue
      for (const name of readdirSync(lcmDir)) {
        if (/^meter(-\d{6})?\.jsonl$/.test(name)) found.push({ file: join(lcmDir, name), project: dirname(lcmDir) })
      }
    }
    if (found.length === 0) { console.log('[lcm] 未发现可导入的旧计量文件'); return 0 }
    if (dryRun) {
      let total = 0
      for (const { file, project } of found) {
        const n = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).length
        total += n
      }
      console.log(`[lcm] dry-run：共 ${found.length} 个文件 / ${total} 事件，未写入`)
      return 0
    }
    mkdirSync(cfg.meterDir, { recursive: true })
    const archivePath = join(cfg.meterDir, 'meter-000000.jsonl')
    let imported = 0
    let total = 0
    const failed = []
    for (const { file, project } of found) {
      const lines = []
      let n = 0
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue
        try { const e = JSON.parse(line); lines.push(JSON.stringify({ ...e, project: e.project ?? project })); n++ }
        catch { /* 坏行跳过 */ }
      }
      // 先追加后改名（逐文件）：改名失败仅影响该文件，提示人工改名防重复导入
      appendFileSync(archivePath, lines.join('\n') + '\n', 'utf8')
      try {
        renameSync(file, file + '.imported')
        imported++
        total += n
        console.log(`  ${file} → project=${project}（${n} 事件）`)
      } catch (e) {
        failed.push(file)
        console.error(`  ⚠ ${file} 已导入 ${n} 事件，但改名失败（${String(e?.code ?? e?.message)}）——请手动改名防重复导入`)
      }
    }
    console.log(`[lcm] 已导入 ${imported}/${found.length} 个文件 / ${total} 事件 → ${archivePath}（源文件已改名 *.imported）`)
    return failed.length > 0 ? 1 : 0
  }

  if (cmd === 'profile') {
    const prof = await import('./profile.mjs')
    const p = prof.getProfile(cfg, { force: Boolean(args.refresh) })
    if (!p || (!p.habit && !p.behavior)) {
      console.error(args.refresh ? '[lcm] 无可画像数据（会话日志/计量事件不足）' : '[lcm] 无缓存画像，先跑：lcm profile --refresh')
      return 1
    }
    if (args.json) { console.log(JSON.stringify(p, null, 2)); return 0 }
    const h = p.habit; const b = p.behavior
    console.log(`画像（${p.stale ? '缓存已过期，建议 lcm profile --refresh' : '缓存 ' + new Date(p.builtAt).toISOString().slice(0, 16).replace('T', ' ')}）`)
    if (b) console.log(`  行为：活跃 ${b.peakHours}｜注意力 ${b.attention.join('、')}｜会话中位 ${b.sessionMedian} 请求｜深潜 ${b.deepSessions} 个`)
    if (h) {
      console.log(`  习惯：${h.sessions} 会话 ${h.talks} talk｜意图 ${h.intentOrder.join('>')}`)
      console.log(`        开场 ${Object.entries(h.openers).map(([k, v]) => k + '×' + v).join(' ')}｜确认率 ${Math.round(h.confirmRate * 100)}%｜链 ${h.topChain}`)
      if (h.phrases?.length) console.log(`        口头禅：${h.phrases.map(([x, n]) => x + '(' + n + ')').join('、')}`)
      if (h.terms?.length) console.log(`        高频术语：${h.terms.slice(0, 8).map(([x, n]) => x + '(' + n + ')').join('、')}`)
    }
    console.log('── 常驻注入块（预算 ' + prof.PROFILE_MAX_CHARS + ' chars）──')
    console.log(prof.renderProfileBlock(cfg, p))
    return 0
  }

  if (cmd === 'memory') {
    const mem = await import('./memory.mjs')
    const sub = args._[0] ?? 'stats'
    if (sub === 'add') {
      if (!args.claim) { console.error('用法: lcm memory add --type fact --subject <主题> --claim <内容> [--keywords a,b]'); return 2 }
      const r = mem.record(cfg, {
        type: args.type ?? 'fact', subject: args.subject ?? 'manual', claim: args.claim,
        keywords: args.keywords ? String(args.keywords).split(',').map((s) => s.trim()).filter(Boolean) : [],
        source: 'manual',
      })
      console.log(`[lcm] ${r.action}${r.reason ? `（${r.reason}）` : ''}${r.id ? ` id=${r.id}` : ''}`)
      if (cfg.openvikingConfigured) await mem.flushOutbox(cfg).catch(() => {})
      return r.action === 'REJECT' ? 1 : 0
    }
    if (sub === 'list') {
      const all = args.all ? mem.loadAll(cfg) : mem.activeEntries(cfg)
      const rows = args.type ? all.filter((e) => e.type === args.type) : all
      for (const e of rows) {
        const date = new Date(e.ts ?? 0).toISOString().slice(0, 10)
        const flag = e.superseded_by ? '（已取代）' : ''
        console.log(`${date} [${e.type}] ${e.claim.startsWith(String(e.subject).slice(0, 20)) || !e.subject ? e.claim : e.subject + '：' + e.claim}${flag}  (${e.id})`)
      }
      console.error(`[lcm] ${rows.length} 条${args.all ? '（含历史）' : ''}`)
      return 0
    }
    if (sub === 'sweep') {
      const r = mem.enforceCapacity(cfg, { maxEntries: Number(args.max ?? mem.MEMORY_MAX_ENTRIES), dryRun: Boolean(args['dry-run']) })
      console.log(`[lcm] 记忆库容量：活跃 ${r.live} 条 / ${(r.bytes / 1024).toFixed(1)} KB`
        + `（上限 ${mem.MEMORY_MAX_ENTRIES} 条 / ${(mem.MEMORY_MAX_BYTES / 1024 / 1024).toFixed(0)} MB）`
        + `${r.over ? `｜归档 ${r.archived} 条${args['dry-run'] ? '（dry-run，未落盘）' : ''}` : '｜未超限，零改动'}`)
      return 0
    }
    if (sub === 'pin' || sub === 'unpin') {
      if (!args.id) { console.error(`用法: lcm memory ${sub} --id <条目 id>`); return 2 }
      const r = mem.setProfile(cfg, args.id, sub === 'pin')
      if (!r.ok) { console.error(`[lcm] 未找到条目 ${args.id}`); return 1 }
      console.log(`[lcm] ${sub === 'pin' ? '已晋升为画像条目' : '已从画像移除'}：${r.entry.subject || r.entry.claim.slice(0, 40)}`)
      return 0
    }
    if (sub === 'profile') {
      if (args.auto) {
        const r = mem.autoProfile(cfg)
        console.log(`[lcm] 自动晋升 ${r.promoted}｜自动降级 ${r.demoted}｜预算裁剪 ${r.trimmed}｜画像保留 ${r.kept}/${mem.PROFILE_MAX_ENTRIES}`)
      }
      const prof = mem.profileEntries(cfg)
      const chars = prof.reduce((n, e) => n + (e.subject?.length ?? 0) + (e.claim?.length ?? 0) + 4, 0)
      console.log(`画像条目 ${prof.length}/${mem.PROFILE_MAX_ENTRIES}（${chars}/${mem.PROFILE_MAX_CHARS} chars）`)
      for (const e of prof) {
        const src = e.promotedBy === 'pin' ? '📌' : '自动'
        console.log(`  ${src} [${e.type}] ${e.claim.startsWith(String(e.subject).slice(0, 20)) || !e.subject ? e.claim : e.subject + '：' + e.claim}  (${e.id})`)
      }
      return 0
    }
    if (sub === 'eval') {
      const ev = await import('./eval.mjs')
      const golden = ev.loadGolden(cfg, { rebuild: Boolean(args.rebuild) })
      const r = ev.runEval(cfg, golden, { k: Number(args.k ?? ev.EVAL_K), mode: args.mode ?? undefined, blend: Boolean(args.blend) })
      if (args.json) { console.log(JSON.stringify(r, null, 2)); return r.ok ? 0 : 1 }
      console.log(ev.renderEvalReport(r, golden))
      return r.ok ? 0 : 1
    }
    if (sub === 'search' || sub === 'inject') {
      if (!args.query) { console.error('用法: lcm memory search --query <查询> [--k 6]'); return 2 }
      const hits = mem.search(cfg, args.query, { k: Number(args.k ?? 6) })
      if (sub === 'search') {
        for (const e of hits) console.log(`[${e.type}] ${e.subject}：${e.claim}  (score ${e.score.toFixed(1)}, ${e.id})`)
        console.error(`[lcm] ${hits.length} 条命中`)
        return 0
      }
      const block = mem.renderInjectBlock(args.query, hits)
      if (!block) { console.error('[lcm] 无命中，无注入块'); return 0 }
      console.log(block)
      return 0
    }
    if (sub === 'sync') {
      const r = await mem.flushOutbox(cfg)
      console.log(`[lcm] 同步完成：发送 ${r.sent} 条，积压 ${r.remaining} 条${r.reason ? `（${r.reason}）` : ''}`)
      return r.remaining > 0 ? 1 : 0
    }
    // stats（默认）
    const all = mem.loadAll(cfg)
    const live = mem.activeEntries(cfg)
    const byType = {}
    for (const e of live) byType[e.type] = (byType[e.type] ?? 0) + 1
    console.log(`记忆库：${cfg.memoryDir}`)
    console.log(`  有效 ${live.length} 条 / 历史 ${all.length} 行${Object.keys(byType).length ? ' ｜ ' + Object.entries(byType).map(([t, n]) => `${t}×${n}`).join(' ') : ''}`)
    console.log(`  OpenViking：${cfg.openvikingConfigured ? `已配置（${cfg.openvikingUrl}，账号 ${cfg.openvikingAccount}）` : '未配置（本地库为唯一副本）'}`)
    console.log(`  同步积压：${mem.outboxPending(cfg).length} 条（lcm memory sync 冲账）`)
    return 0
  }

  if (cmd === 'value') {
    const { computeValue } = await import('./value.mjs')
    const events = await collectMeterEvents(cfg)
    // 时间窗：--days N
    const days = args.days ? Number(args.days) : 0
    const since = days > 0 ? Date.now() - days * 86_400_000 : 0
    const windowed = since > 0 ? events.filter((e) => (e.ts ?? 0) >= since) : events
    // provenance：默认只统计 sessionsDir 里真实存在的会话（排除合成/测试数据）；--all 关闭
    const known = args.all ? null : knownSessionIds(cfg)
    const valueOpts = { knownSessions: known }
    if (args['cache-factor']) valueOpts.cacheFactor = Number(args['cache-factor'])
    const v = computeValue(windowed, valueOpts)
    if (args.json) { console.log(JSON.stringify(v, null, 2)); return 0 }

    const M = (n) => Math.abs(n) >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1e3)}k`
    console.log(`价值记账（${v.sessions} 会话 / ${v.requests} 请求 · 折价因子 ${v.factor}`
      + `${days > 0 ? ` · 近 ${days} 天` : ''}`
      + ` · 反事实水位 ${M(v.ceiling.global)}[${v.ceiling.source}${v.ceiling.samples ? `×${v.ceiling.samples}` : ''}]`
      + `${known ? ' · 仅真实会话' : ' · 含未归因数据'}）`)
    console.log(`  实际成本当量    ${M(v.actualEq).padStart(8)} tok`)
    console.log(`  反事实（无 lcm）${M(v.counterfactualEq).padStart(8)} tok（上界口径：假设无 lcm 时内容一直留在历史中）`)
    console.log('  ── 已实现节省 ──────────────────────')
    console.log(`  ① 压缩臂  ${M(v.realized.compress).padStart(8)}（1.0× 档：reshape 内容的首个承载请求 + 后续折价）`)
    console.log(`  ② 剪枝臂  ${M(v.realized.prune).padStart(8)}（折价 × 后续请求数，击穿请求按 1.0×）`)
    console.log(`  ③ 折叠臂  ${M(v.realized.fold).padStart(8)}（同剪枝机制）`)
    console.log(`  ⑤ 注入开销 −${M(v.injectionCost).padStart(7)}（负项：注入 ${v.memory.injects} 次 / 命中 ${v.memory.entries} 条）`)
    console.log(`  净节省    ${M(v.net).padStart(8)} = ${(v.netPct * 100).toFixed(1)}%（占反事实）`)
    console.log('  ── 单列（不计入净节省）─────────────')
    console.log(`  避免的击穿（piggyback）${M(v.avoidedBust)}（改写落在冷窗口，省下热窗口整段重发）`)
    if (v.estimated.staticTrimPerRequest > 0) console.log(`  静态裁剪（估算，前缀层）每请求 −${v.estimated.staticTrimPerRequest.toLocaleString()} tok`)
    if (v.cappedRequests > 0) console.log(`  被窗口夹住的请求 ${v.cappedRequests} 个（这部分内容本来也发不出去）`)
    console.log(`  交叉验证：载荷口径省 ${(v.payload.pct * 100).toFixed(1)}% vs 成本当量 ${(v.netPct * 100).toFixed(1)}%`
      + `（ratio ${v.xcheck.ratio == null ? '—' : v.xcheck.ratio.toFixed(2)} ∈ [0.3, 3]）`
      + `${v.xcheck.consistent ? ' ✓ 同向同量级' : ' ✗ 不一致——模型有 bug，勿信此账'}`)
    console.log('  口径：realized 已实现 / avoided 避免 / estimated 估算，三者严格分开。')
    return 0
  }

  console.error('用法: lcm <compress|read|recover|report|value|compare|sweep|stat|trim-diff|migrate|memory|profile>')
  return 2
}

main().then((code) => process.exit(code)).catch((e) => {
  console.error(`[lcm] ${String(e?.message ?? e)}`)
  process.exit(1)
})
