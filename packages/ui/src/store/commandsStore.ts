// INV-01 身份键统一取 workspaceIdentity 去空白后回退 workspacePath，再回退固定哨兵，禁止各 action 自行拼接；守住位置：listKey；改错故障：同路径不同身份共享在途与投影，切换 Scope 后列表串台。
// INV-02 任何异步结果写回之前都要重新比对发起时的 key，不能只看 await 是否成功；守住位置：initialize 与 refresh 的提前返回；改错故障：慢 target 的列表覆盖当前投影，随后操作打到错误 host。
// INV-03 同一 key 在同一时刻只允许一个在途清单请求，后续调用等待既有 promise；守住位置：inflightLists 与 existing 分支；改错故障：双发请求写回顺序颠倒，界面回退到旧快照。
// INV-04 在途表项必须在 finally 删除，且登记发生在请求体启动之后；守住位置：inflightLists 的 get、set、delete 三个点；改错故障：失败后 key 永久占位，后续刷新全部拿到旧结果。
// INV-05 loading 置 false 只在当前 key 匹配时执行，提前返回路径不得改动加载态；守住位置：initialize 与 refresh 的成功、失败分支；改错故障：滞后请求把新 target 的加载态提前结束，出现空列表。
// INV-06 error 只在当前 key 匹配时写入，旧 target 的失败不得显示在新 target 上；守住位置：两处 catch 的判空分支；改错故障：切换工作区后提示条挂着上一个 host 的错误。
// INV-07 loadedWorkspacePath 与 loadedWorkspaceIdentity 表示投影归属，必须与 commands 同一次写入；守住位置：initialize 与 refresh 的 set 字面量；改错故障：列表与来源声明不一致，后续操作拿着旧 host 的标识。
// INV-08 commands 与 userCommands 必须同源同序写入，不允许只更新其中一份；守住位置：刷新与增删改的全部 set；改错故障：命令面板有条目而用户域面板缺失，数量对不上。
// INV-09 创建成功只在 key 未变时并入列表，追加语义不得重建已有条目；守住位置：createCommand 的写回分支；改错故障：新建命令出现在已切换的 Scope 里，用户以为写入失败。
// INV-10 命令 id 唯一，更新使用原位替换，重命名不得改变条目下标；守住位置：updateCommand 的两处 map；改错故障：改完名字条目跳到列表末尾，选中项错位。
// INV-11 删除必须同时移除 commands 与 userCommands 中同 id 的条目；守住位置：deleteCommand 的两处 filter；改错故障：用户面板残留幽灵条目，点击后报文件不存在。
// INV-12 启停开关只改 enabled 字段，不得替换 id、scope 或描述；守住位置：toggleCommand 的展开赋值；改错故障：一次开关把远端返回的其它字段冲掉，命令行为变化。
// INV-13 operatingCommandId 是单槽标记，同一时刻只表示一条命令正在被操作；守住位置：update、delete、toggle 的入口 set；改错故障：并发操作时多行同时转圈，指示与真实请求错位。
// INV-14 operatingCommandId 必须在成功、失败、key 变更三条路径上清空；守住位置：三个 action 的 set 与 catch；改错故障：操作按钮永久转圈，必须重开页面才能恢复。
// INV-15 服务错误统一归一化为字符串消息，Error 与非 Error 都要有可读文本；守住位置：各 catch 的 message 构造；改错故障：抛出非 Error 时界面显示 [object Object]。
// INV-16 失败路径必须继续抛出，不能吞掉；守住位置：create、update、delete、toggle 的 catch 末尾；改错故障：调用方误以为成功而关闭表单，用户输入丢失。
// INV-17 key 已变更时的失败不写 error，但仍要抛出；守住位置：catch 内的三元表达式；改错故障：旧 host 的错误污染新 host 的提示条，同时调用方无从感知失败。
// INV-18 capability 只由服务回包定义，客户端不得自行推断用户级是否可用；守住位置：刷新时对 capability 的整体覆盖；改错故障：只读环境仍显示可新建入口，提交后才报权限错误。
// INV-19 初始 capability 取宽松默认，等首次回包校正；守住位置：store 初始 state；改错故障：首帧误禁用新建入口，用户点不到按钮也无法自行恢复。
//
// 模块职责：命令注册表投影由 commandsStore 持有并供命令面板与设置页共用，只做拉取与增删改。
// 状态所有权：命令事实归 ICommandsService，本文件只持有当前 Scope 的投影、加载态与错误。
// 阅读顺序：先看 listKey 与 currentListKey 的身份闸门，再看四个 action 的写回与失败分支。
import { create } from "zustand";
import type {
  CommandCreateParams,
  CommandDeleteParams,
  CommandSetEnabledParams,
  CommandUpdateParams,
  UserCommand,
  ZCodeCommand,
} from "@zcode/shared";
import type { ICommandsService } from "@zcode/services";

