import fs from 'node:fs';

const specs = [
  {
    file: 'apps/zcode-cli/packages/core/src/hooks/configured-runner-callback.ts',
    target: 42,
    header: [
      '// INV-01 command 与 process 同语义：守住位置 两条分支；改错故障 两种 hook 行为不一致。',
      '// INV-02 stdin 必须清理：守住位置 最终清理；改错故障 临时文件泄漏。',
      '// INV-03 cwd 优先输入值：守住位置 空值合并；改错故障 忽略 hook 指定目录。',
      '// INV-04 环境覆盖按插件合并：守住位置 覆盖函数；改错故障 插件变量串台。',
      '// INV-05 变量展开含工作目录：守住位置 参数；改错故障 相对路径按进程目录解析。',
      '// INV-06 输出只诊断不落盘：守住位置 持久化选项；改错故障 大输出写产物。',
      '// INV-07 超时来自执行参数：守住位置 透传；改错故障 hook 无限挂起。',
      '// INV-08 输出上限同值：守住位置 两个字段；改错故障 内联与缓冲不对称。',
      '// INV-09 trace 含匹配位置：守住位置 属性；改错故障 无法定位哪个 hook。',
      '// INV-10 信号透传执行端口：守住位置 第二参数；改错故障 取消不生效。',
      '// INV-11 退出码零才算成功：守住位置 双条件；改错故障 非零被当成功。',
      '// INV-12 退出码二转阻断：守住位置 分支；改错故障 拒绝被当失败重试。',
      '// INV-13 其它退出码抛可恢复错：守住位置 末尾；改错故障 静默吞掉失败。',
      '// INV-14 预览截断统一入口：守住位置 修剪函数；改错故障 日志爆炸。',
      '// INV-15 阻断原因优先 stderr：守住位置 回退链；改错故障 用户看不到拒绝理由。',
      '// INV-16 阻断形状按事件分派：守住位置 四分支；改错故障 权限事件字段错。',
      '// INV-17 stdout 像对象才解析：守住位置 首字符判断；改错故障 普通日志报错。',
      '// INV-18 JSON 结构非法要报错：守住位置 schema 校验；改错故障 错误协议被静默接受。',
      '//',
      '// 模块职责：把配置 hook 翻译成一次受控进程执行并归一化结果。',
      '// 状态所有权：无状态；执行端口、目录与信号均由调用方注入。',
      '// 阅读顺序：先看两条执行分支，再看结果归一化，最后看阻断形状。',
    ],
    blocks: [
      {
        anchor: 'export function createConfiguredHookCallback(',
        lines: [
          '按类型分派两种执行。',
          '两者共享输入与诊断路径。',
          '变量展开带工作目录。',
          '执行参数来自调用方。',
          '不缓存任何状态。',
        ],
      },
      {
        anchor: 'function processHookExecutionResult(',
        lines: [
          '零代码才算成功。',
          '二代码转阻断。',
          '其余抛可恢复错误。',
          '诊断统一附加。',
          '预览统一截断。',
        ],
      },
      {
        anchor: 'function parseHookStdout(stdout: string, event: HookEventName): HookJSONOutput | undefined {',
        lines: [
          '空串直接返回空。',
          '非对象形状不解析。',
          '解析失败静默忽略。',
          '结构非法立即报错。',
          '错误带事件名与片段。',
        ],
      },
      {
        anchor: 'function createExitCodeBlockOutput(input: HookInput, result: ExecutionResult): HookJSONOutput {',
        lines: [
          '原因优先取标准错误。',
          '其次取标准输出。',
          '最后用兜底文案。',
          '工具事件给拒绝决定。',
          '停止事件给阻断决定。',
        ],
      },
    ],
  },
  {
    file: 'apps/zcode-cli/packages/core/src/runtime/methods/rewind.ts',
    target: 44,
    header: [
      '// INV-01 命令占用活动槽：守住位置 开始与结束；改错故障 并发改写历史。',
      '// INV-02 会话行先落盘：守住位置 事件之前；改错故障 事件写入失败。',
      '// INV-03 先发开始事件：守住位置 执行之前；改错故障 界面毫无反应。',
      '// INV-04 分派前检查取消：守住位置 首个检查；改错故障 取消后仍改文件。',
      '// INV-05 分派后复查取消：守住位置 完成之前；改错故障 半完成被当成功。',
      '// INV-06 先完成事件后记账：守住位置 顺序；改错故障 账本失败回滚界面。',
      '// INV-07 成功后自增轮次：守住位置 重建之前；改错故障 轮次重复。',
      '// INV-08 重建投影：守住位置 返回之前；改错故障 界面停在旧历史。',
      '// INV-09 失败统一归一化：守住位置 捕获；改错故障 取消被当错误。',
      '// INV-10 终态事件必发：守住位置 结果追加；改错故障 客户端等待超时。',
      '// INV-11 活动槽必释放：守住位置 最终清理；改错故障 后续请求永久排队。',
      '// INV-12 status 只读：守住位置 分支；改错故障 查看状态就触发回退事件。',
      '// INV-13 无检查点给明确文案：守住位置 空值分支；改错故障 静默失败。',
      '// INV-14 检查点缺失也是终态：守住位置 不可用路径；改错故障 抛异常打断会话。',
      '// INV-15 适配器缺失走降级：守住位置 双空判断；改错故障 环境问题被当用户错误。',
      '// INV-16 只接受活动链与仅文件：守住位置 策略白名单；改错故障 不可达目标改文件。',
      '// INV-17 读快照前检查取消：守住位置 读取之前；改错故障 取消后仍拉大文件。',
      '// INV-18 文件先于事件：守住位置 调用顺序；改错故障 冷恢复看到不一致状态。',
      '//',
      '// 模块职责：回退命令的轮次编排、检查点选择与工作区恢复。',
      '// 状态所有权：轮次号与投影归 runtime，事件归事件存储。',
      '// 阅读顺序：先看命令主流程，再看检查点恢复，最后看不可用收尾。',
    ],
    blocks: [
      {
        anchor: 'export async function executeRewindCommand(',
        lines: [
          '先占活动轮次槽。',
          '会话行先落盘。',
          '开始事件先写。',
          '分派前检查取消。',
          '完成后复查取消。',
          '终态无论成败都发。',
        ],
      },
      {
        anchor: 'export async function rewindWorkspaceToCheckpoint(',
        lines: [
          '每次尝试新回退标识。',
          '无检查点走不可用。',
          '适配器缺失也降级。',
          '只接受两种策略。',
          '读快照前检查取消。',
          '文件恢复后才发事件。',
        ],
      },
      {
        anchor: 'export async function finishUnavailableRewind(',
        lines: [
          '不可用也是合法终态。',
          '仍写回退事件。',
          '策略标记不可用。',
          '恢复列表为空。',
          '文案由统一格式器给出。',
        ],
      },
      {
        anchor: 'export async function formatRewindStatus(this: AgentRuntimeInternal): Promise<string> {',
        lines: [
          '走投影读最后检查点。',
          '无检查点给明确文案。',
          '文件数未知用占位。',
          '被压缩覆盖要说明。',
          '只读不发事件。',
        ],
      },
    ],
  },
  {
    file: 'apps/zcode-cli/packages/core/src/tool/handlers/agent.ts',
    target: 43,
    firstNth: 1,
    header: [
      '// INV-01 描述由门控构造：守住位置 函数；改错故障 关闭后仍宣传工作流。',
      '// INV-02 缺省视为开启：守住位置 严格相等判断；改错故障 既有调用方行为变化。',
      '// INV-03 工作流句式仅一条：守住位置 数组末尾；改错故障 多代理编排被误导向工作流。',
      '// INV-04 描述烘焙一次：守住位置 模块常量；改错故障 每次调用重建长字符串。',
      '// INV-05 子代理端口缺失报配置错：守住位置 空值判断；改错故障 运行期空指针。',
      '// INV-06 错误带稳定码：守住位置 错误码字段；改错故障 界面无法区分禁用与失败。',
      '// INV-07 缺省代理类型：守住位置 空值合并；改错故障 派发无类型。',
      '// INV-08 父工具调用带下去：守住位置 请求字段；改错故障 子代理无法回链。',
      '// INV-09 可读输出文件只影响文案：守住位置 布尔字段；改错故障 权限被文案左右。',
      '// INV-10 后台模式透传：守住位置 布尔转换；改错故障 显式 false 被当未传。',
      '// INV-11 模型覆盖优先：守住位置 展开顺序；改错故障 覆盖被父模型盖住。',
      '// INV-12 同步结果附用量：守住位置 格式化分支；改错故障 模型不知道子代理成本。',
      '// INV-13 后台提醒不要读文件：守住位置 文案；改错故障 模型反复读取输出。',
      '// INV-14 输出结构非法原样回退：守住位置 schema 判断；改错故障 结果丢失。',
      '// INV-15 工具只读但副作用在子会话：守住位置 元数据；改错故障 据此认为派发无副作用。',
      '// INV-16 超时设为无：守住位置 声明；改错故障 长跑子代理被误杀。',
      '// INV-17 权限只匹配输入：守住位置 模式来源；改错故障 规则误命中工具名。',
      '// INV-18 Task 复用 Agent 实现：守住位置 同一实现；改错故障 两套逻辑漂移。',
      '//',
      '// 模块职责：Agent 工具入口，把输入转译成子代理派发请求。',
      '// 状态所有权：子运行时归端口，本文件只构造请求与声明契约。',
      '// 阅读顺序：先看描述构造，再看处理器，最后看入口声明与别名。',
    ],
    blocks: [
      {
        anchor: 'function buildAgentProviderDescription(',
        lines: [
          '基础描述固定。',
          '工作流句受门控。',
          '缺省保留该句。',
          '显式关闭才删除。',
          '结果按行拼接。',
          '不读运行时状态。',
        ],
      },
      {
        anchor: 'const agentHandler: ToolHandler = async (input, context) => {',
        lines: [
          '先校验输入。',
          '缺省通用代理。',
          '无端口报配置错。',
          '请求带父调用链。',
          '覆盖优先于继承。',
        ],
      },
      {
        anchor: 'function formatAgentOutputForModel(output: unknown): string {',
        lines: [
          '结构非法原样返回。',
          '同步结果附用量。',
          '无输出给占位。',
          '后台提醒等通知。',
          '可读文件才给路径。',
        ],
      },
      {
        anchor: 'export function createAgentToolEntry(',
        lines: [
          '复用基础条目。',
          '只替换描述。',
          '门控原样传入。',
          '返回新对象。',
          '不共享可变状态。',
        ],
      },
    ],
  },
  {
    file: 'apps/zcode-cli/packages/tui/src/app-effort-suggestion-panel.tsx',
    target: 41,
    header: [
      '// INV-01 可见窗口由父层给出：守住位置 入参；改错故障 本组件二次过滤。',
      '// INV-02 空候选仍渲染占位：守住位置 三元；改错故障 面板高度跳动。',
      '// INV-03 面板高度按行数：守住位置 计算；改错故障 六行窗口错位。',
      '// INV-04 内容宽异常回退八十：守住位置 归一化；改错故障 窄终端布局崩。',
      '// INV-05 内容宽下限十二列：守住位置 取大值；改错故障 文字被压没。',
      '// INV-06 detail 上限六成五：守住位置 比例常量；改错故障 标题被挤掉。',
      '// INV-07 标题至少保留四列：守住位置 预算公式；改错故障 标题截成空。',
      '// INV-08 选择符宽度固定：守住位置 常量；改错故障 两行文字错位。',
      '// INV-09 当前项只标记不选中：守住位置 参数用途；改错故障 选中态被覆盖。',
      '// INV-10 detail 三段拼接：守住位置 过滤连接；改错故障 出现多余空格。',
      '// INV-11 别名仅在与标识不同时出现：守住位置 比较；改错故障 重复显示同一名。',
      '// INV-12 空 detail 不渲染间隔：守住位置 条件；改错故障 右侧留白。',
      '// INV-13 行键用候选标识：守住位置 键属性；改错故障 选中跳动。',
      '// INV-14 选中色仅两处：守住位置 样式分支；改错故障 整行高亮刺眼。',
      '// INV-15 截断按显示宽度：守住位置 工具函数；改错故障 中文宽度算错。',
      '// INV-16 行高恒为一行：守住位置 常量；改错故障 换行破坏对齐。',
      '// INV-17 面板宽度占满：守住位置 样式；改错故障 边框不齐。',
      '// INV-18 占位文案用警告色：守住位置 颜色常量；改错故障 空态不易察觉。',
      '//',
      '// 模块职责：effort 建议面板的单行拟合与渲染。',
      '// 状态所有权：可见窗口与选中态归父层，本件只做布局。',
      '// 阅读顺序：先看面板装配，再看单行渲染，最后看宽度拟合。',
    ],
    blocks: [
      {
        anchor: 'export function EffortSuggestionPanel({',
        lines: [
          '可见窗口由父层给出。',
          '空候选仍占一行。',
          '面板高度按行数。',
          '内容宽先归一化。',
          '纯展示不持状态。',
        ],
      },
      {
        anchor: 'function EffortSuggestionRow({',
        lines: [
          '选择符固定宽。',
          '标题宽按显示列。',
          'detail 为空不画间隔。',
          '选中色只用于两处。',
          '行高恒为一行。',
        ],
      },
      {
        anchor: 'function fitEffortOptionRow(',
        lines: [
          '先算 detail 预算。',
          '截断后量宽度。',
          '剩余宽度给标题。',
          '标题至少一列。',
          '返回拟合后的三段。',
        ],
      },
      {
        anchor: 'function detailColumnBudget(detail: string, contentWidth: number): number {',
        lines: [
          '无 detail 返回零。',
          '取比例上限。',
          '与最小标题宽取小。',
          '结果不为负。',
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
  fs.writeFileSync(`ZC-deep-b137-spec-${index}.json`, JSON.stringify({ files: [{ file: spec.file, items }] }, null, 2), 'utf8');
  console.log(`spec ${index}: ${spec.file} lines=${total}`);
  index += 1;
}
