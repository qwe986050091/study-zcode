# ZC-deep-b336

> 批次：b336 ｜ 33 行 / 4 文件 ｜ 提交 `23712245`
> 尺子：`deep-quality.mjs` v2.0（句子级口径）、`zc-commit-v13.mjs`、`precheck-assert.mjs`、`gate-run.mjs`（十一闸）

## 0. 首轮把池外行写进 diff（scope 拦下，已回退）

- `pick-generic` 报 `RemoteSkillSyncDialog.tsx:163` 为 `own out`（blame `872ad960`，上游 weak），
  但它和第 162 行连成一句，我按语义把它一起改了，于是 `--subject` 首跑：
  `PRECHECK SCOPE diff_old=34 diff_new=34 out_of_scope_edits=1`，`gate: FAIL scope`。
- 处置：把 163 逐字还原（`SCOPE OUT` 两行列出的 old/new 原文即对），复跑 `judge hits=0`、`diff --numstat` 四文件 8/8/8/9，
  六闸 PASS。没有重拍 `--start`，`record_runs=1`，本批读数可比。
- 教训：`own out` 的行**不能**因为上下文成句就顺手改——越界行会同时进 `diff_old` 与 `diff_new`，
  scope 闸只认 plan，语义理由不构成豁免。该行作为上游 weak 留在 `RemoteSkillSyncDialog.tsx:163`，不计入 `done`。

## 1. 选行

| 文件 | 池内 | 池外 | 本批 | 批后 weak |
| --- | ---: | ---: | ---: | ---: |
| `packages/ui/src/BotsDialog.tsx` | 8 | 0 | 8 | 0 |
| `packages/ui/src/ControlHintTooltip.tsx` | 8 | 0 | 8 | 0 |
| `packages/ui/src/ToolCallBlocks/renderers/execute-group.tsx` | 8 | 0 | 8 | 0 |
| `packages/ui/src/settings/RemoteSkillSyncDialog.tsx` | 10 | 1 | 9 | 1（上游） |
| **合计** | **34** | **1** | **33** | **1** |

- `cand-generic` 里 `upOut=0` 档本批最高 8 行/文件，4 文件上限 32，低于 33 下沿；
  因此取 `RemoteSkillSyncDialog.tsx` 的 10 行档（`upOut=1`），实际只改池内 9 行。
- 8 + 8 + 8 + 9 = 33，落在 33–44 区间；`TALLY ownIn=33 ownOut=0 upOut=1 pending=0 planIn=33`。

## 2. 改动内容

- `BotsDialog.tsx`：`saveBot` 收尾重置 `creatingBot`、扫码成功只写 `feishuAppId`（生成 `bindCode` 属另一阶段）、
  `allowedWorkspaces` 的「全部工作区」是哨兵、新建态要清三份临时态（含 `feishuRegistration`/`weixinRegistration`）、
  `useEffect` 总闸三条件、`credentialRef` 为空才自动扫码、剪贴板写完整 `/bind` 命令、`deleteBot` 后靠 `refresh()` 取真实结果。
- `ControlHintTooltip.tsx`：`setRef` 三态分流（空 / 函数型 / `current`）、`childRef` 与 `triggerRef` 合并、
  `SidebarTooltipProvider` 的 `delayDuration=300`、`skipDelayDuration=0`、`disableHoverableContent`、
  `SidebarTooltipContext` 标记侧栏范围、`SidebarNativeTooltip` 在非侧栏直接透传 `Slot.Root`。
- `execute-group.tsx`：`ACTIVE_STATUSES` 是模块级常量、`formatCompletedSummary` 两个消息键、
  `command.one`/`command.other` 分工、`failed` 与 `stopped` 可同时追加、子渲染器取自 `context.nestedToolRenderer`、
  子项以 `child.toolCall.toolId` 为 key、`ml-2` + `border-l` 表达从属、`onOpenCodeViewer` 等回调透传。
- `RemoteSkillSyncDialog.tsx`：`exists` 只影响默认勾选与筛选、`data.phase` 三字面量闭合、
  不自绘 checkbox 保留原生 `input`、`checked` 由受控属性接管（effect 只写 `indeterminate`）、
  cleanup 只置 `cancelled`、cleanup 与 open 初始化职责分离、`selectedSyncIds` 每次渲染重算交集、
  `importSkillsArchive` → `onSynced()` → `setStep("complete")` 严格串行、`onSynced` 按异步处理。

## 3. 门禁读数

```text
gate: PASS start     t-start=2026-11-11T16:00:05.716Z pre-weak=b335-repo-post.txt
gate: PASS scope     n=0 plan=33 allow=0 diff_old=33 diff_new=33 out_of_scope_edits=0
gate: PASS record    n=0 same=0 indent=0/0 mtime=0 drift=0 record_runs=1
gate: PASS verify    n=0 same=0 indent=0/0 mtime=0 drift=n/a record_runs=1 verify_ok=true
gate: PASS commit    n=0 sha=23712245 files=4/4 numstat=33/33 删代码=0 删上游=0 新增非注释=0 搬移=0 判据=0 嵌套=0 标点=0
gate: PASS pool-diff n=0 removed=33 added=0 allowed=40 auto_self_clear=0
gate: PASS order     total=217.0s controllable=172.0s
```

