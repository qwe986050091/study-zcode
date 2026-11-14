# SVC-B10 深度注释索引（telemetry / file / process / oauth 等中段文件）

> 规范母本：`d:\code\opensource\redb\docs\annotation\DEEP-SPEC.md`（v1）
> 范围：`packages/services/src/**` 中按缺口降序的第 16~30 个文件（单批 ≤15）。
> 口径：注释行 ÷ 代码行 ≥ 30%（`deep-density.mjs --mode code --threshold 30`）。

## 1. 结果

| 文件 | 代码行 | 注释行（前→后） | 密度 | 新增 |
| --- | ---: | --- | ---: | ---: |
| `telemetry/telemetryCore.ts` | 589 | 37 → 181 | 30.73% | 144 |
| `skill-sync/skillSyncService.ts` | 472 | 9 → 146 | 30.93% | 137 |
| `file/fileService.ts` | 581 | 43 → 181 | 31.15% | 138 |
| `project-storage/project-repository.ts` | 397 | 6 → 128 | 32.24% | 122 |
| `terminal/terminalProfile.ts` | 369 | 4 → 116 | 31.44% | 112 |
| `system/systemService.ts` | 344 | 0 → 110 | 31.98% | 110 |
| `subagents/subagentMarkdown.ts` | 381 | 11 → 119 | 31.23% | 108 |
| `providers/api/nodeApiClient.ts` | 381 | 14 → 123 | 32.28% | 109 |
| `cua-permission-broker/windowsCuaDevHelperHost.ts` | 444 | 33 → 138 | 31.08% | 105 |
| `terminal/terminalProfileMacOs.ts` | 331 | 1 → 104 | 31.42% | 103 |
| `remote-projects/index.ts` | 366 | 11 → 114 | 31.15% | 103 |
| `oauth/repo/oauthCredentialRepo.ts` | 381 | 19 → 119 | 31.23% | 100 |
| `task-groups/repository.ts` | 329 | 5 → 102 | 31.00% | 97 |
| `cloud-content/contentBundleCache.ts` | 312 | 1 → 99 | 31.73% | 98 |
| `git/gitCommitMessageGenerator.ts` | 322 | 4 → 101 | 31.37% | 97 |
| **合计** | **5,999** | — | — | **1,683** |

## 2. 分段

| 段 | 文件 | 内容 | 新增 |
| --- | --- | --- | ---: |
| b10a | `telemetryCore.ts` | 出网同源、退出屏障、O_EXCL 锁与孤儿锁回收、每日活跃三阶段提交 | 144 |
| b10a | `skillSyncService.ts` | 有界扫描、先校验后落盘、只增不改幂等、临时目录清理 | 137 |
| b10a | `fileService.ts` | 读取预算、二进制判定、句柄释放、软链分类、越界校验顺序 | 138 |
| b10a | `project-repository.ts` | 事务模式、复合键、软删除、roots 整表替换、名称去重 | 122 |
| b10b | `terminalProfile.ts` | 显式控件优先、继承关闭、探测降级、JSONC 容错 | 112 |
| b10b | `systemService.ts` | 目标归一、超时夹取、socket 单次 settle、空目标语义 | 110 |
| b10b | `subagentMarkdown.ts` | 诊断不抛错、loose 合并顺序、写出可回读 | 108 |
| b10b | `nodeApiClient.ts` | 来源头注入、取消合成、凭据登出判据 | 109 |
| b10b | `windowsCuaDevHelperHost.ts` | lifecycleTail 线性化、tuple 不可替换、两阶段健康判定 | 105 |
| b10b | `terminalProfileMacOs.ts` | plutil 有界调用、平台双守卫、字体/颜色回退 | 103 |
| b10c | `remote-projects/index.ts` | alias 归一、入口去重与上限、CAS 版本 | 103 |
| b10c | `oauthCredentialRepo.ts` | provider 命名空间、JWT 读写对称、覆盖语义 | 100 |
| b10c | `task-groups/repository.ts` | 单组归属、order 分工、禁止嵌套、事务内无 await | 97 |
| b10c | `contentBundleCache.ts` | 缓存键复验、exclusive 串行、双校验原子落盘 | 98 |
| b10c | `gitCommitMessageGenerator.ts` | prompt 双重预算、确定性截断、三态错误映射 | 97 |

