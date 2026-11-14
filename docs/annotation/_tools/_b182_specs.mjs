import fs from 'node:fs';

const specs = [
  {
    file: 'packages/desktop/src/main/desktopWebRemoteControlIpc.ts',
    target: 35,
    header: [
      '// INV-01 埋点失败不影响业务终态：守住位置 旁路捕获；改错故障 启动成功被误判为失败。',
      '// INV-02 窗口缺失显式报错：守住位置 缺失判断；改错故障 用无效窗口标识继续启动。',
      '// INV-03 成功后才上报成功：守住位置 上报位置；改错故障 启动失败也记成功。',
      '// INV-04 失败附带错误分类：守住位置 分类调用；改错故障 遥测只能看到笼统失败。',
      '// INV-05 失败后原样抛出：守住位置 重抛语句；改错故障 渲染进程收不到错误原因。',
      '// INV-06 工作区类型只看上下文：守住位置 空值或运算；改错故障 本地会话被记成远端。',
      '// INV-07 远端类型解析可缺席：守住位置 条件解析；改错故障 非法身份导致上报异常。',
      '// INV-08 授权与启动分两步：守住位置 两次调用；改错故障 未授权也能启动。',
      '// INV-09 授权在启动前完成：守住位置 语句顺序；改错故障 启动读到过期授权。',
      '// INV-10 状态变更通知不阻塞：守住位置 不等待调用；改错故障 通知卡住主进程。',
      '// INV-11 通知异常不外泄：守住位置 空捕获；改错故障 未处理拒绝拖垮进程。',
      '// INV-12 载荷先校验再用：守住位置 安全解析；改错故障 畸形载荷写入管理器。',
      '// INV-13 校验失败静默返回：守住位置 早退分支；改错故障 非法通知触发崩溃。',
      '// INV-14 停止只对真实窗口生效：守住位置 窗口判断；改错故障 空窗口调用停止报错。',
      '// INV-15 状态查询缺窗口回空闲：守住位置 三元兜底；改错故障 状态接口直接抛异常。',
      '// INV-16 通道名集中取自常量：守住位置 通道常量；改错故障 主渲染两侧通道名漂移。',
      '// INV-17 管理器能力通过依赖注入：守住位置 依赖接口；改错故障 单测必须启动完整管理器。',
      '// INV-18 注册函数只接线不持状态：守住位置 函数职责；改错故障 多次注册叠加监听。',
      '//',
      '// 模块职责：把 Web 远程控制的授权、启动、通知、停止与查询接到 IPC。',
      '// 状态所有权：无状态；管理器与遥测上报全部由依赖注入。',
      '// 阅读顺序：先看管理器接口，再看启动操作，最后看四个通道注册。',
    ],
    blocks: [
      {
        anchor: 'export interface WebRemoteControlIpcManager {',
        lines: [
          '五个能力覆盖授权、启动、通知、停止与查询。',
          '管理器由依赖注入。',
          '接口不暴露 Electron 类型。',
        ],
      },
      {
        anchor: 'function reportRemoteUsageEventSafely(',
        lines: [
          '埋点是旁路能力。',
          '捕获后不改变业务终态。',
          '调用方原本的错误继续抛出。',
        ],
      },
      {
        anchor: 'async function runStartOperation(input: {',
        lines: [
          '工作区类型先于操作计算。',
          '窗口缺失立即报错。',
          '成功与失败各上报一次。',
          '失败原样抛出。',
        ],
      },
      {
        anchor: 'export function registerWebRemoteControlIpcHandlers(',
        lines: [
          '三个 handle 与一个监听。',
          '状态查询缺窗口回空闲。',
          '通知不阻塞主进程。',
        ],
      },
    ],
  },
  {
    file: 'packages/desktop/src/main/desktopMainIpcHelpers.ts',
    target: 34,
    header: [
      '// INV-01 空路径直接失败：守住位置 去空判断；改错故障 系统弹窗报无意义错误。',
      '// INV-02 失败返回结构而非抛出：守住位置 返回值形状；改错故障 调用方需要额外捕获。',
      '// INV-03 先规范化再解析真实路径：守住位置 语句顺序；改错故障 符号链接打开错误目标。',
      '// INV-04 真实路径失败仍可回退：守住位置 捕获分支；改错故障 不存在的路径直接放弃。',
      '// INV-05 打开失败记录上下文：守住位置 日志字段；改错故障 只看到一句失败。',
      '// INV-06 成功也记录目标路径：守住位置 信息日志；改错故障 排查时看不到实际打开对象。',
      '// INV-07 错误对象取消息文本：守住位置 类型分支；改错故障 日志出现对象占位。',
      '// INV-08 文件管理器失败同样记日志：守住位置 错误分支；改错故障 目录打不开毫无痕迹。',
      '// INV-09 平台差异集中在一处：守住位置 平台判断；改错故障 苹果系统打开目录行为退化。',
      '// INV-10 截图前校验窗口可用：守住位置 空值与销毁判断；改错故障 窗口关闭后截图崩溃。',
      '// INV-11 截图在进程内完成：守住位置 调用位置；改错故障 需要屏幕录制权限。',
      '// INV-12 文件名自带时间戳：守住位置 模板拼接；改错故障 多次反馈互相覆盖。',
      '// INV-13 文件名替换非法字符：守住位置 正则替换；改错故障 冒号导致写入失败。',
      '// INV-14 响应携带大小与类型：守住位置 返回字段；改错故障 上传端无法预判载荷。',
      '// INV-15 先试直接打开：守住位置 首次调用；改错故障 正常路径多一次兜底。',
      '// INV-16 再试指定应用打开：守住位置 第二次调用；改错故障 不响应默认应用设置。',
      '// INV-17 最后回退通用打开：守住位置 末尾分支；改错故障 前两步失败即报错。',
      '// INV-18 全部失败才告警：守住位置 末尾日志；改错故障 中间步骤失败也刷告警。',
      '//',
      '// 模块职责：主进程打开本地路径、打开所在目录与窗口截图三件公共事。',
      '// 状态所有权：无状态；错误一律经调用方传入的 logger 记录。',
      '// 阅读顺序：先看三个导出函数，再看截图，最后看平台兜底链。',
    ],
    blocks: [
      {
        anchor: 'export async function openFileUrlInDefaultApp(',
        lines: [
          '文件地址先转本地路径。',
          '失败只记日志不外抛。',
          '复用路径打开实现。',
        ],
      },
      {
        anchor: 'export async function openPathInDefaultApp(',
        lines: [
          '空路径直接失败。',
          '规范化后尝试真实路径。',
          '系统错误原样返回。',
        ],
      },
      {
        anchor: 'export async function openPathInFileManager(',
        lines: [
          '空路径直接失败。',
          '平台判断集中在此。',
          '失败返回结构而非抛出。',
        ],
      },
      {
        anchor: 'async function openDarwinPathInFileManager(target: string, logger: DesktopIpcLogger) {',
        lines: [
          '依次尝试三种打开方式。',
          '全部失败才记录一次告警。',
          '失败信息合并三个来源。',
        ],
      },
    ],
  },
  {
    file: 'packages/desktop/src/main/browserView/browserScreenshotSurfaceContracts.ts',
    target: 33,
    header: [
      '// INV-01 视口比较留一像素容差：守住位置 恒定容差；改错故障 取整差异导致重复准备。',
      '// INV-02 宽高都要比较：守住位置 双条件与运算；改错故障 高度变化被忽略。',
      '// INV-03 释放回调只执行一次：守住位置 布尔标记；改错故障 重复释放引发二次异常。',
      '// INV-04 首次释放后置位标记：守住位置 语句顺序；改错故障 回调抛错后仍可再次进入。',
      '// INV-05 可选字段缺席不写键：守住位置 条件展开；改错故障 载荷出现未定义字段。',
      '// INV-06 载荷字段与入参同名：守住位置 逐项映射；改错故障 主渲染两侧字段错位。',
      '// INV-07 超时由调用方决定：守住位置 入参透传；改错故障 录制与截图共用同一上限。',
      '// INV-08 释放载荷剔除只读字段：守住位置 解构剔除；改错故障 释放被当作二次准备。',
      '// INV-09 剔除字段用占位名：守住位置 下划线前缀；改错故障 未使用变量告警。',
      '// INV-10 租约携带失效信号：守住位置 只读属性；改错故障 调用方无法感知作废。',
      '// INV-11 租约携带缩放与视口：守住位置 字段完整；改错故障 调用方拿到错配表面。',
      '// INV-12 活动租约可标记已准备：守住位置 可选方法；改错故障 看门狗无法提前结算。',
      '// INV-13 准备分组按键聚合同源请求：守住位置 分组键；改错故障 同源请求各自准备。',
      '// INV-14 分组区分准备中与就绪：守住位置 两个布尔；改错故障 就绪前被当作可截图。',
      '// INV-15 分组保留发送方标识：守住位置 可选字段；改错故障 回包无法路由到窗口。',
      '// INV-16 分组持有失效控制器：守住位置 必填字段；改错故障 取消时无信号可发。',
      '// INV-17 预设载荷类型取自共享协议：守住位置 类型来源；改错故障 主渲染字段各自定义。',
      '// INV-18 本模块只放契约与纯函数：守住位置 文件职责；改错故障 契约层混入副作用。',
      '//',
      '// 模块职责：截图表面准备与释放的共享契约及三个纯函数。',
      '// 状态所有权：无状态；分组与租约的生命周期由协调器持有。',
      '// 阅读顺序：先看租约与分组形状，再看容差比较，最后看载荷互转。',
    ],
    blocks: [
      {
        anchor: 'export function sameBrowserScreenshotViewport(',
        lines: [
          '宽高各允许一像素误差。',
          '只比较数值不比较模式。',
          '越界立即返回假。',
          '两侧都在容差内才算相同。',
        ],
      },
      {
        anchor: 'export function releaseBrowserScreenshotResourceOnce(callback: () => void): () => void {',
        lines: [
          '闭包持有一个布尔标记。',
          '第二次调用直接返回。',
          '标记先置位再执行回调。',
          '回调异常不影响幂等性。',
        ],
      },
      {
        anchor: 'export function toBrowserScreenshotSurfacePreparePayload(',
        lines: [
          '字段逐项映射。',
          '可选字段仅在存在时展开。',
          '超时由调用方透传。',
        ],
      },
    ],
  },
  {
    file: 'packages/desktop/src/main/embeddedBrowserPermissionPolicy.ts',
    target: 36,
    header: [
      '// INV-01 默认拒绝兜底：守住位置 末尾分支；改错故障 新枚举权限被自动放行。',
      '// INV-02 白名单只放行无害权限：守住位置 常量集合；改错故障 敏感权限无需询问。',
      '// INV-03 提示类权限逐条列举：守住位置 集合成员；改错故障 相邻权限被顺带放行。',
      '// INV-04 设备类检查放行到选择器：守住位置 检查分支；改错故障 设备请求在检查层被拦死。',
      '// INV-05 未知来源归为占位键：守住位置 捕获分支；改错故障 非法地址导致策略崩溃。',
      '// INV-06 站点记录优先于会话记录：守住位置 分支顺序；改错故障 长期选择被临时放行覆盖。',
      '// INV-07 会话放行只存内存：守住位置 局部映射；改错故障 临时同意被写进磁盘。',
      '// INV-08 无弹窗层时敏感权限一律拒绝：守住位置 空值判断；改错故障 未接弹窗也静默放行。',
      '// INV-09 同源同权限共享一次询问：守住位置 在途映射；改错故障 连续请求弹出多个窗口。',
      '// INV-10 询问结算后清理在途项：守住位置 终态回调；改错故障 失败后永远拿不到新询问。',
      '// INV-11 询问失败按拒绝结算：守住位置 第二参数；改错故障 异常时回调永不返回。',
      '// INV-12 永远允许写入持久记录：守住位置 条件分支；改错故障 下次访问仍要询问。',
      '// INV-13 设备选择器全局只开一个：守住位置 会话映射；改错故障 每次发现设备都新开窗。',
      '// INV-14 后续事件只热更新列表：守住位置 已存在分支；改错故障 第二次回调覆盖首次结算。',
      '// INV-15 取消参数按权限区分：守住位置 三元映射；改错故障 串口取消传错取值。',
      '// INV-16 选择器异常按取消结算：守住位置 捕获分支；改错故障 页面请求悬挂不返回。',
      '// INV-17 设备事件先阻止默认：守住位置 处理首行；改错故障 异步选择永远来不及。',
      '// INV-18 屏幕共享缺桥接即拒绝：守住位置 回调前判断；改错故障 未选源也返回成功。',
      '//',
      '// 模块职责：为内置浏览器分区注册默认拒绝的权限闸门。',
      '// 状态所有权：站点记录持久化，会话放行与设备选择器只存内存。',
      '// 阅读顺序：先看三张权限表，再看请求分支，最后看检查与设备事件。',
    ],
    blocks: [
      {
        anchor: 'export function originFromUrl(url: string | undefined): string {',
        lines: [
          '非法地址归为占位来源。',
          '只取协议与主机。',
          '尾部路径不参与来源。',
        ],
      },
      {
        anchor: 'export async function applyEmbeddedBrowserPermissionPolicy(',
        lines: [
          '先初始化站点记录。',
          '会话放行只存内存。',
          '在途询问按来源与权限聚合。',
          '四类处理函数全部注册。',
        ],
      },
      {
        anchor: 'targetSession.setPermissionRequestHandler((webContents, permission, callback, details) => {',
        lines: [
          '白名单直接放行。',
          '站点记录先于会话记录。',
          '无弹窗层时默认拒绝。',
          '未知权限按拒绝处理。',
        ],
      },
      {
        anchor: 'targetSession.setPermissionCheckHandler((_webContents, permission, requestingOrigin) => {',
        lines: [
          '检查层只读不询问。',
          '设备类放行到选择器。',
          '来源键与请求层保持一致。',
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
    `ZC-deep-b182-spec-${index}.json`,
    JSON.stringify({ files: [{ file: spec.file, items }] }, null, 2),
    'utf8',
  );
  console.log(`spec ${index}: ${spec.file} lines=${total}`);
  index += 1;
}
