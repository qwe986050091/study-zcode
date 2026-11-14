# ZC-deep-b299：7 文件 / 91 行（全池内，无自清）

> 批次：b299 ｜ 提交 `d0b6e6ce` ｜ 代码 `+91/−91` ｜ 零代码行
> 尺子：`deep-quality.mjs` v2.0（`756bea66122a`）、`zc-commit.mjs` v13（`f02be471a849`）、
> `precheck-assert.mjs`（`--start` 实盘逐行基准的第十一批）、
> `capacity-estimate.mjs`、`weak-guard.mjs`、`ledger-assert.mjs`。

## 0. 交代

1. 本批 7 文件 / **91 行，全部池内**（`ownIn=91 ownOut=0 upIn=0 upOut=0 pending=0 plan=91 allow=0`）。
   每文件 13 行，`91 = 7 × 13`。
2. 起笔前重跑 `own-commits-gen`（332 行 / `head=bf52e360`），白名单单独提交（`a19a8a45`）后才 `--start`
   （`2026-11-11T06:31:28.547Z`，7 文件 1,105 行实盘逐行基准）。
   **计时口径例外（同 b293–b298）**：映射先于 `--start` 起草，`controllable` 只覆盖「落笔 → 提交」，
   **不进入中位数**。
3. 流程：`--start` → `b299-apply.mjs`（1→1，`changed=91 same=0`）→ 判据预判（首轮 4 条 → 0，全用 Edit 工具）
   → `--scope` → `--record`（首跑即过，`record_runs=1`）→ `--verify` → `zc-commit v13` → `--order`。
4. 本批起把「候选统计 / 选行 / 判据预判」收敛成三个可复用脚本
   （`cand-generic.mjs` / `pick-generic.mjs` / `judge-generic.mjs`），只把**映射表**留在每批的 `b29x-apply.mjs` 里。
   池定义、CAP、allow 规则与 b297/b298 逐字一致，`plan` 仍是「`file / baseLine / blame / content`」四列。
5. 七行门禁：`expected=7 staged=7`，`+91/−91`；顺序断言
   `t-start 06:31:28.547 < t-record 06:32:44.830 ≤ t-verify 06:32:46.324 < commit 14:33:10+08:00`。
6. 第 8 行门禁第十一批：`indentChanged=0 eolChanged=0`、`SAME 0`、`touched_restored=0`、
   `line_drift=0`、`out_of_scope_edits=0`。b298 的 BOM 事故无复发（本批无 PowerShell 就地写文件）。
7. 本批结束重生成白名单：**334 行 / `head=d0b6e6ce` / blob `d1c373863189`**（未提交，随台账一起入账）。

## 1. 计划表

| 文件 | 池内 | 池外 own | 本批 | 批后 weak |
| --- | ---: | ---: | ---: | ---: |
| `packages/ui/src/lib/taskNavigationHistory.ts` | 13 | 0 | 13 | 0 |
| `packages/ui/src/lib/zcodeTimelineIdentity.ts` | 13 | 0 | 13 | 0 |
| `packages/ui/src/remote/remoteWorkspaceProjection.ts` | 13 | 0 | 13 | 0 |
| `packages/ui/src/settings/memoryUpdatedAt.ts` | 13 | 0 | 13 | 0 |
| `packages/ui/src/feedback/feedbackSubmitSubmission.ts` | 13 | 0 | 13 | 0 |
| `packages/zcode-server-cli/src/runtime/paths.ts` | 13 | 0 | 13 | 0 |
| `packages/zcode-server-cli/src/runtime/releaseDownload.ts` | 13 | 0 | 13 | 0 |
| **合计** | **91** | **0** | **91** | **0** |

## 2. 批后池

```text
done files=297（+7）  remain files=710
done lines=4332（+91）remain lines=3089（−91）
ALIGNED acct_remain=3089 pool_remain=3089 diff=0
完成度 4332 / 7421 = 58.4%
```

- 写入 91 行、池内前移 91 行，一一对应：无 PARTIAL、无池外自清，`record_runs=1`。
- PARTIAL 仍为 3：`cuaDetails.tsx`（23 → 1）、`script-workflow-process.ts`（13 → 1）、
  `CoveragePanel.tsx`（13 → 2），本批未新增、未消化。
- 全仓：`6432 → 6341`（−91）；池外 `6341 − 3089 = 3252`，与 post-b298 持平，闭合。
- 档位分布：`>=20` 0，`10-19` 111 文件 / 1,237 行，`5-9` 141 / 931，`3-4` 158 / 539，`1-2` 300 / 382。
- `done 4,332` 的台账口径：**「已写入 4,332 行，其中 10 行经 N/P 双读，fail 1」**。

## 3. 计时（口径例外，不进入中位数）

