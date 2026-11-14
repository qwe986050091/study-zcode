# ZC-deep-b339

> 批次：b339 ｜ 32 行 / 4 文件 ｜ 提交 `a06ffbd4`
> 尺子：`deep-quality.mjs` v2.0（句子级口径）、`zc-commit-v13.mjs`、`precheck-assert.mjs`、`gate-run.mjs`（十一闸）

## 0. 本批只有 32 行（低于 33 下沿 1 行），原因与取舍

- `cand-generic` 在 b338 批后快照里**没有任何文件的可写行（`ownIn`）≥ 9**：最高档仍是 4 个 `ownIn=8`。
  4 文件 × 8 = 32，无论怎么挑都到不了 33。
- 可选的越界办法只有两个，都不合适：
  1) 加第 5 个文件 → 违反「每批 4 文件」的结构约束，`zc-commit` 的 `files=4/4` 也会失配；
  2) 顺手改 `own out` 行 → 越界，且会把上游 weak 算进本批。
- 取舍：**保 4 文件结构，接受 32 行**，与 b337 / b338 §0 同一处置。本批四个文件 `upOut=0`，批后全部池内清零。

## 1. 选行

| 文件 | 池内 | 池外 | 本批 | 批后 weak |
| --- | ---: | ---: | ---: | ---: |
| `packages/ui/src/settings/RemoteSyncActions.tsx` | 8 | 0 | 8 | 0 |
| `packages/ui/src/settings/model-provider-section/ProviderCardSections.tsx` | 8 | 0 | 8 | 0 |
| `packages/ui/src/settings/model-provider-section/ProviderModelReasoningLevelEditor.tsx` | 8 | 0 | 8 | 0 |
| `packages/ui/src/settings/saved-workflows/SavedWorkflowArgsTable.tsx` | 8 | 0 | 8 | 0 |
| **合计** | **32** | **0** | **32** | **0** |

- `pick-generic` 读数：`TALLY ownIn=32 ownOut=0 upIn=0 upOut=0 pending=0 planIn=32 planOut=0`，`plan=32 ownOutAllow=0`。

## 2. 改动内容

- `RemoteSyncActions.tsx`：文件头改为点名 `RemoteSyncActions` 的职责收敛句、
  `RemoteSyncClientMode` 放宽后的重连误弹、`REMOTE_SYNC_PREFLIGHT_TIMEOUT_MS` 调小的后果、
  `shouldStartRemoteSyncOperation` 放行双击、`targetKey` 切换后旧弹窗重开、
  `rpcReady` 抖动导致面板自弹、默认超时改小只提前报错、`RemoteSyncMenuItems` 点击冒泡。
- `ProviderCardSections.tsx`：`renameRequestedRef` 的复位点、
  重命名意图与自动聚焦、`showApiFormat` 不参与提交、`readOnlyBaseUrl` 与 `resolvedApiFormat` 不进可编辑分支、
  `providerSettingsService` 不参与持久化、`addSavingRef` 下允许忽略关闭请求、
  `addDraftErrorMessage` 不参与提交判定、`completeProperties` 只影响提示。
- `ProviderModelReasoningLevelEditor.tsx`：`inputRef` 自动聚焦、`nextValue` 判空去重、
  校验失败保留 `editingIndex`、`editingIndex === values.length` 走追加、
  提交后置空 `editingIndex`、`handleDrop` 调 `move`、`targetIndex` 越界由 `move` 兜底、
  无论是否移动都清 `draggingIndex`。
- `SavedWorkflowArgsTable.tsx`：`ARG_TYPES` 与后端模型对应、顺序即下拉顺序、
  新增类型要同步控件与校验、外层 `rounded-lg` 与 `border` 画边框、
  `columns` 共用列宽、`errors[row.key]` 取行错、名称错误标在 `Input`、`defaultValue` 错误只影响该控件。

## 3. 门禁读数

```text
gate: PASS start     n=0 t-start=2026-11-11T16:14:09.920Z pre-weak=b338-repo-post.txt
gate: PASS scope     n=0 plan=32 allow=0 diff_old=32 diff_new=32 out_of_scope_edits=0
gate: PASS record    n=0 same=0 indent=0/0 mtime=0 drift=0 record_runs=1
gate: PASS verify    n=0 same=0 indent=0/0 mtime=0 drift=n/a record_runs=1 verify_ok=true
gate: PASS commit    n=0 sha=a06ffbd4 files=4/4 numstat=32/32 删代码=0 删上游=0 新增非注释=0 搬移=0 判据=0 嵌套=0 标点=0
gate: PASS pool-diff n=0 removed=32 added=0 allowed=39 auto_self_clear=0
gate: PASS order     total=150.0s controllable=120.0s
```

