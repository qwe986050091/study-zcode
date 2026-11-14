# SVC-B24 深度注释索引（示例文件 / 出口 / 契约收口）

> 规范母本：`d:\code\opensource\redb\docs\annotation\DEEP-SPEC.md`（v1）
> 范围：`packages/services/src/**` 中按缺口降序的第 226~240 个文件（单批 ≤15）。
> 口径：注释行 ÷ 代码行 ≥ 30%（`deep-density.mjs --mode code --threshold 30`）。

## 1. 结果

| 文件 | 代码行 | 注释行（前→后） | 密度 | 新增 |
| --- | ---: | --- | ---: | ---: |
| `remote-projects/contract.example.ts` | 11 | 0 → 4 | 36.36% | 4 |
| `cloud-content/cloudContent.ts` | 12 | 0 → 4 | 33.33% | 4 |
| `subagents/subagentModelSelection.ts` | 12 | 0 → 4 | 33.33% | 4 |
| `cua-permission-broker/cuaPipSession.ts` | 13 | 0 → 4 | 30.77% | 4 |
| `plugin-ui-bridge/index.ts` | 13 | 0 → 4 | 30.77% | 4 |
| `providers/api/apiKeyHeaders.ts` | 17 | 2 → 6 | 35.29% | 4 |
| `skill-sync/skillSyncErrors.ts` | 19 | 2 → 6 | 31.58% | 4 |
| `setting/setting.ts` | 21 | 3 → 7 | 33.33% | 4 |
| `setting/observableSettingService.ts` | 26 | 4 → 8 | 30.77% | 4 |
| `startup-storage/contract.example.ts` | 8 | 0 → 3 | 37.50% | 3 |
| `window-project-directory/contract.example.ts` | 8 | 0 → 3 | 37.50% | 3 |
| `gen-ui/contract.example.ts` | 9 | 0 → 3 | 33.33% | 3 |
| `memory/index.ts` | 10 | 0 → 4 | 40.00% | 4 |
| `providers/api/index.ts` | 10 | 0 → 4 | 40.00% | 4 |
| `client-config/clientConfig.ts` | 12 | 1 → 4 | 33.33% | 3 |
| **合计** | **201** | — | — | **56** |

## 2. 分段

本批全部为 ≤26 行的小文件/示例文件：b24a（remote-projects 示例 / cloud-content / subagent 模型 / cua pip / plugin-ui 出口，20 行）、
b24b（apiKeyHeaders / skillSyncErrors / setting / observableSetting / startup-storage 示例，19 行）、
b24c（window-project 示例 / gen-ui 示例 / memory 出口 / providers-api 出口 / clientConfig，17 行）。

## 3. 校验原文

```text
node d:\code\_annot_baseline\zc-verify.mjs ZC-deep-svc-b24
SUMMARY files=15 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=56
```

逐文件密度复测（`--only`，15 次全部 `PASS`；最低 30.77%，最高 40.00%）。

全 services 复测（b24 后）：

```text
SUMMARY files=467 coreBelow30=25 needLines=44 min=0.00 median=31.85 newComments=29631
```

## 4. 本批锚定的不变量

- `remote-projects/contract.example.ts`：示例不得被生产入口 import；刷新返回值判定不能吞 false。
- `cloudContent.ts`：leaseId 必须由同一实例 release，租约不跨进程。
- `subagentModelSelection.ts`：只保留 reasoningLevel，其余 options 丢弃；校验失败必须上抛。
- `cuaPipSession.ts`：focus-changed 与生命周期事件必须分流，不能合并为通用 publish。
- `plugin-ui-bridge/index.ts`：只做 re-export，不得引入运行时代码。
- `apiKeyHeaders.ts`：只保留可见 ASCII、去掉 Bearer 前缀；发送链路必须经本函数。
- `skillSyncErrors.ts`：code 恒定，data 必须携带 phase 与字节数，只能经工厂构造。
- `setting/setting.ts`：AppSettings 是唯一真源；update 必须带原快照与版本。
- `observableSettingService.ts`：事件只在成功提交后发布；空 patch 不发布。
- `startup-storage/contract.example.ts`：示例不得被运行时导入。
- `window-project-directory/contract.example.ts`：示例不得注册进服务容器。
- `gen-ui/contract.example.ts`：示例常量不得被打包进真实预览入参。
- `memory/index.ts`：外部只能经 barrel 取得服务；导入不得触发 IO。
- `providers/api/index.ts`：只转发不构造实例，导入保持零副作用。
- `clientConfig.ts`：配置快照唯一来源是 channel 响应，本模块不持有第二份状态。

## 5. 看似该改、其实不能改

- 示例文件都不能被生产 import：会凭空拉起依赖或污染入参。
- `cloudContent` 不能把 lease 做成全局：跨进程失效后无人释放。
- `subagentModelSelection` 不能透传未知字段：下游会收到未校验配置。
- `cuaPipSession` 不能合并事件通道：订阅方会按错误顺序处理焦点。
- `plugin-ui-bridge/index` 不能在此初始化：所有引用方都会被拖入初始化。
- `apiKeyHeaders` 不能跳过 ASCII 截断：含中文备注会让请求头整体非法。
- `skillSyncErrors` 不能手写 code：跨 RPC 后会退化为不可区分解。
- `setting` 不能在本层补默认值：并发更新会失去版本约束。
- `observableSettingService` 不能提前发事件：上层会读到未落盘设置。
- `memory/index` 不能深引内部实现：依赖图会环化。
- `providers/api/index` 不能绕过入口直连实现：鉴权头规范化会被绕过。
- `clientConfig` 不能本地缓存：多窗口会读到不一致配置。
