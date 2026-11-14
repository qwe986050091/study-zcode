# ZC-deep-b389

> 批次：b389 ｜ **20 行 / 10 文件** ｜ 提交 `818417fb`

## 0. 普通批；`fix=0`；**判据类 1 / 格式类 0 / lint 0**

| 抓取步骤 | 条数 | 内容 |
| --- | ---: | --- |
| 自写 lint（写盘前） | 2 | `TreemappingPane:318` 分隔符 2 个、`workflowRuns:84` 含禁用代词；改后一次过 |
| `sentence-precheck` | 0 | `missing_anchor=0 missing_predicate=0` |
| `judge-generic`（写盘后） | 1 | 首轮 `CodingPlanUsageLineChart:231` 判 W；补 `visibleSeries` 后 `hits=0` |
| 六闸 | 0 | 一次过（`same=0 indent=0 drift=0`） |
| `deep-quality` 全仓扫描 | 0 | 20 条目标行无一残留 |

## 1. 逐文件对账与固定三列

| 文件 | 批前 weak | 批后 weak |
| --- | ---: | ---: |
| `packages/ui/src/settings/model-provider-section/useStartPlanPreview.ts` | 2 | 0 |
| `packages/ui/src/settings/usage-stats/CodingPlanUsageLineChart.tsx` | 2 | 0 |
| `packages/ui/src/store/subagentsStore.ts` | 2 | 0 |
| `packages/ui/src/store/taskQueryCacheStore.ts` | 2 | 0 |
| `packages/ui/src/ToolCallBlocks/renderers/eval-workflow-snippet.tsx` | 3 | 1 |
| `packages/ui/src/ToolCallBlocks/renderers/read.tsx` | 2 | 0 |
| `packages/ui/src/TreemappingPane.tsx` | 2 | 0 |
| `packages/ui/src/v4/agentConversationTransportWorkflowRuns.ts` | 2 | 0 |
| `packages/ui/src/v4/ConversationShareReadonlyTimeline.tsx` | 2 | 0 |
| `packages/ui/src/v4/ConversationTurnNavigator.tsx` | 2 | 0 |
| **合计** | **21** | **1** |

| 清理文件数（池内清零） | 全仓清零 | 新进 weak 文件 | 集合 | ACTIVE | 表外 | 恒等式 |
| ---: | ---: | ---: | --- | ---: | ---: | --- |
| **10** | **9** | **0** | 1,465 → 1,456 | 1,372 | **84** | `1,465 − 9 + 0 = 1,456` ✔；`1,372 + 84 = 1,456` ✔ |

- 1 个文件留 1 行池外上游残留：`eval-workflow-snippet`。
- **表外差集**：`b388 → b389` 新增 **0** / 移除 **1**，名单落盘
  [`ZC-deep-b389-outside-diff.tsv`](ZC-deep-b389-outside-diff.tsv)：
  `- packages/ui/src/settings/model-provider-section/useStartPlanPreview.ts`。
- 表内 1,520 = ACTIVE 1,372 + CLEARED 148。

## 2. 六闸

```
gate: PASS scope n=0 plan=20 allow=0 diff_old=20 diff_new=20 out_of_scope_edits=0 plan_lines_covered=20/20
gate: PASS record n=0 same=0 indent=0/0 mtime=0 drift=0 record_runs=1
gate: PASS verify n=0 same=0 indent=0/0 mtime=0 drift=n/a record_runs=1 verify_ok=true
gate: PASS commit n=0 sha=818417fb files=10/10 numstat=20/20 删代码=0 删上游=0 新增非注释=0 搬移=0 判据=0 嵌套=0 标点=0
gate: PASS pool-diff n=0 removed=20 added=0 allowed=34 auto_self_clear=0
gate: PASS order n=0 total=338.0s controllable=95.0s
GATE ALL PASS batch=b389 sha=818417fb
```

```
[1c allowed] plan=20 + selfclear_rows=14 + auto=0 → allowed=34
```

## 3. 进度

- 全仓 weak：**3,476 → 3,456**（−20）；weak 文件 **1,465 → 1,456**。
- 池内：**219 行 / 209 文件**（`7,202 + 219 = 7,421`、`798 + 209 = 1,007`、`ALIGNED OK`）。
- **行侧进度 97.0%**（7,202 ÷ 7,421）；文件侧 `798 ÷ 1,007 = 79.2%`（辅助）。
- **残留两列**：池内可写 **219 行** / 池外残留 **3,237 行**（`3,456 − 219`）。
- 剩余批数（cap 10）：**21 批**（209 ÷ 10）。形状：`219 ÷ 21 = 10.4 行/批`、`209 ÷ 21 ≈ 10 文件/批`。

## 4. 计时（一位小数；`S3a + S3b` 拆分自 b389 起）

