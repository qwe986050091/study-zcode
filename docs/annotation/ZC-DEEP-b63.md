# ZC-DEEP-b63

> 批次：B63（12 文件，按 31.4% 口径计算目标 815 行；按当前工作树复算，优先同类：`apps/zcode-cli/packages` 4 个（`adapters` 两处、`tui`、`bootstrap/zcode-protocol`）、`apps/dev-docs` 1 个、`packages/ui` 3 个、`packages/desktop` 3 个、`model-option-map` 1 个）。
> 执行分三波：4 + 4 + 4（并发上限 5），每文件独立 spec。
> 基线快照：`d:\code\_annot_baseline\ZC-deep-b63\orig`；开工前 12 文件均为 `newComments=0`（30% 口径 needLines=773）。

## 校验

```
node zc-verify.mjs ZC-deep-b63
SUMMARY files=12 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=815

node check-batch.mjs ZC-deep-b63 ZC-deep-b63-files.txt
TOTAL added=815 hardBad=0 suspicious=0
```

逐文件密度（`密度 / 总行 / 代码行 / 注释行 / 本次新增 / 路径`）：

```
31.19   305   218    68   66  packages/desktop/src/main/desktopRemoteUsageArmsTelemetry.ts
31.19   307   218    68   67  packages/model-option-map/src/parser.ts
31.22   290   221    69   67  packages/desktop/scripts/mcp-apps-host-fixture/renderer.ts
31.23   347   253    79   67  packages/desktop/src/main/browserView/browserCommandInteractionHandlers.ts
31.34   359   268    84   67  packages/ui/src/store/skillStore.ts
31.35   507   370   116   69  apps/zcode-cli/packages/adapters/src/model/failure-provider-business-codes.ts
31.40   503   363   114   70  apps/zcode-cli/packages/tui/src/app-sidebar.tsx
31.40   327   242    76   67  packages/ui/src/lib/zcodeSessionRestore.ts
31.46   564   410   129   71  apps/zcode-cli/packages/adapters/src/browser/index.ts
31.51   313   219    69   67  packages/ui/src/components/ai-elements/web-preview.tsx
31.51   424   311    98   69  apps/dev-docs/src/capability-map/CapabilityMapView.tsx
31.56   378   282    89   68  apps/zcode-cli/packages/bootstrap/src/zcode-protocol/message-mapper.ts
SUMMARY files=12 coreBelow30=0 needLines=0 min=31.19 median=31.38 newComments=815
PASS: all 12 file(s) >= 30% (mode=code)
```

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `dev-docs/capability-map/CapabilityMapView.tsx` | 能力地图视图 | INV-01~18；布局未就绪时节点与边返回空数组；enabledRelations 由工厂函数懒建；空关系集合表示不画线而非回退全部；关系范围过滤仅跨群按两端 groupId 不等；压暗是选择态与搜索态或关系；选中态只有 selection 一个真源 | 69 |
| `adapters/src/browser/index.ts` | CLI 浏览器适配器入口 | INV-01~18；同一 runtime 只维护一个已连接 Browser；并发 ensureBrowser 共享同一次 launch；请求带当前后端身份；断连即让全部会话失效；close 之后完成的 launch 必须关闭；关闭中的会话不得复活 | 71 |
| `tui/src/app-sidebar.tsx` | TUI 侧栏只读视图 | INV-01~18；只做只读渲染不持有业务状态；数据全经 props 注入；copy 缺省回退 DEFAULT_TUI_COPY；developerMode 只增删调试分区；sectionExpansion 缺省按展开；折叠意图一律 onToggleSection 上抛 | 70 |
| `mcp-apps-host-fixture/renderer.ts` | MCP apps 夹具渲染进程 | INV-01~18；页面生命周期以 manager 为唯一权威；握手完成只由 running 相位确认；端口处理器任一时刻只有一个；文本入口只转发带单端口定制消息；监听器账本只统计当前注册者；承载层切换先建新绑定再解旧绑定 | 67 |
| `model-option-map/src/parser.ts` | 受限表达式解析器 | INV-01~18；必须整体解析到 eof 才成功；成员访问与函数调用期拒绝并给专属文案；优先级固定九级；二元左结合、条件右结合；每个 AST 节点携带源 offset；数字走 JSON 安全校验；越界回退降级 | 67 |
| `adapters/model/failure-provider-business-codes.ts` | 供应商业务码分类 | INV-01~18；每个码只投影一个稳定四元组；只有明确可恢复才 retryable=true；reason 来自语义判断而非 HTTP 状态；未知码返回 undefined 不回落默认；查表区分大小写，仅网络分支小写归一；网络码识别先于响应体兜底 | 69 |
| `bootstrap/zcode-protocol/message-mapper.ts` | 协议消息纯投影 | INV-01~18；不修改入参只重建新对象；id 字段统一 String 化；user 与 assistant 白名单各自维护；model 需 providerId 与 modelId 同时存在；reasoningLevel 无值不产生空 options；error 只投影 name 与 data | 68 |
| `browserView/browserCommandInteractionHandlers.ts` | 浏览器交互命令 CDP 派发 | INV-01~18；坐标只有 ref 与 (x,y) 两源，都缺失必须报错；ref 解析失败立即 refNotFound 不继续派发；坐标一律 CSS 视口像素；点击固定同坐标三步；双击仅 doubleClick 严格为 true；press 必须 keyDown 紧跟 keyUp 共用键定义 | 67 |
| `desktopRemoteUsageArmsTelemetry.ts` | 远控用法 ARMS 遥测 | INV-01~18；telemetryConfig 是唯一配置来源且只整体替换；未配置即静默返回；周期定时器同时至多一个句柄；三个事件名只能来自常量；属性白名单九键；失败结果 error_category 恒非空，缺失回落 unknown | 66 |
| `ui/components/ai-elements/web-preview.tsx` | Web 预览组件 | INV-01~18；url 唯一可写副本是内部 useState，默认值只 defaultUrl 一个入口；defaultUrl 只在首次挂载读取；地址写入必须经 handleUrlChange；onUrlChange 落地后同步调用一次；地址栏仅 Enter 提交；受控 value 优先于内部草稿 | 67 |
| `ui/lib/zcodeSessionRestore.ts` | 会话恢复流程 | INV-01~18；必须先 resume 再 readSession；resume 透传 model 与 thoughtLevel；只有 session 缺失与模型不可用两类错误可降级；未注入 task 服务时失败原样抛出；legacy 降级按 desktop-continuous 取快照；快照为空抛回原始错误 | 67 |
| `ui/store/skillStore.ts` | 技能投影 store | INV-01~18；同投影 key 同轮扫描只发一次请求；缓存复用要求 workspace、identity、provider、授权 ID 四项全等；命中判定必须含 workspaceIdentity；key 变化后丢弃迟到结果；写回列表前同步 loaded 快照；授权 ID 只在成功写回时更新 | 67 |

