# SVC-B7 深度注释索引（zcode-agent 中批收口）

> 规范母本：`d:\code\opensource\redb\docs\annotation\DEEP-SPEC.md`（v1）
> 范围：`packages/services/src/zcode-agent/**` 中缺口较大的 15 个文件（单批 ≤15）。
> 口径：注释行 ÷ 代码行 ≥ 30%（`deep-density.mjs --mode code --threshold 30`）。

## 1. 结果

| 文件 | 代码行 | 注释行（前→后） | 密度 | 新增 |
| --- | ---: | --- | ---: | ---: |
| `zcodeStdioTransport.ts` | 329 | 48 → 121 | 36.78% | 73 |
| `cuaOperationTurnTracker.ts` | 287 | 22 → 88 | 30.66% | 66 |
| `zcodeSessionEventCoalescer.ts` | 174 | 6 → 56 | 32.18% | 50 |
| `zcodeAgentPluginParams.ts` | 199 | 14 → 61 | 30.65% | 47 |
| `topicResourceRelay.ts` | 134 | 2 → 43 | 32.09% | 41 |
| `groupRuntimeSnapshot.ts` | 119 | 4 → 38 | 31.93% | 34 |
| `zcodeAgentBrowserAmbientContext.ts` | 122 | 5 → 37 | 30.33% | 32 |
| `zcodeStorageStartupGate.ts` | 103 | 3 → 34 | 33.01% | 31 |
| `topicResourceUpload.ts` | 83 | 1 → 27 | 32.53% | 26 |
| `topicResourceRelayClient.ts` | 84 | 2 → 26 | 30.95% | 24 |
| `topicResourceRelayChannel.ts` | 77 | 1 → 24 | 31.17% | 23 |
| `groupAttachmentUpload.ts` | 79 | 3 → 26 | 32.91% | 23 |
| `topicResourceBridge.ts` | 72 | 4 → 22 | 30.56% | 18 |
| `topicResourcePeers.ts` | 67 | 3 → 21 | 31.34% | 18 |
| `zcodeV4HostCommand.ts` | 126 | 32 → 38 | 30.16% | 6 |
| **合计** | **2,055** | — | — | **512** |

> `zcodeStdioTransport.ts` 起始缺口最大（401 行原始缺口），一次性铺到 36.78%；
> 其余文件均落在 30.1%~33.0% 区间，不贴 30.00%。

## 2. 分段

| 段 | 文件 | 内容 | 新增 |
| --- | --- | --- | ---: |
| b7a | `zcodeStdioTransport.ts` | 帧边界、背压、写入串行、EOF/error 收口 | 73 |
| b7b/b7c | `cuaOperationTurnTracker.ts` | 三级 key 索引、水位、退役 FIFO、事件去重 | 66 |
| b7d | `zcodeAgentPluginParams.ts` | 市场移除/内置恢复参数补厚 | 4 |
| b7e/b7f | `zcodeSessionEventCoalescer.ts` | 聚合键、合并规则、flush 顺序、dispose 先刷后停 | 50 |
| b7g | `topicResourceRelay.ts` | 传输表、限流、base64 往返、checksum、释放 | 41 |
| b7h | `groupRuntimeSnapshot.ts` | 单次观察、连续 seq、终止判据、订阅/超时/释放 | 26 |
| b7h | `zcodeStorageStartupGate.ts` | 单写入入口、单调推进、ready/failed 终态 | 28 |
| b7h | `zcodeAgentBrowserAmbientContext.ts` | URL 消毒、iab 选择、双列表合并、失败降级 | 32 |
| b7i | `groupRuntimeSnapshot.ts` / `zcodeStorageStartupGate.ts` | 补厚（delta 语义、字段职责） | 7 |
| b7j | `topicResourceUpload.ts` | 绑定实际连接、四段请求、abort 独立通道 | 23 |
| b7j | `topicResourceRelayClient.ts` | token/signal 桥接、分片校验、checksum 闸门 | 24 |
| b7j | `topicResourceRelayChannel.ts` | 命令白名单、鉴权限流、取消登记、dispose 顺序 | 17 |
| b7j | `groupAttachmentUpload.ts` | 三种内容来源、上限、续传、commit/abort | 19 |
| b7k | 上述 3 文件补厚 | 请求字段职责、引用顺序、切片对齐 | 13 |
| b7l | `topicResourceBridge.ts` | 惰性依赖、在途登记、取消归属、清理 | 14 |
| b7l | `topicResourcePeers.ts` | 组合路由键、可信 carrier、Proxy 绑定、断连清理 | 17 |
| b7l | `zcodeV4HostCommand.ts` | HEX 查表、CAS 重试边界、stale 基线 | 6 |
| b7m | `topicResourceBridge.ts` / `topicResourcePeers.ts` | 补厚（销毁、重复请求、closed 单向） | 5 |

