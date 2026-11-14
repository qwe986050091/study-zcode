# ZC-deep-b280：注释清水 92 行（6 文件）· 顺延 7 行收口 · 新口径样本 n=8

> 批次：b280 ｜ 提交 `54ee8612` ｜ 代码 `+92/−92` ｜ 零代码行
> 尺子：`deep-quality.mjs` v2.0（`756bea66122a`）、`zc-commit.mjs` v13（`f02be471a849`）、
> `capacity-estimate.mjs`（`71c35d496da1`）、`weak-guard.mjs`（`a3600ccfacab`）、
> `ledger-assert.mjs`（`35afeb266f97`）、`precheck-assert.mjs`（`47c568c3535c`）。

## 0. 交代

1. 起笔前 `--start` 在干净树上通过（`ts=2026-11-10T20:34:42.864Z`），未触发 `exit 6`。
2. 本批 6 文件 / 92 行：`writable=92 / upstream=0 / self-clearing=0 / pool-out=0 / pending=0`。
   b279 顺延的 `ConversationSelectionTooltip.tsx` 剩余 7 行全部在本批改写完毕，**无新的顺延**。
3. 92 行不是 100 行：b279 后池内单文件可写上限是 17（无 18 行文件），7 + 17×5 = 92；
   仍按「≤6 文件 / ≤100 行」上限执行，不拆第 7 个文件去凑数。
4. 流程：`--start` → 改写 → `--scope`（`out_of_scope_edits=0`）→ `--record`
   （首轮 4 W，返修）→ `--record`（hits=0）→ `--verify` → `zc-commit v13`（`ORDER GATE PASS`）→ `--order`。
5. 七行门禁：`expected=6 staged=6`，`+92/−92`，`GATE self=… blob=f02be471a849`。
6. 批后 6 个文件全部清零；全仓 `WEAK lines=8117 files=1957`（b279 后 8,209 / 1,963）。

## 1. 三列计划表（沿用 b265 §2）

```text
PLAN#1	6 文件 / 92 行	writable=92 upstream=0 self-clearing=0 pool-out=0 pending=0
quota=92(writable 92 − self-clearing 0)，本批取满 92（未触及 ≤100 行上限）
四态和=92=weak合计 池内weak=92/池内实测 92
```

| 文件 | 可写 | 上游 | 池外 | 小计 | 本批 |
| --- | ---: | ---: | ---: | ---: | ---: |
| `packages/ui/src/v4/ConversationSelectionTooltip.tsx` | 7 | 0 | 0 | 7 | 7 |
| `packages/client/src/webRemoteControlAcknowledgedRelayProtocolTypes.ts` | 17 | 0 | 0 | 17 | 17 |
| `packages/desktop/src/host/remoteWorkspaceServiceCollection.ts` | 17 | 0 | 0 | 17 | 17 |
| `packages/provider-node/src/legacy-reasoning-level-renames.ts` | 17 | 0 | 0 | 17 | 17 |
| `packages/services/src/session/sourceServerWorkspaceAliasRepo.ts` | 17 | 0 | 0 | 17 | 17 |
| `packages/shared/src/zcode-session-visible-content.ts` | 17 | 0 | 0 | 17 | 17 |
| **合计** | **92** | **0** | **0** | **92** | **92** |

- 6 个文件的 92 行 weak 全部 `blame=a8784b7e479d3a`，且都在 `git diff -U0 8f7daaf0 HEAD` 的 `+` 行集合内。
- `ConversationSelectionTooltip.tsx` 是 b279 的顺延行（91-93、122-125），本批清零，b279 的「余 7 行顺延」账在本批结清。

## 2. 配额扣减与批后池

```text
SELF-CLEAR n=0	可写桶 0 / 池外 0 / 上游桶 0 / 未解析 0	（只有可写桶进配额扣减）
```

批后 6 文件 weak `92 → 0`。此前 `--start` 曾用旧白名单跑过一次产能，92 行被误归「上游自清」；
重跑 `own-commits-gen.mjs` 后 `54ee8612` 进白名单，归桶恢复为 `SELF-CLEAR n=0`（见 §6.2）。

