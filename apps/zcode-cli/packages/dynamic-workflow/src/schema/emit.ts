// INV-01 只发射子集：守住位置 JsonSchema 产出；改错故障：生成校验器不支持的 schema 关键字。
// INV-02 栈帧记账：守住位置 composite 与 inProgress；改错故障：递归类型无限展开。
// INV-03 def 惰性：守住位置 defs 与 nameFor；改错故障：非递归类型也被提升为 $ref，快照难读。
// INV-04 名字唯一：守住位置 usedNames 去重；改错故障：两个同名类型共用 def 互相覆盖。
// INV-05 拒绝即报错：守住位置 SchemaRejection；改错故障：不可序列化类型被静默降级成 unknown。
// INV-06 any 不放行：守住位置 Any 分支；改错故障：any 被当作 unknown 发射，模型失去约束。
// INV-07 undefined 限定：守住位置 undefined 与 void 分支；改错故障：可选性挤进类型导致必填校验错乱。
// INV-08 字面量常量化：守住位置 字面量分支；改错故障：字面量被拓宽成基础类型，枚举约束丢失。
// INV-09 联合上限：守住位置 MAX_UNION_MEMBERS 检查；改错故障：超大联合生成巨型 anyOf。
// INV-10 联合字面量化：守住位置 emitMembers 与 asLiterals；改错故障：本可 enum 的联合退化成 anyOf。
// INV-11 交叉看原始：守住位置 emitIntersection 原始类型扫描；改错故障：品牌类型被当成对象展开。
// INV-12 内建拒绝：守住位置 REJECTED_BUILTINS；改错故障：Date 与 Map 被当成空对象放行。
// INV-13 类实例拒绝：守住位置 SymbolFlags.Class 兜底；改错故障：类实例被当成纯数据结构。
// INV-14 thenable 拒绝：守住位置 isThenable；改错故障：Promise 被展开成空对象。
// INV-15 必须项来源：守住位置 emitObject 的 required；改错故障：可选属性被写成必填。
// INV-16 可选去 undefined：守住位置 emitOptional；改错故障：required 里出现 undefined 分支。
// INV-17 闭合对象：守住位置 additionalProperties 决策；改错故障：多余键静默通过校验。
// INV-18 元组保序：守住位置 emitTuple 的 prefixItems；改错故障：rest 与可选元素错位。
//
// 模块职责：把 TypeScript 类型结构翻译成受支持的 JSON Schema 子集。
// 状态所有权：defs 与 inProgress 等四张表由 SchemaEmitter 实例独占。
// 阅读顺序：异常与常量 → 栈帧与命名 → 主分发 → 复合类型 → 数组与元组。
import ts from "typescript";
import { harvestConstraints, mergeConstraints } from "./jsdoc.js";
import type { JsonSchema, JsonValue } from "./types.js";
import { MAX_UNION_MEMBERS } from "./types.js";

/**
 * 类型 → JSON Schema 的发射器（emitter），由 checker 的结构化视图驱动（泛型/别名/
 * mapped/conditional 都已被 checker 展平）。
 *
 * 递归类型通过 `$defs`/`$ref` 表达：只有真正被自身（在合成栈上）再次引用到的类型才会
 * 被提升为 def，非递归的具名类型仍就地内联，保证快照可读。识别办法是给每个复合类型
 * 压一个栈帧，若发射其子树时再次进入同一 `ts.Type`，就把它标记为 requested 并返回
 * `$ref`；栈帧结束时若被 requested 过，则登记进 defs。
 *
 * 不可 JSON 序列化的类型以 {@link SchemaRejection} 抛出，由合成侧转成定位到 ask 站点的
 * 诊断（复用分析管线的诊断形状/UX）。
 */

/** 发射失败：携带原因与出错的 JSON 路径，供合成侧组装成定位诊断。 */
export class SchemaRejection extends Error {
  constructor(
    readonly reason: string,
    readonly path: string,
  ) {
    super(reason);
    this.name = "SchemaRejection";
  }
}

/**
 * 明确按名字拒绝的内建对象：它们是宿主对象/类实例，不是纯数据。Promise 也在此列，
 * 给出比“函数类型”更清晰的诊断。用户自定义 class 由 SymbolFlags.Class 兜底。
 */
const REJECTED_BUILTINS = new Set<string>([
  "Date",
  "RegExp",
  "Map",
  "WeakMap",
  "ReadonlyMap",
  "Set",
  "WeakSet",
  "ReadonlySet",
  "Promise",
  "Error",
  "EvalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError",
  "ArrayBuffer",
  "SharedArrayBuffer",
  "DataView",
  "Int8Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int16Array",
  "Uint16Array",
  "Int32Array",
  "Uint32Array",
  "Float32Array",
  "Float64Array",
  "BigInt64Array",
  "BigUint64Array",
]);

