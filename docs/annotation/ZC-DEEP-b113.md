# ZC-DEEP-b113

> 批次：B113（6 文件，按 31.4% 口径目标 294 行，落地 294 行）。
> 逐文件独立 spec、逐份自检后一次插入；单批 6 个文件，按缺口降序选批。
> 基线快照：`d:\code\_annot_baseline\ZC-deep-b113`；开工前 6 文件均为 `newComments=0`。
> 中断复核：机器重启后复扫确认 B112 已完整收尾（`added=281`、索引与两个汇总文档均已回填），
> B113 仅有清单、计划与快照，未产生任何半插入文件，因此直接从原文插入。

## 校验

```
node zc-verify.mjs ZC-deep-b113
SUMMARY files=6 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=294

node check-batch.mjs ZC-deep-b113 ZC-deep-b113-files.txt
TOTAL added=294 hardBad=0 suspicious=0
```

逐文件密度（`密度 / 总行 / 代码行 / 注释行 / 本次新增 / 路径`）：

```
31.28  492  374  117  47  apps/zcode-cli/packages/core/src/runtime/internal-methods.ts
31.32  249  182   57  45  apps/zcode-cli/packages/node-repl-host/src/cua-bridge.ts
31.37  383  271   85  46  apps/zcode-cli/packages/tui/src/app-input-status.tsx
31.40 2164 1538  483  64  apps/zcode-cli/packages/telemetry/src/agent-trace-runtime.ts
31.61  266  193   61  46  apps/zcode-cli/packages/cli/src/command-center/handlers/plugins.ts
31.63  296  215   68  46  apps/zcode-cli/packages/tui/src/app-model-suggestion-panel.tsx
SUMMARY files=6 coreBelow30=0 needLines=0 min=31.28 median=31.49 newComments=294
PASS: all 6 file(s) >= 30% (mode=code)
```

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `cli/src/command-center/handlers/plugins.ts` | /plugins 子命令与选择器 | INV-01~18；子命令分派；卸载 force 闸门；排序稳定；空态与概要文案 | 46 |
| `core/src/runtime/internal-methods.ts` | 运行时核心方法类型契约 | INV-01~18；方法边界；steering 与预留；繁忙判定；工具面与目标 | 47 |
| `node-repl-host/src/cua-bridge.ts` | computer-use 桥接 | INV-01~18；代次校验；子代理拒绝；单飞请求；32MiB 上限；身份读取 | 45 |
| `telemetry/src/agent-trace-runtime.ts` | 遥测 span 运行时 | INV-01~18；容量与降级；链接与父子；身份快照；写入器终态；指标旁路 | 64 |
| `tui/src/app-input-status.tsx` | 输入区状态行 | INV-01~18；纯展示；宽度归一；徽标隐藏；三段拟合；紧凑计数 | 46 |
| `tui/src/app-model-suggestion-panel.tsx` | 模型候选浮层 | INV-01~18；可见窗口；当前标记；标注省略；列预算；宽度归一 | 46 |
