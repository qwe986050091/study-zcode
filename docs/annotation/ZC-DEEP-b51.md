# ZC-DEEP-b51

> 批次：B51（12 文件，复算缺口 953 行；按当前工作树复算，优先同类/同目录：`ui/src` 8 个（`ToolCallBlocks` 3 个、`lib`、`settings`、`v4`、`gen-ui`、`login` 各 1 个）、`desktop` 4 个（`scripts/mcp-apps-host-fixture` 2 个、`main/mcpUserDirectory`、`main` 各 1 个））。
> 执行分三波：4 + 4 + 4（并发上限 5），每文件独立 spec。
> 基线快照：`d:\code\_annot_baseline\ZC-deep-b51\orig`；开工前 12 文件均为 `newComments=0`。

## 校验

```
node zc-verify.mjs ZC-deep-b51
SUMMARY files=12 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=1000

node check-batch.mjs ZC-deep-b51 ZC-deep-b51-files.txt
TOTAL added=1000 hardBad=0 suspicious=0
```

逐文件密度（`密度 / 总行 / 代码行 / 注释行 / 本次新增 / 路径`）：

```
31.31   422   297    93   83  packages/ui/src/lib/codingPlanQuotaResetCoordinator.ts
31.34   364   268    84   82  packages/ui/src/ToolCallBlocks/renderers/cua-group.tsx
31.37   367   271    85   82  packages/ui/src/login/LoginApiKeyForm.tsx
31.38   404   290    91   83  packages/ui/src/ToolCallBlocks/toolResultDisplay.ts
31.42   559   401   126   84  packages/desktop/src/main/desktopWindowLifecycle.ts
31.44   348   264    83   82  packages/desktop/scripts/mcp-apps-host-fixture/managed-environment.ts
31.46   354   267    84   83  packages/ui/src/v4/ConversationShareContent.tsx
31.48   481   359   113   85  packages/ui/src/settings/PluginStoreCard.tsx
31.49   495   362   114   84  packages/ui/src/ToolCallBlocks.tsx
31.50   359   273    86   83  packages/ui/src/gen-ui/components/GenUiCard.tsx
31.52   478   330   104   85  packages/desktop/src/main/mcpUserDirectory/index.ts
31.52   363   276    87   84  packages/desktop/scripts/mcp-apps-host-fixture/main.ts
SUMMARY files=12 coreBelow30=0 needLines=0 min=31.31 median=31.45 newComments=1000
PASS: all 12 file(s) >= 30% (mode=code)
```

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `ui/lib/codingPlanQuotaResetCoordinator.ts` | 配额重置协调器 | INV-01~20；单飞与多订阅者广播；重置请求按幂等 key 去重；失败后状态复位；订阅 id 分配与退订闭包配对；可见性驱动的轮询启停；冷却判定不读系统时钟偏差 | 83 |
| `ui/settings/PluginStoreCard.tsx` | 插件商店卡片 | INV-01~19；安装与卸载入口互斥；进行中状态只由 `activeOperations` 派生；`isItemBusy` 统一禁用；启停锁只作用于目标插件；不可更新条目不渲染更新入口；描述为空不渲染；单行截断与 locale 解析 | 85 |
| `ui/v4/ConversationShareContent.tsx` | 会话分享内容 | INV-01~20；分享视图只读；敏感信息脱敏后才进入渲染；消息顺序与原始一致；空会话占位；代码块与图片分派；超长内容按策略截断且不切断代码块 | 83 |
| `ui/gen-ui/components/GenUiCard.tsx` | 生成式 UI 卡片 | INV-01~19；标题与副标题可选；动作按钮最多一组且点击只触发一次；未知 schema 兜底；空内容占位；loading 覆盖内容；标题层级符合 a11y | 83 |
| `ui/login/LoginApiKeyForm.tsx` | API Key 登录表单 | INV-01~19；密钥输入不回显；粘贴值去首尾空白；提交中禁用；校验失败定位到字段；密钥不进日志与错误对象；成功后清空内存态；回车提交；autocomplete 关闭 | 82 |
| `ui/ToolCallBlocks.tsx` | 工具调用块分派 | INV-01~19；按工具身份分派渲染器、插件可覆盖；未知工具降级而非返回空；状态到视觉纯映射；结果与参数分离；错误优先级最高；同名工具多次调用用 toolId 做 key | 84 |
| `ui/ToolCallBlocks/renderers/cua-group.tsx` | CUA 步骤分组渲染 | INV-01~18；组内顺序即执行顺序；状态聚合规则固定；截图缺失占位；坐标与屏幕尺寸同源展示；失败步骤高亮唯一；折叠不改变执行语义 | 82 |
| `ui/ToolCallBlocks/toolResultDisplay.ts` | 工具结果展示纯函数 | INV-01~19；未知形状兜底不抛错；`undefined`/`null`/空串三态区分；阈值拒绝而非静默截断；`truncated` 只认字面 true；查表命中防原型链键；同输入同输出 | 83 |
| `desktop/scripts/mcp-apps-host-fixture/main.ts` | MCP Apps host 夹具入口 | INV-01~18；argv 契约；userData 与特权 scheme 注册时序；`window-all-closed` 与退出码；旧分区固定种子保证可复现；host 单次安装、日志脱敏；attach/detach 资源配对；flush→destroy→exit 顺序 | 84 |
| `desktop/scripts/mcp-apps-host-fixture/managed-environment.ts` | 夹具托管环境 | INV-01~20；环境变量白名单继承；路径拼接与逃逸防护；临时目录清理；跨平台分隔符；目录创建幂等；失败不留半成品 | 82 |
| `desktop/main/mcpUserDirectory/index.ts` | MCP 用户目录 | INV-01~19；home/appData/便携模式取值优先级；缺参抛错；realpath 与符号链接取舍；畸形结构降级空表；写回保留其余字段；迁移幂等；ENOENT 白名单、其他错误上抛 | 85 |
| `desktop/main/desktopWindowLifecycle.ts` | 桌面窗口生命周期 | INV-01~20；窗口与 Host 一对一映射（键为 webContents.id）；closed 释放顺序与二次触发幂等；reload 补挂端口；`domReadyGeneration` 代际守卫；macOS 全关不退出；退出确认取消必须拦截关闭；尺寸持久化失败降级 | 84 |

