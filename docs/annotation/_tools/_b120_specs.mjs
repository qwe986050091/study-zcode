import fs from 'node:fs';

const specs = [
  {
    file: 'packages/ui/src/components/workflow-timeline/WorkflowTimelineFills.tsx',
    first: 'import { PenIcon } from "lucide-react";',
    target: 45,
    header: [
      '// INV-01 新鲜窗口两秒：守住位置 FILL_FRESH_MS；改错故障 新补全不再高亮。',
      '// INV-02 只按补全身份与时刻重算：守住位置 稳定键 key；改错故障 定时器每帧重置。',
      '// INV-03 时钟只在新鲜窗口内存在：守住位置 compute 与定时器；改错故障 常驻计时持续渲染。',
      '// INV-04 统一按最新到期时刻清空：守住位置 最新时刻求和；改错故障 先到的补全提前熄灭。',
      '// INV-05 定时器卸载即清理：守住位置 effect 返回函数；改错故障 卸载后仍写状态。',
      '// INV-06 空集合不设定时器：守住位置 空集提前返回；改错故障 空转计时浪费。',
      '// INV-07 头识别只认元素：守住位置 元素类型判断；改错故障 图标目标被忽略。',
      '// INV-08 内部模式也认笔标：守住位置 查询分支；改错故障 站头按钮取不到补全。',
      '// INV-09 非可见焦点不画框：守住位置 可见焦点判断；改错故障 点击后框常亮。',
      '// INV-10 旧环境不抛错：守住位置 try 包裹；改错故障 旧测试环境直接报错。',
      '// INV-11 悬停优先于焦点：守住位置 空值合并顺序；改错故障 鼠标与键盘状态互相覆盖。',
      '// INV-12 禁用时不挂委托：守住位置 三元返回；改错故障 禁用组件仍响应指针。',
      '// INV-13 行宽按起始列归档：守住位置 Map 键；改错故障 多行图例互相覆盖。',
      '// INV-14 宽度未变复用旧对象：守住位置 深度比较；改错故障 每次提交都重渲染。',
      '// INV-15 尺寸变化由观察者补量：守住位置 尺寸观察器；改错故障 字体缩放后遮罩错位。',
      '// INV-16 量不到宽度时框照画：守住位置 零宽回退；改错故障 测试环境整块不渲染。',
      '// INV-17 同起点的头排成一行：守住位置 按起始列分组；改错故障 同起点头重叠。',
      '// INV-18 一次只亮一个框：守住位置 单值活动项；改错故障 嵌套补全叠加高亮。',
      '//',
      '// 模块职责：工作流时间线补全的头行与描边框渲染。',
      '// 状态所有权：新鲜集合由 hook 自维护；活动补全由调用方传入。',
      '// 阅读顺序：先看新鲜判定，再读头识别与行宽测量，最后看头与框渲染。',
    ],
    blocks: [
      {
        anchor: 'export function useFreshFills(',
        lines: [
          '只按身份与时刻重算。',
          '新鲜集合按需重建。',
          '空集直接返回不再计时。',
          '最新到期时刻统一延时。',
          '定时器只负责清空集合。',
          '卸载时取消计时。',
        ],
      },
      {
        anchor: 'function fillHeadOf(target: EventTarget, inside: boolean): string | undefined {',
        lines: [
          '非元素目标直接放弃。',
          '先找最近的补全头。',
          '内部模式再找笔标。',
          '只读数据集里的补全标识。',
          '找不到返回未定义。',
          '该函数不派发事件。',
        ],
      },
      {
        anchor: 'export function useFillHeadTarget(enabled: boolean): {',
        lines: [
          '悬停与焦点分开存放。',
          '指针进入即记录头。',
          '指针离开即清空。',
          '仅可见焦点才记录。',
          '禁用时返回空处理器。',
        ],
      },
      {
        anchor: 'function useRowWidths(key: string): {',
        lines: [
          '元素按起始列归档。',
          '提交后量一遍宽度。',
          '宽度相同复用旧对象。',
          '布局阶段先量一次。',
          '观察到尺寸变化再量。',
          '卸载时断开观察。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/GitPane/helpers.ts',
    first: 'import type { GitChangeSourceId, GitDiffResult } from "@zcode/shared";',
    target: 44,
    header: [
      '// INV-01 富预览字符阈值：守住位置 十八万常量；改错故障 超大文件整文件高亮卡死。',
      '// INV-02 富预览行数阈值：守住位置 一千二常量；改错故障 超长文件仍在主线程比较。',
      '// INV-03 来源文案缺省回退未暂存：守住位置 default 分支；改错故障 空来源显示空标题。',
      '// INV-04 不可用文案分三档：守住位置 分支表；改错故障 二进制与截断共用错误文案。',
      '// INV-05 缓存键只含来源与路径：守住位置 模板拼接；改错故障 不同来源互相覆盖。',
      '// INV-06 查找内容仅 patch 可用：守住位置 可用性判断；改错故障 非 patch 也进入查找。',
      '// INV-07 优先用整文件正文：守住位置 双侧非空判断；改错故障 命中差异文件头伪行。',
      '// INV-08 降级后只搜可见行：守住位置 过滤与映射；改错故障 命中预览中不存在的行。',
      '// INV-09 省略标记行不参与查找：守住位置 标记行数解析；改错故障 搜索定位到折叠提示。',
      '// INV-10 错误信息优先 message：守住位置 实例判断；改错故障 错误显示成对象字符串。',
      '// INV-11 结构化错误再读 message：守住位置 键存在判断；改错故障 第三方错误信息丢失。',
      '// INV-12 逻辑行数不计尾换行：守住位置 结尾判断；改错故障 行数阈值提前触发。',
      '// INV-13 缺失一侧即走 patch：守住位置 空值判断；改错故障 空文件被当作整文件删除。',
      '// INV-14 字符超限走 patch：守住位置 字符数求和；改错故障 大文件整文件比较。',
      '// INV-15 行数超限走 patch：守住位置 两侧取最大；改错故障 单侧超长仍走富预览。',
      '// INV-16 预览计划三态互斥：守住位置 联合类型；改错故障 同一文件走两条渲染路径。',
      '// INV-17 纯文本降级只认文本类型：守住位置 文件类型收口；改错故障 结构化文件丢失语义渲染。',
      '// INV-18 本模块不持有差异状态：守住位置 纯函数；改错故障 组件缓存过期差异。',
      '//',
      '// 模块职责：Git 面板的差异预览降级策略、查找内容与文案映射。',
      '// 状态所有权：无状态；差异数据由调用方传入。',
      '// 阅读顺序：先看阈值与文案映射，再读查找内容，最后看预览计划与降级收口。',
    ],
    blocks: [
      {
        anchor: 'export function getGitPaneDiffFindContent(diff: GitDiffResult | null): string | null {',
        lines: [
          '仅 patch 可用时处理。',
          '双侧正文优先拼接。',
          '否则按可见行拼接。',
          '省略标记行先剔除。',
          '每行剥掉差异标记。',
          '无内容返回空。',
        ],
      },
      {
        anchor: 'export function shouldRenderPatchOnlyGitDiffPreview(diff: GitDiffResult): boolean {',
        lines: [
          '无 patch 直接返回假。',
          '缺一侧正文立刻降级。',
          '字符数求和后比阈值。',
          '行数取两侧较大者。',
          '任一超限即降级。',
          '该判断不读渲染状态。',
        ],
      },
      {
        anchor: 'export function getGitPaneDiffPreviewPlan(diff: GitDiffResult | null): GitPaneDiffPreviewPlan {',
        lines: [
          '默认走富预览。',
          '纯文本降级最优先。',
          '其次判断 patch 专用。',
          '再尝试整段 patch 文本。',
          '最后回退 patch 预览。',
        ],
      },
      {
        anchor: 'export function shouldRenderPlainTextDiffPreview(patch: string): string[] | null {',
        lines: [
          '无降级行直接返回空。',
          '新增或删除文件才继续。',
          '取补丁中的文件名。',
          '仅文本类型允许降级。',
          '结构化文件保留语义渲染。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/UpdateStatusButton.tsx',
    first: 'import type { IPlatformService, UpdateStatePayload } from "@zcode/shared";',
    target: 44,
    header: [
      '// INV-01 无版本不渲染：守住位置 展示版本判断；改错故障 空版本出现空按钮。',
      '// INV-02 视图模型单一来源：守住位置 派生函数；改错故障 弹窗与按钮状态分叉。',
      '// INV-03 日志缓存键含语言与版本：守住位置 模板拼接；改错故障 切换语言命中旧日志。',
      '// INV-04 缓存上限八条：守住位置 容量判断；改错故障 长期运行内存持续增长。',
      '// INV-05 淘汰取最旧键：守住位置 键迭代首项；改错故障 新条目立即被删。',
      '// INV-06 实时日志优先于缓存：守住位置 空值合并顺序；改错故障 新日志被旧缓存覆盖。',
      '// INV-07 下载中隐藏日志：守住位置 阶段判断；改错故障 进度区被日志挤占。',
      '// INV-08 下载中按钮仍可点：守住位置 宽度条件；改错故障 用户无法进入窗口取消。',
      '// INV-09 下载中改用旋转图标：守住位置 三元分支；改错故障 显示普通更新图标。',
      '// INV-10 桌面优先开独立窗口：守住位置 能力判断；改错故障 网页弹窗与桌面窗口并存。',
      '// INV-11 无窗口能力回退弹窗：守住位置 回退分支；改错故障 点击无任何反应。',
      '// INV-12 弹窗开关归本组件：守住位置 局部开关；改错故障 外部无法关闭弹窗。',
      '// INV-13 外部链接走平台能力：守住位置 打开外链回调；改错故障 直接跳转丢失鉴权。',
      '// INV-14 响应式类名集中解析：守住位置 布局函数；改错故障 平台分支散落组件。',
      '// INV-15 提示标题按阶段三选：守住位置 三元链；改错故障 下载中仍显示可用提示。',
      '// INV-16 可访问名称与提示同源：守住位置 可访问名属性；改错故障 读屏与悬浮信息不一致。',
      '// INV-17 下载态不复用展开规则：守住位置 旋转图标分支；改错故障 图标被隐藏。',
      '// INV-18 本组件不写更新状态：守住位置 只读属性；改错故障 界面反向驱动更新机。',
      '//',
      '// 模块职责：顶部更新状态入口按钮，组合提示、日志悬浮与弹窗。',
      '// 状态所有权：弹窗开关与日志缓存为局部；更新状态由调用方传入。',
      '// 阅读顺序：先看视图模型与缓存，再读按钮状态分支，最后看入口与弹窗挂载。',
    ],
    blocks: [
      {
        anchor: 'const releaseNotesCacheRef = useRef(',
        lines: [
          '键由语言与版本拼成。',
          '只缓存已本地化的日志。',
          '超过八条淘汰最旧。',
          '缓存不参与渲染判定。',
          '组件卸载即释放。',
          '该缓存不写全局存储。',
        ],
      },
      {
        anchor: 'useEffect(() => {',
        lines: [
          '无键或无日志即返回。',
          '写入当前语言版本条目。',
          '容量超限删最早键。',
          '依赖含日期与日志。',
          '写入不触发额外渲染。',
          '该 effect 无清理函数。',
        ],
      },
      {
        anchor: 'const handleUpdateEntryClick = useCallback(() => {',
        lines: [
          '桌面优先开独立窗口。',
          '打开后不再弹网页弹窗。',
          '无窗口能力才开弹窗。',
          '回调只依赖平台服务。',
          '该函数不发网络请求。',
        ],
      },
      {
        anchor: 'const tooltipTitle =',
        lines: [
          '下载中显示进度或版本。',
          '完成态显示就绪提示。',
          '其余显示可用提示。',
          '文案全部走国际化。',
          '版本参数统一注入。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/v4/OffPeakNewTaskEntry.tsx',
    first: 'import { useCodingPlanEntryGate } from "@/settings/CodingPlanEntryButton.js";',
    target: 59,
    header: [
      '// INV-01 灰度未命中不渲染：守住位置 灰度判断；改错故障 未放量用户看到入口。',
      '// INV-02 关闭后本次会话不再出现：守住位置 关闭态；改错故障 关闭后立即复现。',
      '// INV-03 本地模板追加在远端之后：守住位置 合并缓存；改错故障 空白创建卡排到首位。',
      '// INV-04 远端模板依赖服务实例：守住位置 依赖数组；改错故障 模板列表不随服务更新。',
      '// INV-05 资格探测随设置修订：守住位置 修订号参数；改错故障 套餐变更后资格不刷新。',
      '// INV-06 套餐不可用两条判据：守住位置 不可用计算；改错故障 无套餐用户绕过门禁。',
      '// INV-07 主页只做导航放行：守住位置 点击内判断；改错故障 已购套餐用户被误拦。',
      '// INV-08 表单提交仍严格拦截：守住位置 门禁分层；改错故障 主页放行被当成提交放行。',
      '// INV-09 拦截时记录调试日志：守住位置 调试日志调用；改错故障 线上无法定位被拦原因。',
      '// INV-10 拦截时弹出套餐提示：守住位置 提示调用；改错故障 用户点击无任何反馈。',
      '// INV-11 草稿标题按当前语言生成：守住位置 物化传语言；改错故障 中文界面出现英文草稿。',
      '// INV-12 空白创建不预填标题：守住位置 自定义判断；改错故障 空白创建被写入模板文案。',
      '// INV-13 草稿带遥测来源：守住位置 遥测字段；改错故障 点击来源无法归因。',
      '// INV-14 先暂存再导航：守住位置 调用顺序；改错故障 创建页取不到草稿。',
      '// INV-15 导航回调可缺省：守住位置 可选调用；改错故障 未传回调时崩溃。',
      '// INV-16 入口固定在底部：守住位置 底部内边距；改错故障 入口与窗口底部贴合。',
      '// INV-17 宽度不依赖会话容器：守住位置 最大宽度类；改错故障 容器外宽度塌陷。',
      '// INV-18 模板栅格桌面三列：守住位置 响应式类；改错故障 窄屏出现横向滚动。',
      '//',
      '// 模块职责：新建任务页的闲时任务入口，展示引导横幅与模板卡。',
      '// 状态所有权：灰度、关闭态与待建草稿归闲时任务存储；模板来自模板服务。',
      '// 阅读顺序：先看灰度与模板合并，再读门禁与点击流程，最后看横幅与栅格结构。',
    ],
    blocks: [
      {
        anchor: 'const offPeakTemplates = useMemo(',
        lines: [
          '远端模板保持原顺序。',
          '本地空白创建追加在末尾。',
          '依赖只含远端列表。',
          '合并结果供栅格渲染。',
          '该合并不改写入参。',
        ],
      },
      {
        anchor: 'const entryGate = useCodingPlanEntryGate();',
        lines: [
          '入口门禁决定提示文案。',
          '加载态不给操作按钮。',
          '错误态提供重试。',
          '门禁状态不阻断渲染。',
          '提示动作按状态切换。',
        ],
      },
      {
        anchor: 'const entryPlanState = resolveCodingPlanEntryPlanStateFromProviderSettings(providerSettingsView);',
        lines: [
          '由设置视图推导套餐态。',
          '视图为空视为未知。',
          '结果供跳转埋点冻结。',
          '该值每次渲染重算。',
          '不写入全局缓存。',
        ],
      },
      {
        anchor: 'const codingPlanUnavailable =',
        lines: [
          '显式关闭视为不可用。',
          '未定义时才看设置视图。',
          '视图为空不判不可用。',
          '套餐非编码套餐即拦截。',
          '该判断只影响主页跳转。',
        ],
      },
      {
        anchor: 'const showCodingPlanRequiredToast = () => {',
        lines: [
          '文案优先用门禁标签。',
          '缺省走通用套餐提示。',
          '加载态不显示动作。',
          '错误态动作改为重试。',
          '正常态动作打开升级面板。',
          '提示可手动关闭。',
        ],
      },
      {
        anchor: 'const handleCardClick = (template: OffPeakAutomationTemplate) => {',
        lines: [
          '不可用先记日志再提示。',
          '命中门禁直接返回。',
          '按当前语言生成草稿。',
          '空白创建保持空标题。',
          '草稿带模板遥测来源。',
          '暂存后再请求导航。',
        ],
      },
      {
        anchor: 'return (',
        lines: [
          '入口常驻底部固定区间距。',
          '横幅整体水平居中。',
          '关闭按钮保留但隐藏。',
          '栅格桌面三列窄屏单列。',
          '卡片由同排最高内容拉伸。',
        ],
      },
    ],
  },
];

let index = 0;
for (const spec of specs) {
  const srcLines = fs.readFileSync('D:/code/ZCode/' + spec.file, 'utf8').split('\n');
  const firstAuto = srcLines[0].replace(/\r$/, '').trim();
  const firstAnchor = spec.first ?? firstAuto;
  if (spec.first && firstAnchor !== firstAuto) {
    console.error(`FIRST MISMATCH ${spec.file}\n  spec: ${spec.first}\n  file: ${firstAuto}`);
    process.exit(1);
  }
  const firstItem = { anchor: firstAnchor, raw: spec.header };
  if (spec.firstNth) firstItem.nth = spec.firstNth;
  const items = [firstItem];
  for (const block of spec.blocks) {
    const item = { anchor: block.anchor, lines: block.lines };
    if (block.nth) item.nth = block.nth;
    items.push(item);
  }
  const total = spec.header.length + spec.blocks.reduce((sum, b) => sum + b.lines.length, 0);
  const bodyTotal = spec.blocks.reduce((sum, b) => sum + b.lines.length, 0);
  console.log(`${spec.file} header=${spec.header.length} body=${bodyTotal} total=${total} expect=${spec.target} ${total === spec.target ? 'OK' : 'MISMATCH'}`);
  fs.writeFileSync(
    `ZC-deep-b120-spec-${index}.json`,
    JSON.stringify({ files: [{ file: spec.file, items }] }, null, 2),
    'utf8',
  );
  index += 1;
}
