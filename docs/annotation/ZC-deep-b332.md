# ZC-deep-b332

> 批次：b332 ｜ 36 行 / 4 文件 ｜ 提交 `f3256982`
> 尺子：`deep-quality.mjs` v2.0（句子级口径）、`zc-commit-v13.mjs`、`precheck-assert.mjs`、`gate-run.mjs`（十一闸）

## 0. 无自清、无越界；基准默认解析（未复制快照）

- `gate: PASS start ... pre-weak=b331-repo-post.txt`——基准由 `b{批号-1}` 默认规则解析，未复制任何快照。
- 六闸全部 PASS：`out_of_scope_edits=0`、`record_runs=1`、`numstat=36/36`、
  `pool-diff removed=36 added=0 allowed=43 auto_self_clear=0`。
- 首轮 `judge-generic` 即 `hits=0`；中途发现一次越界（多改了 `command-metadata.ts:53`，
  `diff_old=37`），已回退该行，`git diff --stat` 回到 `36 insertions / 36 deletions` 后才过闸。

## 1. 选行

| 文件 | 池内 | 池外 | 本批 | 批后 weak |
| --- | ---: | ---: | ---: | ---: |
| `packages/shared/src/browser-use/command-metadata.ts` | 9 | 0 | 9 | 0 |
| `packages/ui/src/AssistantCodeCommentCards.tsx` | 9 | 0 | 9 | 0 |
| `packages/ui/src/BotsDialog/BoundGroupsCard.tsx` | 9 | 0 | 9 | 0 |
| `packages/ui/src/GitPane.tsx` | 9 | 0 | 9 | 0 |
| **合计** | **36** | **0** | **36** | **0** |

- 四个文件 `upOut=0`，批后 weak 全清零；文件数 1,757 → 1,753。
- 9 × 4 = 36，落在 33–44 浮动区间内（本批候选池最大只有 9 行/文件，无 10–11 档）。

## 2. 改动内容

- `command-metadata.ts`：`minWidth`/`maxWidth` 与 `minHeight`/`maxHeight` 成对、
  `browserViewportSizeSchema.extend` 的范围继承、`int`/`positive` 归属、
  `setViewportSize` 只校验入参、`Browser tab` 的人类偏好限定、`mode` 决定 `responsive`、
  `strict()` 拒绝多余字段、`BrowserCommand.method` 判别、两端共享枚举、新增命令同步分派表。
- `AssistantCodeCommentCards.tsx`：`[P{priority}]` 形态前缀、`title.trimStart`、
  `displayTitle` 纯函数、`visibleCards === cards` 全量、`isOpen` 才 `map`、
  `card.startLine`/`endLine` 的区间拼接与 `displayPath` 退化。
- `BoundGroupsCard.tsx`：`row.sessionId` 作 key、CSS 截断 + `title` 全文、
  `Switch.checked` 由行数据决定、`saving` 时整列 `disabled`、
  `loading`/空态/`error` 的互斥与优先级、`bot.enabled` 说明、`error` 旁的 `reload`、
  组件不自行 `fetch` 而经 `useBotBoundGroups`。
- `GitPane.tsx`：`datasets` 缺 `currentSourceOption.id` 时回落 `unstaged`、
  `selectedSourceId` 不被回落改写、`loadDiffForChange` 幂等与调用方免判重、
  预加载遍历 `currentChanges`、`fileChangeFindState.total` 变化即上报、
  `activeFileChangeFindMatch` 为空不展开、`requestId` 唯一触发器。

## 3. 门禁读数

```text
gate: PASS start     t-start=15:25:45Z pre-weak=b331-repo-post.txt
gate: PASS scope     n=0 plan=36 allow=0 diff_old=36 diff_new=36 out_of_scope_edits=0
gate: PASS record    n=0 same=0 indent=0/0 mtime=0 drift=0 record_runs=1
gate: PASS verify    n=0 same=0 indent=0/0 mtime=0 drift=n/a record_runs=1 verify_ok=true
gate: PASS commit    n=0 sha=f3256982 files=4/4 numstat=36/36 删代码=0 删上游=0 新增非注释=0 搬移=0 判据=0 嵌套=0 标点=0
gate: PASS pool-diff n=0 removed=36 added=0 allowed=43 auto_self_clear=0
gate: PASS order     total=149.0s controllable=92.0s
```

## 4. 首轮命中与返修

- 判据首轮 **0 / 36**。
- 但 apply 阶段多写了一行：`command-metadata.ts:53`（`整数与正数继承自基础 schema。`）
  本来不在 plan 内，被我一并改成 `int 与 positive 继承自基础 schema。`，`git diff --stat` 暴露 37 行。
  已逐字还原该行，重跑 `judge-generic` 仍 `hits=0`，`scope` 回到 `diff_old=36`。