合计 **815**，与 `zc-verify` 的 `added` 一致。

## 关键不变量（抽取）

### 1. 并发 ensureBrowser 必须共享同一次 launch

`adapters/src/browser/index.ts` 用单个在途 promise 收敛并发启动。
各发一次会让同一 runtime 起两个浏览器进程，后完成的那个无人持有也无人关闭。

### 2. close 之后完成的 launch 必须被关闭

同一文件在关闭标记置位后检查启动结果，命中即关闭新实例。
漏掉这条会让用户关掉面板后后台常驻一个浏览器，内存与端口都不释放。

### 3. 未知业务码不得回落默认映射

`failure-provider-business-codes.ts` 对未知码返回 undefined，由上层决定展示。
回落成通用失败会把「配额耗尽」显示成「服务异常」，用户按错误指引反复重试。

### 4. 坐标来源缺失必须报错

`browserCommandInteractionHandlers.ts` 在既无 ref 又无 (x,y) 时直接失败，不默认落到原点。
默认原点会让误配置的点击静默打在页面左上角，表现为「点了没反应」或误触导航。

### 5. 投影 key 变化后必须丢弃迟到结果

`skillStore.ts` 在写回前重新比对四项身份，任一不等即丢弃。
只比路径会让远程同名工作区的技能列表互相覆盖，切换后看到别人的技能。

## 与本批相关的故障模式

| 写错的位置 | 线上表现 |
| --- | --- |
| ensureBrowser 不去重 | 同 runtime 起两个浏览器进程 |
| 关闭后不清理新 launch | 后台常驻浏览器，端口与内存不释放 |
| 业务码回落默认映射 | 配额耗尽被显示成服务异常 |
| 坐标缺失默认原点 | 点击打在页面左上角，看似无响应 |
| 会话恢复先读后 resume | 读到未激活会话，历史为空 |
| 承载层切换先解旧绑定 | 切换瞬间页面白屏或事件丢失 |
| 技能缓存只比路径 | 远程同名工作区技能列表串台 |
| 消息投影改写入参 | 上层复用同一对象时字段被污染 |
| defaultUrl 变更即生效 | 用户正在编辑的地址被外部覆盖 |
| 遥测未配置仍上报 | 无 endpoint 时刷错误日志 |

## 顺延

B63 复算清单共 20 个候选，本批取 12 个，其余顺延到 B64，开工前用更新后的工作树重新测量后确定。

> 说明：每文件独立 spec（≤150 行），4 文件一组并行（并发上限 5），逐文件密度校验。
> 目标行数按 `round(code × 0.314) − 当前注释行` 计算，实测 31.19%~31.56%，`suspicious=0`。
