# ZC-DEEP-svc-p2b：P2 协议状态机收窄批次

> 范围：`ZC-DEEP-svc-triage.md` A 档 P2 中的「消息/连接的顺序与确认」子集。
> 收窄标准：只做应答与状态推进的先后、ack 与重试的边界、超时与幂等的交互。
> 不做：纯配置读取、编码转换、日志转发、路径遍历、哈希与策略判定。
> 口径：**内文率 = 函数体内部整行中文注释行 ÷ 函数体内部代码行**（`zc-inner.mjs`，AST trivia + 字符覆盖掩码）。
> 代码零改动：`zc-verify` 的 `codeTokenDiff/codeDeletion/upstreamCommentDeleted` 全 0。

## 1. 本批做与不做

### 1.1 已做（9 文件）

| 文件 | 本批补的顺序/确认点 |
| --- | --- |
| `bots/providers/weixinProvider.ts` | `requestWeixinJson` 不做本地重试：重发会换 `client_id` 变成两条消息；`getWeixinUpdates` 的 `messages` 与 `buf` 必须同批返回，先存游标会永久跳过本批 |
| `bots/providers/webhookProvider.ts` | `send` 的 2xx 只代表对端接收，不得据此写「已送达」终态 |
| `bots/groupDeliveryThrottle.ts` | 只保证发送起点间隔、不保证完成顺序；失败不回滚已占用的时间片 |
| `zcode-agent/zcodeV4HostCommand.ts` | duplicate/noop 是幂等成功，不得再推进状态或重发；ACK 是唯一状态推进依据，返回前不写本地投影 |
| `cua-permission-broker/cuaAgentAdmissionGate.ts` | 放行只解除屏障、不代表 spawn 成功；commit 与 fail 对同一 epoch 互斥，迟到路径返回 false |
| `session/automationCron.ts` | 补执行返回 `from` 而不是 `previousRun`，避免 `run_id` 撞车；相对延迟必须用服务端锚点 |
| `project/autoArchiveScheduler.ts` | 归档写事务不重试、失败留待下一轮；补扫先置空 `queued` 再重入 `scan`，避免漏掉设置变更 |
| `session/automationIntervalCarrier.ts` | 校验必须先于强制归一化；`scheduleRule: null` 是清除语义，不能与 carrier 并存 |
| `cua-permission-broker/stableCuaTransport.ts` | 复核后无顺序/确认缺口，未加行（单飞、失败缓存、成功永久缓存已在既有注释中写明） |

### 1.2 未做及理由

| 文件 | 理由 |
| --- | --- |
| `highspeed/highspeedCardService.ts` | 主要是缓存与 JWT 拼接，属编码/凭据构造，不在「消息顺序与确认」内 |
| `conversation-share/conversationShareIntegrity.ts` | 摘要规范化与哈希比对，不是 ack/重试 |
| `model-provider/providerRuntime.ts` | 单例装配与 Registry，属生命周期装配，不是消息确认 |
| `bots/repo.ts`、`bots/config.ts` | v3 仓储与默认值归一，属配置读取 |
| `skills/skillDiscoveryWalk.ts` | 目录遍历与软链边界，属路径安全 |
| `collection.ts` | 暴露策略装配，属配置 |
| `zcode-agent/automationToolPolicy.ts` | 策略判定，不是协议状态机 |
| `weixinProvider` 的 `parseWeixinAesKey`、`inferMimeTypeFromFilename`、`decryptWeixinCdnMedia` | 编码/解密，按本轮约束明确跳过 |
| 两文件的字段读取器（`readWeixinUserId` 等） | 纯字段提取，无顺序语义，不为数字硬填 |

## 2. 逐文件函数级内文率前后值

