# ZC-deep-b321

> 批次：b321 ｜ 44 行 / 4 文件 ｜ 提交 `3f38113b`
> 尺子：`deep-quality.mjs` v2.0（句子级口径）、`zc-commit-v13.mjs`、`precheck-assert.mjs`、`gate-run.mjs`（十一闸）

## 0. 无自清、无越界；pool-diff 因插点快照缺名补跑一次

- `scope` / `record` / `verify` / `commit` 首跑 PASS：`out_of_scope_edits=0`、`record_runs=1`、`numstat=44/44`。
- `pool-diff` **首跑 FAIL**：`removed=-1 added=-1`，原因 `PRE-WEAK MISSING d:/code/_annot_baseline/b320-repo-post.txt`。
  根因是 b320 为普查插点、未产出该批的 `repo-post` 快照，而闸按 `b{batch-1}` 取名。
- 处置（**已纠偏**）：不复制快照——复制会在档案里制造一个「b320 从未实测」的文件。
  保留 `b319-repo-post.txt`，以显式基准重跑：
  `--from pool-diff --prev 43e5e313 --pre-weak d:/code/_annot_baseline/b319-repo-post.txt` →
  `PASS removed=44 added=0 allowed=49 auto_self_clear=0`。
- 「b320 未改扫描域」的证据：
  1) `git diff --stat 43e5e313..f9f4a4cd -- packages apps docs/knip` **输出为空**（exit 0）；
  2) `git status --porcelain` **0 行**（b321 开批前工作树干净）。
  两条合起来说明 b319 批后快照就是 b320 结束时的状态，`--pre-weak b319-repo-post.txt` 与「现扫 b320」等价。
- 复制的 `b320-repo-post.txt` 已删除；`gate-run --start` 自 b322 起在落 `t-start` 前校验基准存在，
  负例见 §12。
- `order` 因 `--from` 重跑时 `sha` 为空，单独以 `--commit 3f38113b` 执行：
  `PRECHECK ORDER OK`，`batch_wall_total=194.0s`、`batch_wall_controllable=166.0s`。
- 结论：**无真实违规**；但 `commit` 闸先于 `pool-diff` 落盘，批次提交在补跑前已产生，属闸序的可改进点，已记入 §11。

## 1. 选行

| 文件 | 池内 | 池外 | 本批 | 批后 weak |
| --- | ---: | ---: | ---: | ---: |
| `packages/ui/src/resource-manager/resourceUsageParts.tsx` | 11 | 0 | 11 | 0 |
| `packages/ui/src/root/useProviderAvailabilityLoginEntryGuard.ts` | 11 | 0 | 11 | 0 |
| `packages/ui/src/root/useRootWorkspaceActions.ts` | 11 | 0 | 11 | 0 |
| `packages/ui/src/settings/saved-workflows/SavedWorkflowMetaForm.tsx` | 11 | 0 | 11 | 0 |
| **合计** | **44** | **0** | **44** | **0** |

- 本批四个文件 `upOut=0`，批后 weak 全清零；文件数 1,798 → 1,794。
- 按 §6.1 浮动规模取 4 × 11 = 44 行。

## 2. 改动内容

- `resourceUsageParts.tsx`：`UsageMetric` 与 `UsageGroupProps.metric` 同源、`UsageMeter` 三段结构与
  `systemPercent` / `appPercent` 叠放、`role="img"` 的 `aria-label` 合成、
  `columns.cpu` / `columns.memory` 二选一、`expanded` 表头与 `ProcessRow` 逐行、
  空进程只渲染 `emptyText`、`data-testid` 用 `group.category`、
  名称列 `truncate` 与 `title`、`base` 分组补 `groupLabel`、`UNSAMPLED_PLACEHOLDER` 与整格 `title`。
- `useProviderAvailabilityLoginEntryGuard.ts`：初值取 `!enabled`、`startupCheckCompletedRef` 防重入、
  `providerAvailabilityHydrated` 只由 `modelSelectionView !== null` 决定、返回值只含两项、
  `enabled=false` 的返回形状、`forceRefresh` 顺序、`setLoginEntryOpen` 同源、日志字段、
  `!enabled` 早退、`modelSelectionError` 结束等待、`isRestoringOAuthSession` 与补水等待。
