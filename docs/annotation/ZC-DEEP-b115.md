# ZC-DEEP-b115

> 批次：B115（6 文件，按 31.4% 口径目标 274 行，落地 274 行）。
> 逐文件独立 spec、逐份自检后按序插入；单批 6 个文件，按缺口降序选批。
> 基线快照：`d:\code\_annot_baseline\ZC-deep-b115`；开工前 6 文件均为 `newComments=0`。
> 首选项仍为 `bootstrap/src/app/script-workflow-child-source.ts`（`String.raw` 子进程源码字符串），
> 插入注释会改动运行时源码，按既定规则跳过，取清单下一项。

## 校验

```
node zc-verify.mjs ZC-deep-b115
SUMMARY files=6 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=274

node check-batch.mjs ZC-deep-b115 ZC-deep-b115-files.txt
TOTAL added=274 hardBad=0 suspicious=0
```

逐文件密度（`密度 / 代码行 / 注释行 / 本次新增 / 路径`）：

```
31.21  141   44  44  packages/shared/src/zcode-network-debug-status.ts
31.36  236   74  48  packages/ui/src/app-shell/WorkflowRunDirectorySidePane.tsx
31.38  188   59  45  packages/shared/src/project-access-token.ts
31.41  156   49  45  packages/shared/src/remoteUsageTelemetry.ts
31.48  216   68  46  packages/shared/src/zcode-session-visible-content.ts
31.61  155   49  46  packages/ui/src/ChatMediaAttachmentPreviewDialog.tsx
min=31.21 max=31.61 added=274
```

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `shared/src/project-access-token.ts` | 项目访问令牌解析、缓存与降级 | INV-01~18；响应补默认；八元组作用域键；pending 合并；换人作废；刷新提前量与抖动；临时故障降级 | 45 |
| `shared/src/remoteUsageTelemetry.ts` | 远端工作区与网页远控埋点构造 | INV-01~18；场景枚举；成功分类为空；事件区域固定；取消与失败分列；错误归类优先级 | 45 |
| `shared/src/zcode-network-debug-status.ts` | 任务载荷归类为网络调试事件 | INV-01~18；五种状态白名单；事件键六段拼接；可选字段条件展开；数值与布尔守卫；头部键序 | 44 |
| `shared/src/zcode-session-visible-content.ts` | 旧协议兼容面的 goal 与可见消息投影 | INV-01~18；续跑双形态；子 agent 来源；压缩摘要区分；稳定排序；迭代边界与上限收敛 | 46 |
| `ui/src/app-shell/WorkflowRunDirectorySidePane.tsx` | 一条对话的 workflow 运行目录侧边页 | INV-01~18；打开请求字段；行只渲染摘要；状态词主通道；租约与投影触发器；三种无行状态；截断明写 | 48 |
| `ui/src/ChatMediaAttachmentPreviewDialog.tsx` | 聊天媒体附件预览对话框 | INV-01~18；PDF 懒加载边界；文本优先；类型判定；播放状态重置；错误只收口预览；标签按需组装 | 46 |
