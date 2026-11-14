// Workspace 文件索引的默认过滤器：决定哪些文件进入候选列表、哪些目录继续遍历。
// 内置黑名单只是没有 .zcodeignore 时的兜底；索引层只依赖最终决策，不感知规则来源。
// 修改名单时注意大小写不敏感的文件系统：所有名称比较前都会转小写。
import { extname } from "node:path";

// 依赖目录与版本库元数据目录：内容量大且几乎不会被用户按名称搜索，
// 默认整棵剪枝；仅在 ignore 规则不可用时生效。
const SKIPPED_DIRECTORY_NAMES = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "bower_components",
  "jspm_packages",
  "__pycache__",
  "site-packages",
  "venv",
  "coverage",
  "htmlcov",
  "lcov-report",
  "cmakefiles",
  "pods",
  "deriveddata",
  "storybook-static",
  "playwright-report",
  "test-results",
  "allure-results",
  "allure-report",
  "cdk.out",
  "eggs",
  "pip-wheel-metadata",
  "wheels",
]);
// 构建产物目录带可变前后缀（如 cmake-build-debug），用前缀匹配覆盖同族命名。
const SKIPPED_DIRECTORY_PREFIXES = ["cmake-build-", "bazel-"];
// Python 打包产物目录以固定后缀结尾，按后缀识别可避免逐个枚举包名。
const SKIPPED_DIRECTORY_SUFFIXES = [".egg-info", ".dist-info"];
// 覆盖率报告单文件：噪声大且不是用户要打开的目标，按文件名整体排除。
const SKIPPED_FILE_NAMES = new Set(["coverage.out", "lcov.info"]);
// 预编译产物与调试符号：无法作为文本被索引，二进制内容只会浪费扫描与内存，
// 按扩展名统一排除；新增语言工具链时在此补充后缀。
const SKIPPED_FILE_EXTENSIONS = new Set([
  ".a",
  ".aar",
  ".beam",
  ".class",
  ".dll",
  ".dylib",
  ".ear",
  ".exe",
  ".gcda",
  ".gcno",
  ".gem",
  ".hi",
  ".idb",
  ".ilk",
  ".jar",
  ".lib",
  ".node",
  ".nupkg",
  ".o",
  ".obj",
  ".pdb",
  ".profdata",
  ".profraw",
  ".pyc",
  ".pyo",
  ".rlib",
  ".so",
  ".tsbuildinfo",
  ".war",
]);

// 索引器传给过滤器的单条条目：name 用于规则匹配，relativePath 用于隐藏目录判断，
// type 决定是否需要继续向下遍历。
export interface WorkspaceFileSearchEntry {
  name: string;
  path: string;
  relativePath: string;
  type: "file" | "directory";
}

// 两个决策位相互独立：include 控制是否进入结果列表，traverse 控制是否继续扫描子目录。
// 分开表达才能支持「目录本身不展示、但内部文件仍可被搜索」这种剪枝策略。
export interface WorkspaceFileSearchDecision {
  include: boolean;
  traverse: boolean;
}

export interface WorkspaceFileSearchFilterContext {
  /**
   * `.zcodeignore` 规则加载成功时为 true：目录排除的单一真相源是规则文件，
   * 内置目录黑名单退役（用户从文件里删掉 node_modules/ 就应恢复搜索），
   * 仅文件级规则（.env/二进制后缀）与隐藏目录语义继续叠加。
   * fail-open（规则文件完全不可用）时为 false/缺省，黑名单照旧兜底。
   */
  ignoreRulesActive: boolean;
}

/**
 * Workspace 文件索引只依赖这个最终过滤器，不关心规则来自内置列表、配置文件还是设置页面。
 * 后续自定义规则应注入另一份完整实现来替换默认实现，而不是与默认黑名单强制求并集。
 */
// 过滤器契约保持最小：只暴露 evaluate，使默认实现可以被自定义规则实现整体替换。
export interface WorkspaceFileSearchFilter {
  evaluate(
    entry: WorkspaceFileSearchEntry,
    context?: WorkspaceFileSearchFilterContext,
  ): WorkspaceFileSearchDecision;
}

// 目录判断按「精确名 / 前缀 / 后缀」三段匹配，命中任意一段即剪枝。
function shouldSkipDirectory(name: string): boolean {
  const normalizedName = name.toLowerCase();
  return (
    SKIPPED_DIRECTORY_NAMES.has(normalizedName) ||
    SKIPPED_DIRECTORY_PREFIXES.some((prefix) => normalizedName.startsWith(prefix)) ||
    SKIPPED_DIRECTORY_SUFFIXES.some((suffix) => normalizedName.endsWith(suffix))
  );
}

// 文件规则优先级：.env 系列无论扩展名都排除，其余按固定文件名与二进制后缀判断。
function shouldSkipFile(name: string): boolean {
  const normalizedName = name.toLowerCase();
  return (
    normalizedName === ".env" ||
    normalizedName.startsWith(".env.") ||
    SKIPPED_FILE_NAMES.has(normalizedName) ||
    SKIPPED_FILE_EXTENSIONS.has(extname(normalizedName))
  );
}

// 只检查父级路径段：条目自身是否隐藏由调用方另行判断，避免重复计算。
function isInsideHiddenDirectory(relativePath: string): boolean {
  const segments = relativePath.split("/");
  const directorySegments = segments.slice(0, -1);
  return directorySegments.some((segment) => segment.startsWith("."));
}

// 默认过滤器是纯函数式实现：不持有状态，便于在索引遍历中高频调用。
// 目录与文件走不同分支，因为只有目录需要 traverse 决策。
export const defaultWorkspaceFileSearchFilter: WorkspaceFileSearchFilter = {
// entry 由索引器产出，context 可缺省：缺省表示规则文件未生效，按内置黑名单处理。
  evaluate(entry, context) {
// 目录先判黑名单再判隐藏：黑名单命中时连遍历都停止，避免进入 node_modules 这类大目录。
    if (entry.type === "directory") {
      // ignoreRulesActive 时目录黑名单退役：目录排除的唯一来源是 .zcodeignore 规则文件。
      if (!context?.ignoreRulesActive && shouldSkipDirectory(entry.name)) {
        return { include: false, traverse: false };
      }
      // 遇到任意隐藏目录就整棵剪枝会让 .github 等目录里的有效文件无法通过名称搜索。
      // 隐藏目录及其下级目录不占候选列表，但保留遍历，让其中的普通文件进入索引。
      const hiddenDirectory =
        entry.name.startsWith(".") || isInsideHiddenDirectory(entry.relativePath);
      return { include: !hiddenDirectory, traverse: true };
    }

// 文件永远不遍历；是否展示只取决于文件名级规则。
    return { include: !shouldSkipFile(entry.name), traverse: false };
  },
};
