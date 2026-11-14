# ZC-deep-b298：7 文件 / 90 行（全池内，无自清；一次 BOM 越界已自纠）

> 批次：b298 ｜ 提交 `ea942c5d` ｜ 代码 `+90/−90` ｜ 零代码行
> 尺子：`deep-quality.mjs` v2.0（`756bea66122a`）、`zc-commit.mjs` v13（`f02be471a849`）、
> `precheck-assert.mjs`（`--start` 实盘逐行基准的第十批）、
> `capacity-estimate.mjs`、`weak-guard.mjs`、`ledger-assert.mjs`。

## 0. 交代

1. 本批 7 文件 / **90 行，全部池内**（`ownIn=90 ownOut=2 upIn=0 upOut=0 pending=0 plan=90 allow=0`）。
   前 6 个文件各 13 行，`panes.tsx` 12 行（该文件 14 条 weak 里 2 条是上游 own，不碰），`13×6+12=90`。
2. 起笔前重跑 `own-commits-gen`（329 行 / `head=b5cd32d6`），白名单单独提交（`bb0c5b81`）后才 `--start`
   （`2026-11-11T06:27:20.825Z`，7 文件 1,497 行实盘逐行基准）。
   **计时口径例外（同 b293–b297）**：映射先于 `--start` 起草，`controllable` 只覆盖「落笔 → 提交」，
   **不进入中位数**。
3. 流程：`--start` → `b298-apply.mjs`（1→1，`changed=90 same=0`）→ 判据预判（首轮 4 条 → 0）
   → `--scope` → `--record`（首跑即过，`record_runs=1`）→ `--verify` → `zc-commit v13` → `--order`。
4. **越界 1 次（write_phase，已自纠，工具未捕获）**：
   首轮 4 条判据命中里，3 条我用 PowerShell `Get-Content -Raw` + `Set-Content -NoNewline` 就地改，
   PS 5.1 的 `Set-Content` 默认带 BOM，给 `MarketingBanner.tsx`、`task-output.tsx`、`panes.tsx`
   三个文件各加了一个 UTF-8 BOM（第 1 行变 `\uFEFF//`）。
   `git diff --numstat` 立刻暴露成 `14/14`（预期 13/13），定位后逐文件剥掉 BOM，`numstat` 回到
   `13/13`、`13/13`、`12/12`。
   这是一次**真实越界**：改了 plan 之外的第 1 行，`--scope` / `MTIME` / `LINE-DRIFT` 全是 0
   （还原发生在 10 s 观测窗内），按既有规则记入人工自查台账，**不因门禁没报就勾掉**。
   后续改判据残留一律改用 Edit 工具，不再用 PowerShell 就地写文件。
5. 七行门禁：`expected=7 staged=7`，`+90/−90`；顺序断言
   `t-start 06:27:20.825 < t-record 06:29:16.807 ≤ t-verify 06:29:21.738 < commit 14:29:45+08:00`。
6. 第 8 行门禁第十批：`indentChanged=0 eolChanged=0`、`SAME 0`、`touched_restored=0`、
   `line_drift=0`。
7. 本批结束重生成白名单：**331 行 / `head=ea942c5d` / blob `d846e1482100`**（未提交，随台账一起入账）。

## 1. 计划表

| 文件 | 池内 | 池外 own | 本批 | 批后 weak |
| --- | ---: | ---: | ---: | ---: |
| `packages/stream-animate/src/client/RunForm.tsx` | 13 | 0 | 13 | 0 |
| `packages/ui/src/ToolCallBlocks/renderers/task-output.tsx` | 13 | 0 | 13 | 0 |
| `packages/ui/src/app-shell/WorkflowRunPhasePills.tsx` | 13 | 0 | 13 | 0 |
| `packages/ui/src/components/ai-elements/tool.tsx` | 13 | 0 | 13 | 0 |
| `packages/ui/src/components/ai-elements/transcription.tsx` | 13 | 0 | 13 | 0 |
| `packages/ui/src/components/marketing-touch/MarketingBanner.tsx` | 13 | 0 | 13 | 0 |
| `apps/zcode-cli/packages/office-runtime/ui/shell/panes.tsx` | 12 | 2 | 12 | 0 |
| **合计** | **90** | **2** | **90** | **0** |

## 2. 批后池

```text
done files=290（+7）  remain files=717
done lines=4241（+90）remain lines=3180（−90）
ALIGNED acct_remain=3180 pool_remain=3180 diff=0
完成度 4241 / 7421 = 57.1%
```

- 写入 90 行、池内前移 90 行，一一对应：无 PARTIAL、无池外自清，`record_runs=1`。
- PARTIAL 仍为 3：`cuaDetails.tsx`（23 → 1）、`script-workflow-process.ts`（13 → 1）、
  `CoveragePanel.tsx`（13 → 2），本批未新增、未消化。
- 全仓：`6522 → 6432`（−90）；池外 `6432 − 3180 = 3252`，与 post-b297 持平，闭合。
- 档位分布：`>=20` 0，`10-19` 118 文件 / 1,328 行，`5-9` 141 / 931，`3-4` 158 / 539，`1-2` 300 / 382。
- `done 4,241` 的台账口径：**「已写入 4,241 行，其中 10 行经 N/P 双读，fail 1」**。

## 3. 计时（口径例外，不进入中位数）

