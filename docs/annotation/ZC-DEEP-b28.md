# ZC-DEEP-b28

> 批次：B28（计划 14 文件 / 缺口 1,982 行，本批取缺口前 8 个）。
> 覆盖四条链路：插件商店详情与协议投影、MCP UI 状态仓库、v4 权限 broker 与 wire 重组器、
> 以及语音选择器、MCP App 保活 fixture 与 Bot provider 卡片。
> 基线快照：`d:\code\_annot_baseline\ZC-deep-b28\orig`。
> 规范母本：[ZC-DEEP-CORE-PLAN.md](./ZC-DEEP-CORE-PLAN.md)（第 5 节固定动作）。

## 校验

```
node zc-verify.mjs ZC-deep-b28
SUMMARY files=8 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=1208

deep-density --baseline ZC-deep-b28/orig --ext .ts,.tsx --threshold 30 --mode code
31.45   696   512  161  153  packages/ui/src/settings/PluginStoreDetailView.tsx
31.55   832   599  189  155  packages/ui/src/store/mcpStore.ts
31.43   985   719  226  154  apps/zcode-cli/packages/bootstrap/src/zcode-protocol/interaction-broker.ts
31.56   729   526  166  152  packages/shared/src/zcode-protocol-v4/wire-assembler.ts
31.57   673   472  149  149  packages/ui/src/components/ai-elements/voice-selector.tsx
31.47   776   572  180  149  apps/zcode-cli/packages/bootstrap/src/zcode-protocol/plugins.ts
31.57   650   491  155  148  packages/desktop/scripts/mcp-apps-host-fixture/background-main.ts
31.57   630   472  149  148  packages/ui/src/BotsDialog/ProviderSettingsCard.tsx
SUMMARY files=8 coreBelow30=0 needLines=0 min=31.43 median=31.55 newComments=1208
PASS: all 8 file(s) >= 30% (mode=code)
```

