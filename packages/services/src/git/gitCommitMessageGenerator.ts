// Git 提交信息生成：读当前模型 → 组装有界 prompt（分支/改动文件/diff 摘要/会话上下文）→ 调模型 → 校验降级。
// INV-01：prompt 体积有硬上界（文件 20、diff 8 段/12000 字符/单文件 2000、上下文 12 条/4000 字符/单条 600）；
// 守住位置：buildGitCommitMessageGenerationPrompt 与两个 summary 函数；破坏后整份 diff 进入请求，
// 会撞上下文上限或产生按 token 计费的意外开销。
// INV-02：所有截断都是「前缀 + 固定 marker」，同一输入必须得到同一 prompt；守住位置：clipText；
// 破坏后（如按行数截断）输出会随 diff 顺序抖动，提交信息不可复现、测试无法比对。
// INV-03：只有首行严格匹配 Conventional Commit 正则才算成功；守住位置：validateGeneratedGitCommitMessage；
// 破坏后 UI 会展示带解释文字或 markdown 围栏的非法提交信息。
// INV-04：失败必须落到 model-unavailable/request-failed/invalid-output 三态之一且不透传原始异常；
// 守住位置：resolveCurrentModel、complete、generate；破坏后调用方分不清「没模型」与「模型乱答」。
import type {
  GitCommitMessageConversationContext,
  GitDiffResult,
  GitFileChange,
  Locale,
  ZCodeWorkspaceGenerateTextParams,
} from "@zcode/shared";
import type { ServiceLogger } from "#src/logger/serviceLogger.js";

// 文件清单与 diff 各有独立上限：清单廉价（每行几十字符），diff 昂贵（可达数千字符）。
// 只截断列表尾部而不采样，是为了让同一次暂存的同一组文件生成稳定 prompt；
// 被截掉的数量以 ... N more files 显式告知模型，避免它以为改动只有前 20 个。
const MAX_PROMPT_FILES = 20;
const MAX_DIFF_FILES = 8;
// 总预算与单文件预算同时存在：只有总量时一个大文件会吃掉全部预算，其余 diff 不可见；
// 只有单文件时 20 个文件仍可能拼出超过上下文窗口的 prompt。
const MAX_DIFF_CHARS = 12_000;
const MAX_DIFF_CHARS_PER_FILE = 2_000;
// 会话上下文按「最近 N 条 + 字符预算」双重截断：条数防轮次过多，字符数防单条超长；
// [顺序] 上下文截断保留尾部 MAX_CONVERSATION_CONTEXT_MESSAGES 条：用户最新指令在末尾，取头部会丢掉真正要提交的意图。
const MAX_CONVERSATION_CONTEXT_MESSAGES = 12;
const MAX_CONVERSATION_CONTEXT_CHARS = 4_000;
const MAX_CONVERSATION_CONTEXT_CHARS_PER_MESSAGE = 600;
// 该上限只用于兜住模型失控输出，正常提交信息远小于此；超出部分直接截断而不是报错，避免整次生成白费。
const MAX_COMMIT_MESSAGE_CHARS = 1_000;
const COMMIT_MESSAGE_QUERY_SOURCE = "git_commit_message";

// 只校验首行：type 限定白名单、scope 可选、允许 breaking 的感叹号，正文不做语法校验。
// 长度写成 1..100 而不是 72，是因为 72 只是 prompt 里的软建议；硬拒绝 73 字符的合理标题会让用户
// 反复重试。真正的硬上限由 MAX_COMMIT_MESSAGE_CHARS 负责（[权衡] 两个上限故意不一致）。
const CONVENTIONAL_COMMIT_RE =
  /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([^)]+\))?!?: .{1,100}$/;

export interface GitCommitMessageCurrentModelProvider {
  readCurrentModel(params: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<ZCodeWorkspaceGenerateTextParams["selection"] | null>;
}

export interface GitCommitMessageTextGenerator {
  generateText(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    selection: ZCodeWorkspaceGenerateTextParams["selection"];
    prompt: string;
    querySource: string;
  }): Promise<{ text: string; selection: ZCodeWorkspaceGenerateTextParams["selection"] }>;
}

export interface GitCommitMessageGeneratorOptions {
  currentModelProvider: GitCommitMessageCurrentModelProvider;
  textGenerator: GitCommitMessageTextGenerator;
  logger?: ServiceLogger;
}

