# ZC-deep-b382

> 批次：b382 ｜ **30 行 / 10 文件** ｜ 提交 `d29e2e15`

## 0. 普通批；`fix=2`；**判据类 2（6.7%）：judge 2 / 格式类 0 / lint 13**

| 抓取步骤 | 条数 | 内容 |
| --- | ---: | --- |
| lint（写盘前） | **13** | 9 条 `anchor=false`、2 条 seps≥2、1 条含「它」、1 条含「此」 |
| `judge-generic`（写盘后） | **2** | `useComposerAttachments.ts:361`（`id` 只有 2 字符，`ident()` 不认）、`workbenchGroupStore.ts:381`（`===` 非标识符） |
| `sentence-precheck` | 0 | `missing_anchor=0 missing_predicate=0` |
| 六闸 | 0 | 一次过 |
| `deep-quality` 全仓扫描 | 0 | 30 条目标行无一残留 |

- **判据类按「写盘后判否」计 2 条**，均为 `ident()` 粒度不足：`id`（2 字符）与 `===` 都不算锚点。
  改为 `attachmentId` / `compare snapshot 引用` 后判据归零。这是 §5.3 第 3 条（锚点必须是 ≥3 字符标识符）的又一次实证。
- **lint 13 条是本线单批最高**：`plan` 里 30 行有 13 行初稿没有任何 ASCII 锚点（纯中文短句）。
  说明这批源码的注释密度高、句子短，**纯中文行必须补 `字段名`**，否则 judge 必判 W。

## 1. 选行、逐文件对账与固定三列

| 文件 | 批前 weak | 批后 weak |
| --- | ---: | ---: |
| `packages/ui/src/ToolCallBlocks/renderers/resolve-workflow-question.tsx` | 3 | 0 |
| `packages/ui/src/ToolCallBlocks/renderers/skill.tsx` | 3 | 0 |
| `packages/ui/src/ToolCallBlocks/renderers/submit-result.tsx` | 4 | 0 |
| `packages/ui/src/v4/composer/useComposerAttachments.ts` | 4 | 1 |
| `packages/ui/src/v4/conversationAssistantWorkItems.ts` | 3 | 0 |
| `packages/ui/src/v4/ConversationShareConfirmationDock.tsx` | 3 | 0 |
| `packages/ui/src/v4/workbenchGroupStore.ts` | 3 | 0 |
| `packages/ui/src/v4/WorkflowNotificationHoleRow.tsx` | 4 | 0 |
| `packages/ui/src/v4/workspaceSessionsIndexSubscriptionSet.ts` | 3 | 0 |
| `packages/ui/src/WorkspaceHeaderSections.tsx` | 3 | 0 |
| **合计** | **33** | **1** |

**固定对账列**

| 清理文件数（池内清零） | 全仓清零 | 新进 weak 文件 | 集合 | 可清 | 恒等式 |
| ---: | ---: | ---: | --- | ---: | --- |
| **10** | **9** | **0** | 1,521 → 1,512 | **−8 → 记 0（已到底）** | `1,521 − 9 + 0 = 1,512` ✔ |

**⚠ 集合穿过了 1,520 这条「永远不清」基线**：`1,512 < 1,520`，`可清` 算出 **−8**。
这不是账错，而是**基线陈旧**：`NEVER-CLEAR.tsv` 的 1,520 条是历史快照，
其中已有 **8 个文件彻底干净**（残留行被本批相邻自清或更早批次的改写带走）。
- 公式订正：`可清 = 集合末行 − 当前仍含 weak 的 NEVER-CLEAR 文件数`，基线须**重新实测**，不再引用 1,520。
- 报表口径：**集合已到底**，此后集合变动只可能来自「新进 weak」或基线重算，不再由清零驱动。

## 2. 自清（2 条，全部自动登记）

