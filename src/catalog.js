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

// 「用户输入的关键词 → 该拿去迅雷搜的几个词」。
//
// 迅雷的索引很怪：搜 `The Odyssey` 能出 57 条（而且文件全是中文的「奥德赛.srt」），
// 但搜 `Odyssey`、搜「奥德赛」都是 0 条 —— 它只认「完整的英文原名」。
// 所以不能拿用户输入的原词硬搜，要先靠 Cinemeta 把片子认准：
//   用户输入 "Odyssey" → Cinemeta 找不到准确条目 → 试 "The Odyssey" → 命中 tt33764258，
//   拿到片名 "The Odyssey" → 用这个完整名字去迅雷搜，57 条就都出来了。
async function thunderSearchTerms(keyword) {
  const raw = String(keyword || '').trim();
  const candidates = new Set();
  const add = (value) => {
    const text = String(value || '').trim().replace(/\s{2,}/g, ' ');
    if (text) candidates.add(text);
  };

  add(raw);

  // 用 Cinemeta 认准这部片，拿到它的「标准片名」。
  // 注意不能「第一个查询有结果就用」：搜 "Odyssey" 会命中另一部同名片（tt31227740, 2025），
  // 而用户想要的是 "The Odyssey"（2026）。所以每个写法都查，最后挑片名和输入最接近的。
  const hits = [];
  for (const term of [...candidates]) {
    try {
      const hit = await searchMeta('movie', term);
      if (hit && /^tt\d+$/.test(String(hit.id || ''))) hits.push({ hit, term });
    } catch {
      // 忽略，继续试下一个写法
    }
  }
  // 完全同名 > 输入是片名的一部分（Odyssey ⊂ The Odyssey）
  // 降序排：完全同名 > 输入是片名的一部分（Odyssey ⊂ The Odyssey）> 只沾一点
  // 输入本身是完整片名（"The Odyssey"）时，同名的那个永远排第一
  const score = ({ hit, term }) => {
    const name = String(hit.name || '').toLowerCase().trim();
    const input = term.toLowerCase().trim();
    if (name === input) return 3;
    // 带冠词的写法命中（输入 "Odyssey"，结果 "The Odyssey"）也算高匹配
    if (name.replace(/^(the|a|an)\s+/, '') === input.replace(/^(the|a|an)\s+/, '')) return 3;
    if (name.includes(input) || input.includes(name)) return 2;
    return 1;
  };
  hits.sort((a, b) => score(b) - score(a));
  let meta = hits[0]?.hit || null;
  if (meta) meta = await addonMeta('movie', meta.id).catch(() => null) || meta;

  const final = new Set();
  const add2 = (v) => { const t = String(v || '').trim().replace(/\s{2,}/g, ' '); if (t) final.add(t); };
  if (meta) {
    const names = [meta.name, meta.originalName].filter(Boolean);
    for (const name of names) {
      const clean = String(name).replace(/\s*\(\d{4}\)\s*$/, '').trim();
      add2(clean); // 完整英文名（迅雷真正认的写法）
      for (const alias of aliasesFor(clean)) add2(alias); // 中文译名也带上
    }
    const year = Number(String(meta.releaseInfo || '').match(/(19|20)\d{2}/)?.[0]) || null;
    if (year && meta.name) add2(`${String(meta.name).replace(/\s*\(\d{4}\)\s*$/, '')} ${year}`);
  }

  // 用户的原词也留着（万一是中文名）
  add2(raw);
  // 没有 meta 时至少保证有原词和带冠词的写法
  if (final.size === 0) for (const c of candidates) add2(c);
  return [...final].slice(0, 4);
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
      // 迅雷的 simple_name 是中文（「简体[SRT]奥德赛(2026)」），拿它去 Cinemeta 会查错片
      // （「奥德赛」只命中 2016 那部）。所以先用**文件名里的英文名**（The.Odyssey.2026…）反查，
      // 查不到再退回中文名。
      for (const item of items) {
        const parsed = parseSimpleName(item.simple_name);
        // 年份：simple_name 里带的（「简体[SRT]奥德赛(2026)」）最可靠，没有再从文件名里找
        const year =
          parsed.year || Number(String(item.name || '').match(/(?<!\d)(19|20)\d{2}(?!\d)/)?.[0]) || null;
        const title = parsed.work || englishTitleFrom(item.name);
        const key = `${title}|${year || ''}`;
        if (!title || seenWorks.has(key)) continue;
        seenWorks.add(key);
        works.push({ title, year });
        if (works.length >= MAX_LOOKUPS) break;
      }
      // 迅雷是按热度排的，同名不同年的片子会混在一起（奥德赛 2026 / 2016 / 1961）。
      // 用户搜的就是他想要的那部，所以让「年份最新 + 条目最多」的排前面。
      works.sort((a, b) => (b.year || 0) - (a.year || 0));
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

