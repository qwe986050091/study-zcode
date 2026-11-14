// INV-01 关闭函数只执行一次：守住位置 shutdownStarted；改错故障 重复释放资源。
// INV-02 父进程先断开可延后关闭：守住位置 parentDisconnected；改错故障 启动后无人关闭。
// INV-03 内建配置优先环境变量：守住位置 入口赋值；改错故障 显式路径被忽略。
// INV-04 内嵌配置物化到环境根：守住位置 分支；改错故障 release 目录校验失败。
// INV-05 缺少内建配置即失败：守住位置 早退判断；改错故障 服务带着空配置启动。
// INV-06 服务标识逐级回退：守住位置 空值合并；改错故障 空标识进入日志。
// INV-07 任务追踪可选服务：守住位置 可选获取；改错故障 缺失服务导致启动失败。
// INV-08 入口令牌先于 HTTP：守住位置 调用顺序；改错故障 出现无鉴权窗口。
// INV-09 ready 上报 Core 版本：守住位置 version 字段；改错故障 消费方读到 Node 版本。
// INV-10 心跳串行不重叠：守住位置 heartbeatInFlight；改错故障 慢响应堆积。
// INV-11 心跳同时带任务数：守住位置 心跳载荷；改错故障 父进程状态滞后。
// INV-12 心跳失败仍上报：守住位置 失败分支；改错故障 监控断流。
// INV-13 关闭先停心跳与订阅：守住位置 顺序；改错故障 关闭后仍有定时回调。
// INV-14 关闭容错释放服务：守住位置 忽略异常；改错故障 单个服务异常阻断退出。
// INV-15 关闭发送确认与退出消息：守住位置 发送顺序；改错故障 父进程收不到完成信号。
// INV-16 显式退出确保收口：守住位置 显式退出；改错故障 Supervisor 等待超时。
// INV-17 关闭命令与信号同源：守住位置 消息与信号处理；改错故障 两条路径行为不一致。
// INV-18 IPC 消息先判形状再判命令：守住位置 类型守卫；改错故障 非法消息触发关闭。
//
// 模块职责：启动服务器核心进程，装配服务、HTTP 入口与父进程通信。
// 状态所有权：进程级单例；关闭标记与心跳句柄局部持有。
// 阅读顺序：先看启动装配，再看 ready 与心跳，最后看关闭流程。
import { hostname } from "node:os";
import {
  createServerHostServices,
  disposeServiceResourcesAndWait,
  materializeZCodeBuiltinProviderConfig,
  getAppConfigDir,
  ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV,
  createTopicResourcePeers,
} from "@zcode/services/node";
import { IZCodeAgentService } from "@zcode/services";
import { ZCODE_VERSION } from "@zcode/shared";
import { createCoreHttpServer } from "./http.js";
import { createIngressToken } from "./ingressToken.js";
import { installParentDisconnectHandler } from "./parentDisconnect.js";
import { resolveCoreServerId } from "./serverIdentity.js";
import { createTaskActivityTracker } from "./taskActivityTracker.js";
import { resolveServerLayout } from "../runtime/paths.js";

declare const __ZCODE_BUILTIN_PROVIDER_CONFIG_JSON__: string | undefined;

