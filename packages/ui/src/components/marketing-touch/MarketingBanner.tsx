// INV-01 视图按资源键重建：守住位置 key；改错故障 换素材后仍显示旧帧。
// INV-02 资源键优先级：守住位置 三元链；改错故障 iframe 复用旧 URL。
// INV-03 无 bundle 即视为就绪：守住位置 ready 计算；改错故障 图片永久隐藏。
// INV-04 bundle 就绪由子组件回调：守住位置 onReadyChange；改错故障 容器一直零高度。
// INV-05 失焦清悬停：守住位置 blur 监听；改错故障 切走后仍播动效。
// INV-06 页面隐藏清悬停：守住位置 visibilitychange；改错故障 后台仍耗电。
// INV-07 监听在卸载时移除：守住位置 清理函数；改错故障 监听泄漏。
// INV-08 只对鼠标指针置悬停：守住位置 pointerType；改错故障 触摸后悬停卡住。
// INV-09 未就绪时零高度占位：守住位置 style 分支；改错故障 布局跳动。
// INV-10 按钮承担唯一点击入口：守住位置 外层 button；改错故障 内层 iframe 抢焦点。
// INV-11 内层一律 aria-hidden：守住位置 两个 span；改错故障 读屏重复播报。
// INV-12 内层禁止指针事件：守住位置 pointer-events-none；改错故障 点击落进 iframe。
// INV-13 无动作时禁用按钮：守住位置 hasAction；改错故障 点击毫无响应。
// INV-14 加载态优先于关闭：守住位置 三元顺序；改错故障 两个覆盖层重叠。
// INV-15 关闭按钮阻止冒泡：守住位置 stopPropagation；改错故障 关闭同时触发打开。
// INV-16 图片不可拖拽：守住位置 draggable；改错故障 拖拽产生幽灵图。
// INV-17 圆角只在按钮上裁切：守住位置 overflow-hidden；改错故障 素材越过圆角。
// INV-18 关闭与加载共用右上角位：守住位置 absolute 定位；改错故障 覆盖层错位。
//
// 模块职责：渲染营销横幅，承载图片、视频或交互 bundle，并处理打开与关闭。
// 状态所有权：bundle 就绪与悬停为本地状态；开关与文案由父级注入。
// 阅读顺序：先看资源键，再看就绪与悬停，最后看覆盖层分支。
import { Loader2Icon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useEffect, useState } from "react";
import { CloudInteractiveBundleHero } from "@/components/cloud-content-dialog/CloudDialogHero.js";
import { CloudVideo } from "@/components/cloud-content-dialog/CloudDialogMediaHero.js";
import type { CloudDialogHero } from "@/components/cloud-content-dialog/cloudContentDialogTypes.js";

interface MarketingBannerProps {
  src?: string;
  video?: Extract<CloudDialogHero, { type: "video" }>;
  bundle?: Extract<CloudDialogHero, { type: "interactive_bundle" }>;
  locale?: string;
  hasAction: boolean;
  hasClose: boolean;
  actionLabel: string;
  closeLabel: string;
  pendingLabel: string;
  pending: boolean;
  onClick: () => void;
  onClose: () => void;
}

// MarketingBannerView 按资源键重建子树。
// 键优先 bundle，再视频，最后图片。
// {...props} 把全部属性原样下传给 MarketingBannerContent。
// 资源全缺时渲染 <img src={props.src}> 分支。
export function MarketingBannerView(props: MarketingBannerProps) {
  return (
    <MarketingBannerContent
      key={props.bundle?.resolvedUrl ?? props.video?.src ?? props.src}
      {...props}
    />
  );
}

// bundle 就绪由回调更新。
// 无 bundle 即视为就绪。
// onPointerEnter 只在 pointerType === "mouse" 时置 hovered。
// useEffect 的清理函数移除两个监听。
function MarketingBannerContent(props: MarketingBannerProps) {
  const [bundleReady, setBundleReady] = useState(false);
  const [hovered, setHovered] = useState(false);
  // ready 为假时 style 给 height: 0 并隐藏。
  // ready 为真时 style 为 undefined，恢复文档流。
  // opacity 不在外层设置，交给内容组件。
  // height: 0 占位避免加载完成时布局跳动。
  const ready = !props.bundle || bundleReady;
  // window "blur" 事件清掉 hovered。
  // visibilitychange 为 hidden 时清 hovered。
  // 清理函数同时移除 blur 与 visibilitychange。
  // 依赖数组为空，监听只注册一次。
  useEffect(() => {
    const clearHover = () => setHovered(false);
    const onVisibility = () => {
      if (document.visibilityState === "hidden") clearHover();
    };
    window.addEventListener("blur", clearHover);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("blur", clearHover);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);
  return (
    <div
      className="relative w-full"
      data-testid="marketing-banner"
      aria-busy={props.pending}
      onPointerEnter={(event) => setHovered(event.pointerType === "mouse")}
      onPointerLeave={() => setHovered(false)}
      onPointerCancel={() => setHovered(false)}
      style={ready ? undefined : { height: 0, overflow: "hidden", visibility: "hidden" }}
    >
      {/* 由同一按钮裁切图片与 iframe，避免资源越过圆角；关闭/loading 保留为兄弟覆盖层。 */}
      <button
        type="button"
        disabled={!ready || props.pending || !props.hasAction}
        aria-label={props.hasAction ? props.actionLabel : undefined}
        onClick={props.onClick}
        className="block h-24 w-full overflow-hidden rounded-xl border border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/50 disabled:cursor-default"
      >
        {props.bundle ? (
          <span
            className="pointer-events-none block size-full overflow-hidden"
            aria-hidden="true"
            inert
          >
            <CloudInteractiveBundleHero
              hero={props.bundle}
              locale={props.locale ?? "en-US"}
              title={props.actionLabel}
              presentation
              hovered={ready && !props.pending && hovered}
              onReadyChange={setBundleReady}
            />
          </span>
        ) : props.video ? (
          <span
            className="pointer-events-none block size-full overflow-hidden"
            aria-hidden="true"
            inert
          >
            <CloudVideo hero={props.video} title={props.actionLabel} presentation />
          </span>
        ) : (
          <img
            src={props.src}
            alt={props.hasAction ? props.actionLabel : ""}
            className="block size-full object-cover"
            draggable={false}
          />
        )}
      </button>
      {props.pending ? (
        // 原 bg-card 让关闭/loading 带上常驻底色；两种状态都保持透明。
        <span
          role="status"
          className="absolute right-2.5 top-2.5 flex size-5 items-center justify-center rounded-full text-foreground"
        >
          <Loader2Icon
            className="size-3.5 animate-spin motion-reduce:animate-none"
            aria-hidden="true"
          />
          <span className="sr-only">{props.pendingLabel}</span>
        </span>
      ) : props.hasClose ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={props.closeLabel}
          onClick={(event) => {
            event.stopPropagation();
            props.onClose();
          }}
          className="absolute right-2.5 top-2.5 rounded-full text-foreground-subtle hover:bg-hover hover:text-foreground focus-visible:ring-foreground/50"
        >
          <XIcon aria-hidden="true" />
        </Button>
      ) : null}
    </div>
  );
}
