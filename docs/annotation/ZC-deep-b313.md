# ZC-deep-b313

> 批次：b313 ｜ 36 行 / 4 文件 ｜ 提交 `671f96bd`
> 尺子：`deep-quality.mjs` v2.0（句子级口径）、`zc-commit-v13.mjs`、`precheck-assert.mjs`、`gate-run.mjs`（十一闸）

## 0. 流程优化：`POOL-DIFF` 自清分流（b313 起生效）

### 0.1 判据

`gate-run.mjs` 的 `pool-diff` 闸把「批后消失的 weak 行」交给纯函数 `classifySelfClear` 分流，
三条件同时满足才自动放行：

1. 该行**在池外**（不在 `git diff -U0 8f7daaf0 HEAD` 的 `+` 行里）；
2. `blame` **为上游提交**（不在 `OWN-COMMITS.tsv` 白名单里）；
3. 本批 `plan` 里**没有这一行**（且未在 `POOL-SELF-CLEAR.tsv` 登记）。

命中时打印固定格式 `AUTO-SELF-CLEAR <file>:<line> reason=adjacent`，
写回 `POOL-SELF-CLEAR.tsv`（第 4 列 `auto-out-of-pool`、第 6 列 `auto`），
闸行输出 `auto_self_clear=N`。

反向两种一律硬失败：

- **池内自清** → `IN-POOL SELF-CLEAR <file>:<line>`（池内说明是本批计划行或本线写过的行，
  转强意味着自己的注释丢了内容，必须人看）；
- **池外但 blame 解析失败或属于本线** → `UNREGISTERED SELF-CLEAR <file>:<line> (own blame|blame unresolved)`。

### 0.2 负例如跑（同一份 `classifySelfClear`，未另写实现）

```text
$ node gate-run.mjs --selftest-selfclear
SELFTEST case=in-pool expect=exit-1 got=exit-1 OK msg=IN-POOL SELF-CLEAR a/b.ts:10
SELFTEST case=non-upstream expect=exit-1 got=exit-1 OK msg=UNREGISTERED SELF-CLEAR c/d.ts:7 (own blame)
SELFTEST case=auto expect=exit-0 got=exit-0 OK msg=AUTO-SELF-CLEAR e/f.ts:3 reason=adjacent
SELFTEST PASS n=0
```

端到端负例（假 batch 前快照 `b312-pre-weak-fake.txt`，在 `timeline-model.ts:245` 注入一条池内假 weak）：

```text
$ node gate-run.mjs --batch b312 --from pool-diff --sha 37f8b297 --pre-weak b312-pre-weak-fake.txt
gate: FAIL pool-diff n=1 removed=37 added=0 allowed=40 auto_self_clear=0
    ! IN-POOL SELF-CLEAR packages/ui/src/components/workflow-timeline/timeline-model.ts:245
EXIT=1

$ ... 同上，追加 --pool-base HEAD（把池清空，使 245 变池外、blame 仍为本线）
gate: FAIL pool-diff n=1 removed=37 added=0 allowed=40 auto_self_clear=0
    ! UNREGISTERED SELF-CLEAR packages/ui/src/components/workflow-timeline/timeline-model.ts:245 (own blame)
EXIT=1
```

两次负例都没有写 `POOL-SELF-CLEAR.tsv`（`auto_self_clear=0`，工作树保持干净）。

### 0.3 首次生效情况

- **b313 `auto_self_clear=0`，自动分支尚未生效**。本批自清 `zip-source.ts:312`（块尾 `*/`）
  的 blame 是 `522e851e`——本线提交，但**早于池基线 `8f7daaf0`**，因此「池外 + 本线 blame」，
  按规则②被拦，走人工登记（见 §5）。
- 也就是说：阶段一观察到的形态里，只有 blame 确实为上游的那些会走自动；本线早期提交造成的
  池外自清仍要人看。是否把规则②放宽到「本线但提交早于池基线」，留待后续单独决定，本批不动。

## 1. 选行

| 文件 | 池内 | 池外 | 本批 | 批后 weak |
| --- | ---: | ---: | ---: | ---: |
| `apps/zcode-cli/packages/tui/src/app-sidebar-subagents.tsx` | 11 | 0 | 11 | 0 |
| `packages/ui/src/lib/remotePluginSyncRefresh.ts` | 10 | 1 | 10 | 0 |
| `packages/ui/src/side-pane-full-view/ConversationHost.tsx` | 8 | 4 | 8 | 0 |
| `apps/zcode-cli/packages/adapters/src/plugins/zip-source.ts` | 7 | 4 | 7 | 3（含块尾 `*/` 自清 1） |
| **合计** | **36** | **9** | **36** | **3** |

