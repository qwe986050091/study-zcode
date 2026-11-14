// 反馈票据的本地持久化实现：以单个 JSON 文件保存当前设备可见的反馈摘要。
// 选择 tickets.json 而非数据库，是因为数据量小、需要用户可直接查看，且写入频率低。
// FeedbackLocalTicketStore 只做存储，不校验业务字段合法性，也不触发任何网络同步。
// 依赖通过构造函数注入根目录，测试可指向临时目录而不污染真实用户数据。
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { FeedbackListQuery, FeedbackTicketStatus, FeedbackTicketSummary } from "@zcode/shared";
import { getFeedbackRootDir } from "#src/paths.js";

// deviceMid 只存在于本地文件，用于区分同一台机器上的不同账号或设备身份；
// 对外返回前会被剥掉，因此不能依赖它在 UI 层做筛选。
// 其余字段完全复用 FeedbackTicketSummary，协议演进时不需要单独维护一份拷贝。
interface StoredFeedbackTicket extends FeedbackTicketSummary {
  deviceMid: string;
}

// 文件顶层只保留 tickets 字段，便于未来平滑增加版本号等元信息。
// 数组而非映射：顺序即写入先后，读时再按更新时间重排。
interface FeedbackTicketStoreFile {
  tickets: StoredFeedbackTicket[];
}

// 本地票据存储的契约：所有方法都以 deviceMid 作为隔离维度，跨设备不可见。
// 该类只负责单个 JSON 文件的读写与格式迁移，不做网络请求，也不承担重试；
// 并发写没有加锁，假定同一时刻只有本进程会写，后写者覆盖先写者是可接受的行为。
// 读操作允许失败放行，写操作则让异常向上抛出，由调用方决定是否提示用户。
export class FeedbackLocalTicketStore {
// 票据文件固定在反馈根目录下的 tickets.json，路径只依赖注入的根目录。
// 实例不缓存内容，每次调用都重新读写文件，避免多窗口或外部编辑导致内存与磁盘不一致。
  private readonly filePath: string;

  constructor(rootDir = getFeedbackRootDir()) {
    this.filePath = join(rootDir, "tickets.json");
  }

// 列表始终先按 deviceMid 隔离，再叠加状态与类型过滤；query 为空表示不加条件。
// 排序用 updated_at 的字符串字典序即可，因为时间戳格式固定且可比较。
// offset 为负时按 0 处理，limit 缺省或为负时返回剩余全部，避免调用方透传异常值。
// 分页在排序和过滤之后进行，保证翻页结果稳定。
// 返回前剥除 deviceMid，它是本地存储的内部字段，不应出现在对外协议里。
  async list(deviceMid: string, query: FeedbackListQuery = {}): Promise<FeedbackTicketSummary[]> {
    // 每次调用都从 read 拿全量，读的降级策略由 read 统一决定
    const tickets = (await this.read()).tickets
      // deviceMid 是本地隔离维度，先过滤再排序以免跨设备票据混入当前列表
      .filter((ticket) => ticket.deviceMid === deviceMid)
      .filter((ticket) => {
        // status 与 type 都是可选过滤条件，缺省时不参与判断以保留全部记录
        if (query.status && ticket.status !== query.status) return false;
        if (query.type && ticket.type !== query.type) return false;
        return true;
      })
      // updated_at 是固定格式的时间串，字典序降序即最新在前无需再解析成 Date
      .sort((left, right) => right.updated_at.localeCompare(left.updated_at));
    // 负 offset 按 0 处理，否则 slice 会从尾部反向取数导致翻页错位
    const offset = Math.max(0, query.offset ?? 0);
    const limit = query.limit !== undefined && query.limit >= 0 ? query.limit : tickets.length;
    return tickets
      // 分页在过滤与排序之后执行，保证同一 query 的翻页结果稳定
      .slice(offset, offset + limit)
      // 返回前剥除 deviceMid 私有字段，它不应出现在对外协议里
      .map(({ deviceMid: _deviceMid, ...ticket }) => ticket);
  }

// 以 deviceMid 与 id 组合为唯一键做覆盖写：同一设备重复上报同一条反馈只更新时间，
// 不会产生重复条目；deviceMid 校验保证换账号或换设备后不会读到别人的票据。
// 新票据固定在数组头部，读取时再按 updated_at 排序，两个维度都不会互相影响。
// upsert 用 slice(0, 200) 截断，避免长期使用后 tickets.json 无限膨胀拖慢全量读取。
// 崩溃窗口：read → 构造 next → writeFile 覆盖，三步之间没有临时文件；进程若在 writeFile 中途被杀，
// 会留下截断的 JSON，下次 read 判为损坏返回空集合，等于整份 tickets 丢失。本文件不是可靠账本。
  async upsert(deviceMid: string, ticket: FeedbackTicketSummary): Promise<void> {
    // 先读全量再覆盖写，读失败会返回空集合而不会写坏文件
    const file = await this.read();
    // 写入时补上 deviceMid，调用方传的摘要不含这个本地字段
    const next: StoredFeedbackTicket = { ...ticket, deviceMid };
    // 按 deviceMid 与 id 双键剔除旧条目，只比 id 会误删其他设备的同号票据
    const rest = file.tickets.filter(
      (current) => current.deviceMid !== deviceMid || current.id !== ticket.id,
    );
    // 新票据放在 tickets 数组头部并截断到 200 条，防止单文件长期膨胀拖慢全量读取
    await this.write({ tickets: [next, ...rest].slice(0, 200) });
  }

// 读取采用失败放行策略：文件缺失、内容损坏或结构不符都返回空集合，
// 这样反馈列表不会因为本地缓存异常而整体不可用；异常记录由上报侧重试补齐。
// 命中旧版本状态时在返回前完成迁移，调用方无需感知历史数据差异。
  private async read(): Promise<FeedbackTicketStoreFile> {
    try {
      // 每次 read 都重新读盘，不在实例内缓存以免多窗口或外部编辑后看到旧内容
      const text = await readFile(this.filePath, "utf8");
      // JSON.parse 可能抛错，用 unknown 承接交给类型守卫而不要直接断言
      const parsed = JSON.parse(text) as unknown;
      // 顶层结构不符时返回空集合，损坏的 tickets.json 不会让反馈列表整体不可用
      if (!isObjectRecord(parsed) || !Array.isArray(parsed.tickets)) {
        return { tickets: [] };
      }
      return {
        // 先剔除字段不全的记录再迁移状态，顺序反过来会让迁移函数读到 undefined
        tickets: parsed.tickets.filter(isStoredFeedbackTicket).map(migrateStoredFeedbackTicket),
      };
    } catch (error) {
      // 解析失败与 ENOENT 同样返回空集合：损坏文件等价于「没有任何票据」，写入侧必须整体覆盖，不能做增量追加。
      // 文件缺失与解析失败目前都返回空集合，分成两支是为将来做差异化降级
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { tickets: [] };
      }
      return { tickets: [] };
    }
  }

