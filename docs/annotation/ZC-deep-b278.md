# ZC-deep-b278：注释清水 100 行（6 文件）· 新口径样本 n=6 · 主档仍不切换

> 批次：b278 ｜ 提交 `fd7c023c` ｜ 代码 `+100/−100` ｜ 零代码行
> 尺子：`deep-quality.mjs` v2.0（`756bea66122a`）、`zc-commit.mjs` v13（`f02be471a849`）、
> `capacity-estimate.mjs`（`71c35d496da1`）、`weak-guard.mjs`（`a3600ccfacab`）、
> `ledger-assert.mjs`（`35afeb266f97`）、`precheck-assert.mjs`（`47a15788e58a`）。

## 0. 交代

1. 本批 6 文件 / 100 行，全部池内可写：`writable=100 / upstream=0 / self-clearing=0 / pool-out=2 / quota=100`。
2. 6 文件：`composerRecent.ts`(18)、`RemoteConnectionProgress.tsx`(18)、
   `AutomationDesignPrimitives.tsx`(18)、`AppUsageModelUsagePieChart.tsx`(18)、
   `plan-guidance.tsx`(18)、`session-mapper.ts`(10)。
3. 流程：`--start` → 改写 → `--scope`（`越界 0 / 漏改 0`）→ `--record`（首轮 3 W，返修）→
   `--record`（hits=0）→ `--verify` → `zc-commit v13`（`ORDER GATE PASS`）→ `--order`。
4. 预检首轮 3 条命中全是 W：`AutomationDesignPrimitives.tsx:70/72/118` 缺 3 字符以上 ASCII 标识符。
   补上 `AutomationHistoryEmptyState` / `className` 后 `hits=0`，`record_runs=2`。
5. 七行门禁全 0，`expected=6 staged=6`，`+100/−100`。
6. 本批无自清：池外 2 行（`composerRecent.ts:81`、`AutomationDesignPrimitives.tsx:67`，均上游）原样保留，
   批后这 2 个文件各残留 1 行 weak。
7. **前置拦截首次实跑**：`--rewrite-annot` 在 `git add` 之前校验 `--snapshot`、`t-record/t-verify` 与文件集，
   打印 `ORDER GATE PASS record=… verify=… files=6` 后才暂存；b277 的「先 commit 后 verify」在本批已做不出来。
   负控两例见 `ZC-deep-b277.md` §6.4（均为 `exit 9` 且 HEAD 未移动）。

## 1. 四态摘要与三列计划表（沿用 b265 §2）

```text
PLAN#1	6 文件 / 100 行	writable=100 upstream=0 self-clearing=0 pool-out=2 pending=0
quota=100(writable 100 − self-clearing 0) 四态和=102=weak合计 池内weak=100/池内实测 100
```

| 文件 | 可写 | 上游 | 池外 | 小计 |
| --- | ---: | ---: | ---: | ---: |
| `packages/ui/src/lib/composerRecent.ts` | 18 | 0 | 1 | 19 |
| `packages/ui/src/remote-connection-flow/ui/RemoteConnectionProgress.tsx` | 18 | 0 | 0 | 18 |
| `packages/ui/src/settings/AutomationDesignPrimitives.tsx` | 18 | 0 | 1 | 19 |
| `packages/ui/src/settings/usage-stats/AppUsageModelUsagePieChart.tsx` | 18 | 0 | 0 | 18 |
| `packages/ui/src/ToolCallBlocks/renderers/plan-guidance.tsx` | 18 | 0 | 0 | 18 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/session-mapper.ts` | 10 | 0 | 0 | 10 |
| **合计** | **100** | **0** | **2** | **102** |

- 池外 2 行：`composerRecent.ts:81`（`acceptComposerRecentSubmission` 的 catch 注释）与
  `AutomationDesignPrimitives.tsx:67`（运行历史空态的 JSDoc），都是上游注释，批后仍在。

## 2. 配额扣减与批后池

```text
SELF-CLEAR n=0	可写桶 0 / 池外 0 / 上游桶 0 / 未解析 0	（只有可写桶进配额扣减）
```

批后 6 文件 weak `102 → 2`，减少的 100 行全部是登记改写；可写桶自清 0，不扣配额。
6 个文件里 4 个清零，`composerRecent.ts` 与 `AutomationDesignPrimitives.tsx` 各剩 1 行上游 weak。

## 3. 计时：三量（新口径样本 n=6）

```text
t-start    2026-11-11 03:58:52.690 +08:00
t-record   2026-11-11 04:02:06.315 +08:00  sha=3ef7b939fccf  record_runs=2
t-verify   2026-11-11 04:02:10.292 +08:00  sha=3ef7b939fccf  record_runs=2
commit     2026-11-11 04:02:43 +08:00  fd7c023c

