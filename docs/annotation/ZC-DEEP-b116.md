# ZC-DEEP-b116

> 批次：B116（6 文件，按 31.4% 口径目标 271 行，落地 271 行）。
> 逐文件独立 spec、逐份自检后按序插入；单批 6 个文件，按缺口降序选批。
> 基线快照：`d:\code\_annot_baseline\ZC-deep-b116`；开工前 6 文件均为 `newComments=0`。
> 首选项仍为 `bootstrap/src/app/script-workflow-child-source.ts`（`String.raw` 子进程源码字符串），
> 插入注释会改动运行时源码，按既定规则跳过，取清单下一项。

## 校验

```
node zc-verify.mjs ZC-deep-b116
SUMMARY files=6 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=271

node check-batch.mjs ZC-deep-b116 ZC-deep-b116-files.txt
TOTAL added=271 hardBad=0 suspicious=0
```

逐文件密度（`密度 / 代码行 / 注释行 / 本次新增 / 路径`）：

```
31.13  151   47  44  packages/ui/src/lib/automationTelemetry.ts
31.25  160   50  45  packages/ui/src/feedback/feedbackMeta.ts
31.36  169   53  45  packages/ui/src/hooks/useWorkspaceActiveTaskState.ts
31.44  264   83  46  packages/ui/src/hooks/useTabPersistence.ts
31.47  143   45  45  packages/ui/src/components/ui/highlighted-lightweight-diff-preview.tsx
31.51  238   75  46  packages/ui/src/components/workflow-timeline/WorkflowTimelineLedge.tsx
min=31.13 max=31.51 added=271
```

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `ui/src/components/ui/highlighted-lightweight-diff-preview.tsx` | 带语法高亮的轻量 diff 预览 | INV-01~18；字符上限；取消标志；同步结果；令牌片段键；数据属性；属性透传 | 45 |
| `ui/src/components/workflow-timeline/WorkflowTimelineLedge.tsx` | 时间线边檐灯带与底部滚动条 | INV-01~18；留白灯优先级；呼吸光晕；双线段；五枚折叠；镜像排列；点击终止 | 46 |
| `ui/src/feedback/feedbackMeta.ts` | 反馈工单元数据与文案标识 | INV-01~18；四类型；三档严重度；状态全覆盖；归档归一；模块与状态文案映射 | 45 |
| `ui/src/hooks/useTabPersistence.ts` | 标签页恢复、持久化与写回门禁 | INV-01~18；双开关；完成态绑定；fail-closed；防抖写回；写前快照；延迟恢复 | 46 |
| `ui/src/hooks/useWorkspaceActiveTaskState.ts` | 工作区活动任务展示状态汇总 | INV-01~18；元数据等价比较；稳定引用；目标键；订阅先于查询；迟到结果拒绝 | 45 |
| `ui/src/lib/automationTelemetry.ts` | 自动化创建与操作点击埋点 | INV-01~18；模型字段解析；错误固定分类；脱敏；成功/失败字段互斥；事件区域 | 44 |
