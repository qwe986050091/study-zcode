// Web 远程控制「选择电脑」列表页：手机 Web 端登录后进入远程会话前的唯一设备入口。
// 本文件只做视图编排——文案查表、在线与离线分组、设备行渲染、刷新与切换账号的回调接线、多连接弹层的开合。
// 全部设备数据以下发的 view 为唯一事实源，组件自身不发请求、不缓存设备、不判断在线状态的来源。
// 不负责：设备发现与轮询、在线判定来源、账号切换副作用、连接建立与会话路由。
//
// INV-01 断言：可点条件等于在线且 selectable —— 守住它的位置：DeviceSection 传给行组件的 disabled —— 改错故障：刷新中或报错时仍能点开设备，进入尚未就绪的连接。
// INV-02 断言：selectable 仅在非加载且非错误时成立 —— 守住它的位置：页面主体 selectable 常量 —— 改错故障：错误态下弹层仍可打开，连接列表停在旧快照。
// INV-03 断言：在线组与离线组互斥且并集等于全部设备 —— 守住它的位置：onlineDevices 与 offlineDevices 两次过滤 —— 改错故障：同一设备重复出现或整组丢失。
// INV-04 断言：重名区分只用 MID 前 8 位且仅作展示 —— 守住它的位置：describeDevice 的 showId 分支 —— 改错故障：误把短 ID 当身份键，重名设备跳转串到另一台。
// INV-05 断言：单连接直接选中，多连接才开弹层 —— 守住它的位置：openDevice 的 others 长度判断 —— 改错故障：多连接被第一条连接吞掉，其余连接不可选。
// INV-06 断言：弹层以 deviceMid 绑定而非连接 sid —— 守住它的位置：sheetDeviceMid 状态与 sheetDevice 派生 —— 改错故障：连接列表刷新后弹层错绑到别的设备。
// INV-07 断言：弹层设备不存在时自动收起 —— 守住它的位置：sheetDevice 由在线列表 find 派生 —— 改错故障：设备转离线后弹层仍展示已失效的连接。
// INV-08 断言：选择连接先关弹层再上抛 —— 守住它的位置：ConnectionSheet 的 onSelect 回调 —— 改错故障：弹层遮罩残留，返回手势与滚动被锁死。
// INV-09 断言：文案必须按 locale 命中同一份键集 —— 守住它的位置：copyByLocale 查表与 DeviceListCopy 类型 —— 改错故障：新增文案漏译，另一种语言显示 undefined。
// INV-10 断言：账号提供方标签覆盖 contract 的全部取值 —— 守住它的位置：PROVIDER_LABELS —— 改错故障：新增 provider 后账号行渲染出空标签。
// INV-11 断言：账号缺失时只留切换入口 —— 守住它的位置：AccountRow 的 account 空分支 —— 改错故障：首屏尚未取到账号时账号区整块空白，用户无法切换。
// INV-12 断言：刷新在加载中禁用但保持可见 —— 守住它的位置：标题栏刷新按钮的 disabled —— 改错故障：连点刷新叠加请求，列表反复闪烁。
// INV-13 断言：错误优先于加载与空态展示 —— 守住它的位置：error、loading、空态的条件链 —— 改错故障：请求失败时同时出现「暂无设备」，把故障说成没有设备。
// INV-14 断言：滚动由页面自身容器承接 —— 守住它的位置：main 的高度与纵向滚动 —— 改错故障：长列表末行被安全区或视口裁掉，无法触达最后一项。
// INV-15 断言：未知平台不展示内部名称、图标回退通用电脑 —— 守住它的位置：describeDevice 的平台名与 DeviceTile 的图标入参 —— 改错故障：副标题把 win32 这类内部取值直接露给用户。
import { useState } from "react";
import { ChevronRightIcon, LaptopIcon, RefreshCwIcon } from "lucide-react";
import { Button } from "@zcode/ui/button";
import { DevicePlatformIcon, getDevicePlatformLabel } from "@zcode/ui/device-platform-icon";
import { WebRemoteControlBrand } from "#src/web-remote-control/ui/webRemoteControlBrand.js";
import {
  WebRemoteControlConnectionSheet,
  WebRemoteControlDeviceRow,
} from "#src/web-remote-control/ui/webRemoteControlConnectionSheet.js";
import type {
  WebRemoteControlDeviceGroup,
  WebRemoteControlDeviceListAccount,
  WebRemoteControlDeviceListView,
} from "#src/web-remote-control/contract.js";

