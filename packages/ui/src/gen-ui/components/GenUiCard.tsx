// GenUiCard.tsx —— 生成式 UI 卡片的唯一宿主：页面获取、快照订阅、占位与失败态、行内与全屏两套工具条、参数确认弹窗
// INV-01 标题永远非空：reference.title 缺失或为空串时回退到 i18n 的通用标题；守住位置：title 的赋值处；改错故障：工具条 aria-label 与预览层标题同时为空，读屏只能念出图标，用户无法判断这是哪张卡片
// INV-02 确认弹窗里 title 只作为描述，不再生成一个与「确认」同级的标题；守住位置：确认弹窗的 DialogDescription；改错故障：读屏连续播报两条同名标题，用户分不清当前停留在哪一层对话框
// INV-03 同一时刻只存在一组动作按钮，行内工具条与预览层工具条互斥；守住位置：占位块下方的 controls 调用与 DialogContent 内的 controls 调用；改错故障：复制按钮出现两份，用户点到的可能被全屏层遮住，点击落空后误判功能损坏
// INV-04 展开态只有 expanded 一个所有者，行内按钮、预览层关闭按钮、遮罩按下与 esc 信号都写同一个 setExpanded；守住位置：三处写入口；改错故障：遮罩关闭后本地视图已关而状态仍为真，再点展开毫无反应，只能刷新页面
// INV-05 escapeSequence 是唯一能被动收起预览的通道，序号变化必须让预览退出；守住位置：监听 escapeSequence 的 effect；改错故障：生成层要求让位时用户仍停在全屏层，底层会话被永久遮挡
// INV-06 复制在 copying 为真或快照非 ready 时必须禁用，点击只允许触发一次；守住位置：复制按钮的 disabled 与 onClick 入口；改错故障：连点写入两次剪贴板，第二次可能写进刚被替换的新帧，用户粘贴出非预期画面
// INV-07 复制失败必须落到 error 并渲染为 role=alert，且每次复制开始前先清空；守住位置：onClick 的置空与 catch 分支；改错故障：失败静默，用户以为已复制，粘贴出来的是上一次的旧图片
// INV-08 确认请求只有一个槽位，新请求覆盖前必须先用空值结束上一个；守住位置：confirm 内对旧 resolver 的调用；改错故障：前一个 await 永不返回，生成层卡在该处不再出图
// INV-09 组件卸载时必须用空值结束尚未完成的确认请求；守住位置：挂载 effect 返回的清理函数；改错故障：promise 悬挂，已卸载卡片的闭包与回调被长期持有
// INV-10 发送按钮在草稿去空白后为空时禁用，取消、遮罩与关闭一律以空值收尾；守住位置：发送按钮的 disabled 与 finish 的空值分支；改错故障：空字符串被当成有效参数提交，生成层收到无意义输入后重试整轮
// INV-11 确认弹窗打开期间预览锚点必须停止绑定，关闭后重新绑定；守住位置：PreviewAnchor 的 suspended 入参；改错故障：两层 top layer 争用同一宿主，预览压在确认框上导致无法输入
// INV-12 占位高度直接取快照里的 height，不做二次换算与偏移；守住位置：PageAnchor 的 height 入参；改错故障：占位高度与真实内容不符，卡片下方多出空白或内容被裁掉一截
// INV-13 绑定与预览都必须发生在布局阶段，且在卸载或 page 替换时解除；守住位置：两个锚点组件的 useLayoutEffect 清理；改错故障：旧 page 仍指向已卸载节点，生成内容画到脱离文档的 DOM 上，界面空白
// INV-14 page 缺失时订阅函数必须是模块级稳定引用，不得内联新函数；守住位置：useSyncExternalStore 的第一个参数；改错故障：每次渲染都换订阅器，React 反复退订重订，快照与渲染错帧表现为内容闪动
// INV-15 首帧与服务端快照必须返回同一个常量对象；守住位置：useSyncExternalStore 的第三个参数；改错故障：hydration 前后快照不同源，卡片首帧报错或先闪成空态
// INV-16 宿主不支持时只显示 desktopOnly，不得获取页面也不得给出重试；守住位置：status 的第一段三元与重试按钮的 supported 前置；改错故障：Web 端出现永远无效的重试按钮，用户反复点击仍停在失败态
// INV-17 未知 schema、离线与获取失败统一收敛成一句可读文案加可重试出口，不渲染半截生成内容；守住位置：status 的后两段三元与 acquisitionError 分支；改错故障：未知卡片渲染成一片空白，用户既看不到原因也没有恢复手段
// INV-18 加载指示只在支持、在线、快照非 error 且无获取错误时出现，并始终覆盖内容区；守住位置：loading 表达式与占位块的渲染条件；改错故障：失败态仍在转圈，用户等待一个不会到来的结果
// INV-19 预览关闭后焦点必须回到行内展开按钮；守住位置：onCloseAutoFocus 与 expandButton；改错故障：键盘用户关闭预览后焦点落回文档开头，需要重新 Tab 穿过整页才能回到卡片
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Copy, Loader2, Maximize2, SlidersHorizontal, X } from "lucide-react";
import type { GenUiReference } from "@zcode/shared/gen-ui";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogPortal,
} from "@/components/ui/dialog.js";
import { Textarea } from "@/components/ui/textarea.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useGenUi } from "@/hooks/useGenUi.js";
import { EMPTY_GEN_UI_SNAPSHOT, type GenUiCardTarget, type GenUiPage } from "../contract.js";
import { TweakPanel } from "./TweakPanel.js";
// 订阅函数放在模块作用域，因为 useSyncExternalStore 按引用相等决定是否重新订阅
// 若写成内联箭头函数：每次渲染都是新引用，React 会先退订再重订，page 上的监听器被拆装两次
// [并发] 退订走 subscribe 返回的清理函数，page 切换时旧监听器先失效，新 page 的监听器后挂上
// page 为空时也必须给出一个函数，不能传 undefined，否则 useSyncExternalStore 直接抛错
// 返回的清理函数保持空操作：没有页面就没有监听器可摘，写清理逻辑反而会掩盖真正的订阅泄漏
// [权衡] 不用 useCallback 包一层：模块级常量零分配，且所有卡片实例共享同一引用
// 订阅只负责通知变化，真正读值的是 page 的 getSnapshot，两者必须成对来自同一个 page
const subscribeEmpty = () => () => {};
function PageAnchor({ page, height }: { page: GenUiPage; height: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => (ref.current ? page.bind(ref.current) : undefined), [page]);
  return (
    <div
      ref={ref}
      style={{ height, width: "calc(100% + 10px)", margin: -5 }}
      data-testid="gen-ui-anchor"
    />
  );
}
function PreviewAnchor({
  page,
  suspended,
  hasPanel,
}: {
  page: GenUiPage;
  suspended: boolean;
  hasPanel: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (suspended || !ref.current) return;
    page.preview(ref.current);
    return () => page.preview(null);
  }, [page, suspended]);
  // 预览位于 top layer，外层 Dialog 无法裁切；锚点向承载层传递实际底部圆角。
  return (
    <div
      ref={ref}
      className="min-h-0 flex-1"
      style={{
        borderBottomLeftRadius: hasPanel ? 0 : "inherit",
        borderBottomRightRadius: hasPanel ? 0 : "inherit",
      }}
      data-testid="gen-ui-preview-anchor"
    />
  );
}
export function GenUiCard({
  target,
  reference,
}: {
  target: GenUiCardTarget;
  reference: GenUiReference;
}) {
  const { intl } = useZCodeIntl();
  const label = (id: string) => intl.formatMessage({ id: `genUi.${id}` });
  const [expanded, setExpanded] = useState(false),
    [tweaks, setTweaks] = useState(false),
    [retry, setRetry] = useState(0);
  const [draft, setDraft] = useState<string | null>(null);
  const [copying, setCopying] = useState(false),
    [error, setError] = useState("");
  const expandButton = useRef<HTMLButtonElement>(null);
  // 确认请求的 resolver 只保留最近一次，用 ref 而非 state 是因为写它不需要触发渲染
  // [并发] 同一时刻最多一个待决确认，新请求到来时先用空值结束上一个，再占住槽位
  // 以空值而不是 reject 结束：调用方按「用户取消」分支继续，不必区分取消与卸载
  // [失败路径] 若旧 resolver 未清空就被覆盖，前一个 await 永不返回，生成层停在该处不再出图
  // 结果只能经由这个 ref 交付，绕过它直接改草稿会让等待方永远收不到值
  // [资源] 卸载时清理函数补一次空值，避免 promise 悬挂并把已卸载组件的闭包留在内存里
  // resolver 的入参允许空值，与生成层「取消即返回空」的契约一致，不需要额外错误类型
  // 草稿内容不放 ref：输入框是受控的，draft 必须走 state 才能在弹窗里回显并保持光标
  const resolve = useRef<((value: string | null) => void) | null>(null);
  const confirm = useCallback(
    (prompt: string) =>
      new Promise<string | null>((done) => {
        resolve.current?.(null);
        resolve.current = done;
        setDraft(prompt);
      }),
    [],
  );
  const finish = (value: string | null) => {
    resolve.current?.(value);
    resolve.current = null;
    setDraft(null);
  };
  useEffect(
    () => () => {
      resolve.current?.(null);
    },
    [],
  );
  // page 是本次生成的唯一句柄；supported 与 online 只决定能力展示，不参与页面创建
  // [失败路径] 宿主不支持或离线时 page 为空，卡片退化成一行说明，不发出任何生成请求
  // acquisitionError 与 snapshot 里的 error 是两条独立通道：前者是拿不到页面，后者是页面自身报错
  // retry 只做递增，用来让 hook 重新获取；失败原因不需要回传，展示文本来自两个 error 通道
  // [事务] confirm 由卡片注入 hook：生成层要在渲染前向用户要参数时必须走这条通道，不能直接读草稿
  // [权衡] 把 confirm 作为入参传入而不是让 hook 自建弹窗，保证弹窗所有者唯一，关闭与焦点归还也只有一个实现
  // 返回结构不暴露获取页面或改页面状态的方法，卡片无法绕过 hook 直接驱动生成层
  // target 变化时由 hook 释放旧 page，卡片只消费返回值，不持有页面生命周期
  const { page, supported, online, error: acquisitionError } = useGenUi(target, confirm, retry);
  // 快照走外部 store 订阅，而不是把生成结果复制进卡片 state，避免每帧多一份页面状态副本
  // 第一个参数随 page 变化：不同 page 对应不同订阅源，切换时必须整体换掉而不是叠加
  // [并发] getSnapshot 必须返回缓存对象；每次新建对象会让 React 判定快照已变，触发无限重渲染
  // 第二个参数在 page 为空时回退到常量快照，保证空态下也满足「同一输入返回同一引用」
  // 第三个参数服务首帧与服务端，必须与客户端空态完全同值，否则 hydration 会报不一致
  // [失败路径] page 尚未创建时三个参数都可用，因此渲染期不会因为缺 page 而抛错
  // 订阅由 React 在提交阶段建立，卡片不自己调用 page 的订阅方法，避免同一来源被监听两次
  // 快照只读：任何写操作都必须回到 page 的方法，卡片不缓存可变的中间副本
  const snapshot = useSyncExternalStore(
    page?.subscribe ?? subscribeEmpty,
    page?.getSnapshot ?? (() => EMPTY_GEN_UI_SNAPSHOT),
    () => EMPTY_GEN_UI_SNAPSHOT,
  );
  useEffect(() => {
    // 展开态除了用户点击，还必须能被生成层的 esc 信号强制收起
    // [事务] 判断的是快照里的序号而不是布尔值：序号每次递增，连续两次 esc 也能各触发一次
    // 依赖数组只放序号，不放 expanded：否则收起动作本身会再次进入该 effect 形成回环
    // [失败路径] 若把条件改成恒真判断，任何一次快照更新都会收起预览，用户刚点开就被关掉
    // 收起时不清空草稿：确认弹窗可能正开着，清空会让用户已输入的内容消失
    // [权衡] 用 effect 而不是在渲染期直接写 state：渲染期改状态会触发 React 警告并可能死循环
    // 该信号只作用于预览层，行内卡片是否展开仍由用户点击决定
    // 序号为零表示从未请求过收起，首次渲染不会误关任何窗口
    if (snapshot.escapeSequence) setExpanded(false);
  }, [snapshot.escapeSequence]);
  // 标题是可选输入：调用方没给就回退到通用标题，保证任何位置都不出现空标题
  // 空串与缺失都走回退，或运算对两者一视同仁，不需要额外判空分支
  // [权衡] 不把回退值写回 reference：引用对象可能被上层复用，写回会污染其他卡片的标题
  // 同一个 title 同时供工具条 aria-label、预览层标题与确认弹窗描述使用，三处必须同源
  // aria-label 取标题而不是「操作」，读屏用户才能分辨这是哪张卡片的按钮组
  // 确认弹窗里标题作为描述而非标题节点，避免与「确认」形成两个同级标题
  // 这里不做截断，截断交给使用它的节点按可用宽度处理，避免短标题被无谓裁掉
  // 每帧调用一次国际化格式化，代价可忽略；缓存反而会在语言切换后继续显示旧文案
  const title = reference.title || label("title");
  const loading = supported && online && snapshot.phase !== "error" && !acquisitionError;
  const status = !supported
    ? label("desktopOnly")
    : !online
      ? label("offline")
      : snapshot.phase === "error" || acquisitionError
        ? label("failed")
        : label("loading");
  // 同一个工厂产出两种形态：行内浮动工具条与预览层顶部工具条，按钮集合与顺序必须一致
  // [权衡] 复用而不是各写一份 JSX：两处若分开维护，新增按钮时必然漏掉其中之一
  // 预览形态把标题渲染成 DialogTitle，无标题时用 sr-only 保留标题层级，读屏仍能定位对话框
  // 行内形态不渲染标题节点，避免卡片正文出现第二处可聚焦文本
  // 工具条带工具栏语义与 aria-label，按钮组对读屏是一个整体而不是散落的图标按钮
  // [失败路径] 复制按钮在拷贝中或快照未就绪时禁用，双击不会产生两次剪贴板写入
  // 展开与收起是同一个按钮的两种文案，预览形态点击即收起，不会新开一层窗口
  // 两种形态的可见性策略不同：行内靠悬停与容器聚焦显示，预览层常驻，改动时不要合并
  const controls = (preview = false) => (
    <div
      role="toolbar"
      aria-label={title}
      className={
        preview
          ? "flex shrink-0 items-center justify-end gap-1 p-2"
          : "absolute right-0 bottom-0 z-20 flex gap-1 rounded-lg bg-popover p-1 shadow-sm opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 data-[visible=true]:opacity-100 [@media(hover:none)]:opacity-100"
      }
      data-visible={snapshot.hovered || tweaks}
      data-testid="gen-ui-actions"
    >
      {preview && (
        <DialogTitle
          className={reference.title ? "min-w-0 flex-1 truncate" : "sr-only"}
          title={title}
        >
          {title}
        </DialogTitle>
      )}
      <Button
        variant="ghost"
        size="icon-sm"
        title={label("copyImage")}
        aria-label={label("copyImage")}
        disabled={copying || snapshot.phase !== "ready"}
        onClick={async () => {
          if (!page) return;
          setCopying(true);
          setError("");
          try {
            // 复制成功不保留视觉状态；原 copied 未复位，会让图标永久停在对勾。
            await page.copyImage();
          } catch (reason) {
            setError(String(reason));
          } finally {
            setCopying(false);
          }
        }}
      >
        <Copy />
      </Button>
      {snapshot.groups.length > 0 && (
        <Button
          variant="ghost"
          size="icon-sm"
          title={label("tweak")}
          aria-label={label("tweak")}
          aria-pressed={tweaks}
          onClick={() => setTweaks(!tweaks)}
        >
          <SlidersHorizontal />
        </Button>
      )}
      <Button
        ref={preview ? undefined : expandButton}
        variant="ghost"
        size="icon-sm"
        title={label(preview ? "collapse" : "expand")}
        aria-label={label(preview ? "collapse" : "expand")}
        onClick={() => setExpanded(!preview)}
      >
        {preview ? <X /> : <Maximize2 />}
      </Button>
    </div>
  );
  const panel =
    tweaks && snapshot.groups.length > 0 && page ? (
      <TweakPanel snapshot={snapshot} page={page} />
    ) : null;
  // 会话父容器已经负责宽度；卡片再次限宽会让 inline UI 无法填满正文。
  return (
    <section className="my-3 w-full" data-testid="gen-ui-card" data-gen-ui-phase={snapshot.phase}>
      <div className="group relative flow-root">
        {(snapshot.phase !== "ready" || !page) && (
          <div className="space-y-2 py-3 text-ui-base text-foreground-subtle" role="status">
            <p className="flex items-center gap-2">
              {loading && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
              {status}
            </p>
            {(snapshot.error || acquisitionError) && (
              <p className="break-words text-ui-xs">{snapshot.error || acquisitionError}</p>
            )}
            {supported && (snapshot.phase === "error" || !online || acquisitionError) && (
              <Button variant="outline" size="sm" onClick={() => setRetry((value) => value + 1)}>
                {label("retry")}
              </Button>
            )}
          </div>
        )}
        {page && <PageAnchor page={page} height={snapshot.height} />}
        {snapshot.phase === "ready" && controls()}
      </div>
      {!expanded && panel}
      {error && (
        <p role="alert" className="text-ui-sm text-destructive">
          {error}
        </p>
      )}
      <Dialog open={expanded} onOpenChange={setExpanded} modal={false}>
        {expanded && (
          <DialogPortal>
            <div
              className="fixed inset-0 z-40 bg-black/60"
              data-testid="gen-ui-backdrop"
              onPointerDown={() => setExpanded(false)}
            />
          </DialogPortal>
        )}
        <DialogContent
          showOverlay={false}
          showCloseButton={false}
          aria-describedby={undefined}
          className="z-40 flex h-[85vh] w-[min(1100px,94vw)] max-w-none flex-col gap-0 overflow-hidden p-0 data-open:animate-none data-closed:animate-none"
          onInteractOutside={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            expandButton.current?.focus();
          }}
        >
          {controls(true)}
          {page && (
            <PreviewAnchor page={page} suspended={draft !== null} hasPanel={panel !== null} />
          )}
          {panel}
        </DialogContent>
      </Dialog>
      <Dialog
        open={draft !== null}
        onOpenChange={(open) => {
          if (!open) finish(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{label("confirm")}</DialogTitle>
            <DialogDescription>{title}</DialogDescription>
          </DialogHeader>
          <Textarea
            value={draft ?? ""}
            onChange={(event) => setDraft(event.target.value)}
            rows={6}
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => finish(null)}>
              {label("cancel")}
            </Button>
            <Button disabled={!draft?.trim()} onClick={() => finish(draft)}>
              {label("send")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
