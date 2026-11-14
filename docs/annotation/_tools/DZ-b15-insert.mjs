// B15 一次性插入脚本：按「1-based 原始行号」在目标行之前插入整行 // 注释，倒序 splice，保持 CRLF。
import fs from 'node:fs';

const ROOT = 'D:/code/opensource/drizzle-orm/drizzle-orm/src/';
const T = '\t';
const DATA = {};

DATA['pg-core/foreign-keys.ts'] = {
	1: [
		'// pg 表级外键 DSL：foreignKey() 只收集「本表列 ↔ 外键表列」的配对与引用动作，不生成 SQL；',
		'// 真正的 DDL 由 drizzle-kit 的 CreateForeignKeyConvertor 以 ALTER TABLE ... ADD CONSTRAINT 追加。',
		'// 链路：table.ts 的 extraConfig → utils.ts getTableConfig 调 ForeignKeyBuilder.build →',
		'// pgSerializer 生成快照（以 getName() 为键）→ sqlgenerator 的 create_reference 分支。',
		'//',
		'// INV-fk#01：columns 与 foreignColumns 逐位对应且来自同一张表；foreignTable 只从',
		'//             foreignColumns[0].table 推断，混表时其余列名会被拼到错误的表上（守住：泛型 + reference）。',
		'// INV-fk#02：getName() 是快照与 diff 的唯一键；改表名/列名会改变默认约束名，drizzle-kit 因此判 drop + add。',
		'// INV-fk#03：外键一律以 ALTER TABLE 追加，建表顺序不影响成败，但被引用表必须已存在（守住：语句排序）。',
		'// INV-fk#04：onDelete/onUpdate 缺省为 no action，动作由数据库执行；set null 要求列可空、',
		'//             set default 要求列有默认值，此处不校验，违规在 DDL 或首次 DML 时才报错。',
		'// INV-fk#05：两列类型必须可比；类型不匹配由 PG 拒绝，本文件无运行时校验（守住：仅类型层约束）。',
	],
	6: [
		'// 动作词汇表：no action 与 restrict 在 PG 里只有 DEFERRABLE 场景才有差别，Drizzle 未暴露 deferrable。',
		'// set default 能被解析，但引用列没有 DEFAULT 时 CREATE 仍成功，首次 DELETE 才失败。',
	],
	8: [
		'// 惰性引用：每次求值返回新对象，两表互指（循环外键）因此在定义期不成问题。',
	],
	40: [
		T + T + T + '// [失败路径] foreignColumns 为空数组时此处对 undefined.table 取值，抛 TypeError；',
		T + T + T + '// 空数组能通过类型层的 TColumns 约束，属于运行期才暴露的调用错误。',
	],
	42: [
		T + T + '// [权衡] actions 存在时按字段直接赋值，显式传 onUpdate: undefined 会把默认 no action 覆盖成 undefined；',
		T + T + '// 而下面的 onUpdate()/onDelete() 会把 undefined 归一化回 no action，两个入口语义不一致。',
	],
	48: [
		T + '// [失败路径] 归一化只发生在这两个 setter：不传参落回 no action，不会被写成空动作。',
	],
	59: [
		T + '// 绑定表后返回不可变快照；builder → ForeignKey 是单向拷贝，之后改 builder 只影响尚未 build 的表。',
	],
	79: [
		T + '// 默认名按「本表_本列_外键表_外键列_fk」拼接，不含 schema；',
		T + '// 两个 schema 下的同名表会得到完全相同的默认名，快照以 name 为键而互相覆盖（INV-fk#02）。',
		T + '// 显式传 name 是避免跨 schema 冲突的唯一手段。',
	],
	89: [
		T + T + '// [失败路径] PG 标识符上限 63 字节，超长名由服务端静默截断，两个长名可能被截成同名而 diff 仍用原名。',
	],
	93: [
		'// 类型层把每个列约束到同一 tableName，运行时不再复查；目的是让混表在编译期报错，代价是要求至少一列。',
	],
	98: [
		'// 入口只接受对象形态；sqlite 版本为兼容保留了回调重载，pg 不背这个包袱。',
	],
	109: [
		T + '// [权衡] 延迟求值而非在定义期解构：立即求值会让循环外键在另一张表尚未构造时崩。',
	],
};

