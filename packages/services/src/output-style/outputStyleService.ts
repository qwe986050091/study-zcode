// 【定位】输出风格服务：读写 ~/.claude/output-styles 下的 .md 与 ~/.claude/settings.json，
// 内置三种风格常驻，自定义风格扫目录，合并后按激活 id 标记 enabled。
// INV-01：内置风格只由 BUILT_IN_STYLES 定义，不依赖磁盘；改从文件推导会让
//   settings.json 缺失时列表整体为空，UI 选择器塌陷。
// INV-02：enabled 每次现算、不持久化；否则切换激活要改两处记录，中途失败出现双激活。
// INV-03：自定义 id 固定 custom-<文件名>，改/删必须剥前缀，剥错会写到 <id>.md
//   剥错后写入的是 <id>.md 而不是 custom-<id>.md，原文件因此永远不再被更新。
import type { OutputStyle, OutputStyleConfig } from "@zcode/shared";
import type { IOutputStyleService } from "./outputStyle.js";
import { access, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// 回退值用字面量而非 BUILT_IN_STYLES[0].id：常量块可能重排，字面量保证 settings 缺失时稳定。
const DEFAULT_OUTPUT_STYLE = "default";
const SETTINGS_FILE = "settings.json";

// 内置顺序即 UI 展示顺序；content 留空表示正文由系统提示词提供，不落 markdown。
// default 的 enabled 只是静态初值，listStyles 会按 settings 重算并覆盖。
// [权衡] 不预置这几个 .md：预置会与用户同名文件冲突，升级还要合并用户改动。
const BUILT_IN_STYLES: OutputStyle[] = [
  {
    id: "default",
    name: "Default",
    description:
      "Completes coding tasks efficiently and provides concise responses",
    content: "",
    isBuiltIn: true,
    enabled: true,
  },
  {
    id: "explanatory",
    name: "Explanatory",
    description:
      "Explains implementation choices and codebase patterns",
    content: "",
    isBuiltIn: true,
    enabled: false,
  },
  {
    id: "learning",
    name: "Learning",
    description:
      "Pauses and asks you to write small pieces of code for hands-on practice",
    content: "",
    isBuiltIn: true,
    enabled: false,
  },
];

// HOME 优先于 USERPROFILE：Git Bash/WSL 下二者可能不同，用户真实配置通常在 HOME；
// 都为空（服务/容器）才回退 os.homedir()，空串不能参与拼接，否则会得到 /.claude。
function resolveUserHomeDir(): string {
  const envHome = process.env.HOME?.trim() || process.env.USERPROFILE?.trim();
  return envHome && envHome.length > 0 ? envHome : homedir();
}

// 与 Claude 客户端共用同一目录：改成私有目录会让用户已有风格在两边互不可见。
function getUserOutputStylesDir(): string {
  return join(resolveUserHomeDir(), ".claude", "output-styles");
}

// 共享文件：本服务只增改 outputStyle 键，其余键必须原样保留（见写回逻辑）。
function getUserClaudeSettingsPath(): string {
  return join(resolveUserHomeDir(), ".claude", SETTINGS_FILE);
}

// 索引签名保留未知键：写回时展开 existingSettings 才不会丢掉 hooks 等用户配置。
interface ClaudeSettingsConfig {
  outputStyle?: string;
  hooks?: unknown;
  [key: string]: unknown;
}

/**
 * Read JSON file safely
 */
// [失败路径] 读失败统一返回 null：文件缺失是首次启动的正常态，JSON 损坏按无配置处理，
// 让调用方走默认值而不是让整个列表加载失败；写路径必须抛错，二者语义不能合并。
async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    // 先 existsSync 再 readFile：文件不存在时不必走一次必然抛 ENOENT 的系统调用，
    // 也不会把「首次启动」的常态记进 console.error。
    if (!existsSync(filePath)) {
      return null;
    }
    const content = await readFile(filePath, "utf-8");
    // 解析结果直接 as T：settings.json 是用户可手改的文件，字段缺失由调用方按可选处理。
    return JSON.parse(content) as T;
  } catch (error) {
    console.error(`Failed to read JSON file ${filePath}:`, error);
    return null;
  }
}

