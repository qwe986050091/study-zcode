import fs from 'node:fs';

const specs = [
  {
    file: 'packages/ui/src/ToolCallBlocks/renderers/execute-group.tsx',
    target: 35,
    header: [
      '// INV-01 活跃集合集中定义：守住位置 唯一常量；改错故障 流式与待审批被判为已结束。',
      '// INV-02 最近活跃子项优先：守住位置 查找顺序；改错故障 运行态展示已结束的子命令。',
      '// INV-03 无活跃时回退末项：守住位置 空值兜底；改错故障 运行中不显示任何命令。',
      '// INV-04 Office 模式不取命令：守住位置 布尔判断；改错故障 文档模式露出终端命令。',
      '// INV-05 概述按状态计数：守住位置 过滤长度；改错故障 失败与停止数不准。',
      '// INV-06 单条与多条走不同消息键：守住位置 三元选择；改错故障 英文单复数错乱。',
      '// INV-07 统计片段按需拼接：守住位置 条件追加；改错故障 出现零失败提示。',
      '// INV-08 运行态主文案来自本地化：守住位置 消息键；改错故障 界面出现硬编码。',
      '// INV-09 主文案按运行态切换：守住位置 三元表达式；改错故障 结束后仍显示运行中。',
      '// INV-10 次文案仅运行时给出：守住位置 条件属性；改错故障 完成态残留最后一条命令。',
      '// INV-11 展开态清空次文案：守住位置 显式空值；改错故障 命令数量后粘连当前命令。',
      '// INV-12 摘要动画随运行态启停：守住位置 布尔属性；改错故障 结束后仍在滚动。',
      '// INV-13 摘要键包含命令与状态：守住位置 模板拼接；改错故障 换命令不触发动画。',
      '// INV-14 子项渲染保留父级回调：守住位置 属性透传；改错故障 子项无法打开文件或浏览器。',
      '// INV-15 子项不重复显示图标：守住位置 图标开关；改错故障 树状结构出现双图标。',
      '// INV-16 子项以标识为键：守住位置 键属性；改错故障 列表重排导致状态串位。',
      '// INV-17 折叠能力默认开启：守住位置 兜底表达式；改错故障 点击标题无响应。',
      '// INV-18 标题区分折叠与展开：守住位置 两个标题属性；改错故障 展开后标题信息缺失。',
      '//',
      '// 模块职责：把一组串行命令渲染为可折叠的单个工具块。',
      '// 状态所有权：无状态；运行态、子项与回调全部来自渲染上下文。',
      '// 阅读顺序：先看活跃集合与统计，再看运行态文案，最后看子项渲染与布局属性。',
    ],
    blocks: [
      {
        anchor: 'const ACTIVE_STATUSES = new Set(["pending", "in_progress"]);',
        lines: [
          '活跃状态统一为两种。',
          'V4 适配层把流式与待审批压成 pending。',
          '集合用于寻找最近的活跃子项。',
          '常量不随渲染变化。',
        ],
      },
      {
        anchor: 'function formatCompletedSummary(',
        lines: [
          '命令数与失败数分开成句。',
          '单条与多条使用不同消息键。',
          '停止与失败可同时出现。',
        ],
      },
      {
        anchor: 'export function ExecuteGroupToolCallBlock(context: ToolCallBlockRenderContext) {',
        lines: [
          '嵌套渲染器由上下文注入。',
          '最近活跃子项优先于末项。',
          'Office 模式不展示命令细节。',
        ],
      },
      {
        anchor: 'const renderContent = useCallback(',
        lines: [
          '子项按标识作为键渲染。',
          '缩进与左侧竖线表达从属关系。',
          '回调透传保持父级能力。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/ToolCallBlocks/renderers/fallback.tsx',
    target: 34,
    header: [
      '// INV-01 兜底渲染必须可用：守住位置 默认导出路径；改错故障 未知工具整块消失。',
      '// INV-02 图标可覆盖：守住位置 合并表达式；改错故障 已知工具显示扳手。',
      '// INV-03 图标可关闭：守住位置 不等于判断；改错故障 嵌套场景出现双图标。',
      '// INV-04 种类标签空值安全：守住位置 长度判断；改错故障 空种类导致取值异常。',
      '// INV-05 种类首字母大写：守住位置 字符串拼接；改错故障 标签大小写不一。',
      '// INV-06 内联预览抑制原始结构：守住位置 布尔判断；改错故障 内容重复展示。',
      '// INV-07 原始结构可整体隐藏：守住位置 双重条件；改错故障 专门渲染下仍泄露原始数据。',
      '// INV-08 加载能力按工具标识绑定：守住位置 闭包参数；改错故障 提示加载错误的工具。',
      '// INV-09 摘要模式不带副文案：守住位置 条件属性；改错故障 摘要行右侧出现状态。',
      '// INV-10 失败时副文案让位状态：守住位置 状态比较；改错故障 失败原因与状态重复。',
      '// INV-11 失败提示用错误文本：守住位置 工具提示属性；改错故障 悬停看不到原因。',
      '// INV-12 失败标记仅在失败时出现：守住位置 状态布尔；改错故障 成功块显示警示。',
      '// INV-13 标题优先摘要覆盖值：守住位置 字符串判断；改错故障 摘要与标题不一致。',
      '// INV-14 摘要覆盖非字符串时不提升标题：守住位置 类型判断；改错故障 对象被当成标题。',
      '// INV-15 折叠能力默认开启：守住位置 兜底表达式；改错故障 未知工具无法展开。',
      '// INV-16 折叠初始态由调用方决定：守住位置 默认值；改错故障 兜底块强制展开。',
      '// INV-17 内容回调依赖完整：守住位置 依赖数组；改错故障 主题切换后预览不刷新。',
      '// INV-18 摘要模式不显示种类：守住位置 空值分支；改错故障 摘要行出现种类标签。',
      '//',
      '// 模块职责：为没有专门渲染器的工具提供通用兜底展示。',
      '// 状态所有权：无状态；工具调用与预览设置全部来自渲染上下文。',
      '// 阅读顺序：先看图标与属性接口，再看种类与预览判断，最后看布局属性与失败态。',
    ],
    blocks: [
      {
        anchor: 'const FALLBACK_TOOL_ICON = <WrenchIcon className="size-4 shrink-0 text-foreground-subtle" />;',
        lines: [
          '兜底图标表示未知工具。',
          '允许调用方覆盖为更具体的图标。',
          '图标样式与父布局一致。',
        ],
      },
      {
        anchor: 'interface FallbackToolCallBlockProps extends ToolCallBlockRenderContext {',
        lines: [
          '摘要模式只显示一行文案。',
          '隐藏原始回退用于已有专门渲染时。',
          '其余字段全部继承通用上下文。',
        ],
      },
      {
        anchor: 'export function FallbackToolCallBlock(context: FallbackToolCallBlockProps) {',
        lines: [
          '种类标签取首个单词首字母大写。',
          '内联预览存在时不再展示原始结构。',
          '加载完整字段按工具标识回调。',
        ],
      },
      {
        anchor: 'const renderContent = useCallback(',
        lines: [
          '正文、快照提示与原始结构依次排列。',
          '快照提示仅在有加载能力时出现。',
          '原始结构受内联预览与隐藏开关双重控制。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/ToolCallBlocks/renderers/get-workflow-run-roster.tsx',
    target: 36,
    firstNth: 1,
    header: [
      '// INV-01 相位词永远在场：守住位置 状态单元格；改错故障 仅靠颜色表达状态。',
      '// INV-02 颜色只是第二通道：守住位置 语义类映射；改错故障 色弱用户无法区分。',
      '// INV-03 停驻视为需要注意：守住位置 状态色；改错故障 等人回答显示成空闲。',
      '// INV-04 空花名册不占位：守住位置 长度早退；改错故障 卡片出现空白块。',
      '// INV-05 匿名不留兜底名：守住位置 空值分支；改错故障 出现占位名字。',
      '// INV-06 行身份用站点与序号：守住位置 键拼接；改错故障 同名子代理状态串位。',
      '// INV-07 任务行从属上一行：守住位置 缩进类；改错故障 被读成新事实行。',
      '// INV-08 读数缺席不补零：守住位置 条件渲染；改错故障 未知被显示为零 token。',
      '// INV-09 在飞判定看读数在场：守住位置 多字段或运算；改错故障 执行中的行只显示相位词。',
      '// INV-10 停驻先说出问题标识：守住位置 分支顺序；改错故障 停驻行没有可行动信息。',
      '// INV-11 等待先说原因再说时长：守住位置 顺序注释与拼接；改错故障 两个时长含义混淆。',
      '// INV-12 等待原因缺省则不占格子：守住位置 空数组返回；改错故障 出现空文案。',
      '// INV-13 重试时长按需追加：守住位置 可选判断；改错故障 无退避时显示零时长。',
      '// INV-14 老日志回退已结算读数：守住位置 空数组判断；改错故障 行里只有相位词。',
      '// INV-15 最后工具名必填：守住位置 直接取值；改错故障 出现未定义文案。',
      '// INV-16 工具目标可为空：守住位置 过滤条件；改错故障 名后残留多余空格。',
      '// INV-17 已结算为零不占格子：守住位置 双零早退；改错故障 显示零步。',
      '// INV-18 单复数走不同消息键：守住位置 三元选择；改错故障 英文单复数错乱。',
      '//',
      '// 模块职责：把工作流运行的子代理花名册渲染成一行一人、按相位分叉的活动描述。',
      '// 状态所有权：无状态；子代理读数与生成时间全部由调用方传入。',
      '// 阅读顺序：先看状态色与行结构，再看在飞判定，最后看三类活动单元格。',
    ],
    blocks: [
      {
        anchor: 'const SUBAGENT_STATE_TEXT: Record<WorkflowRunSubagentView["state"], string> = {',
        lines: [
          '相位词始终显示，颜色只是第二通道。',
          '在动与停驻用活动色。',
          '完成与失败各用语义色。',
          '空闲与未完结用弱化色。',
        ],
      },
      {
        anchor: 'export function WorkflowRunSubagentRoster({',
        lines: [
          '空花名册整块不渲染。',
          '每行以站点与序号为键。',
          '匿名子代理不合成兜底名。',
          '任务行缩进表示从属关系。',
        ],
      },
      {
        anchor: 'function hasCurrentAsk(subagent: WorkflowRunSubagentView): boolean {',
        lines: [
          '扁平载荷没有当前提问标记。',
          '任一进度读数在场即视为在飞。',
          '全部缺席才走已结算分支。',
        ],
      },
      {
        anchor: 'function subagentActivity(',
        lines: [
          '停驻优先说出等哪个问题。',
          '等待与执行各自组装单元格。',
          '未完结但在飞单独成句。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/app-shell/WorkflowRunPhasePills.tsx',
    target: 35,
    header: [
      '// INV-01 工厂纯函数无状态：守住位置 返回三闭包；改错故障 每帧残留上一帧药丸。',
      '// INV-02 命名优先运行时名：守住位置 空值合并；改错故障 用户改名被泳道名覆盖。',
      '// INV-03 相位名缺失退回标识：守住位置 空值分支；改错故障 脚本入口显示空标签。',
      '// INV-04 站点查找按标识：守住位置 查找比较；改错故障 相位名取到相邻站。',
      '// INV-05 打开需回调与槽位同时具备：守住位置 双重判断；改错故障 点击无反应的药丸。',
      '// INV-06 会话标识有则随行无则占位：守住位置 条件展开；改错故障 打开错误会话。',
      '// INV-07 打开面板状态三态映射：守住位置 三元链；改错故障 失败被显示为等待。',
      '// INV-08 运行时名可缺席：守住位置 条件展开；改错故障 面板标题出现未定义值。',
      '// INV-09 打开语法二者择一：守住位置 三元链；改错故障 同一点击触发两种打开。',
      '// INV-10 无打开能力时不挂打开属性：守住位置 空值返回；改错故障 药丸看似可点。',
      '// INV-11 测试标识区分代理与脚本：守住位置 两个常量；改错故障 自动化无法区分入口。',
      '// INV-12 模型标题仅在已知时追加：守住位置 空值判断；改错故障 标题出现空行。',
      '// INV-13 活动计数只追加大于零项：守住位置 条件判断；改错故障 出现零任务零读取。',
      '// INV-14 问题列表按实例聚合：守住位置 映射查找；改错故障 问题挂到别人行下。',
      '// INV-15 问题归属缩进比行更深：守住位置 类名边距；改错故障 问题被读成新一行。',
      '// INV-16 药丸以时间线键作 React 键：守住位置 键属性；改错故障 重排后状态串位。',
      '// INV-17 尾槽同时给计数与模型名：守住位置 属性传递；改错故障 药丸缺少模型提示。',
      '// INV-18 渲染不读取全局时钟：守住位置 入参当前时间；改错故障 同帧不同药丸时间不一致。',
      '//',
      '// 模块职责：把工作流时间线药丸接到脊线上，提供命名、属性与渲染三个闭包。',
      '// 状态所有权：无状态；时间线模型、图数据与回调全部由调用方注入。',
      '// 阅读顺序：先看接口与命名，再看打开动作，最后看属性合成与渲染。',
    ],
    blocks: [
      {
        anchor: 'export interface PhasePillRenderers {',
        lines: [
          '三个闭包覆盖命名、属性与渲染。',
          '清单每帧调用一次工厂。',
          '工厂本身不持有状态。',
          '名称与打开动作解耦。',
        ],
      },
      {
        anchor: 'export function phasePillRenderers({',
        lines: [
          '药丸命名优先运行时名。',
          '相位名缺失时退回标识。',
          '站点查找只读时间线模型。',
        ],
      },
      {
        anchor: 'const openActor = (pill: TimelinePill) => {',
        lines: [
          '没有槽位或回调时不打开。',
          '会话标识有则随行，无则占位。',
          '三态状态映射到打开面板口径。',
        ],
      },
      {
        anchor: 'const renderPill = (pill: TimelinePill) => {',
        lines: [
          '活动计数为零不占格子。',
          '问题是行的从属，不是站点的。',
          '纵向布局让行拉满列宽。',
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
    `ZC-deep-b178-spec-${index}.json`,
    JSON.stringify({ files: [{ file: spec.file, items }] }, null, 2),
    'utf8',
  );
  console.log(`spec ${index}: ${spec.file} lines=${total}`);
  index += 1;
}
