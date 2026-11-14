# ZC-DEEP-svc-b3：bots/providers 渠道适配 L1 深度注释索引

> 范围：`packages/services/src/bots/providers/` 下 11 个生产文件。
> 基线：`d:\code\_annot_baseline\ZC-deep-svc-b3\packages\services\src\bots\providers\`；作业说明：同批 `BRIEF.md`。
> 硬约束：只新增整行 `//` 注释；`deletedNonZero=0`；新增行非注释=0；新增注释无 `*/`；`parseDiagnostics=0`；不做 git 提交。
> 行尾：本目录源码为 CRLF，合并时保留 CRLF；新增注释行同样以 CRLF 落盘。

## 结果

| 文件 | 基线注释/代码 | 完成后注释/代码 | 新增注释 | 基线缺口 | 验收 |
| --- | ---: | ---: | ---: | ---: | --- |
| `feishuProvider.ts` | 91 / 2,729 = 3.33% | 1,054 / 2,729 = **38.62%** | +963 | 728 | PASS |
| `weixinProvider.ts` | 10 / 622 = 1.61% | 217 / 622 = **34.89%** | +207 | 177 | PASS |
| `telegramProvider.ts` | 10 / 517 = 1.93% | 183 / 517 = **35.40%** | +173 | 146 | PASS |
| `webhookProvider.ts` | 2 / 276 = 0.72% | 97 / 276 = **35.14%** | +95 | 81 | PASS |
| `feishuAppRegistration.ts` | 3 / 176 = 1.70% | 96 / 176 = **54.55%** | +93 | 50 | PASS |
| `weixinRegistration.ts` | 2 / 167 = 1.20% | 82 / 167 = **49.10%** | +80 | 49 | PASS |
| `types.ts` | 0 / 122 = 0.00% | 107 / 122 = **87.70%** | +107 | 37 | PASS |
| `feishuGroupMessages.ts` | 8 / 140 = 5.71% | 84 / 140 = **60.00%** | +76 | 34 | PASS |
| `groupMemberDirectory.ts` | 1 / 44 = 2.27% | 36 / 44 = **81.82%** | +35 | 13 | PASS |
| `providerRequest.ts` | 8 / 67 = 11.94% | 50 / 67 = **74.63%** | +42 | 13 | PASS |
| `groupInputReaction.ts` | 1 / 42 = 2.38% | 38 / 42 = **90.48%** | +37 | 12 | PASS |
| **合计** | 136 / 4,802 = 2.83% | 2,044 / 4,802 = **42.57%** | **+1,908** | 1,340 | — |

## 分段明细

| 段 | 文件/范围 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | --- | ---: |
| feishu seg1 | 1–1456 | 常量、token、事件解析、卡片构造、附件元数据 | token 缓存 key 与 60s 提前量；双字段兼容；卡片元素预算；`__form__:` 重组；INV-08/INV-06/INV-11 | +545 |
| feishu seg2 | 1457–2911 | 发送/更新/撤回、typing、WebSocket、群成员、话题历史 | message_id 回填；PATCH 不重试；close 幂等；卡片按钮 value 只作路由；附件双 signal 与 30s 定时器 | +418 |
| weixin | 1–674 | 长轮询、AES 媒体、解析、发送、typing | 90s 长轮询与游标 `||` 语义；AES 三态密钥；无 message_id 回填；ticket 现取 | +207 |
| weixinreg | 1–184 | 扫码注册状态机 | 五态映射；超时→pending；空 token→error；历史拼写 `scaned` 兼容 | +80 |
| telegram | 1–560 | Bot API 收发、按钮、附件、命令菜单 | update 两种包装；callback_data 64 字节与序号编码；Markdown 降级；30s 共享 deadline | +173 |
| webhook | 1–290 | 通用 webhook 收发 | 选择命令编码；2xx/4xx/5xx 与三轮退避；无整体超时；鉴权头归属 | +95 |
| types | 1–130 | `BotProviderAdapter` 契约 | “方法缺失=不支持 / 返回 null=本次失败”不可互换；`send` void 与 handle 两态；`sealed` 节流窗口 | +107 |
| feishuapp | 1–192 | 飞书应用注册 | init→begin→poll；双域 `tenant_brand`；fail-closed 鉴权方式；稳定状态映射 | +93 |
| feishugroup | 1–154 | 群消息/卡片/mention 解析 | mention key 与 open_id 双口径；最长 key 优先；卡片白名单下钻避免 value 泄漏 | +76 |
| memberdir | 1–46 | 群成员分页 | Promise 单飞缓存；原型污染防护；游标环检测；近似 LRU | +35 |
| request | 1–80 | fetch 封装 | 外部 signal 合并；deadline 覆盖响应体；JSON 失败仅在 ok 时重抛 | +42 |
| reaction | 1–45 | 群输入 reaction | rank 只进不退；终态互斥防闪烁；失败仍归属本次调用者 | +37 |
| **合计** | — | — | — | **+1,908** |

