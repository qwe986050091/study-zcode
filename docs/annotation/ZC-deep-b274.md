# ZC-deep-b274：注释清水 100 行（6 文件）· 集合断言首用

> 批次：b274 ｜ 提交 `db65b565` ｜ 代码 `+100/−100` ｜ 零代码行
> 尺子：`deep-quality.mjs` v2.0（`756bea66122a`）、`zc-commit.mjs` v12（`a35b42fa2e4c`）、
> `capacity-estimate.mjs`（`71c35d496da1`）、`weak-guard.mjs`（`a3600ccfacab`）、
> `ledger-assert.mjs`（`35afeb266f97`）、`precheck-assert.mjs`（`6caca03d66ad`，集合断言首用）。
> 尺子升级提交：`068ea17a`（介于 b273 与本批之间，不计入任何一批的改写量）。

## 0. 交代

1. 本批 6 文件 / 100 行，全部池内可写：`writable=100 / upstream=0 / self-clearing=0 / pool-out=9 / quota=100`。
2. 6 文件：`alert-dialog.tsx`(19)、`dialog.tsx`(19)、`WorkflowTimelineTracks.tsx`(19)、
   `modelConfigSync.ts`(19)、`project-sidebar/contract.ts`(19)、`runtime-command-queue.ts`(5)。
3. 预检两轮：首轮 9 条 W（缺 ASCII 标识符），补标识符后 `record n=100 hits=0 sha=a1f87a7bc76b`，`record_runs=2`。
4. 七行门禁全 0，`expected=6 staged=6`，`+100/−100`。
5. **集合断言首用**：`--record --plan --allow` 硬断言「改动行集合 == plan 行集合」，越界 0 / 漏改 0。

## 1. 四态摘要与三列计划表（沿用 b265 §2）

```text
PLAN#1	6 文件 / 100 行	writable=100 upstream=0 self-clearing=0 pool-out=9 pending=0
quota=100(writable 100 − self-clearing 0) 四态和=109=weak合计 109 池内weak=100/池内实测 100
```

| 文件 | 可写 | 上游 | 池外 | 小计 |
| --- | ---: | ---: | ---: | ---: |
| `packages/ui/src/components/ui/alert-dialog.tsx` | 19 | 0 | 0 | 19 |
| `packages/ui/src/components/ui/dialog.tsx` | 19 | 0 | 0 | 19 |
| `packages/ui/src/components/workflow-timeline/WorkflowTimelineTracks.tsx` | 19 | 0 | 8 | 27 |
| `packages/ui/src/lib/modelConfigSync.ts` | 19 | 0 | 0 | 19 |
| `packages/ui/src/project-sidebar/contract.ts` | 19 | 0 | 0 | 19 |
| `apps/zcode-cli/packages/core/src/runtime/methods/runtime-command-queue.ts` | 5 | 0 | 1 | 6 |
| **合计** | **100** | **0** | **9** | **109** |

- 池外 9 行全在 `--allow` 里逐行登记（`b274-allow.txt`）：
  `WorkflowTimelineTracks.tsx` 的 `45/46/59/93/112/194/243/256` 与 `runtime-command-queue.ts:122`。
  其中 45/46 是上游 JSDoc 续行，其余为本线池外行；**本批没有改动其中任何一行**。

## 2. 配额扣减与批后池

```text
SELF-CLEAR n=2	可写桶 0 / 池外 2 / 上游桶 0 / 未解析 0
  packages/ui/src/components/workflow-timeline/WorkflowTimelineTracks.tsx:93	872ad960	out-of-pool
  packages/ui/src/components/workflow-timeline/WorkflowTimelineTracks.tsx:243	872ad960	out-of-pool
```

- 6 文件 weak `109 → 7`（−102）：其中 **100 行**是登记表里的 1→1 改写，另 **2 行**是池外桶自清
  （`WorkflowTimelineTracks.tsx:93` / `243`，均为 JSDoc 收尾行，非本批改写，**不进配额扣减**）。
