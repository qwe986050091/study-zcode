# ZC-deep-b279：注释清水 100 行（6 文件）· 起笔前置拦截上线 · 新口径样本 n=7

> 批次：b279 ｜ 提交 `ae2978f6` ｜ 代码 `+100/−100` ｜ 零代码行
> 尺子：`deep-quality.mjs` v2.0（`756bea66122a`）、`zc-commit.mjs` v13（`f02be471a849`）、
> `capacity-estimate.mjs`（`71c35d496da1`）、`weak-guard.mjs`（`a3600ccfacab`）、
> `ledger-assert.mjs`（`35afeb266f97`）、`precheck-assert.mjs`（`47c568c3535c`，本批前升级）。

## 0. 交代

1. **开工前阻断项（15 文件脏树）**：判定与处置见 `ZC-deep-b279-preflight.md`。
   结论是 15/15 回滚、不提交、不 `git stash`；`done` 与 `remain` **都没有虚高**
   （盘上多出的 91 行 weak 全部 `inPool=0`，只改 `WEAK` 总数与 `pool-out` 中间项）。
   完整 diff 留档在仓库外 `d:\code\_annot_baseline\dirty-15-pre-revert.patch`
   （sha256 `DC3D8659214D556C2B8D0FC81DD407E9E3CABBC5984CC7A15FED3E0DC67A8B74`），未进本批。
2. **起笔前置拦截（`--start` 树必须干净）** 已在前一批提交 `db138e23`：`git status --porcelain` 非空即
   `exit 6` 并打印清单；放行路径只写进工具内 `START_ALLOW`。正控 `exit 0` / 负控 `exit 6` 均实测。
   本批 `t-start` 是在干净树上落的（`ts=2026-11-10T20:17:03.729Z`）。
3. 本批 6 文件 / 100 行：`writable=107 / upstream=0 / self-clearing=0 / pool-out=0 / pending=0`，
   受「≤100 行/批」上限约束只取 100 行，**余 7 行可写（不是池外）顺延到后续批次**。
4. 流程：`--start` → 改写 → `--scope`（首读 `out_of_scope_edits=1`，恢复后 0）→
   `--record`（首轮 2 W，返修）→ `--record`（hits=0）→ `--verify` → `zc-commit v13`
   （`ORDER GATE PASS`）→ `--order`。
5. 七行门禁全 0，`expected=6 staged=6`，`+100/−100`。
6. 批后 5 个文件清零，`ConversationSelectionTooltip.tsx` 残留 7 行可写 weak（本批 10/17）。

## 1. 四态摘要与三列计划表（沿用 b265 §2）

```text
PLAN#1	6 文件 / 100 行	writable=107 upstream=0 self-clearing=0 pool-out=0 pending=0
quota=107(writable 107 − self-clearing 0)，本批只取 100（≤100 行/批上限），余 7 行顺延
四态和=107=weak合计 池内weak=107/池内实测 107
```

| 文件 | 可写 | 上游 | 池外 | 小计 | 本批 |
| --- | ---: | ---: | ---: | ---: | ---: |
| `packages/ui/src/ToolCallBlocks/renderers/switch-mode.tsx` | 18 | 0 | 0 | 18 | 18 |
| `packages/ui/src/v4/ConversationSelectionTooltip.tsx` | 17 | 0 | 0 | 17 | 10 |
| `packages/ui/src/v4/ConversationUserInputBody.tsx` | 18 | 0 | 0 | 18 | 18 |
| `packages/ui/src/v4/composer/useWebElementContexts.ts` | 18 | 0 | 0 | 18 | 18 |
| `packages/ui/src/v4/conversationSharePreflightCache.ts` | 18 | 0 | 0 | 18 | 18 |
| `packages/ui/src/v4/useAssistantPreviewCardsForRow.ts` | 18 | 0 | 0 | 18 | 18 |
| **合计** | **107** | **0** | **0** | **107** | **100** |

- 本批**没有池外行**，也没有上游行：6 个文件的 107 行 weak 全部 `blame=a8784b7e479d` 且在
  `git diff -U0 8f7daaf0 HEAD` 的 `+` 行集合内（tooltip 的 91-93 / 122-125 也在池内，
  见 `@@ -86,0 +122,4 @@` 等块）。
- `ConversationSelectionTooltip.tsx` 只取 10 行，不是因为它池外，而是行数上限：17 行全可写，
  取 10 行正好凑满 100。

## 2. 配额扣减与批后池

```text
SELF-CLEAR n=0	可写桶 0 / 池外 0 / 上游桶 0 / 未解析 0	（只有可写桶进配额扣减）
```

批后 6 文件 weak `107 → 7`，减少的 100 行全部是登记改写；自清 0，不扣配额。
5 个文件清零，`ConversationSelectionTooltip.tsx` 剩 7 行（91-93、122-125），全部仍在池内、
仍可写，登记为下一批候选，**不记为 `pool-out`**。

