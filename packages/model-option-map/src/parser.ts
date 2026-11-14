// INV-01 表达式必须整体解析到 eof 才算成功；守住位置：parse 里 trailing.kind !== "eof" 的终检分支；改错故障：残留 token 被丢弃，用户配置的后半段静默失效。
// INV-02 成员访问与函数调用必须在解析期拒绝并给出专属文案；守住位置：parse 的 trailing.value 判定与 parsePrimary 对标识符后括号的判定；改错故障：用户写了 model.x 或 f() 却只在运行时炸，报错无法定位。
// INV-03 运算符优先级固定为条件、逻辑或、逻辑与、相等、关系、加减、乘除、一元、primary；守住位置：parseConditional 到 parseUnary 的逐层调用链；改错故障：1 + 2 * 3 被算成 9，选项判定结果整体偏移。
// INV-04 二元运算左结合；守住位置：parseBinary 的 while 循环与 expression 覆写；改错故障：减法与除法的结合方向反转，比例阈值判断出错。
// INV-05 条件表达式右结合且两个分支都递归到 parseConditional；守住位置：parseConditional 内两处递归调用；改错故障：嵌套三元被截断，后半段变成 unexpected token。
// INV-06 每个 AST 节点都必须携带源 offset；守住位置：各 parse 方法返回对象上的 offset 字段；改错故障：错误位置指向别的字符，用户无法在配置里找到问题。
// INV-07 数字字面量必须 JSON 安全，有限且整数时为安全整数；守住位置：parsePrimary 的 Number.isFinite 与 Number.isSafeInteger 判定；改错故障：超大整数失精后仍被接受，条件比较出现隐形偏差。
// INV-08 标识符只允许受控变量名与 true、false、null；守住位置：parsePrimary 的 identifier 分支；改错故障：拼错的变量名被当作合法输入，条件恒为假而无人察觉。
// INV-09 数组与对象的容器字段必须在返回前冻结；守住位置：parseArray 与 parseObject 的返回值；改错故障：下游误改已解析 AST，同一表达式两次求值结果不同。
// INV-10 对象键只能是字符串字面量且不可重复；守住位置：parseObject 的 key.kind 校验与 keys 去重集合；改错故障：重复键被后者覆盖，用户看不到冲突提示。
// INV-11 逗号仅作分隔符，不允尾随逗号；守住位置：parseArray 与 parseObject 的 do-while 加 expect 收尾；改错故障：[1,] 被接受，与文档声明的受限语法不一致。
// INV-12 空数组与空对象是合法字面量；守住位置：parseArray 与 parseObject 开头对右括号的 consume；改错故障：用 [] 或 {} 作为默认值直接解析失败。
// INV-13 一元运算符可叠加并递归自身；守住位置：parseUnary 的递归调用；改错故障：!!a 或 --1 解析失败，或优先级错层。
// INV-14 括号分组不产生 AST 节点；守住位置：parsePrimary 的左括号分支；改错故障：多出包装层，下游按 type 匹配时漏掉真实节点。
// INV-15 token 游标只能经 consume、expect、advance 前进；守住位置：Parser 的 #index 与这三个方法；改错故障：某处直接改下标，出现跳 token 或死循环。
// INV-16 advance 在 eof 上不得前进；守住位置：advance 的 token.kind !== "eof" 判断；改错故障：越界后读到 undefined，抛裸 TypeError 而非结构化错误。
// INV-17 current 越界时必须回退到最后一个 token；守住位置：current 的空值合并回退表达式；改错故障：错误路径自身崩溃，用户只看到内部异常。
// INV-18 所有失败都抛 RestrictedCelError 并带 offset；守住位置：解析器内全部 throw 点；改错故障：上层无法区分语法错误与其他异常，降级提示失效。
//
// 模块职责：把 tokenizer 产出的 RestrictedCelToken 序列解析为受限 CEL 的只读 AST，供 model-option-map 的条件求值使用。
// 状态所有权：#index 游标与各层临时集合只存在于 Parser 实例内，AST 由调用方持有，本模块不缓存也不复用解析状态。
// 阅读顺序：先看 RestrictedCelExpression 联合，再沿 parseConditional 到 parsePrimary 的优先级链，最后看四个游标辅助方法的契约。
import { RestrictedCelError, type ModelOptionName } from "./types.js";
// tokenizer 负责词法切分，本文件只消费 RestrictedCelToken，kind、value、offset 是解析的全部输入。
// [权衡] 不在此处复核 token 形状，词法层的保证由 tokenizer 单点承担，避免两处校验逐渐漂移。
// RestrictedCelError 与 ModelOptionName 都来自 types.js，错误类型与受控变量名集合在模块边界上统一。
import type { RestrictedCelToken } from "./tokenizer.js";

