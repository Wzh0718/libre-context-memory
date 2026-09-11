# 05 · 实施路线、测试金字塔与绩效考核

> 原则：**先观测、再动手；每步有验收指标；失败可回退**。hook/插件全异步、失败静默，绝不影响主流程。
> 2026-09-11 重排：砍掉 axon 与 Codex 探针先行项，核心引擎第一。

---

## 测试金字塔（贯穿所有 Phase）

| 层 | 内容 | 依赖 |
|---|---|---|
| L0 核心单测 | 84 个真实 >100k blob 回放：压缩比下限、确定性、句柄可回取 | 无（纯离线，不烧 token） |
| L1 壳契约测试 | 录制真实 hook/插件 payload 重放，断言输出符合各家 schema | 采集管道已有 |
| L2 影子模式 | 壳上线先只记录「会压什么」但透传原文，跑几天看误判率与模型后续行为 | 真实使用 |
| L3 对照实验 | 同类型任务跑「无插件/影子/生效」三组，采集管道对比 | 现有 capture/analyze |

## 绩效考核记分卡（每个省钱指标配一个防降智红线）

| 类别 | 指标（目标） | 红线（触碰即判该会话 0 分，触发回滚/调阈值） |
|---|---|---|
| 成本（权重 50%） | 每任务成本当量 Σ(fresh+0.1×cached) ↓；fresh/请求中位 ↓ | **每请求新增内容 est 必须持平** |
| 压缩质量（25%） | 压缩比 ↑；上下文工具输出体积 ↓ | 句柄回取**失败率** ≈ 0；回取率适中（0=白压，过高=摘要信息不足） |
| 记忆质量（25%） | 记忆命中率 ↑；跨会话重复探索 ↓ | 污染率 ≈ 0；注入预算 ≤ 上限 |

- 数据源：核心引擎 `meter` 落本地 sqlite（harness 无关）；会话用量 DSH 直接取，CC/Codex 从 transcript 估算（标注 1.31×/1.88× 换算）
- 产出：`lcm report --week` 周报 = 记分卡 + 红线告警 + 环比
- 北极星：**每任务成本当量**；分数高必须同时满足「省了钱」和「没变笨」

## Phase 0 · 核心引擎 compress（✅ 已完成，2026-09-11）

**产出**：`core/*.mjs`（Node 版核心引擎：compress/spill/meter/config + `cli.mjs`）+ `scripts/replay_blobs.mjs` + `reports/phase0-compression-report.md`。
- 2026-09-11 起核心引擎为 **Node 实现**（用户拍板：目标机不保证有 Python；DSH/CC 宿主均为 Node；DSH 适配器进程内直调，CC/Codex hook 走 `node core/cli.mjs`）；初版 Python 实现已废弃

**验收结果**（144 个真实 blob 回放：94 个 >100k + 50 个 20k–100k 中带抽样）：
- [x] 各类型压缩比达区间下限（中位口径）：json 394×、table 87×、diff 443×、filelist 4999×、generic 3134×（high）/14×（mid）；整体 **1423×**
- [x] 确定性（同输入同输出）：144/144 逐字节一致（抽样已固定为 content_hash 顺序，可复现）
- [x] 摘要含句柄 ID、行号锚点、关键词；句柄双后端（本地 `.lcm/spill/` 已通，viking 接口预留）
- [x] **重大发现**：大输出的 99.9% 字符是信封内嵌 base64 → 预处理层（信封解包 + base64 剥离 + 超长行收缩）是确定性收益的绝对大头

**遗留调优项**：mid 带 generic 最小 2.9×（低于 10× 下限，内容为致密 JSON/文本混合）；code 类型样本不足待补。

## Phase 1 · DSH 适配器 + 影子模式（🚧 壳已完成，待装 profile 实测）

