import fs from 'node:fs';

const specs = [
  {
    file: 'packages/ui/src/WorkflowPermissionBlock.tsx',
    target: 48,
    header: [
      '// INV-01 保存来源徽标不表达信任：守住位置 徽标文案；改错故障 保存态被当已批准。',
      '// INV-02 徽标在时间线上方：守住位置 渲染顺序；改错故障 前置事实被图淹没。',
      '// INV-03 作用域缺省只显示徽标：守住位置 空值判断；改错故障 出现未定义文案。',
      '// INV-04 参数为空不画表：守住位置 长度判断；改错故障 出现空定义列表。',
      '// INV-05 入参读取复用同族规则：守住位置 读取函数；改错故障 卡片与弹窗解析不一致。',
      '// INV-06 修订按工具名判定：守住位置 工具名判断；改错故障 普通创建被当修订。',
      '// INV-07 留白补全单独标题：守住位置 三元标题；改错故障 补全窗显示创建文案。',
      '// INV-08 脚本沿用需说明：守住位置 继承标志；改错故障 用户以为脚本被改。',
      '// INV-09 前驱在线需提示：守住位置 存活判断；改错故障 用户不知会停掉运行中任务。',
      '// INV-10 并发上限不分工具名：守住位置 统一读取；改错故障 修订窗漏报上限。',
      '// INV-11 子代理模型只影响子代理：守住位置 文案；改错故障 用户以为主代理也换模型。',
      '// INV-12 可调项缺席即纯文本：守住位置 空值分支；改错故障 提供代理会丢掉的改动。',
      '// INV-13 模型清单需作用域：守住位置 作用域判断；改错故障 模型项永远可调却读不到。',
      '// INV-14 空图不画空轨道：守住位置 步数判断；改错故障 出现一条空时间线。',
      '// INV-15 留白时间线收窄：守住位置 收窄函数；改错故障 补全窗显示整图。',
      '// INV-16 换请求重置折叠：守住位置 副作用依赖；改错故障 上个脚本展开态泄漏。',
      '// INV-17 脚本默认折叠随图：守住位置 初始值；改错故障 有图时脚本抢占视线。',
      '// INV-18 脚本区限高滚动：守住位置 高度类；改错故障 长脚本撑高弹窗。',
      '//',
      '// 模块职责：工作流创建、修订与留白补全的运行确认块。',
      '// 状态所有权：入参来自权限请求，改过的设置交回权限弹窗。',
      '// 阅读顺序：先看来源徽标，再看主体入参解析，最后看时间线与脚本区。',
    ],
    blocks: [
      {
        anchor: 'function WorkflowSavedSourceBadge({ saved }: { saved: WorkflowSavedSource }) {',
        lines: [
          '只显示来源与作用域。',
          '未给作用域只显示徽标。',
          '路径可选。',
          '参数为空不画表。',
          '参数值统一格式化。',
          '徽标不表达信任。',
        ],
      },
      {
        anchor: 'export function WorkflowPermissionBlock({',
        lines: [
          '入参与聊天卡片共用读取规则。',
          '修订与补全按工具名区分。',
          '并发与模型是本窗要说的约束。',
          '可调项缺席退成纯文本。',
          '时间线只画非空图。',
          '脚本折叠态随请求重置。',
        ],
      },
      {
        anchor: 'const scriptText = readWorkflowScript(request.raw);',
        lines: [
          '从原始入参读脚本。',
          '名称与保存来源同源。',
          '修订继承标志单独读。',
          '并发上限不分工具名。',
          '子代理模型只读不推断。',
        ],
      },
      {
        anchor: 'const model = useMemo(() => {',
        lines: [
          '无因果图直接返回空。',
          '有留白时收窄时间线。',
          '收窄失败回退整图。',
          '标签只补留白名。',
          '按图与留白记忆。',
        ],
      },
      {
        anchor: 'useEffect(() => {',
        lines: [
          '换请求回到默认折叠。',
          '有图默认收起。',
          '无图默认展开。',
          '只依赖图与请求标识。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/browser-use/BrowserSitePermissionsPage.tsx',
    target: 41,
    header: [
      '// INV-01 仅本次不展示：守住位置 数据源；改错故障 临时授权被写入列表。',
      '// INV-02 不支持平台给说明：守住位置 支持判断；改错故障 空白页无解释。',
      '// INV-03 保存中禁用全部控件：守住位置 忙碌判断；改错故障 并发写入互相覆盖。',
      '// INV-04 缺状态时禁用重置：守住位置 空值判断；改错故障 未加载就允许重置。',
      '// INV-05 三态映射固定：守住位置 映射链；改错故障 未知值被当允许。',
      '// INV-06 能力清单驱动渲染：守住位置 常量遍历；改错故障 新增权限漏渲染。',
      '// INV-07 窄栏名称保宽：守住位置 最小宽；改错故障 下拉框挤成逐字断行。',
      '// INV-08 下拉触发器有可访问名：守住位置 标签属性；改错故障 读屏只念当前值。',
      '// INV-09 选项文案走国际化：守住位置 格式化；改错故障 出现硬编码枚举。',
      '// INV-10 保存成功给状态提示：守住位置 成功分支；改错故障 用户不知是否生效。',
      '// INV-11 重置成功区别于保存：守住位置 操作类型；改错故障 两种结果同一文案。',
      '// INV-12 写入失败给重试：守住位置 失败分支；改错故障 只能重开页面。',
      '// INV-13 读取失败给重试：守住位置 错误分支；改错故障 列表空白无出口。',
      '// INV-14 重试期间禁用：守住位置 忙碌条件；改错故障 连续点击重复写入。',
      '// INV-15 测试标识按能力编码：守住位置 编码调用；改错故障 特殊字符破坏选择器。',
      '// INV-16 标题展示完整来源：守住位置 断词规则；改错故障 长来源溢出。',
      '// INV-17 页面自身可滚动：守住位置 高度类；改错故障 内容被裁掉。',
      '// INV-18 文案前缀统一：守住位置 局部格式化器；改错故障 键名散落各处。',
      '//',
      '// 模块职责：浏览器站点权限设置标签页。',
      '// 状态所有权：权限状态与写入动作归专用钩子，本页只渲染。',
      '// 阅读顺序：先看钩子返回值，再看忙碌与提示，最后看渲染分支。',
    ],
    blocks: [
      {
        anchor: 'export function BrowserSitePermissionsPage({',
        lines: [
          '数据来自站点权限钩子。',
          '仅本次状态不展示。',
          '不支持时给说明。',
          '页面自身滚动。',
          '内容限宽居中。',
        ],
      },
      {
        anchor: 'const { states, error: readError, refresh, supported, write, setPermission, reset, retryWrite } =',
        lines: [
          '状态与错误分别返回。',
          '写入动作带重试。',
          '重置与单项写入分开。',
          '可见性决定是否读取。',
          '作用域限定当前来源。',
        ],
      },
      {
        anchor: 'const busy = write.status === "pending";',
        lines: [
          '写入在途即忙碌。',
          '忙碌禁用重置。',
          '忙碌禁用下拉。',
          '忙碌禁用重试。',
          '成功提示区分重置与保存。',
        ],
      },
      {
        anchor: 'const notice = write.status === "succeeded" ? (write.operation.kind === "reset" ? "resetDone" : "saved") : null;',
        lines: [
          '仅成功后有提示。',
          '重置成功单独文案。',
          '保存成功单独文案。',
          '失败走告警分支。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/ToolCallBlocks/renderers/offpeak-create.tsx',
    target: 41,
    header: [
      '// INV-01 工具名归一化：守住位置 去符号小写；改错故障 大小写差异漏判。',
      '// INV-02 三处名称都参与判定：守住位置 任一匹配；改错故障 旧事件缺字段漏判。',
      '// INV-03 非对象一律无效：守住位置 类型守卫；改错故障 数组被当任务。',
      '// INV-04 字符串先尝试解析：守住位置 首字符判断；改错故障 普通文本被解析。',
      '// INV-05 解析失败静默回退：守住位置 捕获分支；改错故障 卡片渲染抛错。',
      '// INV-06 缺任务标识即无效：守住位置 非空判断；改错故障 卡片无法定位任务。',
      '// INV-07 标题去空白后才采用：守住位置 修剪；改错故障 出现空白标题。',
      '// INV-08 位次需正有限数：守住位置 三条件；改错故障 出现零或小数位次。',
      '// INV-09 多候选按序探测：守住位置 遍历顺序；改错故障 旧字段遮蔽新字段。',
      '// INV-10 未命中原样返回空：守住位置 末尾返回；改错故障 调用方拿到半成品。',
      '// INV-11 嵌套任务优先：守住位置 类型判断；改错故障 外层字段覆盖内层。',
      '// INV-12 位次快照不订阅：守住位置 静态数据；改错故障 历史回看出现实时位次。',
      '// INV-13 缺位次回退文案：守住位置 空值分支；改错故障 第二行空白。',
      '// INV-14 标题缺省有回退：守住位置 空值合并；改错故障 卡片无标题。',
      '// INV-15 绑定提示固定追加：守住位置 拼接；改错故障 用户误以为任务独立运行。',
      '// INV-16 打开入口缺失即禁用：守住位置 布尔判断；改错故障 点击无反应。',
      '// INV-17 打开时带任务标识：守住位置 回调参数；改错故障 跳转到错误任务。',
      '// INV-18 卡片标识来自共享常量：守住位置 测试常量；改错故障 测试与实现漂移。',
      '//',
      '// 模块职责：闲时创建工具调用的轮尾卡片与输出摘要解析。',
      '// 状态所有权：摘要为创建时快照，不订阅后续任务状态。',
      '// 阅读顺序：先看工具名与类型守卫，再看摘要解析，最后看卡片渲染。',
    ],
    blocks: [
      {
        anchor: 'function normalizeToolName(value: unknown): string {',
        lines: [
          '非字符串返回空。',
          '统一转小写。',
          '去掉非字母数字。',
          '只用于工具名比较。',
          '不做其他归一。',
        ],
      },
      {
        anchor: 'export function readOffPeakCreateTaskOutputSummary(',
        lines: [
          '字符串先尝试解析。',
          '非对象直接判无效。',
          '缺任务标识返回空。',
          '标题与状态去空白。',
          '位次需正有限数。',
        ],
      },
      {
        anchor: 'export function readOffPeakCreateTaskSummary(',
        lines: [
          '原始入参需为对象。',
          '多候选按序探测。',
          '首个有效即返回。',
          '全部失败返回空。',
          '不读取实时状态。',
        ],
      },
      {
        anchor: 'export function describeOffPeakCardStatus(',
        lines: [
          '有位次说排在第几位。',
          '缺位次说已入队。',
          '位次需为正数。',
          '文案全部走国际化。',
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
  fs.writeFileSync(`ZC-deep-b133-spec-${index}.json`, JSON.stringify({ files: [{ file: spec.file, items }] }, null, 2), 'utf8');
  console.log(`spec ${index}: ${spec.file} lines=${total}`);
  index += 1;
}