// 投影字段分三组：Scope 身份、命令列表、操作与错误状态。
// [权衡] 两份身份字段并存，workspacePath 供文件操作，workspaceIdentity 供跨 host 去重。
interface CommandsStoreState {
  workspacePath: string | null;
  workspaceIdentity: string | null;
  loadedWorkspacePath: string | null;
  loadedWorkspaceIdentity: string | null;
  // 合并后的命令全集，用户命令与插件命令都在其中，id 由服务端保证唯一。
  // [权衡] 客户端不重新排序，保持服务回包顺序，避免每次刷新列表跳动。
  // 列表引用即渲染依据，所以 commands 更新时优先原位替换而非整体重建以免整表重渲染。
  commands: ZCodeCommand[];
  // 用户域命令的独立投影，与全集同源写入，供设置页过滤展示。
  // 该投影只做展示裁剪，不承担权限判断，能力位由 capability 单独给出。
  userCommands: UserCommand[];
  pluginCommands: ZCodeCommand[];
  capability: { userScopeAvailable: boolean };
  loading: boolean;
  error: string | null;
  // [事务] 单槽在途标记，用命令 id 而非布尔值，便于只点亮对应行。
  // 为 null 表示当前没有进行中的写操作，空转的加载指示不应出现。
  operatingCommandId: string | null;
  initialize: (
    workspacePath: string | undefined,
    commandsService: ICommandsService,
    workspaceIdentity?: string,
  ) => Promise<void>;
  refresh: (commandsService: ICommandsService) => Promise<void>;
  createCommand: (
    params: CommandCreateParams,
    commandsService: ICommandsService,
  ) => Promise<UserCommand | null>;
  updateCommand: (
    params: CommandUpdateParams,
    commandsService: ICommandsService,
  ) => Promise<UserCommand | null>;
  deleteCommand: (
    params: CommandDeleteParams,
    commandsService: ICommandsService,
  ) => Promise<boolean>;
  toggleCommand: (
    params: CommandSetEnabledParams,
    commandsService: ICommandsService,
  ) => Promise<void>;
}

// [并发] 按 key 收敛在途请求，同一 Scope 的重复初始化共享同一个 promise。
// [资源] 表项在 finally 删除，成功与失败都会释放，不做常驻缓存。
const inflightLists = new Map<string, Promise<void>>();

type StoreGet = () => CommandsStoreState;

// listKey 是身份键的唯一构造点，去重与在途登记及写回比对都从这里取值。
// [权衡] 优先身份而非路径，远程同名路径只有身份能区分。
function listKey(workspacePath: string | undefined, workspaceIdentity?: string): string {
  // 先 trim 再判空，避免仅含空白的身份被当成有效键。
  // 哨兵字符串不会与真实路径相等，无工作区场景因此不会误共享。
  return workspaceIdentity?.trim() || workspacePath || "__no_workspace__";
}

