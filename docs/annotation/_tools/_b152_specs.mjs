import fs from 'node:fs';

const specs = [
  {
    file: 'apps/zcode-cli/packages/core/src/agent/turn-state.ts',
    target: 40,
    firstNth: 1,
    header: [
      '// INV-01 阶段枚举封闭十项：守住位置 TurnPhase；改错故障 新阶段落到未处理分支。',
      '// INV-02 等待类阶段可停留：守住位置 isWaitingPhase；改错故障 超时判定漏掉权限等待。',
      '// INV-03 终态只含完成与错误：守住位置 isTerminalPhase；改错故障 仍在处理就被回收。',
      '// INV-04 一轮事实集中单对象：守住位置 TurnState；改错故障 状态散落难以收尾。',
      '// INV-05 附件保留原始形态：守住位置 attachments；改错故障 模型看不到附件。',
      '// INV-06 工具调用状态六种：守住位置 ToolCallStateStatus；改错故障 权限拒绝被当成失败。',
      '// INV-07 调度状态含依赖与并行组：守住位置 ToolScheduleState；改错故障 拓扑顺序错乱。',
      '// INV-08 权限决定四选一：守住位置 PermissionDecision；改错故障 未知决定直通执行。',
      '// INV-09 取消复用完成结果：守住位置 cancelled；改错故障 用户中断被报成错误。',
      '// INV-10 三种上限错误分档：守住位置 三个错误值；改错故障 预算与轮次无法区分。',
      '// INV-11 创建即置空闲阶段：守住位置 createTurnState；改错故障 首帧阶段为空。',
      '// INV-12 集合字段预置空数组：守住位置 工厂默认值；改错故障 消费方处理 undefined。',
      '// INV-13 起始时间在创建时冻结：守住位置 startedAt；改错故障 耗时从首次渲染算起。',
      '// INV-14 完成时间只在收尾写入：守住位置 completedAt；改错故障 运行中已有完成时间。',
      '// INV-15 转移表穷举全阶段：守住位置 validTransitions；改错故障 新增阶段默认可达。',
      '// INV-16 未知转移一律拒绝：守住位置 空值兜底；改错故障 非法跳转静默通过。',
      '// INV-17 完成与错误都可复位：守住位置 两条转移；改错故障 下一轮无法启动。',
      '// INV-18 类型模块不持有运行时状态：守住位置 纯导出；改错故障 单例跨轮污染。',
      '//',
      '// 模块职责：定义单轮状态机、子状态与阶段转移规则。',
      '// 状态所有权：纯类型与纯函数；运行实例由调用方持有。',
      '// 阅读顺序：先看阶段枚举，再看状态结构，最后看转移表。',
    ],
    blocks: [
      {
        anchor: 'export const TurnPhase = {',
        lines: [
          '十个阶段覆盖一轮完整生命周期。',
          '等待类阶段可以停留。',
          '终态只由完成与错误构成。',
        ],
      },
      {
        anchor: 'export interface TurnState {',
        lines: [
          '一轮事实集中在一个对象。',
          '输入与附件保留原始形态。',
          '终态字段在收尾时补齐。',
        ],
      },
      {
        anchor: 'export interface ToolScheduleState {',
        lines: [
          '依赖关系决定执行顺序。',
          '并行组来自依赖分析。',
          '执行顺序是最终拓扑。',
        ],
      },
      {
        anchor: 'export type TurnResultType =',
        lines: [
          '取消与成功同走完成事件。',
          '三种错误分别对应预算、轮次与工具上限。',
          '执行期错误单独一档。',
        ],
      },
      {
        anchor: 'export function createTurnState(',
        lines: [
          '初始阶段为空闲。',
          '工具与权限集合预置为空。',
          '起始时间在创建时记录。',
        ],
      },
      {
        anchor: 'export function canTransitionTo(current: TurnPhase, next: TurnPhase): boolean {',
        lines: [
          '转移表穷举全部阶段。',
          '未知阶段一律禁止。',
          '空闲与终态都可回到空闲。',
        ],
      },
    ],
  },
  {
    file: 'apps/zcode-cli/packages/core/src/runtime-task/workflow-notification-copy.ts',
    target: 41,
    firstNth: 1,
    header: [
      '// INV-01 固定抬头区分系统与用户：守住位置 SYSTEM_NOTIFICATION_BANNER；改错故障 模型把通知读成用户确认。',
      '// INV-02 抬头明确禁止当成答复：守住位置 banner 文案；改错故障 待答问题被误判已答。',
      '// INV-03 缺 providerStop 退回原文：守住位置 早退；改错故障 错误通知为空。',
      '// INV-04 显示名逐级回退：守住位置 providerRef；改错故障 团队套餐标识直接透出。',
      '// INV-05 五种停止原因各有两句：守住位置 switch；改错故障 未知原因没有动作建议。',
      '// INV-06 事实行字段始终齐全：守住位置 facts；改错故障 缺失字段导致解析失败。',
      '// INV-07 原文仅在存在时附加：守住位置 条件展开；改错故障 输出 undefined 字样。',
      '// INV-08 停滞分钟数至少为一：守住位置 取最大值；改错故障 显示零分钟。',
      '// INV-09 停滞原因缺省可读：守住位置 reasonClause；改错故障 句子缺少主语。',
      '// INV-10 停滞文案明说无需动作：守住位置 末段；改错故障 模型自行取消工作流。',
      '// INV-11 扇出上限仅在有值时附加：守住位置 capClause；改错故障 出现空括号。',
      '// INV-12 升级通知包含问题标识：守住位置 question-id；改错故障 回答无法对应问题。',
      '// INV-13 升级通知说明其余分支继续：守住位置 边界段；改错故障 模型停下所有工作。',
      '// INV-14 留白通知给出草稿位置：守住位置 where；改错故障 模型不知道去哪读上下文。',
      '// INV-15 留白正文只写语句：守住位置 指令段；改错故障 模型重写整个脚本。',
      '// INV-16 被抑制文本按字符截断：守住位置 boundBlockedText；改错故障 超长文本撑爆通知。',
      '// INV-17 提醒列表限量八条：守住位置 列表常量；改错故障 通知长度失控。',
      '// INV-18 最后一次提醒明说不再发：守住位置 ordinal 比较；改错故障 模型等待不存在的提醒。',
      '//',
      '// 模块职责：生成工作流 run 中通知与 provider 停止文案。',
      '// 状态所有权：纯函数与常量表；不持有运行状态。',
      '// 阅读顺序：先看固定抬头，再看 provider 停止文案，最后看三类 run 中通知。',
    ],
    blocks: [
      {
        anchor: 'const SYSTEM_NOTIFICATION_BANNER = [',
        lines: [
          '固定抬头区分系统通知与用户输入。',
          '明确禁止把通知当成用户确认。',
          '末尾空行隔开正文。',
        ],
      },
      {
        anchor: 'export function formatWorkflowProviderStopError(',
        lines: [
          '无 providerStop 时退回原始消息。',
          '显示名逐级回退。',
          '每种 kind 给原因与动作两句。',
          '事实行与原文附在末尾。',
        ],
      },
      {
        anchor: 'export function formatWorkflowStallNotification(input: WorkflowStallNotificationInput): string {',
        lines: [
          '分钟数至少为一。',
          '原因缺省使用泛化说法。',
          '明说不需要模型做任何事。',
        ],
      },
      {
        anchor: 'export function formatWorkflowHoleNotification(input: WorkflowHoleNotificationInput): string {',
        lines: [
          '位置短语按上下文组合。',
          '草稿路径缺省改用整脚本。',
          '明确只写函数体语句。',
        ],
      },
      {
        anchor: 'function boundBlockedText(value: string): string {',
        lines: [
          '未超限原样返回。',
          '截断保留省略号。',
          '上限与提醒列表分开配置。',
        ],
      },
      {
        anchor: 'export function formatWorkflowBlockedNotification(input: WorkflowBlockedNotificationInput): string {',
        lines: [
          '问题与留白各自限量。',
          '超出部分用计数说真话。',
          '终态提示这是最后一次提醒。',
        ],
      },
    ],
  },
  {
    file: 'apps/zcode-cli/packages/core/src/runtime/methods/session-title.ts',
    target: 42,
    firstNth: 1,
    header: [
      '// INV-01 标题是后台增强：守住位置 全局捕获；改错故障 标题失败中断主轮。',
      '// INV-02 一次性尝试：守住位置 尝试标记；改错故障 失败后反复调用模型。',
      '// INV-03 显式关闭优先：守住位置 enabled 判断；改错故障 用户关闭后仍然生成。',
      '// INV-04 无 store 不生成：守住位置 早退；改错故障 白费一次模型调用。',
      '// INV-05 子会话不生成：守住位置 父会话判断；改错故障 fork 产物继承错误标题。',
      '// INV-06 只取首轮输入：守住位置 turnNumber；改错故障 后续输入被当成初始意图。',
      '// INV-07 短输入跳过：守住位置 长度判断；改错故障 简短问候被改成泛化标题。',
      '// INV-08 协议命令可绕过短输入：守住位置 绕过标志；改错故障 目标永远没有标题。',
      '// INV-09 运行头刷新竞争先让主轮：守住位置 延迟判断；改错故障 标题请求抢占刷新。',
      '// INV-10 无法判断选择时保守延迟：守住位置 selection 缺省；改错故障 与主请求并发。',
      '// INV-11 入队冻结因果链：守住位置 捕获调用；改错故障 后台 trace 丢失指向。',
      '// INV-12 入队冻结模型上下文：守住位置 保留调用；改错故障 稍后读到新配置。',
      '// INV-13 生成结束释放票据：守住位置 finally；改错故障 闲时额度泄漏。',
      '// INV-14 写回前重读会话：守住位置 重读调用；改错故障 旧标题覆盖用户编辑。',
      '// INV-15 首查被编辑只记用量：守住位置 抑制判断；改错故障 编辑后仍写旧标题。',
      '// INV-16 custom 永不被自动覆盖：守住位置 来源比较；改错故障 用户命名被冲掉。',
      '// INV-17 CAS 期望来源限制写回：守住位置 期望来源；改错故障 并发改名被覆盖。',
      '// INV-18 条件不满足不发事件：守住位置 返回值比对；改错故障 界面显示未生效标题。',
      '//',
      '// 模块职责：编排会话标题的后台生成、写回与自定义改名的持久化。',
      '// 状态所有权：会话数据归 session store；后台任务由 runtime 追踪。',
      '// 阅读顺序：先看入口与前置条件，再看生成与写回，最后看编辑抑制与自定义改名。',
    ],
    blocks: [
      {
        anchor: 'const GENERATED_TITLE_EXPECTED_SOURCES: readonly SessionTitleSource[] = [',
        lines: [
          '只允许三种自动来源被覆盖。',
          'custom 永远不在集合内。',
          '该集合是写回 CAS 的期望值。',
          '新增来源需同步此表。',
        ],
      },
      {
        anchor: 'export function maybeStartSessionTitleGenerationFromExternalInput(',
        lines: [
          '协议命令也复用标题种子。',
          '不额外持久化用户消息。',
          '跳过短输入保护。',
          '无 trace 时使用根上下文。',
        ],
      },
      {
        anchor: 'this.sessionTitleGenerationAttempted = true;',
        lines: [
          '先置一次性标记再异步。',
          '失败也不重新排队。',
          '标记写在本轮同步段。',
          '调用方据此得到是否启动。',
        ],
      },
      {
        anchor: 'async function generateAndPersistSessionTitle(',
        lines: [
          '首查确认会话形态。',
          '首查被编辑则只记用量。',
          'custom 场景仅为目标写摘要。',
          '生成成功才写回标题。',
        ],
      },
      {
        anchor: 'const updated = await this.sessionStore?.updateSession({',
        lines: [
          '写回带期望来源。',
          '同时写入来源标记与消息标识。',
          '返回值不匹配视为未生效。',
          '未生效不再发事件。',
        ],
      },
    ],
  },
  {
    file: 'apps/zcode-cli/packages/core/src/tool/handlers/bash-git-runtime-safety.ts',
    target: 39,
    header: [
      '// INV-01 复合命令逐个检查：守住位置 集合遍历；改错故障 管道后的 git 漏检。',
      '// INV-02 命令名优先归一化：守住位置 归一化函数；改错故障 包装命令绕过检查。',
      '// INV-03 git 与目录切换同时出现才拦截：守住位置 组合判断；改错故障 普通 cd 命令被拒。',
      '// INV-04 逐层剥离内建包装：守住位置 循环；改错故障 command git 识别失败。',
      '// INV-05 无法归一化回退原名：守住位置 空值合并；改错故障 命令被当成未知。',
      '// INV-06 无 cwd 视为安全：守住位置 入口判断；改错故障 只读命令全部被拒。',
      '// INV-07 cwd 无法解析即不安全：守住位置 解析失败分支；改错故障 已删除目录仍放行。',
      '// INV-08 当前目录可信即放行：守住位置 trusted 分支；改错故障 正常仓库被逐级扫描。',
      '// INV-09 向上查找直到根：守住位置 父目录循环；改错故障 嵌套工作区漏判。',
      '// INV-10 裸仓库信号即拒绝：守住位置 HEAD 与 objects；改错故障 裸仓库被当普通目录。',
      '// INV-11 符号链接 .git 解析后再判：守住位置 链接分支；改错故障 链接指向工作区外。',
      '// INV-12 指针文件限长：守住位置 大小判断；改错故障 超大文件拖慢解析。',
      '// INV-13 指针文件禁空字符：守住位置 内容检查；改错故障 二进制内容被当成路径。',
      '// INV-14 gitdir 目标必须在 cwd 外：守住位置 路径包含判断；改错故障 自引用仓库通过。',
      '// INV-15 目标路径必须含 .git 段：守住位置 段判断；改错故障 任意目录被当成仓库。',
      '// INV-16 HEAD 只认引用或对象号：守住位置 两侧正则；改错故障 伪造 HEAD 通过。',
      '// INV-17 commondir 存在即视为工作树：守住位置 二次检查；改错故障 子模块被误判可信。',
      '// INV-18 读取异常按无仓库处理：守住位置 捕获分支；改错故障 权限错误导致命令被拒。',
      '//',
      '// 模块职责：在只读判定放行 git 前校验仓库归属与形态。',
      '// 状态所有权：纯函数；所有输入来自命令分析与运行时上下文。',
      '// 阅读顺序：先看命令识别，再看上下文入口，最后看 .git 形态分类。',
    ],
    blocks: [
      {
        anchor: 'export function analysisContainsGitCommand(',
        lines: [
          '逐个复合命令检查。',
          '名字优先取归一化结果。',
          '包装形式也能识别。',
          '仅判断是否出现 git。',
        ],
      },
      {
        anchor: 'export function isGitRuntimeContextUnsafe(',
        lines: [
          '无 cwd 视为安全。',
          '当前目录可信即放行。',
          '否则逐级向上查找。',
        ],
      },
      {
        anchor: 'function classifyDotGitDirectory(directory: string, cwdCanonical: string): GitDirectoryState {',
        lines: [
          '符号链接先解析目标。',
          '指针文件限长且禁空字符。',
          '目录形态检查 HEAD 与对象。',
          '读取失败按无仓库处理。',
        ],
      },
      {
        anchor: 'function classifyGitDirTarget(target: string, cwdCanonical: string): GitDirectoryState {',
        lines: [
          '目标必须可解析。',
          '目标不能等于或位于 cwd 内。',
          '路径中必须有 .git 段。',
        ],
      },
      {
        anchor: 'function hasTrustedGitDirectory(directory: string): boolean {',
        lines: [
          'HEAD 必须合法。',
          'objects 与 refs 必须可访问。',
          '出现 commondir 即视为工作树。',
        ],
      },
    ],
  },
];

let index = 0;
for (const spec of specs) {
  const srcLines = fs.readFileSync('D:/code/ZCode/' + spec.file, 'utf8').split('\n');
  const firstAnchor = srcLines[0].replace(/\r$/, '').trim();
  const firstItem = { anchor: firstAnchor, raw: spec.header };
  if (spec.firstNth) firstItem.nth = spec.firstNth;
  const items = [firstItem];
  for (const block of spec.blocks) {
    const anchor =
      block.anchorLine === undefined
        ? block.anchor
        : srcLines[block.anchorLine - 1].replace(/\r$/, '').trim();
    const item = { anchor, lines: block.lines };
    if (block.nth !== undefined) item.nth = block.nth;
    items.push(item);
  }
  const total = spec.header.length + spec.blocks.reduce((n, b) => n + b.lines.length, 0);
  if (total !== spec.target) {
    console.error(`TARGET MISMATCH ${spec.file}: ${total} != ${spec.target}`);
    process.exit(1);
  }
  fs.writeFileSync(
    `ZC-deep-b152-spec-${index}.json`,
    JSON.stringify({ files: [{ file: spec.file, items }] }, null, 2),
    'utf8',
  );
  console.log(`spec ${index}: ${spec.file} lines=${total}`);
  index += 1;
}
