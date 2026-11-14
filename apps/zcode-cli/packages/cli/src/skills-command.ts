// `zcode skills` 命令实现：列出或查看工作区/插件/用户级 Skills。
// 发现与解析逻辑由 @zcode/bootstrap 的 SkillRegistry 提供，本层只做参数分发与输出格式化。
import { formatJson } from "@zcode/core";
import type { Logger } from "@zcode/contracts";
import type { RunContext, GlobalOptions } from "@zcode/shared-types";
import type {
  inspectZCodeSkill,
  InspectZCodeSkillOptions,
  listZCodeSkills,
  ListZCodeSkillsOptions,
  ZCodeSkillInspection,
} from "@zcode/bootstrap";
import type { CliEnv } from "./env.js";

// 懒加载的 bootstrap 模块类型；仅用于依赖注入签名，不产生运行时依赖。
type BootstrapModule = typeof import("@zcode/bootstrap");
// 列表结果的完整形状（含 skills/diagnostics/totalDiscovered），保证格式化函数与数据源同源。
type CliSkillListOutcome = Awaited<ReturnType<typeof listZCodeSkills>>;
// 列表中的单条 skill 条目。
type CliSkillListItem = CliSkillListOutcome["skills"][number];

// 本命令的可注入依赖；全部可选，缺省时回落到 process 与真实 bootstrap 模块。
interface SkillsCommandDependencies {
  // 工作目录取值函数，缺省 process.cwd；决定 skill 的搜索根。
  cwd?: () => string;
  // 环境变量袋，缺省 process.env；影响 storage 级 skill 的可见性。
  env?: CliEnv;
  // inspect 实现，缺省 bootstrap.inspectZCodeSkill。
  inspectSkill?: (options: InspectZCodeSkillOptions) => ReturnType<typeof inspectZCodeSkill>;
  // list 实现，缺省 bootstrap.listZCodeSkills。
  listSkills?: (options: ListZCodeSkillsOptions) => ReturnType<typeof listZCodeSkills>;
  // 诊断日志出口；为空时不写日志，只通过命令输出暴露 diagnostics。
  logger?: Logger;
  // bootstrap 模块加载器，缺省动态 import（测试可替换）。
  loadBootstrapModule?: () => Promise<BootstrapModule>;
}

// 帮助文本；未知子命令与参数错误时原样打印。
const SKILLS_COMMAND_USAGE = "Usage: zcode skills [list|inspect <name>]";

// 执行 skills 命令。
// 输入：args[0] 为子命令（缺省 list）；inspect 需要恰好一个非空 skill 名。
// 输出：0 成功（包括"找到 0 个 skill"，空集合是正常结果）；1 表示用法错误、未知子命令或加载失败。
// 副作用：读取工作区/插件目录（磁盘 IO），可能写 logger；不修改任何文件。
// 输出口径：--json 输出完整结构；人类可读模式省略路径以外的内部字段，--verbose 才附 diagnostics。
export const runSkillsCommand = async (
  ctx: RunContext,
  options: GlobalOptions,
  deps: SkillsCommandDependencies,
  args: string[],
): Promise<number> => {
  // 无子命令时默认 list：只读且信息量有用，避免只输入 `zcode skills` 就报错。
  const subcommand = args[0] ?? "list";
  if (subcommand === "list") {
    if (args.length > 1) return failUsage(ctx);
    return await runSkillsListCommand(ctx, options, deps);
  }

  // inspect 必须且只能带一个名字；空白名字视为缺失，避免用空串去搜索而得到含糊错误。
  if (subcommand === "inspect") {
    if (args.length !== 2 || args[1]?.trim().length === 0) return failUsage(ctx);
    return await runSkillsInspectCommand(ctx, options, deps, args[1]);
  }

  ctx.stderr.write(`Unknown skills command: ${subcommand}\n${SKILLS_COMMAND_USAGE}\n`);
  return 1;
};

// 用法错误出口：只打印 usage（不猜用户意图），固定返回 1。
function failUsage(ctx: RunContext): number {
  ctx.stderr.write(`${SKILLS_COMMAND_USAGE}\n`);
  return 1;
}

