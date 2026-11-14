// INV-01 受控值：value 只读取不落盘，onChange 是唯一写出口。守住位置：外部状态是唯一事实源；改错故障：一旦本地缓存文本，回填与过滤会各说各话。
// INV-02 id 同源：generatedId 同时供输入框与 listbox、option 使用。守住位置：aria 关联的三处 id 必须同一来源；改错故障：任一处换成本地 id，读屏就找不到候选。
// INV-03 open 所有权：可见性只由内部 state 决定。守住位置：所有打开请求汇总到 requestOpenFromInput；改错故障：若在渲染分支里直接改状态，会出现关不掉的弹层。
// INV-04 下标边界：activeIndex 合法区间是 -1 到长度减一。守住位置：每次打开与关闭都归位到 -1；改错故障：沿用旧下标会让 aria-activedescendant 指向已卸载的选项。
// INV-05 过滤开关：filterWithCurrentValue 表示“是否按当前输入收窄”。守住位置：聚焦清空、输入置真、关闭复位；改错故障：漏掉任一处，历史列表会在不该过滤时只剩一条。
// INV-06 抑制窗口：选中后短时间拒绝重新打开。守住位置：窗口比较发生在打开入口最前面；改错故障：顺序一旦后移，点击候选会立刻把弹层再弹一次。
// INV-07 焦点留守：keepInputFocusOnOpenRef 只对一次由输入框发起的打开生效。守住位置：拦截自动聚焦后立即复位；改错故障：标记不清会导致后续键盘进入时焦点被强留在输入框。
// INV-08 空历史：suggestions 为空时弹层永不打开。守住位置：打开入口与渲染条件双重把关；改错故障：只拦一处会出现“有弹层没内容”的空壳。
// INV-09 外点豁免：容器内的点击不算弹层外部交互。守住位置：判定依据是事件目标是否落在容器子树；改错故障：误判会导致首次点击输入框时弹层开了又关。
// INV-10 方向键：上下键在候选间循环移动且从不越界。守住位置：取模与回绕都在同一表达式内完成；改错故障：用原始数组长度取模会在过滤生效时跳到不存在的项。
// INV-11 回车提交：只有存在有效高亮时才选中。守住位置：提交前复核下标对应的候选项是否存在；改错故障：空下标提交会把 undefined 写进受控值。
// INV-12 退出键：Escape 与 Tab 只关闭不提交。守住位置：Escape 需要阻止冒泡以免关闭外层对话框；改错故障：误把 Tab 也拦下会让用户无法离开输入框。
// INV-13 滚动可见：高亮项变化时把它滚到最近可视位置。守住位置：滚动发生在候选节点的引用回调里；改错故障：依赖渲染后测量会在一帧内看不到当前高亮。
// INV-14 指针按下：候选上按下鼠标不抢输入框焦点。守住位置：按下阶段阻止默认行为，点击阶段才提交；改错故障：漏掉按下拦截会让输入框先失焦，过滤条件随之丢失。
// INV-15 可访问名：label 与 inputId 绑定，缺省时用 placeholder 兜底。守住位置：同一 inputId 同时给 label 与输入框；改错故障：两处各生成一次 id 会让标签成为孤立文本。
// INV-16 宽度：suggestionWidth 允许覆盖弹层宽度但不突破视口。守住位置：容器类名与最大宽度共同约束；改错故障：只给固定宽度会让窄屏出现横向滚动。
// INV-17 事件顺序：输入事件里先抛出 onChange 再开过滤。守住位置：受控值更新与过滤开关在同一次事件内完成；改错故障：顺序颠倒会用旧值过滤，列表闪一下再正确。
// INV-18 兜底文案：emptyText 与 aria-label 都允许缺省回退。守住位置：回退值来自 placeholder 与调用方传入文本；改错故障：硬编码中文会让多语言场景出现混排。
//
// 模块职责：受控的历史建议输入框，负责聚焦与输入时的候选展示、键盘导航与选中回写，不承担连接建立与网络请求。
// 状态所有权：文本值归调用方；可见性、高亮下标、过滤开关与三个 ref 归本组件，跨层只经 props 回调传递意图。
// 阅读顺序：先看状态声明与派生过滤，再看打开入口与关闭收敛，最后读键盘分派、空态渲染与焦点拦截。
import { useCallback, useId, useMemo, useRef, useState, type ComponentProps } from "react";
import { cn } from "@/components/lib/utils.js";
import { Input } from "@/components/ui/input.js";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover.js";
import { shouldIgnoreRemoteConnectionHistoryPopoverInteractOutside } from "@/remote-connection/remoteConnectionHistoryPopover.js";

