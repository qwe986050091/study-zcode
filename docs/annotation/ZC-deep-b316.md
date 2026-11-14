# ZC-deep-b316

> 批次：b316 ｜ 44 行 / 4 文件（**浮动批规模 33–44 首次生效**） ｜ 提交 `a3c1ebf3`
> 尺子：`deep-quality.mjs` v2.0（句子级口径）、`zc-commit-v13.mjs`、`precheck-assert.mjs`、`gate-run.mjs`（十一闸）

## 0. 无自清、无越界

- `pool-diff` 首跑 `removed=44 added=0 allowed=49 auto_self_clear=0` PASS；`scope` 首跑 `out_of_scope_edits=0`。
- 本批起按 INDEX §6.1 的浮动规模取 4 文件 44 行（`11 × 4`），不再为凑 36 行退到 3 文件。
- 无 `SCOPE OUT`，故本批不需要判据分歧登记。

## 1. 选行

| 文件 | 池内 | 池外 | 本批 | 批后 weak |
| --- | ---: | ---: | ---: | ---: |
| `packages/ui/src/lib/shikiHighlighter.ts` | 11 | 0 | 11 | 0 |
| `packages/ui/src/onboarding/onboardingMeshRenderer.ts` | 11 | 0 | 11 | 0 |
| `packages/ui/src/workspace-file-tree/WorkspaceFileTree.tsx` | 11 | 0 | 11 | 0 |
| `packages/zcode-server-cli/src/ipc/controlServer.ts` | 11 | 0 | 11 | 0 |
| **合计** | **44** | **0** | **44** | **0** |

- 四个文件均 `ownOut=0 upOut=0`，本批后整文件清零；`11/11` 两档取 4 文件即 44 行，落在 33–44 上界。

## 2. 改动内容

- `shikiHighlighter.ts`：`foreground` / `background` 兜底、`bundledLanguageIds` 与 `bundledLanguageAliases`
  的构造、`PLAIN_TEXT_CODE_LANGUAGES` 短路、`FALLBACK_CODE_LANGUAGE` 回退、`highlighterCache` 的 Promise 复用。
- `onboardingMeshRenderer.ts`：`getContext("webgl")` 失败返回、shader / program 编译失败的逐级清理、
  返回对象只暴露 `draw` / `dispose`、尺寸上限与画布重设条件、`aspect` 取逻辑尺寸、`drawArrays` 顶点数、`dispose` 顺序。
- `WorkspaceFileTree.tsx`：`showScrollBottomMask` 的几何派生、`canOpenInFileManager` 的两来源、
  `useWorkspaceFileSearchResults` 的重算成本、`gitStatusAvailable` 翻转触发、`overflowAnchor: "none"`、
  `handleRefresh` 双刷新、`refreshInProgress` 与 `disabled` 的分离、`openInEditor` 返回同形、`handleDirectoryAction` 分流。
- `controlServer.ts`：`rm` / `mkdir` / `chmod(0o600)`、`removeListener("error")`、`closePromise` 单例、
  socket `error` 只销毁自身、`JsonLineDecoder.push` 失败回 `invalid-frame`、`void dispatch` 并发、
  `decoder.finish()` 校验残留帧、`writeResponse` 的 `parse` 与 `destroyed` / `writableEnded` 早退。

## 3. 门禁读数（十一闸）

```text
gate: PASS scope     n=0 plan=44 allow=0 diff_old=44 diff_new=44 out_of_scope_edits=0
gate: PASS record    n=0 same=0 indent=0/0 mtime=0 drift=0 record_runs=1
gate: PASS verify    n=0 same=0 indent=0/0 mtime=0 drift=n/a record_runs=1 verify_ok=true
gate: PASS commit    n=0 sha=a3c1ebf3 files=4/4 numstat=44/44 删代码=0 删上游=0 新增非注释=0 搬移=0 判据=0 嵌套=0 标点=0
gate: PASS pool-diff n=0 removed=44 added=0 allowed=49 auto_self_clear=0
gate: PASS order     n=0 total=138.0s controllable=114.0s
GATE ALL PASS batch=b316 sha=a3c1ebf3
```

- 十一闸首跑全绿，无补跑；`s/行 = 114.0 / 44 ≈ 2.59`。

## 4. 首轮命中与返修

- 首轮 **1 / 44 = 2.3%**，`--record` 前 Edit 直改，`record_runs=1`：
  - `onboardingMeshRenderer.ts:119` `L/无信息列举`：`drawArrays(gl.TRIANGLES, 0, 6)` 两个 ASCII 逗号 →
    改为「`drawArrays` 以 `gl.TRIANGLES` 与 6 个顶点做一次绘制」。

