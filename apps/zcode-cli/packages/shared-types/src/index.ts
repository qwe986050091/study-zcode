/**
 * CLI 入口层的共享类型定义。
 *
 * 职责：描述全局运行参数（GlobalOptions）、运行环境快照（RuntimeInfo）以及可序列化
 * 值（JsonValue）等跨模块复用的纯类型。
 * 约束：本文件只声明类型，不包含任何运行期代码；不得在这里引入实现依赖，
 * 否则所有引用方都会被动带入该依赖。
 * 边界：不负责参数解析与校验，解析逻辑在 CLI 入口处完成。
 */

// 递归 JSON 值：用于描述必须可序列化的载荷（落盘、跨进程、日志），
// 禁止用它表示包含 Date/Map 等非 JSON 语义的对象。
export type JsonValue =
  | boolean
  | null
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

// 一次无头运行的进程级上下文：argv 保留原始参数，三个流由调用方注入，
// 便于测试时替换成内存流而不触碰真实终端。
export type RunContext = {
  argv: string[];
  stderr: NodeJS.WriteStream;
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
};

// 用户可配置的语言：auto 表示交给环境探测；GlobalDetectedLocale 是去掉 auto 后的
// 具体值，用于表示「探测已完成」的场景，避免重复探测。
export type GlobalLocale = "auto" | "en-US" | "zh-CN";
export type GlobalDetectedLocale = Exclude<GlobalLocale, "auto">;

/**
 * How a headless run reports itself.
 *
 * `text` prints the answer only. `json` prints one summary document after the
 * turn. `stream-json` additionally writes each session event as its own line
 * (NDJSON) while the turn runs, for callers that drive the CLI as a subprocess
 * and need progress — a bridge rendering a chat UI, for instance — rather than
 * only the finished answer.
 *
 * 中文口径：`text` 只输出最终答案；`json` 在 turn 结束后输出一份汇总文档；
 * `stream-json` 在此基础上把每条 session event 按 NDJSON 逐行写出，供把 CLI 当子进程
 * 驱动的调用方（例如渲染聊天界面的 bridge）获得实时进度。
 */
export type GlobalOutputFormat = "text" | "json" | "stream-json";

// 已解析完成的全局选项。各字段都是「本进程生效」的终态值，
// 优先级（CLI 参数 > 环境变量 > 配置文件）由解析层决定，消费方不应再自行回退。
export type GlobalOptions = {
  browserExecutable?: string;
  browserUse?: "headless";
  detectedLocale?: GlobalDetectedLocale;
  force: boolean;
  json: boolean;
  locale?: GlobalLocale;
  memoryBench?: boolean;
  noColor: boolean;
  outputFormat?: GlobalOutputFormat;
  recordConversation?: boolean;
  recordConversationDir?: string;
  verbose: boolean;
};

// 运行环境快照：一次性采集后即视为只读事实，用于诊断与兼容性判断；
// sea 表示是否运行在单文件可执行（Single Executable Application）形态。
export type RuntimeInfo = {
  arch: NodeJS.Architecture;
  cwd: string;
  execPath: string;
  node: string;
  platform: NodeJS.Platform;
  sea: boolean;
  versions: NodeJS.ProcessVersions;
};
