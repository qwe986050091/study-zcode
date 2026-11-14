// Gen-UI 协议契约: 产物路径, 作用域, 状态载荷, tweak 控件与模型上下文注入的唯一形状来源
// INV-01 所有对外形状都由 zod schema 定义, 类型一律从 schema 推导；守住位置: 各 genUi*Schema 与其 type 别名；改错故障: 类型与运行时校验漂移, 编译通过而运行拒绝合法载荷。
// INV-02 每个对象 schema 都以 strict 收尾, 未知字段直接拒绝；守住位置: genUiReferenceSchema, genUiScopeSchema 与 tweak 系列；改错故障: 旧版多带的字段被接受, 两端对同一对象的理解分叉。
// INV-03 路径只做线上格式校验, 归一化与文件系统授权归执行器；守住位置: genUiPathSchema 的 refine 分支；改错故障: 执行器误以为路径已可信, 越界写入落到工作区之外。
// INV-04 路径拒绝 NUL 与换行, 且任一段都不得是 ..；守住位置: refine 里的 includes 与 segments 判断；改错故障: 换行注入拆坏协议帧, 或路径向上逃逸。
// INV-05 末段必须是小写连字符命名的 html 文件, 整串以绝对路径开头；守住位置: refine 的绝对前缀正则与末段正则；改错故障: 大写或非 html 产物被放行, 查看器找不到对应文件。
// INV-06 reference 的 mode 目前只认 wide, 用枚举而不是自由字符串；守住位置: genUiReferenceSchema 的 mode 字段；改错故障: 新增展示模式时漏改枚举, 布局静默回退到默认。
// INV-07 作用域身份优先取 workspaceIdentity, 仅在其缺失时回落到 workspacePath；守住位置: buildGenUiScopeKey 的表达式；改错故障: 同一路径的本地与远程工作区共用状态。
// INV-08 作用域键与状态键都是 JSON 数组序列化, 不做手写字符串拼接；守住位置: buildGenUiScopeKey 与 buildGenUiStateKey；改错故障: 分隔符歧义让两个目标撞键, 状态互相覆盖。
// INV-09 控件 id 必须字母开头, 长度 1 到 64, 且同一次 tweak 内唯一；守住位置: controlBase 的 id 正则与 superRefine 的 ids 集合；改错故障: 同名控件共享取值, 拖动一个另一个跟着跳。
// INV-10 控件类型以 type 作为判别字段, 四种分支各自 strict；守住位置: genUiTweakControlSchema 的 discriminatedUnion；改错故障: 判别字段改名后联合退化, 非法字段组合被接受。
// INV-11 slider 要求 min 小于 max 且 value 落在闭区间内；守住位置: superRefine 的 slider 分支；改错故障: 越界初值被界面夹紧, 用户看到的数值与模型意图不符。
// INV-12 select 的 value 必须命中某个 option 的取值；守住位置: superRefine 的 select 分支；改错故障: 选中值不在选项内, 下拉框显示空白。
// INV-13 状态载荷只允许 JSON 可表达的值, 非有限数字同样判非法；守住位置: serializeJson 的 replacer 判断；改错故障: 函数或 undefined 被静默吞掉, 恢复后状态缺字段。
// INV-14 状态体积按 UTF-8 字节计, 上限 16 KiB；守住位置: 变换中 TextEncoder 的字节长度分支；改错故障: 大状态穿透到协议层, 消息帧膨胀拖慢整轮会话。
// INV-15 序列化失败转成 zod issue, 不让异常穿透；守住位置: transform 的 catch 与 NEVER 哨兵；改错故障: 单条非法状态打断整批校验, 其他合法条目一并丢失。
// INV-16 两侧状态默认 null, 表示该侧没有可注入内容；守住位置: modelContent 与 privateContent 的 default；改错故障: 缺省被当作空对象注入, 模型收到无意义片段。
// INV-17 模型上下文条目按路径排序, 截断到 100 条并按 64 KiB 预算逐条追加；守住位置: buildGenUiModelContext 的 sort, slice 与长度判断；改错故障: 上下文超出预算被上游截断, 注入块结构破损。
// INV-18 注入块用不可信标签包裹, 剥离时先校验载荷再切掉尾部；守住位置: buildGenUiModelContext 的模板串与 stripGenUiModelContext；改错故障: 用户伪造标签注入提示, 或剥离失败把标签留在正文。
// 契约文件只描述线上形状, 不做 IO 也不持有状态, 执行器与界面各自消费同一份 schema。
// 改字段前先确认是哪条不变量在挡: 放松校验比新增字段更容易造成静默故障。
// 排错顺序是上限常量, 路径与作用域键, 状态序列化, 最后才是 tweak 控件约束。
//
import { z } from "zod";
// tweak 协议的形状定义在 tweakProtocol 里, 本文件只做再导出, 不重复声明同名结构
// 改动 tweak 字段时只改源头, 在此另写一份会让两侧 schema 悄悄分叉
export * from "./tweakProtocol.js";

