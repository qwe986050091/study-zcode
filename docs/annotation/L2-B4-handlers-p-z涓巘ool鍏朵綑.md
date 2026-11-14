# L2-B4：tool handlers p–z 与 tool 其余模块（逐文件密注索引）

> 批次范围：`apps/zcode-cli/packages/core/src/tool/` 下 114 个非测试文件。
> 1) `handlers/` 文件名首字母 **p–z**（53 个；a–o 属 L2-B3，本批次未触碰）；
> 2) `executor/` 下**未被 L1 认领**的文件（27 个；已由 L1 覆盖的 11 个文件未改动）；
> 3) `search/`（5）、`channel-reply/`（3）、`workflow-entrypoints/`（3）；
> 4) `tool/` 根目录非测试 `.ts`（23 个；`deferred-call.ts`、`scheduler.ts` 已由 L1 覆盖，按任务要求跳过）。
>
> 目标：导出函数/工具实现上方补"职责 + 输入输出口径 + 副作用 + 失败与降级语义 + 维护的不变量"，非平凡分支内部补"为什么"，关键字段补逐字段口径；保留并扩写原文件头，不改任何代码 token。

## 与大纲的对应

- 链路 2（工具执行器）：`turn.ts` → `turn-loop.ts` → `turn-model-step.ts` → `runtime/methods/tools.ts` → `executor/batch-runner.ts` → `executor/call-runner.ts` → handlers → `result-serialization.ts` / `result-display.ts` → `tool-result-settlement.ts`。
- 链路 3（结果序列化与展示）：`originalBytes` / `returnedBytes` 预算账本、display 投影与 artifact 落盘边界。
- 链路 10（MCP / 延迟工具 / CUA）：`DeferredToolCall` 准入解析、`ToolSearch` 暴露状态机、CUA 媒体计入预算。
- 跨链路不变量总表（大纲第六节）：tool_call 与结果必须配对、ToolPart 不得停在 pending/running；预算取 `min(maxModelBytes, maxInlineBytes)` 且 `returnedBytes` 为真实发给模型的字节；权限只能收紧、hook 不能放宽 deny；一个 runtime 同时只有一个 active turn；CUA 无法 attest 时 fail closed。

## 校验结论

- 基线目录：`d:\code\_annot_baseline\L2-B4\`（保持相对路径的完整副本）。
- 逐文件 `git --no-pager diff --no-index --numstat 基线 目标` 全部执行：**删除列 = 0**（113 个文件有新增，1 个文件 `executor/permission-responder-race.ts` 已是完整注释样板、保持 +0/−0）。
- 总新增 **4454 行**；新增行中除 `//`、`/*`、`*` 与空行外无任何代码行。
- 注释后仍无文件超过 800 行（最大 `handlers/read.ts` 643 行）。

## handlers p–z（53）

