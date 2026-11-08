import { config } from './config.js';

export class HttpError extends Error {
  constructor(message, { status = 0, url = '' } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
  }
}

// SubHD 限流时也是 HTTP 403，但会把原因写在 JSON 里（`{"msg":"下载频率过高，请稍后再试。"}`）。
// 这跟 Cloudflare 的地域拦截是两回事：限流该退避重试，地域拦截换镜像也没用。
const RATE_LIMIT_RE = /频率|稍后|too\s*many|frequent|rate\s*limit/i;

export const isRateLimitMessage = (value) => RATE_LIMIT_RE.test(String(value ?? ''));

export class RateLimitError extends HttpError {
  constructor(message, { status = 0, url = '' } = {}) {
    super(message, { status, url });
    this.name = 'RateLimitError';
  }
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// SubHD sits behind Cloudflare, which answers these for blocked regions and
// datacenter ASNs instead of "the site is down". The mirrors are usually served
// by different edges, so it is worth trying the next domain before giving up.
const BLOCKED_STATUSES = new Set([401, 403, 406, 451]);

function blockedError(errors, pathname) {
  const last = errors.at(-1);
  if (!last || !BLOCKED_STATUSES.has(last.status)) {
    return last || new HttpError(`无法访问 SubHD (${pathname})`, { url: pathname });
  }
  return new HttpError(
    `SubHD 拒绝了这台服务器的请求 (HTTP ${last.status}: ${pathname})。` +
      '大多是站点按出口 IP 的地域/机房做的拦截，境外云主机与 Serverless 上很常见 —— ' +
      '换到离国内更近的机房（如 Vercel 的 hkg1），或把插件放在有国内出口的机器上自建',
    { status: last.status, url: last.url || pathname },
  );
}

export class CookieJar {
  constructor() {
    this.cookies = new Map();
  }

  absorb(headers) {
    const list = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [];
    for (const raw of list) {
      const pair = String(raw).split(';')[0];
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
    return this;
  }

  header() {
    return [...this.cookies].map(([key, value]) => `${key}=${value}`).join('; ');
  }
}

export async function request(url, options = {}) {
  const {
    method = 'GET',
    headers = {},
    body,
    jar,
    via = null,
    timeoutMs = config.requestTimeoutMs,
    redirect = 'follow',
  } = options;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const finalHeaders = { 'user-agent': config.userAgent, accept: '*/*', ...headers };
  if (jar) {
    const cookie = jar.header();
    if (cookie) finalHeaders.cookie = cookie;
  }
  if (body !== undefined && finalHeaders['content-type'] === undefined) {
    finalHeaders['content-type'] = 'application/json; charset=utf-8';
  }

  try {
    const init = {
      method,
      headers: finalHeaders,
      body,
      redirect,
      signal: controller.signal,
    };
    // via 是「这一跳从哪个出口出去」（见 proxy.js）：dispatcher 和 fetch 必须来自同一份
    // undici，所以代理请求用池子带出来的那个 fetch，而不是全局那个。
    if (via?.dispatcher) {
      init.dispatcher = via.dispatcher;
    }
    const response = await (via?.fetch || fetch)(url, init);
    if (jar) jar.absorb(response.headers);
    return response;
  } catch (error) {
    if (error && error.name === 'AbortError') {
      throw new HttpError(`请求超时 (${timeoutMs}ms): ${url}`, { url });
    }
    const through = via?.label ? `经 ${via.label} ` : '';
    throw new HttpError(`请求失败: ${through}${url} (${(error && error.message) || error})`, { url });
  } finally {
    clearTimeout(timer);
  }
}

export class SiteClient {
  constructor(domains) {
    this.domains = [...domains];
    this.preferred = domains[0];
    // 每个镜像最近的响应耗时（毫秒）。站点有 6 个镜像，同一时刻快慢能差 5 倍
    // （实测 subhd.tv 0.9s、subhd.me 4.9s），所以按实测速度排队，别老盯着第一个。
    this.speeds = new Map(domains.map((domain) => [domain, 1000]));
  }

  /** 记一次成功/失败的耗时；失败当成很慢，下次排后面 */
  noteSpeed(domain, ms, failed = false) {
    if (!domain) return;
    const previous = this.speeds.get(domain) ?? 1000;
    // 指数滑动平均：反应快，又不会被单次抖动带偏
    const next = failed ? Math.max(previous, 8000) : previous * 0.6 + ms * 0.4;
    this.speeds.set(domain, next);
  }

  get domain() {
    return this.preferred;
  }

  url(pathname) {
    return `https://${this.preferred}${pathname}`;
  }

  /** 按实测速度排序：快的先试（首个镜像只是并列，不再无条件优先） */
  candidates() {
    return [...this.domains].sort((a, b) => (this.speeds.get(a) ?? 1000) - (this.speeds.get(b) ?? 1000));
  }

  async fetchPath(pathname, options = {}) {
    const errors = [];
    // Walking every mirror costs one timeout each, so cap the whole attempt:
    // a blocked deployment should fail in seconds, not minutes.
    const { deadlineMs = config.domainWalkBudgetMs, ...rest } = options;
    const deadline = Date.now() + deadlineMs;

    for (const domain of this.candidates()) {
      const url = `https://${domain}${pathname}`;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        const attemptOptions = {
          ...rest,
          timeoutMs: Math.min(rest.timeoutMs ?? config.requestTimeoutMs, remaining),
        };
        const startedAt = Date.now();
        try {
          const response = await request(url, attemptOptions);
          this.noteSpeed(domain, Date.now() - startedAt, response.status >= 500);
          const retryable = response.status >= 500 || response.status === 429;
          const blocked = BLOCKED_STATUSES.has(response.status);
          if (!retryable && !blocked) {
            this.preferred = domain;
            return response;
          }

          if (blocked) {
            // 403 得先读一眼响应体：站点限流时也是 403，把站点原话带出去，
            // 上层才会按「频率限制」退避重试，而不是告诉用户「换个机房」。
            const body = await response.text().catch(() => '');
            if (isRateLimitMessage(body)) {
              throw new RateLimitError(body.trim().slice(0, 200) || `HTTP ${response.status}`, {
                status: response.status,
                url,
              });
            }
            errors.push(new HttpError(`HTTP ${response.status}`, { status: response.status, url }));
            // Retrying the same domain will not unblock it, so move on to the next mirror.
            break;
          }

          errors.push(new HttpError(`HTTP ${response.status}`, { status: response.status, url }));
          if (attempt === 0) await sleep(200);
        } catch (error) {
          if (error instanceof RateLimitError) throw error;
          // 超时 / 连不上：记成很慢，下次请求先试别的镜像
          if (error?.message?.includes('超时') || error?.status === 0) this.noteSpeed(domain, 8000, true);
          errors.push(error);
          if (attempt === 0) await sleep(150);
        }
      }
    }

    throw blockedError(errors, pathname);
  }

  async text(pathname, options = {}) {
    const response = await this.fetchPath(pathname, options);
    if (!response.ok) {
      throw new HttpError(`HTTP ${response.status}: ${pathname}`, {
        status: response.status,
        url: this.url(pathname),
      });
    }
    return response.text();
  }
}
