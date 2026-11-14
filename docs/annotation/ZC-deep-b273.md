# ZC-deep-b273：注释清水 100 行（6 文件）· 新计时口径首用

> 批次：b273 ｜ 提交 `f868560f` ｜ 代码 `+100/−100` ｜ 零代码行
> 尺子：`deep-quality.mjs` v2.0（`756bea66122a`）、`zc-commit.mjs` v12（`a35b42fa2e4c`）、
> `capacity-estimate.mjs`（`71c35d496da1`）、`weak-guard.mjs`（`a3600ccfacab`）、
> `ledger-assert.mjs`（`35afeb266f97`）、`precheck-assert.mjs`（`a74777c6448c`，三量首用）。
> 计时口径升级提交：`b8843802`（介于 b272 与 b273 之间，不计入任何一批的改写量）。

## 0. 交代

1. 本批 6 文件 / 100 行，全部池内可写：`writable=100 / upstream=0 / self-clearing=0 / pool-out=1 / quota=100`。
2. 6 文件：`contract.ts`(19)、`stream-animate/App.tsx`(19)、`sidePaneTabPresentation.ts`(19)、
   `useWorkspaceSessionReload.ts`(19)、`BrowserSitePermissionsPage.tsx`(19)、`outputEncoding.ts`(5)。
3. 预检**一次过**：`record n=100 hits=0 sha=4ef5e9d28646`，`record_runs=1`，无返修。
4. 七行门禁全 0，`expected=6 staged=6`，`+100/−100`。
5. 新口径三量首次落地：`--start` 起笔戳 → `--record` → `--verify` → `--order` 顺序断言全通过。

## 1. 四态摘要与三列计划表（沿用 b265 §2）

```text
PLAN#1	6 文件 / 100 行	writable=100 upstream=0 self-clearing=0 pool-out=1 pending=0
quota=100(writable 100 − self-clearing 0) 四态和=101=weak合计 101 池内weak=100/池内实测 100
```

| 文件 | 可写 | 上游 | 池外 | 小计 |
| --- | ---: | ---: | ---: | ---: |
| `packages/shared/src/web-remote-relay/contract.ts` | 19 | 0 | 0 | 19 |
| `packages/stream-animate/src/App.tsx` | 19 | 0 | 0 | 19 |
| `packages/ui/src/app-shell/sidePaneTabPresentation.ts` | 19 | 0 | 0 | 19 |
| `packages/ui/src/app-shell/useWorkspaceSessionReload.ts` | 19 | 0 | 0 | 19 |
| `packages/ui/src/browser-use/BrowserSitePermissionsPage.tsx` | 19 | 0 | 0 | 19 |
| `apps/zcode-cli/packages/adapters/src/exec/outputEncoding.ts` | 5 | 0 | 1 | 5 |
| **合计** | **100** | **0** | **1** | **100** |

- 池外 1 行：`outputEncoding.ts:318`「其次探测，最后按 locale 推断。」（upstream，未触碰，批后仍在）。

## 2. 配额扣减与批后池

```text
SELF-CLEAR n=0	可写桶 0 / 池外 0 / 上游桶 0 / 未解析 0
```

批后 6 文件 weak `101 → 1`，减少的 100 行**全部是登记表里的 1→1 改写**，没有自清、没有多改、没有漏改。
这正是 `--start` 与 `--record` 同源带来的好处：`record n=100` 与 `numstat +100` 互证。

## 3. 计时：三量并列（新口径，b273 首用）

### 3.1 三量与顺序断言

```text
t-start    2026-11-11 03:04:11.872 +08:00
t-record   2026-11-11 03:06:38.203 +08:00  sha=4ef5e9d28646  record_runs=1
t-verify   2026-11-11 03:06:42.373 +08:00  sha=4ef5e9d28646  record_runs=1
commit     2026-11-11 03:07:26 +08:00  f868560f

batch_wall_total         = 943.0 s（fd6dfa8f → f868560f，git 两端）
batch_wall_controllable  = 195.0 s（t-start → commit，新工具回放，秒粒度）
落笔段                   = 150.5 s（t-start → t-verify）
tail                     =   4.2 s（t-record → t-verify）
record_runs = 1
```

> b273 落笔时工具只有 `batch_wall` 一段；b274 起拆成 `total` / `controllable` 两段后回放本批，
> `943.0` 归入 `total`（含批间尺子升级），`195.0` 才是本批可控段。历史值不改写，只补口径。

`--order --commit f868560f --prev fd6dfa8f` 输出 `PRECHECK ORDER OK`；
顺序断言 `t-start < t-record ≤ t-verify < commit_time` 全部成立。

### 3.2 三量怎么读（本批的分解，别把 batch_wall 当纯改写）