DATA['mysql-core/foreign-keys.ts'] = {
	1: [
		'// MySQL 表级外键 DSL。与 pg-core/foreign-keys.ts 同构，通用不变量见 INV-fk#01~#05，',
		'// 本文件只标注方言差异；DDL 终点是 mysqlSerializer 快照 + AlterTableAddForeignKey 分支。',
		'//',
		'// 族内映射（本文件 → 基准 INV → 差异）：',
		'//   ForeignKeyBuilder / Reference        → INV-fk#01 → foreignTable 同样只取 foreignColumns[0].table',
		'//   getName()                            → INV-fk#02 → 拼接规则逐字相同，约束名在库内唯一',
		'//   _onUpdate / _onDelete                → INV-fk#04 → 无初值，undefined 由 serializer 的 ?? no action 兜底',
		'//   build() / ForeignKey / foreignKey()  → INV-fk#03 → 产出 ALTER TABLE ... ADD CONSTRAINT ... FOREIGN KEY',
		'//   GetColumnsTableName                  → INV-fk#01 → 本文件额外导出的列名推导工具类型',
		'//',
		'// 方言差异：',
		'// - InnoDB 要求被引用列有索引（PRIMARY/UNIQUE 或普通索引），否则 errno 1822；本表列没有索引时',
		'//   MySQL 会隐式建一个，drizzle-kit 的快照看不到它，下次 diff 可能重复创建。',
		'// - 两列的类型、字符集、排序规则必须完全一致（errno 3780）；TEXT/BLOB 不能直接作外键列。',
		'// - set default 能通过 MySQL 解析器，但 InnoDB 直接拒绝（错误 1215），该动作实际不可用。',
	],
	6: [
		'// 动作词汇表与 pg 相同，但可用集合更小：InnoDB 只接受 RESTRICT/CASCADE/SET NULL/NO ACTION。',
	],
	22: [
		T + '// [失败路径] 与 pg 不同，这里没有 no action 初值：不传 actions 时两个字段都是 undefined，',
		T + '// 直到 mysqlSerializer 用 ?? no action 回填，快照才与 pg 对齐。',
	],
	40: [
		T + T + T + '// 与 pg 相同的非空断言：foreignColumns 为空会在 build 时抛 TypeError，类型层拦不住。',
	],
	42: [
		T + T + '// actions 按字段直接赋值，显式 undefined 会覆盖缺省；MySQL 侧没有 setter 归一化，最终由 serializer 兜底。',
	],
	48: [
		T + '// 不归一化 undefined：保留「未指定」与「显式 no action」的差别，差异留给 serializer 处理。',
	],
	59: [
		T + '// 绑定表后返回不可变快照；同一 builder 可被多张表 build，各自的 table 引用互不影响。',
	],
	73: [
		T + '// reference 存闭包引用，ForeignKey 始终读 config() 的最新结果；与 pg 一致。',
	],
	79: [
		T + '// 默认名与 pg 逐字相同；MySQL 约束名在 schema 内唯一，冲突在 DDL 期报 errno 1826。',
	],
	89: [
		T + T + '// MySQL 标识符上限 64 字符，超长默认名被服务端截断，而 diff 仍用未截断名。',
	],
	93: [
		'// 与 pg 相同的类型级同表约束；MySQL 额外要求字符集/排序规则一致，这一层无法用类型表达。',
	],
	98: [
		'// 工具类型：从列或列数组反推 tableName，供 drizzle-kit 与用户代码在不知道表类型时定位归属表。',
		'// 它是纯类型运算，没有运行时实现，因此不会出现在快照链路里。',
	],
	105: [
		'// 入口只接受对象形态；TForeignTableName 只参与类型约束，运行时不校验列真的属于该表。',
	],
};

