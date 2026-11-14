# ZC-deep-b342

> 批次：b342 ｜ 28 行 / 4 文件 ｜ 提交 `5031948e`
> 尺子：`deep-quality.mjs` v2.0（句子级口径）、`zc-commit-v13.mjs`、`precheck-assert.mjs`、`gate-run.mjs`（十一闸）

## 0. 本批 28 行（低于 33 下沿 5 行），原因与取舍

- `ownIn=8` 的档在 b340 后已清零，b341 又把仅有的 4 个 `ownIn=7` 里的 3 个（含 7/9 两个）用掉，
  b341 后快照只剩 5 个 7 档：2 个 7/9（`upOut=2`）、2 个 7/8（`upOut=1`）、2 个 7/7（全清）。
- 本批优先取 **2 个 7/7 全清 + 2 个 7/8**：4×7 = **28**，与 b341 同为「4 文件结构下的上界」。
  加第 5 个文件违反「每批 4 文件」且 `files=4/4` 失配；改池外行属于越界，故按 §0 惯例接受 28 行。

## 1. 选行

| 文件 | 池内 | 池外 | 本批 | 批后 weak |
| --- | ---: | ---: | ---: | ---: |
| `apps/zcode-cli/packages/core/src/session-context/topic-archive.ts` | 7 | 0 | 7 | 0 |
| `apps/zcode-cli/packages/core/src/tool/handlers/bash-model-content.ts` | 7 | 0 | 7 | 0 |
| `packages/ui/src/app-shell/WorkspaceShellLayout.tsx` | 8 | 1 | 7 | 1（上游） |
| `packages/ui/src/plugin-ui/components/PluginUiLauncherItems.tsx` | 8 | 1 | 7 | 1（上游） |
| **合计** | **30** | **2** | **28** | **2** |

- `pick-generic` 读数：`TALLY ownIn=28 ownOut=0 upIn=0 upOut=2 pending=0 planIn=28 planOut=0`，`plan=28 ownOutAllow=2`。
- 上游 weak 未动：`WorkspaceShellLayout.tsx:2816`、`PluginUiLauncherItems.tsx:61`（另 `:62` 同块）。
  两者都在池外，属永久不排期。

## 2. 改动内容

- `topic-archive.ts`：`readTopicArchive` 纯读 runtime 事实、`sourceSchema.safeParse` 失败即丢弃来源、
  `sources` 末项决定作用域、`record.id` 去重后写覆盖、`toLocaleLowerCase` 归一匹配、
  `budget` 取 `query.maxTokens` 与 12000 的较小值、`next` 游标只推进 `selected` 条数。
- `bash-model-content.ts`：`formatPersistedBashModelContent` 只预览 `serializer` 已写 `content`、
  `formatProviderErrorContent` 保留退出码与三段输出、`staleReadFileStateHint` 等提示段按存在拼接、
  空段经 `filter(Boolean)` 不留空行、`stderr` 先 `trim` 收敛、`interrupted` 补 `error` 标记、有正文时标记前置换行。
- `WorkspaceShellLayout.tsx`：`rememberExpandedSize` 记住浏览器面板宽度、`collapseSidebarIfStillNarrow`
  下一帧再量宽、`V4SplitPaneEntryProvider` 仅本地桌面布局启用、`floatingAnchor` 持久化不回弹、
  `isTerminalVisible` 时对话列补下圆角与边框、`isSidePaneVisible` 时终端独立圆角边框。
- `PluginUiLauncherItems.tsx`：`error` 只弹一次 `toast`、骨架用 `aria-hidden` 隔离点击、
  `sessionId`/`entries` 共用空态出口、`uiSurfaces` 按 `surfaceId` 精确查找、
  `open` 分发单点复用、菜单未就绪时 `event.preventDefault`、未安装只调 `prepare`。

## 3. 门禁读数

```text
gate: PASS start     n=0 t-start=2026-11-11T16:30:29.374Z pre-weak=b341-repo-post.txt
gate: PASS scope     n=0 plan=28 allow=0 diff_old=28 diff_new=28 out_of_scope_edits=0
gate: PASS record    n=0 same=0 indent=0/0 mtime=0 drift=0 record_runs=1
gate: PASS verify    n=0 same=0 indent=0/0 mtime=0 drift=n/a record_runs=1 verify_ok=true
gate: PASS commit    n=0 sha=5031948e files=4/4 numstat=28/28 删代码=0 删上游=0 新增非注释=0 搬移=0 判据=0 嵌套=0 标点=0
gate: PASS pool-diff n=0 removed=28 added=0 allowed=36 auto_self_clear=0
gate: PASS order     total=195.0s controllable=133.0s
```

## 4. 首轮命中与返修

