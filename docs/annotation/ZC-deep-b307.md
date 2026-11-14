# ZC-deep-b307：3 文件 / 36 行（全池内；判据首轮 2 hits 已返修；1 行池外自清）

> 批次：b307 ｜ 代码提交 `b12c9948` ｜ `+36/−36` ｜ 零代码行
> 尺子：`deep-quality.mjs` v2.0（`756bea66122a`）、`zc-commit.mjs` v13（`f02be471a849`）、
> `precheck-assert.mjs`（`--start` 实盘逐行基准的第十九批）、
> `capacity-estimate.mjs`、`weak-guard.mjs`、`ledger-assert.mjs`
> ｜流程：`apply-run.mjs` + `gate-run.mjs`（失败闭合版，本批首例全绿跑完）。

## 0. 交代

1. 本批 3 文件 / **36 行，全部池内**（`ownIn=36 ownOut=0 upIn=0 upOut=1 pending=0 plan=36 allow=0`，
   池外的那 1 行是 `ConversationRowView.tsx:1811`，与上一条同文的重复行，不进计划）。
2. **判据首轮 `hits=2`，均为 `L/无信息列举`**：

   ```text
   L 1247  visibleText 取 …，row.text 保留原文用于复制：展示隐藏 share 块，复制保留完整输入。
   L 2186  autoCollapseKey 只驱动折叠：完成态取 row.state、流式传 null，不影响内容渲染。
   ```

   两条都是「≥2 个顿号/逗号且无谓词/前置条件」被 L 判据命中。改写为单分隔符 + 显式约束后
   `hits=0`。**本批 `write_phase` 返修 2 行**（Edit 直改，非 apply-run），台账如实记。
3. **池外自清 1 行**：`workspaceConnectionRegistry.ts:184`（JSDoc 的 `*/` 行，blame `872ad960`）
   在本次改写后不再满足 weak 判据，`capacity` 判为 `out-of-pool`，**不进 done/remain**，
   也不扣配额。全仓减少 37 行 = 落笔 36 + 该行 1。
4. 起笔前白名单 `352 行 / head=035e00bd`（随 b306 台账入账），工作树干净，
   `--start` 于 `2026-11-11T07:14:56.682Z` 落盘。
5. 顺序断言：`t-start 07:14:56.682 < t-record 07:16:31.721 < t-verify 07:16:32.870 < commit 15:16:52+08:00`；
   `record_runs=1`，无 runner 返修、无续跑。
   `batch_wall_total=198.0s`（`32fd8d4b → b12c9948`），`controllable=116.0s`（t-start → commit）。
6. 第 8 行门禁第十九批：`indentChanged=0 eolChanged=0`、`SAME 0`、`touched_restored=0`、
   `line_drift=0`、`out_of_scope_edits=0`。全程 apply-run，无 BOM。
7. 本批结束重生成白名单：**354 行 / `head=b12c9948`**（未提交，随台账一起入账）。

## 1. 计划表

| 文件 | 池内 | 池外 own | 本批 | 批后 weak |
| --- | ---: | ---: | ---: | ---: |
| `packages/ui/src/v4/ConversationRowView.tsx` | 12 | 1 | 12 | 0 |
| `packages/ui/src/v4/workspaceConnectionRegistry.ts` | 12 | 0 | 12 | 0 |
| `packages/ui/src/workspace-file-tree/useWorkspaceFileTreeWatchers.ts` | 12 | 0 | 12 | 0 |
| **合计** | **36** | **1** | **36** | **0** |

## 2. 批后池

```text
done files=330（+3）   remain files=677（−3）
done lines=4739（+36） remain lines=2682（−36）
ALIGNED acct_remain=2682 pool_remain=2682 diff=0
完成度 4739 / 7421 = 63.9%
```

- PARTIAL 仍为 3：`cuaDetails.tsx`（23 → 1）、`script-workflow-process.ts`（13 → 1）、
  `CoveragePanel.tsx`（13 → 2）。
