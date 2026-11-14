# ZC-deep-b295：7 文件 / 97 行（全池内，池外自清 1）

> 批次：b295 ｜ 提交 `849f438f` ｜ 代码 `+97/−97` ｜ 零代码行
> 尺子：`deep-quality.mjs` v2.0（`756bea66122a`）、`zc-commit.mjs` v13（`f02be471a849`）、
> `precheck-assert.mjs`（`--start` 实盘逐行基准的第七批）、
> `capacity-estimate.mjs`、`weak-guard.mjs`、`ledger-assert.mjs`。

## 0. 交代

1. 本批 7 文件 / **97 行，全部池内**（`ownIn=97 ownOut=0 upIn=0 upOut=0 pending=0 plan=97 allow=0`）。
   原计划 98 行，第 7 个文件只有 13 条可达行（`script-workflow-process.ts`），按实际 97 行提交。
2. 起笔前重跑 `own-commits-gen`（320 行 / `head=e9ab4945`），白名单单独提交后才 `--start`
   （`2026-11-11T06:13:50.607Z`，7 文件 1,548 行实盘逐行基准）。
   **计时口径例外（同 b293/b294）**：映射先于 `--start` 起草，`controllable` 只覆盖「落笔 → 提交」，
   **不进入中位数**。
3. 流程：`--start` → `b295-apply.mjs`（1→1，**2 条与原文相同已当场改写**，最终 `SAME 0`）
   → 判据预判（2 轮，首轮 8 条）→ `--scope` → `--record`（首跑即过，`record_runs=1`）
   → `--verify` → `zc-commit v13` → `--order`。
4. 七行门禁：`expected=7 staged=7`，`+97/−97`；顺序断言
   `t-start 06:13:50.607 < t-record 06:14:12.728 ≤ t-verify 06:14:14.046 < commit 14:14:37+08:00`。
5. 第 8 行门禁第七批：`indentChanged=0 eolChanged=0`、`SAME 0`、`touched_restored=0`。
6. 本批结束重生成白名单：**322 行 / `head=849f438f`**。

## 1. 计划表

| 文件 | 池内 | 池外 own | 本批 | 批后 weak |
| --- | ---: | ---: | ---: | ---: |
| `packages/ui/src/app-shell/WorkflowRunSidePane.tsx` | 14 | 0 | 14 | 0 |
| `packages/ui/src/hooks/useWebElementPicker.ts` | 14 | 0 | 14 | 0 |
| `packages/ui/src/project-sidebar/grouped/task-row.tsx` | 14 | 0 | 14 | 0 |
| `packages/ui/src/root/accountConnectionLossSuggestion.ts` | 14 | 0 | 14 | 0 |
| `packages/ui/src/settings/model-provider-section/useModelConfigResolution.ts` | 14 | 0 | 14 | 0 |
| `packages/ui/src/v4/composer/useCodeCommentContexts.ts` | 14 | 0 | 14 | 0 |
| `apps/zcode-cli/packages/bootstrap/src/app/script-workflow-process.ts` | 13 | 0 | 13 | 1（PARTIAL） |
| **合计** | **97** | **0** | **97** | **1** |

## 2. 批后池

```text
done files=270（+6）  remain files=737
done lines=3971（+96）remain lines=3450（−96）
ALIGNED acct_remain=3450 pool_remain=3450 diff=0
完成度 3971 / 7421 = 53.5%
```

- 写入 97 行，池内口径只前移 **96 行**：`script-workflow-process.ts:175` 改写后仍被
  `deep-quality` v2.0 判为「同义重复」（`handleRequest() 失败时写 ok:false 回执。`），
  该行留池，文件转 PARTIAL（基线 13 → 现 1），**不进入 done**。
  这是 zc-gate-v4 与 deep-quality 判据口径差的第二例（同 `cuaDetails.tsx`），按 PARTIAL 回池排期。
- **SELF-CLEAR 1（池外）**：`WorkflowRunSidePane.tsx:345`（`872ad960` 上游）由相邻改写转强。
- 全仓：`6801 → 6704`（−97 = 池内登记 96 + 池外自清 1）；池外 `6704 − 3450 = 3254`，与 post-b294 的 3255 差 1，闭合。
- 档位分布：`>=20` 0，`10-19` 139 文件 / 1,600 行，`5-9` 141 / 931，`3-4` 158 / 539，`1-2` 299 / 380。
- `done 3,971` 的台账口径：**「已写入 3,971 行，其中 10 行经 N/P 双读，fail 1」**。

## 3. 计时（口径例外，不进入中位数）

```text
t-start    2026-11-11T06:13:50.607Z
t-record   2026-11-11T06:14:12.728Z  sha=a150ce96af74  record_runs=1
t-verify   2026-11-11T06:14:14.046Z  sha=a150ce96af74
commit     2026-11-11T14:14:37+08:00  849f438f

batch_wall_total        = 123.0 s（19f6e744 → 849f438f）
batch_wall_controllable =  47.0 s（t-start → commit）
落笔段                  =  23.4 s（t-start → t-verify）
tail                    =   1.3 s（t-record → t-verify）
s/行（端到端，仅落笔段） = 0.48（47.0 / 97）
```

