// MarketingTouchProvider：营销触达（Banner 与活动弹窗）在 UI 侧的装配点，负责把营销服务、平台能力、
// 国际化与导航入口注入控制器，并托管轮询与副作用生命周期；弹窗状态机与可见性仲裁在 marketingTouchController，
// 素材准备与释放策略在 marketingResources，导航落地在 marketingNavigation，本文件不重复实现这些规则。
//
// INV-01 断言：restoring 期间不得创建运行时 —— 守住它的位置：createRuntime 首个 return null —— 改错故障：OAuth 恢复期按匿名态拉取活动，登录后二次弹窗
// INV-02 断言：poller 必须先 let 声明、在 controller 之后赋值，任何 refresh 调用都要在赋值之后 —— 守住它的位置：createRuntime 的 let poller 与 poller = 赋值 —— 改错故障：首帧点击触发 refresh 读到未初始化值，Banner 点击静默无响应
// INV-03 断言：素材释放必须幂等，且成功与失败两条路径共用同一个 release —— 守住它的位置：released 标志与 catch 里的 void release —— 改错故障：blob URL 泄漏，长会话内存持续上涨
// INV-04 断言：close 动作直接返回 cancelled，不得进入导航或领取分支 —— 守住它的位置：execute 开头的 action.type 判断 —— 改错故障：关闭按钮被当成领取，误发权益申请
// INV-05 断言：claim 提交前后必须用 submitted 区分 uncertain 与 failure —— 守住它的位置：submitted 标志与 execute 尾部 catch —— 改错故障：断网被判确定失败，用户重复领取或放弃已到账权益
// INV-06 断言：领取成功后的本地刷新失败不得改写成功结果 —— 守住它的位置：Promise.allSettled 后置刷新 —— 改错故障：权益已到账却提示失败，用户重复点击
// INV-07 断言：terminal 码集合与服务端语义绑定，不得随手增删 —— 守住它的位置：result.code 的 includes 判断 —— 改错故障：可重试错误被标成终态，用户失去重试入口
// INV-08 断言：未登录点击领取只触发登录并返回 cancelled —— 守住它的位置：execute 中 if (!user) 分支 —— 改错故障：未登录弹操作失败红条，污染转化漏斗
// INV-09 断言：打开升级弹窗的 signal 必须随外层 abort 一并中止 —— 守住它的位置：abortOpening 与 finally —— 改错故障：Banner 已切走后回调仍执行，导航请求悬挂
// INV-10 断言：插件市场必须先发打开事件再退出设置并激活原工作区 —— 守住它的位置：requestPluginStoreOpen 之后的 activateTabByPath —— 改错故障：市场挂在设置层之下，用户看到空白页
// INV-11 断言：Banner 可见性谓词必须与仲裁层共用 isMarketingBannerRenderable —— 守住它的位置：ConnectedBanner 的提前 return —— 改错故障：两处判断漂移，底部活动位与 Banner 同时出现
// INV-12 断言：请求校验预热只对含可领取动作的 Banner 开启 —— 守住它的位置：useRequestVerificationPrewarm 的布尔表达式 —— 改错故障：纯图片 Banner 也跑校验，产生无意义请求与首点延迟
// INV-13 断言：effect 清理必须把 observer、监听器、poller、controller 全部释放 —— 守住它的位置：useEffect 的 return —— 改错故障：切账号重建运行时后旧 poller 仍在轮询，请求翻倍
// INV-14 断言：控制器 Context 允许为 null，消费方必须容忍未就绪 —— 守住它的位置：Context.Provider 的 runtime?.controller —— 改错故障：首帧渲染空转，侧栏仲裁取到 undefined 后崩溃
//
// 装配原则：业务判定全部下沉到 controller 与 poller，本文件只做能力注入与副作用编排；
// 跨渲染期取值一律走 ref 镜像（upgradeTargetRef / openRewardsRef / refreshStartEntitlementRef），
// 否则这些值进依赖数组会让 createRuntime 反复重建，正在展示的弹窗被卸载、轮询被打断。
//
// 失败语义：execute 只回 cancelled / success / failure / uncertain 四态，上层按 uncertain 给重试文案。
import {
  prepareRequestVerificationClaim,
  useRequestVerificationPrewarm,
} from "@/request-security-edition/claim.js";
import { requestVerificationClaimFailureMessageId } from "@/request-security-edition/errors.js";
import { useStartPlanEntitlement } from "@/hooks/useStartPlanEntitlement.js";
import { createContext, useContext, useEffect, useCallback, useState, useRef } from "react";
import type { ReactNode } from "react";
import { useStore } from "zustand";
import { useCodingPlanUpgradeDialog } from "@/settings/CodingPlanUpgradeDialogProvider.js";
import { useOpenRewards } from "@/rewards/RewardsProvider.js";
import { useWorkspaceSidebarFooterUsageSummaryState } from "@/WorkspaceSidebarFooterUsageSummary.js";
import { useTabStore, useTabStoreApi } from "@/store/TabStoreProvider.js";
import { setPendingSettingsSectionIntent } from "@/lib/settingsNavigation.js";
import { requestPluginStoreOpen } from "@/lib/pluginStoreNavigation.js";
import {
  requestMarketingNavigation,
  marketingNavigation,
  finishMarketingNavigation,
  marketingSettingsSections,
  waitForMarketingCapability,
} from "@/lib/marketingNavigation.js";
import { BUILTIN_MODEL_PROVIDER_IDS, ZCODE_ENV } from "@zcode/shared";
import { useServices } from "@/hooks/useServices.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeStore } from "@/store/StoreProvider.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useCloudHeroEnvironment } from "@/components/cloud-content-dialog/useCloudHeroEnvironment.js";
import { MarketingDialogs } from "@/components/marketing-touch/MarketingDialogs.js";
import { toast } from "@/components/ui/toast.js";
import { logger } from "@/logger.js";
import { MarketingBannerView } from "@/components/marketing-touch/MarketingBanner.js";
import {
  canOpenMarketingPopup,
  marketingLabel,
} from "@/components/marketing-touch/marketingPopupAdapter.js";
import {
  createMarketingTouchController,
  isMarketingBannerRenderable,
  type MarketingTouchController,
} from "@/components/marketing-touch/marketingTouchController.js";
import {
  createMarketingTouchPoller,
  resolveMarketingTouchPollIntervalMs,
} from "@/components/marketing-touch/marketingTouchPoller.js";
import { prepareMarketingHero } from "@/components/marketing-touch/marketingResources.js";

