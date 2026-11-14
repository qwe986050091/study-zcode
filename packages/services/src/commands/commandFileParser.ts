// 斜杠命令文件（commands/*.md）的解析与生成：只认 markdown 一种格式，_format 参数为后续格式预留。
// INV-01：frontmatter 只在「首尾各一条 --- 且后者在前者之后」时才成立；不成立必须整篇当正文，
//         绝不能吞掉任何用户内容（守住位置：splitMarkdownCommandContent 的两个 -1 判断）。
// INV-02：写回时只替换 description / argument-hint 两个键，其余 frontmatter 行原样保留
//         （守住位置：preserveFrontmatterLines + replacedKeys）；丢掉未知键会静默删除用户配置。
// INV-03：name 恒以 / 开头且取自文件名；prompt 是去掉 frontmatter 后的正文，二者不得互相污染。
// 解析失败统一返回 null，由调用方降级为「不注册该命令」，不允许抛出中断目录扫描。
import type { CommandConfig } from "@zcode/shared";

export type CommandFileFormat = "markdown";

interface ParsedCommandFile {
  name: string;
  prompt: string;
  content: string;
  filePath: string;
  description?: string;
  argumentHint?: string;
}

interface MarkdownCommandParts {
  frontmatterLines: string[];
  contentLines: string[];
}

function getCrossPlatformBasename(filePath: string): string {
  return filePath.split(/[\\/]+/).pop() ?? "";
}

function splitMarkdownCommandContent(content: string): MarkdownCommandParts {
  const lines = content.split("\n");
// 分隔线允许前后带空白（trim 后比较），因为手写 md 常写成「 --- 」。
// frontmatterEnd 从 start 之后开始找，防止同一行被同时当作首尾两条分隔线。
  const frontmatterStart = lines.findIndex((line) => line.trim() === "---");
  const frontmatterEnd = lines.findIndex(
    (line, index) => index > frontmatterStart && line.trim() === "---",
  );

// 找不到成对的 --- 时整篇视为正文：常见于普通 md 或首行是分隔线的文档，
// 若把第一个 --- 之后的内容当 frontmatter，会静默丢掉正文开头。
// 这里两次 findIndex 而非状态机，是为了让「无 frontmatter」分支保持零分配、零副作用。
  if (frontmatterStart === -1 || frontmatterEnd === -1) {
    return { frontmatterLines: [], contentLines: lines };
  }

  return {
    frontmatterLines: lines.slice(frontmatterStart + 1, frontmatterEnd),
    contentLines: lines.slice(frontmatterEnd + 1),
  };
}

function readFrontmatterKey(line: string): string | undefined {
// 缩进行是上一个键的续行/列表项，不能当成新键；否则多行 description 会被后续列表项截断。
// 只接受 [A-Za-z0-9_-]+ 形式的键并转小写，避免把正文里的「注意：」识别成 frontmatter。
  if (line.startsWith(" ") || line.startsWith("\t")) {
    return undefined;
  }
// 键名正则不允许空格与点，避免把 my.key: value 误认成顶层键；冒号后的内容由调用方自行切分。
// 注意此处 line 已 trim，行首缩进必须靠 readFrontmatterKey 开头的 startsWith 判断。
  const match = /^([A-Za-z0-9_-]+)\s*:/.exec(line.trim());
  return match?.[1]?.toLowerCase();
}

function readFrontmatterMultilineValue(
  lines: readonly string[],
  targetKey: string,
): string | undefined {
  const collected: string[] = [];
  let collecting = false;

  for (const line of lines) {
    const key = readFrontmatterKey(line);
    if (key) {
      if (collecting) {
        break;
      }
      if (key === targetKey) {
        collecting = true;
        const value = line.split(":").slice(1).join(":").trim();
        if (value) {
          collected.push(value);
        }
      }
      continue;
    }

// 只收集目标键之后的缩进行；遇到下一个顶层键时 collecting 已被上面置为 false。
// [失败路径] 其它键的缩进行会被忽略但不报错——frontmatter 是弱格式，容错优先于严格校验。
// 空值（key 后无内容）不 push，最终 join 为空串时返回 undefined，调用方据此不写该字段。
    if (collecting && (line.startsWith(" ") || line.startsWith("\t"))) {
      collected.push(line.trim());
    }
  }

  const value = collected.join(" ").trim();
  return value || undefined;
}

