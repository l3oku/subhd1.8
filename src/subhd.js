import { extname } from 'node:path';
import { config } from './config.js';
import { TtlCache } from './cache.js';
import { log } from './log.js';
import { createPacing } from './pacing.js';
import { CookieJar, HttpError, RateLimitError, SiteClient, isRateLimitMessage, request, sleep } from './http.js';
import { proxies } from './proxy.js';
import {
  cleanText,
  detectEpisodeInText,
  parseDetailPage,
  parseSearchPage,
  parseWorkPage,
} from './parse.js';
import {
  detectContainer,
  extractArchive,
  formatBytes,
  isSubtitleFile,
  oversizeReason,
} from './archive.js';
import {
  convertSubtitle,
  decodeTextBuffer,
  detectTextFormat,
  hasUtf16Bom,
  isProbablyBinary,
  stripBom,
} from './subtitle-format.js';

export class AppError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = 'AppError';
    this.status = status;
  }
}

export const client = new SiteClient(config.domains);

const searchCache = new TtlCache({ ttlMs: config.cache.searchMs, maxEntries: 300 });
const workCache = new TtlCache({ ttlMs: config.cache.workMs, maxEntries: 400 });
const fileCache = new TtlCache({
  ttlMs: config.cache.fileMs,
  maxEntries: 60,
  maxBytes: config.cache.maxFileBytes,
  sizeOf: (value) => value?.raw?.length || 0,
});
const urlCache = new TtlCache({ ttlMs: 4 * 60 * 1000, maxEntries: 300 });
const imdbCache = new TtlCache({ ttlMs: config.cache.metaMs, maxEntries: 400 });
const extractCache = new TtlCache({
  ttlMs: config.cache.fileMs,
  maxEntries: 40,
  maxBytes: config.cache.maxFileBytes,
  sizeOf: (value) => (value?.files || []).reduce((total, file) => total + (file.data?.length || 0), 0),
});

const downloadQueue = { chain: Promise.resolve(), lastFinishedAt: 0 };
// 被限流之后怎么退让（下载间隔翻倍 + 冷却窗口翻倍）都在 pacing.js 里，别一个劲往里撞。
// 这是「没有出口池」时的退让方式；配了 SUBHD_PROXIES 就按出口逐个冷落（见 proxy.js）。
const pace = createPacing({
  intervalMs: config.downloadIntervalMs,
  cooldownMs: config.rateLimitCooldownMs,
});

// 还要等多久才能再碰站点：有出口池就是「最快解冻的那个出口还要多久」，没有就是这台机器自己的冷却
const rateLimitRemaining = () =>
  proxies.enabled ? proxies.nextAvailableIn() : pace.cooldownRemaining();

// 站点自己说的是「下载频率过高」，别说成机房被墙了 —— 用户等一等就能用。
// 冷却期内我们不碰站点，所以这句话要能自己交代清楚「为什么现在点不了」。
function rateLimitError() {
  const seconds = Math.max(1, Math.ceil(rateLimitRemaining() / 1000));

  if (proxies.enabled) {
    // 「所有出口都被站点拍了」和「所有出口都连不上」（隧道断了、节点挂了）是两回事，
    // 后者说成频率过高会把用户带偏 —— 他会去等，而该做的是把隧道拉起来。
    const blocked = proxies.blocked();
    if (blocked && blocked.kind !== 'limit') {
      const detail = blocked.reason ? `，最近一次：${blocked.reason}` : '';
      return new AppError(
        `出口都用不了：${blocked.cooling}/${proxies.size} 个在冷却，最快约 ${seconds} 秒后可用${detail}。` +
          '先看看隧道 / 节点是不是掉了',
        502,
      );
    }
    return new AppError(
      `SubHD 提示「下载频率过高」：${proxies.size} 个出口眼下都被拍了，约 ${seconds} 秒后再试，` +
        '或先换列表里的另一条字幕。这段时间插件不会再请求 SubHD，免得越点越久',
      503,
    );
  }

  return new AppError(
    `SubHD 提示「下载频率过高」（按出口 IP 限流），约 ${seconds} 秒后再试，或先换列表里的另一条字幕。` +
      '这段时间插件不会再请求 SubHD，免得越点越久',
    503,
  );
}

