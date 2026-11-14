/* oxlint-disable eslint(max-lines) */
/**
 * WelcomeScreen —— OAuth / API Key 登录入口
 *
 * 通过 useOAuth hook 驱动 OAuth 流程。
 */
// WelcomeScreen 是 OAuth / API Key 登录的唯一入口面板，把 useOAuth 的 idle / waiting / error
// 与 store 中的 oauthError、oauthSuccessSeq、loginEntryRequest 收敛成同一套视觉状态。
// 它只做展示与流程编排：凭据落盘、网络请求、OAuth 回调处理分别由 useOAuth 和 Root 层承担，本文件不解析回调参数。
//
// INV-01 断言：同一时刻只有 active 的面板在推进登录，非 active 时所有 effect 必须提前返回 —— 守住它的位置：LoginPanel 内每个 useEffect 首行的 active 判断 —— 改错故障：隐藏面板仍会消费 loginEntryRequest，再打开入口时请求已被吞掉。
// INV-02 断言：loginEntryRequest 按 id 幂等消费，先写 consumed 引用再清 store —— 守住它的位置：续接登录的 effect —— 改错故障：React 严格模式下同一请求发起两次 OAuth。
// INV-03 断言：oauthError 是 Root 层写入的事实，面板只负责显示与收敛 —— 守住它的位置：oauthError 收敛 effect 里的 reset 调用 —— 改错故障：失败提示块与渠道列表按钮同屏出现。
// INV-04 断言：reset 之后 pendingProvider 为 null，重试渠道必须回退到 lastAttemptProviderRef —— 守住它的位置：失败态重试按钮的 resolveLoginRetryProvider 入参 —— 改错故障：重试总是退回列表首个渠道而不是刚失败的渠道。
// INV-05 断言：activeLoginEntryAttemptRef 与 store 中的 attempt id 一一对应，完成时先清 ref 再上报 —— 守住它的位置：finishActiveLoginEntryAttempt —— 改错故障：重入导致同一 attempt 重复上报终态。
// INV-06 断言：不带 attempt id 的登录不参与购买意图跟踪 —— 守住它的位置：startTrackedLogin 的 loginEntryAttemptId 判空分支 —— 改错故障：普通登录覆盖掉后台续接的 waiting 状态。
// INV-07 断言：每次发起登录前必须清掉 store 里残留的 oauthError —— 守住它的位置：startTrackedLogin 开头的 setOAuthError 调用 —— 改错故障：等待提示与上一次的失败提示同时渲染。
// INV-08 断言：provider 成功判定必须 providerId 严格相等 —— 守住它的位置：shouldCompleteProviderLoginAttempt 的比较 —— 改错故障：A 渠道的成功关闭了 B 渠道的等待态。
// INV-09 断言：已有 user 只能在没有 in-flight attempt 时视为登录完成 —— 守住它的位置：shouldCompleteLoginFromExistingUser —— 改错故障：旧会话的 user 被当成新登录结果，面板瞬间关闭。
// INV-10 断言：成功信号按 oauthSuccessSeq 水位线比较，非 active 期间只推进水位 —— 守住它的位置：成功序列 effect 的分支 —— 改错故障：历史成功信号在重新打开面板时触发 onComplete。
// INV-11 断言：面板由 active 变为 false 时必须 cancel、reset、清错误、清请求、复位表单 —— 守住它的位置：wasActiveRef 下降沿 effect —— 改错故障：后台 OAuth 继续轮询，重开面板时状态残留。
// INV-12 断言：loginMode 必须随面板关闭回到 providers —— 守住它的位置：resetApiKeyForm —— 改错故障：下次打开入口直接停在 API Key 表单。
// INV-13 断言：onComplete 的 reason 只允许 oauth / apiKey / skip 三种 —— 守住它的位置：LoginCompleteReason 与三处调用点 —— 改错故障：上层无法区分保存密钥与显式跳过。
// INV-14 断言：渠道排序只影响展示顺序，不改变 providers 的原始配置与可用性 —— 守住它的位置：getProviderPriority —— 改错故障：首屏入口顺序回退，次要渠道挤掉主入口。
// INV-15 断言：可见渠道不得按登录状态过滤 —— 守住它的位置：resolveVisibleLoginProviders —— 改错故障：未登录用户看不到 BigModel 入口，无法主动选择。
// INV-16 断言：重试渠道解析顺序必须是 pending、lastAttempt、首个渠道、null —— 守住它的位置：resolveLoginRetryProvider —— 改错故障：空列表时返回未定义值导致点击重试崩溃。
// INV-17 断言：拖拽命中层必须先于 no-drag 区声明并避开窗口控制按钮 —— 守住它的位置：WelcomeScreen 内绝对定位拖拽 div 的位置 —— 改错故障：Windows 桌面端窗控区域无法点击。
// INV-18 断言：登录失败必须用 warning 语义而不是 destructive 语义 —— 守住它的位置：失败态 Alert 的 variant —— 改错故障：用户误以为登录已不可恢复而放弃重试。
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Loader2Icon, LoaderIcon, TriangleAlertIcon } from "lucide-react";
import { type OAuthProviderMeta, BIGMODEL_PROVIDER_ID, ZAI_PROVIDER_ID } from "@zcode/shared";
import {
  TID_LOGIN_USE_API_KEY_BUTTON,
  TID_OAUTH_CANCEL,
  TID_OAUTH_ERROR,
  TID_OAUTH_LOGIN_BUTTON,
  testId,
} from "@zcode/shared/test-ids";
import { Alert, AlertDescription } from "./components/ui/alert.js";
import { Button } from "./components/ui/button.js";
import { ZCodeAboutLogo } from "@/components/ui/ZCodeAboutLogo.js";
import { useOAuth } from "./hooks/useOAuth.js";
import { useZCodeIntl } from "./i18n/IntlProvider.js";
import { LoginApiKeyForm } from "./login/LoginApiKeyForm.js";
import { renderOAuthProviderIcon } from "./lib/oauthProviderIcon.js";
import { ThemeHeroVisual } from "./openWorkspacePageThemeHero.js";
import { useZCodeStore } from "./store/StoreProvider.js";
import { DesktopOverlayWindowControls } from "@/DesktopOverlayWindowControls.js";

