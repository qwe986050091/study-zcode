import fs from 'node:fs';

const specs = [
  {
    file: 'apps/zcode-cli/packages/core/src/tool/handlers/grep.ts',
    target: 44,
    firstNth: 1,
    header: [
      '// INV-01 缺少端口即配置错误：守住位置 端口判断；改错故障 搜索静默返回空结果。',
      '// INV-02 路径先走工作区校验：守住位置 路径解析；改错故障 越界读取仓外文件。',
      '// INV-03 缺省路径用工具工作目录：守住位置 三元分支；改错故障 相对路径落到进程目录。',
      '// INV-04 上下文短选项可覆盖统一值：守住位置 空值合并；改错故障 上下文参数被忽略。',
      '// INV-05 取消转可恢复错误：守住位置 错误码判断；改错故障 用户中断被记成工具失败。',
      '// INV-06 其余错误原样上抛：守住位置 末尾抛出；改错故障 根因被包装丢失。',
      '// INV-07 三种输出互斥：守住位置 模式分支；改错故障 列表与正文同时回填。',
      '// INV-08 文件列表仅在路径模式：守住位置 条件赋值；改错故障 内容模式重复列出文件。',
      '// INV-09 计数模式按路径聚合：守住位置 模板拼接；改错故障 计数行缺少文件前缀。',
      '// INV-10 行号默认开启：守住位置 空值合并；改错故障 内容模式默认没有行号。',
      '// INV-11 展示路径优先相对：守住位置 相对判断；改错故障 结果里全是绝对路径。',
      '// INV-12 路径分隔符统一斜杠：守住位置 替换调用；改错故障 Windows 结果链接失效。',
      '// INV-13 截断不视为失败：守住位置 字段透传；改错故障 分页信息丢失。',
      '// INV-14 超时不可被调用覆盖：守住位置 覆盖标志；改错故障 全仓扫描被拉长。',
      '// INV-15 大结果落盘只预览头部：守住位置 预算配置；改错故障 模型上下文被撑爆。',
      '// INV-16 权限为只读且免审批：守住位置 描述字段；改错故障 每次搜索都要确认。',
      '// INV-17 文案按模式分别组装：守住位置 格式化函数；改错故障 空结果显示错误提示。',
      '// INV-18 复数按数量选择：守住位置 辅助函数；改错故障 一条结果写成复数。',
      '//',
      '// 模块职责：Grep 工具的输入归一、端口调用与模型可见文案。',
      '// 状态所有权：无状态，文件系统能力由上下文注入。',
      '// 阅读顺序：先看参数与路径，再看端口调用与输出组装，最后看工具元数据与文案。',
    ],
    blocks: [
      {
        anchor: 'export const grepHandler: ToolHandler = async (input, context) => {',
        lines: [
          '输入先经结构校验。',
          '端口缺席直接抛配置错误。',
          '显式路径做边界校验。',
          '缺省路径取工具工作目录。',
          '上下文短选项回退到统一值。',
        ],
      },
      {
        anchor: 'const searchPath = parsed.path',
        lines: [
          '端口只看到展开后的数值。',
          '追踪上下文原样透传。',
          '中止信号直接下传。',
          '取消翻译为可恢复错误。',
          '其他错误不包装。',
          '结果不做二次过滤。',
        ],
      },
      {
        anchor: 'const output: GrepOutput = {',
        lines: [
          '文件列表只在路径模式回填。',
          '内容模式拼接匹配行。',
          '计数模式拼成路径与数量。',
          '匹配总数三种模式都回填。',
          '截断与分页字段原样透传。',
        ],
      },
      {
        anchor: 'export const grepToolEntry: ToolEntry = {',
        lines: [
          '只读且并发安全。',
          '不进入审批流程。',
          '超时上下限相同且禁止覆盖。',
          '结果超预算落盘。',
          '预览只取头部。',
          '权限理由说明无副作用。',
        ],
      },
    ],
  },
  {
    file: 'apps/zcode-cli/packages/core/src/runtime/methods/workspace-generate-text.ts',
    target: 43,
    header: [
      '// INV-01 不创建回合：守住位置 不写消息历史；改错故障 辅助调用污染对话。',
      '// INV-02 流必须见完成事件：守住位置 完成标志；改错故障 半截响应当成功。',
      '// INV-03 错误事件即抛：守住位置 事件分支；改错故障 失败被流吞掉。',
      '// INV-04 探测只用一 token：守住位置 绑定上限；改错故障 连通性检查白等推理。',
      '// INV-05 探测提示词固定：守住位置 常量；改错故障 探测混入会话内容。',
      '// INV-06 无信号才加超时：守住位置 空值合并；改错故障 覆盖调用方更短的中止。',
      '// INV-07 辅助档位只给提交信息：守住位置 来源判断；改错故障 其他调用被降档。',
      '// INV-08 输入非空才请求：守住位置 校验函数；改错故障 空请求打到提供者。',
      '// INV-09 请求事件先落盘：守住位置 追加顺序；改错故障 失败时看不到发起内容。',
      '// INV-10 消息先复制再发：守住位置 映射复制；改错故障 上游改写影响记账。',
      '// INV-11 usage 从事件切片：守住位置 起始下标；改错故障 归因混入历史事件。',
      '// INV-12 失败也记 usage 再抛：守住位置 捕获分支；改错故障 失败被改写成成功。',
      '// INV-13 完成事件只在成功发：守住位置 调用位置；改错故障 失败也发完成事件。',
      '// INV-14 回显调用方选择：守住位置 返回值；改错故障 调用方误判档位被改写。',
      '// INV-15 预算只认调用方提供：守住位置 来源判断；改错故障 伪造固定上限。',
      '// INV-16 遥测独立于回合：守住位置 分离上报器；改错故障 面板出现悬空操作。',
      '// INV-17 取消与失败分开归因：守住位置 中止判断；改错故障 用户取消被记成失败。',
      '// INV-18 遥测收尾必执行：守住位置 两条完成路径；改错故障 异常时没有结束事实。',
      '//',
      '// 模块职责：工作区级一次性文本生成与模型连通性探测。',
      '// 状态所有权：不持有状态，仅向会话事件流追加请求与完成事实。',
      '// 阅读顺序：先看连通性探测，再看生成包装与遥测，最后看实现细节。',
    ],
    blocks: [
      {
        anchor: 'export async function testModelConnectivity(',
        lines: [
          '模型按最低公开档位绑定。',
          '输出上限固定为一。',
          '子追踪带提供者与模型。',
          '无信号时用一次性超时。',
          '未见到完成事件即失败。',
        ],
      },
      {
        anchor: 'export async function generateWorkspaceText(',
        lines: [
          '入口先校验输入。',
          '遥测按来源分操作名。',
          '成功记文本结果。',
          '中止记取消。',
          '其他异常记失败后重抛。',
        ],
      },
      {
        anchor: 'async function generateWorkspaceTextImpl(',
        lines: [
          '只有提交信息走辅助档位。',
          '请求事件先追加。',
          '事件数组同时供归因。',
          '失败路径先记账再抛。',
          '成功路径先发完成事件再记账。',
        ],
      },
      {
        anchor: 'const modelRequest = {',
        lines: [
          '预算只来自调用方。',
          '未提供时不带选项。',
          '工具列表缺省为空。',
          '消息为独立副本。',
          '中止信号随请求下发。',
          '模型只看展开后的选项。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/lib/modelConfigSync.ts',
    target: 41,
    header: [
      '// INV-01 前缀不匹配即空：守住位置 前缀判断；改错故障 普通供应商被当自定义。',
      '// INV-02 标识先裁剪：守住位置 去空白；改错故障 前后空格导致匹配失败。',
      '// INV-03 前缀后为空返回空：守住位置 或运算；改错故障 生成空提供者标识。',
      '// INV-04 幽灵键需两段分隔：守住位置 分隔符查找；改错故障 残缺键解析出错误标识。',
      '// INV-05 解码失败用原文：守住位置 捕获分支；改错故障 异常中断配置刷新。',
      '// INV-06 身份段按逗号切分：守住位置 映射裁剪；改错故障 提供者字段读不到。',
      '// INV-07 只认提供者字段：守住位置 前缀判断；改错故障 其他身份段被误当提供者。',
      '// INV-08 活动任务提供者优先：守住位置 选择顺序；改错故障 设置页同步到错误范围。',
      '// INV-09 乐观表优先于缓存：守住位置 空值合并；改错故障 刚切换的模型回退旧值。',
      '// INV-10 无活动任务用当前选择：守住位置 早退分支；改错故障 空任务把范围清空。',
      '// INV-11 自定义供应商必用模型键：守住位置 条件判断；改错故障 保存后刷新丢失供应商。',
      '// INV-12 同提供者沿用已选供应商：守住位置 相等判断；改错故障 纯模型名被误判为原生。',
      '// INV-13 无模型值退回原生键：守住位置 末尾分支；改错故障 返回空供应商键。',
      '// INV-14 模型选项只认下拉：守住位置 类别与类型双判断；改错故障 读到错误配置项。',
      '// INV-15 空模型值视为缺失：守住位置 长度判断；改错故障 空串被当成有效模型。',
      '// INV-16 自定义值需同提供者：守住位置 标识比较；改错故障 跨提供者套用模型名。',
      '// INV-17 模型名需在清单内：守住位置 包含判断；改错故障 返回已下线的模型。',
      '// INV-18 无法确定返回空：守住位置 末尾返回；改错故障 调用方拿到错误默认值。',
      '//',
      '// 模块职责：设置页与工作区模型配置之间的供应商作用域同步。',
      '// 状态所有权：无状态，快照与选项由调用方传入。',
      '// 阅读顺序：先看供应商键解析，再看作用域推导，最后看模型名解析。',
    ],
    blocks: [
      {
        anchor: 'export function parseCustomProviderIdFromSupplierKey(supplierKey: string): string | null {',
        lines: [
          '自定义前缀直接取余下部分。',
          '幽灵键要找到第二段分隔。',
          '身份串先尝试解码。',
          '逗号分段后找提供者字段。',
          '找不到返回空。',
        ],
      },
      {
        anchor: 'function resolveActiveTaskProvider(',
        lines: [
          '无活动任务返回空。',
          '乐观更新优先。',
          '其次查任务缓存。',
          '都找不到返回空。',
          '结果用于范围推导。',
        ],
      },
      {
        anchor: 'export function resolveWorkspaceModelConfigSyncScope(',
        lines: [
          '无活动任务沿用当前选择。',
          '自定义模型键直接采用。',
          '同提供者时沿用已选供应商。',
          '其余用模型推导的键。',
          '都没有则退回原生键。',
        ],
      },
      {
        anchor: 'export function resolveModelNameForConfigSync(params: {',
        lines: [
          '自定义值需提供者一致。',
          '模型名需在清单内。',
          '原始值也可直接匹配。',
          '不匹配返回空。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/lib/chatErrorBannerTelemetry.ts',
    target: 42,
    firstNth: 1,
    header: [
      '// INV-01 事件名与分组固定：守住位置 导出常量；改错故障 看板找不到事件。',
      '// INV-02 敏感文本整段替换：守住位置 正则判断；改错故障 认证头进入遥测。',
      '// INV-03 脱敏只影响副本：守住位置 独立变量；改错故障 界面显示被替换文案。',
      '// INV-04 空值直接丢弃：守住位置 裁剪判断；改错故障 出现空字段。',
      '// INV-05 截断上限固定：守住位置 常量；改错故障 上报正文超长。',
      '// INV-06 内部自动恢复不上报动作：守住位置 提前返回；改错故障 内部重试被当成可见恢复。',
      '// INV-07 非业务错误不报动作：守住位置 码判断；改错故障 普通错误带恢复按钮。',
      '// INV-08 键片段裁剪并替换空白：守住位置 归一函数；改错故障 键含冒号破坏结构。',
      '// INV-09 键片段长度上限：守住位置 切片；改错故障 维度基数失控。',
      '// INV-10 缺失字段给固定兜底：守住位置 空值分支；改错故障 聚合出现空维度。',
      '// INV-11 指纹不含完整正文：守住位置 拼接内容；改错故障 上报正文被放大。',
      '// INV-12 指纹用稳定哈希：守住位置 哈希函数；改错故障 同一错误每次键不同。',
      '// INV-13 键结构固定六段：守住位置 数组拼接；改错故障 下游解析错位。',
      '// INV-14 详情字段只报存在性：守住位置 布尔取值；改错故障 完整详情被上传。',
      '// INV-15 来源与原因统一解析：守住位置 归因函数；改错故障 各面板口径不一致。',
      '// INV-16 提供者范围归一：守住位置 共享函数；改错故障 自定义提供者泄露标识。',
      '// INV-17 上报失败只告警：守住位置 捕获分支；改错故障 遥测失败影响聊天。',
      '// INV-18 上报出口固定 ARMS：守住位置 调用点；改错故障 错误进入业务数仓。',
      '//',
      '// 模块职责：聊天错误横幅的遥测负载组装与 ARMS 上报。',
      '// 状态所有权：无状态，平台能力与错误对象由调用方注入。',
      '// 阅读顺序：先看脱敏与截断，再看恢复动作判定，最后看负载与上报。',
    ],
    blocks: [
      {
        anchor: 'function sanitizeUnderlyingTelemetryText(value: string | undefined): string | undefined {',
        lines: [
          '空值直接返回空。',
          '敏感模式整体替换。',
          '其余走截断。',
          '不修改原错误对象。',
          '只用于上报副本。',
        ],
      },
      {
        anchor: 'export function resolveVisibleChatErrorTelemetryRecoveryAction(',
        lines: [
          '内部验证码优先留空。',
          '非业务码返回空。',
          '有界面动作才返回。',
          '返回动作与业务码。',
          '供聚合维度使用。',
        ],
      },
      {
        anchor: 'function resolveErrorKey(params: {',
        lines: [
          '各片段先归一。',
          '缺失给固定兜底。',
          '指纹拼接结构化字段。',
          '只保留短哈希。',
          '六段用冒号连接。',
        ],
      },
      {
        anchor: 'export function buildChatErrorBannerTelemetryPayload(params: {',
        lines: [
          '展示文案先截断。',
          '底层错误走脱敏。',
          '详情只报存在性。',
          '提供者与模型统一归一。',
          '来源与阶段来自归因。',
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
  fs.writeFileSync(`ZC-deep-b129-spec-${index}.json`, JSON.stringify({ files: [{ file: spec.file, items }] }, null, 2), 'utf8');
  console.log(`spec ${index}: ${spec.file} lines=${total}`);
  index += 1;
}
