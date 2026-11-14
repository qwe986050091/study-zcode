# ZC-deep-b291：7 文件 / 97 行（全池内，3 行池外自清）

> 批次：b291 ｜ 提交 `4d7d84ed` ｜ 代码 `+97/−97` ｜ 零代码行
> 尺子：`deep-quality.mjs` v2.0（`756bea66122a`）、`zc-commit.mjs` v13（`f02be471a849`）、
> `precheck-assert.mjs`（`--start` 实盘逐行基准的第三批）、
> `capacity-estimate.mjs`、`weak-guard.mjs`、`ledger-assert.mjs`。

## 0. 交代

1. 本批 7 文件 / **97 行，全部池内**（`ownIn=97 ownOut=0 upIn=0 upOut=0 pending=0 plan=97 allow=13`）。
   `allow=13` 是同文件里上游 weak 行，未触碰。
2. 起笔前重跑 `own-commits-gen`（308 行 / `head=7bd2b159`），白名单单独提交后才 `--start`
   （`2026-11-11T05:54:21.058Z`）。
3. 流程：`--start` → 起草 → `b291-apply.mjs`（1→1，`SAME 0`）→ 判据预判（2 轮，首轮 9 条）
   → `--scope` → `--record`（**首跑即过**，`record_runs=1`）→ `--verify` → `zc-commit v13` → `--order`。
4. 七行门禁：`expected=7 staged=7`，`+97/−97`；顺序断言
   `t-start 05:54:21.058 < t-record 05:56:35.634 ≤ t-verify 05:56:36.912 < commit 13:56:56+08:00`。
5. 第 8 行门禁第三批：`indentChanged=0 eolChanged=0`、`SAME 0`、`mtime touched_restored=0`。
6. 本批结束重生成白名单：**310 行 / `head=4d7d84ed`**。

## 1. 计划表

| 文件 | 池内 | 池外 own | 本批 | 批后 weak |
| --- | ---: | ---: | ---: | ---: |
| `packages/ui/src/root/useAccountConnectionLossNotification.ts` | 15 | 0 | 15 | 0 |
| `packages/ui/src/settings/useWorkspaceHookInlineTrust.ts` | 15 | 0 | 15 | 0 |
| `packages/ui/src/settings/workspaceHookReviewCommands.ts` | 15 | 0 | 15 | 0 |
| `packages/web/src/web-remote-control/ui/webRemoteControlFailureScreen.tsx` | 15 | 0 | 15 | 0 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/mcp-ui/appTools.ts` | 14 | 0 | 14 | 0 |
| `apps/zcode-cli/packages/core/src/runtime/methods/session-title.ts` | 14 | 0 | 14 | 0 |
| `packages/ui/src/components/workflow-timeline/WorkflowTimeline.tsx` | 9 | 0 | 9 | 0 |
| **合计** | **97** | **0** | **97** | **0** |

## 2. 批后池

```text
done files=243（+7）  remain files=764
done lines=3581（+97）remain lines=3840（−97）
ALIGNED acct_remain=3840 pool_remain=3840 diff=0
完成度 3581 / 7421 = 48.3%
```

- 登记 97 行 == `done +97`，无池外 own 差额。
- 本批 **SELF-CLEAR n=3**（全部 `out-of-pool`，可写桶 0、上游桶 0、未解析 0）：
  `appTools.ts:146`、`WorkflowTimeline.tsx:97`、`workspaceHookReviewCommands.ts:98`。
  这三行不在池内，改写邻行后判据不再命中；按口径不计入 `done`，只记「池外自清 3」。
- 全仓 weak `7197 → 7097`（−100）= 池内 97 + 池外自清 3；池外 `7097 − 3840 = 3257`（前值 3260）。
- `done 3,581` 的台账口径仍是：**「已写入 3,581 行，其中 10 行经 N/P 双读，fail 1」**；
  抽检 fail 率不参与 `remain`。

## 3. 计时（新口径 n=6）

```text
t-start    2026-11-11T05:54:21.058Z
t-record   2026-11-11T05:56:35.634Z  sha=37aef3f7ead9  record_runs=1
t-verify   2026-11-11T05:56:36.912Z  sha=37aef3f7ead9
commit     2026-11-11T13:56:56+08:00  4d7d84ed

