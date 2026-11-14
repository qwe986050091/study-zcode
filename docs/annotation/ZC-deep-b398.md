# b398 · cap 20 第 8 批（20 文件 / 20 行，首轮全绿）

> 提交：`b248975c`（代码 20 行 / 20 文件，+20/−20）
> 批前基准：`b397-repo-post.txt`；批后快照：`b398-repo-post.txt`

## 0. 三列与判据

| 判据类 | 格式类 | lint |
| ---: | ---: | ---: |
| **0**（`judge-generic` hits=0） | **0**（`diffset-assert` missing=0 extra=0） | **首轮 3 → 修后 0** |

- lint 首轮 3 条：`globalNoticeStore.ts:20`、`chatErrorAttributionEvidence.ts:96`、`messageTelemetry.ts:1530` 各有两个分隔符；
  改冒号/并列结构后一次过，只改草稿脚本，未落盘返工。
- 判据首轮 0；`diffset` 首轮 `missing=20` 是脚本未写入时的必然读数，写入后 `missing=0 extra=0`。

## 0.1 cap 20：继续用 `173.25`

| 判据 | 阈值/公式 | b395 | b396 | b397 | b398 |
| --- | --- | --- | --- | --- | --- |
| `pool-diff` 首轮 `n` | **= 0** | 0 | 0 | 0 | **0** |
| `removed − selfclear_batch` | **= `plan.tsv` 行数** | 20 = 20 | 20 = 20 | 20 = 20 | **20 − 0 = 20** |
| `controllable` | **≤ 173.25** | 110.0 | 82.0 | 128.0 | **102.0** |

- `102.0` 比 b397 低 `26.0s`：本批无批前文档提交、无装箱等待；`TOOL_TRIP: 0.0`。
- 首轮干净率 **7/8**，b394–b398 **连续五批**全过，维持「稳定」。

## 1. 逐文件（批前 → 批后）

| 文件 | 前 | 后 |
| --- | ---: | ---: |
| `packages/ui/src/components/marketing-touch/MarketingTouchProvider.tsx` | 1 | 0 |
| `packages/ui/src/components/TaskTitleOverflowText.tsx` | 1 | 0 |
| `packages/ui/src/components/ui/chart.tsx` | 1 | 0 |
| `packages/ui/src/components/ui/pdf-viewer.tsx` | 2 | 1 |
| `packages/ui/src/components/ui/select.tsx` | 2 | 1 |
| `packages/ui/src/components/ui/smooth-metric-value.tsx` | 1 | 0 |
| `packages/ui/src/DeveloperToolsPane.tsx` | 1 | 0 |
| `packages/ui/src/feedback/FeedbackScreenshotPicker.tsx` | 1 | 0 |
| `packages/ui/src/git-action-menu/commitConversationContext.ts` | 1 | 0 |
| `packages/ui/src/git-branch-switcher/GitBranchDialogs.tsx` | 1 | 0 |
| `packages/ui/src/global-notice/globalNoticeStore.ts` | 1 | 0 |
| `packages/ui/src/hooks/useOAuth.ts` | 1 | 0 |
| `packages/ui/src/hooks/useUsageEntitlement.ts` | 1 | 0 |
| `packages/ui/src/i18n/IntlProvider.tsx` | 1 | 0 |
| `packages/ui/src/lib/chatErrorAttributionEvidence.ts` | 1 | 0 |
| `packages/ui/src/lib/composerPlanGroups.ts` | 1 | 0 |
| `packages/ui/src/lib/conversationSelectionReference.ts` | 1 | 0 |
| `packages/ui/src/lib/conversationTelemetryLegacyParityE2E.ts` | 1 | 0 |
| `packages/ui/src/lib/mcpStatusProbe.ts` | 1 | 0 |
| `packages/ui/src/lib/messageTelemetry.ts` | 1 | 0 |

| 清理 | 全仓清零 | 注解清零 | 归类清零 | 新进 |
| ---: | ---: | ---: | ---: | ---: |
| **20** | **18** | **18** | **0** | **0** |

- `全仓清零 18 = 表内 +8 + 表外 +10`：`CLEARED 216 → 224`、表外 `25 → 15`。
- **表外差集**：新增 **0** / 移除 **10**，10 行全 `annotation`；`mixed` 仍未观测到。
- **池外残差**：`3,272 − 39 = 3,233`，与基线相同，**按异常字段规则不报**。

## 2. 六闸原文（同一次跑）