- 因此全仓 weak 减 102，而 `done` 只加 100；两者差额 2 就是上面这两行，记账口径不混。
- 本批没有多改、没有漏改：`numstat +100/−100`、`record n=100`、`plan=100` 三方互证。

## 3. 计时：两段墙钟 + 三量并列（新口径，n=2）

### 3.1 四量与顺序断言

```text
t-start    2026-11-11 03:17:53.153 +08:00
t-record   2026-11-11 03:19:40.013 +08:00  sha=a1f87a7bc76b  record_runs=2
t-verify   2026-11-11 03:19:44.388 +08:00  sha=a1f87a7bc76b  record_runs=2
commit     2026-11-11 03:21:23 +08:00  db65b565

batch_wall_total         = 662.0 s（bc6ac312 → db65b565，git 两端，上一批台账 → 本批代码）
batch_wall_controllable  = 210.0 s（t-start → commit）
落笔段                   = 111.2 s（t-start → t-verify）
tail                     =   4.4 s（t-record → t-verify）
record_runs = 2   out_of_scope_edits(断言时) = 0
```

`--order --commit db65b565 --prev bc6ac312` 输出 `PRECHECK ORDER OK`；
顺序断言 `t-start < t-record ≤ t-verify < commit_time` 全部成立（提交时间按秒比较）。

### 3.2 两段墙钟怎么读（**别拿 total 除以行数**）

- `batch_wall_total=662 s` 的窗口里含 **尺子升级提交 `068ea17a`**（集合断言 + 两段拆分 + b273 补记），
  还有本批的规划与选行；它衡量「上一批提交 → 本批提交」的端到端节奏，**不是**改写成本。
- `batch_wall_controllable=210.0 s` 才是本批自己可控的一段：`落笔段 111.2 s`（改写 + 两轮预检）
  + 门禁与提交 `98.8 s`。
- 两段差 `452 s` = 尺子升级 + 规划 + 选行 + 纯等待，全部落在 `total` 里、全部不进 `controllable`。
- `tail=4.4 s` 只覆盖最后一次 `--record → --verify`，本批有一次预检返修，返修成本体现在 `record_runs=2`，
  不体现在 `tail`。

### 3.3 新口径样本

- 新口径样本：**n=2**（b273、b274）。
  `batch_wall_controllable/100`：`1.95` → `2.10`；
  `落笔段/100`：`1.51` → `1.11`；
  `tail`：`4.2 s` → `4.4 s`。
- 两批都在旧口径 `1.01–1.62 s/行` 的落笔段区间内；**旧口径整列仍不参与**新中位数（b273 §3.3）。
- 到 n=5 时按同段分开给：①`controllable/100` 中位数（`total` 只报端到端节奏）②`落笔段` 与 `tail` 中位数
  ③`record_runs` 分布与 `out_of_scope_edits` 分布。

## 4. 度量前后（同批 6 文件，干净 worktree）

| 文件 | weak 前→后 | comments | substance 前→后 | explain 前→后 | filler 前→后 |
| --- | ---: | ---: | ---: | ---: | ---: |
| `alert-dialog.tsx` | 19 → 0 | 42 | 57.1 → 92.9 | 61.9 → 100.0 | 45.2 → 0.0 |
| `dialog.tsx` | 19 → 0 | 46 | 60.9 → 93.5 | 76.1 → 100.0 | 41.3 → 0.0 |
| `WorkflowTimelineTracks.tsx` | 27 → 6 | 84 | 51.2 → 70.2 | 75.0 → 92.9 | 22.6 → 0.0 |
| `modelConfigSync.ts` | 19 → 0 | 48 | 56.3 → 93.8 | 81.3 → 100.0 | 39.6 → 0.0 |
| `project-sidebar/contract.ts` | 19 → 0 | 46 | 56.5 → 89.1 | 89.1 → 100.0 | 37.0 → 0.0 |
| `runtime-command-queue.ts` | 6 → 1 | 140 | 88.6 → 90.0 | 95.7 → 99.3 | 0.0 → 0.0 |
| **合计** | **109 → 7** | **406** | **67.0 → 87.0** | **83.2 → 98.3** | **全部归零** |

