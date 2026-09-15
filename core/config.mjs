/** 配置与项目根探测（Node 版）。
 *
 * 优先级：
 * - 项目根：process.env.LCM_ROOT > git root > cwd
 * - 计量根（meter）：参数 meterRoot > LCM_METER_ROOT > config.json meter.root
 *   > 全局 ~/.lcm（默认；事件带 project 字段，report/compare 跨项目聚合）。
 *   旧版按项目落 <root>/.lcm/meter*.jsonl，meterFiles 仍会读回（含 migrate 迁移）。
 * - OpenViking：环境变量 LCM_OPENVIKING_URL + LCM_OPENVIKING_API_KEY，
 *   或 ~/.config/lcm/config.json 中 {"openviking": {...}}
 * - 未配置 OpenViking → spill/记忆降级为项目级本地目录 <root>/.lcm/
 */

import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export function findRoot() {
  if (process.env.LCM_ROOT) return resolve(process.env.LCM_ROOT)
  try {
    const out = execSync('git rev-parse --show-toplevel', { timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim()
    if (out) return resolve(out)
  } catch { /* 不在 git 仓库 */ }
  return process.cwd()
}

/** 计量根解析：参数 > 环境变量 > 配置文件 > 全局 ~/.lcm。 */
export function findMeterRoot(explicit) {
  if (explicit) return resolve(explicit)
  if (process.env.LCM_METER_ROOT) return resolve(process.env.LCM_METER_ROOT)
  const cfgFile = join(homedir(), '.config', 'lcm', 'config.json')
  if (existsSync(cfgFile)) {
    try {
      const data = JSON.parse(readFileSync(cfgFile, 'utf8'))
      if (typeof data.meter?.root === 'string' && data.meter.root) return resolve(data.meter.root)
    } catch { /* 配置损坏不致命 */ }
  }
  return join(homedir(), '.lcm')
}

export function loadConfig(root = findRoot(), { meterRoot } = {}) {
  const cfg = {
    root,
    openvikingUrl: process.env.LCM_OPENVIKING_URL || null,
    openvikingApiKey: process.env.LCM_OPENVIKING_API_KEY || null,
    openvikingAccount: 'default',
    openvikingUser: 'libre',
    // —— spill 卫生策略（docs/05 Phase 1）——
    // 剪枝省的是 token，不是磁盘：spill 原文要落盘，所以必须有上限与保留期。
    spillMaxBytes: 512 * 1024 * 1024,   // 目录容量上限，超出按「最旧优先」清理
    spillTtlDays: 30,                   // 保留期；0 = 不按时间清理
    meterMonthly: true,                 // 计量按月轮转（meter-YYYYMM.jsonl）
    sessionsDir: join(homedir(), '.dsh', 'sessions'), // recover 兜底扫描根
  }
  const cfgFile = join(homedir(), '.config', 'lcm', 'config.json')
  if (existsSync(cfgFile)) {
    try {
      const data = JSON.parse(readFileSync(cfgFile, 'utf8'))
      const ov = data.openviking ?? {}
      cfg.openvikingUrl = cfg.openvikingUrl || ov.url || null
      cfg.openvikingApiKey = cfg.openvikingApiKey || ov.api_key || null
      cfg.openvikingAccount = ov.account ?? cfg.openvikingAccount
      cfg.openvikingUser = ov.user ?? cfg.openvikingUser
      const sp = data.spill ?? {}
      if (Number.isFinite(sp.max_bytes)) cfg.spillMaxBytes = sp.max_bytes
      if (Number.isFinite(sp.ttl_days)) cfg.spillTtlDays = sp.ttl_days
      if (typeof data.sessions_dir === 'string') cfg.sessionsDir = data.sessions_dir
    } catch { /* 配置损坏不致命：降级本地 */ }
  }
  // 凭据兜底：复用 ov CLI 的配置文件（~/.openviking/ovcli.conf，{url, api_key}），
  // 不复制密钥、零额外配置——装了 ov 的机器上 lcm 自动获得 OpenViking 同步能力。
  if (!cfg.openvikingUrl || !cfg.openvikingApiKey) {
    const ovcli = join(homedir(), '.openviking', 'ovcli.conf')
    if (existsSync(ovcli)) {
      try {
        const data = JSON.parse(readFileSync(ovcli, 'utf8'))
        cfg.openvikingUrl = cfg.openvikingUrl || (typeof data.url === 'string' ? data.url : null)
        cfg.openvikingApiKey = cfg.openvikingApiKey || (typeof data.api_key === 'string' ? data.api_key : null)
      } catch { /* 损坏静默 */ }
    }
  }
  // 测试密封性开关：LCM_OPENVIKING_DISABLED=1 强制视为未配置
  // （ovcli.conf 兜底会让装了 ov 的机器上所有测试意外「已配置」并发真实网络请求）
  if (process.env.LCM_OPENVIKING_DISABLED === '1') {
    cfg.openvikingUrl = null
    cfg.openvikingApiKey = null
  }
  cfg.openvikingConfigured = Boolean(cfg.openvikingUrl && cfg.openvikingApiKey)
  cfg.localDir = join(root, '.lcm')
  cfg.spillDir = join(cfg.localDir, 'spill')
  // 计量根：全局统一（默认 ~/.lcm，事件带 project 字段）；<root>/.lcm 作为旧数据源仍可读
  cfg.meterDir = findMeterRoot(meterRoot)
  cfg.legacyMeterDir = cfg.localDir
  cfg.meterFile = join(cfg.meterDir, 'meter.jsonl')
  // 记忆库：同样全局（~/.lcm/memories）——记忆是用户级资产，不按项目分割
  cfg.memoryDir = join(cfg.meterDir, 'memories')
  return cfg
}
