# ZC-DEEP-b58

> 批次：B58（12 文件，复算缺口 855 行；按当前工作树复算，优先同类/同目录：`ui/src` 7 个（`git-graph`、`root`、`settings`、`app-shell`、`BotsDialog`、`components/cloud-content-dialog`、`i18n`）、`zcode-server-cli/src/platform` 1 个、`bootstrap/app` 1 个、`telemetry` 1 个、`desktop/scripts/gen-ui-fixture` 1 个、`shared/src` 1 个）。
> 执行分三波：4 + 4 + 4（并发上限 5），每文件独立 spec。
> 基线快照：`d:\code\_annot_baseline\ZC-deep-b58\orig`；开工前 12 文件均为 `newComments=0`。

## 校验

```
node zc-verify.mjs ZC-deep-b58
SUMMARY files=12 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=901

node check-batch.mjs ZC-deep-b58 ZC-deep-b58-files.txt
TOTAL added=901 hardBad=0 suspicious=0
```

逐文件密度（`密度 / 总行 / 代码行 / 注释行 / 本次新增 / 路径`）：

```
31.38   866   615   193   79  apps/zcode-cli/packages/bootstrap/src/app/bundled-plugins.ts
31.40   356   242    76   75  packages/ui/src/git-graph/layoutAlgorithm.ts
31.46   366   267    84   74  apps/zcode-cli/packages/telemetry/src/otlp-exporter.ts
31.47   394   286    90   76  packages/zcode-server-cli/src/platform/serviceManager.ts
31.48   378   270    85   76  packages/ui/src/root/useRemoteWorkspaceTabLifecycle.ts
31.49   439   308    97   75  packages/ui/src/i18n/IntlProvider.tsx
31.50   520   381   120   76  packages/ui/src/app-shell/WorkflowArtifactSidePane.tsx
31.51   313   238    75   74  packages/desktop/scripts/gen-ui-fixture/react.tsx
31.51   333   238    75   74  packages/ui/src/components/cloud-content-dialog/CloudDialogHero.tsx
31.54   326   241    76   74  packages/ui/src/BotsDialog/BotSummaryCard.tsx
31.54   330   241    76   75  packages/ui/src/settings/CommandForm.tsx
31.56   326   244    77   73  packages/shared/src/conversation-share-content.ts
SUMMARY files=12 coreBelow30=0 needLines=0 min=31.38 median=31.49 newComments=901
PASS: all 12 file(s) >= 30% (mode=code)
```

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `ui/git-graph/layoutAlgorithm.ts` | Git 图车道布局纯函数 | INV-01~18；同 hash 单顶点；缺失父节点落负一哨兵不抛错；顶点 id 等于输入下标；车道号一经写入不再迁移；颜色池与分支一一对应；`reservePoint` 只接受连续车道号；父边游标单调保证幂等；合并路径优先复用既有连接；窗口外父节点提前终止 | 75 |
| `ui/root/useRemoteWorkspaceTabLifecycle.ts` | 远程工作区 tab 生命周期 | INV-01~19；身份 key 取 `workspaceIdentity` 优先、`workspacePath` 兜底；关闭判定以 key 集合差为准而非 tab id；`rekeyedTab` 认领旧 key；记忆补偿仅对无 `remoteSessionId` 的 session；ref 写入只发生在 effect；释放用 `disposedSessionIds` 去重、失败降级 warn；订阅侧 sequence 去重 | 76 |
| `ui/settings/CommandForm.tsx` | 命令编辑表单 | INV-01~18；名称字符集与 1~50 长度；编辑态名称与作用域均不可改；裸名去前导斜杠；提交值去首尾空白；空可选字段保留 `undefined`；校验失败不触发 `onSave`；名称与提示词错误分槽；文案随语言实时生成；依赖事件默认行为拦截 | 75 |
| `zcode-server-cli/src/platform/serviceManager.ts` | 系统服务注册（launchd/systemd/Windows） | INV-01~18；描述符名称由 `serverRoot` 派生；入口固定 `--service-entry`+`--supervisor`；扩展名与 kind 一一对应；launchd 仅异常退出重启；systemd `on-failure`+`default.target`；命令行必过转义；子进程输出收齐才结算；超时强杀并销毁管道；探测补 `XDG_RUNTIME_DIR`；注销只容忍不存在 | 76 |
| `bootstrap/app/bundled-plugins.ts` | 内置插件 seed 缓存落盘 | INV-01~18；临时目录写满并逐文件校验哈希后才 rename；seed lock 后二次检查 marker；marker 指纹含 path/sha256/mode；单插件失败只 warn 并回退旧缓存；15s 等锁预算整批共享；backup 名唯一、catch 只回滚自己那份；CUA 无 fallback 且被抑制时不删缓存；可执行位显式 0755 | 79 |
| `telemetry/otlp-exporter.ts` | OTLP trace/metric 导出 | INV-01~20；仅 Telemetry 启用后动态加载；每工厂独立 Provider 不复用单例；gzip 与 timeout 同作用于两条链路；Span 队列满丢弃新数据；Metric 用 DELTA temporality 且不带实例/安装 ID；Context Manager 注册失败立刻关闭；`closed` 保证 flush/shutdown 幂等；View 基数上限 250；端点回落与定时器清理 | 74 |
| `desktop/scripts/gen-ui-fixture/react.tsx` | UI 夹具 React 运行时替身 | INV-01~18；根节点唯一且首帧 `flushSync`；控制指令复用同一 root；消息正文走真实解析链路；服务替身未知方法透传 harness；`onStateChanged` 才返回订阅句柄；远端文档读取被 `documentGate` 卡住；端口订阅成对增删；快照读取只读；未知组件/hook 降级为空实现 | 74 |
| `ui/app-shell/WorkflowArtifactSidePane.tsx` | 工作流产物侧栏 | INV-01~19；零产物复用冻结空数组；父会话租约由同一副作用成对登记释放；投影绑定当前租约；run 定位锁定 runId+快照；live 三态不可折叠；产物缺失分读取中/读不到/不存在三档；hook 数量恒定；版本初值只取打开时 `tab.version`；可选版本只信 journal；本机路径需三条件同时满足；复制定时器随清理 | 76 |
| `ui/BotsDialog/BotSummaryCard.tsx` | 机器人摘要卡片 | INV-01~20；纯受控视图，名称草稿与启停只读自 props；宽度测量仅在重命名时启用且清理观察者；测量字号内边距与输入框一致、保留空白、向上取整；状态文案优先级错误>已绑定>未绑定；绑定态只由 `providerUserId` 决定；失焦提交幂等、组合输入期间不提交；回车只进入重命名 | 74 |
| `ui/components/cloud-content-dialog/CloudDialogHero.tsx` | 云内容弹窗 Hero 展示位 | INV-01~20；每实例唯一 `instanceId`；只接受来源窗口等于自身 iframe 的消息；通道号与实例双校验；5s 未握手降级 error；ready/error 都清定时器；无 `resolvedUrl` 不挂 iframe；展示位只桥接 hover 不转 action；reduced-motion 关 hover；sandbox 仅 `allow-scripts`、no-referrer；key 用 `resolvedUrl` | 74 |
| `ui/i18n/IntlProvider.tsx` | 国际化 Provider | INV-01~18；缺失键回退键名本身；语言表缺失回退 `DEFAULT_LOCALE`；占位符全量替换；消息对象不得原地改；intl 按 locale 记忆化；context value 按五元组记忆化；locale 为 preference 与 systemLocale 纯派生；`setLocalePreference` 先自增序号；异步回调复活前校验序号；广播跳过自身 payload；持久化失败不阻断 UI | 75 |
| `shared/conversation-share-content.ts` | 会话分享内容规范与校验 | INV-01~19；顶层只声明 schema；输入 readonly 不改写入参；字段上限为封闭常量；校验对象 strict 拒未知键；缺失可选字段整体省略；键顺序由字面量声明固定；JSON 深度上限先行判定；拒绝 `__proto__`/`constructor`；拒绝 `file:`/`data:`/`javascript:`；字节预算按 UTF-8；媒体与资源清单双向一一对应；解码失败返回空数组；同输入产出逐字节相同 JSON | 73 |

