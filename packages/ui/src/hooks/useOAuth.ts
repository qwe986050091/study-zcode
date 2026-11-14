// INV-01 每次登录自增 attempt：守住位置 startLogin 首行；改错故障 旧请求回流覆盖新登录状态。
// INV-02 attempt 不一致即静默返回：守住位置 成功与失败两处比较；改错故障 旧失败关闭新流程的轮询。
// INV-03 启动失败只显示通用文案：守住位置 setError 的 i18n 调用；改错故障 登录页泄漏 provider 与 token 细节。
// INV-04 只有本地凭据解密失败可降级：守住位置 isCredentialDecryptError；改错故障 RPC 错误被当成未登录吞掉。
// INV-05 解密失败仍保留 provider 列表：守住位置 只清 activeProvider；改错故障 用户看到没有任何登录渠道。
// INV-06 列表加载失败才同时清空两者：守住位置 外层 catch；改错故障 局部失败让整页变空。
// INV-07 loadingProviders 必在 finally 收尾：守住位置 finally；改错故障 失败后骨架屏永不结束。
// INV-08 轮询开关只对智谱与 BigModel 打开：守住位置 两个 id 比较；改错故障 其他 provider 白等回调。
// INV-09 先登记 state 再打开浏览器：守住位置 调用顺序；改错故障 回调先到而 state 尚未登记。
// INV-10 埋点只上报 hostname：守住位置 resolveSafeTelemetryHostname；改错故障 state 参数进日志。
// INV-11 cancel 同样自增 attempt：守住位置 cancel 首行；改错故障 取消后旧回调重新拉起等待态。
// INV-12 成功回调必须刷新列表：守住位置 setOAuthSuccess；改错故障 登录后界面仍显示未登录。
// INV-13 回调监听不在本 hook：守住位置 文件头约定；改错故障 出现多份监听，回调被处理两次。
//
// 模块职责：发起 OAuth 登录并维护登录 UI 状态，回调监听由常驻层负责。
// 阅读顺序：先看 attempt 防串号，再看 provider 刷新与启动登录，最后看取消与回调注入。
/**
 * useOAuth —— OAuth 登录流程 hook
 *
 * 仅负责发起登录和 UI 状态管理。
 * OAuth 回调监听在 Root/App 常驻层，不在此 hook 中。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { OAuthProviderId, OAuthProviderMeta } from "@zcode/shared";
import {
  BIGMODEL_PROVIDER_ID,
  isCredentialDecryptError,
  resolveSafeTelemetryHostname,
  ZAI_PROVIDER_ID,
} from "@zcode/shared";
import { reportAppTelemetryEvent } from "@/lib/appTelemetry.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { LoginEntryPurpose } from "@/store/index.js";
import { useZCodeStore } from "@/store/StoreProvider.js";
import { logger } from "../logger.js";
import { usePlatform } from "./usePlatform.js";
import { useServices } from "./useServices.js";

type OAuthStatus = "idle" | "waiting" | "error";

export function useOAuth() {
  const { oauthService } = useServices();
  const platform = usePlatform();
  const { intl } = useZCodeIntl();
  const [status, setStatus] = useState<OAuthStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [providers, setProviders] = useState<OAuthProviderMeta[]>([]);
  const [activeProvider, setActiveProvider] = useState<OAuthProviderId | null>(null);
  const [loadingProviders, setLoadingProviders] = useState(true);
  const [pendingProvider, setPendingProvider] = useState<OAuthProviderId | null>(null);
  const loginAttemptRef = useRef(0);
  const setOAuthPollingActive = useZCodeStore((state) => state.setOAuthPollingActive);

  const refreshProviders = useCallback(async () => {
    try {
      setLoadingProviders(true);
      // 先设置加载态再请求，失败路径统一由外层 catch 兜住。
      // provider 列表成功就立刻落地，不等 active provider。
      const providerList = await oauthService.getProviders();
      setProviders(providerList);

      try {
        const active = await oauthService.getActiveProvider();
        setActiveProvider(active);
      } catch (err) {
        // 只有本地 OAuth 凭据解密失败才可恢复为未登录态；RPC/存储权限等错误需要走外层错误路径。
        // 只有本地解密失败能降级：它代表凭据坏了而不是链路坏了。
        // 其它错误必须抛出，否则真实的 RPC 故障会被当成未登录。
        // 降级时仅清 active provider，登录渠道列表保持可见。
        if (!isCredentialDecryptError(err)) {
          throw err;
        }

        // active provider 只是登录态指针，解密失败时服务层会清理 OAuth 凭据。
        // provider 列表仍然可用，不能让用户看到“没有登录渠道”。
        logger.warn("[useOAuth] 加载 active provider 凭据失败，已按未登录处理:", err);
        setActiveProvider(null);
      }
    } catch (err) {
      logger.error("[useOAuth] 加载 provider 列表失败:", err);
      setProviders([]);
      setActiveProvider(null);
    } finally {
      setLoadingProviders(false);
    }
  }, [oauthService]);

  useEffect(() => {
    void refreshProviders();
  }, [refreshProviders]);

  const startLogin = useCallback(
    async (provider: OAuthProviderId, options: { purpose?: LoginEntryPurpose } = {}) => {
      // 自增即作废旧请求：之后所有旧回调都会被 attempt 比较挡掉。
      // 这一步必须在任何 await 之前，否则两个登录会拿到同一编号。
      // 清 error 与置 waiting 放在同一批状态更新里，避免中间态闪现。
      const loginAttempt = ++loginAttemptRef.current;
      try {
        setStatus("waiting");
        setError(null);
        setPendingProvider(provider);

        const {
          authorizeUrl,
          state,
          provider: startedProvider,
        } = await oauthService.startOAuthWithPolling(provider);

        // `startOAuthWithPolling` 返回后再比一次 `loginAttemptRef`：期间可能有更新的登录发起，旧请求不登记 state。
        // 被作废的请求不登记 state、不打开浏览器、不切轮询开关。
        if (loginAttemptRef.current !== loginAttempt) {
          return;
        }

        // 先登记 state 再打开浏览器，避免回调早于登记到达。
        // 轮询开关只对需要轮询的两家 provider 打开。
        // 埋点只取 hostname，完整授权地址含 state 不得外泄。
        platform.registerOAuthState({ state, provider: startedProvider });
        setOAuthPollingActive(
          startedProvider === ZAI_PROVIDER_ID || startedProvider === BIGMODEL_PROVIDER_ID,
        );
        platform.openExternal(authorizeUrl);
        void reportAppTelemetryEvent(
          platform,
          {
            elementName: "app_login_ck",
            eventRegion: "app",
            eventType: "ck",
            eventExtraDetail: {
              // 授权 URL 含 state/凭据参数；埋点只取 hostname，浏览器仍使用上面的完整地址。
              login_url: resolveSafeTelemetryHostname(authorizeUrl),
            },
          },
          "useOAuth",
        );

        logger.info("[useOAuth] OAuth 流程已启动，等待浏览器回调", {
          provider: startedProvider,
          purpose: options.purpose ?? "app-login",
        });
      } catch (err) {
        // 旧 init 的失败可能晚于新登录成功返回，不能反向关闭新 flow 的轮询或覆盖 UI。
        if (loginAttemptRef.current !== loginAttempt) {
          return;
        }
        logger.error("[useOAuth] 启动 OAuth 失败:", err);
        setOAuthPollingActive(false);
        setStatus("error");
        // OAuth 启动失败也属于登录失败，不把服务端或平台错误原文展示给用户。
        // 原文通过 i18n 渲染，避免登录页出现 provider/token 等具体失败原因。
        // 失败态只给通用文案，原始错误留在日志里。
        // 同时关轮询并清 pending，避免界面停在等待态。
        // 错误文案通过 i18n 渲染，不直接拼接服务端字符串。
        setError(intl.formatMessage({ id: "login.oauth.loginFailure" }));
        setPendingProvider(null);
      }
    },
    [intl, oauthService, platform, setOAuthPollingActive],
  );

  const cancel = useCallback(
    async (provider?: OAuthProviderId) => {
      loginAttemptRef.current += 1;
      await oauthService.cancelPending(provider);
      setOAuthPollingActive(false);
      setStatus("idle");
      setError(null);
      setPendingProvider(null);
    },
    [oauthService, setOAuthPollingActive],
  );

  const reset = useCallback(() => {
    setStatus("idle");
    setError(null);
    setPendingProvider(null);
  }, []);

  /** 由 Root/App 层的回调监听器调用，更新 UI 状态 */
  const setOAuthError = useCallback((message: string) => {
    setStatus("error");
    setError(message);
    setPendingProvider(null);
  }, []);

  const setOAuthSuccess = useCallback(async () => {
    setStatus("idle");
    setError(null);
    setPendingProvider(null);
    await refreshProviders();
  }, [refreshProviders]);

  return {
    startLogin,
    cancel,
    reset,
    status,
    error,
    providers,
    activeProvider,
    loadingProviders,
    pendingProvider,
    refreshProviders,
    setOAuthError,
    setOAuthSuccess,
  };
}