- `useRootWorkspaceActions.ts`：`targetWorkspace` 覆盖焦点、`workspaceActionError` 单条覆盖与 `null` 清空、
  `requestConfirmation` 的 `Promise` 期间不读设置、`remoteProjectOpener` 不进渲染、
  `composerClientNamespace` 一致性、复用上方 scope 对象、`rememberComposerWorkspaceScope` 不在条件分支、
  `initialPrompt.trim()` 防空串覆盖、`navigationSequence.current` 自增、三次 `getState` 同帧、登出后不读设置。
- `SavedWorkflowMetaForm.tsx`：`draft` 单一数据源、8 个回调由 `SavedWorkflowDetailView` 注入、
  `descriptionError` 与 `rowErrors` 两层、不 `useState` 草稿、解构顺序、唯一 `useZCodeIntl` 调用、
  变更全部上抛、可快照测试、`workflows.hub.detail.*` 前缀、不拼自然语言、`IntlProvider` 兜底。

## 3. 门禁读数（首跑 + 补跑）

```text
gate: PASS scope     n=0 plan=44 allow=0 diff_old=44 diff_new=44 out_of_scope_edits=0
gate: PASS record    n=0 same=0 indent=0/0 mtime=0 drift=0 record_runs=1
gate: PASS verify    n=0 same=0 indent=0/0 mtime=0 drift=n/a record_runs=1 verify_ok=true
gate: PASS commit    n=0 sha=3f38113b files=4/4 numstat=44/44 删代码=0 删上游=0 新增非注释=0 搬移=0 判据=0 嵌套=0 标点=0
gate: FAIL pool-diff n=1 removed=-1 added=-1 allowed=0 auto_self_clear=0
    ! PRE-WEAK MISSING d:/code/_annot_baseline/b320-repo-post.txt
（--from pool-diff --prev 43e5e313 --pre-weak b319-repo-post.txt）
gate: PASS pool-diff n=0 removed=44 added=0 allowed=49 auto_self_clear=0
（--from order --commit 3f38113b）
PRECHECK ORDER OK t-start=09:04:33Z < t-record=09:06:56Z <= t-verify=09:06:57Z < commit=17:07:19+08:00
PRECHECK WALL batch_wall_total=194.0s batch_wall_controllable=166.0s
```

## 4. 首轮命中与返修

- 首轮 **0 / 44**，`hits=0`，无需返修；`record_runs=1`。

## 5. 自清（累计第 12 批无自清；本批 0 自动、0 人工）

- `removed=44`、`added=0`，与 plan 完全重合，`POOL-SELF-CLEAR.tsv` 无新增。
- `auto_self_clear` 仍未首次生效（b313–b321 连续 0）。

## 6. 池外对账（两个口径）

- 全仓（句子级）weak：`post-b319 5,470` → `post-b321 5,426`（**−44**），文件 `1,798 → 1,794`。
- **句子级口径**：`done 5,241 / remain 2,180`，`5,241 + 2,180 = 7,421`，**70.6%**。
- **逐行口径**：`remain ≈ 2,180 + 1,046 = 3,226`，`done ≈ 4,195 / 7,421`，约 **56.5%**。
- 池外：`5,426 − 2,180 = 3,246`，永久不排期。
- 限定语：「句子级口径；逐行口径下另有约 1,046 行池内续行被判强、未排期」。

## 7. 守卫与产能

- `GUARD` 15 文件：`pre=4 post=4 新增=0 max=8` → **PASS**（pre 复用 `b319-guard-post.txt`）。
- `capacity-estimate --batch b321`：`done files=379 (+4) / lines=5,241 (+44)`，
  `REMAIN 628 files / 2,180 lines`，`ALIGNED acct_remain=2180 pool_remain=2180 diff=0`，分档合计 315 批；
  `PARTIAL 3` 不变（`cuaDetails.tsx:1`、`script-workflow-process.ts:1`、`CoveragePanel.tsx:2`）。
- `ledger-assert`：`379 + 628 = 1,007`、`5,241 + 2,180 = 7,421` → **PASS**。
- 白名单重跑到 `3f38113b`，**404 行**。

## 8. 复算命令

