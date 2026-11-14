# ZC-DEEP-b62

> 批次：B62（12 文件，按 31.4% 口径计算目标 821 行；按当前工作树复算，优先同类：`packages/ui/src` 8 个（`project-sidebar/grouped`、`project-sidebar`、`root`、`store`、`lib`、`components/ai-elements`、`settings`）、`desktop/src/main` 3 个、`rpc/src` 1 个）。
> 执行分三波：4 + 4 + 4（并发上限 5），每文件独立 spec。
> 基线快照：`d:\code\_annot_baseline\ZC-deep-b62\orig`；开工前 12 文件均为 `newComments=0`。

## 校验

```
node zc-verify.mjs ZC-deep-b62
SUMMARY files=12 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=821

node check-batch.mjs ZC-deep-b62 ZC-deep-b62-files.txt
TOTAL added=821 hardBad=0 suspicious=0
```

逐文件密度（`密度 / 总行 / 代码行 / 注释行 / 本次新增 / 路径`）：

```
31.33   571   399   125   71  packages/desktop/src/main/desktopResourceTelemetry.ts
31.34   295   217    68   68  packages/ui/src/settings/MigrationSection.tsx
31.38   327   239    75   67  packages/desktop/src/main/browserDataManager.ts
31.39   294   223    70   68  packages/ui/src/project-sidebar/grouped/useGroupedDrag.ts
31.40   383   258    81   68  packages/ui/src/components/ai-elements/jsx-preview.tsx
31.40   454   344   108   69  packages/ui/src/project-sidebar/useProjectUnreadSignals.ts
31.40   401   293    92   69  packages/desktop/src/main/browserView/browserCommandInput.ts
31.40   344   242    76   68  packages/rpc/src/channelClient.ts
31.41   417   312    98   69  packages/ui/src/root/useBotBroadcastEffects.ts
31.53   311   222    70   68  packages/ui/src/lib/codingPlanFunnelTelemetry.ts
31.60   316   231    73   68  packages/ui/src/store/commandsStore.ts
31.63   285   215    68   68  packages/ui/src/project-sidebar/grouped/task-context-menu-content.tsx
SUMMARY files=12 coreBelow30=0 needLines=0 min=31.33 median=31.40 newComments=821
PASS: all 12 file(s) >= 30% (mode=code)
```

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `ui/project-sidebar/grouped/task-context-menu-content.tsx` | 分组任务右键菜单内容 | INV-01~18；disabledReason 是唯一组织类写入闸门；只读复制与反馈不受闸门限制；每个 onSelect 内二次校验；移动目标等于当前分组禁用；无 currentGroupId 时移出禁用；子菜单列全部目标分组不按当前过滤 | 68 |
| `ui/project-sidebar/grouped/useGroupedDrag.ts` | 分组拖拽手势 | INV-01~18；拖拽期间不写持久状态，只存 preview；结束只提交一条单节点命令，零位移命令为空；取消完全回到起点；组拖临时展开按快照回滚；折叠快照只抓一次且仅组拖生效；指针捕获与监听释放交给 dnd-kit | 68 |
| `ui/project-sidebar/useProjectUnreadSignals.ts` | 项目未读信号 | INV-01~18；复合键「工作区身份 + taskId」去重；接受条件为 updatedAt 更大或同刻不同 status；前台可视任务只登记完成记录不写未读；离开窗口才补记；回窗先补写再清除；补写成功才置 written 并等下次事件重试 | 69 |
| `ui/root/useBotBroadcastEffects.ts` | Bot 广播订阅副作用 | INV-01~18；订阅在 effect 内建立并由清理函数解绑；同一 message 只被 stream 或 refresh 之一消费；回调内重读 store 快照不用闭包；stream 镜像按 activeTaskId 与 workspaceIdentity 双判定；type 穷举未知不写；task_complete 同时置 completed 并清权限请求与错误 | 69 |
| `ui/store/commandsStore.ts` | 命令注册表投影 store | INV-01~18；身份键统一构造；异步写回前重比 key；同 key 单飞在途；在途表项 finally 删除；loading/error 只在 key 匹配时写；投影归属字段与列表同次写入；commands 与 userCommands 同源同序；增删改原位语义；operatingCommandId 单槽且三路径清空 | 68 |
| `ui/lib/codingPlanFunnelTelemetry.ts` | 编码计划升级漏斗埋点 | INV-01~18；事件类型 ck 与元素名 coding_plan_upgrade_ck 共同定位；属性白名单八键；一次会话复用同一 purchaseFunnelId 串四步；id 全局唯一且随机源缺失降级不为空串；上下文创建后只读；来源枚举八选一，空闲链路固定 session_idle_time | 68 |
| `ui/components/ai-elements/jsx-preview.tsx` | JSX 源码预览 | INV-01~18；jsx 字符串是上下文唯一事实源；流式期间只补标签、非流式原样解析；补全只追加不删字符；未闭合尾部标签整段丢弃；解析失败最终降级为展示源码；流式期间的解析错误不外抛只内部降级 | 68 |
| `ui/settings/MigrationSection.tsx` | 迁移设置区块 | INV-01~18；组件不持有业务状态，全部归迁移 hook；能力判定只看 supportState.supported；扫描按钮不受导入禁用影响，三处筛选控件同时禁用；扫描中只换图标不换文字；扫描入口丢弃 Promise，异常由 hook 转 scanError | 68 |
| `desktop/src/main/browserView/browserCommandInput.ts` | 浏览器 CDP 输入事件翻译 | INV-01~18；只翻译动作不查元素不重试；修饰键掩码单一来源 Alt=1/Control=2/Meta=4/Shift=8；ControlOrMeta 按平台折叠；掩码为 0 不下发 modifiers；键名归一仅小写查表；解析顺序固定为表内键、修饰键、单字母、数字、裸键 | 69 |
| `desktop/src/main/browserDataManager.ts` | 内置浏览器数据导入清理 | INV-01~18；固定 `persist:zcode-embedded-browser` 分区；显式 targetSession 优先于分区回退；非 Windows 缺 profilePath 与可执行文件时提前返回；显式 profilePath 跳过自动发现；Profile 目录必须 stat 确认；成功判定三条之一 | 67 |
| `desktop/src/main/desktopResourceTelemetry.ts` | 桌面资源采样与上报 | INV-01~18；事件只经 reportResourceCustom，group 固定 resource/type 固定 custom；globalContext 未配置不产事件；采样与上报分离，仅 flush 与退出排空 drain；main 角色 heap 就地读取合并；设备级来源在角色级之后；completionToken 事实去重且无 token 保留旧行为 | 71 |
| `rpc/src/channelClient.ts` | 通道客户端请求与事件分发 | INV-01~18；请求 id 单调递增且 Promise 与事件共用计数器与 handlers 表；每个 id 的 handler 在成功/失败/取消/dispose 四路径删除；只有 Promise 请求登记 pendingRejections；dispose 逐个拒绝后清空实现 fail-closed；取消前校验 pendingRejections 仍持有 id；state 非 Idle 时挂起到 onDidInitialize | 68 |

