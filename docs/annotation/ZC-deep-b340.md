# ZC-deep-b340

> 批次：b340 ｜ 31 行 / 4 文件 ｜ 提交 `1c0d5ef4`
> 尺子：`deep-quality.mjs` v2.0（句子级口径）、`zc-commit-v13.mjs`、`precheck-assert.mjs`、`gate-run.mjs`（十一闸）

## 0. 本批只有 31 行（低于 33 下沿 2 行），原因与取舍

- `cand-generic` 在 b339 批后快照里 `ownIn=8` 的文件只剩 **3 个**，没有 9 行档；第 4 个文件最高只能取 `ownIn=7`。
  8×3 + 7 = **31**，无论怎么挑都到不了 32，更到不了 33。
- 越界办法都不合适：加第 5 个文件违反「每批 4 文件」且 `files=4/4` 失配；改 `own out` 行属于越界。
- 取舍：**保 4 文件结构，接受 31 行**，与 b337–b339 §0 同一处置。第 4 个文件 `app-shell/types.ts` 池内 9 行中 2 行是上游 blame，本批不动，批后仍留 2 行上游 weak。

## 1. 选行

| 文件 | 池内 | 池外 | 本批 | 批后 weak |
| --- | ---: | ---: | ---: | ---: |
| `packages/ui/src/settings/saved-workflows/SavedWorkflowRunHistoryPanel.tsx` | 8 | 0 | 8 | 0 |
| `packages/ui/src/v4/V4ChatPane.tsx` | 8 | 0 | 8 | 0 |
| `packages/ui/src/v4/composer/useDraftModelReadinessGate.ts` | 8 | 0 | 8 | 0 |
| `packages/ui/src/app-shell/types.ts` | 9 | 2 | 7 | 2（上游） |
| **合计** | **33** | **2** | **31** | **2** |

- `pick-generic` 读数：`TALLY ownIn=31 ownOut=0 upIn=0 upOut=2 pending=0 planIn=31 planOut=0`，`plan=31 ownOutAllow=2`。
- `up out` 两行：`types.ts:101`、`types.ts:183`（blame `0a1fc56d`），保持原样。

## 2. 改动内容

- `SavedWorkflowRunHistoryPanel.tsx`：`canOpen` 决定入口、`canOpenRun` 先短路、
  `parentSessionId` 与 `toolCallId` 成对、`resolveRunProject` 还要求 `project.canOpen`、
  `openable` 三条件、`switch (kind)` 绑定 `icon`/`statusClass`、未知 `kind` 落 `default`、
  `statusClass` 只取 `text-success` 这类语义令牌。
- `V4ChatPane.tsx`：`openTrigger` 只影响埋点、`gitSummary` 为空不展示评审入口、
  `conversationFindQuery` 为空不启用搜索态、外层 `V4ConversationProvider` 包上下文、
  `paneId` 固定 `workspace-main`、`unavailableFallback` 由 Provider 注入、其余 `props` 透传、
  两者由 Provider 决定展示。
- `useDraftModelReadinessGate.ts`：`current.scope` 不同则丢结果、`revealMissing` 清 `dismissed`、
  同类 `missing` 沿用 `dismissed`、其它 `status` 置假、`!enabled` 直接返回 `true`、
  发送前 `await getView`、`status === "missing"` 返回 `false`、`getView` 抛错回落主机门禁。
- `app-shell/types.ts`：`AppProps` 必选回调缺失、只暴露 `IServiceAccessor`、
  `WorkspaceMainView` 为有限字面量、切换视图不销毁会话、缺省视图由调用方定、
  `toggleSidebarShortcutLabel` 等标签由平台格式化、`isSidebarVisible` 与 `isTerminalOpen` 为受控布尔。

## 3. 门禁读数

```text
gate: PASS start     n=0 t-start=2026-11-11T16:18:05.054Z pre-weak=b339-repo-post.txt
gate: PASS scope     n=0 plan=31 allow=0 diff_old=31 diff_new=31 out_of_scope_edits=0
gate: PASS record    n=0 same=0 indent=0/0 mtime=0 drift=0 record_runs=1
gate: PASS verify    n=0 same=0 indent=0/0 mtime=0 drift=n/a record_runs=1 verify_ok=true
gate: PASS commit    n=0 sha=1c0d5ef4 files=4/4 numstat=31/31 删代码=0 删上游=0 新增非注释=0 搬移=0 判据=0 嵌套=0 标点=0
gate: PASS pool-diff n=0 removed=31 added=0 allowed=38 auto_self_clear=0
gate: PASS order     total=144.0s controllable=114.0s
```

## 4. 首轮命中与返修