import { MarketingRefreshContext } from "@/components/marketing-touch/useMarketingTaskCompletionRefresh.js";

// [契约] 控制器实例的唯一出口：Provider 未就绪时值为 null，消费方必须自行降级；
// null 表示运行时尚未建好，不表示当前没有活动——是否有内容由 controller 状态决定。
// 该 Context 还被导出给左下角活动仲裁层读取 Banner 可见性，改语义会连带影响侧栏。
const Context = createContext<MarketingTouchController | null>(null);

// 导出给左下角活动仲裁层（SidebarBottomActivity）读取 Banner 可见性；控制器仍是唯一 owner。
export { Context as MarketingTouchContext };

// [契约] desktop 描述宿主形态且参与下方依赖数组：切换形态会整体重建运行时，在途弹窗被丢弃，
// 因此它只应在应用启动时确定，不要做成随窗口尺寸变化的状态。
// children 始终挂载，Provider 只在旁边追加弹窗，不用条件包装包住 children，避免整棵业务树重挂。
export function MarketingTouchProvider({
  children,
  desktop,
}: {
  children: ReactNode;
  desktop: boolean;
}) {
  const services = useServices();
  const platform = usePlatform();
  const openSettingsTab = useTabStore((state) => state.openSettingsTab);
  const tabStore = useTabStoreApi();
  const { openCodingPlanUpgrade } = useCodingPlanUpgradeDialog();
  const workspacePath = useTabStore((state) => state.activeWorkspacePath);
  const workspaceIdentity = useTabStore((state) => state.activeWorkspaceIdentity);
  const { upgradeTargetProviderId } = useWorkspaceSidebarFooterUsageSummaryState({
    enabled: true,
    workspacePath: workspacePath ?? undefined,
    workspaceIdentity: workspaceIdentity ?? undefined,
  });
  // [并发] ref 镜像让 execute 读到最新的升级目标 Provider，同时避免把它放进 createRuntime 依赖：
  // 一旦进依赖，用量摘要的刷新就会重建 controller，正在展示的弹窗被卸载、轮询被打断。
  // 不要改成直接闭包捕获，闭包会冻结首次渲染时的值，升级时会打开错误的 Provider。
  const upgradeTargetRef = useRef(upgradeTargetProviderId);
  upgradeTargetRef.current = upgradeTargetProviderId;
  const user = useZCodeStore((state) => state.user);
  const restoring = useZCodeStore((state) => state.isRestoringOAuthSession);
  const requestLogin = useZCodeStore((state) => state.requestLoginEntry);
  const openRewards = useOpenRewards();
  // [契约] 同样必须走 ref 镜像：奖励面板的开入口来自另一层 Provider，标识可能随上层渲染变化，
  // 直接进依赖会连带重建整个营销运行时。
  const openRewardsRef = useRef(openRewards);
  openRewardsRef.current = openRewards;
  const { intl, locale } = useZCodeIntl();
  const startEntitlement = useStartPlanEntitlement(
    BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan,
    services.usageStatsService,
  );
  const refreshStartEntitlementRef = useRef(startEntitlement.refresh);
  refreshStartEntitlementRef.current = startEntitlement.refresh;
  // [契约] identity 未在 createRuntime 体内直接引用，但必须留在依赖数组里：
  // 它承担换账号即重建运行时的职责，删掉后 A 账号的 Banner 与待展示弹窗会残留给 B 账号。
  const identity = user?.id ?? "anonymous";
  // [契约] 运行时工厂：依赖变化时重建 controller 与 poller 这一对实例，二者生命周期严格绑定，
  // 不能只换其中一个，因为 controller 的 refresh 闭包持有 poller。
  // 返回 null 表示当前不应有任何营销行为（服务缺失或登录态恢复中），调用方需按无运行时处理。
  // 依赖数组只放稳定能力与身份，频繁变化的值一律走 ref 镜像，否则会打断正在展示的弹窗。
  const createRuntime = useCallback(() => {
    const service = services.marketingTouchService;
    if (!service || restoring) return null;
    // [并发] poller 必须在 controller 之后创建，但 controller 的 refresh 回调又要调 poller.refresh，
    // 于是只能先声明再赋值：controller 创建期间不会触发 refresh，赋值完成后才允许被调用。
    // 若改成前移创建，poller 的 query 会引用尚未初始化的 controller，直接抛错。
    // 点击 Banner 会立刻走到 refresh，这是唯一能暴露该顺序错误的地方。
    let poller: ReturnType<typeof createMarketingTouchPoller>;
    const controller = createMarketingTouchController({
      query: () => service.query({ locale }),
      report: (input) => service.report(input),
      locale,
      canOpen: canOpenMarketingPopup,
      refresh: () => poller.refresh(),
      prepare: async (delivery) => {
        const assets = services.cloudContentService;
        const visual =
          delivery.resource_position === "banner"
            ? delivery.banner.success_popup?.hero
            : delivery.popup.hero;
        const success = prepareMarketingHero(visual, assets, locale, desktop);
        const background =
          delivery.resource_position === "banner"
            ? prepareMarketingHero(delivery.banner.background, assets, locale, desktop)
            : undefined;
        // [资源] 素材准备会产出可释放句柄，release 必须幂等：
        // 正常交付后由弹窗关闭释放一次，准备失败时再释放一次，两条路径可能交叉，靠该标志只放行第一次。
        // 去掉这个标志会让同一素材被重复释放，或第二次释放抛错掩盖真实失败原因。
        let released = false;
        const release = async () => {
          if (!released) {
            released = true;
            await Promise.all([
              (async () => (await success).release())(),
              (async () => (await background)?.release())(),
            ]);
          }
        };
        if (delivery.resource_position === "banner") {
          try {
            if (!assets) throw new Error("marketing_resources_unavailable");
            const prepared = (await background)?.hero;
            if (!prepared) throw new Error("marketing_banner_unavailable");
            return {
              delivery,
              image: prepared.type === "image" ? prepared.src : undefined,
              darkImage: prepared.type === "image" ? prepared.darkSrc : undefined,
              bannerHero:
                prepared.type === "interactive_bundle" || prepared.type === "video"
                  ? prepared
                  : undefined,
              hero: null,
              success,
              release,
            };
          } catch (error) {
            // [失败路径] 准备失败时立刻释放另一份已拿到的素材（banner 的 background 与 success 是成对准备的），
            // 否则异常抛出后没有任何人再持有释放入口，素材随这次请求永久泄漏。
            void release();
            throw error;
          }
        }
        // [契约] 弹窗形态只需要主视觉，background 在上面被刻意跳过；
        // 返回的 release 由 controller 在弹窗关闭时调用，这里不要自行释放。
        const prepared = await success;
        return { delivery, hero: prepared.hero, release };
      },
      execute: async (action, signal, phase) => {
        // [契约] close 是控制器用来收尾的合成动作，必须最先短路：
        // 落到后面任何分支都会触发导航或领取，等于把关闭按钮变成提交按钮。
        if (action.type === "close") return { status: "cancelled" };
        if (action.type === "navigate" || action.type === "copy_text") {
          try {
            // [并发] 每次 await 前后都要重新检查中止信号：动作可能在等待弹窗或剪贴板期间被取消，
            // 少了这一句就会在用户已切走后继续发请求或弹提示。
            signal.throwIfAborted();
            phase("submitting");
            if (action.type === "copy_text") {
              await waitForMarketingCapability(
                navigator.clipboard.writeText(action.args.text),
                signal,
                10_000,
              );
              signal.throwIfAborted();
              // [权衡] 复制成功只在没有弹窗时提示：弹窗内复制若也弹 toast，
              // 会和弹窗自身的成功态叠加成两条重复提示，用户以为触发了两次。
              // 这里用 getState 读实时状态而非闭包快照，保证判断的是此刻是否仍有弹窗。
              if (!controller.store.getState().dialog)
                toast(intl.formatMessage({ id: "manualClaimPlan.claim.share.copyTextSucceeded" }));
            } else if (action.args.page === "rewards") {
              // 只确认窗口级 Provider 接收意图；登录续接不依赖会在账号变化时销毁的营销实例。
              if (!openRewardsRef.current) throw new Error("marketing_navigation_unavailable");
              await openRewardsRef.current();
            } else {
              const opening = new AbortController();
              const abortOpening = () => opening.abort();
              // [并发] 外层信号与升级弹窗内部信号需要桥接：
              // 营销动作被取消（切换 Banner、运行时重建）时要连带中止已打开的弹窗流程，
              // 否则 onResult 会在弹窗卸载后才回调，finishMarketingNavigation 收到悬空结果。
              signal.addEventListener("abort", abortOpening, { once: true });
              try {
                await requestMarketingNavigation(action.args, signal, () => {
                  if (action.args.page === "upgrade") {
                    if (!desktop) throw new Error("marketing_navigation_unavailable");
                    // [契约] 这里的非空断言依赖 requestMarketingNavigation 已登记本次请求，回调只会在登记之后被调用；
                    // 不要改成可选链后静默跳过，那会让升级入口在打开失败时永远等不到结果。
                    const requestId = marketingNavigation.getState().request!.id;
                    if (
                      !openCodingPlanUpgrade(
                        { providerId: upgradeTargetRef.current },
                        {
                          signal: opening.signal,
                          onResult: (opened) =>
                            finishMarketingNavigation(
                              requestId,
                              opened ? undefined : new Error("marketing_upgrade_unavailable"),
                            ),
                        },
                      )
                    )
                      throw new Error("marketing_upgrade_unavailable");
                    return;
                  }
                  if (action.args.page === "settings") {
                    if (action.args.section)
                      setPendingSettingsSectionIntent(
                        marketingSettingsSections[action.args.section],
                        { modelProviderId: action.args.provider_id },
                      );
                    openSettingsTab();
                  } else if (action.args.page === "plugin_marketplace") {
                    const tabs = tabStore.getState();
                    if (!tabs.activeWorkspacePath)
                      throw new Error("marketing_navigation_unavailable");
                    // [契约] 先发打开事件、再强制激活原工作区：市场渲染在工作区容器内，
                    // 只发事件会排在设置页之上，用户看到的是设置页而不是市场。
                    // 激活失败必须抛错，不能假装成功——否则弹窗关闭但什么都没打开。
                    requestPluginStoreOpen(action.args.plugin_id);
                    // 市场在工作区内；仅发事件会在设置层后挂载，必须退出设置并激活原工作区。
                    if (
                      !tabs.activateTabByPath(tabs.activeWorkspacePath, {
                        workspaceIdentity: tabs.activeWorkspaceIdentity ?? undefined,
                      })
                    )
                      throw new Error("marketing_navigation_unavailable");
                  }
                });
              } finally {
                // [资源] 无论成功失败都要摘掉 abort 监听并中止内层信号：
                // 漏掉移除会让外层信号一直持有已结束的打开流程，长会话下监听器持续累积。
                signal.removeEventListener("abort", abortOpening);
                opening.abort();
              }
            }
            return { status: "success" };
          } catch (error) {
            // [失败路径] 这里把技术错误翻译成控制器认识的四态：超时算 uncertain（可能已执行），
            // 其余算 failure；外层已取消时一律 cancelled，避免给用户看无意义的失败文案。
            // 不要在这里直接 toast，提示由控制器按状态统一渲染，否则会和重试入口重复。
            const timedOut =
              error instanceof Error && error.message === "marketing_capability_timeout";
            if (!signal.aborted)
              logger.warn("[marketing-touch] capability failed", {
                action: action.type,
                reason: timedOut ? "timeout" : "unavailable",
              });
            return {
              status: signal.aborted ? "cancelled" : timedOut ? "uncertain" : "failure",
              message: intl.formatMessage({
                id: timedOut ? "marketingTouch.uncertain" : "marketingTouch.failed",
              }),
            };
          }
        }
        // [失败路径] 外部链接走平台层打开，失败只回 failure 且不带技术细节；
        // 不要改成 window.open，桌面壳里会开出无权限的内嵌窗。
        if (action.type === "open_url") {
          try {
            await platform.openExternal(action.args.url);
            return { status: "success" };
          } catch {
            return {
              status: "failure",
              message: intl.formatMessage({ id: "marketingTouch.failed" }),
            };
          }
        }
        // [契约] 未登录时领取只发起登录并回 cancelled，而不是 failure：
        // 登录不是错误，标成 failure 会在漏斗里造出假的失败率，也会弹错误的红条。
        // 登录成功后由运行时重建重新拉取活动，这里不要缓存 delivery 去续跑。
        if (!user) {
          requestLogin();
          return { status: "cancelled" };
        }
        // [契约] submitted 记录 claim 请求是否已经发出，是 uncertain 与 failure 的唯一分界：
        // 发出前失败意味着确定没领到，可安全重试；发出后异常意味着服务端可能已受理，只能提示不确定。
        // 必须在调用 claimManualPlan 之前置真，写到 await 之后等于永远读不到。
        // 不要改成 try 内部的局部变量，catch 里拿不到它。
        let submitted = false;
        try {
          const proof = await prepareRequestVerificationClaim(
            services.codingPlanSubscriptionService,
            signal,
            () => phase("verifying"),
          );
          // [失败路径] 校验凭据缺失属于用户可修复场景（取消验证或验证未通过），
          // 回 cancelled 并带上专用文案，不要计入通用失败。
          if (!proof)
            return {
              status: "cancelled",
              message: intl.formatMessage({ id: requestVerificationClaimFailureMessageId }),
            };
          phase("submitting");
          submitted = true;
          const result = await services.codingPlanSubscriptionService.claimManualPlan({
            planId: action.args.plan_id,
            ...proof,
          });
          signal.throwIfAborted();
          if (!result.success)
            return {
              status: "failure",
              // [契约] 这组码来自服务端契约，表示不可重试（重复领取、资格不符等）：
              // 增删会直接改变结果弹窗上是否给出重试入口，服务端语义调整时必须同步这里。
              // 不要把网络类错误码并进来，否则一次抖动就把用户锁死在终态。
              terminal: [1001, 1002, 1003, 1004, 1005].includes(result.code),
              message: result.message?.trim()
                ? result.message
                : intl.formatMessage({ id: "manualClaimPlan.claim.failure.generic" }),
            };
          // 成功已由 claim 确定，后置刷新失败只影响本地权益投影，不能逆转领取结果。
          // [事务] 领取成功之后才做本地投影刷新，且用 allSettled 而非 all：
          // 任一刷新失败都不能把已确定的领取结果改写成失败，只能落日志。
          // 后置刷新必须 void 掉、不能 await，它慢不该阻塞结果弹窗，也不该延长请求时长。
          void Promise.allSettled([
            refreshStartEntitlementRef.current({ force: true, silent: true, reason: "purchase" }),
            // Provider 迁移后旧服务已不存在；统一刷新权威设置视图，不重建第二条凭据刷新链路。
            services.providerSettingsService.refresh("marketing-plan-claim"),
          ]).then((results) => {
            if (results.some((value) => value.status === "rejected"))
              logger.warn("[marketing-touch] claim succeeded but entitlement refresh failed");
          });
          // 领取结果由 Controller 的结果弹窗承载，避免成功 toast 与弹窗重复提示。
          return { status: "success" };
        } catch {
          if (signal.aborted) return { status: "cancelled" };
          return {
            status: submitted ? "uncertain" : "failure",
            message: intl.formatMessage({
              id: submitted ? "marketingTouch.uncertain" : "marketingTouch.failed",
            }),
          };
        }
      },
    });
    // [契约] 轮询器只负责节奏与可见性，真正的拉取逻辑在 controller.refresh 与 showPending：
    // query 里先 refresh 再 showPending，顺序颠倒会让新到内容多等一个周期才展示。
    // 轮询间隔由 `resolveMarketingTouchPollIntervalMs` 按 `PROD` 与 `ZCODE_ENV` 推导，测试与预发不得硬编码常量。
    poller = createMarketingTouchPoller({
      intervalMs: resolveMarketingTouchPollIntervalMs(import.meta.env.PROD, ZCODE_ENV),
      query: async () => {
        await controller.refresh();
        await controller.showPending();
      },
      visible: () => document.visibilityState !== "hidden",
    });
    return { controller, poller };
  }, [
    services,
    platform,
    identity,
    Boolean(user),
    restoring,
    locale,
    intl,
    requestLogin,
    desktop,
    openSettingsTab,
    tabStore,
    openCodingPlanUpgrade,
  ]);
  // [契约] runtime 用 state 持有而非 ref：Context 与弹窗需要在其就绪后重渲染，
  // 用 ref 会导致首帧拿不到 controller 且不触发更新。
  const [runtime, setRuntime] = useState<ReturnType<typeof createRuntime>>(null);
  useEffect(() => {
    // [契约] 每次 createRuntime 变化都先建新实例再整体替换，旧实例在清理函数里销毁；
    // 不要在这里做复用旧实例的优化，会跨账号串数据。
    const runtime = createRuntime();
    setRuntime(runtime);
    if (!runtime) return;
    const { controller, poller } = runtime;
    const visibility = () => {
      poller.visibilityChanged();
      void controller.showPending();
    };
    const online = () => poller.refresh();
    // [资源] 观察宿主 DOM 结构变化后重新尝试展示待弹内容，用来兜住异步插入的挂载点；
    // showPending 内部已做幂等与可见性判断，所以可以高频触发，错误必须吞掉，不能让观察回调抛出。
    // 只观察 body 且限定 childList 与 subtree，属性观察会被动画帧把回调打爆。
    const observer = new MutationObserver(() => {
      void controller.showPending().catch(() => {});
    });
    observer.observe(document.body, { childList: true, subtree: true });
    // [并发] 可见性与在线状态变化都要主动补拉：页面隐藏期间轮询被跳过，
    // 不做这两个监听就会在切回前台后长时间展示过期活动。
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("online", online);
    poller.refresh();
    // [资源] 清理顺序不可交换：先断开观察与监听，再 dispose poller 停掉定时器，
    // 最后 dispose controller，反过来会在停表期间仍有回调打到已销毁的控制器上。
    // 缺任一项都会在热更新或切账号后留下幽灵轮询，表现为接口请求翻倍。
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("online", online);
      poller.dispose();
      controller.dispose();
    };
  }, [createRuntime]);
  return (
    <Context.Provider value={runtime?.controller ?? null}>
      <MarketingRefreshContext.Provider value={runtime?.poller.refresh ?? null}>
        {children}
      </MarketingRefreshContext.Provider>
      {runtime ? <MarketingDialogs controller={runtime.controller} /> : null}
    </Context.Provider>
  );
}

