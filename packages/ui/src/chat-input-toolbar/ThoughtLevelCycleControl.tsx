// ThoughtLevelCycleControl —— 聊天输入工具栏的「思考强度」档位控件。
// 负责：把 option（select 类型配置）投影成「图标 + 竖向进度条 + 滚动标签」触发器，
// 并承载 select（Radix 下拉）与 cycle（点击轮转）两种交互模式，
// 同时处理 tooltip 标题、单档固定态与下拉关闭后的焦点恢复。
// 不负责：档位文案与「关闭」语义判定（见 thoughtLevelOptions）、配置读写与持久化、
// 快捷键的全局注册与 i18n 键值定义；本组件不持有任何档位状态。
//
// INV-01 断言：option 非 select、选项为空或当前项缺失时渲染空 —— 守住它的位置：entries 计算之后的早退分支 —— 改错故障：工具栏出现空白却可点击的幽灵按钮，且 tooltip 锚在无用节点上。
// INV-02 断言：hooks 调用次数不因早退改变 —— 守住它的位置：早退语句位于所有 useCallback/useEffect 之后 —— 改错故障：运行时切换配置类型时抛 hooks 数量不一致，整块输入栏白屏。
// INV-03 断言：档位匹配只按 value 严格相等，不匹配展示文案 —— 守住它的位置：selectedEntryIndex 的 findIndex —— 改错故障：文案本地化后当前值被当成无效，触发器长期停在 placeholder。
// INV-04 断言：进度分母至少为 1 且「关闭」档不计入 —— 守住它的位置：thinkingEntries 与 dotCount —— 改错故障：仅含关闭项时出现 NaN 高度或满格假进度。
// INV-05 断言：未知或空 currentValue 的进度恒为 0，不回落到首档 —— 守住它的位置：activeDotCount 的三元分支 —— 改错故障：配置缺失时被画成一档思考，用户误以为推理已开启。
// INV-06 断言：只有一个档位且当前值有效时不渲染 Select —— 守住它的位置：isFixedThoughtLevel 分支 —— 改错故障：单档模型出现带箭头下拉，点开只有一项，cycle 模式点击还会原地打转。
// INV-07 断言：下拉触发值必须先命中已渲染 entries 才上抛 —— 守住它的位置：Select 的 onValueChange —— 改错故障：Radix 注册竞争发出的空值被当成用户切档，配置被清空。
// INV-08 断言：当前值提交只由关闭事件消费，打开时清空 —— 守住它的位置：handleSelectOpenChange 的两个分支 —— 改错故障：选中当前档位不落配置，或键盘预选被误提交。
// INV-09 断言：待提交标记先落 ref 再进微任务，未关闭即作废 —— 守住它的位置：armCurrentValueCommit —— 改错故障：Space/Enter 预选后取消，仍把当前值写回配置，产生无意义写。
// INV-10 断言：标签可见性变更必须经 requestAnimationFrame 合并 —— 守住它的位置：debouncedUpdateInlineLabelVisible —— 改错故障：拖动窗口时逐帧 setState，输入框明显掉帧。
// INV-11 断言：ResizeObserver 与 resize 监听成对清理，并同时取消待执行帧 —— 守住它的位置：useEffect 的 cleanup —— 改错故障：卸载后仍 setState，或跨会话残留监听导致内存增长。
// INV-12 断言：关闭下拉后只在非粗指针设备抢回聊天输入框焦点 —— 守住它的位置：onCloseAutoFocus —— 改错故障：手机点选后软键盘反复弹起，或桌面焦点掉到 body 无法继续输入。
// INV-13 断言：restoreFocusSelector 为空时保持 Radix 默认焦点行为 —— 守住它的位置：onCloseAutoFocus 的首个 return —— 改错故障：Automations 等无输入框场景 preventDefault 后焦点丢失，键盘用户失去操作锚点。
// INV-14 断言：tooltip 标题以 disabledReason 为最高优先级 —— 守住它的位置：effectiveTooltipTitle —— 改错故障：禁用态仍提示「切换思考强度」，用户找不到不可用原因。
// INV-15 断言：cycle 模式在当前值无效时从第一档起跳 —— 守住它的位置：handleClick 的 nextIndex —— 改错故障：配置值失效后点击无反应，或从错误档位开始轮转。
//
// 渲染顺序固定为：非法配置早退 → 单档固定态 → select 分支 → cycle 分支。
// 新增分支必须排在这四处之后，且不得跳过上文任何 hooks 调用。
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { type ZCodeConfigOption, type ZCodeProvider } from "@zcode/shared";
import {
  TID_CHAT_THOUGHT_LEVEL_SELECT_ITEM,
  TID_CHAT_THOUGHT_LEVEL_SELECT_TRIGGER,
  testId,
} from "@zcode/shared/test-ids";
import { BrainIcon, ChevronDownIcon } from "lucide-react";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select.js";
import type { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  isCoarseTouchDevice,
  shouldRestoreChatInputFocusAfterPickerClose,
} from "@/lib/pickerFocus.js";
import {
  getThoughtLevelLabel,
  isNoThoughtLevel,
} from "@/chat-input-toolbar/thoughtLevelOptions.js";
import { RollingToolbarLabel } from "@/chat-input-toolbar/RollingToolbarLabel.js";

