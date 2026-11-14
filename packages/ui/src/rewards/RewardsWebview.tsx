// INV-01 每次注入前递增 generation 并记住 epoch，异步读凭据返回后 epoch 不匹配即丢弃；守住位置：inject 首行与 await 之后的早返回；改错故障：切账号后旧账号凭据被写进新页面，积分页显示上一个用户的余额。
// INV-02 凭据只在 guest 当前 URL 通过受信判定时才注入；守住位置：inject 中 isTrustedRewardsUrl 的早返回；改错故障：页内跳转到第三方域名后仍收到 token，凭据被交给外部站点。
// INV-03 注入抛错时只置 error 并记录告警，不得把 ready 置真或吞掉异常；守住位置：inject 的 catch 分支；改错故障：失败被静默吞掉，用户面对一个“加载完成”却始终空白的页面。
// INV-04 ready 仅在 dom-ready 与 did-stop-loading 之后为真，did-start-loading 必须立刻置假；守住位置：start 与 stop 与 loaded 三个监听器；改错故障：加载中执行脚本打在新文档上并被丢弃，页面永远拿不到登录态。
// INV-05 同文档导航不会产生新的 dom-ready，did-stop-loading 必须恢复 ready 并补一次注入；守住位置：stop 回调末尾；改错故障：站内路由跳转后页面掉登录，积分页提示未登录。
// INV-06 只有主框架失败且错误码不是 -3 才展示错误条；守住位置：failed 回调对 isMainFrame 与 errorCode 的联合判断；改错故障：子 iframe 的统计脚本失败也弹告警，或用户点停止后被误报为加载失败。
// INV-07 错误条必须可关闭，重试只走 reload 且不得重建 URL；守住位置：错误条两个按钮的回调；改错故障：一次瞬时失败让顶部永久压着告警，用户只能关掉整个面板。
// INV-08 关闭流程顺序固定为递增 generation、撤销登录态、onClose，且撤销失败不得阻塞关闭；守住位置：close 的 try/catch 与 onClose 的位置；改错故障：关闭按钮在 guest 已销毁时失效，用户被迫重启窗口。
// INV-09 组件卸载同样要撤销凭据，不能只覆盖显式关闭；守住位置：attach 内的 cleanup 与空依赖卸载 effect；改错故障：Root 卸载后 guest 残留登录态，再次打开仍是旧账号。
// INV-10 四个加载监听器必须在重新绑定与卸载时全部移除，且 cleanup 可被重复调用；守住位置：cleanup 末尾的四次 removeEventListener；改错故障：重复绑定后一次加载触发两次注入，revision 跳号并让页面重复初始化。
// INV-11 generation 必须在 cleanup 动手之前递增；守住位置：cleanup 首行的自增；改错故障：清理后仍有在途注入把凭据写回已判定作废的页面。
// INV-12 authSnapshot.revision 只增不减，且仅在凭据指纹变化时递增；守住位置：inject 中的指纹比较分支；改错故障：同一份凭据被反复当作新版本，页面反复重放会话初始化并闪烁重载。
// INV-13 每次注入都必须同时给出 theme、locale 与 auth 三元组；守住位置：两处 createRewardsInjectionScript 调用；改错故障：只改主题时页面仍沿用旧配色，与外壳不一致。
// INV-14 已注入身份与当前 userId 不同时，必须先向页面写匿名态再读新凭据；守住位置：injectedIdentity 的比较分支；改错故障：切账号瞬间旧页面带着上一个账号的 token 继续发请求。
// INV-15 URL 只在首次渲染构造一次，语言与主题变化只走注入通道；守住位置：useState 惰性初始化与空依赖 effect；改错故障：切主题触发 webview 重载，页面重新握手并丢失滚动位置。
// INV-16 加载中占位由 navigation.loading 单独驱动，错误态不得覆盖它；守住位置：标题栏 loading 属性与 did-start-loading；改错故障：慢网下没有任何进度反馈，用户重复点刷新把首次加载打断。
// INV-17 system 偏好必须展开成实际明暗再传给页面，不能把 system 原样注入；守住位置：theme 的三元表达式；改错故障：页面收到无法识别的主题名，回落到默认配色，深色外壳配浅色内容。
// INV-18 provider 只能是 zai 或 bigmodel，凭据只读 access_token 与 zcodejwttoken 两个键；守住位置：provider 归一化与 Promise.all 的键名；改错故障：未知 provider 把空 token 当成有效凭据注入，页面误判已登录后所有接口 401。
// INV-19 webview 必须固定使用 REWARDS_PARTITION，不得落回默认会话；守住位置：webview 的 partition 属性；改错故障：积分页与主应用共享 cookie 与存储，退出登录后积分页仍是登录态。
import { useCallback, useEffect, useRef, useState } from "react";
import {
  buildRewardsUrl,
  createRewardsInjectionScript,
  isTrustedRewardsUrl,
  REWARDS_PARTITION,
  resolveRewardsOrigin,
  ZCODE_ENV,
  type RewardsContext,
} from "@zcode/shared";
import { useServices } from "@/hooks/useServices.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useZCodeStore } from "@/store/StoreProvider.js";
import { resolveTheme } from "@/useTheme.js";
import { logger } from "@/logger.js";
import { Button } from "@/components/ui/button.js";
import { EmbeddedWebsiteHeader } from "@/components/EmbeddedWebsiteHeader.js";

