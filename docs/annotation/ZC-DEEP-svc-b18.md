# SVC-B18 深度注释索引（cua-permission-broker / highspeed / plugins / contracts）

> 规范母本：`d:\code\opensource\redb\docs\annotation\DEEP-SPEC.md`（v1）
> 范围：`packages/services/src/**` 中按缺口降序的第 136~150 个文件（单批 ≤15）。
> 口径：注释行 ÷ 代码行 ≥ 30%（`deep-density.mjs --mode code --threshold 30`）。

## 1. 结果

| 文件 | 代码行 | 注释行（前→后） | 密度 | 新增 |
| --- | ---: | --- | ---: | ---: |
| `cua-permission-broker/cuaAgentAdmissionGate.ts` | 81 | 7 → 26 | 32.10% | 19 |
| `highspeed/highspeedCardService.ts` | 292 | 70 → 92 | 31.51% | 22 |
| `subagents/subagentStorage.ts` | 55 | 0 → 17 | 30.91% | 17 |
| `gen-ui/adapters/files.ts` | 66 | 3 → 21 | 31.82% | 18 |
| `cua-permission-broker/cuaPipSessionService.ts` | 225 | 51 → 71 | 31.56% | 20 |
| `plugins/pluginManagement.ts` | 103 | 15 → 33 | 32.04% | 18 |
| `project-storage/contract.ts` | 95 | 13 → 30 | 31.58% | 17 |
| `git/git.ts` | 53 | 0 → 17 | 32.08% | 17 |
| `window-controller/windowController.ts` | 71 | 6 → 23 | 32.39% | 17 |
| `plugins/plugins.ts` | 52 | 0 → 16 | 30.77% | 16 |
| `task-facts/contract.ts` | 60 | 2 → 19 | 31.67% | 17 |
| `project-catalog/index.ts` | 53 | 1 → 17 | 32.08% | 16 |
| `git/providers/gitEnvironmentProvider.ts` | 54 | 2 → 17 | 31.48% | 15 |
| `logger/serviceLogger.ts` | 57 | 3 → 18 | 31.58% | 15 |
| `oauth/oauthProviderLogout.ts` | 45 | 0 → 14 | 31.11% | 14 |
| **合计** | **1,362** | — | — | **258** |

## 2. 分段

| 段 | 文件 | 内容 | 新增 |
| --- | --- | --- | ---: |
| b18a | `cuaAgentAdmissionGate.ts` | epoch 与等待者并发契约、abort 竞争 | 19 |
| b18a | `highspeedCardService.ts` | 卡生命周期、发送预算、in-flight 去重 | 22 |
| b18a | `subagentStorage.ts` | 路径优先级、配置回落、写入隔离 | 17 |
| b18a | `gen-ui/adapters/files.ts` | 路径包含校验、符号链接与 TOCTOU 防护 | 18 |
| b18b | `cuaPipSessionService.ts` | 会话生命周期、PIP 权限边界、清理时机 | 20 |
| b18b | `pluginManagement.ts` | descriptor 频道不可变更、迁移阶段 | 18 |
| b18b | `project-storage/contract.ts` | workspaceIdentity 回落、组织态归属 | 17 |
| b18b | `git/git.ts` | 门面导出契约、初始化依赖 | 17 |
| b18c | `windowController.ts` | 地址/身份双键语义、重同步与订阅分离 | 17 |
| b18c | `plugins/plugins.ts` | 插件门面、市场移除的幂等 | 16 |
| b18c | `task-facts/contract.ts` | 事实字段契约、缺省值语义 | 17 |
| b18c | `project-catalog/index.ts` | 目录二次读取作为判据 | 16 |
| b18d | `gitEnvironmentProvider.ts` | 候选顺序、全失败返回 null、`--version` 探测 | 15 |
| b18d | `serviceLogger.ts` | `(traceId, ...args)` 形态、debug 回退链 | 15 |
| b18d | `oauthProviderLogout.ts` | 账号维度清理、无标识时不全删 | 14 |

> 分段表按 spec 文件统计；同一文件多段合计等于上表新增。

## 3. 校验原文

```text
node d:\code\_annot_baseline\zc-verify.mjs ZC-deep-svc-b18
SUMMARY files=15 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=258
```

逐文件密度复测（`--only`，15 次全部 `PASS`；最低 30.77%，最高 32.39%）。

b9~b18 十个快照在批后统一复核，全部 `deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0`。

全 services 复测（b18 后）：

```text
SUMMARY files=467 coreBelow30=115 needLines=735 min=0.00 median=31.43 newComments=28920
```

## 4. 本批锚定的不变量

- `cuaAgentAdmissionGate.ts`：准入以 epoch 判定；等待者只在当前 epoch 内被唤醒；abort 与放行竞争只允许一个结果。
- `highspeedCardService.ts`：卡片生命周期单向；发送预算有上限；同键请求在途去重。
- `subagentStorage.ts`：存储路径按优先级解析；配置缺失回落到默认目录。
- `gen-ui/adapters/files.ts`：读取前校验路径包含关系；符号链接不越界；判定与读取之间需二次确认。
- `cuaPipSessionService.ts`：会话创建/销毁成对；PIP 权限只在会话内有效；清理发生在所有出口。
- `pluginManagement.ts`：descriptor 频道名不可变更；迁移按阶段推进且可重入。
- `project-storage/contract.ts`：身份键统一回落到路径；组织态只存项目库。
- `git/git.ts`：门面不承载业务；初始化依赖必须先行。
- `windowController.ts`：地址与身份是双键；重同步与订阅是两条路径。
- `plugins/plugins.ts`：门面只做装配；市场移除幂等。
- `task-facts/contract.ts`：事实字段有固定缺省语义；未提供不等于空值。
- `project-catalog/index.ts`：目录需二次读取确认；一次快照不足以判定。
- `gitEnvironmentProvider.ts`：候选按固定顺序探测；全失败返回 null 而非抛错；`--version` 以退出码为准。
- `serviceLogger.ts`：日志签名固定为 `(traceId, ...args)`；debug 开关按布尔/惰性函数/开发环境顺序回退。
- `oauthProviderLogout.ts`：登出只清账号维度凭据；缺少账号标识时不做全量删除。

## 5. 看似该改、其实不能改

- `cuaAgentAdmissionGate` 不能去掉 epoch：旧等待者会在新一轮放行时被误唤醒。
- `highspeedCardService` 不能取消 in-flight 去重：并发请求会打爆上游配额。
- `subagentStorage` 不能在路径缺失时抛错：默认目录已足够可用。
- `gen-ui/adapters/files` 不能只做一次路径校验：符号链接可绕过包含检查。
- `cuaPipSessionService` 不能在单个出口清理：其他出口会泄漏会话。
- `pluginManagement` 不能修改 descriptor 频道名：已安装插件会收不到迁移事件。
- `project-storage/contract` 不能把组织态写进本地库：多端会看到不一致数据。
- `windowController` 不能只按地址匹配：同一路径的不同工作区会串台。
- `plugins/plugins` 不能在门面里加状态：会破坏单一所有者。
- `task-facts/contract` 不能把缺省值改成 undefined：下游会区分「未提供」与「空」。
- `project-catalog/index` 不能只读一次目录：并发创建会被漏判。
- `gitEnvironmentProvider` 不能在探测失败时抛错：会让整个服务启动失败。
- `serviceLogger` 不能改变参数顺序：traceId 是日志关联的唯一锚点。
- `oauthProviderLogout` 不能在缺少账号标识时全删：会清掉其他账号的凭据。
