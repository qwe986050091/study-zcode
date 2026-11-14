/**
 * facade actor 段里的模型声明（docs/dynamic-workflow/authoring.md「Choosing a model per subagent」）：
 * `ModelRef` 与 `model()`。
 *
 * 自成一个模块只因 dts.ts 顶在 max-lines 上限（与 dts-stream.ts 同一个理由）；契约不变：这段文本
 * 由 dts.ts **插进 actor 段中间**（`Node` 之后、`AgentPersona` 之前），所以只进 `FACADE_DTS`、不进
 * snippet，tests/facade-dts.test.ts 以 sha256 钉住拼接结果。文本以声明开头、以换行结尾，前后的空行
 * 由 actor 段自己给出。
 */
// 维护不变量：本片段是纯"声明段落"（declare class + declare function），由 dts.ts 插在
// actor 段的 Node 之后、AgentPersona 之前；因此不能出现 import/export，也不能依赖其它段
// 的声明顺序。文本只进 FACADE_DTS 供 typechecker，运行时不执行——`model()` 的实现由
// facade 注入；改动任何字符都会改变 facade 哈希，需同步 facade-dts 快照测试的 sha256。
export const FACADE_MODEL_DECLARATIONS = String.raw`/** A model declared with model(). */
declare class ModelRef { private constructor(); private readonly modelRef: never }

/**
 * Declare a model subagents may run on: "modelId" or "providerId/modelId", optional "$level".
 * String literal only (checked at launch); choose among ModelRefs at run time.
 */
declare function model(id: string): ModelRef;
`;