- `batch_wall_total=943 s` 里包含**两批之间的尺子升级**（`--start/--order` 实现、旧口径降级、capacity BOM 断言，提交 `b8843802`），
  所以它衡量的是「上一批提交 → 本批提交」的端到端节奏，**不是**本批改写的工艺成本；两段之差 748 s 全是该升级。
- 本批真正可控的一段是 `batch_wall_controllable = 195.0 s`（`t-start → commit`）：`落笔段 150.5 s`（改写 + 预检）+ 门禁与提交 `44.5 s`。
- `tail=4.2 s` 只覆盖最后一次 `--record → --verify`，本批无返修，所以它约等于工具自身的复算时间。
- 三量互不依赖：若忘跑 `--start`，`tail` 与 `batch_wall_total` 仍可报；只有 `--order` 会因缺戳 `exit 7`。

### 3.3 新口径样本、旧口径降级

- 新口径样本：**n=1**（b273）。`batch_wall_controllable/100=1.95`、`落笔段/100=1.51`、`tail/100=0.04` **一律不出主档**；
  `batch_wall_total/100=9.43` 含批间非改写动作，**不参与任何 per-line 比较**。
- b261–b272 的 `s/行` 整列标「旧口径（手工打点 / 口径不一）」，不参与任何新中位数与区间；
  `1.58` 已降为旧口径历史值（见 `ZC-deep-b271.md` §3.2、`ZC-deep-b265.md` §5）。
- 到 n=5 时按同段分开给：①`batch_wall_controllable/100` 中位数（`total` 只报端到端节奏，不折算行）②`落笔段` 与 `tail` 中位数 ③`record_runs` 分布与 `out_of_scope_edits` 分布。
- 用本批反推旧口径：`落笔段/100=1.505 s/行`，落在旧值 `1.01–1.62` 区间内，量级没有跳变；但样本仍只有 1 个。

## 4. 度量前后（同批 6 文件，干净 worktree）

| 文件 | weak 前→后 | comments | substance 前→后 | explain 前→后 |
| --- | ---: | ---: | ---: | ---: |
| `contract.ts` | 19 → 0 | 52 | 71.2 → 94.2 | 92.3 → 100.0 |
| `stream-animate/App.tsx` | 19 → 0 | 41 | 56.1 → 90.2 | 75.6 → 100.0 |
| `sidePaneTabPresentation.ts` | 20 → 1 | 42 | 50.0 → 92.9 | 76.2 → 97.6 |
| `useWorkspaceSessionReload.ts` | 19 → 0 | 51 | 64.7 → 92.2 | 86.3 → 100.0 |
| `BrowserSitePermissionsPage.tsx` | 19 → 0 | 42 | 59.5 → 95.2 | 71.4 → 100.0 |
| `outputEncoding.ts` | 5 → 0 | 75 | 86.7 → 92.0 | 97.3 → 100.0 |
| **合计** | **101 → 1** | **303** | **67.3 → 92.7** | **85.1 → 99.7** |

`filler` 97 → 0（逐文件 3/19/19/18/19/19 → 全 0），与全仓 `filler 3737 → 3640`（−97）一致。

全仓同域（`packages,apps,docs/knip`）：`WEAK lines=8913 files=1997` → **`8813 / 1992`**；
减少 100 行 = 100 行改写，减少 5 个文件 = 本批把 weak 清零的
`contract` / `stream-animate App` / `sidePaneTabPresentation` / `useWorkspaceSessionReload` / `BrowserSitePermissionsPage`
（`outputEncoding` 仍剩 1 行上游 weak）。

### 4.1 BOM 断言在真实输入上生效

本批 `b273-repo-post.txt` 正是 PowerShell `>` 产出、带 UTF-8 BOM 的快照：

