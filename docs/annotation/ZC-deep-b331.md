# ZC-deep-b331

> 批次：b331 ｜ 36 行 / 4 文件（另 1 行相邻自动自清）｜ 提交 `385da840`
> 尺子：`deep-quality.mjs` v2.0（句子级口径）、`zc-commit-v13.mjs`、`precheck-assert.mjs`、`gate-run.mjs`（十一闸）

## 0. 无越界；基准默认解析（未复制快照）；1 行相邻自动自清

- `gate: PASS start ... pre-weak=b330-repo-post.txt`——基准由 `b{批号-1}` 默认规则解析，未复制任何快照。
- 六闸全部 PASS：`out_of_scope_edits=0`、`record_runs=1`、`numstat=36/36`。
- `pool-diff removed=37 added=0 allowed=43 auto_self_clear=1`：多出的 1 行是
  `reminder.ts:228`（JSDoc 块尾 ` */`）。它不在 plan 内，但句元与 229–231 同判，
  改写后整句转强；blame 属上游 → 按规则④自动登记 `auto-out-of-pool`，人工 0 行。
- 首轮 `judge-generic` 即 `hits=0`；`git diff --stat` 始终 `36 insertions / 36 deletions`。

## 1. 选行

| 文件 | 池内 | 池外 | 本批 | 批后 weak |
| --- | ---: | ---: | ---: | ---: |
| `apps/zcode-cli/packages/core/src/plugin-reference/reminder.ts` | 9 | 0 | 9 | 0 |
| `packages/desktop/scripts/mcp-apps-host-fixture/sampling-extra-checks.ts` | 9 | 0 | 9 | 0 |
| `packages/server/src/source-server/sourceServerProbe.ts` | 9 | 0 | 9 | 0 |
| `packages/services/src/session/offPeakResidentExecutions.ts` | 9 | 0 | 9 | 0 |
| **合计** | **36** | **0** | **36** | **0** |

- 四个文件 `upOut=0`，批后 weak 全清零；文件数 1,761 → 1,757。
- 9 × 4 = 36，落在 33–44 浮动区间内。

## 2. 改动内容

- `reminder.ts`：`skill.source !== "plugin"` 与 `pluginName` 的一致性判据、`renderReminderBody` 四行结构、
  `JSON.stringify` 序列化、`capability metadata` 的定位声明、`Rules` 段落固定、
  `diagnostics`/`kept` 汇总位置、`references` 的四道检查顺序、
  `MAX_PLUGIN_REFERENCE_REMINDER_BYTES` 切片、`no_capabilities` 归类。
- `sampling-extra-checks.ts`：`request` 最小体（一条 `text`）、`scope`/`win` 各建一次、
  结束销毁 `win`、`check` 共用 `request`、工作区路径 `join(root, "sampling-extra-workspace")`、
  `env.agent.session` 作用域、`env.model.selection`、`page` 页面内执行、`sample` 返回 `Promise`。
- `sourceServerProbe.ts`：首行 `set +e`、`SOURCE_SERVER_PROBE_MARKER_PREFIX` 段标记、
  `includeReleaseIdentity` 开关、分号 `join` 串命令、
  `SOURCE_SERVER_MIN_GLIBC_VERSION` 低于即抛 `SourceServerProbeEnvironmentError`、
  `signal.aborted` 取消检查、只读命令、非零 `exitCode` 归类、`installed` 为假时提前返回。
- `offPeakResidentExecutions.ts`：`userOwned`/`terminal` 初始 `false`、`runs.set` 覆盖安全性、
  `renewalId` 严格递增与忽略条件、`undefined` 代次不装新票、`discarded`/`ticketDelivery` 作废判据、
  `deps.renew` 走同一续票入口、`cancel` 置 `userOwned`、`finish` 双条件、
  `runs` 移除后经 `disposed` 清理。

## 3. 门禁读数

```text
gate: PASS scope     n=0 plan=36 allow=0 diff_old=36 diff_new=36 out_of_scope_edits=0
gate: PASS record    n=0 same=0 indent=0/0 mtime=0 drift=0 record_runs=1
gate: PASS verify    n=0 same=0 indent=0/0 mtime=0 drift=n/a record_runs=1 verify_ok=true
gate: PASS commit    n=0 sha=385da840 files=4/4 numstat=36/36 删代码=0 删上游=0 新增非注释=0 搬移=0 判据=0 嵌套=0 标点=0
gate: PASS pool-diff n=0 removed=37 added=0 allowed=43 auto_self_clear=1
gate: PASS order     total=107.0s controllable=84.0s
```

## 4. 首轮命中与返修

- 首轮 **0 / 36**，无返修。

## 5. 自清（累计第 21 批无池内自清；本批 1 行自动、0 人工）

