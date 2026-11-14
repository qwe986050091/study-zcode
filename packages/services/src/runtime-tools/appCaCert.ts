// app 场景自签 CA 的生成与路径解析：为 agent 子进程提供可信根、为出口代理提供重签私钥。
// 边界：appCaCert 只在本机落盘 cert/key，不发起网络请求，也不参与证书轮换与吊销；调用方不能把它当通用 PKI。
// INV：证书与私钥必须成对存在——任一缺失即视为整体缺失并重新生成，绝不混用旧私钥签新证书。
// 改错后果：误删或覆盖私钥会让已信任的证书链失配，agent 侧 NODE_EXTRA_CA_CERTS 校验全部失败。
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import forge from "node-forge";
import { getAppConfigDir } from "../paths.js";

// app 场景的自签 CA（区别于 debug 抓包代理那套，仅 debug 环境用）。
// 程序首次启动时生成一份自签根 CA，公钥证书供 agent 子进程经 NODE_EXTRA_CA_CERTS 信任，
// 私钥供出口代理做 TLS 重签。已存在则原样复用，保证证书指纹稳定、被信任后不漂移。

const APP_CA_CERT_FILE = "zcode-network-ca.pem";
const APP_CA_KEY_FILE = "zcode-network-ca.key";
const CA_VALIDITY_YEARS = 10;
const CA_KEY_BITS = 2048;

// 只暴露路径而不返回 PEM，避免密钥材料在服务层长期驻留内存。
export interface AppCaCertPaths {
  certPath: string;
  keyPath: string;
}

// 路径必须在进程内保持稳定：CA 指纹被 agent 与代理双方引用，目录漂移会让二者指向不同证书。
// 目录解析延迟到调用时进行，保证配置变更与测试中的临时目录能被如实感知。
export function getAppCaCertPaths(): AppCaCertPaths {
  // 前置条件：调用方必须接受目录随数据根变化；证书指纹的稳定性依赖同一进程内 dataBaseDir 不变。
  // certs 子目录由 getAppConfigDir 推导，配置目录变更后路径随之改变，不在模块加载时缓存。
  const certDir = join(getAppConfigDir(), "certs");
  return {
    // 公钥文件固定叫 zcode-network-ca.pem，改名等于换一张 CA，已信任它的 agent 会全部失效。
    certPath: join(certDir, APP_CA_CERT_FILE),
    // 私钥与证书必须同目录同前缀，手工替换时要成对操作，否则下次 ensureAppCaCert 会重新生成。
    keyPath: join(certDir, APP_CA_KEY_FILE),
  };
}

/**
 * 确保 app 自签 CA 存在；缺失时生成一份。返回证书（公钥）路径。
 * 幂等：证书与私钥都已存在时直接返回，不重新生成。
 */
// 存在性检查是幂等边界：两个文件都在才复用，避免半写状态（只有 cert 没有 key）被误认为可用。
// 生成与落盘非原子，进程若在此崩溃会留下不完整的一套，下次调用按缺失重新生成并覆盖。
export function ensureAppCaCert(): string {
  // 顺序约束：先确认成对存在再生成；只有一半文件时覆盖重写，避免用旧私钥签新证书导致信任链失配。
  // 每次调用都重新调用 getAppCaCertPaths 而不缓存，测试切换配置目录后读到的就是新位置。
  const { certPath, keyPath } = getAppCaCertPaths();
  // 两文件都存在才复用；只有 cert 没有 key 的半写状态必须重生成，混用会让出口代理签名失败。
  if (existsSync(certPath) && existsSync(keyPath)) {
    return certPath;
  }

  // 先生成 PEM 再建目录，两个 writeFileSync 紧挨着执行，缩短半套文件暴露在磁盘上的窗口。
  const { certPem, keyPem } = generateSelfSignedCa();
  mkdirSync(join(getAppConfigDir(), "certs"), { recursive: true });
  // 私钥含敏感材料，权限收紧到 0600；公钥证书可读。
  writeFileSync(certPath, certPem, { mode: 0o644 });
  writeFileSync(keyPath, keyPem, { mode: 0o600 });
  // 返回证书路径而非 PEM，调用方直接注入 NODE_EXTRA_CA_CERTS，私钥不离开本模块。
  return certPath;
}

// generateSelfSignedCa 固定 2048 位 RSA + SHA-256：只用于本机信任链，不能当通用 PKI，生成耗时与握手兼容性是刻意权衡。
function generateSelfSignedCa(): { certPem: string; keyPem: string } {
  // 失败后果：这里生成的私钥一旦被覆盖，已信任旧证书的 agent 会整体 TLS 失败，只能重新分发证书。
  // 同步生成 2048 位 RSA，首次启动会阻塞数百毫秒，这是不引入异步密钥库的代价。
  const keys = forge.pki.rsa.generateKeyPair(CA_KEY_BITS);
  // createCertificate 只建空壳，字段必须逐项填完再 sign；漏填 subject 会得到无法解析的证书。
  const cert = forge.pki.createCertificate();
  // 公钥必须在 sign 之前挂上，否则签名覆盖的是空公钥，握手时取不到可用密钥。
  cert.publicKey = keys.publicKey;
  // 用密码学随机数做序列号，首字节清零避免被解析成负数。
  // 序列号取自随机 16 字节，避免多台机器并发生成时撞号，同序列号的根证书会让链校验歧义。
  const serial = randomBytes(16);
  // 首字节清掉符号位，转成十六进制后才是正数，负序列号会被部分 TLS 实现拒绝。
  serial[0] = serial[0]! & 0x7f;
  // forge 接受十六进制字符串，randomBytes(16) 正好给出 32 个偶数长度字符。
  cert.serialNumber = serial.toString("hex");

  const notBefore = new Date();
  const notAfter = new Date(notBefore);
  // 有效期 10 年从生成时刻起算，过期后 agent 侧握手直接失败，只能删文件让下次调用重生成。
  notAfter.setFullYear(notAfter.getFullYear() + CA_VALIDITY_YEARS);
  cert.validity.notBefore = notBefore;
  cert.validity.notAfter = notAfter;

  const attrs = [
    { name: "commonName", value: "ZCode Network CA" },
    { name: "organizationName", value: "ZCode" },
  ];
  // subject 与 issuer 共用 attrs，自签证书要求两者逐字段相同，否则校验取不到根。
  cert.setSubject(attrs);
  cert.setIssuer(attrs); // 自签：issuer == subject
  // basicConstraints 的 cA=true 与 keyUsage 的 keyCertSign 必须同时标 critical，缺一项 Node 与浏览器都不认它是 CA。
  cert.setExtensions([
    { name: "basicConstraints", cA: true, critical: true },
    { name: "keyUsage", critical: true, keyCertSign: true, cRLSign: true, digitalSignature: true },
    { name: "subjectKeyIdentifier" },
  ]);

  // 用 SHA-256 签名；SHA-1 在 OpenSSL 3 与新版 Node 里已被拒绝，握手会报证书无效。
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return {
    certPem: forge.pki.certificateToPem(cert),
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
  };
}
