// 当前构建对应的插件身份：name 决定 MCP 服务名与 ui:// 资源前缀，title 决定面板与文案品牌，
// kinds 决定开放格式。构建脚本 scripts/build.mjs 会整体替换本模块，因此运行时只读。
// 边界：本文件不得引入其他 office 模块（只依赖 kinds.ts），否则会破坏 contract → profile 的单向依赖。
import type { DocKind } from "#office/kinds.ts";

/**
 * Which plugin this build is. Each plugin package declares its title and formats under
 * `office` in its package.json; scripts/build.mjs replaces this module with those values.
 * The default here opens every format; tests and the type checker use it. No plugin ships it.
 */
// Profile 描述当前构建对应哪个插件：字段全部由构建脚本从 package.json 的 office 段整段替换注入，
// 因此运行时只读，不得依赖具体值做分支以外的持久化或缓存决策。
export interface Profile {
  /** Plugin, MCP server and panel surface name, e.g. `documents` or `pdf`. */
  name: string;
  /** 版本号，写入 MCP server 的 version，仅用于展示与诊断，不参与兼容性或缓存判断。 */
  version: string;
  /** 面板与工具文案使用的双语标题；缺少 zh-CN 时上层回落到 en，不会抛错。 */
  title: { en: string; "zh-CN": string };
  /** Formats this plugin opens, in display order. */
  kinds: readonly DocKind[];
}

// 默认 profile：开放全部四种格式，仅供测试与类型检查使用，正式插件构建会整体替换本模块。
// 不变量：kinds 必须非空且元素来自 ALL_KINDS；name 需与 package.json 的插件名一致，否则资源 URI 前缀会与宿主路由错位。
export const PROFILE: Profile = {
  name: "office",
  version: "0.0.0",
  title: { en: "Office", "zh-CN": "Office 文档" },
  kinds: ["docx", "xlsx", "pptx", "pdf"],
};
