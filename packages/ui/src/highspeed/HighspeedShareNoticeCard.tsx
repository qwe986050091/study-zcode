// HighspeedShareNoticeCard.tsx — HighSpeed 分享卡与分享弹窗（展示层，唯一副作用是剪贴板与 toast）
// 数据流：GlobalNoticeEnvelope → 结构守卫 → 毫秒指标还原 → 资格复检 → 卡片 / HighspeedShareDialog
//
// 不变量（INV-01..INV-20）：每条注明守卫位置与改动后的破坏面
// INV-01 非分享类通知必须整卡不渲染：守卫在 isHighspeedShareNoticePayload 三元与紧随的提前返回，改成渲染空壳会让通知栈出现不可见占位并挤偏相邻卡片。
// INV-02 payload 守卫必须要求 cardId、tokenUsage 且 durationMs 或 durationSeconds 至少其一：守卫在 isHighspeedShareNoticePayload，放宽后异形 payload 会让指标还原产出 NaN。
// INV-03 指标只能由毫秒字段还原，不得用秒级字段重建倍率：守卫在 resolveHighspeedShareNoticeMetrics，回退秒级会让 1.2x 边界被系统性低估（spec §9）。
// INV-04 渲染侧资格复检必须与发布门禁同函数同精度：守卫在 isHighspeedShareEligible(metrics)，复检变严会静默隐藏已发布卡的 View 入口。
// INV-05 资格判定使用未取整倍率，取整只发生在展示层：守卫在 highspeedSpeedup 与 highspeedSavedPercent，提前取整会让 1.2008x 压成 1.2 并在门禁边界抖动。
// INV-06 弹窗默认关闭，仅在点击 View 后挂载：守卫在 useState(false) 与 shareEligible 三元，默认展开会在启动时抢焦点并播放入场动画。
// INV-07 卡片关闭按钮只调用注入的 onDismiss，不在卡内改通知状态：守卫在 Button 的 onClick，自行操作 store 会绕过 cooldown 与 latest-only 去重。
// INV-08 深浅两张底图必须同时挂载且都 aria-hidden：守卫在两个 img 的 aria-hidden 与 data-highspeed-card-background，删任一张会在主题切换时闪白或丢描边。
// INV-09 所有可见文案必须走 intl.formatMessage，禁止字面量兜底：守卫在每个 label 与 aria-label，写死中文会让图片与弹窗在非中文 locale 下混排。
// INV-10 复制图片必须传入与弹窗同源的 metrics 与已格式化 labels：守卫在 copyHighspeedCardImage 调用处，传半成品 labels 会让图内百分比与弹窗出现两套数字。
// INV-11 复制图片与复制文本是两条独立失败路径，各自 toast：守卫在两个 catch，合并成一个 catch 后无法区分剪贴板权限失败与 PNG 光栅化失败。
// INV-12 复制动作必须 void 前缀加 then/catch 消费，禁止 Promise 逃逸：守卫在 copyImage 与 copyText，去掉 void 会让未处理拒绝在 Electron 冒泡成全局错误。
// INV-13 节省秒数必须 clamp 到非负后才进文案与图片：守卫在 Math.max(0, Math.round(...))，负数直出会让导出图印出 -0s 之类脏数据。
// INV-14 进度条宽度与指针位置必须共用同一表达式：守卫在 --highspeed-share-fast-width 与 --highspeed-share-marker-left，两处分别取整会让指针与色块错位。
// INV-15 reduced-motion 下数字动画必须直接给终值：守卫在 useCountUpNumber 的 enabled 分支，仍从 0 起跳会让前庭敏感用户看到违和缩放。
// INV-16 useCountUpNumber 必须把 controls.stop 作为 useEffect 清理函数返回：守卫在该 effect 的 return，省略会在快速开关时留下并行动画并让数字抖动。
// INV-17 关闭态必须由 CSS 强制 animation:none 让 Radix 同步卸载：守卫在 highspeed-share.css 与 overlayClassName，只靠 animate-out 类名会让遮罩在窗口隐藏时永久滞留。
// INV-18 必须提供 sr-only 的 DialogTitle 与 DialogDescription：守卫在两个 sr-only 节点，缺失会让 Radix 报无障碍警告且读屏拿不到标题。
// INV-19 装饰图层（底图、噪点、图表、图标）必须全部 aria-hidden，语义只由文案节点承担：守卫在各 aria-hidden 属性，误删会让读屏读出无意义节点。
// INV-20 本文件不得持有持久状态或发起网络请求，外部副作用只有剪贴板与 toast：守卫在组件体无写库无 fetch，引入请求会与 global-notice 生命周期竞态。
import { useEffect, useState, type CSSProperties } from "react";
import { CopyIcon, EyeIcon, XIcon, ZapIcon } from "lucide-react";
import { animate, motion, useReducedMotion } from "motion/react";
import shareCardDarkBackgroundUrl from "@/assets/highspeed/share-card.svg";
import shareCardLightBackgroundUrl from "@/assets/highspeed/share-card-light.svg";
import shareDialogNoiseUrl from "@/assets/highspeed/share-dialog-noise.png";
import shareDialogNoiseLightUrl from "@/assets/highspeed/share-dialog-noise-light.png";
import zaiLogoUrl from "@/assets/highspeed/zai-logo.png";
import { Button } from "@/components/ui/button.js";
import { ZCodeWordmarkLogo } from "@/components/ui/ZCodeAboutLogo.js";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog.js";
import type { GlobalNoticeEnvelope } from "@/global-notice/globalNoticeStore.js";
import {
  copyHighspeedCardImage,
  copyHighspeedShareText,
  formatHighspeedDurationShort,
  highspeedSavedPercent,
  highspeedSpeedup,
  isHighspeedShareEligible,
  isHighspeedShareNoticePayload,
  resolveHighspeedShareNoticeMetrics,
} from "@/highspeed/highspeedShare.js";
import { calculateHighspeedSavedDurationMs } from "@/highspeed/highspeedSavedTime.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { toast } from "@/components/ui/toast.js";