function matchesSuggestion(value: string, query: string): boolean {
  const normalizedValue = value.trim().toLowerCase();
  const normalizedQuery = query.trim().toLowerCase();

  if (!normalizedQuery) {
    return true;
  }

  return normalizedValue.includes(normalizedQuery);
}

// `RemoteConnectionHistoryInput` 只管输入与历史建议：连哪台机、何时重连由调用方决定。
// 解构把 containerClassName、suggestionWidth 这类纯样式开关留在外层，避免样式差异渗透进交互逻辑。
// value 与 onChange 成对出现，意味着本组件永远是受控输入：内部不保存文本副本，只在事件发生时把新值抛回。
// 剩余 inputProps 允许透传原生属性，但 id 与 onKeyDown 属于“先取值再覆盖”的顺序敏感项，改动顺序会同时影响无障碍关联与按键优先级。
export function RemoteConnectionHistoryInput({
  containerClassName,
  suggestionWidth,
  label,
  placeholder,
  value,
  suggestions,
  emptyText,
  onChange,
  ...inputProps
}: {
  containerClassName?: string;
  suggestionWidth?: string;
  label?: string;
  placeholder: string;
  value: string;
  suggestions: string[];
  emptyText: string;
  onChange: (value: string) => void;
} & Omit<
  ComponentProps<typeof Input>,
  "children" | "onChange" | "placeholder" | "size" | "value"
>) {
  const generatedId = useId();
  const inputId = inputProps.id ?? generatedId;
  // open 由组件自己持有而不接受外部注入，保证“建议列表可见性”只有一处写入点，调用方无法在渲染中途与内部状态打架。
  // activeIndex 与 open 分离：关闭时保留 -1 语义，打开瞬间也重置为 -1，避免上一次会话的选中项被误认为本次默认高亮。
  // filterWithCurrentValue 决定过滤是否启用：聚焦时清空为 false 展示全量历史，用户真正输入后才置为 true。
  // 三个状态互不推导，改动其一必须显式重置另外两者，否则会出现“列表开着但高亮指向越界下标”的中间态。
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [filterWithCurrentValue, setFilterWithCurrentValue] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const keepInputFocusOnOpenRef = useRef(false);
  const suppressOpenUntilRef = useRef(0);

  // 过滤是纯派生：输入 suggestions 与 value 不变时引用稳定，避免下游用引用比较时反复重渲染。
  // 未启用过滤时直接返回原数组（同一引用），这是聚焦后立刻看到完整历史的保证。
  // 启用过滤时匹配忽略大小写与首尾空白，空查询视为全部命中，因此清空输入不会突然变成空列表。
  // 派生结果只在过滤开关、suggestions、value 变化时重算；键盘下标必须始终以该结果长度取模，不能引用原始数组长度。
  const filteredSuggestions = useMemo(() => {
    if (!filterWithCurrentValue) {
      return suggestions;
    }

    return suggestions.filter((item) => matchesSuggestion(item, value));
  }, [filterWithCurrentValue, suggestions, value]);

  // 这是“打开建议列表”的唯一入口，聚焦、点击、输入、方向键都汇流到这里，避免多处各自拼装打开条件。
  // 抑制窗口未到期或历史为空时直接不打开，这是选中候选后回车或点击引发重复弹出的第一道闸。
  // resetFilter 默认视为 true：来自聚焦与点击的打开要回到全量视图，来自输入事件的打开必须显式传 false 才能保留过滤。
  // 打开前把高亮下标归位并标记“焦点需留守”，两个动作必须同时发生，否则弹层打开那一刻焦点会被挪走。
  const requestOpenFromInput = useCallback(
    (options?: { resetFilter?: boolean }) => {
      if (Date.now() < suppressOpenUntilRef.current || suggestions.length === 0) {
        return;
      }

      if (options?.resetFilter !== false) {
        setFilterWithCurrentValue(false);
      }

      setActiveIndex(-1);
      keepInputFocusOnOpenRef.current = true;
      setOpen(true);
    },
    [suggestions.length],
  );

  // `handleOpenChange` 是可见性唯一写入口：外部触发与内部收起都汇到一处。
  // 打开分支直接返回，不做任何清理，避免与打开入口刚设置的焦点标记互相覆盖。
  // 关闭分支才重置焦点标记与过滤开关，保证下一次打开从干净状态开始，而不是继承上次的过滤结果。
  // 若在打开瞬间清标记，自动聚焦拦截会读到 false 从而放行，输入框失焦后连续输入就会中断。
  const handleOpenChange = useCallback((nextOpen: boolean) => {
    setOpen(nextOpen);
    if (nextOpen) {
      return;
    }

    keepInputFocusOnOpenRef.current = false;
    setFilterWithCurrentValue(false);
  }, []);

  // 选中是唯一“写回外部值”的路径，先抛出 onChange 再收尾内部状态，保证调用方拿到的值与界面收起顺序一致。
  // 抑制窗口把“刚选中就再次打开”挡在门外，窗口时长足以覆盖一次点击或回车的完整事件序列。
  // 收起时同时把高亮下标归位，防止弹层以旧下标重新打开时 aria-activedescendant 指向不存在的选项。
  // 这里不主动移动焦点，焦点留在输入框由打开阶段的拦截逻辑负责，两条链路不能互相依赖。
  const selectSuggestion = (selected: string) => {
    onChange(selected);
    setFilterWithCurrentValue(false);
    suppressOpenUntilRef.current = Date.now() + 120;
    setOpen(false);
    setActiveIndex(-1);
  };

  return (
    <div ref={containerRef} className={cn("w-full", containerClassName)}>
      {label ? (
        <label htmlFor={inputId} className="mb-1.5 block text-ui-sm text-remote-foreground-muted">
          {label}
        </label>
      ) : null}
      <Popover open={open && suggestions.length > 0} onOpenChange={handleOpenChange}>
        <PopoverAnchor asChild>
          <Input
            id={inputId}
            ref={inputRef}
            size="lg"
            placeholder={placeholder}
            value={value}
            onFocus={() => requestOpenFromInput()}
            onClick={() => requestOpenFromInput()}
            onChange={(event) => {
              onChange(event.target.value);
              setFilterWithCurrentValue(true);
              requestOpenFromInput({ resetFilter: false });
            }}
            autoComplete="off"
            {...inputProps}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={open && suggestions.length > 0}
            aria-controls={open ? `${generatedId}-list` : undefined}
            aria-activedescendant={
              open && activeIndex >= 0 ? `${generatedId}-option-${activeIndex}` : undefined
            }
            // 先转发外部 onKeyDown 再判断 defaultPrevented，尊重调用方对按键的优先处置权，避免组合键被本组件吞掉。
            // `activeIndex` 为 -1（候选为空）时方向键直接放行，光标仍在输入框内移动。
            // 上下键按下标循环：向下取模回到头部，向上在 0 处回绕到末尾，边界不产生 -1 或越界下标。
            // 弹层未打开时按方向键会先请求打开再计算下标，两条分支必须共享同一份过滤结果长度。
            onKeyDown={(event) => {
              inputProps.onKeyDown?.(event);
              if (event.defaultPrevented) return;
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                if (!filteredSuggestions.length) return;
                event.preventDefault();
                if (!open) requestOpenFromInput();
                setActiveIndex((index) =>
                  event.key === "ArrowDown"
                    ? (index + 1) % filteredSuggestions.length
                    : index <= 0
                      ? filteredSuggestions.length - 1
                      : index - 1,
                );
              } else if (open && event.key === "Enter" && activeIndex >= 0) {
                event.preventDefault();
                const selected = filteredSuggestions[activeIndex];
                if (selected !== undefined) selectSuggestion(selected);
              } else if (open && (event.key === "Escape" || event.key === "Tab")) {
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                }
                setOpen(false);
                setActiveIndex(-1);
              }
            }}
          />
        </PopoverAnchor>
        <PopoverContent
          align="start"
          className="max-w-[calc(100vw-2rem)] rounded-xl border border-border bg-menu p-1 shadow-lg"
          style={{
            width: suggestionWidth ?? "var(--radix-popover-trigger-width)",
          }}
          onInteractOutside={(event) => {
            const targetNode = event.target;
            if (
              shouldIgnoreRemoteConnectionHistoryPopoverInteractOutside({
                isTargetInsideContainer:
                  targetNode instanceof Node && containerRef.current?.contains(targetNode) === true,
              })
            ) {
              // 首次鼠标点击输入框时会先触发 focus 打开建议列表，
              // 随后的同一次 click 又会被 Popover 视为“内容外点击”而立刻关闭。
              // 这里把来自当前输入框容器的交互排除掉，避免出现第一次 focus 连续闪两次。
              event.preventDefault();
            }
          }}
          // 焦点策略由 keepInputFocusOnOpenRef 单独把关：只有“由输入框发起”的打开才允许把焦点留在输入框。
          // 未标记时直接返回，让弹层按默认行为接管焦点，用户用键盘从外部进入时不会被困在输入框。
          // 标记有效时阻止自动聚焦并显式把焦点还给输入框，这是“边看历史边继续输入过滤”的前提。
          // 归还焦点后立刻清标记，标记只对一次打开生效，否则后续任意一次打开都会错误地拒绝自动聚焦。
          onOpenAutoFocus={(event) => {
            // Popover 默认会把焦点抢到弹层内，输入框一旦失焦，用户就没法边看历史边继续输入过滤。
            // 这里在“由输入框触发打开”时拦截自动聚焦，把焦点留在输入框里，保证 focus 展示和连续输入都成立。
            if (!keepInputFocusOnOpenRef.current) {
              return;
            }

            event.preventDefault();
            inputRef.current?.focus();
            keepInputFocusOnOpenRef.current = false;
          }}
        >
          <div
            id={`${generatedId}-list`}
            role="listbox"
            aria-label={label ?? placeholder}
            className="max-h-56 overflow-y-auto rounded-lg"
          >
            {filteredSuggestions.length === 0 ? (
              <p className="px-3 py-5 text-ui-base text-remote-foreground-muted">{emptyText}</p>
            ) : (
              filteredSuggestions.map((item, index) => (
                <div
                  key={item}
                  id={`${generatedId}-option-${index}`}
                  role="option"
                  aria-selected={index === activeIndex}
                  ref={(element) => {
                    if (index === activeIndex) element?.scrollIntoView({ block: "nearest" });
                  }}
                  className={cn(
                    "min-h-8 cursor-pointer rounded-md px-3 py-1.5 text-ui-base text-foreground hover:bg-menu-hover",
                    index === activeIndex && "bg-menu-hover",
                  )}
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() => selectSuggestion(item)}
                >
                  <span className="block truncate">{item}</span>
                </div>
              ))
            )}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
