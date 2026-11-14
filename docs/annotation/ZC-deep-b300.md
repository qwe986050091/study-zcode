# ZC-deep-b300：7 文件 / 91 行（全池内，池外自清 1）

> 批次：b300 ｜ 提交 `b910ddfa` ｜ 代码 `+91/−91` ｜ 零代码行
> 尺子：`deep-quality.mjs` v2.0（`756bea66122a`）、`zc-commit.mjs` v13（`f02be471a849`）、
> `precheck-assert.mjs`（`--start` 实盘逐行基准的第十二批）、
> `capacity-estimate.mjs`、`weak-guard.mjs`、`ledger-assert.mjs`。

## 0. 交代

1. 本批 7 文件 / **91 行，全部池内**（`ownIn=91 ownOut=0 upIn=0 upOut=0 pending=0 plan=91 allow=0`）。
   每文件 13 行，`91 = 7 × 13`。
2. 起笔前重跑 `own-commits-gen`（335 行 / `head=586cf45c`），白名单单独提交（`0a8f1b2a`）后才 `--start`
   （`2026-11-11T06:35:51.864Z`，7 文件 1,300 行实盘逐行基准）。
   **计时口径例外（同 b293–b299）**：映射先于 `--start` 起草，`controllable` 只覆盖「落笔 → 提交」，
   **不进入中位数**。
3. 流程：`--start` → `b300-apply.mjs`（1→1，`changed=91 same=0`）→ 判据预判（首轮 6 条 → 0，全用 Edit 工具）
   → `--scope` → `--record`（首跑即过，`record_runs=1`）→ `--verify` → `zc-commit v13` → `--order`。
4. 沿用三个通用脚本（`cand-generic.mjs` / `pick-generic.mjs` / `judge-generic.mjs`），本批只写
   `b300-files.txt` 与映射表 `b300-apply.mjs`。
5. 七行门禁：`expected=7 staged=7`，`+91/−91`；顺序断言
   `t-start 06:35:51.864 < t-record 06:37:21.220 ≤ t-verify 06:37:27.416 < commit 14:37:55+08:00`。
6. 第 8 行门禁第十二批：`indentChanged=0 eolChanged=0`、`SAME 0`、`touched_restored=0`、
   `line_drift=0`、`out_of_scope_edits=0`。全程只用 Edit/apply 脚本，无 BOM。
7. 本批结束重生成白名单：**337 行 / `head=b910ddfa`**（未提交，随台账一起入账）。

## 1. 计划表

| 文件 | 池内 | 池外 own | 本批 | 批后 weak |
| --- | ---: | ---: | ---: | ---: |
| `packages/ui/src/ModelTrajectorySearchHighlight.ts` | 13 | 0 | 13 | 0 |
| `packages/ui/src/index.ts` | 13 | 0 | 13 | 0 |
| `packages/ui/src/lib/zcodeSessionEventOrder.ts` | 13 | 0 | 13 | 0 |
| `packages/ui/src/previewPaneOfficeContent.tsx` | 13 | 0 | 13 | 0 |
| `packages/ui/src/project-sidebar/grouped/task-item.tsx` | 13 | 0 | 13 | 0 |
| `packages/ui/src/settings/model-provider-section/useProviderModelDraft.ts` | 13 | 0 | 13 | 0 |
| `packages/ui/src/v4/ConversationWorkflowCompletion.tsx` | 13 | 0 | 13 | 0 |
| **合计** | **91** | **0** | **91** | **0** |

## 2. 批后池

```text
done files=304（+7）  remain files=703
done lines=4423（+91）remain lines=2998（−91）
ALIGNED acct_remain=2998 pool_remain=2998 diff=0
完成度 4423 / 7421 = 59.6%
```

- 写入 91 行、池内前移 91 行，一一对应：无 PARTIAL 新增，`record_runs=1`。
- PARTIAL 仍为 3：`cuaDetails.tsx`（23 → 1）、`script-workflow-process.ts`（13 → 1）、
  `CoveragePanel.tsx`（13 → 2），本批未新增、未消化。
- 全仓：`6341 → 6250`（−91）；池外 `6250 − 2998 = 3252`，与 post-b299 持平，闭合。
- 档位分布：`>=20` 0，`10-19` 104 文件 / 1,146 行，`5-9` 141 / 931，`3-4` 158 / 539，`1-2` 300 / 382。
- `done 4,423` 的台账口径：**「已写入 4,423 行，其中 10 行经 N/P 双读，fail 1」**。

## 3. 计时（口径例外，不进入中位数）

```text
t-start    2026-11-11T06:35:51.864Z
t-record   2026-11-11T06:37:21.220Z  sha=2c6f2478f139  record_runs=1
t-verify   2026-11-11T06:37:27.416Z  sha=2c6f2478f139
commit     2026-11-11T14:37:55+08:00  b910ddfa

batch_wall_total        = 196.0 s（0a8f1b2a → b910ddfa）
batch_wall_controllable = 124.0 s（t-start → commit）
落笔段                  =  95.6 s（t-start → t-verify）
tail                    =   6.2 s（t-record → t-verify）
s/行（端到端，落笔段）    = 1.36（124.0 / 91）
```

- 起草在 `--start` 之前完成，本样本与 b284/b285/b293–b299 同列「测量口径失效」，
  **不进入新口径 n=7 的中位数（仍为 1.66 s/行）**。

