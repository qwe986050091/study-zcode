# ZC-DEEP-b45

> 批次：B45（12 文件；B44 顺延的 8 个全部纳入，再按缺口补 CLI 权限策略、Chrome 候选、错误横幅、测试结果 4 个）。
> 执行分三波：4 + 4 + 4（并发上限 5），每文件独立 spec。
> 上一会话中断在最后 2 个文件前（`userActionTelemetry.ts`、`sourceServerUpdateNotifications.ts` 均为 `newComments=0`），
> 本次续做前先跑 `zc-verify` 确认已完成的 10 个文件无半插入残留，再补齐剩余 2 个。
> 基线快照：`d:\code\_annot_baseline\ZC-deep-b45\orig`。

## 校验

```
node zc-verify.mjs ZC-deep-b45
SUMMARY files=12 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=1159

node check-batch.mjs ZC-deep-b45 ZC-deep-b45-files.txt
TOTAL added=1159 hardBad=0 suspicious=0
```

逐文件密度（`密度 / 总行 / 代码行 / 注释行 / 本次新增 / 路径`）：

```
31.32   508   364  114   95  apps/zcode-cli/packages/core/src/tool/handlers/bash-command-permission-policy.ts
31.33   438   316   99   95  packages/desktop/src/main/chromeInstallationCandidates.ts
31.34   457   335  105   97  packages/zcode-server-cli/src/runtime/componentCache.ts
31.36   537   389  122   96  packages/ui/src/ChatErrorBanner.tsx
31.39   411   309   97   96  packages/web/src/web-remote-control/domain/webRemoteControlScreenCopy.ts
31.40   454   344  108   97  apps/zcode-cli/packages/core/src/tool/handlers/bash-readonly-policy-multiword-gh.ts
31.46   484   321  101   95  packages/ui/src/components/ai-elements/test-results.tsx
31.47   882   607  191  101  apps/zcode-cli/packages/core/src/agent/message-history.ts
31.49   501   362  114   96  apps/zcode-cli/packages/cli/src/tui-prompt-handler.ts
31.50   543   400  126   99  apps/zcode-cli/packages/tui/src/app.tsx
31.70   432   306   97   96  packages/ui/src/lib/userActionTelemetry.ts
31.86   430   317  101   96  packages/ui/src/root/sourceServerUpdateNotifications.ts
SUMMARY files=12 coreBelow30=0 needLines=0 min=31.32 median=31.43 newComments=1159
PASS: all 12 file(s) >= 30% (mode=code)
```

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `core/src/agent/message-history.ts` | Agent 规范消息历史 | INV-01~18；canonical 条目唯一写入口与克隆入参；borrow 返回内部数组本体的借用契约；cachedMessages 仅表示 context prefix 段；缓存命中只能由 usage 侧确认；推理块必须排在文本之前；replaceMessages 的整段替换与计数重算 | 101 |
| `tui/src/app.tsx` | TUI 根组件 | INV-01~18；messages 只经 SessionEvent 投影与 applyResult 写入；草稿 state 与 draftRef 双真值单一同步口；附件 ref 即时真值；占位符删除连带移除附件；模型/思考档位/模式/slash 四面板互斥；提交解析优先级与面板一致 | 99 |
| `core/src/tool/handlers/bash-readonly-policy-multiword-gh.ts` | gh 多词只读策略表 | INV-01~17；键必须为 gh 加两词子命令且属白名单；safeFlags 只收筛选与输出控制项；repo 作用域条目必须挂危险回调；search 系列刻意不挂回调；共享常量展开顺序；flag 取值类型与真实指向一致 | 97 |
| `zcode-server-cli/src/runtime/componentCache.ts` | 组件缓存与安全解包 | INV-01~18；组件 id 字符集约束；摘要必须 64 位十六进制；归档成员路径拒绝绝对路径/NUL/两点段；拒绝符号链接成员与目录遍历；同归档禁止重复成员；缓存命中三要素（id/组件摘要/归档摘要） | 97 |
| `web/.../webRemoteControlScreenCopy.ts` | 手机远控失败页文案表 | INV-01~15；中英两表 key 集合逐项一致且等于 FailureReason 去掉 auth-required；新增失败原因先落 shared 协议；auth-required 折叠为 relay-unavailable；locale 只允许两种取值；zh 前缀归一化 | 96 |
| `cli/src/tui-prompt-handler.ts` | TUI 会话与 App 生命周期 | INV-01~18；同一时刻至多一个 App 对外可见；close 幂等（WeakMap 复用 Promise）；runtime 跨 App 复用不重建；先关 App 后关自启 Chromium；cleanup 受超时约束；无审批回调一律 deny | 96 |
| `ui/src/ChatErrorBanner.tsx` | 聊天错误横幅 | INV-01~16；远端失败码优先走 formatRemoteConnectionError；缺模型判定只按 error.code；modelConfigTarget 只改措辞不改进程；未知命令原样返回；业务码解析恒定顺序；仅白名单 code 本地化 | 96 |
| `core/src/tool/handlers/bash-command-permission-policy.ts` | Bash 命令权限前缀策略 | INV-01~17；静态安全是前缀规则前置；任一 invocation 不安全则整体降级；高危根命令永不产出前缀；前缀至少两个 token；动态词与路径类 token 不入前缀；环境变量赋值必须可静态化 | 95 |
| `desktop/src/main/chromeInstallationCandidates.ts` | 运行中 Chrome 安装探测 | INV-01~17；全局正则 matchAll 前必须归零 lastIndex；三段捕获按双引号/单引号/裸值优先；密码后端类型与集合同步增删；Windows canary 为 SxS；macOS 包名与 Profile 目录两套命名；Linux dev 对应 unstable 目录 | 95 |
| `ui/src/components/ai-elements/test-results.tsx` | 测试结果展示原语 | INV-01~15；状态四值与样式表/图标表键集合一致；汇总数不得小于通过加失败；总数为 0 跳过进度条；顶栏与单条对 0ms 的口径不同；结果上下文默认空对象；套件上下文兜底为通过 | 95 |
| `ui/src/lib/userActionTelemetry.ts` | Renderer 用户操作埋点 | INV-01~20；严格旁路（发送失败只吞）；四段门控顺序；NOOP handle 共享无状态；未登记动作不采集；finish 幂等且先 delete 再清定时器；负时长防护；队列 256 丢新保旧；批量阈值与 2s 防抖；单条超限丢弃防死循环；flush 单飞与续排 | 96 |
| `ui/src/root/sourceServerUpdateNotifications.ts` | Source 服务器必需升级通知 | INV-01~20；key 为设备 id 加可用版本；仅 required 才提示；四字段缺失不提示；向导已接管不弹；活跃 shown 与持久 seen 分离；离开 eligible 立即撤销；点击前重拉快照复核；actionStarted 单飞；仅 server 目标给按钮；dispose 释放双订阅 | 96 |

