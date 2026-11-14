# ZC-deep-b302：3 文件 / 36 行（全池内，无自清）

> 批次：b302 ｜ 代码提交 `3f5f1757` ｜ `+36/−36` ｜ 零代码行
> 尺子：`deep-quality.mjs` v2.0（`756bea66122a`）、`zc-commit.mjs` v13（`f02be471a849`）、
> `precheck-assert.mjs`（`--start` 实盘逐行基准的第十四批）、
> `capacity-estimate.mjs`、`weak-guard.mjs`、`ledger-assert.mjs`。

## 0. 交代

1. 本批 3 文件 / **36 行，全部池内**（`ownIn=36 ownOut=0 upIn=0 upOut=0 pending=0 plan=36 allow=0`）。
   `12 × 3 = 36`。
2. **口径切换后的第一批**：按新指令改为 **30–40 行 / 批**（b301 是 90–100 行口径的最后一批）。
   十道门禁照旧全跑，未删减任何一条。
3. 起笔前重跑 `own-commits-gen`（341 行 / `head=48d73ec8`）并单独提交（`dbffe1b3`）；
   因 `--start` 要求工作树干净，又重生成一次并提交（342 行，`6464ceb1`），
   之后才 `--start`（`2026-11-11T06:50:09.814Z`，3 文件 724 行实盘逐行基准）。
4. 流程：`--start` → `b302-apply.mjs`（1→1）→ 判据预判（首轮 2 条 L → 0，用 Edit 工具改写 2 行）
   → `--scope` → `--record`（首跑即过，`record_runs=1`）→ `--verify` → `zc-commit v13` → `--order`。
5. 如实记录一处操作失误：`b302-apply.mjs` 首跑漏填 `runtimeEnv.ts:54` 的映射，
   在第 2 个文件处抛 `missing rewrite` 中断，此时第 1 个文件（12 行）已落盘；
   补齐映射后重跑，脚本按 `currentBody === next` 跳过已改行，最终 `git diff --numstat` 恰为 `12/12 × 3`。
   属起草脚本自身缺项，不涉及门禁读数，`record_runs` 仍为 1。
6. 七行门禁：`expected=3 staged=3`，`+36/−36`；顺序断言
   `t-start 06:50:09.814 < t-record 06:51:50.419 ≤ t-verify 06:51:56.441 < commit 14:52:22+08:00`。
7. 第 8 行门禁第十四批：`indentChanged=0 eolChanged=0`、`SAME 0`、`touched_restored=0`、
   `line_drift=0`、`out_of_scope_edits=0`。全程只用 Edit/apply 脚本，无 BOM。
8. 本批结束重生成白名单：**344 行 / `head=3f5f1757`**（未提交，随台账一起入账）。

## 1. 计划表

| 文件 | 池内 | 池外 own | 本批 | 批后 weak |
| --- | ---: | ---: | ---: | ---: |
| `packages/rpc/src/network-telemetry-middleware.ts` | 12 | 0 | 12 | 0 |
| `packages/shared/src/runtimeEnv.ts` | 12 | 0 | 12 | 0 |
| `packages/shared/src/zcode-protocol-v4/wire.ts` | 12 | 0 | 12 | 0 |
| **合计** | **36** | **0** | **36** | **0** |

## 2. 批后池

```text
done files=315（+3）   remain files=692
done lines=4559（+36） remain lines=2862（−36）
ALIGNED acct_remain=2862 pool_remain=2862 diff=0
完成度 4559 / 7421 = 61.4%
```

- 写入 36 行、池内前移 36 行，一一对应：无 PARTIAL 新增、无自清，`record_runs=1`。
- PARTIAL 仍为 3：`cuaDetails.tsx`（23 → 1）、`script-workflow-process.ts`（13 → 1）、
  `CoveragePanel.tsx`（13 → 2），本批未新增、未消化。
- 全仓：`6149 → 6113`（−36）；池外 `6113 − 2862 = 3251`（post-b301 快照明细 6149 − 2898 = 3251，闭合）。
- 档位分布：`>=20` 0，`10-19` 93 文件 / 1,010 行，`5-9` 141 / 931，`3-4` 158 / 539，`1-2` 300 / 382。
- `done 4,559` 的台账口径：**「已写入 4,559 行，其中 10 行经 N/P 双读，fail 1」**。

## 3. 计时（新节奏，n=1）

