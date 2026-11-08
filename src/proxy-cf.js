// Cloudflare Worker 出口代理（可选，只需要配一个 CF Worker 地址和密钥）。
//
// 为什么需要它：迅雷的接口在国内网络很快，但从部分机房（Vercel 的新加坡/东京节点就是这么
// 被卡住的）连过去会 Connect Timeout —— 实测 Cloudflare 香港节点连迅雷是稳定可用的
// （5 轮全部成功，0.4~1 秒）。所以这里只把「迅雷」这一路的请求改走 CF 代理，其它照旧。
//
// 代理协议很简单（Worker 那边见 tools/cf-proxy/worker.js）：
//   GET  {base}/fetch?url=<encodeURIComponent(目标地址)>
//   →  状态码 = 目标站的状态码，正文 = 目标站正文，响应头 x-proxy-status 用来兜底
// 鉴权：请求带 Authorization: Bearer <PROXY_SECRET>，Worker 那边校验。
import { config } from './config.js';
import { HttpError } from './http.js';
import { fetchText } from './net.js';

export const proxyUrl = () => String(config.thunder.proxyUrl || '').replace(/\/+$/, '');

export const isProxyEnabled = () => proxyUrl().length > 0;

/**
 * 经 CF Worker 取一个地址的文本。返回结构和 fetchText 一样（status/ok/text）。
 * 注意：正文由 Worker 原样转回，编码不做转换（字幕转码仍在服务端做）。
 */
export async function proxyFetchText(target, { timeoutMs = 8000, accept = '*/*' } = {}) {
  const base = proxyUrl();
  if (!base) throw new HttpError('没有配置迅雷代理（THUNDER_PROXY_URL）', { url: target });

  const url = `${base}/fetch?url=${encodeURIComponent(target)}`;
  const headers = { accept };
  if (config.thunder.proxySecret) headers.authorization = `Bearer ${config.thunder.proxySecret}`;

  const response = await fetchText(url, { headers, accept, timeoutMs });
  if (!response.ok && response.status !== 200) {
    // Worker 自己出错（鉴权失败、超时）时，正文是一段 JSON
    throw new HttpError(`迅雷代理返回 HTTP ${response.status}`, { status: response.status, url: target });
  }
  return response;
}

/** 经代理取二进制（字幕文件 / 压缩包） */
export async function proxyFetchBinary(target, { timeoutMs = 20000, maxBytes = 32 * 1024 * 1024 } = {}) {
  const base = proxyUrl();
  if (!base) throw new HttpError('没有配置迅雷代理（THUNDER_PROXY_URL）', { url: target });

  const headers = {};
  if (config.thunder.proxySecret) headers.authorization = `Bearer ${config.thunder.proxySecret}`;
  const response = await fetch(`${base}/fetch?url=${encodeURIComponent(target)}`, {
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new HttpError(`迅雷代理返回 HTTP ${response.status}`, { status: response.status, url: target });
  const length = Number(response.headers.get('content-length') || 0);
  if (length && length > maxBytes) throw new HttpError('字幕文件超出大小限制', { url: target });
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > maxBytes) throw new HttpError('字幕文件超出大小限制', { url: target });
  return buffer;
}