// [资源] 这几个上限常量是协议预算的唯一出口: 产物 5 MB, 状态 16 KiB, 上下文 64 KiB, 条目 100
// 调用点读常量而不是另写数字, 两边漂移会出现一边放行一边拒绝, 用户看到白屏或状态被静默丢弃
export const GEN_UI_HTML_MAX_BYTES = 5_000_000;
export const GEN_UI_STATE_MAX_BYTES = 16 * 1024;
export const GEN_UI_STATE_MAX_ENTRIES = 100;
export const GEN_UI_CONTEXT_MAX_BYTES = 64 * 1024;
// 事件名与三个上下文键是宿主和产物页面之间的私有约定, 一律带 zcode 前缀
// 事件用冒号分隔, 上下文键用斜杠分隔, 这不是笔误, 不要统一格式
// 改动任一字符串等于改协议: 旧产物页面收不到 globals, 交互整体失效
export const GEN_UI_GLOBALS_EVENT = "zcode:set_globals";
export const GEN_UI_STATE_CONTEXT_KEY = "zcode/genUiState";
export const GEN_UI_TWEAK_CONTEXT_KEY = "zcode/genUiTweaks";
export const GEN_UI_STYLE_CONTEXT_KEY = "zcode/genUiStyles";
export const genUiStyleVariablesSchema = z.record(
  // 样式变量只允许 --gen-ui- 前缀的小写连字符名, 防止产物写入任意 CSS 变量
  // 放宽前缀会让产物覆盖宿主主题变量, 造成全局样式污染
  z.string().regex(/^--gen-ui-[a-z-]+$/),
  z.string(),
);
// 四个方法名是产物页面调用宿主的通道名, 桥接层与页面运行时都按字面量匹配
// 改名必须两侧同步, 单边改名后调用落到未知方法, 追问与 tweak 静默失效
export const GEN_UI_STATE_METHOD = "zcode/gen-ui/state";
export const GEN_UI_FOLLOW_UP_METHOD = "zcode/gen-ui/follow-up";
export const GEN_UI_TWEAK_METHOD = "zcode/gen-ui/tweak";
export const GEN_UI_PRESENTATION_METHOD = "zcode/gen-ui/presentation";
// [资源] 静态白名单是只读常量数组, 用 as const 收窄, 顺序不承载优先级
// 新增域名等于扩大产物页面的外联面, 评审时要确认来源可信
// 删域名会让存量产物加载不到依赖, 表现为页面空白或字体回退
export const GEN_UI_STATIC_DOMAINS = [
  "cdnjs.cloudflare.com",
  "esm.sh",
  "cdn.jsdelivr.net",
  "unpkg.com",
  "fonts.googleapis.com",
  "fonts.gstatic.com",
  "fonts.bunny.net",
] as const;

/** This is a wire-format check. The executor owns normalization and filesystem authorization. */
export const genUiPathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((path) => {
    if (path.includes("\0") || /[\r\n]/u.test(path)) return false;
    const segments = path.split(/[\\/]/u);
    return (
      /^(?:\/|[A-Za-z]:[\\/]|\\\\)/u.test(path) &&
      !segments.includes("..") &&
      /^[a-z0-9]+(?:-[a-z0-9]+)*\.html$/u.test(segments.at(-1) ?? "")
    );
  // 报错文案是开发者可见的最后一道提示, 点明这是执行器路径而不是普通路径
  // 路径形状由执行器归一化与授权, 这里只拒绝明显不合规的字符串
  }, "Expected an absolute executor path to a lowercase-hyphenated HTML file");
export const genUiReferenceSchema = z
  .object({
    path: genUiPathSchema,
    title: z.string().max(250).optional(),
    // 展示模式当前只有 wide 一个取值, 用枚举留出扩展位而不是自由字符串
    // 省略表示默认布局, 新增模式要同时改枚举与前端渲染分支
    mode: z.enum(["wide"]).optional(),
  })
  .strict();
