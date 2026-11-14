# ZC-DEEP-B158（4 文件，+154 行）

> 范围：Source Server 管理服务、任务实时桥、数据库启动遥测与远程资产 CDN（合计 1,043 行）。
> 快照：`d:\code\_annot_baseline\ZC-deep-b158\orig`；清单：`ZC-deep-b158-files.txt`。
> 目标密度 31.4%，实际落点 31.29%~31.68%。

## 1. 验收输出

```text
[ok] packages/desktop/src/host/sourceServerManagementService.ts: 7 blocks, 40 lines
[ok] packages/desktop/src/host/taskRealtimeBridge.ts: 6 blocks, 39 lines
[ok] packages/desktop/src/main/databaseStartupTelemetry.ts: 6 blocks, 37 lines
[ok] packages/server/src/remote/remoteAssetCdn.ts: 5 blocks, 38 lines
SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=154
TOTAL added=154 hardBad=0 suspicious=0
```

逐文件密度：

```text
31.29% code=342 comment=107 packages/desktop/src/host/sourceServerManagementService.ts
31.38% code=239 comment=75 packages/desktop/src/host/taskRealtimeBridge.ts
31.45% code=124 comment=39 packages/desktop/src/main/databaseStartupTelemetry.ts
31.68% code=161 comment=51 packages/server/src/remote/remoteAssetCdn.ts
```

## 2. 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `packages/desktop/src/host/sourceServerManagementService.ts` | 合成 Directory 事实与连接运行态，提供快照与命令入口 | 双读代际校验、变化重试、事件推送带代际、身份确认、会话目录分配、删除三步顺序与幂等 | 40 |
| `packages/desktop/src/host/taskRealtimeBridge.ts` | 在 Host 与 main 间中继实时事件、租约与 owner command | InitLocal 与 hostId 前置、共享 schema 校验、requestId 关联、事件 FIFO 去重、dispose 拒绝全部 pending | 39 |
| `packages/desktop/src/main/databaseStartupTelemetry.ts` | 把数据库启动状态转成 ARMS 自定义事件 | 上报失败静默、事件 id 可复算、尝试表上限、阶段变化才发、终态只结算一次、磁盘明细与日志 | 37 |
| `packages/server/src/remote/remoteAssetCdn.ts` | 由 CDN 基址与相对路径生成候选 URL 并做版本锁 | 基址去重、版本化优先、笛卡尔积、逐段编码与二次解码、路径穿越拒绝、组件回退父级根 | 38 |

## 3. 说明

- `sourceServerManagementService.ts` 的删除流程块锚定类方法签名，插入后位于方法体之前，未进入对象字面量方法内部。
- `databaseStartupTelemetry.ts` 的阶段与终态块均锚定在函数体语句层，插入后不改变 `if` 分支结构。
- 本批无顺延文件；快照与现文件差异仅为本批新增注释行。
