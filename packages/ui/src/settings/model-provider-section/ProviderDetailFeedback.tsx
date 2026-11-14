// INV-01 默认上下文空实现：守住位置 建上下文默认值；改错故障 无 Provider 时抛错。
// INV-02 同 key 更新原位：守住位置 已存在分支；改错故障 重复提示堆叠。
// INV-03 同 key 重发先清旧定时器：守住位置 计时器映射；改错故障 旧定时器提前关闭新提示。
// INV-04 时长可覆盖：守住位置 空值合并；改错故障 调用方无法定制停留。
// INV-05 默认时长按状态：守住位置 解析函数；改错故障 失败提示过早消失。
// INV-06 进行中不自动关闭：守住位置 零时长判断；改错故障 进行中被计时器抹掉。
// INV-07 卸载清全部定时器：守住位置 清理函数；改错故障 卸载后仍触发状态写入。
// INV-08 关闭同时清定时器：守住位置 删除分支；改错故障 关闭后计时器仍持有引用。
// INV-09 提示按 key 渲染：守住位置 React 键；改错故障 列表复用错位。
// INV-10 失败用告警角色：守住位置 角色三元；改错故障 读屏不播报错误。
// INV-11 成功绿色需显式开启：守住位置 显式标志；改错故障 保存反馈被误当连接成功。
// INV-12 操作按钮需成对：守住位置 双条件；改错故障 出现无回调的按钮。
// INV-13 可关闭才渲染关闭键：守住位置 条件渲染；改错故障 常驻提示无法收起。
// INV-14 关闭键无障碍名回退：守住位置 空值回退；改错故障 读屏只念图标。
// INV-15 容器不拦截页面点击：守住位置 指针事件；改错故障 覆盖层挡住表单。
// INV-16 覆盖层贴底：守住位置 粘性定位；改错故障 长页面提示滚出视口。
// INV-17 上下文值稳定：守住位置 记忆化；改错故障 每次渲染触发消费方重渲。
// INV-18 对外只暴露两个方法：守住位置 接口声明；改错故障 组件直接改内部列表。
//
// 模块职责：模型 Provider 详情页的页内反馈条与定时收起。
// 状态所有权：提示列表与计时器归边界组件，钩子只读上下文。
// 阅读顺序：先看默认时长，再看边界组件，最后看渲染分支。
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { CheckCircle2Icon, CircleAlertIcon, Loader2Icon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";

export type ProviderDetailFeedbackState = "pending" | "success" | "failure";

export interface ProviderDetailFeedbackInput {
  key: string;
  message: string;
  state: ProviderDetailFeedbackState;
  /** 连接测试成功使用语义绿；保存/删除沿用中性反馈，不按文案或 key 推断操作。 */
  successEmphasis?: boolean;
  durationMs?: number;
  actionLabel?: string;
  onAction?: () => void;
  dismissible?: boolean;
  dismissLabel?: string;
}

interface ProviderDetailFeedbackContextValue {
  showFeedback: (input: ProviderDetailFeedbackInput) => void;
  dismissFeedback: (key: string) => void;
}

const ProviderDetailFeedbackContext = createContext<ProviderDetailFeedbackContextValue>({
  showFeedback: () => undefined,
  dismissFeedback: () => undefined,
});

// 默认上下文用 () => undefined 占位，无 Provider 时不抛错。
// 消费方直接 useContext 读取，无需判空。
// 只读取最近一层 ProviderDetailFeedbackContext，不做跨层合并。
// 该 hook 不做记忆化，返回值随上下文引用变化。
// 只暴露读取语义，写入仍走边界组件的 showFeedback。
export function useProviderDetailFeedback(): ProviderDetailFeedbackContextValue {
  return useContext(ProviderDetailFeedbackContext);
}

// state 为 pending 时返回 0，调用方据此跳过计时器。
// failure 默认 8_000 毫秒，给用户留出读错误的时间。
// success 默认 3_500 毫秒，保存反馈不长期占位。
// input.durationMs 存在时优先，覆盖这里的默认值。
// 只按 state 分支，不读文案或 key 推断语气。
function resolveDefaultDuration(state: ProviderDetailFeedbackState): number {
  if (state === "pending") return 0;
  return state === "failure" ? 8_000 : 3_500;
}

// items 列表与 timersRef 都归 ProviderDetailFeedbackBoundary 持有。
// timersRef 的键是 item.key，与列表同生命周期。
// 卸载时 useEffect 的清理函数遍历 timers.values() 全部 clearTimeout。
// contextValue 由 useMemo 按 showFeedback 与 dismissFeedback 记忆。
// 外层 div 用 pointer-events-none，不占布局高度也不挡表单。
// children 原样透传，边界组件不改写子树。
export function ProviderDetailFeedbackBoundary({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ProviderDetailFeedbackInput[]>([]);
  const timersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  // dismissFeedback 先按 key 取 timersRef.current 里的计时器。
  // 取到就 clearTimeout，再从映射 delete 掉该键。
  // 最后 setItems 过滤掉同 key 项，关闭与超时共用这条路径。
  // 未知 key 走同一条路径，get 返回 undefined 时静默跳过。
  // 空依赖数组让回调身份在组件生命周期内保持稳定。
  const dismissFeedback = useCallback((key: string) => {
    const timer = timersRef.current.get(key);
    if (timer) clearTimeout(timer);
    timersRef.current.delete(key);
    setItems((current) => current.filter((item) => item.key !== key));
  }, []);

  const showFeedback = useCallback(
    (input: ProviderDetailFeedbackInput) => {
      const previousTimer = timersRef.current.get(input.key);
      if (previousTimer) clearTimeout(previousTimer);
      timersRef.current.delete(input.key);
      setItems((current) => {
        const existingIndex = current.findIndex((item) => item.key === input.key);
        if (existingIndex < 0) return [...current, input];
        const next = [...current];
        next[existingIndex] = input;
        return next;
      });

      const durationMs = input.durationMs ?? resolveDefaultDuration(input.state);
      if (durationMs > 0) {
        timersRef.current.set(
          input.key,
          setTimeout(() => dismissFeedback(input.key), durationMs),
        );
      }
    },
    [dismissFeedback],
  );

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  const contextValue = useMemo(
    () => ({ showFeedback, dismissFeedback }),
    [dismissFeedback, showFeedback],
  );

  return (
    <ProviderDetailFeedbackContext.Provider value={contextValue}>
      {children}
      {/* 整页滚动后，内容底部可能在屏外；覆盖层不占高度，sticky 以 main 视口定位反馈。 */}
      <div className="pointer-events-none absolute inset-3 flex flex-col justify-end sm:inset-4">
        <div
          className="sticky bottom-3 z-20 flex flex-col gap-2 sm:bottom-4"
          data-testid="provider-detail-feedback-viewport"
          aria-live="polite"
        >
          {items.map((item) => (
            <div
              key={item.key}
              role={item.state === "failure" ? "alert" : "status"}
              data-provider-detail-feedback-state={item.state}
              className={cn(
                "pointer-events-auto flex min-h-11 w-full items-center gap-3 rounded-xl border px-3 py-2.5 backdrop-blur-sm",
                item.state === "success" &&
                  (item.successEmphasis
                    ? "border-success/30 bg-success/10 text-success shadow-md"
                    : "border-border bg-popover/95 text-foreground shadow-md"),
                item.state === "failure" &&
                  "border-destructive/30 bg-destructive/10 text-destructive shadow-lg",
                item.state === "pending" && "border-border bg-popover/95 text-foreground shadow-md",
              )}
            >
              {item.state === "pending" ? (
                <Loader2Icon className="size-4 shrink-0 animate-spin" aria-hidden="true" />
              ) : item.state === "success" ? (
                <CheckCircle2Icon className="size-4 shrink-0 text-success" aria-hidden="true" />
              ) : (
                <CircleAlertIcon className="size-4 shrink-0" aria-hidden="true" />
              )}
              <span className="min-w-0 flex-1 text-ui-sm font-medium">{item.message}</span>
              {item.actionLabel && item.onAction ? (
                <Button type="button" variant="ghost" size="sm" onClick={item.onAction}>
                  {item.actionLabel}
                </Button>
              ) : null}
              {item.dismissible ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={item.dismissLabel ?? item.message}
                  onClick={() => dismissFeedback(item.key)}
                >
                  <XIcon className="size-3.5" aria-hidden="true" />
                </Button>
              ) : null}
            </div>
          ))}
        </div>
      </div>
    </ProviderDetailFeedbackContext.Provider>
  );
}
