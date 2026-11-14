/**
 * 文件职责：录制一次提示轨迹——启动本地 provider 代理、构建 app、执行 fixture 步骤并落盘派生结果。
 * 输入：fixture（含模型配置与步骤）与输出目录；可选原始 CC 请求路径。
 * 副作用：建输出目录、打开 trajectory.jsonl 账本、进程内启动代理与 app、网络转发、写派生文件。
 * 失败语义：运行时模块缺失、fixture 配置不合法、等待超时或步骤失败时抛出；
 * finally 保证关闭 app、代理与账本，避免句柄泄漏。
 * 不变量：账本每请求写一条骨架 + N 条消息；派生只在录制成功后于同一 outDir 生成。
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { writeDerivedTrajectories } from "./derive.js";
import {
  createFixtureWorkspace,
  createRuntimeModelConfig,
  loadFixture,
  resolveModelSelection,
  resolveUpstreamBaseURL,
  type PromptTrajectoryAttachment,
  type PromptTrajectoryFixture,
  type PromptTrajectoryStep,
  type RuntimeModelConfig,
} from "./fixture.js";
import { MessageLedger } from "./message-ledger.js";
import { startOpenAiProviderProxy } from "./openai-provider-proxy.js";

/**
 * 动态加载的运行时 bootstrap 模块契约。
 * 只在运行时按 dist 路径 import，因此用结构化接口而非直接类型引用。
 */
interface ZCodeBootstrapModule {
  /** 创建模型适配器；入参由录制流程构造。 */
  createModelAdapter(input: unknown): unknown;
  /** 创建 ZCode 应用；返回可关闭句柄与提交提示能力。 */
  createZCodeApp(input: unknown): Promise<{
    /** 释放应用资源；缺失表示无需关闭。 */
    close?: () => Promise<void>;
    /** 提交一次用户提示，返回运行结果。 */
    submitPrompt(prompt: RecorderPromptInput): Promise<unknown>;
  }>;
}

/**
 * 提交给 app 的提示形态：纯文本，或带附件的对象。
 * 纯文本是常见路径；附件为空时不应包装成对象，避免下游误判。
 */
type RecorderPromptInput =
  | string
  | {
      attachments?: PromptTrajectoryAttachment[];
      text: string;
    };

interface ZCodeContractsModule {
  parseModelSelection(input: string): unknown;
}

interface ConfigConstructor {
  new (input?: unknown): unknown;
}

interface ProviderRegistryConstructor {
  new (providers?: readonly unknown[]): unknown;
}

interface ZCodeProviderModule {
  ApiKeyAccessConfig: ConfigConstructor;
  ModelConfig: ConfigConstructor;
  ModelOptionSpecsConfig: ConfigConstructor;
  ModelPropertiesConfig: ConfigConstructor;
  ProviderApiConfig: ConfigConstructor;
  ProviderConfig: ConfigConstructor;
  ProviderRegistry: ProviderRegistryConstructor;
}

interface RuntimeSessionEvent {
  type?: unknown;
}

/**
 * 运行时事件观察器。
 * sink 接收 app 广播的会话事件；waitForEvent 按类型与数量阻塞等待。
 */
interface RuntimeEventObserver {
  /** 事件接收端，由 app 调用。 */
  sink: {
    /** 同步记录事件；不得抛错影响 app 的事件分发。 */
    onSessionEvent(event: RuntimeSessionEvent): void;
  };
  /** 等待指定类型的事件达到 count 次；超时 reject。 */
  waitForEvent(input: { count?: number; eventType: string; timeoutMs?: number }): Promise<void>;
}

/**
 * 从 fixture 文件录制轨迹。
 * 输入：fixture 路径、输出目录、可选 CC 请求路径。
 * 输出：无；所有产物写入 outDir。
 * 副作用：读取并解析 fixture，随后委托 recordPromptTrajectoryFromFixture 完成录制。
 * 失败语义：文件缺失或 JSON 非法时抛出，不做默认 fixture 兜底。
 */
export async function recordPromptTrajectory(input: {
  ccRequestPath?: string;
  fixturePath: string;
  outDir: string;
}): Promise<void> {
  await recordPromptTrajectoryFromFixture({
    ccRequestPath: input.ccRequestPath,
    fixture: await loadFixture(input.fixturePath),
    outDir: input.outDir,
  });
}

