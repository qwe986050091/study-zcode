import fs from 'node:fs';

const specs = [
  {
    file: 'packages/desktop/scripts/gen-ui-fixture/standalone-checks.ts',
    target: 40,
    header: [
      '// INV-01 隐藏窗口承载导出页：守住位置 构造；改错故障 校验期间弹出可见窗口。',
      '// INV-02 沙箱必须开启：守住位置 webPreferences；改错故障 导出页获得 Node 能力。',
      '// INV-03 只认 srcdoc 子帧：守住位置 frame 查找；改错故障 校验打到主页面而非导出内容。',
      '// INV-04 加载等待覆盖两种时序：守住位置 Promise；改错故障 快加载时永久挂起。',
      '// INV-05 两种主题都验字号：守住位置 循环；改错故障 只验浅色主题漏掉深色回归。',
      '// INV-06 主色随主题反转：守住位置 断言；改错故障 深色模式按钮对比度不足。',
      '// INV-07 调试器附着后才发命令：守住位置 顺序；改错故障 命令无会话直接失败。',
      '// INV-08 命令统一带 sessionId：守住位置 send 包装；改错故障 命令落到浏览器级而非页面级。',
      '// INV-09 触摸仿真在 finally 复位：守住位置 清理块；改错故障 后续用例继承移动端度量。',
      '// INV-10 三个仿真开关都要关：守住位置 清理；改错故障 鼠标事件仍被转成触摸。',
      '// INV-11 调试器必须解绑：守住位置 清理末尾；改错故障 下一次附着报已附加。',
      '// INV-12 导出页不得有 require：守住位置 断言；改错故障 隔离边界被悄悄放开。',
      '// INV-13 初始计数为零：守住位置 断言；改错故障 导出页带入了构建期状态。',
      '// INV-14 第三方库版本锁定：守住位置 断言；改错故障 升级依赖后图表行为变化无人察觉。',
      '// INV-15 工具提示可离屏触发：守住位置 等待逻辑；改错故障 触摸端提示无法验证。',
      '// INV-16 状态持久化只走本地：守住位置 断言；改错故障 导出页尝试写远端存储。',
      '// INV-17 重载后状态回灌：守住位置 第二次加载；改错故障 持久化只写不读。',
      '// INV-18 窗口最终必销毁：守住位置 外层 finally；改错故障 校验失败后进程残留窗口。',
      '//',
      '// 模块职责：在真实 Chromium 中校验导出页的样式、隔离与交互能力。',
      '// 状态所有权：临时窗口与调试会话都在本函数内创建并释放。',
      '// 阅读顺序：先看窗口与加载，再看两轮主题断言，最后看触摸仿真与清理。',
    ],
    blocks: [
      {
        anchor: 'export async function checkStandalone(root: string) {',
        lines: [
          '窗口全程隐藏且开启沙箱。',
          '加载动作抽成可复用函数。',
          '两种主题共用同一套断言。',
          '调试会话在主题轮询之后建立。',
          '失败也必须销毁窗口。',
        ],
      },
      {
        anchor: 'const load = async () => {',
        lines: [
          '加载完成以子帧出现为准。',
          '导出内容必须位于隔离子帧。',
          '等待逻辑兼容已完成与未完成。',
          '返回子帧供后续断言复用。',
          '重复调用会重新导航。',
        ],
      },
      {
        anchor: 'let frame = await load();',
        lines: [
          '主题通过根节点数据属性切换。',
          '探针元素插入后立即测量。',
          '断言完即移除探针。',
          '两轮主题结束时再进入调试段。',
        ],
      },
      {
        anchor: 'win.destroy();',
        lines: [
          '销毁发生在最外层清理。',
          '调试器在销毁前已解绑。',
          '异常路径同样走到这里。',
          '不保留任何全局引用。',
        ],
      },
    ],
  },
  {
    file: 'packages/desktop/src/host/browserControlMainBridge.ts',
    target: 43,
    header: [
      '// INV-01 requestId 是唯一关联键：守住位置 pending 映射；改错故障 结果交给错误调用方。',
      '// INV-02 重复 requestId 必须拒绝：守住位置 transport 之前；改错故障 旧等待被新请求覆盖。',
      '// INV-03 删除只走条件删除：守住位置 deletePendingIfCurrent；改错故障 旧定时器删掉新请求。',
      '// INV-04 校验先于发送：守住位置 execute 前置；改错故障 失败请求仍产生副作用。',
      '// INV-05 代际不符按不可用：守住位置 第二个校验；改错故障 旧 Host 命令打向新 browser。',
      '// INV-06 clientMode 每次透传：守住位置 消息体；改错故障 连续模式退化成单次模式。',
      '// INV-07 超时预算按命令放大：守住位置 requestTimeoutMs；改错故障 长等待被提前判超时。',
      '// INV-08 超时后反发取消：守住位置 定时器回调；改错故障 远端动作继续执行而调用方已放弃。',
      '// INV-09 副作用不确定要标注：守住位置 mayHaveSideEffects；改错故障 超时谎报无副作用。',
      '// INV-10 所有分支都 resolve：守住位置 execute；改错故障 调用方 await 永久挂起。',
      '// INV-11 发送失败清账并结算：守住位置 catch；改错故障 pending 泄漏且定时器仍在跑。',
      '// INV-12 迟到结果直接忽略：守住位置 handleResult 首判；改错故障 已超时请求被二次结算。',
      '// INV-13 落盘先于回传：守住位置 录制分支；改错故障 调用方拿到模板路径而非实体文件。',
      '// INV-14 无落盘口时剥临时路径：守住位置 分支；改错故障 桌面临时路径泄露给调用方。',
      '// INV-15 落盘失败转执行错误：守住位置 catch；改错故障 异常穿透导致消息分派中断。',
      '// INV-16 dispose 逐个结算：守住位置 循环；改错故障 等待中的调用永久悬空。',
      '// INV-17 dispose 不清外部监听：守住位置 注释与实现；改错故障 结果分派被摘除。',
      '// INV-18 描述符只列可选能力：守住位置 capability 列表；改错故障 核心 API 被伪装成可选。',
      '//',
      '// 模块职责：在 host 侧把浏览器命令转发给 main，并关联回传结果。',
      '// 状态所有权：pending 映射与固定 browserId、generation 归桥实例。',
      '// 阅读顺序：先看类型与默认预算，再看 execute，最后看 handleResult 与 dispose。',
    ],
    blocks: [
      {
        anchor: '}): BrowserControlMainBridge {',
        lines: [
          'pending 以请求标识为键。',
          '实例创建即固定 browserId。',
          'generation 取创建时刻。',
          '条件删除防止误删后继请求。',
          '描述符只声明一个可选能力。',
          '能力数组顺序不影响解析。',
        ],
      },
      {
        anchor: 'const requestId = inputRequestId ?? randomUUID();',
        lines: [
          '缺省标识由调用方或此处生成。',
          '重复标识在发送前返回错误。',
          '该错误明确标注无副作用。',
          '校验顺序保证失败不落远端。',
          '开始时间随后记录。',
        ],
      },
      {
        anchor: 'const requestTimeoutMs =',
        lines: [
          '固定等待单独加传输余量。',
          '脚本命令按其自身预算计算。',
          '其余命令用桥默认预算。',
          '两层预留避免同时到期限。',
          '预算只影响本地等待。',
        ],
      },
      {
        anchor: 'const timer = setTimeout(() => {',
        lines: [
          '超时先做条件删除。',
          '随后反向发送取消命令。',
          '取消失败不覆盖超时结果。',
          '副作用按命令保守判定。',
          '结果始终 resolve 不 reject。',
        ],
      },
    ],
  },
  {
    file: 'packages/desktop/src/host/remoteWorkspaceServiceCollection.ts',
    target: 42,
    header: [
      '// INV-01 注册清单与合同逐项一致：守住位置 自检；改错故障 合同声明支持却报未知通道。',
      '// INV-02 合同校验最先执行：守住位置 函数首行；改错故障 装配到一半才失败。',
      '// INV-03 缺项整体抛错：守住位置 自检末尾；改错故障 返回半套服务面难以定位。',
      '// INV-04 远端面只做转发：守住位置 注册表；改错故障 本地实现悄悄顶替远端能力。',
      '// INV-05 本机配置单独注入：守住位置 客户端配置项；改错故障 远端覆盖本机私有设置。',
      '// INV-06 分享能力按目标类型：守住位置 三元分支；改错故障 不支持的场景给出假实现。',
      '// INV-07 虚拟项目要求双服务：守住位置 virtualProjects 分支；改错故障 缺项时静默降级。',
      '// INV-08 新频道以握手为准：守住位置 注释与校验；改错故障 用对象存在性判断旧服务端能力。',
      '// INV-09 广播按通道分流：守住位置 包装实现；改错故障 任务组消息被误发到远端。',
      '// INV-10 分流依赖两端都在：守住位置 条件判断；改错故障 单侧缺失时丢订阅。',
      '// INV-11 订阅返回合并句柄：守住位置 onMessage；改错故障 退订只退一侧留下泄漏。',
      '// INV-12 领用类操作全部下沉：守住位置 转发方法；改错故障 本地领用状态与远端分叉。',
      '// INV-13 单根项目按 hostId 过滤：守住位置 过滤；改错故障 混入其他服务端工作区。',
      '// INV-14 兼容旧工作区字段：守住位置 分支；改错故障 老数据目录从列表消失。',
      '// INV-15 任务查询按种类分派：守住位置 三元链；改错故障 置顶与归档视图互相串数据。',
      '// INV-16 配置下发单向：守住位置 Provisioning；改错故障 远端反向改写本机 Provider。',
      '// INV-17 副作用限定注入范围：守住位置 装配末尾；改错故障 全局执行器被多处复用。',
      '// INV-18 诊断日志按服务分域：守住位置 日志器构造；改错故障 日志无法按能力过滤。',
      '//',
      '// 模块职责：把远端 RPC 服务面装配为 Host 本地可用的服务集合。',
      '// 状态所有权：函数式装配；集合与执行器都由本次调用创建。',
      '// 阅读顺序：先看注册清单，再看项目服务适配，最后看集合装配与自检。',
    ],
    blocks: [
      {
        anchor: 'export const REMOTE_WORKSPACE_RPC_REGISTRATIONS = [',
        lines: [
          '每项是访问键与描述符配对。',
          '顺序只影响诊断可读性。',
          '新增项必须同步更新合同。',
          '清单同时用作自检依据。',
          '只读断言保证键类型收敛。',
        ],
      },
      {
        anchor: '}): IProjectService {',
        lines: [
          '虚拟项目直接复用远端服务。',
          '缺远端项目服务立即抛错。',
          '单根项目的 hostId 由标识推导。',
          '目录与设置读取全部下沉远端。',
          '已知工作区按 hostId 过滤后展开。',
        ],
      },
      {
        anchor: '}): ServiceCollection {',
        lines: [
          '首行先做合同校验。',
          '执行器在装配前创建。',
          '其余通道按清单逐项注册。',
          '虚拟项目分支要求双服务齐备。',
          '自检在注入执行器之前完成。',
        ],
      },
      {
        anchor: 'const controllerGroups = params.sourceServices?.getOptional(ITaskGroupService);',
        lines: [
          '控制面服务取自本机来源。',
          '两端都存在才做通道分流。',
          '任务组状态只走本机广播。',
          '其余通道仍走远端广播。',
          '订阅句柄同时释放两侧。',
        ],
      },
    ],
  },
  {
    file: 'packages/desktop/src/main/desktopNetworkPolicy.ts',
    target: 40,
    header: [
      '// INV-01 两个出口分别配置：守住位置 targets；改错故障 内置浏览器继续无代理直连。',
      '// INV-02 单一出口失败不阻断另一个：守住位置 逐个捕获；改错故障 浏览器与渲染进程策略漂移。',
      '// INV-03 渲染进程兜底直连：守住位置 fallback 字段；改错故障 本机系统代理影响后端调用。',
      '// INV-04 浏览器兜底跟随系统：守住位置 fallback 字段；改错故障 需代理的站点直接超时。',
      '// INV-05 证书放行只给浏览器：守住位置 allowInsecure；改错故障 整个应用失去传输层保护。',
      '// INV-06 放行优先于自定义根：守住位置 三元分支；改错故障 开了开关仍被自定义校验拒绝。',
      '// INV-07 代理变更后立即断开旧连接：守住位置 closeAllConnections；改错故障 旧连接继续走旧代理。',
      '// INV-08 留空不写绕过规则：守住位置 早退；改错故障 系统模式下出现无意义的绕过表。',
      '// INV-09 代理地址补协议头：守住位置 归一化；改错故障 裸主机名被解析失败。',
      '// INV-10 只保留协议主机与鉴权：守住位置 重建；改错故障 路径与查询串混进代理规则。',
      '// INV-11 解析失败按未配置：守住位置 捕获；改错故障 非法代理让应用无法启动。',
      '// INV-12 绕过规则去空白去空项：守住位置 归一化；改错故障 规则里有空条目导致匹配失败。',
      '// INV-13 自定义根为空返回空实现：守住位置 早退；改错故障 空配置把全部证书错误放行。',
      '// INV-14 证书块缺失视为空集：守住位置 空值合并；改错故障 无证书 PEM 让断言崩溃。',
      '// INV-15 链深度有上限：守住位置 循环条件；改错故障 环形签发链导致死循环。',
      '// INV-16 链路指纹去重：守住位置 seen 集合；改错故障 重复证书节点拖慢校验。',
      '// INV-17 命中链上任一证书即放行：守住位置 返回；改错故障 中间证书根签发的站点被拒。',
      '// INV-18 未命中一律走默认校验：守住位置 末尾回调；改错故障 校验失败被当成放行。',
      '//',
      '// 模块职责：为 Electron 会话配置代理、证书校验与出口策略。',
      '// 状态所有权：无状态；所有改动都作用在传入的 Session 上。',
      '// 阅读顺序：先看出口策略，再看代理构造，最后看证书链路匹配。',
    ],
    blocks: [
      {
        anchor: 'const targets = [',
        lines: [
          '默认会话不放行不安全证书。',
          '内置浏览器使用独立分区。',
          '两个出口的兜底策略不同。',
          '目标表在调用时固定。',
          '逐个应用避免相互阻断。',
        ],
      },
      {
        anchor: 'const proxyConfig = buildElectronProxyConfig(',
        lines: [
          '代理配置由设置与兜底共同决定。',
          '设置后立即断开旧连接。',
          '证书校验按放行开关二选一。',
          '日志只记录状态不记录地址。',
          '本函数不读取环境变量。',
        ],
      },
      {
        anchor: 'const trimmed = caCertPath?.trim();',
        lines: [
          '空路径返回空实现。',
          '读取失败只告警不抛错。',
          '文件无证书按未配置处理。',
          '指纹集合交给下一步构造。',
        ],
      },
      {
        anchor: 'let current: CertificateLike | null | undefined = certificate;',
        lines: [
          '从叶子证书向上遍历。',
          '每层先取指纹再查集合。',
          '命中即判定可信。',
          '深度超限按不匹配处理。',
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
    items.push({ anchor: block.anchor, lines: block.lines });
  }
  const total = spec.header.length + spec.blocks.reduce((n, b) => n + b.lines.length, 0);
  if (total !== spec.target) {
    console.error(`TARGET MISMATCH ${spec.file}: ${total} != ${spec.target}`);
    process.exit(1);
  }
  fs.writeFileSync(
    `ZC-deep-b144-spec-${index}.json`,
    JSON.stringify({ files: [{ file: spec.file, items }] }, null, 2),
    'utf8',
  );
  console.log(`spec ${index}: ${spec.file} lines=${total}`);
  index += 1;
}
