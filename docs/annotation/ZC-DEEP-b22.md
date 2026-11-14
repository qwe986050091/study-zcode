# ZC-DEEP-b22

> 批次：B22（计划 9 文件 / 缺口 1,878 行）。
> 覆盖三条链路：会话存储层（SQLite 迁移与组合写事务）、权限确认与工作区头部动作、远控/遥测 IPC 与 Provider 配置服务。
> 基线快照：`d:\code\_annot_baseline\ZC-deep-b22\orig`。
> 规范母本：[ZC-DEEP-CORE-PLAN.md](./ZC-DEEP-CORE-PLAN.md)（第 5 节固定动作）。

## 校验

```
node zc-verify.mjs ZC-deep-b22
SUMMARY files=9 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=1797

deep-density --baseline ZC-deep-b22/orig --ext .ts,.tsx --threshold 30 --mode code
31.21  1213   878  274  206  apps/zcode-cli/packages/adapters/src/storage/session-store/migrations.ts
31.41  1311   952  299  207  packages/ui/src/PermissionDialog.tsx
31.75  1308   926  294  209  apps/zcode-cli/packages/adapters/src/storage/session-store/sqlite-session-store.ts
31.41  1015   761  239  202  packages/ui/src/WorkspaceHeaderSections.tsx
31.65  1009   752  238  203  apps/dev-docs/src/data/productCapabilityMap.ts
31.21   893   628  196  191  packages/ui/src/components/ai-elements/diagram-preview-dialog.tsx
31.18   894   667  208  190  packages/ui/src/settings/OffPeakEditView.tsx
32.39   934   673  218  198  packages/desktop/src/main/desktopMainIpcRemote.ts
31.40   948   688  216  191  packages/provider/src/config-service.ts
SUMMARY files=9 coreBelow30=0 needLines=0 min=31.18 median=31.41 newComments=1797
PASS: all 9 file(s) >= 30% (mode=code)
```

列口径：`密度 / 总行 / 代码行 / 注释行 / 本次新增 / 路径`。

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `adapters/src/storage/session-store/migrations.ts` | SQLite 迁移清单：id 与 SQL 的追加式版本序列 | INV-01~20；已发布 id 永不改名/复用；数组顺序即执行顺序且只能追加；已发布 SQL 一个字符都不能改（checksum）；SQL 必须可重复执行；`touchedTables` 必须与实际触碰表一致；事务内禁用 VACUUM/PRAGMA；重建表四步同属一条迁移；重建时 insert 列清单必须覆盖全部业务列 | 206 |
| `packages/ui/src/PermissionDialog.tsx` | 权限确认弹窗：选项、反馈草稿、应答幂等 | INV-01~20；草稿按 requestId 归零；responding 期间不再触发 onRespond；被 blocked 的选项不能放行；工作流窗草稿只属于 Refine；空白反馈不发送；`saveWorkflow` 必须最先判定；workflow 判定早于 search/execute | 207 |
| `adapters/.../sqlite-session-store.ts` | 会话 SQLite 存储：开库、迁移、组合写事务 | INV-01~20；实例只能经 `open()` 获得；先建父目录再开库；迁移失败先关 db 再抛；close 失败不得覆盖迁移错误；写方法首行 `throwBeforeWrite`；组合写用 `begin immediate`；任一步失败必须 rollback | 209 |
| `packages/ui/src/WorkspaceHeaderSections.tsx` | 工作区头部：标题、任务菜单、归档与 pin | INV-01~18；标题区不得 flex-1 覆盖拖拽区；`isDraftNewTask` 优先于 activeTaskId；无稳定 taskId 时禁用任务级动作；pinned 只在菜单打开时查询；动作必须同时带 workspaceIdentity 与路径；归档需二次确认；归档后同步清运行态与查询缓存 | 202 |
| `apps/dev-docs/src/data/productCapabilityMap.ts` | 文档站能力图数据：系统、分组、节点与边 | INV-01~18；system id 集合闭合且被全部 group 引用；system 顺序固定（renderer→host→zcode-cli→infra）；group tuple 顺序即 UI 顺序；node id 全局唯一；edge id 由下标生成，中间插入即改号；`codeEstimate` 归属能力群不得按节点累加 | 203 |
| `packages/ui/src/components/ai-elements/diagram-preview-dialog.tsx` | 图表预览弹层：SVG 注入、适配视口、手势 | INV-01~18；SVG 只经清洗后的 `dangerouslySetInnerHTML` 注入；transform 只作用于 content 父容器；`applyPreviewSvgLayout` 先于 `resolveSvgBounds`；父容器与 SVG 尺寸必须同时设置；root bounds 取值序 viewBox→属性→client；背景 rect 必须从可见 bbox 排除 | 191 |
| `packages/ui/src/settings/OffPeakEditView.tsx` | 错峰任务编辑视图：只读判定、脏检查、返回 | INV-01~18；`editing` 是编辑态唯一事实；`createBlocked` 只限制创建；readOnly 仅由 status 决定；`readOnlyRef` 渲染期同步赋值；`initialRef` 只在首渲染建快照；`projectKey` 只参与创建态 dirty | 190 |
| `packages/desktop/src/main/desktopMainIpcRemote.ts` | 主进程远程连接与平台 IPC 注册 | INV-01~18；通道单点注册；openExternal 先过协议白名单；内嵌信任集三条件同时成立；PayPal 仅 https 且 host 受信；支付回调必须同源；非内嵌一律系统浏览器；`file:` 走默认应用；IPC 返回值必须可克隆；只透出公开错误码；payload 必须 safeParse；connect 必须绑定当前窗口；失败先取消 pending；bind 校验 sessionId 与非空路径；dispose 带 grace；OAuth state 成对；关窗必须清理；遥测失败不影响主流程；E2E 桥只在显式开关下生效 | 198 |
| `packages/provider/src/config-service.ts` | Provider 配置服务：两层读取、revision、个人覆盖 | INV-01~18；read 并行读两层并冻结；复合 revision 必须包含两侧；update 必须原样保留 defaultModelSelection；`writableProviderOverlay` 只允许已有 Personal 或继承 Built-in；固定 Account Provider 不允许禁用 | 191 |

