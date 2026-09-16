#!/usr/bin/env node
/** 离线正式验收（**不需要重启 DSH**）：把所有放行门跑一遍，产出报告 + 退出码。
 *
 * 为什么可以离线正式验收：五臂改的是「每一轮请求的载荷」，而 DSH 把每一轮的
 * usage（真实 fresh/cacheRead）、以及臂动作（compress/prune/fold）都写进了 meter；
 * 会话原文（含工具输出全文）完整落在 ~/.dsh/sessions 的 jsonl 里。于是
 * 「压缩/剪枝/折叠/静态裁剪/记忆」在真实历史会话上的效果可以完整回放测量——
 * 这与在线跑相比只少了「实时性」，不缺任何数据。
 *
 * 重启才能验的是另一类东西（在线验收）：新代码进入活会话、shadow→active 切换、
 * 热路径时延、真实冷窗口是否按纪律触发。见 README「验收」一节。
 *
 * 用法：node scripts/acceptance.mjs [--with-bench N]   # N = 回放会话数（慢，默认跳过）
 */

import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const ROOT = process.cwd()
const withBenchIdx = process.argv.indexOf('--with-bench')
const BENCH_N = withBenchIdx >= 0 ? Number(process.argv[withBenchIdx + 1] ?? 6) : 0

const results = []
const lines = []
function say(s = '') { lines.push(s); console.log(s) }

async function gate(name, cmd, args, opts = {}) {
  const t0 = Date.now()
  try {
    const { stdout, stderr } = await run(cmd, args, {
      cwd: opts.cwd ?? ROOT,
      env: { ...process.env, LCM_OPENVIKING_DISABLED: '1', ...(opts.env ?? {}) },
      maxBuffer: 64 * 1024 * 1024,
      timeout: opts.timeout ?? 20 * 60_000,
    })
    const verdict = opts.check ? opts.check(stdout, stderr) : { ok: true, detail: '' }
    results.push({ name, ok: verdict.ok, detail: verdict.detail, ms: Date.now() - t0 })
    say(`  ${verdict.ok ? '✓' : '✗'} ${name.padEnd(22)} ${verdict.detail}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`)
    return { stdout, stderr, ...verdict }
  } catch (e) {
    const out = `${e.stdout ?? ''}\n${e.stderr ?? ''}`.trim()
    const tail = out.split('\n').slice(-6).join('\n    ')
    results.push({ name, ok: false, detail: `失败（exit ${e.code ?? '?'}）`, ms: Date.now() - t0 })
    say(`  ✗ ${name.padEnd(22)} 失败（exit ${e.code ?? '?'}）  (${((Date.now() - t0) / 1000).toFixed(1)}s)`)
    if (tail) say(`    ${tail}`)
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', ok: false }
  }
}

say('离线正式验收（真实会话数据回放，不需要重启 DSH）')
say('═'.repeat(74))

