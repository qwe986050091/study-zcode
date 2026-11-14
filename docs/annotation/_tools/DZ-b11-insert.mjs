// B11 插入器：五方言 core session.ts 同构族，按「1-based 原始行号前插入 + 倒序 splice」一次性应用。
// 用法：node DZ-b11-insert.mjs [--dry]
import fs from 'node:fs';

const repo = 'd:/code/opensource/drizzle-orm';
const dry = process.argv.includes('--dry');

const T = (n) => '\t'.repeat(n);

const plan = {
	'drizzle-orm/src/pg-core/session.ts': [
		{ at: 1, ind: 0, lines: [
			'// PG 方言会话层：把 query-builder 产出的 Query 编译成一次性/可复用执行单元，并定义事务上下文契约。',
			'// 链路位置：query-builders/{select,insert,update,delete}.ts → PgDatabase → 本文件 PgSession.prepareQuery',
			'//           → PgPreparedQuery.execute → 驱动（postgres-js / node-postgres / neon / vercel-postgres）。',
			'// 本层不持有连接与语句句柄：连接生命周期、prepared 缓存、事务 BEGIN/COMMIT 都由驱动子类负责；',
			'// 本层只做四件事——SQL 展平入口、缓存编排、驱动错误→DrizzleQueryError 包装、事务配置语句拼装。',
			'// 同构基准：pg / mysql / sqlite / singlestore / gel 的 session.ts 逐段对应，本文写全量 INV，',
			'//           兄弟文件只写「方法 → INV-SS#nn → 方言差异」映射。',
			'//',
			'// INV-SS#01：PreparedQuery 构造完成后除 authToken 外字段不可变，同一实例可重复执行，结果不得回写实例（守住它的位置：PgPreparedQuery 全部字段）',
			'// INV-SS#02：cacheConfig 在构造末尾归一化为「undefined 或 enable:true」两态，undefined 表示本次查询完全不参与缓存（守住它的位置：构造函数最后一段 if）',
			'// INV-SS#03：所有驱动异常必须包装为 DrizzleQueryError(sql, params, cause) 后抛出，否则调用方拿不到出错 SQL（守住它的位置：queryWithCache 每个 catch）',
			'// INV-SS#04：写查询的缓存失效与查询本身并行发起，但返回前两者都必须成功，任一失败走同一包装（守住它的位置：onMutate 的 Promise.all 分支）',
			'// INV-SS#05：select 的缓存键恒为 cacheConfig.tag ?? hashQuery(sql, params)，get 与 put 必须同源（守住它的位置：cache.get / cache.put 两处）',
			'// INV-SS#06：autoInvalidate 为 false 时 put 的表列表必须传空数组，否则后续写操作会误清该缓存（守住它的位置：cache.put 第 3 个实参的三元表达式）',
			'// INV-SS#07：execute/all/count 是一次性查询，name/fields/isResponseInArrayMode 恒为 undefined/undefined/false（守住它的位置：PgSession.execute/all）',
			"// INV-SS#08：pg 默认返回行数组，count 取 res[0]['count']；返回 {rows} 包装的驱动必须 override count（守住它的位置：PgSession.count）",
			'// INV-SS#09：BEGIN/COMMIT/ROLLBACK 由驱动 session 实现，PgTransaction 只提供 SET TRANSACTION 拼装与 rollback 控制流（守住它的位置：PgSession.transaction / setTransaction）',
			'// INV-SS#10：rollback() 必须抛 TransactionRollbackError 而非返回，驱动据此回滚并把该错误继续上抛（守住它的位置：PgTransaction.rollback）',
			'// INV-SS#11：事务配置只来自 PgTransactionConfig 的枚举白名单，SQL 由 sql.raw 拼接而非绑定参数，故不得接受外部输入（守住它的位置：getTransactionConfigSQL）',
			'// INV-SS#12：SET TRANSACTION 必须发生在事务首条业务查询之前，本层不做时序校验，由调用方与驱动保证（守住它的位置：setTransaction）',
		] },
		{ at: 14, ind: 0, lines: [
			'// 各方言用各自的 PreparedQueryConfig 声明 execute/all/values 的返回 shape，session 泛型据此把结果类型透传给调用方。',
		] },
		{ at: 20, ind: 0, lines: [
			'// 所有 PG 驱动 prepared query 的公共基类：子类只实现 execute/all，缓存编排与错误包装在此统一（INV-SS#03 只有一处实现）。',
		] },
		{ at: 34, ind: 2, lines: [
			'// [权衡] 这里把 cacheConfig 赋成 undefined 而不是保留 enable:false：后续分支只判 `!this.cacheConfig`',
			'// 就能短路成直连数据库，少一层布尔判断，类型也收敛为「有配置=要缓存、无配置=不缓存」。',
		] },
		{ at: 44, ind: 1, lines: [
			'// 返回构造时那份不可变 Query；logger 与 batch 包装需要它做二次拼装，调用方不得改写其中的 chunks。',
		] },
		{ at: 48, ind: 1, lines: [
			'// 默认映射是恒等函数：驱动返回的已是目标行形状；只有需要改写（数组模式、类型转换）的驱动才 override。',
		] },
		{ at: 52, ind: 1, lines: [
			'// [并发] authToken 是唯一可变字段（neon-http 每次请求可能换 JWT），共享同一 prepared 再改 token',
			'// 会让并发请求互相串号；调用方必须每个请求各建一个 prepared（见 INV-SS#01）。',
		] },
		{ at: 64, ind: 1, lines: [
			'// 缓存编排唯一入口：驱动把真正的驱动调用放进 query() 闭包，本方法负责走向判定、并发失效、键生成与错误包装。',
		] },
		{ at: 69, ind: 2, lines: [
			'// STEP-1：无 cache / NoopCache / 无 queryMetadata —— 直接透传，异常仍按 INV-SS#03 包装。',
		] },
		{ at: 78, ind: 2, lines: [
			'// STEP-2：全局 $withCache({ enable: false }) 显式关闭——即便注入了 cache 也不读不写。',
		] },
		{ at: 87, ind: 2, lines: [
			'// STEP-3：写查询且声明了表——查询与失效并行发起；返回值仍以查询结果为准，',
			'// 失效失败会通过 Promise.all 让整次调用失败，避免「写成功但缓存脏」的静默状态。',
		] },
		{ at: 105, ind: 2, lines: [
			'// STEP-4：cacheConfig 缺失（构造时已归一化成 undefined）——读命中无从判断，直接执行。',
		] },
		{ at: 113, ind: 2, lines: [
			'// STEP-5：select 走缓存读；未命中时执行一次并回填，回填键必须与查询键同源（INV-SS#05）。',
		] },
		{ at: 120, ind: 3, lines: [
			'// [并发] 未命中后回填不是原子的：同键并发 SELECT 会各自执行并各自 put，由 Cache 实现决定后写覆盖，正确性不依赖此处去重。',
		] },
		{ at: 128, ind: 4, lines: [
			'// autoInvalidate=false 时传空表列表，缓存条目不会因无关表的写入被清掉（INV-SS#06）。',
		] },
		{ at: 149, ind: 1, lines: [
			'// 三个重载只为内部透传 token：对外签名仍是单个 placeholderValues，避免把 NeonAuthToken 泄漏到驱动无关的 API。',
		] },
		{ at: 162, ind: 0, lines: [
			'// 事务配置与 PG 的 `SET TRANSACTION` 语法一一对应；deferrable 只在 serializable + read only 组合下被接受，',
			'// 本层不做组合校验，非法组合由服务端报错并经 DrizzleQueryError 传回。',
		] },
		{ at: 168, ind: 0, lines: [
			'// 会话抽象：只持有 dialect（SQL 展平器），不持有连接；prepareQuery 与 transaction 由驱动子类实现。',
		] },
		{ at: 177, ind: 1, lines: [
			'// 契约：query 必须已经过 dialect.sqlToQuery 展平；fields 只用于结果列映射，不影响 SQL 文本；name 非空表示',
			'// 命名 prepared statement（驱动可复用执行计划）；queryMetadata/cacheConfig 原样交给 prepared query 构造。',
		] },
		{ at: 190, ind: 1, lines: [
			'// STEP-1：sqlToQuery 把 AST 展平成文本 + `$n` 参数（PG 占位符，按位置绑定）。',
			'// STEP-2：先包 drizzle.prepareQuery span，再执行，准备与执行两段耗时分别可见。',
			'// STEP-3：setToken 后 execute；token 同时作为显式实参传给驱动，重试时不会读到实例上的旧 token。',
		] },
		{ at: 209, ind: 1, lines: [
			'// all 只取 all 形状；不套 tracer，因为批量热路径上额外 span 的收益低于开销。',
		] },
		{ at: 218, ind: 1, lines: [
			'// count 复用 execute，只把 bigint 文本收窄为 number（2^53 内安全）；非行数组结果的驱动须 override。',
		] },
		{ at: 230, ind: 1, lines: [
			'// [事务] 真正的 BEGIN/COMMIT 在驱动层；本抽象只约定「回调抛错 ⇒ 回滚」，PgTransaction.rollback 是约定出口。',
		] },
		{ at: 236, ind: 0, lines: [
			'// 事务上下文是「绑定到同一 session 的 Database」：复用外层 session，故事务内查询落在同一连接上。',
		] },
		{ at: 256, ind: 1, lines: [
			'// [事务] 抛错即回滚指令：驱动 catch 后执行 ROLLBACK 并把同一个错误继续上抛，不被吞掉。',
		] },
		{ at: 260, ind: 1, lines: [
			'// 只做字符串拼接、不产出绑定参数：取值来自枚举白名单（INV-SS#11）；空配置返回空 SQL 片段。',
		] },
		{ at: 275, ind: 1, lines: [
			'// [事务] 必须在事务内、首条业务语句之前调用；已执行查询后再改隔离级别会被服务端拒绝并经 DrizzleQueryError 上抛。',
		] },
		{ at: 284, ind: 0, lines: [
			'// HKT 编码：驱动把结果类型挂在 type 上，session 泛型据此推导 execute 返回值；$brand 只作名义区分，运行时不产生字段。',
		] },
		{ at: 290, ind: 0, lines: [
			'// 把「结果容器类型」与「行类型」组合成驱动实际返回类型，仅编译期存在。',
		] },
	],

	'drizzle-orm/src/mysql-core/session.ts': [
		{ at: 1, ind: 0, lines: [
			'// MySQL 方言会话层：把 Query 交给驱动执行，并定义「无 RETURNING」场景下的 id 回填与流式迭代契约。',
			'// 链路位置：query-builders/*.ts → MySqlDatabase → MySqlSession.prepareQuery → 驱动',
			'//           （mysql2 / planetscale-serverless / tidb）execute 或 iterator。本层不持有连接。',
			'// 本文件与 pg-core/session.ts 结构同构，通用不变量见 INV-SS#01~#12（#04/#07/#08 不适用，见下），',
			'// 本文只写方言差异与 MySQL 专属风险。',
			'//',
			'// 族内映射：',
			'// - MySqlPreparedQuery → PgPreparedQuery → 无 query 字段/getQuery/setToken，能力改为 execute + iterator',
			'// - MySqlSession.prepareQuery → 同名 → 无 name/isResponseInArrayMode，多 generatedIds/returningIds',
			'// - MySqlSession.execute/count → 同名 → 无 tracer 与 token；count 取 res[0][0].count（驱动返回 [rows, fields]）',
			'// - getSet/StartTransactionSQL → PgTransaction.getTransactionConfigSQL → 拆成两条语句，隔离级别在 set 里',
			'// - MySqlTransaction.rollback → 同名 → 语义同 INV-SS#10，嵌套事务依赖 InnoDB savepoint',
			'//',
			'// 方言差异：MySQL 无 RETURNING（MariaDB 除外），增删改的返回行只能靠 generatedIds/returningIds',
			'// 二次读取回填；不支持命名 prepared statement 复用执行计划；事务配置拆成 `start transaction`',
			'// 与 `set transaction` 两条，访问模式与一致性快照在前者、隔离级别在后者。',
			'// 本文件仍守住 INV-SS#01（prepared 不可变）/#02（cacheConfig 归一化）/#03（错误包装）/#05（缓存键同源）/#06（失效表列表）/#10（rollback 抛错）。',
		] },
		{ at: 12, ind: 0, lines: [
			'// planetscale 模式存在的原因：PlanetScale 走 HTTP 协议、没有跨语句的交互式事务，驱动需按模式降级事务实现。',
		] },
		{ at: 14, ind: 0, lines: [
			'// MySQL 驱动统一返回 [rows, fields] 二元组，HKT 让驱动把该容器类型挂在 type 上，由 session 泛型透传给调用方。',
		] },
		{ at: 28, ind: 0, lines: [
			'// 比 PG 家族少 all/values：读取要么经 execute 一次取全量，要么经 iterator 流式拉取，',
			'// 没有第三/四种结果 shape，故 config 只声明两项。',
		] },
		{ at: 33, ind: 0, lines: [
			'// 与 QueryResultHKT 分离：prepared query 类型的容器与结果类型的容器是两套 HKT，不能合并且不可互换。',
		] },
		{ at: 39, ind: 0, lines: [
			'// [权衡] TAssume=true 时把 HKT 上的类型放宽为基类：驱动未声明具体 config 时仍可编译，',
			'// 代价是丢失精确的 execute 结果类型，故默认值为 false。',
		] },
		{ at: 47, ind: 0, lines: [
			'// 注意构造参数里没有 query：MySQL 驱动在执行时才拿到 SQL 文本与参数，基类无需保存 AST。',
		] },
		{ at: 50, ind: 1, lines: [
			'// [差异] cache 是必选位置参数（类型可为 undefined），且排在第一位：子类 super() 必须按位置给足，',
			'// 后续追加字段会同时破坏所有 MySQL 驱动子类，故只能往末尾加可选参数。',
		] },
		{ at: 61, ind: 2, lines: [
			'// [权衡] 归一化收敛在基类构造：子类不再重复判断 strategy/all；子类必须先把原始 cache 传给 super()，',
			'// 否则这里看不到 strategy，默认开启会失效。',
		] },
		{ at: 156, ind: 1, lines: [
			'// 由 db.ts 在构造查询时写入，用于把 join 出的列映射成可为空的类型，运行期只读。',
		] },
		{ at: 161, ind: 1, lines: [
			'// [资源] AsyncGenerator 惰性拉取：游标与连接在生成器正常结束或 return() 时才释放；',
			'// 循环中途 break 不会自动关闭，必须显式 return()，否则连接池会被耗干。',
			'// 生成器不可重复消费，一次 iterator() 只能遍历一遍；mysql2 流式读取需独占连接，驱动须在结束时 release。',
		] },
		{ at: 164, ind: 0, lines: [
			'// isolationLevel 必填且不设默认值：MySQL 的 set transaction 只在显式给出时发送，交给服务端默认更危险；',
			'// withConsistentSnapshot 仅在 repeatable read 下有实际意义，本层不做组合校验。',
			'// 字段缺省即不发送对应子句——本层不替调用方补默认值，避免静默改变事务语义。',
		] },
		{ at: 170, ind: 0, lines: [
			'// 会话抽象：只持有 dialect；prepareQuery/transaction 由各驱动实现，故 execute/all 在此给出默认实现。',
		] },
		{ at: 180, ind: 1, lines: [
			'// 契约：无 name（MySQL 不支持命名 prepared 复用计划）；generatedIds 用于 insert 后回填自增 id，',
			'// returningIds 描述需要二次读取的列序，二者都由 db.ts 依 dialect 生成，驱动不得自行推导。',
			'// 没有 isResponseInArrayMode：MySQL 结果形状固定为 [rows, fields]，无需运行时开关。',
		] },
		{ at: 193, ind: 1, lines: [
			'// 一次性执行：prepare 后立即 execute，不复用 prepared；无 tracer 与 token（MySQL 无 neon 式鉴权）。',
		] },
		{ at: 200, ind: 1, lines: [
			'// all 由驱动实现：mysql2 与 planetscale 的结果包装不同，无法在基类给出统一默认。',
		] },
		{ at: 202, ind: 1, lines: [
			'// [差异] res[0][0].count：execute 返回 [rows, fields]，行在第一个元素里；与 PG 的 res[0].count 差一层。',
			'// 若驱动改写了结果包装，必须同步 override count，否则这里会静默取到 undefined。',
		] },
		{ at: 210, ind: 1, lines: [
			'// [事务] 回调抛错 ⇒ 驱动回滚并继续上抛；嵌套调用由 MySqlTransaction.transaction 用 savepoint 实现，',
			'// 本抽象不感知嵌套层级；回滚只撤销当前连接上未提交的改动。',
		] },
		{ at: 215, ind: 1, lines: [
			'// [事务] 只产出 isolation level：MySQL 的 SET TRANSACTION 不接受访问模式；返回 undefined 表示无需发语句，',
			'// 调用方据此跳过空执行。',
		] },
		{ at: 225, ind: 1, lines: [
			'// [事务] consistent snapshot 必须与 repeatable read 搭配，否则服务端报错；access mode 顺序固定为',
			'// 「快照在前、读写模式在后」，与 MySQL 语法要求一致。',
		] },
		{ at: 240, ind: 0, lines: [
			'// 事务上下文继承 Database，额外携带 nestedIndex：它是 savepoint 名称的唯一来源（sp1/sp2...）。',
		] },
		{ at: 248, ind: 1, lines: [
			'// mode 透传给 Database：PlanetScale 下事务能力被裁剪，同一份事务代码在两种模式下行为不同。',
		] },
		{ at: 258, ind: 1, lines: [
			'// [事务] 同 INV-SS#10：抛错是回滚指令，驱动回滚后把同一个错误继续上抛。',
		] },
		{ at: 262, ind: 1, lines: [
			'// [事务] savepoint 语义依赖 InnoDB；MyISAM 下回滚不会撤销已写入的行。嵌套层级由 nestedIndex 递增，',
			'// 名称必须与驱动实现里 `sp${nestedIndex + 1}` 的拼法一致。',
		] },
		{ at: 268, ind: 0, lines: [
			"// HKT 基类：把 this['config'] 收窄成 PreparedQueryConfig 后交给 MySqlPreparedQuery，供 PreparedQueryKind 解析。",
		] },
	],

	'drizzle-orm/src/sqlite-core/session.ts': [
		{ at: 1, ind: 0, lines: [
			'// SQLite 方言会话层：同一套骨架同时服务同步驱动（better-sqlite3 / bun:sqlite）与异步驱动（d1 / libsql），',
			'// 两者差异被收敛成 TResultKind 与 executeMethod 两个开关，避免维护两份会话实现。',
			'// 链路位置：query-builders/*.ts → BaseSQLiteDatabase → SQLiteSession.prepareQuery → 驱动 run/all/get。',
			'// 本文件与 pg-core/session.ts 结构同构，通用不变量见 INV-SS#01~#06；本文只写 sync/async 二元性、',
			'// 批量结果抽取钩子与一次性查询的差异（INV-SS#07/#08 在本文件改写为 Result 语义）。',
			'//',
			'// 族内映射：',
			'// - SQLitePreparedQuery → PgPreparedQuery → 多 mode/executeMethod 两字段，结果类型由 Result<TKind,T> 决定',
			'// - queryWithCache → 同名 → 逐行同构，差异仅在 query() 闭包内部把同步结果包成 Promise',
			'// - SQLiteSession.prepareQuery → 同名 → 无 name，多 executeMethod/isResponseInArrayMode',
			'// - prepareOneTimeQuery → 基准无 → 默认委托 prepareQuery，子类可 override 以启用语句复用',
			'// - SQLiteSession.run/all/get/values → PgSession.execute/all → 全部返回 Result 而非 Promise',
			'// - extractRaw*ValueFromBatchResult → 基准无 → 批量执行时从驱动结果里抽取原始值',
			'// - SQLiteTransaction → PgTransaction → 无事务配置与 setTransaction，rollback 语义同 INV-SS#10',
			'//',
			'// 方言差异：SQLite 无 SET TRANSACTION，BEGIN 的 deferred/immediate/exclusive 由驱动在',
			'// SQLiteTransactionConfig 中表达；同步路径不能 await，故结果以 ExecuteResultSync 延迟执行。',
		] },
		{ at: 14, ind: 0, lines: [
			'// type 同时是「驱动能力开关」与「结果类型判别式」：它让同一个 PreparedQueryConfig 在 sync/async',
			'// 两套驱动下推导出不同的返回类型；run/all/get/values/execute 分别对应五种结果形状。',
		] },
		{ at: 23, ind: 0, lines: [
			'// [资源] 同步结果的惰性包装：resultCb 保存的是「执行动作」而不是结果，构造它不产生任何 IO；',
			'// 代价是每调用一次 sync()/execute() 就重新执行一次 SQL（见下方 sync 的说明）。',
		] },
		{ at: 30, ind: 1, lines: [
			'// 异步签名只是把同步结果包成已 resolve 的 Promise：await 后拿到的值与 .sync() 完全相同。',
		] },
		{ at: 34, ind: 1, lines: [
			'// [资源] 每次调用都重新执行：不要在循环或多次读取里反复 .sync()，调用方必须自行缓存返回值。',
		] },
		{ at: 39, ind: 0, lines: [
			'// 条件类型：async 驱动得到 Promise，sync 驱动得到 ExecuteResultSync；它保证 await 在两侧都成立。',
		] },
		{ at: 42, ind: 0, lines: [
			'// prepared query 基类：把「同步/异步」与「结果映射」两件事分开，子类只需实现 run/all/get/values，',
			'// 并在 map*Result 里做列名到对象的映射。',
		] },
		{ at: 48, ind: 1, lines: [
			'// [不变量] mode 与 executeMethod 构造后不变：mode 决定 execute() 返回 Promise 还是 ExecuteResultSync，',
			'// executeMethod 决定 execute() 调哪个方法、mapResult 走哪个映射；显式调用 .all()/.get() 不受它影响。',
			'// cache 是可选位置参数，子类 super() 时必须保持参数顺序。',
		] },
		{ at: 62, ind: 2, lines: [
			'// 归一化同 INV-SS#02；SQLite 的交互式事务可跨多条 prepared 语句，写失效在事务未提交时即发生，',
			'// 故 Cache 实现必须容忍「已失效但未提交」的中间态。',
		] },
		{ at: 70, ind: 1, lines: [
			'// 缓存编排逐行同构于基准：驱动把同步调用包成 Promise 后交给 query()，缓存层不需要感知 sync/async。',
		] },
		{ at: 157, ind: 1, lines: [
			'// 返回不可变 Query：批量执行与 logger 依赖它还原 SQL 文本，调用方不得改写。',
		] },
		{ at: 161, ind: 1, lines: [
			'// 返回类型是 Result<T[type], T[run]>：sync 驱动给原始值，async 驱动给 Promise，由条件类型自动选择。',
		] },
		{ at: 163, ind: 1, lines: [
			'// 默认恒等：驱动已把 run 结果规整为 { changes, lastInsertRowid } 一类形状，需要改写的驱动才 override。',
		] },
		{ at: 169, ind: 1, lines: [
			'// [失败路径] 基类抛 Not implemented：只有覆盖了 mapAllResult 的驱动才能走 all；漏实现会在首次读取',
			'// 立即失败，而不是把原始行静默当成映射结果返回。',
		] },
		{ at: 175, ind: 1, lines: [
			'// [失败路径] 同上：get 的映射必须由驱动提供，基类不猜测单行结果的列结构。',
		] },
		{ at: 181, ind: 1, lines: [
			'// STEP-1：sync 模式包成 ExecuteResultSync（延迟到 .sync()/.execute() 执行）。',
			'// STEP-2：async 模式直接调用 executeMethod 对应的方法，返回其 Promise。',
			'// STEP-3：两条路径在调用方看来都能 await，Result 类型保证签名统一。',
		] },
		{ at: 188, ind: 1, lines: [
			'// 批量执行路径按 executeMethod 分派映射：isFromBatch 用于让驱动区分单条结果与批量结果形状，',
			'// 未覆盖的分支返回 undefined 而不是抛错，因为 batch 里可能混合多种语句。',
		] },
		{ at: 206, ind: 0, lines: [
			'// [事务] behavior 决定 BEGIN 的三种语义：immediate 在 WAL 下先拿写锁，避免读到旧快照后升级锁失败；',
			'// exclusive 会阻塞所有其他连接，仅用于必须独占的迁移场景。',
		] },
		{ at: 210, ind: 0, lines: [
			'// execute() 的分派键：run 丢弃行、all 取多行、get 取单行；它只影响 execute()，与显式方法调用无关。',
		] },
		{ at: 212, ind: 0, lines: [
			'// 会话抽象：dialect 按 TResultKind 选出 sync/async 两套之一，同步/异步在编译期就绑定，运行期不分叉。',
		] },
		{ at: 220, ind: 1, lines: [
			'// dialect 是 { sync, async } 的索引类型，TResultKind 决定取哪一套；prepareQuery 的展平逻辑因此完全复用。',
		] },
		{ at: 225, ind: 1, lines: [
			'// 契约：query 已展平；executeMethod 决定结果形状；isResponseInArrayMode 让驱动选择数组/对象行；',
			'// customResultMapper 存在时驱动必须跳过列名映射，直接交给它处理原始行数组。',
		] },
		{ at: 238, ind: 1, lines: [
			'// [权衡] 默认直接委托 prepareQuery：不缓存的实现天然正确。驱动若想复用语句，override 后语义必须',
			'// 与 prepareQuery 完全一致，否则一次性查询与 prepared 查询会出现两种结果形状。',
		] },
		{ at: 261, ind: 1, lines: [
			'// [事务] 返回 Result 而非 Promise：同步驱动在回调返回后立即 COMMIT，异步驱动返回 Promise；',
			'// 回调抛错由驱动回滚并继续上抛（INV-SS#10）。',
		] },
		{ at: 266, ind: 1, lines: [
			'// STEP-1：sqlToQuery 展平，失败（SQL 构造错误）在 try 之外，按原错误直接抛出。',
			'// STEP-2：prepareOneTimeQuery + run 执行，任何驱动异常都被收拢。',
			'// STEP-3：用 DrizzleError 而非 DrizzleQueryError——这条路径没有参数数组，但保留 SQL 文本便于定位。',
		] },
		{ at: 275, ind: 1, lines: [
			'// [资源] 批量结果抽取钩子：返回驱动原始值而非映射值，调用方（db.batch）自行决定后续映射；',
			'// 基类恒等返回，异步驱动的批量结果往往需要在这里解包。',
		] },
		{ at: 280, ind: 1, lines: [
			'// [权衡] executeMethod 固定传 run：一次性查询只取结果，all/get/values 由后面的显式方法调用决定，',
			'// executeMethod 仅影响 execute() 的分派，传 run 不会让 .all() 变成 run。',
		] },
		{ at: 287, ind: 1, lines: [
			'// [失败路径] 基类直接抛错：批量读取必须由驱动实现抽取逻辑，静默返回 undefined 会掩盖漏实现。',
		] },
		{ at: 292, ind: 1, lines: [
			'// get 与 all 的差异只有结果行数（1 行 vs 多行），映射由驱动在 mapGetResult 中完成。',
		] },
		{ at: 299, ind: 1, lines: [
			'// [失败路径] 同 extractRawAll：未实现即抛错，避免 undefined 混入批量结果数组。',
		] },
		{ at: 304, ind: 1, lines: [
			'// values 返回「无列名的行数组」：省掉列名映射开销，适合 count/聚合等只关心位置取值的场景。',
		] },
		{ at: 313, ind: 1, lines: [
			'// 复用 values 而非 all：count 只有一列一行，values 省掉列名映射；不做 Number 收窄，保持驱动原始类型。',
			'// 调用方若需要 number，需自行转换（SQLite 的 count 在部分驱动里是 bigint）。',
		] },
		{ at: 319, ind: 1, lines: [
			'// [失败路径] values 的批量抽取同样要求驱动实现；基类抛错是 fail-closed 的默认值。',
		] },
		{ at: 325, ind: 0, lines: [
			'// 结果类型选择器：TKind 是字面量联合，映射成 { sync, async } 后取索引，避免在每个签名里写条件类型。',
		] },
		{ at: 327, ind: 0, lines: [
			'// 与 Result 的区别：异步侧包成 SQLiteRaw（可再次 .execute()/.sync() 的惰性句柄），用于 db 层暴露的原始查询。',
		] },
		{ at: 329, ind: 0, lines: [
			'// 事务上下文继承 BaseSQLiteDatabase，携带 nestedIndex 供驱动拼 savepoint 名称（sp1/sp2...）。',
		] },
		{ at: 337, ind: 1, lines: [
			'// resultType 与 dialect 都必须与父库一致：事务内查询走同一套 sync/async 分派，混用会让返回类型失真。',
			'// schema 可选，与 BaseSQLiteDatabase 的 relational 配置保持同一形状。',
		] },
		{ at: 351, ind: 1, lines: [
			'// [事务] 同 INV-SS#10：抛错即回滚指令，驱动回滚后继续上抛，调用方拿到同一个错误实例。',
		] },
	],

	'drizzle-orm/src/singlestore-core/session.ts': [
		{ at: 1, ind: 0, lines: [
			'// SingleStore 方言会话层：骨架与 MySQL 族一致（无 RETURNING、execute + iterator、HKT prepared query），',
			'// 差异集中在事务配置的类型约束与协议端点。',
			'// 链路位置：query-builders/*.ts → SingleStoreDatabase → SingleStoreSession.prepareQuery → 驱动。',
			'// 本文件与 pg-core/session.ts 结构同构，通用不变量见 INV-SS#01~#06/#10，本文只写方言差异。',
			'//',
			'// 族内映射：',
			'// - SingleStorePreparedQuery → PgPreparedQuery → 无 query/getQuery/setToken，改为 execute + iterator',
			'// - SingleStoreSession.prepareQuery → 同名 → 无 name；多 generatedIds/returningIds（回填自增 id）',
			'// - SingleStoreSession.execute/count → 同名 → count 取 res[0][0].count（驱动返回 [rows, fields]）',
			'// - getSet/StartTransactionSQL → PgTransaction.getTransactionConfigSQL → 拆两条语句，隔离级别退化为字面量',
			'// - SingleStoreTransaction → PgTransaction → 无 setTransaction，rollback 语义同 INV-SS#10',
			'//',
			'// 方言差异（与 mysql-core 的关键区别，不要照搬其结论）：',
			'// - 隔离级别类型只有一个字面量 read committed：不提供 RR/SERIALIZABLE，故 getSetTransactionSQL 的分支在类型层面恒真；',
			'// - 没有 planetscale 模式，Database/Transaction 构造不接收 mode，因而没有「无交互事务」的降级路径；',
			'// - 嵌套事务仍用 savepoint，但 savepoint 的可见范围受分布式执行影响，驱动需保证同一连接。',
			'// 本文件守住 INV-SS#01（prepared 不可变）/#02/#03（错误包装）/#05（缓存键同源）/#06（失效表列表）。',
		] },
		{ at: 12, ind: 0, lines: [
			'// 结果容器 HKT：驱动把 [rows, fields] 包装类型挂到 type 上，session 泛型据此推导 execute 返回值。',
		] },
		{ at: 26, ind: 0, lines: [
			'// 只有 execute 与 iterator：没有 all/values，读取要么一次取全量，要么流式拉取，避免第三套结果形状。',
		] },
		{ at: 31, ind: 0, lines: [
			'// 与结果 HKT 分离：prepared query 的类型容器不可与结果容器合并，否则 PreparedQueryKind 无法正确解析。',
		] },
		{ at: 37, ind: 0, lines: [
			'// [权衡] TAssume 用于驱动未声明具体 config 的 HKT：放宽到基类后可编译，但会丢失精确结果类型，故默认 false。',
		] },
		{ at: 45, ind: 0, lines: [
			'// prepared query 基类：只保留缓存编排与错误包装，执行与迭代下放到驱动。',
		] },
		{ at: 48, ind: 1, lines: [
			'// [差异] 三个参数全部可选且顺序为 cache → queryMetadata → cacheConfig；驱动 super() 必须按位置传，',
			'// 后续只能追加可选参数，否则所有 SingleStore 驱动同时被破坏。',
		] },
		{ at: 59, ind: 2, lines: [
			'// 归一化同 INV-SS#02：把三态压成两态；cache.strategy() === all 时默认开启，显式 enable:false 时不缓存。',
		] },
		{ at: 67, ind: 1, lines: [
			'// 缓存编排逐行同构：本文件不重述分支语义，只强调 query() 闭包由驱动提供且必须自带参数绑定。',
		] },
		{ at: 154, ind: 1, lines: [
			'// 运行期只读：由 db.ts 构造查询时写入，用于 join 列的 nullable 推导。',
		] },
		{ at: 157, ind: 1, lines: [
			'// 抽象执行：驱动负责把 SQL 文本与参数交给协议层，结果形状由 PreparedQueryHKT 决定。',
		] },
		{ at: 159, ind: 1, lines: [
			'// [资源] AsyncGenerator 持有游标：正常耗尽或 return() 才释放连接；中途 break 不会自动关闭，',
			'// 必须显式 return()；生成器只能消费一次，重复 for-await 会得到空序列。',
			'// [权衡] 用生成器而非一次性取全量：大结果集不必整体进内存，代价是连接占用时间变长。',
			'// SingleStore 同一连接不保证并发多流，驱动必须串行化同一连接上的 iterator。',
		] },
		{ at: 162, ind: 0, lines: [
			'// [差异] isolationLevel 是必填的单值字面量：类型上排除了其他隔离级别，运行时分支恒真；',
			'// withConsistentSnapshot 与 accessMode 只影响 start transaction，不进入 set transaction。',
			'// 与 mysql-core 相比少了 planetscale 相关的模式字段，因为 SingleStore 无 HTTP 降级端点。',
			'// accessMode 为 read only 时不要搭配写语句：服务端会拒绝，且错误在事务提交前才暴露。',
		] },
		{ at: 168, ind: 0, lines: [
			'// 会话抽象：持有 dialect（SingleStore 语法展平器），不持有连接；事务由驱动实现。',
		] },
		{ at: 178, ind: 1, lines: [
			'// 契约：query 已展平；generatedIds 用于 insert 回填自增 id，returningIds 描述回填时读取的列序，',
			'// 二者必须来自同一 dialect 的 escapeName 结果，否则回填 SQL 会点名错误的列。',
			'// generatedIds 为空数组表示本次不涉及自增列，驱动应跳过二次读取而不是发一条空查询。',
			'// 无 name：协议层不支持命名 prepared statement 的计划复用。',
		] },
		{ at: 194, ind: 1, lines: [
			'// 一次性执行：prepare 后立即 execute；无 tracer 与 token，鉴权由驱动连接串承担。',
		] },
		{ at: 201, ind: 1, lines: [
			'// all 留给驱动：不同协议端点对结果包装不同，基类无法给出统一实现。',
		] },
		{ at: 203, ind: 1, lines: [
			'// [差异] execute 返回 [rows, fields]，故计数行在 res[0][0]；驱动若改写结果包装必须同步 override count，',
			'// 否则这里会静默得到 undefined 而不是抛错。',
		] },
		{ at: 211, ind: 1, lines: [
			'// [事务] 回调抛错 ⇒ 回滚并继续上抛；嵌套事务由子类的 transaction 用 savepoint 实现，本抽象不感知层级。',
		] },
		{ at: 216, ind: 1, lines: [
			'// [事务] 因为 isolationLevel 必填，这里几乎恒返回 SQL；仍声明 SQL | undefined 是为了与族内签名一致，',
			'// 调用方按可选处理即可，无需分支判断。',
		] },
		{ at: 226, ind: 1, lines: [
			'// [事务] parts 为空时返回 undefined，避免发送裸 `start transaction`；withConsistentSnapshot 必须先于',
			'// accessMode 出现，否则拼出的语句不符合语法顺序。',
		] },
		{ at: 241, ind: 0, lines: [
			'// 事务上下文：无 mode 参数，schema 用 RelationalSchemaConfig（可选），与 Database 的字段同源。',
		] },
		{ at: 249, ind: 1, lines: [
			'// nestedIndex 由驱动在开 savepoint 前 +1，是 savepoint 名称的唯一来源；schema 直接透传给父库，',
			'// 保证事务内的 relational query 与外层看到同一份表名映射。',
		] },
		{ at: 258, ind: 1, lines: [
			'// [事务] 同 INV-SS#10：抛错即回滚指令，驱动回滚后继续上抛同一个错误。',
		] },
		{ at: 262, ind: 1, lines: [
			'// [事务] savepoint 依赖引擎支持；名称拼法与驱动实现的 sp{nestedIndex+1} 必须一致，改一处就会回滚错层。',
			'// 分布式执行下 savepoint 只在同一连接内可见，驱动必须复用同一连接，不能从池里重新取。',
		] },
		{ at: 268, ind: 0, lines: [
			"// HKT 基类：把 this['config'] 收窄后交给 SingleStorePreparedQuery，供 PreparedQueryKind 解析具体驱动类型。",
		] },
	],

	'drizzle-orm/src/gel-core/session.ts': [
		{ at: 1, ind: 0, lines: [
			'// Gel 方言会话层：与 pg-core 同骨架（prepared query + 一次性 execute/all + 事务上下文），',
			'// 但执行文本是 EdgeQL 而非 SQL，且事务配置能力被裁掉。',
			'// 链路位置：query-builders/*.ts → GelDatabase → GelSession.prepareQuery → 驱动（gel / edgedb-js）。',
			'// 本文件与 pg-core/session.ts 结构同构，通用不变量见 INV-SS#01~#06/#10，本文只写差异。',
			'//',
			'// 族内映射：',
			'// - GelPreparedQuery → PgPreparedQuery → 保留 query/getQuery/mapResult，但无 setToken 与 token 重载',
			'// - GelSession.prepareQuery → 同名 → 签名保留 name/isResponseInArrayMode（恒传 undefined/false）',
			'// - GelSession.execute/all/count → 同名 → execute 保留 tracer，但 token 传参被删除',
			'// - GelSession.transaction → 同名 → 无 config 参数，故无 getTransactionConfigSQL/setTransaction',
			'// - GelTransaction → PgTransaction → 无 nestedIndex 与 setTransaction，rollback 语义同 INV-SS#10',
			'//',
			'// 方言差异：dialect 产出的占位符是 EdgeQL 静态参数 `$1,$2...`，本层只透传文本与参数数组，不解码',
			'// 也不重编号；事务隔离级别与访问模式不在核心层表达，故 INV-SS#11/#12 在本文件不适用。',
			'// 本文件守住 INV-SS#01（prepared 不可变）/#02（cacheConfig 归一化）/#03（错误包装）/#05（缓存键同源）。',
			'// [权衡] GelPreparedQuery 仍保留 authToken 字段：与 PG 家族共享类形状，但 Gel 驱动不消费它，',
			'// 也没有 setToken；写入该字段不会改变任何执行行为。',
		] },
		{ at: 14, ind: 0, lines: [
			'// 只声明 execute/all/values：EdgeQL 没有 insert 影响行数之类的独立形状，写操作也走 execute。',
		] },
		{ at: 20, ind: 0, lines: [
			'// prepared query 基类：缓存编排与错误包装在基类，执行由驱动实现；与 PG 的差异是构造参数全可选。',
			'// 不实现 iterator：EdgeQL 结果一次性返回，流式拉取由驱动自行提供。',
		] },
		{ at: 21, ind: 1, lines: [
			'// [差异] query 声明为 protected 而非 private：getQuery 需要直接返回它，子类也可读取原文做日志。',
		] },
		{ at: 33, ind: 2, lines: [
			'// 归一化同 INV-SS#02；此处 cache 是可选参数，归一化后仍保证「undefined ⇔ 不参与缓存」这一唯一判据。',
		] },
		{ at: 41, ind: 1, lines: [
			'// 缓存编排与基准逐行同构，不重述；唯一差异是 query() 闭包里的驱动调用走 EdgeQL 协议而非 pg wire protocol。',
		] },
		{ at: 128, ind: 1, lines: [
			'// [权衡] 保留 authToken 但不提供 setToken：族内类形状一致，代价是一个永远为 undefined 的字段，',
			'// 误用不会报错也不会生效，属于已知的静默无效面。',
		] },
		{ at: 130, ind: 1, lines: [
			'// 返回构造时的不可变 Query；调用方不得改写，否则会污染缓存键里的 SQL 文本。',
		] },
		{ at: 134, ind: 1, lines: [
			'// 默认恒等：EdgeQL 结果已是对象数组，不需要列序解码；只有需要类型收窄的驱动才 override。',
		] },
		{ at: 143, ind: 1, lines: [
			'// 驱动实现：把 EdgeQL 文本与参数交给协议层，返回 PreparedQueryConfig.execute 声明的形状。',
		] },
		{ at: 145, ind: 1, lines: [
			'// all 与 execute 在协议层是同一调用，区别只在驱动如何映射结果，故两者都标 @internal 由 db 层调用。',
			'// 与 PG 不同，这里没有 token 重载：Gel 的鉴权绑定在连接上，不存在按查询换 token 的场景。',
		] },
		{ at: 148, ind: 1, lines: [
			'// 返回结果是否为数组模式：Gel 恒为 false，保留该抽象只因为 PreparedQuery 接口要求实现。',
		] },
		{ at: 152, ind: 0, lines: [
			'// 会话抽象：只持有 dialect；prepareQuery 与 transaction 由驱动实现。',
		] },
		{ at: 161, ind: 1, lines: [
			'// 契约：query 已展平；name/isResponseInArrayMode 保留是为了与 PgSession 同签名，Gel 下恒传',
			'// undefined/false，驱动不得依赖它们做分支。',
			'// customResultMapper 的 mapColumnValue 参数在 Gel 下不会被使用（无列序解码）。',
		] },
		{ at: 174, ind: 1, lines: [
			'// STEP-1：sqlToQuery 产出 EdgeQL 文本与 $n 参数（占位符形式由 dialect 决定，本层不解析）。',
			'// STEP-2：prepareQuery 包在独立 span 里，便于把准备耗时与驱动执行耗时分开观测。',
			'// STEP-3：execute(undefined) 不再透传 token——Gel 的鉴权属于连接，不属于单次查询。',
		] },
		{ at: 189, ind: 1, lines: [
			'// all 与 execute 共用同一次 prepared 构造，只是取出 all 形状的结果。',
		] },
		{ at: 198, ind: 1, lines: [
			"// 与 PG 相同的行数组形状：res[0]['count']；EdgeQL 的 count 可能是 bigint，Number 在 2^53 内安全。",
			'// 若驱动改写了结果包装，必须 override count，否则会静默取到 undefined。',
		] },
		{ at: 206, ind: 1, lines: [
			'// [事务] 无 config 参数：Gel 驱动不支持在事务开始前声明隔离级别，事务语义完全由驱动默认值决定。',
			'// 回调抛错仍由驱动回滚并继续上抛（INV-SS#10）。',
		] },
		{ at: 211, ind: 0, lines: [
			'// 事务上下文继承 GelDatabase，复用外层 session，故事务内的查询与外层共享同一连接。',
		] },
		{ at: 218, ind: 1, lines: [
			'// 与 PG 的差异：无 nestedIndex——驱动层未实现 savepoint 分层，嵌套事务的原子性由驱动自行承担，',
			'// 核心层不暴露层级信息，因此也无法拼出稳定的 savepoint 名称。',
		] },
		{ at: 230, ind: 1, lines: [
			'// [事务] 抛错即回滚指令：驱动 catch 后回滚并把同一个错误继续上抛，不被吞掉。',
		] },
		{ at: 234, ind: 1, lines: [
			'// 子类实现事务；签名没有 config，与 GelSession.transaction 保持一致，避免上层出现方言分支。',
			'// 与 PG 不同，这里不声明 config 重载，因为核心层没有 getTransactionConfigSQL 可复用。',
		] },
		{ at: 239, ind: 0, lines: [
			'// HKT 编码同 PG：$brand 只作名义区分，type 承载驱动结果容器类型。',
		] },
		{ at: 245, ind: 0, lines: [
			'// 结果容器与行类型的组合工具类型，仅编译期存在。',
		] },
	],
};