合计 **1,159**，与 `zc-verify` 的 `added` 一致。

## 关键不变量（抽取）

### 1. 消息历史只有一份写入口，写入必须克隆

`message-history.ts` 的 `addUser` / `addAttachment` / `addEntries` / `addAssistant` / `addToolResult` /
`replaceMessages` 是 canonical 历史的唯一写入点。若调用方复用同一个 content 数组并在提交后修改，
已提交历史会被静默污染；若绕过这些方法直接改数组，同一条消息会在两个所有者各存一份，重放时出现重复或丢消息。

### 2. TUI 候选面板互斥必须与提交解析顺序一致

`tui/src/app.tsx` 里模型、思考档位、模式与 slash 四个候选面板同一时刻只能有一个选中态，
判定的 else-if 链顺序就是提交时的解析优先级。只改面板不改编排，会出现「屏幕上显示模型候选、回车却按 slash 命令解释」，
用户看到的与提交出去的完全不是一回事。

### 3. 组件缓存先验摘要再解包，且必须拒绝符号链接

`componentCache.ts` 的缓存命中要同时核对组件 id、组件摘要与归档摘要；解包阶段拒绝绝对路径、NUL、
`..` 段、符号链接与重复成员。少任何一条，组件包都能写到发布目录之外，或用符号链接读到目录外的内容，
而且失败会发生在组装阶段，表现为永久卡在坏缓存上。

### 4. 埋点严格旁路，发送失败不得回压业务

`userActionTelemetry.ts` 的 `sendBatch` 异常只在 `flushImpl` 里吞掉，不重试、不改操作结果。
若把采集失败当作业务失败抛出，采集后端抖动会直接变成用户点击失败；这是「可观测性反噬业务」的典型故障。

## 与本批相关的故障模式

| 写错的位置 | 线上表现 |
| --- | --- |
| 消息历史允许复用入参数组 | 已提交历史被后续修改污染，重放消息错乱 |
| TUI 面板互斥与解析优先级分叉 | 显示模型候选，提交却按命令解释 |
| 组件缓存命中不校验归档摘要 | 复用串号的旧归档，组装阶段永久失败 |
| 解包不拒绝符号链接 | 组件可读写发布目录之外的文件 |
| 中文两表漏 key | 切语言后失败页标题空白甚至白屏 |
| auth-required 未折叠 | 查表得到 undefined，绕过入口的调用者拿空文案抛错 |
| 无审批回调时默认放行 | 未授权工具调用被真实执行 |
| 高危根命令产出前缀 | 等价于永久关闭该类命令的审批 |
| Chrome 正则 lastIndex 未归零 | 第二条命令行起全部漏匹配 |
| 埋点把发送异常抛给业务 | 采集抖动导致用户操作失败 |
| 通知点击不复核快照 | 过期按钮重复发起更新 |
| 卸载后仍展示 toast | 组件已销毁但顶部提示残留 |

## 顺延

B45 复算清单共 20 个候选，本批取 12 个后其余 8 个顺延到 B46（缺口各 91~93 行），
清单将在 B46 开工前用更新后的工作树重新测量后确定。

> 说明：每文件独立 spec（≤150 行），4 文件一组并行（并发上限 5），逐文件密度校验。
> 本批 `suspicious=0`；2 个续做文件按 `round(code × 0.315) − 当前注释行` 精确补到 31.70% / 31.86%。
