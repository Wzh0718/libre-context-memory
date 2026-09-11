# dsh-lcm — libre-context-memory DSH 适配器（薄壳）

挂 `tools/post-execute`：纯文本工具结果超过 `maxInlineChars`（默认 20,000 字符）时，
**进程内直调**核心引擎 `core/*.mjs`（压缩/落 spill/记 meter 全在核心内），
模型可见结果替换为「摘要 + 句柄」。壳里只有事件翻译 + 失败静默。
宿主即 Node，零额外运行时（不需要 Python）。

## 模式

| 模式 | 行为 |
|---|---|
| `shadow`（默认） | 完整跑压缩（`--no-spill`），决策写 meter（backend=shadow）+ 日志，结果**原样透传** |
| `active` | 替换为「摘要+句柄」；任何失败（超时/崩溃/输出非法）回退原文 |

## 安装（web profile）

```bash
dsh plugin --profile web add link:/home/libre/project/libre-context-memory/adapters/dsh
```

或在 `~/.dsh/profiles/web/package.json` 的 dependencies 与 `dsh.profile.bundles` 中各加一行
（`"dsh-lcm": "link:..."` / `"dsh-lcm"`），patch 已随包携带（默认 shadow）。

## 注意

- **不要与 `dsh-spill-policy` 同时生效**（同一替换通道；spill-policy 未配 `maxInlineBytes` 时是 no-op，默认不冲突）
- `read` 工具与嵌套子调用不处理（防 read→spill→read 循环）
- 切 active：把 patch 里的 `mode: shadow` 改为 `mode: active`
- 核心引擎仓库根由壳自动定位（`adapters/dsh/../../..`）；数据根（`.lcm/` 落点）取会话 cwd，可用 config `lcmRoot` 覆盖

## 测试

```bash
node --test test/*.test.js   # 6 个契约测试，伪造 ctx 重放，不需要 harness
```