interface WelcomeScreenProps {
  onComplete: (reason: LoginCompleteReason) => void | Promise<void>;
}

// 完成原因是对外契约：oauth 走回调自动完成，apiKey 表示用户已保存密钥，skip 表示显式跳过。
// 新增取值必须同步上层 onComplete 的处理分支，否则入口被关闭但后续流程无人接管。
// 不要用 apiKey 冒充 skip：两者在上层分别是「已配置凭据」与「暂不配置」两种语义。
export type LoginCompleteReason = "oauth" | "apiKey" | "skip";

// 外层只负责布局与窗口装饰，登录状态全部下沉到 LoginPanel，桌面浮层与 Web 才能复用同一面板。
// 拖拽命中层必须写在 section 之前且不接收 pointer 事件，否则会盖住登录按钮的点击命中。
// 这里不要加 active 之类的状态判断：面板挂载即代表入口已经打开。
export function WelcomeScreen({ onComplete }: WelcomeScreenProps) {
  return (
    <main className="relative flex h-full min-h-dvh items-center justify-center overflow-hidden bg-background px-4 py-6 text-foreground sm:px-6">
      <ThemeHeroVisual className="absolute inset-0" />
      {/* 原生拖拽命中不受 pointer-events/z-index 约束；拖拽层必须避开窗控，且先于 no-drag 区声明。 */}
      <div className="pointer-events-none absolute left-0 top-0 right-0 z-10 flex h-12 items-center [app-region:drag] platform-windows-desktop:right-[134px] platform-linux-desktop:right-[134px]" />
      <DesktopOverlayWindowControls />
      <section className="relative z-10 w-full flex flex-col gap-10 max-w-sm rounded-2xl border border-popover-border bg-background p-8 text-ui-base/relaxed shadow-md sm:p-10">
        <LoginPanel active onComplete={onComplete} />
      </section>
    </main>
  );
}

interface LoginPanelProps {
  active: boolean;
  onComplete: (reason: LoginCompleteReason) => void | Promise<void>;
}

interface ActiveLoginEntryAttempt {
  id: number;
  providerId: OAuthProviderMeta["id"];
}

// [契约] attempt 为 null 时返回 true：普通入口没有购买意图，任何渠道的成功都允许关闭面板。
// 有 attempt 时 providerId 必须严格相等，否则别处写入的全局 user 会被误当成这次流程的成功。
// 这个函数是纯判定，不要在这里改 store 或触发完成回调，调用方负责副作用。
export function shouldCompleteProviderLoginAttempt(params: {
  attempt: ActiveLoginEntryAttempt | null;
  successProvider: OAuthProviderMeta["id"] | null;
}): boolean {
  return !params.attempt || params.successProvider === params.attempt.providerId;
}

