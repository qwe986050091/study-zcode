# ZC-DEEP-b109

> 批次：B109（6 文件，按 31.4% 口径目标 276 行，实际 +276）。
> 逐文件独立 spec、逐份自检后一次插入；单批 6 个文件，按缺口降序选批。
> 基线快照：`d:\code\_annot_baseline\ZC-deep-b109\orig`；开工前 6 文件均为 `newComments=0`。
> 开工前全仓复扫（机器重启后重测）：`files=5032 coreBelow30=2309 needLines=42439 median=31.15`。

## 校验

```
node zc-verify.mjs ZC-deep-b109
SUMMARY files=6 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=276

node check-batch.mjs ZC-deep-b109 ZC-deep-b109-files.txt
TOTAL added=276 hardBad=0 suspicious=0
```

逐文件密度（`密度 / 总行 / 代码行 / 注释行 / 本次新增 / 路径`）：

```
31.25  200  144  45  45  packages/client/src/webRemoteControlAcknowledgedRelayProtocolTypes.ts
31.40  357  258  81  47  apps/zcode-cli/packages/tui/src/app-selection-panel.tsx
31.51  193  146  46  46  packages/desktop/src/main/localTtftSpans.ts
31.52  224  165  52  46  packages/shared/src/database-startup.ts
31.58  211  152  48  46  packages/desktop/src/main/desktopContextPromptRollout.ts
31.64  255  177  56  46  packages/desktop/src/main/embeddedBrowserJavaScriptDialog.ts
SUMMARY files=6 coreBelow30=0 needLines=0 min=31.25 median=31.51 newComments=276
PASS: all 6 file(s) >= 30% (mode=code)
```

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `tui/src/app-selection-panel.tsx` | 终端选区弹层 | INV-01~18；三态互斥；固定高度；列宽预算；宽字符裁切 | 47 |
| `client/src/webRemoteControlAcknowledgedRelayProtocolTypes.ts` | 带确认远控中继契约 | INV-01~18；水位校验；上限只收紧；身份匹配；帧字节累加 | 45 |
| `desktop/src/main/desktopContextPromptRollout.ts` | 桌面上下文提示开关 | INV-01~18；缺省即关闭；信封校验；单次结算；响应体上限 | 46 |
| `desktop/src/main/embeddedBrowserJavaScriptDialog.ts` | 内嵌浏览器原生弹窗接管 | INV-01~18；guest 登记；重入防护；自动化穿透；来源标签 | 46 |
| `desktop/src/main/localTtftSpans.ts` | 本地首字耗时转跨度 | INV-01~18；标识派生；父子关系；明细命名；覆盖时长合并 | 46 |
| `shared/src/database-startup.ts` | 数据库启动状态契约 | INV-01~18；结构化分类；安全明细；迁移事实约束；重试条件 | 46 |