const isRateLimited = (error) => error instanceof RateLimitError || isRateLimitMessage(error?.message);
// 出口自己的毛病：连不上 / 超时（status 0），或者被站点按 IP 拦了（403 那类）。
// 跟「频率过高」一样，换个出口就有机会，别急着把错误丢给用户。
const isExitProblem = (error) => error instanceof HttpError && !isRateLimited(error);

function scheduleDownload(task) {
  const scheduled = downloadQueue.chain.then(async () => {
    const wait = downloadQueue.lastFinishedAt + pace.current() - Date.now();
    if (wait > 0) await sleep(wait);
    try {
      return await task();
    } finally {
      downloadQueue.lastFinishedAt = Date.now();
    }
  });
  downloadQueue.chain = scheduled.then(
    () => undefined,
    () => undefined,
  );
  return scheduled;
}

// 这一次下载走哪个出口：配了池子就挑一个（被拍就换下一个），没配就直接从这台机器出去。
// 同一个出口要贯穿「三步握手 + 把包取回来」全程 —— 站点可能把下载凭据和 IP 绑在一起，
// 中途换出口只会白拿一个 403。
async function withRateLimitRetry(task) {
  const attempts = proxies.enabled
    ? Math.max(1, Math.min(proxies.size, config.proxyAttempts))
    : Math.max(1, config.downloadAttempts);
  let delay = config.downloadRetryDelayMs;

  // 冷却期内一次都不敲：站点是按出口 IP 记账的，封禁窗口以分钟计（实测点了 6 分钟还没放开），
  // 每敲一次都可能把窗口续上 —— 用户「越点越久」就是这么来的。已经下过的字幕走缓存，不受影响。
  if (rateLimitRemaining() > 0) throw rateLimitError();

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const via = proxies.enabled ? await proxies.pick() : null;
    if (proxies.enabled && !via) break; // 一个出口都挑不出来：全在冷却

    try {
      return await task(via);
    } catch (error) {
      if (via && (isRateLimited(error) || isExitProblem(error))) {
        const limited = isRateLimited(error);
        const reason = limited ? '站点限流' : String(error.message || '').slice(0, 80);
        const ms = limited
          ? config.proxyCooldownMs
          : Math.min(config.proxyCooldownMs, 60_000);
        const cooldownMs = proxies.penalize(via, { reason, kind: limited ? 'limit' : 'exit', ms });
        log(
          `出口 ${via.label} ${limited ? '被站点限流' : '不通'}：冷落 ` +
            `${Math.round(cooldownMs / 1000)} 秒，换下一个出口`,
        );
        continue;
      }
      if (!isRateLimited(error)) throw error;

      // 没池子：被拍的就是这台机器的 IP。站点封的是 IP，重试只会把窗口续上，
      // 所以默认就不重试（DOWNLOAD_ATTEMPTS=1）—— 真要重试，这里才自己等一下再来。
      pace.hit();
      log(
        `SubHD 按出口 IP 限流（第 ${pace.hits} 次）：${Math.round(pace.cooldownMs / 1000)} 秒内不再请求，` +
          `下载间隔自适应调到 ${pace.intervalMs}ms`,
      );
      if (attempt === attempts) break;
      await sleep(delay);
      delay = Math.min(Math.round(delay * 2), 20_000);
    }
  }
  throw rateLimitError();
}

// 给 /healthz 用：现在是不是在冷却、这一波被拍了几次、间隔被自适应调到了多少。
// 「点了没反应」时看一眼就知道是不是站点在限流（见 README 的同一节）。
export function rateLimitState() {
  return {
    remainingMs: rateLimitRemaining(),
    intervalMs: pace.current(),
    hits: pace.hits,
    cooldownMs: pace.cooldownMs,
    proxy: proxies.state(),
  };
}

async function safeJson(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { success: false, msg: text.slice(0, 200) };
  }
}

export async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      try {
        results[index] = await worker(items[index], index);
      } catch {
        results[index] = null;
      }
    }
  });

  await Promise.all(runners);
  return results;
}

export async function search(query, { page = 1 } = {}) {
  const keyword = String(query ?? '').trim();
  if (!keyword) return { total: 0, page: 1, entries: [] };

  const path = `/search/${encodeURIComponent(keyword)}${page > 1 ? `/${page}` : ''}`;
  return searchCache.wrap(`search:${path}`, async () => {
    const html = await client.text(path, { headers: { referer: client.url('/') } });
    return parseSearchPage(html);
  });
}

