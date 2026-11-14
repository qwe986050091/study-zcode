# ZC-DEEP-b65

> 批次：B65（12 文件，按 31.4% 口径计算目标 792 行；按当前工作树复算，优先同类：`packages/ui` 6 个（v4、components/ai-elements、feedback、resource-manager、settings/usage-stats、ToolCallBlocks/renderers）、`packages/desktop` 1 个、`packages/zcode-server-cli` 1 个、`apps/zcode-cli` 3 个、`packages/server` 1 个）。
> 执行分三波：4 + 4 + 4（并发上限 5），每文件独立 spec。
> 基线快照：`d:\code\_annot_baseline\ZC-deep-b65\orig`；开工前 12 文件均为 `newComments=0`（30% 口径 needLines=753）。

## 校验

```
node zc-verify.mjs ZC-deep-b65
SUMMARY files=12 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=792

node check-batch.mjs ZC-deep-b65 ZC-deep-b65-files.txt
TOTAL added=792 hardBad=0 suspicious=0
```

逐文件密度（`密度 / 总行 / 代码行 / 注释行 / 本次新增 / 路径`）：

```
31.19   298   218    68   65  packages/ui/src/settings/usage-stats/AppUsagePanel.tsx
31.25   319   224    70   65  packages/desktop/src/main/forceUpdateGuard.ts
31.31   544   396   124   67  apps/zcode-cli/packages/core/src/runtime/methods/context-usage.ts
31.35   345   252    79   67  packages/ui/src/v4/windowControllerTaskListRegistry.ts
31.36   491   354   111   66  apps/zcode-cli/packages/adapters/src/exec/node-execution-adapter-lifecycle.ts
31.36   302   220    69   65  apps/zcode-cli/packages/cli/src/arguments.ts
31.43   334   245    77   66  packages/ui/src/resource-manager/ResourceManagerApp.tsx
31.44   484   353   111   68  packages/zcode-server-cli/src/packaging/stage.ts
31.47   351   232    73   66  packages/ui/src/ToolCallBlocks/renderers/agentHelpers.ts
31.49   325   235    74   65  packages/server/src/remote/remoteAssetLiveIdentity.ts
31.58   305   209    66   66  packages/ui/src/components/ai-elements/package-info.tsx
31.58   284   209    66   66  packages/ui/src/feedback/FeedbackScreenshotPicker.tsx
SUMMARY files=12 coreBelow30=0 needLines=0 min=31.19 median=31.40 newComments=792
PASS: all 12 file(s) >= 30% (mode=code)
```

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `ui/v4/windowControllerTaskListRegistry.ts` | 帧流收敛为共享观察器 | INV-01~18；每个 controller 引用只允许一份注册表；启停由 started 与 generation 双检；观察者按订阅者引用计数收口；停止顺序先断帧通道、再清内存态、最后退订；订阅回执 generation 失败须主动退订；订阅失败只降级告警 | 67 |
| `desktop/main/forceUpdateGuard.ts` | 启动前强制更新闸门 | INV-01~18；强更判定必须在建主窗口之前；远端不可用必须放行而非拉闸；只有 code 为 0 的 envelope 可信；版本比较委托 shared 的 resolveForceUpdateRequirement；最低版本缺失按未命中；读配置失败记 warn 后跳过 | 65 |
| `ui/components/ai-elements/package-info.tsx` | package-info 卡片族展示层 | INV-01~18；首行 use client 必须保留；ChangeType 联合是样式与图标唯一键空间；上下文值经 useMemo 缓存且四依赖齐全；默认值只允许 name 为空串；无 changeType 直接返回 null；版本区先检查两个版本再渲染 children | 66 |
| `ui/feedback/FeedbackScreenshotPicker.tsx` | 反馈截图选择器 | INV-01~18；只做收集、预览与转发不持有文件事实；拖放入口只接受图片；空投放早退；高亮只在真正移出容器时熄灭；进入与悬停都维持高亮；文件输入必须先清空值再接续 | 66 |
| `ui/resource-manager/ResourceManagerApp.tsx` | 资源管理器窗口外壳 | INV-01~18；外壳只做骨架、编排与 tab 分发；快照只有一个写入点；请求串行且上一轮未归不叠加；卸载后不得写状态；轮询只在 cpu 与内存两个 tab 运行；采样开关成对且跟随 effect 生命周期 | 66 |
| `ui/settings/usage-stats/AppUsagePanel.tsx` | 本地 App Usage 面板 | INV-01~18；两张图表保持 lazy 拆包；动态 import 结果再取具名导出作 default；lifetime 与当前窗口各用一个 hook 实例；时间窗口默认 7d 且只作组件内状态；仅首次加载且无快照时展示占位；加载分支不渲染图表 | 65 |
| `ui/ToolCallBlocks/renderers/agentHelpers.ts` | agent 工具调用节点解析 | INV-01~18；语言包缺配回落稳定术语；记录判定统一收口 isPlainRecord；字段读取跳过非字符串与纯空白；文本提取分支顺序不可调换；空数组与全空子项返回 undefined；嵌套读取先确认当前层是记录 | 66 |
| `zcode-server-cli/packaging/stage.ts` | 发行目录组装 | INV-01~18；声明文本必须非空；发行目录整体重建而非增量覆盖；旧组件归档随重建一起清掉；许可文件先落盘再算哈希；入口 bundle 与 sourcemap 同名双写；依赖闭包以产物扫描为事实源 | 68 |
| `adapters/exec/node-execution-adapter-lifecycle.ts` | 后台任务门面 | INV-01~18；关停后拒绝新任务；准备阶段失败不建任务；后台任务剥离 captureCwdAfterSuccess；Bash 合并输出不预建双文件；父级取消只转发且只挂一次；run 同步抛错也要落终态 | 66 |
| `cli/src/arguments.ts` | CLI 全局旗标与协议识别 | INV-01~18；全局旗标只有一个真相来源且 strict 开启；parseGlobalArgs 保持纯函数语义不缓存；parseArgs 错误不捕获不降级；协议判定顺序不可调换；catch 仅按裸文本兜底；协议判定每次重新解析 | 65 |
| `core/runtime/methods/context-usage.ts` | 上下文 token 估算 | INV-01~18；全部 token 是本地估算而非权威计数；七类互斥且与白名单同源；Messages 排除 system 与 meta_user；task_notification 形态按消息计回；skills 与 tools 各归一类；section 指标复用构建期 chars 与 tokens | 67 |
| `server/remote/remoteAssetLiveIdentity.ts` | 远端组件身份契约 | INV-01~18；元数据目录只有一个来源；本次部署 manifest 只取一次；组件身份只认内容哈希；判定结果穷尽二态；远端元数据缺失必须重装；组件 id 不符视为他人目录 | 65 |

