import { open, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import ignoreFactory from "ignore";
import type { Ignore } from "ignore";
import type { ServiceLogger } from "../logger/serviceLogger.js";

/**
 * workspace 文件搜索忽略的单一真相源。
 *
 * `.zcodeignore`（workspace root，gitignore 语法）是搜索索引的唯一规则文件：
 * 自动创建暂时停用：文件不存在时仅在内存中使用 root `.gitignore` + 默认排除规则；
 * 之后 `.gitignore` 的变化不再影响搜索，用户通过设置页编辑或「从 .gitignore 重新同步」。
 *
 * 规则解析交给 `ignore` npm 包（gitignore spec 2.22 参考实现，ESLint 同款）：
 * 后声明覆盖、`!` 反选（含父目录排除后子文件无法恢复的 git 原生约束）、anchored/basename、
 * `**` 跨层、目录后缀 `/`、字符类与转义。禁止在本仓库手写 gitignore 解析。
 */

export const WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME = ".zcodeignore";
const GITIGNORE_FILE_NAME = ".gitignore";

type WorkspaceFileIgnoreLogger = Pick<ServiceLogger, "info" | "warn">;

export type WorkspaceFileSearchIgnoreRulesSource =
  | "file"
  | "template"
  | "created-from-gitignore"
  | "created-from-template"
  | "fallback-gitignore"
  | "fallback-builtin";

export interface WorkspaceFileSearchIgnoreRules {
  matcher: Ignore;
  source: WorkspaceFileSearchIgnoreRulesSource;
}

export interface WorkspaceFileSearchIgnoreContent {
  content: string;
  /** file：.zcodeignore 已存在；template：尚未创建，content 是保存后将落盘的初始内容预览。 */
  source: "file" | "template";
}

/**
 * 默认模板的内置排除规则：承接旧 defaultWorkspaceFileSearchFilter 目录黑名单的退役部分，
 * 保证"从零创建"的 workspace 行为与旧默认一致（node_modules/.git 等仍被剪枝）。
 * 前缀通配按 gitignore 语法表达（cmake-build-* 等），与旧 SKIPPED_DIRECTORY_PREFIXES 等价。
 */
const BUILTIN_IGNORE_LINES = [
  ".git/",
  ".hg/",
  ".svn/",
  "node_modules/",
  "bower_components/",
  "jspm_packages/",
  "__pycache__/",
  "site-packages/",
  "venv/",
  "coverage/",
  "htmlcov/",
  "lcov-report/",
  "cmakefiles/",
  "cmake-build-*/",
  "bazel-*/",
  "pods/",
  "deriveddata/",
  "storybook-static/",
  "playwright-report/",
  "test-results/",
  "allure-results/",
  "allure-report/",
  "cdk.out/",
  "*.egg-info/",
  "*.dist-info/",
  "eggs/",
  "pip-wheel-metadata/",
  "wheels/",
];

const TEMPLATE_HEADER = [
  "# ZCode 工作区文件搜索忽略规则（.zcodeignore）",
  "# 语法与 .gitignore 一致，只影响 ZCode 的 @ 文件候选 / Command Center / 文件树搜索，",
  "# 不影响文件树浏览、上传或 Agent 文件访问。",
  "# 修改 .gitignore 不会自动同步到本文件；可在设置页「从 .gitignore 同步」。",
  "",
];

/**
 * 分区标记（按行精确匹配，删除标记会让对应按钮退化为整体重建）：
 * 「从 .gitignore 同步」只重写 SYNC 标记之上的内容；
 * 「恢复默认规则」只重写两个标记之间的默认排除段；
 * DEFAULTS 标记之下的自定义规则区，任何按钮都不会改动。
 */
export const WORKSPACE_FILE_SEARCH_IGNORE_SYNC_MARKER =
  "# ===== ↑ 以上同步自 .gitignore（「从 .gitignore 同步」只重写以上部分）=====";
export const WORKSPACE_FILE_SEARCH_IGNORE_DEFAULTS_MARKER =
  "# ----- ↑ 以上为 ZCode 默认排除规则（自定义规则请写在本行下方，不会被同步/恢复改动）-----";

const CUSTOM_SECTION_HINT = "# 自定义规则写在下方（本行提示可删除）";

function buildBuiltinDefaultsSection(gitignoreContent: string | null): string {
  // 创建/恢复默认时的去重：gitignore 区已声明的规则不重复写入默认段，
  // 保证文件中每条规则最多一份——用户删除一处即完全放开，不会出现
  // "删了默认段的 node_modules/ 但 gitignore 拷贝区还藏着一条"的困惑。
  // 判重保守：行 trim 后相等，或忽略单个尾 '/' 差异（node_modules 覆盖 node_modules/）；
  // anchored（/node_modules/）等写法差异不视为重复，宁可重复不可漏规则。
  if (gitignoreContent === null) {
    return BUILTIN_IGNORE_LINES.join("\n");
  }
  const declared = new Set<string>();
  for (const rawLine of gitignoreContent.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("!")) {
      continue;
    }
    declared.add(line);
    declared.add(line.replace(/\/$/, ""));
  }
  const deduped = BUILTIN_IGNORE_LINES.filter((line) => {
    // 漏写一条 node_modules/ 会让该目录整棵进入文件搜索，所以判重只能保守，不能反过来去重。
    const bare = line.replace(/\/$/, "");
    return !declared.has(line) && !declared.has(bare);
  });
  return deduped.join("\n");
}

