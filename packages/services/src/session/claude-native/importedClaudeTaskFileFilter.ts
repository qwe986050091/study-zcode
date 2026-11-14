// 导入清洗：按点分路径删除不应落库的字段（模型/供应商等运行时选择），只保留可迁移内容；否则会把本机运行时配置带到目标机。
// 过滤是纯函数：先深拷贝再删除，绝不修改调用方传入的对象。
const ARRAY_WILDCARD_SUFFIX = "[]";

// 默认清洗路径：meta 下的模型/供应商选择，以及消息级的 model 字段。
// 这些字段属于本机运行时配置，导入到目标机器后必须由新环境重新选择。
export const DEFAULT_IMPORTED_CLAUDE_TASK_FILTER_PATHS = [
  "meta.mode",
  "meta.model",
  "meta.provider",
  "messages[].model",
] as const;

type MutableJsonObject = Record<string, unknown>;

// 只有普通对象才允许继续下钻或删除字段；数组必须走通配分支。
function isMutableJsonObject(value: unknown): value is MutableJsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// 递归删除：任一层缺失都静默返回，导入文件结构与预期不同不应导致整个导入失败。
// segments 是路径分段，空数组表示已经到达目标节点，由调用方决定是否删除。
function deletePath(value: unknown, segments: readonly string[]): void {
// 没有剩余分段说明没有可删字段，此时直接返回可避免误删整个对象。
  if (segments.length === 0) {
    return;
  }

  // 首段决定当前层语义，rest 继续下钻；空段来自非法路径，直接返回而不是猜测应该删哪个字段。
  const [segment, ...rest] = segments;
  if (!segment) {
    return;
  }

// segment 以 "[]" 结尾表示对数组每个元素递归应用剩余路径。
  if (segment.endsWith(ARRAY_WILDCARD_SUFFIX)) {
    // 去掉 "[]" 后才是真实字段名；value 非对象或该字段不是数组时静默返回，容忍异构的历史导入文件。
    const key = segment.slice(0, -ARRAY_WILDCARD_SUFFIX.length);
    if (!isMutableJsonObject(value) || !Array.isArray(value[key])) {
      return;
    }

// 逐个元素处理：单个元素结构不符时直接跳过，不返回错误，其余记录继续清洗。
    for (const item of value[key]) {
      deletePath(item, rest);
    }
    return;
  }

// 非对象无法承载字段，直接终止下钻。
  // 标量无法承载字段，说明路径与数据形状不匹配；这里只终止这条路径的下钻，同层其他路径仍由调用方继续清洗。
  if (!isMutableJsonObject(value)) {
    return;
  }

  // 只有最后一段才真正删除，中间层仅透传引用，保证不会误删整棵子树。
  if (rest.length === 0) {
    delete value[segment];
    return;
  }

  deletePath(value[segment], rest);
}

// 对外入口：结构化深拷贝后按路径删除，返回同类型的新对象。
// 使用 structuredClone 而不是 JSON 往返，保留 undefined/Date 等结构语义。
export function filterImportedClaudeTaskFilePaths<T>(input: T, filterPaths: readonly string[]): T {
// 克隆失败会让异常向上抛出；调用方需保证输入是可结构化克隆的纯数据。
  const cloned = structuredClone(input) as T;
  // 过滤路径由调用方给出（默认常量或自定义白名单）；传入空数组等价于只做一次深拷贝。
  for (const path of filterPaths) {
    deletePath(cloned, path.split("."));
  }
  return cloned;
}