batch_wall_total        = 221.0 s（7bd2b159 → 4d7d84ed）
batch_wall_controllable = 155.0 s（t-start → commit）
落笔段                  = 135.9 s（t-start → t-verify）
tail                    =   1.3 s（t-record → t-verify）
s/行（新口径，端到端）  = 1.60（155.0 / 97）
```

- 新口径样本 n=6：3.26 / 1.62 / 2.57 / 1.66 / 2.21 / 1.60，中位数 **1.98**。
  仍只作区间，不与旧口径 1.59 比快慢。

## 4. 度量前后

| 文件 | weak 前→后 |
| --- | ---: |
| `useAccountConnectionLossNotification.ts` | 15 → 0 |
| `useWorkspaceHookInlineTrust.ts` | 15 → 0 |
| `workspaceHookReviewCommands.ts` | 15 → 0 |
| `webRemoteControlFailureScreen.tsx` | 15 → 0 |
| `appTools.ts` | 14 → 0 |
| `session-title.ts` | 14 → 0 |
| `WorkflowTimeline.tsx` | 9 → 0 |

- 全仓：`post-b290 7197 / 1906` → `post-b291 7097 / 1902`。
- 池内：`done 3484 / remain 3937` → `done 3581 / remain 3840`。
- PARTIAL 仍为 1：`cuaDetails.tsx` 基线 23 → 现 1。

## 5. 门禁

```text
删本线注释 n=97   删代码 n=0   删上游注释 n=0
新增非注释行 n=0  原行搬移 n=0  标点级改写 n=0
新增注释行 n=97   判据命中 0   嵌套注释 0
numstat: +97 −97
PRECHECK SAME same_rewrites=0（record / verify 各一次）
PRECHECK SCOPE plan=97 allow=13 diff_old=97 diff_new=97 out_of_scope_edits=0
PRECHECK INDENT indentChanged=0 eolChanged=0
PRECHECK MTIME  touched_restored=0
ORDER GATE PASS
```

- `record_runs=1`：**无返修**。
- 首轮预判 `hits=9`（6 W + 3 L），第二轮 `hits=0`：
  - W（纯中文、无 ASCII 锚点）：`WorkflowTimeline.tsx:20/89/100`、`session-title.ts:102/104`、`appTools.ts:204`
    —— 分别补 `TimelineStation`、`resolveToneClassName`、`stationHeight`、
    `maybeStartSessionTitleGenerationFromExternalInput`、`skip`、`claim`。
  - L（并列符 ≥2 且无谓词）：`useAccountConnectionLossNotification.ts:56`（两个 `，`）、
    `useWorkspaceHookInlineTrust.ts:98`（三个 `、`）、`WorkflowTimeline.tsx:189`（两个 `，`）
    —— 改为分号断句 /「由…决定」/「保证…」。
  - 返修只补锚点与谓词，未改语义。

## 6. 收口

```text
GUARD 15文件 pre=4 post=4 新增=0 max=8 → PASS
ACCT files 243 + 764 = 1007 OK
ACCT lines 3581 + 3840 = 7421 OK
ALIGNED acct_remain=3840 pool_remain=3840 diff=0
ledger-assert ASSERT PASS（CLOSE 802 = 802，EXEMPT 2）
OWNCOMMITS rows=310 generated=310 missing=0 extra=0 text=same
WHITELIST OK head=4d7d84ed6720 rows=310
SELF-CLEAR n=3（out-of-pool 3）
```

## 7. 首轮命中率（逐批）

| 批 | 首轮 hits | 登记行 | 命中率 |
| --- | ---: | ---: | ---: |
| b285 | 1 | 70 | 1.4% |
| b286 | 8 | 97 | 8.2% |
| b287 | 2 | 92 | 2.2% |
| b288 | 6 | 90 | 6.7% |
| b289 | 7 | 90 | 7.8% |
| b290 | 6 | 90 | 6.7% |
| **b291** | **9** | **97** | **9.3%** |

- 七批均值约 6.0%。b291 的 9 条中 6 条 W 都出在「一行一个短断言」的旧注释上，
  补主语标识符即可过；3 条 L 是并列顿号/逗号达 2 个仍无谓词。

## 8. 剩余工作量（按 post-b291 更新）

| 口径 | 单位耗时 | 3,840 行折算 | 说明 |
| --- | ---: | ---: | --- |
| `controllable`（新口径 n=6，中位数） | 1.98 s/行 | 7,603 s ≈ 2.1 h | 只作区间 |
| 端到端（b286 实测） | 5.67 s/行 | 21,773 s ≈ **6.0 h** | 含门禁、返修、快照、台账 |
| 批次折算 | 90 行/批 | **约 43 批** | `3,840 / 90 ≈ 43` |

## 9. 池外对账

| 快照 | 提交 | weak | files | remain | 池外 |
| --- | --- | ---: | ---: | ---: | ---: |
| post-b289 | `a307ec35` | 7287 | 1912 | 4027 | 3260 |
| post-b290 | `02af44fa` | 7197 | 1906 | 3937 | 3260 |
| post-b291 | `4d7d84ed` | 7097 | 1902 | 3840 | 3257 |

- `7197 − 7097 = 100` = 池内 97 + 池外自清 3；池外差额 3260 → 3257 与自清数一致。
