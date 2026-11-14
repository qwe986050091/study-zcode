# L2-B3：tool handlers a–o（逐文件密注索引）

> 批次范围：`apps/zcode-cli/packages/core/src/tool/handlers/` 下文件名首字母 **a–o** 的全部非测试文件（75 个）；p–z 归另一批次。
> 目标：每个工具/模块上方补"工具语义 + schema 字段口径 + 副作用 + 权限校验点 + 失败语义"，非平凡分支内部补"为什么"，不解释字面，不改代码 token。

## 与大纲的对应

- 链路 2（tool_call → handler → tool_result）与链路 3（权限/审批/沙箱/结果序列化）。
- 第八节 handlers 清单；第十一节 V4 边界（`resultBudget`、`trace`、`shouldDefer`）。
- 阅读时同步对照 `tool/executor/`（`batch-runner.ts`、`call-runner.ts`、validation / hook-flow / permission-flow、result-serialization），本批次**未修改** executor 目录。
- 关键契约 `tool/types.ts`：`ToolMetadata`（readOnly/destructive/concurrentSafe/sideEffectScope/riskLevel/needsApproval/shouldDefer/alwaysLoad/maxOutputBytes/stopTurnOnSuccess）、`resultBudget`（maxInlineBytes/maxModelBytes/strategy/preview）、`timeout`、`cancellation`、`permission`（patternSources/alwaysAllowPatternSources/denyPriority）。

## 文件索引

