// INV-01 登录入口按条件出现：守住位置 三条件与运算；改错故障 已购买仍显示登录按钮。
// INV-02 未连接与不可用都需登录：守住位置 或运算；改错故障 失效状态看不到入口。
// INV-03 回调缺失即不渲染：守住位置 条件判断；改错故障 出现点击无反应的按钮。
// INV-04 已购买不给断开：守住位置 否定条件；改错故障 付费用户误断连接。
// INV-05 两个加载态各自独立：守住位置 两个禁用属性；改错故障 一个请求锁住另一按钮。
// INV-06 等待态给旋转图标：守住位置 条件渲染；改错故障 用户以为没有响应。
// INV-07 文案键由调用方给定：守住位置 入参；改错故障 两处入口文案耦合。
// INV-08 提供方名注入文案：守住位置 格式化参数；改错故障 按钮出现未替换占位符。
// INV-09 升级入口只切面板：守住位置 点击处理；改错故障 直接跳登录丢失购买流程。
// INV-10 展开态换返回箭头：守住位置 三元图标；改错故障 收起态显示返回。
// INV-11 折扣高亮仅限未展开：守住位置 布尔合成；改错故障 展开后仍高亮主按钮。
// INV-12 折扣配置可缺席：守住位置 可选属性；改错故障 无折扣时渲染空徽标。
// INV-13 折扣说明与按钮同层：守住位置 外层容器；改错故障 说明被裁进按钮内部。
// INV-14 布局不换行压缩：守住位置 收缩与间距类；改错故障 小屏把按钮压成两行。
// INV-15 尺寸档位统一：守住位置 尺寸属性；改错故障 两个入口高度不一致。
// INV-16 语义属性完整：守住位置 按钮类型；改错故障 表单内触发提交。
// INV-17 组件不读全局设置：守住位置 无服务调用；改错故障 展示逻辑依赖远端状态。
// INV-18 文案覆盖只影响本入口：守住位置 默认参数；改错故障 覆盖值泄漏到其他按钮。
//
// 模块职责：套餐卡片底部状态动作，含登录、断开与升级面板切换。
// 状态所有权：无状态；连接态、加载态与回调都由调用方注入。
// 阅读顺序：先看状态动作的四组按钮，再看升级动作的折扣分支。
import { CodingPlanEntryButton } from "@/settings/CodingPlanEntryButton.js";
import type { CodingPlanBillingDiscountConfig } from "@zcode/shared";
import { ArrowLeftIcon, Loader2Icon, RocketIcon } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import {
  CodingPlanBillingDiscountBadgePill,
  CodingPlanBillingDiscountInfoDialog,
} from "@/CodingPlanBillingDiscount.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { CodingPlanLoginOptions } from "./codingPlanPricingCards.js";