// G1 单元 + 契约
await gate('core 单测', 'node', ['--test', 'core/test/core.test.mjs', 'core/test/memory.test.mjs',
  'core/test/profile.test.mjs', 'core/test/eval.test.mjs', 'core/test/value.test.mjs'], {
  check: (out) => {
    const fail = Number(/^# fail (\d+)/m.exec(out)?.[1] ?? '-1')
    const pass = Number(/^# pass (\d+)/m.exec(out)?.[1] ?? '0')
    return { ok: fail === 0, detail: `${pass} pass / ${fail} fail` }
  },
})
await gate('DSH 契约测试', 'node', ['--test', 'test/contract.test.js'], {
  cwd: join(ROOT, 'adapters/dsh'),
  check: (out) => {
    const fail = Number(/^# fail (\d+)/m.exec(out)?.[1] ?? '-1')
    const pass = Number(/^# pass (\d+)/m.exec(out)?.[1] ?? '0')
    return { ok: fail === 0, detail: `${pass} pass / ${fail} fail` }
  },
})

// G2 金标放行门（记忆质量）：跨会话 recall@6 ≥ 0.8 且反例击穿 = 0
const evalStore = join(ROOT, '.eval-lcm')
if (existsSync(join(evalStore, 'memories', 'memories.jsonl'))) {
  await gate('金标放行门（记忆）', 'node', ['core/cli.mjs', 'memory', 'eval', '--json'], {
    env: { LCM_METER_ROOT: evalStore },
    check: (out) => {
      try {
        const r = JSON.parse(out)
        const cross = r.primary?.recall ?? r.recall ?? null
        const total = r.primary?.total ?? null
        const pen = r.penetration ?? 0
        const contam = r.contamination
        const ok = cross != null && cross >= 0.8 && pen === 0 && contam === 0
        return {
          ok,
          detail: `跨会话 recall@6 ${cross == null ? '—' : (cross * 100).toFixed(1) + '%'}`
            + `${total ? `（${total} 对）` : ''} ｜ 反例击穿 ${pen}`
            + ` ｜ 跨项目污染 ${contam == null ? '—' : (contam * 100).toFixed(1) + '%'}`
            + `${ok ? '' : '（门槛 recall<80% / 击穿>0 / 污染>0 / 字段缺失）'}`,
        }
      } catch { return { ok: false, detail: '输出无法解析为 JSON' } }
    },
  })
} else {
  say('  – 金标放行门            跳过（无 .eval-lcm 库；先跑 scripts/eval-prep.mjs 回填）')
}

// G3 价值记账互证门（成本当量口径 vs 载荷口径）
await gate('价值互证门', 'node', ['scripts/value-xcheck.mjs'], {
  check: (out) => {
    const ratio = /ratio = ([\d.]+)/.exec(out)?.[1]
    const ok = out.includes('✓ 同向同量级')
    return { ok, detail: `ratio ${ratio ?? '—'} ｜ ${ok ? '互证通过' : '不一致（模型有 bug）'}` }
  },
})

// G4 真实会话端到端回放（真实适配器 + 真实日志）
if (existsSync(join(ROOT, 'scripts/e2e-verify.mjs'))) {
  await gate('真实会话端到端', 'node', ['scripts/e2e-verify.mjs'], {
    timeout: 10 * 60_000,
    check: (out) => {
      const warn = Number(/warn (\d+) 条/.exec(out)?.[1] ?? '-1')
      const entries = /记忆条目[^\d]*(\d+)/.exec(out)?.[1]
      return { ok: warn === 0, detail: `warn ${warn}${entries ? ` ｜ 熔炼 ${entries} 条` : ''}` }
    },
  })
}

// G5 载荷口径基准（可选，慢）
if (BENCH_N > 0) {
  await gate(`载荷口径基准（${BENCH_N} 会话）`, 'node', ['scripts/bench-all.mjs', String(BENCH_N), '4'], {
    timeout: 40 * 60_000,
    check: (out) => {
      // 真实格式：累计载荷：X → Y tok （省 Z tok = 17.6%）
      const line = out.split('\n').find((l) => l.includes('累计载荷')) ?? ''
      const pct = /= ([\d.]+)%/.exec(line)?.[1]
      if (pct == null) return { ok: false, detail: '未找到合计行（bench-all 可能提前退出或输出格式变了）' }
      const ok = Number(pct) > 0
      return { ok, detail: `累计载荷省 ${pct}%` }
    },
  })
} else {
  say('  – 载荷口径基准          跳过（加 --with-bench N 开启；慢，需回放会话）')
}

// ── 汇总 ──
const failed = results.filter((r) => !r.ok)
say('═'.repeat(74))
say(`${results.length} 个门：${results.length - failed.length} 通过 / ${failed.length} 失败`)
if (failed.length) say(`失败：${failed.map((f) => f.name).join('、')}`)
else say('全部放行门通过——离线正式验收成立（新代码可进 shadow→active 评审）')

const reportPath = join(ROOT, 'docs', 'acceptance-report.txt')
mkdirSync(join(ROOT, 'docs'), { recursive: true })
writeFileSync(reportPath, `# 离线正式验收报告 ${new Date().toISOString()}\n`
  + `# 主机 ${homedir()} · 会话数据源 ~/.dsh/sessions · meter 多根\n\n`
  + lines.join('\n') + '\n', 'utf8')
console.log(`\n报告：${reportPath}`)
process.exit(failed.length ? 1 : 0)
