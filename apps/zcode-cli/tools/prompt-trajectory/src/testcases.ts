/**
 * 文件职责：批量发现、装载与执行 prompt-trajectory 测试用例。
 * 用例目录约定：每个子目录含 prompt.txt 或 fixture.json，且必须有 expect.json 作为基线。
 * 本文件负责目录编排、模型覆盖合并与输出目录命名；真正的录制委托给 record.ts。
 * 副作用：读目录、建输出目录、复制 expect.json、录制写盘。失败时抛出并中止整批。
 * 不变量：用例按 name 字典序执行，输出目录名经清洗，保证跨平台可用的路径片段。
 */

import { copyFile, mkdir, readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { loadFixture, type PromptTrajectoryFixture } from "./fixture.js";
import { recordPromptTrajectoryFromFixture } from "./record.js";

/**
 * 一个已发现的测试用例及其路径。
 * 全部字段为绝对路径（基于 casesDir 拼接），可序列化。
 */
export interface PromptTrajectoryCase {
  /** 用例目录绝对路径。 */
  directory: string;
  /** 基线输出路径，必存在；录制后用其做差异比较。 */
  expectPath: string;
  /** fixture 路径；缺失表示由 prompt.txt 合成 fixture。 */
  fixturePath?: string;
  /** 用例名，取自目录名，用于排序与输出目录。 */
  name: string;
  /** 提示文本路径；与 fixturePath 至少存在其一。 */
  promptPath?: string;
}

/**
 * 跨用例共享的模型覆盖参数。
 * 优先级：显式传入的字段覆盖 fixture 中的同名字段；全部缺失表示不覆盖。
 */
export interface SharedModelOptions {
  /** 明文 Key，优先级最高。 */
  apiKey?: string;
  /** 环境变量名，运行时读取其值作为 Key。 */
  apiKeyEnv?: string;
  /** provider/model 形式或纯模型名，按 fixture 解析规则处理。 */
  modelId?: string;
  /** 上游真实基址。 */
  upstreamBaseURL?: string;
}

/**
 * 扫描用例根目录，返回可执行的用例列表。
 * 输入：casesDir；只扫描一层子目录，不递归。
 * 输出：按 name 字典序排序的用例数组；空目录返回空数组（是否算失败由调用方决定）。
 * 副作用：readdir 与多次 stat 探测。
 * 过滤规则：没有 expect.json 的子目录忽略；prompt.txt 与 fixture.json 都不存在也忽略。
 * 失败语义：casesDir 不存在或不可读时抛出，不返回空数组掩盖错误。
 */
export async function discoverPromptTrajectoryCases(
  casesDir: string,
): Promise<PromptTrajectoryCase[]> {
  const entries = await readdir(casesDir, { withFileTypes: true });
  const cases: PromptTrajectoryCase[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const directory = join(casesDir, entry.name);
    const promptPath = join(directory, "prompt.txt");
    const fixturePath = join(directory, "fixture.json");
    const expectPath = join(directory, "expect.json");
    // 基线缺失说明该目录不是用例，跳过而不是报错，允许目录里混放说明文件。
    if (!(await fileExists(expectPath))) continue;
    const hasPrompt = await fileExists(promptPath);
    const hasFixture = await fileExists(fixturePath);
    if (!hasPrompt && !hasFixture) continue;
    cases.push({
      directory,
      expectPath,
      ...(hasFixture ? { fixturePath } : {}),
      name: entry.name,
      ...(hasPrompt ? { promptPath } : {}),
    });
  }

  return cases.sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * 创建带时间戳的整批运行目录。
 * 输入：输出根目录与基准时间（可注入，便于测试）。
 * 输出：形如 `testYYYYMMDD-HHmmss` 的目录绝对路径。
 * 副作用：递归 mkdir。
 * 失败语义：权限或路径非法时抛错；同名目录已存在时复用（mkdir recursive 不报错）。
 */
export async function createTimestampedRunDirectory(
  outRoot: string,
  now = new Date(),
): Promise<string> {
  const directory = join(outRoot, `test${formatTimestamp(now)}`);
  await mkdir(directory, { recursive: true });
  return directory;
}

/**
 * 创建带时间戳的 prompt 运行目录。
 * 输入：输出根目录与基准时间。
 * 输出：形如 `promptYYYYMMDD-HHmmss` 的目录绝对路径。
 * 副作用：递归 mkdir；与运行目录同名规则一致，仅前缀不同，便于并列存放。
 * 失败语义：同 createTimestampedRunDirectory。
 */
export async function createTimestampedPromptDirectory(
  outRoot: string,
  now = new Date(),
): Promise<string> {
  const directory = join(outRoot, `prompt${formatTimestamp(now)}`);
  await mkdir(directory, { recursive: true });
  return directory;
}

/**
 * 把用例转换为可执行的 fixture。
 * 输入：用例与可选的共享模型覆盖。
 * 输出：合并覆盖后的 fixture；fixture.json 优先，没有时由 prompt.txt 合成。
 * 副作用：读取 fixture 或 prompt 文件。
 * 失败语义：既无 fixture 也无 prompt 时抛 Error；JSON 解析失败原样上抛。
 * 不变量：返回的 fixture 必带可用的 model 身份与 upstreamBaseURL（由 requireExplicitModel 保证）。
 */
export async function promptFixtureFromCase(
  testcase: PromptTrajectoryCase,
  modelOptions?: SharedModelOptions,
): Promise<PromptTrajectoryFixture> {
  if (testcase.fixturePath) {
    const fixture = await loadFixture(testcase.fixturePath);
    return mergeFixtureModelOptions(fixture, modelOptions);
  }
  if (!testcase.promptPath) {
    // 到这里说明目录标记为用例却没有任何输入来源，属于用例目录损坏，不能静默跳过。
    throw new Error(`Prompt trajectory case ${testcase.name} is missing prompt.txt or fixture.json`);
  }
  return promptFixtureFromText({
    modelOptions,
    name: testcase.name,
    prompt: await readFile(testcase.promptPath, "utf8"),
  });
}

/**
 * 把共享模型覆盖合并进 fixture。
 * 输入：原始 fixture 与覆盖参数；覆盖只作用于 model 字段，其他字段原样保留。
 * 输出：新 fixture（浅拷贝），不修改入参。
 * 失败语义：合并后仍缺模型身份/upstreamBaseURL 时抛出。
 * 不变量：未提供覆盖时保持 fixture.model 引用值不变。
 */
function mergeFixtureModelOptions(
  fixture: PromptTrajectoryFixture,
  modelOptions?: SharedModelOptions,
): PromptTrajectoryFixture {
  const model = createFixtureModel(modelOptions);
  const merged = {
    ...fixture,
    ...(model
      ? {
          model: {
            ...fixture.model,
            ...model,
          },
        }
      : {}),
  };
  requireExplicitModel(merged.model);
  return merged;
}

/**
 * 由提示文本合成最小 fixture。
 * 输入：提示文本、用例名与可选模型覆盖。
 * 输出：单步 submitPrompt 的 fixture，runtimeConfig 固定为 yolo + 流式开启。
 * 副作用：无文件 I/O。
 * 失败语义：模型未显式给出或缺少 upstreamBaseURL 时抛 Error。
 * 不变量：steps 恰好一条，保证合成用例只提交一次提示。
 */
export function promptFixtureFromText(input: {
  modelOptions?: SharedModelOptions;
  name: string;
  prompt: string;
}): PromptTrajectoryFixture {
  const model = createFixtureModel(input.modelOptions);
  requireExplicitModel(model);

  return {
    model,
    name: input.name,
    runtimeConfig: {
      mode: "yolo",
      modelStreaming: "on",
    },
    steps: [
      {
        text: input.prompt,
        type: "submitPrompt",
      },
    ],
  };
}

/**
 * 断言 fixture 模型身份与上游基址齐备。
 * 输入：可能不完整的 model。
 * 输出：通过时以断言签名收窄类型；不通过抛 Error。
 * 用途：录制前拦截配置错误，避免请求打向错误地址或缺少 provider。
 * 判定口径：id 或 provider+model 至少一种，且必须显式 upstreamBaseURL。
 */
function requireExplicitModel(
  model: PromptTrajectoryFixture["model"] | undefined,
): asserts model is NonNullable<PromptTrajectoryFixture["model"]> {
  const hasIdentity = Boolean(model?.id || (model?.provider && model.model));
  if (!hasIdentity || !model?.upstreamBaseURL) {
    throw new Error(
      "Explicit model options are required: provide provider/model and upstreamBaseURL.",
    );
  }
}

/**
 * 批量执行所有用例，把产物写入新运行目录。
 * 输入：用例根目录、输出根目录与可选模型覆盖。
 * 输出：{ caseCount, runDir }；runDir 为本次运行目录。
 * 副作用：建目录、复制 expect.json、逐用例录制写盘。
 * 失败语义：未发现任何用例时抛 Error；任一用例失败即中止，已生成产物保留。
 * 不变量：每个用例输出到 `runDir/<sanitized name>/`，目录名互不冲突且跨平台可用。
 */
export async function runPromptTrajectoryCases(input: {
  casesDir: string;
  modelOptions?: SharedModelOptions;
  outRoot: string;
}): Promise<{
  caseCount: number;
  runDir: string;
}> {
  const cases = await discoverPromptTrajectoryCases(input.casesDir);
  if (cases.length === 0) {
    throw new Error(`No prompt trajectory cases found in ${input.casesDir}`);
  }

  const runDir = await createTimestampedRunDirectory(input.outRoot);
  for (const testcase of cases) {
    const caseOutDir = join(runDir, sanitizeCaseName(testcase.name));
    await mkdir(caseOutDir, { recursive: true });
    // 先复制基线再录制：即使用例中途失败，输出目录里仍能看到期望值便于对照。
    await copyFile(testcase.expectPath, join(caseOutDir, "expect.json"));
    await recordPromptTrajectoryFromFixture({
      fixture: await promptFixtureFromCase(testcase, input.modelOptions),
      outDir: caseOutDir,
    });
  }

  return {
    caseCount: cases.length,
    runDir,
  };
}

/**
 * 由共享覆盖参数构造 fixture 的 model 片段。
 * 输入：可选的 SharedModelOptions。
 * 输出：仅含被显式提供字段的 model 对象；一个字段都没有时返回 undefined，表示不覆盖。
 * 不变量：返回对象时 kind 固定为 "openai-compatible"，与录制代理协议一致。
 */
function createFixtureModel(
  modelOptions: SharedModelOptions | undefined,
): PromptTrajectoryFixture["model"] | undefined {
  if (!modelOptions) return undefined;
  const model: PromptTrajectoryFixture["model"] = {};
  if (modelOptions.modelId !== undefined) {
    model.id = modelOptions.modelId;
  }
  if (modelOptions.upstreamBaseURL !== undefined) {
    model.upstreamBaseURL = modelOptions.upstreamBaseURL;
  }
  if (modelOptions.apiKey !== undefined) {
    model.apiKey = modelOptions.apiKey;
  }
  if (modelOptions.apiKeyEnv !== undefined) {
    model.apiKeyEnv = modelOptions.apiKeyEnv;
  }
  if (Object.keys(model).length === 0) return undefined;
  model.kind = "openai-compatible";
  return model;
}

/**
 * 生成 `YYYYMMDD-HHmmss` 格式的本地时间戳。
 * 输入：Date 对象；不做时区转换，直接取本地时间字段。
 * 输出：定长字符串，可直接嵌入目录名。
 * 用途：目录名可排序、可读；同一秒内多次运行会复用同一目录。
 */
function formatTimestamp(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    "-",
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join("");
}

/**
 * 把用例名清洗为安全的单层目录名。
 * 输入：任意用例名；先取 basename 防止路径穿越。
 * 输出：仅保留字母、数字、点、下划线、连字符；清洗后为空则回退 "case"。
 * 无副作用；不保证唯一性，重名由调用方负责。
 */
function sanitizeCaseName(name: string): string {
  const sanitized = basename(name).replace(/[^a-zA-Z0-9._-]+/gu, "_");
  return sanitized.length > 0 ? sanitized : "case";
}

/**
 * 判断路径是否为已存在的普通文件。
 * 输入：路径；目录、符号链接目标非文件时均返回 false。
 * 输出：布尔值；任何 stat 错误都吞掉并返回 false，用于目录探测而非错误上报。
 */
async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