- `removed=37` = plan 36 + 相邻 1 行（`reminder.ts:228`）。
- 该行记入 `POOL-SELF-CLEAR.tsv`：`b331 / 872ad960… / auto-out-of-pool / reason=adjacent / auto`。
  这是 b325 之后的第二例自动自清，形态同为「块尾 ` */` 与相邻注释同判」。
- 池内自清仍为 **0**；`done` 的 36 行全部是本批实际落笔。

## 6. 池外对账（两个口径）

- 全仓（句子级）weak：`post-b330 5,061` → `post-b331 5,024`（**−37**），文件 `1,761 → 1,757`。
- **句子级口径**：`done 5,641 / remain 1,780`，`5,641 + 1,780 = 7,421`，**76.0%**。
- **逐行口径**：`remain ≈ 1,780 + 1,046 = 2,826`，`done ≈ 4,595 / 7,421`，约 **61.9%**。
- 池外：`5,024 − 1,780 = 3,244`，永久不排期。
- 限定语：「句子级口径；逐行口径下另有约 1,046 行池内续行被判强、未排期」。

## 7. 守卫与产能

- `GUARD` 15 文件：`pre=4 post=4 新增=0 max=8` → **PASS**（pre 复用 `b330-guard-post.txt`）。
- `capacity-estimate --batch b331`：`done files=419 (+4) / lines=5,641 (+36)`，
  `REMAIN 588 files / 1,780 lines`，`ALIGNED acct_remain=1780 pool_remain=1780 diff=0`，分档合计 295 批；
  `PARTIAL 3` 不变（`cuaDetails.tsx:1`、`script-workflow-process.ts:1`、`CoveragePanel.tsx:2`）。
- `ledger-assert`：`419 + 588 = 1,007`、`5,641 + 1,780 = 7,421` → **PASS**（`CLOSE`/`FILELIST` 同 PASS）。
- 白名单重跑到 `385da840`，**445 行**（开批前 443 行 + 本批批次提交与开批白名单提交两条）。

## 8. 复算命令

```powershell
node _annot_baseline/cand-generic.mjs d:/code/_annot_baseline/b330-repo-post.txt
node _annot_baseline/pick-generic.mjs b331 d:/code/_annot_baseline/b331-files.txt d:/code/_annot_baseline/b330-repo-post.txt
node docs/annotation/_tools/own-commits-gen.mjs d:/code/ZCode
node _annot_baseline/gate-run.mjs --batch b331 --start
node _annot_baseline/judge-generic.mjs b331
node _annot_baseline/gate-run.mjs --batch b331 --subject "注释清水 b331：4 文件 1→1 改写"
node _annot_baseline/deep-quality.mjs d:/code/ZCode --root packages,apps,docs/knip --list-weak > _annot_baseline/b331-repo-post.txt
node _annot_baseline/deep-quality.mjs d:/code/ZCode --file-list d:/code/_annot_baseline/b254-802-files.txt --list-weak > _annot_baseline/b331-guard-post.txt
node d:/code/ZCode/docs/annotation/_tools/weak-guard.mjs --pre d:/code/_annot_baseline/b330-guard-post.txt --post d:/code/_annot_baseline/b331-guard-post.txt
node docs/annotation/_tools/capacity-estimate.mjs --repo d:/code/ZCode --weak d:/code/_annot_baseline/b331-repo-post.txt --pre-weak d:/code/_annot_baseline/b330-repo-post.txt --batch b331
```

## 9. 计时口径

| 读数 | 起点 | 终点 | 本批 | 每行 |
| --- | --- | --- | ---: | ---: |
| `total` | 上一提交（白名单 `747e519c`，17:52:54） | 批次提交 `385da840`（17:54:41） | 107.0s | 2.97s |
| `controllable` | `--start`（17:53:17） | 批次提交（17:54:41） | 84.0s | 2.33s |
| `批墙钟` | 本批最早可观测产物 `b331-files.txt`（17:53:11） | 台账提交 `f2ee1ca2`（17:56:09） | 178s | 4.94s |

- `controllable` 含读码、写作、apply 与六道闸，不含选行与台账收口；**不是产能**，跨批只认 `批墙钟`。

## 10. 提交

| 内容 | 提交 | numstat |
| --- | --- | --- |
| 白名单（开批前，443 行） | `747e519c` | 2 文件 |
| 批次本体（4 文件 1→1 改写，4 文件 36 行） | `385da840` | `+36/−36` |
| `ZC-deep-b331-rewrite.tsv` + `POOL-SELF-CLEAR.tsv` + 白名单 445 行 + 本台账 + INDEX | `f2ee1ca2` | — |

- 收口判据：A1 `remain=1,780≠0`；A2 `5,641 + 1,780 = 7,421` 成立；A3 `ledger-assert PASS`；
  A4 `5,641 + 0 + 1,780 = 7,421` 成立。
