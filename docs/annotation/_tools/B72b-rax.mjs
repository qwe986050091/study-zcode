// B72b：src/rax.c 第二片（未覆盖单元 1230–1923，函数边界切片 1230–1938）。
// 输入：VK-B72b/orig/src/rax.c（HEAD 快照，已含 B72a 的 282 行，UTF-8/LF）
// 输出：VK-B72b/spec.json
// 对账：E 必须等于本片未覆盖集合；本片无结构性豁免，SKIP 为空集。
import fs from 'node:fs';

const DIR = 'd:/code/_annot_baseline/VK-B72b';
const REL = 'src/rax.c';
const START = 1230;
const END = 1938;
const src = fs.readFileSync(`${DIR}/orig/${REL}`, 'utf8').replace(/\r\n/g, '\n').split('\n');

// 本片没有需要跳过的预处理行或宏体续行，保留空集合以便对账逻辑不变。
const SKIP = new Set();

const E = [
  // ---- raxGenericInsert 的 oom 收尾 ----
  [1230, '先给 numele 加 1，抵消 1231 行 raxRemove 内部的 numele--，否则回滚后计数偏低。'],
  [1233, '两处失败汇合点都置 errno=ENOMEM，调用方靠它区分 OOM 与「键已存在」。'],
  [1234, '返回 0；若前面走了 raxRemove 分支，树已回到插入前的形态。'],

  // ---- raxInsert / raxTryInsert 两个薄封装 ----
  [1240, 'raxInsert 把 overwrite 置 1 转发给 raxGenericInsert，同键时覆盖旧值。'],
  [1249, 'raxTryInsert 传 overwrite=0：同键已存在时不改值，仅用 old 回填既有值。'],

  // ---- raxFind ----
  [1259, 'h 只在本地声明，作为 raxLowWalk 的出参接收停点节点。'],
  [1261, 'Lookup 日志打印 s 的前 len 字节；未定义 RAX_DEBUG_MSG 时 debugf 展开为空。'],
  [1262, 'splitpos 初值 0，只有停在压缩节点中间时 raxLowWalk 才会写非零值。'],
  [1263, 'stopnode 与 plink 都传 NULL：raxFind 既不需要父链槽位，也不需要压栈。'],
  [1264, '三个判否条件缺一不可：i!=len、停在压缩串中间、或 h->iskey 为假。'],
  [1265, 'value 允许为 NULL；命中时把 raxGetData(h) 交给调用方。'],
  [1266, '返回 1 表示键存在，值已可选地写回 *value。'],

  // ---- raxForEachPrefix ----
  [1280, '从 rax->head 起步，head 自身是 key 时代表空前缀也算命中。'],
  [1281, 'consumed 是已对齐到当前节点的查询串字节数，用于取 s[consumed]。'],
  [1282, 'matches 既统计回调次数，也直接作为本函数返回值。'],
  [1284, 'head 可能就是 key（空前缀），进入下降循环前先报告一次。'],
  [1285, '空前缀命中同样计入 matches，与后续每层命中同等对待。'],
  [1286, 'callback 返回 0 表示停止；此处已 matches++，故返回值含最后一次命中。'],
  [1289, '两个终止条件任一成立即结束：查询串走完，或 h->size 为 0 到达叶子。'],
  [1290, '子指针区起点按 h 的布局算一次，压缩与普通节点都从第 0 个取起。'],
  [1291, 'child_index 默认 0：压缩节点只有一个子，普通节点在 1302 行按边下标覆盖。'],
  [1293, '压缩边整段比较，比较长度取 remaining 与 h->size 的较小值。'],
  [1294, 'remaining 是查询串还没对齐到本节点的字节数。'],
  [1295, 'compare_len 取二者较小值，避免 memcmp 读过 s 的末尾。'],
  [1296, '前缀失配直接 break：压缩边必须整段匹配才能通过这一层。'],
  [1297, 'memcmp 通过后 consumed 前移 compare_len，与压缩串长度严格对齐。'],
  [1298, '只匹配了压缩串的一部分，说明查询串在此处结束，不能继续下降。'],
  [1300, '普通节点用 memchr 在 h->size 条边里找 s[consumed]，边数很小所以够用。'],
  [1301, '没有对应边就 break，前缀链在此断开。'],
  [1302, 'edge - h->data 即该边在 children 数组中的下标。'],
  [1303, '普通节点每层只消费 1 字节，与压缩分支的 compare_len 语义不同。'],
  [1306, '按 child_index 取出子节点写回 h，下一轮以它为当前节点继续。'],
  [1307, '每下降一层都要看子节点是否也是 key，是则构成一次新的前缀命中。'],
  [1308, 'matches 在此加一，对应长度为 consumed 的那个前缀。'],
  [1309, '回调中途拒绝时 break 而非 return，保证返回值仍含已命中数。'],
  [1312, '统一返回 matches；本函数不分配内存，因此没有 OOM 分支。'],

  // ---- raxFindParentLink ----
  [1324, 'cp 从第一个子指针起步，逐个与 child 比较。'],
  [1325, 'c 是 memcpy 出来的副本，避免对未对齐地址直接解引用。'],
  [1326, '无边界循环：调用方保证 child 必在 parent 的子指针区内。'],
  [1327, '每次取 sizeof(c) 字节，宽度与 raxNode* 一致。'],
  [1328, '命中即 break，此时 cp 正指向该子指针的槽位地址。'],
  [1329, '未命中就后移一个指针宽度，越界风险由调用方的前置条件兜底。'],
  [1331, '返回槽位地址，调用方可直接 memcpy 覆盖成新子节点。'],

  // ---- raxRemoveChild：压缩父节点直接退化 ----
  [1344, '调试钩子打印删除前的 parent；RAX_DEBUG_MSG 未定义时整条语句消失。'],
  [1349, 'data 暂存旧值，因为退化后值槽偏移会随 iscompr 变化。'],
  [1350, '只有 iskey 的压缩节点才真的持有值指针，否则 data 保持 NULL。'],
  [1351, '先清 isnull，退化后不再有「键存在但值为空」的语义。'],
  [1352, 'iscompr 清 0 后 parent->size 从字节数变回边数，后续才能按普通节点处理。'],
  [1353, 'size 置 0 表示退化结果没有任何子节点。'],
  [1354, 'raxSetData 按新布局重算值槽偏移并写回 data。'],
  [1355, '删除后再打印一次，用于对照 iscompr 与 size 的变化。'],
  [1356, '压缩分支原地修改，指针不变，调用方无需修父链。'],

  // ---- raxRemoveChild：普通父节点搬移 ----
  [1365, 'c 扫描子指针、e 扫描边字符，两者必须同下标前进。'],
  [1366, 'e 指向 parent->data，即第一条边字符。'],
  [1371, 'aux 存放当前子指针副本，用 memcpy 规避未对齐读。'],
  [1372, '读第 c 个子指针，宽度为 sizeof(aux)。'],
  [1373, 'aux 与 child 相等即 break，此时 e 与 c 的下标都指向它。'],
  [1374, 'c 后移一个指针宽度，继续找 child。'],
  [1375, 'e 与 c 同步后移，保证边字符下标与子指针下标一致。'],
  [1381, 'taillen 是删除点之后需要整体左移的子指针个数。'],
  [1382, '边字符区左移 1 字节，覆盖掉被删的那条边。'],
  [1397, 'tail 子指针连同值槽一起左移 shift 字节，valuelen 保证 key 的值不丢。'],
  [1405, 'newnode 非空说明缩容成功，可以安全使用新地址。'],
  [1406, '只在缩容成功时打印；失败沿用旧地址，日志不输出。'],

  // ---- raxRemove：入口与摘除标记 ----
  [1423, 'h 由 raxLowWalk 回填为待删键所在节点。'],
  [1424, 'ts 保存下降路径上的父节点，回收阶段靠 raxStackPop 自底向上回溯。'],
  [1426, '打印待删键；未开 raxDebugMsg 时 debugf 展开为空宏。'],
  [1427, '栈初始用内联 static_items，深度超过 5 层才走 malloc。'],
  [1428, 'splitpos 初值 0，停在压缩节点中间时由 raxLowWalk 回填。'],
  [1429, '传 &ts 让下降过程压栈，这是回收阶段唯一的父链来源。'],
  [1430, '判否条件与 raxFind 一致：没走完整串、停在压缩串中间、或节点不是 key。'],
  [1431, '提前返回前必须释放 ts，否则 depth>5 时泄漏堆内存。'],
  [1432, '返回 0 表示键不存在，树完全未改动。'],
  [1434, 'old 非空时先回填旧值，因为 h 随后可能被释放。'],
  [1435, '清 iskey 是删除第一步，节点先留着让回收阶段判断形状。'],
  [1436, 'numele 自减与 1230 行的补偿加一配对，保证 OOM 回滚后计数正确。'],

  // ---- raxRemove：叶子清理 ----
  [1445, '续行：trycompress 只在删除留下可合并形状时才置 1。'],
  [1447, 'size 为 0 说明删的是叶子键，可能有一串单链节点可回收。'],
  [1448, 'debugf 日志标记进入清理分支，只有 RAX_DEBUG_MSG 打开时才输出。'],
  [1449, 'child 初值 NULL，同时用于区分「是否真的摘除过子节点」。'],
  [1450, '循环到 head 为止：head 永远保留，不能被释放。'],
  [1451, 'child 记录本轮要释放的节点，下一轮它变成父节点 h。'],
  [1452, '打印待释放节点的地址、边内容与 iskey，便于核对回收顺序。'],
  [1454, '释放前先扣 alloc_size，与 rax_ptr_alloc_size 的记账口径一致。'],
  [1455, 'rax_free 对应建节点时的 rax_malloc，二者必须成对。'],
  [1456, 'numnodes 与 rax_free 同步递减，漏减会让 1650 行的断言失败。'],
  [1457, '出栈拿父节点，继续判断它是否也满足单链非 key 的回收条件。'],
  [1462, 'child 非空说明至少释放过一个节点，父节点 h 上还留着它的子指针。'],
  [1463, '打印父 h 与被摘除的 child，确认父链要改写的对象。'],
  [1464, '记下 raxRemoveChild 之前的父节点尺寸，用于差值记账。'],
  [1465, 'raxRemoveChild 摘掉 child 的边与指针，可能 realloc 出新地址。'],
  [1466, 'alloc_size 按 oldalloc 与 new 的实际尺寸之差更新，不能写死常量。'],
  [1467, 'new 与 h 不等才需要修父链；原地修改时 h 已是最新地址。'],
  [1468, 'peek 不弹栈，栈里还剩 h 的父节点；返回 NULL 说明 h 就是 head。'],
  [1469, 'parentlink 先声明，两个分支分别指向 head 槽位或 parent 内部槽位。'],
  [1470, 'parent 为 NULL 表示 h 是 head，head 没有父节点可查。'],
  [1471, 'head 的槽位就是 &rax->head，写入即替换根指针。'],
  [1473, 'raxFindParentLink 线性扫描 parent，找到指向 h 的那个槽位。'],
  [1475, '把 new 写回父链，此后旧 h 地址不再被任何节点引用。'],
  [1481, '只剩一个子且自身不是 key，删除后可能能与相邻节点合并压缩。'],
  [1482, 'h 改指 new，压缩阶段从这条单链的父节点开始上溯。'],

  // ---- raxRemove：压缩优化 ----
  [1539, 'debugf 打印被删键，标记进入压缩优化阶段。'],
  [1540, 'debugnode 打印压缩候选起点 h，确认它确实是删除受影响的节点。'],
  [1541, 'debugf 提示下一步要向上找到可压缩的起点。'],
  [1547, '无限循环靠内部 break 退出，最多上溯到 head。'],
  [1548, 'raxStackPop 返回 NULL（栈空）是循环的合法终止条件之一。'],
  [1549, '父是 key 或（非压缩且子数不为 1）就不满足压缩前提，停止上溯。'],
  [1550, '父满足条件则把 h 上移，下一轮 continue 看更上一层。'],
  [1551, '打印新的候选起点，便于核对上溯位置。'],
  [1553, 'start 固定压缩起点，稍后要在 parent 中替换它。'],
  [1557, 'nodes 统计将被合并的节点数，初值 1 表示只有起点自己。'],
  [1558, '沿最后一个子节点向下扫描，size 为 0 表示已到叶子。'],
  [1559, '压缩与普通节点都只有一个有效子，取最后一个即可。'],
  [1560, 'memcpy 把子节点写回 h，下一轮用它继续判断能否吞并。'],
  [1561, '子是 key 或子数不为 1 就不能再并入压缩串。'],
  [1565, '可以吞并，nodes 计数加一。'],
  [1566, 'comprsize 累加可压缩字节数，与 1570 行的 nodesize 对应。'],
  [1568, '至少 2 个节点才值得新建压缩节点，否则原地保持不动。'],
  [1571, 'nodesize 含 4 字节头、comprsize 字节、填充与唯一子指针。'],
  [1575, '压缩失败只放弃优化，不影响「键已删除」这一结果。'],
  [1576, '返回 1：树仍一致，调用方不应把它当成删除失败。'],
  [1578, '压缩节点不是 key，iskey 必须清零。'],
  [1579, 'isnull 随 iskey 一并清零，二者语义联动。'],
  [1580, 'iscompr 置 1 后 size 的含义从边数改为字节数。'],
  [1581, 'size 写 comprsize，与 data 实际填充长度一致。'],
  [1582, '新节点先计入 numnodes，随后每个被吞并节点各减一。'],
  [1583, 'alloc_size 加新节点尺寸，与 1596 行的逐个扣减配平。'],
  [1589, '回到起点开始第二轮：这次边复制数据边释放旧节点。'],
  [1590, '同一遍历条件，保证第二轮吞并范围与第一轮完全一致。'],
  [1591, '把 h->data 的 h->size 字节追写到 new->data + comprsize。'],
  [1592, 'comprsize 边写边累加，作为下一次写入的偏移。'],
  [1593, '先取 h 的最后一个子指针，再释放 h，顺序不能反。'],
  [1594, 'tofree 暂存 h，因为 h 马上要被覆盖成子节点。'],
  [1595, 'h 前移到子节点，供下一轮复制。'],
  [1596, '释放前扣 alloc_size，与被吞并节点的实际分配尺寸一致。'],
  [1597, 'rax_free(tofree) 对应这些节点当年的 rax_malloc。'],
  [1598, 'numnodes 同步递减，与 1582 行的加一相互抵消。'],
  [1599, '与第一轮相同的终止条件，两轮吞并范围必须一致。'],
  [1600, '超过 RAX_NODE_MAX_SIZE 就 break：size 字段只有 29 位，再长会溢出节点头。'],
  [1602, '打印新压缩节点，核对 iscompr 与 size 是否符合预期。'],
  [1607, 'new 的唯一子指针指向 h，即第一个不能再吞并的节点。'],
  [1611, '在 parent 中找到指向 start 的槽位，准备替换成 new。'],
  [1612, '父链改为 new，start 及其后继已全部释放。'],
  [1614, 'parent 为 NULL 表示压缩起点就是 head，直接改根指针。'],
  [1617, '打印合并节点数与总字节数，便于对比压缩前后。'],
  [1620, '成功路径同样要释放 ts，depth>5 时它已堆分配。'],
  [1621, '返回 1 表示删除成功，压缩是否发生不影响该返回值。'],

  // ---- raxRecursiveFree ----
  [1631, '调试打印当前节点，先序进入时输出。'],
  [1632, '压缩节点只有 1 个子，普通节点有 n->size 个。'],
  [1633, '从最后一个子指针开始，配合 1638 行的 cp-- 逆序遍历。'],
  [1634, 'numchildren-- 递减到 0 结束，省掉单独的计数变量。'],
  [1635, 'child 用 memcpy 取出，规避对未对齐地址解引用。'],
  [1636, '按 sizeof(child) 复制一个子指针。'],
  [1637, '递归释放子树，父节点必须等所有子节点释放完才能 free。'],
  [1638, '指针回退一格，与 1633 行的「最后一个」起点配合完成逆序。'],
  [1640, 'debugnode 后序打印，此时子树已全部释放。'],
  [1641, '只对「有真值」的 key 调 free_callback；isnull 的键没有值可放。'],
  [1642, 'rax_free(n) 对应建树时的 rax_malloc 或 rax_realloc。'],
  [1643, '每释放一个节点 numnodes 减一，供 raxFreeWithCallback 的断言使用。'],

  // ---- raxFree ----
  [1649, '从 rax->head 开始递归，head 本身也会在这趟里被释放。'],
  [1650, '断言所有节点都已释放；numnodes 记账错会在这里暴露。'],
  [1651, '最后释放树壳，head 已在上一步回收。'],
  [1656, 'raxFree 是回调为 NULL 的薄封装，不释放任何存放的值。'],

  // ---- raxStart ----
  [1667, '初始置 EOF：未 seek 就调 raxNext 会安全返回结束，而不是解引用未初始化的 node。'],
  [1669, 'key_len 从 0 起，raxStart 之后还没积累任何边字符。'],
  [1670, 'key 指向内联缓冲 key_static_string，raxStop 据此判断是否需要 free。'],
  [1671, 'key_max 与内联缓冲容量 RAX_ITER_STATIC_LEN 一致，超出才扩容。'],
  [1672, 'data 在命中时回填，先置 NULL 避免调用方误用。'],
  [1673, 'node_cb 默认关闭，需要节点迁移回调的调用方再自行设置。'],
  [1674, '栈同样先走内联 static_items，迭代深度超过 5 层才 malloc。'],

  // ---- raxIteratorAddChars ----
  [1686, '追加 0 字节是空操作，直接返回成功，不触发扩容。'],
  [1687, '容量不足才扩容，条件是 key_max < key_len + len。'],
  [1688, 'old 为 NULL 表示当前用内联缓冲，realloc 不能直接作用于它。'],
  [1689, '新容量取需求的 2 倍，摊薄后续追加的扩容次数。'],
  [1690, 'old 为 NULL 时 rax_realloc 等价于 malloc 一块 new_max 字节。'],
  [1691, 'realloc 失败时 it->key 已被覆盖成 NULL，必须回滚。'],
  [1692, '恢复原存储形态：内联指回 key_static_string，堆则指回 old。'],
  [1693, '统一置 errno=ENOMEM，调用方据此区分 OOM 与逻辑错误。'],
  [1694, '返回 0，key_len 与已有内容都未改动。'],
  [1696, '从内联迁到堆时，需把已累积的 key_len 字节拷进新块。'],
  [1697, '只有扩容成功才更新 key_max，失败路径保持旧上界。'],
  [1702, 'memmove 之后才推进 key_len，保证复制起点仍是旧长度。'],
  [1703, '返回 1 表示追加成功，it->key 已含新字符。'],
  [1709, '只减 key_len，不清字节；下次追加会覆盖这块区域。'],

  // ---- raxIteratorNextStep ----
  [1735, 'EOF 后再 next 直接返回 1，调用方靠 flags 而非返回值判断结束。'],
  [1736, '返回 1 且不改任何状态，重复调用是幂等的。'],
  [1738, 'JUST_SEEKED 表示刚 seek 完，第一次 next 要跳过并清掉该标志。'],
  [1739, '跳过这一步后仍返回 1，key 保持 seek 定位的那一项。'],
  [1745, '记录栈深度，EOF 时恢复到进入本次步进前的值。'],
  [1746, '记录当前节点，EOF 恢复后 it->node 仍可安全取值。'],
  [1748, '外层无限循环：要么下降后 return，要么回到兄弟分支继续。'],
  [1749, '压缩节点的唯一子也算 1 个 children，后续判断统一用它。'],
  [1750, 'noup=0 且当前有子才向下走；noup=1 时直接去兄弟分支。'],
  [1751, 'debugf 打印 GO DEEPER 标记，未开调试时整行为空。'],
  [1756, 'raxNodeFirstChildPtr 取第一个子指针，正向迭代永远优先字典序最小的边。'],
  [1757, '追加边字符：压缩节点追加 size 个，普通节点只追加 1 个。'],
  [1758, 'it->node 换成子节点，父节点已压栈可回溯。'],
  [1766, '下降途中遇到 key 就停下，它就是当前子树里最小的键。'],
  [1767, '返回 1，it->data 已指向该键的值。'],
  [1775, 'old_noup 保存本轮入口的 noup，1800 行的兄弟条件要复用原值。'],
  [1779, '已回到 head 仍无兄弟，标记 EOF。'],
  [1780, '栈深度回滚到 orig_stack_items，不把回溯过程留下的残栈带出去。'],
  [1781, 'key_len 回滚，key 内容恢复成最后一个有效键。'],
  [1782, 'it->node 回滚，保证 EOF 后仍可安全调用 raxGetData。'],
  [1783, 'EOF 也返回 1，结束信号只由 RAX_ITER_EOF 承载。'],
  [1788, 'noup=0 才真正出栈；noup=1 时当前节点已是父节点。'],
  [1789, 'raxStackPop 出栈回到父节点，下面从它的下一个兄弟继续。'],
  [1791, 'noup 只消费一次，随即清零。'],
  [1796, '删掉刚才追加的边字符，删除长度按 iscompr 取 size 或 1。'],
  [1801, '从第一个子指针开始扫描，正向找比 prevchild 大的边。'],
  [1802, 'i 与 cp 同从 0 起：i 索引 data[]，cp 指向同下标的 child 槽，1805 行比较 data[i] 与 prevchild。'],
  [1803, '遍历全部边，it->node->size 即当前节点的边数。'],
  [1804, 'debugf 打印 SCAN NEXT 与正在比较的边字符。'],
  [1805, '边字符严格大于 prevchild 才停，字典序更大才是后继。'],
  [1806, 'i 后移一位，it->node->data[i] 换成下一条边继续比较。'],
  [1807, 'cp 后移一个 sizeof(raxNode*) 宽度，与 i 同步落到该边对应的槽位。'],
  [1809, 'i 未越界说明找到了更大的兄弟分支。'],
  [1810, '打印命中标记，表示找到了新子树。'],
  [1811, '只追加 1 个字节，因为普通节点每条边就是一个字符。'],
  [1812, '压入父节点供后续 prev 回溯；失败即 OOM 返回 0。'],
  [1813, 'it->node 切到该兄弟子节点。'],
  [1817, '兄弟节点本身是 key 就先返回它，不必再往下钻。'],
  [1818, '命中 iskey 才回填 it->data：值指针取自该节点，返回 1 之前必须取好。'],
  [1819, '返回 1 表示步进成功。'],
  [1821, '兄弟不是 key，跳出兄弟扫描回到外层 while 继续向下。'],

  // ---- raxSeekGreatest ----
  [1836, 'size 非 0 说明还有子节点，一直走到叶子为止。'],
  [1837, '压缩节点整段追加，长度是 it->node->size 字节。'],
  [1838, 'raxIteratorAddChars 失败即 OOM，直接返回 0。'],
  [1840, '普通节点只追加最后一条边，即 data[size-1] 那一个字符。'],
  [1842, 'raxNodeLastChildPtr 取最后一个子指针，最大键总在最后一条边下面。'],
  [1843, '压入当前节点，raxPrev 回溯时要用。'],
  [1844, 'it->node 换成最后一个子节点，循环继续。'],
  [1846, '走到 size==0 的叶子，最大键已完整拼在 it->key 里。'],

  // ---- raxIteratorPrevStep ----
  [1856, '与正向一致：EOF 后 prev 直接返回 1，状态不变。'],
  [1857, '返回 1，结束信号由 flags 里的 RAX_ITER_EOF 承载。'],
  [1859, 'seek 后的第一条 prev 要跳过，清掉 JUST_SEEKED。'],
  [1860, '返回 1，key 仍停在 seek 定位的那一项。'],
  [1866, '记录栈深度，EOF 时回滚到步进前。'],
  [1867, '记录节点指针，回滚后 it->node 仍有效。'],
  [1869, '外层循环：找到前驱就 return，否则继续向上。'],
  [1870, 'old_noup 保存入口值，1895 行的兄弟条件需要原值。'],
  [1874, '到 head 仍无更小兄弟，置 EOF。'],
  [1875, '栈深度回滚，不把回溯用的父节点留在栈里。'],
  [1876, 'key_len 回滚到步进前，key 内容随之恢复。'],
  [1877, 'it->node 回滚，EOF 后取 data 仍安全。'],
  [1878, '返回 1 并保留 RAX_ITER_EOF，反向迭代也走同一条返回值约定。'],
  [1881, 'prevchild 是当前 key 的最后一个字符，用于定位从哪条边往回退。'],
  [1882, 'noup=0 才出栈；noup=1 时当前节点已是父节点。'],
  [1883, 'raxStackPop 回到父节点，下面从它的前一个兄弟继续。'],
  [1885, 'noup 只消费一次，随即清零。'],
  [1891, '按 iscompr 决定删 size 还是 1 个字符，必须与追加时严格对称。'],
  [1896, 'raxNodeLastChildPtr 从最后一个子指针起步，反向扫描。'],
  [1897, 'i 从 size-1 开始，向 0 递减。'],
  [1898, 'i>=0 才有效；i 走到 -1 表示没有更小的兄弟。'],
  [1899, 'debugf 打印 SCAN PREV 与正在比较的边字符。'],
  [1900, '边字符严格小于 prevchild 才停，字典序更小才是前驱。'],
  [1901, 'data[i] 不小于 prevchild，这条边不是前驱，i 回退一格继续比较。'],
  [1902, 'cp 与 i 同步回退：两者必须指向同一条边，错位会读到相邻子树的指针。'],
  [1908, 'i 不等于 -1，说明找到了更小的兄弟分支。'],
  [1911, '压入父节点供后续 prev 回溯；失败即 OOM 返回 0。'],
  [1912, 'it->node 切到该兄弟节点。'],
  [1922, '子树已被 raxSeekGreatest 钻到最大键，回填该键的值。'],
  [1923, '返回 1 表示反向步进成功，it->key 已更新为前驱。'],
];