// 写入前确保父目录存在：首次上报时 feedback 目录可能尚未创建。
// 固定两空格缩进并保留结尾换行，便于用户直接查看和手工排查 tickets.json。
  private async write(file: FeedbackTicketStoreFile): Promise<void> {
    // 首次上报时 feedback 目录可能不存在，mkdir 必须早于 writeFile
    await mkdir(dirname(this.filePath), { recursive: true });
    // writeFile 先截断再写，不是原子替换：中途断电会留下空文件或半截 JSON，且没有 temp+rename 兜底。
    await writeFile(this.filePath, `${JSON.stringify(file, null, 2)}\n`, "utf8");
  }
}

function migrateStoredFeedbackTicket(ticket: StoredFeedbackTicket): StoredFeedbackTicket {
  // 3.3.5 将「待评估」重命名为「已提交」，旧版匿名反馈仍会把旧值留在 tickets.json；
  // 读取时不迁移或放行未知值会让状态元数据查找返回 undefined，点击「我的反馈」后渲染崩溃。
  const status = String(ticket.status);
  if (status === "待评估" || !isFeedbackTicketStatus(status)) {
    return { ...ticket, status: "已提交" };
  }
  return ticket;
}

function isFeedbackTicketStatus(status: string): status is FeedbackTicketStatus {
  // 枚举判定用 switch 穷举，新增状态时这里的收窄会强制一起更新
  switch (status) {
    case "已提交":
    case "信息不足":
    case "已采纳":
    case "答复关闭":
    // 已归档 status 在列表里仍需可读，因此与已上线等终态一并保留
    case "已归档":
    case "已拒绝":
    case "开发中":
    case "已解决":
    case "已上线":
      // 命中任一白名单状态才返回 true，未知值一律走 default
      return true;
    default:
      // default 分支返回 false，让迁移函数把未知状态改写为已提交
      return false;
  }
}

function isStoredFeedbackTicket(value: unknown): value is StoredFeedbackTicket {
  // 数组与 null 都不能当票据读，先过普通对象判断再访问字段
  if (!isObjectRecord(value)) {
    return false;
  }
  return (
    // deviceMid 与 id 是隔离与覆盖写的键，缺任一就没法安全 upsert
    typeof value.deviceMid === "string" &&
    typeof value.id === "string" &&
    typeof value.title === "string" &&
    typeof value.type === "string" &&
    typeof value.status === "string" &&
    typeof value.created_at === "string" &&
    // 两个时间戳必须是字符串，排序与比较都直接依赖它们的字典序
    typeof value.updated_at === "string"
  );
}

// 只接受普通对象：数组和 null 都视为非法，避免把数组当字典读字段。
function isObjectRecord(value: unknown): value is Record<string, unknown> {
  // 同时排除 null 与数组，避免调用方把数组当字典读字段
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
