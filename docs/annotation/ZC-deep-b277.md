# ZC-deep-b277：注释清水 100 行（6 文件）· 新口径样本 n=5 · 主档建议

> 批次：b277 ｜ 提交 `f682e3a8` ｜ 代码 `+100/−100` ｜ 零代码行
> 尺子：`deep-quality.mjs` v2.0（`756bea66122a`）、`zc-commit.mjs` v12（`a35b42fa2e4c`）、
> `capacity-estimate.mjs`（`71c35d496da1`）、`weak-guard.mjs`（`a3600ccfacab`）、
> `ledger-assert.mjs`（`35afeb266f97`）、`precheck-assert.mjs`（`47a15788e58a`，`--scope` 第三次跑）。

## 0. 交代

1. 本批 6 文件 / 100 行，全部池内可写：`writable=100 / upstream=0 / self-clearing=0 / pool-out=2 / quota=100`。
2. 6 文件：`BackgroundBashOutputSidePane.tsx`(18)、`TweakPanel.tsx`(18)、`useGitAutoRefresh.ts`(18)、
   `useSystemService.ts`(19，含 1 行上游池外)、`useWorkspaceServices.tsx`(18)、
   `process-provider-registry-runtime.ts`(11，含 1 行本线池外)。
3. 流程：`--start` → 改写 → `--scope`（只报不拦，首轮 `越界 2 / 漏改 0`）→ 回退 2 行 → `--record` → `--verify` → 七行门禁。
4. 预检首轮 4 条命中（2 W + 1 L + 1 W），返修后 `hits=0`，`record_runs=2`。
5. 七行门禁全 0，`expected=6 staged=6`，`+100/−100`。
6. 本批有 1 行连带自清（池外，不扣配额）：`process-provider-registry-runtime.ts:258` 改写邻行后不再构成 POEM 连句；
   池外上游行 `useSystemService.ts:176` 原样保留，批后 weak 残留 1。

## 1. 四态摘要与三列计划表（沿用 b265 §2）

```text
PLAN#1	6 文件 / 100 行	writable=100 upstream=0 self-clearing=0 pool-out=2 pending=0
quota=100(writable 100 − self-clearing 0) 四态和=102=weak合计 池内weak=100/池内实测 100
```

| 文件 | 可写 | 上游 | 池外 | 小计 |
| --- | ---: | ---: | ---: | ---: |
| `packages/ui/src/app-shell/BackgroundBashOutputSidePane.tsx` | 18 | 0 | 0 | 18 |
| `packages/ui/src/gen-ui/components/TweakPanel.tsx` | 18 | 0 | 0 | 18 |
| `packages/ui/src/hooks/useGitAutoRefresh.ts` | 18 | 0 | 0 | 18 |
| `packages/ui/src/hooks/useSystemService.ts` | 18 | 0 | 1 | 19 |
| `packages/ui/src/hooks/useWorkspaceServices.tsx` | 18 | 0 | 0 | 18 |
| `apps/zcode-cli/packages/bootstrap/src/app/process-provider-registry-runtime.ts` | 10 | 0 | 1 | 11 |
| **合计** | **100** | **0** | **2** | **102** |

- 池外 2 行：`useSystemService.ts:176`（上游，批后仍在，就是残留的那 1 行 weak）与
  `process-provider-registry-runtime.ts:258`（本线，批后连带自清）。

## 2. 配额扣减与批后池

```text
SELF-CLEAR n=4	可写桶 0 / 池外 4 / 上游桶 0 / 未解析 0	（只有可写桶进配额扣减）
```

批后 6 文件 weak `102 → 1`，减少的 101 行 = 100 行登记改写 + 1 行池外连带自清；可写桶自清 0，不扣配额。

## 3. 计时：三量（新口径样本 n=5）

```text
t-start    2026-11-11 03:46:45.259 +08:00
t-record   2026-11-11 03:48:41.529 +08:00  sha=51d190835012  record_runs=2
t-verify   2026-11-11 03:49:33.864 +08:00  sha=51d190835012  record_runs=2
commit     2026-11-11 03:50:14 +08:00  f682e3a8

batch_wall_total         = 412.0 s（49311a0a → f682e3a8，git 两端）
batch_wall_controllable  = 209.0 s（t-start → commit）
落笔段                   = 168.6 s（t-start → t-verify）
tail                     =  52.3 s（t-record → t-verify）
record_runs = 2
```

- `412.0 s` 与 `209.0 s` 之差 203 s 是门禁、提交与批间动作，不改写行。
- `--order --commit f682e3a8 --prev 49311a0a` 输出 `PRECHECK ORDER OK`。
- **流程返工（记录在案）**：首次提交 `37e972be` 在 `--verify` 之前产生，违反 `t-verify < commit_time`；
  已 `git reset --soft` 撤回该本地未推送提交，按 `record → verify → commit` 重做，最终提交 `f682e3a8`。
  撤回只动本地 HEAD，6 文件内容与暂存区未变。
