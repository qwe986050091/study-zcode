import fs from 'node:fs';

const specs = [
  {
    file: 'packages/ui/src/v4/useAssistantPreviewCardsForRow.ts',
    target: 40,
    header: [
      '// INV-01 只有末条且已收尾才建卡：守住位置 canBuildCards；改错故障 流式中的半句被当成预览。',
      '// INV-02 轮次文本去空行后拼接：守住位置 joinAssistantTurnText；改错故障 空行产生空段落卡片。',
      '// INV-03 键含行号与实体号：守住位置 requestKey；改错故障 换行后命中上一条的变更结果。',
      '// INV-04 键含状态：守住位置 requestKey；改错故障 同一行的不同状态复用旧结果。',
      '// INV-05 回包按 key 校验后才用：守住位置 changedFilePaths；改错故障 迟到回包覆盖新一轮。',
      '// INV-06 失效后丢弃回包：守住位置 disposed；改错故障 卸载后仍写状态。',
      '// INV-07 失败按空集处理：守住位置 错误分支；改错故障 读变更失败时整块卡片消失。',
      '// INV-08 失败只记警告：守住位置 日志级别；改错故障 一次读失败刷出成片错误。',
      '// INV-09 回退态不请求：守住位置 reverted 早退；改错故障 回退后又覆盖回变更内容。',
      '// INV-10 无 md/html 不请求：守住位置 needsFileChanges；改错故障 纯文本轮次也打明细接口。',
      '// INV-11 远程精简抑制 html：守住位置 条件；改错故障 远程端渲染重预览。',
      '// INV-12 目标对象按字段记忆：守住位置 useMemo 依赖；改错故障 每次渲染重发请求。',
      '// INV-13 无目标不发请求：守住位置 早退；改错故障 用空目标调用接口。',
      '// INV-14 空集用共享常量：守住位置 回退值；改错故障 每次渲染产生新空数组导致重算。',
      '// INV-15 卡片构建整体记忆：守住位置 末尾 useMemo；改错故障 每帧重建卡片数组。',
      '// INV-16 依赖逐项列出：守住位置 依赖数组；改错故障 遗漏项导致卡片不更新。',
      '// INV-17 缓存策略固定：守住位置 请求参数；改错故障 同一轮次反复回源。',
      '// INV-18 引用提取可传主目录：守住位置 参数；改错故障 家目录相对路径无法解析。',
      '//',
      '// 模块职责：为助手文本行派生预览卡片，并按需读取本轮文件变更。',
      '// 状态所有权：变更路径缓存归本 hook；卡片本身由记忆化派生。',
      '// 阅读顺序：先看前置条件，再看请求键与副作用，最后看卡片构建。',
    ],
    blocks: [
      {
        anchor: 'function joinAssistantTurnText(rows: readonly AssistantTextRow[]): string {',
        lines: [
          '逐行取正文。',
          '纯空白行不参与拼接。',
          '段落之间保留双换行。',
          '结果供引用提取复用。',
          '不修改入参数组。',
        ],
      },
      {
        anchor: '}: UseAssistantPreviewCardsForAssistantTextRowParams): AssistantPreviewCard[] {',
        lines: [
          '只有末条且已结束才建卡。',
          '轮次文本按行集合记忆。',
          '引用提取依赖工作区路径。',
          '是否需要文件变更由引用类型决定。',
          '目标对象只保留两个标识。',
        ],
      },
      {
        anchor: 'useEffect(() => {',
        lines: [
          '三个前置条件缺一即退出。',
          '回退态直接跳过请求。',
          '卸载标志防止迟到写入。',
          '成功与失败都写入同一个键。',
        ],
      },
      {
        anchor: 'const changedFilePaths =',
        lines: [
          '键不符时视为空集。',
          '空集常量保证引用稳定。',
          '结果随后传给卡片构建。',
          '远程精简选项单独透传。',
        ],
      },
    ],
  },
  {
    file: 'apps/zcode-cli/packages/core/src/runtime/methods/workspace-fork.ts',
    target: 41,
    header: [
      '// INV-01 先读全快照再动文件：守住位置 两阶段；改错故障 半途失败留下中间态工作区。',
      '// INV-02 缺端口即配置错误：守住位置 前置判断；改错故障 恢复静默跳过却报告成功。',
      '// INV-03 每文件前查取消：守住位置 循环首行；改错故障 取消后继续写剩余文件。',
      '// INV-04 原来不存在就删除：守住位置 分支；改错故障 fork 后残留不该存在的文件。',
      '// INV-05 删除允许缺失：守住位置 missingOk；改错故障 外部已删文件导致整体失败。',
      '// INV-06 写入必须原子：守住位置 参数；改错故障 中断留下半截文件。',
      '// INV-07 只撤销 fork 点之后的检查点：守住位置 切片；改错故障 目标回合自身改动被回退。',
      '// INV-08 历史前缀命中即视为之前：守住位置 集合差；改错故障 跨 turn 检查点被误回退。',
      '// INV-09 同文件取最早 before：守住位置 映射写入；改错故障 恢复成较晚状态而非 fork 点。',
      '// INV-10 无后续检查点走纯对话 fork：守住位置 早退；改错故障 无谓改盘或直接报错。',
      '// INV-11 缺 artifact 与文件端口整体失败：守住位置 判断；改错故障 部分恢复被当成成功。',
      '// INV-12 子会话先建：守住位置 副作用顺序；改错故障 消息复制缺目标会话。',
      '// INV-13 消息复制产出 id 映射：守住位置 解构；改错故障 goal 锚点仍指向父会话。',
      '// INV-14 文件恢复排在复制之后：守住位置 调用顺序；改错故障 复制失败但文件已改。',
      '// INV-15 三条路径都要写 fork 时间线：守住位置 持久化；改错故障 冷恢复边界形态漂移。',
      '// INV-16 通知只带受控标识：守住位置 metadata；改错故障 文件内容被复制进事件。',
      '// INV-17 事件最后落库：守住位置 appendEvent；改错故障 订阅者跳转到尚未建好的会话。',
      '// INV-18 forkPoint 用历史结束下标：守住位置 事件字段；改错故障 子会话历史长度对不上。',
      '//',
      '// 模块职责：在指定消息处 fork 会话，并把工作区文件恢复到该点状态。',
      '// 状态所有权：无长驻状态；读写都经 runtime 注入的端口。',
      '// 阅读顺序：先看文件恢复，再看 fork 主流程，最后看两阶段副作用顺序。',
    ],
    blocks: [
      {
        anchor: '): Promise<WorkspaceRewindRestoredFile[]> {',
        lines: [
          '没有文件端口直接报配置错误。',
          '按文件顺序逐个处理。',
          '每个文件前都可被取消。',
          '原本不存在的走删除分支。',
          '其余走原子写入并回执字节数。',
        ],
      },
      {
        anchor: '): Promise<WorkspaceForkResult> {',
        lines: [
          '会话存储与父会话都必须存在。',
          '以落库消息作为 fork 源。',
          '目标消息缺失判定为非法状态。',
          '历史结束下标交给共享 helper。',
          '检查点只从事件流读取。',
        ],
      },
      {
        anchor: 'const earliestFileByPath = new Map<string, WorkspaceCheckpointArtifact["files"][number]>();',
        lines: [
          '先读全所有快照再动手。',
          '同一路径只保留首次出现。',
          '后出现的变更由首次覆盖。',
          '结果即 fork 点应有的文件状态。',
          '映射顺序不影响正确性。',
        ],
      },
      {
        anchor: 'const copiedTargetMessageId = messageIdMap.get(options.targetMessageId);',
        lines: [
          '目标消息的新 id 用于锚点。',
          '时间线与通知共用同一锚点。',
          '通知只写受控标识。',
          '事件在全部副作用之后写入。',
        ],
      },
    ],
  },
  {
    file: 'apps/zcode-cli/packages/core/src/subagent/persistent-memory-prompt.ts',
    target: 40,
    header: [
      '// INV-01 模板正文即模型契约：守住位置 常量；改错故障 记忆写入行为发生回归。',
      '// INV-02 占位符只有两个：守住位置 模板；改错故障 替换遗漏导致提示词露出原始标记。',
      '// INV-03 替换按字面量进行：守住位置 replace；改错故障 路径中的特殊字符被正则解释。',
      '// INV-04 根目录补平台分隔符：守住位置 归一化；改错故障 模板出现双斜杠路径。',
      '// INV-05 已带分隔符不重复追加：守住位置 判定；改错故障 尾部分隔符翻倍。',
      '// INV-06 索引先做格式归一：守住位置 formatMemoryIndexContent；改错故障 注入文本尾部出现空行。',
      '// INV-07 空索引给固定文案：守住位置 空值合并；改错故障 模型以为缺少段落字段。',
      '// INV-08 作用域全覆盖：守住位置 Record 类型；改错故障 新增作用域时运行时取到未定义。',
      '// INV-09 三种作用域文案互不重叠：守住位置 映射表；改错故障 本地记忆被当成团队共享。',
      '// INV-10 索引段落在模板之后：守住位置 拼接顺序；改错故障 索引被插到指令中间。',
      '// INV-11 记忆类型固定四类：守住位置 模板；改错故障 模型自造类型破坏索引检索。',
      '// INV-12 反例清单显式列出：守住位置 模板；改错故障 模型把可推导信息也写进记忆。',
      '// INV-13 引用先验证再推荐：守住位置 模板；改错故障 推荐已删除的文件或函数。',
      '// INV-14 记忆与计划任务分工明确：守住位置 模板；改错故障 把短期进度写进长期记忆。',
      '// INV-15 索引行数有上限说明：守住位置 模板；改错故障 索引膨胀后被截断却无人察觉。',
      '// INV-16 路径与文件名的链接规则：守住位置 模板；改错故障 关联记忆无法互相跳转。',
      '// INV-17 纯字符串拼装无 IO：守住位置 函数体；改错故障 读取磁盘导致调用点出现隐式失败。',
      '// INV-18 返回单字符串：守住位置 返回；改错故障 调用方需要再拼接一次。',
      '//',
      '// 模块职责：拼装持久记忆段的系统提示词文本。',
      '// 状态所有权：无状态；全部输入由参数给出。',
      '// 阅读顺序：先看模板常量，再看作用域文案，最后看拼装函数。',
    ],
    blocks: [
      {
        anchor: 'const PERSISTENT_AGENT_MEMORY_PROMPT_TEMPLATE = [',
        lines: [
          '每行是模板的一段原文。',
          '两类记忆类型必须成对出现。',
          '占位符以尖括号标记。',
          '反例段落在保存规则之前。',
          '整体在定义时即拼接成串。',
        ],
      },
      {
        anchor: 'const SCOPE_GUIDANCE: Record<AgentMemoryScope, string> = {',
        lines: [
          '三种作用域各一行文案。',
          '用户级强调跨项目通用。',
          '项目级强调随版本库共享。',
          '本地级强调仅本机可见。',
          '类型约束保证新增即报错。',
        ],
      },
      {
        anchor: '}): string {',
        lines: [
          '根目录先补平台分隔符。',
          '索引内容先做格式归一。',
          '先替换根目录再替换作用域。',
          '索引段落固定排在最末。',
        ],
      },
      {
        anchor: 'const memoryRoot = input.rootDir.endsWith(sep) ? input.rootDir : `${input.rootDir}${sep}`;',
        lines: [
          '已带分隔符则原样使用。',
          '空索引走固定文案。',
          '拼接结果不保留多余空行。',
          '函数不做任何磁盘访问。',
        ],
      },
    ],
  },
  {
    file: 'apps/zcode-cli/packages/tui/src/app-mode-suggestion-panel.tsx',
    target: 41,
    header: [
      '// INV-01 可见条数上限为三：守住位置 常量；改错故障 浮层挤占输入区。',
      '// INV-02 面板高按实际行数：守住位置 计算；改错故障 空态与满态高度不一致。',
      '// INV-03 每行恒为一行高：守住位置 行样式；改错故障 长文案换行破坏对齐。',
      '// INV-04 选择符宽度固定：守住位置 常量；改错故障 选中态让整行右移。',
      '// INV-05 detail 至多占 65%：守住位置 预算函数；改错故障 名称被压到不可读。',
      '// INV-06 名称最少保留六列：守住位置 预算；改错故障 窄终端只剩省略号。',
      '// INV-07 内容宽最小十二列：守住位置 归一化；改错故障 极窄终端出现负宽度。',
      '// INV-08 宽度非法回落八十：守住位置 归一化；改错故障 NaN 传入布局导致崩渲染。',
      '// INV-09 空候选显示提示行：守住位置 分支；改错故障 面板高度塌陷。',
      '// INV-10 选中下标先夹取：守住位置 窗口函数；改错故障 越界下标导致切片为空。',
      '// INV-11 窗口以选中项为底部：守住位置 起点计算；改错故障 选中项滚出可视区。',
      '// INV-12 起点不越界：守住位置 双重夹取；改错故障 末尾候选下方留白。',
      '// INV-13 返回相对下标：守住位置 返回值；改错故障 行高亮错位。',
      '// INV-14 返回窗口起点：守住位置 返回值；改错故障 调用方无法定位全局位置。',
      '// INV-15 说明为空省两段：守住位置 条件渲染；改错故障 出现孤立间隔。',
      '// INV-16 间隔用弹性盒：守住位置 行结构；改错故障 说明被推到下一行。',
      '// INV-17 当前模式追加标记：守住位置 modeDetail；改错故障 用户看不出当前生效项。',
      '// INV-18 纯展示不写状态：守住位置 组件边界；改错故障 切换逻辑被复制到面板内。',
      '//',
      '// 模块职责：渲染模式候选浮层，含裁剪、窗口滚动与选中高亮。',
      '// 状态所有权：无状态；选中项与当前模式都由父层给出。',
      '// 阅读顺序：先看常量，再看面板与窗口函数，最后看行渲染与宽度预算。',
    ],
    blocks: [
      {
        anchor: 'const MODE_OPTION_VISIBLE_COUNT = 3;',
        lines: [
          '可见条数与面板外观行数分开。',
          '行高恒为一行。',
          '选择符与间隔各占固定列。',
          '最小内容宽保护窄终端。',
          '比例上限与最小名称宽共同约束。',
        ],
      },
      {
        anchor: '}): React.ReactElement | null {',
        lines: [
          '可见窗口由独立函数给出。',
          '内容宽先归一化再使用。',
          '候选逐行拟合为单行模型。',
          '面板高按可见行数计算。',
          '空候选仍占一行提示。',
        ],
      },
      {
        anchor: 'const clampedSelectedIndex = clampIndex(selectedIndex, modes.length);',
        lines: [
          '空候选或上限非正直接返回空窗。',
          '全局下标先夹取到范围内。',
          '可见条数取上限与总数较小值。',
          '起点让选中项尽量靠底部。',
          '返回值中包含全局起点。',
        ],
      },
      {
        anchor: '}): React.ReactElement {',
        lines: [
          '选择符与名称宽度固定不伸缩。',
          '说明为空时省略间隔与文本。',
          '间隔用弹性盒吸收剩余宽度。',
          '颜色取自当前主题面板。',
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
    items.push({ anchor: block.anchor, lines: block.lines });
  }
  const total = spec.header.length + spec.blocks.reduce((n, b) => n + b.lines.length, 0);
  if (total !== spec.target) {
    console.error(`TARGET MISMATCH ${spec.file}: ${total} != ${spec.target}`);
    process.exit(1);
  }
  fs.writeFileSync(
    `ZC-deep-b143-spec-${index}.json`,
    JSON.stringify({ files: [{ file: spec.file, items }] }, null, 2),
    'utf8',
  );
  console.log(`spec ${index}: ${spec.file} lines=${total}`);
  index += 1;
}