- 全仓：`5969 → 5932`（−37 = 36 落笔 + 1 池外自清）；文件 `1829 → 1827`。
- 池外：`5932 − 2682 = 3250`（比 post-b306 少 1，即上面那条自清）。
- `done 4,739` 的台账口径：**「已写入 4,739 行，其中 10 行经 N/P 双读，fail 1」**。

## 3. 计时

```text
t-start    2026-11-11T07:14:56.682Z
t-record   2026-11-11T07:16:31.721Z  record_runs=1
t-verify   2026-11-11T07:16:32.870Z
commit     2026-11-11T15:16:52+08:00  b12c9948

batch_wall_total        = 198.0 s（32fd8d4b → b12c9948）
batch_wall_controllable = 116.0 s（t-start → commit）
s/行（端到端）           = 3.22（116.0 / 36）
```

- 小批 n=6（3.69 / 1.75 / 2.72 / 1.39 / 2.72 / 3.22），本批略高来自判据返修 2 行。

## 4. 度量前后

| 文件 | weak 前→后 |
| --- | ---: |
| `v4/ConversationRowView.tsx` | 12 → 0（另有 1 行池外同文重复不计） |
| `v4/workspaceConnectionRegistry.ts` | 12 → 0 |
| `workspace-file-tree/useWorkspaceFileTreeWatchers.ts` | 12 → 0 |

- 全仓：`post-b306 5969 / 1829` → `post-b307 5932 / 1827`。
- 池内：`done 4703 / remain 2718` → `done 4739 / remain 2682`。

## 5. 门禁（runner 输出，失败闭合）

```text
gate: PASS scope  n=0 plan=36 allow=0 diff_old=36 diff_new=36 out_of_scope_edits=0
gate: PASS record n=0 same=0 indent=0/0 mtime=0 drift=0 record_runs=1
gate: PASS verify n=0 same=0 indent=0/0 mtime=0 drift=n/a record_runs=1 verify_ok=true
gate: PASS commit n=0 sha=b12c9948 files=3/3 numstat=36/36 删代码=0 删上游=0 新增非注释=0 搬移=0 判据=0 嵌套=0 标点=0
gate: PASS order  n=0 total=198.0s controllable=116.0s
GATE ALL PASS batch=b307 sha=b12c9948
```

- 本批是 runner 改失败闭合后**第一次从头跑到尾全绿**：五道闸齐全、无重复、无缺字段、
  行内结论与 exit 码一致、日志回灌自检通过。
- `verify` 的 `drift=n/a` 是规格显式声明（该阶段不产出 `line_drift`），
  由 `verify_ok=true` 承担断言。

## 6. 收口

```text
GUARD 15文件 pre=4 post=4 新增=0 max=8 → PASS
ACCT files 330 + 677 = 1007 OK
ACCT lines 4739 + 2682 = 7421 OK
ALIGNED acct_remain=2682 pool_remain=2682 diff=0
ledger-assert ASSERT PASS（CLOSE 802 = 802，EXEMPT 2，FILELIST 15 文件 OK）
OWNCOMMITS rows=354 generated=354 missing=0 extra=0 text=same
WHITELIST OK head=b12c9948 rows=354
SELF-CLEAR n=1（池外：workspaceConnectionRegistry.ts:184 / 872ad960 / out-of-pool，不扣配额）
```

## 7. 首轮命中率（逐批）

| 批 | 首轮 hits | 登记行 | 命中率 |
| --- | ---: | ---: | --- |
| b302 | 2 | 36 | 5.6% |
| b303 | 3 | 36 | 8.3% |
| b304 | 0 | 36 | 0.0% |
| b305 | 0 | 36 | 0.0% |
| b306 | 0 | 36 | 0.0% |
| **b307** | **2** | **36** | **5.6%** |

- b283–b307 二十五批合计 `113 / 1,983 ≈ 5.7%`；近八批（b300–b307）`19 / 443 ≈ 4.3%`。