| 文件 | 前 | 后 | 增量 |
| --- | ---: | ---: | ---: |
| `bots/providers/weixinProvider.ts` | 174/574（30.31%） | 178/574（31.01%） | +4 |
| `session/automationCron.ts` | 70/226（30.97%） | 73/226（32.30%） | +3 |
| `bots/providers/webhookProvider.ts` | 81/249（32.53%） | 83/249（33.33%） | +2 |
| `zcode-agent/zcodeV4HostCommand.ts` | 26/86（30.23%） | 30/86（34.88%） | +4 |
| `cua-permission-broker/stableCuaTransport.ts` | 11/31（35.48%） | 11/31（35.48%） | 0 |
| `project/autoArchiveScheduler.ts` | 24/60（40.00%） | 27/60（45.00%） | +3 |
| `cua-permission-broker/cuaAgentAdmissionGate.ts` | 29/66（43.94%） | 32/66（48.48%） | +3 |
| `session/automationIntervalCarrier.ts` | 17/39（43.59%） | 20/39（51.28%） | +3 |
| `bots/groupDeliveryThrottle.ts` | 6/10（60.00%） | 9/10（90.00%） | +3 |
| **合计** | **438/1,341（32.66%）** | **463/1,341（34.53%）** | **+25** |

- 9 文件函数级最低值从 28.4%（`weixinProvider.readNumberOrString`）升至 31.01% 的文件级下限；`groupDeliveryThrottle` 的匿名箭头函数内文率 114.3%（8 行注释 / 7 行代码），因为该函数本身只有一行 `await`。
- `stableCuaTransport` 的 0 增量是结论而非遗漏：三个函数（单飞解析、字段映射、测试重置）没有 ack/重试顺序可补，硬加会变成复述。

## 3. 顺序与确认的具体结论

### 3.1 微信轮询与发送

- `getWeixinUpdates` 返回的 `messages` 与下一页游标 `buf` 必须由调用方同批处理：先持久化 `buf`、再处理 `messages`，一旦处理失败本批就永久跳过；先处理消息、后持久化 `buf`，最坏只是重复拉取，由上层按 `providerMessageId` 去重。因此游标只能随结果返回，adapter 内不能先推进。
- `requestWeixinJson` 不内置重试：HTTP 200 + `ret != 0` 已转成异常，重试节奏统一由 runtime 决定。若在 adapter 内重发 `sendmessage`，两次调用会生成不同的 `client_id`，服务端按两条消息处理。
- `send` 的 `ret == 0` 只代表服务端受理，响应里没有 `message_id`，上层不能把它记成「已送达」。

### 3.2 webhook 发送

- `send` 的 2xx 是传输层确认，不是业务送达确认；对端稍后处理失败时，本地若已写终态就无法回退。
- `postWebhookWithRetry` 只对 5xx 与网络异常重试，4xx 立即返回。5xx 可能发生在对端已接收之后，接收方必须按 `providerMessageId` 去重，否则重试会产生重复投递。

### 3.3 zcode V4 信封与 ACK

- ACK 是唯一状态推进依据：`sendHostCasCommandV4` 返回前不写本地投影，否则 stale/failed 之后本地会领先服务端，下一轮重试的 `baseRevision` 也随之失真。
- `accepted` / `duplicate` / `noop` 都是成功：`duplicate` 是同 `commandId` 的重试已落账，`noop` 是交互已被另一路收口；两者都不能再触发状态推进或重发。

### 3.4 CUA 准入门与单飞传输

- `commitRecovery` 只解除屏障，不代表 Agent 启动成功；等待者恢复后仍要自行处理 spawn 失败。
- `commitRecovery` 与 `failRecovery` 对同一 epoch 互斥：谁先清 `activeEpoch` 谁生效，迟到路径返回 false，不会双重终结。
- `stableCuaTransport` 的并发语义已在既有注释中完整：解析单飞、失败清空重试、成功永久缓存；本批复核未发现需要补的顺序点。

### 3.5 调度与间隔

- `computeInitialAutomationNextRunAt` 在宽限窗口内返回 `from` 而不是 `previousRun`：回填过去时间会让 `run_id` 与已结束的一轮撞车。
- `buildRelativeDelaySchedule` 的锚点必须取服务端当前时刻，否则同一任务两次重算会得到不同的下次触发。
- `autoArchiveScheduler` 的归档写事务不重试，失败留给下一轮；重扫依赖归档判定自身幂等。
- 补扫链在 `queued` 结算时必须先置空再调用 `scan()`，否则后来者会接到一个已完成的 Promise，漏掉这次设置变更。
- `automationIntervalCarrier` 的校验必须先于 `forceIntervalCarrierRecurring`：顺序反了会把本应被拒的输入洗成合法输入。

