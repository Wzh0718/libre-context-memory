# libre-context-memory

> **LLM agent 上下文治理：让每一轮重发的内容都变小。**
> 采集 → 分析 → 压缩 → 剪枝 → 记忆提取，全程实测数据驱动、量化验收。

Agent 每轮的 token 账单里，**真正新增的内容往往只占极小一部分**——实测 Codex 每请求新增内容中位仅 **679 tokens**，其余全是「已经在上下文里、却每轮都要重发一遍」的旧内容。本项目不改变协议、不修改框架内核，而是以**插件/hook** 形式在框架内治理这部分重复体积。

---

## 目录

- [问题：钱花在哪了](#问题钱花在哪了)
- [方案：四条臂](#方案四条臂)
- [实测数据](#实测数据)
- [架构](#架构)
- [快速开始](#快速开始)
- [测试](#测试)
- [诚实边界](#诚实边界)
- [文档](#文档)

---

## 问题：钱花在哪了

真实数据（DSH 采集 1,910 个请求 + Codex 采集 25,822 个请求）给出的结论：

| 现象 | 实测数字 |
|---|---|
| Codex 每请求**真正新增**的内容 | 中位 **679 est tokens** |
| Codex 工具输出长尾 | **0.30%** 的工具调用贡献了 **55.5%** 的工具输出体积 |
| 单个工具输出极值 | **7,723,459 字符**（且 94 个大输出中 99.9% 是内联 base64） |
| DSH 静态地板（工具定义 + skills 注入 + system） | **28.3k tokens/请求**，长会话占 11%，短会话占 **45~100%** |
| DSH 缓存命中率 | 94.3%~96.3%（健康），但**击穿时**整段前缀全价重算 |

单请求成分透视（一次真实的 258k est tokens 请求）：

| 段类型 | tokens | 占比 | 位置 |
|---|---|---|---|
| tool_result | 158,547 | 61.4% | 会话中段 |
| assistant_message | 52,403 | 20.3% | 会话中段 |
| **tool_definition ×73** | **15,767** | **6.1%** | **ordinal 1–73（最前端）** |
| user_message | 12,820 | 5.0% | — |
| **injection（skills 等）** | **9,732** | **3.8%** | ordinal 74+ |
| tool_call | 6,184 | 2.4% | — |
| system | 2,814 | 1.1% | ordinal 0 |

**成本模型**：`当量 = fresh + 0.1 × cached`。单条内容的终身成本 = `体积 × 重发轮数 × 单价` —— 三个乘数各有对应手段。

---

## 方案：四条臂

| 臂 | 钩子 | 治理对象 | 策略 |
|---|---|---|---|
| **① 压缩臂** | `tools/post-execute` | 单条超大工具输出 | 入库即压缩：>20k 字符 → 结构化摘要 + 可回取句柄（类型分流：log/json/jsonl/diff/table/filelist/code/generic） |
| **② 剪枝臂** | `agent/pre-step` | 存量工具输出 | **搭便车驱动**：只在缓存本来就要失效时（`compaction/*` 事件后 / 观测到击穿后 / subagent fork 首请求前）才改写历史；`budgetTokens` 只做「值不值得剪」的守卫；保留 `pruneProactive` 开关给超长会话 |
| **③ 观测臂** | `session/event` | 每请求缓存账本 | 每轮记 fresh/cached/命中率/击穿苗头 + 折叠事件，落 meter |
| **④ 静态层裁剪臂** | `system-prompt/assemble` | 工具定义注入 | **会话无关的确定性裁剪**（描述降噪 + 按族丢弃）；因工具定义在缓存前缀最前端，中途改动会击穿整个前缀，故只做「同输入必得逐字节同输出」的裁剪 |
| **⑤ 记忆臂** | `session/event` + `agent/pre-step` | 对话知识（事实/决策/未决/结论） | 提取：搭 `compaction/summary` 便车，确定性提取入本地库（四选一写入决策 + 禁写过滤）；注入：按最近用户消息检索，**请求尾部追加**稳定块（digest 节流，前缀安全）；OpenViking 双写同步（outbox 兜底） |

**为什么不只是压缩**：压缩解决「单条太肥」，剪枝解决「太多旧内容一直躺在热区」，静态层裁剪解决「每轮固定交税」，观测解决「看不见就治不了」。

---

## 实测数据

### 1. 压缩比（真实数据回放，225.1M 字符）

数据源：Codex 采集库里的真实工具输出 blob（high 带 >100k 字符 94 个 + mid 带 20k–100k 抽样 50 个）。
运行：`node --experimental-sqlite scripts/replay_blobs.mjs`

| 带 | 类型 | 样本数 | 原始字符 | 压缩后字符 | 整体压缩比 | 中位 | 最小 | 区间下限 | 达标 |
|---|---|---|---|---|---|---|---|---|---|
| high | generic | 92 | 214,691,870 | 49,733 | **4316.9×** | 3134.2× | 109.2× | 10× | ✅ |
| high | filelist | 2 | 8,835,379 | 2,500 | **3534.2×** | 4999.1× | 1164.1× | 20× | ✅ |
| mid | generic | 19 | 648,224 | 60,353 | **10.7×** | 14.7× | 2.9× | 10× | ✅ |
| mid | table | 12 | 318,260 | 4,235 | **75.1×** | 78.2× | 38.8× | 20× | ✅ |
| mid | diff | 8 | 271,902 | 1,242 | **218.9×** | 442.6× | 76.2× | 5× | ✅ |
| mid | json | 9 | 267,203 | 738 | **362.1×** | 336.4× | 289.1× | 10× | ✅ |
| mid | passthrough | 2 | 38,778 | 38,778 | 1.0× | 1.0× | 1.0× | — | ⏭️ 设计内直通 |

**整体：225,071,616 → 157,579 字符 = 1428.3×｜确定性校验 144/144 通过**（同输入两次压缩逐字节相同——这是缓存安全的前提）

### 2. 静态层裁剪（真实 73 个工具定义）

| 族 | 工具数 | tokens | 描述字符 |
|---|---|---|---|
| 内置工具 | 44 | 10,265 | 19,677 |
| mcp__openviking | 15 | 3,313 | 6,141 |
| mcp__dbx | 13 | 1,790 | 1,066 |
| mcp__codegraph | 1 | 399 | 582 |
| **合计** | **73** | **15,767** | **27,466** |

描述降噪收益（描述约占工具块 44%，其余是**不可动**的参数 schema）：

| 描述上限 | 省下字符 | 占比 | 裁剪条数 | 估算节省 |
|---|---|---|---|---|
| 120 | 20,932 | 76% | 52 | ~5,233 tok/请求 |
| **300（默认）** | **14,955** | **54%** | **29** | **~3,739 tok/请求** |
| 500 | 10,519 | 38% | 15 | ~2,630 tok/请求 |

**静态层占比随上下文规模变化**（1,910 个真实请求，中位数）：

| 上下文规模 | 请求数 | 静态层占比 |
|---|---|---|
| <20k | 15 | **100%** |
| 20k–60k | 238 | **45.5%** |
| 60k–150k | 893 | **21.3%** |
| >150k | 764 | 11.1% |

→ 会话越长，工具输出/对话越占主导；**会话越短，静态层越是大头**（新会话开局是静态层的天下）。两类优化互补。

### 3. 线上实测（本仓库会话，真实 meter 数据）

本地运行记录（`.lcm/meter-*.jsonl`，194 个请求 / 5 个会话）：

| 指标 | 实测值 |
|---|---|
| 缓存命中率 | **94.7%**（fresh 2,073,334 / cached 37,156,480） |
| 稳态每请求 | fresh 中位 **207 tokens**，cached 中位 **~180k tokens** |
| 缓存击穿 | **11 次**（fresh > 50k）——一次击穿 ≈ 整段前缀全价 |
| 剪枝臂触发 | 137 次（132 shadow + **5 active**），共 2,292 个节点 |
| 剪枝体积 | **12,801,572 → 2,624,675 字符** |
| 内置折叠事件 | 26 次 |
| 压缩臂决策 | 2 次（平均 47.3×） |

**首次 active 剪枝的完整链路**：

```
压力 277,970 tokens > 预算 100,000
  → 选中 22 个节点，117,180 → 26,092 字符（省约 45,544 tokens）
  → 下一轮实测会话总量 ≈ 248,766 tokens（−29k，与估算同量级）
```

### 4. token 消耗对比（`lcm compare`）

真实窗口（2026-09-11 → 09-15，全局计量根聚合，2419 请求 / 77 会话 / 7 个项目）：

```
实际（装 lcm）：      每请求当量 30,818 ｜ 命中率 93.9%
反事实（不装 lcm）：  每请求当量 35,268
治理掉的存量：119 次真剪枝/压缩，累计 1,180,041 tokens 退出热区
毛节省：+10,764,451 当量（+12.6%）
击穿成本：137 次前缀打穿（多付 22,646,644 当量），成因：重启/换会话 113 + compaction 24
归因 lcm 的击穿：0 次（搭便车生效——改写历史只发生在缓存本来要失效时）
净收益：+10,764,451 当量（+12.6%）
```

**账本还揭示了下一个瓶颈**：86.6% 的 fresh 来自 6.2% 的请求（击穿），其中 27 个冷会话
（subagent fork 单请求、几乎无缓存命中）烧掉 23.5% 的总 fresh——这就是「继承冷启动」
免费窗口的由来。另一次真实教训也记在这里：

```
早期窗口（232 请求，主动剪枝默认开）：
  毛节省 +3.1%，但主动改写历史制造 3 次击穿（510,930 当量）
  净收益 −3.2% ｜ 盈亏平衡：改写历史需后续 ≥104 个请求才回本
```

**这个负数促使我们把默认剪枝改成「搭便车」**：改写历史 = 打穿一次前缀（代价 ≈ 全价重发整段上下文），
而收益是「已治理体积 × 缓存价 × 后续轮数」——以本窗口实测参数（上下文 ~250k tokens、
一次剪掉 49k）计算，**主动制造击穿需要 ≥104 个后续请求才回本**。

→ 已实施的设计修正：默认 `pruneProactive: false`，只在缓存本来就要失效时（`compaction/*` 后、
观测到击穿后）才剪；此时改写历史免费，毛节省 +3.1% 不再被击穿成本吃掉。
`lcm compare` 就是这个判断的仪表盘——没有它，我们只会看到「压缩比很好看」而看不见净账。

### 5. 真实数据抓出的三个 bug（都已修 + 有回归测试）

| Bug | 症状 | 修复 |
|---|---|---|
| **关键词通道泄漏原文** | 80,000 字符的**无空格单行**被当成一个「关键词」，把原文经摘要漏回上下文（81,585 > 80,000） | 关键词上限 40 字符 + **不变式**：压缩产物必须小于原文，否则降级首尾保留 |
| **cordis 服务访问抛错被吞** | `ctx.tokenMeter` 在未声明 inject 时抛 `cannot get property without inject`，被 try/catch 吞掉 → 剪枝臂**静默失效** | 改用 `ctx.get('tokenMeter')`（免 inject 读取）+ 一次性可见告警 |
| **剪完立刻又剪 = 反复击穿** | 首次剪枝后每个新工具结果都触发一次单节点剪枝，每次击穿前缀（实测 fresh 96,242） | 剪枝**冷却**：剪完重新实测并设下次允许水位（`pruneCooldownTokens`，默认 10k） |

### 6. 存储卫生（真实数字）

剪枝省的是 token，**不是磁盘**——spill 原文要落盘，所以先有卫生措施再放水：

| 项 | 实测 |
|---|---|
| 压缩落盘 | brotli：**196,955 字节 → 7,546 字节（26×）**；压缩失败退化明文，绝不丢原文 |
| TTL / 容量上限 | 默认 30 天 / 512 MB，超限**最旧优先**清理；写入时机会性清扫（每 20 次写入或 10 分钟一次） |
| 计量轮转 | `meter-YYYYMM.jsonl`，兼容旧单文件 |
| 三级兜底 | spill 丢失 → `lcm recover <句柄>` 从 **DSH 会话日志**找回原文，端到端验证**逐字节一致** |

---

## 架构

```
libre-context-memory/
├── core/                     # 核心引擎（Node ESM，零 npm 依赖，可独立单测）
│   ├── compress.mjs          # 预处理（信封解包 / base64 剥离 / 超长行收缩）+ 8 类确定性压缩器
│   ├── spill.mjs             # 内容寻址原文存储（brotli）+ TTL/容量上限 + 双后端预留
│   ├── recover.mjs           # 从 DSH 会话日志兜底恢复原文（多帧 zstd 解码）
│   ├── meter.mjs             # 计量（JSONL，按月轮转，失败静默）
│   ├── config.mjs            # 根探测 + OpenViking 探测
│   └── cli.mjs               # compress / read / recover / report / sweep / stat
├── adapters/
│   └── dsh/                  # DSH 适配器（薄壳：事件翻译 + 失败静默，进程内直调核心）
├── scripts/
│   ├── replay_blobs.mjs      # Phase 0 回放测试（真实 Codex 数据）
│   └── replay-session-survival.test.mjs  # 会话存活验证（DSH 自己的 foldSurface）
├── docs/                     # 01 数据证据 / 02 策略 / 03 压缩设计 / 04 记忆设计 / 05 路线
└── reports/                  # 可复现的测量报告
```

**设计纪律**

- **核心与壳分离**：压缩/存储/计量/恢复全在 `core/`，适配器只做事件翻译 + 失败静默（任何异常 → 原文透传，绝不让治理逻辑变成会话故障）
- **零额外运行时**：宿主即 Node，不需要 Python；CC/Codex 侧走 `node core/cli.mjs`（stdin→stdout，hook 友好）
- **确定性优先**：能用确定性规则解决的绝不调 LLM（LLM 只作兜底）；压缩调用本身几乎全价，**绝不按计划定时压缩**
- **影价协议**：剪枝严格照抄 DSH 内置 pruner 协议（`compaction/prune` 影价事件 + 紧邻 `surfaceOp: replace` + `sourceEventSeqs`），保证回放可还原、计量不重复

---

## 快速开始

**要求**：Node ≥ 22（开发侧回放测试需要 `--experimental-sqlite`；运行时零依赖）

```bash
# 核心 CLI（可独立使用，hook 友好：stdin → stdout）
seq 1 20000 | node core/cli.mjs compress        # 压缩并落 spill，输出「摘要+句柄」
node core/cli.mjs read spill:<id> --grep ERROR  # 从句柄回取原文（支持 --from/--to/--head）
node core/cli.mjs recover spill:<id>            # spill 丢失时从会话日志找回
node core/cli.mjs report                        # 五段账本：缓存/静态层/剪枝/压缩/存储（全局聚合 + 按项目分组）
node core/cli.mjs report --project html_to_md   # 只看某个项目
node core/cli.mjs compare                       # token 消耗对比：实际 vs 反事实（不装 lcm）
node core/cli.mjs trim-diff                     # 静态层裁剪复核报告（shadow 期间自动采集的 before/after）
node core/cli.mjs migrate --base ~/project      # 旧版按项目落的计量数据导入全局根（源文件改名 *.imported）
node core/cli.mjs sweep                         # 手动执行存储清扫
```

**装进 DSH**（三选一，均为追加式安装，`remove` 即回滚）：

```bash
# ① 从发版包安装（推荐）：CI 产出的自包含 tarball，已内含 core，无需本仓库在场
dsh plugin --profile web add https://github.com/Wzh0718/libre-context-memory/releases/latest/download/dsh-lcm-0.1.0.tgz

# ② 从源码 link 安装（开发用，改代码即时生效）
dsh plugin --profile web add link:$(pwd)/adapters/dsh

# ③ 本地构建 tarball 再装
node scripts/build-package.mjs                              # 产出 dist/dsh-lcm-<version>.tgz
dsh plugin --profile web add dist/dsh-lcm-0.1.0.tgz
```

**自包含打包**：`scripts/build-package.mjs` 把 `core/*.mjs` 一起打进包里并把引用改写成包内相对路径，
然后在**打包产物上就地跑契约测试**——构建产物自身可用才算通过（CI 里还会额外验证「装进
`node_modules` 后能被 import、四条臂全部注册、`dsh.bundle.patch` 装载契约存在」）。

配置在 `adapters/dsh/cordis.patch.yml`：

```yaml
mode: active                  # shadow（只记账）| active（真生效）
maxInlineChars: 20000         # 单条输出压缩阈值
# —— 计量根 ——
# 默认全局 ~/.lcm（事件带 project 字段，report/compare 跨项目聚合）；
# 可用 LCM_METER_ROOT 环境变量或此处 meterRoot 覆盖
# —— 搭便车剪枝臂 ——
budgetTokens: 100000          # 守卫：会话仍高于此值才值得动手
targetTokens: 60000           # 剪到此值以下停手（滞回带）
pruneCooldownTokens: 10000    # 剪过一次后，会话需再长够此值才允许再次剪
pruneProactive: false         # true=回到主动预算触发（默认关）
bustThresholdTokens: 50000    # fresh 超过此值视为「前缀已冷」
pruneMinChars: 4000           # 候选下限：摘要本身 ~1k 字符，太小的剪了没收益
# —— 端到端验证 ——
# node scripts/e2e-verify.mjs          # 真实会话回放进真实适配器，验证五臂协同
# node scripts/fold-demo.mjs           # 折叠收益对照（真实会话）
# node scripts/extract-bench.mjs       # 提取器质量基准（噪声率/动作分布）
# node scripts/profile-demo.mjs        # 跨会话画像拼接
# node scripts/eval-prep.mjs           # 历史会话批量蒸馏（回填 + 评测准备）
# —— 记忆库容量（B5）——
# node core/cli.mjs memory sweep [--max 2000] [--dry-run]
#   双封顶：2000 活跃条目 / 4 MB 库体；超限归档最弱者（session TTL 优先、
#   画像/pin 永不归档、归档保留审计不物理删除、清到 90% 低水位）
# —— 用户画像条目（A3/B4：晋升/pin/加成/常驻注入）——
# node core/cli.mjs memory pin --id <条目id>      # 手动晋升（免疫自动降级）
# node core/cli.mjs memory unpin --id <条目id>
# node core/cli.mjs memory profile [--auto]        # 查看/自动晋升+降级
#   晋升门槛：跨会话复现(≥2 会话) + 质量≥0.8 + 类型∈{preference,decision,conclusion}
#   预算：≤20 条 / ≤800 chars；30 天未再出现 → 自动降级（pin 免疫）
#   读时加成 ×1.2；常驻注入段 <lcm-profile-memory>
# —— 金标评测（shadow→active 的放行依据）——
# node core/cli.mjs memory eval [--rebuild] [--k 6] [--json]
#   主指标：跨会话 recall@6（真实用户消息 → 召回他处学到的旧记忆）≥0.8
#   反例：被取代/被推翻条目绝不可浮出 + 无意义查询零返回（击穿=0）
# —— 画像层（②习惯 + ③行为，常驻注入，硬预算 900 chars）——
# profileInject: true           # <lcm-profile> 块伴随记忆注入（digest 节流）
# 首次/每日：node core/cli.mjs profile --refresh（全量扫描离线做，热路径只读缓存）
# —— 记忆臂（Phase 3）——
memoryExtract: true           # compaction/summary → 确定性提取入库（零 LLM 调用）
memoryInjectMode: shadow      # active = 请求尾部追加检索块（digest 节流，前缀安全）
memoryInjectMaxEntries: 6     # 注入块条目上限
# —— 静态层裁剪臂 ——
staticTrimMode: active        # 2026-09-15 人工复核 trim-diff 后切 active；复核件随时重看：lcm trim-diff
toolMaxDescriptionChars: 300  # 0 = 关闭描述降噪
dropToolFamilies: []          # 例：["mcp__openviking"] 整族不注入
```

**记忆管理**（本地 `~/.lcm/memories` 永远是 source of truth；配置了 OpenViking 则双写同步，
凭据自动复用 `~/.openviking/ovcli.conf`，不可达时落 outbox 下次冲账）：

```bash
node core/cli.mjs memory add --type decision --subject X --claim "..."   # 手动入库
node core/cli.mjs memory list [--type fact] [--all]                     # 浏览（含被取代历史）
node core/cli.mjs memory search --query "..."                           # 关键词检索
node core/cli.mjs memory inject --query "..."                           # 预览注入块
node core/cli.mjs memory sync                                           # 冲 OpenViking outbox
node core/cli.mjs memory stats                                          # 库况/同步积压
```

画像：`lcm profile [--refresh|--json]`——习惯画像（只扫 user talk：意图/开场/确认率/句式指纹/推进链；过滤 DSH checkpoint 伪装消息 + 续接重放去重）+ 行为画像（meter 统计：活跃节奏/注意力/会话深度）→ `<lcm-profile>` 常驻块（预算内截断，模型第一轮就知道怎么协作——省对齐轮次）。
用户画像：跨会话复现（≥2 会话）且质量≥0.8 的 preference/decision/conclusion 自动晋升为画像条目（或手动 `memory pin`）——读时 ×1.2 加成 + 常驻注入段 `<lcm-profile-memory>`，预算 ≤20 条/800 字符，30 天未复现自动降级（pin 免疫）。受控实验：晋升准确时 MRR 0.783→0.802，晋升干扰项时仅轻微劣化（recall -1.7pt）——机制温和可控。

评测：`lcm memory eval`——金标集自动构造（跨会话/同会话/自查询正例 + 死条目/噪声反例），主指标跨会话 recall@6（实测本机 96.7%，61 对；反例击穿 0）；评测不达标则两个 shadow 臂不得切 active。

价值记账：`lcm value [--days N] [--cache-factor 0.1] [--all] [--json]`——把「工具到底省多少」算成三行硬账（设计：docs/06）：
realized（已实现：压缩臂按 1.0× 档计首个承载请求、剪枝/折叠按折价 × 后续请求数、击穿请求按 1.0×）/ avoided（piggyback 避免的击穿，单列）/ estimated（静态裁剪等，单列）。
反事实夹窗口上限（compaction 实测触发水位），守恒不变量 + provenance 过滤（默认只统计真实会话）写成 17 个测试。
实测本机：140 真实会话净省 15.1%（占反事实），与 bench-all 载荷口径 11.9% 交叉验证同向同量级。
写入不是 append 而是四选一决策（ADD/UPDATE/DELETE/NOOP，按 subject + claim 相似度分流；低分候选按来源分层拒之门外：manual 不限 / summary 0.45 / 原始轮 0.6）；
secrets/瞬态/过短内容被硬过滤在库门外；条目幂等键 = 内容哈希（重试/双写/flush 不产生重复）。
提取搭 DSH 内置 `compaction/summary` 的便车——LLM 摘要产物过确定性提取器，零额外调用。

搭便车剪枝的三个免费窗口：① `compaction/*` 事件后（DSH 内置折叠已打穿前缀）；
② 观测到击穿后（fresh > bustThresholdTokens，前缀已冷）；③ **继承冷启动**——subagent
fork 的转写继承自父会话，首请求本就无可命中的缓存（实测 cached≈3k/250k+），首个
pre-step 改写历史免费且直接缩小那个必然全价的请求（实测 27 个冷会话烧掉 23.5% 的总 fresh）。

---

## 测试

```bash
node --test core/test/*.test.mjs                        # 核心：压缩/存储/卫生/恢复
node --test scripts/replay-session-survival.test.mjs     # 会话存活（DSH 自己的 foldSurface 回放）
node --experimental-sqlite scripts/replay_blobs.mjs      # Phase 0 压缩回放（真实数据）
cd adapters/dsh && node --test test/*.test.js            # 适配器契约（伪造 ctx 重放）
```

| 套件 | 数量 | 结果 | 覆盖 |
|---|---|---|---|
| core 测试 | 73 | ✅ 73/73 | 压缩往返无损（含中文/emoji）、内容寻址去重、TTL 清理、容量上限最旧优先、清扫节流、计量轮转、**全局/项目根合并读取**、**旧口径 fresh 归一化 + 按项目过滤**、**记忆写入决策四分支/禁写过滤/质量门槛分层/检索预算/注入确定性/提取幂等（表格行/引用前缀/冗余 subject 归零）/outbox + mock HTTP 同步**、**画像：harness 伪装消息过滤/续接重放去重/意图分类/句式指纹/预算截断保闭合/热路径只读缓存**、多帧 zstd 会话日志恢复、非法输入 |
| **会话存活回放** | 5 | ✅ 5/5 | 用 DSH 自己的 `foldSurface` 回放含替换事件的日志：折叠接受、**surface 只剩替换节点**、原文仍在日志（可恢复）、折叠确定性、**反向校验生效**（越界改写被拒、缺 `sourceEventSeqs` 被拒） |
| 适配器契约 | 35 | ✅ 35/35（打包产物同样 35/35）| 直通/透传分支、shadow 不替换、active 替换+句柄可回取、失败静默、观测臂记账（project 标签）、剪枝预算/最小/最大优先/最新保护/冷却、piggyback 三窗口（compaction/击穿/**继承冷启动**）+ 守卫用例、静态层确定性 + **trim-diff 复核工件**、**金标评测（跨会话配对不变量/项目键归一/死条目与噪声反例/放行 gate）+ warm folding 折叠臂（只折水位线以下=已蒸馏轮次/最新 4 轮与短消息与插件消息不折/指针行不伪装真人消息/无水位线安全默认/无可折不记账）+ 增量熔炼臂（水位线只扫新增 seq/插件注入+harness 模板过滤/每步 24 候选上限/水位线持久化重启不重扫）+ 记忆提取臂（summary→入库幂等 + 质量门槛行为锁定）/注入臂（尾部追加 + digest 节流 + shadow）/画像常驻注入（无查询也注入 + 同会话节流）**、分臂模式、非法配置拒绝 |
| Phase 0 回放 | 144 样本 | ✅ 全达标 | 1428.3×，确定性 144/144 |

**会话存活为什么是必测项**：剪枝会**改写会话历史**。若替换事件不满足 DSH 的校验规则（`surface.ts`：只能改 content、`shadowedSeqs` 恰好一个、`sourceEventSeqs` 必须覆盖被替换节点；`invariant.ts`：替换必须在打开的 turn 内追加），会话在重启/恢复时会加载失败。我们用 DSH 编译产物里的 `foldSurface` 直接回放验证，并且**包含反向用例**证明校验真的在跑。

---

## 诚实边界

- **缓存击穿的根治不在本项目范围**：前缀缓存由供应商/框架内部管理，插件只能「不为打穿它」并让被击穿的前缀尽量小；DSH 命中率本就健康（94%+）
- **剪枝的真实代价**：① 模型需要细节时要多一次回取（摘要里带句柄/锚点/关键词，且最新一条不动）② 剪的那一轮会击穿一次前缀（已用冷却避免反复击穿）③ 界面/回放显示的是归档视图
- **静态层描述降噪有风险**：部分工具描述把「必须这样做」写在第二段，裁剪可能削掉操作性规则 → 复核工具 `lcm trim-diff`（assemble 自动采集 before/after）就是为此而设；2026-09-15 人工复核后已切 active，已知代价：MCP 工具描述后段的参数文档会被首段优先规则裁掉（用户拍板接受）
- **磁盘会增加而非减少**：原文落 spill（brotli 后约为原体积 1/26），靠 TTL + 容量上限控制
- **默认搭便车剪枝**：`pruneProactive: false`，改写历史只在缓存本来就要失效时发生（`compaction/*` 后、观测到击穿后、subagent fork 首请求前），成本归零；主动路径仍保留给超长会话显式开启，但实测回本需要 ≥104 个后续请求
- **计量数据曾按项目根分散**（会话 cwd + 服务器 cwd 两个落点，实测 85% 的事件落在 report 看不到的根）→ 已改为全局 `~/.lcm` 单根 + `project` 字段 + `lcm migrate` 一次性迁移；spill 原文仍按项目落盘
- **记忆注入默认 shadow**：检索质量（关键词打分 vs 语义检索）需 shadow 期数据复核后切 active；对话轮折叠（warm 层）尚未实现——继承转写里剪不掉的 25% 对话体积是下一个量化目标

---

## 文档

| 文件 | 内容 |
|---|---|
| `docs/01-data-evidence.md` | 数据证据：真实采集分析、成本模型、击穿影响 |
| `docs/02-token-reduction-strategy.md` | token 治理策略总纲（三条杠杆） |
| `docs/03-tool-output-compression.md` | 工具输出压缩设计（压缩而非截断，句柄双后端） |
| `docs/04-memory-extraction.md` | 记忆提取设计（hot/warm/cold 三层 + 写入决策 + 同步） |
| `docs/05-roadmap.md` | 实施路线、测试金字塔、验收记分卡、实测记录 |
| `reports/phase0-compression-report.md` | 可复现的压缩比报告 |
| `.github/workflows/ci.yml` | CI：三套测试（Node 22/24）→ 自包含打包 + 产物验证 → tag 发版附 tarball |

---

## 路线状态

- ✅ **Phase 0**：数据采集与量化分析
- ✅ **Phase 1**：压缩臂 + 剪枝臂 + 观测臂 + 静态层裁剪臂（DSH 已装、active 运行中）
- ⏳ **Phase 2**：记分卡（成本当量 + 红线判定）与对照组实验
- 🔶 **Phase 3**：记忆臂已落地（提取入库 + 尾部注入 + OpenViking 双写，注入默认 shadow）；对话轮折叠（warm 层）待做——吃掉剩余 25% 的对话体积
- ⏳ **Phase 4/5**：Claude Code / Codex 适配层

---

*本项目为个人研究项目，数据来自自有 agent 使用记录。所有数字均可用仓库内脚本复现。*
