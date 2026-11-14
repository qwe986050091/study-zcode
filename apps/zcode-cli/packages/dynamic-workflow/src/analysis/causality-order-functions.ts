import ts from "typescript";
import { isFunctionLike } from "./sites.js";
import type { ApplicationVia } from "./state.js";

// causality-order.ts 顶到 oxlint max-lines 上限（400 行），把函数解析类的纯辅助
// （脚本函数判定、外层函数链、函数命名、调用声明解析、递归 SCC 预计算、绑定名展开）拆到
// 本文件；公开面仍从 causality-order.ts 导出。这里的函数都不读走查状态，只看 AST 与 checker。

export type ScriptFunction = ts.SignatureDeclaration & { body: ts.Node };

// 脚本内「有函数体」的函数类节点。与库/facade 声明区分的关键在于 body 存在且属于脚本文件；
// 该别名是下方 asScriptFunction 的类型收窄结果，不是运行时对象，不携带任何状态。
/** Identifiers a binding name introduces (an identifier, or every leaf of a pattern). */
// 把绑定名展开成它引入的所有标识符：标识符本身返回单项，解构模式递归展开所有叶子，
// 省略元素（`[a, , c]` 的空位）直接跳过。返回新数组，顺序为源码书写顺序，空模式返回 []。
export function boundIdentifiers(name: ts.BindingName): ts.Identifier[] {
  if (ts.isIdentifier(name)) return [name];
  const out: ts.Identifier[] = [];
  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) continue;
    out.push(...boundIdentifiers(element.name));
  }
  return out;
}

export function asScriptFunction(
  node: ts.Node,
  scriptFile: ts.SourceFile,
): ScriptFunction | undefined {
  // 判定并收窄为「脚本内可内联函数」：必须函数类节点、声明文件属于脚本文件、且有函数体。
  // 三个条件任一不满足返回 undefined（外部库/facade 声明不可内联，无体函数也没有摘要）。
  if (!isFunctionLike(node)) return undefined;
  if (node.getSourceFile() !== scriptFile) return undefined;
  const body = (node as ts.SignatureDeclaration & { body?: ts.Node }).body;
  return body === undefined ? undefined : (node as ScriptFunction);
}

/** The function-like ancestors of a node, innermost first. */
// 返回节点由内到外的所有脚本函数祖先（不含节点自身），用于判定某个站点处于哪层函数内。
// 只收集脚本文件内的函数；无祖先时返回空数组，顺序即嵌套深度顺序（越靠前越内层）。
export function enclosingFunctions(node: ts.Node): ScriptFunction[] {
  const scriptFile = node.getSourceFile();
  const out: ScriptFunction[] = [];
  for (let current = node.parent; current !== undefined; current = current.parent) {
    const fn = asScriptFunction(current, scriptFile);
    if (fn !== undefined) out.push(fn);
  }
  return out;
}

export function functionName(decl: ts.Node): string | undefined {
  // 给函数节点取展示名：构造函数取类名，命名函数/方法取自身标识符，匿名函数表达式回退到
  // 所在的变量声明名。都取不到时返回 undefined（调用方应用占位标签，不能拼空字符串）。
  // A constructor is named by its class: `new Judge()` inlines as a call labelled "Judge".
  if (ts.isConstructorDeclaration(decl)) {
    const cls = decl.parent;
    return ts.isClassLike(cls) && cls.name !== undefined ? cls.name.text : undefined;
  }
  const named = decl as { name?: ts.Node };
  if (named.name !== undefined && ts.isIdentifier(named.name)) return named.name.text;
  const parent = decl.parent;
  if (parent !== undefined && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    return parent.name.text;
  }
  return undefined;
}

/**
 * The script-local function a call resolves to. `getResolvedSignature` handles the
 * hard shapes (methods, overloads, aliased consts) in one hop; anything outside the
 * authored file (the facade, the stdlib) is not inlinable.
 */