// 交互模式是编译期封闭集合：select 走 Radix 下拉，cycle 走点击轮转。
// 未匹配到 select 的取值都会落到函数末尾的 cycle 分支，而不是报错，
// 因此新增模式必须同时补渲染分支，不能只改类型。
// [契约] 两条路径共用 triggerContent，改触发器结构须同时回归下拉与点击轮转。
type ThoughtLevelInteractionMode = "select" | "cycle";

// 组件是全受控的：档位值只读 option.currentValue，切换意图通过 onValueChange 上抛，
// 本地只保留渲染派生量（索引、文案、进度），不缓存档位副本。
// [契约] 不要在这里用 useState 存档位，否则与配置回写形成双写源。
export function ThoughtLevelCycleControl({
  disabled,
  disabledReason,
  composerCollapsePriority,
  interactionMode = "select",
  indicatorClassName,
  intl,
  labelVisibilityClassName = "hidden @xl/composer:inline-flex",
  option,
  provider,
  showInvalidCurrentValue = false,
  restoreFocusSelector = '[data-testid="chat-input"]',
  shortcutLabel,
  triggerClassName,
  triggerRef,
  open,
  onOpenChange,
  onCurrentValueCommit,
  onValueChange,
}: {
  disabled?: boolean;
  disabledReason?: string;
  /** 聊天输入框由统一布局 owner 收起文字，其他调用方保留原断点规则。 */
  composerCollapsePriority?: number;
  interactionMode?: ThoughtLevelInteractionMode;
  indicatorClassName?: string;
  intl: ReturnType<typeof useZCodeIntl>["intl"];
  labelVisibilityClassName?: string;
  option: ZCodeConfigOption;
  provider?: ZCodeProvider;
  showInvalidCurrentValue?: boolean;
  restoreFocusSelector?: string | null;
  shortcutLabel?: string;
  triggerClassName?: string;
  triggerRef: RefObject<HTMLSpanElement | null>;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onCurrentValueCommit?: (value: string) => void;
  onValueChange: (value: string) => void;
}) {
  // 只有显式传入 composerCollapsePriority 才启用收紧成图标的组样式；
  // undefined 表示「非 chat composer 调用方」，必须保留原断点规则，
  // [权衡] 不能按假值判断，数字优先级 0 也是合法值。
  const composerTriggerClassName =
    composerCollapsePriority !== undefined
      ? "group/thought shrink-0 data-[composer-compact=icon]:size-7 data-[composer-compact=icon]:justify-center data-[composer-compact=icon]:gap-0 data-[composer-compact=icon]:p-0"
      : undefined;
  const labelRef = useRef<HTMLSpanElement | null>(null);
  // [事务] 跨「点击/按键 → 微任务 → 关闭事件」三段的暂存标记，只存待提交的档位值。
  // 用 ref 而不是 state：写入不触发渲染，也不需要进入任何依赖数组。
  // 清空时机错位会把上一轮交互的意图带进下一次开关，产生幽灵提交。
  const pendingCurrentValueCommitRef = useRef<string | null>(null);
  const [inlineLabelVisible, setInlineLabelVisible] = useState(true);

  // [权衡] 可见性用 getComputedStyle 与 getClientRects 判断，而不是 offsetWidth：
  // 断点隐藏时宽度为 0，被 flex 压扁到零宽的可视标签同样为 0，
  // 只有 rects 能区分「被隐藏」与「被压缩」，从而决定 tooltip 是否补出档位名。
  const updateInlineLabelVisible = useCallback((element: HTMLSpanElement | null) => {
    if (!element) {
      return;
    }
    const style = window.getComputedStyle(element);
    const visible =
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      element.getClientRects().length > 0;
    setInlineLabelVisible(visible);
  }, []);

  // [并发] rafId 是每次渲染新建的普通变量，effect cleanup 只能看到自己那一轮的 rafId；
  // 所以取消帧必须发生在同一闭包里，跨渲染共享会读到 null 而漏取消。
  // 去抖窗口是一帧：同一帧内多次 resize 或 observer 回调只触发一次测量。
  // 不要换成 setTimeout：隐藏窗口时定时器仍持续排队，且延迟不可控。
  // RAF-based debounce to coalesce resize events
  let rafId: number | null = null;
  const debouncedUpdateInlineLabelVisible = () => {
    if (rafId !== null) return;
    rafId = requestAnimationFrame(() => {
      rafId = null;
      updateInlineLabelVisible(labelRef.current);
    });
  };

  // entries 是 option.options 的只读投影，非 select 类型直接为空数组。
  // 后续全部计算都基于这个快照，渲染期间配置对象被替换不会影响本次结果。
  // [契约] 不要在这里排序或过滤，顺序即配置顺序，进度条按同一索引取值。
  const entries = option.type === "select" ? (option.options ?? []) : [];

  const selectedEntryIndex = entries.findIndex((entry) => entry.value === option.currentValue);
  const currentValueIsValid = selectedEntryIndex >= 0;
  // [失败路径] 仅当调用方显式要求、当前值确实不在选项内、且字符串非空白三者同时成立。
  // 缺一条就会出问题：非 select 的残留值或空串会把触发器撑成无意义长文本，
  // 空串还会让 aria-label 变空，读屏器只能报出一个没有名称的按钮。
  const shouldShowInvalidCurrentValue =
    showInvalidCurrentValue &&
    !currentValueIsValid &&
    Boolean(String(option.currentValue ?? "").trim());
  const currentIndex = Math.max(0, selectedEntryIndex);
  const currentEntry = entries[currentIndex] ?? entries[0];
  // 单档判定必须同时要求当前值有效：选项只有一个但值对不上说明配置陈旧，
  // 此时仍应渲染下拉让用户重新选择，而不是固化成不可点的静态标签。
  // [失败路径] 若只按 entries.length 判断，模型升级后用户会被困在无效档位。
  const isFixedThoughtLevel = entries.length === 1 && currentValueIsValid;

  // [契约] 文案三态优先级固定：非法值原样展示 > 有效值查表 > placeholder。
  // 顺序反过来会让非法配置被 placeholder 掩盖，用户看不到真实写入值。
  // getThoughtLevelLabel 需要 provider 参与，不同供应商对同一档位的措辞不同；
  // 查表失败时不要回落到首档文案，否则展示值与实际配置不一致。
  const currentLabel = shouldShowInvalidCurrentValue
    ? String(option.currentValue)
    : currentValueIsValid && currentEntry
      ? getThoughtLevelLabel(intl, provider, option, currentEntry)
      : intl.formatMessage({ id: "chat.toolbar.thoughtLevel.placeholder" });
  const tooltipTitle = intl.formatMessage({
    id: "chat.toolbar.thoughtLevel.tooltip",
  });
  // tooltip 标题优先级：禁用原因 > 标签可见时用通用说明 > 标签不可见时用当前档位名。
  // 标签被断点隐藏后触发器只剩图标和进度条，此时必须由 tooltip 补出档位名，
  // 否则用户在窄容器里无法知道当前强度。
  const effectiveTooltipTitle =
    disabledReason ?? (inlineLabelVisible ? tooltipTitle : currentLabel);

  // [资源] 这里同时建立 ResizeObserver 与 window resize 两路订阅。
  // 依赖是 currentLabel 与 labelVisibilityClassName：文案或可见性类变化都会改变标签占位，需要重新测量。
  // effect 体内不读其他 props，避免无谓重订阅与 observer 抖动。
  useEffect(() => {
    const labelElement = labelRef.current;
    if (!labelElement) {
      return;
    }

    updateInlineLabelVisible(labelElement);

    // ResizeObserver 在部分旧 WebView 与 jsdom 测试环境不存在，
    // 存在性检查后一律用可选链调用，缺失时仅靠 window resize 保底。
    // [权衡] 不要在这里抛错，控件应降级为按初始状态展示，而不是整块崩溃。
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            debouncedUpdateInlineLabelVisible();
          });
    observer?.observe(labelElement);
    if (labelElement.parentElement) {
      observer?.observe(labelElement.parentElement);
    }
    window.addEventListener("resize", debouncedUpdateInlineLabelVisible);

    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", debouncedUpdateInlineLabelVisible);
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [currentLabel, labelVisibilityClassName]);

  // 配置顺序不再经过名称排序，关闭项可能位于任意位置；只计算当前项之前的非关闭项。
  // 未选／失效及关闭值始终为零进度，不能把缺失选择投影成首档。
  const thinkingEntries = entries.filter((entry) => !isNoThoughtLevel(entry));
  // [契约] 进度只在「当前值有效且不是关闭档」时为正，其余一律 0。
  // 当前项是「无思考」时必须停在 0，哪怕它排在第二位，
  // 否则进度条会显示一段高度，暗示模型正在推理。
  // 索引取 thinkingEntries 中的位置而非 entries，关闭项不占格。
  const activeDotCount =
    !currentValueIsValid || !currentEntry || isNoThoughtLevel(currentEntry)
      ? 0
      : thinkingEntries.indexOf(currentEntry) + 1;
  // 分母保底 1，避免全是关闭档时出现 0/0 得到 NaN。
  // CSS height 收到 NaN% 会让整条进度条消失，满格判定同样不能被除零污染。
  // [失败路径] 这里是唯一允许分母与 entries.length 不等的位置。
  const dotCount = Math.max(1, thinkingEntries.length);
  const progressPercent = (activeDotCount / dotCount) * 100;

  // [失败路径] 早退必须发生在所有 hooks 之后、首个分支渲染之前。
  // 把 return null 提到 hooks 之上会改变 hook 调用次数，配置运行时切换类型时直接崩组件。
  // currentEntry 兜底取 entries[0]，所以这里判的是「一个都取不到」而非「当前值无效」。
  // `currentEntry` 无效时仍要渲染下拉，让用户能自行纠正。
  if (option.type !== "select" || entries.length === 0 || !currentEntry) {
    return null;
  }

  // cycle 模式索引推进：当前值无效时从 0 开始，否则取下一个并取模回环。
  // entries 含「关闭」档，轮转会经过「无思考」——这是刻意的，用户可一键关掉推理。
  // nextEntry 判空只用于类型收窄，实际不会触发，也不该改成非空断言。
  // [契约] 不要在这里跳过关闭档，否则关闭态变成只能从下拉进入的隐藏状态。
  const handleClick = () => {
    const nextIndex = !currentValueIsValid ? 0 : (currentIndex + 1) % entries.length;
    const nextEntry = entries[nextIndex];
    if (!nextEntry) {
      return;
    }
    onValueChange(nextEntry.value);
  };

  // [事务] 只有被点击或按键的项恰好等于当前值时才有提交意义：
  // 选到别的档位会通过 onValueChange 走正常变更，不需要这里补提交。
  // 早退同时覆盖了 onCurrentValueCommit 未提供的调用方。
  const armCurrentValueCommit = (value: string) => {
    if (!onCurrentValueCommit || value !== String(option.currentValue)) {
      return;
    }
    pendingCurrentValueCommitRef.current = value;
    // Radix 对 typeahead Space 不执行选择。只在同一轮交互确实关闭
    // Select 时提交当前值，未关闭的键盘意图在微任务中作废。
    // [并发] 微任务在当前事件回调结束后、下一次渲染前执行；
    // 若同一轮交互确实关闭了下拉，handleSelectOpenChange 会先消费 ref，此处比对失败即自动作废。
    // 不要改成定时器：延迟不可控，可能在用户重新打开下拉后才清标记。
    queueMicrotask(() => {
      if (pendingCurrentValueCommitRef.current === value) {
        pendingCurrentValueCommitRef.current = null;
      }
    });
  };

  // [事务] 打开时无条件清空标记（新一轮交互开始），关闭时先取出再清空、最后回调。
  // 顺序不能反：先回调后清空会让回调内的同步重入读到旧标记，重复提交同一档位。
  // 无论是否命中待提交值，都要把 onOpenChange 原样转发给受控调用方。
  const handleSelectOpenChange = (nextOpen: boolean) => {
    if (nextOpen) {
      pendingCurrentValueCommitRef.current = null;
    } else {
      const committedValue = pendingCurrentValueCommitRef.current;
      pendingCurrentValueCommitRef.current = null;
      if (committedValue) {
        onCurrentValueCommit?.(committedValue);
      }
    }
    onOpenChange?.(nextOpen);
  };

  const triggerContent = (
    <>
      <BrainIcon
        className={cn(
          "pointer-events-none size-4 text-current",
          // "inline-flex @lg/composer:hidden",
        )}
      />
      <span
        className={cn(
          "relative w-1 self-stretch overflow-hidden rounded-full bg-current/10",
          composerCollapsePriority !== undefined
            ? "hidden group-data-[composer-compact=true]/thought:inline-flex"
            : "hidden @sm/composer:inline-flex @xl/composer:hidden",
        )}
        aria-hidden="true"
      >
        <span
          className={cn(
            "absolute bottom-0 left-0 w-full rounded-full bg-success transition-[height] duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)]",
            progressPercent > 0 ? "min-h-1" : undefined,
          )}
          style={{ height: `${progressPercent}%` }}
        />
      </span>
      <span
        ref={labelRef}
        className={cn(
          "min-w-0 whitespace-nowrap",
          labelVisibilityClassName,
          composerCollapsePriority !== undefined && "group-data-[composer-compact]/thought:hidden",
        )}
      >
        <RollingToolbarLabel label={currentLabel} />
      </span>
    </>
  );

  // [契约] 单档固定态直接渲染 span，不挂 Select：没有可切换项时下拉只是噪音，
  // 且 cycle 模式下点击会一直轮转回自身，产生一次无效 onValueChange。
  // 数据属性与 testid 与下拉触发器保持一致，保证 E2E 选择器不用分叉。
  if (isFixedThoughtLevel) {
    return (
      <ControlHintTooltip title={effectiveTooltipTitle} triggerRef={triggerRef}>
        <span
          className={cn(
            "inline-flex h-7 items-center gap-1 rounded-lg px-1.5 py-1.5 text-ui-base text-foreground",
            composerTriggerClassName,
            triggerClassName,
          )}
          aria-label={currentLabel}
          data-thought-level-fixed="true"
          data-composer-thought-control={composerCollapsePriority !== undefined || undefined}
          data-composer-collapse-priority={composerCollapsePriority}
          data-testid={TID_CHAT_THOUGHT_LEVEL_SELECT_TRIGGER}
        >
          {/* Bugfix: 单档模型（只有一个思考档位）没有可切换状态，不能继续渲染带箭头的 Select。 */}
          {triggerContent}
        </span>
      </ControlHintTooltip>
    );
  }

  if (interactionMode === "select") {
    return (
      <Select
        open={open}
        onOpenChange={handleSelectOpenChange}
        value={String(option.currentValue)}
        onValueChange={(value) => {
          // Radix Select 在受控值与子项注册竞争时可能发出空值等未渲染值；
          // 直接上抛会被调用方误当成用户切换档位。只接受已渲染 entries 中的值。
          if (!entries.some((entry) => entry.value === value)) {
            return;
          }
          onValueChange(value);
        }}
        disabled={disabled}
      >
        <ControlHintTooltip
          title={effectiveTooltipTitle}
          shortcut={shortcutLabel}
          triggerRef={triggerRef}
        >
          <SelectTrigger
            variant="ghost"
            size="default"
            indicator={
              <ChevronDownIcon
                className={cn(
                  "pointer-events-none size-3.5 text-foreground-subtle",
                  indicatorClassName,
                  composerCollapsePriority !== undefined &&
                    "group-data-[composer-compact]/thought:hidden",
                )}
              />
            }
            className={cn(
              "gap-1 rounded-lg px-1.5 py-1.5 text-ui-base",
              composerTriggerClassName,
              triggerClassName,
            )}
            aria-label={currentLabel}
            data-chat-toolbar-popover-trigger="true"
            data-composer-thought-control={composerCollapsePriority !== undefined || undefined}
            data-composer-collapse-priority={composerCollapsePriority}
            data-testid={TID_CHAT_THOUGHT_LEVEL_SELECT_TRIGGER}
          >
            {triggerContent}
          </SelectTrigger>
        </ControlHintTooltip>
        <SelectContent
          position="popper"
          side="top"
          align="start"
          sideOffset={4}
          collisionPadding={8}
          onCloseAutoFocus={(event) => {
            // [失败路径] Automations 等无聊天输入框的宿主传 null，此时保留 Radix 默认行为，
            // 让焦点回到触发器；主动 preventDefault 会把焦点丢到 body。
            if (!restoreFocusSelector) {
              // Automations 没有聊天输入框可恢复；保留 Radix 默认行为，
              // 让键盘焦点回到触发器，而不是 preventDefault 后掉到 body。
              return;
            }
            // [权衡] 一旦阻止默认焦点回落，就必须自己接管焦点，否则键盘用户丢失落点。
            // 下面按粗指针设备再判一次：移动端点选后抢焦点会立刻弹出软键盘，遮挡刚关闭的下拉。
            // 两个分支都放行只会出现在「桌面且无输入框」组合，属于已知可接受损失。
            event.preventDefault();
            if (
              !shouldRestoreChatInputFocusAfterPickerClose({
                isCoarseTouchDevice: isCoarseTouchDevice(),
              })
            ) {
              return;
            }
            const input = document.querySelector<HTMLElement>(restoreFocusSelector);
            input?.focus();
          }}
        >
          {entries.map((entry) => (
            <SelectItem
              key={entry.value}
              value={entry.value}
              onClick={onCurrentValueCommit ? () => armCurrentValueCommit(entry.value) : undefined}
              onPointerUp={
                onCurrentValueCommit
                  ? (event) => {
                      if (event.button === 0 && event.pointerType === "mouse") {
                        armCurrentValueCommit(entry.value);
                      }
                    }
                  : undefined
              }
              onKeyDown={
                onCurrentValueCommit
                  ? (event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        armCurrentValueCommit(entry.value);
                      }
                    }
                  : undefined
              }
              data-testid={testId(TID_CHAT_THOUGHT_LEVEL_SELECT_ITEM, entry.value)}
            >
              <span className="first-letter:uppercase">
                {getThoughtLevelLabel(intl, provider, option, entry)}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }

  // cycle 模式只剩一个 Button：点击推进档位，禁用时依赖 Button 的 disabled 拦截事件。
  // 本分支不渲染 SelectContent，因此 open 与 onOpenChange 在这里不生效。
  // [契约] tooltip 与 testid 必须与 select 分支一致，否则同一控件在两种模式下行为不可预期。
  return (
    <ControlHintTooltip
      title={effectiveTooltipTitle}
      shortcut={shortcutLabel}
      triggerRef={triggerRef}
    >
      <Button
        type="button"
        variant="ghost"
        size="default"
        disabled={disabled}
        data-chat-toolbar-popover-trigger="true"
        data-composer-thought-control={composerCollapsePriority !== undefined || undefined}
        data-composer-collapse-priority={composerCollapsePriority}
        data-testid={TID_CHAT_THOUGHT_LEVEL_SELECT_TRIGGER}
        className={cn(
          "gap-1 rounded-lg px-1.5 py-1.5 text-ui-base",
          composerTriggerClassName,
          triggerClassName,
        )}
        aria-label={currentLabel}
        onClick={handleClick}
      >
        {triggerContent}
      </Button>
    </ControlHintTooltip>
  );
}