- 起草在 `--start` 之前完成，本样本与 b284/b285/b293/b294 同列「测量口径失效」，
  **不进入新口径 n=7 的中位数（仍为 1.66 s/行）**。

## 4. 度量前后

| 文件 | weak 前→后 |
| --- | ---: |
| `WorkflowRunSidePane.tsx` | 14 → 0 |
| `useWebElementPicker.ts` | 14 → 0 |
| `task-row.tsx` | 14 → 0 |
| `accountConnectionLossSuggestion.ts` | 14 → 0 |
| `useModelConfigResolution.ts` | 14 → 0 |
| `useCodeCommentContexts.ts` | 14 → 0 |
| `script-workflow-process.ts` | 13 → 1 |

- 全仓：`post-b294 6801 / 1883` → `post-b295 6704 / 1881`。
- 池内：`done 3875 / remain 3546` → `done 3971 / remain 3450`。
- PARTIAL 2：`cuaDetails.tsx`（23 → 1）、`script-workflow-process.ts`（13 → 1）。

## 5. 门禁

```text
删本线注释 n=97   删代码 n=0   删上游注释 n=0
新增非注释行 n=0  原行搬移 n=0  标点级改写 n=0
新增注释行 n=97   判据命中 0   嵌套注释 0
numstat: +97 −97
PRECHECK SAME same_rewrites=0（record / verify 各一次）
PRECHECK SCOPE plan=97 allow=0 diff_old=97 diff_new=97 out_of_scope_edits=0
PRECHECK INDENT indentChanged=0 eolChanged=0
PRECHECK MTIME  touched_restored=0
ORDER GATE PASS
```

- `record_runs=1`：**预检无返修**。
- 首轮预判 `hits=8`（5 W + 3 L）：
  - W：`WorkflowRunSidePane.tsx:97`、`useWebElementPicker.ts:123/124`、
    `task-row.tsx:167/329` —— 补 `projection`、`WorkflowRunContent`、`activePickerRunRef.current`、
    `logger.warn`、`taskActivity`、`dragOverlay`。
  - L：`useCodeCommentContexts.ts:66/155`、`WorkflowRunSidePane.tsx:168` —— `、` 改 `/` 或分号断句。
  - 返修只补锚点与句式，未改语义。
- 起草时有 2 条与原文逐字相同（`useWebElementPicker.ts:124`、`task-row.tsx:167`），
  `apply` 当场报 `SAME` 并改写，最终提交 `SAME 0`；不构成空替换。

## 6. 收口

```text
GUARD 15文件 pre=4 post=4 新增=0 max=8 → PASS
ACCT files 270 + 737 = 1007 OK
ACCT lines 3971 + 3450 = 7421 OK
ALIGNED acct_remain=3450 pool_remain=3450 diff=0
ledger-assert ASSERT PASS（CLOSE 802 = 802，EXEMPT 2）
OWNCOMMITS rows=322 generated=322 missing=0 extra=0 text=same
WHITELIST OK head=849f438f1243 rows=322
SELF-CLEAR n=1（池外 1）
```

## 7. 首轮命中率（逐批）

| 批 | 首轮 hits | 登记行 | 命中率 |
| --- | ---: | ---: | ---: |
| b289 | 7 | 90 | 7.8% |
| b290 | 6 | 90 | 6.7% |
| b291 | 9 | 97 | 9.3% |
| b292 | 10 | 98 | 10.2% |
| b293 | 2 | 98 | 2.0% |
| b294 | 6 | 98 | 6.1% |
| **b295** | **8** | **97** | **8.2%** |

- 七批均值约 7.0%（48/661），仍在 ±2 个百分点的常态区间。

## 8. 剩余工作量（按 post-b295 更新）

| 口径 | 单位耗时 | 3,450 行折算 | 说明 |
| --- | ---: | ---: | --- |
| `controllable`（新口径 n=7，中位数） | 1.66 s/行 | 5,727 s ≈ 1.6 h | 只作区间 |
| 端到端（b286 实测） | 5.67 s/行 | 19,562 s ≈ **5.4 h** | 含门禁、返修、快照、台账 |
| 批次折算 | 90 行/批 | **约 39 批** | `3,450 / 90 ≈ 39` |

## 9. 池外对账

| 快照 | 提交 | weak | files | remain | 池外 |
| --- | --- | ---: | ---: | ---: | ---: |
| post-b292 | `2bdd2e41` | 6999 | 1895 | 3742 | 3257 |
| post-b293 | `042f140e` | 6899 | 1890 | 3644 | 3255 |
| post-b294 | `682cf328` | 6801 | 1883 | 3546 | 3255 |
| post-b295 | `849f438f` | 6704 | 1881 | 3450 | 3254 |

- `6801 − 6704 = 97` = 池内登记 96 行 + 池外自清 1 行；池外 3255 → 3254 与自清 1 条一一对应。