| 文件 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `handlers/plan-mode.ts` | PlanMode 工具：进入/退出计划模式并产出可评审计划 | 模式切换的状态归属、只读约束、退出条件与失败降级 | +120 |
| `handlers/plan-mode-prompts.ts` | 计划模式的提示词与交互文案片段 | 文案与真实校验点一致、模式差异只在文案层 | +34 |
| `handlers/read.ts` | Read 工具分派入口：按 image → video → PDF → text 依次判定 | 分派顺序不可交换、PDF 需模型能力门、文本 256KB 上限只对整文件读生效 | +111 |
| `handlers/read-image.ts` | 图片读取：媒体编码、尺寸/体积约束 | 媒体计入结果预算、超限时落 artifact 的边界 | +53 |
| `handlers/read-pdf.ts` | PDF 读取：页范围、文本抽取与能力门 | `cancelled` 刻意留 undefined、截断语义与普通错误分离 | +133 |
| `handlers/read-session-context.ts` | 读取跨 session 的上下文/产物 | 可见性边界、缺失时的降级返回、不泄露其他会话 | +125 |
| `handlers/read-text.ts` | 文本读取：offset/limit、行号、编码与 truncation | 行号前缀与 read-before-edit、`isPartialView` 只由 token cap 决定 | +114 |
| `handlers/read-video.ts` | 视频读取：能力检测与占位返回 | 不支持时明确降级，不伪造内容 | +23 |
| `handlers/reply-to-channel.ts` | ReplyToChannel：向频道回复消息 | 频道寻址、失败走结构化结果、副作用范围 | +57 |
| `handlers/resolve-workflow-question.ts` | 回答工作流运行中挂起的问题 | 不 throw 业务性拒绝、判别键是 message 前缀 | +27 |
| `handlers/respond-to-coordinator.ts` | 向协调者回报（subagent 专属端口） | fail closed：非 subagent/端口缺失直接抛 ConfigurationError | +68 |
| `handlers/resume-workflow-run.ts` | 恢复已暂停的工作流运行 | 恢复前置条件、终态判定、失败保留可操作文案 | +34 |
| `handlers/save-workflow.ts` | SaveWorkflow：保存工作流脚本与图 | `overwritten` 必须写盘时重判（hook 可改入参）、预算为全局静态值 | +40 |
| `handlers/save-workflow-description.ts` | 生成 SaveWorkflow 的工具描述文案 | 描述与真实写入字段一致 | +15 |
| `handlers/send-message.ts` | 发送消息到会话/频道 | 目标解析、消息落点、失败语义 | +44 |
| `handlers/skill.ts` | Skill 加载与执行入口 | 全局静态预算、per-skill 上限由 Port 在调用时收紧 | +33 |
| `handlers/submit-result.ts` | subagent 提交最终结果并结束本轮 | 结果与 tool_call 配对、提交后不可再调用 | +30 |
| `handlers/target.ts` | 目标（goal/queue）管理工具 | 目标状态归属、并发写入与幂等边界 | +35 |
| `handlers/task-output.ts` | TaskOutput：读取后台任务输出 | `notified` 置位顺序（投影成功 → 查 abort → 再标记）、字符与字节两套单位 | +119 |
| `handlers/task-output-bash.ts` | bash 后台任务输出的特化读取 | 退出码/终态与输出文件的关系、截断方向 | +60 |
| `handlers/task-output-projection.ts` | 把任务输出投影为模型可见内容 | 投影顺序、截断标记、artifact 引用 | +36 |
| `handlers/task-stop.ts` | TaskStop：终止后台任务 | 终态写入、已结束任务的幂等返回 | +44 |
| `handlers/todo.ts` | TodoWrite：维护会话待办 | 标 `readOnly:true` 但写 session 状态（readOnly 仅指无工作区副作用） | +43 |
| `handlers/tool-perf.ts` | 工具性能统计与查询 | 采样口径、统计窗口、只读 | +89 |
| `handlers/tool-search.ts` | ToolSearch：延迟工具的发现与加载入口 | 自身刻意不 `shouldDefer`，否则需先加载搜索器 | +28 |
| `handlers/webfetch.ts` | WebFetch 主入口：抓取网页并返回模型可用正文 | 每次调用必经 URL 校验、缓存键用入参原文、处理失败仍保留正文 | +123 |
| `handlers/webfetch-cache.ts` | WebFetch 响应缓存 | 缓存写在模型加工之前、键不做归一化 | +40 |
| `handlers/webfetch-constants.ts` | WebFetch 常量与上限 | 字符 vs 字节口径、可调边界集中处 | +54 |
| `handlers/webfetch-content.ts` | 正文提取与格式转换 | 提取失败保留原文、转换不改语义 | +60 |
| `handlers/webfetch-egress-guard.ts` | 出站地址防护：逐跳（含重定向）校验 | 还原 IPv4-mapped/NAT64 再判、redirect manual 保证策略在工具侧 | +58 |
| `handlers/webfetch-errors.ts` | 网络错误归一化与脱敏 | 剥离解析 IP 与 Retry-After 自由文本，避免内网信息泄露 | +26 |
| `handlers/webfetch-network.ts` | HTTP 抓取：超时、重定向、读取 | 跨主机重定向作为终态交回模型重新审批 | +96 |
| `handlers/webfetch-processing.ts` | 小模型加工（摘要/提取） | 失败不丢正文、加工结果与原始内容分离 | +43 |
| `handlers/webfetch-trace.ts` | WebFetch 的 trace 上报 | traceId 贯穿、失败不影响主流程 | +22 |
| `handlers/webfetch-types.ts` | WebFetch 类型契约 | 字段逐项口径与可选性 | +47 |
| `handlers/webfetch-url.ts` | URL 校验与归一化 | 协议/凭据/主机校验、缓存键保留原文 | +65 |
| `handlers/websearch.ts` | WebSearch 主入口 | 查询校验、结果上限、失败降级 | +54 |
| `handlers/websearch-results.ts` | 搜索结果整形与引用编号 | 编号稳定性、去重与截断 | +65 |
| `handlers/websearch-support.ts` | 搜索辅助：能力检测与错误归类 | 不支持时明确报错 | +18 |
| `handlers/workflow.ts` | legacy Workflow 工具入口 | 与动态工作流（Create/Amend/Save/Eval）生命周期不共享 | +21 |
| `handlers/workflow-analysis-display.ts` | 工作流分析结果的展示投影 | 展示字段与持久化字段分离 | +8 |
| `handlers/workflow-description.ts` | 工作流描述生成 | 描述与脚本事实一致 | +9 |
| `handlers/workflow-draft-read-state.ts` | 工作流草稿的读取状态维护 | read-state 必须先于 metadata 更新 | +24 |
| `handlers/workflow-drafts.ts` | 工作流草稿管理 | 草稿生命周期与落盘边界 | +11 |
| `handlers/workflow-path-source.ts` | 工作流/脚本的路径来源解析 | 来源优先级、相对路径基准 | +16 |
| `handlers/workflow-run-introspection.ts` | 工作流运行内省 | 运行态只读、终态判定 | +9 |
| `handlers/workflow-script-analysis.ts` | 脚本静态分析 | 分析失败不阻断主流程 | +7 |
| `handlers/workflow-script-models.ts` | 脚本模型调用与端口 | 端口缺席为不可恢复 | +21 |
| `handlers/workflow-script-notes.ts` | 脚本注释/备注生成 | 只读附加信息 | +4 |
| `handlers/workflow-script-path.ts` | 脚本路径解析 | 路径规范化与越界拒绝 | +5 |
| `handlers/workflow-settings-adjustment.ts` | 工作流设置调整 | off-peak 检查先于端口检查 | +19 |
| `handlers/workflow-skill-gate.ts` | 工作流 skill 门控 | 门控失败 fail closed | +12 |
| `handlers/write.ts` | Write 工具：创建/覆盖文件 | `originalFile` 真值判 update 会把空文件报成 create（反直觉但既有）、read-state 与 metadata 更新顺序 | +124 |

