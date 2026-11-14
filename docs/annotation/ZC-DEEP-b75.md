# ZC-DEEP-b75

> 批次：B75（12 文件，按 31.4% 口径计算目标 712 行，实际 +712，无补插）。
> 执行分三波：4 + 4 + 4（并发上限 5），每文件独立 spec。
> 基线快照：`d:\code\_annot_baseline\ZC-deep-b75\orig`；开工前 12 文件均为 `newComments=0`（30% 口径 needLines=680）。

## 校验

```
node zc-verify.mjs ZC-deep-b75
SUMMARY files=12 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=712

node check-batch.mjs ZC-deep-b75 ZC-deep-b75-files.txt
TOTAL added=712 hardBad=0 suspicious=0
```

逐文件密度（`密度 / 总行 / 代码行 / 注释行 / 本次新增 / 路径`）：

```
31.19   267   202    63   58  packages/desktop/src/renderer/src/plugin-sandbox/genUi.ts
31.19   268   202    63   59  packages/ui/src/chat-input-toolbar/ComposerProviderMenu.tsx
31.19   297   218    68   59  packages/ui/src/v4/conversationTurnWorkSegments.ts
31.22   302   221    69   58  packages/server/src/remote/remoteDeployLock.ts
31.23   343   253    79   60  packages/ui/src/plugin-ui/adapters/usePluginUiToolCallModel.ts
31.27   441   323   101   61  packages/ui/src/app-shell/workflow-artifacts/presets/ArtifactChartView.tsx
31.31   274   198    62   59  packages/ui/src/ToolCallBlocks/renderers/task-stop.tsx
31.36   322   220    69   60  packages/ui/src/components/ai-elements/terminal.tsx
31.42   299   226    71   59  apps/zcode-cli/packages/core/src/tool/handlers/bash-readonly-policy-git-subcommands-history.ts
31.47   336   232    73   60  packages/ui/src/lib/taskModelRecovery.ts
31.58   251   190    60   59  packages/shared/src/localTtft.ts
31.58   316   228    72   60  packages/web/src/web-remote-control/app/webRemoteControlEntry.ts
SUMMARY files=12 coreBelow30=0 needLines=0 min=31.19 median=31.29 newComments=712
PASS: all 12 file(s) >= 30% (mode=code)
```

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `core/src/tool/handlers/bash-readonly-policy-git-subcommands-history.ts` | git 只读子命令白名单 | INV-01~18；key 为「git 子命令」整串且全表唯一；写仓库/写配置一律不入表；远端语义交回黑名单回调 | 59 |
| `shared/src/localTtft.ts` | 本地首字时延采样 | INV-01~18；六阶段固定枚举；桶边界严格递增；时钟校准偏移取往返中点、误差取一半，超限返回未定义 | 59 |
| `server/src/remote/remoteDeployLock.ts` | 远端部署互斥锁 | INV-01~18；互斥只依赖 mkdir 原子失败；stale 先 mv 到带 ownerToken 的临时路径再删；释放共用同一 exec 会话 | 58 |
| `desktop/src/renderer/src/plugin-sandbox/genUi.ts` | GenUI 插件沙箱宿主 | INV-01~18；测量只在 rAF 内读几何；高度差与视口差相等视为宿主缩放；saves 串行链一次失败不阻塞后续 | 58 |
| `web/src/web-remote-control/app/webRemoteControlEntry.ts` | Web 远程控制入口 | INV-01~18；回调识别顺序固定；refresh 单飞且复查 acceptedJwt；自动落点只消费一次；存储只存 sid/mid | 60 |
| `ui/src/v4/conversationTurnWorkSegments.ts` | 会话轮次工时/分段投影 | INV-01~18；工时按 activeMs → endedAt 差 → 本地时钟短路；段只切在 guided 输入且当前段非空；段 key 三级兜底 | 59 |
| `ui/src/app-shell/.../ArtifactChartView.tsx` | 图表产物预览 | INV-01~18；recharts 仅此文件导入且必须有 default 导出；序列上限与配色同源裁剪；memo 从廉价到昂贵逐项比较 | 61 |
| `ui/src/chat-input-toolbar/ComposerProviderMenu.tsx` | 输入框 provider 菜单 | INV-01~18；639px 断点只在 query 常量出现；子菜单偏移仅在展开信号为真时测量并补偿内边距/边框/4px | 59 |
| `ui/src/components/ai-elements/terminal.tsx` | 终端输出块 | INV-01~18；Hook 先于提前返回；计时器句柄存 ref 并在卸载 effect 清理；复制走守卫→成功回执→异常只报 onError | 60 |
| `ui/src/lib/taskModelRecovery.ts` | 任务模型值恢复 | INV-01~18；恢复顺序为占位符过滤→已编码判定→provider 前缀编码→裸值兜底；无变化返回 null | 60 |
| `ui/src/plugin-ui/adapters/usePluginUiToolCallModel.ts` | 插件 UI 工具卡模型 | INV-01~18；supportedScope 是沙箱/自动打开的唯一闸门；toolSurfaceKey 恒定、routedSurfaceKey 按需派生 | 60 |
| `ui/src/ToolCallBlocks/renderers/task-stop.tsx` | task_stop 卡片 | INV-01~18；display 投影优先于 raw 回退；taskId 取值链即优先级；local_agent 只信 displayCommand | 59 |

