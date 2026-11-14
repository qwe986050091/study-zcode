import ts from "typescript";
import { FACADE_DTS, FACADE_FILE_NAME } from "../facade/dts.js";
import { TS_LIBS } from "./libs.generated.js";

/** One diagnostic, positioned in the author's script (1-based line/column). */
// 单条编译诊断，坐标已换算回作者脚本文本（prelude 行已扣掉）。
export interface CompileDiagnostic {
  // TypeScript 原始诊断码（如 1184 = 修饰符位置非法）；下游按码分流，不要去解析文案。
  code: number;
  // 列号，1-based，按 UTF-16 代码单元计数（不是字节、不是显示宽度）。
  column: number;
  // 行号，1-based 且不小于 1；作者脚本坐标系，不是包装后源码的物理行。
  line: number;
  // 已展平的诊断文案；TS1184 且命中 declare/export 时会被改写为可操作提示。
  message: string;
}

// 编译结果：只有诊断，不产出代码（noEmit）。ok 是派生标志，恒等于 diagnostics 为空。
export interface CompileResult {
  // 语法诊断在前、语义诊断在后，不去重不排序；空数组即"通过"。
  diagnostics: CompileDiagnostic[];
  // 与 `diagnostics.length === 0` 等价，仅为调用方便利；不另行过滤警告。
  ok: boolean;
}

// 虚拟 host 里脚本固定使用的文件名；站点收集、facade 判定与行号换算都按它比对文件名，
// 改名会让这些按名分流的逻辑静默失效。
export const SCRIPT_FILE_NAME = "workflow-script.ts";

// Name of the wrapper function the script body is spliced into (see SCRIPT_PRELUDE).
// The site walk locates this declaration to bound its traversal to the authored
// body and to tell top-level `return`s apart from ones in nested functions.
export const WORKFLOW_FUNCTION_NAME = "__workflowScript__";

// The script is wrapped in an async function before typechecking, mirroring the
// runtime execution shape (AsyncFunction body): top-level await and a final
// `return <artifact>` are both legal, and the file stays a non-module global
// script so the facade declarations are in scope without imports.
// No return-type annotation: an annotated Promise<unknown> would demand a return
// statement (TS2355), but scripts may legitimately end without one.
const SCRIPT_PRELUDE = `async function ${WORKFLOW_FUNCTION_NAME}() {\n`;
/**
 * 包装前缀的长度：wrapped 源码里的位置减去它就是作者原文里的偏移。留白补全的拼接
 * （analysis/hole-splice.ts）要按站点表里的节点位置在原文上插入文本，走的正是这条换算。
 */
export const SCRIPT_PRELUDE_LENGTH = SCRIPT_PRELUDE.length;
const SCRIPT_EPILOGUE = "\n}\nexport {};\n";
const PRELUDE_LINES = 1;

// 编译选项口径：strict 开、noUncheckedIndexedAccess 关（模型普遍按下标不判空写代码，
// 开它会制造大量与语义无关的报错）；types 为空，脚本只看到 ES2022 + facade，`process`/
// `fetch` 在编译期即被拒，纯函数契约从类型检查开始。全程 noEmit，不触碰磁盘。
const COMPILER_OPTIONS: ts.CompilerOptions = {
  allowJs: false,
  lib: ["lib.es2022.d.ts"],
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  noEmit: true,
  skipLibCheck: true,
  // `strict` on, `noUncheckedIndexedAccess` deliberately OFF. Models write TS as
  // if the flag were off — training corpora almost universally have it off — so
  // with it on, TS2532/TS18048 on `items[i]` was the single largest source of
  // compile failures (96% of the undefined-family diagnostics in local runs),
  // almost all on indexes whose bounds the surrounding logic already proved.
  // `strictNullChecks` stays: `.find()` / `match()` / optional properties are
  // real hazards and their messages name the cause.
  strict: true,
  target: ts.ScriptTarget.ES2022,
  // No ambient @types: the script sees ES2022 + the facade and nothing else.
  // `process`, `fetch`, `require` etc. fail typechecking — the purity contract
  // starts at compile time.
  types: [],
};

/** A prelude-adjusted, 1-based location in the author's script coordinates. */
// 作者脚本坐标系中的位置：line/column 均 1-based，已扣掉包装前缀行。
export interface ScriptLoc {
  // 行号，1-based，最小为 1（包装前缀内的位置会被夹到 1）。
  line: number;
  // 列号，1-based，按字符计；同一行内可超出脚本原文宽度（前缀已扣掉，故不会出现）。
  column: number;
}

/**
 * The typed program plus the two things every downstream analysis needs: the
 * wrapped script's source file (to walk) and a mapper from raw scanner positions
 * back into the author's 1-based, prelude-stripped coordinates.
 */
