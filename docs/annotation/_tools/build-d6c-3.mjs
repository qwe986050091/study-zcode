import fs from 'node:fs';

const file = 'crates/uv-requirements-txt/src/lib.rs';
const S = 283;
const items = [];
const add = (old, lines) => items.push({ line: old + S, lines });

add(1585, [
  '用例分组：一组合法文件必须解析成功，结果与 insta 快照逐字段比对。',
  'test_case 提供文件路径，覆盖基础语法、约束、include 与哈希。',
  '快照里的路径会被替换成占位符，因此仓库可以在任意机器上复现。',
  '如果这里失败，优先检查解析结果而不是快照本身。',
]);
add(1613, [
  '用例分组：同一批文件在 LF 与 CRLF 下必须解析出相同结果。',
  '实现方式是把文件复制到临时目录再整体替换行尾。',
  '这能覆盖 unscanny 游标对 \\r\\n 的处理，以及行列换算。',
]);
add(1654, [
  'Unix 平台专属：裸 URL 与 editable 路径的解析结果。',
  '这些输入依赖 POSIX 路径语义，Windows 上由 parse_windows 覆盖。',
]);
add(1675, [
  'Unix 平台专属的错误用例：semicolon 与 hash 文件必须报错。',
  '快照固化错误链，确保提示信息不会在重构中退化。',
]);
add(1696, [
  'Windows 平台专属：与 parse_unix 相同的输入，期望等价结果。',
  '盘符与反斜杠会进入快照，因此单独成组。',
]);
add(1714, [
  '错误用例：include 的文件不存在。',
  '覆盖 RequirementsInput::resolve 的失败分支与错误包装。',
  '断言里会检查缺失路径与引用位置是否都出现在错误链中。',
]);
add(1756, [
  '错误用例：版本说明符不合法。',
  '验证 PEP 508 解析错误被正确包装，并保留位置与原文。',
]);
add(1785, [
  '错误用例：需求中的 URL 不合法。',
  '验证 URL 解析失败时错误类型是 Url，而不是泛化的 Parser。',
]);
add(1814, [
  '错误用例：editable 指向无法编辑的目标。',
  'make_editable 返回错误后，解析器要给出 NonEditable 而不是继续。',
]);
add(1843, [
  '错误用例：editable 的扩展名不受支持。',
  '这里覆盖 .zip 之外的普通文件，确认错误分类稳定。',
]);
add(1870, [
  '错误用例：editable 需求带 extras。',
  'extras 对本地项目没有意义，必须在解析阶段拒绝。',
]);
add(1899, [
  '相对路径的 --index-url：必须相对于 requirements 文件目录解析。',
  '这是与命令行参数不同的规则，容易出错，因此单独用例覆盖。',
]);
add(1926, [
  '错误用例：--index-url 既不是可解析的 URL，也不是存在的路径。',
  '确认错误提示包含原始值，方便用户定位。',
]);
add(1953, [
  '错误用例：选项缺少必需参数。',
  '覆盖 parse_value 的空值分支。',
]);
add(1978, [
  '错误用例：把 requirements 文件当作包名传入。',
  '解析器要识别 .txt 或 .in 且文件存在的情况，并提示补 -r。',
  '这是用户最常见的误用之一。',
]);
add(2007, [
  '相对需求路径：-e 相对于工作目录，-r 相对于文件目录。',
  '用例里父文件位于子目录，能同时验证两条规则。',
]);
add(2075, [
  '嵌套文件设置合并：--no-binary 必须取并集。',
  '验证 update_from 对集合类字段的处理。',
]);
add(2143, [
  '嵌套 editable：子文件中的可编辑需求要保留并参与最终结果。',
  '确认 editable 不会被当成普通需求降级。',
]);
add(2244, [
  '嵌套索引冲突：不同文件声明不同 --index-url 时必须报错。',
  '这是有意比 pip 更严格的行为，防止静默改变解析来源。',
]);
add(2280, [
  '注释与续行：行尾注释、反斜杠续行与空行混合。',
  '内联快照覆盖需求、哈希与注释的位置关系。',
  '这个用例是解析器最贴近真实文件的回归测试。',
]);
add(2497, [
  '归档需求：直接 URL 指向 wheel 或 sdist。',
  '验证 URL 与哈希同时被保留，且不会做网络访问。',
]);
add(2863, [
  '错误行列：确认报错位置与编辑器显示一致。',
  '覆盖多字节字符、CRLF 与注释行之后的位置计算。',
]);
add(2889, [
  '错误用例：--hash 的值格式不完整。',
  '确认错误指向哈希本身，而不是需求开头。',
]);
add(2914, [
  '错误用例：未知选项前缀。',
  '确认错误信息包含实际读到的字符。',
]);
add(2939, [
  '选项边界：验证 eat_option 只在 token 边界返回 true。',
  '典型反例是 --no-index 与 --no-index-url 共享前缀。',
]);
add(2954, [
  '行列换算的纯函数测试：直接喂入字符串与游标位置。',
  '覆盖 CRLF、单独 CR 与普通换行三种情况。',
]);
add(2969, [
  '循环 include：互相引用的文件必须终止。',
  '验证 visited 集合在 requirements 与 constraints 两种模式下都生效。',
  '最终结果里的需求与约束都必须去重。',
]);

// 错误枚举各变体的含义
add(1143, ['IO 错误：读文件、读取 stdin 或写缓存失败。']);
add(1144, ['URL 解析失败：--index-url、--extra-index-url 或 find-links 的值不合法。']);
add(1150, ['file URL 无法转换成路径：通常出现在 Windows 与相对路径混用时。']);
add(1155, ['RequirementsInput 解析失败：远程 URL 或本地路径无法归一化。']);
add(1160, ['VerbatimUrl 构造失败：保留了用户原始写法，无法生成规范 URL。']);
add(1166, ['URL 转路径失败：file URL 的 host 或转义不合法。']);
add(1167, ['不支持的 URL：期望 file scheme，但拿到了 http 或其它。']);
add(1168, ['疑似把 requirements 文件当作包名，提示用户补 -r。']);
add(1169, ['editable 需求无法转换为可编辑项目，附行号与原始文本。']);
add(1176, ['--no-binary 的说明符不合法。']);
add(1182, ['--only-binary 的说明符不合法；与 NoBinary 分开是为了错误措辞。']);
add(1188, ['约束中出现未命名需求：路径或 URL 无法表达版本约束。']);
add(1192, ['约束文件中出现 editable 需求。']);
add(1195, ['通用语法错误：带消息、行与列。']);
add(1200, ['需求使用了 uv 不支持的 PEP 508 特性。']);
add(1205, ['PEP 508 解析失败，保留原始错误与位置。']);
add(1210, ['URL 解析成功但 VerbatimParsedUrl 构造失败。']);
add(1215, ['子文件解析失败：递归包装，错误链可一直展开。']);
add(1221, ['远程读取失败：请求、状态码或解码错误。']);
add(1223, ['客户端构造失败：TLS、代理或连接池配置问题。']);

fs.writeFileSync('d:\\code\\_annot_baseline\\spec-d6c-3.json', JSON.stringify([{ file, items }], null, 2));
console.log('items', items.length, 'lines', items.reduce((n, i) => n + i.lines.length, 0));
