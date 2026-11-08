import { config } from './config.js';
import { log } from './log.js';

// 站点是按**出口 IP** 记账的，而这个插件以前只有一个出口：这台机器自己的 IP。被拍之后
// 只能干等（见 subhd.js 里那段冷却）。这里给它加一个出口池：
//
//   SUBHD_PROXIES=socks5://127.0.0.1:1080,http://user:pass@node2:3128
//
// 于是「SubHD 从哪条网络出去」变成一个可配置的东西：被拍一个换下一个，全被拍才让用户等。
// 客户端自己开的隧道（家里电脑 `ssh -R 1080:127.0.0.1:1080 user@云主机`、frp、cloudflared）
// 在这儿也就是一个 socks5 地址 —— 插件还在云上，但去 SubHD 的那一跳是从客户端那条网络
// 出去的；客户端换网络（Wi-Fi 换蜂窝）时隧道重连，出口 IP 跟着换。
//
// 默认只让「下载」那几步走池子（subhd.js 里指定）：搜索/目录不限流，直连更快，也不该拿
// 节点额度去翻页。`SUBHD_PROXY_ALL=1` 可以改成全都走。

const SOCKS_PROTOCOLS = new Set(['socks5:', 'socks5h:', 'socks:']);
// 同一个节点连着被拍才翻倍冷却；隔这么久没再被拍就当「这一波过去了」，从基础值重算
const REPEAT_MS = 60 * 60 * 1000;
const STATE_NODES = 20;

// 地址里带账号密码时，只留下用户名 —— 日志和 /healthz 都是给人看的，别把密码写进去
function label(url) {
  const user = url.username ? `${decodeURIComponent(url.username)}:***@` : '';
  return `${url.protocol}//${user}${url.host}`;
}

// "host:port" 这种没写协议的按 http 代理算（最常见），其余按 URL 解析
export function parseProxyList(raw) {
  const entries = [];
  const seen = new Set();

  for (const item of String(raw || '').split(/[\s,;]+/)) {
    const value = item.trim();
    if (!value) continue;

    let url;
    try {
      url = new URL(value.includes('://') ? value : `http://${value}`);
    } catch {
      log(`SUBHD_PROXIES：看不懂这一项，跳过 ${value}`);
      continue;
    }

    if (SOCKS_PROTOCOLS.has(url.protocol) && url.protocol !== 'socks5:') {
      // undici 只认 socks5:// / socks://；socks5h 本来就是「域名交给代理解析」，等价
      url = new URL(url.toString().replace(/^socks5h:/, 'socks5:'));
    }

    if (!['http:', 'https:', 'socks5:', 'socks:'].includes(url.protocol)) {
      log(`SUBHD_PROXIES：不支持 ${url.protocol}//，跳过 ${label(url)}`);
      continue;
    }
    if (!url.hostname || !url.port) {
      log(`SUBHD_PROXIES：${label(url)} 少了主机名或端口，跳过`);
      continue;
    }

    const normalized = url.toString();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    entries.push({ url: normalized, label: label(url) });
  }

  return entries;
}

// undici 是 Node 自带 fetch 的那套实现（纯 JS，无其它依赖）。没装就别让整个插件崩：
// 只有真去用池子的时候才报这一句，直连的用户完全不受影响。
let undiciPromise = null;
function loadUndici() {
  if (!undiciPromise) {
    undiciPromise = import('undici').catch((error) => {
      undiciPromise = null;
      throw new Error(`配置了 SUBHD_PROXIES 但没有 undici：在项目里跑一次 npm install（本仓库的 Docker 镜像已内置）—— ${error.message}`);
    });
  }
  return undiciPromise;
}

export class ProxyPool {
  constructor(list = []) {
    this.entries = list.map((item, index) => ({
      url: item.url,
      label: item.label,
      index,
      viaPromise: null,
      coolingUntil: 0,
      hits: 0,
      lastHitAt: 0,
      lastUsedAt: 0,
      lastError: '',
      // 这个出口是「被站点拍回来」还是「自己连不上」—— 决定最后给用户的文案
      lastKind: null,
    }));
    this.byUrl = new Map(this.entries.map((entry) => [entry.url, entry]));
  }

  get enabled() {
    return this.entries.length > 0;
  }

