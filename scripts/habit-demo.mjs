#!/usr/bin/env node
/** 习惯画像 demo：只扫 user 消息（跳过插件注入），提炼跨会话的 talk 模式。
 *
 * 习惯画像 ≠ 工作画像（内容层，来自全部轮次）≠ 行为画像（统计层，来自 meter）：
 * 它是「用户怎么说话/下指令/推进 session」的模式层——只存在于 user 的 talk 里。
 *
 * 提炼维度（全确定性）：
 *   1. 意图分布：每条 user 消息的意图分类（理解/行动/验证/确认/扩展）
 *   2. 开场模式：每个 session 第一条 user 消息的意图（怎么启动一个会话）
 *   3. 确认习惯：反问句率（「你能理解吗？」「对吗？」）——边推进边校准
 *   4. 跨会话重复句式：字符 n-gram 在 ≥2 个会话重现（固定表达 = 习惯）
 *   5. 推进节奏：session 内意图转移（理解→行动→验证 的典型链）
 */

import { readdirSync, statSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readSessionLog } from '../core/recover.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const SESSIONS_ROOT = resolve(HERE, '../../../.dsh/sessions')

// ---------- 收集 user talk ----------
function userTalksOf(logPath) {
  const out = []
  let text
  try { text = readSessionLog(logPath) } catch { return out }
  for (const line of text.split('\n')) {
    if (!line.trim().startsWith('{')) continue
    let ev; try { ev = JSON.parse(line) } catch { continue }
    if (ev.type === 'user/message' && ev.data?.source?.kind === 'user') {
      const t = (ev.data.content ?? []).filter((b) => b?.type === 'text').map((b) => b.text).join('\n').trim()
      if (t) out.push(t)
    }
  }
  return out
}

const sessions = []
for (const proj of readdirSync(SESSIONS_ROOT)) {
  const dir = join(SESSIONS_ROOT, proj)
  if (!statSync(dir).isDirectory()) continue
  for (const d of readdirSync(dir)) {
    const log = join(dir, d, 'session.jsonl.zstd')
    if (existsSync(log)) sessions.push({ project: proj.split('--').filter(Boolean).pop(), log, talks: userTalksOf(log) })
  }
}
const withTalks = sessions.filter((s) => s.talks.length >= 2)

// ---------- 1. 意图分类（确定性关键词） ----------
const INTENTS = [
  ['确认', /(能理解|你能理解|对吗|可以吗|是吗|理解吗|明白吗|你觉得|你说)/],
  ['验证', /(测试|benchmark|跑一下|对比|验证|评测|先修.*然后.*跑|检验)/],
  ['理解', /(理解|分析|看看|研究|为什么|怎么|什么|是否|梳理|读一下|了解)/],
  ['行动', /(修复|开始|实现|直接做|动手|加上|写一个|改|提交|推送|开工)/],
  ['扩展', (t) => t.length > 0,],   // 兜底
]
function intentOf(t) { for (const [name, pat] of INTENTS) if (pat instanceof RegExp ? pat.test(t) : pat(t)) return name; return '扩展' }

const intentCount = {}
const openers = {}
const chains = []
let confirmStyle = 0
let total = 0
for (const s of withTalks) {
  const seq = s.talks.map(intentOf)
  chains.push(seq)
  openers[seq[0]] = (openers[seq[0]] ?? 0) + 1
  for (const [i, t] of s.talks.entries()) {
    total++
    intentCount[seq[i]] = (intentCount[seq[i]] ?? 0) + 1
    if (seq[i] === '确认') confirmStyle++
  }
}

