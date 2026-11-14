# L2-B6 adapters 注释索引

- 范围：`apps/zcode-cli/packages/adapters/src/` 全部非测试 `.ts`（226 个）
- 基线：`d:\code\_annot_baseline\L2-B6\`（编辑前逐字节副本）
- 校验：`git diff --no-index --numstat` 删除列 = 0；TypeScript `createSourceFile` 语法诊断 = 0
- 合计：**+9486 行**，删除列非 0 文件 **0**，语法错误 **0**
- 说明：纯 re-export 文件按要求跳过；`storage/session-store/{migration-runner,migrations,sqlite-session-store}.ts` 在基线中已含完整 L2 注释，本批复检为 0 新增（不计入 + 行数）

## 超 800 行文件（按最终文件行数）

| 路径 | 最终行数 | +行数 |
|---|---:|---:|
| `plugins/marketplace.ts` | 3286 | 339 |
| `mcp/index.ts` | 2806 | 300 |
| `fs/index.ts` | 2137 | 258 |
| `model/runner-stream.ts` | 1808 | 89 |
| `model/model-execution.ts` | 1304 | 171 |
| `plugins/index.ts` | 1113 | 116 |
| `storage/session-store/sqlite-session-store.ts` | 1100 | 0（基线已含） |
| `model/runner-debug.ts` | 1036 | 130 |
| `storage/session-store/migrations.ts` | 1008 | 0（基线已含） |
| `storage/session-store/repositories/usage.ts` | 800 | 54（恰好 800，未超） |

## 索引（路径｜职责｜注释主题｜+行数）

### 根与 storage

| 路径 | 职责 | 注释主题 | +行数 |
|---|---|---|---:|
| `index.ts` | adapters 聚合导出 | skip:re-export | 0 |
| `storage/index.ts` | tool 产物/派生媒体文件存储 | URI 口径、原子写、MIME 扩展名、fs 故障注入 | 79 |
| `storage/session-store.ts` | 会话存储聚合导出 | skip:re-export | 0 |
| `storage/session-target.ts` | 会话 goal 与 run 生命周期 | goal 字段、active run 成对不变量、CAS、崩溃恢复截断时长 | 69 |
| `storage/workspace-hook-trust-store.ts` | hook 信任 JSON 存储 | 三态读取、fail-closed、文件锁/原子替换、Windows rename 重试、stale 回收 | 87 |
| `storage/fs-fault-injection.ts` | E2E 文件系统故障注入 | 规则字段、测试环境门禁、errno 形状、maxMatches/reset | 44 |
| `storage/session-store/codecs.ts` | DB 行 ↔ 领域对象 | 可空列→undefined、旧字段投影、主键覆盖 data 内 id | 42 |
| `storage/session-store/errors.ts` | 迁移错误类型 | kind 分支而非文本解析、cause 保留、name 固定 | 16 |
| `storage/session-store/json.ts` | JSON 列编解码 | NULL/空串统一为缺席、parse 不吞错 | 11 |
| `storage/session-store/options.ts` | store 选项/调试计数 | 测试钩子禁止生产、各表计数口径 | 12 |
| `storage/session-store/paths.ts` | 默认库路径 | 用户级固定路径、不随 cwd 漂移 | 10 |
| `storage/session-store/rows.ts` | 表行类型 | 逐字段口径、sequence 可空、epoch ms | 50 |
| `storage/session-store/migration-runner.ts` | WAL/启动锁/单事务迁移执行 | 四道保护、进度协议、busy 退避、备份跳过告警、rollback 唯一收口 | 0（基线已含 L2） |
| `storage/session-store/migrations.ts` | 冻结迁移清单与 SQL | 迁移不可变、追加式演进、checksum 契约 | 0（基线已含 L2） |
| `storage/session-store/sqlite-session-store.ts` | SQLite 会话存储门面 | 连接/事务边界、WAL、begin immediate、仓储委派 | 0（基线已含 L2） |
| `storage/session-store/migrations/0020-provider-model-selection.ts` | 模型选择结构迁移 | 冻结 SQL、builtin 映射、坏 JSON 跳过、幂等 entry id | 20 |
| `storage/session-store/migrations/0021-official-glm-selection.ts` | GLM 模型名归一 | 冻结白名单、只改当前选择、未知模型保留 | 10 |
| `storage/session-store/migrations/0022-backfilled-session-reasoning.ts` | 回填 reasoningLevel | 只补未动过的会话、身份严格对齐、单字段写入 | 16 |
| `storage/session-store/repositories/sessions.ts` | 会话元数据 | 局部更新、软删除幂等、legacy workspace 认领/路径自愈 CAS | 56 |
| `storage/session-store/repositories/messages.ts` | message/part | sequence 保留、legacy 快照、排序兼容 NULL | 42 |
| `storage/session-store/repositories/session-inputs.ts` | 输入账本 admitted 生命周期 | promotion 同事务、单向迁移、队列编辑 durable intent | 58 |
| `storage/session-store/repositories/session-entries.ts` | 会话事件流 | 局部 merge modelSelection、undefined 写显式 null | 21 |
| `storage/session-store/repositories/todos.ts` | 会话待办 | 全量替换、delete+insert 同事务、position 连续 | 16 |
| `storage/session-store/repositories/usage.ts` | 模型/轮次/工具用量 | 30 天裁剪、coalesce 保终态、task input compact 基线 | 54 |
| `storage/session-store/repositories/input-history.ts` | 输入历史 | 100 条上限、去重、丢弃内联 data URL | 30 |
| `storage/session-store/repositories/local-settings.ts` | 项目权限/协作模式 | 新位置优先旧表回退、非法模式返回 null、写后必读 | 25 |
| `storage/session-store/repositories/permission-full-access.ts` | full access 原子授权 | execution+receipt 同事务、receipt 幂等、只改 admitted | 20 |
| `storage/session-store/repositories/debug.ts` | 只读调试统计 | 迁移 id、按会话过滤、全局表不过滤 | 13 |
| `storage/session-store/repositories/script-workflow-runs.ts` | 脚本定义与运行 | 写后必读、upsert 保留 created、scope/enabled 缺省 | 35 |
| `storage/session-store/repositories/script-workflow-activities.ts` | activity/event/task link | attempt=MAX+1、event sequence 单调、缓存只认成功且 hash 一致 | 45 |
| `storage/session-store/repositories/script-workflow-codecs.ts` | workflow 行解码 | 逐字段口径、0/1 严格转 boolean、NULL→undefined | 37 |
| `storage/session-store/repositories/dwf-journal.ts` | JournalStorePort SQLite 实现 | 端口同步性、UPDATE 0 行 throw、NULL 即缺席 | 49 |
| `storage/session-store/repositories/dwf-journal-artifacts.ts` | 产物读面 | 版本按插入序、artifact_id NULL 排除、分页 hasMore | 8 |
| `storage/session-store/repositories/dwf-journal-fields.ts` | 字段投影读 | 路径候选 2^k、coalesce 首命中、SQL 内截短 | 7 |
| `storage/session-store/repositories/dwf-journal-pages.ts` | 事件按条数+字节分页 | 页为前缀、首行必进、惰性读载荷 | 11 |
| `storage/session-store/repositories/dwf-journal-reads.ts` | node/actor/event 读 SQL | 列裁剪 NULL 占位、limit=-1 不限、count/sum 为 0 | 14 |
| `storage/session-store/repositories/dwf-journal-introspection.ts` | run 内省读面 | limit 必填、cwd 可选、缺失端 undefined | 14 |
| `storage/session-store/repositories/dwf-journal-codecs.ts` | dwf 行 ↔ 记录映射 | 物理/逻辑状态映射唯一来源、NULL 不写键 | 7 |

### fs / http / image / logging / mailbox / pdf / workflow

| 路径 | 职责 | 注释主题 | +行数 |
|---|---|---|---:|
| `fs/index.ts` | FileSystemPort Node 实现 | 绝对路径门禁、revision CAS、原子写/拒绝写穿链接、ripgrep→JS 降级、错误归一 | 258 |
| `fs/text-metadata.ts` | 编码探测/编解码/换行归一 | BOM/UTF-8/GB 往返校验、无损编码校验、CRLF 口径 | 73 |
| `fs/text-range-reader.ts` | 按行范围读取 | 10MB 快路径/流式慢路径、只保留目标行、4KB 头部探测 | 41 |
| `http/index.ts` | HttpClientPort Node 实现 | fetch/node:http 选择、超时与取消分类、public egress DNS 校验复用、正文上限 | 99 |
| `http/public-egress-policy.ts` | 公网出口 DNS 校验 | 私网/保留段拒绝、两阶段防 DNS rebinding、egress_blocked | 42 |
| `http/response-body.ts` | 响应正文读取 | content-length 预检+流式累计、超限 cancel、无 body 空数组 | 25 |
| `image/index.ts` | ImageProcessorPort Jimp 实现 | 等比缩放、WebP 透传、取消检查点 | 34 |
| `image/image-budget.ts` | 图片预算 | 字节/base64/token 口径、非法参数 invalid_request | 40 |
| `image/jimp-compression.ts` | 压缩策略搜索 | 原图→格式内→缩小→JPEG→兜底、候选超限不抛、全失败 too_large | 74 |
| `image/jimp-media.ts` | 格式/取消工具 | Jimp 输出格式回退 png、mediaType 归一、取消语义 | 30 |
| `image/webp-passthrough.ts` | WebP 无转码直通 | 仅预算校验、超限 unsupported | 18 |
| `logging/index.ts` | JSONL 文件日志 | 级别过滤、context 合并、redactor、写失败唯一吞错点、stderr 旁路 | 59 |
| `logging/retention.ts` | 日志保留期清理 | 自然日口径、非日志名不动、ENOENT 等价成功、unref 定时器 | 49 |
| `logging/serialize.ts` | 日志序列化/脱敏 | key 名脱敏、错误 cause 链、深度/环引用、undefined 省略 | 52 |
| `mailbox/index.ts` | 文件系统 session 邮箱 | unread/read 原子 rename、坏 JSON 留 unread、路径越界双校验 | 38 |
| `pdf/index.ts` | Poppler PDF 适配器 | 临时目录生命周期、失败分类、可用性只缓存成功、并发探测单飞 | 72 |
| `workflow/index.ts` | 工作流定义/运行态存储 | 快照 temp+rename、JSONL 原子 append、索引非事务、路径白名单 | 156 |

### commands / context / skills

| 路径 | 职责 | 注释主题 | +行数 |
|---|---|---|---:|
| `commands/index.ts` | 自定义 .md 命令发现/读取 | root 优先级、同名先到先得、frontmatter、100KB 截断、诊断降级 | 59 |
| `commands/roots.ts` | 命令搜索根解析 | extra→用户→项目链→额外目录、priority 步长、~ 展开 | 57 |
| `context/index.ts` | 会话启动上下文采集 | 指令文件去重/拼接、100KB 读取上限、best-effort 诊断、项目类型探测 | 87 |
| `context/git-snapshot.ts` | 只读 git 快照 | --no-optional-locks、失败清空输出、3s/1MB 上限、主分支探测 | 35 |
| `skills/index.ts` | SKILL.md 发现/解析/读取 | 路径身份去重、plugin 不跟随 symlink、realpath 禁用比对、frontmatter 块标量 | 91 |
| `skills/roots.ts` | 技能搜索根解析 | 与 commands 同构、.zcode/.agents 合并、priority | 47 |
| `skills/scan.ts` | 技能文件扫描 | 同步/异步契约、只吞 ENOENT/非目录 | 1 |
| `tools/index.ts` | 占位导出 | skip:无逻辑 | 0 |

### mcp

| 路径 | 职责 | 注释主题 | +行数 |
|---|---|---|---:|
| `mcp/descriptor.ts` | MCP 工具描述符归一化 | `mcp__server__tool` 命名空间、schema 兜底、超时夹取 | 49 |
| `mcp/index.ts` | MCP 适配器主实现与连接编排 | generation fencing、OAuth Phase2→1、进程树/遥测、日志脱敏 | 300 |
| `mcp/network.ts` | stdio env 与代理/CA fetch | ZCode 变量清洗、PATH 前置 Node、禁止网络采集 | 44 |
| `mcp/oauth-credentials.ts` | 凭据存储与派生 | canonical/legacy 原子 pair、CAS、generation、兼容交错 | 68 |
| `mcp/oauth-errors.ts` | OAuth 失败品牌与分类 | 两类失败互斥、稳定 code、只认品牌 | 53 |
| `mcp/oauth-interactive.ts` | Phase 2 交互授权 | lease 选主、fresh DCR、原子发布、callback 路径/脱敏 | 72 |
| `mcp/oauth-lease.ts` | 跨进程授权 lease | 选主预算、attemptId CAS、pending TTL | 49 |
| `mcp/oauth-provider.ts` | Phase 1 运行期 token provider | 临期刷新、401 走锁、不实现 SDK auth() | 23 |
| `mcp/oauth-refresh.ts` | 跨进程 token 刷新 | 单飞文件锁、fail-soft、invalid_grant 分支 | 52 |
| `mcp/oauth-shared.ts` | discovery 缓存 | TTL、issuer 校验、兼容存储布局 | 32 |
| `mcp/oauth.ts` | legacy authorization_code provider | SDK 兼容 seam、keyPrefix、条件失效 | 106 |
| `mcp/official-auth.ts` | 官方 MCP 逐请求鉴权 | fail-closed origin、失败分类、只重试一次、日志无 header 值 | 29 |
| `mcp/pool.ts` | 连接池与 lease | 引用计数、idle grace、revalidate 单飞、连接键稳定序列化 | 150 |
| `mcp/process-tree.ts` | 进程树回收 | Windows taskkill、POSIX 三阶段信号、去环/超时 | 52 |
| `mcp/resource-subscriptions.ts` | 资源订阅计数 | 0→1/1→0 触发 subscribe、前缀清理 | 14 |
| `mcp/resource-telemetry.ts` | 进程 CPU/RSS 采样 | 定时器 unref、generation 丢弃迟到结果、CPU 基线 | 45 |
| `mcp/stdio-transport.ts` | 进程树感知 stdio transport | `_meta` 合并、Job Object、`_dispose` 回收顺序 | 59 |
| `mcp/telemetry.ts` | 遥测 tracker | HMAC 匿名 mcpId、owner/orphan、旁路吞错 | 81 |
| `mcp/timeout.ts` | deadline 与超时包装 | 绝对截止、只限制 waiter、定时器清理 | 45 |
| `mcp/windows-job-object.ts` | Windows Job Object 托管 | KILL_ON_JOB_CLOSE、加载失败降级、句柄幂等 | 45 |

### model

| 路径 | 职责 | 注释主题 | +行数 |
|---|---|---|---:|
| `model/index.ts` | 模型适配聚合导出 | skip:re-export | 0 |
| `model/model.ts` | 模型能力/元数据 | 字段口径与不变量 | 68 |
| `model/model-execution.ts` | AI SDK 模型执行装配 | binding/fetch 链、业务错误、捕获顺序 | 171 |
| `model/model-option-map-fetch.ts` | option 映射请求 patch | raw body 捕获 | 23 |
| `model/model-request-headers.ts` | 请求头合并/清理 | 鉴权与来源头优先级 | 20 |
| `model/account-request-retry.ts` | 账号/项目 token 刷新重试 | attempt 额外预算与幂等 claim | 41 |
| `model/anthropic-reasoning-metadata.ts` | Anthropic reasoning 元数据 | 字段口径与降级 | 17 |
| `model/anthropic-request-metadata.ts` | Anthropic metadata/userId | 脱敏与来源 | 22 |
| `model/anthropic-stream-compat.ts` | Anthropic SSE 兼容层 | 帧解析与事件边界 | 91 |
| `model/empty-completion-retry.ts` | 空完成重试 | 可重试条件与退避 | 24 |
| `model/errors.ts` | adapters 错误类型 | 错误分类与包装 | 19 |
| `model/failure-ai-sdk-provider-error.ts` | AI SDK provider 错误提取 | 归一化与兜底 | 12 |
| `model/failure-classifier.ts` | 模型失败分类 | reason/retryable 判定 | 68 |
| `model/failure-inspection.ts` | 失败结构读取 | 错层解包与状态提取 | 84 |
| `model/failure-provider-business-codes.ts` | 业务码语义表 | 码值与重试映射 | 36 |
| `model/failure-tls.ts` | TLS 失败归一化 | 证书错误识别 | 21 |
| `model/media-transform-policy.ts` | 媒体转换策略 | 能力与降级 | 17 |
| `model/official-coding-plan-gateway.ts` | 官方 Coding Plan 网关 | 路由与鉴权 | 15 |
| `model/off-peak-request-auth.ts` | off-peak 请求鉴权 | 账号模式 | 18 |
| `model/offpeak-retry.ts` | off-peak 失败决策 | 排队/票据过期 | 6 |
| `model/openai-responses-json-compat.ts` | Responses JSON 兼容 | 请求/响应整形 | 21 |
| `model/opencode-session.ts` | opencode 会话适配 | 会话字段与副作用 | 13 |
| `model/provider-endpoint-routing-fetch.ts` | 端点路由 fetch | 按请求路由 | 35 |
| `model/provider-endpoint-routing-options.ts` | 端点路由选项 | 字段口径 | 13 |
| `model/provider-finish-business-error.ts` | finish 中隐藏业务错误 | HTTP 200 空流识别 | 49 |
| `model/reasoning-history-normalization.ts` | reasoning 历史签名修复 | 只改请求副本 | 78 |
| `model/request-admission.ts` | 进程级准入票据 | 借还/幂等 | 10 |
| `model/request-observations.ts` | 请求观测 | 状态与脱敏 | 22 |
| `model/request-security.ts` | 请求安全状态端口 | 传输保护 | 15 |
| `model/retry-budget.ts` | 重试预算 | 上限/无限档位 | 12 |
| `model/retry-policy.ts` | 重试策略 | 次数与退避 | 26 |
| `model/runner.ts` | 模型运行总装配 | 链路编排与副作用 | 88 |
| `model/runner-attribution.ts` | 站点/版本归因 | 头合并 | 23 |
| `model/runner-debug.ts` | model I/O 诊断落盘 | 脱敏/压缩/容量/限时 | 130 |
| `model/runner-debug-redaction.ts` | model-io 脱敏 | 密钥/JWT 清理 | 27 |
| `model/runner-diagnostics.ts` | 流诊断与空完成判定 | chunk 累计/四条件 | 93 |
| `model/runner-generate.ts` | 非流式运行 | attempt 与终态 | 35 |
| `model/runner-network-headers.ts` | 网络头脱敏 | 白名单 | 18 |
| `model/runner-normalization.ts` | 用量/工具/来源归一化 | 口径与空值 | 46 |
| `model/runner-options.ts` | stream/generate options | 组装顺序与默认值 | 69 |
| `model/runner-record.ts` | 记录字段读取 | 类型守卫 | 20 |
| `model/runner-retry.ts` | 重试工具 | 延迟/取消/包装 | 69 |
| `model/runner-runtime.ts` | 运行时接口契约 | 类型字段 | 16 |
| `model/runner-runtime-headers.ts` | 运行时模型/头刷新 | 失败语义 | 21 |
| `model/runner-status.ts` | 状态/遥测发布 | 事件口径 | 65 |
| `model/runner-stream.ts` | 流式 attempt 循环 | 重试边界/准入/清理 | 89 |
| `model/runner-telemetry.ts` | 失败遥测字段 | 阶段与错误字段 | 32 |
| `model/stream-idle-timeout.ts` | 流 idle timeout | 计时/中止/重试加时 | 35 |
| `model/stream-retry-boundary.ts` | SSE 重试边界 | 前奏判定 | 15 |
| `model/streaming-tool-call-assembler.ts` | 流式工具调用组装 | 增量与快照 | 31 |
| `model/strict-tool-schema.ts` | 严格工具 schema | 兼容与降级 | 12 |
| `model/system-message-compat.ts` | system 消息兼容 | 角色映射 | 14 |
| `model/tool-call-validation.ts` | 工具调用校验 | 名称/输入校验 | 16 |
| `model/tool-input-normalization.ts` | 工具输入归一化 | JSON 修复 | 20 |
| `model/tool-result-media-projection.ts` | 工具结果媒体投影 | 媒体字段口径 | 53 |
| `model/tool-search.ts` | 工具搜索 | 匹配与截断 | 19 |
| `model/tool-transform.ts` | 工具契约转换 | schema 映射 | 61 |
| `model/transform.ts` | provider 消息转换 | 角色/内容映射 | 57 |
| `model/workflow-model-failure-policy.ts` | workflow 失败策略 | 确定性错误不重试 | 10 |
| `model/request-security-edition/index.ts` | 安全状态工厂 | 执行上下文 | 13 |
| `model/request-security-edition/recovery.ts` | 安全恢复 | 拒绝/空流恢复 | 27 |
| `model/endpoint-routing-edition/index.ts` | 端点路由工厂 | 选路与回退 | 13 |

### exec / browser / device / network

| 路径 | 职责 | 注释主题 | +行数 |
|---|---|---|---:|
| `exec/index.ts` | 执行适配聚合导出 | skip:re-export | 0 |
| `exec/bash-file-output.ts` | Bash 合并输出落盘/轮询 | 生命周期/预算/丢读诊断 | 24 |
| `exec/bash-output-policy.ts` | Bash 输出长度上限 | 优先级/硬上限/非法值降级 | 15 |
| `exec/bash-output-preview.ts` | Bash 输出预览截取 | 行数常量/估算标记 | 13 |
| `exec/bash-progress-poller.ts` | Bash 输出进度订阅 | 订阅者/轮询分组 | 12 |
| `exec/bash-resource-telemetry.ts` | Bash 资源遥测收尾 | 幂等 finish/选项口径 | 13 |
| `exec/bash-shell-provider.ts` | Bash shell 选择 | 平台差异/解析优先级/候选检查 | 41 |
| `exec/bash-startup-script.ts` | Bash 启动脚本/source 注入 | 引用相等/平台支持 | 27 |
| `exec/cwd-capture.ts` | 执行后 cwd 回读 | 捕获/规范化 | 13 |
| `exec/embedded-search-prelude.ts` | find/grep/rg 注入 bfs/ugrep | shell 函数生成/路径处理 | 23 |
| `exec/execution-adapter-types.ts` | 执行适配器内部类型 | 状态/回调/预算字段口径 | 50 |
| `exec/execution-command.ts` | 命令/spawn 解析与 env | 登录 shell/cmd 转义/跨平台 | 38 |
| `exec/execution-utils.ts` | 执行常量与工具 | 阈值/路径清洗/超时格式 | 18 |
| `exec/node-execution-adapter-base.ts` | 适配器基类 | 快照/关闭不变量 | 38 |
| `exec/node-execution-adapter-lifecycle.ts` | 后台任务与超时转后台 | 状态机/后台不回读 cwd | 36 |
| `exec/node-execution-adapter-process.ts` | spawn/管道/进程树终止 | 杀树/EPIPE/排空时序 | 33 |
| `exec/node-execution-adapter-results.ts` | 结果装配 | 截断/后台归一/退出码 | 26 |
| `exec/node-execution-adapter-run.ts` | 单次执行主流程 | 预算/超时/取消/结果组装 | 41 |
| `exec/node-execution-adapter.ts` | 公开入口 | 工厂与导出职责 | 9 |
| `exec/output-collector.ts` | 输出聚合与持久化预算 | 状态机/尾缓冲/限额通知 | 34 |
| `exec/outputEncoding.ts` | 输出编码探测/流式解码 | UTF-8 优先/Windows 代码页回退 | 31 |
| `exec/process-tree.ts` | POSIX 进程树回收 | 两阶段 SIGTERM→SIGKILL/BFS | 16 |
| `exec/shell-init-snapshot.ts` | shell 初始化快照 | 哈希命名/stale 清理/重校验 | 45 |
| `exec/windows-executable.ts` | Windows 可执行解析 | PATHEXT/相对路径 | 13 |
| `browser/descriptor.ts` | 托管 CDP 描述符 | 能力覆盖 | 10 |
| `browser/executable.ts` | 浏览器可执行发现/校验 | 平台路径/可用性 | 17 |
| `browser/index.ts` | 浏览器运行时 | 后端 generation/关闭时序 | 49 |
| `browser/page-command.ts` | 页面命令执行 | ref 解析/URL 白名单 | 27 |
| `browser/playwright-command.ts` | Playwright 动作 | 超时/locator/下载 | 28 |
| `browser/request.ts` | 请求分类与取消 | abort 竞争/错误分类 | 14 |
| `browser/session.ts` | BrowserContext/tab | ref 映射/对话框/视口 | 28 |
| `browser/snapshot.ts` | 页面快照/ref 解析 | 采集上限/WeakMap 生命周期 | 33 |
| `device/cli-device-mid.ts` | deviceMid 生成/持久化 | 原子写/锁/stale/fallback | 34 |
| `device/process-probe-darwin.ts` | macOS ps 采样 | BSD cputime/列对齐 | 20 |
| `device/process-probe-linux.ts` | Linux /proc 采样 | 两遍读取/分批超时 | 20 |
| `device/process-probe-shared.ts` | 探针共享契约 | 树展开/命令执行/退出码归一 | 19 |
| `device/process-probe-windows.ts` | Windows tasklist 采样 | CSV 解析/字段缺失 | 13 |
| `device/process-probe.ts` | 探针门面 | 平台分派/连续失败停用 | 16 |
| `network/http-config.ts` | 代理/NO_PROXY/CA 解析 | 优先级/模式匹配/容错 | 69 |
| `network/incoming-response.ts` | IncomingMessage→Response | 非标准状态码/无正文状态 | 19 |
| `network/proxy-fetch.ts` | 代理感知 fetch | Agent/abort/单次结算 | 47 |
| `network/subprocess-env.ts` | 子进程网络出口 env | 大小写/透传/CA | 46 |

### plugins / auth / config / conversation-recording

| 路径 | 职责 | 注释主题 | +行数 |
|---|---|---|---:|
| `plugins/atomic-directory.ts` | 目录原子替换/回滚 | staging+backup+marker、owner 存活、提交点 | 80 |
| `plugins/github-archive-source.ts` | GitHub zipball 源物化 | Archive→Git 回退、submodule/LFS、resolveInside | 48 |
| `plugins/helpers.ts` | 路径/ID 清洗与清理 | resolveInside、best-effort cleanup | 37 |
| `plugins/hook-sources.ts` | 插件 hook 来源枚举 | hooks.json/manifest 优先级、realpath | 28 |
| `plugins/index.ts` | 插件发现与运行时装配 | 候选优先级、id 唯一、hook/MCP 失败降级 | 116 |
| `plugins/markdown-frontmatter.ts` | frontmatter 解析 | block scalar/标量类型/空白 | 33 |
| `plugins/marketplace.ts` | 市场注册/拉取/安装/校验 | 事务提交回滚、依赖闭包、来源安全、诊断映射 | 339 |
| `plugins/mcp-official-auth.ts` | 官方 MCP 鉴权解析 | 互斥校验、isRecord 口径 | 19 |
| `plugins/mcp.ts` | 插件 MCP 定义发现/变量展开 | 变量 sink 分级、命名空间、鉴权 provenance | 60 |
| `plugins/official-marketplace.ts` | 官方市场分片读写 | bundled/CDN、strict manifest、路径分区 | 50 |
| `plugins/plugin-components.ts` | 内联 hook 组件收集 | 失败跳过原因、事件归一 | 25 |
| `plugins/source-errors.ts` | 插件源错误/诊断码 | 分类、诊断文本脱敏 | 29 |
| `plugins/types.ts` | 插件候选/加载类型 | source/trust/scope 口径 | 30 |
| `plugins/ui-surfaces.ts` | ui.surfaces 解析 | 非法项丢弃、server 命名 | 31 |
| `plugins/version-compare.ts` | 插件版本比较 | semver/sha/更新判定 | 26 |
| `plugins/zip-source.ts` | zip 下载/校验/安全解压 | https/loopback、zip-slip、大小/条目上限 | 89 |
| `auth/index.ts` | 鉴权聚合导出 | skip:re-export | 0 |
| `auth/bigmodel-oauth.ts` | BigModel 授权码换 token | 换取流程、失败口径 | 42 |
| `auth/browser.ts` | 打开浏览器授权页 | 平台命令、失败降级 | 38 |
| `auth/cli-oauth.ts` | CLI 设备码 OAuth | init/poll、state 校验、超时 | 82 |
| `auth/coding-plan-api-key.ts` | Coding Plan PAT 换证 | JWT 单飞、401 重试、代际失效 | 64 |
| `auth/credential-cipher.ts` | 凭据 AES-256-GCM | 密钥派生、enc:v1、fail closed | 41 |
| `auth/localhost-callback.ts` | 本地 OAuth 回调监听 | state 校验、拒绝立即 settle | 43 |
| `auth/shared-credentials.ts` | 共享凭据文件读写 | 文件锁、原子替换、损坏备份 | 109 |
| `auth/zai-business-token-cache.ts` | zai 业务 JWT 缓存 | 单飞、generation、失效重取 | 43 |
| `config/config-factory.ts` | 配置装配入口 | 层级合并顺序、hooks 候选 | 79 |
| `config/config-merger.ts` | 多来源配置合并 | 优先级、plugins/hooks 合并 | 36 |
| `config/env-config.adapter.ts` | ZCODE_* 环境变量解析 | 类型转换、工具并发 | 27 |
| `config/file-config.adapter.ts` | config.json 读写/迁移 | 原子写、旧版迁移、损坏容错 | 112 |
| `config/index.ts` | 配置模块导出与工厂 | 装配顺序、默认值 | 61 |
| `config/project-config.adapter.ts` | 项目配置加载 | 根→cwd、显式路径、hooks 信任旁路 | 61 |
| `config/schema.ts` | 配置 schema 校验 | 字段口径、默认值、严格性 | 83 |
| `conversation-recording/index.ts` | 录制聚合导出 | skip:re-export | 0 |
| `conversation-recording/capture.ts` | fetch 旁路录制 | clone/后台读响应、错误序列化 | 66 |
| `conversation-recording/contract.example.ts` | 录制契约示例 | 示例字段口径 | 12 |
| `conversation-recording/contract.ts` | 录制记录类型 | 逐字段语义、可空含义 | 44 |
| `conversation-recording/module.ts` | 录制模块清单 | 导出面说明 | 12 |
| `conversation-recording/recorder.ts` | JSONL 串行落盘 | 写入队列、session 分目录、失败只 warn | 36 |

### provider

| 路径 | 职责 | 注释主题 | +行数 |
|---|---|---|---:|
| `provider/index.ts` | 空导出占位 | skip:无逻辑 | 0 |

## 关键发现（重点为迁移失败回滚与备份）

1. **迁移只有一个 rollback 收口**：`runSqliteSessionMigrationsAsync` 的 catch 在 `db.isTransaction` 时执行一次 `rollback`（失败也吞掉以保留首个错误），随后按 checksum/其他错误归一为 `SqliteSessionMigrationError`；`begin immediate` 后全量迁移在同事务内，失败不会留下半升级。备份发生在每个迁移应用前，写入 `dataRoot/backup`；备份失败不阻断迁移，只 `process.emitWarning(ZCODE_MIGRATION_BACKUP_SKIPPED)`，因此备份缺失必须靠外部监控。
2. **WAL 与启动锁是硬门槛**：非 `:memory:` 且 journal mode 不是 WAL 直接启动失败；`SQLITE_BUSY` 不立即失败，在 deadline（默认 5s）内 10ms→200ms 指数退避，超时才 `lockTimeoutError`，避免两进程同时升级。
3. **checksum 只允许追加**：已应用迁移的 SQL 被记账校验，历史迁移被改动/顺序变化即 `checksum_mismatch` 启动失败；0020/0021/0022 只导出冻结 SQL，坏 JSON 行用 `json_valid/json_type` 条件跳过，不阻断启动。
4. **session input 的 promotion 是单事务原子迁移**：user message、parts、shared context 与账本 `admitted→promoted` 在同一 `begin immediate` 内；任何异常回滚后账本仍为 admitted 可重试，杜绝“队列已消费但 transcript 无 user message”。
5. **多进程写同一状态目录有明确取舍**：workflow 的 run.json/index.json 是两次独立原子写（非同一事务，可能“快照新、索引旧”）；事件/图用 JSONL append 依赖 OS 原子追加；插件目录替换用 staging+backup+marker 并在提交点后才 finalize，authority 写失败时选择 finalize 而非回退，避免跨代状态。
