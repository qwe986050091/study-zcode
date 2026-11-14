// B05 插入脚本：utils / select.types / tracing / tracing-utils / query-builder。
import fs from 'node:fs';
import path from 'node:path';

const REPO = 'D:/code/opensource/drizzle-orm';

const plan = {
  'drizzle-orm/src/utils.ts': [
    [1, [
      '// 查询执行期的通用工具：行还原（mapResultRow）、选择字段展平（orderSelectedFields）、',
      '// update set 归一化（mapUpdateSet），以及类型层工具集合。',
      '// 链路位置：dialect 执行 SQL 得到 raw row → 本文件按 SelectedFieldsOrdered 还原对象 → 返回用户；',
      '// 类型工具被 query-builders 的类型定义大量引用。',
      '//',
      '// INV-01：mapResultRow 的下标与 orderSelectedFields 的输出顺序一一对应，二者不可单独改。',
      '// INV-02：joinsNotNullableMap 只在 path.length===2 且整组列同表时判定可空，混合表必须放弃判定。',
      '// INV-03：mapUpdateSet 必须把裸值包成 Param，否则 driver 侧无法识别绑定参数。',
      '// INV-04：Equal 是类型层严格相等，不能替换成 extends 判断（后者对联合类型会误判）。',
    ]],
    [15, [
      '// 把一行驱动值还原成嵌套对象：path 描述嵌套层级，最后一跳写入解码后的值。',
      '// STEP-1 逐列定位解码器；STEP-2 按 path 建中间对象；STEP-3 末级写值并判定整表可空。',
      '// [不变量] 返回对象的键序与 columns 顺序一致，用户看到的键顺序因此稳定。',
      '// [失败路径] 解码器抛错直接冒泡；本层不做单列容错，避免部分成功的数据进入业务。',
      '// [并发] 纯函数，无共享状态，可安全并行还原同一批次的多行。',
    ]],
    [21, [
      '// 记录"嵌套对象 → 是否整组同表"：用于 join 全空时把整个对象置 null，',
      '// 而不是留下只含 null 字段的半空对象。',
    ]],
    [26, [
      '// 解码器来源按 field 种类分派：列自带、SQL 的 decoder、子查询内层 SQL 的 decoder。',
      '// [不变量] 四类必须全部覆盖，漏掉一类会退化成 undefined.mapFromDriverValue。',
    ]],
    [36, [
      '// path 的多级前缀按需创建空对象；同一路径前缀在后继列中复用同一引用。',
      '// [权衡] 用可变对象 + 循环赋值而非不可变合并：行还原是热路径，分配越少越好。',
    ]],
    [43, [
      '// null 原样保留，不进入解码器：避免自定义映射把 null 变成默认值。',
      '// [不变量] 写入位置由 path 末级决定，不允许覆盖已存在的非对象值。',
    ]],
    [46, [
      '// 仅当 path 恰好两层（表.列）且该列来自真实 Column 时，才参与"整表可空"判定。',
      '// [失败路径] 同组出现不同表名即标记 false，放弃置 null，宁可留下部分字段也不误删整表。',
    ]],
    [64, [
      '// 判定收尾：整组同表且该表 join 为 nullable 时，把整个嵌套对象置 null。',
      '// [不变量] 该步骤必须在所有列写完之后执行，否则会把后续列写入已置 null 的对象。',
    ]],
    [76, [
      '// 把用户的选择对象展平成有序数组：表展开为列、嵌套对象保留 path 前缀。',
      '// [不变量] 输出顺序即 SQL 列序，是 mapResultRow 下标对齐的唯一依据。',
      '// [失败路径] 既非列/SQL/子查询也非表与对象的键会按对象递归，错误在更深层暴露。',
    ]],
    [86, [
      '// 叶子节点直接入队；Table 用其列集合递归展开；其余按嵌套对象继续下钻。',
      '// [不变量] SQL.Aliased 在进入本函数前已完成别名化，此处统一按叶子处理。',
    ]],
    [97, [
      '// 键集合与顺序都相等才返回 true：顺序敏感是为了与选择字段的列序保持一致。',
      '// [权衡] 不做集合比较：调用方用它判断"形状未变"，顺序变化同样意味着 SQL 需要重建。',
    ]],
    [115, [
      '// 把 update 的 values 归一化成可直接渲染的 set 映射。',
      '// [不变量] undefined 值必须在此剔除，否则会生成 `col = ?` 且绑定 undefined。',
      '// [失败路径] 过滤后为空直接抛错：空 SET 在 SQL 中非法，提前失败比数据库报错更清晰。',
    ]],
    [134, [
      '// SET 子句的取值类型：SQL 片段、绑定参数、列引用或 null。',
    ]],
    [136, [
      '// 以下为类型层工具：全部零运行期成本，只参与类型推导。',
    ]],
    [138, [
      '// Update：用 TUpdate 覆盖 T 的同名键。',
    ]],
    [144, [
      '// Simplify：把交叉类型展平成单一对象面，仅影响编辑器提示，不改变结构。',
    ]],
    [151, [
      '// Not：布尔取反，用于 nullable 推导。',
    ]],
    [153, [
      '// IsNever：用元组包裹避免条件类型对 never 的分配律。',
    ]],
    [155, [
      '// IsUnion：借分配条件类型检测联合；T 为 never 时返回 false（由上游先判 IsNever）。',
    ]],
    [158, [
      '// SingleKeyObject：要求对象恰好一个键，否则返回 DrizzleTypeError 携带可读文案。',
    ]],
    [162, [
      '// FromSingleKeyObject：同上，但命中单键时返回 Result 而非对象本身。',
    ]],
    [166, [
      '// SimplifyMappedType：仅用于中断条件类型的分配，本身是恒等。',
    ]],
    [168, [
      '// ShallowRecord：把映射类型展平，避免与交叉类型结合后提示冗长。',
    ]],
    [170, [
      '// Assume：只在类型层断言为 U，运行期无操作。',
    ]],
    [172, [
      '// Equal：用条件类型恒等性判断严格相等。',
      '// [不变量] 不能换成 extends（联合类型会误判为 true），这是 nullable 推导正确性的基础。',
    ]],
    [174, [
      '// 类型层错误载体：出现在推导结果里即代表用户用法有误，文案通过 $drizzleTypeError 暴露。',
    ]],
    [178, [
      '// ValueOrArray：接收单值或数组的 API 统一签名。',
    ]],
    [181, [
      '// 把多个类原型上的方法拷贝到基类原型，用于方言 mixin（如 PG 的组合表能力）。',
      '// [不变量] 跳过 constructor，且用属性描述符原样复制，保证 getter/setter 语义不变。',
      '// [权衡] 运行时拷贝而非继承链：绕开多继承限制，代价是原型被永久修改。',
    ]],
    [195, [
      '// Or：两个布尔类型任一为 true 即为 true。',
    ]],
    [197, [
      '// IfThenElse：条件类型的三元封装，提高可读性。',
    ]],
    [199, [
      '// PromiseOf：解开 Promise 取出结果类型，非 Promise 原样返回。',
    ]],
    [201, [
      '// Writable：去掉 readonly 修饰，用于结果对象的可写推导。',
    ]],
    [205, [
      '// NonArray：排除数组类型，用于区分"值"与"值列表"。',
    ]],
    [207, [
      '// 读取表的列集合（Symbol 元数据），是 BuildColumns 结果的运行期视图。',
    ]],
    [211, [
      '// 读取视图的选择字段：视图没有列定义，只能从 ViewBaseConfig 取。',
    ]],
    [216, [
      '// 取可用于 SQL 别名的名字：子查询用 alias、视图用 name、SQL 片段无名字。',
      '// [不变量] 普通表优先用别名（IsAlias），否则退回 BaseName（不含 schema 前缀）。',
      '// [失败路径] SQL 片段返回 undefined，调用方需自行决定是否允许无名 join。',
    ]],
    [228, [
      '// 关系声明用：把本表列数组映射成"位置上对应的对表列"数组，长度由元组约束。',
    ]],
    [234, [
      '// 标识符命名风格：只有这两种取值，缺省表示不转换。',
    ]],
    [236, [
      '// db() 的公共配置：logger/schema/casing/cache 四项，各方言在此基础上扩展连接参数。',
      '// [不变量] 未提供 logger 时默认 DefaultLogger；未提供 casing 时标识符原样输出。',
      '// [权衡] schema 用宽松 Record 泛型，避免在此处引入循环依赖。',
    ]],
    [242, [
      '// 编译期形状校验：T 多出 ValidShape 之外的键时，把多余键名嵌进 DrizzleTypeError 文案。',
      '// [不变量] 只检查键的多余，不检查值的兼容（后者由 T extends ValidShape 保证）。',
      '// [失败路径] 报错位置落在使用处，用户看到的是一行类型错误 + 键名列表。',
    ]],
    [249, [
      '// KnownKeysOnly：把 T 中不属于 U 的键映射成 never，用于禁用未声明的选项。',
    ]],
    [253, [
      '// IsAny：利用 any 与 1 的交叉仍为 any 这一特性检测 any。',
    ]],
    [256, [
      '// 列工厂的参数归一化：支持 col() / col(name) / col(name, config) / col(config) 四种写法。',
      '// [不变量] 名字为空串表示"用表定义里的对象键名"，由 setName 在表定义阶段回填。',
      '// [权衡] 用运行时判别而非重载：列工厂数量多，逐个写重载会指数级膨胀。',
    ]],
    [265, [
      '// IfNotImported：依赖未安装时 T 推出 unknown，用它选择提示文案分支。',
    ]],
    [267, [
      '// 未安装驱动时的类型层错误文案，直接展示给用户。',
    ]],
    [270, [
      '// RequireAtLeastOne：要求 Keys 中至少出现一个键，其余键可选。',
    ]],
    [274, [
      '// 与 DrizzleConfig 手工对齐的形状镜像：两处赋值互为约束，任一侧改字段都会在此报错。',
      '// [不变量] 这是编译期守卫，运行期不产生任何代码。',
      '// [失败路径] 若此处报错，说明 isConfig 的判定分支需要同步新增字段。',
    ]],
    [286, [
      '// 运行期嗅探"第一个参数是配置还是连接串/客户端"，供各方言 db() 重载使用。',
      '// STEP-1 非对象/非纯 Object 直接排除（排除驱动客户端实例）；',
      '// STEP-2 按已知键逐个校验类型；STEP-3 空对象视为配置。',
      '// [失败路径] 未知键一律返回 false，宁可让调用方走连接串分支，也不把客户端当配置。',
      '// [不变量] 新增配置字段必须在此登记，否则会被误判为非配置。',
      '// [权衡] 用 constructor.name 判断纯对象而非原型链：跨 realm 时 name 仍稳定。',
    ]],
    [340, [
      '// Neon Auth 令牌：静态字符串或每次取值的函数（供 RLS 场景动态刷新）。',
    ]],
    [342, [
      '// 共享 TextDecoder：部分运行环境无全局 TextDecoder，缺失时置 null 由调用方降级。',
    ]],
  ],
  'drizzle-orm/src/query-builders/select.types.ts': [
    [1, [
      '// select 的类型层：选择字段 → 结果类型的映射、join 可空性传播、别名化与子查询选择构建。',
      '// 链路位置：各方言 query-builders/select.ts 的返回类型全部由这里推导；本文件是纯类型，无运行期代码。',
      '//',
      '// INV-01：join 可空性只能沿 AppendToNullabilityMap 传播，旁路修改会让结果类型与实际行不符。',
      '// INV-02：SelectPartialResult 对"混合表的嵌套对象"必须递归，只有单表对象才能整体套可空性。',
      '// INV-03：BuildSubquerySelection 必须拒绝未别名的 SQL（DrizzleTypeError），否则子查询列名不可控。',
    ]],
    [9, [
      '// join 种类：决定被 join 表在可空性映射里的初始状态（cross/inner 非空，left/right/full 可空）。',
    ]],
    [11, [
      '// 可空性标记：nullable 表示该表整行可能缺席（left/right/full join 的产物）。',
    ]],
    [13, [
      '// 给结果类型套可空性：nullable → T | null；\'null\' 分支用于全空表。',
    ]],
    [17, [
      '// 给单个列套可空性：改写 `_[\'notNull\']` 从而影响 GetColumnData。',
      '// [不变量] notNull 是唯一可空性来源，不能另加可空标记。',
      '// [权衡] 走 UpdateColConfig 而非重新构造列类型，保证方言扩展字段不丢失。',
    ]],
    [28, [
      '// 按表名把可空性映射逐表套到结果对象上。',
      '// [不变量] 只处理同时出现在结果与映射里的表名，多余键原样保留。',
    ]],
    [37, [
      '// 选择模式：partial 保留嵌套结构，single 单表扁平，multiple 多表按表名分组。',
      '// [不变量] 模式由调用方（from/join 链）决定，不由选择字段形状推断。',
    ]],
    [39, [
      '// 结果类型总入口：按模式分派到三种结果形状。',
      '// [不变量] multiple 模式必须叠加 ApplyNotNullMapToJoins，否则 left join 的表不会被标记可空。',
    ]],
    [47, [
      '// partial 模式：逐键推导，表→全部列，列→单列，SQL→类型，子查询→单列约束。',
      '// [不变量] 嵌套对象先判断是否"整组同表"：是则整体套可空，否则递归。',
      '// [失败路径] 子查询选中多列时通过 FromSingleKeyObject 报类型错误。',
      '// [权衡] 用深递归代替展开所有组合，类型检查成本可控。',
    ]],
    [76, [
      '// 把一组列改挂到别名表：只改 tableName，列类型不变。',
      '// [不变量] 非列的值原样保留，避免把 SQL 片段误改。',
    ]],
    [88, [
      '// 子查询别名化：递归把内部所有列改挂到新别名。',
      '// [不变量] IsAny 短路返回 any，防止 any 选择字段在映射中爆炸。',
      '// [失败路径] 裸 SQL 片段保持原样（无法别名化），需要用户先 .as()。',
    ]],
    [104, [
      '// join 后追加结果：partial 不追加（结构由选择字段决定），single/multiple 按表名分组。',
      '// [不变量] 表名为 undefined 时只返回值本身，不产生 Record 包裹。',
      '// [权衡] 分组信息只在类型层存在，运行期由 orderSelectedFields 的 path 承担。',
    ]],
    [116, [
      '// 子查询的选择字段：展平并应用可空性，同时拒绝未命名 SQL。',
      '// STEP-1 never 输入返回 any；STEP-2 裸 SQL 报 DrizzleTypeError；',
      '// STEP-3 列按所属表的可空性改写；STEP-4 表与嵌套选择递归。',
      '// [不变量] 输出键序必须与子查询实际选择列序一致。',
    ]],
    [133, [
      '// 把整张可空性映射重置为同一个值（right/full join 会让左侧全部可空）。',
    ]],
    [137, [
      '// join 类型 → 可空性传播规则：',
      '// left 只把新表置可空；right 把已有全置可空、新表非空；inner/cross 新表非空；full 全部可空。',
      '// [不变量] 未命名 join（TJoinedName 为 undefined）不改映射。',
      '// [权衡] 用条件类型而非映射表：类型层没有运行时表可查。',
    ]],
    [149, [
      '// 可作为 select 源的对象：表、子查询、视图、SQL 片段。',
    ]],
    [151, [
      '// 取源的表名/别名：SQL 片段没有名字，返回 undefined。',
      '// [不变量] 该名字同时是 nullabilityMap 的键。',
    ]],
    [157, [
      '// 取源的列集合：子查询与视图用 selectedFields，SQL 片段为空对象。',
      '// [失败路径] selectedFields 非 ColumnsSelection 时由 Assume 兜底，属类型层断言。',
    ]],
    [162, [
      '// 单个字段 → 输出类型：表递归展开列、列走 GetColumnData、SQL 取 _[\'type\']。',
      '// [不变量] TDeep 防止表嵌套表时无限递归，第二层起表类型返回 never。',
      '// [失败路径] DrizzleTypeError 原样透传，保留错误文案。',
    ]],
    [169, [
      '// 选择字段对象 → 结果对象：逐键 SelectResultField 并用 Simplify 展平。',
    ]],
    [175, [
      '// 集合运算：union/intersect/except，各分支形状必须一致。',
    ]],
  ],
  'drizzle-orm/src/tracing.ts': [
    [5, [
      '// OpenTelemetry 追踪适配：未安装 @opentelemetry/api 时整体降级为空实现。',
      '// [资源] otel 与 rawTracer 都是模块级缓存，进程内只初始化一次。',
    ]],
    [15, [
      '// span 名称枚举：与 drizzle 内部阶段一一对应，便于在 APM 里按阶段聚合耗时。',
    ]],
    [24, [
      '// [失败路径] 未启用追踪时直接调用 fn，不创建 span 也不吞异常。',
    ]],
    [26, [
      '// [并发] rawTracer 惰性初始化无锁：重复赋值只浪费一次 getTracer，不会产生错误状态。',
    ]],
    [34, [
      '// 用 iife 把 otel/rawTracer 作为参数传入，收窄闭包内类型为非空。',
    ]],
  ],
  'drizzle-orm/src/tracing-utils.ts': [
    [1, [
      '// 立即调用函数表达式的类型安全封装：显式传参，避免闭包捕获导致的可空收窄失效。',
    ]],
  ],
  'drizzle-orm/src/query-builders/query-builder.ts': [
    [1, [
      '// 查询构建器基类：承载"选中字段类型"与 getSQL 契约，各方言 select/insert/update/delete 继承它。',
    ]],
    [4, [
      '// [不变量] `_` 只描述类型，运行期不读取；SQLWrapper 使构建器可直接嵌入 sql 模板。',
    ]],
    [7, [
      '// selectedFields 决定结果类型，config 保留方言可选信息。',
    ]],
    [13, [
      '// [不变量] 必须返回构造期的同一对象引用，调用方依赖其键序推导列序。',
    ]],
  ],
};

for (const [rel, inserts] of Object.entries(plan)) {
  const file = path.join(REPO, rel);
  const text = fs.readFileSync(file, 'utf8');
  if (!text.includes('\r\n')) throw new Error('not CRLF: ' + rel);
  const lines = text.split('\r\n');
  for (const [lineNo, comments] of [...inserts].sort((a, b) => b[0] - a[0])) {
    lines.splice(lineNo - 1, 0, ...comments);
  }
  fs.writeFileSync(file, lines.join('\r\n'));
  console.log(`${rel} +${inserts.reduce((n, x) => n + x[1].length, 0)}`);
}
