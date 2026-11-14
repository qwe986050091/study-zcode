# ZC-deep-b344

> 批次：b344 ｜ 25 行 / 4 文件 ｜ 提交 `bd9252de`
> 尺子：`deep-quality.mjs` v2.0（句子级口径）、`zc-commit-v13.mjs`、`precheck-assert.mjs`、`gate-run.mjs`（十一闸）

## 0. 本批 25 行（**尾部批**：4 文件合计 <33，按 INDEX §6.1 第 4 条下探，下限 25）

- b343 后快照只剩 1 个 `7/7`（`task-realtime.ts`），其后是 `6/8` 两个、`6/7` 一个：
  7 + 6 + 6 + 6 = **25**。触发条件 ① `ownIn` 最高档 7、② 最大 4 文件合计 25，两条同时成立。
- **不补第 5 个文件**：第 5 个（`feishuProvider.ts`）池内只有 5 行，5 文件合计 30 仍低于下沿，
  补进来只把形状从 4 改到 5 并破坏 `files=4/4`，对可写行数没有帮助。
- `TALLY {"ownIn":25,"ownOut":2,"upIn":0,"upOut":3,"pending":0,"planIn":25,"planOut":0}` / `plan=25 ownOutAllow=3` /
  `files=4/4`。本批计时按 §6.1 第 4 条**不参与**正常批中位数与极差。

## 1. 选行

| 文件 | 池内 | 池外 | 本批 | 批后 weak |
| --- | ---: | ---: | ---: | ---: |
| `packages/shared/src/task-realtime.ts` | 7 | 0 | 7 | 0 |
| `apps/zcode-cli/packages/debug/server/analyzer.ts` | 6 | 2 | 6 | 2（本线池外） |
| `packages/ui/src/ModelConfigSelect.tsx` | 6 | 2 | 6 | 2（上游） |
| `apps/zcode-cli/packages/core/src/runtime/methods/steering.ts` | 6 | 1 | 6 | 1（上游） |
| **合计** | **25** | **5** | **25** | **5** |

- `pick-generic` 读数：`TALLY ownIn=25 ownOut=2 upIn=0 upOut=3 pending=0 planIn=25 planOut=0`，`plan=25 ownOutAllow=3`。
- 池外未动：`analyzer.ts:513/1522`（本线 blame，池外）、`ModelConfigSelect.tsx:257/578`、`steering.ts:1331`（上游）。

## 2. 改动内容

- `task-realtime.ts`：`TaskStreamMirrorBatchEvent` 的 `ops` 携带 `fromSeq..toSeq` 连续区间、`terminal` 表示该
  `runId` 收尾、`ownerClientId`/`ownerDeviceLabel` 回显设备；`TaskRunLeaseTarget` 与 `TaskStreamMirrorTarget` 同构；
  `TaskOwnerCommandRequest` 是闭合联合、每条带 `commandRequestId`、权限与征询各带 `permissionRequestId`/
  `elicitationRequestId`。
- `analyzer.ts`：`recordFirstUserMessage` 四种情况各给落值对象（`summary.firstUserMessage`/`firstUserMessageAt`）；
  `buildTimeline` 统一倒序且 `at` 缺失排最后；`timelineFromDbMessage` 让 `traceId`/`turnId` 保持 undefined；
  `cacheLimitations` 三条文案可并存；`categorizeSection` 不能假设只有英文。
- `ModelConfigSelect.tsx`：`expandedWidth` 取 `getBoundingClientRect` 宽度、关闭清空；`hasSelectableModel`
  只看 `composerOptions` 有无分组；非合并入口不测量；`options.length` 为 0 不渲染头部；
  高速档由 `isGlmHighspeedModel` 按 `modelGroups` 全部 items 的 `name` 判定，找不到传空串。
- `steering.ts`：`hasSteerInput` 检查 `input`/`attachments`/`conversationQuotes`；`inputSize` 只算正文的
  `measureUtf8Bytes`；`enqueueDeferredInput` 是延迟入口；`beforePendingInputId` 缺锚点退回队尾；
  重启清扫把 `admitted` 结算成 `discarded` 不删账本；`pendingByTurn` 构造与残留条数成正比。

## 3. 门禁读数

```text
gate: PASS start     n=0 t-start=2026-11-11T16:40:05.800Z pre-weak=b343-repo-post.txt
gate: PASS scope     n=0 plan=25 allow=0 diff_old=25 diff_new=25 out_of_scope_edits=0
gate: PASS record    n=0 same=0 indent=0/0 mtime=0 drift=0 record_runs=1
gate: PASS verify    n=0 same=0 indent=0/0 mtime=0 drift=n/a record_runs=1 verify_ok=true
gate: PASS commit    n=0 sha=bd9252de files=4/4 numstat=25/25 删代码=0 删上游=0 新增非注释=0 搬移=0 判据=0 嵌套=0 标点=0
gate: PASS pool-diff n=0 removed=25 added=0 allowed=33 auto_self_clear=0
gate: PASS order     total=126.0s controllable=121.0s
```

## 4. 首轮命中与返修

- 判据首轮 **2 hit**，都是 **L 无信息列举**，缺谓词表里的词：
  - `steering.ts:115`「hasSteerInput 同时看 input、attachments 与 conversationQuotes，任一为真即有效。」
    补 `会检查` / `则返回 true` 后归零。
  - `steering.ts:1781`「只把 admitted 结算成 discarded，不删除账本，保留…痕迹。」补 `不会删除` 后归零。