export async function getWork(workId) {
  const id = String(workId ?? '').replace(/[^\d]/g, '');
  if (!id) throw new AppError('无效的作品 ID', 400);

  return workCache.wrap(`work:${id}`, async () => {
    const html = await client.text(`/d/${id}`, { headers: { referer: client.url('/') } });
    const work = parseWorkPage(html);
    return { ...work, workId: work.workId || id };
  });
}

export async function worksFromEntries(entries, { limit = config.catalogWorkLimit } = {}) {
  const ids = [];
  for (const entry of entries) {
    if (entry.workId && !ids.includes(entry.workId)) ids.push(entry.workId);
    if (ids.length >= limit) break;
  }

  const works = await mapLimit(ids, 5, async (workId) => {
    try {
      const work = await getWork(workId);
      return work.imdbId ? work : null;
    } catch {
      return null;
    }
  });

  return works.filter(Boolean);
}

export async function findEntries(rawId, { pages = 1 } = {}) {
  return imdbCache.wrap(`imdb:${rawId}:${pages}`, async () => {
    const collected = [];
    let total = 0;
    let lastPage = 1;

    for (let page = 1; page <= pages; page += 1) {
      const result = await search(rawId, { page });
      if (page === 1) total = result.total;
      lastPage = result.page || page;
      collected.push(...result.entries);
      if (result.entries.length === 0) break;
      if (result.total && lastPage * 20 >= result.total) break;
    }

    const seen = new Set();
    const entries = collected.filter((entry) => {
      if (!entry?.sid || seen.has(entry.sid)) return false;
      seen.add(entry.sid);
      return true;
    });

    return { total, entries };
  });
}

export async function latest(type, { page = 1 } = {}) {
  const section = String(type) === 'series' ? 'tv' : 'movie';
  const path = `/sub/${section}${page > 1 ? `/${page}` : ''}`;
  return searchCache.wrap(`feed:${path}`, async () => {
    const html = await client.text(path, { headers: { referer: client.url('/') } });
    return parseSearchPage(html);
  });
}

export function decodeSubtitleBuffer(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);

  if (bytes.length >= 2) {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) {
      return { text: stripBom(new TextDecoder('utf-16le').decode(bytes)), encoding: 'utf-16le' };
    }
    if (bytes[0] === 0xfe && bytes[1] === 0xff) {
      const swapped = Buffer.from(bytes);
      swapped.swap16();
      return { text: stripBom(new TextDecoder('utf-16le').decode(swapped)), encoding: 'utf-16be' };
    }
  }

  // 不能「谁先不报错就用谁」：GB18030 能把 Big5 的繁中字幕解成「荡㏑瑀畍」而不报错，
  // 所以交给 decodeTextBuffer 按「解出来像不像正常字幕」挑编码。
  const { encoding, text } = decodeTextBuffer(bytes);
  return { text: stripBom(text), encoding };
}

async function resolveDownloadOnce(sid, via = null) {
  const jar = new CookieJar();
  const detailReferer = client.url(`/a/${sid}`);

  const prepareResponse = await client.fetchPath('/api/sub/prepare-download', {
    method: 'POST',
    jar,
    via,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      referer: detailReferer,
      'x-requested-with': 'XMLHttpRequest',
    },
    body: JSON.stringify({ sid }),
  });
  const prepare = await safeJson(prepareResponse);
  if (!prepare || !prepare.url) {
    throw new AppError(prepare?.msg || 'SubHD 未返回下载地址，请稍后重试');
  }

  await client.fetchPath(prepare.url, { jar, via, headers: { referer: detailReferer } });

  const downResponse = await client.fetchPath('/api/sub/down', {
    method: 'POST',
    jar,
    via,
    headers: { 'content-type': 'application/json', referer: client.url(prepare.url) },
    body: JSON.stringify({ sid }),
  });
  const down = await safeJson(downResponse);
  if (!down || !down.url) {
    throw new AppError(down?.msg || 'SubHD 拒绝了下载请求，请稍后重试');
  }

  // 把出口一起带出去：取包（CDN）也要从同一个 IP 走，有的 CDN 直链是认 IP 的
  return { url: down.url, referer: client.url('/'), via };
}

async function resolveDownload(sid) {
  return urlCache.wrap(`url:${sid}`, () =>
    scheduleDownload(() => withRateLimitRetry((via) => resolveDownloadOnce(sid, via))),
  );
}

