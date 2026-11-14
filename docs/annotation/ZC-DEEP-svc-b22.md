# SVC-B22 深度注释索引（导航 / storage ports / mcp-sync / setting / git / skills / project）

> 规范母本：`d:\code\opensource\redb\docs\annotation\DEEP-SPEC.md`（v1）
> 范围：`packages/services/src/**` 中按缺口降序的第 196~210 个文件（单批 ≤15）。
> 口径：注释行 ÷ 代码行 ≥ 30%（`deep-density.mjs --mode code --threshold 30`）。

## 1. 结果

| 文件 | 代码行 | 注释行（前→后） | 密度 | 新增 |
| --- | ---: | --- | ---: | ---: |
| `project-workspace-navigation/contract.ts` | 32 | 3 → 10 | 31.25% | 7 |
| `storage/app/ports.ts` | 39 | 5 → 12 | 30.77% | 7 |
| `mcp-sync/mcpSync.ts` | 40 | 5 → 13 | 32.50% | 8 |
| `setting/normalizeSettingsPatch.ts` | 75 | 16 → 23 | 30.67% | 7 |
| `highspeed/highspeedCard.ts` | 17 | 0 → 6 | 35.29% | 6 |
| `oauth/callbackAttribution.ts` | 17 | 0 → 6 | 35.29% | 6 |
| `git/gitCheckpoint.ts` | 20 | 0 → 7 | 35.00% | 7 |
| `plugin-ui-bridge/pluginUiSamplingService.ts` | 20 | 0 → 7 | 35.00% | 7 |
| `window-project-directory/contract.ts` | 23 | 1 → 7 | 30.43% | 6 |
| `project-storage/remote-policy.ts` | 26 | 2 → 8 | 30.77% | 6 |
| `oauth/providers/configUtils.ts` | 30 | 3 → 10 | 33.33% | 7 |
| `storage/adapters/rootsResolver.ts` | 32 | 4 → 10 | 31.25% | 6 |
| `storage/adapters/volumeProbe.ts` | 34 | 5 → 11 | 32.35% | 6 |
| `skills/skills.ts` | 40 | 6 → 13 | 32.50% | 7 |
| `project/contract.ts` | 50 | 9 → 16 | 32.00% | 7 |
| **合计** | **525** | — | — | **100** |

## 2. 分段

本批文件 17~75 行，按 3 组并行写入：b22a（导航 / storage ports / mcp-sync / setting / highspeed，35 行）、
b22b（oauth 回调 / git / plugin-ui 采样 / 窗口目录 / 远端策略，32 行）、
b22c（configUtils / storage adapters / skills / project，33 行）。

## 3. 校验原文

```text
node d:\code\_annot_baseline\zc-verify.mjs ZC-deep-svc-b22
SUMMARY files=15 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=100
```

逐文件密度复测（`--only`，15 次全部 `PASS`；最低 30.43%，最高 35.29%）。

全 services 复测（b22 后）：

```text
SUMMARY files=467 coreBelow30=55 needLines=172 min=0.00 median=31.73 newComments=29499
```

## 4. 本批锚定的不变量

- `project-workspace-navigation/contract.ts`：目录解析与远端 admission 必须由 Window Host 同一所有者完成；directories 与 remote 必须同源。
- `storage/app/ports.ts`：耗时操作接受 AbortSignal 并返回失败项集合；errors 与 roots 必须同时返回。
- `mcp-sync/mcpSync.ts`：workspace 身份以 workspaceIdentity 优先、workspacePath 兜底；导入是唯一写远程入口。
- `normalizeSettingsPatch.ts`：只归一不补默认值；绝不修改入参 patch。
- `highspeedCard.ts`：invalidateCard 返回 false 即不可复用；prepareTurn 需幂等。
- `callbackAttribution.ts`：参数全空返回 undefined；只认白名单 key。
- `gitCheckpoint.ts`：检查点以 workspace 为作用域；interface 与 descriptor 同名合并。
- `pluginUiSamplingService.ts`：sample 缺失即抛 unavailable；cancelSampling 缺失返回 cancelled:false。
- `window-project-directory/contract.ts`：三个句柄须同源获取；变更事件不带载荷。
- `remote-policy.ts`：远端只允许单根；新建任务必须已有项目；豁免只看 ownerHostId。
- `configUtils.ts`：env 必须注入；空串视为未配置；只有 0/false 判假。
- `rootsResolver.ts`：home 恒在首位且必须存在；顺序即检索优先级。
- `volumeProbe.ts`：失败返回 null 而非 0；用 bavail 而非 bfree；不做跨调用缓存。
- `skills.ts`：workspaceIdentity 缺省以 workspacePath 为身份键；只暴露 skillId。
- `project/contract.ts`：hostId 缺省即当前 Host；全量 ID 重排需单事务且整体拒绝。

## 5. 看似该改、其实不能改

- `project-workspace-navigation` 不能让导航层各自建连：provisional 连接会互相覆盖。
- `storage/app/ports` 不能在单根失败时整体抛错：UI 需要降级结果。
- `mcpSync` 不能在本服务拉起 MCP 进程：PATH 与 cwd 属于 workspace 环境。
- `normalizeSettingsPatch` 不能顺手补默认值：会锁死用户运行环境。
- `highspeedCard` 不能在 invalidate 返回 false 后复用旧卡：预算会被重复消耗。
- `callbackAttribution` 不能透传空串：会污染统计口径。
- `gitCheckpoint` 不能把 descriptor 改成不同名：依赖注入会解析到 undefined。
- `pluginUiSamplingService` 不能静默返回空样本：插件会误读为无数据。
- `window-project-directory` 不能复用全局项目通道：窗口可见范围会越界。
- `remote-policy` 不能放开多根：缺少跨目录一致性模型。
- `configUtils` 不能在模块内读 process.env：测试与多环境不可复现。
- `rootsResolver` 不能对未规范化的路径去重：重复 root 会让扫描翻倍。
- `volumeProbe` 不能用 bfree：会把 root 保留块算成用户可用空间。
- `skills` 不能把真实目录暴露给 UI：越界校验会失守。
- `project/contract` 不能让 includeDeleted 默认 true：普通列表语义被破坏。