`WorkflowTimelineTracks.tsx` 批后仍剩 6 行、`runtime-command-queue.ts` 剩 1 行，全部是池外行（未触碰）。

全仓同域（`packages,apps,docs/knip`）：`WEAK lines=8813 files=1992` → **`8711 / 1988`**；
减少 102 行 = 100 行改写 + 2 行池外自清，减少 4 个文件 = `alert-dialog` / `dialog` / `modelConfigSync` /
`project-sidebar contract` 把 weak 清零（`runtime-command-queue` 与 `WorkflowTimelineTracks` 仍各剩池外行）。

`filler` 逐文件 `45.2 / 41.3 / 22.6 / 39.6 / 37.0 / 0.0` → 全 0；全仓口径太小，`filler` 仍显示 `1.1%`
（`weak 2.7% → 2.6%` 是这一批在全仓尺度上能看见的唯一变化）。

## 5. 集合断言（b274 首用）

```text
PRECHECK SCOPE plan=100 allow=9 diff_old=100 diff_new=100 out_of_scope_edits=0
PRECHECK RECORD n=100 hits=0 sha=a1f87a7bc76b record_runs=2 out_of_scope_edits=0
```

- `--record` 必须带 `--plan`：`git diff -U0` 的旧行号集合与新增行号集合，分别与 plan 的
  `(file, baseLine)` 双向求差；越界 / 漏改非空即 `exit 8` 并逐行打印 `文件:行 + 原文`。
- `--allow` 是唯一放行口，逐行 `file:line`；本批 9 行池外行全部显式登记，没有隐式放行。
- `--verify` 带同一对参数复算，确认改写之后集合仍一致。

### 5.1 断言前的一次越界（真实发生，已回滚）

| # | 文件:行 | 归属 | 性质 | 发现方式 |
| --- | --- | --- | --- | --- |
| 1 | `packages/ui/src/components/workflow-timeline/WorkflowTimelineTracks.tsx:318` | 本线 | plan 外多改 1 行（`// 灯仍是 DOM 元素。`） | `numstat +19/−20` |

- 该块 plan 只登记 319–322 四行，实际替换成了 318–322 五行 → 少一行、后续行号整体上移。
  `numstat` 立刻显示 `+19/−20`，按原文还原 318 后回到 `+100/−100`。
- **回滚不等于未发生**：`out_of_scope_edits = 1`（本线，已回滚），**不并入** `record_runs=2`。
- 集合断言在 `--record` 时才能看见漂移；**改写完成到 `--record` 之间的越界仍要靠 numstat 自查**——
  这条限制本批实测到了：318 行就是 numstat 先抓住的，不是断言抓的。

## 6. 七行门禁（`zc-commit.mjs` v12，`--rewrite-annot --base 068ea17a`）

```text
删本线注释    n=100  （允许，逐行登记）
删代码        n=0    （必须 0）
删上游注释    n=0    （必须 0）
新增非注释行  n=0    （必须 0）
原行搬移      n=0
标点级改写    n=0    （必须 0）
新增注释行    n=100  其中判据命中 0  其中嵌套注释 0
numstat: +100 −100
expected=6  staged=6
```

登记表：`ZC-deep-b274-rewrite.tsv`（100 行，第三列为 `base` 时的 blame sha）。

## 7. 趋势：归户错 / 文本错 / 越界

| 批 | 归户错 | 文本错 | `record_runs` | `out_of_scope_edits` | 明细 |
| --- | ---: | ---: | ---: | ---: | --- |
| b269 | 0 | 0 | 未记 | 未测（无该断言） | 门禁 0；预检拦 2 W |
| b270 | 0 | 0 | 未记 | 未测（无该断言） | 门禁 0；预检拦 11（2 L + 9 W） |
| b271 | 0 | 0 | 未记 | 未测（无该断言） | 门禁 0；预检拦 6（2 L + 4 W） |
| b272 | 0 | 0 | 3 | 未测（无该断言） | 门禁 0；预检拦 4（1 L + 3 W，跨 3 轮） |
| b273 | 0 | 0 | 1 | 4（3 本线 + 1 上游，已回滚） | 门禁 0；预检 0 |
| **b274** | **0** | **0** | **2** | **1（本线，已回滚）** | 门禁 0；预检拦 9 W；断言时越界 0 |

