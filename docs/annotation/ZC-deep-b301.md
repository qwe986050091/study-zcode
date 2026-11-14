# ZC-deep-b301：8 文件 / 100 行（全池内，无自清）

> 批次：b301 ｜ 提交 `abccbe47` ｜ 代码 `+100/−100` ｜ 零代码行
> 尺子：`deep-quality.mjs` v2.0（`756bea66122a`）、`zc-commit.mjs` v13（`f02be471a849`）、
> `precheck-assert.mjs`（`--start` 实盘逐行基准的第十三批）、
> `capacity-estimate.mjs`、`weak-guard.mjs`、`ledger-assert.mjs`。

## 0. 交代

1. 本批 8 文件 / **100 行，全部池内**（`ownIn=100 ownOut=0 upIn=0 upOut=0 pending=0 plan=100 allow=0`）。
   `13 × 4 + 12 × 4 = 100`。
2. 起笔前重跑 `own-commits-gen`（338 行 / `head=6ef90f15`），白名单单独提交（`ff8c1184`）后才 `--start`
   （`2026-11-11T06:45:02.417Z`，8 文件 3,137 行实盘逐行基准）。
   **计时口径例外（同 b293–b300）**：映射先于 `--start` 起草，`controllable` 只覆盖「落笔 → 提交」，
   **不进入中位数**。
3. 流程：`--start` → `b301-apply.mjs`（1→1，`changed=99 same=0`，1 行缩进前缀未匹配改由 Edit 补齐）
   → 判据预判（首轮 2 条 → 0，全用 Edit 工具）→ `--scope` → `--record`（首跑即过，`record_runs=1`）
   → `--verify` → `zc-commit v13` → `--order`。
4. 本批是 90–100 行口径的**最后一批**。按新指令，b302 起改为**每批 30–40 行、一批一提交**，
   十道门禁照旧全跑；`--start` 前仍先重跑 `own-commits-gen.mjs`。
5. 七行门禁：`expected=8 staged=8`，`+100/−100`；顺序断言
   `t-start 06:45:02.417 < t-record 06:46:23.694 ≤ t-verify 06:46:30.934 < commit 14:46:53+08:00`。
6. 第 8 行门禁第十三批：`indentChanged=0 eolChanged=0`、`SAME 0`、`touched_restored=0`、
   `line_drift=0`、`out_of_scope_edits=0`。全程只用 Edit/apply 脚本，无 BOM。
7. 本批结束重生成白名单：**340 行 / `head=abccbe47`**（未提交，随台账一起入账）。

## 1. 计划表

| 文件 | 池内 | 池外 own | 本批 | 批后 weak |
| --- | ---: | ---: | ---: | ---: |
| `packages/ui/src/quickpick/QuickPickCommandDialog.tsx` | 13 | 0 | 13 | 0 |
| `packages/ui/src/settings/model-provider-section/CodingPlanStatusActions.tsx` | 13 | 0 | 13 | 0 |
| `packages/ui/src/settings/model-provider-section/Detail.tsx` | 13 | 0 | 13 | 0 |
| `packages/ui/src/store/workspaceHookReviewStore.ts` | 13 | 0 | 13 | 0 |
| `apps/zcode-cli/packages/core/src/runtime/methods/workspace-fork.ts` | 12 | 0 | 12 | 0 |
| `docs/knip/docs/src/util/post.ts` | 12 | 0 | 12 | 0 |
| `packages/desktop/scripts/gen-ui-fixture/style-checks.ts` | 12 | 0 | 12 | 0 |
| `packages/desktop/vite.config.ts` | 12 | 0 | 12 | 0 |
| **合计** | **100** | **0** | **100** | **0** |

## 2. 批后池

```text
done files=312（+8）  remain files=695
done lines=4523（+100）remain lines=2898（−100）
ALIGNED acct_remain=2898 pool_remain=2898 diff=0
完成度 4523 / 7421 = 60.9%
```

- 写入 100 行、池内前移 100 行，一一对应：无 PARTIAL 新增、无自清，`record_runs=1`。
- PARTIAL 仍为 3：`cuaDetails.tsx`（23 → 1）、`script-workflow-process.ts`（13 → 1）、
  `CoveragePanel.tsx`（13 → 2），本批未新增、未消化。
- 全仓：`6250 → 6150`（−100）；池外 `6150 − 2898 = 3252`，与 post-b300 持平，闭合。
- 档位分布：`>=20` 0，`10-19` 96 文件 / 1,046 行，`5-9` 141 / 931，`3-4` 158 / 539，`1-2` 300 / 382。
- `done 4,523` 的台账口径：**「已写入 4,523 行，其中 10 行经 N/P 双读，fail 1」**。

## 3. 计时（口径例外，不进入中位数）

```text
t-start    2026-11-11T06:45:02.417Z
t-record   2026-11-11T06:46:23.694Z  sha=1333876dd0ba  record_runs=1
t-verify   2026-11-11T06:46:30.934Z  sha=1333876dd0ba
commit     2026-11-11T14:46:53+08:00  abccbe47

batch_wall_total        = 228.0 s（ff8c1184 → abccbe47）
batch_wall_controllable = 111.0 s（t-start → commit）
落笔段                  =  88.5 s（t-start → t-verify）
tail                    =   7.2 s（t-record → t-verify）
s/行（端到端，落笔段）    = 1.11（111.0 / 100）
```

