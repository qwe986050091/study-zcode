# ZC-deep-b315

> 批次：b315 ｜ 33 行 / 3 文件（不足 36 行，原因见 §1） ｜ 提交 `6f64795e`
> 尺子：`deep-quality.mjs` v2.0（句子级口径）、`zc-commit-v13.mjs`、`precheck-assert.mjs`、`gate-run.mjs`（十一闸）

## 0. 本批无自清；首跑 `scope` 判红一次（3 行越界，已回滚）

- `pool-diff` 首跑即 `removed=33 added=0 allowed=38 auto_self_clear=0` PASS。
  `auto_self_clear` 自 b313 上线以来连续第三批为 0，本批仍无池外邻接自清。
- **首跑 `scope` 判红**：`taskListMembershipSets.ts` 的 96–98 三行（紧随 93–95 的注释带）被一并改写，
  但这三行不在 plan 里（`pick-generic` 未登记，说明它们在本批前已判强）。
  读数 `diff_old=36 diff_new=36 out_of_scope_edits=3` + `SCOPE OUT old/new` 六行，`exit 1`。
  处置：把 96–98 逐字还原为原文，重跑后 `plan=33 diff_old=33 diff_new=33 out_of_scope_edits=0` PASS。
  教训沿用（不加新规则）：**邻行看起来同质不等于同弱**，落笔集合只认 plan。

### 0.1 判据分歧登记（`taskListMembershipSets.ts:96-98`）

| 行 | 正文（还原后） | `pick-generic` 判定 | 我的判定 | 最后执行 |
| --- | --- | --- | --- | --- |
| 96 | `[失败路径] 真实存储太快，不暂停就无法稳定复现旧快照晚到` | strong（不在 plan） | 该改（邻行同质） | **按 `pick-generic` 还原** |
| 97 | `释放由配套函数负责，挂起本身只等待信号` | strong（不在 plan） | 该改（邻行同质） | **按 `pick-generic` 还原** |
| 98 | `暂停状态对外只暴露只读快照，调用方不能改内部计数` | strong（不在 plan） | 该改（邻行同质） | **按 `pick-generic` 还原** |

- **复核方法**：临时把 `deep-quality.mjs` 的 `sentenceUnit` 改为只取当前行（关掉句元合并），
  对单文件跑 `--list-weak`；原始版本未改，判据逻辑未动。
- **复核读数**（`WEAK lines=2 files=1`，本文件只报 46 与 97）：

```text
WEAK	packages/ui/src/lib/taskListMembershipSets.ts:97	无解释	释放由配套函数负责，挂起本身只等待信号
```

- **结论**：
  - 96、98 **逐行口径下也判 strong**（96 命中 `PRECOND` 的「无法」；98 命中 `INVARIANT` 的「只读」+ `PRECOND` 的「不能」），
    与 `pick-generic` 一致；我的判定错在把「邻行同质」当成弱，**分歧关闭，按 `pick-generic` 执行**。
  - 97 **逐行判弱、句子级判强**（`无解释`），正是那 1,046 行「池内续行被判强」的形态；
    该行 blame `a8784b7e` 早于 b309 实测点 `4fb6b6f8`，**已在既有 1,046 计数内，不新增计数**，也不进本批。
- 以后每次 `SCOPE OUT` 还原都必须留下同结构的一行分歧记录（行号 / 两侧判定 / 执行方 + 复核结论），
  规则写在 INDEX 的 `--scope` 段。

## 1. 选行

| 文件 | 池内 | 池外 | 本批 | 批后 weak |
| --- | ---: | ---: | ---: | ---: |
| `packages/ui/src/lib/taskListMembershipSets.ts` | 11 | 0 | 11 | 0 |
| `packages/web/src/share/mockConversationSharePreviewClient.ts` | 11 | 0 | 11 | 0 |
| `packages/zcode-server-cli/src/runtime/immutableRelease.ts` | 11 | 0 | 11 | 0 |
| **合计** | **33** | **0** | **33** | **0** |

