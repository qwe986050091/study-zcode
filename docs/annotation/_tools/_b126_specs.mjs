import fs from 'node:fs';

const specs = [
  {
    file: 'packages/e2e-report/src/shared/types.ts',
    target: 44,
    header: [
      '// INV-01 数值统计四件套固定：守住位置 接口字段；改错故障 图表缺分位数无法渲染。',
      '// INV-02 采样计数单列：守住位置 采样数字段；改错故障 均值失真时无法判断样本量。',
      '// INV-03 时间戳为字符串：守住位置 字符串类型；改错故障 跨时区解析出现偏差。',
      '// INV-04 失败原因可缺省：守住位置 可选字段；改错故障 通过用例被写入空错误。',
      '// INV-05 结果标题双层保留：守住位置 两级标题；改错故障 汇总只剩最后一级。',
      '// INV-06 通过状态用布尔：守住位置 布尔字段；改错故障 汇总统计依赖文本匹配。',
      '// INV-07 进程按类型分组：守住位置 映射字段；改错故障 多进程数据混成一条曲线。',
      '// INV-08 容器指标逐项同构：守住位置 统一统计类型；改错故障 面板列宽抖动。',
      '// INV-09 覆盖率三项分开存：守住位置 覆盖数、总数与百分比；改错故障 精度丢失。',
      '// INV-10 跳过数单独记录：守住位置 跳过字段；改错故障 分母被跳过项污染。',
      '// INV-11 未覆盖行用数组：守住位置 数字数组；改错故障 高亮区间合并出错。',
      '// INV-12 文件路径双份：守住位置 绝对与相对；改错故障 报告换机器后打不开。',
      '// INV-13 报告产物路径集中：守住位置 文件映射；改错故障 查看器找不到资源。',
      '// INV-14 可选产物不占位：守住位置 可选字段；改错故障 缺失产物显示空链接。',
      '// INV-15 覆盖率可整体缺失：守住位置 可选容器；改错故障 未开启覆盖率时报告报错。',
      '// INV-16 性能分组可选：守住位置 可选字段；改错故障 无容器运行时图表空白。',
      '// INV-17 环境信息随报告：守住位置 环境对象；改错故障 不同机器结果无法比较。',
      '// INV-18 运行标识与时间齐备：守住位置 运行标识与起止时间；改错故障 多次运行互相覆盖。',
      '//',
      '// 模块职责：E2E 报告在主进程、渲染层与查看器之间共享的数据形状。',
      '// 状态所有权：纯类型声明，不含运行期状态与副作用。',
      '// 阅读顺序：先看基础统计与用例结果，再看覆盖率，最后看报告汇总与环境。',
    ],
    blocks: [
      {
        anchor: 'export interface ProcessSampleSummary {',
        lines: [
          '进程数据按类型分组。',
          '每组都带两项统计。',
          '总量单独再存一份。',
          '文件清单保持原始顺序。',
          '采样数与分组同源。',
        ],
      },
      {
        anchor: 'export interface TestResultSummary {',
        lines: [
          '标题保留完整与末级两份。',
          '通过状态用布尔表达。',
          '原始状态字符串原样保留。',
          '文件与错误均可缺省。',
          '采集时间用于排序。',
        ],
      },
      {
        anchor: 'export interface UIRendererCoverageSummary {',
        lines: [
          '启用标志决定是否渲染该块。',
          '产物路径全部可选。',
          '页面数与条目数分开统计。',
          '源文件明细按需附带。',
          '汇总与明细使用同一指标形状。',
          '报告类型用于区分插桩方式。',
        ],
      },
      {
        anchor: 'export interface E2EReportSummary {',
        lines: [
          '产物目录是查看器入口。',
          '运行标识与起止时间成对保存。',
          '环境信息随结果一起落盘。',
          '覆盖率与性能都是可选块。',
          '用例统计与明细同层。',
          '请求的用例清单原样保留。',
        ],
      },
    ],
  },
  {
    file: 'packages/server/src/remote/docker-detect.ts',
    target: 44,
    header: [
      '// INV-01 命令名可覆盖：守住位置 常量；改错故障 测试与部署环境无法替换路径。',
      '// INV-02 输出先去回车：守住位置 归一化函数；改错故障 Windows 换行导致解析失败。',
      '// INV-03 可执行判断可注入：守住位置 选项字段；改错故障 单测依赖真实安装。',
      '// INV-04 路径分隔符随平台：守住位置 分隔符函数；改错故障 Windows 上 PATH 切不开。',
      '// INV-05 拼接走平台路径库：守住位置 分支拼接；改错故障 混用分隔符导致路径无效。',
      '// INV-06 可执行名按平台枚举：守住位置 名称数组；改错故障 Windows 找不到包装脚本。',
      '// INV-07 PATH 优先于固定路径：守住位置 查找顺序；改错故障 用户自定义版本被覆盖。',
      '// INV-08 空目录跳过：守住位置 裁剪后判断；改错故障 当前目录被当作 PATH 项。',
      '// INV-09 找不到时返回裸命令：守住位置 末尾返回；改错故障 启动阶段直接抛错。',
      '// INV-10 探测失败即不可用：守住位置 捕获分支；改错故障 守护进程未启动仍显示入口。',
      '// INV-11 错误信息取标准错误：守住位置 或运算；改错故障 只看到退出码没有原因。',
      '// INV-12 输出上限固定：守住位置 缓冲区常量；改错故障 大列表被截断成半行。',
      '// INV-13 逐行解析：守住位置 换行切分；改错故障 多容器只解析出第一条。',
      '// INV-14 空行被丢弃：守住位置 过滤；改错故障 解析器收到空串报错。',
      '// INV-15 关键字段缺失即跳过该行：守住位置 字段判断；改错故障 列表出现空标识卡片。',
      '// INV-16 可选字段退化为空串：守住位置 空值合并；改错故障 界面出现未定义字样。',
      '// INV-17 单行失败不影响整批：守住位置 捕获分支；改错故障 一条脏数据清空整个列表。',
      '// INV-18 列举默认只看运行中：守住位置 参数分支；改错故障 默认把已停止容器算进去。',
      '//',
      '// 模块职责：定位 docker 可执行文件并解析容器列表。',
      '// 状态所有权：无状态，环境与平台由调用方注入。',
      '// 阅读顺序：先看命令定位与回退路径，再看执行封装，最后看列表解析。',
    ],
    blocks: [
      {
        anchor: 'function normalizeDockerOutput(raw: string): string {',
        lines: [
          '只去掉回车字符。',
          '不裁剪首尾空白。',
          '保留原始换行。',
          '供执行与解析共用。',
          '不修改输入字符串。',
        ],
      },
      {
        anchor: 'function getFallbackDockerCommands(platform: NodeJS.Platform, userHomeDir: string): string[] {',
        lines: [
          'macOS 覆盖常见安装位置。',
          'Linux 只列标准目录。',
          'Windows 列桌面版路径。',
          '未知平台返回空数组。',
          '回退只在前一步失败后使用。',
        ],
      },
      {
        anchor: 'export function resolveDockerCommand(options: DockerCommandResolutionOptions = {}): string {',
        lines: [
          '平台与用途都可注入。',
          '先按 PATH 顺序查找。',
          '每个目录试全部候选名。',
          '空目录直接跳过。',
          '再查平台固定路径。',
          '全部失败返回裸命令。',
        ],
      },
      {
        anchor: 'export function parseDockerContainerList(rawOutput: string): DockerContainerInfo[] {',
        lines: [
          '先按行切分。',
          '空行在解析前丢弃。',
          '每行独立解析 JSON。',
          '缺标识或名称的行跳过。',
          '可选字段退化为空串。',
          '脏行不影响其他行。',
        ],
      },
    ],
  },
  {
    file: 'apps/zcode-cli/packages/cli/src/provider-runtime-env.ts',
    target: 42,
    header: [
      '// INV-01 先判断是否需要运行时：守住位置 入口早退；改错故障 帮助命令也触发配置准备。',
      '// INV-02 显式变量最高优先：守住位置 环境读取；改错故障 用户配置被内置路径覆盖。',
      '// INV-03 两个变量都显式才直返：守住位置 双条件；改错故障 只配一半时另一边被清空。',
      '// INV-04 数据根目录三级回退：守住位置 空值合并；改错故障 未设变量时写入错误目录。',
      '// INV-05 单文件模式先取资产：守住位置 资产读取；改错故障 打包后找不到随包配置。',
      '// INV-06 入口路径取真实路径：守住位置 解析软链接；改错故障 全局命令定位到错误目录。',
      '// INV-07 候选路径按序查找：守住位置 数组查找；改错故障 开发态与发布态配置混淆。',
      '// INV-08 资产只读取出即释放：守住位置 收尾释放；改错故障 文件句柄泄漏。',
      '// INV-09 入口只准备资源：守住位置 不启动下载；改错故障 短命令拉起长生命周期任务。',
      '// INV-10 缓存路径集中解析：守住位置 统一函数；改错故障 版本升级后读到旧缓存。',
      '// INV-11 个人配置固定文件名：守住位置 共享常量；改错故障 与主程序读写不同文件。',
      '// INV-12 平台解析可注入：守住位置 选项字段；改错故障 单测绑定当前系统。',
      '// INV-13 版本号可注入：守住位置 选项字段；改错故障 缓存键在测试中漂移。',
      '// INV-14 端点来源统一解析：守住位置 共享函数；改错故障 内置配置指向错误环境。',
      '// INV-15 刷新成功才默认留痕：守住位置 结果判断；改错故障 每次启动都刷日志。',
      '// INV-16 日志不输出查询参数：守住位置 固定字段；改错故障 CDN 令牌进入日志。',
      '// INV-17 非生产环境放宽日志：守住位置 环境判断；改错故障 调试时看不到刷新结果。',
      '// INV-18 返回值为纯字符串映射：守住位置 返回类型；改错故障 调用方拿到可变环境对象。',
      '//',
      '// 模块职责：为 CLI 入口准备 Provider 配置相关的环境变量。',
      '// 状态所有权：本模块不持有全局状态，资源在函数内创建并释放。',
      '// 阅读顺序：先看入口判定，再看路径解析，最后看随包配置定位与日志上报。',
    ],
    blocks: [
      {
        anchor: 'export function createCliProviderRefreshReporter(',
        lines: [
          '输出流可注入便于测试。',
          '刷新失败固定写一行。',
          '只有成功更新才默认写。',
          '非生产环境放宽为全量。',
          '日志只带结果与版本。',
        ],
      },
      {
        anchor: 'export async function prepareCliProviderRuntimeEnv(',
        lines: [
          '不需要运行时的命令返回空。',
          '两个显式变量齐全时原样透传。',
          '缺一个时另一侧走解析。',
          '数据根目录三级回退。',
          '返回三个固定变量。',
        ],
      },
      {
        anchor: 'function requiresProviderRuntime(argv: readonly string[]): boolean {',
        lines: [
          '帮助与版本命令不需要。',
          '直接提示与目标参数需要。',
          '无命令时按需要处理。',
          '以连字符开头的参数按需要处理。',
          '其余按白名单命令判断。',
        ],
      },
      {
        anchor: 'async function resolveBundledZCodeBuiltinProviderConfig(input: {',
        lines: [
          '单文件模式优先读资产。',
          '资产内容写入环境配置根。',
          '缺入口路径直接报错。',
          '入口先解析软链接。',
          '两个候选路径依次查找。',
        ],
      },
    ],
  },
  {
    file: 'packages/desktop/src/main/desktopArmsCustomEvent.ts',
    target: 41,
    header: [
      '// INV-01 容量上限固定：守住位置 常量；改错故障 内存环无限增长。',
      '// INV-02 容量下限为一：守住位置 最大值包裹；改错故障 零容量导致写入即丢。',
      '// INV-03 非法容量退回首值：守住位置 有限数判断；改错故障 传入无穷时环失效。',
      '// INV-04 超出容量从头裁剪：守住位置 裁剪调用；改错故障 旧事件不淘汰。',
      '// INV-05 负载深拷贝：守住位置 属性复制；改错故障 调用方后续修改污染记录。',
      '// INV-06 读取也拷贝：守住位置 逐条复制；改错故障 外部修改历史条目。',
      '// INV-07 序号单调递增：守住位置 自增计数；改错故障 排序依据重复。',
      '// INV-08 抑制名单去重：守住位置 集合构造；改错故障 重复项放大内存。',
      '// INV-09 抑制名单类型校验：守住位置 类型判断；改错故障 非字符串混入名单。',
      '// INV-10 名单长度上限：守住位置 数组长度判断；改错故障 超长名单拖慢匹配。',
      '// INV-11 空名与超长名拒绝：守住位置 裁剪后判断；改错故障 空串抑制所有事件。',
      '// INV-12 平台归类三档：守住位置 分支判断；改错故障 未知平台被算作 Linux。',
      '// INV-13 指标默认值一：守住位置 空值合并；改错故障 无值事件统计为零。',
      '// INV-14 属性统一转字符串：守住位置 逐项转换；改错故障 上报类型不一致。',
      '// INV-15 未定义属性被跳过：守住位置 空值判断；改错故障 出现未定义字样。',
      '// INV-16 先记录再发送：守住位置 调用顺序；改错故障 发送失败时丢失证据。',
      '// INV-17 抑制只跳过发送：守住位置 条件分支；改错故障 抑制后连记录也没有。',
      '// INV-18 共享环按门禁创建：守住位置 启用函数；改错故障 生产环境也常驻捕获。',
      '//',
      '// 模块职责：main 进程的 ARMS 自定义事件捕获环与上报分发。',
      '// 状态所有权：环实例由共享变量持有，其余均为函数内局部状态。',
      '// 阅读顺序：先看环的创建与容量，再看负载构造，最后看分发与抑制。',
    ],
    blocks: [
      {
        anchor: 'export function createFinalArmsCustomEventE2EController(',
        lines: [
          '容量先夹到合法区间。',
          '时间源可注入便于测试。',
          '记录时复制负载。',
          '超出容量从头裁剪。',
          '读取返回独立副本。',
        ],
      },
      {
        anchor: 'export function enableSharedFinalArmsCustomEventE2EController(',
        lines: [
          '每次启用都重建实例。',
          '旧实例不再被引用。',
          '参数与创建函数一致。',
          '由 IPC 层在门禁后调用。',
        ],
      },
      {
        anchor: 'export function buildFinalArmsCustomEventPayload(params: {',
        lines: [
          '指标缺省为一。',
          '上下文属性先铺底。',
          '调用方属性可覆盖。',
          '未定义值被跳过。',
          '其余统一转字符串。',
        ],
      },
      {
        anchor: 'export function dispatchFinalArmsCustomEvent(params: {',
        lines: [
          '先构造负载再记录。',
          '抑制判断按事件名。',
          '未抑制才真正发送。',
          '返回结果含抑制标记。',
          '发送函数由调用方注入。',
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
  fs.writeFileSync(`ZC-deep-b126-spec-${index}.json`, JSON.stringify({ files: [{ file: spec.file, items }] }, null, 2), 'utf8');
  console.log(`spec ${index}: ${spec.file} lines=${total}`);
  index += 1;
}
