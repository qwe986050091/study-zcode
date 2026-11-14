# ZC-deep-b287：6 文件 / 92 行（90 池内 + 2 池外 own）+ 3 行邻行自清

> 批次：b287 ｜ 提交 `c8e58ba3` ｜ 代码 `+92/−92` ｜ 零代码行
> 尺子：`deep-quality.mjs` v2.0（`756bea66122a`）、`zc-commit.mjs` v13（`f02be471a849`）、
> `precheck-assert.mjs`（含第 8 行门禁）、`capacity-estimate.mjs`、`weak-guard.mjs`、`ledger-assert.mjs`。

## 0. 交代

1. 本批 6 文件 / **92 行**：**90 行池内** + **2 行池外 own**（plan 内、不进 `done`）。
2. 新口径第 2 个样本：`--start`（`2026-11-11T03:28:11.005Z`）先于起草，后台 `--watch` 10 s 采样。
3. 流程：`--start` → 起草 → 改写 → `--scope`（`plan=92 diff_old=92 diff_new=92 out_of_scope=0`）
   → `--record`（`hits=0 record_runs=1`）→ `--verify` → `zc-commit v13` → `--order`。
4. 七行门禁：`expected=6 staged=6`，`+92/−92`；顺序断言 `t-start < t-record <= t-verify < commit`。
5. 起草期先做判据预判，首轮 `hits=2`（1 W + 1 L），返修后 `--record` **一次通过**。

## 1. 计划表

| 文件 | 池内 | 池外 own | 本批 | 批后 weak |
| --- | ---: | ---: | ---: | ---: |
| `apps/zcode-cli/packages/core/src/runtime/methods/goal-summary-title.ts` | 15 | 1 | 16 | 0 |
| `apps/zcode-cli/packages/office-runtime/src/adapters/parse/docx.ts` | 15 | 1 | 16 | 0 |
| `packages/ui/src/components/workflow-timeline/WorkflowCompletionCard.tsx` | 15 | 0 | 15 | 1 |
| `packages/ui/src/project-sidebar/useTaskGroups.ts` | 15 | 0 | 15 | 1 |
| `packages/zcode-server-cli/src/server-core/core.ts` | 15 | 0 | 15 | 0 |
| `apps/zcode-cli/packages/adapters/src/exec/node-execution-adapter-base.ts` | 15 | 0 | 15 | 0 |
| **合计** | **90** | **2** | **92** | **2** |

## 2. 批后池

```text
done files=218（+6）  remain files=789
done lines=3214（+90） remain lines=4207（−90）
ALIGNED acct_remain=4207 pool_remain=4207 diff=0
```

- 登记 92 行 ≠ `done +90`：差 2 行是池外 own。
- 另有 **3 行池外上游**（`WorkflowCompletionCard.tsx:87/114`、`core.ts:63`）因相邻改写自动转强，
  由 `capacity-estimate` 记为 `SELF-CLEAR n=3 / out-of-pool`，不进 `done`。

## 3. 计时（新口径 n=2，仍单列）

```text
t-start    2026-11-11T03:28:11.005Z
t-record   2026-11-11T03:29:54.039Z  sha=cad003f5a83c  record_runs=1
t-verify   2026-11-11T03:30:00.534Z
commit     2026-11-11T03:30:40Z      c8e58ba3

batch_wall_total        = 186.0 s
batch_wall_controllable = 149.0 s（含起草时间）
落笔段                  = 109.5 s（含起草时间）
tail                    =   6.5 s
s/行（新口径）          = 1.62（149.0 / 92）
```

- 新口径累计 **n=2**（3.26、1.62），**仍不做与旧口径 1.59 的快慢比较**，也不做新口径内部结论；
  等 n≥5 再谈中位数。
- `batch_wall_total` 含批间非改写动作，不得除以行数当改写成本。

## 4. 度量前后