// store 是单例，Scope 菜单可在同一页面切换 target。任何异步结果写回之前都要比对
// 发起时的 target key，否则慢 target 的列表会覆盖当前投影，随后 delete/toggle 会拿着旧 host
// 的 filePath 在当前 target 的 host 上执行。
// [并发] 每次写回前调 currentListKey(get) 重新取键，而不是复用发起时闭包里的 key。
// 这是防止慢 Scope 覆盖新投影的唯一判据，任何 set 之前都要过这一关。
function currentListKey(get: StoreGet): string {
  const { workspacePath, workspaceIdentity } = get();
  return listKey(workspacePath ?? undefined, workspaceIdentity ?? undefined);
}

// store 是模块级单例，多窗口共享同一份投影，不按组件实例复制。
// action 内一律用 get 读取最新快照，避免闭包持有过期列表。
export const useCommandsStore = create<CommandsStoreState>((set, get) => ({
  workspacePath: null,
  workspaceIdentity: null,
  loadedWorkspacePath: null,
  loadedWorkspaceIdentity: null,
  commands: [],
  userCommands: [],
  pluginCommands: [],
  capability: { userScopeAvailable: true },
  loading: false,
  error: null,
  operatingCommandId: null,

  // [并发] 先同步身份再进入网络请求，保证发起瞬间的键与后续比对一致。
  // [失败路径] 同 key 已在途时直接等待旧 promise，不重复打服务。
  initialize: async (workspacePath, commandsService, workspaceIdentity) => {
    // 身份去空白后为空即视为无身份，避免空串参与键比较。
    // 路径不做 trim，保留工作区原样用于文件操作与命令 cwd。
    const normalizedWorkspaceIdentity = workspaceIdentity?.trim() || null;
    set({ workspacePath: workspacePath ?? null, workspaceIdentity: normalizedWorkspaceIdentity });
    const key = listKey(workspacePath, normalizedWorkspaceIdentity ?? undefined);
    // [并发] inflightLists.get(key) 命中的调用者 await 同一个 promise，因此第二个调用者不新增请求。
    // 提前返回前不写 loading，避免把已有请求的加载态重置一轮。
    const existing = inflightLists.get(key);
    if (existing) {
      await existing;
      return;
    }
    const promise = (async () => {
      set({ loading: true, error: null });
      try {
        const result = await commandsService.list({
          workspacePath,
          ...(normalizedWorkspaceIdentity
            ? { workspaceIdentity: normalizedWorkspaceIdentity }
            : {}),
        });
        if (currentListKey(get) !== key) return;
        set({
          commands: result.commands,
          userCommands: result.userCommands,
          pluginCommands: result.pluginCommands,
          capability: result.capability,
          // loadedWorkspacePath 与 commands 在同一次 set 里落定，分开写会让归属与列表短暂不一致。
          // 归属字段供后续判断当前列表是否仍对应当前 Scope。
          loadedWorkspacePath: workspacePath ?? null,
          loadedWorkspaceIdentity: normalizedWorkspaceIdentity,
          loading: false,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (currentListKey(get) !== key) return;
        set({ loading: false, error: message });
      } finally {
        // [资源] finally 删除确保成功、失败、提前返回都会释放 key。
        inflightLists.delete(key);
      }
    })();
    inflightLists.set(key, promise);
    await promise;
  },

  // 刷新复用当前身份快照，不改变 Scope，只重拉同一 target 的列表。
  // [并发] 与 initialize 共用键判据，但独立发请求，不共享在途表。
  refresh: async (commandsService) => {
    const { workspacePath, workspaceIdentity } = get();
    const key = currentListKey(get);
    set({ loading: true, error: null });
    try {
      const result = await commandsService.list({
        workspacePath: workspacePath ?? undefined,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
      });
      if (currentListKey(get) !== key) return;
      set({
        commands: result.commands,
        userCommands: result.userCommands,
        pluginCommands: result.pluginCommands,
        capability: result.capability,
        loadedWorkspacePath: workspacePath,
        loadedWorkspaceIdentity: workspaceIdentity,
        loading: false,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (currentListKey(get) !== key) return;
      set({ loading: false, error: message });
    }
  },

  // [事务] 先清错误再写文件，写入成功才产生本地可见的新条目。
  // [并发] 写入发生在发起时的 host，键变更后结果不并入当前投影。
  createCommand: async (params, commandsService) => {
    const key = currentListKey(get);
    set({ error: null });
    try {
      const { command } = await commandsService.writeCommandFile(params);
      // 写入在发起时的 target host 上已完成，但期间若切了 Scope，
      // 结果不能再合并进当前 target 的投影，否则列表混入别的 host 的命令。
      if (currentListKey(get) !== key) return command;
      const { commands, userCommands } = get();
      set({
        // 成功路径用追加而非整表替换，保住已有条目的顺序与引用。
        // userCommands 同步追加，保证全集与用户域两份投影不漂移。
        // [权衡] 同 id 若已存在会形成重复项，服务保证唯一性是该追加的前提。
        commands: [...commands, command],
        userCommands: [...userCommands, command],
      });
      return command;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (currentListKey(get) !== key) throw err;
      set({ error: message });
      throw err;
    }
  },

  // [事务] 用 operatingCommandId 标记在途命令，供对应行显示加载态。
  // 键变更时先清操作态再返回结果，避免新 Scope 看到旧行的忙碌指示。
  updateCommand: async (params, commandsService) => {
    const key = currentListKey(get);
    set({ operatingCommandId: params.commandId, error: null });
    try {
      const { command } = await commandsService.updateCommandFile(params);
      if (currentListKey(get) !== key) {
        set({ operatingCommandId: null });
        return command;
      }
      const { commands, userCommands } = get();
      set({
        // map 原位替换保持下标与顺序不变，列表不会因重命名而跳动。
        commands: commands.map((c) => (c.id === params.commandId ? command : c)),
        userCommands: userCommands.map((c) => (c.id === params.commandId ? command : c)),
        operatingCommandId: null,
      });
      return command;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set(
        currentListKey(get) === key
          ? { operatingCommandId: null, error: message }
          : { operatingCommandId: null },
      );
      throw err;
    }
  },

  // [事务] 先删远端文件，成功后才从两份投影里移除同 id 条目。
  // [失败路径] 删除失败保留原条目并抛出，清单不出现幽灵项。
  deleteCommand: async (params, commandsService) => {
    const key = currentListKey(get);
    set({ operatingCommandId: params.commandId, error: null });
    try {
      // [资源] 文件删除是唯一副作用，成功后本地只做投影裁剪。
      await commandsService.deleteCommandFile(params);
      if (currentListKey(get) !== key) {
        set({ operatingCommandId: null });
        return true;
      }
      const { commands, userCommands } = get();
      set({
        commands: commands.filter((c) => c.id !== params.commandId),
        userCommands: userCommands.filter((c) => c.id !== params.commandId),
        operatingCommandId: null,
      });
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set(
        currentListKey(get) === key
          ? { operatingCommandId: null, error: message }
          : { operatingCommandId: null },
      );
      throw err;
    }
  },

  // [事务] 服务成功后本地按目标 enabled 覆盖，不回读整表。
  // 两份投影在同一次 set 更新，避免全集与用户面板开关状态打架。
  toggleCommand: async (params, commandsService) => {
    const key = currentListKey(get);
    set({ operatingCommandId: params.commandId, error: null });
    try {
      // [失败路径] 服务失败不做本地回滚，因为写入前未修改投影。
      await commandsService.setCommandEnabled(params);
      if (currentListKey(get) !== key) {
        set({ operatingCommandId: null });
        return;
      }
      const { commands, userCommands } = get();
      set({
        commands: commands.map((command) =>
          command.id === params.commandId ? { ...command, enabled: params.enabled } : command,
        ),
        userCommands: userCommands.map((command) =>
          command.id === params.commandId ? { ...command, enabled: params.enabled } : command,
        ),
        operatingCommandId: null,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set(
        currentListKey(get) === key
          ? { operatingCommandId: null, error: message }
          : { operatingCommandId: null },
      );
      throw err;
    }
  },
// 文件收尾：action 以对象字面量方法注册，store 实例在此创建并导出。
}));
