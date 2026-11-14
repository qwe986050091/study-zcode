import fs from 'node:fs';

const specs = [
  {
    file: 'apps/zcode-cli/packages/cli/src/plugins-command-shared.ts',
    target: 30,
    header: [
      '// INV-01 依赖按名注入、生产懒加载：守住位置 resolveDep；改错故障 轻命令把整个 bootstrap 图提前拉起。',
      '// INV-02 依赖名与 bootstrap 导出名一一对应：守住位置 BOOTSTRAP_EXPORTS 的 satisfies；改错故障 改名后静默取到 undefined。',
      '// INV-03 注入覆盖优先于真实实现：守住位置 override 判断；改错故障 测试假实现被生产实现顶掉。',
      '// INV-04 单参数命令只接受一个非空值：守住位置 requireOne 的长度与 trim 双检；改错故障 多余参数被静默忽略。',
      '// INV-05 scope 映射固定：user→user、project→workspace、local 拒绝；守住位置 resolveScope；改错故障 写到非预期作用域。',
      '// INV-06 标识按最后一个 @ 拆分：守住位置 lastIndexOf；改错故障 名字本身含 @ 时被拆坏。',
      '// INV-07 裸名必须唯一命中才放行：守住位置 resolveLoadedPluginId；改错故障 重名插件被随意选中。',
      '// INV-08 带 marketplace 的标识原样透传：守住位置 早退；改错故障 多查一次列表且可能改写用户输入。',
      '// INV-09 只看 severity=error：守住位置 hasErrors；改错故障 warning 被当成失败。',
      '// INV-10 卸载确认默认拒绝：守住位置 ^y(es)?$ 正则；改错故障 直接回车就删除插件。',
      '// INV-11 readline 必须关闭：守住位置 rl.close；改错故障 stdin 被占住，后续命令挂起。',
      '// INV-12 失败写 stderr 且退出码 1：守住位置 reportPluginsError；改错故障 脚本把失败当成功。',
      '// INV-13 堆栈只在 verbose 下输出：守住位置 条件分支；改错故障 普通用户看到内部路径。',
      '//',
      '// 模块职责：plugins 子命令共用的依赖解析、参数校验与错误输出。',
      '// 阅读顺序：先看依赖名映射与懒加载，再看 scope/标识解析，最后看确认与错误报告。',
    ],
    blocks: [
      {
        anchor: 'export const BOOTSTRAP_EXPORTS = {',
        lines: [
          '左边是 CLI 依赖名（测试注入键），右边是 bootstrap 实际导出名。',
          '两侧必须同时改：satisfies 让改名在编译期暴露，而不是运行时取到 undefined。',
          '新增子命令时在这里登记，类型派生会自动覆盖 override 与 resolveDep。',
        ],
      },
      {
        anchor: 'export async function resolveDep<K extends PluginDepName>(',
        lines: [
          '覆盖优先，测试用它注入假 bootstrap，不触碰真实文件系统。',
          '生产走动态 import，避免 plugins 这类轻命令把 bootstrap 图提前拉起。',
        ],
      },
      {
        anchor: 'export function baseOptions(deps: PluginsCommandDependencies) {',
        lines: [
          'workingDirectory 每次调用即时求值，避免长进程里 cwd 变更后仍用旧值。',
          '其余字段原样透传，undefined 表示交给 bootstrap 走默认解析。',
        ],
      },
      {
        anchor: 'export function resolveScope(value: string | undefined): PluginScope | undefined {',
        lines: [
          '未给 scope 时返回 undefined，由调用方决定默认值。',
          'project 在 CLI 语义下映射为 workspace，local 单独拒绝并给出可用值。',
        ],
      },
      {
        anchor: 'export function splitPluginIdentifier(value: string): { name: string; marketplace?: string } {',
        lines: [
          'at<=0 或 at 在末位都按裸名处理，不构造空 marketplace。',
          '只有中间位置的 @ 才拆成 name 与 marketplace 两段。',
        ],
      },
      {
        anchor: 'export async function resolveLoadedPluginId(',
        lines: [
          '带 marketplace 时无需查表，直接原样交给下游安装/卸载。',
          '裸名零命中报 not found，多命中报歧义并列出全部候选 id 供用户改写。',
          '只有唯一命中才返回真实 id，避免把用户输入的裸名直接当成 id 使用。',
        ],
      },
    ],
  },
  {
    file: 'apps/zcode-cli/packages/core/src/runtime/methods/browser-turn-screenshot.ts',
    target: 31,
    firstNth: 1,
    header: [
      '// INV-01 截图是展示增强不是失败点：守住位置 最外层 catch；改错故障 补图失败把已成功的轮次标成失败。',
      '// INV-02 合成 ToolPart 必须直接 completed：守住位置 persistPart 的 state；改错故障 投影停在 running 占住并发槽。',
      '// INV-03 图片只进 display 投影：守住位置 metadata.display；改错故障 截图回灌模型上下文撑爆 token。',
      '// INV-04 同一 turn 只补一张：守住位置 consumeBrowserTurnState；改错故障 重试后追加重复 part。',
      '// INV-05 无 candidate 或无端口即跳过：守住位置 两处早退；改错故障 非 Browser 宿主凭空造 tab。',
      '// INV-06 只截 active tab：守住位置 list 结果过滤；改错故障 截到后台页签，与用户所见不一致。',
      '// INV-07 超预算先压缩再展示：守住位置 prepareForModel 分支；改错故障 复杂页面截图被静默丢弃。',
      '// INV-08 压缩不放宽持久化预算：守住位置 复用展示常量；改错故障 存储层被大图撑爆。',
      '// INV-09 无图不落 part：守住位置 display 判定；改错故障 UI 出现空截图或伪造成功。',
      '// INV-10 事件顺序 scheduled→started→result：守住位置 三次 append；改错故障 投影认不出合成 part。',
      '// INV-11 part 与事件时间同源：守住位置 timestamp；改错故障 UI 出现负耗时或时间跳变。',
      '// INV-12 result.content 必须为空：守住位置 合成结果；改错故障 模型读到不存在的工具输出。',
      '// INV-13 事件先落库再进内存镜像：守住位置 appendScreenshotEvent 顺序；改错故障 投影与事件流错序。',
      '//',
      '// 模块职责：轮次收尾时给 active tab 补一张终态截图并合成为 completed 工具 part。',
      '// 阅读顺序：先看状态消费与端口早退，再看截图/压缩与 part 落库，最后看三条事件时序。',
    ],
    blocks: [
      {
        anchor: 'const BROWSER_TURN_SCREENSHOT_TOOL_NAME = "mcp__node_repl__js";',
        lines: [
          '复用 node_repl 工具名，展示层据此走同一套图片渲染与分组。',
          '改名会同时影响 UI 分组与历史投影的兼容性。',
        ],
      },
      {
        anchor: 'const BROWSER_TURN_SCREENSHOT_MAX_RAW_BYTES = Math.floor(',
        lines: [
          'base64 有 4/3 膨胀，先换算成原始字节上限再交给图片处理器。',
          '与展示预算严格对应，不额外放大。',
        ],
      },
      {
        anchor: 'if (display?.kind !== "node_repl_images") return undefined;',
        lines: [
          '构造器拒绝（超预算/不支持）时返回 undefined，由调用方按无图处理。',
          'source 标记让前端区分轮尾图与真实工具截图。',
        ],
      },
      {
        anchor: 'async function appendScreenshotEvent(',
        lines: [
          '事件由 runtime 统一创建，保证 trace 与时序字段完整。',
          'appendEvent 落库成功后才 push 内存镜像，镜像只服务本轮投影。',
        ],
      },
      {
        anchor: 'const turnState = consumeBrowserTurnState(runtime.sessionId, state.turnId);',
        lines: [
          'take 语义：取到即从状态表删除，重复调用返回 undefined。',
          '因此上游即使重试也不会重复补图。',
        ],
      },
      {
        anchor: 'const port = runtime.browserControlPort;',
        lines: [
          '端口缺席表示宿主没有 Browser 能力，属能力降级而非失败。',
          '显式 emitImage 不能替代轮尾图，两者语义不同。',
        ],
      },
      {
        anchor: 'const listed = await port.execute({',
        lines: [
          'list 与 screenshot 携带同一个 turnAbortSignal，用户取消时一起中断。',
          'browserGeneration 防止重连后打到旧 browser instance。',
        ],
      },
      {
        anchor: 'if (!activeTab) {',
        lines: [
          '窗口已关或用户切走都视为无 active tab，这里只记 debug 不报错误事件。',
        ],
      },
    ],
  },
  {
    file: 'apps/zcode-cli/packages/core/src/tool/handlers/bash-readonly-policy-argv-flags.ts',
    target: 31,
    header: [
      '// INV-01 白名单外一律拒绝：守住位置 末尾兜底 return false；改错故障 未登记 flag 被放行。',
      '// INV-02 allowAnyArgs 优先级最高：守住位置 首个分支；改错故障 本就无限制的命令被逐词误拒。',
      '// INV-03 commandOnly 要求零参数：守住位置 argv.length === startIndex；改错故障 pwd 带参仍判只读。',
      '// INV-04 无 safeFlags 即拒绝：守住位置 末尾 return false；改错故障 未声明策略的命令默认放行。',
      '// INV-05 xargs 目标必须在白名单：守住位置 XARGS_TARGET_COMMANDS；改错故障 等于任意命令执行。',
      '// INV-06 `--` 之后不再校验：守住位置 respectsDoubleDash；改错故障 把内容当 flag 误判。',
      '// INV-07 紧凑数字条数是特例：守住位置 isCompactNumericCountFlag；改错故障 head -10 被判成非法 flag。',
      '// INV-08 短 flag 粘连取值需二次校验：守住位置 parseShortFlagWithAttachedValue；改错故障 -Ifoo 绕过类型检查。',
      '// INV-09 短 flag 簇必须全为 none 型：守住位置 isShortFlagClusterAllowed；改错故障 取值型 flag 吞掉后续参数。',
      '// INV-10 none 型禁止内联取值：守住位置 hasInlineValue；改错故障 --verbose=x 被接受。',
      '// INV-11 取值型优先内联再消费下一个：守住位置 索引推进；改错故障 取值被当成新 flag 重复校验。',
      '// INV-12 取值本身像 option 时默认拒绝：守住位置 isOptionLikeStringValueAllowed；改错故障 仅 git --sort 的显式例外失效。',
      '// INV-13 校验是纯函数：守住位置 全文件只读入参；改错故障 判定结果受调用顺序影响。',
      '//',
      '// 模块职责：按 flag 白名单逐 token 校验 argv，供通用命令与 git 子命令共用。',
      '// 阅读顺序：先看三种策略分流，再看循环里 xargs/`--`/紧凑条数特例，最后看 flag 取值校验。',
    ],
    blocks: [
      {
        anchor: 'if (argv.length === 0) return false;',
        lines: [
          '空 argv 没有命令可校验，直接拒绝。',
          '这条先于 allowAnyArgs，避免把空数组当合法调用。',
        ],
      },
      {
        anchor: 'if (policy.commandOnly) return argv.length === startIndex;',
        lines: [
          'startIndex 之后必须一个参数都没有。',
          '用等号而不是 <=：多一个位置参数也拒绝。',
        ],
      },
      {
        anchor: 'if (commandName === "xargs" && (!word.startsWith("-") || word === "--")) {',
        lines: [
          'xargs 的执行体是首个非 flag 词，必须本身在白名单里。',
          '`--` 表示其后第一个词才是目标命令。',
          '命中后立即 break：目标命令之后的实参由目标自己决定。',
        ],
      },
      {
        anchor: 'if (policy.respectsDoubleDash === false) {',
        lines: [
          '这类命令的 `--` 是内容而非分隔符，跳过继续校验。',
          '默认把 `--` 当分隔符，其后不再检查。',
        ],
      },
      {
        anchor: 'if (isHeadTailCompactCountFlag(commandName, word)) {',
        lines: [
          '`-10` 是条数缩写，不是可登记 flag。',
          '仅 head/tail 适用，其余命令的 -10 仍走正常校验。',
        ],
      },
      {
        anchor: 'const shortAttached = parseShortFlagWithAttachedValue(word, safeFlags);',
        lines: [
          '未登记 flag 先尝试短 flag 粘连取值的形态。',
          '粘连出的值仍要过 option-like 与类型两道校验。',
          '都不成立才判失败，不做模糊放行。',
        ],
      },
      {
        anchor: 'if (flagValue === "none") {',
        lines: [
          'none 型不允许内联取值，`--flag=x` 与声明矛盾直接拒绝。',
        ],
      },
    ],
  },
  {
    file: 'apps/zcode-cli/packages/office-runtime/src/adapters/parse/xlsx.ts',
    target: 32,
    header: [
      '// INV-01 先做包级校验再解压：守住位置 openPackage；改错故障 zip 炸弹把内存打满。',
      '// INV-02 解析失败统一映射 corrupt_file：守住位置 catch；改错故障 上层拿不到稳定错误码。',
      '// INV-03 空表返回空文本而非报错：守住位置 usedBounds 返回 null；改错故障 空工作簿被当成坏文件。',
      '// INV-04 合并区非主格不重复渲染：守住位置 readCell 早退；改错故障 同值在每格重复出现。',
      '// INV-05 公式保留原文并标注未计算：守住位置 cached 判定；改错故障 用户以为读到了计算结果。',
      '// INV-06 每页固定 25 行、最多 60 列：守住位置 ROWS_PER_UNIT/MAX_COLS；改错故障 一次倾倒整表撑爆上下文。',
      '// INV-07 列被截断必须提示：守住位置 表头后缀；改错故障 用户以为拿到了全部列。',
      '// INV-08 表名精确优先、大小写回退：守住位置 findSheet；改错故障 同名不同大小写选错表。',
      '// INV-09 指定区间用已用区域裁边：守住位置 bounds 收敛；改错故障 整列区间渲染出海量空行。',
      '// INV-10 check 只规范化不改数据：守住位置 展开返回；改错故障 校验动作产生副作用。',
      '// INV-11 搜索命中定位到单格：守住位置 formatLocator 的 range；改错故障 命中无法回读原文。',
      '// INV-12 达到 limit 立即停止：守住位置 两层提前 return；改错故障 大表搜索把全部单元格扫完。',
      '// INV-13 display 兜底必须无损：守住位置 JSON.stringify；改错故障 未知类型被静默渲染成空串。',
      '//',
      '// 模块职责：用 ExcelJS 读取工作表、单元格文本与公式，产出按表/区域定位的模型文本。',
      '// 阅读顺序：先看单元格取值与边界，再看分页渲染，最后看 read/search/check 三个投影入口。',
    ],
    blocks: [
      {
        anchor: 'const ROWS_PER_UNIT = 25;',
        lines: [
          '同时作为分页粒度与默认预览行数；调大减少页数但单页更重，容易挤占上下文。',
        ],
      },
      {
        anchor: 'function display(value: ExcelJS.CellValue): string {',
        lines: [
          '判定顺序按值形状从具体到泛化，先富文本/错误/超链接，再公式对象。',
          '未知对象退化为 JSON 而不是空串，保证不丢信息。',
        ],
      },
      {
        anchor: 'function readCell(cell: ExcelJS.Cell): CellInfo {',
        lines: [
          '合并区只有主格持有内容，非主格返回空避免重复渲染。',
          '公式原文与缓存结果分开保存，缓存缺失时追加提示。',
          '不伪造数值：没有缓存就留空并标注未计算。',
        ],
      },
      {
        anchor: 'function usedBounds(sheet: ExcelJS.Worksheet): Bounds | null {',
        lines: [
          'dimensions 与 actualRowCount 任一缺失都视为空表。',
          '返回边界含首尾，供渲染与区间裁剪共用。',
        ],
      },
      {
        anchor: 'for (let start = bounds.top; start <= bounds.bottom; start += ROWS_PER_UNIT) {',
        lines: [
          '分页按行推进，末页可能不足 25 行。',
          '每页独立生成表头与公式区，便于单独读取。',
        ],
      },
      {
        anchor: 'const right = Math.min(bounds.right, bounds.left + MAX_COLS - 1);',
        lines: [
          '列截断只影响渲染，不改变定位语义。',
          '截断后用真实列字母标注省略范围，提示改用更窄区间。',
        ],
      },
      {
        anchor: 'await openPackage(bytes, label); // zip-bomb guard before ExcelJS inflates everything',
        lines: [
          '必须在 ExcelJS 解压前完成压缩比检查。',
          '这里失败直接向上抛，不降级成 corrupt_file。',
        ],
      },
      {
        anchor: 'if (!locator) {',
        lines: [
          '无定位器时每张表给一份预览并提示剩余行数。',
          '空表只输出标题占位，不构造假数据。',
        ],
      },
    ],
  },
];

let index = 0;
for (const spec of specs) {
  const srcLines = fs.readFileSync('D:/code/ZCode/' + spec.file, 'utf8').split('\n');
  const firstAnchor = srcLines[0].replace(/\r$/, '').trim();
  const firstItem = { anchor: firstAnchor, raw: spec.header };
  if (spec.firstNth) firstItem.nth = spec.firstNth;
  const items = [firstItem];
  for (const block of spec.blocks) {
    const item = { anchor: block.anchor, lines: block.lines };
    if (block.nth !== undefined) item.nth = block.nth;
    items.push(item);
  }
  const total = spec.header.length + spec.blocks.reduce((n, b) => n + b.lines.length, 0);
  if (total !== spec.target) {
    console.error(`TARGET MISMATCH ${spec.file}: ${total} != ${spec.target}`);
    process.exit(1);
  }
  fs.writeFileSync(
    `ZC-deep-b205-spec-${index}.json`,
    JSON.stringify({ files: [{ file: spec.file, items }] }, null, 2),
    'utf8',
  );
  console.log(`spec ${index}: ${spec.file} lines=${total}`);
  index += 1;
}
