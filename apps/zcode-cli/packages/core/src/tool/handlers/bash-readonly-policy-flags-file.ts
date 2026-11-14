// INV-01 安全 flag 表是白名单，缺省即判可能写：守住位置 六张表；改错故障 未收录 flag 被放行。
// INV-02 表只被对应的 simple-command policy 引用：守住位置 模块注释与导出；改错故障 其他命令误用宽松表。
// INV-03 fd 的执行类 flag 必须保持不收录：守住位置 FD 表；改错故障 任意子进程被执行。
// INV-04 sort 的输出类 flag 必须保持不收录：守住位置 SORT 表；改错故障 只读命令覆盖文件。
// INV-05 date 的设置时间 flag 必须保持不收录：守住位置 DATE 表；改错故障 系统时间被修改。
// INV-06 hostname 的写主机名 flag 必须保持不收录：守住位置 HOSTNAME 表；改错故障 系统主机名被改写。
// INV-07 sha 校验类 flag 只保留只读语义：守住位置 SHA 表；改错故障 校验模式被误判为写入。
// INV-08 base64 的输入输出 flag 按取值类型声明：守住位置 BASE64 表；改错故障 取值被当成位置参数。
// INV-09 值类型只能取 SafeFlagValue 的五种形态：守住位置 satisfies 约束；改错故障 新增类型绕过 argv 解析。
// INV-10 每个 flag 都必须显式声明取值类型：守住位置 值映射；改错故障 缺值 flag 吞掉后续路径。
// INV-11 短选项与长选项分开列出：守住位置 两组键；改错故障 只匹配一种写法。
// INV-12 同一命令的别名选项必须同时收录：守住位置 多组等价键；改错故障 换个写法就判写。
// INV-13 表使用 as const 保持字面量类型：守住位置 每个表尾；改错故障 类型放宽后丢失穷尽检查。
// INV-14 表对象不得被运行时修改：守住位置 Readonly 约束；改错故障 策略层意外增删条目。
// INV-15 注释中说明的排除项必须与表内容一致：守住位置 每张表前注释；改错故障 维护者误以为已收录。
// INV-16 新增 flag 前先确认其不会执行子进程或写盘：守住位置 评审口径；改错故障 只读策略被扩大。
// INV-17 表顺序不影响判定，但保持字母序便于比对：守住位置 键排列；改错故障 人工审查遗漏重复键。
// INV-18 本文件不包含任何执行逻辑：守住位置 模块边界；改错故障 数据与策略耦合难以复用。
//
// 模块职责：集中声明文件与搜索类只读命令的安全 flag 白名单及其取值类型。
// 状态所有权：全部为不可变常量；策略层只读引用，本文件不持有运行时状态。
// 阅读顺序：先读模块注释的保守口径，再按命令逐张查看白名单与排除说明。
/**
 * 文件/搜索类只读命令的安全 flag 表（fd、sort、base64、sha*sum、date、hostname）。
 * 值类型来自 SafeFlagValue：none=不接受取值，string/number/char=紧跟一个取值，
 * {} / EOF 表示 xargs 的占位符/终止符，optionalString=取值可省略。
 * 这些表只被 bash-readonly-policy-simple-commands.ts 的 policy 条目引用；
 * 表里没列出的 flag 一律按"未知→可能写"处理，因此"缺省即保守"是本文件的判定口径。
 */

import type { SafeFlagValue } from "./bash-readonly-policy-types.js";

// fd 的 -x/--exec 与 -X/--exec-batch 会执行任意子进程，故意不收录；
// 只要出现这两个 flag，argv 层就会因为不在安全表里直接判不可读。
// FD_SAFE_FLAGS 其余条目只放纯查询/格式化选项，取值类型严格按命令手册声明，新增条目前必须确认它不会执行子进程或写盘。
export const FD_SAFE_FLAGS = {
  "-0": "none",
  "-1": "none",
  "-E": "string",
  "-F": "none",
  "-H": "none",
  "-I": "none",
  "-L": "none",
  "-S": "string",
  "-V": "none",
  "-a": "none",
  "-c": "string",
  "-d": "number",
  "-e": "string",
  "-g": "none",
  "-h": "none",
  "-i": "none",
  "-j": "number",
  "-o": "string",
  "-p": "none",
  "-q": "none",
  "-s": "none",
  "-t": "string",
  "--absolute-path": "none",
  "--and": "string",
  "--base-directory": "string",
  "--batch-size": "number",
  "--case-sensitive": "none",
  "--changed-before": "string",
  "--changed-within": "string",
  "--color": "string",
  "--exact-depth": "number",
  "--exclude": "string",
  "--extension": "string",
  "--fixed-strings": "none",
  "--follow": "none",
  "--format": "string",
  "--full-path": "none",
  "--glob": "none",
  "--help": "none",
  "--hidden": "none",
  "--hyperlink": "string",
  "--ignore-case": "none",
  "--ignore-file": "string",
  "--max-buffer-time": "string",
  "--max-depth": "number",
  "--max-results": "number",
  "--min-depth": "number",
  "--no-ignore": "none",
  "--no-ignore-parent": "none",
  "--no-ignore-vcs": "none",
  "--no-require-git": "none",
  "--one-file-system": "none",
  "--owner": "string",
  "--path-separator": "string",
  "--print0": "none",
  "--prune": "none",
  "--quiet": "none",
  "--regex": "none",
  "--search-path": "string",
  "--show-errors": "none",
  "--size": "string",
  "--strip-cwd-prefix": "none",
  "--threads": "number",
  "--type": "string",
  "--version": "none",
} as const satisfies Readonly<Record<string, SafeFlagValue>>;