// [权衡] 只有「已有 user 且没有 in-flight attempt」才自动完成，避免把上一次会话的 user 当成新登录结果。
// 一旦为购买意图创建了 attempt，就必须等该渠道的 OAuth 成功信号，不能靠 user 提前收口。
// 改这里的判断前先确认 oauthSuccessSeq 分支仍能覆盖 provider connection 场景。
export function shouldCompleteLoginFromExistingUser(params: {
  hasUser: boolean;
  attempt: ActiveLoginEntryAttempt | null;
}): boolean {
  return params.hasUser && !params.attempt;
}

// 登录面板是四态机：idle 显示渠道列表或密钥表单，waiting 显示等待与取消，失败态显示错误与重试。
// 多个 effect 分别负责打开刷新、请求续接、失败收敛、成功收敛，互斥关系靠 status 与 ref 共同保证。
// [状态机] `LoginPanel` 只渲染 `status` 对应的一态；新分支先归入 idle / waiting / failed 之一，不往渠道列表同一屏塞错误提示。
export function LoginPanel({ active, onComplete }: LoginPanelProps) {
  const { intl } = useZCodeIntl();
  const {
    startLogin,
    cancel,
    reset,
    status,
    error,
    providers,
    loadingProviders,
    pendingProvider,
    refreshProviders,
  } = useOAuth();
  const user = useZCodeStore((s) => s.user);
  const oauthError = useZCodeStore((s) => s.oauthError);
  const setOAuthError = useZCodeStore((s) => s.setOAuthError);
  const oauthSuccessSeq = useZCodeStore((s) => s.oauthSuccessSeq);
  const lastOAuthSuccessProvider = useZCodeStore((s) => s.lastOAuthSuccessProvider);
  const loginEntryRequest = useZCodeStore((s) => s.loginEntryRequest);
  const clearLoginEntryRequest = useZCodeStore((s) => s.clearLoginEntryRequest);
  const markLoginEntryAttemptStatus = useZCodeStore((s) => s.markLoginEntryAttemptStatus);
  // loginMode 只是面板内的展示开关，不参与 OAuth 状态机，切换时不需要 reset useOAuth。
  // 面板关闭时由 resetApiKeyForm 复位，避免下次打开直接停在密钥表单。
  // 不要把它提升到 store：多窗口共享会让一个窗口的切换影响另一个窗口。
  const [loginMode, setLoginMode] = useState<"providers" | "apiKey">("providers");
  // 这几个 ref 都不进入 effect 依赖：它们在渲染期被写入，加入依赖会造成额外重跑。
  // consumedLoginRequestRef 记录已消费的请求 id，与 store 的 request id 配合实现幂等。
  // observedOAuthSuccessSeqRef 是成功信号水位线，用于区分历史成功与本次流程的成功。
  // activeLoginEntryAttemptRef 与 store 中的 attempt 记录一一对应，是完成或失败上报的唯一内存来源。
  const wasActiveRef = useRef(active);
  const consumedLoginRequestRef = useRef<number | null>(null);
  const observedOAuthSuccessSeqRef = useRef(oauthSuccessSeq);
  const lastAttemptProviderRef = useRef<OAuthProviderMeta["id"] | null>(null);
  const activeLoginEntryAttemptRef = useRef<ActiveLoginEntryAttempt | null>(null);

  // [事务] 先清空 ref 再上报状态：上报会触发 store 订阅与重渲染，清空放后面会因重入重复上报。
  // status 必须是终态（succeeded / cancelled / failed），waiting 只允许由 startTrackedLogin 写入。
  // 没有进行中的 attempt 时直接返回，保证取消按钮与关闭面板重复调用只生效一次。
  // 不要在这里顺手 reset()：各调用方对 useOAuth 的清理时机并不相同。
  const finishActiveLoginEntryAttempt = useCallback(
    (status: "succeeded" | "cancelled" | "failed") => {
      const attempt = activeLoginEntryAttemptRef.current;
      if (!attempt) {
        return;
      }
      activeLoginEntryAttemptRef.current = null;
      markLoginEntryAttemptStatus(attempt.id, status);
    },
    [markLoginEntryAttemptStatus],
  );

  // [失败路径] 发起前先清 store 的 oauthError，否则等待态会与上一次的失败提示同屏。
  // 同一面板内切到另一条流程时，旧购买意图必须先标记 cancelled，否则会一直挂在等待态。
  // loginEntryAttemptId 只有后台续接请求才传，普通点击登录不创建 attempt，不能被误标为 waiting。
  // lastAttemptProviderRef 记录真实发起过的渠道，供失败重试兜底，因为 reset 后 pendingProvider 已被清空。
  const startTrackedLogin = useCallback(
    (
      provider: OAuthProviderMeta["id"],
      options?: Parameters<typeof startLogin>[1],
      loginEntryAttemptId?: number,
    ) => {
      const activeAttempt = activeLoginEntryAttemptRef.current;
      if (activeAttempt && activeAttempt.id !== loginEntryAttemptId) {
        // 切换流程时先把旧 attempt 标成 cancelled，再继续新流程，避免两条意图同时挂起。
        // 判断条件是 id 不同而非 provider 不同：同一渠道重新发起也算换了一条流程。
        // 用户在统一登录页开始另一条登录流程时，旧购买意图不能继续等待。
        finishActiveLoginEntryAttempt("cancelled");
      }
      // 上一次失败遗留的 store oauthError 若不清掉，新流程进入等待态后
      // 失败提示会和等待提示同屏（如失败后关闭登录入口，再从设置页自动续接登录）。
      setOAuthError(null);
      if (loginEntryAttemptId !== undefined) {
        activeLoginEntryAttemptRef.current = {
          id: loginEntryAttemptId,
          providerId: provider,
        };
        markLoginEntryAttemptStatus(loginEntryAttemptId, "waiting");
      }
      lastAttemptProviderRef.current = provider;
      return startLogin(provider, options);
    },
    [finishActiveLoginEntryAttempt, markLoginEntryAttemptStatus, setOAuthError, startLogin],
  );

  // 展示名映射只从当前 providers 推导，列表刷新后自动失效，不需要手动清理。
  // pendingProvider 可能已被后端下线，取值处必须回退到原始 id 再展示。
  const providerNameMap = useMemo(
    () => new Map(providers.map((provider) => [provider.id, provider.displayName])),
    [providers],
  );

  const pendingProviderName = pendingProvider
    ? (providerNameMap.get(pendingProvider) ?? pendingProvider)
    : null;
  // 只排序不过滤：即便某渠道当前不可登录也要展示，否则用户失去主动选择的机会。
  // 这里不再去重，id 唯一性由 providers 保证；用 useMemo 只为稳住渲染引用。
  const visibleProviders = useMemo(() => resolveVisibleLoginProviders(providers), [providers]);

  // 面板打开时刷新渠道列表；active 为 false 时不能发请求，否则隐藏面板仍在打后端。
  // refreshProviders 来自 useOAuth，引用稳定，作为依赖不会造成循环刷新。
  // 失败由 useOAuth 内部的 error 与 oauthError 承担，这里不重复捕获。
  useEffect(() => {
    if (active) {
      void refreshProviders();
    }
  }, [active, refreshProviders]);

  // [并发] 续接后台登录请求：同一个 request id 只消费一次，先写 ref 再清 store。
  // consumedLoginRequestRef 必须在调用前赋值，否则严格模式下两次 effect 会各发一次 OAuth。
  // 只处理带 providerId 的请求，purpose 原样透传，用于区分购买与普通连接。
  // 清 store 与发起之间不能插入 await，避免出现已清空但尚未发起的窗口。
  useEffect(() => {
    if (
      !active ||
      !loginEntryRequest?.providerId ||
      consumedLoginRequestRef.current === loginEntryRequest.id
    ) {
      return;
    }

    consumedLoginRequestRef.current = loginEntryRequest.id;
    clearLoginEntryRequest(loginEntryRequest.id);
    // Model Provider 的登录/连接入口以前绕过统一登录入口直接发起 OAuth，
    // 导致用户看不到统一的等待、取消和错误状态。这里在 WelcomeScreen 打开后自动启动指定 provider，
    // 复用登录入口的 loading 流程，同时用 request id 防止 React 严格模式下重复发起。
    void startTrackedLogin(
      loginEntryRequest.providerId,
      {
        purpose: loginEntryRequest.purpose,
      },
      loginEntryRequest.id,
    );
  }, [active, clearLoginEntryRequest, loginEntryRequest, startTrackedLogin]);

  // Root 层 OAuth 回调失败时写入 Zustand oauthError，统一登录入口负责显示错误。
  // [失败路径] Root 层回调失败只写 oauthError，面板必须在这里把 useOAuth 从 waiting 拉回 idle。
  // reset() 会清空 pendingProvider，所以失败态重试只能依赖 lastAttemptProviderRef 回退。
  // 只有 active 时收敛，隐藏面板保留错误交给下次打开展示。
  // 不要在这里 setOAuthError(null)：错误需要留给下方失败块渲染。
  useEffect(() => {
    if (oauthError && active) {
      finishActiveLoginEntryAttempt("failed");
      reset(); // 重置 useOAuth 的 waiting 状态
      // oauthError 已在 store 中，下方 UI 会读取并显示
    }
  }, [active, finishActiveLoginEntryAttempt, oauthError, reset]);

  // useOAuth 自身报错时同步结束 attempt，避免购买意图停在 waiting。
  // 文案由下方失败块统一读取 error，这里不决定展示形式。
  useEffect(() => {
    if (active && status === "error") {
      finishActiveLoginEntryAttempt("failed");
    }
  }, [active, finishActiveLoginEntryAttempt, status]);

  // OAuth 回调成功后 Root 层设置 user，统一登录入口自动关闭。
  // [契约] OAuth 回调成功后 Root 层写 user，面板据此自动完成登录。
  // 有 in-flight attempt 时这段必须跳过，全局 user 可能来自另一个渠道的旧会话。
  // onComplete 用 void 调用，避免上层返回 Promise 时在 effect 里产生未处理的拒绝。
  // reset 与清错误放在 onComplete 之前，保证面板关闭过程中不再闪回等待态。
  useEffect(() => {
    if (
      active &&
      shouldCompleteLoginFromExistingUser({
        hasUser: Boolean(user),
        attempt: activeLoginEntryAttemptRef.current,
      })
    ) {
      // 全局 user 可能来自另一个 Provider，不能把刚发起的购买登录
      // 误判为成功；Provider-specific attempt 只由匹配的 OAuth success 完成。
      reset();
      setOAuthError(null);
      void onComplete("oauth");
    }
  }, [active, finishActiveLoginEntryAttempt, onComplete, reset, setOAuthError, user]);

  // [并发] 用 seq 水位线识别本次流程新增的成功，不能只看 user 是否变化。
  // 面板关闭期间只推进水位不清流程，防止历史成功信号在重开时触发 onComplete。
  // provider connection 不写 App user，这条分支是它唯一的完成入口。
  // attempt 存在时 providerId 必须严格匹配，否则会把别处的成功当成自己的。
  useEffect(() => {
    if (!active) {
      observedOAuthSuccessSeqRef.current = oauthSuccessSeq;
      return;
    }

    if (oauthSuccessSeq > observedOAuthSuccessSeqRef.current) {
      observedOAuthSuccessSeqRef.current = oauthSuccessSeq;
    } else {
      return;
    }

    if (
      status === "waiting" &&
      shouldCompleteProviderLoginAttempt({
        attempt: activeLoginEntryAttemptRef.current,
        successProvider: lastOAuthSuccessProvider,
      })
    ) {
      // provider connection 复用同一个登录入口视觉流程，
      // 但成功后不会写 App user；这里用 Root 的成功信号关闭登录入口，保持用户交互不变。
      finishActiveLoginEntryAttempt("succeeded");
      reset();
      setOAuthError(null);
      void onComplete("oauth");
    }
  }, [
    active,
    finishActiveLoginEntryAttempt,
    lastOAuthSuccessProvider,
    oauthSuccessSeq,
    onComplete,
    reset,
    setOAuthError,
    status,
  ]);

  // 表单复位只切回渠道列表，不触碰 OAuth 状态，供取消、保存、跳过三个出口复用。
  // 依赖数组为空是刻意的：setLoginMode 是稳定 setter。
  const resetApiKeyForm = useCallback(() => {
    setLoginMode("providers");
  }, []);

  // [资源] 面板由 active 变为 false 的下降沿：取消等待中的 OAuth，避免后台继续轮询。
  // 只在真正由 true 转 false 时执行一次，首次挂载即为 false 不能触发清理。
  // 顺序固定：先 cancel 再 reset，最后清 store 与表单，保证重开时是干净的 idle。
  // finishActiveLoginEntryAttempt 在这里上报 cancelled，不能省略这一步。
  useEffect(() => {
    if (active) {
      wasActiveRef.current = true;
      return;
    }

    if (!wasActiveRef.current) {
      return;
    }
    wasActiveRef.current = false;

    if (status === "waiting") {
      void cancel(pendingProvider ?? undefined);
    }
    finishActiveLoginEntryAttempt("cancelled");
    reset();
    setOAuthError(null);
    clearLoginEntryRequest();
    resetApiKeyForm();
  }, [
    active,
    cancel,
    clearLoginEntryRequest,
    finishActiveLoginEntryAttempt,
    pendingProvider,
    reset,
    resetApiKeyForm,
    setOAuthError,
    status,
  ]);

  return (
    <>
      <LoginPanelHeader
        title={intl.formatMessage({ id: "login.title" })}
        description={intl.formatMessage({ id: "login.description" })}
      >
        {null}
      </LoginPanelHeader>

      <div className="space-y-6">
        {/* Bugfix: Root 层写入 oauthError（轮询/回调失败）后 effect 会把 useOAuth reset 回 idle，
            若只判断 status==="idle" 会让失败块和渠道按钮列表同屏、状态纠缠。
            失败期间统一由下方失败块接管（重新登录/取消），渠道列表等错误清掉后再回来。 */}
        {status === "idle" && !oauthError && loginMode === "providers" && (
          <div className="space-y-4">
            {loadingProviders ? (
              <div className="flex items-center justify-center gap-2 rounded-xl border border-border bg-surface px-4 py-6 text-ui-base text-foreground-subtle">
                <Loader2Icon className="size-4 animate-spin" />
                {intl.formatMessage({ id: "login.oauth.loadingProviders" })}
              </div>
            ) : null}

            {!loadingProviders && providers.length === 0 ? (
              <Alert
                variant="warning"
                className="flex items-center justify-center gap-2 text-center"
                data-testid={TID_OAUTH_ERROR}
              >
                <TriangleAlertIcon className="size-4" />
                <AlertDescription className="text-center">
                  {intl.formatMessage({ id: "login.oauth.noProviders" })}
                </AlertDescription>
              </Alert>
            ) : null}

            {!loadingProviders ? (
              <div className="space-y-2">
                {visibleProviders.map((provider) => (
                  <Button
                    key={provider.id}
                    variant="default"
                    className="h-10 w-full text-ui-base"
                    size="lg"
                    data-testid={
                      provider.id === BIGMODEL_PROVIDER_ID
                        ? TID_OAUTH_LOGIN_BUTTON
                        : testId(TID_OAUTH_LOGIN_BUTTON, provider.id)
                    }
                    onClick={() => void startTrackedLogin(provider.id)}
                  >
                    {renderOAuthProviderIcon(provider.id, "size-4")}
                    <span className="min-w-0 truncate">
                      {intl.formatMessage(
                        { id: getLoginOAuthButtonMessageId(provider.id) },
                        { provider: provider.displayName },
                      )}
                    </span>
                    <LoginOAuthRegionTag providerId={provider.id} />
                  </Button>
                ))}
                <Button
                  variant="outline"
                  className="h-10 w-full text-ui-base"
                  size="lg"
                  data-testid={TID_LOGIN_USE_API_KEY_BUTTON}
                  onClick={() => {
                    setLoginMode("apiKey");
                  }}
                >
                  {intl.formatMessage({ id: "login.useApiKey" })}
                </Button>
              </div>
            ) : null}
          </div>
        )}

        {status === "idle" && loginMode === "apiKey" ? (
          <LoginApiKeyForm
            onCancel={() => setLoginMode("providers")}
            onSaved={() => {
              resetApiKeyForm();
              return onComplete("apiKey");
            }}
            onSkipped={() => {
              resetApiKeyForm();
              return onComplete("skip");
            }}
          />
        ) : null}

        {status === "waiting" && (
          <div className="space-y-4">
            <div className="flex items-center justify-center gap-2 rounded-lg border border-border bg-surface p-2 text-ui-base text-foreground-subtle">
              <LoaderIcon className="size-4 animate-spin" />
              {intl.formatMessage(
                { id: "login.oauth.waiting" },
                { provider: pendingProviderName ?? "OAuth" },
              )}
            </div>
            <Button
              variant="outline"
              className="h-10 w-full text-ui-base"
              size="lg"
              data-testid={TID_OAUTH_CANCEL}
              onClick={() => {
                // 等待态的取消只收敛 OAuth，不关闭面板，否则用户要重新打开入口才能换渠道。
                // 先结束 attempt 再调用 cancel，保证取消信号与状态上报的顺序一致。
                // 这里不要 reset 整个面板：回到 idle 后列表可以立即再次点击。
                // OAuth 等待态里的“取消”只应取消浏览器授权等待，
                // 不能关闭整个登录入口，否则用户需要重新从入口打开才能换登录方式。
                finishActiveLoginEntryAttempt("cancelled");
                void cancel(pendingProvider ?? undefined);
              }}
            >
              {intl.formatMessage({ id: "login.oauth.cancel" })}
            </Button>
          </div>
        )}

        {(status === "error" || oauthError) && (
          <div className="space-y-4">
            <Alert
              variant="warning"
              className="flex items-center justify-center gap-2 text-center"
              data-testid={TID_OAUTH_ERROR}
            >
              <TriangleAlertIcon className="size-4" />
              <AlertDescription className="text-center">
                {/* Bugfix: 登录失败通常是可重试/可切换提供方的状态，不能用 destructive 红色误导为破坏性错误。
                    这里统一用 warning 语义，并居中文案以匹配登录面板的居中视觉节奏。 */}
                {oauthError || error}
              </AlertDescription>
            </Alert>
            <Button
              className="h-10 w-full text-ui-base"
              size="lg"
              onClick={() => {
                const retryProvider = resolveLoginRetryProvider({
                  pendingProvider,
                  lastAttemptProvider: lastAttemptProviderRef.current,
                  providers,
                });
                if (!retryProvider) {
                  return;
                }
                // 重试渠道来自 resolveLoginRetryProvider，解析不到时直接返回，避免用未定义渠道发请求。
                // 失败后 pendingProvider 已被清空，必须靠 lastAttemptProviderRef 才能沿用刚才的渠道。
                // 不要在重试前手动清 oauthError：startTrackedLogin 内部会统一清理。
                // OAuth 回调失败会触发 reset()，它会清空 pendingProvider。
                // 重新登录必须沿用刚才失败的渠道，不能因为 providers[0] 的原始顺序退回 BigModel。
                // store 残留错误由 startTrackedLogin 发起前统一清理。
                void startTrackedLogin(retryProvider);
              }}
            >
              {intl.formatMessage({ id: "login.oauth.retry" })}
            </Button>
            <Button
              variant="outline"
              className="h-10 w-full text-ui-base"
              size="lg"
              data-testid={TID_OAUTH_CANCEL}
              onClick={() => {
                // 失败态的取消回到渠道列表而非关闭面板，让用户能直接换渠道重试。
                // 清 oauthError 是必须的：不清会让下方失败块继续渲染，列表永远不出现。
                // 顺序为结束 attempt、清错误、取消 OAuth，与等待态取消保持同一套语义。
                // 失败态不能只有「重新登录」沿原渠道重试：想换渠道只能关闭
                // 登录入口重开，容易在同一条失败链路上反复失败。这里对齐等待态取消的
                // 语义：结束本次失败流程回到渠道列表，登录入口不关闭。
                finishActiveLoginEntryAttempt("cancelled");
                setOAuthError(null);
                void cancel(pendingProvider ?? undefined);
              }}
            >
              {intl.formatMessage({ id: "login.oauth.cancel" })}
            </Button>
          </div>
        )}
      </div>
    </>
  );
}

