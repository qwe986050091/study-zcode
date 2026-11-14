# ZC-DEEP-b32

> 批次：B32（12 文件，跨 4 个模块，按「同模块优先」拆为 B32-A / B32-B 两个子批各自校验）。
> B32-A：`packages/provider` 2 文件 + `apps/zcode-cli/core` 3 文件 + `packages/shared` 1 文件 + `packages/desktop` 1 文件（+934 行）；
> B32-B：`packages/ui` 5 文件（+643 行）。
> 基线快照：`d:\code\_annot_baseline\ZC-deep-b32\orig`。

## 校验

```
node zc-verify.mjs ZC-deep-b32
SUMMARY files=12 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=1577

node check-batch.mjs ZC-deep-b32 ZC-deep-b32a-files.txt
TOTAL added=934 hardBad=0 suspicious=0

node check-batch.mjs ZC-deep-b32 ZC-deep-b32b-files.txt
TOTAL added=643 hardBad=0 suspicious=0
```

逐文件密度（列口径：`密度 / 总行 / 代码行 / 注释行 / 本次新增 / 路径`）：

```
31.30   677   476  149  127  packages/ui/src/components/ai-elements/code-block.tsx
31.34   699   501  157  133  packages/ui/src/v4/pendingCommandRegistry.ts
31.35   733   520  163  135  apps/zcode-cli/packages/core/src/agent/session-history-hydrator.ts
31.37   725   542  170  135  packages/shared/src/browser-use/commands.ts
31.40   926   672  211  131  apps/zcode-cli/packages/core/src/runtime/methods/rewind-message.ts
31.40   608   449  141  128  packages/ui/src/ToolCallBlocks/renderers/edit.tsx
31.41   641   433  136  128  packages/provider/src/config/provider-config.ts
31.41   580   433  136  126  packages/ui/src/chat-input-toolbar/CodingPlanContextUsage.tsx
31.43  1006   700  220  131  apps/zcode-cli/packages/core/src/browser-client/playwright.ts
31.45   584   442  139  129  packages/ui/src/store/pluginStore.ts
31.46   612   445  140  127  packages/desktop/src/main/windowsChromeAppBoundKey.ts
31.46   728   499  157  147  packages/provider/src/config/model-config.ts
SUMMARY files=12 coreBelow30=0 needLines=0 min=31.30 median=31.41 newComments=1577
PASS: all 12 file(s) >= 30% (mode=code)
```

开工前 12 文件基线均为 `newComments=0`（无半插入残留）；`zc-verify` 的 `added=1577`
与两组子批 `check-batch` 合计（934 + 643）一致，也与逐文件目标合计一致。
`// INV-` 条数：13~23 条/文件。

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `packages/provider/src/config/model-config.ts` | Provider 模型能力配置的构造、冻结与逐层叠加 | INV-01~16；构造结束即冻结；`undefined` 表示本层未声明、`null` 才是显式清空；标量/数组/映射各自的叠加规则；内置能力不得被个人层无声覆盖 | 147 |
| `packages/provider/src/config/provider-config.ts` | Provider 访问配置（凭据/端点/协议）的合并与校验 | INV-01~16；配置类构造后只读；`overlayProviderAccess` 三值分支顺序；type 不同不得字段合并；`complete` 校验的未知字段拒绝 | 128 |
| `apps/zcode-cli/packages/core/src/agent/session-history-hydrator.ts` | 冷恢复时把持久化 part 水合成 provider history | INV-01~19；同一 `part.id` 只入一次且后者覆盖；`bot_topic_context` 整组跳过；未 attached 的 `shared_context` 不得注入；工具结果与正文分开去重 | 135 |
| `apps/zcode-cli/packages/core/src/runtime/methods/rewind-message.ts` | 消息回滚：文件快照 / 对话链 / 两者同时 | INV-01~23；Workspace 只回文件不动对话；Both 先工作区且仅 ActiveChain 继续裁消息；cascade 先规划后执行；checkpoint 基线与代际不可漂移 | 131 |
| `apps/zcode-cli/packages/core/src/browser-client/playwright.ts` | Playwright 浏览器会话的链式定位与执行封装 | INV-01~14；构造只拼选择器不发命令；终结操作统一判错；一个会话只绑一个归属对象；超时与跨页组合的拒绝 | 131 |
| `packages/shared/src/browser-use/commands.ts` | 浏览器命令的 zod schema 与能力协商词表 | INV-01~16；`method` 判别联合且各分支 strict；未知字段拒绝；`tabId` 可选表示默认 view；新增命令必须同步 manager 路由 | 135 |
| `packages/desktop/src/main/windowsChromeAppBoundKey.ts` | Windows Chrome App-Bound 密钥的读取与解密 helper 调用 | INV-01~15；4 字节 `APPB` 前缀与长度判定；送入 helper 前必须剥前缀；helper 需 realpath 且在受信根内、非符号链接；失败只降级不抛穿 | 127 |
| `packages/ui/src/v4/pendingCommandRegistry.ts` | 待确认命令账本：登记、确认、查询与过期清理 | INV-01~16；账本只是恢复线索而非权威事实；键必须含 `sessionId + commandId`，全局用 `<global>`；重复登记不刷新 TTL；一次性消费与 prun 顺序 | 133 |
| `packages/ui/src/store/pluginStore.ts` | 插件市场列表与启用状态的 UI store | INV-01~13；同路径不同工作区身份不共享缓存；请求失败保留既有列表只写错误；有缓存只置刷新标志；无乐观更新 | 129 |
| `packages/ui/src/ToolCallBlocks/renderers/edit.tsx` | edit 工具调用的 diff 渲染器 | INV-01~15；无 patch 时退回全量渲染；有 patch 必须出现内联 diff；单文件 patch 只渲染一次；失败态也要可见 | 128 |
| `packages/ui/src/components/ai-elements/code-block.tsx` | 代码块展示：语言归一、标题兜底、复制与主题 | INV-01~15；上下文必须有默认值；语言先去空白再小写；未知语言三级兜底；空代码与超长行不破坏布局 | 127 |
| `packages/ui/src/chat-input-toolbar/CodingPlanContextUsage.tsx` | 输入框工具条上的编码套餐额度/上下文用量 | INV-01~15；百分比截断到 0~100；非有限值按 0；无快照不渲染额度条；窗口额度与包月额度口径分离 | 126 |

