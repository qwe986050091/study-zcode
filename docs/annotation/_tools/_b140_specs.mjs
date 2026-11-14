import fs from 'node:fs';

const specs = [
  {
    file: 'packages/ui/src/hooks/useWebElementPicker.ts',
    target: 41,
    header: [
      '// INV-01 每次选择有独立运行号：守住位置 启动与取消；改错故障 迟到结果覆盖新一轮。',
      '// INV-02 运行号不匹配直接丢弃：守住位置 回包判断；改错故障 旧选择被加入新会话。',
      '// INV-03 executeJs 走 ref 固定：守住位置 依赖数组；改错故障 每次渲染重建回调。',
      '// INV-04 回包先验形状：守住位置 类型守卫；改错故障 任意对象被当成选择结果。',
      '// INV-05 上下文再验一次：守住位置 载荷构造；改错故障 缺字段载荷进入聊天队列。',
      '// INV-06 取消要先递增运行号：守住位置 取消函数首行；改错故障 在途结果仍然生效。',
      '// INV-07 取消失败只记调试：守住位置 捕获分支；改错故障 取消失败阻断状态复位。',
      '// INV-08 只能以 origin 与路径记日志：守住位置 URL 清洗；改错故障 查询串中的敏感值进日志。',
      '// INV-09 非法 URL 回退截断：守住位置 兜底分支；改错故障 清洗函数自身抛错。',
      '// INV-10 Esc 有双通道：守住位置 窗口监听；改错故障 焦点在外层时无法取消。',
      '// INV-11 仅在选择中挂监听：守住位置 早退分支；改错故障 空闲时吞掉 Escape。',
      '// INV-12 捕获阶段监听：守住位置 addEventListener；改错故障 内层组件先消费按键。',
      '// INV-13 卸载时取消：守住位置 清理副作用；改错故障 页面切换后选择态残留。',
      '// INV-14 成功只发事件：守住位置 分发调用；改错故障 直接写聊天状态导致双写。',
      '// INV-15 失败向上抛：守住位置 捕获末尾；改错故障 调用方无从感知错误。',
      '// INV-16 结束态按运行号复位：守住位置 finally；改错故障 新一轮被旧轮复位成空闲。',
      '// INV-17 标签可局部覆盖：守住位置 脚本构造；改错故障 调用方必须传全量文案。',
      '// INV-18 返回值形状稳定：守住位置 末尾对象；改错故障 调用方解构时缺字段。',
      '//',
      '// 模块职责：封装网页元素选择的生命周期、取消与结果分发。',
      '// 状态所有权：选择中标志与运行号归本 hook；载荷归聊天侧。',
      '// 阅读顺序：先看运行号，再看启动与取消，最后看键盘兜底。',
    ],
    blocks: [
      {
        anchor: 'export function useWebElementPicker({',
        lines: [
          '选择中标志只控制界面态。',
          '运行号是并发正确性的核心。',
          '执行出口用 ref 固定引用。',
          '启动与取消共享同一运行号。',
          '返回值四个成员都稳定。',
        ],
      },
      {
        anchor: 'const cancelPicking = useCallback(async () => {',
        lines: [
          '先递增运行号再复位界面。',
          '随后才向页面发送取消脚本。',
          '取消脚本失败不影响状态。',
          '日志只记录错误消息。',
          '回调不依赖外部可变值。',
        ],
      },
      {
        anchor: 'const startPicking = useCallback(async () => {',
        lines: [
          '启动时先占领运行号。',
          '回包后先比对运行号。',
          '形状不符只告警不抛错。',
          '取消态直接结束本次。',
          '载荷无效则丢弃并记警告。',
        ],
      },
      {
        anchor: 'window.addEventListener("keydown", handleWindowKeyDown, true);',
        lines: [
          '捕获阶段先于业务组件。',
          '只拦截 Escape 一个键。',
          '卸载时移除同一引用。',
          '依赖包含取消回调与状态。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/plugin-ui/adapters/useRecommendedUiPlugins.ts',
    target: 40,
    header: [
      '// INV-01 目标键覆盖四个维度：守住位置 key 构造；改错故障 切换会话后复用旧结果。',
      '// INV-02 上下文对象按 key 记忆：守住位置 useMemo；改错故障 每次渲染都重建身份。',
      '// INV-03 当前上下文存 ref：守住位置 赋值；改错故障 异步回调读到过期上下文。',
      '// INV-04 就绪态存上下文对象：守住位置 ready 比较；改错故障 旧初始化结果被当成新结果。',
      '// INV-05 卸载后不再写状态：守住位置 active 标志；改错故障 卸载后更新触发警告。',
      '// INV-06 未就绪时列表为空：守住位置 ready 比较；改错故障 展示半初始化的空店铺。',
      '// INV-07 推荐项按插件与面板去重：守住位置 findIndex；改错故障 同一入口出现两行。',
      '// INV-08 匹配不到店铺项即跳过：守住位置 早退；改错故障 渲染缺字段的推荐卡。',
      '// INV-09 忙碌项拦截重复点击：守住位置 isItemBusy；改错故障 同一插件并发安装两次。',
      '// INV-10 操作前再验当前上下文：守住位置 isCurrent；改错故障 旧目标操作作用到新会话。',
      '// INV-11 失败信息绑定上下文：守住位置 failure 结构；改错故障 旧会话错误显示在新会话。',
      '// INV-12 安装与恢复分两条路：守住位置 分支；改错故障 可恢复项走了市场安装。',
      '// INV-13 操作服务包一层遥测：守住位置 构造；改错故障 推荐入口行为无法归因。',
      '// INV-14 成功只刷新技能存储：守住位置 后续调用；改错故障 推荐页被强制打开面板。',
      '// INV-15 读取面板失败返回空：守住位置 捕获分支；改错故障 单次失败阻断整个面板。',
      '// INV-16 面板读取也验上下文：守住位置 isCurrent；改错故障 返回旧工作区的面板。',
      '// INV-17 加载态由三条件合成：守住位置 返回值；改错故障 初始化中显示空态。',
      '// INV-18 返回值字段顺序稳定：守住位置 末尾对象；改错故障 调用方解构读到未定义。',
      '//',
      '// 模块职责：把推荐列表接到插件管理 store，产出可渲染条目与操作。',
      '// 状态所有权：就绪态与失败信息归本 hook；插件数据归管理 store。',
      '// 阅读顺序：先看上下文键，再看初始化副作用，最后看操作与读取。',
    ],
    blocks: [
      {
        anchor: 'export function useRecommendedUiPlugins(target: {',
        lines: [
          '四项目标信息参与去重键。',
          '服务来自全局容器。',
          '管理 store 按服务作用域。',
          '推荐配置独立读取。',
          '就绪态与失败态分开保存。',
        ],
      },
      {
        anchor: 'const key = JSON.stringify([',
        lines: [
          '键必须覆盖会话与工作区。',
          '身份字段参与键可区分同路径账号。',
          '上下文只依赖键与服务。',
          'ref 始终指向最新上下文。',
        ],
      },
      {
        anchor: 'const prepare = async (item: StorePluginItem) => {',
        lines: [
          '先读即时状态判断忙碌。',
          '遥测包装不改调用语义。',
          '安装、恢复、启用三选一。',
          '失败信息只在当前上下文写入。',
          '成功后触发技能存储刷新。',
        ],
      },
      {
        anchor: 'const resolveSurface = async (pluginId: string, surfaceId: string) => {',
        lines: [
          '缺桥接直接返回空。',
          '面板列表按目标工作区取。',
          '回包后再验一次上下文。',
          '读失败返回空不抛错。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/settings/model-provider-section/useModelConfigResolution.ts',
    target: 40,
    header: [
      '// INV-01 每次解析递增代次：守住位置 resolveCurrent；改错故障 旧回包覆盖新结果。',
      '// INV-02 身份对象随三项变化重建：守住位置 useMemo；改错故障 A 到 B 再回 A 复用旧解析。',
      '// INV-03 结果绑定身份：守住位置 返回值筛选；改错故障 旧身份结果被当前 UI 读取。',
      '// INV-04 恢复路径单独放行：守住位置 条件；改错故障 恢复请求被默认值判断拦掉。',
      '// INV-05 未打开不发请求：守住位置 早退；改错故障 弹层关闭时仍在打网络。',
      '// INV-06 未启用不发请求：守住位置 早退；改错故障 禁用态触发无意义解析。',
      '// INV-07 与原名相同不发请求：守住位置 早退；改错故障 继承态被当成显式选择。',
      '// INV-08 代次、身份、启用三者共判：守住位置 isCurrent；改错故障 任一变化后旧结果仍提交。',
      '// INV-09 默认值提示有节流：守住位置 定时器；改错故障 连续输入反复闪烁提示。',
      '// INV-10 签名相同不重复提示：守住位置 比较；改错故障 同配置每次刷新都亮提示。',
      '// INV-11 卸载时清定时器：守住位置 清理副作用；改错故障 卸载后仍写状态。',
      '// INV-12 取消即增代次：守住位置 cancel；改错故障 在途请求回来仍提交。',
      '// INV-13 失败也验代次：守住位置 捕获分支；改错故障 旧请求错误覆盖新字段反馈。',
      '// INV-14 结束态按代次复位：守住位置 finally；改错故障 新一轮被旧轮置为未解析。',
      '// INV-15 关闭时清签名：守住位置 条件分支；改错故障 重开弹层误判为已提示。',
      '// INV-16 延迟触发有取消与立即两条：守住位置 触发器；改错故障 无法手动抢先解析。',
      '// INV-17 结果对象不可变：守住位置 构造；改错故障 下游修改缓存结果。',
      '// INV-18 返回值用只读断言：守住位置 末尾；改错故障 调用方误改返回结构。',
      '//',
      '// 模块职责：按打开态、启用态与模型标识调度一次配置解析。',
      '// 状态所有权：结果、解析中、提示与代次都归本 hook。',
      '// 阅读顺序：先看代次与身份，再看解析主体，最后看副作用与返回。',
    ],
    blocks: [
      {
        anchor: 'export function useModelConfigResolution({',
        lines: [
          '结果携带身份对象。',
          '解析中与提示态各自独立。',
          '代次用 ref 避免额外渲染。',
          '身份随打开与模型变化重建。',
          '启用态与身份都存 ref 供异步判断。',
        ],
      },
      {
        anchor: 'const resolveCurrent = useCallback(',
        lines: [
          '恢复调用可跳过默认条件。',
          '模型标识先 trim。',
          '代次在请求前自增。',
          '当前判断综合三项条件。',
          '成功后写结果并可回调应用。',
        ],
      },
      {
        anchor: 'const idle = useIdleTrigger(() => resolveCurrent());',
        lines: [
          '延迟触发复用同一解析函数。',
          '可取消避免输入抖动。',
          '可立即触发供手动刷新。',
          '触发只决定时序不决定条件。',
        ],
      },
      {
        anchor: 'const activeResult = result?.identity === identity ? result.resolution : null;',
        lines: [
          '身份不符的结果对外不可见。',
          '避免旧身份结果短暂展示。',
          '取消与恢复都走同一代次。',
          '返回结构整体只读。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/settings/usage-stats/AppUsageModelUsagePieChart.tsx',
    target: 40,
    header: [
      '// INV-01 视图模型整体记忆：守住位置 useMemo；改错故障 设置页刷新时重复派发图表数据。',
      '// INV-02 依赖只有文案与快照：守住位置 依赖数组；改错故障 无关状态变化触发重建。',
      '// INV-03 无令牌走空态：守住位置 总量判断；改错故障 零值饼图显示为空白。',
      '// INV-04 提示项按载荷取切片：守住位置 格式化回调；改错故障 提示标题与颜色错位。',
      '// INV-05 数值缺失回退切片总量：守住位置 类型判断；改错故障 提示显示零。',
      '// INV-06 占比缺失回退零：守住位置 空值合并；改错故障 提示出现 NaN。',
      '// INV-07 颜色优先用载荷色：守住位置 样式取值；改错故障 图例与扇形颜色不一致。',
      '// INV-08 提示内容按格式化函数记忆：守住位置 useMemo；改错故障 每次渲染重建提示节点。',
      '// INV-09 单切片不加间隔：守住位置 角度计算；改错故障 单扇区出现断裂缝。',
      '// INV-10 扇形描边用表面色：守住位置 描边属性；改错故障 扇区间出现高对比白线。',
      '// INV-11 中心总量与单位分层：守住位置 覆盖层；改错故障 长数字挤压单位。',
      '// INV-12 图例与图表同源：守住位置 数据来源；改错故障 两侧顺序或占比不一致。',
      '// INV-13 图例为语义列表：守住位置 role；改错故障 读屏软件无法逐项朗读。',
      '// INV-14 每行占比与用量并列：守住位置 行结构；改错故障 只有比例没有绝对值。',
      '// INV-15 末行不画分隔线：守住位置 样式；改错故障 列表底部出现多余横线。',
      '// INV-16 边距常量固定：守住位置 图表参数；改错故障 小屏扇形被裁切。',
      '// INV-17 文案全部走国际化：守住位置 消息 id；改错故障 标题与空态不随语言切换。',
      '// INV-18 紧凑单位随语言格式化：守住位置 格式化调用；改错故障 数字单位与语言不匹配。',
      '//',
      '// 模块职责：渲染按模型拆分的令牌用量饼图与图例。',
      '// 状态所有权：无状态；数据由快照经视图模型一次性算出。',
      '// 阅读顺序：先看视图模型，再看提示格式化，最后看空态与图例。',
    ],
    blocks: [
      {
        anchor: 'export function AppUsageModelUsagePieChart({ snapshot }: { snapshot: AppUsageSnapshot }) {',
        lines: [
          '文案与区域设置一起读取。',
          '图表配置与数据同批产出。',
          '总量决定空态分支。',
          '提示内容与图例共用同一数据。',
          '组件本身不持有业务状态。',
        ],
      },
      {
        anchor: 'const formatTooltipItem = useCallback(',
        lines: [
          '载荷类型先断言再取字段。',
          '数值非数字时回退切片总量。',
          '占比缺省为零。',
          '色块与文本分离排版。',
          '语言或单位变化才重建。',
        ],
      },
      {
        anchor: 'const tooltipContent = useMemo(',
        lines: [
          '提示节点只随格式化函数重建。',
          '隐藏默认标签避免重复。',
          '指示线跟随切片颜色。',
          '节点复用减少图表重排。',
        ],
      },
      {
        anchor: 'const APP_USAGE_MODEL_PIE_CHART_MARGIN = {',
        lines: [
          '四边留白一致。',
          '常量冻结避免误改。',
          '小屏裁切由留白吸收。',
          '与图例列宽无关。',
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
    `ZC-deep-b140-spec-${index}.json`,
    JSON.stringify({ files: [{ file: spec.file, items }] }, null, 2),
    'utf8',
  );
  console.log(`spec ${index}: ${spec.file} lines=${total}`);
  index += 1;
}
