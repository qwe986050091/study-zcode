// INV-01 同一时刻只允许一个采集会话：守住位置 早退判断；改错故障 两次启动互相重置缓冲。
// INV-02 采集标识先分配再启动：守住位置 赋值顺序；改错故障 早期请求没有归属标识。
// INV-03 只订阅应用自带会话：守住位置 会话清单；改错故障 内置浏览器流量混入报表。
// INV-04 已销毁渲染进程不采集：守住位置 空值判断；改错故障 访问已销毁对象抛错。
// INV-05 远程调试渲染器不采集：守住位置 类型判断；改错故障 用户浏览器请求被上传。
// INV-06 主进程请求标记为主进程：守住位置 三元取值；改错故障 报表归因错误。
// INV-07 停止时先清标识再退订：守住位置 清理顺序；改错故障 退订后仍写入缓冲。
// INV-08 停止幂等：守住位置 早退判断；改错故障 重复停止清空新会话。
// INV-09 窗口关闭与进程消失都触发停止：守住位置 事件绑定；改错故障 崩溃后采集常驻。
// INV-10 主机批次只保留主机与命令行记录：守住位置 过滤条件；改错故障 同一请求重复计数。
// INV-11 主机记录改写为本机进程号：守住位置 映射分支；改错故障 报表出现远端进程号。
// INV-12 查询与清空校验发起者：守住位置 授权函数；改错故障 任意窗口可读网络记录。
// INV-13 无活动采集时拒绝请求：守住位置 授权条件；改错故障 返回空快照而不是错误。
// INV-14 清空通过更换标识实现：守住位置 重赋值；改错故障 在途批次把旧数据写回。
// INV-15 清空后重新下发控制消息：守住位置 遍历调用；改错故障 主机继续用旧标识上报。
// INV-16 下发控制消息失败不重启进程：守住位置 捕获分支；改错故障 观测逻辑拖垮主机。
// INV-17 新主机接入时补发控制：守住位置 配置函数；改错故障 后启动主机没有采集。
// INV-18 退订函数全部释放：守住位置 循环调用；改错故障 热重载后重复注入监听。
//
// 模块职责：资源管理器的网络请求采集，涵盖会话订阅与主机批次汇入。
// 状态所有权：captureId、ownerId、currentHosts 与 disposers 都必须由模块级单例持有。
// 阅读顺序：先看启动与订阅，再看停止与事件，最后看 IPC 授权。
import { randomUUID } from "node:crypto";
import { ipcMain, session, webContents, type BrowserWindow, type UtilityProcess } from "electron";
import { HostMessageTypes, PlatformChannels, type NetworkCaptureBatch } from "@zcode/shared";
import { createNodeNetworkCapture } from "@zcode/shared/node";
import { NetworkCaptureBuffer } from "./networkCaptureBuffer.js";
import { subscribeBeforeRequest } from "./observeBeforeRequest.js";

// buffer 是进程内唯一缓冲；三类来源都写进这一个实例，另建实例会让快照按来源割裂。
const buffer = new NetworkCaptureBuffer();
// nodeCapture 的回调直接写入 buffer，若改成先攒再提交，同一请求会在快照里出现两次。
const nodeCapture = createNodeNetworkCapture("main", (batch) => buffer.ingest(batch));
// captureId 为 null 表示没有活动采集，启动与授权两处都以它作为会话存在性的唯一判据。
let captureId: string | null = null;
// ownerId 保存发起窗口的 webContents.id，停止时忘记置 null 会让旧窗口在无会话时仍通过授权。
let ownerId: number | null = null;
// currentHosts 缓存枚举函数，清空流程靠它把新 captureId 补发给全部 Host。
let currentHosts: (() => Iterable<UtilityProcess>) | null = null;
// disposers 保存三个 webRequest 订阅的退订句柄；覆盖而不 push 会让先订阅的 session 永久残留监听。
let disposers: Array<() => void> = [];

// configureNetworkCaptureHost 是给单个 Host 补发控制的唯一入口，启动与清空都走它，绕过它会让 Host 收不到 captureId。
export function configureNetworkCaptureHost(child: UtilityProcess): void {
  // 没有 captureId 时不发控制消息，否则 Host 会拿到空标识并开始上报无人认领的批次。
  if (!captureId) return;
  // 只转发给这一个 child，不在这里遍历全部 Host，补发范围由调用方决定。
  sendControl(child);
}

// sendControl 是模块内唯一向 Host 投递控制消息的位置，异常必须在此吞掉而不能上抛。
function sendControl(child: UtilityProcess): void {
  try {
    // 控制消息以 HostMessageTypes.NetworkCapture 加 captureId 下发，Host 只认这个组合来切换采集标识。
    child.postMessage({ type: HostMessageTypes.NetworkCapture, control: { captureId } });
  } catch {
    /* Host 已退出，观测不重启进程 */
  }
}

