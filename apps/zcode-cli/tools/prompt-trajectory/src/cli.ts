/**
 * 文件职责：prompt-trajectory 的命令行入口。
 * 用法：`<command> [--flag ...]`，command 由 argv[2] 决定，其余参数按键值对解析。
 * 副作用：进程级——直接读写文件、调用录制/派生流程、设置 process.exitCode，未知命令直接退出。
 * 错误语义：参数错误或业务异常统一捕获，打印 message 并把退出码置 1，不打印堆栈。
 * 不变量：每个命令只走一条分支，命令所需的必填参数在分支内即时校验。
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeDerivedTrajectories } from "./derive.js";
import { writeModelIoAnthropicTrajectory } from "./model-io.js";
import { recordPromptTrajectory, recordPromptTrajectoryFromFixture } from "./record.js";
import {
  createTimestampedPromptDirectory,
  promptFixtureFromText,
  runPromptTrajectoryCases,
  type SharedModelOptions,
} from "./testcases.js";

/**
 * 解析后的命令行选项。
 * 除 ignoreToolSearchChanges 为布尔开关外，其余均为字符串；undefined 表示未提供。
 * 所有字段都是纯运行时参数，不参与序列化；具体必填性由对应 command 分支决定。
 */
interface CliOptions {
  /** 明文 Key；仅供交互调试，避免写入脚本。 */
  apiKey?: string;
  /** Key 所在环境变量名，与 apiKey 互斥使用。 */
  apiKeyEnv?: string;
  /** run-testcases 的用例根目录。 */
  casesDir?: string;
  /** 可选的 Chat Completions 原始请求文件，用于对齐真实请求。 */
  ccRequestPath?: string;
  /** record 的 fixture 路径。 */
  fixturePath?: string;
  /** derive/model-io 的输入轨迹文件。 */
  inputPath?: string;
  /** 是否在派生/转换时忽略 ToolSearch 变化；仅 derive 与 model-io 支持。 */
  ignoreToolSearchChanges?: boolean;
  /** 模型选择串，交给 SharedModelOptions。 */
  modelId?: string;
  /** 输出目录；部分命令必填。 */
  outDir?: string;
  /** 输出根目录，用于自动生成时间戳子目录。 */
  outRoot?: string;
  /** 直接传入的提示文本。 */
  prompt?: string;
  /** 提示文本文件路径，与 prompt 互斥。 */
  promptFile?: string;
  /** model-io 的 querySource 过滤条件。 */
  querySource?: string;
  /** 上游真实基址。 */
  upstreamBaseURL?: string;
}

const command = process.argv[2];
const options = parseOptions(process.argv.slice(3));