## 2. 改动内容

- `app-sidebar-subagents.tsx`：`SubagentsSection` 的状态所有权（只有 `endedOpen`）、
  `controller` 注入 `directory` / `loadMore`、`items` 合并顺序、选中态 `selected` × `sessionId`、
  `stopPropagation` 顺序、`contentHeight` 三部分逐项（`item` 2 行 / 标题 1 行 / `nextCursor` 1 行）与
  `Math.min` 夹取上限。
- `remotePluginSyncRefresh.ts`：`workspaceIdentity` 按需携带与写回前一致性校验、
  命令面板数据直写会话、失败只复位 `loading`、三段刷新串行 `await` 顺序、
  `refreshSlashCommandsAfterRemotePluginSync` 的复用与不回滚、投影重取能力不等待。
- `ConversationHost.tsx`：`floating` 收起态与最小化态区分、`hostRef` 唯一句柄、
  `headerVisible` 四条件契约、`rebaselineFloatingAnswerBubbles` 只重置基线、
  `useCallback` 稳定引用、`apply` 回流、`cancelDrag` 不触发吸附变更、`statusIcon` 纯展示。
- `zip-source.ts`：逐条读取与零条目收束、`directory`/`file` 分流、单条失败即 `reject`、
  `destroy` 与 `end/error` 清理监听、协议白名单（`https` + loopback 明文，其余必须拒绝）。

## 3. 门禁读数（十一闸）

```text
gate: PASS start     n=0 t-start=2026-11-11T08:19:16.226Z
gate: PASS scope     n=0 plan=36 allow=0 diff_old=36 diff_new=36 out_of_scope_edits=0
gate: PASS record    n=0 same=0 indent=0/0 mtime=0 drift=0 record_runs=1
gate: PASS verify    n=0 same=0 indent=0/0 mtime=0 drift=n/a record_runs=1 verify_ok=true
gate: PASS commit    n=0 sha=671f96bd files=4/4 numstat=36/36 删代码=0 删上游=0 新增非注释=0 搬移=0 判据=0 嵌套=0 标点=0
gate: FAIL pool-diff n=1 removed=37 added=0 allowed=40 auto_self_clear=0
    ! UNREGISTERED SELF-CLEAR apps/zcode-cli/packages/adapters/src/plugins/zip-source.ts:312 (own blame)
gate: PASS pool-diff n=0 removed=37 added=0 allowed=41 auto_self_clear=0   ← 人工登记后补跑
gate: PASS order     n=0 total=0.0s controllable=44.0s
```

- **`pool-diff` 首跑非零**：`zip-source.ts:312` 是块尾 `*/`，blame `522e851e`（本线、早于池基线）。
  按规则②不自动登记，人工写入 `POOL-SELF-CLEAR.tsv` 后补跑 `allowed=41` PASS。
- **`order` 重跑失真**：`prev` 默认取 HEAD = 本批提交，故 `total=0.0s`。
  真实墙钟 `d173d3e7`（16:17:48）→ `671f96bd`（16:20:00）= **132.0s**；
  `controllable=44.0s`（`08:19:16.226Z` → `08:20:00Z`），`s/行 = 44.0 / 36 ≈ 1.22`。

## 4. 首轮命中与返修

- 首轮 **1 / 36 = 2.8%**：`zip-source.ts:598` `L/无信息列举`（两个逗号、`抛错` 不在谓词表）。
  改为「其余协议**必须拒绝**」后归零；`--record` 前用 Edit 直改，`record_runs=1`。

## 5. 自清（累计第 5 次；本批 0 条自动、1 条人工）

| 行 | blame | 分类 | 路径 |
| --- | --- | --- | --- |
| `apps/zcode-cli/packages/adapters/src/plugins/zip-source.ts:312` | `522e851e` | `out-of-pool`（本线早期提交） | **人工**登记 |

