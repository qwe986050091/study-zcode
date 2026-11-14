# SVC-B12 深度注释索引（project / providers / runtime-tools / git）

> 规范母本：`d:\code\opensource\redb\docs\annotation\DEEP-SPEC.md`（v1）
> 范围：`packages/services/src/**` 中按缺口降序的第 46~60 个文件（单批 ≤15）。
> 口径：注释行 ÷ 代码行 ≥ 30%（`deep-density.mjs --mode code --threshold 30`）。

## 1. 结果

| 文件 | 代码行 | 注释行（前→后） | 密度 | 新增 |
| --- | ---: | --- | ---: | ---: |
| `project/index.ts` | 305 | 19 → 97 | 31.80% | 78 |
| `feedback/feedbackService.ts` | 257 | 6 → 84 | 32.68% | 78 |
| `highspeed/highspeedHttpTransport.ts` | 273 | 14 → 84 | 30.77% | 70 |
| `zcode-session/zcodeSessionService.ts` | 408 | 55 → 126 | 30.88% | 71 |
| `index.ts` | 326 | 36 → 102 | 31.29% | 66 |
| `hooks/hooksService.ts` | 295 | 28 → 94 | 31.86% | 66 |
| `subagents/subagentRuntimeConfig.ts` | 219 | 8 → 68 | 31.05% | 60 |
| `providers/api/nodeApiNetwork.ts` | 226 | 11 → 71 | 31.42% | 60 |
| `runtime-tools/runtimeCommandEnv.ts` | 234 | 14 → 74 | 31.62% | 60 |
| `providers/codexConfigToml.ts` | 194 | 2 → 61 | 31.44% | 59 |
| `runtime-tools/runtimeLoginShellEnvCapture.ts` | 217 | 9 → 68 | 31.34% | 59 |
| `git/repo/gitCheckpointHelpers.ts` | 184 | 0 → 58 | 31.52% | 58 |
| `git/providers/gitCommandProvider.ts` | 206 | 6 → 63 | 30.58% | 57 |
| `project-storage/migrate-projects.ts` | 201 | 9 → 64 | 31.84% | 55 |
| `bot-project-runtime/index.ts` | 168 | 1 → 54 | 32.14% | 53 |
| **合计** | **3,713** | — | — | **950** |

## 2. 分段

| 段 | 文件 | 内容 | 新增 |
| --- | --- | --- | ---: |
| b12a | `project/index.ts` | 状态不落库、root 归一、先路由后副作用、首建单飞 | 78 |
| b12a | `feedbackService.ts` | device_mid 复用、附件名防穿越、临时目录清理、取消语义 | 78 |
| b12a | `highspeedHttpTransport.ts` | 超时与取消顺序、四类错误归一、日志脱敏 | 70 |
| b12a | `zcodeSessionService.ts` | 先订阅后广播、草稿清理、thoughtLevel 三态 | 71 |
| b12b | `index.ts` | browser-safe 边界、导出契约、`./node` 子路径隔离 | 66 |
| b12b | `hooksService.ts` | 发现顺序即执行顺序、location 决定 scope、fail-closed | 66 |
| b12c | `subagentRuntimeConfig.ts` | 缓存所有权、busy 快照降级 | 60 |
| b12c | `codexConfigToml.ts` | 表结构与转义边界、bare key | 59 |
| b12c | `runtimeLoginShellEnvCapture.ts` | 双层超时、2MB 预算、进程组 kill | 59 |
| b12c | `nodeApiNetwork.ts` | 直连旁路、dispatcher 单飞、dispose 后 fail-closed | 60 |
| b12c | `runtimeCommandEnv.ts` | 四层覆盖优先级、PATH 单键、sanitize 顺序 | 60 |
| b12c | `gitCheckpointHelpers.ts` | ref 隔离、`-z` 解析、临时索引隔离 | 58 |
| b12c | `gitCommandProvider.ts` | 参数合并、退出码映射、三段式超时 | 57 |
| b12c | `migrate-projects.ts` | 迁移顺序、别名归一、幂等与回滚 | 55 |
| b12c | `bot-project-runtime/index.ts` | 三重校验、Lease 复核、逐调用验租约 | 53 |

