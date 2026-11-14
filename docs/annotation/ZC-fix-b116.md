# ZC-FIX-B116（4 文件 / 23 段，删除 108 行自有注释）

> 基线：`d:\code\_annot_baseline\ZC-fix-b116\orig`（改写前工作树）。
> 本批是「先装门禁、再清存量」的第一批存量清理，按统一判据（`zc-gate.mjs`）取 `packages/ui/src` 命中量前 4 的文件。

## 1. 验收输出

```text
SUMMARY files=4 rewrittenSegments=23 deletedOwnCommentLines=108 codeTokenDiff=0 headTokenDrift=0 codeDeletion=0 upstreamCommentDeleted=0 literalCommentDeletion=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0
```

`node zc-gate.mjs --scan ZC-fix-b116\_files.txt` 复扫：

```text
SUMMARY files=4 badFiles=0 addedCommentLines=64 waterLines=0 waterRate=0.00%
```

## 2. 分文件计数

| 文件 | 改写段 | numstat（对基线） | 内文率 |
| --- | ---: | --- | ---: |
| `packages/ui/src/v4/OffPeakNewTaskEntry.tsx` | 9 | +16 / −39 | 13.74%（25/182） |
| `packages/ui/src/components/workflow-timeline/WorkflowTimelineFills.tsx` | 5 | +10 / −24 | 2.40%（5/208） |
| `packages/ui/src/components/ui/input-group.tsx` | 5 | +9 / −22 | 0.00%（0/76） |
| `packages/ui/src/UpdateStatusButton.tsx` | 4 | +9 / −23 | 12.33%（18/146） |
| **合计** | **23** | **+44 / −108** | — |

## 3. 改写要点

- `OffPeakNewTaskEntry.tsx`：`appendLocalCustomizeTemplate` 的截断与追加顺序、`useCodingPlanEntryGate` 的 `status` 三态动作、`codingPlanUnavailable` 的显式否定优先于 `entryPlanStatus` 回落、`handleCardClick` 的门禁前置与 `materializeOffPeakTemplateDraft` 的 locale 依赖、`pb-[38px]` 与 `@container/conversation` 的作用域边界，都落到标识符上。
- `WorkflowTimelineFills.tsx`：`useFreshFills` 为何以 `holeId@filledAt` 串为依赖（`fills` 每帧新引用会让定时器永远重置）、`fillHeadOf` 的 `closest` 与内部笔标回落、`useFillHeadTarget` 的 `hovered ?? focused` 与 `focusVisible` 门槛、`useRowWidths` 的逐键相等短路。
- `input-group.tsx`：`data-slot`/`role=group` 的用途、`align` 四档与 `order-*`、`onClick` 先排 `button` 再 `querySelector(input)` 的焦点归属、`size` 四档与 `shadow-none` 的边框叠加原因。
- `UpdateStatusButton.tsx`：`releaseNotesCacheRef` 的键格式与 8 条淘汰、`handleUpdateEntryClick` 的独立窗口优先与 `setDialogOpen` 回落、`tooltipTitle` 三态取值与 `intl.formatMessage` 注入。

## 4. 断点核对与残留

- 逐文件复扫 `weaklines`：`input-group.tsx` 为 0；其余三个文件的残留均**上游注释行**，改写前已用 `git show HEAD:` 精确比对确认存在，未删除、未改写：
  - `OffPeakNewTaskEntry.tsx` L129（`埋点缺失原因：…` 上游 L 判定）。
  - `UpdateStatusButton.tsx` L112 / L162 / L165（`用户开始下载后…`、`只把更新弹窗改成中性视觉…`、`改用最小高度配合内容宽度…`）。
- 对基线 numstat 合计 +44 / −108，与 `deletedOwnCommentLines=108` 一致，无「已插入未写索引」或反向遗漏。

## 5. 顺带修正的统计口径

`qc-poem-audit` 按批次快照目录累计，同一文件若出现在多个批次（如 `ZC-deep-b120` 与 `ZC-deep-b120a`）会被重复计数。
`OffPeakNewTaskEntry.tsx` 的 74 行即为其 poem 行数 37 的两倍。后续以 `zc-gate.mjs --scan` 的**去重文件集合**为准，不再引用按批次累加的总数。
