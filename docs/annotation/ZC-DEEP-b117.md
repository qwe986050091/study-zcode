# ZC-DEEP-b117

> 批次：B117（6 文件，按 31.4% 口径目标 297 行，落地 297 行）。
> 逐文件独立 spec、逐份自检后按序插入；单批 6 个文件，按缺口降序选批。
> 基线快照：`d:\code\_annot_baseline\ZC-deep-b117`；开工前 6 文件均为 `newComments` 偏低。
> 首选项仍为 `bootstrap/src/app/script-workflow-child-source.ts`（`String.raw` 子进程源码字符串），
> 插入注释会改动运行时源码，按既定规则跳过，取清单下一项补足 6 个。

## 校验

```
node zc-verify.mjs ZC-deep-b117
SUMMARY files=6 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=297

node check-batch.mjs ZC-deep-b117 ZC-deep-b117-files.txt
TOTAL added=297 hardBad=0 suspicious=0
```

逐文件密度（`密度 / 代码行 / 注释行 / 本次新增 / 路径`）：

```
31.08  148   46  44  packages/ui/src/project-sidebar/contract.ts
31.28  179   56  50  packages/ui/src/project-sidebar/grouped/virtualized-top-level-list.tsx
31.36  169   53  45  packages/ui/src/lib/fileDisplayHelpers.ts
31.58  209   66  46  packages/ui/src/lib/composerRecent.ts
31.60  212   67  67  packages/ui/src/root/RootWorkspaceContent.tsx
31.69  142   45  45  packages/ui/src/lib/workspaceFileDrag.ts
min=31.08 max=31.69 added=297
```

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `ui/src/lib/composerRecent.ts` | 编辑器最近提交的模型与模式偏好存取 | INV-01~18；键兼容；回执序号；ACK 后落盘；加速 Provider 自愈；草稿初始选择 | 46 |
| `ui/src/lib/fileDisplayHelpers.ts` | 文件图标名称解析、配色与缩写标签 | INV-01~18；调色板兜底；文件名优先；逐段回退；扩展名收敛；大小写归一 | 45 |
| `ui/src/lib/workspaceFileDrag.ts` | 工作区文件拖拽载荷与提及构造 | INV-01~18；MIME 与事件常量；五字段校验；可取消事件；同区相对路径 | 45 |
| `ui/src/project-sidebar/contract.ts` | 侧边栏公开类型契约与再导出 | INV-01~18；设备行；可用性；文件树目标；导航属性边界 | 44 |
| `ui/src/project-sidebar/grouped/virtualized-top-level-list.tsx` | 分组视图顶层节点轻量虚拟化 | INV-01~18；阈值；高度估算；滚动容器探测；边距；初始偏移；锚点禁用 | 50 |
| `ui/src/root/RootWorkspaceContent.tsx` | 工作区壳层与设置页覆盖层的组合根 | INV-01~18；壳层常驻；透明覆盖；inert；边界重置；平台透传 | 67 |
