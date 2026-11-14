# ZC-DEEP-b73

> 批次：B73（12 文件，按 31.4% 口径计算目标 729 行，实际 +729，无补插）。
> 执行分三波：4 + 4 + 4（并发上限 5），每文件独立 spec。
> 基线快照：`d:\code\_annot_baseline\ZC-deep-b73\orig`；开工前 12 文件均为 `newComments=0`（30% 口径 needLines=690）。

## 校验

```
node zc-verify.mjs ZC-deep-b73
SUMMARY files=12 deletedNonZero=0 nonCommentAdded=0 syntaxErrorFiles=0 added=729

node check-batch.mjs ZC-deep-b73 ZC-deep-b73-files.txt
TOTAL added=729 hardBad=0 suspicious=0
```

逐文件密度（`密度 / 总行 / 代码行 / 注释行 / 本次新增 / 路径`）：

```
31.22   300   205    64   60  packages/web/src/auth/zaiWebOAuthProvider.ts
31.22   319   221    69   60  packages/desktop/src/main/manifestUpdateProvider.ts
31.30   316   230    72   61  packages/ui/src/project-sidebar/grouped/virtualized-group-task-list.tsx
31.36   316   220    69   61  packages/ui/src/settings/automationTemplateCatalog.ts
31.38   541   392   123   62  apps/zcode-cli/packages/tui/src/app-keyboard.ts
31.41   260   191    60   60  packages/stream-animate/src/client/FrameChart.tsx
31.47   270   197    62   60  packages/zcode-server-cli/src/runtime/lock.ts
31.48   387   270    85   61  apps/zcode-cli/packages/core/src/tool/handlers/bash-command-parser.ts
31.50   352   254    80   61  packages/desktop/src/main/pluginSandbox/protocol.ts
31.58   278   209    66   61  packages/ui/src/TaskActionMenuContent.tsx
31.61   254   193    61   61  packages/desktop/scripts/mcp-apps-host-fixture/retention-renderer.ts
31.61   267   193    61   61  packages/ui/src/settings/MemorySettingsSection.tsx
SUMMARY files=12 coreBelow30=0 needLines=0 min=31.22 median=31.44 newComments=729
PASS: all 12 file(s) >= 30% (mode=code)
```

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `desktop/scripts/mcp-apps-host-fixture/retention-renderer.ts` | 插件 UI 宿主保留语义模拟 | INV-01~18；harness 是唯一宿主通道；port 只从 `event.ports[0]` 取；pending 双向回调才删除；timers 存绝对截止时间；快照键 `task/key` 不可单侧修改 | 61 |
| `desktop/src/main/manifestUpdateProvider.ts` | 清单更新 Provider 桥接 | INV-01~18；每次调用重解析 endpoint；platform 先归一；只认 preview 通道；accept 与 X-Platform 同时下发 | 60 |
| `desktop/src/main/pluginSandbox/protocol.ts` | 沙箱协议解析与分发 | INV-01~18；scheme 与介质同批注册；host 前缀决定 kind；带凭据或端口的 URL 直接拒绝；路径必须 `/instance/` 开头 | 61 |
| `stream-animate/src/client/FrameChart.tsx` | 帧统计图表渲染 | INV-01~18；metrics 判空先返回占位；固定取 frames 的 "60"/"120"；默认值只写在解构；高度由 embedded 决定 | 60 |
| `ui/project-sidebar/grouped/virtualized-group-task-list.tsx` | 分组任务列表窗口化 | INV-01~18；阈值严格大于 80；非虚拟化整表早返回；count 跟随开关；滚动容器逐级反查 | 61 |
| `ui/settings/automationTemplateCatalog.ts` | 自动化模板目录投影 | INV-01~18；纯投影不缓存；模板只取自 scene options.prompts；无标题即拒绝；被丢弃 id 必须上报 | 61 |
| `ui/settings/MemorySettingsSection.tsx` | 工作区记忆设置分区 | INV-01~18；请求序号是唯一并发裁决；写三态前先比对序号；关闭时同样自增；失败清空选中 | 61 |
| `ui/TaskActionMenuContent.tsx` | 任务操作菜单内容 | INV-01~18；完全受控无副作用；两禁用开关先合成；总开关约束非目标动作；置顶开关不进公共常量 | 61 |
| `web/src/auth/zaiWebOAuthProvider.ts` | Web 端 OAuth 归一 | INV-01~18；两套配置成组提供；参数名按 provider 分支；state 必填；authCode 后写入映射 code | 60 |
| `zcode-server-cli/src/runtime/lock.ts` | data root 跨进程锁 | INV-01~18；路径由构造注入；handle 与 token 同点赋值；五态穷尽互斥；ENOENT 只映射 missing | 60 |
| `apps/zcode-cli/.../bash-command-parser.ts` | bash 命令结构化 | INV-01~18；唯一入口收原始串；解析失败折为空分析；超长先判再解析；空串早返回 | 61 |
| `apps/zcode-cli/packages/tui/src/app-keyboard.ts` | TUI 全局按键分发 | INV-01~18；分发优先级固定；只读视图独占键盘；审批先消费后处理；选区优先于侧栏与 Ctrl-C | 62 |

