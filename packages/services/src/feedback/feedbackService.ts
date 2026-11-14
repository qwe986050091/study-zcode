// [契约] IFeedbackService 门面只暴露工单创建与附件上传：日志归档和重试都下沉到 FeedbackHttpClient，前端只依赖这一层。
// 它不直接发 HTTP：网络、重试与鉴权都在 FeedbackHttpClient，这里只负责身份、取消、进度与临时资源。
// INV-01：device_mid 恒取宿主注入的 getDeviceMid，缺失即报错，绝不生成 fb_ 前缀的替代身份
//         （守住：getHostDeviceMid / requireHostDeviceMid）；否则同一台机器会被拆成多台设备。
// INV-02：落盘路径只由本进程生成，来自外部的附件名必须 basename（守住：uploadAttachmentData）；
//         否则 ../ 序列可以写出附件目录。
// INV-03：临时目录在所有出口（成功/失败/取消）都要 rm，且清理失败不覆盖原始错误
//         （守住：uploadAttachmentData 的 finally）；残留会随每次反馈累积占盘。
// INV-04：取消以 AbortController 为准，取消不是错误：只停请求并广播 canceled
//         （守住：activeCreateControllers / activeUploadControllers）；吞掉取消会让 UI 停在 preparing。
// INV-05：进度 emitter 靠 onDidRemoveLastListener 自清理（守住：getUploadProgressEmitter）；
//         否则长跑的 Host 会按上传次数泄漏订阅对象。
// INV-06：本地临时文件不是权威状态：上传结束即清理（守住：attachLogsFromExport）；
//         清理失败不得影响主流程，否则一次磁盘错误就让整条反馈不可用。
import { basename, join } from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";

import type { ApiClient, FeedbackDeviceInfo } from "@zcode/shared";
import {
  buildRuntimeZCodeApiUrl,
  ZCODE_BUILD_TIME,
  ZCODE_COMMIT,
  ZCODE_VERSION,
} from "@zcode/shared";
import { Emitter } from "@zcode/rpc";
import { arch, platform, release, type as osType } from "node:os";

import type { ICredentialService } from "../credential/credential.js";
import type { IOAuthService } from "../oauth/oauth.js";
import type { FeedbackUploadProgress, IFeedbackService } from "./feedback.js";
import { FeedbackHttpClient, FeedbackUploadCanceledError } from "./feedbackHttpClient.js";
import { cleanupLogArchive, prepareCompactLogArchive } from "./compactLogArchive.js";
import { getFeedbackAttachmentDir } from "../paths.js";
import { FeedbackLocalTicketStore } from "#src/feedback/feedbackLocalTicketStore.js";

// 凭据键与其它服务共用的 key 一致；改变它等于让已登录用户看不到自己的工单。
const ZCODE_JWT_TOKEN_KEY = "zcodejwttoken";

// 依赖全部注入：凭据、OAuth、ApiClient、归档实现与路径揭示都由宿主提供，
// 这样桌面端可以复用宿主身份，测试可以替换归档与文件系统。
export interface CreateFeedbackServiceOptions {
  credentialService: ICredentialService;
  oauthService: IOAuthService;
  apiClient: ApiClient;
  getDeviceMid?: () => string | undefined;
  apiBaseUrl?: string;
  createFullLogArchive?: (
    sourceDir: string,
    options?: {
      onProgress?: (event: { processedBytes: number; totalBytes: number }) => void;
    },
  ) => Promise<{ path: string; size: number }>;
  revealPath?: (path: string) => Promise<void>;
}

// 优先级：显式参数 > 环境变量 > 运行时默认。显式值用于测试与私有化部署，
// 环境变量是进程级事实，不应被单次调用悄悄覆盖。
function resolveApiBaseUrl(explicit?: string): string {
  return (
    explicit?.trim() ||
    process.env.ZCODE_FEEDBACK_API_BASE?.trim() ||
    buildRuntimeZCodeApiUrl(process.env, "/api/v1")
  );
}

// 设备快照用于后端定位问题，字段必须来自真实运行时、不读入参或缓存，
// 否则升级后仍上报旧版本，排查会指向已经修好的版本。
function buildDeviceSnapshot(): FeedbackDeviceInfo {
  return {
    appVersion: ZCODE_VERSION,
    buildCommitId: ZCODE_COMMIT,
    buildTime: ZCODE_BUILD_TIME,
    nodeVersion: process.version,
    osType: osType(),
    osPlatform: platform(),
    osRelease: release(),
    // node:os.version() 在 macOS 上是完整 Darwin kernel 字符串，超过后端 os_version VARCHAR(64) 会写库失败。
    osVersion: release(),
    osArch: arch(),
  };
}

