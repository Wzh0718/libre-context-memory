# 03 · 工具输出压缩设计（压缩而非截断）

> 核心主张：**截断丢信息（不可恢复），压缩保信息（摘要 + 完整原文句柄，可回取）**。
> 依据：Codex 实测 0.30% 的调用贡献 55.5% 的工具输出字符；`exec`+`exec_command` 占 98.5%。

---

## 1. 各 harness 的干预口子（2026-09-11 改为纯插件视角）

| harness | 入库前替换输出 | 源头改写命令 | 状态 |
|---|---|---|---|
| DSH | `ctx.toolResultPruner`（官方修剪口子，插件实现语义压缩版） | 插件包装 | **主战场，口子最全** |
| CC | `PostToolUse` hook 替换输出 | `PreToolUse.updatedInput` | 契约明确 |
| Codex | `PostToolUse` → `block`+`feedback`（⚠️ 未验证） | `PreToolUse.updated_input`（⚠️ 未验证） | 待探针，见 §8 |

壳的统一形态：把 harness 事件 JSON 的字段抠出来 → 调核心 CLI `lcm compress` → 包成 harness 要求的返回格式。**壳里没有压缩逻辑。**

## 2. 三层压缩架构（插件口径）

```
L1 源头压缩（PreToolUse / 插件包装）  ← exec 类占 98.5% 体量，改这里最有效
   命令改写：{原命令} 2>&1 | tee spill文件 | 压缩器 ；同时补齐 max_output_tokens
        ↓ 输出天生就小
L2 入库压缩（PostToolUse / toolResultPruner）  ← 替换模型可见结果的通道
   取输出 → lcm compress → 回传「摘要+句柄」；原文进 spill 后端
        ↓ 进入上下文的是压缩版，原文仍可回取
L3 历史压缩（仅折叠/击穿时刻）  ← 存量回收
   DSH：compaction seam，检测到 fresh 突增（击穿）时顺带批量替换旧输出
   CC/Codex：拿不到 usage，只挂在 harness 自身折叠时刻；无折叠则不回收存量
```

**分工**：L1/L2 让增量变小；存量回收只有 L3，且在 CC/Codex 上机会有限——所以**入库即压缩（L2）是主战场，越早压省的轮数越多**（成本 = 体积 × 剩余轮数）。

## 3. 压缩算法（确定性优先，LLM 兜底）

**预处理层（Phase 0 实测后新增，必须先于类型检测）**：
1. **信封解包**：harness 工具输出是 JSON 信封（`{"type":"custom_tool_call_output","output":[{"type":"input_text","text":...},{"type":"input_image",...}]}`），真正的载荷在 `output[].text`
2. **base64 剥离**：实测 94 个 >100k 大输出 **99.9% 字符是内联 base64** → 替换为 `[base64 <mime> <N> chars stripped → 句柄原文]` 占位符。**这是确定性收益的绝对大头（long tail 的本体）**
3. **超长单行收缩**：单行 >500 字符（常见于嵌套 JSON）→ 尝试解析为 JSON schema 摘要，失败则截断并标注原长

| 输出类型 | 确定性手法 | 典型压缩比 | Phase 0 实测中位 |
|---|---|---|---|
| 日志 | 重复行折叠 `line × N`、时间戳归一 | 10–50× | —（high 带未出现） |
| 搜索结果 / 文件列表 | 按目录聚合 + 计数 + 样本 | 20–100× | 4999×（high，n=2） |
| JSON | schema + 行数 + 前 N 条 + 聚合统计 | 10–30× | 394×（mid，n=9） |
| 表格 | 表头 + 行数 + 列统计 | 20–50× | 87×（mid，n=12） |
| diff/patch | 文件级摘要 + 增删行数 | 5–20× | 443×（mid，n=8） |
| 代码 | 保留签名与关键行 | 3–10× | —（样本不足，早期实测 3–5×） |
| 通用兜底 | head + tail + 超长行收缩 + 中间统计 | 10–30× | 3134×（high，n=92，含 base64 剥离）/ 14×（mid，n=19） |

