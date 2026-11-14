# SVC-B14 深度注释索引（process / task-groups / plugins / storage）

> 规范母本：`d:\code\opensource\redb\docs\annotation\DEEP-SPEC.md`（v1）
> 范围：`packages/services/src/**` 中按缺口降序的第 76~90 个文件（单批 ≤15）。
> 口径：注释行 ÷ 代码行 ≥ 30%（`deep-density.mjs --mode code --threshold 30`）。

## 1. 结果

| 文件 | 代码行 | 注释行（前→后） | 密度 | 新增 |
| --- | ---: | --- | ---: | ---: |
| `process/processTreeWaiter.ts` | 212 | 22 → 68 | 32.08% | 46 |
| `runtime-tools/runtimeToolResolver.ts` | 136 | 0 → 44 | 32.35% | 44 |
| `project/legacy-single-root.ts` | 157 | 7 → 50 | 31.85% | 43 |
| `task-groups/index.ts` | 131 | 0 → 42 | 32.06% | 42 |
| `output-style/outputStyleService.ts` | 207 | 24 → 65 | 31.40% | 41 |
| `plugins/pluginManagementService.ts` | 202 | 23 → 64 | 31.68% | 41 |
| `project-workspace-navigation/index.ts` | 125 | 2 → 40 | 32.00% | 38 |
| `zcode-session/zcodeSession.ts` | 145 | 8 → 46 | 31.72% | 38 |
| `storage/domain/storageCatalog.ts` | 184 | 20 → 58 | 31.52% | 38 |
| `marketing-touch/marketingAssetRegistry.ts` | 117 | 1 → 38 | 32.48% | 37 |
| `project-storage/legacy-tasks.ts` | 133 | 6 → 42 | 31.58% | 36 |
| `git/repo/gitCliTypes.ts` | 110 | 0 → 35 | 31.82% | 35 |
| `system/integratedTerminalShells.ts` | 108 | 0 → 35 | 32.41% | 35 |
| `usage-stats/usageStatsService.ts` | 153 | 13 → 49 | 32.03% | 36 |
| `remote-projects/workspace-settings.ts` | 115 | 3 → 37 | 32.17% | 34 |
| **合计** | **2,235** | — | — | **584** |

## 2. 分段

| 段 | 文件 | 内容 | 新增 |
| --- | --- | --- | ---: |
| b14a | `processTreeWaiter.ts` | 3.5s/4s 强杀边界、晚到 exit、settle 幂等与 timer 释放 | 46 |
| b14a | `runtimeToolResolver.ts` | env > runtimeRoot > bundled > PATH 优先级、exists+X_OK 双校验 | 44 |
| b14a | `legacy-single-root.ts` | 合成 ID 纯函数、verifyHost 先于 I/O、非事务去重边界 | 43 |
| b14a | `task-groups/index.ts` | host 身份一致、存活性过滤、afterChange 时序 | 42 |
| b14a | `outputStyleService.ts` | 内置风格不依赖磁盘、enabled 现算、`custom-` 前缀剥离 | 41 |
| b14a | `pluginManagementService.ts` | 无缓存、唯一上报入口、启停同路径 | 41 |
| b14b | `project-workspace-navigation/index.ts` | 远程需保留项目、identity 非空、stale 闸门 | 38 |
| b14b | `zcodeSession.ts` | 生命周期分组、expectedRevision 乐观并发、草稿事务 | 38 |
| b14b | `storageCatalog.ts` | 目录优先级、清理范围递归/非递归权衡、保护名单 | 38 |
| b14c | `marketingAssetRegistry.ts` | 白名单唯一写入方、48MB 按插入序逐出、pending 复用 | 37 |
| b14c | `legacy-tasks.ts` | 只写身份列、handoff 按位或、整批事务 | 36 |
| b14c | `gitCliTypes.ts` | resolution 前置、stats 相对路径键、空摘要不推断 | 35 |
| b14c | `integratedTerminalShells.ts` | id 唯一、候选可执行性收口、env 大小写不敏感 | 35 |
| b14c | `usageStatsService.ts` | 数据源隔离、TTL 窗口、在途 Promise 合并 | 36 |
| b14c | `workspace-settings.ts` | 单一快照派生、身份由构造器生成、去重键含 hostId | 34 |

