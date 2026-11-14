// INV-01 normalizeCodingPlanCardCopyItems 必须对 unknown 全量防御，非数组直接返回空数组而不抛错；守住位置：函数首分支；改错故障：服务端下发 null 或对象时卡片区域整块崩溃
// INV-02 卡片文案条目只接受 string 或带 text 的对象两种形态，其余一律丢弃；守住位置：flatMap 内的类型判定；改错故障：脏数据变成对象字符串文案直接显示给用户
// INV-03 text 与 tooltip 都先做去空白再判空，空文本条目不进入结果；守住位置：text 计算与 tooltip 计算；改错故障：纯空白条目占位，卡片出现空行
// INV-04 tooltip 为空时不得写入该键，返回对象只保留 text；守住位置：尾部对象的展开写法；改错故障：空 tooltip 被下游当成有值，渲染出空气泡
// INV-05 CodingPlanProductDisplay 是对 CodingPlanProductPreviewPayment 的纯扩展，不改写上游字段；守住位置：类型定义处；改错故障：与服务端契约漂移，字段重命名后静默取到 undefined
// INV-06 CODING_PLAN_PERIODS 的数组顺序即界面上的周期顺序，monthly 在前 yearly 在后；守住位置：常量声明；改错故障：分组与标签错位，月付卡片显示成季付
// INV-07 周期标签走 i18n key 而不是中文字面量，三种周期必须各有独立 key；守住位置：CODING_PLAN_PERIOD_LABEL_IDS；改错故障：新增语言时该处回落成 key 原文
// INV-08 groupProductsByPeriod 的返回值必须同时含三个周期的数组，即使是空数组；守住位置：groups 初始化；改错故障：消费方按键读取时拿到 undefined，渲染报错
// INV-09 未识别周期的商品由 inferBillingPeriod 兜底成 monthly，分组阶段不得二次过滤；守住位置：for 循环内的入桶；改错故障：新品被静默丢弃，用户看不到可购买套餐
// INV-10 排序只依赖 productLevelRank 的数值差，且统一放在分桶完成之后执行；守住位置：第二个 for 循环；改错故障：边插边排导致顺序不稳定，刷新后卡片跳动
// INV-11 pickProductTitle 的优先级固定为 productName、productBigTitle、productId，最后一级必须保底；守住位置：或运算链；改错故障：标题为空字符串，卡片出现空白头部
// INV-12 pickProductDetails 优先 productDescription 与 productIntroduction，不得把 productEquityList 当首选；守住位置：descriptionDetails 的构造；改错故障：旧权益字段覆盖服务端配置的套餐说明
// INV-13 详情行按换行切分后逐行去空白并丢弃空行，最多保留四行；守住位置：切分与截断的组合；改错故障：卡片被超长文案撑开，布局溢出
// INV-14 详情为空时才回退权益列表，权益标题与详情用中文冒号拼接且同样上限四行；守住位置：函数尾部；改错故障：两条来源同时输出，卡片信息重复
// INV-15 pickProductPrice 的取价顺序是 payAmount、discountAmount、renewAmount，全部缺失返回 null；守住位置：空值合并链；改错故障：待定价格套餐被显示成 0 元
// INV-16 normalizeCodingPlanCurrency 只认 USD，其余一律收敛为 CNY，不做汇率换算；守住位置：三元判断；改错故障：未知币种被当成 USD，价格量级严重失真
// INV-17 formatCodingPlanAmount 固定两位小数并按 locale 选择符号，中文前缀为 ¥、其余为 CN¥；守住位置：currencyPrefix 分支；改错故障：海外用户把人民币符号误读成美元
// INV-18 inferBillingPeriod 的判定优先级是 priceUnit、资源包名正则、金额比值、monthly 兜底，顺序不可交换；守住位置：函数整体；改错故障：商品名先命中正则会覆盖后端明确的 priceUnit
//
// 模块职责：把服务端下发的 CodingPlan 预览支付数据结构化成卡片可直接消费的显示模型，并统一文案、价格、周期与排序口径
// 状态所有权：本文件不持有任何状态，输入全部来自参数，输出均为新建对象，不修改调用方传入的数组与对象
// 阅读顺序：先看 normalizeCodingPlanCardCopyItems 与类型定义确立契约，再看 groupProductsByPeriod 的组装顺序，最后看价格、金额与周期三条判定链
import type {
  CodingPlanCardCopyItem,
  CodingPlanProductPreviewPayment,
} from "@zcode/shared";

