# ZC-DEEP-svc-b3b：`bots/**` 其余 30 个文件深度注释索引

> 范围：`packages/services/src/bots/` 下除 `botsService.ts`、`providers/**` 之外的 30 个生产文件（`bots/providers` 已由 b3 完成，`botsService.ts` 已由 b1 完成）。
> 基线：`d:\code\_annot_baseline\ZC-deep-svc-b3b\orig\packages\services\src\bots\`，清单 `_files.txt`。
> 硬约束：只新增整行 `//` 注释；`deletedNonZero=0`；`nonCommentAdded=0`；`starSlash=0`；`syntaxErrorFiles=0`；不做 git 提交。
> 行尾：源码为 CRLF；插入脚本按 `\r\n` 切分与回拼，新增行同样以 CRLF 落盘，`git diff --numstat` 删除列全为 0。

## 结果

| 文件 | 基线注释/代码 | 完成后注释/代码 | 新增注释 | 验收 |
| --- | ---: | ---: | ---: | --- |
| `bots.ts` | 7 / 203 | 61 / 203 = **30.05%** | +54 | PASS |
| `telegramChannelRuntime.ts` | 18 / 392 | 118 / 392 = **30.10%** | +100 | PASS |
| `feishuChannelRuntime.ts` | 11 / 324 | 98 / 324 = **30.25%** | +87 | PASS |
| `replyFormatter.ts` | 6 / 382 | 117 / 382 = **30.63%** | +111 | PASS |
| `messages.ts` | 1 / 280 | 86 / 280 = **30.71%** | +85 | PASS |
| `config.ts` | 4 / 81 | 25 / 81 = **30.86%** | +21 | PASS |
| `topicResource.ts` | 2 / 154 | 48 / 154 = **31.17%** | +46 | PASS |
| `topicHistoryAttachment.ts` | 1 / 70 | 22 / 70 = **31.43%** | +21 | PASS |
| `botConfigHelpers.ts` | 3 / 114 | 36 / 114 = **31.58%** | +33 | PASS |
| `commandParser.ts` | 0 / 114 | 36 / 114 = **31.58%** | +36 | PASS |
| `channelRuntime.ts` | 11 / 257 | 82 / 257 = **31.91%** | +71 | PASS |
| `topicPreparationState.ts` | 2 / 72 | 23 / 72 = **31.94%** | +21 | PASS |
| `repo.ts` | 3 / 90 | 29 / 90 = **32.22%** | +26 | PASS |
| `statusFormatting.ts` | 6 / 158 | 52 / 158 = **32.91%** | +46 | PASS |
| `weixinChannelRuntime.ts` | 15 / 317 | 107 / 317 = **33.75%** | +92 | PASS |
| `workspaceHelpers.ts` | 0 / 109 | 37 / 109 = **33.94%** | +37 | PASS |
| `channelReply.ts` | 6 / 215 | 73 / 215 = **33.95%** | +67 | PASS |
| `topicContinuation.ts` | 5 / 102 | 35 / 102 = **34.31%** | +30 | PASS |
| `storageMigration.ts` | 4 / 81 | 28 / 81 = **34.57%** | +24 | PASS |
| `groupResultDelivery.ts` | 4 / 86 | 31 / 86 = **36.05%** | +27 | PASS |
| `channelMentionResolver.ts` | 4 / 94 | 36 / 94 = **38.30%** | +32 | PASS |
| `groupSessions.ts` | 2 / 31 | 12 / 31 = **38.71%** | +10 | PASS |
| `topicHistory.ts` | 7 / 83 | 33 / 83 = **39.76%** | +26 | PASS |
| `groupQueueCard.ts` | 1 / 47 | 19 / 47 = **40.43%** | +18 | PASS |
| `taskStreamHub.ts` | 1 / 49 | 20 / 49 = **40.82%** | +19 | PASS |
| `groupAdminAttention.ts` | 3 / 47 | 20 / 47 = **42.55%** | +17 | PASS |
| `commandOrder.ts` | 0 / 15 | 8 / 15 = **53.33%** | +8 | PASS |
| `groupDeliveryThrottle.ts` | 2 / 10 | 7 / 10 = **70.00%** | +5 | PASS |
| `modelSelectionHelpers.ts` | 0 / 10 | 7 / 10 = **70.00%** | +7 | PASS |
| `groupReply.ts` | 1 / 9 | 8 / 9 = **88.89%** | +7 | PASS |
| **合计** | 130 / 3,996 = 3.25% | 1,314 / 3,996 = **32.88%** | **+1,184** | — |

## 分段明细