DATA['sqlite-core/foreign-keys.ts'] = {
	1: [
		'// SQLite 表级外键 DSL。与 pg-core/foreign-keys.ts 同构，通用不变量见 INV-fk#01~#05，',
		'// 但 DDL 形态完全不同：外键只能写在 CREATE TABLE 内部，SQLite 没有 ALTER TABLE ADD CONSTRAINT。',
		'//',
		'// 族内映射（本文件 → 基准 INV → 差异）：',
		'//   ForeignKeyBuilder / Reference → INV-fk#01 → 无 schema，foreignTable 仍取 foreignColumns[0].table',
		'//   getName()                     → INV-fk#02 → 拼接规则相同；未命名时 drizzle-kit 用默认名做 diff 键',
		'//   onUpdate / onDelete           → INV-fk#04 → 动作名相同，SET DEFAULT 要求列有默认值',
		'//   build() / ForeignKey          → INV-fk#03 → 不生成 ALTER，而由 recreate 流程重建整表',
		'//   foreignKey() 双重载             → 无对应    → 兼容已废弃的回调形态',
		'//',
		'// 方言差异：',
		'// - 修改外键只能重建表：drizzle-kit 建新表 → 拷数据 → drop 旧表 → rename，索引与触发器一并重建。',
		'// - PRAGMA foreign_keys 默认 off 且按连接生效；Drizzle 不注入该 pragma，忘记开启时外键静默不校验。',
		'// - 被引用列必须是 PRIMARY KEY 或 UNIQUE，否则运行期报 foreign key mismatch；此处不做校验。',
		'// - 约束名只是可选的 CONSTRAINT 前缀，SQLite 不保证库内唯一，重名不会报错但会让 diff 失去依据。',
	],
	12: [
		'// 惰性引用：每次求值返回新对象，两表互指（循环外键）因此在定义期不成问题。',
	],
	15: [
		'// builder 只持有 config 回调与两个动作，未绑定表；同一 builder 可被多张表 build 成独立 ForeignKey。',
	],
	18: [
		T + '// brand 让 SQLite 的 builder 在类型层与 pg/mysql/gel 的同名类型不兼容，避免跨方言误用。',
	],
	26: [
		T + '// 与 pg 不同，这里没有 no action 初值；undefined 由 sqliteSerializer 的 ?? no action 回填。',
	],
	45: [
		T + T + T + '// [失败路径] foreignColumns 为空数组时此处对 undefined.table 取值，抛 TypeError；',
		T + T + T + '// 空数组能通过类型层的 TColumns 约束，属于运行期才暴露的调用错误。',
	],
	47: [
		T + T + '// actions 按字段直接赋值，不做归一化；undefined 与显式 no action 在此层不可区分。',
	],
	49: [
		T + T + T + '// 不归一化，保留「未指定」态；动作最终由 drizzle-kit 写成 ON DELETE/ON UPDATE 子句。',
	],
	53: [
		T + '// setter 同样不归一化，与构造器分支保持一致；两条入口的语义在 SQLite 上没有分叉。',
	],
	73: [
		T + '// 构造时把 builder 的三个字段拷贝成值；之后再改 builder 不会影响已建好的 ForeignKey。',
	],
	79: [
		T + '// 默认名规则与 pg 逐字相同，但 SQLite 的约束名不参与命名空间校验，重名只会让 diff 变模糊。',
	],
	89: [
		T + T + '// 显式 name 优先；未命名时依赖本表/本列/外键表/外键列的拼接结果，改任一段都会改变 diff 键。',
		T + T + '// SQLite 对标识符长度没有硬上限，这里不存在 pg 的 63 字节截断问题。',
	],
	93: [
		'// 与 pg 相同的类型级同表约束：让混表在编译期报错，运行时不复查。',
	],
};

