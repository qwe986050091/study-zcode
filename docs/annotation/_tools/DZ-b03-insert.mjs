// B03（relations.ts）插入脚本：按 1-based 行号在目标行前插入整行 // 注释，倒序应用，保持 CRLF。
import fs from 'node:fs';

const FILE = 'D:/code/opensource/drizzle-orm/drizzle-orm/src/relations.ts';

const inserts = [
  [1, [
    '// 关系（relations）声明层：定义表与表之间 one/many 的方向、连接字段与引用字段，',
    '// 并在 db 初始化时把用户的 schema 对象归一化成运行期可查询的 TablesRelationalConfig。',
    '// 链路位置：schema.ts 导出 relations() → db 构造时 extractTablesRelationalConfig() →',
    '// relational query-builder 用 normalizeRelation() 生成 join → 结果用 mapRelationalRow() 还原。',
    '//',
    '// 不变量表：',
    '// INV-01：fieldName 必须等于 schema 中注册的键名；relations() 用 withFieldName 派生新实例，',
    '//   禁止原地改写，否则同一 Relation 被两表复用时字段名会互相覆盖。',
    '//   （守住位置：relations() 的 Object.fromEntries 与 One/Many.withFieldName）',
    '// INV-02：referencedTableName 是构造期快照；此后的查找一律走 getTableUniqueName(dbName)。',
    '//   （守住位置：Relation 构造函数）',
    '// INV-03：One.isNullable 由 fields 是否全部 notNull 推导，运行期不重算。',
    '//   （守住位置：createOne 的 reduce）',
    '// INV-04：extractTablesRelationalConfig 必须缓冲先于表出现的 Relations 定义，',
    '//   因为 schema 对象键序无保证。（守住位置：relationsBuffer 的两个分支）',
    '// INV-05：normalizeRelation 在信息不足或多义时必须抛错，禁止猜测连接字段。',
    '//   （守住位置：normalizeRelation 的三处 throw）',
    '// INV-06：mapRelationalRow 的 selection 下标必须与 SQL 选择列顺序逐一对应。',
    '//   （守住位置：buildQueryResultSelection.entries() 循环）',
    '//',
    '// 本文件不发起 I/O、不开事务：它是纯声明与纯函数装配层，[事务]/[资源] 语义在下游 session。',
  ]],
  [33, [
    '// 关系基类：只保存"源表 → 引用表 + 关系名"，连接字段留给子类 config。',
    '// [权衡] 不在构造期校验字段：字段缺失统一在 normalizeRelation 阶段报错，',
    '// 这样 schema 声明可以延迟求值——循环引用的两张表天然互相引用，无法按顺序构造。',
    '//',
    '// [不变量] sourceTable 与 referencedTable 只读；别名化交给 alias.ts 的 Proxy，',
    '// 本类不感知别名，因此 alias 后的表仍能按 referencedTableName 命中同一份配置。',
  ]],
  [40, [
    '// referencedTableName 在此快照：后续用 Table.Symbol.Name（而非对象引用）做 schema 反查，',
    '// 保证表被 alias 包装后仍能命中同一份配置。',
    '// [不变量] 子类必须先 super() 才能读 this.config，否则 relationName 尚未写入基类。',
  ]],
  [48, [
    '// 派生带字段名的新实例而非改 this：Relation 可能被多处共享（两表各引一次）。',
    '// [并发] 派生只发生在 db 初始化期，运行期只读，故不需要加锁。',
  ]],
  [51, [
    '// 表级关系容器：把所有关系声明延迟成 config(helpers) 闭包。',
    '// 延迟的意义：one()/many() 需要源表已构造完成，且允许关系之间互相引用。',
    '// [不变量] config 只在 extractTablesRelationalConfig 中求值一次，结果缓存进',
    '// TableRelationalConfig.relations；重复求值会得到彼此不相等的 Relation 实例。',
    '// [权衡] 不缓存求值结果到 Relations 自身：同一 Relations 对象可被多个 db 实例使用。',
  ]],
  [59, [
    '// table 用于反查 dbName；config 保留为闭包，避免模块加载期就展开整张关系图。',
    '// [资源] 闭包持有用户 schema 的强引用，db 生命周期内不会释放，这是预期行为。',
  ]],
  [65, [
    '// 一对一/多对一关系：携带 fields（本表列）与 references（对表列）的显式映射。',
    '// config 可为 undefined —— 此时连接字段只能在 normalizeRelation 阶段从"反向 One"反推。',
    '// [失败路径] 反推失败（对端缺失或多义）由 normalizeRelation 抛错，绝不静默生成笛卡尔积。',
    '// [不变量] One 的语义是"至多一行"；nullable 只影响结果类型，join 仍是 left join。',
  ]],
  [73, [
    '// config 原样保存引用而非拷贝：推导 isNullable 时仍需读同一批列对象。',
    '// [权衡] isNullable 由 createOne 算好传入而非在构造函数推导，',
    '// 保证类型层 Equal<...> 与运行期布尔值来自同一个表达式，不会出现类型与行为不一致。',
  ]],
  [88, [
    '// 派生新 One：保留 config / isNullable，仅写入 fieldName。',
    '// [不变量] 不可直接改 this.fieldName —— config 返回的实例可能被复用。',
  ]],
  [100, [
    '// 一对多关系：只记录目标表；连接字段由对端 One 的 fields/references 反转得到。',
    '// [不变量] Many 没有 config.fields；任何需要字段的地方都必须先 normalizeRelation。',
  ]],
  [105, [
    '// relationName 可选：仅当两表间存在多条关系（多外键）时才必须显式命名。',
  ]],
  [113, [
    '// 派生新 Many，语义同 One.withFieldName：返回副本，保留 relationName。',
    '// [不变量] 返回类型仍是 Many<TTableName>，不因派生而丢失基数信息。',
  ]],
  [124, [
    '// 类型工具：从 schema 中筛出"属于某表"的 Relations 声明键。',
    '// 只按 TTableName 匹配，因此关系可以写在任意 schema 键上（不必与表同名）。',
    '// [权衡] 纯类型层过滤，零运行期成本；代价是按键写错要到查询结果类型上才暴露。',
  ]],
  [130, [
    '// 由 schema 反推某张表的关系配置：键为关系名，值为 Relations 的 TConfig。',
    '// STEP-1 筛选 Relations<TTableName> 的键；STEP-2 取出其 TConfig 作为值。',
    '// [不变量] 推导不递归：嵌套关系由 BuildRelationResult 在查询层再展开。',
    '// [权衡] 不做键名合法性校验，声明错误在类型层暴露，运行期零开销。',
  ]],
  [147, [
    '// 从表的 extraConfig 数组里提取 Relations 声明（旧式写法，与表定义同处）。',
    '// [不变量] 只保留 Relations 元素，索引/主键构造器等 extra config 被类型过滤掉。',
  ]],
  [159, [
    '// relations 回调可用的条件运算器集合：与 where 回调收到的 operators 是同一份。',
    '// 全部转出自 sql/expressions，本文件不重新实现任何比较语义。',
    '// [权衡] 用工厂函数而非导出常量对象：返回类型即 Operators，避免手写接口与实现漂移。',
    '// [不变量] 新增运算器只需改这里，Operators 类型与回调入参自动同步。',
  ]],
  [188, [
    '// orderBy 回调专用运算器：只有 asc/desc/sql，刻意不暴露条件函数以防误用。',
  ]],
  [198, [
    '// 以 dbName（含 schema 前缀的唯一名）反查 schema 键对应的表配置。',
    '// [不变量] 映射源是 TableRelationalConfig[\'dbName\'] 而非 tsName；两者可以不同。',
  ]],
  [210, [
    '// 关系查询的声明式配置（findMany/findFirst 的 with 子句形状）。',
    '// columns：布尔掩码，false 表示排除；未列出的列默认全选。',
    '// with：嵌套关系，true 表示全选，对象则递归为下一层 DBQueryConfig；',
    '//   递归时 TRelationType 由 One/Many 决定，TIsRoot 置 false（内层不允许 offset）。',
    '// extras：SQL.Aliased 扩展列，可为函数形式以拿到列与 sql。',
    '// [不变量] where/orderBy/limit 只出现在 \'many\' 分支；offset 只在根查询出现。',
    '// [权衡] 掩码用 boolean 而非字符串数组：省略键与 true 等价，配置更贴近直觉。',
    '// [失败路径] 键名写错在类型层即报错，不会退化成运行期忽略。',
  ]],
  [217, [
    '// 列掩码项：键集合被限制为本表的列名，值为 boolean（false = 排除）。',
    '// [不变量] 省略某个键等价于显式 true；结果类型推导必须遵循同一规则。',
  ]],
  [223, [
    '// 关系名来自 TableRelationalConfig[\'relations\'] 的键，类型层直接挡住拼写错误。',
  ]],
  [226, [
    '// true 简写 = 该关系全选；类型上仍会推导成完整模型，而非 unknown。',
  ]],
  [230, [
    '// 递归下降时用 referencedTableName 反查对表配置，保证嵌套层仍能拿到列类型。',
  ]],
  [238, [
    '// extras 允许两种形态：直接给 SQL.Aliased，或用 (fields, { sql }) 构造。',
    '// [不变量] 函数形态的返回值仍是 SQL.Aliased，decoder 由别名列自带。',
  ]],
  [240, [
    '// 函数形态用于"需要引用列但不想在声明期捕获列对象"的场景，例如聚合别名。',
  ]],
  [245, [
    '// extras 回调只给 sql，不开放比较运算器：扩展列是投影，不是过滤条件。',
  ]],
  [249, [
    '// \'many\' 专属子句：where/orderBy/limit 直接作用于子查询，而不是父查询。',
    '// [权衡] 不提供 having：关系查询不暴露聚合，聚合应走 select + groupBy。',
  ]],
  [250, [
    '// 子句作用域是子查询本身；父查询的过滤由调用方的根查询条件负责。',
  ]],
  [251, [
    '// where 支持直接给 SQL 或回调；回调拿到的 fields 是已选列的投影。',
  ]],
  [254, [
    '// 回调形态的 fields 类型是"已选列"的简单投影，未选列不可引用。',
  ]],
  [261, [
    '// 排序支持单值或数组；数组按顺序生成多个 ORDER BY 项。',
  ]],
  [262, [
    '// orderBy 回调形式便于写 asc(col) 这类表达式，返回值同样接受单值或数组。',
  ]],
  [271, [
    '// limit 允许 Placeholder，供 prepared statement 在运行期绑定数值。',
  ]],
  [273, [
    '// offset 仅根查询可见：嵌套关系没有稳定行序，分页语义不成立。',
  ]],
  [279, [
    '// 运行期表配置：tsName 是 schema 键，dbName 是 SQL 中的真实名（可能带 schema 前缀）。',
    '// columns/relations 都来自 Symbol 元数据，查询期只读——改写会影响同进程其他连接。',
    '// [不变量] primaryKey 顺序即列声明顺序，关系查询的默认排序依赖它保持稳定。',
  ]],
  [290, [
    '// 一次 db 初始化得到的只读快照：fullSchema 保留原始对象供用户代码继续引用，',
    '// schema 是归一化结果，tableNamesMap 用于 dbName → tsName 反查。',
    '// [不变量] 三者必须来自同一次 extractTablesRelationalConfig 调用，混用会错配表。',
  ]],
  [298, [
    '// 类型层：把用户 schema 收敛成 TablesRelationalConfig 的形状。',
    '// 只保留 Table 键；relations 通过 ExtractTableRelationsFromSchema 按 dbName 关联，',
    '// 因此关系声明可以写在任意 schema 键上。',
    '// [权衡] 与运行期 extractTablesRelationalConfig 是两套独立实现，必须保持同构。',
  ]],
  [302, [
    '// 只有 Table 键参与映射；Relations 声明在下一步按 dbName 关联回来。',
  ]],
  [305, [
    '// tsName 取 schema 键，dbName 取 Symbol.Name，二者在查询与 SQL 中分工不同。',
  ]],
  [308, [
    '// 关系通过表名（非键名）匹配，因此 relations() 可以写在任意 schema 键上。',
  ]],
  [317, [
    '// extras 既可能是值也可能是函数，类型层统一取其"结果类型"。',
  ]],
  [320, [
    '// with 子句 → 结果字段的类型推导。',
    '// STEP-1 只挑 with 中显式出现（非 undefined）且存在于 relations 的键；',
    '// STEP-2 用 referencedTableName 找到对表，递归 BuildQueryResult 得到子结果；',
    '// STEP-3 One 输出 TResult | null（仅 isNullable=false 时追加 null），Many 输出 TResult[]。',
    '// [不变量] nullable 判定来源是 TRel[\'isNullable\'] 与 false 的 Equal，',
    '// 与 SQL 的 left join 事实同源，不允许单独改一处。',
  ]],
  [326, [
    '// 键集合 = with 的非 undefined 键 ∩ 本表 relations 的键。',
  ]],
  [330, [
    '// 用 referencedTableName 反查对表配置，再递归推导子查询结果类型。',
  ]],
  [334, [
    '// 基数分支：One 且 isNullable=false 时结果可为 null（left join 未命中）；Many 恒为数组。',
  ]],
  [341, [
    '// 过滤掉值为 undefined 的键：DBQueryConfig 里未写的键在类型上就是 undefined。',
  ]],
  [349, [
    '// 查询结果类型总装：columns（掩码）+ extras（SQL.Aliased）+ with（关系）三段合并。',
    '// STEP-1 全选（true）直接 InferModelFromColumns；',
    '// STEP-2 掩码为 false 时排除列，为 true/省略时保留；',
    '// STEP-3 extras 取 SQL.Aliased[\'_\'][\'type\']；STEP-4 with 递归 BuildRelationResult。',
    '// [不变量] 三段结果用 Simplify 交叉合并，顺序不影响结果类型。',
  ]],
  [355, [
    '// 掩码分支：Equal<..., false> 为 true 表示"全排除再显式加回"，否则按 true 逐个挑列。',
  ]],
  [357, [
    '// 排除模式：先从列集合中拿掉显式 false 的键，剩余全部保留。',
  ]],
  [373, [
    '// 包含模式：只挑值为 true 的键；一个 false 都没有时才走这里。',
  ]],
  [384, [
    '// extras 分支：函数形态先取返回类型，再取每个 SQL.Aliased 的类型参数。',
  ]],
  [388, [
    '// 输出键必须非 undefined，值被 Assume 成 SQL.Aliased 后取其类型。',
  ]],
  [397, [
    '// with 段：把每层关系类型递归展开，最终与根列、extras 交叉合并成结果对象。',
  ]],
  [406, [
    '// 关系声明契约：fields 属本表、references 属对表，两者按位置一一对应。',
    '// [不变量] 数组长度由 ColumnsWithTable 在类型层约束为等长，运行期不再校验。',
    '// [权衡] 不校验列是否真属该表：类型约束已足够，运行期校验会拖慢 db 初始化。',
  ]],
  [416, [
    '// db 初始化入口：遍历 schema，把 Table 与 Relations 声明拼装成 TablesRelationalConfig。',
    '// [并发] 只在构造期执行一次，结果被 db 实例持有；执行期间 schema 不得被外部修改。',
    '// [不变量] 输出 tables 的键是 schema 键（tsName），tableNamesMap 是 dbName→tsName 反查表。',
    '// [权衡] 单轮遍历 + 缓冲，而不是先收表再收关系：后者需要两遍扫描。',
    '// [失败路径] 本函数自身不抛错：悬空关系留给 normalizeRelation 在首次查询时暴露。',
  ]],
  [422, [
    '// 兼容 `export default { users, posts }` 形态：仅当整个 schema 只有一个 default 键',
    '// 且其值不是 Table 时，才把 default 展开为 schema。',
    '// [不变量] 用 is() 而非 instanceof，兼容跨包多实例场景。',
  ]],
  [431, [
    '// dbName → schema 键。分离两者的原因：同一表可在不同 schema 下重名，',
    '// 运行期 SQL 必须用带前缀的 dbName，而用户 API 只用 schema 键。',
  ]],
  [433, [
    '// 缓冲尚未见到所属表的 Relations：schema 键序不保证"表在前、关系在后"，',
    '// 直接写入 tablesConfig 会因找不到表而丢失。等表出现时再整体并入。',
    '// [不变量] 缓冲键是 dbName，与 tableNamesMap 一致。',
  ]],
  [438, [
    '// 单轮遍历：命中 Table 建配置，命中 Relations 则合并或缓冲。',
  ]],
  [439, [
    '// Table 分支：先登记反查表，再把缓冲中提前出现的关系与主键并入。',
    '// [不变量] relations 字段先指向缓冲对象本身引用，后续新增关系无需回写。',
  ]],
  [444, [
    '// 初始 relations 直接取缓冲对象；primaryKey 同理，避免二次赋值。',
  ]],
  [446, [
    '// schema 可为 undefined（未指定 PG schema / MySQL database）。',
  ]],
  [452, [
    '// 列级主键：primary 标记来自 column.primary，逐列收集。',
    '// [不变量] 顺序即列声明顺序，关系查询的默认排序依赖它保持稳定。',
  ]],
  [463, [
    '// 表级主键：extraConfig 里可能有 PrimaryKeyBuilder（复合主键），columns 追加到同一数组。',
    '// [权衡] 与列级主键混在一起而不区分子段：运行期只需要"主键列集合"。',
  ]],
  [471, [
    '// Relations 分支：求值 config(helpers) 得到关系字典；表已登记则直接挂上。',
    '// [失败路径] 表不存在时进缓冲而不是报错，因为后面可能才遍历到该表。',
  ]],
  [479, [
    '// 逐条关系挂载；primaryKey 在此恒为 undefined，只有旧式 Relation 携带主键时才回填。',
  ]],
  [486, [
    '// 缓冲路径：以 dbName 为键，relations 与 primaryKey 一起暂存。',
  ]],
  [502, [
    '// 用户 API：声明一张表的关系集合。',
    '// [不变量] 返回前必须对每个关系调用 withFieldName(key)，把 schema 键写进 Relation；',
    '// 否则 normalizeRelation 报错信息里的 fieldName 会是 undefined。',
    '// [权衡] 用 Object.fromEntries + map 保持对象键序与声明顺序一致。',
  ]],
  [509, [
    '// 包一层闭包：真正的 relations(helpers) 延迟到 db 初始化时求值。',
  ]],
  [521, [
    '// one() 工厂：把源表闭包进函数，返回用户声明用的 one(table, config?)。',
    '// 泛型约束 TColumns 只允许本表的列（tableName 匹配），编译期挡住跨表引用。',
    '// [不变量] isNullable 由 fields 的 notNull 全真推导；无 fields 时默认 false。',
    '// [失败路径] fields 为空数组时 reduce 返回 true，即认为非空——这是声明错误，交由校验兜底。',
  ]],
  [535, [
    '// 实参顺序与 One 构造签名一致；isNullable 断言成与泛型 Equal<...> 相同的布尔类型。',
  ]],
  [539, [
    '// reduce 短路求值：任一列可空即整体可空；空数组返回初值 true。',
  ]],
  [545, [
    '// many() 工厂：无需字段推导，只包一层 Many。',
  ]],
  [554, [
    '// 归一化后的连接描述：fields/references 都已确定，方向固定为"源表 → 对表"。',
  ]],
  [559, [
    '// 把任意 Relation 归一化成可直接拼 join 的 (fields, references) 对。',
    '// STEP-1 自带 config 的 One 直接返回其 fields/references；',
    '// STEP-2 否则到对表关系里找"反向关系"，用反向 One 的 fields/references 交换得到；',
    '// STEP-3 找不到或存在多条同名反向关系即抛错。',
    '// [失败路径] 全部走 throw：错误的连接条件会静默产生错误行集，必须 fail-fast。',
    '// [资源] 本函数只读 schema，不缓存结果；调用方（query-builder）自行决定复用。',
  ]],
  [564, [
    '// 快路径：字段显式声明，无需反查。',
  ]],
  [571, [
    '// 反查对表：表名一律用 getTableUniqueName（含 schema 前缀）为键。',
    '// [失败路径] 表未注册即抛错，通常意味着该表没有纳入 db(schema)。',
  ]],
  [578, [
    '// tableNamesMap 命中的 tsName 必须能在 schema 中取到配置，否则是内部不一致。',
  ]],
  [583, [
    '// 源表同样必须可反查：Many 场景要靠它匹配"对端指向本表"的关系。',
  ]],
  [591, [
    '// 收集反向关系：命名关系按 relationName 匹配，匿名关系按 referencedTable 是否指回本表匹配。',
    '// [不变量] 必须排除 relation 自身（自引用表会同时命中正向与反向）。',
  ]],
  [593, [
    '// 遍历对表的全部关系，挑出"指回源表"的那些。',
  ]],
  [597, [
    '// 匹配条件分两类：显式命名时同名即反向；匿名时靠目标表引用方向判断。',
  ]],
  [599, [
    '// 排除自身：自引用表（树形结构）会同时命中正向与反向关系。',
  ]],
  [608, [
    '// 多义直接失败：同一对表存在多条可用连接时无法自动选择。',
    '// [失败路径] 文案区分"同名多义"与"匿名多义"，后者提示显式指定 relationName。',
  ]],
  [620, [
    '// 反向 One 带 config 时交换 fields/references：反向的 fields 是本表列，正好作 references。',
  ]],
  [621, [
    '// 只有带 config 的反向 One 才能提供确定字段；Many 或匿名 One 都不够。',
  ]],
  [631, [
    '// 兜底：反向关系不是带 config 的 One，信息不足即报错。',
  ]],
  [636, [
    '// helpers 工厂：relations 回调里可用的 one/many 都绑定到当前源表。',
  ]],
  [649, [
    '// 关系查询的中间结果：把 select 出来的扁平行按 selection 树还原成嵌套对象。',
    '// selection 的每一项描述一个输出键来自哪一列，以及它可能挂载的子 selection。',
    '// [不变量] sql 字段是根表或组合 SQL，仅供调试/日志，不参与解码。',
  ]],
  [666, [
    '// 行还原：按 selection 顺序消费 row 的每一列，isJson 的列再递归还原嵌套关系。',
    '// [不变量] selectionItemIndex 与 SQL 选择列顺序严格对齐；任何插入列都要同步 selection。',
    '// [并发] 纯函数，不共享状态；同一 row 可被多个连接并行还原。',
    '// [失败路径] JSON.parse 失败直接向上抛，不尝试容错——说明 SQL 侧聚合已出错。',
  ]],
  [675, [
    '// 用 entries() 而不是纯下标：下标即列位置，必须与 selection 数组一致。',
  ]],
  [681, [
    '// 嵌套关系分支：驱动可能给 JSON 字符串（pg json 列）或已解析数组（部分驱动）。',
    '// [不变量] One/Many 的区分只看 Relation 元数据，不看数据形状。',
  ]],
  [688, [
    '// 统一成数组：One 取首行语义由后续分支处理，Many 逐行递归。',
  ]],
  [691, [
    '// One：subRows 为空（null/[]/{}）时结果为 null，非空则还原单行。',
  ]],
  [692, [
    '// 空数组在 JS 中为真值，必须由 mapRelationalRow 内部对空 selection 返回空对象。',
  ]],
  [700, [
    '// Many：逐行还原，返回数组；顺序完全由 SQL 的 orderBy 决定，本层不重排。',
  ]],
  [709, [
    '// 普通列分支：先交给驱动层的 mapColumnValue（时区/类型归一化），再解码。',
  ]],
  [712, [
    '// decoder 三选一：Column 自带；SQL 取其 decoder；SQL.Aliased 取内层 sql 的 decoder。',
  ]],
  [714, [
    '// Column：直接使用列自带的 decoder（含自定义类型转换）。',
  ]],
  [715, [
    '// SQL 片段：取构建时挂上的 decoder；无 decoder 时按原值返回。',
  ]],
  [720, [
    '// null 保持 null（不调用 mapFromDriverValue），避免自定义映射把 null 变成默认值。',
  ]],
];

const text = fs.readFileSync(FILE, 'utf8');
if (!text.includes('\r\n')) throw new Error('not CRLF');
const lines = text.split('\r\n');
for (const [lineNo, comments] of [...inserts].sort((a, b) => b[0] - a[0])) {
  lines.splice(lineNo - 1, 0, ...comments);
}
fs.writeFileSync(FILE, lines.join('\r\n'));
console.log('added ' + inserts.reduce((n, x) => n + x[1].length, 0) + ' lines, blocks=' + inserts.length);
