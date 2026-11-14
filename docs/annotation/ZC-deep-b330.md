# ZC-deep-b330

> 批次：b330 ｜ 40 行 / 4 文件 ｜ 提交 `0755ad09`
> 尺子：`deep-quality.mjs` v2.0（句子级口径）、`zc-commit-v13.mjs`、`precheck-assert.mjs`、`gate-run.mjs`（十一闸）

## 0. 无自清、无越界；基准默认解析（未复制快照）

- `gate: PASS start ... pre-weak=b329-repo-post.txt`——基准由 `b{批号-1}` 默认规则解析，未复制任何快照。
- 六闸全部 PASS：`out_of_scope_edits=0`、`record_runs=1`、`numstat=40/40`、
  `pool-diff removed=40 added=0 allowed=46 auto_self_clear=0`。
- 首轮 `judge-generic` 即 `hits=0`；`git diff --stat` 始终 `40 insertions / 40 deletions`。
- 本批四个文件全是「短句堆叠」型注释块，改写后每行都有 ASCII 锚点，堆叠判据自动消失。

## 1. 选行

| 文件 | 池内 | 池外 | 本批 | 批后 weak |
| --- | ---: | ---: | ---: | ---: |
| `packages/ui/src/v4/MarkdownSelectionTooltip.tsx` | 10 | 0 | 10 | 0 |
| `packages/ui/src/v4/composer/PptxElementReferenceChip.tsx` | 10 | 0 | 10 | 0 |
| `packages/web/src/web-remote-control/adapters/payloadRequester.ts` | 10 | 0 | 10 | 0 |
| `packages/zcode-server-cli/src/server-core/taskActivityTracker.ts` | 10 | 0 | 10 | 0 |
| **合计** | **40** | **0** | **40** | **0** |

- 四个文件 `upOut=0`，批后 weak 全清零；文件数 1,765 → 1,761。
- 10 × 4 = 40，落在 33–44 浮动区间内。

## 2. 改动内容

- `MarkdownSelectionTooltip.tsx`：`inspect` 只在 `rootRef` 内取选区、`SelectionActionMenu` 的位置来自
  `range.getBoundingClientRect`、侧聊可用性经 `useSyncExternalStore` 读取；
  `selection.isCollapsed`/`rangeCount`、`hasExcludedConversationSelectionEndpoint`、
  `selection.toString`/`rect` 三道放弃条件；`useTextSelection` 的 `observeSelectionChange`；
  超长选区只留加入任务、`sideState` 为 `unavailable` 的原因、`onOpen` 成功后才 `close`。
- `PptxElementReferenceChip.tsx`：`getReferenceText` 的四级回退（`selectedText` → `text` → `nodeName` → `nodeType`）；
  `references.length` 为 0 返回 `null`、`label` 的 `one`/`many`、`removeLabel` 的 `intl.formatMessage`；
  `ContextAttachmentPill` 承接 `icon` 与 `onRemoveAll`、逐条 `map` 引用行、`onOpen` 存在才渲染按钮。
- `payloadRequester.ts`：`relay-unavailable`/`desktop-bootstrap-timeout` 两种 `reason`、
  `recoverTimeout` 显式开启、其余 `failure.reason` 原样抛出；
  `recoveryPromise` 只建一次并由 `finally` 清空、并发共用、失败后原 `sender` 重放一次；
  `pending` 以 `requestId` 为键、`defaultTimeoutMs` 默认 `10_000`、四个返回方法。
- `taskActivityTracker.ts`：`TaskActivityTracker` 三项能力、`Event<number>` 只带数量、
  `readRunningTasks` 返回快照、`changed` 只在数量变化时 `fire`、`workspaces` 以 `workspaceKey` 索引、
  `activeSessionIds` 汇总、`disposed` 单次标记、`unavailable` 按 `runtimeIdentity` 移除、
  在线先 `dispose` 旧 `telemetry` 再登记。

## 3. 门禁读数

```text
gate: PASS scope     n=0 plan=40 allow=0 diff_old=40 diff_new=40 out_of_scope_edits=0
gate: PASS record    n=0 same=0 indent=0/0 mtime=0 drift=0 record_runs=1
gate: PASS verify    n=0 same=0 indent=0/0 mtime=0 drift=n/a record_runs=1 verify_ok=true
gate: PASS commit    n=0 sha=0755ad09 files=4/4 numstat=40/40 删代码=0 删上游=0 新增非注释=0 搬移=0 判据=0 嵌套=0 标点=0
gate: PASS pool-diff n=0 removed=40 added=0 allowed=46 auto_self_clear=0
gate: PASS order     total=98.0s controllable=72.0s
```