export function normalizeCodingPlanCardCopyItems(
  items: unknown,
): CodingPlanCardCopyItem[] {
  // 入口声明为 unknown，说明调用点可能拿到服务端任意 JSON，所有取值都必须先类型收窄
  // 非数组直接返回空数组而不是抛错，卡片区域宁可空白也不能让整个设置页白屏
  // [失败路径] items 为 null、单个字符串或普通对象时都落到这里，调用方无需再包一层异常处理
  // string 与对象两种形态并存，是为了兼容后端早期只下发纯字符串的历史配置
  // 对象形态只读取 text 与 tooltip 两个字段，其余字段一律忽略，避免未知结构透传到界面
  // 整体用 flatMap 而不是 map，被判废的条目返回空数组即可自然消失，结果不会留下空洞
  if (!Array.isArray(items)) {
    return [];
  }
  return items.flatMap((item) => {
    if (
      typeof item !== "string" &&
      (!item || typeof item !== "object")
    ) {
      return [];
    }
    const text =
      typeof item === "string"
        ? item.trim()
        : typeof (item as { text?: unknown }).text === "string"
          ? (item as { text: string }).text.trim()
          : "";
    if (!text) {
      return [];
    }
    const tooltip =
      typeof item === "string" ||
      typeof (item as { tooltip?: unknown }).tooltip !== "string"
        ? ""
        : (item as { tooltip: string }).tooltip.trim();
    return [{ text, ...(tooltip ? { tooltip } : {}) }];
  });
}

export type CodingPlanBillingPeriod = "monthly" | "quarterly" | "yearly";
export type CodingPlanPriceCurrency = "CNY" | "USD";
export type CodingPlanPriceUnit = "month" | "quarter" | "year";

// 显示模型只做叠加不做改写，服务端字段一旦改名这里会以类型错误暴露，而不是静默取到 undefined
// priceCurrency 留空时由 normalizeCodingPlanCurrency 收敛为 CNY，所以此处不设默认值
// externalPurchaseUrl 供海外套餐跳转外部收银台，缺失即表示该套餐走站内下单流程
// hasPreview 是展示开关，为真才渲染试算区域，避免未开通预览的套餐出现空壳
// equity 与 descriptionItems 都是净化后的卡片文案，来源固定为 normalizeCodingPlanCardCopyItems
// [权衡] 把可选字段集中在这一个交叉类型里，代价是调用方需要判空，收益是不复制支付实体
export type CodingPlanProductDisplay = CodingPlanProductPreviewPayment & {
  priceCurrency?: CodingPlanPriceCurrency;
  externalPurchaseUrl?: string;
  hasPreview?: boolean;
  equity?: CodingPlanCardCopyItem[];
  descriptionItems?: CodingPlanCardCopyItem[];
};

// 键类型绑定 CodingPlanPriceCurrency，新增币种时这里会直接编译失败，逼迫补全中文名
// 只服务于中文 locale 的金额后缀，英文路径不追加中文币种名，避免中英混排
// 币种中文名与符号是两套口径，符号由 formatCodingPlanAmount 决定，这里只负责名称
// [资源] 常量表在模块加载期建立一次，渲染热路径上只做一次查表，不产生额外分配
// 人民币写在首位只是阅读习惯，取值永远按键名，不依赖对象字面量的书写顺序
const CODING_PLAN_CURRENCY_LABELS_ZH: Record<CodingPlanPriceCurrency, string> =
  {
    CNY: "人民币",
    USD: "美元",
  };

