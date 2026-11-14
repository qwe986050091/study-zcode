/* eslint-disable max-lines -- OAuth lifecycle effects intentionally share one coordination point. */
// root 层 OAuth 生命周期副作用协调点：把启动缓存恢复、JWT 失效广播、轮询登录、deep-link 回调四条入口收敛到同一处编排。
// 只负责登录态收敛与 UI 副作用的先后顺序；不校验 token 有效性、不落盘凭据、不实现 OAuth 授权流程本身，也不持有 React 状态的所有权。
// 用户态、错误态、轮询开关与恢复中标记全部由调用方注入，本文件只用 ref 保存跨入口的登录成功仲裁标记。
//
// INV-01 断言：连接域初始化失败只撤销本次自动写入资格，绝不否定已成立的 session —— 守住它的位置：handleOAuthCallbackSuccess 首个 try/catch —— 改错故障：用户明明已登录却被弹回登录页
// INV-02 断言：写入资格被撤销后不得再重读最新 provider family 选择 —— 守住它的位置：if (connectionInitialized && params.refreshLatestModelProviderFamilySelection) —— 改错故障：重读出的新版本会覆盖用户刚做的并发选择
// INV-03 断言：资格被撤销但未拿到选择时仍要刷新 settings 快照 —— 守住它的位置：if ((selection || !connectionInitialized) && params.refreshAppSettings) —— 改错故障：界面长期停留在旧 selectedKey，直到重启才恢复
// INV-04 断言：账号态刷新在门控之外无条件执行 —— 守住它的位置：if 块之后的 await params.refreshProviderState() —— 改错故障：Account Source 与 Registry 继续按上一个账号的额度渲染
// INV-05 断言：登录成功遥测必须以 void 发起且不阻塞收尾 —— 守住它的位置：void reportAppTelemetryEvent —— 改错故障：遥测网络慢或抛错会卡住或打断登录成功流程
// INV-06 断言：启动恢复结果的持有标志初值必须为 false，只在真正恢复出用户后变真 —— 守住它的位置：restoreOAuthSessionInBackground 内的 hasRestoredUser —— 改错故障：恢复失败仍去校正 provider family，命中空 provider 分支并刷出错误日志
// INV-07 断言：每处 await 之后都要重新检查 disposed 才能写状态 —— 守住它的位置：恢复主流程 setUser 与 applyCachedOAuthSessionRestoreResult 之后 —— 改错故障：组件卸载后仍写状态，旧会话覆盖新会话
// INV-08 断言：恢复中标记必须在第二轮刷新之前落定为 false —— 守住它的位置：restoreOAuthSessionInBackground 尾部 setIsRestoringOAuthSession(false) —— 改错故障：侧栏先按未登录渲染，出现外面未登录、弹窗内已登录提供方的分裂展示
// INV-09 断言：第二轮 try 的失败只记 warn，不得冒泡成未处理的 rejection —— 守住它的位置：启动刷新 catch —— 改错故障：后台恢复链路整体中断且界面上无任何提示
// INV-10 断言：失效提示闸门必须同步置真再发起异步提示 —— 守住它的位置：broadcast onMessage 回调中的 promptPending —— 改错故障：连发的失效广播弹出多个叠在一起的重复登录提示
// INV-11 断言：广播订阅必须在 cleanup 中既置 disposed 又释放句柄 —— 守住它的位置：失效广播 effect 的返回函数 —— 改错故障：热更新或重挂载后旧监听继续弹窗，句柄泄漏
// INV-12 断言：失效提示与启动过期必须共用同一份文案来源 —— 守住它的位置：两处 requestOAuthReauthentication 的 copy 字段 —— 改错故障：同一故障在不同时机显示不同措辞，用户以为是两类问题
// INV-13 断言：轮询成功只认 kind 为 session 的结果 —— 守住它的位置：pollPendingOAuth 的 then 首段 —— 改错故障：把空结果当成功，进入无用户信息的成功收尾
// INV-14 断言：轮询定时器靠 pollInFlight 串行，慢网下不得叠发请求 —— 守住它的位置：setInterval 回调首行 —— 改错故障：同一 session 被并发处理两次，登录成功收尾重复执行
// INV-15 断言：成功收尾必须按 owner、inFlight、遥测回调、停轮询的顺序收尾 —— 守住它的位置：轮询成功分支尾部 —— 改错故障：后续失败判定读到脏标记，把已完成的登录写成失败
// INV-16 断言：自身收尾抛错时不得再把失败应用到界面 —— 守住它的位置：shouldApplyOAuthPollingFailure 的第二个入参 —— 改错故障：登录成功后仅因刷新步骤异常就被提示登录失败
// INV-17 断言：空结果、归因结果、重复结果三类回调都要提前返回 —— 守住它的位置：handleCallback 之后的分支判断 —— 改错故障：取消或切换 flow 的旧回调被当成登录异常提示
// INV-18 断言：轮询仍活跃时 deep-link 失败不报错 —— 守住它的位置：ownSuccessHandlerFailed 分支后的 !oauthPollingActive 条件 —— 改错故障：轮询正在成功的那一秒弹出登录失败
// INV-19 断言：界面只呈现统一可重试文案，底层原因只进日志 —— 守住它的位置：deep-link catch 内的 setOAuthError —— 改错故障：登录页泄露 provider、token 等内部失败细节
// INV-20 断言：渲染器就绪通知必须在注册回调之后且每个 effect 实例只调一次 —— 守住它的位置：deep-link effect 末尾 platform.notifyRendererReady —— 改错故障：主进程在无监听时派发早期回调，点登录无反应
import { useEffect, useRef } from "react";
import type {
  IPlatformService,
  OAuthProviderId,
  OAuthSessionCallbackResult,
  UserInfo,
} from "@zcode/shared";
import {
  resolveProviderFamilyDomainFromOAuthProvider,
  ZCODE_JWT_INVALID_BROADCAST_CHANNEL,
} from "@zcode/shared";
import type { IServiceAccessor } from "@zcode/services";
import { useAlertDialog } from "@/hooks/useAlertDialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { reportAppTelemetryEvent, resolveProviderTelemetryLabel } from "@/lib/appTelemetry.js";
import { logger } from "@/logger.js";
import { setProviderFamilyDomain } from "@/lib/providerFamilyDomainSettings.js";
import type { ModelProviderFamilyConnectionSelection } from "@/lib/modelProviderFamilyConnectionSelection.js";
import {
  refreshLatestModelProviderFamilySelectionAfterLogin,
  refreshRestoredOAuthProviderFamilyAfterStartup,
} from "@/root/oauthProviderFamilySelectionRefresh.js";
import {
  applyCachedOAuthSessionRestoreResult,
  requestOAuthReauthentication,
} from "@/root/oauthCachedSessionRestore.js";
import { shouldApplyOAuthPollingFailure } from "@/root/oauthLoginAttemptGuard.js";
import { useAccountConnectionLossNotification } from "@/root/useAccountConnectionLossNotification.js";

