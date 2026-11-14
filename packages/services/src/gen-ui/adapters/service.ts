// Gen UI 服务装配层：把状态存储、文档读取与桌面沙箱注册组装成单一的 IGenUiService 实现。
// 本文件只做编排与入参收窄，HTML 片段校验、路径约束、状态持久化都留在各自适配器里。
// 依赖通过 options 注入，便于测试替换目录，也便于无桌面的宿主只使用状态相关能力。
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { GEN_UI_OUTPUT_DIRECTORY } from "@zcode/shared/node";
import {
  GEN_UI_STATIC_DOMAINS,
  buildGenUiScopeKey,
  genUiStateTargetSchema,
} from "@zcode/shared/gen-ui";
import type { PluginSandboxHandle, PluginSandboxRegisterInput } from "@zcode/shared/mcp-apps";
import type { IGenUiService } from "../contract.js";
import { getAppConfigDir } from "../../paths.js";
import { assertGenUiFragment, readGenUiDocument } from "./files.js";
import { createGenUiStateStorage } from "./stateStorage.js";

// 在共享的 state target schema 上追加沙箱准备所需的字段；ownerWebContentsId 限定为正整数，
// 避免渲染进程传入非法窗口句柄后把内容注册到错误的宿主窗口。
const prepareSchema = genUiStateTargetSchema.extend({
  html: z.string(),
  ownerWebContentsId: z.number().int().positive(),
  instanceKey: z.string().min(1).max(1024),
});
// 创建 Gen UI 服务的唯一入口；除 IGenUiService 契约外额外暴露 dispose，供宿主在窗口销毁时释放存储。
// 未指定 stateRoot/outputRoot 时回落到应用配置目录下的默认位置，保证本地运行与测试使用同一套目录语义。
// registerSandbox 是可选依赖：只读状态的宿主可以不提供，真正要挂载沙箱时才会要求它存在。
export function createGenUiService(
  options: {
    stateRoot?: string;
    outputRoot?: string;
    registerSandbox?: (input: PluginSandboxRegisterInput) => Promise<PluginSandboxHandle>;
  } = {},
): IGenUiService & { dispose(): void } {
// 状态存储按 workspace/session/path 三元组隔离，读写语义与并发控制全部封装在 storage 内部。
  const storage = createGenUiStateStorage(
    options.stateRoot ?? join(getAppConfigDir(), "gen-ui-state"),
  );
// runtimeId 标识本次服务实例，需与每个文档的 appIdentity 组合才能唯一定位沙箱实例。
  const runtimeId = `gen-ui:${randomUUID()}`;
// 输出根目录允许调用方覆盖；默认落在配置目录的固定子目录，方便清理、迁移与路径校验复用。
  const outputRoot = options.outputRoot ?? join(getAppConfigDir(), GEN_UI_OUTPUT_DIRECTORY);
// 读文档、订阅变更与状态增删查直接转交底层实现，服务层不再缓存，避免出现第二份真相。
  return {
// 文档读取的目标路径与输出根目录由 files 适配器统一校验，这里不提前触碰磁盘。
    readDocument: (target) => readGenUiDocument(target, outputRoot),
// onChanged/get/set/list/dispose 复用同一个存储实例，保证订阅者与写入方看到一致的状态。
    onStateChanged: storage.onChanged,
    getState: (target) => storage.get(target),
    setState: ({ target, state }) => storage.set(target, state),
    listState: (scope) => storage.list(scope),
    dispose: () => storage.dispose(),
// prepareSandbox：先校验并包装 HTML，再交给桌面沙箱注册；所有校验都发生在注册之前，避免产生半成品实例。
    async prepareSandbox(raw) {
// 缺少桌面沙箱注册器属于宿主配置错误：立即失败，否则组装出的 HTML 永远没有加载入口。
      if (!options.registerSandbox) throw new Error("Gen UI requires a desktop sandbox");
// 用 schema 收窄原始入参，除 target 外还要求 html、窗口 id 与 instanceKey，越界输入在此被拒绝。
      const input = prepareSchema.parse(raw);
// 片段校验（大小、禁止完整文档结构）先于身份计算执行，确保不合规内容不进入哈希与注册流程。
      assertGenUiFragment(input.html);
// appIdentity 由作用域 key 与文档路径哈希得出：同一文档在不同会话里保持稳定标识，
// 同时不把原始路径直接暴露给沙箱进程。
      const appIdentity = createHash("sha256")
        .update(JSON.stringify(["gen-ui", buildGenUiScopeKey(input), input.path]))
        .digest("hex");
// 初始状态按同一 target 读取；存储层在记录缺失时返回 null，这里序列化后作为沙箱的首屏状态。
      const state = await storage.get({
        workspacePath: input.workspacePath,
        workspaceIdentity: input.workspaceIdentity,
        sessionId: input.sessionId,
        path: input.path,
      });
      const initial = JSON.stringify(state).replaceAll("<", "\\u003c");
// 组装完整的注册输入：内容类型、实例身份、所有者窗口与作用域 id 一并交给宿主完成实际加载。
// initial 中把 `<` 转义为 \u003c，防止状态 JSON 提前闭合 script 标签，这是嵌入不可信状态的关键防护。
      return options.registerSandbox({
        contentKind: "gen-ui",
        instance: { appIdentity, runtimeId, generation: 1, token: randomUUID() },
        ownerWebContentsId: input.ownerWebContentsId,
        workspacePath: input.workspacePath,
        workspaceIdentity: input.workspaceIdentity,
        sessionId: input.sessionId,
        scopeId: input.instanceKey,
        html: `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><!--__ZCODE_GEN_UI_STYLES__--><script type="application/json" id="zcode-gen-ui-initial-state">${initial}</script><script src="__ZCODE_GEN_UI_RUNTIME__"></script></head><body>${input.html}<!--__ZCODE_GEN_UI_INNER_KIT__--></body></html>`,
        csp: {
          connectDomains: [],
          resourceDomains: GEN_UI_STATIC_DOMAINS.map((host) => `https://${host}`),
          frameDomains: [],
          baseUriDomains: [],
        },
      });
    },
  };
}