```text
t-start    2026-11-11T06:27:20.825Z
t-record   2026-11-11T06:29:16.807Z  sha=48707aea0cad  record_runs=1
t-verify   2026-11-11T06:29:21.738Z  sha=48707aea0cad
commit     2026-11-11T14:29:45+08:00  ea942c5d

batch_wall_total        = 190.0 s（bb0c5b81 → ea942c5d）
batch_wall_controllable = 145.0 s（t-start → commit）
落笔段                  = 120.9 s（t-start → t-verify）
tail                    =   4.9 s（t-record → t-verify）
s/行（端到端，落笔段）    = 1.61（145.0 / 90）
```

- 起草在 `--start` 之前完成，本样本与 b284/b285/b293–b297 同列「测量口径失效」，
  **不进入新口径 n=7 的中位数（仍为 1.66 s/行）**。

## 4. 度量前后

| 文件 | weak 前→后 |
| --- | ---: |
| `RunForm.tsx` | 13 → 0 |
| `task-output.tsx` | 13 → 0 |
| `WorkflowRunPhasePills.tsx` | 13 → 0 |
| `ai-elements/tool.tsx` | 13 → 0 |
| `ai-elements/transcription.tsx` | 13 → 0 |
| `MarketingBanner.tsx` | 13 → 0 |
| `office-runtime/ui/shell/panes.tsx` | 14 → 0（12 条本批 + 2 条上游随改写转强） |

- 全仓：`post-b297 6522 / 1872` → `post-b298 6432 / 1866`。
- 池内：`done 4151 / remain 3270` → `done 4241 / remain 3180`。

## 5. 门禁

```text
删本线注释 n=90   删代码 n=0   删上游注释 n=0
新增非注释行 n=0  原行搬移 n=0  标点级改写 n=0
新增注释行 n=90   判据命中 0   嵌套注释 0
numstat: +90 −90
PRECHECK SAME same_rewrites=0（record / verify 各一次）
PRECHECK SCOPE plan=90 allow=0 diff_old=90 diff_new=90 out_of_scope_edits=0
PRECHECK INDENT indentChanged=0 eolChanged=0
PRECHECK MTIME  touched_restored=0  LINE-DRIFT files=0
ORDER GATE PASS
```

- `record_runs=1`：**预检无返修**。
- 首轮预判 `hits=4`（3 W + 1 L），一轮返修后 `hits=0`：
  - W：`MarketingBanner.tsx:67/68`、`task-output.tsx:95` —— 分别补 `opacity`、`height: 0`、`else-if`；
  - L：`panes.tsx:278`（两个 `，`）→ 改分号断句。
- 这 3 条 W 的返修就是 BOM 越界的发生点（见 §0.4），修完后 `numstat` 已回到 90。
- 起草无 `SAME`（`apply` 报 `changed=90 same=0`），不构成空替换。

## 6. 收口

```text
GUARD 15文件 pre=4 post=4 新增=0 max=8 → PASS
ACCT files 290 + 717 = 1007 OK
ACCT lines 4241 + 3180 = 7421 OK
ALIGNED acct_remain=3180 pool_remain=3180 diff=0
ledger-assert ASSERT PASS（CLOSE 802 = 802，EXEMPT 2）
OWNCOMMITS rows=331 generated=331 missing=0 extra=0 text=same
WHITELIST OK head=ea942c5d rows=331
SELF-CLEAR n=0
```

- 本批的越界不由 `--scope` 捕获，而是靠 `git diff --numstat` 的逐文件行数偏大发现；
  这条经验已写回 §0.4，后续批量改写只走 apply 脚本或 Edit 工具。

## 7. 首轮命中率（逐批）

| 批 | 首轮 hits | 登记行 | 命中率 |
| --- | ---: | ---: | ---: |
| b292 | 10 | 98 | 10.2% |
| b293 | 2 | 98 | 2.0% |
| b294 | 6 | 98 | 6.1% |
| b295 | 8 | 97 | 8.2% |
| b296 | 10 | 91 | 11.0% |
| b297 | 5 | 91 | 5.5% |
| **b298** | **4** | **90** | **4.4%** |

- 近七批均值约 6.8%（45/663）；本批 4.4%，低于均值，且 4 条里 3 条是「纯中文短句缺锚点」的已知模式。

## 8. 剩余工作量（按 post-b298 更新）

| 口径 | 单位耗时 | 3,180 行折算 | 说明 |
| --- | ---: | ---: | --- |
| `controllable`（新口径 n=7，中位数） | 1.66 s/行 | 5,279 s ≈ 1.5 h | 只作区间 |
| 端到端（b286 实测） | 5.67 s/行 | 18,031 s ≈ **5.0 h** | 含门禁、返修、快照、台账 |
| 批次折算 | 90 行/批 | **约 35 批** | `3,180 / 90 ≈ 35` |

## 9. 池外对账

| 快照 | 提交 | weak | files | remain | 池外 |
| --- | --- | ---: | ---: | ---: | ---: |
| post-b295 | `849f438f` | 6704 | 1881 | 3450 | 3254 |
| post-b296 | `b4a61ced` | 6613 | 1874 | 3359 | 3254 |
| post-b297 | `d6cf1991` | 6522 | 1872 | 3270 | 3252 |
| post-b298 | `ea942c5d` | 6432 | 1866 | 3180 | 3252 |

- `6522 − 6432 = 90` = 池内前移 90 行；池外 3252 保持不变。