export { refreshRestoredOAuthProviderFamilyAfterStartup } from "@/root/oauthProviderFamilySelectionRefresh.js";

// [契约] 本函数是轮询与 deep-link 两条入口共用的收尾编排，执行顺序就是契约：先落用户态，再补连接域与设置快照，最后刷新账号态。
// 调用方必须先自行判定结果类型，不要在这里再判一次；两条入口拿到的结果结构不同，重复判定会让分支语义分叉。
// 此处刻意不关闭轮询开关：轮询分支要等整个成功序列结束才停，提前关闭会让收尾中途被下一轮定时器重新拉起。
// 也不在这里登记成功标记，那是调用方在成功后立即执行的语义，搬进来会让 deep-link 的重入判定失效。
export async function handleOAuthCallbackSuccess(params: {
  result: OAuthSessionCallbackResult;
  platform: Pick<IPlatformService, "reportTelemetryEvent">;
  refreshLatestModelProviderFamilySelection?: (
    provider: OAuthProviderId,
  ) => Promise<ModelProviderFamilyConnectionSelection | null>;
  refreshAppSettings?: () => Promise<void>;
  refreshProviderState: () => Promise<void>;
  setProviderFamilyDomain: (provider: OAuthProviderId) => Promise<void>;
  setUser: (user: UserInfo | null) => void;
  setOAuthError: (error: string | null) => void;
}) {
  const loginProvider = resolveProviderTelemetryLabel(params.result.provider);
  params.setUser(params.result.userInfo);
  params.setOAuthError(null);
  // [权衡] 这个标志表达的不是“连接域是否已生效”，而是“本次自动写入是否还具资格”；一旦发生冲突即为假，用来阻止后续重读覆盖。
  // 初值必须为真：改成假的初值会让毫无冲突的正常登录也跳过设置快照刷新，界面一直读旧 selectedKey。
  // `connectionInitialized` 只参与后续两步门控，不用登录成败的语义解读。
  // [失败路径] 撤销资格的位置只有下面那个 catch，任何新增的撤销分支都必须复用同一处，否则门控出现两套真相。
  let connectionInitialized = true;
  try {
    // [事务] 这是登录成功后的首个副作用写入，可能因并发修改而冲突；必须被单独的 try 包裹，不能与后续刷新步骤合并。
    // 合并的后果是一次冲突连带跳过设置快照与账号态刷新，用户看到已登录但模型列表仍是旧的，且日志里只有一个 warn。
    // 此处失败不重试：重试会拿本轮读到的旧版本再次覆盖并发的用户修改，比不写更糟。
    await params.setProviderFamilyDomain(params.result.provider);
  } catch (error) {
    connectionInitialized = false;
    // 原因：认证已成功，连接初始化的 CAS 冲突不能否定 session 或中断登录成功收尾。
    // 保留并发新设置，不重试覆盖；独立报告辅助步骤失败。
    logger.warn("[Root] OAuth 登录后连接域初始化未应用", {
      provider: params.result.provider,
      error,
    });
  }
  // [契约] 进入条件是“具备刷新能力”或“本次写入被撤销”二者之一，后者要走到内部去补齐设置快照。
  // 不要简化成只看回调是否存在：资格被撤销时即使没有回调，也必须刷新快照，否则输入框与悬停提示一直拿旧值。
  // 此 if 内的任何失败都只影响展示层校正，不能回滚已经成立的登录态，也不要在此处写错误提示。
  // 两层判断保持嵌套，别拍平成一个复合条件，那会把“是否重读选择”和“是否刷新快照”两类语义混在一起。
  if (params.refreshLatestModelProviderFamilySelection || !connectionInitialized) {
    let selection: ModelProviderFamilyConnectionSelection | null = null;
    try {
      // 原因：初始化冲突已撤销本次自动写入资格，不能重读新版本再次覆盖用户选择。
      if (connectionInitialized && params.refreshLatestModelProviderFamilySelection)
        selection = await params.refreshLatestModelProviderFamilySelection(params.result.provider);
    } catch (error) {
      // selectedKey 后台校正失败只影响默认连接方式展示，不能回滚已经成功的 OAuth 登录态。
      logger.warn("[Root] OAuth 登录后刷新 provider family selectedKey 失败", {
        provider: params.result.provider,
        error,
      });
    }
    const selectedConnection = selection ? JSON.stringify(selection) : "";
    if ((selection || !connectionInitialized) && params.refreshAppSettings) {
      try {
        // selectedKey 由 settingService 直接落盘，输入框和 context hover
        // 读取的是 renderer settings 快照。登录后必须先刷新快照，再按最终套餐刷新
        // 模型可用态和剩余额度，否则 UI 会一直拿旧 selectedKey，直到打开设置页或重启。
        await params.refreshAppSettings();
      } catch (error) {
        logger.warn("[Root] OAuth 登录后刷新 App settings 快照失败", {
          provider: params.result.provider,
          selectedConnection,
          error,
        });
      }
    }
  }
  // selectedKey 与账号状态收敛后统一刷新 Account Source 与 Registry。
  // [契约] 账号态刷新放在门控之外无条件执行：即使选择没变，也要让 Account Source 与 Registry 跟随新账号重建。
  // 改成条件执行，会在“连接域写入冲突但登录成功”的场景里让账号面板继续显示上一个账号的额度与套餐。
  // 此处不在 try 内：账号态刷新失败属于基础设施异常，必须让调用方感知，而不是被本函数吞成一次登录成功。
  await params.refreshProviderState();
  if (loginProvider) {
    void reportAppTelemetryEvent(
      params.platform,
      {
        elementName: "app_login_success",
        eventRegion: "app_profile",
        eventType: "view",
        eventExtraDetail: {
          login_provider: loginProvider,
        },
      },
      "Root",
    );
  }
  logger.info("[Root] OAuth 登录成功:", params.result.userInfo.username);
}

