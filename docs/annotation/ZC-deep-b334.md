# ZC-deep-b334

> 批次：b334 ｜ 33 行 / 4 文件 ｜ 提交 `51b11411`
> 尺子：`deep-quality.mjs` v2.0（句子级口径）、`zc-commit-v13.mjs`、`precheck-assert.mjs`、`gate-run.mjs`（十一闸）

## 0. 无自清、无越界；基准默认解析（未复制快照）

- `gate: PASS start ... pre-weak=b333-repo-post.txt`——基准由 `b{批号-1}` 默认规则解析，未复制任何快照。
- 六闸全部 PASS：`out_of_scope_edits=0`、`record_runs=1`、`numstat=33/33`、
  `pool-diff removed=33 added=0 allowed=40 auto_self_clear=0`。
- 判据首轮 1 hit（`L` 无信息列举），改写后 `hits=0`，见 §4。

## 1. 选行

| 文件 | 池内 | 池外 | 本批 | 批后 weak |
| --- | ---: | ---: | ---: | ---: |
| `packages/ui/src/v4/telemetry/useSessionOpenArmsTelemetry.ts` | 9 | 0 | 9 | 0 |
| `apps/zcode-cli/packages/adapters/src/exec/execution-command.ts` | 8 | 0 | 8 | 0 |
| `apps/zcode-cli/packages/cli/src/plugins-command-format.ts` | 8 | 0 | 8 | 0 |
| `packages/shared/src/cloudContent.ts` | 8 | 0 | 8 | 0 |
| **合计** | **33** | **0** | **33** | **0** |

- 四个文件 `upOut=0`，批后 weak 全清零；文件数 1,753 → 1,745。
- 9 + 8 × 3 = 33，落在 33–44 浮动区间下沿（候选池本批无 10–11 档）。

## 2. 改动内容

- `useSessionOpenArmsTelemetry.ts`：`SESSION_OPEN_TIMEOUT_MS` 触顶兜底结算、
  `now()` 取 `performance.now` 回退 `Date.now`、无 `requestAnimationFrame` 退化 `setTimeout`、
  `errorCodeFromMessage` 认 `fault.*` 与括号尾注、`runtime.finished` 幂等、
  `cold` 才带 `openTiming`、总耗时按 `now()` 单调差值夹零、
  `identity` 变化重建 `runtimeRef`、`resolvedOpenKind` 只影响归因。
- `execution-command.ts`：`buildExecutionEnv` 复制 `process.env` 不原地改、
  `overlay.base === "empty"` 跳过继承清洗、文本编码先于 `applyNetworkEgressEnv`、
  `unset` 先于 `set`、`setResolvedShellLoginMode` 只认 `shell === false` 且 `usesLoginShell`、
  命令行取 `args.at(-1)`、`useLoginShell` 决定保留 `-l`、`applyResolvedShellCommand` 保留 `-l` 只换末位。
- `plugins-command-format.ts`：`formatDiagnosticLines` 只拼接、`pluginId`/`path` 缺失不留空括号、
  格式串 `- [severity] pluginId code: message (path)`、`severity` 不本地化、
  `version`/`description` 缺省省略、`marketplaces` 空列表早退、无 `locator` 时输出 `kind`。
- `cloudContent.ts`：`class`/`style` 各限 512、`url` 禁 `username`/`password`、
  `cloudContentPayloadSchema` 顶层全量、`dialog.buttons` 上限 4、`actions` 上限 16、
  `button.id` 唯一、`button.actionId` 必须已声明、违规逐条 `addIssue`。

## 3. 门禁读数

```text
gate: PASS start     t-start=15:34:34Z pre-weak=b333-repo-post.txt
gate: PASS scope     n=0 plan=33 allow=0 diff_old=33 diff_new=33 out_of_scope_edits=0
gate: PASS record    n=0 same=0 indent=0/0 mtime=0 drift=0 record_runs=1
gate: PASS verify    n=0 same=0 indent=0/0 mtime=0 drift=n/a record_runs=1 verify_ok=true
gate: PASS commit    n=0 sha=51b11411 files=4/4 numstat=33/33 删代码=0 删上游=0 新增非注释=0 搬移=0 判据=0 嵌套=0 标点=0
gate: PASS pool-diff n=0 removed=33 added=0 allowed=40 auto_self_clear=0
gate: PASS order     total=153.0s controllable=125.0s
```

## 4. 首轮命中与返修

- 判据首轮 **1 / 33**：`plugins-command-format.ts:50`
  `// severity 原样输出，不做本地化，便于脚本匹配。` 判 `L 无信息列举`（三个逗号短句并列）。
  改为 `// severity 原样输出不做本地化，保持脚本可匹配。` 后 `hits=0`。
