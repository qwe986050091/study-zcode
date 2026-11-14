# b397 · cap 20 第 7 批（20 文件 / 20 行，首轮全绿）

> 提交：`e1bb22f9`（代码 20 行 / 20 文件，+20/−20）
> 批前基准：`b396-repo-post.txt`；批后快照：`b397-repo-post.txt`

## 0. 三列与判据

| 判据类 | 格式类 | lint |
| ---: | ---: | ---: |
| **0**（`judge-generic` hits=0） | **0**（`diffset-assert` missing=0 extra=0） | **首轮 1 → 修后 0** |

- lint 首轮 1 条：`WorkflowWorkspaceSidePane.tsx:14` 的 `、`+`，` 两个分隔符超限；改分号后一次过。
- 判据首轮 1 条：`queue.tsx:320` 被 `judge` 判 `W 单行无信息`（只有 Tailwind 尺寸、无标识符锚点）；
  补 `Queue` 标识符并改写因果后 `hits=0`。两轮都只改草稿脚本，未落盘返工。

## 0.1 cap 20：本批继续用 `173.25`

| 判据 | 阈值/公式 | b394 | b395 | b396 | b397 |
| --- | --- | --- | --- | --- | --- |
| `pool-diff` 首轮 `n` | **= 0** | 0 | 0 | 0 | **0** |
| `removed − selfclear_batch` | **= `plan.tsv` 行数** | 20 = 20 | 20 = 20 | 20 = 20 | **20 − 0 = 20** |
| `controllable` | **≤ 173.25** | 121.0 | 110.0 | 82.0 | **128.0** |

- `128.0` 比 b396 高 `46.0s`，原因是本批前先落了一次方法论文档提交（`1d1f84db`）并跑完整装箱；
  两项都已计入 `controllable`，不是返工（`TOOL_TRIP: 0.0`）。
- 首轮干净率 **6/7**，b394–b397 **连续四批**全过，维持「稳定」。

## 1. 逐文件（批前 → 批后）

| 文件 | 前 | 后 |
| --- | ---: | ---: |
| `packages/shared/src/zcodeEndpoint.ts` | 1 | 0 |
| `packages/ui/src/app-shell/SidePaneTabTrigger.tsx` | 1 | 0 |
| `packages/ui/src/app-shell/WorkflowRunSidePaneSections.tsx` | 1 | 0 |
| `packages/ui/src/app-shell/WorkflowWorkspaceSidePane.tsx` | 2 | 1 |
| `packages/ui/src/BotsDialog/BotSummaryCard.tsx` | 1 | 0 |
| `packages/ui/src/browser-use/UnifiedBrowserView.tsx` | 2 | 1 |
| `packages/ui/src/chat-input-toolbar/ComposerModelMenu.tsx` | 2 | 1 |
| `packages/ui/src/chat-input-toolbar/ThoughtLevelCycleControl.tsx` | 1 | 0 |
| `packages/ui/src/ChatErrorBanner.tsx` | 1 | 0 |
| `packages/ui/src/components/ai-elements/context.tsx` | 1 | 0 |
| `packages/ui/src/components/ai-elements/conversation.tsx` | 1 | 0 |
| `packages/ui/src/components/ai-elements/markdown-image.tsx` | 1 | 0 |
| `packages/ui/src/components/ai-elements/mic-selector.tsx` | 1 | 0 |
| `packages/ui/src/components/ai-elements/prompt-input.tsx` | 1 | 0 |
| `packages/ui/src/components/ai-elements/queue.tsx` | 1 | 0 |
| `packages/ui/src/components/ai-elements/snippet.tsx` | 1 | 0 |
| `packages/ui/src/components/ai-elements/terminal.tsx` | 1 | 0 |
| `packages/ui/src/components/cloud-content-dialog/CloudDialogHero.tsx` | 1 | 0 |
| `packages/ui/src/components/marketing-touch/MarketingDialogs.tsx` | 1 | 0 |
| `packages/ui/src/components/marketing-touch/marketingTouchController.ts` | 1 | 0 |

| 清理 | 全仓清零 | 注解清零 | 归类清零 | 新进 |
| ---: | ---: | ---: | ---: | ---: |
| **20** | **17** | **17** | **0** | **0** |

- `全仓清零 17 = 表内 +9 + 表外 +8`：`CLEARED 207 → 216`、表外 `33 → 25`。
- **表外差集**：新增 **0** / 移除 **8**，8 行全 `annotation`；`mixed` 仍未观测到（规则按行级预置）。
- **池外残差**：`3,292 − 59 = 3,233`，**与基线相同，按 b397 规则不再作为固定字段报告**；变化时才解释。

## 2. 六闸原文（同一次跑）