- 成因：312 是 JSDoc 块尾 `*/`，与下一行同判；313 行改成带 `entry` 的整句后整句转强。
- 它不占配额：`capacity-estimate` 回读 `SELF-CLEAR n=1 可写桶 0 / 池外 1`。
- **计数口径**：`auto_self_clear`（闸行输出、登记表第 6 列 `auto`）与人工登记（5 列）分开；
  本批 `auto_self_clear=0`、人工 1 条。

## 6. 池外对账（两个口径）

- 全仓（句子级）weak：`post-b312 5,749` → `post-b313 5,712`（**−37** = 36 批内 + 1 自清），文件 `1,817 → 1,816`。
- **句子级口径（工程完成度）**：`done 4,955 / remain 2,466`，`4,955 + 2,466 = 7,421`，**66.8%**。
- **逐行口径（自足性，并列观测）**：`remain ≈ 2,466 + 1,046 = 3,512`，`done ≈ 3,909 / 7,421`，**约 52.7%**。
- 池外：`5,712 − 2,466 = 3,246` 行，**永久不排期**。
- 限定语（凡引用完成度处必须同段出现）：
  「句子级口径；逐行口径下另有约 1,046 行池内续行被判强、未排期」。

## 7. 守卫与产能

- `GUARD` 15 文件：`pre=4 post=4 新增=0 max=8` → **PASS**。
- `capacity-estimate --batch b313`：`done files=353 (+4) / lines=4,955 (+36)`，
  `REMAIN 654 files / 2,466 lines`，`ALIGNED acct_remain=2466 pool_remain=2466 diff=0`，分档合计 328 批；
  `PARTIAL 3`（`cuaDetails.tsx` 1、`script-workflow-process.ts` 1、`CoveragePanel.tsx` 2）。
- `ledger-assert`：`ACCT files 353 + 654 = 1007`、`ACCT lines 4,955 + 2,466 = 7,421` → **PASS**。
- 白名单重跑到 `671f96bd`，**378 行**。

## 8. 复算命令

```powershell
node _annot_baseline/gate-run.mjs --selftest-selfclear
node _annot_baseline/pick-generic.mjs b313 d:/code/_annot_baseline/b313-files.txt d:/code/_annot_baseline/b312-repo-post.txt
node _annot_baseline/gate-run.mjs --batch b313 --start
node _annot_baseline/apply-run.mjs b313
node _annot_baseline/judge-generic.mjs b313
node _annot_baseline/gate-run.mjs --batch b313 --subject "注释清水 b313：4 文件 1→1 改写"
node _annot_baseline/gate-run.mjs --batch b313 --from pool-diff --sha 671f96bd --subject "注释清水 b313：4 文件 1→1 改写"
node _annot_baseline/deep-quality.mjs d:/code/ZCode --root packages,apps,docs/knip --list-weak > _annot_baseline/b313-repo-post.txt
node _annot_baseline/deep-quality.mjs d:/code/ZCode --file-list d:/code/_annot_baseline/b254-802-files.txt --list-weak > _annot_baseline/b313-guard-post.txt
node docs/annotation/_tools/weak-guard.mjs --pre d:/code/_annot_baseline/b312-guard-post.txt --post d:/code/_annot_baseline/b313-guard-post.txt
node docs/annotation/_tools/own-commits-gen.mjs d:/code/ZCode
node docs/annotation/_tools/capacity-estimate.mjs --repo d:/code/ZCode --weak d:/code/_annot_baseline/b313-repo-post.txt --pre-weak d:/code/_annot_baseline/b312-repo-post.txt --batch b313
node docs/annotation/_tools/ledger-assert.mjs d:/code/ZCode
```

## 9. 提交

| 内容 | 提交 | numstat |
| --- | --- | --- |
| 白名单（开批前，376 行） | `d173d3e7` | 2 文件 |
| b313 批次本体（4 文件 1→1 改写） | `671f96bd` | `+36/−36` |
| `ZC-deep-b313-rewrite.tsv` + `POOL-SELF-CLEAR.tsv`（人工 1 条）+ 白名单 378 行 + 本台账 + INDEX 同步 | 见本批台账提交 | — |

- 收口判据：A1 `remain=2,466≠0` 未到；A2 `4,955 + 2,466 = 7,421` 成立；
  A3 `ledger-assert PASS`；A4 `4,955 落笔 + 0 池内自清 + 2,466 = 7,421` 成立。
- 后续：b314 起继续 36 行/批；`auto_self_clear` 首次非零的批号在出现时回报。
