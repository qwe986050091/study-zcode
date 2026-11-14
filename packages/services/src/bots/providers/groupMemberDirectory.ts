// 飞书群成员分页响应的最小形状：字段名保持远端 snake_case，本层不做改名，
// 避免「同一份数据在适配层与调用方之间两套命名」导致取错字段。
// 全部可选：接口在「无结果」或「权限不足」时可能只返回空对象，调用方必须能处理「没有 items」。
export interface GroupMemberPage {
  items?: Array<{ member_id?: string; name?: string }>;
  // has_more 为真时必须同时给出 page_token；只有 page_token 没有 has_more 时按「已到末页」处理。
  has_more?: boolean;
  page_token?: string;
}

// 构造一个「按 key 缓存 + 单飞」的成员目录读取器：
//   key     由调用方决定（通常是 botId + chatId），本层不解析其含义；
//   readPage 负责真正拉取一页，游标由本层维护，adapter 调用方只需要实现「拿一页」。
// 返回 Record<open_id, 展示名>，调用方按 ID 查表；查不到即回退显示 ID。
// 副作用：进程内缓存与网络请求；无定时器，过期靠惰性判定（见下方 expires 比较）。
// 失败语义：分页异常时整次调用抛错，绝不返回「已抓到的那几页」（INV-04 的同类口径：不投递半截数据）。
export function createGroupMemberDirectory(now: () => number = Date.now) {
  // now 可注入是为了让过期策略可测：生产默认 Date.now，测试可直接推时间而不 sleep。
  // 缓存值刻意存 Promise 而不是已解析的 Record：这是单飞（single-flight）的关键，见下方说明。
  const cache = new Map<string, { expires: number; value: Promise<Record<string, string>> }>();
  return (
    key: string,
    readPage: (cursor?: string) => Promise<GroupMemberPage>,
  ): Promise<Record<string, string>> => {
    const existing = cache.get(key);
    // 命中且未过期就返回同一个 Promise：并发调用者共享一次在途请求，
    // 不会因为同一群的多条消息同时到达而打出 N 份分页请求（渠道有频控，这直接决定可用性）。
    // [并发] 共享的是 Promise，因此后来者拿到的是同一结果对象；调用方不得修改返回值中的字段。
    if (existing && existing.expires > now()) return existing.value;
    // [权衡] 先放一个 expires=Infinity 的占位 entry 再异步填充，是为了让 entry 在 IIFE 执行前就有确定形状，
    // 避免 IIFE 内同步抛错时留下「未初始化」的对象。Infinity 只在这段极短窗口内可见，
    // 且此刻 entry 尚未写入 cache，因此不会被其它调用者读到。
    const entry = { expires: Infinity, value: Promise.resolve({} as Record<string, string>) };
    entry.value = (async () => {
      try {
        // null 原型：member_id 来自远端，普通字面量对象会让 "__proto__" 之类的键改写原型链；
        // 虽然下面只接受 ou_ 前缀，但把安全性放在结构上比放在校验顺序上更可靠（INV-09 的同类防御）。
        const names: Record<string, string> = Object.create(null);
        // visited 只记录「已用过的游标」，用于识别服务端返回自环/重复游标：
        // 没有这层检查，一个错误的 page_token 会让 do/while 永不结束，直到进程被拖死。
        const visited = new Set<string>();
        let cursor: string | undefined;
        do {
          const page = await readPage(cursor);
          for (const member of page.items ?? []) {
            // 两个条件都是硬性的：open_id 必须符合 ou_ 形态（否则无法用于 mention 定位），
            // 名字 trim 后必须非空（空名会让 UI 显示空白，且无法与其他成员区分）。
            if (member.member_id?.startsWith("ou_") && member.name?.trim()) {
              names[member.member_id] = member.name.trim();
            }
          }
          if (!page.has_more) break;
          // [失败路径] has_more 为真却没有下一页游标、或游标重复，都说明分页协议被破坏：
          // 此时抛错而不是 break，因为静默截断会把「只查到一半成员」当成完整目录缓存 60 秒。
          cursor = page.page_token;
          if (!cursor || visited.has(cursor)) throw new Error("Invalid group member pagination");
          visited.add(cursor);
        } while (cursor);
        // 成功结果缓存 60 秒：成员变更不频繁，一分钟的陈旧对「把 mention 渲染成名字」足够。
        // 这里在 IIFE 内写 entry.expires，保证「先有结果、再有 TTL」，不会出现有效期为真的空结果。
        entry.expires = now() + 60_000;
        return names;
      } catch (error) {
        // 缺少权限时短暂缓存失败，避免每条群消息重复查询；不暴露不完整的分页结果。
        // [权衡] 负缓存 30 秒而不是立即失效：权限缺失是稳定状态，重试只会放大频控；
        // 但缓存的是 rejected Promise，调用方必须 await/catch，否则会触发 unhandledRejection。
        entry.expires = now() + 30_000;
        throw error;
      }
    })();
    // delete + set 把该 key 移到 Map 插入序末尾：这是下面「按插入序淘汰」能起到近似 LRU 效果的前提。
    // [并发] 从这里到 return 之间没有 await，仍在同一个同步片段内，因此并发调用不会插入两条 entry。
    cache.delete(key);
    cache.set(key, entry);
    // 上限 128 条：按「最早插入」淘汰，而不是真正的最久未用——命中不会刷新顺序，
    // 因此热点条目理论上可能被淘汰；换来的是 O(1) 淘汰与无需额外链表。
    // [失败路径] size > 128 时 keys().next() 必然有值（刚 set 过至少一条），非空断言不会失败。
    if (cache.size > 128) cache.delete(cache.keys().next().value!);
    return entry.value;
  };
}
