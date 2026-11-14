// INV-01 图片深浅色选择发生在 CloudImage，dark 为真且 darkSrc 存在才切换——改错会让浅色主题误用暗色资源。
// INV-02 图片组件用 src 作 key 强制重挂——缺了 key 时切换主题会沿用旧 img 的加载状态，出现错图。
// INV-03 ImageResource 的初始状态固定为 loading——改成 ready 会让占位样式在真实加载前就消失，产生闪白。
// INV-04 onLoad 与 onError 是仅有的状态写入点——新增第三条写入路径会让 data-status 与环境不一致。
// INV-05 出错时保留同尺寸空 div 并带 role 与 aria-label——删掉会破坏无障碍树和布局占位。
// INV-06 兜底走 CloudImage 时必须给 type image 与 fit——缺字段会让错误态尺寸与正常态不一致。
// INV-07 object-contain 只在 fit 为 contain 时启用——反转条件会让封面类资源被裁切。
// INV-08 referrerPolicy 固定 no-referrer——移除会把来源信息带进 CDN 请求，属于隐私回退。
// INV-09 CloudVideo 只做主题与 animate 透传，播放控制留在 VideoResource——把播放逻辑上移会重复注册副作用。
// INV-10 VideoResource 的 key 是 src——主题切换后视频必须重新挂载，否则会继续播放旧源。
// INV-11 播放副作用依赖 animate 与 autoplay——遗漏 autoplay 会让用户开关自动播放后行为不更新。
// INV-12 play 的拒绝被静默吞掉并以 pause 作为兜底——去掉处理会产生未处理的拒绝噪音。
// INV-13 清理函数必须 pause——卸载后仍在后台播放会占用解码器与音频会话。
// INV-14 video 固定 muted 与 playsInline——移除后移动端会强制全屏且自动播放被浏览器拒绝。
// INV-15 presentation 模式关闭控件并置 tabIndex 为 -1——漏掉会让放映态出现可聚焦控件。
// INV-16 视频 onError 只置 failed，交给上层渲染 CloudImage 兜底——直接卸载节点会让容器塌陷。
// INV-17 CloudLottie 的 key 拼接 src、loop、speed——少拼一项会导致参数变化不重建动画，停留在旧速率。
// INV-18 Lottie 的 10 秒超时是最后防线，超时即 abort 并置 error——删掉后坏资源会永久停在 loading。
//
// 模块职责：为云内容弹窗提供图片、视频、Lottie 三种媒体 Hero 的渲染与降级，保持容器尺寸稳定。
// 状态所有权：主题与 animate 来自 useCloudHeroEnvironment；加载态与失败态是组件内局部 state，不向上回传。
// 阅读顺序：先看 CloudImage 与 ImageResource 的加载状态机，再看 CloudVideo 的播放副作用，最后看 Lottie 的异步加载与超时。
import { useEffect, useRef, useState } from "react";
import type { AnimationItem } from "lottie-web";
import type {
  CloudImageHero,
  CloudVideoHero,
  CloudLottieHero,
} from "@/components/cloud-content-dialog/cloudContentDialogTypes.js";
import { useCloudHeroEnvironment } from "@/components/cloud-content-dialog/useCloudHeroEnvironment.js";
import { loadCloudLottieData } from "@/components/cloud-content-dialog/cloudLottieRuntime.js";

