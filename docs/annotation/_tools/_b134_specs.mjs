import fs from 'node:fs';

const specs = [
  {
    file: 'packages/ui/src/app-shell/sidePaneTabPresentation.ts',
    target: 40,
    header: [
      '// INV-01 搜索面覆盖类型标识：守住位置 分支；改错故障 搜索找不到工作流标签。',
      '// INV-02 会话标识进搜索面：守住位置 演员分支；改错故障 只有会话标识时搜不到。',
      '// INV-03 产物标识进搜索面：守住位置 产物分支；改错故障 按产物标识搜不到。',
      '// INV-04 缺省回退来源路径：守住位置 末尾；改错故障 返回空串。',
      '// INV-05 标题映射缺省用标识：守住位置 空值回退；改错故障 标题空白。',
      '// INV-06 文件管理回退代码查看：守住位置 双字段回退；改错故障 文件标签无标题。',
      '// INV-07 新标签有本地化缺省：守住位置 空值合并；改错故障 显示原始键名。',
      '// INV-08 类型标签覆盖全部种类：守住位置 末尾回退；改错故障 返回未定义。',
      '// INV-09 子代理类型去空白：守住位置 修剪判断；改错故障 标签为空白。',
      '// INV-10 浏览器两类同标题：守住位置 合并判断；改错故障 两处标题不一致。',
      '// INV-11 终端与后台输出同标题：守住位置 合并判断；改错故障 两处标题不一致。',
      '// INV-12 git 复用评审标题：守住位置 映射；改错故障 出现第二套文案。',
      '// INV-13 搜索词包含工具名：守住位置 拼接；改错故障 按工具名检索失败。',
      '// INV-14 搜索词不依赖渲染：守住位置 纯函数；改错故障 折叠时才可搜。',
      '// INV-15 标题本地化交给上层：守住位置 标签入参；改错故障 组件内硬编码语言。',
      '// INV-16 标签接口属性可选：守住位置 可选声明；改错故障 调用方被迫补全所有文案。',
      '// INV-17 映射表不缓存外部状态：守住位置 每次构造；改错故障 语言切换后标题不变。',
      '// INV-18 不改变标签类型：守住位置 返回字符串；改错故障 调用方拿到对象。',
      '//',
      '// 模块职责：侧边栏标签的搜索词、本地化标题与类型标签。',
      '// 状态所有权：文案由调用方注入，本模块只做映射与回退。',
      '// 阅读顺序：先看搜索词，再看标题映射，最后看类型标签。',
    ],
    blocks: [
      {
        anchor: 'export function getSidePaneTabSearchHint(tab: WorkspaceSidePaneTab): string {',
        lines: [
          '每种标签拼可检索词。',
          '工作流三类包含工具名。',
          '产物包含产物标识。',
          '缺省回退到来源路径。',
          '纯函数不读外部状态。',
        ],
      },
      {
        anchor: 'export function getLocalizedSidePaneTabTitle(',
        lines: [
          '标题委托统一入口。',
          '描述符标识查本地化表。',
          '缺失回落描述符标识。',
          '文件管理复用代码查看标题。',
          '文案由调用方注入。',
        ],
      },
      {
        anchor: 'const titleByMessageId: Record<string, string> = {',
        lines: [
          '键名与描述符一一对应。',
          '可选标题按需回退。',
          '不在表内的键原样返回。',
          '每次调用重新构造。',
        ],
      },
      {
        anchor: 'export function getSidePaneTabTypeLabel(',
        lines: [
          '子代理类型优先。',
          '浏览器两型合并。',
          '终端两型合并。',
          '末尾回退代码查看标题。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/app-shell/BackgroundBashOutputSidePane.tsx',
    target: 40,
    header: [
      '// INV-01 仅可见时自动贴底：守住位置 布局副作用；改错故障 后台页抢滚动。',
      '// INV-02 跟随态才滚到底：守住位置 条件；改错故障 用户上翻被强行拉回。',
      '// INV-03 记录上次滚动位置：守住位置 引用；改错故障 无法判断上翻。',
      '// INV-04 上翻即暂停跟随：守住位置 比较；改错故障 新输出持续抢滚动。',
      '// INV-05 回到底部恢复跟随：守住位置 距离判断；改错故障 悬浮箭头常驻。',
      '// INV-06 底部阈值留余量：守住位置 八像素；改错故障 差一像素不恢复。',
      '// INV-07 手动滚到底也恢复：守住位置 暂停分支；改错故障 到底后仍暂停。',
      '// INV-08 不可见不处理滚动：守住位置 早退；改错故障 隐藏页写入跟随状态。',
      '// INV-09 错误优先展示：守住位置 错误分支；改错故障 错误被状态栏淹没。',
      '// INV-10 错误可重试：守住位置 刷新回调；改错故障 只能重开面板。',
      '// INV-11 运行中显示旋转图标：守住位置 状态判断；改错故障 无进行中反馈。',
      '// INV-12 完整文件入口带回工作区：守住位置 参数展开；改错故障 打开到错误工作区。',
      '// INV-13 文件名取末段：守住位置 分隔符切分；改错故障 标题显示整条路径。',
      '// INV-14 空输出给空态文案：守住位置 双条件；改错故障 空白区域。',
      '// INV-15 输出保留换行：守住位置 空白规则；改错故障 命令行挤成一段。',
      '// INV-16 悬浮箭头有可访问名：守住位置 标签属性；改错故障 读屏只念图标。',
      '// INV-17 状态与跟随写入数据属性：守住位置 数据属性；改错故障 测试无法断言。',
      '// INV-18 组件记忆化：守住位置 外层包装；改错故障 父级渲染带动整块重排。',
      '//',
      '// 模块职责：后台 bash 输出的侧栏面板与跟随滚动。',
      '// 状态所有权：输出与跟随态归专用钩子，组件只管视口。',
      '// 阅读顺序：先看布局副作用，再看滚动处理，最后看渲染分支。',
    ],
    blocks: [
      {
        anchor: 'export const BackgroundBashOutputSidePane = memo(function BackgroundBashOutputSidePane({',
        lines: [
          '输出由专用钩子读取。',
          '仅可见时建立订阅。',
          '状态与跟随写入数据属性。',
          '记忆化隔离父级渲染。',
          '面板本身不改数据。',
        ],
      },
      {
        anchor: 'useLayoutEffect(() => {',
        lines: [
          '不可见直接跳过。',
          '未跟随时不贴底。',
          '跟随则滚到末尾。',
          '记录滚动位置供比较。',
          '输出变化才重跑。',
        ],
      },
      {
        anchor: 'onScroll={(event) => {',
        lines: [
          '上翻且不在底部即暂停。',
          '到底且未跟随即恢复。',
          '更新上次滚动位置。',
          '不可见不处理。',
        ],
      },
      {
        anchor: 'const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 8;',
        lines: [
          '距底八像素内算到底。',
          '阈值留出渲染误差。',
          '到底才允许恢复。',
          '只读当前元素尺寸。',
        ],
      },
    ],
  },
  {
    file: 'packages/web/src/web-remote-control/ui/webRemoteControlConnectingScreen.tsx',
    target: 41,
    header: [
      '// INV-01 阶段映射穷举：守住位置 分支；改错故障 未知状态显示空白。',
      '// INV-02 非线性状态单独说明：守住位置 重连与后台分支；改错故障 用户不知会自恢复。',
      '// INV-03 缺省回退准备中：守住位置 末尾；改错故障 显示原始枚举。',
      '// INV-04 进度只高亮线性阶段：守住位置 阶段表；改错故障 重连时进度条乱跳。',
      '// INV-05 进度段数固定四段：守住位置 文案数组；改错故障 步骤与进度不一致。',
      '// INV-06 设备名优先连接参数：守住位置 空值回退；改错故障 显示通用文案。',
      '// INV-07 设备平台来自记录：守住位置 属性透传；改错故障 图标缺失。',
      '// INV-08 文案按语言整包切换：守住位置 查表；改错故障 中英混排。',
      '// INV-09 状态区宣告忙碌：守住位置 无障碍属性；改错故障 读屏不提示加载。',
      '// INV-10 阶段文案实时播报：守住位置 礼貌播报；改错故障 状态变化无提示。',
      '// INV-11 步骤列表有可访问名：守住位置 标签拼接；改错故障 读屏只念步骤。',
      '// INV-12 当前步骤标记语义：守住位置 当前属性；改错故障 无法定位当前步。',
      '// INV-13 已完成与待办样式区分：守住位置 类名三元；改错故障 全部同色。',
      '// INV-14 当前步骤脉冲：守住位置 条件类名；改错故障 无进行中视觉。',
      '// INV-15 步骤文本仅供读屏：守住位置 隐藏类；改错故障 布局被文字撑开。',
      '// INV-16 全屏高度适配安全区：守住位置 动态高度；改错故障 刘海遮挡品牌。',
      '// INV-17 只呈现传输状态：守住位置 纯展示；改错故障 页面内改阶段逻辑。',
      '// INV-18 描述可选才渲染：守住位置 条件渲染；改错故障 出现空段落。',
      '//',
      '// 模块职责：远程控制连接过程的全屏进度页。',
      '// 状态所有权：传输状态由上层传入，本页只做展示映射。',
      '// 阅读顺序：先看语言文案表，再看阶段解析，最后看页面装配。',
    ],
    blocks: [
      {
        anchor: 'function resolveStage(',
        lines: [
          '线性阶段直接取文案。',
          '重连附自动恢复说明。',
          '后台附回前台说明。',
          '其余回退准备中。',
          '不改变传输状态。',
        ],
      },
      {
        anchor: 'export function WebRemoteControlLoadingScreen({',
        lines: [
          '文案整包按语言选择。',
          '阶段由传输状态解析。',
          '进度段来自阶段表。',
          '设备名去空白后回退。',
          '只呈现不改变状态。',
        ],
      },
      {
        anchor: 'const copy = copyByLocale[locale];',
        lines: [
          '中英各一份。',
          '步骤固定四段。',
          '阶段键与状态对齐。',
          '描述仅非线性阶段有。',
          '语言入参决定整包。',
        ],
      },
      {
        anchor: 'const STEP_INDEX: Partial<Record<WebRemoteControlTerminalTransportState, number>> = {',
        lines: [
          '线性阶段映射到四段。',
          '重连与后台不映射。',
          '缺映射即不高亮。',
          '键与传输状态同名。',
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
  const total = spec.header.length + spec.blocks.reduce((n, b) => n + b.lines.length, 0);
  if (total !== spec.target) {
    console.error(`TARGET MISMATCH ${spec.file}: ${total} != ${spec.target}`);
    process.exit(1);
  }
  fs.writeFileSync(`ZC-deep-b134-spec-${index}.json`, JSON.stringify({ files: [{ file: spec.file, items }] }, null, 2), 'utf8');
  console.log(`spec ${index}: ${spec.file} lines=${total}`);
  index += 1;
}