## 5. 自清（累计第 8 批无自清；本批 0 自动、0 人工）

- `removed=44`、`added=0`，消失集合与 plan 完全重合，`POOL-SELF-CLEAR.tsv` 无新增行。
- `capacity-estimate` 回读 `SELF-CLEAR n=44 可写桶 44 / 池外 0 / 上游桶 0 / 未解析 0`。
- `auto_self_clear` 仍未首次生效（b313–b316 连续 0）。

## 6. 池外对账（两个口径）

- 全仓（句子级）weak：`post-b315 5,646` → `post-b316 5,602`（**−44** = 本批落笔，无自清），文件 `1,810 → 1,806`。
- **句子级口径（工程完成度）**：`done 5,065 / remain 2,356`，`5,065 + 2,356 = 7,421`，**68.3%**。
- **逐行口径（自足性，并列观测）**：`remain ≈ 2,356 + 1,046 = 3,402`，`done ≈ 4,019 / 7,421`，**约 54.2%**。
- 池外：`5,602 − 2,356 = 3,246` 行，**永久不排期**。
- 限定语（凡引用完成度处必须同段出现）：
  「句子级口径；逐行口径下另有约 1,046 行池内续行被判强、未排期」。

## 7. 守卫与产能

- `GUARD` 15 文件：`pre=4 post=4 新增=0 max=8` → **PASS**。
- `capacity-estimate --batch b316`：`done files=363 (+4) / lines=5,065 (+44)`，
  `REMAIN 644 files / 2,356 lines`，`ALIGNED acct_remain=2356 pool_remain=2356 diff=0`，分档合计 323 批；
  `PARTIAL 3`（`cuaDetails.tsx` 1、`script-workflow-process.ts` 1、`CoveragePanel.tsx` 2）。
- `ledger-assert`：`ACCT files 363 + 644 = 1007`、`ACCT lines 5,065 + 2,356 = 7,421` → **PASS**。
- 白名单重跑到 `a3c1ebf3`，**387 行**。

## 8. 复算命令

```powershell
node _annot_baseline/cand-generic.mjs d:/code/_annot_baseline/b315-repo-post.txt > _annot_baseline/b316-candidates.txt
node _annot_baseline/pick-generic.mjs b316 d:/code/_annot_baseline/b316-files.txt d:/code/_annot_baseline/b315-repo-post.txt
node _annot_baseline/gate-run.mjs --batch b316 --start
node _annot_baseline/judge-generic.mjs b316
node _annot_baseline/gate-run.mjs --batch b316 --subject "注释清水 b316：4 文件 1→1 改写"
node _annot_baseline/deep-quality.mjs d:/code/ZCode --root packages,apps,docs/knip --list-weak > _annot_baseline/b316-repo-post.txt
node _annot_baseline/deep-quality.mjs d:/code/ZCode --file-list d:/code/_annot_baseline/b254-802-files.txt --list-weak > _annot_baseline/b316-guard-post.txt
node docs/annotation/_tools/weak-guard.mjs --pre d:/code/_annot_baseline/b315-guard-post.txt --post d:/code/_annot_baseline/b316-guard-post.txt
node docs/annotation/_tools/own-commits-gen.mjs d:/code/ZCode
node docs/annotation/_tools/capacity-estimate.mjs --repo d:/code/ZCode --weak d:/code/_annot_baseline/b316-repo-post.txt --pre-weak d:/code/_annot_baseline/b315-repo-post.txt --batch b316
node docs/annotation/_tools/ledger-assert.mjs d:/code/ZCode
```

## 9. 提交

| 内容 | 提交 | numstat |
| --- | --- | --- |
| 白名单 + b315 分歧记录 + INDEX §6.1（开批前） | `22bdbf2a` | 4 文件 |
| b316 批次本体（4 文件 1→1 改写） | `a3c1ebf3` | `+44/−44` |
| `ZC-deep-b316-rewrite.tsv` + 白名单 387 行 + 本台账 + INDEX 同步 | 见本批台账提交 | — |

- 收口判据：A1 `remain=2,356≠0` 未到；A2 `5,065 + 2,356 = 7,421` 成立；
  A3 `ledger-assert PASS`；A4 `5,065 落笔 + 0 池内自清 + 2,356 = 7,421` 成立。
- 后续：b317 按浮动规模继续，优先 4 文件 44 行。
