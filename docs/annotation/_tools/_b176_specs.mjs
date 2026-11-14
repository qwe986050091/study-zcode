import fs from 'node:fs';

const specs = [
  {
    file: 'packages/ui/src/ModelTrajectorySearchHighlight.ts',
    target: 35,
    header: [
      '// INV-01 高亮接口按能力探测：守住位置 支持函数；改错故障 旧浏览器直接抛错。',
      '// INV-02 样式只注入一次：守住位置 标识判断；改错故障 重复插入样式节点。',
      '// INV-03 主题变量带兜底色：守住位置 样式声明；改错故障 深色主题下高亮不可见。',
      '// INV-04 全部命中与当前命中分开注册：守住位置 两个名称；改错故障 当前项与其余同色。',
      '// INV-05 空命中仍清空注册表：守住位置 空数组构造；改错故障 上一次高亮残留。',
      '// INV-06 清理只删自己的名称：守住位置 删除调用；改错故障 清掉其他功能的高亮。',
      '// INV-07 目标按展开键定位：守住位置 数据属性比较；改错故障 命中落到别的消息。',
      '// INV-08 字段按名称筛选：守住位置 属性选择器；改错故障 在错误字段里找匹配。',
      '// INV-09 首选展开态字段：守住位置 展开判断；改错故障 当前命中停在折叠摘要上。',
      '// INV-10 展开字段为空时退回全部：守住位置 长度判断；改错故障 展开后命中消失。',
      '// INV-11 索引越界退回首段：守住位置 空值兜底链；改错故障 命中没有高亮。',
      '// INV-12 文本节点遍历用树遍历器：守住位置 遍历器创建；改错故障 标签结构被打断。',
      '// INV-13 区间偏移取原文位置：守住位置 起止设置；改错故障 高亮错位。',
      '// INV-14 目标挂载判断看展开键：守住位置 存在性检查；改错故障 滚动到尚未渲染的命中。',
      '// INV-15 已可见不滚动：守住位置 边界比较；改错故障 每次查找页面都跳动。',
      '// INV-16 滚动量为中心差值：守住位置 计算表达式；改错故障 命中停在容器边缘。',
      '// INV-17 滚动不调用全局定位：守住位置 直接改滚动位置；改错故障 祖先链整体位移。',
      '// INV-18 无窗口环境安全返回：守住位置 全局检查；改错故障 服务端渲染报错。',
      '//',
      '// 模块职责：把轨迹搜索命中映射为浏览器高亮并滚动到可见位置。',
      '// 状态所有权：高亮注册表属于文档全局，本模块只按固定名称增删。',
      '// 阅读顺序：先看常量与样式，再看应用与清理，最后看区间收集与能力探测。',
    ],
    blocks: [
      {
        anchor: 'const HIGHLIGHT_NAME = "zcode-model-trajectory-find";',
        lines: [
          '两个高亮名分别表示全部命中与当前命中。',
          '样式表按固定标识只注入一次。',
          '颜色走主题变量并留兜底值。',
          '名称常量不对外暴露。',
        ],
      },
      {
        anchor: 'export function applyTrajectorySearchHighlights({',
        lines: [
          '不支持高亮接口时直接放弃。',
          '样式在使用前确保存在。',
          '当前命中单独注册以便区分深浅。',
        ],
      },
      {
        anchor: 'export function scrollTrajectorySearchRangeIntoView(',
        lines: [
          '已完全可见时不滚动。',
          '直接修正容器滚动位置，避免祖先链抖动。',
          '返回是否发生了滚动。',
        ],
      },
      {
        anchor: 'function collectRanges(element: HTMLElement, normalizedQuery: string): Range[] {',
        lines: [
          '只在当前字段内遍历文本节点。',
          '按归一化查询切出区间。',
          '区间偏移使用原文位置。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/store/mcpStoreMigration.ts',
    target: 35,
    header: [
      '// INV-01 只认 zcode agent 用户级来源：守住位置 三条件判断；改错故障 把别的来源当成已迁移。',
      '// INV-02 位置缺省时按自家来源处理：守住位置 可选链判断；改错故障 旧记录被漏掉。',
      '// INV-03 空输入直接完成：守住位置 计数早退；改错故障 空迁移被报告为失败。',
      '// INV-04 已存在同名则跳过：守住位置 名称集合；改错故障 覆盖用户现有配置。',
      '// INV-05 逐个写入互不影响：守住位置 循环内捕获；改错故障 一个失败丢掉已迁移结果。',
      '// INV-06 写入失败即停止并报告：守住位置 返回完成标记；改错故障 继续写入造成半迁移。',
      '// INV-07 停写时保留已完成计数：守住位置 返回字段；改错故障 调用方重复迁移已写条目。',
      '// INV-08 成功后才登记名称：守住位置 集合写入时机；改错故障 同名条目被写两次。',
      '// INV-09 变更标记由导入数推导：守住位置 布尔表达式；改错故障 无变更也触发重读。',
      '// INV-10 无旧数据直接返回原表：守住位置 空对象判断；改错故障 每次启动都走迁移。',
      '// INV-11 迁移原因写入来源路径：守住位置 常量参数；改错故障 日志无法定位数据来源。',
      '// INV-12 仅完成才清理旧数据：守住位置 完成判断；改错故障 无桌面桥接时丢配置。',
      '// INV-13 未变更不重新拉取：守住位置 变更判断；改错故障 启动多一次服务调用。',
      '// INV-14 有变更才记信息日志：守住位置 日志位置；改错故障 日志噪音掩盖真实迁移。',
      '// INV-15 迁移后重新读取权威列表：守住位置 返回调用；改错故障 界面显示旧列表。',
      '// INV-16 工作区路径原样透传：守住位置 查询参数；改错故障 迁移结果只含全局服务器。',
      '// INV-17 失败不抛出到调用方：守住位置 捕获分支；改错故障 迁移异常阻断启动。',
      '// INV-18 结果对象字段齐全：守住位置 两个返回分支；改错故障 调用方读到未定义计数。',
      '//',
      '// 模块职责：把旧版存在本地存储的通用 MCP 配置迁移到 zcode agent 用户目录。',
      '// 状态所有权：旧数据真值在浏览器存储，新数据真值在用户目录，本模块只做一次性搬运。',
      '// 阅读顺序：先看来源判定，再看逐个导入与失败分支，最后看迁移入口的清理与重读。',
    ],
    blocks: [
      {
        anchor: 'function isZCodeAgentUserServer(server: NativeMcpServerRecord): boolean {',
        lines: [
          '来源必须是自家 agent 配置。',
          '作用域必须是用户级。',
          '位置缺省视为自家来源。',
          '三个条件同时成立才算命中。',
        ],
      },
      {
        anchor: 'export async function importLegacyCommonServersToZCodeAgent(',
        lines: [
          '空输入视为已完成，没有变更。',
          '只有自家用户级条目参与同名判断。',
          '跳过计数用于向调用方解释结果。',
        ],
      },
      {
        anchor: 'export async function migrateStoredCommonMcpToZCodeAgent(',
        lines: [
          '没有旧数据就原表返回。',
          '迁移成功后才清理旧存储。',
          '有变更再重新读取权威列表。',
        ],
      },
      {
        anchor: 'for (const [name, config] of entries) {',
        lines: [
          '同名条目直接跳过并计数。',
          '写入失败保留已完成的部分。',
          '成功写入后才登记名称。',
        ],
      },
    ],
  },
  {
    file: 'packages/shared/src/browser-use/command-metadata.ts',
    target: 35,
    header: [
      '// INV-01 尺寸边界是单一事实源：守住位置 常量对象；改错故障 画布与接口各写一套上下限。',
      '// INV-02 代理视口与人类偏好分离：守住位置 两套常量；改错故障 代理打开页面继承用户缩放。',
      '// INV-03 基础尺寸只要求正数：守住位置 整数正判断；改错故障 零宽视口进入渲染。',
      '// INV-04 输入尺寸再夹边界：守住位置 扩展 schema；改错故障 超大视口撑爆窗口。',
      '// INV-05 缩放档位固定枚举：守住位置 常量数组；改错故障 前端传入任意比例。',
      '// INV-06 默认缩放为适应：守住位置 默认值；改错故障 首开缩放比例不符合预期。',
      '// INV-07 人类偏好不含运行态：守住位置 类型注释；改错故障 代理运行态写入用户偏好。',
      '// INV-08 偏好结构严格校验：守住位置 严格模式；改错故障 多余字段被静默持久化。',
      '// INV-09 默认偏好给手机尺寸：守住位置 默认对象；改错故障 首开桌面尺寸与布局不符。',
      '// INV-10 命令方法集集中枚举：守住位置 判别字段；改错故障 新命令在两端名称不一致。',
      '// INV-11 方法名即协议契约：守住位置 枚举值；改错故障 客户端与服务端分叉。',
      '// INV-12 客户端模式决定重放边界：守住位置 模式枚举；改错故障 手机端执行不可重放命令。',
      '// INV-13 会话上下文必填：守住位置 最小长度；改错故障 空标识跨会话串扰。',
      '// INV-14 工作区键可回落路径：守住位置 字段注释；改错故障 远端工作区互相隔离失败。',
      '// INV-15 受控标签缺省合法：守住位置 可选字段；改错故障 未指定标签时直接报错。',
      '// INV-16 错误码不静默兜底：守住位置 固定枚举；改错故障 失败原因被压成通用错误。',
      '// INV-17 页面状态字段最小：守住位置 接口定义；改错故障 把内部调试字段暴露给模型。',
      '// INV-18 可选滚动与视口字段：守住位置 可选标记；改错故障 老版本回传缺字段时校验失败。',
      '//',
      '// 模块职责：browser-use 命令与页面状态的共享 schema 与常量。',
      '// 状态所有权：无状态；只有常量与校验器，不持有运行时数据。',
      '// 阅读顺序：先看视口边界与缩放，再看人类偏好，最后看命令方法与错误码。',
    ],
    blocks: [
      {
        anchor: 'export const BROWSER_VIEWPORT_LIMITS = {',
        lines: [
          '宽度与高度的上下限成对出现。',
          '数值按 CSS 像素计。',
          '常量冻结，避免被调用方改写。',
          '画布与接口共用这一组边界。',
        ],
      },
      {
        anchor: 'export const browserViewportInputSchema = browserViewportSizeSchema.extend({',
        lines: [
          '在基础尺寸上追加范围约束。',
          '整数与正数继承自基础 schema。',
          '只校验入参，不约束自然视口。',
        ],
      },
      {
        anchor: 'export const embeddedBrowserViewportPreferenceSchema = z',
        lines: [
          '只描述人类主动打开的标签。',
          '模式决定是否按响应式展示。',
          '结构严格，拒绝多余字段。',
        ],
      },
      {
        anchor: 'export const browserCommandMethodSchema = z.enum([',
        lines: [
          '方法名作为判别字段值。',
          '两端共享同一份枚举。',
          '新增命令必须同时更新这里。',
        ],
      },
    ],
  },
  {
    file: 'packages/rpc/src/network-telemetry-middleware.ts',
    target: 34,
    firstNth: 1,
    header: [
      '// INV-01 遥测出口是单一回调：守住位置 模块级引用；改错故障 各处自行上报造成双计。',
      '// INV-02 未安装回调时静默：守住位置 可选调用；改错故障 无上报环境抛错。',
      '// INV-03 观察对象只承载事实：守住位置 接口字段；改错故障 上报携带业务数据。',
      '// INV-04 耗时归一到非负整数：守住位置 取整与下界；改错故障 时钟回拨产生负耗时。',
      '// INV-05 接口名由频道与命令拼接：守住位置 字符串模板；改错故障 无人能定位慢接口。',
      '// INV-06 成功不填错误类型：守住位置 三元表达式；改错故障 成功记录带旧错误。',
      '// INV-07 错误分类按关键字降级：守住位置 消息小写比较；改错故障 分类遗漏时抛错。',
      '// INV-08 没有匹配归为其他：守住位置 兜底返回；改错故障 未知错误被丢弃。',
      '// INV-09 服务端装饰只包调用：守住位置 转发方法；改错故障 监听事件被重复注册。',
      '// INV-10 成功与失败都上报：守住位置 两个分支；改错故障 失败调用没有耗时数据。',
      '// INV-11 异常原样再抛：守住位置 捕获后重抛；改错故障 遥测把错误吞掉。',
      '// INV-12 客户端装饰可选：守住位置 类注释；改错故障 两端同时包装导致双计。',
      '// INV-13 频道按名称逐层包装：守住位置 注册参数；改错故障 遥测丢失频道名。',
      '// INV-14 就绪转发保持幂等：守住位置 可选调用；改错故障 重复就绪抛错。',
      '// INV-15 包装不改变调用签名：守住位置 泛型透传；改错故障 返回值类型收窄。',
      '// INV-16 通道获取不缓存：守住位置 每次查询；改错故障 旧通道绕过遥测。',
      '// INV-17 错误分类不读取堆栈：守住位置 仅用消息；改错故障 上报泄露路径信息。',
      '// INV-18 传输种类固定枚举：守住位置 类型别名；改错故障 上报端收到未知传输。',
      '//',
      '// 模块职责：为 RPC 调用装饰服务端与客户端通道，产出按接口聚合的网络遥测。',
      '// 状态所有权：上报回调是模块级单例，由宿主在启动时安装或清空。',
      '// 阅读顺序：先看观察结构与上报入口，再看错误分类，最后看两个装饰器。',
    ],
    blocks: [
      {
        anchor: 'export interface NetworkObservation {',
        lines: [
          '观察只描述一次调用的结果。',
          '分阶段耗时全部可选。',
          '传输种类用于区分上报来源。',
        ],
      },
      {
        anchor: 'function classifyErrorKind(error: unknown): string {',
        lines: [
          '消息统一小写后再匹配。',
          '超时优先于连接类判断。',
          '未命中归入其他。',
        ],
      },
      {
        anchor: 'class NetworkTelemetryServerChannel<TContext> implements IServerChannel<TContext> {',
        lines: [
          '内层调用成功才记成功。',
          '失败先上报再原样抛出。',
          '监听事件直接转发不包装。',
        ],
      },
      {
        anchor: 'export class NetworkTelemetryChannelServer<TContext = string> implements IChannelServer<TContext> {',
        lines: [
          '注册时按频道名逐层包装。',
          '就绪状态直接转发。',
          '包装对调用方透明。',
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
    `ZC-deep-b176-spec-${index}.json`,
    JSON.stringify({ files: [{ file: spec.file, items }] }, null, 2),
    'utf8',
  );
  console.log(`spec ${index}: ${spec.file} lines=${total}`);
  index += 1;
}