// [契约] 本 hook 是四条 OAuth 入口的唯一协调点，参数全部由外部注入，内部不持有登录事实，只持有跨入口的判定标记。
// 四条入口分别是启动缓存恢复、失效广播、轮询登录、deep-link 回调；它们共享登录成功的先后关系，不能拆成互不知情的独立 hook。
// 不负责渲染，也不负责 token 生命周期；任何“顺手在 effect 里再刷新一次业务数据”的改动都应回到调用方。
// 所有 effect 的依赖数组都内联展开，没有做引用收敛，改依赖前先确认调用方是否每次渲染都传新函数。
export function useRootOAuthEffects({
  accountIntentKey,
  platform,
  services,
  refreshProviderState,
  refreshAppSettings,
  setUser,
  setIsRestoringOAuthSession,
  setOAuthError,
  oauthPollingActive,
  setOAuthPollingActive,
  markOAuthSuccess,
  onReauthenticationRequired,
}: {
  accountIntentKey: string;
  platform: IPlatformService;
  services: IServiceAccessor;
  refreshProviderState: () => Promise<void>;
  refreshAppSettings?: () => Promise<void>;
  setUser: (user: UserInfo | null) => void;
  setIsRestoringOAuthSession: (restoring: boolean) => void;
  setOAuthError: (error: string | null) => void;
  oauthPollingActive: boolean;
  setOAuthPollingActive: (active: boolean) => void;
  markOAuthSuccess: (provider?: OAuthProviderId) => void;
  onReauthenticationRequired: () => void;
}) {
  useAccountConnectionLossNotification(services, accountIntentKey, refreshAppSettings);
  const requestAlert = useAlertDialog();
  const { intl } = useZCodeIntl();
  // [并发] 三个 ref 组成一次登录成功的仲裁状态：已成功过、成功处理中、谁在处理，分别对应成功标记、在途标记与归属标记。
  // 三者必须在同一同步块内成对写入，不能只改其中一个；任何一个在 await 之间漏写，失败判定都会读到半状态。
  // 用 ref 而不是 state，是因为它们要跨定时器回调与 deep-link 回调共享，且变化不应触发重渲染。
  // 别把它们合并成一个对象 ref：合并后局部更新要展开旧值，并发路径上极易写出丢失字段的赋值。
  const oauthLoginSucceededRef = useRef(false);
  const oauthLoginSuccessInFlightRef = useRef(false);
  const oauthLoginSuccessOwnerRef = useRef<"polling" | "deep-link" | null>(null);

  useEffect(() => {
    let disposed = false;
    // [契约] 启动恢复是只读后台流程：只读本地缓存与本地有效期，绝不主动联网校验或强制刷新 token。
    // 函数后半段还会做 provider family 校正，那属于展示层动作，失败后仍然保留已恢复的登录态。
    // 名字里的后台是语义承诺：调用方以 void 启动、不等待完成，因此内部必须自己兜住全部异常。
    async function restoreOAuthSessionInBackground() {
      logger.info("[Root] 后台启动 OAuth 本地会话恢复");
      let hasRestoredUser = false;
      // [失败路径] 第二轮 try 覆盖 provider family 校正与账号态刷新，全是尽力而为的展示层动作。
      // 这里的 catch 只记 warn：登录态在上一段已经落定，不能因为后台刷新失败就把用户判成未登录。
      // 也不在此处加复合重试循环，重试会和 provider 视图的正常更新形成两条写入路径，产生竞态。
      try {
        // 启动只读缓存及本地有效期；业务 token 已明确过期时直接重新登录，
        // 不把无 exp 的历史凭据或暂时断网误判成退出。
        const result = await services.oauthService.restoreCachedSessionState();

        // [资源] 首个 await 之后立刻检查卸载标记：此时组件可能已卸载，继续写用户态会落到废弃的 store 引用上。
        // 这里的 return 只结束恢复主流程，后面的恢复中标记落定也会被跳过，这是有意为之。
        // 不要为了“把 loading 收干净”把状态落定提前到检查之前，卸载后写状态同样会触发警告并污染新实例。
        if (disposed) {
          return;
        }

        hasRestoredUser = await applyCachedOAuthSessionRestoreResult({
          result,
          setUser,
          requestAlert,
          onReauthenticationRequired,
          shouldReauthenticate: async () =>
            !disposed && (await services.oauthService.getActiveProvider()) === null,
          copy: {
            title: intl.formatMessage({ id: "login.expired.title" }),
            description: intl.formatMessage({ id: "login.expired.description" }),
            actionLabel: intl.formatMessage({ id: "login.expired.action" }),
          },
        });
      } catch (error) {
        logger.error("[Root] 恢复 OAuth 本地登录态失败:", error);
        if (disposed) {
          return;
        }
      }

      // 启动恢复是异步后台流程，慢网时如果不单独暴露“恢复中”状态，
      // sidebar 会先按 user=null 渲染成“登录”，而登录弹窗又还能读到本地 activeProvider，
      // 用户就会看到“外面未登录、弹窗里已登录提供方”的分裂展示。
      // 这里在恢复主流程结束后立刻落定状态，让 footer 先显示 loading，再收敛到最终登录态。
      setIsRestoringOAuthSession(false);

      try {
        if (hasRestoredUser) {
          const activeProvider = await services.oauthService.getActiveProvider();
          if (disposed) return;
          // [契约] 只有真正恢复出用户才校正 provider family；未恢复用户没有账号上下文，调用会命中空 provider 分支。
          // 传入 activeProvider 而不是让被调函数自己再查一次，避免两次查询之间 provider 被切走导致校正错目标。
          // 该调用与后续账号态刷新顺序不可交换：先定 provider family，再让 Registry 按最终 family 重建。
          await refreshRestoredOAuthProviderFamilyAfterStartup({
            activeProvider,
            services,
            refreshAppSettings,
          });
        }

        // OAuth 会话恢复与 Provider Runtime 刷新保持后台执行，避免首屏等待网络链路。
        await refreshProviderState();
      } catch (error) {
        // 启动刷新失败不能跳过后续订阅，否则网络恢复后账号失效协调也永久停止。
        // 保留当前事实，继续由 Provider View 的正常更新驱动，不另起重试循环。
        logger.warn("[Root] 启动账号配置刷新失败，继续观察后续更新", { error });
      }
    }

    // [并发] 以 void 启动而不是 await：恢复链路包含网络请求，阻塞 effect 会让首屏空等。
    // 因此 cleanup 只能置卸载标记，无法取消在途请求；取消语义由各 await 之后的卸载检查承担。
    // 依赖数组逐项比较，若调用方每次渲染都传入新的 setter 或服务对象，这里的恢复会被反复重启。
    void restoreOAuthSessionInBackground();

    return () => {
      disposed = true;
    };
  }, [
    intl,
    onReauthenticationRequired,
    refreshAppSettings,
    refreshProviderState,
    requestAlert,
    services,
    setIsRestoringOAuthSession,
    setUser,
  ]);

  // [契约] 失效广播订阅只认失效频道，其它频道一律忽略，避免把状态同步消息误当失效信号触发重新登录。
  // 该 effect 与登录恢复互不依赖，独立订阅独立释放；把两者合并会让任一依赖变化都重建另一条链路。
  // 订阅回调里不做重活，只做去重判定后发起一次异步提示，防止主线程被弹窗构造阻塞。
  // 回调内再次查询活跃 provider，是因为广播到达与真正提示之间可能已被别处重新登录，重复提示会误导用户。
  useEffect(() => {
    let disposed = false;
    // [并发] 这个闸门必须同步置真再发起异步提示，结束后在 finally 复位；它是同一轮失效的唯一去重依据。
    // 若改成先 await 再置位，连发的失效广播会同时通过判定，用户看到叠在一起的重复登录弹窗。
    // 它按 effect 实例隔离，重挂载即重置，因此不能承担跨会话的“已经提示过”记忆。
    // 复位放在 finally 而不是 then，是为了让提示失败后闸门也能打开，否则一次失败会永久堵死后续提示。
    let promptPending = false;
    const disposable = services.broadcastService.onMessage((message) => {
      if (message.channel !== ZCODE_JWT_INVALID_BROADCAST_CHANNEL || disposed || promptPending) {
        return;
      }
      promptPending = true;
      // 业务 token 撤销后仍显示头像并要求重启会阻断恢复；与启动过期共用 Welcome 登录入口。
      // [契约] 判定函数里再查一次活跃 provider：广播到达与真正执行提示之间可能已被别处重新登录。
      // 这里复用启动过期那套文案，两条入口必须保持一致，否则同一故障在不同时机措辞不同。
      // 提示失败只记日志：提示本身尽力而为，不能因为弹窗失败去修改登录态。
      void requestOAuthReauthentication({
        setUser,
        requestAlert,
        onReauthenticationRequired: () => {
          if (!disposed) onReauthenticationRequired();
        },
        shouldReauthenticate: async () =>
          !disposed && (await services.oauthService.getActiveProvider()) === null,
        copy: {
          title: intl.formatMessage({ id: "login.expired.title" }),
          description: intl.formatMessage({ id: "login.expired.description" }),
          actionLabel: intl.formatMessage({ id: "login.expired.action" }),
        },
      })
        .catch((error) => logger.error("[Root] 登录失效恢复提示失败", { error }))
        .finally(() => {
          promptPending = false;
        });
    });
    return () => {
      disposed = true;
      disposable.dispose();
    };
  }, [intl, onReauthenticationRequired, requestAlert, services.broadcastService, setUser]);

  // [并发] 轮询 effect 由轮询开关驱动，每次进入都是一轮新登录，因此先复位三个仲裁 ref。
  // 复位必须发生在建立定时器之前；放进 interval 回调会让上一轮的成功标记污染本轮首个失败判定。
  // 定时器间隔一秒是体验与请求量的折中，改小会压到授权服务，改大会让登录完成后的界面响应明显迟钝。
  // cleanup 只清定时器，不清 ref：ref 的复位语义属于下一轮开始，不属于本轮结束。
  useEffect(() => {
    if (!oauthPollingActive) {
      return;
    }
    oauthLoginSucceededRef.current = false;
    oauthLoginSuccessInFlightRef.current = false;
    oauthLoginSuccessOwnerRef.current = null;
    let pollInFlight = false;
    const pollTimer = window.setInterval(() => {
      if (pollInFlight) {
        return;
      }
      pollInFlight = true;
      void services.oauthService
        .pollPendingOAuth()
        .then(async (result) => {
          if (!result || result.kind !== "session") {
            return;
          }
          // [并发] 在 await 收尾编排之前就登记归属并把在途标记置真，是为了让收尾中途抛错也能被识别为本轮自损。
          // 顺序不能反：先 await 再登记，收尾内部抛错时归属仍为空，失败会被误判成外部失败而覆盖登录态。
          // 同一次成功处理只允许一个归属，deep-link 分支会写同名字段，两条路径靠先到先登记实现互斥。
          oauthLoginSuccessOwnerRef.current = "polling";
          oauthLoginSuccessInFlightRef.current = true;
          await handleOAuthCallbackSuccess({
            result,
            platform,
            refreshLatestModelProviderFamilySelection: (provider) =>
              refreshLatestModelProviderFamilySelectionAfterLogin({ provider, services }),
            refreshAppSettings,
            refreshProviderState,
            setProviderFamilyDomain: async (provider) => {
              const domain = resolveProviderFamilyDomainFromOAuthProvider(provider);
              if (domain) {
                await setProviderFamilyDomain(services.settingService, domain);
              }
            },
            setUser,
            setOAuthError,
          });
          oauthLoginSucceededRef.current = true;
          oauthLoginSuccessOwnerRef.current = null;
          oauthLoginSuccessInFlightRef.current = false;
          markOAuthSuccess(result.provider);
          setOAuthPollingActive(false);
        })
        .catch((error) => {
          setOAuthPollingActive(false);
          // [失败路径] 先把自身失败标记快照下来再清 ref：清空后就无法再判断这次抛错是不是收尾步骤自己造成的。
          // 判定为自身失败时向失败判定函数传假值，等于宣布“不要按登录失败处理”。
          // 日志同时打印成功标记与在途标记的当前值，是为了线上能区分“已成功但收尾抛错”和“真正登录失败”。
          const ownSuccessHandlerFailed = oauthLoginSuccessOwnerRef.current === "polling";
          if (ownSuccessHandlerFailed) {
            oauthLoginSuccessOwnerRef.current = null;
            oauthLoginSuccessInFlightRef.current = false;
          }
          const shouldApplyFailure = shouldApplyOAuthPollingFailure(
            oauthLoginSucceededRef.current,
            ownSuccessHandlerFailed ? false : oauthLoginSuccessInFlightRef.current,
          );
          logger.warn("[Root] OAuth polling 失败判定", {
            succeeded: oauthLoginSucceededRef.current,
            successInFlight: oauthLoginSuccessInFlightRef.current,
            shouldApplyFailure,
          });
          if (shouldApplyFailure) {
            setOAuthError(intl.formatMessage({ id: "login.oauth.loginFailure" }));
          }
          logger.error("[Root] OAuth 轮询处理失败:", error);
        })
        .finally(() => {
          pollInFlight = false;
        });
    }, 1_000);

    return () => {
      window.clearInterval(pollTimer);
    };
  }, [
    intl,
    markOAuthSuccess,
    oauthPollingActive,
    platform,
    refreshAppSettings,
    refreshProviderState,
    services,
    setOAuthError,
    setOAuthPollingActive,
    setUser,
  ]);

  // [契约] deep-link 回调 effect 负责注册平台监听，并在挂载完成后通知主进程可以派发。
  // 依赖里包含轮询开关，因此轮询启停会重建监听；重建窗口内到达的回调由主进程的重放保证不丢。
  // 该 effect 不依赖三个仲裁 ref，它们跨实例共享，改成依赖会让重建时读不到上一轮标记。
  useEffect(() => {
    const disposeOAuth = platform.onOAuthCallback(async (url) => {
      try {
        const result = await services.oauthService.handleCallback(url);
        // 取消或切换 flow 会使已接收的回调失效，正常空结果不能被当作登录异常。
        if (!result) {
          logger.info("[Root] 已忽略失效 OAuth 回调");
          return;
        }
        if (result.kind === "attribution") {
          logger.info("[Root] OAuth 登录归因参数已缓存:", result.provider);
          return;
        }
        if (result.kind === "duplicate") {
          logger.info("[Root] 已忽略 polling 完成后的迟到 OAuth deep link");
          return;
        }

        // [并发] deep-link 进入成功分支后同样先登记归属再执行共用收尾，顺序与轮询分支保持一致。
        // 若轮询已先完成，这里会覆盖归属，但因为成功标记已为真，失败判定不会回写登录态。
        // 登记位置必须在所有提前返回之后，否则归因与重复两类结果会污染归属标记。
        oauthLoginSuccessOwnerRef.current = "deep-link";
        oauthLoginSuccessInFlightRef.current = true;
        await handleOAuthCallbackSuccess({
          result,
          platform,
          refreshLatestModelProviderFamilySelection: (provider) =>
            refreshLatestModelProviderFamilySelectionAfterLogin({
              provider,
              services,
            }),
          refreshAppSettings,
          refreshProviderState,
          setProviderFamilyDomain: async (provider) => {
            const domain = resolveProviderFamilyDomainFromOAuthProvider(provider);
            if (!domain) {
              return;
            }
            await setProviderFamilyDomain(services.settingService, domain);
          },
          setUser,
          setOAuthError,
        });
        oauthLoginSucceededRef.current = true;
        oauthLoginSuccessOwnerRef.current = null;
        oauthLoginSuccessInFlightRef.current = false;
        setOAuthPollingActive(false);
        markOAuthSuccess(result.provider);
      } catch (err) {
        // 之前把底层 OAuth 错误原文写入 UI，用户会看到 provider/token 等具体失败原因。
        // 登录页只保留统一可重试提示，具体原因继续进入 logger 便于排查。
        // polling 成功后可能收到迟到/重复的 deep-link；该回调失败不能覆盖已完成的登录态。
        // [失败路径] deep-link 的失败判定比轮询多一个条件：轮询仍活跃时不报错，因为真正的结果会由轮询给出。
        // 自身失败分支直接看成功标记：已成功过就绝不回写失败，避免迟到回调覆盖刚完成的登录。
        // 不是自身失败时复用同一套判定函数，保证两条入口对“成功中”和“已成功”的理解一致。
        const ownSuccessHandlerFailed = oauthLoginSuccessOwnerRef.current === "deep-link";
        if (ownSuccessHandlerFailed) {
          oauthLoginSuccessOwnerRef.current = null;
          oauthLoginSuccessInFlightRef.current = false;
        }
        const shouldApplyFailure = ownSuccessHandlerFailed
          ? !oauthLoginSucceededRef.current
          : shouldApplyOAuthPollingFailure(
              oauthLoginSucceededRef.current,
              oauthLoginSuccessInFlightRef.current,
            ) && !oauthPollingActive;
        logger.warn("[Root] OAuth deep-link 失败判定", {
          succeeded: oauthLoginSucceededRef.current,
          successInFlight: oauthLoginSuccessInFlightRef.current,
          pollingActive: oauthPollingActive,
          shouldApplyFailure,
        });
        if (shouldApplyFailure) {
          setOAuthError(intl.formatMessage({ id: "login.oauth.loginFailure" }));
        }
        logger.error("[Root] OAuth 回调处理失败:", err);
      }
    });
    // [契约] 通知主进程渲染器就绪必须放在注册监听之后，反序会让主进程在无监听时派发早期 deep-link。
    // 该调用不在 cleanup 中撤销，主进程侧是幂等标记，重复通知只是再确认一次已就绪。
    // cleanup 只释放本次注册的回调，别顺手重置三个仲裁 ref，那是轮询 effect 的职责。
    platform.notifyRendererReady();
    return () => {
      disposeOAuth();
    };
  }, [
    intl,
    platform,
    refreshAppSettings,
    refreshProviderState,
    services,
    markOAuthSuccess,
    oauthPollingActive,
    setUser,
    setOAuthError,
    setOAuthPollingActive,
  ]);
}
