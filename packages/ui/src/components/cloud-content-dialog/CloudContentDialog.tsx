// INV-01 [契约] 关闭态必须整棵卸载，open 为 false 时返回 null 而不是隐藏外壳；守住位置：CloudContentDialog 的三元返回；改错故障：关闭后实例状态与 Hero 资源仍驻留，重新打开会带着上一次的复制提示。
// INV-02 [事务] 实例身份由 payload.id 与 payload.revision 共同决定；守住位置：CloudContentDialog 传给 CloudContentDialogInstance 的 key；改错故障：切换到另一条内容时复用旧实例，pending 与失败态串到新内容上。
// INV-03 close 动作只调用 onClose，不进入待定与分发流程；守住位置：run 开头对 action.type 的判定；改错故障：关闭被当作异步动作，按钮在关闭瞬间禁用或错误上报失败。
// INV-04 [并发] 重入防护是 actionPending 与 inFlight 的并集，缺一不可；守住位置：run 中的早退判断；改错故障：外部待定期间仍发起调用，同一动作被重复提交到远端。
// INV-05 [并发] inFlight 覆盖整个 await 周期，而非仅同步段；守住位置：run 中置位在 try 之前、复位在 finally 之中；改错故障：连点两次会并行触发两个异步动作，回包顺序错乱。
// INV-06 [失败路径] await 之后的每次写入都必须先确认 mounted；守住位置：run 的 try、catch、finally 内每处 mounted 判定；改错故障：动作返回前对话框已卸载，状态写到已卸载实例并在关闭回调上二次触发关闭。
// INV-07 [事务] dismiss_content 必须等分发成功后才关闭；守住位置：dispatch 返回后对 action.type 的判断；改错故障：先关后发，动作失败时用户看不到提示，内容也没有真正被移除。
// INV-08 [失败路径] 分发异常必须落到 failed 状态而不是被吞掉；守住位置：run 的 catch 分支；改错故障：远端拒绝后界面毫无反馈，用户只能反复点击同一按钮。
// INV-09 [资源] pending 复位只能放在 finally；守住位置：run 的 finally 块；改错故障：分发抛错后按钮永久禁用，用户只能强制关闭对话框。
// INV-10 [资源] 复制提示必须自动过期；守住位置：copiedActionId 的定时器 effect 与 2_000 毫秒常量；改错故障：复制文案长期驻留，后续点击其他按钮仍显示旧的已复制。
// INV-11 [资源] 定时器必须随依赖变化清理；守住位置：copiedActionId effect 返回的清理函数；改错故障：连续复制时旧定时器先触发，新提示被提前清除。
// INV-12 [契约] 按钮可用性同时要求动作存在且处理器已注册；守住位置：available 的布尔表达式；改错故障：远端下发了本端未实现的动作，点击后静默无响应或直接抛错。
// INV-13 动作查找用 Object.hasOwn 判别自有键；守住位置：payload.actions 的取值处；改错故障：原型链上的同名属性被当作真实动作，调用到不存在的处理器。
// INV-14 [权衡] 待定期只禁用非 close 动作；守住位置：disabled 中对 action?.type 的例外判断；改错故障：关闭按钮一起被禁用，慢动作期间用户无法退出。
// INV-15 [资源] 打开记录焦点来源，关闭只恢复到仍连接的元素；守住位置：onOpenAutoFocus 写入 opener 与 onCloseAutoFocus 的 isConnected 判断；改错故障：焦点落回 body，键盘用户丢失位置。
// INV-16 [失败路径] 交互式 bundle 的首焦点必须落在关闭按钮；守住位置：interactive_bundle 分支中的查询与 preventDefault；改错故障：焦点进入跨文档 iframe，Escape 不冒泡到父弹窗，键盘无法关闭。
// INV-17 [契约] 外部链接回调仅在存在 open_external 处理器时注入；守住位置：onOpenExternal 的条件表达式；改错故障：描述中的链接渲染成可点击却无效，或绕过统一的待定与失败上报。
// INV-18 [权衡] 交互式 bundle 必须关闭遮罩的背景滤镜；守住位置：overlayClassName 的 hero 类型判断；改错故障：macOS 圆角外出现方形暗块，视觉回归无法通过。
//
// 模块职责：渲染云端下发的单条内容弹窗，把 Hero、标题、描述与动作按钮组合成受控对话框，并把动作交给外部处理器执行。
// 状态所有权：open 与 payload 归调用方；本文件只持有 pending、failed、copiedActionId 三个瞬时展示态；焦点来源与在飞标记存放在 ref 中。
// 阅读顺序：先看动作分发与处理器类型，再看实例的卸载与 key、run 的重入与失败处理，最后看焦点接管与按钮可用性。
import { useEffect, useRef, useState, type RefObject } from "react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog.js";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { parseCloudDescriptionStyle } from "@/components/cloud-content-dialog/cloudDescriptionStyle.js";
import {
  CloudDialogDescription,
  CloudFormattedTextContent,
} from "@/components/cloud-content-dialog/CloudDialogDescription.js";
import { CloudDialogHero } from "@/components/cloud-content-dialog/CloudDialogHero.js";
import type {
  CloudContentAction,
  CloudContentDialogPayload,
} from "@/components/cloud-content-dialog/cloudContentDialogTypes.js";

