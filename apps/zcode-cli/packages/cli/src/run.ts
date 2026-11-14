// 职责边界（cli run.ts）
// 做：CLI 进程唯一入口，先分流自执行子命令，再解析全局参数并归一化成 GlobalOptions。
// 做：集中校验参数互斥与作用域，统一写 stderr、决定退出码，再分发到各子命令实现。
// 不做：不实现会话、协议、TUI 或 Git 逻辑，只把依赖注入给 prompt/tui/protocol 命令。
// 不做：不在业务层做业务状态判断；参数错误与作用域错误只在本层收口。
// 依赖：parseGlobalArgs、normalizeWorkflowModeOption、RunDependencies 注入的 run* 实现。
// 边界：任何可变全局（env、cwd、logger）只在这里构造一次，子命令复用 commandDeps。
//
// INV 不变量表（19 条；每条都是「看起来该改、其实不能改」的约束）
// INV-01 断言：自执行子命令必须在 parseGlobalArgs 之前分流 —— 守住它的位置：run 开头四个 if —— 改错故障：SEA 下 argv 末尾的入口路径被当成未知参数
// INV-02 断言：参数错误一律写 stderr 并 return 1 —— 守住它的位置：各归一化 try/catch —— 改错故障：错误被吞后带非法配置继续启动
// INV-03 断言：--output-format 必须拒绝未知值 —— 守住它的位置：normalizeOutputFormat —— 改错故障：调用方静默拿到纯文本，解析不到 JSON
// INV-04 断言：--resume 与 --continue 互斥 —— 守住它的位置：resumeRequest 校验 —— 改错故障：会话恢复目标含糊，恢复错会话
// INV-05 断言：--browser-executable 只在 headless 下合法 —— 守住它的位置：browserUse 检查 —— 改错故障：桌面模式静默忽略参数，用户以为生效
// INV-06 断言：--target 与 --prompt 互斥 —— 守住它的位置：targetRequest 检查 —— 改错故障：两条输入通道同时生效，目标被覆盖
// INV-07 断言：--surface 只允许 prompt/target/app-server/agent-server —— 守住它的位置：isPresentationSurfaceSupportedInvocation —— 改错故障：TUI 拿到 desktop 表面并渲染错布局
// INV-08 断言：--force-mcs 与 --toolsearch-mode 共用同一作用域判定 —— 守住它的位置：同一个 if —— 改错故障：无会话命令上启用了 MCS
// INV-09 断言：--workflow-mode 作用域与 --force-mcs 完全一致 —— 守住它的位置：workflowMode 校验 —— 改错故障：doctor 等命令上出现 workflow 语义
// INV-10 断言：--memory-bench 只接受 --prompt 且不允许位置参数 —— 守住它的位置：memoryBench 检查 —— 改错故障：bench 误捕普通命令并拖慢启动
// INV-11 断言：headless 默认权限模式是 yolo，TUI 不套用 —— 守住它的位置：runPrompt 的 mode ?? 默认 —— 改错故障：TUI 被强制 yolo，权限提示消失
// INV-12 断言：--help/--version 必须在业务分发前返回 —— 守住它的位置：两个提前 return —— 改错故障：--help 启动了 agent 或建了会话
// INV-13 断言：app-server 是常驻协议子进程，不返回一次性结果 —— 守住它的位置：runZCodeProtocolCommand —— 改错故障：desktop 侧只看到 transport closed
// INV-14 断言：协议子进程不读用户 .env —— 守住它的位置：shouldLoadCliDotenvForProtocolServer —— 改错故障：环境污染在握手前退出
// INV-15 断言：dotenv 失败只在协议路径抛错 —— 守住它的位置：dotenvResult.error —— 改错故障：启动静默使用缺省配置，问题难复现
// INV-16 断言：resolveCliCwd 必须在所有参数归一化之后 —— 守住它的位置：workingDirectory 解析位置 —— 改错故障：cwd 报错先于参数报错，错误顺序错乱
// INV-17 断言：commandDeps 的 env 与 logger 只构造一次 —— 守住它的位置：commandDeps —— 改错故障：子命令各自读 env，行为不一致
// INV-18 断言：未知子命令写 help 到 stderr 并返回 1 —— 守住它的位置：switch 的 default —— 改错故障：退出码 0 让脚本误判成功
// INV-19 断言：版本号只来自 __CLI_VERSION__，缺省 0.0.0 —— 守住它的位置：version 常量 —— 改错故障：运行期读 package.json 在 SEA 下失败
//
// 维护约定：新增参数先加归一化函数与错误常量，再在 run 里接作用域校验，最后才传给子命令。
// 维护约定：新增子命令进 switch 时必须给默认分支留 help 输出，不能静默返回 0。
// 维护约定：任何 stderr 输出都带换行，退出码只在本层决定，子命令不要直接 process.exit。
import { ToolSearchModeSchema } from "@zcode/contracts";
import {
  STORAGE_MIGRATION_COMMAND,
  storageMigrationReportSchema,
} from "@zcode/shared/sqlite-migrations";
import { extractDisallowedToolsArgs, parseGlobalArgs } from "./arguments.js";
import { createNodeLoggerFactory } from "@zcode/adapters";
import { getRuntimeInfo, type PresentationSurface } from "@zcode/core";
import { color, formatJson, supportsColor } from "@zcode/core";
import { getZCodeCopy, isUiLocale, type UiLocale } from "@zcode/i18n";
import type { RunContext, GlobalOptions, GlobalOutputFormat } from "@zcode/shared-types";
import {
  applyCliRuntimeEnvSanitization,
  loadCliDotenv,
  prepareCliRuntimeEnv,
  shouldLoadCliDotenvForProtocolServer,
} from "./env.js";
import { formatCliHelp } from "./help.js";
import { runHooksCommand } from "./hooks-trust-command.js";
import { detectCliLocale } from "./locale.js";
import { loadBootstrapModule } from "./bootstrap-loader.js";
import { runEmbeddedSearchCli } from "./internal-search/embedded-search-cli.js";
import { runCommandsCommand } from "./commands-command.js";
import { resolveCliCwd } from "./cwd.js";
import { runLoginCommand, runLogoutCommand } from "./login-command.js";
import { CLI_COMMAND_NAME, CLI_PROCESS_NAME } from "./process-name.js";
import { isPluginHostInvocation, runPluginHostCommand } from "./plugin-host-command.js";
import { isDwfChildInvocation, runDwfChildCommand } from "./dwf-child-command.js";
import { runPrompt } from "./prompt-command.js";
import { runPluginsCommand, type PluginsCommandFlags } from "./plugins-command.js";
import { runSkillsCommand } from "./skills-command.js";
import { runTuiCommand } from "./tui-command.js";
import {
  DEFAULT_CLI_WORKFLOW_MODE,
  normalizeWorkflowModeOption,
  WORKFLOW_MODE_SCOPE_ERROR,
} from "./workflow-mode.js";
import type {
  CliPermissionMode,
  CliResumeRequest,
  CliTargetRequest,
  RunDependencies,
} from "./cli-types.js";

