// INV-01 回调识别必须先于登录门禁：isWebRemoteControlOAuthCallback 的判定要早于 jwt 检查，守住位置是 start 里 url 解析之后的第一分支，改错故障会让带 authCode 的浏览器跳回落进登录页。
// INV-02 回调最低门槛是 state，code、authCode、error 三者任一即可，守住位置是判定集合的构造处，改错故障会吞掉 BigModel 的 authCode 型回调或只带 error 的失败回调。
// INV-03 每次进入列表、换设备、连接、切账号都先 reset，守住位置是 reset 里先 dispose 再新建 AbortController，改错故障会让旧作用域的 signal 继续放行过期回调。
// INV-04 scope 是唯一取消源，dispose 时 abort 并把 list 置空，守住位置是异步分支落地前复查 signal.aborted，改错故障会让已离开页面的设备列表回写视图。
// INV-05 列表刷新单飞，list.request 存在即复用，守住位置是发起请求前的早返回，改错故障会并发多次设备拉取并让 loading 反复抖动。
// INV-06 账号切换判定以 acceptedJwt 与当前令牌比较，守住位置是发起请求前与响应落地后各一次，改错故障会把上一账号的设备当作新账号的自动连接依据。
// INV-07 自动落点只消费首次成功的列表，守住位置是成功分支里清空 lastSid 与 lastMid 的动作，改错故障会让后台刷新打断用户已做出的选择。
// INV-08 自动落点优先级为最近 SID 在线、同 MID 恰好一个在线 SID、否则放弃，守住位置是 resolveAutoConnectSid 的返回，改错故障会在同 MID 多在线时连错机器。
// INV-09 最近 MID 缺失时允许从最近 SID 记录的 device_mid 回填，守住位置是 resolveAutoConnectSid 内的 mid 取值，改错故障会让桌面重注册换 SID 后接不回同一台电脑。
// INV-10 存储读写一律包在 try 内，守住位置是 openDevices 读取偏好与 rememberDevice 写入偏好，改错故障会让 iOS 私密模式直接抛错阻断整个入口。
// INV-11 持久化只保存 sid 与 mid 两个偏好，守住位置是 LAST_DEVICE_KEY 与 LAST_DEVICE_MID_KEY，改错故障会把令牌或业务状态写进同域可读的存储。
// INV-12 连接回调都要先检查 signal.aborted，守住位置是 onPaired 与 onFailure 的首行短路，改错故障会在换设备后仍弹失败视图或写入旧设备偏好。
// INV-13 鉴权失败的归口是 switchAccount，守住位置是 onFailure 分支与 refreshDevices 的 catch，改错故障会把令牌过期显示成设备连接错误。
// INV-14 selectDevice 要求视图非 loading 非 error 且 acceptedJwt 与当前令牌一致，守住位置是方法入口两道守卫，改错故障会用过期列表发起连接。
// INV-15 选中设备后先改写 sid、mid、name 再 replaceHref，守住位置是 connect 之前的地址落地，改错故障会让刷新页面回到列表或连到旧机器。
// INV-16 chooseOtherDevice 删除 sid、mid、name、hash、t 五个参数并以 autoConnect=false 开列表，守住位置是先改地址再开列表，改错故障会让自动落点把用户弹回原设备。
// INV-17 subscribeVisible 返回的取消函数必须存进 list.unsubscribe 并由 reset 调用，守住位置是 list 对象构造处，改错故障会累积可见性订阅并重复刷新。
// INV-18 列表视图每次整体替换而非就地改字段，守住位置是 list.view 的重新赋值，改错故障会让视图层拿到同一引用而漏渲染。
//
// 模块职责：网页远控入口的 admission 层，负责回调识别、登录门禁、二维码参数校验，以及设备列表到连接的转发；配对后的 workspace 与恢复仍交给既有 bootstrap。
// 状态所有权：AbortController、设备列表视图、最近设备偏好归本类；令牌与账号归 options.auth，持久化归 options.storage，连接本体归 options.connect。
// 阅读顺序：先看 isWebRemoteControlOAuthCallback 与 resolveAutoConnectSid 两个纯函数，再看 start 的分支顺序，最后看 refreshDevices 的单飞与令牌复查。
import type {
  WebRemoteControlDeviceListView,
  WebRemoteControlEntryConnection,
  WebRemoteControlEntryOptions,
  WebRemoteControlDeviceGroup,
} from "#src/web-remote-control/contract.js";
import type { WebRemoteControlRelayV2Device } from "@zcode/shared/web-remote-relay";
import { parseWebRemoteControlExternalQrParams } from "@zcode/shared";
import { WebRemoteControlV2ConnectionError } from "@zcode/shared/web-remote-relay";
import type { WebOAuthProviderId } from "#src/auth/browserOAuthCredentialRepo.js";
import { groupWebRemoteControlDevices } from "#src/web-remote-control/domain/webRemoteControlDeviceGroups.js";
import {
  readKnownDevices,
  rememberKnownDevices,
} from "#src/web-remote-control/app/webRemoteControlKnownDevices.js";