// 已有 captureId 时直接返回；先分配 randomUUID 再启动 buffer；只订阅 session.defaultSession 等三个应用会话；主机进程经 HostMessageTypes.NetworkCapture 控制消息接入。
export function startResourceManagerNetwork(
  // senderId 取自 window.webContents.id，写入 ownerId 后成为后续所有 IPC 的授权依据。
  senderId: number,
  // hosts 传函数而不是数组，保证启动之后新出现的 Host 仍能被枚举到。
  hosts: () => Iterable<UtilityProcess>,
): void {
  // 已有采集会话时直接返回；去掉这句会让第二次调用重置 buffer，把前一次的未读记录冲掉。
  if (captureId) return;
  // captureId 必须在 buffer.start 之前赋值，否则早期到达的请求没有归属标识会被判成无效批次。
  captureId = randomUUID();
  // 授权凭据在此刻固定为 ownerId，后续 IPC 只比对这个数字而不接受渲染进程自报身份。
  ownerId = senderId;
  // currentHosts 保存枚举函数而不是它的调用结果，否则清空时漏掉之后启动的 Host。
  currentHosts = hosts;
  // buffer.start 绑定本次 captureId，用于把上一会话的在途批次判为过期。
  buffer.start(captureId);
  // 主进程侧的 Node 采集也要同步标识，漏掉这句主进程请求会带空 captureId 入库。
  nodeCapture.setCaptureId(captureId);
  // 只订阅 App 拥有的 session；内置浏览器/录屏的独立 session 不进入采集。
  const sessions = [
    session.defaultSession,
    session.fromPartition("persist:zcode-coding-plan"),
    session.fromPartition("persist:zcode-rewards"),
  ];
  // 逐个 session 订阅且数量固定为三，只订 defaultSession 会漏掉计费页与奖励页的流量。
  for (const appSession of sessions) {
    // 退订句柄必须 push 进 disposers，直接丢弃会让停止时无法解绑这三个监听。
    disposers.push(
      subscribeBeforeRequest(
        appSession.webRequest,
        ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"],
        (details) => {
          // 回调触发时采集可能已经停止，这里重读 captureId 而不是沿用闭包里的旧值。
          if (!captureId) return;
          // 优先取 details.webContents，其次按 webContentsId 反查，两者都没有才视为主进程发起。
          const contents =
            details.webContents ??
            // fromId 在页面已销毁时返回 null，所以下一行必须再判一次空。
            (details.webContentsId ? webContents.fromId(details.webContentsId) : null);
          // 已销毁对象读进程号会抛错；getType 为 remote 的是远程调试渲染器，其请求不属于本应用。
          if (contents?.isDestroyed() || contents?.getType() === "remote") return;
          // 单条请求也走 buffer.ingest 的批接口，与 Host 批次共用同一条写入路径。
          buffer.ingest({
            // 带上当前 captureId 入库，清空后旧标识的记录会被 buffer 判为过期直接丢弃。
            captureId,
            // 本地采集没有丢弃计数，dropped 固定填 0 才能与 Host 批次的统计口径对齐。
            dropped: 0,
            // records 每条请求单独成批，避免高频页面把记录堆在内存里。
            records: [
              {
                // timestamp 取采集时刻而不是入库时刻，缓冲排队不会改变记录顺序。
                timestamp: Date.now(),
                // 有 webContents 即归为 renderer，没有则是主进程自身发起的请求。
                processType: contents ? "renderer" : "main",
                // 进程号取自实际发起者，统一填 process.pid 会让多窗口场景无法定位来源。
                pid: contents ? contents.getOSProcessId() : process.pid,
                // method 与 url 原样记录而不做大小写归一，报表侧按原值匹配才能和网络面板对上。
                method: details.method,
                // url 保留完整查询串，截断会让同一路径的不同请求看起来重复。
                url: details.url,
              },
            ],
          });
        },
      ),
    );
  }
  // 启动时遍历已存在的 Host 补发控制，漏掉这一步先启动的 Host 永远收不到 captureId。
  for (const host of hosts()) configureNetworkCaptureHost(host);
}

