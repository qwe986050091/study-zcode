/**
 * Every format the runtime knows; a plugin opens the subset in its profile.
 * 单独成文件：profile.ts 与 contract.ts 都要用到格式列表，放在 contract.ts 会形成循环依赖。
 * 这里是格式列表的唯一真源，DocKind 由该数组推导；数组顺序即展示顺序（Word、Excel、PowerPoint、PDF）。
 */
// as const 保证 DocKind 推导为字面量联合而非 string；本文件不得引入任何运行时代码，否则会破坏上面的循环依赖边界。
export const ALL_KINDS = ["docx", "xlsx", "pptx", "pdf"] as const;
// 由唯一格式数组推导的字面量联合，新增格式只需改上面的数组；不要手写字符串联合以免走样。
export type DocKind = (typeof ALL_KINDS)[number];
