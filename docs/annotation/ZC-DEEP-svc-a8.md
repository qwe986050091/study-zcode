# ZC-DEEP-svc-a8 深度注释报告（渠道协议与完整性）

> 规范母本：`d:\code\opensource\redb\docs\annotation\DEEP-SPEC.md`（v2）
> 分诊计划：[ZC-DEEP-svc-triage.md](./ZC-DEEP-svc-triage.md) 渠道协议与完整性组。
> 范围：微信 iLink 适配、webhook 双向适配、会话分享完整性、V4 宿主命令信封。
> 口径：**内文率** = 函数体内整行中文注释 ÷ 函数体内代码行（`zc-inner.mjs`，AST trivia）。
> 硬约束：只加整行 `//` 中文注释；不改代码 token、缩进、import、字符串；清理阶段只删除/改写本批或未入库的自有注释行；不 git add / commit。

## 1. 结果

| 文件 | 代码行 | 内文（前→后） | 内文率（前→后） | 净增 |
| --- | ---: | --- | --- | ---: |
| `bots/providers/weixinProvider.ts` | 574 | 72 → 174 | 12.54% → 30.31% | 102 |
| `bots/providers/webhookProvider.ts` | 249 | 31 → 81 | 12.45% → 32.53% | 50 |
| `conversation-share/conversationShareIntegrity.ts` | 102 | 0 → 31 | 0.00% → 30.39% | 31 |
| `zcode-agent/zcodeV4HostCommand.ts` | 86 | 5 → 26 | 5.81% → 30.23% | 22 |
| **合计** | **1011** | **108 → 312** | **10.68% → 30.86%** | **205** |

文件级最低 30.23%，中位 30.39%；函数级最低 15.4%（`weixinProvider.test`，2/13），4 个文件全部满足「函数级 ≥15%、文件级 ≥30%」。

> 说明：相对 `HEAD` 的 `git diff --numstat` 为 309/145/49/28 行，其中含上一轮已写入但未提交的文件头注释；本批实际净增 205 行，另有 42 行自有注释按注水门禁改写（未新增行数）。

## 2. 补深方式

- 只解释语句组的四件事：在做什么、为什么必须这样、依赖什么前置条件、做错会出现什么现象；不对函数整体写排比式总结。
- 注释贴住紧邻代码行，同一事实只在一个位置说一次，避免与已有 JSDoc 重复。
- 轮询链与回灌链共用函数处，集中说明「两条链路口径必须一致」，不在两处各写一遍。

重点覆盖的故障面：

- `weixinProvider`：`get_updates_buf` 游标用 `??` 保留旧值、`message_id` 别名链与数字兜底、`item_list` 与 `attachments` 两个附件入口、`aes_key` 只放 `providerMetadata`、`sendmessage` 必须带 `message_state` 与 `context_token`、调用方未纳入 fetch 超时导致挂死（INV-04）。
- `webhookProvider`：`type` 精确匹配防止把普通文字当应答、4xx 不重试而 5xx 重试三次、`botId`/`userId` 缺失即丢弃（INV-01）、有 secret 才算可用（INV-05）、`providerMessageId` 缺失不回退合成。
- `conversationShareIntegrity`：JCS 键排序与代理对校验、`undefined` 成员显式拒绝、`artifacts` 摘出后才进 confirm 请求、`rawRows` 用原始值重算以避免误判篡改。
- `zcodeV4HostCommand`：uuidv7 的 version/variant 位、`baseRevision=0` 首轮探测、`accepted`/`duplicate`/`noop` 同归成功、stale 循环上限与放弃原因。

## 3. 校验原文

结构校验：

```text
node d:\code\_annot_baseline\zc-verify.mjs --rewrite ZC-deep-svc-a8
SUMMARY files=4 rewrittenSegments=39 deletedOwnCommentLines=42 codeTokenDiff=0 headTokenDrift=0 codeDeletion=0 upstreamCommentDeleted=0 literalCommentDeletion=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0
```

注水门禁：

```text
node d:\code\_annot_baseline\zc-gate.mjs --scan d:\code\_annot_baseline\ZC-deep-svc-a8\_files.txt
SUMMARY files=4 badFiles=0 addedCommentLines=531 waterLines=0 waterRate=0.00%
```

内文率复测：

```text
node d:\code\_annot_baseline\zc-inner.mjs --repo D:/code/ZCode --roots packages/services/src --only <4 个文件> --threshold 15 --fns 30
SUMMARY files=4 innerCode=1011 innerZh=312 below15=0 min=30.23 median=30.39
30.23%	26/86	packages/services/src/zcode-agent/zcodeV4HostCommand.ts
30.31%	174/574	packages/services/src/bots/providers/weixinProvider.ts
32.53%	81/249	packages/services/src/bots/providers/webhookProvider.ts
30.39%	31/102	packages/services/src/conversation-share/conversationShareIntegrity.ts
```

语义质量：

```text
node d:\code\_annot_baseline\deep-quality.mjs D:/code/ZCode --files <4 个文件> --quiet --top 20
SUMMARY files=4 units=585 coverage=39.5% branch=50.6% field=36.4% comments=598 substance=88.3% explain=100.0% filler=0.0% weak=0.0%
```

## 4. 锚定不变量

- 锚点取整行 `trim()` 后全文相等，重复行用 `nth`（本轮用到 `return payload;`、`const from = ...`、`.filter(...)`、`const filename =`、`const sizeBytes =` 两处同文行）。
- 锚点一律选在可执行语句行，不落在跨行模板字符串内部；`textLen=`/`hasUserId=`/`innerKeys=` 三处虽含反引号，但都是独立的单行模板字面量，只是数组元素行，插入注释不触及字符串内容。
- 插入点全部位于语句组之前，缩进由脚本沿用锚点行前缀，未改动任何代码 token；`zc-verify` 的 `codeTokenDiff=0`、`headTokenDrift=0` 即为验证。
- 42 行改写均落在「相对 HEAD 新增」的自有注释行上（不在 `git show HEAD:<file>` 内），改写只替换注释文本，未删除任何上游注释。

## 5. 看似该改其实不能改

- `weixinProvider` 的 `client_id`、`message_state`、`message_type` 字面量：注释只解释取值含义，不能把它们替换成常量或枚举——改动会破坏与服务端的协议字面量匹配。
- `sendmessage` 只在 adapter 内发送一次：看起来应在 `send` 里补超时重试，但重试策略由 runtime 统一持有，本地重试会产生 `client_id` 不同的两条消息。
- `readWeixinMessageId` 的 `String(numericId)`：看似可直接返回 number，但去重表按字符串建键，返回类型混用会漏判重复。
- `conversationShareIntegrity` 的 `sort` 前展开复制：不能为了省内存改成原地 `sort`，否则会改动调用方后续上传用的数组顺序。
- `buildConversationShareConfirmRequest` 的 `_artifacts` 解构：看似多余，实为把 `artifacts` 从 confirm 请求体中摘出，缺失会让服务端收到两份口径不同的列表。
- `zcodeV4HostCommand` 的 `baseRevision = 0` 首轮探测：不能改成读取本地缓存 revision，并发提交下会持续落后并反复 stale。
- `assertV4CommandAckOk` 把 `duplicate`/`noop` 视为成功：不能图省事只认 `accepted`，重放与晚到应答会被误判为失败而再次提交。
