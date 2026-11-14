// INV-01 入口必须先校验输入类型：守住位置 evaluateRestrictedCel 内 assertRestrictedCelValue 的调用；改错故障 非法输入直到求值中途才报错，错误位置指向内部节点而非调用处
// INV-02 对外返回值必须冻结：守住位置 evaluateRestrictedCel 末尾的 freezeJson；改错故障 调用方可改写返回结构，缓存中的选项值被跨请求污染
// INV-03 节点类型分派必须穷举：守住位置 evaluate 的 switch，不设兜底分支；改错故障 新增节点类型静默返回 undefined，配置被忽略却没有任何报错
// INV-04 对象字面量结果必须是无原型字典：守住位置 object 分支以 Object.create 的空原型形式建容器；改错故障 键名为 __proto__ 时触发原型写入，用户输入可污染共享原型
// INV-05 对象键必须逐条 defineProperty 写入：守住位置 object 分支的属性定义；改错故障 直接赋值对 __proto__ 失效，该键静默丢失且无痕迹
// INV-06 逻辑运算符只产出布尔值：守住位置 evaluateBinary 的 && 与 || 分支；改错故障 返回值随操作数类型漂移，下游布尔断言在远离出错点处抛出
// INV-07 短路语义只求值必要分支：守住位置 evaluateBinary 中 && 与 || 的提前返回；改错故障 被跳过的右侧照样求值，合法配置被判为非法
// INV-08 一元运算按运算符分流：守住位置 evaluateUnary 的 "!" 分支；改错故障 布尔取反误走数值校验，合法表达式被拒
// INV-09 "+" 只有同类字符串拼接与数值相加两种语义：守住位置 evaluateBinary 的 "+" 分支；改错故障 混合类型被隐式转换，结果与 CEL 预期不一致
// INV-10 每个算术结果都要过数值安全检查：守住位置 numericBinary 与一元负号的 assertNumber；改错故障 NaN 或 Infinity 流入结果，序列化阶段才暴露成 null
// INV-11 除零与对零取模必须报错而非产出无穷：守住位置 assertNumber 的有限性判断；改错故障 Infinity 被当作有效数字，后续比较全部失真
// INV-12 比较要求两侧同类型且为数字或字符串：守住位置 compare 开头的类型判断；改错故障 布尔与 null 参与比较，排序结果不稳定
// INV-13 等值判断先用 Object.is：守住位置 jsonEquals 首行；改错故障 改用 === 后 -0 与 0 被视为相等，去重结果发生变化
// INV-14 数组相等要求长度一致且逐元素递归：守住位置 jsonEquals 的数组分支；改错故障 长度不同却判为相等，配置指纹冲突
// INV-15 对象相等与键顺序无关：守住位置 jsonEquals 的键集合比较；改错故障 键序不同被判为不等，等价配置无法命中缓存
// INV-16 冻结必须递归到叶子：守住位置 freezeJson 的数组与对象分支；改错故障 只冻结顶层，嵌套值仍可被调用方改写
// INV-17 普通对象判定必须排除 null 与数组：守住位置 isJsonObject；改错故障 数组被当成对象，遍历得到下标键
// INV-18 求值器保持无状态纯函数：守住位置 整个模块不引入缓存与模块级可变变量；改错故障 跨调用复用可变结果，出现偶发且难以复现的串值
//
// 模块职责：受限 CEL 表达式求值器，把 parser 已做结构校验的语法树在给定输入上算成 JSON 值，并保证结果不可变、数字可序列化。
// 状态所有权：不持有任何状态；输入只读，输出由 freezeJson 冻结后交给调用方，语法树的生命周期与缓存由上层负责。
// 阅读顺序：先 evaluateRestrictedCel 看对外契约与入参校验 → evaluate 的类型分派 → evaluateUnary 与 evaluateBinary 的运算符语义 → requireBoolean、requireNumber、assertNumber 的失败路径 → jsonEquals 与 freezeJson 的结果整形。
import type { RestrictedCelExpression } from "./parser.js";
import {
  RestrictedCelError,
  type JsonObject,
  type JsonValue,
  type RestrictedCelValue,
} from "./types.js";

