# ZC-DEEP-b112

> 批次：B112（6 文件，按 31.4% 口径目标 278 行，落地 281 行）。
> 逐文件独立 spec、逐份自检后一次插入；单批 6 个文件，按缺口降序选批。
> 基线快照：`d:\code\_annot_baseline\ZC-deep-b112\orig`；开工前 6 文件均为 `newComments=0`。
> 顺延说明：原第 6 项 `bootstrap/src/app/script-workflow-child-source.ts` 的内容是「子进程源码字符串」，
> 在其内部插入注释会改动该字符串本身，违反「不改字符串」约束，故跳过并顺延取 `mcp-ui/protocol.ts`（缺口 43）。
> 回调：`WorkspaceHelpMenuButton.tsx` 32.34% → 删 1 行至 31.74%；`protocol.ts` 刚落盘为 30.03%（低于本项目 31% 维护带），补 4 行至 31.31%。

## 校验

```
node zc-verify.mjs ZC-deep-b112
SUMMARY files=6 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=281

node check-batch.mjs ZC-deep-b112 ZC-deep-b112-files.txt
TOTAL added=278 hardBad=0 suspicious=0   （回调前；回调后 zc-verify 记为 281）
```

逐文件密度（`密度 / 总行 / 代码行 / 注释行 / 本次新增 / 路径`）：

```
31.31  422  313  98  47  apps/zcode-cli/packages/bootstrap/src/zcode-protocol/mcp-ui/protocol.ts
31.40  516  363  114  48  apps/zcode-cli/packages/adapters/src/commands/index.ts
31.42  555  401  126  48  apps/zcode-cli/packages/adapters/src/plugins/mcp.ts
31.45  220  159  50  46  packages/zcode-server-cli/src/runtime/serviceInstallation.ts
31.58  225  152  48  46  packages/web/src/auth/oauthStateCodec.ts
31.74  223  167  53  46  packages/ui/src/WorkspaceHelpMenuButton.tsx
SUMMARY files=6 coreBelow30=0 needLines=0 min=31.31 median=31.44 newComments=281
PASS: all 6 file(s) >= 30% (mode=code)
```

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `ui/src/WorkspaceHelpMenuButton.tsx` | 标题栏帮助菜单 | INV-01~18；桌面注入；无障碍名称；角标预留；桌面分组 | 46 |
| `web/src/auth/oauthStateCodec.ts` | OAuth state 编解码与回跳校验 | INV-01~18；URL 安全编码；白名单查询；同源校验；回调构造 | 46 |
| `zcode-server-cli/src/runtime/serviceInstallation.ts` | 本地服务卸载 | INV-01~18；卸载顺序；平台归一；旧版归属；别名扫描 | 46 |
| `adapters/src/commands/index.ts` | 自定义命令发现与读取 | INV-01~18；优先级；冲突保留；截断读取；frontmatter 白名单 | 48 |
| `adapters/src/plugins/mcp.ts` | 插件 MCP 服务器汇总 | INV-01~18；合并顺序；命名空间；形状归一；鉴权互斥 | 48 |
| `bootstrap/.../mcp-ui/protocol.ts` | 插件 UI 协议入口 | INV-01~18；凭证校验；幂等取消；订阅代次；错误翻译 | 47 |