// RestrictedCelExpression 是判别联合，type 字段即判别式，下游应按它分支而不是按形状猜测。
// literal 承载 string、number、boolean、null 四类 JSON 标量，是唯一能直接求值出常量的节点。
// [权衡] 联合中每个字段都是 readonly，求值阶段无法回写 AST，新增节点类型时必须同步求值器。
export type RestrictedCelExpression =
  | {
      readonly type: "literal";
      readonly value: string | number | boolean | null;
      readonly offset: number;
    }
  | { readonly type: "input"; readonly offset: number }
  | {
      readonly type: "array";
      readonly elements: readonly RestrictedCelExpression[];
      readonly offset: number;
    }
  | {
      readonly type: "object";
      readonly entries: readonly {
        readonly key: string;
        readonly value: RestrictedCelExpression;
        readonly offset: number;
      }[];
      readonly offset: number;
    }
  | {
      readonly type: "unary";
      // 一元运算符在类型层收敛为取反、负号、正号三种，词法层即使产出其他符号也造不出 unary 节点。
      // operator 直接复用 token.value，不做规范化，符号语义以词法层定义为唯一来源。
      // [权衡] 不支持按位取反等 CEL 扩展运算符，遇到时走 unexpected token 失败路径。
      readonly operator: "!" | "-" | "+";
      readonly operand: RestrictedCelExpression;
      readonly offset: number;
    }
  | {
      readonly type: "binary";
      readonly operator: string;
      readonly left: RestrictedCelExpression;
      readonly right: RestrictedCelExpression;
      readonly offset: number;
    }
  | {
      readonly type: "conditional";
      readonly condition: RestrictedCelExpression;
      readonly whenTrue: RestrictedCelExpression;
      readonly whenFalse: RestrictedCelExpression;
      readonly offset: number;
    };

// parseRestrictedCel 是本模块唯一导出函数，保持纯函数语义：相同 tokens 与 variableName 必得相同 AST。
// [失败路径] 词法错误在进入本函数前已由 tokenizer 抛出，这里只处理语法层面的失败。
// 返回的 AST 已确认尾部只剩 eof，调用方拿到的是完整表达式而不是可继续解析的前缀。
export function parseRestrictedCel(
  tokens: readonly RestrictedCelToken[],
  variableName: ModelOptionName,
): RestrictedCelExpression {
  return new Parser(tokens, variableName).parse();
}

class Parser {
  // #index 是解析器唯一的可变状态，起点为 0，指向下一个待消费 token。
  // 它是私有字段，外部无法在解析中途改写位置，前进只能经 consume、expect、advance。
  // [权衡] 用私有字段而非公开属性，换取游标不变式的可证明性。
  #index = 0;

  constructor(
    private readonly tokens: readonly RestrictedCelToken[],
    // variableName 由构造参数注入并保持 readonly，一次解析内不允许切换受控变量。
    // 它只影响 identifier 分支：命中即产出 input，未命中才继续判断 true、false、null。
    // [失败路径] 变量名与配置键不一致时表现为 unknown identifier，而不是静默的恒假条件。
    private readonly variableName: ModelOptionName,
  ) {}

