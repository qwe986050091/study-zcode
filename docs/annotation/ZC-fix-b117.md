# FIX-B117 注释质量改写（按文件聚合）

> 判据：`_annot_baseline/zc-gate.mjs`（插入侧与清理侧共用）。统计口径为**去重文件全量**，
> 不按批次快照累加。三档分类由 `zc-classify.mjs` 给出，块级人工复核后执行。

## 1. 目标选择：先纠正队列排序

原队列头部按 `c1+c2` 排序，前四名是：

| 文件 | 命中 | POEM | B | W | L |
| --- | ---: | ---: | ---: | ---: | ---: |
| `packages/shared/src/zcode-protocol/index.ts` | 103 | 0 | 0 | 60 | 52 |
| `packages/ui/src/v4/SessionPane.tsx` | 92 | 0 | 0 | 42 | 55 |
| `packages/ui/src/remote-connection-flow/index.ts` | 78 | 0 | 0 | 58 | 27 |
| `packages/ui/src/settings/SubagentsSection.tsx` | 70 | 0 | 0 | 48 | 24 |

四个文件 `POEM=0`、`B=0`，命中全部是**多行注释折行**触发的 `L`（分隔符计数）/`W`（单行无标识符）误报。
按块级复核，这些行所在注释块整块都带真实标识符与后果语义，属误判，推翻不改。

全仓 kind 分布（去重口径，22,227 行）：

| kind | 行数 | 说明 |
| --- | ---: | --- |
| POEM | 5,950 | 成片短句，真注水主体 |
| B | 144 | 连续短句堆叠 |
| W | 10,025 | 单行无信息（含折行误报） |
| L | 6,108 | 无信息列举（含折行误报） |

结论：**队列应按 POEM+B 行数排序**，而不是按 `c1+c2` 总命中排序。本批据此把 B1-120 阶段的实际头部
4 个文件定为下表（`zc-work-queue-poem.txt` 已按此口径导出，保留原 `zc-work-queue.txt` 不动）。

| 文件 | 阶段 | 命中（c1/c2/c3） |
| --- | --- | --- |
| `packages/ui/src/root/RootWorkspaceContent.tsx` | B1-120 | 40（15/25/0） |
| `packages/ui/src/project-sidebar/grouped/virtualized-top-level-list.tsx` | B1-120 | 29（19/10/0） |
| `packages/ui/src/settings/OffPeakHistoryTab.tsx` | B1-120 | 27（15/12/0） |
| `packages/ui/src/resource-manager/storage/StorageCategoryDetail.tsx` | B1-120 | 27（12/15/0） |

## 2. 三档执行（每个文件一次改完）

| 档 | 行数 | 处理 |
| --- | ---: | --- |
| c1 真注水（成片短句，无标识符/谓词/前置/后果） | 99 | 按 v2 整块重写：点名真实标识符 + 守住什么 + 破坏现象 + 顺序/失败态 |
| c1 变体：`//` 被插进 JSX 子节点（会渲染成可见文本） | 16 | 删除（bug 修复，非内容取舍） |
| c2 可增强（有谓词但缺锚点） | 8 | 原地补真实标识符 + 一句「做错会怎样」，保留原句 |
| c3 误判（顺序/条件 + 后果齐全，只是短） | 0 | 本批未出现 |

JSX 变体分布：`OffPeakHistoryTab.tsx` 两处（表头前、行操作菜单前）、`StorageCategoryDetail.tsx` 两处
（根卡片前、定位按钮前），各 4 行，共 16 行。这些行在 JSX children 里不是注释而是文本节点，
`zc-verify` 的 JsxText 归一化把它们排除出代码 token 流，删除不改变代码。

## 3. 每文件结果

| 文件 | 段 | 删自有注释 | 增行 | 净 | 注水率 | 内文率 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `RootWorkspaceContent.tsx` | 9 | 45 | 21 | −24 | 0.00% | 26.42%（28/106） |
| `virtualized-top-level-list.tsx` | 6 | 29 | 16 | −13 | 0.00% | 7.43%（11/148） |
| `OffPeakHistoryTab.tsx` | 7 | 29 | 13 | −16 | 0.00% | 4.29%（6/140） |
| `StorageCategoryDetail.tsx` | 7 | 27 | 11 | −16 | 0.00% | 5.41%（6/111） |
| 合计 | 29 | 130 | 61 | −69 | 0.00% | — |

内文率下降是删掉成片短句的预期结果（分子减少、代码行不变）；后三个文件本就低于 15%，
属「补深」范畴，不在本批目标内，只记录不追改。

## 4. 验收

```
zc-gate --scan ZC-fix-b117/_files.txt
SUMMARY files=4 badFiles=0 addedCommentLines=147 waterLines=0 waterRate=0.00%

zc-verify --rewrite ZC-fix-b117
SUMMARY files=4 rewrittenSegments=29 deletedOwnCommentLines=130 codeTokenDiff=0 headTokenDrift=0
        codeDeletion=0 upstreamCommentDeleted=0 literalCommentDeletion=0 nonCommentAdded=0
        starSlash=0 syntaxErrorFiles=0
```

`deletedOwnCommentLines=130` 与 4 文件 numstat 删除数（45/29/29/27）逐项相等；
新增 61 行全部是 `//` 注释行，`nonCommentAdded=0`。

基线说明：`RootWorkspaceContent.tsx` 在补拍快照前已改写，基线由 `ZC-fix-b117/reconstruct-orig.mjs`
按「新行锚点 + 行数」逆变换还原；其余 3 文件为改写前快照。

## 5. 遗留

- `zc-work-queue.txt` 仍是 `c1+c2` 口径，下一批起以 `zc-work-queue-poem.txt` 为准。
- 待评估：`L` 规则对散文折行误报率偏高，可在判据里加「上一行未以句末标点收尾则跳过 L」的折行豁免，
  但会放宽漏报，需先在不改文件的前提下做一轮回归再定。
