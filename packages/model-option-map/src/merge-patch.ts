// INV-01 顺序应用：守住位置 for (const namedPatch of patches)；改错故障 后写覆盖先写而无法定位来源。
// INV-02 冲突即失败：守住位置 throw ModelOptionMapError；改错故障 两个插件静默互相覆盖。
// INV-03 重叠含祖先关系：守住位置 pathsOverlap 前缀比较；改错故障 $.a 与 $.a.b 被当成不相干。
// INV-04 写入路径先收集：守住位置 collectWrittenPaths 在建树前调用；改错故障 冲突检测滞后于合并。
// INV-05 空对象不算写入：守住位置 length > 0 判断；改错故障 空 patch 与任何路径冲突。
// INV-06 合并基于克隆：守住位置 cloneJson(body)；改错故障 直接改写调用方入参。
// INV-07 null 表示删除：守住位置 patchValue === null；改错故障 RFC 7386 语义丢失，字段变成 null。
// INV-08 非对象目标按空对象处理：守住位置 isJsonObject(targetValue) 三元；改错故障 标量目标上抛错。
// INV-09 叶子值整体替换：守住位置 最后一行赋值；改错故障 数组被逐项合并。
// INV-10 数组视为叶子：守住位置 isJsonObject 排除 Array；改错故障 数组被当对象展开。
// INV-11 克隆用空原型：守住位置 Object.create(null)；改错故障 __proto__ 键污染原型链。
// INV-12 键用 defineProperty：守住位置 逐个定义；改错故障 特殊键触发 setter 或丢属性。
// INV-13 路径格式化固定：守住位置 "$" 与 "$.a.b"；改错故障 报错信息不可读。
// INV-14 纯函数无 IO：守住位置 全部导出；改错故障 冲突检测读取环境或写日志。
//
// 模块职责：按顺序应用带来源名的 JSON Merge Patch，并在写入路径重叠时报错。
// 阅读顺序：先看顺序应用与冲突检测，再看路径收集，最后看合并与克隆的边界。
import { ModelOptionMapError, type JsonObject, type JsonValue } from "./types.js";

// 补丁必须带来源名用于冲突归因。
export interface NamedJsonMergePatch {
  readonly option: string;
  readonly patch: JsonObject;
}

interface OwnedPath {
  readonly option: string;
  readonly path: readonly string[];
}

// 对外只暴露顺序应用入口。
export function applyOrderedJsonMergePatches(
  body: JsonObject,
  patches: readonly NamedJsonMergePatch[],
): JsonObject {
  const ownedPaths: OwnedPath[] = [];
  let result = cloneJson(body) as JsonObject;
  for (const namedPatch of patches) {
    // 先算本条写入哪些路径。
    const paths = collectWrittenPaths(namedPatch.patch);
    for (const path of paths) {
      // 与已登记路径做前缀重叠判断。
      const conflict = ownedPaths.find((owned) => pathsOverlap(owned.path, path));
      if (conflict) {
        throw new ModelOptionMapError(
          `Model option maps write conflicting JSON path ${formatPath(path)}: ${conflict.option} and ${namedPatch.option}`,
        );
      }
      ownedPaths.push({ option: namedPatch.option, path });
    }
    // 冲突检查通过后才真正合并。
    result = mergeObject(result, namedPatch.patch);
  }
  return result;
}

// 递归列出所有叶子写入路径。
function collectWrittenPaths(
  patch: JsonObject,
  prefix: readonly string[] = [],
): readonly string[][] {
  const paths: string[][] = [];
  for (const [key, value] of Object.entries(patch)) {
    const path = [...prefix, key];
    // 非空对象继续下钻，空对象即叶子。
    if (isJsonObject(value) && Object.keys(value).length > 0) {
      paths.push(...collectWrittenPaths(value, path));
    } else {
      paths.push(path);
    }
  }
  return paths;
}

// `commonPrefix` 全部相同即视为重叠。
function pathsOverlap(left: readonly string[], right: readonly string[]): boolean {
  const sharedLength = Math.min(left.length, right.length);
  for (let index = 0; index < sharedLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function formatPath(path: readonly string[]): string {
  return path.length === 0 ? "$" : `$.${path.join(".")}`;
}

// 合并只在 `structuredClone` 的副本上执行，入参不被改写。
function mergeObject(target: JsonObject, patch: JsonObject): JsonObject {
  const result = cloneJson(target) as Record<string, JsonValue>;
  for (const [key, patchValue] of Object.entries(patch)) {
    // null 表示删除该键。
    if (patchValue === null) {
      delete result[key];
      continue;
    }
    if (isJsonObject(patchValue)) {
      const targetValue = result[key];
      // 目标不是对象时按空对象起步。
      result[key] = mergeObject(isJsonObject(targetValue) ? targetValue : {}, patchValue);
      continue;
    }
    result[key] = cloneJson(patchValue);
  }
  return result;
}

// 克隆同时隔离数组与对象。
function cloneJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(cloneJson);
  if (!isJsonObject(value)) return value;
  // 空原型避免原型链键污染。
  const result: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
  for (const [key, entry] of Object.entries(value)) {
    Object.defineProperty(result, key, {
      configurable: true,
      enumerable: true,
      value: cloneJson(entry),
      writable: true,
    });
  }
  return result;
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