## executor（27，均未被 L1 认领）

| 文件 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `executor/approval-gate.ts` | 审批门：决定是否需要用户确认 | 规则 allow/deny 与 alwaysAsk 的优先级、只收紧不放宽 | +27 |
| `executor/background-task-output.ts` | 后台任务输出读取底层 | 私有 `isRecord` 包含数组（与 `utils.ts` 同名不同语义） | +42 |
| `executor/background-task-registry.ts` | 后台任务注册表与生命周期 | `notified` 只在重臂时复位、新生命必须走 register 以重盖分支代 | +66 |
| `executor/bash-result-display.ts` | bash 结果的 display 投影 | 150_000 是 display 独立预算、`TextDecoder({stream:true})` 防切多字节 | +18 |
| `executor/create-workflow-display.ts` | CreateWorkflow 的展示投影 | 展示字段来源与缺省 | +15 |
| `executor/display-text.ts` | 展示文本拼装工具 | 与模型内容口径分离 | +11 |
| `executor/events.ts` | 执行器事件发布 | `emitToolCallResult` 仅成功路径且 success 硬编码 true；失败必须走 error 事件 | +69 |
| `executor/impl.ts` | executor 实现装配 | 依赖注入边界、端口缺失的处理 | +39 |
| `executor/memory-file-permission.ts` | 记忆目录的权限收紧 | 仅收紧、不参与放宽；路径归一化后再判 | +43 |
| `executor/model-status-sink.ts` | 模型状态 sink | 事件准入与 toolCallId 过滤 | +16 |
| `executor/permission-capability.ts` | 权限能力判定 | 能力缺失时 fail closed | +24 |
| `executor/permission-input.ts` | 权限输入归一化 | 归一化后与审批载荷一致 | +17 |
| `executor/permission-input-adjustments.ts` | 授权后的入参调整 | 调整必须可审计、不得放宽权限 | +16 |
| `executor/permission-input-recheck.ts` | hook 改写入参后的权限重判 | 非 rule.project.ask 的 ask 返回 `{}` 会被上游按 allow 收口（反直觉） | +22 |
| `executor/permission-request.ts` | 权限请求的登记与发布 | 先登记后发布，取消优先于授权 | +28 |
| `executor/permission-response.ts` | 权限响应解释 | 响应种类与终态映射、未知响应不放行 | +30 |
| `executor/permission-rules.ts` | 权限规则匹配 | 匹配顺序、命中即停、deny 优先 | +21 |
| `executor/permission-rules-persistence.ts` | 授权后规则落盘 | 只在授权成功后写、失败不回滚已生效判定 | +26 |
| `executor/permission-suggestions.ts` | 权限建议生成 | 建议只是提示，不改变判定 | +18 |
| `executor/telemetry.ts` | 执行器遥测上报 | 采样字段与 traceId 关联、失败不影响执行 | +14 |
| `executor/timeout.ts` | ToolDeadline：工具超时与暂停 | 按 toolCallId 过滤准入事件、暂停期间不超时、重入计数取并集 | +55 |
| `executor/types.ts` | executor 层类型契约 | 字段逐项口径与可选性 | +59 |
| `executor/utils.ts` | executor 通用工具函数 | `isRecord` 排除数组 | +20 |
| `executor/workflow-artifact.ts` | 工作流产物落盘 | 产物与内联预算的边界 | +11 |
| `executor/workflow-observation-display.ts` | 工作流观察结果的展示投影 | 观察态与运行态字段分离、展示预算 | +43 |
| `executor/workflow-published-artifacts.ts` | 已发布产物的收集与暴露 | 只暴露已完成产物 | +14 |
| `executor/permission-responder-race.ts` | hook 与 broker 权限竞速：先到者定案、败者 abort | 已是完整注释样板，本批次保持 +0/−0（无可补缺口） | +0 |