/**
 * Write JSON file safely
 */
// 写失败向外抛：激活状态未落盘时返回成功会让 UI 与实际行为不一致；非原子写在
// 这里可接受，损坏后 readJsonFile 会回退默认值。
async function writeJsonFile<T>(filePath: string, data: T): Promise<void> {
  try {
    // 2 空格缩进是刻意的：settings.json 用户会手改，压成一行会让 diff 与人工编辑都不可读。
    await writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
  } catch (error) {
    console.error(`Failed to write JSON file ${filePath}:`, error);
    // 记录后重新抛出：调用方要能感知落盘失败，只打日志会让 UI 显示已切换而磁盘没变。
    throw error;
  }
}

/**
 * 解析 markdown 格式的 output style 文件
 */
// 解析文件头两行伪 front matter（name:/description:），不引入 YAML 依赖；
// 多行 description 不支持，这是与 Claude 风格文件格式的既定约定。
// 回退链：name 字段 → 文件名去 .md → "Custom Style"，保证 UI 永远有可显示名称。
function parseMarkdownStyle(
  content: string,
  filename?: string,
): { name: string; description: string } {
  // 用 /m 的行锚点匹配而不是逐行 split：name 允许出现在正文任意位置的单独一行，
  // 与 Claude 客户端读取本文件的方式保持一致。
  const nameMatch = content.match(/^name:\s*(.+)$/m);
  const descMatch = content.match(/^description:\s*(.+)$/m);

  let name = nameMatch?.[1]?.trim() ?? "";

  if (!name && filename) {
    // 回退到文件名去 .md：没有 name 字段的手写风格也要有可点击标签，否则选择器里出现空标题项。
    name = filename.replace(/\.md$/, "");
  }

  if (!name) {
    name = "Custom Style";
  }

  const description = descMatch?.[1]?.trim() ?? "";

  return { name, description };
}

/**
 * 创建 OutputStyle 服务实例
 */