export function isWebRemoteControlOAuthCallback(url: URL): boolean {
  // state 是回调的最低门槛，没有 state 的访问一律当普通入口，避免把站内正常跳转误判成回调。
  // code、authCode、error 三者任一命中即可，BigModel 走 authCode，失败回调只带 error，两类都不能漏。
  // 路径限定在 /remote/v4 及其尾斜杠形态，其他路径即使带 state 也不进入回调分支。
  // 这里只回答是不是回调，换取凭证与错误展示留给 callback 视图，本处不触碰令牌。
  return (
    ["/remote/v4", "/remote/v4/"].includes(url.pathname) &&
    url.searchParams.has("state") &&
    // BigModel 使用 authCode；必须先进入既有回调校验，不能落回未登录门禁。
    (url.searchParams.has("code") ||
      url.searchParams.has("authCode") ||
      url.searchParams.has("error"))
  );
}

// 键名写死 zcode-web-remote 前缀，避免与同域其他页面的偏好键冲突而互相覆盖。
// 只存 SID 与 MID 两个字符串，令牌与账号信息一律不落这里，存储可被同域脚本读取。
// 两个键成对使用：SID 键用于命中最近设备，MID 键用于跨 SID 接回同一台电脑。
const LAST_DEVICE_KEY = "zcode-web-remote-last-device-sid";
const LAST_DEVICE_MID_KEY = "zcode-web-remote-last-device-mid";

/**
 * 最近设备的自动落点：最近 SID 在线优先；否则同一台电脑（最近 MID）恰好一个在线 SID 时接上它。
 * 桌面重新注册会换 SID 并尽力删除旧 SID，因此最近 MID 缺失时只能从列表里旧 SID 的离线记录取。
 * 同 MID 多个在线 SID 时不猜测目标，交给用户在列表中选择。
 */
// 优先级固定为最近 SID 在线、同 MID 恰好一个在线 SID、否则不给建议，中间不插入任何猜测分支。
// 桌面重注册会换 SID 并尽力删除旧 SID，所以最近 MID 缺失时退回到最近 SID 记录里的 device_mid。
// 同 MID 存在多个在线 SID 时返回 undefined，说明用户有多端或重连残留，只能交给列表人工选择。
// 本函数只读 records 与 groups，不改存储也不发请求，保证自动落点可被重复计算。
function resolveAutoConnectSid(
  records: readonly WebRemoteControlRelayV2Device[],
  groups: readonly WebRemoteControlDeviceGroup[],
  lastSid: string | null,
  lastMid: string | null,
): string | undefined {
  if (!lastSid && !lastMid) return undefined;
  const lastRecord = lastSid ? records.find((record) => record.device_sid === lastSid) : undefined;
  if (lastRecord?.online) return lastRecord.device_sid;
  const mid = lastMid || lastRecord?.device_mid;
  const connections = groups.find((group) => group.deviceMid === mid)?.onlineConnections ?? [];
  return connections.length === 1 ? connections[0]?.device_sid : undefined;
}

/** 只负责连接前的 admission；配对后的 workspace/恢复仍归既有 bootstrap。 */
export class WebRemoteControlEntry {
  // scope 是入口唯一的取消源，列表请求与连接共用同一 signal，dispose 一次即可全线取消。
  // list 内的 request 与 unsubscribe 跟随 list 生命周期，新建 scope 不会自动接管旧订阅。
  // 字段初始即创建，构造函数返回后 signal 立刻可用，不必等 start 才具备取消能力。
  private scope = new AbortController();
  private list:
    | {
        view: WebRemoteControlDeviceListView;
        unsubscribe: () => void;
        request?: Promise<void>;
        lastSid: string | null;
        lastMid: string | null;
        acceptedJwt?: string;
      }
    | undefined;

  constructor(private readonly options: WebRemoteControlEntryOptions) {}

  dispose(): void {
    this.scope.abort();
    this.list?.unsubscribe();
    this.list = undefined;
  }