interface Frame {
  requested: boolean;
}

/** 读取对象类型的 objectFlags（`ts.getObjectFlags` 未在公有 typings 暴露，这里直接取）。 */
// 公有 typings 未暴露 objectFlags，这里按类型标志位直接取。
// 非对象类型统一返回 0，调用方据此提前退出。
// 仅用于识别数组与元组引用，不参与 schema 决策。
function objectFlagsOf(type: ts.Type): ts.ObjectFlags {
  return (type.flags & ts.TypeFlags.Object) !== 0 ? (type as ts.ObjectType).objectFlags : 0;
}

// 四张表都以类型对象为键：defs 存已定稿的 def，inProgress 存递归探测中的栈帧。
// defName 缓存命名结果，usedNames 保证全局唯一。
// checker 与 location 只读注入，不随单次发射变化。
export class SchemaEmitter {
  private readonly defs = new Map<ts.Type, { name: string; schema: JsonSchema }>();
  private readonly inProgress = new Map<ts.Type, Frame>();
  private readonly defName = new Map<ts.Type, string>();
  private readonly usedNames = new Set<string>();

  constructor(
    private readonly checker: ts.TypeChecker,
    private readonly location: ts.Node,
  ) {}

  /** 发射顶层类型；若过程中产生了 def，则把 `$defs` 挂到根 schema 上。 */
  // 顶层发射从 $ 路径开始，路径只用于诊断定位。
  // 没有产生 def 时直接返回，避免空 $defs 干扰快照。
  // 有 def 时把 $defs 挂到根上，引用在同一份 schema 内自洽。
  //
  emitTop(type: ts.Type): JsonSchema {
    const schema = this.emit(type, "$");
    if (this.defs.size === 0) return schema;
    const $defs: Record<string, JsonSchema> = {};
    for (const { name, schema: defSchema } of this.defs.values()) $defs[name] = defSchema;
    return { ...schema, $defs };
  }

  // 先查已定稿 def：命中即返回引用，不再重复展开。
  // 再查进行中的栈帧：命中说明递归，标记 requested 并返回引用。
  // [契约] 按 type.flags 位标志分发：any 与 never 先抛 SchemaRejection 并带 path 定位，unknown 放行成空 schema。
  // 联合、交叉与对象统一走 composite，才能探测自引用。
  // 路径逐层拼接，供 SchemaRejection 精确定位。
  //
  private emit(type: ts.Type, path: string): JsonSchema {
    const settled = this.defs.get(type);
    if (settled !== undefined) return { $ref: `#/$defs/${settled.name}` };
    const frame = this.inProgress.get(type);
    if (frame !== undefined) {
      frame.requested = true;
      return { $ref: `#/$defs/${this.nameFor(type)}` };
    }

    const flags = type.flags;
    if (flags & ts.TypeFlags.Any) {
      throw new SchemaRejection("type 'any' is not allowed; use 'unknown' or a concrete type", path);
    }
    if (flags & ts.TypeFlags.Unknown) return {};
    if (flags & ts.TypeFlags.Never) throw new SchemaRejection("type 'never' cannot be represented", path);
    if (flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) {
      throw new SchemaRejection("'undefined' is only allowed on optional properties", path);
    }
    if (flags & ts.TypeFlags.Null) return { type: "null" };
    if (flags & ts.TypeFlags.BooleanLiteral) return { const: this.booleanValue(type) };
    if (flags & ts.TypeFlags.Boolean) return { type: "boolean" };
    if (flags & ts.TypeFlags.StringLiteral) return { const: (type as ts.StringLiteralType).value };
    if (flags & ts.TypeFlags.NumberLiteral) return { const: (type as ts.NumberLiteralType).value };
    if (flags & ts.TypeFlags.String) return { type: "string" };
    if (flags & ts.TypeFlags.Number) return { type: "number" };
    if (flags & (ts.TypeFlags.BigInt | ts.TypeFlags.BigIntLiteral)) {
      throw new SchemaRejection("'bigint' is not JSON-serializable", path);
    }
    if (flags & (ts.TypeFlags.ESSymbol | ts.TypeFlags.UniqueESSymbol)) {
      throw new SchemaRejection("'symbol' is not JSON-serializable", path);
    }
    if (type.isUnion()) return this.composite(type, () => this.emitUnion(type, path));
    if (type.isIntersection()) return this.composite(type, () => this.emitIntersection(type, path));
    if (flags & ts.TypeFlags.Object) return this.composite(type, () => this.emitObjectLike(type, path));

    throw new SchemaRejection("type is not JSON-serializable", path);
  }

