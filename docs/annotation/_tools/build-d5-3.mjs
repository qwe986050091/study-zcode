import fs from 'node:fs';

const file = 'd:\\code\\opensource\\uv\\crates\\uv-python-discovery\\src\\lib.rs';
const src = fs.readFileSync(file, 'utf8').split(/\r?\n/);

function anchorFor(name) {
  const hits = [];
  src.forEach((l, i) => {
    if (l.trim().startsWith(`fn ${name}(`) && /^\s+fn /.test(l)) hits.push({ line: i + 1, text: l });
  });
  if (hits.length !== 1) throw new Error(`${name}: hits=${hits.length}`);
  return hits[0].text;
}

const blocks = [
  ['find_python_default_arch', [
    '默认架构发现：不指定版本，只看本机第一个可用解释器。',
    '[不变量] 结果必须带出平台架构字段，供后续标签匹配使用。',
    '[边界] 无任何解释器时由调用方转成 PythonNotFound，不在本函数内兜底。',
    '[维护] 该断言依赖夹具构造的 mock 解释器头，改动夹具需同步更新期望值。',
  ]],
  ['find_python_empty_path', [
    '空 PATH：搜索路径为空时不应找到任何解释器。',
    '[不变量] 错误类型为 PythonNotFound，而不是 IO 错误。',
    '[边界] 空目录与不存在的目录要表现一致，避免上游分支分化。',
    '[权衡] 本用例只验证「找不到」，具体提示文案由 Hinted 层负责。',
  ]],
  ['find_python_unexecutable_file', [
    '不可执行文件：存在同名文件但缺少执行位，应被跳过。',
    '[不变量] 不以文件是否存在作为判定依据，而看能否实际执行。',
    '[边界] Unix 下通过权限位模拟，Windows 下该分支不参与编译。',
    '[维护] 若未来引入「仅校验元数据」的快速路径，需要保留本用例防回归。',
  ]],
  ['find_python_valid_executable', [
    '正常命中：合法解释器应被完整解析出版本与实现。',
    '[不变量] 返回的是虚拟环境外的系统解释器。',
    '[边界] 校验状态为 Valid 时才允许返回，避免半解析结果外泄。',
    '[权衡] 这里只断言关键字段，减少对具体版本字符串的耦合。',
  ]],
  ['find_or_download_skips_download_metadata_when_python_is_found', [
    '「先找后下」策略：本地已命中时不得触发下载元数据查询。',
    '[不变量] 通过 mock 客户端计数确认零次网络访问。',
    '[边界] 这是离线可用性的核心保证，任何下载前置都会破坏它。',
    '[维护] 新增下载相关字段时，需确认仍在命中分支之后才求值。',
  ]],
  ['find_python_valid_executable_after_invalid', [
    '混合目录：无效候选在前、有效候选在后，仍应命中后者。',
    '[不变量] 单个候选失败不得中断整个搜索路径的遍历。',
    '[边界] 错误要逐个吞掉，只有全部失败才汇总报错。',
    '[权衡] 顺序语义使 PATH 优先级天然成立，无需显式排序。',
  ]],
  ['find_python_installations_discovers_search_path_lazily', [
    '惰性发现：迭代器未消费前不得预先展开搜索路径。',
    '[不变量] 首次 next() 调用时才真正读取目录。',
    '[边界] 提前 drop 迭代器应释放已打开句柄。',
    '[维护] 该性质保护大 PATH 场景下的启动开销，改动迭代结构需回归。',
  ]],
  ['find_python_installation_queries_lazily', [
    '查询惰性：只向迭代器索取足够判断的候选数量。',
    '[不变量] 命中后不再继续枚举剩余目录。',
    '[边界] 提前返回时迭代器应处于可安全释放状态。',
    '[权衡] 惰性与正确性在此处一致，因为搜索顺序即优先级。',
  ]],
];

const items = blocks.map(([name, lines]) => ({ anchor: anchorFor(name), lines }));
const spec = [{ file, items }];
const out = 'd:\\code\\_annot_baseline\\spec-uvr-d5-3.json';
fs.writeFileSync(out, JSON.stringify(spec, null, 2));
console.log('items', items.length, 'lines', items.reduce((a, b) => a + b.lines.length, 0));
