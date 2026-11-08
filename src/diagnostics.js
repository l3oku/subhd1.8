import { resolveTool } from './binary.js';
import { request } from './http.js';
import { client } from './subhd.js';
import { proxies } from './proxy.js';

const TTL_MS = 30_000;
const PROBE_PATH = '/search/dune';
const HEADERS_OF_INTEREST = ['server', 'cf-mitigated', 'cf-ray', 'x-vercel-mitigated'];

let cached = null;
let cachedAt = 0;

// 「我这个出口的 IP 是多少」问哪个服务：ipify / Cloudflare 在国内时通时不通（实测直连和
// 走代理都失败过），所以第一个用国内能稳定访问的 ipip.net，后面几个当备份。谁先答出来用谁。
// 返回体格式各不相同（JSON / ip= 行 / 「当前 IP：」），统一从里面捞出第一个 IP。
const EGRESS_PROBES = [
  'https://myip.ipip.net',
  'https://www.cloudflare.com/cdn-cgi/trace',
  'https://api.ipify.org?format=json',
];
const IP_RE = /\b(\d{1,3}(?:\.\d{1,3}){3})\b/;

// 拿不到 IP 就抛最后一个错误 —— 调用方自己决定是写进报告还是标成 null
async function lookupEgressIp(via = null, timeoutMs = 8000) {
  let lastError = new Error('没有可用的探测服务');
  for (const url of EGRESS_PROBES) {
    try {
      const response = await request(url, { timeoutMs, via });
      if (!response.ok) {
        lastError = new Error(`HTTP ${response.status}: ${url}`);
        continue;
      }
      const ip = IP_RE.exec(await response.text())?.[1];
      if (ip) return ip;
      lastError = new Error(`响应里没有 IP: ${url}`);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

// 走了出口池的请求，从站点那边看到的到底是谁的 IP —— 换节点之前先确认这个，
// 不然「换了半天还是被限流」只能是靠猜。只有 ?exits=1 时才真的去敲一遍（每个节点一次）。
async function exitIp(via) {
  const started = Date.now();
  try {
    return { egressIp: await lookupEgressIp(via, 10_000), ms: Date.now() - started };
  } catch (error) {
    return { egressIp: null, error: error.message, ms: Date.now() - started };
  }
}

async function exitsReport() {
  let vias;
  try {
    vias = await proxies.all();
  } catch (error) {
    return { error: error.message };
  }
  const exits = [];
  for (const via of vias) exits.push({ label: via.label, ...(await exitIp(via)) });
  return { total: exits.length, exits };
}

async function probe(domain) {
  const entry = { domain };
  const started = Date.now();
  try {
    const response = await request(`https://${domain}${PROBE_PATH}`, {
      headers: { referer: `https://${domain}/` },
      timeoutMs: 8000,
    });
    entry.status = response.status;
    entry.bytes = (await response.arrayBuffer()).byteLength;
    for (const header of HEADERS_OF_INTEREST) {
      const value = response.headers.get(header);
      if (value) entry[header] = value;
    }
  } catch (error) {
    entry.error = error.message;
  }
  entry.ms = Date.now() - started;
  return entry;
}

// Public endpoint used to explain "why does the deployed addon get 403 while
// my laptop does not": it reports where the function runs and what SubHD
// answers to this particular egress IP.
export async function networkReport({ exits = false } = {}) {
  // ?exits=1 每次都真去敲节点，别拿缓存糊弄
  if (!exits && cached && Date.now() - cachedAt < TTL_MS) return cached;

  const domains = client.candidates();
  const report = {
    runtime: {
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      region: process.env.VERCEL_REGION || process.env.AWS_REGION || null,
      deployment: process.env.VERCEL_URL || null,
      sevenZip: await resolveTool('7z'),
    },
    egressIp: await lookupEgressIp().catch((error) => `unavailable (${error.message})`),
    domains: await Promise.all(domains.map(probe)),
    checkedAt: new Date().toISOString(),
  };

  if (proxies.enabled) report.proxy = proxies.state();
  if (exits && proxies.enabled) report.exits = await exitsReport();

  if (exits) return report;
  cached = report;
  cachedAt = Date.now();
  return report;
}
