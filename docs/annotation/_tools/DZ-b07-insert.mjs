// B07：为 drizzle-orm/src/mysql-core/dialect.ts 插入整行中文注释（基准文件）。
// 用法：node DZ-b07-insert.mjs [--dry]
import fs from 'node:fs';

const target = 'd:/code/opensource/drizzle-orm/drizzle-orm/src/mysql-core/dialect.ts';
const T = '\t';

const header = [
	'// MySQL 方言 SQL 生成器：把 query-builder 组装的配置对象翻译成「SQL 文本 + 参数序列」。',
	'//',
	'// 链路位置：query-builders/{select,insert,update,delete}.ts 产出 MySqlSelectConfig 等配置 →',
	'// MySqlSession（session.ts）在 prepare/execute 前调用本类的 build*Query → 得到 SQL AST →',
	'// sqlToQuery 调 SQL.toQuery 展平成 `?` 占位符文本与 params，交给驱动绑定执行。',
	'// 本文件不持有连接、不读时钟、不缓存执行结果；唯一的产出是确定性的 SQL 片段。',
	'//',
	'// 同构性：本文件是 pg / sqlite / singlestore / gel 各方言 dialect.ts 的基准，下列 INV 为族内',
	'// 通用不变量；兄弟文件只需在文件头写「本文件函数 → 基准 INV 编号 → 差异点」映射，不复制本文。',
	'//',
	'// INV-01：相同的 schema 与配置必须得到逐字节相同的 SQL 与参数顺序；构建期禁止引入时钟、',
	'//         随机数、全局自增（守住它的位置：全部 build*Query）',
	'// INV-02：占位符恒为 `?`，文本中第 n 个 `?` 对应 params[n]；escapeParam 忽略编号，因为 MySQL',
	'//         只按位置绑定（守住它的位置：escapeParam / sqlToQuery）',
	'// INV-03：选择列表的输出顺序严格等于 fieldsFlat 的顺序，解码端按同一顺序取值；重排会让结果列错位',
	'//         （守住它的位置：buildSelection）',
	'// INV-04：`returning` 是否出现只由 config 决定，dialect 不做能力探测；服务端是否接受该语法',
	'//         由 session/驱动承担（守住它的位置：buildDeleteQuery / buildUpdateQuery）',
	'// INV-05：只有无 join 的单表查询才允许列不带表限定；有 join 时所有列必须带表名，否则同名列歧义',
	'//         （守住它的位置：buildSelectQuery 的 isSingleTable 判定）',
	'// INV-06：WITH 前缀只由 buildWithCTE 生成，且必须位于语句最前；嵌套子查询不得自带 WITH，',
	'//         否则产生 `with ... (with ...)` 语法错误（守住它的位置：buildWithCTE 与各拼接顺序）',
	'// INV-07：relational query 中关系别名恒为 `${tableAlias}_${tsKey}`，join 的 Subquery.alias 与',
	'//         引用它的 `${alias}.data` 必须字面一致；别名重复会读到另一张表',
	'//         （守住它的位置：buildRelationalQuery 的 relationTableAlias）',
	'// INV-08：One 关系递归时必须强制 limit 1，否则 json_arrayagg 折叠多行，运行时得到数组而非对象',
	'//         （守住它的位置：两套 relational 实现里递归处的 queryConfig 归一化）',
	'// INV-09：只有 sqlToQuery 能产出最终占位符文本；sql.raw 片段不参与参数编号，故不得拼用户输入',
	'//         （守住它的位置：sqlToQuery 与全部 sql.raw 调用点）',
	'// INV-10：锁子句只允许出现在最外层 SELECT 尾部；子查询携带 FOR UPDATE 会扩大锁定范围',
	'//         （守住它的位置：buildSelectQuery 的 lockingClause 段）',
	'//',
	'// 标记约定：[失败路径] 标注抛错点与静默错误的边界；[权衡] 标注「看起来可以更简单」的选择；',
	'// [事务] 只出现在 migrate（MySQL 的 DDL 隐式提交，事务边界需单独说明）；',
	'// 本文件不持有连接/文件/语句句柄，故无 [资源] 标记。',
	'//',
	'// 两套 relational 编译实现：buildRelationalQuery 用 LATERAL join（8.0.14+），',
	'// buildRelationalQueryWithoutLateralSubqueries 用相关子查询（PlanetScale 模式）。除 join 形态外',
	'// 步骤逐段同构，修改其中一套时必须同步另一套。',
	'//',
	'// 族内差异速查（兄弟文件仍需逐条写映射，本表只作索引）：',
	'// - pg：占位符 `$n`、原生 RETURNING / ON CONFLICT / FOR UPDATE SKIP LOCKED，构建期无需回填 id',
	'// - sqlite：占位符 `?`、3.35+ 支持 RETURNING、ON CONFLICT，无索引提示与 LATERAL',
	'// - singlestore：无 LATERAL，relational 固定走 WithoutLateralSubqueries 路径',
	'// - gel：产出 edgeql 而非 SQL 文本，build*Query 整体重写，仅 INV-01/03/07/08 可直接沿用',
];

