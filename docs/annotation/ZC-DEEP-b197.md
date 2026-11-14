# ZC-DEEP-B197（4 文件，+130 行）

> 范围：Web 远控帧适配、服务端任务活动跟踪、dev-docs 的 Vite 配置与 CLI 运行时配置合并（合计 696 行）。
> 快照：`d:\code\_annot_baseline\ZC-deep-b197\orig`；清单：`ZC-deep-b197-files.txt`。
> 目标密度 31.4%，实际落点 31.07%~31.68%。

## 1. 验收输出

```text
[ok] packages/web/src/web-remote-control/adapters/relayMessage.ts: 4 blocks, 32 lines
[ok] packages/zcode-server-cli/src/server-core/taskActivityTracker.ts: 4 blocks, 32 lines
[ok] apps/dev-docs/vite.config.ts: 4 blocks, 33 lines
[ok] apps/zcode-cli/packages/bootstrap/src/app/runtime-config.ts: 4 blocks, 33 lines
SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=130
TOTAL added=130 hardBad=0 suspicious=0
```

逐文件密度：

```text
31.07% code=103 comment=32 packages/web/src/web-remote-control/adapters/relayMessage.ts
31.68% code=101 comment=32 packages/zcode-server-cli/src/server-core/taskActivityTracker.ts
31.39% code=223 comment=70 apps/dev-docs/vite.config.ts
31.23% code=269 comment=84 apps/zcode-cli/packages/bootstrap/src/app/runtimeConfig.ts
```

## 2. 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `web-remote-control/adapters/relayMessage.ts` | 帧读取与解析 | 四形态字节上限、Blob 异步、解析整体捕获、失败对象工厂、元数据白名单、追踪摘要分流 | 32 |
| `zcode-server-cli/src/server-core/taskActivityTracker.ts` | 任务活动聚合 | 工作区键归一、数量去抖广播、生命周期按身份移除、事实分支、销毁幂等与订阅释放 | 32 |
| `apps/dev-docs/vite.config.ts` | dev-docs 构建配置 | 常量上限、指针文件三重校验、目录扫描降级、尾部截断丢残行、句柄收尾、虚拟模块缓存 | 33 |
| `apps/zcode-cli/.../runtime-config.ts` | 运行时配置合并 | MCP 三层合并、内建保身份、模型恢复语义、标题生成默认、工具面、钩子来源与顺序 | 33 |

## 3. 说明

- `relayMessage.ts` 原为零注释；首行为 `import {` 共出现两次，spec 以 `nth: 1` 锚定文件头，
  块落在帧读取、解析入口与追踪摘要前。
- `taskActivityTracker.ts` 原为零注释，块落在跟踪器接口、工厂函数与生命周期处理前；
  事实处理与返回值结构保持原样。
- `apps/dev-docs/vite.config.ts` 既有 20 余处说明注释未动，块落在候选文件接口与两个插件工厂前；
  常量区与导出配置未插行。
- `runtime-config.ts` 既有 6 处 JSDoc 与多处行内说明未动，块落在输出接口、主合并函数与日志上下文前。
- 本批 4 份 spec 中 `relayMessage.ts` 首锚点重复一次，改为 `nth: 1` 后一次通过；其余锚点计数唯一。

## 4. 落地后复扫

```text
SUMMARY files=5032 coreBelow30=1934 needLines=28472 min=0.00 median=31.33
本会话范围 files=4562 coreBelow30=1930 needLines=23880
```

累计 1,294 文件 / 124,387 行。
