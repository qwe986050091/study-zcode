// 端到端故障注入：按环境变量里的规则，在指定 fs 操作点上抛出可识别的错误。
// 设计目标是「默认绝不启用」：没有 ZCODE_E2E_FS_FAULTS 时是空规则集，调用点只多一次长度判断；
// 变量存在但未声明测试环境、也未显式允许时同样不启用。
// INV-01：isEnabled() 为 false 时 maybeThrow 不分配、不记 hit、不抛错，主链路零副作用。
// INV-02：同一注入器内命中计数只增不减，maxMatches 是跨调用累计而非单次调用。
// INV-03：抛出的错误同时具备 code/path/syscall 与 zcodeFsFaultId，上层可按真实 errno 处理。
// INV-04：环境解析失败必须抛错而非静默降级，配置写错时应立即暴露而不是跑出假通过。
// INV-05：hits 只记录已发生的注入，reset 同时清零计数，避免二次注入用到已耗尽的规则。
export const ZCODE_E2E_FS_FAULTS_ENV = "ZCODE_E2E_FS_FAULTS";
export const ZCODE_E2E_FS_FAULTS_ALLOW_ENV = "ZCODE_E2E_FS_FAULTS_ALLOW";

// "any" 是通配而不是真实 syscall：规则省略 operations 时会落到它，
// 因此新增操作点时不需要回头改已有规则。
export type FsFaultOperation =
  | "any"
  | "appendFile"
  | "createWriteStream"
  | "mkdir"
  | "open"
  | "readFile"
  | "readdir"
  | "rename"
  | "rm"
  | "sqliteOpen"
  | "sqliteRun"
  | "stat"
  | "writeFile";

// 规则只描述「匹配什么」与「抛什么」，不含执行逻辑：解析与匹配分离，
// 使 env 反序列化可以独立校验形状（parseFsFaultRulesFromEnvValue 只做顶层检查）。
export interface FsFaultRuleConfig {
  id: string;
  code: string;
  operations?: readonly FsFaultOperation[];
  pathIncludes?: string;
  pathEndsWith?: string;
  pathRegex?: string;
  maxMatches?: number;
  message?: string;
}

export interface FsFaultCheckInput {
  operation: FsFaultOperation;
  path: string;
}

// hit 是给测试断言用的观测记录：matchIndex 从 1 开始，等于该规则的第几次命中，
// 用它可以在「只失败前两次」这类场景里核对轮次。
export interface FsFaultHit {
  id: string;
  code: string;
  operation: FsFaultOperation;
  path: string;
  matchIndex: number;
  matchedAt: string;
}

// 继承 ErrnoException 是为了让现有 catch 分支（判断 error.code）原样工作；
// zcodeFsFaultId 是唯一标记，业务代码据此区分「真实磁盘错误」与「注入」。
export interface InjectedFsFaultError extends NodeJS.ErrnoException {
  zcodeFsFaultId: string;
}

// 接口刻意保持最小：isEnabled 让热路径先短路，maybeThrow 只在命中时抛，
// getHits/reset 仅测试使用，不进入生产读取路径。
export interface FsFaultInjector {
  isEnabled(): boolean;
  maybeThrow(input: FsFaultCheckInput): void;
  getHits(): readonly FsFaultHit[];
  reset(): void;
}

// 归一化后的规则：路径与正则已预处理，operations 已成 Set，匹配阶段不再做字符串转换；
// matchedCount 是可变的运行态，与配置字段放在一起但不回写原配置对象。
interface NormalizedFsFaultRule {
  code: string;
  id: string;
  maxMatches: number;
  message?: string;
  operations: ReadonlySet<FsFaultOperation>;
  pathEndsWith?: string;
  pathIncludes?: string;
  pathRegex?: RegExp;
  matchedCount: number;
}

// 白名单必须与 FsFaultOperation 联合类型同步：漏掉某个操作会让规则在运行期
// 静默匹配不上（而不是报错），属于最难排查的「注入没生效」。
const SUPPORTED_OPERATIONS = new Set<FsFaultOperation>([
  "any",
  "appendFile",
  "createWriteStream",
  "mkdir",
  "open",
  "readFile",
  "readdir",
  "rename",
  "rm",
  "sqliteOpen",
  "sqliteRun",
  "stat",
  "writeFile",
]);

// 统一成正斜杠再比较：Windows 下调用方可能传反斜杠，
// 而规则是手写在 JSON 里的，不能要求作者同时考虑两种分隔符。
function normalizePathForFaultMatch(path: string): string {
  return path.replace(/\\/g, "/");
}