// [入口] 左下角常驻分享卡：受控组件，notice 与 onDismiss 全由 global-notice 层注入
// 组件自身只持有一个弹窗开关，卸载即全部丢失，符合通知卡的短生命周期语义
// [并发] 通知队列切换时父级可能复用同一实例，因此这里不得缓存上一张卡的派生指标
// 依赖 prop 的派生值全部在每次渲染内联计算，保证 notice 换人时不会串数据
// 若把 metrics 提升为 useMemo 却漏掉 notice.payload 依赖，会展示上一轮任务的倍率
export function HighspeedShareNoticeCard({
  notice,
  onDismiss,
}: {
  notice: GlobalNoticeEnvelope;
  onDismiss: () => void;
}) {
  const { intl } = useZCodeIntl();
  const [open, setOpen] = useState(false);
  // [失败路径] 先做结构守卫再取字段：payload 是 Record<string, unknown>，直接访问只会得到 unknown
  // 守卫只认 cardId、tokenUsage 与 durationMs|durationSeconds 的存在性，不校验数值合理性
  // 三元返回 null 而不是抛错，让异形通知退化为不渲染，而不是把整条通知流打断
  // 数值合理性交给下游 isHighspeedShareEligible 的 Number.isFinite 检查，职责不重叠
  // 若把守卫改成断言非空，坏 payload 会以 NaN 进入文案模板并渲染出 NaN x
  const payload = isHighspeedShareNoticePayload(notice.payload) ? notice.payload : null;
  // [提前返回] 必须在任何 hook 之前：此刻尚未调用 useState/useEffect，返回 null 不改变 hook 顺序
  // 若把该判断挪到 useState 之后，通知类型切换会改变 hook 调用次数并触发 React 报错
  // 返回值 null 而非空 fragment，避免在通知栈里留下占位节点影响相邻卡片的间距
  if (!payload) return null;
  // Bug 根因：此前由秒级取整字段重建指标再复检资格，边界倍率被系统性低估而隐藏 View（spec §9）。
  // 现在与发布门禁共用同一份毫秒事实，复检只能与发布判定一致，纵深防御不再误伤已发布的卡。
  // [事务] 指标还原是一次纯计算，不读 DOM 不写 store，因此可在渲染期安全重复执行
  // 还原函数优先读毫秒字段，只有遗留秒级 payload 才按 ×1000 兜底，精度不倒退
  // 合成 TPS 只为满足资格函数对正数 TPS 的前置校验，倍率本身不依赖该合成值
  // 若在这里对毫秒值取整，下游复检就会与发布门禁的真实倍率产生缝隙
  const metrics = resolveHighspeedShareNoticeMetrics(payload);
  // [权衡] 发布侧已判定过一次资格，渲染侧仍复检：多一层防御，但必须与门禁用同一份事实
  // 若复检使用展示用四舍五入值，1.2008x 会被压成 1.2 而被判不合格，View 按钮凭空消失
  // 当前复检只可能比门禁更宽松（同精度同函数），因此不会误伤已经发布的卡（spec §9）
  // 把该布尔值放在渲染期而不是 state，避免通知更新后资格与卡片状态不同步
  const shareEligible = isHighspeedShareEligible(metrics);
  const openDetails = () => setOpen(true);
  return (
    <>
      <div className="highspeed-sidebar-share-card-frame">
        <section
          className="highspeed-sidebar-share-card"
          aria-label={intl.formatMessage({ id: "globalNotice.highspeed.title" })}
          data-global-notice-type="highspeed-share"
          role="group"
        >
          {/* Bug 原因：旧实现把设计稿背景拆成多个近似图层，主题切换时容易重复叠加或丢失描边。
           * 直接使用设计交付的完整主题底图，前景元素仍按 Figma 坐标独立渲染。 */}
          <img
            // [资源] 深浅两张底图同时挂载、由 CSS 按根节点 dark class 显隐，避免切换时重新加载造成闪白
            // 两张 img 都 aria-hidden 且 alt 为空，装饰图不进入无障碍树，语义完全交给文案节点
            // draggable={false} 防止在 Electron 里把背景图拖出成幽灵窗口
            // data-highspeed-card-background 供样式与测试定位主题层，删掉会让主题选择器失效
            src={shareCardLightBackgroundUrl}
            alt=""
            aria-hidden="true"
            draggable={false}
            className="highspeed-sidebar-share-card__background highspeed-sidebar-share-card__background--light"
            data-highspeed-card-background="light"
          />
          <img
            src={shareCardDarkBackgroundUrl}
            alt=""
            aria-hidden="true"
            draggable={false}
            className="highspeed-sidebar-share-card__background highspeed-sidebar-share-card__background--dark"
            data-highspeed-card-background="dark"
          />
          <div className="highspeed-sidebar-share-card__content">
            <div className="highspeed-sidebar-share-card__title" role="img" aria-label="ZCode">
              <ZCodeWordmarkLogo className="highspeed-sidebar-share-card__wordmark" />
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={intl.formatMessage({ id: "globalNotice.highspeed.close" })}
              className="highspeed-sidebar-share-card__close absolute right-2.5 top-2.5 z-2 rounded-full text-foreground-subtle hover:bg-hover hover:text-foreground focus-visible:ring-foreground/50"
              onClick={onDismiss}
            >
              <XIcon aria-hidden="true" />
            </Button>
            {shareEligible ? (
              <Button
                type="button"
                variant="ghost"
                aria-label={intl.formatMessage({ id: "globalNotice.highspeed.view" })}
                className="highspeed-sidebar-share-card__view"
                onClick={openDetails}
              >
                <EyeIcon aria-hidden="true" className="size-3" strokeWidth={2} />
                {intl.formatMessage({ id: "globalNotice.highspeed.view" })}
              </Button>
            ) : null}
            <div className="highspeed-sidebar-share-card__model">
              <ZapIcon aria-hidden="true" className="highspeed-sidebar-share-card__model-icon" />
              <span className="highspeed-sidebar-share-card__model-text">GLM-5.3-Highspeed</span>
            </div>
            <div className="highspeed-sidebar-share-card__description">
              {intl.formatMessage({ id: "globalNotice.highspeed.sidebarTagline" })}
            </div>
          </div>
        </section>
      </div>
      <HighspeedShareDialog metrics={metrics} open={open} onOpenChange={setOpen} />
    </>
  );
}