export async function runServerCore(generation: number): Promise<void> {
  // shutdown 在初始化完成后才赋值，供 IPC 与信号处理共用。
  // 父进程先断开时只置 parentDisconnected = true，等初始化完再执行。
  // shutdownStarted 保证重复调用只生效一次。
  let shutdown: ((reason: string) => Promise<void>) | undefined;
  let parentDisconnected = false;
  let disposeParentDisconnectHandler = (): void => undefined;
  disposeParentDisconnectHandler = installParentDisconnectHandler(() => {
    if (shutdown) void shutdown("parent-disconnected");
    else parentDisconnected = true;
  });
  const layout = resolveServerLayout(process.env.ZCODE_SERVER_ROOT?.trim());
  // topicResourcePeers 由 createTopicResourcePeers 建立，生命周期随进程。
  // getChannel(request) 按请求惰性建通道，不预先分配。
  // topicResourcePeers 无需单独关闭，进程退出时随句柄释放。
  const topicResourcePeers = createTopicResourcePeers();
  const explicitZCodeBuiltinProviderConfigFilePath =
    process.env[ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]?.trim();
  // Built-in Config 物化到所属 Environment 配置根（~/.zcode/v2）而不是 release 自带的 runtime 目录：
  // release 目录是不可变的，同一 releaseId 重装时 assertExistingReleaseMatches 会重算整棵树的
  // 内容哈希，多出的物化文件会让校验失败。
  // explicitZCodeBuiltinProviderConfigFilePath 来自环境变量，优先级最高。
  // 未设置时用 __ZCODE_BUILTIN_PROVIDER_CONFIG_JSON__ 物化到配置根。
  // 显式文件避免写入 release 目录。
  const zcodeBuiltinProviderConfigFilePath = explicitZCodeBuiltinProviderConfigFilePath
    ? explicitZCodeBuiltinProviderConfigFilePath
    : typeof __ZCODE_BUILTIN_PROVIDER_CONFIG_JSON__ === "string"
      ? await materializeZCodeBuiltinProviderConfig({
          environmentConfigRoot: getAppConfigDir(),
          content: __ZCODE_BUILTIN_PROVIDER_CONFIG_JSON__,
        })
      : undefined;
  if (!zcodeBuiltinProviderConfigFilePath) {
    throw new Error(
      `当前构建未嵌入 ZCode Built-in Provider Config，且未设置 ${ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV}`,
    );
  }
  // resolveCoreServerId() 返回持久化标识时直接使用。
  // 为空时回退 hostname()，再回退固定名 "zcode-server"。
  // 三级回退保证 sourceServerId 永不为空。
  const sourceServerId = (await resolveCoreServerId()) ?? hostname() ?? "zcode-server";
  const { services, workspaceIdentityMapper, migrationFailedPathCount } =
    await createServerHostServices({
      sourceServerId,
      zcodeBuiltinProviderConfigFilePath,
      providerProvisioningTargetEnabled: true,
    topicResourceRelayChannel: (request) => topicResourcePeers.getChannel(request),
    });
  const taskActivityTracker = createTaskActivityTracker(services.getOptional(IZCodeAgentService));
  const ingressToken = await createIngressToken(layout);
  const http = await createCoreHttpServer(services, {
    serverId: sourceServerId,
    ingressToken,
    migrationFailedPathCount,
    workspaceIdentityMapper,
    topicResourcePeers,
  });
  // 无 IPC 通道时静默成功。
  // 父进程断连后不阻塞。
  // process.send 回调里的异常被吞掉，只保证 Promise 收敛。
  const send = (message: unknown): Promise<void> => {
    if (typeof process.send !== "function" || process.connected === false) return Promise.resolve();
    return new Promise((resolve) => {
      try {
        process.send?.(message, () => resolve());
      } catch {
        // 父进程断连后的最后一条生命周期消息不应阻塞资源释放。
        resolve();
      }
    });
  };
  // ready.version 的语义是 Core 版本；不能误发 Node runtime 版本常量
  // （22.16.0），否则消费方读取会拿到错误值。
  await send({
    type: "ready",
    host: http.host,
    port: http.port,
    version: ZCODE_VERSION,
    ...(process.env.ZCODE_SERVER_RELEASE_ID?.trim()
      ? { releaseId: process.env.ZCODE_SERVER_RELEASE_ID.trim() }
      : {}),
    generation,
  });
  let shutdownStarted = false;
  let lastRunningTaskCount = taskActivityTracker.readRunningTaskCount();
  // lastRunningTaskCount 记录上一次上报值，初值取 readRunningTaskCount()。
  // onDidChangeRunningTaskCount 回调里带上 runningTasks 列表。
  // activitySubscription 在关闭流程里统一释放。
  const activitySubscription = taskActivityTracker.onDidChangeRunningTaskCount(
    (runningTaskCount) => {
      lastRunningTaskCount = runningTaskCount;
      void send({
        type: "task-activity",
        runningTasks: taskActivityTracker.readRunningTasks(),
        runningTaskCount,
      });
    },
  );
  let heartbeatInFlight: Promise<void> | undefined;
  const heartbeat = setInterval(() => {
    if (heartbeatInFlight) return;
    heartbeatInFlight = Promise.resolve(taskActivityTracker.readRunningTaskCount())
      .then((runningTaskCount) => {
        if (runningTaskCount !== lastRunningTaskCount) {
          lastRunningTaskCount = runningTaskCount;
          void send({
            type: "task-activity",
            runningTasks: taskActivityTracker.readRunningTasks(),
            runningTaskCount,
          });
        }
        void send({
          type: "heartbeat",
          runningTasks: taskActivityTracker.readRunningTasks(),
          at: Date.now(),
          runningTaskCount,
        });
      })
      .catch(() => {
        void send({
          type: "heartbeat",
          runningTasks: taskActivityTracker.readRunningTasks(),
          at: Date.now(),
          runningTaskCount: lastRunningTaskCount,
        });
      })
      .finally(() => {
        heartbeatInFlight = undefined;
      });
  }, 10_000);
  shutdown = async (reason: string): Promise<void> => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    disposeParentDisconnectHandler();
    clearInterval(heartbeat);
    activitySubscription.dispose();
    taskActivityTracker.dispose();
    await http.close().catch(() => undefined);
    await disposeServiceResourcesAndWait(services).catch(() => undefined);
    await send({ type: "shutdown-ack" });
    await send({ type: "exit", reason });
    try {
      process.disconnect?.();
    } catch {
      // 父进程已断连时 disconnect 可能报告 IPC_CHANNEL_CLOSED；不影响资源已释放后的退出。
    }
    // 仅设置 exitCode 无法关闭 Agent/SQLite 等仍持有的事件循环；Supervisor 的有界停止
    // 会因此等待到超时。资源释放完成后显式退出，确保 stop/restart/uninstall 真正收口。
    process.exit(0);
  };
  if (parentDisconnected) void shutdown("parent-disconnected");
  process.on("message", (message: unknown) => {
    if (
      typeof message === "object" &&
      message !== null &&
      "command" in message &&
      message.command === "shutdown"
    ) {
      void shutdown("requested");
    }
  });
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}