// 列出所有可见 skill。
// 输入：deps 提供 cwd/env/logger 与可替换的 list 实现。
// 输出：0；异常统一转交给 reportSkillsError（返回 1）。
// 副作用：读取 skill 目录与 manifest；不写盘。
async function runSkillsListCommand(
  ctx: RunContext,
  options: GlobalOptions,
  deps: SkillsCommandDependencies,
): Promise<number> {
  try {
    const env = deps.env ?? process.env;
    const workingDirectory = (deps.cwd ?? process.cwd)();
    const bootstrap = deps.loadBootstrapModule ?? (() => import("@zcode/bootstrap"));
    const listSkills = deps.listSkills ?? (await bootstrap()).listZCodeSkills;
    const outcome = await listSkills({
      env,
      logger: deps.logger,
      workingDirectory,
    });

    ctx.stdout.write(
      options.json
        ? formatSkillJson(outcome, workingDirectory)
        : formatHumanSkillList(outcome, options),
    );
    return 0;
  } catch (error) {
    return reportSkillsError(ctx, options, error);
  }
}

// 查看单个 skill 的元数据与正文（正文可能被截断）。
// 输入：name 可为短名或 qualifiedName，解析由 bootstrap 负责。
// 输出：0；找不到或解析失败即抛错，由 reportSkillsError 输出并返回 1。
// 副作用：只读该 skill 对应文件（含 sizeBytes 上限保护），不修改内容。
async function runSkillsInspectCommand(
  ctx: RunContext,
  options: GlobalOptions,
  deps: SkillsCommandDependencies,
  name: string,
): Promise<number> {
  try {
    const env = deps.env ?? process.env;
    const workingDirectory = (deps.cwd ?? process.cwd)();
    const bootstrap = deps.loadBootstrapModule ?? (() => import("@zcode/bootstrap"));
    const inspectSkill = deps.inspectSkill ?? (await bootstrap()).inspectZCodeSkill;
    const inspection = await inspectSkill({
      env,
      logger: deps.logger,
      name,
      workingDirectory,
    });

    ctx.stdout.write(
      options.json
        ? formatSkillInspectionJson(inspection, workingDirectory)
        : formatHumanSkillInspection(inspection, options),
    );
    return 0;
  } catch (error) {
    return reportSkillsError(ctx, options, error);
  }
}

// 统一错误出口：错误信息写 stderr，--verbose 时追加调用栈，固定返回 1。
// 非 Error 对象也转成字符串输出，保证不会有异常静默丢失。
function reportSkillsError(ctx: RunContext, options: GlobalOptions, error: unknown): number {
  const message = error instanceof Error ? error.message : String(error);
  ctx.stderr.write(`Error: ${message}\n`);
  if (options.verbose && error instanceof Error && error.stack) {
    ctx.stderr.write(`${error.stack}\n`);
  }
  return 1;
}

// 组合描述与"何时使用"提示；whenToUse 缺省时只返回 description。
function formatSkillDescription(skill: CliSkillListItem): string {
  return skill.whenToUse ? `${skill.description} ${skill.whenToUse}` : skill.description;
}

// 展示名优先用 qualifiedName（可唯一区分同名 skill），否则退回短名。
function formatSkillName(skill: Pick<CliSkillListItem, "name" | "qualifiedName">): string {
  return skill.qualifiedName ?? skill.name;
}

// 渲染人类可读的 skill 列表；每条占三行（名称/来源、描述、绝对路径）。
// 输出：带结尾换行的字符串；空集合时固定文案 "No skills found."，便于脚本判定。
function formatHumanSkillList(outcome: CliSkillListOutcome, options: GlobalOptions): string {
  if (outcome.skills.length === 0) {
    return "No skills found.\n";
  }

  const lines = [`Available skills (${outcome.skills.length})`];
  for (const skill of outcome.skills) {
    const alias = skill.qualifiedName ? `; alias ${skill.name}` : "";
    lines.push(`- ${formatSkillName(skill)} (${skill.scope}/${skill.source}${alias})`);
    lines.push(`  ${formatSkillDescription(skill)}`);
    lines.push(`  ${skill.path}`);
  }

  appendDiagnostics(lines, outcome.diagnostics, options);
  return `${lines.join("\n")}\n`;
}

