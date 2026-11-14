import ts from "typescript";
import { FACADE_FILE_NAME } from "../facade/dts.js";

/**
 * The callback-semantics registry: the ONE place that says what a library callee does with
 * the script-local functions handed to it.
 *
 * Invocation is a semantic fact. The taint listener already treats functions as values and
 * applies whatever reaches a call (directly, or pessimistically through the keystone rule
 * for unknown callees). The ordering listener must NOT guess from syntax what the taint
 * listener knows from values — so the only thing left to write down is what the taint
 * domain cannot express: how OFTEN a library invokes its callback and whether it PROVABLY
 * does. Both listeners read this table; neither keeps a private whitelist.
 *
 *  - `each`: the callback runs once per element of `iterated`. The site table turns such a
 *    call into an iteration candidate (a fan-out relay, promoted when its body reaches a
 *    facade site); the ordering walk opens a `fanout` region around the body.
 *  - `once`: the callback runs at most once. The ordering walk opens a `call` region,
 *    `entered` iff the library provably invokes it (a `Promise` executor, `.finally`).
 *
 * A callee with no entry gets {@link DEFAULT_CALLBACK_SEMANTICS}: once, not entered, every
 * argument a potential callback — exactly the set the taint keystone applies, so no function
 * value that reaches a call is ever left for the end-of-walk sweep.
 *
 * Deliberately NOT here: `.call` / `.apply` / `.bind` (they forward the CALLEE, not a callback;
 * calls.ts routes those through the callee application path) and the facade's own functions.
 */

export type CallbackMultiplicity = "each" | "once";

// 回调调用频次：`each` 表示每个元素调用一次（对应 fan-out 区域），`once` 表示至多一次
// （对应普通 call 区域）。该枚举是回调语义表的判别键，其它模块不应再自行推断频次。
export interface CallbackSemantics {
  // 频次判别键；决定站点表是否生成迭代候选、以及 ordering walk 开哪种区域。
  multiplicity: CallbackMultiplicity;
  /** Running the call provably runs the callback body (at least once). */
  // 是否可证明「调用即必然执行回调体」。true 只给确定会调用的库语义（Promise 执行器、
  // .finally、future）；false 时 walk 仍会开区域，但按未进入处理（不虚构执行事实）。
  entered: boolean;
  /** Argument indices that may hold callbacks, in order. */
  // 可能承载回调的实参下标，升序；空数组表示无回调候选，下标越界时调用方应跳过而非补空。
  callbacks: readonly number[];
  /** Display / region label: the method or global function name. */
  // 展示/区域标签，取方法名或全局函数名（如 "map"、"Promise"、"future"）；不参与逻辑判断。
  label: string;
  /**
   * `once` only: the callback runs AFTER the receiver settles (a promise continuation, a
   * timer), not during the call. The ordering walk places the body at the call site and
   * opens it with a may-barrier over the receiver, so the receiver's steps precede the
   * callback's without the continuation being mistaken for a synchronous call.
   */
  // 仅 once 使用：true 表示回调在接收者 settle 之后才跑（promise 续体/定时器）。walk 据此
  // 在接收者上加 may 屏障，避免把续体误排成同步调用；each 条目不会带该字段。
  deferred?: true;
  /** `each` only: the expression the callback is applied to element-wise. */
  // 仅 each 使用：被逐元素遍历的表达式（即接收者或 Array.from 的首参）；作为 fan-out 的输入源。
  iterated?: ts.Expression;
  /** `each` only: callback parameter indices that receive an ELEMENT. */
  // 仅 each 使用：接收单个元素的回调参数下标；第一个元素参数承载带 fan-out 标签的值。
  elementParams?: readonly number[];
  /** `each` only: callback parameter indices that receive the WHOLE collection. */
  // 仅 each 使用：接收整个集合的回调参数下标（运行时与接收者同一对象，故绑定同样的值）。
  wholeParams?: readonly number[];
  /** `each` only: the callback parameter index that receives the accumulator (`reduce`). */
  // 仅 each 使用：接收累加器的回调参数下标（reduce/reduceRight 为 0）；缺省表示非 accumulator 语义。
  accumulatorParam?: number;
}

/** What an unknown callee is assumed to do with function-valued arguments. */
// 未登记被调函数的兜底语义：至多调用一次且不可证明进入，交由调用方按 keystone 规则
// 把「所有到达该调用的函数值」都当作潜在回调处理，保证不会漏掉未识别的回调。
// 该常量被多处共用，修改会同时影响 taint 与 ordering 两个监听器。
export const DEFAULT_CALLBACK_SEMANTICS: Pick<CallbackSemantics, "multiplicity" | "entered"> = {
  entered: false,
  multiplicity: "once",
};