合计 **712**，与 `zc-verify` 的 `added` 一致。

## 关键不变量（抽取）

### 1. 锁的成功信号必须带 ownerToken

`remoteDeployLock.ts` 的加锁只把「stdout 中含本次 ownerToken 的 acquired marker」当作成功。
只看退出码不行：远端 shell 的 `mkdir` 失败与网络中断退出码可能相同，误判成功会让两个部署同时写同一目录。

### 2. 清理只能在 owner 仍是自己时执行

stale 回收先 `mv` 到带 ownerToken 的临时路径再 `rm -rf`，释放时再对比 owner。
省掉对比会把别人刚抢到的锁删掉，表现为「锁莫名消失、两个进程同时部署」。

### 3. 尺寸测量不得回写 DOM

`genUi.ts` 在 rAF 里只读几何，从不改写 html/body 高度；高度差与视口差相等时判定为宿主缩放并跳过上报。
一旦回写，观测器会观测到自己的写入，形成自激循环，宿主 CPU 持续飙高。

### 4. 无变化必须返回 null

`taskModelRecovery.ts` 的合并函数在无变化时返回 `null` 而不是空数组。
空数组会被当成「有结果」推给工具栏恢复 effect，与本次恢复互相触发，形成无限重渲染。

### 5. 段 key 的三级兜底顺序固定

`conversationTurnWorkSegments.ts` 依次用 entityId、rowId、下标生成段 key。
调换顺序会让同一轮在同一次渲染中拿到两个 key，React 重挂载后工时与折叠状态全部丢失。

## 与本批相关的故障模式

| 写错的位置 | 线上表现 |
| --- | --- |
| 写操作子命令混入只读白名单 | 只读沙箱里能改仓库 |
| 远端语义靠 safeFlags 表达 | `git remote` 被误判为安全 |
| 时钟校准不设误差上限 | 跨机采样出现负首字时延 |
| 锁成功只看退出码 | 两个部署同时写同一目录 |
| 清理不校验 owner | 别人刚拿到的锁被删 |
| 测量回写 DOM | 自激循环，CPU 持续高 |
| 无变化返回空数组 | 工具栏恢复 effect 无限触发 |
| 序列上限与配色不同源 | 图例与图形色不一致 |
| 段 key 兜底顺序调换 | 工时与折叠状态周期性丢失 |
| 恢复顺序颠倒 | 模型值被重复编码 |
| 自动落点重复消费记忆键 | 第二个工具卡抢走侧栏 |
| 只读 raw 回退忽略 display | task_stop 显示旧快照的完整 prompt |

## 顺延

B75 复算清单共 20 个候选，本批取 12 个（跨 core / shared / server / desktop / web / ui 六个区域），
其余 8 个顺延到 B76，开工前用更新后的工作树重新测量后确定。

> 说明：每文件独立 spec（≤150 行），4 文件一组并行（并发上限 5），逐文件密度校验。
> 目标行数按 `round(code × 0.314) − 当前注释行` 计算，实测 31.19%~31.58%，`suspicious=0`；
> 本批 wave1 的 `genUi.ts` spec 的 raw 首块漏了 `//` 前缀（子代理按另一套自检脚本口径写入），
> 用 `_fix-raw-b75.mjs` 统一补前缀后一次插入成功；后续波次在 prompt 中显式要求 raw 自带前缀，未再复现。
