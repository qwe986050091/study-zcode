# ZC-deep-b303：3 文件 / 36 行（全池内，无自清）

> 批次：b303 ｜ 代码提交 `3e50b96c` ｜ `+36/−36` ｜ 零代码行
> 尺子：`deep-quality.mjs` v2.0（`756bea66122a`）、`zc-commit.mjs` v13（`f02be471a849`）、
> `precheck-assert.mjs`（`--start` 实盘逐行基准的第十五批）、
> `capacity-estimate.mjs`、`weak-guard.mjs`、`ledger-assert.mjs`。

## 0. 交代

1. 本批 3 文件 / **36 行，全部池内**（`ownIn=36 ownOut=0 upIn=0 upOut=0 pending=0 plan=36 allow=0`）。
   `12 × 3 = 36`。
2. 新节奏（30–40 行 / 批）第二批，十道门禁全跑。
3. 起笔前白名单已在 `5a94ed81` 随 b302 台账入账（344 行 / `head=3f5f1757`），工作树干净，
   直接 `--start`（`2026-11-11T06:56:16.447Z`，3 文件 518 行实盘逐行基准）。
4. 流程：`--start` → `b303-apply.mjs`（`changed=36 same=0`）→ 判据预判（首轮 3 条：2 W + 1 L → 0，全用 Edit 工具）
   → `--scope` → `--record`（首跑即过，`record_runs=1`）→ `--verify` → `zc-commit v13` → `--order`。
5. 七行门禁：`expected=3 staged=3`，`+36/−36`；顺序断言
   `t-start 06:56:16.447 < t-record 06:56:54.626 ≤ t-verify 06:56:55.806 < commit 14:57:19+08:00`。
6. 第 8 行门禁第十五批：`indentChanged=0 eolChanged=0`、`SAME 0`、`touched_restored=0`、
   `line_drift=0`、`out_of_scope_edits=0`。全程只用 Edit/apply 脚本，无 BOM。
7. 本批结束重生成白名单：**346 行 / `head=3e50b96c`**（未提交，随台账一起入账）。

## 1. 计划表

| 文件 | 池内 | 池外 own | 本批 | 批后 weak |
| --- | ---: | ---: | ---: | ---: |
| `packages/ui/src/ToolCallBlocks/renderers/fallback.tsx` | 12 | 0 | 12 | 0 |
| `packages/ui/src/hooks/useBotBoundGroups.ts` | 12 | 0 | 12 | 0 |
| `packages/ui/src/lib/exploreToolCall.ts` | 12 | 0 | 12 | 0 |
| **合计** | **36** | **0** | **36** | **0** |

## 2. 批后池

```text
done files=318（+3）   remain files=689
done lines=4595（+36） remain lines=2826（−36）
ALIGNED acct_remain=2826 pool_remain=2826 diff=0
完成度 4595 / 7421 = 61.9%
```

- 写入 36 行、池内前移 36 行，一一对应：无 PARTIAL 新增、无自清，`record_runs=1`。
- PARTIAL 仍为 3：`cuaDetails.tsx`（23 → 1）、`script-workflow-process.ts`（13 → 1）、
  `CoveragePanel.tsx`（13 → 2）。
- 全仓：`6113 → 6077`（−36）；池外 `6077 − 2826 = 3251`，与 post-b302 持平。
- 档位分布见 `capacity-estimate` 输出；批数对照 345。
- `done 4,595` 的台账口径：**「已写入 4,595 行，其中 10 行经 N/P 双读，fail 1」**。

## 3. 计时（新节奏，n=2）

```text
t-start    2026-11-11T06:56:16.447Z
t-record   2026-11-11T06:56:54.626Z  sha=f9ded46e713b  record_runs=1
t-verify   2026-11-11T06:56:55.806Z  sha=f9ded46e713b
commit     2026-11-11T14:57:19+08:00  3e50b96c

batch_wall_total        =  89.0 s（5a94ed81 → 3e50b96c）
batch_wall_controllable =  63.0 s（t-start → commit）
落笔段                  =  39.4 s（t-start → t-verify）
tail                    =   1.2 s（t-record → t-verify）
s/行（端到端，落笔段）    = 1.75（63.0 / 36）
```

