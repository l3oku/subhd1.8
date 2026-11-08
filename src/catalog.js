// 迅雷 / 射手（伪）两个来源的「发现页目录」：最新电影、最新剧集、按片名搜索。
//
// Stremio 的目录返回的是 meta 预览（id 必须是 tt 编号，点进去才能正常播放），
// 所以这里做两件事：
//   - 搜索：用户输入关键词 → 迅雷 / 射手的搜索结果 → 每个作品名去 Cinemeta 换成 tt；
//   - 最新：迅雷没有「最新」接口（它只按名字搜），最新列表只有射手（伪）有（/xml/list/sub/）。
import { TtlCache } from './cache.js';
import { addonMeta, searchMeta } from './meta.js';
import { aliasesFor } from './aliases.js';
import { logSource } from './net.js';
import { searchThunder } from './thunder.js';
import { parseSimpleName } from './thunder.js';
import { latestAssrt, searchAssrt, splitAssrtTitle } from './assrt.js';

const metaCache = new TtlCache({ ttlMs: 6 * 60 * 60 * 1000, maxEntries: 400 });

// 「简体[SRT]沙丘2(2024)」里的作品名 → { title, year }
function thunderWorkName(item) {
  const parsed = parseSimpleName(item.simple_name);
  return { title: parsed.work || String(item.name || '').replace(/\.[A-Za-z0-9]{1,4}$/, ''), year: parsed.year };
}

function toPreview(meta, type, extra = {}) {
  return {
    id: meta.id,
    type,
    name: meta.name || meta.originalName || meta.id,
    poster: meta.poster || undefined,
    posterShape: 'poster',
    releaseInfo: /^\d{4}/.test(String(meta.releaseInfo || '')) ? meta.releaseInfo : undefined,
    description: extra.description,
  };
}

// 每个作品名只换一次 tt 编号（Cinemeta 的搜索接口不快，别一个名字问两遍）
async function previewFor(type, name, year) {
  if (!name) return null;
  return metaCache.wrap(`preview:${type}:${name.toLowerCase()}:${year || ''}`, async () => {
    const meta = await searchMeta(type, name, { year });
    if (!meta) return null;
    return { meta, year };
  });
}

