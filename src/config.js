import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'));

const int = (value, fallback) => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const ADDON_ID = process.env.ADDON_ID || 'community.subhd';
export const ADDON_VERSION = pkg.version;
export const SITE_NAME = 'SubHD';

// 这版是多来源的：SubHD + 迅雷 + 射手（伪）。SUBHD_SOURCES 用一个逗号分隔的名单挑
// 启用哪几个（默认三个全开），名单为空时退回只有 SubHD。
const SOURCE_IDS = ['subhd', 'thunder', 'assrt'];
const enabledSources = [];
if (process.env.SUBHD_SOURCES === undefined || process.env.SUBHD_SOURCES.trim() === '') {
  enabledSources.push(...SOURCE_IDS);
} else {
  for (const raw of process.env.SUBHD_SOURCES.split(/[,;\s]+/)) {
    const id = raw.trim().toLowerCase();
    if (id && SOURCE_IDS.includes(id) && !enabledSources.includes(id)) enabledSources.push(id);
  }
  if (enabledSources.length === 0) enabledSources.push('subhd');
}

export const config = {
  host: process.env.HOST || '0.0.0.0',
  port: int(process.env.PORT, 7000),
  baseUrl: (process.env.ADDON_BASE_URL || '').replace(/\/+$/, ''),
  domains: (process.env.SUBHD_DOMAINS || 'subhd.tv,subhd.me,subhd.one,subhd.top,subhd.cc,subhd.com')
    .split(',')
    .map((domain) => domain.trim())
    .filter(Boolean),
  requestTimeoutMs: int(process.env.REQUEST_TIMEOUT_MS, 15000),
  domainWalkBudgetMs: int(process.env.DOMAIN_WALK_BUDGET_MS, 20000),
  // 允许读进内存的字幕体积，同时压着「下载的压缩包」和「解压后的字幕」两条线。文本字幕
  // 撑死几 MB，但 SUP/PGS 这种图形字幕动辄几十上百 MB（实测一部 1080p 电影的 `.sup` 就有
  // 90MB），按 80MB 卡会把它们悄悄丢掉、只剩包里那个几百字节的说明文件。Vercel Hobby
  // 函数的默认内存和上限都是 2GB，放得下 256MB 的字幕。
  maxArchiveBytes: int(process.env.MAX_ARCHIVE_BYTES, 256 * 1024 * 1024),
  maxSubtitleResults: int(process.env.MAX_SUBTITLE_RESULTS, 40),
  // 三个来源合在一个列表里返回时的总条数上限（SubHD 在前，迅雷、射手依次补）
  maxMergedResults: int(process.env.MAX_MERGED_RESULTS, 80),
  catalogSearchPages: int(process.env.CATALOG_SEARCH_PAGES, 2),
  catalogWorkLimit: int(process.env.CATALOG_WORK_LIMIT, 14),
  downloadIntervalMs: int(process.env.DOWNLOAD_INTERVAL_MS, 1500),
  // 站点说「下载频率过高」时别在请求里干等：它的窗口按分钟算（实测 6 分钟还没放开），
  // 1.5 秒后的重试基本不可能成功，只会多敲一次、把封禁窗口续上。
  // 所以默认不重试（1 次就报错），让用户马上换一条 —— 下面那两条通常已经预热好了。
  downloadRetryDelayMs: int(process.env.DOWNLOAD_RETRY_DELAY_MS, 1500),
  downloadAttempts: int(process.env.DOWNLOAD_ATTEMPTS, 1),
  rateLimitCooldownMs: int(process.env.RATE_LIMIT_COOLDOWN_MS, 90_000),
  // 出口池。填了 SUBHD_PROXIES 之后，「下载」那几步（prepare-download -> /down ->
  // api/sub/down，以及把包取回来）就不再从这台机器自己的 IP 出去，而是从池子里的
  // 某个出口出去 —— 站点是按出口 IP 记账的，被拍一个就换下一个。
  // 每项一个地址，逗号/分号/换行都行：http://127.0.0.1:7890、socks5://user:pass@host:1080。
  // 客户端自己开的隧道（ssh -R / frp / cloudflared）在这里也就是一个 socks5 地址，
  // 于是「SubHD 从哪条网络出去」就跟着客户端当前那条网络走。
  proxyList: process.env.SUBHD_PROXIES || process.env.SUBHD_PROXY || '',
  // 一次下载最多换几个出口（池子里有几个就最多试几个，再被这个数封顶）
  proxyAttempts: int(process.env.SUBHD_PROXY_ATTEMPTS, 3),
  // 某个出口被拍（或连不上）之后冷落多久。站点封的是那个 IP，冷却期内别再碰它；
  // 连着被拍就翻倍（90s -> 3min -> 6min ...），上限 30 分钟。
  proxyCooldownMs: int(process.env.SUBHD_PROXY_COOLDOWN_MS, 90_000),
  proxyMaxCooldownMs: int(process.env.SUBHD_PROXY_MAX_COOLDOWN_MS, 30 * 60 * 1000),
  // 连代理本身超时：节点挂了要快点换下一个，别让用户干等
  proxyConnectMs: int(process.env.SUBHD_PROXY_CONNECT_MS, 10_000),
  prefetchNeighbors: int(process.env.PREFETCH_NEIGHBORS, 2),
  prefetchDelayMs: int(process.env.PREFETCH_DELAY_MS, 4000),
  // 站上的 SUP/PGS 图形字幕（一帧帧图片）也列进列表：Stremio 桌面版（mpv）能直接放，
  // 网页版/手机版放不出来。`INCLUDE_IMAGE_SUBTITLES=0` 可以退回「只列文本字幕」。
  includeImageSubtitles: process.env.INCLUDE_IMAGE_SUBTITLES !== '0',
  logLevel: process.env.LOG_LEVEL || 'info',
  cache: {
    searchMs: int(process.env.CACHE_SEARCH_MS, 5 * 60 * 1000),
    workMs: int(process.env.CACHE_WORK_MS, 10 * 60 * 1000),
    fileMs: int(process.env.CACHE_FILE_MS, 30 * 60 * 1000),
    metaMs: int(process.env.CACHE_META_MS, 60 * 60 * 1000),
    maxFileBytes: int(process.env.CACHE_MAX_FILE_BYTES, 64 * 1024 * 1024),
  },
  // 启用的字幕来源（顺序就是列表里的顺序）：subhd / thunder / assrt
  sources: enabledSources,
  // 每个来源最多等多久（毫秒）。客户端自己有超时，一个站连不上不能拖着整个列表；
  // 到点就用已经拿到的结果，晚到的写进缓存。0 = 不限时。
  sourceDeadlineMs: int(process.env.SOURCE_DEADLINE_MS, 9000),
  // 冷启动时（函数刚起来 / 空闲超过一分钟）给更宽的预算：DNS 和连接池都是空的，第一次总要慢些
  sourceDeadlineColdMs: int(process.env.SOURCE_DEADLINE_COLD_MS, 8000),
  // 第一个来源回来后，再给其它来源多久「补进来」（不补也无所谓，结果会进缓存）
  sourceLateGraceMs: int(process.env.SOURCE_LATE_GRACE_MS, 2500),
  // 某个来源连续失败这么多次就先跳过它一段时间（毫秒），别每次请求都白等一遍
  sourceFailureThreshold: int(process.env.SOURCE_FAILURE_THRESHOLD, 2),
  sourceCooldownMs: int(process.env.SOURCE_COOLDOWN_MS, 120000),
  // 迅雷字幕：接口是迅雷看看网页端在用的那个（api-shoulei-ssl.xunlei.com/oracle/subtitle），
  // 按片名搜，返回的结果里带着字幕文件的直链（subtitle.v.geilijiasu.com）。
  thunder: {
    apiBase: (process.env.THUNDER_API_BASE || 'https://api-shoulei-ssl.xunlei.com').replace(/\/+$/, ''),
    // 一次请求拿多少条（接口默认也就给这么多）
    limit: int(process.env.THUNDER_LIMIT, 60),
    // 迅雷接口在部分机房（比如 Vercel 的 hkg1）连不上，默认可连的很快返回，
    // 连不上的几秒内就放弃，换/退回别的来源
    // 单次超时别太短：机房跨境连迅雷本来就要 1~3 秒，4 秒会误杀；整体仍受 SOURCE_DEADLINE_MS 兜底
    timeoutMs: int(process.env.THUNDER_TIMEOUT_MS, 2500),
    // 可选：Cloudflare Worker 出口代理。Vercel 机房连迅雷常被掐断，配上之后迅雷这一路
    // 走 CF（实测 CF 香港连迅雷 5/5 成功、0.4~1 秒）。不配就直连，行为不变。
    proxyUrl: (process.env.THUNDER_PROXY_URL || '').trim(),
    proxySecret: (process.env.THUNDER_PROXY_SECRET || '').trim(),
    // 一次最多往播放器列表里放多少条
    maxResults: int(process.env.THUNDER_MAX_RESULTS, 30),
    // 片名要和字幕名对得上才算：至少命中标题里的几个词（英文按词算，中文按整串算）
    minTitleTokens: int(process.env.THUNDER_MIN_TOKENS, 1),
  },
  // 射手（伪）assrt.net：
  //   - 填了 ASSRT_TOKEN 就走官方 API（api.assrt.net，最稳，推荐）；
  //   - 没填就走网页（assrt.net/sub/ 搜索 + 详情页 + /download/<id>/<文件名>），
  //     不用注册，但站点偶尔会在出口 IP 上拦一下。
  // 两个 domain 是同一个站的线路（主站 TLS 只认 1.3，在国内网络下才通；2.assrt.net 是备份）。
  assrt: {
    token: (process.env.ASSRT_TOKEN || '').trim(),
    apiBase: (process.env.ASSRT_API_BASE || 'https://api.assrt.net').replace(/\/+$/, ''),
    domains: (process.env.ASSRT_DOMAINS || 'assrt.net,2.assrt.net')
      .split(',')
      .map((domain) => domain.trim())
      .filter(Boolean),
    maxResults: int(process.env.ASSRT_MAX_RESULTS, 30),
    timeoutMs: int(process.env.ASSRT_TIMEOUT_MS, 5000),
    // 作品页上的「查找本片的其他字幕」最多再看几条
    detailLimit: int(process.env.ASSRT_DETAIL_LIMIT, 20),
  },
  userAgent:
    process.env.USER_AGENT ||
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
};

// 给 addon.js / server.js 用：解析后的来源名单，永远非空。
export function subtitleSources() {
  const list = Array.isArray(config.sources) ? config.sources.filter(Boolean) : [];
  return list.length > 0 ? list : ['subhd'];
}

// 射手（伪）有没有配置好：有 token 走 API，没有就走网页（网页那条路一直可用）。
export const isAssrtReady = () => config.assrt.token.length > 0 || config.assrt.domains.length > 0;