> 分段表按 spec 文件统计；同一文件多段合计等于上表新增。

## 3. 校验原文

```text
node d:\code\_annot_baseline\zc-verify.mjs ZC-deep-svc-b14
SUMMARY files=15 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=584
```

逐文件密度复测（`--only`，15 次全部 `PASS`；最低 31.40%，最高 32.48%）。

b9~b14 六个快照在批后统一复核，全部 `deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0`。

全 services 复测（b14 后）：

```text
SUMMARY files=467 coreBelow30=175 needLines=2071 min=0.00 median=30.93 newComments=27501
```

## 4. 本批锚定的不变量

- `processTreeWaiter.ts`：Host 3.5s / 4s 是强杀边界；晚到 exit 只能观察，不能改变结论；settle 幂等并释放 timer。
- `runtimeToolResolver.ts`：优先级固定为 env > runtimeRoot/resourcesPath > bundled-tools > PATH；必须 `exists` 且 `X_OK` 双校验。
- `legacy-single-root.ts`：合成 ID 是纯函数；`directoryMatchPath` 只匹配不参与 ID；`verifyHost` 先于任何 I/O。
- `task-groups/index.ts`：host 身份必须一致；已失效连接不参与列表；`afterChange` 在提交后触发。
- `outputStyleService.ts`：内置风格不依赖磁盘；`enabled` 每次现算；自定义项必须剥离 `custom-` 前缀。
- `pluginManagementService.ts`：不缓存插件状态；上报入口唯一；启停走同一条路径。
- `project-workspace-navigation/index.ts`：远程工作区必须先有保留项目；identity 恒非空；发布前过 stale 闸门。
- `zcodeSession.ts`：`Set*` 走 `expectedRevision` 乐观并发；close/promote 的草稿清理在事务内完成。
- `storageCatalog.ts`：目录分类有固定优先级；清理范围区分递归与非递归；保护名单兜底。
- `marketingAssetRegistry.ts`：白名单是唯一写入方；48 MiB 按插入序逐出；pending 结果复用。
- `legacy-tasks.ts`：只写身份列；handoff 按位或；整批在同一事务内。
- `gitCliTypes.ts`：resolution 必须先于其它字段；stats 键为相对路径；空摘要不得推断。
- `integratedTerminalShells.ts`：id 唯一；候选可执行性只有一个收口点；env 解析大小写不敏感。
- `usageStatsService.ts`：数据源隔离；TTL 窗口统一；在途 Promise 合并顺序固定；Reset 不缓存。
- `workspace-settings.ts`：只从单一快照派生；identity 由构造器生成；去重键必须含 hostId。

## 5. 看似该改、其实不能改

- `processTreeWaiter` 不能缩短 3.5s/4s 边界：Windows 下进程退出与句柄释放存在固有延迟。
- `runtimeToolResolver` 不能省略 `X_OK`：存在但不可执行的文件会让 spawn 直接失败。
- `legacy-single-root` 不能把 `directoryMatchPath` 并入 ID 计算：同一项目会因路径写法不同裂成两个身份。
- `task-groups/index` 不能在 `afterChange` 前广播：订阅方读到的还是旧数据。
- `outputStyleService` 不能缓存 `enabled`：配置变更后需要立即生效。
- `pluginManagementService` 不能缓存插件列表：外部安装/卸载后状态会过期。
- `workspace-navigation` 不能先发布再校验 stale：会短暂暴露已失效项目。
- `zcodeSession` 不能去掉 `expectedRevision`：并发写会静默覆盖。
- `storageCatalog` 不能把所有目录都按递归清理：会误删仍在使用的父目录。
- `marketingAssetRegistry` 不能改成 LRU 逐出：插入序才是「最近一次白名单」的语义。
- `gitCliTypes` 不能在 resolution 缺失时兜底推断：会让不可解析的 diff 被误认成删除。
- `usageStatsService` 不能在 Reset 上做缓存：重置后的首读必须反映真实状态。