  // reset 语义是先作废旧作用域再开新的，dispose 负责 abort 与退订，两步顺序颠倒会留下未取消的请求。
  // 每次进入列表或建立连接都重置，保证上一次的 signal 不会在新流程里继续放行回调。
  // list 置空后旧闭包仍可能持有引用，因此异步分支在落地前都要复查 signal.aborted。
  // reset 不清理存储偏好，最近设备跨会话保留，只有 chooseOtherDevice 才显式改写地址。
  private reset(): void {
    this.dispose();
    this.scope = new AbortController();
  }

  // 分支顺序固定：回调、无令牌、二维码参数非法、无指定设备进列表、有设备直接连，交换顺序会改变用户看到的页面。
  // 二维码参数解析失败给 invalid-mobile-connection 而不是退回列表，此时地址已被污染，继续读会连到错误目标。
  // 无 deviceSid 时以 autoConnect=true 开列表，保留最近设备偏好作为唯一自动落点依据。
  async start(): Promise<void> {
    this.reset();
    const url = new URL(this.options.getHref());
    if (isWebRemoteControlOAuthCallback(url)) {
      this.options.onView({ kind: "callback" });
      return;
    }
    if (!this.options.auth.getZCodeJwtToken()) {
      this.options.onView({ kind: "login" });
      return;
    }
    const params = parseWebRemoteControlExternalQrParams(url.searchParams);
    if (!params) {
      this.options.onView({ kind: "failure", failure: { reason: "invalid-mobile-connection" } });
      return;
    }
    if (!params.deviceSid) {
      await this.openDevices(true);
      return;
    }
    this.connect({ ...params, deviceSid: params.deviceSid });
  }

  // autoConnect=false 表示用户主动换设备，此时不读最近设备偏好，避免又被弹回原机器。
  // 偏好读取失败按无偏好处理，入口继续可用，最近设备只是便利而非必要条件。
  // 列表先以空设备与 loading=false 呈现，再由 refreshDevices 置 loading，避免闪一帧旧数据。
  private async openDevices(autoConnect: boolean): Promise<void> {
    this.reset();
    let lastSid: string | null = null;
    let lastMid: string | null = null;
    try {
      if (autoConnect) {
        lastSid = this.options.storage.getItem(LAST_DEVICE_KEY);
        lastMid = this.options.storage.getItem(LAST_DEVICE_MID_KEY);
      }
    } catch {
      // iOS 私密模式等环境可能禁用存储；最近设备只是偏好，不阻断入口。
    }
    const account = this.options.auth.getActiveAccount() ?? undefined;
    this.list = {
      view: {
        kind: "devices",
        devices: [],
        loading: false,
        error: false,
        ...(account ? { account } : {}),
      },
      unsubscribe: this.options.subscribeVisible(() => {
        void this.refreshDevices();
      }),
      lastSid,
      lastMid,
    };
    await this.refreshDevices();
  }

  // 单飞由 list.request 承担，可见性回调与手动刷新叠加时，后续调用复用同一个进行中的请求。
  // 设备请求返回后必须复查 signal.aborted 与当前令牌，账号在这段时间切换时旧响应一律丢弃。
  // 成功后先读已知设备补全离线名字再写回，已知设备只服务展示，不参与自动连接判定。
  // 自动落点只消费首次成功列表，成功后立即清空 lastSid 与 lastMid，后续刷新不再打断选择。
  async refreshDevices(): Promise<void> {
    const list = this.list;
    if (!list) return;
    if (list.request) return list.request;
    const jwt = this.options.auth.getZCodeJwtToken();
    if (!jwt) return this.switchAccount();
    if (list.acceptedJwt && list.acceptedJwt !== jwt) return this.start();
    const { signal } = this.scope;
    list.view = { ...list.view, loading: true, error: false };
    this.options.onView(list.view);
    list.request = (async () => {
      try {
        const devices = await this.options.devices(jwt, signal);
        if (signal.aborted) return;
        // 账号变更后的响应不能为新账号提供设备或自动连接依据。
        if (this.options.auth.getZCodeJwtToken() !== jwt) return this.start();
        list.acceptedJwt = jwt;
        // 先读缓存补全离线记录的名字/平台，再把本次在线记录写回；它们只是展示偏好，不进入 admission。
        const knownDevices = readKnownDevices(this.options.storage);
        const groups = groupWebRemoteControlDevices(devices, this.options.locale, knownDevices);
        rememberKnownDevices(this.options.storage, knownDevices, groups);
        list.view = { ...list.view, devices: groups, loading: false, error: false };
        const autoSid = resolveAutoConnectSid(devices, groups, list.lastSid, list.lastMid);
        // 自动落点只消费首次成功的列表；后续刷新不能打断用户选择。
        list.lastSid = null;
        list.lastMid = null;
        if (autoSid) this.selectDevice(autoSid);
        else this.options.onView(list.view);
      } catch (error) {
        if (signal.aborted) return;
        if (this.options.auth.getZCodeJwtToken() !== jwt) return this.start();
        if (
          error instanceof WebRemoteControlV2ConnectionError &&
          error.reason === "auth-required"
        ) {
          await this.switchAccount();
          return;
        }
        list.view = { ...list.view, loading: false, error: true };
        this.options.onView(list.view);
      } finally {
        list.request = undefined;
      }
    })();
    return list.request;
  }