export type { RunDependencies } from "./cli-types.js";

declare const __CLI_VERSION__: string | undefined;

// [契约] __CLI_VERSION__ 由构建期注入，SEA 打包后无法再读 package.json。
// [失败路径] 改成运行期读文件会在只读安装目录下抛错，且版本号可能被本地文件污染。
// [权衡] 缺省 0.0.0 而不是抛错：未注入版本的开发构建仍要能跑。
const version = typeof __CLI_VERSION__ === "string" ? __CLI_VERSION__ : "0.0.0";

const EMPTY_TARGET_ERROR = "--target requires non-empty text.";
const DEFAULT_HEADLESS_PROMPT_MODE: CliPermissionMode = "yolo";
const FORCE_MCS_SCOPE_ERROR = "--force-mcs can only be used with --prompt, --target, or tui.";
const TARGET_REPLACE_REQUIRES_TARGET_ERROR = "--target-replace requires --target.";
const TARGET_CONFLICTS_WITH_PROMPT_ERROR =
  '--target cannot be used with --prompt. Use either --target <objective> or --prompt "/goal <objective>".';
const BROWSER_EXECUTABLE_REQUIRES_HEADLESS_ERROR =
  "--browser-executable requires --browser-use=headless.";
const BROWSER_USE_SCOPE_ERROR =
  "--browser-use=headless can only be used with --prompt, --target, or tui.";
const SURFACE_SCOPE_ERROR =
  "--surface can only be used with --prompt, --target, app-server, or agent-server.";
const MEMORY_BENCH_SCOPE_ERROR = "--memory-bench can only be used with -p/--prompt.";

// [契约] CLI 参数到子命令选项的映射只在这里做，子命令不认识原始 kebab-case 参数。
// [失败路径] 少映射一个 flag 会静默丢弃用户输入，不报错也不生效。
// [权衡] 用条件展开而不是把 undefined 传下去：下游据此判断「是否指定」。
const pluginsCommandFlags = (
  values: ReturnType<typeof parseGlobalArgs>["values"],
): PluginsCommandFlags => ({
  ...(values.all === true ? { all: true } : {}),
  ...(values.available === true ? { available: true } : {}),
  ...(values["keep-data"] === true ? { keepData: true } : {}),
  ...(typeof values.scope === "string" ? { scope: values.scope } : {}),
  ...(Array.isArray(values.sparse) ? { sparse: values.sparse as string[] } : {}),
});

const commandName = (positionals: string[]): string => positionals[0] ?? "tui";

// [契约] 作用域判定的唯一实现：prompt、target 或 tui 三者之一。
// [失败路径] 各参数各写一份判定，很快会出现口径漂移。
// [权衡] 函数保持纯函数，便于单测直接覆盖矩阵。
const isForceMcsSupportedInvocation = (input: {
  positionals: string[];
  prompt?: string;
  targetRequest?: CliTargetRequest;
}): boolean =>
  typeof input.prompt === "string" ||
  input.targetRequest !== undefined ||
  commandName(input.positionals) === "tui";