合计 **729**，与 `zc-verify` 的 `added` 一致。

## 关键不变量（抽取）

### 1. port 只能从 `event.ports[0]` 取

`retention-renderer.ts` 按消息类型与 port 数量双条件接收通道。
改从 `data` 里取会让接收端永远拿到 `undefined`，保留测试测到的生命周期全是假的。

### 2. 带凭据或端口的 URL 一律拒绝

`protocol.ts` 在归属比较前先拦掉 `username/password/port`。
放过这类 URL 会让 host 归属判断被绕过，出现跨实例读取他人插件页面。

### 3. 阈值是「严格大于 80」

`virtualized-group-task-list.tsx` 的 `shouldVirtualizeGroupedTasks` 用 `>` 而非 `>=`。
改成 `>=` 或调低阈值会让小组也走绝对定位路径，首帧只有估算高度，内容区短暂空白。

### 4. 请求序号是唯一并发裁决

`MemorySettingsSection.tsx` 在写入三态前一律比对 `catalogRequestIdRef`。
改用对象身份或时间戳比较，陈旧响应会覆盖新目录，开关已关闭仍渲染工作区列表。

### 5. handle 与 ownerToken 同点赋值

`lock.ts` 只在 `tryAcquireOnce` 成功后相邻两行同时赋值。
先赋值后写盘会在写失败时留下无法凭 token 回收的所有权，其他进程永远等不到锁释放。

## 与本批相关的故障模式

| 写错的位置 | 线上表现 |
| --- | --- |
| port 从 data 取 | 通道永远建立不起来，保留测试全绿但无意义 |
| 宿主通道自建 | 测到假的生命周期 |
| 带凭据 URL 未拦 | 跨实例读取插件页面 |
| 阈值写成 `>=` | 小组首帧空白 |
| 滚动容器写死父节点 | 展开/折叠后虚拟列表挂错容器 |
| 模板投影内缓存 | 出现第二份真源 |
| 陈旧响应未比对序号 | 旧目录覆盖新目录 |
| 失败不清选中项 | 详情面板读上一轮快照 |
| 置顶开关并入公共常量 | 重命名/归档被连带禁用 |
| state 缺失不抛错 | CSRF 防护失效 |
| ENOENT 之外也当 missing | 权限错误被误判为可启动 |
| 超长后置判断 | 解析成本被放大 |
| 解析失败直接抛 | 保守审批被绕过 |
| 分发优先级调换 | 低优先级处理器抢走高优先级按键 |

## 顺延

B73 复算清单共 20 个候选，本批取 12 个，其余顺延到 B74，开工前用更新后的工作树重新测量后确定。

> 说明：每文件独立 spec（≤150 行），4 文件一组并行（并发上限 5），逐文件密度校验。
> 目标行数按 `round(code × 0.314) − 当前注释行` 计算，实测 31.22%~31.61%，`suspicious=0`；
> 本批三波均一次插入通过，无补插。