**分层阈值**：
- `< 20k 字符`：不动（p90=19,865，多数调用不打扰）
- `20k–100k`：确定性压缩
- `> 100k`：确定性 + 小模型语义摘要（输入附当前任务目标，只留结论/错误/关键行号）

LLM 压缩只用于极少数大输出——确定性压缩已覆盖绝大多数，成本可控。

## 4. 句柄与 spill 双后端（2026-09-11 用户定案）

**检测到 OpenViking 配置 → spill 原文上传 `viking://resources/spill/<project>/<hash>.txt`；未配置 → 项目级本地目录 `<project>/.lcm/spill/<hash>.txt`。**

```
[归档] spill:a3f9c2 · 412,331 字符 · 8,204 行 · 已压缩为摘要
回取：lcm read spill:a3f9c2 （任意后端统一入口）
     本地后端也可直接：read / grep -n 'ERROR' <path> | head -50
```

要点：
- **内容寻址**：hash 跨后端一致，local → viking 回填时 ID 不变（只有 backend 段变）
- **句柄自描述后端**：`spill:` ID 全局稳定；摘要中同时给出当前后端的可读路径/URI
- **回取对模型透明**：统一走 `lcm read`；viking 后端先拉取到本地缓存再输出路径，本地后端零依赖（read/grep 直用）
- **viking 上传关闭语义切分**：spill 原文按 ID 取回即可，不参与语义索引（避免烧 embedding + 污染记忆检索）
- 路径/ID 稳定可预测 → 缓存友好；摘要保留可检索关键词提示与行号锚点 → 回取一次到位

## 5. 两个必须注意的坑

**① block 语义坑（Codex 专用）**：block 原生偏「拒绝/报错」→ feedback 里必须写明「这是**成功结果**的归档视图」，否则模型误判失败重试（白压了）。DSH/CC 的替换通道无此坑。

**② 缓存纪律**：
- 压缩只在输出**入库那一刻**做一次，之后不再改动 → 前缀稳定
- 句柄内容确定性生成（同输出同句柄）
- 禁止事后逐请求微调历史；批量历史压缩只在击穿（仅 DSH 可检测）/折叠时刻做

## 6. 预期收益与验证

| 层 | 依据 | 预期 |
|---|---|---|
| L1+L2 增量 | 94 次大输出占 55.5% 体量、99.9% 是 base64、83% 被沿用 | Phase 0 实测整体 **1423×**（含 base64 剥离），上下文工具输出体积 −50%+ 属保守 |
| L3 存量 | 沿用体积 1.42B est | 折叠/击穿时刻逐步回收 |

**验证**：meter 记录 `原文字符数 / 压缩后字符数 / 句柄回取次数 / 回取失败次数` → 本地 sqlite 聚合 → 「省了多少 + 有没有被回取（是否压过头）」进记分卡（05 文档）。

## 7. 测试（与 harness 解耦）

- 压缩器测试集 = `../codex-lifecycle-data/` 的 94 个 >100k 字符真实 blob（Phase 0 已跑通，见 `reports/phase0-compression-report.md`）：断言压缩比下限、确定性（同输入同输出）、句柄可回取
- 壳的契约测试：录制真实 hook payload 重放，断言输出符合各家 schema，**不烧 token**
- 影子模式：壳上线先只记录「会压什么」但透传原文，跑几天看误判率，再开生效

## 8. Codex 探针（暂缓，Codex 恢复后为第一步）

1. PostToolUse payload 是否真带 `tool_response`
2. `block`+`feedback` 是否真替换了模型可见结果（而非变成错误）
3. `PreToolUse` 的 `updated_input` 是否被采纳

探针 = 把 stdin JSON 落盘的最小 hook，挂一个会话即可全部确认。CC 壳的等价契约已明确，可先行。