- 判据**首轮 0 hit**，无文案返修；也没有越界行。
- 唯一非零处置是 §0 的选行取舍（31 行），不涉及回退。

## 5. 自清（累计第 30 批无自清；本批 0 自动、0 人工）

- `removed=31`、`added=0`，与 plan 完全重合，`POOL-SELF-CLEAR.tsv` 无新增（`allowed=38`）。
- 本批 `auto_self_clear=0`。

## 6. 池外对账（两个口径）

- 全仓（句子级）weak：`post-b339 4,757` → `post-b340 4,726`（**−31**），文件 `1,729 → 1,726`。
- **句子级口径**：`done 5,939 / remain 1,482`，`5,939 + 1,482 = 7,421`，**80.0%**。
- **逐行口径**：`remain ≈ 1,482 + 1,046 = 2,528`，`done ≈ 4,893 / 7,421`，约 **65.9%**。
- 池外：`4,726 − 1,482 = 3,244`，永久不排期（含本批留下的 2 行上游 weak）。
- 限定语：「句子级口径；逐行口径下另有约 1,046 行池内续行被判强、未排期」。

## 7. 守卫与产能

- `GUARD` 15 文件：`pre=4 post=4 新增=0 max=8` → **PASS**（pre 复用 `b339-guard-post.txt`）。
- `capacity-estimate --batch b340`：`done files=455 (+4) / lines=5,939 (+31)`，
  `REMAIN 552 files / 1,482 lines`，`ALIGNED acct_remain=1482 pool_remain=1482 diff=0`，分档合计 277 批；
  `PARTIAL 3` 不变（`cuaDetails.tsx:1`、`script-workflow-process.ts:1`、`CoveragePanel.tsx:2`）。
- `ledger-assert`：`455 + 552 = 1,007`、`5,939 + 1,482 = 7,421` → **PASS**。
- 白名单重跑到 `1c0d5ef4`，**481 行**（开批前 479 行 + 本批两条）。

## 8. 复算命令

```powershell
node _annot_baseline/cand-generic.mjs d:/code/_annot_baseline/b339-repo-post.txt
node _annot_baseline/pick-generic.mjs b340 d:/code/_annot_baseline/b340-files.txt d:/code/_annot_baseline/b339-repo-post.txt
node _annot_baseline/gate-run.mjs --batch b340 --start          # 必须在改文件之前
node docs/annotation/_tools/own-commits-gen.mjs d:/code/ZCode
node _annot_baseline/judge-generic.mjs b340
node _annot_baseline/gate-run.mjs --batch b340 --subject "注释清水 b340：4 文件 1→1 改写"
node _annot_baseline/deep-quality.mjs d:/code/ZCode --root packages,apps,docs/knip --list-weak > _annot_baseline/b340-repo-post.txt
node _annot_baseline/deep-quality.mjs d:/code/ZCode --file-list d:/code/_annot_baseline/b254-802-files.txt --list-weak > _annot_baseline/b340-guard-post.txt
node d:/code/ZCode/docs/annotation/_tools/weak-guard.mjs --pre d:/code/_annot_baseline/b339-guard-post.txt --post d:/code/_annot_baseline/b340-guard-post.txt
node docs/annotation/_tools/capacity-estimate.mjs --repo d:/code/ZCode --weak d:/code/_annot_baseline/b340-repo-post.txt --pre-weak d:/code/_annot_baseline/b339-repo-post.txt --batch b340
```

## 9. 计时口径

| 读数 | 起点 | 终点 | 本批 | 每行 |
| --- | --- | --- | ---: | ---: |
| `total` | 上一提交（白名单 `a2db2be8`） | 批次提交 `1c0d5ef4` | 144.0s | 4.65s |
| `controllable` | `--start`（16:18:05.054Z） | 批次提交 | 114.0s | 3.68s |
| `批墙钟` | 本批最早可观测产物 `b340-files.txt`（00:17:57） | 台账提交 `9d9e3563`（00:21:01） | 184s | 5.94s |

- 跨批比较只认 `批墙钟`；`total` / `controllable` 仅作本批记账。

## 10. 提交

| 内容 | 提交 | numstat |
| --- | --- | --- |
| 白名单（开批前，479 行） | `a2db2be8` | 2 文件 |
| 批次本体（4 文件 1→1 改写） | `1c0d5ef4` | `+31/−31` |
| `ZC-deep-b340-rewrite.tsv` + 白名单 481 行 + 本台账 + INDEX 同步 | `9d9e3563` | — |

- 收口判据：A1 `remain=1,482≠0`；A2 `5,939 + 1,482 = 7,421` 成立；A3 `ledger-assert PASS`；
  A4 `5,939 + 0 + 1,482 = 7,421` 成立。
