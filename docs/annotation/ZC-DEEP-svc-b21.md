# SVC-B21 深度注释索引（runtime-tools / terminal / contracts / oauth / gen-ui）

> 规范母本：`d:\code\opensource\redb\docs\annotation\DEEP-SPEC.md`（v1）
> 范围：`packages/services/src/**` 中按缺口降序的第 181~195 个文件（单批 ≤15）。
> 口径：注释行 ÷ 代码行 ≥ 30%（`deep-density.mjs --mode code --threshold 30`）。

## 1. 结果

| 文件 | 代码行 | 注释行（前→后） | 密度 | 新增 |
| --- | ---: | --- | ---: | ---: |
| `runtime-tools/clientPlatform.ts` | 28 | 0 → 9 | 32.14% | 9 |
| `skill-sync/skillSync.ts` | 28 | 0 → 9 | 32.14% | 9 |
| `terminal/terminalProfileTypes.ts` | 30 | 0 → 10 | 33.33% | 10 |
| `bot-project-runtime/contract.ts` | 34 | 2 → 11 | 32.35% | 9 |
| `process/processTreeTypes.ts` | 54 | 8 → 17 | 31.48% | 9 |
| `runtime-tools/appCaCert.ts` | 60 | 9 → 19 | 31.67% | 10 |
| `terminal/terminal.ts` | 25 | 0 → 8 | 32.00% | 8 |
| `commands/commands.ts` | 26 | 0 → 8 | 30.77% | 8 |
| `oauth/providers/index.ts` | 31 | 2 → 10 | 32.26% | 8 |
| `symlinkPointsToTarget.ts` | 31 | 2 → 10 | 32.26% | 8 |
| `task-facts/repairSubagentTaskIndex.ts` | 34 | 3 → 11 | 32.35% | 8 |
| `prompt-attachment-transfer/promptAttachmentTransfer.ts` | 38 | 4 → 12 | 31.58% | 8 |
| `remote-projects/contract.ts` | 61 | 11 → 19 | 31.15% | 8 |
| `source-server-workspace/sourceServerWorkspace.ts` | 21 | 0 → 7 | 33.33% | 7 |
| `gen-ui/contract.ts` | 25 | 1 → 8 | 32.00% | 7 |
| **合计** | **526** | — | — | **126** |

## 2. 分段

本批仍为小文件（21~61 行），按 3 组并行写入：b21a（runtime-tools / skill-sync / terminal / bot-project / process）、
b21b（appCaCert / terminal / commands / oauth index / symlink）、b21c（task-facts / prompt-attachment / remote-projects / source-server / gen-ui），
三组分别新增 46 / 42 / 38 行。

## 3. 校验原文

```text
node d:\code\_annot_baseline\zc-verify.mjs ZC-deep-svc-b21
SUMMARY files=15 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=126
```

逐文件密度复测（`--only`，15 次全部 `PASS`；最低 30.77%，最高 33.33%）。

全 services 复测（b21 后）：

```text
SUMMARY files=467 coreBelow30=70 needLines=266 min=0.00 median=31.67 newComments=29399
```

## 4. 本批锚定的不变量

- `clientPlatform.ts`：映射表是唯一真相，未命中原样透传；override 优先于映射表。
- `skillSync.ts`：导入禁止静默覆盖；频道名即协议兼容面。
- `terminalProfileTypes.ts`：字段全可选，缺省沿用终端默认，不填硬编码默认色。
- `bot-project-runtime/contract.ts`：连接由 router 之外的所有者创建与关闭，本层只读句柄。
- `processTreeTypes.ts`：空快照不等于进程退出，必须结合身份校验；快照不保证同刻。
- `appCaCert.ts`：证书与私钥必须成对，任一缺失即整体重新生成。
- `terminal.ts`：id 由 create 返回且全局唯一；事件订阅必须先于写入。
- `commands.ts`：写操作以单个文件为单位，返回写入后的快照。
- `oauth/providers/index.ts`：apiClient 必须外部注入；未知 provider 静默跳过。
- `symlinkPointsToTarget.ts`：必须用 realpath 比较；探测失败与不匹配同处理。
- `repairSubagentTaskIndex.ts`：可见会话永不删除；child 身份由 CLI 权威裁决。
- `promptAttachmentTransfer.ts`：operationId 全链路唯一；phase 单调前进，canceled 为唯一任意阶段终态。
- `remote-projects/contract.ts`：entry.hostId 必须指向存在的 host；缓存整体替换不逐字段合并。
- `sourceServerWorkspace.ts`：failed 与 abandoned 互斥计数；resolveWorkspace 必须幂等。
- `gen-ui/contract.ts`：状态方法以完整 target 定位，同一 target 只有唯一权威状态。

## 5. 看似该改、其实不能改

- `clientPlatform` 不能在未知平台抛错：下游应按产物缺失显式暴露。
- `skillSync` 不能放开 overwrite：会静默覆盖用户技能。
- `terminalProfileTypes` 不能把色板键改成必填：旧配置会被整体重置。
- `bot-project-runtime` 不能在本层 dispose 连接：会打断同 workspace 的其他订阅者。
- `processTreeTypes` 不能只凭空快照判成功：会漏杀仍存活的子进程。
- `appCaCert` 不能允许 cert/key 单边存在：会留下不可用的半套证书。
- `terminal` 不能把 dispose 与 onDynamicExit 合并：主动关闭与自然退出语义不同。
- `commands` 不能改成整表覆盖写入：并发编辑会互相覆盖。
- `oauth/providers/index` 不能在内部 new apiClient：会出现多份连接池。
- `symlinkPointsToTarget` 不能改成字符串比较：相对链接会误判。
- `repairSubagentTaskIndex` 不能放宽身份校验：会误删可见会话。
- `promptAttachmentTransfer` 不能在 canceled 后继续处理事件：状态会倒退。
- `remote-projects/contract` 不能让 entry 悬挂：host 移除后入口必须消失。
- `sourceServerWorkspace` 不能去掉 abandoned：失败路径会永久重试。
- `gen-ui/contract` 不能省略 instanceKey：沙箱实例会跨窗口串用。