async function downloadOnce(sid) {
  const resolved = await resolveDownload(sid);
  const response = await request(resolved.url, {
    headers: { referer: resolved.referer },
    via: resolved.via,
    timeoutMs: 60_000,
  });
  if (!response.ok) throw new AppError(`下载源返回 HTTP ${response.status}`);
  const raw = Buffer.from(await response.arrayBuffer());
  if (raw.length > config.maxArchiveBytes) throw new AppError('字幕文件超出大小限制');
  const filename = decodeURIComponent(
    new URL(resolved.url).pathname.split('/').pop() || `subhd-${sid}`,
  );
  return { raw, filename };
}

export async function fetchRemoteFile(sid) {
  const value = await fileCache.wrap(
    `file:${sid}`,
    async () => {
      try {
        return await downloadOnce(sid);
      } catch (error) {
        if (isRateLimited(error)) throw error;
        urlCache.delete(`url:${sid}`);
        return downloadOnce(sid);
      }
    },
    config.cache.fileMs,
  );
  markUserActivity();
  return value;
}

export async function getArchiveFiles(sid) {
  markUserActivity();
  const { raw, filename } = await fetchRemoteFile(sid);
  return extractFilesFromBuffer(raw, filename, sid);
}

// 「一个压缩包（或者干脆就是一份字幕）→ 里面的文件」。SubHD 那条路是现下现解，
// 射手（伪）那条路是把整个包取回来再走这里 —— 解压、缓存、体积上限都用同一套。
export async function getArchiveFilesFromBuffer(raw, filename) {
  return extractFilesFromBuffer(raw, filename, null);
}

async function extractFilesFromBuffer(raw, filename, sid = null) {
  const container = detectContainer(raw, filename);

  if (container === 'text' || container === 'unknown') {
    const files = [{ name: filename, data: raw }];
    if (sid) await rememberNote(sid, files);
    return { container: 'text', filename, tool: null, files };
  }

  const cached = sid ? extractCache.get(`extract:${sid}`) : undefined;
  if (cached) return cached;

  const result = await extractArchive(raw, { container, maxBytes: config.maxArchiveBytes });
  if (result.files.length === 0) {
    const oversize = oversizeReason(result.skipped, config.maxArchiveBytes);
    throw new AppError(
      oversize
        ? `该字幕是 ${container} 压缩包，${oversize}，服务器没能解出来（调大 MAX_ARCHIVE_BYTES 可以放宽）`
        : `该字幕是 ${container} 压缩包，服务器解压失败${result.reason ? ` (${result.reason})` : ''}`,
      502,
    );
  }

  const value = {
    container,
    filename,
    tool: result.tool,
    files: result.files,
    skipped: result.skipped || [],
  };
  if (sid) {
    await rememberNote(sid, result.files);
    extractCache.set(`extract:${sid}`, value, config.cache.fileMs);
  }
  return value;
}

// 用户点开一条字幕后，列表里它下面那一两条也在后台悄悄下好 —— 换字幕时不用再等 SubHD
// 现下现解压（冷启动好几秒，撞上限流更久）。只在用户这边安静下来之后才动手，一次只下一个包，
// 失败就当没发生：别为了省用户几秒把站点惹毛。
const warmState = { queue: [], running: false, active: false, lastAt: 0 };
let lastUserActivityAt = 0;

// 后台预热期间不算「用户在用」，否则自己会把自己挡住。
function markUserActivity() {
  if (!warmState.active) lastUserActivityAt = Date.now();
}

export function warmSubtitles(sids, limit = config.prefetchNeighbors) {
  const count = Math.max(0, Math.min(Number(limit) || 0, 4));
  if (count === 0 || rateLimitRemaining() > 0) return;

  let queued = 0;
  for (const raw of sids || []) {
    if (queued >= count) break;
    const sid = String(raw ?? '');
    if (!/^[A-Za-z0-9]{4,12}$/.test(sid)) continue;
    if (warmState.queue.includes(sid)) continue;
    // 已经下过的包不用再下（同一个包换语言也在这里省掉）
    if (fileCache.get(`file:${sid}`) || extractCache.get(`extract:${sid}`)) continue;
    warmState.queue.push(sid);
    queued += 1;
  }

  void runWarmQueue();
}