  /** 复合类型的栈帧包装：发射期间若被自身再次引用则提升为 def 并返回 `$ref`。 */
  // 进入时压栈帧，requested 初值为 false。
  // 子发射期间若再次进入同一类型，栈帧被标记。
  // 出栈后按标记决定就地内联还是提升为 def。
  // 提升时先分配唯一名字，再把 schema 登记进 defs。
  //
  private composite(type: ts.Type, build: () => JsonSchema): JsonSchema {
    this.inProgress.set(type, { requested: false });
    const schema = build();
    const frame = this.inProgress.get(type)!;
    this.inProgress.delete(type);
    if (!frame.requested) return schema;
    const name = this.nameFor(type);
    this.defs.set(type, { name, schema });
    return { $ref: `#/$defs/${name}` };
  }

  /** 为一个类型分配稳定且唯一的 def 名（源自别名/符号名），惰性且去重。 */
  private nameFor(type: ts.Type): string {
    const cached = this.defName.get(type);
    if (cached !== undefined) return cached;
    const base = type.aliasSymbol?.name ?? type.getSymbol()?.name ?? "Schema";
    let name = base;
    let suffix = 1;
    while (this.usedNames.has(name)) {
      suffix += 1;
      name = `${base}${suffix}`;
    }
    this.usedNames.add(name);
    this.defName.set(type, name);
    return name;
  }

  private booleanValue(type: ts.Type): boolean {
    return (type as unknown as { intrinsicName?: string }).intrinsicName === "true";
  }

  private emitUnion(type: ts.UnionType, path: string): JsonSchema {
    const members = type.types;
    if (members.length > MAX_UNION_MEMBERS) {
      throw new SchemaRejection(
        `union has too many members (${members.length} > ${MAX_UNION_MEMBERS})`,
        path,
      );
    }
    for (const member of members) {
      if (member.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) {
        throw new SchemaRejection("'undefined' is only allowed on optional properties", path);
      }
    }
    return this.emitMembers(members, path);
  }

  /** 一组成员类型 → enum（全为字面量时）或 anyOf。也被可选属性的去 undefined 路径复用。 */
  emitMembers(members: readonly ts.Type[], path: string): JsonSchema {
    const literals = this.asLiterals(members);
    if (literals !== undefined) return { enum: literals };
    return { anyOf: members.map((member, index) => this.emit(member, `${path}|${index}`)) };
  }

  /** 若所有成员都是字面量（string/number/boolean 字面量或 null），返回其取值数组。 */
  private asLiterals(members: readonly ts.Type[]): JsonValue[] | undefined {
    const values: JsonValue[] = [];
    for (const member of members) {
      const flags = member.flags;
      if (flags & ts.TypeFlags.StringLiteral) values.push((member as ts.StringLiteralType).value);
      else if (flags & ts.TypeFlags.NumberLiteral) values.push((member as ts.NumberLiteralType).value);
      else if (flags & ts.TypeFlags.BooleanLiteral) values.push(this.booleanValue(member));
      else if (flags & ts.TypeFlags.Null) values.push(null);
      else return undefined;
    }
    return values;
  }

  /** 交叉类型：合并为一个 object（checker 已把成员属性合并到交叉类型上）。含原始类型成员
   *  的品牌类型（如 `string & {__brand}`）按其原始类型发射。 */
  private emitIntersection(type: ts.IntersectionType, path: string): JsonSchema {
    for (const member of type.types) {
      if (member.flags & ts.TypeFlags.String) return { type: "string" };
      if (member.flags & ts.TypeFlags.Number) return { type: "number" };
      if (member.flags & ts.TypeFlags.Boolean) return { type: "boolean" };
    }
    if (type.getCallSignatures().length > 0) {
      throw new SchemaRejection("function types are not JSON-serializable", path);
    }
    return this.emitObject(type, path);
  }

  private emitObjectLike(type: ts.Type, path: string): JsonSchema {
    if (this.isArrayType(type)) return this.emitArray(type as ts.TypeReference, path);
    if (this.isTupleType(type)) return this.emitTuple(type as ts.TupleTypeReference, path);
    if (type.getCallSignatures().length > 0 || type.getConstructSignatures().length > 0) {
      throw new SchemaRejection("function types are not JSON-serializable", path);
    }
    const name = type.getSymbol()?.getName();
    if (name !== undefined && REJECTED_BUILTINS.has(name)) {
      throw new SchemaRejection(`'${name}' is not JSON-serializable`, path);
    }
    if (((type.getSymbol()?.flags ?? 0) & ts.SymbolFlags.Class) !== 0) {
      throw new SchemaRejection("class instances are not JSON-serializable", path);
    }
    if (this.isThenable(type)) {
      throw new SchemaRejection("Promise/thenable values are not JSON-serializable", path);
    }
    return this.emitObject(type, path);
  }