列口径：`密度 / 总行 / 代码行 / 注释行 / 本次新增 / 路径`。
每个文件 `// INV-` 均为 20 条。

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `packages/ui/src/settings/PluginStoreDetailView.tsx` | 插件商店详情页：listing + 运行时 info + 按需 describe 的纯投影 | INV-01~20；分区顺序必须等于 SECTION_ORDER；已安装项优先 `item.info`；`componentsLoading` 只在无 info 时为真；loading 与 failed 互斥且 error 优先；信息区取值 listing → info → describeMetadata；外链只放行 `https://`；`pickHttpsUrl` 首个合格即返回；示例提示词图标判定 pdf→spreadsheets→documents 且正则保留词边界；Hero 只在有可信图或有提示词时渲染；`showHeroImage` 同时要求可信与未失败；图 404 只置 heroFailed；无图退化为纯胶囊且不叠 overlay；预览 Dialog open 与 showHeroImage 相与；提示词 key 用文本本身；试用走父级 onUsePrompt；UI 插件优先 onOpenUi；信息区空则整块省略；分区图标复用同一映射；高级折叠只由父级注入 | 153 |
| `packages/ui/src/store/mcpStore.ts` | MCP UI 状态仓库：配置、原生记录、状态快照与启用覆盖 | INV-01~20；配置写入必须先落盘再改 state；`source==="mcp"` 映射 zcodeagentmcp 且不落用户目录；scoped 变更前作废两条状态链路；connect 与 status 各自独立 epoch；status-only 轮询不清空授权与工具数；status 失败回填 no-op；失败回填只命中最新 epoch 且限定 zcodeagentmcp+enabled+connecting；status 快照 merge、connect 整体替换；`markMissingConnectingAsError` 只在 connect 模式；enabledStates 未知 id 回落 server.enabled；toggle 先持久化再 set；启停持久化失败只告警；目录加载按 workspaceKey 去重并复用在飞 promise；等待后必须用最新 identity 选目录服务；异步返回后再比 currentWorkspaceKey；加载失败返回 false 不给空配置；只过滤断连错误；finally 同时清 promise 与 key；切 workspace 清空 nativeServers 与 statusSnapshots；下发列表只取 zcodeagentmcp 并按 priority 合并 | 155 |
| `.../zcode-protocol/interaction-broker.ts` | 权限/交互 broker：PermissionBrokerPort → v3 反向 RPC 与 v4 pending interaction | INV-01~20；分流顺序 AskUserQuestion → ExitPlanMode → 普通权限；registered 在请求登记时 resolve；result 错误分支与 ready.reject 共用同一 promise；ready.promise 挂空 catch；只有 guarded 模式翻译 ProtocolRequestError；错误码映射固定三条；未知错误原样 rethrow；必须同时合成 v4 与 legacy 选项；会话免确认只出现在 v4；fullAccess 五个前提缺一不可；先 claimResponse 再授权；必须 await 授权提交；deny 无 reason 补标准文案；v4 应答先 Refine 特判再 optionId 匹配；Refine 三重校验；未知 optionId 一律 deny；sessionPermissionUpdates 在 broker 侧合成；MCP elicitation 无 sessionId 或 record 必须 decline；合成事件 sequenceNumber 为 0；合成 PermissionResolved 在 finally 且吞错 | 154 |
| `packages/shared/src/zcode-protocol-v4/wire-assembler.ts` | v4 物理分片重组：ownership 过滤后逐片接纳，全套校验通过才产出 logical frame | INV-01~20；accept 先 expire 再处理；ordinal 合法性早于任何 map 操作；settled 检查早于 envelope/base64 与预算；ordinal 小于 settled 静默返回；同 ordinal 只有 id 不同才是冲突；recovery 回收同 route 更低 ordinal 的旧 fault；只有 recovery 可无 fault 取代旧 assembly；替换旧 assembly 必须 release 后立刻 settle；deliveryKind 非法先 releaseAndSettle 再 fault；complete 校验 key 白名单与 frame 自属性；信封字节超限先于 schema 解析；complete 命中已有 assembly 释放旧并报 metadataMismatch；fragment 四元组必须与已有 assembly 一致；新 assembly 同时过并发上限与 staged 预算；重复 fragmentIndex 比对字节；decodedBytes 不超 logicalBytes；stagedDecodedBytes 与 assemblies 严格同步；release 先校验身份；settle 不让 tombstone 回退；完成路径 release → 校验 → settle | 152 |
| `packages/ui/src/components/ai-elements/voice-selector.tsx` | 语音音色选择器原语组（Radix Dialog + cmdk） | INV-01~20；Context 默认值必须是 null；value 的 undefined 表示未选择；open 与 value 两条独立状态；defaultProp 只在首挂读取；onValueChange 允许 undefined；Context value 的四项依赖；Provider 必须在 Dialog 外层；Dialog 上 `{...props}` 位于 open/onOpenChange 之后；Trigger 不再调 setOpen；Content 的 aria-describedby 固定 undefined；DialogTitle 始终存在；Gender 联合类型以 string 收尾；未知性别落 CircleSmallIcon；Accent 未知渲染 null；children ?? icon 中 children 优先；switch 分支内不调 hook；Bullet 必须 aria-hidden；Preview 中 loading 优先 playing；Preview 点击顺序 stopPropagation→onClick→onPlay；playing 时不禁用 | 149 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/plugins.ts` | 插件域协议处理器：参数校验、配置视图、摘要投影与 storage 锁 | INV-01~20；所有入参先 parseParams；configScope 为 user 不传 workingDirectory；每次 list 重解析目录不缓存；配置有而磁盘缺失的插件补进列表；缺失 id 必须含 @ 且后缀非空；敏感 option 不进 configuredOptions；可选字段用条件展开；路径比较前先归一化；Workspace 归属优先于 user；市场/安装/更新/校验共用同一 storageRoot 锁；锁粒度按 storageRoot；dryRun 原样透传；setPluginEnabled 写入不可回滚；取消只能阻断后续响应；install 失败以 diagnostics 返回；update 聚合每条诊断；update 过滤顺序 pluginId→marketplace→全部；describe 只有懒加载 manifest 写入进锁；ok 只看 error 级诊断；compatibility 是能力声明常量 | 149 |
| `packages/desktop/scripts/mcp-apps-host-fixture/background-main.ts` | MCP Apps host 背景保活 fixture（测试用 Electron main） | INV-01~20；guest 注册与「有卡片」解耦；真实 tool 结果也能在无卡片窗口开 guest；`guests.has` 在 release 前后一假一真；隐藏窗口 visible 必须 false；隐藏/最小化期间 rAF 继续推进；off-screen 过期不销毁 guest；未保存文档跨过期保留；同插件可并存两份实例；第二份创建不关第一份；运行中 session 不被回收；空闲 MCP 页面也不自动回收；session stop 不冻结插件内部帧；隐藏 guest 不拦截点击（inert）；目标执行不唤醒同窗空闲 guest；stale initId 必须被拒绝；其他 window 句柄必须被拒绝；下一轮对话唤醒同一 guest；隐藏页执行后仍同一 guest 并展示新图层；删除任务后 guest 归零；失败必须以非零码退出且写 stderr | 148 |
| `packages/ui/src/BotsDialog/ProviderSettingsCard.tsx` | 单个 Bot provider 的凭据与绑定状态卡片 | INV-01~20；webhook 直接返回 null 且早于状态派生；isConnected 对 weixin 只看 hasSecret；hasSecret 只来自 credentialRef；Feishu 运行态错误优先于 bindCode 与二维码；descriptionText 只对 Feishu 故障切换；control 四分支互斥且顺序固定；detail 五分支与 control 不是同一组条件；活动注册按 botId 匹配；showBindCode 同样按 botId 匹配；错误码用 `\b\d{7,}\b` 提取；errorCode 缺失不渲染 dt/dd；bindCommand 直接拼接不转义；倒计时用 scaleX；进度条 key 是 bindCode.code；三层颜色三元顺序固定；deliveryError 只在 enabled 且送达失败时出现；PrivateDeliveryRetry key 用 deliveryRetryId；二维码 dataUrl 是唯一本地状态；二维码副作用必须有 cancelled 守卫；注册按钮禁用只由 loading 决定 | 148 |

合计 **1,208**，与 `zc-verify` 的 `added` 一致。

## 关键不变量（抽取）

### 1. 投影优先级是单向的，回退值不能「更权威」

`PluginStoreDetailView.tsx` 与 `plugins.ts` 都守同一条：商店/磁盘权威值优先，本地缓存只做兜底。
- 详情页：已安装项先看 `item.info`，`componentsLoading` 只在**没有** info 时才可为真；
  信息区固定 `listing → item.info → describeMetadata`；`pickHttpsUrl` 首个合格即返回（返回最后一个会让低优先级值覆盖权威链接）。
- 协议层：可选字段用条件展开而不是显式 `undefined`——序列化后二者不可区分，客户端会把缺字段读成「显式清空」。

`PluginStoreDetailView.tsx` 另有一条安全边界：外链只放行 `https://`，`javascript:`/`data:` 会直接进入
`openExternal`，形成注入面。

