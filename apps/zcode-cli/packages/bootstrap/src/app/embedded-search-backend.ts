// ============================================================
// 内嵌搜索后端的默认解析（internal-cli 覆盖 vs 原生二进制）
// ============================================================
// create-app 在装配搜索端口时调用：决定 grep/glob 类的搜索由随包 CLI 自举，还是交给宿主
// 环境里的 bfs / ugrep / rg。两种结果都是纯描述，不探测文件是否存在，也不启动子进程。
// 失败语义：本函数不抛错；二进制缺失会在真正执行时由工具运行时报告。

import type { EmbeddedSearchBackend } from "@zcode/contracts";
import { getRuntimeToolRuntime } from "@zcode/shared";

/** 覆盖入口：设置后改走随包 CLI 的内建搜索，不再解析原生二进制。 */
const EMBEDDED_SEARCH_COMMAND_ENV = "ZCODE_EMBEDDED_SEARCH_COMMAND";
/** internal-cli 子命令名；与随包 CLI 的搜索入口约定一致。 */
const INTERNAL_SEARCH_ENTRYPOINT = "__internal-search";

/**
 * 解析默认搜索后端：环境里给了 ZCODE_EMBEDDED_SEARCH_COMMAND（trim 后非空）时选 internal-cli，
 * 命令取该值、参数固定为内部入口；否则回 native-binaries。
 *
 * 原生模式下三个命令名各自优先读对应工具运行时注册的 binaryEnvVar（bfs / ugrep / rg），
 * 未配置才回落到同名默认值。输出只含命令与参数，不含版本与路径探测。
 */
export function resolveDefaultEmbeddedSearchBackend(input: {
  env?: NodeJS.ProcessEnv;
}): EmbeddedSearchBackend {
  const env = input.env ?? process.env;
  const commandOverride = env[EMBEDDED_SEARCH_COMMAND_ENV]?.trim();
  if (commandOverride) {
    return {
      kind: "internal-cli",
      command: commandOverride,
      args: [INTERNAL_SEARCH_ENTRYPOINT],
    };
  }

  const bfsRuntime = getRuntimeToolRuntime("bfs");
  const ripgrepRuntime = getRuntimeToolRuntime("ripgrep");
  const ugrepRuntime = getRuntimeToolRuntime("ugrep");
  // 注意语义：find 用 bfs，内容搜索用 ugrep，rg 作为另一条内容搜索命令单独下发；
  // 三者互不替代，缺失与否由执行侧判断。
  return {
    kind: "native-binaries",
    findCommand: env[bfsRuntime.binaryEnvVar]?.trim() || "bfs",
    grepCommand: env[ugrepRuntime.binaryEnvVar]?.trim() || "ugrep",
    rgCommand: env[ripgrepRuntime.binaryEnvVar]?.trim() || "rg",
  };
}