  parse(): RestrictedCelExpression {
    const expression = this.parseConditional();
    const trailing = this.current();
    // 解析成功与否的唯一判据是尾部 token 为 eof，而不是过程里有没有抛过异常。
    // [失败路径] 三元缺 else 时后续内容会残留成尾部 token，在这里被拦下。
    // [权衡] 不自动跳过或纠正残留 token，宁可报错也不猜测用户意图。
    if (trailing.kind !== "eof") {
      if (trailing.value === ".") {
        throw new RestrictedCelError("member access is not supported", trailing.offset);
      }
      if (trailing.value === "(") {
        throw new RestrictedCelError("function calls are not supported", trailing.offset);
      }
      throw new RestrictedCelError(
        `unexpected token ${JSON.stringify(trailing.value)}`,
        trailing.offset,
      );
    }
    return expression;
  }

  private parseConditional(): RestrictedCelExpression {
    const condition = this.parseLogicalOr();
    if (!this.consume("?")) return condition;
    const whenTrue = this.parseConditional();
    this.expect(":");
    const whenFalse = this.parseConditional();
    // 条件节点以 condition 的 offset 作为整体位置，错误可指向问号左侧的判定表达式。
    // whenTrue 与 whenFalse 都是完整的 parseConditional 结果，因此支持任意深度嵌套。
    // [权衡] 不生成惰性节点，短路语义留给求值器按 type 分支实现。
    return { type: "conditional", condition, whenTrue, whenFalse, offset: condition.offset };
  }

  private parseLogicalOr(): RestrictedCelExpression {
    return this.parseBinary(() => this.parseLogicalAnd(), new Set(["||"]));
  }

  private parseLogicalAnd(): RestrictedCelExpression {
    return this.parseBinary(() => this.parseEquality(), new Set(["&&"]));
  }

  private parseEquality(): RestrictedCelExpression {
    return this.parseBinary(() => this.parseRelational(), new Set(["==", "!="]));
  }

  private parseRelational(): RestrictedCelExpression {
    return this.parseBinary(() => this.parseAdditive(), new Set(["<", "<=", ">", ">="]));
  }

  private parseAdditive(): RestrictedCelExpression {
    return this.parseBinary(() => this.parseMultiplicative(), new Set(["+", "-"]));
  }

  private parseMultiplicative(): RestrictedCelExpression {
    return this.parseBinary(() => this.parseUnary(), new Set(["*", "/", "%"]));
  }

  private parseBinary(
    parseOperand: () => RestrictedCelExpression,
    operators: ReadonlySet<string>,
  ): RestrictedCelExpression {
    let expression = parseOperand();
    // parseBinary 是全部二元层的唯一实现，各层只传入不同的操作数回调与运算符集合。
    // 循环同时要求 token 类别为 operator 且符号在集合内，避免把相邻的其他符号误吞。
    // 每轮把旧表达式作为 left、新操作数作为 right，赋值顺序天然形成左结合。
    while (this.current().kind === "operator" && operators.has(this.current().value)) {
      const operator = this.advance();
      expression = {
        type: "binary",
        operator: operator.value,
        left: expression,
        right: parseOperand(),
        offset: operator.offset,
      };
    }
    return expression;
  }

