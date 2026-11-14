# ZC-DEEP-b120a

> 批次：B120a（4 文件，按 31.4% 口径目标 192 行，落地 192 行）。
> B120 原选 6 文件，按「宁可多批也不要被截断」拆为 B120a（4 文件）+ B120b（2 文件）。
> 基线快照：`d:\code\_annot_baseline\ZC-deep-b120a`。
> 首选项仍为 `bootstrap/src/app/script-workflow-child-source.ts`（`String.raw` 子进程源码字符串），
> 插入注释会改动运行时源码，按既定规则跳过，顺延到后续批次。

## 校验

```
node zc-verify.mjs ZC-deep-b120a
SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=192

node check-batch.mjs ZC-deep-b120a ZC-deep-b120-files.txt
TOTAL added=192 hardBad=0 suspicious=0
```

逐文件密度（`密度 / 代码行 / 注释行 / 本次新增 / 路径`）：

```
31.25  256   80  45  packages/ui/src/components/workflow-timeline/WorkflowTimelineFills.tsx
31.58  171   54  44  packages/ui/src/GitPane/helpers.ts
31.40  172   54  44  packages/ui/src/UpdateStatusButton.tsx
31.39  223   70  59  packages/ui/src/v4/OffPeakNewTaskEntry.tsx
min=31.25 max=31.58 added=192
```

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `ui/src/components/workflow-timeline/WorkflowTimelineFills.tsx` | 工作流时间线补全的头行与描边框渲染 | INV-01~18；两秒新鲜窗口；稳定键；时钟最小化；头识别；可见焦点；行宽容差比较；单框高亮 | 45 |
| `ui/src/GitPane/helpers.ts` | Git 面板差异预览降级策略与查找内容 | INV-01~18；字符与行数阈值；文案三档；缓存键；只搜可见行；错误信息读取；三态预览计划 | 44 |
| `ui/src/UpdateStatusButton.tsx` | 顶部更新状态入口按钮 | INV-01~18；视图模型单一来源；日志缓存上限八条；下载态分支；桌面窗口优先；响应式类名集中 | 44 |
| `ui/src/v4/OffPeakNewTaskEntry.tsx` | 新建任务页闲时任务入口 | INV-01~18；灰度门控；本地模板追加；套餐门禁分层；草稿语言同源；遥测来源；底部固定与栅格 | 59 |