// 服务是工厂而非类：每次装配持有自己的 controller 与 emitter 表，
// 多个 Host 实例之间不共享取消状态，避免一个窗口取消到另一个窗口的上传。
export function createFeedbackService(options: CreateFeedbackServiceOptions): IFeedbackService {
// 基址在装配期定一次：它属于部署事实，不随单次请求变化，提前解析也能让配置错误在启动时暴露。
  const apiBaseUrl = resolveApiBaseUrl(options.apiBaseUrl);
// 宿主 deviceMid 可能为空（尚未注册）或带空白，统一 trim 后为空即视为缺失，
// 避免把空白字符串当作有效设备身份发出去。
  function getHostDeviceMid(): string | undefined {
    return options.getDeviceMid?.()?.trim() || undefined;
  }

  function requireHostDeviceMid(): string {
    const deviceMid = getHostDeviceMid();
// [失败路径] 这里不生成替代身份：device_mid 是对账键，伪造一个会让本机票据永远查不回来。
    if (!deviceMid) {
      throw new Error("Missing feedback device_mid");
    }
    return deviceMid;
  }

// JWT 每次从凭据服务读，不做进程内缓存：登录、登出与换号都发生在运行期，
// 缓存会让请求带着已失效的令牌，表现为「已登录却一直 401」。
  async function getZcodeJwtToken(): Promise<string | undefined> {
    return (await options.credentialService.load(ZCODE_JWT_TOKEN_KEY))?.trim() || undefined;
  }

// 只用真值判断是否存在：空串与纯空白都按未登录处理，与 getZcodeJwtToken 的 trim 口径保持一致。
  async function hasZcodeJwtToken(): Promise<boolean> {
    return Boolean(await getZcodeJwtToken());
  }

// getAuthHeaders 每次请求重新取值：deviceMid 与 JWT 都会在运行中变化，
// 构造期快照会让登录前后、切换设备后的请求带着旧身份。
  const httpClient = new FeedbackHttpClient({
    baseUrl: apiBaseUrl,
    apiClient: options.apiClient,
    getAuthHeaders: async () => {
      const headers: Record<string, string> = {};
      const deviceMid = getHostDeviceMid();
      // feedback 的 device_mid 必须复用宿主 deviceMid（与 provider 请求头、远控同一身份）；
      // 不单独生成 fb_ 身份，否则同一台机器在不同系统里会被拆成两个设备。
      if (deviceMid) {
        headers["X-Device-Mid"] = deviceMid;
      }
      const jwtToken = await getZcodeJwtToken();
      if (jwtToken) {
        headers.Authorization = `Bearer ${jwtToken}`;
      }
      return headers;
    },
  });
// 本机票据只服务未登录场景；已登录时 list 直接走服务端，两份数据不合并，
// 避免同一工单在前端出现两次。
  const localTicketStore = new FeedbackLocalTicketStore();
// [资源] 每张上传一个 emitter，最后一个监听者移除时立刻 dispose 并从 Map 删除；
// 否则长跑的 Host 会按上传次数无限累积订阅对象。
  const uploadProgressEmitters = new Map<string, Emitter<FeedbackUploadProgress>>();
// [并发] 上传取消表以 progressId 为键：同一附件可能在重试中被多次发起，
// 新请求覆盖旧 controller，旧请求即使漏删也不会被后续 cancel 命中。
  const activeUploadControllers = new Map<string, AbortController>();
// [并发] 创建取消表以 operationId 为键，与上传表分开：两张表的生命周期与取消语义不同，合表会让一次取消波及另一操作。
  const activeCreateControllers = new Map<string, AbortController>();

// 同一个 progressId 复用同一 emitter：调用方可能在开始上传前就订阅，
// 若每次新建，先订阅的一方会收不到后续事件。
  function getUploadProgressEmitter(id: string): Emitter<FeedbackUploadProgress> {
    const current = uploadProgressEmitters.get(id);
    if (current) return current;
    const emitter = new Emitter<FeedbackUploadProgress>({
      onDidRemoveLastListener: () => {
        uploadProgressEmitters.delete(id);
        emitter.dispose();
      },
    });
    uploadProgressEmitters.set(id, emitter);
    return emitter;
  }

  return {
// 创建工单可能慢到数十秒：operationId 把 UI 的取消映射到具体的 HTTP 请求。
    create: async (input, createOptions) => {
// 允许调用方传 device（如远端代传）时以入参为准，否则取本机快照。
      const device = input.device ?? buildDeviceSnapshot();
      const operationId = createOptions?.operationId?.trim();
      const controller = new AbortController();
      if (operationId) {
        // UI 取消创建工单时不能只关闭弹窗；host 需要能按 operationId
        // 找到当前 HTTP 请求并 abort，避免“正在连接反馈服务”永久悬挂。
// [并发] 同一 operationId 重复创建时先取消旧请求再登记新的：
// 重试不应留下两个都在跑的请求，否则可能建出两张工单。
        activeCreateControllers.get(operationId)?.abort();
        activeCreateControllers.set(operationId, controller);
      }
      try {
        const ticket = await httpClient.create(
          {
            ...input,
            device,
          },
          {
            signal: controller.signal,
          },
        );
// 未登录才落本机票据：已登录时服务端是唯一事实，再写本地会让切换账号后看到别人的工单。
        if (!(await hasZcodeJwtToken())) {
          await localTicketStore.upsert(requireHostDeviceMid(), ticket);
        }
        return ticket;
      } finally {
        if (operationId && activeCreateControllers.get(operationId) === controller) {
          activeCreateControllers.delete(operationId);
        }
      }
    },
// 取消是幂等的：找不到 controller 说明请求已结束，什么都不做也不算失败。
    cancelCreate: async (operationId) => {
      const key = operationId.trim();
      if (!key) return;
      activeCreateControllers.get(key)?.abort();
    },
// 登录状态决定数据来源，两者互斥：不合并、不回溯同步，避免出现两份不同版本的同一工单。
    list: async (query) => {
      if (await hasZcodeJwtToken()) {
        return httpClient.list(query);
      }
      const items = await localTicketStore.list(requireHostDeviceMid(), query);
      return { items, total: items.length };
    },
// 详情、评论只走服务端：本机票据不缓存正文，离线时宁可报错也不展示可能过期的内容。
    get: (id) => httpClient.get(id),
// 评论不做本地排队：反馈评论需要立即得到服务端确认，排队会让用户以为没发出去而重复提交。
    comment: (id, body) => httpClient.comment(id, body),
// 无进度版本与带进度版本共用同一 HTTP 调用，只是不带 signal 与回调；
// 文件名缺省时从路径取 basename，contentType 按 kind 兜底。
    uploadAttachment: async (id, kind, file) => {
      const filename = file.filename ?? basename(file.path);
      const contentType = file.contentType ?? (kind === "image" ? "image/png" : "application/zip");
      return httpClient.uploadFile(id, kind, file.path, filename, contentType, {
        messageId: file.messageId,
      });
    },
// [资源] 这里持有 controller 与 emitter 两条引用，finally 只清 controller；
// emitter 由 onDidRemoveLastListener 回收，提前 dispose 会让仍在重试的 UI 丢事件。
    uploadAttachmentWithProgress: async (id, kind, file, progressId) => {
      const filename = file.filename ?? basename(file.path);
      const contentType = file.contentType ?? (kind === "image" ? "image/png" : "application/zip");
      const emitter = getUploadProgressEmitter(progressId);
      emitter.fire({
        id: progressId,
        phase: "preparing",
        uploadedBytes: 0,
        totalBytes: 0,
      });
      const controller = new AbortController();
      activeUploadControllers.set(progressId, controller);
      return httpClient
        .uploadFile(id, kind, file.path, filename, contentType, {
          messageId: file.messageId,
          signal: controller.signal,
          onUploadProgress: (event) => {
            emitter.fire({
              id: progressId,
              phase: event.uploadedBytes >= event.totalBytes ? "complete" : "uploading",
              uploadedBytes: event.uploadedBytes,
              totalBytes: event.totalBytes,
            });
          },
        })
// [失败路径] 取消要显式广播 canceled 再原样抛出：UI 需要区分用户取消与网络失败，
// 但调用方仍应收到拒绝以结束自己的 loading 状态。
        .catch((error) => {
          if (error instanceof FeedbackUploadCanceledError) {
            emitter.fire({
              id: progressId,
              phase: "canceled",
              uploadedBytes: 0,
              totalBytes: 0,
            });
          }
          throw error;
        })
// [资源] 无论成功、失败还是取消都释放 controller 引用，否则 cancelUpload 会一直命中已完成的请求。
        .finally(() => {
          activeUploadControllers.delete(progressId);
        });
    },
// 与 cancelCreate 同构：只 abort 不等待，终态由 uploadFile 的 catch 分支广播。
    cancelUpload: async (progressId) => {
      activeUploadControllers.get(progressId)?.abort();
    },
// 暴露 event 而不是 emitter：订阅方只能监听，无法从外部 fire 或 dispose，
// 回收权因此始终留在本服务的引用计数里。
    onDynamicUploadProgress: (id) => getUploadProgressEmitter(id).event,
// base64 附件先落临时目录再交给上传：uploadFile 读的是文件路径，
// 直接传内存需要在 HTTP 层另开一条不走重试的通道。
    uploadAttachmentData: async (id, kind, file) => {
      const attachmentRootDir = getFeedbackAttachmentDir();
      await mkdir(attachmentRootDir, { recursive: true });
// [资源] 每次上传独占一个 mkdtemp 目录，避免并发上传同名文件互相覆盖。
      const tempDir = await mkdtemp(join(attachmentRootDir, "attachment-"));
      // 附件名来自 renderer，不能作为本地相对路径使用。
// [失败路径] 反斜杠先统一成 / 再 basename（Linux 不把 \ 当分隔符），空结果兜底为固定名；
// 这一步是路径穿越的唯一防线，任何绕过都会让写入落到附件目录之外。
      const filename = basename(file.filename.replaceAll("\\", "/")) || "attachment";
      const tempPath = join(tempDir, "content");
      try {
// 固定文件名 content：目录已经唯一，文件名不承载语义，也就不需要再校验。
        await writeFile(tempPath, Buffer.from(file.dataBase64, "base64"));
        return await httpClient.uploadFile(id, kind, tempPath, filename, file.contentType, {
          messageId: file.messageId,
        });
      } finally {
// [资源] 清理失败不覆盖原始错误：调用方关心的是上传结果，
// 残留目录由下轮 mkdtemp 前的环境清理兜底，不影响主流程。
        await rm(tempDir, { recursive: true, force: true }).catch(() => {});
      }
    },
// 日志归档是本地大文件：先压缩再上传，上传结束立刻清理；
// 失败也只影响这条反馈，不能让异常冒到 UI 阻断提交。
    attachLogsFromExport: async (id, attachOptions) => {
      const archive = await prepareCompactLogArchive({
        full: attachOptions?.full,
        createFullArchive: options.createFullLogArchive,
      });
      try {
        return await httpClient.uploadFile(
          id,
          "log",
          archive.path,
          basename(archive.path),
          "application/zip",
        );
      } finally {
// [资源] 归档文件在 uploadFile 读取完之后才删；提前删会让流式上传读到空文件。
        await cleanupLogArchive(archive.path);
      }
    },
// 只读方法保持 async 以符合接口：调用方可以统一 await，不必区分同步与异步实现。
    getDeviceSnapshot: async () => buildDeviceSnapshot(),
// 预压缩把进度映射成 phase=preparing 并复用上传 emitter，
// 让 UI 在压缩与上传两个阶段之间显示同一条进度条。
    prepareCompactLogArchive: async (archiveOptions) => {
// progressId 可选：不关心进度的调用方（如脚本）不需要创建 emitter，也就不会留下待回收的订阅。
      const progressId = archiveOptions?.progressId;
      const progressEmitter = progressId ? getUploadProgressEmitter(progressId) : null;
      return prepareCompactLogArchive({
        full: archiveOptions?.full,
        createFullArchive: options.createFullLogArchive,
        onProgress: progressEmitter
          ? (event) => {
              progressEmitter.fire({
                id: progressId!,
                phase: "preparing",
                uploadedBytes: event.processedBytes,
                totalBytes: event.totalBytes,
              });
            }
          : undefined,
      });
    },
// 预压缩产生的文件由调用方负责清理：这里只暴露能力不自动删除，
// 因为文件还要先被展示或上传。
    cleanupPreparedLogArchive: (path) => cleanupLogArchive(path),
// revealPath 是可选能力：桌面端可在文件管理器中定位，Web 端没有等价操作时静默忽略。
    revealLogArchive: async (path) => {
      if (options.revealPath) {
        await options.revealPath(path);
        return;
      }
    },
  };
}
