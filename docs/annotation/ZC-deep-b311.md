# ZC-deep-b311

> 批次：b311 ｜ 36 行 / 4 文件 ｜ 提交 `7f8a4bad`
> 尺子：`deep-quality.mjs` v2.0（句子级口径）、`zc-commit-v13.mjs`、`precheck-assert.mjs`、`gate-run.mjs`（十一闸）

## 0. 本轮前置：§12.4 三件事落盘（`7c139fa1`）+ 白名单（`6e16d727`）

1. **`SELF-CLEAR 提前量` 与 A4 写进 §12.4**：区分池内 / 池外自清，给出实测率与区间；
   收口判据由 A1–A3 扩为 **A1–A4**，A4 = `done 实际落笔 + Σ 池内自清 + remain == 7,421`，
   差值必须逐行对到 `POOL-SELF-CLEAR.tsv`，不许用「差 N 已知」放过。
2. **`ALIGNED` 里自清的处置写明**：`done` 是减法定义，自清在已登记文件内由同一份批后 `cur`
   同时改变两侧（`done` 加 / `remain` 减）；池内自清若落在**未登记文件**，`acct_remain` 取基线、
   `pool_remain` 取实测 → `DRIFT` + `exit 1`，不会悄悄不平。
3. 开批前重跑 `own-commits-gen.mjs` → **370 行**（`meta.head=7c139fa1e09d`），随白名单提交 `6e16d727`。

## 1. 选行

| 文件 | 池内 | 池外 own | 本批 | 批后 weak |
| --- | ---: | ---: | ---: | ---: |
| `apps/zcode-cli/packages/bootstrap/src/app/script-workflow-meta.ts` | 11 | 0 | 11 | 0 |
| `apps/zcode-cli/packages/core/src/mcp/app-tools.ts` | 11 | 2 | 11 | 0 |
| `packages/desktop/src/host/sourceServerManagementService.ts` | 11 | 1 | 11 | 0 |
| `apps/zcode-cli/packages/core/src/runtime/methods/usage-observability.ts` | 3 | 1 | 3 | 0 |
| **合计** | **36** | **4** | **36** | **0** |

- 池外 own 行共 4 条，**均未改**：`app-tools.ts:35/53`（`aac47556`）、
  `sourceServerManagementService.ts:354`（`e6ff6fab`）、`usage-observability.ts:99`（`c788b9f1`）。
- 其中 `354` 在本批收尾时从 weak 集合消失，按规则登记到 `POOL-SELF-CLEAR.tsv`（见 §5），不占配额。

## 2. 改动内容

- `script-workflow-meta.ts`：3 组（读文档、`stableHash`、meta 子进程求值）。
  补锚点：`resolve`、`maxBytes`、`SCRIPT_READ_MAX_BYTES`、`script.truncated`、
  `stableStringify`、`Object.keys`、`createHash`、`spawn`、`child.kill()`、`MAX_META_EVAL_OUTPUT_BYTES`。
- `app-tools.ts`：4 组（条目超时常量、条目构造、权限与风险、schema 归一）。
  超时写成「三段之和」并点名两个导入常量；权限写明 `readOnlyHint` 免审、`medium` 起步；
  透传写明 `args` / `toolCallId` / `abortSignal`。
- `sourceServerManagementService.ts`：4 组（目录增量、状态增量、一致性快照、profile 读取）+ 1 行删除语义。
  代际写成 `generation += 1` 与 `startGeneration === endGeneration` 双读；删除语义写成
  `onBeforeSourceServerRemoved` 缺失抛 `SourceServerRemovalError`。
- `usage-observability.ts`：3 处（用量事实写入、turn 级汇总、工具取消）。
  写明 `recordModelUsage`、`createModelUsageSummaryFromEvents`、`cancelled` 与 `error` 的分流。

## 3. 门禁读数（十一闸）

```text
gate: PASS start     n=0 t-start=2026-11-11T08:02:52.877Z
gate: PASS scope     n=0 plan=36 allow=0 diff_old=36 diff_new=36 out_of_scope_edits=0
gate: PASS record    n=0 same=0 indent=0/0 mtime=0 drift=0 record_runs=1
gate: PASS verify    n=0 same=0 indent=0/0 mtime=0 drift=n/a record_runs=1 verify_ok=true
gate: PASS commit    n=0 sha=7f8a4bad files=4/4 numstat=36/36 删代码=0 删上游=0 新增非注释=0 搬移=0 判据=0 嵌套=0 标点=0
gate: PASS pool-diff n=0 removed=37 added=0 allowed=39
gate: PASS order     n=0 total=0.0s controllable=53.0s
```

- **`pool-diff` 首跑判红**：`removed=37 / allowed=38`，多出的 1 行是未登记自清
  `packages/desktop/src/host/sourceServerManagementService.ts:354`（`e6ff6fab`，池外 own，本批未改）。
  登记后 `--from pool-diff --sha 7f8a4bad` 补跑 → `removed=37 added=0 allowed=39` PASS。
  **commit 在首跑时已落盘**（`7f8a4bad`），补跑只重验后两道闸，未重提交。
- **`order` 的重跑读数失真**：补跑时 `prev` 默认取 HEAD，恰好就是本批提交，所以 `total=0.0s`。
  真实墙钟为上一提交 `6e16d727`（16:01:09）→ `7f8a4bad`（16:03:45）= **156.0s**；
  `controllable=53.0s`（`t-start 08:02:52.877Z` → commit `08:03:45Z`），`s/行 = 53.0 / 36 ≈ 1.47`。

## 4. 首轮命中与返修

