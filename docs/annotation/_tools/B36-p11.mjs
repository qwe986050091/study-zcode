// B36 P11：cleanupDataset / addRespCommandToSequence / parseCommandTemplate / genBenchmarkRandomData。
import fs from 'node:fs';

const SRC = 'd:/code/opensource/valkey/src/valkey-benchmark.c';
const DIR = 'd:/code/_annot_baseline/VK-B36';

const E = [
  // ---- cleanupDataset ----
  [3026, 'static void cleanupDataset(void) {', '/* 释放 dataset 并把指针置 NULL，只处理 config.current_dataset。 */'],
  [3027, 'if (config.current_dataset) {', '/* 没加载过 dataset 时什么都不做。 */'],
  [3028, 'datasetFree(config.current_dataset);', '/* datasetFree 释放文件记录与内部数组。 */'],
  [3029, 'config.current_dataset = NULL;', '/* 置 NULL 防止下一轮测试复用已释放的 dataset。 */'],

  // ---- addRespCommandToSequence ----
  [3034, 'static void addRespCommandToSequence(sds *sds_args, size_t *argvlen, int start, int end, int repeat, sds *cmd_seq, int *seq_len) {', '/* 把 [start,end) 参数编码成 RESP，重复 repeat 次追加到 cmd_seq。 */'],
  [3035, 'char *cmd = NULL;', '/* valkeyFormatCommandArgv 返回 malloc 缓冲，用完 free。 */'],
  [3036, 'int len = valkeyFormatCommandArgv(&cmd, end - start, (const char **)sds_args + start, argvlen + start);', '/* 只编码 start 起的 end-start 个参数，得到一条完整 RESP 命令。 */'],
  [3037, 'for (int j = 0; j < repeat; j++) {', '/* repeat 次追加同一段编码，实现命令重复。 */'],
  [3038, '*cmd_seq = sdscatlen(*cmd_seq, cmd, len);', '/* sdscatlen 追加 len 字节并更新 sds 长度。 */'],
  [3040, '*seq_len += repeat;', '/* seq_len 是命令条数，每条 repeat 计一次。 */'],
  [3041, 'free(cmd);', '/* 编码缓冲由 malloc 分配，必须用 free 而非 zfree。 */'],

  // ---- parseCommandTemplate ----
  [3045, 'static int parseCommandTemplate(int argc, char **argv) {', '/* 解析命令模板并检测 FIELD_PREFIX 占位符；失败返回 0。 */'],
  [3046, 'sds *sds_args = getSdsArrayFromArgv(argc, argv, 0);', '/* 按 RESP 参数规则拆分 argv，处理引号与转义。 */'],
  [3047, 'if (!sds_args) {', '/* 引号不配对时返回 NULL。 */'],
  [3048, 'fprintf(stderr, "Invalid quoted string\\n");', '/* 提示模板本身写错，而不是 dataset 问题。 */'],
  [3049, 'return 0;', '/* 0 让 main 直接退出，不进入压测。 */'],
  [3053, 'config.has_field_placeholders = 0;', '/* 先假定没有字段占位符。 */'],
  [3054, 'for (int i = 0; i < argc; i++) {', '/* 逐参数查找 FIELD_PREFIX。 */'],
  [3055, 'if (strstr(sds_args[i], FIELD_PREFIX)) {', '/* strstr 命中说明该参数是字段占位符。 */'],
  [3056, 'config.has_field_placeholders = 1;', '/* 置位后 main 会加载 dataset。 */'],
  [3057, 'break;', '/* 只要有一个命中就不再扫描。 */'],
  [3061, 'if (config.has_field_placeholders) {', '/* 只有需要占位符时才复制整份模板。 */'],
  [3062, 'config.template_argc = argc;', '/* 记下模板参数个数。 */'],
  [3063, 'config.template_argv = zmalloc(argc * sizeof(sds));', '/* zmalloc 分配 sds 指针数组，OOM 即 abort。 */'],
  [3064, 'for (int i = 0; i < argc; i++) {', '/* 逐个参数深拷贝。 */'],
  [3065, 'config.template_argv[i] = sdsdup(sds_args[i]);', '/* sdsdup 保证模板不依赖下面要释放的 sds_args。 */'],
  [3069, 'sdsfreesplitres(sds_args, argc);', '/* 释放临时拆分结果，模板已另存一份。 */'],
  [3070, 'return 1;', '/* 1 表示模板解析成功。 */'],

  // ---- genBenchmarkRandomData ----
  [3075, 'static void genBenchmarkRandomData(char *data, int count) {', '/* 用线性同余生成器填 count 字节可打印随机数据。 */'],
  [3076, 'static uint32_t state = 1234;', '/* 固定种子，保证每次运行的随机序列可复现。 */'],
  [3077, 'int i = 0;', '/* data 写入下标。 */'],
  [3079, 'while (count--) {', '/* 每循环生成一个字节。 */'],
  [3080, 'state = (state * 1103515245 + 12345);', '/* 经典 LCG 常数，溢出回绕是预期行为。 */'],
  [3081, "data[i++] = '0' + ((state >> 16) & 63);", '/* 取高位 6 bit 映射到字符 0~?，保证可打印。 */'],
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
fs.writeFileSync(`${DIR}/ins-p11.json`, JSON.stringify([{ file: 'src/valkey-benchmark.c', ops }], null, 1));

const OUT = `${DIR}/out-valkey-benchmark.json`;
const prev = JSON.parse(fs.readFileSync(OUT, 'utf8'));
fs.writeFileSync(OUT, JSON.stringify(prev.concat(added), null, 1));
console.log(`P11 entries=${added.length} cumulative=${prev.length + added.length}`);