batch_wall_total         = 277.0 s（d06f97bc → fd7c023c，git 两端）
batch_wall_controllable  = 230.3 s（t-start → commit）
落笔段                   = 197.6 s（t-start → t-verify）
tail                     =   4.0 s（t-record → t-verify）
record_runs = 2
s/行                     = 1.98（197.6 ÷ 100）
```

- `277.0 s` 与 `230.3 s` 之差 46.7 s 是门禁、提交与批间动作，不改写行。
- `tail=4.0 s` 是本批最干净的一次：`--record` 第二轮一次通过，`--verify` 紧随其后。
- `--order --commit fd7c023c --prev d06f97bc` 输出 `PRECHECK ORDER OK`。

## 3.1 主档建议（n=6，按 b269 约定）

```text
样本（落笔段 s/行）  b273 1.51 / b274 1.11 / b275 1.72 / b276 1.06 / b277 1.69 / b278 1.98
中位数               1.60 s/行
极差                 1.98 − 1.06 = 0.92 s/行（中位数的 57.5%）
record_runs 分布     1 → 1 批（b273）；2 → 5 批（b274–b278）；3+ → 0 批
out_of_scope_edits   本批 0 = write_phase 0 + record_phase 0；rolled_back=no；includes_upstream=no
结论                 **仍不切换主档**：极差 57.5% > 30% 阈值，按约定等 b279 的 n=7
```

- 分组预览（b279 正式给）：`record_runs ≤1` 组只有 b273 `1.51`（n=1）；`record_runs ≥2` 组
  `1.06 / 1.11 / 1.69 / 1.72 / 1.98`，中位数 `1.69`（n=5）。
  两组当前相差 12%，但 A 组 n=1，**本批不据此给任何工艺结论**，只登记分组口径。
- 本批 `1.98` 是六批最高值，与 3 条 W 返修、6 文件里有一个 907 行的协议文件（`session-mapper.ts`）有关；
  但它仍是单批样本，不构成上调主档的理由。
- b279 落笔后 n=7：同时给总体中位数与按 `record_runs` 分组的中位数，两组各标 n。

## 4. 度量前后（同批 6 文件，批前快照 `b278-repo-pre.txt` / 批后 `b278-repo-post.txt`）

| 文件 | weak 前→后 | comments | substance 前→后 | explain 前→后 | filler 前→后 |
| --- | ---: | ---: | ---: | ---: | ---: |
| `composerRecent.ts` | 19 → 1 | 66 | 68.2 → 87.9 | 80.3 → 98.5 | 25.8 → 0.0 |
| `RemoteConnectionProgress.tsx` | 18 → 0 | 41 | 73.2 → 95.1 | 75.6 → 100.0 | 43.9 → 0.0 |
| `AutomationDesignPrimitives.tsx` | 19 → 1 | 46 | 71.7 → 93.5 | 76.1 → 97.8 | 39.1 → 0.0 |
| `AppUsageModelUsagePieChart.tsx` | 18 → 0 | 41 | 58.5 → 92.7 | 80.5 → 100.0 | 43.9 → 0.0 |
| `plan-guidance.tsx` | 18 → 0 | 41 | 75.6 → 95.1 | 78.0 → 100.0 | 43.9 → 0.0 |
| `session-mapper.ts` | 10 → 0 | 414 | 93.2 → 94.7 | 97.6 → 100.0 | 0.0 → 0.0 |
| **合计** | **102 → 2** | **649** | **84.8 → 93.9** | **90.9 → 99.7** | **13.2 → 0.0** |

全仓同域（`packages,apps,docs/knip`）：`WEAK lines=8500 files=1982` → **`8400 / 1978`**。
减少 100 行 = 100 行改写；减少 4 个文件 = 4 个文件清零（另 2 个文件各剩 1 行上游 weak）。

## 5. 七行门禁（`zc-commit.mjs` v13，`--rewrite-annot --base HEAD`）

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
ORDER GATE PASS record=2026-11-11T04:02:06.315Z verify=2026-11-11T04:02:10.292Z files=6
GATE self=d:\code\_annot_baseline\zc-commit.mjs blob=f02be471a849
```