import type { WebRemoteControlScreenLocale } from "#src/web-remote-control/domain/webRemoteControlScreenCopy.js";
import { WebRemoteControlSwitchAccountDialog } from "#src/web-remote-control/ui/webRemoteControlSwitchAccountDialog.js";

// [契约] 文案表是页内唯一文案来源，键集由 zh-CN 定义，en-US 必须逐键对齐。
// 新增设备状态或空态时先加键再改渲染，否则另一种语言会静默显示 undefined。
// 函数型条目只用于带数量的句子，改成字符串会让连接数无法插值。
// 不要在渲染处临时拼接半句文案，换行与语序在英文下会错位。
const copyByLocale = {
  "zh-CN": {
    title: "选择电脑",
    switchAccount: "切换",
    switchAccountFallback: "切换账号",
    refresh: "刷新",
    loading: "正在加载设备…",
    online: "在线",
    offline: "离线",
    unnamed: "未命名设备",
    connections: (count: number) => `${count} 个连接`,
    notFound: "没看到你的电脑？在电脑端 ZCode 登录同一账号并开启远程控制，然后刷新。",
    emptyTitle: "暂无设备",
    emptyDescription: "在电脑端登录同一账号并开启 Web 远程控制，然后刷新列表。",
    error: "无法加载设备，请检查网络后刷新。",
  },
  "en-US": {
    title: "Choose a computer",
    switchAccount: "Switch",
    switchAccountFallback: "Switch account",
    refresh: "Refresh",
    loading: "Loading devices…",
    online: "Online",
    offline: "Offline",
    unnamed: "Unnamed device",
    connections: (count: number) => `${count} connections`,
    notFound:
      "Don't see your computer? Sign in to ZCode on it with the same account, turn on remote control, then refresh.",
    emptyTitle: "No devices yet",
    emptyDescription:
      "Sign in with the same account on your computer, enable Web remote control, then refresh this list.",
    error: "Could not load devices. Check your connection and refresh.",
  },
};

type DeviceListCopy = (typeof copyByLocale)["zh-CN"];

// [契约] 标签映射按 contract 的 provider 联合类型穷举，新增取值必须同步补键。
// 查表结果为 undefined 时账号行只剩一个分隔符，表面像样式问题实为漏配。
// 不要改成按字符串首字母大写的兜底，品牌名大小写并不规则。
const PROVIDER_LABELS: Record<WebRemoteControlDeviceListAccount["provider"], string> = {
  zai: "Z.ai",
  bigmodel: "BigModel",
};

interface WebRemoteControlDeviceListPageProps {
  view: WebRemoteControlDeviceListView;
  locale: WebRemoteControlScreenLocale;
  onSelect(sid: string): void;
  onRefresh(): void;
  onSwitchAccount(): void;
  /** 多连接弹层的“启动于”相对时间基准，测试注入。 */
  now?: () => number;
}

function SectionHeader({ label, count }: { label: string; count: number }) {
  return (
    <h2 className="flex items-baseline gap-1.5 px-1 pb-2 pt-6 text-ui-sm font-medium text-foreground-subtle">
      {label}
      <span className="text-foreground-subtlest">{count}</span>
    </h2>
  );
}

