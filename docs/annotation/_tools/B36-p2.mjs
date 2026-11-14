// B36 P2：getServerConfig / freeServerConfig / resetPlaceholders / initPlaceholders。
// 只输出本片 ops；entries 追加到累积 out-valkey-benchmark.json。
import fs from 'node:fs';

const SRC = 'd:/code/opensource/valkey/src/valkey-benchmark.c';
const DIR = 'd:/code/_annot_baseline/VK-B36';

const E = [
  // ---- getServerConfig ----
  [587, 'serverConfig *cfg = zcalloc(sizeof(*cfg));', '/* zcalloc 失败会直接 abort，因此这里的判空实际不可达，属于防御性写法。 */'],
  [588, 'if (!cfg) return NULL;', '/* 实际不会命中：zcalloc 不返回 NULL；保留是为了与旧版分配器兼容。 */'],
  [589, 'valkeyContext *c = NULL;', '/* 先置 NULL，fail 路径统一 valkeyFree(c) 时才能安全地传空。 */'],
  [590, 'valkeyReply *reply = NULL, *sub_reply = NULL;', '/* reply 每轮都要释放上一份，初值 NULL 让首轮 freeReplyObject 不会读脏指针。 */'],
  [591, 'c = getValkeyContext(ct, ip_or_path, port);', '/* 控制面建连；AUTH 被拒已在该函数内部 exit，这里只会拿到 NULL 或可用连接。 */'],
  [592, 'if (c == NULL) {', '/* 只有连接或 TLS 失败才返回 NULL，此时必须回收刚分配的 cfg。 */'],
  [593, 'freeServerConfig(cfg);', '/* 连不上也要释放 cfg，否则每次重试泄漏一个结构体。 */'],
  [594, 'exit(1);', '/* 拿不到 CONFIG 就无法生成报告，直接终止而不是带着空值继续。 */'],
  [596, 'valkeyAppendCommand(c, "CONFIG GET %s", "save");', '/* 第 1 条 append 必须与 switch 的 case 0 对应，顺序调换会把 save 写进 appendonly。 */'],
  [597, 'valkeyAppendCommand(c, "CONFIG GET %s", "appendonly");', '/* 第 2 条 append 对应 case 1；服务端按序回复是这套对应关系的前提。 */'],
  [598, 'int abort_test = 0;', '/* 只有 NOAUTH 才置 1；其它错误仅返回 NULL，不影响压测继续。 */'],
  [599, 'int i = 0;', '/* 回复序号，同时决定写入哪个字段，不能与 append 顺序脱节。 */'],
  [600, 'void *r = NULL;', '/* libvalkey 的出参；先置 NULL 才能区分“没取到回复”与“取到错误回复”。 */'],
  [601, 'for (; i < 2; i++) {', '/* 固定读两次回复；少读一次会让 c 里残留未消费回复，关闭时告警。 */'],
  [602, 'int res = valkeyGetReply(c, &r);', '/* 同步取回复；返回值与出参 r 都要判，任一失败都不能解引用。 */'],
  [603, 'if (reply) freeReplyObject(reply);', '/* 先释放上一轮 reply；value 已经 sdsnew 复制过，释放不影响 cfg。 */'],
  [604, 'reply = res == VALKEY_OK ? ((valkeyReply *)r) : NULL;', '/* 统一成 NULL 或有效指针，下面只需判 reply，不必重复看 res。 */'],
  [605, 'if (res != VALKEY_OK || !r) goto fail;', '/* 读取失败或空回复都走 fail，避免把 NULL 当 valkeyReply 解引用。 */'],
  [606, 'if (reply->type == VALKEY_REPLY_ERROR) {', '/* 错误回复不是数组，继续读 element[1] 会越界。 */'],
  [607, 'goto fail;', '/* 交给 fail 判断是否 NOAUTH，再决定 exit 还是返回 NULL。 */'],
  [609, 'if (reply->type != VALKEY_REPLY_ARRAY || reply->elements < 2) goto fail;', '/* 形状校验：CONFIG GET 应回 [name, value] 两元素，畸形回复直接放弃。 */'],
  [610, 'sub_reply = reply->element[1];', '/* 第二个元素才是值，第一个是参数名；取错会把 "save" 当成配置值。 */'],
  [611, 'char *value = sub_reply->str;', '/* 取 bulk string 内容；类型异常时 str 为 NULL，下一行兜底。 */'],
  [612, 'if (!value) value = "";', '/* 空值用空串代替 NULL，否则 sdsnew(NULL) 返回 NULL 会被误判成分配失败。 */'],
  [613, 'switch (i) {', '/* 按回复序号写字段，与上面两条 append 的顺序一一对应。 */'],
  [614, 'case 0: cfg->save = sdsnew(value); break;', '/* 第一条回复是 save；这里漏 break 会继续执行 case 1，把两个字段写成同值。 */'],
  [615, 'case 1: cfg->appendonly = sdsnew(value); break;', '/* 第二条回复是 appendonly；字段写反会让恢复阶段回写错误的持久化配置。 */'],
  [618, 'freeReplyObject(reply);', '/* 成功路径释放最后一次回复；cfg 与 c 的所有权分别归调用方与本函数收尾。 */'],
  [619, 'valkeyFree(c);', '/* 控制面连接用完即关，不参与压测，常驻会白占一个 fd。 */'],
  [620, 'return cfg;', '/* 成功后 cfg 归调用方，最终由 freeServerConfig 回收。 */'],
  [621, 'fail:', '/* 统一失败出口：先释放 reply/c，再回收 cfg，最后才决定是否 exit。 */'],
  [622, 'if (reply && reply->type == VALKEY_REPLY_ERROR && !strncmp(reply->str, "NOAUTH", 6)) {', '/* 只有 NOAUTH 升级为致命错误；其它错误可能是旧版本不支持该参数。 */'],
  [623, 'if (ct != VALKEY_CONN_UNIX)', '/* unix socket 没有 ip:port，报错格式要分开，否则打印出无意义的端口 0。 */'],
  [624, 'fprintf(stderr, "Node %s:%d replied with error:\\n%s\\n", ip_or_path, port, reply->str);', '/* 非 unix 连接打印 host:port，便于定位是哪台节点拒绝认证。 */'],
  [626, 'fprintf(stderr, "Node %s replied with error:\\n%s\\n", ip_or_path, reply->str);', '/* unix 连接只打印套接字路径。 */'],
  [627, 'abort_test = 1;', '/* 延迟到清理完再 exit；在这里直接退出会漏掉 reply 与 cfg 的释放。 */'],
  [629, 'freeReplyObject(reply);', '/* fail 路径同样要释放 reply，否则每条失败连接泄漏一份回复。 */'],
  [630, 'valkeyFree(c);', '/* 关闭控制面连接；c 可能为 NULL，valkeyFree 允许传空。 */'],
  [631, 'freeServerConfig(cfg);', '/* 回收 cfg；调用方拿到的是 NULL，不会二次释放。 */'],
  [632, 'if (abort_test) exit(1);', '/* NOAUTH 直接终止；未认证连接上继续压测只会得到一片错误回复。 */'],
  [633, 'return NULL;', '/* 非致命失败；调用方打印 WARNING 后可降级继续。 */'],

  // ---- freeServerConfig ----
  [635, 'static void freeServerConfig(serverConfig *cfg) {', '/* 释放 getServerConfig 建立的结构；只回收两个 sds 与结构本身。 */'],
  [636, 'if (cfg->save) sdsfree(cfg->save);', '/* save 可能为 NULL（读取半途失败），判空避免 sdsfree(NULL) 的未定义行为。 */'],
  [637, 'if (cfg->appendonly) sdsfree(cfg->appendonly);', '/* appendonly 同理；两个字段必须各自释放，不能只放一个。 */'],
  [638, 'zfree(cfg);', '/* 结构体最后释放；提前释放会让上面两行读到已释放内存。 */'],

  // ---- resetPlaceholders ----
  [641, 'void resetPlaceholders(void) {', '/* 清空占位符缓存；换模板或退出时调用，释放唯一堆块并整体归零。 */'],
  [642, 'if (placeholders.index_data)', '/* index_data 可能为 NULL（首次调用或已清零），必须判空再 free。 */'],
  [643, 'zfree(placeholders.index_data); /* indices are a single contiguous allocation */', '/* indices[] 只是这块内存的切片，不能单独 zfree；漏放则每次 reset 泄漏一块。 */'],
  [644, 'memset(&placeholders, 0, sizeof(placeholders));', '/* 把 count[]、indices[]、cmd_len 全部归零；不清零会让下次 init 按旧计数切片。 */'],

  // ---- initPlaceholders ----
  [663, 'void initPlaceholders(const char *cmd, size_t cmd_len) {', '/* 扫描一次模板命令，缓存全部占位符偏移；之后每条请求只做定点覆写，不再 strstr。 */'],
  [664, 'resetPlaceholders();', '/* 先释放上一次的 index_data；不重置会让旧偏移残留到新命令上。 */'],
  [665, 'placeholders.cmd_len = cmd_len;', '/* 记录命令长度，replacePlaceholders 用它校验替换后长度不变。 */'],
  [668, 'size_t total_count = 0;', '/* 先统计总数，才能一次性分配连续块，避免每类占位符各分配一块。 */'],
  [669, 'size_t *temp_indices[PLACEHOLDER_COUNT];', '/* 扫描阶段的临时数组；各占位符独立扩容，最后合并进 index_data。 */'],
  [670, 'for (size_t placeholder = 0; placeholder < PLACEHOLDER_COUNT; placeholder++) {', '/* 按占位符种类逐个扫描；下标顺序必须与 PLACEHOLDERS 数组一致。 */'],
  [671, 'size_t *count = &placeholders.count[placeholder];', '/* 取计数槽地址，循环内直接累加，省一次数组下标计算。 */'],
  [672, '*count = 0;', '/* 计数同时是扩容判据，必须先清零，否则旧值会立刻触发扩容。 */'],
  [674, 'size_t temp_size = RANDPTR_INITIAL_SIZE;', '/* 初始容量 8 只避免短命令就分配大块；命中多时再按 2 倍扩容。 */'],
  [675, 'temp_indices[placeholder] = zmalloc(sizeof(size_t) * temp_size);', '/* zmalloc 失败直接 abort，因此这里不需要判空。 */'],
  [676, 'const char *p = cmd;', '/* 每条命令都从缓冲头开始扫，占位符可以出现在任意位置。 */'],
  [677, 'const char *end = cmd + cmd_len;', '/* 逻辑结束位置；strstr 可能越过内嵌 NUL 继续找，必须用 end 截住。 */'],
  [678, 'while ((p = strstr(p, PLACEHOLDERS[placeholder])) != NULL && p < end) {', '/* p < end 是防越界：命中点在 cmd_len 之外一律丢弃，否则覆写会踩坏缓冲区。 */'],
  [679, 'if (*count == temp_size) {', '/* 容量满才扩容；每次只加 1，所以用 == 判断就够。 */'],
  [680, 'temp_size *= 2;', '/* 2 倍扩容保证均摊 O(1)；改成 +1 会让长命令退化成 O(n²)。 */'],
  [681, 'temp_indices[placeholder] = zrealloc(temp_indices[placeholder], sizeof(size_t) * temp_size);', '/* zrealloc 失败 abort，旧块不会泄漏，也不用保存返回前的指针。 */'],
  [683, 'size_t index = p - cmd;', '/* 偏移相对命令起点；替换时用 cmd + index 定位，不能用绝对地址。 */'],
  [684, 'temp_indices[placeholder][*count] = index;', '/* 写入前已确认容量，这里不会越界。 */'],
  [685, '(*count)++;', '/* 同步更新 placeholders.count，最终布局按它切片。 */'],
  [686, 'total_count++;', '/* 累加全局总数，决定 index_data 的分配大小。 */'],
  [687, 'p += PLACEHOLDER_LEN; // Move past the placeholder', '/* 步进 12 跳过整段；改成 p++ 会把相邻占位符的内部再匹配一次。 */'],
  [692, 'placeholders.index_data = zmalloc(sizeof(size_t) * total_count);', '/* 一次性分配；total_count 为 0 时 zmalloc(0) 仍返回可 free 的指针。 */'],
  [693, 'size_t overall_index = 0;', '/* 连续块内的游标，按各类 count 依次推进。 */'],
  [694, 'for (size_t placeholder = 0; placeholder < PLACEHOLDER_COUNT; placeholder++) {', '/* 第二遍用同样的下标顺序切片，保证 indices[] 与 count[] 对齐。 */'],
  [695, 'placeholders.indices[placeholder] = placeholders.index_data + overall_index;', '/* 切片指针只可读不可 free；把它当独立分配会破坏 index_data。 */'],
  [697, 'const size_t count = placeholders.count[placeholder];', '/* 局部拷贝，避免 memcpy 期间计数被改动导致复制长度不一致。 */'],
  [698, 'memcpy(placeholders.indices[placeholder], temp_indices[placeholder],', '/* 临时数组只在这里被读，复制完立即释放。 */'],
  [702, 'zfree(temp_indices[placeholder]);', '/* 释放临时数组；漏放会每条新模板命令泄漏 PLACEHOLDER_COUNT 块。 */'],
  [704, 'return;', '/* 显式 return 收尾；本函数没有失败路径需要清理，所有分配都已转交 index_data。 */'],
];

const lines = fs.readFileSync(SRC, 'utf8').split(/\r?\n/);
const ops = [];
const added = [];
for (const [ln, expect, c] of E) {
  const cur = lines[ln - 1];
  if (cur === undefined || cur.trim() !== expect) {
    console.error(`MISMATCH ${ln}\n expect: ${expect}\n actual: ${cur}`);
    process.exit(2);
  }
  ops.push({ line: ln, expect, lines: [c] });
  added.push({ line: ln, c: [c] });
}
ops.sort((a, b) => b.line - a.line);
fs.writeFileSync(`${DIR}/ins-p2.json`, JSON.stringify([{ file: 'src/valkey-benchmark.c', ops }], null, 1));

const OUT = `${DIR}/out-valkey-benchmark.json`;
const prev = JSON.parse(fs.readFileSync(OUT, 'utf8'));
fs.writeFileSync(OUT, JSON.stringify(prev.concat(added), null, 1));
console.log(`P2 entries=${added.length} cumulative=${prev.length + added.length}`);