合计 **1,577**，与 `zc-verify` 的 `added` 一致。

## 关键不变量（抽取）

### 1. `undefined` 与 `null` 在配置叠加里是两种语义

`model-config.ts` 与 `provider-config.ts` 都把 `undefined` 定义为「本层未声明，保留下层」，
把 `null` 定义为「显式清空」。这两个值一旦被归一成同一个，个人层就无法删除内置继承来的字段，
典型故障是清空凭据后旧 Key 仍参与请求、个人未填窗口大小被当成清空并截断长会话。

### 2. 冷恢复的每一步都必须先判来源，再判内容

`session-history-hydrator.ts` 的跳过规则（`bot_topic_context`、未 attached 的 `shared_context`）
必须发生在去重与写 history 之前。顺序反过来时，被跳过的消息已经进入 history，再删就会破坏
`part.id` 覆盖关系，表现为重复正文或 provider 报重复工具调用标识。

### 3. 回滚是「先规划、后执行」的两阶段操作

`rewind-message.ts` 的 cascade 分支要求先确认对话链可回滚，再动工作区快照。
反过来做（先回文件、再发现对话不可回）会留下半回滚状态，用户重试时 checkpoint 基线已经漂移，
最终既回不到旧状态也回不到新状态。Both 分支必须先工作区、仅 ActiveChain 才继续裁消息，也是同一约束。

### 4. 账本不是事实

`pendingCommandRegistry.ts` 的条目只是「可能已发送」的恢复线索。界面若把它当权威事实，
刷新后会把 accepted 误判为已送达并重复发送。因此键必须同时含会话与命令（全局用 `<global>` 占位），
且重复登记只保留首次的 `issuedAt`/`expiresAt`，否则 TTL 被不断推后、过期条目永远清不掉。

### 5. 外部输入的展示值必须先夹紧再使用

`CodingPlanContextUsage.tsx` 的百分比、`code-block.tsx` 的语言标识都属于外部输入：
百分比要在写入宽度前截断到 0~100 并把 NaN/Infinity 归零，语言要先 `trim().toLowerCase()` 再查表。
少了任一步，故障不是报错而是「静默错形」——进度条溢出、标题出现悬空点号或 `undefined`。

## 与本批相关的故障模式

| 写错的位置 | 线上表现 |
| --- | --- |
| 把 `undefined` 与 `null` 归一 | 个人层无法删除内置字段，清空凭据后旧 Key 仍生效 |
| 配置实例构造后仍可写 | 两个窗口读到不同配置，缓存实例被原地污染 |
| 冷恢复先写 history 再判来源 | 旧话题背景回流，模型回退到上一轮话题 |
| `part.id` 去重方向写反 | 冷恢复出现重复正文与重复工具结果 |
| Both 回滚先动对话 | 文件回了、历史没了，或只回一半导致基线漂移 |
| 构造期就发送浏览器命令 | 构造一次一次往返，超时与并发翻倍 |
| 命令 schema 非 strict | `tabId` 拼错被静默剥离，命令打到默认 view |
| App-Bound 前缀未剥离 | 解密整体偏移 4 字节，cookie 静默解成乱码 |
| helper 未做 realpath / 符号链接校验 | 执行点被 junction 指向任意目录，校验对象是替身 |
| 账本当权威事实 | 刷新后重复发送同一命令 |
| 重复登记刷新 TTL | 过期条目永不清理，账本无限增长 |
| 插件请求失败清空列表 | 一次网络抖动整屏空态 |
| 有缓存仍置 loading | 开关插件后列表闪空 |
| diff 渲染重复 | 同一段 patch 在展开区出现两份 |
| 无快照仍渲染额度条 | 下游读 undefined，工具栏白屏 |
| 百分比不夹紧 | 进度条溢出或反向，数字与图形矛盾 |
| 语言标识不归一 | 带空格/大小写不同的语言落到同一兜底标题 |

## 顺延

B32 复算清单为 16 文件，本批按「同模块优先」取 12 个，其余 4 个顺延到 B33：
`apps/dev-docs/src/feature-boundary-graph/FeatureBoundaryGraphView.tsx`（缺口 123）、
`packages/desktop/scripts/gen-ui-fixture/main.ts`（缺口 123）、
`packages/server/src/remote/zcodeAgentDevDeploy.ts`（缺口 120）、
`packages/ui/src/CodingPlanUsageRemainingPanel.tsx`（缺口 120）。

> 说明：本批按防超限规则执行——每文件单独一份 spec（≤150 行），5 文件一组并行，
> 每组插完立即跑该组 `check-batch` 与单文件密度，未出现长输出。
> `provider-config.ts` 首轮有 1 行注释以英文关键字 `switch` 开头，被自查规则判为疑似代码行，
> 已改写为纯中文表述；改写只动新增注释自身，`deletedNonZero` 仍为 0。
