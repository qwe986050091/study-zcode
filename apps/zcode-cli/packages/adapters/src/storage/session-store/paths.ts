// ============================================================
// Session store paths
// ============================================================
// 定位：给出 session 数据库的默认落盘路径。
// 输入输出：无参数，返回 <home>/.zcode/cli/db/db.sqlite。
// 副作用：无，不创建目录；建目录由 open 流程负责。
// 调用方式：SqliteSessionStore.open 在 options.dbPath 缺省时使用；测试可传临时 dbPath 绕过。
// 平台差异：经 path.join 拼接，Windows 结果为反斜杠形式，调用方不要自行拼字符串比较。
// 失败语义：homedir 不可用时会由 Node 返回兜底值或抛错，这里不吞。
// 不变量：路径固定，不随 cwd 或 workspace 变化（同一用户共享一个 session 库）。

import { homedir } from "node:os";
import { join } from "node:path";

// 默认库路径：用户级而非项目级，保证跨 workspace 的会话历史可恢复。
// 目录可能不存在：open 流程会先 recursive mkdir 父目录，因此这里既不创建也不校验。
// 返回以 homedir 起头的绝对路径；":memory:" 等特殊路径不归本函数表达。
export function getDefaultSessionDbPath(): string {
  return join(homedir(), ".zcode", "cli", "db", "db.sqlite");
}
