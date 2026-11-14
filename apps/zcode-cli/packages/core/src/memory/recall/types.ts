// ============================================================
// memory/recall/types —— Semantic Recall 的共享类型与分类枚举
// ============================================================
//
// 【定位】recall 子模块的类型契约：manifest 条目、选择器输出、召回结果、
//   会话状态。manifest/selector/content/index 都依赖这里，避免循环引用。
//
// 【纯类型文件】不产生运行时代码，只有 MEMORY_RECALL_TYPES 常量会进入 bundle；
//   该常量同时作为 frontmatter type 的合法值集合（解析时用它校验）。
//
// 【口径】filename 是相对 memoryRoot 的 POSIX 路径（不是 basename），
//   选择器返回的也是同一口径，二者靠字符串精确匹配。mtimeMs 来自 stat，
//   不是 frontmatter 里的日期。
// ============================================================
import type { ModelInputMessage } from "@zcode/contracts";

// 允许出现在 manifest 中的记忆分类；解析 frontmatter 时用 includes 校验。
export const MEMORY_RECALL_TYPES = ["user", "feedback", "project", "reference"] as const;

export type MemoryRecallType = (typeof MEMORY_RECALL_TYPES)[number];

/**
 * 扫描 memoryRoot 得到的一条记忆索引项（只含选择器需要的元数据）。
 * description：取自 frontmatter 的 description，用于让选择器判断相关性。
 * filePath：绝对路径，读正文与生成 header 用。
 * filename：相对 memoryRoot 的 POSIX 路径，是选择器返回值的匹配键。
 * mtimeMs：stat 的修改时间，用于过期提醒；读取失败回退 0。
 * type：frontmatter 中校验过的分类，非法或缺省时 undefined。
 */
export interface MemoryManifestEntry {
  description?: string;
  filePath: string;
  filename: string;
  mtimeMs: number;
  type?: MemoryRecallType;
}

/**
 * 选择器模型的输出（严格 JSON 解析后的形状）。
 * selectedKnowledgeIds 是模型按 schema 必须给的空数组占位，实际不参与召回；
 * selectedMemories 是 manifest 的 filename 列表，未知项会在过滤阶段被丢弃。
 */
export interface MemorySelectorResult {
  selectedKnowledgeIds: string[];
  selectedMemories: string[];
}

/**
 * 一篇已读取正文的召回记忆。
 * content：截断/归一化后的正文（含截断提示），也是配额计数的单位。
 * header：路径 + 过期警告的注入头。
 * limit：仅当发生截断时存在，表示保留的行数。
 * revisionId：文件系统返回的版本 id，用于 readFileState 冲突检测。
 * sizeBytes：读取时文件总字节数（截断前），不是注入正文的大小。
 */
export interface RecalledMemory {
  content: string;
  filePath: string;
  header: string;
  limit?: number;
  mtimeMs: number;
  revisionId?: string;
  sizeBytes: number;
}

/**
 * 单会话召回状态（由 createMemoryRecallState 创建，随会话存活）。
 * manifest：首次扫描后缓存；空数组会被视为无效并重新扫描。
 * recalledContentCharacters：累计注入字符数，用于配额门禁。
 * recalledPaths：已召回文件的绝对路径，避免重复召回同一篇。
 * selectorMessages：选择器的粘性对话，下一轮查询复用，保证选择口径连续。
 */
export interface MemoryRecallState {
  manifest?: MemoryManifestEntry[];
  recalledContentCharacters: number;
  recalledPaths: Set<string>;
  selectorMessages?: ModelInputMessage[];
}