```powershell
node _annot_baseline/cand-generic.mjs d:/code/_annot_baseline/b319-repo-post.txt
node _annot_baseline/pick-generic.mjs b321 d:/code/_annot_baseline/b321-files.txt d:/code/_annot_baseline/b319-repo-post.txt
node _annot_baseline/gate-run.mjs --batch b321 --start
node _annot_baseline/judge-generic.mjs b321
node _annot_baseline/gate-run.mjs --batch b321 --subject "注释清水 b321：4 文件 1→1 改写"
node _annot_baseline/gate-run.mjs --batch b321 --subject "注释清水 b321：4 文件 1→1 改写" --from pool-diff --prev 43e5e313 --pre-weak d:/code/_annot_baseline/b319-repo-post.txt
node docs/annotation/_tools/precheck-assert.mjs --repo d:/code/ZCode --base HEAD --files d:/code/_annot_baseline/b321-files.txt --snapshot d:/code/_annot_baseline/b321-precheck.json --order --commit 3f38113b --prev HEAD~1
node _annot_baseline/deep-quality.mjs d:/code/ZCode --root packages,apps,docs/knip --list-weak > _annot_baseline/b321-repo-post.txt
node _annot_baseline/deep-quality.mjs d:/code/ZCode --file-list d:/code/_annot_baseline/b254-802-files.txt --list-weak > _annot_baseline/b321-guard-post.txt
node docs/annotation/_tools/capacity-estimate.mjs --repo d:/code/ZCode --weak d:/code/_annot_baseline/b321-repo-post.txt --pre-weak d:/code/_annot_baseline/b319-repo-post.txt --batch b321
```

## 9. 计时口径

| 读数 | 起点 | 终点 | 本批 | 每行 |
| --- | --- | --- | ---: | ---: |
| `total` | 上一提交（白名单 `f9f4a4cd`） | 批次提交 `3f38113b` | 194.0s | 4.41s |
| `controllable` | `--start`（17:04:33） | 批次提交（17:07:19） | 166.0s | 3.77s |
| `批墙钟` | 本批第一个工具调用（≈17:03:50，白名单生成） | 台账提交（17:10:09） | 379s | 8.61s |

- `controllable` 含读码、写作、apply 与六道闸，不含选行与台账收口；**不是产能**，跨批只认 `批墙钟`。

## 10. 提交

| 内容 | 提交 | numstat |
| --- | --- | --- |
| 普查定档 + 47 行 backlog + 1,046 成本区间（INDEX） | `ddbdb9c3` | 1 文件 |
| 白名单（开批前，402 行） | `f9f4a4cd` | 2 文件 |
| b321 批次本体（4 文件 1→1 改写） | `3f38113b` | `+44/−44` |
| `ZC-deep-b321-rewrite.tsv` + 白名单 404 行 + 本台账 + INDEX 同步 | 见本批台账提交 | — |

- 收口判据：A1 `remain=2,180≠0`；A2 `5,241 + 2,180 = 7,421` 成立；A3 `ledger-assert PASS`；
  A4 `5,241 + 0 + 2,180 = 7,421` 成立。

## 11. 闸序改进（已落实，b322 起生效）

- `gate-run --start` 现在先解析本批基准：`--pre-weak` 显式值优先，否则取 `b{批号-1}-repo-post.txt`；
  **文件不存在即 `exit 1`**，且不落 `t-start`、不改工作树。错误信息给出三种处置：
  补批号改用更早快照 / `--pre-weak` 显式指定 / 现扫生成该批快照。
- `start` 闸的日志行新增 `pre-weak=<文件名>`，基准来源直接留在闸日志里。
- 仍保留的时序事实：`commit` 闸先于 `pool-diff`；前置检查只覆盖「基准缺失」，不改变提交顺序。

## 12. 负例（b322 开批前实跑）

```text
（临时把 b321-repo-post.txt 改名为 .bak，且不给 --pre-weak）
$ node gate-run.mjs --batch b322 --start
PRE-WEAK MISSING d:/code/_annot_baseline/b321-repo-post.txt
本批未显式给 --pre-weak，且上一批号对应的批后快照不存在。三种处置：
  1) 补批号：确认基准其实是更早的批次（如 b319），改用 --pre-weak .../b319-repo-post.txt
  2) 显式指定：--pre-weak <已有的批后快照路径>
  3) 现扫：node .../deep-quality.mjs ... --list-weak > .../b321-repo-post.txt
拒绝在基准不明时落 t-start（避免批次提交后才发现 pool-diff 无法闭合）。
exit=1
Test-Path b322-precheck.json  -> False
Test-Path b322-t-start.txt    -> False
git status --porcelain        -> 0 行
```

- 恢复文件名后 b322 正常开批；负例满足「在 `--start` 就停、工作树未被改动」两条。
