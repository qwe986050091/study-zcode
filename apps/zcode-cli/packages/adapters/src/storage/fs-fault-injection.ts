// ============================================================
// Storage FS fault injection
// ============================================================
// 定位：为 E2E / 单测提供可预测的文件系统与 sqlite 故障注入点。业务代码在真正
// 执行 mkdir/writeFile/rename/rm/sqlite 前调用 maybeThrowStorageFsFault，命中规则
// 时抛出一个带 errno code 的 Error，模拟磁盘满、权限拒绝、rename 占用等。
// 输入输出：规则来自 ZCODE_E2E_FS_FAULTS JSON 数组（含 id/code/operations/路径
// 匹配/maxMatches）；不匹配则静默返回，无返回值。
// 副作用：仅维护命中计数（可变状态），不会真的操作文件系统。
// 失败语义：规则 JSON 非法时在构造阶段 throw；命中规则时抛 InjectedStorageFsFaultError。
// 不变量：环境变量只在 ZCODE_ENV=test 或显式 ZCODE_E2E_FS_FAULTS_ALLOW=1 时生效，
// 生产环境绝不会因为遗留环境变量而随机失败；maxMatches 默认 1，reset 清零计数。

export const ZCODE_E2E_FS_FAULTS_ENV = "ZCODE_E2E_FS_FAULTS";
export const ZCODE_E2E_FS_FAULTS_ALLOW_ENV = "ZCODE_E2E_FS_FAULTS_ALLOW";

export type StorageFsFaultOperation =
  | "appendFile"
  | "any"
  | "mkdir"
  | "rename"
  | "rm"
  | "sqliteOpen"
  | "sqliteRun"
  | "writeFile";

export interface StorageFsFaultRule {
  /** 规则标识，注入错误时回填到 zcodeFsFaultId，便于测试断言命中了哪条规则。 */
  id: string;
  /** 模拟的 errno code（如 EACCES/ENOSPC/EPERM），决定上层错误分支走向。 */
  code: string;
  /** 生效操作集合；缺省 ["any"] 表示所有操作。 */
  operations?: readonly StorageFsFaultOperation[];
  /** 路径子串匹配（反斜杠会归一化为斜杠再比较）。 */
  pathIncludes?: string;
  /** 路径后缀匹配。 */
  pathEndsWith?: string;
  /** 路径正则匹配（针对归一化后的路径）。 */
  pathRegex?: string;
  /** 最多触发次数；缺省 1，0 表示永不触发，用于关闭规则。 */
  maxMatches?: number;
  /** 覆盖默认错误消息，便于断言或模拟真实系统文案。 */
  message?: string;
}

export interface StorageFsFaultInput {
  /** 即将执行的操作类型，与规则 operations 比对。 */
  operation: StorageFsFaultOperation;
  /** 操作目标路径，与规则路径条件比对。 */
  path: string;
}

interface NormalizedStorageFsFaultRule {
  code: string;
  id: string;
  maxMatches: number;
  message?: string;
  operations: ReadonlySet<StorageFsFaultOperation>;
  pathEndsWith?: string;
  pathIncludes?: string;
  pathRegex?: RegExp;
  matchedCount: number;
}

export interface InjectedStorageFsFaultError extends NodeJS.ErrnoException {
  /** 触发规则的 id；调用方可据此区分不同注入点。 */
  zcodeFsFaultId: string;
}

const SUPPORTED_OPERATIONS = new Set<StorageFsFaultOperation>([
  "appendFile",
  "any",
  "mkdir",
  "rename",
  "rm",
  "sqliteOpen",
  "sqliteRun",
  "writeFile",
]);

// 归一化路径分隔符：Windows 的 \ 统一成 /，让规则在不同平台可复用。
function normalizePath(path: string): string {
  return path.replace(/\\/g, "/");
}

function requireNonEmptyString(value: unknown, field: string, index: number): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Invalid fs fault rule at index ${index}: ${field} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(value: unknown, field: string, index: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error(`Invalid fs fault rule at index ${index}: ${field} must be a string`);
  }
  return value;
}