// 对外契约：只接收 hero，主题由环境 hook 提供，调用方不需要判断深浅色
// 选择逻辑集中在一处，避免每个使用点各写一份三元判断而产生分歧
// 把 src 交给 ImageResource 并作为 key，等于声明换源即换实例
// 若在调用方自行拼 key，主题切换时旧加载状态会被复用，出现错图
// 该组件不感知弹窗布局，尺寸完全交给父容器，改错会出现双重内边距
// 这里只做选择不持有加载状态，状态归属始终在下一层
export function CloudImage({ hero }: { hero: CloudImageHero }) {
  const { dark } = useCloudHeroEnvironment();
  const src = dark && hero.darkSrc ? hero.darkSrc : hero.src;
  return <ImageResource key={src} hero={hero} src={src} />;
}
// ImageResource 是纯展示状态机：loading、ready、error 三态互斥
// 初值必须是 loading，因为首帧还没有 onLoad 证据
// 只有 onLoad 与 onError 能推进状态，不允许父组件直接改写
// error 分支不再渲染 img，避免浏览器继续重试同一个坏地址
// data-status 是对外可观测面，测试与样式都依赖它，不能随意改名
function ImageResource({ hero, src }: { hero: CloudImageHero; src: string }) {
  const [status, setStatus] = useState("loading");
  return (
    <div
      className="size-full bg-surface"
      data-testid="cloud-dialog-image-hero"
      data-status={status}
    >
      {status === "error" ? (
        <div role="img" aria-label={hero.alt} className="size-full" />
      ) : (
        <img
          src={src}
          alt={hero.alt}
          referrerPolicy="no-referrer"
          onLoad={() => setStatus("ready")}
          onError={() => setStatus("error")}
          className={`size-full ${hero.fit === "contain" ? "object-contain" : "object-cover"}`}
        />
      )}
    </div>
  );
}

// CloudVideo 是薄包装：解析主题、透传 animate 与 presentation，不做播放决策
// animate 与 autoplay 必须同时为真才自动播放，缺任一条件都应保持暂停
// presentation 表示放映态，调用方用它关闭交互控件而不是自己再包一层
// title 同时用作 aria-label 与失败兜底图的 alt，语义必须一致
// 组件不缓存视频实例，重挂由 key 保证，避免在 hook 里手写重置
// 若在此层增加播放副作用，会与 VideoResource 内部 effect 竞争同一元素
export function CloudVideo({
  hero,
  title,
  presentation = false,
}: {
  hero: CloudVideoHero;
  title: string;
  presentation?: boolean;
}) {
  const environment = useCloudHeroEnvironment();
  const src = environment.dark && hero.darkSrc ? hero.darkSrc : hero.src;
  return (
    <VideoResource
      key={src}
      hero={hero}
      src={src}
      title={title}
      animate={environment.animate}
      presentation={presentation}
    />
  );
}
// ref 指向真实 video 元素，effect 内先判空再操作，首帧可能尚未挂载
// 自动播放条件来自 props，不直接读 hero，避免绕过主题层的 animate
// 浏览器策略限制下的自动播放失败属于常见情况，静默处理是刻意为之
// pause 分支覆盖用户关闭动画或资源不允许自动播放两种场景
// 卸载时必须 pause，否则弹窗关闭后音频与解码仍在继续
// 依赖数组只放 animate 与 autoplay，hero 其他字段变化不应重跑
function VideoResource({
  hero,
  src,
  title,
  animate,
  presentation,
}: {
  hero: CloudVideoHero;
  src: string;
  title: string;
  animate: boolean;
  presentation: boolean;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    if (animate && hero.autoplay) void video.play().catch(() => {});
    else video.pause();
    return () => video.pause();
  }, [animate, hero.autoplay]);
  // 失败早返回：视频加载错误时整块替换为图片兜底，而不是留下空框
  // 兜底图复用 CloudImage，因此同样享有主题选择与 key 重挂行为
  // 早返回必须位于渲染 video 之前，放到之后会让两个节点同时存在
  // poster 作为兜底 src 是刻意选择，它本就是首帧的代表图
  if (failed)
    return <CloudImage hero={{ type: "image", src: hero.poster, alt: title, fit: hero.fit }} />;
  return (
    <video
      ref={ref}
      src={src}
      poster={hero.poster}
      muted
      playsInline
      controls={!presentation}
      tabIndex={presentation ? -1 : undefined}
      loop={hero.loop}
      autoPlay={Boolean(hero.autoplay && animate)}
      preload="metadata"
      aria-label={title}
      data-testid="cloud-dialog-video-hero"
      onError={() => setFailed(true)}
      className={`size-full ${hero.fit === "contain" ? "object-contain" : "object-cover"}`}
    />
  );
}