// [契约] 键集合来自 CloudContentAction 去掉 close，close 不进入处理器表。
// [事务] 每个处理器拿到的是已收窄的动作类型，可直接读该动作独有的字段。
// [契约] 返回值允许同步或异步，界面不区分两者，统一在 run 中等待。
// [权衡] 全部键可选：远端的动作集合可能大于本端实现，缺失即视为不可用。
// [边界] actionId 是可选的按钮级标识，只有 navigate 会使用它。
// [边界] 该类型只描述调用约定，不承载任何状态，也不是服务层接口。
export type CloudDialogActionHandlers = {
  [K in Exclude<CloudContentAction["type"], "close">]?: (
    action: Extract<CloudContentAction, { type: K }>,
    actionId?: string,
  ) => void | Promise<void>;
};

// [契约] 分发只做类型到处理器的映射，不执行重试、不吞异常；异常由 run 的 catch 统一转成失败提示。
// [契约] close 分支为空返回，真正的关闭只由 run 与 Dialog 的开关回调触发，避免两处重复关闭。
// [契约] navigate 是唯一携带 actionId 的分支，用于区分同一动作下的多个按钮。
// [权衡] 其余分支不传 actionId，回调契约保持最小，处理器无需关心按钮标识。
// [契约] 处理器可为同步或异步，dispatch 直接返回其返回值，由调用方统一等待。
// [失败路径] 处理器缺失时在 run 中提前拦截，此处只做可选调用，正常路径不会走到空实现。
// [边界] 新增动作类型时，映射表与 switch 会因穷尽检查同时报错，不会漏接。
function dispatch(
  action: CloudContentAction,
  handlers: CloudDialogActionHandlers,
  actionId?: string,
) {
  switch (action.type) {
    case "close":
      return;
    case "copy_text":
      return handlers.copy_text?.(action);
    case "navigate":
      return handlers.navigate?.(action, actionId);
    case "open_external":
      return handlers.open_external?.(action);
    case "claim_plan":
      return handlers.claim_plan?.(action);
    case "dismiss_content":
      return handlers.dismiss_content?.(action);
  }
}

type CloudContentDialogProps = {
  payload: CloudContentDialogPayload;
  open: boolean;
  onClose: () => void;
  handlers: CloudDialogActionHandlers;
  labels: { actionFailed: string; copySucceeded?: string };
  actionPending?: boolean;
  returnFocusRef?: RefObject<HTMLElement | null>;
};

// [事务] 打开时才挂载实例，关闭即销毁，组件不保留跨次打开的可视状态。
// [事务] key 带 revision，同一条内容的新版本也会得到全新实例。
// [契约] open 与 payload 由调用方拥有；本组件不缓存内容，也不自行决定何时展示。
// [权衡] 用条件渲染代替受控显隐，换来状态干净，代价是每次打开都重新解析 Hero。
// [边界] props 原样透传给实例，包装层不读取除 open 与身份字段以外的值。
export function CloudContentDialog(props: CloudContentDialogProps) {
  return props.open ? (
    <CloudContentDialogInstance key={`${props.payload.id}:${props.payload.revision}`} {...props} />
  ) : null;
}

