# SVC-B17 深度注释索引（project-storage / marketing-touch / git / credential / process / plugins）

> 规范母本：`d:\code\opensource\redb\docs\annotation\DEEP-SPEC.md`（v1）
> 范围：`packages/services/src/**` 中按缺口降序的第 121~135 个文件（单批 ≤15）。
> 口径：注释行 ÷ 代码行 ≥ 30%（`deep-density.mjs --mode code --threshold 30`）。

## 1. 结果

| 文件 | 代码行 | 注释行（前→后） | 密度 | 新增 |
| --- | ---: | --- | ---: | ---: |
| `project-storage/index.ts` | 70 | 0 → 22 | 31.43% | 22 |
| `marketing-touch/marketingTouchService.ts` | 76 | 2 → 24 | 31.58% | 22 |
| `git/repo/gitCheckpointRepo.ts` | 370 | 91 → 117 | 31.62% | 26 |
| `accessor.ts` | 110 | 13 → 35 | 31.82% | 22 |
| `credential/credentialService.ts` | 133 | 20 → 42 | 31.58% | 22 |
| `source-server-workspace/sourceServerWorkspaceService.ts` | 65 | 0 → 21 | 32.31% | 21 |
| `highspeed/highspeedMockTransport.ts` | 62 | 0 → 20 | 32.26% | 20 |
| `providers/api/networkErrorClassifier.ts` | 76 | 4 → 24 | 31.58% | 20 |
| `storage/app/storageService.ts` | 90 | 8 → 29 | 32.22% | 21 |
| `source-server-management/sourceServerManagement.ts` | 67 | 2 → 21 | 31.34% | 19 |
| `process/runtimeProcessLifecycle.ts` | 76 | 4 → 24 | 31.58% | 20 |
| `feedback/feedback.ts` | 63 | 0 → 20 | 31.75% | 20 |
| `runtime-tools/providerRuntimeResolver.ts` | 197 | 42 → 63 | 31.98% | 21 |
| `usage-stats/providers/bigmodelSubscriptionProvider.ts` | 58 | 0 → 18 | 31.03% | 18 |
| `plugins/installedPluginRoots.ts` | 59 | 0 → 19 | 32.20% | 19 |
| **合计** | **1,572** | — | — | **313** |

## 2. 分段

| 段 | 文件 | 内容 | 新增 |
| --- | --- | --- | ---: |
| b17a | `project-storage/index.ts` | 模块导出契约、存储门面、初始化顺序 | 22 |
| b17a | `marketingTouchService.ts` | 触点归属、Bearer 模板不内插、事件去重 | 22 |
| b17a | `gitCheckpointRepo.ts` | 临时 index 预热、pathspec 限定、restore 冲突基线 | 26 |
| b17a | `accessor.ts` | 访问器分层、只读视图、依赖方向 | 22 |
| b17b | `credentialService.ts` | 锁内读改写、schema 双向校验、错误分类白名单 | 22 |
| b17b | `sourceServerWorkspaceService.ts` | 源服务工作区映射、缺省回退 | 21 |
| b17b | `highspeedMockTransport.ts` | 模拟传输边界、可控延迟/失败注入 | 20 |
| b17b | `networkErrorClassifier.ts` | 可重试错误白名单、cause/AggregateError 展开 | 20 |
| b17c | `storageService.ts` | 写操作返回整份快照、快照/事件分工 | 21 |
| b17c | `sourceServerManagement.ts` | 服务注入 token、频道契约、幂等边界 | 19 |
| b17c | `runtimeProcessLifecycle.ts` | spawn/ready/exit/error 语义、watchdog 归因 | 20 |
| b17c | `feedback.ts` | progressId 分流、operationId 幂等、取消尽力而为 | 20 |
| b17d | `providerRuntimeResolver.ts` | 解析优先级、平台目录假设、降级路径 | 21 |
| b17d | `bigmodelSubscriptionProvider.ts` | 订阅查询契约、失败降级、空结果语义 | 18 |
| b17d | `installedPluginRoots.ts` | 根目录发现顺序、去重、不存在即跳过 | 19 |

