# ZC-deep-b314

> 批次：b314 ｜ 33 行 / 3 文件（不足 36 行，原因见 §1） ｜ 提交 `34d98a2e`
> 尺子：`deep-quality.mjs` v2.0（句子级口径）、`zc-commit-v13.mjs`、`precheck-assert.mjs`、`gate-run.mjs`（十一闸）

## 0. 本批未触发自清

`pool-diff` 首跑即 `removed=33 added=0 allowed=38 auto_self_clear=0` PASS——33 行全部是本批 plan 行，
没有邻接自清，也没有自动登记行。`auto_self_clear` 自 b313 上线以来仍未首次非零。

## 1. 选行

| 文件 | 池内 | 池外 | 本批 | 批后 weak |
| --- | ---: | ---: | ---: | ---: |
| `packages/services/src/skills/skillsService.ts` | 11 | 0 | 11 | 0 |
| `packages/ui/src/TaskListItem.tsx` | 11 | 0 | 11 | 0 |
| `packages/ui/src/TaskRenameDialog.tsx` | 11 | 0 | 11 | 0 |
| **合计** | **33** | **0** | **33** | **0** |

- **不足 36 行的原因**：`cand-generic` 的 b314 候选里，`ownIn > 0` 的文件只有 **11 与 10 两档**，
  没有 1–9 行的小文件；4 文件组合最小 `11+11+10+10 = 42 > 36`，只能取 3 文件 33 行。
  三个文件都是 `ownOut=0 upOut=0`，本批后整文件清零（`批后 weak = 0`）。

## 2. 改动内容

- `skillsService.ts`：扫描根祖先跳过（`otherIndex === index` / `existing`）、技能提及捕获组、
  严格解析 `keys` 来源、宽松 frontmatter 逐行扫描的三处跳过（空行 / 无冒号 / 注释行）、
  metadata 字段 `typeof` + `trim` 双校验、`installedRoots` 直接展开、`diagnostics` 透出、
  受控根命中即 `break`。
- `TaskListItem.tsx`：`hasPendingInteraction` 驱动范围、`resolveTaskSourceLabel` 调用成本、
  右键经 `onOpenTaskContextMenu` 上抛、`isTaskCron` 职责边界、`hoverEnabled` 与
  `shouldSuppressWorkspaceTaskMetadata` / `shouldMountWorkspaceTaskActions` 的关系、
  `formatTaskRelativeTime` 与 `task.updatedAt`、`shouldRenderPinAction` 可见性、
  `loadTaskPaths` 探测开关与挂载策略成对约束。
- `TaskRenameDialog.tsx`：`open / value / inputRef` 受控、`compositionActiveRef` 的
  start/end 写入点、Enter 前读取、`Dialog` / `Input` / `DialogFooter` 的受控边界、
  组件不持有 `useState`。

## 3. 门禁读数（十一闸）

```text
gate: PASS start     n=0 t-start=2026-11-11T08:25:11.817Z
gate: PASS scope     n=0 plan=33 allow=0 diff_old=33 diff_new=33 out_of_scope_edits=0
gate: PASS record    n=0 same=0 indent=0/0 mtime=0 drift=0 record_runs=1
gate: PASS verify    n=0 same=0 indent=0/0 mtime=0 drift=n/a record_runs=1 verify_ok=true
gate: PASS commit    n=0 sha=34d98a2e files=3/3 numstat=33/33 删代码=0 删上游=0 新增非注释=0 搬移=0 判据=0 嵌套=0 标点=0
gate: PASS pool-diff n=0 removed=33 added=0 allowed=38 auto_self_clear=0
gate: PASS order     n=0 total=192.0s controllable=128.0s
GATE ALL PASS batch=b314 sha=34d98a2e
```

- 十一闸首跑全绿，无补跑。
- `order` 的 `total=192.0s` 是 `--start` 到提交的墙钟；`controllable=128.0s`（含起草），
  `s/行 = 128.0 / 33 ≈ 3.88`——本批含一次选行口径排查（cand 只有 11/10 档），不作为稳定态样本。

## 4. 首轮命中与返修

- 首轮 **2 / 33 = 6.1%**，均 `--record` 前 Edit 直改，`record_runs=1`：
  - `TaskRenameDialog.tsx:40` `W/单行无信息`：原文「组件没有内部可写状态」无 ASCII 锚点 →
    改为「组件不持有 `useState`，内部无可写状态」。
  - `skillsService.ts:395` `L/无信息列举`：两个逗号、无谓词 →
    改为「捕获组 `match[1]` 必然存在，判空只为收窄类型而不改变匹配语义」（去掉一个逗号）。

