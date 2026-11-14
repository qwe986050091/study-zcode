// B27 insert: tool search + model middleware wrappers
import fs from 'node:fs';

const ROOT = 'D:/code/opensource/ai/packages/ai/src/';
const files = [
  {
    name: 'tool-search/prepare-tool-search.ts',
    want: [44, 44],
    blocks: [
      {
        at: 1,
        expect: 'import {',
        lines: [
          '// ============================================================================',
          '// prepare-tool-search：为一次生成绑定延迟加载工具的发现状态',
          '// 搜索工具执行后把命中的名称写入 discovered，下一步才真正暴露这些工具。',
          '// 状态按生成创建，绝不挂到共享 tool 实例上。',
          '// 该文件只做绑定，不执行实际检索逻辑之外的 IO。',
        ],
      },
      {
        at: 21,
        expect: 'export function createToolSearchState({',
        lines: [
          '// 不变量（守住它的位置）：',
          '// INV-01 只有 deferLoading 或搜索工具参与发现，普通工具始终直接可见。',
          '// INV-02 搜索工具自身不得 deferLoading，否则永远无法被调用。',
          '// INV-03 发现集合跨 step 累积，但当前 step 的绑定是快照。',
          '// INV-04 未发现工具不得出现在本 step 的工具表与执行绑定中。',
          '// 守住位置：INV-01 在收集，INV-02 在入口校验，INV-03/04 在返回的绑定函数。',
        ],
      },
      {
        at: 34,
        expect: 'const searchTools = Object.entries(tools ?? {}).filter(',
        lines: [
          '// 只需检查延迟工具与搜索工具；没有这类工具时返回恒等函数。',
        ],
      },
      {
        at: 41,
        expect: 'const discovered = new Set<string>();',
        lines: [
          '// [事务] 发现集合只增不减，作用域是本次生成；',
          '// 新命中的工具从下一步开始可见，避免同一步内自举。',
          '// 该集合不写入 tool 实例，多个请求互不影响。',
        ],
      },
      {
        at: 43,
        expect: 'const getCallers = (name: string) =>',
        lines: [
          '// 缺省允许直接调用；显式空数组表示禁用所有调用方。',
        ],
      },
      {
        at: 46,
        expect: 'for (const [name, tool] of searchTools) {',
        lines: [
          '// 校验调用方配置是否自洽：搜索工具必须能直接调用，',
          '// code mode 调用方必须能准备模型消息，否则配置无效。',
          '// 搜索工具自身 deferLoading 会形成无法触发的死锁，直接拒绝。',
          '// 错误信息同时说明两种合法配置，便于用户修正。',
        ],
      },
      {
        at: 66,
        expect: 'return (activeTools, { toolsContext = {}, experimental_sandbox } = {}) => {',
        lines: [
          '// 每一步调用一次：activeTools 为空时保持 undefined 语义；',
          '// 过滤掉尚未发现的工具，并把搜索工具的 execute 替换成真实检索。',
          '// 返回新对象，不修改调用方传入的 ToolSet。',
          '// 多层搜索工具时每一层独立解析自己的候选集。',
        ],
      },
      {
        at: 71,
        expect: '// Snapshot eligibility before binding callers. Newly discovered tools are',
        lines: [
          '// 先快照再绑定：本步新发现的工具不会反向出现在本次执行中。',
        ],
      },
      {
        at: 77,
        expect: '.map(([searchName, tool]) => {',
        lines: [
          '// 非搜索工具原样保留，只有搜索工具需要注入 execute。',
        ],
      },
      {
        at: 82,
        expect: 'const callers = getCallers(searchName).filter(',
        lines: [
          '// 只保留当前 activeTools 中真实存在的调用方，避免指向已移除工具。',
        ],
      },
      {
        at: 86,
        expect: 'const candidates = entries.filter(',
        lines: [
          '// 候选集：延迟加载、非搜索工具，且与搜索工具共享至少一个调用方。',
          '// 该交集保证 code mode 与直接调用各自只看到自己的工具。',
          '// 候选顺序沿用 entries，后续打分排序不会修改原顺序。',
        ],
      },
      {
        at: 97,
        expect: 'execute: async ({ query }: { query: string }) => {',
        lines: [
          '// 每次检索都重新求值描述，因为描述函数可能依赖 toolsContext；',
          '// 自定义 search 优先，未提供时使用内置关键词打分。',
          '// 只有命中结果会写入 discovered，未命中不改变可见性。',
        ],
      },
      {
        at: 110,
        expect: 'const toolsByName = new Map(',
        lines: [
          '// 名称索引用于把排序结果映射回完整工具信息。',
        ],
      },
      {
        at: 113,
        expect: 'const customSearch = getToolSearchFunction(tool);',
        lines: [
          '// 查询词去重后再参与打分，避免重复词放大权重。',
        ],
      },
      {
        at: 120,
        expect: ': availableTools',
        lines: [
          '// 默认打分：名称命中 2 分、描述命中 1 分；',
          '// 零分候选直接丢弃，不做模糊兜底；',
          '// 按分数降序，稳定排序保持同分时的原顺序。',
          '// 打分只看名称与描述，不读取 schema。',
        ],
      },
      {
        at: 136,
        expect: 'const matches = [...new Set(rankedNames)]',
        lines: [
          '// 自定义 search 可能返回重复或未知名称：先去重、再过滤、最后截断。',
          '// 截断上限来自工具自身元数据，默认 5。',
        ],
      },
      {
        at: 143,
        expect: 'for (const { name } of matches) {',
        lines: [
          '// 命中后写入发现集合，下一步的绑定会包含这些工具。',
        ],
      },
      {
        at: 156,
        expect: 'function tokenize(text: string): string[] {',
        lines: [
          '// 驼峰拆分后转小写，按 Unicode 字母数字切词，兼容中文；',
          '// 不使用 locale 相关规则，保证跨环境结果一致。',
        ],
      },
    ],
  },
  {
    name: 'tool-search/tool-search.ts',
    want: [14, 14],
    blocks: [
      {
        at: 1,
        expect: "import { jsonSchema, tool, type Tool } from '@ai-sdk/provider-utils';",
        lines: [
          '// ============================================================================',
          '// tool-search：声明一个由生成器绑定的工具搜索工具',
          '// 本文件只定义工具形状与元数据，真正的检索在 prepare-tool-search 中注入。',
          '// 三个 Symbol 让跨包代码无需 instanceof 即可识别搜索工具。',
          '// 工具本身可被序列化到模型，但元数据不会进入 JSON Schema。',
        ],
      },
      {
        at: 4,
        expect: "const toolSearchSymbol = Symbol.for('vercel.ai.toolSearch');",
        lines: [
          '// Symbol.for 使用全局注册表，跨模块副本也能拿到同一标记。',
          '// 三个符号分别表示「是搜索工具」「自定义搜索函数」「结果上限」。',
        ],
      },
      {
        at: 25,
        expect: 'export function toolSearch({',
        lines: [
          '// 默认最多返回 5 个匹配工具；search 省略时使用内置关键词检索。',
          '// 返回的工具在未绑定生成器前调用 execute 会直接抛错。',
        ],
      },
      {
        at: 44,
        expect: 'if (!Number.isSafeInteger(maxResults) || maxResults < 1) {',
        lines: [
          '// 上限必须是正安全整数，0 与小数都会让截断行为不可预测。',
        ],
      },
      {
        at: 52,
        expect: 'return Object.assign(',
        lines: [
          '// 先用 tool 创建标准函数工具，再附加搜索元数据；',
          '// 描述里明确「匹配结果下一步才可用」，降低模型连续调用的概率。',
          '// 元数据挂在工具对象上，随工具一起传递，无需额外注册表。',
          '// 未绑定生成器时调用 execute 会抛出清晰的配置错误。',
        ],
      },
    ],
  },
  {
    name: 'middleware/wrap-language-model.ts',
    want: [19, 19],
    blocks: [
      {
        at: 1,
        expect: 'import type {',
        lines: [
          '// ============================================================================',
          '// wrap-language-model：给语言模型套上中间件链',
          '// 数组第一个中间件最先看到参数，最后一个最贴近模型。',
          '// 每层都产生新的 V4 视图，原始模型对象不被修改。',
          '// 该函数是纯组合器，不缓存、不持有请求状态。',
        ],
      },
      {
        at: 25,
        expect: 'export const wrapLanguageModel = ({',
        lines: [
          '// 入口先把 V2/V3 统一升到 V4，后续只处理一种版本；',
          '// reverse 后从最内层开始包装，保证执行顺序与数组顺序一致；',
          '// reduce 的初始值就是模型本身，没有中间件时等价于直接返回。',
        ],
      },
      {
        at: 37,
        expect: 'return [...asArray(middlewareArg)]',
        lines: [
          '// 复制数组后再 reverse，避免修改调用方传入的 middleware。',
          '// asArray 兼容单个中间件与数组两种写法。',
          '// 每个中间件只包装一次，不做去重或合并。',
        ],
      },
      {
        at: 44,
        expect: 'const doWrap = ({',
        lines: [
          '// 每层解析自己的覆盖项：provider/modelId/supportedUrls 都可被替换；',
          '// 覆盖函数拿到的是当前已包装的 model，可基于内层信息决策。',
          '// 解构出的五个钩子都是可选的。',
        ],
      },
      {
        at: 62,
        expect: 'async function doTransform({',
        lines: [
          '// type 告诉中间件本次是 generate 还是 stream，参数转换可据此分化。',
        ],
      },
      {
        at: 74,
        expect: 'return {',
        lines: [
          '// doGenerate 与 doStream 都先把参数转换，再把两种调用能力交给钩子；',
          '// 钩子可以只替换其中一种，另一种仍走原模型；',
          '// 返回对象是纯 V4 形状，不携带中间件状态。',
          '// 中间件异常会沿调用栈向上抛，不做统一包装。',
        ],
      },
    ],
  },
  {
    name: 'middleware/wrap-embedding-model.ts',
    want: [18, 18],
    blocks: [
      {
        at: 1,
        expect: 'import type {',
        lines: [
          '// ============================================================================',
          '// wrap-embedding-model：给向量模型套上中间件链',
          '// 组合顺序与语言模型一致：第一个 transform 最先执行。',
          '// 额外透传两个实验能力，避免包装后丢失。',
          '// 该组合器不读取 embedding 内容，只转交参数。',
        ],
      },
      {
        at: 35,
        expect: 'export const wrapEmbeddingModel = ({',
        lines: [
          '// 先升到 V4，再按 reverse 顺序逐层包装。',
          '// 没有中间件时返回升级后的模型本身。',
        ],
      },
      {
        at: 47,
        expect: 'return [...asArray(middlewareArg)]',
        lines: [
          '// 复制后 reverse，保护调用方的数组不被修改。',
        ],
      },
      {
        at: 54,
        expect: 'const doWrap = ({',
        lines: [
          '// maxEmbeddingsPerCall 与 supportsParallelCalls 可被覆盖；',
          '// 实验字段从内层模型读取并继续向外透传。',
          '// 每层只处理一次 doEmbed 调用。',
          '// 覆盖值与内层值都可能是函数，读取时保持原样。',
        ],
      },
      {
        at: 73,
        expect: 'async function doTransform({',
        lines: [
          '// 向量模型只有 embed 一种操作，不需要 type 参数。',
        ],
      },
      {
        at: 81,
        expect: 'return {',
        lines: [
          '// 实验符号属性必须在包装对象上重建，否则下游读不到；',
          '// 取值函数返回内层能力，不做缓存，保证动态模型也能正确；',
          '// doEmbed 先转换参数，再交给 wrapEmbed 或直接调用。',
          '// 返回对象不修改原模型。',
          '// 每层包装都创建独立对象，链式调用不会互相污染。',
        ],
      },
    ],
  },
  {
    name: 'middleware/wrap-image-model.ts',
    want: [14, 14],
    blocks: [
      {
        at: 1,
        expect: 'import type {',
        lines: [
          '// ============================================================================',
          '// wrap-image-model：给图像模型套上中间件链',
          '// 组合顺序与语言/向量模型一致。',
          '// 图像模型没有流式接口，只有一次 doGenerate。',
        ],
      },
      {
        at: 24,
        expect: 'export const wrapImageModel = ({',
        lines: [
          '// V2/V3/V4 先统一为 V4，再逐层包装。',
          '// 没有中间件时直接返回升级后的模型。',
        ],
      },
      {
        at: 43,
        expect: 'const doWrap = ({',
        lines: [
          '// 图像模型的覆盖项包含数量上限与两种输入能力。',
          '// 其余字段直接沿用内层模型。',
        ],
      },
      {
        at: 66,
        expect: 'const maxImagesPerCallRaw =',
        lines: [
          '// maxImagesPerCall 可能是函数，复制到包装对象后 this 会丢失；',
          '// 因此函数值必须 bind 回原模型。',
          '// 非函数值直接复制。',
        ],
      },
      {
        at: 76,
        expect: 'const supportsFileInputs =',
        lines: [
          '// 用 !== undefined 判断覆盖，允许显式覆盖成 false。',
        ],
      },
      {
        at: 85,
        expect: 'return {',
        lines: [
          '// doGenerate 是唯一操作：先转换参数，再交给 wrapGenerate 或直接调用。',
          '// 每层包装创建独立对象，链式组合不会互相污染。',
        ],
      },
    ],
  },
];