  // 入口两道守卫：视图处于 loading 或 error 时拒绝选择，acceptedJwt 过期时改为重启入口而不是继续。
  // 只在 onlineConnections 里查找设备，离线记录即便存在也不能成为连接目标。
  // 地址参数与连接参数取自同一次查找结果，避免列表显示与真正连上的机器不一致。
  // 先 replaceHref 再 connect，用户刷新或回退时地址已带 sid 与 mid，可直接复原目标。
  selectDevice(sid: string): void {
    if (!this.list || this.list.view.loading || this.list.view.error) return;
    if (this.list.acceptedJwt !== this.options.auth.getZCodeJwtToken()) {
      void this.start();
      return;
    }
    const device = this.list.view.devices
      .flatMap((group) => group.onlineConnections)
      .find((item) => item.device_sid === sid);
    if (!device) return;
    const url = new URL(this.options.getHref());
    url.searchParams.set("sid", device.device_sid);
    url.searchParams.set("mid", device.device_mid);
    const name = device.meta.name?.trim();
    if (name) url.searchParams.set("name", name);
    else url.searchParams.delete("name");
    this.options.replaceHref(url.href);
    this.rememberDevice(device.device_sid, device.device_mid);
    this.connect({
      deviceSid: device.device_sid,
      deviceMid: device.device_mid,
      deviceName: name || undefined,
      appVersion: url.searchParams.get("app_version") || undefined,
    });
  }

  // 清掉 sid、mid、name、hash、t 五个参数，hash 与 t 是二维码透传的定位信息，留着会复现旧目标。
  // 先改写 href 再开列表，保证此刻刷新页面停在设备列表而不是回到自动连接。
  // 此处复用 openDevices 并传 autoConnect=false，不为换设备另写一套拉取逻辑。
  async chooseOtherDevice(): Promise<void> {
    this.reset();
    const url = new URL(this.options.getHref());
    for (const key of ["sid", "mid", "name", "hash", "t"]) url.searchParams.delete(key);
    this.options.replaceHref(url.href);
    await this.openDevices(false);
  }

  private rememberDevice(sid: string, mid: string | undefined): void {
    try {
      this.options.storage.setItem(LAST_DEVICE_KEY, sid);
      if (mid) this.options.storage.setItem(LAST_DEVICE_MID_KEY, mid);
    } catch {
      // 偏好持久化失败不影响连接，也不修改按 SID 隔离的业务状态。
    }
  }

  // 先 reset 再取 signal，保证交给 connect 的 signal 属于本次连接而非上一次。
  // getToken 每次现取令牌，缺失即拒绝 auth-required，交由 onFailure 统一转账号切换。
  // onPaired 仅在未取消时写偏好，连接因换设备被取消时不污染最近设备落点。
  private connect(params: WebRemoteControlEntryConnection["params"]): void {
    this.reset();
    const { signal } = this.scope;
    this.options.connect({
      params,
      signal,
      getToken: (tokenSignal) => {
        const jwt = this.options.auth.getZCodeJwtToken();
        if (!jwt) return Promise.reject(new WebRemoteControlV2ConnectionError("auth-required"));
        return this.options.token(jwt, tokenSignal);
      },
      onPaired: () => {
        if (!signal.aborted) this.rememberDevice(params.deviceSid, params.deviceMid);
      },
      onFailure: (failure) => {
        if (signal.aborted) return;
        if (failure.reason === "auth-required") void this.switchAccount();
        else this.options.onView({ kind: "failure", failure });
      },
    });
  }

  startLogin(provider?: WebOAuthProviderId): void {
    this.options.auth.startLogin({
      ...this.options.loginOptions,
      ...(provider ? { provider } : {}),
      appReturnTo: this.options.getHref(),
    });
  }

  async switchAccount(): Promise<void> {
    this.reset();
    const { signal } = this.scope;
    await this.options.auth.logout();
    if (!signal.aborted) this.options.onView({ kind: "login" });
  }
}