合计 **1,000**，与 `zc-verify` 的 `added` 一致。

## 关键不变量（抽取）

### 1. 进行中状态只能从一个集合派生

`PluginStoreCard.tsx` 的 `isItemBusy` 只读 `activeOperations`，不再维护第二份 `boolean`。
两份状态一旦分叉，按钮会在操作结束后长期停在禁用态，用户只能重启应用。

### 2. 结果展示函数必须同输入同输出

`toolResultDisplay.ts` 是纯函数，不读 `Date.now()`、不读 locale 全局态。
引入外部状态后，同一条历史消息在不同时刻渲染出不同文本，分享与截图对不上。

### 3. 窗口与 Host 的映射键是 webContents.id

`desktopWindowLifecycle.ts` 用 `webContents.id` 而不是窗口对象引用做键。
换成对象引用后 reload 会生成新的 Host，旧 Host 的监听器继续持有已销毁的 webContents，出现重复响应。

### 4. macOS 全关不退出必须早返回

`window-all-closed` 在 darwin 上直接返回，不调用 `app.quit()`。
少了这个分支，macOS 上关掉最后一个窗口就退出，Dock 图标消失，用户以为应用崩溃。

## 与本批相关的故障模式

| 写错的位置 | 线上表现 |
| --- | --- |
| 插件卡片维护第二份 busy 状态 | 操作完成后按钮永久禁用 |
| 结果展示读时钟或 locale 全局态 | 同一条消息两次渲染文本不一致 |
| 窗口映射用对象引用做键 | reload 后出现两个 Host，消息重复处理 |
| macOS 全关未早返回 | 关最后一个窗口即退出应用 |
| 分享内容未脱敏 | 密钥与本地路径出现在分享截图里 |
| API Key 进日志 | 密钥以明文落到日志文件 |
| CUA 组内用下标做 key | 步骤增删后失败高亮错位到别的步骤 |
| 未知工具返回空节点 | 工具调用整块消失，用户以为模型没执行 |
| 夹具退出不走 flush→destroy→exit | 数据目录残留半写文件，下次启动读数失败 |
| 用户目录写回不保留其余字段 | 用户手改的其他配置被整体覆盖 |
| 未知结果形状抛错 | 一条异常结果导致整轮对话渲染中断 |
| 配额协调器无单飞 | 连点触发多次重置请求 |

## 顺延

B51 复算清单共 20 个候选，本批按同类同目录取 12 个，其余 8 个顺延到 B52，开工前用更新后的工作树重新测量后确定：

- `apps/zcode-cli/packages/i18n/src/types.ts`（89）
- `packages/stream-animate/src/server/deepseekRunner.ts`（88）
- `apps/zcode-cli/packages/bootstrap/src/plugins.ts`（86）
- `packages/e2e-report/src/viewer/App.tsx`（86）
- `packages/desktop/src/main/localTtftExporter.ts`（85）
- `apps/zcode-cli/packages/node-repl-host/src/server.ts`（84）
- `apps/zcode-cli/packages/adapters/src/mcp/index.ts`（83）
- `packages/zcode-server-cli/src/server-core/http.ts`（83）

> 说明：每文件独立 spec（≤150 行），4 文件一组并行（并发上限 5），逐文件密度校验。
> 本批 `suspicious=0`；全部文件按 `round(code × 0.314) − 当前注释行` 精确补行，密度落在 31.31%~31.52%。