合计 **1,797**，与 `zc-verify` 的 `added` 一致。

## 关键不变量（抽取）

### 1. 迁移是「只追加的线上契约」

`migrations.ts` 的三条禁令互相支撑：id 不可改名/复用、数组只能追加、已发布 SQL 一个字符都不改。
三者任一被破坏，老库的 `schema_migration` 记账与 checksum 就对不上，表现为**升级后启动即失败且无法自救**——
用户手里没有降级包，也没有手工修 checksum 的入口。
`touchedTables` 不属于运行时正确性，它守的是「评审时能看见破坏性变更」；漏写不会报错，只会让 schema 合同检查形同虚设。

### 2. 组合写必须 `begin immediate`

`sqlite-session-store.ts` 里三个 commit/transition 方法用 `begin immediate` 而非 `begin`。
SQLite 的读事务在升级写锁时会失败并重试，两个启动期并发写就会互相等成死锁。
同时「任一步失败必须 rollback」防止出现「子会话存在但历史不完整」的半成品——这种状态无法自愈，
因为下次启动会认为子会话已存在而跳过补写。

### 3. 内嵌导航的信任集是三条的交集，不是并集

`desktopMainIpcRemote.ts` 里 `isCodingPlanWebviewUrl` 同时要求受信 origin、coding-plan 路径、`embedded=app` 参数。
任何一条被放宽（例如为了测试环境加通配域名）都等于给外部页面一个套壳入口。
`isAllowedExternalOpenUrl` 是 `openExternal` 的第一道闸，放在 shell 调用之前；顺序一颠倒，畸形 URL 就已经交给系统处理器了。
`toBindIpcFailure` 不重新抛出——IPC 返回值必须可结构化克隆，抛异常会让渲染层只拿到泛化错误，丢失 reasonCode。

### 4. Provider 配置的两层快照必须同一时刻

`config-service.ts` 的 `read` 并行读取两层并冻结结果，复合 revision 同时包含两侧 revision。
串行读取会让两层快照来自不同时间点；只拼一侧 revision 则「另一层变了」时缓存不失效。
`#updatePersonal` 必须原样保留 `defaultModelSelection`——这是最容易被顺手「优化」掉的一行，
改错后用户每改一次 Provider，默认模型就被清空一次。

## 与本批相关的故障模式

| 写错的位置 | 线上表现 |
| --- | --- |
| 在迁移数组中间插入新迁移 | 老库把新迁移当「已跑过」，表结构永久缺失 |
| 修改已发布迁移的 SQL 文本 | checksum 变化，升级后启动即失败且无法自救 |
| 组合写用 `begin` 而非 `begin immediate` | 启动期并发写锁升级，互相等待直至卡死 |
| 组合写失败不 rollback | 「子会话存在但历史不完整」，之后永远无法自愈 |
| `open()` 迁移失败不关 db | 句柄泄漏，Windows 上文件被占用，重试也失败 |
| 权限弹窗 responding 期间仍可点击 | 同一 request 在 CLI 侧被记两次决策 |
| 工作流窗把草稿带去 Deny | 模型收不到 refine 升级，用户反馈静默丢失 |
| 头部标题区 flex-1 铺满 | no-drag 覆盖拖拽区，整条标题栏无法拖动窗口 |
| 归档后不清查询缓存 | Header 里任务消失但列表仍显示，点击进入已归档任务 |
| `openExternal` 白名单放在 shell 之后 | 畸形或自定义 scheme 已交给系统处理器 |
| 内嵌判定放宽为「受信 origin 即可」 | 任意外部页面可套壳在应用内导航 |
| IPC handler 抛出异常 | 渲染层只拿到泛化错误，丢失公开 reasonCode |
| connect 失败不取消 pending session | 残留死 flight，重试永远等不到结果 |
| Provider update 不保留默认模型 | 改一次 Provider 清一次默认模型 |
| 只拼一侧 revision | 另一层变更后缓存不失效，UI 显示旧配置 |

## 顺延

无。B22 计划内 9 个文件全部达标；下一批按 `ZC-DEEP-CORE-PLAN.md` 复算清单推进。

> 备注：`desktopMainIpcRemote.ts` 首轮只补了正文注释、缺 INV 头注。已按快照整文件还原后重插，
> 补齐 27 行头注（职责边界 + 18 条 INV），并等量剔除 19 条低信息量正文注释，最终 32.39%。
