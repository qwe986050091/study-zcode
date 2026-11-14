// INV-01 守住位置：StartPlanCard 首分支以 resolveStartPlanEntitlementSummary 的返回值为唯一准入条件｜改错故障：去掉该判空会在无远端额度时渲染出空指标卡
// INV-02 守住位置：可展示额度只认 meter 为 model_usage 且 grantUnits 大于零且 showName 非空的条目｜改错故障：放宽过滤会把赠送额度或未命名模型算进总额
// INV-03 守住位置：entitlementSummary 为空时整块返回 null 而不是退回本地文案｜改错故障：本地兜底会和远端配置出现两套口径，诱导用户按错误额度购买
// INV-04 守住位置：主指标 heroMetric 取 grantUnitsLabel，单位取 unitLabel，二者来自同一条 primary 记录｜改错故障：分头取不同条目会让数字与周期单位对不上
// INV-05 守住位置：title 对 preview.name 做去空白处理，展示前清掉首尾空字符｜改错故障：远端名称带换行时会撑破卡片头部布局
// INV-06 守住位置：description 与明细文案同源，都由 formatEntitlementDetailsDescription 生成｜改错故障：卡片正文另起一套拼接会与明细口径分叉
// INV-07 守住位置：主视觉数值由 totalGrantUnits 求和得到，求和范围就是过滤后的 entitlements｜改错故障：少加或多加一条会让总额与逐模型明细对不上账
// INV-08 守住位置：[权衡] 英文主视觉走 Intl.NumberFormat 的长量级写法，中文仍走 formatCompactTokenNumber｜改错故障：统一改成 K/M/B 会让英文文案丢失 Million 量级表达
// INV-09 守住位置：[权衡] 英文 compactDisplay 固定为 long，maximumFractionDigits 为 1，minimumFractionDigits 为 0｜改错故障：放开小数位会出现 4.999 Million 这类噪声读数
// INV-10 守住位置：英文首字母大写的替换只作用于 thousand 到 trillion 四个单词｜改错故障：替换规则放宽会误伤模型名或单位后缀
// INV-11 守住位置：[事务] 明细按 grantUnits 分组，同额度模型合并成「各 X」一句｜改错故障：逐条平铺会让同额度模型重复刷屏，卡片高度失控
// INV-12 守住位置：分组以 Map 的 grantUnits 为键，保持首次出现的顺序｜改错故障：改用普通对象会因键排序规则改变明细顺序
// INV-13 守住位置：[并发] 分组函数只读 entitlements 并新建 Map，不修改传入数组｜改错故障：就地排序会污染调用方持有的预览配置
// INV-14 守住位置：[失败路径] primary 取 entitlements 首项后再判空，缺失时返回 null｜改错故障：直接解引用首项会在过滤器放行空数组时抛错
// INV-15 守住位置：[失败路径] 明细拼接的模型名缺失时回落为空串，不让未定义值进入文案｜改错故障：占位文案里出现 undefined 会被用户当成模型名
// INV-16 守住位置：[资源] 卡片不发起请求也不持有状态，所有数据来自 preview 与 actions｜改错故障：组件内补拉配置会引入额外时延与不一致窗口
// INV-17 守住位置：[资源] actions 只在调用方传入时渲染，且窄屏下按钮撑满容器｜改错故障：无条件渲染空容器会在头部留下无法解释的空白
// INV-18 守住位置：[权衡] period 只区分 daily 与其余情况，其余一律走 generic 文案｜改错故障：新增周期未落文案时会静默显示成通用表述
//
// 模块职责：把远端 startPlanPreview 的额度信息渲染成体验套餐卡片，并统一主指标、单位与明细三处口径。
// 状态所有权：无本地状态；preview 与 actions 由调用方持有，intl 与 locale 来自 useZCodeIntl，本模块只做派生计算。
// 阅读顺序：先看 StartPlanCard 的入口与空态返回，再看 resolveStartPlanEntitlementSummary 的过滤与汇总，最后看三个格式化函数的分组与本地化分支。
import type { ReactNode } from "react";
import type { StartPlanPreviewConfig, StartPlanPreviewEntitlement } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatCompactTokenNumber } from "@/lib/tokenNumberFormat.js";

export interface StartPlanEntitlementSummary {
  grantUnitsLabel: string;
  detailsDescription: string;
  unitLabel: string;
}