DATA['gel-core/foreign-keys.ts'] = {
	1: [
		'// Gel 表级外键 DSL。与 pg-core/foreign-keys.ts 逐行同构，通用不变量见 INV-fk#01~#05。',
		'// 本文件只标注差异；Gel 侧最终产出的是 EdgeQL migration，而不是 SQL 的 ALTER TABLE。',
		'//',
		'// 族内映射（本文件 → 基准 INV → 差异）：',
		'//   ForeignKeyBuilder / Reference → INV-fk#01 → foreignTable 同样取 foreignColumns[0].table',
		'//   getName()                     → INV-fk#02 → 拼接规则与 pg 逐字相同，名字用作 migration 的 diff 键',
		'//   _onUpdate / _onDelete         → INV-fk#04 → 同样默认 no action，构建期行为与 pg 一致',
		'//   build() / ForeignKey          → INV-fk#03 → 约束顺序由 gelSerializer 决定，而非 SQL 语句排序',
		'//',
		'// 方言差异：',
		'// - Gel 的关系用 link 表达：link 自带基数（single/multi）与可选性，SQL 外键只有一个方向；',
		'//   单列外键可映射成 link，多列复合外键在 EdgeQL 里没有直接对应物。',
		'// - EdgeQL 没有 DEFERRABLE，动作只有 ON DELETE/ON UPDATE 的四种；set default 依赖属性的 default 表达式。',
		'// - gelSerializer 与 pgSerializer 同源，同样以约束名做键，重名会互相覆盖。',
	],
	6: [
		'// 动作词汇表复用 pg 的联合类型；未识别的动作由 serializer 原样透传，最终在 migration 执行期失败。',
	],
	18: [
		T + '// reference 在构造时才赋值，因此 builder 的公开形状与 config 回调用解耦。',
	],
	22: [
		T + '// 与 pg 相同：这里预置 no action，因此不传 actions 时也能拿到确定的默认动作。',
	],
	40: [
		T + T + T + '// 与 pg 相同的非空断言：foreignColumns 为空会在 build 时抛 TypeError。',
	],
	42: [
		T + T + '// actions 直接按字段赋值，显式 undefined 会覆盖默认值；下方 setter 又会归一化回 no action。',
	],
	48: [
		T + '// [失败路径] 归一化只在此处：保证 _onUpdate 永远是可序列化的字符串，而不是 undefined。',
	],
	59: [
		T + '// 绑定表后返回快照；Gel 的 table 只是 migration 输入，运行期查询不读 ForeignKey。',
	],
	73: [
		T + '// reference 存闭包引用；ForeignKey 的 onUpdate/onDelete 在构造时就被拷贝成值。',
	],
	79: [
		T + '// 默认名规则与 pg 逐字相同：本表_列_外键表_列_fk。',
	],
	93: [
		'// 与 pg 相同的类型级同表约束；Gel 侧同样没有运行时复查。',
	],
	98: [
		'// 入口只接受对象形态，config 被闭包捕获；循环外键因此能在两表都定义完后才求值。',
		'// [权衡] 若改为立即解构，Gel 的对象类型在定义顺序上更敏感，容易出现半初始化的表引用。',
	],
	101: [
		T + '// 泛型只约束 tableName，不约束列类型；Gel 的列类型检查发生在 columns 定义处。',
	],
	109: [
		T + '// mappedConfig 是薄包装：不复制列数组、不做校验，保证 builder 与 config 共享同一批列对象。',
	],
};

DATA['pg-core/indexes.ts'] = {
	1: [
		'// pg 索引 DSL：index()/uniqueIndex() 产出 IndexBuilderOn，.on()/.using() 把列快照成 IndexedColumn',
		'// 并产出 IndexBuilder；build() 绑定表后得到 Index，等待 getTableConfig 收集。',
		'// 链路：table extraConfig → getTableConfig 的 indexes 数组 → pgSerializer（以 index 名为键，',
		'// 表达式列要求显式 name，否则 process.exit(1)）→ PgCreateIndexConvertor 拼 CREATE [UNIQUE] INDEX。',
		'// INV-idx#01：columns 顺序即索引列顺序；每列的 asc/nulls/op 在 .on() 瞬间被快照，之后改列不再影响该索引。',
		'// INV-idx#02：索引名是快照唯一键；列索引的默认名由 drizzle-kit 推导，改名/改列会变成 drop + create。',
		'// INV-idx#03：表达式列（SQL）必须自带 name，否则 serializer 无法推导默认名并终止进程。',
		'// INV-idx#04：concurrently 生成的 CREATE INDEX CONCURRENTLY 不能在事务块内执行，migrate 事务会失败。',
		'// INV-idx#05：only 标志不被 pgSerializer 读取，ON ONLY 不会出现在 DDL 中（onOnly/using 与 on 等价）。',
		'// INV-idx#06：where 只对 pg/sqlite 有效；MySQL 无部分索引，兄弟文件没有该字段。',
		'// INV-idx#07：method/with 是原样透传的字符串，Drizzle 不校验方法名与存储参数键，错误在 DDL 期暴露。',
	],
	16: [
		T + '// unique 走 CREATE UNIQUE INDEX 而非 UNIQUE 约束：前者可带 WHERE，后者不能，两者生成的索引结构相同。',
	],
	21: [
		T + '// [失败路径] 标志原样进快照；若 drizzle-kit 把语句包在事务里（migrate 默认），PG 报 cannot run inside a transaction block。',
	],
	31: [
		T + '// 局部索引谓词：只索引满足条件的行。MySQL 兄弟文件没有该字段（无部分索引）。',
	],
	36: [
		T + '// 存储参数（fillfactor 等）原样拼进 WITH (...)；值不做引号处理，只适合标识符与数字字面量。',
	],
	48: [
		'// PgIndexMethod 与 PgIndexOpClass 都留了 (string & {}) 逃生舱：类型只做提示，不校验服务端是否存在该方法/操作符类，',
		'// 因此拼错不会在编译期报错，而是在 CREATE INDEX 时由 PG 拒绝。',
	],
	114: [
		T + '// [不变量] 三件事按顺序发生：先把列当前的 indexConfig 快照进 IndexedColumn，再把列复位，最后交给 IndexBuilder。',
		T + '// 若先复位再快照，.desc() 等修饰会丢失；若不复位，下一次 .on() 会重复带上本次修饰，',
		T + '// 造成「同一列在第二个索引里莫名 DESC」。',
	],
	121: [
		T + T + T + T + '// [权衡] 这里只替换列的 indexConfig 指针，没有深拷贝那个快照对象：',
		T + T + T + T + '// IndexedColumn 拿走的是旧对象，列随后指向新对象，二者不共享可变状态，深拷贝是多余开销。',
	],
	131: [
		T + '// [失败路径] onOnly 与 on 的代码差异是 only=true 和复位方式；复位直接指向 defaultConfig 本体，',
		T + '// 之后对该列调用 .desc() 会连默认值一起改掉，下一次索引从被污染的默认值起步。',
	],
	159: [
		'	// using 把 only 也置为 true（IndexBuilder 第 3 个参数），但 pgSerializer 不读 only，',
		'	// 所以 ON ONLY 不会出现在生成的 DDL 里；分区父表的索引仍会递归到子表。',
	],
	186: [
		'// 声明合并让 is(builder, IndexBuilder) 守卫与 AnyIndexBuilder 约束指向同一个类型。',
	],
	199: [
		T + T + '// 默认 btree；method 参与快照比较，改方法等于重建索引。',
	],
};