export type GenUiReference = z.infer<typeof genUiReferenceSchema>;

export const genUiScopeSchema = z
  .object({
    workspacePath: z.string().min(1).max(4096),
    // [事务] workspaceIdentity 是可选身份, 缺省时回落到 workspacePath
    // 身份只用于隔离与键构造, 不参与文件操作, 不要拿它拼真实路径
    // 把它当必填会让旧调用方解析失败, 当成纯展示字段又会让远程与本地共用状态
    workspaceIdentity: z.string().max(4096).optional(),
    sessionId: z.string().min(1).max(512),
  })
  .strict();
export type GenUiScope = z.infer<typeof genUiScopeSchema>;
// 状态目标在作用域之上追加产物路径, 复用同一份 scope 校验避免重复定义
// 若在此重写字段, 作用域校验放宽后状态键与事件路由会不同步
export const genUiStateTargetSchema = genUiScopeSchema.extend({ path: genUiPathSchema });
export type GenUiStateTarget = z.infer<typeof genUiStateTargetSchema>;

// [失败路径] 序列化前先用 replacer 过滤非法值, 再回读成纯数据, 保证线上形状固定
// undefined, 函数, 符号, bigint, 非有限数字一律判非法, 不做降级
// 静默丢弃会让组件恢复后状态缺字段, 排查时却看不到任何报错
function serializeJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (
      typeof item === "undefined" ||
      typeof item === "function" ||
      typeof item === "symbol" ||
      typeof item === "bigint" ||
      (typeof item === "number" && !Number.isFinite(item))
    ) {
      // 错误文案会原样作为校验信息回给调用方, 因此要描述规则而不是内部实现
      // 改成吞掉异常会让非法状态进入上下文注入, 模型读到不完整数据
      throw new Error("Widget state must contain JSON values only");
    }
    return item;
  });
}
export const genUiWidgetStateSchema = z
  .object({
    // 模型侧载荷默认 null, 用来区分「没有状态」与「状态为空对象」
    // 缺省值改成空对象会让模型上下文多出无意义的空片段
    modelContent: z.unknown().default(null),
    privateContent: z.unknown().default(null),
  })
  .strict()
  .transform((state, context) => {
    try {
      const serialized = serializeJson(state);
      if (new TextEncoder().encode(serialized).byteLength > GEN_UI_STATE_MAX_BYTES) {
        throw new Error("Widget state exceeds 16 KiB");
      }
      return JSON.parse(serialized) as { modelContent: unknown; privateContent: unknown };
    } catch (error) {
      context.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : "Invalid widget state",
      });
      // 转换失败时返回 NEVER 哨兵并追加 issue, 让整次校验以普通失败收场
      // 改成抛异常会绕过 zod 的错误收集, 同批其他条目的错误一并丢失
      return z.NEVER;
    }
  });
export type GenUiWidgetState = z.infer<typeof genUiWidgetStateSchema>;
export const genUiFollowUpSchema = z
  .object({
    prompt: z
      .string()
      .trim()
      .min(1)
      .max(64 * 1024),
    title: z.string().max(250).optional(),
  })
  .strict();

