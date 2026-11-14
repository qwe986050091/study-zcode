import fs from 'node:fs';

const specs = [
  {
    file: 'packages/ui/src/lib/modeConfigUpdateGuard.ts',
    target: 38,
    header: [
      '// INV-01 保护窗口仅三秒：守住位置 TTL 常量；改错故障 后续真实切换被吞掉。',
      '// INV-02 保护按工作区隔离：守住位置 状态键；改错故障 多工作区互相误伤。',
      '// INV-03 模式名归一化后比较：守住位置 normalizeModeId；改错故障 前后空格导致不匹配。',
      '// INV-04 过期即删除：守住位置 读取时判断；改错故障 陈旧守卫长期生效。',
      '// INV-05 空任务或空模式不登记：守住位置 早退；改错故障 无意义守卫拦截回包。',
      '// INV-06 登记记录任务与模式：守住位置 set 调用；改错故障 无法判断是否同一任务。',
      '// INV-07 带模式清除才精确删除：守住位置 模式比较；改错故障 误删其它切换的守卫。',
      '// INV-08 不带模式清除整工作区：守住位置 undefined 分支；改错故障 残留守卫。',
      '// INV-09 回包模式一致即确认：守住位置 ack 比较；改错故障 守卫永不释放。',
      '// INV-10 确认后删除守卫：守住位置 清除调用；改错故障 后续合法回包被拦截。',
      '// INV-11 任务不一致即放行：守住位置 任务比对；改错故障 其它任务的配置更新被丢弃。',
      '// INV-12 当前模式不一致即放行：守住位置 模式比对；改错故障 用户手动切换被回滚。',
      '// INV-13 回包已回到目标即放行并清除：守住位置 相等分支；改错故障 保护窗口一直挂着。',
      '// INV-14 仅当回包是另一模式才保留：守住位置 末尾布尔；改错故障 无害更新被拦截。',
      '// INV-15 无守卫默认放行：守住位置 空值早退；改错故障 所有配置更新被拒。',
      '// INV-16 状态键复用统一选择器：守住位置 resolveWorkspaceStateKey；改错故障 身份与路径口径分裂。',
      '// INV-17 只存内存不持久化：守住位置 模块级 Map；改错故障 重启后仍拦截。',
      '// INV-18 测试重置入口独立：守住位置 resetForTest；改错故障 单测之间互相污染。',
      '//',
      '// 模块职责：在本地发起模式切换后短暂拦截并发配置回包，避免刚切好的模式被旧响应回滚。',
      '// 状态所有权：模块级 Map 按工作区保存守卫，过期或确认后删除。',
      '// 阅读顺序：先看归一化与读取，再看登记与清除，最后看配置更新是否保留当前模式。',
    ],
    blocks: [
      {
        anchor: 'export function markPendingModeSwitchGuard(params: {',
        lines: [
          '归一化模式与任务标识。',
          '任一为空则不登记。',
          '按状态键写入并带过期时间。',
        ],
      },
      {
        anchor: 'function readPendingModeSwitchGuard(',
        lines: [
          '先解析工作区状态键。',
          '无守卫直接返回空。',
          '过期即删除并返回空。',
          '有效则原样返回。',
        ],
      },
      {
        anchor: 'export function clearPendingModeSwitchGuard(params: {',
        lines: [
          '不带模式时清空整个工作区。',
          '带模式时只删匹配项。',
          '模式不匹配则保留。',
        ],
      },
      {
        anchor: 'export function ackPendingModeSwitchGuardFromModeUpdate(params: {',
        lines: [
          '先读取当前守卫。',
          '模式一致才视为确认。',
          '确认即清除守卫。',
        ],
      },
      {
        anchor: 'export function shouldPreserveModeAgainstConfigUpdate(params: {',
        lines: [
          '任务不一致即放行。',
          '当前模式不一致即放行。',
          '回包已是目标则清除并放行。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/mentions/mentionSearch.ts',
    target: 38,
    header: [
      '// INV-01 查询去空白后判空：守住位置 hasMentionQuery；改错故障 空格被当成有效查询。',
      '// INV-02 空查询才用默认分组上限：守住位置 三元；改错故障 有查询时仍截断结果。',
      '// INV-03 空查询展示上限固定：守住位置 DISPLAY_CAP；改错故障 巨型仓库全量渲染。',
      '// INV-04 要求查询时不展示默认项：守住位置 requireQuery；改错故障 打开面板就渲染全量。',
      '// INV-05 前缀命中优先于子串：守住位置 前缀分支；改错故障 相关度排序颠倒。',
      '// INV-06 子串命中带位置权重：守住位置 索引偏移；改错故障 越靠后反而越靠前。',
      '// INV-07 中文只走前两级：守住位置 汉字正则；改错故障 「浏器」命中「浏览器操作」。',
      '// INV-08 英文保留子序列匹配：守住位置 子序列循环；改错故障 英文缩写搜不到。',
      '// INV-09 匹配失败返回空：守住位置 返回 null；改错故障 无关项混入结果。',
      '// INV-10 同分保持原序：守住位置 索引比较；改错故障 同分项顺序抖动。',
      '// INV-11 同分再按标签排序：守住位置 localeCompare；改错故障 多语言下顺序不稳定。',
      '// INV-12 分数加成体现字段权重：守住位置 加权常量；改错故障 描述命中压过标题命中。',
      '// INV-13 插件不参与描述匹配：守住位置 类别判断；改错故障 长描述引入无关候选。',
      '// INV-14 关键词命中附加固定分：守住位置 加分；改错故障 关键词结果排在标题后。',
      '// INV-15 上限非有限时返回全量：守住位置 有限性判断；改错故障 NaN 截断成空。',
      '// INV-16 上限取整且不为负：守住位置 夹取；改错故障 负数导致反向切片。',
      '// INV-17 目录排在文件之后：守住位置 默认优先级；改错故障 空查询时目录抢占首位。',
      '// INV-18 空分组结果被过滤：守住位置 buildVisibleMentionGroups；改错故障 渲染空标题分组。',
      '//',
      '// 模块职责：对提及候选项做空查询排序、模糊打分与结果上限裁剪。',
      '// 状态所有权：无状态；所有导出均为纯函数。',
      '// 阅读顺序：先看查询判空，再看打分与排序，最后看结果上限。',
    ],
    blocks: [
      {
        anchor: 'export function hasMentionQuery(query: string): boolean {',
        lines: [
          '去首尾空白。',
          '空串视为无查询。',
          '结果用于默认展示判断。',
        ],
      },
      {
        anchor: 'function scoreFuzzyMatch(text: string, query: string): number | null {',
        lines: [
          '空文本直接不匹配。',
          '空前缀返回零。',
          '前缀与子串分级。',
          '中文不做子序列。',
        ],
      },
      {
        anchor: 'function sortScoredItems<T>(',
        lines: [
          '先打分并过滤空值。',
          '同分保持原序。',
          '最后按标签稳定排序。',
        ],
      },
      {
        anchor: 'export function filterMentionItemsWithOptions(',
        lines: [
          '空查询按默认优先级。',
          '有查询走模糊打分。',
          '结果统一裁剪上限。',
        ],
      },
      {
        anchor: 'function applyMentionItemLimit(items: MentionItem[], limit?: number): MentionItem[] {',
        lines: [
          '非有限值返回全量。',
          '负数夹到零。',
          '按上限切片。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/project-sidebar/grouped/task-item.tsx',
    target: 38,
    header: [
      '// INV-01 空分组拖放区独立组件：守住位置 EmptyGroupDropZone；改错故障 分区逻辑重复。',
      '// INV-02 拖放标识带分组前缀：守住位置 拖放 id；改错故障 多个空分组互相覆盖。',
      '// INV-03 点击不冒泡到分组：守住位置 stopPropagation；改错故障 点击创建同时触发选中。',
      '// INV-04 指针与触摸同样阻止冒泡：守住位置 三个事件；改错故障 移动端触发父级拖拽。',
      '// INV-05 拖放区可访问性保留：守住位置 button 元素；改错故障 键盘无法触发创建。',
      '// INV-06 文案走国际化：守住位置 formatMessage；改错故障 硬编码中文。',
      '// INV-07 列表项组件纯展示：守住位置 GroupedTaskItemComponent；改错故障 组件内私藏业务状态。',
      '// INV-08 回调全部由外部注入：守住位置 props 结构；改错故障 内部直接访问 store。',
      '// INV-09 分组标识可为空：守住位置 groupId 可选；改错故障 未分组任务无法渲染。',
      '// INV-10 远程会话标识透传：守住位置 remoteSessionId；改错故障 远程任务操作打到本地。',
      '// INV-11 工作区身份透传：守住位置 activeWorkspaceIdentity；改错故障 同名路径工作区串数据。',
      '// INV-12 当前任务标识透传：守住位置 activeTaskId；改错故障 选中态错误。',
      '// INV-13 拖拽状态透传：守住位置 dragging 与 dragOverlay；改错故障 拖影与占位不一致。',
      '// INV-14 提示可按场景禁用：守住位置 tooltipsDisabled；改错故障 拖拽时提示遮挡。',
      '// INV-15 行容器样式统一：守住位置 外层 div；改错故障 悬浮态与分组不一致。',
      '// INV-16 记忆化避免重复渲染：守住位置 memo 包装；改错故障 大列表每次全量重绘。',
      '// INV-17 所有属性原样下传：守住位置 GroupedTaskRow；改错故障 新增属性在半路丢失。',
      '// INV-18 组件只负责布局：守住位置 单一返回；改错故障 副作用散落在渲染路径。',
      '//',
      '// 模块职责：渲染分组侧栏中的单个任务行，并提供空分组拖放区。',
      '// 状态所有权：无；任务数据与回调全部由上层注入。',
      '// 阅读顺序：先看空分组拖放区，再看任务行组件，最后看记忆化导出。',
    ],
    blocks: [
      {
        anchor: 'export function EmptyGroupDropZone({',
        lines: [
          '拖放标识带分组前缀。',
          '点击阻止冒泡。',
          '指针与触摸同样阻止。',
          '文案走国际化。',
        ],
      },
      {
        anchor: 'function GroupedTaskItemComponent({',
        lines: [
          '回调全部由外部注入。',
          '远程会话标识原样透传。',
          '组件只负责布局。',
        ],
      },
      {
        anchor: 'export const GroupedTaskItem = memo(GroupedTaskItemComponent);',
        lines: [
          '记忆化避免重复渲染。',
          '属性原样下传。',
          '导出保持稳定引用。',
        ],
      },
      {
        anchor: '  const { intl } = useZCodeIntl();',
        lines: [
          '文案统一走国际化。',
          '组件内不硬编码语言。',
          '缺失键由 provider 兜底。',
        ],
      },
      {
        anchor: '  const droppable = useDroppable({',
        lines: [
          '拖放区按分组注册。',
          '空分组也能接收拖入。',
          '节点引用交给 button。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/settings/useWorkspaceHookInlineTrust.ts',
    target: 38,
    header: [
      '// INV-01 远程目标必须注入服务：守住位置 hooksService 选择；改错故障 RPC 打到错误 host。',
      '// INV-02 rpcReady 为假禁用链路：守住位置 平台判断；改错故障 越界 RPC 发给断连代理。',
      '// INV-03 未就绪时不回退上下文服务：守住位置 三元；改错故障 信任链路打到激活 tab。',
      '// INV-04 服务缺失时功能不可用：守住位置 canUseHooksService；改错故障 按钮可用但调用崩溃。',
      '// INV-05 审核结束才刷新列表：守住位置 结算判断；改错故障 Trust 已落盘但行内仍显示旧态。',
      '// INV-06 前一次交互标识单独保存：守住位置 previous ref；改错故障 无法判断是否结算。',
      '// INV-07 刷新三元组同刻捕获：守住位置 target 常量；改错故障 等待期间切换工作区污染新作用域。',
      '// INV-08 缺少工作区路径不刷新：守住位置 早退条件；改错故障 用空路径刷新。',
      '// INV-09 信任失败不刷新：守住位置 accepted 判断；改错故障 失败也刷新造成假成功。',
      '// INV-10 过期拒绝不弹提示：守住位置 shouldSilenceStaleRejection；改错故障 用户看到无关报错。',
      '// INV-11 提示文案按原因码解析：守住位置 消息 id 解析；改错故障 提示千篇一律。',
      '// INV-12 成功后按发起目标刷新：守住位置 原子刷新；改错故障 刷新到已切换的作用域。',
      '// INV-13 刷新期间作用域切换由 store 丢弃：守住位置 守卫语义；改错故障 新工作区被旧刷新覆盖。',
      '// INV-14 信任中记录当前 hook：守住位置 trustingHookId；改错故障 行内无法显示加载态。',
      '// INV-15 结束必清加载态：守住位置 finally；改错故障 按钮永久转圈。',
      '// INV-16 异常记日志并提示用户：守住位置 catch；改错故障 失败无感知。',
      '// INV-17 回调依赖完整声明：守住位置 useCallback 依赖；改错故障 闭包读到旧 props。',
      '// INV-18 授权能力决定按钮可用：守住位置 trustActionAvailable；改错故障 无权限也显示信任按钮。',
      '//',
      '// 模块职责：为设置页工作区 hooks 提供行内信任动作、审核结算后刷新与状态回传。',
      '// 状态所有权：审核绑定归 review store；信任中标识由本 hook 本地持有。',
      '// 阅读顺序：先看服务解析与可用性，再看结算刷新，最后看信任动作。',
    ],
    blocks: [
      {
        anchor: 'export function useWorkspaceHookInlineTrust(input: {',
        lines: [
          '服务按目标工作区解析。',
          '未就绪时不回退上下文服务。',
          '审核结束才刷新列表。',
          '信任中记录当前 hook。',
        ],
      },
      {
        anchor: '  const hooksService =',
        lines: [
          '未就绪直接为空。',
          '显式注入优先。',
          '显式就绪才回退上下文。',
        ],
      },
      {
        anchor: '  useEffect(() => {',
        lines: [
          '只在结算时刷新。',
          '三元组同刻捕获。',
          '缺工作区路径不刷新。',
        ],
      },
      {
        anchor: '  const trustHook = useCallback(',
        lines: [
          '无服务直接返回。',
          '失败不刷新。',
          '结束必清加载态。',
        ],
      },
      {
        anchor: '        if (!result.accepted) {',
        lines: [
          '过期拒绝不提示。',
          '提示按原因码解析。',
          '失败不刷新列表。',
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
    `ZC-deep-b155-spec-${index}.json`,
    JSON.stringify({ files: [{ file: spec.file, items }] }, null, 2),
    'utf8',
  );
  console.log(`spec ${index}: ${spec.file} lines=${total}`);
  index += 1;
}
