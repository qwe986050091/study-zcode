// INV-01 路径项只承载展示与动作：守住位置 接口字段；改错故障 面包屑持有路由状态。
// INV-02 章节项固定排首位：守住位置 拼接顺序；改错故障 章节被页面项挤掉。
// INV-03 注销按版本授权：守住位置 版本比较；改错故障 旧页面清空新页面的面包屑。
// INV-04 报告函数身份稳定：守住位置 依赖数组；改错故障 每次渲染都重装报告者。
// INV-05 动作引用与签名解耦：守住位置 两个引用；改错故障 文案不变也频繁上报。
// INV-06 签名只覆盖文案：守住位置 序列化范围；改错故障 动作变化触发多余上报。
// INV-07 上报只在依赖变化时发生：守住位置 effect 依赖；改错故障 出现上报循环。
// INV-08 未提供提供方时静默：守住位置 可选调用；改错故障 独立使用组件时报错。
// INV-09 单项不渲染导航：守住位置 长度判断；改错故障 顶栏出现只剩分隔线的空壳。
// INV-10 末项视为当前位置：守住位置 下标比较；改错故障 当前位置仍可点击跳转。
// INV-11 无动作项退化为文本：守住位置 条件分支；改错故障 出现禁用按钮。
// INV-12 键包含下标与文案：守住位置 键拼接；改错故障 同名项复用错误节点。
// INV-13 导航区域不拦截指针：守住位置 容器类；改错故障 顶栏拖拽被阻断。
// INV-14 可点击项单独恢复指针：守住位置 按钮类；改错故障 按钮点不动。
// INV-15 分隔符不进可访问树：守住位置 隐藏属性；改错故障 读屏重复念出箭头。
// INV-16 当前项标记页面语义：守住位置 当前属性；改错故障 读屏无法识别所在层级。
// INV-17 长文案统一截断：守住位置 截断类；改错故障 面包屑撑破标题栏。
// INV-18 测试标识区分章节与子项：守住位置 条件拼接；改错故障 自动化无法定位返回。
//
// 模块职责：把设置子页面的路径投影到顶栏，并提供返回上一层的入口。
// 状态所有权：导航状态仍属各页面；本模块只接收投影并在卸载时撤掉。
// 阅读顺序：先看上下文与提供方，再看报告者的签名上报，最后看渲染分支。
import { createContext, useCallback, useContext, useEffect, useRef, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";

// SettingsBreadcrumbItem 只有 label 与可选 onSelect 两个字段。
// items 的最后一项视为当前位置，不再渲染跳转。
// onSelect 缺失的项渲染为纯文本。
// SettingsBreadcrumbItem 接口不承载路由状态，只描述展示项。
// 面包屑的跳转目标由上层 onSelect 决定，本模块不解释路径。
export interface SettingsBreadcrumbItem {
  label: string;
  onSelect?: () => void;
}

interface SettingsBreadcrumbReport {
  items: readonly SettingsBreadcrumbItem[];
  onSectionSelect?: () => void;
}

const SettingsBreadcrumbContext = createContext<
  ((report: SettingsBreadcrumbReport) => () => void) | null
>(null);

// report() 每次调用都返回自己的注销函数。
// sectionLabel 固定插在 items 最前。
// reportVersion 由 reportVersionRef 自增，决定谁有权清空。
// 旧版本的 cleanup 不影响新投影。
// cleanup 用 reportVersionRef.current === reportVersion 兜住顺序。
export function SettingsBreadcrumbProvider({
  children,
  onItemsChange,
  sectionLabel,
}: {
  children: ReactNode;
  onItemsChange: (items: readonly SettingsBreadcrumbItem[]) => void;
  sectionLabel: string;
}) {
  const reportVersionRef = useRef(0);
  const report = useCallback(
    ({ items, onSectionSelect }: SettingsBreadcrumbReport) => {
      const reportVersion = ++reportVersionRef.current;
      onItemsChange([{ label: sectionLabel, onSelect: onSectionSelect }, ...items]);
      return () => {
        // 多个页面 reporter 切换时，旧 effect 可能晚于新 effect cleanup。
        // 旧版本只能清理自己的投影，不能把较新的面包屑覆盖为空。
        if (reportVersionRef.current === reportVersion) {
          onItemsChange([]);
        }
      };
    },
    [onItemsChange, sectionLabel],
  );

  return (
    <SettingsBreadcrumbContext.Provider value={report}>
      {children}
    </SettingsBreadcrumbContext.Provider>
  );
}

/**
 * 将 section 内既有页面状态和返回动作投影到 Settings 顶栏，但不拥有或持久化导航状态。
 */
// SettingsBreadcrumbReporter 不拥有也不持久化导航状态。
// onSelect 引用单独存 actionsRef，避免签名抖动。
// 上报签名只覆盖 label 序列，不含动作引用。
// 依赖不变时跳过重复上报。
export function SettingsBreadcrumbReporter({
  items,
  onSectionSelect,
}: {
  items: readonly SettingsBreadcrumbItem[];
  onSectionSelect?: () => void;
}) {
  const report = useContext(SettingsBreadcrumbContext);
  const actionsRef = useRef(items.map((item) => item.onSelect));
  const sectionActionRef = useRef(onSectionSelect);
  actionsRef.current = items.map((item) => item.onSelect);
  sectionActionRef.current = onSectionSelect;
  const signature = JSON.stringify(items.map((item) => item.label));

  useEffect(() => {
    const labels = JSON.parse(signature) as string[];
    const dispose = report?.({
      items: labels.map((label, index) => ({
        label,
        onSelect: actionsRef.current[index] ? () => actionsRef.current[index]?.() : undefined,
      })),
      onSectionSelect: sectionActionRef.current ? () => sectionActionRef.current?.() : undefined,
    });
    return dispose;
  }, [report, signature]);

  return null;
}

export function SettingsHeaderBreadcrumb({
  ariaLabel,
  className,
  items,
}: {
  ariaLabel: string;
  className?: string;
  items: readonly SettingsBreadcrumbItem[];
}) {
  if (items.length < 2) return null;

  return (
    <nav
      aria-label={ariaLabel}
      className={cn(
        "pointer-events-none flex h-full min-w-0 items-center overflow-hidden px-2.5",
        className,
      )}
    >
      <ol className="flex min-w-0 items-center gap-0 overflow-hidden text-ui-base/relaxed">
        {items.map((item, index) => {
          const current = index === items.length - 1;
          return (
            <li key={`${index}:${item.label}`} className="flex min-w-0 items-center gap-0">
              {index > 0 ? (
                <ChevronRight
                  aria-hidden="true"
                  className="size-3.5 shrink-0 text-foreground-subtlest"
                  data-testid="settings-breadcrumb-separator"
                />
              ) : null}
              {current || !item.onSelect ? (
                <span
                  aria-current={current ? "page" : undefined}
                  className={cn(
                    "truncate",
                    current ? "px-2 text-foreground" : "text-foreground-subtle",
                  )}
                >
                  {item.label}
                </span>
              ) : (
                <Button
                  type="button"
                  variant="ghost"
                  size="default"
                  data-testid={
                    index === 0 ? "settings-breadcrumb-section" : "settings-breadcrumb-item"
                  }
                  className="pointer-events-auto min-w-0 shrink text-foreground-subtle hover:text-foreground [app-region:no-drag]"
                  onClick={item.onSelect}
                >
                  <span className="truncate">{item.label}</span>
                </Button>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