// 插入前预检：先按终审口径（deep-quality 的 isWeakLine 等价物）过一遍单行。
// 这里用 vk-gate 的块级判定做分钟级预检，最终以插入后的 deep-quality 为准（§8.10）。
const { isWeakBlock } = await import('./vk-gate.mjs');
const weak = E.filter(([, t]) => isWeakBlock([t]));
if (weak.length) {
  console.error(`WEAK ${weak.length}: ${weak.map(([n]) => n).join(',')}`);
  process.exit(3);
}

// 对账：本片未覆盖集合 = E ∪ SKIP，且 E 与 SKIP 不相交。
const uncov = fs
  .readFileSync('d:/code/_annot_baseline/VK-B72b-uncov0.txt', 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => Number(l.split('\t')[1]))
  .filter((n) => n >= START && n <= END);
const want = new Set(uncov);
const have = new Set(E.map(([n]) => n));
const missing = [...want].filter((n) => !have.has(n) && !SKIP.has(n));
const extra = [...have].filter((n) => !want.has(n));
const dup = E.map(([n]) => n).filter((n, i, a) => a.indexOf(n) !== i);
const skipOutside = [...SKIP].filter((n) => !want.has(n));
if (missing.length || extra.length || dup.length || skipOutside.length) {
  console.error(`MISMATCH missing=${missing.length} extra=${extra.length} dup=${dup.length} skipOutside=${skipOutside.length}`);
  if (missing.length) console.error('missing: ' + missing.join(','));
  if (extra.length) console.error('extra: ' + extra.join(','));
  if (dup.length) console.error('dup: ' + dup.join(','));
  if (skipOutside.length) console.error('skipOutside: ' + skipOutside.join(','));
  process.exit(2);
}

const ops = E.map(([line, text]) => ({
  line,
  expect: src[line - 1].trim(),
  lines: ['// ' + text],
}));
fs.writeFileSync(`${DIR}/spec.json`, JSON.stringify([{ file: REL, ops }], null, 2) + '\n', 'utf8');
console.log(`entries=${ops.length} skipped=${SKIP.size} slice=${START}..${END} -> ${DIR}/spec.json`);
