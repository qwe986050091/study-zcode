# ZC-DEEP-b103

> 批次：B103（6 文件，按 31.4% 口径目标 296 行，实际 +296）。
> 逐文件独立 spec、逐份自检后一次插入；单批 6 个文件，按缺口降序选批。
> 基线快照：`d:\code\_annot_baseline\ZC-deep-b103\orig`；开工前 6 文件均为 `newComments=0`。

## 校验

```
node zc-verify.mjs ZC-deep-b103
SUMMARY files=6 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=296

node check-batch.mjs ZC-deep-b103 ZC-deep-b103-files.txt
TOTAL added=296 hardBad=0 suspicious=0
```

逐文件密度（`密度 / 总行 / 代码行 / 注释行 / 本次新增 / 路径`）：

```
31.16  263  199  62  48  apps/zcode-cli/packages/core/src/tool/handlers/bash-readonly-policy-git-subcommands-core.ts
31.18  232  170  53  48  packages/ui/src/AssistantCodeCommentCards.tsx
31.28  265  195  61  48  packages/ui/src/components/workflow-run-line/TaskWorkflowRunLines.tsx
31.34  481  351 110  50  apps/zcode-cli/packages/core/src/tool/handlers/cron.ts
31.52  578  422 133  52  apps/zcode-cli/packages/adapters/src/storage/session-target.ts
31.67  244  180  57  50  packages/ui/src/mentions/providers/fileMentionProvider.ts
SUMMARY files=6 coreBelow30=0 needLines=0 min=31.16 median=31.31 newComments=296
PASS: all 6 file(s) >= 30% (mode=code)
```

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `ui/src/mentions/providers/fileMentionProvider.ts` | 文件提及搜索 | INV-01~18；跨根去重；作用域失效；补扫绕过缓存 | 50 |
| `adapters/src/storage/session-target.ts` | 会话目标表读写 | INV-01~18；单行唯一；运行态成对；收口比对与单调时间 | 52 |
| `core/src/tool/handlers/bash-readonly-policy-git-subcommands-core.ts` | git 只读子命令白名单 | INV-01~18；白名单默认拒绝；回调边界；只读断言 | 48 |
| `core/src/tool/handlers/cron.ts` | 定时自动化 CRUD 工具 | INV-01~18；自动化轮写闸门；端口缺失；输出裁剪 | 50 |
| `ui/src/AssistantCodeCommentCards.tsx` | 代码评论卡片列表 | INV-01~18；选择中不跳转；折叠本地状态；查看器请求标识 | 48 |
| `ui/src/components/workflow-run-line/TaskWorkflowRunLines.tsx` | 工作流运行行 | INV-01~18；实时与结束文案分叉；确认副作用；溢出计数 | 48 |