  get size() {
    return this.entries.length;
  }

  // 连着被拍翻倍，隔久了从基础值重算；顺手把已经过期的冷却收掉
  #forget(entry, now) {
    if (entry.hits > 0 && now - entry.lastHitAt > REPEAT_MS) {
      entry.hits = 0;
      entry.lastError = '';
    }
  }

  async #via(entry) {
    if (!entry.viaPromise) {
      entry.viaPromise = (async () => {
        const { ProxyAgent, Socks5ProxyAgent, fetch } = await loadUndici();
        const options = { connectTimeout: config.proxyConnectMs };
        const dispatcher = SOCKS_PROTOCOLS.has(new URL(entry.url).protocol)
          ? new Socks5ProxyAgent(entry.url, options)
          : new ProxyAgent(entry.url, options);
        // fetch 也一起带出来：dispatcher 和 fetch 必须是同一份 undici，别和全局那个混着用
        return { url: entry.url, label: entry.label, entry, dispatcher, fetch };
      })().catch((error) => {
        entry.viaPromise = null;
        throw error;
      });
    }
    return entry.viaPromise;
  }

  // 轮着用：挑「没在冷却、又最久没被用过」的那个；全在冷却就返回 null（调用方去等）
  async pick() {
    if (!this.enabled) return null;
    const now = Date.now();
    for (const entry of this.entries) this.#forget(entry, now);

    const ready = this.entries.filter((entry) => entry.coolingUntil <= now);
    if (!ready.length) return null;

    ready.sort((a, b) => a.lastUsedAt - b.lastUsedAt || a.index - b.index);
    const entry = ready[0];
    entry.lastUsedAt = now;
    return this.#via(entry);
  }

  // 排障用（/debug/net?exits=1）：不看冷却，把每个出口挨个拿出来试一遍
  async all() {
    const vias = [];
    for (const entry of this.entries) vias.push(await this.#via(entry));
    return vias;
  }

  penalize(target, { reason = '', kind = 'exit', ms = config.proxyCooldownMs } = {}) {
    const entry = typeof target === 'string' ? this.byUrl.get(target) : target?.entry || null;
    if (!entry) return 0;

    const now = Date.now();
    entry.hits = now - entry.lastHitAt <= REPEAT_MS ? entry.hits + 1 : 1;
    entry.lastHitAt = now;
    entry.lastError = reason;
    entry.lastKind = kind;
    const cooldownMs = Math.min(config.proxyMaxCooldownMs, ms * 2 ** (entry.hits - 1));
    entry.coolingUntil = Math.max(entry.coolingUntil, now + cooldownMs);
    return cooldownMs;
  }

  // 一个出口都派不出来时，是「站点在限流」还是「出口连不上」—— 文案不一样，别把隧道掉了
  // 说成站点在拍我们（见 subhd.js 的 rateLimitError）
  blocked(now = Date.now()) {
    const cooling = this.entries.filter((entry) => entry.coolingUntil > now);
    if (!cooling.length) return null;
    const kinds = new Set(cooling.map((entry) => entry.lastKind || 'exit'));
    return {
      cooling: cooling.length,
      kind: kinds.size === 1 ? [...kinds][0] : 'mixed',
      reason: cooling.find((entry) => entry.lastError)?.lastError || '',
      nextInMs: this.nextAvailableIn(now),
    };
  }

  // 还要等多久才有出口可用（0 = 现在就用得上）
  nextAvailableIn(now = Date.now()) {
    if (!this.enabled) return 0;
    return this.entries.reduce((min, entry) => Math.min(min, Math.max(0, entry.coolingUntil - now)), Infinity);
  }

  state(now = Date.now()) {
    const cooling = this.entries.filter((entry) => entry.coolingUntil > now);
    return {
      enabled: this.enabled,
      total: this.entries.length,
      cooling: cooling.length,
      nextAvailableInMs: this.nextAvailableIn(now),
      nodes: this.entries.slice(0, STATE_NODES).map((entry) => ({
        label: entry.label,
        coolingMs: Math.max(0, entry.coolingUntil - now),
        hits: entry.hits,
        lastError: entry.lastError || null,
      })),
    };
  }
}

export const proxies = new ProxyPool(parseProxyList(config.proxyList));