## 3. 计时：四量（新口径样本 n=7）

```text
t-start    2026-11-11 04:17:03.729 +08:00
t-record   2026-11-11 04:18:46.329 +08:00  sha=c88418a08936  record_runs=2
t-verify   2026-11-11 04:18:50.221 +08:00  sha=c88418a08936  record_runs=2
commit     2026-11-11 04:19:08 +08:00  ae2978f6

batch_wall_total         = 181.0 s（db138e23 → ae2978f6，git 两端）
batch_wall_controllable  = 125.0 s（t-start → commit）
落笔段                   = 106.5 s（t-start → t-verify）
tail                     =   3.9 s（t-record → t-verify）
record_runs = 2
s/行                     = 1.07（106.5 ÷ 100）
```

- `181.0 s` 与 `125.0 s` 之差 56 s 是起笔前的选片、脏树核对与批间动作，不改写行。
- `--order --commit ae2978f6 --prev db138e23` 输出 `PRECHECK ORDER OK`（四戳齐全且单调）。

## 3.1 主档建议（n=7，按 b269 约定）

```text
样本（落笔段 s/行）  b273 1.51 / b274 1.11 / b275 1.72 / b276 1.06 / b277 1.69 / b278 1.98 / b279 1.07
中位数               1.51 s/行
极差                 1.98 − 1.06 = 0.92 s/行（中位数的 60.9%）
record_runs 分布     1 → 1 批（b273）；2 → 6 批（b274–b279）；3+ → 0 批
out_of_scope_edits   本批 1 = write_phase 1 + record_phase 0；rolled_back=yes；includes_upstream=no
结论                 **仍不切换主档**：极差 60.9% > 30% 阈值，n=7 也没有收窄
```

- **按 `record_runs` 分组（返修次数 = `record_runs − 1`）**：

  | 组 | 口径 | n | 中位数（落笔段 s/行） | 样本 |
  | --- | --- | ---: | ---: | --- |
  | 零/一次返修 | `record_runs ≤ 2` | 7 | **1.51** | 1.51 / 1.11 / 1.72 / 1.06 / 1.69 / 1.98 / 1.07 |
  | 两次以上 | `record_runs ≥ 3` | 0 | —（无样本） | 无 |

- 第二组 n=0，**不给任何工艺结论**；只能说「七批里没有一批需要两次以上返修」。
  分组没有产生可比较的第二样本，主档判断仍只看总体中位数与极差。
- 若改按 `record_runs ≤1` vs `≥2` 切（b278 曾预告的口径）：`1.51`（n=1）vs `1.40`（n=6），
  A 组只有一批，同样不构成结论；两组差 7%，小于极差，说明 `record_runs` 对落笔段时长
  的解释力弱于文件构成（本批 6 个全在 `packages/ui/src/v4`，无大协议文件）。
- 极差 60.9% 主要来自 b276 `1.06` 与 b278 `1.98`。b278 的 1.98 已在 b278 §3.1 归因于
  3 条 W 返修 + 907 行协议文件 `session-mapper.ts`；本批 1.07 是「6 个同构短文件 + 一次返修」，
  属于分布另一端的形状。两批合起来说明：**同一口径下，批的形状比返修轮数更影响 s/行**。

## 4. 度量前后（同批 6 文件，批前 `_wt_b279_pre` 干净 worktree / 批后主工作区）

| 文件 | weak 前→后 | comments | substance 前→后 | explain 前→后 | filler 前→后 |
| --- | ---: | ---: | ---: | ---: | ---: |
| `switch-mode.tsx` | 18 → 0 | 46 | 73.9 → 97.8 | 80.4 → 100.0 | 39.1 → 0.0 |
| `ConversationSelectionTooltip.tsx` | 17 → 7 | 42 | 61.9 → 81.0 | 85.7 → 92.9 | 40.5 → 16.7 |
| `ConversationUserInputBody.tsx` | 18 → 0 | 42 | 64.3 → 95.2 | 73.8 → 100.0 | 42.9 → 0.0 |
| `composer/useWebElementContexts.ts` | 18 → 0 | 41 | 65.9 → 95.1 | 87.8 → 100.0 | 43.9 → 0.0 |
| `conversationSharePreflightCache.ts` | 18 → 0 | 55 | 60.0 → 85.5 | 85.5 → 100.0 | 32.7 → 0.0 |
| `useAssistantPreviewCardsForRow.ts` | 18 → 0 | 43 | 69.8 → 95.3 | 83.7 → 100.0 | 41.9 → 0.0 |
| **合计** | **107 → 7** | **269** | **65.8 → 91.4** | **82.9 → 98.9** | **39.8 → 2.6** |