// reason 是调用方唯一可依赖的分类，message 只面向用户展示；不要把原始异常文本塞进 reason。
export class GitCommitMessageGenerationError extends Error {
  constructor(
    message: string,
    readonly reason: "model-unavailable" | "request-failed" | "invalid-output",
    readonly detail?: string,
  ) {
    super(message);
    this.name = "GitCommitMessageGenerationError";
  }
}

export class GitCommitMessageGenerator {
  constructor(private readonly options: GitCommitMessageGeneratorOptions) {}

// 生成是「先读模型、再拼 prompt、最后调用」的三段式：模型缺失必须在拼 prompt 之前失败，
// 否则白做一次本地计算才发现没有模型，日志里会留下误导性的 diff 统计。本方法不缓存、不重试。
  async generate(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    branchName: string | null;
    locale?: Locale;
    files: readonly GitFileChange[];
    diffs: readonly GitDiffResult[];
    conversationContext?: GitCommitMessageConversationContext;
  }): Promise<{ message: string; providerId: string; model: string }> {
// selection 必须来自宿主当前的模型选择（含 options）而非写死默认值：
// 写死会让用户切换的 provider 静默失效，提交信息语言与风格随实现漂移。
    const selection = await this.resolveCurrentModel(params);
    const prompt = buildGitCommitMessageGenerationPrompt({
      branchName: params.branchName,
      locale: params.locale,
      files: params.files,
      diffs: params.diffs,
      conversationContext: params.conversationContext,
    });

// 只记录计数与标识，不记录 prompt 与 diff 内容：diff 可能含密钥或私有代码，
// 而 info 等级在生产会落盘，泄露面远大于一条 debug 轨迹。
    this.options.logger?.info(undefined, "开始生成 Git 提交消息", {
      workspacePath: params.workspacePath,
      workspaceIdentity: params.workspaceIdentity,
      providerId: selection.providerId,
      model: selection.modelId,
      fileCount: params.files.length,
      diffCount: params.diffs.length,
      conversationMessageCount: params.conversationContext?.messages.length ?? 0,
      conversationOmittedMessageCount: params.conversationContext?.omittedMessageCount ?? 0,
    });

// complete 内部把所有生成器异常折叠成 GitCommitMessageGenerationError，供下面按 reason 统一处理。
    const rawMessage = await this.complete({
      workspacePath: params.workspacePath,
      workspaceIdentity: params.workspaceIdentity,
      selection,
      prompt,
    });
// 校验与生成分离：模型输出先剥离装饰、长度截断，再判首行；顺序不能反，
// 因为围栏或引号会让首行变成反引号串而正则必然失败。失败时不抛原始模型输出，只留短 preview。
    const validation = validateGeneratedGitCommitMessage(rawMessage);
    if (!validation.ok) {
      // 模型可能重复 prompt 或返回解释性长文本，直接塞给 UI 会让错误提示失控。
      // 这里只保留短 preview 给用户，完整模型调用细节由 agent runtime 的模型日志记录。
      this.options.logger?.debug(undefined, "模型生成的 Git 提交消息不合规", {
        workspacePath: params.workspacePath,
        providerId: selection.providerId,
        model: selection.modelId,
        reason: validation.reason,
        preview: validation.preview,
      });
      throw new GitCommitMessageGenerationError(
// 错误文案是给用户的最终提示，因此不拼接 validation.reason（英文枚举对用户无意义）；
// preview 通过 detail 字段传出，由调用方决定是否展示。
        "模型没有返回可用的 Conventional Commit 提交消息。",
        "invalid-output",
        validation.preview,
      );
    }

    return {
// 返回 providerId/model 供 UI 标注生成来源，不透出 selection.options（可能含敏感字段）。
      message: validation.message,
      providerId: selection.providerId,
      model: selection.modelId,
    };
  }

