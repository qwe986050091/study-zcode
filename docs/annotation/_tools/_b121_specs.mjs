import fs from 'node:fs';

const specs = [
  {
    file: 'packages/shared/src/assistant-presentation.ts',
    first: 'import {',
    target: 44,
    header: [
      '// INV-01 空部件回退到三件套：守住位置 部件长度判断；改错故障 无部件消息整段空白。',
      '// INV-02 回退顺序思考在前：守住位置 数组展开顺序；改错故障 思考块排在正文之后。',
      '// INV-03 只展示根工具调用：守住位置 父标识过滤；改错故障 子代理内部调用平铺到主列表。',
      '// INV-04 父标识自引用视为根：守住位置 父等于自身判断；改错故障 自引用调用被隐藏。',
      '// INV-05 父不存在也视为根：守住位置 候选存在性检查；改错故障 孤儿调用整条消失。',
      '// INV-06 显式部件优先：守住位置 三元第一分支；改错故障 新协议被旧三件套覆盖。',
      '// INV-07 工具调用按标识索引：守住位置 映射构建；改错故障 重复扫描退化为平方复杂度。',
      '// INV-08 同一工具只渲染一次：守住位置 已渲染集合；改错故障 同一调用出现多张卡片。',
      '// INV-09 缺工具定义跳过：守住位置 空值判断；改错故障 渲染出空卡片。',
      '// INV-10 父未到时子调用跳过：守住位置 父标识存在判断；改错故障 子调用先于父出现。',
      '// INV-11 流式中不给最新块：守住位置 流式标志；改错故障 流式期间正文重复上浮。',
      '// INV-12 中断态不给最新块：守住位置 中断标志；改错故障 中断后正文被抽走。',
      '// INV-13 结算态不给最新块：守住位置 结算标志；改错故障 结算动画期间布局跳动。',
      '// INV-14 最新块取最后一个匹配：守住位置 从后查找；改错故障 相同文本取到第一块。',
      '// INV-15 历史块排除最新块：守住位置 下标不等过滤；改错故障 正文在两处重复。',
      '// INV-16 无最新块时历史保留全部：守住位置 负下标；改错故障 空索引过滤掉首块。',
      '// INV-17 返回字段固定四个：守住位置 返回结构；改错故障 调用方读到未定义字段。',
      '// INV-18 本模块不改写入参：守住位置 部件拷贝；改错故障 上层数组被排序污染。',
      '//',
      '// 模块职责：把助手消息部件投影成内容、思考与工具调用块。',
      '// 状态所有权：无状态；输入部件与工具调用由调用方提供。',
      '// 阅读顺序：先看回退构造，再读主投影循环，最后看最新块与历史块切分。',
    ],
    blocks: [
      {
        anchor: 'function buildFallbackAssistantParts({',
        lines: [
          '只取根级工具调用。',
          '父标识为空视为根。',
          '自引用也视为根。',
          '父不存在同样视为根。',
          '思考块排在最前。',
          '正文块排在最后。',
        ],
      },
      {
        anchor: 'for (const part of messageParts) {',
        lines: [
          '内容与思考直接入块。',
          '工具调用先查索引。',
          '缺失定义直接跳过。',
          '重复调用只渲染一次。',
          '父调用存在时跳过子调用。',
          '入块后登记已渲染。',
        ],
      },
      {
        anchor: 'const latestContentPart =',
        lines: [
          '三种进行态都不给最新块。',
          '仅内容块参与选择。',
          '选择逻辑委托共享函数。',
          '结果可能为空。',
          '不修改块数组。',
        ],
      },
      {
        anchor: 'return {',
        lines: [
          '原样返回消息部件。',
          '块顺序即渲染顺序。',
          '最新块可为空。',
          '历史块按同一顺序过滤。',
          '返回新数组不改入参。',
        ],
      },
    ],
  },
  {
    file: 'packages/shared/src/workspaceFileSearch.ts',
    first: 'import type { WorkspaceFileEntry } from "@zcode/shared";',
    target: 44,
    header: [
      '// INV-01 展示上限一千：守住位置 展示上限常量；改错故障 巨型仓库列表卡顿。',
      '// INV-02 归一化一次建索引：守住位置 候选构建；改错故障 热路径反复小写化。',
      '// INV-03 候选标识用相对路径：守住位置 标识赋值；改错故障 同路径跨根冲突。',
      '// INV-04 空文本不参与打分：守住位置 空文本判断；改错故障 空名候选恒排第一。',
      '// INV-05 空查询返回零分：守住位置 空查询判断；改错故障 空查询过滤掉全部候选。',
      '// INV-06 前缀命中优先：守住位置 前缀分支；改错故障 子串命中压过前缀。',
      '// INV-07 子串命中加一百：守住位置 偏移计分；改错故障 靠前命中不占优。',
      '// INV-08 子序列兜底加二百：守住位置 初始分；改错故障 模糊命中与精确命中同分。',
      '// INV-09 子序列不命中返回空：守住位置 找不到字符；改错故障 无关候选进入结果。',
      '// INV-10 热路径不重复归一化：守住位置 归一化版本函数；改错故障 每次比较重新小写。',
      '// INV-11 名称分最优：守住位置 三者取最小；改错故障 路径命中压过文件名。',
      '// INV-12 相对路径加权二十五：守住位置 加分常量；改错故障 深层路径压过浅层。',
      '// INV-13 关键词档加三百：守住位置 关键词分；改错故障 跨目录命中落到末尾。',
      '// INV-14 无穷大表示未命中：守住位置 无穷兜底；改错故障 空值参与数值比较。',
      '// INV-15 默认排序稳定：守住位置 原始下标次序；改错故障 同优先级顺序抖动。',
      '// INV-16 目录排在文件之后：守住位置 优先级函数；改错故障 目录占据列表头部。',
      '// INV-17 二分插入依赖全序：守住位置 比较器三段；改错故障 同分项插入位置错乱。',
      '// INV-18 无查询按需拒绝：守住位置 需要查询标志；改错故障 面板初开直接全量返回。',
      '//',
      '// 模块职责：工作区文件搜索的候选构建、模糊打分与 top-K 过滤。',
      '// 状态所有权：无状态；候选与查询由调用方传入。',
      '// 阅读顺序：先看候选与打分，再读热路径版本，最后看排序与二分插入。',
    ],
    blocks: [
      {
        anchor: 'export function mapWorkspaceFileEntriesToSearchCandidates(',
        lines: [
          '每项一次性归一化。',
          '标识直接用相对路径。',
          '原始名称与路径同时保留。',
          '小写字段供热路径使用。',
          '结果顺序与入参一致。',
          '该函数不改写入参。',
        ],
      },
      {
        anchor: 'export function scoreWorkspaceFileFuzzyMatch(text: string, query: string): number | null {',
        lines: [
          '两侧先归一化。',
          '空文本直接返回空。',
          '空前缀返回零分。',
          '前缀命中按长度差。',
          '子串命中按偏移加百。',
          '子序列按间隔累加。',
        ],
      },
      {
        anchor: 'export function getWorkspaceFileSearchCandidateScore(',
        lines: [
          '空查询返回零分。',
          '名称分不额外加权。',
          '相对路径加二十五。',
          '关键词档加三百。',
          '三者取最小。',
        ],
      },
      {
        anchor: 'export function filterWorkspaceFileSearchCandidates(',
        lines: [
          '无查询走默认排序。',
          '需要查询时返回空。',
          '结果按分数升序维护。',
          '末尾即当前最差。',
          '超限时弹出末项。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/lib/chatPrepareError.ts',
    first: 'import {',
    target: 43,
    header: [
      '// INV-01 缺失配置投影成稳定码：守住位置 模型缺失码；改错故障 首页提示条不显示。',
      '// INV-02 内部等待原因不外泄：守住位置 返回对象；改错故障 用户看到 Agent 故障。',
      '// INV-03 未就绪判定先归一化：守住位置 归一化调用；改错故障 字符串错误漏判。',
      '// INV-04 详情串字段顺序固定：守住位置 四段拼接；改错故障 日志检索口径漂移。',
      '// INV-05 未知值按类型字符串化：守住位置 类型分支；改错故障 对象显示成对象标签。',
      '// INV-06 循环引用不二次抛错：守住位置 序列化包裹；改错故障 原始错误被覆盖。',
      '// INV-07 序列化失败回退字符串化：守住位置 末尾回退；改错故障 错误信息丢失。',
      '// INV-08 实例优先消息：守住位置 实例分支；改错故障 空消息时显示空串。',
      '// INV-09 空消息再退名称：守住位置 或运算链；改错故障 无名错误没有提示。',
      '// INV-10 对象消息仅取有效值：守住位置 空值判断；改错故障 未定义被当成文案。',
      '// INV-11 其余值统一字符串化：守住位置 末尾调用；改错故障 数字错误无文案。',
      '// INV-12 有展示文案才包装：守住位置 空值判断；改错故障 多包一层空错误。',
      '// INV-13 包装保留原错误名：守住位置 名称复制；改错故障 错误分类丢失。',
      '// INV-14 包装保留原堆栈：守住位置 堆栈复制；改错故障 定位不到调用点。',
      '// INV-15 结构化字段白名单透传：守住位置 键数组；改错故障 敏感字段进入展示层。',
      '// INV-16 仅透传已定义字段：守住位置 未定义判断；改错故障 覆盖已有默认值。',
      '// INV-17 详情只补不覆盖：守住位置 已有详情判断；改错故障 上游详情被覆盖。',
      '// INV-18 缓存命中复用结构化错误：守住位置 消息相等判断；改错故障 缺失配置重显原文。',
      '//',
      '// 模块职责：聊天与工作区准备阶段的错误归一化与用户可见文案构造。',
      '// 状态所有权：无状态；错误对象由调用方传入。',
      '// 阅读顺序：先看缺失码与未就绪判定，再读字符串化，最后看包装与缓存复用。',
    ],
    blocks: [
      {
        anchor: 'export function buildModelConfigMissingUiError(): ModelConfigMissingUiError {',
        lines: [
          '固定稳定错误码。',
          '文案面向最终用户。',
          '不透出内部等待原因。',
          '该函数无副作用。',
          '供首页提示条识别。',
        ],
      },
      {
        anchor: 'function stringifyUnknownValue(value: unknown): string {',
        lines: [
          '字符串原样返回。',
          '空值单独成词。',
          '原始类型直接转字符串。',
          '对象尝试序列化。',
          '失败回退字符串化。',
          '不抛出二次错误。',
        ],
      },
      {
        anchor: 'export function getChatErrorMessage(err: unknown): string {',
        lines: [
          '实例优先消息。',
          '空消息退名称。',
          '对象消息仅取有效值。',
          '其余统一字符串化。',
          '结果始终为字符串。',
        ],
      },
      {
        anchor: 'function buildDisplayErrorInput(',
        lines: [
          '无展示文案直接返回。',
          '有文案时新建错误。',
          '复制名称与堆栈。',
          '白名单字段透传。',
          '未定义字段跳过。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/lib/patchDiffPreview.ts',
    first: 'import { getFiletypeFromFileName, getSingularPatch, parsePatchFiles } from "@pierre/diffs";',
    target: 45,
    header: [
      '// INV-01 安全行数一千二：守住位置 行数常量；改错故障 超大补丁同步解析卡死。',
      '// INV-02 安全字符十八万：守住位置 字符常量；改错故障 长行补丁撑爆主线程。',
      '// INV-03 深行号一千二：守住位置 行号常量；改错故障 深层 hunk 长时间卡顿。',
      '// INV-04 纯文本回退上限八百：守住位置 回退常量；改错故障 回退预览同样卡顿。',
      '// INV-05 截断标记不拼文案：守住位置 标记前缀；改错故障 英文硬编码进界面。',
      '// INV-06 截断标记可解析：守住位置 标记正则；改错故障 折叠行数无法还原。',
      '// INV-07 锁文件强制纯文本：守住位置 锁文件集合；改错故障 锁文件展开空白。',
      '// INV-08 后缀强制纯文本：守住位置 后缀数组；改错故障 脚本文件点击后整屏不可交互。',
      '// INV-09 先剥时间戳再判后缀：守住位置 制表符截断；改错故障 后缀规则被绕过。',
      '// INV-10 文件头对识别多文件：守住位置 双行前缀判断；改错故障 多文件误计为单文件。',
      '// INV-11 hunk 按声明行数消费：守住位置 剩余行数循环；改错故障 行数偏差吞掉下一文件头。',
      '// INV-12 文件头对优先结束 hunk：守住位置 提前返回；改错故障 下一文件头被并进正文。',
      '// INV-13 截断保守计一个文件：守住位置 保守计数；改错故障 多文件误判成零文件。',
      '// INV-14 无 diff 头按文件头对计数：守住位置 回退分支；改错故障 片段补丁计为零。',
      '// INV-15 元信息预览保留：守住位置 元信息收集；改错故障 重命名补丁展开空白。',
      '// INV-16 hunk 内只跳过头行：守住位置 进入标记；改错故障 正文加减行被误删。',
      '// INV-17 尾部空行裁掉：守住位置 末尾循环；改错故障 预览底部出现空白。',
      '// INV-18 空结果留一个空行：守住位置 兜底数组；改错故障 空预览高度塌陷。',
      '//',
      '// 模块职责：补丁差异的降级判定与纯文本预览行生成。',
      '// 状态所有权：无状态；补丁文本由调用方传入。',
      '// 阅读顺序：先看常量与文件数统计，再读行裁剪，最后看降级决策顺序。',
    ],
    blocks: [
      {
        anchor: 'export function countPatchFileDiffs(patch: string): number {',
        lines: [
          '优先按差异头计数。',
          '无头时逐对识别文件头。',
          'hunk 按声明行数消费。',
          '文件头对提前结束。',
          '截断也计一个文件。',
          '返回非负整数。',
        ],
      },
      {
        anchor: 'export function getPatchPreviewLineContent(line: string): string {',
        lines: [
          '三种前缀剥一层。',
          '其它行原样返回。',
          '不裁剪空白。',
          '不解析 hunk 头。',
          '该函数为纯函数。',
        ],
      },
      {
        anchor: 'function limitPlainTextPreviewLines(lines: readonly string[]): string[] {',
        lines: [
          '未超限直接复制。',
          '保留行数留一行给标记。',
          '头尾大致对半。',
          '中间折叠成标记行。',
          '折叠数可被解析。',
          '不修改入参数组。',
        ],
      },
      {
        anchor: 'function collectPlainTextPreviewLines(lines: readonly string[]): string[] {',
        lines: [
          '遇到 hunk 头才进入。',
          '进入后只跳过头行。',
          '正文加减行全部保留。',
          '有无 hunk 决定回退。',
          '无 hunk 时取元信息。',
          '原顺序保持不变。',
        ],
      },
    ],
  },
];

let index = 0;
for (const spec of specs) {
  const srcLines = fs.readFileSync('D:/code/ZCode/' + spec.file, 'utf8').split('\n');
  const firstAuto = srcLines[0].replace(/\r$/, '').trim();
  const firstAnchor = spec.first ?? firstAuto;
  if (spec.first && firstAnchor !== firstAuto) {
    console.error(`FIRST MISMATCH ${spec.file}\n  spec: ${spec.first}\n  file: ${firstAuto}`);
    process.exit(1);
  }
  const firstItem = { anchor: firstAnchor, raw: spec.header };
  if (spec.firstNth) firstItem.nth = spec.firstNth;
  const items = [firstItem];
  for (const block of spec.blocks) {
    const item = { anchor: block.anchor, lines: block.lines };
    if (block.nth) item.nth = block.nth;
    items.push(item);
  }
  const total = spec.header.length + spec.blocks.reduce((sum, b) => sum + b.lines.length, 0);
  const bodyTotal = spec.blocks.reduce((sum, b) => sum + b.lines.length, 0);
  console.log(`${spec.file} header=${spec.header.length} body=${bodyTotal} total=${total} expect=${spec.target} ${total === spec.target ? 'OK' : 'MISMATCH'}`);
  fs.writeFileSync(
    `ZC-deep-b121-spec-${index}.json`,
    JSON.stringify({ files: [{ file: spec.file, items }] }, null, 2),
    'utf8',
  );
  index += 1;
}
