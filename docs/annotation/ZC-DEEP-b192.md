# ZC-DEEP-B192（4 文件，+129 行）

> 范围：资源管理器网络采集、远端 Source Server 探测、后台任务通知解析、MCP Apps 采样模式（合计 479 行）。
> 快照：`d:\code\_annot_baseline\ZC-deep-b192\orig`；清单：`ZC-deep-b192-files.txt`。
> 目标密度 31.4%，实际落点 30.97%~31.54%。

## 1. 验收输出

```text
[ok] packages/desktop/src/main/resourceManagerNetwork.ts: 4 blocks, 32 lines
[ok] packages/server/src/source-server/sourceServerProbe.ts: 4 blocks, 33 lines
[ok] packages/shared/src/background-task-notifications.ts: 4 blocks, 32 lines
[ok] packages/shared/src/mcp-apps/sampling.ts: 4 blocks, 32 lines
SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=129
TOTAL added=129 hardBad=0 suspicious=0
```

逐文件密度：

```text
31.25% code=112 comment=35 packages/desktop/src/main/resourceManagerNetwork.ts
31.54% code=149 comment=47 packages/server/src/source-server/sourceServerProbe.ts
31.43% code=105 comment=33 packages/shared/src/background-task-notifications.ts
30.97% code=113 comment=35 packages/shared/src/mcp-apps/sampling.ts
```

## 2. 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `src/main/resourceManagerNetwork.ts` | 网络采集 | 单会话互斥、先分配标识、只订阅自带会话、停止顺序与幂等、主机批次归并、IPC 授权 | 32 |
| `server/src/source-server/sourceServerProbe.ts` | 远端环境探测 | 单次往返、唯一标记分段、失败不中止、平台与架构归一、glibc 下限、摘要格式 | 33 |
| `shared/src/background-task-notifications.ts` | 后台任务通知 | 前缀与标识校验、字段独立读取、实体解码、后写覆盖、状态归并、元数据不覆盖 | 32 |
| `shared/src/mcp-apps/sampling.ts` | 采样模式 | 严格子集、消息与块上下限、图片白名单与线性校验、元数据计入预算、结果仅文本 | 32 |

## 3. 说明

- `resourceManagerNetwork.ts` 的块落在启动、停止与 IPC 注册前；既有会话与事件注释未动。
- `sourceServerProbe.ts` 首行为 `import {`（文件内多处），header 锚点取 `firstNth: 1`；块落在命令构造、探测入口与 glibc 校验前。
- `background-task-notifications.ts` 的块落在单条解析、批量聚合与元数据附加前；状态映射表达式保持原样。
- `sampling.ts` 的块落在参数模式、结果模式与字节估算函数前；既有正则与预算注释未动。
- 本批 4 份 spec 均一次 check 通过。

## 4. 落地后复扫

```text
SUMMARY files=5032 coreBelow30=1954 needLines=29090 min=0.00 median=31.33
本会话范围 files=4562 coreBelow30=1950 needLines=24498
```

累计 1,274 文件 / 123,737 行。
