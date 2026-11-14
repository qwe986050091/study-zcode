// INV-01 布局只做排版：守住位置 组件体；改错故障 设置页自行取服务或管状态。
// INV-02 加载态由两路合并：守住位置 shouldShowModelProviderRefreshLoading；改错故障 只等预设或只等自定义。
// INV-03 刷新按钮文案跟加载切换：守住位置 refreshLabel 三元；改错故障 转圈时仍显示「刷新」。
// INV-04 新增入口唯一：守住位置 SettingsResourceHeaderActions；改错故障 头部出现两个添加入口。
// INV-05 分栏比例固定：守住位置 grid-cols 两档；改错故障 窄屏导航挤占详情宽度。
// INV-06 导航列独立滚动：守住位置 data-model-provider-navigation-scroll；改错故障 长供应商列表拖走整页。
// INV-07 详情列独立滚动：守住位置 data-model-provider-detail-scroll；改错故障 切换供应商后焦点位置丢失。
// INV-08 详情底部留白：守住位置 pb-20 / sm:pb-24；改错故障 最后一个字段被浮层遮挡。
// INV-09 反馈边界按节点重建：守住位置 key=selectedNodeKey；改错故障 切换供应商后错误横幅残留。
// INV-10 未选中用稳定占位键：守住位置 ?? "unselected-provider"；改错故障 空值导致边界反复重建。
// INV-11 点击回调原样下传：守住位置 onSelectNavItem；改错故障 布局层改写选中语义。
// INV-12 拖拽能力可选透传：守住位置 onReorderProviderIds；改错故障 不支持拖拽的调用方也拿到入口。
// INV-13 test id 集中引用：守住位置 TID_MODEL_PROVIDER_ADD_PROVIDER_BUTTON；改错故障 E2E 选择器漂移。
// INV-14 内容由调用方决定：守住位置 children；改错故障 布局层耦合具体供应商详情。
//
// 模块职责：模型供应商设置页的整体骨架，包含头部动作、左侧导航与右侧详情分栏。
// 阅读顺序：先看加载态合并，再看头部动作，最后看分栏与反馈边界。
import type { ReactNode } from "react";
import { TID_MODEL_PROVIDER_ADD_PROVIDER_BUTTON } from "@zcode/shared/test-ids";
import type { ModelProviderNavGroup } from "@/settings/model-provider-section/constants.js";
import { ModelProviderSectionNavigation } from "@/settings/model-provider-section/Navigation.js";
import { ProviderDetailFeedbackBoundary } from "@/settings/model-provider-section/ProviderDetailFeedback.js";
import { SettingsResourceHeaderActions } from "@/settings/SettingsResourceHeaderActions.js";

interface ModelProviderSectionLayoutProps {
  description: string;
  refreshLabel: string;
  loadingLabel: string;
  presetLoading: boolean;
  customLoading: boolean;
  onRefresh: () => void;
  addProviderLabel: string;
  onAddProvider: () => void;
  navigationGroups: ModelProviderNavGroup[];
  selectedNodeKey: string | null;
  onSelectNavItem: (item: ModelProviderNavGroup["items"][number]) => void;
  onReorderProviderIds?: (providerIds: string[]) => Promise<void>;
  reorderableProviderIds?: ReadonlySet<string>;
  children: ReactNode;
}

// shouldShowModelProviderRefreshLoading 在 presetLoading 或 customLoading 为真时返回 true，两路任一未就绪都要显示刷新。
export function shouldShowModelProviderRefreshLoading(params: {
  presetLoading: boolean;
  customLoading: boolean;
}): boolean {
  // 返回值取 presetLoading || customLoading 的或，因此只要预设还在加载按钮就保持转圈。
  return params.presetLoading || params.customLoading;
}

// 布局组件全部输入来自 props。
export function ModelProviderSectionLayout({
  description,
  refreshLabel,
  loadingLabel,
  presetLoading,
  customLoading,
  onRefresh,
  addProviderLabel,
  onAddProvider,
  navigationGroups,
  selectedNodeKey,
  onSelectNavItem,
  onReorderProviderIds,
  reorderableProviderIds,
  children,
}: ModelProviderSectionLayoutProps) {
  // refreshButtonLoading 在渲染期算一次并同时传给按钮与导航，避免两处各算一遍出现不一致。
  const refreshButtonLoading = shouldShowModelProviderRefreshLoading({
    presetLoading,
    customLoading,
  });

  return (
    // 外层 div 只带 space-y-4，横向对齐交给子组件的 flex 容器处理。
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <p className="text-ui-base leading-6 text-foreground-subtle">{description}</p>
        <SettingsResourceHeaderActions
          onRefresh={onRefresh}
          onNew={onAddProvider}
          refreshing={refreshButtonLoading}
          // 加载中文案可替换。
          refreshLabel={refreshButtonLoading ? loadingLabel : refreshLabel}
          newLabel={addProviderLabel}
          newTestId={TID_MODEL_PROVIDER_ADD_PROVIDER_BUTTON}
        />
      </div>

      <div className="overflow-clip rounded-xl border border-border bg-card">
        <div
          className="grid min-h-[36rem] grid-cols-[56px_minmax(0,1fr)] gap-0 md:grid-cols-[224px_minmax(0,1fr)]"
          // 分栏标记供 E2E 定位。
          data-model-provider-split-panel="true"
        >
          <div
            className="min-w-0 border-r border-border"
            // 导航列由 data-model-provider-navigation-scroll 标记独立滚动，详情列滚动时它保持原位。
            data-model-provider-navigation-scroll="true"
          >
            <ModelProviderSectionNavigation
              navigationGroups={navigationGroups}
              selectedNodeKey={selectedNodeKey}
              presetLoading={presetLoading}
              customLoading={customLoading}
              onSelectNavItem={onSelectNavItem}
              onReorderProviderIds={onReorderProviderIds}
              reorderableProviderIds={reorderableProviderIds}
            />
          </div>
          <div
            className="relative min-w-0 p-4 pb-20 sm:p-6 sm:pb-24"
            // 详情列由 data-model-provider-detail-scroll 标记独立滚动，底部留 pb-20 给浮动操作条让位。
            data-model-provider-detail-scroll="true"
          >
            <ProviderDetailFeedbackBoundary key={selectedNodeKey ?? "unselected-provider"}>
              {children}
            </ProviderDetailFeedbackBoundary>
          </div>
        </div>
      </div>
    </div>
  );
}