/**
 * 构建 `.zcodeignore` 初始内容：.gitignore 规则拷贝 + 双标记分区（默认排除段 / 自定义区）。
 * 附加默认段是行为兼容要求：.gitignore 未声明 node_modules 等目录的仓库若仅严格拷贝，
 * 依赖目录会被整棵放开扫描（再次出现全仓扫描的性能问题）；默认段随文件
 * 交给用户编辑，删除即放开，维持"单一真相源、无代码级并集"的承诺。
 * 默认段写入前先对 gitignore 区做规则去重（见 buildBuiltinDefaultsSection）。
 */
export function buildWorkspaceFileSearchIgnoreTemplate(gitignoreContent: string | null): string {
  // gitignore 段是本函数唯一可变部分，先定型再拼装，避免在数组字面量里写嵌套三元。
  const gitignoreSection =
    // null 表示 .gitignore 不存在，纯空白表示存在但无规则；两者都退回 TEMPLATE_HEADER，否则会生成空段。
    gitignoreContent !== null && gitignoreContent.trim().length > 0
      // 末尾已有换行就不再补：补第二次会在 SYNC 标记前多出空行，按标记切分后 gitignore 段会漂移。
      ? gitignoreContent.endsWith("\n")
        ? gitignoreContent
        : `${gitignoreContent}\n`
      // 没有 .gitignore 时用 TEMPLATE_HEADER 占位，生成的 .zcodeignore 仍带解释性注释而不是直接以标记开头。
      : `${TEMPLATE_HEADER.join("\n")}\n`;
  return [
    gitignoreSection,
    WORKSPACE_FILE_SEARCH_IGNORE_SYNC_MARKER,
    // 默认段先按 gitignore 内容去重，避免同一规则在 SYNC 标记上下各出现一次。
    buildBuiltinDefaultsSection(gitignoreContent),
    WORKSPACE_FILE_SEARCH_IGNORE_DEFAULTS_MARKER,
    // 自定义提示行放在默认标记之下：两个分区按钮都只改标记以上内容，这一行永远不会被重写。
    CUSTOM_SECTION_HINT,
    "",
  ].join("\n");
}

interface SplitWorkspaceFileSearchIgnoreSections {
  gitignoreSection: string;
  defaultsSection: string;
  customSection: string;
}

