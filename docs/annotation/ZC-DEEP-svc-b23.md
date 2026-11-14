# SVC-B23 深度注释索引（小文件收口：场景 / 契约 / 调度 / 类型声明）

> 规范母本：`d:\code\opensource\redb\docs\annotation\DEEP-SPEC.md`（v1）
> 范围：`packages/services/src/**` 中按缺口降序的第 211~225 个文件（单批 ≤15）。
> 口径：注释行 ÷ 代码行 ≥ 30%（`deep-density.mjs --mode code --threshold 30`）。

## 1. 结果

| 文件 | 代码行 | 注释行（前→后） | 密度 | 新增 |
| --- | ---: | --- | ---: | ---: |
| `client-scenes/clientScenesService.ts` | 14 | 0 → 5 | 35.71% | 5 |
| `marketing-touch/marketingTouch.ts` | 14 | 0 → 5 | 35.71% | 5 |
| `project-catalog/contract.ts` | 14 | 0 → 5 | 35.71% | 5 |
| `system/system.ts` | 14 | 0 → 5 | 35.71% | 5 |
| `gen-ui/app/ports.ts` | 15 | 0 → 5 | 33.33% | 5 |
| `types/yazl.d.ts` | 15 | 0 → 5 | 33.33% | 5 |
| `plugin-ui-bridge/samplingContract.ts` | 18 | 1 → 6 | 33.33% | 5 |
| `official-mcp/officialMcpIssuanceAudit.ts` | 20 | 1 → 7 | 35.00% | 6 |
| `project-storage/default-workspace/migration.ts` | 25 | 3 → 8 | 32.00% | 5 |
| `oauth/providers/providerAdapter.ts` | 30 | 4 → 10 | 33.33% | 6 |
| `subagents/subagents.ts` | 31 | 5 → 10 | 32.26% | 5 |
| `collection.ts` | 36 | 6 → 11 | 30.56% | 5 |
| `plugins/pluginsService.ts` | 76 | 18 → 23 | 30.26% | 5 |
| `project/autoArchiveScheduler.ts` | 81 | 20 → 25 | 30.86% | 5 |
| `project/contract.example.ts` | 11 | 0 → 4 | 36.36% | 4 |
| **合计** | **454** | — | — | **76** |

## 2. 分段

b23a（客户端场景 / 营销触达 / 目录契约 / 系统信息 / gen-ui 端口，25 行）、
b23b（yazl 类型 / 采样契约 / 发放审计 / 默认工作区迁移 / provider 适配器，27 行）、
b23c（subagents / 注册中心 / 插件退役壳 / 自动归档调度 / 项目示例，24 行）。

## 3. 校验原文

```text
node d:\code\_annot_baseline\zc-verify.mjs ZC-deep-svc-b23
SUMMARY files=15 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=76
```

逐文件密度复测（`--only`，15 次全部 `PASS`；最低 30.26%，最高 36.36%）。

全 services 复测（b23 后）：

```text
SUMMARY files=467 coreBelow30=40 needLines=98 min=0.00 median=31.82 newComments=29575
```

## 4. 本批锚定的不变量

- `clientScenesService.ts`：端点取自常量表；响应原样返回，不裁剪不填默认值；工厂无状态。
- `marketingTouch.ts`：query 必须回带 scope 供幂等计数；actionType 只有 confirm/cancel 两个终态。
- `project-catalog/contract.ts`：Pick 面不得扩大；远端能力缺省即按空目录降级。
- `system.ts`：三个方法均为只读查询，不得承载副作用；类型必须复用 shared。
- `gen-ui/app/ports.ts`：get 未命中返回 null；onChanged 是唯一变更通道；dispose 后实例不可复用。
- `types/yazl.d.ts`：仅编译期形状，运行时由真实模块提供；签名必须与上游同步。
- `samplingContract.ts`：Agent 是限额与终态所有者，本层必须无状态；operationId 全生命周期复用。
- `officialMcpIssuanceAudit.ts`：进程内有界去重，容量下限钳制为 1，FIFO 淘汰；不可作为计费依据。
- `default-workspace/migration.ts`：只认单 root 且未编辑的自动项目；迁移只改归属且必须幂等。
- `providerAdapter.ts`：token 与错误归一化由 provider 完成；不得隐式重试；错误必须脱敏。
- `subagents.ts`：agent Markdown 是唯一事实源；插件覆盖只写用户 state。
- `collection.ts`：channelName 为唯一键，重复 register 覆盖；overrides 优先于实例。
- `pluginsService.ts`：退役壳恒返回 supported=false 或恒抛同一错误，不得恢复部分能力。
- `autoArchiveScheduler.ts`：扫描串行且合并补扫；dispose 后不再读写与排队。
- `contract.example.ts`：不得被生产入口 import，仅作契约文档。

## 5. 看似该改、其实不能改

- `clientScenesService` 不能在本层补缓存：多环境切换会读到旧场景。
- `marketingTouch` 不能扩展 actionType：宿主会静默丢弃未知动作。
- `project-catalog/contract` 不能去掉远端可选：离线端会整页失败。
- `system` 不能在本层加节流：频率策略应归调用方。
- `gen-ui/app/ports` 不能把 get 未命中改成抛错：空状态是正常语义。
- `yazl.d.ts` 不能改成运行时实现：会与真实模块重复。
- `samplingContract` 不能在本层缓存：会破坏 Agent 限额。
- `officialMcpIssuanceAudit` 不能改成无限 Map：内存随工作区增长。
- `default-workspace/migration` 不能放宽候选：会误标用户自建项目。
- `providerAdapter` 不能在上层做 provider 分支：协议差异会泄漏。
- `subagents` 不能把覆盖回写插件 Markdown：多端状态分叉。
- `collection` 不能在此做鉴权：注册中心不掌握调用者身份。
- `pluginsService` 不能恢复部分能力：会出现两套事实源。
- `autoArchiveScheduler` 不能挂到 UI 读取路径：刚清未读的任务会立刻消失。
- `contract.example` 不能被生产引用：会绕过正式编排。
