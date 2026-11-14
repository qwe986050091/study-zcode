/**
 * 文件职责：prompt-trajectory 的 fixture 类型定义与装载/工作区/模型配置构造。
 * fixture 是“一个轨迹用例”的声明式描述，落盘为 JSON，字段全部可序列化。
 * 本文件不含录制逻辑，只把 fixture 及其覆盖参数解析成运行时可用的模型配置与临时工作区。
 * 失败语义：模型身份或 upstreamBaseURL 缺失时显式抛 Error，不做默认猜测。
 */

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * 运行时模型目标配置：写进 runtimeConfig 的单个模型条目。
 * 各字段可选，缺失即“交给运行时默认值”；仅 model/provider 必填以确定调用目标。
 */
export interface RuntimeModelTargetConfig {
  /** 明文 API Key；通常由环境变量解析后填入，避免直接写在 fixture 里。 */
  apiKey?: string;
  /** 是否强制要求 apiKey；缺失表示由调用方/runtime 自行判断。 */
  apiKeyRequired?: boolean;
  /** 请求基址；本工具会指向本地代理，因此通常由构造逻辑注入。 */
  baseURL?: string;
  /** 额外请求头，键值均为字符串；缺失表示不附加。 */
  headers?: Record<string, string>;
  /** provider 适配器种类，如 "openai-compatible"；缺失由运行时决定。 */
  kind?: string;
  /** 模型名（不含 provider 前缀）。必填。 */
  model: string;
  /** 配置项展示名；缺失表示无别名。 */
  name?: string;
  /** provider 标识（如 anthropic/openai）。必填。 */
  provider: string;
  /** provider 私有选项，结构不透明但必须可序列化。 */
  providerOptions?: Record<string, unknown>;
}

/**
 * 运行时模型配置：main 必填，lite/available 可选。
 * 只描述模型选择，不包含鉴权以外的运行参数。
 */
export interface RuntimeModelConfig {
  /** 可切换的模型列表；缺失表示只有 main。 */
  available?: RuntimeModelTargetConfig[];
  /** 轻量任务使用的模型；缺失表示复用 main。 */
  lite?: RuntimeModelTargetConfig;
  /** 主模型，必填。 */
  main: RuntimeModelTargetConfig;
}

/**
 * 单个轨迹用例的完整声明。
 * 输入来源：fixture.json 或由 prompt 文本合成；全部字段可 JSON 序列化。
 * 不变量：name 唯一标识用例；steps 至少一条，否则录制无输入。
 */
export interface PromptTrajectoryFixture {
  /** 模型输入能力声明；缺失表示按模型默认能力，不做探测。 */
  modelInputFormat?: Partial<{
    /** 是否支持文本输入。 */
    supportsText: boolean;
    /** 是否支持图片输入。 */
    supportsImage: boolean;
    /** 是否支持视频输入。 */
    supportsVideo: boolean;
    /** 是否支持音频输入。 */
    supportsAudio: boolean;
    /** 是否支持 PDF 输入。 */
    supportsPdf: boolean;
  }>;
  /** 模型身份与鉴权来源；缺失时由 CLI 覆盖参数补齐，仍缺则报错。 */
  model?: {
    /** 明文 Key，优先级高于 apiKeyEnv。 */
    apiKey?: string;
    /** 存放 Key 的环境变量名；读取失败视为配置错误。 */
    apiKeyEnv?: string;
    /** 是否强制要求 Key；缺失按是否提供 Key 推断。 */
    apiKeyRequired?: boolean;
    /** 上游真实基址；录制时用于转发，必填。 */
    connectionBaseURL?: string;
    /** 连接层 provider 种类提示。 */
    connectionProviderKind?: string;
    /** 附加请求头。 */
    headers?: Record<string, string>;
    /** 形如 provider/model 的标识；与 provider+model 二选一。 */
    id?: string;
    /** provider 适配器种类，默认 "openai-compatible"。 */
    kind?: string;
    /** 模型名（不含 provider）。 */
    model?: string;
    /** provider 标识。 */
    provider?: string;
    /** 上游基址别名，与 connectionBaseURL 同义场景使用。 */
    upstreamBaseURL?: string;
  };
  /** 预置的模型响应序列，按请求顺序消费；缺失表示真实调用上游。 */
  mockResponses?: unknown[];
  /** 用例名，同时用于输出目录与报告展示。必填。 */
  name: string;
  /** 透传给运行时的配置覆盖，结构不透明但需可序列化。 */
  runtimeConfig?: Record<string, unknown>;
  /** 交互步骤序列，按顺序执行。必填。 */
  steps: PromptTrajectoryStep[];
  /** 录制前写入临时工作区的文件，键为相对路径、值为文本内容。 */
  workspaceFiles?: Record<string, string>;
}

