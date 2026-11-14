# ZC-DEEP-svc-b1：botsService L1 深度注释索引

> 范围：`packages/services/src/bots/botsService.ts`（9,913 行）。
> 基线：`d:\code\_annot_baseline\ZC-deep-svc-b1\packages\services\src\bots\botsService.ts`。
> 规范：`d:\code\opensource\redb\docs\annotation\DEEP-SPEC.md` v1；作业说明：同批 `BRIEF.md`。
> 硬约束：只新增整行 `//` 注释；相对基线 `deletedNonZero=0`；新增注释无 `*/`；`parseDiagnostics=0`；不做 git 提交。

## 结果

| 指标 | 基线 | 本批后 |
| --- | ---: | ---: |
| 总行 | 9,913 | 13,317 |
| 代码行 | 9,336 | 9,336 |
| 注释行 | 337 | 3,741 |
| 注释 / 代码行 | 3.61% | **40.07%** |
| 注释 / 总行 | 3.40% | 28.09% |
| 新增注释行 | — | **3,404** |

校验：`deep-density` `coreBelow30=0`、`needLines=0`、`newComments=3404`；`git diff --no-index --numstat` = `3404 0`；新增行非注释数 0；TypeScript `parseDiagnostics=0`。

## 分段明细

| 段 | 原行范围 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | --- | ---: |
| seg1 | 1–1412 | 文件头、imports、常量、纯函数、工厂初始化 | INV-01…INV-12 表；职责边界（正文归 CLI）；流式卡片/typing/附件/重连阈值失效后果；模型值编解码回退；状态写入串行链 | +443 |
| seg2 | 1413–2901 | 私有/群同步、附件、模型与配置选择 | `serializeStateWrite` 二次读；订阅键与旧订阅 dispose 顺序；附件先校验后落盘；远程未连接 fail-closed；模型选择显式值不被改写 | +462 |
| seg3 | 2902–3687 | 群投递 sender、入站幂等、typing、live status | sender 授权八条件复核；投递键占位/释放与 2min TTL；会话级入站串行队列；typing 双表生命周期；同 kind 拼接/切换重置 | +405 |
| seg4 | 3688–4501 | terminal meta、provider callback、回复块、elicitation schema | 终态事件与 meta 对齐；400/401/403/503 返回码；卡片回调 deferred 判定；token 只作交互凭据不作安全边界；保留 id 约定 | +457 |
| seg5 | 4502–6107 | elicitation 交互、话题输入、流订阅前半 | 选项 id 契约；ownership/handledAt/清理顺序；`__form__:` 合并；投递幂等键；流式卡片节流/超时/熔断；run 归属 | +406 |
| seg6 | 6108–7164 | 远程重连、命令鉴权、群输入 admission | 重连双窗口去重；7 层鉴权 STEP；绑定码消费时序；确定性 commandId；accepted 回写与终态清理 | +292 |
| seg7 | 7165–8146 | 话题续接、prompt 后台发送、自动化投递 | fire-and-forget 失败兜底；`(workspaceKey, taskId, executionId)` 身份；代际栅栏；群 auto-reply 额度原子性；waiter 兑现顺序 | +338 |
| seg8 | 8147–8665 | 对外公开方法面 | 凭据先写后引用/删除顺序；topic 先授权后读；group result 仅 unknown 可对账；secret 孤儿清理风险 | +258 |
| seg9 | 8666–9913 | `handleInboundMessage`、provider callback、dispose | 七段流水线顺序不可交换；幂等键先占位后副作用；accepted 输入 terminal 回执；`/leave` 顺序；dispose 幂等与定时器收尾 | +343 |
| **合计** | 9,913 | — | — | **+3,404** |

## 本批标注的代码风险（仅注释，未改代码）

1. `writeBotConfig` 配置与 state 两步非事务，崩溃窗口内可能出现“绑定已变、群授权仍可用”，无启动期补偿扫描。
2. `releaseInboundDelivery` 在“业务已执行、出站发送失败”时也归还幂等键并返回 503，平台重投可能重复执行命令。
3. 私聊附件超过 4 个时 `slice` 静默截断，与 INV-06“超限走用户可见错误”不一致；下载先完整读入再判 5MB。
4. `enqueueInboundProcessing` 无超时，单个挂起任务会阻塞整会话的后续输入。
5. `startTyping` 缺少 dispose 后守卫，迟到流事件可能在清理后重建 interval。
6. `prepareCallbackPayload` 的附件下载发生在逐条 token 校验之前，存在“未授权先产生下载副作用”的张力。
7. `findCallbackBot` 无 `botId` 时回退到同 provider 首个启用 bot，多 bot 场景可能记错 bot。
8. `approve` 分支缺少 `handledAt` 防重；`deny` 分支对缺失 pending 用默认 deny 提交。
9. `topic.leave` 先落盘 `topicActive=false` 再停执行，停执行失败时用户看到失败但话题已退出。
10. `createBindCode` 的 `params.botId ?? params.botId` 自赋值无实效；绑定码仅 24 位熵且无失败次数限制。
11. `setGroupEnabled` 把 `actor.providerUserId` 直接设为 `bot.providerUserId`，owner 校验等于自证，依赖 RPC 层鉴权。
12. `resetBotState` 只清持久 context，不清话题准备/群 sender/绑定码等内存投影。

以上均为阅读结论，本批未改动任何代码 token。