## 5. 自清（累计第 6 批无自清；本批 0 自动、0 人工）

- 本批 `removed=33`、`added=0`，消失集合与 plan 完全重合，`POOL-SELF-CLEAR.tsv` 无新增行。
- `capacity-estimate` 回读 `SELF-CLEAR n=33 可写桶 33 / 池外 0 / 上游桶 0 / 未解析 0`（33 条全是本批落笔）。

## 6. 池外对账（两个口径）

- 全仓（句子级）weak：`post-b313 5,712` → `post-b314 5,679`（**−33** = 本批落笔 33，无自清），文件 `1,816 → 1,813`。
- **句子级口径（工程完成度）**：`done 4,988 / remain 2,433`，`4,988 + 2,433 = 7,421`，**67.2%**。
- **逐行口径（自足性，并列观测）**：`remain ≈ 2,433 + 1,046 = 3,479`，`done ≈ 3,942 / 7,421`，**约 53.1%**。
- 池外：`5,679 − 2,433 = 3,246` 行，**永久不排期**（与 b313 持平：本批只动池内行）。
- 限定语（凡引用完成度处必须同段出现）：
  「句子级口径；逐行口径下另有约 1,046 行池内续行被判强、未排期」。

## 7. 守卫与产能

- `GUARD` 15 文件：`pre=4 post=4 新增=0 max=8` → **PASS**。
- `capacity-estimate --batch b314`：`done files=356 (+3) / lines=4,988 (+33)`，
  `REMAIN 651 files / 2,433 lines`，`ALIGNED acct_remain=2433 pool_remain=2433 diff=0`，分档合计 327 批；
  `PARTIAL 3`（`cuaDetails.tsx` 1、`script-workflow-process.ts` 1、`CoveragePanel.tsx` 2）。
- `ledger-assert`：`ACCT files 356 + 651 = 1007`、`ACCT lines 4,988 + 2,433 = 7,421` → **PASS**（`ASSERT PASS`）。
- 白名单重跑到 `34d98a2e`，**381 行**。

## 8. 复算命令

```powershell
node _annot_baseline/cand-generic.mjs d:/code/_annot_baseline/b313-repo-post.txt > _annot_baseline/b314-candidates.txt
node _annot_baseline/pick-generic.mjs b314 d:/code/_annot_baseline/b314-files.txt d:/code/_annot_baseline/b313-repo-post.txt
node _annot_baseline/gate-run.mjs --batch b314 --start
node _annot_baseline/judge-generic.mjs b314
node _annot_baseline/gate-run.mjs --batch b314 --subject "注释清水 b314：3 文件 1→1 改写"
node _annot_baseline/deep-quality.mjs d:/code/ZCode --root packages,apps,docs/knip --list-weak > _annot_baseline/b314-repo-post.txt
node _annot_baseline/deep-quality.mjs d:/code/ZCode --file-list d:/code/_annot_baseline/b254-802-files.txt --list-weak > _annot_baseline/b314-guard-post.txt
node docs/annotation/_tools/weak-guard.mjs --pre d:/code/_annot_baseline/b313-guard-post.txt --post d:/code/_annot_baseline/b314-guard-post.txt
node docs/annotation/_tools/own-commits-gen.mjs d:/code/ZCode
node docs/annotation/_tools/capacity-estimate.mjs --repo d:/code/ZCode --weak d:/code/_annot_baseline/b314-repo-post.txt --pre-weak d:/code/_annot_baseline/b313-repo-post.txt --batch b314
node docs/annotation/_tools/ledger-assert.mjs d:/code/ZCode
```

## 9. 提交

| 内容 | 提交 | numstat |
| --- | --- | --- |
| 白名单（开批前，379 行） | `dddb3eea` | 2 文件 |
| b314 批次本体（3 文件 1→1 改写） | `34d98a2e` | `+33/−33` |
| `ZC-deep-b314-rewrite.tsv` + 白名单 381 行 + 本台账 + INDEX 同步 | 见本批台账提交 | — |

- 收口判据：A1 `remain=2,433≠0` 未到；A2 `4,988 + 2,433 = 7,421` 成立；
  A3 `ledger-assert PASS`；A4 `4,988 落笔 + 0 池内自清 + 2,433 = 7,421` 成立。
- 后续：b315 继续；选行时若再次遇到「只有 11/10 档」，按 3 文件 33 行执行并在台账写明。
