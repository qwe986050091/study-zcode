# ZC-deep-b337

> 批次：b337 ｜ 32 行 / 4 文件 ｜ 提交 `64929f17`
> 尺子：`deep-quality.mjs` v2.0（句子级口径）、`zc-commit-v13.mjs`、`precheck-assert.mjs`、`gate-run.mjs`（十一闸）

## 0. 本批只有 32 行（低于 33 下沿 1 行），原因与取舍

- `cand-generic` 在当前快照里**没有任何文件的可写行（`ownIn`）≥ 9**：全仓最高档就是 `ownIn=8`。
  4 文件 × 8 = 32，无论怎么挑都到不了 33。
- 可选的越界办法只有两个，都不合适：
  1) 加第 5 个文件 → 违反「每批 4 文件」的结构约束，`zc-commit` 的 `files=4/4` 也会失配；
  2) 顺手改 `own out` 行 → 正是 b336 §0 被 `scope` 拦下的那类越界，且会把上游 weak 算进本批。
- 取舍：**保 4 文件结构，接受 32 行**，并在本节记明「低于下沿 1 行」是快照上限所致，不是漏挑。
  `own out` 行 `useWorkflowRunSave.ts:136`（blame `aac47556`）保持原样，批后仍是上游 weak。

## 1. 选行

| 文件 | 池内 | 池外 | 本批 | 批后 weak |
| --- | ---: | ---: | ---: | ---: |
| `packages/ui/src/command-center/commandCenterSearchHistory.ts` | 8 | 0 | 8 | 0 |
| `packages/ui/src/lib/userActionTraceCatalog.ts` | 8 | 0 | 8 | 0 |
| `docs/knip/docs/scripts/get-monthly-sponsorships-github.ts` | 8 | 0 | 8 | 0 |
| `packages/ui/src/project-workflow/useWorkflowRunSave.ts` | 9 | 1 | 8 | 1（上游） |
| **合计** | **33** | **1** | **32** | **1** |

- `pick-generic` 读数：`TALLY ownIn=32 ownOut=0 upIn=0 upOut=1 pending=0 planIn=32`。
- 四个文件都是 `upOut=0` 档里可写行最多的；`useWorkflowRunSave.ts` 的池内 9 行里有 1 行是上游 blame，不可写。

## 2. 改动内容

- `commandCenterSearchHistory.ts`：上限由 `COMMAND_CENTER_HISTORY_LIMIT` 单点决定、
  `isCommandCenterSearchHistoryEntry` 做形状校验、`getStorage` 为 null 返回空数组、
  `filter` 后 `slice` 裁上限、写入前再 `slice` 防超长、`query` 为 `>`/`#`/`@` 时不写历史、
  `dedupeKey` 用 `toLocaleLowerCase`、`nextEntry` 置顶后整体裁剪。
- `userActionTraceCatalog.ts`：`keyof typeof CORE_USER_ACTION_FEATURES` 获得类型、
  `UserActionCatalogEntry` 五项字段、`operationKind` 用于告警分级、`surface` 取 `featureId`、
  `timeoutMs` 统一 `30_000`、`settings.` 前缀走 `preference`、`refresh_memory`/`import_browser_data` 归 `command`、
  `entriesFrom` 把 `Object.entries` 展平。
- `get-monthly-sponsorships-github.ts`：`token` 只读环境变量、`graphql` 用 `first: 100` + `period: ALL`、
  `activeRecurring` 按 `sponsor.login` 去重、`recurringOnly` 跳过 `isOneTime`、
  `NEW_SPONSORSHIP` 只累加 `monthYear`、`CANCELLED_SPONSORSHIP` 用 `delete` 不产生负数、
  `reduce` 重算总额、`startMonth`/`endMonth` 裁剪留在 `getGitHubTotals`。
- `useWorkflowRunSave.ts`：`generation` 变化强制重查、`setSaving(true)` 在 `await` 前、
  `result.ok` 时 `applySaved`、回填 `name`/`meta` 取 `input`、`finally` 复位 `saving`、
  `launchTarget` 优先于 `target`、`host.sessionId` 存在时 `resolveSessionDirectories` 补 `projectId`、
  结果收敛为 `{ ok }` 判别值。

## 3. 门禁读数

```text
gate: PASS start     t-start=2026-11-11T16:05:21.974Z pre-weak=b336-repo-post.txt
gate: PASS scope     n=0 plan=32 allow=0 diff_old=32 diff_new=32 out_of_scope_edits=0
gate: PASS record    n=0 same=0 indent=0/0 mtime=0 drift=0 record_runs=1
gate: PASS verify    n=0 same=0 indent=0/0 mtime=0 drift=n/a record_runs=1 verify_ok=true
gate: PASS commit    n=0 sha=64929f17 files=4/4 numstat=32/32 删代码=0 删上游=0 新增非注释=0 搬移=0 判据=0 嵌套=0 标点=0
gate: PASS pool-diff n=0 removed=32 added=0 allowed=39 auto_self_clear=0
gate: PASS order     total=138.0s controllable=112.0s
```

