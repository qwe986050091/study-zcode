# ZC-DEEP-b119

> 批次：B119（6 文件，按 31.4% 口径目标 263 行，落地 263 行）。
> 逐文件独立 spec、逐份自检后按序插入；单批 6 个文件，按缺口降序选批。
> 基线快照：`d:\code\_annot_baseline\ZC-deep-b119`；开工前 6 文件均为 `newComments` 偏低。
> 首选项仍为 `bootstrap/src/app/script-workflow-child-source.ts`（`String.raw` 子进程源码字符串），
> 插入注释会改动运行时源码，按既定规则跳过，顺延到后续批次。

## 校验

```
node zc-verify.mjs ZC-deep-b119
SUMMARY files=6 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=263

node check-batch.mjs ZC-deep-b119 ZC-deep-b119-files.txt
TOTAL added=263 hardBad=0 suspicious=0
```

逐文件密度（`密度 / 代码行 / 注释行 / 本次新增 / 路径`）：

```
31.08  148   46  44  packages/ui/src/terminal/terminalLinks.ts
31.25  144   45  43  packages/ui/src/lib/exploreToolCall.ts
31.51  146   46  44  packages/ui/src/ToolCallBlocks/renderers/cuaDetails.tsx
31.51  146   46  44  packages/ui/src/ToolCallBlocks/renderers/todo.tsx
31.64  177   56  44  packages/ui/src/hooks/useSystemService.ts
31.64  177   56  44  packages/ui/src/project-sidebar/RemoteIdentityHoverCard.tsx
min=31.08 max=31.64 added=263
```

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `ui/src/terminal/terminalLinks.ts` | 从终端缓冲区文本识别并定位 HTTP 链接 | INV-01~18；URL 正则；尾标点裁剪；括号配对；折行快照；坐标转一基；无命中返回未定义 | 44 |
| `ui/src/lib/exploreToolCall.ts` | 依据工具身份与入参判定 shell 属于探查还是执行 | INV-01~18；身份先行；命令切段；两种包装剥壳；多键去重；写与重定向排除；循环只读 | 43 |
| `ui/src/hooks/useSystemService.ts` | 系统信息与内网探测 hooks 及稳定键工具 | INV-01~18；超时与次数归一化；端口校验；稳定键序列化；代际守卫；稳定键驱动重探 | 44 |
| `ui/src/project-sidebar/RemoteIdentityHoverCard.tsx` | 远端项目身份悬停详情卡 | INV-01~18；关闭缓冲；进入取消；菜单外沿锚点；协议解析回退；短消息文案；只读主机 | 44 |
| `ui/src/ToolCallBlocks/renderers/cuaDetails.tsx` | CUA 工具调用详情卡 | INV-01~18；记录判定；文本裁剪；状态图标；结果常驻；失败与建议二选一；分区顺序 | 44 |
| `ui/src/ToolCallBlocks/renderers/todo.tsx` | 待办工具调用折叠卡 | INV-01~18；输出优先取计划；三态样式；当前项三优先级；节点缓存；两分支快照提示 | 44 |