- 起草在 `--start` 之后，`controllable` 合法；小批 n=2（b302 3.69、b303 1.75），
  差异来自 b302 首跑 apply 中断重跑，不作节奏结论。

## 4. 度量前后

| 文件 | weak 前→后 |
| --- | ---: |
| `ToolCallBlocks/renderers/fallback.tsx` | 12 → 0 |
| `hooks/useBotBoundGroups.ts` | 12 → 0 |
| `lib/exploreToolCall.ts` | 12 → 0 |

- 全仓：`post-b302 6113 / 1841` → `post-b303 6077 / 1838`。
- 池内：`done 4559 / remain 2862` → `done 4595 / remain 2826`。

## 5. 门禁

```text
删本线注释 n=36   删代码 n=0   删上游注释 n=0
新增非注释行 n=0  原行搬移 n=0  标点级改写 n=0
新增注释行 n=36   判据命中 0   嵌套注释 0
numstat: +36 −36
PRECHECK SAME same_rewrites=0（record / verify 各一次）
PRECHECK SCOPE plan=36 allow=0 diff_old=36 diff_new=36 out_of_scope_edits=0
PRECHECK INDENT indentChanged=0 eolChanged=0
PRECHECK MTIME  touched_restored=0  LINE-DRIFT files=0
ORDER GATE PASS
```

- `record_runs=1`：**预检无返修**。
- 首轮预判 `hits=3`（2 W + 1 L），一轮返修后 `hits=0`：
  - W：`exploreToolCall.ts:78`（无标识符）→ 补 `collectFromValue`。
  - W：`exploreToolCall.ts:79`（无标识符）→ 补 `findIndex`。
  - L：`exploreToolCall.ts:164`（四项列举无谓词）→ 补「直接返回 true」。
- 起草无 `SAME`，`changed=36 same=0`。

## 6. 收口

```text
GUARD 15文件 pre=4 post=4 新增=0 max=8 → PASS
ACCT files 318 + 689 = 1007 OK
ACCT lines 4595 + 2826 = 7421 OK
ALIGNED acct_remain=2826 pool_remain=2826 diff=0
ledger-assert ASSERT PASS（CLOSE 802 = 802，EXEMPT 2）
OWNCOMMITS rows=346 generated=346 missing=0 extra=0 text=same
WHITELIST OK head=3e50b96c rows=346
SELF-CLEAR n=0
```

## 7. 首轮命中率（逐批）

| 批 | 首轮 hits | 登记行 | 命中率 |
| --- | ---: | ---: | ---: |
| b298 | 4 | 90 | 4.4% |
| b299 | 4 | 91 | 4.4% |
| b300 | 6 | 91 | 6.6% |
| b301 | 2 | 100 | 2.0% |
| b302 | 2 | 36 | 5.6% |
| **b303** | **3** | **36** | **8.3%** |

- b283–b303 二十一批合计 `111 / 1,839 ≈ 6.0%`；近七批（b297–b303）`26 / 535 ≈ 4.9%`。

## 8. 剩余工作量（按 post-b303 更新）

| 口径 | 单位耗时 | 2,826 行折算 | 说明 |
| --- | ---: | ---: | --- |
| 旧新口径 n=7 中位数（90–100 行批） | 1.66 s/行 | 4,691 s ≈ 1.3 h | 只作区间 |
| 30–40 行小批（b302–b303，n=2） | 3.69 / 1.75 s/行 | — | 样本不足，不给合并值 |
| 批次折算（35 行/批） | 35 行/批 | **约 81 批** | `2,826 / 35 ≈ 80.7` |

## 9. 池外对账

| 快照 | 提交 | weak | files | remain | 池外 |
| --- | --- | ---: | ---: | ---: | ---: |
| post-b299 | `d0b6e6ce` | 6341 | 1859 | 3089 | 3252 |
| post-b300 | `b910ddfa` | 6250 | 1852 | 2998 | 3252 |
| post-b301 | `abccbe47` | 6149 | 1844 | 2898 | 3251 |
| post-b302 | `3f5f1757` | 6113 | 1841 | 2862 | 3251 |
| post-b303 | `3e50b96c` | 6077 | 1838 | 2826 | 3251 |

- `6113 − 6077 = 36` = 池内前移 36 行；池外 3251 不变。