function normalizePathPattern(pattern: string | undefined): string | undefined {
  return pattern === undefined ? undefined : normalizePathForFaultMatch(pattern);
}

// 配置来自环境变量，形状不可信：所有字段先做类型与空串校验再 trim；
// 报错带 ruleIndex，避免多条规则时无法定位是哪一条写错。
function assertNonEmptyString(value: unknown, field: string, ruleIndex: number): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Invalid fs fault rule at index ${ruleIndex}: ${field} must be a non-empty string`);
  }
  return value.trim();
}

// 省略 operations 等价于 ["any"]，让「所有 fs 操作都失败」这种粗粒度规则不必罗列全部操作名；
// 空数组则视为配置错误，不猜测作者意图。
function parseOperations(value: unknown, ruleIndex: number): readonly FsFaultOperation[] {
  if (value === undefined) {
    return ["any"];
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Invalid fs fault rule at index ${ruleIndex}: operations must be a non-empty array`);
  }
  return value.map((operation) => {
    if (typeof operation !== "string" || !SUPPORTED_OPERATIONS.has(operation as FsFaultOperation)) {
      throw new Error(
        `Invalid fs fault rule at index ${ruleIndex}: unsupported operation ${String(operation)}`,
      );
    }
    return operation as FsFaultOperation;
  });
}

// 默认 1 而不是 0：规则最常见的用途是「只失败一次」，0 表示无限次；
// 若默认成 0，忘了写 maxMatches 的规则会把整个用例永久打死。
function parseMaxMatches(value: unknown, ruleIndex: number): number {
  if (value === undefined) {
    return 1;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`Invalid fs fault rule at index ${ruleIndex}: maxMatches must be a non-negative integer`);
  }
  return value;
}

// 可选字段只接受 undefined 与 string：null 不当作「未设置」，
// 否则 JSON 里写 null 会静默变成「不限制」，与作者预期相反。
function parseOptionalString(value: unknown, field: string, ruleIndex: number): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`Invalid fs fault rule at index ${ruleIndex}: ${field} must be a string`);
  }
  return value;
}