- 教训：三行连写时不能顺手把中间一行也改掉；批前必须先比对 `plan` 行号集合。

## 5. 自清（累计第 22 批无自清；本批 0 自动、0 人工）

- `removed=36`、`added=0`，与 plan 完全重合，`POOL-SELF-CLEAR.tsv` 无新增（`allowed=43`）。
- 本批 `auto_self_clear=0`。

## 6. 池外对账（两个口径）

- 全仓（句子级）weak：`post-b331 5,024` → `post-b332 4,988`（**−36**），文件 `1,757 → 1,753`。
- **句子级口径**：`done 5,677 / remain 1,744`，`5,677 + 1,744 = 7,421`，**76.5%**。
- **逐行口径**：`remain ≈ 1,744 + 1,046 = 2,790`，`done ≈ 4,631 / 7,421`，约 **62.4%**。
- 池外：`4,988 − 1,744 = 3,244`，永久不排期。
- 限定语：「句子级口径；逐行口径下另有约 1,046 行池内续行被判强、未排期」。

## 7. 守卫与产能

- `GUARD` 15 文件：`pre=4 post=4 新增=0 max=8` → **PASS**（pre 复用 `b331-guard-post.txt`）。
- `capacity-estimate --batch b332`：`done files=423 (+4) / lines=5,677 (+36)`，
  `REMAIN 584 files / 1,744 lines`，`ALIGNED acct_remain=1744 pool_remain=1744 diff=0`，分档合计 293 批；
  `PARTIAL 3` 不变（`cuaDetails.tsx:1`、`script-workflow-process.ts:1`、`CoveragePanel.tsx:2`）。
- `ledger-assert`：`423 + 584 = 1,007`、`5,677 + 1,744 = 7,421` → **PASS**。
- 白名单重跑到 `f3256982`，**449 行**（开批前 447 行 + 本批批次提交与开批白名单提交两条）。

## 8. 复算命令

```powershell
node _annot_baseline/cand-generic.mjs d:/code/_annot_baseline/b331-repo-post.txt
node _annot_baseline/pick-generic.mjs b332 d:/code/_annot_baseline/b332-files.txt d:/code/_annot_baseline/b331-repo-post.txt
node docs/annotation/_tools/own-commits-gen.mjs d:/code/ZCode
node _annot_baseline/gate-run.mjs --batch b332 --start
node _annot_baseline/judge-generic.mjs b332
node _annot_baseline/gate-run.mjs --batch b332 --subject "注释清水 b332：4 文件 1→1 改写"
node _annot_baseline/deep-quality.mjs d:/code/ZCode --root packages,apps,docs/knip --list-weak > _annot_baseline/b332-repo-post.txt
node _annot_baseline/deep-quality.mjs d:/code/ZCode --file-list d:/code/_annot_baseline/b254-802-files.txt --list-weak > _annot_baseline/b332-guard-post.txt
node d:/code/ZCode/docs/annotation/_tools/weak-guard.mjs --pre d:/code/_annot_baseline/b331-guard-post.txt --post d:/code/_annot_baseline/b332-guard-post.txt
node docs/annotation/_tools/capacity-estimate.mjs --repo d:/code/ZCode --weak d:/code/_annot_baseline/b332-repo-post.txt --pre-weak d:/code/_annot_baseline/b331-repo-post.txt --batch b332
```

## 9. 计时口径

| 读数 | 起点 | 终点 | 本批 | 每行 |
| --- | --- | --- | ---: | ---: |
| `total` | 上一提交（白名单 `adbee2b9`，23:24:48） | 批次提交 `f3256982`（23:27:17） | 149.0s | 4.14s |
| `controllable` | `--start`（23:25:45） | 批次提交（23:27:17） | 92.0s | 2.56s |
| `批墙钟` | 本批最早可观测产物 `b332-files.txt`（23:25:38） | 台账提交 `efd81da2`（23:28:18） | 160s | 4.44s |

- `controllable` 含读码、写作、apply、返修与六道闸，不含选行与台账收口；**不是产能**，跨批只认 `批墙钟`。

## 10. 提交

| 内容 | 提交 | numstat |
| --- | --- | --- |
| 白名单（开批前，447 行） | `adbee2b9` | 2 文件 |
| 批次本体（4 文件 1→1 改写） | `f3256982` | `+36/−36` |
| `ZC-deep-b332-rewrite.tsv` + 白名单 449 行 + 本台账 + INDEX 同步 | `efd81da2` | — |

- 收口判据：A1 `remain=1,744≠0`；A2 `5,677 + 1,744 = 7,421` 成立；A3 `ledger-assert PASS`；
  A4 `5,677 + 0 + 1,744 = 7,421` 成立。