// sort 的 -o/--output 会把结果写入文件，不在表中，因此出现即判写。
// SORT_SAFE_FLAGS 只保留 -k/--key、-t/--field-separator 与 -s/--stable 等只读项，-c/--check 只校验不写回。
export const SORT_SAFE_FLAGS = {
  "-C": "none",
  "-M": "none",
  "-R": "none",
  "-S": "string",
  "-V": "none",
  "-b": "none",
  "-c": "none",
  "-d": "none",
  "-f": "none",
  "-g": "none",
  "-h": "none",
  "-i": "none",
  "-k": "string",
  "-m": "none",
  "-n": "none",
  "-r": "none",
  "-s": "none",
  "-t": "string",
  "-u": "none",
  "-z": "none",
  "--batch-size": "number",
  "--buffer-size": "string",
  "--check": "none",
  "--check-char-order": "none",
  "--dictionary-order": "none",
  "--field-separator": "string",
  "--general-numeric-sort": "none",
  "--help": "none",
  "--human-numeric-sort": "none",
  "--ignore-case": "none",
  "--ignore-leading-blanks": "none",
  "--ignore-nonprinting": "none",
  "--key": "string",
  "--merge": "none",
  "--month-sort": "none",
  "--numeric-sort": "none",
  "--parallel": "number",
  "--random-sort": "none",
  "--reverse": "none",
  "--sort": "string",
  "--stable": "none",
  "--unique": "none",
  "--version": "none",
  "--version-sort": "none",
  "--zero-terminated": "none",
} as const satisfies Readonly<Record<string, SafeFlagValue>>;

// BASE64_SAFE_FLAGS 收 -d/--decode、--ignore-garbage、-w/--wrap 与 -i/--input：解码、忽略垃圾字符、换行宽度和输入文件都只读，编码结果仍写标准输出，不会落盘。
export const BASE64_SAFE_FLAGS = {
  "-D": "none",
  "-b": "number",
  "-d": "none",
  "-h": "none",
  "-i": "string",
  "-w": "number",
  "--break": "number",
  "--decode": "none",
  "--help": "none",
  "--ignore-garbage": "none",
  "--input": "string",
  "--version": "none",
  "--wrap": "number",
} as const satisfies Readonly<Record<string, SafeFlagValue>>;

// SHA_SUM_SAFE_FLAGS 的 -c/--check 只读清单与目标文件，-b/--binary 与 -t/--text 只改读取方式，--status/--quiet 只改输出，--strict 在格式错误时失败而不写任何文件。
export const SHA_SUM_SAFE_FLAGS = {
  "-b": "none",
  "-c": "none",
  "-t": "none",
  "-w": "none",
  "-z": "none",
  "--binary": "none",
  "--check": "none",
  "--help": "none",
  "--ignore-missing": "none",
  "--quiet": "none",
  "--status": "none",
  "--strict": "none",
  "--tag": "none",
  "--text": "none",
  "--version": "none",
  "--warn": "none",
  "--zero": "none",
} as const satisfies Readonly<Record<string, SafeFlagValue>>;

// date 的 -s/--set 会修改系统时间，故意不收录；这里只保留格式化/查询类选项。
// DATE_SAFE_FLAGS 保留 -d/--date、-r/--reference 与 --iso-8601，它们只解析或格式化时间，不会改动系统时钟。
export const DATE_SAFE_FLAGS = {
  "-I": "none",
  "-R": "none",
  "-d": "string",
  "-r": "string",
  "-u": "none",
  "--date": "string",
  "--debug": "none",
  "--help": "none",
  "--iso-8601": "string",
  "--reference": "string",
  "--rfc-3339": "string",
  "--rfc-email": "none",
  "--universal": "none",
  "--utc": "none",
  "--version": "none",
} as const satisfies Readonly<Record<string, SafeFlagValue>>;

// hostname 的 -F/--file（从文件读取新主机名）与 -b/--boot（设置默认主机名）会改系统状态，
// 不在表中；仅保留查询自身名称/地址的选项。
// HOSTNAME_SAFE_FLAGS 的查询项包括 -A/--all-fqdns、-I/--all-ip-addresses 与 -d/--domain。
export const HOSTNAME_SAFE_FLAGS = {
  "-A": "none",
  "-V": "none",
  "-a": "none",
  "-d": "none",
  "-f": "none",
  "-h": "none",
  "-i": "none",
  "-I": "none",
  "-s": "none",
  "-v": "none",
  "--alias": "none",
  "--all-fqdns": "none",
  "--all-ip-addresses": "none",
  "--domain": "none",
  "--fqdn": "none",
  "--help": "none",
  "--ip-address": "none",
  "--long": "none",
  "--short": "none",
  "--verbose": "none",
  "--version": "none",
} as const satisfies Readonly<Record<string, SafeFlagValue>>;
