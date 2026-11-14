# SVC-B19 深度注释索引（cua / plugin-sync / contracts / storage）

> 规范母本：`d:\code\opensource\redb\docs\annotation\DEEP-SPEC.md`（v1）
> 范围：`packages/services/src/**` 中按缺口降序的第 151~165 个文件（单批 ≤15）。
> 口径：注释行 ÷ 代码行 ≥ 30%（`deep-density.mjs --mode code --threshold 30`）。

## 1. 结果

| 文件 | 代码行 | 注释行（前→后） | 密度 | 新增 |
| --- | ---: | --- | ---: | ---: |
| `cua-permission-broker/stableCuaTransport.ts` | 45 | 0 → 14 | 31.11% | 14 |
| `remote-projects/validation.ts` | 46 | 0 → 14 | 30.43% | 14 |
| `official-mcp/officialMcpCredentials.ts` | 343 | 89 → 105 | 30.61% | 16 |
| `plugin-sync/pluginSync.ts` | 42 | 0 → 13 | 30.95% | 13 |
| `plugin-ui-bridge/pluginUiAppToolsService.ts` | 46 | 1 → 14 | 30.43% | 13 |
| `setting/settingsWriteQueue.ts` | 50 | 2 → 16 | 32.00% | 14 |
| `task-groups/contract.ts` | 47 | 2 → 15 | 31.91% | 13 |
| `cua-permission-broker/cuaStandaloneStatusLaunch.ts` | 39 | 0 → 12 | 30.77% | 12 |
| `plugin-sync/pluginSyncPath.ts` | 40 | 0 → 13 | 32.50% | 13 |
| `skill-sync/skillSyncPath.ts` | 40 | 0 → 13 | 32.50% | 13 |
| `startup-storage/index.ts` | 37 | 0 → 12 | 32.43% | 12 |
| `usage-stats/usageStats.ts` | 37 | 0 → 12 | 32.43% | 12 |
| `prompt-attachment-transfer/promptAttachmentTransferService.ts` | 41 | 1 → 13 | 31.71% | 12 |
| `oauth/providers/zaiProviderConfig.ts` | 48 | 3 → 15 | 31.25% | 12 |
| `storage/domain/cleanPlan.ts` | 66 | 8 → 21 | 31.82% | 13 |
| **合计** | **1,007** | — | — | **196** |

## 2. 分段

| 段 | 文件 | 内容 | 新增 |
| --- | --- | --- | ---: |
| b19a | `stableCuaTransport.ts` | 管道名与启动配方的进程内单例 | 14 |
| b19a | `remote-projects/validation.ts` | strict schema、跨条目主根约束 | 14 |
| b19a | `officialMcpCredentials.ts` | 身份快照双读比对、MaaS JWT 与 wireScope | 16 |
| b19a | `pluginSync.ts` | 同步能力面与 archive 交换格式 | 13 |
| b19a | `pluginUiAppToolsService.ts` | 四路透传与能力缺失降级 | 13 |
| b19b | `settingsWriteQueue.ts` | 提交阶段与超时的竞速边界 | 14 |
| b19b | `task-groups/contract.ts` | 整体结构、移动与首次登记 | 13 |
| b19b | `cuaStandaloneStatusLaunch.ts` | 候选优先级与内置路径优先 | 12 |
| b19b | `pluginSyncPath.ts` | 相对路径三段拒绝规则 | 13 |
| b19b | `skillSyncPath.ts` | 与插件同步平行的独立实现 | 13 |
| b19c | `startup-storage/index.ts` | 迁移子命令插入位置、报告校验 | 12 |
| b19c | `usageStats.ts` | 快照与重置三方法的配对关系 | 12 |
| b19c | `promptAttachmentTransferService.ts` | 本地零拷贝、事件分桶自清理 | 12 |
| b19c | `zaiProviderConfig.ts` | 基线加 env 覆盖、client_id 公开性 | 12 |
| b19c | `cleanPlan.ts` | 四类过滤与 skippedCount 口径 | 13 |

