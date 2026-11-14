// B08 回调密度：精确整行删除本批次自增的低信息量注释行（前缀定位 + 连续行数）。
// 只删注释行，不触碰代码行；每项要求「唯一匹配」，否则报错退出。
import fs from 'node:fs';

const target = 'D:/code/opensource/drizzle-orm/drizzle-orm/src/sqlite-core/dialect.ts';

// [唯一前缀, 从此行起的连续注释行数]
const drops = [
	['// 构造期只建 CasingCache', 2],
	['// 分隔符只在非最后一项后追加', 1],
	['// 结尾补一个空格', 1],

	['// STEP-1 with 前缀必须先于 delete 关键字', 2],
	['// STEP-3 where 缺失时整段不出现', 1],
	['// STEP-4 order by / limit 只能跟在 returning 之后', 1],
	['// 拼接顺序即语法顺序，不可调换', 1],
	['// setSize 用于', 2],
	['// flatMap 而非 map', 2],
	['// 赋值左侧必须走 identifier', 1],
	['// STEP-1 with 前缀；与 delete 相同', 1],
	['// STEP-2 set 列表由 buildUpdateSet 生成', 1],
	['// STEP-4 joins 段：from 之后可以跟 join 语法', 1],
	['// STEP-6 where / order by / limit 顺序固定', 1],
	['// 注意 fromSql 与 joinsSql 都可能是 undefined', 1],
	['// 先缓存长度：flatMap 内部', 1],
	['// 已经是选择字段的 SQL.Aliased', 2],
	['// 重写 chunk 而不是拼字符串', 1],
	['// 只有 SQL.Aliased 需要显式 as', 1],
	['// 裸列分支。', 1],
	['// 子查询分支。', 1],
	['// 只处理 entries.length === 1 的情况', 2],
	['// 直接改写子查询 SQL 对象的 decoder 字段', 1],
	['// 逗号分隔：同样只在非最后一项后追加', 1],
	['// 遍历顺序即 SQL 中出现顺序', 1],
	['// 首个 join 前补一个空格', 1],
	['// 非最后一项补空格；不补逗号', 1],
	['// 分隔符用 sql', 1],
	['// schema 前缀用 .if(...) 条件拼接', 1],
	['// 先输出原名（OriginalName）', 1],

	['// STEP-1 with 前缀，必须最先。', 1],
	['// STEP-2 distinct 是布尔开关', 1],
	['// STEP-4 from。buildFromTable', 1],
	['// STEP-5 joins。', 1],
	['// STEP-6 where / having 分离', 1],
	['// group by 与 order by 采用同一套', 1],
	['// 拼接顺序即最终语法顺序', 1],
	['// 终止条件：只剩一个操作符时直接产出', 1],
	['// 生成单个 set 操作符片段', 1],
	['// 三种形态分别处理：裸列直接取列名', 1],
	['// offset 只能出现在整条复合语句的最尾', 1],
	['// values 列表可能整体是一条 SQL', 1],
	['// 多行 values 形态。', 1],
	['// values 关键字本身用 raw', 1],
	['// 按行遍历，行内再按 colEntries 的固定顺序填值', 1],
	['// 行间逗号：最后一行不补', 1],
	['// STEP-1 with 前缀（insert 也允许 CTE', 1],
	['// STEP-2 values/select 段落整体 join', 1],
	['// STEP-3 returning 只由 config 决定（INV-MD#04）；SQLite 3.35+ 才支持', 1],
	['// 拼接顺序：insert into → 列清单 → values', 2],
	['// setOperators 非空时', 2],
	['// 把 setOperators 数组折叠成一条复合语句。', 2],

	['// limit/offset/orderBy/where 在两种模式', 2],
	['// joins 只由关系递归填充', 2],
	['// config === true 是「只取该表全部列', 1],
	['// isJson: false 表示该字段是标量列', 2],
	['// where 允许函数或直接 SQL', 1],
	['// undefined 值视为「未提及」直接跳过', 1],
	['// 模式一旦被某个 true 锁定就不再回退', 2],
	['// 未传 columns 即全选', 1],
	['// 统一转成 fieldsSelection', 1],
	['// 关系选择：selectedRelations 保留', 1],
	['// 过滤掉值为 undefined/null 的关系', 2],
	['// 关系定义来自 tableConfig.relations', 2],
	['// extras 是用户自定义的附加列', 1],
	['// fieldsSelection 到此已完成使命', 2],
	['// 裸列要再包一次别名', 1],
	['// orderBy 归一：函数形态在构建期求值', 1],
	['// 单值（非数组）也要支持', 1],
	['// 每个排序项：裸列换成别名列', 2],
	['// limit/offset 直接取自配置', 1],
	['// normalizeRelation 把关系对象归一', 2],
	['// 被引用表的 ts 名', 1],
	['// 递归编译子关系：tableAlias 传关系别名', 2],

	['// 契约：返回 Promise<void>', 1],
	['// 读取最近一条迁移记录，语义与同步版一致。', 1],
	['// 建表仍在事务外', 1],
];

const raw = fs.readFileSync(target, 'utf8');
if (!raw.includes('\r\n') || /(^|[^\r])\n/.test(raw)) throw new Error('line ending check failed');
const lines = raw.split('\r\n');
if (lines[lines.length - 1] === '') lines.pop();

let removed = 0;

// 文件头的 4 行空注释分隔符
const blanks = lines.map((l, i) => (l.trim() === '//' ? i : -1)).filter((i) => i >= 0);
if (blanks.length !== 4) throw new Error('expected 4 blank // separator lines, got ' + blanks.length);
for (const i of [...blanks].sort((a, b) => b - a)) {
	lines.splice(i, 1);
	removed++;
}

const targets = [];
for (const [prefix, count] of drops) {
	const hits = [];
	lines.forEach((l, i) => {
		if (l.trim().startsWith(prefix)) hits.push(i);
	});
	if (hits.length !== 1) throw new Error(`prefix not unique (${hits.length}): ${prefix}`);
	const start = hits[0];
	for (let k = 0; k < count; k++) {
		const t = lines[start + k].trim();
		if (!t.startsWith('//')) throw new Error(`line ${start + k + 1} is not comment: ${t}`);
	}
	targets.push([start, count, prefix]);
}

targets.sort((a, b) => b[0] - a[0]);
for (const [start, count] of targets) {
	lines.splice(start, count);
	removed += count;
}

fs.writeFileSync(target, lines.join('\r\n') + '\r\n', 'utf8');
console.log(`removed=${removed} lines=${lines.length}`);
