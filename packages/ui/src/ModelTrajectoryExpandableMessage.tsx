// 文件职责：模型轨迹单条消息的可展开行，负责展开态合并、预览摘要、元数据角标与复制等展示逻辑。
// 边界：本文件不发请求、不读持久化、不解析轨迹记录；展开命令与覆盖表由 ModelTrajectoryExpansion 提供，
// 搜索定位由 ModelTrajectorySearch 提供，正文渲染交给 TrajectoryExpandedContent，本文件只做行的投影。
//
// INV-01 断言：本组件只做单行投影，不取数、不持久化、不改写消息 —— 守住它的位置：函数体与所有渲染分支 —— 改错故障：同一轨迹出现第二份展开真相，刷新或滚动后状态错乱
// INV-02 断言：默认展开状态为真 —— 守住它的位置：localExpansion 的 useState 初值 —— 改错故障：新会话轨迹默认全部折叠，用户误判为没有内容
// INV-03 断言：本地 commandVersion 初值必须为 0，与命令工厂初值对齐 —— 守住它的位置：localExpansion 初值与 userOpen 比较 —— 改错故障：首次批量展开对该行无效或反向生效
// INV-04 断言：最终展开态是用户选择与搜索命中的并集 —— 守住它的位置：open 的或运算 —— 改错故障：搜索跳转后命中行仍折叠，用户看不到上下文
// INV-05 断言：只有命令版本严格大于覆盖版本，批量命令才生效 —— 守住它的位置：userOpen 的三元比较 —— 改错故障：手动逐条调整被旧命令反复覆盖
// INV-06 断言：写覆盖时必须记录当前命令版本 —— 守住它的位置：handleOpenChange 的 override 对象 —— 改错故障：批量展开对点过的行失效，点击表现为无反应
// INV-07 断言：只有同时具备 expansionKey 与注册表才写全局覆盖，否则写本地 —— 守住它的位置：handleOpenChange 的分支 —— 改错故障：无键行共用同一条目并互相牵连
// INV-08 断言：显式 visualRole 优先于任何推断 —— 守住它的位置：resolvedVisualRole 的空值合并 —— 改错故障：角色配色、命令分组与数据属性三者错位
// INV-09 断言：工具方向按 tool-result 优先于 tool-call 判定 —— 守住它的位置：payloadDirection 的两级三元 —— 改错故障：输入输出混合消息显示错误方向与错误图标
// INV-10 断言：复制文本与预览文本必须是两套序列化 —— 守住它的位置：messageClipboardText 与 messagePreview —— 改错故障：复制到被截断的预览内容或丢失换行
// INV-11 断言：复制失败只记录告警，不抛出也不打断渲染 —— 守住它的位置：handleCopy 的 catch —— 改错故障：剪贴板权限异常冒泡导致整块轨迹白屏
// INV-12 断言：所有可见文案与无障碍标签都经 intl 注入 —— 守住它的位置：复制标签与折叠提示的 formatMessage —— 改错故障：切换语言后按钮仍是旧语言
// INV-13 断言：data-trajectory 开头的属性是搜索、样式与端到端测试的公共契约 —— 守住它的位置：折叠容器与各触发器属性 —— 改错故障：搜索定位与自动化选择器静默失效
// INV-14 断言：展开内容始终挂载，可见性交给折叠状态控制 —— 守住它的位置：CollapsibleContent 内的展开内容 —— 改错故障：搜索高亮与滚动定位拿不到 DOM 节点
// INV-15 断言：预览对空内容必须返回破折号哨兵 —— 守住它的位置：messagePreview 及三个辅助函数 —— 改错故障：行渲染出现空白或 undefined 文本
// INV-16 断言：预览序列化不得抛异常，循环引用必须有兜底 —— 守住它的位置：compactPreviewValue 的 try 与 catch —— 改错故障：一条坏部件数据让整段轨迹崩溃
import type { ZCodeModelTrajectoryMessage } from "@zcode/services";
import { ArrowRightIcon, ChevronRightIcon, CircleAlertIcon, CopyIcon } from "lucide-react";
import { useContext, useState } from "react";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible.js";
import type { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import {
  TrajectoryExpansionCommandContext,
  TrajectoryExpansionRegistryContext,
} from "@/ModelTrajectoryExpansion.js";
import { TrajectoryExpandedContent } from "@/ModelTrajectoryExpandedContent.js";
import { TrajectorySearchRevealContext } from "@/ModelTrajectorySearch.js";
import { trajectoryRoleTextClass, type TrajectoryVisualRole } from "@/ModelTrajectoryRoleStyles.js";
import {
  trajectoryToolHasError,
  trajectoryToolMetadata,
  trajectoryToolOutputs,
  trajectoryToolPayloadErrorText,
} from "@/ModelTrajectoryToolPayload.js";

type IntlShape = ReturnType<typeof useZCodeIntl>["intl"];

// [契约] 行展示所需文案由父层算好传入，这里不读时钟也不做本地化格式化
// role 是协议角色，visualRole 是视觉与分组角色，二者不能互相替代
// expansionKey 缺省表示该行不参与跨渲染的展开持久化，只保留组件本地状态
// intl 由调用方注入，保证同一棵树内共用同一份国际化实例
// isAlt 只影响斑马纹样式，不参与展开判定与数据属性
export function ExpandableTrajectoryMessage({
  message,
  role,
  visualRole,
  roleLabel,
  callDurationLabel,
  callDatetimeLabel,
  callDatetimeTitle,
  isAlt = false,
  intl,
  expansionKey,
}: {
  message: ZCodeModelTrajectoryMessage;
  role: "system" | "user" | "assistant" | "tool";
  visualRole?: TrajectoryVisualRole;
  roleLabel: string;
  callDurationLabel: string;
  callDatetimeLabel: string;
  callDatetimeTitle: string;
  isAlt?: boolean;
  intl: IntlShape;
  expansionKey?: string;
}) {
  // [契约] 三个 context 都可能为 null：命令表来自工具栏，覆盖表来自时间线，搜索键来自搜索条
  // 缺少命令表时该行只能手动展开，批量切换不会影响它
  // 缺少覆盖表时展开态退回组件本地，滚动卸载后不保留
  // 不要在此补默认空对象，否则会掩盖 Provider 缺失并产生难以复现的交互差异
  // [并发] 三处读取在同一渲染批次完成，保证看到一致的状态快照
  const expansionCommands = useContext(TrajectoryExpansionCommandContext);
  const expansionRegistry = useContext(TrajectoryExpansionRegistryContext);
  const searchRevealKey = useContext(TrajectorySearchRevealContext);
  // [契约] 默认展开为真，与命令工厂的初始展开语义保持一致
  // commandVersion 初值 0，用来判断批量命令是否比当前状态更新
  // [权衡] 本地态只在没有 expansionKey 或注册表时使用，避免给每个节点建全局条目
  // 不要改成受控属性，父层无法为虚拟列表中的每一行维护独立状态
  // 版本号只在写入覆盖时更新，渲染期间不修改
  const [localExpansion, setLocalExpansion] = useState({ open: true, commandVersion: 0 });
  const copyLabel = intl.formatMessage({ id: "chat.message.copy" });
  // [权衡] 每次渲染都会序列化整条消息，复制是低频操作但文本可能很大，暂不做懒加载
  // 不要推迟到 handleCopy 里再取，按钮禁用状态依赖首帧就有值
  // [契约] 序列化规则集中在 messageClipboardText，预览函数不得复用它
  // 若后续加缓存，键必须包含 message 引用，不能用 expansionKey 代替
  const copyText = messageClipboardText(message);
  const toolResultMeta = trajectoryToolMetadata(message);
  const toolPayloadHasError = trajectoryToolHasError(message);
  // [契约] 方向文案按 tool-result 优先于 tool-call 判定，混合消息展示输出方向
  // 两个分支各扫一遍部件，次数固定为二，接受这点开销，不要在渲染期预建索引
  // 无工具部件时为 null，界面据此整体隐藏方向、箭头与错误图标
  // 文案 id 固定为 toolOutput 与 toolInput，不能复用预览文案
  // [失败路径] 判定依据是部件种类而非角色，role 为 tool 却没有结果时仍显示输入方向
  const payloadDirection = message.parts.some((part) => part.kind === "tool-result")
    ? intl.formatMessage({ id: "modelTrajectory.toolOutput" })
    : message.parts.some((part) => part.kind === "tool-call")
      ? intl.formatMessage({ id: "modelTrajectory.toolInput" })
      : null;
  // [契约] 显式传入的 visualRole 永远优先，其次才按部件种类推断
  // 推断顺序是工具结果、工具调用、tool 角色回退为工具结果，最后才用协议角色
  // 该结果同时决定角色配色、展开命令的键与数据属性，不能出现第二套推断
  // 不要把它与 role 合并：协议角色只有四种，视觉角色多了推理与工具两类
  // 改变推断顺序会让按类别展开的工具按钮命中错误的行
  const resolvedVisualRole =
    visualRole ??
    (message.parts.some((part) => part.kind === "tool-result")
      ? "tool-result"
      : message.parts.some((part) => part.kind === "tool-call")
        ? "tool-call"
        : role === "tool"
          ? "tool-result"
          : role);
  // [契约] 命令按视觉角色分组，同角色的所有行共享一个命令，不是行级开关
  // 命令表缺失时为 undefined，后续版本比较与写入路径都要容忍
  // 不要把键换成 expansionKey，批量切换是按类别广播而非按行
  // 读取后不得在渲染期间修改该对象，它是工具栏持有的真源
  const expansionCommand = expansionCommands?.[resolvedVisualRole];
  // [契约] 覆盖表优先于本地状态，用户逐条点击的结果跨滚动与重渲染保留
  // 没有 expansionKey 时直接跳过覆盖表，避免用空串在全时间线共享同一条目
  // 注册表存在但该键无条目时返回 undefined，交给本地状态兜底
  // [权衡] overrides 是只读映射，读取无需拷贝，写入统一走 handleOpenChange
  // 不要在此清理过期条目，注册表的生命周期由外层 Provider 管理
  const persistedExpansion = expansionKey
    ? expansionRegistry?.overrides.get(expansionKey)
    : undefined;
  const rowExpansion = persistedExpansion ?? localExpansion;
  // [契约] 只有命令版本严格大于覆盖版本时才采用命令，否则保留用户的逐条选择
  // 版本相等表示两者同源，用户最近一次点击直接生效
  // 使用严格大于而不是不等号，防止版本回退时把旧命令重新应用
  // [并发] 批量切换自增版本后，所有行的比较同时失败，展开态整体翻转
  // 不要把比较搬进副作用回写状态，那会多出一轮延迟与重复渲染
  const userOpen =
    expansionCommand && expansionCommand.version > rowExpansion.commandVersion
      ? expansionCommand.expanded
      : rowExpansion.open;
  const searchRevealed = Boolean(expansionKey && expansionKey === searchRevealKey);
  // [契约] 最终展开态是用户结果与搜索命中的并集，搜索展开不写回用户状态
  // 搜索键变化只会让命中的那一行临时展开，关闭搜索后立即回落
  // 不要把搜索命中合进 localExpansion，否则搜索结束行仍保持展开
  // [失败路径] expansionKey 缺省的行永不参与搜索定位，这是有意为之
  // open 同时传给折叠容器与展开内容，两处必须同源
  const open = userOpen || searchRevealed;

  // [失败路径] 文本为空、无 navigator 或无剪贴板能力时静默返回，按钮本身已禁用
  // 写剪贴板返回 Promise，失败只记警告，不弹错也不向上冒泡
  // 日志前缀固定为 ModelTrajectory，便于按模块过滤告警
  // 不要在成功时改状态做已复制提示，本组件没有该界面契约
  // [资源] 不缓存 navigator 引用，避免服务端渲染或测试环境在模块层访问
  const handleCopy = () => {
    if (!copyText || typeof navigator === "undefined" || !navigator.clipboard?.writeText) return;
    void navigator.clipboard.writeText(copyText).catch((error: unknown) => {
      logger.warn("[ModelTrajectory] copy expanded content failed", error);
    });
  };

  // [事务] 一次切换把目标态与当前命令版本一起写入，形成不可分割的覆盖记录
  // 版本取当前命令版本，表示用户已看到该命令的结果并做出选择
  // 有键且有注册表时写全局，否则退回本地状态，两条路径不可同时走
  // [失败路径] 若版本写成 0 或省略，批量切换会把用户选择再次覆盖
  // nextOpen 来自折叠容器，不要在这里再做取反或二次判断
  const handleOpenChange = (nextOpen: boolean) => {
    const override = {
      open: nextOpen,
      commandVersion: expansionCommand?.version ?? rowExpansion.commandVersion,
    };
    if (expansionKey && expansionRegistry) {
      expansionRegistry.setOverride(expansionKey, override);
    } else {
      setLocalExpansion(override);
    }
  };

  // [契约] data-trajectory 开头的属性是搜索、样式与端到端测试的公共契约，重命名要同步调用方
  // 折叠时预览与角标可见，展开时由 group-data 状态切换为耗时与日期
  // [契约] 展开内容始终挂载在折叠容器内，可见性交给状态与样式控制
  // 不要改成条件渲染，搜索高亮与滚动定位依赖已经存在的 DOM 节点
  // 复制按钮与箭头触发器共用同一操作区，键盘可达性依赖按钮语义
  return (
    <Collapsible
      open={open}
      onOpenChange={handleOpenChange}
      data-trajectory-message-role={role}
      data-trajectory-message-collapsible=""
      data-trajectory-expandable-role={resolvedVisualRole}
      data-trajectory-search-target-key={expansionKey}
      data-trajectory-row-alt={isAlt || undefined}
      data-trajectory-user-container={role === "user" ? "" : undefined}
      className={cn(
        "group relative col-span-full grid w-full min-w-0 grid-cols-subgrid",
        isAlt && "bg-surface/30",
      )}
    >
      <div
        data-trajectory-user-summary-card=""
        className="col-span-full grid min-h-8 w-full min-w-0 grid-cols-subgrid items-center"
      >
        <CollapsibleTrigger
          data-trajectory-message-trigger=""
          className="col-span-2 grid min-h-8 min-w-0 grid-cols-subgrid items-center py-0 pl-3 text-left text-ui-sm text-foreground-subtle"
        >
          <span
            data-trajectory-role-label={resolvedVisualRole}
            className={cn(
              "pr-1 font-mono text-ui-sm uppercase",
              trajectoryRoleTextClass(resolvedVisualRole),
            )}
          >
            {roleLabel}
          </span>
          <span className="flex min-w-0 items-center">
            {payloadDirection ? (
              toolPayloadHasError ? (
                <CircleAlertIcon
                  data-trajectory-payload-error-icon=""
                  aria-hidden="true"
                  className="mr-1 size-3.5 shrink-0 text-destructive"
                />
              ) : null
            ) : null}
            {payloadDirection ? (
              <span
                data-trajectory-payload-direction=""
                className={cn(
                  "mr-2 shrink-0 font-mono text-ui-sm uppercase",
                  toolPayloadHasError ? "text-destructive" : "text-foreground",
                )}
              >
                {payloadDirection}
              </span>
            ) : null}
            {payloadDirection ? (
              <ArrowRightIcon
                data-trajectory-payload-arrow=""
                className="mr-2 size-3 shrink-0 text-foreground-subtlest group-data-[state=open]:hidden"
              />
            ) : null}
            <span
              data-trajectory-message-preview=""
              data-trajectory-search-field="content"
              className="min-w-0 flex-1 truncate font-mono group-data-[state=open]:hidden"
            >
              {messagePreview(message, role)}
            </span>
            {toolResultMeta.names ? (
              <Badge
                data-trajectory-tool-result-name=""
                data-trajectory-search-field="tool-name"
                variant="outline"
                className="ml-1.5 h-5 rounded-full border-border bg-tag px-2 font-mono text-ui-xs text-foreground-subtle group-data-[state=open]:hidden"
                title={toolResultMeta.names}
              >
                {toolResultMeta.names}
              </Badge>
            ) : null}
            {toolResultMeta.ids ? (
              <Badge
                data-trajectory-tool-result-id=""
                data-trajectory-search-field="tool-id"
                variant="outline"
                className="ml-1 h-5 max-w-[40%] truncate rounded-full border-border bg-tag px-2 font-mono text-ui-xs text-foreground-subtle group-data-[state=open]:hidden"
                title={toolResultMeta.ids}
              >
                {toolResultMeta.ids}
              </Badge>
            ) : null}
            <span
              data-trajectory-call-metadata=""
              data-trajectory-user-call-metadata={role === "user" ? "" : undefined}
              className="ml-auto mr-7 hidden min-w-0 items-center gap-1 font-mono text-ui-xs text-foreground-subtlest group-data-[state=open]:flex"
            >
              <span>{callDurationLabel}</span>
              <span aria-hidden="true">·</span>
              <span
                data-trajectory-call-datetime=""
                data-trajectory-user-call-datetime={role === "user" ? "" : undefined}
                className="truncate"
                title={callDatetimeTitle}
              >
                {callDatetimeLabel}
              </span>
            </span>
          </span>
          <span className="sr-only group-data-[state=open]:hidden">
            {intl.formatMessage({ id: "modelTrajectory.expand" })}
          </span>
          <span className="sr-only hidden group-data-[state=open]:inline">
            {intl.formatMessage({ id: "modelTrajectory.collapse" })}
          </span>
        </CollapsibleTrigger>
        <span
          data-trajectory-message-actions=""
          className="relative -ml-1 mr-1 flex items-center justify-end"
        >
          <Button
            data-trajectory-message-copy=""
            data-trajectory-user-copy={role === "user" ? "" : undefined}
            type="button"
            variant="ghost"
            size="icon-sm"
            className="absolute right-full mr-1 hidden text-foreground-subtlest group-data-[state=open]:inline-flex"
            aria-label={copyLabel}
            title={copyLabel}
            disabled={!copyText}
            onClick={handleCopy}
          >
            <CopyIcon className="size-3" />
          </Button>
          <CollapsibleTrigger asChild>
            <Button
              data-trajectory-message-chevron-trigger=""
              data-trajectory-user-chevron-trigger={role === "user" ? "" : undefined}
              type="button"
              variant="ghost"
              size="icon-sm"
              className="size-5 rounded-sm text-foreground-subtlest"
            >
              <ChevronRightIcon
                data-trajectory-message-chevron=""
                data-trajectory-user-chevron={role === "user" ? "" : undefined}
                className="size-3 transition-transform group-data-[state=open]:rotate-90"
              />
              <span className="sr-only group-data-[state=open]:hidden">
                {intl.formatMessage({ id: "modelTrajectory.expand" })}
              </span>
              <span className="sr-only hidden group-data-[state=open]:inline">
                {intl.formatMessage({ id: "modelTrajectory.collapse" })}
              </span>
            </Button>
          </CollapsibleTrigger>
        </span>
      </div>
      <CollapsibleContent data-trajectory-message-expanded="" className="col-span-full">
        <TrajectoryExpandedContent
          message={message}
          role={role}
          open={open}
          searchRevealed={searchRevealed}
          intl={intl}
        />
      </CollapsibleContent>
    </Collapsible>
  );
}

// [契约] 预览优先级固定为：工具输出、工具调用参数、用户与助手正文、首行兜底
// tool 角色但没有结果时不会走输出分支，会落到工具调用参数或首行
// 工具调用参数逐个压缩后用逗号拼接，顺序即部件顺序
// 不要在此截断长度，截断交给样式层，避免搜索文本与展示不一致
// [失败路径] 每个分支都必须返回字符串，空值用破折号哨兵而不是空串
function messagePreview(
  message: ZCodeModelTrajectoryMessage,
  role: "system" | "user" | "assistant" | "tool",
): string {
  if (role === "tool" && message.parts.some((part) => part.kind === "tool-result")) {
    return trajectoryToolOutputs(message).join(" ").replaceAll(/\s+/g, " ").trim() || "—";
  }
  const toolCallNames = message.parts.flatMap((part) =>
    part.kind === "tool-call" ? [part.toolName] : [],
  );
  if (toolCallNames.length > 0) {
    return message.parts
      .flatMap((part) => (part.kind === "tool-call" ? [compactPreviewValue(part.input)] : []))
      .join(", ");
  }
  if (role === "user" || role === "assistant") return compactTextPreview(message);
  return firstLinePreview(message);
}

function compactTextPreview(message: ZCodeModelTrajectoryMessage): string {
  const text = message.parts
    .flatMap((part) => ("text" in part && typeof part.text === "string" ? [part.text] : []))
    .join(" ")
    .replaceAll(/\s+/g, " ")
    .trim();
  return text || "—";
}

// [契约] 字符串先压缩空白，错误包装优先展开为真实错误文本，避免展示传输层 JSON
// undefined 与空串统一给破折号，保证行高稳定
// [失败路径] 序列化可能因循环引用抛错，捕获后回退到字符串转换，不要删这个兜底
// 序列化对函数与 symbol 返回 undefined，因此还需要字符串转换兜底
// 不要把捕获范围收窄到对象分支，任何值都可能触发序列化异常
function compactPreviewValue(value: unknown): string {
  if (typeof value === "string") return value.replaceAll(/\s+/g, " ").trim() || "—";
  const errorText = trajectoryToolPayloadErrorText(value);
  if (errorText !== undefined) return errorText.replaceAll(/\s+/g, " ").trim() || "—";
  if (value === undefined) return "—";
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

// [契约] 只取第一个文本部件中第一行非空内容，供系统等没有专用分支的角色使用
// 拆分兼容回车换行两种行尾，先裁剪再判空，避免纯空白行被当成内容
// [失败路径] 全部为空时返回破折号，不要返回空串导致高度抖动
// 遍历顺序即部件顺序，不做全文扫描，避免拉长首屏时间
function firstLinePreview(message: ZCodeModelTrajectoryMessage): string {
  for (const part of message.parts) {
    if ("text" in part && typeof part.text === "string") {
      const firstLine = part.text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean);
      if (firstLine) return firstLine;
    }
  }
  return "—";
}

// [契约] tool 角色只复制工具输出，不包含输入参数，与预览文本不同
// 其他角色保留原始文本与部件 JSON，用双空行分隔，便于粘贴后阅读
// [权衡] 这里使用缩进 JSON 而非压缩值，复制场景优先可读性
// 部件可能无法序列化，调用方在渲染期使用需自行承担异常风险
// 过滤空串必须在拼接之前，否则会留下多余分隔符
function messageClipboardText(message: ZCodeModelTrajectoryMessage): string {
  if (message.role === "tool") return trajectoryToolOutputs(message).join("\n\n");
  return message.parts
    .map((part) => {
      if ("text" in part && typeof part.text === "string") return part.text;
      return JSON.stringify(part, null, 2);
    })
    .filter(Boolean)
    .join("\n\n");
}