async function runWarmQueue() {
  if (warmState.running) return;
  warmState.running = true;

  try {
    while (warmState.queue.length > 0) {
      // 站点正在限流就先收手，等用户下次点再排
      if (rateLimitRemaining() > 0) {
        warmState.queue.length = 0;
        break;
      }

      const wait = Math.max(
        lastUserActivityAt + config.prefetchDelayMs - Date.now(),
        warmState.lastAt + pace.current() - Date.now(),
        0,
      );
      if (wait > 0) {
        // 用户中途又点了：只睡一小会就重算，别把用户挡在后面
        await sleep(Math.min(wait, 1000));
        continue;
      }

      const sid = warmState.queue.shift();
      warmState.active = true;
      try {
        await getArchiveFiles(sid);
      } catch {
        // 下不动就算了，用户真去点的时候会看到原因
      } finally {
        warmState.active = false;
        warmState.lastAt = Date.now();
      }
    }
  } finally {
    warmState.running = false;
  }
}

// 一个压缩包常常按语言分成好几份文件：KKTV 的日剧包就是 `…S01E03….ja.srt` 和
// `…S01E03….zh-Hant.srt` 各一份，也有的写成 `….繁体&英文.ass`、`….Chs&Eng.ass`，
// 还有整包都不写语言的（这种包里通常只有一种语言）。站点标签只说「包里有哪些语言」，
// 具体是哪一份文件得看文件名，所以每条轨道都带着自己要的语言下来挑。
const CHINESE_FILE_RE =
  /(^|[^a-z0-9])(zh([-_.]?(hans|hant|cht|chs|cn|tw|sg))?|chs|cht|chi|sc|tc|cn|tw|big5)(?![a-z0-9])|简|繁|中文|双语|國語|国语/i;

function chineseFirst(files) {
  const chinese = files.filter((file) => CHINESE_FILE_RE.test(String(file.name)));
  if (chinese.length === 0 || chinese.length === files.length) return files;
  return chinese.concat(files.filter((file) => !chinese.includes(file)));
}

// 文件名里的语言标记 → 轨道上的语言代码。只认字幕圈通用的写法，不猜发布名里的
// 两字母缩写（`TC` 是抢鲜版、`SC` 也可能是别的意思），短代码必须独立成段才算。
const LANGUAGE_PATTERNS = [
  ['zh-Hant', /繁|zh[-_.]?hant|cht|big5/i],
  ['zh-Hans', /简|簡|zh[-_.]?hans|chs/i],
  ['zh', /中文|中字|國語|国语|双语|雙語|(^|[^a-z0-9])zh([^a-z0-9]|$)/i],
  ['ja', /日[语語文字]|(^|[^a-z0-9])(ja|jp|jpn|jap)([^a-z0-9]|$)/i],
  ['ko', /[韩韓][语語文字]|(^|[^a-z0-9])(ko|kor)([^a-z0-9]|$)/i],
  ['en', /英[语語文字]|双语|雙語|(^|[^a-z0-9])(en|eng|english)([^a-z0-9]|$)/i],
  ['fr', /法[语語文字]|(^|[^a-z0-9])(fr|fre|fra|french)([^a-z0-9]|$)/i],
  ['de', /德[语語文字]|(^|[^a-z0-9])(de|ger|deu|german)([^a-z0-9]|$)/i],
  ['es', /西班牙[语語]|(^|[^a-z0-9])(es|spa|esp|spanish)([^a-z0-9]|$)/i],
  ['it', /意大利[语語]|義大利|(^|[^a-z0-9])(it|ita|italian)([^a-z0-9]|$)/i],
  ['ru', /俄[语語文字]|(^|[^a-z0-9])(ru|rus|russian)([^a-z0-9]|$)/i],
  ['pt', /葡萄牙[语語]|(^|[^a-z0-9])(pt|por|portuguese)([^a-z0-9]|$)/i],
];

export function fileLanguages(name) {
  const text = String(name ?? '');
  const found = new Set();
  for (const [code, pattern] of LANGUAGE_PATTERNS) {
    if (!pattern.test(text)) continue;
    // 认得出简繁就别再挂一个笼统的「中文」：简中、繁中是两条不同的轨道。
    if (code === 'zh' && (found.has('zh-Hans') || found.has('zh-Hant'))) continue;
    if (code !== 'zh' && (code === 'zh-Hans' || code === 'zh-Hant')) found.delete('zh');
    found.add(code);
  }
  return found;
}