## 3. 计时：四量（新口径样本 n=8）

```text
t-start    2026-11-11 04:34:42.864 +08:00
t-record   2026-11-11 04:37:04.893 +08:00  sha=905ff14ae965  record_runs=2
t-verify   2026-11-11 04:37:08.763 +08:00  sha=905ff14ae965  record_runs=2
commit     2026-11-11 04:37:37 +08:00  54ee8612

batch_wall_total         = 243.0 s（34a4c40d → 54ee8612，git 两端）
batch_wall_controllable  = 174.1 s（t-start → commit）
落笔段                   = 145.9 s（t-start → t-verify）
tail                     =   3.9 s（t-record → t-verify）
record_runs = 2
s/行                     = 1.59（145.9 ÷ 92）
```

- `243.0 s` 与 `174.1 s` 之差 68.9 s 是起笔前的选片与批间动作，不改写行。
- `--order --commit 54ee8612 --prev 34a4c40d` 输出 `PRECHECK ORDER OK`（四戳齐全且单调）。

### 3.1 主档建议（n=8）

```text
样本（落笔段 s/行）  b273 1.51 / b274 1.11 / b275 1.72 / b276 1.06 / b277 1.69 / b278 1.98 / b279 1.07 / b280 1.59
中位数               1.55 s/行
极差                 1.98 − 1.06 = 0.92 s/行（中位数的 59.4%）
record_runs 分布     1 → 1 批（b273）；2 → 7 批（b274–b280）；3+ → 0 批
out_of_scope_edits   本批 3 = write_phase 3 + record_phase 0；rolled_back=yes；includes_upstream=no
结论                 **仍不切换主档**：极差 59.4% > 30% 阈值，n=8 未收窄
```

- 按 `record_runs` 分组（返修次数 = `record_runs − 1`）：

  | 组 | 口径 | n | 中位数（落笔段 s/行） | 样本 |
  | --- | --- | ---: | ---: | --- |
  | 零/一次返修 | `record_runs ≤ 2` | 8 | **1.55** | 1.51 / 1.11 / 1.72 / 1.06 / 1.69 / 1.98 / 1.07 / 1.59 |
  | 两次以上 | `record_runs ≥ 3` | 0 | —（无样本） | 无 |

- 第二组仍为空组，**本批不据此给任何工艺结论**；只记「八批里没有一批需要两次以上返修」这一事实，
  等 `record_runs ≥ 3` 出现实样本后再比较两组中位数（与 b279 的口径一致，不用空组凑「分组已做」）。
- 本批 1.59 是「6 个同构短文件（单文件 ≤17 行）+ 一次返修」；与 b280 同形状的 b279 `1.07`
  相差 0.52，说明同一形状内仍有 30% 级波动，极差主要不由文件构成单独解释。

## 4. 度量前后（同批 6 文件，批前 `_wt_b280_pre` 干净 worktree / 批后主工作区）

| 文件 | weak 前→后 | comments | substance 前→后 | explain 前→后 | filler 前→后 |
| --- | ---: | ---: | ---: | ---: | ---: |
| `ConversationSelectionTooltip.tsx` | 7 → 0 | 42 | 81.0 → 95.2 | 92.9 → 100.0 | 16.7 → 0.0 |
| `webRemoteControlAcknowledgedRelayProtocolTypes.ts` | 17 → 0 | 45 | 80.0 → 95.6 | 88.9 → 100.0 | 33.3 → 0.0 |
| `remoteWorkspaceServiceCollection.ts` | 17 → 0 | 94 | 80.9 → 92.6 | 89.4 → 100.0 | 16.0 → 0.0 |
| `legacy-reasoning-level-renames.ts` | 17 → 0 | 40 | 72.5 → 95.0 | 80.0 → 100.0 | 42.5 → 0.0 |
| `sourceServerWorkspaceAliasRepo.ts` | 17 → 0 | 675 | 92.0 → 93.3 | 98.1 → 100.0 | 0.0 → 0.0 |
| `zcode-session-visible-content.ts` | 17 → 0 | 68 | 70.6 → 91.2 | 89.7 → 100.0 | 22.1 → 0.0 |
| **合计** | **92 → 0** | **964** | **87.6 → 93.4** | **95.2 → 100.0** | **7.2 → 0.0** |