| 文件 | weak 前→后 |
| --- | ---: |
| `goal-summary-title.ts` | 16 → 0 |
| `docx.ts` | 16 → 0 |
| `WorkflowCompletionCard.tsx` | 18 → 1 |
| `useTaskGroups.ts` | 16 → 1 |
| `core.ts` | 16 → 0 |
| `node-execution-adapter-base.ts` | 15 → 0 |
| **合计** | **97 → 2** |

- 全仓：`post-b286 7566 / 1928` → `post-b287 7471 / 1924`（−95 行 / −4 文件）；`filler 2509 → 2419`。
- 池内：`post-b286 done 3124 / remain 4297` → `post-b287 done 3214 / remain 4207`（−90）。
- 池外：`post-b287 7471 − 4207 = 3264`；`post-b286` 为 `3269`，减少 **5**
  = 2 行池外 own + 3 行邻行自清；`90 + 2 + 3 = 95`，与全仓减少量闭合。

## 5. 门禁

```text
删本线注释 n=92   删代码 n=0   删上游注释 n=0
新增非注释行 n=0  原行搬移 n=0  标点级改写 n=0
新增注释行 n=92   判据命中 0   嵌套注释 0
numstat: +92 −92
PRECHECK INDENT indentChanged=0 eolChanged=0（record / verify 各一次）
PRECHECK MTIME  touched_restored=0
PRECHECK LINE-DRIFT samples=61/67 files=0
ORDER GATE PASS
```

- 首轮预判 2 hits：`core.ts:57`（W，正文无 ASCII 锚点）、`WorkflowCompletionCard.tsx:89`（L，两个逗号无谓词）。
  返修补 `topicResourcePeers` 标识符与「先…再」谓词后 `hits=0`。

## 6. 收口

```text
GUARD 15文件 pre=4 post=4 新增=0 max=8 → PASS
ACCT files 218 + 789 = 1007 OK
ACCT lines 3214 + 4207 = 7421 OK
ALIGNED acct_remain=4207 pool_remain=4207 diff=0
ledger-assert PASS
WHITELIST OK head=c8e58ba32b7d rows=295
PARTIAL 1：cuaDetails.tsx 基线 23 → 现 1
```

## 7. 首轮命中率（逐批）

| 批 | 首轮 hits | 登记行 | 命中率 |
| --- | ---: | ---: | ---: |
| b283 | 3 | 96 | 3.1% |
| b284 | 7 | 100 | 7.0% |
| b285 | 1 | 70 | 1.4% |
| b286 | 8 | 97 | 8.2% |
| **b287** | **2** | **92** | **2.2%** |

- 五批均值约 4.4%，b287 回落到 2.2%，未见与文件类型相关的异常升高。

## 8. 剩余工作量（按 post-b287 更新）

| 口径 | 单位耗时 | 4,207 行折算 | 说明 |
| --- | ---: | ---: | --- |
| 仅 `controllable`（新口径 n=2） | 3.26 / 1.62 s/行 | 13,715 / 6,815 s ≈ 3.8 / 1.9 h | 只作区间，不取单点 |
| 端到端（b286 实测） | 5.67 s/行 | 23,853 s ≈ **6.6 h** | 含门禁、返修、快照、台账 |
| 批次折算 | 100 行/批 | **43 批** | `4,207 / 100 ≈ 43` |

- 结论不变：剩余工作量**小时级（约 4–7 小时可控时间 + 43 批固定动作）**，不是天级。
- 新口径 n=2 的内部差距（3.26 vs 1.62）主要来自 b286 首轮 8 hits 返修与文件类型差异，样本不足，不做归因。

## 9. 池外对账

| 快照 | 提交 | weak | remain | 池外 |
| --- | --- | ---: | ---: | ---: |
| post-b286 | `a899f645` | 7566 | 4297 | 3269 |
| post-b287 | `c8e58ba3` | 7471 | 4207 | 3264 |

- `3269 − 3264 = 5` = 2 池外 own + 3 邻行自清（上游 blame、非池）；池内 `4297 − 4207 = 90`；
  `90 + 5 = 95` = `7566 − 7471`。
