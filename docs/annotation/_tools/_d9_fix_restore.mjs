// 修复 App.tsx / ink.tsx 的非纯增量问题：恢复基线后再以纯插入方式补回注释
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'd:\\code\\claude-code-main';
const BASE = 'd:\\code\\_annot_baseline\\CC-L2-D9-Ink渲染器-1';

const appBlocks = [
  ['type Props = {', [
    '// 阅读提示：App 是 Ink 应用的最内层根组件，负责「stdin 字节 → ParsedInput →',
    '// DOM 事件/业务回调」的整条输入链路，同时管理 raw mode、光标与终端模式开关。',
    '// 上游：ink.tsx 挂载它并注入 selection/click/mouse 等回调；下游：reconciler',
    '// 的 discreteUpdates 驱动 React，EventEmitter 兼容旧的 useInput 语义。',
    '// 关键不变量：raw mode 是可重入计数（多个组件可同时请求），只有计数归零',
    '// 才真正关闭；同一时刻只能有一个 readable 监听者（先停 earlyInput）。',
    '// 反直觉：Ctrl+C 退出只在 handleInput 兜底处理，Ctrl+Z 挂起改在',
    '// processKeysInBatch 处理，以兼容 Kitty CSI-u 格式。',
    '// 终端意外重置（tmux attach/ssh 重连/睡眠唤醒）没有信号通知，',
    '// 因此靠 stdin 5s 静默后首包触发 onStdinResume 重新声明模式。',
  ]],
  ['  handleSetRawMode = (isEnabled: boolean): void => {', [
    '// 职责：按引用计数开启/关闭 raw mode 及配套终端模式（括号粘贴、焦点上报、',
    '// 扩展键盘），首次开启时探测终端身份。',
    '// 参数：isEnabled - true 增加计数，false 减少计数。',
    '// 边界：stdin 非 TTY 直接抛错（原生 stdin 与自定义 stdin 给不同提示）；',
    '// 计数归零前不真正关闭；setEncoding(\'utf8\') 每次都会调用（幂等）。',
    '// 扩展键盘只在 supportsExtendedKeys() 为真时下发，tmux 只认 modifyOtherKeys。',
  ]],
  ['  flushIncomplete = (): void => {', [
    '// 职责：超时兜底——把滞留的不完整转义序列当作已结束来解析。',
    '// 参数：无。',
    '// 边界：若 stdin 仍有可读数据，说明只是事件循环被渲染阻塞，重新计时而非',
    '// 立即 flush（否则会把真实方向键误判成裸 ESC，并丢掉滚动事件）。',
    '// 反直觉：timers 阶段先于 poll 阶段执行，所以这里必须检查 readableLength。',
  ]],
  ['  processInput = (input: string | Buffer | null): void => {', [
    '// 职责：解析一段输入，并把这一批按键放进同一个 discreteUpdates 批次。',
    '// 参数：input - 原始字符串/Buffer；null 表示 flush 当前不完整状态。',
    '// 边界：必须整批更新，否则粘贴大量文本会触发 Maximum update depth exceeded；',
    '// 剩余不完整序列会重设定时器，粘贴态用 500ms、普通态 50ms。',
  ]],
  ['  handleReadable = (): void => {', [
    '// 职责：stdin readable 回调——批量 drain 全部可读数据并交给解析器。',
    '// 参数：无。',
    '// 边界：进入前先检查 5s 静默，必要时重声明终端模式；异常必须 catch 并',
    '// 重新挂监听（Bun 下未捕获异常会让 stream 永久卡死、readable 不再触发）。',
  ]],
  ['  handleInput = (input: string | undefined): void => {', [
    '// 职责：兼容路径下的单键回调，仅处理 Ctrl+C 退出。',
    '// 参数：input - 原始按键字符串（可能是 undefined）。',
    '// 边界：仅当 exitOnCtrlC 为真才退出；其余按键（含 Ctrl+Z）不在这里处理，',
    '// 由 processKeysInBatch 基于解析后的键统一处理。',
  ]],
  ['  handleExit = (error?: Error): void => {', [
    '// 职责：统一退出入口——先关 raw mode 再回调 onExit。',
    '// 参数：error - 可选错误，作为退出原因透传。',
    '// 边界：raw mode 不支持时跳过关闭；不会自行 process.exit，',
    '// 真正的进程退出由上层 onExit 实现决定。',
  ]],
  ['  handleTerminalFocus = (isFocused: boolean): void => {', [
    '// 职责：把终端焦点事件写入全局焦点状态。',
    '// 参数：isFocused - 终端是否获得焦点。',
    '// 边界：刻意不 setState，靠订阅者（TerminalFocusProvider / Clock）自行响应，',
    '// 避免焦点抖动导致整棵 App 重渲染。',
  ]],
  ['  handleSuspend = (): void => {', [
    '// 职责：挂起进程（Ctrl+Z）前完整还原终端状态，SIGCONT 后恢复原状。',
    '// 参数：无。',
    '// 边界：仅 Unix（Windows 无 SIGSTOP）；先记录 raw mode 计数再逐个关闭，',
    '// 恢复时按同样次数重新开启；挂起前必须显示光标+关焦点+关鼠标追踪，',
    '// 否则 shell 提示符下会冒出 SGR 鼠标乱码；resume 后自移除监听防泄漏。',
  ]],
  ['function processKeysInBatch(app: App, items: ParsedInput[], _unused1: undefined, _unused2: undefined): void {', [
    '// 职责：在单个 React 批次把一批 ParsedInput 依次分发给各类处理器。',
    '// 参数：app - 所属 App 实例；items - 已解析的多条输入。',
    '// 边界：仅用户真实输入会刷新交互时间戳（终端响应、被动鼠标移动不算）；',
    '// Ctrl+Z 在这里处理以兼容 Kitty CSI-u；鼠标事件转交 handleMouseEvent。',
  ]],
  ['export function handleMouseEvent(app: App, m: ParsedMouse): void {', [
    '// 职责：把解析后的鼠标事件（点击/拖拽/滚轮/移动）翻译成选择、点击派发、',
    '// hover、超链接打开等高层动作。',
    '// 参数：app - 所属 App 实例；m - 已解析鼠标事件。',
    '// 边界：单击会延迟 MULTI_CLICK_TIMEOUT_MS 打开浏览器，双击可取消；',
    '// 多击选中在按下瞬间触发，拖拽按 char/word/line 模式扩展；',
    '// 非全屏模式下 click/hover 派发是 no-op。',
  ]],
];