// 归一化只在构造注入器时做一次，匹配热路径因此只剩 Set 查找与字符串比较；
// 正则也在这里编译，保证非法模式在启动期暴露，而不是第一次命中才抛。
function normalizeRule(input: FsFaultRuleConfig, ruleIndex: number): NormalizedFsFaultRule {
  const record = input as unknown as Record<string, unknown>;
  const id = assertNonEmptyString(record.id, "id", ruleIndex);
  const code = assertNonEmptyString(record.code, "code", ruleIndex);
  const operations = new Set(parseOperations(record.operations, ruleIndex));
  const maxMatches = parseMaxMatches(record.maxMatches, ruleIndex);
  const pathIncludes = normalizePathPattern(parseOptionalString(record.pathIncludes, "pathIncludes", ruleIndex));
  const pathEndsWith = normalizePathPattern(parseOptionalString(record.pathEndsWith, "pathEndsWith", ruleIndex));
  const pathRegexRaw = parseOptionalString(record.pathRegex, "pathRegex", ruleIndex);
  const message = parseOptionalString(record.message, "message", ruleIndex);

  let pathRegex: RegExp | undefined;
  if (pathRegexRaw !== undefined) {
    try {
// [失败路径] 正则非法时包装成带 ruleIndex 的错误：原生 SyntaxError 不含规则位置，
// 在几十条规则里无法定位；这里保留原始 message 作为原因。
      pathRegex = new RegExp(pathRegexRaw);
    } catch (error) {
      throw new Error(
        `Invalid fs fault rule at index ${ruleIndex}: pathRegex is invalid: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  return {
    code,
    id,
    matchedCount: 0,
    maxMatches,
    message,
    operations,
    pathEndsWith,
    pathIncludes,
    pathRegex,
  };
}

// "any" 在规则内部即通配全部操作，不必与具体操作名并列；
// 用 Set 而不是数组，是因为每次 fs 调用都会走一次这个判断。
function operationMatches(rule: NormalizedFsFaultRule, operation: FsFaultOperation): boolean {
  return rule.operations.has("any") || rule.operations.has(operation);
}

// 三个路径条件彼此是与关系，且都在同一份归一化路径上判断：
// includes 用于「某个目录下」，endsWith 用于精确文件，regex 用于其余复杂场景。
function pathMatches(rule: NormalizedFsFaultRule, path: string): boolean {
  const normalizedPath = normalizePathForFaultMatch(path);
  if (rule.pathIncludes !== undefined && !normalizedPath.includes(rule.pathIncludes)) {
    return false;
  }
  if (rule.pathEndsWith !== undefined && !normalizedPath.endsWith(rule.pathEndsWith)) {
    return false;
  }
  if (rule.pathRegex !== undefined && !rule.pathRegex.test(normalizedPath)) {
    return false;
  }
  return true;
}

// maxMatches === 0 表示不限次数；写成 matchedCount < maxMatches 会让 0 变成
// 「永不命中」，与「省略即 1」一起构成最容易写错的两处边界。
function hasRemainingMatches(rule: NormalizedFsFaultRule): boolean {
  return rule.maxMatches === 0 || rule.matchedCount < rule.maxMatches;
}

// 用 Error 而不是自定义 class：跨包或跨 realm 的 instanceof 会失效，
// 上层改用 isInjectedFsFaultError 按字段识别，因此不依赖原型链。
export function createInjectedFsFaultError(input: {
  code: string;
  id: string;
  message?: string;
  operation: FsFaultOperation;
  path: string;
}): InjectedFsFaultError {
  const error = new Error(
    input.message ?? `Injected fs fault ${input.code} for ${input.operation}: ${input.path}`,
  ) as InjectedFsFaultError;
  error.code = input.code;
  error.path = input.path;
  error.syscall = input.operation;
  error.zcodeFsFaultId = input.id;
  return error;
}

// 只认 zcodeFsFaultId 且必须是字符串：真实 errno 错误不会有这个字段，
// 反过来伪造该字段的成本足够高，不需要额外的 Symbol 标记。
export function isInjectedFsFaultError(error: unknown): error is InjectedFsFaultError {
  return (
    typeof error === "object" &&
    error !== null &&
    "zcodeFsFaultId" in error &&
    typeof (error as { zcodeFsFaultId?: unknown }).zcodeFsFaultId === "string"
  );
}

// 默认空规则集：调用方漏传参数时得到「永不注入」的实例，
// 而不是抛错——生产路径上的默认值必须失败安全。
export function createFsFaultInjector(rules: readonly FsFaultRuleConfig[] = []): FsFaultInjector {
// 构造期完成全部校验与预编译：之后每次命中都不再做任何解析，
// 因此错误配置只会在创建注入器时抛，不会在业务调用中途炸出。
  const normalizedRules = rules.map((rule, index) => normalizeRule(rule, index));
// hits 与各规则计数是同一份状态的两面：hits 供断言，匹配只用计数，
// 两者必须同步推进，否则「已命中次数」与「实际抛错次数」会分叉。
  const hits: FsFaultHit[] = [];

  return {
// 只有归一化后的非空规则集才算启用；空数组在热路径上直接短路。
    isEnabled(): boolean {
      return normalizedRules.length > 0;
    },

// 顺序敏感：先判断剩余次数、再判断操作、最后匹配路径，前两者是 O(1)，
// 路径匹配含 includes 与正则，放在最后减少无谓开销。
    maybeThrow(input: FsFaultCheckInput): void {
      for (const rule of normalizedRules) {
        if (
          !hasRemainingMatches(rule) ||
          !operationMatches(rule, input.operation) ||
          !pathMatches(rule, input.path)
        ) {
          continue;
        }

// [事务] 先记账再抛错：抛出后调用方可能重试，计数必须先落定，
// 否则同一条规则会被无限次命中，maxMatches 形同虚设。
        rule.matchedCount += 1;
        hits.push({
          code: rule.code,
          id: rule.id,
          matchIndex: rule.matchedCount,
          matchedAt: new Date().toISOString(),
          operation: input.operation,
          path: input.path,
        });
// 命中第一条规则就抛，不再继续匹配：多条规则同时命中时行为应可预测，
// 由规则顺序决定优先级，而不是抛出「最后一条」。
        throw createInjectedFsFaultError({
          code: rule.code,
          id: rule.id,
          message: rule.message,
          operation: input.operation,
          path: input.path,
        });
      }
    },

// 返回副本：调用方排序或 push 不会污染内部记录，
// 测试可以放心地对结果做断言前的加工。
    getHits(): readonly FsFaultHit[] {
      return [...hits];
    },

// reset 必须同时清空 hits 与各规则计数：只清其中一个会得到
// 「计数已耗尽但 hits 为空」或反之的不一致状态。
    reset(): void {
// 原地清空而不是重新赋值：其他持有 getHits 结果的代码不受影响，
// 注入器对象本身也保持同一身份。
      hits.length = 0;
      for (const rule of normalizedRules) {
        rule.matchedCount = 0;
      }
    },
  };
}

// 这里只校验 JSON 与顶层数组形状，字段级校验留给 normalizeRule：
// 两处都做会让错误信息分叉，且 parse 阶段拿不到归一化后的语义。
export function parseFsFaultRulesFromEnvValue(rawValue: string): FsFaultRuleConfig[] {
  let parsed: unknown;
  try {
// JSON.parse 的异常信息不含变量名，这里补上 ZCODE_E2E_FS_FAULTS 前缀，
// 让「环境变量写坏了」与「规则内容不合法」在日志里可区分。
    parsed = JSON.parse(rawValue);
  } catch (error) {
    throw new Error(
      `Invalid ${ZCODE_E2E_FS_FAULTS_ENV}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`Invalid ${ZCODE_E2E_FS_FAULTS_ENV}: expected a JSON array`);
  }
// 只做「每项是普通对象」的检查，不复制字段：真正的类型收窄由 normalizeRule
// 在使用处完成，返回值只是形状可信的候选配置。
  return parsed.map((value, index) => {
// 数组也是 object，必须显式排除，否则 [1,2] 会被当成一条字段全缺失的规则，
// 错误信息会指向「id 不能为空」而不是「规则必须是对象」。
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`Invalid fs fault rule at index ${index}: rule must be an object`);
    }
    return value as FsFaultRuleConfig;
  });
}