// 卡片入口只接收 preview 与可选 actions，不自行读取任何全局配置
// preview 是远端 startPlanPreview 的完整快照，组件内不再二次派生请求
// actions 由调用方注入，用于放置购买或升级按钮，组件不关心其具体行为
// intl 与 locale 在同一处从 useZCodeIntl 取出，保证文案与数字格式共用同一语言
// 所有展示值都在渲染前算好，JSX 里不出现业务判断，便于逐项核对口径
// 改错后果：把 actions 塞进内部状态会让卡片在重新渲染时丢失按钮的回调绑定
export function StartPlanCard({
  preview,
  actions,
}: {
  preview: StartPlanPreviewConfig;
  actions?: ReactNode;
}) {
  const { intl, locale } = useZCodeIntl();
  const entitlementSummary = resolveStartPlanEntitlementSummary(preview, intl, locale);
  // 空态是唯一允许整块消失的出口，返回 null 让父级布局自然收起
  // [失败路径] 远端未下发 entitlements 或全部被过滤时都会走到这里
  // 这里刻意不回退到本地 Trial 文案，避免与远端额度出现两套数字
  // 改错后果：把 null 改成占位卡片会让用户看到一张没有任何额度的体验套餐
  if (!entitlementSummary) {
    // 体验套餐卡片必须由远端 startPlanPreview.entitlements 驱动；
    // 没有可展示额度时不能再回退到本地硬编码 Trial plan 文案。
    return null;
  }

  // 标题直接取 preview.name，去空白只处理远端可能带出的首尾空字符
  // heroMetric 与 heroMetricUnit 都来自 entitlementSummary，不在这里重算
  // description 复用明细文案，卡片正文与下方明细因此永远一致
  // 三个派生值都是纯字符串，渲染期间不会再变，可安全直接嵌入 JSX
  // 改错后果：把 title 换成硬编码套餐名会让远端改名后页面仍显示旧称
  const title = preview.name.trim();
  const heroMetric = entitlementSummary.grantUnitsLabel;
  const heroMetricUnit = entitlementSummary.unitLabel;
  const description = entitlementSummary.detailsDescription;

  return (
    <div className="space-y-3">
      <h3 className="text-ui-base font-semibold text-foreground">
        {intl.formatMessage({
          id: "settings.modelProvider.startPlan.quotaSectionTitle",
        })}
      </h3>
      <div className="min-h-20 overflow-hidden rounded-xl border border-border bg-[radial-gradient(circle_at_14%_12%,color-mix(in_srgb,var(--color-success)_24%,var(--color-background)_76%)_0%,color-mix(in_srgb,var(--color-success)_10%,var(--color-surface)_90%)_64%,var(--color-surface)_300%)] p-4">
        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="flex min-w-0 items-center justify-between gap-3 max-sm:flex-col max-sm:items-stretch">
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                <span className="w-fit shrink-0 rounded-full border border-border bg-background px-2 py-0.5 text-ui-sm font-medium text-foreground-subtle">
                  {intl.formatMessage({
                    id: "settings.modelProvider.startPlan.eligibleNewUser",
                  })}
                </span>
                <span className="min-w-0 truncate text-ui-base font-medium text-foreground">
                  {title}
                </span>
              </div>
              <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span className="text-2xl font-bold leading-none text-foreground">
                  {heroMetric}
                </span>
                <span className="text-ui-base font-medium text-foreground-subtle">
                  {heroMetricUnit}
                </span>
              </div>
            </div>
            {actions ? <div className="max-sm:[&>button]:w-full">{actions}</div> : null}
          </div>
          <p className="max-w-2xl text-ui-base leading-5 text-foreground-subtle">
            {description}
          </p>
        </div>
      </div>
    </div>
  );
}

export function resolveStartPlanEntitlementSummary(
  preview: StartPlanPreviewConfig,
  intl: ReturnType<typeof useZCodeIntl>["intl"],
  locale: string,
): StartPlanEntitlementSummary | null {
  // 过滤是全部后续计算的唯一准入点，明细与总额共用同一份结果
  // isDisplayableModelUsageEntitlement 要求 meter 为 model_usage，排除赠送或试用类额度
  // grantUnits 必须大于零，零额度条目既不进总额也不进明细
  // showName 需要去空白后非空，避免无名模型在明细里留下孤立单位
  // [失败路径] 过滤后为空直接返回 null，调用方据此隐藏整张卡片
  // 改错后果：把过滤放宽到全部条目会让总额虚高，用户按错误额度判断是否购买
  const entitlements = (preview?.entitlements ?? []).filter(isDisplayableModelUsageEntitlement);
  if (entitlements.length === 0) {
    return null;
  }

  const primary = entitlements[0];
  if (!primary) {
    return null;
  }

  // Trial Plan 主指标展示总额度；明细按 grantUnits 分组展示各模型额度。
  // 同额度模型合并成“各 X”，避免重复文字，同时保留逐模型配额差异。
  const detailsDescription = formatEntitlementDetailsDescription(
    entitlements,
    primary,
    intl,
    locale,
  );
  // 总额用 reduce 累加 grantUnits，初值为 0，空数组时结果仍是 0
  // 求和范围严格等于过滤后的 entitlements，不额外并入 primary
  // 该值只用于主视觉数字，明细仍按分组展示各自额度
  // [权衡] 用一次性求和代替逐条累加变量，避免渲染期间出现中间态
  // 改错后果：漏掉初值 0 会让首项被当作初始累加器，空数组时直接抛错
  const totalGrantUnits = entitlements.reduce(
    (total, entitlement) => total + entitlement.grantUnits,
    0,
  );

  return {
    grantUnitsLabel: formatHeroGrantUnits(totalGrantUnits, locale),
    detailsDescription,
    unitLabel: formatStartPlanUnitLabel(primary, intl),
  };
}

