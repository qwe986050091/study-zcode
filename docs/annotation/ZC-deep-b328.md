# ZC-deep-b328

> 批次：b328 ｜ 40 行 / 4 文件 ｜ 提交 `4f5bf021`
> 尺子：`deep-quality.mjs` v2.0（句子级口径）、`zc-commit-v13.mjs`、`precheck-assert.mjs`、`gate-run.mjs`（十一闸）

## 0. 无自清、无越界；基准默认解析（未复制快照）

- `gate: PASS start ... pre-weak=b327-repo-post.txt`——基准由 `b{批号-1}` 默认规则解析，未复制任何快照。
- 十一闸全部首跑 PASS：`out_of_scope_edits=0`、`record_runs=1`、`numstat=40/40`、
  `pool-diff removed=40 added=0 allowed=46 auto_self_clear=0`。
- 首轮 `judge-generic` 即 `hits=0`，无需返修；`git diff --stat` 始终 `40 insertions / 40 deletions`，无连带。

## 1. 选行

| 文件 | 池内 | 池外 | 本批 | 批后 weak |
| --- | ---: | ---: | ---: | ---: |
| `packages/ui/src/components/coding-plan-quota-reset/CodingPlanQuotaResetOpportunity.tsx` | 10 | 0 | 10 | 0 |
| `packages/ui/src/components/ui/pptx-selection-action-bar.tsx` | 10 | 0 | 10 | 0 |
| `packages/ui/src/conversation-workspace-target/usePluginCreator.ts` | 10 | 0 | 10 | 0 |
| `packages/ui/src/git-action-menu/currentSessionFileScope.ts` | 10 | 0 | 10 | 0 |
| **合计** | **40** | **0** | **40** | **0** |

- 四个文件 `upOut=0`，批后 weak 全清零；文件数 1,773 → 1,769。
- 10 × 4 = 40，落在 33–44 浮动区间内。

## 2. 改动内容

- `CodingPlanQuotaResetOpportunity.tsx`：`remainingSeconds` 由 `useState` 惰性初始化器调 `getRemainingSeconds`、
  `dialogOpen`/`uncontrolledDialogOpen` 共用 `resolvedDialogOpen`、单/多机会共用 `effectiveVisible`、
  `openDialogLabel` 随 `count` 变、`countdownLabel` 由 `formatCodingPlanQuotaResetCountdown` 格式化、
  `label` 与 `aria-label` 同源、`dialog` 存在才渲染可点入口、`onClick` 阻断默认行为与冒泡、两处开关复用 `setDialogOpen`。
- `pptx-selection-action-bar.tsx`：`PptxSelectionActionBar` 不持有选择状态、`comment` 草稿只在 `editing` 期存在、
  `compositionActiveRef` 保存组合输入标记、退出编辑清空草稿并复位标记、`useEffect` 依赖只有 `editing`、
  `Popover` 的 `modal=false`、`PopoverContent` 经 Portal 独立于幻灯片缩放、`role="toolbar"` + `aria-label`、
  非编辑态走 `onExitSelection`。
- `usePluginCreator.ts`：`create` 与 `busyScope` 一起返回、`isWebRemoteControl` 时 `group`/`paneLayout` 取缺省、
  `scope` 可用性由 `target` 与 `onCreateTask` 共同决定、解析与创建都调 `resolveWorkbenchNewTaskTarget`、
  远端回退 `INITIAL_PANE_LAYOUT`、`targetKey` 先身份后路径、`pending.current === scope` 去重、
  `resolution.rpcReady` 未就绪时 toast、预填空不创建、结束按 `scope` 清理。
- `currentSessionFileScope.ts`：`normalizeCommitScopePath` 的 trim → 反斜杠 → 前导 `./` → 尾部斜杠四步、
  `stripBasePath` 的空侧返回 `null`、相等返回空串、前缀不匹配时 `toLowerCase` 再比、
  `filterCommitPreviewFilesByCurrentSession` 先 `buildCurrentSessionFileScope`、空 `scope` 全放行、
  逐文件交 `isPreviewFileInScope` 判定。

## 3. 门禁读数

```text
gate: PASS start     t-start=09:42:49Z pre-weak=b327-repo-post.txt
gate: PASS scope     n=0 plan=40 allow=0 diff_old=40 diff_new=40 out_of_scope_edits=0
gate: PASS record    n=0 same=0 indent=0/0 mtime=0 drift=0 record_runs=1
gate: PASS verify    n=0 same=0 indent=0/0 mtime=0 drift=n/a record_runs=1 verify_ok=true
gate: PASS commit    n=0 sha=4f5bf021 files=4/4 numstat=40/40 删代码=0 删上游=0 新增非注释=0 搬移=0 判据=0 嵌套=0 标点=0
gate: PASS pool-diff n=0 removed=40 added=0 allowed=46 auto_self_clear=0
gate: PASS order     total=100.0s controllable=71.0s
```