- `capacity-estimate` 入读剥 BOM 后，`WEAK lines=8813` 与明细 8813 行对账一致，`SELF-CLEAR n=0`；
- 若沿用 b272 的旧解析，首行会漏读，凭空多出一条自清（b272 的 `App.tsx:295` 就是这样误报的）；
- 负控：从快照删掉一条 `WEAK` 明细后重跑 → `exit 9`（表头 8813 ≠ 明细 8812），见 `_tools/INDEX.md` §2.2。

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
```

本批预检首轮即 `hits=0`，门禁首轮即全 0：`record_runs=1`，预检返修 0 轮。
登记表：`ZC-deep-b273-rewrite.tsv`（100 行）。

### 5.1 `out_of_scope_edits`（b274 起独立入账，本批补记）

```text
out_of_scope_edits = 4 行（3 本线 + 1 上游）  已回滚 = 是   计入 record_runs = 否
```

| # | 文件:行 | 归属 | 性质 |
| --- | --- | --- | --- |
| 1 | `packages/shared/src/web-remote-relay/contract.ts:140` | 本线 | plan 外多改 1 行 |
| 2 | `packages/shared/src/web-remote-relay/contract.ts:200` | 本线 | plan 外多改 1 行 |
| 3 | `packages/ui/src/app-shell/useWorkspaceSessionReload.ts:54` | 本线 | plan 外多改 1 行 |
| 4 | `apps/zcode-cli/packages/adapters/src/exec/outputEncoding.ts:318` | **上游** | 上游注释，plan 外且池外 |

- **回滚不等于未发生**：4 行在 `--record` 之前按 `numstat +104/−104` 发现并逐行还原，因此没进快照、
  没进登记表、也没进 `record_runs`——旧工具下它们**完全不可见**。这正是 b274 要单列这个指标的原因。
- `outputEncoding.ts:318` 与 b264「4 行改到上游注释」同一类事故；本次靠自查抓回，但趋势上必须看得见升降。
- b274 起由 `precheck-assert.mjs` 的集合断言在 `--record` 时硬拦：`改动行集合 == plan 行集合`，
  越界即 `exit 8` 并逐行打印 `文件:行 + 原文`，不再依赖事后 numstat 自查。
- `record_runs` 语义收窄为「预检返修轮数」，与越界**分开记**，不合并成一个「返修成本」。

## 6. `uncovered` 与本批的收口边界

1→1 改写不改 uncovered 的构造，`101 → 1` 是 weak，不是 uncovered；池内清零不等于全仓完成。

## 7. 趋势：归户错 / 文本错

| 批 | 归户错 | 文本错 | `out_of_scope_edits` | 明细 |
| --- | ---: | ---: | ---: | --- |
| b269 | 0 | 0 | 未测（无该断言） | 门禁 0；预检拦 2 W |
| b270 | 0 | 0 | 未测（无该断言） | 门禁 0；预检拦 11（2 L + 9 W） |
| b271 | 0 | 0 | 未测（无该断言） | 门禁 0；预检拦 6（2 L + 4 W） |
| b272 | 0 | 0 | 未测（无该断言） | 门禁 0；预检拦 4（1 L + 3 W，跨 3 轮） |
| **b273** | **0** | **0** | **4（3 本线 + 1 上游，已回滚）** | 门禁 0；预检 0（`record_runs=1`） |

> `out_of_scope_edits` 与 `record_runs` 是两列独立事实：b273 的 `record_runs=1`（预检零返修）与
> 越界 4 行同时成立，不能用一个数掩盖另一个。b274 起该列由工具断言强制为 0 才能 `--record` 通过。

## 8. 守卫 / 断言 / 产能 / 提交

### 8.1 `weak-guard`（15 文件 cohort，与本批 6 文件无交集）

```text
WEAK 15文件  pre=4  post=4  新增=0  max=8  key=file+正文
GUARD PASS
```

### 8.2 `ledger-assert`

```text
BATCH ZC-deep-b248..b260-rewrite.tsv（12 批）
IGNORED b261–b273（非 802 批次，各 100 行不计入）
SUM 各批 = 802  OK ；ROLL 144 / 658 / 802 均 OK ；GREP 全仓 2 = 清单内 0 + 清单外 2  OK
EXEMPT 2 ；REMAIN 0 ；CLOSE 802 = 802  OK ；FILELIST 15 文件 OK
ASSERT PASS
```

### 8.3 产能与池等式

```text
BATCHCHK b273 pre=b272-repo-post.txt weak=b273-repo-post.txt  OK
done files=138 lines=1896
REMAIN	869	5525	-	435
SELF-CLEAR n=0	可写桶 0 / 池外 0 / 上游桶 0 / 未解析 0
PARTIAL	packages/ui/src/ToolCallBlocks/renderers/cuaDetails.tsx	基线 23 → 现 1
ACCT files  done 138 + remain 869 = 1007  OK
ACCT lines  done 1896 + remain 5525 = 7421  OK
ALIGNED acct_remain=5525 pool_remain=5525 diff=0  OK
ASSERT PASS
```

落笔后池数：**869 文件 / 5,525 行**（b272 后为 875 / 5,625；本批 −6 文件、−100 行）。

- 三个批数口径照 `ZC-deep-b271.md` §8.3：`147`（排期）/ `58`（纯行上界，现为 `5,525÷100≈56`）/
  `442`（文件装箱对照上界，现为 `435`）。工具明示 `435` 不作为排期依据。

### 8.4 提交

| 提交 | 内容 |
| --- | --- |
| `b8843802` | 尺子升级：`--start` / `--order` / 三量、capacity BOM 断言、旧 `s/行` 降级 |
| `f868560f` | 代码（注释）`+100/−100`，6 文件，`expected=6 staged=6` |
| `cd630192` | 本台账：`ZC-deep-b273.md`、`ZC-deep-b273-rewrite.tsv` |

## 9. 收口三断言（指针）

仍按 `ZC-deep-b265.md` §9：`remain == 0`、`done + remain == 7,421`、`ledger-assert PASS`。
本批推进 `remain`：5,625 → **5,525**，A1 未达成。
