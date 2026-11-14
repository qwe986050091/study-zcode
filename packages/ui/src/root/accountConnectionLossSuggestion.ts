// INV-01 只给建议不落盘：守住位置 返回对象中的应用函数；改错故障 打开建议即改配置。
// INV-02 家庭域与原始选择必须存在：守住位置 早退条件；改错故障 无选择时误算目标。
// INV-03 起始套餐不参与切换：守住位置 种类判断；改错故障 从试用套餐跳到个人套餐。
// INV-04 目标提供方必须匹配失效事件：守住位置 解析比较；改错故障 建议切到无关提供方。
// INV-05 事件过期即放弃：守住位置 当前性检查；改错故障 提示指向已复原的连接。
// INV-06 原始连接必须仍不可用：守住位置 状态三元；改错故障 已恢复仍建议切换。
// INV-07 连接键参与比较：守住位置 字段比较；改错故障 重连后旧建议仍生效。
// INV-08 可用性按选择类型分流：守住位置 种类分支；改错故障 团队权益被个人判断覆盖。
// INV-09 团队按组织与项目精确查询：守住位置 查询参数；改错故障 团队名单存在即误判。
// INV-10 个人套餐优先：守住位置 首个判断；改错故障 优先跳到团队导致越权。
// INV-11 与原始选择相同即跳过：守住位置 序列化比较；改错故障 建议原地不动。
// INV-12 首个可用即停止：守住位置 循环内中断；改错故障 继续请求拖慢提示。
// INV-13 应用只允许一次：守住位置 运行与已应用标记；改错故障 连点两次切换两次。
// INV-14 应用前重新校验：守住位置 刷新后判断；改错故障 用陈旧视图写入。
// INV-15 写入带版本前置条件：守住位置 乐观锁参数；改错故障 并发改动被静默覆盖。
// INV-16 刷新失败不改写结果：守住位置 捕获分支；改错故障 已保存被提示成失败。
// INV-17 结果三态明确：守住位置 返回类型；改错故障 调用方无法区分过期与成功。
// INV-18 目标选择闭包固定：守住位置 局部常量；改错故障 闭包读取到后续变化。
//
// 模块职责：账号连接失效时推导可切换的套餐目标，并提供幂等的应用动作。
// 状态所有权：函数内只有运行与已应用两个局部标记，配置仍由服务持久化。
// 阅读顺序：先看入口条件与原始校验，再看候选查找，最后看应用动作。
import type { IServiceAccessor, ProviderSettingsView } from "@zcode/services";
import type { ProviderFamilyConnectionSelection } from "@zcode/shared";
import type { AccountConnectionLoss } from "@/root/accountConnectionRefreshObserver.js";
import {
  resolveFirstSubscribedTeamPlanConnectionWithContext,
  resolveModelProviderFamilyConnectionProviderId,
} from "@/lib/modelProviderFamilyConnectionSelection.js";
import { hasActiveUsageEntitlementSnapshot } from "@/lib/codingPlanProvider.js";
import { getEnterprisePricingProducts } from "@/root/oauthTeamPricing.js";
import { logger } from "@/logger.js";

