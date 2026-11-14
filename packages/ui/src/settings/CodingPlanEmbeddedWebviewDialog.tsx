/* oxlint-disable eslint(max-lines) -- Coding Plan webview 容器集中维护凭据注入、购买完成回传、三方支付导航和错误兜底。 */
// CodingPlanEmbeddedWebviewDialog.tsx —— Coding Plan 官网购买页的全屏 webview 容器：负责可信域校验、凭据注入、购买完成回传与加载失败兜底
// INV-01 webview 的 src 只允许落在 isTrustedCodingPlanEmbeddedWebviewUrl 认可的原生官网 origin；守住位置：computedWebviewUrl 与 handleDomReady；改错故障：环境变量被写成任意域时会把 App 凭据注入第三方页面
// INV-02 URL 只能由 buildCodingPlanEmbeddedWebviewUrl 与 resolveCodingPlanEmbeddedOrigin 构造，禁止在 JSX 里手拼 query；守住位置：computedWebviewUrl；改错故障：provider、audience、teamPlanKey 漏拼任一项，官网展示错误套餐并引导到错误收银台
// INV-03 凭据是否可注入取决于 getURL 的实时 origin，而不是首帧 src 的可信性；守住位置：injectAuth 的可信性分支；改错故障：跳转三方支付页后 dom-ready 再次触发，access token 被写进非官网页面
// INV-04 注入顺序恒为「先清敏感 key、再写当前凭据」，两步合并成一次 executeJavaScript；守住位置：injectAuth 末尾；改错故障：切换账号时旧 token 被官网首屏读到，用户看到上一个账号的订阅状态
// INV-05 webview 使用 persist:zcode-coding-plan 持久分区，与 App renderer 不同分区，凭据必须显式搬运；守住位置：webview 标签与 credentialService.load；改错故障：误以为官网能读 App 存储，页面永远停在未登录态
// INV-06 webviewReadyRef 只在 dom-ready 置真、did-start-loading 置假，executeJavaScript 只在其为真时调用；守住位置：handleDomReady 与 handleDidStartLoading；改错故障：提前注入抛 attach 与 dom-ready 错误，授权静默失败
// INV-07 一次 open 生命周期内只冻结首帧 URL，运行时主题变化不得改 src；守住位置：frozenWebviewUrlRef 的读写分支；改错故障：PayPal 授权页被整页 reload 打断，支付流程中断
// INV-08 关闭时必须把冻结 URL 归零，下一次 open 重新计算；守住位置：open 为假的分支；改错故障：跨团队或跨账号重新打开仍带旧 teamPlanKey，官网进入错误购买上下文
// INV-09 购买完成信号只有一个方向：官网页 preload 发 zcode:coding-plan-purchase-complete，本组件仅做消费方；守住位置：handleIpcMessage；改错故障：反向在 renderer 重发同名频道会与 bridge 协议冲突并触发重复刷新
// INV-10 ipc-message 只按频道与 provider 白名单放行，payload 不合法即丢弃；守住位置：handleIpcMessage 的校验；改错故障：脏数据或伪造 payload 触发权益刷新与关窗，用户付款页被莫名关闭
// INV-11 onPurchaseComplete 必须经 onPurchaseCompleteRef 读取，事件闭包不得捕获 props 原值；守住位置：onPurchaseCompleteRef 的 effect 与 handleIpcMessage；改错故障：上层重渲染后仍是旧回调，刷新的是过期闭包里的 store
// INV-12 Electron 事件在 ref 回调里同步绑定，并在 ref 卸载与组件卸载两处全部解绑，绑定次数恒等于解绑次数；守住位置：handleWebviewRef 尾部与卸载 effect；改错故障：重复绑定让一次购买触发多次刷新，漏解绑则摘掉存活 webview 的必要监听
// INV-13 主 frame 加载失败与渲染进程崩溃都必须落 loadError 并上报 onOpenResult 为假；守住位置：handleDidFailLoad 与 handleRenderProcessGone；改错故障：白屏无兜底，用户既看不到错误也不知道可以去官网购买
// INV-14 子资源失败不进入错误态，只记录日志；守住位置：handleDidFailLoad 的首个判断；改错故障：一个 favicon 或统计脚本 404 就把整个购买页替换成错误卡片
// INV-15 凭据注入失败必须落 authError 并保留页面与重试入口，不得静默吞掉；守住位置：injectAuth 的 catch；改错故障：用户停在未登录骨架态，既无法自救也无法上报
// INV-16 新导航开始时要同时清 authError 与 loadError，错误态不得跨导航残留；守住位置：handleDidStartLoading；改错故障：重试成功后仍顶着上一条错误，用户误以为页面依旧不可用
// INV-17 卸载清理顺序为「先清持久分区凭据、再解绑监听」，且清凭据只在 webviewReadyRef 为真时执行；守住位置：卸载 effect；改错故障：跨账号残留 token 被下一个人读到，或在已销毁 webview 上调用产生未捕获拒绝
// INV-18 全部 hooks 与 provider 解析必须早于 open 为假时的提前 return；守住位置：组件体与 JSX 之前的 if (!open)；改错故障：open 翻转时 hooks 数量变化，React 直接抛错白屏
// INV-19 本组件不注册 Esc 与全局键盘监听，关闭只走 EmbeddedWebsiteHeader 的 onClose，焦点归还交给上层容器；守住位置：return 的 section 与 Header；改错故障：在 webview 聚焦时抢键会吞掉官网输入，Esc 双触发关窗
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ExternalLinkIcon, RefreshCwIcon } from "lucide-react";
import { usePlatform } from "@/hooks/usePlatform.js";
import { RENDERER_ZCODE_ENDPOINT_URLS } from "@/lib/rendererZCodeEndpoint.js";
import { logger } from "@/logger.js";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { EmbeddedWebsiteHeader } from "@/components/EmbeddedWebsiteHeader.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useZCodeStoreWithDefault } from "@/store/StoreProvider.js";
import { normalizeThemePreference, resolveTheme } from "@/useTheme.js";
import type { CodingPlanProviderId } from "@/settings/model-provider-section/constants.js";
import type { CodingPlanFunnelContext } from "@/lib/codingPlanFunnelTelemetry.js";
import {
  buildCodingPlanEmbeddedWebviewUrl,
  buildCodingPlanEmbeddedReportContext,
  createCodingPlanAuthInjectionScript,
  createCodingPlanCredentialClearScript,
  createCodingPlanLangInjectionScript,
  createCodingPlanScrollbarHideScript,
  getCodingPlanCredentialKeys,
  isTrustedCodingPlanEmbeddedWebviewUrl,
  resolveCodingPlanEmbeddedOrigin,
  resolveCodingPlanWebsiteProvider,
  type CodingPlanEmbeddedCredentials,
  type CodingPlanEmbeddedTheme,
  type CodingPlanPurchaseAudience,
  CODING_PLAN_WEBVIEW_OVERRIDE_ENV_KEY,
} from "@/settings/model-provider-section/codingPlanEmbeddedWebview.js";
import {
  CodingPlanWebviewChannels,
  type CodingPlanPurchaseCompletePayload,
  ZCODE_ENV,
  ZCODE_VERSION,
} from "@zcode/shared";

