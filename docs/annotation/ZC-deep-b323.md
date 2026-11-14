# ZC-deep-b323

> 批次：b323 ｜ 40 行 / 4 文件 ｜ 提交 `37ef235f`
> 尺子：`deep-quality.mjs` v2.0（句子级口径）、`zc-commit-v13.mjs`、`precheck-assert.mjs`、`gate-run.mjs`（十一闸）

## 0. 无自清、无越界；基准默认解析（未复制快照）

- `gate: PASS start ... pre-weak=b322-repo-post.txt`——基准由 `b{批号-1}` 默认规则解析，未复制任何快照。
- 十一闸全部首跑 PASS：`out_of_scope_edits=0`、`record_runs=1`、`numstat=40/40`、
  `pool-diff removed=40 added=0 allowed=45 auto_self_clear=0`。
- 起草阶段出现一次**越界苗头**：`generateTitleCandidateImpl` 上方三行注释里只登记了 164，
  首轮把 165/166 也一起改了；返修时先逐字还原 165/166，只保留 164 的改写，
  之后 `git diff --stat` 回到 `40 insertions / 40 deletions`，与 plan 全等。
  这是「按语义块改写」容易带出的邻行连带，`scope` 闸在本批是首跑前就已纠回，未判红。

## 1. 选行

| 文件 | 池内 | 池外 | 本批 | 批后 weak |
| --- | ---: | ---: | ---: | ---: |
| `apps/zcode-cli/packages/core/src/runtime/methods/title-generation-sidecar.ts` | 10 | 0 | 10 | 0 |
| `apps/zcode-cli/packages/core/src/tool/handlers/bash-readonly-policy-git-subcommands-core.ts` | 10 | 0 | 10 | 0 |
| `packages/shared/src/background-task-notifications.ts` | 10 | 0 | 10 | 0 |
| `packages/ui/src/v4/ConversationDraftEmptyState.tsx` | 10 | 0 | 10 | 0 |
| **合计** | **40** | **0** | **40** | **0** |

- 四个文件 `upOut=0`，批后 weak 全清零；文件数 1,790 → 1,786。
- 4 × 10 = 40 行，落在 33–44 浮动区间内。

## 2. 改动内容

- `title-generation-sidecar.ts`：`TitleModelContext` 三个字段的语义、借票的三项前置条件、
  标题选择缺省降级、`normalizeTitleInput` 的空白折叠与 `MAX_TITLE_INPUT_CHARS` 硬截断。
- `bash-readonly-policy-git-subcommands-core.ts`：`git cat-file` 的四个 `safeFlags` 键与 `--batch-check`、
  `git config --get` 的 key 前缀限定与四个作用域开关、`git log` 的 `GIT_LOG_SAFE_FLAGS` 覆盖范围、
  `git ls-files` 的索引/工作区查询与 `-x/-X`、`--recurse-submodules` 的只读性。
- `background-task-notifications.ts`：通知文本前缀判断、`tool-use-id` 必填、标签独立读取与实体解码、
  只扫 `role === "user"`、解析失败跳过、同一 `toolUseId` 覆盖顺序、`asPlainRecord` 的补全与空记录。
- `ConversationDraftEmptyState.tsx`：`date = new Date()` 默认参、分段函数首末分支闭合、
  连续 `if` 与查表的取舍、单定时点与 `setTimeout` 重挂、比例缩放的 `Math.floor`、
  `compactForRemoteControl` 早退、函数式 `setGreetingFontSizePx`、`useLayoutEffect` 测量、`aria-hidden`。

## 3. 门禁读数

```text
gate: PASS start     t-start=09:20:31Z pre-weak=b322-repo-post.txt
gate: PASS scope     n=0 plan=40 allow=0 diff_old=40 diff_new=40 out_of_scope_edits=0
gate: PASS record    n=0 same=0 indent=0/0 mtime=0 drift=0 record_runs=1
gate: PASS verify    n=0 same=0 indent=0/0 mtime=0 drift=n/a record_runs=1 verify_ok=true
gate: PASS commit    n=0 sha=37ef235f files=4/4 numstat=40/40 删代码=0 删上游=0 新增非注释=0 搬移=0 判据=0 嵌套=0 标点=0
gate: PASS pool-diff n=0 removed=40 added=0 allowed=45 auto_self_clear=0
gate: PASS order     total=128.0s controllable=121.0s
```

## 4. 首轮命中与返修

- 首轮 **5 / 40**：
  1. `background-task-notifications.ts:39` `W/单行无信息`——补标识 `readTaskNotificationTag`。
  2. `background-task-notifications.ts:104` `W/单行无信息`——补标识 `asPlainRecord`。
  3. `bash-readonly-policy-git-subcommands-core.ts:123` `W/单行无信息`——改为点名 `safeFlags` 与 `"none"`。
  4. `ConversationDraftEmptyState.tsx:314` `L/无信息列举`——删去第二个 `，`，只留 `aria-hidden` 一处信息。
  5. `title-generation-sidecar.ts:316` `W/单行无信息`——先写 `/\s+/g` 仍不够，改为 `replace(/\s+/g, " ")` 后归零。
