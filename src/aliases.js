// Cinemeta 只给英文原名（Dune: Part Two），而迅雷 / 射手（伪）的字幕名大多是「中文译名 + 英文名」，
// 迅雷甚至中文译名一条能搜到、英文名搜不到（搜 Dune 是 0 条，搜 沙丘 有 58 条）。
//
// 所以这里放一份常用片名的中文译名表：先按英文名去搜，搜不到就再按中文译名搜一次；
// 判定的时候中文译名也算「身份对得上」，不会被当成别的片子。表不用很全 —— 没有的名字
// 只是少一种查法，不影响原有的匹配。想加条目就直接往下面加一行。

export const TITLE_ALIASES = {
  // 沙丘系列
  dune: ['沙丘', '沙丘瀚戰'],
  'dune part two': ['沙丘2', '沙丘：第二部', '沙丘：第二部'],
  'dune prophecy': ['沙丘：预言'],

  // 诺兰
  interstellar: ['星际穿越', '星際效應', '星际效应'],
  inception: ['盗梦空间', '全面啟動', '盗梦'],
  oppenheimer: ['奥本海默'],
  tenet: ['信条'],
  dunkirk: ['敦刻尔克'],
  'the dark knight': ['黑暗骑士', '蝙蝠侠：黑暗骑士'],
  'the dark knight rises': ['黑暗骑士崛起', '蝙蝠侠：黑暗骑士崛起'],
  'batman begins': ['蝙蝠侠：侠影之谜'],
  memento: ['记忆碎片'],
  'the prestige': ['致命魔术'],
  prestige: ['致命魔术'],

  // 热门剧
  'breaking bad': ['绝命毒师', '絕命毒師'],
  'game of thrones': ['权力的游戏', '冰与火之歌', '權力的遊戲'],
  'house of the dragon': ['龙之家族'],
  friends: ['老友记', '六人行', '老友記'],
  'the big bang theory': ['生活大爆炸', '宅男行不行', '天才理论传'],
  'stranger things': ['怪奇物语'],
  'the office': ['办公室'],
  'the last of us': ['最后生还者'],
  'the boys': ['黑袍纠察队'],
  chernobyl: ['切尔诺贝利'],
  'peaky blinders': ['浴血黑帮'],
  'money heist': ['纸钞屋'],
  'la casa de papel': ['纸钞屋'],
  'squid game': ['鱿鱼游戏'],
  'the walking dead': ['行尸走肉'],
  'prison break': ['越狱'],
  lost: ['迷失'],
  dark: ['暗黑'],
  westworld: ['西部世界'],
  'sex education': ['性爱自修室'],
  'modern family': ['摩登家庭'],
  'how i met your mother': ['老爸老妈的浪漫史'],
  'the wire': ['火线'],
  'the sopranos': ['黑道家族'],
  succession: ['继承之战'],
  'better call saul': ['风骚律师'],
  'the mandalorian': ['曼达洛人'],
  'the expanse': ['苍穹浩瀚'],
  'attack on titan': ['进击的巨人'],
  'death note': ['死亡笔记'],
  'one piece': ['海贼王', '航海王'],
  'the crown': ['王冠'],
  sherlock: ['神探夏洛克'],

  // 经典电影
  'the odyssey': ['奥德赛', '奥德塞'],
  'the godfather': ['教父'],
  'the lord of the rings': ['指环王', '魔戒'],
  'harry potter': ['哈利波特'],
  'the matrix': ['黑客帝国', '駭客任務'],
  'fight club': ['搏击俱乐部'],
  'forrest gump': ['阿甘正传'],
  'the shawshank redemption': ['肖申克的救赎', '刺激1995'],
  'spirited away': ['千与千寻', '神隱少女'],
  'your name': ['你的名字'],
  avatar: ['阿凡达', '阿凡達'],
  titanic: ['泰坦尼克号', '铁达尼号', '鐵達尼號'],
  'the wolverine': ['金刚狼'],
  'spider-man': ['蜘蛛侠'],
  batman: ['蝙蝠侠'],
  'star wars': ['星球大战'],
  'the avengers': ['复仇者联盟'],
  'avengers endgame': ['复仇者联盟4', '终局之战'],
  'john wick': ['疾速追杀'],
  'fast and furious': ['速度与激情'],
  'furious 7': ['速度与激情7'],
  'top gun maverick': ['壮志凌云2'],
  'the batman': ['新蝙蝠侠'],
  'everything everywhere all at once': ['瞬息全宇宙'],
  'spider-man across the spider-verse': ['蜘蛛侠：纵横宇宙'],
  'spider-man into the spider-verse': ['蜘蛛侠：平行宇宙'],
  'saving private ryan': ['拯救大兵瑞恩'],
  "schindler's list": ['辛德勒的名单'],
  'the silence of the lambs': ['沉默的羔羊'],
  "leon's the professional": ['这个杀手不太冷'],
  parasite: ['寄生虫'],
  'the grand budapest hotel': ['布达佩斯大饭店'],
  whiplash: ['爆裂鼓手'],
  'green book': ['绿皮书'],
  joker: ['小丑'],
  'the lion king': ['狮子王'],
  'toy story': ['玩具总动员'],
  coco: ['寻梦环游记'],
  soul: ['心灵奇旅'],
  'mad max fury road': ['疯狂的麦克斯'],
  'blade runner 2049': ['银翼杀手2049'],
  arrival: ['降临'],
  'the martian': ['火星救援'],
  gravity: ['地心引力'],
};

// 名字 → 中文译名列表（大小写、标点都不敏感）
// 片名的「近似问法」：别名表里没收录的片子，也尽量多试一种查法 ——
// 迅雷 / 射手的中文条目常常只写中文名，而英文名搜不到中文条目。
const CJK_ALIAS_HINTS = {
  奥德赛: ['the odyssey'],
  odyssey: ['奥德赛'],
};

export function aliasesFor(title) {
  const key = String(title || '')
    .toLowerCase()
    .replace(/[^\p{Script=Han}a-z0-9]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!key) return [];

  const found = new Set(TITLE_ALIASES[key] || []);
  for (const [needle, extra] of Object.entries(CJK_ALIAS_HINTS)) {
    if (key.includes(needle)) for (const alias of extra) found.add(alias);
  }
  // 「Dune: Part Two」去掉副标题后也查一次（「Dune」→ 沙丘）
  const head = key.split(' ')[0];
  if (head && head !== key && TITLE_ALIASES[head]) {
    for (const alias of TITLE_ALIASES[head]) found.add(alias);
  }
  return [...found];
}