- 教训：「不做 X，便于 Y」这类三顿式中文即使每句都有信息，也会被并列判据抓住；并成两句最稳。

## 5. 自清（累计第 24 批无自清；本批 0 自动、0 人工）

- `removed=33`、`added=0`，与 plan 完全重合，`POOL-SELF-CLEAR.tsv` 无新增（`allowed=40`）。
- 本批 `auto_self_clear=0`。

## 6. 池外对账（两个口径）

- 全仓（句子级）weak：`post-b333 4,952` → `post-b334 4,919`（**−33**），文件 `1,749 → 1,745`。
- **句子级口径**：`done 5,746 / remain 1,675`，`5,746 + 1,675 = 7,421`，**77.4%**。
- **逐行口径**：`remain ≈ 1,675 + 1,046 = 2,721`，`done ≈ 4,700 / 7,421`，约 **63.3%**。
- 池外：`4,919 − 1,675 = 3,244`，永久不排期。
- 限定语：「句子级口径；逐行口径下另有约 1,046 行池内续行被判强、未排期」。

## 7. 守卫与产能

- `GUARD` 15 文件：`pre=4 post=4 新增=0 max=8` → **PASS**（pre 复用 `b333-guard-post.txt`）。
- `capacity-estimate --batch b334`：`done files=431 (+4) / lines=5,746 (+33)`，
  `REMAIN 576 files / 1,675 lines`，`ALIGNED acct_remain=1675 pool_remain=1675 diff=0`，分档合计 289 批；
  `PARTIAL 3` 不变（`cuaDetails.tsx:1`、`script-workflow-process.ts:1`、`CoveragePanel.tsx:2`）。
- `ledger-assert`：`431 + 576 = 1,007`、`5,746 + 1,675 = 7,421` → **PASS**。
- 白名单重跑到 `51b11411`，**457 行**（开批前 455 行 + 本批两条）。

## 8. 复算命令

```powershell
node _annot_baseline/cand-generic.mjs d:/code/_annot_baseline/b333-repo-post.txt
node _annot_baseline/pick-generic.mjs b334 d:/code/_annot_baseline/b334-files.txt d:/code/_annot_baseline/b333-repo-post.txt
node docs/annotation/_tools/own-commits-gen.mjs d:/code/ZCode
node _annot_baseline/gate-run.mjs --batch b334 --start
node _annot_baseline/judge-generic.mjs b334
node _annot_baseline/gate-run.mjs --batch b334 --subject "注释清水 b334：4 文件 1→1 改写"
node _annot_baseline/deep-quality.mjs d:/code/ZCode --root packages,apps,docs/knip --list-weak > _annot_baseline/b334-repo-post.txt
node _annot_baseline/deep-quality.mjs d:/code/ZCode --file-list d:/code/_annot_baseline/b254-802-files.txt --list-weak > _annot_baseline/b334-guard-post.txt
node d:/code/ZCode/docs/annotation/_tools/weak-guard.mjs --pre d:/code/_annot_baseline/b333-guard-post.txt --post d:/code/_annot_baseline/b334-guard-post.txt
node docs/annotation/_tools/capacity-estimate.mjs --repo d:/code/ZCode --weak d:/code/_annot_baseline/b334-repo-post.txt --pre-weak d:/code/_annot_baseline/b333-repo-post.txt --batch b334
```

## 9. 计时口径

| 读数 | 起点 | 终点 | 本批 | 每行 |
| --- | --- | --- | ---: | ---: |
| `total` | 上一提交（白名单 `81f1eb70`） | 批次提交 `51b11411` | 153.0s | 4.64s |
| `controllable` | `--start` | 批次提交 | 125.0s | 3.79s |
| `批墙钟` | 本批最早可观测产物 `b334-files.txt`（23:34:28） | 台账提交 `981e0661`（23:37:51） | 203s | 6.15s |

- `controllable` 含读码、写作、apply、返修与六道闸，不含选行与台账收口；**不是产能**，跨批只认 `批墙钟`。

## 10. 提交

| 内容 | 提交 | numstat |
| --- | --- | --- |
| 白名单（开批前，455 行） | `81f1eb70` | 2 文件 |
| 批次本体（4 文件 1→1 改写） | `51b11411` | `+33/−33` |
| `ZC-deep-b334-rewrite.tsv` + 白名单 457 行 + 本台账 + INDEX 同步 | `981e0661` | — |

- 收口判据：A1 `remain=1,675≠0`；A2 `5,746 + 1,675 = 7,421` 成立；A3 `ledger-assert PASS`；
  A4 `5,746 + 0 + 1,675 = 7,421` 成立。