// 纯展示组件：标题与描述由调用方传入已翻译的文案，这里不再做国际化取值。
// children 目前恒为 null，保留扩展位用于放置公告类内容。
// 视觉上居中且窄列，调整间距时需同时确认手机宽度下的换行表现。
function LoginPanelHeader({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <header className="flex flex-col items-center gap-3 text-center">
      <LoginPanelLogo />
      <div className="flex flex-col items-center gap-1 text-center">
        <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
        <p className="text-ui-base/relaxed text-foreground-subtle">{description}</p>
      </div>
      {children}
    </header>
  );
}

// logo 壳使用固定深色渐变与白色前景，不跟随主题 token，因此边框色写死在渐变里。
// aria-label 与 role 让读屏软件识别品牌图形，调整结构时保留这两个属性。
function LoginPanelLogo() {
  return (
    // 登录 logo 壳是固定深色底，边框不能跟随浅色主题 token，否则浅色主题下边框过重。
    <div
      className="relative mb-1 flex size-16 items-center justify-center rounded-2xl bg-[linear-gradient(180deg,#000000_0%,#151718_100%)] text-[#ffffff] shadow-lg/20 before:pointer-events-none before:absolute before:inset-0 before:rounded-2xl before:border before:border-[rgba(255,255,255,0.1)]"
      aria-label="ZCode"
      role="img"
    >
      <ZCodeAboutLogo className="h-auto w-10" />
    </div>
  );
}