// 登录按钮只在 loginVisible 为真时出现。
// isDisconnected || isUnavailable 都归入需要登录的状态。
// canDisconnectProvider && !isPurchased 才渲染断开按钮。
// loginLoading 与 disconnectLoading 各自控制自己的 disabled。
// 按钮文案取 loginButtonId，不在组件内写死。
export function CodingPlanStatusActions({
  providerName,
  isDisconnected,
  isUnavailable,
  isPurchased,
  loginLoading,
  loginButtonId,
  loginVisible,
  canDisconnectProvider,
  disconnectLoading,
  onLogin,
  onDisconnect,
}: {
  providerName: string;
  isDisconnected: boolean;
  isUnavailable: boolean;
  isPurchased: boolean;
  loginLoading?: boolean;
  loginButtonId: string;
  loginVisible: boolean;
  canDisconnectProvider: boolean;
  disconnectLoading?: boolean;
  onLogin?: (options?: CodingPlanLoginOptions) => void;
  onDisconnect?: () => void;
}) {
  const { intl } = useZCodeIntl();

  return (
    <div className="flex shrink-0 flex-wrap justify-start gap-2">
      {loginVisible && (isDisconnected || isUnavailable) && onLogin ? (
        <Button type="button" size="lg" onClick={() => onLogin()} disabled={loginLoading}>
          {loginLoading ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
          {intl.formatMessage({ id: loginButtonId }, { provider: providerName })}
        </Button>
      ) : null}
      {canDisconnectProvider && onDisconnect && !isPurchased ? (
        <Button
          type="button"
          variant="outline"
          size="lg"
          disabled={disconnectLoading}
          onClick={onDisconnect}
        >
          {disconnectLoading ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
          {intl.formatMessage({
            id: "settings.modelProvider.codingPlan.disconnect",
          })}
        </Button>
      ) : null}
    </div>
  );
}

// actionLabelId 默认 settings.modelProvider.codingPlan.upgrade，可被调用方覆盖。
// billingDiscountButtonActive 要求 billingDiscountActive === true 且面板未展开。
// billingDiscountConfig 是可选属性，缺省时不渲染徽标。
// upgradePlansVisible 由父层通过 onUpgradePlansVisibleChange 持有。
export function CodingPlanUpgradeAction({
  loginLoading,
  upgradePlansVisible,
  actionLabelId = "settings.modelProvider.codingPlan.upgrade",
  billingDiscountActive,
  billingDiscountConfig,
  onUpgradePlansVisibleChange,
}: {
  loginLoading?: boolean;
  upgradePlansVisible: boolean;
  actionLabelId?: string;
  billingDiscountActive?: boolean;
  billingDiscountConfig?: CodingPlanBillingDiscountConfig;
  onUpgradePlansVisibleChange: (visible: boolean) => void;
}) {
  const { intl } = useZCodeIntl();
  const billingDiscountButtonActive = billingDiscountActive === true && !upgradePlansVisible;

  // onClick() 只切换 upgradePlansVisible，不直接调用登录。
  // loginLoading 期间渲染 Loader2Icon，提示请求正在进行。
  // upgradePlansVisible 为真时图标换成 ArrowLeftIcon。
  // CodingPlanBillingDiscountBadgePill 只在 billingDiscountButtonActive 时挂载。
  const upgradeButton = (
    <CodingPlanEntryButton
      bypassGate={upgradePlansVisible}
      type="button"
      size="lg"
      className={cn(
        billingDiscountButtonActive &&
          "button-gradient dark:bg-[#484A58] text-white hover:bg-transparent hover:opacity-90 dark:hover:bg-[#484A58] pr-[5px] rounded-full",
      )}
      onClick={() => {
        // 购买/升级入口必须先打开面板，OAuth 失效恢复由面板在用户选择
        // plan/周期后处理，避免点击 Upgrade 直接跳登录导致用户看不到购买流程。
        onUpgradePlansVisibleChange(!upgradePlansVisible);
      }}
      disabled={loginLoading}
    >
      {loginLoading ? (
        // Upgrade 可能先触发 OAuth 业务 token 刷新。
        // 等待期间只有 disabled 没有 spinner，用户会误以为点击没有响应。
        <Loader2Icon className="size-3.5 animate-spin" />
      ) : upgradePlansVisible ? (
        <ArrowLeftIcon className="size-3.5" />
      ) : (
        <RocketIcon className="size-3.5" />
      )}
      {intl.formatMessage({
        id: upgradePlansVisible
          ? "settings.modelProvider.codingPlan.cancelUpgrade"
          : actionLabelId,
      })}
      {billingDiscountButtonActive ? (
        <CodingPlanBillingDiscountBadgePill
          config={billingDiscountConfig}
          iconVisible={false}
          variant="surface"
        />
      ) : null}
    </CodingPlanEntryButton>
  );

  if (!billingDiscountButtonActive) {
    return upgradeButton;
  }

  return (
    <div className="inline-flex shrink-0 items-center gap-1">
      {upgradeButton}
      <CodingPlanBillingDiscountInfoDialog config={billingDiscountConfig} />
    </div>
  );
}