> 分段表按 spec 文件统计；同一文件多段合计等于上表新增。

## 3. 校验原文

```text
node d:\code\_annot_baseline\zc-verify.mjs ZC-deep-svc-b10
SUMMARY files=15 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=1683
```

逐文件密度复测（`--only`，15 次全部 `PASS`，newComments 依次为 144/137/138/122/112/110/108/109/105/103/103/100/97/98/97）。

全 services 复测（b10 后）：

```text
SUMMARY files=467 coreBelow30=235 needLines=5455 min=0.00 median=26.09 newComments=23915
```

## 4. 本批锚定的不变量

- `telemetryCore.ts`：遥测只走同一出口域名；退出时 `trackReport` 是屏障，必须先落盘；in-flight 计数只在锁内改；4xx 不可重试。
- `skillSyncService.ts`：先解包校验再落盘；导入「只增不改」；临时目录在 finally 清理；扫描深度与体积有上限。
- `fileService.ts`：读取预算必须 clamp；句柄在 finally 释放；越界校验与 realpath 解析有固定先后顺序。
- `project-repository.ts`：写事务用 BEGIN IMMEDIATE；roots 整表替换以保证删除生效；主根唯一；名称去重在同一事务内完成。
- `terminalProfile.ts`：显式控件优先于探测；关闭继承时不得读取系统配置；探测失败降级为 null，`fontFamily` 永不为空。
- `systemService.ts`：目标先归一化再过滤；单目标失败不整体 reject；Socket 只 settle 一次且 settle 前 destroy。
- `subagentMarkdown.ts`：诊断收集不抛错；`loose` 覆盖 `yaml`；写出的内容必须能被自身读回。
- `nodeApiClient.ts`：来源头统一注入；timeout 与调用方 signal 合成为单一取消源；只有「凭据失效的证据」才触发登出。
- `windowsCuaDevHelperHost.ts`：`lifecycleTail` 线性化生命周期；已暴露的 tuple 不可替换；跨代 stop 用 `externalStopEpoch` 拒绝。
- `terminalProfileMacOs.ts`：`plutil` 调用有界；平台与文件存在性双守卫；字体三层回退、颜色三档归一。
- `remote-projects/index.ts`：alias 与 serverId 归一后去重；入口上限 20；写入走 CAS 版本校验。
- `oauthCredentialRepo.ts`：provider key 有命名空间；共享 JWT 读写对称；refresh token 覆盖语义固定；解密失败整体清理。
- `task-groups/repository.ts`：成员只属于一个组；组 order 与成员 sort_order 分工明确；事务内禁止 await。
- `contentBundleCache.ts`：缓存命中要复验；exclusive 串行下载；staging→rename 原子落盘并在 finally 清理。
- `gitCommitMessageGenerator.ts`：prompt 双重预算；截断必须确定性；Conventional Commit 校验后才落盘。

## 5. 看似该改、其实不能改

- `telemetryCore` 不能把 4xx 纳入重试：客户端错误重试只会放大无效流量。
- `skillSyncService` 不能先落盘再校验：解包校验失败时目标目录已被污染。
- `fileService` 不能把 realpath 解析挪到越界检查之后：顺序反了会先访问到仓库外路径。
- `project-repository` 不能把 roots 改成增量合并：已删除的根永远不会被移除。
- `subagentMarkdown` 不能反过来用 `yaml` 覆盖 `loose`：内置字段会被外部 Markdown 覆盖。
- `nodeApiClient` 不能无条件登出：网络抖动会被误判成凭据失效。
- `windowsCuaDevHelperHost` 不能在重启后原地替换 tuple：并发方仍持有旧 tuple，句柄会错配。
- `task-groups/repository` 不能在事务体内加 await：会破坏串行化并放大锁等待。
- `contentBundleCache` 不能只信 `content-length`：必须同时校验 sha256。
- `gitCommitMessageGenerator` 不能把模型输出的多行直接当 subject：必须按确定性规则裁剪。