- 判据首轮 **2 hit**，都不是文案判据误报：
  - `PluginUiLauncherItems.tsx:80` 是**漏改**——计划 7 行只落了 6 行，`numstat=6/6` 先暴露；
    补上（`error` 只以一次 `toast` 暴露）后回到 7/7。
  - `WorkspaceShellLayout.tsx:2945` 与 2944 是同一句跨行，`deep-quality` 按整句判不弱，
    但 `judge-generic` 逐行判则缺锚点；给 2945 补 `floatingAnchor` 后 `hits=0`。
- 无越界行，无回退。

## 5. 自清（累计第 32 批无自清；本批 0 自动、0 人工）

- `removed=28`、`added=0`，与 plan 完全重合；`auto_self_clear=0`，`POOL-SELF-CLEAR.tsv` 无新增（`allowed=36`）。

## 6. 池外对账（两个口径）

- 全仓（句子级）weak：`post-b341 4,697` → `post-b342 4,669`（**−28**），文件 `1,726 → 1,724`
  （`topic-archive.ts`、`bash-model-content.ts` 全清）。
- **句子级口径**：`done 5,995 / remain 1,426`，`5,995 + 1,426 = 7,421`，**80.8%**。
- **逐行口径**：`remain ≈ 1,426 + 1,046 = 2,472`，`done ≈ 4,949 / 7,421`，约 **66.7%**。
- 池外：`4,669 − 1,426 = 3,243`，永久不排期（含本批留下的 2 行上游 weak 与 1 行同块续行）。

## 7. 守卫与产能

- `GUARD` 15 文件：`pre=4 post=4 新增=0 max=8` → **PASS**（pre 复用 `b341-guard-post.txt`）。
- `capacity-estimate --batch b342`：`done files=463 (+4) / lines=5,995 (+28)`，
  `REMAIN 544 files / 1,426 lines`，`ALIGNED acct_remain=1426 pool_remain=1426 diff=0`，分档合计 273 批；
  `PARTIAL 3` 不变（`cuaDetails.tsx:1`、`script-workflow-process.ts:1`、`CoveragePanel.tsx:2`）。
- `ledger-assert`：`463 + 544 = 1,007`、`5,995 + 1,426 = 7,421` → **PASS**。
- 白名单重跑到 `5031948e`，**489 行**（开批前 487 行 + 本批两条）。

## 8. 复算命令

```powershell
node _annot_baseline/cand-generic.mjs d:/code/_annot_baseline/b341-repo-post.txt
node _annot_baseline/pick-generic.mjs b342 d:/code/_annot_baseline/b342-files.txt d:/code/_annot_baseline/b341-repo-post.txt
node _annot_baseline/gate-run.mjs --batch b342 --start          # 必须在改文件之前
node docs/annotation/_tools/own-commits-gen.mjs d:/code/ZCode
node _annot_baseline/judge-generic.mjs b342
node _annot_baseline/gate-run.mjs --batch b342 --subject "注释清水 b342：4 文件 1→1 改写"
node _annot_baseline/deep-quality.mjs d:/code/ZCode --root packages,apps,docs/knip --list-weak > _annot_baseline/b342-repo-post.txt
node _annot_baseline/deep-quality.mjs d:/code/ZCode --file-list d:/code/_annot_baseline/b254-802-files.txt --list-weak > _annot_baseline/b342-guard-post.txt
node d:/code/ZCode/docs/annotation/_tools/weak-guard.mjs --pre d:/code/_annot_baseline/b341-guard-post.txt --post d:/code/_annot_baseline/b342-guard-post.txt
node docs/annotation/_tools/capacity-estimate.mjs --repo d:/code/ZCode --weak d:/code/_annot_baseline/b342-repo-post.txt --pre-weak d:/code/_annot_baseline/b341-repo-post.txt --batch b342
```

## 9. 计时口径

| 读数 | 起点 | 终点 | 本批 | 每行 |
| --- | --- | --- | ---: | ---: |
| `total` | 上一提交（白名单 `82223220`） | 批次提交 `5031948e` | 195.0s | 6.96s |
| `controllable` | `--start`（16:30:29.374Z） | 批次提交 | 133.0s | 4.75s |
| `批墙钟` | 本批最早可观测产物 `b342-files.txt`（00:30:21） | 台账提交 `73da7bd3`（00:33:46） | 205s | 7.32s |

- 跨批比较只认 `批墙钟`；`total` / `controllable` 仅作本批记账。

## 10. 提交

| 内容 | 提交 | numstat |
| --- | --- | --- |
| 白名单（开批前，487 行） | `82223220` | 2 文件 |
| 批次本体（4 文件 1→1 改写） | `5031948e` | `+28/−28` |
| `ZC-deep-b342-rewrite.tsv` + 白名单 489 行 + 本台账 + INDEX 同步 | `73da7bd3` | — |

- 收口判据：A1 `remain=1,426≠0`；A2 `5,995 + 1,426 = 7,421` 成立；A3 `ledger-assert PASS`；
  A4 `5,995 + 0 + 1,426 = 7,421` 成立。
