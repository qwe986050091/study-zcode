// INV-01 按钮主题缺省为 default：守住位置 transform；改错故障 主题为空字符串。
// INV-02 仅允许 http 与 https：守住位置 协议正则；改错故障 file 协议被放行。
// INV-03 URL 禁止内嵌凭据：守住位置 username 与 password 判断；改错故障 凭据随链接下发。
// INV-04 包体格式固定 zip：守住位置 literal；改错故障 未知格式进入解压。
// INV-05 摘要必须是 64 位十六进制：守住位置 正则；改错故障 校验形同虚设。
// INV-06 包体大小上限 8MB：守住位置 max；改错故障 大文件拖垮预检。
// INV-07 hero 四型封闭：守住位置 判别联合；改错故障 未知类型落到默认分支。
// INV-08 视频必须静音：守住位置 literal true；改错故障 自动播放带声音。
// INV-09 动效速度限制在 0.1~4：守住位置 min 与 max；改错故障 极端速度导致不可用。
// INV-10 沙箱退化为图片：守住位置 fallback；改错故障 加载失败留下空白。
// INV-11 交互数据上限 64000 字节：守住位置 序列化长度；改错故障 超大数据进入消息通道。
// INV-12 事件表最多 16 项：守住位置 键数判断；改错故障 事件数量失控。
// INV-13 动作六型封闭：守住位置 判别联合；改错故障 未知动作被忽略。
// INV-14 外链动作复用安全 URL：守住位置 url 常量；改错故障 绕过协议校验。
// INV-15 按钮最多四个：守住位置 max；改错故障 弹窗布局溢出。
// INV-16 按钮 id 必须唯一：守住位置 superRefine；改错故障 点击命中错误动作。
// INV-17 按钮必须指向存在动作：守住位置 hasOwn；改错故障 点击后毫无响应。
// INV-18 载荷字段全量声明：守住位置 顶层对象；改错故障 新字段被静默丢弃。
//
// 模块职责：定义云端内容弹窗的运行时校验 schema 与推导类型。
// 状态所有权：纯 schema 声明，不持有任何运行状态。
// 阅读顺序：先看按钮主题，再看各类联合，最后看顶层载荷与交叉校验。
import { z } from "zod";

// 主题缺省回落 default。
// class 与 style 各自限长 512。
// 未知主题直接拒绝。
export const cloudButtonThemeSchema = z.object({
  variant: z
    .enum(["", "default", "outline", "secondary", "ghost", "destructive", "warning", "link"])
    .optional()
    .transform((value) => value || "default"),
  class: z.string().max(512).optional(),
  style: z.string().max(512).optional(),
});

// 仅允许 http 与 https。
// url 禁止内嵌 username 与 password。
// 长度上限 4096。
// 解析失败即拒绝。
const url = z
  .string()
  .max(4096)
  .url()
  .refine(
    (value) =>
      URL.canParse(value) &&
      /^https?:\/\//iu.test(value) &&
      !new URL(value).username &&
      !new URL(value).password,
  );
const id = z.string().min(1).max(128);
const image = z.object({
  type: z.literal("image"),
  src: url,
  darkSrc: url.optional(),
  alt: z.string().max(500),
  fit: z.enum(["cover", "contain"]).optional(),
});
// 格式固定为 zip。
// 摘要要求 64 位小写十六进制。
// 大小必须为正整数。
// 大小上限 8MB。
export const contentBundleSchema = z.object({
  format: z.literal("zip"),
  url,
  entry: z.string().min(1).max(240),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  sizeBytes: z
    .number()
    .int()
    .positive()
    .max(8 * 1024 * 1024)
    .optional(),
});
export type CloudContentBundle = z.infer<typeof contentBundleSchema>;
const hero = z.discriminatedUnion("type", [
  image,
  z.object({
    type: z.literal("video"),
    src: url,
    darkSrc: url.optional(),
    poster: url,
    autoplay: z.boolean().optional(),
    loop: z.boolean().optional(),
    muted: z.literal(true),
    fit: z.enum(["cover", "contain"]).optional(),
  }),
  z.object({
    type: z.literal("lottie"),
    src: url,
    darkSrc: url.optional(),
    autoplay: z.boolean().optional(),
    loop: z.boolean().optional(),
    speed: z.number().min(0.1).max(4).optional(),
    fallback: image.optional(),
  }),
  z.object({
    type: z.literal("interactive_bundle"),
    runtime: z.literal("zcode-hero-sandbox-v1"),
    bundle: contentBundleSchema,
    viewport: z.object({ aspectRatio: z.literal("4:3") }),
    data: z
      .record(z.string(), z.unknown())
      .refine((value) => JSON.stringify(value).length <= 64000),
    events: z.record(id, id).refine((value) => Object.keys(value).length <= 16),
    fallback: image.optional(),
  }),
]);
const action = z.discriminatedUnion("type", [
  z.object({ type: z.literal("close") }),
  z.object({ type: z.literal("dismiss_content") }),
  z.object({
    type: z.literal("navigate"),
    destination: z.enum(["model_settings", "plugin_store", "settings"]),
  }),
  z.object({ type: z.literal("copy_text"), text: z.string().max(20000) }),
  z.object({ type: z.literal("open_external"), url }),
  z.object({ type: z.literal("claim_plan"), planId: id }),
]);
// cloudContentPayloadSchema 顶层字段全量声明。
// dialog.buttons 最多四个。
// actions 表最多十六项。
export const cloudContentPayloadSchema = z
  .object({
    schemaVersion: z.literal(1),
    id,
    revision: z.number().int().positive(),
    kind: z.enum(["campaign", "feature", "notice"]),
    locale: z.enum(["zh-CN", "en-US"]),
    dialog: z.object({
      title: z.string().min(1).max(500),
      description: z.object({
        format: z.enum(["plain_text", "html", "markdown"]),
        text: z.string().max(20000),
      }),
      hero,
      buttons: z
        .array(
          z.object({
            id,
            label: z.string().min(1).max(200),
            variant: z.enum(["primary", "secondary", "link"]),
            theme: cloudButtonThemeSchema.nullish(),
            actionId: id,
          }),
        )
        .max(4),
    }),
    actions: z.record(id, action).refine((value) => Object.keys(value).length <= 16),
  })
  // button.id 必须唯一。
  // button.actionId 必须指向已声明动作。
  // 违规逐条 addIssue 记录问题。
  .superRefine((payload, context) => {
    const ids = new Set<string>();
    for (const button of payload.dialog.buttons) {
      if (ids.has(button.id) || !Object.hasOwn(payload.actions, button.actionId))
        context.addIssue({ code: "custom", message: "Duplicate button or missing action" });
      ids.add(button.id);
    }
  });
export type CloudContentPayload = z.infer<typeof cloudContentPayloadSchema>;
export type CloudContentHeroType = CloudContentPayload["dialog"]["hero"]["type"];