`units=532`（前后同值）。全仓同域（`packages,apps,docs/knip`）：`WEAK lines=8309 files=1968`
→ **`8209 / 1963`**。减少 100 行 = 100 行改写；减少 5 个文件 = 5 个文件清零。

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
ORDER GATE PASS record=2026-11-10T20:18:46.329Z verify=2026-11-10T20:18:50.221Z files=6
GATE self=d:\code\_annot_baseline\zc-commit.mjs blob=f02be471a849
```

登记表：`ZC-deep-b279-rewrite.tsv`（100 行，全部 blame `a8784b7e479d3a`）。

### 5.1 预检：集合断言与越界两列

```text
--scope   首读 out_of_scope_edits=1（useWebElementContexts.ts:84）→ 恢复后 SCOPED ok=0 / 0 / 0
--record  run1  hits=2（2 W）→ 返修
--record  run2  hits=0
越界      out_of_scope_write_phase=1 / out_of_scope_record_phase=0 / 合计 1
```

- 唯一越界是 `useWebElementContexts.ts:84`：我按「整块替换 84-88」写法改写，84 原行（「附件列表只在本 hook 内可变。」）
  被一起换掉，plan 只登记 85-88，`--scope` 报 `out_of_scope_edits=1`。
  恢复 84 原文、把新增语义并入 85 后，85-88 各 1→1，`--scope` 归零。
- **这 1 行计入 `write_phase`，`rolled_back=yes`，`includes_upstream=no`**——按
  「回滚不等于未发生」的口径，恢复原文不改变它发生过。
- 2 条 W 都是「改写后仍无 3 字符以上 ASCII 标识符」：`ConversationUserInputBody.tsx:36`
  （`容差避免边界高度反复抖动。`）与 `:81`（`收起避免旧展开态被沿用。`）。
  补 `USER_INPUT_CONTENT_OVERFLOW_TOLERANCE_PX` / `setExpanded(false)` 后 `hits=0`。
- `record_runs=2`；`record_phase` 无越界。

### 5.2 负控：格式化 / 标点级重排必须报红

「15 文件代码差异 100% 是 prettier 重排、无一个语义 token 变化」不等于门禁会放行。补两组负控
（干净 worktree 内做，跑完即删，不碰主工作区）：

| 负控 | 输入 | 门禁输出 | 结果 |
| --- | --- | --- | --- |
| N1 | `dirty-15-pre-revert.patch`（15 文件，`+2008/−285`） | `删代码 274 / 删上游注释 11 / 新增非注释行 238 / 新增注释命中 171`，`exit 1` | 红 |
| N2 | 单行纯空白：`padStart(8, "0");` → `padStart(8, "0") ;`（零语义差异） | `删代码 1 / 新增非注释行 1`，`exit 1` | 红 |

- 门禁按**行分类**判定：`isComment()` 为假的行被删或新增，分别进「删代码 / 新增非注释行」，
  **与语义是否等价无关**；`标点级改写` 只判注释行去标点后的同形，不是代码行的免检通道。
  所以「一次真实的格式化重排能静默通过」不成立，不是 fail-open。
- N2 是正向证据：连一个空格的位置变化都会被拦在 `git add` 之前。
- 门禁在 `git add` 之前退出，负控不产生提交；`GATE self` blob 仍为 `f02be471a849`（v13 未改）。

## 6. 收口

### 6.1 守卫（15 文件 cohort，与本批无交集）

```text
WEAK 15文件  pre=4  post=4  新增=0  max=8  key=file+正文
GUARD PASS
```

### 6.2 产能

```text
BATCHCHK b279 pre=b278-repo-post-clean.txt weak=b279-repo-post.txt  OK
done files=173 lines=2496（行口径：Σ 基线 weak − 现 weak）  perBatch=2
REMAIN	834	4925	-	418  （剩余；批数为对照/上界，不作为排期依据）
PLAN	139 批	口径=≤6 文件且 ≤100 行/批	均值 6.0 文件 / 35.4 行
ACCT files  done 173 + remain 834 = 1007  OK
ACCT lines  done 2496 + remain 4925 = 7421  OK
ALIGNED acct_remain=4925 pool_remain=4925 diff=0  OK
ASSERT PASS
```

> 口径：以上 `ACCT` 只在**池内**成立。池外另有 3,284 行 / 1,308 文件 weak，不进 `done` / `remain`（§9）。

- `b278-repo-post-clean.txt` 是 b279 批前基线（= b278 的批后快照，8,309/1,968），
  用它而不是 `b279-repo-pre.txt` 是为了让 `BATCHCHK` 的批号相邻校验成立；
  两者内容逐字相同（脏树回滚后重扫）。
- 三个批数口径照 `ZC-deep-b271.md` §8.3：`139`（排期）/ `49`（纯行上界，`4,925÷100≈49`）/
  `418`（文件装箱对照，不作排期）。

### 6.3 三断言

`remain == 0` 未达成；`done + remain = 2,496 + 4,925 = 7,421` OK；`ledger-assert PASS`。
本批推进 `remain`：5,025 → **4,925**。`ledger-assert.mjs` 实测 `ASSERT PASS`
（802 收口三列仍 `144/658/802` 全 OK，b279 的 tsv 按非 802 批次 `IGNORED`）。

## 7. 趋势：归户错 / 文本错 / 越界

> 表头口径：**回滚不等于未发生；统计目的是看越界在增加还是减少。**
> `out_of_scope_edits = out_of_scope_write_phase + out_of_scope_record_phase`，两列都计入总数，
> 不设「另有 N 行不计入」这种类别。每批另标 `rolled_back` 与 `includes_upstream`。

| 批 | 归户错 | 文本错 | write_phase | record_phase | 合计 | rolled_back | includes_upstream | `record_runs` | 明细 |
| --- | ---: | ---: | ---: | ---: | ---: | --- | --- | ---: | --- |
| b273 | 0 | 0 | 4 | 0 | **4** | yes | yes | 1 | 3 本线 + 1 上游，`--record` 前手工回滚 |
| b274 | 0 | 0 | 1 | 0 | **1** | yes | no | 2 | 本线 1 行，`numstat +19/−20` 反推后回滚 |
| b275 | 0 | 0 | 0 | 0 | **0** | no | no | 2 | `--scope` 首用，1 W + 2 L |
| b276 | 0 | 0 | 0 | 0 | **0** | no | no | 2 | 4 W + 1 L |
| b277 | 0 | 0 | 2 | 0 | **2** | yes | no | 2 | `useWorkspaceServices.tsx:198/199` 本就不弱，`--scope` 抓到后原样回退 |
| b278 | 0 | 0 | 0 | 0 | **0** | no | no | 2 | 3 W，无越界 |
| **b279** | **0** | **0** | **1** | **0** | **1** | **yes** | **no** | **2** | `useWebElementContexts.ts:84` 整块替换越界，`--scope` 抓到后恢复原文；2 W |

七批合计：`write_phase 8 + record_phase 0 = 8`。越界在 b275–b278 连续四批为 0 后，
b279 又出现 1，说明它没有结构性消失：**`--scope` 只是把「发现时刻」提前，不能阻止整块替换的写法本身越界**。
本批这 1 行与 b277 的 2 行同属「改写块边界比 plan 宽」这一类。

## 8. 收口三断言（指针）

仍按 `ZC-deep-b265.md` §9：`remain == 0`、`done + remain == 7,421`、`ledger-assert PASS`。
本批推进 `remain`：5,025 → **4,925**，A1 未达成。两列越界：`write_phase=1 / record_phase=0`。

## 9. 池外欠账：全仓量化

`done + remain == 7,421` 的等式只覆盖**池内**（本线改写过的行）。池外 weak 既不进 `remain`，
也永远不会被排期。全仓实测（`b279-repo-post.txt` 快照，池 = `git diff -U0 8f7daaf0 HEAD` 的 `+` 行）：

```text
WEAK_TOTAL  8209 行 / 1963 文件
IN_POOL     4925 行 /  834 文件
POOL_OUT    3284 行 / 1308 文件  (40.0%)
  基线同号行（本来就没进池） 2678 行 / 1007 文件
  行号漂移                   601 行 /  307 文件
  跨行续写无法归一              5 行 /    5 文件
BASELINE    7421 行 / 1007 文件  （= done 2496 + remain 4925）
```

- 分类方法：把每条池外 weak 的正文与 `8f7daaf0:<file>` 归一后比对（去掉 `//`、`/*`、`*`、`*/`）。
  同号命中 = **本来就没进池**；异号命中 = **行号漂移**（被前后插行挤开，所以不在 `+` 集合里）；
  都不命中 5 行，人工核为跨行续写的既有行，不改变结论。
- 3,284 行全部是**基线快照之前就存在的上游 weak**：它们的正文在 `8f7daaf0` 里能找到，
  从来不属于本线的 7,421。
- 因此：本线承诺的欠账 7,421；全仓同口径欠账 = 7,421 + 3,284 = **10,705**。
  HEAD 时点 = 4,925（池内 remain）+ 3,284（池外）= **8,209**。
- `ACCT done + remain == 7,421` **只对池内成立**，不能读成全仓欠账；这句已写进 `_tools/INDEX.md` §2.3。
- 这批池外行要清，必须先把它们纳入池（改一行使其成为 `+` 行）或另立零基线扫描，
  不在当前「本线改写」的记账模型内。