## 4. 首轮命中与返修

- 判据**首轮 0 hit**，无文案返修；也没有越界行。
- 唯一非零处置是 §0 的选行取舍（32 行），不涉及回退。

## 5. 自清（累计第 29 批无自清；本批 0 自动、0 人工）

- `removed=32`、`added=0`，与 plan 完全重合，`POOL-SELF-CLEAR.tsv` 无新增（`allowed=39`）。
- 本批 `auto_self_clear=0`。

## 6. 池外对账（两个口径）

- 全仓（句子级）weak：`post-b338 4,789` → `post-b339 4,757`（**−32**），文件 `1,733 → 1,729`。
- **句子级口径**：`done 5,908 / remain 1,513`，`5,908 + 1,513 = 7,421`，**79.6%**。
- **逐行口径**：`remain ≈ 1,513 + 1,046 = 2,559`，`done ≈ 4,862 / 7,421`，约 **65.5%**。
- 池外：`4,757 − 1,513 = 3,244`，永久不排期。
- 限定语：「句子级口径；逐行口径下另有约 1,046 行池内续行被判强、未排期」。

## 7. 守卫与产能

- `GUARD` 15 文件：`pre=4 post=4 新增=0 max=8` → **PASS**（pre 复用 `b338-guard-post.txt`）。
- `capacity-estimate --batch b339`：`done files=451 (+4) / lines=5,908 (+32)`，
  `REMAIN 556 files / 1,513 lines`，`ALIGNED acct_remain=1513 pool_remain=1513 diff=0`，分档合计 279 批；
  `PARTIAL 3` 不变（`cuaDetails.tsx:1`、`script-workflow-process.ts:1`、`CoveragePanel.tsx:2`）。
- `ledger-assert`：`451 + 556 = 1,007`、`5,908 + 1,513 = 7,421` → **PASS**。
- 白名单重跑到 `a06ffbd4`，**477 行**（开批前 475 行 + 本批两条）。

## 8. 复算命令

```powershell
node _annot_baseline/cand-generic.mjs d:/code/_annot_baseline/b338-repo-post.txt
node _annot_baseline/pick-generic.mjs b339 d:/code/_annot_baseline/b339-files.txt d:/code/_annot_baseline/b338-repo-post.txt
node _annot_baseline/gate-run.mjs --batch b339 --start          # 必须在改文件之前
node docs/annotation/_tools/own-commits-gen.mjs d:/code/ZCode
node _annot_baseline/judge-generic.mjs b339
node _annot_baseline/gate-run.mjs --batch b339 --subject "注释清水 b339：4 文件 1→1 改写"
node _annot_baseline/deep-quality.mjs d:/code/ZCode --root packages,apps,docs/knip --list-weak > _annot_baseline/b339-repo-post.txt
node _annot_baseline/deep-quality.mjs d:/code/ZCode --file-list d:/code/_annot_baseline/b254-802-files.txt --list-weak > _annot_baseline/b339-guard-post.txt
node d:/code/ZCode/docs/annotation/_tools/weak-guard.mjs --pre d:/code/_annot_baseline/b338-guard-post.txt --post d:/code/_annot_baseline/b339-guard-post.txt
node docs/annotation/_tools/capacity-estimate.mjs --repo d:/code/ZCode --weak d:/code/_annot_baseline/b339-repo-post.txt --pre-weak d:/code/_annot_baseline/b338-repo-post.txt --batch b339
```

## 9. 计时口径

| 读数 | 起点 | 终点 | 本批 | 每行 |
| --- | --- | --- | ---: | ---: |
| `total` | 上一提交（白名单 `a8883a54`） | 批次提交 `a06ffbd4` | 150.0s | 4.69s |
| `controllable` | `--start`（16:14:09.920Z） | 批次提交 | 120.0s | 3.75s |
| `批墙钟` | 本批最早可观测产物 `b339-files.txt`（00:14:03） | 台账提交 `6685faa5`（00:17:19） | 196s | 6.13s |

- 跨批比较只认 `批墙钟`；`total` / `controllable` 仅作本批记账。

## 10. 提交

| 内容 | 提交 | numstat |
| --- | --- | --- |
| 白名单（开批前，475 行） | `a8883a54` | 2 文件 |
| 批次本体（4 文件 1→1 改写） | `a06ffbd4` | `+32/−32` |
| `ZC-deep-b339-rewrite.tsv` + 白名单 477 行 + 本台账 + INDEX 同步 | `6685faa5` | — |

- 收口判据：A1 `remain=1,513≠0`；A2 `5,908 + 1,513 = 7,421` 成立；A3 `ledger-assert PASS`；
  A4 `5,908 + 0 + 1,513 = 7,421` 成立。