> 分段表按 spec 文件统计；同一文件多段合计等于上表新增。

## 3. 校验原文

```text
node d:\code\_annot_baseline\zc-verify.mjs ZC-deep-svc-b17
SUMMARY files=15 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=313
```

逐文件密度复测（`--only`，15 次全部 `PASS`；最低 31.03%，最高 32.31%）。

b9~b17 九个快照在批后统一复核，全部 `deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0`。

全 services 复测（b17 后）：

```text
SUMMARY files=467 coreBelow30=130 needLines=977 min=0.00 median=31.36 newComments=28662
```

## 4. 本批锚定的不变量

- `project-storage/index.ts`：门面只做导出与装配；初始化顺序不可交换。
- `marketingTouchService.ts`：触点归属由身份决定；Bearer 拼接不在模板内插值；同名事件只记一次。
- `gitCheckpointRepo.ts`：checkpoint 用临时 index 预热；pathspec 限定范围；restore 以冲突检测为基线。
- `accessor.ts`：访问器只暴露只读视图；依赖方向单向。
- `credentialService.ts`：读改写必须在锁内；写入前后做 schema 双向校验；错误按白名单分类。
- `sourceServerWorkspaceService.ts`：工作区映射由源服务标识派生；缺省回退到本地路径。
- `highspeedMockTransport.ts`：模拟层可注入延迟与失败；不改变调用方契约。
- `networkErrorClassifier.ts`：仅白名单错误可重试；cause/AggregateError 需展开判断。
- `storageService.ts`：写操作返回整份快照；快照与事件职责分离。
- `sourceServerManagement.ts`：服务经注入获得；频道名是契约；重复调用幂等。
- `runtimeProcessLifecycle.ts`：spawn/ready/exit/error 事件语义固定；watchdog 只归因不改变退出结果。
- `feedback.ts`：progressId 决定分流；operationId 保证幂等；取消是尽力而为。
- `providerRuntimeResolver.ts`：解析优先级固定；平台目录假设集中；失败走降级路径。
- `bigmodelSubscriptionProvider.ts`：查询契约固定；失败降级；空结果不等于错误。
- `installedPluginRoots.ts`：根目录按固定顺序发现；结果去重；不存在的根直接跳过。

## 5. 看似该改、其实不能改

- `project-storage/index` 不能在门面里加业务逻辑：会让初始化顺序变得不可推理。
- `marketingTouchService` 不能把 token 拼进模板字符串：会被日志与错误上报带出。
- `gitCheckpointRepo` 不能跳过临时 index：直接操作工作区 index 会污染用户暂存区。
- `accessor` 不能返回可写引用：调用方会绕过服务层直接改状态。
- `credentialService` 不能把读改写拆到锁外：并发写会丢更新。
- `sourceServerWorkspaceService` 不能对未知源服务抛错：旧工作区会整体不可打开。
- `highspeedMockTransport` 不能在模拟层吞掉错误：测试会失去失败路径覆盖。
- `networkErrorClassifier` 不能把所有网络错误都判可重试：非幂等请求会被重复提交。
- `storageService` 不能只返回增量：调用方依赖整份快照做全量渲染。
- `sourceServerManagement` 不能改成全局单例：多窗口会共享同一份连接状态。
- `runtimeProcessLifecycle` 不能让 watchdog 直接改写退出码：会掩盖真实退出原因。
- `feedback` 不能去掉 operationId 幂等：重试会产生重复归档。
- `providerRuntimeResolver` 不能把平台目录写死成单一值：跨平台会找不到运行时。
- `bigmodelSubscriptionProvider` 不能把空结果当失败：未订阅是正常状态。
- `installedPluginRoots` 不能在发现阶段抛错：单个坏根会让所有插件不可用。
