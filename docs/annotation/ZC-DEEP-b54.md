# ZC-DEEP-b54

> 批次：B54（12 文件，复算缺口 944 行；按当前工作树复算，优先同类/同目录：`stream-animate` 2 个、`bootstrap` 3 个、`adapters/mcp` 1 个、`zcode-server-cli` 1 个、`core/tool/handlers` 1 个、`shared` 1 个、`ui/src` 3 个）。
> 执行分三波：4 + 4 + 4（并发上限 5），每文件独立 spec。
> 基线快照：`d:\code\_annot_baseline\ZC-deep-b54\orig`；开工前 12 文件均为 `newComments=0`。

## 校验

```
node zc-verify.mjs ZC-deep-b54
SUMMARY files=12 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=1039

node check-batch.mjs ZC-deep-b54 ZC-deep-b54-files.txt
TOTAL added=1039 hardBad=0 suspicious=0
```

逐文件密度（`密度 / 总行 / 代码行 / 注释行 / 本次新增 / 路径`）：

```
31.27   493   355   111   79  apps/zcode-cli/packages/core/src/tool/handlers/apply-patch.ts
31.27   407   291    91   91  packages/stream-animate/src/server/deepseekRunner.ts
31.29   440   310    97   79  packages/shared/src/workspace-hook-config.ts
31.31   543   396   124   81  packages/ui/src/ToolCallBlocks/renderers/create-workflow.tsx
31.37   532   373   117   80  packages/ui/src/ErrorBoundary.tsx
31.41  2918  2133   670  113  apps/zcode-cli/packages/adapters/src/mcp/index.ts
31.42  1802  1305   410  104  apps/zcode-cli/packages/bootstrap/src/plugins.ts
31.44  1102   808   254   87  apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/cold-event-merge.ts
31.44   493   369   116   82  apps/zcode-cli/packages/bootstrap/src/app/input-facade.ts
31.44   357   264    83   78  packages/ui/src/v4/ConversationTurnNavigator.tsx
31.51   416   311    98   87  packages/zcode-server-cli/src/server-core/http.ts
31.58   352   247    78   78  packages/stream-animate/src/server/http.ts
SUMMARY files=12 coreBelow30=0 needLines=0 min=31.27 median=31.41 newComments=1039
PASS: all 12 file(s) >= 30% (mode=code)
```

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `stream-animate/server/deepseekRunner.ts` | 流式模型运行器与归档 | INV-01~19；raw 事件单向顺序且 finally 唯一关闭；SSE 跨 chunk 残留缓冲；首字节/首 token 锁定时机；200ms 进度节流；双写归档顺序与失败补写；API key 缺失前置抛错 | 91 |
| `stream-animate/server/http.ts` | 流式动画本地 HTTP 服务 | INV-01~18；127.0.0.1 绑定；`/api/` 优先分派；activeRuns 内存/磁盘双写配对；先写 summary 后启动执行器；未处理拒绝的 fire-and-forget；raw limit 钳制；静态目录穿越校验；Content-Type 白名单 | 78 |
| `bootstrap/plugins.ts` | 插件发现/安装/卸载编排 | INV-01~19；overview 单轮读投影与计数口径；市场声明冲突 fail closed；刷新目标选择与单市场失败隔离；安装三路径（dryRun / 内置恢复 / 常规）；suppression 生命周期；卸载所有权以 `installed_plugins.json` 为准 | 104 |
| `bootstrap/app/input-facade.ts` | CLI 输入门面 | INV-01~18；boundary 先于 admission；delivery 只是意向；订阅先于 boundary 建立；reservationId 幂等；promoting 中间态；清空双侧一致；autoDrain 与外部 drain 标记；history 旁路与附件外化 | 82 |
| `bootstrap/zcode-protocol-v4/cold-event-merge.ts` | 冷事件合并 | INV-01~19；去重键只用持久实体 ID/key；顺序保持与 resequence 全序；幂等且不改入参；合并窗口内 queue 生命周期；settled 抑制；live-only 丢弃与内存回收 | 87 |
| `adapters/mcp/index.ts` | MCP 服务器适配 | INV-01~19；连接全量收敛与 generation fencing；共享 connecting 去重；订阅登记回滚；进程树回收；工具缓存与失效；OAuth 事务寿命与 caller 预算解耦；日志脱敏；span requestId 有界缓存 | 113 |
| `zcode-server-cli/server-core/http.ts` | 服务端核心 HTTP/WS | INV-01~19；CoreHttpServer 关停顺序与 250ms 排空预算；loopback fail-closed；wrapWebSocket 丢帧；反向资源通道身份映射；通配鉴权与常量时间比较；capability 一次性消费 | 87 |
| `core/tool/handlers/apply-patch.ts` | ApplyPatch 工具 | INV-01~20；两阶段验证（先 verify 再写）；expectedRevision 条件写；delete/move 的非原子边界；编码与换行透传；错误码收敛与 recoverable；取消信号只透传 | 79 |
| `shared/workspace-hook-config.ts` | 工作区钩子配置解析 | INV-01~19；超时与输出上限归一优先级；roots 折叠与默认关闭；三重 gate 缺省语义；候选路径顺序与去重；单文件失败隔离；strict 校验与事件名单一来源 | 79 |
| `ui/ErrorBoundary.tsx` | 渲染错误边界 | INV-01~19；只覆盖渲染期异常；fallback 自身不得再抛；重试只清 state 不重挂载；上报不阻塞渲染；resetKeys 一次性收敛；locale 与日志序列化归一 | 80 |
| `ui/v4/ConversationTurnNavigator.tsx` | 会话轮次导航条 | INV-01~19；活动轮次与双键映射；三级回退链；rail ref 与虚拟化配置；滚动定位副作用；空会话早返回；键盘/观察器清理；点击跳转槽位身份 | 78 |
| `ui/ToolCallBlocks/renderers/create-workflow.tsx` | 创建工作流工具结果渲染 | INV-01~18；工具输出形状校验与 display 缺失降级；`ok=false` 与 failed 摘要的合取判据；空图/无 v4Status 降级；折叠记忆 Map 生命周期；宿主 forceOpen/canToggle 优先级；脚本折叠与 Resume 页脚可见性 | 81 |

