# ZC-DEEP-B204（4 文件，+129 行）

> 范围：V4 composer 工具条热键、Web 远控传输契约、模型请求状态投递与 Workspace Hook 信任安全面（合计 896 行）。
> 快照：`d:\code\_annot_baseline\ZC-deep-b204\orig`；清单：`ZC-deep-b204-files.txt`。
> 目标密度 31.4%，实际落点 30.93%~31.53%。

## 1. 验收输出

```text
[ok] packages/ui/src/v4/composer/toolbarShortcuts.ts: 8 blocks, 33 lines
[ok] packages/web/src/web-remote-control/contracts/transport.ts: 6 blocks, 30 lines
[ok] apps/zcode-cli/packages/adapters/src/model/runner-status.ts: 7 blocks, 34 lines
[ok] apps/zcode-cli/packages/bootstrap/src/app/workspace-hook-trust.ts: 7 blocks, 32 lines
SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=129
[packages/ui/src/v4/composer/toolbarShortcuts.ts] added=33 nonComment=0 starSlash=0 suspicious=0
[packages/web/src/web-remote-control/contracts/transport.ts] added=30 nonComment=0 starSlash=0 suspicious=0
[apps/zcode-cli/packages/adapters/src/model/runner-status.ts] added=34 nonComment=0 starSlash=0 suspicious=0
[apps/zcode-cli/packages/bootstrap/src/app/workspace-hook-trust.ts] added=32 nonComment=0 starSlash=0 suspicious=0
TOTAL added=129 hardBad=0 suspicious=0
```

逐文件密度：

```text
30.93% code=97 comment=30 packages/web/src/web-remote-control/contracts/transport.ts
31.35% code=386 comment=121 apps/zcode-cli/packages/adapters/src/model/runner-status.ts
31.43% code=210 comment=66 apps/zcode-cli/packages/bootstrap/src/app/workspace-hook-trust.ts
31.53% code=203 comment=64 packages/ui/src/v4/composer/toolbarShortcuts.ts
```

## 2. 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `ui/v4/composer/toolbarShortcuts.ts` | 工具条热键解析与监听 | 三条命令白名单、修饰键精确匹配、前置条件整体早退、candidates 顺序即优先级、录制态独占、ref 读生效表、capture 成对增删 | 33 |
| `web/.../contracts/transport.ts` | 远控终端传输契约 | 九态状态机、诊断五种形状、定位要素必带、hiddenDurationMs 只在有值时出现、注入式 WebSocketCtor、失败与错误分通道 | 30 |
| `cli/.../model/runner-status.ts` | 模型状态事件出口 | 物理请求换 requestId、traceId 兜底生成、请求侧与生效侧 reasoning 分离、观测先于终态、take 消费语义、allSettled 逐条降级 | 34 |
| `cli/.../app/workspace-hook-trust.ts` | Hook 准入与审核装配 | 无快照即无面、rollout 关闭不读 Trust、控制器三条件、unavailable 原因码、读取 fail-closed、reloadTrust 重放 admission | 32 |

## 3. 说明

- `toolbarShortcuts.ts` 原 15.27%，块锚定 select 循环、前置条件、candidates 表、disabled 跳过、生效表同步、录制态早退与 preventDefault；
  首行锚点 `/**` 在文件内出现两次（文件头与 `resolveToolbarShortcutAction` 的 JSDoc），用 `nth: 1` 固定到第一处。
- `transport.ts` 原 0.00%，块锚定诊断联合、socket-close、三类无载荷诊断、诊断输入与选项接口；
  把「诊断必须可安全序列化」「onSendReady 区分同 socket 与重连」固定为契约说明。
- `runner-status.ts` 原 22.54%，块锚定上下文构造、attempt 派生、reasoning 初值、日志先行、deliveries 数组与 take 语义；
  `logStatusEvent` 在文件内有两处调用（publishModelStatus 与 publishModelTelemetryMilestone），用 `nth: 1` 固定到前者。
- `workspace-hook-trust.ts` 原 16.19%，块锚定快照早退、trustEnabled 判定、控制器声明、三条件装配、reloadTrust 与 store 读取；
  文件首行 `import {` 出现三次，用 `nth: 1` 固定到第一处。

## 4. 落地后复扫

```text
SUMMARY files=5032 coreBelow30=1906 needLines=27634 min=0.00 median=31.34
本会话范围 files=4562 coreBelow30=1902 needLines=23042
```

累计 1,322 文件 / 125,279 行。
