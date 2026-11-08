// 迅雷 / 射手（伪）两个来源的「发现页目录」：最新电影、最新剧集、按片名搜索。
//
// Stremio 的目录返回的是 meta 预览（id 必须是 tt 编号，点进去才能正常播放），
// 所以这里做两件事：
//   - 搜索：用户输入关键词 → 迅雷 / 射手的搜索结果 → 每个作品名去 Cinemeta 换成 tt；
//   - 最新：迅雷没有「最新」接口（它只按名字搜），最新列表只有射手（伪）有（/xml/list/sub/）。
import { TtlCache } from './cache.js';
import { searchMeta } from './meta.js';
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
const usableName = (title) => /[\p{Script=Han}]/u.test(title) ? title.length >= 2 && title.length <= 60 : title.length >= 3 && title.split(/\s+/).length <= 8;

// 「用户输入的关键词 → 该拿去迅雷搜的几个词」。
// 迅雷的接口要求关键词能「完整对上」：搜 `The Odyssey` 有 57 条，搜 `Odyssey` 是 0 条
// （它不会做模糊匹配），所以这里除了原名和中文译名，还补上「the/a/an + 原名」和「原名 + 年份」
// 这些常见写法。能查到的片子再补它自己的中英文名。
async function thunderSearchTerms(keyword) {
  const raw = String(keyword || '').trim();
  const terms = new Set();
  const add = (value) => {
    const text = String(value || '').trim();
    if (text && !terms.has(text)) terms.add(text);
  };

  add(raw);
  // 「Odyssey」→「The Odyssey」：迅雷那边片名常常带冠词
  if (!/^(the|a|an)\s/i.test(raw)) add(`The ${raw}`);
  else add(raw.replace(/^(the|a|an)\s+/i, ''));

  try {
    const hit = await searchMeta('movie', raw);
    const names = [hit?.name, hit?.originalName].filter(Boolean);
    for (const name of names) {
      const clean = String(name).replace(/\s*\(\d{4}\)\s*$/, '').trim();
      add(clean);
      if (!/^(the|a|an)\s/i.test(clean)) add(`The ${clean}`);
      for (const alias of aliasesFor(clean)) add(alias);
    }
    const year = Number(String(hit?.releaseInfo || '').match(/(19|20)\d{2}/)?.[0]) || null;
    if (year) {
      add(`${raw} ${year}`);
      if (hit?.name) add(`${String(hit.name).replace(/\s*\(\d{4}\)\s*$/, '')} ${year}`);
    }
  } catch {
    // 查不到就只按原词和补全的写法搜
  }

  return [...terms].slice(0, 4);
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
      const terms = await thunderSearchTerms(keyword);
      const batches = await Promise.allSettled(terms.map((term) => searchThunder(term)));
      const items = batches.flatMap((batch) => (batch.status === 'fulfilled' ? batch.value : []));
      const works = [];
      const seenWorks = new Set();
      for (const item of items) {
        const { title, year } = thunderWorkName(item);
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