export const CODING_PLAN_PERIODS: CodingPlanBillingPeriod[] = [
  "monthly",
  "quarterly",
  "yearly",
];

export const CODING_PLAN_PERIOD_LABEL_IDS: Record<
  CodingPlanBillingPeriod,
  string
> = {
  monthly: "settings.modelProvider.codingPlan.period.monthly",
  quarterly: "settings.modelProvider.codingPlan.period.quarterly",
  yearly: "settings.modelProvider.codingPlan.period.yearly",
};

// 入参是已经成型的显示模型数组，本函数不再做净化，净化职责属于上游映射与 normalizeCodingPlanCardCopyItems
// 三个周期的桶在循环开始前全部建好，保证返回值形状恒定，消费方不必判空
// [失败路径] 周期判定整体委托给 inferBillingPeriod，未命中任何规则的套餐落到 monthly，不会被丢弃
// 排序放在分桶之后统一执行，因此排序只作用于本函数新建的数组，不会波及入参
// [权衡] 每次调用都重建三个数组并按需排序，换来实现简单与结果不可变，套餐数量在个位数时开销可忽略
// 排序键 productLevelRank 只表达档位先后，价格与名称都不参与，避免运营改价后卡片顺序跳动
export function groupProductsByPeriod(
  productList: CodingPlanProductDisplay[],
): Record<CodingPlanBillingPeriod, CodingPlanProductDisplay[]> {
  const groups: Record<CodingPlanBillingPeriod, CodingPlanProductDisplay[]> = {
    monthly: [],
    quarterly: [],
    yearly: [],
  };

  for (const product of productList) {
    groups[inferBillingPeriod(product)].push(product);
  }

  for (const period of CODING_PLAN_PERIODS) {
    groups[period].sort(compareCodingPlanProduct);
  }

  return groups;
}

export function pickProductTitle(
  product: CodingPlanProductPreviewPayment,
): string {
  return (
    product.productName?.trim() ||
    product.productBigTitle?.trim() ||
    product.productId
  );
}

// 详情优先取 productDescription 与 productIntroduction，这两项才是服务端配置的套餐说明
// [失败路径] 两项都缺失或全为空白行时，才回退到 productEquityList 的旧权益字段
// 按换行切分后逐行去空白并丢弃空行，保证多行文案不会把卡片压成一条长文本
// 上限固定四行，超出部分直接截断而不是折叠，避免卡片高度随运营文案无限增长
// 权益回退分支用中文冒号连接标题与详情，缺任一侧时只保留存在的一段，不产生孤立符号
export function pickProductDetails(
  product: CodingPlanProductPreviewPayment,
): string[] {
  // 修复原因：套餐卡片的运营文案现在由静态配置的 description 控制；
  // 继续优先拼 productEquityList 会展示旧权益字段，和服务端配置的套餐说明不一致。
  const descriptionDetails = [
    product.productDescription?.trim(),
    product.productIntroduction?.trim(),
  ]
    .filter((value): value is string => Boolean(value))
    .flatMap((value) =>
      value
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean),
    )
    .slice(0, 4);
  if (descriptionDetails.length > 0) {
    return descriptionDetails;
  }

  return (product.productEquityList ?? [])
    .map((equity) =>
      [equity.productEquityTitle?.trim(), equity.productEquityDetails?.trim()]
        .filter(Boolean)
        .join("："),
    )
    .filter(Boolean)
    .slice(0, 4);
}

export function pickProductPrice(
  product: CodingPlanProductPreviewPayment,
): number | null {
  return (
    product.payAmount ?? product.discountAmount ?? product.renewAmount ?? null
  );
}

export function normalizeCodingPlanCurrency(
  currency: string | null | undefined,
): CodingPlanPriceCurrency {
  return currency?.trim().toUpperCase() === "USD" ? "USD" : "CNY";
}