// 工厂返回闭包而非 class：服务无内部状态，事实全部来自磁盘，便于测试替换 HOME。
// 闭包内不缓存列表，每次调用读盘，保证多窗口或外部编辑后立即生效。
export function createOutputStyleService(): IOutputStyleService {
// 返回 null 而非 "default"：让调用方区分「用户未设置」与「显式选择 default」。
  async function getActiveStyle(): Promise<{ styleId: string | null }> {
    // 路径每次现算：测试会替换 HOME 环境变量，缓存的绝对路径会指向真实用户目录。
    const settingsPath = getUserClaudeSettingsPath();
    // 每次调用都重新读盘：缓存会让外部编辑 settings.json 后本窗口一直显示旧激活项。
    const settings = await readJsonFile<ClaudeSettingsConfig>(settingsPath);
    return { styleId: settings?.outputStyle ?? null };
  }

// [资源] mkdir recursive 对已存在目录幂等，比 existsSync 先判后建少一个 TOCTOU 窗口。
// 读取后展开合并，只覆盖 outputStyle；直接写 {outputStyle} 会清掉 hooks 等配置。
// [权衡] 不加 file lock：设置页操作低频，并发最坏结果是后写覆盖，加锁的成本大于收益。
  async function setActiveStyle(params: { styleId: string }): Promise<void> {
    const { styleId } = params;
    const settingsPath = getUserClaudeSettingsPath();
    const claudeDir = join(resolveUserHomeDir(), ".claude");

    // Ensure directory exists
    // 只有目录缺失才 mkdir：~/.claude 通常已由 Claude 客户端创建，多数请求在这里零系统调用。
    // mkdir 传 recursive: true 时父目录缺失与并发创建都会成功，不需要额外判 EEXIST。
    if (!existsSync(claudeDir)) {
      await mkdir(claudeDir, { recursive: true });
    }

    // Read existing settings.json
    // 失败后果：readJsonFile 在文件损坏时返回 null，这里会把 {} 当成现有配置写回，settings.json 被「修复」成只剩 outputStyle，
    // 用户原有的 hooks/permissions 永久丢失；因此读失败与「文件不存在」在这里不能被同等对待。
    const existingSettings = (await readJsonFile<ClaudeSettingsConfig>(settingsPath)) || {};

    // Update outputStyle
    const newSettings: ClaudeSettingsConfig = {
      // 展开顺序决定优先级：outputStyle 写在展开之后覆盖旧值，其余键（hooks、permissions）原样保留。
      ...existingSettings,
      outputStyle: styleId,
    };

    // 崩溃窗口：writeJsonFile 先截断 settings.json 再写，中途被 kill 会留下半截 JSON；
    // 与自定义风格文件不同，这里是用户共享配置，损坏后 readJsonFile 只能回退默认值，无法恢复 hooks。
    await writeJsonFile(settingsPath, newSettings);
  }

// [失败路径] 目录缺失/不可读只返回内置风格，不抛错：首次使用尚未建目录是常态。
// 单个 .md 解析失败只跳过该文件并记日志，不能让一个坏文件拖垮整个列表。
  async function listStyles(): Promise<{ styles: OutputStyle[] }> {
    const stylesDir = getUserOutputStylesDir();
    // customStyles 先收集完再统一合并：中途 push 内置项会让排序把内置风格也卷进自定义分支。
    const customStyles: OutputStyle[] = [];

    // Get active style from settings.local.json, default to "default"
    const { styleId } = await getActiveStyle();
// 未配置时回退 "default"，这是全文件唯一允许出现默认激活的判定点。
    // styleId 为 null 只代表 settings.json 没写 outputStyle，不能与「用户选了 default」混为一谈，
    // 所以回退发生在这一刻，而不是在 getActiveStyle 里。
    const activeStyleId = styleId ?? "default";

    try {
// 先 access 再 readdir：目录缺失时直接跳过后续系统调用，避免必然抛错的 readdir。
      await access(stylesDir);
      const entries = await readdir(stylesDir, { withFileTypes: true });

// 只认 .md：编辑器备份（.md~）和附件若被纳入，会在选择器里出现无法解析的条目。
      for (const entry of entries) {
        // isFile 排除子目录：有人会把素材放进 output-styles/assets，
        // 不判类型会让 readFile 对目录抛 EISDIR，日志被噪声淹没。
        if (entry.isFile() && entry.name.endsWith(".md")) {
          try {
            const filePath = join(stylesDir, entry.name);
            const content = await readFile(filePath, "utf-8");
            const { name, description } = parseMarkdownStyle(content, entry.name);
            const styleId = `custom-${entry.name.replace(".md", "")}`;

            customStyles.push({
              id: styleId,
              name,
              description,
              content,
              isBuiltIn: false,
              // 自定义风格的 enabled 也由 activeStyleId 现算：id 前缀 custom- 保证不会与内置 id 撞车。
              enabled: styleId === activeStyleId,
              filePath,
            });
          } catch (error) {
            // 单文件失败只记日志并继续：一个编码错误的 md 不应让整个风格列表变成空数组。
            console.error(`Failed to read output style file ${entry.name}:`, error);
          }
        }
      }
    } catch {
      // 目录不存在或无法访问，返回内置 styles
    }

    // 按名称排序
// 按 name 而非 filename 排序：用户按显示名找风格，文件名可能已被转写成难辨认的横线形式。
    customStyles.sort((a, b) => a.name.localeCompare(b.name));

    // 合并内置和自定义 styles，标记激活状态
// 内置在前、自定义在后：顺序稳定可减少 UI 重排闪烁；enabled 在此统一覆盖静态初值。
    const allStyles: OutputStyle[] = [
      ...BUILT_IN_STYLES.map((style) => ({
        ...style,
        enabled: style.id === activeStyleId,
      })),
      ...customStyles,
    ];

    return { styles: allStyles };
  }

// 文件名由 name 小写并把空白转 -，「My Style」与「my-style」会互相覆盖，这是既有约定。
// mkdir recursive 幂等，EEXIST 分支防御旧版 Node 差异；其余错误必须抛，否则后续写入必失败。
  async function addStyle(params: { config: OutputStyleConfig }): Promise<void> {
    const { config } = params;
    const stylesDir = getUserOutputStylesDir();

    try {
      // mkdir 放在写文件之前：output-styles 目录首次使用时不存在，
      // 直接 writeFile 会以 ENOENT 失败，而错误信息只会指向 .md 路径。
      await mkdir(stylesDir, { recursive: true });
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== "EEXIST") {
        throw error;
      }
    }

    const filename = `${config.name.toLowerCase().replace(/\s+/g, "-")}.md`;
    // 路径用 join 而不是字符串拼接：Windows 与 POSIX 的分隔符差异由 node:path 吸收。
    const filePath = join(stylesDir, filename);

    // 生成文件内容
    const content = `name: ${config.name}
description: ${config.description}

${config.content}`;

    // 写入用 writeFile 整段覆盖而不是追加：风格文件是「头两行 + 正文」的定长结构，
    // 追加会让第二次保存产生重复的 name 行，解析正则只命中第一个。
    // 整段写不是原子替换：中途被 kill 时可能只剩 name 行，列表仍能解析出标题并展示截断正文，不会报错。
    await writeFile(filePath, content, "utf-8");
  }