// 读模型失败与读到的模型不完整要区分来源，但两者对用户都表现为「未读取到当前模型」，
// 因此共用 model-unavailable。返回前重新 trim：空白字符会让下游按 providerId 建索引时 miss。
  private async resolveCurrentModel(params: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<ZCodeWorkspaceGenerateTextParams["selection"]> {
    const currentModel = await this.options.currentModelProvider.readCurrentModel({
      workspacePath: params.workspacePath,
      workspaceIdentity: params.workspaceIdentity,
    });
    const modelId = currentModel?.modelId?.trim();
    const providerId = currentModel?.providerId?.trim();
    const options = currentModel?.options;
// providerId 与 modelId 必须同时存在：只有其一时无法构造有效 selection，提前失败好过下游 400。
    if (!providerId || !modelId) {
      throw new GitCommitMessageGenerationError("未读取到当前模型。", "model-unavailable");
    }
    return {
      providerId,
      modelId,
      ...(options
        ? {
// options 浅拷贝后返回：调用方若原地修改，会污染宿主共享的模型配置对象。
            options: {
              ...options,
            },
          }
        : {}),
    };
  }

// 单次请求不自动重试：超时与限流由上层策略决定，这里重试会把一次用户操作放大成多次计费调用。
// 归一化在 return 处做（normalizeModelText），保证下游拿到的一定是非空字符串。
  private async complete(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    selection: ZCodeWorkspaceGenerateTextParams["selection"];
    prompt: string;
  }): Promise<string> {
    try {
// querySource 固定为 git_commit_message，供宿主区分调用来源、做配额与统计；
// 不能复用聊天的 querySource，否则提交信息会被计入对话额度或触发对话侧限流。
      const result = await this.options.textGenerator.generateText({
        workspacePath: params.workspacePath,
        ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
        selection: params.selection,
        prompt: params.prompt,
        querySource: COMMIT_MESSAGE_QUERY_SOURCE,
      });
      return normalizeModelText(result.text);
    } catch (error) {
// 已是本类错误就原样抛出，避免二次包装把 reason 覆盖成 request-failed（会丢失 invalid-output）；
// 其余异常只保留 message 作为 detail，防止堆栈或内部 URL 透到 UI。
      if (error instanceof GitCommitMessageGenerationError) {
        throw error;
      }
      throw new GitCommitMessageGenerationError(
        "模型请求失败。",
        "request-failed",
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}

// prompt 是纯函数输出：相同输入必须得到完全相同的字符串，便于日志与测试比对，因此不采样、
// 不读时间、不依赖 locale 之外的全局状态。各片段先算好再拼数组，最后过滤空行。
function buildGitCommitMessageGenerationPrompt(params: {
  branchName: string | null;
  locale?: Locale;
  files: readonly GitFileChange[];
  diffs: readonly GitDiffResult[];
  conversationContext?: GitCommitMessageConversationContext;
}): string {
// 分支名参与 prompt 但不能为空：detached HEAD 时 branchName 为 null，留空会让模型把「无分支」
// 误读成「未知改动」；显式占位符能提示它这只是一种上下文状态。
  const normalizedBranchName = params.branchName?.trim() || "(detached or unknown)";
  const language = resolveCommitMessageLanguage(params.locale);
// 截断收口在 prompt 组装处而不是调用方：files 可能来自整个暂存区，
// 统一在此处理才能保证命令面板、快捷键、CLI 等所有入口使用同一预算。
  const visibleFiles = params.files.slice(0, MAX_PROMPT_FILES);
  const omittedFileCount = Math.max(0, params.files.length - visibleFiles.length);
// 每行给出 kind 与增删行数：模型判断 type（feat/fix/refactor）主要靠统计与路径而非 diff 内容，
// 所以清单不能省。路径用 repoRelativePath，避免绝对路径泄露本机目录结构。
  const fileSummary = visibleFiles
    .map((file) => `- ${file.kind} ${file.repoRelativePath} (+${file.added}/-${file.removed})`)
    .join("\n");
// diff 摘要可能为空串（无 diff 或预算耗尽），此时 prompt 退化为仅按文件清单推断。
  const diffSummary = buildDiffSummary(params.diffs);
  const conversationSummary = buildConversationContextSummary(params.conversationContext);

// 提示词按「规则 → 上下文 → 文件清单 → diff」排列：规则在最前，避免长 diff 把约束挤出模型注意力。
  return [
// 用英文写指令、要求输出跟随 Current language：英文指令解析更稳定，
// 输出语言交给模型按 locale 决定，避免在这里维护中英两套模板。
    "Write exactly one Git commit message for the workspace changes below.",
    "Return only the commit message text.",
    "",
    "Hard requirements:",
    "- The first line must be a valid Conventional Commit subject.",
    "- Use one of: feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert.",
    "- Keep the Conventional Commit type and optional scope in English.",
    "- Write the subject and any body in the current language.",
// 72 是软约束（git log 一行显示），与正则的 100 硬上限故意留余量，模型偶尔超长不该导致失败。
    "- Keep the subject under 72 characters.",
    "- Use the current session conversation context only to infer user intent.",
    "- Do not mention the conversation, chat, prompt, or user request explicitly.",
    "- Do not explain your reasoning.",
    "- Do not repeat these instructions.",
    "",
    `Current branch: ${normalizedBranchName}`,
    `Current language: ${language}`,
    "",
    "Current session conversation context:",
    conversationSummary || "(not provided)",
    "",
    "Changed files:",
    fileSummary || "- (no file summary available)",
    omittedFileCount > 0 ? `- ... ${omittedFileCount} more files` : "",
    "",
    "Diff excerpts:",
    diffSummary || "(diff unavailable; infer only from the changed file summary)",
  ]
// 只过滤完全空串：diff 内容里的空行有语义，trim 会吃掉；这里的空串仅来自条件占位。
    .filter((line) => line !== "")
    .join("\n");
}

// 只支持中英两种输出：模型对其它语言的提交信息质量不稳定，团队规范也只覆盖这两类。
// locale 缺失时读运行时 Intl 而不是默认英文，否则中文用户会莫名收到英文提交信息。
function resolveCommitMessageLanguage(locale?: Locale): "Chinese" | "English" {
  const candidate = locale ?? readRuntimeLocale();
  return candidate?.toLowerCase().startsWith("zh") ? "Chinese" : "English";
}

// Intl 在裁剪过 ICU 的环境会抛错，这里吞掉异常返回 undefined，由上层回落 English；
// 不在 catch 里写日志，是因为该函数每次生成都会调用，高频日志没有诊断价值。
function readRuntimeLocale(): string | undefined {
  try {
    // 系统默认语言没有从 UI 显式传入时，服务层只能读取当前运行时的 Intl locale。
    // 这里仍只接受 zh 为中文，其它未知或读取失败都按英文处理，避免误生成第三种语言。
    return Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    return undefined;
  }
}

// 校验顺序：剥离装饰 → trim → 硬截断 → 再 trim → 判空 → 判首行。先截断再判首行，
// 是为了让「首行合法但正文超长」的输出被接受，而不是因正文过长被误判非法。
function validateGeneratedGitCommitMessage(
  rawMessage: string,
): { ok: true; message: string } | { ok: false; reason: "empty" | "invalid"; preview?: string } {
  const message = stripGeneratedCommitMessageDecorations(rawMessage)
    .trim()
    .slice(0, MAX_COMMIT_MESSAGE_CHARS)
    .trim();
  if (!message) {
    return { ok: false, reason: "empty" };
  }

// 只取第一行作为 subject，且兼容 CRLF：模型在 Windows 语境下可能输出 \r\n，
// 不兼容会让 subject 末尾带 \r，正则能匹配但会污染最终写入 git 的信息。
  const subject = message.split(/\r?\n/, 1)[0]?.trim() ?? "";
// preview 优先用 subject，为空时退回正文前 120 字符，保证日志里总能看出模型答了什么。
  if (!CONVENTIONAL_COMMIT_RE.test(subject)) {
    return { ok: false, reason: "invalid", preview: subject || message.slice(0, 120) };
  }
  return { ok: true, message };
}

// 预算按「已用字符」累计而不是按文件均分：小 diff 应让出预算给后面的大 diff，
// 均分会在「8 个文件只有 1 个有内容」时浪费 7 份配额。
function buildDiffSummary(diffs: readonly GitDiffResult[]): string {
  let totalChars = 0;
  const chunks: string[] = [];
// 只取前 8 个 diff 且不排序：顺序由暂存区决定，重排会让同一组改动的 prompt 不稳定；
// 超出的文件仍出现在清单里，模型据此能感知改动范围。
  for (const diff of diffs.slice(0, MAX_DIFF_FILES)) {
    const header = `--- ${diff.path}`;
// patch 缺失时退回 summary，两者都没有才用占位符：二进制文件没有 patch，
// 但 summary 仍能说明该文件被修改，比让模型误以为没改动更准确。
// 预算耗尽时下一个循环就 break，不再拼空 chunk；继续拼会把 header 也塞进去，总长超出 MAX_DIFF_CHARS。
    const body = diff.patch?.trim() || diff.summary?.trim() || "(diff unavailable)";
    const remainingChars = MAX_DIFF_CHARS - totalChars;
    if (remainingChars <= 0) {
      break;
    }
// 单文件上限取「单文件预算」与「剩余总预算」的较小值，既不超单文件也不超总量；marker 明确告知
// 模型内容不完整，避免它把截断处当成文件结尾下结论。
    const clippedBody = clipText(
      body,
      Math.min(MAX_DIFF_CHARS_PER_FILE, remainingChars),
      "...diff truncated...",
    );
    const chunk = `${header}\n${clippedBody}`;
    chunks.push(chunk);
    totalChars += chunk.length;
  }
  return chunks.join("\n\n");
}

// 会话上下文是可选意图提示，不是事实来源：可能含与改动无关的闲聊，所以限尾部、限条数、限字符，
// 并在 prompt 中要求不得在提交信息里提及对话。返回空串表示无上下文，由调用方回落占位符。
function buildConversationContextSummary(
  context: GitCommitMessageConversationContext | undefined,
): string {
  const messages = context?.messages ?? [];
  if (messages.length === 0) {
    return "";
  }

  const chunks: string[] = [];
  let totalChars = 0;
// 省略条数由上游统计与本地截断相加：上游已丢掉的更早消息若不告知模型，
// 它会把「最近 12 条」误当成完整会话。
  const omittedMessageCount =
    (context?.omittedMessageCount ?? 0) +
    Math.max(0, messages.length - MAX_CONVERSATION_CONTEXT_MESSAGES);
  if (omittedMessageCount > 0) {
    chunks.push(`- ${omittedMessageCount} earlier messages omitted`);
  }

// 取最后 N 条：最新指令通常决定提交意图。角色只区分 assistant/user，system 与 tool 不参与，
// 防止把内部工具输出当成用户意图；空内容消息跳过，避免纯附件消息挤占字符预算。
  for (const message of messages.slice(-MAX_CONVERSATION_CONTEXT_MESSAGES)) {
    const content = normalizeConversationContextText(message.content);
    if (!content) {
      continue;
    }

    const role = message.role === "assistant" ? "Assistant" : "User";
// 单条先截断再拼 role 前缀：先拼后截会让长内容把 role 挤出窗口，模型可能把整段当成用户发言。
    const clippedContent = clipText(
      content,
      MAX_CONVERSATION_CONTEXT_CHARS_PER_MESSAGE,
      "...message truncated...",
    );
    const nextChunk = `${role}: ${clippedContent}`;
    const remainingChars = MAX_CONVERSATION_CONTEXT_CHARS - totalChars;
    if (remainingChars <= 0) {
      break;
    }

// 最后一条也可能被剩余预算截断：这里不 break 而是截断后结束循环，让模型知道上下文到此为止；
// totalChars 计入额外的换行开销，保证 join 后的实际长度不超总预算。
    const clippedChunk = clipText(nextChunk, remainingChars, "...conversation truncated...");
    chunks.push(clippedChunk);
    totalChars += clippedChunk.length + 1;
  }

  return chunks.join("\n");
}

// 归一化只为压缩体积：统一换行、去行尾空白、把 3 个以上连续换行压成 2 个（保留段落分隔），
// 不改变语义。若改成整段 trim 会丢掉代码块缩进，模型对改动的理解会变差。
function normalizeConversationContextText(value: string): string {
  return value
    .replace(/\r\n?/gu, "\n")
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

// 截断规则：保留 maxChars - marker.length - 1 个字符，trimEnd 后接换行与 marker，保证结果不超限。
// 用固定 marker 而非省略号，是因为 marker 本身要向模型传达「被截断」；Math.max(0) 兜住极端入参。
function clipText(value: string, maxChars: number, marker: string): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars - marker.length - 1)).trimEnd()}\n${marker}`;
}

// 模型常把提交信息包进围栏、引号或 commit message: 前缀；只剥离这几种已知装饰，不做通用清洗，
// 避免把正文里有意义的引号或代码块误删（[权衡] 宁可漏剥也不误删）。
function stripGeneratedCommitMessageDecorations(value: string): string {
  const trimmed = value.trim();
// 围栏正则要求首尾匹配整串：只剥完整围栏，正文中间的代码块保持原样；
// 语言标记允许字母数字下划线连字符，因为模型常写 ```text 或 ```git-commit。
  const fenced = /^```(?:[a-zA-Z0-9_-]+)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  const withoutFence = fenced?.[1] ?? trimmed;
  const withoutPrefix = withoutFence.replace(/^commit message:\s*/i, "").trim();
  if (
// 只在首尾同种引号时剥一层：单边引号可能是正文的一部分（如引用报错信息），
// 无条件 slice(1, -1) 会吃掉首字符，产生难以察觉的错别字。
    (withoutPrefix.startsWith('"') && withoutPrefix.endsWith('"')) ||
    (withoutPrefix.startsWith("'") && withoutPrefix.endsWith("'"))
  ) {
    return withoutPrefix.slice(1, -1);
  }
  return withoutPrefix;
}

// 文本生成器的返回类型在运行时不可信，必须先判类型再判非空：空串会走到 validate 的 empty 分支，
// 而 undefined 若直接 trim 会抛 TypeError 并被误报为请求失败。
function normalizeModelText(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("模型响应缺少文本内容。");
  }
  return value.trim();
}