/** Array methods that invoke their callback per element. Name-based on any receiver that is
 * not a script-declared method (a user class's own `.map` is a user function: callee path).
 * Value: element / whole-collection / accumulator parameter indices of the callback. */
const EACH_METHODS: ReadonlyMap<string, { element: readonly number[]; whole: readonly number[]; accumulator?: number }> =
  new Map([
    ["map", { element: [0], whole: [2] }],
    ["flatMap", { element: [0], whole: [2] }],
    ["forEach", { element: [0], whole: [2] }],
    ["filter", { element: [0], whole: [2] }],
    ["some", { element: [0], whole: [2] }],
    ["every", { element: [0], whole: [2] }],
    ["find", { element: [0], whole: [2] }],
    ["findIndex", { element: [0], whole: [2] }],
    ["findLast", { element: [0], whole: [2] }],
    ["findLastIndex", { element: [0], whole: [2] }],
    ["reduce", { accumulator: 0, element: [1], whole: [3] }],
    ["reduceRight", { accumulator: 0, element: [1], whole: [3] }],
    ["sort", { element: [0, 1], whole: [] }],
  ]);

/** Promise continuation methods: run at most once, after the receiver settles. */
const ONCE_METHODS: ReadonlyMap<string, { callbacks: readonly number[]; entered: boolean; deferred: true }> = new Map([
  ["then", { callbacks: [0, 1], deferred: true, entered: false }],
  ["catch", { callbacks: [0], deferred: true, entered: false }],
  ["finally", { callbacks: [0], deferred: true, entered: true }],
]);

/** Global scheduling functions: run their callback once, later. */
const ONCE_GLOBALS: ReadonlySet<string> = new Set(["setTimeout", "setInterval", "setImmediate", "queueMicrotask"]);

/**
 * The one facade function that takes a callback: `future(body)` starts `body` at the call
 * and returns its promise (docs/dynamic-workflow/authoring.md「Streams」). Once and ENTERED —
 * the cell provably calls it — and NOT deferred: it runs now, not after anything settles, so
 * the ordering walk inlines the body as an entered `call` region, a strand when it is async.
 */
const FUTURE_FUNCTION = "future";

/**
 * The registry entry for a call or `new`, or undefined when the callee has none (callers
 * fall back to {@link DEFAULT_CALLBACK_SEMANTICS} for whatever function values reach it).
 * Never matches a callee declared in the authored script: a script-local `then` is a
 * script-local function, applied through the callee path.
 */
export function callbackSemanticsOf(
  node: ts.CallExpression | ts.NewExpression,
  checker: ts.TypeChecker,
  program: ts.Program,
): CallbackSemantics | undefined {
  // 职责：按被调方的符号/全局身份查回调语义，返回唯一权威条目。
  // 输入：node 为调用或 new 表达式；checker/program 用于判定符号来源（是否 ES lib）。
  // 输出：命中时返回完整条目，未命中返回 undefined（调用方必须回落到 DEFAULT 兜底，
  // 不能把 undefined 当作「无回调」）。
  // 判定顺序：new Promise → 属性访问方法（Array.from / each 方法 / once 方法）→ 全局函数
  // （setTimeout 等）→ facade 的 future。顺序即优先级，前者命中即不再看后者。
  // 副作用：只读 AST/checker，无 IO、无缓存写入；可重复调用。
  // 维护不变量：脚本内自定义同名方法是用户函数，必须先排除，否则会把用户实现当库语义。
  const args = node.arguments ?? [];
  if (ts.isNewExpression(node)) {
    if (isGlobalLibValue(node.expression, "Promise", checker, program) && args.length > 0) {
      return { callbacks: [0], entered: true, label: "Promise", multiplicity: "once" };
    }
    return undefined;
  }
  const callee = node.expression;
  if (ts.isPropertyAccessExpression(callee)) {
    // 脚本内声明的方法优先：用户自己的 `.map` 走 callee 应用路径，绝不能被当库方法展开。
    if (isScriptDeclared(callee.name, checker, program)) return undefined;
    const method = callee.name.text;
    if (method === "from" && isGlobalLibValue(callee.expression, "Array", checker, program)) {
      const iterated = args[0];
      // Array.from 的映射函数是第二个实参：缺首参或只有一个实参时没有回调可描述的语义。
      if (iterated === undefined || args.length < 2) return undefined;
      return { callbacks: [1], elementParams: [0], entered: false, iterated, label: "from", multiplicity: "each", wholeParams: [] };
    }
    const each = EACH_METHODS.get(method);
    if (each !== undefined) {
      return {
        callbacks: [0],
        elementParams: each.element,
        entered: false,
        iterated: callee.expression,
        label: method,
        multiplicity: "each",
        wholeParams: each.whole,
        ...(each.accumulator === undefined ? {} : { accumulatorParam: each.accumulator }),
      };
    }
    const once = ONCE_METHODS.get(method);
    if (once !== undefined) return { ...once, label: method, multiplicity: "once" };
    return undefined;
  }
  if (ts.isIdentifier(callee) && ONCE_GLOBALS.has(callee.text) && isGlobalLibValue(callee, callee.text, checker, program)) {
    return { callbacks: [0], deferred: true, entered: false, label: callee.text, multiplicity: "once" };
  }
  if (ts.isIdentifier(callee) && callee.text === FUTURE_FUNCTION && isFacadeFunction(callee, checker)) {
    return { callbacks: [0], entered: true, label: FUTURE_FUNCTION, multiplicity: "once" };
  }
  return undefined;
}