## 4. 度量前后

| 文件 | weak 前→后 |
| --- | ---: |
| `ModelTrajectorySearchHighlight.ts` | 13 → 0 |
| `index.ts` | 13 → 0 |
| `lib/zcodeSessionEventOrder.ts` | 13 → 0 |
| `previewPaneOfficeContent.tsx` | 13 → 0 |
| `project-sidebar/grouped/task-item.tsx` | 13 → 0 |
| `settings/model-provider-section/useProviderModelDraft.ts` | 13 → 0 |
| `v4/ConversationWorkflowCompletion.tsx` | 13 → 0 |

- 全仓：`post-b299 6341 / 1859` → `post-b300 6250 / 1852`。
- 池内：`done 4332 / remain 3089` → `done 4423 / remain 2998`。
- 池外自清 1：`ConversationWorkflowCompletion.tsx:57`（`872ad960`，上游 JSDoc 收尾行）——
  该行原先随 `58-60` 的短句单元一起计 weak，本批把 `58` 起改成带标识符的长句后单元不再命中；
  属池外顺带消失，按 `self-clearing / pool-out` 登记，不改口径、不扣配额。

## 5. 门禁

```text
删本线注释 n=91   删代码 n=0   删上游注释 n=0
新增非注释行 n=0  原行搬移 n=0  标点级改写 n=0
新增注释行 n=91   判据命中 0   嵌套注释 0
numstat: +91 −91
PRECHECK SAME same_rewrites=0（record / verify 各一次）
PRECHECK SCOPE plan=91 allow=0 diff_old=91 diff_new=91 out_of_scope_edits=0
PRECHECK INDENT indentChanged=0 eolChanged=0
PRECHECK MTIME  touched_restored=0  LINE-DRIFT files=0
ORDER GATE PASS
```

- `record_runs=1`：**预检无返修**。
- 首轮预判 `hits=6`（5 W + 1 L），一轮返修后 `hits=0`：
  - W：`ModelTrajectorySearchHighlight.ts:28`、`zcodeSessionEventOrder.ts:32`、
    `useProviderModelDraft.ts:41/61`、`index.ts:115` —— 分别补 `HIGHLIGHT_STYLE`、
    `ZCodeSessionEventGap`、`useProviderModelDraft()`/`draftScope`、`export`；
  - L：`index.ts:29`（两个 `，` 且无谓词）→ 改成「编译后会被擦除」，补 `会`。
- 起草无 `SAME`，`changed=91 same=0`，不构成空替换。

## 6. 收口

```text
GUARD 15文件 pre=4 post=4 新增=0 max=8 → PASS
ACCT files 304 + 703 = 1007 OK
ACCT lines 4423 + 2998 = 7421 OK
ALIGNED acct_remain=2998 pool_remain=2998 diff=0
ledger-assert ASSERT PASS（CLOSE 802 = 802，EXEMPT 2）
OWNCOMMITS rows=337 generated=337 missing=0 extra=0 text=same
WHITELIST OK head=b910ddfa rows=337
SELF-CLEAR n=1（池外 1，可写桶 0）
```

## 7. 首轮命中率（逐批）

| 批 | 首轮 hits | 登记行 | 命中率 |
| --- | ---: | ---: | ---: |
| b293 | 2 | 98 | 2.0% |
| b294 | 6 | 98 | 6.1% |
| b295 | 8 | 97 | 8.2% |
| b296 | 10 | 91 | 11.0% |
| b297 | 5 | 91 | 5.5% |
| b298 | 4 | 90 | 4.4% |
| b299 | 4 | 91 | 4.4% |
| **b300** | **6** | **91** | **6.6%** |

- b283–b300 十八批合计 `104 / 1,667 ≈ 6.2%`；近七批（b294–b300）`43 / 649 ≈ 6.6%`。
  本批命中集中在类型常量的短句与 `export` 桶注释，补上标识符后一轮清零。

## 8. 剩余工作量（按 post-b300 更新）

| 口径 | 单位耗时 | 2,998 行折算 | 说明 |
| --- | ---: | ---: | --- |
| `controllable`（新口径 n=7，中位数） | 1.66 s/行 | 4,977 s ≈ 1.4 h | 只作区间 |
| 端到端（b286 实测） | 5.67 s/行 | 16,999 s ≈ **4.7 h** | 含门禁、返修、快照、台账 |
| 批次折算 | 90 行/批 | **约 34 批** | `2,998 / 90 ≈ 33.3` |

## 9. 池外对账

| 快照 | 提交 | weak | files | remain | 池外 |
| --- | --- | ---: | ---: | ---: | ---: |
| post-b296 | `b4a61ced` | 6613 | 1874 | 3359 | 3254 |
| post-b297 | `d6cf1991` | 6522 | 1872 | 3270 | 3252 |
| post-b298 | `ea942c5d` | 6432 | 1866 | 3180 | 3252 |
| post-b299 | `d0b6e6ce` | 6341 | 1859 | 3089 | 3252 |
| post-b300 | `b910ddfa` | 6250 | 1852 | 2998 | 3252 |

- `6341 − 6250 = 91` = 池内前移 91 行（另有 1 行池外自清同时消失，已由档位/账本两侧吸收；
  池外仍按 `6250 − 2998 = 3252` 与 post-b299 持平）。
