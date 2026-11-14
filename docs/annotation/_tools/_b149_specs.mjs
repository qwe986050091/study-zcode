import fs from 'node:fs';

const specs = [
  {
    file: 'packages/ui/src/ToolCallBlocks/renderers/task-output.tsx',
    target: 39,
    header: [
      '// INV-01 对象与 JSON 字符串都能解析：守住位置 toRecord；改错故障 输入字段全部丢失。',
      '// INV-02 数组与标量视为无效：守住位置 类型判断；改错故障 数组被当成记录。',
      '// INV-03 解析失败返回空：守住位置 catch；改错故障 非法输入导致整块崩溃。',
      '// INV-04 任务标识只认非空串：守住位置 readTaskId；改错故障 数字 id 被强转。',
      '// INV-05 失败状态两种：守住位置 failed 与 lost；改错故障 丢失任务显示成功。',
      '// INV-06 停止状态三种：守住位置 三个词；改错故障 取消被当成完成。',
      '// INV-07 拒绝与停止不算失败：守住位置 showFailureStatus；改错故障 用户主动中止被染红。',
      '// INV-08 输出存在才渲染内容：守住位置 hasOutput；改错故障 空内容仍占位。',
      '// INV-09 状态标签有优先级：守住位置 分支顺序；改错故障 具体原因被通用状态覆盖。',
      '// INV-10 未知任务态回退原文：守住位置 末段判断；改错故障 标签为空。',
      '// INV-11 成功读取需显式检索状态：守住位置 retrievalStatus；改错故障 未读取也显示已获取。',
      '// INV-12 类别标签随运行切换：守住位置 kindLabel；改错故障 运行中仍显示类型名。',
      '// INV-13 主文本优先任务标识：守住位置 primaryText；改错故障 标题掩盖真实任务。',
      '// INV-14 回调依赖完整：守住位置 依赖数组；改错故障 截断状态陈旧。',
      '// INV-15 快照引用缺省为空：守住位置 空数组兜底；改错故障 访问 undefined 报错。',
      '// INV-16 加载完整字段按需回调：守住位置 可选调用；改错故障 无回调时按钮可点。',
      '// INV-17 失败提示仅传错误文本：守住位置 statusTooltip；改错故障 成功状态也带提示。',
      '// INV-18 图标常量共享：守住位置 模块常量；改错故障 每次渲染新建元素。',
      '//',
      '// 模块职责：渲染 TaskOutput 工具调用块，汇总任务标识、状态与输出内容。',
      '// 状态所有权：展示数据全部来自工具调用与结果；组件无本地状态。',
      '// 阅读顺序：先看记录归一与状态判定，再看标签优先级，最后看内容渲染。',
    ],
    blocks: [
      {
        anchor: 'function toRecord(value: unknown): Record<string, unknown> | undefined {',
        lines: [
          '对象直接透传。',
          '字符串按 JSON 解析。',
          '数组与标量视为无效。',
          '解析失败返回空。',
        ],
      },
      {
        anchor: 'export function TaskOutputToolCallBlock(context: ToolCallBlockRenderContext) {',
        lines: [
          '图标与布局复用通用块。',
          '状态标签由多重判定得出。',
          '无输出时折叠内容区。',
          '快照字段缺失走通用提示。',
        ],
      },
      {
        anchor: 'const showFailureStatus = !isDenied && !isStopped && (isExecutionFailed || isTaskFailed);',
        lines: [
          '拒绝与停止不算失败。',
          '任务态失败也算失败。',
          '失败状态驱动警示样式。',
        ],
      },
      {
        anchor: 'let outcomeLabel: string | undefined;',
        lines: [
          '分支顺序即优先级。',
          '先具体状态后通用状态。',
          '命中后不再继续判断。',
        ],
      },
      {
        anchor: 'const renderContent = useCallback(',
        lines: [
          '仅在有输出时传入。',
          '内容区展示原始输出。',
          '截断提示附在末尾。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/v4/ConversationSelectionTooltip.tsx',
    target: 39,
    header: [
      '// INV-01 四种行映射四类内容：守住位置 contentTypeForRow；改错故障 引用类型与来源不符。',
      '// INV-02 未知行不可引用：守住位置 末尾返回空；改错故障 系统行被选中。',
      '// INV-03 文本节点先取父元素：守住位置 closestRowElement；改错故障 选区端点找不到行。',
      '// INV-04 行标识来自数据集：守住位置 最近祖先；改错故障 跨行选择定位错误。',
      '// INV-05 行集合引用常新：守住位置 rowsRef；改错故障 回调读到旧行。',
      '// INV-06 关闭时不做检查：守住位置 enabled；改错故障 关闭后仍弹菜单。',
      '// INV-07 折叠选区不处理：守住位置 isCollapsed；改错故障 光标点击弹出菜单。',
      '// INV-08 只接受单一范围：守住位置 rangeCount；改错故障 多段选择位置错乱。',
      '// INV-09 控件端点先排除：守住位置 端点判断；改错故障 表格工具按钮参与引用。',
      '// INV-10 可选区域必须同段：守住位置 sameSelectableRegion；改错故障 跨区块引用不完整。',
      '// INV-11 同行是硬条件：守住位置 sameRow；改错故障 跨行文本被拼接。',
      '// INV-12 内容类型必须受支持：守住位置 supportedContent；改错故障 未知内容生成引用。',
      '// INV-13 文本非空才继续：守住位置 text；改错故障 空引用进入菜单。',
      '// INV-14 布局尺寸必须为正：守住位置 hasLayout；改错故障 零尺寸时菜单飘到角落。',
      '// INV-15 单行超限返回错误态：守住位置 single-limit；改错故障 超限内容仍可引用。',
      '// INV-16 引用对象集中构造：守住位置 createConversationSelectionReference；改错故障 字段散落易漏。',
      '// INV-17 会话标识随选择写入：守住位置 sourceSessionId；改错故障 引用指向错误会话。',
      '// INV-18 菜单动作后立即关闭：守住位置 close；改错故障 菜单停留遮挡内容。',
      '//',
      '// 模块职责：检测对话文本选区并弹出引用动作菜单。',
      '// 状态所有权：选区事实来自浏览器；菜单可见性归 useTextSelection。',
      '// 阅读顺序：先看行与内容映射，再看选区门禁，最后看引用构造与菜单渲染。',
    ],
    blocks: [
      {
        anchor: 'function contentTypeForRow(row: ConversationRow): ConversationSelectionContentType | null {',
        lines: [
          '四种行类型映射四类内容。',
          '工具调用也算可选内容。',
          '其他行不允许引用。',
        ],
      },
      {
        anchor: 'function closestRowElement(node: Node | null): HTMLElement | null {',
        lines: [
          '文本节点先取父元素。',
          '向上查找行标识。',
          '无标识返回空。',
        ],
      },
      {
        anchor: 'const rowsRef = useRef(rows);',
        lines: [
          '引用持有最新行集合。',
          '每次渲染同步。',
          '回调内不依赖旧闭包。',
        ],
      },
      {
        anchor: 'const inspectSelection = useCallback((): TooltipState | null => {',
        lines: [
          '关闭时直接返回空。',
          '折叠选区返回空。',
          '选择必须只有一个范围。',
          '结果同时用于定位与门禁。',
        ],
      },
      {
        anchor: 'const guardResult = guardConversationSelectionCandidate({',
        lines: [
          '同行、时间线与可选区都要满足。',
          '控件端点先排除。',
          '文本与布局都需有效。',
          '门禁结果决定后续分支。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/v4/ConversationUserInputBody.tsx',
    target: 40,
    header: [
      '// INV-01 折叠高度统一常量：守住位置 模块常量；改错故障 各处高度不一致。',
      '// INV-02 溢出判断带一像素容差：守住位置 isUserInputContentOverflowing；改错故障 临界值反复闪烁。',
      '// INV-03 展开高度不小于折叠高度：守住位置 resolveUserInputContentMaxHeight；改错故障 展开后内容被裁。',
      '// INV-04 收起态固定为折叠高度：守住位置 分支；改错故障 收起仍显示全高。',
      '// INV-05 内容变化即收起：守住位置 effect 依赖；改错故障 换消息后沿用展开态。',
      '// INV-06 高度仅在变化时写入：守住位置 条件 set；改错故障 每次测量触发重渲染。',
      '// INV-07 展开后不再改可展开性：守住位置 expanded 判断；改错故障 展开中按钮消失。',
      '// INV-08 通知按帧合并：守住位置 animationFrameRef；改错故障 长会话测量堆积。',
      '// INV-09 同一消息只排一帧：守住位置 早退分支；改错故障 重复申请帧。',
      '// INV-10 帧号零表示在途：守住位置 哨兵值；改错故障 并发申请覆盖帧号。',
      '// INV-11 尺寸观察优先：守住位置 ResizeObserver；改错故障 内容变化不更新。',
      '// INV-12 不支持时监听窗口：守住位置 回退分支；改错故障 旧环境高度失效。',
      '// INV-13 清理释放观察与监听：守住位置 返回闭包；改错故障 卸载后仍回调。',
      '// INV-14 在途帧必须取消：守住位置 cancelAnimationFrame；改错故障 卸载后访问节点。',
      '// INV-15 引用始终指向最新节点：守住位置 contentRef；改错故障 测量旧节点。',
      '// INV-16 按钮标签随状态切换：守住位置 toggleLabel；改错故障 展开后仍写展开。',
      '// INV-17 按钮带展开语义：守住位置 aria-expanded；改错故障 读屏不知当前状态。',
      '// INV-18 内容容器标记可选：守住位置 data 属性；改错故障 选区引用无法定位。',
      '//',
      '// 模块职责：渲染用户输入正文，按内容高度提供折叠与展开。',
      '// 状态所有权：高度与展开态为组件局部状态；正文由 props 传入。',
      '// 阅读顺序：先看三个纯函数，再看测量 effect，最后看渲染树。',
    ],
    blocks: [
      {
        anchor: 'export const COLLAPSED_USER_INPUT_CONTENT_MAX_HEIGHT_PX = 120;',
        lines: [
          '折叠高度是统一常量。',
          '超出即出现展开按钮。',
          '展开高度按内容测量。',
        ],
      },
      {
        anchor: 'export function isUserInputContentOverflowing(scrollHeight: number): boolean {',
        lines: [
          '加一像素容差。',
          '避免边界反复抖动。',
          '纯函数便于独立测试。',
        ],
      },
      {
        anchor: 'const [contentScrollHeight, setContentScrollHeight] = useState(',
        lines: [
          '初始值等于折叠高度。',
          '仅在变化时更新。',
          '供展开高度计算使用。',
        ],
      },
      {
        anchor: 'setExpanded(false);',
        lines: [
          '内容或行变化即收起。',
          '避免旧展开态沿用。',
          '依赖文本与行标识。',
        ],
      },
      {
        anchor: 'const scheduleOverflowUpdate = () => {',
        lines: [
          '同一消息只排一帧。',
          '通过帧号合并通知。',
          '兼容测试中的同步帧。',
        ],
      },
      {
        anchor: 'let observer: ResizeObserver | null = null;',
        lines: [
          '优先使用尺寸观察。',
          '不支持时退回窗口监听。',
          '清理时两者都释放。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/v4/featureSuggestedPromptRotation.ts',
    target: 39,
    header: [
      '// INV-01 每个面板独立游标：守住位置 panes；改错故障 换一批互相干扰。',
      '// INV-02 面板注销即删条目：守住位置 unregister；改错故障 内存与避重集合残留。',
      '// INV-03 修订号单调递增：守住位置 revision；改错故障 订阅方不刷新。',
      '// INV-04 通知逐个调用：守住位置 notify；改错故障 某个订阅异常阻断其他。',
      '// INV-05 订阅返回退订函数：守住位置 subscribe；改错故障 组件卸载后仍被通知。',
      '// INV-06 同 id 同模式直接返回：守住位置 早退分支；改错故障 重建面板丢失游标。',
      '// INV-07 换模式保留游标：守住位置 existing 游标；改错故障 切换布局后候选重头开始。',
      '// INV-08 注册后立即选批：守住位置 selectForPane；改错故障 首次渲染为空。',
      '// INV-09 避重只看同模式面板：守住位置 usedByOtherPanes；改错故障 办公与编码互相耗尽。',
      '// INV-10 三个集合同时避重：守住位置 返回元组；改错故障 同图标或同插件重复出现。',
      '// INV-11 插件标识来自稳定字段：守住位置 pluginIds；改错故障 同插件不同提示共存。',
      '// INV-12 旧式插件标记也解析：守住位置 文本匹配；改错故障 历史提示绕过避重。',
      '// INV-13 图标键优先 URL：守住位置 iconKey；改错故障 同名图标被误判相同。',
      '// INV-14 环形候选自游标开始：守住位置 取模；改错故障 换一批总从首项开始。',
      '// INV-15 每批最多三个：守住位置 上限判断；改错故障 候选区高度失控。',
      '// INV-16 先避重后放宽：守住位置 双层循环；改错故障 候选不足时直接重复。',
      '// INV-17 放宽时仍避免同屏冲突：守住位置 本地集合；改错故障 同批出现重复图标。',
      '// INV-18 选中后回写全局集合：守住位置 末尾循环；改错故障 后续面板无法避重。',
      '//',
      '// 模块职责：维护各面板的建议提示候选与换一批游标。',
      '// 状态所有权：面板表、订阅者与修订号均为模块级状态。',
      '// 阅读顺序：先看面板注册与换批，再看避重集合，最后看候选选择。',
    ],
    blocks: [
      {
        anchor: 'const panes = new Map<string, Pane>();',
        lines: [
          '每个面板独立游标。',
          '同模式面板互相避重。',
          '注销即删除条目。',
        ],
      },
      {
        anchor: 'function notify() {',
        lines: [
          '修订号单调递增。',
          '逐个通知订阅者。',
          '通知不携带快照。',
        ],
      },
      {
        anchor: 'export function registerRecommendedPromptPane(id: string, mode: Mode) {',
        lines: [
          '同 id 同模式直接返回。',
          '保留原游标便于重启。',
          '注册即选一批候选。',
          '选完立即通知。',
        ],
      },
      {
        anchor: 'function usedByOtherPanes(id: string, mode: Mode): [Set<string>, Set<string>, Set<string>] {',
        lines: [
          '只看同模式的其他面板。',
          '同时收集标识、插件与图标。',
          '三个集合分别用于避重。',
          '返回顺序与消费方一致。',
        ],
      },
      {
        anchor: 'function selectForPane(',
        lines: [
          '候选从游标处环形展开。',
          '每批最多选择三个。',
          '先严格避重再逐步放宽。',
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
    `ZC-deep-b149-spec-${index}.json`,
    JSON.stringify({ files: [{ file: spec.file, items }] }, null, 2),
    'utf8',
  );
  console.log(`spec ${index}: ${spec.file} lines=${total}`);
  index += 1;
}