DATA['mysql-core/indexes.ts'] = {
	1: [
		'// MySQL 索引 DSL。与 pg-core/indexes.ts 同构，通用不变量见 INV-idx#01~#07，这里只写差异。',
		'// 映射：IndexBuilderOn.on → INV-idx#01（列顺序即索引列序）；build → INV-idx#02（name 为快照键）；',
		'//       using/algorithm/lock → 无基准对应，MySQL 专属 DDL 提示。',
		'// 差异：name 必填（无法推导默认名）；无 where/concurrently/only/with；无 INCLUDE 覆盖列。',
	],
	6: [
		'// name 必填而非可选：drizzle-kit 以 name 做快照键，匿名索引无法 diff；这是与 pg 类型的最大差异。',
	],
	32: [
		'// IndexColumn 允许 SQL 表达式：MySQL 8.0.13+ 的函数索引要求双括号，sqlgenerator 原样输出，括号需用户自己写。',
	],
	65: [
		T + '// [失败路径] using/algorithm/lock 只写进快照，CreateMySqlIndexConvertor 只取 name/columns/isUnique，三者不会出现在 CREATE INDEX 文本里。',
	],
};

DATA['sqlite-core/indexes.ts'] = {
	1: [
		'// SQLite 索引 DSL。与 pg-core/indexes.ts 同构，通用不变量见 INV-idx#01~#07，这里只写差异。',
		'// 映射：IndexBuilderOn.on → INV-idx#01；IndexBuilder.where → INV-idx#06（部分索引）；',
		'//       build → INV-idx#02（name 是快照键）；无 using/only/concurrently/with 对应字段。',
		'//',
		'// 差异：',
		'// - 命名空间：SQLite 的索引名与表、视图、触发器共用 sqlite_master 的 schema 级命名空间，',
		'//   两张表不能有同名索引；显式 UNIQUE 约束自动生成的 sqlite_autoindex_* 也占用该空间。',
		'// - 部分索引自 3.8.0 起支持，where 由 CreateSqliteIndexConvertor 直接拼到语句尾部。',
	],
	6: [
		'// where 必定存在（构造时置 undefined），与 pg 的可选字段不同；序列化时用 !== undefined 判定。',
	],
	13: [
		'// IndexColumn 允许 SQL 表达式，但 SQLite 只有在查询里出现同一表达式时才会用该索引。',
	],
	28: [
		T + '// brand 让 SQLite 的 builder 与 pg/mysql/gel 的同名类型在类型层不兼容。',
	],
	47: [
		T + '// 部分索引谓词只能引用本表列，且不能包含子查询/聚合；服务端不校验，建索引时才报错。',
	],
	58: [
		'// Index 只是 config + table 的浅合并；真正生成 CREATE INDEX 的语句在 drizzle-kit 侧。',
	],
};

