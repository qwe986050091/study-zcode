# b399 · cap 20 第 9 批（20 文件 / 20 行，首轮格式返工 1 次）

> 提交：`fd5f1cdb`（代码 20 行 / 20 文件，+20/−20）
> 批前基准：`b398-repo-post.txt`（`pre_done=7382 prev_done=7,382 → OK`）
> 批后快照：`b399-repo-post.txt`

## 0. 三列与判据

| 判据类 | 格式类 | lint |
| ---: | ---: | ---: |
| **0**（`judge-generic` hits=0） | **0**（最终 `diffset-assert` missing=0 extra=0） | **首轮 2 → 修后 0** |

- lint 首轮 2 条：`userActionTelemetry.ts:339`、`presentationElementModel.ts:106` 各两个分隔符；改并列结构后一次过。
- **format 首轮 1 条**：`PreviewPane.tsx:1151` 被整文件按 CRLF 重写，`record` 报 `eolChanged=1`（`LF => CRLF`）；
  按行保留 EOL 并恢复该文件 LF 后通过。这是落盘返工，计入 `controllable`，不记 `TOOL_TRIP`（未重复外部命令）。
- 判据首轮 0。

## 0.1 cap 20：继续用 `173.25`

| 判据 | 阈值/公式 | b396 | b397 | b398 | b399 |
| --- | --- | --- | --- | --- | --- |
| `pool-diff` 首轮 `n` | **= 0** | 0 | 0 | 0 | **0** |
| `removed − selfclear_batch` | **= `plan.tsv` 行数** | 20 = 20 | 20 = 20 | 20 = 20 | **20 − 0 = 20** |
| `controllable` | **≤ 173.25** | 82.0 | 128.0 | 102.0 | **167.0** |

- `167.0` 比 b398 高 `65.0s`，全部来自 EOL 返工（两次 gate 重跑）；`TOOL_TRIP: 0.0`。
- 首轮干净率 **7/9**（b392 n=3、b395 合并计时不影响、b399 EOL）；b394 起连续六批判据全过，cap 20 维持「稳定」。

## 1. 逐文件（批前 → 批后）

| 文件 | 前 | 后 |
| --- | ---: | ---: |
| `packages/ui/src/lib/remoteConnectionWizard.ts` | 1 | 0 |
| `packages/ui/src/lib/settingsNavigation.ts` | 9 | 8 |
| `packages/ui/src/lib/userActionTelemetry.ts` | 1 | 0 |
| `packages/ui/src/lib/webElementPickerScript.ts` | 2 | 1 |
| `packages/ui/src/mentions/MentionPlugin.tsx` | 3 | 2 |
| `packages/ui/src/onboarding/OccupationOnboarding.tsx` | 3 | 2 |
| `packages/ui/src/onboarding/OnboardingFlowParts.tsx` | 1 | 0 |
| `packages/ui/src/plugin-ui/adapters/pluginUiManagedPage.ts` | 1 | 0 |
| `packages/ui/src/plugin-ui/app/pluginUiHostController.ts` | 2 | 1 |
| `packages/ui/src/plugin-ui/domain/pluginUiToolFeed.ts` | 1 | 0 |
| `packages/ui/src/presentation/presentationElementModel.ts` | 1 | 0 |
| `packages/ui/src/PreviewPane.tsx` | 1 | 0 |
| `packages/ui/src/previewPaneOfficeDocxContent.tsx` | 1 | 0 |
| `packages/ui/src/project-sidebar/grouped/useGroupedDrag.ts` | 1 | 0 |
| `packages/ui/src/project-sidebar/grouped/virtualized-group-task-list.tsx` | 1 | 0 |
| `packages/ui/src/project-sidebar/useProjectTree.ts` | 1 | 0 |
| `packages/ui/src/resource-manager/storage/StorageSection.tsx` | 2 | 1 |
| `packages/ui/src/Root.tsx` | 1 | 0 |
| `packages/ui/src/root/useBotBroadcastEffects.ts` | 1 | 0 |
| `packages/ui/src/root/useRootOAuthEffects.ts` | 1 | 0 |

| 清理 | 全仓清零 | 注解清零 | 归类清零 | 新进 |
| ---: | ---: | ---: | ---: | ---: |
| **20** | **14** | **14** | **0** | **0** |

- `全仓清零 14 = 表内 +7 + 表外 +7`：`CLEARED 224 → 231`、表外 `15 → 8`。
- **表外差集**：新增 **0** / 移除 **7**，7 行全 `annotation`；`mixed` 仍未观测到。
- **池外残差**：`3,252 − 19 = 3,233`，与基线相同，不报。

## 2. 六闸原文（同一次跑）

