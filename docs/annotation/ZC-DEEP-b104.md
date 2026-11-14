# ZC-DEEP-b104

> 批次：B104（6 文件，按 31.4% 口径目标 292 行，实际 +292）。
> 逐文件独立 spec、逐份自检后一次插入；单批 6 个文件，按缺口降序选批。
> 基线快照：`d:\code\_annot_baseline\ZC-deep-b104\orig`；开工前 6 文件均为 `newComments=0`。

## 校验

```
node zc-verify.mjs ZC-deep-b104
SUMMARY files=6 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=292

node check-batch.mjs ZC-deep-b104 ZC-deep-b104-files.txt
TOTAL added=292 hardBad=0 suspicious=0
```

逐文件密度（`密度 / 总行 / 代码行 / 注释行 / 本次新增 / 路径`）：

```
31.21  221  157  49  47  packages/ui/src/v4/composer/useCodeCommentContexts.ts
31.28  342  243  76  48  apps/zcode-cli/packages/core/src/plugin-reference/reminder.ts
31.32  546  380 119  50  apps/zcode-cli/packages/debug/server/network-capture.ts
31.35  499  370 116  50  apps/zcode-cli/packages/adapters/src/storage/session-store/repositories/session-inputs.ts
31.43  287  210  66  49  packages/ui/src/plugin-ui/app/pluginUiAppTools.ts
31.64  235  177  56  48  packages/ui/src/project-sidebar/ProjectTaskRows.tsx
SUMMARY files=6 coreBelow30=0 needLines=0 min=31.21 median=31.33 newComments=292
PASS: all 6 file(s) >= 30% (mode=code)
```

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `ui/src/plugin-ui/app/pluginUiAppTools.ts` | 插件页面工具发现与转发 | INV-01~18；代际绑定；刷新纪元；调用幂等与取消 | 49 |
| `ui/src/project-sidebar/ProjectTaskRows.tsx` | 侧栏任务行列表 | INV-01~18；单元素数组记忆化；分页与日期分组；空态归属 | 48 |
| `ui/src/v4/composer/useCodeCommentContexts.ts` | 代码评论附件 hook | INV-01~18；键拼接；提交成对；事件认领；作用域切换 | 47 |
| `adapters/.../session-inputs.ts` | 会话输入账本仓库 | INV-01~18；序号单调；提升同事务；状态单向迁移 | 50 |
| `core/src/plugin-reference/reminder.ts` | 插件引用提醒正文 | INV-01~18；只承载标识符；预算分配；字节截断 | 48 |
| `debug/server/network-capture.ts` | 本地代理抓包服务 | INV-01~18；记录上限；头部脱敏；归因优先级；启动幂等 | 50 |
