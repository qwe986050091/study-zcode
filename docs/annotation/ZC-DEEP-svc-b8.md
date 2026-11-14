# SVC-B8 深度注释索引（zcode-agent 小文件收口）

> 规范母本：`d:\code\opensource\redb\docs\annotation\DEEP-SPEC.md`（v1）
> 范围：`packages/services/src/zcode-agent/**` 中剩余 14 个低于 30% 的文件（单批 ≤15）。
> 口径：注释行 ÷ 代码行 ≥ 30%（`deep-density.mjs --mode code --threshold 30`）。

## 1. 结果

| 文件 | 代码行 | 注释行（前→后） | 密度 | 新增 |
| --- | ---: | --- | ---: | ---: |
| `zcodeStdioTapDevConfig.ts` | 59 | 1 → 19 | 32.20% | 18 |
| `localRuntimeNetworkCapture.ts` | 58 | 3 → 19 | 32.76% | 16 |
| `modelTrajectoryFileTail.ts` | 48 | 3 → 15 | 31.25% | 12 |
| `zcodeConfigOptions.ts` | 51 | 5 → 16 | 31.37% | 11 |
| `agentStderrCollector.ts` | 39 | 2 → 13 | 33.33% | 11 |
| `independentPlanSupport.ts` | 36 | 2 → 12 | 33.33% | 10 |
| `agentTelemetryEnv.ts` | 34 | 2 → 11 | 32.35% | 9 |
| `pluginReferenceCatalogRequest.ts` | 26 | 1 → 9 | 34.62% | 8 |
| `botTopicAdmission.ts` | 29 | 3 → 9 | 31.03% | 6 |
| `zcodeProtocolTransport.ts` | 15 | 0 → 5 | 33.33% | 5 |
| `zcodeAgentSpawnCwd.ts` | 22 | 2 → 7 | 31.82% | 5 |
| `zcodeAgentErrors.ts` | 15 | 2 → 5 | 33.33% | 3 |
| `automationToolPolicy.ts` | 18 | 3 → 6 | 33.33% | 3 |
| `zcodeAgentPresentationSurface.ts` | 18 | 3 → 6 | 33.33% | 3 |
| **合计** | **468** | — | — | **120** |

## 2. 分段

| 段 | 文件 | 内容 | 新增 |
| --- | --- | --- | ---: |
| b8a | `zcodeProtocolTransport.ts` | 三种形态、关闭事件、send 语义 | 5 |
| b8a | `zcodeStdioTapDevConfig.ts` | 可见性判据、状态文件读写、双条件开关 | 16 |
| b8a | `pluginReferenceCatalogRequest.ts` | 新方法优先、-32601 回退 | 8 |
| b8a | `agentStderrCollector.ts` | 一次性排空、死线收紧、finish 幂等 | 11 |
| b8b | `zcodeStdioTapDevConfig.ts` | 补厚（状态文件命名、落盘与运算） | 2 |
| b8c | `localRuntimeNetworkCapture.ts` | spawn 登记、captureId 重配、真实 pid 补齐 | 16 |
| b8c | `independentPlanSupport.ts` | 按 client 弱缓存、严格 true、失败不缓存 | 10 |
| b8c | `agentTelemetryEnv.ts` | 端点前置、身份状态与 subject 配对 | 9 |
| b8c | `modelTrajectoryFileTail.ts` | 双根目录、尾读窗口、首行丢弃 | 12 |
| b8d | `zcodeAgentSpawnCwd.ts` | 只定目录、异常即不可用、回退条件 | 5 |
| b8d | `zcodeConfigOptions.ts` | 稳定 config id、最近消息模型、shared 单源 | 11 |
| b8d | `botTopicAdmission.ts` | 版本失效、tail 串行、finally 释放 | 6 |
| b8d | `zcodeAgentErrors.ts` | 稳定 code、跨 RPC 类型守卫 | 3 |
| b8d | `automationToolPolicy.ts` | 两组 denylist 不得合并 | 3 |
| b8d | `zcodeAgentPresentationSurface.ts` | 可信事实推导、灰度显式 false | 3 |

> 分段表按 spec 文件统计；同一文件多段合计等于上表新增。

## 3. 校验原文

```text
node d:\code\_annot_baseline\zc-verify.mjs ZC-deep-svc-b8
SUMMARY files=14 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=120
```

```text
node d:\code\_annot_baseline\deep-density.mjs d:\code\ZCode \
  --baseline d:\code\_annot_baseline\ZC-deep-svc-base \
  --root packages/services/src/zcode-agent --ext .ts --mode code --threshold 30

SUMMARY files=38 coreBelow30=0 needLines=0 min=30.16 median=32.06 newComments=5222
```

全 services 复测（b8 后）：

```text
SUMMARY files=467 coreBelow30=265 needLines=11149 min=0.00 median=14.56 newComments=17962
```

`packages/services/src/zcode-agent/**` 已全部收口（38/38 ≥ 30%）。

## 4. 本批锚定的不变量

- `zcodeProtocolTransport.ts`：传输只收发帧，不解析业务；`send` 成功不等于对端已处理。
- `zcodeStdioTapDevConfig.ts`：`enabled = visible && 磁盘开关`；非开发环境不得因残留状态开启抓包。
- `pluginReferenceCatalogRequest.ts`：只有 `-32601` 允许回退旧方法，其余错误必须原样抛出。
- `agentStderrCollector.ts`：所有终止路径收敛到同一个 `finish`；死线只能收紧不能放宽。
- `localRuntimeNetworkCapture.ts`：pid 只用本机 spawn 登记值；重配先拆旧订阅。
- `independentPlanSupport.ts`：能力必须严格 `true`；失败结论不缓存。
- `agentTelemetryEnv.ts`：无 OTLP 端点不注入；`authenticated` 与 subject 成对出现。
- `modelTrajectoryFileTail.ts`：只读尾部 32 MiB；截断时丢弃不完整首行。
- `zcodeAgentSpawnCwd.ts`：仅当请求目录等于 workspace 且不存在时才回退。
- `zcodeConfigOptions.ts`：模式/配置清单只有 shared 一份事实源。
- `botTopicAdmission.ts`：`invalidate` 先递增版本再等 tail。
- `zcodeAgentErrors.ts`：能力判定按稳定 code，不按文案。
- `automationToolPolicy.ts`：automation 与 off-peak 的 denylist 永不合并。
- `zcodeAgentPresentationSurface.ts`：呈现面只从可信 Host 事实推导。

## 5. 看似该改、其实不能改

- `agentStderrCollector` 的输入流 error 不能升级为协议致命错误：诊断出口失效不代表 stdin/stdout 不可用。
- `localRuntimeNetworkCapture` 不能采用对端自报 pid/角色：身份必须来自本机 spawn 记录。
- `independentPlanSupport` 不能把探测失败缓存为「不支持」：那会把暂时故障固化成永久降级。
- `zcodeConfigOptions` 不能恢复 service 侧模式白名单：edit 模式曾因此被覆盖。
- `botTopicAdmission` 不能把 `release()` 放在 try 之外：异常路径同样必须放行后续发送。
- `automationToolPolicy` 不能把 `OffPeakCreate` 并入 automation 名单：会让定时派生被误 deny。
