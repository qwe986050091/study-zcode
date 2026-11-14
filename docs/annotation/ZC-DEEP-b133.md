# ZC-DEEP-B133（3 文件，+130 行）

> 范围：工作流运行确认块、浏览器站点权限页与闲时创建卡片。
> 快照：`d:\code\_annot_baseline\ZC-deep-b133\orig`；清单：`ZC-deep-b133-files.txt`。
> 目标密度 31.4%，实际落点 31.27%~31.34%。

## 1. 验收输出

```text
[ok] packages/ui/src/WorkflowPermissionBlock.tsx: 6 blocks, 48 lines
[ok] packages/ui/src/browser-use/BrowserSitePermissionsPage.tsx: 5 blocks, 41 lines
[ok] packages/ui/src/ToolCallBlocks/renderers/offpeak-create.tsx: 5 blocks, 41 lines
SUMMARY files=3 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=130
TOTAL added=130 hardBad=0 suspicious=0
```

逐文件密度：

```text
31.27% code=291 comment=91 packages/ui/src/WorkflowPermissionBlock.tsx
31.34% code=134 comment=42 packages/ui/src/browser-use/BrowserSitePermissionsPage.tsx
31.29% code=147 comment=46 packages/ui/src/ToolCallBlocks/renderers/offpeak-create.tsx
```

## 2. 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `packages/ui/src/WorkflowPermissionBlock.tsx` | 工作流创建、修订与留白补全的运行确认块 | 来源徽标不表达信任、入参解析分叉、时间线收窄与折叠重置 | 48 |
| `packages/ui/src/browser-use/BrowserSitePermissionsPage.tsx` | 浏览器站点权限设置标签页 | 三态映射、忙碌禁用、成功与失败提示分叉 | 41 |
| `packages/ui/src/ToolCallBlocks/renderers/offpeak-create.tsx` | 闲时创建工具调用的轮尾卡片与输出摘要 | 工具名归一、多候选探测、位次快照与缺省回退 | 41 |

## 3. 说明

- 本批三个文件首行均唯一，无需 `nth`。
- `WorkflowPermissionBlock.tsx` 的 `useEffect(() => {` 在文件中唯一，可直接锚定。
- 本批无顺延文件；快照与现文件差异仅为本批新增注释行。