interface CodingPlanEmbeddedWebviewDialogProps {
  credentialService: {
    load(key: string): Promise<string | null>;
  };
  onOpenChange: (open: boolean) => void;
  open: boolean;
  onOpenResult?: (opened: boolean) => void;
  providerId: CodingPlanProviderId;
  funnelContext?: CodingPlanFunnelContext | null;
  audience?: CodingPlanPurchaseAudience;
  teamPlanKey?: string | null;
  /**
   * 官网页购买成功后的回调。
   *
   * 官网页通过 preload 注入的 window.zcodeBridge.notifyPurchaseComplete({ provider })
   * 发送 zcode:coding-plan-purchase-complete 频道消息，本组件在 webview 的
   * ipc-message 事件里识别该频道并触发此回调（经 onPurchaseCompleteRef 防 stale closure）。
   * 上层（CodingPlanUpgradeDialog）在此回调里刷新 entitlements/providers 并关闭 webview。
   */
  onPurchaseComplete?: () => void;
}

interface CodingPlanWebviewImportMetaEnv {
  DEV?: boolean;
  VITE_CODING_PLAN_WEBVIEW_ORIGIN?: string;
  VITE_ZCODE_E2E_STORE_BRIDGE?: string;
}

interface CodingPlanWebviewNavigationState {
  canGoBack: boolean;
  canGoForward: boolean;
  isLoading: boolean;
}

function readCodingPlanWebviewImportMetaEnv(): CodingPlanWebviewImportMetaEnv {
  return ((import.meta as ImportMeta & { env?: CodingPlanWebviewImportMetaEnv }).env ??
    {}) as CodingPlanWebviewImportMetaEnv;
}