// [契约] --surface 多允许 app-server 与 agent-server，与 force-mcs 不同。
// [失败路径] 复用 force-mcs 的判定会让协议服务无法声明桌面表面。
// [权衡] 两处逻辑相似但不合并：允许集合本就不同。
const isPresentationSurfaceSupportedInvocation = (input: {
  positionals: string[];
  prompt?: string;
  targetRequest?: CliTargetRequest;
}): boolean => {
  const command = commandName(input.positionals);
  return (
    typeof input.prompt === "string" ||
    input.targetRequest !== undefined ||
    command === "app-server" ||
    command === "agent-server"
  );
};

// [契约] GlobalOptions 是子命令唯一可见的参数视图，原始 values 不再下传。
// [失败路径] 直接把 values 传给子命令会让每个子命令自行解释 flag，语义分裂。
// [权衡] 布尔项用 === true 归一，缺省 undefined 与 false 严格区分。
// [契约] 可选项用条件展开写入，避免把 undefined 显式放进对象。
const globalOptions = (
  values: ReturnType<typeof parseGlobalArgs>["values"],
  locale: UiLocale | undefined,
  detectedLocale: GlobalOptions["detectedLocale"],
  browserUse: GlobalOptions["browserUse"],
  browserExecutable: GlobalOptions["browserExecutable"],
  outputFormat: GlobalOptions["outputFormat"],
): GlobalOptions => {
  return {
    browserExecutable,
    browserUse,
    detectedLocale,
    force: values.force === true,
    json: values.json === true,
    locale,
    ...(values["memory-bench"] === true ? { memoryBench: true } : {}),
    noColor: values["no-color"] === true,
    ...(outputFormat ? { outputFormat } : {}),
    ...(values["record-conversation"] === true ||
    typeof values["record-conversation-dir"] === "string"
      ? { recordConversation: true }
      : {}),
    ...(typeof values["record-conversation-dir"] === "string"
      ? { recordConversationDir: values["record-conversation-dir"] }
      : {}),
    verbose: values.verbose === true,
  };
};

// [契约] 输出格式白名单只有三个值，新增格式要同时改渲染端。
// [失败路径] 放宽成字符串会让错误格式进到解析层，表现为空输出。
// [权衡] 用 readonly 数组而不是 Set：需要 join 出错误文案。
const OUTPUT_FORMATS: readonly GlobalOutputFormat[] = ["text", "json", "stream-json"];

/**
 * Validate --output-format. Rejecting an unknown value matters more than it
 * looks: a caller that misspells it would otherwise get plain text back and
 * silently parse nothing.
 */
// [契约] undefined 表示未指定，交给下游走默认格式。
// [失败路径] 未知值必须抛错：调用方拼错后会静默拿到纯文本。
// [权衡] 抛错而不是返回 undefined：静默降级比失败更难排查。
const normalizeOutputFormat = (value: string | undefined): GlobalOutputFormat | undefined => {
  if (value === undefined) return undefined;
  if ((OUTPUT_FORMATS as readonly string[]).includes(value)) return value as GlobalOutputFormat;
  throw new Error(
    `--output-format must be one of ${OUTPUT_FORMATS.join(", ")} (received: ${value}).`,
  );
};

const normalizeLocaleOption = (value: string | undefined): UiLocale | undefined => {
  if (value === undefined) return undefined;
  if (isUiLocale(value)) return value;
  throw new Error(getZCodeCopy().cli.errors.localeUnsupported(value));
};

// [契约] 权限模式白名单固定为 build/plan/edit/yolo/guarded。
// [失败路径] 新增模式只改这里而不改 core，会在执行层被当成未知值忽略。
// [契约] normalizePromptMode 先 toLowerCase 再比对白名单：手输 BUILD 可用，但返回值始终是小写枚举。
const normalizePromptMode = (value: string | undefined): CliPermissionMode | undefined => {
  if (value === undefined) return undefined;
  const mode = value.toLowerCase();
  if (
    mode === "build" ||
    mode === "plan" ||
    mode === "edit" ||
    mode === "yolo" ||
    mode === "guarded"
  )
    return mode;
  throw new Error(
    `Unsupported --mode value: ${value}. Supported modes: build, edit, plan, yolo, guarded.`,
  );
};

const normalizeBrowserUse = (value: string | undefined): GlobalOptions["browserUse"] => {
  if (value === undefined) return undefined;
  if (value.toLowerCase() === "headless") return "headless";
  throw new Error(`Unsupported --browser-use value: ${value}. Supported value: headless.`);
};

const normalizePresentationSurface = (value: string | undefined): PresentationSurface => {
  if (value === undefined || value.toLowerCase() === "terminal") return "terminal";
  if (value.toLowerCase() === "desktop") return "zcode_desktop";
  throw new Error(`Unsupported --surface value: ${value}. Supported surfaces: terminal, desktop.`);
};