  private parseUnary(): RestrictedCelExpression {
    const token = this.current();
    if (
      token.kind === "operator" &&
      (token.value === "!" || token.value === "-" || token.value === "+")
    ) {
      this.advance();
      return {
        type: "unary",
        operator: token.value,
        operand: this.parseUnary(),
        offset: token.offset,
      };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): RestrictedCelExpression {
    const token = this.advance();
    if (token.kind === "number") {
      const value = Number(token.value);
      // 数字字面量先转 Number 再判定：有限性拦下 Infinity 与 NaN，安全性拦下越界整数。
      // [失败路径] 命中即抛 number literal is not JSON-safe，错误 offset 指向该字面量。
      // [权衡] 不做静默截断或取整，宁可拒绝也不让精度损失进入配置。
      if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
        throw new RestrictedCelError("number literal is not JSON-safe", token.offset);
      }
      return { type: "literal", value, offset: token.offset };
    }
    if (token.kind === "string")
      return { type: "literal", value: token.value, offset: token.offset };
    if (token.kind === "identifier") {
      if (this.current().value === "(") {
        throw new RestrictedCelError("function calls are not supported", this.current().offset);
      }
      // 变量名判定排在 true、false、null 之前，受控变量名与关键字同名时优先识别为 input。
      // input 节点不复制 token 文本，变量名快照只保留在 Parser 的 variableName 上。
      // [权衡] 该顺序依赖 ModelOptionName 取值域不与关键字冲突，解析期不额外校验。
      if (token.value === this.variableName) return { type: "input", offset: token.offset };
      if (token.value === "true" || token.value === "false") {
        return { type: "literal", value: token.value === "true", offset: token.offset };
      }
      if (token.value === "null") return { type: "literal", value: null, offset: token.offset };
      throw new RestrictedCelError(
        `unknown identifier ${JSON.stringify(token.value)}`,
        token.offset,
      );
    }
    if (token.value === "(") {
      const expression = this.parseConditional();
      this.expect(")");
      return expression;
    }
    if (token.value === "[") return this.parseArray(token.offset);
    if (token.value === "{") return this.parseObject(token.offset);
    throw new RestrictedCelError(`unexpected token ${JSON.stringify(token.value)}`, token.offset);
  }

  private parseArray(offset: number): RestrictedCelExpression {
    const elements: RestrictedCelExpression[] = [];
    if (!this.consume("]")) {
      do elements.push(this.parseConditional());
      while (this.consume(","));
      this.expect("]");
    }
    // 数组节点返回前冻结 elements，AST 对调用方只读。
    // offset 取自左方括号，指向整个字面量的起始位置。
    // [权衡] Object.freeze 只冻结容器不深拷贝元素：元素构造后无写入点，深拷贝的代价换不到任何不变性。
    return { type: "array", elements: Object.freeze(elements), offset };
  }

  private parseObject(offset: number): RestrictedCelExpression {
    const entries: { key: string; value: RestrictedCelExpression; offset: number }[] = [];
    const keys = new Set<string>();
    if (!this.consume("}")) {
      do {
        const key = this.advance();
        if (key.kind !== "string") {
          // 对象键只接受字符串字面量，裸标识符键与数字键一律失败。
          // [失败路径] 键类型错误先于 expect 冒号暴露，错误 offset 落在该键 token 上。
          // 校验在查重之前完成，避免对非字符串键做无意义的集合查找。
          throw new RestrictedCelError("object keys must be string literals", key.offset);
        }
        if (keys.has(key.value)) {
          throw new RestrictedCelError(
            `duplicate object key ${JSON.stringify(key.value)}`,
            key.offset,
          );
        }
        keys.add(key.value);
        this.expect(":");
        entries.push({ key: key.value, value: this.parseConditional(), offset: key.offset });
      } while (this.consume(","));
      this.expect("}");
    }
    // entries 与数组的 elements 一样在返回前冻结，容器节点的只读契约保持一致。
    // 每个 entry 保留自己的 key offset，便于把错误精确到单个键值对。
    // [权衡] 键序保留插入顺序，不做排序，求值器按 entries 顺序遍历。
    return { type: "object", entries: Object.freeze(entries), offset };
  }

  private consume(value: string): boolean {
    if (this.current().value !== value) return false;
    this.#index += 1;
    return true;
  }

  private expect(value: string): RestrictedCelToken {
    const token = this.current();
    if (token.value !== value) {
      throw new RestrictedCelError(`expected ${JSON.stringify(value)}`, token.offset);
    }
    this.#index += 1;
    return token;
  }

  private advance(): RestrictedCelToken {
    const token = this.current();
    if (token.kind !== "eof") this.#index += 1;
    return token;
  }

  private current(): RestrictedCelToken {
    // current 是唯一的只读取 token 入口，越界时回退到最后一个 token，tokenizer 保证其为 eof。
    // [失败路径] 非空断言依赖 token 列表至少含 eof，本层不重复做空数组校验。
    // [权衡] 回退而非抛错，让错误集中由终检与 expect 输出结构化文案。
    return this.tokens[this.#index] ?? this.tokens[this.tokens.length - 1]!;
  }
}