```
gate: PASS scope n=0 plan=20 allow=0 diff_old=20 diff_new=20 out_of_scope_edits=0 plan_lines_covered=20/20
gate: PASS record n=0 same=0 indent=0/0 mtime=0 drift=0 record_runs=1
gate: PASS verify n=0 same=0 indent=0/0 mtime=0 drift=n/a record_runs=1 verify_ok=true
gate: PASS commit n=0 sha=b248975c files=20/20 numstat=20/20 删代码=0 删上游=0 新增非注释=0 搬移=0 判据=0 嵌套=0 标点=0
gate: PASS pool-diff n=0 removed=20 added=0 selfclear_batch=0 allowed=38 auto_self_clear=0
gate: PASS order n=0 elapsed_since_start=313.0s controllable=102.0s
GATE ALL PASS batch=b398 sha=b248975c
```

- `allowed = 20 计划 + 18 已登记 + 0 自动 = 38`。
- `elapsed_since_start=313.0s` 是「上一提交 → 本提交」整段墙钟，含批前定稿与装箱；与收口不是同一个量。

## 3. 进度与残余

| 项 | 值 |
| --- | --- |
| 池内可写行 | **39**（done 7,382 / 7,421 = **99.5%**；输入 1） |
| 池内文件 | **39**（done 968 / 1,007 = 96.1%），辅助 |
| 全仓 weak | **3,272 行 / 1,311 文件**（输入 2） |
| 集合 | `1,311 = ACTIVE 1,296 + 表外 15`（定义恒等，非校验） |
| 表内 | `1,520 = ACTIVE 1,296 + CLEARED 224`（定义恒等，非校验） |

- `ALIGNED OK`：`acct_remain 39 == pool_remain 39`。
- 剩余形状 **39 文件 × 1 行**，cap 20 下 `20 + 19 = 2` 批。

## 4. 计时

| 读数 | 起点 | 终点 | 秒 |
| --- | --- | --- | ---: |
| `controllable` | `--start`（20:41:22.2） | 批次提交（20:43:04） | **102.0** |
| **S0** 收口准备（含全量 closeout 9s） | 20:43:04 | 20:43:27.1 | **23.1** |
| **S1** 失败诊断 | — | — | **0.0** |
| **S2** 人工登记 + 二段闸 | — | — | **0.0** |
| **S3a** 台账写盘 | 20:43:27.1 | 20:43:46.1 | **19.0**（`Write` 返回即打点） |
| **S3b** CLOSING + INDEX 数据行 | 20:43:46.1 | 20:44:12.4 | **26.3**（数据行写完再打点） |
| **S4** 提交（数据行，`8d238a45`） | 20:44:12.4 | 20:44:21 | **8.6** |
| **收口 S0–S4** | 20:43:04 | 20:44:21 | **77.0**（23.1 + 0 + 0 + 19.0 + 26.3 + 8.6） |
| **批墙钟** | 20:41:22.2 | 20:44:21 | **178.8**（`102.0 + 77.0 = 179.0`，端点差 0.2s） |
| **S5** 回填（计时 + 主报复算 + 回填提交） | 20:44:21 | 20:45:17 | **56.0**（常数 `57.5`，偏差 −1.5；白名单由 `report-only` 自动重建，无补记链，±5s） |

TOOL_TRIP: 0.0（无重复执行；lint 首轮修正只改草稿脚本）
S5_PER_BATCH: 57.5

- 打点：台账 `Write` 返回即记 `S3A_END`，CLOSING/INDEX 数据行写完再记 `S3B_END`。
- `S5` 常数改为「最近四个实测常规批中位」`57.5 = median(57.0, 45.7, 58.0, 84.0)`，与收口项同为中位（CLOSING §5.5）。

## 5. 主报

- 剩余 39 行 / 39 文件 → cap 20 下 `2` 批（`20 + 19`）。
- 窗口 `b397 / b396 / b395`，净收口 `114.0 / 83.0 / 79.3` → 中位 **`83.0s`**（三批 `TOOL_TRIP` 全 0，无构造值）。
- **主报 `0.15h`**：`2 × (61.4 + 57.5) + 39 × 3.45 + 2 × 83.0 = 237.8 + 134.55 + 166.0 = 538.35s`；区间 `0.11–0.18h`；包络 `0.09–0.13h`。
- 参考档：收口维持 `114.0s` → `0.17h`；收口回到 `79.3s` → `0.15h`。
- **`S5_closeout` 不在 `0.15h` 里**：预登记区间 `[160.0, 220.0]s`；含 ≈ `0.15h + 0.04~0.06h = 0.19–0.21h`。
- 本批无口径变更；执行 b398 前定稿的四项（白名单结构化、主报统一中位、旧判据删除、批报固定三列）。

## 6. GATE-DEBT 当前条目

- 当前 **8 条**；预期可清零 **0**，接受 **8**（口径边界与工具近似，不是待办）。
- 最后一批逐条给「清 / 接受 / 转交」结论；本批未新增条目。
