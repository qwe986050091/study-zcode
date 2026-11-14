# ZC-deep-b275：注释清水 100 行（6 文件）· `--scope` 首用

> 批次：b275 ｜ 提交 `a417facb` ｜ 代码 `+100/−100` ｜ 零代码行
> 尺子：`deep-quality.mjs` v2.0（`756bea66122a`）、`zc-commit.mjs` v12（`a35b42fa2e4c`）、
> `capacity-estimate.mjs`（`71c35d496da1`）、`weak-guard.mjs`（`a3600ccfacab`）、
> `ledger-assert.mjs`（`35afeb266f97`）、`precheck-assert.mjs`（`47a15788e58a`，`--scope` 首用）。
> 批前工具升级提交：`f43c07b2`（新鲜度三态、`--scope`、分叉快照，不计入任何一批改写量）。

## 0. 交代

1. 本批 6 文件 / 100 行，全部池内可写：`writable=100 / upstream=0 / self-clearing=0 / pool-out=1 / quota=100`。
2. 6 文件：`group-item.tsx`(19)、`HomeOnlyWorkspaceRows.tsx`(19)、
   `useEnterpriseCodingPlanProducts.ts`(19)、`SubagentsSection.tsx`(19)、
   `offpeak-create.tsx`(19)、`managed-late-checks.ts`(5)。
3. 新流程首用：改写完成 → `--scope`（只报不拦）→ `--record` → `--verify`。
   `--scope` 首轮即 `out_of_scope_edits=0 / 漏改 0`，b274 那种「靠 `numstat` 反推越界」的窗口已封。
4. 预检首轮 3 条命中（1 W + 2 L），返修后 `hits=0`，`record_runs=2`。
5. 七行门禁全 0，`expected=6 staged=6`，`+100/−100`。
6. 顺序断言与三量全通过。

## 1. 四态摘要与三列计划表（沿用 b265 §2）

```text
PLAN#1	6 文件 / 100 行	writable=100 upstream=0 self-clearing=0 pool-out=1 pending=0
quota=100(writable 100 − self-clearing 0) 四态和=101=weak合计 池内weak=100/池内实测 101
```

| 文件 | 可写 | 上游 | 池外 | 小计 |
| --- | ---: | ---: | ---: | ---: |
| `packages/ui/src/project-sidebar/grouped/group-item.tsx` | 19 | 0 | 0 | 19 |
| `packages/ui/src/project-sidebar/HomeOnlyWorkspaceRows.tsx` | 19 | 0 | 0 | 19 |
| `packages/ui/src/settings/model-provider-section/useEnterpriseCodingPlanProducts.ts` | 19 | 0 | 1 | 20 |
| `packages/ui/src/settings/SubagentsSection.tsx` | 19 | 0 | 0 | 19 |
| `packages/ui/src/ToolCallBlocks/renderers/offpeak-create.tsx` | 19 | 0 | 0 | 19 |
| `packages/desktop/scripts/mcp-apps-host-fixture/managed-late-checks.ts` | 5 | 0 | 0 | 5 |
| **合计** | **100** | **0** | **1** | **101** |

- 池外 1 行：`useEnterpriseCodingPlanProducts.ts:119`（`*/`，blame `872ad960`，不在池内、未在 plan 中、写进 `--allow`）。

## 2. 配额扣减与批后池

```text
SELF-CLEAR n=1	可写桶 0 / 池外 1 / 上游桶 0 / 未解析 0	（只有可写桶进配额扣减）
  packages/ui/src/settings/model-provider-section/useEnterpriseCodingPlanProducts.ts:119	872ad960	out-of-pool
```

- 本批实测 6 文件 weak `101 → 0`，改写 100 行，另 1 行（`*/`）是**连带自清**：
  它与紧随其后的 4 行单行注释被判成一个注释单元，后者改好后整单元不再命中，`*/` 自身没有改动。
