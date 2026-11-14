/**
 * 本地日历日格式化：把 Date 按运行机器的本地时区取出年/月/日，拼成 `YYYY-MM-DD`。
 *
 * 生产者：core/tui 在写入按日归桶的诊断、日志或用户可见日期时调用。
 * 消费者：按本地日分组的展示与统计；只接受“日期字符串”，不携带时刻和时区信息，
 * 因此跨进程/持久化后不能再据此还原绝对时间。
 *
 * 不变量：必须使用 getFullYear/getMonth/getDate 这组本地字段，不能用 toISOString().slice(0,10)；
 * 后者是 UTC 日，在东八区凌晨等场景会落到前一天。月份补零是字符串格式化，不改变日期语义。
 *
 * 副作用：纯函数，只读入参，不写日志、不改全局状态、不做时区换算或本地化格式化，
 * 重复调用同一 Date 结果稳定，可安全并发调用。
 * 失败语义：不做入参校验；传入 Invalid Date 时 getFullYear/getMonth/getDate 均返回 NaN，
 * 函数依旧返回 `NaN-NaN-NaN` 而不抛错，因此调用方需自行保证 date 有效。
 * 降级口径：需要时刻、时区或时间差时必须另取字段，不能把返回值反解析成 Date 再计算。
 */
export function formatLocalIsoDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