- 同时修正 165/166 的连带改写（见 §0）。返修后 `hits=0`，`record → verify → commit` 全绿，`numstat=40/40`。

## 5. 自清（累计第 14 批无自清；本批 0 自动、0 人工）

- `removed=40`、`added=0`，与 plan 完全重合，`POOL-SELF-CLEAR.tsv` 无新增（`allowed=40 + 5 = 45`）。
- `auto_self_clear` 仍未首次生效（b313–b323 连续 0）。

## 6. 池外对账（两个口径）

- 全仓（句子级）weak：`post-b322 5,384` → `post-b323 5,344`（**−40**），文件 `1,790 → 1,786`。
- **句子级口径**：`done 5,323 / remain 2,098`，`5,323 + 2,098 = 7,421`，**71.7%**。
- **逐行口径**：`remain ≈ 2,098 + 1,046 = 3,144`，`done ≈ 4,277 / 7,421`，约 **57.6%**。
- 池外：`5,344 − 2,098 = 3,246`，永久不排期。
- 限定语：「句子级口径；逐行口径下另有约 1,046 行池内续行被判强、未排期」。

## 7. 守卫与产能

- `GUARD` 15 文件：`pre=4 post=4 新增=0 max=8` → **PASS**（pre 复用 `b322-guard-post.txt`）。
- `capacity-estimate --batch b323`：`done files=387 (+4) / lines=5,323 (+40)`，
  `REMAIN 620 files / 2,098 lines`，`ALIGNED acct_remain=2098 pool_remain=2098 diff=0`，分档合计 311 批；
  `PARTIAL 3` 不变（`cuaDetails.tsx:1`、`script-workflow-process.ts:1`、`CoveragePanel.tsx:2`）。
- `ledger-assert`：`387 + 620 = 1,007`、`5,323 + 2,098 = 7,421` → **PASS**。
- 白名单重跑到 `37ef235f`，**413 行**。

## 8. 复算命令

```powershell
node _annot_baseline/cand-generic.mjs d:/code/_annot_baseline/b322-repo-post.txt
node _annot_baseline/pick-generic.mjs b323 d:/code/_annot_baseline/b323-files.txt d:/code/_annot_baseline/b322-repo-post.txt
node docs/annotation/_tools/own-commits-gen.mjs d:/code/ZCode
node _annot_baseline/gate-run.mjs --batch b323 --start
node _annot_baseline/judge-generic.mjs b323
node _annot_baseline/gate-run.mjs --batch b323 --subject "注释清水 b323：4 文件 1→1 改写"
node _annot_baseline/deep-quality.mjs d:/code/ZCode --root packages,apps,docs/knip --list-weak > _annot_baseline/b323-repo-post.txt
node _annot_baseline/deep-quality.mjs d:/code/ZCode --file-list d:/code/_annot_baseline/b254-802-files.txt --list-weak > _annot_baseline/b323-guard-post.txt
node docs/annotation/_tools/weak-guard.mjs --pre d:/code/_annot_baseline/b322-guard-post.txt --post d:/code/_annot_baseline/b323-guard-post.txt
node docs/annotation/_tools/capacity-estimate.mjs --repo d:/code/ZCode --weak d:/code/_annot_baseline/b323-repo-post.txt --pre-weak d:/code/_annot_baseline/b322-repo-post.txt --batch b323
```

## 9. 计时口径

| 读数 | 起点 | 终点 | 本批 | 每行 |
| --- | --- | --- | ---: | ---: |
| `total` | 上一提交（白名单 `7dfc6f59`，17:20:24） | 批次提交 `37ef235f`（17:22:32） | 128.0s | 3.20s |
| `controllable` | `--start`（17:20:31） | 批次提交（17:22:32） | 121.0s | 3.03s |
| `批墙钟` | 本批最早可观测产物 `b323-files.txt`（17:20:14；选行调用略早，故此值为下限） | 台账提交 `16715463`（17:23:53） | 219s | 5.48s |

- `controllable` 含读码、写作、apply 与六道闸，不含选行与台账收口；**不是产能**，跨批只认 `批墙钟`。

## 10. 提交

| 内容 | 提交 | numstat |
| --- | --- | --- |
| 白名单（开批前，411 行） | `7dfc6f59` | 2 文件 |
| 批次本体（4 文件 1→1 改写） | `37ef235f` | `+40/−40` |
| `ZC-deep-b323-rewrite.tsv` + 白名单 413 行 + 本台账 + INDEX 同步 | 见本批台账提交 | — |

- 收口判据：A1 `remain=2,098≠0`；A2 `5,323 + 2,098 = 7,421` 成立；A3 `ledger-assert PASS`；
  A4 `5,323 + 0 + 2,098 = 7,421` 成立。
