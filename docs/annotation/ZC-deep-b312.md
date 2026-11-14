# ZC-deep-b312

> 批次：b312 ｜ 36 行 / 4 文件 ｜ 提交 `37f8b297`
> 尺子：`deep-quality.mjs` v2.0（句子级口径）、`zc-commit-v13.mjs`、`precheck-assert.mjs`、`gate-run.mjs`（十一闸）

## 0. 开批前置

- 重跑 `own-commits-gen.mjs` → **373 行**（`meta.head=c918c2f5`），提交 `76eefe61`（开批前工作树必须干净）。
- 选行依据 `post-b311` 快照 + `cand-generic.mjs`（池内 own 计数），取 `11 + 11 + 9 + 5 = 36`。

## 1. 选行

| 文件 | 池内 | 池外 | 本批 | 批后 weak |
| --- | ---: | ---: | ---: | ---: |
| `packages/ui/src/settings/saved-workflows/SavedWorkflowMoveDialog.tsx` | 11 | 4 | 11 | 3（含块尾 `*/` 自清 1） |
| `packages/ui/src/v4/ConversationWorkflowDigests.tsx` | 11 | 2 | 11 | 0 |
| `packages/ui/src/project-sidebar/ProjectComposerMenu.tsx` | 9 | 2 | 9 | 0 |
| `packages/ui/src/components/workflow-timeline/timeline-model.ts` | 5 | 5 | 5 | 0 |
| **合计** | **36** | **13** | **36** | **3** |

- 池外 13 行均未改（blame `872ad960` / `aac47556` / `0a1fc56d` / `29628c9a`）。
  其中 `SavedWorkflowMoveDialog.tsx:72`（块尾 `*/`，`872ad960`）在本批由邻接改写转强，
  按规则登记 `POOL-SELF-CLEAR.tsv`（见 §5），不占配额。

## 2. 改动内容

- `SavedWorkflowMoveDialog.tsx`：props 语义（`entryName` / `targets` / `busy` / `onSubmit`）、
  选中键维护与调和（`targetKey` / `reconcileAutomationWorkspaceSelectionKey`）、
  提交三步（`noTargets` 早退 → `findAutomationWorkspaceOptionByKey` 定位 → 未命中 `return`）。
- `ConversationWorkflowDigests.tsx`：空摘要早退、`workflow.fallbackName` 回落、
  `useWorkflowSubagentModelProviderName` 注入、每条 `digest` 派生 `onOpenRun` / `onResume`、
  回调即门控（`onOpenWorkflowRun` + `sessionId`、`onResumeWorkflowRun` + `summary.resumable`、
  `onOpenWorkflowActor` + 活投影）、可选字段条件展开。
- `ProjectComposerMenu.tsx`：`workspaceSearchQuery` 归属、`chatKey` 四元组与门禁、
  `operation` 序号来源（禁 `Date.now` / `Math.random`）、`connectedDevice` 不持久化、
  `canFinish` 的 `await` 后二次校验、`currentProject` 的 `hostId` 匹配、
  `canDetachProject` 三条件、`currentWorkspaceTitle` 仅展示。
- `timeline-model.ts`：模块职责（`WorkflowCausalityGraphData` × `WorkflowRunState`）、
  `withImplicitPhase` + `timelineHoleGraph` 顺序、`avatarKey` 跨阶段复用、
  `hole.state === "waiting"` 强制 `running`、行进边优先级（`reentry` → `inbound`）。

## 3. 门禁读数（十一闸）

```text
gate: PASS start     n=0 t-start=2026-11-11T08:11:14.064Z
gate: PASS scope     n=0 plan=36 allow=0 diff_old=36 diff_new=36 out_of_scope_edits=0
gate: PASS record    n=0 same=0 indent=0/0 mtime=0 drift=0 record_runs=1
gate: PASS verify    n=0 same=0 indent=0/0 mtime=0 drift=n/a record_runs=1 verify_ok=true
gate: PASS commit    n=0 sha=37f8b297 files=4/4 numstat=36/36 删代码=0 删上游=0 新增非注释=0 搬移=0 判据=0 嵌套=0 标点=0
gate: PASS pool-diff n=0 removed=37 added=0 allowed=40
gate: PASS order     n=0 total=0.0s controllable=35.0s
```

- **`pool-diff` 首跑判红**：`removed=37 / allowed=39`，未登记自清
  `packages/ui/src/settings/saved-workflows/SavedWorkflowMoveDialog.tsx:72`（`872ad960`，池外）。
  登记后 `--from pool-diff --sha 37f8b297` 补跑 → `removed=37 added=0 allowed=40` PASS。
  **commit 在首跑时已落盘**，补跑只重验后两道闸，未重提交。
- **`order` 重跑读数失真**：补跑时 `prev` 默认取 HEAD = 本批提交，故 `total=0.0s`。
  真实墙钟为 `76eefe61`（16:09:05）→ `37f8b297`（16:11:49）= **164.0s**；
  `controllable=35.0s`（`t-start 08:11:14.064Z` → `08:11:49Z`），`s/行 = 35.0 / 36 ≈ 0.97`。

