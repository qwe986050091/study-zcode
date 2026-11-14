# ZC-deep-b318

> 批次：b318 ｜ 44 行 / 4 文件 ｜ 提交 `3e2eef86`
> 尺子：`deep-quality.mjs` v2.0（句子级口径）、`zc-commit-v13.mjs`、`precheck-assert.mjs`、`gate-run.mjs`（十一闸）

## 0. 无自清、无越界

- `scope` 首跑 `out_of_scope_edits=0`；`pool-diff` 首跑 `removed=44 added=0 allowed=49 auto_self_clear=0` PASS。
- 无 `SCOPE OUT`，本批不需要判据分歧登记。

## 1. 选行

| 文件 | 池内 | 池外 | 本批 | 批后 weak |
| --- | ---: | ---: | ---: | ---: |
| `packages/ui/src/components/ui/lightweight-diff-preview.tsx` | 11 | 0 | 11 | 0 |
| `packages/ui/src/feedback/FeedbackCenter.tsx` | 11 | 0 | 11 | 0 |
| `packages/ui/src/hooks/useWorkspaceProviderConfigFile.ts` | 11 | 0 | 11 | 0 |
| `packages/ui/src/project-sidebar/useProjectTaskNavigation.ts` | 11 | 0 | 11 | 0 |
| **合计** | **44** | **0** | **44** | **0** |

- 四个文件均 `ownOut=0 upOut=0`，本批后整文件清零；按 §6.1 浮动规模取 4 × 11 = 44 行。

## 2. 改动内容

- `lightweight-diff-preview.tsx`：`LightweightDiffLineKind` 三态、`context` 的 `marker` 空串、
  `parseLightweightDiffLines` 的无缓存、`rowStyle` / `gutterStyle` 与 `--color-diff-*` 同源、
  双层滚动容器分工、`parseTruncatedMarkerOmittedLineCount` 先于内容识别、`sticky` 行号列、`showLineNumbers` 关闭时整列不渲染。
- `FeedbackCenter.tsx`：`memo` 包装、`feedbackService` 缺失返回 `null`、三处 store 取值、
  `titleId` 与返回按钮的 `tab === "tickets"` 分支、`XIcon` 自绘关闭、上传指示器的 `feedbackDialogOpen`、
  `FeatureRequestDialog` 兄弟节点、`submissionJobId` 作 key、成功切票单页、`DialogContent` 视口高度约束。
- `useWorkspaceProviderConfigFile.ts`：`getErrorMessage` 的 `message` → `name` → `String(error)` 三级、
  `INITIAL_STATE` 三字段初值、`configuredServiceScope` 的分派、`baseZCodeService` 未就绪返回 `null`、
  本地回退、`resolveWorkspaceProviderConfigZCodeService` 作为唯一分派点。
- `useProjectTaskNavigation.ts`：`useCallback` 稳定引用、`latest.current` 快照、`sequence.current++` 作废、
  `isCurrent` 的三段比较、`identity` 的本工作区校验、`webRemoteControlWorkspaceSwitcher` 优先、
  `openWebRemoteControlTask` 前读 `tree` 确认 host、连接前复核 `isCurrent()`。

## 3. 门禁读数（十一闸）

```text
gate: PASS scope     n=0 plan=44 allow=0 diff_old=44 diff_new=44 out_of_scope_edits=0
gate: PASS record    n=0 same=0 indent=0/0 mtime=0 drift=0 record_runs=1
gate: PASS verify    n=0 same=0 indent=0/0 mtime=0 drift=n/a record_runs=1 verify_ok=true
gate: PASS commit    n=0 sha=3e2eef86 files=4/4 numstat=44/44 删代码=0 删上游=0 新增非注释=0 搬移=0 判据=0 嵌套=0 标点=0
gate: PASS pool-diff n=0 removed=44 added=0 allowed=49 auto_self_clear=0
gate: PASS order     n=0 total=75.0s controllable=68.0s
GATE ALL PASS batch=b318 sha=3e2eef86
```

- 十一闸首跑全绿，无补跑。
- 计时按 §10（INDEX §6.2）口径：`total=75.0s`（白名单提交 → 批次提交）、
  `controllable=68.0s`（`--start` → 批次提交）、`批墙钟 = 158.0s`（16:47:24 → 台账提交 16:50:02）。
  `68.0 / 44 ≈ 1.55 s/行` 只是闸内段，**不是产能**；端到端 `158.0 / 44 ≈ 3.59 s/行`。