// 这是本包唯一的对外入口，先校验入参再求值，两步顺序不可交换
// input 只允许 string 或 number，对象与数组输入在入口即失败，而不是算到一半才暴露
// 返回值统一走 freezeJson，调用方拿到的是深冻结结构，既不需要也不应再拷贝
// 求值过程不读时钟、不读环境、不写外部状态，同一输入重复调用结果稳定
// 语法树由 parser 产出并已做过结构校验，这里不再做形状兜底，避免出现两处真相
// 把校验挪进 evaluate 内部会让同一次求值重复检查，错误偏移量也会随之漂移
export function evaluateRestrictedCel(
  expression: RestrictedCelExpression,
  input: RestrictedCelValue,
): JsonValue {
  assertRestrictedCelValue(input, expression.offset);
  return freezeJson(evaluate(expression, input));
}

function evaluate(expression: RestrictedCelExpression, input: RestrictedCelValue): JsonValue {
  // 按节点类型穷举分派，故意不写兜底分支
  // 新增节点类型时必须在这里补分支，缺少时类型检查会失败
  // 若用兜底分支返回 undefined，非法语法树会被 freezeJson 原样放过，错误推迟到消费方
  // literal 直接返回字面量，input 直接返回入参，两者都不拷贝，不可变性由末端冻结保证
  // array 与 object 会递归求值子节点，嵌套深度由 parser 的层数上限间接约束
  switch (expression.type) {
    case "literal":
      return expression.value;
    case "input":
      return input;
    case "array":
      return expression.elements.map((element) => evaluate(element, input));
    case "object": {
      // 用空原型容器承载结果，杜绝 __proto__ 之类的键触发原型写入
      // 逐键用 Object.defineProperty 写入，是为了让 __proto__ 作为普通数据属性落地
      // enumerable 与 writable 显式打开，序列化结果与后续读取行为才和普通对象一致
      // configurable 打开只为与字面量对象对齐，求值路径不会再次改动这些键
      // 若改成下标赋值的写法，键名为 __proto__ 时会改写原型而不是新增属性
      const result: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
      for (const entry of expression.entries) {
        Object.defineProperty(result, entry.key, {
          configurable: true,
          enumerable: true,
          value: evaluate(entry.value, input),
          writable: true,
        });
      }
      return result;
    }
    case "unary":
      return evaluateUnary(
        expression.operator,
        evaluate(expression.operand, input),
        expression.offset,
      );
    case "binary":
      return evaluateBinary(expression, input);
    case "conditional":
      return requireBoolean(evaluate(expression.condition, input), expression.condition.offset)
        ? evaluate(expression.whenTrue, input)
        : evaluate(expression.whenFalse, input);
  }
}

function evaluateUnary(operator: string, operand: JsonValue, offset: number): JsonValue {
  // "!" 属于布尔运算，先 requireBoolean 再取反，不接受 0 或空串这类隐式真值
  // 其余一元运算符只保留负号，因此校验完数字后直接走数值通道
  // 负号结果立刻过 assertNumber，防止出现不可序列化的溢出值
  // 运算符集合由 parser 收窄；解析层若放宽而这里不补分支，未知运算符会被当成负号处理
  // 错误偏移量统一用运算符位置传递，避免报错指向子节点让调用方误判出错位置
  if (operator === "!") return !requireBoolean(operand, offset);
  const number = requireNumber(operand, offset);
  return assertNumber(operator === "-" ? -number : number, offset);
}

function evaluateBinary(
  expression: Extract<RestrictedCelExpression, { type: "binary" }>,
  input: RestrictedCelValue,
): JsonValue {
  const left = evaluate(expression.left, input);
  // 左操作数已在上一行求值过一次，短路判断不得重复求值，否则带副作用的表达式会算两次
  // "&&" 左侧为 false 时直接给 false，右侧整棵子树不参与求值
  // "||" 左侧为 true 时直接给 true，同样跳过右侧
  // 两个逻辑运算符都返回布尔值而不是操作数本身，这是与 JS 语义的关键差异
  // 漏掉 requireBoolean 会让字符串或数字穿透到条件分支，报错点偏离真正的错误来源
  if (expression.operator === "&&") {
    return requireBoolean(left, expression.left.offset)
      ? requireBoolean(evaluate(expression.right, input), expression.right.offset)
      : false;
  }
  if (expression.operator === "||") {
    return requireBoolean(left, expression.left.offset)
      ? true
      : requireBoolean(evaluate(expression.right, input), expression.right.offset);
  }

  const right = evaluate(expression.right, input);
  switch (expression.operator) {
    case "==":
      return jsonEquals(left, right);
    case "!=":
      return !jsonEquals(left, right);
    case "+":
      // "+" 是唯一重载的运算符：两侧同为 string 才拼接，其余情况按数值相加
      // 不做隐式类型转换，数字字符串与数字相加会进入数值通道并因类型校验失败而报错
      // 拼接结果长度不受限，但输出必须是 JSON 值，体积需由调用方自行评估
      // 数值相加的结果再经 assertNumber，避免大整数相加后越过安全整数范围
      // 把字符串判断放到数值分支之后，会让两个字符串相加先报数值错误，行为与 CEL 预期相反
      if (typeof left === "string" && typeof right === "string") return left + right;
      return assertNumber(
        requireNumber(left, expression.left.offset) + requireNumber(right, expression.right.offset),
        expression.offset,
      );
    case "-":
      return numericBinary(left, right, expression, (a, b) => a - b);
    case "*":
      return numericBinary(left, right, expression, (a, b) => a * b);
    case "/":
      return numericBinary(left, right, expression, (a, b) => a / b);
    case "%":
      return numericBinary(left, right, expression, (a, b) => a % b);
    case "<":
    case "<=":
    case ">":
    case ">=":
      return compare(left, right, expression.operator, expression.offset);
    default:
      throw new RestrictedCelError(
        `unsupported operator ${expression.operator}`,
        expression.offset,
      );
  }
}