## 4. 首轮命中与返修

- 首轮 **0 / 40**，无返修。

## 5. 自清（累计第 20 批无自清；本批 0 自动、0 人工）

- `removed=40`、`added=0`，与 plan 完全重合，`POOL-SELF-CLEAR.tsv` 无新增（`allowed=46`）。
- 本批 `auto_self_clear=0`。

## 6. 池外对账（两个口径）

- 全仓（句子级）weak：`post-b329 5,101` → `post-b330 5,061`（**−40**），文件 `1,765 → 1,761`。
- **句子级口径**：`done 5,605 / remain 1,816`，`5,605 + 1,816 = 7,421`，**75.5%**。
- **逐行口径**：`remain ≈ 1,816 + 1,046 = 2,862`，`done ≈ 4,559 / 7,421`，约 **61.4%**。
- 池外：`5,061 − 1,816 = 3,245`，永久不排期。
- 限定语：「句子级口径；逐行口径下另有约 1,046 行池内续行被判强、未排期」。

## 7. 守卫与产能

- `GUARD` 15 文件：`pre=4 post=4 新增=0 max=8` → **PASS**（pre 复用 `b329-guard-post.txt`）。
- `capacity-estimate --batch b330`：`done files=415 (+4) / lines=5,605 (+40)`，
  `REMAIN 592 files / 1,816 lines`，`ALIGNED acct_remain=1816 pool_remain=1816 diff=0`，分档合计 297 批；
  `PARTIAL 3` 不变（`cuaDetails.tsx:1`、`script-workflow-process.ts:1`、`CoveragePanel.tsx:2`）。
- `ledger-assert`：`415 + 592 = 1,007`、`5,605 + 1,816 = 7,421` → **PASS**。
- 白名单重跑到 `0755ad09`，**441 行**（开批前 439 行 + 本批批次提交与开批白名单提交两条）。

## 8. 复算命令

```powershell
node _annot_baseline/cand-generic.mjs d:/code/_annot_baseline/b329-repo-post.txt
node _annot_baseline/pick-generic.mjs b330 d:/code/_annot_baseline/b330-files.txt d:/code/_annot_baseline/b329-repo-post.txt
node docs/annotation/_tools/own-commits-gen.mjs d:/code/ZCode
node _annot_baseline/gate-run.mjs --batch b330 --start
node _annot_baseline/judge-generic.mjs b330
node _annot_baseline/gate-run.mjs --batch b330 --subject "注释清水 b330：4 文件 1→1 改写"
node _annot_baseline/deep-quality.mjs d:/code/ZCode --root packages,apps,docs/knip --list-weak > _annot_baseline/b330-repo-post.txt
node _annot_baseline/deep-quality.mjs d:/code/ZCode --file-list d:/code/_annot_baseline/b254-802-files.txt --list-weak > _annot_baseline/b330-guard-post.txt
node d:/code/ZCode/docs/annotation/_tools/weak-guard.mjs --pre d:/code/_annot_baseline/b329-guard-post.txt --post d:/code/_annot_baseline/b330-guard-post.txt
node docs/annotation/_tools/capacity-estimate.mjs --repo d:/code/ZCode --weak d:/code/_annot_baseline/b330-repo-post.txt --pre-weak d:/code/_annot_baseline/b329-repo-post.txt --batch b330
```

## 9. 计时口径

| 读数 | 起点 | 终点 | 本批 | 每行 |
| --- | --- | --- | ---: | ---: |
| `total` | 上一提交（白名单 `94af4d22`，17:49:13） | 批次提交 `0755ad09`（17:50:51） | 98.0s | 2.45s |
| `controllable` | `--start`（17:49:39） | 批次提交（17:50:51） | 72.0s | 1.80s |
| `批墙钟` | 本批最早可观测产物 `b330-files.txt`（17:49:34） | 台账提交 `f3d21b7c`（17:51:48） | 134s | 3.35s |

- `controllable` 含读码、写作、apply 与六道闸，不含选行与台账收口；**不是产能**，跨批只认 `批墙钟`。

## 10. 提交

| 内容 | 提交 | numstat |
| --- | --- | --- |
| 白名单（开批前，439 行） | `94af4d22` | 2 文件 |
| 批次本体（4 文件 1→1 改写） | `0755ad09` | `+40/−40` |
| `ZC-deep-b330-rewrite.tsv` + 白名单 441 行 + 本台账 + INDEX 同步 | `f3d21b7c` | — |

- 收口判据：A1 `remain=1,816≠0`；A2 `5,605 + 1,816 = 7,421` 成立；A3 `ledger-assert PASS`；
  A4 `5,605 + 0 + 1,816 = 7,421` 成立。