/** 按双标记切分文件；任一标记缺失（旧格式/用户删除）返回 null，调用方退化为整体重建。 */
function splitWorkspaceFileSearchIgnoreSections(
  content: string,
): SplitWorkspaceFileSearchIgnoreSections | null {
  // 先按行切分再整行精确匹配：用户规则里可能提到标记原文，用 indexOf 全文搜索会定位错分区。
  const lines = content.split(/\r?\n/);
  const syncIndex = lines.findIndex(
    // trim 后整行相等才算标记：用户在标记后追加说明会使其失配，调用方随之退化为整体重建。
    (line) => line.trim() === WORKSPACE_FILE_SEARCH_IGNORE_SYNC_MARKER,
  );
  const defaultsIndex = lines.findIndex(
    (line) => line.trim() === WORKSPACE_FILE_SEARCH_IGNORE_DEFAULTS_MARKER,
  );
  // defaultsIndex <= syncIndex 也要拒绝：顺序颠倒时 slice 会得到反向区间，分区内容直接张冠李戴。
  if (syncIndex === -1 || defaultsIndex === -1 || defaultsIndex <= syncIndex) {
    return null;
  }
  return {
    // SYNC 标记行本身不进入任何分区，重新拼装时由调用方插回，避免标记被复制成两份。
    gitignoreSection: lines.slice(0, syncIndex).join("\n"),
    // 默认段 trim：标记之间的空行不属于规则，留着会让「恢复默认」每执行一次就累积一段空白。
    defaultsSection: lines.slice(syncIndex + 1, defaultsIndex).join("\n").trim(),
    // 只剥开头空行而不整体 trim：自定义区尾部的空行可能是有意排版，不该被吃掉。
    customSection: lines.slice(defaultsIndex + 1).join("\n").replace(/^\n+/, ""),
  };
}

/**
 * 「从 .gitignore 同步」：只重写 SYNC 标记之上的内容为当前 .gitignore，
 * 默认排除段与自定义区原样保留（用户对默认段的删改不受影响）。
 * 标记缺失时退化为整体初始内容重建（无法结构化定位分区）。
 */
export function syncWorkspaceFileSearchIgnoreFromGitignore(
  currentContent: string,
  gitignoreContent: string | null,
): string {
  // 前置条件：gitignoreContent 是当前 .gitignore 全文，null 表示不存在；两者生成的同步区头部不同。
  // 只有当前文件两个标记都在且顺序正确才能局部重写，否则走下方整体重建。
  const sections = splitWorkspaceFileSearchIgnoreSections(currentContent);
  if (!sections) {
    // 整体重建会丢掉用户自定义区，这是标记缺失时唯一能保证文件格式合法的选择。
    return buildWorkspaceFileSearchIgnoreTemplate(gitignoreContent);
  }
  // 与初始构建共用同一套首尾换行规则：同步前后行数差应只来自 .gitignore 内容本身。
  const gitignoreSection =
    gitignoreContent !== null && gitignoreContent.trim().length > 0
      ? gitignoreContent.endsWith("\n")
        ? gitignoreContent
        : `${gitignoreContent}\n`
      : `${TEMPLATE_HEADER.join("\n")}\n`;
  return [
    gitignoreSection,
    WORKSPACE_FILE_SEARCH_IGNORE_SYNC_MARKER,
    // 默认段原样回填而不重新去重：用户可能故意保留重复规则，同步不该动 SYNC 标记以外的内容。
    sections.defaultsSection,
    WORKSPACE_FILE_SEARCH_IGNORE_DEFAULTS_MARKER,
    // 自定义区最后写回，位置固定在 DEFAULTS 标记之后，保证用户手写规则不会被夹进默认段。
    sections.customSection,
  ]
    .join("\n")
    // 统一收尾为一个换行：反复同步不累积文件末尾空行，git diff 才不会噪声化。
    .replace(/\n+$/, "\n");
}

/**
 * 「恢复默认规则」：只重置默认排除段为内置清单，gitignore 区与自定义区原样保留。
 * 标记缺失时退化为整体初始内容重建。
 */
export function resetWorkspaceFileSearchIgnoreDefaults(
  currentContent: string,
  gitignoreContent: string | null,
): string {
  const sections = splitWorkspaceFileSearchIgnoreSections(currentContent);
  if (!sections) {
    return buildWorkspaceFileSearchIgnoreTemplate(gitignoreContent);
  }
  // 恢复默认按当前 gitignore 区规则去重重算：gitignore 已声明的行不重复写回默认段；
  // 若用户曾从 .gitignore 删掉 node_modules 等，恢复时默认段会把它补回（兜底回归）。
  return [
    sections.gitignoreSection,
    WORKSPACE_FILE_SEARCH_IGNORE_SYNC_MARKER,
    // 去重依据取当前 gitignore 段而不是外部传入内容：恢复默认时用户看不到 .gitignore，只能以文件现状为准。
    buildBuiltinDefaultsSection(sections.gitignoreSection),
    WORKSPACE_FILE_SEARCH_IGNORE_DEFAULTS_MARKER,
    // 自定义区这次同样原样保留，恢复默认只允许动 SYNC 与 DEFAULTS 之间的默认段。
    sections.customSection,
  ]
    .join("\n")
    // 与同步分支同一收尾规则，两个按钮产出的文件在行尾处理上必须一致。
    .replace(/\n+$/, "\n");
}