// 渲染单个 skill 的详情：元数据逐项一行，随后是正文（空正文显示 "(empty)"）。
// 输出：带结尾换行的字符串；truncated 时在 size 行标注，提醒正文不完整。
function formatHumanSkillInspection(
  inspection: ZCodeSkillInspection,
  options: GlobalOptions,
): string {
  const { metadata } = inspection.skill;
  const lines = [
    `Skill: ${formatSkillName(metadata)}`,
    `scope/source: ${metadata.scope}/${metadata.source}`,
    `path: ${metadata.path}`,
    `directory: ${metadata.directory}`,
    `description: ${metadata.description}`,
  ];

  if (metadata.pluginName) lines.push(`pluginName: ${metadata.pluginName}`);
  if (metadata.qualifiedName) lines.push(`qualifiedName: ${metadata.qualifiedName}`);
  if (metadata.whenToUse) lines.push(`whenToUse: ${metadata.whenToUse}`);
  lines.push(`safeToAutoLoad: ${metadata.safeToAutoLoad ? "yes" : "no"}`);
  lines.push(
    `size: ${inspection.skill.bytesRead}/${inspection.skill.sizeBytes} bytes${inspection.skill.truncated ? " (truncated)" : ""}`,
  );
  lines.push(
    "",
    "Content",
    inspection.skill.content.length > 0 ? inspection.skill.content : "(empty)",
  );

  appendDiagnostics(lines, inspection.diagnostics, options);
  return `${lines.join("\n")}\n`;
}

// 仅当 --verbose 且确实有诊断时追加 diagnostics 段；默认静默，避免正常输出被噪声淹没。
function appendDiagnostics(
  lines: string[],
  diagnostics: CliSkillListOutcome["diagnostics"],
  options: GlobalOptions,
): void {
  if (!options.verbose || diagnostics.length === 0) return;

  lines.push("", `Diagnostics (${diagnostics.length})`);
  for (const diagnostic of diagnostics) {
    const location = diagnostic.path ? ` (${diagnostic.path})` : "";
    lines.push(`- [${diagnostic.severity}] ${diagnostic.code}: ${diagnostic.message}${location}`);
  }
}

// 构造 list 的 JSON 输出；字段为机器消费的稳定契约，可选字段（pluginName/qualifiedName/whenToUse）缺省即省略。
const formatSkillJson = (outcome: CliSkillListOutcome, cwd: string): string =>
  formatJson({
    cwd,
    diagnostics: outcome.diagnostics.map(formatDiagnosticJson),
    skills: outcome.skills.map((skill) => ({
      description: skill.description,
      directory: skill.directory,
      name: skill.name,
      path: skill.path,
      ...(skill.pluginName ? { pluginName: skill.pluginName } : {}),
      ...(skill.qualifiedName ? { qualifiedName: skill.qualifiedName } : {}),
      rootPath: skill.rootPath,
      scope: skill.scope,
      source: skill.source,
      ...(skill.whenToUse ? { whenToUse: skill.whenToUse } : {}),
    })),
    totalDiscovered: outcome.totalDiscovered,
  });

// 构造 inspect 的 JSON 输出；包含正文与截断标记，供调用方自行判断是否继续读取。
const formatSkillInspectionJson = (inspection: ZCodeSkillInspection, cwd: string): string =>
  formatJson({
    cwd,
    diagnostics: inspection.diagnostics.map(formatDiagnosticJson),
    skill: {
      baseDirectory: inspection.skill.baseDirectory,
      bytesRead: inspection.skill.bytesRead,
      content: inspection.skill.content,
      metadata: {
        description: inspection.skill.metadata.description,
        directory: inspection.skill.metadata.directory,
        frontmatterKeys: inspection.skill.metadata.frontmatterKeys,
        name: inspection.skill.metadata.name,
        path: inspection.skill.metadata.path,
        ...(inspection.skill.metadata.pluginName
          ? { pluginName: inspection.skill.metadata.pluginName }
          : {}),
        ...(inspection.skill.metadata.qualifiedName
          ? { qualifiedName: inspection.skill.metadata.qualifiedName }
          : {}),
        rootPath: inspection.skill.metadata.rootPath,
        safeToAutoLoad: inspection.skill.metadata.safeToAutoLoad,
        scope: inspection.skill.metadata.scope,
        source: inspection.skill.metadata.source,
        ...(inspection.skill.metadata.whenToUse
          ? { whenToUse: inspection.skill.metadata.whenToUse }
          : {}),
      },
      sizeBytes: inspection.skill.sizeBytes,
      truncated: inspection.skill.truncated,
    },
  });

// 诊断项的 JSON 形态；path/skillName 为空时省略字段而不是输出 null，保持契约稳定。
function formatDiagnosticJson(diagnostic: CliSkillListOutcome["diagnostics"][number]) {
  return {
    code: diagnostic.code,
    message: diagnostic.message,
    ...(diagnostic.path ? { path: diagnostic.path } : {}),
    severity: diagnostic.severity,
    ...(diagnostic.skillName ? { skillName: diagnostic.skillName } : {}),
  };
}
