// INV-01 打开即聚焦并全选：守住位置 mount 副作用；改错故障 用户需再点一次才能输入。
// INV-02 空匹配禁用跳转：守住位置 disabled 判定；改错故障 0 条结果仍可点上下键。
// INV-03 Escape 关闭且阻止默认：守住位置 keydown 分支；改错故障 搜索框吞掉 Esc，面板关不掉。
// INV-04 Enter 正向、Shift+Enter 反向：守住位置 shiftKey 三元；改错故障 快捷键方向与按钮相反。
// INV-05 计数器只在有匹配时显示序号：守住位置 matchCount 大于零的三元；改错故障 0/0 与索引 0 混淆。
// INV-06 受控输入：守住位置 value 与 onChange 绑定；改错故障 输入框可被外部状态覆盖成脏值。
// INV-07 三个按钮文案全部走 intl：守住位置 三处 formatMessage；改错故障 多语言下按钮无标签。
// INV-08 关闭按钮不受匹配数影响：守住位置 第三个 Button 无 disabled；改错故障 无结果时连关闭都点不了。
// INV-09 搜索框身份用 data 属性：守住位置 data-trajectory-search-bar；改错故障 测试与样式选择器失效。
// INV-10 原生取消按钮隐藏：守住位置 尾部 appearance-none；改错故障 与自定义关闭按钮重叠。
// INV-11 aria-hidden 只给装饰图标：守住位置 SearchIcon；改错故障 读屏重复播报图标名。
// INV-12 面板高度与横向约束：守住位置 h-8 与 min-w-0；改错故障 长查询把面板撑开。
// INV-13 导航语义固定为上一处与下一处：守住位置 onMove 的字面量；改错故障 上层收到未知方向。
//
// 模块职责：轨迹面板内的查找条，负责输入、计数与上一处/下一处/关闭三种操作。
// 阅读顺序：先看挂载聚焦与受控输入，再看键盘分支与计数器，最后看三个按钮的可用性差异。
import { ArrowDownIcon, ArrowUpIcon, SearchIcon, XIcon } from "lucide-react";
import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button.js";
import type { IntlShape } from "@/ModelTrajectoryPaneParts.js";

export function ModelTrajectorySearchBar({
  query,
  activeIndex,
  matchCount,
  onQueryChange,
  onMove,
  onClose,
  intl,
}: {
  query: string;
  activeIndex: number;
  matchCount: number;
  onQueryChange: (query: string) => void;
  onMove: (direction: "previous" | "next") => void;
  onClose: () => void;
  intl: IntlShape;
}) {
  // 持有输入框句柄，仅用于挂载时聚焦。
  const inputRef = useRef<HTMLInputElement>(null);
  // 空依赖，只在首次挂载执行一次。
  useEffect(() => {
    inputRef.current?.focus();
    // 预选中已有查询，便于直接覆盖输入。
    inputRef.current?.select();
  }, []);

  const previousLabel = intl.formatMessage({ id: "modelTrajectory.searchPrevious" });
  const nextLabel = intl.formatMessage({ id: "modelTrajectory.searchNext" });
  const closeLabel = intl.formatMessage({ id: "modelTrajectory.searchClose" });
  // matchCount === 0 时上下跳转没有意义，disabled 必须一起禁用。
  const disabled = matchCount === 0;

  return (
    <div
      // 稳定身份标记，供测试与样式定位。
      data-trajectory-search-bar=""
      className="mt-2 flex h-8 min-w-0 items-center gap-1.5 rounded-lg border border-input-border bg-input px-2"
    >
      <SearchIcon className="size-3.5 shrink-0 text-foreground-subtle" aria-hidden="true" />
      <input
        ref={inputRef}
        // type="search" 用原生搜索类型，获得系统级清除与 Esc 语义。
        type="search"
        // 完全受控，匹配状态由上层维护。
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={(event) => {
          // Esc 优先关闭，避免落到上层快捷键。
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          // Enter 触发跳转，方向由修饰键决定。
          } else if (event.key === "Enter") {
            event.preventDefault();
            // Shift 反转方向，与按钮顺序保持一致。
            onMove(event.shiftKey ? "previous" : "next");
          }
        }}
        // 占位文案走 intl，跟随界面语言。
        placeholder={intl.formatMessage({ id: "modelTrajectory.searchPlaceholder" })}
        aria-label={intl.formatMessage({ id: "modelTrajectory.search" })}
        className="min-w-0 flex-1 bg-transparent text-ui-sm text-foreground outline-none placeholder:text-foreground-subtlest [&::-webkit-search-cancel-button]:appearance-none"
      />
      <span className="w-12 shrink-0 text-center font-mono text-ui-xs tabular-nums text-foreground-subtle">
        {matchCount > 0 ? `${activeIndex + 1}/${matchCount}` : "0/0"}
      </span>
      <span className="flex shrink-0 items-center gap-0.5 border-l border-border pl-1.5">
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          disabled={disabled}
          aria-label={previousLabel}
          title={previousLabel}
          // 上一个按钮与 Shift+Enter 走同一条路径。
          onClick={() => onMove("previous")}
        >
          <ArrowUpIcon className="size-3.5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          disabled={disabled}
          aria-label={nextLabel}
          title={nextLabel}
          // 下一个按钮与 Enter 走同一条路径。
          onClick={() => onMove("next")}
        >
          <ArrowDownIcon className="size-3.5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={closeLabel}
          title={closeLabel}
          // 关闭按钮始终可用，disabled 必须只作用于跳转，不影响 onClose。
          onClick={onClose}
        >
          <XIcon className="size-3.5" />
        </Button>
      </span>
    </div>
  );
}
