// INV-01 纯展示：守住位置 全部组件；改错故障：渲染过程发起网络或改写中继状态。
// INV-02 键集对齐：守住位置 copyByLocale；改错故障：缺失键在运行时渲染成 undefined。
// INV-03 秒级时间：守住位置 formatRelativeTime 入参；改错故障：毫秒当秒用，显示五十年前。
// INV-04 单位收敛：守住位置 相对时间分支；改错故障：同一时刻在不同行显示不同单位。
// INV-05 近期合并：守住位置 一分钟内分支；改错故障：刚创建的行每秒刷新文案。
// INV-06 远期转日期：守住位置 一个月以上分支；改错故障：显示三百天前这类不可读文案。
// INV-07 整行可点：守住位置 DeviceRow 按钮；改错故障：只有文字可点，触控命中区过小。
// INV-08 首行无分割：守住位置 first 标记；改错故障：分组顶部多出一条横线。
// INV-09 平台回退：守住位置 连接平台取值；改错故障：连接未上报平台时图标空白。
// INV-10 版本可缺：守住位置 版本三元分支；改错故障：无版本时渲染出多余空格。
// INV-11 标识可辨：守住位置 标识尾部截取；改错故障：同机多实例在界面上无法区分。
// INV-12 禁用下传：守住位置 disabled 传递；改错故障：连接受限时仍可点击发起连接。
// INV-13 空设备关闭：守住位置 open 派生；改错故障：无设备时仍弹出空白选择层。
// INV-14 标题兜底：守住位置 设备名回退；改错故障：标题栏高度塌陷或显示空串。
// INV-15 计数一致：守住位置 描述中的在线数量；改错故障：文案数量与列表条目不符。
// INV-16 滚动隔离：守住位置 列表容器；改错故障：整层滚动，头部与取消按钮被带走。
// INV-17 选择透传：守住位置 onSelect 调用；改错故障：组件内自做准入，与单连接路径分叉。
// INV-18 关闭复用：守住位置 BottomSheetClose；改错故障：取消路径绕过统一关闭逻辑。
//
// 模块职责：同机多实例场景下的连接选择层，含行组件与列表组件。
// 状态所有权：无状态；设备数据、当前时间与禁用态全部由调用方注入。
// 阅读顺序：文案表 → 相对时间 → 行组件 → 列表 → 选择层。
import type { ReactNode } from "react";
import { ChevronRightIcon } from "lucide-react";
import type { WebRemoteControlRelayV2Device } from "@zcode/shared/web-remote-relay";
import {
  BottomSheet,
  BottomSheetClose,
  BottomSheetContent,
  BottomSheetDescription,
  BottomSheetHeader,
  BottomSheetTitle,
} from "@zcode/ui/bottom-sheet";
import { Button } from "@zcode/ui/button";
import { DevicePlatformIcon } from "@zcode/ui/device-platform-icon";
import type { WebRemoteControlDeviceGroup } from "#src/web-remote-control/contract.js";
import type { WebRemoteControlScreenLocale } from "#src/web-remote-control/domain/webRemoteControlScreenCopy.js";

// 文案按 locale 查表，未知 locale 由类型层挡住。
// 描述与相对时间以函数形式保存，避免提前求值。
// 两种语言键集合必须一致，新增键要同步补齐。
//
const copyByLocale = {
  "zh-CN": {
    unnamed: "未命名设备",
    sheetDescription: (count: number) => `这台电脑上有 ${count} 个 ZCode 在线，选择要连接的一个`,
    startedAgo: (relative: string) => `${relative}启动`,
    cancel: "取消",
  },
  "en-US": {
    unnamed: "Unnamed device",
    sheetDescription: (count: number) =>
      `${count} ZCode instances are online on this computer. Choose one.`,
    startedAgo: (relative: string) => `started ${relative}`,
    cancel: "Cancel",
  },
};

// 入参 timestamp 为秒级，与中继协议单位保持一致。
// elapsed 取整到最近的单位，不显示小数位。
// formatRelative 对不足一分钟统一显示刚刚，避免秒级抖动。
// 超过一个月改用 toLocaleDateString，相对天数已难以阅读。
//
function formatRelativeTime(
  createdAtSeconds: number,
  locale: WebRemoteControlScreenLocale,
  now: number,
): string {
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const diffSeconds = Math.round(createdAtSeconds - now / 1000);
  const abs = Math.abs(diffSeconds);
  if (abs < 60) return format.format(0, "minute");
  if (abs < 3600) return format.format(Math.round(diffSeconds / 60), "minute");
  if (abs < 86_400) return format.format(Math.round(diffSeconds / 3600), "hour");
  if (abs < 30 * 86_400) return format.format(Math.round(diffSeconds / 86_400), "day");
  // 超过一个月的相对天数难以阅读，改用日期。
  return new Date(createdAtSeconds * 1000).toLocaleDateString(locale);
}

