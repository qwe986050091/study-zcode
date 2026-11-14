import fs from 'node:fs';

const specs = [
  {
    file: 'packages/ui/src/components/ui/dialog.tsx',
    target: 41,
    header: [
      '// INV-01 关闭文案走国际化：守住位置 辅助组件；改错故障 硬编码英文。',
      '// INV-02 根组件透传属性：守住位置 展开语法；改错故障 受控状态失效。',
      '// INV-03 触发器与传送门独立导出：守住位置 组件拆分；改错故障 无法自定义挂载点。',
      '// INV-04 遮罩覆盖完整视口：守住位置 固定定位；改错故障 顶部残留亮条。',
      '// INV-05 遮罩不拦截自绘窗控：守住位置 说明注释；改错故障 标题栏按钮失效。',
      '// INV-06 内容默认带遮罩：守住位置 默认值；改错故障 调用方忘了传就没有背景。',
      '// INV-07 内容可关遮罩：守住位置 条件渲染；改错故障 无法做无遮罩弹层。',
      '// INV-08 内容落在无拖拽区：守住位置 应用区域属性；改错故障 关闭键被窗口拖拽吞掉。',
      '// INV-09 内容居中限宽：守住位置 定位类；改错故障 小屏溢出。',
      '// INV-10 关闭键可隐藏：守住位置 默认布尔；改错故障 纯信息弹窗多一个叉。',
      '// INV-11 关闭键语义名走国际化：守住位置 隐藏文本；改错故障 读屏只念图标。',
      '// INV-12 头部纵向排列：守住位置 布局类；改错故障 标题与描述挤行。',
      '// INV-13 底部小屏倒序：守住位置 响应式类；改错故障 主操作难触。',
      '// INV-14 底部关闭键默认不显示：守住位置 默认值；改错故障 每个弹窗多一个取消。',
      '// INV-15 标题与描述语义独立：守住位置 原语组件；改错故障 读屏无标题。',
      '// INV-16 描述保留下划线链接：守住位置 选择器；改错故障 链接不可辨。',
      '// INV-17 样式类名最后合并：守住位置 合并顺序；改错故障 外部覆盖失效。',
      '// INV-18 仅具名导出：守住位置 导出块；改错故障 引用路径不稳定。',
      '//',
      '// 模块职责：通用弹窗的无状态样式与语义包装。',
      '// 状态所有权：开关与焦点全部交给底层弹窗原语。',
      '// 阅读顺序：先看关闭文案，再看内容与遮罩，最后看头部与底部。',
    ],
    blocks: [
      {
        anchor: 'function DialogCloseText() {',
        lines: [
          '统一读取通用关闭文案。',
          '依赖国际化上下文。',
          '供隐藏文本与取消键复用。',
          '不接收参数。',
          '每次渲染重新取文案。',
        ],
      },
      {
        anchor: 'function DialogContent({',
        lines: [
          '默认渲染遮罩。',
          '可显式关闭遮罩。',
          '内容整体标记无拖拽。',
          '关闭键可隐藏。',
          '外部类名最后合并。',
        ],
      },
      {
        anchor: 'function DialogFooter({',
        lines: [
          '小屏纵向倒序。',
          '宽屏右对齐横排。',
          '可选追加关闭键。',
          '关闭键默认不显示。',
          '子节点原样透传。',
        ],
      },
      {
        anchor: 'function DialogTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {',
        lines: [
          '使用原语标题。',
          '保留插槽标识。',
          '字号与字重统一。',
          '类名可覆盖。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/app-shell/WorkflowRunSpineParts.tsx',
    target: 42,
    firstNth: 1,
    header: [
      '// INV-01 流轨墨色在箭头：守住位置 流轨判断；改错故障 缺口里出现两条亮线。',
      '// INV-02 轨道大于零才内联定位：守住位置 条件；改错故障 基线轨道位置偏移。',
      '// INV-03 流轨上下半让出缺口：守住位置 位置分支；改错故障 缺口被轨道填满。',
      '// INV-04 开口行主轨外伸：守住位置 外伸参数；改错故障 接头悬空断开。',
      '// INV-05 整节穿过用满高：守住位置 位置回退；改错故障 轨道在节内断开。',
      '// INV-06 一节竖轨一次画全：守住位置 映射；改错故障 分支轨漏画。',
      '// INV-07 流轨缺口放两枚箭头：守住位置 条件映射；改错故障 缺口无方向提示。',
      '// INV-08 箭头层级高于节头：守住位置 层级值；改错故障 悬停底纹压住箭头。',
      '// INV-09 无接头不画行：守住位置 空值早退；改错故障 出现空行。',
      '// INV-10 分叉汇合共用母线：守住位置 母线常量；改错故障 两端高度不一致。',
      '// INV-11 圆角半径受轨距限制：守住位置 取小值；改错故障 密集轨道转角重叠。',
      '// INV-12 光叠在底墨之上：守住位置 绘制顺序；改错故障 后画底墨盖住前一条光。',
      '// INV-13 渐变标识唯一：守住位置 实例标识；改错故障 多条路径共用渐变。',
      '// INV-14 接头整行装饰：守住位置 无障碍属性；改错故障 读屏重复播报。',
      '// INV-15 灯态映射集中：守住位置 状态类表；改错故障 运行灯与卡不一致。',
      '// INV-16 非零轨灯按轨距定位：守住位置 内联样式；改错故障 分支灯落到主线。',
      '// INV-17 头像串最多三枚：守住位置 上限常量；改错故障 节头被头像撑开。',
      '// INV-18 头像色按编号与名字：守住位置 取色函数；改错故障 同一代理两处颜色不同。',
      '//',
      '// 模块职责：侧栏脊线的纯展示件，不含展开状态与问题归属。',
      '// 状态所有权：全部输入来自脊线模型，组件只负责绘制。',
      '// 阅读顺序：先看轨道与接头，再看灯与头像串，最后看轮次与尾巴。',
    ],
    blocks: [
      {
        anchor: 'export function SpineRail({',
        lines: [
          '主轨位置由轨距算出。',
          '非零轨才写内联左偏移。',
          '流轨上下半让出缺口。',
          '开口轨向行外外伸。',
          '灯亮与否只影响宽度与色。',
        ],
      },
      {
        anchor: 'export function SpinePieces({ pitch, section }: { pitch: number; section: SpineSection }) {',
        lines: [
          '映射全部竖轨。',
          '流轨缺口再叠箭头。',
          '箭头层级高于节头。',
          '键含轨道与位置。',
          '不持有状态。',
        ],
      },
      {
        anchor: 'export function SpineJointRow({',
        lines: [
          '无接头直接不渲染。',
          '母线取接头半高。',
          '分叉从左向右展开。',
          '汇合按镜像生成。',
          '光叠在全部底墨之后。',
        ],
      },
      {
        anchor: 'export function AvatarCluster({',
        lines: [
          '空列表不渲染。',
          '最多显示三枚。',
          '其余折叠成计数。',
          '子代理瓦片按编号取色。',
          '工作区用终端字形。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/components/workflow-timeline/WorkflowTimelineTracks.tsx',
    target: 42,
    header: [
      '// INV-01 双线段不画：守住位置 跳过；改错故障 卡上出现重复轨道。',
      '// INV-02 无前驱长尾巴：守住位置 尾巴段；改错故障 首站轨道缺失。',
      '// INV-03 无汇合长残段：守住位置 残段；改错故障 末站轨道悬空。',
      '// INV-04 分支离开主线有固定偏移：守住位置 偏移公式；改错故障 分叉点重叠。',
      '// INV-05 分支先升后横：守住位置 路径顺序；改错故障 曲线穿过灯。',
      '// INV-06 汇合是分叉镜像：守住位置 镜像公式；改错故障 汇合落点错位。',
      '// INV-07 跨带普通段走主线：守住位置 带不同判断；改错故障 相邻带之间断线。',
      '// INV-08 缺带时跳过：守住位置 空值判断；改错故障 越界访问。',
      '// INV-09 流轨中间断开：守住位置 缺口常量；改错故障 箭头与线重叠。',
      '// INV-10 首尾点与路径同源：守住位置 返回结构；改错故障 渐变方向错。',
      '// INV-11 段键包含两端：守住位置 键拼接；改错故障 并行边键冲突。',
      '// INV-12 墨色三档映射：守住位置 常量表；改错故障 行进边颜色错误。',
      '// INV-13 渐变标识清洗：守住位置 替换非法字符；改错故障 标识含冒号失效。',
      '// INV-14 折叠站引线同淡出：守住位置 类名条件；改错故障 引线残留。',
      '// INV-15 分支引线点状：守住位置 描边样式；改错故障 引线与主线混淆。',
      '// INV-16 灯仍为 DOM：守住位置 组件选择；改错故障 状态类无法生效。',
      '// INV-17 灯按轨道行定位：守住位置 取行回退；改错故障 灯落到零轨。',
      '// INV-18 补全滑入复用样式：守住位置 工具函数；改错故障 插入列后灯不跟随。',
      '//',
      '// 模块职责：时间线带视图的轨道层与灯层绘制。',
      '// 状态所有权：几何来自布局对象，折叠态由上层传入。',
      '// 阅读顺序：先看轨道段纯函数，再看分支路径，最后看两个渲染组件。',
    ],
    blocks: [
      {
        anchor: 'export function timelineRailPieces(',
        lines: [
          '双线段先跳过。',
          '无前驱补尾巴。',
          '无汇合补残段。',
          '跨带段走主线。',
          '键包含两端站号。',
        ],
      },
      {
        anchor: 'const forkPath = (band: TimelineBand, track: number, head: number): RailShape => {',
        lines: [
          '起点在主线上。',
          '先升到分支行。',
          '再横到灯前。',
          '半径固定八像素。',
          '返回路径与首尾点。',
        ],
      },
      {
        anchor: 'export function WorkflowTimelineTracks({',
        lines: [
          '先算全部轨道段。',
          '渐变标识按实例唯一。',
          '底墨与光分层绘制。',
          '流轨不叠光。',
          '分支站补点状引线。',
        ],
      },
      {
        anchor: 'export function WorkflowTimelineLamps({',
        lines: [
          '灯仍是 DOM 元素。',
          '状态类来自共用映射。',
          '折叠站随引线淡出。',
          '补全时按索引滑入。',
          '位置按轨道行计算。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/hooks/useGitAutoRefresh.ts',
    target: 40,
    header: [
      '// INV-01 刷新延迟一分钟：守住位置 常量；改错故障 批量写文件触发风暴。',
      '// INV-02 延迟内重复事件合并：守住位置 清理旧定时器；改错故障 多次刷新。',
      '// INV-03 回调走引用：守住位置 引用赋值；改错故障 旧闭包读到过期工作区。',
      '// INV-04 工作区键优先身份：守住位置 空值回退；改错故障 同路径不同身份串台。',
      '// INV-05 不可监听时清空路径：守住位置 条件构造；改错故障 仍在旧工作区监听。',
      '// INV-06 路径签名按内容比较：守住位置 序列化；改错故障 引用变化重建监听。',
      '// INV-07 签名依赖显式列出：守住位置 依赖数组；改错故障 摘要更新不重算。',
      '// INV-08 平台信息按服务身份归属：守住位置 服务相等判断；改错故障 旧平台泄漏。',
      '// INV-09 平台读取失败静默：守住位置 捕获；改错故障 弹错误提示。',
      '// INV-10 仅仓库可用才监听：守住位置 三条件；改错故障 非仓库也建监听。',
      '// INV-11 注册前判取消：守住位置 取消标志；改错故障 卸载后仍注册。',
      '// INV-12 取消时立即退订：守住位置 分支；改错故障 监听泄漏。',
      '// INV-13 监听失败只告警：守住位置 捕获分支；改错故障 自动刷新拖垮手动链路。',
      '// INV-14 清理先停定时器：守住位置 顺序；改错故障 卸载后仍刷新。',
      '// INV-15 清理逐个退订：守住位置 遍历；改错故障 残留订阅。',
      '// INV-16 退订失败告警：守住位置 捕获；改错故障 静默泄漏。',
      '// INV-17 事件路径只用于日志：守住位置 参数；改错故障 误按文件过滤。',
      '// INV-18 钩子无返回值：守住位置 签名；改错故障 调用方误以为可控。',
      '//',
      '// 模块职责：监听 Git 工作区变化并延迟触发状态刷新。',
      '// 状态所有权：Git 摘要归上层，本钩子只持监听注册与定时器。',
      '// 阅读顺序：先看监听路径构造，再看刷新调度，最后看清理。',
    ],
    blocks: [
      {
        anchor: 'export function useGitAutoRefresh({',
        lines: [
          '工作区服务支持远程。',
          '刷新回调存引用。',
          '工作区键优先用身份。',
          '仅满足条件才监听。',
          '钩子不返回值。',
        ],
      },
      {
        anchor: 'const watchPathSignature = useMemo(',
        lines: [
          '不可监听时序列化空列表。',
          '平台未知时用保守策略。',
          '依赖逐个列出。',
          '内容不变签名不变。',
          '避免重建监听。',
        ],
      },
      {
        anchor: 'const scheduleRefresh = (path: string) => {',
        lines: [
          '先清旧定时器。',
          '新定时器统一延迟。',
          '到点先清引用。',
          '记日志后调回调。',
        ],
      },
      {
        anchor: 'const watchPaths = useMemo(',
        lines: [
          '从签名解析路径。',
          '记忆化避免重建。',
          '签名变化才重算。',
          '结果供监听使用。',
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
  fs.writeFileSync(`ZC-deep-b136-spec-${index}.json`, JSON.stringify({ files: [{ file: spec.file, items }] }, null, 2), 'utf8');
  console.log(`spec ${index}: ${spec.file} lines=${total}`);
  index += 1;
}
