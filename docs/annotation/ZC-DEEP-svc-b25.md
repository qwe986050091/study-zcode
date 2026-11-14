# SVC-B25 深度注释索引（示例契约 / 模块描述符 / 端点与配置）

> 规范母本：`d:\code\opensource\redb\docs\annotation\DEEP-SPEC.md`（v1）
> 范围：`packages/services/src/**` 中按缺口降序的第 241~255 个文件（单批 ≤15）。
> 口径：注释行 ÷ 代码行 ≥ 30%（`deep-density.mjs --mode code --threshold 30`）。

## 1. 结果

| 文件 | 代码行 | 注释行（前→后） | 密度 | 新增 |
| --- | ---: | --- | ---: | ---: |
| `window-project-directory/index.ts` | 13 | 1 → 4 | 30.77% | 3 |
| `storage/contract.example.ts` | 24 | 5 → 8 | 33.33% | 3 |
| `project-workspace-navigation/contract.example.ts` | 4 | 0 → 2 | 50.00% | 2 |
| `task-groups/contract.example.ts` | 4 | 0 → 2 | 50.00% | 2 |
| `bot-project-runtime/contract.example.ts` | 5 | 0 → 2 | 40.00% | 2 |
| `project-catalog/contract.example.ts` | 5 | 0 → 2 | 40.00% | 2 |
| `gen-ui/module.ts` | 6 | 0 → 2 | 33.33% | 2 |
| `hooks/workspaceHookConfigMutation.ts` | 6 | 0 → 2 | 33.33% | 2 |
| `project-storage/startup-entry.ts` | 6 | 0 → 2 | 33.33% | 2 |
| `providers/api/apiEndpoints.ts` | 6 | 0 → 2 | 33.33% | 2 |
| `usage-stats/usageStatsConfig.ts` | 6 | 0 → 2 | 33.33% | 2 |
| `task-groups/migration-v6.ts` | 9 | 1 → 3 | 33.33% | 2 |
| `process/windowsTaskkillRunner.ts` | 13 | 2 → 4 | 30.77% | 2 |
| `startup-storage/contract.ts` | 13 | 2 → 4 | 30.77% | 2 |
| `plugin-ui-bridge/appToolsContract.ts` | 35 | 9 → 11 | 31.43% | 2 |
| **合计** | **155** | — | — | **32** |

## 2. 分段

b25a（目录转发出口 / storage 示例 / 三个契约示例，12 行）、
b25b（project-catalog 示例 / gen-ui 模块 / hooks 门面 / 启动入口 / 端点表，10 行）、
b25c（统计配置 / 迁移语句 / taskkill / 启动存储契约 / app tools 契约，10 行）。

## 3. 校验原文

```text
node d:\code\_annot_baseline\zc-verify.mjs ZC-deep-svc-b25
SUMMARY files=15 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=32
```

逐文件密度复测（`--only`，15 次全部 `PASS`；最低 30.77%，最高 50.00%）。

全 services 复测（b25 后）：

```text
SUMMARY files=467 coreBelow30=10 needLines=12 min=0.00 median=31.93 newComments=29663
```

## 4. 本批锚定的不变量

- `window-project-directory/index.ts`：只做单向订阅转发，不读写项目数据、不扩大频道权限。
- `storage/contract.example.ts`：示例不参与装配；快照必须按当前 jobId 过滤。
- `project-workspace-navigation/contract.example.ts`：示例中的 hostId/projectId 只是占位，不得用于真实路由。
- `task-groups/contract.example.ts`：示例不承担校验，缺省与冲突语义以真实契约为准。
- `bot-project-runtime/contract.example.ts`：端口由调用方注入，示例不创建运行时、不缓存连接。
- `project-catalog/contract.example.ts`：示例必须保持只读，禁止写目录。
- `gen-ui/module.ts`：requires 与 publicEntrypoints 必须与目录实际导出一致。
- `hooks/workspaceHookConfigMutation.ts`：导出名与 shared 一一对应，改名会断开写入链路。
- `project-storage/startup-entry.ts`：只做再导出，不得引入副作用初始化。
- `providers/api/apiEndpoints.ts`：端点必须经 buildRuntime/resolveZai 从 env 派生，禁止硬编码。
- `usageStatsConfig.ts`：键集合必须与 UsageStatsRange 去 all 后完全一致，占位键不得冲突。
- `task-groups/migration-v6.ts`：建表语句必须幂等，不得含 DROP/ALTER。
- `windowsTaskkillRunner.ts`：异步 execFile 且始终 resolve，错误放进结果对象。
- `startup-storage/contract.ts`：migrateAgent 必须在 CLI 迁移结束并关闭连接后才 resolve。
- `appToolsContract.ts`：实例身份由 session + scopeId + generation 三元组唯一确定，按 callId 幂等。

## 5. 看似该改、其实不能改

- `window-project-directory/index` 不能宽化频道匹配：窗口会收到非目录事件并双写分叉。
- `storage/contract.example` 不能被接入装配：离线尾包会覆盖新进度。
- 三个 `contract.example` 都不能被生产 import：会拉起空实现依赖。
- `gen-ui/module` 不能漏写 requires：模块加载期解析失败。
- `workspaceHookConfigMutation` 不能改名导出：钩子配置写入链路断裂。
- `startup-entry` 不能在此初始化：调用顺序契约会被打乱。
- `apiEndpoints` 不能硬编码主机：多环境会打到错误网关。
- `usageStatsConfig` 不能漏改键集合：UI 选区与查询区间错位。
- `migration-v6` 不能加 DROP/ALTER：重放会擦除准入记录。
- `windowsTaskkillRunner` 不能改成同步或 reject：调用方会卡住 Host 退出。
- `startup-storage/contract` 不能放宽 resolve 时机：业务会读到半迁移的库。
- `appToolsContract` 不能省略任一身份维度：旧代际调用会串到新实例。