/** 分组内一行：左侧图标列固定，右侧内容带内缩分隔线（首行无分隔线）。 */
// 整行由 button 承载，点击区域覆盖图标与内容。
// 左侧 icon 列宽度固定，保证多行文本对齐。
// divider 只画在内容区，首行省略以形成分组视觉。
// dimmed 同时作用于图标与文字，保持对比一致。
//
export function WebRemoteControlDeviceRow({
  first,
  disabled,
  onClick,
  leading,
  children,
  trailing,
  dimmed,
}: {
  first: boolean;
  disabled: boolean;
  onClick?: () => void;
  leading: ReactNode;
  children: ReactNode;
  trailing?: ReactNode;
  dimmed?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex w-full min-w-0 items-center gap-3 pl-4 text-left text-foreground outline-none enabled:active:bg-hover focus-visible:bg-hover disabled:cursor-not-allowed"
    >
      <span className={dimmed ? "opacity-55" : undefined}>{leading}</span>
      <span
        className={[
          "flex min-h-16 min-w-0 flex-1 items-center gap-2 py-3 pr-3",
          first ? "" : "border-t border-border",
        ].join(" ")}
      >
        <span className={["min-w-0 flex-1", dimmed ? "opacity-55" : ""].join(" ")}>{children}</span>
        {trailing}
      </span>
    </button>
  );
}

/** 多连接选择的行列表；独立导出便于在无 Portal 的环境中校验文案与禁用态。 */
// 分组内的在线连接逐条渲染，顺序沿用中继返回顺序。
// 首行不画分隔线，其余行依赖行组件的 first 标记。
// 平台优先取连接自身，缺失时回退设备平台。
// 禁用态整体下传，避免逐行重复判断。
export function WebRemoteControlConnectionList({
  device,
  locale,
  disabled,
  now,
  onSelect,
}: {
  device: WebRemoteControlDeviceGroup;
  locale: WebRemoteControlScreenLocale;
  disabled: boolean;
  now: number;
  onSelect(sid: string): void;
}) {
  const copy = copyByLocale[locale];
  return (
    <ul>
      {device.onlineConnections.map((connection: WebRemoteControlRelayV2Device, index) => (
        <li key={connection.device_sid}>
          <WebRemoteControlDeviceRow
            first={index === 0}
            disabled={disabled}
            onClick={() => onSelect(connection.device_sid)}
            leading={
              <DevicePlatformIcon
                platform={connection.meta.platform?.trim() || device.platform}
                className="size-4 text-foreground-subtle"
              />
            }
            trailing={
              <ChevronRightIcon
                aria-hidden="true"
                className="size-4 shrink-0 text-foreground-subtlest"
              />
            }
          >
            <span className="block truncate text-ui-base font-medium">
              {connection.meta.version?.trim()
                ? `ZCode ${connection.meta.version.trim()}`
                : "ZCode"}
            </span>
            <span className="mt-0.5 block truncate text-ui-sm text-foreground-subtle">
              {copy.startedAgo(formatRelativeTime(connection.created_at, locale, now))}
              {` · ID ${connection.device_sid.slice(-6)}`}
            </span>
          </WebRemoteControlDeviceRow>
        </li>
      ))}
    </ul>
  );
}

/** 同一台电脑多个在线 ZCode 时的底部选择层；选择沿用与单连接相同的 admission。 */
// device 为空即关闭，选择层不保留占位。
// 标题缺省回退未命名设备，不显示空标题栏。
// description 附带在线数量，帮助用户判断选哪个会话。
// now 以函数传入，每次打开取当时时间。
// 选择回调直接透传连接标识，准入由上层负责。
export function WebRemoteControlConnectionSheet({
  device,
  locale,
  disabled,
  now,
  onClose,
  onSelect,
}: {
  device: WebRemoteControlDeviceGroup | undefined;
  locale: WebRemoteControlScreenLocale;
  disabled: boolean;
  now(): number;
  onClose(): void;
  onSelect(sid: string): void;
}) {
  const copy = copyByLocale[locale];
  return (
    <BottomSheet
      open={Boolean(device)}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      {device ? (
        <BottomSheetContent>
          <BottomSheetHeader>
            <BottomSheetTitle>{device.name || copy.unnamed}</BottomSheetTitle>
            <BottomSheetDescription>
              {copy.sheetDescription(device.onlineConnections.length)}
            </BottomSheetDescription>
          </BottomSheetHeader>
          <div className="min-h-0 overflow-y-auto">
            <WebRemoteControlConnectionList
              device={device}
              locale={locale}
              disabled={disabled}
              now={now()}
              onSelect={onSelect}
            />
          </div>
          <div className="px-4 pt-3">
            <BottomSheetClose asChild>
              <Button type="button" variant="outline" className="h-11 w-full rounded-lg">
                {copy.cancel}
              </Button>
            </BottomSheetClose>
          </div>
        </BottomSheetContent>
      ) : null}
    </BottomSheet>
  );
}
