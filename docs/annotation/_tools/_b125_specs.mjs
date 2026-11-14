import fs from 'node:fs';

const specs = [
  {
    file: 'apps/zcode-cli/packages/bootstrap/src/zcode-protocol/usage-stats-builder.ts',
    target: 44,
    header: [
      '// INV-01 单日切分只认偏移：守住位置 时区偏移换算；改错故障 跨时区用户日期错一天。',
      '// INV-02 偏移解析失败回退零：守住位置 捕获分支；改错故障 非法时区让整个快照抛错。',
      '// INV-03 日索引按本地午夜：守住位置 毫秒常量相乘；改错故障 热力图日期整体偏移。',
      '// INV-04 四档阈值固定：守住位置 比例分界；改错故障 等级随数据量漂移。',
      '// INV-05 无 token 归零级：守住位置 非正数判断；改错故障 空白天显示成有数据的颜色。',
      '// INV-06 全量区间从最早日开始：守住位置 取最小值；改错故障 热力图左侧出现大片空白。',
      '// INV-07 无数据退化为单日：守住位置 空数组判断；改错故障 起始日缺失导致循环失控。',
      '// INV-08 非全量用起点日：守住位置 区间判断；改错故障 窗口开始前的数据仍被统计。',
      '// INV-09 缓存命中率分母唯一：守住位置 三目表达式；改错故障 命中率被重复扣减。',
      '// INV-10 比率除零保护：守住位置 大于零判断；改错故障 空库出现无效数值。',
      '// INV-11 连续天数双向统计：守住位置 运行段与最长段；改错故障 中断后当前连续数继续累加。',
      '// INV-12 当前段遇零即止：守住位置 中断标志；改错故障 断签后仍显示连续三十天。',
      '// INV-13 峰值取最大日：守住位置 归约函数；改错故障 热力图色阶封顶错误。',
      '// INV-14 周切片固定七天：守住位置 长度判断；改错故障 网格列数随数据变化。',
      '// INV-15 末周补空位：守住位置 补空循环；改错故障 最后一周被挤到下一列。',
      '// INV-16 趋势按日聚模型：守住位置 当日映射；改错故障 同日多模型互相覆盖。',
      '// INV-17 排行份额按总量：守住位置 总和归约；改错故障 各模型份额之和不为一。',
      '// INV-18 纯函数只读入参：守住位置 不写查询结果；改错故障 上游缓存被污染。',
      '//',
      '// 模块职责：把用量库的聚合结果投影成 App 端快照。',
      '// 状态所有权：无状态，输入为查询结果与已解析的时间窗口。',
      '// 阅读顺序：先看时区与等级，再看连续天数与热力图，最后看趋势与排行。',
    ],
    blocks: [
      {
        anchor: 'export function resolveTzOffsetMs(timeZone: string, atMs: number): number {',
        lines: [
          '用格式化结果反推偏移。',
          '秒级截断后再相减。',
          '解析失败一律回退零。',
          '不依赖运行环境时区。',
          '只在解析时创建格式化器。',
          '返回值单位是毫秒。',
        ],
      },
      {
        anchor: 'function levelFor(tokens: number, max: number): AppUsageHeatmapCell["level"] {',
        lines: [
          '非正数直接归零级。',
          '比例按最大值计算。',
          '四档阈值依次判断。',
          '大于七成五为最高档。',
          '零级不参与比例计算。',
          '阈值之间不留空洞。',
        ],
      },
      {
        anchor: 'function resolveUsageStartDayIndex(',
        lines: [
          '非全量区间用起点日。',
          '起点由毫秒偏移换算。',
          '全量时汇总两处日索引。',
          '无数据退化为结束日。',
          '取最小值作为起点。',
        ],
      },
      {
        anchor: 'export function buildAppUsageSnapshot(',
        lines: [
          '命中率分母不重复累加。',
          '三项错误率各自除零保护。',
          '日映射供连续与热力图共用。',
          '热力图按七天切周。',
          '末尾不足一周补空位。',
        ],
      },
    ],
  },
  {
    file: 'apps/zcode-cli/packages/core/src/tool/handlers/bash-readonly-policy-simple-commands.ts',
    target: 45,
    header: [
      '// INV-01 未登记即需审批：守住位置 白名单缺省；改错故障 未知参数被静默放行。',
      '// INV-02 git 全局 flag 三分类：守住位置 三个集合；改错故障 危险 flag 落入只读分支。',
      '// INV-03 带值全局 flag 当前为空：守住位置 空集合；改错故障 误放行带值全局参数。',
      '// INV-04 重定向类一律危险：守住位置 危险集合；改错故障 指定仓库目录绕过权限。',
      '// INV-05 危险集合先于白名单判断：守住位置 查表顺序；改错故障 白名单覆盖危险项。',
      '// INV-06 命令级策略三种形态：守住位置 策略对象字段；改错故障 参数形态被误判。',
      '// INV-07 裸命令最严格：守住位置 仅命令判断；改错故障 带参调用被判只读。',
      '// INV-08 任意参数需真无害：守住位置 放宽标记；改错故障 写操作命令进入只读。',
      '// INV-09 安全 flag 未列出即拒绝：守住位置 集合查找；改错故障 新 flag 默认放行。',
      '// INV-10 双横线语义可关闭：守住位置 标志位；改错故障 待处理内容被截断解析。',
      '// INV-11 回调补充逐命令判断：守住位置 附加判断函数；改错故障 特定子命令写文件。',
      '// INV-12 正则限定的命令不认位置参数：守住位置 整行匹配；改错故障 位置参数改写系统状态。',
      '// INV-13 兜底集合只放无写命令：守住位置 注释约束；改错故障 用户数据被改写。',
      '// INV-14 兜底集合先于逐命令表：守住位置 判定顺序；改错故障 严格策略被放宽覆盖。',
      '// INV-15 兜底集合绕过 flag 限制：守住位置 集合语义；改错故障 带写 flag 的命令放行。',
      '// INV-16 docker 只放列举子命令：守住位置 两词前缀；改错故障 启动容器被判只读。',
      '// INV-17 前缀按段比较：守住位置 元组数组；改错故障 相似命令被误命中。',
      '// INV-18 表结构只读：守住位置 导出常量；改错故障 运行期修改污染全局判定。',
      '//',
      '// 模块职责：单命令只读策略表，供 argv 查表与整体判定使用。',
      '// 状态所有权：全部为模块级常量，运行期不修改。',
      '// 阅读顺序：先看 git 全局分类，再看逐命令白名单，最后看兜底集合与前缀。',
    ],
    blocks: [
      {
        anchor: 'export const GIT_GLOBAL_NO_VALUE_FLAGS = new Set(["--no-pager", "--paginate"]);',
        lines: [
          '只登记不改变执行方向的 flag。',
          '带值集合当前刻意留空。',
          '危险集合含配置与目录重定向。',
          '三类集合互不重叠。',
          '新增 flag 先判断归属。',
        ],
      },
      {
        anchor: 'export const READONLY_COMMAND_POLICIES = new Map<string, BashReadonlyCommandPolicy>([',
        lines: [
          '只允许裸命令的最严格。',
          '任意参数仅用于无写命令。',
          '安全 flag 未列出的参数一律拒绝。',
          '双横线语义按命令关闭。',
          '回调负责子命令级追加判断。',
          '未登记命令由上层按需审批。',
        ],
      },
      {
        anchor: 'export const READONLY_ALLOW_ANY_ARG_COMMANDS = new Set([',
        lines: [
          '集合在逐命令表之前生效。',
          '因此不能放任何写操作命令。',
          '仅收录参数只影响查询的命令。',
          '新增条目需先确认无副作用。',
          '条目顺序无关但保持字母序。',
          '与白名单重复的条目是有意为之。',
        ],
      },
      {
        anchor: 'export const READONLY_ALLOW_ANY_ARG_COMMAND_PREFIXES = [',
        lines: [
          '只收 docker 的两词前缀。',
          '列举子命令不改变守护进程。',
          '参数只缩小查询范围。',
          '前缀按数组逐段比较。',
          '新增前缀需同族审查。',
          '不拼接过长的命令字符串。',
        ],
      },
    ],
  },
  {
    file: 'apps/zcode-cli/packages/tui/src/app-submit.ts',
    target: 45,
    first: '// 提交落地模块：把一次提交/恢复的结果合并进 transcript，并分派"进行中排队"与"空闲新建一轮"两条路径。',
    header: [
      '// INV-01 只改传入 setter：守住位置 入参收敛；改错故障 模块直接写会话存储。',
      '// INV-02 结果按种类分派：守住位置 种类分支；改错故障 排队结果被当成新一轮。',
      '// INV-03 恢复优先于当前：守住位置 三元基底；改错故障 恢复历史与现存消息混在一起。',
      '// INV-04 空响应不占位：守住位置 裁剪后长度判断；改错故障 界面出现未发送的回复。',
      '// INV-05 重复响应不追加：守住位置 存在性判断；改错故障 同一回复渲染两次。',
      '// INV-06 空片段被过滤：守住位置 类型收窄过滤；改错故障 渲染层收到空数组。',
      '// INV-07 工具片段重建投影：守住位置 标题与详情重建；改错故障 恢复后工具行样式不同。',
      '// INV-08 本地消息标识进程内唯一：守住位置 自增序号；改错故障 列表键冲突。',
      '// INV-09 进行中提交先排队：守住位置 发送能力判断；改错故障 与当前回合并发起新轮。',
      '// INV-10 无发送能力不动草稿：守住位置 提前返回；改错故障 用户输入丢失。',
      '// INV-11 排队只进队列区：守住位置 排队分支；改错故障 排队输入混入流式回复。',
      '// INV-12 其余结果回填草稿：守住位置 兜底分支；改错故障 失败后输入消失。',
      '// INV-13 异常统一写错误态：守住位置 捕获分支；改错故障 失败没有任何提示。',
      '// INV-14 空闲提交先清态：守住位置 发送前重置；改错故障 上一轮状态栏残留。',
      '// INV-15 紧凑命令走时间线：守住位置 命令识别；改错故障 同一命令出现两种行样式。',
      '// INV-16 取消不算失败：守住位置 中止判断；改错故障 用户取消后弹出错误。',
      '// INV-17 只清理自己的控制器：守住位置 引用比较；改错故障 并发提交后新轮无法取消。',
      '// INV-18 展示文本先脱敏：守住位置 脱敏函数；改错故障 密钥进入对话记录。',
      '//',
      '// 模块职责：把提交结果合并进 transcript，并分派排队与新建两条路径。',
      '// 状态所有权：状态全部来自调用方 setter，本模块不持久化任何数据。',
      '// 阅读顺序：先看结果合并与恢复，再看进行中提交，最后看空闲提交与脱敏。',
    ],
    blocks: [
      {
        anchor: 'export function appendAgentResult(',
        lines: [
          '恢复场景以历史为基底。',
          '重置标记清空当前消息。',
          '两者都不满足时沿用。',
          '空响应直接返回基底。',
          '仅追加一条最终回复。',
        ],
      },
      {
        anchor: 'function restoreTranscriptPart(',
        lines: [
          '文本片段为空则丢弃。',
          '思考片段补上字数。',
          '工具片段重建投影。',
          '文件差异转结构化展示。',
          '保留错误与输出字段。',
          '片段类型决定分支。',
        ],
      },
      {
        anchor: 'export async function submitDuringActiveTurn(input: {',
        lines: [
          '无发送能力时保持草稿。',
          '发请求前先清空输入框。',
          '命令结果保留回合状态。',
          '排队结果只进队列区。',
          '其他结果回填原文。',
          '异常同时写错误与消息。',
        ],
      },
      {
        anchor: 'export async function submitIdleTurn(input: {',
        lines: [
          '发送前重置全部展示态。',
          '紧凑命令改为时间线行。',
          '普通输入追加用户消息。',
          '中止按用户取消处理。',
          '失败按命令类型分别处理。',
          '收尾恢复空闲并释放引用。',
        ],
      },
    ],
  },
  {
    file: 'apps/zcode-cli/packages/cli/src/clipboard-image.ts',
    target: 43,
    header: [
      '// INV-01 超限即视为无图：守住位置 字节上限；改错故障 巨型图片进入模型上下文。',
      '// INV-02 失败一律返回空：守住位置 各实现兜底；改错故障 剪贴板异常打断提交。',
      '// INV-03 平台分发只做能力选择：守住位置 分支判断；改错故障 启动时探测拖慢启动。',
      '// INV-04 未知平台返回空：守住位置 末尾兜底；改错故障 调用方需要额外分支。',
      '// INV-05 macOS 走临时文件：守住位置 脚本写盘；改错故障 二进制走标准输出被截断。',
      '// INV-06 临时目录必清理：守住位置 收尾删除；改错故障 截图残留在用户磁盘。',
      '// INV-07 Linux 多候选依次尝试：守住位置 候选数组；改错故障 只有单一工具的环境取不到图。',
      '// INV-08 首个成功即返回：守住位置 退出码与内容双判断；改错故障 空输出被当作图片。',
      '// INV-09 无图退出码单独约定：守住位置 脚本分支；改错故障 期待图片却拿到空文件。',
      '// INV-10 字节为空不可用：守住位置 长度判断；改错故障 生成空数据地址。',
      '// INV-11 尺寸按原始字节：守住位置 长度字段；改错故障 展示体积偏大四成。',
      '// INV-12 媒体类型随候选给定：守住位置 候选声明；改错故障 图片类型与实际不符。',
      '// INV-13 子进程用参数数组：守住位置 启动方式；改错故障 路径含空格被拆断。',
      '// INV-14 输出超限即终止：守住位置 累计判断；改错故障 内存被超大输出撑爆。',
      '// INV-15 只收集标准输出：守住位置 管道配置；改错故障 错误输出混入图片数据。',
      '// INV-16 启动失败归一为负一：守住位置 捕获分支；改错故障 异常逃逸成未捕获拒绝。',
      '// INV-17 结果只结算一次：守住位置 已结算标志；改错故障 关闭与错误事件重复结算。',
      '// INV-18 脚本字面量转义：守住位置 专用转义函数；改错故障 路径内容注入脚本。',
      '//',
      '// 模块职责：跨平台读取剪贴板图片并归一为 TUI 可用结构。',
      '// 状态所有权：无状态，配置与命令执行器由调用方注入。',
      '// 阅读顺序：先看创建器与分发，再看三平台实现，最后看字节归一与执行器。',
    ],
    blocks: [
      {
        anchor: 'export function createNodeClipboardImageReader(',
        lines: [
          '默认值集中在闭包。',
          '平台在创建时确定。',
          '返回函数只做分发。',
          '中止信号透传给子进程。',
          '不缓存上一次结果。',
        ],
      },
      {
        anchor: 'async function readMacClipboardImage(options: {',
        lines: [
          '先确保目录存在。',
          '每次读取用独立临时目录。',
          '脚本把图像写入文件。',
          '非零退出直接返回空。',
          '收尾递归删除目录。',
        ],
      },
      {
        anchor: 'async function readLinuxClipboardImage(options: {',
        lines: [
          '先试 Wayland 再试 X11。',
          '每种格式单独一条候选。',
          '退出码为零才接受。',
          '内容为空继续下一个。',
          '全部失败返回空。',
        ],
      },
      {
        anchor: 'async function runCommandBuffer(',
        lines: [
          '用参数数组启动进程。',
          '隐藏窗口避免弹窗。',
          '标准输入与错误均忽略。',
          '超限立即终止子进程。',
          '错误与关闭统一结算。',
          '只结算第一次结果。',
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
  fs.writeFileSync(`ZC-deep-b125-spec-${index}.json`, JSON.stringify({ files: [{ file: spec.file, items }] }, null, 2), 'utf8');
  console.log(`spec ${index}: ${spec.file} lines=${total}`);
  index += 1;
}
