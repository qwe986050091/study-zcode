# ZC-DEEP-B191（4 文件，+129 行）

> 范围：应用遥测运行时、MCP 遥测上报、任务通知派发、插件沙箱权限闸门（合计 467 行）。
> 快照：`d:\code\_annot_baseline\ZC-deep-b191\orig`；清单：`ZC-deep-b191-files.txt`。
> 目标密度 31.4%，实际落点 31.13%~31.78%。

## 1. 验收输出

```text
[ok] packages/desktop/src/main/appTelemetryRuntime.ts: 4 blocks, 32 lines
[ok] packages/desktop/src/main/desktopMcpTelemetry.ts: 4 blocks, 32 lines
[ok] packages/desktop/src/main/desktopNotifications.ts: 4 blocks, 32 lines
[ok] packages/desktop/src/main/pluginSandbox/permissionGate.ts: 4 blocks, 33 lines
SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=129
TOTAL added=129 hardBad=0 suspicious=0
```

逐文件密度：

```text
31.68% code=101 comment=32 packages/desktop/src/main/appTelemetryRuntime.ts
31.13% code=106 comment=33 packages/desktop/src/main/desktopMcpTelemetry.ts
31.30% code=131 comment=41 packages/desktop/src/main/desktopNotifications.ts
31.78% code=129 comment=41 packages/desktop/src/main/pluginSandbox/permissionGate.ts
```

## 2. 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `src/main/appTelemetryRuntime.ts` | 启动与日活遥测 | 协调器确认后上报、待发先清空、心跳只读最新上下文、交互翻转补发、定时器不阻止退出 | 32 |
| `src/main/desktopMcpTelemetry.ts` | MCP 遥测上报 | 未配置即丢弃、内存事件停发、事件到名称一一对应、属性转字符串、平台名归一 | 32 |
| `src/main/desktopNotifications.ts` | 任务通知派发 | 载荷校验、聚焦不弹、文案缺失拒绝、请求号去重、通知对象持有、点击后恢复再聚焦 | 32 |
| `src/main/pluginSandbox/permissionGate.ts` | 沙箱权限闸门 | 来源登记与地址一致、异步前复核、未声明即拒、同组合单框、系统媒体逐个申请、同意按分区隔离 | 33 |

## 3. 说明

- `appTelemetryRuntime.ts` 原文件无注释，header 22 行插在首个 import 之上；块落在工厂、补发与标记函数前。
- `desktopMcpTelemetry.ts` 的块落在发送入口、事件映射与属性序列化前；既有的内存事件说明保持原样。
- `desktopNotifications.ts` 的块落在去重函数、派发入口与窗口聚焦前；macOS 恢复顺序等既有注释未动。
- `permissionGate.ts` 首行 JSDoc 保留，header 插在 import 之上；块落在工厂、来源解析与请求分支前。
- 本批 1 次修正（通知文件块行数 11 → 10），修正后 check 一次通过。

## 4. 落地后复扫

```text
SUMMARY files=5032 coreBelow30=1958 needLines=29214 min=0.00 median=31.33
本会话范围 files=4562 coreBelow30=1954 needLines=24622
```

累计 1,270 文件 / 123,608 行。
