// INV-01 单一校验源：守住位置 zod schema 导出；改错故障：调用方自行断言，非法投放进入渲染。
// INV-02 主题复用：守住位置 cloudButtonThemeSchema 引用；改错故障：营销按钮主题与云内容出现两套定义。
// INV-03 id 非空：守住位置 id 的 trim 与 min；改错故障：空白投放标识无法去重。
// INV-04 地址协议受限：守住位置 url 的 refine；改错故障：file 或 javascript 协议被当作可打开链接。
// INV-05 地址不含凭据：守住位置 username 与 password 判空；改错故障：带账号密码的地址被下发。
// INV-06 素材双字段：守住位置 素材的 src 与 sha256；改错故障：缺哈希导致缓存无法校验。
// INV-07 strict 分支：守住位置 导航与动作的 strict；改错故障：未知字段被静默接受，前后端契约漂移。
// INV-08 设置页约束：守住位置 provider_id 与 section 的 refine；改错故障：非模型页带供应商参数仍通过。
// INV-09 空格式归一：守住位置 bannerButton 的 transform；改错故障：空格式投放被丢弃或渲染为空白。
// INV-10 路径安全：守住位置 bundle 入口的路径校验；改错故障：入口穿越到上级目录。
// INV-11 数量上限：守住位置 按钮与投放数组的 max；改错故障：异常载荷撑爆界面。
// INV-12 视觉体积上限：守住位置 visualArgs 的序列化长度限制；改错故障：超大参数拖慢解析。
// INV-13 资源位判别同步：守住位置 marketingDeliverySchema 的判别值；改错故障：旧命名投放被整条丢弃。
// INV-14 单条容错：守住位置 parse 循环里的 safeParse；改错故障：一条坏投放导致整批失败。
// INV-15 外层不吞错：守住位置 envelope.parse 直接调用；改错故障：信封错误伪装成成功空结果。
// INV-16 资源位去重：守住位置 positions 集合；改错故障：同一位置渲染两份投放。
// INV-17 拒绝可观测：守住位置 rejectedCount 返回；改错故障：坏数据被静默忽略，无法排查。
// INV-18 时间单位：守住位置 server_time 乘 1000；改错故障：时间戳差三个数量级。
//
// 模块职责：定义营销投放的校验 schema、类型推导与响应解析，供客户端安全消费服务端投放。
// 状态所有权：无状态；schema 是模块常量，解析函数只返回新对象。
// 阅读顺序：基础标量 → 导航与动作 → 视觉与弹窗 → 投放与信封 → 类型导出 → 解析函数。
import { z } from "zod";
import { cloudButtonThemeSchema } from "./cloudContent.js";

const id = z.string().trim().min(1).max(128);
// id 用于投放标识：去空白后必须非空，长度上限防止异常载荷。
// url 只允许 http 与 https，且拒绝带账号密码的地址。
// 先判可解析再取协议，避免异常字符串中断后续校验。
//
const url = z
  .string()
  .max(4096)
  .url()
  .refine((value) => {
    if (!URL.canParse(value)) return false;
    const parsed = new URL(value);
    return ["http:", "https:"].includes(parsed.protocol) && !parsed.username && !parsed.password;
  });
// 素材必须同时给出地址与 sha256，缺一不可，便于缓存校验。
// 哈希限定 64 位小写十六进制，格式不符直接判失败。
//
export const marketingAssetSchema = z.object({
  src: url,
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
});
const text = z.object({
  format: z.enum(["plaintext", "html", "markdown"]),
  content: z.string().max(20_000),
});
// 导航按 page 判别，各分支 strict，未知字段会被拒绝而不是静默忽略。
// 设置页的供应商参数只在 section 为模型页时合法，其余组合判失败。
// 插件市场可选插件标识，格式要求名称与来源两段。
//
export const marketingNavigationSchema = z.discriminatedUnion("page", [
  z.object({ page: z.literal("upgrade") }).strict(),
  z.object({ page: z.literal("rewards") }).strict(),
  z
    .object({
      page: z.literal("settings"),
      section: z
        .enum([
          "general",
          "appearance",
          "models",
          "browser",
          "computer_use",
          "memory",
          "subagents",
          "plugins",
          "mcp",
          "skills",
          "commands",
          "hooks",
          "usage",
        ])
        .optional(),
      provider_id: id.optional(),
    })
    .strict()
    .refine((args) => args.provider_id === undefined || args.section === "models"),
  z
    .object({
      page: z.literal("plugin_marketplace"),
      plugin_id: id.regex(/^[^@\s]+@[^@\s]+$/u).optional(),
    })
    .strict(),
]);
// 动作按 type 判别：关闭、打开链接、领取计划、页面跳转、复制文本。
// 复制文本先 trim 再判非空，纯空白内容不合法。
//
export const marketingActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("close") }),
  z.object({ type: z.literal("open_url"), args: z.object({ url }) }),
  z.object({ type: z.literal("claim_zcode_plan"), args: z.object({ plan_id: id }) }),
  z.object({ type: z.literal("navigate"), args: marketingNavigationSchema }),
  z.object({
    type: z.literal("copy_text"),
    args: z
      .object({
        text: z
          .string()
          .max(20_000)
          .refine((value) => value.trim().length > 0),
      })
      .strict(),
  }),
]);
const button = z.object({
  text,
  action: marketingActionSchema,
  theme: cloudButtonThemeSchema.nullish(),
});
// Banner 允许空格式；若复用弹窗约束会丢弃有效投放，仅在此按纯文本归一。
const bannerButton = button.omit({ theme: true }).extend({
  text: text.extend({
    format: z
      .enum(["", "plaintext", "html", "markdown"])
      .transform((value) => value || "plaintext"),
  }),
});
const layout = z.enum(["", "v1"]).optional();
const visualArgs = z
  .record(z.string(), z.unknown())
  .refine((value) => JSON.stringify(value).length <= 64_000)
  .optional();