登记表：`ZC-deep-b278-rewrite.tsv`（100 行，全部 blame `a8784b7e479d3a`）。

### 5.1 预检：集合断言与越界两列

```text
--scope   SCOPED ok=0 out_of_scope=0 missing=0（只报不拦）
--record  run1  hits=3（3 W）→ 返修
--record  run2  hits=0
越界      out_of_scope_write_phase=0 / out_of_scope_record_phase=0 / 合计 0
```

- 3 条 W 都是「改写后仍无 3 字符以上 ASCII 标识符」：
  `AutomationDesignPrimitives.tsx:70`（`定时与闲时…`）、`:72`（`空态尺寸…`）、`:118`（`py-3…`）。
- 本批没有任何越界行，因此 `rolled_back=no`；`includes_upstream=no`。

## 6. 收口

### 6.1 守卫（15 文件 cohort，与本批无交集）

```text
WEAK 15文件  pre=4  post=4  新增=0  max=8  key=file+正文
GUARD PASS
```

### 6.2 产能

```text
BATCHCHK b278 pre=b277-repo-post.txt weak=b278-repo-post.txt  OK
done files=168 lines=2396（行口径：Σ 基线 weak − 现 weak）  perBatch=2
REMAIN	839	5025	-	420  （剩余；批数为对照/上界，不作为排期依据）
PLAN	140 批	口径=≤6 文件且 ≤100 行/批	均值 6.0 文件 / 35.9 行
ACCT files  done 168 + remain 839 = 1007  OK
ACCT lines  done 2396 + remain 5025 = 7421  OK
ALIGNED acct_remain=5025 pool_remain=5025 diff=0  OK
ASSERT PASS
```

三个批数口径照 `ZC-deep-b271.md` §8.3：`140`（排期）/ `50`（纯行上界，`5,025÷100≈50`）/
`420`（文件装箱对照，不作排期）。

### 6.3 三断言

`remain == 0` 未达成；`done + remain = 2,396 + 5,025 = 7,421` OK；`ledger-assert PASS`。
本批推进 `remain`：5,125 → **5,025**。

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
| b277 | 0 | 0 | 2 | 0 | **2** | yes | no | 2 | `useWorkspaceServices.tsx:198/199` 本就不弱，`--scope` 抓到后原样回退 |
| **b278** | **0** | **0** | **0** | **0** | **0** | **no** | **no** | **2** | 3 W（`AutomationDesignPrimitives.tsx:70/72/118`），无越界 |

六批合计：`write_phase 7 + record_phase 0 = 7`。越界在 b275–b278 连续四批为 0，
但 b277 的 2 行证明它没有结构性消失，仍按「发生即计、回滚也计」记录。

## 8. 收口三断言（指针）

仍按 `ZC-deep-b265.md` §9：`remain == 0`、`done + remain == 7,421`、`ledger-assert PASS`。
本批推进 `remain`：5,125 → **5,025**，A1 未达成。
