import fs from 'node:fs';

const specs = [
  {
    file: 'packages/ui/src/settings/model-provider-section/ProviderDetailFeedback.tsx',
    target: 43,
    header: [
      '// INV-01 默认上下文空实现：守住位置 建上下文默认值；改错故障 无 Provider 时抛错。',
      '// INV-02 同 key 更新原位：守住位置 已存在分支；改错故障 重复提示堆叠。',
      '// INV-03 同 key 重发先清旧定时器：守住位置 计时器映射；改错故障 旧定时器提前关闭新提示。',
      '// INV-04 时长可覆盖：守住位置 空值合并；改错故障 调用方无法定制停留。',
      '// INV-05 默认时长按状态：守住位置 解析函数；改错故障 失败提示过早消失。',
      '// INV-06 进行中不自动关闭：守住位置 零时长判断；改错故障 进行中被计时器抹掉。',
      '// INV-07 卸载清全部定时器：守住位置 清理函数；改错故障 卸载后仍触发状态写入。',
      '// INV-08 关闭同时清定时器：守住位置 删除分支；改错故障 关闭后计时器仍持有引用。',
      '// INV-09 提示按 key 渲染：守住位置 React 键；改错故障 列表复用错位。',
      '// INV-10 失败用告警角色：守住位置 角色三元；改错故障 读屏不播报错误。',
      '// INV-11 成功绿色需显式开启：守住位置 显式标志；改错故障 保存反馈被误当连接成功。',
      '// INV-12 操作按钮需成对：守住位置 双条件；改错故障 出现无回调的按钮。',
      '// INV-13 可关闭才渲染关闭键：守住位置 条件渲染；改错故障 常驻提示无法收起。',
      '// INV-14 关闭键无障碍名回退：守住位置 空值回退；改错故障 读屏只念图标。',
      '// INV-15 容器不拦截页面点击：守住位置 指针事件；改错故障 覆盖层挡住表单。',
      '// INV-16 覆盖层贴底：守住位置 粘性定位；改错故障 长页面提示滚出视口。',
      '// INV-17 上下文值稳定：守住位置 记忆化；改错故障 每次渲染触发消费方重渲。',
      '// INV-18 对外只暴露两个方法：守住位置 接口声明；改错故障 组件直接改内部列表。',
      '//',
      '// 模块职责：模型 Provider 详情页的页内反馈条与定时收起。',
      '// 状态所有权：提示列表与计时器归边界组件，钩子只读上下文。',
      '// 阅读顺序：先看默认时长，再看边界组件，最后看渲染分支。',
    ],
    blocks: [
      {
        anchor: 'export function useProviderDetailFeedback(): ProviderDetailFeedbackContextValue {',
        lines: [
          '默认上下文返回空实现。',
          '消费方无需判空。',
          '直接读取最近的提供者。',
          '不做任何记忆化。',
          '仅暴露读取语义。',
        ],
      },
      {
        anchor: 'function resolveDefaultDuration(state: ProviderDetailFeedbackState): number {',
        lines: [
          '进行中不自动关闭。',
          '失败停留八秒。',
          '成功停留三点五秒。',
          '时长仍可被调用方覆盖。',
          '只按状态决定默认值。',
        ],
      },
      {
        anchor: 'export function ProviderDetailFeedbackBoundary({ children }: { children: ReactNode }) {',
        lines: [
          '提示列表归本组件持有。',
          '计时器映射与列表同生命周期。',
          '卸载时统一清理。',
          '上下文值按依赖记忆。',
          '覆盖层不占布局高度。',
          '子节点原样透传。',
        ],
      },
      {
        anchor: 'const dismissFeedback = useCallback((key: string) => {',
        lines: [
          '先清该键的计时器。',
          '再从映射删除。',
          '最后过滤列表。',
          '关闭与超时共用同一路径。',
          '未知键静默忽略。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/settings/model-provider-section/SortableProviderModelList.tsx',
    target: 43,
    firstNth: 1,
    header: [
      '// INV-01 重排只走数组移动：守住位置 纯函数；改错故障 调用方收到被改写的原数组。',
      '// INV-02 未知标识原样返回：守住位置 索引判断；改错故障 非法拖拽清空列表。',
      '// INV-03 同位置不移动：守住位置 相等判断；改错故障 无意义更新触发保存。',
      '// INV-04 交互控件不启动拖拽：守住位置 选择器；改错故障 点按钮变成拖动。',
      '// INV-05 弹窗内容不启动拖拽：守住位置 选择器扩展；改错故障 弹窗内滑动拖走模型行。',
      '// INV-06 拖动行透明边框占位：守住位置 类名分支；改错故障 行高抖动。',
      '// INV-07 拖动中浮起：守住位置 条件类名；改错故障 被拖行压在邻居下。',
      '// INV-08 末行无分隔线：守住位置 末行判断；改错故障 列表底部多一条线。',
      '// INV-09 拖拽标签走国际化：守住位置 文案读取；改错故障 出现硬编码英文。',
      '// INV-10 键盘排序复用同一隔离：守住位置 键盘分支；改错故障 输入框空格被拖拽吞掉。',
      '// INV-11 拖拽激活需位移阈值：守住位置 传感器配置；改错故障 轻点即进入拖拽。',
      '// INV-12 指针与键盘双传感器：守住位置 传感器数组；改错故障 无鼠标用户无法排序。',
      '// INV-13 可排序集合可裁剪：守住位置 集合判断；改错故障 固定行被拖动。',
      '// INV-14 不可排序行仍渲染：守住位置 三元分支；改错故障 固定行从列表消失。',
      '// INV-15 无回调时纯展示：守住位置 早退；改错故障 只读列表也挂拖拽上下文。',
      '// INV-16 拖拽结束无目标即忽略：守住位置 空值判断；改错故障 列表被重排成空序。',
      '// INV-17 排序上下文只含可排序项：守住位置 标识展开；改错故障 拖拽命中不可排序行。',
      '// INV-18 列表标识保持稳定：守住位置 行键；改错故障 重排后组件状态错位。',
      '//',
      '// 模块职责：模型 Provider 的模型顺序拖拽列表与纯函数重排。',
      '// 状态所有权：拖拽过程归排序库，最终顺序由调用方回调落库。',
      '// 阅读顺序：先看重排纯函数，再看拖拽目标隔离，最后看列表装配。',
    ],
    blocks: [
      {
        anchor: 'export function resolveReorderedModelIds(params: {',
        lines: [
          '索引缺失即原样返回。',
          '相同位置不产生变化。',
          '复制后再移动。',
          '不修改调用方数组。',
          '返回全新数组。',
        ],
      },
      {
        anchor: 'class ModelRowPointerSensor extends PointerSensor {',
        lines: [
          '指针按下先判目标。',
          '交互控件不激活拖拽。',
          '静态激活器可复用到键盘。',
          '不吞掉输入默认行为。',
          '阈值交给传感器配置。',
        ],
      },
      {
        anchor: 'export function isInteractiveModelDragTarget(target: EventTarget | null): boolean {',
        lines: [
          '非元素直接判否。',
          '按钮与输入都算交互。',
          '可编辑区域同样排除。',
          '显式标记优先排除。',
          '弹窗内容不参与拖拽。',
        ],
      },
      {
        anchor: 'function SortableProviderModelRow({',
        lines: [
          '行标识由模型标识决定。',
          '拖拽标签走国际化。',
          '键盘事件先过隔离。',
          '变换与过渡来自排序钩子。',
          '拖动中用透明边框占位。',
          '末行不画分隔线。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/settings/SourceServerUpdateActivity.tsx',
    target: 43,
    header: [
      '// INV-01 阶段文案穷举：守住位置 映射函数；改错故障 未知阶段显示空白。',
      '// INV-02 探测与预检同文案：守住位置 合并判断；改错故障 同阶段两种说法。',
      '// INV-03 未知阶段回退准备中：守住位置 末尾默认；改错故障 显示未定义。',
      '// INV-04 进度百分比取整：守住位置 四舍五入；改错故障 出现超长小数。',
      '// INV-05 无进度不显示百分比：守住位置 空值判断；改错故障 显示非法数值。',
      '// INV-06 数字格式按语言：守住位置 记忆化格式器；改错故障 千分位与语言不符。',
      '// INV-07 进度条语义随状态切换：守住位置 展开属性；改错故障 读屏读到三个百分数。',
      '// INV-08 无进度且活动时脉冲：守住位置 条件类名；改错故障 卡住时无反馈。',
      '// INV-09 日志展开初值随活动：守住位置 初始化；改错故障 进行中默认收起。',
      '// INV-10 活动且有日志自动展开：守住位置 副作用；改错故障 新日志被折叠隐藏。',
      '// INV-11 展开可手动切换：守住位置 点击处理；改错故障 用户无法收起日志。',
      '// INV-12 最近日志与更新日志文案区分：守住位置 条件文案；改错故障 两处标题相同。',
      '// INV-13 时间戳按语言格式化：守住位置 格式化调用；改错故障 十二小时制混入。',
      '// INV-14 错误与警告分级着色：守住位置 类名判断；改错故障 错误日志与普通行同色。',
      '// INV-15 空日志显示等待：守住位置 空数组分支；改错故障 日志区完全空白。',
      '// INV-16 日志行键含时间与阶段：守住位置 键拼接；改错故障 同毫秒日志渲染错位。',
      '// INV-17 展开状态由调用方持有：守住位置 受控组件；改错故障 两个实例互相影响。',
      '// INV-18 进度容器不撑破布局：守住位置 高度类；改错故障 日志变长挤变形。',
      '//',
      '// 模块职责：来源服务器更新的阶段进度与操作日志展示。',
      '// 状态所有权：日志由调用方传入，展开状态归本组件。',
      '// 阅读顺序：先看阶段映射，再看活动组件，最后看日志列表。',
    ],
    blocks: [
      {
        anchor: 'function resolveUpdatePhaseMessageId(phase: string): string {',
        lines: [
          '探测与预检共用一条文案。',
          '下载上传各自映射。',
          '校验分归档与文件两步。',
          '重启与守护重连分开。',
          '未知阶段回退到准备中。',
        ],
      },
      {
        anchor: 'export function SourceServerUpdateActivity({',
        lines: [
          '展开初值跟随活动状态。',
          '最新日志决定进度。',
          '百分比按语言格式化。',
          '无进度时不渲染数值。',
          '活动且有日志自动展开。',
          '日志区可手动收起。',
        ],
      },
      {
        anchor: 'const latest = logs.at(-1);',
        lines: [
          '取最后一条日志。',
          '进度可能缺席。',
          '百分比四舍五入到整数。',
          '空值不参与格式化。',
          '只读最新一条。',
        ],
      },
      {
        anchor: 'export function SourceServerLogList({ logs }: { logs: readonly SourceServerOperationLog[] }) {',
        lines: [
          '空日志显示等待文案。',
          '每行时间按语言格式化。',
          '错误与警告分级着色。',
          '行键含时间与阶段。',
          '容器限高可滚动。',
        ],
      },
    ],
  },
  {
    file: 'apps/zcode-cli/packages/bootstrap/src/app/standalone-account-provider-runtime.ts',
    target: 45,
    firstNth: 1,
    header: [
      '// INV-01 目录每次现读不缓存：守住位置 读取入口；改错故障 登录流程看到旧目录。',
      '// INV-02 注入投影不再读文件：守住位置 配置分支；改错故障 测试与线上走不同源。',
      '// INV-03 只收完整条目：守住位置 四条件判断；改错故障 缺模型条目进入登录列表。',
      '// INV-04 文件模式必须释放源：守住位置 最终清理；改错故障 句柄泄漏。',
      '// INV-05 家族必须唯一：守住位置 数量判断；改错故障 静默取第一个。',
      '// INV-06 身份键拒绝空标识：守住位置 非空判断；改错故障 生成跨 Provider 串号键。',
      '// INV-07 来源键不做去空白：守住位置 文档约定；改错故障 键口径与写入端不一致。',
      '// INV-08 手工身份不可逆：守住位置 摘要算法；改错故障 明文密钥进凭据键。',
      '// INV-09 三段读取缩小范围：守住位置 分批读取；改错故障 手工模式读到 OAuth 密文。',
      '// INV-10 缺身份显式离线：守住位置 空值分支；改错故障 账号断开后仍在线。',
      '// INV-11 缺凭据显式离线：守住位置 授权判断；改错故障 删除凭据后 Provider 不退出。',
      '// INV-12 目录失败向上抛：守住位置 不捕获；改错故障 登录误判为无套餐。',
      '// INV-13 访问判定任一在线：守住位置 存在判断；改错故障 多 Provider 时误判未登录。',
      '// INV-14 请求期先校验中断：守住位置 首尾中断检查；改错故障 取消后仍发请求。',
      '// INV-15 请求身份必须匹配模式：守住位置 访问判断；改错故障 非套餐账号套用桥接。',
      '// INV-16 迟到签发复核登录态：守住位置 三重读取；改错故障 已退出账号仍拿到令牌。',
      '// INV-17 来源不明拒绝猜测：守住位置 末尾抛错；改错故障 旧格式被当 OAuth。',
      '// INV-18 手工模式拒绝范围参数：守住位置 参数判断；改错故障 手工模式接受 OAuth 指纹。',
      '//',
      '// 模块职责：无托管账号 Profile 的独立登录态 Provider 运行时桥。',
      '// 状态所有权：身份与凭据归凭据库，本模块只做投影与请求期解析。',
      '// 阅读顺序：先看目录解析与键口径，再看离线快照，最后看请求期端口。',
    ],
    blocks: [
      {
        anchor: 'export async function readStandaloneCodingPlanProviders(',
        lines: [
          '每次调用都重新解析目录。',
          '不缓存解析结果。',
          '只返回被收下的条目。',
          '目录来源由环境决定。',
          '登录流程需要最新目录。',
          '失败原样向上抛。',
        ],
      },
      {
        anchor: 'async function readStandaloneCodingPlanCatalog(',
        lines: [
          '注入配置时直接投影。',
          '文件模式必须读环境变量。',
          '缺路径立即报稳定错误。',
          '只收账号计划条目。',
          '模型标识需非空。',
          '最终清理保证源被释放。',
        ],
      },
      {
        anchor: 'export async function resolveStandaloneCodingPlanProvider(',
        lines: [
          '先按家族过滤。',
          '数量不是一就抛错。',
          '不做取第一个的猜测。',
          '目录是产品契约。',
          '返回唯一命中项。',
        ],
      },
      {
        anchor: 'export async function readStandaloneAccountProviderConfigSnapshot(',
        lines: [
          '先读目录再读身份。',
          '缺身份直接排除。',
          '来源决定后续读取范围。',
          '缺凭据显式写离线。',
          '在线才写在线。',
          '快照带目录版本。',
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
  fs.writeFileSync(`ZC-deep-b131-spec-${index}.json`, JSON.stringify({ files: [{ file: spec.file, items }] }, null, 2), 'utf8');
  console.log(`spec ${index}: ${spec.file} lines=${total}`);
  index += 1;
}