/** 数字从 0 增长到目标值；reduced-motion 或禁用时直接呈现终值。节奏与卡片各区块的 fade-up 交错对齐。 */
// [动画] 数字滚动 hook：把 target 从 0 缓动到终值，返回值直接参与渲染
// enabled 为假时（reduced-motion 或弹窗未打开）跳过动画，首帧即终值，避免无谓 tween
// 初值按 enabled 取 0 或 target：弹窗未开时不应先渲染 0 再跳，否则关闭态可见闪烁
// durationMs 与 delayMs 由调用方给，保证两个数字与各自区块 fade-up 的节奏对齐
// [资源] 动画实例由 motion 的 animate 管理，依赖变化即重建，旧实例在清理函数里停止
// 该 hook 不做节流，因为目标值在一次会话里最多变两次（入场一次、关闭归位一次）
// 若在渲染期直接调用 animate 而不放进 useEffect，会每次渲染都新建一条动画
function useCountUpNumber(
  target: number,
  { enabled, delayMs, durationMs }: { enabled: boolean; delayMs: number; durationMs: number },
) {
  const [value, setValue] = useState(enabled ? 0 : target);
  useEffect(() => {
    if (!enabled) {
      setValue(target);
      return;
    }
    setValue(0);
    // [资源] 单条 tween 驱动整个数字：duration 单位是秒，因此传参时必须除以 1000
    // ease 与卡片入场用同一条三次贝塞尔，视觉手感统一，改动需同步 CSS 曲线
    // onUpdate 直接 setValue，帧调度交给 motion，不额外叠加 rAF
    // [失败路径] 清理函数必须 stop：弹窗快速开关会留下并行 tween，数字会在两个目标间抖动
    // 若依赖数组漏掉 durationMs 或 delayMs，切语言或改布局后动画节奏不会更新
    // target 变化时先归零再起动画，保证从 0 重新计数而不是从旧值继续
    const controls = animate(0, target, {
      duration: durationMs / 1000,
      delay: delayMs / 1000,
      ease: [0.22, 1, 0.36, 1],
      onUpdate: setValue,
    });
    return () => controls.stop();
  }, [target, enabled, delayMs, durationMs]);
  return value;
}