```text
t-start    2026-11-11T06:50:09.814Z
t-record   2026-11-11T06:51:50.419Z  sha=2d37a4e9f044  record_runs=1
t-verify   2026-11-11T06:51:56.441Z  sha=2d37a4e9f044
commit     2026-11-11T14:52:22+08:00  3f5f1757

batch_wall_total        = 137.0 s（6464ceb1 → 3f5f1757）
batch_wall_controllable = 133.0 s（t-start → commit）
落笔段                  = 106.6 s（t-start → t-verify）
tail                    =   6.0 s（t-record → t-verify）
s/行（端到端，落笔段）    = 3.69（133.0 / 36）
```

- 起草全部发生在 `--start` 之后，`controllable` 含起草 + 落笔，**本批是新节奏的合法样本**。
- 30–40 行小批的端到端单位成本明显高于 90–100 行批（3.69 vs 1.11–1.66 s/行），
  这是固定开销（10 道门禁 + 快照 + 台账）摊到更少行上的必然结果；
  与旧口径 n=7 中位数（1.66 s/行）**不同节奏，不混算**。

## 4. 度量前后

| 文件 | weak 前→后 |
| --- | ---: |
| `network-telemetry-middleware.ts` | 12 → 0 |
| `runtimeEnv.ts` | 12 → 0 |
| `wire.ts` | 12 → 0 |

- 全仓：`post-b301 6149 / 1844` → `post-b302 6113 / 1841`。
- 池内：`done 4523 / remain 2898` → `done 4559 / remain 2862`。

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
- 首轮预判 `hits=2`（2 L，0 W），一轮返修后 `hits=0`：
  - L：`network-telemetry-middleware.ts:33`（`dnsMs、tcpMs…` 三项列举无谓词）→ 改为「由 http 链路填写」。
  - L：`runtimeEnv.ts:140`（`development、production、test` 列举无谓词）→ 改为「只返回 … 三个取值」。
- 起草无 `SAME`，`changed=36 same=0`，不构成空替换。

## 6. 收口

```text
GUARD 15文件 pre=4 post=4 新增=0 max=8 → PASS
ACCT files 315 + 692 = 1007 OK
ACCT lines 4559 + 2862 = 7421 OK
ALIGNED acct_remain=2862 pool_remain=2862 diff=0
ledger-assert ASSERT PASS（CLOSE 802 = 802，EXEMPT 2）
OWNCOMMITS rows=344 generated=344 missing=0 extra=0 text=same
WHITELIST OK head=3f5f1757 rows=344
SELF-CLEAR n=0
```

## 7. 首轮命中率（逐批）

| 批 | 首轮 hits | 登记行 | 命中率 |
| --- | ---: | ---: | ---: |
| b297 | 5 | 91 | 5.5% |
| b298 | 4 | 90 | 4.4% |
| b299 | 4 | 91 | 4.4% |
| b300 | 6 | 91 | 6.6% |
| b301 | 2 | 100 | 2.0% |
| **b302** | **2** | **36** | **5.6%** |

- b283–b302 二十批合计 `108 / 1,803 ≈ 6.0%`；近七批（b296–b302）`26 / 587 ≈ 4.4%`。

## 8. 剩余工作量（按 post-b302 更新）

| 口径 | 单位耗时 | 2,862 行折算 | 说明 |
| --- | ---: | ---: | --- |
| 旧新口径 n=7 中位数（90–100 行批） | 1.66 s/行 | 4,751 s ≈ 1.3 h | 只作区间，不适用于小批 |
| 30–40 行小批（b302 实测，n=1） | 3.69 s/行 | 10,561 s ≈ **2.9 h** | 固定开销占比高 |
| 批次折算（新节奏 35 行/批） | 35 行/批 | **约 82 批** | `2,862 / 35 ≈ 81.8` |

## 9. 池外对账

| 快照 | 提交 | weak | files | remain | 池外 |
| --- | --- | ---: | ---: | ---: | ---: |
| post-b298 | `ea942c5d` | 6432 | 1866 | 3180 | 3252 |
| post-b299 | `d0b6e6ce` | 6341 | 1859 | 3089 | 3252 |
| post-b300 | `b910ddfa` | 6250 | 1852 | 2998 | 3252 |
| post-b301 | `abccbe47` | 6149 | 1844 | 2898 | 3251 |
| post-b302 | `3f5f1757` | 6113 | 1841 | 2862 | 3251 |

- 口径修正：b301 台账正文写「post-b301 6150」，而快照 `b301-repo-post.txt` 的明细与
  `WEAK lines=` 都是 **6149**；本表按快照实数填，池外因此为 3251 而非 3252。
  该 1 行差异是上一批写台账时把 `--weak` 快照与另一次读数混用，**不是本批造成的**，
  `done / remain` 走池内交集，未受影响（b301 的 `ALIGNED diff=0` 亦成立）。
- `6149 − 6113 = 36` = 池内前移 36 行，无自清。