// CloudLottie 与另两个组件保持同一契约：主题与 animate 由环境决定
// key 同时包含 src、loop、speed，任一变化都要重建动画实例
// 只拼 src 会让调速或改循环后动画仍按旧参数播放
// 回调速度与 loop 在 LottieResource 内二次应用，key 只是第一道保险
// 该层不加载 lottie 运行时代码，真正的动态引入在资源组件内部
// 保持薄包装可让三种媒体在弹窗里共享同一套挂载语义
export function CloudLottie({ hero, title }: { hero: CloudLottieHero; title: string }) {
  const environment = useCloudHeroEnvironment();
  const src = environment.dark && hero.darkSrc ? hero.darkSrc : hero.src;
  return (
    <LottieResource
      key={`${src}:${hero.loop}:${hero.speed}`}
      hero={hero}
      src={src}
      title={title}
      animate={environment.animate}
    />
  );
}
function LottieResource({
  hero,
  src,
  title,
  animate,
}: {
  hero: CloudLottieHero;
  src: string;
  title: string;
  animate: boolean;
}) {
  const container = useRef<HTMLDivElement>(null);
  const animation = useRef<AnimationItem | null>(null);
  const playback = useRef({ animate, autoplay: hero.autoplay });
  playback.current = { animate, autoplay: hero.autoplay };
  const [status, setStatus] = useState("loading");
  useEffect(() => {
    // controller 把超时、卸载、加载失败统一收敛到 abort 信号
    // 10 秒定时器是兜底而非性能优化，触发的语义就是资源不可用
    // destroy 负责回收动画实例并把 ref 清空，必须与 abort 成对出现
    // 所有异步回调都要先查 aborted 或容器是否存在，防止写已卸载组件
    const controller = new AbortController();
    let item: AnimationItem | undefined;
    const destroy = () => {
      item?.destroy();
      item = undefined;
      animation.current = null;
    };
    const timer = window.setTimeout(() => {
      controller.abort();
      destroy();
      setStatus("error");
    }, 10_000);
    void Promise.all([
      import("lottie-web/build/player/lottie_light_canvas.js"),
      loadCloudLottieData(src, controller.signal),
    ])
      .then(([module, data]) => {
        if (controller.signal.aborted || !container.current) return;
        item = module.default.loadAnimation({
          container: container.current,
          renderer: "canvas",
          autoplay: false,
          loop: hero.loop ?? false,
          animationData: data,
        });
        animation.current = item;
        item.setSpeed(Math.max(0.1, Math.min(4, hero.speed ?? 1)));
        const ready = () => {
          window.clearTimeout(timer);
          if (!controller.signal.aborted) setStatus("ready");
        };
        const fail = () => {
          window.clearTimeout(timer);
          destroy();
          if (!controller.signal.aborted) setStatus("error");
        };
        item.addEventListener("DOMLoaded", ready);
        item.addEventListener("data_failed", fail);
        item.addEventListener("error", fail);
        if (item.isLoaded) ready();
        if (playback.current.animate && playback.current.autoplay) item.play();
        else item.goToAndStop(0, true);
      })
      .catch(() => {
        destroy();
        if (!controller.signal.aborted) setStatus("error");
        window.clearTimeout(timer);
      });
    return () => {
      controller.abort();
      window.clearTimeout(timer);
      destroy();
    };
  }, [src, hero.loop, hero.speed]);
  useEffect(() => {
    if (animate && hero.autoplay) animation.current?.play();
    else animation.current?.pause();
  }, [animate, hero.autoplay]);
  // 最终渲染只有两种出口：有 fallback 时给图片，否则给空容器
  // 容器始终保留，供 lottie 挂载，不能在加载中把节点摘掉
  // status 为 error 且无 fallback 时仍返回空容器，尺寸由父级决定
  // 第二个 effect 只负责播放与暂停，不重复创建动画，避免实例泄漏
  if (status === "error" && hero.fallback) return <CloudImage hero={hero.fallback} />;
  return (
    <div
      ref={container}
      className="size-full"
      role="img"
      aria-label={title}
      data-testid="cloud-dialog-lottie-hero"
      data-status={status}
    />
  );
}
