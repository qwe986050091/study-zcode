# ZC-DEEP-B132（4 文件，+168 行）

> 范围：工作流产物正文分派、确认弹窗原语包装、工作区服务解析与首页工作区列表。
> 快照：`d:\code\_annot_baseline\ZC-deep-b132\orig`；清单：`ZC-deep-b132-files.txt`。
> 目标密度 31.4%，实际落点 31.11%~31.54%。

## 1. 验收输出

```text
[ok] packages/ui/src/app-shell/workflow-artifacts/WorkflowArtifactBody.tsx: 5 blocks, 44 lines
[ok] packages/ui/src/components/ui/alert-dialog.tsx: 5 blocks, 41 lines
[ok] packages/ui/src/hooks/useWorkspaceServices.tsx: 5 blocks, 42 lines
[ok] packages/ui/src/project-sidebar/HomeOnlyWorkspaceRows.tsx: 5 blocks, 41 lines
SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=168
TOTAL added=168 hardBad=0 suspicious=0
```

逐文件密度：

```text
31.54% code=260 comment=82 packages/ui/src/app-shell/workflow-artifacts/WorkflowArtifactBody.tsx
31.11% code=135 comment=42 packages/ui/src/components/ui/alert-dialog.tsx
31.28% code=195 comment=61 packages/ui/src/hooks/useWorkspaceServices.tsx
31.16% code=138 comment=43 packages/ui/src/project-sidebar/HomeOnlyWorkspaceRows.tsx
```

## 2. 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `packages/ui/src/app-shell/workflow-artifacts/WorkflowArtifactBody.tsx` | 工作流产物标签页的正文分派与懒加载查看器 | 预置看板短路、字节三态、类型分派与表外回退 | 44 |
| `packages/ui/src/components/ui/alert-dialog.tsx` | 确认式弹窗的无状态样式与语义包装 | 属性透传、遮罩覆盖、按钮变体与类名合并顺序 | 41 |
| `packages/ui/src/hooks/useWorkspaceServices.tsx` | 按工作区身份解析服务访问器与连接态 | 断连代理契约、远程判定兜底、等待态禁止 RPC | 42 |
| `packages/ui/src/project-sidebar/HomeOnlyWorkspaceRows.tsx` | 首页专用工作区列表的打开、重连与状态展示 | 单飞请求、桥接与重连分派、连接态派生 | 41 |

## 3. 说明

- 本批四个文件首行均唯一，无需 `nth`。
- 本批无顺延文件；快照与现文件差异仅为本批新增注释行。
