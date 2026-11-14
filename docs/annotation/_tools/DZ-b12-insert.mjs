// B12：五方言 alias / view-common / view-base / subquery 共 20 个样板文件。
// 规则：按 1-based 原始行号在该行前插入整行 // 注释；倒序 splice；CRLF 写回；不动任何代码行。
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'D:/code/opensource/drizzle-orm';

// key = 相对仓库根路径；value = [锚点行号(1-based), [注释行...]]
const PLAN = {
	'drizzle-orm/src/pg-core/alias.ts': [
		[1, [
			'// 本文件与 src/alias.ts 同构，通用不变量见 INV-alias#01~04；这里只是按方言收窄类型的入口。',
			'// 方言差异：入参并集是 PgTable | PgViewBase，物化视图也走同一入口；',
			'// [权衡] BuildAliasTable 把它收窄成 PgViewWithSelection：别名只用于 FROM 引用，无需保留刷新语法。',
		]],
		[11, [
			'\t// replaceOriginalName=false：保留原表/视图名供错误信息定位，限定符改由 Name 承担。',
		]],
	],
	'drizzle-orm/src/mysql-core/alias.ts': [
		[1, [
			'// 本文件与 src/alias.ts 同构，通用不变量见 INV-alias#01~04；此处只补 MySQL 的类型面。',
			'// 方言差异：入参为 MySqlTable | MySqlViewBase，视图别名与表别名共用同一 handler。',
			'// [权衡] 别名不改写 [MySqlViewConfig]，故别名视图与原视图共享 algorithm/sqlSecurity 配置（只读用途，无需复制）。',
		]],
		[10, [
			'\t// replaceOriginalName=false：只替换 Name，原视图名仍能在诊断与迁移核对中取回。',
		]],
	],
	'drizzle-orm/src/sqlite-core/alias.ts': [
		[1, [
			'// 本文件与 src/alias.ts 同构，通用不变量见 INV-alias#01~04；这里只做 SQLite 的类型收窄。',
			'// 方言差异：SQLite 无物化视图，SQLiteViewBase 的唯一子类是 SQLiteView，别名后收窄为 SQLiteViewWithSelection。',
			'// 为何单独存在：BuildAliasTable 在 sqlite 的 select.types.ts 里按 \'sqlite\' 标签重写列名，通用入口推导不出。',
		]],
		[11, [
			'\t// replaceOriginalName=false：OriginalName 保持真实视图名，别名只改变 FROM 里的限定符。',
		]],
	],
	'drizzle-orm/src/singlestore-core/alias.ts': [
		[1, [
			'// 本文件与 src/alias.ts 同构，通用不变量见 INV-alias#01~04；此处是五方言中唯一不收视图的入口。',
			'// [权衡] 只收表：BuildAliasTable 的 View 分支在 select.types.ts 中被注释，放开会推导出 never，故签名末尾的 // | SingleStoreViewBase 只是占位。',
		]],
		[9, [
			'\t// replaceOriginalName=false：与其它方言一致，别名只覆盖 Name，原表名留给日志。',
		]],
	],
	'drizzle-orm/src/gel-core/alias.ts': [
		[1, [
			'// 本文件与 src/alias.ts 同构，通用不变量见 INV-alias#01~04；此处只补 Gel 的类型面。',
			'// 方言差异：入参为 GelTable | GelViewBase，GelView 与 GelMaterializedView 都经此入口别名化；',
			'// [权衡] 别名后类型统一为 ViewWithSelection，物化视图身份不保留（FROM 引用用不到）。',
		]],
		[11, [
			'\t// replaceOriginalName=false：别名只改 Name；OriginalName 保留真实对象名，供错误信息与迁移核对。',
		]],
	],

	'drizzle-orm/src/pg-core/view-common.ts': [
		[1, [
			'// 本文件与 src/view-common.ts 同构：Symbol.for 键必须只在此定义，view.ts 负责写入、utils.ts 负责读取。',
			'// 方言差异：键名带 Pg 前缀；只承载 PgView 的 with 选项，物化视图另用 view.ts 里的 PgMaterializedViewConfig。',
		]],
	],
	'drizzle-orm/src/mysql-core/view-common.ts': [
		[1, [
			'// 本文件与 src/view-common.ts 同构：键的唯一事实源，避免各处手写 Symbol.for 字符串拼错后读不到配置。',
			'// 方言差异：本键存 algorithm/sqlSecurity/withCheckOption；未传 mysqlConfig 时值为 undefined，展开读取无需判空。',
		]],
	],
	'drizzle-orm/src/sqlite-core/view-common.ts': [
		[1, [
			'// 本文件与 src/view-common.ts 同构：拆成独立文件使键与类实现解耦，view.ts 与 utils.ts 引用同一常量。',
			'// 方言差异：SQLite 的 config 通路（view.ts 的 sqliteConfig 与 utils.ts 的展开）目前被注释，本键按方言对齐预留。',
		]],
	],
	'drizzle-orm/src/singlestore-core/view-common.ts': [
		[1, [
			'// 本文件与 src/view-common.ts 同构：Symbol.for 保证跨包实例读到同一键，独立文件避免键被类模块私藏。',
			'// 方言差异：utils.ts 的 getViewConfig 与 import 整体被注释，本键当前只在 view.ts 赋值，属方言对齐占位。',
		]],
	],
	'drizzle-orm/src/gel-core/view-common.ts': [
		[1, [
			'// 本文件与 src/view-common.ts 同构：键在此唯一声明，view.ts 写入、utils.ts 的 getViewConfig 展开读取。',
			'// 方言差异：Gel 用本键承载 with 选项；物化视图的配置走 view.ts 的 GelMaterializedViewConfig。',
		]],
	],

	'drizzle-orm/src/pg-core/view-base.ts': [
		[1, [
			'// 本族基准：根 src/ 下没有同名文件，其余四方言 view-base 与本文件同构，只替换类型名与 brand 字面量。',
			'// 为何单独存在：dialect.ts / db.ts / update.ts 需要 is(table, PgViewBase) 与 FROM 参数类型，',
			'// 而薄基类只留品牌，避免为一次判定把 ViewBuilder 与列类型实现拖进这些模块。',
		]],
		[11, [
			'\t// brand 仅在类型层收窄；运行期 is() 比对的是 entityKind，两者必须同时保留。',
		]],
	],
	'drizzle-orm/src/mysql-core/view-base.ts': [
		[1, [
			'// 本文件与 pg-core/view-base.ts 同构（族内基准），只保留品牌；通用继承关系不再展开。',
			'// 方言差异：唯一子类 MySqlView 携带 ViewBuilderConfig（algorithm/sqlSecurity/withCheckOption），',
			'// 但配置挂在 MySqlViewConfig 符号上，不进入本基类，避免 FROM 参数被迫感知建视图语法。',
		]],
		[10, [
			'\t// entityKind 是跨包实例判定的唯一依据，必须与子类 MySqlView 的字符串不同。',
		]],
		[12, [
			'\t// brand 只参与类型收窄、运行期不读取；改字面量不影响 is()。',
		]],
	],
	'drizzle-orm/src/sqlite-core/view-base.ts': [
		[1, [
			'// 本文件与 pg-core/view-base.ts 同构（族内基准），只保留品牌；通用契约不重复。',
			'// 方言差异：SQLite 无物化视图，SQLiteView 是唯一子类；brand 字面量写作 \'SQLiteView\' 而非类名，',
			'// 这是已发布的对外类型值，改名会打断基于 brand 的收窄。',
		]],
		[10, [
			'\t// entityKind 用 \'SQLiteViewBase\'、brand 用 \'SQLiteView\'，两者用途不同：前者运行期判定，后者类型收窄。',
		]],
		[12, [
			'\t// 与其余四方言不同，这里的 _ 未加 readonly，属已发布类型的松散声明，收窄时不能假设其不可变。',
		]],
	],
	'drizzle-orm/src/singlestore-core/view-base.ts': [
		[1, [
			'// 本文件与 pg-core/view-base.ts 同构（族内基准），此处只记录 SingleStore 的差异。',
			'// 方言差异：唯一子类 SingleStoreView 的 ViewBuilderConfig 额外带 definer；配置不进入基类。',
			'// [权衡] alias() 目前不接受视图（见 alias.ts 与 select.types.ts 的注释分支），但基类仍保留，',
			'// 使 FROM 参数与 is() 判定先具备视图能力，后续放开别名时不必改签名。',
		]],
		[10, [
			'\t// brand 与 entityKind 分工：brand 供类型收窄，entityKind 供 is() 跨包实例判定。',
		]],
	],
	'drizzle-orm/src/gel-core/view-base.ts': [
		[1, [
			'// 本文件与 pg-core/view-base.ts 同构（族内基准），只替换类型名与品牌字面量。',
			'// 方言差异：Gel 有两个子类 GelView / GelMaterializedView，故本基类不能假设视图唯一；',
			'// 物化视图配置在 GelMaterializedViewConfig，与本基类无关。',
		]],
		[11, [
			'\t// entityKind 为 \'GelViewBase\'：与子类 \'GelView\' / \'GelMaterializedView\' 都不同，is() 才能区分层级。',
		]],
	],

	'drizzle-orm/src/pg-core/subquery.ts': [
		[1, [
			'// 本文件与 src/subquery.ts 同构：只读 _ 载体、isWith 标记与 usedTables 契约都以根文件为准，此处只补类型。',
			'// 方言差异：AddAliasToSelection 的第三个实参固定为 \'pg\'，决定别名如何改写选中字段里的列名与 table 引用。',
			'// 为何单独存在：WithBuilder 的回调参数是方言 QueryBuilder，且 SELECT 构造器返回方言选型，无法共用。',
		]],
		[7, [
			'// 交叉类型的两半缺一不可：Subquery 提供 alias/getSQL（供 FROM 与 WITH 引用），平铺部分让 sq.col 可被选中。',
			'// [权衡] 用交叉而不是把选中字段塞进 Subquery 泛型：后者会让 Subquery 反向依赖方言选型工具。',
		]],
		[11, [
			'// 与上面的 SubqueryWithSelection 同构，区别是实例来自 WithSubquery（isWith=true），渲染时进入 WITH 子句。',
			'// 两者不可互换：普通子查询内联进 FROM，CTE 必须先由 db.$with 登记，否则 SQL 里缺少声明。',
		]],
		[15, [
			'// 两个重载的分界：只给别名时走 qb.getSelectedFields() 自动取字段；显式给 selection 时字段由调用方 SQL 决定。',
			'// [失败路径] 显式 selection 分支的字段需带 .as(name)：SelectionProxyHandler 对未别名的 SQL 在取列时直接抛错。',
		]],
	],
	'drizzle-orm/src/mysql-core/subquery.ts': [
		[1, [
			'// 本文件与 src/subquery.ts 同构：只读 _ 载体与 isWith 契约沿用根文件，此处只补 MySQL 的类型。',
			'// 方言差异：AddAliasToSelection 的第三个实参为 \'mysql\'，别名改写规则随之切换。',
			'// 为何单独存在：WithBuilder 的 qb 回调类型与 SELECT 构造器都是 mysql-core 专属，无法跨方言复用。',
		]],
		[7, [
			'// 交叉类型的 Subquery 一半提供 alias/getSQL，平铺一半让 sq.<col> 直接出现在 select 字段里。',
			'// 少任一半都会断链：只有 Subquery 时字段不可选，只有平铺时 FROM 拿不到 SQL。',
		]],
		[14, [
			'// 与 SubqueryWithSelection 同构，实例换成 WithSubquery（isWith=true），由 WITH 子句先行声明。',
			'// 类型上不合并成一个别名：普通子查询与 CTE 在 db.with 的入参位置不同，混用会生成缺失声明的 SQL。',
		]],
		[21, [
			'// 重载 1：只给别名，字段从 qb.getSelectedFields() 取；返回的 as 同时接受 builder 与其工厂函数。',
			'// 工厂函数形态让调用方在 CTE 内部再引用 db 构造关联查询，QueryBuilder 由方言在运行期注入。',
		]],
		[32, [
			'\t// 重载 2：显式 selection，字段由外部 SQL 决定，因此要求每列已 .as(name)，否则取列时抛错。',
			'\t// [权衡] 不做重载合并：合并后 selection 可选，类型层无法区分「自动取字段」与「显式给字段」的返回类型。',
		]],
	],
	'drizzle-orm/src/sqlite-core/subquery.ts': [
		[1, [
			'// 本文件与 src/subquery.ts 同构：_ 的只读载体与 isWith 语义沿用根文件，此处只补类型。',
			'// 方言差异：AddAliasToSelection 的第三个实参为 \'sqlite\'；SQLite 的 CTE 同样靠 WITH 子句声明。',
			'// 为何单独存在：WithBuilder 绑定 sqlite-core 的 QueryBuilder 与 SELECT 构造器，不能跨方言共用。',
		]],
		[7, [
			'// 交叉类型：Subquery 一半给 alias/getSQL，平铺一半让 sq.<col> 能直接进 select 字段。',
			'// 两半分别对应两种用法（FROM 引用 / 字段选择），删任一半都会让另一种用法退化成 any。',
		]],
		[11, [
			'// 与 SubqueryWithSelection 同构，但实例是 WithSubquery（isWith=true），渲染时要先进 WITH 列表。',
			'// 普通子查询与 CTE 的类型不能互换：db.with 只接受 WithSubquery，误用会在 SQL 里漏掉声明。',
		]],
		[15, [
			'// 重载 1：别名唯一参数时字段来自 qb.getSelectedFields()；as 同时收 builder 与其工厂函数。',
			'// 工厂参数里的 QueryBuilder 由 sqlite-core 注入，故本接口只能留在方言文件里。',
		]],
	],
	'drizzle-orm/src/singlestore-core/subquery.ts': [
		[1, [
			'// 本文件与 src/subquery.ts 同构：只读 _ 与 isWith 契约沿用根文件，此处只补 SingleStore 的类型。',
			'// 方言差异：AddAliasToSelection 的第三个实参为 \'singlestore\'，别名改写按该方言的列模型执行。',
			'// 为何单独存在：WithBuilder 绑定 SingleStore 的 QueryBuilder 与 SELECT 构造器，无法跨方言复用。',
		]],
		[7, [
			'// 交叉类型的 Subquery 一半提供 alias/getSQL，平铺一半让 sq.<col> 直接用作 select 字段。',
			'// [权衡] 拆成交叉类型而非扩展 Subquery 泛型，避免 Subquery 反向依赖方言选型工具形成环。',
		]],
		[14, [
			'// 与 SubqueryWithSelection 同构，实例为 WithSubquery（isWith=true），需先进 WITH 声明列表。',
			'// 两个类型不可合并：普通子查询内联进 FROM，CTE 必须先登记，否则渲染出的 SQL 缺声明。',
		]],
		[21, [
			'// 重载 1：仅给别名，字段从 qb.getSelectedFields() 取；as 同时接受 builder 与其工厂函数。',
			'// 工厂函数在运行期由 db 注入 QueryBuilder，让 CTE 内部可以再写完整查询。',
		]],
		[32, [
			'\t// 重载 2：显式 selection，字段名由调用方 SQL 决定，故要求逐列 .as(name)。',
			'\t// [失败路径] 未别名的 SQL 字段在 SelectionProxyHandler 取列时抛错（sqlBehavior=\'error\'），不是静默降级。',
		]],
	],
	'drizzle-orm/src/gel-core/subquery.ts': [
		[1, [
			'// 本文件与 src/subquery.ts 同构：只读 _ 与 isWith 契约沿用根文件，此处只补 Gel 的类型。',
			'// 方言差异：AddAliasToSelection 的第三个实参为 \'gel\'；本文件不导出 WithBuilder，',
			'// 因为 Gel 的 $with 在 db.ts / query-builder.ts 内联声明，且不支持「别名 + selection」的两参重载。',
		]],
	],
};

let files = 0;
let lines = 0;
for (const [rel, edits] of Object.entries(PLAN)) {
	const file = path.join(ROOT, rel);
	const text = fs.readFileSync(file, 'utf8');
	if (!text.includes('\r\n')) throw new Error('not CRLF: ' + rel);
	const rows = text.split('\r\n');
	const orig = rows.length;
	for (const [anchor, comments] of edits.sort((a, b) => b[0] - a[0])) {
		if (anchor < 1 || anchor > orig) throw new Error(`bad anchor ${anchor} in ${rel}`);
		rows.splice(anchor - 1, 0, ...comments);
		lines += comments.length;
	}
	fs.writeFileSync(file, rows.join('\r\n'), 'utf8');
	files++;
	console.log(`${rel}\t+${edits.reduce((n, e) => n + e[1].length, 0)}`);
}
console.log(`files=${files} added=${lines}`);
