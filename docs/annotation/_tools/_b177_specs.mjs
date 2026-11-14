import fs from 'node:fs';

const specs = [
  {
    file: 'docs/knip/docs/scripts/get-monthly-sponsorships-opencollective.ts',
    target: 35,
    header: [
      '// INV-01 令牌只从环境读取：守住位置 模块常量；改错故障 令牌出现在源码里。',
      '// INV-02 月度键统一为年月：守住位置 切片格式；改错故障 跨时区落到相邻月。',
      '// INV-03 起点到当前逐月建零：守住位置 循环步进；改错故障 早期月份缺失。',
      '// INV-04 循环步进用月构造：守住位置 新建日期；改错故障 月末溢出跳月。',
      '// INV-05 交易只取贷方：守住位置 查询参数；改错故障 支出被重复计入。',
      '// INV-06 周期口径只认贡献类型：守住位置 种类比较；改错故障 一次性赞助混入周期统计。',
      '// INV-07 金额按整数累积：守住位置 取整函数；改错故障 浮点误差累积。',
      '// INV-08 缺失月份从零起算：守住位置 空值兜底；改错故障 累加得到非数字。',
      '// INV-09 支出仅非周期模式计入：守住位置 布尔判断；改错故障 周期统计混入支出。',
      '// INV-10 欧元支出按固定汇率折算：守住位置 币种判断；改错故障 币种混算。',
      '// INV-11 支出金额由分转元：守住位置 除法；改错故障 支出被放大一百倍。',
      '// INV-12 汇率是常量而非实时：守住位置 常量定义；改错故障 每次运行结果漂移。',
      '// INV-13 缺令牌立即失败：守住位置 入口抛错；改错故障 携带空令牌请求。',
      '// INV-14 生成器接收显式令牌：守住位置 参数合并；改错故障 内部再读环境绕过测试。',
      '// INV-15 输出按闭区间裁剪：守住位置 起止月份比较；改错故障 边界外的月份留在结果里。',
      '// INV-16 未给结束月份则开放右端：守住位置 可选判断；改错故障 只保留起始月。',
      '// INV-17 输出保持插入顺序：守住位置 映射迭代；改错故障 表格月份乱序。',
      '// INV-18 查询字段与接口一一对应：守住位置 查询文本；改错故障 解析出未定义字段。',
      '//',
      '// 模块职责：从 Open Collective 拉取赞助与支出，汇总为每月的净额。',
      '// 状态所有权：无状态；数据只在调用期间存在于内存映射。',
      '// 阅读顺序：先看选项与响应类型，再看月度汇总，最后看对外裁剪入口。',
    ],
    blocks: [
      {
        anchor: 'const getMonthlyTotals = async (options: Options): Promise<Map<string, number>> => {',
        lines: [
          '选项含显式令牌，便于测试注入。',
          '起始月为闭区间，结束月可选。',
          '周期模式只看贡献类交易。',
          '汇总结果以年月为键。',
        ],
      },
      {
        anchor: 'for (let d = new Date(startDate); d <= now; d = new Date(d.getFullYear(), d.getMonth() + 1, 1)) {',
        lines: [
          '从起始月逐月推进到当前月。',
          '每次以年月日重建日期，避免月末溢出。',
          '先给每个月建零值占位。',
        ],
      },
      {
        anchor: 'if (!recurringOnly) {',
        lines: [
          '支出只在非周期模式计入。',
          '欧元按固定汇率折算。',
          '金额以分为单位，先除后舍入。',
        ],
      },
      {
        anchor: 'export const getOpenCollectiveTotals = async (options: Options) => {',
        lines: [
          '缺少令牌时直接抛出。',
          '内部调用使用显式令牌。',
          '结果按起止月份裁剪。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/settings/offPeakUiPresentation.ts',
    target: 35,
    header: [
      '// INV-01 禁用原因三类且可空：守住位置 类型别名；改错故障 未知原因让按钮永久禁用。',
      '// INV-02 灰度关闭不参与禁用：守住位置 首个早退；改错故障 未灰度用户看不到按钮。',
      '// INV-03 加载与错误都视为暂不可用：守住位置 状态判断；改错故障 请求失败仍可点。',
      '// INV-04 无套餐优先于不可用：守住位置 判断顺序；改错故障 付费引导被错误遮住。',
      '// INV-05 非就绪态一律不可用：守住位置 兜底判断；改错故障 未知状态被放行。',
      '// INV-06 可号必须为 true：守住位置 严格相等；改错故障 未定义被当成可取号。',
      '// INV-07 剩余为非正时显示不足一分钟：守住位置 边界比较；改错故障 显示负数分钟。',
      '// INV-08 分钟向上取整：守住位置 取整函数；改错故障 低估等待时间。',
      '// INV-09 小时与分钟拆算：守住位置 除法与取模；改错故障 分钟超过六十。',
      '// INV-10 三种文案按组合选择：守住位置 分支顺序；改错故障 出现零分钟或零小时。',
      '// INV-11 文案全部走本地化：守住位置 格式化调用；改错故障 界面出现硬编码。',
      '// INV-12 提示允许换行：守住位置 样式类；改错故障 长原因被截断。',
      '// INV-13 标题仅在自动默认时跟随语言：守住位置 四条件早退；改错故障 覆盖用户输入。',
      '// INV-14 编辑中永不改写标题：守住位置 编辑判断；改错故障 输入被重置。',
      '// INV-15 草稿或已保存标题优先：守住位置 初始标题判断；改错故障 已保存任务被改名。',
      '// INV-16 状态映射唯一来源：守住位置 单一函数；改错故障 图标与文案不一致。',
      '// INV-17 带位次的排队与暂停用位次文案：守住位置 位次判断；改错故障 暂停显示成排队。',
      '// INV-18 终态不提示模型选择问题：守住位置 状态白名单；改错故障 历史任务长期报错。',
      '//',
      '// 模块职责：闲时任务的创建禁用原因、剩余时长、标题与状态展示映射。',
      '// 状态所有权：无状态；任务数据与本地化实例全部由调用方注入。',
      '// 阅读顺序：先看禁用原因，再看剩余时长与标题，最后看状态页脚与选择问题。',
    ],
    blocks: [
      {
        anchor: 'export const OFF_PEAK_CREATE_TOOLTIP_CLASSNAME =',
        lines: [
          '提示框允许换行，避免长句被截断。',
          '宽度上限防止提示横跨面板。',
          '只影响提示内部的文本节点。',
          '值与主题无关，保持常量。',
        ],
      },
      {
        anchor: 'export function resolveOffPeakCreateBlockReason({',
        lines: [
          '灰度关闭时不参与禁用判断。',
          '加载与错误都视为暂不可用。',
          '只有明确可取号才放行。',
        ],
      },
      {
        anchor: 'export function formatOffPeakRemainingWait(',
        lines: [
          '非正剩余时间显示不足一分钟。',
          '分钟向上取整，避免低估等待。',
          '小时与分钟分别给三种文案。',
        ],
      },
      {
        anchor: 'export function resolveOffPeakStatusFooter(',
        lines: [
          '状态到图标与文案只有这一处映射。',
          '排队与暂停按位次切换文案。',
          '完成与取消使用弱化色。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/v4/ackActivationBarrier.ts',
    target: 34,
    header: [
      '// INV-01 暂存按主题分组：守住位置 映射结构；改错故障 同一主题的并发订阅互相覆盖。',
      '// INV-02 暂存与订阅标识双索引：守住位置 两张映射；改错故障 写入时找不到待激活批次。',
      '// INV-03 上限同时约束条数与字节：守住位置 三重条件；改错故障 单条超大帧撑爆内存。',
      '// INV-04 越界整批清空而非截头：守住位置 溢出分支；改错故障 激活后缺片却看似完整。',
      '// INV-05 溢出原因在绑定时抛出：守住位置 绑定入口；改错故障 订阅静默成立但收不到帧。',
      '// INV-06 绑定前收到的帧留在暂存：守住位置 空标识判断；改错故障 早到帧被丢弃。',
      '// INV-07 激活只投递本订阅帧：守住位置 过滤条件；改错故障 并发订阅收到别人的帧。',
      '// INV-08 激活返回主题与前驱：守住位置 返回对象；改错故障 上层无法清理旧所有权。',
      '// INV-09 激活后移除暂存：守住位置 清理调用；改错故障 暂存批次长期滞留。',
      '// INV-10 新激活替换旧所有权：守住位置 主题映射覆盖；改错故障 两个订阅同时被视为活动。',
      '// INV-11 旧订阅标识同步移除：守住位置 反向映射删除；改错故障 旧标识仍能触发删除。',
      '// INV-12 已激活的帧直接投递：守住位置 入口判断；改错故障 活动订阅的帧被暂存。',
      '// INV-13 无待激活批次即丢弃：守住位置 分组空值检查；改错故障 建出无主暂存组。',
      '// INV-14 取消与遗忘共用清理：守住位置 统一函数；改错故障 两处清理逻辑分叉。',
      '// INV-15 遗忘同时清三种索引：守住位置 三步删除；改错故障 残留活动主题指向空订阅。',
      '// INV-16 清理释放帧引用：守住位置 长度与字节归零；改错故障 帧对象长期滞留。',
      '// INV-17 全清用于代次失效：守住位置 清空调用；改错故障 重连后旧帧被投递。',
      '// INV-18 本层只处理物理帧：守住位置 职责注释；改错故障 在暂存期做逻辑拼装。',
      '//',
      '// 模块职责：在确认到达前有界暂存订阅帧，激活后按所有权投递。',
      '// 状态所有权：待激活与活动两套索引都封闭在闭包内，不暴露给调用方。',
      '// 阅读顺序：先看上限与接口，再看创建与清理，最后看绑定、激活与接收。',
    ],
    blocks: [
      {
        anchor: 'const MAX_STAGED_FRAMES = 1024;',
        lines: [
          '条数与字节双上限。',
          '溢出原因用固定故障键。',
          '上限不随主题变化。',
        ],
      },
      {
        anchor: 'export interface AckActivationBarrier<T extends { topic: string; subscriptionId: string }> {',
        lines: [
          '令牌是不透明对象，调用方不得解构。',
          '激活返回主题与前驱标识。',
          '清除用于代次失效时整体丢弃。',
        ],
      },
      {
        anchor: 'export function createAckActivationBarrier<T extends { topic: string; subscriptionId: string }>(',
        lines: [
          '待激活按主题与标识双索引。',
          '活动订阅按主题与反向映射。',
          '投递函数由调用方注入。',
        ],
      },
      {
        anchor: 'const removePending = (pending: PendingFrameSubscription<T>): void => {',
        lines: [
          '从主题分组中摘除。',
          '分组空时删掉主题键。',
          '帧与字节同时归零。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/store/workspaceHookReviewStore.ts',
    target: 35,
    header: [
      '// INV-01 绑定按会话隔离：守住位置 记录键；改错故障 会话之间互相覆盖绑定。',
      '// INV-02 断开需发送函数身份一致：守住位置 引用比较；改错故障 旧清理删掉新连接。',
      '// INV-03 断开同时移除评审绑定：守住位置 双删除；改错故障 设置页拿到已释放客户端。',
      '// INV-04 更新前校验命令通道：守住位置 发送函数比较；改错故障 迟到回调换回旧通道。',
      '// INV-05 判定统一走单调性函数：守住位置 单一裁决源；改错故障 各处自行比较代次。',
      '// INV-06 同流过期与重放不覆盖：守住位置 判定结果分支；改错故障 回放请求回滚界面。',
      '// INV-07 同流冲突同样拒绝：守住位置 结果枚举；改错故障 两个请求互相覆盖。',
      '// INV-08 跨流接受新权威：守住位置 兜底覆盖；改错故障 旧运行时的代次永久挡住新请求。',
      '// INV-09 清除可限定交互标识：守住位置 可选参数比较；改错故障 清掉其他交互的绑定。',
      '// INV-10 按工作区查找取最新：守住位置 创建时间排序；改错故障 命中旧请求。',
      '// INV-11 授权查找需三项齐全：守住位置 摘要与条目比较；改错故障 跨包误用授权。',
      '// INV-12 信任状态白名单固定：守住位置 集合判断；改错故障 未知状态也能提交。',
      '// INV-13 等待先查一次现状：守住位置 入口读取；改错故障 已存在时仍挂起到超时。',
      '// INV-14 等待超时返回空：守住位置 定时器回调；改错故障 永久挂起。',
      '// INV-15 结算只发生一次：守住位置 已结算标记；改错故障 定时器与订阅重复结算。',
      '// INV-16 订阅后补查一次：守住位置 复核位置；改错故障 首读与订阅之间丢事件。',
      '// INV-17 身份优先于路径：守住位置 键取值；改错故障 同路径远端标签误选本地通道。',
      '// INV-18 查询带身份时禁止路径回落：守住位置 末尾条件；改错故障 未知身份选到旧本地绑定。',
      '//',
      '// 模块职责：保存工作区钩子评审请求与命令通道绑定，并提供按工作区查找。',
      '// 状态所有权：绑定真值在本 store，页面只做订阅与临时展示。',
      '// 阅读顺序：先看两张绑定表与动作，再看三种查找，最后看等待与匹配规则。',
    ],
    blocks: [
      {
        anchor: 'export interface WorkspaceHookCommandBinding {',
        lines: [
          '命令通道绑定按会话标识存放。',
          '绑定携带发送函数与结算回调。',
          '远端会话额外带身份隔离键。',
          '远程工作区还要带远端会话标识。',
        ],
      },
      {
        anchor: 'export const useWorkspaceHookReviewStore = create<WorkspaceHookReviewState>((set) => ({',
        lines: [
          '状态只有两张绑定表与四个动作。',
          '所有动作都以会话标识为键。',
          '断开时用发送函数身份做保护。',
        ],
      },
      {
        anchor: 'export function findWorkspaceHookReviewBindingForItem(',
        lines: [
          '必须同时匹配工作区、摘要与条目。',
          '只信任可授权的三种状态。',
          '多条命中取创建时间最新者。',
        ],
      },
      {
        anchor: 'function matchesWorkspaceBinding(input: {',
        lines: [
          '查询键优先用身份，其次用路径。',
          '绑定带身份时只允许严格相等。',
          '无身份的旧绑定才按路径回落。',
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
    `ZC-deep-b177-spec-${index}.json`,
    JSON.stringify({ files: [{ file: spec.file, items }] }, null, 2),
    'utf8',
  );
  console.log(`spec ${index}: ${spec.file} lines=${total}`);
  index += 1;
}