const anchors = [
	[1, header],
	[40, [
		T + '// 方言配置只有 casing：标识符大小写策略，构造时固化，之后所有输出都走同一份缓存；',
		T + '// 连接参数、SQL mode 等运行期差异不在这里感知，故本类可同步构造。',
	]],
	[44, [
		T + '// 方言实例由 MySqlDatabase 单例持有，生命周期与连接池相同；除 casing 外无可变状态，',
		T + '// 因此可被并发的多次查询复用而无需同步。',
	]],
	[47, [
		T + '// casing 构造后只读，build* 中可自由读取，不必考虑缓存失效。',
	]],
	[50, [
		T + '// 只装配 CasingCache，不做 I/O；构造函数无副作用，方言才能被安全地提前创建。',
	]],
	[54, [
		T + '// 执行迁移：按 folderMillis 顺序运行尚未落库的 MigrationMeta，并登记到迁移记录表。',
		T + '// 输入：session 是已连接的 MySqlSession；migrations 由 migrator 预排序。',
		T + '// 副作用：只写数据库，不返回值；错误原样上抛，由调用方决定是否终止启动。',
	]],
	[59, [
		T + '// 记录表名可配置；后续所有引用都走 sql.identifier，避免表名中的特殊字符破坏语句。',
	]],
	[60, [
		T + '// [事务] 建表用 if not exists 保证幂等：上次迁移若在登记前崩溃，重跑会再次执行到这里。',
		T + '// 代价是表结构不做版本校验，字段变更需用户自行处理。',
	]],
	[67, [
		T + '// STEP-1 先建表再读记录；顺序反了会在空库上抛「表不存在」。',
	]],
	[69, [
		T + '// STEP-2 只取 created_at 最大的一条：进度定义为「已执行的最大 folderMillis」，',
		T + '// 不逐条比对 hash，因此重命名历史迁移文件不会触发重放。',
	]],
	[77, [
		T + '// 空表时 lastDbMigration 为 undefined，下面的判断自然退化为「全部执行」。',
	]],
	[79, [
		T + '// [事务] 所有待执行迁移共用一个 session.transaction。MySQL 的 DDL 会隐式提交，',
		T + '// 故这里的原子性只覆盖记录表插入：某条 DDL 成功而登记失败时，重跑会再次执行该迁移，',
		T + '// 因此迁移脚本自身必须幂等 —— 这是本方言与 pg 事务型 DDL 的关键差异。',
	]],
	[81, [
		T + '// 用严格小于比较而非不等：乱序或重复传入 migrations 时不会倒退执行旧迁移。',
	]],
	[85, [
		T + '// STEP-3 单条迁移内的语句按数组顺序执行，顺序即语义（先建表后建索引）；',
		T + '// sql.raw 表示迁移文本是受信输入，不做参数化。',
	]],
	[88, [
		T + '// STEP-4 先执行后登记：崩溃在登记前只会导致重放，而不会把未执行的迁移标记成已完成。',
	]],
	[100, [
		T + '// 标识符转义：反引号包裹，内部反引号双写。只用于 identifier —— 字符串字面量走 escapeString，',
		T + '// 两者规则不同，混用会造成注入或语法错误。',
	]],
	[104, [
		T + '// [权衡] 丢弃 `_num` 返回常量 `?`：MySQL 按位置绑定，params 的顺序即 `?` 的出现顺序。',
		T + '// 与 pg 的 `$n` 相比少一层编号映射，但要求 toQuery 绝不跳过或重排参数。',
	]],
	[108, [
		T + '// 字符串字面量转义：单引号双写。仅用于必须内联的少数场景；普通值一律参数化，',
		T + '// 因为 NO_BACKSLASH_ESCAPES 等 SQL mode 会改变反斜杠语义，内联拼接不可移植。',
	]],
	[112, [
		T + '// 生成 `with a as (...), b as (...) ` 前缀；无 withList 时返回 undefined，',
		T + '// SQL 模板会跳过 undefined 分片，因此调用方可以直接插值而不必判空。',
	]],
	[115, [
		T + '// STEP-1 以 `with ` 开头、以空格收尾，使后续 select/delete 不与 `)` 粘连。',
	]],
	[116, [
		T + '// 别名走 sql.identifier，保证 CTE 名与内部引用在同一 casing 策略下渲染。',
	]],
	[126, [
		T + '// 拼装 DELETE：with → delete from → where → order by → limit → returning。',
		T + '// ORDER BY / LIMIT 是 MySQL 的方言扩展，顺序错了即语法错误。',
		T + '// 纯拼接函数，不校验 where：空 where 即全表删除，责任在 query-builder。',
	]],
	[134, [
		T + '// STEP-1 WITH 必须最前；子查询若自带 WITH 会形成嵌套 CTE（INV-06）。',
	]],
	[136, [
		T + '// STEP-2 DELETE 只能针对单表，列不加表限定；returning 是否被接受由驱动决定（INV-04）。',
	]],
	[140, [
		T + '// STEP-3 三个可空子句各自独立，插值自动省略。',
	]],
	[146, [
		T + '// 片段顺序即语义：互换任意两项都会产出非法 SQL 或改变影响行数。',
	]],
	[149, [
		T + '// 生成 `col = value, col2 = value2`；列的选取 = 显式出现在 set 中的列 + 定义了',
		T + '// onUpdateFn 的列（如 updatedAt 自动续期）。',
	]],
	[150, [
		T + '// 读表元数据还原列对象：set 里只有 TS 键，casing 与类型信息只能从表定义取。',
	]],
	[152, [
		T + '// [权衡] 过滤掉 undefined 而不生成 `col = default`：undefined 表示「不更新」，',
		T + '// null 表示显式置空；合并两者会让用户无法表达「保留原值」。',
	]],
	[158, [
		T + '// STEP-1 先算总列数，用索引判断是否追加分隔符，避免 join 后再裁字符串。',
	]],
	[163, [
		T + '// STEP-2 onUpdateFn 可能返回 SQL（如 sql`now()`）或普通值：前者直接拼接，',
		T + '// 后者用列对象参数化，保证写回编码与列类型一致。',
	]],
	[170, [
		T + '// STEP-3 分隔符用 sql.raw(", ")：纯结构片段，不参与参数编号（INV-09）。',
	]],
	[178, [
		T + '// 拼装 UPDATE，片段顺序同 DELETE；where 缺省即全表更新，dialect 不拦截。',
	]],
	[187, [
		T + '// STEP-1 set 子句必须由 buildUpdateSet 生成：列顺序即参数顺序，规则不能两处维护。',
	]],
	[201, [
		T + '// limit/orderBy 是 MySQL 多表更新的扩展语法，置于 where 之后、returning 之前。',
	]],
	[215, [
		T + '// 渲染逗号分隔的选择列表，SELECT 与 RETURNING 共用。',
		T + '// 输入 fields 是已排序的 { path, field } 数组，顺序即输出列序（INV-03）。',
		T + '// 副作用：Subquery 分支会就地写入 decoder（见下）。',
	]],
	[219, [
		T + '// STEP-1 用列数判断分隔符，保证最后一项之后没有逗号。',
	]],
	[224, [
		T + '// 已标记为选择字段的 SQL.Aliased 直接输出别名，不再包一层 as，避免 `x as x`。',
	]],
	[229, [
		T + '// STEP-2 单表时把表达式里的列降级为不带表名的标识符（INV-05）：RETURNING/单表 SELECT',
		T + '// 里带表前缀在 MySQL 下会与别名解析冲突。',
	]],
	[244, [
		T + '// 表达式原样输出；SQL.Aliased 补 `as identifier`，别名同样需转义。',
	]],
	[247, [
		T + '// 裸列：单表只输出列名（走 casing），多表输出列对象由模板展开为 `table`.`column`，',
		T + '// 因此多表时必须保留列对象而不是先转字符串。',
	]],
	[254, [
		T + '// 子查询字段：若子查询只选出一列，把该列 decoder 挂到子查询 SQL 上，',
		T + '// 使外层结果仍按正确类型解码，而不是透出驱动的原始值。',
	]],
	[259, [
		T + '// [权衡] 只在恰好一列时继承 decoder：多列子查询各列类型可能不同，',
		T + '// 一个 decoder 无法表达，选择放弃而不是猜一个。',
	]],
	[268, [
		T + '// 就地写入是有意的副作用：Subquery 在本函数中只被消费一次，复制会让调用方拿不到 decoder。',
	]],
	[275, [
		T + '// STEP-3 追加分隔符，保持与 fields 顺序一致。',
	]],
	[285, [
		T + '// 生成 ` limit n`；负数哨兵表示「无 limit」需省略，Placeholder 走对象分支交给运行期填充。',
	]],
	[292, [
		T + '// 生成 ` order by a, b`；空数组与 undefined 等价，整段省略。',
	]],
	[300, [
		T + '// 索引提示：`use/force/ignore index (...)`。',
		T + '// [权衡] 表名与索引名用 sql.raw：索引提示的语法差异（别名、schema）由调用方保证，',
		T + '// 这里只做前缀分派，避免对同一名称重复转义。',
	]],
	[312, [
		T + '// SELECT 主装配点：输入 MySqlSelectConfig，输出完整 SQL AST，是本文件最大的纯函数。',
		T + '// 输入：fields/fieldsFlat、table（表/子查询/视图）、joins、where/having/groupBy/orderBy、',
		T + '//       limit/offset、distinct、setOperators、索引提示、lockingClause。',
		T + '// 输出：SQL；唯一副作用是抛错（字段引用了未 join 的表）。',
	]],
	[331, [
		T + '// fieldsFlat 已由 query-builder 排好序；只有动态构建（relational query）才需在此临时排序。',
	]],
	[332, [
		T + '// [失败路径] 构建期校验「字段所属表是否参与查询」，而不是让数据库报 Unknown column：',
		T + '// 这里的错误能给出关系路径与缺失表名，是最常见的误用。',
		T + '// 别名 join 表是唯一豁免：它按 alias 与 BaseName/OriginalName 双向比对。',
	]],
	[352, [
		T + '// [失败路径] 抛普通 Error：这是使用错误（代码 bug），需完整暴露 path，不做驱动层包装。',
	]],
	[363, [
		T + '// STEP-1 单表判定：无 join 才允许省略表限定；子查询/视图作主表同样按单表处理。',
	]],
	[365, [
		T + '// STEP-2 WITH 前缀先于 select（INV-06）。',
	]],
	[367, [
		T + '// distinct 必须紧跟 select，且在列之前。',
	]],
	[369, [
		T + '// STEP-3 列序在此固化（INV-03），后续不再调整 selection 内部结构。',
	]],
	[371, [
		T + '// 别名主表需输出 `schema.原表名 as 别名`；非别名表直接交给模板展开。',
	]],
	[383, [
		T + '// join 片段逐条累积：joinType 由 query-builder 保证合法，用 raw 拼；表名/别名仍走 identifier。',
	]],
	[391, [
		T + '// LATERAL 仅在明确要求时启用：MySQL 8.0.14+ 才支持，旧版本执行期报错。',
	]],
	[394, [
		T + '// [权衡] 表 / 视图 / 任意 SQL 三种 join 源分三条分支：元数据来源不同（符号、ViewBaseConfig、',
		T + '// 模板），合并会让符号访问与别名判断难以读对。',
		T + '// 视图分支无索引提示（视图上不能指定索引）。',
	]],
	[399, [
		T + '// 索引提示紧跟表引用、位于别名之前，这是 MySQL 的语法要求。',
	]],
	[441, [
		T + '// STEP-4 子句按语法顺序拼接，每个片段独立判空。',
	]],
	[447, [
		T + '// group by 在 having/order by 之前；源码顺序与语法顺序保持一致，便于对照。',
	]],
	[453, [
		T + '// offset 用真值判断（0 视为无 offset），与 buildLimit 的负数哨兵不同。',
	]],
	[467, [
		T + '// STEP-5 noWait 与 skipLocked 互斥，先判 noWait 使语义确定。',
	]],
	[478, [
		T + '// 最终顺序即语法：with → select/distinct → 列 → from/索引提示 → join → where →',
		T + '// group by → having → order by → limit → offset → 锁。',
	]],
	[481, [
		T + '// STEP-6 集合运算包裹整条 select，不能只包 from 之后的部分，否则 UNION 优先级出错。',
	]],
	[488, [
		T + '// 把 setOperators 折叠成左深树 ((A union B) union C)。',
		T + '// [权衡] 用递归而非 reduce：每一步都要对累积结果重新加括号并生成新 SQL，',
		T + '// 递归让「左侧已定型」在类型与结构上都显式。',
	]],
	[494, [
		T + '// [失败路径] undefined 说明调用方漏填元素（通常是可选值直接入数组）；',
		T + '// 静默跳过会少一个分支，宁可在此抛错。',
	]],
	[498, [
		T + '// 递归终点：只剩一个操作符时直接生成单层，不再包多余括号。',
	]],
	[509, [
		T + '// 生成单层 `(左) union [all] (右) order by ... limit ... offset ...`。',
		T + '// 两侧先 getSQL() 再手动加括号：MySQL 要求集合运算的操作数是被括号包裹的查询块。',
	]],
	[516, [
		T + '// 即使只有一条语句也强制括号，这是唯一能让 order by/limit 归属明确的形式。',
	]],
	[519, [
		T + '// order by 属于整个集合运算而非某一侧，因此列名要改写成不带表限定的形式。',
	]],
	[525, [
		T + '// [权衡] 就地替换 queryChunks 里的 MySqlColumn：模板默认把列展开成 `table`.`column`，',
		T + '// 而集合运算外层的全局 ORDER BY 不允许表名前缀（MySQL 语法错误）。',
		T + '// 改 AST 而非重建，是为了保留用户表达式的结构与 decoder。',
	]],
	[554, [
		T + '// 操作符用 raw：type 来自联合类型，isAll 决定是否补 all。',
	]],
	[561, [
		T + '// 拼装 INSERT：`insert [ignore] into t (cols) values (...) [, (...)] [on duplicate key ...]`。',
		T + '// 输入 valuesOrSelect 为二维值数组，或 select 构建器/裸 SQL。',
		T + '// 输出 { sql, generatedIds }：generatedIds 是本方言独有 —— MySQL 没有可用的 RETURNING，',
		T + '// defaultFn 在客户端生成的主键要靠它回填。',
	]],
	[569, [
		T + '// [权衡] 不区分单值与多值：多值只是列表更长，少一条分支；单值多一次循环可忽略。',
	]],
	[571, [
		T + '// 过滤掉不应参与插入的列（如 generated identity 且未显式给值），',
		T + '// 保证列清单与值清单一一对应 —— 长度不一致会写出错位的行。',
	]],
	[575, [
		T + '// 列清单一次性固化，多行 values 复用同一份顺序；逐行重算会让不同行落到不同列（INV-01）。',
	]],
	[576, [
		T + '// generatedIds 与 values 按下标平行，第 i 项对应第 i 条输入记录。',
	]],
	[578, [
		T + '// INSERT ... SELECT 分支：值来源是查询，无逐行默认值替换，列数匹配由用户负责。',
	]],
	[581, [
		T + '// 已是 SQL 时不调 getSQL()：它本身就是要嵌入的片段，再包一层会破坏参数编号。',
	]],
	[587, [
		T + '// 显式值分支：先写死 `values `，再逐行追加值列表。',
	]],
	[590, [
		T + '// STEP-1 每条记录独立构造一行，行间以 `, ` 分隔。',
	]],
	[594, [
		T + '// STEP-2 按列清单遍历而非用户对象的键：缺列落到 default 分支，多余的键自然忽略。',
	]],
	[596, [
		T + '// undefined（含 Param 包装的 undefined）视为「走默认值」，与显式 null 区分；',
		T + '// 两种形态都要拦，因为 Param 在构建期已存在但值可能尚未给出。',
	]],
	[601, [
		T + '// defaultFn 是客户端生成器（如 $defaultFn(() => randomUUID())）：只在此求值一次，',
		T + '// 结果既进 SQL 也登记到 generatedIds，保证 upsert 后拿到的是同一个值。',
	]],
	[609, [
		T + '// [权衡] 无 default 但有 onUpdateFn 的列在插入时也求值：显式写入比依赖服务端默认',
		T + '// 更可预期，也不必假设 SQL mode。',
	]],
	[616, [
		T + '// 其余情况交给 `default` 关键字，让服务端用自己的 DDL 默认值。',
	]],
	[619, [
		T + '// 用户显式给值：若为 Param 且列有 defaultFn，说明这就是客户端生成值，同样回填 generatedIds。',
	]],
	[626, [
		T + '// STEP-3 行尾分隔符；generatedIds 与行同步 push，保持下标对齐。',
	]],
	[634, [
		T + '// 值列表整体 join：多行得到 `values (..), (..)`，单行只有一组。',
	]],
	[636, [
		T + '// insert ignore 是 MySQL 扩展；与 on duplicate key 可同时出现，语义由服务端决定。',
	]],
	[638, [
		T + '// [失败路径] on duplicate key 的内容由 query-builder 生成。MySQL 不支持',
		T + '// `on conflict ... do update`，两者不可互换（与 pg/sqlite 的核心差异）。',
	]],
	[648, [
		T + '// 展平出口：SQL AST → { sql, params, typings }。',
		T + '// 三个转义函数以方法引用传入，方法内部都不依赖 this；修改它们时需保持无 this 依赖，',
		T + '// 否则这里会丢失绑定。',
	]],
	[658, [
		T + '// RQB 核心（LATERAL 版）：把 db.query 的配置编译成「一条主查询 + 若干 left join lateral',
		T + '// 子查询」，每个关系产出一个 JSON 列。',
		T + '// 输入：schema/tableConfig（关系与列元数据）、queryConfig（用户配置）、tableAlias（本层别名）、',
		T + '//       nestedQueryRelation（非空表示当前层是被父层当子查询调用）、joinOn（父层给的关联条件）。',
		T + '// 输出：{ tableTsKey, sql, selection }，selection 描述「列 → TS 键 → 关系」的映射供解码。',
		T + '// 本函数递归自调用，别名与 joinOn 由父层传入，是理解整段逻辑的关键。',
	]],
	[679, [
		T + '// selection 是产出物描述而非结果；每次递归新建一份，父层据此把子层的 JSON 列拼进来。',
	]],
	[686, [
		T + '// STEP-1 config === true 是最简形式（findMany() 无参）：全列、无关系，',
		T + '// 不进入列/关系解析，也就没有 where/orderBy。',
	]],
	[687, [
		T + '// 单表也统一用 tableAlias 包装，与带 join 的形态共用同一套解码路径。',
	]],
	[697, [
		T + '// STEP-2 完整配置：先构造别名化列映射，用户回调拿到的列都带别名，',
		T + '// 于是用户写的 where/orderBy 天然可拼进带 join 的语句。',
	]],
	[704, [
		T + '// STEP-3 where 回调同步求值；返回值必须再做列 → 别名重写，',
		T + '// 因为用户可能用原表列对象而不是回调参数。',
	]],
	[711, [
		T + '// fieldsSelection 先收集「键 → 值」，等 extras 加完再统一转 selection，',
		T + '// 输出顺序由用户书写顺序决定（INV-03 的延伸）。',
	]],
	[718, [
		T + '// STEP-4 列筛选支持 include / exclude：由「是否出现第一个 true」决定模式，',
		T + '// 全 false/undefined 视为 exclude。判定必须在遍历中完成，因为配置是键序对象。',
	]],
	[742, [
		T + '// 未指定 columns 即全列，这是 db.query 与手写 select 的默认差异。',
	]],
	[751, [
		T + '// STEP-5 关系筛选：falsy 配置被过滤，其余保留 queryConfig，递归时按 One/Many 归一化。',
	]],
	[758, [
		T + '// [权衡] 用类型谓词过滤而非 map 后再滤 undefined：少一个中间数组，后续 map 也不必断言非空。',
	]],
	[772, [
		T + '// STEP-6 extras：函数形式在构建期求值一次；值里的列要重写为别名形式，否则引用原表。',
	]],
	[789, [
		T + '// STEP-7 转换点：此后 fieldsSelection 作废，因为 selection 保存的是别名化后的字段，',
		T + '// 两者混用会引入未别名的列。',
	]],
	[804, [
		T + '// STEP-8 orderBy 归一化为数组：函数形式构建期求值；列需别名化、表达式需列名重写，',
		T + '// 两条路径缺一不可。',
	]],
	[817, [
		T + '// limit/offset 原样透传，只影响本层 SQL；递归子查询各自携带自己的分页。',
	]],
	[821, [
		T + '// STEP-9 逐关系递归，本函数最重的一段：每个关系变成一个 left join lateral 子查询，',
		T + '// 外层再用 `别名.data` 取 JSON。',
	]],
	[828, [
		T + '// normalizeRelation 把可能省略 fields/references 的关系定义规范化成确定的列对，',
		T + '// 关系元数据的多态只在这里消解一次。',
	]],
	[835, [
		T + '// 别名规则见 INV-07；唯一性由「父别名 + 关系 TS 键」保证，也使子层 JSON 引用可静态推导。',
	]],
	[836, [
		T + '// joinOn 由「关系列 = 引用列」的等值条件组成，多列用 and 连接；下传子层后与用户 where 合并。',
	]],
	[847, [
		T + '// STEP-10 递归：One 强制覆盖出 limit: 1（INV-08），用户配置的 limit 被覆盖，',
		T + '// 因为 One 的语义要求至多一行。',
	]],
	[862, [
		T + '// 关系值统一从子查询的 `data` 列取：子查询内部已把整行折叠成 JSON。',
	]],
	[865, [
		T + '// [权衡] join 条件写 `on true`：真正的关联条件已下推进子查询的 where，',
		T + '// 这里只是语法占位，MySQL 的 LATERAL join 必须有 on 子句。',
	]],
	[872, [
		T + '// selection 记录 relationTableTsKey 与子层 selection，解码端据此递归还原嵌套对象。',
	]],
	[883, [
		T + '// [失败路径] 没有可选列时抛 DrizzleError：columns 全 false 且 with/extras 为空属于配置矛盾，',
		T + '// 不可能生成合法 SQL。',
	]],
	[889, [
		T + '// result 的两条构建路径在此汇合，最后由本层统一 return。',
	]],
	[891, [
		T + '// joinOn 与自身 where 合并：子层 where 必须同时含「与父行关联」和「用户过滤」，',
		T + '// 否则 LATERAL 子查询会扫全表。',
	]],
	[893, [
		T + '// STEP-11 嵌套模式：把本行折叠成单个 JSON 列 `data`；顶层模式则直接输出列，由 session 组装对象。',
	]],
	[894, [
		T + '// Many 用 json_arrayagg 聚合多行；One 不聚合，直接 json_array 包一行。',
	]],
	[906, [
		T + '// [权衡] 聚合外套 coalesce(..., json_array())：无匹配行时聚合返回 NULL，',
		T + '// 而 TS 侧期望空数组；在此补齐比让解码端处理 null 更内聚。',
	]],
	[909, [
		T + '// 别名 data 必须与父层 `${alias}.data` 的字面一致（INV-07）。',
		T + '// nestedSelection 只有一项：列与关系的细节全部收进这一个 JSON 列。',
		T + '// 父层靠这个固定别名取列，故它不是可选的装饰。',
	]],
	[920, [
		T + '// STEP-12 limit/offset/orderBy 不能直接作用在 json_arrayagg 上：有分页或排序时',
		T + '// 先做一层 `select *`（有 orderBy 时附带 row_number()），再在外层聚合。',
	]],
	[924, [
		T + '// [权衡] 用 row_number() 而非把 order by 塞进聚合：MySQL 不支持在 json_arrayagg 内排序，',
		T + '// row_number 让「排序结果」变成可选择的列。',
	]],
	[928, [
		T + '// fieldsFlat 塞 sql.raw("*") 保住全部列；row_number 项仅用于排序，外层不再引用。',
	]],
	[948, [
		T + '// STEP-13 分页已下沉内层，必须清空，否则外层再次分页会把结果裁成 0 行。',
	]],
	[953, [
		T + '// 无分页时无需子查询，直接别名化原表，少一层嵌套。',
	]],
	[956, [
		T + '// STEP-14 外层：内层结果（子查询或表）作 from，唯一选中列是 data；',
		T + '// 此层带 joins（更下一层的关系），形成递归嵌套。',
	]],
	[975, [
		T + '// 顶层路径：selection 里的字段别名化后交给 buildSelectQuery，',
		T + '// 与嵌套路径的差别只是不折叠成 JSON。',
	]],
	[993, [
		T + '// 返回值不含执行信息：参数绑定与结果解码都在 session 侧完成。',
	]],
	[1000, [
		T + '// RQB 核心（非 LATERAL 版）：不使用 LATERAL，改为相关子查询。',
		T + '// 选择发生在 query.ts：queryMode 为 planetscale 时走本函数，其余走 LATERAL 版。',
		T + '// 差异：关系列是相关的标量子查询 `(select ...)`，不再 join 出新行；',
		T + '// 子查询只能引用父层列，故关联条件写在 where 里。',
		T + '// 列筛选、extras、orderBy 归一化、One 强制 limit 与上一函数逐行同构，修改时需同步两处。',
		T + '// 输出结构与 LATERAL 版一致，解码端因此不需要按路径分支。',
	]],
	[1021, [
		T + '// 与 LATERAL 版的结构性差异：没有 joins 数组，所有关系都由子查询完成。',
	]],
	[1030, [
		T + '// STEP-1 config === true：全列、无关系，与 LATERAL 版一致。',
	]],
	[1041, [
		T + '// STEP-2 完整配置：先别名化列映射供用户回调使用。',
	]],
	[1048, [
		T + '// STEP-3 where 回调求值后做列名重写，保证引用的是本次别名。',
	]],
	[1055, [
		T + '// fieldsSelection 的收集顺序即最终列序，列与 extras 混排也按书写顺序输出。',
	]],
	[1062, [
		T + '// STEP-4 include/exclude 判定与 LATERAL 版一致，两处规则必须同步修改。',
	]],
	[1090, [
		T + '// 列值此处还不别名化，统一在转换步骤处理，避免同一列被包装两次。',
	]],
	[1095, [
		T + '// STEP-5 关系筛选：过滤 falsy 配置，保留 One/Many 各自的 queryConfig。',
	]],
	[1102, [
		T + '// with 的类型是对象，函数形式只出现在 where/orderBy/extras，故此处无需求值。',
	]],
	[1116, [
		T + '// STEP-6 extras 构建期求值一次，值里的列同样重写为别名形式。',
	]],
	[1133, [
		T + '// STEP-7 转成 selection：此后 fieldsSelection 作废，混用会引入未别名化的列。',
	]],
	[1148, [
		T + '// STEP-8 orderBy 归一化：列别名化、表达式列名重写，两条路径缺一不可。',
	]],
	[1161, [
		T + '// limit/offset 仅作用于本层。',
	]],
	[1165, [
		T + '// STEP-9 逐关系递归：每个关系编译成相关子查询，其 where 同时含父行关联与用户过滤。',
	]],
	[1179, [
		T + '// 别名仍遵循 INV-07，便于两套实现互相替换时保持一致。',
	]],
	[1191, [
		T + '// STEP-10 递归：One 强制 limit 1（INV-08），与 LATERAL 版逐字一致。',
	]],
	[1208, [
		T + '// [权衡] 关系值不是 join 出的行，而是 `(子查询)` 标量表达式：无 LATERAL 时',
		T + '// 只能让子查询在 where 里引用父表列（相关子查询），代价是每行一次子查询执行。',
	]],
	[1209, [
		T + '// Many 可能无匹配行，子查询返回 NULL，同样用 coalesce 兜底成空数组。',
	]],
	[1224, [
		T + '// [失败路径] 与 LATERAL 版相同的空选择校验；错误信息额外提示「至少给 columns/with/extras',
		T + '// 之一」，因为这条路径常被 `columns: {}` 触发。',
	]],
	[1231, [
		T + '// result 由后续两条分支赋值，本层最后统一返回。',
	]],
	[1235, [
		T + '// STEP-11 嵌套模式：把本层结果折叠成单个 JSON 列 `data` 供父层引用。',
	]],
	[1236, [
		T + '// 相关子查询里只有一张表，列名不带前缀，直接按 casing 输出标识符；',
		T + '// 这与 LATERAL 版用 `别名.tsKey` 引用 JSON 列不同。',
	]],
	[1248, [
		T + '// Many 用 json_arrayagg；此处没有 coalesce 兜底，空集时聚合为 NULL，解码端需按 null 处理。',
	]],
	[1251, [
		T + '// data 字段不加 .as()：别名由外层列别名规则决定。',
	]],
	[1262, [
		T + '// STEP-12 有分页或排序时先做一层 `select *`，相关子查询无法同时完成排序与聚合。',
	]],
	[1264, [
		T + '// needsSubquery 判定与 LATERAL 版一致，两处必须同步，否则同一配置在两套实现下结果不同。',
	]],
	[1266, [
		T + '// 内层选出全部列并附带 row_number()，给 json_arrayagg 提供稳定顺序。',
	]],
	[1277, [
		T + '// row_number 的排序表达式来自用户 orderBy，已在前面完成别名化。',
	]],
	[1288, [
		T + '// STEP-13 分页/排序已下沉，外层清空避免二次裁剪。',
	]],
	[1293, [
		T + '// 无分页时直接用别名表，省掉一层嵌套。',
	]],
	[1296, [
		T + '// STEP-14 外层 select：from 内层结果并选出 data 列；此层不再带 joins（相关子查询已覆盖），',
		T + '// 这是与 LATERAL 版在结构上的第二处差异。',
	]],
	[1314, [
		T + '// 顶层路径：直接输出别名化后的列，不折叠 JSON。',
	]],
	[1331, [
		T + '// 返回结构与 LATERAL 版一致，session 侧无需区分两套实现。',
	]],
	[168, [
		T + '// 列名走 casing：set 的键是 TS 属性名，数据库列名可能被 casing 策略改写。',
	]],
	[189, [
		T + '// 先算 set 再拼其余片段：set 为空时语句仍合法（`update t set ` 除外），故由调用方保证非空。',
	]],
	[192, [
		T + '// returning 与 DELETE 一致：单表，列不加表限定（INV-04）。',
	]],
	[195, [
		T + '// where 为空即全表更新，这里不做拦截。',
	]],
	[241, [
		T + '// 表达式整体作为一个 chunk：列改写只在单表时发生，多表时保留原引用。',
	]],
	[272, [
		T + '// 子查询整体输出：它内部已带括号与自己的选择列表，不能再解构其列。',
	]],
	[308, [
		T + '// 索引名用 raw 拼接并整体加括号：多个索引用 `, ` 分隔，由 MySQL 解析。',
	]],
	[387, [
		T + '// 第一个 join 前补一个空格，避免与 from 的表名粘连；后续片段之间用空格分隔。',
	]],
	[412, [
		T + '// on 条件由 query-builder 生成，dialect 不再改写：其中的列已在构建期别名化。',
	]],
	[430, [
		T + '// 其余 join 源（子查询）交给模板：其 SQL 已自带括号与别名。',
	]],
	[439, [
		T + '// join 片段用空格而非逗号连接：每个片段自带 `join` 关键字。',
	]],
	[443, [
		T + '// having 只在此处出现：它依赖 group by 的聚合结果，位置固定在其后、order by 之前。',
	]],
	[457, [
		T + '// 主表的索引提示与 join 上的语法相同但位置不同：必须紧跟 from 的表引用。',
	]],
	[469, [
		T + '// 锁强度（update / share）由 query-builder 限定为关键字，故用 raw 拼入。',
	]],
	[485, [
		T + '// 无集合运算时直接返回主查询；有集合运算时由它整体包裹，见 INV-06 的括号要求。',
	]],
	[642, [
		T + '// 列清单后用一个空格接 values：MySQL 的 `(a, b) values` 之间不能有逗号，',
		T + '// 这也是 insertOrder 与 valuesSql 必须分开拼接的原因。',
		T + '// 返回结构比 buildDeleteQuery 多一项：客户端生成的主键值要回传给调用方。',
	]],
	[683, [
		T + '// 三个分页/排序变量在两侧分支分别赋值，默认保持 undefined 表示「未配置」；',
		T + '// 最终都作为 MySqlSelectConfig 的字段交给 buildSelectQuery。',
	]],
	[961, [
		T + '// 交给 buildSelectQuery 前先把裸列别名化：selection 里可能仍是原表列对象。',
	]],
	[1213, [
		T + '// 关系列同样登记 relationTableTsKey：解码端据此把 JSON 还原成嵌套对象。',
	]],
	[1307, [
		T + '// 外层不再带 joins（关系已由相关子查询完成），因此 where 只含内层过滤条件。',
	]],
	[118, [
		T + '// 分隔符只加在中间：最后一个 CTE 后不能留逗号，否则与后续 select 之间出现 `, select`。',
	]],
	[227, [
		T + '// 表达式分支：先取出可选择的 SQL（Aliased 取内部 sql），再决定是否补别名。',
	]],
	[434, [
		T + '// 相邻 join 之间补空格，否则两个 join 关键字会粘连成非法 token。',
	]],
	[492, [
		T + '// 解构第一个操作符，剩余项留给递归；数组顺序即用户书写顺序。',
	]],
	[503, [
		T + '// 递归：把刚生成的单层作为下一轮的左操作数，保持左结合；',
		T + '// 右操作数仍是原数组的剩余项，顺序不反转。',
	]],
	[521, [
		T + '// orderByValues 收集改写后的项：MySqlColumn / 含列的 SQL / 其它（字符串或 Name）。',
	]],
	[541, [
		T + '// 表达式内的列逐个就地改写：嵌套表达式里的列同样不能带表名前缀。',
	]],
	[550, [
		T + '// limit 判定与 buildLimit 相同：负数哨兵省略，Placeholder 交给运行期填充。',
	]],
	[558, [
		T + '// 集合运算自身的 order by/limit/offset 属于整个结果集，必须在两个操作数之后。',
	]],
	[588, [
		T + '// raw 写入 `values` 关键字：结构片段而非参数，不参与编号。',
	]],
	[604, [
		T + '// defaultFn 的返回值可能是 SQL 表达式，此时直接拼接而不是参数化。',
	]],
	[610, [
		T + '// onUpdateFn 同样区分 SQL 与普通值两条路径。',
	]],
	[1087, [
		T + '// 未指定 columns 即全列：与 LATERAL 版同一默认值。',
	]],
];