// 一次目录请求最多换几个 tt 编号：Cinemeta 一次 200~800ms，多了就超时了
const MAX_LOOKUPS = 12;
// 名字里「像片名」的那一段：太长的是完整发布名，短名字（一个词）像是随手起的文件名
// 文件名里那段英文片名：「The.Odyssey.2026.1080p.BluRay…」→「The Odyssey」
// 只认「开头到第一个年份/画质标记」这一段，别把发布组、语言标记一起带出来。
function englishTitleFrom(value) {
  const text = String(value || '').replace(/^\[[^\]]*\]\s*/, ''); // 去掉 [zmk.pw] 这种前缀
  const head = text.split(/(?<![A-Za-z])(19|20)\d{2}(?![0-9])/)[0]; // 年份前面那段
  const cleaned = head
    .replace(/\.(mkv|mp4|avi|srt|ass|ssa|sup|zip|rar|7z)$/i, '')
    .replace(/[._]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  // 至少两个词、全是英文字母，才当作「英文片名」
  const words = cleaned.split(' ').filter(Boolean);
  if (words.length < 1 || words.length > 8) return '';
  if (!/^[A-Za-z0-9'’&:!,.\- ]+$/.test(cleaned)) return '';
  if (cleaned.length < 4) return '';
  return cleaned;
}

const usableName = (title) => /[\p{Script=Han}]/u.test(title) ? title.length >= 2 && title.length <= 60 : title.length >= 3 && title.split(/\s+/).length <= 8;

// 「用户输入的关键词 → 该拿去迅雷搜的词」。
//
// 关键事实（实测）：
//   - Cinemeta 的 **series** 检索对中文很准：绝命毒师→Breaking Bad、老友记→Friends、
//     权力的游戏→Game of Thrones；而 **movie** 检索对中文基本是乱的（绝命毒师→《续命之徒》）。
//   - 迅雷只认完整英文名：搜 "The Odyssey" 57 条（文件是中文的「奥德赛.srt」），
//     搜英文残缺名 / 某些中文名是 0 条。
// 所以顺序是：**先用用户输入（中文也行）问 Cinemeta 拿标准片名 → 再用标准片名去迅雷搜**，
// 而不是拿迅雷的中文结果去反查 Cinemeta（那样会被电影类型的乱结果带偏）。
async function thunderSearchTerms(keyword, kind) {
  const raw = String(keyword || '').trim();
  const terms = new Set([raw]); // 原词优先
  // 先按目录类型查，查不到再查另一种
  const order = kind === 'series' ? ['series', 'movie'] : ['movie', 'series'];
  for (const type of order) {
    try {
      const hit = await searchMeta(type, raw);
      if (!hit?.name) continue;
      const clean = String(hit.name).replace(/\s*\(\d{4}\)\s*$/, '').trim();
      if (clean) terms.add(clean);
      if (hit.originalName) terms.add(String(hit.originalName).trim());
      if (clean || hit.originalName) break;
    } catch {
      // 继续试
    }
  }
  // 用户原词一定保留在最前面：迅雷的中文条目（「老友记」「绝命毒师」）只有中文名能搜到，
  // 换成英文名反而一条都没有。
  return [...terms].filter(Boolean).slice(0, 3);
}

// 「迅雷里搜出来的这些作品名 → 挑出适合当搜索结果的」。
// 用户输中文时，迅雷给的 simple_name 也是中文（「奥德赛」），拿它查 Cinemeta 会串到别的片，
// 所以这里优先用「用户原词已经在 Cinemeta 认出来的那部」，其次才用迅雷自己的名字去认。
async function pickBestWorks(works, keyword, kind) {
  const years = new Set(works.map((w) => w.year).filter(Boolean).map(String));
  const order = kind === 'series' ? ['series', 'movie'] : ['movie', 'series'];
  const wantName = (() => {
    const w = String(keyword || '').toLowerCase().trim();
    return w;
  })();

  const hits = [];
  for (const work of works) {
    if (!work.title) continue;
    for (const type of order) {
      try {
        const hit = await searchMeta(type, work.title, { year: work.year });
        if (hit && /^tt\d+$/.test(String(hit.id || ''))) hits.push({ hit, work, type });
      } catch {
        // 忽略
      }
    }
  }

  const scored = hits.map((entry) => {
    const name = String(entry.hit.name || '').toLowerCase();
    const title = String(entry.work.title || '').toLowerCase();
    let score = 0;
    if (name === title || name.replace(/^(the|a|an)\s+/, '') === title.replace(/^(the|a|an)\s+/, '')) score += 3;
    else if (name.includes(title) || title.includes(name)) score += 1;
    const metaYear = String(entry.hit.releaseInfo || '').match(/(19|20)\d{2}/)?.[0];
    if (metaYear && years.has(metaYear)) score += 4; // 迅雷里有这个年份的条目 → 就是这部
    if (entry.type === kind) score += 2; // 和目录类型一致
    if (/[\u4e00-\u9fff]/.test(wantName) && entry.type === 'series') score += 1;
    return { ...entry, score };
  });
  scored.sort((a, b) => b.score - a.score);

  const picked = [];
  const seen = new Set();
  for (const entry of scored) {
    if (seen.has(entry.hit.id)) continue;
    seen.add(entry.hit.id);
    picked.push({
      title: entry.hit.name,
      year: Number(String(entry.hit.releaseInfo || '').match(/(19|20)\d{2}/)?.[0]) || null,
    });
    if (picked.length >= MAX_LOOKUPS) break;
  }
  if (picked.length === 0) return works.filter((w) => w.title).slice(0, MAX_LOOKUPS);
  return picked;
}

export async function sourceCatalog({ type, source, kind, keyword = '', skip = 0 }) {
  const metas = [];
  const seen = new Set();
  const push = (preview) => {
    if (!preview || seen.has(preview.id)) return;
    seen.add(preview.id);
    metas.push(toPreview(preview.meta, type, {}));
  };

  if (kind === 'search') {
    if (!keyword) return metas;

    if (source === 'thunder') {
      // 迅雷的字幕库基本只认中文名：搜「沙丘」58 条，搜「Dune」/「Odyssey」都是 0 条。
      // 用户在目录里输入的可能是英文片名，所以先用 Cinemeta 查一下，拿它的中文译名一起搜。
      const terms = await thunderSearchTerms(keyword, type);
      const batches = await Promise.allSettled(terms.map((term) => searchThunder(term)));
      const items = batches.flatMap((batch) => (batch.status === 'fulfilled' ? batch.value : []));
      const works = [];
      const seenWorks = new Set();
      // 迅雷的 simple_name 是中文（「简体[SRT]奥德赛(2026)」），拿它去 Cinemeta 会查错片，
      // 所以优先用文件名里的英文名（The.Odyssey.2026…）反查，查不到再退回中文名。
      for (const item of items) {
        const parsed = parseSimpleName(item.simple_name);
        const year =
          parsed.year || Number(String(item.name || '').match(/(?<!\d)(19|20)\d{2}(?!\d)/)?.[0]) || null;
        const title = parsed.work || englishTitleFrom(item.name);
        const key = `${title}|${year || ''}`;
        if (!title || seenWorks.has(key)) continue;
        seenWorks.add(key);
        works.push({ title, year });
        if (works.length >= MAX_LOOKUPS) break;
      }
      // 迅雷是按热度排的，同名不同年的片子会混在一起（奥德赛 2026 / 2016 / 1961）
      works.sort((a, b) => (b.year || 0) - (a.year || 0));
      // 把迅雷里出现的「作品名+年份」交给打分用（判断 Cinemeta 的候选是不是真的在迅雷里）
      const ranked = await pickBestWorks(works, keyword, type);
      const previews = await Promise.all(ranked.map((work) => previewFor(type, work.title, work.year)));
      for (const preview of previews) push(preview);
      if (metas.length === 0) logSource('catalog', `thunder/${type} 没认出「${keyword}」（迅雷 ${items.length} 条，作品 ${works.length} 个）`);
      return metas;
    }

    // 射手（伪）：搜索结果里的标题通常就是「片名 原名 (年份)」
    const { items } = await searchAssrt(keyword);
    const works = [];
    const seenWorks = new Set();
    for (const item of items) {
      const { title, year } = splitAssrtTitle(item.title);
      const key = `${title}|${year || ''}`;
      if (!title || !usableName(title) || seenWorks.has(key)) continue;
      seenWorks.add(key);
      works.push({ title, year });
      if (works.length >= MAX_LOOKUPS) break;
    }
    const previews = await Promise.all(works.map((work) => previewFor(type, work.title, work.year)));
    for (const preview of previews) push(preview);
    return metas;
  }

  // 最新：只有射手（伪）有列表（迅雷只能按名字搜）。
  // 最新列表里混着电影和剧，而 Cinemeta 的片名搜索不知道类型 —— 同名的电影和剧会被
  // 搜成同一个 tt，所以先按名字里有没有 SxxExx 分出「像剧的 / 像电影的」，再按请求的
  // 类型去搜。一页最多换 8 个 tt，凑不满 20 条就顺着翻下一页（最多 3 页）。
  if (source !== 'assrt') return metas;
  const wanted = Number(skip) || 0;
  const firstPage = Math.floor(wanted / 20) + 1;

  for (let page = firstPage; page < firstPage + 3 && metas.length < 20; page += 1) {
    const { items } = await latestAssrt(page);
    if (!items.length) break;

    const works = [];
    const seenWorks = new Set();
    for (const item of items) {
      const parsed = splitAssrtTitle(item.title);
      if (!parsed.title || !usableName(parsed.title) || seenWorks.has(parsed.title)) continue;
      const looksSeries = Boolean(parsed.episode) || /第\s*[零一二三四五六七八九十百千\d]+\s*季|全\s*\d+\s*集/.test(parsed.full);
      if (type === 'series' ? !looksSeries : looksSeries) continue;
      seenWorks.add(parsed.title);
      works.push({ title: parsed.title, year: parsed.year });
      if (works.length >= MAX_LOOKUPS) break;
    }

    const previews = await Promise.all(works.map((work) => previewFor(type, work.title, work.year)));
    for (const preview of previews) {
      if (preview?.meta) push(preview);
      if (metas.length >= 20) break;
    }
  }

  if (metas.length === 0) logSource('catalog', `${source}/${type}/latest 没有能对上 Cinemeta 的条目`);
  return metas;
}