- `tail=52.3 s` 偏高，原因是 verify 前多了一次软重置与重暂存，非改写本身耗时。

## 3.1 主档建议（n=5，按 b269 约定）

```text
样本（落笔段 s/行）  b273 1.51 / b274 1.11 / b275 1.72 / b276 1.06 / b277 1.69
中位数               1.51 s/行
极差                 1.72 − 1.06 = 0.66 s/行（中位数的 43.7%）
record_runs 分布     1 → 1 批（b273）；2 → 4 批（b274/b275/b276/b277）；3+ → 0 批
out_of_scope_edits   合计 7 = write_phase 7 + record_phase 0（五批 `--record` 全 0）；
                     rolled_back=yes（7 行全部回滚）；includes_upstream=yes（b273 含 1 行上游）
结论                 **不切换主档**：极差 43.7% > 30% 阈值，按约定再等两批（b278/b279）
```

- 旧主档 `1.58` 已在 INDEX 降级为历史值；本批不把它换成 1.51，也不宣布新主档。
- 差异来源已定位：样本 1.06 是零返修批，1.69 是本批（含 `--scope` 2 行越界回退 + 预检 4 条返修），
  1.72 是 b275（含池外自清排查）。返修次数与 `record_runs` 正相关，但与 `s/行` 只部分相关，
  所以不能用 `record_runs` 直接折算工时。
- b278 后 n=6、b279 后 n=7，再按同一张表复算；若极差仍在 30% 以上，继续攒，不硬定。

## 4. 度量前后（同批 6 文件，干净 worktree）

| 文件 | weak 前→后 | comments | substance 前→后 | explain 前→后 | filler 前→后 |
| --- | ---: | ---: | ---: | ---: | ---: |
| `process-provider-registry-runtime.ts` | 11 → 0 | 69 | 72.5 → 82.6 | 94.2 → 100.0 | 14.5 → 0.0 |
| `BackgroundBashOutputSidePane.tsx` | 18 → 0 | 41 | 68.3 → 97.6 | 78.0 → 100.0 | 43.9 → 0.0 |
| `TweakPanel.tsx` | 18 → 0 | 39 | 59.0 → 97.4 | 71.8 → 100.0 | 43.6 → 0.0 |
| `useGitAutoRefresh.ts` | 18 → 0 | 49 | 71.4 → 98.0 | 81.6 → 100.0 | 36.7 → 0.0 |
| `useSystemService.ts` | 19 → 1 | 56 | 58.9 → 89.3 | 82.1 → 98.2 | 32.1 → 0.0 |
| `useWorkspaceServices.tsx` | 18 → 0 | 61 | 73.8 → 96.7 | 88.5 → 100.0 | 29.5 → 0.0 |
| **合计** | **102 → 1** | **315** | **67.9 → 92.7** | **84.1 → 99.7** | **31.4 → 0.0** |

全仓同域（`packages,apps,docs/knip`）：`WEAK lines=8601 files=1987` → **`8500 / 1982`**。
减少 101 行 = 100 行改写 + 1 行池外自清；减少 5 个文件 = 5 个文件清零（`useSystemService.ts` 仍剩 1 行上游 weak）。

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

登记表：`ZC-deep-b277-rewrite.tsv`（100 行，全部 blame `a8784b7e479d3a`）。

### 5.1 预检：集合断言先报后拦，判据命中 4 条

```text
--scope   PRECHECK SCOPE plan=100 allow=2 diff_old=102 diff_new=102 out_of_scope_edits=2
          PRECHECK SCOPE PASS 越界 2 / 漏改 0（只报不拦）
--record  HIT BackgroundBashOutputSidePane.tsx:34 L 无信息列举
          HIT BackgroundBashOutputSidePane.tsx:129 W 单行无信息
          HIT TweakPanel.tsx:54 L 无信息列举
          HIT useGitAutoRefresh.ts:109 W 单行无信息
          PRECHECK RECORD FAIL n=100 hits=4 record_runs=1
```

- 2 行越界：`useWorkspaceServices.tsx:198/199` 本就不弱，改写后已原样回退；`--scope` 只报不拦，
  没有进 `--record`，因此记为 `out_of_scope_write_phase=2`、`out_of_scope_record_phase=0`。
  **回滚不等于未发生**：这 2 行计入本批 `out_of_scope_edits` 总数，不并进 `record_runs`。
- 2 条 L 都是「两个中文停顿 + 无谓词」（`，…，…` 与 `、…，…`），各删一个停顿后过。
- 2 条 W 是整句中文但没有 ASCII 标识符可挂，补 `useBackgroundBashOutput` / `clientHeight` /
  `watchPathSignature` 后过。