// 编译产物：program（含 checker，schema 合成与站点提取都从它出发）、scriptFile（包装后
// 脚本的 SourceFile，供 AST 遍历与 node.getStart 取偏移）、toScriptLoc（把扫描偏移换算回
// 作者坐标）。三者必须同源于一次 createProgram，节点身份才能互认。
export interface WorkflowProgram {
  // 类型化程序对象；持有 checker 与全部 SourceFile 缓存，不可跨脚本复用。
  program: ts.Program;
  // 包装后脚本的源文件（含 prelude/epilogue），遍历与 getStart 均以它为基准。
  scriptFile: ts.SourceFile;
  // 偏移 → 作者坐标；输入是原始 scanner 偏移（0-based），输出 1-based 行列。
  toScriptLoc(pos: number): ScriptLoc;
}

/**
 * {@link createWorkflowProgram} 的选项。`facadeDts` 允许注入一份**替代的 facade 文本**
 * （snippet eval 的 scratch facade）；它永远以
 * {@link FACADE_FILE_NAME} 为文件名进虚拟 host——facade 身份在 registry / sites /
 * facade-misuse / lowering 五处按声明文件名判定，换名字会让站点收集静默变空。
 */
export interface CreateWorkflowProgramOptions {
  facadeDts?: string;
}

/**
 * Build the typed program for a workflow script: the wrapped script + facade
 * `.d.ts` + embedded stdlib, compiled in the virtual host. This is the shared
 * substrate — diagnostics, schema synthesis and site-graph extraction all hang
 * off the one Program and checker built here.
 */
// 构建类型化程序：脚本原文包进 async 函数壳，与 facade `.d.ts`、内置 stdlib 一起放进
// 全虚拟 host 编译，全程不落盘。失败语义：脚本自身的语法/类型错误不抛错，只体现在
// collectDiagnostics；唯一抛出的是虚拟 host 应产出脚本文件却缺失（内部不变量被破坏）。
// 纯函数：不读环境、不写全局；每次调用新建 Program/checker，调用方自行承担编译开销。
export function createWorkflowProgram(
  scriptText: string,
  options?: CreateWorkflowProgramOptions,
): WorkflowProgram {
  const wrapped = `${SCRIPT_PRELUDE}${scriptText}${SCRIPT_EPILOGUE}`;
  const host = createVirtualHost(wrapped, options?.facadeDts ?? FACADE_DTS);
  const program = ts.createProgram({
    host,
    options: COMPILER_OPTIONS,
    rootNames: [SCRIPT_FILE_NAME, FACADE_FILE_NAME],
  });
  const scriptFile = program.getSourceFile(SCRIPT_FILE_NAME);
  if (scriptFile === undefined) {
    throw new Error("workflow script source file missing from program");
  }
  const toScriptLoc = (pos: number): ScriptLoc => {
    const { character, line } = scriptFile.getLineAndCharacterOfPosition(pos);
    return { column: character + 1, line: Math.max(1, line - PRELUDE_LINES + 1) };
  };
  return { program, scriptFile, toScriptLoc };
}

/** Collect and script-position the program's syntactic + semantic diagnostics. */
// 收集语法 + 语义诊断并统一换算坐标；顺序为"先语法后语义"，不排序、不去重、不丢弃。
// 空数组表示通过（调用方据此判断）；无副作用，可重复调用但结果随 checker 缓存稳定。
export function collectDiagnostics(program: ts.Program): CompileDiagnostic[] {
  return [...program.getSyntacticDiagnostics(), ...program.getSemanticDiagnostics()].map(
    toCompileDiagnostic,
  );
}

/**
 * Typecheck a workflow script against the facade in a fully virtual compiler host.
 * Scaffold scope: diagnostics only. Schema synthesis, site-graph extraction and
 * dependency inference build on the same Program in later steps.
 */
// 对外最小入口：一次编译 + 诊断收集，ok 严格由"零诊断"推导，不做警告分级或降级。
// 每次调用都新建 Program（较贵）；批量分析场景应直接复用 createWorkflowProgram。
export function compileWorkflowScript(scriptText: string): CompileResult {
  const { program } = createWorkflowProgram(scriptText);
  const diagnostics = collectDiagnostics(program);
  return { diagnostics, ok: diagnostics.length === 0 };
}