DATA['gel-core/indexes.ts'] = {
	1: [
		'// Gel 索引 DSL。与 pg-core/indexes.ts 逐行同构，通用不变量见 INV-idx#01~#07，这里只写差异。',
		'// 映射：IndexBuilderOn.on/onOnly/using → INV-idx#01/#02/#05；IndexBuilder.where → INV-idx#06；',
		'//       build → INV-idx#02（name 是 migration 快照键）。',
		'//',
		'// 差异：',
		'// - 目标产物是 EdgeQL migration，不是 CREATE INDEX；索引在 Gel 里表达为对象类型的 index on (...) 子句。',
		'// - GelIndexMethod 里的 sGelist 是 pg 分支 spgist 做机械文本替换时的残留，两边都没有该方法名，',
		'//   传入会原样进快照并在 migration 执行期失败；应写 gist。',
		'// - Gel 没有分区表，onOnly 的 only 维度没有语义（且 serializer 都不读 only）。',
		'// - 无并发建索引：Gel 的 schema migration 是原子的，concurrently 会被丢弃。',
		'// - 操作符类在 Gel 侧依赖标量类型，pg 的 opclass 名称不保证存在。',
		'//',
		'// 与 pg 相同的既有行为一并保留：onOnly 把列复位到 defaultConfig 本体而非拷贝。',
	],
	46: [
		'// 方法白名单含 (string & {})：Gel 的索引方法由后端扩展决定，这里只做 IDE 补全。',
	],
	117: [
		'// builder-on 只在 on/onOnly/using 时才接触列，因此同一 IndexBuilderOn 可复用于多个索引。',
	],
	122: [
		T + '// [不变量] 快照顺序：先复制列当前的 indexConfig 生成 IndexedColumn，再把列复位为 defaultConfig 的深拷贝。',
		T + '// 深拷贝（JSON 往返）保证快照对象与列之后的修改彻底脱钩；代价是 indexConfig 只能是 JSON 可表达的值。',
		T + '// 复位过晚会让修饰泄漏到下一个索引，过早则丢掉本次的 asc/nulls/op。',
	],
	139: [
		T + '// onOnly 与 on 的差异只有 only 标志与复位方式；这里复位到 defaultConfig 本体，',
		T + '// 后续对该列 .desc() 会改坏默认值，是 pg 同源代码里一并继承的行为。',
	],
	167: [
		'	// using 同时把 only 置为 true，但 only 不进快照 → 实际效果与 on 等价，method 才是唯一差异。',
		'	// 方法名不做校验，拼错要等到 migration 执行时才暴露（INV-idx#07）。',
	],
	189: [
		'// 声明合并：interface 与 class 同名，使 IndexBuilder 天然满足 AnyIndexBuilder，is() 守卫也能正确收窄。',
	],
	207: [
		T + T + '// 默认 btree；method 参与快照 diff，改方法等于重建索引。',
	],
	218: [
		T + '// 链式修改直接写 config；IndexBuilder 在 build 之前可变，build 之后不应再复用。',
	],
	228: [
		T + '// where 是 SQL 对象，序列化时由 gelSerializer 用 sqlToQuery 展平，参数被内联成字面量。',
	],
	234: [
		T + '// build 把 config 与 table 合并成新对象；Index 上的 config 是快照，不再与 builder 共享。',
	],
	239: [
		'// Index 的 config 带 table，便于 serializer 反查表名与 schema，不依赖外部上下文。',
	],
	249: [
		'// 列名推导只用于类型层：GetColumnsTableName 在运行时不存在。',
		'// [权衡] 与 pg 相同地要求 columns 为非空元组，避免生成没有列的索引。',
	],
	253: [
		'// 两个入口只差 unique；name 可选，但表达式列仍要求显式 name（serializer 无法推导）。',
	],
};

