import fs from 'node:fs';

const file = 'crates/uv-client/src/html.rs';
const off = 0;
const items = [];
const add = (line, lines) => items.push({ line: line + off, lines });

add(477, [
  '以下测试均使用内联快照：输入是一段最小 HTML，输出是整个解析结构。',
  '快照的好处是任何字段变化都会被发现，代价是改动需要同步更新快照。',
]);

add(479, [
  '标准 PEP 503 详情页：单个 whl 链接，fragment 中带 sha256。',
]);
add(489, [
  '页面 URL 作为 base 的回退值，用于解析相对路径。',
]);
add(490, [
  '解析成功即可，字段细节由快照固定。',
]);
add(491, [
  '快照断言四件事：project_status 取默认值、base 等于页面 URL、只有一个文件、sha256 被填充。',
  '注意 url 字段只保留路径，不含 fragment，避免把 hash 拼进下载地址。',
]);

add(538, [
  'md5 fragment：验证 Hashes 的算法分派只填充对应字段。',
]);
add(550, [
  'base 与上一个用例相同，确保差异只来自 fragment。',
]);
add(551, [
  '解析结果应当同样只有一个文件。',
]);
add(552, [
  '快照中只有 md5 字段非空，其余算法保持 None。',
]);

add(599, [
  '非法摘要长度必须报错，而不是退化成「没有 hash」。',
]);
add(609, [
  'base 用 expect 是因为这里不测试 URL 解析。',
]);
add(611, [
  'expect_err 断言解析失败，并对错误内容做快照。',
]);
add(612, [
  '错误信息包含期望长度与实际长度，便于用户直接定位索引问题。',
]);

add(615, [
  '`<base>` 标签应当覆盖页面 URL，成为所有相对路径的解析基准。',
]);
add(630, [
  '页面 URL 故意与 base 不同，才能验证覆盖确实生效。',
]);
add(631, [
  '解析成功，base 字段来自 `<base href>`。',
]);
add(632, [
  '快照断言 base 的主机变成 index.python.org，路径为根。',
  '文件 url 仍是相对路径，说明 base 只在后续拼接时使用。',
]);

add(679, [
  'HTML 实体 `&#43;` 应当在解析后变成 `+`，否则文件名与 URL 不一致。',
]);
add(691, [
  '页面 base 与实体无关，保持常规值。',
]);
add(692, [
  '解析结果中的文件名应当已经解码。',
]);
add(693, [
  '快照断言 filename 含 `+`，而 url 也保留解码后的本地构建标签。',
]);

add(740, [
  'fragment 中的 `%3D` 是百分号编码的等号，需先解码才能识别为 hash。',
]);
add(752, [
  'base 常规。',
]);
add(753, [
  '解析时对 fragment 做 percent_decode，再做 hash 解析。',
]);
add(754, [
  '快照确认 sha256 被正确填充，说明解码发生在分派之前。',
]);

add(801, [
  '路径中含 `%2B`：文件名需要解码，但 url 字段保留原始编码。',
  '这是两者语义不同的关键用例：落盘用解码名，请求用编码路径。',
]);
add(813, [
  'base 常规。',
]);
add(814, [
  '解析应当成功，即使 href 没有 fragment。',
]);
add(815, [
  '快照断言 filename 是 `torchtext-0.17.0+cpu-...`，url 仍是 `%2B` 形式。',
]);

add(860, [
  '完全没有 fragment 时，hash 集合应当为空而不是报错。',
]);
add(872, [
  'base 常规。',
]);
add(873, [
  '解析成功，说明缺少 hash 属于可接受情况。',
]);
add(874, [
  '快照中所有算法字段均为 None，url 与 filename 一致。',
]);

add(919, [
  '没有 href 的 `<a>` 不是分发链接，应当被静默跳过。',
]);
add(931, [
  'base 常规。',
]);
add(932, [
  '解析结果应当没有文件，而不是报 MissingHref。',
]);
add(933, [
  '快照断言 files 为空数组，project_status 与 base 正常。',
]);

add(961, [
  'href 为空字符串与缺失 href 等价，同样跳过。',
]);
add(973, [
  'base 常规。',
]);
add(974, [
  '解析成功且不产生文件。',
]);
add(975, [
  '快照确认空链接没有被当作文件名。',
]);

add(1003, [
  'href 以 `#` 结尾（空 fragment）：hash 为空，但文件仍然有效。',
]);
add(1015, [
  'base 常规。',
]);
add(1016, [
  '解析成功，文件被保留。',
]);
add(1017, [
  '快照中 hashes 全为 None，url 不带 fragment。',
]);

add(1062, [
  '查询串属于下载参数，不应进入文件名。',
]);
add(1074, [
  'base 常规。',
]);
add(1075, [
  '解析成功。',
]);
add(1076, [
  '快照断言 filename 已去掉 `?...`，而 url 保留查询串以便正确下载。',
]);

add(1121, [
  '未知 fragment（如 `#main`）不是 hash，应当被忽略而不是报错。',
]);
add(1133, [
  'base 常规。',
]);
add(1134, [
  '注意这里保留 Result 不 unwrap，快照会展示 Ok 结构。',
]);
add(1135, [
  '快照确认解析成功且 hashes 为空。',
]);

add(1182, [
  '`#egg=name-version` 是 setuptools 历史写法，不含完整性信息，应当忽略。',
]);
add(1194, [
  'base 常规。',
]);
add(1195, [
  '同样保留 Result，便于快照展示完整结构。',
]);
add(1196, [
  '快照确认 hashes 为空且文件仍被收录。',
]);

add(1243, [
  '不支持的算法（blake2）必须报错，否则无法校验完整性。',
]);
add(1255, [
  'base 常规。',
]);
add(1256, [
  'unwrap_err 断言这是硬错误，而不是降级。',
]);
add(1257, [
  '错误信息列出支持的算法列表，用户可直接据此修正索引。',
]);

fs.writeFileSync('d:\\code\\_annot_baseline\\spec-d6f-2.json', JSON.stringify([{ file, items }], null, 2));
console.log('items', items.length, 'lines', items.reduce((n, i) => n + i.lines.length, 0));