function isDisplayableModelUsageEntitlement(entitlement: StartPlanPreviewEntitlement): boolean {
  return (
    entitlement.meter === "model_usage" &&
    entitlement.grantUnits > 0 &&
    entitlement.showName.trim().length > 0
  );
}

function formatCompactUnits(value: number, locale: string): string {
  return formatCompactTokenNumber(locale, value);
}

function formatHeroGrantUnits(value: number, locale: string): string {
  // [权衡] 只有英文主视觉需要完整量级，判定依据是 locale 前缀为 en
  // 其余语言继续走 formatCompactTokenNumber，保持万与亿的中文口径
  // 改错后果：把判定写成全等 en 会漏掉 en-US 等地区码，英文页面退回 K/M/B
  // 改错后果：把中文也切到长写法会让主视觉数字过长，挤掉单位位置
  if (locale.toLowerCase().startsWith("en")) {
    // 体验套餐主视觉英文需要表达完整量级（如 5 Million），
    // 但明细和其它 token 用量仍保留 compact 的 K/M/B 或中文万/亿口径。
    return new Intl.NumberFormat(locale || "en-US", {
      notation: Math.abs(value) >= 1_000 ? "compact" : "standard",
      compactDisplay: "long",
      maximumFractionDigits: 1,
      minimumFractionDigits: 0,
    })
      .format(value)
      .replace(/\b(thousand|million|billion|trillion)\b/g, (unit) =>
        unit.slice(0, 1).toUpperCase() + unit.slice(1),
      );
  }
  return formatCompactTokenNumber(locale, value);
}

function formatEntitlementDetailsDescription(
  entitlements: StartPlanPreviewEntitlement[],
  primary: StartPlanPreviewEntitlement,
  intl: ReturnType<typeof useZCodeIntl>["intl"],
  locale: string,
): string {
  const unit = formatStartPlanUnitTypeLabel(primary, intl);
  const groups = groupEntitlementsByGrantUnits(entitlements);
  const separator = " · ";
  const details = groups
    .map((group) =>
      group.modelNames.length > 1
        ? intl.formatMessage(
            {
              id: "settings.modelProvider.startPlan.preview.entitlementGroup.each",
            },
            {
              models: formatModelList(group.modelNames, locale),
              quota: formatCompactUnits(group.grantUnits, locale),
              unit,
            },
          )
        : intl.formatMessage(
            {
              id: "settings.modelProvider.startPlan.preview.entitlementGroup.single",
            },
            {
              model: group.modelNames[0] ?? "",
              quota: formatCompactUnits(group.grantUnits, locale),
              unit,
            },
          ),
    )
    .join(separator);

  return intl.formatMessage(
    {
      id:
        primary.period === "daily"
          ? "settings.modelProvider.startPlan.preview.entitlementSummary.daily"
          : "settings.modelProvider.startPlan.preview.entitlementSummary.generic",
    },
    { details },
  );
}

function groupEntitlementsByGrantUnits(
  entitlements: StartPlanPreviewEntitlement[],
): Array<{ grantUnits: number; modelNames: string[] }> {
  // 分组键是 grantUnits，同额度模型收进同一数组，顺序按首次出现
  // 遍历 entitlements 时先取旧数组再追加 showName，最后回写 Map
  // [并发] 每次调用都新建 Map，不缓存也不修改入参，多次渲染互不影响
  // 改错后果：改用对象字面量会让数字键按字符串排序，明细顺序与远端下发不一致
  const groups = new Map<number, string[]>();
  for (const entitlement of entitlements) {
    const modelNames = groups.get(entitlement.grantUnits) ?? [];
    modelNames.push(entitlement.showName);
    groups.set(entitlement.grantUnits, modelNames);
  }
  return [...groups.entries()].map(([grantUnits, modelNames]) => ({
    grantUnits,
    modelNames,
  }));
}

function formatModelList(modelNames: string[], locale: string): string {
  if (locale.toLowerCase().startsWith("zh")) {
    return modelNames.join("、");
  }
  if (modelNames.length <= 2) {
    return modelNames.join(" / ");
  }
  return modelNames.join(" / ");
}

function formatStartPlanUnitLabel(
  entitlement: StartPlanPreviewEntitlement,
  intl: ReturnType<typeof useZCodeIntl>["intl"],
): string {
  const unit = formatStartPlanUnitTypeLabel(entitlement, intl);
  if (entitlement.period === "daily") {
    return intl.formatMessage(
      {
        id: "settings.modelProvider.startPlan.preview.period.daily",
      },
      { unit },
    );
  }
  return unit;
}

function formatStartPlanUnitTypeLabel(
  entitlement: StartPlanPreviewEntitlement,
  intl: ReturnType<typeof useZCodeIntl>["intl"],
): string {
  return entitlement.unitType === "token"
    ? intl.formatMessage({
        id: "settings.modelProvider.startPlan.preview.unit.tokens",
      })
    : entitlement.unitType;
}
