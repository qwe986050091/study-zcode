# FIX-B129：runner-diagnostics.ts 补深（安全边界优先）

## 批次定位

| 项 | 值 |
| --- | --- |
| 文件 | `apps/zcode-cli/packages/adapters/src/model/runner-diagnostics.ts` |
| 类型 | 关键文件补深（安全边界） |
| 基线快照 | `_annot_baseline/ZC-fix-b129/orig/...`（= B127 去重后的落盘版本） |
| 代码行 | 378（未变） |
| 内文率 | **1.32%（5/378）→ 30.69%（116/378）** |
| 新增注释行 | 152 |
| 注水率 | **0.00%**（`zc-gate --scan`：added=152 / water=0） |

本批只加注释行，代码 token 逐字未动：

```
SUMMARY files=1 rewrittenSegments=0 deletedOwnCommentLines=0 codeTokenDiff=0 headTokenDrift=0
        codeDeletion=0 upstreamCommentDeleted=0 literalCommentDeletion=0
        nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0
```

## 为什么先补这个文件

用户口径调整（2026-11-09）：注水队列清完当前这一遍即停，剩余 5.84% 不再专门清。
理由是该批 4 文件语句覆盖 17.5%、分支 13.8%、内文率 11.44%，八成代码无注释，
继续抠 0.03 个点的注水率不划算。往后新写行由 `zc-gate` 拦，人力转入覆盖度。

`runner-diagnostics.ts` 的请求头脱敏是安全边界，内文率 1.32% 意味着这条边界
在代码里几乎没有可读说明，因此作为补深第一优先。

## 脱敏边界：逐分支说明

### 1. `summarizeOutboundModelHeaders`（唯一输出出站头的位置）

- **脱敏的是什么**：只输出 `Object.keys(headers)`，即头的**键名**；所有头值一律不进入返回值。
- **漏了会泄露什么**：`Authorization`、`x-api-key`、`api-key`、`Cookie`、
  `Proxy-Authorization` 都是长期凭据。值一旦进日志，等于写进本地日志文件与远端上报链路，
  属于不可撤销的凭据泄露（INV-08）。
- **为什么在这个位置脱敏**：本函数是出站头的唯一出口，收敛后调用点无法自行拼出原始
  `headers`；且它只在 `logStreamDiagnostics` 的 suspicious 空完成 warn 分支被调用——
  正常 path 的 info 日志根本不接触 headers，风险压在低概率分支上。
- **为什么保留键名**：键名不含秘密，却能说明鉴权头是否被正确注入、有没有多余头被带出，
  是排障需要的最小信息。
- **`summarizeRequestVerificationHeaders`**：来自 `@zcode/shared`，只返回存在性/指纹字段，
  不返回头值（当前开源版实现返回空对象）。统一在这里拼接，避免各调用点重复实现时漏脱敏。
- `!headers` 分支返回 `outboundHeaderKeys: []` 而非 `undefined`：让「确实没发头」与
  「字段漏写」在排障时可区分。

### 2. `summarizeFinishChunkForDiagnostics` / `summarizeFinishChunkBusinessScan`

- 逐字段显式挑取，**绝不 spread `record`**：`record` 可能带 `request.body`
  （完整 prompt 与鉴权头回显），整体展开会把用户输入和凭据写进日志。
- `chunkKeys` / `providerMetadataKeys` 只取键名（`objectKeys`，上限 20），不读值。
- `responseBody` 走 `summarizeProviderBody`；`rawFinishReason` 走 `summarizeScalar`。
- 业务码 `providerCode/providerMessage` 只在可疑空完成时落日志，用于把空回复归因到
  额度/风控等 provider 侧原因；不伪造 `response/body` 参与摘要（INV-12）。

### 3. `summarizeProviderBody` / `summarizeProviderError`

- 字符串体只留前 500 字符 + 原始 `length`：可能含模型输出或上游 error 回显，
  完整写入会同时放大日志体积与内容泄露面。