```
gate: PASS scope n=0 plan=20 allow=0 diff_old=20 diff_new=20 out_of_scope_edits=0 plan_lines_covered=20/20
gate: PASS record n=0 same=0 indent=0/0 mtime=0 drift=0 record_runs=3
gate: PASS verify n=0 same=0 indent=0/0 mtime=0 drift=n/a record_runs=3 verify_ok=true
gate: PASS commit n=0 sha=fd5f1cdb files=20/20 numstat=20/20 删代码=0 删上游=0 新增非注释=0 搬移=0 判据=0 嵌套=0 标点=0
gate: PASS pool-diff n=0 removed=20 added=0 selfclear_batch=0 allowed=38 auto_self_clear=0
gate: PASS order n=0 elapsed_since_start=364.0s controllable=167.0s
GATE ALL PASS batch=b399 sha=fd5f1cdb
```

- `allowed = 20 计划 + 18 已登记 + 0 自动 = 38`。
- `record_runs=3` 是 EOL 返工留下的重跑计数；`order` 的 `elapsed_since_start=364.0s` 含返工与装箱等待。

## 3. 进度与残余

| 项 | 值 |
| --- | --- |
| 池内可写行 | **19**（done 7,402 / 7,421 = **99.7%**；输入 1） |
| 池内文件 | **19**（done 988 / 1,007 = 98.1%），辅助 |
| 全仓 weak | **3,252 行 / 1,297 文件**（输入 2） |
| 集合 | `1,297 = ACTIVE 1,289 + 表外 8`（定义恒等，非校验） |
| 表内 | `1,520 = ACTIVE 1,289 + CLEARED 231`（定义恒等，非校验） |

- `ALIGNED OK`：`acct_remain 19 == pool_remain 19`。
- 剩余形状 **19 文件 × 1 行**，cap 20 下一批（b400）收口。

## 4. 计时

| 读数 | 起点 | 终点 | 秒 |
| --- | --- | --- | ---: |
| `controllable` | `--start`（20:51:01） | 批次提交（20:53:48） | **167.0**（含 EOL 返工 ≈65.0） |
| **S0** 收口准备（含一次批前校验失败与重跑） | 20:53:48 | 20:54:27.9 | **39.9** |
| **S1** 失败诊断 | — | — | **0.0** |
| **S2** 人工登记 + 二段闸 | — | — | **0.0** |
| **S3a** 台账写盘 | 20:54:27.9 | 20:54:50.7 | **22.8** |
| **S3b** CLOSING + INDEX 数据行 | 20:54:50.7 | 20:55:17.4 | **26.7** |
| **S4** 提交（数据行，`c051a3aa`） | 20:55:17.4 | 20:55:23 | **5.6** |
| **收口 S0–S4** | 20:53:48 | 20:55:23 | **95.0**（39.9 + 0 + 0 + 22.8 + 26.7 + 5.6） |
| **批墙钟** | 20:51:01 | 20:55:23 | **262.0**（`167.0 + 95.0`，恰好相等） |
| **S5** 回填（计时 + 主报复算 + 回填提交） | 20:55:23 | 20:56:27 | **62.0**（常数 `57.0`，偏差 +5.0；含 `--report-only` 与白名单自动重建） |

TOOL_TRIP: 0.0（EOL 返工在批次内，已计入 `controllable`）
S5_PER_BATCH: 57.0（**构造值**：剔除已修缺陷 `84.0` 后 `median(57.0, 45.7, 58.0)`）

## 5. 主报

- **剩余 19 行 / 19 文件 → b400 单批收口**（cap 20，`plan=19`）。
- 窗口 `b399 / b398 / b397`，净收口 `95.0 / 77.0 / 114.0` → 中位 **`95.0s`**（无构造值）。
- **本批口径主报 `0.08h`**：`1 × (61.4 + 57.0) + 19 × 3.45 + 1 × 95.0 = 118.4 + 65.55 + 95.0 = 278.95s`；
  区间 `0.06–0.09h`；包络 `0.05–0.07h`；收口回到 77.0 → `0.07h`。
- **收口批（b400）主报待实测**：`1 × (61.4 + 57.0) + 19 × 3.45 + 1 × 新中位`，中位以 b400 落盘后窗口为准。
- **`S5_closeout` 尚未实测**：预登记 `[160.0, 220.0]s`；b400 实测后给「预登记 vs 实测」对照，超区间需解释。
- 最终报告必须给「不含 `S5_closeout`」与「含」两个数及各自区间。

## 6. GATE-DEBT 当前条目

- 当前 **8 条**；可清零 **0**，接受 **8**（逐条理由见 CLOSING §6）。
- 本批未新增条目；b400 逐条给最终结论。