### 2. 两条状态链路必须各自计 epoch

`mcpStore.ts` 的 `statusListEpochs` 按 connect 与 status **分别**计数：
合并成一个计数会让 OAuth 轮询与全量 list 互相作废，界面持续抖动。
配套的三条：status 快照 `merge`、connect 整体替换（写反会把「未返回」当成「已消失」）；
status 失败回填必须是 no-op（否则一次临时轮询失败批量标红）；
每次 scoped 变更前作废两条链路（否则旧 epoch 响应回填刚改的配置）。

### 3. wire 重组器的「检查顺序」就是正确性

`wire-assembler.ts` 的二十条 INV 里超过一半是顺序：`expire` 先于处理、ordinal 合法性早于任何 map 操作、
settled 检查早于 envelope 解 base64、信封字节超限早于 schema 解析。
它们的共同后果是：顺序错了不会抛错，只会让「迟到旧帧」复活或让预算失控。
两条状态机约束不可合并：`assemblies`（active 分片）与 `settledByRoute`（ordinal tombstone）——
合并后 `release` 无法先校验身份（INV-18），重复释放会把 `stagedDecodedBytes` 减成负数。

### 4. 权限应答「未知即拒绝」

`interaction-broker.ts` 的安全底线是 INV-16：未知 optionId 一律 deny，绝不放行。
围绕它的一组约束：未知错误必须原样 rethrow（兜底成 deny 会把基础设施故障伪装成用户拒绝）；
fullAccess 五个前提缺一不可且必须先 `claimResponse`；Refine 特判必须三重校验（工具名 + optionId + 非空 freeText），
否则伪造 optionId 即可把任意文本注入用户消息通道。
合成事件 `sequenceNumber` 必须为 0——沿用持久化高水位 +1 会被当重放丢弃，pending 永不清。

### 5. 纯展示层的「契约缺口」比逻辑缺口更常见

