// B14：五方言表约束声明类（primary-keys / unique-constraint / checks）深度注释插入。
// 规则：只新增整行 // 注释；按「1-based 原始行号，在该行前插入」；倒序 splice；CRLF 写回。
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'd:/code/opensource/drizzle-orm';

const plans = {
	'drizzle-orm/src/pg-core/primary-keys.ts': [
		[1, [
			'// 表级复合主键声明：把 primaryKey({ columns }) 的意图固化成可序列化的元数据，本文件不生成 SQL。',
			'// 链路：pgTable 的 extraConfig 产出 PrimaryKeyBuilder → getTableConfig 按 entityKind 归集并 build →',
			'// drizzle-kit pgSerializer 取 getName() 与 columns 写快照 → PgCreateTableConvertor 渲染 PRIMARY KEY。',
			'// INV-01：表内约束名唯一，缺省名「表名_列名以 _ 连接_pk」；重名会让 CREATE TABLE 直接失败。',
			'// INV-02：columns 必须同表；泛型 { tableName: TTableName } 只约束编译期，运行时零校验。',
			'// INV-03：DDL 里 PRIMARY KEY 只出现一次，排在列定义之后、UNIQUE 与 CHECK 之前（取 compositePKs[0]）。',
		]],
		[18, [
			'// [失败路径] 变参重载已废弃但保留：空参调用会在 config[0].columns 处抛 TypeError，而不是友好报错。',
		]],
		[25, [
			'// entityKind 带 Pg 前缀是硬约束：is() 在跨包场景按 entityKind 字符串相等判定，重名会让其他方言的',
			'// builder 被 getTableConfig 当成本方言约束收集，产生幽灵主键。',
		]],
		[59, [
			'\t// [权衡] 缺省名惰性推导：casing 由 serializer 决定；它还会对显式 name 做列名替换，含列名子串的自定义名会被改写。',
		]],
	],
	'drizzle-orm/src/pg-core/unique-constraint.ts': [
		[1, [
			'// 表级唯一约束声明：unique(名).on(col, ...) 的产物，负责缺省命名与 NULLS NOT DISTINCT 开关。',
			'// 链路：extraConfig → UniqueConstraintBuilder（on 时才创建）→ getTableConfig 归集 build →',
			'// pgSerializer 写 uniqueConstraints 快照并做表内重名检测 → PgCreateTableConvertor 渲染 UNIQUE。',
			'// INV-01：缺省名「表名_列名以 _ 连接_unique」，与列级 .unique() 的缺省名同构；同一列两种写法会撞名，',
			'//         serializer 检测到重复即 process.exit(1)（守住它的位置：uniqueKeyName 与构造函数）。',
			'// INV-02：columns 必须来自本表，运行时不校验；跨表列会生成引用不存在列的 DDL。',
			'// INV-03：nullsNotDistinct 是整条约束的粒度，不能按列设置，且 PG 15 以下没有该语法。',
			'// INV-04：DDL 排序为 列定义 → PRIMARY KEY → UNIQUE → CHECK，唯一约束不得插进列定义之间。',
		]],
		[6, [
			'// [权衡] 拆成 unique() + .on() 两段只为贴近 SQL 读法：unique() 返回「尚未绑定列」的构建器。',
		]],
		[10, [
			'// 列级 .unique() 也调用本函数（columns/common.ts），改格式会同时改动列级与表级 UNIQUE 的缺省名。',
		]],
		[29, [
			'\t// [失败路径] 构建期不探测服务端版本：PG 15 以下会在这条 DDL 上报语法错误，错误直到 migrate 才出现。',
			'\t// [权衡] 用可变字段 + 返回 this 实现链式：builder 只被 extraConfig 用一次，无需不可变副本。',
		]],
		[52, [
			'\t// [失败路径] 不校验列归属、列重复与空参：on(t.a, t.a) 会生成含重复列的 UNIQUE，由数据库拒绝。',
		]],
		[66, [
			'\t\t// [权衡] 名字在构造期固化为字符串（类型仍写可选以统一接口）；serializer 里的 ?? 兜底已是死分支。',
		]],
	],
	'drizzle-orm/src/pg-core/checks.ts': [
		[1, [
			'// 表级 CHECK 约束声明：只保存 name 与 SQL 条件，构建期不解析、不求值，也不渲染 SQL。',
			'// 链路：extraConfig 产出 CheckBuilder → getTableConfig 归集 build → pgSerializer 用',
			'// dialect.sqlToQuery(value).sql 取文本写快照（参数被丢弃）→ sqlgenerator 渲染 CHECK (...)。',
			'// INV-01：name 在表内唯一；serializer 发现重名即 process.exit(1)，数据库侧同名约束同样冲突。',
			'// INV-02：value 必须是无参数 SQL；带占位符会留下 $1 这类悬空引用，DDL 执行时才会报错。',
		]],
		[13, [
			'\t// [失败路径] 只做持有关系转换：不校验 value 是否引用本表列、name 是否重复，错误全部推迟到迁移生成。',
		]],
		[30, [
			'// [权衡] 保持薄工厂而不做防御性校验：check() 在 schema 加载期调用，抛错会直接中断应用启动。',
		]],
	],
	'drizzle-orm/src/mysql-core/primary-keys.ts': [
		[1, [
			'// 与 pg-core/primary-keys.ts 同构，通用不变量见 INV-PKPG#01~#03；本文只标注 MySQL 差异。',
			'// 族内映射：primaryKey() → INV-PKPG#02（同表列，仅编译期约束）；build 时点 → INV-PKPG#03；',
			'// getName → INV-PKPG#01（缺省名「表名_列以 _ 连接_pk」）。',
			'// 差异：MySQL 没有 nullsNotDistinct 概念，本文件也不含该开关；复合主键列在 mysqlSerializer 中被强制',
			'// 置为 notNull=true，因为主键列隐式 NOT NULL，快照不改会让列可空性在 diff 中反复翻转。',
			'// 差异：DDL 由 MySqlCreateTableConvertor 生成，列级 PRIMARY KEY 与表级 CONSTRAINT 二选一。',
		]],
		[60, [
			'\t// [失败路径] 列级 autoIncrement 与表级复合主键需用户自行配平：MySQL 要求自增列是某个索引的首列，',
			'\t// 落在复合主键非首列时建表报 1075，本文件与 serializer 都不做这项检查。',
			'\t// [权衡] 名字惰性推导：mysqlSerializer 按 casing 逐列替换，显式名含列名子串时同样会被改写。',
		]],
	],
	'drizzle-orm/src/mysql-core/unique-constraint.ts': [
		[1, [
			'// 与 pg-core/unique-constraint.ts 同构，通用不变量见 INV-UQPG#01~#04；本文只标注 MySQL 差异。',
			'// 族内映射：unique()/.on() → INV-UQPG#01（缺省名，列级 .unique() 共用 uniqueKeyName）；',
			'// build → INV-UQPG#02（列归属不校验）；UNIQUE 在 DDL 中的位置 → INV-UQPG#04。',
			'// INV-05：build 只拷贝列引用，不深拷贝列对象；列不可变，深拷贝只会增加快照比较成本。',
			'// 差异：没有 nullsNotDistinct() 方法，也没有 NULLS NOT DISTINCT 语法；类上的同名只读字段恒为 false，',
			'// mysqlSerializer 不读取它——这是为对齐五方言构造签名留的占位，不是可配置项。',
			'// 差异：UNIQUE 的约束名同时是索引名，表内唯一；CHECK 的约束名则是库级唯一，二者规则不同。',
			'// 差异：serializer 只按表检测重名，跨表同名要到建索引时才报 1061。',
			'// 差异：本类不承载 where；部分唯一只能走 uniqueIndex().where()，而 MySQL 无部分索引语法，此路不通。',
		]],
		[10, [
			'// 列级 .unique()（columns/common.ts）也调用本函数；同列同时写列级与表级 unique 会得到同名并触发退出。',
		]],
		[45, [
			'\t// [失败路径] 不校验列归属、重复与空参：on(t.a, t.a) 会生成重复列 UNIQUE，建表期由服务端拒绝。',
		]],
		[50, [
			'// 与 Builder 的区别：UniqueConstraint 是绑定 table 后的只读快照，name 已解析为最终字符串。',
		]],
		[57, [
			'\t// [权衡] 与 PK 相反，缺省名在构造期固化为字符串：快照需要稳定的 name，getName 只做透传。',
		]],
	],
	'drizzle-orm/src/mysql-core/checks.ts': [
		[1, [
			'// 与 pg-core/checks.ts 同构，通用不变量见 INV-CKPG#01~#02；本文只标注 MySQL 差异。',
			'// 差异：MySQL 8.0.16 之前解析但忽略 CHECK；本文件与 serializer 都不探测版本，声明能通过、DDL 能执行，',
			'// 数据却不受约束——需要强制的环境必须自行确认服务端版本。',
			'// 差异：CHECK 约束名在 MySQL 是库级唯一，而 serializer 只按表检测重名，跨表同名在建表期报 3822。',
			'// 差异：value 文本同样来自 dialect.sqlToQuery，MySQL 占位符是 ?，参数不会进入快照。',
		]],
		[13, [
			'\t// [失败路径] 不校验 value 是否引用本表列、name 是否重复：错误推迟到迁移生成或服务端执行阶段。',
		]],
		[30, [
			'// [权衡] 保持薄工厂：8.0.16 以下 CHECK 被忽略，若在此做版本探测会让 schema 加载依赖连接信息。',
		]],
	],
	'drizzle-orm/src/sqlite-core/primary-keys.ts': [
		[1, [
			'// 与 pg-core/primary-keys.ts 同构，通用不变量见 INV-PKPG#01~#03；本文只标注 SQLite 差异。',
			'// 族内映射：primaryKey() → INV-PKPG#02；build → INV-PKPG#03；getName → INV-PKPG#01。',
			'// 差异：sqliteSerializer 把单列表级主键折叠成该列的 primaryKey 标记，多列才写 compositePrimaryKeys；',
			'// 折叠只复制「是否主键」，不带列级 autoIncrement，故表级单列声明无法表达自增语义。',
			'// 差异：AUTOINCREMENT 只能出现在 INTEGER PRIMARY KEY 列上；复合主键再加列级 autoIncrement 会生成',
			'// 两个主键定义，SQLite 报 table has more than one primary key，本文件不拦截。',
		]],
		[27, [
			'\t// [权衡] _ 是纯类型品牌位，运行时为 undefined；用于在类型层区分本方言 builder，不参与任何判定。',
		]],
		[62, [
			'\t// [权衡] 名字惰性推导且 DDL 不引用：SQLite 不支持命名表级主键，这个名字只用于快照比对。',
			'\t// [失败路径] serializer 按 casing 逐列替换名字，显式 name 含列名子串时也会被改写。',
		]],
	],
	'drizzle-orm/src/sqlite-core/unique-constraint.ts': [
		[1, [
			'// 与 pg-core/unique-constraint.ts 同构，通用不变量见 INV-UQPG#01~#04；本文只标注 SQLite 差异。',
			'// 族内映射：unique()/.on() → INV-UQPG#01；build → INV-UQPG#02；UNIQUE 位置 → INV-UQPG#04。',
			'// 差异：表级 UNIQUE 在 sqliteSerializer 里落成索引条目（isUnique: true），不是约束对象；',
			'// 名字因此与索引共用命名空间，重名检测比对的是 indexesObject 而非 uniqueConstraints。',
			'// 差异：没有 nullsNotDistinct：SQLite 的 UNIQUE 本就把 NULL 视为互不相等，无法用约束选项改变。',
			'// 差异：本类不承载 where 与 conflict。部分唯一走 uniqueIndex().where()（3.8.0+ 的部分索引）；',
			'// 冲突策略只能写在列级 PrimaryKeyConfig.onConflict 或运行期的 ON CONFLICT 子句里。',
			'// [失败路径] SQLite 索引名是库内全局唯一，serializer 只按表查重，跨表同名要到建索引时才报错。',
		]],
		[10, [
			'// 列级 .unique()（columns/common.ts）复用 uniqueKeyName，两种写法在同一列上会得到同名并触发退出。',
		]],
		[28, [
			'\t// [失败路径] build 不检查列是否属于传入的 table：跨表列会生成引用不存在列的索引定义。',
		]],
		[45, [
			'\t// [失败路径] 不校验列重复、空参与归属：on(t.a, t.a) 生成的索引列重复，SQLite 建索引时拒绝。',
		]],
		[50, [
			'// 只读快照：绑定 table 后 name 已是字符串，columns 仅持有引用，供 serializer 映射 casing。',
		]],
		[56, [
			'\t// [权衡] 名字构造期固化：索引名在 DDL 中直接引用，且快照与索引必须一次确定。',
		]],
	],
	'drizzle-orm/src/sqlite-core/checks.ts': [
		[1, [
			'// 与 pg-core/checks.ts 同构，通用不变量见 INV-CKPG#01~#02；本文只标注 SQLite 差异。',
			'// 差异：SQLite 对 CHECK 一直强制生效，无版本门槛；NO INHERIT 也不存在（SQLite 没有表继承），',
			'// 故本族 check() 不暴露任何「写了会被忽略」的开关。',
			'// 差异：sqlgenerator 渲染 SQLite CHECK 时给名字加双引号（CONSTRAINT "名" CHECK(...)），',
			'// 而 UNIQUE / PRIMARY KEY 不加引号；名字含特殊字符时只有 CHECK 能安全生成。',
			'// [失败路径] value 走 dialect.sqlToQuery 后只剩文本，占位符是 ?，参数丢弃后 DDL 会出现悬空问号。',
		]],
		[12, [
			'\t// [失败路径] 仅做持有关系转换：不校验条件语法、列归属与名字重复，错误推迟到迁移生成期。',
		]],
		[20, [
			'\t// [权衡] _ 品牌位只服务类型推导，运行时为 undefined；鉴别统一走 entityKind，不要用它。',
		]],
		[33, [
			'// [权衡] 薄工厂：schema 加载期调用，若在此解析 SQL 或查表会把纯声明变成可能抛错的初始化路径。',
		]],
	],
	'drizzle-orm/src/singlestore-core/primary-keys.ts': [
		[1, [
			'// 与 pg-core/primary-keys.ts 同构，通用不变量见 INV-PKPG#01~#03；SingleStore 走 MySQL 协议，差异很小。',
			'// 族内映射：primaryKey() → INV-PKPG#02；build → INV-PKPG#03；getName → INV-PKPG#01。',
			'// 差异：singlestoreSerializer 不做 casing 映射，直接以 pk.getName() 与列原始 name 写快照，',
			'// 因此 casing 配置对该方言的主键名与列名不生效（与 mysqlSerializer 行为不一致）。',
			'// 差异：复合主键列同样被 serializer 强制置 notNull=true，理由与 MySQL 相同：主键列隐式非空。',
			'// 差异：DDL 由 SingleStoreCreateTableConvertor 生成，语法与 MySQL 分支逐字相同。',
		]],
		[59, [
			'\t// [权衡] 名字惰性推导：缺省名只在快照生成时需要，构造期固化会把表名读取提前到 schema 定义期。',
			'\t// [失败路径] 名字不经过 casing 替换，可能与列的 cased 名不一致；自定义 casing 时请显式传 name。',
		]],
	],
	'drizzle-orm/src/singlestore-core/unique-constraint.ts': [
		[1, [
			'// 与 pg-core/unique-constraint.ts 同构，通用不变量见 INV-UQPG#01~#04；SingleStore 走 MySQL 协议。',
			'// 族内映射：unique()/.on() → INV-UQPG#01；build → INV-UQPG#02；UNIQUE 位置 → INV-UQPG#04。',
			'// 差异：无 nullsNotDistinct() 方法，也没有对应语法；类上的只读字段恒为 false 且无人读取，',
			'// 仅用于与其他方言保持相同构造签名。',
			'// 差异：singlestoreSerializer 不做 casing 替换（name 与 columns 都取原始值），MySQL 分支会做，',
			'// 同一份 schema 在两个方言下可能生成不同的约束名与列名。',
			'// 差异：本方言没有 checks.ts，serializer 也不解构 checks——SingleStore 侧 CHECK 完全没有入口。',
			'// [失败路径] SingleStore 无部分索引，where 无处承载；条件唯一只能靠生成列 + 唯一索引。',
		]],
		[10, [
			'// 列级 .unique()（columns/common.ts）复用本函数；与表级同列写法撞名时同样受同一命名规则约束。',
		]],
		[28, [
			'\t// [失败路径] build 不校验列归属：跨表列会生成引用不存在列的 UNIQUE，建表期才失败。',
		]],
		[45, [
			'\t// [失败路径] 不校验列重复、空参与归属：重复列会生成重复列 UNIQUE，建表期由服务端拒绝。',
		]],
		[50, [
			'// 只读快照：绑定 table 后 name 为最终字符串，columns 仅持引用，供 serializer 直接取 name。',
		]],
		[57, [
			'\t// [权衡] 名字构造期固化：快照需要稳定 name；serializer 里 unq.name ?? ... 的兜底已成死分支。',
		]],
	],
	'drizzle-orm/src/gel-core/primary-keys.ts': [
		[1, [
			'// 与 pg-core/primary-keys.ts 同构，通用不变量见 INV-PKPG#01~#03；本文只标注 Gel 差异。',
			'// 族内映射：primaryKey() → INV-PKPG#02；build → INV-PKPG#03；getName → INV-PKPG#01。',
			'// 差异：Gel 快照由 gelSerializer 生成，主键写入 compositePrimaryKeys；sqlgenerator 没有 Gel 分支，',
			'// 故本文件只产出元数据，不存在本文件负责的 DDL 顺序。',
			'// 差异：introspect-gel 用 compositePrimaryKeys 反推 schema 里的 primaryKey 导入，缺了它会把',
			'// 已有主键判成新增，产生多余迁移。',
		]],
		[43, [
			'\t// [失败路径] build 不校验列归属与 name 唯一：跨表列或重名会一路写进快照，直到迁移生成才暴露。',
		]],
		[59, [
			'\t// [权衡] 缺省名惰性推导：只用于快照键与 diff，不进 edgeql/SQL 文本；serializer 会按 casing 逐列替换。',
		]],
	],
	'drizzle-orm/src/gel-core/unique-constraint.ts': [
		[1, [
			'// 与 pg-core/unique-constraint.ts 同构，通用不变量见 INV-UQPG#01~#04；本文只标注 Gel 差异。',
			'// 族内映射：unique()/.on() → INV-UQPG#01；build → INV-UQPG#02；nullsNotDistinct → INV-UQPG#03。',
			'// 差异：nullsNotDistinct() 与字段都保留（Gel 语义接近 PG），但 gelSerializer 的 uniqueConstraints',
			'// 分支被整段注释掉、最终写 uniqueConstraints: {}——本文件声明的约束不进快照，也不生成迁移。',
			'// 差异：因此 name 与 nullsNotDistinct 目前只对运行时对象有意义，改它们不影响产物；接入序列化前',
			'// 不要把这里当成可用能力对外说明。',
			'// [失败路径] 列级 .unique() 在 gelSerializer 里同样被注释：Gel 侧唯一性声明无处落地。',
			'// [权衡] 保留完整类结构：与 PG 共用 utils.ts 的归集逻辑，删分支会让未来恢复时调用方 schema 作废。',
		]],
		[6, [
			'// [权衡] 拆成 unique() + .on() 只为贴近 SQL 读法；unique() 返回尚未绑定列的构建器。',
		]],
		[10, [
			'// 列级 .unique() 也调用本函数（columns/common.ts），但 Gel 侧该结果目前不会进入快照。',
		]],
		[29, [
			'\t// [失败路径] 不探测服务端能力：Gel 的快照里根本没有唯一约束，这个开关不会带来任何 DDL 变化。',
			'\t// [权衡] 保持可变字段 + 返回 this 的链式写法，与其余四方言构造签名一致，便于跨方言复制 schema。',
		]],
		[52, [
			'\t// [失败路径] 不校验列重复、空参与归属：即便将来接上序列化，重复列也会生成非法 UNIQUE。',
		]],
		[66, [
			'\t\t// [权衡] 名字构造期固化（类型仍写可选以统一接口）；Gel 侧该名字当前只存在于内存对象里。',
		]],
	],
	'drizzle-orm/src/gel-core/checks.ts': [
		[1, [
			'// 与 pg-core/checks.ts 同构，通用不变量见 INV-CKPG#01~#02；本文只标注 Gel 差异。',
			'// 差异：gelSerializer 里 checks 的写入分支整段被注释，最终写 checkConstraints: {}——本文件产出的 Check',
			'// 不进快照、不生成迁移语句，但 getTableConfig 仍会收集它。',
			'// 差异：Gel 没有 NO INHERIT 概念，本类也不暴露限制或延迟校验选项。',
			'// [失败路径] 因为约束被丢弃，value 的 SQL 文本错误在本方言完全静默：写错条件没有任何提示。',
			'// [权衡] 保留与 PG 一致的 name/value 形状：schema 文件可跨方言复制，代价是 Gel 侧只有声明没有效果。',
		]],
		[30, [
			'// [权衡] 薄工厂：不解析 SQL、不校验 name 重复——本方言的重复检测与渲染都已在 serializer 侧关闭。',
		]],
	],
};

for (const [rel, inserts] of Object.entries(plans)) {
	const file = path.join(ROOT, rel);
	const src = fs.readFileSync(file, 'utf8');
	const bom = src.startsWith('\uFEFF');
	const body = bom ? src.slice(1) : src;
	const lines = body.split('\r\n');
	const ordered = inserts.slice().sort((a, b) => b[0] - a[0]);
	for (const [ln, add] of ordered) {
		lines.splice(ln - 1, 0, ...add);
	}
	fs.writeFileSync(file, (bom ? '\uFEFF' : '') + lines.join('\r\n'), 'utf8');
	console.log(rel, '+', inserts.reduce((a, b) => a + b[1].length, 0));
}
