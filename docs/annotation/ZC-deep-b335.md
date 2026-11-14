# ZC-deep-b335

> 批次：b335 ｜ 33 行 / 4 文件 ｜ 提交 `e7354db1`
> 尺子：`deep-quality.mjs` v2.0（句子级口径）、`zc-commit-v13.mjs`、`precheck-assert.mjs`、`gate-run.mjs`（十一闸）

## 0. 漏跑 `--start` 的事故与恢复（本批唯一异常）

- 首轮直接写完 33 行才跑 `--subject`，`record` 闸按失败闭合拒绝：
  `PRECHECK FAIL 缺 b335-lines.json`（第 8 行门禁要求「替换前」逐行基准必须由 `--start` 实拍）。
- 处置：`git diff` 存成 `_tmp/b335.patch` → `git checkout --` 四个文件恢复批前树 →
  `--start` 重拍真实批前快照（`record_runs=2`）→ `git apply` 回放同一份 patch → `judge hits=0` → 六闸 PASS。
- 快照内容是真的批前树，未伪造；但本批 `t-start` 晚于首次落笔，**§9 的 `controllable` 不具可比性**，跨批只用 `批墙钟`。
- 教训：`--start` 必须紧跟 `pick-generic`，在打开任何文件之前。

## 1. 选行

| 文件 | 池内 | 池外 | 本批 | 批后 weak |
| --- | ---: | ---: | ---: | ---: |
| `packages/services/src/settings-sync/settingsSyncService.ts` | 9 | 1 | 9 | 1（上游） |
| `packages/services/src/bots/telegramChannelRuntime.ts` | 8 | 0 | 8 | 0 |
| `packages/shared/src/sqlite-migrations/runner.ts` | 8 | 0 | 8 | 0 |
| `packages/shared/src/zcode-protocol-v4/workflow-observation-display.ts` | 8 | 0 | 8 | 0 |
| **合计** | **33** | **1** | **33** | **1** |

- 池内 `upOut=0` 档本批最高只有 8 行/文件，4 文件上限 32，低于 33 下沿；
  因此取 `settingsSyncService.ts` 的 9 行档（`upOut=1`）。批后该文件仅剩 1 行上游 weak（`3123`，非本线），不计入 `done`。
- 9 + 8 × 3 = 33，落在 33–44 区间；`TALLY ownOut=0`、`planIn=33`。

## 2. 改动内容

- `settingsSyncService.ts`：`resolvePluginCandidateTargetRoot` 默认目标根、`as Record` 只影响类型、
  `selectedByDefault` 由 `importableCount > 0` 决定、串行让 `nameKey` 立即可见、
  `skipReason` 区分「已占用」与「同名」、`shouldScanCommands`/`shouldScanPlugins` 条件同 `shouldScanSkills`、
  命令分支只换 `buildCommandsDiscovery`、`markFirstRunPromptHandled` 的键与导入结果无关。
- `telegramChannelRuntime.ts`：`telegramProvider` 可缺省、`acquirePollingLock` 可替换、
  每轮重读 `readTelegramOffset`、`allowed_updates` 只订阅 `message`/`callback_query`、
  先构造 `runtime` 再 `runtimes.set`、`refresh` 走 `refreshQueue`、后台刷新吞错只记 `logger`、
  控制面暴露 `dispose`/`refresh`。
- `runner.ts`：`migrations` 清单缺失或表名非法直接 `throw`、按 `location` 串行而非 `db` 对象、
  前一个 `migrate` 失败不影响后一个、等 `admission` 后进 `migrateExclusive`、取不到 `location` 退化为不串行、
  `id` 与 `previousIds` 一起查、`applied.checksum` 与 `checksum(migration.sql)` 不等即抛、`appliedIds` 命中即不进 `pending`。
- `workflow-observation-display.ts`：`usageSchema` 五项必填、`phase.state` 四值、
  `enteredAt`/`exitedAt` 可选、计数用 `int().nonnegative()`、`waitCause` 只允许 `slot`/`backoff`、
  `workflowRunHealthSchema` 整体可选、`concurrency` 嵌套可选、`leftoverRunning` 用 `positive` 可选。

## 3. 门禁读数

```text
gate: PASS start     t-start=15:41:18Z pre-weak=b334-repo-post.txt（record_runs=2，见 §0）
gate: PASS scope     n=0 plan=33 allow=0 diff_old=33 diff_new=33 out_of_scope_edits=0
gate: PASS record    n=0 same=0 indent=0/0 mtime=0 drift=0 record_runs=2
gate: PASS verify    n=0 same=0 indent=0/0 mtime=0 drift=n/a record_runs=2 verify_ok=true
gate: PASS commit    n=0 sha=e7354db1 files=4/4 numstat=33/33 删代码=0 删上游=0 新增非注释=0 搬移=0 判据=0 嵌套=0 标点=0
gate: PASS pool-diff n=0 removed=33 added=0 allowed=40 auto_self_clear=0
gate: PASS order     total=229.0s controllable=51.0s
```

