import fs from 'node:fs';

const specs = [
  {
    file: 'apps/zcode-cli/packages/core/src/runtime/methods/title-generation-sidecar.ts',
    target: 40,
    firstNth: 1,
    header: [
      '// INV-01 未传入冻结上下文时兜底现取：守住位置 modelContext 合并；改错故障 直调路径无选择。',
      '// INV-02 无模型选择即降级：守住位置 空值返回；改错故障 抛错中断主轮。',
      '// INV-03 辅助选项绑定：守住位置 auxiliaryModelOptions；改错故障 标题继承主轮工具与流式设置。',
      '// INV-04 子 trace 带模型与来源：守住位置 createChildTraceContext；改错故障 用量无法归属。',
      '// INV-05 先落 ModelRequest 再发请求：守住位置 appendEvent；改错故障 审计看不到旁路调用。',
      '// INV-06 网络事件起点在此标记：守住位置 索引；改错故障 用量把旧事件算进来。',
      '// INV-07 独立超时：守住位置 AbortSignal.timeout；改错故障 标题永久挂起。',
      '// INV-08 超时配置需为正有限数：守住位置 positiveTimeoutMs；改错故障 传 0 立即超时。',
      '// INV-09 headers 刷新绑定本次 abortSignal：守住位置 创建函数；改错故障 拖住主轮。',
      '// INV-10 statusSink 绑定本次调用：守住位置 invocationContext；改错故障 状态串轮。',
      '// INV-11 失败也记 usage：守住位置 catch；改错故障 token 消耗漏账。',
      '// INV-12 成功后也落 ModelComplete：守住位置 事件追加；改错故障 统计只读内存。',
      '// INV-13 工具调用即违约：守住位置 toolCalls 判断；改错故障 把回答当标题。',
      '// INV-14 空标题不写回：守住位置 title 判空；改错故障 会话列表出现空白。',
      '// INV-15 返回子 trace：守住位置 返回对象；改错故障 后续事件挂错链路。',
      '// INV-16 输入折叠空白并硬截断：守住位置 MAX_TITLE_INPUT_CHARS；改错故障 超长 query 抬高成本。',
      '// INV-17 清洗先去 think 再剥 JSON：守住位置 顺序；改错故障 推理片段进入标题。',
      '// INV-18 只剩标点视为无效：守住位置 字符校验；改错故障 emoji 标题入库。',
      '//',
      '// 模块职责：以独立无工具请求生成会话标题，并单独上报 ModelRequest/ModelComplete 与用量。',
      '// 状态所有权：模型上下文由调用方冻结传入；本模块不持有跨调用状态。',
      '// 阅读顺序：先看上下文保留，再看请求主链，最后看标题清洗。',
    ],
    blocks: [
      {
        anchor: 'export interface TitleModelContext {',
        lines: [
          '选择可为空。',
          '可携带请求依赖。',
          '释放只影响自身票据。',
        ],
      },
      {
        anchor: 'export function retainTitleModelContext(',
        lines: [
          '闲时票据在入队时读取。',
          '仅未终结且未接管才借票。',
          '普通路径无票据可释放。',
        ],
      },
      {
        anchor: 'export async function generateTitleCandidate(',
        lines: [
          '先建 detached span。',
          '成功记 completed。',
          '失败记 failed 后原样抛出。',
        ],
      },
      {
        anchor: 'async function generateTitleCandidateImpl(',
        lines: [
          '无选择即降级为空。',
          '先落 ModelRequest 再发请求。',
          '失败也先记 usage。',
        ],
      },
      {
        anchor: 'export function normalizeTitleInput(input: string): string {',
        lines: [
          '折叠连续空白。',
          '按字符数硬截断。',
          '不处理码点边界。',
        ],
      },
      {
        anchor: 'function cleanGeneratedTitle(raw: string): string | null {',
        lines: [
          '先剔除 think 段。',
          '再按 JSON 解析。',
          '标点与 emoji 视为无效。',
        ],
      },
    ],
  },
  {
    file: 'apps/zcode-cli/packages/core/src/tool/executor/background-tasks.ts',
    target: 49,
    firstNth: 1,
    header: [
      '// INV-01 只观察已转后台的结果：守住位置 isBackgroundTaskLaunch；改错故障 同步结果起轮询。',
      '// INV-02 taskId 双口径且幂等去重：守住位置 backgroundPollers；改错故障 两套轮询并发。',
      '// INV-03 先注册再发 started：守住位置 顺序；改错故障 订阅者查不到任务。',
      '// INV-04 started 失败回滚：守住位置 catch；改错故障 留下永远 running 的幽灵。',
      '// INV-05 无快照源与等待者时收敛为 lost：守住位置 两个能力判断；改错故障 任务卡在 running。',
      '// INV-06 停止追踪先移除集合：守住位置 stopTracking；改错故障 外部仍认为在轮询。',
      '// INV-07 运行更新只发有变化的快照：守住位置 签名比较；改错故障 每秒重复事件。',
      '// INV-08 终态只发一次且失败释放认领：守住位置 emitTerminalSnapshot；改错故障 重复 completed 或通知被吞。',
      '// INV-09 轮询间隔一秒，直接等待优先：守住位置 waitForCompletion；改错故障 高频打爆端口或终态延迟。',
      '// INV-10 取消能力由生命周期表决定：守住位置 canCancelBackgroundTask；改错故障 取消入口失效。',
      '// INV-11 载荷字段集中构造：守住位置 backgroundTaskPayload；改错故障 started 与 updated 字段漂移。',
      '// INV-12 通知先去重认领：守住位置 claim；改错故障 同一任务重复通知。',
      '// INV-13 本地 agent 快照不外发：守住位置 isNotifiedLocalAgentSnapshot；改错故障 内部事件泄露成用户通知。',
      '// INV-14 bash 通知摘要按描述优先：守住位置 buildBackgroundTaskSummary；改错故障 用户只看到长命令。',
      '// INV-15 报告与产物分两段：守住位置 两个 builder；改错故障 顶层返回值混进产物。',
      '// INV-16 脚本路径只在有值时出现：守住位置 scriptPath；改错故障 通知出现 undefined。',
      '// INV-17 缺失能力视为无：守住位置 lifecycleProvider；改错故障 调用空函数崩溃。',
      '// INV-18 状态名收敛为三态：守住位置 normalize；改错故障 未知状态进入通知。',
      '//',
      '// 模块职责：跟踪已转入后台的工具任务，轮询或等待终态并发出事件与通知。',
      '// 状态所有权：pollers 集合与 runtime registry 共同描述存活任务。',
      '// 阅读顺序：先看生命周期表，再看追踪主链，最后看通知格式化。',
    ],
    blocks: [
      {
        anchor: 'export class BackgroundTaskTracker {',
        lines: [
          '只观察已转后台的结果。',
          '非 record 直接返回。',
          'taskId 支持双口径。',
          '同一任务幂等去重。',
        ],
      },
      {
        anchor: '  async trackBackgroundTask(',
        lines: [
          '先注册再发 started。',
          'started 失败要回滚。',
          '无来源时收敛为 lost。',
          '终态只发一次。',
        ],
      },
      {
        anchor: '    const stopTracking = () => {',
        lines: [
          '先移除存活集合。',
          '再更新注册表状态。',
          '失败不阻断后续清理。',
          '重复调用无副作用。',
        ],
      },
      {
        anchor: '    const emitTerminalSnapshot = async (',
        lines: [
          '运行更新只发变化。',
          '终态只发一次。',
          '通知失败释放认领。',
          '本地 agent 不外发。',
        ],
      },
      {
        anchor: '  private async emitBackgroundTaskEvent(',
        lines: [
          '载荷集中构造。',
          '事件携带轮次标识。',
          '失败向上抛出。',
          '由调用方决定回滚。',
        ],
      },
      {
        anchor: '  private canCancelBackgroundTask(toolCall: ExecutableToolCall): boolean {',
        lines: [
          '由生命周期表决定。',
          '缺省不可取消。',
          '与 started 载荷保持一致。',
          'legacy 任务显式支持。',
        ],
      },
      {
        anchor: 'function isBackgroundTaskLaunch(',
        lines: [
          '非 record 即判否。',
          '必须带任务标识。',
          '同步结果不进入观察。',
        ],
      },
    ],
  },
  {
    file: 'docs/knip/docs/src/util/post.ts',
    target: 37,
    header: [
      '// INV-01 只处理带 URL 实体的帖子：守住位置 entities.urls 判断；改错故障 对空实体排序崩溃。',
      '// INV-02 从大到小替换：守住位置 排序；改错故障 短链接先被替换破坏长链接。',
      '// INV-03 媒体实体替换为图片标签：守住位置 media_key 分支；改错故障 图片链接残留。',
      '// INV-04 推文链接清空：守住位置 includes 判断；改错故障 正文出现裸链接。',
      '// INV-05 外链替换为锚点：守住位置 默认分支；改错故障 外链不可点击。',
      '// INV-06 长文媒体追加尾部：守住位置 note_tweet 判断；改错故障 媒体图片丢失。',
      '// INV-07 原地改写 text：守住位置 post.text 赋值；改错故障 调用方读不到结果。',
      '// INV-08 时间格式固定 UTC：守住位置 timeZone；改错故障 本地时区导致时间漂移。',
      '// INV-09 时间与日期两段拼接：守住位置 模板；改错故障 只显示其一。',
      '// INV-10 帖子类型集中声明：守住位置 interface Post；改错故障 字段散落。',
      '// INV-11 URL 实体字段可选：守住位置 interface UrlEntity；改错故障 缺字段即崩。',
      '// INV-12 注解实体独立：守住位置 interface AnnotationEntity；改错故障 类型混用。',
      '// INV-13 媒体仅支持图片：守住位置 type literal；改错故障 视频被当图片。',
      '// INV-14 带用户扩展：守住位置 PostWithUser；改错故障 用户信息缺失。',
      '// INV-15 响应结构固定：守住位置 PostResponse；改错故障 includes 缺失。',
      '// INV-16 用户提及类型独立：守住位置 interface MentionEntity；改错故障 与注解混淆。',
      '// INV-17 图片尺寸必填：守住位置 interface ImageEntity；改错故障 渲染拿不到宽高。',
      '// INV-18 用户字段完整：守住位置 interface User；改错故障 头像或名称缺失。',
      '//',
      '// 模块职责：把推文正文中的短链、媒体与外链改写成可展示的 HTML 片段。',
      '// 状态所有权：输入帖子对象会被原地改写 text。',
      '// 阅读顺序：先看正文改写，再看时间格式，最后看类型声明。',
    ],
    blocks: [
      {
        anchor: "const timeFormatter = new Intl.DateTimeFormat('en-US', {",
        lines: [
          '时间固定 UTC。',
          '使用 12 小时制。',
          '只输出时分。',
        ],
      },
      {
        anchor: 'export const formatTimestamp = (date: string) => {',
        lines: [
          '解析 ISO 时间。',
          '两段格式化后拼接。',
          '保持单行展示。',
        ],
      },
      {
        anchor: 'interface Post {',
        lines: [
          '指标字段全量声明。',
          '实体字段必填。',
          '长文正文单独存放。',
        ],
      },
      {
        anchor: 'interface UrlEntity {',
        lines: [
          '起止偏移必填。',
          '展开链接必填。',
          '媒体键与预览信息可选。',
        ],
      },
      {
        anchor: 'export interface PostWithUser extends Post {',
        lines: [
          '继承基础字段。',
          '媒体数组可选。',
          '用户信息必填。',
        ],
      },
    ],
  },
  {
    file: 'packages/desktop/scripts/mcp-apps-host-fixture/sampling-extra-checks.ts',
    target: 37,
    header: [
      '// INV-01 复用同一 sampling 请求体：守住位置 request 常量；改错故障 各检查参数漂移。',
      '// INV-02 每种权限模式都要走通：守住位置 模式循环；改错故障 某模式被跳过。',
      '// INV-03 授权历史不应增加：守住位置 前后比对；改错故障 隐式弹审批。',
      '// INV-04 会话消息不应被写入：守住位置 messages 长度；改错故障 采样污染会话。',
      '// INV-05 用量至少覆盖四次请求：守住位置 modelRequestCount；改错故障 计数漏记。',
      '// INV-06 provider 错误只到 SDK 一次：守住位置 filter 长度；改错故障 重试风暴。',
      '// INV-07 错误后实例可继续使用：守住位置 after-error 调用；改错故障 实例被永久占死。',
      '// INV-08 采样与主任务并发：守住位置 并行发起；改错故障 串行导致用例失真。',
      '// INV-09 取消采样不影响主任务：守住位置 取消后比对消息；改错故障 主任务被连带取消。',
      '// INV-10 主任务终态成功：守住位置 terminal 状态；改错故障 误判失败。',
      '// INV-11 关闭任务中止采样：守住位置 session/close；改错故障 采样悬挂。',
      '// INV-12 陈旧请求被拒绝：守住位置 assert.rejects；改错故障 旧实例继续服务。',
      '// INV-13 keep-warm 订阅要释放：守住位置 waitConnectionsReleased；改错故障 句柄泄漏。',
      '// INV-14 每个检查独立命名：守住位置 check 包装；改错故障 失败无法定位。',
      '// INV-15 窗口最终销毁：守住位置 win.destroy；改错故障 残留窗口。',
      '// INV-16 计划键区分用例：守住位置 采样键；改错故障 用例互相命中。',
      '// INV-17 采样结果必须显式断言：守住位置 result 与 error；改错故障 静默通过。',
      '// INV-18 中止事件要等到：守住位置 aborted 等待；改错故障 竞态下假通过。',
      '//',
      '// 模块职责：在 fixture 环境里验证 sampling 的权限、错误、并发与关闭语义。',
      '// 状态所有权：环境与窗口由调用方创建，本函数只在最后销毁窗口。',
      '// 阅读顺序：先看公共请求与作用域，再看四个 check。',
    ],
    blocks: [
      {
        anchor: 'export async function checkSamplingExtras(',
        lines: [
          '请求体保持最小。',
          '作用域与窗口各建一次。',
          '结束时销毁窗口。',
        ],
      },
      {
        anchor: '  const request = {',
        lines: [
          '单条文本消息。',
          '输出上限 32。',
          '所有检查共用。',
        ],
      },
      {
        anchor: '  const scope = await env.agent.session(join(root, "sampling-extra-workspace"), "sampling-extra");',
        lines: [
          '独立测试工作区。',
          '独立会话作用域。',
          '复用同一模型选择。',
        ],
      },
      {
        anchor: '  const page = (code: string) => env.evalPage(win, code);',
        lines: [
          '页面内执行脚本。',
          'UI 侧同样可执行。',
          '采样入口单独封装。',
        ],
      },
      {
        anchor: '  const sample = (key: string) =>',
        lines: [
          '键用于区分计划。',
          '请求体序列化传入。',
          '返回 Promise 供断言。',
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
    const item = { anchor, lines: block.lines };
    if (block.nth !== undefined) item.nth = block.nth;
    items.push(item);
  }
  const total = spec.header.length + spec.blocks.reduce((n, b) => n + b.lines.length, 0);
  if (total !== spec.target) {
    console.error(`TARGET MISMATCH ${spec.file}: ${total} != ${spec.target}`);
    process.exit(1);
  }
  fs.writeFileSync(
    `ZC-deep-b157-spec-${index}.json`,
    JSON.stringify({ files: [{ file: spec.file, items }] }, null, 2),
    'utf8',
  );
  console.log(`spec ${index}: ${spec.file} lines=${total}`);
  index += 1;
}
