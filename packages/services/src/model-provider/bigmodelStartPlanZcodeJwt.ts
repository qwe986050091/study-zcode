// BigModel Start Plan 的 ZCode JWT 解析：优先已落盘的 JWT，其次 provider 上缓存的副本。
// INV-01：只有 active_provider 为 bigmodel 或调用方显式信任缓存时，才读 credential 里的 JWT。
import { BIGMODEL_PROVIDER_ID } from "@zcode/shared";

const ACTIVE_PROVIDER_KEY = "oauth:active_provider";
const ZCODE_JWT_TOKEN_KEY = "zcodejwttoken";

interface BigModelStartPlanZcodeJwtCredentialService {
  load(key: string): Promise<string | null>;
}

// [失败路径] 两条路径都取不到时返回空串，由调用方按「无 JWT」降级，不抛异常。
export async function resolveBigModelStartPlanZcodeJwt(params: {
  credentialService?: BigModelStartPlanZcodeJwtCredentialService;
  provider?: { readonly apiKey?: string | null } | null;
  trustCachedZcodeJwt?: boolean;
}): Promise<string> {
// active_provider 缺失按空串处理：未初始化时不应假设当前是 BigModel。
  const activeProvider = (await params.credentialService?.load(ACTIVE_PROVIDER_KEY))?.trim() || "";
  if (params.trustCachedZcodeJwt === true || activeProvider === BIGMODEL_PROVIDER_ID) {
    const credentialJwt = (await params.credentialService?.load(ZCODE_JWT_TOKEN_KEY))?.trim() || "";
    if (credentialJwt) {
      return credentialJwt;
    }
  }

  // zcode JWT 必须在 BigModel OAuth callback 阶段用授权码 body 落盘。
  // Start Plan 查询余额/运行时只消费已保存的 JWT 或 provider 副本，不再用
  // BigModel access_token 构造 provider+access_token body 临时兑换，避免 /oauth/token 400。
  return params.provider?.apiKey?.trim() || "";
}