- **不足 36 行的原因**：`cand-generic` 的 b315 候选里仍只有 **11 与 10 两档**（`ownOut=0` 的 `upOut=0` 文件全是 11/10），
  4 文件组合最小 `11+11+10+10 = 42 > 36`，只能取 3 文件 33 行——与 b314 同因，台账继续写明。
- 三个文件都是 `ownOut=0 upOut=0`，本批后整文件清零（`批后 weak = 0`），且分散在三个 package（ui / web / zcode-server-cli）。

## 2. 改动内容

- `taskListMembershipSets.ts`：E2E 挂起入口 `holdTaskListMembershipRefreshResultForE2E` 的职责、
  `activeTaskListMembershipRefreshHold` 重入保护、先 `clearTaskListMembershipCache` 的原因、
  `scopeParams` 的 `workspaceIdentity` 条件展开与空串边界、`fetchTaskListMembershipSetsForEndpoints` 的
  `taskId` 去重与五类附属映射合并。
- `mockConversationSharePreviewClient.ts`：`createdAt` / `expires_at` 的时间基、三类 `rows` 的覆盖范围、
  `title` 三元切换、`mock-expired` / `mock-not-found` 的 `kind`、未知码兜底、`mock-partial-unsupported`
  的 `unsupportedRowCount: 1` 与手工验收边界。
- `immutableRelease.ts`：`readdir` 按 `entry.name` 排序、`RELEASE_INTEGRITY_FILE` 自排除、
  目录与文件权限位的哈希输入、非普通文件拒绝、完整性记录与 `manifest.json` 的读取、
  `hashReleaseTree` 重算、逐字段比对、冲突错误保留 `error.message`、`promoteImmutableReleaseDirectory` 的前置校验与清理。

## 3. 门禁读数（十一闸）

```text
gate: PASS start     n=0 t-start=ts=2026-11-11T08:30:30.377Z
gate: FAIL scope     n=3 plan=33 allow=0 diff_old=36 diff_new=36 out_of_scope_edits=3
gate: PASS scope     n=0 plan=33 allow=0 diff_old=33 diff_new=33 out_of_scope_edits=0
gate: PASS record    n=0 same=0 indent=0/0 mtime=0 drift=0 record_runs=1
gate: PASS verify    n=0 same=0 indent=0/0 mtime=0 drift=n/a record_runs=1 verify_ok=true
gate: PASS commit    n=0 sha=6f64795e files=3/3 numstat=33/33 删代码=0 删上游=0 新增非注释=0 搬移=0 判据=0 嵌套=0 标点=0
gate: PASS pool-diff n=0 removed=33 added=0 allowed=38 auto_self_clear=0
gate: PASS order     n=0 total=115.0s controllable=89.0s
GATE ALL PASS batch=b315 sha=6f64795e
```

- 首次全量为 `scope` 判红（§0），回滚 3 行后重跑全绿；`record_runs=1`，`--record` 无返修。
- `order` 的 `total=115.0s`、`controllable=89.0s`，`s/行 = 89.0 / 33 ≈ 2.70`。

## 4. 首轮命中与返修

- 首轮 **1 / 33 = 3.0%**，`--record` 前 Edit 直改，`record_runs=1`：
  - `taskListMembershipSets.ts:156` `W/单行无信息`：原文「可选字段用条件展开，省略后对象保持最小」无 ASCII 锚点 →
    改为「用条件 spread 展开 `workspaceIdentity`，为空时对象不含该键」。

## 5. 自清（累计第 7 批无自清；本批 0 自动、0 人工）

- 本批 `removed=33`、`added=0`，消失集合与 plan 完全重合，`POOL-SELF-CLEAR.tsv` 无新增行。
- `capacity-estimate` 回读 `SELF-CLEAR n=33 可写桶 33 / 池外 0 / 上游桶 0 / 未解析 0`（33 条全是本批落笔）。
- `auto_self_clear` 仍未首次生效（b313=0、b314=0、b315=0）。

