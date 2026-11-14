// ============================================================================
// RemoteConnectionFields.tsx — 新建/编辑远程连接表单的字段层
//
// 覆盖四种连接类型（ssh / server / wsl / docker）共用一个受控表单：
//   - 所有字段值都由调用方的 hook 持有（useRemoteConnectionForm），本文件零业务状态；
//   - 本文件只保留「纯 UI 态」：docker 输入模式、popover 展开、高级选项展开、粘贴提示。
//   - 校验结果由 fieldErrors 传入，本文件只负责把错误挂到正确的输入上。
//
// 之所以四种类型挤在一个文件：它们共享 FieldLabel / FieldError / FieldHint 与
// 同一套 test-id 约定，拆开会让「错误 id 与输入 id 对齐」这条契约变成跨文件约定。
// eslint-disable max-lines 是已知取舍，不是遗漏。
//
// INV 不变量表（每条注明守住它的位置）
// INV-01 受控组件：任何字段值的变化都必须走调用方 setter，本文件不缓存输入值。
//         守住：所有 value/onChange 成对出现，且没有本地 useState 保存字段值。
// INV-02 错误 id 必须由同一 fieldId 派生，且 aria-describedby 只在有错误时出现。
//         守住：errorId / invalidProps。
// INV-03 aria-invalid 的触发条件 = 已有错误 或 被显式标记（focusField 定位）。
//         守住：invalidProps 的 flagged 参数。
// INV-04 别名关联模式（linked）与高级模式（advanced）互斥，不能同时出现两个入口。
//         守住：两个 selectedSshConfigAlias && sshConfigAliasMode 判断。
// INV-05 清空别名必须走 clearSelectedSshConfigAlias，不能只把本地选中态置空。
//         守住：chip 的 X 按钮与 picker 的 none 选项。
// INV-06 修正主机后必须清除粘贴识别提示：提示描述的是上一次粘贴的宿主。
//         守住：host onChange 首行的 setPasteRecognized(null)。
// INV-07 粘贴拆分只在 parseSshPasteTarget 成功时接管事件，否则保留浏览器默认粘贴。
//         守住：onPaste 里的 if (!parsed) return。
// INV-08 焦点修复的触发条件是 key 变化，不是 host 变化：
//         仅当显式导入/粘贴请求时才移动焦点，普通输入不得抢焦点。
//         守住：lastFocusRequestKeyRef 与 focusRequestKey。
// INV-09 第一个空必填项的判定顺序固定：host -> username -> (password | privateKey)。
//         守住：focus effect 里的三元链。
// INV-10 docker 的 select / manual 两种输入模式互斥，切换时必须清空另一侧的值。
//         守住：模式切换 onChange 与两个输入各自的 setDockerContainer。
// INV-11 docker 空列表文案与下方原因提示必须同源（同一个 dockerContainerEmptyText）。
//         守住：CommandEmpty 与 FieldHint 共用变量。
// INV-12 容器下拉打开时才刷新列表，关闭不做任何请求。
//         守住：handleDockerContainerPopoverOpenChange。
// INV-13 非 docker 类型切换进来时，docker popover 必须立即关闭。
//         守住：监听 kind 的 useEffect。
// INV-14 wsl 用户为空合法（默认用户），非空才校验；root 只警告不拦截。
//         守住：wslUserIsInvalid 的 length > 0 前置条件。
// INV-15 别名触发器在「加载中」「已选」「未选且无候选」「未选有候选」下文案不同。
//         守住：sshAliasTriggerLabel 的四级回退。
// INV-16 picker 内的滚轮处理只在确有溢出时接管，避免吞掉外层的正常滚动。
//         守住：handleListWheel 的 scrollHeight <= clientHeight 短路。
// INV-17 打开 picker 后滚动到当前选中项：rAF 必须在 cleanup 里 cancel。
//         守住：useEffect 的 frameId。
// INV-18 本文件不得发起任何远程请求；唯一的副作用是 selectFile 的系统文件选择。
//         守住：import 区（没有 rpc/client 依赖）与唯一的 void(async) 调用。
// ============================================================================
import { RemotePasswordInput } from "@/remote-connection/RemotePasswordInput.js";
/* eslint-disable max-lines -- 远程连接字段较多，SSH/WSL/Docker 分支暂集中在单文件维护。 */
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import type {
  DockerContainerInfo,
  RemoteAssetInstallMode,
  RemoteTarget,
  RemoteWorkspaceSessionEntry,
  SSHConfigAliasOption,
  WSLDistro,
} from "@zcode/shared";
import type { LucideIcon } from "lucide-react";
import {
  AlertCircleIcon,
  AlertTriangleIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  LinkIcon,
  LoaderIcon,
  FileKey,
  XIcon,
} from "lucide-react";
import { isValidWslUser } from "@zcode/shared";
import {
  TID_DOCKER_CONTAINER_INPUT,
  TID_DOCKER_CONTAINER_SELECT,
  TID_SSH_CONFIG_ALIAS_CHIP,
  TID_SSH_CONFIG_ALIAS_SELECT,
  TID_SSH_AUTH_PASSWORD,
  TID_SSH_AUTH_PRIVATE_KEY,
  TID_SSH_HOST_INPUT,
  TID_SSH_PASSWORD_INPUT,
  TID_SSH_PORT_INPUT,
  TID_SSH_PRIVATE_KEY_INPUT,
  TID_SSH_USERNAME_INPUT,
  TID_SERVER_NAME_INPUT,
  TID_SERVER_TOKEN_INPUT,
  TID_SERVER_URL_INPUT,
  TID_SERVER_WORKSPACE_PATH_INPUT,
  TID_WSL_DISTRO_SELECT,
  TID_WSL_USER_INPUT,
} from "@zcode/shared/test-ids";
import type { SSHAuthMethod } from "@/hooks/useRemoteConnectionForm.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { RemoteConnectionHistoryInput } from "@/remote-connection/RemoteConnectionHistoryInput.js";
import {
  REMOTE_KIND_PRESENTATION,
  RemoteConnectionKindTile,
} from "@/remote-connection/RemoteConnectionTags.js";
import { buildSshConnectionHistorySuggestions } from "@/remote-connection/sshHistorySuggestions.js";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command.js";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  parseSshPasteTarget,
  type RemoteFormField,
  type RemoteFormFieldError,
} from "@/lib/remoteConnectionWizard.js";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible.js";

// 分段控件的选项契约。selectedClassName 只给「连接类型切换」用，
// 其余分段保持中性选中态，这是 DESIGN.md Tabs 的规定。
// testId 直接透传到 button 上，供 E2E 按语义定位而不是按文案。
export interface RemoteSegmentedOption<T extends string> {
  value: T;
  label: string;
  icon?: LucideIcon;
  /** 只有连接类型切换传入类型色；其余分段保持中性选中态（DESIGN.md Tabs）。 */
  selectedClassName?: string;
  testId?: string;
}