// [契约] 该组件刻意独立导出：它挂在布局层，必须容忍 Context 为空并返回 null，
// 不要在这里抛错或回退默认内容，Banner 是否出现完全由 controller 状态决定。
export function MarketingBanner() {
  const controller = useContext(Context);
  return controller ? <ConnectedBanner controller={controller} /> : null;
}
function ConnectedBanner({ controller }: { controller: MarketingTouchController }) {
  const state = useStore(controller.store);
  const { dark } = useCloudHeroEnvironment();
  const { intl, locale } = useZCodeIntl();
  const banner = state.banner;
  // [契约] 预热条件必须与真正可领取的分支严格一致：有图或有 hero，且存在非 close 的 claim 动作；
  // 条件放宽会让纯展示 Banner 也发起校验请求，条件收紧则首次点击仍要等校验，延迟可感知。
  // 这里的 find 只取第一个非 close 按钮，与下方渲染取 action 的口径一致，改动需两处同步。
  // 预热属于纯性能优化，判断偏差不影响正确性，但不能因此改成无条件调用。
  useRequestVerificationPrewarm(
    Boolean(
      banner?.delivery.resource_position === "banner" &&
      (banner.image || banner.bannerHero) &&
      banner.delivery.banner.buttons.find((button) => button.action.type !== "close")?.action
        .type === "claim_zcode_plan",
    ),
  );
  // 与仲裁层（SidebarBottomActivity）共用同一可见性谓词，避免两处判断漂移。
  // [契约] 可见性判定必须复用同一个谓词，禁止在这里另写一套条件：
  // 左下角活动仲裁层用同一函数决定是否让位，两套写法一旦漂移就会出现 Banner 与活动位重叠。
  if (!isMarketingBannerRenderable(banner)) return null;
  const buttons = banner.delivery.banner.buttons;
  // [契约] 按钮语义按 action.type 判定而非文案：文案可能为空或是运营占位符，
  // 用文案推断动作在多语言下必然失效；close 单独取，不能默认第二个按钮就是关闭。
  const action = buttons.find((button) => button.action.type !== "close");
  const close = buttons.find((button) => button.action.type === "close");
  return (
    <MarketingBannerView
      src={dark && banner.darkImage ? banner.darkImage : banner.image}
      bundle={banner.bannerHero?.type === "interactive_bundle" ? banner.bannerHero : undefined}
      video={banner.bannerHero?.type === "video" ? banner.bannerHero : undefined}
      locale={locale}
      // 纯图片 Banner 允许空文案；动作是否存在不能由标签决定。
      hasAction={Boolean(action)}
      hasClose={Boolean(close)}
      actionLabel={
        (action && marketingLabel(action.text).trim()) || intl.formatMessage({ id: "common.open" })
      }
      closeLabel={
        (close && marketingLabel(close.text).trim()) || intl.formatMessage({ id: "common.close" })
      }
      pending={state.pending}
      pendingLabel={intl.formatMessage({ id: `marketingTouch.${state.phase}` })}
      onClick={() => {
        void controller.clickBanner().catch(() => logger.warn("[marketing-touch] action failed"));
      }}
      onClose={() => {
        void controller.closeBanner();
      }}
    />
  );
}