// [契约] target 与 target-replace 必须成对校验，replace 单独出现是用法错误。
// [失败路径] 只校验非空字符串会让 --target-replace 被静默忽略。
// [权衡] 空字符串与纯空白都按缺失处理，用 trim 后长度判断。
const normalizeTargetRequest = (
  values: ReturnType<typeof parseGlobalArgs>["values"],
): CliTargetRequest | undefined => {
  const rawTarget = values.target as string | undefined;
  const replaceExisting = values["target-replace"] === true;
  if (rawTarget === undefined) {
    if (replaceExisting) {
      throw new Error(TARGET_REPLACE_REQUIRES_TARGET_ERROR);
    }
    return undefined;
  }

  const objective = rawTarget.trim();
  if (objective.length === 0) {
    throw new Error(EMPTY_TARGET_ERROR);
  }

  return {
    objective,
    replaceExisting,
  };
};

// [契约] target 走 /goal 命令通道，与 --prompt 共用 runPrompt。
// [失败路径] replaceExisting 必须映射成 replace 前缀，丢了就会追加而不是替换目标。
// [权衡] 在入口拼命令而不是让 runtime 认识 target，保持协议单一入口。
const buildHeadlessTargetCommand = (targetRequest: CliTargetRequest): string =>
  targetRequest.replaceExisting
    ? `/goal replace ${targetRequest.objective}`
    : `/goal ${targetRequest.objective}`;

const writeHelp = (
  stdout: NodeJS.WriteStream,
  locale?: UiLocale,
  detectedLocale?: GlobalOptions["detectedLocale"],
): void => {
  stdout.write(formatCliHelp(version, locale, detectedLocale));
};

// [契约] doctor 只读环境并输出，不建会话、不初始化 Provider。
// [失败路径] 引入会话初始化会让诊断在故障环境下无法运行。
// [权衡] json 模式输出结构化 payload，text 模式给人看，两份字段必须同源。
const runDoctor = (ctx: RunContext, options: GlobalOptions, workingDirectory: string): number => {
  const runtime = getRuntimeInfo();
  const payload = {
    cli: {
      name: CLI_COMMAND_NAME,
      processName: CLI_PROCESS_NAME,
      version,
    },
    runtime: {
      arch: runtime.arch,
      cwd: workingDirectory,
      execPath: runtime.execPath,
      node: runtime.node,
      platform: runtime.platform,
      processTitle: process.title,
      sea: runtime.sea,
    },
    packaging: {
      default: "node-bundle",
      sea: "optional",
    },
  };

  if (options.json) {
    ctx.stdout.write(formatJson(payload));
    return 0;
  }

  const colors = supportsColor(ctx.stdout, options.noColor);
  ctx.stdout.write(`${color.bold("zcode doctor", colors)}\n`);
  ctx.stdout.write(`version: ${payload.cli.version}\n`);
  ctx.stdout.write(`process: ${payload.runtime.processTitle}\n`);
  ctx.stdout.write(`node: ${payload.runtime.node}\n`);
  ctx.stdout.write(`platform: ${payload.runtime.platform}/${payload.runtime.arch}\n`);
  ctx.stdout.write(`sea: ${payload.runtime.sea ? "yes" : "no"} (${payload.packaging.sea})\n`);
  ctx.stdout.write(`default artifact: ${payload.packaging.default}\n`);

  if (options.verbose) {
    ctx.stdout.write(`execPath: ${payload.runtime.execPath}\n`);
    ctx.stdout.write(`cwd: ${payload.runtime.cwd}\n`);
  }

  return 0;
};

// [契约] 协议命令失败要写 stderr 并返回 1，不能抛给上层进程。
// [失败路径] 抛错会让 Electron 只看到未捕获异常，没有可读错误。
// [事务] prepareStorageOnly 只准备存储，供 --prepare-storage 预热使用。
const runZCodeProtocolCommand = async (
  ctx: RunContext,
  options: GlobalOptions,
  deps: RunDependencies,
  presentationSurface: PresentationSurface,
  prepareStorageOnly = false,
): Promise<number> => {
  try {
    // [契约] 协议路径与普通路径都要先做 env 净化，不能只做一次。
    // [失败路径] 跳过净化会把继承的调试变量带进 agent 子进程。
    // [事务] 净化必须发生在读取 dotenv 之前，顺序反了会读到未净化的值。
    const env = prepareCliRuntimeEnv(deps.env ?? process.env);
    const workingDirectory = (deps.cwd ?? process.cwd)();
    // 打包态 app-server 是 desktop host 的内部协议子进程。
    // 如果这里继续从 workspace 向上读取用户 .env，读文件失败或环境污染会在协议建立前
    // 直接退出，外层只能看到 ZCode agent transport closed。
    // [契约] 协议子进程默认不读用户 .env，只有显式允许才读。
    // [失败路径] 读失败或环境污染会在协议建立前退出，外层只看到 transport closed。
    // [权衡] 不读时返回空的 keys/loaded，保持返回结构一致。
    const dotenvResult = shouldLoadCliDotenvForProtocolServer(env)
      ? (deps.loadDotenv ?? loadCliDotenv)({
          cwd: workingDirectory,
          env,
        })
      : {
          keys: [],
          loaded: false,
        };
    // [契约] 净化在 dotenv 之后执行，把外部加载进来的危险变量一并清掉。
    // [失败路径] 只在加载前净化会漏掉 .env 里的污染项。
    // [事务] 原地修改 env 对象，下游看到的必须是同一引用。
    applyCliRuntimeEnvSanitization(env);

    if (dotenvResult.error) {
      throw new Error(`Failed to load environment file: ${dotenvResult.path}`, {
        cause: dotenvResult.error,
      });
    }

    const runProtocolAgent =
      deps.runZCodeProtocolAgent ?? (await loadBootstrapModule()).runZCodeProtocolAgent;
    // [契约] 输入输出直接绑定 ctx 的 stdin/stdout，不额外包一层流。
    // [失败路径] 包一层会破坏背压与协议帧边界。
    // [事务] prepareStorageOnly 与 presentationSurface 必须原样透传，不能取默认值。
    // [资源] runProtocolAgent 常驻直到连接关闭，这里不做超时。
    await runProtocolAgent({
      lifecycle: deps.protocolLifecycle,
      cwd: workingDirectory,
      env,
      input: deps.protocolInput ?? ctx.stdin,
      output: ctx.stdout,
      presentationSurface,
      prepareStorageOnly,
      version,
    });
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.stderr.write(`Error: ${message}\n`);
    if (options.verbose && error instanceof Error && error.stack) {
      ctx.stderr.write(`${error.stack}\n`);
    }
    return 1;
  }
};