`voice-selector.tsx` 的三处「看起来更简洁」的改动都会破坏契约：value 改成必选（首帧伪造音色）、
Context 默认从 null 改成 `{}`（缺 Provider 静默失效）、`{...props}` 挪到 `open` 之前（弹层再也无法受控）。
`ProviderSettingsCard.tsx` 则是两组独立的 if/else 链（control 四分支 / detail 五分支），
合并成一个 switch 会出现「有 control 无 detail」的空洞。

### 6. fixture 的断言就是回归契约

`background-main.ts` 二十条 INV 全部是断言：每删一条，「过期即回收 / 新开旧关 / 空闲被回收」这类回归就无人发现。
最容易被顺手改掉的三条：把 assert 换成 log、把 release 提前、缩短 double-rAF 超时。
末尾的 `.catch` 必须以非零码退出并写 stderr——改成 `exit(0)` 会让 CI 永远绿。

## 与本批相关的故障模式

| 写错的位置 | 线上表现 |
| --- | --- |
| 已安装项先读 describeEntry | 详情页显示陈旧或空组件清单 |
| `componentsLoading` 不判 item.info | 已安装插件闪加载骨架 |
| loading 与 failed 不互斥 | 失败态被 loading 覆盖，重试按钮消失 |
| `pickHttpsUrl` 返回最后一个 | 低优先级回退值覆盖商店权威链接 |
| 外链不校验 https 前缀 | `javascript:` 进入 openExternal |
| 提示词图标正则退化为 includes | pdfx / mycsv 之类子串被误判 |
| 图 404 时改 item 或上抛 | 一张图 404 让整页报错 |
| 提示词 key 用下标 | 重复 prompt 点击串到别的项 |
| 配置先改 state 后落盘 | agent 读到旧 timeoutMs，健康状态长期不一致 |
| connect/status 共用一个 epoch | OAuth 轮询与全量 list 互相作废，界面抖动 |
| status 用整体替换 | 缺失项被当成消失 |
| status 失败回填不 no-op | 一次轮询失败批量标红 |
| 切 workspace 不清 nativeServers | 跨 workspace 串数据 |
| 加载失败给空配置 | 下发空 mcpServers，断开发在跑的 MCP |
| finally 只清 promise 不清 key | 同 workspace 调用永久命中已结束的 promise |
| accept 不先 expire | 超时帧与新帧拼出错误内容 |
| ordinal 校验晚于 map 操作 | NaN/负数进入 tombstone，后续全判旧帧 |
| 任意 fault 都能取代旧 assembly | decoder fail-close，flight 永不收口 |
| release 不校验 assembly 身份 | stagedDecodedBytes 减成负数 |
| 信封超限放到 schema 解析之后 | 超大 payload 先被 JSON 解析，内存峰值失控 |
| 未知 optionId 放行 | 权限语义下形成提权面 |
| 未知错误兜底成 deny | 基础设施故障伪装成用户拒绝 |
| 合成事件沿用高水位 +1 | 被当重放丢弃，pending 永不清 |
| fullAccess 不 await 授权提交 | 客户端仍显 pending，用户重复点击 |
| 给 list 加缓存 | 手改配置文件后 GUI 不刷新 |
| install 失败改成 throw | GUI 丢掉依赖闭包等部分成功信息 |
| 锁粒度改成进程全局 | 不同 workspace 的无关操作被串行化 |
| value 改成必选 | 首帧伪造音色并触发 onValueChange |
| Context 默认值从 null 改 {} | 缺 Provider 时静默失效 |
| Dialog 的 `{...props}` 前置 | 内部值覆盖调用方，弹层无法受控 |
| webhook 不提前 return | 渲染一张没有凭据意义的空卡片 |
| control 与 detail 合并成 switch | 出现「有 control 无 detail」的空洞 |
| 二维码副作用无 cancelled | 卸载后 setState |
| fixture 把 assert 换成 log | 回归悄悄消失 |
| fixture 末尾 `exit(0)` | CI 永远绿 |

## 顺延

本批从 B28 计划清单的 14 个文件中取缺口前 8 个，其余条目由
`zc-next-batches.mjs` 在 B29 开工前复算。

> 说明：本批开工前对 8 个目标文件逐一做了基线校验（`newComments=0`），确认无半插入残留。
> 全部插入均经 `zc-insert.mjs` 原子批写入；三处 anchor 需按完整整行或 `nth` 重定位后重试，
> 整批拒写时未产生落盘。