`units=1669`（前后同值）。全仓同域（`packages,apps,docs/knip`）：`WEAK lines=8209 files=1963`
→ **`8117 / 1957`**。减少 92 行 = 92 行改写；减少 6 个文件 = 6 个文件清零。

## 5. 七行门禁（`zc-commit.mjs` v13，`--rewrite-annot --base HEAD`）

```text
删本线注释    n=92   （允许，逐行登记）
删代码        n=0    （必须 0）
删上游注释    n=0    （必须 0）
新增非注释行  n=0    （必须 0）
原行搬移      n=0
标点级改写    n=0    （必须 0）
新增注释行    n=92   其中判据命中 0  其中嵌套注释 0
numstat: +92 −92
expected=6  staged=6
ORDER GATE PASS record=2026-11-10T20:37:04.893Z verify=2026-11-10T20:37:08.763Z files=6
GATE self=d:\code\_annot_baseline\zc-commit.mjs blob=f02be471a849
```

登记表：`ZC-deep-b280-rewrite.tsv`（92 行，全部 blame `a8784b7e479d3a`）。
提交后复核（`git show 54ee8612` 逐行分类）：`add 92 / del 92 / 新增非注释 0 / 删代码 0 / 空行 0`，
与门禁读数一致。

### 5.1 预检：集合断言与越界两列

```text
--scope   out_of_scope_edits=0
--record  run1  hits=4（4 W）→ 返修
--record  run2  hits=0
越界      out_of_scope_write_phase=3 / out_of_scope_record_phase=0 / 合计 3
```

- **这 3 行没有被 `--scope` 抓到，是本批主动记账**：改写 `remoteWorkspaceServiceCollection.ts`
  178-182 段时，我多改了 180-182（原行本就含 `hostId` / `readKnownWorkspaces` 等 ASCII 标识符，不在 plan 内），
  在跑 `--scope` 之前已恢复原文。按「回滚不等于未发生」的口径照样计入 `write_phase=3`，
  `rolled_back=yes`、`includes_upstream=no`。
- 与 b279 的 1 行同类：**改写块边界比 plan 宽**。差别是这次 `--scope` 跑之前就自查回滚了，
  所以工具读数为 0——**工具读数为 0 不等于没发生过**，这一行就是证据。
- 4 条 W 全是「改写后仍无 3 字符以上 ASCII 标识符」：
  `legacy-reasoning-level-renames.ts:33`（`(?:[.\-:/\[].*)?` 里没有 ≥3 字符的 ASCII 串）、
  `:95`（`legacyReasoningLevelRenames` 未写进正文）、`:146`（只写了 `.*`）、
  `sourceServerWorkspaceAliasRepo.ts:1093`（三处并列但无谓词，判 L）。
  分别补 `modelMatch` / `legacyReasoningLevelRenames` / `modelMatch` / `直接返回` 后 `hits=0`。
- `record_runs=2`；`record_phase` 无越界。

## 6. 收口

### 6.1 守卫（15 文件 cohort，与本批无交集）

```text
WEAK 15文件  pre=4  post=4  新增=0  max=8  key=file+正文
GUARD PASS
```

### 6.2 产能

```text
BATCHCHK b280 pre=b279-repo-post.txt weak=b280-repo-post.txt  OK
done files=179 lines=2588（行口径：Σ 基线 weak − 现 weak）  perBatch=2
REMAIN	828	4833	-	414  （剩余；批数为对照/上界，不作为排期依据）
PLAN	138 批	口径=≤6 文件且 ≤100 行/批	均值 6.0 文件 / 35.0 行
ACCT files  done 179 + remain 828 = 1007  OK
ACCT lines  done 2588 + remain 4833 = 7421  OK
ALIGNED acct_remain=4833 pool_remain=4833 diff=0  OK
ASSERT PASS
```

