// INV-01 每个交互型 Hero 持有全局唯一 instanceId，用于丢弃其他实例的消息；守住位置：CloudInteractiveBundleHero 的惰性 useState；改错故障：跨弹窗消息串扰，主题与动作互相污染。
// INV-02 只接受来源窗口等于当前 iframe contentWindow 的消息；守住位置：isTrustedCloudHeroMessage；改错故障：任意页面都能伪造 action 触发业务回调。
// INV-03 通道号与 instanceId 必须双重校验；守住位置：isCloudHeroResourceMessage；改错故障：旧实例的迟到消息把新实例状态改坏。
// INV-04 打开后 5 秒内未握手必须降级为 error；守住位置：挂载时的超时定时器 effect；改错故障：加载卡死时弹窗顶部出现永久空白。
// INV-05 收到 ready 或 error 都要清理超时定时器；守住位置：handleMessage 的对应分支；改错故障：定时器泄漏并在卸载后触发状态更新。
// INV-06 error 且存在 fallback 时视为已就绪；守住位置：onReadyChange 的同步 effect；改错故障：上层一直等待 ready，骨架屏不撤。
// INV-07 error 分支的渲染顺序是兜底资源优先、同色占位兜底；守住位置：status 为 error 时的提前返回；改错故障：无兜底素材时露出白色块。
// INV-08 没有 resolvedUrl 时不得挂载 iframe；守住位置：CloudDialogHero 的地址判空；改错故障：iframe 请求空地址并抛出安全错误。
// INV-09 展示位禁止点击与键盘焦点；守住位置：iframe 的 tabIndex 与 aria-hidden；改错故障：键盘可进入 Banner，读屏重复朗读装饰内容。
// INV-10 展示位只桥接 hover，永不转发 action；守住位置：action 分支的 presentation 判断；改错故障：Banner 上的点击误触发主流程动作。
// INV-11 reduced-motion 生效时展示位关闭 hover 反馈；守住位置：syncHover 内的媒体查询判断；改错故障：前庭敏感用户仍看到动画反馈。
// INV-12 主题观察必须限定在 documentElement 的 class 属性；守住位置：MutationObserver 的 observe 配置；改错故障：观察整棵树造成明显性能回退。
// INV-13 页面可见性变化要主动通知子内容；守住位置：visibilitychange 监听 effect；改错故障：后台标签页继续播放动画或轮询。
// INV-14 卸载时向 iframe 发送 destroy；守住位置：最后一个 effect 的清理函数；改错故障：子内容残留定时器与监听，造成资源泄漏。
// INV-15 init 消息必须同时携带 theme、locale、reducedMotion 与 data；守住位置：sendInit；改错故障：子内容首帧用错主题或语言后抖动。
// INV-16 iframe 的 sandbox 只授予 allow-scripts；守住位置：iframe 的 sandbox 属性；改错故障：给了同源权限后子内容可触达宿主存储。
// INV-17 iframe 必须声明 no-referrer；守住位置：referrerPolicy 属性；改错故障：外部素材拿到弹窗地址，泄露上下文信息。
// INV-18 Hero 始终以 size-full 撑满容器，兜底图用 object-contain；守住位置：三处 className；改错故障：窄容器或错误态下 Hero 塌成 0 高度。
// INV-19 按 hero 的 type 四类分派，未知类型返回 null；守住位置：CloudDialogHero 的类型判断链；改错故障：新增类型静默渲染为空。
// INV-20 key 用 resolvedUrl，地址变化即重建实例；守住位置：CloudInteractiveBundleHero 的 key；改错故障：换源后复用旧 iframe 而不重新 init。
//
// Hero 区是云内容弹窗顶部的媒体与交互展示槽，本身不持有业务状态。
// 宿主与子内容的职责边界是：宿主给上下文，子内容给事件。
// 阅读顺序建议：消息校验 → 生命周期 effect → 降级渲染 → 类型分派。
import { useCallback, useEffect, useRef, useState } from "react";
import {
  CloudImage,
  CloudVideo,
  CloudLottie,
} from "@/components/cloud-content-dialog/CloudDialogMediaHero.js";
import type {
  CloudDialogHero as CloudDialogHeroDefinition,
  CloudHeroHostMessage,
  CloudHeroResourceMessage,
} from "@/components/cloud-content-dialog/cloudContentDialogTypes.js";