// 站点说这一条是简中/繁中/日语时，就到包里找对应的那一份。文件名什么都没写就按时站
// 标签认（整包只有一种语言的包都这样）；实在找不到才把选择权交回给调用方。
function filesForLanguage(files, lang) {
  const wanted = String(lang ?? '').toLowerCase();
  if (!wanted) return [];

  const hasLanguage = (file, code) =>
    [...fileLanguages(file.name)].some((found) => found.toLowerCase() === code);

  const exact = files.filter((file) => hasLanguage(file, wanted));
  if (exact.length > 0) return exact;

  const untagged = files.filter((file) => fileLanguages(file.name).size === 0);
  if (untagged.length > 0) return untagged;

  // 站点标了简繁各一份、包里却只有一份中文：宁可给另一份中文，也别让这一行点不动
  if (wanted.startsWith('zh')) {
    return files.filter(
      (file) => hasLanguage(file, 'zh') || hasLanguage(file, 'zh-hans') || hasLanguage(file, 'zh-hant'),
    );
  }

  return [];
}

export function pickArchiveFile(
  files,
  { target = 'srt', season = null, episode = null, lang = null } = {},
) {
  if (!Array.isArray(files) || files.length === 0) return null;
  const extOf = (file) => extname(String(file.name)).toLowerCase();
  const best = (list) =>
    list.find((file) => extOf(file) === `.${target}`) ||
    list.find((file) => isSubtitleFile(file.name)) ||
    list[0] ||
    null;

  const episodeFiles = episode
    ? files.filter((file) => detectEpisodeInText(file.name, season, episode))
    : [];
  const pool = episodeFiles.length > 0 ? episodeFiles : files;
  const targeted = filesForLanguage(pool, lang);
  return best(targeted.length > 0 ? targeted : chineseFirst(pool));
}

export async function getSubtitleText(
  sid,
  { targetExt = 'srt', season = null, episode = null, lang = null } = {},
) {
  const archive = await getArchiveFiles(sid);
  return subtitleTextFromArchive(archive, { targetExt, season, episode, lang });
}

// 已经解好的包（射手伪那边是自己把文件取回来再解的）→ 一份文本字幕。
export function subtitleTextFromArchive(archive, { targetExt = 'srt', season = null, episode = null, lang = null } = {}) {
  const { container, filename, tool, files } = archive;
  const target = ['srt', 'ass', 'vtt'].includes(targetExt) ? targetExt : 'srt';
  const selected = pickArchiveFile(files, { target, season, episode, lang });
  const matchesEpisode = (name) =>
    Boolean(episode) && detectEpisodeInText(name, season, episode);

  // 只有网盘说明的包里挑出来的「字幕」其实就是那份说明：当成一条说明字幕发出去，
  // 用户点完能在画面里看见链接（直接发原文只会是一段没有时间轴的乱码）
  const note = noteOnly([selected]);
  if (note) {
    return {
      note: true,
      text: noteSubtitle(note),
      ext: 'srt',
      encoding: 'UTF-8',
      container,
      tool,
      language: lang || null,
      matchedEpisode: false,
      sourceName: selected.name || filename,
    };
  }

  if (isProbablyBinary(selected.data) && !hasUtf16Bom(selected.data)) {
    throw new AppError(
      '该字幕是图形/二进制格式（如 SUP、VobSub），Stremio 无法当作文本字幕渲染，请换一条',
      415,
    );
  }

  const { text, encoding } = decodeSubtitleBuffer(selected.data);
  const format = detectTextFormat(text);
  if (format === 'sub') {
    throw new AppError('该字幕是图形字幕 (VobSub/SUP)，Stremio 无法直接渲染，请换一条字幕');
  }

  return {
    text: convertSubtitle(text, format, target),
    ext: target,
    encoding,
    container,
    tool,
    language: lang || null,
    matchedEpisode: matchesEpisode(selected.name),
    sourceName: selected.name || filename,
  };
}

// 图形字幕（SUP/PGS）不在服务端转文本，把包里那一份 .sup / .pgs 原样发出去，
// 交给会画图片字幕的播放器（mpv 等）。
export const IMAGE_SUBTITLE_EXTS = ['.sup', '.pgs'];