export function resolveCallDeclaration(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
  scriptFile: ts.SourceFile,
): ScriptFunction | undefined {
  // 解析调用实际指向的脚本内函数声明；一步 getResolvedSignature 覆盖方法/重载/别名常量等形态。
  // 解析不到签名或声明在脚本文件之外（facade、stdlib）时返回 undefined——外部实现不可内联。
  const declaration = checker.getResolvedSignature(call)?.declaration;
  if (declaration === undefined) return undefined;
  return asScriptFunction(declaration, scriptFile);
}

/**
 * Script-local functions that can reach themselves in the call graph — the SCCs the analysis turns into `loop` regions instead of unrolling. Callees are the union of the
 * checker's resolved declarations and the call oracle's applications (both vias: a
 * function handed to a library that hands it back is a cycle too). Nested function bodies
 * count as their owner's callees, which over-approximates cycles; over-approximating here
 * only costs a `loop` region, while under-approximating would unroll forever.
 */
export function collectRecursiveFunctions(
  scriptFile: ts.SourceFile,
  checker: ts.TypeChecker,
  applications: ReadonlyMap<ts.Node, ReadonlyMap<ts.Node, ApplicationVia>>,
): Set<ts.Node> {
  // 职责：预计算「调用图中能回到自身」的脚本函数集合（自环或 SCC 成员），供 walk 生成 loop
  // 区域而不是无限展开。输入为脚本文件、checker 与调用预言的应用表（callee/argument 两种方式）。
  // 输出：函数节点集合；无递归时为空集。判定用可达性搜索（每个函数一次 DFS），不用真 SCC 算法。
  // 边来源取「checker 解析声明 ∪ 调用预言应用」的并集：函数被库转手再调用也构成环。
  // 过近似口径：内层函数体计入外层被调方，可能多判一些环；多判只多一个 loop 区域，
  // 少判会导致无限展开，因此这里必须偏保守。纯函数，不写走查状态。
  const functions: ScriptFunction[] = [];
  const collect = (node: ts.Node): void => {
    const fn = asScriptFunction(node, scriptFile);
    if (fn !== undefined) functions.push(fn);
    ts.forEachChild(node, collect);
  };
  collect(scriptFile);

  const callees = new Map<ts.Node, Set<ts.Node>>();
  for (const fn of functions) {
    const set = new Set<ts.Node>();
    const scan = (node: ts.Node): void => {
      // 收集 fn.body 内的调用边：语法调用走 checker；调用/构造/tagged template 再并上
      // 预言记录的应用（同一节点可能两种方式都记录，Set 天然去重）。
      if (ts.isCallExpression(node)) {
        const target = resolveCallDeclaration(node, checker, scriptFile);
        if (target !== undefined) set.add(target);
      }
      if (
        ts.isCallExpression(node) ||
        ts.isNewExpression(node) ||
        ts.isTaggedTemplateExpression(node)
      ) {
        for (const applied of applications.get(node)?.keys() ?? []) {
          const target = asScriptFunction(applied, scriptFile);
          if (target !== undefined) set.add(target);
        }
      }
      ts.forEachChild(node, scan);
    };
    scan(fn.body);
    callees.set(fn, set);
  }

  const recursive = new Set<ts.Node>();
  for (const fn of functions) {
    const seen = new Set<ts.Node>();
    const stack = [...(callees.get(fn) ?? [])];
    while (stack.length > 0) {
      const next = stack.pop() as ts.Node;
      if (next === fn) {
        // 回到自身即递归，立刻记为递归函数：与其继续遍历（可能环），不如早点收敛。
        recursive.add(fn);
        break;
      }
      // seen 只在出栈后标记，配合栈式 DFS 避免同一节点重复展开；环由「next === fn」单独拦截。
      if (seen.has(next)) continue;
      seen.add(next);
      stack.push(...(callees.get(next) ?? []));
    }
  }
  return recursive;
}
