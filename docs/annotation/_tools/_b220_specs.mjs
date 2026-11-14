// B220 四个文件的注释 spec 生成器（各新增 30 行）。
import fs from 'node:fs';

const specs = [
  {
    file: 'packages/ui/src/settings/useShortcutRecording.ts',
    target: 30,
    header: [
      '// INV-01 仅录制态监听：守住位置 useEffect 的 recording 早退；改错故障 普通输入被吞键。',
      '// INV-02 捕获阶段拦截：守住位置 addEventListener 第三参 true；改错故障 组件先处理按键，录制不到。',
      '// INV-03 监听随录制态收放：守住位置 依赖数组含 recording；改错故障 结束后仍抢占键盘。',
      '// INV-04 Escape 取消：守住位置 第一个按键分支；改错故障 无法退出录制。',
      '// INV-05 Backspace 恢复默认：守住位置 clearBinding 调用；改错故障 用户只能逐条删。',
      '// INV-06 未完成组合保留预览：守住位置 pending 分支；改错故障 按下修饰键就丢失已录内容。',
      '// INV-07 无效组合转错误文案：守住位置 invalid 分支；改错故障 界面无反馈，像没响应。',
      '// INV-08 同命令重复直接拒绝：守住位置 duplicate 判定；改错故障 一个命令挂两组相同键。',
      '// INV-09 replace 跳过目标条：守住位置 index === bindingIndex；改错故障 原位重录被判为重复。',
      '// INV-10 冲突检查区分保留与占用：守住位置 conflict.kind；改错故障 系统键被允许抢绑。',
      '// INV-11 Web 端菜单键按保留处理：守住位置 menuChannelReserved；改错故障 Web 抢走菜单快捷键。',
      '// INV-12 落盘按模式分派：守住位置 mode 与 bindingIndex 判断；改错故障 替换变成追加。',
      '// INV-13 监听必须解绑：守住位置 cleanup；改错故障 多次进入录制后重复写入绑定。',
      '// INV-14 依赖完整：守住位置 依赖数组；改错故障 闭包拿到过期绑定表。',
      '//',
      '// 模块职责：快捷键录制态下的键盘捕获与冲突校验，把结果写回绑定表。',
      '// 阅读顺序：先看录制早退与按键分派，再看重复与冲突拒绝，最后看落盘分支。',
    ],
    blocks: [
      {
        anchor: 'export function useShortcutRecording({',
        lines: [
          'hook 只负责录制，不持有绑定事实。',
        ],
      },
      {
        anchor: 'if (!recording) {',
        lines: [
          '非录制态不装监听。',
        ],
      },
      {
        anchor: 'function handleRecordingKeydown(event: KeyboardEvent) {',
        lines: [
          '录制期间所有按键先拦截。',
        ],
      },
      {
        anchor: 'if (event.key === "Escape") {',
        lines: [
          '取消录制不改动绑定。',
        ],
      },
      {
        anchor: 'if (event.key === "Backspace") {',
        lines: [
          '退格恢复该命令默认键。',
        ],
      },
      {
        anchor: 'const result = recordShortcutBinding(event);',
        lines: [
          '组合判定交给内核录制器。',
        ],
      },
      {
        anchor: 'if (result.kind === "pending") {',
        lines: [
          '组合未完成时清掉上一次提示。',
        ],
      },
      {
        anchor: 'if (result.kind === "invalid") {',
        lines: [
          '无效组合按原因给出不同文案。',
        ],
      },
      {
        anchor: 'const sameCommandBindings = effective[current.commandId] ?? [];',
        lines: [
          '只与同命令的生效条目比较。',
        ],
      },
      {
        anchor: 'if (duplicate) {',
        lines: [
          '重复组合同样只标红，不落盘。',
        ],
      },
      {
        anchor: 'if (conflict) {',
        lines: [
          '冲突分支保留预览以便用户改按。',
        ],
      },
      {
        anchor: 'if (current.mode === "add" || current.bindingIndex === null) {',
        lines: [
          '占位行录制等价于追加。',
        ],
      },
      {
        anchor: 'window.addEventListener("keydown", handleRecordingKeydown, true);',
        lines: [
          '捕获阶段注册，先于业务组件。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/slashCommandHelpers.ts',
    target: 30,
    header: [
      '// INV-01 纯函数：守住位置 全部导出；改错故障 建议构造过程产生副作用。',
      '// INV-02 值一律去前导斜杠：守住位置 normalizeSlashCommandValue；改错故障 插入后变成双斜杠。',
      '// INV-03 App 命令带独立前缀：守住位置 APP_SLASH_SUGGESTION_ID_PREFIX；改错故障 与 CLI 命令 id 撞车。',
      '// INV-04 App 命令不进发送链路：守住位置 接口注释与 run；改错故障 选中即发送文本。',
      '// INV-05 空值命令丢弃：守住位置 !value 早退；改错故障 面板出现空白项。',
      '// INV-06 Plan 由 Composer 本地处理：守住位置 plan 过滤；改错故障 旧 Agent 广播的命令重新插入文本。',
      '// INV-07 关键词去重：守住位置 new Set 展开；改错故障 面板匹配项重复排序抖动。',
      '// INV-08 标签可回落：守住位置 inputHint 三元；改错故障 命令显示为 undefined。',
      '// INV-09 子代理复用 mention 映射：守住位置 mapSubagentsToMentionItemsForTest；改错故障 两处展示不一致。',
      '// INV-10 Skill 标记补默认关键词：守住位置 skills 关键字拼接；改错故障 搜索不到技能。',
      '// INV-11 替换要求活跃触发：守住位置 activeTrigger 判断；改错故障 光标不在命令内也改写文本。',
      '// INV-12 尾部按 token 长度裁剪：守住位置 tailLength；改错故障 替换后残留旧命令片段。',
      '// INV-13 非折叠选区不取文本：守住位置 isCollapsed；改错故障 选中整段时插入错位。',
      '// INV-14 非文本锚点回落全量：守住位置 anchor.type 分支；改错故障 根节点下光标拿不到上下文。',
      '//',
      '// 模块职责：斜杠命令面板的建议构造、命令名规整与光标前后文本替换。',
      '// 阅读顺序：先看 App 命令与 CLI 命令两套建议，再看替换函数，最后看光标上下文。',
    ],
    blocks: [
      {
        anchor: 'export function buildAppSlashCommandSuggestions(',
        lines: [
          'App 命令逐条规整后转成建议项。',
        ],
      },
      {
        anchor: 'const value = normalizeSlashCommandValue(command.value);',
        lines: [
          '规整后再判断是否可展示。',
        ],
      },
      {
        anchor: 'export function isAppSlashCommandSuggestion(suggestion: PromptInputSuggestionItem): boolean {',
        lines: [
          '前缀是判断来源的唯一依据。',
        ],
      },
      {
        anchor: 'export function shouldOfferSideSlashCommand(options: {',
        lines: [
          '四个条件必须同时满足才展示。',
        ],
      },
      {
        anchor: 'export function normalizeSlashCommandValue(name: string): string {',
        lines: [
          '远端可能自带斜杠，统一去掉。',
        ],
      },
      {
        anchor: 'return name.trim().replace(/^\\/+/, "");',
        lines: [
          '只裁剪前导斜杠，保留内部内容。',
        ],
      },
      {
        anchor: 'export function buildSlashSuggestions(commands: ZCodeSlashCommand[]): PromptInputSuggestionItem[] {',
        lines: [
          'CLI 命令以 catalog 为准。',
        ],
      },
      {
        anchor: 'if (!value || value.toLowerCase() === "plan") {',
        lines: [
          'Plan 不再经建议面板插入。',
        ],
      },
      {
        anchor: 'export function buildSubagentSuggestions(',
        lines: [
          '子代理先转 mention 再转建议。',
        ],
      },
      {
        anchor: 'export function buildSkillSuggestions(',
        lines: [
          '技能标签固定带美元前缀。',
        ],
      },
      {
        anchor: 'export function replaceActiveSlashToken(',
        lines: [
          '只有光标处在命令内才替换。',
        ],
      },
      {
        anchor: 'export function getTextAroundCursor() {',
        lines: [
          '取光标前后文本供触发识别。',
        ],
      },
      {
        anchor: 'if (!$isRangeSelection(selection) || !selection.isCollapsed()) {',
        lines: [
          '非折叠选区不参与命令匹配。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/TaskListItemContextMenu.tsx',
    target: 30,
    header: [
      '// INV-01 纯展示装配：守住位置 组件体；改错故障 右键菜单自己取服务或改任务状态。',
      '// INV-02 组织动作排在最前：守住位置 organizationActions；改错故障 分组命令被任务动作挤到后面。',
      '// INV-03 菜单项实现可注入：守住位置 Item / Separator；改错故障 右键菜单与操作面板分叉。',
      '// INV-04 动作清单只有一份：守住位置 TaskActionMenuContent；改错故障 两处菜单项增减不同步。',
      '// INV-05 全部动作回调透传：守住位置 各 on* props；改错故障 右键菜单里点击无反应。',
      '// INV-06 可选动作保持可选：守住位置 onCopySessionId / onViewModelTrajectory；改错故障 缺数据时出现死按钮。',
      '// INV-07 禁用态整体下传：守住位置 disableTaskActions；改错故障 部分动作在禁用任务上仍可点。',
      '// INV-08 禁用原因一并下传：守住位置 disabledReason；改错故障 悬停没有解释。',
      '// INV-09 会话文件三态透传：守住位置 taskSessionFile；改错故障 加载中与不存在被混为一谈。',
      '// INV-10 原生日志与人读日志分开：守住位置 taskNativeSessionLogFile；改错故障 复制到错误路径。',
      '// INV-11 供应商配置独立入参：守住位置 providerConfigFile；改错故障 打不开当前任务的配置。',
      '// INV-12 宽度固定：守住位置 w-52；改错故障 长文案把菜单撑出屏幕。',
      '// INV-13 intl 由调用方注入：守住位置 intl prop；改错故障 菜单文案绕开统一国际化。',
      '// INV-14 归档默认 false：守住位置 参数默认值；改错故障 缺省时显示「取消归档」。',
      '//',
      '// 模块职责：任务列表项右键菜单的容器，把动作清单接到上下文菜单组件上。',
      '// 阅读顺序：先看容器与组织动作，再看动作清单的透传参数，最后看禁用与文件三态。',
    ],
    blocks: [
      {
        anchor: 'export function TaskListItemContextMenu({',
        lines: [
          '菜单只做装配，不持有任务状态。',
        ],
      },
      {
        anchor: 'disabledReason,',
        lines: [
          '禁用原因由调用方给出。',
        ],
      },
      {
        anchor: '<ContextMenuContent className="w-52">',
        lines: [
          '宽度固定，避免长文案撑破。',
        ],
      },
      {
        anchor: '{organizationActions}',
        lines: [
          '组织动作先于任务动作展示。',
        ],
      },
      {
        anchor: '<TaskActionMenuContent',
        lines: [
          '动作清单复用面板同一实现。',
        ],
      },
      {
        anchor: 'Item={ContextMenuItem}',
        lines: [
          '菜单项组件由调用方注入。',
        ],
      },
      {
        anchor: 'Separator={ContextMenuSeparator}',
        lines: [
          '分隔线同样注入。',
        ],
      },
      {
        anchor: 'onCopySessionId={onCopySessionId}',
        lines: [
          '可选动作原样下传。',
        ],
      },
      {
        anchor: 'onViewModelTrajectory={onViewModelTrajectory}',
        lines: [
          '轨迹入口只对支持的来源出现。',
        ],
      },
      {
        anchor: 'disableTaskActions={disableTaskActions}',
        lines: [
          '禁用态整体传给动作清单。',
        ],
      },
      {
        anchor: 'disabledReason={disabledReason}',
        lines: [
          '原因一并下传用于提示。',
        ],
      },
      {
        anchor: '}) {',
        lines: [
          '参数解构结束，属性原样展开。',
        ],
      },
      {
        anchor: '</ContextMenuContent>',
        lines: [
          '容器闭合，不附加额外包裹层。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/ToolCallBlocks/ToolPresentation.tsx',
    target: 30,
    header: [
      '// INV-01 无宿主依赖：守住位置 组件体与默认值；改错故障 公开页面构造服务或工作区。',
      '// INV-02 renderer 为共享实现：守住位置 resolveToolCallRenderer；改错故障 独立维护一套卡片。',
      '// INV-03 输出文本规整按能力开启：守住位置 capabilities.normalizeOutputText 判断；改错故障 无能力时也改写输出。',
      '// INV-04 规整结果同步 raw：守住位置 rawOutput 赋值；改错故障 摘要与原始数据不一致。',
      '// INV-05 规整用 memo 缓存：守住位置 useMemo 依赖；改错故障 每次渲染重建节点树。',
      '// INV-06 展示模型纯推导：守住位置 buildToolDisplayModel；改错故障 渲染过程写入业务状态。',
      '// INV-07 工作区固定为空：守住位置 workspacePath: ""；改错故障 公开页面按某路径读文件。',
      '// INV-08 todo 默认隐藏：守住位置 showTodoToolCalls 判断；改错故障 公开页面出现内部待办卡。',
      '// INV-09 子调用递归同参：守住位置 子节点展开 options；改错故障 嵌套层级丢失主题与设置。',
      '// INV-10 子列表按 toolId 作 key：守住位置 key 取值；改错故障 流式追加时卡片错位。',
      '// INV-11 fallback 只读时隐藏原文：守住位置 hideRawFallback；改错故障 只读场景暴露原始载荷。',
      '// INV-12 CUA 组回调按需透传：守住位置 events / renderAssistantMessage / renderReasoning；改错故障 组内消息渲染缺失。',
      '// INV-13 状态词映射统一：守住位置 mapToolStatus 与摘要 id；改错故障 状态标签与图标不一致。',
      '// INV-14 关闭摘要动画：守住位置 disableSummaryContentAnimation；改错故障 公开页面逐帧抖动。',
      '//',
      '// 模块职责：脱离宿主环境的工具卡装配层，复用共享 renderer 并补齐默认上下文。',
      '// 阅读顺序：先看输出规整，再看 render 上下文构造，最后看三类 renderer 分支。',
    ],
    blocks: [
      {
        anchor: 'export function ToolPresentation({',
        lines: [
          '公开渲染入口，全部依赖显式传入。',
        ],
      },
      {
        anchor: 'const { intl } = useZCodeIntl();',
        lines: [
          '文案统一走内联国际化。',
        ],
      },
      {
        anchor: 'const capabilities = useToolPresentationCapabilities();',
        lines: [
          '宿主能力按上下文注入，可为空。',
        ],
      },
      {
        anchor: 'const normalizedNode = useMemo(() => {',
        lines: [
          '只有存在规整能力时才改写输出。',
        ],
      },
      {
        anchor: 'const state = mapToolStatus(toolCall.status);',
        lines: [
          '协议状态先映射成展示状态。',
        ],
      },
      {
        anchor: 'const displayModel = useMemo(() => buildToolDisplayModel(toolCall, ""), [toolCall]);',
        lines: [
          '展示模型只依赖工具调用本身。',
        ],
      },
      {
        anchor: 'const context: ToolCallBlockRenderContext = {',
        lines: [
          '上下文一次构造，供各 renderer 共用。',
        ],
      },
      {
        anchor: 'nestedToolRenderer: ToolPresentation,',
        lines: [
          '嵌套渲染指回自身，保持行为一致。',
        ],
      },
      {
        anchor: 'workspacePath: "",',
        lines: [
          '公开页面没有工作区，固定为空。',
        ],
      },
      {
        anchor: 'childToolList: childToolCalls.length ? (',
        lines: [
          '子调用按 toolId 作 key 递归展开。',
        ],
      },
      {
        anchor: 'if (identity.family === "todo" && options.showTodoToolCalls !== true) return null;',
        lines: [
          '待办卡默认不展示，需显式开启。',
        ],
      },
      {
        anchor: 'if (Renderer === FallbackToolCallBlock)',
        lines: [
          '兜底卡按只读能力隐藏原文。',
        ],
      },
      {
        anchor: 'return <Renderer {...context} />;',
        lines: [
          '常规分支统一展开上下文。',
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
    const item = { anchor: block.anchor, lines: block.lines };
    if (block.nth !== undefined) item.nth = block.nth;
    items.push(item);
  }
  const total = spec.header.length + spec.blocks.reduce((n, b) => n + b.lines.length, 0);
  if (total !== spec.target) {
    console.error(`TARGET MISMATCH ${spec.file}: ${total} != ${spec.target}`);
    process.exit(1);
  }
  fs.writeFileSync(
    `ZC-deep-b220-spec-${index}.json`,
    JSON.stringify({ files: [{ file: spec.file, items }] }, null, 2),
    'utf8',
  );
  console.log(`spec ${index}: ${spec.file} lines=${total}`);
  index += 1;
}