合计 **901**，与 `zc-verify` 的 `added` 一致。

## 关键不变量（抽取）

### 1. 内置插件缓存必须「先完整、后可见」

`bundled-plugins.ts` 在临时目录写满并逐文件校验哈希后才 `rename` 到目标位置。
中途把半成品目录暴露出去，下一次启动会读到缺文件的插件，表现为插件市场里该插件加载失败且无法自愈。

### 2. 远端身份 key 优先于路径

`useRemoteWorkspaceTabLifecycle.ts` 判定关闭时用「身份 key 集合差」而不是 tab id 消失。
只按 id 判定会让改绑身份的 tab 被误判为关闭，用户的远程会话记忆被提前删除。

### 3. 图表车道号不可迁移

`layoutAlgorithm.ts` 中车道号由 `addToBranch` 一次写入，后续不再变更。
允许迁移会让同一条分支在相邻行换色换位，用户看到 Git 图在滚动时抖动。

### 4. 产物缺失必须三档区分

`WorkflowArtifactSidePane.tsx` 把「读取中 / 读不到详情 / 确实不存在」分成三态。
合并成一态会让加载中的空态直接显示「没有产物」，用户误以为工作流失败。

### 5. OTLP Span 队列满丢弃而非阻塞

`otlp-exporter.ts` 队列满时丢新数据，不阻塞调用方。
改成阻塞会让遥测后端抖动反向传导为业务线程卡顿。

## 与本批相关的故障模式

| 写错的位置 | 线上表现 |
| --- | --- |
| 插件缓存先可见后写满 | 启动后插件缺文件且无法自愈 |
| 关闭判定按 tab id | 改绑身份即丢远程会话记忆 |
| 车道号允许迁移 | Git 图滚动时抖动换色 |
| 产物缺失三态合并 | 加载中误报「无产物」 |
| 遥测队列满时阻塞 | 后端抖动拖慢业务线程 |
| 名称校验放过非法字符 | 命令名无法被 shell 调用 |
| systemd 单元未转义命令行 | 含空格路径启动即失败 |
| 夹具服务替身吞掉未知方法 | 夹具场景静默冻住，测试假通过 |
| Hero 不校验来源窗口 | 其他 iframe 可向展示位投递消息 |
| intl 回退成空串 | 缺键处界面出现空白而非键名 |
| 分享内容键顺序可变 | 同内容两次导出字节不同，去重失效 |
| Bot 卡片内部另存名称 | 父级回填被草稿覆盖 |

## 顺延

B58 复算清单共 20 个候选，本批取 12 个，其余顺延到 B59，开工前用更新后的工作树重新测量后确定。

> 说明：每文件独立 spec（≤150 行），4 文件一组并行（并发上限 5），逐文件密度校验。
> 本批 `suspicious=0`；全部文件按 `round(code × 0.314) − 当前注释行` 精确补行，密度落在 31.38%~31.56%。