> 分段表按 spec 文件统计；同一文件多段合计等于上表新增。

## 3. 校验原文

```text
node d:\code\_annot_baseline\zc-verify.mjs ZC-deep-svc-b12
SUMMARY files=15 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=950
```

逐文件密度复测（`--only`，15 次全部 `PASS`；最低 30.58%，最高 32.68%）。

全 services 复测（b12 后）：

```text
SUMMARY files=467 coreBelow30=205 needLines=3306 min=0.00 median=30.58 newComments=26187
```

## 4. 本批锚定的不变量

- `project/index.ts`：项目状态不落库；root 必须绝对化并 normalize；先路由再产生副作用；首次创建单飞。
- `feedbackService.ts`：`device_mid` 复用；附件名只取 basename 防穿越；所有出口都清理临时目录。
- `highspeedHttpTransport.ts`：AbortController 与 clearTimeout 的释放顺序固定；业务码失败与网络失败分开归一。
- `zcodeSessionService.ts`：先订阅后广播；关闭时必须清理 deferred 草稿；`thoughtLevel` 三态需要重放。
- `index.ts`：导出名与导出种类不可随意改；browser 侧不得引入 `./node` 专属依赖。
- `hooksService.ts`：发现顺序即执行顺序（项目 → legacy → 用户）；`location` 决定回写的 scope；trust store fail-closed。
- `subagentRuntimeConfig.ts`：缓存所有权归本模块；busy 时降级为快照而不是阻塞。
- `codexConfigToml.ts`：表结构与转义边界（U+007F、`nan`/`inf`、bare key）必须按 TOML 语义处理。
- `runtimeLoginShellEnvCapture.ts`：双层 4s 超时；2 MiB 预算；超时必须杀进程组。
- `nodeApiNetwork.ts`：代理 URL 非法时不退化为直连；dispatcher 缓存键单飞；dispose 后 fail-closed。
- `runtimeCommandEnv.ts`：覆盖优先级固定为「快照白名单 → 工具透传 → 内置工具 → Python 补丁」；Windows PATH 收敛为单键。
- `gitCheckpointHelpers.ts`：checkpoint ref 命名空间隔离；`-z` 以 NUL 解析；临时索引不触碰真实 index。
- `gitCommandProvider.ts`：退出码 `-2` 归因为 spawn 失败；超时后按孤儿进程处理；输出按字节截断。
- `migrate-projects.ts`：迁移顺序不可交换；幂等条件为 `project_id IS NULL`；失败必须回滚。
- `bot-project-runtime/index.ts`：身份/路径/hostId 三重校验；每次调用都要重新验租约。

## 5. 看似该改、其实不能改

- `project/index.ts` 不能在路由前落库：副作用先发生，失败会留下脏状态。
- `feedbackService` 不能用完整路径拼附件名：会被 `../` 穿越到临时目录外。
- `highspeedHttpTransport` 不能先 clearTimeout 再 abort：会丢掉取消信号。
- `zcodeSessionService` 不能先广播再订阅：首帧事件会丢失。
- `index.ts` 不能把 node 专属导出放进 browser 入口：打包会引入 node 内置模块。
- `hooksService` 不能让未知 trust 状态默认放行：应 fail-closed。
- `codexConfigToml` 不能把 `nan`/`inf` 当普通标识符：TOML 有专门语义。
- `runtimeLoginShellEnvCapture` 不能只 kill 子进程：登录 shell 会派生子进程，必须杀进程组。
- `nodeApiNetwork` 不能在代理 URL 非法时静默直连：会绕过用户显式配置的代理。
- `runtimeCommandEnv` 不能先做 Python 补丁再 sanitize：补丁会被清理掉。
- `gitCheckpointHelpers` 不能复用真实 index：会污染用户暂存区。
- `migrate-projects` 不能把迁移改成无序执行：后续步骤依赖前序列已存在。