/** 远程连接表单统一的分段控件：外框方框、竖线分隔、选中项 aria-pressed。 */
// 泛型分段控件：用 role=group + aria-pressed 而不是 radio，
// 因为它是「多按钮过滤器」语义，不是表单单选组。
// label 与 labelledBy 二选一：label 用字面量，labelledBy 指向外部标题，
// 两者都给时 aria-labelledby 优先，会覆盖 aria-label（可访问性规范如此）。
// wrap 只影响按钮内部文本换行，不影响容器 flex-wrap：
// 分段必须整体横向滚动或收缩，换行会让分组边框断开。
export function RemoteSegmentedControl<T extends string>({
  label,
  labelledBy,
  value,
  options,
  onChange,
  disabled,
  wrap = false,
}: {
  label?: string;
  labelledBy?: string;
  value: T;
  options: RemoteSegmentedOption<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
  /** 长文案（如下载方式）允许换行；短标签保持单行。 */
  wrap?: boolean;
}) {
  return (
    <div
      // 用 group 而不是 radiogroup：分段控件的按钮是「切换过滤器」语义，
      // aria-pressed 已足够表达选中态；radiogroup 还会要求方向键切换焦点。
      role="group"
      aria-label={label}
      aria-labelledby={labelledBy}
      className="flex w-fit max-w-full overflow-hidden rounded-lg border border-input-border"
    >
      {options.map((option, index) => {
        // 用值而不是索引判断选中：选项数量会随版本变化，索引比较会在重排后错位。
        // aria-pressed 与视觉选中必须同源，否则读屏用户和视力用户看到的选中项不同。
        const selected = option.value === value;
        const Icon = option.icon;
        return (
          <button
            key={option.value}
            type="button"
            // aria-pressed 只接受布尔值，不能传 undefined：
            // 传 undefined 会让按钮退化成普通按钮，读屏不再播报选中态。
            // 视觉选中与无障碍选中必须由同一个 selected 派生。
            aria-pressed={selected}
            disabled={disabled}
            data-testid={option.testId}
            onClick={() => onChange(option.value)}
            className={cn(
              "inline-flex min-h-8 min-w-0 items-center justify-center gap-1.5 px-3 text-ui-base transition-colors disabled:opacity-50",
              // wrap 模式只改内边距与对齐，不打开 flex-wrap：
              // 分段必须保持单行，否则外框会把断行处包成两段视觉区域。
              wrap ? "py-1 text-center" : "whitespace-nowrap",
              // 分隔线用「除第一项外左边框」而不是每项右边框：
              // 后者会让容器右边缘出现双重边框（外框 + 最后一项右边框）。
              index > 0 && "border-l border-input-border",
              selected
                ? cn("font-medium", option.selectedClassName ?? "bg-selected text-foreground")
                : // 全局样式禁用了 focus outline / box-shadow，键盘焦点改用背景提示。
                  "text-remote-foreground-muted hover:text-foreground focus-visible:bg-hover focus-visible:text-foreground",
            )}
          >
            {Icon ? <Icon className="size-3.5 shrink-0" /> : null}
            <span className={cn("min-w-0", wrap && "break-words")}>{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}

// 哨兵值必须是一个不可能等于真实 alias 的字符串，且不能以字母开头：
// CommandItem 的 value 参与模糊搜索，普通单词会被用户输入命中。
// 双下划线前缀同时降低「与真实 Host 重名」的概率。
// 不要用空串：Radix Command 把空 value 视为无效项，会被过滤掉。
const NO_SSH_CONFIG_ALIAS_VALUE = "__ssh_config_alias_none__";

// 摘要格式固定为 [user@]host[:port]，这是 SSH 用户在终端里最熟悉的写法。
// host 缺失时退回 alias：某些 config 只有 Host 别名没有 HostName，
// 此时别名本身就是可解析目标（交给 ssh 自己解析）。
// port 用 != null 判断而不是真值判断，端口 0 虽然非法但要如实展示以便报错。
export function formatSshConfigAliasSummary(aliasOption: SSHConfigAliasOption): string {
  const host = aliasOption.host?.trim() || aliasOption.alias;
  const username = aliasOption.username?.trim();
  // 用户名可选：SSH config 允许只写 HostName，此时凭据由 ssh-agent / 默认用户决定。
  // 拼串顺序固定 user@host，这是 ssh 命令行唯一可解析的形式。
  const withUser = username ? `${username}@${host}` : host;
  return aliasOption.port != null ? `${withUser}:${aliasOption.port}` : withUser;
}

/**
 * SSH config Host 的可搜索弹层。新建连接的「从 SSH config 导入」与编辑连接高级选项里的
 * 别名下拉共用同一列表，触发按钮由调用方提供。
 */
// 别名选择器。两处复用：新建表单的「从 SSH config 导入」与编辑弹窗的高级选项。
// includeNoneOption 对应「编辑态需要能解除关联」，新建态改用 chip 上的 X。
// children 作为 trigger 由调用方提供，是为了让新建态显示 chip、编辑态显示普通按钮，
// 而选择器本身不需要感知这两种外观。
export function SshConfigAliasPicker({
  aliases,
  selectedAlias,
  includeNoneOption = false,
  align = "start",
  onApply,
  onClear,
  children,
}: {
  aliases: SSHConfigAliasOption[];
  selectedAlias: string | null;
  /** 编辑连接的下拉保留「不使用别名」；新建表单用关联标签的 × 解除。 */
  includeNoneOption?: boolean;
  align?: "start" | "end";
  onApply: (option: SSHConfigAliasOption) => void;
  onClear?: () => void;
  children: ReactNode;
}) {
  const { intl } = useZCodeIntl();
  const [open, setOpen] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);
  // Popover 嵌在 Dialog 内时，Dialog 的滚动锁会 preventDefault 掉滚轮，
  // 导致候选列表只能拖滚动条。这里显式写 scrollTop 并阻止冒泡。
  // short-circuit 条件是必要的：没有溢出时接管滚轮会让外层页面无法滚动。
  // event.preventDefault 必须在手动滚动之后调用，顺序反了会出现「滚一下跳两行」。
  const handleListWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    const listElement = event.currentTarget;
    // 没有溢出时不接管滚轮：
    // 否则鼠标停在短列表上滚动，页面却不动，用户会以为页面卡住。
    if (listElement.scrollHeight <= listElement.clientHeight) {
      return;
    }

    // Popover 嵌在 Dialog 中时，外层滚动锁会吞掉默认滚轮行为，
    // 导致 alias CommandList 只能拖滚动条、不能直接滚轮滚动。
    // 这里显式驱动列表自身 scrollTop，确保鼠标滚轮和触控板都能滚动候选项。
    // 直接累加 deltaY 而不是用 scrollBy：
    // 部分浏览器在 preventDefault 之后 scrollBy 会被合并到下一帧，产生滞后感。
    listElement.scrollTop += event.deltaY;
    event.preventDefault();
    event.stopPropagation();
  }, []);

  useEffect(() => {
    if (!open) {
      return;
    }

    // 用 rAF 等一帧：Popover 内容在 open 的同一 tick 内尚未布局，
    // 同步 scrollIntoView 会因高度为 0 而滚到顶部。
    // cleanup 必须 cancel：快速开关 picker 时旧帧会把列表滚回旧位置。
    // 依赖含 aliases.length：候选到达后需要重新定位选中项。
    const frameId = window.requestAnimationFrame(() => {
      listRef.current
        ?.querySelector<HTMLElement>('[data-ssh-config-alias-selected="true"]')
        // block:"nearest" 保证列表只在必要时滚动：
        // 用 center 会让首次打开就把选中项顶到中间，视觉上像列表自己跳了一下。
        ?.scrollIntoView({ block: "nearest" });
    });

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [open, selectedAlias, aliases.length]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align={align} sideOffset={6} className="w-80 gap-0 bg-menu p-0">
        <Command className="bg-transparent p-0 text-foreground">
          <CommandInput
            placeholder={intl.formatMessage({
              id: "ssh.configAliasSearchPlaceholder",
            })}
            className="h-8"
          />
          <CommandList
            ref={listRef}
            // overscroll-contain 阻止滚到边界后把滚动传给外层 Dialog：
            // 否则列表到底再滚一下，整个弹窗会跟着动。
            className="max-h-60 overscroll-contain"
            onWheel={handleListWheel}
          >
            <CommandEmpty className="px-4 py-5 text-remote-foreground-muted">
              {intl.formatMessage({ id: "ssh.configAliasEmpty" })}
            </CommandEmpty>
            <CommandGroup className="p-1">
              {includeNoneOption ? (
                <CommandItem
                  value={NO_SSH_CONFIG_ALIAS_VALUE}
                  // 「不使用别名」项的选中态是 selectedAlias 为 null，
                  // 不能用空串判断：空串在 Command 的 value 匹配里可能被当成「无值」。
                  // data-checked 只写 true，不写 false —— 与 Radix 的 data-state 约定保持一致。
                  data-checked={selectedAlias == null ? "true" : undefined}
                  data-ssh-config-alias-selected={selectedAlias == null ? "true" : undefined}
                  className="min-h-8 cursor-pointer px-2 text-ui-base"
                  // 选中哨兵项后先清空别名再关闭：
                  // 顺序反了会让 Popover 关闭动画期间读到旧的选中值并高亮错误项。
                  // onClear 是可选回调：新建态没有外部关联可清，但仍要关闭弹层。
                  onSelect={() => {
                    onClear?.();
                    setOpen(false);
                  }}
                >
                  <span className="truncate">
                    {intl.formatMessage({
                      id: "ssh.configAliasPlaceholder",
                    })}
                  </span>
                </CommandItem>
              ) : null}
              {aliases.map((aliasOption) => {
                // 比较原始别名而不是格式化摘要：
                // 摘要包含 user/port，两个不同 Host 可能摘要相同，用它比较会同时高亮多项。
                const selected = selectedAlias === aliasOption.alias;
                return (
                  <CommandItem
                    key={aliasOption.alias}
                    value={`${aliasOption.alias} ${formatSshConfigAliasSummary(aliasOption)}`}
                    data-checked={selected ? "true" : undefined}
                    // 这个属性是「打开时滚动到选中项」的查找键，
                    // 改名必须同步修改上方 querySelector，否则滚动定位静默失效。
                    data-ssh-config-alias-selected={selected ? "true" : undefined}
                    className="min-h-8 cursor-pointer gap-2 px-2 text-ui-base"
                    // 选中容器时同步清空手工输入：两种模式共用 field "docker"，
                    // 残留的 manual 值会在下次切到 manual 时突然出现在输入框里。
                    onSelect={() => {
                      onApply(aliasOption);
                      setOpen(false);
                    }}
                  >
                    <RemoteConnectionKindTile kind="ssh" />
                    <span className="flex min-w-0 flex-1 flex-col text-left">
                      <span className="truncate">{aliasOption.alias}</span>
                      <span className="truncate font-mono text-ui-sm text-remote-foreground-muted">
                        {formatSshConfigAliasSummary(aliasOption)}
                      </span>
                    </span>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

// 统一标签：htmlFor 与 id 都由调用方传入，本组件不生成 id，
// 因为错误 id 与输入 id 必须共享同一个 fieldId 前缀。
function FieldLabel({
  htmlFor,
  id,
  children,
}: {
  htmlFor?: string;
  id?: string;
  children: ReactNode;
}) {
  return (
    <label
      htmlFor={htmlFor}
      id={id}
      className="mb-1.5 block text-ui-sm text-remote-foreground-muted"
    >
      {children}
    </label>
  );
}

// 无消息时返回 null 而不是渲染空 p：
// 空 p 仍会占 mt-1.5 的间距，表单会在「有错/无错」之间跳动。
// id 必须与输入的 aria-describedby 完全一致，否则读屏读不到错误。
function FieldError({ id, message }: { id: string; message?: string }) {
  // 空消息返回 null，不渲染带 id 的空元素：
  // aria-describedby 指向空元素时读屏会播报「无效」，但读不出原因。
  if (!message) return null;
  return (
    <p id={id} className="mt-1.5 flex items-start gap-1 text-ui-sm text-destructive">
      <AlertCircleIcon className="mt-0.5 size-3.5 shrink-0" />
      <span>{message}</span>
    </p>
  );
}

/** 字段下方提示：限制信息用 warning 卡片，粘贴识别用 success，其余中性。 */
// 提示条三档语气：muted（普通说明）、success（粘贴识别成功）、warning（限制/风险）。
// data-remote-field-hint 是测试与样式共享的钩子，不要改成仅 class 判断。
// warning 使用独立背景卡片，因为它承载「为什么不能提交」这类阻断信息。
function FieldHint({
  tone = "muted",
  children,
}: {
  tone?: "muted" | "warning" | "success";
  children: ReactNode;
}) {
  return (
    <p
      data-remote-field-hint={tone}
      className={cn(
        "mt-1.5 flex items-start gap-1.5 text-pretty text-ui-sm",
        tone === "muted" && "text-remote-foreground-muted",
        tone === "success" && "text-success",
        tone === "warning" &&
          "rounded-lg bg-warning-surface px-3 py-2 text-warning-surface-foreground",
      )}
    >
      {tone === "warning" ? <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" /> : null}
      {tone === "success" ? <CheckIcon className="mt-0.5 size-3.5 shrink-0" /> : null}
      <span>{children}</span>
    </p>
  );
}

// 字段组件入口。props 分四类，阅读时按类看：
//   1) 受控值（host/port/username/...），全部必填（部分可选）；
//   2) 远程数据（distros / containers / aliases / sessions）；
//   3) 异步标记（loading / error 字符串）；
//   4) 动作（setXxx / apply / clear / refresh）。
// focusCredentials 与 focusField 是两套焦点语义：
// 前者「聚焦凭据区」，后者「聚焦指定字段并标记 invalid」。
// wslUser 与 setWslUser 是可选的：其他平台调用方可以不提供。
export function RemoteConnectionFields({
  focusCredentials,
  autoFocusHost = false,
  focusFirstEmptyToken = 0,
  sshConfigAliasMode = "advanced",
  fieldErrors = [],
  runtimeOptionsError = "",
  focusField,
  passwordPlaceholder,
  privateKeyPassphrasePlaceholder,
  kind,
  host,
  port,
  username,
  sshAuthMethod,
  assetInstallMode,
  password,
  privateKeyPath,
  privateKeyPassphrase,
  wslDistro,
  wslUser = "",
  wslDistros,
  dockerContainer,
  manualDockerContainer,
  serverUrl,
  serverName,
  serverToken,
  serverWorkspacePath,
  dockerContainers,
  dockerAvailable,
  sshConfigAliases,
  sshConfigAliasesLoading,
  sshConfigAliasesError,
  selectedSshConfigAlias,
  runtimeOptionsLoading,
  remoteWorkspaceSessions = [],
  refreshDockerContainers,
  applySshConfigAlias,
  clearSelectedSshConfigAlias,
  setHost,
  setPort,
  setUsername,
  setSshAuthMethod,
  setAssetInstallMode,
  setPassword,
  setPrivateKeyPath,
  setPrivateKeyPassphrase,
  setWslDistro,
  setWslUser,
  setDockerContainer,
  setManualDockerContainer,
  setServerUrl,
  setServerName,
  setServerToken,
  setServerWorkspacePath,
}: {
  focusCredentials?: boolean;
  /** 新建连接表单打开时把焦点放在主机（RDUX-27）。 */
  autoFocusHost?: boolean;
  /** 每次递增时把焦点移到第一个为空的必填 SSH 字段；全部已填时移到表单主操作。 */
  focusFirstEmptyToken?: number;
  /**
   * linked：新建连接表单，别名由外部「从 SSH config 导入」选择，这里只显示关联标签；
   * advanced：编辑连接弹窗，别名下拉保留在高级选项内。
   */
  sshConfigAliasMode?: "advanced" | "linked";
  /** 提交后显示的内联错误，来自 collectRemoteFormFieldErrors。 */
  fieldErrors?: RemoteFormFieldError[];
  runtimeOptionsError?: string;
  focusField?: "host" | "auth";
  passwordPlaceholder?: string;
  privateKeyPassphrasePlaceholder?: string;
  kind: RemoteTarget["kind"];
  host: string;
  port: string;
  username: string;
  sshAuthMethod: SSHAuthMethod;
  assetInstallMode: RemoteAssetInstallMode;
  password: string;
  privateKeyPath: string;
  privateKeyPassphrase: string;
  wslDistro: string;
  wslUser?: string;
  wslDistros: WSLDistro[];
  dockerContainer: string;
  manualDockerContainer: string;
  serverUrl: string;
  serverName: string;
  serverToken: string;
  serverWorkspacePath: string;
  dockerContainers: DockerContainerInfo[];
  dockerAvailable: boolean | null;
  sshConfigAliases: SSHConfigAliasOption[];
  sshConfigAliasesLoading: boolean;
  sshConfigAliasesError: string;
  selectedSshConfigAlias: string | null;
  runtimeOptionsLoading: boolean;
  remoteWorkspaceSessions?: RemoteWorkspaceSessionEntry[];
  refreshDockerContainers?: () => void;
  applySshConfigAlias: (value: SSHConfigAliasOption) => void;
  clearSelectedSshConfigAlias: () => void;
  setHost: (value: string) => void;
  setPort: (value: string) => void;
  setUsername: (value: string) => void;
  setSshAuthMethod: (value: SSHAuthMethod) => void;
  setAssetInstallMode: (value: RemoteAssetInstallMode) => void;
  setPassword: (value: string) => void;
  setPrivateKeyPath: (value: string) => void;
  setPrivateKeyPassphrase: (value: string) => void;
  setWslDistro: (value: string) => void;
  setWslUser?: (value: string) => void;
  setDockerContainer: (value: string) => void;
  setManualDockerContainer: (value: string) => void;
  setServerUrl: (value: string) => void;
  setServerName: (value: string) => void;
  setServerToken: (value: string) => void;
  setServerWorkspacePath: (value: string) => void;
}) {
  const { intl } = useZCodeIntl();
  // useId 生成的前缀保证同一页面多个表单的 label/error/datalist id 不冲突。
  // 所有派生 id 必须经由这个前缀，直接写固定 id 是多表单并存时的经典串台来源。
  const fieldId = useId();
  // docker 输入模式的初值是「推导」而非固定 select：
  // 已有手工容器名、或当前没有选中容器时进入 manual。
  // 这个推导只在挂载时执行一次。之后由用户切换主导，
  // 否则编辑已有连接时用户手动切到 select 会被下一次渲染重置回来。
  const [dockerInputMode, setDockerInputMode] = useState<"select" | "manual">(
    manualDockerContainer || !dockerContainer ? "manual" : "select",
  );
  const platform = usePlatform();
  // popover 展开态放在本地，而不是交给 Radix 非受控：
  // 因为切到非 docker 类型时需要程序化关闭（见下方 effect）。
  const [dockerContainerPopoverOpen, setDockerContainerPopoverOpen] = useState(false);
  // 高级选项默认收起，且不做持久化：
  // 展开态属于一次性操作意图，记住它会让下次打开表单时多出一段无关字段。
  const [advancedOptionsOpen, setAdvancedOptionsOpen] = useState(false);
  // 粘贴识别结果只属于本次粘贴；主机再被手动修改时清除。
  // 粘贴识别提示只属于「本次粘贴」，不持久化：
  // 它描述的是剪贴板内容，不是表单状态。
  // host 被手动修改时立即清除，否则提示会和当前值矛盾。
  const [pasteRecognized, setPasteRecognized] = useState<string | null>(null);
  const [pasteFocusRequest, setPasteFocusRequest] = useState(0);
  // SSH 根节点 ref 只服务于焦点修复 effect；
  // 不要在渲染期读取它，首次渲染时必为 null。
  const sshRootRef = useRef<HTMLDivElement | null>(null);
  // 历史候选在每次渲染时重建。这里没有 useMemo 是刻意的：
  // 函数内部做了去重与截断，成本远低于一次表单重渲染；
  // 加 memo 反而让 remoteWorkspaceSessions 的引用稳定性成为隐藏前提。
  // 密码/口令不进入历史，只有 host/port/user/私钥路径会被记录。
  const sshHistorySuggestions = buildSshConnectionHistorySuggestions(remoteWorkspaceSessions);
  // 错误查找与错误 id 生成都集中在两个闭包里，
  // 新增字段时只要传字段名，就会自动获得 aria 关联与错误渲染。
  // fieldErrors 是数组而不是 map：同一字段理论上只应有一条错误，find 取第一条。
  const errorOf = (field: RemoteFormField) =>
    fieldErrors.find((error) => error.field === field)?.message;
  const errorId = (field: RemoteFormField) => `${fieldId}-${field}-error`;
  // aria-invalid 与 aria-describedby 必须同时来自同一个错误来源：
  // 只标 invalid 不关联描述，读屏只会说「无效」而说不出原因。
  // flagged 用于「聚焦到该字段但尚未校验」的场景，
  // 此时只描红不挂 describedby（没有文案可挂）。
  // 返回对象直接展开到输入上，因此键名必须是字符串字面量而不是变量。
  const invalidProps = (field: RemoteFormField, flagged = false) => ({
    "aria-invalid": errorOf(field) || flagged ? true : undefined,
    "aria-describedby": errorOf(field) ? errorId(field) : undefined,
  });
  // 选中别名可能来自旧快照（配置文件已删除该 Host），
  // find 返回 undefined 时仍保留 selectedSshConfigAlias 作为展示值，
  // 不能因为查不到就当成「未选择」——那会让用户的关联静默丢失。
  const selectedSshAliasOption =
    selectedSshConfigAlias == null
      ? null
      : (sshConfigAliases.find((option) => option.alias === selectedSshConfigAlias) ?? null);
  // 四级文案：加载中 > 选中项显示名 > 原始选中值 > 无候选提示 > 占位。
  // 第二级用 aliasOption.alias 而不是 selectedSshConfigAlias：
  // aliasOption.alias 与 selectedSshConfigAlias 通常相同，但别名会被规范化大小写后展示。
  // 「无候选」与「未选择」必须区分，否则用户会以为是自己没选。
  const sshAliasTriggerLabel = sshConfigAliasesLoading
    ? intl.formatMessage({ id: "common.loading" })
    : (selectedSshAliasOption?.alias ??
      selectedSshConfigAlias ??
      (sshConfigAliases.length === 0
        ? intl.formatMessage({ id: "ssh.configAliasEmpty" })
        : intl.formatMessage({ id: "ssh.configAliasPlaceholder" })));
  // Bugfix: 空下拉列表曾固定显示「选择正在运行的容器」，下拉又盖住选择器下方的原因提示，
  // 用户看不到为什么没有候选。空列表与下方提示共用同一条原因文案。
  // 空列表原因的三级判定：加载失败 > docker 不可用 > 没有运行中的容器。
  // 这个字符串同时用于下拉内的 CommandEmpty 与下方的 FieldHint，
  // 两处不同源是历史上的真实缺陷：下拉说「没有容器」，下方说「加载失败」。
  // 注意 runtimeOptionsError 优先于 dockerAvailable === false：
  // 发现失败时 dockerAvailable 通常是 null，但若恰好为 false 也要先说失败原因。
  const dockerContainerEmptyText = runtimeOptionsError
    ? intl.formatMessage({ id: "remote.optionsLoadFailed" })
    : dockerAvailable === false
      ? intl.formatMessage({ id: "docker.unavailable" })
      : intl.formatMessage({ id: "docker.noContainers" });
  // 触发器文案：已选容器名 > 加载中 > 「选择容器」。
  // trim 后为空才算未选，纯空格不算合法容器名。
  const dockerContainerTriggerLabel =
    dockerContainer.trim() ||
    (runtimeOptionsLoading
      ? intl.formatMessage({ id: "docker.loading" })
      : intl.formatMessage({ id: "docker.selectContainer" }));
  // 占位态只影响文字颜色，不影响是否禁用：
  // 列表加载失败时按钮仍可点开，让用户看到失败原因。
  const dockerContainerTriggerIsPlaceholder = !dockerContainer.trim();
  // 手工输入为空时展示填写提示，但不禁用提交：
  // 错误由 collectRemoteFormFieldErrors 在提交时统一给出。
  const manualDockerContainerIsEmpty = manualDockerContainer.trim().length === 0;
  // root 只做警告，不阻断：某些镜像只允许 root 登录，
  // 硬拦截会让这类环境完全无法连接。
  // 大小写不敏感匹配，避免 Root / ROOT 绕过提示。
  const wslUserIsRoot = wslUser.trim().toLowerCase() === "root";
  // wslUser 空串合法，语义是使用发行版默认用户。
  // 前置 length > 0 不能省：isValidWslUser("") 返回 false，
  // 省掉后空输入会被标红，新用户一进来就看到错误。
  const wslUserIsInvalid = wslUser.trim().length > 0 && !isValidWslUser(wslUser);
  // 只在打开时刷新，关闭时不请求：
  // 关闭触发的刷新会与下一次打开的刷新竞争，导致列表闪回旧数据。
  // refreshDockerContainers 是可选的，未提供时下拉只展示已有快照。
  const handleDockerContainerPopoverOpenChange = (nextOpen: boolean) => {
    setDockerContainerPopoverOpen(nextOpen);
    if (nextOpen) {
      refreshDockerContainers?.();
    }
  };

  useEffect(() => {
    // 切换连接类型时强制关闭 docker popover。
    // Radix Popover 的 Portal 挂在 body 上，不随分支卸载自动关闭，
    // 不处理会在切到 SSH 后留下一个悬空的容器列表。
    if (kind !== "docker" && dockerContainerPopoverOpen) {
      setDockerContainerPopoverOpen(false);
    }
  }, [dockerContainerPopoverOpen, kind]);

  // 导入 Host 或粘贴拆分后，按提交后的最新字段值把焦点移到第一个空必填项（RDUX-27）。
  // 放在 effect 里而不是事件回调里，保证读取到已经提交到 DOM 的值。
  // 把「外部导入请求」与「本次粘贴」两个计数拼成一个 key。
  // 用 key 比较而不是依赖数组里的两个数字：
  // 任一计数变化都视为一次新的焦点请求，且不会重复触发。
  // lastFocusRequestKeyRef 的初值等于首个 key，保证挂载时不抢焦点。
  const focusRequestKey = `${focusFirstEmptyToken}:${pasteFocusRequest}`;
  const lastFocusRequestKeyRef = useRef(focusRequestKey);
  useEffect(() => {
    if (lastFocusRequestKeyRef.current === focusRequestKey) return;
    lastFocusRequestKeyRef.current = focusRequestKey;
    // 焦点修复 effect 的整体顺序：先比对 key（去重），再找根节点，
    // 再按「第一个空必填项」定位，最后 fallback 到表单主操作。
    // 必须在 effect 里读 DOM：事件回调执行时新值还没提交到受控输入，
    // 读到的是上一轮的值，会定位到错误的字段。
    const root = sshRootRef.current;
    // 根节点缺失说明当前不是 SSH 分支（或尚未挂载）。
    // 直接返回而不是 fallback 到 document：
    // document 上可能有其他表单的 submit 按钮，抢焦点会提交错误的表单。
    if (!root) return;
    const firstEmptyTestId = !host.trim()
      ? TID_SSH_HOST_INPUT
      : !username.trim()
        ? TID_SSH_USERNAME_INPUT
        : sshAuthMethod === "password"
          ? TID_SSH_PASSWORD_INPUT
          : !privateKeyPath.trim()
            ? TID_SSH_PRIVATE_KEY_INPUT
            : null;
    // 空必填项用 data-testid 定位而不是 id：id 带 useId 前缀，
    // 跨渲染不稳定，而 testid 是产品级稳定契约。
    // 全部已填时把焦点移到 form 的提交按钮（closest("form")）：
    // 全部已填时 focus 提交按钮，让「导入后按回车即可提交」成立。
    const target = firstEmptyTestId
      ? root.querySelector<HTMLElement>(`[data-testid="${firstEmptyTestId}"]`)
      : root.closest("form")?.querySelector<HTMLElement>('button[type="submit"]');
    target?.focus();
  }, [focusRequestKey]);

  // 高级选项里的别名字段。触发器在「加载中」或「无候选且未选中」时禁用，
  // 但已选中时保持可点，让用户能打开列表改选或清除。
  // 错误只显示一行通用文案（加载失败），不展示底层错误对象：
  // SSH config 解析错误可能含本机路径，不适合直接呈现。
  const sshAliasField = (
    <div className="space-y-1">
      <FieldLabel htmlFor={`${fieldId}-ssh-alias`}>
        {intl.formatMessage({ id: "ssh.configAlias" })}
      </FieldLabel>
      <SshConfigAliasPicker
        aliases={sshConfigAliases}
        selectedAlias={selectedSshConfigAlias}
        includeNoneOption
        onApply={applySshConfigAlias}
        onClear={clearSelectedSshConfigAlias}
      >
        <Button
          type="button"
          variant="outline"
          size="lg"
          disabled={
            // disabled 只有两个来源：sshConfigAliasesLoading 为真，或候选为空且 selectedSshConfigAlias 缺省。
            // selectedSshConfigAlias 有值而列表为空时仍可点，否则用户无法打开并清除失效关联。
            // 不要把 sshConfigAliasesError 加进禁用条件，加载失败时仍需让用户看到错误。
            sshConfigAliasesLoading || (sshConfigAliases.length === 0 && !selectedSshConfigAlias)
          }
          id={`${fieldId}-ssh-alias`}
          data-testid={TID_SSH_CONFIG_ALIAS_SELECT}
          className="h-9 w-full max-w-80 justify-between rounded-lg border-input-border bg-input px-3 text-ui-base font-normal hover:border-input-border-hover hover:bg-input aria-expanded:border-input-border-focused aria-expanded:bg-input-focused"
        >
          <span className="min-w-0 truncate text-left">{sshAliasTriggerLabel}</span>
          <ChevronDownIcon className="size-3.5 text-remote-foreground-muted" />
        </Button>
      </SshConfigAliasPicker>
      {sshConfigAliasesError ? (
        <p className="text-pretty text-ui-sm text-remote-foreground-muted">
          {intl.formatMessage({
            id: "ssh.configAliasLoadFailed",
          })}
        </p>
      ) : null}
    </div>
  );

  // 四种类型各自 return 整块 JSX，没有 default：
  // RemoteTarget["kind"] 是闭合联合，新增类型时 TS 会报「并非所有路径都返回值」。
  // 不要把共用字段提到 switch 外面：SSH 的字段布局与 server/wsl/docker 差异极大，
  // 强行复用会让每种类型都带上一堆条件渲染。
  switch (kind) {
    // SSH 分支是唯一有「别名关联 chip」的类型。
    // chip 与高级选项里的下拉不会同时出现，由 sshConfigAliasMode 决定。
    // host 与 port 固定同一行（grid-cols-[minmax(0,1fr)_6rem]）：
    // 端口宽度必须固定，否则窄屏下 host 会被压缩到不可读。
    // 主机行下方的两个 FieldError 是分开的：端口错误文案较长，
    // 塞进 6rem 列会换成多行并撑高整行。
    case "ssh":
      return (
        <div ref={sshRootRef} className="space-y-4">
          {selectedSshConfigAlias && sshConfigAliasMode === "linked" ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span
                data-testid={TID_SSH_CONFIG_ALIAS_CHIP}
                className={cn(
                  "inline-flex h-7 items-center gap-1.5 rounded-md border pr-0.5 pl-2 text-ui-sm",
                  REMOTE_KIND_PRESENTATION.ssh.className,
                )}
              >
                <LinkIcon className="size-3.5 shrink-0" />
                <span className="truncate">
                  {intl.formatMessage(
                    { id: "ssh.configAliasLinked" },
                    { alias: selectedSshConfigAlias },
                  )}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  // 解除关联按钮必须同时给 aria-label 与 title：
                  // 图标按钮没有可见文本，读屏依赖前者、鼠标用户依赖后者。
                  aria-label={intl.formatMessage({ id: "ssh.configAliasUnlink" })}
                  title={intl.formatMessage({ id: "ssh.configAliasUnlink" })}
                  onClick={clearSelectedSshConfigAlias}
                >
                  <XIcon />
                </Button>
              </span>
              <span className="text-ui-sm text-remote-foreground-muted">
                {intl.formatMessage({ id: "ssh.configAliasLinkedHint" })}
              </span>
            </div>
          ) : null}
          {selectedSshConfigAlias && sshConfigAliasMode === "advanced" ? (
            <p className="text-pretty text-ui-sm text-remote-foreground-muted">
              {selectedSshConfigAlias} · {intl.formatMessage({ id: "ssh.configAliasDescription" })}
            </p>
          ) : null}
          {/* Bugfix: Electron / Chromium 的原生 autocomplete 在 SSH 向导里不稳定，
              而且默认值（如 localhost / 22）会把历史候选提前过滤掉。
              这里改成用应用自身持久化的远程连接历史做显式候选，focus 时先展示完整历史；密码仍然不参与历史回填。 */}
          {/* Bugfix: 建议列表之前直接跟着全宽输入框展开，在大对话框里会变成长条。
              这里把宽度限制在字段语义范围内，只收窄建议列表，不改变原输入框布局。 */}
          {/* Bugfix: 示例值直接作为 placeholder 会被误认为已有默认值。
              这里改成“输入提示 + 示例”，让用户知道仍需手动填写必填字段。 */}
          {/* 主机与端口同属连接目标，放在同一行；端口固定 6rem，窄屏同样并排（RDUX-27）。 */}
          <div>
            <div className="grid grid-cols-[minmax(0,1fr)_6rem] gap-3">
              <div className="min-w-0">
                <RemoteConnectionHistoryInput
                  className="h-9 font-mono placeholder:font-sans text-ui-base"
                  label={intl.formatMessage({ id: "ssh.host" })}
                  autoFocus={autoFocusHost || focusField === "host"}
                  {...invalidProps("host", focusField === "host")}
                  value={host}
                  onChange={(value) => {
                    setPasteRecognized(null);
                    setHost(value);
                  }}
                  // 失焦时 trim 主机名：复制粘贴常带首尾空格，
                  // 空格会进入连接串并导致 ssh 报「Could not resolve hostname」。
                  // 在 blur 而不是 onChange 里 trim，避免用户输入中间空格时被吞掉。
                  onBlur={() => setHost(host.trim())}
                  onPaste={(event) => {
                    // 解析失败时直接 return，不 preventDefault：
                    // 用户粘贴普通文本（例如带空格的备注）时仍应正常进入输入框。
                    // 解析成功才接管，并一次性填充 host/username/port 三个字段。
                    const parsed = parseSshPasteTarget(event.clipboardData.getData("text"));
                    if (!parsed) return;
                    // 粘贴 user@host:port 或 ssh 命令时一次填好三个字段；setter 走表单原有语义，
                    // 视为手动修改并解除别名关联（RDUX-27）。
                    event.preventDefault();
                    setHost(parsed.host);
                    if (parsed.username) setUsername(parsed.username);
                    if (parsed.port) setPort(parsed.port);
                    // 提示文本按「实际填入了什么」重建，而不是回显原始剪贴板：
                    // 原始内容可能含 ssh 命令前缀（ssh -p 2222 user@host），回显会让用户以为输入框里是那串命令。
                    setPasteRecognized(
                      `${parsed.username ? `${parsed.username}@` : ""}${parsed.host}${
                        parsed.port ? `:${parsed.port}` : ""
                      }`,
                    );
                    setPasteFocusRequest((request) => request + 1);
                  }}
                  placeholder={intl.formatMessage({ id: "ssh.hostPlaceholder" })}
                  suggestions={sshHistorySuggestions.hosts}
                  emptyText={intl.formatMessage({ id: "remote.history.empty" })}
                  suggestionWidth="min(30ch, calc(100vw - 2rem))"
                  autoCapitalize="none"
                  spellCheck={false}
                  data-testid={TID_SSH_HOST_INPUT}
                />
              </div>
              <RemoteConnectionHistoryInput
                className="h-9 font-mono placeholder:font-sans text-ui-base"
                label={intl.formatMessage({ id: "ssh.port" })}
                value={port}
                onChange={setPort}
                // 端口占位值是字面量 22 而不是本地化文案：
                // 端口号没有语言差异，且必须让用户看到「留空就是 22」这个事实。
                placeholder="22"
                suggestions={sshHistorySuggestions.ports}
                emptyText={intl.formatMessage({ id: "remote.history.empty" })}
                suggestionWidth="min(8ch, calc(100vw - 2rem))"
                inputMode="numeric"
                {...invalidProps("port")}
                data-testid={TID_SSH_PORT_INPUT}
              />
            </div>
            <FieldError id={errorId("host")} message={errorOf("host")} />
            {/* 端口错误文案较长，放在整行下方，避免挤进 6rem 列。 */}
            <FieldError id={errorId("port")} message={errorOf("port")} />
            {pasteRecognized && !errorOf("host") ? (
              <FieldHint tone="success">
                {intl.formatMessage({ id: "ssh.pasteRecognized" }, { target: pasteRecognized })}
              </FieldHint>
            ) : null}
          </div>

          <div>
            <RemoteConnectionHistoryInput
              className="h-9 font-mono placeholder:font-sans text-ui-base"
              label={intl.formatMessage({ id: "ssh.username" })}
              value={username}
              onChange={setUsername}
              onBlur={() => setUsername(username.trim())}
              placeholder={intl.formatMessage({
                id: "ssh.usernamePlaceholder",
              })}
              suggestions={sshHistorySuggestions.usernames}
              emptyText={intl.formatMessage({ id: "remote.history.empty" })}
              suggestionWidth="min(30ch, calc(100vw - 2rem))"
              autoCapitalize="none"
              spellCheck={false}
              {...invalidProps("username")}
              data-testid={TID_SSH_USERNAME_INPUT}
            />
            <FieldError id={errorId("username")} message={errorOf("username")} />
          </div>

          <div className="space-y-2">
            {/* 认证方式标签与分段同行，分段已说明凭据类型，凭据输入不再重复可见标签。 */}
            <div className="flex flex-wrap items-center gap-3">
              <span
                id={`${fieldId}-ssh.authMethod`}
                className="text-ui-sm text-remote-foreground-muted"
              >
                {intl.formatMessage({ id: "ssh.authMethod" })}
              </span>
              <RemoteSegmentedControl
                labelledBy={`${fieldId}-ssh.authMethod`}
                value={sshAuthMethod}
                onChange={setSshAuthMethod}
                options={[
                  {
                    value: "password",
                    label: intl.formatMessage({ id: "ssh.auth.password" }),
                    testId: TID_SSH_AUTH_PASSWORD,
                  },
                  {
                    value: "privateKey",
                    label: intl.formatMessage({ id: "ssh.auth.privateKey" }),
                    testId: TID_SSH_AUTH_PRIVATE_KEY,
                  },
                ]}
              />
            </div>
            {sshAuthMethod === "password" ? (
              <div>
                <RemotePasswordInput
                  size="lg"
                  className="h-9 pr-10 text-ui-base"
                  autoFocus={focusCredentials || focusField === "auth"}
                  {...invalidProps("password", focusField === "auth")}
                  aria-label={intl.formatMessage({ id: "ssh.password" })}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={
                    passwordPlaceholder ?? intl.formatMessage({ id: "ssh.passwordPlaceholder" })
                  }
                  id={`${fieldId}-ssh.password`}
                  name="remote-ssh-password"
                  // SSH 密码不参与浏览器自动填充：
                  // SSH 密码用于远程主机认证，不是本站在线账号，因此 autoComplete 会关掉自动填充。
                  autoComplete="off"
                  data-testid={TID_SSH_PASSWORD_INPUT}
                />
                <FieldError id={errorId("password")} message={errorOf("password")} />
              </div>
            ) : (
              <div className="space-y-3">
                <div>
                  <div className="relative">
                    <RemoteConnectionHistoryInput
                      className="h-9 pr-10 font-mono placeholder:font-sans text-ui-base"
                      value={privateKeyPath}
                      onChange={setPrivateKeyPath}
                      placeholder={intl.formatMessage({
                        id: "ssh.privateKeyPlaceholder",
                      })}
                      suggestions={sshHistorySuggestions.privateKeyPaths}
                      emptyText={intl.formatMessage({
                        id: "remote.history.empty",
                      })}
                      autoCapitalize="none"
                      spellCheck={false}
                      id={`${fieldId}-ssh.privateKey`}
                      aria-label={intl.formatMessage({ id: "ssh.privateKey" })}
                      autoFocus={focusField === "auth"}
                      {...invalidProps("privateKey", focusField === "auth")}
                      data-testid={TID_SSH_PRIVATE_KEY_INPUT}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-lg"
                      className="absolute top-1/2 right-0.5 -translate-y-1/2"
                      aria-label={intl.formatMessage({
                        id: "ssh.privateKeySelect",
                      })}
                      title={intl.formatMessage({ id: "ssh.privateKeySelect" })}
                      onClick={() => {
                        void (async () => {
                          // 系统文件选择失败或取消时返回空值，此时保留原路径：
                          // 清空会让用户误以为选择动作把已有配置删了。
                          // void(async) 包装是为了在 onClick 里吞掉 Promise，避免未处理的 rejection。
                          const selectedPath = await platform.selectFile();
                          if (selectedPath) {
                            setPrivateKeyPath(selectedPath);
                          }
                        })();
                      }}
                    >
                      <FileKey className="size-4" />
                    </Button>
                  </div>
                  <FieldError id={errorId("privateKey")} message={errorOf("privateKey")} />
                </div>
                <div>
                  <FieldLabel htmlFor={`${fieldId}-ssh.privateKeyPassphrase`}>
                    {intl.formatMessage({ id: "ssh.privateKeyPassphrase" })}
                  </FieldLabel>
                  <RemotePasswordInput
                    size="lg"
                    className="h-9 text-ui-base"
                    autoFocus={focusCredentials}
                    value={privateKeyPassphrase}
                    onChange={(e) => setPrivateKeyPassphrase(e.target.value)}
                    placeholder={
                      privateKeyPassphrasePlaceholder ??
                      intl.formatMessage({ id: "ssh.privateKeyPassphrasePlaceholder" })
                    }
                    id={`${fieldId}-ssh.privateKeyPassphrase`}
                    name="remote-ssh-private-key-passphrase"
                    autoComplete="off"
                  />
                </div>
              </div>
            )}
          </div>

          {/* 高级选项默认收起，紧凑文字触发，不再加虚线分隔（RDUX-27）。 */}
          <Collapsible open={advancedOptionsOpen} onOpenChange={setAdvancedOptionsOpen}>
            <CollapsibleTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="-ml-1 px-1 text-remote-foreground-muted hover:text-foreground"
              >
                <ChevronRightIcon
                  className={cn(
                    "size-3.5 transition-transform",
                    advancedOptionsOpen && "rotate-90",
                  )}
                />
                {intl.formatMessage({ id: "ssh.advancedOptions" })}
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="space-y-3 pt-2">
              {sshConfigAliasMode === "advanced" ? sshAliasField : null}

              <div>
                <FieldLabel id={`${fieldId}-ssh.assetInstallMode`}>
                  {intl.formatMessage({ id: "ssh.assetInstallMode" })}
                </FieldLabel>
                <RemoteSegmentedControl
                  labelledBy={`${fieldId}-ssh.assetInstallMode`}
                  value={assetInstallMode}
                  onChange={setAssetInstallMode}
                  wrap
                  // 资源安装方式只有两档，且顺序固定：先本地上传、再远端下载。
                  // as const 让 value 保持字面量联合，intl id 才能拼出可被类型检查的键路径。
                  options={(["local-download-upload", "remote-download"] as const).map((value) => ({
                    value,
                    label: intl.formatMessage({ id: `ssh.assetInstallMode.${value}` }),
                  }))}
                />
                <FieldHint>
                  {intl.formatMessage({ id: "ssh.assetInstallModeDescription" })}
                </FieldHint>
              </div>
            </CollapsibleContent>
          </Collapsible>
        </div>
      );
    // Server 分支：URL 独占一行，名称与 token 两列，工作区路径独占一行。
    // 只有 token 用 RemotePasswordInput（可切换明文），
    // URL 与路径用普通 Input —— 它们不是机密，需要可读。
    // 这里刻意用原生 label 而不是 FieldLabel：布局需要的类名与 FieldLabel 不同。
    case "server":
      return (
        <div className="space-y-3">
          <p className="text-pretty text-ui-base text-remote-foreground-muted">
            {intl.formatMessage({ id: "server.description" })}
          </p>
          <div>
            <label
              htmlFor={`${fieldId}-server.url`}
              className="mb-1.5 block text-ui-sm text-remote-foreground-muted"
            >
              {intl.formatMessage({ id: "server.url" })}
            </label>
            <Input
              size="lg"
              className="h-9 text-ui-base"
              value={serverUrl}
              // Server URL 不做实时规范化：用户可能正在输入协议前缀，
              // 边输入边补全会让光标跳到末尾。规范化留给提交前校验。
              onChange={(event) => setServerUrl(event.target.value)}
              placeholder={intl.formatMessage({ id: "server.urlPlaceholder" })}
              autoCapitalize="none"
              spellCheck={false}
              id={`${fieldId}-server.url`}
              {...invalidProps("serverUrl")}
              data-testid={TID_SERVER_URL_INPUT}
            />
            <FieldError id={errorId("serverUrl")} message={errorOf("serverUrl")} />
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <div>
              <label
                htmlFor={`${fieldId}-server.name`}
                className="mb-1.5 block text-ui-sm text-remote-foreground-muted"
              >
                {intl.formatMessage({ id: "server.name" })}
              </label>
              <Input
                size="lg"
                className="h-9 text-ui-base"
                value={serverName}
                onChange={(event) => setServerName(event.target.value)}
                placeholder={intl.formatMessage({
                  id: "server.namePlaceholder",
                })}
                id={`${fieldId}-server.name`}
                data-testid={TID_SERVER_NAME_INPUT}
              />
            </div>
            <div>
              <label
                htmlFor={`${fieldId}-server.token`}
                className="mb-1.5 block text-ui-sm text-remote-foreground-muted"
              >
                {intl.formatMessage({ id: "server.token" })}
              </label>
              <RemotePasswordInput
                size="lg"
                className="h-9 text-ui-base"
                autoFocus={focusCredentials}
                value={serverToken}
                // Server token 使用密码输入组件，但 autoComplete 仍必须是 off：
                // 浏览器自动填充会把账号密码塞进这个字段，提交后被当成服务端 token。
                onChange={(event) => setServerToken(event.target.value)}
                placeholder={intl.formatMessage({
                  id: "server.tokenPlaceholder",
                })}
                autoComplete="off"
                id={`${fieldId}-server.token`}
                data-testid={TID_SERVER_TOKEN_INPUT}
              />
            </div>
          </div>
          <div>
            <label
              htmlFor={`${fieldId}-server.workspacePath`}
              className="mb-1.5 block text-ui-sm text-remote-foreground-muted"
            >
              {intl.formatMessage({ id: "server.workspacePath" })}
            </label>
            <Input
              size="lg"
              className="h-9 text-ui-base"
              // 工作区路径留空表示使用服务端默认目录，
              // 因此这里不设必填提示，只在下方给出用途说明。
              value={serverWorkspacePath}
              onChange={(event) => setServerWorkspacePath(event.target.value)}
              placeholder={intl.formatMessage({
                id: "server.workspacePathPlaceholder",
              })}
              autoCapitalize="none"
              spellCheck={false}
              id={`${fieldId}-server.workspacePath`}
              data-testid={TID_SERVER_WORKSPACE_PATH_INPUT}
            />
            <p className="mt-1 text-pretty text-ui-base text-remote-foreground-muted">
              {intl.formatMessage({ id: "server.workspacePathDescription" })}
            </p>
          </div>
        </div>
      );
    // WSL 分支用 datalist 而不是下拉组件：
    // 发行版名允许用户手填（尚未安装的发行版也能先配置）。
    // 提示区是四级回退：加载中 > 加载失败 > 已检测到 N 个 > 未检测到。
    // root 警告与用户校验错误可以同时出现（前者是建议，后者是格式错误）。
    case "wsl":
      return (
        <div className="space-y-4">
          <div>
            <FieldLabel htmlFor={`${fieldId}-wsl-distro`}>
              {intl.formatMessage({ id: "wsl.distro" })}
            </FieldLabel>
            <Input
              id={`${fieldId}-wsl-distro`}
              size="lg"
              className="h-9 text-ui-base"
              // 发行版用自由文本 + datalist，而不是受控下拉：
              // 已安装列表只作为候选，用户仍需能为未安装的发行版预填名称。
              value={wslDistro}
              onChange={(event) => setWslDistro(event.target.value)}
              placeholder={intl.formatMessage({ id: "wsl.defaultDistro" })}
              data-testid={TID_WSL_DISTRO_SELECT}
              list={`${fieldId}-wsl-options`}
            />
            <datalist id={`${fieldId}-wsl-options`}>
              {wslDistros.map((distro) => (
                <option key={distro.name} value={distro.name} />
              ))}
            </datalist>
            <FieldHint>
              {runtimeOptionsLoading
                ? intl.formatMessage({ id: "wsl.loading" })
                : runtimeOptionsError
                  ? intl.formatMessage({ id: "remote.optionsLoadFailed" })
                  : wslDistros.length > 0
                    ? intl.formatMessage(
                        { id: "wsl.detectedCount" },
                        {
                          count: String(wslDistros.length),
                        },
                      )
                    : intl.formatMessage({ id: "wsl.noDistros" })}
            </FieldHint>
          </div>
          <div>
            <FieldLabel htmlFor={`${fieldId}-wsl.user`}>
              {intl.formatMessage({ id: "wsl.user" })}
            </FieldLabel>
            <Input
              size="lg"
              className="h-9 text-ui-base"
              value={wslUser}
              onChange={(event) => setWslUser?.(event.target.value)}
              placeholder={intl.formatMessage({ id: "wsl.defaultUser" })}
              autoCapitalize="none"
              spellCheck={false}
              {...invalidProps("wslUser", wslUserIsInvalid)}
              id={`${fieldId}-wsl.user`}
              data-testid={TID_WSL_USER_INPUT}
            />
            {wslUserIsInvalid ? (
              <FieldError
                id={errorId("wslUser")}
                message={intl.formatMessage({ id: "wsl.validation.invalidUser" })}
              />
            ) : (
              <FieldHint>{intl.formatMessage({ id: "wsl.userDescription" })}</FieldHint>
            )}
            {wslUserIsRoot ? (
              <FieldHint tone="warning">{intl.formatMessage({ id: "wsl.rootWarning" })}</FieldHint>
            ) : null}
          </div>
        </div>
      );
    // Docker 分支按输入模式二选一，两种模式共享同一个 field 名 "docker"，
    // 因此切换模式不会让已填的错误消失（校验结果仍挂在同一字段上）。
    // 切换模式时同时清空两侧的值：保留旧值会让用户提交一个界面上看不见的容器名。
    case "docker":
      return (
        <div className="space-y-4">
          <RemoteSegmentedControl
            label="Docker"
            value={dockerInputMode}
            onChange={(mode) => {
              // 先切模式再清值，顺序不可颠倒：
              // 反过来的话，清空 manual 会触发一次「manual 为空」的渲染，
              // 此时模式仍是旧值，会短暂显示手工输入的空白提示。
              setDockerInputMode(mode);
              setDockerContainer("");
              setManualDockerContainer("");
            }}
            options={(["select", "manual"] as const).map((mode) => ({
              value: mode,
              label: intl.formatMessage({ id: `docker.inputMode.${mode}` }),
            }))}
          />
          {dockerInputMode === "select" ? (
            <div>
              <FieldLabel htmlFor={`${fieldId}-docker-select`}>
                {intl.formatMessage({ id: "docker.container" })}
              </FieldLabel>
              <Popover
                open={dockerContainerPopoverOpen}
                onOpenChange={handleDockerContainerPopoverOpenChange}
              >
                <PopoverTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    size="lg"
                    id={`${fieldId}-docker-select`}
                    data-testid={TID_DOCKER_CONTAINER_SELECT}
                    {...invalidProps("docker")}
                    className="h-9 w-full justify-between rounded-lg border-input-border bg-input px-3 text-ui-base font-normal hover:border-input-border-hover hover:bg-input aria-expanded:border-input-border-focused aria-expanded:bg-input-focused aria-invalid:border-destructive"
                  >
                    <span
                      className={cn(
                        "min-w-0 truncate text-left",
                        dockerContainerTriggerIsPlaceholder
                          ? "text-remote-foreground-muted"
                          : "text-foreground",
                      )}
                    >
                      {dockerContainerTriggerLabel}
                    </span>
                    {runtimeOptionsLoading ? (
                      <LoaderIcon className="size-3.5 shrink-0 animate-spin text-remote-foreground-muted" />
                    ) : (
                      <ChevronDownIcon className="size-3.5 shrink-0 text-remote-foreground-muted" />
                    )}
                  </Button>
                </PopoverTrigger>
                <PopoverContent
                  align="start"
                  sideOffset={6}
                  className="max-w-[calc(100vw-2rem)] rounded-xl border border-border bg-menu p-1 shadow-lg"
                  style={{ width: "var(--radix-popover-trigger-width)" }}
                >
                  <Command className="rounded-lg bg-transparent p-0 text-foreground">
                    <CommandInput
                      aria-label={intl.formatMessage({ id: "docker.selectContainer" })}
                      placeholder={intl.formatMessage({ id: "docker.selectContainer" })}
                    />
                    <CommandList className="max-h-56 scroll-py-1">
                      {runtimeOptionsLoading ? (
                        <div className="flex min-h-8 items-center gap-2 rounded-lg px-3 py-1.5 text-ui-base text-remote-foreground-muted">
                          <LoaderIcon className="size-3.5 shrink-0 animate-spin" />
                          <span className="truncate">
                            {intl.formatMessage({ id: "docker.loading" })}
                          </span>
                        </div>
                      ) : null}
                      {dockerContainers.length === 0 && !runtimeOptionsLoading ? (
                        <CommandEmpty className="px-3 py-5 text-ui-base text-remote-foreground-muted">
                          {dockerContainerEmptyText}
                        </CommandEmpty>
                      ) : (
                        dockerContainers.map((container) => {
                          // 容器选中用 name 比较：dockerContainer 存的是名字而不是 id，
                          // 用 id 比较会让「手工输入同名容器」永远显示未选中。
                          const selected = container.name === dockerContainer;

                          return (
                            <CommandItem
                              key={container.id}
                              // 容器用 name 作为 Command 的搜索值而不是 id：
                              // 用户输入的是名字片段；id 只在 key 上使用，保证列表重排不丢焦点。
                              value={container.name}
                              className="min-h-8 cursor-pointer gap-2 rounded-lg px-2 py-1.5 text-ui-base text-foreground data-selected:bg-menu-hover data-selected:text-foreground"
                              onSelect={() => {
                                setManualDockerContainer("");
                                setDockerContainer(container.name);
                                setDockerContainerPopoverOpen(false);
                              }}
                            >
                              <RemoteConnectionKindTile kind="docker" />
                              <span className="min-w-0 flex-1 truncate">{container.name}</span>
                              <CheckIcon
                                className={cn(
                                  "size-4 shrink-0 text-remote-foreground-muted",
                                  selected ? "opacity-100" : "opacity-0",
                                )}
                              />
                            </CommandItem>
                          );
                        })
                      )}
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
              <FieldError id={errorId("docker")} message={errorOf("docker")} />
              {/* 限制信息放到选择器下方：区分 Docker 不可用、发现失败与没有运行中的容器（RDUX-27）。 */}
              {runtimeOptionsLoading ? null : runtimeOptionsError || dockerAvailable === false ? (
                <FieldHint tone="warning">{dockerContainerEmptyText}</FieldHint>
              ) : dockerContainers.length === 0 ? (
                <FieldHint>{dockerContainerEmptyText}</FieldHint>
              ) : null}
            </div>
          ) : (
            <div>
              <FieldLabel htmlFor={`${fieldId}-docker.container`}>
                {intl.formatMessage({ id: "docker.container" })}
              </FieldLabel>
              <Input
                size="lg"
                className="h-9 text-ui-base"
                value={manualDockerContainer}
                onChange={(event) => {
                  setDockerContainer("");
                  // 手工输入每次变更都清空已选容器：
                  // 两侧共用同一字段，若不清空，用户会以为最终提交的是刚输入的名字，
                  // 实际却仍是之前从下拉里选中的那个。
                  setManualDockerContainer(event.target.value);
                }}
                placeholder={intl.formatMessage({
                  id: "docker.containerPlaceholder",
                })}
                {...invalidProps("docker")}
                id={`${fieldId}-docker.container`}
                data-testid={TID_DOCKER_CONTAINER_INPUT}
              />
              <FieldError id={errorId("docker")} message={errorOf("docker")} />
              {manualDockerContainerIsEmpty && !errorOf("docker") ? (
                <FieldHint>{intl.formatMessage({ id: "docker.manualContainerHint" })}</FieldHint>
              ) : null}
            </div>
          )}
        </div>
      );
  }
}