- 二轮 `record n=100 hits=0 sha=51d190835012 record_runs=2`，`--verify` 逐字节通过（`tail=52.3 s`）。

```text
out_of_scope_edits = write_phase 2 + record_phase 0 = 2   rolled_back=yes  includes_upstream=no
不计入 record_runs（record_runs=2 只表示预检返修轮数）
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
IGNORED b261–b277（非 802 批次，各 100 行不计入）
SUM 各批 = 802  OK ；ROLL 144 / 658 / 802 均 OK ；GREP 全仓 2 = 清单内 0 + 清单外 2  OK
EXEMPT 2 ；REMAIN 0 ；CLOSE 802 = 802  OK ；FILELIST 15 文件 OK
ASSERT PASS
```

### 6.3 产能与池等式

```text
BATCHCHK b277 pre=b276-repo-post.txt weak=b277-repo-post.txt  OK
done files=162 lines=2296
REMAIN	845	5125	-	423
SELF-CLEAR n=4	可写桶 0 / 池外 4 / 上游桶 0 / 未解析 0
ACCT files  done 162 + remain 845 = 1007  OK
ACCT lines  done 2296 + remain 5125 = 7421  OK
ALIGNED acct_remain=5125 pool_remain=5125 diff=0  OK
ASSERT PASS
```

落笔后池数：**845 文件 / 5,125 行**（b276 后为 851 / 5,225；本批 −6 文件、−100 行）。

- `done=2296（批前 2196 → 批后 2296）`；`remain=5125（批前 5225 → 批后 5125）`；`ALIGNED OK`。
- 三个批数口径照 `ZC-deep-b271.md` §8.3：`141`（排期）/ `51`（纯行上界，`5,125÷100`）/
  `423`（文件装箱对照，不作排期）。

### 6.4 提交

| 提交 | 内容 |
| --- | --- |
| `f682e3a8` | 代码（注释）`+100/−100`，6 文件，`expected=6 staged=6` |
| 本台账 | `ZC-deep-b277.md`、`ZC-deep-b277-rewrite.tsv` |

**顺序纪律补强（b278 起，`zc-commit` v13 / blob `f02be471a849`）**：本批「先 commit 后 verify」不能再发生。
`--rewrite-annot --yes` 现在必须先通过前置拦截：缺 `--snapshot`、缺 `t-verify`、`t-verify ≤ t-record`、
`t-verify` 不在过去、快照文件集 ≠ 本批清单，任一不满足即 `exit 9` 且**不 `git add`**。

```text
负控 1 只有 t-record 没有 t-verify      → exit 9  ORDER GATE FAIL 缺 …-t-verify.txt（未跑 --verify）
负控 2 t-verify 早于 t-record           → exit 9  ORDER GATE FAIL t-verify(…) 不晚于 t-record(…)
两次负控后 HEAD 均未移动，git diff --cached 为 0 行；正控见 b278 的 ORDER GATE PASS
```

## 7. 趋势：归户错 / 文本错 / 越界

> 表头口径：**回滚不等于未发生；统计目的是看越界在增加还是减少。**
> `out_of_scope_edits = out_of_scope_write_phase + out_of_scope_record_phase`，两列都计入总数，
> 不设「另有 N 行不计入」这种类别。每批另标 `rolled_back` 与 `includes_upstream`。

| 批 | 归户错 | 文本错 | write_phase | record_phase | 合计 | rolled_back | includes_upstream | `record_runs` | 明细 |
| --- | ---: | ---: | ---: | ---: | ---: | --- | --- | ---: | --- |
| b273 | 0 | 0 | 4 | 0 | **4** | yes | yes | 1 | 3 本线 + 1 上游，`--record` 前手工回滚 |
| b274 | 0 | 0 | 1 | 0 | **1** | yes | no | 2 | 本线 1 行，`numstat +19/−20` 反推后回滚；b276 表曾记 0，本表按发生即计恢复 |
| b275 | 0 | 0 | 0 | 0 | **0** | no | no | 2 | `--scope` 首用，1 W + 2 L |
| b276 | 0 | 0 | 0 | 0 | **0** | no | no | 2 | 4 W + 1 L |
| **b277** | **0** | **0** | **2** | **0** | **2** | **yes** | **no** | **2** | `useWorkspaceServices.tsx:198/199` 本就不弱，`--scope` 抓到后原样回退 |

五批合计：`write_phase 7 + record_phase 0 = 7`。b273 的 4 行含 1 行上游（`includes_upstream=yes`），其余全部本线。
越界未随批次推进收敛到 0，但都停在写前阶段、都被回滚，没有一行进过 `--record` / 门禁。

## 8. 收口三断言（指针）

仍按 `ZC-deep-b265.md` §9：`remain == 0`、`done + remain == 7,421`、`ledger-assert PASS`。
本批推进 `remain`：5,225 → **5,125**，A1 未达成。