```
gate: PASS scope n=0 plan=20 allow=0 diff_old=20 diff_new=20 out_of_scope_edits=0 plan_lines_covered=20/20
gate: PASS record n=0 same=0 indent=0/0 mtime=0 drift=0 record_runs=1
gate: PASS verify n=0 same=0 indent=0/0 mtime=0 drift=n/a record_runs=1 verify_ok=true
gate: PASS commit n=0 sha=e1bb22f9 files=20/20 numstat=20/20 删代码=0 删上游=0 新增非注释=0 搬移=0 判据=0 嵌套=0 标点=0
gate: PASS pool-diff n=0 removed=20 added=0 selfclear_batch=0 allowed=38 auto_self_clear=0
gate: PASS order n=0 elapsed_since_start=345.0s controllable=128.0s
GATE ALL PASS batch=b397 sha=e1bb22f9
```

- `allowed = 20 计划 + 18 已登记 + 0 自动 = 38`。
- `elapsed_since_start=345.0s` 是「上一提交 → 本提交」整段墙钟，含批前方法论文档提交与装箱；
  与收口段不是同一个量（b397 起字段由 `total=` 改名，见 CLOSING §4）。

## 3. 进度与残余

| 项 | 值 |
| --- | --- |
| 池内可写行 | **59**（done 7,362 / 7,421 = **99.2%**；输入 1） |
| 池内文件 | **59**（done 948 / 1,007 = 94.1%），辅助 |
| 全仓 weak | **3,292 行 / 1,329 文件**（输入 2） |
| 集合 | `1,329 = ACTIVE 1,304 + 表外 25`（定义恒等，非校验） |
| 表内 | `1,520 = ACTIVE 1,304 + CLEARED 216`（定义恒等，非校验） |

- `ALIGNED OK`：`acct_remain 59 == pool_remain 59`。
- 剩余形状 **59 文件 × 1 行**，cap 20 下 `20 + 20 + 19 = 3` 批。

## 4. 计时

| 读数 | 起点 | 终点 | 秒 |
| --- | --- | --- | ---: |
| `controllable` | `--start`（20:30:32.0） | 批次提交（20:32:40） | **128.0** |
| **S0** 收口准备（含全量 closeout 9s） | 20:32:40 | 20:33:06.6 | **26.6** |
| **S1** 失败诊断 | — | — | **0.0** |
| **S2** 人工登记 + 二段闸 | — | — | **0.0** |
| **S3a** 台账写盘 | 20:33:06.6 | 20:33:35.4 | **28.8**（`Write` 完成即打点） |
| **S3b** CLOSING + INDEX 数据行 | 20:33:35.4 | 20:34:22.1 | **46.7**（数据行写完再打点） |
| **S4** 提交（数据行，`9caabbc6`） | 20:34:22.1 | 20:34:34 | **11.9** |
| **收口 S0–S4** | 20:32:40 | 20:34:34 | **114.0**（26.6 + 0 + 0 + 28.8 + 46.7 + 11.9） |
| **批墙钟** | 20:30:32.0 | 20:34:34 | **242.0**（`128.0 + 114.0`，端点相加本批恰好相等） |
| **S5** 回填（计时 + 主报复算 + 回填提交） | 20:34:34 | 20:35:58 | **84.0**（计入常数 `57.0`，偏差 +27.0；含 `--report-only`、补记本行与白名单同步提交，±5s） |

TOOL_TRIP: 0.0（无重复执行；lint 与 judge 首轮修正都只改草稿脚本）
S5_PER_BATCH: 57.0

- **打点方式（本批起真拆分）**：台账 `Write` 返回后立即打点记为 `S3A_END`，CLOSING/INDEX 数据行写完再打点记为 `S3B_END`。
- 端点容差：收口与 `controllable` 相加与批墙钟不默认相等，各端 ±0.5s。

## 5. 主报

- 剩余 59 行 / 59 文件 → cap 20 下 `3` 批（`20 + 20 + 19`）。
- 窗口 `b397 / b396 / b395`，净收口 `114.0 / 83.0 / 79.3` → 中位 **`83.0s`**（三批都无工具往返，本窗口中位**不含构造值**）。
- **主报 `0.22h`**：`3 × (61.4 + 57.0) + 59 × 3.45 + 3 × 83.0 = 355.2 + 203.55 + 249.0 = 807.75s`；区间 `0.16–0.27h`；包络 `0.14–0.20h`。
- 参考档：收口回到窗口最低 `79.3s` → `0.22h`（无差别）；收口维持本批 `114.0s` → `0.25h`。
- **`S5_closeout` 不在 `0.22h` 里**：按预登记区间 `[160.0, 220.0]s`，最终报告同时给「不含」（常规批口径）与「含」两个数；
  按本批 `0.22h` 计，含 ≈ `0.22h + 0.04~0.06h = 0.26–0.28h`。
- 本批**无口径变更**；执行 b397 前定稿的四项（S3b 状态表、`S5_closeout` 量化、残差降级、`plan=19` 预登记）。
