# ZC-DEEP-B213（4 文件，+120 行）

> 范围：工作流详情头行、Side Pane 浮窗纯模型、submit_result 工具卡、更新状态视图模型（合计 581 代码行）。
> 快照：`d:\code\_annot_baseline\ZC-deep-b213\orig`；清单：`ZC-deep-b213-files.txt`。
> 目标密度 31%~32%，实际落点 30.72%~31.25%。

## 1. 验收输出

```text
[ok] packages/ui/src/settings/saved-workflows/SavedWorkflowDetailHeader.tsx: 13 blocks, 30 lines
[ok] packages/ui/src/side-pane-full-view/model.ts: 14 blocks, 30 lines
[ok] packages/ui/src/ToolCallBlocks/renderers/submit-result.tsx: 14 blocks, 30 lines
[ok] packages/ui/src/updateStatusModel.ts: 14 blocks, 30 lines
SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=120
[packages/ui/src/settings/saved-workflows/SavedWorkflowDetailHeader.tsx] added=30 nonComment=0 starSlash=0 suspicious=0
[packages/ui/src/side-pane-full-view/model.ts] added=30 nonComment=0 starSlash=0 suspicious=0
[packages/ui/src/ToolCallBlocks/renderers/submit-result.tsx] added=30 nonComment=0 starSlash=0 suspicious=0
[packages/ui/src/updateStatusModel.ts] added=30 nonComment=0 starSlash=0 suspicious=0
TOTAL added=120 hardBad=0 suspicious=0
```

逐文件密度（`codeRatio` = 注释 ÷ 代码）：

```text
30.72% code=166 comment=51 packages/ui/src/ToolCallBlocks/renderers/submit-result.tsx
30.89% code=123 comment=38 packages/ui/src/settings/saved-workflows/SavedWorkflowDetailHeader.tsx
31.10% code=164 comment=51 packages/ui/src/side-pane-full-view/model.ts
31.25% code=128 comment=40 packages/ui/src/updateStatusModel.ts
```

## 2. 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `ui/src/settings/saved-workflows/SavedWorkflowDetailHeader.tsx` | 详情页头行 | 只读展示、运行双条件、菜单只受 busy、归属小标、空说明、作用域动作、危险色删除、测试 id、h1 唯一 | 30 |
| `ui/src/side-pane-full-view/model.ts` | 浮窗纯模型 | 不碰 DOM、入场态、宽高推导、位置钳制、吸附推导、默认值、缩放原点、最近角、锚点解析、气泡基线/关闭/重置、预览清洗 | 30 |
| `ui/src/ToolCallBlocks/renderers/submit-result.tsx` | 提交结果卡 | 读时归一化不抛错、单次 parse、标量保原样、result 键在场、驳回扁平行、错误通道优先、四相文案、概要截断、CodeBlock、快照提示 | 30 |
| `ui/src/updateStatusModel.ts` | 更新视图模型 | 版本优先级、下载占位符、阶段同源、legacy 兜底条件、动作完成三判定、通道暴露、进度钳制、字节齐全、发布说明 | 30 |

## 3. 说明

- `SavedWorkflowDetailHeader.tsx` 原 8 行（6.50%），首行 `import {` 与第 11、19 行同名，用 `firstNth: 1` 锚定文件头；
  块锚定入口、归属测试 id、空说明三元、`min-w-0` 容器、h1、运行禁用、菜单禁用、作用域动作两行、scope 文案、删除样式、删除测试 id、删除图标。
- `model.ts` 原 21 行（12.80%），首行本就是注释，新增 INV 表插在其前；块锚定入场态、锚点集合、拖拽阈值、宽度、钳制、水平分量、缩放原点、最近角兜底、解析函数、回合键、基线建立、关闭短路、重置映射。
- `submit-result.tsx` 原 21 行（12.65%），块锚定概要上限、`toRecord`、归一化函数、标量分支、序列化、result 键门、驳回判定、停止判定、驳回原文链、展开门、prose 分支、CodeBlock、内容挂载。
- `updateStatusModel.ts` 原 10 行（7.81%），块锚定推导入口、版本次序、占位符、阶段、legacy 兜底、动作完成入口、下载分支、取消分支、非下载短路、字节校验、进度钳制、发布说明、格式化。
- 本批两个锚点首轮不匹配：`className="flex min-w-0 flex-col gap-1.5"` 实际行含 `<div `，取消分支缺少行尾 `||`；
  已按磁盘原文修正后重插，两次失败均未落盘（fail-closed），最终 `deletedNonZero=0`。

## 4. 落地后复扫

```text
SUMMARY files=5032 coreBelow30=1870 needLines=26590 min=0.00 median=31.34
本会话范围 files=4562 coreBelow30=1866 needLines=21998
```

累计 1,358 文件 / 126,369 行。

## 提交回填（2026-11-10）

```text
ZC-deep-b213 | 提交 a8784b7e | numstat 113 0 | 门禁 未通过（现行 W/POEM/L 判据：waterLines=35 / 113）
```

口径与边界：

- **提交边界不代表批次边界。** 本批注释在安全快照 `a8784b7e` 里入库，与其余 1,700 余个文件同属一次提交，无法从提交历史还原批次边界。
- 门禁以 `8f7daaf0` 为基线重跑（`--base` / `--diff-base`），以复原落盘时的判据条件；若用 HEAD 作基线会得到 0 行假 PASS。
- 六件套原始 SUMMARY：

```text
deep-gate    SUMMARY files=4 badFiles=4 addedCommentLines=113 waterLines=35 waterRate=30.97% [exit!=1]
zc-verify    SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=113
code-tokens  SUMMARY files=4 codeTokenDiff=0
in-strings   SUMMARY files=4 scanned=4 stringRanges=212 violations=0 addedViolations=0
boilerplate  SUMMARY groups=0 lines=0 files=0 dups=0 dupLines=0 singles=0 mode=diff
upstream     SUMMARY files=4 checked=4 upstreamComments=114 missing=0
```

- 结论：**六件套未全通过**。waterLines=35 说明按现行判据仍有水句，需按 §2.16 逐行改写后重新门禁；本批状态为「已提交、门禁未通过」。