// 站上有一类「假字幕包」：包里就一份网盘分享说明（百度 / 阿里云盘链接），字幕本体在网盘
// 上 —— 阿里云盘不支持 .sup，作者会把文件改名成 .smi 再分享（条目 zYmhLc 就是）。这种包
// 里挑不出任何字幕，只说「包里没有 .sup / .pgs」等于什么都没说：把说明里的链接带出来，
// 用户才知道去哪拿。
const SHARE_URL_RE = /https?:\/\/[^\s"'<>，。；、）】]+/;

// 同步函数：调用方（noteOnly / 列表）到处在用，别让它们变成 async
export function shareNote(files) {
  for (const file of files || []) {
    if (extname(String(file.name)).toLowerCase() !== '.txt') continue;
    const { text } = decodeSubtitleBuffer(file.data);
    const url = String(text).match(SHARE_URL_RE);
    if (url) return url[0].replace(/[.)\]]+$/, '');
  }
  return null;
}

// 整个包里只有说明 txt（一份字幕文件都没有）才算「假包」：真字幕包顺手夹一份说明很正常。
export function noteOnly(files) {
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return null;
  if (list.some((file) => extname(String(file.name)).toLowerCase() !== '.txt')) return null;
  return shareNote(list);
}

// 把说明当成一条字幕发出去。这类包最大的问题是「没法提示」：Stremio 不显示失败的响应体，
// 用户点完就是没反应。文本字幕谁都画得出来，链接写在画面里至少看得见。
// 时间轴铺满整部片子 —— 用户常常看到一半才去挑字幕，只放在开头等于没显示。
export function noteSubtitle(note) {
  return (
    '1\n00:00:00,000 --> 99:59:59,000\n' +
    `这条字幕没有随包上传（包里只有一份网盘分享说明），去这里拿：\n${note}\n`
  );
}

// sid → 分享链接：点过一次就知道这条是假包，下次列字幕时能直接写在第二行（见 addon.js）。
// 站上这些包不会变，缓存给长一点。
const NOTE_TTL_MS = 6 * 60 * 60 * 1000;
const noteCache = new TtlCache({ ttlMs: NOTE_TTL_MS });

async function rememberNote(sid, files) {
  const note = noteOnly(files);
  if (note) noteCache.set(`note:${sid}`, note, NOTE_TTL_MS);
  return note;
}

export function noteFor(sid) {
  return noteCache.get(`note:${String(sid ?? '')}`) || null;
}

export function pickImageSubtitleFile(files, { season = null, episode = null, lang = null } = {}) {
  const candidates = (files || []).filter((file) =>
    IMAGE_SUBTITLE_EXTS.includes(extname(String(file.name)).toLowerCase()),
  );
  if (candidates.length === 0) return null;
  return pickArchiveFile(candidates, { target: 'sup', season, episode, lang });
}

export async function getSubtitleBinary(sid, { season = null, episode = null, lang = null } = {}) {
  const { container, filename, tool, files, skipped } = await getArchiveFiles(sid);
  const selected = pickImageSubtitleFile(files, { season, episode, lang });
  if (!selected) {
    const blocked = (skipped || []).find((file) =>
      IMAGE_SUBTITLE_EXTS.includes(extname(String(file.name)).toLowerCase()),
    );
    const note = blocked ? null : noteOnly(files);
    if (note) {
      // 图形字幕的位置上只能发文本，但总比让用户对着没反应的屏幕猜要好（见 noteSubtitle）
      return {
        note: true,
        text: noteSubtitle(note),
        ext: 'srt',
        container,
        tool,
        language: lang || null,
        matchedEpisode: false,
        sourceName: filename,
      };
    }
    throw new AppError(
      blocked
        ? `这一条的图形字幕 ${blocked.name}（${formatBytes(blocked.size)}）超过服务器体积上限，没能解出来`
        : '这一条不是图形字幕（压缩包里没有 .sup / .pgs 文件），请换一条',
      415,
    );
  }

  return {
    data: selected.data,
    ext: 'sup',
    container,
    tool,
    language: lang || null,
    matchedEpisode: Boolean(episode) && detectEpisodeInText(selected.name, season, episode),
    sourceName: selected.name || filename,
  };
}

export async function getSubtitleDetail(sid) {
  const html = await client.text(`/a/${sid}`, { headers: { referer: client.url('/') } });
  return { sid, ...parseDetailPage(html), url: client.url(`/a/${sid}`) };
}

export const caches = { searchCache, workCache, fileCache, urlCache, imdbCache, noteCache };