| 文件 | 工具语义 | 注释主题 | +行数 |
| --- | --- | --- | --- |
| `agent.ts` | Agent 子代理启动（委托 subagent 执行一轮任务） | 入口声明口径（subagent_type/description/prompt/run_in_background）、readOnly=true + sideEffectScope=session、patternSources=input | +11 |
| `amend-workflow.ts` | AmendWorkflow：修改已有 workflow 的图/描述 | owner 免确认边界、图/描述变更的校验前置、失败语义 | +18 |
| `amend-workflow-description.ts` | 生成 AmendWorkflow 工具描述文案 | 描述与真实校验点的一致口径 | +4 |
| `amend-workflow-resolve.ts` | 把 id/name 解析成既有 workflow | 解析失败与歧义的返回值口径 | +7 |
| `amend-workflow-retune.ts` | 并发 retune 判定（何时可原地调整） | script/path/subagent_model/name 全缺席、前驱 pending/running、端口有 retuneConcurrency 才生效 | +2 |
| `amend-workflow-source.ts` | amend 后源码重组（阶段引用改写） | 引用完整性优先、`unphased` 改写口径 | +8 |
| `apply-patch.ts` | ApplyPatch：批量补丁应用 | 两阶段不变量（先全量验证再落盘）、move 非原子、recoverable 失败、Add File 先 stat | +33 |
| `ask-user-question.ts` | 向用户提问（答案由外部注入，handler 不发起交互） | 文件头扩写、双 schema（未回答/已回答）、部分作答分支 | +25 |
| `bash.ts` | Bash：shell 命令执行主入口 | captureCwdAfterSuccess 仅前台、outputLimit 30KB/persistOutput、sandbox、entry（readOnly 恒 false、maxOutputBytes 10MB vs resultBudget） | +14 |
| `bash-background-lifecycle.ts` | 后台任务启动/等待/终止的生命周期 | 状态机与终态、退出码归属 | +12 |
| `bash-background-policy.ts` | 后台化策略（explicit / auto_on_timeout） | 两种触发口径与转后台后的通知语义 | +8 |
| `bash-command-parser.ts` | shell 词法：管道/重定向/命令替换切分 | 重定向与命令替换必判写、解析失败按保守处理 | +21 |
| `bash-command-permission-policy.ts` | 命令级权限策略组合 | 规则来源优先级、deny 先于 ask | +17 |
| `bash-command-rule-evaluator.ts` | 权限规则匹配求值 | 匹配顺序与"命中即停"、未命中落默认 | +13 |
| `bash-cwd-policy.ts` | cwd 合法性与持久化 | 越界 cwd 拒绝、成功后 cwd 回写条件 | +12 |
| `bash-gh-rate-limit.ts` | 识别 gh 命令并给出限流约束 | 限流只影响提示/重试，不改判定 | +10 |
| `bash-git-runtime-safety.ts` | git 运行时安全（组合命令、联网子命令） | git + cd/pushd/popd 组合不安全、`git ls-remote` 判联网 | +18 |
| `bash-image-output.ts` | 从输出中提取图片 | 图片与文本预算分离、落 artifact 的边界 | +12 |
| `bash-metadata.ts` | 组装 Bash tool_call metadata | 字段来源与可省略键的口径 | +11 |
| `bash-model-content.ts` | Bash 结果转模型内容 | 输出投影顺序、错误/截断标记 | +16 |
| `bash-output.ts` | 输出截断与 artifact 持久化 | 30KB 内联阈值、截断时保留头尾的方向 | +14 |
| `bash-prompt.ts` | Bash 工具描述/prompt 片段 | 描述与真实校验点一致性 | +10 |
| `bash-read-file-sources.ts` | 从命令推断被读取的文件源 | 只识别可静态判定的读命令，其余不回填 | +18 |
| `bash-read-file-state.ts` | 成功后回填 readFileState | 错误/截断/后台/图片/中断时不回填 | +14 |
| `bash-readonly-policy.ts` | 只读判定入口（三值 true/false/undefined） | 三值语义、缺省即保守 | +7 |
| `bash-readonly-policy-argv.ts` | argv 级判定编排 | 判定顺序：git → 精确 argv → 多词前缀 | +19 |
| `bash-readonly-policy-argv-direct.ts` | 精确 argv 白名单 + 自定义文法 | docker 危险 flag、find 写能力（-delete/-exec/-fls…）、无法穷举即 false | +21 |
| `bash-readonly-policy-argv-flags.ts` | 通用 flag 表判定的 argv 编排 | 子命令选择与表命中顺序 | +19 |
| `bash-readonly-policy-argv-git.ts` | git argv 判定 | 位置参数语义、`branch/tag` 无 `--list` 即写 | +17 |
| `bash-readonly-policy-argv-io.ts` | I/O 类命令 argv 判定 | 读写方向判定与保守回退 | +19 |
| `bash-readonly-policy-callbacks.ts` | 各命令的危险性回调（docker/gh 等） | 回调 true 即不可读、回调在表校验之前 | +35 |
| `bash-readonly-policy-commands.ts` | 只读命令清单与前缀表 | 清单口径与新增命令的准入条件 | +8 |
| `bash-readonly-policy-flags.ts` | flag 判定入口/分发表 | 表的选取与"未列出即不安全" | +7 |
| `bash-readonly-policy-flags-file.ts` | 文件类命令安全 flag 表 | SafeFlagValue 逐项口径 | +14 |
| `bash-readonly-policy-flags-git.ts` | git 安全 flag 表 | 会写仓库/索引的 flag | +9 |
| `bash-readonly-policy-flags-process.ts` | 进程/网络类 flag 表（ps/ss/lsof…） | 位置参数与过滤表达式不可通用覆盖 | +9 |
| `bash-readonly-policy-flags-text.ts` | 文本处理类安全 flag 表 | `-i` 等就地写 flag | +10 |
| `bash-readonly-policy-git-callbacks.ts` | git 子命令危险性回调 | 回调与 flag 表的叠加顺序 | +19 |
| `bash-readonly-policy-git-subcommands-core.ts` | git 核心子命令只读性 | 逐子命令口径 | +13 |
| `bash-readonly-policy-git-subcommands-history.ts` | git 历史类子命令只读性 | log/show/reflog 等的写风险 | +10 |
| `bash-readonly-policy-multiword-core.ts` | 多词前缀核心命令判定 | 前缀长度与参数边界 | +11 |
| `bash-readonly-policy-multiword-gh.ts` | gh 多词前缀判定 | gh 子命令只读/联网口径 | +9 |
| `bash-readonly-policy-simple-commands.ts` | 简单命令只读判定 | 单词命令白名单与参数校验 | +25 |
| `bash-readonly-policy-types.ts` | 只读判定的类型（SafeFlagValue 等） | 逐字段口径 | +6 |
| `bash-semantics.ts` | 命令语义（退出码是否算错误、读写意图） | exit 1 仅 grep/rg/diff/test/find 视为语义非错误 | +34 |
| `create-workflow.ts` | CreateWorkflow：创建并启动 workflow | 创建前置校验、owner 免确认、停止/失败语义 | +11 |
| `create-workflow-description.ts` | 生成 CreateWorkflow 描述 | 描述与 schema 一致 | +4 |
| `create-workflow-graph-bounds.ts` | 展示图裁剪 | 引用完整性优先于保留数量、`truncated:true` 不抛错 | +12 |
| `create-workflow-graph-fold.ts` | 图的折叠/聚合 | 折叠后 id 可回指 | +5 |
| `create-workflow-source.ts` | 创建时的 source 归一化 | 脚本/路径/内联的互斥口径 | +6 |
| `cron.ts` | CronCreate/List/Update/Delete 定时自动化 CRUD | automationTurn 写闸门先于端口、端口缺失 ConfigurationError、`deleted=false` 业务语义、scheduleRule 投影 | +19 |
| `deferred-tool-call.ts` | 延迟工具调用解包（控制入口占位） | 解包前不执行、handler 永远抛的安全性理由 | +20 |
| `edit.ts` | Edit：精确字符串替换 | read-before-edit、mtime/size/revision 新鲜度、expectedRevision 乐观并发、CRLF 保留、唯一性按 actualOldString 重计数 | +13 |
| `escalate.ts` | 升级/请求用户介入 | question/context 口径、answered/refused、timeout 为 none | +10 |
| `eval-workflow-snippet.ts` | EvalWorkflowSnippet：片段求值 | 求值输入边界、失败语义 | +16 |
| `eval-workflow-snippet-description.ts` | 求值工具描述 | 描述与 schema 一致 | +4 |
| `fill-workflow-hole.ts` | FillWorkflowHole：填充 workflow 空洞 | 空洞定位与替换前置校验 | +15 |
| `fill-workflow-hole-description.ts` | 填充工具描述 | 描述与 schema 一致 | +4 |
| `fill-workflow-hole-resolve.ts` | 空洞定位解析 | 定位不到即业务失败 | +6 |
| `fill-workflow-hole-splice.ts` | 空洞拼接替换 | 文本拼接的不变量 | +2 |
| `get-workflow-run.ts` | GetWorkflowRun：查询 run 状态 | run 端口/listRuns 缺席 → 业务失败而非空列表、owner 免确认边界 | +16 |
| `get-workflow-run-format.ts` | run 输出格式化 | 模型可见投影的字段顺序 | +9 |
| `get-workflow-run-format-roster.ts` | roster 格式化 | 成员/阶段渲染口径 | +7 |
| `get-workflow-run-roster-output.ts` | 端口截面 → 输出 schema | 逐字段搬（strict schema 防端口演进击穿）、可选键用条件展开 | +12 |
| `get-workflow-run-summary.ts` | run 摘要 | 摘要与详情的分界 | +9 |
| `glob.ts` | Glob：文件路径匹配 | 工具语义/输入口径/truncated 语义/权限、path 解析 | +20 |
| `grep.ts` | Grep：ripgrep 内容检索 | 三种 output_mode 互斥、contextLines 映射、cancelled → ToolCancelled | +26 |
| `index.ts` | handlers 注册表 | 注册过滤顺序、disallowed 先于能力开关、branch 变体与过滤共用 options | +13 |
| `list-models.ts` | ListModels：列本宿主已配置模型 | 不是选模开关、读活目录不返回冻结拷贝 | +12 |
| `list-saved-workflows.ts` | ListSavedWorkflows：列已保存 workflow | 端口缺席降级、裁剪口径 | +13 |
| `list-workflow-runs.ts` | ListWorkflowRuns：列 run | 端口缺席 → introspectionUnavailable 业务失败 | +13 |
| `model-reference.ts` | 模型名 → 一次选型（纯函数） | 三档匹配/大小写/解不出返回 ok:false+candidates、在确认窗前解析 | +4 |
| `node-repl.ts` | js：持久 Node REPL / Code-Act | session 持久化、风险等同 Bash、browser-use 注入与 generation 校验、截图 artifact | +43 |
| `node-repl-model-content.ts` | js 结果转模型内容 | 投影顺序 error→logs→result→路径、错误 header 去重、image 优先 | +8 |
| `off-peak.ts` | OffPeakCreate/List 闲时任务 | offPeakTurn 拒绝（非 automationTurn）、额度/资格失败翻译为稳定错误、entry（needsApproval 恒 true、concurrentSafe=false） | +14 |