> 越界从 4 降到 1，且这 1 行在本批就被 numstat 抓住——断言把「可见性」从事后挪到了 `--record`，
> numstat 仍守在更前面。两列分开看：`record_runs=2` 是文本返修，`out_of_scope_edits=1` 是范围漂移。

## 8. 守卫 / 断言 / 产能 / 提交

### 8.1 `weak-guard`（15 文件 cohort，与本批 6 文件无交集）

```text
WEAK 15文件  pre=4  post=4  新增=0  max=6  key=file+正文
GUARD PASS
```

### 8.2 `ledger-assert`

```text
BATCH ZC-deep-b248..b260-rewrite.tsv（12 批）
IGNORED b261–b274（非 802 批次，各 100 行不计入）
SUM 各批 = 802  OK ；ROLL 144 / 658 / 802 均 OK ；GREP 全仓 2 = 清单内 0 + 清单外 2  OK
EXEMPT 2 ；REMAIN 0 ；CLOSE 802 = 802  OK ；FILELIST 15 文件 OK
ASSERT PASS
```

### 8.3 产能与池等式

```text
BATCHCHK b274 pre=b273-repo-post.txt weak=b274-repo-post.txt  OK
done files=144 lines=1996
REMAIN	863	5425	-	432
SELF-CLEAR n=2	可写桶 0 / 池外 2 / 上游桶 0 / 未解析 0
PARTIAL	packages/ui/src/ToolCallBlocks/renderers/cuaDetails.tsx	基线 23 → 现 1
ACCT files  done 144 + remain 863 = 1007  OK
ACCT lines  done 1996 + remain 5425 = 7421  OK
ALIGNED acct_remain=5425 pool_remain=5425 diff=0  OK
ASSERT PASS
```

落笔后池数：**863 文件 / 5,425 行**（b273 后为 869 / 5,525；本批 −6 文件、−100 行）。

- 三个批数口径照 `ZC-deep-b271.md` §8.3：`147`（排期）/ `54`（纯行上界，`5,425÷100≈54`）/
  `432`（文件装箱对照上界，不作排期）。

### 8.4 提交

| 提交 | 内容 |
| --- | --- |
| `068ea17a` | 尺子升级：集合断言（越界/漏改 `exit 8`）、`batch_wall` 拆两段、b273 补记 `out_of_scope_edits` |
| `db65b565` | 代码（注释）`+100/−100`，6 文件，`expected=6 staged=6` |
| `e2b33ee8` | 本台账：`ZC-deep-b274.md`、`ZC-deep-b274-rewrite.tsv` |

## 9. 收口三断言（指针）

仍按 `ZC-deep-b265.md` §9：`remain == 0`、`done + remain == 7,421`、`ledger-assert PASS`。
本批推进 `remain`：5,525 → **5,425**，A1 未达成。

## 10. 开工前的新鲜度门禁（未通过，需决断）

`node scripts/check-workspace-freshness.mjs`（仓库根）本批**失败**：

```text
本地 main 落后 origin/main 2 个提交（a9fe401e 等 chore: sync ZCode source）
提示：先 git merge --ff-only origin/main
```

- 实测 `origin/main` 的两个 vendor sync 提交相对本分支触及 **5,315 文件 / −613k 行**；
  本分支是注解分支（领先 origin/main 百余提交），`--ff-only` 必然失败，真合并会把本分支的注解整体冲掉。
- 本批**没有合并**，仍在本地基线 `068ea17a` 上开工；该门禁状态在此如实登记，等上游同步策略定了再处理。
- 影响面：本批只改注释、不依赖新架构；但池数与行号以本地树为准，与 `origin/main` 不同步。
