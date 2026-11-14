import fs from 'node:fs';

const specs = [
  {
    file: 'packages/shared/src/sqlite-migrations/backup.ts',
    target: 42,
    header: [
      '// INV-01 空表不建备份：守住位置 全表列数为零判断；改错故障 首次安装制造空备份。',
      '// INV-02 保留份数固定：守住位置 常量；改错故障 备份目录无限膨胀。',
      '// INV-03 空间估算含余量：守住位置 余量常量；改错故障 写到一半磁盘满。',
      '// INV-04 估算按字节加倍：守住位置 末尾乘二；改错故障 压缩后仍可能超限。',
      '// INV-05 二进制按字节长度：守住位置 类型判断；改错故障 图片列被低估。',
      '// INV-06 候选目录去重：守住位置 集合；改错故障 同一目录被尝试两次。',
      '// INV-07 主目录优先：守住位置 生成顺序；改错故障 备份落到外接盘。',
      '// INV-08 权限最小：守住位置 目录与文件模式；改错故障 他人可读数据库副本。',
      '// INV-09 备份库单事务：守住位置 提交与回滚；改错故障 半截表结构留下。',
      '// INV-10 失败目录即时清理：守住位置 捕获分支；改错故障 残留半成品目录。',
      '// INV-11 非空间错误继续抛：守住位置 异常过滤；改错故障 真实缺陷被吞掉。',
      '// INV-12 不可用卷换下一个：守住位置 跳过分支；改错故障 只读盘让迁移直接失败。',
      '// INV-13 全部失败仍写元数据：守住位置 兜底写入；改错故障 用户不知道备份被跳过。',
      '// INV-14 跳过原因写进元数据：守住位置 字段赋值；改错故障 启动提示没有依据。',
      '// INV-15 回调通知跳过：守住位置 调用点；改错故障 上层无法提示。',
      '// INV-16 只清理自己的目录：守住位置 前缀过滤；改错故障 误删用户文件夹。',
      '// INV-17 缺元数据不清理：守住位置 读取判断；改错故障 半成品被当垃圾删除。',
      '// INV-18 当前目录不清理：守住位置 路径比较；改错故障 刚写好的备份被删。',
      '//',
      '// 模块职责：迁移前的表快照备份、空间检查与保留份数裁剪。',
      '// 状态所有权：无长期状态，目录与回调由调用方注入。',
      '// 阅读顺序：先看备份主流程，再看空间估算，最后看裁剪与目录枚举。',
    ],
    blocks: [
      {
        anchor: 'export async function createMigrationBackup(',
        lines: [
          '涉及表先去重再快照。',
          '全空表直接跳过。',
          '元数据不含行数据。',
          '目录按优先级逐个尝试。',
          '空间不足换下一个目录。',
        ],
      },
      {
        anchor: 'function estimateBytes(tables: TableSnapshot[]): number {',
        lines: [
          '固定余量先计入。',
          '每格至少三十二字节。',
          '二进制按真实长度。',
          '其余按 UTF-8 字节数。',
          '总量乘二留浮动空间。',
        ],
      },
      {
        anchor: 'function isUnavailableVolume(error: unknown): boolean {',
        lines: [
          '只认对象形态的错误。',
          '必须带码字段。',
          '空间与权限归为不可用。',
          '其他错误原样抛出。',
          '不吞掉程序缺陷。',
        ],
      },
      {
        anchor: 'async function pruneBackups(directory: string, prefix: string, current: string): Promise<void> {',
        lines: [
          '只扫描同前缀目录。',
          '无元数据的目录跳过。',
          '保留额度含当前目录。',
          '超出部分递归删除。',
          '不触碰普通文件。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/app-shell/useWorkspaceSessionReload.ts',
    target: 42,
    header: [
      '// INV-01 防抖在入口：守住位置 时间窗判断；改错故障 双击并发重建同一工作区。',
      '// INV-02 禁用或进行中直接返回：守住位置 早退条件；改错故障 重建过程中再次发起。',
      '// INV-03 先置进行中再发起：守住位置 状态顺序；改错故障 按钮仍可点击。',
      '// INV-04 身份只取活动标签：守住位置 选择器；改错故障 别的工作区身份串台。',
      '// INV-05 标识不匹配返回空：守住位置 路径比较；改错故障 草稿写到错误区域。',
      '// INV-06 提供者三级回退：守住位置 选项与作用域；改错故障 使用未选中的提供者。',
      '// INV-07 恢复任务优先：守住位置 裁剪后或运算；改错故障 有活跃任务时仍重新准备。',
      '// INV-08 重建前先写初始化态：守住位置 显式赋值；改错故障 界面停留在旧状态。',
      '// INV-09 准备阶段先清旧错误：守住位置 清空调用；改错故障 输入区残留上一轮报错。',
      '// INV-10 准备结果按提供者校验：守住位置 二次比较；改错故障 旧选项覆盖新选项。',
      '// INV-11 成功后重置重试计数：守住位置 归零调用；改错故障 重试次数只增不减。',
      '// INV-12 失败写标准化草稿错误：守住位置 工厂函数；改错故障 聊天区只有提示条。',
      '// INV-13 失败回写配置状态：守住位置 错误分支；改错故障 选项面板一直转圈。',
      '// INV-14 无论成败释放进行中：守住位置 收尾分支；改错故障 按钮永久禁用。',
      '// INV-15 成功与失败都提示：守住位置 两处提示；改错故障 用户不知道结果。',
      '// INV-16 依赖数组只放稳定引用：守住位置 依赖列表；改错故障 回调每次渲染重建。',
      '// INV-17 操作结束才落完成态：守住位置 调用顺序；改错故障 半途被标记完成。',
      '// INV-18 日志带工作区与提供者：守住位置 模板参数；改错故障 多工作区无法定位。',
      '//',
      '// 模块职责：工作区会话重建的入口、状态编排与错误回填。',
      '// 状态所有权：进行中标志归本地；初始化态与配置态写入会话 store。',
      '// 阅读顺序：先看身份解析与防抖，再看重建流程，最后看成功与失败收尾。',
    ],
    blocks: [
      {
        anchor: 'const workspaceIdentity = useTabStore((state) => {',
        lines: [
          '无活动标签返回空。',
          '只接受工作区标签。',
          '路径必须与入参一致。',
          '返回该标签的身份。',
          '选择器只读 store。',
        ],
      },
      {
        anchor: 'const handleReloadSession = useCallback(',
        lines: [
          '入口先判禁用与进行中。',
          '时间窗内重复请求被忽略。',
          '通过后立即置进行中。',
          '依赖全部来自参数与选择器。',
          '返回稳定回调。',
        ],
      },
      {
        anchor: 'await services.zcodeTaskService.restartWorkspaceProcess({',
        lines: [
          '重建服务是唯一入口。',
          '提供者与恢复任务一并传入。',
          '身份仅在存在时附带。',
          '准备阶段与重建阶段串行。',
          '准备结果按提供者二次校验。',
        ],
      },
      {
        anchor: '} catch (error) {',
        lines: [
          '失败统一转标准草稿错误。',
          '初始化态写失败原因。',
          '准备失败再写配置错误态。',
          '详细错误回填输入区。',
          '无论成败都释放进行中。',
        ],
      },
    ],
  },
  {
    file: 'packages/desktop/src/main/pluginSandbox/guestPolicy.ts',
    target: 42,
    header: [
      '// INV-01 只认沙箱协议：守住位置 前缀判断；改错故障 普通页面被当成沙箱 guest。',
      '// INV-02 三重匹配才放行：守住位置 标识、分区、所有者；改错故障 其他窗口挂载插件。',
      '// INV-03 地址必须逐字相等：守住位置 全等比较；改错故障 相近地址借用已注册沙箱。',
      '// INV-04 未注册沙箱拒绝：守住位置 记录查找；改错故障 伪造标识进入。',
      '// INV-05 分区不匹配拒绝：守住位置 字段比较；改错故障 复用宿主会话分区。',
      '// INV-06 所有者不匹配拒绝：守住位置 窗口标识比较；改错故障 跨窗口挂载。',
      '// INV-07 沙箱偏好硬编码：守住位置 逐项赋值；改错故障 参数可覆盖安全设置。',
      '// INV-08 预加载脚本由主进程指定：守住位置 覆盖赋值；改错故障 guest 自带预加载。',
      '// INV-09 删除可注入偏好：守住位置 逐项删除；改错故障 参数绕过加固。',
      '// INV-10 弹出窗口一律拒绝：守住位置 窗口打开处理器；改错故障 插件弹出新窗口。',
      '// INV-11 导航白名单两个来源：守住位置 来源集合；改错故障 插件域被误拦。',
      '// INV-12 主框架与子框架同规则：守住位置 两种导航事件；改错故障 子框架跳转外站。',
      '// INV-13 挂载即 pin：守住位置 注册表调用；改错故障 活实例被容量淘汰。',
      '// INV-14 销毁即 unpin：守住位置 一次性监听；改错故障 已销毁实例占额度。',
      '// INV-15 端口随清理关闭：守住位置 返回函数；改错故障 消息端口泄漏。',
      '// INV-16 先宿主再 guest：守住位置 发送顺序；改错故障 初始化消息因宿主未就绪丢失。',
      '// INV-17 权限转成 iframe 白名单：守住位置 允许列表构造；改错故障 插件权限全部失效。',
      '// INV-18 调试日志不落 info：守住位置 等级判断；改错故障 协议日志刷满磁盘。',
      '//',
      '// 模块职责：插件沙箱 webview 的偏好加固、导航限制与端口建立。',
      '// 状态所有权：pin 与端口生命周期绑定本函数，注册表由调用方持有。',
      '// 阅读顺序：先看地址识别与偏好加固，再看挂载策略，最后看 pin 与端口。',
    ],
    blocks: [
      {
        anchor: 'export function configurePluginSandboxGuest(input: {',
        lines: [
          '地址解析失败直接拒绝。',
          '只接受 shell 类型。',
          '注册记录必须存在。',
          '分区与所有者逐项比对。',
          '返回放行标识。',
        ],
      },
      {
        anchor: 'input.webPreferences.preload = input.preloadPath;',
        lines: [
          '预加载路径由主进程给出。',
          '上下文隔离与沙箱同时开启。',
          '子框架 Node 能力关闭。',
          'webview 标签关闭。',
          '可注入偏好逐项删除。',
        ],
      },
      {
        anchor: 'export function attachPluginSandboxGuest(input: AttachPluginSandboxGuestInput): () => void {',
        lines: [
          '未注册沙箱只记警告。',
          '允许来源含 shell 与插件域。',
          '挂载即 pin。',
          '销毁只解一次 pin。',
          '清理时关闭全部端口。',
        ],
      },
      {
        anchor: 'input.guest.once("dom-ready", () => {',
        lines: [
          '登记前再查一次注册表。',
          '任一侧已销毁则放弃。',
          '先发宿主再发 guest。',
          '负载带标识与初始化号。',
          '权限转成允许列表。',
        ],
      },
    ],
  },
  {
    file: 'packages/provider-node/src/personal-provider-config-repository.ts',
    target: 58,
    header: [
      '// INV-01 空路径直接拒绝：守住位置 构造函数校验；改错故障 配置写到进程目录。',
      '// INV-02 轮询间隔必须为正：守住位置 数值校验；改错故障 零间隔忙轮询。',
      '// INV-03 可整体关闭轮询：守住位置 假值分支；改错故障 无法禁用后台轮询。',
      '// INV-04 读路径不加锁：守住位置 纯读分支；改错故障 慢 IO 放大成锁超时。',
      '// INV-05 需要写盘才加锁：守住位置 规范化差异判断；改错故障 旧内容覆盖其他写者。',
      '// INV-06 锁内必须重读：守住位置 锁定后读取；改错故障 用加锁前快照覆盖。',
      '// INV-07 写前先规范化校验：守住位置 编解码往返；改错故障 越权来源落盘。',
      '// INV-08 版本基于规范形态：守住位置 同一编码函数；改错故障 写成功即读回变化。',
      '// INV-09 原子写私有文件：守住位置 共享工具；改错故障 他人可读配置。',
      '// INV-10 写后记录版本：守住位置 版本赋值；改错故障 自身写入触发失效通知。',
      '// INV-11 旧轮询结果丢弃：守住位置 世代比较；改错故障 版本倒退。',
      '// INV-12 相同版本不通知：守住位置 版本相等判断；改错故障 重复刷新界面。',
      '// INV-13 损坏文件不覆盖：守住位置 恢复分支；改错故障 用户配置被清空。',
      '// INV-14 恢复回调不阻断：守住位置 捕获分支；改错故障 观测异常导致读取失败。',
      '// INV-15 轮询错误只报一次：守住位置 活跃标志；改错故障 每分钟刷错误。',
      '// INV-16 轮询在飞不重复排期：守住位置 状态组合；改错故障 定时器叠加。',
      '// INV-17 定时器不阻塞退出：守住位置 取消引用；改错故障 进程无法自然结束。',
      '// INV-18 快照与版本同源：守住位置 同一编码内容；改错故障 范围校验误报变化。',
      '//',
      '// 模块职责：个人 Provider 配置文件的读写、轮询与损坏恢复。',
      '// 状态所有权：文件内容以磁盘为准，本类仅持有观察版本与轮询状态。',
      '// 阅读顺序：先看读写与锁，再看版本与恢复，最后看轮询与通知。',
    ],
    blocks: [
      {
        anchor: 'async read(): Promise<ProviderConfigLayerSnapshot> {',
        lines: [
          '关闭后调用直接报错。',
          '优先走无锁读取。',
          '首次读取记录观察版本。',
          '异常进入恢复分支且不写盘。',
          '读取结束确保轮询启动。',
          '返回值与磁盘内容同源。',
        ],
      },
      {
        anchor: 'async update(',
        lines: [
          '写路径全程持锁。',
          '锁内重读当前内容。',
          '变换结果冻结为更新。',
          '写入返回规范形态。',
          '成功后广播更新。',
          '异常原样抛出。',
        ],
      },
      {
        anchor: 'async #readCurrent(): Promise<ProviderConfigLayerSnapshot> {',
        lines: [
          '纯读不加锁。',
          '文件缺失且无导入时返回空。',
          '内容已规范则直接返回。',
          '需要写盘才进锁。',
          '锁内重新读取。',
          '规范化差异决定是否落盘。',
        ],
      },
      {
        anchor: '#recoverInvalidFile(error: unknown): ProviderConfigLayerSnapshot {',
        lines: [
          '原文件保留不覆盖。',
          '只以内存空层降级。',
          '上报恢复事件。',
          '回调异常不外泄。',
          '返回空配置快照。',
          '等待用户修复原文件。',
        ],
      },
      {
        anchor: '#ensurePolling(): void {',
        lines: [
          '关闭轮询直接返回。',
          '已有定时器不重排。',
          '轮询在飞不排期。',
          '已销毁不再排期。',
          '定时器不阻塞退出。',
          '到期清引用再执行。',
        ],
      },
      {
        anchor: 'async #pollOnce(): Promise<void> {',
        lines: [
          '进入即标记在飞。',
          '先记当前写世代。',
          '读取不持锁。',
          '世代变化丢弃本轮。',
          '新版本更新观察值并广播。',
          '收尾复位并重新排期。',
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
  fs.writeFileSync(`ZC-deep-b127-spec-${index}.json`, JSON.stringify({ files: [{ file: spec.file, items }] }, null, 2), 'utf8');
  console.log(`spec ${index}: ${spec.file} lines=${total}`);
  index += 1;
}