// 文档条目把执行器路径与完整 html 成对携带, 体积由上限常量约束而不是这里
// 两个字段都必填, 缺 html 的条目会让查看器渲染空壳
export interface GenUiDocument {
  path: string;
  html: string;
}
// 控件公共字段集中在此展开, id, label 与可选 reference 三处复用
// id 限长 64 且必须字母开头, 保证能安全用作 DOM id 与取值表的键
// reference 是关联文档的提示串, 限长 160 并限制字符集, 不参与解析
const controlBase = {
  id: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/),
  label: z.string().min(1).max(120),
  reference: z
    .string()
    .regex(/^[\w./:@$#-]{1,160}$/u)
    .optional(),
};
// [权衡] 判别字段选 type 而不是按字段存在性猜测, 联合才具备穷尽性检查
// 四个分支各自 strict, 分支间不共享多余字段, 滑块不会误收 options
// 判别字段一旦改名, 联合退化为宽松对象, 非法组合会被静默接受
export const genUiTweakControlSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...controlBase,
      type: z.literal("slider"),
      value: z.number().finite(),
      min: z.number().finite(),
      max: z.number().finite(),
      step: z.number().positive().optional(),
      unit: z.string().max(24).optional(),
    })
    .strict(),
  z
    .object({
      ...controlBase,
      type: z.literal("color"),
      value: z.string().regex(/^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i),
    })
    .strict(),
  z.object({ ...controlBase, type: z.literal("toggle"), value: z.boolean() }).strict(),
  z
    .object({
      ...controlBase,
      type: z.literal("select"),
      value: z.string().max(120),
      options: z
        .array(
          z.union([
            z.string().min(1).max(120),
            z.object({ label: z.string().min(1).max(120), value: z.string().max(120) }).strict(),
          ]),
        )
        .min(1)
        .max(12),
    })
    .strict(),
]);
export const genUiTweakSchema = z
  .object({
    title: z.string().min(1).max(120),
    controls: z.array(genUiTweakControlSchema).min(1).max(12),
  })
  .strict()
  // 跨字段约束放在这里: id 唯一, slider 区间, select 取值命中, 逐条累计 issue 而不遇错即停
  // 去掉 ids 去重会让两个控件同名, 用户拖一个另一个跟着变
  .superRefine((input, ctx) => {
    const ids = new Set<string>();
    for (const control of input.controls) {
      if (
        ids.has(control.id) ||
        (control.type === "slider" &&
          (control.min >= control.max ||
            control.value < control.min ||
            control.value > control.max)) ||
        (control.type === "select" &&
          !control.options.some(
            (option) => (typeof option === "string" ? option : option.value) === control.value,
          ))
      )
        ctx.addIssue({ code: "custom", message: "Invalid or duplicate tweak control" });
      ids.add(control.id);
    }
  });
export type GenUiTweak = z.infer<typeof genUiTweakSchema>;
export type GenUiTweakValues = Record<string, string | number | boolean>;
export interface GenUiStateEntry {
  path: string;
  state: GenUiWidgetState;
}
export interface GenUiStateChange {
  target: GenUiStateTarget;
  state: GenUiWidgetState | null;
}
export function buildGenUiScopeKey(scope: GenUiScope): string {
  // [并发] 作用域键是二元数组的 JSON 串, 身份优先路径兜底, 再与会话 id 共同确定唯一域
  // 手写分隔符拼接会产生歧义, 两个不同作用域算出同一个键, 状态互相覆盖
  return JSON.stringify([scope.workspaceIdentity?.trim() || scope.workspacePath, scope.sessionId]);
}
export function buildGenUiStateKey(target: GenUiStateTarget): string {
  return JSON.stringify([buildGenUiScopeKey(target), target.path]);
}
export function buildGenUiModelContext(entries: readonly GenUiStateEntry[]): string {
  const selected: Array<{ path: string; state: unknown }> = [];
  for (const entry of [...entries]
    .sort((a, b) => a.path.localeCompare(b.path))
    .slice(0, GEN_UI_STATE_MAX_ENTRIES)) {
    const parsed = genUiWidgetStateSchema.safeParse(entry.state);
    if (!parsed.success || parsed.data.modelContent === null) continue;
    const next = { path: entry.path, state: parsed.data.modelContent };
    if (
      new TextEncoder().encode(JSON.stringify([...selected, next])).length >
      GEN_UI_CONTEXT_MAX_BYTES
    )
      break;
    selected.push(next);
  }
  return selected.length
    ? `<untrusted_gen_ui_state>\n${JSON.stringify(selected).replaceAll("<", "\\u003c")}\n</untrusted_gen_ui_state>`
    : "";
}
// [失败路径] 只剥掉末尾那段注入块, 未命中就原样返回, 不动正文其他部分
// 剥离前先用 schema 校验载荷形状, 避免把正文里相似的标签误删
// 匹配限定行首双换行与结尾锚点, 放宽会把正文中间的引用块一起吃掉
export function stripGenUiModelContext(content: string): string {
  const match = /\n\n<untrusted_gen_ui_state>\n([^]*?)\n<\/untrusted_gen_ui_state>\s*$/u.exec(
    content,
  );
  if (!match) return content;
  try {
    z.array(z.object({ path: genUiPathSchema, state: z.unknown() }).strict())
      .max(GEN_UI_STATE_MAX_ENTRIES)
      .parse(JSON.parse(match[1]!));
    return content.slice(0, match.index);
  } catch {
    return content;
  }
}
