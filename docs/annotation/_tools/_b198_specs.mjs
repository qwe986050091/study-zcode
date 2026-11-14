import fs from 'node:fs';

const specs = [
  {
    file: 'apps/zcode-cli/packages/debug/server/sources.ts',
    target: 35,
    firstNth: 1,
    header: [
      '// INV-01 路径先解析为绝对路径：守住位置 三个 loader 的首行 resolve；改错故障 相对路径随进程 cwd 漂移。',
      '// INV-02 日志目录有默认值、事件文件没有：守住位置 loadLogs 与 loadEventLog 的入参处理；改错故障 猜错事件文件位置反而读到别的数据。',
      '// INV-03 SQLite 一律只读打开：守住位置 DatabaseSync 的 readOnly；改错故障 调试端写坏生产会话库。',
      '// INV-04 三表读取上限固定：守住位置 三个 read* 的 limit；改错故障 全库拉取拖垮调试接口。',
      '// INV-05 句柄必在 finally 关闭：守住位置 loadSqlite 收尾块；改错故障 WAL/SHM 被长期占用，CLI 写入被拖慢。',
      '// INV-06 源缺失降级为 warning：守住位置 各 loader 的早退分支；改错故障 一个源缺文件就让整页 500。',
      '// INV-07 单行坏 JSON 只影响该行：守住位置 readJsonlFiles 的内层捕获；改错故障 一条坏行清空整个文件。',
      '// INV-08 单文件读失败不影响其他文件：守住位置 外层捕获；改错故障 一个权限错误丢掉整批记录。',
      '// INV-09 行号是 1 基物理行号：守住位置 entries 索引加一；改错故障 前端回跳错行。',
      '// INV-10 目录只认 .jsonl/.log 并按名排序：守住位置 filter 与 sort；改错故障 读到垃圾文件、顺序不稳定。',
      '// INV-11 每条记录都带来源：守住位置 JsonRecord 包装；改错故障 前端无法定位原始行。',
      '// INV-12 空串等同未提供：守住位置 stringValue；改错故障 空 event 被当成合法事件。',
      '// INV-13 数字只认有限值：守住位置 numberValue；改错故障 NaN 进入时间戳与用量。',
      '// INV-14 解析结果只收普通对象：守住位置 isRecord；改错故障 数组被当记录读取、字段全是 undefined。',
      '//',
      '// 模块职责：把日志 JSONL、Session 事件 JSONL 与 SQLite 会话库读成 types.ts 的统一记录集。',
      '// 状态所有权：无模块级状态；数据库句柄在单次调用内创建并关闭。',
      '// 阅读顺序：先看默认路径，再看三个 loader，最后看 JSONL 读取与字段归一工具。',
    ],
    blocks: [
      {
        anchor: 'const logDir = resolve(options.logDir ?? defaultLogDir());',
        lines: [
          '先解析成绝对路径，调用方给相对路径也不会随 cwd 漂移。',
          '缺省回落到 ~/.zcode/cli/log，与 CLI 写入侧约定一致。',
          '读取失败不在这里判断，统一交给 readJsonlFiles 转成 warning。',
          '返回结构固定三件套：记录、路径、告警。',
        ],
      },
      {
        anchor: 'if (!options.eventPath) {',
        lines: [
          '事件文件位置无法推断，缺省就是空态而不是猜路径。',
          '空记录加 warning，让页面其他源照常展示。',
          '这里不抛错，否则一个未配置项会打断整个观测接口。',
        ],
      },
      {
        anchor: 'let db: DatabaseSync | undefined;',
        lines: [
          '保存句柄是为了 finally 里无条件关闭，提前 return 也必须走到。',
          '只读打开：调试端绝不能写生产会话库。',
          '三张表各自限流，顺序固定为 session、message、part。',
          '打开或查询异常统一降级为 warning，不向 HTTP 层抛。',
          '关闭放在 finally，避免长期占用 WAL/SHM 阻塞 CLI 写入。',
        ],
      },
      {
        anchor: 'const inputStat = await stat(inputPath);',
        lines: [
          '目录与单文件两种输入：目录只扫一层，避免递归过深拖慢请求。',
          '只认 .jsonl/.log 并按文件名排序，保证多次读取顺序稳定。',
          '逐行解析：空行跳过，非对象与坏 JSON 只记 warning。',
          '行号是 1 基物理行号，前端据此回跳原始文件。',
          '单文件读失败不中断其余文件，告警最后合并成一条。',
        ],
      },
    ],
  },
  {
    file: 'apps/zcode-cli/packages/dynamic-workflow/src/testing/journal-contract-runs.ts',
    target: 35,
    header: [
      '// INV-01 用例只登记不另开 describe：守住位置 registerRunCases；改错故障 套件分组与拆分前不一致。',
      '// INV-02 用例顺序即拆分前顺序：守住位置 函数体线性排列；改错故障 报告顺序漂移、历史失败难以对比。',
      '// INV-03 终态与产物必须同笔写：守住位置 completed 结算用例；改错故障 崩溃窗口里出现「已完成但产物丢失」。',
      '// INV-04 缺席的结算袋不触碰 failure 与 result：守住位置 无结算袋用例；改错故障 历史行被清空。',
      '// INV-05 后到的终态整体改写失败三件套：守住位置 后续 completed 用例；改错故障 同一行同时说「完成」和「被打断」。',
      '// INV-06 非终态写入清空 settlement：守住位置 resume 翻转用例；改错故障 running 与陈旧 failure 并存。',
      '// INV-07 非终态携带结算袋按清空处理：守住位置 矛盾请求用例；改错故障 两个实现各自发明语义。',
      '// INV-08 产物可以是任意 JSON 值（含 null）：守住位置 it.each 表；改错故障 null 被塌成「没有产物」。',
      '// INV-09 产物与调用方对象隔离：守住位置 变更隔离用例；改错故障 存储内引用被外部改写。',
      '// INV-10 可选字段缺席必须原样缺席：守住位置 `in` 断言；改错故障 读出 null/undefined 占位键，两实现分叉。',
      '// INV-11 createRun 元数据列同属契约：守住位置 name/args/toolCallId/resumedFrom 用例；改错故障 SQLite 漏列导致恢复丢数据。',
      '// INV-12 结算不覆盖元数据列：守住位置 跨结算保留用例；改错故障 结算时丢名字、实参、锚点。',
      '// INV-13 用量与上界是独立窄写入：守住位置 usage 与 caps 用例；改错故障 恢复后从零计费、沿用旧上界。',
      '// INV-14 未知 run 的写入一律抛错：守住位置 三个 throw 用例；改错故障 静默无操作掩盖调度 bug。',
      '//',
      '// 模块职责：run 记录的建、结算、元数据、用量与上界契约用例，由 journal-contract.ts 按序调用。',
      '// 状态所有权：无；每个用例自建 store，互不共享。',
      '// 阅读顺序：先看建 run 与终态结算，再看元数据列契约，最后看用量与上界窄写入。',
    ],
    blocks: [
      {
        anchor: 'it("rejects duplicate run creation loudly", () => {',
        lines: [
          '重复建 run 必须显式失败，而不是覆盖既有记录。',
          '覆盖会让正在跑的 run 被静默替换，调度侧完全无感知。',
          '这里只断言抛错，不约束错误类型。',
        ],
      },
      {
        anchor: 'it("settles a stopped run with its reason and a ProviderStop failure", () => {',
        lines: [
          'stopped 与 stopReason 必须同笔落库，否则恢复时无法区分是谁停的。',
          'ProviderStop 的嵌套字段要整包往返，缺一层就丢失供应商上下文。',
          '结果字段保持缺席：停下不等于有产物。',
        ],
      },
      {
        anchor: 'it("leaves result absent when no settlement bag is passed", () => {',
        lines: [
          '无结算袋等于不触碰 failure 与 result，这是兼容旧行的关键语义。',
          '把它改成清空会让历史 completed 行丢掉产物。',
          '状态本身仍然要写成 completed。',
        ],
      },
      {
        anchor: 'it("clears a stale failure when a later settlement completes the run", () => {',
        lines: [
          '后到的 completed 必须整体改写失败三件套，而不是只补状态。',
          '否则同一行会同时说「已完成」和「被打断」。',
          'stopReason 也要一并清掉，产物保持新值。',
        ],
      },
      {
        anchor: 'it("round-trips a run name and keeps it absent when unnamed", () => {',
        lines: [
          'name 走 createRun 元数据路，两个实现必须逐字段一致。',
          '未命名时键要缺席，而不是 null 或 undefined 占位。',
          '用 `in` 判断而不是取空值比较，才能抓到占位键。',
        ],
      },
      {
        anchor: 'it("throws when updating an unknown run", () => {',
        lines: [
          '未知 run 的写入必须抛错，静默无操作会掩盖调度 bug。',
          '状态、用量、上界三个窄写入共用这条约定。',
        ],
      },
    ],
  },
  {
    file: 'docs/knip/docs/astro.config.ts',
    target: 31,
    header: [
      '// INV-01 site 与 base 固定：守住位置 顶层配置；改错故障 生成的绝对链接指向错误域名。',
      '// INV-02 trailingSlash 恒为 never：守住位置 顶层配置；改错故障 同一页面出现两种 URL，链接检查翻倍。',
      '// INV-03 旧路径靠 redirects 兜住：守住位置 redirects 表；改错故障 历史外链直接 404。',
      '// INV-04 remark 插件顺序固定：守住位置 remarkPlugins 数组；改错故障 指令转换早于链接修复，改写后的地址漏修。',
      '// INV-05 setForeground 只改命中的第一条规则：守住位置 find；改错故障 主题色被后续定义覆盖。',
      '// INV-06 未命中 scope 时静默跳过：守住位置 条件判断；改错故障 主题升级改名后构建直接崩。',
      '// INV-07 侧边栏按目录自动生成：守住位置 sidebar 配置；改错故障 新增文档不进导航。',
      '// INV-08 样式覆盖只写 CSS 变量：守住位置 styleOverrides；改错故障 深色主题下对比度失效。',
      '// INV-09 高亮样式表单独产出：守住位置 emitExternalStylesheet；改错故障 首屏内联体积膨胀。',
      '// INV-10 自定义主题必须返回同一对象：守住位置 customizeTheme 返回值；改错故障 高亮主题链断裂。',
      '//',
      '// 模块职责：knip 文档站（Astro 加 Starlight）的构建配置。',
      '// 阅读顺序：先看站点与重定向，再看 markdown 插件，最后看 Starlight 集成与代码高亮主题。',
    ],
    blocks: [
      {
        anchor: 'const setForeground = (theme: ExpressiveCodeTheme, scope: string, value: string) => {',
        lines: [
          '按 scope 片段匹配主题规则，而不是全等比较。',
          '只改第一条命中的规则：同名作用域后面的定义保持原样。',
          '找不到就静默返回，主题升级改名不应让构建失败。',
          '原地修改并返回同一个对象，避免复制出第二份主题。',
        ],
      },
      {
        anchor: 'export default defineConfig({',
        lines: [
          'site 与 base 决定绝对链接的生成基准。',
          'trailingSlash 固定为 never，保证同一页面只有一种 URL。',
          'redirects 兜住历史外链，文档改名不能只靠 404 通知。',
          'sitemap 显式关闭：文档站不需要额外索引产物。',
          '该对象只做装配，不在这里读取文件或环境变量。',
        ],
      },
      {
        anchor: 'markdown: {',
        lines: [
          '三个插件顺序固定：先修内部链接，再做指令转换，最后交给指令解析。',
          '顺序对调会让自定义指令在解析前就被当成普通文本。',
          '数组顺序即执行顺序，不要按字母序整理。',
        ],
      },
      {
        anchor: 'expressiveCode: {',
        lines: [
          '外部样式表单独产出，避免首屏内联整份高亮 CSS。',
          'styleOverrides 只覆盖 CSS 变量，不写死颜色值。',
          'frames 保留复制按钮，文档示例需要可复制。',
          '基础主题在 customizeTheme 里二次调色，不整体替换。',
        ],
      },
      {
        anchor: 'customizeTheme: theme => {',
        lines: [
          '按作用域改前景色：标签、类型与字符串三种。',
          '必须返回同一 theme，否则高亮链路拿不到主题。',
        ],
      },
    ],
  },
  {
    file: 'packages/client/src/websocket.ts',
    target: 31,
    header: [
      '// INV-01 二进制类型固定为 arraybuffer：守住位置 包装器首行；改错故障 收到 Blob，字节读取被迫异步化。',
      '// INV-02 每条 message 都包成 VSBuffer：守住位置 message 监听；改错故障 协议层拿到裸缓冲区，边界检查失效。',
      '// INV-03 close 与 error 都发射 close/end：守住位置 两个监听；改错故障 错误路径下等待方永远挂起。',
      '// INV-04 只有 OPEN 才写入：守住位置 write 判断；改错故障 关闭中发送抛 InvalidStateError。',
      '// INV-05 发送底层完整缓冲区：守住位置 ws.send 实参；改错故障 只发出视图片段。',
      '// INV-06 drain 恒为已完成：守住位置 Promise.resolve；改错故障 上层排空逻辑等不到回调。',
      '// INV-07 dispose 与 end 等价：守住位置 两个方法；改错故障 释放路径漏关连接。',
      '// INV-08 settled 只置一次：守住位置 open 回调；改错故障 重复决议被忽略但状态错乱。',
      '// INV-09 握手失败必须在交付前 reject：守住位置 error 与 close 分支；改错故障 调用方拿到永不完成的 Promise。',
      '// INV-10 先回调 onClose 再决定 reject：守住位置 close 监听内的顺序；改错故障 上层收不到关闭原因。',
      '// INV-11 关闭原因优先于状态码：守住位置 三元表达式；改错故障 用户只看得到 1006。',
      '// INV-12 协议接入点唯一：守住位置 connectViaProtocol；改错故障 出现第二套 RPC 装配路径。',
      '//',
      '// 模块职责：把浏览器 WebSocket 适配成 RPC 的 ISocket，并提供两条连接入口。',
      '// 状态所有权：settled 是单次连接的局部状态；Emitter 归包装对象所有。',
      '// 阅读顺序：先看包装器的事件与写入语义，再看连接 Promise 的失败路径，最后看协议装配。',
    ],
    blocks: [
      {
        anchor: 'ws.binaryType = "arraybuffer";',
        lines: [
          '强制二进制帧，避免收到 Blob 后还要异步读文本。',
          '这一行必须在注册监听前生效，否则首帧可能还是 Blob。',
        ],
      },
      {
        anchor: 'const onData = new Emitter<VSBuffer>();',
        lines: [
          '三个发射器分别对应数据、关闭与结束，协议层按事件订阅。',
          '包装对象只做适配，不缓存任何数据。',
        ],
      },
      {
        anchor: 'export function connectViaWebSocket(',
        lines: [
          '返回 Promise：只有握手完成后才交付 service access。',
          '连接期错误走 reject，运行期关闭走 onClose 回调，两条路分开。',
          'ws 在函数内创建，调用方拿不到未连接的实例。',
          '成功路径统一经 connectViaProtocol 装配，避免出现第二套 RPC 入口。',
          '这里不做重试：重连策略属于上层控制器。',
        ],
      },
      {
        anchor: 'let settled = false;',
        lines: [
          'settled 只置一次：open 之后到达的 error 与 close 不再 reject。',
          '它同时表示「握手成功」与「Promise 已决议」。',
          '不要改用 readyState 判断，关闭后无法区分是否已交付。',
        ],
      },
      {
        anchor: 'ws.addEventListener("open", () => {',
        lines: [
          '先把 settled 置真再回调外部，避免回调里同步关闭造成二次决议。',
          'onOpenSocket 暴露原始 ws，供调用方接管心跳等能力。',
          '包装后的 socket 交给 SocketProtocol，写入语义由包装器保证。',
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
    `ZC-deep-b198-spec-${index}.json`,
    JSON.stringify({ files: [{ file: spec.file, items }] }, null, 2),
    'utf8',
  );
  console.log(`spec ${index}: ${spec.file} lines=${total}`);
  index += 1;
}