> 口径：以上 `ACCT` 只在**池内**成立。池外另有 3,284 行 / 1,308 文件 weak，不进 `done` / `remain`（b279 §9）。

- **本批抓到一次白名单滞后**：首跑产能时 `done` 只 +7（Tooltip 的 7 行），其余 85 行被归成
  「上游自清」。原因是 `54ee8612` 尚未进 `OWN-COMMITS.tsv`，`blame` 判上游。
  `own-commits-gen.mjs` 重生成（214 → 268 行）后 `SELF-CLEAR` 归桶恢复、`ALIGNED diff=0`。
  **可执行结论：每批改写提交后、跑 `capacity-estimate` 之前，先重跑 `own-commits-gen.mjs` 并 `--verify`。**
- `--plan 6x100` 的 138 批：`4,833 ÷ 35.0 ≈ 138`；`414` 是文件装箱对照上界，`49` 是纯行上界
  （`4,833 ÷ 100`），三个口径照 `ZC-deep-b271.md` §8.3 分开报，不合并。

### 6.3 三断言

`remain == 0` 未达成；`done + remain = 2,588 + 4,833 = 7,421` OK；`ledger-assert PASS`。
本批推进 `remain`：4,925 → **4,833**。`ledger-assert.mjs` 实测 `ASSERT PASS`
（802 收口三列仍 `144/658/802` 全 OK，b280 的 tsv 按非 802 批次 `IGNORED`）。

## 7. 趋势：归户错 / 文本错 / 越界

> 表头口径：**回滚不等于未发生；统计目的是看越界在增加还是减少。**
> `out_of_scope_edits = out_of_scope_write_phase + out_of_scope_record_phase`，两列都计入总数，
> 不设「另有 N 行不计入」这种类别。每批另标 `rolled_back` 与 `includes_upstream`。

| 批 | 归户错 | 文本错 | write_phase | record_phase | 合计 | rolled_back | includes_upstream | `record_runs` | 明细 |
| --- | ---: | ---: | ---: | ---: | ---: | --- | --- | ---: | --- |
| b273 | 0 | 0 | 4 | 0 | **4** | yes | yes | 1 | 3 本线 + 1 上游，`--record` 前手工回滚 |
| b274 | 0 | 0 | 1 | 0 | **1** | yes | no | 2 | 本线 1 行，`numstat` 反推后回滚 |
| b275 | 0 | 0 | 0 | 0 | **0** | no | no | 2 | `--scope` 首用，1 W + 2 L |
| b276 | 0 | 0 | 0 | 0 | **0** | no | no | 2 | 4 W + 1 L |
| b277 | 0 | 0 | 2 | 0 | **2** | yes | no | 2 | `useWorkspaceServices.tsx:198/199` 原样回退 |
| b278 | 0 | 0 | 0 | 0 | **0** | no | no | 2 | 3 W，无越界 |
| b279 | 0 | 0 | 1 | 0 | **1** | yes | no | 2 | `useWebElementContexts.ts:84` 整块替换越界 |
| **b280** | **0** | **0** | **3** | **0** | **3** | **yes** | **no** | **2** | `remoteWorkspaceServiceCollection.ts:180-182` 改写块越界，`--scope` 前自查恢复；4 W |

八批合计：`write_phase 11 + record_phase 0 = 11`。b280 的 3 行与 b279 的 1 行、b277 的 2 行同属
「改写块边界比 plan 宽」；**这次 `--scope` 读数为 0，是因为回滚发生在跑 `--scope` 之前**——
说明该工具只能测「跑的那一刻还在漂移的越界」，测不到「已经改过又恢复」的越界，两列口径必须靠人工自查补齐。

## 8. 收口三断言（指针）

仍按 `ZC-deep-b265.md` §9：`remain == 0`、`done + remain == 7,421`、`ledger-assert PASS`。
本批推进 `remain`：4,925 → **4,833**，A1 未达成。两列越界：`write_phase=3 / record_phase=0`。
