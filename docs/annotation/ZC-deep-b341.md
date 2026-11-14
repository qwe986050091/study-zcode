# ZC-deep-b341

> 批次：b341 ｜ 28 行 / 4 文件 ｜ 提交 `a5198720`
> 尺子：`deep-quality.mjs` v2.0（句子级口径）、`zc-commit-v13.mjs`、`precheck-assert.mjs`、`gate-run.mjs`（十一闸）

## 0. 本批只有 28 行（低于 33 下沿 5 行），原因与取舍

- `cand-generic` 在 b340 批后快照里 **`ownIn=8` 的文件已经清零**，最高档只剩 `ownIn=7`：
  2 个 7/9（`upOut=2`）、5 个 7/8（2 个 `ownOut=1`、3 个 `upOut=1`）。4×7 = **28**，这是 4 文件结构下的上界。
- 越界办法都不合适：加第 5 个文件违反「每批 4 文件」且 `files=4/4` 失配；改 `own out` 行属于越界。
- 取舍：**保 4 文件结构，接受 28 行**，与 b337–b340 §0 同一处置。四个文件批后各留 1 行池外 weak
  （2 行本线但池外 blame、2 行上游），本批不动。

## 1. 选行

| 文件 | 池内 | 池外 | 本批 | 批后 weak |
| --- | ---: | ---: | ---: | ---: |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/transcript-hydration.ts` | 8 | 1 | 7 | 1（池外本线） |
| `apps/zcode-cli/packages/cli/src/command-center/handlers/goal.ts` | 8 | 1 | 7 | 1（池外本线） |
| `packages/services/src/conversation-share/conversationShareService.ts` | 8 | 1 | 7 | 1（上游） |
| `packages/ui/src/WorkspaceSidebar/RemoteProjectDetailsPopover.tsx` | 8 | 1 | 7 | 1（上游） |
| **合计** | **32** | **4** | **28** | **4** |

- `pick-generic` 读数：`TALLY ownIn=28 ownOut=2 upIn=0 upOut=2 pending=0 planIn=28 planOut=0`，`plan=28 ownOutAllow=2`。
- 池外四行保持原样：`transcript-hydration.ts:1262`（`ee933d52`）、`goal.ts:169`（`3ead6c6a`）、
  `conversationShareService.ts:653`（`872ad960`）、`RemoteProjectDetailsPopover.tsx:209`（`0a1fc56d`）。

## 2. 改动内容

- `transcript-hydration.ts`：`entryFacts` 补发缺失会让历史验证结论静默消失、`highspeed provider`
  重启后的虚假切换提示、`cancelled` 优先于 `success` 的单调合并、`epilogueStart` 只收非负整数、
  非法记录（含 `payload` 解析失败）静默剔除不抛错、旧 `subtask` 不得据此推断失败而按 `completed` 还原、
  `timestamp` 取 `sourceTimestampMs` 或 `baseMs+seq` 不读系统时钟。
- `goal.ts`：`trim` 后的首尾空白不参与子命令判定、四方法（`readTarget`/`setTarget`/`updateTargetStatus`/
  `clearTarget`）缺一即整体降级、`splitArgs` 只取首个词、`pause` 分支不触发续跑、`clearTarget`
  结果按布尔回报、非 `forceReplace` 写入先读目标、`setTarget` 落库后进统一续跑出口。
- `conversationShareService.ts`：`IMPORTED_CONVERSATION_SHARE_FORMAT_VERSION` 只描述本地落盘格式、
  `collectShareStructureIssues` 一次收齐阻断问题、`assistantTextByProductTurnId` 串行查询可接受、
  `video`/`audio` 跳过 `allowedArtifacts` 白名单、`import` 记录同时写精确表与宽表、
  `progressEmitters` 以 `removeLastListener` 为销毁信号、扩展名比较先去点再 `toLowerCase`。
- `RemoteProjectDetailsPopover.tsx`：`disabled` 为真时收起并 `clearTimer`、`mode` 显式记录 `hover`/`click`、
  卸载复用同一清理函数、`callback` 可选、`open` 条件由 `disabled` 与 `mode` 共同决定、
  `onCloseAutoFocus` 先 `preventDefault` 再把焦点还给行元素、回填只针对 `anchorRef` 行元素。

## 3. 门禁读数

```text
gate: PASS start     n=0 t-start=2026-11-11T16:23:00.089Z pre-weak=b340-repo-post.txt
gate: PASS scope     n=0 plan=28 allow=0 diff_old=28 diff_new=28 out_of_scope_edits=0
gate: PASS record    n=0 same=0 indent=0/0 mtime=0 drift=0 record_runs=1
gate: PASS verify    n=0 same=0 indent=0/0 mtime=0 drift=n/a record_runs=1 verify_ok=true
gate: PASS commit    n=0 sha=a5198720 files=4/4 numstat=28/28 删代码=0 删上游=0 新增非注释=0 搬移=0 判据=0 嵌套=0 标点=0
gate: PASS pool-diff n=0 removed=29 added=0 allowed=36 auto_self_clear=1
gate: PASS order     total=259.0s controllable=214.0s
```

## 4. 首轮命中与返修

- 判据首轮 **1 hit**：`conversationShareService.ts:1496` 的 L「无信息列举」
  （`video/audio` 那行两个逗号且无谓词）。把「不进上传清单」改成「跳过上传清单」补上谓词，复检 `hits=0`。
- 无越界行，无回退。另见 §0 的 28 行取舍。

## 5. 自清（累计第 31 批；本批 1 自动、0 人工）

- `removed=29`、`added=0`，比 plan 多 1 行：`transcript-hydration.ts:639`（`872ad960`）的 JSDoc 摘要
  因相邻改写转强，属 `auto_self_clear=1`，**落在池外**，只减 weak 不减 `done`。
- 已登记 `POOL-SELF-CLEAR.tsv`（`allowed=36`）。

## 6. 池外对账（两个口径）

- 全仓（句子级）weak：`post-b340 4,726` → `post-b341 4,697`（**−29**），文件 `1,726 → 1,726`
  （四个文件各留 1 行池外 weak）。
- **句子级口径**：`done 5,967 / remain 1,454`，`5,967 + 1,454 = 7,421`，**80.4%**。
- **逐行口径**：`remain ≈ 1,454 + 1,046 = 2,500`，`done ≈ 4,921 / 7,421`，约 **66.3%**。
- 池外：`4,697 − 1,454 = 3,243`，永久不排期（含本批留下的 4 行池外 weak）。
- 限定语：「句子级口径；逐行口径下另有约 1,046 行池内续行被判强、未排期」。

## 7. 守卫与产能

- `GUARD` 15 文件：`pre=4 post=4 新增=0 max=8` → **PASS**（pre 复用 `b340-guard-post.txt`）。
- `capacity-estimate --batch b341`：`done files=459 (+4) / lines=5,967 (+28)`，
  `REMAIN 548 files / 1,454 lines`，`ALIGNED acct_remain=1454 pool_remain=1454 diff=0`，分档合计 275 批；
  `PARTIAL 3` 不变（`cuaDetails.tsx:1`、`script-workflow-process.ts:1`、`CoveragePanel.tsx:2`）。
- `ledger-assert`：`459 + 548 = 1,007`、`5,967 + 1,454 = 7,421` → **PASS**。
- 白名单重跑到 `a5198720`，**485 行**（开批前 483 行 + 本批两条）。

## 8. 复算命令

```powershell
node _annot_baseline/cand-generic.mjs d:/code/_annot_baseline/b340-repo-post.txt
node _annot_baseline/pick-generic.mjs b341 d:/code/_annot_baseline/b341-files.txt d:/code/_annot_baseline/b340-repo-post.txt
node _annot_baseline/gate-run.mjs --batch b341 --start          # 必须在改文件之前
node docs/annotation/_tools/own-commits-gen.mjs d:/code/ZCode
node _annot_baseline/judge-generic.mjs b341
node _annot_baseline/gate-run.mjs --batch b341 --subject "注释清水 b341：4 文件 1→1 改写"
node _annot_baseline/deep-quality.mjs d:/code/ZCode --root packages,apps,docs/knip --list-weak > _annot_baseline/b341-repo-post.txt
node _annot_baseline/deep-quality.mjs d:/code/ZCode --file-list d:/code/_annot_baseline/b254-802-files.txt --list-weak > _annot_baseline/b341-guard-post.txt
node d:/code/ZCode/docs/annotation/_tools/weak-guard.mjs --pre d:/code/_annot_baseline/b340-guard-post.txt --post d:/code/_annot_baseline/b341-guard-post.txt
node docs/annotation/_tools/capacity-estimate.mjs --repo d:/code/ZCode --weak d:/code/_annot_baseline/b341-repo-post.txt --pre-weak d:/code/_annot_baseline/b340-repo-post.txt --batch b341
```

## 9. 计时口径

| 读数 | 起点 | 终点 | 本批 | 每行 |
| --- | --- | --- | ---: | ---: |
| `total` | 上一提交（白名单 `4040ea15`） | 批次提交 `a5198720` | 259.0s | 9.25s |
| `controllable` | `--start`（16:23:00.089Z） | 批次提交 | 214.0s | 7.64s |
| `批墙钟` | 本批最早可观测产物 `b341-files.txt`（00:22:49） | 台账提交 `fd668bbf`（00:29:08） | 379s | 13.54s |

- 跨批比较只认 `批墙钟`；`total` / `controllable` 仅作本批记账。

## 10. 提交

| 内容 | 提交 | numstat |
| --- | --- | --- |
| 白名单（开批前，483 行） | `4040ea15` | 2 文件 |
| 批次本体（4 文件 1→1 改写） | `a5198720` | `+28/−28` |
| `ZC-deep-b341-rewrite.tsv` + 白名单 485 行 + 本台账 + INDEX 同步 | `fd668bbf` | — |

- 收口判据：A1 `remain=1,454≠0`；A2 `5,967 + 1,454 = 7,421` 成立；A3 `ledger-assert PASS`；
  A4 `5,967 + 0 + 1,454 = 7,421` 成立。
