// B226 四个文件的注释 spec 生成器（各新增 30 行）。
import fs from 'node:fs';

const specs = [
  {
    file: 'packages/desktop/scripts/gen-ui-fixture/file-summary.tsx',
    target: 30,
    header: [
      '// INV-01 固定 rowId：守住位置 rowId: 2 与 rowId: 1；改错故障 预览卡与摘要面板对不上同一行。',
      '// INV-02 turnId 两侧一致：守住位置 两处 "summary-turn"；改错故障 文件变更聚合去别的轮次找。',
      '// INV-03 行类型不可换：守住位置 kind: "assistantText"；改错故障 预览 hook 收到未知类型直接跳过。',
      '// INV-04 文案三态由 mode 决定：守住位置 文本三元；改错故障 only 与 mixed 两个场景互相串扰。',
      '// INV-05 visualize 指令必须带 path：守住位置 JSON.stringify({ path })；改错故障 面板解析不到目标文件。',
      '// INV-06 useMemo 依赖完整：守住位置 [mode, path, root]；改错故障 切换场景后仍渲染旧文案。',
      '// INV-07 workspacePath 与 root 同源：守住位置 workspacePath: root；改错故障 路径拼出双层根目录。',
      '// INV-08 变更条数随 mode 变化：守住位置 两处展开判断；改错故障 ordinary 场景仍报两个文件。',
      '// INV-09 汇总计数与明细同源：守住位置 additions 三元；改错故障 面板总数与列表行数矛盾。',
      '// INV-10 变更目标指向 header：守住位置 fileChangesTarget 的 rowId: 1；改错故障 变更卡片挂到文本行。',
      '// INV-11 预览容器 id 稳定：守住位置 #file-preview-cards；改错故障 截图脚本选择器失效。',
      '// INV-12 摘要面板 id 稳定：守住位置 #file-summary-panel；改错故障 端到端用例无法定位面板。',
      '// INV-13 compact 只影响展示：守住位置 compactForRemoteControl；改错故障 夹具改变数据形态。',
      '// INV-14 上下文集中构造：守住位置 context 对象；改错故障 各子组件读不同来源设置。',
      '//',
      '// 模块职责：为文件预览卡与文件摘要面板提供可复现的最小 UI 夹具。',
      '// 阅读顺序：先看 mode 与 row 的构造，再看 context 与 header 的配套，最后看渲染结构。',
    ],
    blocks: [
      {
        anchor: 'export function FileSummaryFixture({',
        lines: [
          '夹具只服务截图与端到端测试，不进生产包。',
        ],
      },
      {
        anchor: 'const row = useMemo<AssistantTextRow>(',
        lines: [
          '行对象在依赖变化时才重建。',
        ],
      },
      {
        anchor: 'text:',
        lines: [
          '三种 mode 分别产出纯文件、指令加文件、纯指令文案。',
        ],
      },
      {
        anchor: 'const rows = useMemo(() => [row], [row]);',
        lines: [
          '包成同类行列表，满足 hook 的入参约定。',
        ],
      },
      {
        anchor: 'const context = useMemo(',
        lines: [
          '上下文集中构造，两块 UI 读到同一份设置。',
        ],
      },
      {
        anchor: 'workspaceIdentity: "ssh:fixture:/workspace",',
        lines: [
          '固定远端身份，夹具不依赖本机路径。',
        ],
      },
      {
        anchor: 'fetchFileChanges: async () => ({',
        lines: [
          '变更清单按 mode 组合，与 header 计数保持一致。',
        ],
      },
      {
        anchor: 'const header: TurnHeaderRow = {',
        lines: [
          'header 代表轮次汇总，预览卡按 rowId 反查它。',
        ],
      },
      {
        anchor: 'fileChanges: {',
        lines: [
          '汇总计数必须与明细列表同源。',
        ],
      },
      {
        anchor: 'const cards = useAssistantPreviewCardsForAssistantTextRow({',
        lines: [
          '预览卡由 hook 从文本解析得出。',
        ],
      },
      {
        anchor: 'fileChangesTarget: { rowId: 1, entityId: "summary-header" },',
        lines: [
          '把变更目标显式指向 header 行。',
        ],
      },
      {
        anchor: 'return (',
        lines: [
          '渲染两块区域，各自带稳定 id 供测试定位。',
        ],
      },
      {
        anchor: 'kind: "assistantText",',
        lines: [
          '行类型必须与 hook 期望一致。',
        ],
      },
    ],
  },
  {
    file: 'packages/stream-animate/src/server/dataStore.ts',
    target: 30,
    header: [
      '// INV-01 运行目录可反推：守住位置 getRunDir 的两级拼接；改错故障 列表扫描找不到已写入的运行。',
      '// INV-02 分片前缀取前 8 位：守住位置 runId.slice(0, 8)；改错故障 单目录条目过多拖慢遍历。',
      '// INV-03 建目录幂等：守住位置 mkdir recursive；改错故障 重跑同一 runId 抛已存在。',
      '// INV-04 原始流追加写：守住位置 flags: "a"；改错故障 第二轮采集覆盖第一轮。',
      '// INV-05 每条记录一行：守住位置 换行拼接；改错故障 多行 JSON 破坏 ndjson 逐行解析。',
      '// INV-06 关闭需等待落盘：守住位置 closeStream 的 Promise；改错故障 退出时尾部记录丢失。',
      '// INV-07 摘要写入自建目录：守住位置 writeJson 内 mkdir；改错故障 首次写摘要报 ENOENT。',
      '// INV-08 列表按时间倒序：守住位置 createdAt 比较；改错故障 最新运行沉到列表底部。',
      '// INV-09 缺根目录视为空：守住位置 readdir 的 catch；改错故障 首次启动直接报错。',
      '// INV-10 只认 summary.json：守住位置 文件名判断；改错故障 raw.ndjson 被当摘要解析。',
      '// INV-11 递归结果扁平化：守住位置 paths.flat()；改错故障 嵌套数组混入运行列表。',
      '// INV-12 原始行只取尾部：守住位置 slice(-limit)；改错故障 面板显示最旧日志。',
      '// INV-13 空行必须过滤：守住位置 filter(Boolean)；改错故障 尾部空串被当成一条记录。',
      '// INV-14 相对路径基于数据目录：守住位置 toDataRelativePath；改错故障 前端拼错静态资源地址。',
      '//',
      '// 模块职责：stream-animate 服务端的运行数据落盘、读取与路径约定。',
      '// 阅读顺序：先看路径构造函数，再看写入与读取，最后看扫描与流关闭的边界。',
    ],
    blocks: [
      {
        anchor: 'export function createRunId(now = new Date()) {',
        lines: [
          '时间戳加随机后缀，同秒多次启动也不撞名。',
        ],
      },
      {
        anchor: 'const stamp = now.toISOString().replaceAll(/[-:.TZ]/gu, "").slice(0, 14);',
        lines: [
          '压成 14 位数字串，便于目录按名排序。',
        ],
      },
      {
        anchor: 'export function getRunDir(packageRoot: string, runId: string) {',
        lines: [
          '目录分两级，前 8 位充当分片。',
        ],
      },
      {
        anchor: 'return join(getDataDir(packageRoot), "runs", runId.slice(0, 8), runId);',
        lines: [
          '分片名只取前缀，完整 id 才是叶子目录。',
        ],
      },
      {
        anchor: 'export function createRawWriter(runDir: string) {',
        lines: [
          '原始记录以追加方式写出，支持断点续采。',
        ],
      },
      {
        anchor: 'const stream = createWriteStream(rawPath, { encoding: "utf-8", flags: "a" });',
        lines: [
          '追加标志而非覆盖标志。',
        ],
      },
      {
        anchor: 'export async function listRuns(packageRoot: string) {',
        lines: [
          '运行集合靠扫描摘要文件反推。',
        ],
      },
      {
        anchor: 'return runs.sort((first, second) => second.createdAt.localeCompare(first.createdAt));',
        lines: [
          'ISO 时间戳可直接比较，倒序即最新在前。',
        ],
      },
      {
        anchor: 'export async function readRawLines(packageRoot: string, runId: string, limit: number) {',
        lines: [
          '只取尾部若干行，避免整份日志回传前端。',
        ],
      },
      {
        anchor: 'return text.split(/\\r?\\n/u).filter(Boolean).slice(-limit);',
        lines: [
          '兼容 CRLF，过滤空行后取尾部。',
        ],
      },
      {
        anchor: 'async function collectSummaryPaths(root: string): Promise<string[]> {',
        lines: [
          '递归收集所有摘要文件路径。',
        ],
      },
      {
        anchor: 'entries = await readdir(root, { withFileTypes: true });',
        lines: [
          '读目录失败按空处理，首次运行没有数据目录属正常。',
        ],
      },
      {
        anchor: 'async function closeStream(stream: Writable) {',
        lines: [
          '等 end 回调再判定完成，防止尾部记录被截断。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/components/ai-elements/prompt-input-actions.tsx',
    target: 30,
    header: [
      '// INV-01 无采集能力即降级：守住位置 能力探测早返回；改错故障 点击截图直接抛错。',
      '// INV-02 媒体流必须释放：守住位置 finally 内 track.stop；改错故障 录屏指示灯常亮。',
      '// INV-03 视频元素复位：守住位置 pause 与 srcObject = null；改错故障 旧流被下一帧复用。',
      '// INV-04 尺寸为 0 视为失败：守住位置 width/height 判断；改错故障 产出空白 PNG。',
      '// INV-05 2D 上下文缺失即放弃：守住位置 getContext 判空；改错故障 空指针中断附件流程。',
      '// INV-06 截图必须是 File：守住位置 File 构造；改错故障 附件管线拒绝非 File 项。',
      '// INV-07 文件名带时间戳：守住位置 ISO 字符替换；改错故障 多次截图重名互相覆盖。',
      '// INV-08 用户取消不报错：守住位置 NotAllowedError 与 AbortError 分支；改错故障 取消选择弹错误提示。',
      '// INV-09 先调用外部 onSelect：守住位置 onSelect?.() 在前；改错故障 外部禁用逻辑被跳过。',
      '// INV-10 已 preventDefault 即放弃：守住位置 defaultPrevented 判断；改错故障 禁用后仍弹窗。',
      '// INV-11 附件走统一入口：守住位置 attachments.add；改错故障 绕开容量与类型校验。',
      '// INV-12 菜单项透传 props：守住位置 {...props}；改错故障 外部 aria 与事件丢失。',
      '// INV-13 触发器有默认图标：守住位置 children ?? PlusIcon；改错故障 空触发器没有点击区域。',
      '// INV-14 菜单默认左对齐：守住位置 align="start"；改错故障 靠近右边界时内容溢出视口。',
      '//',
      '// 模块职责：输入框附件菜单的动作项与菜单包装，含屏幕截图采集。',
      '// 阅读顺序：先看 captureScreenshot 的资源释放，再看两个动作项，最后看菜单包装的透传。',
    ],
    blocks: [
      {
        anchor: 'const captureScreenshot = async (): Promise<File | null> => {',
        lines: [
          '采集失败返回 null 而不抛错，调用方据空值静默跳过。',
        ],
      },
      {
        anchor: 'if (typeof navigator === "undefined" || !navigator.mediaDevices?.getDisplayMedia) {',
        lines: [
          '先探测能力，SSR 与旧浏览器都走降级。',
        ],
      },
      {
        anchor: 'stream = await navigator.mediaDevices.getDisplayMedia({',
        lines: [
          '只请求画面，不申请音频权限。',
        ],
      },
      {
        anchor: 'await new Promise<void>((resolve, reject) => {',
        lines: [
          '元数据加载是回调式 API，这里桥接成 Promise。',
        ],
      },
      {
        anchor: 'const canvas = document.createElement("canvas");',
        lines: [
          '用 canvas 抓取当前帧再转成图片。',
        ],
      },
      {
        anchor: 'const blob = await new Promise<Blob | null>((resolve) => {',
        lines: [
          'toBlob 同样是回调式，失败时给 null。',
        ],
      },
      {
        anchor: 'return new File([blob], `screenshot-${timestamp}.png`, {',
        lines: [
          '包装成 File 才能进入附件管线。',
        ],
      },
      {
        anchor: 'export const PromptInputActionAddAttachments = ({',
        lines: [
          '附件入口直接调用上下文打开文件对话框。',
        ],
      },
      {
        anchor: 'attachments.openFileDialog();',
        lines: [
          '选择行为统一由附件上下文实现。',
        ],
      },
      {
        anchor: 'export const PromptInputActionAddScreenshot = ({',
        lines: [
          '截图入口先让外部处理，再自行采集。',
        ],
      },
      {
        anchor: 'const screenshot = await captureScreenshot();',
        lines: [
          '结果为空表示用户取消或能力不足。',
        ],
      },
      {
        anchor: 'error instanceof DOMException &&',
        lines: [
          '只吞用户取消类错误，其余继续抛出。',
        ],
      },
      {
        anchor: 'export const PromptInputActionMenuTrigger = ({',
        lines: [
          '触发器缺省用加号图标，保持可点击面积。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/components/ai-elements/snippet.tsx',
    target: 30,
    header: [
      '// INV-01 代码只由 Provider 注入：守住位置 SnippetContext；改错故障 子组件各存一份而不同步。',
      '// INV-02 默认上下文为空串：守住位置 createContext 初值；改错故障 脱离 Provider 时渲染 undefined。',
      '// INV-03 value 用 useMemo：守住位置 contextValue；改错故障 每次渲染刷新全部消费者。',
      '// INV-04 输入框只读：守住位置 readOnly；改错故障 用户可改动展示用的代码。',
      '// INV-05 外部不能覆盖 value：守住位置 类型上 Omit value；改错故障 传入值与上下文不一致。',
      '// INV-06 复制前判能力：守住位置 clipboard 探测；改错故障 非安全上下文下未捕获异常。',
      '// INV-07 复制中不重复写：守住位置 !isCopied 判断；改错故障 连点产生多次回调。',
      '// INV-08 超时后回退图标：守住位置 setTimeout 复位；改错故障 勾选态永久停留。',
      '// INV-09 定时器卸载清理：守住位置 useEffect 的 cleanup；改错故障 卸载后 setState 告警。',
      '// INV-10 错误交给调用方：守住位置 onError?.()；改错故障 失败被静默吞掉无法归因。',
      '// INV-11 图标随状态切换：守住位置 isCopied 三元；改错故障 复制成功没有视觉反馈。',
      '// INV-12 默认超时可覆盖：守住位置 timeout = 2000；改错故障 无法按场景调整提示时长。',
      '// INV-13 可访问性固定：守住位置 aria-label 与 title；改错故障 纯图标按钮无朗读文本。',
      '// INV-14 子节点优先于图标：守住位置 children ?? Icon；改错故障 自定义内容被图标覆盖。',
      '//',
      '// 模块职责：只读代码片段展示与一键复制按钮。',
      '// 阅读顺序：先看上下文与外壳，再看输入的只读绑定，最后看复制按钮的状态机。',
    ],
    blocks: [
      {
        anchor: 'const SnippetContext = createContext<SnippetContextType>({',
        lines: [
          '上下文只暴露代码串，避免各组件分别取数。',
        ],
      },
      {
        anchor: 'export const Snippet = ({ code, className, children, ...props }: SnippetProps) => {',
        lines: [
          '外壳同时提供上下文与等宽排版。',
        ],
      },
      {
        anchor: 'const contextValue = useMemo(() => ({ code }), [code]);',
        lines: [
          '对象身份随代码变化，消费者才不会空转。',
        ],
      },
      {
        anchor: 'export const SnippetInput = ({ className, ...props }: SnippetInputProps) => {',
        lines: [
          '输入框从上下文取值，外部无法传值覆盖。',
        ],
      },
      {
        anchor: 'export const SnippetCopyButton = ({',
        lines: [
          '复制按钮自带状态机与超时复位。',
        ],
      },
      {
        anchor: 'const [isCopied, setIsCopied] = useState(false);',
        lines: [
          '勾选态只用于图标与防重入。',
        ],
      },
      {
        anchor: 'const timeoutRef = useRef<number>(0);',
        lines: [
          '定时器句柄存 ref，避免每次渲染重建。',
        ],
      },
      {
        anchor: 'const copyToClipboard = useCallback(async () => {',
        lines: [
          '复制逻辑收敛到一个回调，便于声明依赖。',
        ],
      },
      {
        anchor: 'if (typeof window === "undefined" || !navigator?.clipboard?.writeText) {',
        lines: [
          '能力缺失走 onError，而不是抛未捕获异常。',
        ],
      },
      {
        anchor: 'await navigator.clipboard.writeText(code);',
        lines: [
          '写入成功后立即反馈，再启动复位定时器。',
        ],
      },
      {
        anchor: 'timeoutRef.current = window.setTimeout(() => setIsCopied(false), timeout);',
        lines: [
          '新句柄覆盖旧句柄，卸载时只需清一个。',
        ],
      },
      {
        anchor: 'useEffect(',
        lines: [
          '卸载清定时器，防止卸载后 setState。',
        ],
      },
      {
        anchor: 'const Icon = isCopied ? CheckIcon : CopyIcon;',
        lines: [
          '图标跟随状态切换，无需额外分支渲染。',
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
    `ZC-deep-b226-spec-${index}.json`,
    JSON.stringify({ files: [{ file: spec.file, items }] }, null, 2),
    'utf8',
  );
  console.log(`spec ${index}: ${spec.file} lines=${total}`);
  index += 1;
}