export const CLOUD_HERO_MESSAGE_CHANNEL = "zcode-cloud-hero-v1" as const;

// [并发] 实例号的生成只依赖模块级自增，不读 DOM 也不依赖随机数
// [权衡] 单调递增便于日志与 data-instance-id 对照，代价是长会话下理论上会溢出
let nextCloudHeroInstanceId = 0;

type CloudHeroMessageEvent = Pick<MessageEvent, "data" | "source">;

function isRecord(value: unknown): value is Record<string, unknown> {
  // null 的 typeof 结果同样是 object，必须额外排除，否则空值会被当成合法记录继续解构
  // [失败路径] 这一行是后续所有字段校验的入口，漏掉后会在属性读取处抛错
  return typeof value === "object" && value !== null;
}

function isCloudHeroResourceMessage(value: unknown): value is CloudHeroResourceMessage {
  if (!isRecord(value)) return false;
  if (value.channel !== CLOUD_HERO_MESSAGE_CHANNEL || typeof value.instanceId !== "string") {
    return false;
  }
  switch (value.type) {
    case "ready":
      return true;
    case "action":
      return typeof value.id === "string";
    case "resize":
      // 高度必须是有限数字，NaN 与 Infinity 会让容器尺寸计算失去意义
      // [失败路径] 非法高度直接判定消息无效，避免把异常值写进样式
      return typeof value.height === "number" && Number.isFinite(value.height);
    case "error":
      return typeof value.code === "string";
    default:
      return false;
  }
}

// 消息可信判定是整条链路的唯一入口，宿主不信任任何来源的 postMessage
// 三个条件同时成立才放行：来源窗口一致、结构合规、实例号匹配
// 返回类型谓词让调用方在分派前就拿到收窄后的 data，无需二次断言
export function isTrustedCloudHeroMessage(
  event: CloudHeroMessageEvent,
  frameWindow: Window | null,
  instanceId: string,
): event is CloudHeroMessageEvent & { data: CloudHeroResourceMessage } {
  return (
    frameWindow !== null &&
    event.source === frameWindow &&
    isCloudHeroResourceMessage(event.data) &&
    event.data.instanceId === instanceId
  );
}