| 读数 | 起点 | 终点 | 秒 |
| --- | --- | --- | ---: |
| `total` | `7a6afed2`（17:40:17） | `818417fb`（17:45:55） | 338.0 |
| `controllable` | `--start`（17:44:20.4） | 批次提交 | **95.0 ± 0.5** |
| **S0** 提交 → closeout | 17:45:55 | 17:45:56.3 | **1.3** |
| **S1** 扫描 + 1b/1c | — | — | **7.4** |
| **S2** rewrite.tsv + own-commits + capacity | — | — | **1.3**（0.0 + 0.2 + 1.1） |
| **S3a** 台账（稳态） | 17:46:05 | 17:47:09 | **64.0** |
| **S3b** CLOSING + INDEX 填数（文档） | 17:47:09 | 18:03:11.8 | **962.0**（环境异常，见下） |
| **S4** 提交 | 18:03:11.8 | 18:03:23.8 | **12.0** |
| **收口 S0–S4（分段和）** | 17:45:55 | 18:03:23.8 | **1048.0**（1.3 + 7.4 + 1.3 + 64.0 + 962.0 + 12.0） |
| **收口（端点实测）** | 17:45:55 | 18:03:23.8 | **1048.8 ± 0.5** |
| **批墙钟（实测端点）** | 17:44:20.4 | 18:03:23.8 | **1143.4 ± 0.5** |

`ACCIDENT_TIMING: b389 的 S3b = 962.0s 是本会话上下文膨胀造成的环境延迟，不是批次成本`

- `S3b` 只做了 7 处 CLOSING 编辑 + 8 处 INDEX 编辑 + 1 次状态刷新，同规模工作 b388 只用 `~75s`。
  `962s` 与文本量无关，是长上下文下每轮生成的间隔；`controllable 95.0` 与 `S3a 64.0` 测得早，未被污染。
- 按既有规则：**标记 `ACCIDENT_TIMING`，中位与包络两处同时剔除 b389**；不静默扣数，也不永久抬高成本结构。
  b390 起在**新会话**里开，避免同一批的 `S3b` 再被上下文长度污染。

- `controllable` 与模型 `61.4 + 20 × 3.45 = 130.4s` 对比：本批 `95.0s`，**低于模型 27%**，与 b388 的 `+18.9%` 反向。
  两批同形状（20 行 / 10 文件），返修轮次：b388 是 3 轮校验链 + 2 次 `apply`，b389 是 2 轮 + 2 次 `apply`。
  **返修轮次才是那个 ±20% 的变量**，不是行数也不是文件数。
- **`S3a` / `S3b` 分开报（b389 起）**：`S3a` 进收口中位，`S3b` 只作文档开销单列，不与稳态混排。

## 5. 点估计（主报）

```
[窗口] b388 / b387 / b386
[窗口滚动] 滚入 b388（309.4s）；滚出 b385（176s）
[点估计] 0.95h = 21批 × 61.4 + 219行 × 3.45 + 21批 × 65s（收口中位 54 / 65 / 155）→ 3409.9s
[点估计] 1.47h（收口维持 b388 的 155s）→ 5299.9s
[点估计] 0.88h（收口回到窗口最低 b386 的 54s）→ 3178.9s
[观测包络] 0.89–1.80h（同窗口 min 152s / max 309.4s；参考，不进主报）
[表外差集] 新增 0 / 移除 1（b388 → b389）
```

- **主报 = `0.95h`**（收口中位 `65.0s`）；收口维持 `155s` 则 `1.47h`，回到 `54s` 则 `0.88h`。
- **窗口滚动**：滚入 `b388（309.4s）`、滚出 `b385（176s）`，包络从 `0.93–1.08h`（22 批）变为
  `0.89–1.80h`（21 批）。上沿抬到 `1.80h` 是 `b388` 的 `309.4s` 进窗口，**其中约 `75s` 是文档段**（见 §4.2 的拆分口径）。
- **含文档与去文档两版中位**：`b388 155 / b387 65 / b386 54` → 中位 `65.0s`；
  把 b388 的 `S3b`（CLOSING `~40` + INDEX `~35`）扣掉得 `~80s`，窗口变 `80 / 65 / 54` → 中位仍是 `65.0s`。
  **主报 `0.95h` 两版相同**，所以本次不因文档成本改数；b390 起中位只用 `S3a` 版本。
- 收口中位与包络同源：`b388 / b387 / b386`；b381 与 b384 两处同时剔除。

## 6. 提交

| 内容 | 提交 | numstat |
| --- | --- | --- |
| 批次本体 | `818417fb` | `+20/−20` |
| rewrite.tsv + outside-diff + 本台账 + CLOSING 填数 + 白名单 702 行 | `0cb3d289` | — |

- **`closeout.mjs` 正则缺陷（本批发现并修复）**：`CLOSEOUT_ROW` 只认 `**155.0**`，
  b388 台账写成 `**155.0 ± 0.5**` 后，b388 从窗口里静默消失——中位只剩 `54 / 65` 两个值。
  已加 `(?:\s*±\s*[\d.]+)?` 容错，重跑后窗口恢复三批。
  **教训：改台账的排版会改统计结果**，凡动 `**数字**` 的写法，必须回跑 `closeout`。