## search / channel-reply / workflow-entrypoints（11）

| 文件 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `search/description.ts` | ToolSearch 的工具描述文案 | 描述与实际暴露规则一致 | +19 |
| `search/exposure.ts` | 工具暴露状态机：announced / listed / removed / readded | `removedNames` 要对照全量作用域；`readded ⊆ addedNames`；enabled=false 时 mode 回落 off | +85 |
| `search/history.ts` | 搜索历史与 visible/pending 双集合投影 | 并行 ToolSearch 需等下一条 assistant 边界才合入 visible；`loadedToolCallIds` 是结果外事实 | +51 |
| `search/local-projection.ts` | 本地工具目录投影 | 本地需 DeferredToolCall 在目录中才可控 | +22 |
| `search/search.ts` | 工具搜索实现与排序 | 匹配口径、结果上限与稳定顺序 | +37 |
| `channel-reply/contract.ts` | 频道回复契约定义 | 端口能力与输入输出声明 | +7 |
| `channel-reply/contract.example.ts` | 契约示例（无生产引用） | 示例与真实注册入口的区别 | +5 |
| `channel-reply/module.ts` | 频道回复模块装配 | 依赖注入边界 | +7 |
| `workflow-entrypoints/contract.ts` | 工作流入口契约定义 | 入口能力与失败语义 | +10 |
| `workflow-entrypoints/contract.example.ts` | 契约示例（无生产引用） | 示例不可当作注册入口 | +5 |
| `workflow-entrypoints/module.ts` | 工作流入口模块装配 | 装配顺序与端口必需性 | +5 |

## tool 根目录（23）