// [失败路径] 没有变量或只有空白时返回空注入器，这是生产默认路径；
// 绝不因为「变量存在但不认识」就抛错，否则用户残留变量会让应用起不来。
export function createFsFaultInjectorFromEnv(
  env: Record<string, string | undefined> = process.env,
): FsFaultInjector {
  const rawValue = env[ZCODE_E2E_FS_FAULTS_ENV]?.trim();
// 先 trim 再判空：CI 里常见 ZCODE_E2E_FS_FAULTS=""，
// 空串必须等同于未设置，而不是 JSON 解析失败。
  if (!rawValue) {
    return createFsFaultInjector();
  }

  // 测试故障注入必须默认被生产环境隔离，避免用户机器残留环境变量后误伤真实配置和会话落盘。
// 默认绝不启用：仅当显式声明测试环境，或显式 allow 时才进入注入分支。
// 生产机器上残留该变量不应影响真实配置与会话落盘。
  if (env.ZCODE_ENV !== "test" && env[ZCODE_E2E_FS_FAULTS_ALLOW_ENV] !== "1") {
    return createFsFaultInjector();
  }

  return createFsFaultInjector(parseFsFaultRulesFromEnvValue(rawValue));
}

// 进程级单例：注入器要跨多次 fs 调用保持命中计数，必须与调用点分离存放；
// null 表示「尚未从 env 解析」，与「解析结果为空规则集」是两种不同状态。
let processEnvFaultInjector: FsFaultInjector | null = null;
// 测试注入优先于环境解析：单测可以直接替换注入器而不污染 process.env，
// 用完通过 setFsFaultInjectorForTests(null) 恢复。
let injectedFsFaultInjectorForTests: FsFaultInjector | null = null;

// 优先测试注入；否则惰性解析并按进程缓存：每次 fs 调用都读 env 会放大开销，
// 也让「运行中修改 env」产生难以解释的行为。
export function getProcessFsFaultInjector(): FsFaultInjector {
  if (injectedFsFaultInjectorForTests) {
    return injectedFsFaultInjectorForTests;
  }
// 只在首次调用时解析：解析失败会在这里抛出，属于启动期配置错误，
// 不应被吞成「无注入」——否则整组注入用例会静默失效。
  processEnvFaultInjector ??= createFsFaultInjectorFromEnv();
  return processEnvFaultInjector;
}

// 唯一的调用入口：把「取注入器」集中在此，各 fs 包装点无需持有引用，
// 也保证测试替换立即对所有调用点生效。
export function maybeThrowInjectedFsFault(input: FsFaultCheckInput): void {
  getProcessFsFaultInjector().maybeThrow(input);
}

// [权衡] 用模块级可变变量而不是依赖注入：fs 包装函数是直接 import 的，
// 传入注入器会扩散到几十个签名；代价是测试之间必须显式清理。
export function setFsFaultInjectorForTests(injector: FsFaultInjector | null): void {
  injectedFsFaultInjectorForTests = injector;
}

// 两个变量一起重置：只清测试注入会让下一次 get 复用旧的 env 解析结果，
// 测试相互污染时表现为「顺序不同结果不同」。
export function resetProcessFsFaultInjectorForTests(): void {
  processEnvFaultInjector = null;
  injectedFsFaultInjectorForTests = null;
}