## 4. 首轮命中与返修

- 判据 **0 / 33**（首次 apply 与回放后各跑一次，均为 0）。
- 返修只有 §0 的流程性回退，无文案返工。

## 5. 自清（累计第 25 批无自清；本批 0 自动、0 人工）

- `removed=33`、`added=0`，与 plan 完全重合，`POOL-SELF-CLEAR.tsv` 无新增（`allowed=40`）。
- 本批 `auto_self_clear=0`。

## 6. 池外对账（两个口径）

- 全仓（句子级）weak：`post-b334 4,919` → `post-b335 4,886`（**−33**），文件 `1,745 → 1,742`。
- **句子级口径**：`done 5,779 / remain 1,642`，`5,779 + 1,642 = 7,421`，**77.9%**。
- **逐行口径**：`remain ≈ 1,642 + 1,046 = 2,688`，`done ≈ 4,733 / 7,421`，约 **63.8%**。
- 池外：`4,886 − 1,642 = 3,244`，永久不排期（含本批留下的 1 行上游 weak）。
- 限定语：「句子级口径；逐行口径下另有约 1,046 行池内续行被判强、未排期」。

## 7. 守卫与产能

- `GUARD` 15 文件：`pre=4 post=4 新增=0 max=8` → **PASS**（pre 复用 `b334-guard-post.txt`）。
- `capacity-estimate --batch b335`：`done files=435 (+4) / lines=5,779 (+33)`，
  `REMAIN 572 files / 1,642 lines`，`ALIGNED acct_remain=1642 pool_remain=1642 diff=0`，分档合计 287 批；
  `PARTIAL 3` 不变（`cuaDetails.tsx:1`、`script-workflow-process.ts:1`、`CoveragePanel.tsx:2`）。
- `ledger-assert`：`435 + 572 = 1,007`、`5,779 + 1,642 = 7,421` → **PASS**。
- 白名单重跑到 `e7354db1`，**461 行**（开批前 459 行 + 本批两条）。

## 8. 复算命令

```powershell
node _annot_baseline/cand-generic.mjs d:/code/_annot_baseline/b334-repo-post.txt
node _annot_baseline/pick-generic.mjs b335 d:/code/_annot_baseline/b335-files.txt d:/code/_annot_baseline/b334-repo-post.txt
node _annot_baseline/gate-run.mjs --batch b335 --start          # 必须在改文件之前
node docs/annotation/_tools/own-commits-gen.mjs d:/code/ZCode
node _annot_baseline/judge-generic.mjs b335
node _annot_baseline/gate-run.mjs --batch b335 --subject "注释清水 b335：4 文件 1→1 改写"
node _annot_baseline/deep-quality.mjs d:/code/ZCode --root packages,apps,docs/knip --list-weak > _annot_baseline/b335-repo-post.txt
node _annot_baseline/deep-quality.mjs d:/code/ZCode --file-list d:/code/_annot_baseline/b254-802-files.txt --list-weak > _annot_baseline/b335-guard-post.txt
node d:/code/ZCode/docs/annotation/_tools/weak-guard.mjs --pre d:/code/_annot_baseline/b334-guard-post.txt --post d:/code/_annot_baseline/b335-guard-post.txt
node docs/annotation/_tools/capacity-estimate.mjs --repo d:/code/ZCode --weak d:/code/_annot_baseline/b335-repo-post.txt --pre-weak d:/code/_annot_baseline/b334-repo-post.txt --batch b335
```

## 9. 计时口径

| 读数 | 起点 | 终点 | 本批 | 每行 |
| --- | --- | --- | ---: | ---: |
| `total` | 上一提交（白名单 `60476845`） | 批次提交 `e7354db1` | 229.0s | 6.94s |
| `controllable` | `--start`（15:41:18，**重拍**） | 批次提交 | 51.0s | 1.55s |
| `批墙钟` | 本批最早可观测产物 `b335-files.txt`（23:39:02） | 台账提交 `98466fee`（23:58:19） | 1157s | 35.06s |

- 本批 `controllable` 因 §0 的重拍不具可比性；`total` 含回退与回放，也只作记账。

## 10. 提交

| 内容 | 提交 | numstat |
| --- | --- | --- |
| 白名单（开批前，459 行） | `60476845` | 2 文件 |
| 批次本体（4 文件 1→1 改写） | `e7354db1` | `+33/−33` |
| `ZC-deep-b335-rewrite.tsv` + 白名单 461 行 + 本台账 + INDEX 同步 | `98466fee` | — |

- 收口判据：A1 `remain=1,642≠0`；A2 `5,779 + 1,642 = 7,421` 成立；A3 `ledger-assert PASS`；
  A4 `5,779 + 0 + 1,642 = 7,421` 成立。