/**
 * 用已解析的 fixture 录制并派生轨迹。
 * 输入：fixture、outDir、可选 CC 请求路径。
 * 输出：无；写 trajectory.jsonl 与同目录派生产物。
 * 副作用：建目录、开账本、启动本地 OpenAI 代理、动态加载运行时模块、创建 app 与临时工作区。
 * 失败语义：任一阶段失败向上抛出；finally 固定按 app -> 代理 -> 账本顺序清理。
 * 不变量：无论成功失败账本都会关闭；派生只在录制成功后执行，避免半截数据产出轨迹。
 */
export async function recordPromptTrajectoryFromFixture(input: {
  ccRequestPath?: string;
  fixture: PromptTrajectoryFixture;
  outDir: string;
}): Promise<void> {
  await mkdir(input.outDir, { recursive: true });
  const jsonlPath = join(input.outDir, "trajectory.jsonl");
  const fixture = input.fixture;
  const ledger = await MessageLedger.open(jsonlPath);
  let closeProxy: (() => Promise<void>) | undefined;
  let closeApp: (() => Promise<void>) | undefined;

  try {
    const { bootstrap, contracts, provider } = await loadZCodeModules();
    const proxy = await startOpenAiProviderProxy({
      ledger,
      mockResponses: fixture.mockResponses,
      upstreamBaseURL: resolveUpstreamBaseURL({ fixture }),
    });
    closeProxy = proxy.close;
    const modelConfig = createRuntimeModelConfig({
      env: process.env,
      fixture,
      proxyBaseURL: proxy.baseURL,
    });
    const modelAdapter = bootstrap.createModelAdapter({
      env: process.env,
      registryConfig: {
        providers: {},
      },
    });
    const recorderModelAdapter = wrapModelAdapterConnectionForFixture(modelAdapter, fixture);
    const workspace = await createFixtureWorkspace(fixture);
    const modelSelection = contracts.parseModelSelection(resolveModelSelection(fixture));
    const eventObserver = createRuntimeEventObserver();
    const providerRegistry = createRecorderProviderRegistry(provider, modelConfig, fixture);
    const app = await bootstrap.createZCodeApp({
      eventSink: eventObserver.sink,
      env: process.env,
      modelAdapter: recorderModelAdapter,
      providerRegistry,
      runtimeConfig: buildRecorderRuntimeConfig({
        fixture,
        modelSelection,
        workingDirectory: workspace,
      }),
      skipUserConfig: true,
    });
    closeApp = async () => {
      await app.close?.();
    };

    await executeFixtureSteps({ app, eventObserver, steps: fixture.steps });
  } finally {
    await closeApp?.();
    await closeProxy?.();
    await ledger.close();
  }

  await writeDerivedTrajectories({
    ccRequestPath: input.ccRequestPath,
    inputPath: jsonlPath,
    outDir: input.outDir,
  });
}

/**
 * 按 fixture 覆盖模型适配器的连接解析结果。
 * 输入：原始 adapter 与 fixture；未配置 connectionBaseURL/providerKind 时原样返回，零开销。
 * 输出：Proxy 包装或原 adapter。
 * 副作用：无；Proxy 仅在读取 resolveConnection 时拦截。
 * 失败语义：adapter 未暴露 resolveConnection 时抛 Error，避免静默忽略覆盖配置。
 */
