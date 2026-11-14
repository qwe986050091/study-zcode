// Coding Plan 账单优惠（Billing Discount）展示层：徽标、横幅、规则弹窗，以及进程内缓存与并发去重。
// 数据来源为 codingPlanSubscriptionService.getBillingDiscount，返回按 Locale 分键的远端运营文案。
// 本文件只做「读取 → 归一化 → 渲染」，不写 store、不改订阅状态、不产生额外副作用。
// 不变量清单 INV-01..INV-20，格式为「不变量 / 守卫位置 / 改坏后的故障表现」。
// INV-01 缓存有效期只能是 BILLING_DISCOUNT_CACHE_TTL_MS（1 小时）/ 守卫在 loadCodingPlanBillingDiscount 的 expiresAt 比较与写入 / 改小或改 0 会让每次挂载都打远端接口。
// INV-02 同一时刻只允许一个在途请求 / 守卫在 loadCodingPlanBillingDiscount 的 billingDiscountRequest 非空早退 / 去掉后并发挂载会各发一次请求。
// INV-03 请求结束时只清自己的在途引用 / 守卫在 finally 的 billingDiscountRequest === request / 改成无条件置空会误清后来者的新请求。
// INV-04 缓存是模块级单例且不按 locale 分键 / 守卫在顶层只声明一次 billingDiscountCache / 改成按语言分缓存会让切语言重复拉取且状态分叉。
// INV-05 失败结果不写缓存 / 守卫在 refresh 的 catch 只改 state 不碰 billingDiscountCache / 若写入失败态会把取不到钉死一小时。
// INV-06 失败后必须回落空态 / 守卫在 catch 里把 active 置 false、config 置 undefined / 保留旧 config 会让已下线活动继续展示。
// INV-07 文案不全即视为无活动 / 守卫在 hasLocaleCopy 与各组件首行的 copy 字段判断 / 放宽为任一非空即展示会渲染半截文案。
// INV-08 徽标显隐只看 badgeBody / 守卫在 BadgePill 与 Badge 的 copy.badgeBody 判断 / 改为依赖 cardTitle 会让横幅与徽标显隐不同步。
// INV-09 横幅要求 cardTitle 与 cardBody 同时存在 / 守卫在 Banner 的标题正文联合判断 / 只判其一会渲染空标题卡片。
// INV-10 弹窗要求 infoTitle 与 infoBody 同时存在 / 守卫在 InfoDialog 的两个字段判断 / 缺失正文仍渲染会出现空白弹窗。
// INV-11 所有文案必须经 readNonEmptyString 归一 / 守卫在 resolveCodingPlanBillingDiscountCopy 的五个字段赋值 / 绕过它会让纯空格文案通过存在性判断。
// INV-12 非法 locale 配置返回空对象而非抛错 / 守卫在 resolveCodingPlanBillingDiscountCopy 的类型判断 / 去掉后遇到脏配置会整页白屏。
// INV-13 语言或 service 变化必须重新拉取 / 守卫在 refresh 的 useCallback 依赖与 effect 依赖 / 漏掉 locale 会切换语言后文案不更新。
// INV-14 service 缺失时不得发起请求 / 守卫在 refresh 首行的空值与函数类型双判断 / 去掉会抛 TypeError 并产生未处理 rejection。
// INV-15 首帧必须复用缓存避免闪烁 / 守卫在 useState 初值直接读 billingDiscountCache / 改成 undefined 会先闪一次无徽标再出现。
// INV-16 loading 初值只在有 service 且无缓存时为真 / 守卫在 useState 的 loading 表达式 / 改错会让无 service 场景永久转圈。
// INV-17 弹窗正文固定为二级标题加空行加 Markdown 正文 / 守卫在 markdown 模板串 / 改掉空行分隔会让标题与正文粘连成一行。
// INV-18 弹窗主题与代码预览设置由调用方注入 / 守卫在 useZCodeStoreWithDefault 两处读取 / 改回组件自取 store 会破坏解耦并在 provider 外崩溃。
// INV-19 徽标文字禁止强制大写 / 守卫在 BadgePill 的 className 不写 uppercase / 加上会把 150% Quota 渲染成 150% QUOTA。
// INV-20 清缓存与预热仅限测试 / 守卫在两个 ForTest 导出函数的命名与调用边界 / 生产代码调用会绕过 TTL 读到脏数据。
// 失败路径总览：取数 reject 时只记一条 warn 并回落空态，订阅主流程不受影响。
// 资源：模块级只常驻一份配置对象，生命周期等于会话，无需显式释放。
// 并发：单例在途 Promise 让同帧多个组件挂载只产生一次网络往返，后来者共享同一结果。
// 权衡：TTL 一小时意味着运营改配置最长延迟一小时生效。
// 权衡：文案缺失即整块隐藏，宁可少展示也不展示残缺或过期活动。
// 注意：所有早退分支返回 null 而不是空占位，父容器 flex 间距不会留空洞。
import type {
  CodingPlanBillingDiscountConfig,
  CodingPlanBillingDiscountLocaleCopy,
  Locale,
} from "@zcode/shared";
import type { ICodingPlanSubscriptionService } from "@zcode/services";
import { InfoIcon, SparklesIcon, TrendingUpIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { cn } from "@/components/lib/utils.js";
import { MessageResponse } from "@/components/ai-elements/message.js";
import {
  Dialog,
  DialogContent,
  DialogTrigger,
} from "@/components/ui/dialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useOptionalServices } from "@/hooks/useServices.js";
import { useZCodeStoreWithDefault } from "@/store/StoreProvider.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import { logger } from "@/logger.js";

// [资源] 缓存 TTL 一小时，也是运营改配置到客户端可见之间的最大不一致窗口。
// 调大 TTL：活动下线后最长一小时仍展示旧福利；调小：每次进入订阅页都多一次远端读取。
const BILLING_DISCOUNT_CACHE_TTL_MS = 60 * 60 * 1000;
export const CODING_PLAN_BILLING_DISCOUNT_DIALOG_CONTENT_CLASS =
  "max-h-[min(82vh,640px)] max-w-lg grid-rows-[auto_minmax(0,1fr)] overflow-hidden";
export const CODING_PLAN_BILLING_DISCOUNT_DIALOG_BODY_CLASS = "p-3 !space-y-3";

// [并发] 缓存与在途请求都是模块级单例，跨组件、跨路由共享，仅存活于当前进程。
// 二者必须成对维护：只有 cache 会丢并发去重，只有 request 会丢 TTL 命中。
// [资源] 这里只存公开活动文案，不含用户私有数据，进程级共享没有越权风险。
// value 允许是 undefined，表示服务端明确无活动，与从未请求过是两种状态。
let billingDiscountCache: {
  value: CodingPlanBillingDiscountConfig | undefined;
  expiresAt: number;
} | null = null;
let billingDiscountRequest: Promise<
  CodingPlanBillingDiscountConfig | undefined
> | null = null;

// 便捷 Hook：从服务上下文取 codingPlanSubscriptionService，再委托给可注入版本，方便测试替身。
// [失败路径] 没有 ServicesProvider 时取到空值，此处不抛错，只得到空态。
export function useCodingPlanBillingDiscount(): {
  active: boolean;
  config: CodingPlanBillingDiscountConfig | undefined;
  loading: boolean;
  refresh: () => Promise<void>;
} {
  const services = useOptionalServices();
  return useCodingPlanBillingDiscountFromService(
    services?.codingPlanSubscriptionService,
  );
}

// 核心 Hook：service 允许为空，未登录或上下文未初始化时也能安全调用。
// 返回的 active 是当前 locale 是否具备 badgeBody 的派生布尔，不代表服务端开关。
export function useCodingPlanBillingDiscountFromService(
  service:
    | Pick<ICodingPlanSubscriptionService, "getBillingDiscount">
    | undefined,
): {
  active: boolean;
  config: CodingPlanBillingDiscountConfig | undefined;
  loading: boolean;
  refresh: () => Promise<void>;
} {
  const { locale } = useZCodeIntl();
  // 首帧同步读缓存：命中时 active 与 config 直接有值，避免徽标先消失再出现的闪烁。
  // [权衡] 过期缓存也会被当作初值乐观展示，真正的过期判定留在加载函数内部。
  // 这个对象字面量只求值一次，不要改成每次渲染重算，否则会覆盖用户已看到的状态。
  const [state, setState] = useState({
    active: hasLocaleCopy(billingDiscountCache?.value, locale, ["badgeBody"]),
    config: billingDiscountCache?.value,
    loading: Boolean(service) && !billingDiscountCache,
  });

  // [并发] refresh 的身份由依赖决定，身份变化会连带触发下面 effect 重新拉取。
  // 不要在函数体内读 state 做短路，闭包会捕获旧值，导致永远不再更新。
  const refresh = useCallback(async () => {
    // [失败路径] 双保险：service 为空，或实现方是旧版本、没有 getBillingDiscount 方法。
    // 命中时立刻回落空态并返回，不进入 try，避免把未实现误报成请求失败。
    // loading 必须显式置 false，否则调用方会为一个永远不会来的结果一直转圈。
    if (!service || typeof service.getBillingDiscount !== "function") {
      setState({ active: false, config: undefined, loading: false });
      return;
    }

    setState((current) => ({ ...current, loading: true }));
    try {
      const discount = await loadCodingPlanBillingDiscount(service);
      setState({
        active: hasLocaleCopy(discount, locale, ["badgeBody"]),
        config: discount,
        loading: false,
      });
    // [失败路径] 失败只降级不阻断：订阅页仍需能正常下单，活动缺失是可接受降级。
    // 日志只记 message，不打印完整配置对象，避免把运营文案与内部字段写进用户日志。
    // 此处刻意不写缓存，失败结果不会被记住一小时，对应 INV-05。
    } catch (error) {
      logger.warn("[CodingPlanBillingDiscount] 读取 Coding Plan 活动配置失败", {
        error: error instanceof Error ? error.message : String(error),
      });
      setState({ active: false, config: undefined, loading: false });
    }
  }, [locale, service]);

  // 挂载即拉取；refresh 身份变化时先清理再重跑，语言切换天然不会串数据。
  // void 前缀显式丢弃 Promise，异常已在 refresh 内部收敛，这里不需要再处理。
  useEffect(() => {
    void refresh();
  }, [refresh]);

  return {
    active: state.active,
    config: state.config,
    loading: state.loading,
    refresh,
  };
}

// 文案归一化唯一入口：把任意形状的 locale 配置收敛成五个可空字符串字段。
// 不做任何语言回退，locale 缺文案就是缺，避免出现中英混排。
// 返回结构固定，调用方可以放心按字段判空，不必再判断对象是否存在。
export function resolveCodingPlanBillingDiscountCopy(
  config: CodingPlanBillingDiscountConfig | undefined,
  locale: Locale,
): CodingPlanBillingDiscountLocaleCopy {
  const copy = config?.[locale];
  // [失败路径] 同时挡住 null 与非法类型；数组的 typeof 也是 object，但读字段得到 undefined，后续仍回落空态。
  // 返回空对象而不是 undefined，可让调用方省掉一层可空判断，对应 INV-12。
  if (!copy || typeof copy !== "object") {
    return {};
  }
  return {
    badgeBody: readNonEmptyString(copy.badgeBody),
    cardTitle: readNonEmptyString(copy.cardTitle),
    cardBody: readNonEmptyString(copy.cardBody),
    infoTitle: readNonEmptyString(copy.infoTitle),
    infoBody: readNonEmptyString(copy.infoBody),
  };
}

function hasLocaleCopy(
  config: CodingPlanBillingDiscountConfig | undefined,
  locale: Locale,
  keys: Array<keyof CodingPlanBillingDiscountLocaleCopy>,
): boolean {
  const copy = resolveCodingPlanBillingDiscountCopy(config, locale);
  return keys.every((key) => Boolean(copy[key]));
}

type CodingPlanBillingDiscountBadgePillProps = {
  config?: CodingPlanBillingDiscountConfig;
  iconVisible?: boolean;
  size?: "default" | "compact";
  variant?: "gradient" | "surface" | "tag";
};

// 最小展示单元：纯展示组件，不取数不读 store，只接收 config 与三个样式开关。
// [失败路径] badgeBody 缺失直接返回 null，父级因此不会渲染空胶囊。
// 文案长度由服务端决定，外层用 whitespace-nowrap 防止折行撑破布局。
export function CodingPlanBillingDiscountBadgePill({
  config,
  iconVisible = true,
  size = "default",
  variant = "gradient",
}: CodingPlanBillingDiscountBadgePillProps) {
  const { locale } = useZCodeIntl();
  const copy = resolveCodingPlanBillingDiscountCopy(config, locale);
  if (!copy.badgeBody) {
    return null;
  }
  return (
    <div
      className={cn(
        // Bugfix: 活动徽标文案来自服务端多语言配置，英文可能需要保留 Title Case。
        // 不能用 uppercase 强制转写，否则 "150% Quota" 会被渲染成 "150% QUOTA"。
        "inline-flex items-center py-0.5 whitespace-nowrap",
        size === "compact"
          ? "gap-0.5 px-1.5 text-ui-xs leading-none"
          : "gap-1 px-2 text-ui-xs",
        variant === "surface"
          ? "rounded-full bg-white text-[#191A1D]"
          : variant === "tag"
            ? "rounded-full bg-tag text-foreground"
            : "rounded-full text-white button-gradient dark:bg-[#484A58]",
      )}
    >
      {iconVisible ? (
        // 图标尺寸随档位切换，compact 用 size-2.5、default 用 size-3，保持与文字基线对齐。
        // [权衡] iconVisible 只控制 TrendingUpIcon；关掉图标仅减少视觉噪音，badgeBody 文案始终保留。
        <TrendingUpIcon
          className={size === "compact" ? "size-2.5" : "size-3"}
        />
      ) : null}
      {copy.badgeBody}
    </div>
  );
}

// 徽标组合件：徽标本体加一个规则弹窗入口，二者共享同一份 config 与 locale。
// 这里再判一次 badgeBody，是为了在弹窗入口渲染前短路，避免挂出一个没有可见锚点的图标。
// 弹窗配色跟随变体：surface 背景偏亮，用 onGradient 取反差色，其余用默认前景色。
export function CodingPlanBillingDiscountBadge(
  props: CodingPlanBillingDiscountBadgePillProps,
) {
  const { locale } = useZCodeIntl();
  const copy = resolveCodingPlanBillingDiscountCopy(props.config, locale);
  if (!copy.badgeBody) {
    return null;
  }
  const badge = <CodingPlanBillingDiscountBadgePill {...props} />;
  return (
    <>
      {badge}
      <CodingPlanBillingDiscountInfoDialog
        config={props.config}
        tone={props.variant === "surface" ? "onGradient" : "default"}
      />
    </>
  );
}

// 横幅组件：卡片式活动文案，右侧嵌一个 surface 变体徽标，整体可整块隐藏。
// [失败路径] 标题或正文任一缺失都返回 null，宁可不渲染也不拼接残缺文案。
// 容器逐层 min-w-0，保证长文案被截断而不是把右侧徽标挤出可视区。
export function CodingPlanBillingDiscountBanner({
  config,
}: {
  config?: CodingPlanBillingDiscountConfig;
}) {
  const { locale } = useZCodeIntl();
  const copy = resolveCodingPlanBillingDiscountCopy(config, locale);
  if (!copy.cardTitle || !copy.cardBody) {
    return null;
  }
  return (
    <div className="rounded-xl border border-transparent button-gradient px-3 py-2.5 text-white dark:bg-[#484A58]">
      <div className="flex min-w-0 items-center justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2">
          <div className="flex h-6 shrink-0 items-center">
            <SparklesIcon className="size-4 text-white" />
          </div>
          <div className="min-w-0">
            <div className="text-ui-lg font-medium leading-6 text-white">
              {copy.cardTitle}
            </div>
            <div className="mt-0.5 text-ui-base leading-5 text-white/80">
              {copy.cardBody}
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <CodingPlanBillingDiscountBadge config={config} variant="surface" />
        </div>
      </div>
    </div>
  );
}

// 规则弹窗：触发器是一个可聚焦图标，内容用 Markdown 渲染远端规则正文。
// [权衡] 规则完全以远端为准，本地不留兜底文案，避免旧规则与当前活动冲突。
// tone 只影响触发器配色，不影响弹窗内容，onGradient 用于渐变底上的对比度。
export function CodingPlanBillingDiscountInfoDialog({
  config,
  tone = "default",
}: {
  config?: CodingPlanBillingDiscountConfig;
  tone?: "default" | "onGradient";
}) {
  const { intl, locale } = useZCodeIntl();
  const copy = resolveCodingPlanBillingDiscountCopy(config, locale);
  // M5②.5 store 耦合剥离：MessageResponse 不再自取 store，主题/代码预览设置由调用方传入。
  // [权衡] 两次 store 订阅发生在早退判断之前，隐藏场景也会订阅，换来 Hook 顺序恒定。
  // 主题与代码预览设置由调用方注入，provider 缺失时走默认值，不会抛错。
  const theme = useZCodeStoreWithDefault((state) => state.theme, "system");
  const codePreviewSettings = useZCodeStoreWithDefault(
    (state) => state.codePreviewSettings,
    DEFAULT_CODE_PREVIEW_SETTINGS,
  );
  const openLabel = intl.formatMessage({
    id: "settings.modelProvider.codingPlan.billingDiscountInfo.open",
  });
  // [失败路径] 规则缺失时隐藏入口而非打开空弹窗，避免用户点到没有内容的问号。
  // 该判断位于所有 hooks 之后，保证 Hook 调用顺序不随配置有无而变化。
  // 活动规则会随服务端运营配置变化，必须整体使用远端标题和 Markdown 正文，
  // 缺失时隐藏入口，避免本地旧规则与当前活动不一致。
  if (!copy.infoTitle || !copy.infoBody) {
    return null;
  }
  // 标题提升为二级标题再拼正文，空行分隔是 Markdown 解析成标题加段落的必要条件。
  // 正文本身已是 Markdown，这里不再转义，防止双重转义把排版符号当普通字符。
  const markdown = `## ${copy.infoTitle}\n\n${copy.infoBody}`;
  return (
    <Dialog>
      <DialogTrigger asChild>
        <InfoIcon
          role="button"
          tabIndex={0}
          aria-label={openLabel}
          className={cn(
            "size-3.5 shrink-0 cursor-pointer rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
            tone === "onGradient"
              ? "text-white/90 hover:text-white"
              : "text-foreground-subtle hover:text-foreground",
          )}
        />
      </DialogTrigger>
      <DialogContent
        className={cn(
          CODING_PLAN_BILLING_DISCOUNT_DIALOG_CONTENT_CLASS,
          "block",
        )}
      >
        <div className={CODING_PLAN_BILLING_DISCOUNT_DIALOG_BODY_CLASS}>
          <MessageResponse
            className="min-h-0 overflow-y-auto pr-1 text-foreground"
            theme={theme}
            codePreviewSettings={codePreviewSettings}
          >
            {markdown}
          </MessageResponse>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// 测试辅助：同时清空缓存与在途请求，避免上一个用例的 Promise 泄漏到下一个用例。
// 只清缓存不清在途请求，会让新用例复用到旧 Promise，产生顺序相关的偶发失败。
export function clearCodingPlanBillingDiscountCacheForTest() {
  billingDiscountCache = null;
  billingDiscountRequest = null;
}

export function primeCodingPlanBillingDiscountCacheForTest(
  config: CodingPlanBillingDiscountConfig | undefined,
) {
  billingDiscountCache = {
    value: config,
    expiresAt: Date.now() + BILLING_DISCOUNT_CACHE_TTL_MS,
  };
  billingDiscountRequest = null;
}

// 取数核心三级决策：命中未过期缓存、复用同帧在途请求、否则发起新请求。
// 返回 undefined 是合法结果，调用方用 active 区分无活动与失败两种空。
async function loadCodingPlanBillingDiscount(
  service: Pick<ICodingPlanSubscriptionService, "getBillingDiscount">,
): Promise<CodingPlanBillingDiscountConfig | undefined> {
  const now = Date.now();
  if (billingDiscountCache && billingDiscountCache.expiresAt > now) {
    return billingDiscountCache.value;
  }
  // [并发] 复用同帧在途请求：并发的多个挂载只产生一次网络往返，其余共享同一 Promise。
  // 复用方不各自写缓存，缓存由发起方在 finally 之前写入，语义上只有一次写入。
  if (billingDiscountRequest) {
    return billingDiscountRequest;
  }

  const request = service.getBillingDiscount();
  billingDiscountRequest = request;
  try {
    const discount = await request;
    billingDiscountCache = {
      value: discount,
      expiresAt: now + BILLING_DISCOUNT_CACHE_TTL_MS,
    };
    return discount;
  // [失败路径] finally 无论成功失败都执行，保证在途引用不会永久悬挂而吞掉后续请求。
  // 用引用相等判断归属，避免把别人刚发起的新请求误清空，对应 INV-03。
  } finally {
    if (billingDiscountRequest === request) {
      billingDiscountRequest = null;
    }
  }
}

// 文案清洗：非字符串与纯空白一律归为 undefined，让上层判空只处理一种空。
// 返回 trim 后的值，避免首尾空格进入排版导致对齐偏移或出现视觉空隙。
function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