// [契约] run 是纯函数式入口：所有 IO 从 ctx 与 deps 来，便于单测注入。
// [事务] 退出码只在本函数返回，任何子命令都不应调用 process.exit。
// [失败路径] 早期分流必须先于参数解析，见 INV-01。
export const run = async (ctx: RunContext, deps: RunDependencies = {}): Promise<number> => {
  // [契约] storage-migrate 是内部命令，只允许零参数并输出一份 JSON 报告。
  // [事务] 迁移直接开 startup store 并 close，不初始化 Provider/MCP/Agent。
  // [失败路径] 复用完整启动链会让迁移在配置损坏时无法执行。
  // [资源] finally 里必须 close，否则 WAL 文件残留导致下次迁移阻塞。
  if (ctx.argv[0] === STORAGE_MIGRATION_COMMAND) {
    try {
      if (ctx.argv.length !== 1) throw new Error("storage-migrate accepts no arguments");
      const migrateStorage =
        deps.migrateStorage ??
        (async () => {
          // 复用正常启动的配置解析与存储入口，不初始化 Provider/MCP/Agent 运行态。
          const { createConfig, resolvePath } = await import("@zcode/adapters/config");
          const { openStartupSqliteSessionStore } = await import("@zcode/adapters/storage");
          const config = createConfig({ env: deps.env ?? process.env });
          const store = await openStartupSqliteSessionStore({
            dbPath: resolvePath(config.config.storage.sessionDbPath),
          });
          try {
            return store.migrationResult;
          } finally {
            store.close();
          }
        });
      const report = storageMigrationReportSchema.parse({
        version: 1,
        kind: "storage-migrated",
        ...(await migrateStorage()),
      });
      ctx.stdout.write(`${JSON.stringify(report)}\n`);
      return 0;
    } catch (error) {
      ctx.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
  }
  // [契约] 内部搜索命令只为嵌入场景存在，参数原样交给子实现。
  // [失败路径] 走公开参数解析会与搜索自身的 flag 冲突。
  // [权衡] 放在这里而不是注册子命令：不希望出现在 help 里。
  if (ctx.argv[0] === "__internal-search") {
    return runEmbeddedSearchCli(ctx.argv.slice(1), {
      cwd: (deps.cwd ?? process.cwd)(),
      stderr: ctx.stderr,
      stdin: ctx.stdin,
      stdout: ctx.stdout,
    });
  }

  // [契约] plugin host 调用必须先于 parseGlobalArgs：它的 argv 形态不符合全局参数约定。
  // [失败路径] 放到解析之后会把插件参数当未知 flag 直接退出。
  // [并发] 该分支直接 return，不参与后续任何全局状态构造。
  if (isPluginHostInvocation(ctx.argv)) {
    return await runPluginHostCommand(ctx, ctx.argv.slice(1));
  }

  // 与 plugin host 同理，且必须同样在 parseArgs 之前：SEA 下 dwf 的沙箱子进程是本二进制的
  // 自 re-exec，argv 末位是入口文件路径——交给严格 parseArgs 只会报未知参数。
  // [契约] dwf 沙箱子进程是本二进制自 re-exec，argv 末位是入口文件路径。
  // [失败路径] 交给严格 parseArgs 只会报未知参数，沙箱永远起不来。
  // [权衡] 与 plugin host 同理，必须同层提前分流。
  if (isDwfChildInvocation(ctx.argv)) {
    return await runDwfChildCommand(ctx, ctx.argv.slice(1));
  }

  // [契约] hooks 是信任管理命令，需要 deps 与 version，但不需要全局参数。
  // [失败路径] 挪到参数解析之后会让 hooks 误吃用户的其它 flag。
  // [事务] 直接 await 并返回其退出码，不在这里改写错误文案。
  if (ctx.argv[0] === "hooks") {
    return await runHooksCommand(ctx, deps, version);
  }

  // [契约] 解析结果与 disallowlist 分开保存：后者来自参数抽取阶段。
  // [失败路径] 在 try 外使用 parsed 会因未赋值而崩溃，因此解析失败必须 return。
  // [事务] 解析失败时先写错误再写 help，顺序影响可读性。
  // [权衡] 这里只 catch 不包装：参数错误信息已是面向用户的文案。
  let parsed: ReturnType<typeof parseGlobalArgs>;
  let toolDisallowlist: readonly string[] | undefined;

  try {
    // [契约] 工具禁用列表必须在解析前抽出，它不是标准 flag 语法。
    // [失败路径] 不抽会污染 positionals，让命令名判定错位。
    // [事务] 抽取后的 args 才是 parseGlobalArgs 的输入。
    const extracted = extractDisallowedToolsArgs(ctx.argv);
    parsed = parseGlobalArgs(extracted.args);
    toolDisallowlist = extracted.toolDisallowlist;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.stderr.write(`${message}\n\n`);
    writeHelp(ctx.stderr);
    return 1;
  }

  // [契约] locale 只影响文案，不影响业务行为。
  // [失败路径] 非法 locale 直接失败而不是回退，防止用户以为切换成功。
  // [权衡] 单独 try 而不是合并到统一校验，保证错误顺序稳定。
  let locale: UiLocale | undefined;
  try {
    locale = normalizeLocaleOption(parsed.values.locale as string | undefined);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.stderr.write(`${message}\n`);
    return 1;
  }

  // [契约] mode 与 workflowMode 在同一段解析，二者都属于会话语义参数。
  // [失败路径] 拆成两段会让第一个失败掩盖第二个，错误提示不完整。
  // [事务] 解析结果只赋值给局部变量，options 对象稍后统一构造。
  // [权衡] workflowModeOption 保留 undefined 以便区分「未指定」与「默认值」。
  let mode: CliPermissionMode | undefined;
  let workflowModeOption: ReturnType<typeof normalizeWorkflowModeOption>;
  let browserUse: GlobalOptions["browserUse"];
  let presentationSurface: PresentationSurface;
  try {
    mode = normalizePromptMode(parsed.values.mode as string | undefined);
    workflowModeOption = normalizeWorkflowModeOption(
      parsed.values["workflow-mode"] as string | undefined,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.stderr.write(`${message}\n`);
    return 1;
  }

  try {
    // [契约] 每个归一化独立 try：只报第一个错误，避免连锁噪音。
    // [失败路径] 合并 try 会让后续参数不再校验，用户要多次运行才发现全部问题。
    // [权衡] 早失败优先于一次性收集全部错误，符合 CLI 习惯。
    browserUse = normalizeBrowserUse(parsed.values["browser-use"] as string | undefined);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.stderr.write(`${message}\n`);
    return 1;
  }
  try {
    presentationSurface = normalizePresentationSurface(parsed.values.surface as string | undefined);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.stderr.write(`${message}\n`);
    return 1;
  }
  // [契约] browserExecutable 只有在 headless 下才有意义。
  // [失败路径] 不校验会让人以为指定了自定义浏览器，实际被忽略。
  // [权衡] 这里直接写 stderr 而不是抛错：错误文案已是完整句子。
  const browserExecutable = parsed.values["browser-executable"] as string | undefined;
  if (browserExecutable !== undefined && browserUse !== "headless") {
    ctx.stderr.write(`${BROWSER_EXECUTABLE_REQUIRES_HEADLESS_ERROR}\n`);
    return 1;
  }

  // [契约] resume 与 continue 是两个独立字段，互斥性在这里校验。
  // [失败路径] 同时允许会让恢复目标不确定，可能接错会话。
  // [事务] 校验在构造后立即进行，不能延迟到 runPrompt 内部。
  const resumeRequest: CliResumeRequest = {
    continueSession: parsed.values.continue === true,
    resumeSessionId: parsed.values.resume as string | undefined,
  };
  if (resumeRequest.continueSession && resumeRequest.resumeSessionId) {
    ctx.stderr.write("--resume and --continue cannot be used together.\n");
    return 1;
  }

  const env = prepareCliRuntimeEnv(deps.env ?? process.env);
  // [契约] detectedLocale 来自环境变量，用于 help 与错误文案的回退语言。
  // [失败路径] 用显式 locale 覆盖检测值会让未指定时没有回退语言。
  // [事务] 只能在 env 净化之后检测，否则会读到被清理的变量。
  // [权衡] 检测失败返回 undefined，由文案层自行兜底。
  const detectedLocale = detectCliLocale(env);
  let outputFormat: GlobalOptions["outputFormat"];
  try {
    outputFormat = normalizeOutputFormat(parsed.values["output-format"] as string | undefined);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.stderr.write(`${message}\n`);
    return 1;
  }
  // [契约] options 在所有归一化完成后一次性构造，之后不再改动。
  // [失败路径] 传错位置参数（如把 browserUse 与 browserExecutable 调换）不会报类型错，只会静默失效。
  // [事务] 各子命令共用同一个 options 引用，不能各自克隆。
  const options = globalOptions(
    parsed.values,
    locale,
    detectedLocale,
    browserUse,
    browserExecutable,
    outputFormat,
  );
  // [契约] toolsearch-mode 用 schema 校验，缺省值 off 由这里注入。
  // [失败路径] 用 includes 手写白名单会与 contracts 里的枚举漂移。
  // [权衡] safeParse 而不是 parse：错误要转成用户可读提示。
  const parsedToolsearchMode = ToolSearchModeSchema.safeParse(
    parsed.values["toolsearch-mode"] ?? "off",
  );
  if (!parsedToolsearchMode.success) {
    ctx.stderr.write("--toolsearch-mode must be one of auto, native, local, off.\n");
    return 1;
  }
  const toolsearchMode = parsedToolsearchMode.data;
  // [契约] forceMcs 是布尔开关，只接受显式 true。
  // [失败路径] 用真值判断会把字符串 "false" 也当成开启。
  // [事务] 作用域校验在下面与 toolsearch-mode 共用同一个 if。
  const forceMcs = parsed.values["force-mcs"] === true;
  let targetRequest: CliTargetRequest | undefined;
  try {
    targetRequest = normalizeTargetRequest(parsed.values);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.stderr.write(`${message}\n`);
    return 1;
  }

  // [契约] target 与 prompt 互斥，提示里给出两种正确写法。
  // [失败路径] 允许同时存在会让 prompt 覆盖 target，目标静默丢失。
  // [权衡] 只报错不自动择一，避免猜用户意图。
  if (targetRequest && typeof parsed.values.prompt === "string") {
    ctx.stderr.write(`${TARGET_CONFLICTS_WITH_PROMPT_ERROR}\n`);
    return 1;
  }

  if (
    parsed.values.surface !== undefined &&
    !isPresentationSurfaceSupportedInvocation({
      positionals: parsed.positionals,
      prompt: parsed.values.prompt as string | undefined,
      targetRequest,
    })
  ) {
    ctx.stderr.write(`${SURFACE_SCOPE_ERROR}\n`);
    return 1;
  }

  // [契约] help 与 version 必须在任何会话动作之前返回。
  // [失败路径] 放在 scope 校验之后，会让 `zcode --help --surface=x` 直接报错。
  // [事务] 输出走 stdout，退出码 0。
  if (parsed.values.help === true) {
    writeHelp(ctx.stdout, options.locale, options.detectedLocale);
    return 0;
  }

  // [契约] version 只输出裸版本号，不加前缀，便于脚本消费。
  // [失败路径] 加前缀会破坏已有的解析脚本。
  // [事务] 与 help 同层提前返回，不依赖 options。
  if (parsed.values.version === true) {
    ctx.stdout.write(`${version}\n`);
    return 0;
  }

  if (
    // [契约] memory-bench 只允许 prompt 模式且不允许位置参数。
    // [失败路径] 允许位置参数会让 bench 与子命令同时生效。
    // [权衡] 检查放在 help/version 之后，便于 --help 总能生效。
    options.memoryBench &&
    (typeof parsed.values.prompt !== "string" || parsed.positionals.length > 0)
  ) {
    ctx.stderr.write(`${MEMORY_BENCH_SCOPE_ERROR}\n`);
    return 1;
  }

  if (
    browserUse === "headless" &&
    !isForceMcsSupportedInvocation({
      positionals: parsed.positionals,
      prompt: parsed.values.prompt as string | undefined,
      targetRequest,
    })
  ) {
    ctx.stderr.write(`${BROWSER_USE_SCOPE_ERROR}\n`);
    return 1;
  }

  // app-server 的 mode 归 Host 决定（launch.md「The standalone CLI: `--workflow-mode`」），
  // 其余子命令不建会话；作用域与 --force-mcs 相同：只有 --prompt、--target 与 TUI。
  if (
    workflowModeOption !== undefined &&
    !isForceMcsSupportedInvocation({
      positionals: parsed.positionals,
      prompt: parsed.values.prompt as string | undefined,
      targetRequest,
    })
  ) {
    ctx.stderr.write(`${WORKFLOW_MODE_SCOPE_ERROR}\n`);
    return 1;
  }
  // [契约] 默认 workflow 模式只在这里兜底一次，子命令不再各写默认值。
  // [失败路径] 在子命令里再兜底会让默认值有两份来源。
  // [事务] workflowModeOption 保留原值用于「是否显式指定」的判定。
  const workflowMode = workflowModeOption ?? DEFAULT_CLI_WORKFLOW_MODE;

  if (
    (forceMcs || parsed.values["toolsearch-mode"] !== undefined) &&
    !isForceMcsSupportedInvocation({
      positionals: parsed.positionals,
      prompt: parsed.values.prompt as string | undefined,
      targetRequest,
    })
  ) {
    ctx.stderr.write(
      `${parsed.values["toolsearch-mode"] !== undefined ? "--toolsearch-mode can only be used with --prompt, --target, or tui." : FORCE_MCS_SCOPE_ERROR}\n`,
    );
    return 1;
  }

  // [契约] cwd 解析在所有参数校验之后，保证先报参数错误。
  // [失败路径] 提前解析会让非法 cwd 掩盖真正需要用户修的参数问题。
  // [事务] 解析失败写 stderr 并返回 1，不抛异常。
  let workingDirectory: string;
  try {
    workingDirectory = resolveCliCwd({
      cwd: deps.cwd ?? process.cwd,
      requestedCwd: parsed.values.cwd as string | undefined,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.stderr.write(`${message}\n`);
    return 1;
  }

  // [契约] commandDeps 是子命令的唯一依赖视图：cwd、env、logger 都在这里固化。
  // [失败路径] 子命令直接读 process.env 会绕过净化，行为与主路径不一致。
  // [事务] logger 只构造一次，避免同一次运行出现两份日志文件。
  // [契约] loadDotenv 包一层以复用净化逻辑，调用方无需自己记得。
  const commandDeps: RunDependencies = {
    ...deps,
    cwd: () => workingDirectory,
    env,
    logger:
      deps.logger ??
      createNodeLoggerFactory({ env }).createLogger("zcode").child({ module: "cli" }),
    loadDotenv: (dotenvOptions = {}) => {
      const dotenvResult = (deps.loadDotenv ?? loadCliDotenv)(dotenvOptions);
      applyCliRuntimeEnvSanitization(dotenvOptions.env ?? env);
      return dotenvResult;
    },
  };

  // [契约] prompt 模式走 runPrompt，并补上 headless 默认权限模式。
  // [失败路径] 漏传 toolDisallowlist 会让用户的禁用配置失效。
  // [事务] 参数顺序是位置契约，调整形参时要同步所有调用点。
  // [权衡] 空字符串也是合法 prompt，因此用 typeof 判断而不是真值。
  if (typeof parsed.values.prompt === "string") {
    return await runPrompt(
      ctx,
      parsed.values.prompt,
      parsed.values.attach ?? [],
      options,
      commandDeps,
      version,
      mode ?? DEFAULT_HEADLESS_PROMPT_MODE,
      resumeRequest,
      toolDisallowlist,
      forceMcs,
      toolsearchMode,
      presentationSurface,
      workflowMode,
    );
  }

  // [契约] target 复用 runPrompt，用 /goal 命令承载目标。
  // [失败路径] 传 mode 而不是默认值：target 与 prompt 的权限默认不同，是有意为之。
  // [事务] attach 为空数组：target 模式不支持附件。
  if (targetRequest) {
    return await runPrompt(
      ctx,
      buildHeadlessTargetCommand(targetRequest),
      [],
      options,
      commandDeps,
      version,
      mode,
      resumeRequest,
      toolDisallowlist,
      forceMcs,
      toolsearchMode,
      presentationSurface,
      workflowMode,
    );
  }

  // [契约] 子命令分发的唯一位置，新增命令只在这里加 case。
  // [失败路径] 在 switch 外另开入口会让 help 列表与实现漂移。
  // [事务] 每个 case 直接 return 退出码，不做 fallthrough 共享逻辑。
  // [权衡] 用 switch 而不是映射表：能让未知命令落到 default 并给 help。
  switch (commandName(parsed.positionals)) {
    case "help":
      writeHelp(ctx.stdout, options.locale, options.detectedLocale);
      return 0;
    case "version":
      ctx.stdout.write(`${version}\n`);
      return 0;
    // [契约] agent-server 与 app-server 是同一条协议链路，共享 runZCodeProtocolCommand。
    // [失败路径] 只改其中一个分支会让 desktop 与 agent 客户端行为分叉。
    // [事务] prepare-storage 只对协议命令有意义，从这里透传。
    case "agent-server":
    case "app-server":
      return await runZCodeProtocolCommand(
        ctx,
        options,
        commandDeps,
        presentationSurface,
        parsed.values["prepare-storage"] === true,
      );
    case "doctor":
      return runDoctor(ctx, options, workingDirectory);
    case "login":
      return await runLoginCommand(
        ctx,
        options,
        commandDeps,
        parsed.values["no-browser"] === true,
        parsed.positionals.slice(1),
      );
    case "logout":
      return await runLogoutCommand(ctx, options, commandDeps);
    case "commands":
      return await runCommandsCommand(ctx, options, commandDeps, parsed.positionals.slice(1));
    case "plugin":
    case "plugins":
      return await runPluginsCommand(
        ctx,
        options,
        commandDeps,
        parsed.positionals.slice(1),
        pluginsCommandFlags(parsed.values),
      );
    case "skills":
      return await runSkillsCommand(ctx, options, commandDeps, parsed.positionals.slice(1));
    case "tui":
      return await runTuiCommand(
        ctx,
        options,
        commandDeps,
        version,
        mode,
        resumeRequest,
        toolDisallowlist,
        forceMcs,
        toolsearchMode,
        workflowMode,
      );
    // [契约] 未知命令写 stderr 加 help，并返回 1。
    // [失败路径] 返回 0 会让 CI 脚本把拼错的命令当成功。
    // [权衡] help 写 stderr 而不是 stdout：这是错误路径。
    default:
      ctx.stderr.write(`Unknown command: ${commandName(parsed.positionals)}\n\n`);
      writeHelp(ctx.stderr, options.locale, options.detectedLocale);
      return 1;
  }
};