## 4. 首轮命中与返修

- 首轮 **0 / 40**，无返修。
- 40 行同样按「每行点一个具体标识符」写，b326 的两类坑（无 ASCII 锚点的 `W`、ASCII 逗号计入列举分隔的 `L`）均未触发。

## 5. 自清（累计第 18 批无自清；本批 0 自动、0 人工）

- `removed=40`、`added=0`，与 plan 完全重合，`POOL-SELF-CLEAR.tsv` 无新增（`allowed=46`）。
- 本批 `auto_self_clear=0`。

## 6. 池外对账（两个口径）

- 全仓（句子级）weak：`post-b327 5,181` → `post-b328 5,141`（**−40**），文件 `1,773 → 1,769`。
- **句子级口径**：`done 5,525 / remain 1,896`，`5,525 + 1,896 = 7,421`，**74.5%**。
- **逐行口径**：`remain ≈ 1,896 + 1,046 = 2,942`，`done ≈ 4,479 / 7,421`，约 **60.4%**。
- 池外：`5,141 − 1,896 = 3,245`，永久不排期。
- 限定语：「句子级口径；逐行口径下另有约 1,046 行池内续行被判强、未排期」。

## 7. 守卫与产能

- `GUARD` 15 文件：`pre=4 post=4 新增=0 max=8` → **PASS**（pre 复用 `b327-guard-post.txt`）。
- `capacity-estimate --batch b328`：`done files=407 (+4) / lines=5,525 (+40)`，
  `REMAIN 600 files / 1,896 lines`，`ALIGNED acct_remain=1896 pool_remain=1896 diff=0`，分档合计 301 批；
  `PARTIAL 3` 不变（`cuaDetails.tsx:1`、`script-workflow-process.ts:1`、`CoveragePanel.tsx:2`）。
- `ledger-assert`：`407 + 600 = 1,007`、`5,525 + 1,896 = 7,421` → **PASS**（`ROLL` 144/658/802 全 0 剩余）。
- 白名单重跑到 `4f5bf021`，**433 行**（开批前 431 行 + 本批批次提交与开批白名单提交两条）。

## 8. 复算命令

```powershell
node _annot_baseline/cand-generic.mjs d:/code/_annot_baseline/b327-repo-post.txt
node _annot_baseline/pick-generic.mjs b328 d:/code/_annot_baseline/b328-files.txt d:/code/_annot_baseline/b327-repo-post.txt
node docs/annotation/_tools/own-commits-gen.mjs d:/code/ZCode
node _annot_baseline/gate-run.mjs --batch b328 --start
node _annot_baseline/judge-generic.mjs b328
node _annot_baseline/gate-run.mjs --batch b328 --subject "注释清水 b328：4 文件 1→1 改写"
node _annot_baseline/deep-quality.mjs d:/code/ZCode --root packages,apps,docs/knip --list-weak > _annot_baseline/b328-repo-post.txt
node _annot_baseline/deep-quality.mjs d:/code/ZCode --file-list d:/code/_annot_baseline/b254-802-files.txt --list-weak > _annot_baseline/b328-guard-post.txt
node d:/code/ZCode/docs/annotation/_tools/weak-guard.mjs --pre d:/code/_annot_baseline/b327-guard-post.txt --post d:/code/_annot_baseline/b328-guard-post.txt
node docs/annotation/_tools/capacity-estimate.mjs --repo d:/code/ZCode --weak d:/code/_annot_baseline/b328-repo-post.txt --pre-weak d:/code/_annot_baseline/b327-repo-post.txt --batch b328
```

## 9. 计时口径

| 读数 | 起点 | 终点 | 本批 | 每行 |
| --- | --- | --- | ---: | ---: |
| `total` | 上一提交（白名单 `7a64ff8b`，17:42:20） | 批次提交 `4f5bf021`（17:44:00） | 100.0s | 2.50s |
| `controllable` | `--start`（17:42:49） | 批次提交（17:44:00） | 71.0s | 1.78s |
| `批墙钟` | 本批最早可观测产物 `b328-files.txt`（17:42:40） | 台账提交 `c16972a4`（17:45:08） | 148s | 3.70s |

- `controllable` 含读码、写作、apply 与六道闸，不含选行与台账收口；**不是产能**，跨批只认 `批墙钟`。

## 10. 提交

| 内容 | 提交 | numstat |
| --- | --- | --- |
| 白名单（开批前，431 行） | `7a64ff8b` | 2 文件 |
| 批次本体（4 文件 1→1 改写） | `4f5bf021` | `+40/−40` |
| `ZC-deep-b328-rewrite.tsv` + 白名单 433 行 + 本台账 + INDEX 同步 | `c16972a4` | — |

- 收口判据：A1 `remain=1,896≠0`；A2 `5,525 + 1,896 = 7,421` 成立；A3 `ledger-assert PASS`；
  A4 `5,525 + 0 + 1,896 = 7,421` 成立。