- 该行 blame 为 `872ad960`（不在本线白名单）、且在池外，因此**不进配额扣减**，`quota` 仍为 100。
  这是「自清」第一次以 `out-of-pool` 身份出现，与 b273 的 `SELF-CLEAR n=0` 不矛盾：判据只看 blame 归属与池内位置。

## 3. 计时：三量（新口径样本 n=3）

```text
t-start    2026-11-11 03:30:00.378 +08:00
t-record   2026-11-11 03:32:48.840 +08:00  sha=a28127a9c399  record_runs=2
t-verify   2026-11-11 03:32:52.396 +08:00  sha=a28127a9c399  record_runs=2
commit     2026-11-11 03:33:22 +08:00  a417facb

batch_wall_total         = 546.0 s（df539966 → a417facb，git 两端）
batch_wall_controllable  = 202.0 s（t-start → commit）
落笔段                   = 172.0 s（t-start → t-verify）
tail                     =   3.6 s（t-record → t-verify）
record_runs = 2
```

- `546.0 s` 含批间工具升级（`f43c07b2`：三态新鲜度、`--scope`、分叉快照），不折算成每行成本。
- `controllable=202.0 s` 里 `172.0 s` 是改写 + 预检 + 一次返修，`30.0 s` 是门禁与提交。
- `--order --commit a417facb --prev df539966` 输出 `PRECHECK ORDER OK`。
- 新口径样本累计 **n=3**（b273 / b274 / b275）。`controllable/100`：1.95 / 2.10 / 2.02。

## 4. 度量前后（同批 6 文件，干净 worktree）

| 文件 | weak 前→后 | comments | substance 前→后 | explain 前→后 | filler 前→后 |
| --- | ---: | ---: | ---: | ---: | ---: |
| `managed-late-checks.ts` | 5 → 0 | 30 | 76.7 → 90.0 | 83.3 → 100.0 | 0.0 → 0.0 |
| `offpeak-create.tsx` | 19 → 0 | 46 | 47.8 → 87.0 | 82.6 → 100.0 | 41.3 → 0.0 |
| `HomeOnlyWorkspaceRows.tsx` | 19 → 0 | 43 | 55.8 → 93.0 | 74.4 → 100.0 | 44.2 → 0.0 |
| `group-item.tsx` | 19 → 0 | 235 | 82.1 → 88.1 | 92.8 → 100.0 | 1.3 → 0.0 |
| `SubagentsSection.tsx` | 19 → 0 | 567 | 89.6 → 91.9 | 96.8 → 100.0 | 0.0 → 0.0 |
| `useEnterpriseCodingPlanProducts.ts` | 20 → 0 | 74 | 74.3 → 91.9 | 85.1 → 100.0 | 25.7 → 0.0 |
| **合计** | **101 → 0** | **995** | **82.9 → 90.8** | **93.0 → 100.0** | **6.0 → 0.0** |

全仓同域（`packages,apps,docs/knip`）：`WEAK lines=8711 files=1988` → **`8610 / 1982`**。
减少 101 行（100 行改写 + 1 行 out-of-pool 连带自清），减少 6 个文件 = 本批 6 文件全部 weak 清零。

## 5. 七行门禁（`zc-commit.mjs` v12，`--rewrite-annot --base HEAD`）

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
GATE self=d:\code\_annot_baseline\zc-commit.mjs blob=a35b42fa2e4c
```

登记表：`ZC-deep-b275-rewrite.tsv`（100 行，全部 blame `a8784b7e479d3a`）。

### 5.1 预检：`--scope` 与 `--record` 首轮差异

```text
--scope   PRECHECK SCOPE plan=100 allow=1 diff_old=100 diff_new=100 out_of_scope_edits=0
          PRECHECK SCOPE PASS 越界 0 / 漏改 0（只报不拦，--record 时仍拦）
--record  HIT offpeak-create.tsx:149 W 单行无信息
          HIT HomeOnlyWorkspaceRows.tsx:101 L 无信息列举
          HIT SubagentsSection.tsx:489 L 无信息列举
          PRECHECK RECORD FAIL n=100 hits=3 record_runs=1