## 3. 校验原文

```text
node d:\code\_annot_baseline\zc-verify.mjs ZC-deep-svc-b19
SUMMARY files=15 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=196
```

逐文件密度复测（`--only`，15 次全部 `PASS`；最低 30.43%，最高 32.50%）。

全 services 复测（b19 后）：

```text
SUMMARY files=467 coreBelow30=100 needLines=545 min=0.00 median=31.48 newComments=29116
```

## 4. 本批锚定的不变量

- `stableCuaTransport.ts`：管道名全进程只生成一次；配方解析结果连失败一起缓存，失败需显式重置才重试；失败告警只记一次。
- `remote-projects/validation.ts`：所有对象 strict；roots 内路径唯一且非空时恰有一个主根。
- `officialMcpCredentials.ts`：Registry / active provider / JWT / MaaS JWT 前后双读比对，任一变化整轮重来；身份头只按 wireScope 生成。
- `pluginSync.ts`：契约只声明不实现；overwrite 只允许 false。
- `pluginUiAppToolsService.ts`：登记/认领/解析缺失实现时抛不可用，注销返回 removed=0。
- `settingsWriteQueue.ts`：超时只允许发生在提交前；进入提交即撤销定时器。
- `task-groups/contract.ts`：结构与顺序由客户端整体 save；createdAt/updatedAt 由服务端写入。
- `cuaStandaloneStatusLaunch.ts`：内置路径优先于候选列表；ensureInstalled 的返回值才是最终路径。
- `pluginSyncPath.ts`：拒绝绝对路径、盘符、上级段；拼接后必须仍在根目录内。
- `skillSyncPath.ts`：与 pluginSyncPath 规则相同但实现独立，避免一次改动影响两条链路。
- `startup-storage/index.ts`：迁移子命令必须插在 app-server/agent-server 之前；报告解析失败即失败。
- `usageStats.ts`：重置三方法配对；读方法与重置方法同为快照语义。
- `promptAttachmentTransferService.ts`：本地路径 staged 恒 false；最后一个监听者移除即销毁 emitter。
- `zaiProviderConfig.ts`：静态默认值必须保持可用；appSecret 不在本文件。
- `cleanPlan.ts`：不可清理类别全跳过；候选重新分类且未受保护；logs 保留当天；subagent 会话整组静默 24h。

## 5. 看似该改、其实不能改

- `stableCuaTransport` 不能在失败后直接重试：没有显式重置会放大启动抖动。
- `remote-projects/validation` 不能去掉 `.strict()`：未知字段会随缓存长期留存。
- `officialMcpCredentials` 不能去掉双读比对：会拼出跨 family 或新旧两代凭证。
- `pluginSync` 不能把 archive 换成路径：路径在远端不可用。
- `pluginUiAppToolsService` 不能把注销改成抛错：退出流程会被中断。
- `settingsWriteQueue` 不能在提交后仍允许超时：旧写会覆盖新设置。
- `task-groups/contract` 不能让服务端生成顺序：多端会互相覆盖。
- `cuaStandaloneStatusLaunch` 不能跳过 ensureInstalled：内置路径未必已安装。
- `pluginSyncPath` 不能在越界时自动修正：修正后的路径仍可能指向根外。
- `skillSyncPath` 不能改为复用 pluginSyncPath：两条链路的策略需独立演进。
- `startup-storage/index` 不能把子命令追加到末尾：会被上游参数解析吞掉。
- `usageStats` 不能把申请与使用合并：申请失败不应改变状态。
- `promptAttachmentTransferService` 不能伪造进度：本地文件的进度条会永远停在 0。
- `zaiProviderConfig` 不能把 appSecret 移入本文件：会随源码分发泄漏。
- `cleanPlan` 不能只看已过滤集合判断活跃：会漏掉同目录最新写入。
