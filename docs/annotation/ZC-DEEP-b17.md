# ZC-DEEP B17 索引（core & apps）

日期：2026-11-07
基线快照：`d:\code\_annot_baseline\ZC-deep-b17\orig`
范围：`packages/ui` 视图层 + `apps/zcode-cli/packages/core`（不含 `packages/services`）

## 1. 批次数据

| 指标 | 值 |
| --- | --- |
| 文件数 | 7 |
| 计划缺口 | 1,862 |
| 实际新增注释行（`added`） | 2,146 |
| 最低密度 | 30.81%（`StatusCards.tsx`） |
| 最高密度 | 42.48%（`V4ComposerToolbar.tsx`） |
| 校验 | `deletedNonZero=0` / `nonCommentAdded=0` / `starSlash=0` / `syntaxErrorFiles=0` / `needLines=0` |

累计（含 B16 收尾时 `taskRealtimeBus.ts` 的 +10 补厚）：69 文件 / 30,984 行，
相对基线 141,590 行完成度 21.9%，剩余缺口 110,606 行。

## 2. 文件清单（路径｜职责｜注释主题｜+行数）

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `apps/zcode-cli/packages/core/src/browser-client/facade.ts` | browser-client 对象门面（Browser / Tabs / Tab / cua / recording / capabilities） | 门面不按 backend 分支；id+generation 缓存；assertAvailable 包住每次调用；raw 不 expectOk；cua 按键映射与修饰键白名单；JS dialog 默认 alert；open 复用失败降级 newTab；list 返回副本；applyPlaywrightPolicy 后新 getter 必须 wrap | +290 |
| `packages/ui/src/remote-connection/RemoteConnectionConnectingStep.tsx` | 远程连接向导「连接中」阶段视图（四段轨 channel → identify → deploy → handshake） | 只有 `[source-server:<phase>]` 推进阶段；进度取 max 不回退；失败只标记对应段；connectionReady 有失败时不生效；percent 只 upload/download；日志跟随贴底；展示状态优先级 forceUpdate > upgrading > install > loading > upgrade > failed > online > absent；反馈只取最后 30 条并脱敏 | +278 |
| `packages/ui/src/settings/model-provider-section/StatusCards.tsx` | Coding Plan / Start Plan 状态卡（状态投影 + 动作编排） | displayStatus / actionStatus / balanceStatus 三输入分离；checking 不显示旧文案；Team Plan 只读显式 reason；relogin 优先于 retry；buy 与 upgrade 互斥；多卡路径三条件；percentage 已用需反转 clamp；<10 保留 1 位小数 | +275 |
| `packages/ui/src/command-center/CommandCenterDialog.tsx` | 全局命令中心（命令 / 会话 / 文件三类搜索） | 关闭态降空但不 early return；前缀 > / # / @ 优先于手动 scope；文件每 workspace 只拉一次；cancelled 拦截晚到响应；任务 key = identity\|\|path + taskId；runCommand 记历史→关闭→执行且 catch；cmdk value 全局唯一且 `shouldFilter={false}`；Linux variant 覆盖 top | +319 |
| `packages/ui/src/v4/composer/V4ComposerToolbar.tsx` | v4 composer 工具条（模型 / 思考深度 / context usage 三件套） | 三件套不门控在 `config!==null`；modelLocked 优先；Highspeed 指示器优先于加载态；显示事实只消费 draft；团队 source 缓存按 scope+鉴权隔离；entitlement 按 family 取 providerId；空 thought value 不上抛；同 key 且有 error 仍允许重试；热键文案读生效绑定；e2e data-* 与受控值一致 | +418 |
| `packages/ui/src/v4/ConversationShareConfirmationDock.tsx` | 会话分享停靠面板（确认 / 进度 / 失败 / 警告） | publishView = pending \|\| error；compactProgress = pending && !error；披露勾选是确认前置但重试免检；未勾选只做本地提示（滚动→聚焦→抖动，尊重 reduced-motion）；失败只标记当前 phase；权限映射双向全覆盖；keep-open 标记供外部识别 | +276 |
| `packages/ui/src/chat-input-toolbar/contextUsage.tsx` | 工具条 context 用量触发器 + 弹层（上下文 / Coding Plan / Start Plan） | 三段全空返回 null；触发器文案三级回退；used/size 非法视为不可展示；百分比 clamp 0..1；缓存命中率 78% 阈值（DEV 例外）；breakdown 按 chars 降序 + 固定次序 tie-break；重置弹框打开期间拒绝面板关闭；晚到刷新用序列号拦截；自动完成先 claim 后播报；跨窗口只播一次 | +290 |

