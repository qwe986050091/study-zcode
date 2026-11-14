# SVC-B20 深度注释索引（session / oauth / usage / plugin-ui / storage）

> 规范母本：`d:\code\opensource\redb\docs\annotation\DEEP-SPEC.md`（v1）
> 范围：`packages/services/src/**` 中按缺口降序的第 166~180 个文件（单批 ≤15）。
> 口径：注释行 ÷ 代码行 ≥ 30%（`deep-density.mjs --mode code --threshold 30`）。

## 1. 结果

| 文件 | 代码行 | 注释行（前→后） | 密度 | 新增 |
| --- | ---: | --- | ---: | ---: |
| `runtime-tools/node-forge.d.ts` | 49 | 2 → 15 | 30.61% | 13 |
| `zcode-session/importedClaudeSessionRepair.ts` | 34 | 0 → 11 | 32.35% | 11 |
| `oauth/providers/bigmodelProviderConfig.ts` | 44 | 3 → 14 | 31.82% | 11 |
| `usage-stats/providers/zcodeMcpQuotaProvider.ts` | 234 | 60 → 72 | 30.77% | 12 |
| `providers/api/requestIdHeaders.ts` | 31 | 0 → 10 | 32.26% | 10 |
| `remote-sync/remoteSyncWriteAccess.ts` | 33 | 0 → 10 | 30.30% | 10 |
| `zcode-session/zcodeSessionDraftRegistry.ts` | 32 | 0 → 10 | 31.25% | 10 |
| `plugin-ui-bridge/instanceAccounts.ts` | 38 | 2 → 12 | 31.58% | 10 |
| `file/workspaceFileSearch.ts` | 37 | 2 → 12 | 32.43% | 10 |
| `project-storage/migration-order/migration.ts` | 37 | 2 → 12 | 32.43% | 10 |
| `plugin-ui-bridge/contract.example.ts` | 42 | 3 → 13 | 30.95% | 10 |
| `cua-permission-broker/cuaHelperInstaller.ts` | 44 | 4 → 14 | 31.82% | 10 |
| `storage/adapters/inProcessScanRunner.ts` | 47 | 5 → 15 | 31.91% | 10 |
| `skills/skillDiscoveryWalk.ts` | 82 | 15 → 25 | 30.49% | 10 |
| `feedback/compactLogArchive.ts` | 30 | 0 → 10 | 33.33% | 10 |
| **合计** | **854** | — | — | **157** |

## 2. 分段

本批 15 个文件均为小文件（30~234 行），按 3 组并行写入：
b20a（5 个：session / oauth / usage / api）、b20b（5 个：remote-sync / plugin-ui / file / migration）、
b20c（5 个：plugin-ui 示例 / cua / storage adapter / skills / feedback），每组新增 50~57 行。

## 3. 校验原文

```text
node d:\code\_annot_baseline\zc-verify.mjs ZC-deep-svc-b20
SUMMARY files=15 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=157
```

逐文件密度复测（`--only`，15 次全部 `PASS`；最低 30.30%，最高 33.33%）。

全 services 复测（b20 后）：

```text
SUMMARY files=467 coreBelow30=85 needLines=390 min=0.00 median=31.58 newComments=29273
```

## 4. 本批锚定的不变量

- `node-forge.d.ts`：仅为缺失类型声明的本地补齐，不承载运行时逻辑。
- `importedClaudeSessionRepair.ts`：导入会话的修复以幂等为前提，重复执行不改变结果。
- `bigmodelProviderConfig.ts`：静态默认值与 env 覆盖分层，与 ZAI 侧结构平行。
- `zcodeMcpQuotaProvider.ts`：额度查询的 family 选择不得跨 provider 回退。
- `requestIdHeaders.ts`：请求 id 头只增不改，缺失时由上游补齐。
- `remoteSyncWriteAccess.ts`：写权限判定失败按「不可写」处理，避免误写远端。
- `zcodeSessionDraftRegistry.ts`：草稿登记按 session 维度隔离，避免跨会话串写。
- `instanceAccounts.ts`：实例与账号的映射以实例 id 为键，账号切换需重建。
- `workspaceFileSearch.ts`：搜索根必须来自 workspace，不接受任意绝对路径。
- `migration.ts`：迁移顺序由显式序号决定，不得依赖文件枚举顺序。
- `contract.example.ts`：示例契约不参与运行时装配，仅用于类型演示。
- `cuaHelperInstaller.ts`：安装结果以落盘路径为准，重复安装需幂等。
- `inProcessScanRunner.ts`：进程内扫描共享队列，单个失败不得中断整批。
- `skillDiscoveryWalk.ts`：遍历需限制深度与忽略目录，避免进入 node_modules。
- `compactLogArchive.ts`：归档只压缩已封闭文件，活跃日志不得参与。

## 5. 看似该改、其实不能改

- `node-forge.d.ts` 不能改成外部依赖：离线构建需要本地声明。
- `importedClaudeSessionRepair` 不能去掉幂等判断：修复会被重试。
- `bigmodelProviderConfig` 不能让 env 成为唯一来源：默认值必须可用。
- `zcodeMcpQuotaProvider` 不能跨 family 回退：会拿错误身份查额度。
- `requestIdHeaders` 不能覆盖既有 id：会切断链路追踪。
- `remoteSyncWriteAccess` 不能把异常当可写：会破坏远端数据。
- `zcodeSessionDraftRegistry` 不能全局共享草稿槽：会造成会话串稿。
- `instanceAccounts` 不能在账号切换后复用旧映射：会写到前一个账号。
- `workspaceFileSearch` 不能放宽搜索根：会读到工作区外文件。
- `migration` 不能按目录遍历顺序执行：升级顺序会随文件系统变化。
- `contract.example` 不能被运行时 import：会把示例实现带进产物。
- `cuaHelperInstaller` 不能跳过已安装检查：会重复覆盖用户侧安装。
- `inProcessScanRunner` 不能因单文件失败整体 reject：扫描应尽量产出结果。
- `skillDiscoveryWalk` 不能无限深度遍历：会卡在依赖目录。
- `compactLogArchive` 不能归档正在写的文件：会产生截断日志。
