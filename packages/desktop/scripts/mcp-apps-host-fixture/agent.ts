// INV-01 Events 是一次性交付语义：命中后立即从等待集合移除，同一事件不会被两个等待者共享。
// INV-02 emit 必须先追加历史再遍历等待者，遍历期间新增的等待者不会收到本次事件，这是有意的时序边界。
// INV-03 wait 的 after 是 history 下标而非事件计数，传错会让用例读到上一轮会话的残留事件。
// INV-04 控制端口必须绑定 127.0.0.1，禁止监听全部网卡，避免夹具端口暴露到局域网。
// INV-05 端口必须由 listen 0 交由系统分配，硬编码会在并行测试间产生抢占与串扰。
// INV-06 sockets 以 source 名为键，来源由模拟 MCP 服务端自报，键名是夹具内部契约不得随意更改。
// INV-07 sockets 与 socketSources 必须双向维护，只更新一侧会导致向已销毁连接写入。
// INV-08 连接关闭后必须重绑定到同 source 的存活实例，否则重连场景会写进死句柄。
// INV-09 release、disconnect、notify 通过非空断言直写连接，调用方必须先确认 source 已登记。
// INV-10 子进程环境只保留 PATH 与夹具目录变量，父进程的 API key、真实认证与 Electron 标志一律不继承。
// INV-11 ZCODE_DATA_BASE_DIR 与 ZCODE_STORAGE_DIR 必须指向同一个隔离目录，分叉会让存储与会话库错位。
// INV-12 requireStorageStartup 必须为 true，存储异常要在握手阶段暴露而不是推迟到首个会话请求。
// INV-13 默认 15 秒 RPC 期限不得套用到 mcp/uiCallTool，真实编辑器长轮询需要 180 秒窗口。
// INV-14 运行偏好查询必须显式关闭原生搜索增强与记忆，夹具不得触达外部能力。
// INV-15 权限请求只投递到 approvals 事件流，夹具不自动放行，决策权始终在测试用例。
// INV-16 未识别的服务端请求方法必须回 -32601，静默忽略会让客户端一直等到超时。
// INV-17 session 与 uiSession 的返回对象是对外契约，sessionId 只能取自创建响应，不得伪造。
// INV-18 关闭顺序固定为传输层收尾、客户端释放、连接销毁、控制服务器关闭，跳步会残留句柄。
//
// 模块职责：为桌面 MCP Apps 测试拉起真实 CLI app-server 子进程，并提供事件流、审批流与模拟 MCP 连接的控制入口。
// 状态所有权：Events 独占历史与等待者；sockets 与 socketSources 独占来源到连接的映射；会话与工具状态归子进程，夹具只转发不持有。
// 阅读顺序：Events 工具 → 控制端口与连接登记 → 子进程与环境隔离 → 协议客户端与请求分派 → 对外能力与关闭顺序。
import { spawn } from "node:child_process";
import { createServer, type Socket } from "node:net";
import { createInterface } from "node:readline";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ZCodeProtocolClient } from "../../../services/src/zcode-agent/zcodeProtocolClient.js";
import { ZCodeStdioTransport } from "../../../services/src/zcode-agent/zcodeStdioTransport.js";