## 4. 首轮命中与返修

- 判据**首轮 0 hit**，无文案返修；也没有越界行。
- 唯一非零处置是 §0 的选行取舍（32 行），不涉及回退。

## 5. 自清（累计第 27 批无自清；本批 0 自动、0 人工）

- `removed=32`、`added=0`，与 plan 完全重合，`POOL-SELF-CLEAR.tsv` 无新增（`allowed=39`）。
- 本批 `auto_self_clear=0`。

## 6. 池外对账（两个口径）

- 全仓（句子级）weak：`post-b336 4,853` → `post-b337 4,821`（**−32**），文件 `1,739 → 1,736`。
- **句子级口径**：`done 5,844 / remain 1,577`，`5,844 + 1,577 = 7,421`，**78.7%**。
- **逐行口径**：`remain ≈ 1,577 + 1,046 = 2,623`，`done ≈ 4,798 / 7,421`，约 **64.7%**。
- 池外：`4,821 − 1,577 = 3,244`，永久不排期（含本批留下的 1 行上游 weak）。
- 限定语：「句子级口径；逐行口径下另有约 1,046 行池内续行被判强、未排期」。

## 7. 守卫与产能

- `GUARD` 15 文件：`pre=4 post=4 新增=0 max=8` → **PASS**（pre 复用 `b336-guard-post.txt`）。
- `capacity-estimate --batch b337`：`done files=443 (+4) / lines=5,844 (+32)`，
  `REMAIN 564 files / 1,577 lines`，`ALIGNED acct_remain=1577 pool_remain=1577 diff=0`，分档合计 283 批；
  `PARTIAL 3` 不变（`cuaDetails.tsx:1`、`script-workflow-process.ts:1`、`CoveragePanel.tsx:2`）。
- `ledger-assert`：`443 + 564 = 1,007`、`5,844 + 1,577 = 7,421` → **PASS**。
- 白名单重跑到 `64929f17`，**469 行**（开批前 467 行 + 本批两条）。

## 8. 复算命令

```powershell
node _annot_baseline/cand-generic.mjs d:/code/_annot_baseline/b336-repo-post.txt
node _annot_baseline/pick-generic.mjs b337 d:/code/_annot_baseline/b337-files.txt d:/code/_annot_baseline/b336-repo-post.txt
node _annot_baseline/gate-run.mjs --batch b337 --start          # 必须在改文件之前
node docs/annotation/_tools/own-commits-gen.mjs d:/code/ZCode
node _annot_baseline/judge-generic.mjs b337
node _annot_baseline/gate-run.mjs --batch b337 --subject "注释清水 b337：4 文件 1→1 改写"
node _annot_baseline/deep-quality.mjs d:/code/ZCode --root packages,apps,docs/knip --list-weak > _annot_baseline/b337-repo-post.txt
node _annot_baseline/deep-quality.mjs d:/code/ZCode --file-list d:/code/_annot_baseline/b254-802-files.txt --list-weak > _annot_baseline/b337-guard-post.txt
node d:/code/ZCode/docs/annotation/_tools/weak-guard.mjs --pre d:/code/_annot_baseline/b336-guard-post.txt --post d:/code/_annot_baseline/b337-guard-post.txt
node docs/annotation/_tools/capacity-estimate.mjs --repo d:/code/ZCode --weak d:/code/_annot_baseline/b337-repo-post.txt --pre-weak d:/code/_annot_baseline/b336-repo-post.txt --batch b337
```

## 9. 计时口径

| 读数 | 起点 | 终点 | 本批 | 每行 |
| --- | --- | --- | ---: | ---: |
| `total` | 上一提交（白名单 `7c2fbf9d`） | 批次提交 `64929f17` | 138.0s | 4.31s |
| `controllable` | `--start`（16:05:21.974Z） | 批次提交 | 112.0s | 3.50s |
| `批墙钟` | 本批最早可观测产物 `b337-files.txt`（00:05:15） | 台账提交 `28b0c9f3`（00:08:14） | 179s | 5.59s |

- 跨批比较只认 `批墙钟`；`total` / `controllable` 仅作本批记账。

## 10. 提交

| 内容 | 提交 | numstat |
| --- | --- | --- |
| 白名单（开批前，467 行） | `7c2fbf9d` | 2 文件 |
| 批次本体（4 文件 1→1 改写） | `64929f17` | `+32/−32` |
| `ZC-deep-b337-rewrite.tsv` + 白名单 469 行 + 本台账 + INDEX 同步 | `28b0c9f3` | — |

- 收口判据：A1 `remain=1,577≠0`；A2 `5,844 + 1,577 = 7,421` 成立；A3 `ledger-assert PASS`；
  A4 `5,844 + 0 + 1,577 = 7,421` 成立。
