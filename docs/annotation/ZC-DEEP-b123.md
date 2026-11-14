# ZC-DEEP-B123（4 文件，+173 行）

> 范围：`packages/ui/src` 的侧栏分区编排、远端连接进度/断线视图与 SaveWorkflow 确认块。
> 快照：`d:\code\_annot_baseline\ZC-deep-b123\orig`；清单：`ZC-deep-b123-files.txt`。
> 目标密度 31.4%，实际落点 31.23%~31.55%。

## 1. 验收输出

```text
[ok] packages/ui/src/project-sidebar/PurposeSections.tsx: 5 blocks, 44 lines
[ok] packages/ui/src/project-sidebar/RemoteConnectionProgressSection.tsx: 5 blocks, 43 lines
[ok] packages/ui/src/project-sidebar/RemoteConversationDisconnected.tsx: 5 blocks, 42 lines
[ok] packages/ui/src/SaveWorkflowPermissionBlock.tsx: 5 blocks, 44 lines
SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=173
TOTAL added=173 hardBad=0 suspicious=0
```

逐文件密度：

```text
31.51% code=146 comment=46 packages/ui/src/project-sidebar/PurposeSections.tsx
31.55% code=168 comment=53 packages/ui/src/project-sidebar/RemoteConnectionProgressSection.tsx
31.39% code=137 comment=43 packages/ui/src/project-sidebar/RemoteConversationDisconnected.tsx
31.23% code=269 comment=84 packages/ui/src/SaveWorkflowPermissionBlock.tsx
```

## 2. 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `packages/ui/src/project-sidebar/PurposeSections.tsx` | 项目/任务分区的排序、折叠与动作按钮 | 拖拽单轴锁定、偏好读写、排序标识与折叠独立 | 44 |
| `packages/ui/src/project-sidebar/RemoteConnectionProgressSection.tsx` | 远端连接进度与失败原因展示 | 来源域解析、展示时钟、进度分段与复制失效 | 43 |
| `packages/ui/src/project-sidebar/RemoteConversationDisconnected.tsx` | 断线横幅、草稿回显与禁用发送区 | 冷态不读远端、作用域兜底、只读草稿与禁用提交 | 42 |
| `packages/ui/src/SaveWorkflowPermissionBlock.tsx` | SaveWorkflow 权限确认块 | 折叠测量、四列实参表、覆盖警示与换请求重置 | 44 |

## 3. 说明

- 四个文件均为 `packages/ui` 组件，插入点全部位于模块级、函数体或 `return (` 之前，未落入 JSX 子节点。
- 本批未发现需要顺延的文件；快照与现文件差异仅为本批新增注释行。
- 本批也是总账断言落地后的第一批，`ledger-check.mjs zcode` 通过（见 README §4「范围声明与总账断言」）。