// ignore 包的 index.d.ts 在 nodenext 下把 default import 解析为模块命名空间（无调用签名），
// 而运行时 default 恰是工厂函数本身（Node ESM interop 实测）。这里显式收窄回工厂签名。
const createIgnoreMatcher: () => Ignore = ignoreFactory as unknown as () => Ignore;

function buildIgnoreMatcher(content: string): Ignore {
  // 规则文本原样交给 ignore 包：本仓库不手写 gitignore 解析，取反与后声明覆盖语义都由它保证。
  return createIgnoreMatcher().add(content);
}

function isNotFoundError(error: unknown): boolean {
  // 只认字符串 "ENOENT"：其它错误码（EACCES/EISDIR）必须上抛，不能被当成「文件不存在」。
  return (error as { code?: unknown } | null)?.code === "ENOENT";
}

async function readOptionalFile(path: string): Promise<string | null> {
  // 前置条件：path 必须是 workspace 根下的固定文件名；本函数不校验越界，拼路径由调用方负责。
  try {
    // await 不能省：直接 return readFile 会把 rejection 留在 Promise 里，try/catch 捕不到 ENOENT。
    return await readFile(path, "utf8");
  } catch (error) {
    if (isNotFoundError(error)) {
      return null;
    }
    // 只有 ENOENT 归为 null，权限与 IO 错误必须上抛：把 EACCES 当成不存在会让扫描悄悄换用兜底规则。
    throw error;
  }
}

/**
 * 原子写：目标目录内写临时文件（flush + close）后 rename 替换，参照
 * workspace-hook-mutation.ts 的模式，保证 Runtime/设置页不会观察到半截规则文件。
 */