function normalizeOperations(value: unknown, index: number): readonly StorageFsFaultOperation[] {
  if (value === undefined) return ["any"];
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Invalid fs fault rule at index ${index}: operations must be a non-empty array`);
  }
  return value.map((operation) => {
    if (typeof operation !== "string" || !SUPPORTED_OPERATIONS.has(operation as StorageFsFaultOperation)) {
      throw new Error(
        `Invalid fs fault rule at index ${index}: unsupported operation ${String(operation)}`,
      );
    }
    return operation as StorageFsFaultOperation;
  });
}

// 校验规则字段并编译成正则/Set，构造期失败比运行时静默失效更安全。
function normalizeRule(rule: StorageFsFaultRule, index: number): NormalizedStorageFsFaultRule {
  const record = rule as unknown as Record<string, unknown>;
  const maxMatches = record.maxMatches === undefined ? 1 : record.maxMatches;
  if (typeof maxMatches !== "number" || !Number.isInteger(maxMatches) || maxMatches < 0) {
    throw new Error(`Invalid fs fault rule at index ${index}: maxMatches must be a non-negative integer`);
  }
  const pathRegexRaw = optionalString(record.pathRegex, "pathRegex", index);

  return {
    code: requireNonEmptyString(record.code, "code", index),
    id: requireNonEmptyString(record.id, "id", index),
    matchedCount: 0,
    maxMatches,
    message: optionalString(record.message, "message", index),
    operations: new Set(normalizeOperations(record.operations, index)),
    pathEndsWith: optionalString(record.pathEndsWith, "pathEndsWith", index),
    pathIncludes: optionalString(record.pathIncludes, "pathIncludes", index),
    pathRegex: pathRegexRaw === undefined ? undefined : new RegExp(pathRegexRaw),
  };
}

// 解析环境变量里的 JSON 数组；语法错误、非数组、元素非对象都会 throw，
// 避免配置写错后 fault 规则被静默忽略、让 E2E 误以为通过了失败路径。
function parseRules(rawValue: string): StorageFsFaultRule[] {
  let parsed: unknown;
  try {
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
  return parsed.map((rule, index) => {
    if (typeof rule !== "object" || rule === null || Array.isArray(rule)) {
      throw new Error(`Invalid fs fault rule at index ${index}: rule must be an object`);
    }
    return rule as StorageFsFaultRule;
  });
}

// "any" 是通配操作；否则必须精确命中当前操作的集合成员。
function operationMatches(rule: NormalizedStorageFsFaultRule, operation: StorageFsFaultOperation): boolean {
  return rule.operations.has("any") || rule.operations.has(operation);
}

// 三个路径条件同时满足才命中；未配置的条件视为放行。
function pathMatches(rule: NormalizedStorageFsFaultRule, path: string): boolean {
  const normalizedPath = normalizePath(path);
  const includes = rule.pathIncludes === undefined || normalizedPath.includes(normalizePath(rule.pathIncludes));
  const endsWith = rule.pathEndsWith === undefined || normalizedPath.endsWith(normalizePath(rule.pathEndsWith));
  const regex = rule.pathRegex === undefined || rule.pathRegex.test(normalizedPath);
  return includes && endsWith && regex;
}

// 构造带 errno 形状的 Error：code/syscall/path 让 Node 惯用的错误分类逻辑
// （isNodeError(e, "ENOSPC") 等）可以直接命中。
function createInjectedError(input: {
  code: string;
  id: string;
  message?: string;
  operation: StorageFsFaultOperation;
  path: string;
}): InjectedStorageFsFaultError {
  const error = new Error(
    input.message ?? `Injected fs fault ${input.code} for ${input.operation}: ${input.path}`,
  ) as InjectedStorageFsFaultError;
  error.code = input.code;
  error.path = input.path;
  error.syscall = input.operation;
  error.zcodeFsFaultId = input.id;
  return error;
}

export interface StorageFsFaultInjector {
  /** 判断是否命中规则；命中即抛错，未命中静默返回。 */
  maybeThrow(input: StorageFsFaultInput): void;
  /** 清零所有规则的命中计数，便于同一进程内重复用例互不污染。 */
  reset(): void;
}

/**
 * 按规则构造注入器。规则顺序即匹配顺序，命中第一条后立即抛出（不会继续匹配）。
 * maxMatches 用后即增，达到上限后的调用被跳过；无法关闭单条规则之外的副作用。
 */
export function createStorageFsFaultInjector(
  rules: readonly StorageFsFaultRule[] = [],
): StorageFsFaultInjector {
  const normalizedRules = rules.map((rule, index) => normalizeRule(rule, index));
  return {
    maybeThrow(input: StorageFsFaultInput): void {
      for (const rule of normalizedRules) {
        if (
          (rule.maxMatches > 0 && rule.matchedCount >= rule.maxMatches) ||
          !operationMatches(rule, input.operation) ||
          !pathMatches(rule, input.path)
        ) {
          continue;
        }
        rule.matchedCount += 1;
        throw createInjectedError({
          code: rule.code,
          id: rule.id,
          message: rule.message,
          operation: input.operation,
          path: input.path,
        });
      }
    },
    reset(): void {
      for (const rule of normalizedRules) {
        rule.matchedCount = 0;
      }
    },
  };
}

let envInjector: StorageFsFaultInjector | null = null;
let injectedForTests: StorageFsFaultInjector | null = null;

// 仅在测试环境或显式 allow 开关下解析环境变量；否则返回空注入器（永不触发），
// 防止生产进程因外部遗留的 ZCODE_E2E_FS_FAULTS 而出现随机 IO 失败。
function createStorageFsFaultInjectorFromEnv(
  env: Record<string, string | undefined> = process.env,
): StorageFsFaultInjector {
  const rawValue = env[ZCODE_E2E_FS_FAULTS_ENV]?.trim();
  if (!rawValue || (env.ZCODE_ENV !== "test" && env[ZCODE_E2E_FS_FAULTS_ALLOW_ENV] !== "1")) {
    return createStorageFsFaultInjector();
  }
  return createStorageFsFaultInjector(parseRules(rawValue));
}

// 测试注入优先于环境变量；env 注入器惰性构造并进程内缓存（规则计数跨调用累积）。
function getStorageFsFaultInjector(): StorageFsFaultInjector {
  if (injectedForTests) return injectedForTests;
  envInjector ??= createStorageFsFaultInjectorFromEnv();
  return envInjector;
}

// 业务侧统一调用点：在真实 IO 之前调用，命中即中断后续副作用。
export function maybeThrowStorageFsFault(input: StorageFsFaultInput): void {
  getStorageFsFaultInjector().maybeThrow(input);
}

// 测试钩子：覆盖全局注入器；传 null 恢复为环境变量/空注入器。
export function setStorageFsFaultInjectorForTests(injector: StorageFsFaultInjector | null): void {
  injectedForTests = injector;
}

// 测试钩子：同时清空 env 缓存与测试注入器，保证用例之间互不影响。
export function resetStorageFsFaultInjectorForTests(): void {
  envInjector = null;
  injectedForTests = null;
}