合计 **821**，与 `zc-verify` 的 `added` 一致。

## 关键不变量（抽取）

### 1. 拖拽期间不得写持久状态

`useGroupedDrag.ts` 只把预览放在 `preview` 与 `latestPreview`，手势结束才提交一条单节点命令。
边拖边写会让中途取消留下半程结果，用户松手前分组已经变了。

### 2. 未读补写成功才置 written

`useProjectUnreadSignals.ts` 补写失败时保持未写状态，等下一个生命周期事件重试。
提前置位会让一次失败永久丢失未读，用户切回窗口看不到任何红点。

### 3. 异步写回前必须重比 key

`commandsStore.ts` 每个 await 之后重新比对发起时的 key，不匹配直接返回。
只判断 await 是否成功会让慢 target 的响应覆盖当前 Scope 的列表。

### 4. 流式补全只追加

`jsx-preview.tsx` 的标签补全只追加缺失闭合标签，未闭合尾部整段丢弃。
改写原始字符或截半截标签会让解析器拿到非法文档，预览直接白屏。

### 5. 通道取消前校验 handler 仍在册

`channelClient.ts` 只有在 `pendingRejections` 仍持有该 id 时才发送 PromiseCancel。
对已完成请求补发取消会让服务端把幂等取消记成异常，日志被噪声填满。

## 与本批相关的故障模式

| 写错的位置 | 线上表现 |
| --- | --- |
| 拖拽中写持久状态 | 取消后分组残留半程结果 |
| 未读补写前提前置 written | 一次失败永久丢未读 |
| 异步写回不重比 key | 慢响应覆盖新工作区列表 |
| 流式补全改写原字符 | 预览白屏或标签错乱 |
| 对已完成请求发取消 | 服务端日志被幂等取消噪声填满 |
| 修饰键掩码多源 | 组合键在部分平台失效 |
| 资源事件绕过 reportResourceCustom | ARMS 上看不到该批事件 |
| dispose 不拒绝挂起请求 | 调用方永久 pending，连接泄漏 |
| 迁移控件未按能力禁用 | 不支持环境仍可点导入 |
| 漏斗 id 用空串兜底 | 四步无法串成一次转化 |

## 顺延

B62 复算清单共 20 个候选，本批取 12 个，其余顺延到 B63，开工前用更新后的工作树重新测量后确定。

> 说明：每文件独立 spec（≤150 行），4 文件一组并行（并发上限 5），逐文件密度校验。
> 目标行数按 `round(code × 0.314) − 当前注释行` 计算，实测 31.33%~31.63%，`suspicious=0`。