function CloudContentDialogInstance({
  payload,
  open,
  onClose,
  handlers,
  labels,
  actionPending = false,
  returnFocusRef,
}: CloudContentDialogProps) {
  // [契约] pending 表示本实例正在等待处理器返回，与外部传入的 actionPending 各自独立。
  // [契约] failed 只表示最近一次分发抛错，新的动作开始时会先清零。
  // [并发] copiedActionId 记录刚复制成功的按钮，而不是布尔值，保证同一时刻只有一处换文案。
  // [资源] 复制提示的存活时间固定为两秒，集中在一个 effect 中管理。
  // [资源] effect 在依赖变化与卸载时都会清掉定时器，避免悬挂回调。
  // [资源] inFlight 是同步重入锁，必须在渲染周期之外读写，因此用 ref 而非 state。
  // [资源] mounted 标记在卸载时立即置否，是所有异步写入的最后一道闸。
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const [copiedActionId, setCopiedActionId] = useState<string>();
  useEffect(() => {
    if (!copiedActionId) return;
    const timer = setTimeout(() => setCopiedActionId(undefined), 2_000);
    return () => clearTimeout(timer);
  }, [copiedActionId]);
  const inFlight = useRef(false);
  const opener = useRef<HTMLElement | null>(null);
  const content = useRef<HTMLDivElement | null>(null);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // [契约] run 是所有入口的唯一执行通道：按钮、描述链接与关闭都从这里走。
  // [事务] 顺序固定为：判关闭、判重入、上锁、清失败、等待分发、按类型收尾、复位。
  // [并发] 重入锁先于任何状态写入，第二次点击在渲染前就被同步挡住。
  // [事务] dispatch 成功且类型为 copy_text 才写入 copiedActionId，并带上具体按钮标识。
  // [事务] dismiss_content 的成功语义包含关闭，失败语义包含保留，两者不可互换。
  // [失败路径] catch 不区分错误种类，统一转成一条可读提示，详细原因留在上层。
  // [失败路径] finally 无条件复位 inFlight，即使 mounted 为假也必须解锁，防止实例复用时卡死。
  // [资源] finally 中的 setPending 才受 mounted 约束，锁本身不受卸载影响。
  // [边界] 关闭分支不设 pending，也不检查处理器，关闭永远可用。
  const run = async (action: CloudContentAction, actionId?: string) => {
    if (action.type === "close") {
      onClose();
      return;
    }
    if (actionPending || inFlight.current || !handlers[action.type]) return;
    inFlight.current = true;
    setPending(true);
    setFailed(false);
    try {
      await dispatch(action, handlers, actionId);
      if (mounted.current && action.type === "copy_text") setCopiedActionId(actionId);
      if (mounted.current && action.type === "dismiss_content") onClose();
    } catch {
      if (mounted.current) setFailed(true);
    } finally {
      inFlight.current = false;
      if (mounted.current) setPending(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        ref={content}
        data-testid="cloud-content-dialog"
        // macOS 窗口合成中，backdrop-filter 与隔离 iframe 叠加会在圆角外留下方形暗块；父层裁切无效。
        overlayClassName={
          payload.dialog.hero?.type === "interactive_bundle" ? "backdrop-filter-none!" : undefined
        }
        // [资源] 打开瞬间记录 document.activeElement 作为焦点来源，供无触发器场景回退。
        // [失败路径] 交互式 Hero 会抢走首焦点，跨文档后 Escape 不冒泡，因此这里改聚焦关闭按钮。
        // [契约] 只有找到关闭按钮才阻止默认行为，找不到时保留 Radix 的原始焦点策略。
        // [资源] 关闭时一律阻止默认行为，因为受控弹窗没有 Trigger 可供 Radix 自动恢复。
        // [失败路径] 恢复目标优先取 returnFocusRef，其次取打开来源，且必须仍在文档中。
        onOpenAutoFocus={(event) => {
          opener.current =
            document.activeElement instanceof HTMLElement ? document.activeElement : null;
          // Radix 默认先聚焦 Hero iframe，跨文档的 Escape 不会冒泡到父弹窗。
          // 初始焦点留在关闭按钮；用户仍可用 Tab 或指针主动进入 Hero。
          if (payload.dialog.hero?.type === "interactive_bundle") {
            const close = content.current?.querySelector<HTMLButtonElement>(
              '[data-slot="dialog-close"]',
            );
            if (close) {
              event.preventDefault();
              close.focus();
            }
          }
        }}
        onCloseAutoFocus={(event) => {
          // 受控弹窗没有 Radix Trigger，默认关闭会丢失焦点；仅恢复仍在页面中的打开来源。
          event.preventDefault();
          const target = returnFocusRef?.current ?? opener.current;
          if (target?.isConnected) target.focus();
        }}
        // Hero 背景独立于 App 主题，关闭按钮用固定媒体覆盖层配色保证可见。
        className="cloud-content-dialog max-h-[calc(100dvh-2rem)] w-[min(480px,calc(100vw-2rem))] max-w-none gap-0 overflow-y-auto border-0 p-0 [&_[data-slot=dialog-close]]:rounded-full"
      >
        {payload.dialog.hero ? (
          <div
            // Hero 与外壳共用顶部圆角，不依赖资源内容自行适配。
            className="aspect-[4/3] w-full overflow-hidden rounded-t-2xl bg-surface"
            data-testid="cloud-dialog-hero-slot"
          >
            <CloudDialogHero
              hero={payload.dialog.hero}
              locale={payload.locale}
              title={payload.dialog.title}
            />
          </div>
        ) : null}
        <section className="flex min-w-0 flex-col items-center gap-6 bg-popover px-6 py-7 text-center text-foreground">
          <div
            data-testid="cloud-dialog-status"
            className="flex w-full min-w-0 flex-col items-center gap-3"
          >
            <DialogTitle className="text-ui-xl font-semibold">
              <CloudFormattedTextContent
                inline
                text={
                  payload.dialog.formattedTitle ?? {
                    format: "plain_text",
                    text: payload.dialog.title,
                  }
                }
              />
            </DialogTitle>
            <DialogDescription asChild>
              <CloudDialogDescription
                data-testid="cloud-dialog-description"
                className="text-center text-ui-base/relaxed text-foreground-subtle"
                description={payload.dialog.description}
                onOpenExternal={
                  handlers.open_external
                    ? (url) => {
                        void run({ type: "open_external", url });
                      }
                    : undefined
                }
              />
            </DialogDescription>
          </div>
          {failed ? (
            <div role="alert" className="text-ui-sm text-destructive">
              {labels.actionFailed}
            </div>
          ) : null}
          <div className="flex w-full flex-wrap items-center justify-center gap-2">
            {payload.dialog.buttons.map((button) => {
              const action = Object.hasOwn(payload.actions, button.actionId)
                ? payload.actions[button.actionId]
                : undefined;
              const available =
                action && (action.type === "close" || Boolean(handlers[action.type]));
              return (
                <Button
                  key={button.id}
                  data-testid="cloud-dialog-action"
                  data-action-id={button.actionId}
                  size="lg"
                  className={cn(
                    "h-10 min-w-32 max-w-full whitespace-normal rounded-full px-6 text-ui-base",
                    button.theme?.class,
                  )}
                  style={parseCloudDescriptionStyle(button.theme?.style ?? null)}
                  variant={
                    button.theme?.variant ??
                    (button.variant === "primary" ? "default" : button.variant)
                  }
                  disabled={!available || ((pending || actionPending) && action?.type !== "close")}
                  onClick={() => {
                    if (action) void run(action, button.actionId);
                  }}
                >
                  {/* 动作类型不代表视觉语义，远端文案可能是“取消”；内容按钮统一不自动加图标。 */}
                  {copiedActionId === button.actionId && labels.copySucceeded ? (
                    labels.copySucceeded
                  ) : (
                    <span className="min-w-0 break-words">
                      <CloudFormattedTextContent
                        inline
                        text={button.formattedLabel ?? { format: "plain_text", text: button.label }}
                      />
                    </span>
                  )}
                </Button>
              );
            })}
          </div>
        </section>
      </DialogContent>
    </Dialog>
  );
}
