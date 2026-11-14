# ZC-DEEP-B147（4 文件，+158 行）

> 范围：Mermaid 渲染预算、Office 预览识别与链接净化、插件页面生命周期管理、Office 预览内容组合。
> 快照：`d:\code\_annot_baseline\ZC-deep-b147\orig`；清单：`ZC-deep-b147-files.txt`。
> 目标密度 31.4%，实际落点 31.20%~31.58%。

## 1. 验收输出

```text
[ok] packages/ui/src/lib/mermaidRenderBudget.ts: 6 blocks, 39 lines
[ok] packages/ui/src/lib/officeFilePreview.ts: 7 blocks, 40 lines
[ok] packages/ui/src/plugin-ui/app/pluginUiPageManager.ts: 7 blocks, 40 lines
[ok] packages/ui/src/previewPaneOfficeContent.tsx: 6 blocks, 39 lines
SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=158
TOTAL added=158 hardBad=0 suspicious=0
```

逐文件密度：

```text
31.30% code=131 comment=41 packages/ui/src/lib/mermaidRenderBudget.ts
31.36% code=169 comment=53 packages/ui/src/lib/officeFilePreview.ts
31.58% code=133 comment=42 packages/ui/src/plugin-ui/app/pluginUiPageManager.ts
31.20% code=125 comment=39 packages/ui/src/previewPaneOfficeContent.tsx
```

## 2. 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `packages/ui/src/lib/mermaidRenderBudget.ts` | Mermaid 渲染前的源码规模与可见性预算 | 三道阈值、指标采集、正则游标归零与判别联合返回 | 39 |
| `packages/ui/src/lib/officeFilePreview.ts` | Office 预览种类识别、尺寸计算、解码与链接净化 | 后缀归一化、等比缩放、控制字符拒绝与点击受控入口 | 40 |
| `packages/ui/src/plugin-ui/app/pluginUiPageManager.ts` | 窗口级 MCP App 页面准入、容量与回收 | 串行准入链、任务与槽位上限、取消标记与延迟回收 | 40 |
| `packages/ui/src/previewPaneOfficeContent.tsx` | Office 三种格式预览的组合、加载态与错误兜底 | 懒加载拆包、复位键清错、二进制解码与格式分支穷尽 | 39 |

## 3. 说明

- `mermaidRenderBudget.ts` 首行即常量声明，文件头与首个正文块不能落在同一插入下标；首块改锚第二行阈值常量。
- `officeFilePreview.ts` 已有 JSDoc 与根因注释，正文块全部落在函数体语句上，未触碰既有注释。
- `pluginUiPageManager.ts` 为类实现，块锚点均为方法签名，插入位置在方法体之前，不影响缩进与 token。
- 本批无顺延文件；快照与现文件差异仅为本批新增注释行。