- 对象体只取 `code/message/msg/status/success`；`messages/choices/embedding` 等
  可能含用户内容的字段一律不展开。
- `success` 仅在确为布尔时保留，字符串 `"true"` 不冒充成功标志。
- 嵌套 error 只取 `code/keys/message/type`，避免 `request` 回显或堆栈进入日志。

### 4. `summarizeRawFinishChunkPreview`

- `undefined` 与「序列化失败」分开处理，后者退回结构摘要。
- `≤2048` 字符用 `JSON.parse` 还原结构；超长只留前 2048 字符并标 `truncated: true`，
  截断点可能落在 JSON 中间，因此不再解析（INV-10）。
- 循环引用 / BigInt 抛错时退回 `summarizeFinishChunkForDiagnostics`，
  一次日志序列化失败不能中断整条流（INV-09 / INV-18）。

### 5. `summarizeScalar` / `objectKeys`

- 标量原样透传，调用方只传 `finishReason/code/status` 这类短状态字段，不用于正文。
- 复杂值降级为 `[array:N]` / `[object]`：不展开大对象、不泄露内容、循环引用不抛错。
- `Object.keys` 最多 20 个键，限制单条日志体积。

## 其他补深分支

- `recordStreamChunkDiagnostic`：`asRecord` 类型兜底（INV-02 绝不抛）、未知 chunk 用
  `typeof` 计数、`text-delta` 缺字段按 0 计、`reasoning-*` 以 `providerMetadata` 有键判签名
  （INV-07）、`tool-call` 独立计数（INV-06）、`finish` 取 `totalUsage ?? usage`。
- `logGenerateTextDiagnostics`：info 与 suspicious warn 复用同一份 context，字段不漂移。
- `logStreamDiagnostics`：出站头摘要与业务扫描只拼在 warn 分支。
- `logStreamFailureDiagnostics`：`errorAfterFinish` 区分结算前后、Cancelled 单列
  `status=cancelled`（INV-13/14）。
- `createEmptyContextExceededError`：只转换无有效输出的明确超窗，同时检查
  `finishReason` 与 `rawFinishReason`（INV-15/16）。
- `isZeroOutputModelCompletion` / `excludesEmptyCompletionRetry`：超窗/拒绝/内容过滤
  不进入空完成重试（INV-17）。
- `isSuspiciousModelCompletion`：四条件逐条注释（INV-03）。
- `isNonStopFinish`：`trim + toLowerCase` 归一，`tool-calls` 与 `tool_calls` 同类（INV-04）。
- `isZeroUsage`：`serverToolUse` 先判，`totalTokens` 缺省时对五项求和（INV-05）。

## 门禁复核

| 门禁 | 结果 |
| --- | --- |
| `zc-verify --rewrite ZC-fix-b129` | PASS（`codeTokenDiff=0`、`codeDeletion=0`、`upstreamCommentDeleted=0`、`nonCommentAdded=0`、`starSlash=0`、`syntaxErrorFiles=0`） |
| `zc-gate --scan ZC-fix-b129/_files.txt` | PASS（`added=152 water=0 waterRate=0.00%`） |
| `zc-inner --roots apps --only <rel>` | 30.69%（116/378） |

首轮 gate 报 27 行 W/L（均为硬折行被按行误判），已逐行补标识符或改连接符，
终轮 0 命中；说明补深文本本身也满足插入侧判据。

## 下一批

按「语句/分支覆盖」排优先级，不再按注水命中数：

1. `apps/zcode-cli/packages/adapters/src/model/edit.ts`
2. `packages/desktop/src/main/index.ts`
3. `ModelTrajectoryExpandedContent.tsx`
4. `taskNotificationOrchestrator.ts`
5. `chatErrorBannerTelemetry.ts`

每批 4~6 个文件。注水率只在两处看：`zc-gate` 拦新行、每批收尾自检。
