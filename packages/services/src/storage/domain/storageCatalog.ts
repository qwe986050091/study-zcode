/**
 * 存储分类目录：把 .zcode 根下的相对路径映射到类别、聚合 key 与可清理性。
 * 纯函数、单一事实源。
 * 匹配顺序：根级特例 → 文件规则（精确）→ 前缀规则（最长前缀优先）→ 其他。
 */
// INV-01：分类是全函数——任何路径都落到某个类别，永不返回 undefined（守住位置：classifyStoragePath 末尾兜底）。
// INV-02：优先级固定为 根级特例 → 文件规则 → 最长前缀；顺序变了分类会静默漂移且无报错（守住位置：三个匹配循环）。
// INV-03：可清理性只由类别决定，与具体路径、大小、时间无关（守住位置：CLEANABILITY 表）。
// INV-04：受保护文件即便落在可清理类别里也不得删除（守住位置：isProtectedStoragePath 及其调用侧）。
// 破坏 INV-02 最危险：v2/config.json.pre-xxx 会先命中泛化的 config 规则，备份被当配置保留、配置被当备份删除。
import type { StorageCategoryId, StorageCleanability, StorageRootId } from "@zcode/shared";

// rootId 与 hasCustomDataBaseDir 共同决定「同名目录是新数据还是迁移残留」：
// 缺后者时，启用自定义数据目录后 home 下的旧 v2 会被当成活跃数据并提供清理，
// 而回滚路径仍指向它。
export interface StorageCatalogContext {
  rootId: StorageRootId;
  hasCustomDataBaseDir: boolean;
}

// entryKey 是明细聚合粒度：同一 key 的多条路径在 UI 合并成一行，
// 因此它必须稳定且不含用户可变的层级。
export interface StorageClassification {
  categoryId: StorageCategoryId;
  /** 下钻明细的聚合 key：规则命中路径的下一级。 */
  entryKey: string;
}

/** 清理时需要枚举的范围；recursive=false 表示只看该目录直接子项（用于文件规则）。 */
export interface StorageCleanScope {
  prefix: string;
  recursive: boolean;
}

// [权衡] 可清理性做成静态表而非按路径计算：清理不可逆，任何「按大小/时间动态判断」
// 都会让同一条路径在不同时刻可删性不同，用户无法预判。
// none 表示完全不出现在清理候选；confirm 表示需二次确认；safe 可直接删。
// 新增类别必须同步补这张表，缺失会让该类别在运行时拿到 undefined。
const CLEANABILITY: Record<StorageCategoryId, StorageCleanability> = {
  sessionStore: "none",
  // 只有 subagent 的 transcript.jsonl 可删；其余工具输出与临时缓存暂不可删。
  subagentTranscripts: "safe",
  toolOutputs: "none",
  modelTrajectory: "safe",
  devTraces: "safe",
  logs: "safe",
  backups: "confirm",
  exports: "safe",
  runtimes: "none",
  config: "none",
  other: "none",
};

// entryKeySegments 用于「一条规则命中大量单文件」的场景（如每个会话的 transcript）：
// 截断到会话目录层，才能把同会话的文件聚成一行。
interface FileRule {
  categoryId: StorageCategoryId;
  pattern: RegExp;
  /** 聚合 key 取路径前 N 段（缺省用完整路径）。 */
  entryKeySegments?: number;
}

