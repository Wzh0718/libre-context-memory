#!/usr/bin/env node
/** 把 dsh-lcm 适配器 + 核心引擎打成一个**自包含**的 npm 包（可被 DSH 直接安装）。
 *
 * 为什么需要：仓库里适配器用相对路径 ../../../core/*.mjs 引用核心；一旦按
 * node_modules 安装，仓库外的 core/ 不存在 → 必须把 core 一起打进包里，
 * 并把引用改写成包内相对路径 ../core/*.mjs。
 *
 * 产出：dist/dsh-lcm-<version>.tgz
 * 验证：在 dist/dsh-lcm/ 就地跑适配器契约测试（证明打包产物自身可用，而非只信构建）
 *
 * 用法：node scripts/build-package.mjs [version]
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIST = join(REPO, 'dist')
const OUT = join(DIST, 'dsh-lcm')
const PKG_SRC = join(REPO, 'adapters', 'dsh')

const version = process.argv[2] ?? JSON.parse(readFileSync(join(PKG_SRC, 'package.json'), 'utf8')).version

console.log(`[build] 组装自包含包 dsh-lcm@${version}`)
rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

// 1) 适配器源码 + 元数据
cpSync(join(PKG_SRC, 'src'), join(OUT, 'src'), { recursive: true })
cpSync(join(PKG_SRC, 'test'), join(OUT, 'test'), { recursive: true })
cpSync(join(PKG_SRC, 'cordis.patch.yml'), join(OUT, 'cordis.patch.yml'))
cpSync(join(PKG_SRC, 'README.md'), join(OUT, 'README.md'))

// 2) 核心引擎（自包含的关键）
mkdirSync(join(OUT, 'core'), { recursive: true })
for (const name of readdirSync(join(REPO, 'core'))) {
  if (name.endsWith('.mjs')) cpSync(join(REPO, 'core', name), join(OUT, 'core', name))
}

// 3) 相对引用改写：../../../core/ → ../core/（src 与 test 一致）
const CORE_REF = /\.\.\/\.\.\/\.\.\/core\//g
let rewritten = 0
for (const dir of ['src', 'test']) {
  for (const name of readdirSync(join(OUT, dir))) {
    if (!name.endsWith('.js')) continue
    const file = join(OUT, dir, name)
    const text = readFileSync(file, 'utf8')
    if (!CORE_REF.test(text)) continue
    CORE_REF.lastIndex = 0
    writeFileSync(file, text.replace(CORE_REF, '../core/'), 'utf8')
    rewritten++
  }
}
console.log(`[build] 引用改写：${rewritten} 个文件`)

// 4) 包元数据：files 白名单 + dsh 装载契约
const pkg = JSON.parse(readFileSync(join(PKG_SRC, 'package.json'), 'utf8'))
pkg.version = version
pkg.files = ['src', 'core', 'cordis.patch.yml', 'README.md']
pkg.description = 'libre-context-memory 的 DSH 适配器（自包含：压缩/剪枝/观测/静态层裁剪四臂）'
writeFileSync(join(OUT, 'package.json'), JSON.stringify(pkg, null, 2) + '\n', 'utf8')

// 5) 完整性自检：包内不得残留仓库外引用
const leaks = []
for (const dir of ['src', 'test']) {
  for (const name of readdirSync(join(OUT, dir))) {
    if (!name.endsWith('.js')) continue
    const text = readFileSync(join(OUT, dir, name), 'utf8')
    if (text.includes('../../../')) leaks.push(`${dir}/${name}`)
  }
}
if (leaks.length) {
  console.error(`[build] ❌ 包内仍有仓库外相对引用：${leaks.join(', ')}`)
  process.exit(1)
}
if (!existsSync(join(OUT, 'core', 'compress.mjs'))) {
  console.error('[build] ❌ 核心未打入包内')
  process.exit(1)
}

// 6) 就地验证：跑打包产物的契约测试（这是对「包能不能用」最直接的证明）
console.log('[build] 验证打包产物：运行包内契约测试')
try {
  execFileSync('node', ['--test', 'test/*.test.js'], { cwd: OUT, stdio: ['ignore', 'pipe', 'pipe'] })
  console.log('[build] ✅ 包内测试通过')
} catch (error) {
  console.error('[build] ❌ 包内测试失败')
  process.stderr.write(String(error.stdout ?? '') + String(error.stderr ?? ''))
  process.exit(1)
}

// 7) 打 tarball
// npm 需要可写的缓存目录（沙箱/CI 下 ~/.npm 可能只读）→ 指定仓库内缓存
const npmCache = join(REPO, '.npm-cache')
mkdirSync(npmCache, { recursive: true })
execFileSync('npm', ['pack', '--pack-destination', DIST], {
  cwd: OUT,
  stdio: ['ignore', 'inherit', 'inherit'],
  env: { ...process.env, npm_config_cache: npmCache, npm_config_update_notifier: 'false' },
})
const tarball = readdirSync(DIST).find((n) => n.endsWith('.tgz'))
console.log(`[build] ✅ 产出 ${join(DIST, tarball)}`)
console.log(`[build] 安装：dsh plugin --profile web add ${join(DIST, tarball)}`)