// 主题以 documentElement 上的 dark 类为唯一事实来源，不读本地存储也不读 store
// [并发] 每次调用即时读取，跨窗口切换主题后不会用到过期快照
function resolveDocumentTheme(): "light" | "dark" {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

function resolveReducedMotion(): boolean {
  // [权衡] 用可选链兼容缺失 matchMedia 的环境，缺失时按不减弱动效处理
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

// 交互型 Hero 的唯一实现：宿主负责握手与降级，子内容负责渲染与交互
// [资源] 每个实例固定持有一个 iframe、一个超时定时器与一个主题观察器
export function CloudInteractiveBundleHero({
  hero,
  locale,
  title,
  onAction,
  presentation = false,
  hovered = false,
  onReadyChange,
}: {
  hero: Extract<CloudDialogHeroDefinition, { type: "interactive_bundle" }>;
  locale: string;
  title: string;
  onAction?: (actionId: string) => void;
  presentation?: boolean;
  hovered?: boolean;
  onReadyChange?: (ready: boolean) => void;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [instanceId] = useState(() => {
    // [并发] 惰性初始化只在首次挂载执行，即使开发模式双调用也不会复用同一个号
    // 生成后即固定为本次挂载的身份，之后所有宿主消息都携带它
    nextCloudHeroInstanceId += 1;
    return `cloud-hero-${nextCloudHeroInstanceId}`;
  });
  // 三态是本组件唯一的内部状态，不再拆出 ready 布尔值以免组合不一致
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const readyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    // 有兜底资源的错误态等价于已可展示，上层据此撤掉骨架屏
    // 无兜底时错误态仍不算就绪，调用方保留加载或提示失败
    onReadyChange?.(status === "ready" || (status === "error" && Boolean(hero.fallback)));
  }, [status, hero.fallback, onReadyChange]);

  useEffect(() => {
    // [失败路径] 子内容迟迟不握手时，5 秒后主动进入 error，避免无限 loading
    // [权衡] 用状态兜底而不是重试，避免弱网下反复重建 iframe 抬高成本
    readyTimer.current = setTimeout(() => setStatus("error"), 5_000);
    return () => clearTimeout(readyTimer.current);
  }, []);

  // 统一出口：所有宿主到子内容的消息都经此函数，结构由 CloudHeroHostMessage 约束
  const postToHero = useCallback((message: CloudHeroHostMessage) => {
    // 目标源用通配符是因为子内容运行在不可预知的源上，无法提前写出精确 origin
    // 安全性由 sandbox 与入站校验承担，而不是寄希望于投递目标源
    frameRef.current?.contentWindow?.postMessage(message, "*");
  }, []);

  useEffect(() => {
    // [时序] 未就绪时子内容尚未注册监听，此刻发 hover 会丢失且不会补发
    if (!presentation || status !== "ready") return;
    // Banner 的 iframe 必须隔离点击，因此只桥接视觉 hover，不放开原生指针或 action。
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    // hover 由父容器下发，子内容只做视觉呈现，不自行监听指针事件
    const syncHover = () =>
      postToHero({
        channel: CLOUD_HERO_MESSAGE_CHANNEL,
        type: "hover",
        instanceId,
        hovered: hovered && !media?.matches,
      });
    syncHover();
    media?.addEventListener("change", syncHover);
    return () => media?.removeEventListener("change", syncHover);
  }, [hovered, instanceId, postToHero, presentation, status]);

  // init 在 iframe 的 onLoad 之后发送，确保子内容已完成监听注册
  // [时序] 不用轮询等待 ready，靠 iframe 事件定序比互相试探更可靠
  const sendInit = useCallback(() => {
    postToHero({
      channel: CLOUD_HERO_MESSAGE_CHANNEL,
      type: "init",
      instanceId,
      theme: resolveDocumentTheme(),
      locale,
      reducedMotion: resolveReducedMotion(),
      data: hero.data,
    });
  }, [hero.data, instanceId, locale, postToHero]);

  useEffect(() => {
    // 入站消息一律先过可信校验再按类型分派，未识别的类型不做任何处理
    const handleMessage = (event: MessageEvent) => {
      // [时序] 每次消息重新取 contentWindow，iframe 重建后不会沿用旧引用
      if (!isTrustedCloudHeroMessage(event, frameRef.current?.contentWindow ?? null, instanceId)) {
        return;
      }
      switch (event.data.type) {
        case "ready":
          clearTimeout(readyTimer.current);
          setStatus("ready");
          return;
        case "action":
          // 展示位永远不转发 action，避免 Banner 上的点击带动主流程
          // [失败路径] 只有声明过的事件 id 才回调，未注册的 id 被静默忽略
          if (!presentation && Object.hasOwn(hero.events, event.data.id))
            onAction?.(hero.events[event.data.id]!);
          return;
        case "error":
          clearTimeout(readyTimer.current);
          setStatus("error");
          return;
        case "resize":
          return;
      }
    };
    // 监听挂在 window 上，靠实例号区分具体是哪一个 Hero，清理与注册严格配对
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [hero.events, instanceId, onAction, presentation]);

  useEffect(() => {
    const handleVisibility = () => {
      postToHero({
        channel: CLOUD_HERO_MESSAGE_CHANNEL,
        type: "visibility",
        instanceId,
        // [资源] 子内容可据此暂停动画与轮询，降低后台标签页的 CPU 占用
        visible: document.visibilityState !== "hidden",
      });
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, [instanceId, postToHero]);

  useEffect(() => {
    const observer = new MutationObserver(() => {
      postToHero({
        channel: CLOUD_HERO_MESSAGE_CHANNEL,
        type: "theme",
        instanceId,
        theme: resolveDocumentTheme(),
      });
    });
    // attributeFilter 把观察面收窄到 class，主题切换之外的全属性变更不会触发回调
    // 未开启 subtree，整棵文档树的变更不会进入观察队列
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, [instanceId, postToHero]);

  useEffect(() => {
    // [资源] 清理阶段 ref 可能已被置空，先取局部变量确保 destroy 能发到真实窗口
    const frame = frameRef.current;
    return () => {
      frame?.contentWindow?.postMessage(
        {
          channel: CLOUD_HERO_MESSAGE_CHANNEL,
          type: "destroy",
          instanceId,
        } satisfies CloudHeroHostMessage,
        "*",
      );
    };
  }, [instanceId]);

  // [失败路径] 错误态优先渲染兜底资源，其次才是同色占位块
  // 占位块保持 size-full，保证错误时的容器高度与正常态一致
  if (status === "error")
    return hero.fallback ? (
      presentation ? (
        <img src={hero.fallback.src} alt="" className="size-full object-contain" />
      ) : (
        <CloudImage hero={hero.fallback} />
      )
    ) : (
      <div data-testid="cloud-dialog-hero-error" className="size-full bg-surface" />
    );
  return (
    <iframe
      ref={frameRef}
      src={hero.resolvedUrl}
      title={title}
      // 只授予脚本执行能力而不给同源权限，子内容因此读不到宿主存储与 cookie
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      data-testid="cloud-dialog-interactive-hero"
      data-hero-type={hero.type}
      data-instance-id={instanceId}
      data-status={status}
      // 加载完成即握手，这是宿主唯一主动发起初始化的时机
      onLoad={sendInit}
      onError={() => setStatus("error")}
      tabIndex={presentation ? -1 : undefined}
      // 展示位的 iframe 对无障碍树隐藏，避免读屏进入不可交互的装饰内容
      aria-hidden={presentation || undefined}
      className={
        presentation
          ? "pointer-events-none size-full border-0 bg-transparent"
          // size-full 让 iframe 撑满父容器，父级必须有确定高度，否则窄容器下会塌成 0
          : "size-full border-0 bg-surface"
      }
    />
  );
}

// 对外只暴露一个按类型分派的入口，调用方不必知道交互型的具体实现
// [权衡] 分派放在渲染期而非配置期，新增类型只需增加一条判断
export function CloudDialogHero({
  hero,
  locale,
  title,
  onAction,
}: {
  hero: CloudDialogHeroDefinition;
  locale: string;
  title: string;
  onAction?: (actionId: string) => void;
}) {
  // `hero.type === "image"` 是开销最低的分支，既不需要标题也不需要就绪回调。
  if (hero.type === "image") return <CloudImage hero={hero} />;
  if (hero.type === "video") return <CloudVideo hero={hero} title={title} />;
  if (hero.type === "lottie") return <CloudLottie hero={hero} title={title} />;
  // [失败路径] 未知类型返回 null 而不是抛错，单个 Hero 异常不应拖垮整个弹窗
  if (hero.type !== "interactive_bundle") return null;
  // 地址解析失败时降级：有兜底图就展示兜底图，没有则渲染同色占位
  // [失败路径] 绝不把空字符串交给 iframe，否则会产生无意义的加载错误
  if (!hero.resolvedUrl)
    return hero.fallback ? (
      <CloudImage hero={hero.fallback} />
    ) : (
      <div data-testid="cloud-dialog-hero-unresolved" className="size-full bg-surface" />
    );
  return (
    <CloudInteractiveBundleHero
      // [时序] 用地址作 key，换源即重建，新实例重新走一遍 init 握手
      key={hero.resolvedUrl}
      hero={hero}
      locale={locale}
      title={title}
      onAction={onAction}
    />
  );
}