- 复检 `hits=0`；`git diff --numstat` 四文件 7/6/6/6 = 25，与 plan 一致。

## 5. 自清（累计第 34 批无自清；本批 0 自动、0 人工）

- `removed=25`、`added=0`，与 plan 完全重合；`auto_self_clear=0`，`POOL-SELF-CLEAR.tsv` 无新增（`allowed=33`）。

## 6. 池外对账（两个口径）

- 全仓（句子级）weak：`post-b343 4,641` → `post-b344 4,616`（**−25**），文件 `1,722 → 1,721`
  （`task-realtime.ts` 全清）。
- **订正**：b343 台账与 INDEX 曾把 `post-b343` 文件数写成 1,721，按快照实测为 **1,722**，本批已一并改回，
  行数 4,641 不变。
- **影响面**：这个「快照唯一文件数」是**台账显示量**，由 `--list-weak` 明细现算，没有任何检查把它当分母——
  `capacity-estimate` 只读 `WEAK lines=` 与逐行 `WEAK\t` 明细（done/remain 的文件数来自基线 tsv，`1007`），
  `weak-guard` 比的是固定 15 文件清单的 `files=15`，`ledger-assert` 用基线 tsv 与批次表。因此订正后
  所有断言结论不变（`ALIGNED diff=0`、`ASSERT PASS`、`GUARD PASS` 均为订正前后同值）。
- **句子级口径**：`done 6,048 / remain 1,373`，`6,048 + 1,373 = 7,421`，**81.5%**。
- **逐行口径**：`remain ≈ 1,373 + 1,046 = 2,419`，`done ≈ 5,002 / 7,421`，约 **67.4%**。
- 池外：`4,616 − 1,373 = 3,243`，永久不排期（含本批留下的 2 行本线池外 + 3 行上游 weak）。

## 7. 守卫与产能

- `GUARD 15 文件`：`pre=4 post=4 新增=0 max=8` → **PASS**（pre 复用 `b343-guard-post.txt`）。
- `capacity-estimate --batch b344`：`done files=471 (+4) / lines=6,048 (+25)`，
  `REMAIN 536 files / 1,373 lines`，`ALIGNED acct_remain=1373 pool_remain=1373 diff=0`，分档合计 269 批；
  `PARTIAL 3` 不变（`cuaDetails.tsx:1`、`script-workflow-process.ts:1`、`CoveragePanel.tsx:2`）。
- `ledger-assert`：`471 + 536 = 1,007`、`6,048 + 1,373 = 7,421` → **PASS**。
- 白名单重跑到 `bd9252de`，**497 行**（开批前 495 行 + 本批两条）。

## 8. 复算命令

```powershell
node docs/annotation/_tools/own-commits-gen.mjs d:/code/ZCode
node _annot_baseline/cand-generic.mjs d:/code/_annot_baseline/b343-repo-post.txt
node _annot_baseline/pick-generic.mjs b344 d:/code/_annot_baseline/b344-files.txt d:/code/_annot_baseline/b343-repo-post.txt
node _annot_baseline/gate-run.mjs --batch b344 --start          # 必须在改文件之前
node _annot_baseline/judge-generic.mjs b344
node _annot_baseline/gate-run.mjs --batch b344 --subject "注释清水 b344：4 文件 1→1 改写"
node _annot_baseline/deep-quality.mjs d:/code/ZCode --root packages,apps,docs/knip --list-weak > _annot_baseline/b344-repo-post.txt
node _annot_baseline/deep-quality.mjs d:/code/ZCode --file-list d:/code/_annot_baseline/b254-802-files.txt --list-weak > _annot_baseline/b344-guard-post.txt
node d:/code/ZCode/docs/annotation/_tools/weak-guard.mjs --pre d:/code/_annot_baseline/b343-guard-post.txt --post d:/code/_annot_baseline/b344-guard-post.txt
node docs/annotation/_tools/capacity-estimate.mjs --repo d:/code/ZCode --weak d:/code/_annot_baseline/b344-repo-post.txt --pre-weak d:/code/_annot_baseline/b343-repo-post.txt --batch b344
```

## 9. 计时口径

| 读数 | 起点 | 终点 | 本批 | 每行 |
| --- | --- | --- | ---: | ---: |
| `total` | 上一提交（白名单 `da131eb8`） | 批次提交 `bd9252de` | 126.0s | 5.04s |
| `controllable` | `--start`（16:40:05.800Z） | 批次提交 | 121.0s | 4.84s |
| `批墙钟` | 本批最早可观测产物 `b344-files.txt`（00:39:06） | 台账提交 `b46920f9`（00:43:23） | 257s | 10.28s |

- 跨批比较只认 `批墙钟`；`total` / `controllable` 仅作本批记账。

## 10. 提交

| 内容 | 提交 | numstat |
| --- | --- | --- |
| 白名单（开批前，495 行） | `da131eb8` | 2 文件 |
| 批次本体（4 文件 1→1 改写） | `bd9252de` | `+25/−25` |
| `ZC-deep-b344-rewrite.tsv` + 白名单 497 行 + 本台账 + INDEX 同步 | `b46920f9` | — |

- 收口判据：A1 `remain=1,373≠0`；A2 `6,048 + 1,373 = 7,421` 成立；A3 `ledger-assert PASS`；
  A4 `6,048 + 0 + 1,373 = 7,421` 成立。