// [入口] 分享详情弹窗：纯展示，唯一副作用是复制到剪贴板并弹 toast
// metrics 由外部传入且已通过资格复检，弹窗内部不再重复判定是否该展示
// props 里的 savedDurationMs 可选，缺省时回退到估算函数，兼容旧调用方
// 弹窗不自行关闭：关闭权交给 Radix 的 onOpenChange，避免两套状态互相打架
export function HighspeedShareDialog({
  metrics,
  open,
  onOpenChange,
}: {
  metrics: {
    outputTokens: number;
    durationMs: number;
    regularTps: number;
    highspeedTps: number;
    savedDurationMs?: number;
  };
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { intl } = useZCodeIntl();
  const prefersReducedMotion = useReducedMotion();
  const speedup = highspeedSpeedup(metrics);
  // [兼容] 优先用 payload 携带的毫秒节省值，旧消息才走 calculateHighspeedSavedDurationMs 估算
  // 估算按工具 20% / 模型 80% 拆分，与 CLI 真实耗时口径不同，只作降级展示
  // 用空值合并而非逻辑或：0 是合法节省值，用或运算会被误判为缺失而重新估算
  // [事务] 该值只读，不回写 metrics，避免展示层把估算值污染成事实
  // 若在这里把 savedDurationMs 取整到秒，百分比与图片文案会出现两套结果
  const savedDurationMs = metrics.savedDurationMs ?? calculateHighspeedSavedDurationMs(metrics);
  const savedSeconds = Math.max(0, Math.round(savedDurationMs / 1_000));
  // Bug 原因：此前写成 1 - highspeedTps/regularTps，结果恒为负数被 clamp 成 0%。
  const savedPercent = highspeedSavedPercent(metrics);
  // 倍数与百分比在弹窗入场时从 0 增长到目标值；节奏对齐各自区块 fade-up 的 230ms/300ms 延迟。
  const countUpEnabled = open && !prefersReducedMotion;
  const speedupCount = useCountUpNumber(speedup, {
    enabled: countUpEnabled,
    delayMs: 230,
    durationMs: 900,
  });
  const savedPercentCount = useCountUpNumber(savedPercent, {
    enabled: countUpEnabled,
    delayMs: 300,
    durationMs: 900,
  });
  // [副作用] 复制卡片图：先按当前 locale 组装全部 label，再交给 copyHighspeedCardImage 光栅化
  // label 全部在点击时求值，保证用户切语言后复制到的是最新文案而不是挂载时的快照
  // percent 传未取整的 savedPercent，与图上刻度同源，避免图上写 41% 而弹窗写 42%
  // [失败路径] then 弹成功 toast，catch 弹失败 toast：剪贴板被拒与光栅化失败都走同一条提示
  // 函数体用 void 前缀消费 Promise，避免未处理的拒绝冒泡成全局错误
  // 若把 labels 拆成多次格式化再拼字符串，占位符错位会导致文案出现 undefined
  // [资源] 光栅化在 copyHighspeedCardImage 内部创建 object URL 并在 finally 里回收
  const copyImage = () =>
    void copyHighspeedCardImage(metrics, undefined, {
      benefit: intl.formatMessage({ id: "globalNotice.highspeed.badge" }),
      standardSpeed: intl.formatMessage({ id: "globalNotice.highspeed.standardTaskSpeed" }),
      speedSummary: intl.formatMessage(
        { id: "globalNotice.highspeed.speedSummary" },
        { duration: formatHighspeedDurationShort(metrics.durationMs) },
      ),
      lessWaiting: intl.formatMessage(
        { id: "globalNotice.highspeed.lessWaiting" },
        { percent: savedPercent },
      ),
      imageSummary: intl.formatMessage(
        { id: "globalNotice.highspeed.imageSummary" },
        { tokens: Math.floor(metrics.outputTokens).toLocaleString(), duration: savedSeconds },
      ),
    })
      .then(() => toast(intl.formatMessage({ id: "globalNotice.highspeed.imageCopied" })))
      .catch(() => toast(intl.formatMessage({ id: "globalNotice.highspeed.imageCopyFailed" })));
  const shareText = intl.formatMessage(
    { id: "globalNotice.highspeed.copySummary" },
    { tokens: metrics.outputTokens.toLocaleString(), duration: savedSeconds },
  );
  // [副作用] 复制纯文本摘要：shareText 已在上方按 token 数与节省秒数格式化好
  // 文本复制与图片复制是两条独立链路，各自 toast，失败原因不必在 UI 上细分
  // void 加 then/catch 的写法与 copyImage 保持一致，避免两处风格分叉
  // 若在按钮 title 与 onClick 里分别计算 shareText，可能出现选中文本与复制内容不一致
  // [失败路径] navigator.clipboard 在非安全上下文不可用，copyHighspeedShareText 会抛错并落到失败 toast
  const copyText = () =>
    void copyHighspeedShareText(shareText)
      .then(() => toast(intl.formatMessage({ id: "globalNotice.highspeed.textCopied" })))
      .catch(() => toast(intl.formatMessage({ id: "globalNotice.highspeed.textCopyFailed" })));
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Bug 原因：Radix Presence 等 overlay/content 的退出 CSS 动画 animationend 才卸载，且无超时兜底；
       * Electron 窗口不可见时 compositor 停摆，animationend 永不触发，bg-black/60 遮罩无限滞留，
       * 把左下角查看按钮罩灰并吞掉点击。关闭态由 highspeed-share.css 强制 animation:none，
       * Radix 检测不到动画名即同步卸载（tw-merge 不合并 tw-animate 的 animate-out，类名方案不可靠）。 */}
      <DialogContent
        className="highspeed-share-dialog__content"
        overlayClassName="highspeed-share-dialog__overlay"
        showCloseButton={false}
      >
        <motion.section
          className="highspeed-share-dialog__card"
          data-highspeed-share-dialog-card="true"
          initial={
            prefersReducedMotion
              ? false
              : { opacity: 0, rotateY: -72, rotateX: 4, scale: 0.9, y: 10 }
          }
          animate={{ opacity: 1, rotateY: 0, rotateX: 0, scale: 1, y: 0 }}
          transition={{ duration: 0.68, ease: [0.22, 1, 0.36, 1] }}
          style={{ transformOrigin: "50% 50%", transformPerspective: 1200 }}
        >
          <div
            className="highspeed-share-dialog__noise highspeed-share-dialog__noise--dark"
            style={{ backgroundImage: `url(${shareDialogNoiseUrl})` }}
            aria-hidden="true"
          />
          <div
            className="highspeed-share-dialog__noise highspeed-share-dialog__noise--light"
            style={{ backgroundImage: `url(${shareDialogNoiseLightUrl})` }}
            aria-hidden="true"
          />
          <div className="highspeed-share-dialog__header">
            <div className="highspeed-share-dialog__brand">
              <span className="highspeed-share-dialog__logo" aria-hidden="true">
                <img src={zaiLogoUrl} alt="" draggable={false} />
              </span>
              <span className="highspeed-share-dialog__benefit">
                {intl.formatMessage({ id: "globalNotice.highspeed.badge" })}
              </span>
              <span className="highspeed-share-dialog__pill">
                {intl.formatMessage({ id: "chat.highspeed.statusTag" })}
              </span>
            </div>
            <DialogClose asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={intl.formatMessage({ id: "globalNotice.highspeed.close" })}
                className="highspeed-share-dialog__close"
              >
                <XIcon aria-hidden="true" />
              </Button>
            </DialogClose>
          </div>
          <DialogTitle className="sr-only">
            {intl.formatMessage({ id: "globalNotice.highspeed.title" })}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {intl.formatMessage({ id: "globalNotice.highspeed.tagline" })}
          </DialogDescription>
          <div className="highspeed-share-dialog__metric">
            <span className="highspeed-share-dialog__metric-value">
              {speedupCount.toFixed(1)}
              <span className="highspeed-share-dialog__metric-suffix"> x</span>
            </span>
            <span className="highspeed-share-dialog__metric-label">
              {intl.formatMessage({ id: "globalNotice.highspeed.standardTaskSpeed" })}
            </span>
          </div>
          <div className="highspeed-share-dialog__stats">
            <div className="highspeed-share-dialog__stats-header text-ui-sm">
              <span className="highspeed-share-dialog__stats-label">
                <ZapIcon aria-hidden="true" fill="currentColor" strokeWidth={0} />
                {intl.formatMessage(
                  { id: "globalNotice.highspeed.speedSummary" },
                  { duration: formatHighspeedDurationShort(metrics.durationMs) },
                )}
              </span>
              <span className="highspeed-share-dialog__saved text-ui-sm">
                {intl.formatMessage(
                  { id: "globalNotice.highspeed.lessWaiting" },
                  { percent: Math.round(savedPercentCount) },
                )}
              </span>
            </div>
            <div
              className="highspeed-share-dialog__chart"
              aria-hidden="true"
              style={
                {
                  "--highspeed-share-fast-width": `calc(${Math.max(1, 100 - savedPercent)}% + 1px)`,
                  "--highspeed-share-marker-left": `calc(${Math.max(1, 100 - savedPercent)}% + 1px)`,
                } as CSSProperties
              }
            >
              <span
                className="highspeed-share-dialog__chart-bars highspeed-share-dialog__chart-bars--baseline"
                aria-hidden="true"
              />
              <span
                className="highspeed-share-dialog__chart-bars highspeed-share-dialog__chart-bars--fast"
                aria-hidden="true"
              />
              <span className="highspeed-share-dialog__chart-marker" />
            </div>
            <div className="highspeed-share-dialog__actions">
              <button
                type="button"
                className="highspeed-share-dialog__url"
                onClick={copyText}
                title={shareText}
                aria-label={shareText}
              >
                <span>{shareText}</span>
                <CopyIcon aria-hidden="true" />
              </button>
              <button
                type="button"
                className="highspeed-share-dialog__download"
                onClick={copyImage}
              >
                {intl.formatMessage({ id: "globalNotice.highspeed.copyImage" })}
              </button>
            </div>
          </div>
        </motion.section>
      </DialogContent>
    </Dialog>
  );
}