// 生成新 frontmatter 时保留旧文件里的未知键，但跳过本次要重写的键，避免同一键出现两次。
// [权衡] skipUntilNextKey 会连同该键的缩进续行一起丢弃：旧的 description 可能是多行，
// 只删首行会把续行变成孤立文本，写回后 frontmatter 结构被破坏。
function preserveFrontmatterLines(
  existingContent: string | undefined,
  replacedKeys: ReadonlySet<string>,
): string[] {
  const preserved: string[] = [];
  let skipUntilNextKey = false;

  for (const line of splitMarkdownCommandContent(existingContent ?? "").frontmatterLines) {
    const key = readFrontmatterKey(line);
    if (key) {
      skipUntilNextKey = replacedKeys.has(key);
    }
    if (!skipUntilNextKey) {
      preserved.push(line);
    }
  }

  return preserved;
}

function parseMarkdownCommandFile(content: string, filePath: string): ParsedCommandFile | null {
  const { frontmatterLines, contentLines } = splitMarkdownCommandContent(content);
// 命名以文件名为准而非 frontmatter：文件名是唯一跨平台稳定标识，重命名文件即重命名命令。
// content 保留未 trim 的正文（含首尾空行），prompt 才 trim；两者用途不同，不能合并成一个字段。
// 换行统一按 \n 切分：命令文件可能由 Windows 编辑器以 CRLF 写出，多出的 \r 留在行尾也无害。
  const fileName = getCrossPlatformBasename(filePath);
// [契约] name 必须带前导 / 并剥掉 .md（大小写不敏感）：注册表按带斜杠的形式查找，缺前缀或带后缀都匹配不到用户输入。
// 文件名中的空格与中文原样保留、不做 slug 化：命令名即用户输入的前缀，改写会导致调用不到。
  const name = `/${fileName.replace(/\.md$/i, "")}`;
  const prompt = contentLines.join("\n").trim();

// [失败路径] 纯防御：basename 恒非空（至少有扩展名），但保留 null 返回让调用方跳过坏路径，
// 而不是把空串当命令名注册成一条无名斜杠命令。
  if (!name) {
    return null;
  }

  return {
    name,
    prompt,
    content: contentLines.join("\n"),
    filePath,
    description: readFrontmatterMultilineValue(frontmatterLines, "description"),
    argumentHint: readFrontmatterMultilineValue(frontmatterLines, "argument-hint"),
  };
}

function generateMarkdownCommandFileContent(
  config: CommandConfig,
  existingContent?: string,
): string {
// 只重写这两个键，其余键靠 preserveFrontmatterLines 原样搬运，未知键不丢失也不重排。
// [权衡] 先算保留行、再追加新键，最后才判断是否为空——顺序颠倒会在无 frontmatter 时
// 生成一个只有分隔线、没有键的空块。
  const replacedKeys = new Set<string>(["description", "argument-hint"]);
  const frontmatterLines = preserveFrontmatterLines(existingContent, replacedKeys);

  if (config.description?.trim()) {
    frontmatterLines.push(`description: ${config.description.trim()}`);
  }
  if (config.argumentHint?.trim()) {
    frontmatterLines.push(`argument-hint: ${config.argumentHint.trim()}`);
  }

// 没有任何 frontmatter 时直接返回 prompt，不额外造一对 ---；否则每个命令文件都会被加上空块，
// 既改变用户文件外观，也让 parse 侧误以为存在 frontmatter。
  if (frontmatterLines.length === 0) {
    return config.prompt;
  }

// 首行必须是独占一行的 ---，parse 侧才能识别；正文前留一个空行，与手写命令文件惯例一致。
// [失败路径] prompt 为空时仍会产出一个只有 frontmatter 的文件，此处不拒绝：空命令由注册侧校验。
  return `---
${frontmatterLines.join("\n")}
---

${config.prompt}`;
}

export class CommandFileParser {
// 入口只做异常隔离：解析是纯函数，理论上不抛；这里的 catch 防止单个坏文件
// 让整轮命令目录扫描中断（调用方按 null 跳过该文件）。
  static parseCommandFile(
    content: string,
    filePath: string,
    _format: CommandFileFormat = "markdown",
  ): ParsedCommandFile | null {
    try {
      return parseMarkdownCommandFile(content, filePath);
// [失败路径] 任何意外异常都折叠成 null，不记录、不抛出：命令文件来自用户工作区，
// 内容与编码都不可控，把错误升级成日志会随目录规模刷屏。
// 代价是坏文件静默消失，因此 parseMarkdownCommandFile 内部避免依赖会抛异常的 API。
    } catch {
      return null;
    }
  }

// 生成侧同样忽略 format：当前只有 markdown，占位参数保证调用方签名在新增格式时不变。
// existingContent 缺省表示新建文件，此时只写本次的两个键。
  static generateCommandFileContent(
    config: CommandConfig,
    _format: CommandFileFormat = "markdown",
    existingContent?: string,
  ): string {
    return generateMarkdownCommandFileContent(config, existingContent);
  }
}