const total = anchors.reduce((n, [, lines]) => n + lines.length, 0);
const dry = process.argv.includes('--dry');
console.log('anchors=' + anchors.length + ' added=' + total + ' dry=' + dry);

if (dry) process.exit(0);

// 从基线原文生成：注释缩进 = 锚点下方第一行代码的缩进（Tab），保证不改变任何代码 token。
const base = 'd:/code/_annot_baseline/B07/orig/drizzle-orm/src/mysql-core/dialect.ts';
const raw = fs.readFileSync(base, 'utf8');
const lines = raw.split('\r\n');
if (raw.includes('\n') && !raw.includes('\r\n')) throw new Error('unexpected LF-only file');
if (new Set(anchors.map(([l]) => l)).size !== anchors.length) throw new Error('duplicate anchors');
for (const [line] of anchors) {
	if (line < 1 || line > lines.length + 1) throw new Error('anchor out of range: ' + line);
}
// 倒序插入
const sorted = [...anchors].sort((a, b) => b[0] - a[0]);
for (const [line, comments] of sorted) {
	const first = lines[line - 1] ?? '';
	let probe = line - 1;
	while (probe < lines.length && !(lines[probe] ?? '').trim()) probe++;
	const indent = ((lines[probe] ?? first).match(/^\t*/) || [''])[0];
	lines.splice(line - 1, 0, ...comments.map((c) => indent + c.replace(/^\t+/, '')));
}
fs.writeFileSync(target, lines.join('\r\n'), 'utf8');
console.log('written lines=' + lines.length);