// 1) 干跑：计算插入后每文件注释数与密度
function measureText(text) {
	const lines = text.split('\r\n');
	if (lines.length && lines[lines.length - 1] === '') lines.pop();
	let blank = 0, comment = 0, inBlock = false;
	for (const raw of lines) {
		const t = raw.trim();
		if (!t) { blank++; continue; }
		let isComment = false;
		if (inBlock) { isComment = true; if (t.includes('*/')) inBlock = false; }
		else if (t.startsWith('//')) isComment = true;
		else if (t.startsWith('/*')) { isComment = true; if (!t.includes('*/')) inBlock = true; }
		if (isComment) comment++;
	}
	const total = lines.length;
	return { total, blank, comment, code: total - blank - comment };
}

let ok = true;
for (const [rel, inserts] of Object.entries(plan)) {
	const file = repo + '/' + rel;
	const orig = fs.readFileSync(file, 'utf8');
	const lines = orig.split('\r\n');
	const before = measureText(orig);
	for (const ins of inserts) {
		if (ins.at < 1 || ins.at > lines.length) { console.error('BAD ANCHOR ' + rel + ':' + ins.at); ok = false; }
		for (const l of ins.lines) {
			if (l.trim().startsWith('//') === false) { console.error('NOT COMMENT ' + rel + ':' + ins.at + ' :: ' + l); ok = false; }
			if (l.includes('*/')) { console.error('STAR SLASH ' + rel + ':' + ins.at + ' :: ' + l); ok = false; }
		}
	}
	const added = inserts.reduce((s, i) => s + i.lines.length, 0);
	// 校验缩进是否与该锚点下方首行一致（锚点在文件末尾时跳过）
	const anchors = inserts.slice().sort((a, b) => b.at - a.at);
	const out = lines.slice();
	for (const ins of anchors) {
		const target = out[ins.at - 1];
		const targetIndent = (target.match(/^\t*/) || [''])[0].length;
		if (targetIndent !== ins.ind) {
			console.error(`INDENT MISMATCH ${rel}:${ins.at} plan=${ins.ind} code=${targetIndent} :: ${target.slice(0, 60)}`);
			ok = false;
		}
		const block = ins.lines.map((l) => T(ins.ind) + l);
		out.splice(ins.at - 1, 0, ...block);
	}
	const text = out.join('\r\n');
	const after = measureText(text);
	const ratio = (after.comment / after.code) * 100;
	console.log(`${rel}\tadded=${added}\ttotal=${after.total}\tcode=${after.code}\tcomment=${after.comment}\tratio=${ratio.toFixed(2)}%`);
	if (ratio < 30 || ratio > 34) { console.error('RATIO OUT OF RANGE ' + rel + ' = ' + ratio.toFixed(2)); ok = false; }
	if (!dry && ok) fs.writeFileSync(file, text, 'utf8');
}
if (dry) console.log('DRY OK=' + ok);
if (!ok) process.exit(1);