// 按 id 反推文件名，改名只改 frontmatter 的 name，保证文件名与激活项都不变。
  async function updateStyle(params: {
    id: string;
    config: OutputStyleConfig;
  }): Promise<void> {
    const { id, config } = params;

    // 移除 'custom-' 前缀获取文件名
    // slice(7) 对应 custom- 的长度：少切或多切会写到另一个文件名，原文件看起来像被删除。
    const baseId = id.startsWith("custom-") ? id.slice(7) : id;
    const stylesDir = getUserOutputStylesDir();
    // 文件名只由 id 推导，与 config.name 无关：改名不会导致路径变化，列表 id 因此保持稳定。
    const filename = `${baseId}.md`;
    const filePath = join(stylesDir, filename);

    // 生成文件内容
    const content = `name: ${config.name}
description: ${config.description}

${config.content}`;

    // 只按 id 推导的路径写，不校验文件是否存在：文件被外部删除后 writeFile 会重建它，
    // updateStyle 用 writeFile 写回会重建被外部删除的文件，用户看到已删风格复活；这是 listStyles 不缓存、以磁盘为准的既定代价。
    await writeFile(filePath, content, "utf-8");
  }

// rm 带 force: true：文件已不存在也视为成功，删除保持幂等。
  async function deleteStyle(params: { id: string }): Promise<void> {
    const { id } = params;

    // 移除 'custom-' 前缀获取文件名
    // 这里不校验 custom- 前缀：旧版本残留的 id 也该能被清理，否则列表项永远删不掉。
    const baseId = id.startsWith("custom-") ? id.slice(7) : id;
    const stylesDir = getUserOutputStylesDir();
    const filename = `${baseId}.md`;
    const filePath = join(stylesDir, filename);

    // force: true 让「文件已不存在」也算成功：删除是幂等操作，
    // 抛 ENOENT 会让 UI 在重复点击后显示失败却什么都没发生。
    await rm(filePath, { force: true });
  }

// 给 UI「打开目录」用：返回前确保目录存在，避免文件管理器打开报错。
  async function getUserStylesDirectory(): Promise<{ path: string }> {
    const stylesDir = getUserOutputStylesDir();

    try {
      // 打开目录前先建目录：文件管理器对不存在的路径会直接报错，
      // 而「查看目录」按钮在首次使用时必须可用。
      await mkdir(stylesDir, { recursive: true });
    } catch {
      // 目录已存在
    }

    // 返回绝对路径供 shell.openPath 使用：相对路径会以主进程 cwd 解析，打开错误目录。
    return { path: stylesDir };
  }

  return {
    listStyles,
    addStyle,
    updateStyle,
    deleteStyle,
    // 导出的方法集合由 IOutputStyleService 约束：新增方法必须同步接口，
    // 否则调用方只能拿到 any，设置页的类型检查随之失效。
    getUserStylesDirectory,
    setActiveStyle,
    getActiveStyle,
  };
}