## 4. 首轮命中与返修

- 首轮 **0 / 44 = 0.0%**，`record_runs=1`，无返修。

## 5. 自清（累计第 10 批无自清；本批 0 自动、0 人工）

- `removed=44`、`added=0`，消失集合与 plan 完全重合，`POOL-SELF-CLEAR.tsv` 无新增行。
- `capacity-estimate` 回读 `SELF-CLEAR n=44 可写桶 44 / 池外 0 / 上游桶 0 / 未解析 0`。
- `auto_self_clear` 仍未首次生效（b313–b318 连续 0）。

## 6. 池外对账（两个口径）

- 全仓（句子级）weak：`post-b317 5,558` → `post-b318 5,514`（**−44** = 本批落笔，无自清），文件 `1,802 → 1,798`。
- **句子级口径（工程完成度）**：`done 5,153 / remain 2,268`，`5,153 + 2,268 = 7,421`，**69.4%**。
- **逐行口径（自足性，并列观测）**：`remain ≈ 2,268 + 1,046 = 3,314`，`done ≈ 4,107 / 7,421`，**约 55.3%**。
- 池外：`5,514 − 2,268 = 3,246` 行，**永久不排期**。
- 限定语（凡引用完成度处必须同段出现）：
  「句子级口径；逐行口径下另有约 1,046 行池内续行被判强、未排期」。

## 7. 守卫与产能

- `GUARD` 15 文件：`pre=4 post=4 新增=0 max=8` → **PASS**。
- `capacity-estimate --batch b318`：`done files=371 (+4) / lines=5,153 (+44)`，
  `REMAIN 636 files / 2,268 lines`，`ALIGNED acct_remain=2268 pool_remain=2268 diff=0`，分档合计 319 批；
  `PARTIAL 3`（`cuaDetails.tsx` 1、`script-workflow-process.ts` 1、`CoveragePanel.tsx` 2）。
- `ledger-assert`：`ACCT files 371 + 636 = 1007`、`ACCT lines 5,153 + 2,268 = 7,421` → **PASS**。
- 白名单重跑到 `3e2eef86`，**394 行**。

## 8. 复算命令

```powershell
node _annot_baseline/cand-generic.mjs d:/code/_annot_baseline/b317-repo-post.txt > _annot_baseline/b318-candidates.txt
node _annot_baseline/pick-generic.mjs b318 d:/code/_annot_baseline/b318-files.txt d:/code/_annot_baseline/b317-repo-post.txt
node _annot_baseline/gate-run.mjs --batch b318 --start
node _annot_baseline/judge-generic.mjs b318
node _annot_baseline/gate-run.mjs --batch b318 --subject "注释清水 b318：4 文件 1→1 改写"
node _annot_baseline/deep-quality.mjs d:/code/ZCode --root packages,apps,docs/knip --list-weak > _annot_baseline/b318-repo-post.txt
node _annot_baseline/deep-quality.mjs d:/code/ZCode --file-list d:/code/_annot_baseline/b254-802-files.txt --list-weak > _annot_baseline/b318-guard-post.txt
node docs/annotation/_tools/weak-guard.mjs --pre d:/code/_annot_baseline/b317-guard-post.txt --post d:/code/_annot_baseline/b318-guard-post.txt
node docs/annotation/_tools/own-commits-gen.mjs d:/code/ZCode
node docs/annotation/_tools/capacity-estimate.mjs --repo d:/code/ZCode --weak d:/code/_annot_baseline/b318-repo-post.txt --pre-weak d:/code/_annot_baseline/b317-repo-post.txt --batch b318
node docs/annotation/_tools/ledger-assert.mjs d:/code/ZCode
```

## 9. 提交

| 内容 | 提交 | numstat |
| --- | --- | --- |
| 白名单（开批前，392 行） | `4ffdad04` | 2 文件 |
| b318 批次本体（4 文件 1→1 改写） | `3e2eef86` | `+44/−44` |
| `ZC-deep-b318-rewrite.tsv` + 白名单 394 行 + 本台账 + INDEX 同步 | 见本批台账提交 | — |

- 收口判据：A1 `remain=2,268≠0` 未到；A2 `5,153 + 2,268 = 7,421` 成立；
  A3 `ledger-assert PASS`；A4 `5,153 落笔 + 0 池内自清 + 2,268 = 7,421` 成立。
- 后续：b319 继续；b320 插点做「逐行探针增量普查」，只测不修。