> 分段表按 spec 文件统计；同一文件多段合计等于上表新增。

## 3. 校验原文

```text
node d:\code\_annot_baseline\zc-verify.mjs ZC-deep-svc-b7
SUMMARY files=15 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=512
```

```text
node d:\code\_annot_baseline\deep-density.mjs d:\code\ZCode \
  --baseline d:\code\_annot_baseline\ZC-deep-svc-base \
  --root packages/services/src/zcode-agent --ext .ts --mode code --threshold 30

SUMMARY files=38 coreBelow30=14 needLines=115 min=0.00 median=30.54 newComments=5102
```

全 services 复测（b7 后）：

```text
SUMMARY files=467 coreBelow30=279 needLines=11264 min=0.00 median=11.80 newComments=17842
```

## 4. 本批锚定的不变量

- `zcodeStdioTransport.ts`：写入必须串行；EOF 只表示对端不再发送，不等于可立即强杀；
  背压期间不得丢弃已接受帧。
- `cuaOperationTurnTracker.ts`：`turnKey` 是事件归属的唯一判据；水位按 session 独立；
  退役集合只用于拒绝迟到事件，不参与活跃判定。
- `zcodeSessionEventCoalescer.ts`：只有可重组增量可以合并；结构化事件必须先 flush 再投递；
  `dispose` 必须先刷后停，否则正文会从下一段 delta 才开始显示。
- `topicResourceRelay.ts`：同一 `requestId` 只允许一条传输；`release` 是唯一释放路径；
  `expected` 代际防止迟到回调误删新条目。
- `groupRuntimeSnapshot.ts`：`fromSeq` 必须紧邻上一帧；`stopping` 不是终态；
  超时同时覆盖 ACK 与首帧。
- `zcodeStorageStartupGate.ts`：`sequence` 严格递增；`ready`/`failed` 终态不可回退；
  接受帧后才清首帧超时。
- `zcodeAgentBrowserAmbientContext.ts`：URL 只允许 about/http/https 且剥离 userinfo；
  仅 iab 后端参与采集；任何失败降级为 `undefined`。
- `topicResource*`：内容一律以对端字节为准并本地重算 checksum；上传/读取都必须绑定实际连接。
- `groupAttachmentUpload.ts`：`uploadId` 每附件唯一；`nextChunkIndex` 必须逐块推进；
  失败必须 abort。
- `zcodeV4HostCommand.ts`：CAS 命令必须带 `baseRevision`；`stale` 用 `revisionAtDecision`
  作下一轮基线；重试有界。

## 5. 看似该改、其实不能改

- `role !== "trusted-host-relay"` 分支的流控拒绝不能放宽：它保护的是不可信连接不得抢占队列。
- `begin` 的 `transfers.size >= 2` 不能改成 1 或无限：1 会让回执类传输无槽位，无限则无界缓存。
- `topicResourceRelayClient` 的 `cancel` 不能用已取消的 token：清理必须仍能到达对端。
- `zcodeStorageStartupGate.accept` 不能在非递增序号时"纠正"状态：跳跃说明进程代次已变。
- `zcodeSessionEventCoalescer` 不能对 `tool.updated` 的终态做合并：只合并 `progress`。
- `topicResourcePeers` 不能绕过 `readTrustedZCodeAgentV4Connection`：公共参数可伪造身份。
- `groupAttachmentUpload` 的 abort 失败不能覆盖原始错误：abort 只是尽力清理。