## 校验输出原文

```text
34.89	881	622	217	207	packages/services/src/bots/providers/weixinProvider.ts
35.14	385	276	97	95	packages/services/src/bots/providers/webhookProvider.ts
35.40	733	517	183	173	packages/services/src/bots/providers/telegramProvider.ts
38.62	3874	2729	1054	963	packages/services/src/bots/providers/feishuProvider.ts
49.10	264	167	82	80	packages/services/src/bots/providers/weixinRegistration.ts
54.55	285	176	96	93	packages/services/src/bots/providers/feishuAppRegistration.ts
60.00	230	140	84	76	packages/services/src/bots/providers/feishuGroupMessages.ts
74.63	122	67	50	42	packages/services/src/bots/providers/providerRequest.ts
81.82	81	44	36	35	packages/services/src/bots/providers/groupMemberDirectory.ts
87.70	237	122	107	107	packages/services/src/bots/providers/types.ts
90.48	82	42	38	37	packages/services/src/bots/providers/groupInputReaction.ts
SUMMARY files=11 coreBelow30=0 needLines=0 min=34.89 median=54.55 newComments=1908
PASS: all 11 file(s) >= 30% (mode=code)

[feishu]    963  0  plus=963 minus=0 nonComment=0 star=0
[weixin]    207  0  plus=207 minus=0 nonComment=0 star=0
[weixinreg]  80  0  plus=80  minus=0 nonComment=0 star=0
[telegram]  173  0  plus=173 minus=0 nonComment=0 star=0
[webhook]    95  0  plus=95  minus=0 nonComment=0 star=0
[types]     107  0  plus=107 minus=0 nonComment=0 star=0
[feishuapp]  93  0  plus=93  minus=0 nonComment=0 star=0
[feishugroup] 76 0  plus=76  minus=0 nonComment=0 star=0
[memberdir]  35  0  plus=35  minus=0 nonComment=0 star=0
[request]    42  0  plus=42  minus=0 nonComment=0 star=0
[reaction]   37  0  plus=37  minus=0 nonComment=0 star=0
TypeScript parseDiagnostics=0（11 个文件全部）
```

全目录重测：`coreBelow30 428 → 417`，`needLines 21160 → 19820`，`median 4.92% → 5.08%`，累计 `newComments=8884`（b1+b2+b3）。

## “看起来该改其实不能改”的点

1. 微信 `readNextBuf` 用 `||` 把空串游标折叠成 `undefined`，看似可改 `??`；改了会让首轮空游标变成非法值并重放历史。
2. 微信 `send` 丢弃响应体、不回填 message_id，看似违反 INV-02；协议本身不返回 id，伪造 id 比缺 id 更危险。
3. 飞书 `downloadAttachment` 无大小上限，看似该在本层加；5MB 上限归属 botsService 的统一策略，本层再加会形成双口径。
4. 飞书 `typingReactionIds` 无 TTL，看似泄漏；reaction 撤销依赖平台返回的 id，TTL 清理会留下无法删除的表情。
5. Telegram 按钮只编码序号，看似脆弱；`callback_data` 64 字节限制决定了不能塞完整 option id。
6. Webhook 入站 secret 头固定 `x-zcode-bot-secret`，看似与出站可配置头不一致；header 由 server 层提取，单边改会破坏协议契约。
7. `postWebhookWithRetry` 对 5xx 重试三次，看似对非幂等下游危险；这是 webhook 渠道既定投递语义，去重责任在接收方与 `providerMessageId`。
8. `groupInputReaction` 终态同 rank 互斥，“失败后取消”不改写为 cancelled，看似漏更新；这是避免终态闪烁的有意取舍。
9. 飞书卡片按钮 `value` 只作路由、不校验，看似越权入口；ownership/pending 校验必须在 botsService，适配层无法判断。
10. `feishuAppRegistration` 空 `client_secret` 落 pending，看似可能无限轮询；`expiresAt` 由调用方消费是既定契约，本层自行终止会掩盖服务端状态。

以上均为阅读结论，本批未改动任何代码 token。
