// 「国内网络直接取一个站」的小工具，给迅雷 / 射手（伪）这两个来源用。
//
// 只依赖 Node 自带的东西：全局 fetch + undici 的 Agent（项目本来就带着 undici 依赖）。
//   - 有些站的 TLS 只认 1.3（assrt.net 在国内网络下用 1.2 会在握手阶段被掐掉，
//     报 `unexpected eof while reading`）。这里给每个站点建一个 undici Agent，
//     在握手层把版本定下来，失败再退回 1.2 —— 不碰 tls 模块，也不用开启动参数。
//   - 这些站要挑 UA / Accept-Language 才给正经页面（只带一个裸 UA 会被当成爬虫），
//     默认值写在下面，别每个调用点各写一份。
import { Agent, fetch as undiciFetch } from 'undici';
import { HttpError } from './http.js';
import { log } from './log.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

// 每个站点一套 TLS 配置：1.3 优先，直连不通再试 1.2。只在进程内缓存。
const agents = new Map();

function agentFor(origin, minVersion, family = 0) {
  const key = `${origin}|${minVersion}|${family}`;
  let agent = agents.get(key);
  if (!agent) {
    agent = new Agent({
      // family: 4 = 只走 IPv4。境外机房遇到不可达的 IPv6 会白等好几秒（连不上也不会立刻报错），
      // 0 = 交给系统按 DNS 顺序来（第一次 IPv4 失败后的兜底）。
      connect: { minVersion, maxVersion: minVersion, ...(family ? { family } : {}) },
      connectTimeout: 10_000,
      headersTimeout: 20_000,
      bodyTimeout: 30_000,
      maxRedirections: 0,
    });
    agents.set(key, agent);
  }
  return agent;
}

// 迅雷 / 射手这些站点在国内网络下 IPv6 常常是「黑洞」（连上去没响应，等满超时）。
// 每个请求先按 IPv4 走，失败了才用系统默认顺序再试一次 —— 比全局改 DNS 顺序更安全，
// 不会影响别的站点。
function versionsFor(url, tls13Only) {
  const tls = tls13Only ? ['TLSv1.3'] : ['TLSv1.3', 'TLSv1.2'];
  return [...tls.map((version) => ({ version, family: 4 })), ...tls.map((version) => ({ version, family: 0 }))];
}

// 握手阶段的错（TLS 版本不对、被掐断、DNS 解析不了）都值得换一个版本再试一次；
// 真正的 404 / 403 不重试。
const RETRYABLE_TRANSPORT =
  /fetch failed|TLS|SSL|socket|ECONNRESET|eproto|handshake|unexpected eof|other side closed|terminated/i;

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

// 优先用 Node 自带的全局 fetch 并带上我们是自己建的 Agent（TLS 版本由它定）。有的环境里
// 全局 fetch 被换成了不认 Agent 的 polyfill，这时退回 undici 的 fetch —— 参数一样。
async function fetchWith(url, version, init) {
  const { family = 0, ...rest } = init;
  const agent = agentFor(originOf(url), version, family);
  try {
    return await globalThis.fetch(url, { ...rest, dispatcher: agent });
  } catch (error) {
    // polyfill 的错包在 cause 里（外层只有一句 fetch failed）
    const detail = `${error?.message || ''} ${error?.cause?.message || ''}`;
    if (!/onRequestStart|onHeaders|dispatcher/i.test(detail)) throw error;
    return undiciFetch(url, { ...rest, dispatcher: agent });
  }
}

function headersFor({ headers = {}, accept, acceptLanguage, referer = '' }) {
  return {
    'user-agent': UA,
    accept: accept || 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'accept-language': acceptLanguage || 'zh-CN,zh;q=0.9,en;q=0.6',
    ...(referer ? { referer } : {}),
    ...headers,
  };
}

/**
 * 取一个网页 / 接口，返回 { status, ok, text, headers, url }。
 * 失败时抛 HttpError（和 SubHD 那套错误处理保持同一形状）。
 */
export async function fetchText(url, options = {}) {
  const {
    method = 'GET',
    body,
    redirect = 'follow',
    timeoutMs = 15_000,
    tls13Only = false,
  } = options;

  const candidates = versionsFor(url, tls13Only);
  const overallDeadline = Date.now() + timeoutMs;
  let lastError = null;

  for (const [index, { version, family }] of candidates.entries()) {
    // 总超时是「整个请求」的上限，不是「每一轮」的上限：4 个候选平均分，
    // 一轮失败后剩下的时间还够下一轮。否则最坏情况会叠加成 4 倍超时。
    const remaining = overallDeadline - Date.now();
    if (remaining <= 0) break;
    const slot = Math.max(800, Math.floor(remaining / (candidates.length - index)));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), slot);
    try {
      const response = await fetchWith(url, version, {
        method,
        body,
        redirect,
        signal: controller.signal,
        headers: headersFor(options),
        family,
      });
      const text = await response.text();
      return { status: response.status, ok: response.ok, text, headers: response.headers, url: response.url };
    } catch (error) {
      lastError = error;
      if (error?.name === 'AbortError') {
        // 这一轮超时：换下一个候选（IPv4 → 默认顺序，1.3 → 1.2），不再重复同一个组合
        continue;
      }
      const message = String(error?.cause?.message || error?.message || error);
      if (!RETRYABLE_TRANSPORT.test(message)) break;
    } finally {
      clearTimeout(timer);
    }
  }

  // 超时 / 连不上的原始报错是「This operation was aborted」这种，用户看不懂是哪一步出的问题
  const aborted = lastError?.name === 'AbortError';
  const reason = aborted
    ? `超时（${Math.round(timeoutMs / 1000)} 秒没连上）`
    : (lastError && (lastError.cause?.message || lastError.message)) || lastError;
  throw new HttpError(`请求失败: ${url} (${reason})`, { url });
}

/**
 * 取一个二进制文件（字幕直链 / 压缩包），返回 Buffer。
 * 超过 maxBytes 直接报错，别把一个几百 MB 的东西读进内存。
 * 握手版本和 fetchText 一样：1.3 优先、失败退回 1.2（迅雷的 CDN 只认 1.2，射手的只认 1.3）。
 */
export async function fetchBinary(
  url,
  { headers = {}, timeoutMs = 30_000, maxBytes = 64 * 1024 * 1024, referer = '', tls13Only = false } = {},
) {
  let lastError = null;

  for (const { version, family } of versionsFor(url, tls13Only)) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchWith(url, version, {
        signal: controller.signal,
        redirect: 'follow',
        headers: headersFor({ headers, accept: '*/*', referer }),
      });
      if (!response.ok) throw new HttpError(`HTTP ${response.status}: ${url}`, { status: response.status, url });
      const length = Number(response.headers.get('content-length') || 0);
      if (length && length > maxBytes) throw new HttpError(`文件超出大小限制: ${url}`, { url });
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > maxBytes) throw new HttpError(`文件超出大小限制: ${url}`, { url });
      return buffer;
    } catch (error) {
      if (error instanceof HttpError) throw error;
      lastError = error;
      if (error?.name === 'AbortError') break;
      const message = String(error?.cause?.message || error?.message || error);
      if (!RETRYABLE_TRANSPORT.test(message)) break;
    } finally {
      clearTimeout(timer);
    }
  }

  throw new HttpError(
    `请求失败: ${url} (${
      lastError?.name === 'AbortError' ? '超时' : lastError?.cause?.message || lastError?.message || lastError
    })`,
    { url },
  );
}

export function logSource(source, ...args) {
  log(`[${source}]`, ...args);
}