合计 **1039**，与 `zc-verify` 的 `added` 一致。

## 关键不变量（抽取）

### 1. SSE 残留缓冲必须跨 chunk 保留

`deepseekRunner.ts` 在每次读流后把未闭合的半行留在缓冲区，下一次拼接后再按行切分。
一旦在 chunk 边界丢弃残段，含中文的多字节事件会被截断，模型输出出现乱码或直接丢事件。

### 2. 冷事件合并只认持久实体 ID

`cold-event-merge.ts` 的去重键只取持久实体 ID/key，不用数组下标或时间戳。
用下标做键时，插入一条历史事件会让其后所有事件错位重排，会话回放顺序与真实发生顺序不一致。

### 3. MCP 工具缓存必须按连接代际失效

`adapters/mcp/index.ts` 的 generation 在重连时递增，旧代际回包一律丢弃。
不比较代际会让断线前的工具列表覆盖重连后的新列表，用户看到已下线的工具却调用失败。

### 4. ApplyPatch 必须两阶段

`apply-patch.ts` 先在内存验证全部 hunk 再落盘写入。
边验证边写时，第二个 hunk 失败会留下前半个补丁，文件处于既非旧版也非新版的破损状态。

### 5. 输入门面的 boundary 先于 admission

`input-facade.ts` 先确立本轮 boundary 再把输入投进队列。
顺序颠倒时，队列中排在前面的旧输入会被算进新一轮，消息归属到错误的 turn。

## 与本批相关的故障模式

| 写错的位置 | 线上表现 |
| --- | --- |
| SSE 残段跨 chunk 丢弃 | 中文事件被截断，输出乱码或丢事件 |
| 插件市场声明冲突 fail open | 来源不明插件覆盖官方同名项 |
| 输入门面 admission 先于 boundary | 旧输入被并入新 turn |
| 冷事件按下标做去重键 | 回放顺序错位 |
| MCP 工具缓存不按代际失效 | 调用已下线工具持续失败 |
| 服务端 WS 不校验 loopback | 任意来源可建立本地控制通道 |
| ApplyPatch 边验证边写 | 补丁失败后文件停在中途状态 |
| 钩子配置 strict 校验放行 | 错误配置静默生效，钩子不执行 |
| ErrorBoundary fallback 再抛 | 白屏替代错误提示，用户无从恢复 |
| 轮次导航不清理观察器 | 长会话滚动监听累积，切换会话卡顿 |
| 工作流渲染不校验输出形状 | 字段缺失时整块渲染崩掉 |

## 顺延

B54 复算清单共 20 个候选，本批取 12 个，其余顺延到 B55，开工前用更新后的工作树重新测量后确定。

> 说明：每文件独立 spec（≤150 行），4 文件一组并行（并发上限 5），逐文件密度校验。
> 本批 `suspicious=0`；全部文件按 `round(code × 0.314) − 当前注释行` 精确补行，密度落在 31.27%~31.58%。
