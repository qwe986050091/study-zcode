// INV-01 类型配色集中一处：守住位置 REMOTE_KIND_PRESENTATION；改错故障 同一类型在不同组件里颜色不一。
// INV-02 每类三套类名齐全：守住位置 className、selectedClassName、tileClassName；改错故障 选中态或图标块缺底色。
// INV-03 as const 锁定字面量：守住位置 对象收尾；改错故障 键被拓宽成 string，按 kind 索引失效。
// INV-04 图标块纯装饰：守住位置 aria-hidden；改错故障 读屏把图标名重复念一遍。
// INV-05 类型标签带 data 属性：守住位置 data-remote-connection-kind；改错故障 自动化无法按类型定位。
// INV-06 类型文案按 kind 拼 id：守住位置 模板字符串；改错故障 新增类型没有对应翻译。
// INV-07 外部展示结果优先：守住位置 supplied 的空值合并；改错故障 已聚合的线路状态被状态机覆盖。
// INV-08 状态标签可自给自足：守住位置 只给 status 时的兜底推导；改错故障 不传 presentation 就无法渲染。
// INV-09 status 角色与原子播报：守住位置 role 与 aria-atomic；改错故障 状态变化没有任何读屏反馈。
// INV-10 圆点颜色与文案同源：守住位置 presentation.dot 与 messageId；改错故障 点显示绿色而文案说失败。
// INV-11 恢复建议优先于简称：守住位置 第一段三元；改错故障 用户只看到简称，看不到怎么修。
// INV-12 简称相同则省略：守住位置 第二段三元的判等；改错故障 同一句话在标签里出现两次。
// INV-13 状态数据属性取解析后的值：守住位置 presentation.status；改错故障 选择器匹配到调用方传入的原始值。
// INV-14 格式化函数原样转出：守住位置 文件顶部的 export；改错故障 调用方必须改导入路径。
//
// 模块职责：远程连接的类型与状态标签，以及候选列表左侧的类型图标块。
// 阅读顺序：先看类型配色表，再看三个组件，最后看状态标签的恢复建议与简称回退。
import { Box, Server, TerminalSquare } from "lucide-react";
import type { SourceServerTransportKind } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  resolveRemoteConnectionPresentation,
  type RemoteConnectionPresentation,
  type RemoteConnectionStatus,
} from "@/lib/remoteConnectionPresentation.js";
export { formatConnectionProfileTarget } from "@/lib/remoteConnectionPresentation.js";

export type RemoteConnectionDisplayStatus = RemoteConnectionStatus;

/**
 * 连接类型的唯一配色来源。类型 token 只表达连接类型（DESIGN.md），
 * 类型标签、新建连接表单的类型切换、关联标签与候选图标块共用（RDUX-27）。
 */
// 连接类型的唯一配色来源，标签、表单与候选块共用。
// 新增类型必须补齐三套类名，否则标签会失去边框与底色。
export const REMOTE_KIND_PRESENTATION = {
  // SSH 用服务器图标与蓝紫系 token。
  // token 只表达类型，不表达连接状态。
  ssh: {
    Icon: Server,
    className: "border-remote-ssh-border bg-remote-ssh-surface text-remote-ssh-foreground",
    selectedClassName:
      "bg-remote-ssh-surface text-remote-ssh-foreground ring-1 ring-inset ring-remote-ssh-border",
    tileClassName: "bg-remote-ssh-surface text-remote-ssh-foreground",
  },
  // WSL 用终端图标与独立色系。
  wsl: {
    Icon: TerminalSquare,
    className: "border-remote-wsl-border bg-remote-wsl-surface text-remote-wsl-foreground",
    selectedClassName:
      "bg-remote-wsl-surface text-remote-wsl-foreground ring-1 ring-inset ring-remote-wsl-border",
    tileClassName: "bg-remote-wsl-surface text-remote-wsl-foreground",
  },
  // Docker 用容器图标与另一套 token。
  docker: {
    Icon: Box,
    className: "border-remote-docker-border bg-remote-docker-surface text-remote-docker-foreground",
    selectedClassName:
      "bg-remote-docker-surface text-remote-docker-foreground ring-1 ring-inset ring-remote-docker-border",
    tileClassName: "bg-remote-docker-surface text-remote-docker-foreground",
  },
} as const;

/** 候选列表行左侧的类型图标块。 */
export function RemoteConnectionKindTile({ kind }: { kind: SourceServerTransportKind }) {
  // 按 kind 直接解构，类型收窄由联合类型保证。
  // 图标是纯装饰，外层已标记 aria-hidden。
  const { Icon, tileClassName } = REMOTE_KIND_PRESENTATION[kind];
  return (
    <span
      aria-hidden="true"
      className={cn("flex size-8 shrink-0 items-center justify-center rounded-md", tileClassName)}
    >
      <Icon className="size-4" />
    </span>
  );
}

const BASE_TAG_CLASS_NAME =
  "inline-flex h-6 w-fit shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border px-2 text-ui-xs font-semibold";

export function RemoteConnectionKindTag({
  kind,
  className,
}: {
  kind: SourceServerTransportKind;
  className?: string;
}) {
  const { intl } = useZCodeIntl();
  const presentation = REMOTE_KIND_PRESENTATION[kind];
  const Icon = presentation.Icon;
  return (
    <span
      data-remote-connection-kind={kind}
      className={cn(BASE_TAG_CLASS_NAME, presentation.className, className)}
    >
      <Icon className="size-3" />
      {intl.formatMessage({ id: `remote.kind.${kind}` })}
    </span>
  );
}

export function RemoteConnectionStatusTag({
  status,
  presentation: supplied,
  className,
}: {
  status?: RemoteConnectionDisplayStatus;
  presentation?: RemoteConnectionPresentation;
  className?: string;
}) {
  const { intl } = useZCodeIntl();
  // 调用方给了展示结果就直接用，避免重复推导。
  // 只给 status 时按状态反推一份最小展示。
  const presentation = supplied ?? resolveRemoteConnectionPresentation({ state: status });
  return (
    <span
      // 状态标签用 status 角色，变化时读屏会播报。
      // aria-atomic 保证整块文案一起读出，而不是逐段补丁。
      role="status"
      aria-atomic="true"
      data-remote-connection-status={presentation.status}
      className={cn(
        BASE_TAG_CLASS_NAME,
        presentation.foreground,
        presentation.surface,
        presentation.border,
        className,
      )}
    >
      <span aria-hidden="true" className={cn("size-1.5 rounded-full", presentation.dot)} />
      {intl.formatMessage({ id: presentation.messageId })}
      {presentation.recovery ? (
        <>
          {" · "}
          <span>
            {intl.formatMessage(
              { id: presentation.recovery.shortMessageId },
              presentation.recovery.values,
            )}
          </span>
        </>
      ) : presentation.shortMessageId !== presentation.messageId ? (
        <>
          {" "}
          · <span>{intl.formatMessage({ id: presentation.shortMessageId })}</span>
        </>
      ) : null}
    </span>
  );
}