// [契约] 设备图标只从 platform 字符串映射，未知平台回退到通用笔记本图标。
// 在线小圆点纯装饰且必须对读屏隐藏，否则状态会被念两遍。
// 圆点用绝对定位叠在图标右下角，不参与布局，改成流式排布会挤压图标。
// DeviceTile 用 size-9 固定尺寸，行高由外层行组件决定，所以这里不再加外边距。
function DeviceTile({ platform, online }: { platform?: string; online: boolean }) {
  return (
    <span className="relative flex size-9 shrink-0 items-center justify-center rounded-lg bg-surface text-foreground">
      <DevicePlatformIcon platform={platform} className="size-[18px]" />
      {online ? (
        <span
          aria-hidden="true"
          className="absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full bg-success ring-2 ring-card"
        />
      ) : null}
    </span>
  );
}

// 设备副标题由平台名、版本、离线文案按顺序拼装，中间统一用中点分隔。
// 版本只在恰好一条在线连接时展示，多连接版本可能不一致，挑任意一条都是误导。
// 离线设备不展示版本，因为版本元数据只存在于在线连接上。
// [权衡] 拼装放在渲染前一次算完，避免在 JSX 里串条件导致分支难以复核。
function describeDevice(
  device: WebRemoteControlDeviceGroup,
  copy: DeviceListCopy,
  showId: boolean,
): string {
  const platform = getDevicePlatformLabel(device.platform);
  const online = device.onlineConnections.length > 0;
  // [契约] 只有在线连接数为 1 时才取出该连接读版本，多连接一律视为无版本。
  // 这里用 undefined 而不是空对象兜底，让下游的可选链自然短路。
  // 不要改成取 onlineConnections 首元素，多连接下会读到任意一台的版本。
  // 该值不参与可用性判断，仅用于文案。
  const single = device.onlineConnections.length === 1 ? device.onlineConnections[0] : undefined;
  const version = single?.meta.version?.trim();
  const parts = online
    ? [platform, version ? `ZCode ${version}` : undefined]
    : [platform, copy.offline];
  const filtered = parts.filter((part): part is string => Boolean(part));
  // [失败路径] 平台名与版本可能同时为空，过滤后会出现空副标题，这里补一个状态词兜底。
  // 兜底只拼状态词，不要再拼平台名，否则又回到空串问题。
  // 该分支正常不可达，但平台映射新增空值时会被立即暴露。
  if (filtered.length === 0) filtered.push(online ? copy.online : copy.offline);
  // 设备 ID 默认隐藏；同组重名时才追加 MID 前 8 位区分，前 8 位不参与身份判断。
  if (showId) filtered.push(`ID ${device.deviceMid.slice(0, 8)}`);
  return filtered.join(" · ");
}