- 首轮预判据 **3 / 36 = 8.3%**，全部在 `app-tools.ts`：
  - `:38` `W/单行无信息`（`MCP_APP_PROVIDED_TOOL_ENTRY_TIMEOUT_MS 只是条目级兜底…` 原句无 ASCII 标识符）→ 补常量名；
  - `:39` `W/单行无信息`（原句只有「该常量」）→ 改为 `export` 供上层对齐；
  - `:74` `L/无信息列举`（两个逗号、无谓词）→ 改「风险等级**必须**至少 medium」补谓词。
- 在 `--record` 之前用 Edit 直改，所以 `record_runs=1`、`write_phase 3 / record_phase 0`。

## 5. 自清（累计第 3 次，仍为池外）

`pool-diff` 首跑 `removed=37` 中，36 行是本批登记行，第 37 行是
**`packages/desktop/src/host/sourceServerManagementService.ts:354`（blame `e6ff6fab`，池外 own）**。

- 该行本批未改；它与 353 行同属一个「失败语义」短句组，355 行由无锚点短句改成带 `removeSourceServer`
  的整句后，354 与之同组判定时锚点成立，不再单独判弱。
- 已写入 `POOL-SELF-CLEAR.tsv`（`b311` / `e6ff6fab` / `out-of-pool`），
  `capacity-estimate` 回读 `SELF-CLEAR n=1 可写桶 0 / 池外 1 / 上游桶 0 / 未解析 0`，**不扣配额**。

## 6. 池外对账（两个口径）

- 全仓（句子级）weak：`post-b310 5,823` → `post-b311 5,786`（**−37** = 36 批内 + 1 自清），
  文件 `1,819 → 1,817`（−2）。
- **句子级口径（工程完成度）**：`done 4,883 / remain 2,538`，`4,883 + 2,538 = 7,421`，**65.8%**。
- **逐行口径（自足性，并列观测）**：`remain ≈ 2,538 + 1,046 = 3,584`，
  `done ≈ 3,837 / 7,421`，**约 51.7%**。两个数回答不同问题，不可互相替代。
- 池外：`5,786 − 2,538 = 3,248` 行，**永久不排期**，只作外部观测。
- 限定语（凡引用完成度处必须同段出现）：
  「句子级口径；逐行口径下另有约 1,046 行池内续行被判强、未排期」。

## 7. 守卫与产能

- `GUARD` 15 文件：`pre=4 post=4 新增=0 max=8` → **PASS**。
- `capacity-estimate --batch b311`：`done files=345 (+4) / lines=4,883 (+36)`，
  `REMAIN 662 files / 2,538 lines`，`ALIGNED acct_remain=2538 pool_remain=2538 diff=0`，分档合计 332 批；
  `PARTIAL 3`（`cuaDetails.tsx` 1、`script-workflow-process.ts` 1、`CoveragePanel.tsx` 2）。
- `SELF-CLEAR n=1`（`sourceServerManagementService.ts:354`，out-of-pool，累计 3 次全为池外）。
- `ledger-assert`：`ACCT files 345 + 662 = 1007`、`ACCT lines 4,883 + 2,538 = 7,421` → **PASS**。
- 白名单重跑到 `7f8a4bad`，**372 行**。

## 8. 复算命令

```powershell
node _annot_baseline/deep-quality.mjs d:/code/ZCode --root packages,apps,docs/knip --list-weak > _annot_baseline/b311-repo-post.txt
node _annot_baseline/pick-generic.mjs b311 _annot_baseline/b311-files.txt _annot_baseline/b310-repo-post.txt
node _annot_baseline/gate-run.mjs --batch b311 --start
node _annot_baseline/apply-run.mjs b311
node _annot_baseline/judge-generic.mjs b311
node _annot_baseline/gate-run.mjs --batch b311 --subject "注释清水 b311：4 文件 1→1 改写"
# 首跑 pool-diff 因未登记自清判红后：
node _annot_baseline/gate-run.mjs --batch b311 --from pool-diff --sha 7f8a4bad --subject "注释清水 b311：4 文件 1→1 改写"
node _annot_baseline/deep-quality.mjs d:/code/ZCode --file-list d:/code/_annot_baseline/b254-802-files.txt --list-weak > _annot_baseline/b311-guard-post.txt
node docs/annotation/_tools/weak-guard.mjs --pre d:/code/_annot_baseline/b310-guard-post.txt --post d:/code/_annot_baseline/b311-guard-post.txt
node docs/annotation/_tools/own-commits-gen.mjs d:/code/ZCode
node docs/annotation/_tools/capacity-estimate.mjs --repo d:/code/ZCode --weak d:/code/_annot_baseline/b311-repo-post.txt --pre-weak d:/code/_annot_baseline/b310-repo-post.txt --batch b311
node docs/annotation/_tools/ledger-assert.mjs d:/code/ZCode
```

## 9. 提交

| 内容 | 提交 | numstat |
| --- | --- | --- |
| INDEX §12.4 自清提前量与 A4 三数闭合 | `7c139fa1` | `+36/−2` |
| 白名单至 7c139fa1（开批前，370 行） | `6e16d727` | 2 文件 |
| b311 批次本体（4 文件 1→1 改写） | `7f8a4bad` | `+36/−36` |
| `ZC-deep-b311-rewrite.tsv` + `POOL-SELF-CLEAR.tsv` + 白名单 372 行 + 本台账 + INDEX 同步 | 见本批台账提交 | — |

- 收口判据：A1 `remain=2,538≠0` 未到；A2 `4,883 + 2,538 = 7,421` 成立；
  A3 `ledger-assert PASS`；A4 `4,883 落笔 + 0 池内自清 + 2,538 = 7,421` 成立。
- 后续：b312 起继续 36 行/批；约 b390 前后插 10 行 N/P 语义双读。