| 文件 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `bash-timeout-policy.ts` | bash 超时策略：默认值与上限、后台化衔接 | 超时单位、与工具元数据 timeout 的优先级 | +26 |
| `compat.ts` | 模型/客户端兼容性判定 | 不支持时的降级路径 | +18 |
| `diff.ts` | 文本 diff 生成 | 输出格式与截断边界 | +15 |
| `edit-matchers.ts` | 编辑匹配阶梯：精确 → 换行归一 → 去行号前缀等 | 宽松策略仅在 `replaceAll=false` 启用；`not_found`/`ambiguous` 语义；`actualString` 必须是真实片段 | +51 |
| `executor.ts` | executor 对外聚合入口 | 导出面即契约 | +3 |
| `index.ts` | tool 包对外导出入口 | 导出面稳定、不泄露内部实现 | +3 |
| `input-normalization.ts` | 执行入参归一化：JSON parse + runtime schema | 保留 runtime schema 错误、无 runtime schema 时直接放行 | +34 |
| `input-validation-model-content.ts` | 入参校验错误的模型可见投影 | JSON issues 提供结构、runtime issues 判断真实性；一对一配对不拼接；无 issue 时回退完整 JSON | +146 |
| `json-schema.ts` | 最小 JSON Schema 校验器 | `errors`（legacy 文案）与 `issues`（结构化）双输出且顺序不同；空 schema 视为无约束 | +29 |
| `model-contract.ts` | 模型能力契约 | 能力缺失时 fail closed / 明确降级 | +18 |
| `patch-apply.ts` | 补丁应用：两阶段（先全量验证再落盘） | 匹配四级容错、逆序 splice 防下标漂移、失败可诊断 | +53 |
| `patch-parser.ts` | 补丁解析 | 解析失败保留原文与行号 | +40 |
| `path-normalization.ts` | 工具路径归一化与比较键 | 只处理盘符别名/`\\?\`/NFC，故意不折叠大小写与 realpath | +23 |
| `path-policy.ts` | 工作区路径边界策略 | 越界拒绝、符号链接与 Windows 差异 | +21 |
| `provider-visible-order.ts` | 多工具结果的 provider 可见顺序 | 与 tool_call 配对、顺序稳定性 | +11 |
| `read-file-state.ts` | read-before-edit 事实来源 | 严格全读 vs 最新读两种查找口径；stale 由消费者用 mtime/revision/size 判 | +41 |
| `read-file-state-metadata.ts` | readFileState 的持久化元数据 | 持久化字段口径；`FillWorkflowHole` 解析白名单缺项（仅注释标注） | +46 |
| `registry.ts` | 工具注册表 | 同名覆盖并 warn、注册顺序决定 provider-visible 列表 | +27 |
| `result-persistence-format.ts` | 结果持久化格式 | 落盘格式与模型内容的差异 | +37 |
| `tool-input-validation-issues.ts` | 结构化入参错误 issue 构造器 | 字段顺序稳定、path 浅拷贝、可选字段按需出现 | +52 |
| `tool-visibility.ts` | 工具可见性判定 | readOnly/concurrentSafe/sideEffectScope 的真实语义 | +28 |
| `types.ts` | tool 层唯一契约：metadata/entry/result/batch | 4 条不变量：metadata 是调度与权限唯一依据；resolveInput 在 validate 后、hook 前；预算 min 口径；结果必须配对 | +121 |
| `webfetch-preapproved.ts` | WebFetch 预批准 URL 判定 | 只对原始入参判定、hostname 精确匹配、不校验 scheme/端口、重定向不重判 | +18 |

## 关键发现（详见各文件注释）

1. **`executor/events.ts` 的成败分流是配对不变量的最后一道闸**：`emitToolCallResult` 仅在成功路径调用且 payload 的 `success` 硬编码 true；registry miss、schema/语义校验失败、权限拒绝、handler 抛错都必须走 `emitToolCallError`，否则 ToolPart 停在 `inputStreaming`、模型收不到配对结果。
2. **后台任务通知的置位时机决定去重正确性**：`task-output.ts` 必须"投影成功 → 再查 abort → 才 markTaskNotified"；`background-task-registry.ts` 仅在 dwf 重臂时复位 `notified`，且新生命必须 `register()` 重盖分支代，否则 cancel → rewind → resume 后事件被 stale-branch fencing 丢弃。
3. **字符与字节在同一工具内混用**：TaskOutput 的 `maxModelChars` 是 UTF-16 字符，`RESULT_BUDGET_BYTES` 与 artifact 判定是字节；WebFetch 正文按 UTF-8 字节数对比字符上限但"截断 ⇒ 必已落盘"仍成立。混淆会绕过预算或误落 artifact。
4. **权限只能收紧**：`permission-input-recheck.ts` 对"非 `rule.project.ask` 且非记忆目录目标"的 ask 返回 `{}`，上游按 allow 收口（含 `tool.alwaysAsk`），属既有反直觉行为；`permission-request.ts` 先登记后发布、取消优先于授权。
5. **路径身份不做隐式归一化**：`path-normalization.ts` 故意不折叠大小写与 realpath，`C:\Repo` 与 `C:\repo` 会得到不同 `createReadFileStateKey`；这是测试明确锁定的取舍，改动会同时影响 read-before-edit 与权限匹配。
