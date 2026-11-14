# ZC-DEEP-B198（4 文件，+132 行）

> 范围：调试观测数据源读取、动态工作流 run 契约用例、knip 文档站 Astro 配置与客户端 WebSocket 适配（合计 796 行）。
> 快照：`d:\code\_annot_baseline\ZC-deep-b198\orig`；清单：`ZC-deep-b198-files.txt`。
> 目标密度 31.4%，实际落点 31.63%~31.95%。

## 1. 验收输出

```text
[ok] apps/zcode-cli/packages/debug/server/sources.ts: 5 blocks, 35 lines
[ok] apps/zcode-cli/packages/dynamic-workflow/src/testing/journal-contract-runs.ts: 7 blocks, 35 lines
[ok] docs/knip/docs/astro.config.ts: 6 blocks, 31 lines
[ok] packages/client/src/websocket.ts: 6 blocks, 31 lines
SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=132
[apps/zcode-cli/packages/debug/server/sources.ts] added=35 nonComment=0 starSlash=0 suspicious=0
[apps/zcode-cli/packages/dynamic-workflow/src/testing/journal-contract-runs.ts] added=35 nonComment=0 starSlash=0 suspicious=0
[docs/knip/docs/astro.config.ts] added=31 nonComment=0 starSlash=0 suspicious=0
[packages/client/src/websocket.ts] added=31 nonComment=0 starSlash=0 suspicious=0
TOTAL added=132 hardBad=0 suspicious=0
```

逐文件密度：

```text
31.63% code=98 comment=31 packages/client/src/websocket.ts
31.71% code=328 comment=104 apps/zcode-cli/packages/dynamic-workflow/src/testing/journal-contract-runs.ts
31.73% code=104 comment=33 docs/knip/docs/astro.config.ts
31.95% code=266 comment=85 apps/zcode-cli/packages/debug/server/sources.ts
```

## 2. 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `debug/server/sources.ts` | 观测数据源读取 | 路径解析口径、只读打开、三表限流、句柄 finally 关闭、单行坏 JSON 隔离、1 基行号、字段归一 | 35 |
| `dynamic-workflow/src/testing/journal-contract-runs.ts` | run 契约用例登记 | 终态与产物同笔写、缺席语义、失败三件套整体改写、非终态清空、元数据列契约、用量与上界窄写入 | 35 |
| `docs/knip/docs/astro.config.ts` | 文档站构建配置 | 站点基准与尾斜杠、重定向兜底、remark 插件顺序、CSS 变量覆盖、主题返回值 | 31 |
| `client/src/websocket.ts` | 浏览器 WebSocket 适配 | 二进制帧类型、事件双发、仅 OPEN 写入、drain 即时完成、结算标记、握手失败 reject 顺序 | 31 |

## 3. 说明

- `sources.ts` 原已有文件头 JSDoc 与逐函数 JSDoc（18.80%），本批在其上方补 INV 表，
  四个块全部锚定函数体内的首条语句，避免把既有 JSDoc 与函数签名拆开。
- `journal-contract-runs.ts` 原为 21.04%，正文已有大量语义注释；本批只补契约层的不变量表
  与六个用例前的口径说明，不改既有断言与注释。
- `docs/knip/docs/astro.config.ts` 原仅 2 行 `@ts-expect-error`（1.92%），块锚定在顶层配置项
  与两个工厂函数上；配置键与顺序未动。
- `packages/client/src/websocket.ts` 原为零注释，块锚定在包装器首行、监听器创建与两条连接入口；
  `settled` 的语义与先置位后回调的顺序在本批中显式记录。
- 本批 `sources.ts` 首锚点 `/**` 出现 5 次，spec 以 `nth: 1` 锚定文件首行后一次通过。

## 4. 落地后复扫

```text
SUMMARY files=5032 coreBelow30=1930 needLines=28352 min=0.00 median=31.33
本会话范围 files=4562 coreBelow30=1926 needLines=23760
```

累计 1,298 文件 / 124,519 行。