/** 只计算建议，不替用户保存；闭包固定按钮展示的那个目标，点击时重新校验。 */
// prepareAccountConnectionSwitch() 只返回建议，不替用户写入 settings。
// providerFamilyDomain 与 providerFamilyConnectionSelections 缺一即 return null。
// resolveModelProviderFamilyConnectionProviderId() 的结果必须等于 event.providerId。
// providerFamilyDomainUpdatedAt 取 settings 当前值，缺失时用 0 兜底。
// event.isCurrent() 为假说明事件已过期，不再计算。
export async function prepareAccountConnectionSwitch(
  services: IServiceAccessor,
  event: AccountConnectionLoss,
) {
  const settings = await services.settingService.get();
  const family = settings.providerFamilyDomain;
  const original = family && settings.providerFamilyConnectionSelections?.[family];
  if (!family || !original || original.kind === "start-plan" || !event.isCurrent()) return null;
  if (
    resolveModelProviderFamilyConnectionProviderId({
      providerFamilyDomain: family,
      selection: original,
    }) !== event.providerId
  )
    return null;
  const expected = {
    providerFamilyDomain: family,
    providerFamilyConnectionSelections: settings.providerFamilyConnectionSelections,
    // 原因：相同身份重选不会改变映射，迟到操作仍须按锁内版本拒绝。
    providerFamilyDomainUpdatedAt: settings.providerFamilyDomainUpdatedAt ?? 0,
  };
  // isOriginal() 要求原始连接仍是当前且 availability === "unavailable"。
  // event.isCurrent() / state.current / connectionKey / availability 四项必须全真。
  // connectionKey 参与比较，防止已重连的连接被误判。
  // isAvailable() 按 selection.kind 分流判断。
  // 团队选择由 getEnterprisePricingProducts() 按组织与项目精确查询。
  const isOriginal = (view: ProviderSettingsView) => {
    const state = view.providers.find((p) => p.providerId === event.providerId)?.accountState;
    return (
      event.isCurrent() &&
      state?.current === true &&
      state.connectionKey === event.connectionKey &&
      state.availability === "unavailable"
    );
  };
  const view = await services.providerSettingsService.getView();
  if (!isOriginal(view)) return null;
  const isAvailable = async (
    selection: ProviderFamilyConnectionSelection,
    snapshot: ProviderSettingsView,
  ) => {
    const providerId = resolveModelProviderFamilyConnectionProviderId({
      providerFamilyDomain: family,
      selection,
    });
    if (selection.kind !== "team-coding-plan")
      return (
        snapshot.providers.find((p) => p.providerId === providerId)?.accountState?.availability ===
        "available"
      );
    // 未选中的 Team 没有可复用的 current 事实。按按钮的具体组织/项目查询，
    // 不能把团队名单存在或另一个 Team 的权益当成目标可用。
    const { kind: planKind, ...identity } = selection;
    const entitlement = await services.usageStatsService.getEntitlementSnapshot({
      preferredProviderId: providerId,
      includeSubscription: true,
      accountAccess: { type: "zhipu-account", family, planKind, ...identity },
      allowDisabledPreferredProvider: true,
      requirePreferredProvider: true,
      allowEnvApiKey: false,
    });
    return hasActiveUsageEntitlementSnapshot(entitlement, providerId);
  };
  // 先试 { kind: "individual-coding-plan" }，个人套餐优先。
  // 团队产品逐个遍历 pricing.productList 展开。
  // 与 original 相同的候选跳过。
  // 找到第一个 isAvailable 为真的候选即停止。
  let selection: ProviderFamilyConnectionSelection | undefined;
  let label: string | undefined;
  if (await isAvailable({ kind: "individual-coding-plan" }, view))
    selection = { kind: "individual-coding-plan" };
  if (!selection) {
    const pricing = await getEnterprisePricingProducts(services, family);
    if (pricing.status === "success") {
      for (const product of pricing.productList) {
        const contexts = product.teamProjects?.length ? product.teamProjects : [product];
        for (const context of contexts) {
          const candidate = resolveFirstSubscribedTeamPlanConnectionWithContext({
            teamProducts: [{ ...product, teamProjects: [], ...context }],
          });
          if (!candidate || JSON.stringify(candidate) === JSON.stringify(original)) continue;
          if (await isAvailable(candidate, view)) {
            selection = candidate;
            label =
              context.organizationName?.trim() ||
              context.projectName?.trim() ||
              candidate.organizationId;
            break;
          }
        }
        if (selection) break;
      }
    }
  }
  if (!selection || !event.isCurrent()) return null;
  const target = selection;
  let running = false;
  let applied = false;
  return {
    selection: target,
    label,
    async apply(): Promise<"switched" | "stale"> {
      if (running || applied || !event.isCurrent()) return "stale";
      running = true;
      try {
        const latest = await services.providerSettingsService.refresh(
          "account-connection-switch-confirm",
        );
        if (!isOriginal(latest) || !(await isAvailable(target, latest)) || !event.isCurrent())
          return "stale";
        await services.settingService.update(
          {
            providerFamilyConnectionSelections: {
              ...settings.providerFamilyConnectionSelections,
              [family]: target,
            },
          },
          expected,
        );
        applied = true;
        try {
          await services.providerSettingsService.refresh("account-connection-switched");
        } catch (error) {
          // 写入已完成，刷新失败不能把结果伪装成未保存；后续正常刷新继续收敛。
          logger.lifecycle.warn("[AccountConnection] 连接已保存，刷新暂未完成", { error });
        }
        return "switched";
      } finally {
        running = false;
      }
    },
  };
}