合计：**+1015 行**，75 个文件。

## 超 800 行文件

无。本批次加注后最大为 `edit.ts`（691 行），其次 `bash.ts`（615 行）、`create-workflow.ts`（485 行）、`node-repl.ts`（455 行）、`amend-workflow.ts`（427 行）；75 个文件合计 16,560 行，全部低于 800 行上限。

## 关键判定点落位（便于按图索骥）

- `bash.ts` + `bash-readonly-policy*.ts`：只读判定是三值（true / false / undefined），任一层无法穷举参数含义即返回 false；重定向、命令替换一律判写；`git branch/tag` 没有 `--list` 时位置参数即写操作；`git ls-remote` 判为联网。
- `bash-semantics.ts`：exit 1 只在 grep/rg/diff/test/find 这类"1 表示无匹配/有差异"的命令中视为语义结果，其余命令仍算失败。
- `bash-read-file-state.ts`：provider 报错、输出截断、转后台、含图片、被中断时都不回填 `readFileState`，避免把不完整读取当成已读。
- `edit.ts`：`concurrentSafe=false`，读前必须先 stat/read；用 mtime+size+revision 做新鲜度校验，`expectedRevision` 提供乐观并发，CRLF 原样保留；唯一性按替换后的 `actualOldString` 重新计数。
- `apply-patch.ts`：两阶段——先对全部操作做路径/上下文验证，全部通过后才落盘；move 不是原子操作，失败按 recoverable 返回。
- `cron.ts` / `off-peak.ts`：写闸门读的是 executor 传入的"本轮事实"，且在调用端口之前拒绝；provider 的 tool denylist 只约束可见性，不能当权限边界。
- `create-workflow-graph-bounds.ts`：展示图裁剪以"引用完整性"优先于"保留数量"，任何一次裁剪都置 `truncated:true` 而不是抛错。
- `get-workflow-run*.ts` / `list-models.ts`：端口缺席时返回稳定的业务失败（如 `workflowIntrospectionUnavailableFailure()`、`model_catalog_unavailable`），不返回空列表冒充"没有数据"。

## 校验

基线：`d:\code\_annot_baseline\L2-B3\apps\zcode-cli\packages\core\src\tool\handlers\`（编辑前快照，保持相对路径）。

```powershell
git --no-pager diff --no-index --numstat `
  "d:\code\_annot_baseline\L2-B3\apps\zcode-cli\packages\core\src\tool\handlers\<file>" `
  "d:\code\ZCode\apps\zcode-cli\packages\core\src\tool\handlers\<file>"
```

汇总脚本 `d:\code\_annot_baseline\check-l2-b3.ps1`（逐文件执行上述命令并聚合）：

```
files: 75  added: 1015  deleted(non-zero files): 0
```

结论：75 个文件**删除列全部为 0**；新增行全部为 `//` / `/** */` 注释或紧邻空行，未改代码 token、缩进、import 顺序与字符串，未执行格式化。已有文件头一律保留并扩写，未覆盖原文。