```
AUTO-SELF-CLEAR packages/ui/src/ToolCallBlocks/renderers/submit-result.tsx:63 reason=adjacent
AUTO-SELF-CLEAR packages/ui/src/v4/WorkflowNotificationHoleRow.tsx:35 reason=adjacent
```

- 两条都是「改写相邻行后，原本 weak 的那一行也跟着变干净」，按 §6.2 第 20 条由闸自动登记。
- `allowed=44 = plan 30 + 自清 12 + 本批自动 2`，公式第三次被实测验证。

## 3. 六闸

```
gate: PASS scope n=0 plan=30 allow=0 diff_old=30 diff_new=30 out_of_scope_edits=0 plan_lines_covered=30/30
gate: PASS record n=0 same=0 indent=0/0 mtime=0 drift=0 record_runs=1
gate: PASS verify n=0 same=0 indent=0/0 mtime=0 drift=n/a record_runs=1 verify_ok=true
gate: PASS commit n=0 sha=d29e2e15 files=10/10 numstat=30/30 删代码=0 删上游=0 新增非注释=0 搬移=0 判据=0 嵌套=0 标点=0
gate: PASS pool-diff n=0 removed=32 added=0 allowed=44 auto_self_clear=2
gate: PASS order n=0 total=339.0s controllable=85.0s
```

- `removed=32`（30 计划 + 2 相邻自清）而池内只少 30：那 2 条自清行**本来就在池外**，
  与集合减少 9 个文件（10 个清理文件里 1 个仍留池外残留、外加 8 条基线衰减）不冲突。

## 4. 进度

- 全仓 weak：**3,632 → 3,600**（−32）；weak 文件 **1,521 → 1,512**（末行 `files=`）。
- 池内：**363 行 / 279 文件**（`728 + 279 = 1,007`、`7,058 + 363 = 7,421`、`ALIGNED OK`）。
- **行侧进度 95.1%**（7,058 ÷ 7,421）；文件侧 `728 ÷ 1,007 = 72.3%`（辅助）。
- 剩余批数（cap 10）：**28 批**（279 ÷ 10）。
- **集合已到底**：可清记 0，后续报表只报「新进 / 清零」两项。

## 5. 计时（分段）

| 读数 | 起点 | 终点 | 秒 |
| --- | --- | --- | ---: |
| `total` | 上一提交 `8e345c27`（16:18:1x） | `d29e2e15`（16:23:14） | 339.0 |
| `controllable` | `--start`（16:21:49） | 批次提交 | **85.0**（`s/行 = 2.83`，明细） |
| **S0** 提交 → closeout | 16:23:14 | 16:23:34 | **20**（含 `closeout.mjs` 落地与 INDEX 规则提交） |
| **S1** 扫描 | 16:23:34 | 16:23:41 | **7.3** |
| **S2** rewrite.tsv + own-commits + capacity | 16:23:41 | 16:23:43 | **1.3**（`0.0 + 0.2 + 1.1`） |
| **S3** 台账 | 16:23:43 | 16:24:07 | **24** |
| **S4** 提交 | 16:24:07 | 16:24:08 | **1** |
| **合计 S0–S4** | 16:23:14 | 16:24:08 | **53.6s**（20 + 7.3 + 1.3 + 24 + 1） |`n| `批墙钟` | 16:21:49 | 16:24:08 | **139s** |

- **单入口生效**：`S2` 从 b381 的 `56s` 降到 **1.3s**，且不再有我手工拼顺序的空间。
  这是「封成一条命令」的直接收益，不是工具变快。
- `controllable 85s` 也刷新下限，但同批有 15 条初稿被拦（13 lint + 2 judge），
  **快的原因是这批源码注释本来就短**，不能当能力提升。

## 6. 提交

| 内容 | 提交 | numstat |
| --- | --- | --- |
| 批次本体 | `d29e2e15` | `+30/−30` |
| rewrite.tsv + 本台账 + 白名单 672 行 | `41d0e159` | — |
