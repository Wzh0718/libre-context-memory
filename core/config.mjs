/** 配置与项目根探测（Node 版）。
 *
 * 优先级：
 * - 项目根：process.env.LCM_ROOT > git root > cwd
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

export function loadConfig(root = findRoot()) {
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
  cfg.openvikingConfigured = Boolean(cfg.openvikingUrl && cfg.openvikingApiKey)
  cfg.localDir = join(root, '.lcm')
  cfg.spillDir = join(cfg.localDir, 'spill')
  cfg.meterFile = join(cfg.localDir, 'meter.jsonl')
  return cfg
}
