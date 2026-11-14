# ZC-DEEP-b72

> 批次：B72（12 文件，按 31.4% 口径计算目标 739 行，实际 +739，无补插）。
> 执行分三波：4 + 4 + 4（并发上限 5），每文件独立 spec。
> 基线快照：`d:\code\_annot_baseline\ZC-deep-b72\orig`；开工前 12 文件均为 `newComments=0`（30% 口径 needLines=700）。

## 校验

```
node zc-verify.mjs ZC-deep-b72
SUMMARY files=12 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=739

node check-batch.mjs ZC-deep-b72 ZC-deep-b72-files.txt
TOTAL added=739 hardBad=0 suspicious=0
```

逐文件密度（`密度 / 总行 / 代码行 / 注释行 / 本次新增 / 路径`）：

```
31.19   296   218    68   61  packages/ui/src/ToolCallBlocks/ToolCallBody.tsx
31.22   284   205    64   60  packages/client/src/webRemoteControlRelayProtocol.ts
31.25   398   288    90   62  packages/ui/src/settings/model-provider-section/codingPlanEmbeddedWebview.ts
31.27   368   259    81   62  packages/ui/src/useTaskListItemContextActions.ts
31.36   319   236    74   62  packages/ui/src/settings/saved-workflows/SavedWorkflowGlobalGroup.tsx
31.42   525   366   115   63  apps/zcode-cli/packages/core/src/tool/edit-matchers.ts
31.44   515   388   122   63  apps/zcode-cli/packages/bootstrap/src/zcode-protocol-entrypoint.ts
31.45   471   337   106   62  packages/server/src/remote/connect.ts
31.49   316   235    74   61  apps/dev-docs/src/capability-map/CapabilityMapDetail.tsx
31.54   335   241    76   61  packages/desktop/src/main/applicationIcons.ts
31.61   283   193    61   61  packages/shared/src/tool-call-summary.ts
31.61   273   193    61   61  packages/ui/src/onboarding/useOnboardingMigration.ts
SUMMARY files=12 coreBelow30=0 needLines=0 min=31.19 median=31.43 newComments=739
PASS: all 12 file(s) >= 30% (mode=code)
```

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `ui/settings/model-provider-section/codingPlanEmbeddedWebview.ts` | Coding Plan 嵌入式 webview | INV-01~18；origin 白名单是唯一信任边界；鉴权脚本只在同源注入；首屏 URL 与语言参数同源；上报上下文不含 token | 62 |
| `ui/settings/saved-workflows/SavedWorkflowGlobalGroup.tsx` | 全局工作流分组 | INV-01~18；列表/空态/错误态互斥；非法条目只提示不隐藏；运行与移动弹层不写列表 | 62 |
| `ui/ToolCallBlocks/ToolCallBody.tsx` | 工具调用主体投影 | INV-01~18；五类子块顺序固定；只有存在内容才挂载；plan 与 output 不重复渲染；kind 决定主体而非猜测 | 61 |
| `ui/useTaskListItemContextActions.ts` | 任务列表右键动作 | INV-01~18；路径解析失败给出空值而非抛错；复制与打开互不依赖；动作集合不缓存过期 task | 62 |
| `apps/dev-docs/src/capability-map/CapabilityMapDetail.tsx` | 能力地图详情 | INV-01~18；三态由选择集合唯一判定；只读投影不写选择；缺失字段回落占位 | 61 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-entrypoint.ts` | 进程级入口装配 | INV-01~18；装配顺序即依赖顺序；退出按逆序回收；任一阶段失败整体退出；遥测初始化不阻断主链 | 63 |
| `apps/zcode-cli/packages/core/src/tool/edit-matchers.ts` | 编辑定位匹配 | INV-01~18；命中必须唯一才允许改写；宽松策略按固定优先级尝试；命中策略回传上层；多解一律判失败 | 63 |
| `packages/client/src/webRemoteControlRelayProtocol.ts` | 远程控制中继协议 | INV-01~18；seq 单调且缺口必须检出；重连缓冲有上限；bridgeSessionId 是会话唯一键；乱序帧不得先交付 | 60 |
| `packages/desktop/src/main/applicationIcons.ts` | 应用图标解析 | INV-01~18；只读本地资源；路径必须局限在图标根内；失败返回空而非抛错；不缓存跨平台结果 | 61 |
| `packages/server/src/remote/connect.ts` | 远端连接编排 | INV-01~18；detect/deploy/exec/handshake 顺序不可交换；每阶段失败即终止；RPC 包装只做协议转换；连接对象持有生命周期 | 62 |
| `packages/shared/src/tool-call-summary.ts` | 工具调用摘要纯函数 | INV-01~18；纯函数无 IO；状态与原始 input/output 分列；缺失字段回落默认；摘要不含调用内容全文 | 61 |
| `packages/ui/src/onboarding/useOnboardingMigration.ts` | 向导迁移 hook | INV-01~18；有序执行不可并行；进度状态唯一；失败保留已完成步骤；重置清空全部中间态 | 61 |

合计 **739**，与 `zc-verify` 的 `added` 一致。

## 关键不变量（抽取）

### 1. origin 白名单是唯一信任边界

`codingPlanEmbeddedWebview.ts` 在拼装首屏 URL 与注入脚本前校验 origin。
放宽为前缀匹配会让 `evil.example.com` 通过，鉴权脚本被注入到第三方页面。

### 2. 命中必须唯一才允许改写

`edit-matchers.ts` 在多处命中时直接判失败并回报候选位置。
取第一处会造成静默改错文件，用户只看到「编辑成功」。

### 3. seq 单调且缺口必须检出

`webRemoteControlRelayProtocol.ts` 用 gap 判定触发补拉。
跳过缺口会让后续帧基于错误状态继续执行，远端状态永久偏移。

### 4. 装配顺序即依赖顺序

`zcode-protocol-entrypoint.ts` 先存储后 Registry、再遥测与 server。
调换会让 Registry 在存储未就绪时初始化，首请求即失败。

### 5. 迁移不可并行

`useOnboardingMigration.ts` 串行执行各步骤并在失败处停止。
并行会让 agents 文件写入与设置写入互相覆盖。

## 与本批相关的故障模式

| 写错的位置 | 线上表现 |
| --- | --- |
| origin 用前缀匹配 | 第三方页面拿到鉴权脚本 |
| 多处命中取第一处 | 静默改错文件 |
| 跳过 seq 缺口 | 远端状态永久偏移 |
| 装配顺序调换 | 首请求即失败 |
| 退出不逆序回收 | 句柄泄漏、进程挂起 |
| 图标路径不设根 | 任意本地文件被读取 |
| 摘要包含全文 | 日志体积暴涨 |
| 迁移并行 | 设置与 agents 互相覆盖 |
| 错误态隐藏非法条目 | 用户无从修复 |
| 右键动作缓存过期 task | 操作作用到已删除任务 |

## 顺延

B72 复算清单共 20 个候选，本批取 12 个，其余顺延到 B73，开工前用更新后的工作树重新测量后确定。

> 说明：每文件独立 spec（≤150 行），4 文件一组并行（并发上限 5），逐文件密度校验。
> 目标行数按 `round(code × 0.314) − 当前注释行` 计算，实测 31.19%~31.61%，`suspicious=0`；
> 本批三波均一次插入通过，无补插。
