# ZC-DEEP-b110

> 批次：B110（6 文件，按 31.4% 口径目标 277 行，落地 276 行）。
> 逐文件独立 spec、逐份自检后一次插入；单批 6 个文件，按缺口降序选批。
> 基线快照：`d:\code\_annot_baseline\ZC-deep-b110\orig`；开工前 6 文件均为 `newComments=0`。
> 唯一回调：`StartPlanContextBalance.tsx` 初始插入后为 32.22%，删除 1 行本次新增注释回调到 31.67%。

## 校验

```
node zc-verify.mjs ZC-deep-b110
SUMMARY files=6 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=276

node check-batch.mjs ZC-deep-b110 ZC-deep-b110-files.txt
TOTAL added=277 hardBad=0 suspicious=0   （回调前；回调后 zc-verify 记为 276）
```

逐文件密度（`密度 / 总行 / 代码行 / 注释行 / 本次新增 / 路径`）：

```
31.10  222  164  51  45  packages/ui/src/RemoteConnectionWizardChrome.tsx
31.13  221  151  47  45  packages/shared/src/tool-plan-adapter.ts
31.53  288  203  64  47  packages/ui/src/hooks/useTaskNotifications.ts
31.54  197  149  47  46  packages/ui/src/hooks/useBotGroupTask.ts
31.67  251  180  57  47  packages/ui/src/chat-input-toolbar/StartPlanContextBalance.tsx
31.68  228  161  51  46  packages/ui/src/components/ui/diff-viewer.tsx
SUMMARY files=6 coreBelow30=0 needLines=0 min=31.10 median=31.54 newComments=276
PASS: all 6 file(s) >= 30% (mode=code)
```

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `shared/src/tool-plan-adapter.ts` | 计划工具解析适配器 | INV-01~18；名称指纹；集合优先级；整组取舍；主代理归属 | 45 |
| `ui/src/chat-input-toolbar/StartPlanContextBalance.tsx` | Start Plan 余额面板 | INV-01~18；比例夹取；可见额度；兜底入口；进度与重置时间 | 47 |
| `ui/src/components/ui/diff-viewer.tsx` | 统一差异查看器 | INV-01~18；双形态互斥；阴影样式注入；选项合并；属性透传 | 46 |
| `ui/src/hooks/useBotGroupTask.ts` | 群任务状态同步 | INV-01~18；版本号防旧响应；工作区匹配；动作守卫；单条回填 | 46 |
| `ui/src/hooks/useTaskNotifications.ts` | 任务终态与交互通知 | INV-01~18；工作区签名；索引配对释放；基线推进；已见集合 | 47 |
| `ui/src/RemoteConnectionWizardChrome.tsx` | 远程连接向导外壳 | INV-01~18；步骤映射；预览占位；类型标签；两种布局 | 45 |
