// 为 L2-D9 批次剩余 4 个文件补注释（纯插入）
import fs from 'node:fs';

const ROOT = 'd:\\code\\claude-code-main';

const specs = [
  {
    rel: 'ink/termio.ts',
    header: [
      '// 阅读提示：termio 是整批 termio/ 子模块的稳定对外门面，把 Parser 实例与',
      '// 语义化动作类型（text/cursor/erase/link/mode/scroll/title）统一导出。',
      '// 在渲染链路中的位置：位于输入解析与终端能力探测之下，供 parse-keypress 与',
      '// terminal-querier 使用；本文件不含实现逻辑。',
      '// 边界：新增动作类型时需同时在 termio/types.ts 与这里导出，否则上层无法判别。',
    ],
    blocks: [
      ['export { Parser } from \'./termio/parser.js\'', [
        '// 职责：导出流式解析器 Parser（feed/flush 增量解析 ANSI 序列）。',
        '// 参数/返回值：在 termio/parser.ts 中定义，见其 JSDoc。',
        '// 边界：解析是纯函数式的（每次 feed 返回动作数组），不直接写终端。',
      ]],
      ['export type {', [
        '// 职责：集中回导出 termio/types 的动作与样式类型，避免上层依赖内部路径。',
        '// 参数：仅类型，无运行时开销。',
        '// 边界：这里是类型门面，改动会影响所有消费方的判别联合类型。',
      ]],
    ],
  },
  {
    rel: 'ink/reconciler.ts',
    header: [
      '// 阅读提示：本文件是 Ink 的 React 自定义渲染器（host config），把 React 元素',
      '// 映射到轻量 DOM 树（ink-box/ink-text/ink-virtual-text）并驱动 Yoga 布局。',
      '// 在渲染链路中的位置：React commit → 本文件写 DOM/props → resetAfterCommit',
      '// 调 onComputeLayout → onRender 走 render-node-to-output 绘制。',
      '// 关键不变量：属性更新必须 diff 后增量下发（style 走 applyStyles 局部更新），',
      '// 否则每次 commit 都全量重算样式会让长列表滚动卡死。',
      '// 反直觉：resetAfterCommit 在 test 环境走 onImmediateRender（同步），生产走',
      '// onRender（节流调度），因此测试断言的是即时快照而非帧缓存。',
    ],
    blocks: [
      ['const diff = (before: AnyObject, after: AnyObject): AnyObject | undefined => {', [
        '// 职责：计算 props 浅 diff，只返回变化的键（含被删除的键映射为 undefined）。',
        '// 参数：before/after - 旧/新 props 对象，允许 undefined。',
        '// 边界：引用相等即视为无变化；style 会被再 diff 一次以支持部分样式更新。',
      ]],
      ['export function getOwnerChain(fiber: unknown): string[] {', [
        '// 职责：沿 _debugOwner/return 上溯，收集渲染出该元素的组件名，供重绘调试。',
        '// 参数：fiber - createInstance 收到的第 5 个参数（React Fiber）。',
        '// 边界：最多 50 层并用 Set 防环；host 元素（字符串类型）跳过，仅 dev 构建有 owner。',
      ]],
      ['export function isDebugRepaintsEnabled(): boolean {', [
        '// 职责：读取 CLAUDE_CODE_DEBUG_REPAINTS 开关，结果缓存一次。',
        '// 参数：无。',
        '// 边界：环境变量只在首次调用时读取，运行中修改不生效。',
      ]],
      ['export function recordYogaMs(ms: number): void {', [
        '// 职责：记录最近一次布局（Yoga）耗时，供滚动性能基准读取。',
        '// 参数：ms - 布局毫秒数。',
        '// 边界：仅内存变量，重启即清零；并发渲染下后写覆盖前写。',
      ]],
      ['  resetAfterCommit(rootNode) {', [
        '// 职责：commit 收尾——先算布局，再按环境触发即时渲染或节流渲染。',
        '// 参数：rootNode - 根 DOM 元素，带 onComputeLayout/onRender 钩子。',
        '// 边界：test 环境空树且已渲染过时直接返回，避免卸载后重复输出；',
        '// COMMIT_LOG 分支只写日志，不影响主链路。',
      ]],
      ['  createInstance(', [
        '// 职责：为每个 React host 元素创建 DOM 节点并应用初始 props。',
        '// 参数：originalType - ink-box/ink-text 等；newProps - 初始属性；',
        '// internalHandle - Fiber，仅调试重绘时用于取 owner 链。',
        '// 边界：Text 内嵌 Box 直接抛错；Text 内再嵌 Text 会降级为 ink-virtual-text。',
      ]],
      ['  createTextInstance(', [
        '// 职责：创建纯文本节点，仅允许出现在 Text 子树中。',
        '// 参数：text - 文本内容；hostContext - 用于校验是否处于 Text 内。',
        '// 边界：Text 外裸字符串直接抛错，提示用 <Text> 包裹。',
      ]],
      ['  hideInstance(node) {', [
        '// 职责：隐藏节点——置 isHidden、把 Yoga display 设为 None 并标脏。',
        '// 参数：node - 目标 DOM 元素。',
        '// 边界：必须 markDirty，否则布局缓存不会重新计算导致旧位置仍被占用。',
      ]],
      ['  commitUpdate(', [
        '// 职责：props 变更时增量下发：style/textStyles/事件/普通属性分别处理。',
        '// 参数：oldProps/newProps - React 19 直接给新旧 props（无 updatePayload）。',
        '// 边界：普通属性逐键 setAttribute（值为 undefined 表示删除）；',
        '// style 走 applyStyles 的局部 diff，避免整块样式重算。',
      ]],
      ['  removeChild(node, removeNode) {', [
        '// 职责：移除子节点并释放其 Yoga 节点，同时通知焦点管理器修正焦点。',
        '// 参数：node - 父节点；removeNode - 被移除节点。',
        '// 边界：文本节点不参与焦点管理（nodeName === \'#text\' 跳过）。',
      ]],
    ],
  },
  {
    rel: 'ink/parse-keypress.ts',
    header: [
      '// 阅读提示：本文件把终端字节流解析成三类语义化输入：按键、鼠标、终端响应。',
      '// 在渲染链路中的位置：App.handleReadable 喂字节 → 这里的 tokenizer/解析 →',
      '// processKeysInBatch 分发给焦点、滚动、选择等上层处理器。',
      '// 关键不变量：tokenizer 跨调用持有缓冲（incomplete），不完整转义序列必须',
      '// 原样留到下一次 feed，否则方向键会被拆成 ESC + 字符；粘贴态内一切序列',
      '// 都按字面文本累积，只有 PASTE_END 才收口。',
      '// 反直觉：终端响应（CSI ?…$y、DA1、OSC 回复）与按键共用同一条输入流，',
      '// 只能靠语法区分；轮询回复绝不能当按键派发，否则会误触快捷键。',
    ],
    blocks: [
      ['const keyName: Record<string, string> = {', [
        '// 职责：把 xterm/gnome/kitty 等终端的历史键码别名映射到规范键名。',
        '// 参数：无（查表常量）。',
        '// 边界：未收录的别名会退化成原始序列，调用方需容错 name 为 undefined。',
      ]],
      ['export const INITIAL_STATE: KeyParseState = {', [
        '// 职责：解析器初始状态（非粘贴态、无滞留缓冲）。',
        '// 参数：无。',
        '// 边界：对象为共享常量，调用方必须只读，否则会污染后续解析。',
      ]],
      ['export function parseMultipleKeypresses(', [
        '// 职责：一次 feed 解析出多条输入，并返回新的解析状态。',
        '// 参数：prevState - 上一轮状态；input - 新字节；null 表示超时 flush。',
        '// 边界：flush 时把残留粘贴内容也吐出；孤立鼠标尾巴会补回 ESC 重新解析，',
        '// 但只兜底滚轮范围，避免把普通方括号文本误判成点击事件。',
      ]],
      ['export type ParsedInput = ParsedKey | ParsedMouse | ParsedResponse', [
        '// 职责：上层消费的输入判别联合，按 kind 分流：key/mouse/response。',
        '// 参数：无（类型别名）。',
        '// 边界：新增 kind 需同步更新 App 的分发逻辑，否则会被静默丢弃。',
      ]],
      ['function parseKeypress(s: string = \'\'): ParsedKey {', [
        '// 职责：把单个序列解析成按键，覆盖 CSI u、modifyOtherKeys、功能键、鼠标滚轮。',
        '// 参数：s - 原始序列，缺省空串表示无输入。',
        '// 边界：识别不了时退化为单字符键；大小写与 Ctrl 修饰在 raw 文本上推断。',
      ]],
    ],
  },
  {
    rel: 'ink/selection.ts',
    header: [
      '// 阅读提示：本文件维护全屏模式下的文本选区（锚点+焦点、拖拽/多击/键盘扩展）。',
      '// 在渲染链路中的位置：App 的鼠标/键盘事件调用这里改状态 → onRender 里',
      '// applySelectionOverlay 直接改屏幕单元样式 → diff 引擎无感知地绘制高亮。',
      '// 关键不变量：选区用「屏幕坐标」而非内容坐标；内容滚动时必须整体平移，',
      '// 滚出视口的行由 captureScrolledRows 先捕获，否则复制文本会丢行。',
      '// 反直觉：只高不成选——按下未拖动时 focus 为 null，裸点击不会选中任何单元；',
      '// noSelect 单元（行号栏、diff 标记）参与布局但不参与选中与复制。',
    ],
    blocks: [
      ['export function createSelectionState(): SelectionState {', [
        '// 职责：构造空白选区状态（无锚点、未拖拽）。',
        '// 参数：无。',
        '// 边界：返回新对象，调用方可直接持有，不与其他实例共享。',
      ]],
      ['export function startSelection(', [
        '// 职责：鼠标按下时设锚点并进入拖拽态。',
        '// 参数：s - 选区状态；col/row - 屏幕坐标。',
        '// 边界：此刻不设 focus，单纯点击不产生 1 格选区；会清掉上次的累积与虚拟行。',
      ]],
      ['export function updateSelection(', [
        '// 职责：拖拽移动时更新焦点。',
        '// 参数：s - 选区状态；col/row - 当前鼠标位置。',
        '// 边界：未处于拖拽直接忽略；首次移动仍落在锚点格时不动，避免把点击变成选中。',
      ]],
      ['export function finishSelection(s: SelectionState): void {', [
        '// 职责：松开鼠标时结束拖拽，但保留选区以便高亮与复制。',
        '// 参数：s - 选区状态。',
        '// 边界：仅清 isDragging；清空需显式 clearSelection。',
      ]],
      ['export function clearSelection(s: SelectionState): void {', [
        '// 职责：彻底清空选区及所有滚动累积、虚拟行与修饰键标记。',
        '// 参数：s - 选区状态。',
        '// 边界：字段全部复位，避免残留累积行污染下一次复制。',
      ]],
      ['export function selectWordAt(', [
        '// 职责：双击选词——按 iTerm2 风格词界选中整词并记录 anchorSpan。',
        '// 参数：s - 选区状态；screen - 屏幕缓冲；col/row - 点击位置。',
        '// 边界：点不到词（空白/noSelect）直接返回，不改动现有选区。',
      ]],
      ['export function selectLineAt(', [
        '// 职责：三击选行——整行从头到尾，并记录 line 类型 anchorSpan。',
        '// 参数：s - 选区状态；screen - 屏幕缓冲；row - 目标行。',
        '// 边界：行越界直接返回；后续拖拽会按整行扩展。',
      ]],
      ['export function extendSelection(', [
        '// 职责：多击模式下把选区从原始词/行扩展到鼠标当前所在词/行。',
        '// 参数：s - 选区状态；screen - 屏幕缓冲；col/row - 鼠标位置。',
        '// 边界：无 anchorSpan 时不生效；鼠标在原始跨度内则退回只选原始跨度。',
      ]],
      ['export function moveFocus(s: SelectionState, col: number, row: number): void {', [
        '// 职责：键盘扩展选区——固定锚点、移动焦点。',
        '// 参数：s - 选区状态；col/row - 已由调用方做边界/换行处理的坐标。',
        '// 边界：无焦点（未开始选区）直接返回；会清 anchorSpan 退化为按字符扩展。',
      ]],
      ['export function shiftSelection(', [
        '// 职责：键盘滚动时把锚点与焦点同向平移 dRow，越界处夹到视口边界。',
        '// 参数：s - 选区状态；dRow - 行增量；minRow/maxRow - 可平移范围；width - 行宽。',
        '// 边界：两端同时越过同一侧边界时清空选区，避免残留 1 格幽灵高亮；',
        '// 被夹住的一端列号会重置到整行边界，因为原内容已滚出视口并被捕获。',
      ]],
      ['export function shiftAnchor(', [
        '// 职责：拖拽滚动时只平移锚点，焦点保持跟随鼠标。',
        '// 参数：s - 选区状态；dRow - 行增量；minRow/maxRow - 视口范围。',
        '// 边界：虚拟行记录夹断前的真实位置，供反向滚动还原；anchorSpan 同步平移。',
      ]],
      ['export function shiftSelectionForFollow(', [
        '// 职责：自动跟随滚动时整体平移选区（两端都随内容移动）。',
        '// 参数：s - 选区状态；dRow - 行增量；minRow/maxRow - 视口范围。',
        '// 边界：两端都滚出顶部时清空并返回 true，调用方需直接通知订阅者；',
        '// 恰好落在 minRow 仍有效，不清空。',
      ]],
      ['export function selectionBounds(s: SelectionState): {', [
        '// 职责：把锚点/焦点归一化为阅读顺序的 start/end。',
        '// 参数：s - 选区状态。',
        '// 边界：任一端缺失返回 null，调用方据此判定无选区。',
      ]],
      ['export function isCellSelected(', [
        '// 职责：判断某屏幕单元是否落在选区内（按行包含列区间）。',
        '// 参数：s - 选区状态；col/row - 屏幕坐标。',
        '// 边界：首行左界与末行右界为开区间约束，中间行整行选中。',
      ]],
      ['export function getSelectedText(s: SelectionState, screen: Screen): string {', [
        '// 职责：把选区转成可复制文本，按软换行拼回逻辑行，并前置/后接滚出视口的行。',
        '// 参数：s - 选区状态；screen - 当前屏幕缓冲。',
        '// 边界：无选区返回空串；noSelect 与宽字符占位单元跳过，避免复制出重复字符。',
      ]],
      ['export function captureScrolledRows(', [
        '// 职责：在 scrollBy 覆盖之前，把即将滚出视口且属于选区的行文本存起来。',
        '// 参数：s - 选区状态；screen - 屏幕缓冲；firstRow/lastRow - 滚出行范围；',
        '// side - above（顶部滚出）或 below（底部滚出）。',
        '// 边界：只捕获与选区相交的行；捕获锚点行后重置锚点列与 span 列，',
        '// 否则后续捕获会被陈旧列约束截断，导致高亮与复制内容不一致。',
      ]],
      ['export function applySelectionOverlay(', [
        '// 职责：把选区内单元的背景换成实心高亮色，交给 diff 引擎自然绘制。',
        '// 参数：screen - 屏幕缓冲；selection - 选区状态；stylePool - 样式池。',
        '// 边界：跳过 noSelect 单元；保留原前景色，仅替换背景，避免语法色被切成色带。',
      ]],
      ['export function findPlainTextUrlAt(', [
        '// 职责：在屏幕上查找鼠标位置的纯文本 URL，作为 OSC 8 链接的兜底。',
        '// 参数：screen - 屏幕缓冲；col/row - 屏幕坐标。',
        '// 边界：仅识别 ASCII 单宽字符，命中非 ASCII/宽字符即视为边界；',
        '// 取点击点之前最近的 scheme，避免把逗号相连的两个 URL 一起返回。',
      ]],
    ],
  },
];

function insert(lines, blocks, rel) {
  let out = lines.slice();
  for (const [anchor, block] of blocks) {
    const idx = out.findIndex((l) => l === anchor);
    if (idx < 0) {
      console.log(`ANCHOR-MISS ${rel}: ${anchor}`);
      process.exit(1);
    }
    const indent = anchor.match(/^[ \t]*/)[0];
    const inserted = [indent, ...block.map((c) => indent + c)];
    out = [...out.slice(0, idx), ...inserted, ...out.slice(idx)];
  }
  return out;
}

for (const spec of specs) {
  const raw = fs.readFileSync(`${ROOT}\\${spec.rel}`, 'utf8');
  const lines = raw.split('\n');
  let out = insert(lines, spec.blocks, spec.rel);
  // 文件头插到最顶部，空行分隔
  out = [...spec.header, '', ...out];
  fs.writeFileSync(`${ROOT}\\${spec.rel}`, out.join('\n'), 'utf8');
  console.log(`${spec.rel}: ${lines.length} -> ${out.length}`);
}