// ---------- 2. 跨会话重复句式（词级短语，≥2 会话重现；中文/实词优先） ----------
const WORD_RE = /[\u4e00-\u9fa5]{2,}|[a-zA-Z]{3,}/g    // 中文词段 / 英文实词
const phraseSessions = new Map()   // phrase → Set(sessionIdx)
for (const [si, s] of withTalks.entries()) {
  const seen = new Set()
  for (const t of s.talks) {
    const words = t.match(WORD_RE) ?? []
    // 相邻双词短语（bigram）：足以捕捉「开始修复」「跑一下」「先...然后」类固定搭配
    for (let i = 0; i + 1 < words.length; i++) {
      const g = words[i] + words[i + 1]
      if ([...g].length >= 4) seen.add(g)
    }
    for (const w of words) if ([...w].length >= 3) seen.add(w)   // 单长词也计
  }
  for (const g of seen) {
    if (!phraseSessions.has(g)) phraseSessions.set(g, new Set())
    phraseSessions.get(g).add(si)
  }
}
const repeatPhrases = [...phraseSessions.entries()]
  .filter(([, set]) => set.size >= 3)          // ≥3 会话才算习惯（2 会话偶合多）
  .sort((a, b) => b[1].size - a[1].size)
const STOP = new Set(['the','and','for','with','that','this','from','have','not','are','was','you','your','can','now','com','www','https','http','name','message','token','tokens','user','test','will','all','out','get','set','use','one','two','review','inherited','completed','checkpoint','checkpointnow','reviewthe','theinherited','inheritedcompleted','completedcheckpoint','continue','condensing','earlier','span'])
const isCjk = (w) => /[\u4e00-\u9fa5]/.test(w)
const phrases = []   // 句式习惯（中文搭配优先）
const terms = []     // 高频术语（英文专有名词——词汇习惯的另一面）
for (const [g, set] of repeatPhrases) {
  const dup = (arr) => arr.some((p) => p.includes(g) || g.includes(p))
  if (isCjk(g)) { if (!dup(phrases)) phrases.push([g, set.size]) }
  else if (!STOP.has(g.toLowerCase()) && g.length >= 4) { if (!dup(terms)) terms.push([g, set.size]) }
}

// ---------- 3. 推进链（理解→行动→验证 的典型序列压缩） ----------
const chainSig = (seq) => {
  const out = []
  for (const x of seq) if (out[out.length - 1] !== x) out.push(x)
  return out.join('→')
}
const chainCount = {}
for (const c of chains) { const sig = chainSig(c); chainCount[sig] = (chainCount[sig] ?? 0) + 1 }

// ---------- 输出 ----------
const pct = (n) => ((n / Math.max(1, total)) * 100).toFixed(0) + '%'
console.log(`习惯画像 demo · ${withTalks.length} 个会话（共 ${sessions.length} 个，取有对话的）· ${total} 条 user talk`)
console.log('═'.repeat(70))
console.log()
console.log('── 1. 意图分布（用户怎么下指令）──')
console.log('  ' + Object.entries(intentCount).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${pct(v)}`).join('  ｜  '))
console.log()
console.log('── 2. 开场模式（session 第一句话的意图 = 怎么启动工作）──')
console.log('  ' + Object.entries(openers).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}开局 ×${v}`).join('  ｜  '))
console.log()
console.log(`── 3. 确认习惯（反问校准式推进）──`)
console.log(`  确认类 talk 占 ${pct(confirmStyle)}（「你能理解吗」式边推进边校准）`)
console.log()
console.log('── 4a. 句式习惯（≥3 会话重现的固定搭配）──')
for (const [p, n] of phrases.slice(0, 12)) console.log(`  「${p}」（${n} 会话）`)
console.log('── 4b. 高频术语（跨会话反复出现的专有名词 = 词汇习惯）──')
console.log('  ' + terms.slice(0, 14).map(([t, n]) => `${t}(${n})`).join('  '))
console.log()
console.log('  ⚠ 计数口径：DSH checkpoint 续接会把历史消息重放进分段会话，同一句式的')
console.log('    会话数因此偏虚高；方向可信、绝对值待按「独立对话链」去重后修正。')
console.log()
console.log('── 5. 推进链（去重压缩后的典型意图序列）──')
for (const [sig, n] of Object.entries(chainCount).sort((a, b) => b[1] - a[1]).slice(0, 6)) {
  console.log(`  ×${n}  ${sig.slice(0, 60)}`)
}