  // 属性逐个发射，可选属性先剥掉 undefined。
  // JSDoc 约束在属性 schema 之上合并，不覆盖结构。
  // 只有非可选属性进入 required。
  // 无字符串索引签名时闭合对象，多余键交由校验器拒绝。
  //
  private emitObject(type: ts.Type, path: string): JsonSchema {
    const properties: Record<string, JsonSchema> = {};
    const required: string[] = [];
    for (const prop of this.checker.getPropertiesOfType(type)) {
      const optional = (prop.flags & ts.SymbolFlags.Optional) !== 0;
      const propPath = `${path}.${prop.name}`;
      const propType = this.checker.getTypeOfSymbolAtLocation(prop, prop.valueDeclaration ?? this.location);
      const base = optional ? this.emitOptional(propType, propPath) : this.emit(propType, propPath);
      properties[prop.name] = mergeConstraints(base, harvestConstraints(prop, this.checker));
      if (!optional) required.push(prop.name);
    }

    const schema: JsonSchema = { type: "object" };
    if (Object.keys(properties).length > 0) schema.properties = properties;
    if (required.length > 0) schema.required = required;

    // 闭合对象（无字符串索引签名）发射 additionalProperties: false。
    // 注意这不是「忠于 TS」：TS 的对象类型在结构上是开放的（多余属性检查只对对象字面量
    // 触发），`{a: string}` 本身接受多余键。这里选 false 的真正理由是校验 UX 与结构化
    // 输出惯例：模型给出多余键几乎总是误解的信号，false 能把它变成一条清晰的修复提示，
    // 也符合严格结构化输出的通行做法。带字符串索引签名（Record<string,T>）则用其值 schema。
    const indexInfo = this.checker.getIndexInfoOfType(type, ts.IndexKind.String);
    schema.additionalProperties = indexInfo !== undefined ? this.emit(indexInfo.type, `${path}[*]`) : false;
    return schema;
  }

  /** 可选属性：从属性类型里剥掉 undefined 后再发射（可选性由 required 表达，不进类型）。 */
  // 非联合类型原样发射，可选性只由 required 表达。
  // 联合里剥掉 undefined 与 void，只剩一个时直接内联。
  // 剩余成员多于一个时退回 emitMembers，可能产出 enum。
  private emitOptional(propType: ts.Type, path: string): JsonSchema {
    if (!propType.isUnion()) return this.emit(propType, path);
    const rest = propType.types.filter(
      (member) => (member.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) === 0,
    );
    if (rest.length === propType.types.length) return this.emit(propType, path);
    if (rest.length === 1) return this.emit(rest[0]!, path);
    return this.emitMembers(rest, path);
  }

  private emitArray(type: ts.TypeReference, path: string): JsonSchema {
    const element = this.checker.getTypeArguments(type)[0];
    const items = element !== undefined ? this.emit(element, `${path}[]`) : {};
    return { type: "array", items };
  }

  private emitTuple(type: ts.TupleTypeReference, path: string): JsonSchema {
    const elementFlags = type.target.elementFlags;
    const args = this.checker.getTypeArguments(type);
    const prefixItems: JsonSchema[] = [];
    let minItems = 0;
    let restItems: JsonSchema | undefined;
    for (let index = 0; index < args.length; index += 1) {
      const flag = elementFlags[index] ?? ts.ElementFlags.Required;
      const arg = args[index]!;
      if (flag & ts.ElementFlags.Rest) {
        restItems = this.emit(arg, `${path}[${index}]`);
        continue;
      }
      const optional = (flag & ts.ElementFlags.Optional) !== 0;
      prefixItems.push(optional ? this.emitOptional(arg, `${path}[${index}]`) : this.emit(arg, `${path}[${index}]`));
      if (flag & ts.ElementFlags.Required) minItems += 1;
    }
    const schema: JsonSchema = { type: "array", prefixItems, minItems };
    if (restItems !== undefined) schema.items = restItems;
    else schema.maxItems = prefixItems.length;
    return schema;
  }

  private isArrayType(type: ts.Type): boolean {
    if ((objectFlagsOf(type) & ts.ObjectFlags.Reference) === 0) return false;
    const name = (type as ts.TypeReference).target.getSymbol()?.getName();
    return name === "Array" || name === "ReadonlyArray";
  }

  private isTupleType(type: ts.Type): boolean {
    if ((objectFlagsOf(type) & ts.ObjectFlags.Reference) === 0) return false;
    return (((type as ts.TypeReference).target.objectFlags ?? 0) & ts.ObjectFlags.Tuple) !== 0;
  }

  private isThenable(type: ts.Type): boolean {
    const then = this.checker.getPropertyOfType(type, "then");
    if (then === undefined) return false;
    const thenType = this.checker.getTypeOfSymbolAtLocation(then, then.valueDeclaration ?? this.location);
    return thenType.getCallSignatures().length > 0;
  }
}