/**
 * 交互步骤：提交提示或等待某个事件。
 * 通过 type 判别；缺失 type 视为用例损坏。
 */
export type PromptTrajectoryStep =
  | {
      /** 随提示一起提交的附件；缺失表示纯文本。 */
      attachments?: PromptTrajectoryAttachment[];
      /** 提交给 agent 的提示文本，必填。 */
      text: string;
      /** 判别字段：提交一次提示。 */
      type: "submitPrompt";
    }
  | {
      /** 期望出现的事件次数；缺失默认 1。 */
      count?: number;
      /** 事件类型名，必填；未知类型由调用方处理。 */
      eventType: string;
      /** 等待超时毫秒数；缺失使用全局默认。 */
      timeoutMs?: number;
      /** 判别字段：等待事件。 */
      type: "waitForEvent";
    };

/**
 * 提示附件描述。
 * 输入：path 指向文件，或 content 内联内容；两者至少其一，缺失由运行时报错。
 */
export interface PromptTrajectoryAttachment {
  /** 内联内容；与 path 并存时语义由调用方约定。 */
  content?: string;
  /** 文件/资源路径；跨平台路径由调用方解析。 */
  path?: string;
  /** 附件类型，决定运行时如何处理。必填。 */
  type: "file" | "image" | "pdf" | "url";
}

/**
 * 从磁盘读取并解析 fixture JSON。
 * 输入：fixture 文件路径（相对路径按当前工作目录解析）。
 * 输出：反序列化后的 fixture；不做字段校验，类型断言仅用于编译期。
 * 副作用：读取文件；无写入。
 * 失败语义：文件不存在、JSON 语法错误直接抛出（SyntaxError 原样上抛）。
 */
export async function loadFixture(path: string): Promise<PromptTrajectoryFixture> {
  const { readFile } = await import("node:fs/promises");
  return JSON.parse(await readFile(path, "utf8")) as PromptTrajectoryFixture;
}

/**
 * 为用例创建一次性临时工作区，并写入预置文件。
 * 输入：fixture，只读取 workspaceFiles。
 * 输出：新建临时目录的绝对路径。
 * 副作用：在系统临时目录下 mkdtemp，递归建父目录并写文件；目录不会自动清理，由调用方/系统回收。
 * 失败语义：写文件失败直接抛出，已创建的临时目录保留用于排查。
 * 不变量：workspaceFiles 的相对路径不会逃逸出临时目录（由 join 语义约束，调用方需给出相对路径）。
 */
