// B09 插入脚本：按 1-based 原始行号前插入整行 // 注释，倒序 splice，CRLF 保持。
import fs from 'node:fs';

const file = 'd:/code/opensource/drizzle-orm/drizzle-orm/src/singlestore-core/dialect.ts';
const raw = fs.readFileSync(file, 'utf8');
const lines = raw.split('\r\n');

const T = '\t';
const inserts = [
	[1, [
		'// SingleStore 方言 SQL 生成器：把 query-builder 的配置对象翻译成「SQL 文本 + 参数序列」。',
		'// 本文件与 mysql-core/dialect.ts 结构同构：方法骨架、执行链路、解码契约完全一致，',
		'// 通用不变量统一引用 INV-MD#nn（INV-MD 即该文件头 INV-01..10），本文只标注方言差异。',
		'// 链路：query-builders/* 产出 *Config → SingleStoreSession 调 build*Query 得到 SQL AST →',
		'// sqlToQuery 展平为 `?` 占位符与 params（INV-MD#02）→ 驱动绑定。本类不持连接、不读时钟（INV-MD#01）。',
		'//',
		'// 族内映射表（本文件函数 → 基准 INV/方法 → 差异点）：',
		'// - migrate → mysql migrate → DDL 相同；事务包裹与 DDL 隐式提交见函数头 [事务]',
		'// - escapeName/escapeParam/escapeString → INV-MD#02 → 反引号 / `?` / 单引号翻倍，无差异',
		'// - buildWithCTE → INV-MD#06 → 无差异，WITH 仍必须位于语句最前',
		'// - buildDeleteQuery/buildUpdateQuery → INV-MD#04/#05 → 语法同 MySQL；returning 只由 config 决定',
		'// - buildUpdateSet → mysql 同名 → onUpdateFn 回填规则相同，不做列存特殊处理',
		'// - buildSelection → INV-MD#03 → 输出顺序即 fieldsFlat 顺序，单表才省表限定',
		'// - buildSelectQuery → INV-MD#05/#10 → lateral 关键字原样透传；锁子句 FOR ... NOWAIT/SKIP LOCKED',
		'// - buildSetOperations/buildSetOperationQuery → mysql 同名 → UNION 后 orderBy 列名需去表限定',
		'// - buildInsertQuery → mysql 同名 → `ignore` / `on duplicate key update`；构建期回填 defaultFn 值',
		'// - buildRelationalQuery → INV-MD#07/#08 → 只有一套 LATERAL 实现；聚合用 JSON_TO_ARRAY / json_agg',
	]],
	[39, [
		T + '// 仅暴露 casing：方言差异都在 SQL 文本层，构建期不需要连接级开关。',
		T + '// 若新增能力开关，必须保证「同一 config 必得同一 SQL」（INV-MD#01）。',
	]],
	[49, [
		T + '// CasingCache 在构造期固化 casing 规则，构建期只读；',
		T + '// 避免每个标识符重复做大小写推导，也防止运行期被外部修改破坏确定性（INV-MD#01）。',
	]],
	[53, [
		T + '// 迁移执行：先确保记录表存在，再取 created_at 最大的一条已应用记录，',
		T + '// 之后在单个事务里按顺序执行 folderMillis 更大的迁移。',
		T + '// [事务] 迁移 SQL 与记录插入必须同事务：只执行不记录会在重启后重复执行，',
		T + '// 只记录不执行会让后续迁移基于错误版本；MySQL 系 DDL 隐式提交，失败时可能留下半套表。',
		T + '// SingleStore 沿用 MySQL 协议，本函数不做 DDL 能力探测，语法不支持由服务端报错。',
	]],
	[58, [
		T + T + '// 记录表名可由 MigrationConfig 覆盖；标识符走 sql.identifier，防止配置值注入 SQL。',
	]],
	[59, [
		T + T + '// 建表用 if not exists，重复迁移幂等；serial 由服务端自增，',
		T + T + '// hash/created_at 由迁移器写入，三列构成版本判定的最小信息。',
	]],
	[66, [
		T + T + '// 先建表再读记录：否则首次运行 all() 会因表不存在失败（错误直接上抛）。',
	]],
	[78, [
		T + T + '// [事务] 整个迁移循环共用一个事务：任一语句失败即整体回滚。',
		T + T + '// DDL 的隐式提交不在本函数控制范围内，故失败时可能残留部分表（见函数头）。',
	]],
	[79, [
		T + T + T + '// 只执行 folderMillis 严格大于最后记录的迁移，等值视为已应用，避免边界重复。',
	]],
	[84, [
		T + T + T + T + '// 迁移文件内的语句按书写顺序执行；sql.raw 不参与参数编号（INV-MD#09）。',
	]],
	[87, [
		T + T + T + T + '// 记录插入与迁移语句共享事务，hash 供后续校验版本一致性。',
	]],
	[99, [
		T + '// 标识符转义：SingleStore 与 MySQL 同为反引号，内部反引号翻倍；casing 已在上层处理。',
	]],
	[103, [
		T + '// INV-MD#02：占位符恒为 `?`，按位置绑定，编号参数被忽略；',
		T + '// 改成 `$n` 会与 SingleStore 的 MySQL 协议不兼容。',
	]],
	[107, [
		T + '// 字符串字面量只做单引号翻倍；反斜杠语义取决于服务端 sql_mode。',
	]],
	[111, [
		T + '// INV-MD#06：WITH 只在这里生成，调用方必须把它拼在语句最前，嵌套层不得自带 WITH。',
		T + '// 别名取 Subquery._.alias，与 buildRelationalQuery 的关系别名规则（INV-MD#07）无关。',
		T + '// 空列表返回 undefined 而不是空片段，避免模板里出现孤立的 `with`。',
	]],
	[114, [
		T + T + '// 逐项拼 `alias as (sql)`，仅最后一个之后不加逗号，末尾补空格供后续关键字衔接。',
	]],
	[125, [
		T + '// 单表 DELETE 编译：WITH → delete from → where → order by → limit → returning，',
		T + '// 顺序与 MySQL 一致；limit/orderBy 只在单表删除时合法，本函数不做多表校验。',
		T + '// [权衡] returning 无条件按 config 输出（INV-MD#04），不支持时由服务端报错，而不是静默丢弃。',
	]],
	[133, [
		T + T + '// undefined 片段会被 SQL 拼接层忽略，不会留下多余的 with 关键字。',
	]],
	[135, [
		T + T + '// 删除语句没有 join，选择列不需要表限定（INV-MD#05）。',
	]],
	[139, [
		T + T + '// where/orderBy/limit 都可能缺省，保持 undefined 让模板自然省略对应片段。',
	]],
	[148, [
		T + '// 生成 `col = value` 列表，列顺序取 table 定义顺序而非 set 的键序，保证 SQL 确定性（INV-MD#01）。',
		T + '// 参与列 = 用户显式赋值列 ∪ 定义了 onUpdateFn 的列；后者即 `$onUpdate` 的自动更新时间戳。',
		T + '// SingleStore 无列存相关的特殊写入语义，此处与 MySQL 逐字相同，不做额外分支。',
	]],
	[151, [
		T + T + '// 用 undefined 判断而不是 `in`：显式传 undefined 与未传等价，',
		T + T + '// 都走 onUpdateFn / default 兜底。',
	]],
	[162, [
		T + T + T + T + '// onUpdateFn 在构建期同步求值一次；返回 SQL 时原样使用（可能是 now()），',
		T + T + T + T + '// 否则包成参数，交给驱动绑定。',
	]],
	[167, [
		T + T + T + T + '// 列名经 casing 转换后作为标识符；值来自用户输入时由 sql.param 绑定，绝不拼进文本。',
	]],
	[177, [
		T + '// UPDATE 编译顺序与 DELETE 相同：with → update set → where → orderBy → limit → returning。',
		T + '// set 片段由 buildUpdateSet 生成，列序稳定；returning 同样只由 config 决定（INV-MD#04）。',
		T + '// 不带 from/join：SingleStore 与 MySQL 的多表更新不在本类的支持范围。',
	]],
	[186, [
		T + T + '// WITH 必须位于最前（INV-MD#06），update 关键字紧随其后。',
	]],
	[188, [
		T + T + '// set 为空会生成悬空的 `set`，这属于调用方构造了空更新，本函数不额外兜底。',
	]],
	[190, [
		T + T + '// 单表 returning：无 join，列不加表限定。',
	]],
	[203, [
		T + '// 选择列编译：把 fieldsFlat（或 fields 展开后的有序列表）变成 select 列表文本。',
		T + '// [权衡] fieldsFlat 优先于 fields：query-builder 已排好序时直接复用，避免二次遍历破坏顺序（INV-MD#03）。',
		T + '// isSingleTable 决定是否给列加表限定：有 join 必须加，否则同名列无法区分（INV-MD#05）。',
		T + '// 输出是一段可嵌入的 SQL 片段，不含 select/from 关键字。',
	]],
	[218, [
		T + T + '// 预先记录长度，用于判断是否追加 `, ` 分隔符；分隔符跟随前一项，避免尾逗号。',
	]],
	[221, [
		T + T + '// 每项独立产出 chunk 数组，保证「表达式 + as 别名 + 分隔符」作为整体加入。',
	]],
	[223, [
		T + T + T + '// 已标记 selection field 的 SQL.Aliased 只输出别名本身（常见于外层引用内层 data 列），',
		T + T + T + '// 不再重复表达式，否则同一表达式会被渲染两次。',
	]],
	[226, [
		T + T + T + T + '// 普通 SQL / SQL.Aliased 走 queryChunks 重写：单表时把其中的列对象替换为不带表限定的标识符。',
	]],
	[228, [
		T + T + T + T + '// [权衡] 新建 SQL 而非原地改 queryChunks：原 SQL 可能被多个 builder 共享，原地改写会污染其他语句。',
	]],
	[243, [
		T + T + T + T + '// SQL.Aliased 必须补 `as 别名`；别名用 identifier 转义，保留用户给定的大小写。',
	]],
	[246, [
		T + T + T + '// 裸列：单表输出列名，多表输出带表名（由列自身的 SQL 渲染决定）。',
		T + T + T + '// [失败路径] 到这里仍未命中的类型会被静默跳过，依赖 SelectedFieldsOrdered 只含上述几类（类型层保证）。',
	]],
	[252, [
		T + T + T + '// 子查询作为选择项时只取一层 decoder，用于把子查询单列结果按该列的类型映射解码。',
	]],
	[253, [
		T + T + T + T + '// selectedFields 的键序即子查询输出顺序，entries 长度为 1 才判定为「单列」。',
	]],
	[261, [
		T + T + T + T + T + '// decoder 来源按 SQL / Column / SQL.Aliased 三种包装分别取；',
		T + T + T + T + T + '// 缺失时保持 undefined，解码端按原值透传。',
	]],
	[267, [
		T + T + T + T + T + '// 直接把 decoder 挂到子查询 SQL 上：后续 sqlToQuery 展平时已无机会补，必须在此刻完成。',
	]],
	[271, [
		T + T + T + T + '// 子查询整体入列，不加别名（别名由 Subquery 自身渲染）。',
	]],
	[274, [
		T + T + T + '// 分隔符加在除最后一项之外的每项尾部。',
	]],
	[284, [
		T + '// limit 接受数值与 Placeholder：数值必须 >= 0（负数视为未设置），对象一律视为占位符。',
		T + '// [权衡] 负数不报错而是忽略：与 LIMIT 语义一致，也避免构建期对用户输入抛异常。',
	]],
	[291, [
		T + '// 空数组等价于未设置，不输出 `order by`（空列表会产生非法 SQL）。',
	]],
	[294, [
		T + T + '// 表达式之间统一以 `, ` 连接；列的表限定由列自身渲染决定。',
	]],
	[299, [
		T + '// SELECT 编译主入口：with → select → distinct → 选择列 → from → joins → where → group by →',
		T + '// having → order by → limit → offset → 锁子句 → set operators，顺序即 SQL 语法要求的顺序。',
		T + '// [权衡] 一次性模板拼接而非逐步 append：undefined 片段由 SQL 拼接层忽略，省掉大量条件分支。',
		T + '// joins 的 lateral 标记原样透传为 `lateral`；服务端是否支持取决于版本，',
		T + '// 本函数不做能力探测，不支持时由服务端解析错误暴露。',
	]],
	[315, [
		T + T + '// fieldsFlat 是 query-builder 排好序的扁平列表；缺省时才从嵌套 fields 递归展开（INV-MD#03）。',
	]],
	[316, [
		T + T + '// [失败路径] 选择项出现「不属于本表也不属于任何 join」的列时立即抛错：',
		T + T + '// 这类列在生成的 SQL 里无法解析，提前失败比数据库返回 unknown column 更容易定位。',
	]],
	[336, [
		T + T + T + T + '// 表名校验用 BaseName：别名表也要能匹配到 join 上的 alias。',
	]],
	[337, [
		T + T + T + T + '// 错误信息带字段路径（如 `user->id`），便于在多级嵌套选择中定位。',
	]],
	[347, [
		T + T + '// INV-MD#05：仅当 joins 为空（或未传）才允许省略表限定。',
	]],
	[349, [
		T + T + '// WITH 仍由统一入口生成，保证位于语句最前（INV-MD#06）。',
	]],
	[351, [
		T + T + '// distinct 只作用于选择列，位置固定在 select 之后、列之前。',
	]],
	[353, [
		T + T + '// 选择列在此一次性生成，后续不再改动（INV-MD#03）。',
	]],
	[355, [
		T + T + '// [权衡] 表别名用 OriginalName + ` as ` Name 渲染，而不是直接输出别名：',
		T + T + '// 这样 `from 真实表名 as 别名` 能同时保留真实表名与用户别名，',
		T + T + '// 跨库引用也不会丢失 schema。',
	]],
	[367, [
		T + T + '// joins 片段按配置顺序拼接；顺序会影响优化器的连接顺序，因此不做重排。',
	]],
	[370, [
		T + T + T + '// 每个 join 产出 `type join [lateral] table [alias] [on ...]`；on 缺省时仅用于 cross join。',
	]],
	[375, [
		T + T + T + T + '// [权衡] lateral 关键字直接取 joinMeta.lateral：select.ts 的 *JoinLateral API 会显式置位，',
		T + T + T + T + '// relational query 递归构造的子查询同样置 true（见 buildRelationalQuery 的 joins.push）。',
		T + T + T + T + '// 若服务端版本不支持 LATERAL，错误以服务端解析错误暴露，而不是在构建期静默降级。',
	]],
	[378, [
		T + T + T + T + '// 表对象按 SingleStoreTable / View / 其他 三类分别渲染，差异只在「别名是否需要显式输出」。',
	]],
	[382, [
		T + T + T + T + T + '// 仅当用户给了别名（Name 与 OriginalName 不同）时才追加别名，避免 `t t` 这种冗余。',
	]],
	[388, [
		T + T + T + T + '// View 元数据来自 ViewBaseConfig，字段名与表不同，但别名判定规则一致。',
	]],
	[398, [
		T + T + T + T + '// 其他（Subquery / 任意 SQL）直接交给 SQL 渲染，别名由对象自身携带。',
	]],
	[409, [
		T + T + '// join 之间用一个空格分隔，模板里不再重复加空格。',
	]],
	[411, [
		T + T + '// where 缺省即不输出；片段位置固定在 group by 之前。',
	]],
	[413, [
		T + T + '// having 与 where 同为条件片段，但只能出现在 group by 之后。',
	]],
	[417, [
		T + T + '// group by 为空数组时视为未设置，避免 `group by ` 悬空。',
	]],
	[421, [
		T + T + '// limit/offset 复用同一判定，保持与 delete/update 一致。',
	]],
	[425, [
		T + T + '// 锁子句：`for <strength>` 后按配置追加 nowait / skip locked，二者互斥（noWait 优先）。',
		T + T + '// [权衡] strength 用 sql.raw 直出：取值来自 query-builder 的枚举（update/share），',
		T + T + '// 属受控常量，不构成注入面（INV-MD#09）。',
	]],
	[436, [
		T + T + '// 主查询与 set 操作共用同一份片段顺序；带 set 时由 buildSetOperations 包裹。',
	]],
	[439, [
		T + T + '// INV-MD#10：锁子句已固化在本层 SELECT 尾部，set 操作的内层不再追加。',
	]],
	[446, [
		T + '// UNION / INTERSECT / EXCEPT 链的递归折叠：每次取最左两个 SELECT 组成一层，',
		T + '// 结果作为下一层的 leftSelect，最终形成左深树；括号由 buildSetOperationQuery 负责。',
		T + '// [权衡] 递归而非迭代：每层复用同一构造器，保证括号嵌套与运算符优先级一致。',
	]],
	[450, [
		T + T + '// 空数组是调用方违约，立即抛错，避免生成 `()` 之类的非法 SQL。',
	]],
	[456, [
		T + T + '// 只剩一个运算符时收口，返回最终 SQL。',
	]],
	[461, [
		T + T + '// rest 非空时把当前层结果作为新的左操作数继续折叠（见上方 Some recursive magic here）。',
	]],
	[467, [
		T + '// 生成 `(left) <op> [all] (right) [order by ...] [limit ...] [offset ...]`。',
		T + '// 两侧 SELECT 都强制加括号，否则 UNION 与 ORDER BY/LIMIT 的归属会产生歧义。',
		T + '// orderBy/limit/offset 只作用于整个集合运算结果，不进入任何一侧。',
	]],
	[474, [
		T + T + '// 用 getSQL() 取原 SQL 再包括号：直接嵌入 SQL 对象会让外层模板的括号与参数顺序错位。',
	]],
	[477, [
		T + T + '// orderBy 需要去表限定：集合运算结果没有表名，`table`.`col` 在此非法（见下方英文注释）。',
	]],
	[481, [
		T + T + T + '// 逐项重写：列对象换成裸列名标识符，SQL 表达式则深入 queryChunks 替换其中的列对象。',
		T + T + T + '// [权衡] 对 SQL 表达式做原地改写而非重建：重建需完整遍历 AST，',
		T + T + T + '// 这里只替换 Column 节点，其余 chunk 原样保留。',
	]],
	[483, [
		T + T + T + '// 注意替换发生在用户传入的 SQL 对象上，因此同一 SQL 对象不能复用于带表限定的场景。',
		T + T + T + '// 实际使用中 orderBy 由 query-builder 每次新建，不存在跨语句共享。',
	]],
	[508, [
		T + T + '// limit/offset 与主 SELECT 同一判定口径，数值 < 0 视为未设置。',
	]],
	[512, [
		T + T + '// 运算符连同 ALL 一起用 sql.raw 输出；type 来自 set 操作 API 的枚举，属受控常量。',
	]],
	[514, [
		T + T + '// offset 排在 limit 之后，符合 MySQL 系语法。',
	]],
	[519, [
		T + '// INSERT 编译：insert [ignore] into → 列清单 → values 列表 → [on duplicate key ...]。',
		T + '// 同时返回 generatedIds：构建期由 defaultFn 生成的 id/时间戳必须回传给调用方，',
		T + '// 因为 SingleStore 不支持 RETURNING（返回语句里也没有 returning 片段）。',
		T + '// values 按传入顺序逐行展开，行的顺序即插入顺序，不做去重或重排（INV-MD#01）。',
	]],
	[529, [
		T + T + '// valuesSqlList 里穿插 `, ` 分隔片段，与行数据同构，最终一次 join 成文本。',
	]],
	[530, [
		T + T + '// 列清单取 table 的列定义顺序而非用户对象的键序：同一表结构必得同一 SQL（INV-MD#01）。',
	]],
	[531, [
		T + T + '// shouldDisableInsert 的列（如 generated always）不参与 insert，连列名都不出现。',
	]],
	[535, [
		T + T + '// insertOrder 只生成一次并复用于所有行，保证列顺序与 values 的字段顺序严格对应。',
	]],
	[538, [
		T + T + '// 逐行构造 value 列表；generatedIds 与行一一对应，缺失的键不会出现在结果对象里。',
	]],
	[541, [
		T + T + T + '// 单行的字段顺序必须与 insertOrder 完全一致，否则值会错列。',
	]],
	[543, [
		T + T + T + T + '// 缺值判定同时覆盖「键缺失」与「Param 值为 undefined」：后者常见于可选字段被显式跳过。',
	]],
	[549, [
		T + T + T + T + T + '// [权衡] 缺列时按 defaultFn → onUpdateFn → default 三级回退：',
		T + T + T + T + T + '// defaultFn 是客户端默认值（需回传 generatedIds），onUpdateFn 是客户端侧更新时间戳，',
		T + T + T + T + T + '// 都没有时才输出 SQL 的 `default` 关键字，交给服务端默认值。',
	]],
	[557, [
		T + T + T + T + T + '// 仅当列未声明 default 且有 onUpdateFn 时才用 onUpdateFn 兜底；有服务端 default 时优先 `default`。',
	]],
	[564, [
		T + T + T + T + T + '// 让服务端求值默认值：客户端无法得知序列/表达式的结果。',
	]],
	[566, [
		T + T + T + T + '// 有值时直接用用户给的 SQL 或参数；Param 包装的 defaultFn 结果需登记到 generatedIds。',
	]],
	[574, [
		T + T + T + '// 行数据与 generatedIds 必须同序推进，调用方按 index 对应回填到返回对象。',
	]],
	[583, [
		T + T + '// `insert ignore` 是 MySQL 系语法，SingleStore 同样接受；冲突行被静默跳过，不产生错误。',
	]],
	[585, [
		T + T + '// [权衡] onConflict 以 `on duplicate key` 渲染而不是 `on conflict do update`：',
		T + T + '// SingleStore 沿用 MySQL 的冲突语法，表达式由 query-builder 生成，这里只做前缀拼接。',
		T + T + '// 该片段位于 values 之后，不能再跟 where/returning。',
	]],
	[589, [
		T + T + '// 返回值里 sql 是纯 AST；generatedIds 是构建期副产物，不进入 SQL，只供 session 合并结果。',
	]],
	[595, [
		T + '// INV-MD#09：唯一产出占位符文本的入口。四个 escape* 回调决定标识符/参数/字符串的字面形式，',
		T + '// `?` 的出现顺序必须与 params 顺序一致，因此这里不允许再插入任何自定义文本。',
		T + '// invokeSource 仅用于区分 indexes 场景，不改变编码规则。',
	]],
	[605, [
		T + '// RQB 核心：把 db.query 的配置编译成「主查询 + left join lateral 子查询」，每个关系输出一个 JSON 列。',
		T + '// 与 mysql 的差异：本文件只有这一套 relational 实现（没有 WithoutLateralSubqueries 分支），',
		T + '// 关系子查询固定以 lateral: true 的 left join 挂载；JSON 聚合用 SingleStore 的',
		T + '// JSON_TO_ARRAY / json_agg，而不是 MySQL 的 json_array / json_arrayagg。',
		T + '// 输入：schema 与 tableConfig（列/关系元数据）、queryConfig（用户配置）、tableAlias（本层别名）、',
		T + '//       nestedQueryRelation（非空表示本层被父层当子查询调用）、joinOn（父层给的关联条件）。',
		T + '// 输出：{ tableTsKey, sql, selection }，selection 描述「列 → TS 键 → 关系」的映射供解码递归还原。',
		T + '// 本函数自递归；别名与 joinOn 由父层传入，是理解整段逻辑的关键（INV-MD#07/#08）。',
	]],
	[626, [
		T + T + '// selection 是「产出物描述」而非查询结果；每层递归各建一份，父层据此把子层 JSON 列拼回对象。',
	]],
	[630, [
		T + T + '// limit/offset/orderBy/where 在两条分支里分别赋值，undefined 表示未配置，最终交给 buildSelectQuery。',
	]],
	[633, [
		T + T + '// config === true 是最简形态（findMany() 无参）：全列、无关系、无过滤，直接映射所有列。',
	]],
	[634, [
		T + T + T + '// 单表也统一包 tableAlias，与带 join 的形态共用同一套解码路径（INV-MD#07）。',
	]],
	[643, [
		T + T + T + '// 完整配置分支：列/关系/排序/分页都要做别名化与重写。',
	]],
	[644, [
		T + T + T + '// 构造别名化列映射：用户回调拿到的列天然带别名，where/orderBy 可直接拼进带 join 的语句。',
	]],
	[651, [
		T + T + T + '// where 回调同步求值；返回值必须再做「原表列 → 别名列」重写，因为用户可能直接引用表列。',
	]],
	[658, [
		T + T + T + '// fieldsSelection 先收集「TS 键 → 值」，等 extras 合并后统一转 selection；顺序即用户书写顺序（INV-MD#03）。',
	]],
	[662, [
		T + T + T + '// selectedColumns 只存 TS 键，真正的列对象在最后一步从 tableConfig 取。',
	]],
	[665, [
		T + T + T + '// 列筛选支持 include / exclude 两种模式：出现第一个 true 即切到 include，',
		T + T + T + '// 全 false/undefined 视为 exclude；判定在遍历中完成，因为配置是键序对象。',
	]],
	[668, [
		T + T + T + T + '// 只遍历真实存在的列键，未知键被忽略（避免 typo 静默进入 SQL）。',
	]],
	[677, [
		T + T + T + T + T + '// 先收集「被点名」的列，模式确定后再做反转或过滤。',
	]],
	[681, [
		T + T + T + T + '// include 模式取显式 true 的列；exclude 模式取其余所有列。',
		T + T + T + T + '// 空结果不是错误，交给最后的选择为空的检查统一处理。',
	]],
	[688, [
		T + T + T + '// 未指定 columns 即全列：这是 db.query 与手写 select 的默认差异，',
		T + T + T + '// 也保证 selection 非空（除非 with/extras 提供了内容）。',
	]],
	[693, [
		T + T + T + '// 按 tableConfig.columns 的键序产出，保证选择列顺序稳定（INV-MD#03）。',
	]],
	[698, [
		T + T + T + '// 关系列表按配置键序保存；递归时按 One/Many 归一化，这里的 queryConfig 保持用户原样。',
	]],
	[705, [
		T + T + T + '// falsy 的关系配置被过滤（如 with: { posts: false }），类型谓词让后续 map 不必再断言非空。',
	]],
	[719, [
		T + T + T + '// extras 是用户自定义的表达式列；函数形式在构建期求值一次，不进入运行时。',
	]],
	[722, [
		T + T + T + '// extras 的列同样要重写为别名形式，否则会引用原表（在带 join 的语句里可能歧义）。',
	]],
	[726, [
		T + T + T + T + '// extras 追加在普通列之后，输出顺序为「列 → extras」，与用户配置顺序一致。',
	]],
	[734, [
		T + T + T + '// 转换点：此后 fieldsSelection 作废，selection 保存的是别名化后的字段；',
		T + T + T + '// 两者混用会引入未别名列。',
	]],
	[736, [
		T + T + T + '// SQL.Aliased 的 dbKey 取 fieldAlias（用户显式指定的输出名），普通列取数据库列名。',
	]],
	[751, [
		T + T + T + '// orderBy 归一化为数组：函数形式在构建期求值，结果可能是单值也可能是数组。',
	]],
	[757, [
		T + T + T + '// 列需别名化、表达式需列名重写，两条路径缺一不可；否则 order by 会引用到未 join 的原表。',
	]],
	[767, [
		T + T + T + '// limit/offset 原样透传，只影响本层；递归子查询各自携带自己的分页（见 needsSubquery 分支）。',
	]],
	[771, [
		T + T + T + '// 逐关系递归，本函数最重的一段：每个关系变成一个 left join lateral 子查询，',
		T + T + T + '// 外层再用 `别名.data` 取 JSON 列。别名规则见 INV-MD#07。',
	]],
	[778, [
		T + T + T + T + '// normalizeRelation 把可能省略 fields/references 的关系定义补成确定的列对，多态只在这里消解一次。',
	]],
	[785, [
		T + T + T + T + '// 别名恒为 `${父别名}_${关系 TS 键}`（INV-MD#07）；唯一性由父别名保证，子层 JSON 引用可静态推导。',
	]],
	[786, [
		T + T + T + T + '// joinOn 由「关系列 = 引用列」的等值条件 and 连接；下传子层后与用户 where 合并。',
	]],
	[797, [
		T + T + T + T + '// 递归：One 强制覆盖为 limit: 1（INV-MD#08），用户配置的 limit 被丢弃，因为 One 要求至多一行。',
		T + T + T + T + '// Many 保持用户配置原样，分页由子层的 needsSubquery 分支处理。',
	]],
	[812, [
		T + T + T + T + '// 关系值统一从子查询的 `data` 列取：子查询内部已把整行折叠成 JSON（见下方 nestedQueryRelation 分支）。',
	]],
	[815, [
		T + T + T + T + '// [权衡] join 条件写 `on true`：真正的关联条件已下推进子查询的 where，',
		T + T + T + T + '// 这里只是语法占位（left join lateral 必须有 on 子句）；',
		T + T + T + T + '// lateral: true 让子查询能引用父层列，这是本节与普通 join 的本质差别。',
	]],
	[822, [
		T + T + T + T + '// selection 记录 relationTableTsKey 与子层 selection，解码端据此递归还原嵌套对象（INV-MD#07）。',
	]],
	[833, [
		T + T + '// [失败路径] 没有可选列时抛 DrizzleError：columns 全 false 且 with/extras 为空属配置矛盾。',
	]],
	[841, [
		T + T + '// joinOn 与自身 where 合并：子层 where 必须同时含「与父行关联」和「用户过滤」，否则会扫全表。',
	]],
	[843, [
		T + T + '// 嵌套模式：把本行折叠成单个 JSON 列 `data`；顶层模式直接输出列，由 session 组装对象。',
	]],
	[844, [
		T + T + T + '// [方言差异] 单行用 JSON_TO_ARRAY 包成数组：SingleStore 没有 MySQL 的 json_array 构造器，',
		T + T + T + '// 但提供 JSON_TO_ARRAY 作为等价的行→JSON 数组转换。',
		T + T + T + '// Many 关系在下一段再套 json_agg，把多行聚合成一个数组（对应 MySQL 的 json_arrayagg，',
		T + T + T + '// 但此处没有 coalesce 兜底，空集结果为 NULL）。',
	]],
	[856, [
		T + T + T + '// Many 用 json_agg 聚合多行；空集时聚合结果为 NULL，解码端需按 null 处理。',
	]],
	[859, [
		T + T + T + '// 别名 data 必须与父层 `${alias}.data` 的字面一致（INV-MD#07）；nestedSelection 只有这一项。',
	]],
	[870, [
		T + T + T + '// STEP：limit/offset/orderBy 不能直接作用在 json_agg 上，有分页或排序时必须先做一层内层 SELECT。',
	]],
	[874, [
		T + T + T + '// 内层选出全部列（sql.raw 星号）；有 orderBy 时附带 row_number()，让「排序结果」成为可选择的列。',
	]],
	[898, [
		T + T + T + T + '// 分页/排序已下沉内层，必须清空，否则外层再次分页会把结果裁成 0 行。',
	]],
	[902, [
		T + T + T + '// 无分页时直接别名化原表，少一层嵌套。',
	]],
	[906, [
		T + T + T + '// 外层：内层结果作 from，唯一选中列是 data；此层带 joins（更下一层的关系），形成递归嵌套。',
	]],
	[924, [
		T + T + '// 顶层路径：selection 里的字段别名化后交给 buildSelectQuery，与嵌套路径的差别只是不折叠 JSON。',
	]],
	[925, [
		T + T + T + '// 顶层不做 JSON 包装：每个列直接作为结果列，',
		T + T + T + '// session 按 selection 的 dbKey/tsKey 组装对象。',
	]],
	[943, [
		T + T + '// 返回值不含执行信息：参数绑定与结果解码都在 session 侧完成；sql 仍是未展平的 AST（INV-MD#09）。',
	]],
];

inserts.sort((a, b) => b[0] - a[0]);
let total = 0;
let last = Infinity;
for (const [line, arr] of inserts) {
	if (!Number.isInteger(line) || line < 1 || line > lines.length + 1) {
		throw new Error('bad anchor: ' + line);
	}
	if (line >= last) throw new Error('anchor not strictly descending: ' + line);
	last = line;
	for (const s of arr) {
		if (!s.trim().startsWith('//')) throw new Error('non-comment: ' + s);
		if (s.includes('*/')) throw new Error('star slash: ' + s);
	}
	lines.splice(line - 1, 0, ...arr);
	total += arr.length;
}
fs.writeFileSync(file, lines.join('\r\n'));
console.log('inserted=' + total);