// 金额统一走 Intl 的 NumberFormat 并固定两位小数，避免不同 locale 下小数位与千分位不一致
// 币种符号按 locale 区分，中文环境用 ¥ 与 $，其他环境用 CN¥ 与 US$，防止符号歧义
// 中文环境额外追加 CODING_PLAN_CURRENCY_LABELS_ZH 的中文币种名，英文环境不追加
// [权衡] 不用 Intl 的 currency 样式，因为同一金额在不同 locale 会输出不同的 ISO 代码与符号组合，与产品文案规范冲突
// [失败路径] locale 非法时 Intl 会抛 RangeError，调用方必须传入已校验的 locale，本函数不做兜底
export function formatCodingPlanAmount(
  amount: number,
  currency: string | null | undefined,
  locale: string,
): string {
  const resolvedCurrency = normalizeCodingPlanCurrency(currency);
  const isChineseLocale = locale.toLowerCase().startsWith("zh");
  const formattedAmount = new Intl.NumberFormat(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
  const currencyPrefix = isChineseLocale
    ? resolvedCurrency === "USD"
      ? "$"
      : "¥"
    : resolvedCurrency === "USD"
      ? "US$"
      : "CN¥";
  const formatted = `${currencyPrefix}${formattedAmount}`;

  // 套餐页需要同时展示中英文和跨币种价格；依赖 Intl currency 会在不同 locale 下输出
  // 不一致的 ISO code/符号组合，因此这里按产品文案规范固定符号和中文币种名。
  return isChineseLocale
    ? `${formatted} ${CODING_PLAN_CURRENCY_LABELS_ZH[resolvedCurrency]}`
    : formatted;
}

// 判定优先级固定为 priceUnit、资源包名正则、金额比值、monthly 兜底，调换顺序会改变已有套餐的归属
// priceUnit 是后端显式声明的计费周期，命中即返回，不再参考商品名称
// [失败路径] priceUnit 缺失时才退回 relateResourcePack 的关键词匹配，正则同时覆盖包年与 year 两种写法
// 金额兜底用月度原价与总额的比值四舍五入，十及以上判年付、二及以上判季付，只在前两步都无结论时生效
// [权衡] 比值阈值偏保守，宁可把年付误判成季付也不把月付误升级，避免展示错误的折扣力度
export function inferBillingPeriod(
  product: CodingPlanProductPreviewPayment,
): CodingPlanBillingPeriod {
  const explicitUnit = product.priceUnit;
  if (explicitUnit) {
    // Bugfix: Z.AI 海外套餐会直接返回 priceUnit，优先使用后端给出的计费周期，避免英文商品名或金额折算造成误判。
    return explicitUnit === "year"
      ? "yearly"
      : explicitUnit === "quarter"
        ? "quarterly"
        : "monthly";
  }

  const pack = product.relateResourcePack ?? "";
  if (/包年|-\s*年|year/i.test(pack)) {
    return "yearly";
  }
  if (/包季|-\s*季|quarter/i.test(pack)) {
    return "quarterly";
  }
  if (/包月|-\s*月|month/i.test(pack)) {
    return "monthly";
  }

  const monthlyAmount =
    product.monthlyOriginalAmount ?? product.monthlyPayAmount;
  const totalAmount = product.originalAmount ?? product.payAmount;
  if (typeof monthlyAmount === "number" && typeof totalAmount === "number") {
    const ratio = Math.round(totalAmount / monthlyAmount);
    if (ratio >= 10) {
      return "yearly";
    }
    if (ratio >= 2) {
      return "quarterly";
    }
  }

  return "monthly";
}

function compareCodingPlanProduct(
  left: CodingPlanProductDisplay,
  right: CodingPlanProductDisplay,
): number {
  return productLevelRank(left) - productLevelRank(right);
}

function productLevelRank(product: CodingPlanProductPreviewPayment): number {
  const name = product.productName?.toLowerCase() ?? "";
  if (name.includes("start")) {
    return -1;
  }
  if (name.includes("lite")) {
    return 0;
  }
  if (name.includes("pro")) {
    return 1;
  }
  if (name.includes("max")) {
    return 2;
  }
  return 3;
}