// Fully virtual compiler host: every file the program can see — the wrapped
// script, the facade, and the embedded TS stdlib closure (TS_LIBS) — is served
// from an in-memory Map. Nothing touches disk, so the bundled/SEA CLI (no
// node_modules) behaves identically to dev: a missing lib fails package tests
// too, instead of only breaking in the bundle.
// 全虚拟 CompilerHost：脚本、facade、内置 stdlib 全在内存 Map 中，fileExists/readFile
// 只查这份表；writeFile 直接抛错——noEmit 下任何写出都是 bug。SourceFile 按文件名缓存，
// 保证同一次编译内节点身份稳定；大小写敏感固定为 true，与打包环境无关。
function createVirtualHost(wrappedScript: string, facadeDts: string): ts.CompilerHost {
  const virtualFiles = new Map<string, string>([
    [SCRIPT_FILE_NAME, wrappedScript],
    [FACADE_FILE_NAME, facadeDts],
    ...Object.entries(TS_LIBS),
  ]);
  const sourceFileCache = new Map<string, ts.SourceFile>();

  return {
    getSourceFile: (fileName, languageVersionOrOptions) => {
      const cached = sourceFileCache.get(fileName);
      if (cached !== undefined) return cached;
      const text = virtualFiles.get(fileName);
      // 未登记的文件返回 undefined（交给 TS 报"找不到模块/文件"），不抛错：缺失是
      // 输入问题，应由诊断通道呈现，而不是让整次分析失败。
      if (text === undefined) return undefined;
      const sourceFile = ts.createSourceFile(fileName, text, languageVersionOrOptions, true);
      sourceFileCache.set(fileName, sourceFile);
      return sourceFile;
    },
    getDefaultLibFileName: (options) => ts.getDefaultLibFileName(options),
    writeFile: () => {
      throw new Error("workflow compile is noEmit; nothing may write output");
    },
    getCurrentDirectory: () => "/",
    getCanonicalFileName: (fileName) => fileName,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: (fileName) => virtualFiles.has(fileName),
    readFile: (fileName) => virtualFiles.get(fileName),
  };
}

// TS1184 ("Modifiers cannot appear here.") is what a script-top-level `declare`
// or `export` compiles to, because the body is spliced into SCRIPT_PRELUDE's
// function — ambient declarations and exports are both illegal there. The raw
// text never names the offending modifier, so the model's self-repair loop can
// only guess; these rewrites name it and give the fix. Keyed on the exact
// modifier span, so any other misplaced modifier keeps the compiler's wording.
// 键是被误置修饰符的原文片段（"declare"/"export"），值是面向模型自修复的提示；
// 以精确片段为键，任何其他误置修饰符仍走编译器原文，不扩大改写范围。
const AMBIENT_MODIFIER_MESSAGES = new Map<string, string>([
  [
    "declare",
    "The `declare` modifier is not allowed in a workflow script: the script is compiled inside a function body, where ambient declarations are illegal. Remove `declare` and write a plain declaration (e.g. `interface Foo { ... }`).",
  ],
  [
    "export",
    "`export` is not allowed in a workflow script: the script is compiled inside a function body. Remove `export` — the workflow's output is its final `return` value.",
  ],
]);

const MISPLACED_MODIFIER_CODE = 1184;

// 把 TS 诊断换算成作者坐标：无文件/无偏移的全局诊断钉在 1:1；脚本文件扣除 prelude 行，
// facade 诊断保留原行号。行号夹到 1，避免前缀区域内的错误出现 0 行。
function toCompileDiagnostic(diagnostic: ts.Diagnostic): CompileDiagnostic {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
  if (diagnostic.file === undefined || diagnostic.start === undefined) {
    return { code: diagnostic.code, column: 1, line: 1, message };
  }
  const { character, line } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
  const scriptLine = diagnostic.file.fileName === SCRIPT_FILE_NAME ? line - PRELUDE_LINES : line;
  return {
    code: diagnostic.code,
    column: character + 1,
    line: Math.max(1, scriptLine + 1),
    message: rewriteAmbientModifierMessage(diagnostic) ?? message,
  };
}

/** The actionable replacement for a script-level `declare` / `export`, if this is one. */
// 仅在"TS1184 + 落在脚本文件 + 带完整 start/length"三条件都满足时才尝试改写，
// 且只命中 declare/export 精确片段；其余返回 undefined，保留编译器原文措辞。
function rewriteAmbientModifierMessage(diagnostic: ts.Diagnostic): string | undefined {
  if (
    diagnostic.code !== MISPLACED_MODIFIER_CODE ||
    diagnostic.file?.fileName !== SCRIPT_FILE_NAME ||
    diagnostic.start === undefined ||
    diagnostic.length === undefined
  ) {
    return undefined;
  }
  const span = diagnostic.file.text.slice(diagnostic.start, diagnostic.start + diagnostic.length);
  return AMBIENT_MODIFIER_MESSAGES.get(span);
}
