# ZC-DEEP-svc-b2：zcode-agent 两文件 L1 深度注释索引

> 范围：`packages/services/src/zcode-agent/zcodeAgentService.ts`（6,816 行）、`zcodeTaskServiceAdapter.ts`（5,880 行）。
> 基线：`d:\code\_annot_baseline\ZC-deep-svc-b2\packages\services\src\zcode-agent\`；作业说明：同批 `BRIEF.md`。
> 硬约束：只新增整行 `//` 注释；`deletedNonZero=0`；新增行非注释=0；新增注释无 `*/`；`parseDiagnostics=0`；不做 git 提交。

## 结果

| 文件 | 基线注释/代码 | 完成后注释/代码 | 新增注释 | 基线缺口 | 验收 |
| --- | ---: | ---: | ---: | ---: | --- |
| `zcodeAgentService.ts` | 518 / 6,010 = 8.62% | 2,334 / 6,010 = **38.84%** | +1,816 | 1,285 | PASS |
| `zcodeTaskServiceAdapter.ts` | 322 / 5,242 = 6.14% | 2,078 / 5,242 = **39.64%** | +1,756 | 1,251 | PASS |
| **合计** | 840 / 11,252 = 7.47% | 4,412 / 11,252 = **39.21%** | **+3,572** | 2,536 | — |

## 分段明细

| 文件 | 段 | 原行范围 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | --- | --- | ---: |
| zcodeAgentService | seg1 | 1–1688 | 文件头、imports、稳定码、compat 协商、参数构造、工厂前段 | V4 兼容字段白名单；错误码分流；事件 key 与有界去重；provider readiness；client 失效释放顺序 | +446 |
| zcodeAgentService | seg2 | 1689–3376 | 偏好同步、启动等待、client 获取、三类 pending | 串行链与身份复核；pending 超时清理；provider headers 信任校验先于读凭据；V4 订阅 ownership 换代 | +428 |
| zcodeAgentService | seg3 | 3377–5111 | client 门禁、session create/resume、只读/诊断路径 | 只读提升与 start-if-needed；compat 重试；workspace 策略 fail-closed；`disposeLocalState` 拆除顺序 | +524 |
| zcodeAgentService | seg4 | 5112–6816 | 插件/MCP/浏览器/子进程/off-peak/automation、dispose | 5 分钟 I/O 超时与 operationId 幂等；channel allowlist；V4 订阅 ownership；`disposeAllAndWait` 顺序 | +418 |
| zcodeTaskServiceAdapter | seg1 | 1–1474 | 迁移判据、旧 snapshot、session→task 投影 | “旧数据没有 vs 新链路未写入”；taskId≡sessionId；live Map join；有界 tool projection | +515 |
| zcodeTaskServiceAdapter | seg2 | 1475–2947 | indexed task state、snapshot 切片、goal/plan/todo | `COALESCE` patch 口径；`null/[]/undefined` 三态；legacy 与 session 双分支；CAS revision | +467 |
| zcodeTaskServiceAdapter | seg3 | 2948–4412 | provider config、task 元数据写路径、事件订阅、纯映射 | archive guard 与幂等删除；CAS unread；复合 disposable；synthetic timeline 补插；流式输入 tombstone | +366 |
| zcodeTaskServiceAdapter | seg4 | 4413–5880 | 流式 tool input、background task、retry/遥测、清理 | 固化-清空顺序；三张 Map 释放；ACK→in_progress 语义；apiRetry 四级回退；遥测脱敏 | +408 |
| **合计** | — | 12,696 | — | — | **+3,572** |

## 校验输出原文

```text
38.84	8632	6010	2334	1816	packages/services/src/zcode-agent/zcodeAgentService.ts
SUMMARY files=1 coreBelow30=0 needLines=0 min=38.84 median=38.84 newComments=1816
PASS: all 1 file(s) >= 30% (mode=code)

39.64	7636	5242	2078	1756	packages/services/src/zcode-agent/zcodeTaskServiceAdapter.ts
SUMMARY files=1 coreBelow30=0 needLines=0 min=39.64 median=39.64 newComments=1756
PASS: all 1 file(s) >= 30% (mode=code)

[agent] numstat=1816	0	... plus=1816 minus=0 nonComment=0 star=0
[adapter] numstat=1756	0	... plus=1756 minus=0 nonComment=0 star=0
TypeScript parseDiagnostics=0（两文件）
```

全目录重测：`coreBelow30 430 → 428`，`needLines 23696 → 21160`，`median 4.92%`，累计 `newComments=6976`（含 b1）。

## 新增不变量

- **INV-13**：快照裁剪（`limitTaskSnapshotMessages`）必须与 `history`（`totalMessages` / `truncatedBefore`）在同一次构造中产出；UI 不得用“返回条数是否等于 limit”推断是否还有更早历史。

## “看起来该改其实不能改”的点

1. `isClosedStdioTransportError` / `isSessionMissingError` 用 message 文本判错，看似违反 INV-05 的稳定码纪律；但底层 stdio/旧 op 没有可用 code，改成 code 判断需要上游协议先提供稳定错误码，注释任务内不能替换。
2. `getTaskSnapshotBody/Ref/ToolCallsSlice` 恒返回 `null`，看似未实现的 bug；实际是旧调用方依赖“拿不到分片就走全量 snapshot”的兼容契约，贸然实现会改变增量补拉语义。
3. `branchTaskFromPrompt` 返回 `unsupported`，看似遗漏；这是 INV-08 的显式迁移缺口（V4 无等价能力），补实现等于新增产品行为，不属于注释范围。
4. `tool_input_end` 的兜底 state 不回写 Map，看似状态不一致；回写会复活已 tombstone 的投影，破坏“终态后不再物化”的有界内存约束（INV-11）。
5. `permissionOptionsFromPayload` 直接 cast 协议数组，看似缺校验；结构校验在协议边界完成，适配层再抛错会让旧 CLI 的新增可选字段直接失败，属有意的宽松兼容。
6. `resolvePromptToolDenylist` 返回 `undefined` 与 `[]` 不等价，看似可用 `?? []` 简化；`undefined` 表示“不限制”，空数组表示“禁用全部”，改成 `?? []` 会静默放开全部工具。
7. `backgroundTaskControlsByTaskKey` 只写不删，看似泄漏；其生命周期绑定 task，删除点应在任务销毁而不是本文件，贸然加清理会与跨 taskKey 的缓存共享冲突。
8. `disposeLocalState` 对 `pendingProviderRuntimeHeaders` 直接 `clear()` 而非走取消事件，看似漏发通知；此时 emitter 已先 dispose，补发事件反而会在关闭后写入。

以上均为阅读结论，本批未改动任何代码 token。
