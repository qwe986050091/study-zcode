# SVC-B6 深度注释索引（zcode-agent 大文件收口）

> 规范母本：`d:\code\opensource\redb\docs\annotation\DEEP-SPEC.md`（v1）
> 范围：`packages/services/src/zcode-agent/**` 中缺口最大的 6 个文件。
> 口径：注释行 ÷ 代码行 ≥ 30%（`deep-density.mjs --mode code --threshold 30`）。

## 1. 结果

| 文件 | 代码行 | 注释行（前→后） | 密度 | 新增 |
| --- | ---: | --- | ---: | ---: |
| `zcodeTaskIndexSyncer.ts` | 1,681 | 209 → 507 | 30.16% | 298 |
| `zcodeAgentProcessManager.ts` | 1,271 | 155 → 385 | 30.29% | 230 |
| `zcodeAgentConnectionScope.ts` | 974 | 79 → 299 | 30.70% | 220 |
| `modelTrajectory.ts` | 395 | 23 → 122 | 30.89% | 99 |
| `zcodeAgent.ts` | 809 | 152 → 247 | 30.53% | 95 |
| `zcodeProtocolClient.ts` | 356 | 38 → 114 | 32.02% | 76 |
| **合计** | **5,486** | — | — | **1,018** |

## 2. 分段

| 段 | 文件 | 内容 | 新增 |
| --- | --- | --- | ---: |
| b6a | `zcodeTaskIndexSyncer.ts` | 状态表、背压、退订、事件发射、终态/标题迁移 | 83 |
| b6b | 同上 | summary diff、首帧基线、恢复状态机、snapshot/delta 落地 | 92 |
| b6c | 同上 | wire 闸门、订阅激活、重试、lifecycle、展示字段推导、dispose | 117 |
| b6d | 同上 | 暂存双限额补厚 | 6 |
| b6e | `zcodeAgentProcessManager.ts` | 命令解析链、stderr 尾部、spawn 前置探测 | 77 |
| b6f | 同上 | 进程三表、空闲回收、幂等清理、启动去重 | 55 |
| b6g | 同上 | startClient 启动事务、env 合成、transport/client 组装 | 48 |
| b6h | 同上 | exit/error/close 收口、workspace 释放、关闭等待 | 45 |
| b6i | 同上 | 进程树归属时间戳补厚 | 5 |
| b6j | `modelTrajectory.ts` | 读取入口、delta 展开、内容映射、弱校验 | 99 |
| b6k/b6l/b6m | 同上 | 补厚（日志、tail 语义、标题提示反推） | 0 |
| b6n | `zcodeAgent.ts` | 上下文类型与 IZCodeAgentService 契约 | 92 |
| b6o/b6p/b6q | 同上 | 其余参数接口补厚 | 3 |
| b6r | `zcodeProtocolClient.ts` | 在飞请求表、超时/abort、存储门禁、批量拒绝 | 76 |
| b6s | `zcodeAgentConnectionScope.ts` | 可信 carrier、路由键、流控串行队列、占位与帧暂存 | 79 |
| b6t | 同上 | 流控转发、owner 顶替、退订顺序、ACK 收口 | 71 |
| b6u/b6v | 同上 | runtime 失效清理、握手、命令/附件守卫、dispose | 70 |

> 分段表按 spec 文件统计；同一文件多段合计等于上表新增。

## 3. 校验原文

```text
node d:\code\_annot_baseline\zc-verify.mjs ZC-deep-svc-b6
SUMMARY files=6 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=1018
```

```text
node d:\code\_annot_baseline\deep-density.mjs d:\code\ZCode \
  --baseline d:\code\_annot_baseline\ZC-deep-svc-base \
  --root packages/services/src/zcode-agent --ext .ts --mode code --threshold 30

30.16  zcodeTaskIndexSyncer.ts
30.29  zcodeAgentProcessManager.ts
30.53  zcodeAgent.ts
30.70  zcodeAgentConnectionScope.ts
30.89  modelTrajectory.ts
32.02  zcodeProtocolClient.ts
```

目录复测（b6 后）：`files=38 coreBelow30=29 needLines=589`，剩余缺口集中在
`zcodeAgentPluginParams.ts`（241 行）、`cuaOperationTurnTracker.ts`（338 行）、
`zcodeStdioTransport.ts`（401 行）等中小文件（原始缺口，非密度列）。

## 4. 本批锚定的不变量

- `zcodeTaskIndexSyncer.ts`：`indexSeq` 只在 `fromSeq === indexSeq` 时推进；`snapshot` 与首个
  logical 帧是唯一可建立 base 的两条路径；`subscriptionId` 是唯一的帧归属判据。
- `zcodeAgentProcessManager.ts`：`processesByWorkspaceKey` 只存活跃实例，回收所有权在
  `ownedProcesses`；`spawn` 事件之后才允许上报 ready/restarted；清理只认首次原因。
- `zcodeAgentConnectionScope.ts`：可信字段必须先删后写；`owned` 的 `ownershipKey` 是替换单元；
  `closed` 必须早于 `unsubscribe`；ACK 只能回放 `subscriptionId` 匹配的帧。
- `modelTrajectory.ts`：`tail` 是新起点不是断点；`offset` 之后才是 delta 覆盖区间。
- `zcodeProtocolClient.ts`：`pending` 是唯一在飞事实；超时先删表再上报；存储门禁等待发生在建请求之前。

## 5. 看似该改、其实不能改

- `available` 分支不能推进 runtime 代际：首次冷启动会先 available 再 ACK，推进会误杀合法 ACK。
- 首帧基线不能广播：纯 V4 UI 冷启动会因此闪出一批历史任务行。
- 空 `configOptions` 不能下发：会让模型选择器被清空。
- `attachmentBeginV4` 的 ACK 晚于 close 时不能只抛错：必须先 abort，否则 CLI 留下 TTL 半上传。
- `queryConversationCommandsV4` 的 clock 探测不能绑定 workspace：否则会抢占业务查询的绑定。