const inkBlocks = [
  ['export type Options = {', [
    '// 阅读提示：Ink 实例是渲染链路的「总调度器」——持有 React 根、双缓冲 Frame、',
    '// LogUpdate 与终端句柄，负责布局→绘制→diff→写终端以及 alt-screen/暂停/卸载。',
    '// 上游：render()/renderSync 等入口创建它，App 组件负责输入侧；',
    '// 下游：renderer（screen+fiber）、renderNodeToOutput、terminal.writeDiffToTerminal。',
    '// 关键不变量：frontFrame 是「终端当前显示的内容」，backFrame 是新帧，二者',
    '// 在两帧交错处交换；任何直接写 stdout 的动作（切屏/光标）都要与 diff 协调。',
    '// 反直觉：onRender 用 lodash throttle 而非 rAF，FS 调度以 FRAME_INTERVAL_MS 为准；',
    '// 暂停(isPaused)时仍接受脏标记但不绘帧，resume 后由 repaint 补一帧。',
    '// alt-screen 下光标位置恒在 (rows,1)（末尾），因此锚点光标被冻结复用。',
  ]],
  ['  constructor(private readonly options: Options) {', [
    '// 职责：初始化 React 并发根、双缓冲、节流后的 scheduleRender 与退出钩子。',
    '// 参数：options - 三条流、exitOnCtrlC、patchConsole、onFrame 回调等。',
    '// 边界：会把实例注册到 instances（按 stdout 键）；构建时即创建空帧，',
    '// 首帧之前 frontFrame/backFrame 都是空屏幕；调度函数自身节流，',
    '// 调用方可以每个 DOM 变更都无脑调用。',
  ]],
  ['  enterAlternateScreen(): void {', [
    '// 职责：进入备用屏并清空历史帧，使下一次渲染从头绘制整屏。',
    '// 参数：无。',
    '// 边界：只在 TTY 下生效；写 1049 序列后必须重置 front/back frame，',
    '// 否则 diff 会以为备用屏上已有旧内容，产生花屏；鼠标追踪由调用方另开。',
  ]],
  ['  exitAlternateScreen(): void {', [
    '// 职责：外部 TUI（vim/nano/less）交还控制后恢复 Ink 的屏幕与终端模式。',
    '// 参数：无。',
    '// 边界：非全屏时退出备用屏回主屏；全屏时先重新进入备用屏（编辑器的 rmcup',
    '// 会把我们丢到主屏），再 2J+回家并重建帧缓存，避免擦掉用户 scrollback。',
    '// 焦点上报与扩展键盘要「先 pop 再 push」，保持 Kitty 栈深度平衡。',
  ]],
  ['  onRender() {', [
    '// 职责：渲染一帧——布局/绘制/选中高亮/diff 写终端，并回报帧事件。',
    '// 参数：无。',
    '// 边界：卸载或暂停时直接返回；进入前会取消待执行的 drain tick，防止',
    '// 「滚轮渲染」和「drain 定时器」重复绘同一帧；自动跟随滚动时会先把即将',
    '// 滚出视口的行捕获进选区，并按 delta 平移锚点（拖拽中只移锚点）。',
    '// 反直觉：frontFrame 在这一刻仍持有上一帧屏幕，因此 captureScrolledRows',
    '// 必须在 swap 之前执行；选区两侧都必须在 scrollbox 内才整体平移，',
    '// 跨边界选区故意不动，防止高亮从 footer 瞬移到内容区。',
  ]],
  ['  pause(): void {', [
    '// 职责：暂停前先把待处理的 React 更新 flush 并绘最后一帧，再置暂停位。',
    '// 参数：无。',
    '// 边界：flushSyncFromReconciler 是社区类型缺失的 API（有 ts-expect-error）；',
    '// 暂停后 onRender 直接 return，但 DOM 仍可继续变更。',
  ]],
  ['  resume(): void {', [
    '// 职责：恢复渲染并立即补绘一帧（与 pause 成对）。',
    '// 参数：无。',
    '// 边界：会同步调用 onRender，因此 resume 之后无需再手动 repaint；',
    '// 若终端内容在暂停期间被外部破坏，仍应先 forceRedraw/repaint。',
  ]],
  ['  repaint(): void {', [
    '// 职责：重置双缓冲与行记账后整屏重绘（终端内容可能被外部破坏时调用）。',
    '// 参数：无。',
    '// 边界：会重建空帧并 log.reset()，因此不是增量 diff，而是从头绘制；',
    '// 光标物理位置未知，所以还要额外下发回家序列。',
  ]],
  ['  forceRedraw(): void {', [
    '// 职责：丢弃帧缓存并整屏重绘，用于终端内容可能被外部破坏的场景。',
    '// 参数：无。',
    '// 边界：会把 frontFrame 置空，避免 diff 基于错误基线；代价是整屏输出。',
  ]],
  ['  setAltScreenActive(active: boolean, mouseTracking = false): void {', [
    '// 职责：切换全屏（备用屏）模式并按需开启鼠标追踪。',
    '// 参数：active - 是否进入全屏；mouseTracking - 是否同时开启 SGR 鼠标。',
    '// 边界：重复设为相同值不重复写序列；退出时必须先关鼠标再退屏，',
    '// 否则残留追踪会让 shell 收到乱码；切换会重置帧缓存。',
  ]],
  ['  reassertTerminalModes = (includeAltScreen = false): void => {', [
    '// 职责：重新声明终端模式（扩展键盘/焦点上报，可选重进备用屏与鼠标）。',
    '// 参数：includeAltScreen - 是否连同备用屏一起重进。',
    '// 边界：幂等，可在 tmux attach/ssh 重连后安全调用；依赖 supportsExtendedKeys()',
    '// 决定是否下发 Kitty 序列，不影响已有帧内容。',
  ]],
  ['  detachForShutdown(): void {', [
    '// 职责：进程退出前的同步止损——取消待绘帧、关 raw mode、清空 stdin。',
    '// 参数：无。',
    '// 边界：走短路路径，不依赖 React 的 componentWillUnmount；必须用',
    '// options.stdin 而非 process.stdin（stdin 被管道时可能已切到 /dev/tty）。',
    '// 置位 isUnmounted 后所有渲染调用都会立即返回。',
  ]],
  ['  drainStdin(): void {', [
    '// 职责：实例级 drain 包装，见模块底部 drainStdin。',
    '// 参数：无。',
    '// 边界：只作用于本实例绑定的 stdin，不碰 process.stdin；非 TTY 直接返回。',
  ]],
  ['  private writeRaw(data: string): void {', [
    '// 职责：把原始字符串直接写进 stdout，供 TerminalWriteContext 消费方使用。',
    '// 参数：data - 已拼好的转义序列或文本。',
    '// 边界：完全不走 diff/行记账，调用方必须自行保证不破坏 Ink 的屏幕假设',
    '// （例如 OSC 标题/标签状态这类不占行列的序列是安全的）。',
  ]],
  ['  render(node: ReactNode): void {', [
    '// 职责：把 React 树挂到根容器并同步刷新（渲染 App + TerminalWriteProvider）。',
    '// 参数：node - 业务根节点。',
    '// 边界：使用 updateContainerSync/flushSyncWork（类型定义缺失，带 ts-expect-error），',
    '// 保证 render() 返回时 DOM 已构建；重复调用只替换根节点，不重建实例。',
  ]],
  ['  unmount(error?: Error | number | null): void {', [
    '// 职责：卸载应用——绘最后一帧、恢复控制台/终端模式并释放资源。',
    '// 参数：error - 可选退出原因（数字/错误），透传给退出流程。',
    '// 边界：幂等（isUnmounted 守卫）；会同步写禁用序列（不依赖 React 卸载时机），',
    '// 非 TTY 环境下只渲染最后一帧静态输出，避免擦除序列污染日志。',
    '// 反直觉：退出前无条件发送全部 disable 序列，因为 tmux/screen 下能力探测不可靠，',
    '// 对不支持的终端它们本就是 no-op。',
  ]],
  ['  async waitUntilExit(): Promise<void> {', [
    '// 职责：返回一个在实例退出时 resolve 的 Promise，供调用方等待收尾。',
    '// 参数：无。',
    '// 边界：若已经卸载则立即 resolve；不负责触发退出，只做等待。',
  ]],
  ['export function drainStdin(stdin: NodeJS.ReadStream = process.stdin): void {', [
    '// 职责：非阻塞清空 TTY 输入缓冲，防止上一进程/外部程序残留的字节被误读。',
    '// 参数：stdin - 目标输入流，默认 process.stdin。',
    '// 边界：非 TTY 直接返回；先 drain Node 的 stream 缓冲，Unix 上再以 O_NONBLOCK',
    '// 打开 /dev/tty 读内核缓冲（最多 64 次/约 64KB）；Windows 无 /dev/tty 直接跳过。',
    '// 会临时把 termios 切到 raw 以保证非阻塞读到部分输入，finally 中恢复原状。',
  ]],
];

function insertBlocks(lines, blocks, label) {
  let out = lines.slice();
  for (const [anchor, block] of blocks) {
    const idx = out.findIndex((l) => l === anchor);
    if (idx < 0) {
      console.log(`ANCHOR-MISS ${label}: ${anchor}`);
      process.exit(1);
    }
    const indent = anchor.match(/^[ \t]*/)[0];
    const inserted = block.map((c) => indent + c);
    // 前一行若为空行则不再额外加空行；否则补一个空行做视觉分隔（纯新增）
    const prevIsBlank = out[idx - 1] === undefined || out[idx - 1].trim() === '';
    if (!prevIsBlank) inserted.unshift(indent);
    out = [...out.slice(0, idx), ...inserted, ...out.slice(idx)];
  }
  return out;
}

for (const [rel, blocks] of [
  ['ink/components/App.tsx', appBlocks],
  ['ink/ink.tsx', inkBlocks],
]) {
  const raw = fs.readFileSync(path.join(BASE, rel), 'utf8');
  const lines = raw.split('\n');
  const out = insertBlocks(lines, blocks, rel);
  fs.writeFileSync(path.join(ROOT, rel), out.join('\n'), 'utf8');
  console.log(`${rel}: ${lines.length} -> ${out.length}`);
}
