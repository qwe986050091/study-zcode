# ZC-deep-b326

> 批次：b326 ｜ 40 行 / 4 文件 ｜ 提交 `832b1d3e`
> 尺子：`deep-quality.mjs` v2.0（句子级口径）、`zc-commit-v13.mjs`、`precheck-assert.mjs`、`gate-run.mjs`（十一闸）

## 0. 无自清、无越界；基准默认解析（未复制快照）

- `gate: PASS start ... pre-weak=b325-repo-post.txt`——基准由 `b{批号-1}` 默认规则解析，未复制任何快照。
- 十一闸全部首跑 PASS：`out_of_scope_edits=0`、`record_runs=1`、`numstat=40/40`、
  `pool-diff removed=40 added=0 allowed=46 auto_self_clear=0`。
- 返修只触及本批计划行（3 行），`git diff --stat` 始终 `40 insertions / 40 deletions`，无连带。

## 1. 选行

| 文件 | 池内 | 池外 | 本批 | 批后 weak |
| --- | ---: | ---: | ---: | ---: |
| `packages/desktop/src/host/sourceServerConnectionManager.ts` | 10 | 0 | 10 | 0 |
| `packages/ui/src/SSHDialog.tsx` | 10 | 0 | 10 | 0 |
| `packages/ui/src/TaskInteractionBadge.tsx` | 10 | 0 | 10 | 0 |
| `packages/web/src/web-remote-control/adapters/relayMessage.ts` | 10 | 0 | 10 | 0 |
| **合计** | **40** | **0** | **40** | **0** |

- 四个文件 `upOut=0`，批后 weak 全清零；文件数 1,781 → 1,777。
- 10 × 4 = 40，落在 33–44 浮动区间内。

## 2. 改动内容

- `sourceServerConnectionManager.ts`：`retryable=false` 是 `isRetryableError` 的唯一依据、
  `remote-connection-canceled` 让 `scheduleReconnect` 停止续排、`reconnectInputs.delete` 撤销恢复意图、
  `ONLINE_RETRY_DELAYS_MS` 三档不接受指数退避、`isAutomaticRecoveryUserActionCode` 的三个 code 与终态、
  新增动作码必须同步、`reconnectInputs` 的 set/delete 时机、`reconnectOnStartup` 的安装升级副作用、
  更新身份时「先写表再清定时器」的顺序。
- `SSHDialog.tsx`：`open` 由 `useRemoteConnectionFlow` 给出、`currentStep` 决定分支、
  `minimizedProgress` 经 `usePublishRemoteConnectionProgress` 发布、关闭时不动焦点、
  `screenRef` 内已有焦点不抢、`querySelector` 的首个可交互元素、`hideTriggerWhenClosed`、`dvh` 视口、`error` 的显示条件。
- `TaskInteractionBadge.tsx`：`presentation` 三字段、旧 `sessions-index` 帧缺 `toolName` 的兜底、
  `trim().toLowerCase()` 归一、`autoResolution` 只作历史帧判据；`duration` 的 `Math.max(1, …)` 除零保护、
  `progress` 的线性衰减与夹取、`now` 的边界值、`state` 缺失的缺省、纯函数可单测、`injectedNow` 与 `clockNow` 的校准时机。
- `relayMessage.ts`：`readWebSocketData` 的 `TextEncoder` 字节计数、`ArrayBuffer`/`Blob` 分支、未知类型 `String()`；
  `parseRelayMessage` 的 `readWebSocketData → JSON.parse → parseWebRemoteControlRelayV2IncomingMessage` 顺序与 catch 吞错；
  `summarizeRelayMessageForTrace` 的按 `type` 挑字段、`safePayloadMetadata` 白名单、未知 `type` 只留类型名。

## 3. 门禁读数

```text
gate: PASS start     t-start=09:34:48Z pre-weak=b325-repo-post.txt
gate: PASS scope     n=0 plan=40 allow=0 diff_old=40 diff_new=40 out_of_scope_edits=0
gate: PASS record    n=0 same=0 indent=0/0 mtime=0 drift=0 record_runs=1
gate: PASS verify    n=0 same=0 indent=0/0 mtime=0 drift=n/a record_runs=1 verify_ok=true
gate: PASS commit    n=0 sha=832b1d3e files=4/4 numstat=40/40 删代码=0 删上游=0 新增非注释=0 搬移=0 判据=0 嵌套=0 标点=0
gate: PASS pool-diff n=0 removed=40 added=0 allowed=46 auto_self_clear=0
gate: PASS order     total=90.0s controllable=84.0s
```

## 4. 首轮命中与返修

- 首轮 **3 / 40**，全部集中在「无 ASCII 锚点」与「ASCII 逗号被算作列举分隔」：
  1. `SSHDialog.tsx:78` `W/单行无信息`——补 `screenRef`。
  2. `TaskInteractionBadge.tsx:89` `L/无信息列举`——`Math.max(1, …)` 里的 ASCII 逗号被计入分隔符，改为
     `Math.max(1, deadlineAt - visibleAt)` 并用 `由` 提供谓词。
  3. `TaskInteractionBadge.tsx:93` `L/无信息列举`——`只读入参与常量，无副作用` 两处分隔无谓词，改为
     `返回值由入参与常量决定，函数无副作用，可直接单测。`