**产出**（2026-09-11）：`adapters/dsh/`（`dsh-lcm` 插件，ESM + cordis.patch.yml，挂 `tools/post-execute`，prepend，**进程内直调 core/*.mjs，零额外运行时**）。
- 壳纪律达标：压缩/spill/meter 全在核心 CLI，壳只做事件翻译 + 失败静默
- shadow/active 双模式；`read` 与嵌套子调用跳过；与 `dsh-spill-policy` 同通道、默认不冲突（其未配置即 no-op）
- **主动预算剪枝臂（2026-09-11，用户拍板）**：`agent/pre-step` 挂 prepend，tokenMeter 实测会话总量 > `budgetTokens`（默认 100k）时，把 surface 里的 tool/result 按**字符降序**批量替换为「摘要+句柄」直至 < `targetTokens`（60k 滞回带）；最新一条不动；**不按单条内容的尺寸/年龄设死规则**（第一轮就可能来超大输出，尺寸/年龄与语义价值无关，驱动 = 会话总预算）。shadow 完整计算+记账不改写。影价协议与内置 pruner 一致（compaction/prune shadow-price 事件 + surfaceOp replace，回放可还原）
- **第四臂·静态层裁剪（2026-09-11 实现，shadow 起步）**：挂 `system-prompt/assemble`（返回值的 `tools` 权威生效）。**铁律**：工具定义在 ordinal 1–73 = 缓存前缀最前端，会话中途改动会击穿整个前缀，故只做**会话无关的确定性裁剪**（同输入必得逐字节同输出）；契约测试含确定性断言
- **静态层实测（真实 73 个工具定义）**：内置 44 个 10,265 tok / openviking 15 个 3,313 / dbx 13 个 1,790 / codegraph 1 个 399；描述共 27,466 字符（约占工具块的 44%，其余是参数 schema，不可动）。描述压到 300 字符 → 省 14,955 字符（54%）≈ **3.7k tok/请求**
- **静态层占比随上下文规模（1910 个真实请求）**：上下文 <20k → 中位 **100%**；20–60k → **45.5%**；60–150k → **21.3%**；>150k → **11.1%**。→ 平均约 **21%**：**短中会话里静态层才是大头，长会话里工具输出/对话才是**，两类优化互补
- **三臂全绿（2026-09-11，重启后实测本仓库会话）**：观测 51 请求（命中率 96.3%、2 次击穿）；**剪枝 1 次 shadow：会话 163,938 tok > 预算 100k → 11 节点 54,973→10,707 字符**；压缩 1 次 88.2×
- **剪枝天花板实测（关键发现）**：该会话 164k tokens 里，**全部可见 tool/result 只有 55k 字符**（≈1/8 体积），其余是「对话本身」（user/assistant 消息 + 工具调用）与静态层。结论：**只剪工具输出的收益有天花板**，主动剪枝的下一层必须是「旧对话轮折叠 + 记忆沉淀」（Phase 3），否则吃不到大头
- **首轮实机验证（2026-09-11，本仓库会话）**：观测臂 48 请求入账（聚合命中率 96.1%，**2 次真实击穿** fresh 109,589/134,882）；压缩臂 1 次决策 23,893→271 字符（88.2×，shadow）
- **踩坑（已修）**：cordis 对**未声明 inject 的服务属性访问直接抛错**（"cannot get property \"tokenMeter\" without inject"），被剪枝臂 try/catch 吞掉 → 静默失效。改用 `ctx.get('tokenMeter')`（免 inject 读取，缺服务时返回 undefined 且不影响启动），并加一次性可见告警。教训：**所有臂的异常必须至少 console 一次**，ctx.logger 不进终端
- **口径修正**：DSH usage 的 `inputTokens` **不含** cacheRead（实测验算 input+cacheRead+output=totalTokens）→ fresh=inputTokens，总量=input+cacheRead，命中率=cacheRead/总量。初版按「input 含 cacheRead」算出的命中率 36%/226% 属错误口径，已修
- **观测臂（2026-09-11 补）**：`session/event` 每请求记 usage（fresh/cached/命中率/击穿苗头 fresh>50k）+ compaction 事件，落 `meter.jsonl`——「重复写」账本不再等大输出才记，每轮可见；`lcm report` 输出缓存账本/折叠事件/压缩决策三段
- 契约测试 10/10 通过（直通/透传分支/shadow 不替换/active 替换+句柄可回取/失败静默/观测臂记账/剪枝预算内不动/shadow 剪枝不改写/active 剪枝影价+replace 成对+最新节点保留/非法配置加载期拒绝）。**剪枝臂抓获真 bug**：80k 无空格单行的「关键词」未截断会经关键词通道把原文漏回上下文 → core 修复（关键词≤40 字符）+ 不变式兜底（压缩产物必须小于原文，违反则首尾保留）

**⚠️ token 消耗对比实测（2026-09-11，`lcm compare`）**：窗口 232 请求 / 6 会话
- 实际每请求当量 33,766；反事实（不装 lcm）34,845；治理掉 49,296 tokens 存量
- 毛节省 +250,377 当量（+3.1%），**lcm 引起的击穿成本 510,930 当量（3 次）**，净 **−3.2%**
- **盈亏平衡：改写历史需 ≥104 个后续请求才回本**（击穿 ≈ 全价重发整段 ~250k 上下文；收益 = 治理体积 × 0.1 × 后续轮数）
- → **设计修正（待做）**：改为「搭便车剪枝」——只在缓存本来就要失效时动手（内置折叠前后、已观测到击穿之后），此时改写历史免费；主动制造击穿只在超长会话值得
- 方法论：反事实口径、击穿归因（剪枝后该会话第一次请求才算 lcm 引起）、保守假设（被剪体积按缓存价而非全价）都写在 `core/compare.mjs` 顶部

**会话存活验证（2026-09-11，切 active 前必须过的一关）**：用 DSH **自己的** `foldSurface`（`packages/core/session/lib`）回放含 lcm 替换事件的日志，`scripts/replay-session-survival.test.mjs` 5/5 通过：
- 折叠接受我们的替换；**surface 只剩替换节点**（原节点退出 surface）→ 重启/恢复不会挂
- 反向校验生效（证明这是真验证而非空转）：改写 content 以外字段 → `may change only content` 拒绝；缺 `sourceEventSeqs` → 拒绝
- 原文仍在 append-only 日志里 → `lcm recover` 兜底成立
- 三层规则（`surface.ts`）：① `shadowedSeqs` 恰好一个且指向当前 surface 的 tool/result ② 替换与原事件**只能差 content** ③ `sourceEventSeqs` 必须覆盖被替换节点；`invariant.ts` 另要求 surface 替换型 `tool/result` **必须在 turn 打开期间追加**——我们的剪枝臂跑在 `agent/pre-step`，位于 `turn/start` 之后、`step/start` 之前，turn 必然是打开的 ✅

**存储卫生（2026-09-11 完成，切 active 前的前置）**：剪枝省的是 token、不是磁盘，spill 原文要落盘，故先有卫生措施再放水：
- **压缩落盘**：`<hash>.txt.br`（brotli），实测 196,955 字节 → **7,546 字节（26×）**；压缩失败退化明文，绝不丢原文
- **TTL + 容量上限**：`spillTtlDays`（默认 30 天）+ `spillMaxBytes`（默认 512 MB），超出按「最旧优先」清理；写入时机会性清扫（每 20 次写入或 10 分钟最多一次），清扫记 meter
- **计量按月轮转**：`meter-YYYYMM.jsonl`；`summary()` 同时读旧单文件，兼容历史数据
- **三级兜底恢复**：spill 文件丢失时 `lcm recover <句柄>` 从 DSH 会话日志找回原文。踩坑：DSH 会话日志是**逐次追加的多帧 zstd**，而 `node:zlib` 的解码器（sync 与 stream 皆然）**只解第一帧** → 自实现按魔数切帧；真实日志 9,332 行与 `zstd -dc` 完全对齐；端到端验证「删除 spill → read 失败 → recover 恢复，与原文逐字节一致」
- 测试：core 11/11（含 TTL/容量/节流/轮转/多帧 zstd 恢复）+ 适配器契约 12/12

**安装状态（2026-09-11）**：已装入 web profile（`dsh plugin --profile web add link:.../adapters/dsh`；dependencies + bundles 均已注册，包内 cordis.patch.yml 由 loader 启动时自动应用，无需改 profile patch 层）。冒烟验证：profile 内 `import('dsh-lcm')` 正常、apply 注册 `tools/post-execute` 成功。**待 DSH 重启后生效**（默认 shadow）。回滚：`dsh plugin --profile web remove dsh-lcm`。

**验收**：
- [x] 壳契约测试通过（L1）
- [x] 装进 web profile 且模块可加载
- [ ] 影子日志显示压缩决策正确率；无误伤小输出（<20k 直通）——待重启后真实使用
- [ ] 生效后句柄回取可用（模型能 grep/read 到细节）——待真实使用

## Phase 2 · 记分卡 + 对照实验（2 天）

**动作**：meter JSONL 汇总 + report 脚本（成本当量 + 红线判定）；同类型任务三组对照。

**验收**：
- [ ] 上下文当量下降、新增内容持平（红线未触）
- [ ] 压缩比与 L0 离线报告一致（线上无退化）

## Phase 3 · 记忆层（3–5 天）

**动作**：extract（确定性启发式 + 小模型抽取）+ mem0 式写入决策 + outbox；recall 注入（尾部稳定块、预算有界）；写 OpenViking / 本地双后端。

**验收**：
- [ ] 记忆命中率、注入预算、污染率进记分卡
- [ ] 跨会话任务不再重复探索（对照实验）

## Phase 4 · CC 适配层（1–2 天）

**动作**：hooks.json 条目（PreToolUse/PostToolUse/PreCompact/SessionStart/Stop → 核心 CLI）；复用 Phase 1 影子流程。

**验收**：同 Phase 1/2 标准。

## Phase 5 · Codex 适配层（待 Codex 恢复）

**前置**：探针验证三假设（PostToolUse 带 `tool_response`；`block`+`feedback` 替换语义；`PreToolUse.updated_input` 被采纳）。
**动作**：同 CC 壳；block feedback 必须标注「成功结果的归档视图」防模型重试。

## 风险清单（全程适用）

| 风险 | 缓解 |
|---|---|
| hook 影响主流程/启动失败 | 全异步、失败静默、影子模式先行 |
| block 语义导致模型重试（Codex） | feedback 标注「成功结果的归档视图」 |
| 压缩丢关键信息 | 句柄可回取 + 回取失败率红线 + 阈值保守起步（先 100k） |
| 改写历史打穿缓存 | 只在入库时一次 / 折叠·击穿时刻执行（后者仅 DSH 可检测） |
| 压缩调用本身近全价（实测 180k 输入仅 5.4k cacheRead） | 禁止定期压缩；压缩挂在折叠/击穿时刻 |
| 记忆污染 | 写入决策（ADD/UPDATE/DELETE/NOOP）+ confidence+ttl + 幂等键 |
| 多机器句柄失效 | spill 双后端：OpenViking 配置则跨机可取；无配置则句柄带机器标识、失败明确提示 |
| 与现有 hook 冲突 | 追加不替换；matcher 按工具名精确匹配 |

## 与既有资产的对应

| 阶段 | 依赖的既有资产 |
|---|---|
| Phase 0 | `../codex-lifecycle-data/` blob（84 个真实大输出测试集） |
| Phase 1 | DSH `spillStore`/`spill-policy`（已验证的句柄形态）、DSH 插件口子 |
| Phase 2 | 现有采集管道 `capture.py`/`analyze.py`（对照实验测量仪） |
| Phase 3 | OpenViking（运行中）、Codex 354 份 compacted 摘要、DSH 2,356 注入段、`~/.codex/memories/MEMORY.md`（252KB） |
| Phase 4/5 | CC hooks 契约（明确）；Codex 探针（恢复后） |