## 8. 剩余工作量（按 post-b307 更新）

| 口径 | 单位耗时 | 2,682 行折算 | 说明 |
| --- | ---: | ---: | --- |
| 旧新口径 n=7 中位数（90–100 行批） | 1.66 s/行 | 4,452 s ≈ 1.2 h | 只作区间 |
| 30–40 行小批（b302–b307，n=6） | 1.39–3.69 s/行 | — | 中位 2.72 |
| 批次折算（35 行/批） | 35 行/批 | **约 77 批** | `2,682 / 35 ≈ 76.6` |

- `capacity` 的分档合计给出 339 批（文件数上界，不是排期依据）。

## 9. 池成员资格漂移追查（b308 起笔前补记）

`b307` 落笔 36 行、全仓 weak 少 37 行，多出的 1 行已查清，**不是池成员漂移**：

- **weak 判定确实对邻接敏感**：`deep-quality.mjs` 的 `sentenceUnit()` 会把「不以句末标点收尾」
  的相邻注释行合并成一句再判，`*/` 既不是结构性标记（`^\*+$` 不匹配 `*/`）也不以句末标点结尾，
  于是与下一行同判。改写前下一行是「命中时只增引用并清预热定时器。」（无标识符），整句判弱；
  改写后该行含 `acquireWorkspaceConnection / refCount / keepWarmTimer`，整句转强，
  `*/` 随之不再被报 weak。**这是句元合并的连带效应，不是该行自身内容变化。**
- **池成员资格没有漂移**：`capacity` 的池 = `git diff -U0 8f7daaf0 <HEAD>` 的 `+` 行集合，
  blame 只用于三态与自清分类。全量对拍 `035e00bd → b12c9948`：
  `POOL-DELTA gone=0 add=209`（209 行全是 `docs/annotation/` 台账，不在扫描域，
  永远不会成为 weak）；扫描域内池成员变化 **0 行**。
- **weak 集合变化**：`gone=37 added=0` —— 36 行在池内（本批计划行）+ 1 行池外
  （`workspaceConnectionRegistry.ts:184`，blame `872ad960`，`out-of-pool`）。**漂移只有这 1 行。**

据此新增第 11 道门禁 **`POOL-DIFF`**（`gate-run.mjs`，跑在 `commit` 之后）：

```text
预快照（上一批全仓 weak）  vs  后快照（本批文件重新扫描）
消失集合必须 ⊆ {本批计划行} ∪ {POOL-SELF-CLEAR.tsv 已登记行}；新增 weak 一律判红。
未登记的消失行 → UNREGISTERED SELF-CLEAR <file:line> → exit 1
```

- 登记表：[POOL-SELF-CLEAR.tsv](POOL-SELF-CLEAR.tsv)（当前唯一一行：上述 `:184`，b307）。
- b307 实跑：`gate: PASS pool-diff n=0 removed=37 added=0 allowed=37`；
  负例（不喂登记表）：`UNREGISTERED SELF-CLEAR packages/ui/src/v4/workspaceConnectionRegistry.ts:184` → `exit=1`。
- 该行仍**不计入 done/remain**（池外），登记只为让「邻接改写导致归属漂移」显式留痕。

## 10. 池外对账

| 快照 | 提交 | weak | files | remain | 池外 |
| --- | --- | ---: | ---: | ---: | ---: |
| post-b303 | `3e50b96c` | 6077 | 1838 | 2826 | 3251 |
| post-b304 | `0b23b3c1` | 6041 | 1835 | 2790 | 3251 |
| post-b305 | `b355ff66` | 6005 | 1832 | 2754 | 3251 |
| post-b306 | `035e00bd` | 5969 | 1829 | 2718 | 3251 |
| post-b307 | `b12c9948` | 5932 | 1827 | 2682 | 3250 |

- `5969 − 5932 = 37` = 池内 36 + 池外自清 1；池外因此从 3251 降到 3250。
