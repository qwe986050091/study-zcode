// B13 注释插入：逐文件按「1-based 原始行号」在行前插入整行 // 注释，倒序 splice，CRLF 写回。
import fs from 'node:fs';

const ROOT = 'D:/code/opensource/drizzle-orm';
const T = '\t';

const spec = {
	'drizzle-orm/src/pg-core/utils.ts': [
		[1, 0, [
			'// PG 表/视图元数据读取器：把 Symbol 槽位上挂的 builder 展平成 migration 与 introspection 可消费的普通对象。',
			'//',
			'// 链路位置：pgTable()/pgView() 构造时写入列与 extraConfig → 本文件读取 → drizzle-kit 的 pgSerializer',
			'// 生成快照 JSON；本文件不生成 SQL、不缓存，每次调用都会重新执行 extraConfig 回调。',
			'//',
			'// INV-01：extraConfig 回调必须无副作用，否则同表两次读取会得到不同的 builder 集合（守住它的位置：L31~L51）',
			'// INV-02：builder 归类只按 is(builder, XxxBuilder) 的构造器身份，不靠字段形状猜测（守住它的位置：L36~L50）',
			'// INV-03：返回对象的键集合是 pgSerializer 的契约，增删键即快照格式变更（守住它的位置：L53~L64）',
			'// INV-04：extractUsedTable 对已知表拼 `${schema}.${BaseName}`，对未知输入返回 []（守住它的位置：L67~L78）',
		]],
		[19, 0, [
			'// 表元数据快照入口：一次遍历把 Symbol 槽位与 extraConfig 里的 builder 展平，返回全新数组而非表上的引用。',
			'// [失败路径] 回调内抛错不在此包裹，原样冒泡到 drizzle-kit CLI，由该方言的 serializer 终止本表序列化。',
		]],
		[20, 1, ['// 列顺序等于定义顺序：pgSerializer 以此生成 CREATE TABLE 的列序，重排会改变快照 diff。']],
		[24, 1, [
			'// 外键有两条来源：列级 .references() 落在 InlineForeignKeys，表级 foreignKey() 在 extraConfig；',
			'// 只取其一都会让快照缺 REFERENCES，且缺失在生成 SQL 之前不可见。',
		]],
		[26, 1, ['// name 是逻辑表名、schema 是命名空间且可为 undefined；下游按「schema 是否存在」决定是否加限定。']],
		[31, 1, ['// 未传第三个参数时槽位为 undefined；不能默认成空函数，否则无法区分「无约束」与「回调返回空」。']],
		[34, 1, ['// 入参是 ExtraConfigColumns（回调作用域内的列集合），不是整表 Columns：让回调只能引用自己的列。']],
		[35, 1, ['// 兼容数组（可嵌套一层）与对象两种返回；flat(1) 只展平一层，保留 builder 自身的相对顺序。']],
		[36, 1, ['// [失败路径] 没有 else 分支：未注册的 builder 被静默丢弃，新增约束类型若忘记在此加分支会静默丢约束。']],
		[47, 2, ['// PgPolicy 是已构造实例（无 build），其余都是 Builder，需绑定到具体 table 才能产出配置。']],
		[53, 1, [
			'// INV-03：键名即 pgSerializer 的快照契约，增删键属于格式变更，需同步 serializer 与 introspect。',
			'// columns 直接复用 Object.values 的结果，未做防御性拷贝——列对象本身不可变，拷贝只会增加相等性比较成本。',
		]],
		[67, 0, ['// 收集 FROM 中实际出现的表名，供 relational query 的依赖分析与 sql.raw 片段的作用域校验使用。']],
		[69, 1, ['// 判定依据是 table[Schema] 是否为 undefined；空字符串 schema 也会被当作「有命名空间」并拼出 `.table`。']],
		[71, 1, ['// Subquery 在构造期已递归收集内部表名，此处只取缓存；undefined 用 [] 兜底，保证调用方可直接展开。']],
		[74, 1, ['// SQL 的 usedTables 由 sql`` 插值里的表自动登记；raw 字符串不登记，这也是 raw 不得拼表名的原因。']],
		[77, 1, ['// 未知输入返回 [] 而非 undefined：调用方普遍 for..of / .map，返回 undefined 会立刻抛 TypeError。']],
		[80, 0, ['// 视图配置 = 公共 ViewBaseConfig + PG 专属 PgViewConfig；方言字段后展开，同名字段以方言为准。']],
		[90, 0, ['// 物化视图单独取配置：字段集与普通视图不同（例如物化选项），混用会让 serializer 读到无关键。']],
		[100, 0, [
			'// 类型级重映射：把列元素上的 tableName 参数整体替换为目标外键表名，仅参与类型推导，运行期零成本。',
			'// [权衡] 用映射类型而非运行时改写列：后者要复制列对象，破坏列身份比较并让迁移快照出现重复列。',
		]],
	],

	'drizzle-orm/src/mysql-core/utils.ts': [
		[1, 0, [
			'// MySQL 表/视图元数据读取器；结构同构于 pg-core/utils.ts，通用不变量见 INV-pg-utils#01~#04。',
			'//',
			'// 链路位置：MySqlTable 的 Symbol 槽位 + extraConfig 回调 → 本文件展平 → drizzle-kit 的 mysqlSerializer',
			'// 生成快照 JSON。本文件不生成 SQL、不持有连接、不缓存。',
			'//',
			'// 族内映射（本文件 → 基准小节 → 方言差异）：',
			'// - extractUsedTable → INV-pg-utils#04 → 恒返回 BaseName，不拼 schema；MySQL 的 schema 是库名',
			'// - getTableConfig → INV-pg-utils#01/02/03 → 回调入参是 Columns 而非 ExtraConfigColumns，无 check/policy',
			'// - getViewConfig → INV-pg-utils#03 → MySqlViewConfig 与 ViewBaseConfig 直接合并，无物化视图',
			'// - convertIndexToString / toArray → 基准无对应 → MySQL 独有，服务于 index hint 与参数归一',
		]],
		[21, 0, [
			'// MySQL 无跨 schema 的 FROM 限定惯例：库名由连接本身决定，故这里只返回表名。',
			'// 与 PG 的差异在此：若照抄 `${schema}.${BaseName}`，会生成反引号包裹的双重限定并改变语义。',
		]],
		[34, 0, [
			'// 表元数据快照入口；返回新数组，调用方排序/过滤不会污染表定义。',
			'// [权衡] 回调每次重跑而非缓存：缓存会掩盖用户在两次 introspect 之间对表的修改。',
		]],
		[40, 1, [
			'// 外键双来源：列级 .references() 在 InlineForeignKeys，表级 foreignKey() 在 extraConfig；',
			'// MySQL 要求二者都进快照，否则 CREATE TABLE 会缺 REFERENCES。',
		]],
		[41, 1, ['// name / schema / baseName 三者并存：name 是逻辑名，baseName 是物理名，schema 是库名且可为 undefined。']],
		[47, 1, ['// 未传第三个参数时槽位为 undefined；不能默认成空函数，否则无法区分「无约束」与「回调返回空」。']],
		[48, 2, ['// 与 PG 的差异：回调收到整表 Columns，因为 MySQL 的 key 定义需要引用任意列（含前缀长度与排序）。']],
		[49, 2, ['// 兼容 [] 与 {} 两种返回；对数组再包一层 Object.values 是恒等操作，对对象则丢弃键名。']],
		[50, 2, ['// [失败路径] 没有 else 分支：未注册的 builder 被静默丢弃，新增约束类型时必须同步这里。']],
		[65, 1, [
			'// 返回 baseName 是 MySQL 独有：物理表名可能与逻辑名不同，serializer 需要保留原值。',
			'// 键集合即快照契约，增删键要同步 drizzle-kit 的 mysqlSerializer。',
		]],
		[78, 0, [
			'// 只合并公共 ViewBaseConfig 与 MySqlViewConfig；MySQL 没有物化视图，故无 getMaterializedViewConfig。',
			'// 展开顺序让方言字段覆盖公共字段。',
		]],
		[88, 0, [
			'// index hint 的输入可以是索引名或 Index 对象；这里统一收敛成名字，供 USE/FORCE/IGNORE INDEX 渲染。',
			'// [权衡] 不去重、不校验存在性：重复 hint 合法，索引是否存在由数据库在执行期判定。',
		]],
		[94, 0, [
			'// 单值/数组归一，供 limit、index hint 等「可单可多」的配置复用。',
			'// 不拷贝数组：返回值可能与入参同一引用，调用方约定只读，避免无谓分配。',
		]],
	],

	'drizzle-orm/src/sqlite-core/utils.ts': [
		[1, 0, [
			'// SQLite 表/视图元数据读取器；结构同构于 pg-core/utils.ts，通用不变量见 INV-pg-utils#01~#04。',
			'//',
			'// 链路位置：SQLiteTable 的 Symbol 槽位 + extraConfig 回调 → 本文件展平 → drizzle-kit 的',
			'// sqliteSerializer 生成快照。SQLite 无 schema 概念（ATTACH 的库名不参与表定义）。',
			'//',
			'// 族内映射：getTableConfig → INV-pg-utils#01/02/03（差异：无 schema、无 policy/RLS）；',
			'// extractUsedTable → INV-pg-utils#04（差异：恒返回单个 BaseName）；getViewConfig → INV-03',
			'// （差异：SQLiteViewConfig 整段被注释，当前只回放 ViewBaseConfig）；OnConflict 为方言独有类型。',
		]],
		[19, 0, [
			'// 表元数据快照入口；SQLite 的表定义只在本库内生效，因此既不读取也不返回 schema。',
			'// 返回新数组，调用方过滤不影响表对象。',
		]],
		[25, 1, ['// InlineForeignKeys 来自列级 .references()；表级 foreignKey() 走下面的 extraConfig。']],
		[28, 1, ['// 无 schema：表名在库内全局唯一，附加数据库的限定由连接层处理，不进入表配置。']],
		[30, 1, ['// 未传第三个参数时槽位为 undefined；不默认成空函数，以区分「无约束」与「回调返回空」。']],
		[31, 1, ['// 回调入参是整表 Columns；兼容 []/{} 两种返回，flat(1) 只展平一层。']],
		[33, 2, ['// [失败路径] 未注册的 builder 静默丢弃：新增约束类型时必须在此补分支，否则快照缺约束且无报错。']],
		[48, 1, ['// 键集合刻意比 PG 少 schema/policies/enableRLS：serializer 按键存在性分支，缺键即表示方言不支持。']],
		[59, 0, ['// 只回 BaseName：SQLite 的限定名是附加库名，与表定义无关，拼进去会改变查询语义。']],
		[63, 1, ['// Subquery 构造期已递归收集 usedTables，此处只取缓存并用 [] 兜底，保证调用方可直接展开。']],
		[66, 1, ['// SQL 的 usedTables 由 sql`` 插值自动登记，raw 字符串不登记。']],
		[72, 0, ['// SQLite 冲突解决算法全集，直接映射到 ON CONFLICT 子句；类型收窄在此处，insert/update 共用。']],
		[74, 0, [
			'// 当前只回放公共 ViewBaseConfig；SQLiteViewConfig 的合并被注释掉，说明方言专属视图字段尚未落地。',
			'// [失败路径] 读取方若访问方言专属键会得到 undefined 而非抛错，依赖方需自行兜底。',
		]],
	],

	'drizzle-orm/src/singlestore-core/utils.ts': [
		[1, 0, [
			'// SingleStore 表元数据读取器；结构同构于 pg-core/utils.ts，通用不变量见 INV-pg-utils#01~#04。',
			'// 族内映射：extractUsedTable → INV-pg-utils#04（差异：恒 BaseName）；getTableConfig → INV-01/02/03',
			'// （差异：只收集 index/unique/primary 三类 builder，无 check/foreignKey/policy）；getViewConfig 整段被注释。',
			'// 视图能力尚未启用，故不导出 getViewConfig——读取方拿不到 SingleStoreViewConfig 的合并结果。',
		]],
		[14, 0, ['// 与 MySQL 一致：schema 即库名，不参与 FROM 限定，故只返回 BaseName。']],
		[27, 0, ['// 表元数据快照入口；返回对象不含 foreignKeys/checks——键集合即能力集，下游按键存在性判断。']],
	],

	'drizzle-orm/src/gel-core/utils.ts': [
		[1, 0, [
			'// Gel 表/视图元数据读取器；结构同构于 pg-core/utils.ts，通用不变量见 INV-pg-utils#01~#04。',
			'//',
			'// 链路位置：GelTable 的 Symbol 槽位 + extraConfig 回调 → 本文件展平 → drizzle-kit 的 gelSerializer',
			'// 生成快照。返回对象与 PG 几乎逐一对应（含 policies/enableRLS/物化视图），差异集中在表名与列类型语义。',
			'//',
			'// 族内映射：extractUsedTable → INV-pg-utils#04（差异：恒 BaseName，模块名不进 FROM）；',
			'// getTableConfig → INV-01/02/03（差异：回调列集合经基类 Symbol 取）；getViewConfig/getMaterializedViewConfig → INV-03。',
		]],
		[19, 0, [
			'// 表元数据快照入口；返回全新数组，调用方过滤不污染表定义。',
			'// [权衡] 回调每次调用重跑而不缓存：缓存会让跨进程 introspect 读到旧约束。',
		]],
		[20, 1, ['// 列顺序即定义顺序，serializer 依赖它生成输出中的字段序。']],
		[24, 1, ['// 外键双来源之一（列级 .references()）；表级 foreignKey() 在 extraConfig，二者必须合并。']],
		[26, 1, ['// name 是逻辑名、schema 是模块名且可为 undefined；模块名只做快照元数据，不参与 FROM 限定。']],
		[31, 1, ['// 未传第三个参数时槽位为 undefined；不默认成空函数，以区分「无约束」与「回调返回空」。']],
		[34, 2, [
			'// [权衡] 这里经 Table.Symbol.ExtraConfigColumns 取回调列集合，列本体经 Table.Symbol.Columns 取；',
			'// 两处都用基类 Symbol，与 PG 一致——Gel 刻意复用基类槽位，而非在 GelTable 上另建一份。',
		]],
		[35, 2, ['// 兼容 []/{} 两种返回；flat(1) 只展平一层，Object.values 对数组是恒等操作。']],
		[36, 2, ['// [失败路径] 未注册的 builder 静默丢弃：新增约束类型若忘记加分支，快照缺约束且无报错。']],
		[47, 2, ['// GelPolicy 是已构造实例（无 build），其余为 Builder，需绑定 table 才能产出配置。']],
		[53, 1, [
			'// 键集合与 PG 对齐（含 policies/enableRLS），便于 drizzle-kit 复用同一套 serializer 骨架。',
			'// 增删键属于快照格式变更，需同步 gelSerializer。',
		]],
		[67, 0, ['// 只回 BaseName：schema 是 Gel 的模块名，跨模块引用由查询自身解析，拼进 FROM 会破坏限定语义。']],
		[68, 1, ['// [权衡] 与 PG 不同，这里不拼 schema 前缀；若未来支持跨模块查询，需同步改这里与调用方。']],
		[71, 1, ['// Subquery 构造期已递归收集 usedTables，此处取缓存并 [] 兜底，保证调用方可直接展开。']],
		[74, 1, ['// SQL 的 usedTables 由 sql`` 插值自动登记，raw 字符串不登记。']],
		[77, 1, ['// 未知输入返回 [] 而非 undefined，避免调用方直接展开时抛 TypeError。']],
		[80, 0, [
			'// 视图配置 = 公共 ViewBaseConfig + GelViewConfig；展开顺序让方言字段覆盖公共字段。',
			'// 与 PG 同名函数逐行对应，唯一差异是配置对象来源。',
		]],
		[90, 0, [
			'// 物化视图配置单独取：字段集与普通视图不同，混用会让 serializer 读到无关键。',
			'// 二者共用 ViewBaseConfig，name/query 的读取逻辑不分叉。',
		]],
		[100, 0, [
			'// 类型级重映射：把列元素上的 tableName 参数替换为目标外键表名，仅参与类型推导，运行期零成本。',
			'// [权衡] 用映射类型而非运行时改写列：复制列对象会破坏列身份比较，并让快照出现重复列。',
		]],
	],

	'drizzle-orm/src/pg-core/schema.ts': [
		[1, 0, [
			'// PgSchema：把 pgTable/pgView/pgEnum/pgSequence 绑定到固定 schema 的命名空间对象。',
			'//',
			'// 链路位置：drizzle(pgSchema(\'app\')) 后用户调用本类的 table/view/enum/sequence → 各 WithSchema 函数',
			'// 把 schemaName 写进目标对象的 Symbol 槽位 → dialect 渲染 "app"."users"，drizzle-kit 读同一槽位出快照。',
			'//',
			'// INV-01：schemaName 构造期确定且 readonly，所有子对象共享同一个值，禁止中途改绑（守住它的位置：constructor）',
			'// INV-02：四个转发属性必须是箭头函数；方法形式在用户解构 `const { table } = schema` 后会丢 this（守住它的位置：L15~L49）',
			'// INV-03：pgSchema(\'public\') 在构造前抛错，不返回等价对象（守住它的位置：pgSchema）',
		]],
		[9, 0, ['// 实现 SQLWrapper 是为了让 schema 本身能出现在 sql`` 片段里，解析为带引号的标识符。']],
		[15, 1, [
			'// 箭头函数属性而非方法：用户可能解构 `const { table } = schema`，箭头函数把 this 捕获在构造期，',
			'// 解构后仍能读到 schemaName；写成方法则 this 变成 undefined 并在调用时抛出。',
		]],
		[19, 1, ['// 通过 as typeof pgView 对齐无 schema 版本的返回类型，使 schema.view 与顶层 pgView 可互换。']],
		[27, 1, ['// 重载只服务类型推导：数组形式得到 PgEnum<Writable<T>>，对象形式得到 PgEnumObject<E>。']],
		[37, 1, ['// [失败路径] Array.isArray 是唯一分流依据；非数组非对象输入会在 WithSchema 内部抛错，此处不吞异常。']],
		[47, 1, ['// sequence 同样绑定 schema；未传 options 时由 pgSequenceWithSchema 填默认 increment/min/max。']],
		[51, 1, ['// 标识符按方言规则加双引号并转义内嵌引号，因此 schemaName 含点号或大写也能安全渲染。']],
		[55, 1, ['// 返回 true 让 SQL 拼接层不再给 schema 加括号；否则会得到 ("app") 这种非法限定名。']],
		[60, 0, ['// 运行时类型守卫靠 entityKind 标记而非 instanceof：dist 与 src 双份副本时 instanceof 会失效。']],
		[64, 0, ['// [权衡] 构造前抛错而非返回等价的默认 schema 对象：后者会让 Symbol 组合与 pgTable() 不同，快照出现难解释的差异。']],
	],

	'drizzle-orm/src/pg-core/expressions.ts': [
		[1, 0, [
			'// PG 表达式桶：重导出公共 SQL 表达式集，并补充依赖 PG 列类型的方言函数。',
			'// 链路位置：query-builder 与用户代码从这里取 concat/substring 与公共表达式（eq/and/count…）→',
			'// 返回未绑定的 SQL AST → dialect 在 build 阶段展平；本文件不执行、不缓存。',
			'// 本文件是 expressions.ts 族的基准；INV-exp#01：每个函数都必须返回新的 SQL 实例，禁止复用可变 AST。',
			'// 兄弟方言只在列类型导入路径与方言专属函数上不同，见各自文件头的族内映射。',
		]],
		[8, 0, ['// `||` 是 PG 的字符串连接运算符；bindIfParam 决定 value 作为列、占位符还是字面量参与绑定。']],
		[12, 0, ['// [权衡] from/for 分开判断而非拼一个对象：省略参数时不能输出 `substring(x from )`，必须整段跳过。']],
	],

	'drizzle-orm/src/mysql-core/expressions.ts': [
		[1, 0, [
			'// MySQL 表达式桶：与 pg-core/expressions.ts 同构，INV-exp#01 同（函数必须返回新的 SQL 实例）。',
			'// 族内差异：列类型取自同目录 ./columns/index.ts，导出集与基准一致，无方言专属函数。',
			'// 链路位置：同基准——产出未绑定 SQL AST，由 MySqlDialect 展平为 `?` 占位符文本。',
			'// [权衡] concat 仍用 `||`：MySQL 默认把它当逻辑 OR，只有 PIPES_AS_CONCAT 模式下才是连接；',
			'// 方言层未改写，因此正确性依赖连接的 sql_mode，这是已知不足而非本文件可修。',
		]],
		[8, 0, ['// 列类型来自同目录 ./columns，避免经 ~/mysql-core 再导一次造成循环依赖。']],
		[12, 0, ['// substring 的参数省略逻辑与基准一致：from/for 各自可选，缺省时整段不输出。']],
	],

	'drizzle-orm/src/sqlite-core/expressions.ts': [
		[1, 0, [
			'// SQLite 表达式桶：与 pg-core/expressions.ts 同构，INV-exp#01 同（函数必须返回新的 SQL 实例）。',
			'// 族内差异：签名不含 Placeholder（SQLite 只按位置绑定），并额外导出 rowId()。',
			'// 链路位置：同基准——产出未绑定 SQL AST，由 SQLiteSyncDialect / SQLiteAsyncDialect 展平。',
			'// 列类型来自 ~/sqlite-core/columns/index.ts，与 pg/gel 同用绝对别名导入。',
			'// [权衡] concat 用 `||`：SQLite 的 `||` 就是连接运算符，无需像 MySQL 那样关心 sql_mode。',
		]],
		[8, 0, ['// 相比 PG/MySQL 少一个 Placeholder 分支：SQLite 无编号占位符，value 只能是字符串或 SQLWrapper。']],
		[12, 0, ['// from/for 均可省略；省略时不输出空槽，避免 `substring(x from )` 语法错误。']],
		[27, 0, ['// rowid 是 SQLite 的隐式主键列（WITHOUT ROWID 表除外）；返回带 number 泛型的裸标识符供比较。']],
	],

	'drizzle-orm/src/singlestore-core/expressions.ts': [
		[1, 0, [
			'// SingleStore 表达式桶：与 pg-core/expressions.ts 同构，INV-exp#01 同。',
			'// 族内差异：额外导出向量函数 dotProduct/euclideanDistance；列类型来自 ./columns/index.ts。',
			'// 链路位置：同基准——产出未绑定 SQL AST，由 SingleStoreDialect 展平。',
			'// [权衡] 向量字面量用 JSON.stringify 内联：<*>/<-> 右侧必须是数组字面量，参数绑定会得到 `?` 而无法解析。',
		]],
		[8, 0, ['// 与 MySQL 同形：`||` 的语义取决于 sql_mode，方言层未改写。']],
		[12, 0, ['// from/for 各自可选，缺省时整段不输出。']],
		[28, 0, ['// <*> 为点积运算符；值必须内联为 JSON 数组文本，故此处不走参数绑定。']],
		[32, 0, ['// <-> 为欧氏距离运算符，同样要求右侧为内联数组字面量。']],
	],

	'drizzle-orm/src/gel-core/expressions.ts': [
		[1, 0, [
			'// Gel 表达式桶：与 pg-core/expressions.ts 同构，INV-exp#01 同（函数必须返回新的 SQL 实例）。',
			'// 族内差异：列类型来自 ~/gel-core/columns/index.ts；导出集与 PG 完全一致，无方言专属函数。',
			'// 链路位置：同基准——产出未绑定 SQL AST，由 GelDialect 转成 edgeql 片段。',
			'// [权衡] concat 仍用 `||`：Gel 的字符串拼接运算符与 PG 同形，故 AST 可原样复用，不做方言改写。',
		]],
		[6, 0, ['// 重导出公共表达式集（eq/and/or/count…），保证 drizzle-orm/gel-core 与 drizzle-orm 拿到同一批函数。']],
		[8, 0, ['// bindIfParam 的作用与 PG 相同：区分列、占位符与字面量；Gel 最终由 dialect 决定绑定形态。']],
		[12, 0, ['// from/for 各自可选，缺省时整段不输出，避免空槽。']],
	],
};

for (const [rel, items] of Object.entries(spec)) {
	const file = `${ROOT}/${rel}`;
	const text = fs.readFileSync(file, 'utf8');
	const lines = text.split('\r\n');
	const sorted = [...items].sort((a, b) => b[0] - a[0]);
	for (const [at, indent, comments] of sorted) {
		if (at < 1 || at > lines.length) throw new Error(`bad anchor ${rel}:${at} (total ${lines.length})`);
		const pad = T.repeat(indent);
		lines.splice(at - 1, 0, ...comments.map((c) => pad + c));
	}
	fs.writeFileSync(file, lines.join('\r\n'), 'utf8');
	console.log(`${rel}\t+${items.reduce((a, x) => a + x[2].length, 0)}`);
}