export function RewardsWebview({ onClose }: { onClose: () => void }) {
  const { credentialService, oauthService } = useServices();
  const platform = usePlatform();
  const { intl, locale } = useZCodeIntl();
  const themePreference = useZCodeStore((s) => s.theme);
  const userId = useZCodeStore((s) => s.user?.id ?? null);
  // 系统明暗只读一次作为初值，之后完全交给 change 订阅：每次渲染直接读 matchMedia
  // 不会让组件重渲染，两次渲染之间发生的系统切换会被永久错过。
  // [资源] 订阅句柄必须与创建它的那个 media 实例配对移除：每轮都新建 MediaQueryList 再移除会静默失败，
  // 监听器累积后一次系统切换触发多次 setState，热更新几次后切换明显卡顿。
  // [权衡] 不轮询 matchMedia：轮询既耗电又让切换延迟一帧生效，原生 change 事件没有这两个代价。
  // 这里只存明暗布尔而不是完整主题值：完整值由 themePreference 与它合成，
  // 把 system 也存成 state 会让用户在 system 与固定档之间来回切时同步两份互相覆盖的状态。
  // 依赖数组留空成立的前提是 matchMedia 返回对象在组件生命周期内稳定，浏览器保证同一查询返回同一实例。
  const [systemDark, setSystemDark] = useState(
    () => matchMedia("(prefers-color-scheme: dark)").matches,
  );
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const changed = () => setSystemDark(media.matches);
    media.addEventListener("change", changed);
    return () => media.removeEventListener("change", changed);
  }, []);
  const theme: RewardsContext["theme"] = (
    themePreference === "system" ? systemDark : resolveTheme(themePreference) === "dark"
  )
    ? "zai-dark"
    : "zai-light";
  const env = import.meta.env;
  const policy = { dev: env.DEV, e2e: env.VITE_ZCODE_E2E_STORE_BRIDGE === "1" };
  // URL 只在首次渲染构造一次，之后的语言与主题变化全部走注入；若把它放进依赖重建，
  // 每次切主题都会让 webview 重新加载，页面重新握手并丢失滚动位置与已展开的面板。
  // [失败路径] override 只在环境变量确实是字符串时才参与解析：直接透传会让 undefined 进到 origin 计算里，
  // 得到一段含 undefined 的地址，表现是白屏且不触发 did-fail-load，连错误条都不出现。
  // dev 与 e2e 两个开关收在同一份 policy 里：URL 构造与注入侧的受信判定共用它，两边各自判断迟早分叉，届时合法的 dev 地址会拿不到凭据。
  // [权衡] 初始地址仍带上 locale 与 theme，首帧不必等注入即可渲染正确语言，而代价是切语言后参数过期，
  // 因此页面以注入的 locale 与 theme 为准，地址只当作首次握手参数。
  const [url] = useState(() =>
    buildRewardsUrl(
      resolveRewardsOrigin({
        ...policy,
        env: ZCODE_ENV,
        override:
          typeof env.VITE_REWARDS_WEBVIEW_ORIGIN === "string"
            ? env.VITE_REWARDS_WEBVIEW_ORIGIN
            : undefined,
      }),
      locale,
      theme,
    ),
  );
  // 这一组 ref 共同承担“异步注入不写错页面”的契约：注入流程跨越多次 await，期间 React 可能已重渲染、回调捕获的快照不再是最新值，任何一个 ref 换成 state 都会引入额外重渲染与闭包竞态。
  // generation 在加载开始、绑定变更、关闭与每次注入时递增，而它正是判废在途结果的唯一凭据。
  // ready 表示 guest 桥接已就绪（dom-ready 或同文档导航结束）；为假时执行脚本要么打在旧文档上被丢弃、
  // ready 为假时要么直接抛错，因此所有撤销与注入动作都以它为闸门。
  // injectedIdentity 的初值 undefined 与 null 语义不同：前者表示一次都没写过，而后者表示写过匿名态，
  // 混用会让切账号时的“先撤旧登录”分支少走一次，旧 token 在被覆盖前仍留在页面里。
  // authSnapshot 的 fingerprint 避免同内容跳号、revision 供页面判断新旧，而 latest 是跨 await 的读写通道，
  // effect 尚未执行时闭包值已过期，必须从 ref 再取一次，否则主题与身份会落后一拍。
  const view = useRef<ElectronWebviewTag | null>(null);
  const cleanup = useRef<(() => void) | null>(null);
  const generation = useRef(0);
  const ready = useRef(false);
  const injectedIdentity = useRef<string | null | undefined>(undefined);
  const authSnapshot = useRef({ fingerprint: "", revision: 0 });
  const latest = useRef({ theme, locale, userId });
  // 读取后的身份比较覆盖 React effect 尚未执行的窗口，不能让旧账号写入新页面。
  latest.current = { theme, locale, userId };
  const [error, setError] = useState(false);
  const [navigation, setNavigation] = useState({ loading: true, back: false, forward: false });
  const inject = useCallback(async () => {
    const element = view.current;
    if (!element || !ready.current) return;
    const epoch = ++generation.current;
    const identity = latest.current.userId;
    try {
      const href = element.getURL();
      // [失败路径] 注入前必须核对 guest 当前地址：页内跳转到第三方域名后仍执行注入，等于把 token 交给外部站点，
      // 这是本文件唯一的来源校验点，不能挪到注入之后，也不能只校验首次的 src。
      // 用 getURL 实时读取而不是缓存地址：站内路由与重定向只改 guest 内部文档，ref 上的字符串不会跟着变。
      // 校验失败静默返回而不置 error：跨域跳转可能是网站自身的登录流程，弹错误条属于误报。
      // 受信判定与 URL 构造共用同一份 policy，任一侧单独放宽都会让上面这条泄露路径重新成立。
      if (!isTrustedRewardsUrl(href, policy)) return;
      if (injectedIdentity.current !== identity) {
        // 切账号不能等异步凭据读取完才清旧账号，先撤销当前页面登录态。
        await element.executeJavaScript(
          createRewardsInjectionScript(
            {
              theme: latest.current.theme,
              locale: latest.current.locale,
              auth: {
                status: "anonymous",
                provider: null,
                revision: ++authSnapshot.current.revision,
              },
            },
            {},
            href,
          ),
        );
        injectedIdentity.current = identity;
      }
      const rawProvider = identity ? await oauthService.getActiveProvider() : null;
      const provider =
        rawProvider === "zai" ? "zai" : rawProvider === "bigmodel" ? "bigmodel" : null;
      const [oauth, jwt] = provider
        ? await Promise.all([
            credentialService.load(`oauth:${provider}:access_token`),
            credentialService.load("zcodejwttoken"),
          ])
        : [null, null];
      if (
        view.current !== element ||
        epoch !== generation.current ||
        latest.current.userId !== identity ||
        !ready.current ||
        element.getURL() !== href
      )
        return;
      // [事务] revision 只在指纹变化时递增，页面据此区分“新凭据”与“只是重复注入”。
      // 若每次注入都无脑递增，页面会把同一份 token 当成新登录重放会话初始化，表现为积分数据闪烁重载；
      // 若不递增，真正换了 token 时页面又不会刷新，用户要手动重试才能看到新账号的数据。
      // 指纹必须涵盖身份、provider 与两枚凭据：少一项就漏掉“同账号换 provider”这类变化。
      // [权衡] 用字符串化比较而不是逐字段比对：字段少且都是原始类型，成本可忽略，而逐字段写会在新增凭据时忘记同步，漏判的后果比多判一次严重。
      // 顺序是先写入指纹再递增 revision：颠倒会留下“已发布但未记录”的空档，下一轮会重复发布。
      // 指纹本身不交给页面，页面只认 revision，而凭据摘要因此不会外泄到渲染进程的网页上下文。
      const fingerprint = JSON.stringify([identity, provider, oauth, jwt]);
      if (authSnapshot.current.fingerprint !== fingerprint) {
        authSnapshot.current.fingerprint = fingerprint;
        ++authSnapshot.current.revision;
      }
      const snapshot: RewardsContext = {
        theme: latest.current.theme,
        locale: latest.current.locale,
        auth: {
          provider,
          status: identity && (oauth || jwt) ? "ready" : "anonymous",
          revision: authSnapshot.current.revision,
        },
      };
      await element.executeJavaScript(createRewardsInjectionScript(snapshot, { oauth, jwt }, href));
      if (epoch === generation.current) setError(false);
    } catch {
      if (epoch === generation.current) {
        setError(true);
        logger.warn("[rewards] context injection failed");
      }
    }
  }, [credentialService, oauthService, policy.dev, policy.e2e]);
  const injectRef = useRef(inject);
  injectRef.current = inject;
  useEffect(() => {
    void inject();
  }, [inject, locale, theme, userId]);
  // [资源] attach 既可能收到真实节点，也可能在卸载时收到 null；首行先跑旧 cleanup，
  // 保证换节点时旧监听器与旧凭据先失效，再绑定新节点，否则新旧两套回调会同时响应同一次加载。
  // 四个监听器覆盖完整生命周期：dom-ready 首帧就绪、did-start-loading 进入加载、
  // did-stop-loading 结束（含同文档导航）、did-fail-load 失败。漏掉任何一个都会留下一种卡死状态。
  // 每个回调只读 ref 与稳定的 setter，因此依赖数组可以为空；把 inject 放进依赖会让 ref 回调在每次注入后重建绑定，监听器反复摘下重挂，期间的加载事件直接丢失。
  // [失败路径] cleanup 必须可重复调用：节点替换与组件卸载都会触发，第二次执行时 ready 已为假，
  // 撤销凭据分支自然跳过，不会对已销毁的 guest 再发脚本。
  const attach = useCallback((element: ElectronWebviewTag | null) => {
    cleanup.current?.();
    view.current = element;
    if (!element) return;
    const sync = () =>
      setNavigation((s) => ({ ...s, back: element.canGoBack(), forward: element.canGoForward() }));
    const start = () => {
      ++generation.current;
      ready.current = false;
      setNavigation((s) => ({ ...s, loading: true }));
    };
    const stop = () => {
      sync();
      setNavigation((s) => ({ ...s, loading: false }));
      // Next 语言路由会触发 loading，但同文档导航没有新的 dom-ready；恢复桥接就绪。
      ready.current = true;
      void injectRef.current();
    };
    const loaded = () => {
      ready.current = true;
      sync();
      void injectRef.current();
    };
    // [失败路径] 只有主框架失败才算页面加载失败：子 iframe（统计、广告、验证码）失败时主页面通常仍可用，则不应整页置错。
    // 一并弹错误条会让用户误以为积分页整个打不开，从而放弃使用。
    // 错误码 -3 是主动中止，来自用户点停止、页面调用 stop 或重定向打断，属于正常流程；不排除它，每次站内跳转都会闪一条“加载失败”。
    // 这里只置 error，不动 ready：随后若发生 did-stop-loading 仍会恢复注入；
    // 在失败回调里提前把 ready 置假，会让重试后的一次成功加载反而拿不到凭据。
    // 日志只带错误码与是否主框架，不带完整地址与凭据，而用户信息与 token 因此不会落进日志文件。
    // 错误条上的重试不复用这段逻辑：一次性失败不该把整页判定为不可用，否则只能靠关闭面板恢复。
    const failed = (event: ElectronWebviewDidFailLoadEvent) => {
      if (event.isMainFrame && event.errorCode !== -3) {
        setError(true);
        logger.warn("[rewards] webview load failed", { code: event.errorCode });
      }
    };
    element.addEventListener("dom-ready", loaded);
    element.addEventListener("did-start-loading", start);
    element.addEventListener("did-stop-loading", stop);
    element.addEventListener("did-fail-load", failed);
    cleanup.current = () => {
      ++generation.current;
      // 除显式关闭外，Root 卸载也要撤销凭据；销毁中的 guest 失败可忽略。
      if (ready.current) {
        try {
          void element
            .executeJavaScript(
              createRewardsInjectionScript(
                {
                  theme: latest.current.theme,
                  locale: latest.current.locale,
                  auth: {
                    status: "anonymous",
                    provider: null,
                    revision: ++authSnapshot.current.revision,
                  },
                },
                {},
                element.getURL(),
              ),
            )
            .catch(() => {});
        } catch {
          /* guest 已销毁。 */
        }
      }
      ready.current = false;
      element.removeEventListener("dom-ready", loaded);
      element.removeEventListener("did-start-loading", start);
      element.removeEventListener("did-stop-loading", stop);
      element.removeEventListener("did-fail-load", failed);
    };
  }, []);
  useEffect(
    () => () => {
      cleanup.current?.();
      view.current = null;
    },
    [],
  );
  // [事务] 关闭顺序固定为“递增 generation、撤销登录态、onClose”：递增在前让在途注入全部判废，
  // 撤销在后保证页面在关闭前已转匿名；颠倒会留下一个已判废但仍可能写回凭据的窗口。
  // [资源] 撤销脚本的失败必须被吞掉：guest 可能已被宿主销毁，抛错只会让关闭按钮失效，用户被迫重启窗口；
  // 这与 cleanup 里的 catch 是同一条约定。
  // close 不等待页面确认，脚本调用只做异常兜底而不参与关闭时序。
  // 关闭即卸载：ref 随组件销毁，重新打开是全新挂载，所以这里既不复用实例也不做去重。
  const close = async () => {
    ++generation.current;
    const element = view.current;
    try {
      if (element && ready.current)
        await element.executeJavaScript(
          createRewardsInjectionScript(
            {
              theme,
              locale,
              auth: { status: "anonymous", provider: null, revision: generation.current },
            },
            {},
            element.getURL(),
          ),
        );
    } catch {
      /* WebView 已销毁时不阻塞关闭。 */
    }
    onClose();
  };
  return (
    <section
      data-testid="rewards-surface"
      className="fixed inset-0 z-50 flex flex-col overflow-hidden bg-background pt-12 text-foreground"
    >
      <EmbeddedWebsiteHeader
        title={intl.formatMessage({ id: "rewards.title" })}
        loading={navigation.loading}
        canGoBack={navigation.back}
        canGoForward={navigation.forward}
        onBack={() => view.current?.goBack()}
        onForward={() => view.current?.goForward()}
        onReload={() => view.current?.reload()}
        onClose={() => void close()}
      />
      {error && (
        <div
          role="alert"
          className="mx-auto flex w-full max-w-5xl items-center gap-3 px-6 text-ui-base"
        >
          <span>{intl.formatMessage({ id: "rewards.loadFailed" })}</span>
          <Button
            variant="ghost"
            onClick={() => {
              setError(false);
              view.current?.reload();
            }}
          >
            {intl.formatMessage({ id: "common.refresh" })}
          </Button>
          <Button variant="ghost" onClick={() => void platform.openExternal(url)}>
            {intl.formatMessage({ id: "rewards.openWebsite" })}
          </Button>
        </div>
      )}
      {/* 网页视口必须铺满窗口；限宽交给网站内容，否则滚动条也会被居中内缩。 */}
      <webview
        ref={attach}
        src={url}
        partition={REWARDS_PARTITION}
        className="min-h-0 w-full flex-1 bg-background"
        data-testid="rewards-webview"
      />
    </section>
  );
}