/** True iff `expr` resolves to a function declared in the facade `.d.ts` (not a user shadow). */
function isFacadeFunction(expr: ts.Expression, checker: ts.TypeChecker): boolean {
  let symbol = checker.getSymbolAtLocation(expr);
  if (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0) symbol = checker.getAliasedSymbol(symbol);
  return (
    symbol?.declarations?.some((declaration) => declaration.getSourceFile().fileName === FACADE_FILE_NAME) ?? false
  );
}

/** True iff `expr` resolves to the ES-lib global `name` (not a user shadow). */
// 判定表达式是否解析到 ES 标准库的全局 `name`：先解 alias，再校验符号名与声明文件来源。
// 用于排除用户遮蔽（脚本里 `const setTimeout = …` 或自定义 `Array`）时误判为库语义；
// 返回布尔值，expr 无符号或声明缺失时返回 false（保守地不当作库）。
export function isGlobalLibValue(
  expr: ts.Expression,
  name: string,
  checker: ts.TypeChecker,
  program: ts.Program,
): boolean {
  let symbol = checker.getSymbolAtLocation(expr);
  if (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0) symbol = checker.getAliasedSymbol(symbol);
  if (symbol?.name !== name) return false;
  return symbol.declarations?.some((declaration) => isLibDeclaration(declaration, program)) ?? false;
}

/**
 * True iff the member is DECLARED, and nowhere in the authored script: a library or facade
 * method (`p.finally`, `xs.map`, `node.ask`). Such a member can never BE a script function,
 * however many function values the receiver's abstract value happens to carry — a whole-value
 * read of a container with an absent field collapses to everything in it, callables included,
 * and dispatching on those would inline callbacks as the callee of `.finally`. An undeclared
 * member (an `any` receiver) keeps the value-based answer.
 */
export function isForeignMember(name: ts.MemberName, checker: ts.TypeChecker, scriptFile: ts.SourceFile): boolean {
  // 判定成员是否为「非脚本声明」的外部成员（库/facade 方法）。无声明（any 接收者）时返回
  // false，保留按值判定的旧行为；有声明但全部在脚本文件外时才认为外部，避免把用户实现当库。
  const declarations = checker.getSymbolAtLocation(name)?.declarations;
  if (declarations === undefined || declarations.length === 0) return false;
  return declarations.every((declaration) => declaration.getSourceFile() !== scriptFile);
}

/** True iff the member's symbol has a declaration in the authored script (a user method). */
function isScriptDeclared(name: ts.MemberName, checker: ts.TypeChecker, program: ts.Program): boolean {
  const symbol = checker.getSymbolAtLocation(name);
  return (
    symbol?.declarations?.some((declaration) => {
      const file = declaration.getSourceFile();
      return !isLibDeclaration(declaration, program) && !file.isDeclarationFile;
    }) ?? false
  );
}

function isLibDeclaration(declaration: ts.Declaration, program: ts.Program): boolean {
  const file = declaration.getSourceFile();
  return program.isSourceFileDefaultLibrary(file) || /^lib\..+\.d\.ts$/.test(file.fileName);
}