let grand = 0;
for (const f of files) {
  if (f.name === 'tool-search/prepare-tool-search.ts' || f.name === 'tool-search/tool-search.ts' || f.name === 'middleware/wrap-language-model.ts' || f.name === 'middleware/wrap-embedding-model.ts') {
    console.log('SKIP already inserted', f.name);
    continue;
  }
  const path = ROOT + f.name;
  const raw = fs.readFileSync(path, 'utf8');
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const lines = raw.split(eol);
  let total = 0;
  for (const b of f.blocks) {
    const actual = (lines[b.at - 1] ?? '').trim();
    if (actual !== b.expect) {
      console.error(`MISMATCH ${f.name}:${b.at} expected [${b.expect}] actual [${actual}]`);
      process.exit(1);
    }
    total += b.lines.length;
  }
  if (total < f.want[0] || total > f.want[1]) {
    console.error(`COUNT ${f.name}=${total} want ${f.want[0]}..${f.want[1]}`);
    process.exit(1);
  }
  const sorted = [...f.blocks].sort((a, b) => b.at - a.at);
  for (const b of sorted) lines.splice(b.at - 1, 0, ...b.lines);
  fs.writeFileSync(path, lines.join(eol), 'utf8');
  console.log('ADDED', f.name, total);
  grand += total;
}
console.log('TOTAL', grand);