// 分组组件只负责标题计数、重名统计与行渲染，不自行判断可用性，可用性由 selectable 透传。
// 重名统计每次渲染重建，设备量在几十以内，不做缓存也不引入记忆化。
// [契约] 分组数据为空时直接返回空，调用方无需再判断一次。
// 行点击一律交给 onOpen，分组内不区分单连接与多连接。
function DeviceSection({
  label,
  devices,
  copy,
  selectable,
  onOpen,
}: {
  label: string;
  devices: WebRemoteControlDeviceGroup[];
  copy: DeviceListCopy;
  selectable: boolean;
  onOpen(device: WebRemoteControlDeviceGroup): void;
}) {
  if (devices.length === 0) return null;
  // [契约] 重名统计按最终显示名计数，未命名设备共用同一回退文案，因此会互相判为重名。
  // 统计范围仅限当前分组，在线与离线各自独立，避免跨组误加 ID 后缀。
  // 不要改成按 deviceMid 统计，那样计数恒为 1，重名永远不会提示。
  const nameCounts = new Map<string, number>();
  for (const device of devices) {
    // 未命名设备统一回退到同一文案，保证统计口径与展示口径一致。
    // 下方渲染取的是同一表达式，两处必须同步修改。
    // [契约] 名称可以是空串，因此用逻辑或而非空值合并，否则空串会绕过回退。
    const name = device.name || copy.unnamed;
    nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
  }
  return (
    <section>
      <SectionHeader label={label} count={devices.length} />
      <ul className="overflow-hidden rounded-xl border border-card-border bg-card">
        {devices.map((device, index) => {
          const name = device.name || copy.unnamed;
          const online = device.onlineConnections.length > 0;
          const multiple = device.onlineConnections.length > 1;
          return (
            <li key={device.deviceMid}>
              <WebRemoteControlDeviceRow
                first={index === 0}
                // 全离线行原生禁用；在线行在刷新中/失败时也暂不可选，沿用入口 admission。
                disabled={!online || !selectable}
                onClick={() => onOpen(device)}
                dimmed={!online}
                leading={<DeviceTile platform={device.platform} online={online} />}
                trailing={
                  online ? (
                    <>
                      {multiple ? (
                        <span className="shrink-0 text-ui-sm text-foreground-subtle">
                          {copy.connections(device.onlineConnections.length)}
                        </span>
                      ) : null}
                      <ChevronRightIcon
                        aria-hidden="true"
                        className="size-4 shrink-0 text-foreground-subtlest"
                      />
                    </>
                  ) : null
                }
              >
                <span className="block truncate text-ui-base font-medium">{name}</span>
                <span className="mt-0.5 block truncate text-ui-sm text-foreground-subtle">
                  {describeDevice(device, copy, (nameCounts.get(name) ?? 0) > 1)}
                </span>
              </WebRemoteControlDeviceRow>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// 账号行展示头像、名称与提供方，右侧固定为切换入口；无账号时只保留入口。
// 头像缺失时用显示名首字符占位，按码点取首字，避免把代理对或表情截断。
// [契约] 占位字符取不到时回退问号，不能渲染空圆。
// 该组件不持有账号状态，切换动作由上层回调完成。
function AccountRow({
  account,
  copy,
  locale,
  onSwitchAccount,
}: {
  account?: WebRemoteControlDeviceListAccount;
  copy: DeviceListCopy;
  locale: WebRemoteControlScreenLocale;
  onSwitchAccount(): void;
}) {
  // [契约] 有账号与无账号两个分支共用同一段弹层包裹，避免出现两套确认流程。
  // switchButton 用负外边距抵消容器 padding，只调视觉对齐不扩大点击区域。
  // switchButton 不加 disabled，加载中也要能切换账号并弹确认框。
  const switchButton = (label: string) => (
    <WebRemoteControlSwitchAccountDialog locale={locale} onConfirm={onSwitchAccount}>
      <Button
        type="button"
        variant="ghost"
        className="-my-2 h-9 shrink-0 rounded-lg px-2 font-medium focus-visible:bg-hover"
      >
        {label}
      </Button>
    </WebRemoteControlSwitchAccountDialog>
  );
  if (!account) {
    return (
      <div className="-ml-2 mt-1 flex items-center">{switchButton(copy.switchAccountFallback)}</div>
    );
  }
  return (
    <div className="mt-1 flex min-w-0 items-center gap-2 text-ui-sm text-foreground-subtle">
      {account.avatarUrl ? (
        <img
          src={account.avatarUrl}
          alt=""
          aria-hidden="true"
          className="size-5 shrink-0 rounded-full object-cover"
        />
      ) : (
        <span
          aria-hidden="true"
          className="flex size-5 shrink-0 items-center justify-center rounded-full bg-surface-hover text-ui-xs font-semibold text-foreground"
        >
          {Array.from(account.displayName.trim())[0]?.toUpperCase() ?? "?"}
        </span>
      )}
      <span className="min-w-0 truncate">
        {account.displayName} · {PROVIDER_LABELS[account.provider]}
      </span>
      {switchButton(copy.switchAccount)}
    </div>
  );
}

// 页面契约：view 为唯一数据源，三个回调只上抛意图，页内不直接改写视图状态。
// 注入的 now 默认取系统时间，仅用于多连接弹层的相对时间，测试注入固定值避免抖动。
// locale 决定文案表，不提供兜底语言，非法值会直接取到 undefined。
// [契约] 组件不接收设备或连接标识，也不对外暴露内部状态。
// [资源] 弹层开关是唯一的本地状态，随组件卸载释放，不做跨渲染缓存。
export function WebRemoteControlDeviceListPage({
  view,
  locale,
  onSelect,
  onRefresh,
  onSwitchAccount,
  now = () => Date.now(),
}: WebRemoteControlDeviceListPageProps) {
  // [契约] 文案表按 locale 直接查表，类型保证键存在，运行时不重复校验。
  // 若上游放宽 locale 类型，这里会拿到 undefined 并在首个取值处崩溃，而不是显示默认语言。
  // 不要改成可选链加兜底文案，那会让漏配语言长期无人发现。
  // 查表结果全程复用，避免逐行重复索引。
  const copy = copyByLocale[locale];
  // [契约] 弹层状态只存设备 MID，不存连接数组，避免刷新后持有过期连接对象。
  // 存 MID 使弹层内容始终由当前 view 派生，设备下线会自动消失。
  // 关闭统一写回 null，不要用空串表示关闭，否则查找可能命中异常数据。
  // 该状态不随 view 变化重置，失效由派生查找负责。
  const [sheetDeviceMid, setSheetDeviceMid] = useState<string | null>(null);
  // [契约] selectable 由 !view.loading && !view.error 统一给出，整页不可进入但已有列表照常显示。
  // 刷新期间保留旧列表是刻意取舍，避免整页闪空。
  // view.error 非空时列表保留而 selectable 为假，用户能看到上次结果并手动刷新。
  // 不要把可用性拆成行级独立判断，否则会出现部分行可点的分裂状态。
  const selectable = !view.loading && !view.error;
  // [契约] 在线判定只有一条：在线连接数大于零，分组、行状态、副标题共用该口径。
  // onlineDevices 单独 filter 一次而不做单次分桶，设备量小换可读性。
  // 在线组排在离线组之前，顺序即优先级，不要改成按名称排序。
  // 若上游引入最近在线字段，应在此处统一改用，而不是各处分别判断。
  const onlineDevices = view.devices.filter((device) => device.onlineConnections.length > 0);
  const offlineDevices = view.devices.filter((device) => device.onlineConnections.length === 0);
  // 弹层设备由在线列表按 MID 查找，找不到即为 undefined，弹层据此自动收起。
  // [失败路径] 设备在弹层打开期间转为离线时查找落空，弹层卸载而不是展示旧连接。
  // 不要改成用状态保存设备快照，那会绕过下线失效逻辑。
  // 查找基于已过滤的在线列表，语义是只能从在线设备进入弹层。
  // [契约] 该派生值同时作为弹层的唯一入参来源。
  const sheetDevice = onlineDevices.find((device) => device.deviceMid === sheetDeviceMid);
  // [契约] 行点击的唯一分流点：无在线连接直接返回，单连接立即选中，多连接打开弹层。
  // 单连接分支传出连接 sid 而非设备 MID，两者不可互换。
  // 多连接只记录 MID，具体选哪条连接在弹层内决定。
  // [失败路径] 首条连接不存在时静默返回，防止对空数组解构后继续调用。
  // 不要在这里清理弹层状态，关闭路径由弹层自身回调统一处理。
  const openDevice = (device: WebRemoteControlDeviceGroup) => {
    const [only, ...others] = device.onlineConnections;
    if (!only) return;
    // [契约] 单连接分支直接透传连接 sid，与弹层内的选择结果走同一个回调。
    // 判据是除首条外是否还有连接，与行内「N 个连接」徽标同源。
    // 可改写为连接数是否大于 1，但要与 multiple 的表达式保持字面一致，便于对照。
    if (others.length === 0) onSelect(only.device_sid);
    else setSheetDeviceMid(device.deviceMid);
  };

  // [资源] 滚动交给页面根容器，移动端需要它承接长列表与安全区，不能用固定高度截断。
  // 内层容器只负责最大宽度与横向内边距，不设高度，否则末行会被裁掉。
  // 刷新或空态切换不重建滚动容器，保留滚动位置，避免每次刷新跳回顶部。
  // 全局 body/#root 禁止滚动；入口自己承接长列表，保证末行可达。
  return (
    // [资源] 根容器占满动态视口高度并纵向滚动，是页面唯一的滚动层。
    // 顶部内边距叠加安全区，刘海屏下标题不会被遮挡。
    // 底部留出较大内边距，保证最后一行在弹层与手势区之上仍可点。
    // 不要给这里加横向或纵向隐藏，会把长列表锁死。
    <main className="h-dvh overflow-y-auto bg-background text-foreground">
      <div className="mx-auto w-full max-w-md px-4 pb-10 pt-[calc(env(safe-area-inset-top)+12px)]">
        <div className="flex h-10 items-center">
          <WebRemoteControlBrand />
        </div>
        <div className="mt-3 flex items-center justify-between gap-3">
          <h1 className="text-ui-xl font-semibold">{copy.title}</h1>
          <Button
            type="button"
            variant="ghost"
            aria-label={copy.refresh}
            title={copy.refresh}
            disabled={view.loading}
            onClick={onRefresh}
            className="-mr-2 size-10 rounded-lg text-foreground-subtle focus-visible:bg-hover"
          >
            <RefreshCwIcon
              className={["size-[18px]", view.loading ? "animate-spin" : ""].join(" ")}
            />
          </Button>
        </div>
        <AccountRow
          account={view.account}
          copy={copy}
          locale={locale}
          onSwitchAccount={onSwitchAccount}
        />

        {view.error ? (
          <p role="alert" className="mt-5 px-1 text-ui-sm text-destructive">
            {copy.error}
          </p>
        ) : null}
        <div aria-busy={view.loading}>
          {view.devices.length > 0 ? (
            <>
              <DeviceSection
                label={copy.online}
                devices={onlineDevices}
                copy={copy}
                selectable={selectable}
                onOpen={openDevice}
              />
              <DeviceSection
                label={copy.offline}
                devices={offlineDevices}
                copy={copy}
                selectable={selectable}
                onOpen={openDevice}
              />
              <p className="px-1 pt-3 text-ui-sm leading-5 text-foreground-subtlest">
                {copy.notFound}
              </p>
            </>
          ) : view.loading ? (
            <p role="status" className="py-16 text-center text-ui-sm text-foreground-subtle">
              {copy.loading}
            </p>
          ) : !view.error ? (
            <div className="mt-16 flex flex-col items-center px-6 text-center">
              <span className="flex size-14 items-center justify-center rounded-xl bg-surface text-foreground-subtle">
                <LaptopIcon aria-hidden="true" className="size-7" />
              </span>
              <p className="mt-4 text-ui-base font-semibold">{copy.emptyTitle}</p>
              <p className="mt-1.5 text-ui-sm leading-5 text-foreground-subtle">
                {copy.emptyDescription}
              </p>
              <Button
                type="button"
                variant="outline"
                size="lg"
                className="mt-5 h-10 px-4"
                onClick={onRefresh}
              >
                <RefreshCwIcon />
                {copy.refresh}
              </Button>
            </div>
          ) : null}
        </div>
      </div>
      <WebRemoteControlConnectionSheet
        device={sheetDevice}
        locale={locale}
        disabled={!selectable}
        now={now}
        onClose={() => setSheetDeviceMid(null)}
        onSelect={(sid) => {
          setSheetDeviceMid(null);
          onSelect(sid);
        }}
      />
    </main>
  );
}