const image = z.object({
  type: z.literal("image"),
  image: z.object({ default: marketingAssetSchema, dark: marketingAssetSchema.nullish() }),
  args: visualArgs,
});
// 视觉资源三选一：图片、视频、打包资源，按 type 判别。
// discriminatedUnion 的 image 与 video 分支都要求 default 素材，dark 与 fallback 可选。
// 打包入口做路径校验，拒绝反斜杠、空段与上下级跳转。
//
export const marketingVisualSchema = z.discriminatedUnion("type", [
  image,
  z.object({
    type: z.literal("video"),
    video: z.object({ src: marketingAssetSchema, fallback: marketingAssetSchema }),
    args: visualArgs,
  }),
  z.object({
    type: z.literal("bundle"),
    bundle: z.object({
      bundle: marketingAssetSchema,
      entry: z
        .string()
        .min(1)
        .max(240)
        .refine(
          (value) =>
            !value.includes("\\") &&
            value.split("/").every((part) => part && part !== "." && part !== ".."),
        ),
      fallback: marketingAssetSchema.nullish(),
    }),
    args: visualArgs,
  }),
]);
// marketingPopupSchema 固定为 title + description + 可选 visual + 最多四个 buttons，不额外扩展字段。
// 布局只允许空串或 v1，未知值在解析期即被拒绝。
// 按钮数组允许为空，此时弹窗只承担说明作用。
//
export const marketingPopupSchema = z.object({
  layout,
  title: text,
  description: text,
  hero: marketingVisualSchema.nullish(),
  buttons: z.array(button).max(4),
});
const banner = z
  .object({
    layout,
    background: marketingVisualSchema,
    buttons: z.array(bannerButton).max(2),
    success_popup: marketingPopupSchema.nullish(),
  })
  .refine(
    (value) =>
      value.buttons.filter((b) => b.action.type === "close").length <= 1 &&
      value.buttons.filter((b) => b.action.type !== "close").length <= 1,
  );
const deliveryBase = { campaign_id: id, priority: z.number().int().min(0).max(100) };
// 服务端已将旧 card 改名为 banner；判别值与内容字段必须同步，否则有效投放会被丢弃。
// 投放按 resource_position 判别，分横幅与弹窗两种资源位。
// 判别值与内容字段必须同步，否则有效投放会被整条丢弃。
// 公共的投放标识与优先级在两种资源位间共享。
//
export const marketingDeliverySchema = z.discriminatedUnion("resource_position", [
  z.object({ ...deliveryBase, resource_position: z.literal("banner"), banner }),
  z.object({ ...deliveryBase, resource_position: z.literal("popup"), popup: marketingPopupSchema }),
]);
const envelope = z.object({
  code: z.literal(0),
  data: z.object({
    server_time: z.number().finite(),
    language: z.enum(["zh-CN", "en-US"]),
    deliveries: z.array(z.unknown()).max(32),
  }),
});

export type MarketingAsset = z.infer<typeof marketingAssetSchema>;
export type MarketingAction = z.infer<typeof marketingActionSchema>;
export type MarketingPopup = z.infer<typeof marketingPopupSchema>;
export type MarketingVisual = z.infer<typeof marketingVisualSchema>;
export type MarketingDelivery = z.infer<typeof marketingDeliverySchema>;
export type MarketingBannerDelivery = Extract<MarketingDelivery, { resource_position: "banner" }>;
export type MarketingPopupDelivery = Extract<MarketingDelivery, { resource_position: "popup" }>;
export type MarketingTouchSnapshot = ReturnType<typeof parseMarketingTouchResponse>;

/** 单条坏投放不影响其他资源位；外层失败不能伪装成成功空结果。 */
// 外层信封解析失败直接抛出，不能伪装成成功空结果。
// 单条投放用 safeParse，坏数据只计入拒绝数并跳过。
// 同一资源位只接受首条，重复投放被计为拒绝。
// 服务端时间从秒换算为毫秒，语言与投放列表原样返回。
//
export function parseMarketingTouchResponse(input: unknown) {
  const { data } = envelope.parse(input);
  const deliveries: MarketingDelivery[] = [];
  let rejectedCount = 0;
  const positions = new Set<string>();
  for (const raw of data.deliveries) {
    const result = marketingDeliverySchema.safeParse(raw);
    if (!result.success || positions.has(result.data.resource_position)) {
      rejectedCount++;
      continue;
    }
    positions.add(result.data.resource_position);
    deliveries.push(result.data);
  }
  return {
    serverTime: data.server_time * 1000,
    language: data.language,
    deliveries,
    rejectedCount,
  };
}