function wrapModelAdapterConnectionForFixture(
  modelAdapter: unknown,
  fixture: PromptTrajectoryFixture,
): unknown {
  const connectionBaseURL = fixture.model?.connectionBaseURL;
  const connectionProviderKind = fixture.model?.connectionProviderKind;
  if (!connectionBaseURL && !connectionProviderKind) return modelAdapter;

  return new Proxy(modelAdapter as Record<PropertyKey, unknown>, {
    get(target, property, receiver) {
      if (property === "resolveConnection") {
        return (model: unknown) => {
          // 覆盖发生在解析结果之上，而不是改 adapter 内部状态，保证其他连接配置仍生效。
          const baseResolve = Reflect.get(target, property, receiver);
          if (typeof baseResolve !== "function") {
            throw new Error("Model adapter does not expose resolveConnection.");
          }
          const connection = baseResolve.call(target, model) as Record<string, unknown>;
          return {
            ...connection,
            ...(connectionBaseURL ? { baseURL: connectionBaseURL } : {}),
            ...(connectionProviderKind ? { providerKind: connectionProviderKind } : {}),
          };
        };
      }

      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/**
 * 按顺序执行 fixture 步骤。
 * 输入：app 的 submitPrompt、事件观察器与步骤数组。
 * 输出：无；全部步骤完成后 resolve。
 * 副作用：向 app 提交提示、阻塞等待运行时事件。
 * 失败语义：等待超时抛 Error；未知步骤类型由 assertNever 抛错。
 * 不变量：严格串行，前一步完成后才进入下一步。
 */
export async function executeFixtureSteps(input: {
  app: {
    submitPrompt(prompt: RecorderPromptInput): Promise<unknown>;
  };
  eventObserver: RuntimeEventObserver;
  steps: readonly PromptTrajectoryStep[];
}): Promise<void> {
  for (const step of input.steps) {
    if (step.type === "submitPrompt") {
      await input.app.submitPrompt(
        step.attachments?.length ? { attachments: step.attachments, text: step.text } : step.text,
      );
      continue;
    }
    if (step.type === "waitForEvent") {
      await input.eventObserver.waitForEvent({
        count: step.count,
        eventType: step.eventType,
        timeoutMs: step.timeoutMs,
      });
      continue;
    }
    assertNever(step);
  }
}

/**
 * 创建轻量事件观察器：记录会话事件并支持按类型/数量等待。
 * 输出：{ sink, waitForEvent }。
 * 副作用：事件保存在内存；waitForEvent 使用 setTimeout 计时，不写盘。
 * 失败语义：超时 reject，错误信息包含类型、数量与超时毫秒数。
 * 不变量：事件按到达顺序保存；满足条件的等待者只结算一次并清理定时器。
 */
function createRuntimeEventObserver(): RuntimeEventObserver {
  const events: RuntimeSessionEvent[] = [];
  const waiters = new Set<{
    count: number;
    eventType: string;
    resolve(): void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  const matchingCount = (eventType: string): number =>
    events.filter((event) => event.type === eventType).length;

  const settleReadyWaiters = (): void => {
    for (const waiter of waiters) {
      // 所有等待者共享同一事件缓冲，每来一个事件就统一复检，避免为每个等待者单独扫描。
      if (matchingCount(waiter.eventType) < waiter.count) continue;
      clearTimeout(waiter.timer);
      waiters.delete(waiter);
      waiter.resolve();
    }
  };

  return {
    sink: {
      onSessionEvent(event) {
        events.push(event);
        settleReadyWaiters();
      },
    },
    waitForEvent(input) {
      const count = input.count ?? 1;
      if (matchingCount(input.eventType) >= count) return Promise.resolve();

      return new Promise<void>((resolve, reject) => {
        const timeoutMs = input.timeoutMs ?? 10_000;
        const waiter = {
          count,
          eventType: input.eventType,
          resolve,
          timer: setTimeout(() => {
            waiters.delete(waiter);
            reject(
              new Error(
                `Timed out waiting for ${count} ${input.eventType} event(s) after ${timeoutMs}ms.`,
              ),
            );
          }, timeoutMs),
        };
        waiters.add(waiter);
      });
    },
  };
}

/**
 * 穷尽检查：未知步骤类型在此抛错。
 * 用途：新增 step 类型时让编译期报错，而不是运行时静默跳过。
 */
function assertNever(value: never): never {
  throw new Error(`Unsupported fixture step: ${JSON.stringify(value)}`);
}

/**
 * 动态加载运行时依赖的已构建产物。
 * 输入：无；路径全部相对本文件 dist 位置解析。
 * 输出：合并后的 bootstrap/contracts/provider 模块。
 * 副作用：执行四次动态 import，会触发目标模块的顶层副作用。
 * 失败语义：任一 import 失败时抛带构建指引的 Error，并保留原始 cause。
 * 不变量：provider 模块由 config 与 registry 两部分拼成，键集合需保持完整。
 */
async function loadZCodeModules(): Promise<{
  bootstrap: ZCodeBootstrapModule;
  contracts: ZCodeContractsModule;
  provider: ZCodeProviderModule;
}> {
  const bootstrapPath = pathToFileURL(
    join(import.meta.dirname, "../../../packages/bootstrap/dist/index.js"),
  ).href;
  const contractsPath = pathToFileURL(
    join(import.meta.dirname, "../../../packages/contracts/dist/index.js"),
  ).href;
  const providerConfigPath = pathToFileURL(
    join(import.meta.dirname, "../../../../../packages/provider/dist/config/index.js"),
  ).href;
  const providerRegistryPath = pathToFileURL(
    join(import.meta.dirname, "../../../../../packages/provider/dist/registry.js"),
  ).href;
  try {
    // 并行加载四个独立构建入口，缩短录制启动时间；任一路径缺失都会进入统一报错。
    const [bootstrap, contracts, providerConfig, providerRegistry] = await Promise.all([
      import(bootstrapPath) as Promise<ZCodeBootstrapModule>,
      import(contractsPath) as Promise<ZCodeContractsModule>,
      import(providerConfigPath) as Promise<Omit<ZCodeProviderModule, "ProviderRegistry">>,
      import(providerRegistryPath) as Promise<Pick<ZCodeProviderModule, "ProviderRegistry">>,
    ]);
    return {
      bootstrap,
      contracts,
      provider: { ...providerConfig, ...providerRegistry },
    };
  } catch (error) {
    throw new Error(
      "Missing built zcode-cli packages. Run `pnpm --filter @zcode/bootstrap^... build && pnpm --filter @zcode/bootstrap build` before `record`.",
      { cause: error },
    );
  }
}

/**
 * 为录制构造只包含单一 provider/model 的注册表。
 * 输入：provider 模块、运行时模型配置与 fixture。
 * 输出：ProviderRegistry 实例。
 * 副作用：构造运行时对象，无 I/O。
 * 失败语义：main.baseURL 缺失时抛 Error；apiFormat 由 kind 映射，未知 kind 回退 chat-completions。
 * 不变量：模型能力默认全开、限制上限，再以 fixture.modelInputFormat 覆盖，保证录制尽量不因能力门禁中断。
 */
function createRecorderProviderRegistry(
  provider: ZCodeProviderModule,
  modelConfig: RuntimeModelConfig,
  fixture: PromptTrajectoryFixture,
): unknown {
  const target = modelConfig.main;
  if (!target.baseURL) {
    throw new Error("Prompt trajectory Provider is missing baseURL");
  }
  const apiFormat =
    // kind 只用于挑 API 形状；未知值回退 chat-completions，保证本地代理仍能匹配请求路径。
    target.kind === "anthropic"
      ? "anthropic-messages"
      : target.kind === "openai"
        ? "openai-responses"
        : "openai-chat-completions";
  const providerConfig = new provider.ProviderConfig({
    access: new provider.ApiKeyAccessConfig({
      apiKey: target.apiKey ?? "prompt-trajectory-key",
    }),
    api: new provider.ProviderApiConfig({
      type: apiFormat,
      baseURL: target.baseURL,
      headers: target.headers,
    }),
    models: [target.model],
    enabled: true,
  });
  const registryModelConfig = new provider.ModelConfig({
    properties: new provider.ModelPropertiesConfig({
      contextWindow: 1_000_000,
      inputFormat: {
        supportsText: true,
        supportsImage: true,
        supportsVideo: true,
        supportsAudio: false,
        supportsPdf: true,
        ...fixture.modelInputFormat,
      },
      outputFormat: { supportsText: true },
      supportsToolCall: true,
      supportsJsonSchemaOutput: true,
      supportsNativeWebSearch: false,
      supportsMidConversationSystem: true,
    }),
    optionSpecs: new provider.ModelOptionSpecsConfig({
      maxOutputTokens: { max: 1_000_000 },
    }),
  });
  return new provider.ProviderRegistry([
    {
      providerId: target.provider,
      config: providerConfig,
      models: [{ modelId: target.model, config: registryModelConfig }],
    },
  ]);
}

/**
 * 组装录制专用运行时配置。
 * 输入：fixture、已解析的模型选择与工作目录。
 * 输出：新配置对象，fixture.runtimeConfig 作为基底。
 * 无文件副作用；不修改入参。
 * 口径：默认关闭 mcp/memory/titleGeneration 与 subagents，mode 默认 yolo、streaming 默认 on，
 * 确保录制不依赖外部环境，也不额外触发其他模型调用。
 */
export function buildRecorderRuntimeConfig(input: {
  fixture: PromptTrajectoryFixture;
  modelSelection: unknown;
  workingDirectory: string;
}): Record<string, unknown> {
  const fixtureRuntimeConfig = input.fixture.runtimeConfig;

  return {
    ...fixtureRuntimeConfig,
    compact: fixtureRuntimeConfig?.compact,
    mcp: { enabled: false },
    memory: { enabled: false },
    mode: fixtureRuntimeConfig?.mode ?? "yolo",
    modelSelection: input.modelSelection,
    modelStreaming: fixtureRuntimeConfig?.modelStreaming ?? "on",
    outputStyle: fixtureRuntimeConfig?.outputStyle,
    subagents: fixtureRuntimeConfig?.subagents ?? { enabled: false },
    titleGeneration: { enabled: false },
    workingDirectory: input.workingDirectory,
  };
}
