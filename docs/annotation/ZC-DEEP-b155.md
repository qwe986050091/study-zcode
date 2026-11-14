# ZC-DEEP-B155（4 文件，+152 行）

> 范围：模式切换回包守卫、提及搜索、分组任务行与工作区 hooks 行内信任（合计 687 行）。
> 快照：`d:\code\_annot_baseline\ZC-deep-b155\orig`；清单：`ZC-deep-b155-files.txt`。
> 目标密度 31.4%，实际落点 31.08%~31.40%。

## 1. 验收输出

```text
[ok] packages/ui/src/lib/modeConfigUpdateGuard.ts: 6 blocks, 38 lines
[ok] packages/ui/src/mentions/mentionSearch.ts: 6 blocks, 38 lines
[ok] packages/ui/src/project-sidebar/grouped/task-item.tsx: 6 blocks, 38 lines
[ok] packages/ui/src/settings/useWorkspaceHookInlineTrust.ts: 6 blocks, 38 lines
SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=152
TOTAL added=152 hardBad=0 suspicious=0
```

逐文件密度：

```text
31.25% code=128 comment=40 packages/ui/src/lib/modeConfigUpdateGuard.ts
31.21% code=157 comment=49 packages/ui/src/mentions/mentionSearch.ts
31.40% code=121 comment=38 packages/ui/src/project-sidebar/grouped/task-item.tsx
31.08% code=148 comment=46 packages/ui/src/settings/useWorkspaceHookInlineTrust.ts
```

## 2. 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `packages/ui/src/lib/modeConfigUpdateGuard.ts` | 本地发起模式切换后短暂拦截并发配置回包 | 三秒保护窗口、按工作区隔离、归一化比较、过期删除、确认即释放、任务/模式不一致放行 | 38 |
| `packages/ui/src/mentions/mentionSearch.ts` | 对提及候选项做空查询排序、模糊打分与上限裁剪 | 空查询默认上限、前缀优先于子串、中文不走子序列、同分稳定排序、字段权重加成、上限夹取 | 38 |
| `packages/ui/src/project-sidebar/grouped/task-item.tsx` | 渲染分组侧栏中的单个任务行并实现空分组拖放区 | 拖放标识前缀、事件冒泡阻断、属性原样透传、国际化文案、记忆化边界 | 38 |
| `packages/ui/src/settings/useWorkspaceHookInlineTrust.ts` | 提供工作区 hooks 行内信任、审核结算刷新与状态回传 | 目标工作区服务解析、未就绪不回退、结算才刷新、三元组同刻捕获、失败不刷新、加载态必清 | 38 |

## 3. 说明

- `task-item.tsx` 含 JSX，新块只插在模块级组件签名之前与函数体语句之前，未进入 JSX 子节点或属性区。
- `useWorkspaceHookInlineTrust.ts` 的 `if (!result.accepted)` 块锚定在 try 内的语句层，插入后不影响分支结构。
- 本批无顺延文件；快照与现文件差异仅为本批新增注释行。