## 6. 池外对账（两个口径）

- 全仓（句子级）weak：`post-b314 5,679` → `post-b315 5,646`（**−33** = 本批落笔 33，无自清），文件 `1,813 → 1,810`。
- **句子级口径（工程完成度）**：`done 5,021 / remain 2,400`，`5,021 + 2,400 = 7,421`，**67.7%**。
- **逐行口径（自足性，并列观测）**：`remain ≈ 2,400 + 1,046 = 3,446`，`done ≈ 3,975 / 7,421`，**约 53.6%**。
- 池外：`5,646 − 2,400 = 3,246` 行，**永久不排期**（与 b314 持平：本批只动池内行）。
- 限定语（凡引用完成度处必须同段出现）：
  「句子级口径；逐行口径下另有约 1,046 行池内续行被判强、未排期」。

## 7. 守卫与产能

- `GUARD` 15 文件：`pre=4 post=4 新增=0 max=8` → **PASS**（键 = 文件 + weak 行正文）。
- `capacity-estimate --batch b315`：`done files=359 (+3) / lines=5,021 (+33)`，
  `REMAIN 648 files / 2,400 lines`，`ALIGNED acct_remain=2400 pool_remain=2400 diff=0`，分档合计 325 批；
  `PARTIAL 3`（`cuaDetails.tsx` 1、`script-workflow-process.ts` 1、`CoveragePanel.tsx` 2）。
- `ledger-assert`：`ACCT files 359 + 648 = 1007`、`ACCT lines 5,021 + 2,400 = 7,421` → **PASS**（`ASSERT PASS`）。
- 白名单重跑到 `6f64795e`，**384 行**。

## 8. 复算命令

```powershell
node _annot_baseline/cand-generic.mjs d:/code/_annot_baseline/b314-repo-post.txt > _annot_baseline/b315-candidates.txt
node _annot_baseline/pick-generic.mjs b315 d:/code/_annot_baseline/b315-files.txt d:/code/_annot_baseline/b314-repo-post.txt
node _annot_baseline/gate-run.mjs --batch b315 --start
node _annot_baseline/judge-generic.mjs b315
node _annot_baseline/gate-run.mjs --batch b315 --subject "注释清水 b315：3 文件 1→1 改写"
node _annot_baseline/deep-quality.mjs d:/code/ZCode --root packages,apps,docs/knip --list-weak > _annot_baseline/b315-repo-post.txt
node _annot_baseline/deep-quality.mjs d:/code/ZCode --file-list d:/code/_annot_baseline/b254-802-files.txt --list-weak > _annot_baseline/b315-guard-post.txt
node docs/annotation/_tools/weak-guard.mjs --pre d:/code/_annot_baseline/b314-guard-post.txt --post d:/code/_annot_baseline/b315-guard-post.txt
node docs/annotation/_tools/own-commits-gen.mjs d:/code/ZCode
node docs/annotation/_tools/capacity-estimate.mjs --repo d:/code/ZCode --weak d:/code/_annot_baseline/b315-repo-post.txt --pre-weak d:/code/_annot_baseline/b314-repo-post.txt --batch b315
node docs/annotation/_tools/ledger-assert.mjs d:/code/ZCode
```

## 9. 提交

| 内容 | 提交 | numstat |
| --- | --- | --- |
| 白名单（开批前，382 行） | `6247364f` | 2 文件 |
| b315 批次本体（3 文件 1→1 改写） | `6f64795e` | `+33/−33` |
| `ZC-deep-b315-rewrite.tsv` + 白名单 384 行 + 本台账 + INDEX 同步 | 见本批台账提交 | — |

- 收口判据：A1 `remain=2,400≠0` 未到；A2 `5,021 + 2,400 = 7,421` 成立；
  A3 `ledger-assert PASS`；A4 `5,021 落笔 + 0 池内自清 + 2,400 = 7,421` 成立。
- 后续：b316 继续；候选仍是 11/10 档时按 3 文件 33 行执行并在台账写明。
