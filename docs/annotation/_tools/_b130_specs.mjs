import fs from 'node:fs';

const specs = [
  {
    file: 'packages/provider-node/src/provider-config-runtime.ts',
    target: 48,
    firstNth: 1,
    header: [
      '// INV-01 环境来源与内置来源互斥：守住位置 构造分支；改错故障 两套源同时读盘。',
      '// INV-02 远端同步只在文件源：守住位置 实例判断；改错故障 端点源也去拉远端。',
      '// INV-03 旧配置导入仅在缺文件时触发：守住位置 注入函数；改错故障 已有配置被覆盖。',
      '// INV-04 服务在构造期装配：守住位置 末次赋值；改错故障 调用方拿到未初始化服务。',
      '// INV-05 启动只跑一次：守住位置 启动承诺缓存；改错故障 重复读配置。',
      '// INV-06 启动失败可重试：守住位置 捕获清缓存；改错故障 一次失败永久卡死。',
      '// INV-07 无下载配置不建周期任务：守住位置 条件判断；改错故障 Worker 空转定时器。',
      '// INV-08 定时器不阻塞退出：守住位置 取消引用；改错故障 进程无法自然结束。',
      '// INV-09 已销毁拒绝启动：守住位置 状态判断；改错故障 销毁后仍拉起轮询。',
      '// INV-10 刷新在销毁后返回固定值：守住位置 早退分支；改错故障 销毁后仍访问网络。',
      '// INV-11 刷新按来源分派：守住位置 实例判断；改错故障 端点源走到空同步器。',
      '// INV-12 后台检查单飞：守住位置 在飞缓存；改错故障 定时器叠加并发检查。',
      '// INV-13 检查结果逐个上报：守住位置 遍历判断；改错故障 首个错误后静默其余。',
      '// INV-14 监听器可注销：守住位置 返回函数；改错故障 注销后仍被执行。',
      '// INV-15 检查异常不外抛：守住位置 全量结算；改错故障 出现未捕获拒绝。',
      '// INV-16 活动文件路径两源兼容：守住位置 实例分支；改错故障 端点源调用缺失方法。',
      '// INV-17 销毁幂等：守住位置 状态判断；改错故障 二次销毁抛错。',
      '// INV-18 销毁释放全部子资源：守住位置 依次调用；改错故障 定时器与监听泄漏。',
      '//',
      '// 模块职责：组装 Node 进程内共享的 Provider 配置运行边界。',
      '// 状态所有权：配置由两个来源服务持有，本类只管理生命周期。',
      '// 阅读顺序：先看构造装配，再看启动与刷新，最后看后台检查与销毁。',
    ],
    blocks: [
      {
        anchor: 'constructor(options: NodeProviderConfigRuntimeOptions) {',
        lines: [
          '环境来源与文件来源二选一。',
          '远端同步只包在文件来源外。',
          '导入函数缺省不注入。',
          '个人仓库接收轮询与恢复回调。',
          '配置服务最后装配。',
          '构造期不发起任何 IO。',
        ],
      },
      {
        anchor: 'start(): Promise<void> {',
        lines: [
          '已销毁直接拒绝。',
          '已有启动则复用。',
          '首次读取完成后再启检查。',
          '无下载与监听时不建定时器。',
          '失败清缓存以便重试。',
        ],
      },
      {
        anchor: 'refreshZCodeBuiltin(options?: { readonly force?: boolean }): Promise<ZCodeBuiltinRefreshResult> {',
        lines: [
          '已销毁返回固定值。',
          '端点源走自身刷新。',
          '文件源走远端同步器。',
          '无同步器返回跳过。',
          '错误不在这里吞掉。',
        ],
      },
      {
        anchor: '#checkBackground(): Promise<void> {',
        lines: [
          '已销毁直接返回。',
          '在飞检查复用。',
          '刷新与监听并行。',
          '失败逐个回调。',
          '收尾只清自己的引用。',
        ],
      },
      {
        anchor: 'dispose(): void {',
        lines: [
          '重复调用直接返回。',
          '先清定时器。',
          '再清监听集合。',
          '依次销毁子资源。',
          '顺序保证无回调残留。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/hooks/usePptxFileWatch.ts',
    target: 42,
    header: [
      '// INV-01 路径比较前统一分隔符：守住位置 归一函数；改错故障 反斜杠导致漏判。',
      '// INV-02 盘符与网络路径忽略大小写：守住位置 正则判断；改错故障 大小写差异误刷新。',
      '// INV-03 无变更路径视为命中：守住位置 空值分支；改错故障 目录级事件被丢弃。',
      '// INV-04 状态带文件与服务双标识：守住位置 快照字段；改错故障 换服务沿用旧就绪态。',
      '// INV-05 路径变化先重置状态：守住位置 副作用开头；改错故障 切换文件仍显示旧预览。',
      '// INV-06 无文件即不就绪：守住位置 空值早退；改错故障 空路径被当成可读。',
      '// INV-07 无目录即视为就绪：守住位置 空值分支；改错故障 根路径永远等待。',
      '// INV-08 注册失败仍就绪：守住位置 捕获分支；改错故障 监听不可用阻断预览。',
      '// INV-09 注册竞态需回收：守住位置 已取消判断；改错故障 泄漏一个目录监听。',
      '// INV-10 订阅只处理目标文件：守住位置 过滤函数；改错故障 同目录其他文件触发刷新。',
      '// INV-11 刷新按代数自增：守住位置 计数更新；改错故障 依赖方无法感知新内容。',
      '// INV-12 就绪态归属当前服务：守住位置 双重相等判断；改错故障 旧服务状态泄漏。',
      '// INV-13 卸载先取消标记：守住位置 清理函数；改错故障 迟到的注册仍写状态。',
      '// INV-14 卸载释放订阅：守住位置 销毁调用；改错故障 事件回调继续执行。',
      '// INV-15 卸载停止监听：守住位置 调用点；改错故障 目录监听残留。',
      '// INV-16 停止失败只告警：守住位置 捕获分支；改错故障 关闭页签抛错。',
      '// INV-17 依赖只含文件与服务：守住位置 依赖数组；改错故障 每次渲染重建监听。',
      '// INV-18 返回值永远完整：守住位置 末尾三元；改错故障 调用方读到未定义。',
      '//',
      '// 模块职责：PPTX 预览对源文件变化的监听与刷新代数。',
      '// 状态所有权：快照归本 hook，监听与订阅生命周期绑定副作用。',
      '// 阅读顺序：先看路径归一与事件判定，再看监听注册，最后看返回值隔离。',
    ],
    blocks: [
      {
        anchor: 'function normalizeFileWatchPathForCompare(path: string): string {',
        lines: [
          '先去空白。',
          '反斜杠统一为斜杠。',
          '去掉尾部斜杠。',
          '盘符与网络路径转小写。',
          '其余保持原样。',
        ],
      },
      {
        anchor: 'export function shouldReloadPptxPreviewForWatchEvent(',
        lines: [
          '无变更路径即命中。',
          '两侧都先归一。',
          '逐字相等才刷新。',
          '目录级事件按命中处理。',
          '不读取文件内容。',
        ],
      },
      {
        anchor: 'export function usePptxFileWatch({',
        lines: [
          '状态带文件与服务双标识。',
          '路径变化先重置。',
          '无文件即不就绪。',
          '无目录直接标记就绪。',
          '依赖只有文件与服务。',
        ],
      },
      {
        anchor: 'if (!filePath) {',
        lines: [
          '注册成功记下监听标识。',
          '事件按目标文件过滤。',
          '刷新只增代数。',
          '注册失败仍标记就绪。',
          '取消后立即回收监听。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/app-shell/workflow-artifacts/presets/apply.ts',
    target: 44,
    firstNth: 1,
    header: [
      '// INV-01 纯函数无外部状态：守住位置 不读时间与随机；改错故障 同批条目重放出不同图。',
      '// INV-02 单遍折叠：守住位置 顺序遍历；改错故障 需要二次扫描导致复杂度上升。',
      '// INV-03 字段读取唯一入口：守住位置 读取函数；改错故障 字段表与整条对象口径漂移。',
      '// INV-04 空值不算有值：守住位置 双判空；改错故障 清空后瓦片钉死在空值。',
      '// INV-05 显示文本对象走 JSON：守住位置 序列化；改错故障 表格出现对象占位。',
      '// INV-06 序列化失败退回字符串：守住位置 捕获分支；改错故障 循环引用让整表抛错。',
      '// INV-07 无 x 的点跳过：守住位置 空值判断；改错故障 图上出现无位置的点。',
      '// INV-08 对数轴丢非正维度：守住位置 比较；改错故障 对数轴出现断点。',
      '// INV-09 参考线取首个有效值：守住位置 存在判断；改错故障 参考线随数据漂移。',
      '// INV-10 非数值 x 退化为序号：守住位置 全量判断；改错故障 半排序轴误导阅读。',
      '// INV-11 同 x 按到达顺序：守住位置 次序比较；改错故障 重放顺序不稳定。',
      '// INV-12 表格 upsert 保留首现位置：守住位置 映射插入序；改错故障 行在运行期跳动。',
      '// INV-13 缺 key 用站点与序号兜底：守住位置 三元分支；改错故障 upsert 退化成覆盖。',
      '// INV-14 指标按字段各取最后值：守住位置 逐瓦片更新；改错故障 心跳条目抹掉指标。',
      '// INV-15 看板缺 key 直接跳过：守住位置 早退；改错故障 出现无身份卡片。',
      '// INV-16 其他列只在有卡时出现：守住位置 长度判断；改错故障 侧板被空列挤占。',
      '// INV-17 卡片标题缺省用标识：守住位置 空值回退；改错故障 卡片标题为空。',
      '// INV-18 分发按种类穷举：守住位置 切换分支；改错故障 新种类返回未定义。',
      '//',
      '// 模块职责：把 journal 里的报告条目折叠成预置看板模型。',
      '// 状态所有权：纯函数，输入输出完全由参数决定。',
      '// 阅读顺序：先看字段读取与格式化，再看图表折叠，最后看表格、指标与看板。',
    ],
    blocks: [
      {
        anchor: 'function readEntryField(entry: ArtifactItem, path: string): unknown {',
        lines: [
          '字段表在场时只查表。',
          '缺字段按未定义处理。',
          '整条条目走统一读取。',
          '两种来源规则一致。',
          '不缓存读取结果。',
        ],
      },
      {
        anchor: 'function applyChart(spec: ChartSpec, items: readonly ArtifactItem[]): ChartModel {',
        lines: [
          '序列按字段声明生成。',
          '无 x 的条目静默跳过。',
          '对数轴丢弃非正维度。',
          '参考线取首个有效值。',
          '非数值 x 退化为到达序号。',
        ],
      },
      {
        anchor: 'function applyTable(spec: TableSpec, items: readonly ArtifactItem[]): TableModel {',
        lines: [
          '列按声明顺序生成。',
          '有 key 走 upsert。',
          '行保留首次出现位置。',
          '无 key 用站点与序号拼标识。',
        ],
      },
      {
        anchor: 'function applyMetrics(spec: MetricsSpec, items: readonly ArtifactItem[]): MetricsModel {',
        lines: [
          '每块瓦片各取最后值。',
          '空值不覆盖旧值。',
          '值来源条目一并记录。',
          '从未出现则保持缺省。',
        ],
      },
      {
        anchor: 'function applyBoard(spec: BoardSpec, items: readonly ArtifactItem[]): BoardModel {',
        lines: [
          '缺 key 的条目跳过。',
          '列顺序按声明。',
          '其他列只在有卡时追加。',
          '卡片总数按标识去重。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/settings/model-provider-section/useEnterpriseCodingPlanProducts.ts',
    target: 42,
    header: [
      '// INV-01 鉴权态不同不保留快照：守住位置 相等判断；改错故障 登出后仍显示组织套餐。',
      '// INV-02 刷新失败可退回静态目录：守住位置 兜底构造；改错故障 首次失败显示空列表。',
      '// INV-03 静态目录缺失才返回空：守住位置 数组判断；改错故障 无配置时误报有商品。',
      '// INV-04 作用域标识包含会话序号：守住位置 选择器；改错故障 重新登录沿用旧目录。',
      '// INV-05 作用域对象随依赖重建：守住位置 记忆函数；改错故障 身份变化不隔离状态。',
      '// INV-06 渲染期即隔离：守住位置 相等比较；改错故障 登出暴露一帧旧组织。',
      '// INV-07 已卸载不写状态：守住位置 挂载标志；改错故障 卸载后仍更新状态。',
      '// INV-08 静态与实时并行请求：守住位置 全量结算；改错故障 静态失败阻断实时价格。',
      '// INV-09 响应回写前校验身份：守住位置 三重判断；改错故障 旧响应复活旧身份。',
      '// INV-10 静态目录按提供者取桶：守住位置 存在性判断；改错故障 读错家族的目录。',
      '// INV-11 定价失败不覆盖已知身份：守住位置 兜底函数；改错故障 刷新失败清空已购套餐。',
      '// INV-12 首次失败才展示禁用卡：守住位置 空快照判断；改错故障 已有数据被降级。',
      '// INV-13 断连错误不告警：守住位置 判断函数；改错故障 初始化阶段刷错误日志。',
      '// INV-14 未启用时只收尾：守住位置 早退分支；改错故障 未启用仍发请求。',
      '// INV-15 无服务给固定错误码：守住位置 空值分支；改错故障 界面一直加载。',
      '// INV-16 刷新中保留旧数据：守住位置 保留判断；改错故障 套餐区闪成骨架屏。',
      '// INV-17 静态商品标识单独保存：守住位置 字段；改错故障 用实时价格补造缺失商品。',
      '// INV-18 返回值含状态与刷新：守住位置 记忆返回；改错故障 调用方拿不到刷新入口。',
      '//',
      '// 模块职责：企业 Coding Plan 套餐目录与实时定价的加载编排。',
      '// 状态所有权：快照按身份作用域存本地，服务结果不跨身份复用。',
      '// 阅读顺序：先看待保留与失败兜底，再看 hook 作用域，最后看刷新流程。',
    ],
    blocks: [
      {
        anchor: 'export function shouldRetainEnterprisePricingSnapshotForRefresh(',
        lines: [
          '空快照无可保留。',
          '鉴权态一致才保留。',
          '不一致返回假。',
          '只比较鉴权维度。',
          '不读取套餐内容。',
        ],
      },
      {
        anchor: 'export function resolveEnterprisePricingFailureSnapshot({',
        lines: [
          '可保留则返回原快照。',
          '无静态目录返回空。',
          '否则用空定价构造。',
          '商品按家族打标。',
          '结果仍带当前鉴权态。',
        ],
      },
      {
        anchor: 'export function useEnterpriseCodingPlanProducts({',
        lines: [
          '服务可缺省。',
          '作用域含账号与会话序号。',
          '渲染期先按作用域隔离。',
          '写入前校验作用域与挂载。',
          '默认家族为 bigmodel。',
        ],
      },
      {
        anchor: 'const refresh = useCallback(',
        lines: [
          '未启用只收尾。',
          '无服务给固定错误码。',
          '刷新时保留同身份数据。',
          '静态与定价并行请求。',
          '回写前再次校验身份。',
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
  fs.writeFileSync(`ZC-deep-b130-spec-${index}.json`, JSON.stringify({ files: [{ file: spec.file, items }] }, null, 2), 'utf8');
  console.log(`spec ${index}: ${spec.file} lines=${total}`);
  index += 1;
}
