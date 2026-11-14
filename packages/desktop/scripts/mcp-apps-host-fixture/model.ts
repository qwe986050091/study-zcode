// INV-01 夹具独立：守住位置 本文件的依赖；改错故障：夹具引入真实供应商 SDK，离线环境无法启动。
// INV-02 计划消费：守住位置 plans 的 shift；改错故障：同一计划被两次请求复用。
// INV-03 请求可观测：守住位置 requests 事件；改错故障：测试无法断言请求是否到达。
// INV-04 延迟应答：守住位置 delayed 分支；改错故障：无法在响应前断言请求已发出。
// INV-05 拒绝计划：守住位置 status 分支；改错故障：鉴权失败场景只能靠真实密钥复现。
// INV-06 释放表清理：守住位置 releases 的 delete；改错故障：重复释放导致二次应答。
// INV-07 已关闭不写：守住位置 res.destroyed 判断；改错故障：向已断开连接写入抛错。
// INV-08 中止事件：守住位置 close 回调；改错故障：取消传播在夹具侧不可断言。
// INV-09 挂起流：守住位置 holdStream 分支；改错故障：长流场景无法模拟。
// INV-10 工具名后缀：守住位置 endsWith 匹配；改错故障：带命名空间前缀的工具匹配不到。
// INV-11 增量结构：守住位置 tool_calls 的 index 与 id；改错故障：客户端合并增量失败。
// INV-12 结束帧：守住位置 finish_reason 的分支；改错故障：工具调用结束后客户端仍等待。
// INV-13 用量字段：守住位置 usage 元数据；改错故障：计费或统计路径在夹具下报错。
// INV-14 端口动态：守住位置 listen 的零端口；改错故障：并行用例争抢固定端口。
// INV-15 配置同源：守住位置 内置配置复制来源；改错故障：夹具规则与仓库配置漂移。
// INV-16 个人配置指向本地：守住位置 baseUrl 拼接；改错故障：夹具请求打到真实服务。
// INV-17 关闭彻底：守住位置 closeAllConnections；改错故障：用例结束后进程不退出。
// INV-18 环境变量注入：守住位置 env 返回；改错故障：被测进程读不到夹具配置。
//
// 模块职责：为端到端夹具提供确定性的本地 OpenAI 兼容模型服务与配置。
// 状态所有权：请求队列与计划队列属于本次启动；用例之间不共享。
// 阅读顺序：入口与队列 → 请求分流 → 非流式应答 → 中止与挂起 → 流式增量 → 配置与返回。
import { createServer } from "node:http";
import { copyFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Events } from "./agent.js";
// 确定性本地模型只返回预置工具调用；授权、认领、执行、取消仍走真实 Agent。
// 每次启动新建请求队列与计划队列，状态不跨用例泄漏。
// 计划队列按请求顺序消费，测试可精确控制第几次调用的行为。
//
export async function startModel(root: string, cli: string) {
  const requests = new Events<any>();
  const plans: {
    key: string;
    delayed: boolean;
    holdStream?: boolean;
    toolName?: string;
    arguments?: Record<string, unknown>;
    status?: number;
    finishReason?: string;
  }[] = [];
  const aborted = new Events<string>();
  const releases = new Map<string, () => void>();
  // 同一个 handler 先读完 request body 再按 stream 字段分流。
  // 工具名按后缀匹配，兼容供应商给工具加命名空间前缀。
  //
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const plan = plans.shift();
    const tool = body.tools?.find((t: any) =>
      t.function?.name.endsWith(`__${plan?.toolName ?? "page_edit"}`),
    );
    // 非流式分支支持延迟应答：测试先断言 request 到达，再 resolve 响应。
    // 拒绝计划直接返回鉴权错误体，模拟供应商侧失败。
    //
    if (!body.stream) {
      // 应答前清理释放表，避免同一键被重复触发。
      // 连接已销毁时直接返回，防止向已关闭的响应写入。
      //
      const reply = () => {
        releases.delete(plan?.key ?? "");
        if (res.destroyed) return;
        if (plan?.status) {
          res.writeHead(plan.status, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: {
                message: "fixture provider denied",
                type: "authentication_error",
                code: "invalid_api_key",
              },
            }),
          );
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            id: "sampling-fixture",
            object: "chat.completion",
            created: 1,
            model: "gpt-4o",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: `answer:${plan?.key ?? "sample"}` },
                finish_reason: plan?.finishReason ?? "stop",
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
        );
      };
      // 客户端提前断开时发出取消事件，供测试断言中止传播。
      // 关闭回调同时清理释放表，保证键不会残留。
      //
      res.on("close", () => {
        if (!res.writableEnded) aborted.emit(plan?.key ?? "sample");
        releases.delete(plan?.key ?? "");
      });
      if (plan?.delayed) releases.set(plan.key, reply);
      requests.emit({ body, plan, tool, url: req.url });
      if (!plan?.delayed) reply();
      return;
    }
    requests.emit({ body, plan, tool, url: req.url });
    // 挂起流只写一行注释并保持连接，直到测试显式释放。
    // 释放函数写在结束事件里，键随连接关闭一起删除。
    //
    if (plan?.holdStream) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(": fixture running\n\n");
      releases.set(plan.key, () => res.end("data: [DONE]\n\n"));
      res.on("close", () => releases.delete(plan.key));
      return;
    }
    // 有计划且命中工具时返回工具调用增量，参数取计划里的对象。
    // 否则回一条普通文本，用于非工具场景的收尾。
    //
    const delta =
      plan && tool
        ? {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: `call_${plan.key}`,
                type: "function",
                function: {
                  name: tool.function.name,
                  arguments: JSON.stringify(plan.arguments ?? plan),
                },
              },
            ],
          }
        : { role: "assistant", content: "fixture complete" };
    const base = {
      id: "fixture-completion",
      object: "chat.completion.chunk",
      created: 1,
      model: "gpt-4o",
    };
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(
      `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
    );
    res.write(
      `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: plan && tool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`,
    );
    res.end("data: [DONE]\n\n");
  });
  // 只监听回环地址的动态端口，避免向局域网暴露夹具服务。
  // 监听完成后再取实际端口，个人配置据此拼接基础地址。
  //
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  // 内置配置从仓库原样复制，保证夹具与真实供应商规则同源。
  // 个人配置指向本地端口，模型清单与默认选择一并写入。
  //
  const builtin = join(root, "fixture-builtin.json"),
    personal = join(root, "fixture-personal.json");
  await copyFile(resolve(cli, "../../../../../../config/provider/zcode-builtin.json"), builtin);
  await writeFile(
    personal,
    JSON.stringify({
      schemaVersion: 1,
      config: {
        providerConfigRules: {
          providerRules: [
            {
              providerId: "fixture-local",
              config: {
                group: "standard-personal",
                access: { type: "api-key", apiKey: "fixture-only" },
                api: { type: "openai-chat-completions", baseUrl: `http://127.0.0.1:${port}/v1` },
                personalModelIds: ["gpt-4o", "gpt-4o-mini"],
              },
            },
          ],
        },
        modelConfigRules: {
          providerModelRules: ["gpt-4o", "gpt-4o-mini"].map((modelId) => ({
            providerId: "fixture-local",
            modelId,
            config: { properties: { inputFormat: { supportsImage: true } } },
          })),
          manualProviderModelRules: [],
        },
        defaultModelSelection: {
          providerId: "fixture-local",
          modelId: "gpt-4o",
          options: { reasoningLevel: "disabled" },
        },
      },
    }),
  );
  // 对外只暴露队列、释放、关闭与环境变量，内部计划结构不外泄。
  // 关闭会先断开全部连接再等服务器回收，避免用例挂起。
  //
  return {
    requests,
    plans,
    aborted,
    release: (key: string) => releases.get(key)?.(),
    env: {
      ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: builtin,
      ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: personal,
    },
    selection: {
      providerId: "fixture-local",
      modelId: "gpt-4o",
      options: { reasoningLevel: "disabled" },
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
