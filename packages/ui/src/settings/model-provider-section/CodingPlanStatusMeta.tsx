//
// 文件职责：设置页「模型套餐 / Start Plan」状态元信息的唯一渲染与时间语义解析层，只负责展示与推导，不发起请求。
// 不变量清单（INV-01..INV-20）：每条给出「不变量 / 守卫位置 / 破坏后果」。
//
// INV-01 单一渲染入口：CodingPlanStatusMeta 与 StartPlanStatusMeta 是套餐元信息唯一出口，改动需同步设置页调用方，否则会出现两套分隔符逻辑。
// INV-02 renew 优先于 expire：resolveCodingPlanSubscriptionTime 先判 renewTime，顺序颠倒会把续费日显示成到期日。
// INV-03 空白串按缺失处理：两处 trim 校验保证空串与纯空格不产生空标签，删除校验会渲染出只含分隔符的行。
// INV-04 无效日期原样回显：formatStartPlanExpireDate 与 formatCodingPlanSubscriptionDate 在 NaN 时返回入参，去掉会把 Invalid Date 抬到界面。
// INV-05 订阅日期按 UTC 格式化：formatCodingPlanSubscriptionDate 固定 timeZone 为 UTC，改成默认时区会让美西时区整体前移一天。
// INV-06 同年判定与 UTC 对齐：该函数的 isCurrentYear 使用 getUTCFullYear，混用本地年会在跨年边界多显示或少显示年份。
// INV-07 Start Plan 到期用本地时区：formatStartPlanExpireDate 不传 timeZone，补齐时分后按本地解释，改成 UTC 会让到期时刻偏移。
// INV-08 Start Plan 不展示 renew：StartPlanStatusMeta 只读 expireTime，接入 renewTime 会把免费额度刷新时间误读为续费。
// INV-09 相对日期仅限今明两天：formatStartPlanEffectiveDate 只在 dayDifference 为 0 或 1 时用 RelativeTimeFormat，扩大范围会出现不稳定的「3 天后」文案。
// INV-10 日历日差按本地零点对齐：resolveLocalCalendarDayIndex 用本地年月日构造 UTC 零点，直接用时间戳相减会让「明天」在深夜误判。
// INV-11 pending 判定优先级最高：resolveStartPlanStatusMetaState 先返回 pending，若挪到 hasQuota 判断之后，排期权益会提前露出刷新按钮。
// INV-12 立即生效哨兵必须排除：effective_at=0 投影为 Unix Epoch，refreshable 分支要求毫秒数大于 0，删掉会为立即生效套餐显示刷新。
// INV-13 非有限时间戳必须丢弃：两处 Date.parse 后接 Number.isFinite，否则 NaN 参与比较恒为 false，状态会静默落到 settled。
// INV-14 最早未来时间胜出：resolvePendingStartPlanEffectiveTime 排序后取首个，返回顺序不稳定会让倒计时多次渲染间跳动。
// INV-15 定时器需分段唤醒：StartPlanStatusMeta 的 setTimeout 以 2147483647 截断，去掉 Math.min 会在超过约 24.8 天时立即触发。
// INV-16 定时器必须清理：该 effect 返回 clearTimeout，删除清理会在 entitlements 变更后叠加多个计时器并重复 setState。
// INV-17 时间基准随 entitlements 重置：独立 effect 依赖 entitlements，缺失会让同一排期复用旧基准，刷新按钮延迟出现。
// INV-18 分隔符与可见内容同源：三处 CodingPlanMetaSeparator 的 visible 表达式必须与实际渲染项一致，漂移会产生首尾孤立圆点。
// INV-19 兜底文案仅在完全空态：fallbackStatusLabel 受 hasMetaContent 约束，放宽后会出现「已购买」与操作项并存。
// INV-20 请求期间保持禁用：刷新按钮 disabled 绑定 refreshing，点击后立即禁用，否则并发点击会重复发起额度同步。
import type { UsageEntitlementSubscriptionDetail } from "@zcode/shared";
import { Loader2Icon, RefreshCwIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

// 组件职责：把「订阅时间 + 状态标签 + 管理/解绑操作」拼成一行元信息，仅做展示与事件透传。
// [并发] 所有判断都来自 props，组件内无 state，父级重渲染不会产生额外副作用或竞态。
// 调用方需保证 onManage 与 onUnlink 可重复执行，本组件不做点击去重，重复触发由上层兜底。
// 布局约束：外层 span 依赖 flex-wrap，条目增多时换行而不是截断，去掉 wrap 会在窄侧栏溢出。
export function CodingPlanStatusMeta({
  renewTime,
  expireTime,
  extraAction,
  statusLabel,
  manageLabel,
  unlinkLabel,
  unlinkLoading,
  onManage,
  onUnlink,
}: {
  extraAction?: ReactNode;
  statusLabel?: ReactNode;
  renewTime?: string | null;
  expireTime?: string | null;
  manageLabel?: string | null;
  unlinkLabel?: string | null;
  unlinkLoading?: boolean;
  onManage?: () => void;
  onUnlink?: () => void;
}) {
  const { intl, locale } = useZCodeIntl();
  // 时间优先级在此收敛：renew 与 expire 同时存在时只取 renew，避免一行里出现两个日期。
  // [权衡] 选择「只显示一个日期」而不是并列展示，是为了让续费语义唯一，代价是到期日被隐藏。
  // 返回 null 时不渲染时间片，后续分隔符也会因 subscriptionTimeLabel 为空自动隐藏。
  const subscriptionTime = resolveCodingPlanSubscriptionTime({
    renewTime,
    expireTime,
  });
  const subscriptionTimeLabel = subscriptionTime
    ? intl.formatMessage(
        {
          id:
            subscriptionTime.kind === "renew"
              ? "settings.modelProvider.codingPlan.renewsAt"
              : "settings.modelProvider.codingPlan.expiresAt",
        },
        {
          date: formatCodingPlanSubscriptionDate(subscriptionTime.value, locale),
        },
      )
    : null;
  // [失败路径] 兜底文案的开关：只有所有可渲染项都为空时才回落「已购买」，否则保持 null。
  // manageLabel 与 onManage 这类成对判断不可简化为单侧，否则标签存在但回调缺失时会渲染空操作位。
  // 修改此处需同步 unlink 分隔符的 visible 表达式，两处口径漂移会出现尾部孤立圆点。
  const hasMetaContent = Boolean(
    statusLabel ||
    subscriptionTimeLabel ||
    extraAction ||
    (manageLabel && onManage) ||
    (unlinkLabel && onUnlink),
  );
  // 下方 JSX 的书写顺序即视觉顺序：状态标签、订阅时间、额外操作、管理、解绑。
  // 每个分隔符都由紧邻两项是否有内容推导，不能预先固定，否则空项会留下连续两个圆点。
  // [权衡] 状态用纯文本、操作用下划线按钮，靠 CodingPlanMetaAction 统一可点击样式。
  // 管理项前的分隔符只看 `hasMetaContent` 与管理标签，条件比实际渲染略宽。
  // [权衡] 放宽 onManage 判断换取表达式简洁，代价是标签存在而回调缺失时多出一个圆点。
  const fallbackStatusLabel =
    statusLabel ??
    (hasMetaContent
      ? null
      : intl.formatMessage({
          id: "settings.modelProvider.codingPlan.status.purchased",
        }));

  return (
    <span className="flex flex-wrap items-center gap-1.5 text-ui-base text-foreground-subtle">
      {fallbackStatusLabel ? <span>{fallbackStatusLabel}</span> : null}
      {subscriptionTimeLabel ? <span>{subscriptionTimeLabel}</span> : null}
      <CodingPlanMetaSeparator visible={Boolean(subscriptionTimeLabel && extraAction)} />
      {extraAction}
      <CodingPlanMetaSeparator
        visible={Boolean((subscriptionTimeLabel || extraAction) && manageLabel)}
      />
      {manageLabel && onManage ? (
        <CodingPlanMetaAction label={manageLabel} onClick={onManage} />
      ) : null}
      <CodingPlanMetaSeparator
        visible={Boolean(
          (subscriptionTimeLabel || extraAction || manageLabel || fallbackStatusLabel) &&
          unlinkLabel,
        )}
      />
      {unlinkLabel && onUnlink ? (
        <CodingPlanMetaAction label={unlinkLabel} loading={unlinkLoading} onClick={onUnlink} />
      ) : null}
    </span>
  );
}

// 组件职责：渲染 Start Plan（含免费套餐）的排期、就地刷新按钮与到期时间，不涉及续费语义。
// 入参全部可选，缺省 hasQuota 为 false、refreshing 为 false，调用方通常只需给出 entitlements 与 expireTime。
// [并发] refreshing 由父级传入且仅用于禁用按钮，本组件不持有请求状态，避免与外部同步状态分叉。
// 该卡片可能与升级入口并排展示，但绝不承担购买流程，点击刷新只重建额度桶视图。
export function StartPlanStatusMeta({
  expireTime,
  entitlements,
  hasQuota = false,
  refreshing = false,
  onRefresh,
}: {
  expireTime?: string | null;
  entitlements?: UsageEntitlementSubscriptionDetail["entitlements"];
  hasQuota?: boolean;
  refreshing?: boolean;
  onRefresh?: () => void;
}) {
  const { intl, locale } = useZCodeIntl();
  // now 是状态而非渲染期取值：只有它变化才能让 pending 与 refreshable 判定跨越时间边界。
  // [资源] 初值使用惰性初始化，避免每次渲染都调用 Date.now，减少无意义的时间漂移。
  const [currentTime, setCurrentTime] = useState(() => Date.now());
  useEffect(() => {
    setCurrentTime(Date.now());
  }, [entitlements]);
  useEffect(() => {
    // [并发] 依赖 currentTime 与 entitlements，任一变都会重建计时器，清理函数保证同一时刻只有一个挂起定时器。
    // [资源] 无排期或剩余毫秒为负时直接返回，不注册定时器，避免空转唤醒。
    // [失败路径] Date.parse 失败时 Number.isFinite 拦截，防止 NaN 传给 setTimeout 退化为 0 延迟死循环。
    const pendingTime = resolvePendingStartPlanEffectiveTime(entitlements, currentTime);
    if (!pendingTime) return;
    const effectiveAt = Date.parse(pendingTime);
    const remainingMs = effectiveAt - Date.now();
    if (!Number.isFinite(effectiveAt) || remainingMs < 0) return;
    // setTimeout 存在约 24.8 天上限；长排期分段唤醒，到点后再切换刷新按钮。
    const timeout = window.setTimeout(
      () => setCurrentTime(Date.now()),
      Math.min(remainingMs + 1, 2_147_483_647),
    );
    return () => window.clearTimeout(timeout);
  }, [currentTime, entitlements]);
  // 状态三分支由纯函数推导：pending 优先，其次 refreshable，最后 settled，渲染侧只读结果。
  // [权衡] 把判定抽成导出的纯函数便于单测覆盖临界时刻，组件内不再复写时间比较逻辑。
  // [失败路径] 刷新按钮可见性由 statusState 与 onRefresh 共同决定，缺回调时宁可不显示也不留死按钮。
  // [并发] 按钮 disabled 绑定 refreshing，点击后立即禁用，防止重复触发额度同步请求。
  // [权衡] 用 outline 小尺寸按钮而非链接，是为了让「就地刷新」与「管理/解绑」链接在视觉上可区分。
  const statusState = resolveStartPlanStatusMetaState({
    entitlements,
    hasQuota,
    now: currentTime,
  });
  const pendingEffectiveTime =
    statusState === "pending"
      ? resolvePendingStartPlanEffectiveTime(entitlements, currentTime)
      : null;
  // 仅在 pending 态解析展示时间，避免 settled 时重复排序 entitlements 造成无谓开销。
  // 文案 id 固定为 pendingUntil，改成条件 id 会让排期语义在不同语言下漂移。
  const pendingEffectiveTimeLabel = pendingEffectiveTime
    ? intl.formatMessage(
        { id: "settings.modelProvider.startPlan.pendingUntil" },
        { date: formatStartPlanEffectiveDate(pendingEffectiveTime, locale) },
      )
    : null;
  const normalizedExpireTime = expireTime?.trim();
  // expireTime 先 trim 再判空：接口可能给空串，直接判真会渲染出只有标签没有日期的时间片。
  // [失败路径] 非法日期由 formatStartPlanExpireDate 原样返回，此处不做二次校验，避免两处规则分叉。
  const expireTimeLabel = normalizedExpireTime
    ? intl.formatMessage(
        { id: "settings.modelProvider.startPlan.expiresAt" },
        {
          date: formatStartPlanExpireDate(normalizedExpireTime, locale),
        },
      )
    : null;
  // 产品语义：待生效时展示排期；到点但额度桶尚未同步时提供就地刷新；
  // 对应额度桶出现后只保留过期日期。免费套餐无管理页，升级入口在卡片右侧。
  return (
    <span className="flex flex-wrap items-center gap-1.5 text-ui-base text-foreground-subtle">
      {pendingEffectiveTimeLabel ? (
        <span className="whitespace-nowrap text-success">{pendingEffectiveTimeLabel}</span>
      ) : null}
      <CodingPlanMetaSeparator visible={Boolean(pendingEffectiveTimeLabel && expireTimeLabel)} />
      {statusState === "refreshable" && onRefresh ? (
        <>
          {/* Bug 原因：排期权益到点后服务端才创建额度桶，本地仍可能展示旧模型。
              就地刷新只在尚未拿到额度桶时出现；立即生效和已同步成功的套餐不显示。 */}
          <Button
            type="button"
            variant="outline"
            size="xs"
            className="rounded-full border-success/30 bg-success/14 px-2.5 font-medium text-success hover:border-success/50 hover:bg-success/20 hover:text-success dark:border-success/40 dark:bg-success/18 dark:hover:bg-success/24"
            disabled={refreshing}
            onClick={onRefresh}
          >
            {refreshing ? (
              <Loader2Icon className="size-3 animate-spin" aria-hidden="true" />
            ) : (
              <RefreshCwIcon className="size-3" aria-hidden="true" />
            )}
            {intl.formatMessage({
              id: "settings.modelProvider.startPlan.refreshEntitlement",
            })}
          </Button>
          <CodingPlanMetaSeparator visible={Boolean(expireTimeLabel)} />
        </>
      ) : null}
      {expireTimeLabel ? (
        <>
          {/* Bugfix: Start Plan 不展示 renew 时间，状态卡片只保留过期日期，避免把免费额度刷新时间误读成套餐续费。 */}
          <span className="whitespace-nowrap">{expireTimeLabel}</span>
        </>
      ) : null}
    </span>
  );
}

// 纯函数：仅依赖 entitlements、hasQuota 与 now，便于在测试里用固定 now 覆盖临界时刻。
// 第一步收集所有可解析的 effectiveTime，空串与非法日期被丢弃，防止 NaN 污染后续比较。
// [失败路径] 任一 effectiveTime 晚于 now 即判 pending，此时不应显示刷新按钮，因为权益尚未到账。
// [并发] 函数无副作用且不读全局时间，多实例渲染结果一致，不会出现同屏状态不一致。
// 返回值只有三个字面量，调用方必须穷举处理，新增状态需同步 StartPlanStatusMeta 的渲染分支。
export function resolveStartPlanStatusMetaState({
  entitlements,
  hasQuota,
  now = Date.now(),
}: {
  entitlements: UsageEntitlementSubscriptionDetail["entitlements"];
  hasQuota: boolean;
  now?: number;
}): "pending" | "refreshable" | "settled" {
  const effectiveTimes = (entitlements ?? []).flatMap((entitlement) => {
    const effectiveTime = entitlement.effectiveTime?.trim();
    if (!effectiveTime) return [];
    const milliseconds = Date.parse(effectiveTime);
    return Number.isFinite(milliseconds) ? [milliseconds] : [];
  });
  // pending 判定放在最前：只要存在未来排期就压住刷新入口，避免排期套餐被当成「到点未同步」。
  // [权衡] 这里不区分是哪一条权益，多权益场景下只要最晚的一条未到点即整体等待。
  if (effectiveTimes.some((milliseconds) => milliseconds > now)) {
    return "pending";
  }
  if (
    !hasQuota &&
    // effective_at=0 会投影为 Unix Epoch，是立即生效哨兵值，不属于排期权益。
    effectiveTimes.some((milliseconds) => milliseconds > 0 && milliseconds <= now)
  ) {
    return "refreshable";
  }
  return "settled";
}

// 返回最近一条未来排期的原始字符串而非时间戳，供上层原样交给 Intl 格式化，减少精度丢失。
// [并发] 每次调用重新构建数组并排序，不缓存结果，保证 entitlements 更新后立即反映新排期。
// [权衡] 排序取首个而非遍历求最小值，多权益规模很小，可读性优先于常数级优化。
export function resolvePendingStartPlanEffectiveTime(
  entitlements: UsageEntitlementSubscriptionDetail["entitlements"],
  now = Date.now(),
): string | null {
  const futureTimes = (entitlements ?? []).flatMap((entitlement) => {
    const effectiveTime = entitlement.effectiveTime?.trim();
    if (!effectiveTime) return [];
    const milliseconds = Date.parse(effectiveTime);
    return Number.isFinite(milliseconds) && milliseconds > now
      ? [{ effectiveTime, milliseconds }]
      : [];
  });
  futureTimes.sort((left, right) => left.milliseconds - right.milliseconds);
  return futureTimes[0]?.effectiveTime ?? null;
}

// `formatStartPlanEffectiveDate` 对 2 天内用相对日期加时分，更远退化为月日加时分。
// [权衡] 相对日期只在今天与明天窗口内使用，再远会得到「3 天后」这类不精确文案。
// [失败路径] 非法日期直接返回入参，保证界面出现的是原值而不是 Invalid Date。
export function formatStartPlanEffectiveDate(
  value: string,
  locale: string,
  now = Date.now(),
): string {
  const date = new Date(value);
  // [失败路径] 所有格式化入口都保留同名守卫：解析失败时回显原始字符串，便于定位后端脏数据。
  // 去掉该守卫会让 Intl 格式化输出 Invalid Date 或抛 RangeError，污染整行元信息。
  if (Number.isNaN(date.getTime())) return value;
  const currentDate = new Date(now);
  const dayDifference =
    resolveLocalCalendarDayIndex(date) - resolveLocalCalendarDayIndex(currentDate);
  const time = new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
  // 只对今天与明天使用相对时间，跨两天后统一走绝对日期，避免「后天」这类歧义表述。
  // [权衡] 首字母大写依赖 toLocaleUpperCase，个别语言大小写规则不同，接受轻微不一致换取文案统一。
  if (dayDifference === 0 || dayDifference === 1) {
    const relativeDay = new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(
      dayDifference,
      "day",
    );
    const displayDay = relativeDay.replace(/^./u, (character) =>
      character.toLocaleUpperCase(locale),
    );
    return `${displayDay} ${time}`;
  }
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

// 把本地年月日压成 UTC 零点后再除以一天毫秒数，得到与夏令时无关的整数日历日。
// [失败路径] 若直接用 getTime 相减，夏令时切换日会出现 23 或 25 小时，导致「明天」误判为今天。
function resolveLocalCalendarDayIndex(date: Date): number {
  return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000);
}

// 分隔符是纯受控组件：visible 为 false 时返回 null，绝不依赖 CSS 隐藏，避免布局占位。
// [权衡] 圆点用 aria-hidden 标记，读屏软件不会朗读，视觉分隔不进入无障碍语义。
function CodingPlanMetaSeparator({ visible }: { visible: boolean }) {
  return visible ? <span aria-hidden="true">·</span> : null;
}

// 操作项统一走原生 button 并显式声明 type 为 button，防止嵌在表单里时触发默认提交。
// [并发] loading 直接映射为 disabled，禁用态同时关闭指针事件与悬停样式，避免重复点击。
function CodingPlanMetaAction({
  label,
  loading,
  onClick,
}: {
  label: string;
  loading?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="text-ui-base font-medium text-brand underline-offset-2 hover:text-brand/80 hover:underline disabled:pointer-events-none disabled:opacity-50"
      disabled={loading}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

function resolveCodingPlanSubscriptionTime({
  renewTime,
  expireTime,
}: {
  renewTime?: string | null;
  expireTime?: string | null;
}): { kind: "renew" | "expire"; value: string } | null {
  // [事务] 先判 renew 再判 expire，等价于「续费信息覆盖到期信息」的优先级契约。
  // 两侧都为 null、undefined、空串或纯空格时返回 null，调用方据此完全省略时间片。
  const normalizedRenewTime = renewTime?.trim();
  if (normalizedRenewTime) {
    return { kind: "renew", value: normalizedRenewTime };
  }

  const normalizedExpireTime = expireTime?.trim();
  if (normalizedExpireTime) {
    return { kind: "expire", value: normalizedExpireTime };
  }

  return null;
}

// 订阅接口返回日期语义的 ISO 字符串，这里统一按 UTC 展示，不做本地时区换算。
// [失败路径] 非法输入原样返回，避免设置页出现 Invalid Date 或抛异常中断整块渲染。
function formatCodingPlanSubscriptionDate(value: string, locale: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  // 同年隐藏年份、跨年补年份；判定与格式化都必须用 UTC，混用会导致临界时区年份误判。
  // [权衡] 只比较年份而非完整日期，跨年当天展示月日可接受，胜过固定展示年份的冗余。
  const isCurrentYear = date.getUTCFullYear() === new Date().getUTCFullYear();
  return new Intl.DateTimeFormat(locale, {
    ...(isCurrentYear ? {} : { year: "numeric" }),
    month: "short",
    day: "numeric",
    // 订阅接口返回的是日期语义，按本地时区格式化 ISO 零点会让美国时区显示成前一天。
    // 同一年隐藏年份时也要按 UTC 判断，否则临界时区会把“今年”误判成去年/明年。
    timeZone: "UTC",
  }).format(date);
}

// Start Plan 到期时间按本地时区格式化并补齐时分，用于区分「今天几点失效」与「明天失效」。
// now 参数只为可测试注入，默认取当前时间，业务代码不要显式传入固定值。
// [失败路径] 解析失败返回原字符串，调用方无需额外兜底即可安全渲染。
export function formatStartPlanExpireDate(value: string, locale: string, now = Date.now()): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  // 与订阅日期不同，这里的年份比较使用本地时间，与下方不带 timeZone 的格式化保持一致。
  // [权衡] 仅跨年时展示年份，牺牲少量信息量换取卡片宽度稳定。
  const isCurrentYear = date.getFullYear() === new Date(now).getFullYear();
  // Start Plan 过去只展示到期日，同一天内无法判断额度具体何时失效。
  // 过期时间按客户端本地时区补齐小时分钟，并继续仅在跨年时展示年份。
  return new Intl.DateTimeFormat(locale, {
    ...(isCurrentYear ? {} : { year: "numeric" }),
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}