```

- **集合断言首轮就过，判据命中 3 条**：两类事分得很干净——「改到哪些行」由 `--scope` 管，
  「写成什么样」由 `--record` 管；b274 的 318 行若走这条路径，会在 `--scope` 阶段就报 `out_of_scope_edits=1`。
- 返修：`149` 补 `queuePosition`/`statusText`；`101` 把「、」列举改为「或」；`489` 把两个逗号句改成一个。
- 二轮 `record n=100 hits=0 sha=a28127a9c399 record_runs=2`，`--verify` 逐字节比对通过（`tail=3.6 s`）。

```text
out_of_scope_edits = 0   scope=0 / record=0   计入 record_runs = 否
```

## 6. 守卫 / 断言 / 产能 / 提交

### 6.1 `weak-guard`（15 文件 cohort，与本批 6 文件无交集）

```text
WEAK 15文件  pre=4  post=4  新增=0  max=8  key=file+正文
GUARD PASS
```

### 6.2 `ledger-assert`

```text
BATCH ZC-deep-b248..b260-rewrite.tsv（12 批）
IGNORED b261–b275（非 802 批次，各 100 行不计入）
SUM 各批 = 802  OK ；ROLL 144 / 658 / 802 均 OK ；GREP 全仓 2 = 清单内 0 + 清单外 2  OK
EXEMPT 2 ；REMAIN 0 ；CLOSE 802 = 802  OK ；FILELIST 15 文件 OK
ASSERT PASS
```

### 6.3 产能与池等式

```text
BATCHCHK b275 pre=b274-repo-post.txt weak=b275-repo-post.txt  OK
done files=150 lines=2096
REMAIN	857	5325	-	429
SELF-CLEAR n=1	可写桶 0 / 池外 1 / 上游桶 0 / 未解析 0
PARTIAL	packages/ui/src/ToolCallBlocks/renderers/cuaDetails.tsx	基线 23 → 现 1
ACCT files  done 150 + remain 857 = 1007  OK
ACCT lines  done 2096 + remain 5325 = 7421  OK
ALIGNED acct_remain=5325 pool_remain=5325 diff=0  OK
ASSERT PASS
```

落笔后池数：**857 文件 / 5,325 行**（b274 后为 863 / 5,425；本批 −6 文件、−100 行）。

- 三个批数口径照 `ZC-deep-b271.md` §8.3：`147`（排期）/ `54`（纯行上界，现为 `5,325÷100≈53`）/
  `429`（文件装箱对照，不作排期）。

### 6.4 提交

| 提交 | 内容 |
| --- | --- |
| `f43c07b2` | 尺子升级：新鲜度三态、`precheck --scope`、`vendor-sync-divergence.md`、INDEX §11 禁合并约定 |
| `a417facb` | 代码（注释）`+100/−100`，6 文件，`expected=6 staged=6` |
| 本台账 | `ZC-deep-b275.md`、`ZC-deep-b275-rewrite.tsv` |

## 7. 趋势：归户错 / 文本错 / 越界

| 批 | 归户错 | 文本错 | `out_of_scope_edits` | `record_runs` | 明细 |
| --- | ---: | ---: | ---: | ---: | --- |
| b272 | 0 | 0 | 未测（无该断言） | 3 | 预检拦 4（1 L + 3 W） |
| b273 | 0 | 0 | 4（3 本线 + 1 上游，已回滚） | 1 | 门禁 0；预检 0 |
| b274 | 0 | 0 | 0（首用集合断言，事后发现 1 行已回滚） | 2 | `--scope` 尚未存在 |
| **b275** | **0** | **0** | **0（scope 0 / record 0）** | **2** | 集合断言 + `--scope` 双跑 |

## 8. 收口三断言（指针）

仍按 `ZC-deep-b265.md` §9：`remain == 0`、`done + remain == 7,421`、`ledger-assert PASS`。
本批推进 `remain`：5,425 → **5,325**，A1 未达成。