// 文案 id 与 provider 一一对应，新增渠道时走到 default 会回落到通用按钮文案。
// 不要按 displayName 拼装文案 id：渠道展示名可被后端改写，文案键不会变。
// 返回类型保持 string，调用方直接交给 intl.formatMessage。
function getLoginOAuthButtonMessageId(providerId: string): string {
  switch (providerId) {
    case ZAI_PROVIDER_ID:
      return "login.oauth.button.zai";
    case BIGMODEL_PROVIDER_ID:
      return "login.oauth.button.bigmodel";
    default:
      return "login.oauth.button";
  }
}

// 区域标签只对特定渠道存在，返回 null 表示该渠道不渲染标签。
// 与按钮文案共用同一份 provider 常量，避免两处判断漂移。
function getLoginOAuthRegionTagMessageId(providerId: string): string | null {
  switch (providerId) {
    case ZAI_PROVIDER_ID:
      return "login.oauth.regionTag.zai";
    case BIGMODEL_PROVIDER_ID:
      return "login.oauth.regionTag.bigmodel";
    default:
      return null;
  }
}

// 标签是纯装饰信息，没有消息 id 时返回 null，不占位也不留空白。
// 文案走 intl，颜色依赖 primary-foreground 语义，切换主题时无需改动。
function LoginOAuthRegionTag({ providerId }: { providerId: string }) {
  const { intl } = useZCodeIntl();
  const messageId = getLoginOAuthRegionTagMessageId(providerId);

  if (!messageId) {
    return null;
  }

  return (
    <span className="ml-1 inline-flex h-5 shrink-0 items-center rounded-full border border-primary-foreground/30 px-2 text-ui-xs font-medium leading-none text-primary-foreground/60">
      {intl.formatMessage({ id: messageId })}
    </span>
  );
}

