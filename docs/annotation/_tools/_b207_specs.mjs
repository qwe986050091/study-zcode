// B207 四个文件的注释 spec 生成器（全部 target=30）。
import fs from 'node:fs';

const specs = [
  {
    file: 'packages/shared/src/node/privateFilePersistence.ts',
    target: 30,
    header: [
      '// INV-01 进程内先 FIFO 再抢 OS 锁：守住位置 withFileLock 的 tails 链；改错故障 同进程惊群导致后排假超时。',
      '// INV-02 队列节点必须释放：守住位置 finally 的 releaseProcessQueue；改错故障 后续同文件调用永久挂起。',
      '// INV-03 尾部登记按值比对再删除：守住位置 currentTail 相等判断；改错故障 新排队者被旧清理逻辑摘掉。',
      '// INV-04 取锁失败也要走 finally：守住位置 releaseLock?.()；改错故障 异常路径把队列卡死。',
      '// INV-05 目录必须先建：守住位置 mkdir recursive；改错故障 首次写入因父目录缺失失败。',
      '// INV-06 临时文件名含 pid/时间/随机数：守住位置 tempPath 拼接；改错故障 并发写撞同名临时文件。',
      '// INV-07 临时文件权限 0600：守住位置 writeFile 的 mode；改错故障 凭据文件对同机其他用户可读。',
      '// INV-08 写完必须 rename 原子替换：守住位置 renameWithRetry；改错故障 读者可能看到半截内容。',
      '// INV-09 rename 只重试三类错误：守住位置 isRetryableRenameError；改错故障 永久错误被拖到超时。',
      '// INV-10 失败必须清理临时文件：守住位置 catch 的 rm force；改错故障 磁盘堆积 .tmp。',
      '// INV-11 清理失败不掩盖原始错误：守住位置 rm 的吞错回调；改错故障 用户看到 ENOENT 而非真实原因。',
      '// INV-12 损坏备份名按内容哈希确定：守住位置 sha256 前缀；改错故障 每次重试都新建一份备份。',
      '// INV-13 备份用 wx 排他创建：守住位置 flag: "wx"；改错故障 覆盖已有证据文件。',
      '// INV-14 EEXIST 视为成功：守住位置 getErrorCode 判定；改错故障 并发备份互相报错。',
      '// INV-15 备份最终强制 0600：守住位置 chmod；改错故障 继承历史宽松权限。',
      '//',
      '// 模块职责：私有文本文件的原子写入、跨进程锁排队与损坏文件证据备份。',
      '// 阅读顺序：先看锁队列与释放，再看临时文件写入与 rename 重试，最后看损坏备份。',
    ],
    blocks: [
      {
        anchor: 'const DEFAULT_LOCK_RETRY_DELAYS_MS = [25, 50, 100, 200, 400] as const;',
        lines: [
          '退避序列总时长远小于 maxWait，保证重试次数内能给出明确结果。',
        ],
      },
      {
        anchor: 'const processFileLockTails = new Map<string, Promise<void>>();',
        lines: [
          '键是文件路径，值是该路径当前队尾的完成信号。',
        ],
      },
      {
        anchor: 'function isRetryableRenameError(error: unknown): boolean {',
        lines: [
          'Windows 上杀软或索引器短暂占用会报这三类，其余错误立即上抛。',
        ],
      },
      {
        anchor: 'async function renameWithRetry(',
        lines: [
          'attempt 递增读取延迟表，越界即放弃，避免无限重试。',
          'sleep 在重试之间让出事件循环，不阻塞其他文件的写入。',
        ],
      },
      {
        anchor: 'export async function withFileLock<T>(',
        lines: [
          '前一个队尾完成才继续，保证同进程对同一文件严格串行。',
          '释放顺序固定：先还 OS 锁再放队列，反过来会让下一个抢锁者空转。',
        ],
      },
      {
        anchor: 'export async function atomicWritePrivateTextFile(',
        lines: [
          '临时文件与目标同目录，保证 rename 不跨设备。',
          '错误分支里先清临时文件再抛出，调用方只需处理一个错误。',
        ],
      },
      {
        anchor: 'export async function backupCorruptFile(filePath: string): Promise<string> {',
        lines: [
          '读取原始字节做哈希，避免先解码再编码造成证据偏差。',
          '截断到 24 位十六进制足够区分，又不至于让文件名过长。',
          'chmod 放在写之后执行，覆盖潜在的历史权限。',
        ],
      },
    ],
  },
  {
    file: 'packages/shared/src/plan-identity.ts',
    target: 30,
    header: [
      '// INV-01 无 provider 家族直接 unknown：守住位置 首个早退；改错故障 未登录时误报无套餐。',
      '// INV-02 顺序固定 coding plan 优先：守住位置 两次 resolve 的先后；改错故障 双订阅时身份抖动。',
      '// INV-03 只有 active 才产出身份：守住位置 kind === "active"；改错故障 none 状态被当成有效套餐。',
      '// INV-04 coding 非 none 即 unknown：守住位置 第二个判断；改错故障 过期缓存被当成无套餐。',
      '// INV-05 start 为 none 才落到 no_plan：守住位置 末尾判断；改错故障 未知状态被误判为无套餐。',
      '// INV-06 缓存过期即 unknown：守住位置 now - generatedAt > TTL；改错故障 展示过期套餐。',
      '// INV-07 未登录或不可用即 unknown：守住位置 authenticated/unavailableReason；改错故障 网络故障被说成无套餐。',
      '// INV-08 not_authenticated 与 not_configured 归 unknown：守住位置 并列判断；改错故障 配置缺失被当成无套餐。',
      '// INV-09 只有 no_plan 映射为 none：守住位置 单独分支；改错故障 其它不可用原因被吞成无套餐。',
      '// INV-10 有配额或订阅或余量才算 active：守住位置 三元判断；改错故障 空快照被当成有效套餐。',
      '// INV-11 产品 id 缺失降级为空串：守住位置 subscription?.details[0]?.productId ?? ""；改错故障 返回 undefined 破坏快照类型。',
      '// INV-12 generatedAt 用快照时间而非 now：守住位置 active 分支；改错故障 缓存命中时间被当成凭证生成时间。',
      '// INV-13 unknown 统一用 now 与空产品 id：守住位置 createPlanIdentitySnapshot 调用；改错故障 下游拿到无效时间戳。',
      '// INV-14 纯函数无副作用：守住位置 全模块无 IO；改错故障 投影层意外触发网络请求。',
      '//',
      '// 模块职责：把 provider 家族与两份用量凭证投影成可展示的套餐身份快照。',
      '// 阅读顺序：先看顶层优先级，再看 entitlement 三态判定，最后看快照字段来源。',
    ],
    blocks: [
      {
        anchor: 'export function resolvePlanIdentitySnapshot(input: {',
        lines: [
          'provider 家族是身份判定的前提，缺失时不再看凭证。',
          'coding plan 命中即返回，避免与 start plan 叠加。',
          '两边都不可判定时保持 unknown，不做猜测。',
        ],
      },
      {
        anchor: 'function createPlanIdentitySnapshot(',
        lines: [
          '三个字段即全部可展示信息，不再向下透传凭证对象。',
          '状态名直接对应前端展示枚举，本层不做文案映射。',
        ],
      },
      {
        anchor: 'function resolvePlanEntitlementState(input: {',
        lines: [
          '无快照与缓存过期都归 unknown，调用方无需区分。',
          '未认证或整体不可用优先于具体原因，避免误读。',
          'no_plan 是唯一能宣称确实没有套餐的状态。',
          '三个载荷任一存在即视为 active，避免与套餐类型耦合。',
        ],
      },
      {
        anchor: 'if (snapshot.unavailableReason === "no_plan") {',
        lines: [
          '这里是 none 的唯一来源。',
          '其余 reason 一律向上落到 unknown。',
        ],
      },
      {
        anchor: 'planProductId: snapshot.subscription?.details[0]?.productId ?? "",',
        lines: [
          'productId 只取首个订阅明细，缺失时用空串占位。',
          'generatedAt 沿用快照时间，保证缓存命中不刷新时间戳。',
        ],
      },
    ],
  },
  {
    file: 'packages/shared/src/remoteSshHostKey.ts',
    target: 30,
    header: [
      '// INV-01 共享键绝不含口令：守住位置 字段列表；改错故障 密码进入日志或跨窗口缓存键。',
      '// INV-02 认证方式参与身份：守住位置 resolveSshAuthKind；改错故障 换认证方式后复用旧连接。',
      '// INV-03 私钥路径归一化后入键：守住位置 normalizePrivateKeyPath；改错故障 同一私钥的两种写法产生两条连接。',
      '// INV-04 host 统一小写并 trim：守住位置 数组第二项；改错故障 大小写不同被当成两台主机。',
      '// INV-05 端口缺省 22：守住位置 target.port ?? 22；改错故障 显式 22 与缺省产生两个键。',
      '// INV-06 用户名只 trim 不折叠大小写：守住位置 第四项；改错故障 不同账号撞键。',
      '// INV-07 盘符与 UNC 根不可被 .. 弹掉：守住位置 blocksParentTraversal；改错故障 路径逃逸到父目录。',
      '// INV-08 相对与 ~ 路径保留未消解 ..：守住位置 末尾 push；改错故障 浏览器侧错误求值。',
      '// INV-09 分隔符统一为斜杠：守住位置 replace 反斜杠；改错故障 Windows 路径跨平台不一致。',
      '// INV-10 盘符统一大写：守住位置 正则替换；改错故障 C: 与 c: 生成两个键。',
      '// INV-11 空段与点段直接丢弃：守住位置 循环内 continue；改错故障 路径出现双斜杠差异。',
      '// INV-12 归一化结果为空回落到原前缀：守住位置 || root.prefix；改错故障 根路径变成空串。',
      '// INV-13 版本前缀固定：守住位置 数组首项；改错故障 协议变更后旧键仍被命中。',
      '// INV-14 键是 JSON 数组而非拼接串：守住位置 JSON.stringify；改错故障 字段含分隔符时撞键。',
      '//',
      '// 模块职责：为窗口内 SSH 远端生成稳定且不含敏感信息的共享身份键。',
      '// 阅读顺序：先看字段清单与认证方式，再看路径根拆分，最后看逐段归一化。',
    ],
    blocks: [
      {
        anchor: 'function splitPrivateKeyPathRoot(value: string): PrivateKeyPathRoot {',
        lines: [
          '先识别盘符绝对路径，再处理 UNC 与 POSIX 根，顺序不能换。',
          'UNC 至少要 server 与 share 两段才构成合法根。',
          '波浪号与裸相对路径不做越界阻断，交给上层策略。',
        ],
      },
      {
        anchor: 'function normalizePrivateKeyPath(value: string | undefined): string {',
        lines: [
          'trim 后为空统一返回空串，避免 undefined 进入键。',
          '反斜杠先统一，否则后续按斜杠分段会漏拆。',
          '盘符大写化保证跨平台一致。',
        ],
      },
      {
        anchor: 'if (root.blocksParentTraversal) {',
        lines: [
          '根路径上的 .. 直接忽略，保持根不被上跳。',
          '相对路径保留 ..，因为浏览器侧无法安全求值。',
        ],
      },
      {
        anchor: 'return `${root.prefix}${segments.join("/")}` || root.prefix;',
        lines: [
          '拼完为空时回落到纯根，保证根路径也有稳定键。',
        ],
      },
      {
        anchor: 'function resolveSshAuthKind(target: SshRemoteHostKeyTarget): "agent" | "password" | "private-key" {',
        lines: [
          '私钥优先于口令，二者同时存在时按私钥建连。',
          '都没有则视为 agent，避免把空字符串当认证信息。',
        ],
      },
      {
        anchor: 'export function buildSshRemoteHostKey(target: SshRemoteHostKeyTarget): string {',
        lines: [
          '数组顺序即协议，改动需要同时升级版本前缀。',
          '认证方式由既有字段推导，不额外读取运行时状态。',
        ],
      },
    ],
  },
  {
    file: 'packages/shared/src/session-debug.ts',
    target: 30,
    header: [
      '// INV-01 三个上限固定且同时生效：守住位置 SESSION_DEBUG_LIMITS 与两处 max；改错故障 调试快照撑爆前端。',
      '// INV-02 参数只接受 sessionId 一个字段：守住位置 strict；改错故障 多余字段被静默忽略。',
      '// INV-03 sessionId 不能为空串：守住位置 min(1)；改错故障 空 id 查询到默认会话。',
      '// INV-04 计数字段有限且非负：守住位置 count 定义；改错故障 NaN 或负数进入统计。',
      '// INV-05 所有对象 schema 都 strict：守住位置 四处 strict；改错故障 未知字段悄悄落库。',
      '// INV-06 网络状态是五值枚举：守住位置 z.enum；改错故障 新事件类型让整个快照解析失败。',
      '// INV-07 头部字段必须成对：守住位置 两个 HeaderCount；改错故障 计数与实际头数不一致。',
      '// INV-08 可空字段用 nullable 而非 optional：守住位置 hitRate/generationDurationMs；改错故障 缺失与 null 语义混淆。',
      '// INV-09 cache 可整体为空：守住位置 nullable；改错故障 无缓存时快照校验失败。',
      '// INV-10 TPS 只在输入完整时计算：守住位置 calculateOutputTps 的六连判；改错故障 未知值被算成 0。',
      '// INV-11 时长必须为正：守住位置 generationDurationMs <= 0；改错故障 除零得到 Infinity。',
      '// INV-12 非有限结果一律 null：守住位置 末尾 Number.isFinite；改错故障 NaN 进入展示层。',
      '// INV-13 类型由 schema 推导：守住位置 z.infer；改错故障 手写类型与校验漂移。',
      '// INV-14 未知值不用总耗时替代：守住位置 入参只收生成时长；改错故障 TPS 被高估。',
      '//',
      '// 模块职责：会话调试快照的 zod 契约与输出 TPS 计算。',
      '// 阅读顺序：先看上限与基础 schema，再看轮次/网络/缓存三张表，最后看 TPS 计算。',
    ],
    blocks: [
      {
        anchor: 'export const SESSION_DEBUG_LIMITS = { rounds: 200, network: 100, dedupe: 2000 } as const;',
        lines: [
          'rounds 与 network 是数组上限，dedupe 供上游去重窗口使用。',
          '三值集中在这里，避免不同调用方各自截断。',
        ],
      },
      {
        anchor: 'export const sessionDebugParamsSchema = z.object({ sessionId: z.string().min(1) }).strict();',
        lines: [
          '只允许 sessionId，strict 让拼错的查询参数直接报错。',
        ],
      },
      {
        anchor: 'const count = z.number().finite().nonnegative();',
        lines: [
          '共享一个有限非负约束，避免每个字段重复字面量。',
        ],
      },
      {
        anchor: 'export const sessionDebugRoundSchema = z',
        lines: [
          'hitRate 等可空字段允许 null，区分无数据与未采集。',
          'usage 内全部 optional，旧快照缺少新字段仍可解析。',
        ],
      },
      {
        anchor: 'export const sessionDebugNetworkEntrySchema = z',
        lines: [
          '枚举覆盖请求生命周期五个关键点，新增状态需同步前端。',
          '头部同时给 map 与 count，便于展示体积又不必遍历。',
        ],
      },
      {
        anchor: 'export const sessionDebugSnapshotSchema = z',
        lines: [
          'rounds 与 networkEntries 必须落在上限内。',
          'cache 整体可空，表示该会话没有缓存统计。',
        ],
      },
      {
        anchor: 'export function calculateOutputTps(',
        lines: [
          '任一输入缺失或非正都返回 null，不猜测。',
        ],
      },
      {
        anchor: 'const tps = (outputTokens * 1000) / generationDurationMs;',
        lines: [
          '毫秒换算成秒，调用方拿到的是每秒 token 数。',
          '结果不做四舍五入，精度交给展示层决定。',
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
    `ZC-deep-b207-spec-${index}.json`,
    JSON.stringify({ files: [{ file: spec.file, items }] }, null, 2),
    'utf8',
  );
  console.log(`spec ${index}: ${spec.file} lines=${total}`);
  index += 1;
}