## 4. 首轮命中与返修

- 判据首轮 **4 hit**，均为 L「无信息列举」（顿号/逗号 ≥2 且无谓词）：
  `execute-group.tsx:41`、`RemoteSkillSyncDialog.tsx:190`、`RemoteSkillSyncDialog.tsx:538`、`BotsDialog.tsx:1056`。
- 返修：四行各自降到 1 个分隔符或补谓词，复判 `hits=0`；无文案返工之外的返修。
- 另有 §0 的越界回退 1 行（scope 闸，不是判据）。

## 5. 自清（累计第 26 批无自清；本批 0 自动、0 人工）

- `removed=33`、`added=0`，与 plan 完全重合，`POOL-SELF-CLEAR.tsv` 无新增（`allowed=40`）。
- 本批 `auto_self_clear=0`。

## 6. 池外对账（两个口径）

- 全仓（句子级）weak：`post-b335 4,886` → `post-b336 4,853`（**−33**），文件 `1,742 → 1,739`。
- **句子级口径**：`done 5,812 / remain 1,609`，`5,812 + 1,609 = 7,421`，**78.3%**。
- **逐行口径**：`remain ≈ 1,609 + 1,046 = 2,655`，`done ≈ 4,766 / 7,421`，约 **64.2%**。
- 池外：`4,853 − 1,609 = 3,244`，永久不排期（含本批留下的 1 行上游 weak）。
- 限定语：「句子级口径；逐行口径下另有约 1,046 行池内续行被判强、未排期」。

## 7. 守卫与产能

- `GUARD` 15 文件：`pre=4 post=4 新增=0 max=8` → **PASS**（pre 复用 `b335-guard-post.txt`）。
- `capacity-estimate --batch b336`：`done files=439 (+4) / lines=5,812 (+33)`，
  `REMAIN 568 files / 1,609 lines`，`ALIGNED acct_remain=1609 pool_remain=1609 diff=0`，分档合计 285 批；
  `PARTIAL 3` 不变（`cuaDetails.tsx:1`、`script-workflow-process.ts:1`、`CoveragePanel.tsx:2`）。
- `ledger-assert`：`439 + 568 = 1,007`、`5,812 + 1,609 = 7,421` → **PASS**。
- 白名单重跑到 `23712245`，**465 行**（开批前 463 行 + 本批两条）；blob `b49862c98d25`。

## 8. 复算命令

```powershell
node _annot_baseline/cand-generic.mjs d:/code/_annot_baseline/b335-repo-post.txt
node _annot_baseline/pick-generic.mjs b336 d:/code/_annot_baseline/b336-files.txt d:/code/_annot_baseline/b335-repo-post.txt
node _annot_baseline/gate-run.mjs --batch b336 --start          # 必须在改文件之前
node docs/annotation/_tools/own-commits-gen.mjs d:/code/ZCode
node _annot_baseline/judge-generic.mjs b336
node _annot_baseline/gate-run.mjs --batch b336 --subject "注释清水 b336：4 文件 1→1 改写"
node _annot_baseline/deep-quality.mjs d:/code/ZCode --root packages,apps,docs/knip --list-weak > _annot_baseline/b336-repo-post.txt
node _annot_baseline/deep-quality.mjs d:/code/ZCode --file-list d:/code/_annot_baseline/b254-802-files.txt --list-weak > _annot_baseline/b336-guard-post.txt
node d:/code/ZCode/docs/annotation/_tools/weak-guard.mjs --pre d:/code/_annot_baseline/b335-guard-post.txt --post d:/code/_annot_baseline/b336-guard-post.txt
node docs/annotation/_tools/capacity-estimate.mjs --repo d:/code/ZCode --weak d:/code/_annot_baseline/b336-repo-post.txt --pre-weak d:/code/_annot_baseline/b335-repo-post.txt --batch b336
```

## 9. 计时口径

| 读数 | 起点 | 终点 | 本批 | 每行 |
| --- | --- | --- | ---: | ---: |
| `total` | 上一提交（白名单 `65421f41`，23:59:20） | 批次提交 `23712245`（00:02:57） | 217.0s | 6.58s |
| `controllable` | `--start`（00:00:05.716） | 批次提交 | 172.0s | 5.21s |
| `批墙钟` | 本批最早可观测产物 `b336-files.txt`（23:59:54.881） | 台账提交 `e449cb2e`（00:04:29） | 274s | 8.31s |

- 跨批比较只认 `批墙钟`；`total` / `controllable` 仅作本批记账。

## 10. 提交

| 内容 | 提交 | numstat |
| --- | --- | --- |
| 白名单（开批前，463 行） | `65421f41` | 2 文件 |
| 批次本体（4 文件 1→1 改写） | `23712245` | `+33/−33` |
| `ZC-deep-b336-rewrite.tsv` + 白名单 465 行 + 本台账 + INDEX 同步 | `e449cb2e` | — |

- 收口判据：A1 `remain=1,609≠0`；A2 `5,812 + 1,609 = 7,421` 成立；A3 `ledger-assert PASS`；
  A4 `5,812 + 0 + 1,609 = 7,421` 成立。