合计 **792**，与 `zc-verify` 的 `added` 一致。

## 关键不变量（抽取）

### 1. 启停必须由 started 与 generation 双检

`windowControllerTaskListRegistry.ts` 只认同时满足启动标记与代际匹配的回执。
只判 started 会让停止后迟到的订阅回执复活观察器，旧帧继续写入已清空的任务行镜像。

### 2. 远端不可用时必须放行启动

`forceUpdateGuard.ts` 在配置读取失败时记 warn 并跳过拦截。
拉闸会让一次网络抖动变成全体用户无法启动客户端。

### 3. 请求必须串行且上一轮未归不叠加

`ResourceManagerApp.tsx` 用在途标记阻止并发轮询。
叠加请求会让采样结果乱序写回，CPU 曲线出现回跳。

### 4. 解析错误不得降级为默认值

`cli/arguments.ts` 不在 parseGlobalArgs 内捕获 parseArgs 错误。
兜底会让非法参数静默生效，进程带着错误配置继续启动。

### 5. 远端元数据缺失必须重装

`remoteAssetLiveIdentity.ts` 把缺失视为需要重装，而不是沿用旧组件。
沿用会让远端资源与本地清单长期不一致，表现为插件加载失败但无提示。

## 与本批相关的故障模式

| 写错的位置 | 线上表现 |
| --- | --- |
| 停止后不校验 generation | 迟到回执复活观察器，旧帧写入已清镜像 |
| 强更闸门在远端失败时拉闸 | 一次网络抖动导致全体无法启动 |
| 轮询请求叠加 | 采样结果乱序，CPU 曲线回跳 |
| 参数解析错误降级为默认 | 非法参数静默生效 |
| 远端元数据缺失仍复用 | 资源与清单不一致，插件加载失败无提示 |
| 截图选择器改为持有文件 | 父层与子层两份事实，删除后缩略图残留 |
| 图表改为顶层静态 import | 首屏包体膨胀，设置页打开变慢 |
| 依赖闭包用声明文本 | 实际产物缺失依赖，运行时报模块找不到 |
| 上下文估算把 meta 计入 Messages | 上下文占比虚高，压缩被误触发 |
| 版本缺失按命中处理 | 缺字段的配置被判定为需要强更 |

## 顺延

B65 复算清单共 20 个候选，本批取 12 个，其余顺延到 B66，开工前用更新后的工作树重新测量后确定。

> 说明：每文件独立 spec（≤150 行），4 文件一组并行（并发上限 5），逐文件密度校验。
> 目标行数按 `round(code × 0.314) − 当前注释行` 计算，实测 31.19%~31.58%，`suspicious=0`。