| 段 | 文件 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| seg1 | `commandOrder` `modelSelectionHelpers` `groupDeliveryThrottle` `groupReply` `taskStreamHub` `groupQueueCard` `groupSessions` `groupAdminAttention` `topicPreparationState` `topicHistoryAttachment` | 命令排序与模型选择；群投递节流窗口；按 taskKey 单订阅 + 多 target 扇出（allSettled）；群卡片状态互斥；话题准备态与历史附件复用 | +115 |
| seg2 | `botConfigHelpers` `repo` `bots` `config` `storageMigration` `topicResource` `topicContinuation` `topicHistory` `commandParser` `workspaceHelpers` | 配置补全与默认值；repo 原子写与 schema 校验；存储迁移幂等；话题授权必须绑定 threadId；续聊与历史窗口；命令解析边界；workspace 路径解析 | +337 |
| seg3 | `messages` `statusFormatting` | 双语字典逐键语义；状态流文本的时间/耗时/工具摘要口径 | +131 |
| seg4 | `channelMentionResolver` `groupResultDelivery` `channelReply` | mention 最长 key 优先与可信来源；群结果分段投递；回复 parts 归一与 trusted 判定 | +131 |
| seg5 | `channelRuntime` | 跨窗口文件锁（目录 + owner + lease + 心跳）、连接指纹、最新代次刷新队列、waitFor 可取消等待 | +71 |
| seg6 | `replyFormatter` | 3500 字符切分；工具状态单向终结；权限标题四类归一；变更摘要 10 项上限与显式计数 | +111 |
| seg7 | `feishuChannelRuntime` | WebSocket 连接生命周期；acquire 失败可恢复；race(abort, terminated)；清理后退避 | +87 |
| seg8 | `telegramChannelRuntime` | 长轮询 40s 超时；deleteWebhook；offset 逐条确认；409 退避 10s | +100 |
| seg9 | `weixinChannelRuntime` | get_updates_buf 批后提交；attachments/context_token 透传；凭据换代先停后启 | +92 |
| **合计** | — | — | **+1,184** |

## 校验输出原文

```text
SUMMARY files=42 coreBelow30=0 needLines=0 min=30.05 median=35.27 newComments=6496
PASS: all 42 file(s) >= 30% (mode=code)
```

```text
SUMMARY files=30 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=1184
```

逐文件 `git diff --no-index --numstat` 删除列均为 0，新增列合计 1,184，与 `deep-density` 的 `newComments` 逐文件一致。

全目录重测（`packages/services/src`，467 文件）：

```text
SUMMARY files=467 coreBelow30=387 needLines=18737 min=0.00 median=5.83 newComments=10068
```

相对 b3 收口：`coreBelow30 417 → 387`（本批 30 个文件全部达标）、`needLines 19,820 → 18,737`（−1,083）、`median 5.08% → 5.83%`、累计 `newComments 8,884 → 10,068`。

## 本批重点不变量

1. **任务流扇出**（`taskStreamHub.ts`）：同一 taskKey 只允许一条 upstream；target 逐个串行消费，用 `allSettled` 保证单渠道失败不阻断其他渠道；dispose 必须先校验 listener 仍为当前绑定，防止旧句柄误删新监听器。
2. **跨窗口锁**（`channelRuntime.ts`）：锁由目录 + `owner.json` + `lease-<nonce>` + 心跳组成；租约过期才允许接管，不能仅凭文件存在判断存活。
3. **连接指纹**（三个渠道 runtime）：指纹 = provider + 凭据引用 + 凭据内容；轮换凭据必须先 stop 再 start，旧连接不能继续消费。
4. **Telegram offset**：`update_id` 是外部队列确认点，必须逐条回调成功后才写 `update_id + 1`；回调失败绝不推进。
5. **Weixin buf**：`get_updates_buf` 只在整批消息全部回调成功后提交；重新包装 inbound 时 `attachments` 与 `context_token` 必须原样透传。
6. **飞书 WebSocket**：首次 ready 不是生命周期终点，SDK 重连耗尽必须进入 catch；退避前必须已关闭 client 并释放锁。
7. **消息文本**：单条回复上限 3500 字符；工具状态 completed/failed/denied/stopped 之后不再变更；权限标题必须还原为写入/更新/删除/编辑四类。

## “看起来该改其实不能改”的点

1. `telegramChannelRuntime` 长轮询请求超时设 40s 看似过长；服务端最长 25s，必须覆盖响应体读取，否则半开连接会长期占锁。
2. Telegram 收到 409 时退避 10s 而非指数退避；409 表示同一 token 被另一客户端占用，固定窗口重试足够，指数退避只会延长恢复时间。
3. `weixinChannelRuntime` 失败后固定 5s 重试看似简单粗暴；微信侧限流窗口固定，指数退避不会更快恢复。
4. `weixinChannelRuntime` 只在 `result.buf` 非空时提交游标，看似可能漏更新；空 buf 表示服务端无新游标，写入空串会让下一轮从头拉取。
5. `topicResource` 强制要求 `threadId`，看似可以退化为按群 ID 授权；话题群内不同话题是独立会话边界，退化会导致跨话题串消息。
6. `channelRuntime` 用目录 + owner + lease 三重文件而非单个锁文件，看似繁琐；单文件无法区分“崩溃残留”和“仍在运行”，租约是唯一可安全接管的依据。
7. `replyFormatter` 变更摘要只列 10 个文件并显式计数，看似应该全量列出；渠道消息有长度上限，静默截断会误导用户。
8. `messages.ts` 的键必须中英一一对应，看似可以只补中文；缺失英文键会回落到中文，破坏非中文用户的整条消息。
9. `channelMentionResolver` 按最长 key 优先匹配，看似可以按出现顺序；短 key 前缀相同会截断长 mention，导致 @ 错人。
10. `groupDeliveryThrottle` 节流窗口不随消息量放大，看似会丢消息；节流只合并展示卡片，实际投递仍逐条排队。

以上均为阅读结论，本批未改动任何代码 token。