// 事件缓冲的最小实现，只为夹具内的等待与回放服务，不承诺跨进程或持久化语义。
// [资源] history 只追加不清理，长用例的内存会随事件数线性增长，需要在断言后自行收敛。
export class Events<T> {
  readonly history: T[] = [];
  private waiters = new Set<{ match: (event: T) => boolean; resolve: (event: T) => void }>();
  // [并发] 先入历史再遍历等待者，保证后注册的等待者不会错过早期事件也能被 after 切片补齐。
  // 命中即删除再交付，一个事件只交给一个等待者，避免用例间互相偷走对方的事件。
  emit(event: T) {
    this.history.push(event);
    for (const waiter of this.waiters)
      if (waiter.match(event)) {
        this.waiters.delete(waiter);
        waiter.resolve(event);
      }
  }
  // 先查历史再挂等待者，让已经发生的事件立即返回，不依赖后续再发一次。
  // [失败路径] 无命中时永不结算，用例必须有外部超时兜底，否则测试进程会挂死。
  wait(match: (event: T) => boolean, after = 0): Promise<T> {
    const existing = this.history.slice(after).find(match);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve) => this.waiters.add({ match, resolve }));
  }
}
// 夹具主入口：返回时控制端口已在监听、子进程已拉起、协议客户端的通知与请求监听都已挂好。
// [失败路径] 前置步骤中途抛错会留下已打开的端口或子进程，启动阶段需要兜底清理。
// [权衡] 夹具直接持有子进程与传输层，换来用例对生命周期与事件时序的完全可见。
export async function startAgent(
  root: string,
  node: string,
  cli: string,
  providerEnv: Record<string, string> = {},
) {
  const events = new Events<any>();
  const approvals = new Events<any>();
  const notifications = new Events<any>();
  // 来源到连接的映射是释放、断开与通知三条写路径的唯一寻址依据，键必须与创建会话时传入的 source 一致。
  // [资源] 该表不自动过期，关闭阶段统一销毁全部连接，否则残留句柄会拖住进程退出。
  const sockets = new Map<string, Socket>();
  const socketSources = new Map<Socket, string>();
  // 控制端口承接模拟 MCP 服务端的登记与事件上报，是夹具与外部子进程之间唯一的入站通道。
  // [失败路径] 每行按 JSON 解析，格式错误会抛出并中断该连接的事件流，不会污染其它来源。
  // [并发] 同一来源重复登记时后写覆盖先写，旧连接依靠关闭回调重新选主。
  const control = createServer((socket) => {
    createInterface({ input: socket }).on("line", (line) => {
      const event = JSON.parse(line);
      socketSources.set(socket, event.source);
      sockets.set(event.source, socket);
      events.emit(event);
    });
    // [资源] 关闭时必须同时清理两张表，只清一侧会让后续写入命中已销毁的 socket。
    // [并发] 反向遍历选取最新且未销毁的同源连接，避免重连窗口内被旧实例顶掉。
    // 只有找不到可用替代时才删除来源，保证短暂重连期间指令仍可寻址。
    socket.on("close", () => {
      const source = socketSources.get(socket);
      socketSources.delete(socket);
      if (source && sockets.get(source) === socket) {
        const previous = [...socketSources]
          .reverse()
          .find(([candidate, key]) => key === source && !candidate.destroyed);
        if (previous) sockets.set(source, previous[0]);
        else sockets.delete(source);
      }
    });
  });
  // 回环地址加系统分配端口，是并行用例之间互不干扰的前提。
  // [失败路径] 端口不可用时不会结算，启动阶段需要超时护栏把挂起转为明确失败。
  await new Promise<void>((resolve) => control.listen(0, "127.0.0.1", resolve));
  const port = (control.address() as { port: number }).port;
  const data = join(root, "agent-data");
  await mkdir(data, { recursive: true });
  // 不继承 API key、真实用户认证及 Electron Node 标志，模型测试也只通过显式传入的隔离配置访问本地 fixture。
  // [失败路径] 三段式参数固定为解释器、CLI 入口与 app-server 子命令，缺少子命令会让子进程立刻退出。
  // [资源] 环境变量按白名单重建，父进程的密钥、真实登录态与 Electron 标志都不会被带进子进程。
  // 工作目录与数据目录统一指向 agent-data，会话库和存储因此落在同一个隔离根下。
  const child = spawn(node, [cli, "app-server"], {
    cwd: data,
    env: {
      PATH: process.env.PATH,
      ZCODE_DATA_BASE_DIR: data,
      ZCODE_SESSION_DB: join(data, "session.sqlite"),
      ZCODE_STORAGE_DIR: data,
      LANG: "en_US.UTF-8",
      ...providerEnv,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const transport = new ZCodeStdioTransport(child, {
    onStderrLine: (line) => process.stderr.write(line + "\n"),
  });
  // 开启存储启动校验，让初始化失败在握手阶段就被看见。
  // [失败路径] 此处期限只覆盖普通请求，长轮询由调用封装单独放宽。
  const client = new ZCodeProtocolClient(transport, {
    requireStorageStartup: true,
    requestTimeoutMs: 15_000,
  });
  client.onNotification((event) => notifications.emit(event));
  // [契约] 服务端请求全部经 onRequest 分流：运行偏好与权限走对应发射器；未知方法回 32601，不静默吞掉。
  // [失败路径] 未知方法回 -32601，客户端不会无限等待，协议不匹配能立刻定位。
  // 运行偏好查询固定关闭搜索增强与记忆，保证夹具行为与外部环境无关。
  client.onRequest((request) => {
    if (request.method === "session/requestRuntimePreferences")
      void client.respond(request.id, {
        nativeSearchEnhancementsEnabled: false,
        memoryEnabled: false,
      });
    else if (request.method === "interaction/requestPermission") approvals.emit(request);
    else
      void client.respondError(request.id, -32601, `Unexpected fixture request: ${request.method}`);
  });
  // 真实编辑器的长轮询为 20 秒，不能套夹具普通 RPC 的 15 秒期限。
  // [权衡] 工具调用单独放宽到 180 秒以对齐真实编辑器长轮询，其余方法沿用默认期限。
  // 统一出口让所有用例共享同一超时策略，避免各处自行传参造成口径不一。
  const call = (method: string, params: unknown) =>
    client.request<any>(
      method as never,
      params,
      undefined,
      method === "mcp/uiCallTool" ? { timeoutMs: 180_000 } : undefined,
    );
  return {
    call,
    client,
    events,
    approvals,
    notifications,
    respond: (request: any, decision: "allow" | "deny") => client.respond(request.id, { decision }),
    // [失败路径] 依赖非空断言直写连接，来源未登记时会在写入处抛错，而不是静默丢弃指令。
    release: (source: string, key: string) =>
      sockets.get(source)!.write(JSON.stringify({ type: "release", key }) + "\n"),
    disconnect: (source: string) =>
      sockets.get(source)!.write(JSON.stringify({ type: "disconnect" }) + "\n"),
    notify: (source: string, uri: string) =>
      sockets.get(source)!.write(JSON.stringify({ type: "notify", uri }) + "\n"),
    // 标准会话入口：先建工作区目录，再以延迟持久化与关闭标题生成的方式创建会话，减少无关副作用。
    // MCP 服务以 legacy 协议与会话级隔离注册，服务脚本由夹具注入端口、页面路径与来源标识。
    // [失败路径] sessionId 只从创建响应读取，缺失即视为协议破坏，不在夹具内补默认值掩盖问题。
    async session(
      workspacePath: string,
      source: string,
      serverName = "fixture",
      workspaceIdentity?: string,
      demo?: { serverScript: string; resourceUri: string },
    ) {
      await mkdir(workspacePath, { recursive: true });
      const workspace = {
        workspacePath,
        workspaceKey: workspaceIdentity ?? workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
      };
      const response = await call("session/create", {
        workspace,
        mode: "build",
        persistence: "deferred",
        titleGenerationEnabled: false,
        mcpServers: [
          {
            name: serverName,
            command: node,
            args: demo
              ? [demo.serverScript]
              : [join(root, "mcp-server.mjs"), String(port), join(root, "widget.html"), source],
            env: [],
            protocolVersion: "legacy",
            isolation: "session",
          },
        ],
      });
      return {
        workspace,
        sessionId: response.session.sessionId,
        pluginId: "fixture",
        serverName,
        ...(demo ? { resourceUri: demo.resourceUri } : {}),
      };
    },
    // UI 会话入口改用插件目录与 zcode.json 声明，走 yolo 模式让自动化操作不被审批打断。
    // [权衡] 插件标识与服务器名取固定拼接格式，改动必须与调用方断言同步。
    async uiSession(
      workspacePath: string,
      source: string,
      demo?: { serverScript: string; resourceUri: string; surface: string },
    ) {
      const pluginRoot = join(workspacePath, "editor-plugin");
      await mkdir(join(pluginRoot, ".zcode-plugin"), { recursive: true });
      await writeFile(
        join(pluginRoot, ".zcode-plugin", "plugin.json"),
        JSON.stringify({
          name: "background-editor",
          mcpServers: {
            editor: {
              command: node,
              args: demo
                ? [demo.serverScript]
                : [join(root, "mcp-server.mjs"), String(port), join(root, "widget.html"), source],
            },
          },
        }),
      );
      await writeFile(
        join(workspacePath, "zcode.json"),
        JSON.stringify({ plugins: { dirs: [pluginRoot] } }),
      );
      const workspace = { workspacePath, workspaceKey: workspacePath };
      const response = await call("session/create", {
        workspace,
        mode: "yolo",
        persistence: "deferred",
        titleGenerationEnabled: false,
      });
      return {
        workspace,
        sessionId: response.session.sessionId,
        pluginId: "background-editor@inline",
        serverName: "plugin:background-editor:editor",
        ...(demo ? { resourceUri: demo.resourceUri, surface: demo.surface } : {}),
      };
    },
    // 关闭顺序固定：先停传输层并等待收尾，再释放客户端，随后销毁连接，最后关闭控制服务器。
    // [资源] 任一步被跳过都会留下句柄，测试进程无法自然退出。
    async close() {
      await transport.disposeAndWait();
      client.dispose();
      for (const socket of sockets.values()) socket.destroy();
      await new Promise<void>((resolve) => control.close(() => resolve()));
    },
  };
}
