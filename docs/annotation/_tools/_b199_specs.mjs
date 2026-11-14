import fs from 'node:fs';

const specs = [
  {
    file: 'packages/desktop/src/main/databaseStartupRelay.ts',
    target: 31,
    header: [
      '// INV-01 每窗口只保留一个绑定：守住位置 windowBindings 的覆盖与释放；改错故障 旧 Host 的监听继续重放 ready。',
      '// INV-02 每个 Host 进程一个 startupId：守住位置 WeakMap 写入；改错故障 新旧两代状态互相覆盖。',
      '// INV-03 状态按 sequence 单调前进：守住位置 applyState 的早退；改错故障 乱序帧把界面回退到旧阶段。',
      '// INV-04 ready 只广播一次且随清空监听：守住位置 ready 分支；改错故障 重连时重复调度初始化。',
      '// INV-05 控制命令只认本窗口渲染进程且先过 schema：守住位置 control 入口；改错故障 任意窗口可关闭数据库。',
      '// INV-06 进程退出即合成 failed：守住位置 onExit；改错故障 旧 ready 证明放行新端口。',
      '// INV-07 转发前校验绑定与窗口存活：守住位置 forward；改错故障 窗口销毁后 send 抛错。',
      '// INV-08 遥测失败不阻断启动：守住位置 单独捕获；改错故障 采集异常中断 ready 传播。',
      '// INV-09 释放幂等且按身份删除：守住位置 dispose；改错故障 二次释放误删新绑定。',
      '// INV-10 退出后不再向子进程发消息：守住位置 exited 判断；改错故障 对已退出进程 postMessage。',
      '//',
      '// 模块职责：把 Host 子进程的数据库启动状态中继到渲染进程，并回传用户控制命令。',
      '// 阅读顺序：先看同窗口绑定与转发，再看状态合并，最后看控制命令与退出收尾。',
    ],
    blocks: [
      {
        anchor: 'windowBindings.get(win)?.();',
        lines: [
          '先释放同窗口的旧绑定：旧 Host 的监听不能继续重放 ready。',
          '释放只按窗口身份，不影响其他窗口与子进程。',
          '绑定表用 WeakMap，窗口被回收时不留引用。',
          '覆盖发生在新旧 Host 交替时，属于正常路径而非异常。',
        ],
      },
      {
        anchor: 'const applyState = (state: DatabaseStartupState) => {',
        lines: [
          '同一代内按 sequence 单调：迟到或重复的帧直接丢弃。',
          '先更新 latest 再转发，保证随后的 snapshot 拿到最新值。',
          '遥测单独兜住异常，采集失败不能阻断启动链路。',
          'ready 是全局一次性事件：翻标志、广播、清空监听三步不可拆。',
          '只有 phase 为 ready 才触发，失败与中间态都不解锁初始化。',
        ],
      },
      {
        anchor: 'const control = (event: Electron.IpcMainEvent, raw: unknown) => {',
        lines: [
          '只接受本窗口渲染进程发来的控制命令，其他来源直接忽略。',
          '载荷先过 schema，畸形输入不进入子进程。',
          'exit 走宿主注入的退出回调，模块本身不碰 app 生命周期。',
          'snapshot 只回放缓存，不向子进程再要一次。',
        ],
      },
      {
        anchor: 'const onExit = () => {',
        lines: [
          '先落 exited 与映射清理，后续控制命令不再转发。',
          '从未收到过状态时也要合成一条 starting，保证 failed 有完整上下文。',
          '走 applyState 而不是直接转发，让序列号与遥测走同一条路。',
        ],
      },
      {
        anchor: 'const dispose = () => {',
        lines: [
          '幂等：重复调用直接返回，避免重复摘监听。',
          '只有仍指向自己时才删除窗口映射，防止误删新绑定。',
        ],
      },
    ],
  },
  {
    file: 'packages/desktop/src/main/pluginSandbox/session.ts',
    target: 31,
    header: [
      '// INV-01 每个 session 只准备一次：守住位置 preparedSessions；改错故障 重复装 handler，权限被二次覆盖。',
      '// INV-02 稳定 origin 不等于可信：守住位置 归属交叉校验；改错故障 任意沙箱读别人实例的资源。',
      '// INV-03 https 只放行 shell 的脚本请求：守住位置 resourceType 判断；改错故障 沙箱发起任意外网请求。',
      '// INV-04 vendor 重定向失败即取消：守住位置 then 的失败分支；改错故障 降级成直连，清单缺失被掩盖。',
      '// INV-05 shell 绝对资源改写到实例路径：守住位置 hostname 比对；改错故障 打包资源指向错误实例。',
      '// INV-06 非首帧必须属于同一 guest：守住位置 initial 判断；改错故障 其他 guest 借用主文档授权。',
      '// INV-07 默认分支一律取消：守住位置 末尾 cancel；改错故障 未登记 URL 被放行。',
      '// INV-08 未装闸门即拒绝全部权限：守住位置 gate 空值分支；改错故障 单测环境静默放行。',
      '// INV-09 权限请求带存活复核：守住位置 isCurrent；改错故障 导航后旧页面仍拿到授权。',
      '// INV-10 闸门异常与同步检查都按拒绝：守住位置 失败分支与 check 处理器；改错故障 请求与检查出现两套结论。',
      '// INV-11 下载一律阻止且代理直连：守住位置 will-download 与 setProxy；改错故障 文件落到用户磁盘、流量走用户代理。',
      '//',
      '// 模块职责：为每个可信 App 身份的持久 partition 锁定沙箱会话能力。',
      '// 阅读顺序：先看一次性准备与协议安装，再看请求拦截的分支顺序，最后看权限与下载收口。',
    ],
    blocks: [
      {
        anchor: 'if (preparedSessions.has(session)) return;',
        lines: [
          '同一 partition 只锁一次：handler 与闸门都不允许叠加。',
          '弱集合登记的是 session 对象本身，进程内复用同一对象才算同一个沙箱。',
        ],
      },
      {
        anchor: 'session.webRequest.onBeforeRequest(',
        lines: [
          '同时监听沙箱协议与外网 https，其余协议不进入这个回调。',
          '每个请求都重新解析 url 与 guest，不信任缓存的身份结论。',
          '结论只有三种：放行、改写重定向、取消；没有默认放行。',
          '回调必须同步返回结论，异步结果放在 then 里再 callback。',
          '任何内部异常都收敛成 cancel，不允许异常冒泡放行。',
        ],
      },
      {
        anchor: 'if (url.protocol === "https:") {',
        lines: [
          '外网只允许 shell 的脚本请求，用于 vendor 资源。',
          'resourceType 或 shell 身份任一不符即放空回调，即取消。',
          '重定向失败按取消处理，不降级为直连。',
        ],
      },
      {
        anchor: 'if (!target && shell?.kind === "shell") {',
        lines: [
          '只改写主文档所在实例的绝对资源 URL。',
          'hostname 必须与登记身份的 shell 主机名完全一致。',
          '改写到 /instance/<sandboxId> 前缀，保持顶层站点稳定。',
        ],
      },
      {
        anchor: 'session.setPermissionRequestHandler((guest, permission, callback, details) => {',
        lines: [
          '没有闸门就拒绝，单测与未装闸门的环境不会静默放行。',
          'isCurrent 在授权前复核页面仍在、URL 未变、frame 未脱离。',
          '闸门拒绝或抛错都回调 false，异常不会被当成同意。',
          '同步检查处理器复用同一闸门，避免两套结论。',
        ],
      },
    ],
  },
  {
    file: 'packages/provider/src/config/provider-data-schema.ts',
    target: 31,
    header: [
      '// INV-01 稀疏与完整两套 schema 成对存在：守住位置 每个 DataSchema 的稀疏与 complete 组合；改错故障 草稿态被完整校验挡住。',
      '// INV-02 稀疏用 sparseShape 展开完整形状：守住位置 两处展开；改错故障 逐字段手写后与完整版漂移。',
      '// INV-03 完整版只收紧不删键：守住位置 extend 调用；改错故障 新增字段在完整校验里被静默丢弃。',
      '// INV-04 对象一律 strict：守住位置 所有 .strict()；改错故障 拼错的配置键被静默接受。',
      '// INV-05 必填串先 trim 再判空：守住位置 nonBlankRequiredString；改错故障 纯空白通过校验。',
      '// INV-06 必填失败带稳定 issue code：守住位置 refine 的 params；改错故障 UI 只能显示通用错误。',
      '// INV-07 判别联合按 type 分流：守住位置 discriminatedUnion；改错故障 字段交叉组合出非法访问配置。',
      '// INV-08 Personal 允许暂存未成形的 baseUrl：守住位置 personalProviderApiDataSchema；改错故障 编辑中的 endpoint 无法保存。',
      '// INV-09 模型 id 列表只读且可空：守住位置 modelIdsDataSchema；改错故障 调用方原地修改配置对象。',
      '// INV-10 模板配置复用 Provider 稀疏 schema：守住位置 providerTemplateDataSchema；改错故障 模板与实例校验口径分叉。',
      '//',
      '// 模块职责：Provider 配置的稀疏（草稿）与完整（准入）两套 zod 契约。',
      '// 阅读顺序：先看枚举与必填串，再看访问与 API 的成对 schema，最后看 Provider 与模板形状。',
    ],
    blocks: [
      {
        anchor: 'const nonBlankRequiredString = z.string().refine((value) => value.trim().length > 0, {',
        lines: [
          'trim 后为空即视为缺失，避免只输入空格的配置通过准入。',
          'issue code 是给 UI 定位字段用的稳定标识，不要随手改名。',
          '这里只校验非空，URL 等格式由调用处继续 pipe。',
        ],
      },
      {
        anchor: 'export const apiKeyAccessDataSchema = z',
        lines: [
          '草稿态允许 apiKey 与管理地址都缺席。',
          '访问类型决定后续按哪种方式解释其余字段，因此不可省略。',
          'apiKey 可空但不允许空串，空串会让下游误判为已配置。',
          'strict 保证拼错的键在校验期就暴露。',
        ],
      },
      {
        anchor: 'export const completeZhipuAccountAccessDataSchema = z',
        lines: [
          '完整版要求账号类型、模式与权益标记全部在场。',
          'mode 取值与高速通道共用同一个枚举，新增值要同步访问侧。',
          '该形状同时被 sparseShape 展平成草稿版。',
        ],
      },
      {
        anchor: 'export const providerApiDataSchema = z',
        lines: [
          '草稿版把 baseUrl 放宽为可空，允许编辑中途保存。',
          '其余键仍来自完整形状，避免两版字段集分叉。',
          '完整版仍然拒绝非法 URL，准入不受草稿放宽影响。',
        ],
      },
      {
        anchor: 'export const providerConfigDataSchema = z',
        lines: [
          '三组模型列表共用同一形状：只读、可空、可缺席。',
          '分组、logo、访问方式与可见性都可以先不填。',
          '完整版只把分组、访问与 API 三处收紧为必填。',
          'visible 与 hidden 之外的值不应进入持久化。',
          'strict 让多余键在持久化前就被拒，避免脏数据落盘。',
        ],
      },
    ],
  },
  {
    file: 'packages/shared/src/conversation-share.ts',
    target: 35,
    header: [
      '// INV-01 分享路径只有两种形状：守住位置 路径正则；改错故障 其它路由被误判为分享页。',
      '// INV-02 改写只换语言前缀不碰 code：守住位置 localize 的 pathname 赋值；改错故障 编解码往返改变 code。',
      '// INV-03 版本只升不降且入站先按数字收：守住位置 版本 schema；改错故障 「版本太新」被混成通用契约错误。',
      '// INV-04 逐行降级不整份失败：守住位置 decodeConversationShareRows；改错故障 一行新 kind 让整份分享打不开。',
      '// INV-05 出站 strict、入站宽容：守住位置 各处 .strict() 的取舍；改错故障 服务端加字段打死老客户端。',
      '// INV-06 未知枚举在 narrow 时丢弃并回报：守住位置 narrowConversationShareCapabilities；改错故障 静默削掉服务端允许的类型。',
      '// INV-07 公开 URL 只允许 http/https：守住位置 preview artifact 的 refine；改错故障 API 响应启动其它协议。',
      '// INV-08 原始 rows 与解码结果一起保留：守住位置 continuation 的 rawRows；改错故障 落盘副本永久抹掉未知字段。',
      '// INV-09 已知业务码给语义、未知码退回 HTTP：守住位置 classifyConversationShareError；改错故障 新码一律显示网络错误。',
      '// INV-10 错误信封与成功信封都不锁死 code/msg：守住位置 两个信封 schema；改错故障 后端换个文案就判契约损坏。',
      '//',
      '// 模块职责：会话分享的路径、版本、投影解码、能力收窄与错误分类契约。',
      '// 阅读顺序：先看路径与版本，再看 rows 解码与能力收窄，最后看请求响应形状与错误分类。',
    ],
    blocks: [
      {
        anchor: 'if (!match) return null;',
        lines: [
          '只认两种分享形状，其余路径返回 null 交给调用方决定。',
          'code 原样返回不解码，解码与安全校验属于调用方。',
          '语言由是否带 cn 前缀推导，不再看查询参数。',
        ],
      },
      {
        anchor: 'let url: URL;',
        lines: [
          '非法 URL 原样返回，让调用方保留原始字符串而不是抛错。',
          '只有解析出分享形状才改写，避免动到别的链接。',
          '改写只换前缀，code 段保持未解码原样。',
        ],
      },
      {
        anchor: 'for (const row of rows) {',
        lines: [
          '逐行 safeParse：成功入列，失败只计数不抛出。',
          '未知 kind 归入 unsupported 并去重，供调用方做软提示。',
          '没有 kind 的脏行统一记成 unknown。',
          '这里刻意不给枚举配兜底，猜错语义比丢一行更危险。',
        ],
      },
      {
        anchor: 'for (const entry of wire.allowed_artifacts) {',
        lines: [
          '逐个类型尝试收窄，认识的才进入能力表。',
          '被丢弃的类型去重后回报，便于排查白名单是否漏配。',
          '注意丢弃只对客户端确实产不出的类型无损。',
          '访问模式同理：认不出的模式不能让用户选到。',
        ],
      },
      {
        anchor: 'export const conversationSharePreviewDataSchema = z.object({',
        lines: [
          'rows 在 wire 层是 unknown[]，语义交给逐行解码。',
          '其余字段保持严格，只有 rows 与 content_blocks 放宽。',
          '对外类型是解码后的形状，不从这份 schema 推断。',
        ],
      },
      {
        anchor: 'const known = conversationShareKnownErrorCodeSchema.safeParse(code);',
        lines: [
          '已知业务码优先，直接映射到稳定错误类别。',
          '未知码退回 HTTP 状态判断，避免新码一律变 unknown。',
          '2xx 却缺 code 才算契约损坏，与 HTTP 拒绝区分开。',
          '429 与 5xx 单独归类，便于上层做退避与服务故障提示。',
          '403 与 404 合并为 not_found：不向用户暴露资源是否存在。',
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
    `ZC-deep-b199-spec-${index}.json`,
    JSON.stringify({ files: [{ file: spec.file, items }] }, null, 2),
    'utf8',
  );
  console.log(`spec ${index}: ${spec.file} lines=${total}`);
  index += 1;
}