DATA['pg-core/policies.ts'] = {
	1: [
		'// pg 行级安全（RLS）策略 DSL：pgPolicy() 直接产出 PgPolicy 实例而不是 builder，',
		'// 由 table extraConfig 收集或被 policy.link(table) 关联，最终在 pgSerializer 里转成快照的 policies。',
		'// 链路：getTableConfig 的 policies → pgSerializer（重名即 process.exit(1)，未 link 则打印 warning 并跳过）→',
		'// sqlgenerator 的 create_policy 分支拼 CREATE POLICY ... AS ... FOR ... TO ... USING ... WITH CHECK。',
		'// 注意：策略只有在表的 RLS 被打开（table.enableRLS()）后才生效，本文件不承载该开关。',
		'// INV-pol#01：策略名在 (schema, table) 内唯一；重名会让 serializer 直接终止整个进程，而不是抛错。',
		'// INV-pol#02：to 里的 PgRole 取 .name，其余字符串原样进 TO 子句，不做标识符转义。',
		'// INV-pol#03：using 是读谓词，withCheck 是写谓词；序列化时参数被内联，策略体不能带绑定参数。',
	],
	15: [
		'// for 覆盖 all/select/insert/update/delete，all 是缺省值，由 serializer 用 ?? ALL 补齐。',
	],
	26: [
		T + '// readonly 字段用 PgPolicyConfig[...] 取值类型而非 boolean，保留 undefined 这个「未指定」态。',
	],
	33: [
		T + '// _linkedTable 不参与快照字段，只用于 serializer 判断「这条策略属于哪张表」。',
	],
	39: [
		T + T + '// config 整体可选：不传时全部字段保持 undefined，符合 strictPropertyInitialization 的豁免条件。',
	],
	48: [
		T + '// link 是唯一的表关联入口，返回 this 以便链式；重复 link 会覆盖前一次，serializer 只看到最后一次。',
		T + '// [失败路径] 忘记 link 且未放进 extraConfig 时不报错，只在 drizzle-kit 输出里留一条 warning。',
	],
};

DATA['gel-core/policies.ts'] = {
	1: [
		'// Gel 策略 DSL。与 pg-core/policies.ts 逐行同构，通用不变量见 INV-pol#01~#03，这里只写差异。',
		'// 映射：GelPolicy → INV-pol#01（name 为表内键）；to → INV-pol#02（GelRole 取 name）；',
		'//       using/withCheck → INV-pol#03（参数内联）；link → 无基准对应，仅用于归属判定。',
		'//',
		'// 差异：',
		'// - Gel 没有 SQL 的 RLS：访问规则由 schema 的 expression/permission 表达，本类是 pg 分支的机械复制，',
		'//   gelSerializer 虽读取 policies 并做同样的重名检查，最终 migration 是否落地权限取决于后端。',
		'// - Gel 的 current_user/current_role 等关键字沿用 pg 词汇，实际解析由 EdgeQL 侧完成。',
	],
	15: [
		'// for/as 的可选集合与 pg 相同；缺省值同样由 serializer 用 ?? ALL/PERMISSIVE 补齐。',
		'// 在 Gel 侧这两个字面量最终被映射成 permission 的读写方向，而不是 DDL 关键字。',
	],
	26: [
		T + '// readonly 字段保留 undefined 表示「未指定」；Gel 侧同样用 ?? 兜底，因此 null 与 undefined 不等价。',
	],
	33: [
		T + '// _linkedTable 只在 serializer 的归属判定里使用，不进入快照。',
	],
	48: [
		T + '// link 返回 this 以便链式，重复 link 覆盖前值；Gel 侧与 pg 相同，忘记 link 只产生 warning。',
		T + '// [失败路径] 策略声明了但没挂到任何表上时，migration 静默少一条，不会报错。',
	],
};

DATA['pg-core/roles.ts'] = {
	1: [
		'// pg 角色 DSL：pgRole() 产出 PgRole，仅作为 drizzle-kit 配置（schema 的 roles 导出）的输入，',
		'// 不参与表定义；pgSerializer 以 name 为键生成 roles 快照，供 CREATE ROLE / GRANT 使用。',
		'// INV-role#01：name 是唯一键，重复定义后写覆盖先写，serializer 不做重复检测。',
		'// INV-role#02：existing() 跳过 CREATE ROLE 但仍参与授权；漏标会重复建角色并报错。',
		'// INV-role#03：createDb/createRole/inherit 三态：undefined 用服务器默认，true/false 显式写 YES/NO。',
		'// [失败路径] 本类无 build/link，误放进 table extraConfig 会被 getTableConfig 的 else-if 链静默丢弃。',
	],
};

DATA['gel-core/roles.ts'] = {
	1: [
		'// Gel 角色 DSL。与 pg-core/roles.ts 逐行同构，通用不变量见 INV-role#01~#03，这里只写差异。',
		'// 映射：GelRole → INV-role#01（name 唯一）；existing() → INV-role#02（跳过 CREATE）；',
		'//       createDb/createRole/inherit → INV-role#03（三态）。',
		'// 差异：Gel 的 role 与 database 权限模型和 pg 不同，createDb 等标志是机械同构；',
		'// gelSerializer 同样以 name 为键，但最终语句由 Gel migration 生成，而非 SQL 的 CREATE ROLE。',
		'// [失败路径] 无 build/link，误放进 extraConfig 会被 getTableConfig 的 else-if 链静默丢弃。',
	],
};