## 4. 复述型注释复核

本批在定稿前合并了 2 处自己写出的重复，没有保留「更正行」：

| # | 位置 | 问题 | 处理 |
| ---: | --- | --- | --- |
| 1 | `zcodeV4HostCommand.assertV4CommandAckOk` | 新增两行与上一行「三者都算成功…不能当失败重发」重复 | 把上一行改为定义状态集合，新增两行只讲状态推进与重复副作用 |
| 2 | `automationIntervalCarrier.assertValidAutomationIntervalCarrier` | 「校验必须先于 force」与 `forceIntervalCarrierRecurring` 的新增行重复 | 校验侧改为讲「只读函数的漏项会被下游归一化掩盖」的后果 |

定稿后复核：0 处复述、0 处写错对象。所有新增行都带真实标识符（`client_id`、`buf`、`providerMessageId`、`baseRevision`、`activeEpoch`、`run_id`）或谓词（必须/不能/会/导致）。

## 5. 验收

```text
node _annot_baseline/zc-verify.mjs --rewrite ZC-deep-svc-p2b
SUMMARY files=9 rewrittenSegments=0 deletedOwnCommentLines=0 codeTokenDiff=0 headTokenDrift=0
        codeDeletion=0 upstreamCommentDeleted=0 literalCommentDeletion=0 nonCommentAdded=0
        starSlash=0 syntaxErrorFiles=0
```

```text
node _annot_baseline/zc-gate.mjs --scan _annot_baseline/ZC-deep-svc-p2b/_files.txt
SUMMARY files=9 badFiles=0 addedCommentLines=707 waterLines=0 waterRate=0.00%
```

```text
node _annot_baseline/zc-stringscan.mjs D:/code/ZCode
SUMMARY repo=ZCode files=9818 hits=96 new=0 inHead=96 untracked=0
```

```text
node _annot_baseline/zc-inner.mjs --repo D:/code/ZCode --roots packages/services/src \
  --threshold 100 --top 9 --fns 999 --only <9 文件> --out _annot_baseline/ZC-p2-funcs-after.json
SUMMARY files=9 innerCode=1341 innerZh=463 below100=9 min=31.01 median=35.48
```

## 6. 边读边发现的缺陷

本批读到 3 个代码缺陷，已写入 `ZCode/docs/annotation/ZC-DEFECTS.md`，本批**未修**：

- D-05：`webhookProvider.postWebhookWithRetry` 的 `fetch` 无超时，对端挂起时 Bot 串行队列永久阻塞。
- D-06：`weixinProvider` 附件下载无超时、无大小上限，整包 `arrayBuffer` 进内存。
- D-07：`autoArchiveScheduler.dispose` 后仍在跑的扫描会继续归档并广播；`dispose` 注释声称「下一处 await 会看到 disposed」，但 `runOnce` 在 `archiveInactive` 之后并不复查。

P1 同类的 D-04（`markRunDispatch` 与 `markDispatched` 之间的崩溃窗口可导致同一 `runId` 重复派发）也补入了清单。D-04 与 `automationRepo.ts:1724` 现有注释「不会重复派发」冲突，修复时应改写该行，不要再追加更正句。

## 7. 收口状态

P2 收窄批次完成。A 档 P2 的其余 8 个文件按第 1.2 节理由留在未做清单，不占本轮余量。注释线到此收口；缺陷清单交由用户决定是否开修复批次。

遗留一处非代码问题：复核 P2 时读到 `session/offPeakTaskRepo.ts:775-779` 有一组近义重复注释（「缺 Provider 身份的历史行留在列表等待修复」连续出现两次），属 P1 批次遗留的复述。本批范围只含 9 个 P2 文件，未改动该行；如需清理，应在下一次注释批次里按一换一改写并重跑 P1 的 `zc-verify`。
