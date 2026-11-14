import fs from 'node:fs';

const specs = [
  {
    file: 'packages/server/src/source-server/sourceServerTransportRuntime.ts',
    target: 37,
    header: [
      '// INV-01 单引号包裹参数：守住位置 quoteShellArg；改错故障 含空格命令被拆分。',
      '// INV-02 单引号转义序列固定：守住位置 replaceAll；改错故障 参数可逃逸注入。',
      '// INV-03 只在中止时抛错：守住位置 aborted 判断；改错故障 正常路径也抛错。',
      '// INV-04 错误名固定 AbortError：守住位置 name 赋值；改错故障 调用方无法识别取消。',
      '// INV-05 JSON 从后往前找：守住位置 倒序遍历；改错故障 警告行遮住结果。',
      '// INV-06 只认以花括号开头的行：守住位置 startsWith；改错故障 混合日志被解析。',
      '// INV-07 解析失败继续向前：守住位置 try/catch；改错故障 单行噪音中断搜索。',
      '// INV-08 找不到 JSON 立即报错：守住位置 末尾 throw；改错故障 返回空对象。',
      '// INV-09 结构化错误只取字符串：守住位置 typeof；改错故障 对象被当消息。',
      '// INV-10 错误读取失败返回空：守住位置 外层 catch；改错故障 二次抛错掩盖主因。',
      '// INV-11 版本号先试整行精确匹配：守住位置 exact；改错故障 带前缀输出的版本丢失。',
      '// INV-12 带标签的版本同样收集：守住位置 labelled 正则；改错故障 安装脚本输出无法识别。',
      '// INV-13 多版本视为不确定：守住位置 size 判断；改错故障 随机取一个版本。',
      '// INV-14 关闭事件只结算一次：守住位置 subscription.dispose；改错故障 重复 resolve。',
      '// INV-15 文本三路并发收集：守住位置 Promise.all；改错故障 串行导致管道互锁。',
      '// INV-16 行回调按换行切分：守住位置 indexOf；改错故障 进度行粘连。',
      '// INV-17 尾部残行补发：守住位置 decoder.end；改错故障 最后一行丢失。',
      '// INV-18 duplex 先暂停输出：守住位置 output.pause；改错故障 背压失效内存暴涨。',
      '//',
      '// 模块职责：Source Server 传输层的 shell 引号、JSON 结果解析与 stdio 双工桥。',
      '// 状态所有权：无跨调用状态；每条命令的流由调用方持有。',
      '// 阅读顺序：先看引号与中止，再看结果解析，最后看 stdio 桥。',
    ],
    blocks: [
      {
        anchor: 'export function quoteShellArg(value: string): string {',
        lines: [
          '单引号包裹整个参数。',
          '内部单引号按固定序列转义。',
          '保持纯函数便于复用。',
        ],
      },
      {
        anchor: 'export function throwIfAborted(signal?: AbortSignal): void {',
        lines: [
          '无信号直接返回。',
          '仅中止时抛错。',
          '错误名固定便于识别。',
        ],
      },
      {
        anchor: 'export function readLastJsonLine(value: string): Record<string, unknown> {',
        lines: [
          '从后往前扫描。',
          '只认花括号开头的行。',
          '解析失败继续向前。',
        ],
      },
      {
        anchor: 'export function readUniqueVersion(value: string): string | undefined {',
        lines: [
          '先试整行精确匹配。',
          '再扫带标签的输出行。',
          '多版本时返回空。',
        ],
      },
      {
        anchor: 'export function duplexFromStdio(stream: StdioStream): Duplex {',
        lines: [
          '先暂停输出。',
          '按背压恢复读取。',
          '关闭按退出码区分。',
        ],
      },
    ],
  },
  {
    file: 'packages/shared/src/feedback.ts',
    target: 38,
    header: [
      '// INV-01 类型枚举覆盖四类：守住位置 FeedbackTicketType；改错故障 后端新增类型被拒。',
      '// INV-02 状态枚举覆盖九态：守住位置 FeedbackTicketStatus；改错故障 状态显示回退为未知。',
      '// INV-03 模块枚举与下拉一致：守住位置 FeedbackTicketModule；改错故障 选项与校验不一致。',
      '// INV-04 空字符串用哨兵替代：守住位置 FEEDBACK_FRAMEWORK_NONE；改错故障 Radix Select 抛错。',
      '// INV-05 提交前转回未指定：守住位置 选择值类型；改错故障 后端收到 none。',
      '// INV-06 采集字段全部可选：守住位置 FeedbackDeviceInfo；改错故障 缺字段构造失败。',
      '// INV-07 描述必填标题必填：守住位置 CreateFeedbackTicketInput；改错故障 空工单入库。',
      '// INV-08 语言仅走请求头：守住位置 locale 注释；改错故障 中文标识写入正文。',
      '// INV-09 摘要不含正文：守住位置 FeedbackTicketSummary；改错故障 列表响应体积翻倍。',
      '// INV-10 未读与活动时间可选：守住位置 unread 与 last_user_activity_at；改错故障 旧后端解析失败。',
      '// INV-11 事件载荷可选：守住位置 payload；改错故障 缺载荷事件被丢弃。',
      '// INV-12 附件含脱敏标志：守住位置 redacted；改错故障 前端误展示敏感内容。',
      '// INV-13 评论附件与工单附件分离：守住位置 两个附件类型；改错故障 字段混用。',
      '// INV-14 详情继承摘要：守住位置 extends；改错故障 字段重复定义漂移。',
      '// INV-15 列表查询分页可选：守住位置 FeedbackListQuery；改错故障 默认全量拉取。',
      '// INV-16 模块顺序与后端一致：守住位置 FEEDBACK_TICKET_MODULES；改错故障 下拉顺序漂移。',
      '// INV-17 类型值文案成对：守住位置 FEEDBACK_TICKET_TYPES；改错故障 表单渲染错位。',
      '// INV-18 含未指定的完整列表单独导出：守住位置 FEEDBACK_TICKET_FRAMEWORKS；改错故障 管理端缺选项。',
      '//',
      '// 模块职责：声明反馈工单的类型、状态、模块、请求体与响应结构。',
      '// 状态所有权：纯类型与常量，不持有运行状态。',
      '// 阅读顺序：先看三个枚举，再看请求与响应结构，最后看常量表。',
    ],
    blocks: [
      {
        anchor: 'export interface FeedbackDeviceInfo {',
        lines: [
          '采集字段全部可选。',
          '模型展示名可回退。',
          '时间与平台字段分开。',
        ],
      },
      {
        anchor: 'export interface CreateFeedbackTicketInput {',
        lines: [
          '标题与描述必填。',
          '联系人与语言可选。',
          '语言仅走请求头。',
        ],
      },
      {
        anchor: 'export interface FeedbackTicketDetail extends FeedbackTicketSummary {',
        lines: [
          '继承摘要字段。',
          '正文只在详情出现。',
          '附件与评论分开声明。',
        ],
      },
      {
        anchor: 'export const FEEDBACK_TICKET_MODULES: FeedbackTicketModule[] = [',
        lines: [
          '顺序与后端一致。',
          '覆盖全部模块。',
          '供下拉与校验共用。',
          '与联合类型保持同步。',
        ],
      },
      {
        anchor: 'export const FEEDBACK_TICKET_TYPES: { value: FeedbackTicketType; label: string }[] = [',
        lines: [
          '值与文案成对。',
          '顺序稳定。',
          '供表单直接渲染。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/components/marketing-touch/MarketingBanner.tsx',
    target: 38,
    header: [
      '// INV-01 视图按资源键重建：守住位置 key；改错故障 换素材后仍显示旧帧。',
      '// INV-02 资源键优先级：守住位置 三元链；改错故障 iframe 复用旧 URL。',
      '// INV-03 无 bundle 即视为就绪：守住位置 ready 计算；改错故障 图片永久隐藏。',
      '// INV-04 bundle 就绪由子组件回调：守住位置 onReadyChange；改错故障 容器一直零高度。',
      '// INV-05 失焦清悬停：守住位置 blur 监听；改错故障 切走后仍播动效。',
      '// INV-06 页面隐藏清悬停：守住位置 visibilitychange；改错故障 后台仍耗电。',
      '// INV-07 监听在卸载时移除：守住位置 清理函数；改错故障 监听泄漏。',
      '// INV-08 只对鼠标指针置悬停：守住位置 pointerType；改错故障 触摸后悬停卡住。',
      '// INV-09 未就绪时零高度占位：守住位置 style 分支；改错故障 布局跳动。',
      '// INV-10 按钮承担唯一点击入口：守住位置 外层 button；改错故障 内层 iframe 抢焦点。',
      '// INV-11 内层一律 aria-hidden：守住位置 两个 span；改错故障 读屏重复播报。',
      '// INV-12 内层禁止指针事件：守住位置 pointer-events-none；改错故障 点击落进 iframe。',
      '// INV-13 无动作时禁用按钮：守住位置 hasAction；改错故障 点击毫无响应。',
      '// INV-14 加载态优先于关闭：守住位置 三元顺序；改错故障 两个覆盖层重叠。',
      '// INV-15 关闭按钮阻止冒泡：守住位置 stopPropagation；改错故障 关闭同时触发打开。',
      '// INV-16 图片不可拖拽：守住位置 draggable；改错故障 拖拽产生幽灵图。',
      '// INV-17 圆角只在按钮上裁切：守住位置 overflow-hidden；改错故障 素材越过圆角。',
      '// INV-18 关闭与加载共用右上角位：守住位置 absolute 定位；改错故障 覆盖层错位。',
      '//',
      '// 模块职责：渲染营销横幅，承载图片、视频或交互 bundle，并处理打开与关闭。',
      '// 状态所有权：bundle 就绪与悬停为本地状态；开关与文案由父级注入。',
      '// 阅读顺序：先看资源键，再看就绪与悬停，最后看覆盖层分支。',
    ],
    blocks: [
      {
        anchor: 'export function MarketingBannerView(props: MarketingBannerProps) {',
        lines: [
          '按资源键重建子树。',
          '键优先 bundle，再视频，最后图片。',
          '属性原样下传。',
          '无资源时回退图片分支。',
        ],
      },
      {
        anchor: 'function MarketingBannerContent(props: MarketingBannerProps) {',
        lines: [
          'bundle 就绪由回调更新。',
          '无 bundle 即视为就绪。',
          '悬停只对鼠标生效。',
          '监听在卸载时移除。',
        ],
      },
      {
        anchor: '  const ready = !props.bundle || bundleReady;',
        lines: [
          '未就绪时零高度占位。',
          '就绪后恢复正常流。',
          '透明度交由内容决定。',
          '占位避免布局跳动。',
        ],
      },
      {
        anchor: '  useEffect(() => {',
        lines: [
          '失焦清悬停。',
          '页面隐藏清悬停。',
          '卸载时移除两个监听。',
          '依赖为空只注册一次。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/components/ui/flip-metric-value.tsx',
    target: 38,
    header: [
      '// INV-01 减少动效时全部静态：守住位置 reducedMotion；改错故障 前庭不适。',
      '// INV-02 服务端渲染无 window：守住位置 typeof 判断；改错故障 SSR 崩溃。',
      '// INV-03 matchMedia 缺失直接返回：守住位置 函数判断；改错故障 旧环境抛错。',
      '// INV-04 新旧监听 API 都兼容：守住位置 addEventListener 判断；改错故障 旧内核不回退。',
      '// INV-05 注册后立即同步一次：守住位置 update 调用；改错故障 首帧使用默认值。',
      '// INV-06 卸载时移除监听：守住位置 两个清理函数；改错故障 监听泄漏。',
      '// INV-07 数字槽宽固定：守住位置 isDigitCharacter；改错故障 数字跳动引发横向抖动。',
      '// INV-08 冒号与点更窄：守住位置 分支；改错故障 时间格式过宽。',
      '// INV-09 其余字符统一宽度：守住位置 默认分支；改错故障 单位挤压。',
      '// INV-10 非数字不走翻转：守住位置 早退；改错故障 单位也被翻页。',
      '// INV-11 槽高固定并居中：守住位置 固定高度类；改错故障 基线错位。',
      '// INV-12 翻页只在槽内裁切：守住位置 overflow-hidden；改错故障 字符越界。',
      '// INV-13 键含索引与字符：守住位置 key 拼接；改错故障 同字符重复触发动效。',
      '// INV-14 初始动画可关闭：守住位置 animateInitial；改错故障 首屏闪烁。',
      '// INV-15 字符按码点拆分：守住位置 Array.from；改错故障 emoji 被拆断。',
      '// INV-16 可访问名称取完整值：守住位置 aria-label；改错故障 读屏逐字念。',
      '// INV-17 值同时作为标题：守住位置 title；改错故障 截断后无法查看全值。',
      '// INV-18 容器不换行且裁切：守住位置 whitespace-nowrap；改错故障 指标换行撑高。',
      '//',
      '// 模块职责：把指标字符串逐字符渲染为可翻页的固定宽度槽位。',
      '// 状态所有权：减少动效偏好由媒体查询派生，其余全部来自 props。',
      '// 阅读顺序：先看媒体查询，再看字符宽度，最后看两个组件。',
    ],
    blocks: [
      {
        anchor: 'function usePrefersReducedMotion() {',
        lines: [
          '服务端渲染直接返回。',
          '无匹配能力直接返回。',
          '注册后同步一次。',
        ],
      },
      {
        anchor: 'function getCharacterWidthClass(character: string) {',
        lines: [
          '数字固定宽。',
          '标点更窄。',
          '其余统一宽。',
        ],
      },
      {
        anchor: 'function MetricCharacter({',
        lines: [
          '非数字不走翻转。',
          '槽高固定并居中。',
          '翻页只在槽内裁切。',
        ],
      },
      {
        anchor: 'export function FlipMetricValue({',
        lines: [
          '减少动效时静态。',
          '字符按码点拆分。',
          '可访问名取完整值。',
          '初始动画可关闭。',
        ],
      },
      {
        anchor: '  return (',
        nth: 2,
        lines: [
          '容器不换行。',
          '超出部分裁切。',
          '标题保留完整值。',
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
    `ZC-deep-b159-spec-${index}.json`,
    JSON.stringify({ files: [{ file: spec.file, items }] }, null, 2),
    'utf8',
  );
  console.log(`spec ${index}: ${spec.file} lines=${total}`);
  index += 1;
}