// 无 captureId 时直接返回；先清标识再执行 disposers 退订；最后通知全部主机。
export function stopResourceManagerNetwork(hosts: Iterable<UtilityProcess>): void {
  // 停止同样幂等，captureId 为空时直接返回，避免重复停止把新会话的标识清掉。
  if (!captureId) return;
  // 先清 captureId 再退订，退订期间到达的回调会因标识为空而自行退出。
  captureId = null;
  // ownerId 一并失效，之后任何窗口的查询与清空都会被 authorize 拒绝。
  ownerId = null;
  // currentHosts 置空，防止停止后仍有人借它给 Host 补发控制消息。
  currentHosts = null;
  // nodeCapture 同步停止主进程采集，漏掉这句停止之后仍有主进程记录写进缓冲。
  nodeCapture.setCaptureId(null);
  // 逐个执行退订而不是只清数组，否则热重载后 webRequest 监听会重复叠加。
  for (const dispose of disposers) dispose();
  // disposers 清空后下一次启动重新收集，旧句柄不会被执行两遍。
  disposers = [];
  // buffer.stop 丢弃当前会话并让在途批次失效，必须先于通知 Host 执行。
  buffer.stop();
  // 停止时也要通知 Host，否则 Host 会继续按旧 captureId 上报。
  for (const host of hosts) sendControl(host);
}

// observeNetworkWindow 把采集生命周期绑到单个窗口上，是本模块对外的唯一入口。
export function observeNetworkWindow(
  // window 是采集的归属者，其 webContents.id 会成为后续 IPC 的 ownerId。
  window: BrowserWindow,
  // hosts 透传给启动与停止两处，保证同一窗口的两次调用看的是同一批主机。
  hosts: () => Iterable<UtilityProcess>,
): void {
  // 以 window.webContents.id 作为授权凭据启动，因此只有这个窗口能查询与清空网络记录。
  startResourceManagerNetwork(window.webContents.id, hosts);
  // 三个事件共用同一个 stop 闭包，重复触发由 stopResourceManagerNetwork 的幂等兜住。
  const stop = () => stopResourceManagerNetwork(hosts());
  // 缺少 closed 绑定会让采集会话随窗口一起泄漏，窗口销毁后仍有人在写缓冲。
  window.on("closed", stop);
  // 渲染进程崩溃后 webContents 已不可信，继续采集只会写进无人读取的缓冲。
  window.webContents.on("render-process-gone", stop);
  // destroyed 与 closed 的触发顺序不固定，两条都绑才能保证必定停止。
  window.webContents.on("destroyed", stop);
}

// ingestHostNetworkCapture 是 Host 批次进入主进程缓冲的唯一通道。
export function ingestHostNetworkCapture(batch: NetworkCaptureBatch, hostPid: number): void {
  // 与本地采集共用 buffer.ingest，两类来源在快照里按时间戳混排。
  buffer.ingest({
    ...batch,
    // 只保留 host 与 cli 记录，同一请求在 Host 侧已经记过一次，全量汇入会重复计数。
    records: batch.records
      .filter((record) => record.processType === "host" || record.processType === "cli")
      .map((record) => (record.processType === "host" ? { ...record, pid: hostPid } : record)),
  });
}

// 查询与清空都必须校验 senderId；无活动采集时抛错；清空通过更换 captureId 实现。
export function registerResourceManagerNetworkIpc(): void {
  // authorize 是所有网络采集 IPC 的公共前置，校验失败直接抛错而不是返回空快照。
  const authorize = (senderId: number) => {
    // 发起者不等于 ownerId 时拒绝，任意窗口都不能读别的窗口的网络记录。
    if (senderId !== ownerId || !captureId) throw new Error("Network capture is inactive");
  };
  // 快照通道以 PlatformChannels 常量注册，渲染进程只能通过同名通道调用。
  ipcMain.handle(PlatformChannels.GetNetworkCaptureSnapshot, (event) => {
    // 授权读 event.sender.id 而不是入参，调用方无法伪造发起者。
    authorize(event.sender.id);
    // 只返回 buffer.snapshot 的副本，渲染进程拿不到缓冲内部结构。
    return buffer.snapshot();
  });
  // ClearNetworkCapture 走独立通道，与查询共用同一套授权。
  ipcMain.handle(PlatformChannels.ClearNetworkCapture, (event) => {
    // 清空是破坏性操作，未授权调用必须在改动 captureId 之前抛错。
    authorize(event.sender.id);
    // 清空需要切换 captureId，否则 Host/CLI 尚未发出的旧批次会把列表填回来。
    captureId = randomUUID();
    // 用新 captureId 重启缓冲，旧标识下的在途批次随即失效。
    buffer.start(captureId);
    // 主进程采集也要换成新 captureId，否则清空后主进程记录继续写进旧会话。
    nodeCapture.setCaptureId(captureId);
    // 补发控制消息给全部 Host，漏掉这一步 Host 会继续用清空前的标识上报。
    for (const host of currentHosts?.() ?? []) configureNetworkCaptureHost(host);
  });
}
