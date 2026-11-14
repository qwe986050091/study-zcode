import fs from 'node:fs';

const specs = [
  {
    file: 'packages/provider-node/src/legacy-reasoning-level-renames.ts',
    target: 39,
    header: [
      '// INV-01 改名清单是纯数据：守住位置 模块顶层；改错故障 迁移逻辑散落到读取路径。',
      '// INV-02 精确正则匹配原名：守住位置 modelMatch；改错故障 相近型号被误迁移档位。',
      '// INV-03 简化正则只作兜底：守住位置 simplifiedModelMatch；改错故障 精确匹配失效。',
      '// INV-04 旧档位只认一个值：守住位置 oldLevel；改错故障 其他档位被顺手改写。',
      '// INV-05 新档位统一为默认：守住位置 迁移后取值；改错故障 迁移后残留旧语义。',
      '// INV-06 一个型号一条记录：守住位置 数组结构；改错故障 合并条目难以排查。',
      '// INV-07 版本段允许后缀：守住位置 后缀分组；改错故障 带渠道后缀的型号漏迁移。',
      '// INV-08 分隔符集合固定：守住位置 字符类；改错故障 新渠道前缀不被识别。',
      '// INV-09 大小写按原样保留：守住位置 正则字面；改错故障 大小写归一误伤其他型号。',
      '// INV-10 型号名不参与猜测：守住位置 匹配方式；改错故障 新模型被误判为旧模型。',
      '// INV-11 顺序不影响结果：守住位置 消费方；改错故障 命中依赖数组顺序产生歧义。',
      '// INV-12 表只为迁移存在：守住位置 使用点；改错故障 新选型也走旧档位。',
      '// INV-13 常量断言保证只读：守住位置 末尾断言；改错故障 运行时被追加条目。',
      '// INV-14 缺省档位不在表内：守住位置 数据；改错故障 正常档位也被认为需要迁移。',
      '// INV-15 命中即可停止遍历：守住位置 消费方；改错故障 多次迁移叠加改写。',
      '// INV-16 未命中保持原样：守住位置 消费方；改错故障 未列型号被清空档位。',
      '// INV-17 新增型号只加数据：守住位置 维护方式；改错故障 每次新增都要改迁移代码。',
      '// INV-18 表结构无副作用：守住位置 导入；改错故障 加载即触发 IO。',
      '//',
      '// 模块职责：集中维护旧推理档位到默认档位的型号改名表。',
      '// 状态所有权：只读常量；无运行时状态。',
      '// 阅读顺序：先看首条记录的字段含义，其余条目形状一致。',
    ],
    blocks: [
      {
        anchorLine: 9,
        lines: [
          '该型号旧档位为非思考。',
          '迁移后回到默认档位。',
          '版本后缀由分组吸收。',
          '大小写与原文一致才命中。',
        ],
      },
      {
        anchorLine: 34,
        lines: [
          '同一系列按变体逐条列出。',
          '精确正则限定版本边界。',
          '简化正则用于宽松兜底。',
          '两条正则必须能互相覆盖主要写法。',
        ],
      },
      {
        anchorLine: 64,
        lines: [
          '新条目直接追加即可。',
          '不需要改动消费方逻辑。',
          '旧档位字段是迁移的唯一输入。',
        ],
      },
      {
        anchorLine: 84,
        lines: [
          '命中后只改档位不改型号。',
          '未命中条目原样穿过。',
          '列表顺序不参与匹配判定。',
        ],
      },
      {
        anchorLine: 109,
        lines: [
          '视觉型号同样适用该规则。',
          '渠道后缀在边界分组之外。',
          '新增变体时复制同组写法。',
        ],
      },
    ],
  },
  {
    file: 'packages/provider-node/src/provider-config-file-codec.ts',
    target: 39,
    header: [
      '// INV-01 版本号是文件第一道门：守住位置 解码入口；改错故障 无版本文件被当成当前格式。',
      '// INV-02 高版本直接拒绝：守住位置 比较分支；改错故障 新客户端文件被旧端静默降级。',
      '// INV-03 迁移逐级推进：守住位置 while 循环；改错故障 跨版本跳步产生错误结构。',
      '// INV-04 缺迁移器即报错：守住位置 映射查找；改错故障 用当前 schema 强解旧文件。',
      '// INV-05 迁移必须递增恰好一级：守住位置 校验；改错故障 迁移器原地打转导致死循环。',
      '// INV-06 落盘 schema 为 strict：守住位置 顶层与 config；改错故障 未知字段被带进内存。',
      '// INV-07 规则字段先接 unknown：守住位置 解码；改错故障 个性化规则无法兼容历史形状。',
      '// INV-08 版本错误类型专用：守住位置 异常类；改错故障 调用方无法区分损坏与版本不支持。',
      '// INV-09 版本字段必须非负整数：守住位置 读取器；改错故障 字符串版本被强转。',
      '// INV-10 缺版本与非法版本区分：守住位置 两个错误消息；改错故障 排障时分不清原因。',
      '// INV-11 旧手动规则就地归一：守住位置 map 回调；改错故障 单个旧规则阻断整份配置。',
      '// INV-12 现行形状优先放行：守住位置 早退；改错故障 合法配置被多余提取改写。',
      '// INV-13 只认两种旧形状：守住位置 联合校验；改错故障 未知形状被删字段伪装成功。',
      '// INV-14 提取只取可编辑字段：守住位置 转换；改错故障 隐藏字段重新回流。',
      '// INV-15 编码只写当前版本：守住位置 常量；改错故障 保存出未来版本号。',
      '// INV-16 可选字段缺省即省略：守住位置 展开；改错故障 空对象覆盖上层默认值。',
      '// INV-17 编码输出即为可序列化结构：守住位置 返回；改错故障 类实例直接落盘。',
      '// INV-18 读与写共用同一常量：守住位置 版本引用；改错故障 读写版本漂移。',
      '//',
      '// 模块职责：个人 Provider 配置文件的版本解码、迁移与编码。',
      '// 状态所有权：迁移表为模块常量；解码过程全部局部变量。',
      '// 阅读顺序：先看落盘 schema 与异常类，再看解码，最后看旧规则归一与编码。',
    ],
    blocks: [
      {
        anchor: 'const storedProviderConfigSchema = z',
        lines: [
          '顶层与 config 都是严格对象。',
          '四种规则字段全部必填。',
          '默认选择可缺省。',
          '未知键在解析期即报错。',
        ],
      },
      {
        anchor: 'export class UnsupportedProviderConfigVersionError extends Error {',
        lines: [
          '版本缺失时字段为 null。',
          '异常名固定便于跨进程识别。',
          '消息保留原始版本值。',
          '调用方可据此提示升级客户端。',
        ],
      },
      {
        anchor: 'export function decodeProviderConfigFile(input: unknown): ProviderConfigLayerUpdate {',
        lines: [
          '解码全程只读不写盘。',
          '返回对象整体冻结。',
          '可选默认选择按存在性展开。',
        ],
      },
      {
        anchor: 'function normalizeLegacyManualRules(input: unknown): unknown {',
        lines: [
          '非对象与非数组原样返回。',
          '逐条规则独立判定。',
          '现行形状直接跳过。',
        ],
      },
      {
        anchor: 'export function encodeProviderConfigFile(update: ProviderConfigLayerUpdate) {',
        lines: [
          '输出只含当前版本号。',
          '顺序字段可选写入。',
          '规则序列化交给模型对象。',
        ],
      },
    ],
  },
  {
    file: 'packages/shared/src/channel-mention.ts',
    target: 39,
    header: [
      '// INV-01 提及目标只认 open_id：守住位置 targetId 正则；改错故障 其他平台标识混入。',
      '// INV-02 渠道枚举固定两种：守住位置 channel；改错故障 未知渠道被当作合法。',
      '// INV-03 提及结构 strict：守住位置 object；改错故障 多余字段被静默保留。',
      '// INV-04 内容片段有双上限：守住位置 parts 数量；改错故障 超长消息拖垮渲染。',
      '// INV-05 文本片段限制十万字：守住位置 text；改错故障 超大文本占用内存。',
      '// INV-06 回复文本限制两千字：守住位置 reply 文本；改错故障 超出平台发送上限。',
      '// INV-07 回复至少一段：守住位置 min；改错故障 空回复被发成空消息。',
      '// INV-08 回复至多五十段：守住位置 max；改错故障 分段爆炸触发限流。',
      '// INV-09 提及名未解析即报错：守住位置 resolve；改错故障 模型自造引用被直接信任。',
      '// INV-10 引用必须来自已验证输入：守住位置 targets 构造；改错故障 模型可注入任意目标。',
      '// INV-11 同引用冲突即报错：守住位置 比较；改错故障 同名引用指向两个目标。',
      '// INV-12 引用缺失即报错：守住位置 查找；改错故障 空目标进入发送链。',
      '// INV-13 解析后再次校验长度：守住位置 末尾判断；改错故障 展开后超长仍被发送。',
      '// INV-14 纯空白视为空回复：守住位置 trim；改错故障 只有空格的消息被发出。',
      '// INV-15 澄清候选项限十个：守住位置 max；改错故障 长候选列表刷屏。',
      '// INV-16 未解决项至少一条：守住位置 min；改错故障 空澄清结果被当成失败。',
      '// INV-17 澄清原因四选一：守住位置 reason；改错故障 新原因直通到前端未知分支。',
      '// INV-18 Host 请求在基础请求上扩展：守住位置 extend；改错故障 两套请求形状分叉。',
      '//',
      '// 模块职责：定义渠道提及、回复片段与澄清结果的校验形状。',
      '// 状态所有权：纯 schema 与纯函数；不持有会话状态。',
      '// 阅读顺序：先看提及与内容片段，再看回复请求，最后看解析函数。',
    ],
    blocks: [
      {
        anchor: 'export const channelMentionSchema = z',
        lines: [
          '引用标识与展示名等长约束。',
          '渠道与实体类型都是枚举。',
          '目标标识必须匹配 open_id 形状。',
          '多余字段在解析期报错。',
        ],
      },
      {
        anchor: 'export const channelReplyPartsSchema = z',
        lines: [
          '三种片段共用同一数组。',
          '文本与引用各自限长。',
          '提及名可带候选引用。',
          '段数上下限同时约束。',
        ],
      },
      {
        anchor: 'export const channelReplyRequestSchema = z',
        lines: [
          '任务与工具调用标识必填。',
          '授权标识可缺省。',
          '片段形状复用回复 schema。',
        ],
      },
      {
        anchor: 'export function channelContentText(parts: readonly ChannelContentPart[]): string {',
        lines: [
          '文本原样保留。',
          '提及时以 at 加名称展开。',
          '拼接不加分隔符。',
        ],
      },
      {
        anchor: 'export function resolveChannelReplyParts(',
        lines: [
          '先收集已校验来源中的提及。',
          '冲突检测以整条记录为准。',
          '模型给出的名称一律拒绝。',
        ],
      },
    ],
  },
  {
    file: 'packages/shared/src/rendererActionTrace.ts',
    target: 39,
    header: [
      '// INV-01 采样上限为两成：守住位置 常量与 schema；改错故障 全量采集压垮主线程。',
      '// INV-02 单批跨度上限三十二：守住位置 max；改错故障 大批次阻塞 IPC。',
      '// INV-03 单批字节上限 256K：守住位置 常量；改错故障 序列化超时。',
      '// INV-04 分组是封闭枚举：守住位置 group schema；改错故障 拼写错误的分组被放行。',
      '// INV-05 配置 strict 且版本必填：守住位置 config schema；改错故障 无法判断配置是否更新。',
      '// INV-06 关闭态配置固定：守住位置 常量；改错故障 关闭仍带非零采样比。',
      '// INV-07 十六进制标识有定长：守住位置 两个正则；改错故障 非法 traceId 进入后端。',
      '// INV-08 属性字段全部白名单：守住位置 attributes schema；改错故障 任意键被当维度上报。',
      '// INV-09 属性值限长且去空白：守住位置 bounded 正则；改错故障 高基数文本撑爆聚合。',
      '// INV-10 动作标识用 uuid：守住位置 action_id；改错故障 同一动作无法去重。',
      '// INV-11 时间必须单调：守住位置 superRefine；改错故障 负时长跨度污染统计。',
      '// INV-12 跨度名固定为 ui_action：守住位置 literal；改错故障 后端无法按名聚合。',
      '// INV-13 资源名与服务名一致：守住位置 literal；改错故障 多端数据混在同一服务名下。',
      '// INV-14 环境枚举三选一：守住位置 enum；改错故障 生产数据被标成测试。',
      '// INV-15 批次序号非负整数：守住位置 sequence；改错故障 丢批检测失效。',
      '// INV-16 丢弃计数单列：守住位置 droppedSinceLastFlush；改错故障 丢样本无法归因。',
      '// INV-17 资源实例与批次一致：守住位置 superRefine；改错故障 跨实例样本被合并。',
      '// INV-18 批次版本固定为一：守住位置 literal；改错故障 新旧协议无法区分。',
      '//',
      '// 模块职责：定义渲染进程动作追踪的配置、跨度与批次协议。',
      '// 状态所有权：纯 schema 与常量；无运行时状态。',
      '// 阅读顺序：先看常量与分组，再看属性与跨度，最后看批次交叉校验。',
    ],
    blocks: [
      {
        anchor: 'export const RENDERER_ACTION_TRACE_SERVICE_NAME = "zcode-desktop-renderer";',
        lines: [
          '服务名是后端聚合主键。',
          '采样比上限与 schema 共用同一常量。',
          '跨度数与字节数分别设限。',
          '常量改动需同步采集端。',
        ],
      },
      {
        anchor: 'export const rendererActionTraceConfigSchema = z',
        lines: [
          '启用位为必填布尔。',
          '本地首帧开关可缺省。',
          '分组列表最多六项。',
          '配置版本用于识别变更。',
        ],
      },
      {
        anchor: 'export const rendererActionTraceAttributesSchema = z',
        lines: [
          '功能与动作使用受限标识。',
          '结果来源与失败阶段可选。',
          '工作区形态区分本地与远程。',
        ],
      },
      {
        anchor: 'export const rendererActionTraceSpanSchema = z',
        lines: [
          '跨度标识两种定长十六进制。',
          '名称固定为界面动作。',
          '起止时间必须非负。',
        ],
      },
      {
        anchor: 'export const rendererActionTraceBatchSchema = z',
        lines: [
          '实例标识同时出现在两处。',
          '跨度数组受上限约束。',
          '交叉校验保证资源与批次一致。',
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
    const anchor =
      block.anchorLine === undefined
        ? block.anchor
        : srcLines[block.anchorLine - 1].replace(/\r$/, '').trim();
    items.push({ anchor, lines: block.lines });
  }
  const total = spec.header.length + spec.blocks.reduce((n, b) => n + b.lines.length, 0);
  if (total !== spec.target) {
    console.error(`TARGET MISMATCH ${spec.file}: ${total} != ${spec.target}`);
    process.exit(1);
  }
  fs.writeFileSync(
    `ZC-deep-b145-spec-${index}.json`,
    JSON.stringify({ files: [{ file: spec.file, items }] }, null, 2),
    'utf8',
  );
  console.log(`spec ${index}: ${spec.file} lines=${total}`);
  index += 1;
}