## 4. 首轮命中与返修

- 首轮预判据 **0 / 36 = 0.0%**，无返修；`record_runs=1`、`write_phase 0 / record_phase 0`。

## 5. 自清（累计第 4 次，仍为池外）

`pool-diff` 首跑 `removed=37` 中，36 行是本批登记行，第 37 行是
**`packages/ui/src/settings/saved-workflows/SavedWorkflowMoveDialog.tsx:72`（blame `872ad960`，池外）**。

- 该行正文为块尾 `*/`，批前因句元与下一行同判而弱；73 行改成带 `targetKey` 的整句后整句转强。
- 已写入 `POOL-SELF-CLEAR.tsv`（`b312` / `872ad960` / `out-of-pool`），
  `capacity-estimate` 回读 `SELF-CLEAR n=1 可写桶 0 / 池外 1`，**不扣配额**。

## 6. 池外对账（两个口径）

- 全仓（句子级）weak：`post-b311 5,786` → `post-b312 5,749`（**−37** = 36 批内 + 1 自清），文件 `1,817 → 1,817`。
- **句子级口径（工程完成度）**：`done 4,919 / remain 2,502`，`4,919 + 2,502 = 7,421`，**66.3%**。
- **逐行口径（自足性，并列观测）**：`remain ≈ 2,502 + 1,046 = 3,548`，`done ≈ 3,873 / 7,421`，**约 52.2%**。
- 池外：`5,749 − 2,502 = 3,247` 行，**永久不排期**。
- 限定语（凡引用完成度处必须同段出现）：
  「句子级口径；逐行口径下另有约 1,046 行池内续行被判强、未排期」。

## 7. 守卫与产能

- `GUARD` 15 文件：`pre=4 post=4 新增=0 max=8` → **PASS**。
- `capacity-estimate --batch b312`：`done files=349 (+0) / lines=4,919 (+36)`，
  `REMAIN 658 files / 2,502 lines`，`ALIGNED acct_remain=2502 pool_remain=2502 diff=0`，分档合计 330 批；
  `PARTIAL 3`（`cuaDetails.tsx` 1、`script-workflow-process.ts` 1、`CoveragePanel.tsx` 2）。
- `SELF-CLEAR n=1`（`SavedWorkflowMoveDialog.tsx:72`，out-of-pool，累计 4 次全为池外）。
- `ledger-assert`：`ACCT files 349 + 658 = 1007`、`ACCT lines 4,919 + 2,502 = 7,421` → **PASS**。
- 白名单重跑到 `37f8b297`，**375 行**。

## 8. 复算命令

```powershell
node _annot_baseline/cand-generic.mjs d:/code/_annot_baseline/b311-repo-post.txt
node _annot_baseline/pick-generic.mjs b312 d:/code/_annot_baseline/b312-files.txt d:/code/_annot_baseline/b311-repo-post.txt
node _annot_baseline/gate-run.mjs --batch b312 --start
node _annot_baseline/apply-run.mjs b312
node _annot_baseline/judge-generic.mjs b312
node _annot_baseline/gate-run.mjs --batch b312 --subject "注释清水 b312：4 文件 1→1 改写"
node _annot_baseline/gate-run.mjs --batch b312 --from pool-diff --sha 37f8b297 --subject "注释清水 b312：4 文件 1→1 改写"
node _annot_baseline/deep-quality.mjs d:/code/ZCode --root packages,apps,docs/knip --list-weak > _annot_baseline/b312-repo-post.txt
node _annot_baseline/deep-quality.mjs d:/code/ZCode --file-list d:/code/_annot_baseline/b254-802-files.txt --list-weak > _annot_baseline/b312-guard-post.txt
node docs/annotation/_tools/weak-guard.mjs --pre d:/code/_annot_baseline/b311-guard-post.txt --post d:/code/_annot_baseline/b312-guard-post.txt
node docs/annotation/_tools/own-commits-gen.mjs d:/code/ZCode
node docs/annotation/_tools/capacity-estimate.mjs --repo d:/code/ZCode --weak d:/code/_annot_baseline/b312-repo-post.txt --pre-weak d:/code/_annot_baseline/b311-repo-post.txt --batch b312
node docs/annotation/_tools/ledger-assert.mjs d:/code/ZCode
```

## 9. 提交

| 内容 | 提交 | numstat |
| --- | --- | --- |
| 白名单（开批前，373 行） | `76eefe61` | 2 文件 |
| b312 批次本体（4 文件 1→1 改写） | `37f8b297` | `+36/−36` |
| `ZC-deep-b312-rewrite.tsv` + `POOL-SELF-CLEAR.tsv` + 白名单 375 行 + 本台账 + INDEX 同步 | 见本批台账提交 | — |

- 收口判据：A1 `remain=2,502≠0` 未到；A2 `4,919 + 2,502 = 7,421` 成立；
  A3 `ledger-assert PASS`；A4 `4,919 落笔 + 0 池内自清 + 2,502 = 7,421` 成立。
- 后续：b313 起继续 36 行/批；b320 前后按约定算 1,046 行续行自足化的可补性成本。
