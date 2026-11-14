import fs from 'node:fs';

const specs = [
  {
    file: 'packages/ui/src/lib/mermaidRenderBudget.ts',
    target: 39,
    header: [
      '// INV-01 三道预算是渲染前闸门：守住位置 常量；改错故障 大图直接进入渲染层。',
      '// INV-02 字符上限两万：守住位置 sourceChars；改错故障 超长源码拖垮主线程。',
      '// INV-03 行数上限六百：守住位置 lineCount；改错故障 长文档一次性建树。',
      '// INV-04 复杂度上限一千五：守住位置 complexityScore；改错故障 边与节点双重放大。',
      '// INV-05 页面不可见即跳过：守住位置 可见性分支；改错故障 后台标签页仍然渲染。',
      '// INV-06 未知可见性按可见处理：守住位置 判定；改错故障 首帧被误判为隐藏。',
      '// INV-07 无文档环境按可见处理：守住位置 环境判断；改错故障 测试环境全部跳过。',
      '// INV-08 可见性只认四种标准值：守住位置 类型与判定；改错故障 浏览器新状态被拒。',
      '// INV-09 指标先于决策计算：守住位置 measure 调用；改错故障 拒绝时无法解释原因。',
      '// INV-10 跳过原因封闭四种：守住位置 联合类型；改错故障 新原因前端没有对应文案。',
      '// INV-11 决策是判别联合：守住位置 返回类型；改错故障 调用方同时处理两种形状。',
      '// INV-12 边匹配使用全局正则：守住位置 标志 gu；改错故障 只统计首个匹配。',
      '// INV-13 正则游标每次归零：守住位置 lastIndex；改错故障 复用正则时计数漂移。',
      '// INV-14 节点匹配限长两百：守住位置 量词；改错故障 恶意长串拖慢匹配。',
      '// INV-15 空源码按零行处理：守住位置 countLines；改错故障 空文档被算成一行。',
      '// INV-16 阈值可由选项覆盖：守住位置 options；改错故障 测试无法构造边界。',
      '// INV-17 覆盖值不改变默认常量：守住位置 空值合并；改错故障 默认常量被意外改写。',
      '// INV-18 全部判断无副作用：守住位置 纯函数；改错故障 决策过程触发渲染。',
      '//',
      '// 模块职责：为 Mermaid 自动渲染提供源码规模与页面可见性预算。',
      '// 状态所有权：纯常量与纯函数；不持有渲染状态。',
      '// 阅读顺序：先看三道阈值，再看指标采集，最后看决策分支。',
    ],
    blocks: [
      {
        anchor: 'export const MERMAID_AUTO_RENDER_MAX_LINES = 600;',
        lines: [
          '三道预算是渲染前的硬闸门。',
          '字符数按源码长度计算。',
          '行数与复杂度各自独立设限。',
          '阈值改动需同步文档说明。',
        ],
      },
      {
        anchor: 'function countPatternMatches(value: string, pattern: RegExp): number {',
        lines: [
          '全局正则先归零游标。',
          '逐次执行直到没有匹配。',
          '计数只用于复杂度估算。',
          '正则对象为模块级常量。',
        ],
      },
      {
        anchor: 'function countLines(value: string): number {',
        lines: [
          '空串视为零行。',
          '按换行符计数。',
          '末行没有换行也算一行。',
        ],
      },
      {
        anchor: 'export function getCurrentMermaidDocumentVisibility(): MermaidDocumentVisibilityState {',
        lines: [
          '无文档环境按可见处理。',
          '只接受四种标准状态。',
          '其余回落到隐藏标志。',
        ],
      },
      {
        anchor: 'function measureMermaidSource(source: string): MermaidAutoRenderMetrics {',
        lines: [
          '一次遍历得到全部指标。',
          '复杂度是三项之和。',
          '指标随决策一起返回。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/lib/officeFilePreview.ts',
    target: 40,
    header: [
      '// INV-01 后缀决定预览种类：守住位置 扩展名表；改错故障 未知格式被当成可预览。',
      '// INV-02 归一化先去空白再小写：守住位置 normalizedPath；改错故障 大写后缀漏判。',
      '// INV-03 无路径直接返回空：守住位置 入口判断；改错故障 空路径抛出异常。',
      '// INV-04 三种后缀判断顺序固定：守住位置 分支顺序；改错故障 doc 抢在 docx 之前。',
      '// INV-05 缩放不超过原尺寸：守住位置 取最小值；改错故障 小图被放大后模糊。',
      '// INV-06 宽高共用同一比例：守住位置 返回对象；改错故障 图形被拉伸变形。',
      '// INV-07 非法尺寸返回空：守住位置 数值校验；改错故障 除零得到无穷大。',
      '// INV-08 解码只做字节复制：守住位置 循环；改错故障 文本编码被二次转换。',
      '// INV-09 链接必须是字符串：守住位置 类型判断；改错故障 对象被强转成协议串。',
      '// INV-10 控制字符一律拒绝：守住位置 逐字符扫描；改错故障 换行伪装的脚本协议通过。',
      '// INV-11 内部锚点需无空白与尖括号：守住位置 正则；改错故障 锚点注入额外属性。',
      '// INV-12 外链只允许两种协议：守住位置 scheme 判断；改错故障 自定义协议被放行。',
      '// INV-13 解析后再次校验协议：守住位置 URL 分支；改错故障 大小写或变体绕过检查。',
      '// INV-14 写入 DOM 后再收口：守住位置 sanitizeDocumentLinks；改错故障 parser 生成的链接漏网。',
      '// INV-15 不安全链接移除属性并标记禁用：守住位置 removeAttribute；改错故障 链接仍可点击。',
      '// INV-16 点击统一交给受控入口：守住位置 handleClick；改错故障 主窗口被导航。',
      '// INV-17 变更观察只扫新增子树：守住位置 MutationObserver；改错故障 大文档全树重扫。',
      '// INV-18 卸载函数释放监听与观察：守住位置 返回闭包；改错故障 预览关闭后仍持有 DOM。',
      '//',
      '// 模块职责：识别 Office 文件预览种类，并提供尺寸计算、解码与链接净化。',
      '// 状态所有权：纯函数与常量；不持有预览实例。',
      '// 阅读顺序：先看后缀识别与尺寸，再看解码与链接净化，最后看点击拦截与观察。',
    ],
    blocks: [
      {
        anchor: 'const EXCEL_FILE_EXTENSIONS = [".xlsx", ".xlsm", ".xls"] as const;',
        lines: [
          '三种表格扩展名并列。',
          '匹配只看小写后缀。',
          '扩展名列表是唯一来源。',
        ],
      },
      {
        anchor: 'const normalizedPath = path.trim().toLowerCase();',
        lines: [
          '先去空白再转小写。',
          '大小写差异在此吸收。',
          '归一化不改动展示路径。',
        ],
      },
      {
        anchor: 'const scale = Math.min(1, availableWidth / naturalWidth);',
        lines: [
          '缩放不超过一比一。',
          '按可用宽度等比缩放。',
          '宽高使用同一比例。',
        ],
      },
      {
        anchor: 'export function decodeBase64ToArrayBuffer(dataBase64: string): ArrayBuffer {',
        lines: [
          '先解成二进制字符串。',
          '逐字节写入缓冲区。',
          '返回底层缓冲区本体。',
        ],
      },
      {
        anchor: 'const href = value.trim();',
        lines: [
          '非字符串直接拒绝。',
          '空白串视为无链接。',
          '后续判断只基于归一化值。',
        ],
      },
      {
        anchor: 'const scheme = href.match(/^([a-z][a-z0-9+.-]*):/iu)?.[1]?.toLowerCase();',
        lines: [
          '只取协议前缀。',
          '大小写统一后比较。',
          '非两种 Web 协议一律拒绝。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/plugin-ui/app/pluginUiPageManager.ts',
    target: 40,
    header: [
      '// INV-01 页面按 key 唯一：守住位置 pages 映射；改错故障 同 key 覆盖活页面。',
      '// INV-02 每个任务一组 key：守住位置 tasks；改错故障 无法按任务回收。',
      '// INV-03 任务上限三十：守住位置 容量判断；改错故障 后台任务无限增长。',
      '// INV-04 沙箱槽位上限六十四：守住位置 reserve；改错故障 同时存活页面失控。',
      '// INV-05 所有准入串行：守住位置 admission 链；改错故障 并发添加突破容量。',
      '// INV-06 取消标记先于入队：守住位置 pendingAdds；改错故障 已移除页面仍被创建。',
      '// INV-07 回收只选不可见且空闲：守住位置 候选过滤；改错故障 正在使用的页面被销毁。',
      '// INV-08 挂起失败即换下一个：守住位置 suspend 返回值；改错故障 回收卡在首个候选。',
      '// INV-09 回收后再次校验页面身份：守住位置 第二次判断；改错故障 撤销的槽位被旧页占用。',
      '// INV-10 重复 key 直接报错：守住位置 pages.has；改错故障 两个 controller 同时持有。',
      '// INV-11 隐藏延迟回收：守住位置 五分钟计时；改错故障 切走即销毁丢失状态。',
      '// INV-12 计时器按 key 单份：守住位置 timers；改错故障 重复隐藏叠加多个计时。',
      '// INV-13 可见时刷新任务顺序：守住位置 删除后重设；改错故障 淘汰顺序长期不变。',
      '// INV-14 结算时无计时才挂起：守住位置 settled；改错故障 与计时器重复挂起。',
      '// INV-15 释放只移除分配记录：守住位置 released；改错故障 连活页面一起销毁。',
      '// INV-16 移除任务清理全部页面：守住位置 removeTask；改错故障 键集合残留。',
      '// INV-17 清空先取消全部在途：守住位置 clear；改错故障 关闭后仍有页面创建。',
      '// INV-18 管理器不直接渲染：守住位置 类职责；改错故障 视图与生命周期耦合。',
      '//',
      '// 模块职责：管理窗口级 MCP App 页面的准入、容量与回收。',
      '// 状态所有权：页面、任务、计时器与准入链均由管理器独占。',
      '// 阅读顺序：先看添加与预留的准入，再看可见性回收，最后看移除与清空。',
    ],
    blocks: [
      {
        anchor: 'export class PluginUiPageManager<T extends ManagedPluginPage> {',
        lines: [
          '按 key 持有窗口级页面。',
          '任务集合用于容量与回收。',
          '准入链保证操作串行。',
        ],
      },
      {
        anchor: 'add(page: T): Promise<void> {',
        lines: [
          '先登记可取消标记。',
          '入队后统一走串行链。',
          '被取消的添加不再占用槽位。',
        ],
      },
      {
        anchor: 'if (!this.tasks.has(page.task) && this.tasks.size >= 30) {',
        lines: [
          '任务数达到上限才回收。',
          '只回收不可见且空闲的任务。',
          '回收失败即报告容量耗尽。',
        ],
      },
      {
        anchor: 'reserve(page: T): Promise<void> {',
        lines: [
          '已分配的直接返回。',
          '沙箱槽位上限六十四。',
          '回收同样尊重可见与忙碌。',
        ],
      },
      {
        anchor: 'visibility(page: T, visible: boolean): void {',
        lines: [
          '页面身份不匹配即忽略。',
          '隐藏后启动回收计时。',
          '重新可见时刷新任务顺序。',
        ],
      },
      {
        anchor: 'removeTask(task: string): void {',
        lines: [
          '先取消该任务在途添加。',
          '逐个销毁页面并清理计时器。',
          '最后通知外部清理任务。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/previewPaneOfficeContent.tsx',
    target: 39,
    header: [
      '// INV-01 三种格式各自懒加载：守住位置 lazy 常量；改错故障 首包体积失控。',
      '// INV-02 默认导出与文件名对齐：守住位置 import 映射；改错故障 懒加载拿到空模块。',
      '// INV-03 渲染错误就地兜底：守住位置 错误边界；改错故障 整个预览区白屏。',
      '// INV-04 错误态由复位键清理：守住位置 componentDidUpdate；改错故障 换文件后仍显示错误。',
      '// INV-05 错误上报走统一日志：守住位置 componentDidCatch；改错故障 线上无法定位。',
      '// INV-06 加载态是纯占位：守住位置 OfficePreviewLoading；改错故障 占位抢占交互。',
      '// INV-07 错误提示带 alert 语义：守住位置 role 属性；改错故障 读屏不播报失败。',
      '// INV-08 解码只在有数据时进行：守住位置 useMemo；改错故障 空数据触发异常。',
      '// INV-09 解码结果按预览对象缓存：守住位置 依赖数组；改错故障 每帧重复解码。',
      '// INV-10 无错误无数据仍算加载：守住位置 分支判断；改错故障 空白页没有任何提示。',
      '// INV-11 有错误优先于有数据：守住位置 错误分支；改错故障 损坏文件仍尝试渲染。',
      '// INV-12 兜底文案走国际化：守住位置 formatMessage；改错故障 中文硬编码直接透出。',
      '// INV-13 主题只传明暗两值：守住位置 resolvedTheme；改错故障 子组件拿到未知主题。',
      '// INV-14 外链打开由宿主注入：守住位置 onOpenBrowserUrl；改错故障 预览内直接导航。',
      '// INV-15 格式分支必须穷尽：守住位置 三元链；改错故障 新格式落到旧 doc 渲染器。',
      '// INV-16 缓冲以二进制传入：守住位置 buffer；改错故障 文本解码破坏二进制。',
      '// INV-17 面板只组合不解析：守住位置 组件体；改错故障 预览逻辑被重复实现。',
      '// INV-18 测试标识与请求参数一致：守住位置 sourcePath 与 resetKey；改错故障 不同文件共用缓存。',
      '//',
      '// 模块职责：组合 Office 三种格式的预览渲染、加载态与错误兜底。',
      '// 状态所有权：数据与格式来自上层 props；仅错误边界持有错误态。',
      '// 阅读顺序：先看懒加载与错误边界，再看数据解码与分支，最后看渲染树。',
    ],
    blocks: [
      {
        anchor: 'const LazyXlsxContent = lazy(async () => {',
        lines: [
          '三种格式各自拆包。',
          '独立 chunk 降低首包体积。',
          '加载期间由 Suspense 接管。',
          '默认导出与组件名对齐。',
        ],
      },
      {
        anchor: 'class OfficePreviewErrorBoundary extends Component<',
        lines: [
          '边界只捕获子树渲染错误。',
          '错误态保存在实例 state。',
          '复位键变化时清除错误。',
          '捕获后上报统一日志。',
        ],
      },
      {
        anchor: 'componentDidUpdate(previousProps: Readonly<{ resetKey: string }>) {',
        lines: [
          '仅在出错后检查复位键。',
          '切换文件即重新尝试渲染。',
          '同一文件重渲染不重置。',
        ],
      },
      {
        anchor: 'const buffer = useMemo(',
        lines: [
          '仅当存在预览数据时解码。',
          '依赖项只有预览对象。',
          '解码结果随预览切换重算。',
        ],
      },
      {
        anchor: 'if (loading || (!error && !buffer)) {',
        lines: [
          '加载中优先显示占位。',
          '无数据且无错误时保持占位。',
          '错误与数据都不存在才进入兜底。',
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
    `ZC-deep-b147-spec-${index}.json`,
    JSON.stringify({ files: [{ file: spec.file, items }] }, null, 2),
    'utf8',
  );
  console.log(`spec ${index}: ${spec.file} lines=${total}`);
  index += 1;
}