try {
  // 该开关只影响比较口径，其余命令无此语义；提前拒绝比静默忽略更安全。
  if (options.ignoreToolSearchChanges && command !== "derive" && command !== "model-io") {
    throw new Error("--ignore-tool-search-changes is only supported by derive and model-io.");
  }
  if (command === "record") {
    requireOption(options.fixturePath, "--fixture");
    requireOption(options.outDir, "--out");
    await recordPromptTrajectory({
      ccRequestPath: options.ccRequestPath,
      fixturePath: options.fixturePath,
      outDir: options.outDir,
    });
  } else if (command === "record-prompt") {
    const prompt = await readPrompt(options);
    const outDir =
      options.outDir ?? (await createTimestampedPromptDirectory(options.outRoot ?? "out"));
    await recordPromptTrajectoryFromFixture({
      ccRequestPath: options.ccRequestPath,
      fixture: promptFixtureFromText({
        modelOptions: readModelOptions(options),
        name: "command-line-prompt",
        prompt,
      }),
      outDir,
    });
    console.log(`Recorded prompt trajectory into ${outDir}`);
  } else if (command === "run-testcases") {
    const result = await runPromptTrajectoryCases({
      casesDir: options.casesDir ?? "testcases",
      modelOptions: readModelOptions(options),
      outRoot: options.outRoot ?? "out",
    });
    console.log(`Recorded ${result.caseCount} prompt trajectory case(s) into ${result.runDir}`);
  } else if (command === "derive") {
    requireOption(options.outDir, "--out");
    await writeDerivedTrajectories({
      ignoreToolSearchChanges: options.ignoreToolSearchChanges,
      ccRequestPath: options.ccRequestPath,
      inputPath: options.inputPath ?? join(options.outDir, "trajectory.jsonl"),
      outDir: options.outDir,
    });
  } else if (command === "model-io") {
    requireOption(options.inputPath, "--input");
    requireOption(options.outDir, "--out");
    await writeModelIoAnthropicTrajectory({
      ignoreToolSearchChanges: options.ignoreToolSearchChanges,
      inputPath: options.inputPath,
      outDir: options.outDir,
      querySource: options.querySource,
    });
    console.log(
      `Converted model-io JSONL into ${join(options.outDir, "anthropic_trajectory.json")}`,
    );
  } else {
    printUsageAndExit();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}

/**
 * 逐项解析命令行参数。
 * 输入：去掉 command 后的 argv 片段。
 * 输出：累积的 CliOptions；未知参数立即抛 Error，不做宽松透传。
 * 副作用：闭包内递增 index 以消费参数值；遇到 "--" 直接跳过。
 * 失败语义：需要值的开关缺少下一个 token 时抛 `Missing value for <flag>`。
 * 不变量：布尔开关不消费后续 token；同名参数重复出现时后值覆盖前值。
 */
function parseOptions(args: readonly string[]): CliOptions {
  const options: CliOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") continue;
    const readValue = (): string => {
      const value = args[index + 1];
      if (!value) throw new Error(`Missing value for ${arg}`);
      index += 1;
      return value;
    };
    if (arg === "--fixture") {
      options.fixturePath = readValue();
    } else if (arg === "--prompt") {
      options.prompt = readValue();
    } else if (arg === "--prompt-file") {
      options.promptFile = readValue();
    } else if (arg === "--cases") {
      options.casesDir = readValue();
    } else if (arg === "--out") {
      options.outDir = readValue();
    } else if (arg === "--out-root") {
      options.outRoot = readValue();
    } else if (arg === "--input") {
      options.inputPath = readValue();
    } else if (arg === "--cc-request") {
      options.ccRequestPath = readValue();
    } else if (arg === "--query-source") {
      options.querySource = readValue();
    } else if (arg === "--ignore-tool-search-changes") {
      options.ignoreToolSearchChanges = true;
    } else if (arg === "--model") {
      options.modelId = readValue();
    } else if (arg === "--upstream-base-url" || arg === "--base-url") {
      options.upstreamBaseURL = readValue();
    } else if (arg === "--api-key-env") {
      options.apiKeyEnv = readValue();
    } else if (arg === "--api-key") {
      options.apiKey = readValue();
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

/**
 * 断言必填选项存在且非空字符串。
 * 输入：可能为 undefined 的值与对应 flag 名（仅用于报错）。
 * 输出：通过时收窄类型；空字符串同样视为缺失，避免把 `""` 当合法路径。
 * 无副作用；失败抛 Error。
 */
function requireOption<T>(value: T | undefined, flag: string): asserts value is T {
  if (value === undefined || value === "") {
    throw new Error(`Missing required option ${flag}`);
  }
}

/**
 * 取得待录制提示文本。
 * 输入：已解析选项，--prompt 与 --prompt-file 二选一。
 * 输出：提示文本；不追加换行、不做 trim。
 * 副作用：promptFile 分支读取文件。
 * 失败语义：两者同时给出、或都未给出时抛 Error。
 * 不变量：选择顺序固定为“内联优先”，但互斥校验先执行。
 */
async function readPrompt(options: CliOptions): Promise<string> {
  if (options.prompt !== undefined && options.promptFile !== undefined) {
    throw new Error("Use only one of --prompt or --prompt-file.");
  }
  if (options.prompt !== undefined) return options.prompt;
  requireOption(options.promptFile, "--prompt-file");
  return readFile(options.promptFile, "utf8");
}

/**
 * 把 CLI 选项收窄为共享模型覆盖。
 * 输入：CliOptions；只取四个模型相关字段。
 * 输出：全未提供时返回 {}，否则返回包含全部键的对象（值为 undefined 的键也保留）。
 * 无副作用；不做校验，模型合法性由 fixture 解析阶段检查。
 */
function readModelOptions(options: CliOptions): SharedModelOptions {
  if (
    options.apiKey === undefined &&
    options.apiKeyEnv === undefined &&
    options.modelId === undefined &&
    options.upstreamBaseURL === undefined
  ) {
    return {};
  }
  return {
    apiKey: options.apiKey,
    apiKeyEnv: options.apiKeyEnv,
    modelId: options.modelId,
    upstreamBaseURL: options.upstreamBaseURL,
  };
}

/**
 * 打印用法并终止进程。
 * 输出：用法文本写到 stderr，退出码固定 1（未知命令视为使用错误）。
 * 副作用：调用 process.exit，不返回；因此返回类型为 never。
 * 注意：该函数绕过外层 try/catch 的错误格式化，属入口层的刻意行为。
 */
function printUsageAndExit(): never {
  console.error(`Usage:
  pnpm --filter @zcode/prompt-trajectory record -- --fixture <fixture.json> --out <dir> [--cc-request <path>]
  pnpm --filter @zcode/prompt-trajectory record:prompt -- --prompt <text> --model <provider/model> --upstream-base-url <url> [--out <dir>] [--api-key-env <env>]
  pnpm --filter @zcode/prompt-trajectory run:testcases -- [--cases <dir>] [--out-root out] --model <provider/model> --upstream-base-url <url> [--api-key-env <env>]
  pnpm --filter @zcode/prompt-trajectory derive -- --out <dir> [--input <trajectory.jsonl>] [--cc-request <path>] [--ignore-tool-search-changes]
  pnpm --filter @zcode/prompt-trajectory model-io -- --input <model-io.jsonl> --out <dir> [--query-source main_turn] [--ignore-tool-search-changes]`);
  process.exit(1);
}
