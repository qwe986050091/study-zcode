// 文件定位：技能的「发现 + 校验 + 开关状态」聚合点，设置页列表与 prompt 注入共用同一份结果。
// 发现语义必须与 apps/zcode-cli 的 adapter 保持一致，否则 UI 可见与模型可执行会分裂。
// INV-01：技能 id = provider + scope + name + 路径哈希（buildSkillId），四者任一漂移都会让已存开关失效；
//         守住它的位置：buildSkillId、setEnabled 的 id 匹配；破坏后果：用户关闭的技能在下次扫描后重新启用。
// INV-02：开关只持久化「关闭」态，开启等于删除 override（writeSkillEnabledMap）；
//         守住它的位置：writeSkillEnabledMap 的 enable 分支；破坏后果：写入 true 会把技能钉死，
//         插件升级或默认值调整后无法跟随。
// INV-03：扫描根先去重路径、再按 realpath 去重实体，且被更深层根覆盖的祖先目录必须剔除；
//         守住它的位置：filterNestedScanRoots、dedupeScanRootsByRealpath；破坏后果：同一 SKILL.md 以两条路径出现两次。
// INV-04：同一实体技能只保留首次命中（seenSkillPaths 用 realpath 键）；用户级 .agents 被 .zcode 覆盖时跳过；
//         守住它的位置：discoverSkills 主循环；破坏后果：同名技能重复展示、开关互相覆盖。
// INV-05：删除只作用于受控技能根内的目录项，父目录 realpath 后再做包含判定；
//         守住它的位置：deleteSkill 的 canonicalParent 与 allowedRootCandidates；破坏后果：软链祖先把 rm -rf 引到根外。
// INV-06：frontmatter 解析允许宽松回退，任何失败都不得让技能从列表消失；
//         守住它的位置：readFrontmatter 的三条兜底分支；破坏后果：历史中文 description 会让整根技能不可见。
// INV-07：config 写入串行化（writeQueue），且单次失败不污染队列（queued.catch 兜底）；
//         守住它的位置：setEnabled；破坏后果：并发开关互相覆盖，或一次失败后队列永久 reject。
/* eslint-disable max-lines -- skill 发现 + 校验 + 状态 + 通用目录管理在同一服务里聚合，分层后跳转成本更高 */
import {
  access,
  appendFile,
  cp,
  mkdir,
  realpath,
  rm,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { existsSync, type Dirent } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import type {
  ZCodeProvider,
  SkillDiagnostic,
  SkillMetadata,
  SkillScope,
  SkillSummary,
  SkillsPromptContext,
  SkillsListResult,
  SkillsCapability,
} from "@zcode/shared";
import { DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS } from "@zcode/shared";
import type { ISkillsService } from "./skills.js";
import { SKILL_FILE_NAME, walkSkillMarkdownPaths } from "./skillDiscoveryWalk.js";
import { readInstalledPluginRoots } from "#src/plugins/installedPluginRoots.js";

// skills 与 diagnostics 分开返回：诊断是给设置页展示的可操作提示，
// 与技能本身不是一一对应（一次扫描失败可能只产出一条 warning），
// 混在技能对象上会让前端必须遍历全部技能才能汇总问题。
// 因此调用方必须以 diagnostics 为准判断「是否扫全」，不能只看 skills 是否为空。
interface DiscoverResult {
  skills: SkillSummary[];
  diagnostics: SkillDiagnostic[];
}

// parseOk 区分「严格 YAML 成功」与「宽松回退」：调用方目前只用 name/description/body，
// 但保留这个位是让未来诊断能区分「作者写了坏 YAML」与「文件根本没有 frontmatter」。
// keys 只保留顶层键，供能力判断使用（如某生态声明的扩展字段），不作为 warning 暴露。
// 该结构是发现流程的中间态，不得直接透出到 RPC，避免把宽松解析细节固化进协议。
interface ParsedFrontmatter {
  hasFrontmatter: boolean;
  name: string;
  description: string;
  body: string;
  /** frontmatter 中出现过的顶层 key，保留给后续能力判断，不再作为 warning 暴露。 */
  keys: string[];
  /** 严格 YAML 解析是否成功；失败时仍可能有 looseFields。 */
  parseOk: boolean;
}

// _meta.json 由技能安装器写入，缺失或损坏都不影响 SKILL.md 本体；
// 常量集中在此是因为它与 SKILL_FILE_NAME 必须位于同一技能目录层级，
// 任何一方挪位都会让 metadata 永远读不到，且不会报错、只会静默丢失版本信息。
// [权衡] 不校验 schema：安装器版本可能比本包新，严格校验反而会丢弃可用字段。
const SKILL_META_FILE_NAME = "_meta.json";
// 这三个路径在模块加载期求值一次，而不是每次调用重算：
// 审计日志与 CLI config 必须落在同一 home 下，运行中改 HOME 不应让写端漂移。
// [失败路径] 副作用是测试若在 import 之后修改 HOME 不会生效，必须在 import 前设置。
// 目录名 v2 属于既有用户数据布局，改名会让所有历史开关与审计日志失联。
const SKILL_SETTINGS_DIR = join(resolveUserHomeDir(), ".zcode", "v2");
const SKILL_CLI_SETTINGS_DIR = join(resolveUserHomeDir(), ".zcode", "cli");
const SKILL_CLI_CONFIG_FILE = join(SKILL_CLI_SETTINGS_DIR, "config.json");
const GIT_MARKER = ".git";
const HOME_PREFIX = "~/";
const ZCODE_OFFICIAL_PLUGIN_MARKETPLACE = "zcode-plugins-official";
const ZCODE_INLINE_PLUGIN_MARKETPLACE = "inline";
const ZCODE_PLUGIN_MANIFEST_PATH = join(".zcode-plugin", "plugin.json");
const CLAUDE_PLUGIN_MANIFEST_PATH = join(".claude-plugin", "plugin.json");
const CODEX_PLUGIN_MANIFEST_PATH = join(".codex-plugin", "plugin.json");

/** 对齐 apps/zcode-cli/packages/adapters/src/skills/index.ts:19 */
const MAX_DESCRIPTION_LENGTH = 1024;
// HOME 优先于 USERPROFILE：与 plugin 同步保持一致，SSH 与 Windows 本机
// 都能解析到用户期望的目录；两者都缺失时退回 os.homedir() 兜底。
// 空串（设置成 ""）视为未设置，否则 join 会拼出相对路径，
// 技能根被解析到进程 cwd，删除操作就可能越过受控根。
function resolveUserHomeDir() {
  // 先取 HOME 再取 USERPROFILE：两处都必须 trim，否则只含空格的值会被当成有效目录。
  const envHome = process.env.HOME?.trim() || process.env.USERPROFILE?.trim();
  // 只有非空结果才采用，缺值时退回 os.homedir()，保证技能根永远是绝对路径。
  return envHome && envHome.length > 0 ? envHome : homedir();
}

interface SkillsServiceOptions {
  isDesktopRuntime?: boolean;
}

/** ZCode Agent 工作区级技能目录。 */
// 工作区技能主目录。所有 workspace 级读写（扫描、复制、删除白名单）都从这里派生，
// 不得在别处手写 '.zcode','skills' 字面量，否则改布局时会漏掉某条破坏性路径。
// [权衡] 使用 path.join 而非 URL：Windows 下反斜杠形式是 CLI 侧同一实现，
// 两者必须逐字符一致，否则 realpath 去重会把同一目录当成两个根。
function getWorkspaceZcodeSkillRoot(workspacePath: string): string {
  // 三段一律交给 join：分隔符由平台决定，与 CLI 侧逐字符一致才能被 realpath 去重识别为同一根。
  return join(workspacePath, ".zcode", "skills");
}

/** 兼容目录: workspace 级 `.agents/skills`, 仅在同层 `.zcode/skills` 没读到技能时 fallback。 */
// 兼容目录：其它 Agent 生态的 `.agents/skills`。它只在「同层 .zcode/skills 未覆盖」时
// 贡献技能，但扫描时两个根都要进列表（见 resolveAncestorWorkspaceRoots 注释），
// 因为 runtime 本身是合并扫描的，UI 若只认一个根就会漏技能。
// 该函数返回的是候选根，不代表目录一定存在，调用方必须先探测。
function getWorkspaceAgentsSkillRoot(workspacePath: string): string {
  // 目录名固定为 .agents：写成 .zcode 会让兼容来源与主根重合，去重后兼容技能整体消失。
  return join(workspacePath, ".agents", "skills");
}

/** ZCode Agent 用户级技能目录。 */
// 用户级技能主目录，仅在 desktop 运行时可用（见 resolveCapabilities）。
// 远端/Web 场景没有稳定的用户主目录，硬扫会读到服务器运行账户的技能，
// 因此能力判断在调用方，而不是在这里返回空串——空串会被 join 成根路径，
// 那等于把整个磁盘当成技能目录。
function getUserZcodeSkillRoot(): string {
  // 用户根必须每次现算：home 在模块加载后才被测试改动时，缓存的字符串会指到旧目录。
  return join(resolveUserHomeDir(), ".zcode", "skills");
}

/** 兼容目录: 用户级 `~/.agents/skills`。 */
// 用户级兼容目录。与 .zcode 根同时扫描，去重由「同名覆盖」规则承担
// （见 isUserAgentsSkillCoveredByZcode）：.zcode 有同名技能时 .agents 的那份隐藏，
// 避免同一技能出现两行、开关互相冲突。
// 若改成只扫 .zcode，用户从别的 Agent 导入的全局技能会整体消失。
function getUserAgentsSkillRoot(): string {
  // 与用户级 .zcode 根同源求值：覆盖判定要比较两个兄弟目录，home 不同就永远比不中。
  return join(resolveUserHomeDir(), ".agents", "skills");
}

// 技能名比较键：trim + 小写。SKILL.md 的作者大小写习惯不统一（Foo 与 foo 常指同一技能），
// 但展示仍用原始 name，因此只在这里归一化，不能改写 SkillSummary.name。
// [权衡] 不做连字符/下划线互换：那属于不同技能生态的命名风格，
// 强行折叠会让两个真实存在的技能被判为重复并隐藏其中一个。
function normalizeSkillNameKey(name: string): string {
  // 判重键只做 trim 与小写：展示名仍用原始 name，改写会把用户写的技能名改掉。
  return name.trim().toLowerCase();
}

// 读不到 frontmatter 时退回父目录名：覆盖判断只需要一个稳定键，
// 而「无 frontmatter 的手写技能」在发现阶段也用目录名兜底（见 discoverSkills），
// 两处规则必须一致，否则覆盖判定与展示名会对不上。
// [失败路径] 读文件异常也走同一兜底，绝不让一次 IO 失败中断整根扫描。
async function readSkillNameKey(skillPath: string): Promise<string> {
  // 先算兜底名：父目录名不依赖文件内容，是读取失败时唯一还能用的稳定键。
  const fallbackName = basename(dirname(skillPath));
  try {
    // 整文件读入只为取 frontmatter，正文不参与覆盖判定，这里不做任何截断。
    const parsed = readFrontmatter(await readFile(skillPath, "utf-8"));
    // 无 frontmatter 或 name 为空都要落回目录名，规则必须与 discoverSkills 取名一致。
    const rawName = parsed.hasFrontmatter ? parsed.name.trim() : fallbackName;
    // 归一化后再返回：键要与 collectSkillNameKeysInRoot 写入的形态完全相同才可比。
    return normalizeSkillNameKey(rawName || fallbackName);
  } catch {
    // 读失败（权限、竞态删除、非法编码）不能中断扫描，退化成目录名键最多漏判一次覆盖。
    return normalizeSkillNameKey(fallbackName);
  }
}

// 只为用户级 .agents 覆盖判定服务的轻量索引：只取名字键，不构建完整 SkillSummary，
// 避免为了「是否重复」而解析全部技能正文与 metadata。
// 根不存在时返回空集合而不是抛错：目录缺失是常态（用户从未用过 .agents）。
// 诊断数组在这里被丢弃：覆盖判定不需要展示扫描失败，真正的问题由主扫描上报。
async function collectSkillNameKeysInRoot(rootPath: string): Promise<Set<string>> {
  const nameKeys = new Set<string>();
  // 先探测根是否存在：目录缺失是常态（用户从未装过其它生态），提前返回省掉一次遍历。
  if (!(await exists(rootPath))) {
    return nameKeys;
  }
  // 诊断只在这一层临时收集后丢弃：覆盖判定不负责展示问题，同一错误不该在主扫描里报两遍。
  const diagnostics: SkillDiagnostic[] = [];
  for (const skillPath of await collectSkillMarkdownPaths(rootPath, diagnostics)) {
    // 逐个文件解析名字键，刻意不构建 SkillSummary，避免为判重再读正文与 metadata。
    nameKeys.add(await readSkillNameKey(skillPath));
  }
  return nameKeys;
}

// 覆盖规则：用户级 .agents 技能在 .zcode 根存在「同名目录 + SKILL.md」或「同名键」时跳过。
// 先按路径同名判定，再按名字键判定：路径判定能覆盖目录名即技能名的常见布局，
// 名字键则兜住 frontmatter 里 name 与目录名不一致的情况。
// 只对 .agents 根生效：workspace 两个根是并存语义，不能互相遮盖（INV-04）。
async function isUserAgentsSkillCoveredByZcode(params: {
  skillPath: string;
  rootPath: string;
  userZcodeSkillNameKeys: Set<string>;
}): Promise<boolean> {
  const { skillPath, rootPath, userZcodeSkillNameKeys } = params;
  // 只有用户级 .agents 根参与覆盖：workspace 两个根是并存语义，误加会让兼容技能被整体吞掉。
  if (rootPath !== getUserAgentsSkillRoot()) {
    return false;
  }
  // 先按路径判定：.zcode 下存在同名目录且带 SKILL.md 时，这份 .agents 技能必须隐藏。
  if (await exists(join(getUserZcodeSkillRoot(), basename(dirname(skillPath)), SKILL_FILE_NAME))) {
    return true;
  }
  // 路径对不上再比名字键，兜住 frontmatter 里的 name 与目录名不一致的手写技能。
  return userZcodeSkillNameKeys.has(await readSkillNameKey(skillPath));
}

/**
 * 从 workspacePath 向上走到 worktree 根（含 .git 标记），把每一层的
 * `.zcode/skills` 与 `.agents/skills` 都收集起来。
 * 对齐 apps/zcode-cli/packages/adapters/src/skills/roots.ts:60-72。
 * 找不到 .git 时退回 workspacePath 自身。
 */
// 从工作区向上走到 worktree 根，每层都产出 `.zcode/skills` 与 `.agents/skills` 两个候选根：
// monorepo 里子包目录常有自己的技能，只扫顶层会漏；到 worktree 根为止则避免
// 顺着父目录扫到无关仓库。
// [失败路径] 找不到 .git 时只返回 workspacePath 自身——不能一路扫到盘符根，
// 否则会读到用户主目录之外的同名目录，且扫描代价不可控。
async function resolveAncestorWorkspaceRoots(workspacePath: string): Promise<string[]> {
  const worktreeRoot = await findWorktreeRoot(workspacePath);
  const baseDirectories: string[] = [];
  if (!worktreeRoot) {
    // 不在 git 仓库内时只认工作区自身，继续向上会扫到无关目录且代价不可控。
    baseDirectories.push(workspacePath);
  } else {
    let current = workspacePath;
    while (true) {
      // 从工作区逐层收集到 worktree 根，monorepo 子包目录里的技能因此同样可见。
      baseDirectories.push(current);
      // 到 worktree 根或盘符根时收手；dirname 在根目录返回自身，不判会死循环。
      if (current === worktreeRoot || current === dirname(current)) {
        break;
      }
      current = dirname(current);
    }
  }
  const roots: string[] = [];
  for (const dir of baseDirectories) {
    // Agent runtime 会合并扫描两个 workspace skill 根。UI 之前把 `.agents`
    // 当成 `.zcode` 的 fallback，导致同层 `.zcode` 只要有一个技能，`/`、`$` 和设置页
    // 就会整根漏掉 `.agents` 技能，形成“模型可执行但 UI 无法引用”的发现语义分裂。
    roots.push(getWorkspaceZcodeSkillRoot(dir));
    roots.push(getWorkspaceAgentsSkillRoot(dir));
  }
  return roots;
}

// 逐级向上找 .git 标记（目录或 worktree 的 git 文件都算存在），
// 用 exists 而非 stat：worktree 的 .git 是文件，只判目录会漏。
// 以 parent === current 作为终止条件（Windows 盘符根与 POSIX /），
// 否则 dirname 在根目录返回自身，循环不会退出。
async function findWorktreeRoot(workingDirectory: string): Promise<string | null> {
  let current = workingDirectory;
  while (true) {
    // 用 exists 而非 stat：worktree 的 .git 是文件而不是目录，只判目录会漏掉它。
    if (await exists(join(current, GIT_MARKER))) return current;
    const parent = dirname(current);
    // 父目录等于自身说明已到盘符根或 /，返回 null 让调用方退回 workspacePath。
    if (parent === current) return null;
    current = parent;
  }
}

// 纯字符串去重，保留首次出现顺序。这里不做 realpath：
// realpath 是异步且可能失败的操作，放在后面的 dedupeScanRootsByRealpath 统一处理，
// 免得同一批路径被解析两次。
// 顺序重要——先命中的根决定技能归属的 scope 与 plugin 信息。
function dedupeRoots(paths: string[]): string[] {
  const roots = new Set<string>();
  for (const path of paths) {
    // 只做字符串级去重，不碰文件系统：Set 的插入序就是首次出现序，scope 归属随之稳定。
    roots.add(path);
  }
  // 展开成新数组返回：调用方后续的 push 不会回写到这里的 Set。
  return [...roots];
}

// 统一成正斜杠并去掉尾部斜杠，仅用于比较，不用于真实文件访问：
// Windows 上同一目录可能以 `C:/a` 与 `C:\a\` 两种形式出现，
// 不归一化会让嵌套判定与 realpath 去重全部失效。
// 因此返回值绝不能拿去 join 或 rm，路径拼接必须继续使用原始字符串。
function normalizeScanRootPath(path: string): string {
  // 反斜杠换正斜杠并去掉尾斜杠；返回值只用于比较，拿去 join 会得到混合分隔符的错路径。
  return path.replaceAll("\\", "/").replace(/\/+$/, "");
}

/**
 * 去掉会被「已存在」的更深层扫描根完全覆盖的祖先目录。
 * 同一目录被不同路径形式扫到时，同一 SKILL.md 会因路径字符串不同重复出现。
 * 若子目录尚不存在，仍保留父目录以兼容非标准布局。
 */
// 去掉会被「已存在的更深层根」完全覆盖的祖先目录，防止同一 SKILL.md 因
// 路径形式不同而重复出现；判断前只对存在的根做归一化比较。
// 子目录不存在时保留父目录：非标准布局（技能直接放在中间层）仍需可扫。
// 用 startsWith(`${current}/`) 而不是 includes，避免 /a/bc 被 /a/b 误判为子目录（INV-03）。
async function filterNestedScanRoots(paths: string[]): Promise<string[]> {
  const existing = new Set<string>();
  for (const path of paths) {
    // 只有真实存在的根才参与覆盖判定：不存在的子目录不能证明父目录被覆盖。
    if (await exists(path)) {
      existing.add(normalizeScanRootPath(path));
    }
  }
  const normalized = paths.map((path) => normalizeScanRootPath(path));
  return paths.filter((path, index) => {
    // 归一化结果理论上必然存在，?? 只是为了不让 undefined 参与 startsWith。
    const current = normalized[index] ?? normalizeScanRootPath(path);
    // 当前根不存在时无法证明它被谁覆盖，原样保留以兼容非标准布局。
    if (!existing.has(current)) {
      return true;
    }
    // 只要有一个更深的已存在根以 current + "/" 开头，当前根就是可被跳过的祖先。
    return !normalized.some((other, otherIndex) => {
      // 跳过 otherIndex === index 与不存在的 other：后者不构成覆盖证据。
      if (otherIndex === index || !existing.has(other)) {
        return false;
      }
      // 带尾斜杠比较，保证按路径段而不是按字符前缀判定。
      return other.startsWith(`${current}/`);
    });
  });
}

// 实体去重：软链或 junction 让两个不同字符串指向同一目录时，只保留首个。
// 保留原始字符串而非 realpath 结果，是为了后续按根反查 descriptor（rootByPath），
// 回写 realpath 会让 Map 查不到，技能丢失 scope/plugin 归属。
// [失败路径] realpath 失败时退回归一化字符串：断链仍需参与扫描并产出可读诊断。
async function dedupeScanRootsByRealpath(paths: string[]): Promise<string[]> {
  const seen = new Set<string>();
  const result: string[] = [];
  // 先剔除祖先根再解析实体：顺序反了会让被覆盖的祖先先占位，真正的子根反被去重掉。
  for (const path of await filterNestedScanRoots(paths)) {
    let canonical = normalizeScanRootPath(path);
    // 只有存在的路径才值得 realpath；不存在时保留归一化字符串，让断链仍能参与扫描。
    if (await exists(path)) {
      // realpath 失败（断链、权限）退回原路径，不能让一次解析异常丢掉整个根。
      canonical = normalizeScanRootPath(await realpath(path).catch(() => path));
    }
    // 软链或 junction 让两个字符串指向同一实体时，后来的根直接丢弃。
    if (seen.has(canonical)) {
      continue;
    }
    seen.add(canonical);
    // 推入原始字符串而不是 canonical：rootByPath 按原始路径建索引，改写会让归属查不到。
    result.push(path);
  }
  return result;
}

// id 中只放哈希前缀而不是完整路径：路径可能很长且含用户目录名，
// 直接拼进 id 会泄漏本地布局，也会让日志与 UI 展示变得不可读。
// 12 位十六进制足以区分同一用户下的技能路径，冲突概率可忽略。
// 注意它参与 INV-01：换哈希算法等于所有已保存开关失效，必须视作破坏性变更。
function hashStableIdPart(value: string): string {
  // 固定 12 位十六进制：长度稳定才让 id 可比较，也避免把用户目录名直接暴露在 id 里。
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

// id 由 provider/scope/name/路径哈希四段拼成：name 进入 id 是为了让同名不同源技能可区分，
// 路径哈希则区分「同名且同 scope 但位于不同目录」的两个技能。
// [权衡] 不用路径全量做 id：路径会随 workspace 迁移变化，而用户开关按 id 存储，
// 全量路径会让「换个目录打开同一技能」被当成新技能（这是当前实现的已知取舍）。
function buildSkillId(params: {
  provider: ZCodeProvider;
  scope: SkillScope;
  name: string;
  path: string;
}): string {
  // 四段冒号连接：provider 与 scope 决定同名技能是否分离，路径哈希再区分同 scope 下的不同目录。
  return `${params.provider}:${params.scope}:${params.name}:${hashStableIdPart(params.path)}`;
}

// 只识别 `$name` 形式的显式引用，不猜自然语言：技能注入会改变模型行为，
// 误判的代价（注入无关技能正文）远高于漏判（用户再写一次 $name）。
// 正则限定小写字母数字与连字符，与技能名规范一致；大小写变体不匹配，
// 因此 buildPromptContext 里按原样比对 skill.name，不做二次归一化。
function collectMentionedSkillNames(prompt: string): Set<string> {
  const names = new Set<string>();
  // 去重集合：同一技能被提及多次也只注入一次，否则正文会在 prompt 里重复膨胀。
  for (const match of prompt.matchAll(/\$([a-z0-9]+(?:-[a-z0-9]+)*)/g)) {
    const name = match[1];
    // 捕获组 match[1] 必然存在，判空只为收窄类型而不改变匹配语义。
    if (name) {
      names.add(name);
    }
  }
  return names;
}

// 技能名与路径会进入 XML 属性，必须转义四个字符：& 先处理，
// 否则后续替换产生的 &amp;quot; 会被二次转义成字面量。
// 不转义单引号：属性统一用双引号包裹，单引号在其中无语法意义。
// [失败路径] 未转义的引号会让模型侧解析截断 prompt，技能正文被当成属性值丢弃。
function escapeXmlAttribute(value: string): string {
  // 替换顺序固定且 & 必须最先，否则后面生成的 &quot; 会被再转义成 &amp;quot;。
  // 单引号不处理：属性一律用双引号包裹，单引号在其中没有语法意义。
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("\"", "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

// 注入块用固定标签包裹，且每个技能单独一个 activated_skill 节点：
// 模型侧靠标签边界识别技能正文的起止，正文里即使含 Markdown 标题也不会破坏结构。
// [权衡] 不在此处截断正文：截断会让技能指令不完整，比不注入更危险；
// 体积控制由「只在显式提及时注入」这一前置条件承担。
function buildActivatedSkillsPromptBlock(skills: SkillSummary[]): string {
  return [
    "<available_skills>",
    // 逐项 map 成独立节点：正文里的 Markdown 标题不会与标签边界混淆。
    ...skills.map((skill) =>
      [
        // 标签名与属性值都转义；正文原样插入，因为截断或转义会破坏技能指令本身。
        `<activated_skill name="${escapeXmlAttribute(skill.name)}" path="${escapeXmlAttribute(skill.path)}">`,
        skill.body,
        "</activated_skill>",
      ].join("\n"),
    ),
    "</available_skills>",
  ].join("\n");
}

// 审计日志追加写：每次注入都记一条 JSON 行，用于回答「模型为什么知道这个技能」。
// 目录不存在时递归创建；appendFile 是 O_APPEND，多进程并发写不会互相覆盖行。
// [失败路径] 写失败的异常向上传播——审计缺失属于可观测性故障，不能静默吞掉。
// 日志字段只含路径与技能名，不含 prompt 正文，避免把用户输入落到磁盘。
async function appendSkillsAuditLog(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  activatedSkillNames: string[];
}): Promise<void> {
  // recursive 让首次使用时自动建出 ~/.zcode/v2，已存在时不报错。
  await mkdir(SKILL_SETTINGS_DIR, { recursive: true });
  await appendFile(
    // 固定文件名追加写，O_APPEND 语义保证并发进程的多条记录不会互相截断。
    join(SKILL_SETTINGS_DIR, "skills-audit.log"),
    // 单行 JSON 加换行：日志按行解析，且只落元信息、不落 prompt 正文。
    `${JSON.stringify({
      createdAt: Date.now(),
      // 路径与 identity 都要记：远程场景两者不同，只有路径无法关联回会话。
      workspacePath: params.workspacePath,
      // 缺失时写 null 而不是省略字段，下游解析无需区分两种形状。
      workspaceIdentity: params.workspaceIdentity ?? null,
      // 只记本次真正注入的名字，用于回答「模型为什么知道这个技能」。
      activatedSkillNames: params.activatedSkillNames,
    })}\n`,
    "utf-8",
  );
}

// frontmatter 解析是整条发现链路上唯一允许「失败也不丢技能」的环节（INV-06）。
// 先统一换行：SKILL.md 可能来自 Windows 或其他工具链，正则锚定 \n 才不会漏匹配。
// 解析顺序固定为「严格 YAML -> 宽松字段读取」，后者永远能给出 name/description，
// 只是把 parseOk 置 false 供上层判断是否降级。
function readFrontmatter(content: string): ParsedFrontmatter {
  // SKILL.md 可能来自 Windows 或其他工具链，换行符不一定是 \n。
  // 先统一换行，再把 frontmatter 字段交给 YAML 解析，兼容多行 description。
  const normalized = content.replace(/\r\n|\r/g, "\n");
  // 只认文件开头紧邻的 --- 块：允许出现在正文中间会让普通分隔线被误判成 frontmatter。
  const frontmatterMatch = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(normalized);
  if (!frontmatterMatch) {
    // 没有 frontmatter 是合法形态（手写技能常见），正文原样返回，name 留空由调用方兜底。
    return {
      hasFrontmatter: false,
      name: "",
      description: "",
      body: normalized.trim(),
      keys: [],
      parseOk: false,
    };
  }

  // 捕获组 1 是两条 --- 之间的内容；?? 兜住极端空块，避免后续 slice 收到 undefined。
  const frontmatterText = frontmatterMatch[1] ?? "";
  // 先把混进 frontmatter 的正文标题切出去，否则接下来的严格解析必然失败。
  const frontmatterParts = splitFrontmatterAndLeakedBody(frontmatterText);
  // 关闭 --- 之后的正文单独取出，稍后与切回来的泄漏正文合并。
  const bodyAfterFrontmatter = normalized.slice(frontmatterMatch[0].length).trim();
  // 泄漏正文在前、正常正文在后，还原成作者书写的先后顺序，空段被过滤掉。
  const body = [frontmatterParts.leakedBody, bodyAfterFrontmatter]
    .filter((part) => part.trim().length > 0)
    .join("\n\n")
    .trim();
  // 宽松字段与顶层键各算一次：严格解析失败后的每条分支都要用它们兜底。
  const looseFields = readLooseFrontmatterFields(frontmatterParts.metadataText);
  // 键列表只在严格解析失败时才用得上，但必须提前算好，避免在每个 catch 里重复扫描。
  const looseKeys = extractLooseFrontmatterKeys(frontmatterParts.metadataText);
  if (hasYamlUnsafeLooseInlineField(frontmatterParts.metadataText)) {
    // 历史中文 description 常写成未加引号的 `触发场景: ...`。
    // `: ` 在 YAML plain scalar 中会被当成映射分隔符，严格解析只会报错；这里直接采用宽松读取结果，避免全量并发测试里反复进入失败解析路径。
    return {
      hasFrontmatter: true,
      ...looseFields,
      body,
      keys: looseKeys,
      parseOk: false,
    };
  }
  let parsed: unknown;
  try {
    // 严格 YAML 结果可能是任意类型，先按 unknown 接住，类型判断放到下面统一做。
    parsed = parseYaml(frontmatterParts.metadataText);
  } catch {
    // 历史 skill 里存在 closing --- 前混入正文的非严格 YAML。
    // YAML 解析失败时回退到宽松字段读取，避免中文 description 等已存在 metadata 丢失。
    return {
      hasFrontmatter: true,
      ...looseFields,
      body,
      keys: looseKeys,
      parseOk: false,
    };
  }
  if (!isObjectRecord(parsed)) {
    // YAML 合法但不是映射（字符串、数组、null）时没有字段可读，只能回退到宽松结果。
    return {
      hasFrontmatter: true,
      ...looseFields,
      body,
      keys: looseKeys,
      parseOk: false,
    };
  }

  // 严格解析成功也仍用宽松值补空字段：name 写成 null 这类文件不该被判成缺失。
  return {
    hasFrontmatter: true,
    // 空串/null 都会让出位置给宽松读取到的名字，避免因一个坏字段丢掉整个技能。
    name: readFrontmatterString(parsed.name) || looseFields.name,
    // description 同理兜底，保证列表里始终有可读描述。
    description: readFrontmatterString(parsed.description) || looseFields.description,
    // body 已在上方与泄漏正文合并完毕，这里只做透传。
    body,
    // 严格解析成功时 keys 取 Object.keys(parsed)，宽松键只服务回退分支。
    keys: Object.keys(parsed),
    // 只有走到这里才代表严格解析成功，其余分支一律为 false。
    parseOk: true,
  };
}

// 历史技能把正文标题写在 closing --- 之前，严格解析会把正文当成 YAML 错误。
// 这里按 Markdown 标题切分：第一个标题之后的内容整体挪回 body，
// 既保留说明文本，又让剩余的 metadata 尽可能可解析。
// [权衡] 只认 ATX 标题（# 开头），不识别 Setext——后者在 frontmatter 中极罕见且易误判。
function splitFrontmatterAndLeakedBody(frontmatterText: string): {
  metadataText: string;
  leakedBody: string;
} {
  const lines = frontmatterText.split("\n");
  // 从第 1 行才开始找标题：首行以 # 开头的情况极少，宁可漏切也不要把整块 metadata 当正文。
  const leakedBodyStartIndex = lines.findIndex(
    (line, index) =>
      index > 0 &&
      // 部分历史 skill 把正文标题写在 closing --- 之前。
      // 遇到 Markdown 标题时，将这一段从 frontmatter 挪回 body，避免说明内容被解析阶段吞掉。
      /^#{1,6}\s+\S/.test(line),
  );
  if (leakedBodyStartIndex < 0) {
    // 没找到标题说明整段都是 metadata，泄漏正文必须是空串而不是 undefined。
    return { metadataText: frontmatterText, leakedBody: "" };
  }
  // 按标题下标一分为二：前半段继续当 metadata 解析，后半段整段归还给正文。
  return {
    metadataText: lines.slice(0, leakedBodyStartIndex).join("\n").trimEnd(),
    leakedBody: lines.slice(leakedBodyStartIndex).join("\n").trim(),
  };
}

// 宽松读取只做「按第一个冒号切键值」，不追求 YAML 语义：它存在的唯一理由是
// 历史技能里存在未加引号的中文 description（其中 `: ` 会被 YAML 当映射分隔符）。
// 支持 | 与 > 两种块标量，因为多行 description 在这类文件里很常见；
// 缩进处理只剥 1~2 个空格，保留作者原有的更深缩进语义。
function readLooseFrontmatterFields(frontmatterText: string): {
  name: string;
  description: string;
} {
  let name = "";
  let description = "";
  const lines = frontmatterText.split("\n");
  // 逐行扫描且下标可被块标量分支推进，不能改成 forEach，否则多行值会被重复解析。
  for (let index = 0; index < lines.length; index += 1) {
    // 行内容用 ?? 兜底，避免越界读到 undefined 时抛错。
    const line = lines[index] ?? "";
    // 按第一个冒号切分：值内部允许再出现冒号，用 indexOf 而不是 split。
    const colonIndex = line.indexOf(":");
    // colonIndex < 0 的行（块标量续行、空行）不是键值对，直接跳过。
    if (colonIndex < 0) {
      continue;
    }
    // 键与值各自 trim，容忍冒号两侧的空格。
    const key = line.slice(0, colonIndex).trim();
    const rawValue = line.slice(colonIndex + 1).trim();
    if (key === "name") {
      // name 不按多行处理：技能名跨行没有实际场景，只剥引号即可。
      name = readLooseFrontmatterInlineString(rawValue);
    } else if (key === "description") {
      // 看值首字符判断块标量：| 保留换行，> 折成空格。
      const blockStyle = rawValue[0];
      if (blockStyle === "|" || blockStyle === ">") {
        const blockLines: string[] = [];
        for (let nextIndex = index + 1; nextIndex < lines.length; nextIndex += 1) {
          const nextLine = lines[nextIndex] ?? "";
          // 顶格行代表块结束：块标量的每一行至少缩进一个字符。
          if (!nextLine.startsWith(" ") && !nextLine.startsWith("\t")) {
            break;
          }
          // 只剥 1~2 个空格，保留作者更深层的缩进；同时推进外层下标避免重复扫描。
          blockLines.push(nextLine.replace(/^\s{1,2}/, ""));
          index = nextIndex;
        }
        // 两种块样式只差连接符：> 用空格折行，| 保留原始换行。
        description = blockStyle === ">" ? blockLines.join(" ") : blockLines.join("\n");
      } else {
        // 非块标量按单行处理，与 name 同一规则。
        description = readLooseFrontmatterInlineString(rawValue);
      }
    }
  }
  return { name, description };
}

/**
 * 只收集 frontmatter 顶层 key（缩进行视为子字段，跳过）。
 * 用来给 unknown-key 诊断与 YAML 解析失败时的回退提供 keys 列表。
 */
// 只收集顶层键：以空白开头的行视为某个键的子字段直接跳过，
// 否则嵌套的 name 会把顶层键集污染，能力判断随之误判。
// 注释行与空键被排除；重复键只保留首个，与 YAML 的前者生效语义一致。
// 返回值仅用于回退路径（严格解析失败时仍要给出 keys）。
function extractLooseFrontmatterKeys(frontmatterText: string): string[] {
  const keys: string[] = [];
  for (const line of frontmatterText.split("\n")) {
    // line.length === 0 的空行不含键，先跳过以减少后面的判断。
    if (line.length === 0) continue;
    // 以空白开头的行属于上一个键的子字段，误收会污染顶层键集合。
    if (/^\s/.test(line)) continue;
    // line.trim().startsWith("#") 的注释行不构成键。
    if (line.trim().startsWith("#")) continue;
    // 冒号必须出现在首字符之后，排除无冒号与以冒号开头的行。
    const colonIndex = line.indexOf(":");
    if (colonIndex <= 0) continue;
    const key = line.slice(0, colonIndex).trim();
    // 冒号前只有空白时键为空，跳过。
    if (key.length === 0) continue;
    // 去重保留首次出现，与 YAML 中重复键前者生效的语义对齐。
    if (!keys.includes(key)) {
      keys.push(key);
    }
  }
  return keys;
}

// 预判「严格 YAML 必失败」的形态，直接走宽松读取，省掉一次异常构造与栈展开。
// 判定条件收得很窄：只有 name/description 的未加引号行值里出现 `: ` 才算。
// 已用引号或块标量的行不命中——它们是合法 YAML，交给严格解析即可。
// [权衡] 宁可漏判（退化成 catch 分支）也不要误判，否则正常技能会被当成坏文件。
function hasYamlUnsafeLooseInlineField(frontmatterText: string): boolean {
  const lines = frontmatterText.split("\n");
  for (const line of lines) {
    const colonIndex = line.indexOf(":");
    // colonIndex < 0 的行不可能是键值对，跳过。
    if (colonIndex < 0) {
      continue;
    }
    const key = line.slice(0, colonIndex).trim();
    // 只关心 name 与 description：其他字段的 ": " 不影响这两个字段的解析结果。
    if (key !== "name" && key !== "description") {
      continue;
    }
    const rawValue = line.slice(colonIndex + 1).trim();
    // 空值、带引号、块标量都是合法形态或无需特殊处理，交给严格解析即可。
    if (
      rawValue.length === 0 ||
      rawValue.startsWith("\"") ||
      rawValue.startsWith("'") ||
      rawValue.startsWith("|") ||
      rawValue.startsWith(">")
    ) {
      continue;
    }
    // 未加引号的 ": " 会被 YAML 当成映射分隔符，命中即可预判严格解析失败。
    if (rawValue.includes(": ")) {
      return true;
    }
  }
  // 所有行都没命中危险形态，可以安全交给严格 YAML 解析。
  return false;
}

// 只剥首尾成对的引号，不做反转义：宽松路径的定位是「尽量保住可读文本」，
// 而不是等价于 YAML。真正的反义交由严格解析负责。
// 若写成 replace(/["']/g, "")，技能名里合法的引号会被吞掉，id 随之变化。
function readLooseFrontmatterInlineString(value: string): string {
  // 首尾各剥一次引号，中间内容与内部引号保持不变，避免改写技能名。
  return value.trim().replace(/^["']|["']$/g, "");
}

// 严格 YAML 允许标量是非字符串（数字、布尔、日期），统一转成字符串：
// 技能名写成 name: 123 这类文件在真实生态里存在，直接当缺失会让技能消失。
// null/undefined 才返回空串，以便上层用 `|| looseFields.name` 回退。
// 不做 trim：trim 由调用方决定，避免把作者刻意保留的空白语义改掉。
function readFrontmatterString(value: unknown): string {
  // 已是字符串就原样返回，保留作者写下的空白与大小写。
  if (typeof value === "string") {
    return value;
  }
  // null/undefined 代表字段缺失，返回空串让调用方用 || 回退到宽松值。
  if (value === null || value === undefined) {
    return "";
  }
  // 数字、布尔等标量统一字符串化：丢字段会让大量历史技能从列表里消失。
  return String(value);
}

// _meta.json 是安装器附加信息，与技能本体解耦：读不到或损坏都返回 undefined，
// 让技能仍以 SKILL.md 的内容展示（见 catch 分支的既有注释）。
// 只挑选已知字段并逐项校验类型，未知字段不透传——协议层不接受任意键，
// 透传会把安装器的内部结构泄漏到 RPC 响应里。
// 空对象视为无 metadata：全字段缺失与文件不存在对调用方的语义相同。
async function readSkillMetadata(skillPath: string): Promise<SkillMetadata | undefined> {
  const metaPath = join(dirname(skillPath), SKILL_META_FILE_NAME);
  // 读不到（不存在、权限、竞态删除）统一折成 null：metadata 只是附加信息，不能影响技能可见性。
  const raw = await readFile(metaPath, "utf-8").catch(() => null);
  // 空文件与读失败同义，直接按无 metadata 处理。
  if (!raw) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    // 非对象（数组、字符串、null）没有可识别字段，按无 metadata 处理。
    if (!isObjectRecord(parsed)) {
      return undefined;
    }
    // 只挑已知字段重新组装，未知键不透传，避免安装器内部结构泄漏到 RPC 响应。
    const metadata: SkillMetadata = {};
    // 逐项校验 typeof === "string" 且 trim 后非空：安装器可能写入空串。
    if (typeof parsed.slug === "string" && parsed.slug.trim().length > 0) {
      metadata.slug = parsed.slug.trim();
    }
    if (typeof parsed.version === "string" && parsed.version.trim().length > 0) {
      metadata.version = parsed.version.trim();
    }
    if (typeof parsed.ownerId === "string" && parsed.ownerId.trim().length > 0) {
      metadata.ownerId = parsed.ownerId.trim();
    }
    // 时间戳必须同时是数字且有限：NaN 或 Infinity 会让前端日期格式化出错。
    if (typeof parsed.publishedAt === "number" && Number.isFinite(parsed.publishedAt)) {
      metadata.publishedAt = parsed.publishedAt;
    }
    // 全字段都缺失时返回 undefined，与文件不存在的形状保持一致。
    return Object.keys(metadata).length > 0 ? metadata : undefined;
  } catch {
    // _meta.json 是 skill 安装器的附加信息，损坏时不应影响 SKILL.md 本体展示。
    return undefined;
  }
}

// 用 access 而不是 stat：调用方只关心「能否访问」，不需要类型信息；
// 名称与 node:fs 的 existsSync 对应，避免读代码时误以为在判文件类型。
// [失败路径] 任何异常都折算为 false，包括 EACCES——权限不足的目录在扫描阶段
// 会被当作不存在而跳过，而不是中断整次发现。
async function exists(path: string): Promise<boolean> {
  try {
    // access 成功即视为可用，不区分文件与目录，调用方只关心能不能读。
    await access(path);
    return true;
  } catch {
    // 任何异常（ENOENT、EACCES、断链）都折算为 false，权限不足的目录按不存在跳过。
    return false;
  }
}

// config 里的键统一用正斜杠：开关按 SKILL.md 绝对路径存储，
// Windows 写入的是反斜杠，不归一会导致同一技能出现两个键、开关看起来时灵时不灵。
// 只做分隔符替换，不做大小写折叠：Windows 路径本身不区分大小写，
// 但折叠会让两份真实并存的技能（大小写不同）共用一个开关。
// 该函数只用于 config 键，绝不用于真实文件访问。
function normalizeSkillConfigPath(path: string): string {
  // 只换分隔符不做大小写折叠：折叠会让大小写不同的两份真实技能共用一个开关。
  return path.replaceAll("\\", "/");
}

// 读失败一律返回空对象：CLI config 可能尚未创建（首次启动），
// 也可能被其他进程写成半个文件；技能列表不应因此整体不可用。
// [权衡] 静默降级意味着「配置损坏」不可见，代价是开关全部回到默认；
// 写入路径（writeSkillEnabledMap）会基于空对象重建，最终覆盖损坏文件。
// 非对象内容（数组、字符串）同样视为空，避免下游 isObjectRecord 分支到处判断。
async function readCliConfigFile(): Promise<Record<string, unknown>> {
  try {
    // 每次调用都读盘：config 可能被 CLI 进程并发修改，缓存会让开关显示过期状态。
    const raw = await readFile(SKILL_CLI_CONFIG_FILE, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    // 非对象内容视为空配置，写回路径才能基于空对象重建并覆盖损坏文件。
    return isObjectRecord(parsed) ? parsed : {};
  } catch {
    // 文件缺失或 JSON 只写了一半都返回空对象：技能列表不能因此整体不可用。
    return {};
  }
}

// 排除数组：typeof [] === "object"，若不显式排除，
// 对数组做 Object.entries 会得到下标键，被误当成技能路径写入 config。
function isObjectRecord(value: unknown): value is Record<string, unknown> {
  // 必须排除数组：typeof [] 也是 object，否则下标会被当成键写入 config。
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// skills 段的结构是 { <SKILL.md 路径>: { enable: boolean } }，只有 enable 为布尔才采纳；
// 其它字段（未来可能扩展）被忽略，保证旧版本读到新格式时不会崩溃。
// 键在读取时就归一化，与写入侧保持同一形态，attachEnabledState 才能命中。
// 重复归一化后的键后者覆盖前者，与 JSON 解析的后者优先一致。
function readSkillEnabledMapFromConfig(config: Record<string, unknown>): Record<string, boolean> {
  const skillsConfig = isObjectRecord(config.skills) ? config.skills : {};
  // 结果键统一归一化，与写入侧同形态，attachEnabledState 才能命中。
  const result: Record<string, boolean> = {};
  for (const [path, value] of Object.entries(skillsConfig)) {
    // 只采纳 { enable: boolean } 形状，旧格式或损坏值一律忽略，旧版本读到新格式也不会崩。
    if (isObjectRecord(value) && typeof value.enable === "boolean") {
      // 归一化后键可能撞车，后者覆盖前者，与 JSON 解析的后者优先一致。
      result[normalizeSkillConfigPath(path)] = value.enable;
    }
  }
  return result;
}

// 每次 list 都重新读盘而不是缓存：config 可能被 CLI 进程并发修改，
// 缓存会让设置页显示过期状态，用户点开关时又基于旧值计算，形成回跳。
// [权衡] 高频 list 会放大 IO，但技能列表本身已包含目录遍历，占比可忽略。
async function readSkillEnabledMap(): Promise<Record<string, boolean>> {
  // 先读全量 config 再投影：投影保持纯函数，方便在同一份快照上复用与测试。
  return readSkillEnabledMapFromConfig(await readCliConfigFile());
}

// 写入策略是「只记关闭」：enable 为 true 时删除键（INV-02），否则写入 { enable: false }。
// 遍历前按路径排序，保证同一份状态产生稳定文件内容，便于 diff 与人工排查。
// config.skills 清空后整个字段被删除，避免留下空对象影响其他模块的默认值判断。
// [资源] 这里没有用原子写：调用方已串行化（writeQueue），且 CLI 与本进程共用文件；
// 直接 writeFile 的窗口更短，但崩溃仍可能截断文件——这是已知取舍。
async function writeSkillEnabledMap(next: Record<string, boolean>): Promise<void> {
  const config = await readCliConfigFile();
  // 现有 skills 段可能是损坏形状，非对象时从空对象起步，旧内容就此被整体覆盖。
  const skillsConfig = isObjectRecord(config.skills) ? config.skills : {};
  for (const [path, enable] of Object.entries(next).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    // 技能开关之前分散在 workspace/provider/context 状态文件，导致同一技能在不同入口表现不一致。
    // 现在只按 SKILL.md 路径写入 CLI config 的 skills 字段，避免额外迁移或旧文件副作用。
    const normalizedPath = normalizeSkillConfigPath(path);
    if (enable) {
      // 开启态是默认值，不应落盘成 `{ enable: true }`；删除 override 才能跟随插件/默认配置变化。
      delete skillsConfig[normalizedPath];
    } else {
      // 关闭态写入最小对象，只带 enable 字段，未来扩展不会与默认值冲突。
      skillsConfig[normalizedPath] = { enable };
    }
  }
  // 有内容才写字段：空对象会让其它模块误以为用户显式清空了技能配置。
  if (Object.keys(skillsConfig).length > 0) {
    config.skills = skillsConfig;
  } else {
    // 全部为空时删掉整个字段，保持 config 干净。
    delete config.skills;
  }
  // 首次写入时 ~/.zcode/cli 可能还不存在，recursive 保证父目录被建出来。
  await mkdir(SKILL_CLI_SETTINGS_DIR, { recursive: true });
  // 末尾补换行：手工编辑与 diff 工具都把末行换行当作文本文件约定。
  await writeFile(SKILL_CLI_CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
}

// 扫描根的完整身份：scope 决定技能归属，pluginName/pluginId 只在插件根上出现。
// 之所以把 descriptor 与路径分开存，是因为去重后的根可能被别名替换，
// 但归属信息必须跟着原始字符串走（见 dedupeScanRootsByRealpath）。
// 任何新增根类型都必须补齐这三个字段，否则 UI 上会出现无归属的技能。
interface SkillRootDescriptor {
  scope: SkillScope;
  rootPath: string;
  pluginName?: string;
  pluginId?: string;
}

// CLI config 中插件相关字段的收敛视图：dirs 是手动登记目录，
// enabledPlugins 是按 pluginId 的覆盖开关，suppressedBuiltins 记录被卸载的内置插件。
// storageDir 是插件缓存根（可能含 ~ 前缀），后续 resolveConfigPath 负责展开。
// 五项都有默认值，缺失字段不能让整个插件技能发现失败。
interface PluginConfigSummary {
  dirs: string[];
  enabled: boolean;
  enabledPlugins: Record<string, boolean>;
  storageDir: string;
  suppressedBuiltins: string[];
}

interface PluginRootCandidate {
  defaultEnabled: boolean;
  marketplace: string;
  rootPath: string;
}

interface PluginManifestSummary {
  name: string;
  skills?: unknown;
}

// plugins.enabled 缺省为 true：与 CLI 行为一致，未显式关闭插件即视为启用。
// 布尔字段用 typeof 判断而非真值判断，避免字符串 "false" 被当成 true。
// dirs 与 suppressedBuiltins 都走 readStringArray，非字符串项被丢弃。
// [失败路径] 整个 plugins 段缺失时得到全默认值，等价于「未安装任何插件」。
function readPluginConfigFromConfig(config: Record<string, unknown>): PluginConfigSummary {
  const plugins = isObjectRecord(config.plugins) ? config.plugins : {};
  // 五项分别兜底：plugins 整段缺失时得到全默认值，等价于「未安装任何插件」。
  return {
    // dirs 只接受字符串项，非字符串项被丢弃，宁可少扫一个目录也不用错路径。
    dirs: readStringArray(plugins.dirs),
    // 布尔判断用 typeof：字符串 "false" 是真值，直接真值判断会把它当启用。
    enabled: typeof plugins.enabled === "boolean" ? plugins.enabled : true,
    // enabledPlugins 只保留布尔值，非法项退化为「未设置」即默认启用。
    enabledPlugins: readBooleanRecord(plugins.enabledPlugins),
    // storageDir 缺省 ~/.zcode，与 CLI 共用同一缓存根。
    storageDir: readStorageDirFromConfig(config),
    // 卸载记录只做字符串过滤，缺失即空数组，不触发任何跳过。
    suppressedBuiltins: readStringArray(plugins.suppressedBuiltins),
  };
}

function readStringArray(value: unknown): string[] {
  // 非数组直接给空数组；数组内用类型谓词过滤，保证返回值里没有 null 或对象。
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

// 只保留布尔值：enabledPlugins 里混入 null 或字符串时忽略该项，
// 让「未设置」与「设置为非法值」都退化为默认启用。
// 不复用 isObjectRecord 之外的校验，避免把数组下标键当成插件 id。
function readBooleanRecord(value: unknown): Record<string, boolean> {
  const result: Record<string, boolean> = {};
  // 非对象没有可枚举的插件 id，直接返回空表。
  if (!isObjectRecord(value)) {
    return result;
  }
  for (const [key, enabled] of Object.entries(value)) {
    // 只有显式布尔值才采纳，null 与字符串视为未设置，最终落到默认启用。
    if (typeof enabled === "boolean") {
      result[key] = enabled;
    }
  }
  return result;
}

// storage.dir 决定插件缓存的物理位置，缺省 ~/.zcode 与 CLI 保持一致；
// 空白字符串视为未配置，否则会拼出相对 cwd 的路径，扫描到错误目录。
// 这里不展开 ~，展开交给 resolveConfigPath：读取与展开分离，
// 让配置原样透传到日志时仍可读（用户看到的是自己填的值）。
// [失败路径] 传入非字符串时同样回退默认值，而不是抛错中断列表。
function readStorageDirFromConfig(config: Record<string, unknown>): string {
  const storage = isObjectRecord(config.storage) ? config.storage : {};
  // 只有非空字符串才采纳：空白值会让 join 拼出相对 cwd 的路径，扫描到错误目录。
  return typeof storage.dir === "string" && storage.dir.trim().length > 0
    ? storage.dir
    : "~/.zcode";
}

// 只展开行首的 ~/，不支持 ~user：插件配置来自 CLI，约定只用当前用户主目录。
// 相对路径按进程 cwd 解析，这是 CLI 侧同样的语义；因此配置里写相对路径
// 在 desktop 与 CLI 下可能指向不同目录，属于已知限制。
// [权衡] 不做存在性校验：解析失败留给下游 readdir 报错，避免同一路径被判两次。
function resolveConfigPath(path: string): string {
  const expanded = path.startsWith(HOME_PREFIX)
    // 只把行首 ~/ 换成用户主目录，~user 形式不支持，配置约定只用当前用户。
    ? join(resolveUserHomeDir(), path.slice(HOME_PREFIX.length))
    : path;
  // 相对路径按进程 cwd 解析，与 CLI 语义一致；此处不校验存在性，交给下游 readdir 报错。
  return isAbsolute(expanded) ? expanded : resolve(expanded);
}

// storage.dir 可能有两种写法：直接指向 .../cli，或指向其父级；
// 以 basename 是否为 cli 区分，兼容历史上两种配置形态。
// 不做 realpath：缓存根可能在首次安装前不存在，realpath 会失败。
// 结果用于拼插件目录，拼接前不校验存在性。
function resolveCliStorageRoot(storageDir: string): string {
  const storageRoot = resolveConfigPath(storageDir);
  // 兼容两种历史写法：已指向 .../cli 的直接用，指向父级的再补一层 cli。
  return basename(storageRoot) === "cli" ? storageRoot : join(storageRoot, "cli");
}

function resolvePluginStorageRoot(storageDir: string): string {
  // 插件缓存固定在 cli/plugins 下，偏移一层就会与 CLI 看到不同的插件集合。
  return join(resolveCliStorageRoot(storageDir), "plugins");
}

// 插件 manifest 的 skills 字段允许单个字符串或数组两种写法：
// 单字符串形态来自早期手工编写的 manifest，直接 readStringArray 会得到空数组，
// 表现为「插件声明了技能却一个都扫不到」。
// [失败路径] 其他类型一律按空数组处理，与「未声明」等价。
function parsePathList(value: unknown): string[] {
  // 单字符串形态来自早期手写 manifest，必须包成数组，否则会被 readStringArray 判成空。
  if (typeof value === "string") {
    return [value];
  }
  // 数组输入逐个过滤；其他类型得到空数组，等价于「未声明」。
  return readStringArray(value);
}

// 把 manifest 里的相对路径收敛到插件根内，越界或绝对路径返回 null 由调用方跳过。
// 判定用 relative 而不是字符串前缀：前缀比较在 Windows 上会因盘符大小写、
// 分隔符差异误判；且 `..` 段必须按路径语义处理，不能靠 includes。
// 允许 relativePath === ""（skills 写成 "." 指向插件根本身）——这是合法布局。
// [失败路径] 返回 null 而不是抛错：一个坏路径不应让整个插件无技能。
function resolveInside(rootPath: string, rawPath: string): string | null {
  // 绝对路径无法保证落在插件根内，直接拒绝，由调用方跳过该项。
  if (isAbsolute(rawPath)) {
    return null;
  }
  const resolved = resolve(rootPath, rawPath);
  // 用 relative 做归属判定：它按路径段计算，能正确处理 .. 段与盘符大小写差异。
  const relativePath = relative(rootPath, resolved);
  if (
    // 空串表示指向插件根本身（skills 写成 "."），是合法布局。
    relativePath === "" ||
    // 不以 .. 开头且不含 .../ 段，说明解析结果仍在根内。
    (!relativePath.startsWith("..") && !relativePath.includes(`..${sep}`))
  ) {
    return resolved;
  }
  // 越界返回 null 而不是抛错：一个坏路径不应让整个插件失去全部技能。
  return null;
}

// 官方插件缓存的布局是 cache/<marketplace>/<plugin>/<version>，只把 version 目录当根；
// 这样每个版本各自成为扫描根，旧版本仍会被扫到——是否启用由 enabledPlugins 决定，
// 不在这里做「只取最新版本」的裁剪。
// [失败路径] 目录缺失或不可读都返回空数组：未安装过官方插件是常态。
// 结果排序保证同一份缓存产生稳定的技能顺序，便于前端 diff。
async function scanOfficialPluginCacheRoots(pluginStorageRoot: string): Promise<string[]> {
  const cacheRoot = join(pluginStorageRoot, "cache", ZCODE_OFFICIAL_PLUGIN_MARKETPLACE);
  // 默认空数组：目录缺失或不可读都走 catch 返回，未安装过官方插件是常态。
  let pluginEntries: Dirent[] = [];
  try {
    // withFileTypes 才能直接判目录，省掉逐项额外 stat 的开销。
    pluginEntries = await readdir(cacheRoot, { withFileTypes: true });
  } catch {
    // 缓存根不存在时返回空数组而不是抛错，调用方按「无官方插件」继续。
    return [];
  }

  const roots: string[] = [];
  for (const pluginEntry of pluginEntries) {
    // 只认目录：缓存根下可能混有索引 json 等文件。
    if (!pluginEntry.isDirectory()) {
      continue;
    }
    const pluginDir = join(cacheRoot, pluginEntry.name);
    let versionEntries: Dirent[] = [];
    try {
      versionEntries = await readdir(pluginDir, { withFileTypes: true });
    } catch {
      // 单个插件目录不可读时跳过它，不能因为一个坏插件中断整批缓存扫描。
      continue;
    }
    for (const versionEntry of versionEntries) {
      // 布局是 <plugin>/<version>，每个版本目录各自成为扫描根，旧版本也不裁剪。
      if (versionEntry.isDirectory()) {
        roots.push(join(pluginDir, versionEntry.name));
      }
    }
  }
  // 固定字典序：同一份缓存每次产出的根顺序一致，前端 diff 才不会抖动。
  return roots.sort((left, right) => left.localeCompare(right));
}

// 插件 manifest 的 name 必须匹配小写 slug 规则，否则返回 null：
// 这个名字会拼进 pluginId 并作为配置键，含大写或空格会让开关与 CLI 侧对不上。
// skills 字段原样保留，由 resolvePluginSkillRoots 决定如何解释。
// [失败路径] 读失败、JSON 损坏、非对象三种情况统一返回 null，调用方按「无插件」跳过。
// 长度上限 128 是配置键与日志可读性的折中，不是安全边界。
async function readPluginManifest(rootPath: string): Promise<PluginManifestSummary | null> {
  const manifestPath = await findPluginManifestPath(rootPath);
  // 三个生态的 manifest 都不存在时按「非插件目录」处理。
  if (!manifestPath) {
    return null;
  }
  let raw: string;
  try {
    raw = await readFile(manifestPath, "utf-8");
  } catch {
    // 探测到文件但读不了（权限、竞态删除）同样返回 null，调用方跳过该候选。
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    // 非对象没有 name，无法生成 pluginId，直接判为无插件。
    if (!isObjectRecord(parsed)) {
      return null;
    }
    // name 缺失时给空串，交给下面的 slug 正则统一拒绝。
    const name = typeof parsed.name === "string" ? parsed.name.trim() : "";
    // 名字会拼进 pluginId 并作为配置键：大写、空格、超长都会让开关与 CLI 侧对不上。
    if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(name)) {
      return null;
    }
    // skills 原样透出，由 resolvePluginSkillRoots 决定按字符串还是数组解释。
    return { name, skills: parsed.skills };
  } catch {
    // JSON 损坏等同于无 manifest，不能让一个坏文件阻断其它插件。
    return null;
  }
}

// 三个生态的 manifest 依次探测：.zcode-plugin 优先，其次 .claude-plugin 与 .codex-plugin。
// 顺序决定同一目录下多份 manifest 时以谁为准——ZCode 必须优先，
// 否则用户为 ZCode 定制的 skills 路径会被其他生态的声明覆盖。
// 用 exists 逐项探测而不是一次 readdir：目录可能很大，且我们要保持固定优先级。
async function findPluginManifestPath(rootPath: string): Promise<string | null> {
  for (const manifestPath of [
    // 顺序即优先级：.zcode 必须最先，用户为 ZCode 定制的 skills 路径不能被其他生态声明覆盖。
    join(rootPath, ZCODE_PLUGIN_MANIFEST_PATH),
    // 其次是 Claude 生态的 manifest。
    join(rootPath, CLAUDE_PLUGIN_MANIFEST_PATH),
    // 最后是 Codex 生态。
    join(rootPath, CODEX_PLUGIN_MANIFEST_PATH),
  ]) {
    // 逐个探测而不是一次 readdir：目录可能很大，且必须保持这个固定优先级。
    if (await exists(manifestPath)) {
      return manifestPath;
    }
  }
  // 三个位置都没有 manifest，说明该目录不是插件根。
  return null;
}

// 把 manifest.skills 解析成实际目录列表，全部经 resolveInside 收敛在插件根内。
// 只有「skills 字段完全缺失」时才回退到约定目录 <root>/skills；
// 显式声明了但全部越界时不回退，避免把不该暴露的目录扫进来。
// [失败路径] 越界项静默跳过，但会因 roots 为空导致该插件无技能，属于可见后果。
function resolvePluginSkillRoots(params: {
  manifest: PluginManifestSummary;
  rootPath: string;
}): string[] {
  const roots: string[] = [];
  for (const rawPath of parsePathList(params.manifest.skills)) {
    // 每个声明路径都要收敛到插件根内，越界或绝对路径会得到 null。
    const rootPath = resolveInside(params.rootPath, rawPath);
    // 只有合法路径才成为扫描根；全部越界时 roots 为空，该插件无技能。
    if (rootPath) {
      roots.push(rootPath);
    }
  }
  // 仅在 skills 字段完全缺失时才回退约定目录；显式声明全部越界时不回退，避免扫进不该暴露的目录。
  if (roots.length === 0 && params.manifest.skills === undefined) {
    const defaultRoot = join(params.rootPath, "skills");
    // 函数本身是同步的，这里用同步 existsSync 判存在，约定目录缺失就不产出根。
    if (existsSync(defaultRoot)) {
      roots.push(defaultRoot);
    }
  }
  return roots;
}

// 插件技能根的三类来源：CLI config.dirs（手动登记）、官方缓存、installed_plugins.json。
// plugins.enabled 为 false 时整段返回空：这是全局开关，优先于任何单项配置。
// 每个候选都要读 manifest 才能得到稳定的 pluginId；读不到就跳过，
// 因为无 manifest 的目录无法与 enabledPlugins 的键对应。
// 同一 pluginId 只取首个（seenPluginIds）：官方缓存可能有多个版本目录，
// 全部保留会让同一技能出现多行且开关互相覆盖。
// [并发] 全程只读文件系统与 config，不写任何状态。
async function resolvePluginSkillRootDescriptors(): Promise<SkillRootDescriptor[]> {
  const config = readPluginConfigFromConfig(await readCliConfigFile());
  // 全局开关优先：plugins.enabled 为 false 时整段不产出任何插件根。
  if (!config.enabled) {
    return [];
  }

  // 缓存根由 storage.dir 派生，所有插件来源共用它，保证与 CLI 读到同一批目录。
  const pluginStorageRoot = resolvePluginStorageRoot(config.storageDir);
  // 官方缓存与 installed_plugins.json 是并存的两套来源，都要扫，缺一会漏技能。
  const officialCacheRoots = await scanOfficialPluginCacheRoots(pluginStorageRoot);
  // 已安装列表自带 marketplace 与启用默认值，由插件模块统一解析。
  const installedRoots = await readInstalledPluginRoots(pluginStorageRoot);
  // 候选顺序即优先级：手动登记 > 官方缓存 > 已安装列表，后两者同 id 时被 seenPluginIds 丢弃。
  const candidates: PluginRootCandidate[] = [
    ...config.dirs.map((dir) => ({
      // 手动登记的目录默认启用：用户显式写下就代表想用。
      defaultEnabled: true,
      // 市场名固定 inline，用于拼出稳定的 pluginId。
      marketplace: ZCODE_INLINE_PLUGIN_MARKETPLACE,
      // 配置里的路径可能带 ~ 或相对形式，先展开再交给 manifest 探测。
      rootPath: resolveConfigPath(dir),
    })),
    ...officialCacheRoots.map((rootPath) => ({
      // 官方缓存里的插件默认不启用，需显式开关或内置白名单才放行。
      defaultEnabled: false,
      marketplace: ZCODE_OFFICIAL_PLUGIN_MARKETPLACE,
      rootPath,
    })),
    // installedRoots 已是候选形状，直接展开，不再补 defaultEnabled。
    ...installedRoots,
  ];
  const descriptors: SkillRootDescriptor[] = [];
  // 去重键是 pluginId 而不是路径：同一插件多版本目录只取首个，避免同名技能出现多行。
  const seenPluginIds = new Set<string>();

  for (const candidate of candidates) {
    // 读 manifest 才能拿到稳定 pluginId，读不到说明该目录不是插件根。
    const manifest = await readPluginManifest(candidate.rootPath);
    if (!manifest) {
      continue;
    }
    // pluginId 由名字与市场拼成，既是配置键也是去重键，必须与 CLI 侧一字不差。
    const pluginId = `${manifest.name}@${candidate.marketplace}`;
    // 内置官方插件被「卸载」后只在 CLI config 写入 suppressedBuiltins；desktop 直接扫
    // 官方 cache 时不经过 CLI resolve 的过滤，需要在这里同样跳过，否则被卸载的内置插件
    // 仍会从 cache 贡献技能。
    if (
      candidate.marketplace === ZCODE_OFFICIAL_PLUGIN_MARKETPLACE &&
      config.suppressedBuiltins.includes(pluginId)
    ) {
      // 被卸载的内置插件不能从缓存复活，这里跳过与 CLI resolve 的过滤保持一致。
      continue;
    }
    // 同 id 已处理过（多版本或多来源），后续候选一律丢弃，保证技能只归属一次。
    if (seenPluginIds.has(pluginId)) {
      continue;
    }
    seenPluginIds.add(pluginId);
    // 候选默认值之外，内置白名单里的官方插件即使来自缓存也默认启用。
    const defaultEnabled =
      candidate.defaultEnabled || DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS.has(pluginId);
    // 用户显式开关优先于默认值；用 ?? 而不是 || 才能让显式 false 生效。
    const enabled = config.enabledPlugins[pluginId] ?? defaultEnabled;
    if (!enabled) {
      // 关闭的插件不产出技能根，继续检查后续候选而不是提前返回。
      continue;
    }
    // agent runtime 已经从 plugin manifest 注入 skillRoots，但 UI 的 skillsService
    // 之前只扫描内置官方 cache/手动目录，漏掉 marketplace installed_plugins.json 中的
    // 个人来源市场（claude-plugins-official、自建市场等）插件，导致插件详情页只有技能数量、没有技能名。
    for (const rootPath of resolvePluginSkillRoots({ manifest, rootPath: candidate.rootPath })) {
      descriptors.push({
        // scope 固定 plugin：删除与开关逻辑据此拒绝直接操作，必须走卸载插件。
        scope: "plugin",
        rootPath,
        // pluginName 供 UI 展示来源，pluginId 供配置匹配，两者都来自同一 manifest。
        pluginName: manifest.name,
        pluginId,
      });
    }
  }

  return descriptors;
}

// 发现主流程：workspace 各级根 + 可选用户根 + 插件根，统一去重后逐根扫描。
// 用户根受 includeUserSkills 控制：非 desktop 运行时没有稳定的用户主目录，
// 能力判断在 resolveCapabilities，本函数只执行传入的策略。
// 三条去重链依次生效：dedupeRoots（字符串）-> dedupeScanRootsByRealpath（实体）
// -> seenSkillPaths（逐个 SKILL.md 的 realpath），任何一条缺失都会产生重复项。
// [失败路径] 单个 SKILL.md 读取失败只产出一条 diagnostic 并继续，不中断整根。
// 结果排序固定为 name -> scope -> path，保证同一文件系统下输出稳定。
async function discoverSkills(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  includeUserSkills: boolean;
  provider: ZCodeProvider;
}): Promise<DiscoverResult> {
  // 第一层去重：同一路径可能来自多层 workspace 根，保留首次出现才能让 scope 归属稳定。
  const workspaceRoots = dedupeRoots(
    await resolveAncestorWorkspaceRoots(params.workspacePath),
  );
  // 这里就把 scope 绑到路径上，后续实体去重只保留字符串，归属靠 rootByPath 反查。
  const roots: SkillRootDescriptor[] = workspaceRoots.map((rootPath) => ({
    scope: "workspace" as const,
    rootPath,
  }));
  if (params.includeUserSkills) {
    // 用户级技能是全局资源，`.zcode/skills` 里只要存在一个技能就截断
    // `.agents/skills` 会导致外部 Agent 的全局技能在导入后从设置页消失。
    roots.push({
      scope: "user" as const,
      rootPath: getUserZcodeSkillRoot(),
    });
    // .zcode 根先入列：覆盖判定以它为准，顺序反了会让用户级兼容技能被误判为重复。
    roots.push({
      scope: "user" as const,
      rootPath: getUserAgentsSkillRoot(),
    });
  }
  // 插件根排最后：同名冲突时 workspace 与用户级优先，插件不会挤掉用户自己的技能。
  roots.push(...(await resolvePluginSkillRootDescriptors()));

  const diagnostics: SkillDiagnostic[] = [];
  const skills: SkillSummary[] = [];
  // 第三层去重：同一 SKILL.md 的实体路径只收录一次，软链场景下这是唯一可靠的判据。
  const seenSkillPaths = new Set<string>();
  // 仅为 .agents 覆盖判定预取一次 .zcode 的名字键；不扫用户根时给空集合，判定自然全 false。
  const userZcodeSkillNameKeys = params.includeUserSkills
    ? await collectSkillNameKeysInRoot(getUserZcodeSkillRoot())
    : new Set<string>();
  // 第二层去重：字符串去重后仍可能有两个根指向同一实体目录，这里按 realpath 合并。
  const scanRootPaths = await dedupeScanRootsByRealpath(roots.map((root) => root.rootPath));
  // 路径到 descriptor 的索引：去重后只剩路径，必须能查回 scope 与 plugin 信息。
  const rootByPath = new Map(roots.map((root) => [root.rootPath, root]));

  for (const rootPath of scanRootPaths) {
    const root = rootByPath.get(rootPath);
    // 理论上必然命中，判空只为收窄类型，避免后面读 root.scope 时抛错。
    if (!root) {
      continue;
    }
    // 根不存在是常态（用户没有该目录），探测后再遍历能少产生一条失败诊断。
    if (!(await exists(root.rootPath))) {
      continue;
    }

    // 遍历交给有界 walker：深度限制与 node_modules 跳过都在那里，错误转成 warning 诊断。
    const skillPaths = await collectSkillMarkdownPaths(root.rootPath, diagnostics);
    for (const skillPath of skillPaths) {
      if (
        await isUserAgentsSkillCoveredByZcode({
          skillPath,
          rootPath: root.rootPath,
          userZcodeSkillNameKeys,
        })
      ) {
        // 被 .zcode 同名覆盖的 .agents 技能直接丢弃，否则设置页会出现两行同技能。
        continue;
      }
      // 解析实体路径用于跨根去重；失败（断链）退回原路径，至少让该文件仍被尝试读取。
      const canonicalSkillPath = await realpath(skillPath).catch(() => skillPath);
      if (seenSkillPaths.has(canonicalSkillPath)) {
        // 同一实体已被更靠前的根收录，保留首份以保证 scope 与 plugin 归属稳定。
        continue;
      }
      seenSkillPaths.add(canonicalSkillPath);
      // realpath 之后目标可能已不存在，读取前再探测一次，跳过时不会产生额外异常。
      if (!(await exists(skillPath))) {
        continue;
      }
      let markdown: string;
      try {
        markdown = await readFile(skillPath, "utf-8");
      } catch (error) {
        // 单个文件读失败只报一条 warning 并继续，绝不中断整根扫描。
        diagnostics.push({
          code: "skill_read_failed",
          severity: "warning",
          message:
            error instanceof Error
              ? error.message
              : `Failed to read skill: ${skillPath}`,
          path: skillPath,
        });
        continue;
      }
      const parsed = readFrontmatter(markdown);
      // 目录名同时是兜底技能名与复制删除的目标目录名，先算好避免重复 dirname。
      const skillFolderName = basename(dirname(skillPath));

      // name 校验只要求非空；大小写/下划线等是其它 skill 生态的合法显示名，不应产出噪音诊断。
      // 缺少 frontmatter 的手写 skill 不应显示不可操作的诊断；用目录名兜底，metadata 字段留空。
      const rawName = parsed.hasFrontmatter ? parsed.name.trim() : skillFolderName;
      // frontmatter 写了空串时同样落回目录名，保证每个技能都有可展示的名称。
      const resolvedName = rawName || skillFolderName;
      if (!resolvedName) {
        // 目录名与 frontmatter 都为空才走到这里，此时无法生成稳定 id，只能报错跳过。
        diagnostics.push({
          code: "skill_missing_name",
          severity: "error",
          message: `Skill frontmatter must include a name: ${skillPath}`,
          path: skillPath,
        });
        continue;
      }

      // 无 frontmatter 时描述留空，不猜正文首段，避免把说明文本误当描述。
      const description = parsed.hasFrontmatter ? parsed.description.trim() : "";
      if (description.length > MAX_DESCRIPTION_LENGTH) {
        // 超长描述在注入层会被截断，这里提前拒绝并给出可操作诊断，而不是静默截断。
        diagnostics.push({
          code: "skill_description_too_long",
          severity: "error",
          message: `Skill description is too long (>${MAX_DESCRIPTION_LENGTH}): ${resolvedName}`,
          path: skillPath,
          skillName: resolvedName,
        });
        continue;
      }

      // frontmatter 扩展字段通常来自不同 skill 生态的元信息。
      // 这些字段不影响 ZCode 读取 name/description，继续报 warning 只会制造无操作价值的噪音。

      // 正文单独 trim 后原样保存，注入时按整段包裹，不再二次格式化。
      const body = parsed.body.trim();
      // metadata 是可选附加信息，读不到不影响该技能进入列表。
      const metadata = await readSkillMetadata(skillPath);
      skills.push({
        id: buildSkillId({
          provider: params.provider,
          // scope 取当前根归属，同一技能放在不同根会得到不同 id。
          scope: root.scope,
          name: resolvedName,
          path: canonicalSkillPath,
        }),
        name: resolvedName,
        description,
        body,
        // SkillSummary.path 之前存的是技能目录，前端在生成 skill mention 链接时拿不到标准文件路径，
        // 最终只能得到 `[$skill](.../skill-dir)` 这种不完整引用。这里直接返回 `SKILL.md` 文件路径，
        // 让 UI、日志和后续技能跳转都能共享同一份标准定位信息。
        path: canonicalSkillPath,
        // 原始扫描路径（未 realpath）。软链技能删除时用它定位链接本体，避免误删目标目录。
        sourcePath: skillPath,
        scope: root.scope,
        // 这里先占位 true，真实开关由 list 里的 attachEnabledState 按 config 覆盖。
        enabled: true,
        // 插件字段用条件展开：非插件根不产生空串字段，前端无需判空。
        ...(root.pluginName ? { pluginName: root.pluginName } : {}),
        ...(root.pluginId ? { pluginId: root.pluginId } : {}),
        // metadata 缺失时不带该字段，保持 SkillSummary 形状最小。
        ...(metadata ? { metadata } : {}),
      });
    }
  }

  skills.sort((left, right) => {
    // 第一排序键是展示名，保证设置页顺序与文件系统遍历顺序无关。
    const byName = left.name.localeCompare(right.name);
    if (byName !== 0) {
      return byName;
    }
    // 同名时按 scope 分组，用户、工作区与插件的同名技能不会交错。
    const byScope = left.scope.localeCompare(right.scope);
    // 最后用路径兜底，保证全序，每次输出完全一致。
    return byScope !== 0 ? byScope : left.path.localeCompare(right.path);
  });

  return { skills, diagnostics };
}

// 复用共享的有界遍历（深度限制、跳过 node_modules、软链 realpath 去重），
// 避免在 Windows junction 或巨型依赖目录上把一次扫描放大到数十秒。
// [失败路径] onError 把遍历错误转成 warning 诊断而不是抛出，
// 让「部分目录不可读」与「整次发现失败」区分开。
// 结果再排序一次：遍历顺序依赖文件系统，排序后诊断与技能列表才可复现。
async function collectSkillMarkdownPaths(
  rootPath: string,
  diagnostics: SkillDiagnostic[],
): Promise<string[]> {
  // 复用共享的有界遍历：支持分组目录，但排除 node_modules 等内容目录、限制深度、对软链按 realpath 去重，
  // 避免 Windows junction / 巨型依赖目录把单次扫描放大到数十秒。
  const discovered = new Set<string>();
  // walker 可能对同一文件产出多次（软链重复），Set 在收集阶段先做一次去重。
  for await (const skillPath of walkSkillMarkdownPaths(rootPath, {
    onError: (path, error) => {
      // 遍历错误降级成 warning 诊断，部分目录不可读不应让整次发现失败。
      diagnostics.push({
        code: "skill_scan_failed",
        severity: "warning",
        message:
          error instanceof Error
            ? error.message
            : `Failed to scan skill directory: ${path}`,
        // 记录出错的具体路径，UI 才能提示用户修哪一个目录。
        path,
      });
    },
  })) {
    discovered.add(skillPath);
  }
  // 排序消除文件系统遍历顺序差异，让诊断与技能列表可复现。
  return [...discovered].sort((left, right) => left.localeCompare(right));
}

// 用户级技能只在 desktop 运行时可用：Web/远端服务没有「当前用户主目录」语义，
// 强行扫描会读到服务账户的技能并暴露给所有连接方。
// 判定优先用显式 options，其次看 ZCODE_PROCESS_LABEL 环境变量；
// 缺省为不可用（fail-closed），避免忘记传参时意外放开用户目录。
// 返回 userScopeReason 是为了让 UI 能解释「为什么看不到用户技能」。
function resolveCapabilities(options?: SkillsServiceOptions): SkillsCapability {
  const isDesktopRuntime =
    options?.isDesktopRuntime ?? Boolean(process.env.ZCODE_PROCESS_LABEL);
  if (isDesktopRuntime) {
    // 只有 desktop 有稳定用户主目录，此时才允许扫用户级技能根。
    return { userScopeAvailable: true };
  }
  // 缺省 fail-closed：未显式声明就当作没有用户根，避免 Web 端读到服务器账户的技能。
  return { userScopeAvailable: false, userScopeReason: "desktop_only" };
}

// 把持久化的关闭态贴到技能对象上：默认 true，只有 config 里显式 false 才关闭。
// 键必须与写入侧同源归一化，否则 Windows 反斜杠路径永远命中不了，
// 表现为「关掉的技能刷新后又开了」。
// 返回新对象而不改原数组：discoverSkills 的结果可能被同一次请求的多处复用。
function attachEnabledState(
  skills: SkillSummary[],
  enabledByPath: Record<string, boolean>,
): SkillSummary[] {
  return skills.map((skill) => ({
    // 浅拷贝而不是原地改：discoverSkills 的结果可能被同一次请求的多处复用。
    ...skill,
    // 键与写入侧同源归一化；命中不了就默认 true，表现为「关掉的技能刷新后又开了」。
    enabled: enabledByPath[normalizeSkillConfigPath(skill.path)] ?? true,
  }));
}

// writeQueue 是模块内的串行队列：setEnabled 需要「读全量 config -> 改一项 -> 写回」，
// 并发执行时后写者会基于旧快照覆盖先写者的结果，用户的两次点击只有一次生效。
// [并发] 队列只保护写路径；list 不加锁，允许与写并发（读到旧值是短暂且可接受的）。
// 队列上保存的是「已吞掉错误」的派生 Promise（见 setEnabled），
// 保证一次写失败不会让后续所有写入卡在 rejected 链上。
// provider 目前固定为 glm：id 需要它，但接口仍保留参数以免调用方误以为可切换。
export function createSkillsService(options?: SkillsServiceOptions): ISkillsService {
  let writeQueue = Promise.resolve();

  return {
    async list(params: {
      workspacePath: string;
      workspaceIdentity?: string;
      provider?: ZCodeProvider;
    }): Promise<SkillsListResult> {
      // 能力先算：它决定是否扫用户根，必须在 discoverSkills 之前确定。
      const capability = resolveCapabilities(options);
      // provider 固定 glm：id 需要它，接口保留参数只是兼容调用方。
      const provider = "glm";
      // 每次 list 都重新扫描，不复用缓存，避免用户新增目录后列表不更新。
      const { skills: discovered, diagnostics } = await discoverSkills({
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
        includeUserSkills: capability.userScopeAvailable,
        provider,
      });
      // 开关状态在扫描之后再读，尽量缩短与 CLI 写操作的时间差。
      const enabledByPath = await readSkillEnabledMap();
      return {
        // 状态贴在副本上，discovered 原数组保持「全部默认启用」的干净形态。
        skills: attachEnabledState(discovered, enabledByPath),
        capability,
        // diagnostics 原样透出，前端据此判断「是否扫全」。
        diagnostics,
      };
    },

    async setEnabled(params: {
      workspacePath: string;
      workspaceIdentity?: string;
      provider?: ZCodeProvider;
      scope?: SkillScope;
      skillId: string;
      enabled: boolean;
    }): Promise<void> {
      const runUpdate = async () => {
        // 与 list 用同一 provider，保证 buildSkillId 结果一致，否则 find 永远匹配不到。
        const provider = "glm";
        // 重新算能力：开关操作必须遵守与 list 相同的用户根策略。
        const capability = resolveCapabilities(options);
        // 每次写前重新扫描：id 含路径哈希，不能只按调用方传来的 id 做局部修改。
        const { skills } = await discoverSkills({
          workspacePath: params.workspacePath,
          workspaceIdentity: params.workspaceIdentity,
          includeUserSkills: capability.userScopeAvailable,
          provider,
        });
        // 用完整 id 匹配定位技能，id 是 provider、scope、name 与路径哈希的唯一组合。
        const skill = skills.find((item) => item.id === params.skillId);
        if (!skill) {
          // 扫不到说明调用方持有过期 id（技能已删除或路径变化），明确报错而不是静默忽略。
          throw new Error(`Skill not found: ${params.skillId}`);
        }
        // 读全量开关再改一项：config 里还有其它技能的键，必须整份写回。
        const enabledByPath = await readSkillEnabledMap();
        // 路径归一化与读取侧一致，否则写入的键和后续读取对不上。
        enabledByPath[normalizeSkillConfigPath(skill.path)] = params.enabled;
        await writeSkillEnabledMap(enabledByPath);
      };

// 两个参数都传 runUpdate：无论前一次成功还是失败，本次都必须执行；
// 只写 then(runUpdate) 会让一次失败后整个队列永久短路。
// writeQueue 保存 catch 后的版本，await 的仍是原始 queued——
// 这样调用方能看到本次的真实错误，而队列本身保持可用。
      const queued = writeQueue.then(runUpdate, runUpdate);
      // 队列存 catch 后的版本：吞掉错误保证后续写入仍能排队，避免一次失败后永久短路。
      writeQueue = queued.catch(() => {});
      // 但对外 await 的仍是原始 queued，调用方能拿到本次的真实错误。
      await queued;
    },

    async buildPromptContext(params: {
      workspacePath: string;
      workspaceIdentity?: string;
      provider?: ZCodeProvider;
      prompt: string;
    }): Promise<SkillsPromptContext> {
      // 先做一次廉价的正则匹配：没有 $name 就直接返回，避免触发整次技能扫描。
      const mentionedSkillNames = collectMentionedSkillNames(params.prompt);
      if (mentionedSkillNames.size === 0) {
        // 无显式提及时原样返回 prompt，注入层无需再判空。
        return { prompt: params.prompt, activatedSkillNames: [] };
      }

      // 复用 list 而不是单独扫描：开关状态与 UI 列表必须来自同一份结果。
      const { skills } = await this.list({
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
        provider: params.provider,
      });
      // 两个条件同时成立才注入：既被显式提到，又处于启用态；名字按原样比对，不做归一化。
      const activatedSkills = skills.filter(
        (skill) => skill.enabled && mentionedSkillNames.has(skill.name),
      );
      if (activatedSkills.length === 0) {
        // 全部被关闭或名字不匹配时不注入，避免出现空标签污染 prompt。
        return { prompt: params.prompt, activatedSkillNames: [] };
      }

      const activatedSkillNames = activatedSkills.map((skill) => skill.name);
      // 技能目录是可见资源，但不能在每次 session 发送时全量注入。
      // 只有用户在 prompt 中显式提到且当前启用的技能才进入上下文，避免技能状态从 UI 列表泄漏到 agent 核心 session。
      // 先落审计再返回：审计写失败会向上抛，调用方能感知可观测性故障。
      await appendSkillsAuditLog({
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
        activatedSkillNames,
      });
      return {
        // 注入块追加在用户 prompt 之后，原始输入始终排在最前面。
        prompt: `${params.prompt}\n\n${buildActivatedSkillsPromptBlock(activatedSkills)}`,
        // 返回实际注入的名字，供上层记录与去重。
        activatedSkillNames,
      };
    },

    async copyToCommon(params: {
      workspacePath: string;
      workspaceIdentity?: string;
      skillId: string;
    }): Promise<{ newPath: string }> {
      // 从所有 provider 扫描结果中找目标 skill（list 已经扫过全量路径）
      // 走 list 而不是再扫一遍：开关与 scope 信息都在这份结果里，与 UI 完全同源。
      const { skills } = await this.list({
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
      });
      // id 完整匹配才能保证复制的是用户看到的那一项，而非同名副本。
      const skill = skills.find((s) => s.id === params.skillId);
      if (!skill) {
        throw new Error(`Skill not found: ${params.skillId}`);
      }
      // 复制的最小单位是技能目录，所以从 SKILL.md 路径上取 dirname。
      const sourceDir = dirname(skill.path);
      // 通用目录根据 skill 原 scope 确定 user 还是 workspace 级
// 通用目录按原 scope 决定目标：workspace 技能复制到工作区 `.zcode/skills`，
// user/plugin 技能复制到用户级根——插件技能被复制后变成 user 技能，
// 这是「从插件取一份可编辑副本」的唯一语义，不会反向写回插件目录。
// [失败路径] 目标同名目录已存在时直接抛错，不合并、不覆盖。
      const commonRoot =
        skill.scope === "workspace"
          ? getWorkspaceZcodeSkillRoot(params.workspacePath)
          : getUserZcodeSkillRoot();
      // 目标目录名沿用源目录名：目录名决定兜底技能名，改名会让复制后的技能 id 变化。
      const targetDir = join(commonRoot, basename(sourceDir));
      // 不覆盖已有目录
      if (await exists(targetDir)) {
        // 已存在时抛错而不是合并：合并会混合两个来源的正文，结果无法预期。
        throw new Error(`通用目录已存在同名技能: ${basename(sourceDir)}`);
      }
      // 首次复制时通用根可能还不存在，recursive 一并建出父目录。
      await mkdir(commonRoot, { recursive: true });
      // recursive:true 才能整目录复制，references、assets 等子目录会被保留。
      await cp(sourceDir, targetDir, { recursive: true });
      // 返回标准 SKILL.md 路径而不是目录，与 SkillSummary.path 保持同一形状。
      return { newPath: join(targetDir, SKILL_FILE_NAME) };
    },

    async removeFromCommon(params: {
      workspacePath: string;
      workspaceIdentity?: string;
      skillId: string;
    }): Promise<void> {
      const { skills } = await this.list({
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
      });
      // 只有 id 命中才能确定待删目录，找不到说明调用方持有过期 id。
      const skill = skills.find((s) => s.id === params.skillId);
      if (!skill) {
        throw new Error(`Skill not found: ${params.skillId}`);
      }
// 用「小写 + 正斜杠」的形式做包含判定：Windows 路径大小写不敏感，
// 且分隔符两种形态都可能出现；不归一化会让合法技能被判为「不在通用目录」。
// 判定用的是 skill.path（realpath 后），而删除用的是 sourcePath（未解析），
// 两者不一致是刻意的：前者用于归属判断，后者用于定位要删的目录项。
      const normalizedPath = skill.path.replaceAll("\\", "/").toLowerCase();
      // 两个受控根同样归一化：形态与 normalizedPath 一致才可能被 includes 命中。
      const userCommonRoot = getUserZcodeSkillRoot().replaceAll("\\", "/").toLowerCase();
      const workspaceCommonRoot = getWorkspaceZcodeSkillRoot(params.workspacePath)
        .replaceAll("\\", "/")
        .toLowerCase();
// 用 `${root}/` 带尾斜杠比较，避免 /a/skills-extra 被 /a/skills 前缀误判。
// 只做包含而非 startsWith：用户根与工作区根可能互为前缀（嵌套 workspace），
// 任一命中即视为通用目录技能，删除才允许继续。
// [失败路径] 两个都未命中时抛错，宁可不删也不能删到插件或外部目录。
      const inUserCommon = normalizedPath.includes(`${userCommonRoot}/`);
      const inWorkspaceCommon = normalizedPath.includes(`${workspaceCommonRoot}/`);
      if (!inUserCommon && !inWorkspaceCommon) {
        // 两者都未命中说明技能来自插件或外部目录，拒绝删除以免越过受控范围。
        throw new Error("该技能不在通用目录中");
      }
      // 删除整个技能目录；force 让并发删除同一目录时不因 ENOENT 失败。
      await rm(dirname(skill.path), { recursive: true, force: true });
    },

    async deleteSkill(params: {
      workspacePath: string;
      workspaceIdentity?: string;
      skillId: string;
    }): Promise<void> {
      const { skills } = await this.list({
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
      });
      // 与 removeFromCommon 相同：先按完整 id 定位，避免误删同名技能。
      const skill = skills.find((s) => s.id === params.skillId);
      if (!skill) {
        throw new Error(`Skill not found: ${params.skillId}`);
      }
      // plugin 作用域的技能由其所属插件管理，应通过卸载插件移除，这里拒绝单独删除。
      if (skill.scope === "plugin") {
        throw new Error("插件提供的技能不可单独删除，请卸载对应插件");
      }

      // 用发现阶段命中的原始路径（sourcePath，未 realpath）定位技能目录项。
      // 软链导入的技能 skill.path 是 realpath 后的目标文件，dirname 会指向目标目录；
      // sourcePath 才指向 `~/.zcode/skills/<name>` 下的目录项本身。
      const skillDir = dirname(skill.sourcePath ?? skill.path);
      // 叶子名单独取出，后面与 realpath 后的父目录重新拼接。
      const skillLeafName = basename(skillDir);
      // 只解析父目录，不解析叶子本身：
      // - 叶子若是软链（正常导入场景），保持不解析，删除时才只删链接、不动目标；
      // - 父目录 realpath 后，任何“软链/junction 祖先”都会被展开到真实位置，
      //   随后越界校验就能拦住“经由祖先软链删到受控根之外”的数据丢失路径。
      const canonicalParent = await realpath(dirname(skillDir)).catch(() => null);
      if (!canonicalParent) {
        // 父目录解析失败（已被删除或断链）时无法校验归属，宁可拒绝删除。
        throw new Error(`该技能不可删除: ${skill.path}`);
      }

      // 安全护栏：删除是 `rm -rf` 目录的破坏性操作，仅允许命中受控技能根。
      // 收集工作区各层级（沿 worktree 向上）的 .zcode/skills 与 .agents/skills，外加用户级两根。
      const allowedRootCandidates = await resolveAncestorWorkspaceRoots(params.workspacePath);
      // 用户级两根也要入列，否则用户目录下的技能永远无法删除。
      allowedRootCandidates.push(getUserZcodeSkillRoot());
      allowedRootCandidates.push(getUserAgentsSkillRoot());

      // 用 realpath 后的父目录与 realpath 后的根比较：父目录必须落在（或等于）某个受控根内。
      // 两侧都 realpath，`/tmp`→`/private/tmp` 这类系统软链会在两侧抵消，不会误判越界。
      let contained = false;
      for (const root of allowedRootCandidates) {
        // 根不存在时 realpath 会失败，退回原串；不存在的根会被下面的 relative 判定自然排除。
        const canonicalRoot = await realpath(root).catch(() => root);
        // relative 按路径段计算，避免 /a/skills-extra 被前缀判定误认为 /a/skills 之内。
        const relativePath = relative(canonicalRoot, canonicalParent);
        // 父目录等于根（叶子直接位于根下）也是合法的常见场景，故允许 "".
        if (
          relativePath === "" ||
          (!relativePath.startsWith("..") && !isAbsolute(relativePath))
        ) {
          contained = true;
          // contained 命中任一受控根即可放行，无需继续比较其余 root。
          break;
        }
      }

      if (!contained) {
        // 父目录不在任何受控根内，说明技能经由外部目录或软链祖先指向别处，拒绝递归删除。
        throw new Error(`该技能不可删除: ${skill.path}`);
      }
      // 删除 `<真实父目录>/<叶子名>`：父目录已是真实路径，不会经由祖先软链穿越；
      // 叶子仍是原目录项，是软链就只删链接、是普通目录就整目录删除。
      await rm(join(canonicalParent, skillLeafName), {
        recursive: true,
        force: true,
      });
    },
  };
}

// 仅供测试/调试，便于在 vitest 里直接 fixture 出诊断结果。
export const __INTERNAL__ = {
  discoverSkills,
  readFrontmatter,
  MAX_DESCRIPTION_LENGTH,
};
