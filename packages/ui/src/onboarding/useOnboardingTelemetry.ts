// INV-01 曝光只在可见时建立：守住位置 可见性判断；改错故障 隐藏态也上报曝光。
// INV-02 不可见立即清空记录：守住位置 清空赋值；改错故障 再次打开时复用旧曝光。
// INV-03 曝光只上报一次：守住位置 空值判断；改错故障 每步都重复曝光。
// INV-04 偏好快照拼接三项：守住位置 模板字符串；改错故障 无法判断偏好是否变化。
// INV-05 返回改模式后偏好访问失效：守住位置 双条件判断；改错故障 第三页被误判已访问。
// INV-06 非第三页时偏好变化也重置：守住位置 与运算；改错故障 中途改偏好仍带旧答案。
// INV-07 模式与偏好每次同步写回：守住位置 赋值顺序；改错故障 对比基准停留在首帧。
// INV-08 第一页标记模式已访问：守住位置 步骤比较；改错故障 上报模式为空。
// INV-09 第二页标记偏好已访问：守住位置 步骤比较；改错故障 上报偏好为空。
// INV-10 清理阶段不重置记录：守住位置 注释约束；改错故障 严格模式重放重复曝光。
// INV-11 退出回调由钩子缓存：守住位置 缓存包装；改错故障 父组件每次渲染都换引用。
// INV-12 退出时冻结当前答案：守住位置 闭包捕获；改错故障 延迟调用读到后续更改。
// INV-13 未访问字段上报空串：守住位置 三元分支；改错故障 用户未见选项却上报真值。
// INV-14 模式映射为办公与代码：守住位置 三元映射；改错故障 上报原始模式名。
// INV-15 职业缺失上报空串：守住位置 空值判断；改错故障 空职业映射出未定义。
// INV-16 退出步骤按一基计数：守住位置 加一运算；改错故障 步骤从零开始上报。
// INV-17 已结束或记录被替换则忽略：守住位置 三重判断；改错故障 重复点击产生两次结束。
// INV-18 上报成功后不再改写状态：守住位置 只读闭包；改错故障 点第二下重复上报。
//
// 模块职责：引导流程的曝光与结束埋点，含上报去重与答案冻结。
// 状态所有权：曝光记录与结束标记由本钩子的引用持有。
// 阅读顺序：先看职业映射，再看曝光副作用，最后看退出回调。
import { useCallback, useLayoutEffect, useRef } from "react";
import type { IPlatformService } from "@zcode/shared";
import type { InterfaceMode } from "@/lib/interfaceMode.js";
import type { OccupationValue } from "@/onboarding/occupationOptions.js";
import { reportAppTelemetryEvent } from "@/lib/appTelemetry.js";

// workDirections 把 OccupationValue 映射为上报用的软件行业分类值。
// Record<OccupationValue, string> 是穷尽映射，新增职业时 TS 会要求补全。
// occupation 为 null 时上报字面量 "null"，不猜一个默认行业。
const workDirections: Record<OccupationValue, string> = {
  developer: "software_data_ai",
  independent: "entrepreneurship_freelance_opc",
  infrastructure: "qa_operations_security",
  product: "product_project_solutions",
  design: "ui_ux_visual_design",
  student: "education_research",
  finance: "finance_accounting_consulting",
  creator: "media_content_creation",
  operations: "business_operations_ecommerce_customer_service",
  marketing: "marketing_brand_pr",
  legal: "legal_administration_hr",
  other: "other",
};

type ExitAction = "start" | "skip" | "close";
type Exposure = {
  ended: boolean;
  modeVisited: boolean;
  preferencesVisited: boolean;
  mode: InterfaceMode | null;
  preferenceValues: string;
};

/** 业务选择仍由引导组件持有；这里只记录本次真实展示范围和上报去重。 */
// memory、suggestions、migration 三个业务开关由引导组件持有，本钩子不落状态。
// exposure 只记录本次真实展示过的 mode 与 preferenceValues。
// exposure 用 useRef 持有，重渲染不会重置当次曝光。
// ended 标记放在 exposure.current 里，退出回调用它挡住重复上报。
export function useOnboardingTelemetry({
  platform,
  visible,
  step,
  occupation,
  mode,
  memory,
  suggestions,
  migration,
}: {
  platform: Pick<IPlatformService, "reportTelemetryEvent">;
  visible: boolean;
  step: 0 | 1 | 2;
  occupation: OccupationValue | null;
  mode: InterfaceMode | null;
  memory: boolean;
  suggestions: boolean;
  migration: boolean;
}) {
  const exposure = useRef<Exposure | null>(null);
  useLayoutEffect(() => {
    if (!visible) {
      exposure.current = null;
      return;
    }
    const preferenceValues = `${memory}:${suggestions}:${migration}`;
    if (!exposure.current) {
      exposure.current = {
        ended: false,
        modeVisited: false,
        preferencesVisited: false,
        mode,
        preferenceValues,
      };
      void reportAppTelemetryEvent(
        platform,
        {
          elementName: "onboarding_expose",
          eventRegion: "app.onboarding",
          eventType: "expose",
          eventText: "",
          eventExtraDetail: {},
        },
        "onboardingTelemetry",
      );
    }
    const current = exposure.current;
    // 返回改模式后旧偏好不再代表用户看到的选项；切回原模式也必须重新展示第三页。
    if (current.mode !== mode || (step !== 2 && current.preferenceValues !== preferenceValues)) {
      current.preferencesVisited = false;
    }
    current.preferenceValues = preferenceValues;
    current.mode = mode;
    if (step === 1) current.modeVisited = true;
    if (step === 2) current.preferencesVisited = true;
    // 不在 cleanup 重置：StrictMode 的 effect 重放不是一次新的产品曝光。
  }, [visible, step, mode, platform, memory, suggestions, migration]);

  // useCallback 闭包捕获点击瞬间的 occupation 与三个偏好开关。
  // 返回的退出回调在 ended 置位后直接 return，同一轮曝光只上报一次。
  // 重复点击命中 exposure.current.ended 时跳过 reportAppTelemetryEvent。
  return useCallback(
    (action: ExitAction, eventText: string) => {
      const current = exposure.current;
      const detail = {
        work_direction: occupation ? workDirections[occupation] : "null",
        ui_mode: current?.modeVisited && mode ? (mode === "office" ? "work" : "code") : "null",
        proactive_task_recommendations_enabled:
          current?.preferencesVisited && mode === "office" ? String(suggestions) : "null",
        workspace_memory_enabled: current?.preferencesVisited ? String(memory) : "null",
        claude_code_history_migration_selected: current?.preferencesVisited
          ? String(migration)
          : "null",
        exit_action: action,
        exit_step: String(step + 1),
      };
      // 点击时冻结文案与答案；仅保存成功后调用，不读被 skip 改写的 settings/record。
      return () => {
        if (!current || current.ended || exposure.current !== current) return;
        current.ended = true;
        void reportAppTelemetryEvent(
          platform,
          {
            elementName: "onboarding_end",
            eventRegion: "app.onboarding",
            eventType: "ck",
            eventText,
            eventExtraDetail: detail,
          },
          "onboardingTelemetry",
        );
      };
    },
    [platform, occupation, mode, memory, suggestions, migration, step],
  );
}