- 返修后 `hits=0`，`record → verify → commit` 全绿，`numstat=40/40`。

## 5. 自清（累计第 16 批无自清；本批 0 自动、0 人工）

- `removed=40`、`added=0`，与 plan 完全重合，`POOL-SELF-CLEAR.tsv` 无新增（`allowed=40 + 5 = 46`）。
- b325 的首例自动自清未引发后续，本批 `auto_self_clear=0`。

## 6. 池外对账（两个口径）

- 全仓（句子级）weak：`post-b325 5,261` → `post-b326 5,221`（**−40**），文件 `1,781 → 1,777`。
- **句子级口径**：`done 5,445 / remain 1,976`，`5,445 + 1,976 = 7,421`，**73.4%**。
- **逐行口径**：`remain ≈ 1,976 + 1,046 = 3,022`，`done ≈ 4,399 / 7,421`，约 **59.3%**。
- 池外：`5,221 − 1,976 = 3,245`，永久不排期。
- 限定语：「句子级口径；逐行口径下另有约 1,046 行池内续行被判强、未排期」。

## 7. 守卫与产能

- `GUARD` 15 文件：`pre=4 post=4 新增=0 max=8` → **PASS**（pre 复用 `b325-guard-post.txt`）。
- `capacity-estimate --batch b326`：`done files=399 (+4) / lines=5,445 (+40)`，
  `REMAIN 608 files / 1,976 lines`，`ALIGNED acct_remain=1976 pool_remain=1976 diff=0`，分档合计 305 批；
  `PARTIAL 3` 不变（`cuaDetails.tsx:1`、`script-workflow-process.ts:1`、`CoveragePanel.tsx:2`）。
- `ledger-assert`：`399 + 608 = 1,007`、`5,445 + 1,976 = 7,421` → **PASS**（`ROLL` 144/658/802 全 0 剩余）。
- 白名单重跑到 `832b1d3e`，**425 行**（开批前 423 行 + 本批批次提交与开批白名单提交两条）。

## 8. 复算命令

```powershell
node _annot_baseline/cand-generic.mjs d:/code/_annot_baseline/b325-repo-post.txt
node _annot_baseline/pick-generic.mjs b326 d:/code/_annot_baseline/b326-files.txt d:/code/_annot_baseline/b325-repo-post.txt
node docs/annotation/_tools/own-commits-gen.mjs d:/code/ZCode
node _annot_baseline/gate-run.mjs --batch b326 --start
node _annot_baseline/judge-generic.mjs b326
node _annot_baseline/gate-run.mjs --batch b326 --subject "注释清水 b326：4 文件 1→1 改写"
node _annot_baseline/deep-quality.mjs d:/code/ZCode --root packages,apps,docs/knip --list-weak > _annot_baseline/b326-repo-post.txt
node _annot_baseline/deep-quality.mjs d:/code/ZCode --file-list d:/code/_annot_baseline/b254-802-files.txt --list-weak > _annot_baseline/b326-guard-post.txt
node d:/code/ZCode/docs/annotation/_tools/weak-guard.mjs --pre d:/code/_annot_baseline/b325-guard-post.txt --post d:/code/_annot_baseline/b326-guard-post.txt
node docs/annotation/_tools/capacity-estimate.mjs --repo d:/code/ZCode --weak d:/code/_annot_baseline/b326-repo-post.txt --pre-weak d:/code/_annot_baseline/b325-repo-post.txt --batch b326
```

## 9. 计时口径

| 读数 | 起点 | 终点 | 本批 | 每行 |
| --- | --- | --- | ---: | ---: |
| `total` | 上一提交（白名单 `9f1fd0c9`，17:34:42） | 批次提交 `832b1d3e`（17:36:12） | 90.0s | 2.25s |
| `controllable` | `--start`（17:34:48） | 批次提交（17:36:12） | 84.0s | 2.10s |
| `批墙钟` | 本批最早可观测产物 `b326-files.txt`（17:34:34） | 台账提交 `87167685`（17:37:18） | 164s | 4.10s |

- `controllable` 含读码、写作、apply 与六道闸，不含选行与台账收口；**不是产能**，跨批只认 `批墙钟`。

## 10. 提交

| 内容 | 提交 | numstat |
| --- | --- | --- |
| 白名单（开批前，423 行） | `9f1fd0c9` | 2 文件 |
| 批次本体（4 文件 1→1 改写） | `832b1d3e` | `+40/−40` |
| `ZC-deep-b326-rewrite.tsv` + 白名单 425 行 + 本台账 + INDEX 同步 | 见本批台账提交 | — |

- 收口判据：A1 `remain=1,976≠0`；A2 `5,445 + 1,976 = 7,421` 成立；A3 `ledger-assert PASS`；
  A4 `5,445 + 0 + 1,976 = 7,421` 成立。