// 排序权重只决定登录入口的展示顺序，不改变 provider 的真实配置与可用性。
// z.ai 固定 0、BigModel 固定 1，其余按后端 order 排在 10 之后，保证前两位稳定。
// [契约] `getProviderPriority` 只排展示序：z.ai 取 0 / BigModel 取 1 / 其余 `10 + provider.order`，首屏前两位不随渠道增减漂移。
function getProviderPriority(provider: OAuthProviderMeta): number {
  switch (provider.id) {
    // Windows 登录入口里 z.ai 入口需要固定排在最上面，
    // 之前把 BigModel 设成更高优先级后，用户首屏会先看到次要入口。
    // 这里直接调整排序权重，只改展示顺序，不影响 OAuth provider 的真实配置来源。
    case ZAI_PROVIDER_ID:
      return 0;
    case BIGMODEL_PROVIDER_ID:
      return 1;
    default:
      return 10 + provider.order;
  }
}

// 只做拷贝排序，绝不按登录状态过滤，否则未登录用户会缺少可选渠道。
// 用 slice 拷贝后再 sort，避免原地排序污染 useOAuth 返回的数组引用。
// 调用方用 useMemo 缓存结果，这里保持纯函数便于单测。
export function resolveVisibleLoginProviders(providers: OAuthProviderMeta[]): OAuthProviderMeta[] {
  // Bugfix: ZAI / BigModel 现在共享 App 登录事实源，未登录时登录入口必须同时展示两个入口。
  // 旧逻辑曾临时隐藏 BigModel，导致用户无法主动选择 BigModel 作为 active provider。
  return [...providers].sort((left, right) => {
    return getProviderPriority(left) - getProviderPriority(right);
  });
}

// 解析优先级：进行中的渠道、本次最后尝试的渠道、列表首个渠道、null。
// providers 为空时必须返回 null，调用方依赖该值判断是否可以重试。
// 不要在这里读取 store：纯函数便于单测，也避免与组件订阅重复。
export function resolveLoginRetryProvider({
  pendingProvider,
  lastAttemptProvider,
  providers,
}: {
  pendingProvider: OAuthProviderMeta["id"] | null;
  lastAttemptProvider: OAuthProviderMeta["id"] | null;
  providers: OAuthProviderMeta[];
}): OAuthProviderMeta["id"] | null {
  return pendingProvider ?? lastAttemptProvider ?? providers[0]?.id ?? null;
}