export function CodingPlanEmbeddedWebviewDialog({
  credentialService,
  onOpenChange,
  open,
  providerId,
  funnelContext,
  audience,
  teamPlanKey,
  onPurchaseComplete,
  onOpenResult,
}: CodingPlanEmbeddedWebviewDialogProps) {
  // 组件体不接收 intl 与 platform 作为 props，各自在 hook 内取：locale 切换时本组件随 Provider 重渲染，不必上层透传
  // provider 由 providerId 同步解析成官网站点描述而不放进 state：providerId 在本组件生命周期内不变，放 state 只多一次渲染
  // 所有 state 与 useMemo 都在这里一次性声明完，提前 return 之后不得再出现 hook：open 翻转时 hooks 数量必须稳定
  // [并发] 注入、导航同步、错误上报都写在同一批 ref 上：ref 更新不触发渲染，这些高频写入不需要也不应进 state
  // webviewRef 与 webviewCleanupRef 必须成对维护：前者供事件与注入使用，后者保存上一次挂载绑定的解绑函数，不允许只更新其中一个
  // [权衡] 不把 webview 元素放进 state：元素引用变化会引发额外渲染，且 effect 依赖无法表达「同一元素」语义，只能退化成每次都重绑
  // theme 与 userId 订阅的是标量而非整个 store 对象：订阅整个对象会在任意字段变化时重渲染，进而反复重建注入脚本
  const { intl, locale } = useZCodeIntl();
  const platform = usePlatform();
  const theme = useZCodeStoreWithDefault((state) => state.theme, "zai-dark");
  const userId = useZCodeStoreWithDefault((state) => state.user?.id ?? null, null);
  const webviewRef = useRef<ElectronWebviewTag | null>(null);
  const onOpenResultRef = useRef(onOpenResult);
  onOpenResultRef.current = onOpenResult;
  // 当前 locale 作为 webview 语言 hint / 注入值；Locale 与 CodingPlanWebviewLocale 同构。
  const webviewLocale = locale;
  const webviewCleanupRef = useRef<(() => void) | null>(null);
  // webview 是否已 dom-ready：executeJavaScript 只在 ready 后调用，
  // 否则会抛 "WebView must be attached to the DOM and dom-ready emitted"。
  const webviewReadyRef = useRef(false);
  const frozenWebviewUrlRef = useRef<string | null>(null);
  const injectAuthRef = useRef<(webview: ElectronWebviewTag | null) => Promise<void>>(
    async () => {},
  );
  // onPurchaseComplete 通过 ref 在 ref callback / 事件监听器里访问，避免 stale closure
  // （handleWebviewRef 用 useCallback([],) 只绑定一次事件，不依赖 onPurchaseComplete 最新值）。
  const onPurchaseCompleteRef = useRef<(() => void) | undefined>(onPurchaseComplete);
  useEffect(() => {
    onPurchaseCompleteRef.current = onPurchaseComplete;
  }, [onPurchaseComplete]);
  const [authError, setAuthError] = useState<string | null>(null);
  // loadError: webview 加载失败/崩溃时的兜底态。
  // 按用户决策，webview 不可用时只报错并引导去官网购买，不回退到老 Dialog。
  const [loadError, setLoadError] = useState<string | null>(null);
  const [navigationState, setNavigationState] = useState<CodingPlanWebviewNavigationState>({
    canGoBack: false,
    canGoForward: false,
    isLoading: false,
  });
  const provider = resolveCodingPlanWebsiteProvider(providerId);
  const embeddedTheme: CodingPlanEmbeddedTheme =
    normalizeThemePreference(theme) === "zai-dark" || resolveTheme(theme) === "dark"
      ? "zai-dark"
      : "zai-light";
  // URL 计算被 useMemo 包住，依赖只含会影响官网展示语义的项：audience、embeddedTheme、provider、teamPlanKey、webviewLocale
  // origin 每次重算而不缓存：dev 标记与 e2e 桥接开关共同参与可信域判定，缓存会让两者的组合切换后取到旧域名
  // endpointOrigin 取 renderer 侧同一份常量，保证 webview 与 App 走同一套环境域名，不去读第二份配置
  // overrideOrigin 仅在 VITE_CODING_PLAN_WEBVIEW_ORIGIN 存在时生效，其合法性留给注入前的可信性校验把关
  // [失败路径] 这里不抛异常：URL 拼装异常由官网返回错误页，本组件靠 did-fail-load 兜底，在此抛错会让打开动作直接白屏
  // theme hint 与运行时注入共用 embeddedTheme 这一个来源，避免 URL 首帧浅色而脚本写深色造成的闪变
  // audience 与 teamPlanKey 允许为空，省略空参数的职责在构造器，本层不拼 query 以防出现字符串 undefined 这类脏 URL
  // 返回值语义是「本帧希望展示的地址」，不是「当前正在展示的地址」，真实地址以 getURL 的结果为准
  const computedWebviewUrl = useMemo(() => {
    const env = readCodingPlanWebviewImportMetaEnv();
    const origin = resolveCodingPlanEmbeddedOrigin({
      dev: env.DEV === true,
      endpointOrigin: RENDERER_ZCODE_ENDPOINT_URLS.origin,
      e2eStoreBridgeEnabled: env.VITE_ZCODE_E2E_STORE_BRIDGE === "1",
      overrideOrigin: env.VITE_CODING_PLAN_WEBVIEW_ORIGIN,
      zcodeEnv: ZCODE_ENV,
    });
    // URL 带 ?lang= hint 让官网首屏就有正确语言，避免注入前的英文闪烁。
    // 同步带 ?theme= hint，避免官网 SSR 默认 dark 在 App 浅色主题下首帧闪烁。
    return buildCodingPlanEmbeddedWebviewUrl({
      origin,
      provider,
      locale: webviewLocale,
      theme: embeddedTheme,
      audience,
      teamPlanKey,
    });
  }, [audience, embeddedTheme, provider, teamPlanKey, webviewLocale]);
  // 冻结发生在渲染期而非 effect：首帧 src 在挂载时就必须是最终地址，等 effect 再改会先加载一次空 src 再跳转
  // 写入条件带空值判断，所以同一次 open 内重复渲染不会覆盖首帧值，这段渲染期写入是幂等的
  // [并发] 同一次 open 内即使 audience 或 teamPlanKey 后到也不重算：它们由上层在打开前确定，运行期变化意味着上层状态机有问题
  // 关闭分支把 ref 归零，让下一次 open 取当帧 URL：否则跨团队重新打开仍带上一轮的 teamPlanKey
  // webviewUrl 取 ref 优先、计算值兜底，保证首次渲染与后续渲染读到的地址完全一致
  // [权衡] 用 ref 而不是 state 保存冻结值：state 会触发额外渲染并与 useMemo 形成依赖环，ref 的渲染期写入在此处是可控的
  // 关闭到再次打开之间组件可能并不卸载（open 为假时只返回 null），因此归零必须显式写，不能依赖卸载路径
  if (open && frozenWebviewUrlRef.current === null) {
    // theme=system 会随 OS 自动切换，若 src 跟着变化会重载正在授权的 PayPal 页面。
    // Dialog 一次打开生命周期只固定首帧 hint，运行时 theme 仍通过 auth 注入脚本同步给官网。
    frozenWebviewUrlRef.current = computedWebviewUrl;
  } else if (!open && frozenWebviewUrlRef.current !== null) {
    frozenWebviewUrlRef.current = null;
  }
  const webviewUrl = frozenWebviewUrlRef.current ?? computedWebviewUrl;

  // 注入是唯一把 App 凭据交给官网的通道，所有入口最终都落到这里：dom-ready、错误条重试、语言变化后的补偿
  // [失败路径] webview 为空时直接返回而不置错：ref 尚未挂载属于正常时序，报错会闪出用户无法理解的提示
  // 每次注入先清 authError，让重试点击有即时反馈，避免失败后错误条残留导致用户以为没生效
  // getURL 先判函数存在再调用：测试桩与旧版 Electron 类型不提供该方法，直接调用会抛错并中断整条注入链路
  // [权衡] 可信性判断放在注入前而不是导航时：导航事件在 webview 内产生且无法阻断，只有在真正写凭据的那一刻校验才有意义
  // provider 决定要读哪两个 key，key 列表来自 getCodingPlanCredentialKeys 单一来源，避免与存储层写死不同的键名
  // 凭据与 deviceId 并行读取，deviceId 失败降级为空不阻断注入：设备指纹只用于归因上报，缺失不应影响登录态
  // 注入脚本携带 theme 与 locale 快照，因此一次成功注入同时完成首帧视觉与语言的同步
  const injectAuth = useCallback(
    async (webview: ElectronWebviewTag | null = webviewRef.current) => {
      if (!webview) {
        return;
      }
      setAuthError(null);
      try {
        const env = readCodingPlanWebviewImportMetaEnv();
        const currentUrl = typeof webview.getURL === "function" ? webview.getURL() : "";
        if (
          !isTrustedCodingPlanEmbeddedWebviewUrl(currentUrl, {
            e2eStoreBridgeEnabled: env.VITE_ZCODE_E2E_STORE_BRIDGE === "1",
          })
        ) {
          // dom-ready 会在后续主 frame 导航时再次触发，初始 src 可信不代表
          // 当前页面仍是官网购买页。离开可信页后只能做本 origin 清理，不能注入 App 凭据。
          await webview.executeJavaScript(createCodingPlanCredentialClearScript(), true);
          return;
        }
        const keys = getCodingPlanCredentialKeys(provider);
        const [values, deviceMid] = await Promise.all([
          Promise.all(keys.map((key) => credentialService.load(key))),
          Promise.resolve()
            .then(() => platform.getDeviceId())
            .catch(() => null),
        ]);
        const credentials: CodingPlanEmbeddedCredentials =
          provider === "zai"
            ? {
                zaiAccessToken: values[0],
                zcodeJwtToken: values[1],
              }
            : {
                bigmodelAccessToken: values[0],
                // BigModel OAuth callback 同样会落盘 zcode JWT；官网用它在
                // zcode-plan 域查 billing/balance 判定 Start Plan 状态。
                zcodeJwtToken: values[1],
              };
        const reportContext = buildCodingPlanEmbeddedReportContext({
          funnelContext,
          deviceMid,
          userId,
          appVersion: ZCODE_VERSION,
        });
        const script = createCodingPlanAuthInjectionScript({
          provider,
          credentials,
          theme: embeddedTheme,
          locale: webviewLocale,
          reportContext,
        });
        // webview 使用持久 partition，provider/account 切换时不能让旧 token
        // 短暂残留在 localStorage 里被官网首屏逻辑读到。注入前先清敏感 key，再写当前凭据。
        await webview.executeJavaScript(
          `${createCodingPlanCredentialClearScript()};\n${script}`,
          true,
        );
      } catch (error) {
        // WebView 和 App renderer 是不同存储分区，官网页不能直接读 App credentialService。
        // 注入失败时必须给出可重试状态，否则页面会停留在未登录/骨架态且用户无法恢复。
        setAuthError(error instanceof Error ? error.message : String(error));
        logger.warn("[CodingPlanEmbeddedWebviewDialog] 注入购买凭据失败", {
          provider,
          error,
        });
      }
    },
    [credentialService, embeddedTheme, funnelContext, platform, provider, userId, webviewLocale],
  );

  // App locale 运行时变化时，对已 dom-ready 的 webview 注入 lang 更新脚本，
  // 让官网无感切换语言（webviewUrl 变化会整页 reload，这里处理「同一页面内 locale 变了」的场景）。
  // webview 未 dom-ready 时跳过：dom-ready 后的 auth 注入脚本本身会带最新 locale，
  // 无需在这里提前注入（提前 executeJavaScript 会抛 attach/dom-ready 错误）。
  useEffect(() => {
    if (!open) return;
    if (!webviewReadyRef.current) return;
    const webview = webviewRef.current;
    if (!webview) return;
    // locale 热切换只发语言脚本、不重载 webview：整页 reload 会丢掉官网侧已填表单与正在进行的支付会话
    // 脚本单独构造而不复用凭据注入脚本，避免每次切语言都重写存储，减少官网侧读写竞争
    // [失败路径] 这里 catch 后静默：webview 已销毁或正在导航都属于预期竞态，上报只会污染日志
    // 早退条件共三层：未打开、未 dom-ready、ref 为空；任一命中都说明时机未到，交给 dom-ready 时的完整注入处理
    // 依赖数组只含 open 与 webviewLocale，不含 webview 实例：实例变化由 ref 回调重新触发 dom-ready 注入
    const script = createCodingPlanLangInjectionScript(webviewLocale);
    void webview.executeJavaScript(script, true).catch(() => {
      // webview 已销毁时 executeJavaScript 会拒绝，静默即可。
    });
  }, [open, webviewLocale]);

  useEffect(() => {
    injectAuthRef.current = injectAuth;
  }, [injectAuth]);

  const syncNavigationState = useCallback((webview: ElectronWebviewTag | null) => {
    if (!webview) {
      setNavigationState({
        canGoBack: false,
        canGoForward: false,
        isLoading: false,
      });
      return;
    }
    try {
      setNavigationState((current) => ({
        ...current,
        canGoBack: webview.canGoBack(),
        canGoForward: webview.canGoForward(),
      }));
    } catch (error) {
      // 三方支付页导航 churn 中 webview 可能短暂未 attach。
      // 导航按钮只是辅助控件，同步失败不应影响支付流程。
      logger.debug("[CodingPlanEmbeddedWebviewDialog] 同步 webview 导航状态失败", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, []);

  const handleGoBack = useCallback(() => {
    const webview = webviewRef.current;
    if (!webview || !navigationState.canGoBack) return;
    webview.goBack();
    syncNavigationState(webview);
  }, [navigationState.canGoBack, syncNavigationState]);

  const handleGoForward = useCallback(() => {
    const webview = webviewRef.current;
    if (!webview || !navigationState.canGoForward) return;
    webview.goForward();
    syncNavigationState(webview);
  }, [navigationState.canGoForward, syncNavigationState]);

  const handleReloadWebview = useCallback(() => {
    webviewRef.current?.reload();
  }, []);

  // ref 回调承担 webview 的完整生命周期：进入时先解绑上一次，离开时置空 ready 并清空导航态，保证同一时刻只有一套监听
  // [资源] 解绑放在最前而不是最后：React 可能带着新元素调用 ref，先解绑可避免旧元素与新元素短暂共享监听
  // 监听器在 ref 回调里同步绑定，抢在首个 dom-ready 之前完成；放到 effect 里会晚一帧，漏掉首次注入
  // 解绑函数存进 webviewCleanupRef 而不是作为返回值：ref 回调没有返回值语义，而卸载路径需要一处可主动调用的入口
  // 依赖只有 syncNavigationState，它本身稳定，因此本回调引用稳定，不会因父级渲染导致 webview 被重新挂载
  // [失败路径] 元素为空时提前返回前已清空 ready，防止后续 effect 在已卸载的 webview 上注入
  // 这里不设置 src 也不读 webviewUrl：地址完全由 JSX 的 src 驱动，ref 回调再写一次会造成二次导航
  // 导航按钮状态统一由 syncNavigationState 推导，回调里不复制那段带 try 的状态同步逻辑
  const handleWebviewRef = useCallback(
    (element: ElectronWebviewTag | null) => {
      webviewCleanupRef.current?.();
      webviewCleanupRef.current = null;
      webviewRef.current = element;
      if (!element) {
        webviewReadyRef.current = false;
        setNavigationState({
          canGoBack: false,
          canGoForward: false,
          isLoading: false,
        });
        return;
      }
      const handleDomReady = () => {
        // 标记 ready，允许后续 locale 变化的 executeJavaScript 注入。
        webviewReadyRef.current = true;
        syncNavigationState(element);
        // 官网和三方支付页内部会继承各自原生滚动条，接入 App 后与无边框
        // webview 外壳并列出现很突兀；只隐藏 scrollbar，不禁用页面滚动。
        void element
          .executeJavaScript(createCodingPlanScrollbarHideScript(), true)
          .catch((error) => {
            logger.debug("[CodingPlanEmbeddedWebviewDialog] 隐藏 webview 滚动条失败", {
              error: error instanceof Error ? error.message : String(error),
            });
          });
        void injectAuthRef.current(element);
        onOpenResultRef.current?.(true);
      };
      const handleDidStartLoading = () => {
        // 新导航开始：重置 ready，避免在未 ready 的页面上 executeJavaScript。
        webviewReadyRef.current = false;
        setAuthError(null);
        setLoadError(null);
        setNavigationState((current) => ({ ...current, isLoading: true }));
      };
      const handleDidStopLoading = () => {
        setNavigationState((current) => ({ ...current, isLoading: false }));
        syncNavigationState(element);
      };
      const handleNavigation = () => {
        syncNavigationState(element);
      };
      // did-fail-load: 主 frame 加载失败（网络中断、DNS 失败、连接被拒等）。
      // 只对主 frame 报错，避免子资源失败把整个 webview 打成错误态。
      const handleDidFailLoad = (event: ElectronWebviewDidFailLoadEvent) => {
        if (!event.isMainFrame) {
          return;
        }
        const description = event.errorDescription || String(event.errorCode);
        logger.warn("[CodingPlanEmbeddedWebviewDialog] webview 加载失败", {
          provider,
          errorCode: event.errorCode,
          errorDescription: event.errorDescription,
          validatedURL: event.validatedURL,
        });
        setLoadError(description);
        onOpenResultRef.current?.(false);
        setNavigationState((current) => ({ ...current, isLoading: false }));
      };
      // render-process-gone: 渲染进程崩溃/OOM/被杀，webview 已无法恢复，同样进入错误态。
      const handleRenderProcessGone = (event: ElectronWebviewRenderProcessGoneEvent) => {
        logger.warn("[CodingPlanEmbeddedWebviewDialog] webview 渲染进程崩溃", {
          provider,
          reason: event.details.reason,
          exitCode: event.details.exitCode,
        });
        setLoadError(event.details.reason);
        onOpenResultRef.current?.(false);
      };
      // ipc-message: 官网页通过 preload 的 window.zcodeBridge.notifyPurchaseComplete
      // 发回购买完成信号（zcode:coding-plan-purchase-complete）。
      // 参照 useEmbeddedBrowserWheelChain.ts 的 ipc-message handler 模式。
      // 这是官网到 App 的唯一反向通道，只表示「官网页认为购买已完成」，不携带金额与订单号，最终权益仍由主进程查服务端确认
      // [权衡] 频道名从 shared 常量取而不是字面量：preload bridge 与本组件必须严格同一字符串，写错的表现是购买成功后页面永不刷新
      // 非法 payload 分支记录 warning 后返回而不抛错：webview 内页面内容不可信，任何异常都不应穿透到 App 主流程
      // 时间戳只进日志不做校验：它用于排查何时点的购买，不能当幂等键，重复信号由上层刷新逻辑吸收
      // 回调前不判断 open：信号可能在关闭过渡期间到达，是否刷新由上层按自身状态决定，本组件不替它做决定
      // [失败路径] 上层未传 onPurchaseComplete 时可选链让信号被静默丢弃，这是允许的：无人消费时本组件不承担刷新职责
      // payload 取 event.args 首元素，preload bridge 固定只传一个对象，多参派发会被判为非法
      const handleIpcMessage = (event: ElectronWebviewIpcMessageEvent) => {
        if (event.channel !== CodingPlanWebviewChannels.PurchaseComplete) {
          return;
        }
        const raw = event.args[0] as CodingPlanPurchaseCompletePayload | undefined;
        if (raw?.provider !== "zai" && raw?.provider !== "bigmodel") {
          // payload 不合法，忽略，避免伪造或脏数据触发刷新。
          logger.warn("[CodingPlanEmbeddedWebviewDialog] 收到非法的购买完成 payload", {
            channel: event.channel,
            args: event.args,
          });
          return;
        }
        logger.info("[CodingPlanEmbeddedWebviewDialog] 收到官网购买完成信号，触发刷新", {
          provider: raw.provider,
          timestamp: raw.timestamp,
        });
        onPurchaseCompleteRef.current?.();
      };

      element.addEventListener("dom-ready", handleDomReady);
      element.addEventListener("did-start-loading", handleDidStartLoading);
      element.addEventListener("did-stop-loading", handleDidStopLoading);
      element.addEventListener("did-navigate", handleNavigation);
      element.addEventListener("did-navigate-in-page", handleNavigation);
      element.addEventListener("did-fail-load", handleDidFailLoad);
      element.addEventListener("render-process-gone", handleRenderProcessGone);
      element.addEventListener("ipc-message", handleIpcMessage);
      // React effect 绑定可能晚于 <webview> 首轮 dom-ready。
      // ref 挂载时立即绑定 Electron 事件，确保 executeJavaScript 只在 dom-ready 之后发生。
      webviewCleanupRef.current = () => {
        webviewReadyRef.current = false;
        element.removeEventListener("dom-ready", handleDomReady);
        element.removeEventListener("did-start-loading", handleDidStartLoading);
        element.removeEventListener("did-stop-loading", handleDidStopLoading);
        element.removeEventListener("did-navigate", handleNavigation);
        element.removeEventListener("did-navigate-in-page", handleNavigation);
        element.removeEventListener("did-fail-load", handleDidFailLoad);
        element.removeEventListener("render-process-gone", handleRenderProcessGone);
        element.removeEventListener("ipc-message", handleIpcMessage);
      };
    },
    [syncNavigationState],
  );

  useEffect(() => {
    // [资源] 卸载清理顺序固定为「先清凭据、再解绑监听、最后清空解绑引用」：反过来会让监听在清理期间继续触发注入
    // 只在 webviewReadyRef 为真时清凭据：未 ready 的 executeJavaScript 必然拒绝，跳过它比吞掉一次异常更干净
    // 清理使用首次渲染时捕获的 webview 引用，不再读新的 ref 值：卸载点之后 ref 可能已被 React 置空
    // [权衡] 依赖数组为空表示只在真正卸载时执行一次，不在 open 翻转时执行：关闭后组件仍挂载，凭据清理由下一次注入的开头负责
    // executeJavaScript 的拒绝被空 catch 吸收：webview 进程可能先于 renderer 消失，主进程的 clear-all-data 是最后一道兜底
    // 清理后再把 webviewCleanupRef 置空，防止 ref 回调与卸载路径重复调用同一个解绑函数
    // [失败路径] 本 effect 不重置 frozenWebviewUrlRef：它属于打开生命周期，由渲染期分支负责归零
    // 这里不关闭 webview 标签本身：元素随 open 为假返回 null 一起卸载，Electron 会自行销毁 guest 进程
    return () => {
      const webview = webviewRef.current;
      if (webviewReadyRef.current && webview) {
        // 关闭购买页时主动清掉持久 partition 内的凭据 key，降低跨账号残留窗口。
        void webview.executeJavaScript(createCodingPlanCredentialClearScript(), true).catch(() => {
          // webview 可能已销毁，主进程 clear-all-data 会兜底清理 partition。
        });
      }
      webviewCleanupRef.current?.();
      webviewCleanupRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (open) {
      setAuthError(null);
      setLoadError(null);
      setNavigationState({
        canGoBack: false,
        canGoForward: false,
        isLoading: false,
      });
    }
  }, [open, webviewUrl]);

  // 打开官网购买页：webview 不可用时引导用户去官网自行购买。
  const handleOpenWebsite = useCallback(() => {
    platform.openExternal(webviewUrl);
  }, [platform, webviewUrl]);

  // 提前 return 必须在全部 hooks 之后：open 在真假之间切换时 hooks 调用序列保持一致，否则 React 抛错
  // [权衡] 不把整个组件包成条件渲染，而是让组件常驻、内部返回 null：常驻换来 hooks 稳定，代价是关闭期间仍占少量闭包内存
  // 返回 null 会卸载 section 与 webview，Electron guest 进程随之销毁，这就是「关闭即卸载」的落点
  // authError 与 loadError 的清理不在这里做，而由 open 变化时的下一个 effect 处理，避免渲染期产生副作用
  // 此处的提前返回同时保证下方 JSX 里 webviewUrl 与各回调都已定义，不存在半初始化渲染
  if (!open) {
    return null;
  }

  const pageContentWidthClass = "max-w-5xl";

  return (
    <section
      data-testid="coding-plan-upgrade-surface"
      className="fixed inset-0 z-50 flex flex-col overflow-hidden bg-background pt-12 text-foreground"
    >
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <EmbeddedWebsiteHeader
          title={intl.formatMessage({ id: "settings.modelProvider.codingPlan.webview.title" })}
          loading={navigationState.isLoading}
          canGoBack={navigationState.canGoBack}
          canGoForward={navigationState.canGoForward}
          onBack={handleGoBack}
          onForward={handleGoForward}
          onReload={handleReloadWebview}
          onClose={() => onOpenChange(false)}
        />

        <main
          className={cn(
            "mx-auto flex w-full flex-1 flex-col px-6 pt-2 pb-8 max-sm:px-4 max-sm:pt-2 max-sm:pb-5",
            pageContentWidthClass,
          )}
        >
          {authError ? (
            <div className="mb-3 flex items-center justify-between gap-3 rounded-xl border border-border bg-surface p-3 text-ui-base text-foreground-subtle">
              <span>
                {intl.formatMessage({
                  id: "settings.modelProvider.codingPlan.webview.authInjectFailed",
                })}
              </span>
              <Button size="sm" variant="outline" onClick={() => void injectAuth()}>
                <RefreshCwIcon className="size-3.5" />
                {intl.formatMessage({
                  id: "settings.modelProvider.codingPlan.webview.retry",
                })}
              </Button>
            </div>
          ) : null}
          {loadError ? (
            <div
              className="mb-3 flex flex-col gap-3 rounded-xl border border-border bg-surface p-4 text-ui-base text-foreground-subtle"
              data-testid="coding-plan-embedded-webview-load-error"
            >
              <span className="font-medium text-foreground">
                {intl.formatMessage({
                  id: "settings.modelProvider.codingPlan.webview.loadFailed",
                })}
              </span>
              <span className="text-ui-sm text-foreground-subtle">{loadError}</span>
              <div className="flex items-center gap-2">
                <Button size="sm" variant="outline" onClick={handleOpenWebsite}>
                  <ExternalLinkIcon className="size-3.5" />
                  {intl.formatMessage({
                    id: "settings.modelProvider.codingPlan.webview.openWebsite",
                  })}
                </Button>
                <Button size="sm" variant="ghost" onClick={handleReloadWebview}>
                  <RefreshCwIcon className="size-3.5" />
                  {intl.formatMessage({
                    id: "settings.modelProvider.codingPlan.webview.retry",
                  })}
                </Button>
              </div>
            </div>
          ) : null}
          <webview
            ref={handleWebviewRef}
            allowpopups={"" as unknown as boolean}
            partition="persist:zcode-coding-plan"
            src={webviewUrl}
            className={cn(
              "min-h-0 flex-1 bg-background [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
              loadError && "hidden",
            )}
            data-testid="coding-plan-embedded-webview"
          />
        </main>
      </div>
    </section>
  );
}

export { CODING_PLAN_WEBVIEW_OVERRIDE_ENV_KEY };