async function atomicWriteIgnoreFile(path: string, content: string): Promise<void> {
  // 目标目录由 path 推导，不再传参：调用方少一个可传错的口子，临时文件必然与目标同目录。
  const directory = dirname(path);
  // 临时文件必须与目标同目录：跨目录 rename 在不同分区会退化成复制加删除，原子性直接消失。
  const tempPath = resolve(
    directory,
    // 名字里带 pid、时间戳与随机串：三者组合让并发保存不会命中同一个临时文件，也不会与用户文件重名。
    `.${basename(path)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    // wx 要求文件必须不存在：撞名时直接失败，而不是覆盖另一个进程正在写的临时文件。
    handle = await open(tempPath, "wx", 0o644);
    await handle.writeFile(content, "utf8");
    // 先 sync 再 rename：不刷盘时断电可能留下长度正确但内容为空的规则文件。
    await handle.sync();
    await handle.close();
    // close 成功后清空句柄，catch 里的 close 才不会对已关闭句柄再调一次并掩盖原始错误。
    handle = undefined;
    await rename(tempPath, path);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    // 失败路径清理临时文件，force 让「根本没创建成功」也不抛错；清理失败不能盖住原始 error。
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * 扫描前加载 `.zcodeignore` 规则；自动创建暂时注释停用：
 * 文件不存在 → 内存使用 .gitignore + 默认排除规则，不落盘；
 * 读取失败（权限等）→ 内存使用 .gitignore 内容 → 再失败用内置默认规则。
 * 任何降级只 warn 一次，绝不让 @ 面板因规则文件不可用而扫描失败。
 */
export async function loadWorkspaceFileSearchIgnoreRules(
  rootPath: string,
  logger?: WorkspaceFileIgnoreLogger,
): Promise<WorkspaceFileSearchIgnoreRules> {
  // 规则文件只认 workspace 根这一层，不做逐层查找：多份规则会让「哪条生效」不可预测。
  const ignorePath = resolve(rootPath, WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME);

  // 降级封装成闭包：三条降级路径共用同一段 .gitignore 读取与日志逻辑，避免只改一处导致 source 标记不一致。
  const degradeToInMemory = async (
    reason: string,
    error: unknown,
  ): Promise<WorkspaceFileSearchIgnoreRules> => {
    // 降级只影响内存规则，绝不落盘：扫描失败不能反过来改写用户项目里的 .zcodeignore。
    // 降级时连 .gitignore 都读不到就用内置模板，因此这里的 catch 必须返回 null 而不是继续向上抛。
    const gitignoreContent = await readOptionalFile(resolve(rootPath, GITIGNORE_FILE_NAME)).catch(
      () => null,
    );
    // 只要 .gitignore 读到内容就优先用它，内置默认规则只在两者都不可用时兜底。
    if (gitignoreContent !== null) {
      // 日志里带上 reason 而不是错误对象全文：路径与系统文案只经 error 参数交给 logger，不进消息串。
      logger?.warn(
        undefined,
        `[workspace-file-ignore] ${reason}，降级为运行时使用 .gitignore 规则`,
        error,
      );
      return {
        matcher: buildIgnoreMatcher(gitignoreContent),
        // 标记 fallback-gitignore 而不是 file，调用方才能区分「读的是 .zcodeignore」还是「临时借用了 .gitignore」。
        source: "fallback-gitignore",
      };
    }
    logger?.warn(
      undefined,
      `[workspace-file-ignore] ${reason}，降级为内置默认忽略规则`,
      error,
    );
    // 传 null 生成纯内置模板：没有 .gitignore 可拷贝时，模板里只剩默认排除段与提示行。
    const template = buildWorkspaceFileSearchIgnoreTemplate(null);
    return {
      matcher: buildIgnoreMatcher(template),
      source: "fallback-builtin",
    };
  };

  let existing: string | null;
  try {
    // null 表示文件确实不存在，与读取失败不同：前者继续走仅内存模板，后者由 catch 直接降级。
    existing = await readOptionalFile(ignorePath);
  } catch (error) {
    return degradeToInMemory(`读取 ${WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME} 失败`, error);
  }
  // 有文件就以文件为唯一真相源，不再叠加 .gitignore，否则用户删掉的规则会被 .gitignore 悄悄补回。
  if (existing !== null) {
    // 整个文件文本交给 ignore 包解析，取反与后声明覆盖的语义由它负责，本模块不做任何预拆分。
    return { matcher: buildIgnoreMatcher(existing), source: "file" };
  }

  // 确认 .zcodeignore 缺失后才读 .gitignore：顺序反了会多一次无谓 IO，也会让降级原因失真。
  const gitignoreContent = await readOptionalFile(
    resolve(rootPath, GITIGNORE_FILE_NAME),
  ).catch(() => null);
  // 未落盘时用初始内容建 matcher，保证 template 来源的扫描结果与将来落盘后再读完全一致。
  const initialContent = buildWorkspaceFileSearchIgnoreTemplate(gitignoreContent);
  // 管理入口已临时隐藏，但自动创建逻辑仍会往用户项目写文件，因此先注释停用。
  // 保留原创建和日志逻辑，后续恢复入口时可重新启用；当前只在内存中使用规则。
  /*
  try {
    await atomicWriteIgnoreFile(ignorePath, initialContent);
  } catch (error) {
    // 创建失败不影响扫描：初始内容确定性已知，内存中直接按初始内容执行，
    // 来源标记沿用初始内容来源（.gitignore 拷贝 / 内置模板）表达 fail-open 降级。
    logger?.warn(
      undefined,
      `[workspace-file-ignore] 自动创建 ${WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME} 失败，降级为运行时使用${
        gitignoreContent !== null ? ".gitignore" : "内置默认"
      }规则`,
      error,
    );
    return {
      matcher: buildIgnoreMatcher(initialContent),
      source: gitignoreContent !== null ? "fallback-gitignore" : "fallback-builtin",
    };
  }
  logger?.info(
    undefined,
    `[workspace-file-ignore] 已自动创建 ${WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME}（来源：${
      gitignoreContent !== null ? ".gitignore 拷贝" : "默认模板"
    }）`,
  );
  */
  return {
    matcher: buildIgnoreMatcher(initialContent),
    // source: gitignoreContent !== null ? "created-from-gitignore" : "created-from-template",
    // 写死 template：自动创建已停用，文件不存在就等价于模板态，不能标成 created-from-gitignore。
    source: "template",
  };
}

/**
 * 判定相对路径是否被忽略。目录必须传带尾斜杠的路径（gitignore dirOnly 规则只匹配目录），
 * relativePath 由调用方保证为 posix 分隔符（fileService 的 normalizeRelativePath 已转换）。
 */
export function isWorkspaceFileSearchPathIgnored(
  rules: WorkspaceFileSearchIgnoreRules,
  relativePath: string,
  type: "file" | "directory",
): boolean {
  // 前置条件：relativePath 已由调用方转成 POSIX 分隔符；混用反斜杠会让 gitignore 规则整体失配。
  // 目录必须补尾斜杠再交给 ignores：gitignore 的 dirOnly 规则（node_modules/）只匹配带斜杠的目录路径。
  return type === "directory"
    ? rules.matcher.ignores(`${relativePath}/`)
    : rules.matcher.ignores(relativePath);
}

/** 设置页读取：文件不存在时返回初始内容预览（source: template），不落盘。 */
export async function readWorkspaceFileSearchIgnore(
  rootPath: string,
): Promise<WorkspaceFileSearchIgnoreContent> {
  // 只读不写：文件不存在时返回模板预览，绝不在这里落盘，避免设置页一打开就改用户项目。
  const ignorePath = resolve(rootPath, WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME);
  // 设置页读取同样区分「不存在」与「读取失败」：失败会直接抛出，避免把权限问题显示成空模板。
  const existing = await readOptionalFile(ignorePath);
  if (existing !== null) {
    // source 为 file 表示规则已生效，前端据此隐藏「尚未落盘」的提示。
    return { content: existing, source: "file" };
  }
  const gitignoreContent = await readOptionalFile(
    resolve(rootPath, GITIGNORE_FILE_NAME),
  ).catch(() => null);
  return {
    // 文件不存在时返回模板预览而不是空串，用户能看到将来保存后会落盘的内容。
    content: buildWorkspaceFileSearchIgnoreTemplate(gitignoreContent),
    source: "template",
  };
}

export type WorkspaceFileSearchIgnoreTransform = "sync-gitignore" | "reset-defaults";

/**
 * 设置页分区操作（返回新内容填充编辑框，保存才落盘）：
 * sync-gitignore 只重写 gitignore 同步区；reset-defaults 只重置默认排除段；
 * 两者都保留标记之外的用户内容，详见各纯函数的契约。
 */
export async function transformWorkspaceFileSearchIgnore(
  rootPath: string,
  transform: WorkspaceFileSearchIgnoreTransform,
): Promise<{ content: string }> {
  // 前置条件：rootPath 必须是已确认的工作区根；变换结果只回填编辑框，真正落盘由保存接口负责。
  const ignorePath = resolve(rootPath, WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME);
  // 与读取接口不同，这里把读取失败也折叠成 null：变换只生成编辑框内容，失败应退回模板而不是报错。
  const existing = await readOptionalFile(ignorePath).catch(() => null);
  const gitignoreContent = await readOptionalFile(
    resolve(rootPath, GITIGNORE_FILE_NAME),
  ).catch(() => null);
  // 没有现成文件就先造一份等效内容再变换，保证 sync/reset 在首次使用时也有两个标记可切分。
  const currentContent = existing ?? buildWorkspaceFileSearchIgnoreTemplate(gitignoreContent);
  // transform 只有两个取值，用三元而不是查表：调用方能直接看到每个分支落到哪个纯函数。
  const content =
    transform === "sync-gitignore"
      ? syncWorkspaceFileSearchIgnoreFromGitignore(currentContent, gitignoreContent)
      // reset 分支同样传入 gitignoreContent，因为标记缺失时要靠它重建完整模板。
      : resetWorkspaceFileSearchIgnoreDefaults(currentContent, gitignoreContent);
  return { content };
}

/** 设置页保存：原子写整个文件，下次扫描读取即为新内容。 */
export async function writeWorkspaceFileSearchIgnore(
  rootPath: string,
  content: string,
): Promise<void> {
  // 写入即成为唯一真相源：content 必须来自设置页编辑框，不能由扫描路径自动拼装后覆盖用户文件。
  const ignorePath = resolve(rootPath, WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME);
  await atomicWriteIgnoreFile(ignorePath, content);
}