DATA['pg-core/sequence.ts'] = {
	1: [
		'// pg 序列 DSL：pgSequence() 只保存名字、选项与 schema，不产生任何 SQL；',
		'// 序列通常作为列默认值 nextval(...) 的依赖，由 drizzle-kit 配置里的 sequences 导出收集。',
		'// 链路：pgSerializer 的 sequencesToReturn（键为 schema.name，缺 schema 记 public）→ create_sequence 语句。',
		'// INV-seq#01：选项全部 number|string，字符串用于 bigint 级数值，避免 JS 精度丢失；原样进快照。',
		'// INV-seq#02：seqName 允许 undefined，但 serializer 用 seqName! 取值，缺名会在序列化期抛错。',
		'// INV-seq#03：schema 为 undefined 时按 public 处理；同名序列在不同 schema 下是不同对象。',
	],
	12: [
		'// 类只做数据携带，没有 build/link；类型、范围等校验都推迟到 PostgreSQL 执行 CREATE SEQUENCE。',
	],
	15: [
		T + '// 三个 public readonly 字段就是快照契约；改字段名等于改 drizzle-kit 的读取协议。',
	],
	23: [
		'// 无 schema 的入口转调 WithSchema 版本并显式传 undefined，避免复制构造逻辑。',
	],
	39: [
		'// is() 按 entityKind 判定，使跨包（drizzle-orm 与 drizzle-kit 各自打包）的实例仍能正确识别。',
	],
};

DATA['gel-core/sequence.ts'] = {
	1: [
		'// Gel 序列 DSL。与 pg-core/sequence.ts 逐行同构，通用不变量见 INV-seq#01~#03，这里只写差异。',
		'// 映射：GelSequence → INV-seq#01（选项原样保存）；seqName → INV-seq#02（serializer 用非空断言）；',
		'//       schema → INV-seq#03（undefined 视为默认 schema）。',
		'// 差异：Gel 的自增由 id 的 global 计数器/序列对象表达，pg 的 nextval 语义不完全对应；',
		'// 选项名（increment/minValue/cache/cycle）沿用 pg 词汇，映射到 EdgeQL 由 serializer 负责。',
		'// [失败路径] 缺名与 pg 一样在序列化期抛错，本类不做前置校验。',
	],
	12: [
		'// 纯数据载体：Gel 的 migration 生成器读取这些字段，DDL 校验发生在后端。',
	],
	15: [
		T + '// public readonly 字段即快照契约，改名等于改 drizzle-kit 的读取协议。',
	],
	23: [
		'// 无 schema 入口转调 WithSchema 版本；Gel 的默认 schema 由连接配置决定，不是硬编码的 public。',
	],
	39: [
		'// is() 按 entityKind 判定，跨包实例仍可识别。',
	],
};

const rels = Object.keys(DATA);
const BASE = 'd:/code/_annot_baseline/B15/orig/drizzle-orm/src/';
for (const rel of rels) {
	const file = ROOT + rel;
	const text = fs.readFileSync(file, 'utf8');
	const eol = text.includes('\r\n') ? '\r\n' : '\n';
	// 幂等：先移除「不在 baseline 中的整行注释」（即本脚本此前插入的行），校验回落到 baseline，再一次性插入。
	const base = fs.readFileSync(BASE + rel, 'utf8');
	const baseSet = new Set(base.split(eol));
	const lines = text.split(eol).filter((l) => !(l.trim().startsWith('//') && !baseSet.has(l)));
	if (lines.join(eol) !== base) throw new Error(`${rel}: reset mismatch`);
	const anchors = Object.keys(DATA[rel]).map(Number).sort((a, b) => b - a);
	let n = 0;
	for (const a of anchors) {
		if (!Number.isInteger(a) || a < 1 || a > lines.length + 1) throw new Error(`${rel}: bad anchor ${a}`);
		const block = DATA[rel][a];
		lines.splice(a - 1, 0, ...block);
		n += block.length;
	}
	fs.writeFileSync(file, lines.join(eol), 'utf8');
	console.log(`${rel}\t+${n}`);
}