## 3. 本批发现的关键不变量

- **门面层**：`browser-client/facade.ts` 的 `execute` 在调用时才读取 `this.info.id/generation`，
  缓存键必须同时含 id 与 generation——只按 id 缓存会让重连后的旧 tab 句柄继续命中。
- **向导层**：连接阶段只能由宿主日志的 `[source-server:<phase>]` 推进；客户端不得根据进度百分比反推阶段，
  否则日志重放时进度条会倒退。
- **状态卡**：`displayStatus` 与 `actionStatus` 可以不同，任何「用文案反推动作」的实现都会把
  Project Key 错误误判成团队未分配。
- **命令中心**：任务行的身份 key 是「工作区身份或路径 + taskId」，缺工作区维度会让两个仓库的同名 taskId 合并成一行。
- **工具条**：团队额度 source 的缓存必须按 scope + 鉴权隔离，并且 scope 比较放在 render 期；
  放 effect 会多渲染一帧上一账号的额度。
- **分享面板**：`error` 单独也能进入发布版面（`publishView = pending || error`），只判 pending 会让失败退回确认表单。
- **context 弹层**：重置弹框与 HoverCard 共用 Portal，弹框打开期间必须拒绝面板关闭（读 ref 而非 state），
  否则同一 tick 的同步关闭事件会把弹框一起卸载。

## 4. 故障模式（改错会出现什么）

| 错误改法 | 现象 |
| --- | --- |
| 工具条把三件套整体门控在 `config !== null` | 草稿态整条工具条不渲染 |
| 团队 source 缓存上用 `useEffect` 清空 | 登出后短暂显示上一账号额度 |
| 分享面板用 `pending` 单独决定版面 | 发布失败退回确认表单，看不到失败原因 |
| context 触发器只认 `codingPlan.onAccess` | Start Plan 用户 hover 永不刷新余额 |
| 命令中心先截断再过滤文件 | 大仓库只剩几条命中 |
| 向导用进度百分比反推阶段 | 日志重放时进度条倒退 |
| StatusCards 用展示文案反推交互 | 团队错误给出「重新登录」的错误引导 |

## 5. 阻塞与需要决定的事项

- 无阻塞。B17 断电前的半插入风险已三重确认（grep 无标记 / `git status --short` 无输出 /
  `deep-density newComments=0`），随后按基线快照从零重建。
- 待决定：`V4ComposerToolbar.tsx` 实测密度 42.48%，明显高于 30% 目标线。
  该文件同时承载模型目录、连接切换与额度三段编排，注释以「不变量 + 失败路径」为主；
  是否在后续批次统一做一次「超密文件瘦身」需要用户确认，本批未做删改（避免引入非注释变更）。

## 6. 校验输出

```
deep-density (7 files, mode=code)
31.84  facade.ts
31.23  RemoteConnectionConnectingStep.tsx
30.81  StatusCards.tsx
35.34  CommandCenterDialog.tsx
42.48  V4ComposerToolbar.tsx
31.41  ConversationShareConfirmationDock.tsx
32.75  contextUsage.tsx

zc-verify ZC-deep-b17
deletedNonZero=0  nonCommentAdded=0  starSlash=0  syntaxErrorFiles=0  added=2146
```