export async function createFixtureWorkspace(fixture: PromptTrajectoryFixture): Promise<string> {
  // 每个用例独立临时目录，避免用例之间互相污染，也避免写入用户的真实工作区。
  const workspace = await mkdtemp(join(tmpdir(), "zcode-prompt-trajectory-"));
  for (const [relativePath, content] of Object.entries(fixture.workspaceFiles ?? {})) {
    const target = join(workspace, relativePath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }
  return workspace;
}

/**
 * 构造注入运行时的模型配置。
 * 输入：fixture、本地代理基址、环境变量快照；apiKey 优先取 fixture 明文，其次按 apiKeyEnv 读取。
 * 输出：仅含 main 的 RuntimeModelConfig；baseURL 固定指向本地代理，便于录制流量。
 * 副作用：无（只读 env 快照）；不修改 fixture。
 * 失败语义：fixture 无 model、或 apiKeyEnv 指向的变量为空时抛 Error。
 * 不变量：输出的 provider/model 已由 resolveModelTarget 校验过格式。
 */
export function createRuntimeModelConfig(input: {
  fixture: PromptTrajectoryFixture;
  proxyBaseURL: string;
  env: NodeJS.ProcessEnv;
}): RuntimeModelConfig {
  const model = input.fixture.model;
  if (!model) throw new Error("Model config is missing. Provide fixture model.");

  const target = resolveModelTarget(input.fixture);
  // 显式声明优先；否则只要配置了任一 Key 来源，就要求运行时必须提供 Key。
  const apiKey = model.apiKey ?? readApiKey(model, input.env);
  return {
    main: {
      apiKey,
      apiKeyRequired: model.apiKeyRequired ?? Boolean(model.apiKeyEnv || model.apiKey),
      baseURL: input.proxyBaseURL,
      headers: model.headers,
      kind: model.kind ?? "openai-compatible",
      model: target.model,
      provider: target.provider,
    },
  };
}

/**
 * 解析模型选择串，供 CLI --model 参数使用。
 * 输入：fixture；内部复用 resolveModelTarget 的校验。
 * 输出：`provider/model` 拼接字符串，不做额外转义。
 * 失败语义：模型身份缺失时抛 Error。
 */
export function resolveModelSelection(fixture: PromptTrajectoryFixture): string {
  const target = resolveModelTarget(fixture);
  return `${target.provider}/${target.model}`;
}

/**
 * 解析上游真实基址。
 * 输入：fixture；只接受显式 upstreamBaseURL。
 * 输出：非空基址字符串。
 * 失败语义：缺失时抛 Error，而不是回退到 provider 默认地址——录制必须明确流量去向。
 */
export function resolveUpstreamBaseURL(input: { fixture: PromptTrajectoryFixture }): string {
  const explicit = input.fixture.model?.upstreamBaseURL;
  if (explicit) return explicit;
  throw new Error("Fixture model is missing upstreamBaseURL for prompt trajectory recording.");
}

/**
 * 解析模型身份，兼容 provider+model 与 id 两种写法。
 * 输入：fixture 的 model 字段（可为空）。
 * 输出：{ provider, model }；两者都非空才返回。
 * 失败语义：id 不含斜杠、或两个来源都缺失时抛 Error。
 * 不变量：仅按第一个 "/" 切分，模型名中允许再次出现斜杠。
 */
function resolveModelTarget(fixture: PromptTrajectoryFixture): {
  model: string;
  provider: string;
} {
  if (fixture.model?.provider && fixture.model.model) {
    return {
      model: fixture.model.model,
      provider: fixture.model.provider,
    };
  }

  const id = fixture.model?.id;
  // 只认第一个斜杠；缺分隔符时静默截断会连到错误 provider，所以直接报错。
  if (id) {
    const slashIndex = id.indexOf("/");
    if (slashIndex < 0) {
      throw new Error("Fixture model id must be formatted as provider/model.");
    }
    return {
      model: id.slice(slashIndex + 1),
      provider: id.slice(0, slashIndex),
    };
  }

  throw new Error("Model config is missing. Provide fixture model.");
}

/**
 * 按环境变量名读取 API Key。
 * 输入：model 配置与 env 快照；不读取真实 process.env，便于测试注入。
 * 输出：Key 字符串；未配置 apiKeyEnv 时返回 undefined。
 * 失败语义：配置了变量名但变量值为空时抛 Error，避免用空 Key 发起请求后才失败。
 */
function readApiKey(
  model: NonNullable<PromptTrajectoryFixture["model"]>,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const key = model.apiKeyEnv;
  if (!key) return undefined;
  const value = env[key];
  if (!value) {
    throw new Error(`Missing API key env ${key}.`);
  }
  return value;
}
