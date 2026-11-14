# ZC-deep-b371

> 批次：b371 ｜ **24 行 / 6 文件** ｜ 提交 `046feda9`

## 0. 普通批；`fix=1`；`hit_rate=4.2%`

- `files=6/6`；`plan_lines_covered=24/24`；`removed=24 added=0 allowed=35 auto_self_clear=0`。
- **首轮 1 行命中**：`codingPlanFunnelTelemetry.ts:105` 判 `L 无信息列举`（`seps=2` 且无谓词，
  judge 报、precheck 未拦）→ `1 ÷ 24 = **4.2%**`。改「，因此」为「：」后 `hits=0`。
- 等集断言与六闸均首跑通过，`fix` 只花在这一行。

## 1. 选行与目录分布

| 文件 | 本批 | 批后 weak | 目录 |
| --- | ---: | ---: | --- |
| `packages/shared/src/zcode-protocol-v4/wire-assembler.ts` | 4 | 0 | shared |
| `packages/ui/src/app-shell/workflow-artifacts/presets/ArtifactBoard.tsx` | 4 | 0 | ui/app-shell |
| `packages/ui/src/app-shell/workflow-artifacts/WorkflowArtifactTilePreview.tsx` | 4 | 3（池外） | ui/app-shell |
| `packages/ui/src/chat-input-toolbar/contextQuotaResetOpportunityReminder.tsx` | 4 | 0 | ui/chat-input-toolbar |
| `packages/ui/src/components/ai-elements/mermaid-block.tsx` | 4 | 0 | ui/components |
| `packages/ui/src/lib/codingPlanFunnelTelemetry.ts` | 4 | 0 | ui/lib |
| **合计** | **24** | **3** | — |

- 5 个文件清零，`WorkflowArtifactTilePreview.tsx` 留 3 行池外 weak（`42/43/47`，均为上游或空壳行）。
- 全仓文件数 `1,596 → 1,592`（−4），行数 `3,927 → 3,903`（−24）。
- 顶层目录 **2 个**（shared / ui），与 b370 同；ui 内部跨 4 个子目录。

## 2. 改动内容

- `wire-assembler.ts`：谓词只读入参故无竞争；`hardBound` 仅构造期执行；整帧/分片混用抛 `metadataMismatch`；
  重复 index 用 `bytesEqual` 逐字节比较。
- `ArtifactBoard.tsx`：空态仍渲染 `PresetHeading`；`compact` 只渲染列计数；列数用 `flex-wrap`；
  计数用 `font-mono` + `tabular-nums`。
- `WorkflowArtifactTilePreview.tsx`：空行跳过并截断到 `CSV_PREVIEW_COLUMNS`；单元格按 `CSV_CELL_MAX_CHARS` 截断；
  满 `CSV_PREVIEW_ROWS` 即 break；错误态回退纸页字形。
- `contextQuotaResetOpportunityReminder.tsx`：`trigger.contains(target)` 短路；`initial`/`urgent` 两态图标；
  关闭按钮两处 `stopPropagation`。
- `mermaid-block.tsx`：探针 `span` 用 `pointer-events:none`；兼容 `addListener`；回调只 `setRevision`；
  加载态与清空预览同段完成。
- `codingPlanFunnelTelemetry.ts`：`createFallbackFunnelId` 的降级条件；`entryPlanList` 留空串的理由；
  `no_plan` 分支清空档位；不用含 `Start` 的宽泛 helper。

## 3. 六闸

```
gate: PASS scope n=0 plan=24 allow=0 diff_old=24 diff_new=24 out_of_scope_edits=0 plan_lines_covered=24/24
gate: PASS record n=0 same=0 indent=0/0 mtime=0 drift=0 record_runs=1
gate: PASS verify n=0 same=0 indent=0/0 mtime=0 drift=n/a record_runs=1 verify_ok=true
gate: PASS commit n=0 sha=046feda9 files=6/6 numstat=24/24 删代码=0 删上游=0 新增非注释=0 搬移=0 判据=0 嵌套=0 标点=0
gate: PASS pool-diff n=0 removed=24 added=0 allowed=35 auto_self_clear=0
gate: PASS order n=0 total=438.0s controllable=121.0s
GATE ALL PASS batch=b371 sha=046feda9
```

## 4. 自清

- `auto_self_clear=0`，`POOL-SELF-CLEAR.tsv` 数据行仍 **11 行**（手工 6 + 自动 5，b367 登记后未再增长）。

## 5. 进度（双分母）

- 全仓 weak：**3,927 → 3,903**（−24）；文件 **1,596 → 1,592**（−4）。
- 池内：**663 行 / 384 文件**，全部可写（`ALIGNED diff=0`、`REMAIN` 无上游分量）。
- `done 6,758 / remain 663`；`6,758 + 663 = 7,421`（capacity `ASSERT PASS`）。
- **对基线 91.1%**（6,758 ÷ 7,421）；文件口径 **61.9%**（623 ÷ 1,007）。
- 可清到零文件 **72**（76 − 4）；含不可写残留 **1,520**（未变）。
- 剩余批数 **64**（384 文件 ÷ 6），`min/avg/max = 6/10.4/24`，46 批整批为 1 行文件。
  `capacity` 同时打印的 `perBatch=2 → 192` 是**对照值**，不是排期口径。

## 6. 计时

| 读数 | 起点 | 终点 | 本批 | 每行 |
| --- | --- | --- | ---: | ---: |
| `total` | 上一提交 `26b44ece` | `046feda9`（13:29:53） | 438.0s | 18.25s |
| `controllable` | `--start`（13:27:52） | 批次提交（13:29:53） | 121.0s | **5.04s** |
| 收口段 | 13:29:53 | 台账提交 `ca1a32ce`（13:36:49） | 416s | — |
| `批墙钟` | 13:27:52 | 台账提交（13:36:49） | 537.0s | 22.4s |

- `total=438s` 里含台账修订与 65→64 批的收尾改动，**不得当本批成本**；成本看 `controllable=121s`。
- **收口 416s 超 150s 停批线 1 次**（阈值是连续 3 批，故不停批）。超的构成可归因：
  本批收口含 INDEX 两处口径重写（65→64 批、可清 76→72）+ 新写台账 + capacity 两次，
  不是工具变慢——`controllable=121s` 与 b368–b370 同量级。
- `s/行 5.04` 回到 b367–b370 区间上沿（4.25–5.04），24 行 / 6 文件的形状目前样本 **n=6**。

| 批 | 行/批 | 行/文件 | s/行 | 收口 |
| --- | ---: | ---: | ---: | ---: |
| b366 | 30 | 5.00 | 7.17 | — |
| b367 | 26 | 4.33 | 6.04 | 235s |
| b368 | 24 | 4.00 | 4.25 | 86s |
| b369 | 24 | 4.00 | 4.67 | 46s |
| b370 | 24 | 4.00 | 4.29 | 49s |
| b371 | 24 | 4.00 | **5.04** | 416s |

- **离群原因：未定**（沿用 b370 结论）。目录跨度加了第 6 个点：b371 跨度 2、`5.04 s/行`；
  `r` 由 0.66 降到 **0.59（n=6）**，更不足以支持「异构度」解释。
  仍然只有一条有证据的结论：**开销不随文件数线性增长**。

## 7. 提交

| 内容 | 提交 | numstat |
| --- | --- | --- |
| 批次本体（6 文件 1→1 改写） | `046feda9` | `+24/−24` |
| `ZC-deep-b371-rewrite.tsv` + 本台账 + INDEX | `ca1a32ce` | — |
| 白名单重生成（629 行）+ 计时回填 | 见回填 | — |
