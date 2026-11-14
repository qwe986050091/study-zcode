import fs from 'node:fs';

const specs = [
  {
    file: 'packages/ui/src/settings/AutomationDesignPrimitives.tsx',
    target: 40,
    header: [
      '// INV-01 图标统一从一处再导出：守住位置 模块顶部；改错故障 各页面各自引用图标库。',
      '// INV-02 返回入口只变色不改热区：守住位置 类名常量；改错故障 点击区域随 hover 收缩。',
      '// INV-03 表单间距用 gap 不用 margin：守住位置 类名常量；改错故障 行盒让实际间距小于设计值。',
      '// INV-04 空态高度固定：守住位置 容器类名；改错故障 定时与闲时两页高度不一致。',
      '// INV-05 分段页签复用同一组件：守住位置 渲染；改错故障 详情页与列表页样式漂移。',
      '// INV-06 页签值只两种：守住位置 联合类型；改错故障 出现第三种值导致空面板。',
      '// INV-07 页签标签由调用方注入：守住位置 props；改错故障 组件内硬编码文案无法国际化。',
      '// INV-08 保持唤醒用共享设置：守住位置 受控 props；改错故障 页面级 mock 与服务端不一致。',
      '// INV-09 提示条带稳定标识：守住位置 属性；改错故障 端到端用例找不到提示条。',
      '// INV-10 提示图标对读屏隐藏：守住位置 aria 属性；改错故障 读屏重复朗读装饰图标。',
      '// INV-11 开关与提示共用文案：守住位置 aria 标签；改错故障 开关没有可读名称。',
      '// INV-12 提示条垂直内边距回填：守住位置 类名；改错故障 桌面断点下高度不足。',
      '// INV-13 创建入口分成两个按钮：守住位置 结构；改错故障 手动创建缺少独立入口。',
      '// INV-14 手动按钮带测试标识：守住位置 data-testid；改错故障 用例只能按文案定位。',
      '// INV-15 菜单按钮带可读名称：守住位置 aria-label；改错故障 图标按钮无名称。',
      '// INV-16 下拉菜单贴边对齐：守住位置 对齐参数；改错故障 菜单溢出右侧被裁切。',
      '// INV-17 菜单项按需回调：守住位置 onSelect；改错故障 菜单打开即触发创建。',
      '// INV-18 组件不取全局状态：守住位置 入参；改错故障 同一组件在设置页外复用受限。',
      '//',
      '// 模块职责：自动化设置页共用的排版、空态与创建入口组件。',
      '// 状态所有权：无业务状态；开关值与页签值都由调用方持有。',
      '// 阅读顺序：先看类名常量，再看两个空态与页签，最后看提示条与创建入口。',
    ],
    blocks: [
      {
        anchor: 'export function AutomationHistoryEmptyState({',
        lines: [
          '空态高度与卡片边框固定。',
          '文案由调用方传入。',
          '两页共用避免样式漂移。',
          '容器不处理加载态。',
          '布局变化只改这一处。',
        ],
      },
      {
        anchor: 'export function AutomationSettingsHistoryTabs({',
        lines: [
          '页签是受控组件。',
          '选项固定为设置与历史。',
          '标签文案由调用方给出。',
          '切换只上报不自行保存。',
          '复用设置页分段样式。',
        ],
      },
      {
        anchor: 'export function AutomationKeepAwakeNotice({',
        lines: [
          '开关值来自全局共享设置。',
          '图标仅作装饰。',
          '文案同时用于提示与开关名称。',
          '内边距按设计规格回填。',
        ],
      },
      {
        anchor: 'export function AutomationCreateDropdown({',
        lines: [
          '主按钮直接进入手动创建。',
          '箭头按钮只负责展开菜单。',
          '菜单项才触发对话创建。',
          '两个入口共享同一视觉组。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/ToolCallBlocks/renderers/plan-guidance.tsx',
    target: 41,
    header: [
      '// INV-01 输出优先于输入：守住位置 候选顺序；改错故障 回显请求而非指导正文。',
      '// INV-02 字符串先 trim 再判空：守住位置 取值；改错故障 纯空白被当成有效内容。',
      '// INV-03 对象只认三个键：守住位置 字段白名单；改错故障 任意键被渲染成正文。',
      '// INV-04 原始输出支持两种形态：守住位置 rawOutput 分支；改错故障 结构化输出丢失。',
      '// INV-05 内容数组逐项下钻：守住位置 循环；改错故障 嵌套内容被整体丢弃。',
      '// INV-06 数组元素必须为对象：守住位置 类型守卫；改错故障 字符串元素引发属性访问错误。',
      '// INV-07 内层 content 优先：守住位置 嵌套判断；改错故障 外层元数据被当成正文。',
      '// INV-08 找不到正文返回未定义：守住位置 末尾；改错故障 空串被当成有效内容。',
      '// INV-09 有正文时不显示原始输出：守住位置 三元分支；改错故障 正文与 JSON 同时出现。',
      '// INV-10 失败时正文退让给错误：守住位置 输出参数；改错故障 错误与半截正文混杂。',
      '// INV-11 渲染回调依赖显式列出：守住位置 useCallback；改错故障 上下文变化后仍用旧回调。',
      '// INV-12 空正文走通用输出组件：守住位置 分支；改错故障 空白区域无任何提示。',
      '// INV-13 图标常量模块级复用：守住位置 顶部；改错故障 每次渲染重建元素。',
      '// INV-14 失败状态才显示状态标：守住位置 条件；改错故障 成功状态也带失败样式。',
      '// INV-15 失败提示复用错误文本：守住位置 悬浮说明；改错故障 提示与实际错误不一致。',
      '// INV-16 展示开关支持外部覆盖：守住位置 合并；改错故障 调用方无法折叠。',
      '// INV-17 快照提示独立渲染：守住位置 末尾节点；改错故障 快照引用无法按需加载。',
      '// INV-18 工具名与标题原样透传：守住位置 布局入参；改错故障 标题被改写丢失来源。',
      '//',
      '// 模块职责：把计划指导工具的调用结果渲染成 Markdown 正文。',
      '// 状态所有权：无状态；正文与错误都从上下文实时推导。',
      '// 阅读顺序：先看正文提取，再看渲染回调，最后看布局装配。',
    ],
    blocks: [
      {
        anchor: 'export function PlanGuidanceToolCallBlock(context: ToolCallBlockRenderContext) {',
        lines: [
          '正文与错误各取一次。',
          '渲染回调按上下文依赖重建。',
          '布局入参全部来自上下文。',
          '失败态才挂状态标签。',
          '快照提示放在布局之后。',
        ],
      },
      {
        anchor: 'function extractGuidanceMarkdown(',
        lines: [
          '输出与输入按优先级尝试。',
          '字符串直接作为候选。',
          '对象走固定字段读取。',
          '原始载荷做最后兜底。',
          '全部落空才返回未定义。',
        ],
      },
      {
        anchor: 'const renderContent = useCallback(',
        lines: [
          '正文存在时渲染 Markdown。',
          '预览与链接能力来自上下文。',
          '正文缺失时退到通用输出。',
          '失败时输出位让给错误。',
          '依赖数组与入参一一对应。',
        ],
      },
      {
        anchor: 'const PLAN_GUIDANCE_TOOL_ICON = <NotepadText className="size-4 shrink-0 text-foreground-subtle" />;',
        lines: [
          '图标元素在模块级创建一次。',
          '尺寸与颜色跟随设计变量。',
          '布局组件只接收元素本身。',
          '换图标不影响渲染逻辑。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/v4/composer/useWebElementContexts.ts',
    target: 41,
    header: [
      '// INV-01 作用域变化即清空：守住位置 首个副作用；改错故障 切会话后残留上一条目。',
      '// INV-02 工作区键参与过滤：守住位置 两个事件处理；改错故障 其他工作区的元素混入。',
      '// INV-03 工作区键含身份：守住位置 键函数；改错故障 同路径不同账号互相串数据。',
      '// INV-04 监听可整体关闭：守住位置 开关判断；改错故障 无窗口环境仍注册监听。',
      '// INV-05 无窗口环境即退出：守住位置 环境判断；改错故障 服务端渲染时报错。',
      '// INV-06 新增事件先验形状：守住位置 类型守卫；改错故障 任意自定义事件被消费。',
      '// INV-07 载荷非法直接丢弃：守住位置 转换函数；改错故障 缺字段附件进入输入框。',
      '// INV-08 缺标识时补发一个：守住位置 转换；改错故障 同一条目无法去重。',
      '// INV-09 按标识就地替换：守住位置 更新分支；改错故障 重复添加产生两条相同条目。',
      '// INV-10 命中即阻止默认行为：守住位置 事件处理；改错故障 同一事件被多处重复处理。',
      '// INV-11 移除事件双校验：守住位置 两个守卫；改错故障 非本模块事件触发删除。',
      '// INV-12 移除按标识过滤：守住位置 回调；改错故障 误删其他条目。',
      '// INV-13 卸载时解绑：守住位置 清理函数；改错故障 监听器随组件泄漏。',
      '// INV-14 监听依赖含键与删除回调：守住位置 依赖数组；改错故障 工作区切换后仍用旧键。',
      '// INV-15 清空后列表为空：守住位置 清空回调；改错故障 旧数组仍被返回。',
      '// INV-16 返回值整体记忆：守住位置 useMemo；改错故障 每次渲染产生新对象触发重渲染。',
      '// INV-17 有无条目由长度推导：守住位置 返回字段；改错故障 布尔值与列表不同步。',
      '// INV-18 对外只暴露只读数组：守住位置 类型声明；改错故障 调用方直接改写内部列表。',
      '//',
      '// 模块职责：维护输入框里的网页元素附件，并响应跨窗口自定义事件。',
      '// 状态所有权：附件列表归本 hook；作用域与工作区信息来自入参。',
      '// 阅读顺序：先看状态与键，再看两个事件处理，最后看返回值装配。',
    ],
    blocks: [
      {
        anchor: 'export function useWebElementContexts({',
        lines: [
          '附件列表只在本 hook 内可变。',
          '工作区键由路径与身份合成。',
          '作用域变化时整体清空。',
          '删除与清空都是稳定回调。',
          '监听开关默认打开。',
        ],
      },
      {
        anchor: 'const handleAdd = (event: Event) => {',
        lines: [
          '先验事件形状再取载荷。',
          '载荷转换失败即返回。',
          '来源工作区不符则忽略。',
          '同标识替换而非追加。',
          '命中后阻止默认行为。',
        ],
      },
      {
        anchor: 'const handleRemove = (event: Event) => {',
        lines: [
          '事件与载荷分别校验。',
          '工作区不符直接返回。',
          '命中后按标识删除。',
          '删除复用稳定回调。',
          '不存在的标识无副作用。',
        ],
      },
      {
        anchor: 'function isRemovePayload(payload: unknown): payload is WebElementContextRemovePayload {',
        lines: [
          '标识与路径都要求非空。',
          '身份字段可缺省但类型必须对。',
          '非对象一律拒绝。',
          '守卫只做形状判断不转换。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/v4/conversationSharePreflightCache.ts',
    target: 41,
    header: [
      '// INV-01 指纹覆盖轮次全部行：守住位置 签名构造；改错故障 正文变化后仍命中旧预检。',
      '// INV-02 签名只取稳定字段：守住位置 映射；改错故障 临时渲染态导致指纹抖动。',
      '// INV-03 附件只取四项：守住位置 映射；改错故障 大字段参与哈希拖慢计算。',
      '// INV-04 预览候选参与指纹：守住位置 附加字段；改错故障 文件引用变化不触发重检。',
      '// INV-05 作用域三元组参与哈希：守住位置 scope；改错故障 跨会话命中同一缓存。',
      '// INV-06 上下文同名键优先：守住位置 空值合并；改错故障 显式覆盖被忽略。',
      '// INV-07 哈希固定八位十六进制：守住位置 末尾格式化；改错故障 键长度不稳定。',
      '// INV-08 缓存键用不可见分隔：守住位置 拼接；改错故障 作用域与轮次标识互相拼接误命中。',
      '// INV-09 全局错误去重：守住位置 过滤；改错故障 同一全局问题重复展示。',
      '// INV-10 有定位字段的不过早去重：守住位置 守卫；改错故障 多个待处理轮次被合并成一条。',
      '// INV-11 去重键覆盖全部判别字段：守住位置 JSON 构造；改错故障 不同问题被视为同一问题。',
      '// INV-12 首次出现才保留：守住位置 集合；改错故障 重复项占满列表。',
      '// INV-13 缺轮次明细时回落整体：守住位置 空值合并；改错故障 老宿主返回被当成失败。',
      '// INV-14 轮次结果按请求顺序产出：守住位置 map；改错故障 缓存条目顺序与选中顺序不一致。',
      '// INV-15 缺失判定含指纹比对：守住位置 过滤；改错故障 内容变化后仍认为已缓存。',
      '// INV-16 行数预算按组重算：守住位置 聚合；改错故障 沿用单批合计导致上限误判。',
      '// INV-17 任一缺失即放弃合并预算：守住位置 早退；改错故障 用不完整数据显示上限。',
      '// INV-18 上限取各组最小值：守住位置 归约；改错故障 取最大值放行超量分享。',
      '//',
      '// 模块职责：为会话分享预检生成轮次指纹、缓存键与聚合结果。',
      '// 状态所有权：纯函数模块；缓存本身由调用方持有。',
      '// 阅读顺序：先看指纹与键，再看问题去重，最后看条目构建与聚合。',
    ],
    blocks: [
      {
        anchor: 'export function conversationShareTurnFingerprint(',
        lines: [
          '先按轮次过滤出行。',
          '助手正文用于提取文件引用。',
          '预览候选只保留位置字段。',
          '行签名白名单式取字段。',
          '最终对整包 JSON 取哈希。',
        ],
      },
      {
        anchor: 'export function dedupeConversationShareIssues(',
        lines: [
          '按出现顺序过滤。',
          '有定位字段的问题一律保留。',
          '全局问题才进入去重。',
          '去重键包含全部判别字段。',
          '首次出现即登记。',
        ],
      },
      {
        anchor: 'export function buildConversationSharePreflightCacheEntries(',
        lines: [
          '轮次明细先建索引。',
          '数组缺失按空数组处理。',
          '按请求顺序逐个产出。',
          '缺明细时回落整体问题。',
          '每条都带上指纹。',
        ],
      },
      {
        anchor: 'export function aggregateConversationShareBlockingIssues(',
        lines: [
          '先收集全部阻断问题。',
          '缺预算信息则不合并行数问题。',
          '实际用量按组求和。',
          '上限取各组最小值再判超限。',
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
    `ZC-deep-b141-spec-${index}.json`,
    JSON.stringify({ files: [{ file: spec.file, items }] }, null, 2),
    'utf8',
  );
  console.log(`spec ${index}: ${spec.file} lines=${total}`);
  index += 1;
}