```text
t-start    2026-11-11T06:31:28.547Z
t-record   2026-11-11T06:32:44.830Z  sha=6c943797c3f3  record_runs=1
t-verify   2026-11-11T06:32:46.324Z  sha=6c943797c3f3
commit     2026-11-11T14:33:10+08:00  d0b6e6ce

batch_wall_total        = 125.0 s（a19a8a45 → d0b6e6ce）
batch_wall_controllable = 102.0 s（t-start → commit）
落笔段                  =  77.8 s（t-start → t-verify）
tail                    =   1.5 s（t-record → t-verify）
s/行（端到端，落笔段）    = 1.12（102.0 / 91）
```

- 起草在 `--start` 之前完成，本样本与 b284/b285/b293–b298 同列「测量口径失效」，
  **不进入新口径 n=7 的中位数（仍为 1.66 s/行）**。

## 4. 度量前后

| 文件 | weak 前→后 |
| --- | ---: |
| `taskNavigationHistory.ts` | 13 → 0 |
| `zcodeTimelineIdentity.ts` | 13 → 0 |
| `remoteWorkspaceProjection.ts` | 13 → 0 |
| `memoryUpdatedAt.ts` | 13 → 0 |
| `feedbackSubmitSubmission.ts` | 13 → 0 |
| `runtime/paths.ts` | 13 → 0 |
| `runtime/releaseDownload.ts` | 13 → 0 |

- 全仓：`post-b298 6432 / 1866` → `post-b299 6341 / 1859`。
- 池内：`done 4241 / remain 3180` → `done 4332 / remain 3089`。

## 5. 门禁

```text
删本线注释 n=91   删代码 n=0   删上游注释 n=0
新增非注释行 n=0  原行搬移 n=0  标点级改写 n=0
新增注释行 n=91   判据命中 0   嵌套注释 0
numstat: +91 −91
PRECHECK SAME same_rewrites=0（record / verify 各一次）
PRECHECK SCOPE plan=91 allow=0 diff_old=91 diff_new=91 out_of_scope_edits=0
PRECHECK INDENT indentChanged=0 eolChanged=0
PRECHECK MTIME  touched_restored=0  LINE-DRIFT files=0
ORDER GATE PASS
```

- `record_runs=1`：**预检无返修**。
- 首轮预判 `hits=4`（3 W + 1 L），一轮返修后 `hits=0`：
  - W：`memoryUpdatedAt.ts:28/35`、`zcodeTimelineIdentity.ts:101` —— 分别补
    `formatWeekday()`/`formatDate()`、`startOfLocalDay()`、`hasSharedZCodeTimelineIdentity()`；
  - L：`remoteWorkspaceProjection.ts:167`（三个 `、`）→ 改 `/` 分隔。
- 起草无 `SAME`，`changed=91 same=0`，不构成空替换。

## 6. 收口

```text
GUARD 15文件 pre=4 post=4 新增=0 max=8 → PASS
ACCT files 297 + 710 = 1007 OK
ACCT lines 4332 + 3089 = 7421 OK
ALIGNED acct_remain=3089 pool_remain=3089 diff=0
ledger-assert ASSERT PASS（CLOSE 802 = 802，EXEMPT 2）
OWNCOMMITS rows=334 generated=334 missing=0 extra=0 text=same
WHITELIST OK head=d0b6e6ce rows=334
SELF-CLEAR n=0
```

## 7. 首轮命中率（逐批）

| 批 | 首轮 hits | 登记行 | 命中率 |
| --- | ---: | ---: | ---: |
| b293 | 2 | 98 | 2.0% |
| b294 | 6 | 98 | 6.1% |
| b295 | 8 | 97 | 8.2% |
| b296 | 10 | 91 | 11.0% |
| b297 | 5 | 91 | 5.5% |
| b298 | 4 | 90 | 4.4% |
| **b299** | **4** | **91** | **4.4%** |

- 近七批均值约 5.9%（39/656）。连续两批 4 条：文件构成从「UI 组件」转向「纯逻辑库 + 运行时工具」，
  短句多但每行都能对上具体函数名或常量名，返修成本低。

## 8. 剩余工作量（按 post-b299 更新）

| 口径 | 单位耗时 | 3,089 行折算 | 说明 |
| --- | ---: | ---: | --- |
| `controllable`（新口径 n=7，中位数） | 1.66 s/行 | 5,128 s ≈ 1.4 h | 只作区间 |
| 端到端（b286 实测） | 5.67 s/行 | 17,514 s ≈ **4.9 h** | 含门禁、返修、快照、台账 |
| 批次折算 | 90 行/批 | **约 35 批** | `3,089 / 90 ≈ 34.3` |

## 9. 池外对账

| 快照 | 提交 | weak | files | remain | 池外 |
| --- | --- | ---: | ---: | ---: | ---: |
| post-b296 | `b4a61ced` | 6613 | 1874 | 3359 | 3254 |
| post-b297 | `d6cf1991` | 6522 | 1872 | 3270 | 3252 |
| post-b298 | `ea942c5d` | 6432 | 1866 | 3180 | 3252 |
| post-b299 | `d0b6e6ce` | 6341 | 1859 | 3089 | 3252 |

- `6432 − 6341 = 91` = 池内前移 91 行；池外 3252 保持不变。