function numericBinary(
  left: JsonValue,
  right: JsonValue,
  expression: Extract<RestrictedCelExpression, { type: "binary" }>,
  operation: (left: number, right: number) => number,
): number {
  return assertNumber(
    operation(
      requireNumber(left, expression.left.offset),
      requireNumber(right, expression.right.offset),
    ),
    expression.offset,
  );
}

function compare(left: JsonValue, right: JsonValue, operator: string, offset: number): boolean {
  if (typeof left !== typeof right || (typeof left !== "number" && typeof left !== "string")) {
    throw new RestrictedCelError(
      "comparison operands must have the same numeric or string type",
      offset,
    );
  }
  const comparison =
    typeof left === "number" && typeof right === "number"
      ? left < right
        ? -1
        : left > right
          ? 1
          : 0
      : String(left) < String(right)
        ? -1
        : String(left) > String(right)
          ? 1
          : 0;
  if (operator === "<") return comparison < 0;
  if (operator === "<=") return comparison <= 0;
  if (operator === ">") return comparison > 0;
  return comparison >= 0;
}

function requireBoolean(value: JsonValue, offset: number): boolean {
  if (typeof value !== "boolean") {
    throw new RestrictedCelError("boolean operand required", offset);
  }
  return value;
}

function requireNumber(value: JsonValue, offset: number): number {
  if (typeof value !== "number") {
    throw new RestrictedCelError("numeric operand required", offset);
  }
  return value;
}

function assertNumber(value: number, offset: number): number {
  // 所有算术出口都要经过这里，保证结果仍是 JSON 能表示的数字
  // NaN 与 Infinity 一律拒绝，除法、取模与溢出都可能产生它们
  // 整数必须落在安全整数区间，超出后序列化再解析会失真
  // 非整数浮点不受此限制，但调用方不应假设其十进制精度
  // 直接放行会让序列化输出 null，把错误推迟到更难定位的落盘阶段
  if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
    throw new RestrictedCelError("numeric result is not JSON-safe", offset);
  }
  return value;
}

function assertRestrictedCelValue(
  value: unknown,
  offset: number,
): asserts value is RestrictedCelValue {
  if (typeof value === "string") return;
  if (typeof value === "number") {
    assertNumber(value, offset);
    return;
  }
  throw new RestrictedCelError("input value must be a string or number", offset);
}

function jsonEquals(left: JsonValue, right: JsonValue): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((entry, index) => jsonEquals(entry, right[index]!))
    );
  }
  if (isJsonObject(left) && isJsonObject(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every((key) => Object.hasOwn(right, key) && jsonEquals(left[key]!, right[key]!))
    );
  }
  return false;
}

function freezeJson<T extends JsonValue>(value: T): T {
  if (Array.isArray(value)) {
    for (const entry of value) freezeJson(entry);
  } else if (isJsonObject(value)) {
    // 冻结是递归的：数组逐元素、普通对象逐值，先处理子结构再冻结自身
    // 只处理自有可枚举值，原型链上的对象不属于 JSON 语义范围
    // 基本类型直接返回，避免为字符串和数字创建无意义的包装
    // 同一子树被多处引用时会被重复冻结，重复冻结幂等且不引入额外状态
    // 只在顶层冻结时，嵌套数组仍可被调用方改写，不可变承诺随之失效
    for (const entry of Object.values(value)) freezeJson(entry);
  } else {
    return value;
  }
  return Object.freeze(value);
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
