// B221 四个文件的注释 spec 生成器（各新增 30 行）。
import fs from 'node:fs';

const specs = [
  {
    file: 'packages/ui/src/v4/ConversationTurnRow.tsx',
    target: 30,
    firstNth: 1,
    header: [
      '// INV-01 薄壳装配：守住位置 组件体只有透传；改错故障 单轮行自行取 store 或改写行数据。',
      '// INV-02 行数据只读：守住位置 row / context 两个必填参数；改错故障 组件内部派生第二份行状态。',
      '// INV-03 回调全部可选：守住位置 onFork / onRetry / onEdit 的 ?；改错故障 只读场景必须伪造空函数。',
      '// INV-04 编辑返回值宽类型：守住位置 Promise<CommandAck | boolean | void>；改错故障 上层无法区分拒绝与成功。',
      '// INV-05 属性名不重命名：守住位置 解构与透传同名；改错故障 下游 context 字段与 props 脱节。',
      '// INV-06 不吞未声明属性：守住位置 显式列举参数；改错故障 新增能力被静默丢弃。',
      '// INV-07 复制文本有单一来源：守住位置 resolveAssistantCopyText；改错故障 各按钮各自拼串。',
      '// INV-08 无文本行即无复制：守住位置 latestAssistantTextRow 早退；改错故障 空回答给出空剪贴板。',
      '// INV-09 分段优先多段文本：守住位置 assistantTextRows.length 判断；改错故障 多段回答只复制最后一段。',
      '// INV-10 计划正文按需补入：守住位置 ExitPlanMode 过滤；改错故障 漏掉结构化计划原文。',
      '// INV-11 去重按内容判等：守住位置 includedSegments；改错故障 计划与正文重复复制两遍。',
      '// INV-12 只认 toolCall 行：守住位置 row.kind 判断；改错故障 非工具行被当计划解析。',
      '// INV-13 空计划跳过：守住位置 !markdown 分支；改错故障 末尾多出两个换行。',
      '// INV-14 段间双换行拼接：守住位置 join("\\n\\n")；改错故障 复制出的段落黏成一段。',
      '//',
      '// 模块职责：单轮会话行的渲染入口，以及本轮回答复制文本的组装规则。',
      '// 阅读顺序：先看属性透传，再看复制文本的分段来源，最后看计划去重。',
    ],
    blocks: [
      {
        anchor: 'export function ConversationTurnRow({',
        lines: [
          '单轮行只负责把属性交给行视图。',
        ],
      },
      {
        anchor: 'row,',
        lines: [
          '行数据原样下传，不做拷贝。',
        ],
      },
      {
        anchor: '}: ConversationTurnRowProps) {',
        lines: [
          '解构结束，属性名与下游保持一致。',
        ],
      },
      {
        anchor: '<ConversationRowView',
        lines: [
          '渲染收敛到唯一行视图实现。',
        ],
      },
      {
        anchor: 'onFork={onFork}',
        lines: [
          '分叉入口缺省时保持未连接。',
        ],
      },
      {
        anchor: 'reasoningContentVariant={reasoningContentVariant}',
        lines: [
          '推理内容形态由调用方决定。',
        ],
      },
      {
        anchor: 'export function resolveAssistantCopyText(unit: ConversationTurnRenderUnit): string | undefined {',
        lines: [
          '复制文本从渲染单元推导，不读 DOM。',
        ],
      },
      {
        anchor: 'if (!unit.latestAssistantTextRow) {',
        lines: [
          '没有回答文本就没有可复制内容。',
        ],
      },
      {
        anchor: 'const segments =',
        lines: [
          '多段优先，退化时取最后一段。',
        ],
      },
      {
        anchor: 'const includedSegments = new Set(segments);',
        lines: [
          '按内容建集合用于后续去重。',
        ],
      },
      {
        anchor: 'if (row.kind !== "toolCall" || row.toolName !== "ExitPlanMode") continue;',
        lines: [
          '只有计划工具行才是正文来源。',
        ],
      },
      {
        anchor: 'if (!markdown || includedSegments.has(markdown)) continue;',
        lines: [
          '空正文与重复正文都不再追加。',
        ],
      },
      {
        anchor: 'return segments.join("\\n\\n");',
        lines: [
          '段落之间保留空行便于阅读。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/v4/workbenchLayout.ts',
    target: 30,
    header: [
      '// INV-01 纯计算：守住位置 全部导出函数；改错故障 布局阶段读取 DOM 尺寸或写 store。',
      '// INV-02 叶子扁平化：守住位置 collectWorkbenchLayout 返回结构；改错故障 递归嵌套导致存活 pane 重挂。',
      '// INV-03 占比只走 CSS 变量：守住位置 ratioVar 的 var() 写法；改错故障 拖拽时逐帧触发 React 渲染。',
      '// INV-04 变量按节点命名：守住位置 SPLIT_VAR_PREFIX + node.id；改错故障 多个分割节点互相覆盖占比。',
      '// INV-05 第二子树首尾相接：守住位置 left/boundary 复用；改错故障 分割线两侧出现缝隙或重叠。',
      '// INV-06 row 与 column 轴向对称：守住位置 两条分支的宽高交换；改错故障 竖向分割按横向算。',
      '// INV-07 表达式不带 calc：守住位置 RectExpr 只存裸表达式；改错故障 嵌套 calc 拼接出错。',
      '// INV-08 calc 统一在样式层包：守住位置 rectStyle / dividerStyle；改错故障 表达式混入单位后失效。',
      '// INV-09 祖先占比取数值：守住位置 regionFraction 传 store ratio；改错故障 拖拽像素换算比例失真。',
      '// INV-10 分割条宽度常量：守住位置 9px；改错故障 命中区与视觉线错位。',
      '// INV-11 分割条居中偏移：守住位置 translateX/Y(-50%)；改错故障 线偏到一侧。',
      '// INV-12 交叉轴沿父矩形：守住位置 crossStart / crossLength；改错故障 分割线长度不随父区域收缩。',
      '// INV-13 根矩形满幅：守住位置 FULL_WORKBENCH_RECT；改错故障 初始布局留白或溢出。',
      '// INV-14 占比可缺省：守住位置 var() 第二参 node.ratio；改错故障 变量未写入时布局塌陷。',
      '//',
      '// 模块职责：把分屏树编译成叶子与分割条的绝对定位表达式。',
      '// 阅读顺序：先看 collectNode 的轴向分支，再看扁平输出，最后看样式包装。',
    ],
    blocks: [
      {
        anchor: 'export const SPLIT_VAR_PREFIX = "--v4-split-";',
        lines: [
          '变量前缀是拖拽零渲染的契约。',
        ],
      },
      {
        anchor: 'export interface RectExpr {',
        lines: [
          '矩形用四个表达式描述，而非像素。',
        ],
      },
      {
        anchor: 'export interface LeafLayout {',
        lines: [
          '叶子携带 paneId 与最终矩形。',
        ],
      },
      {
        anchor: 'export interface DividerLayout {',
        lines: [
          '分割条同时记录占比与区域比例。',
        ],
      },
      {
        anchor: 'export const FULL_WORKBENCH_RECT: RectExpr = {',
        lines: [
          '根节点铺满容器。',
        ],
      },
      {
        anchor: '): void {',
        lines: [
          '递归只写两个输出数组，无返回值。',
        ],
      },
      {
        anchor: 'if (node.type === "leaf") {',
        lines: [
          '叶子直接产出矩形并终止递归。',
        ],
      },
      {
        anchor: 'const ratioVar = `var(${SPLIT_VAR_PREFIX}${node.id}, ${node.ratio})`;',
        lines: [
          '占比优先读 CSS 变量，缺省回落 store。',
        ],
      },
      {
        anchor: 'if (node.direction === "row") {',
        lines: [
          '横向分割切宽度，纵向切高度。',
        ],
      },
      {
        anchor: 'export function collectWorkbenchLayout(root: PaneLayoutNode): WorkbenchLayout {',
        lines: [
          '对外只暴露一次遍历后的扁平结果。',
        ],
      },
      {
        anchor: 'export function rectStyle(rect: RectExpr): CSSProperties {',
        lines: [
          '矩形表达式在此统一包 calc。',
        ],
      },
      {
        anchor: 'export function dividerStyle(divider: DividerLayout): CSSProperties {',
        lines: [
          '分割条样式按轴向分支。',
        ],
      },
      {
        anchor: 'if (divider.direction === "row") {',
        lines: [
          '竖向线定 left，横向线定 top。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/v4/WorkflowNotificationHoleRow.tsx',
    target: 30,
    header: [
      '// INV-01 只读投影：守住位置 组件体；改错故障 留白行自行补全或改动 run 数据。',
      '// INV-02 三态封闭：守住位置 HoleRowState；改错故障 出现第四种未定义展示。',
      '// INV-03 缺表即离开：守住位置 holes === undefined；改错故障 非活投影误显示等待。',
      '// INV-04 缺项同样离开：守住位置 hole === undefined；改错故障 旧留白编号残留等待态。',
      '// INV-05 等待与补全二选一：守住位置 hole.state 判定；改错故障 已补全仍显示等待时长。',
      '// INV-06 计时只在等待态：守住位置 state !== "waiting" 早退；改错故障 已结束的留白仍每 30 秒重渲染。',
      '// INV-07 停驻也计时：守住位置 setInterval；改错故障 无事件流时等待时长冻结。',
      '// INV-08 定时器必须清理：守住位置 clearInterval；改错故障 状态切换后定时器泄漏。',
      '// INV-09 切换即校准：守住位置 setNow(Date.now()) 立即调用；改错故障 首秒显示过期时长。',
      '// INV-10 文案随态映射：守住位置 KIND_LABEL_ID；改错故障 三种态共用一句话。',
      '// INV-11 主文本 memo 化：守住位置 primaryText 依赖；改错故障 每次计时刷新重建节点。',
      '// INV-12 展开体不抖动：守住位置 不使用动画；改错故障 等待中的卡片闪烁。',
      '// INV-13 站点描述按缺省降级：守住位置 standsId 三分支；改错故障 缺 before/after 时输出空占位。',
      '// INV-14 打开入口可选：守住位置 onOpenRun 判断；改错故障 无回调时出现死链接。',
      '//',
      '// 模块职责：工作流留白通知行的状态判定、计时刷新与展开体渲染。',
      '// 阅读顺序：先看 holeRowState，再看计时器，最后看展开体的各可选段落。',
    ],
    blocks: [
      {
        anchor: 'export type WorkflowHoleNotification = Extract<WorkflowNotificationMeta, { kind: "hole" }>;',
        lines: [
          '从联合类型中精确取出留白形态。',
        ],
      },
      {
        anchor: 'export type HoleRowState = "waiting" | "filled" | "left";',
        lines: [
          '三种态覆盖等待、补全与已离场。',
        ],
      },
      {
        anchor: 'export function holeRowState(',
        lines: [
          '状态纯由投影表推导，可单测。',
        ],
      },
      {
        anchor: 'if (holes === undefined) return "left";',
        lines: [
          '投影缺席说明 run 不在活集合。',
        ],
      },
      {
        anchor: 'return hole.state === "waiting" ? "waiting" : "filled";',
        lines: [
          '只剩等待与补全两种细分。',
        ],
      },
      {
        anchor: 'const KIND_LABEL_ID: Record<HoleRowState, string> = {',
        lines: [
          '状态到文案 id 的映射固定在此。',
        ],
      },
      {
        anchor: 'const HOLE_ICON = <Pen className="size-4 shrink-0 text-foreground-subtle" />;',
        lines: [
          '图标是常量节点，避免重复创建。',
        ],
      },
      {
        anchor: 'export function WorkflowNotificationHoleRow({',
        lines: [
          '行组件只依赖传入的通知与投影。',
        ],
      },
      {
        anchor: 'const state = holeRowState(holes, notification.siteId);',
        lines: [
          '站点 id 是查表的唯一键。',
        ],
      },
      {
        anchor: 'const [now, setNow] = useState(() => Date.now());',
        lines: [
          '本地时钟只用于展示已等待时长。',
        ],
      },
      {
        anchor: '}, [state]);',
        lines: [
          '状态变化才重装计时器。',
        ],
      },
      {
        anchor: 'const waited =',
        lines: [
          '时长文案在等待态才计算。',
        ],
      },
      {
        anchor: 'const renderContent = useCallback(() => {',
        lines: [
          '展开体按需构造，未展开不渲染。',
        ],
      },
    ],
  },
  {
    file: 'packages/web/src/web-remote-control/adapters/webRemoteControlDeviceInfo.ts',
    target: 30,
    header: [
      '// INV-01 无全局依赖：守住位置 全部注入参数默认值；改错故障 测试必须伪造浏览器全局。',
      '// INV-02 宿主接口最小化：守住位置 NavigatorLike / WindowLike；改错故障 直接引用 DOM 类型导致 Node 端报错。',
      '// INV-03 只认有限数值：守住位置 readFiniteNumber；改错故障 NaN / Infinity 进入上报字段。',
      '// INV-04 空串视为缺失：守住位置 readNonEmptyString 的 trim；改错故障 上报空 userAgent。',
      '// INV-05 时区失败静默：守住位置 readTimezone 的 try；改错故障 老旧浏览器抛错中断整份设备信息。',
      '// INV-06 像素比恒有值：守住位置 ?? 1；改错故障 缺字段时上报 undefined。',
      '// INV-07 视口成对出现：守住位置 宽高同时判断；改错故障 只有单边时产出半个 viewport。',
      '// INV-08 屏幕尺寸同理成对：守住位置 screen 展开判断；改错故障 半个 screen 对象。',
      '// INV-09 语言列表先过滤空项：守住位置 filter；改错故障 空语言码进入上报。',
      '// INV-10 在线态只收布尔：守住位置 typeof onLine 判断；改错故障 字符串被当成在线。',
      '// INV-11 平台固定为 web：守住位置 platform 字段；改错故障 Web 端伪装成桌面端。',
      '// INV-12 版本有兜底：守住位置 "web"；改错故障 缺版本时字段为 null。',
      '// INV-13 可选字段按需展开：守住位置 条件展开语法；改错故障 缺数据时字段仍存在且为 undefined。',
      '// INV-14 时间戳可注入：守住位置 now 参数；改错故障 无法断言上报时间。',
      '//',
      '// 模块职责：从浏览器全局收集移动端 Web 远控所需的设备信息快照。',
      '// 阅读顺序：先看三个读取工具，再看时区容错，最后看返回对象的条件展开。',
    ],
    blocks: [
      {
        anchor: 'function readFiniteNumber(value: unknown): number | undefined {',
        lines: [
          '数值字段只接受有限数。',
        ],
      },
      {
        anchor: 'return typeof value === "number" && Number.isFinite(value) ? value : undefined;',
        lines: [
          '非有限数一律当作缺失。',
        ],
      },
      {
        anchor: 'function readNonEmptyString(value: unknown): string | undefined {',
        lines: [
          '字符串字段排除纯空白。',
        ],
      },
      {
        anchor: 'function readTimezone(',
        lines: [
          '时区读取必须可失败。',
        ],
      },
      {
        anchor: '} catch {',
        lines: [
          '取不到时区不算错误。',
        ],
      },
      {
        anchor: 'export function collectWebRemoteControlMobileDeviceInfo({',
        lines: [
          '默认实现指向浏览器全局。',
        ],
      },
      {
        anchor: 'now = () => Date.now(),',
        lines: [
          '时钟可注入便于断言。',
        ],
      },
      {
        anchor: 'navigatorLike = globalThis.navigator,',
        lines: [
          'navigator 缺失时上层判空。',
        ],
      },
      {
        anchor: 'const devicePixelRatio = readFiniteNumber(windowLike?.devicePixelRatio) ?? 1;',
        lines: [
          '像素比缺省按 1 上报。',
        ],
      },
      {
        anchor: 'platform: "web",',
        lines: [
          '平台标识固定，不随 UA 变化。',
        ],
      },
      {
        anchor: '...(navigatorLike?.languages?.length',
        lines: [
          '语言列表非空才上报。',
        ],
      },
      {
        anchor: '...(viewportWidth !== undefined && viewportHeight !== undefined',
        lines: [
          '视口宽高必须成对。',
        ],
      },
      {
        anchor: 'updatedAt: now(),',
        lines: [
          '采集时刻由注入时钟决定。',
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
    `ZC-deep-b221-spec-${index}.json`,
    JSON.stringify({ files: [{ file: spec.file, items }] }, null, 2),
    'utf8',
  );
  console.log(`spec ${index}: ${spec.file} lines=${total}`);
  index += 1;
}