- 起草在 `--start` 之前完成，本样本与 b284/b285/b293–b300 同列「测量口径失效」，
  **不进入新口径 n=7 的中位数（仍为 1.66 s/行）**。

## 4. 度量前后

| 文件 | weak 前→后 |
| --- | ---: |
| `QuickPickCommandDialog.tsx` | 13 → 0 |
| `CodingPlanStatusActions.tsx` | 13 → 0 |
| `settings/model-provider-section/Detail.tsx` | 13 → 0 |
| `workspaceHookReviewStore.ts` | 13 → 0 |
| `runtime/methods/workspace-fork.ts` | 12 → 0 |
| `docs/knip/docs/src/util/post.ts` | 12 → 0 |
| `scripts/gen-ui-fixture/style-checks.ts` | 12 → 0 |
| `packages/desktop/vite.config.ts` | 12 → 0 |

- 全仓：`post-b300 6250 / 1852` → `post-b301 6150 / 1844`。
- 池内：`done 4423 / remain 2998` → `done 4523 / remain 2898`。

## 5. 门禁

```text
删本线注释 n=100  删代码 n=0   删上游注释 n=0
新增非注释行 n=0  原行搬移 n=0  标点级改写 n=0
新增注释行 n=100  判据命中 0   嵌套注释 0
numstat: +100 −100
PRECHECK SAME same_rewrites=0（record / verify 各一次）
PRECHECK SCOPE plan=100 allow=0 diff_old=100 diff_new=100 out_of_scope_edits=0
PRECHECK INDENT indentChanged=0 eolChanged=0
PRECHECK MTIME  touched_restored=0  LINE-DRIFT files=0
ORDER GATE PASS
```

- `record_runs=1`：**预检无返修**。
- 首轮预判 `hits=2`（2 W，0 L），一轮返修后 `hits=0`：
  - W：`workspace-fork.ts:73`（补 `unlink`）、`workspace-fork.ts:296`（补 `notice`）。
  - 另有 1 行 `Detail.tsx:163` 因缩进前缀（`//   3)`）未被 apply 的 `^//\s?` 剥净而跳过，
    改用 Edit 工具按原缩进补齐，计入本批 `changed=100`。
- 起草无 `SAME`，`changed=100 same=0`，不构成空替换。

## 6. 收口

```text
GUARD 15文件 pre=4 post=4 新增=0 max=8 → PASS
ACCT files 312 + 695 = 1007 OK
ACCT lines 4523 + 2898 = 7421 OK
ALIGNED acct_remain=2898 pool_remain=2898 diff=0
ledger-assert ASSERT PASS（CLOSE 802 = 802，EXEMPT 2）
OWNCOMMITS rows=340 generated=340 missing=0 extra=0 text=same
WHITELIST OK head=abccbe47 rows=340
SELF-CLEAR n=0
```

## 7. 首轮命中率（逐批）

| 批 | 首轮 hits | 登记行 | 命中率 |
| --- | ---: | ---: | ---: |
| b294 | 6 | 98 | 6.1% |
| b295 | 8 | 97 | 8.2% |
| b296 | 10 | 91 | 11.0% |
| b297 | 5 | 91 | 5.5% |
| b298 | 4 | 90 | 4.4% |
| b299 | 4 | 91 | 4.4% |
| b300 | 6 | 91 | 6.6% |
| **b301** | **2** | **100** | **2.0%** |

- b283–b301 十九批合计 `106 / 1,767 ≈ 6.0%`；近七批（b295–b301）`39 / 651 ≈ 6.0%`。
  本批命中降到 2 条，说明「先读代码再落注释」的映射质量在提升。

## 8. 剩余工作量（按 post-b301 更新）

| 口径 | 单位耗时 | 2,898 行折算 | 说明 |
| --- | ---: | ---: | --- |
| `controllable`（新口径 n=7，中位数） | 1.66 s/行 | 4,811 s ≈ 1.3 h | 只作区间 |
| 端到端（b286 实测） | 5.67 s/行 | 16,432 s ≈ **4.6 h** | 含门禁、返修、快照、台账 |
| 批次折算（新口径） | 35 行/批 | **约 83 批** | `2,898 / 35 ≈ 82.8` |

## 9. 池外对账

| 快照 | 提交 | weak | files | remain | 池外 |
| --- | --- | ---: | ---: | ---: | ---: |
| post-b297 | `d6cf1991` | 6522 | 1872 | 3270 | 3252 |
| post-b298 | `ea942c5d` | 6432 | 1866 | 3180 | 3252 |
| post-b299 | `d0b6e6ce` | 6341 | 1859 | 3089 | 3252 |
| post-b300 | `b910ddfa` | 6250 | 1852 | 2998 | 3252 |
| post-b301 | `abccbe47` | 6150 | 1844 | 2898 | 3252 |

- `6250 − 6150 = 100` = 池内前移 100 行；池外 `6150 − 2898 = 3252` 保持不变。