/** 文件级规则：按顺序求值，先命中先生效（备份/缓存要排在泛化的 config 之前）。 */
// [权衡] 顺序敏感：精确文件名规则必须排在泛化的 /^v2/[^/]+.json$/ 之前，
// 否则 config.json.pre-xxx 会被当成 config 而非 backups。
const FILE_RULES: FileRule[] = [
  // subagent 运行记录（单文件可达数十 MB），按会话目录聚合
  {
    categoryId: "subagentTranscripts",
// transcript.jsonl 单文件可达数十 MB，是占用统计与全量导出的主要来源；
// 聚合到 3 段（cli/agents/<session>）后，删除时以会话目录为单位。
    pattern: /^cli\/agents\/[^/]+\/[^/]+\/transcript\.jsonl$/,
    entryKeySegments: 3,
  },
  { categoryId: "sessionStore", pattern: /^v2\/[^/]+\.sqlite(?:-wal|-shm)?$/ },
  { categoryId: "sessionStore", pattern: /^cli\/db\/db\.sqlite(?:-wal|-shm)?$/ },
  { categoryId: "toolOutputs", pattern: /^v2\/checkpoints\/(?:.+\/)?(?:pending|tmp)\// },
  { categoryId: "backups", pattern: /^cli\/db\/db\.sqlite\.[^/]+$/ },
  { categoryId: "backups", pattern: /^cli\/config\.json\.bak[^/]*$/ },
  { categoryId: "backups", pattern: /^v2\/[^/]+\.bak$/ },
  { categoryId: "backups", pattern: /^v2\/[^/]+\.backup\.json$/ },
  { categoryId: "backups", pattern: /^v2\/setting\.json\.(?:corrupt-|[^/]*backup)[^/]*$/ },
  { categoryId: "backups", pattern: /^v2\/config\.json\.pre-[^/]+$/ },
  { categoryId: "toolOutputs", pattern: /^v2\/coding-plan-cache\.json$/ },
  // Bot 历史缓存仅供资源管理器识别展示，不加载配置或启动渠道。
  { categoryId: "toolOutputs", pattern: /^v2\/bots-model-cache[^/]*\.json$/ },
  { categoryId: "logs", pattern: /^computer-use\/run\/[^/]+\.log$/ },
  { categoryId: "config", pattern: /^v2\/[^/]+\.json$/ },
  { categoryId: "config", pattern: /^cli\/config\.json$/ },
  { categoryId: "config", pattern: /^agents\/[^/]+\.md$/ },
  { categoryId: "config", pattern: /^AGENTS\.md$/ },
];

/** 前缀规则：值为相对根的目录前缀，命中最长者。 */
const PREFIX_RULES: Record<Exclude<StorageCategoryId, "other">, string[]> = {
  sessionStore: ["v2/sessions", "v2/session-bindings", "v2/checkpoints"],
  // transcript.jsonl 由上面的文件规则先命中，其余 cli/agents 内容留在这里
  subagentTranscripts: [],
  toolOutputs: [
    "cli/artifacts",
    "cli/agents",
    "cli/sessions",
    "cli/exec",
    "cli/image-cache",
    "cli/pdf-cache",
    "clipboard",
    "git-checkpoint-index",
    "editor-icon",
    "tmp",
    "cache",
  ],
  modelTrajectory: ["cli/debug", "cli/rollout"],
  devTraces: ["v2/dev", "v2/acp-traffic-proxy", "v2/acp-stream-diagnostics"],
  logs: ["v2/logs", "cli/log", "logs", "v2/crash", "v2/perf", "feedback/logs"],
  backups: ["backup", "v2/backup", "v2/migrations", "cli/db/backup", "cli/db/backups"],
  exports: ["export-log", "export-log-stage", "feedback"],
  runtimes: ["agents", "bundled-agents", "lite", "computer-use", "cli/plugins"],
  // cli/plugins 整体（含 cache）不可清理，插件缓存归运行时。
  config: [
    "v2/agent-config",
    "v2/bots-runtime-locks",
    "v2/bot-attachments",
    "v2/certs",
    "v2/acp-auth",
    "v2/acp-config",
    "v2/provider",
    "cli/models",
    "cli/memories",
    "cli/workflows",
    "security",
    "commands",
    "skills",
    "workflows",
    "workspace",
    "mailbox",
    "server",
    "controller",
    "launcher",
    "dev-signing",
    "cua-helper-dev-identity",
    "perf-task-manifests",
    "plugin-workspace",
    "projects",
  ],
};

// [权衡] 前缀表在模块加载时展开并按长度降序排列，而不是分类时临时比较：
// 分类跑在目录枚举热路径上（一次可能上万条），预排序把每次比较降为线性扫描；
// 代价是新增前缀必须重启生效，本文件没有热更新需求。
const PREFIX_INDEX: Array<{ prefix: string; categoryId: StorageCategoryId }> = Object.entries(
  PREFIX_RULES,
)
  .flatMap(([categoryId, prefixes]) =>
    prefixes.map((prefix) => ({ prefix, categoryId: categoryId as StorageCategoryId })),
  )
  .sort((a, b) => b.prefix.length - a.prefix.length);

// [失败路径] 保护名单是最后一道闸：即便分类把凭据误判进可清理类别，
// isProtectedStoragePath 仍会拦住删除；名单只放「删了就无法启动或无法鉴权」的文件。
/** 任何类别下都不能删除的文件：启动引导文件、凭据、Helper broker 凭据、诊断开关、活动崩溃现场。 */
const PROTECTED_BASENAMES = new Set([
  "setting.json",
  "setting.json.lock",
  "credentials.json",
  ".credentials.json",
  ".tokens",
  "zcode-stdio-tap.json",
]);
const PROTECTED_PREFIXES = ["v2/crash/live"];

// 统一分隔符并去掉首尾斜杠：Windows 路径原样进入正则时，
// 所有以 / 锚定的规则都会失配，路径被静默归入 other。
export function normalizeStorageRelativePath(relativePath: string): string {
  return relativePath.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

// 边界必须是「等于或后接 /」：直接 startsWith 会让 v2/session 命中 v2/sessions，
// 类别与清理范围一起错。
function isUnderPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

function entryKeyBelow(path: string, prefix: string): string {
  const rest = path.slice(prefix.length + 1);
  const next = rest.split("/")[0];
  return next ? `${prefix}/${next}` : prefix;
}

// 分类入口只做三步：归一化 → 按固定优先级匹配 → 兜底 other；
// 新增规则必须插进对应优先级段内，不能追加到末尾（INV-02）。
export function classifyStoragePath(
  rawPath: string,
  context: StorageCatalogContext,
): StorageClassification {
  const path = normalizeStorageRelativePath(rawPath);
  // 启用自定义数据路径后，home 根下的 v2 是迁移遗留的旧副本，整体归「其他」，不提供清理。
// [权衡] 自定义数据目录生效后，home 下的 v2 是迁移遗留副本：
// 不归 other 会让用户可以删掉它，而升级回滚路径仍指向这里。
  if (context.rootId === "home" && context.hasCustomDataBaseDir && isUnderPrefix(path, "v2")) {
    return { categoryId: "other", entryKey: "v2" };
  }
  // agent/ 是 ACP 时代残留，当前代码无写入方，同样归「其他」。
// agent/ 是 ACP 时代目录，当前无写入方；保留分类只为让旧安装的残留可见但不可删。
  if (isUnderPrefix(path, "agent")) {
    return { categoryId: "other", entryKey: "agent" };
  }
// 文件规则先于前缀规则：同一路径可能前缀命中 v2/ 又文件命中 v2/xxx.json，
// 文件名比目录更能表达语义。
  for (const rule of FILE_RULES) {
    if (rule.pattern.test(path)) {
      const entryKey = rule.entryKeySegments
        ? path.split("/").slice(0, rule.entryKeySegments).join("/")
        : path;
      return { categoryId: rule.categoryId, entryKey };
    }
  }
  for (const { prefix, categoryId } of PREFIX_INDEX) {
    if (isUnderPrefix(path, prefix)) {
      return { categoryId, entryKey: entryKeyBelow(path, prefix) };
    }
  }
// [失败路径] 兜底用首段做 key，空路径退回原值，保证 INV-01：
// 调用方永远拿到字符串 key，无需判空。
  return { categoryId: "other", entryKey: path.split("/")[0] ?? path };
}

export function getStorageCategoryCleanability(categoryId: StorageCategoryId): StorageCleanability {
  return CLEANABILITY[categoryId];
}

export function isProtectedStoragePath(rawPath: string): boolean {
  const path = normalizeStorageRelativePath(rawPath);
  const basename = path.split("/").at(-1) ?? path;
  if (PROTECTED_BASENAMES.has(basename)) return true;
  return PROTECTED_PREFIXES.some((prefix) => isUnderPrefix(path, prefix));
}

/** 文件规则所在的目录：清理时只需非递归枚举这些目录。 */
const FILE_RULE_SCOPES: Partial<Record<StorageCategoryId, string[]>> = {
  backups: ["cli/db", "cli", "v2"],
  logs: ["computer-use/run"],
};
/** 只靠文件规则、且需要递归枚举的类别：候选按分类过滤后只剩命中文件规则的路径。 */
const RECURSIVE_FILE_RULE_SCOPES: Partial<Record<StorageCategoryId, string[]>> = {
  subagentTranscripts: ["cli/agents"],
};

export function getStorageCleanScopes(categoryId: StorageCategoryId): StorageCleanScope[] {
  if (categoryId === "other" || CLEANABILITY[categoryId] === "none") return [];
  const recursive = [
    ...PREFIX_RULES[categoryId],
    ...(RECURSIVE_FILE_RULE_SCOPES[categoryId] ?? []),
  ].map((prefix) => ({ prefix, recursive: true }));
  const shallow = (FILE_RULE_SCOPES[categoryId] ?? []).map((prefix) => ({
    prefix,
    recursive: false,
  }));
  return [...recursive, ...shallow];
}
