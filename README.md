# 中文字幕 · Stremio 插件（SubHD + 迅雷 + 射手(伪)）

把 [SubHD](https://subhd.tv) 做成 Stremio 插件：**搜索**、**下载**中文字幕，并在播放时直接加载。
这版把另外两个字幕站也接进来了：**迅雷字幕**（迅雷看看 / 迅雷影音那个字幕库）和
**射手网（伪）assrt.net**。

**装的时候只有一个 json 地址**：`https://<你的域名>/manifest.json`。
三个来源的字幕列表是**合并在一起**返回的（同一个 `/subtitles` 接口，同一个列表里），
每一行前面标着来源 —— `SubHD · …` / `迅雷 · …` / `射手(伪) · …`，想用哪条点哪条。
只想要其中一两个时设 `SUBHD_SOURCES=subhd,thunder` 之类即可。

> 为什么不是「一个来源一个 json 地址」：Stremio 客户端（`stremio-core` 的
> `Manifest::is_resource_supported`）是拿请求里的资源名去 `manifest.resources` 里**精确匹配
> `name`** 的，只有叫 `subtitles` 的资源才会被请求。把资源命名成 `subtitles-thunder` 这类名字，
> 客户端根本不会来问，字幕列表就是空的 —— 这也是这个版本修正掉的问题。

## 三个来源

| 来源 | 怎么找字幕 | 点开之后 | 备注 |
| --- | --- | --- | --- |
| **SubHD** `subhd` | 按 IMDb ID → 站点搜索 → 作品页 | 现下现解压缩包，按语言/集号挑一份 | 老功能，见下面各节 |
| **迅雷** `thunder` | Cinemeta 拿到片名 → 迅雷字幕接口按片名搜 | 服务器去迅雷 CDN 取那一份文件 | 只有「按片名」，没有最新列表 |
| **射手(伪)** `assrt` | Cinemeta 片名 → assrt.net 搜索（或官方 API） | 取回整包 → 按语言挑一份 | 可以填 `ASSRT_TOKEN` 走 API |

- 新接的两个来源都**经过插件服务器**去取文件（`/thunder/<base64url(直链)>.<ext>`、
  `/assrt/<编号>.<ext>?lang=…`），不把第三方直链直接交给播放器：这些站的 CDN 在 Vercel
  （hkg1）和国内网络之间的可达性时好时坏，由服务器统一取、统一转 UTF-8，播放器那边只看到
  插件自己的地址，稳定得多。
- **IPv4 优先级（进程级 + 请求级）**：域名同时有 AAAA 记录时，Node 先连 IPv6，境外机房那条路
  常常不通，要卡几秒才回落 —— 这就是「第一次打开列表总是慢、三个来源一起跑时 SubHD 超时」的原因。
  `src/index.js` 里设了 `dns.setDefaultResultOrder('ipv4first')`，每个请求内部也先走 IPv4。
- **超时是「整个请求」的上限**：以前 TLS 1.3 / 1.2 × IPv4 / 默认 四个候选各按满超时算，最坏会叠加成
  4 倍；现在四个候选平分同一个预算，一轮失败立刻换下一个。
- **镜像自动择优**：SubHD 有 6 个镜像，实测同一时刻快慢能差 5 倍（`subhd.tv` 0.9s vs
  `subhd.me` 4.9s），以前固定先试第一个，赶上它慢就报「请求超时」。现在按**实测响应时间**排队，
  超时的镜像会被记成很慢、下次排后面 —— 连续请求稳定在 0.3~0.5 秒。
- **IPv4 优先**：迅雷 / 射手这类跨境站点，域名的 IPv6 常常是「连上去没响应」的黑洞。每个请求
  先按 IPv4 连，失败再用系统默认顺序，不会因为 IPv6 白等几秒。
- **迅雷可以走 Cloudflare 出口**：Vercel 的机房连迅雷经常 Connect Timeout，而实测 Cloudflare 香港
  节点 5/5 成功（0.4~1 秒）。配上 `THUNDER_PROXY_URL` / `THUNDER_PROXY_SECRET` 后，迅雷这一路
  （接口 + 字幕 CDN）改从你的 CF Worker 出去，其它来源照旧。Worker 代码在 `tools/cf-proxy/`，
  **完整步骤见 [`tools/cf-proxy/README.md`](tools/cf-proxy/README.md)**
  （`PROXY_SECRET` 怎么生成、一键按钮、手动部署、Vercel 怎么填，全在同一页）。不配就是直连，行为不变。

  [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/l3oku/subhd1.8/tree/main/tools/cf-proxy)
- **冷启动放宽预算**：函数刚起来时 DNS / 连接池是空的，首次请求给 `SOURCE_DEADLINE_COLD_MS`
  （默认 8 秒），之后回到 `SOURCE_DEADLINE_MS`（3.5 秒）。
- **迅雷 http / https 双协议并发**：两个都发，谁先回有效结果用谁（不同机房下两者快慢差别很大）。
- **迅雷多个片名并发搜**：英文名、带年份、中文译名同时发，谁先命中先收，不再串行等。
- **某个站连不上不会拖垮整个列表**：三个来源并行取，**第一个有结果的先返回**，其余来源再给
  `SOURCE_LATE_GRACE_MS`（默认 2 秒）补进来，还不回来就先不等（它的结果会进缓存，下次秒回）。
  单个来源最迟 `SOURCE_DEADLINE_MS`（默认 6 秒）放弃；连续失败 `SOURCE_FAILURE_THRESHOLD` 次后
  先跳过它 `SOURCE_COOLDOWN_MS`（默认 2 分钟）再试。结果按「来源 + 影片 id」缓存 30 分钟。
  `/healthz` 的 `sources` 能看到每个来源最近一次的错误。实测一部片子 2.5~3.5 秒出结果。
- **迅雷 / 射手(伪) 的搜索结果怎么筛**（`src/match.js`，和 SubHD 同一套思路）：
  1. **片名**：英文按「词边界」逐个比对（`Breaking Bad` 的两个词都得在，且不是别的词的一部分），
     中文整串比对；两字短名（沙丘）要求前后是边界，免得把「沙丘奇兵」算进来。
  2. **以片名打头、后面接别的英文词 → 另一部片**：`Friends.Lovers.1999` 不是《老友记》，
     `Friends.S01E05` 才是；射手那版《风骚律师》S06E11 发布名里夹着 `Breaking.Bad` 也靠这条挡掉。
  3. **中文译名**：Cinemeta 只有英文原名，而迅雷按中文建索引（搜 `Dune` 是 0 条、搜「沙丘」有 58 条），
     所以 `src/aliases.js` 里带了一份常用译名表，英文搜不到就换中文再搜；想加片名直接往表里加一行。
  4. **年份**：字幕名里写了年份就必须对得上（电影 ±1 年、剧集 ±6 年）；
     电影列表里不会出现剧集字幕。
  5. **季 / 集**：写了季号就必须是这一季；写了集号却不是这一集的直接丢掉；
     整季包、全剧合集留着（点开时按集从包里挑文件），排在正片后面，第二行标「整季合集」。
- 射手（伪）主站的 TLS 只认 1.3（国内网络下用 1.2 会在握手阶段被掐掉，报
  `unexpected eof while reading`），插件对这两个站都试 1.3 → 1.2。
- 射手（伪）网页版上不少条目是 `.zip` / `.rar`：Vercel 的 Node 运行时只有打包进仓库的
  `bin/7zzs`（官方完整版 7-Zip，只支持 Linux x64），RAR 由系统里的 `bsdtar`（libarchive）
  来解 —— 所以 `vercel.json` 里要装 `libarchive-tools`，见下面「部署到 Vercel」。两者都解不开时
  会直接说「解压失败」，不会假装成功。要更稳就填 `ASSRT_TOKEN` 走官方 API。

## 功能

- **播放时自动匹配字幕**：播放任意影片（`tt1234567`）或剧集某集（`tt1234567:1:8`）时，插件会按 IMDb ID 在 SubHD 搜索，
  剧集按季/集筛掉不属于这一集的字幕；想看的这一季没出现在搜索结果里时，顺着作品页上的其它季链接找过去。
  列表顺序照抄站点作品页上的「默认排序」（搜索页只用来找作品，插件不按下载量重排）。
- **Stremio 内搜索目录**：在「发现」页每个来源各有一组目录 —— 电影/剧集搜索（SubHD、迅雷、射手(伪)），
  以及最新电影/剧集字幕（SubHD、射手(伪)；迅雷没有「最新」接口）。
  搜索目录返回 IMDb ID，因此可以直接接上 Cinemeta 的海报和 Torrentio 等播放源。
  迅雷 / 射手（伪）的搜索结果会先拿片名去 Cinemeta 换成 tt 编号再列出来。
- **网页搜索下载**：打开插件首页 `http://<你的地址>:7000/` 就是一个搜索下载页，支持中文名/英文名/IMDb ID，
  右上角可以切换 SubHD / 迅雷 / 射手(伪)。
- **自动处理压缩包**：SubHD 上很多字幕是 `.zip` / `.rar` / `.7z` 打包的，插件会自动解压、挑选正确的文件、
  统一转成 UTF-8 的 `SRT`（或 `ASS`），Stremio 可以直接用。
  「包里套包」（一个 zip 里只躺着一个 `xxx.7z`，图形字幕常见这么传）也会往里再解一层，最多两层。
- **图形字幕（SUP / PGS）也在列表里**：站上有一类 `SUP` / `PGS` 的**图形字幕**（BluRay REMUX 常见），
  本质是一张张图片而不是文字。网页版 / 手机版的 Stremio 画不出来，只有 mpv 这类能解图形字幕的播放器
  （桌面版用外部播放器打开）才放得出来，所以插件把它们照样列出来、行里标注「图形字幕」，
  点开把包里的 `.sup` 原样发给你（`/sub/{sid}.sup`），不做文本转换。不想看到它们就设
  `INCLUDE_IMAGE_SUBTITLES=0`。`VobSub`（`.idx` + `.sub` 一对）和 `MKS` 拼不成一条字幕直链，
  仍然不进列表 —— 真想要那两个文件，用 `GET /raw/{sid}` 把原始压缩包拿走。
  注意这种图形字幕一份就常有几十上百 MB（实测一部 1080p 电影的 `.sup` 有 90MB），
  所以 `MAX_ARCHIVE_BYTES` 的默认值给到了 256MB；万一还是超了，插件会明说「包里的
  `xxx.sup`（94.3MB）超过体积上限」，不会让你以为是包里没有字幕。
- **一条字幕里的每种语言各列一条轨道**：SubHD 上一条字幕常常是个压缩包，包里简中、繁中、英语、日语
  各一份文件（`…S03E01….zh-Hans.srt` 和 `…S03E01….zh-Hant.srt`，或者 `….繁体&英文.ass` 配一份
  没写语言的简体）。插件按站点标签把每种语言各列成一条轨道，各自带着语言去包里挑对应的那份文件 ——
  以前一条只挑一份（先中文后其它），于是「简体 + 繁体」的包永远看不到繁体，「繁体 + 日语」的包点繁中
  会拿到日语。文件名里没写语言时（整包只有一种语言的包都这样）就按站点标签认那一份。
  「双语 / 三语」表示「一份文件里中英都有」，这种不会拆开（拆了也是同一份文件）。
- **换字幕不用等第二次下载**：SubHD 是点一次下一次，切到一条还没下过的字幕要先等它下载 + 解压
  （几秒，撞上限流更久）。插件在你点开一条之后，会在后台把列表里它下面那一两条也下好，
  接着换那两条就是秒开的；预热只在没人用的时候跑，一次一个包，站点限流时自动收手。
  `PREFETCH_NEIGHBORS=0` 可以关掉。
- **出口可以换**：`SUBHD_PROXIES` 里给一串 http / socks5 出口，下载就轮着从它们出去；被站点
  拍一个就换下一个。也可以填你自己从客户端开的隧道，让 SubHD 从你当前那条网络出去 ——
  见下面「让 SubHD 从别的网络出去」。
- **编码转换**：自动识别 UTF-8 / UTF-16 / GB18030 / Big5 / Shift-JIS 字幕，输出统一为 UTF-8。
  GB18030 几乎不会解出「无法解码」的字符，所以插件不是「谁先不报错用谁」，而是给每个候选解码结果
  打分（常见汉字/标点加分，CJK 兼容符号、私用区这类怪字符减分），挑最像正常字幕的那个。
- **字幕行怎么显示**：行标题（`label`）是「中文名 + 正在看的集号 + 这条字幕自己的名字」。
  片名常常写成 `怪奇物语 第一季 Stranger Things`，后半截英文对挑字幕没有用（而且同一集下十几条
  字幕会因此长得一模一样 —— 只看 `label` 的客户端根本分不出哪条是谁翻的），
  所以只留中文，后面直接跟站点上那条字幕的发布名；太长就留开头和结尾、中间用 `…` 省略，
  结尾那一截往往才是「字幕组 / 简体&英文 / 特效」。行下方那一行由客户端拿 `lang` 渲染
  （不是所有客户端都显示）：语言、`特效 / AI 校对 / 台词注释` 这类特殊标记、整季、字幕组、
  格式、来源、画质都放在那里 —— 第一行只留名字，标记挤上去反而看不清。选中《越狱》S03E04 时，
  同一个压缩包里的简繁两份各占一行，长这样：

  ```
  越狱 第三季 · 第4集 · 越狱.S03E04.简英双语.1080p.BluRay.x264-ESiR
  简英双语 · 整季 · YYeTs字幕组 · SRT/ASS · 原创翻译 · 1080p BluRay

  越狱 第三季 · 第4集 · Prison.Break.S03E04.繁英双语特效.1080p.BluRay.x264-NTb
  繁英双语 · 双语特效 · 整季 · YYeTs字幕组 · SRT/ASS · 原创翻译 · 1080p BluRay
  ```

  剧名里没写第几季时就退回 `S01E04` 这种写法。发布名里那截中文名已经在行首时不重复第二遍
  （`佐杜洛夫斯基的沙丘 · Jodorowskys.Dune.2013-SONYHD`）。
  整季合集标成「整季」而不是站点归类的集号（SubHD 把整季包挂在「第1集」下面，照抄它的集号会让
  所有行看起来都是第 1 集），下载时再按你正在看的那一集从压缩包里挑文件。轨道 `id` 里也带着同一个
  名字和语言（`越狱 第三季 · 繁中 · UKIN6L`），安卓 / 电视版把 `id` 当标题显示时同样能看懂，
  语言不同的几条也不会撞车。

## 快速开始

需要 Node.js 18+（推荐 20 或 22）。

```bash
node src/index.js
# 或
npm start
```

默认监听 `0.0.0.0:7000`，然后：

1. 打开 `http://localhost:7000/`，可以先用网页版试试搜索下载。
2. 在 Stremio 里安装插件：
   - 桌面版：**插件（Addons）→ 社区插件 → 粘贴地址** `http://localhost:7000/manifest.json`
   - 或者直接点首页上的「在 Stremio 中安装」按钮（`stremio://` 链接）。
3. 播放任意影片 → 字幕 → 选择 **SubHD 中文字幕**。

> 如果要在别的设备（电视、手机）上使用，`localhost` 换成运行本插件的机器 IP，
> 并且建议设置 `ADDON_BASE_URL`（见下），否则字幕直链可能拼错。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | 监听地址 |
| `PORT` | `7000` | 监听端口 |
| `ADDON_BASE_URL` | 空 | 对外访问地址，例如 `https://subhd.example.com`。反向代理后面必填，用于生成 manifest 与字幕直链 |
| `SUBHD_DOMAINS` | `subhd.tv,subhd.me,...` | 站点域名列表，第一个优先，失败自动切换 |
| `REQUEST_TIMEOUT_MS` | `15000` | 单个 HTTP 请求超时 |
| `DOMAIN_WALK_BUDGET_MS` | `20000` | 一次请求在所有 SubHD 镜像上最多花多久（镜像全挂时避免干等好几分钟） |
| `MAX_ARCHIVE_BYTES` | `268435456` | 下载的压缩包 / 解压后的字幕各自的体积上限（256MB）。图形字幕（SUP/PGS）一份就常有几十上百 MB，卡太小会把它们挡在外面，只在错误里留一句「包里没有字幕」 |
| `MAX_SUBTITLE_RESULTS` | `40` | SubHD 这一路每次最多返回多少条字幕（合并列表里迅雷、射手各自的上限见 `THUNDER_MAX_RESULTS` / `ASSRT_MAX_RESULTS`） |
| `MAX_MERGED_RESULTS` | `80` | 三个来源合并后，整个字幕列表的条数上限 |
| `DOWNLOAD_INTERVAL_MS` | `1500` | 两次下载之间的基准间隔（SubHD 有频率限制，别调太小）。被限流后会自动往上加，见下节 |
| `DOWNLOAD_ATTEMPTS` | `1` | 没配出口池时，撞上限流后原地重试几次（间隔翻倍，默认 1.5s 起）。默认不重试：站点限流窗口按分钟算，在原地干等只会让字幕卡住、还可能把封禁续上 |
| `DOWNLOAD_RETRY_DELAY_MS` | `1500` | 上面那次重试等多久 |
| `RATE_LIMIT_COOLDOWN_MS` | `90000` | 没配出口池时，被限流后的冷却时间 |
| `SUBHD_PROXIES` | 空 | 出口池：下载这几步从这些代理出去，被拍一个换下一个（见「让 SubHD 从别的网络出去」）。逗号 / 分号 / 换行分隔，支持 `http://` 与 `socks5://`（可带账号密码） |
| `SUBHD_PROXY_ATTEMPTS` | `3` | 一次下载最多换几个出口 |
| `SUBHD_PROXY_COOLDOWN_MS` | `90000` | 某个出口被站点拍回来 / 连不上之后冷落多久，连着被拍翻倍 |
| `SUBHD_PROXY_MAX_COOLDOWN_MS` | `1800000` | 上面那口气的上限（30 分钟） |
| `SUBHD_PROXY_CONNECT_MS` | `10000` | 连代理本身的超时（节点挂了快点换下一个，别让用户干等） |
| `PREFETCH_NEIGHBORS` | `2` | 点开一条字幕后，顺手预热的「下面几条」（`0` 关掉） |
| `PREFETCH_DELAY_MS` | `4000` | 点完字幕先安静这么久再开始预热，别和用户的下载抢 |
| `INCLUDE_IMAGE_SUBTITLES` | `1` | 是否把 SUP / PGS 图形字幕也列进列表（`0` 只列文本字幕） |
| `SEVEN_ZIP_PATH` | 空 | 自定义 7-Zip 可执行文件路径（默认用 `PATH` 里的 `7z`，Linux x64 上优先用仓库自带的 `bin/7zzs`） |
| `CACHE_SEARCH_MS` / `CACHE_WORK_MS` / `CACHE_FILE_MS` | 5/10/30 分钟 | 各类缓存时长 |
| `LOG_LEVEL` | `info` | `info` / `debug` / `silent` |
| `SUBHD_SOURCES` | `subhd,thunder,assrt` | 启用哪几个来源（逗号分隔，顺序就是字幕列表里的顺序）。只写 `subhd` 就退回老行为：manifest 名字、资源名都和最开始的版本一模一样 |
| `THUNDER_LIMIT` | `60` | 迅雷接口一次取多少条 |
| `THUNDER_MAX_RESULTS` | `30` | 迅雷一次最多列多少条字幕 |
| `THUNDER_MIN_TOKENS` | `1` | 片名至少命中几个词才算同一部片（英文按词、中文整串） |
| `THUNDER_TIMEOUT_MS` | `2500` | 迅雷接口单次请求超时（http / https 同时发，取先回的那个） |
| `ASSRT_TIMEOUT_MS` | `5000` | 射手（伪）单次请求超时 |
| `SOURCE_DEADLINE_MS` | `3500` | 一个来源最多等多久就先用其它来源的结果（客户端自己有超时），`0` = 不限 |
| `SOURCE_LATE_GRACE_MS` | `1000` | 第一个来源有结果后，再给其它来源多久「补进来」（没补上的会进缓存，下次秒回） |
| `SOURCE_FAILURE_THRESHOLD` | `2` | 某个来源连续失败几次就先跳过它 |
| `SOURCE_COOLDOWN_MS` | `120000` | 跳过多久（到点自动放回来） |
| `THUNDER_API_BASE` | `https://api-shoulei-ssl.xunlei.com` | 迅雷字幕接口地址（接口变了可以换） |
| `ASSRT_TOKEN` | 空 | 射手（伪）的 API token（在 assrt.net 个人中心拿）。填了就走官方 API，没填走网页 |
| `ASSRT_DOMAINS` | `assrt.net,2.assrt.net` | 射手（伪）的线路列表，第一个优先 |
| `ASSRT_MAX_RESULTS` | `30` | 射手（伪）一次最多列多少条字幕 |
| `ASSRT_DETAIL_LIMIT` | `20` | 网页那条路上，最多再打开几个详情页补语言/格式 |
| `ASSRT_API_BASE` | `https://api.assrt.net` | 射手（伪）API 地址 |

## 部署

### 一键（Docker，推荐）

```bash
git clone https://github.com/uzzyj333/subhd.git && cd subhd && docker compose up -d --build
```

起来之后：

- 浏览器打开 `http://<机器IP>:7000/` 是插件首页（网页搜索下载字幕），`/healthz` 看版本和这次跑的是哪个提交。
- 装进 Stremio：`http://<机器IP>:7000/manifest.json`（Stremio 和它在同一网络就能直接装）；
  走反代 / 隧道的话先做下面这步，然后用 `https://<你的域名>/manifest.json`。
- 要改端口、挂域名下、调下载间隔：「cp .env.example .env」，改那几行，再 `docker compose up -d`。不改也能跑。

目录就这些（`.env` 可选，其余都是仓库自带的）：

```
subhd/
├── docker-compose.yml   # 端口、环境变量、日志轮转、健康检查
├── .env.example         # cp .env.example .env 之后按需改（端口 / ADDON_BASE_URL / 限流…）
├── Dockerfile           # node:22-alpine + 7zip + bsdtar，构建时装依赖（出口池用的 undici）
├── package.json         # 依赖只有 undici，且只在配了 SUBHD_PROXIES 时才真的加载
├── package-lock.json
├── src/                 # 插件本体，镜像里只放这一层
└── test/                # 测试，不进镜像（.dockerignore 挡住）
```

不想用 compose 就直接跑：

```bash
docker build -t stremio-subhd .
docker run -d --name stremio-subhd --restart unless-stopped \
  -p 7000:7000 \
  -e ADDON_BASE_URL=https://subhd.example.com \
  stremio-subhd
```

Docker 镜像里预装了 `7zip` 与 `libarchive-tools(bsdtar)`，因此 **RAR / 7z 压缩包也能解压**（Alpine 上的 bsdtar 支持 7z LZMA），
包里套包、SUP/PGS 图形字幕同样照常。跟 Vercel 那份部署比，自建没有 4.5MB 的响应体上限，也不需要
给 `/tmp` 留神（容器自己的磁盘够就行），但**缓存都在进程内存里**，重启即失效。

日常几条命令：

```bash
docker logs -f stremio-subhd          # 看日志：自建的一大好处就是报错不用猜
git pull && docker compose up -d --build   # 更新
docker compose down                   # 停掉
```

反向代理示例（Nginx）：

```nginx
location / {
    proxy_pass http://127.0.0.1:7000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Host $host;
    proxy_read_timeout 120s;
}
```

启动时设置 `ADDON_BASE_URL=https://subhd.example.com`（反代/隧道后面必填，否则生成的
manifest 和字幕直链会指向容器自己看到的地址）。没有公网 IP 的话可以用 Cloudflare Tunnel 之类
把 `http://127.0.0.1:7000` 暴露出去，只要 Stremio 那台设备能访问到就行。

### 部署到 Vercel

仓库里已经带了 `vercel.json` 和 `api/index.js`（整个插件是**一个** Serverless Function）。
上传时**整个项目根目录就是上传内容**（不需要再套一层子目录）：把这个目录（或者压缩包解开后的内容）
推到 GitHub 后在 Vercel 里 Import；也可以直接把压缩包拖进 Vercel 的 Deploy 页面，
或者用 CLI：

```bash
npm i -g vercel
vercel          # 预览部署
vercel --prod   # 生产部署
```

**不需要配置任何环境变量**：插件会从 `x-forwarded-host` / `x-forwarded-proto` 推断自己的对外地址。

> `package.json` 里**故意不写 `engines.node`**：Vercel 对宽松范围（`>=18`）会提示「将来会自动升级大版本」
> （构建日志里那条黄色 Warning）。Node 版本请在 Vercel → Settings → General → **Node.js Version**
> 里选（推荐 24.x），该设置优先于 `package.json`，而且不会有这条提示。
部署完成后，Stremio 里安装 `https://<项目名>.vercel.app/manifest.json` 即可。

Vercel 上的几点差异：

- `bin/7zzs` 是随仓库一起打包的 7-Zip 官方**静态**构建，函数启动时会被复制到 `/tmp` 并补上可执行位，
  所以 **7z / zip 压缩包照样能解**，不依赖系统里有没有 7-Zip。
- **RAR 需要 `bsdtar`**：函数的运行时里只有 Node，RAR 交给 `bsdtar`（libarchive）解。
  Linux x64 的 `bsdtar` 已经随仓库放在 `bin/` 里（`bsdtar` + `libarchive.so.*`，
  函数启动时照样复制到 `/tmp` 并补可执行位），所以**不用额外配置**。
  万一哪天它跑不起来，射手（伪）网页版里那些 `.rar` 条目会报「解压失败」；
  填 `ASSRT_TOKEN` 走官方 API 可以绕开。
- 单个响应体上限 **4.5MB**，这是平台硬限制、**任何套餐都调不了**（超过就是
  `413 FUNCTION_PAYLOAD_TOO_LARGE`）。绕法是流式返回：Vercel 只管「先攒好再一次性发回」的响应，
  分块流出去的不算这个上限。所以图形字幕 `/sub/{sid}.sup`（一整部片子的 PGS 常常几十 MB）和
  `/raw/{sid}` 的原始压缩包都是 chunked 发出去的，不设 `Content-Length`；
  文本字幕照旧是普通响应（带 `Content-Length`，方便客户端显示进度），只有超过 4MB 的
  （带特效的 ASS 能长到几 MB）才跟着流式发。
- 函数默认最长跑 **300 秒**（Hobby 上限也是 300s），下大包 + 解压 + 往外发足够用，不用配 `maxDuration`。
- 函数跑在共享的云出口 IP 上，比自建更容易撞上 SubHD 的**按 IP 限流**（见下），
  同一个列表里偶尔有一两条点不出来是正常的。必要时把 `DOWNLOAD_INTERVAL_MS` 调大（例如 `3000`）、
  `CACHE_FILE_MS` 调长。
- 免费版函数内存在 2GB、`/tmp` 512MB；`CACHE_*` 只在单个函数实例内生效，多实例不共享
  （「假包」的链接提示也一样：点过一次之后，命中同一个实例的请求才会带上它）。

**两条必看：**

- **装进 Stremio 请用生产域名** `https://<项目名>.vercel.app/manifest.json`。浏览器地址栏里带
  `-git-<分支>-<团队>` 的是预览部署，默认被 **Vercel Authentication** 保护，所有请求都返回
  `302 → vercel.com/sso-api`；浏览器里有登录态所以看着正常，但 Stremio 拿到的是跳转而不是 JSON，
  怎么都装不上。真要用预览域名就去 Vercel → Settings → Deployment Protection 关掉 Vercel Authentication。
- **函数默认跑在 `iad1`（美东）**，SubHD 前面的 Cloudflare 会对这类境外机房 IP 直接返回 403
  （同一时刻自家网络访问是 200）。仓库里的 `vercel.json` 已经把 `regions` 设为 `hkg1`（香港）；
  如果还是 403，打开 `https://<你的域名>/debug/net` 看实际出口 IP 和各镜像的状态码，再考虑自建。

## SubHD 的「下载频率过高」

SubHD 的下载接口限流时回的是 **HTTP 403 + `{"success":false,"msg":"下载频率过高，请稍后再试。"}`**。
状态码和 Cloudflare 的地域封锁一样，但完全不是一回事：限流等一等就能下，地域封锁换机房才行。
插件会把这段 JSON 读出来，按 `DOWNLOAD_ATTEMPTS` 给一次重试的机会；还是不行就冷却
`RATE_LIMIT_COOLDOWN_MS`，并且把站点原话告诉你，而不是甩一句「境外机房被墙了」。
重试不会拉长：站点要求的等待是几十秒到分钟级的，在请求里干等基本不会成功，
只会让客户端看起来像卡住了（点了没反应十几秒），所以撞上就快点报错、让用户换一条
（列表里下面那两条通常已经预热好了，换过去是秒开的）。

限流是**按出口 IP** 算的：自建（尤其国内出口）基本遇不到；Vercel 这类共享出口因为同一个 IP
上还跑着别人的服务，热门剧集偶尔有一两条点不出来属于正常现象，等一会儿再点同一条就好。

真撞上也不用去改配置：被拍一次之后，插件会把两次下载之间的间隔翻倍（`1500 → 3000 → 6000 …`，
最多 15 秒），安静 15 分钟没再被限流就减半慢慢收回默认值。默认不必为了少数被限流的情况把所有人
拖慢，撞上了又能自己退开。想确认现在到底是不是在限流，自建的话看
`docker logs -f stremio-subhd`（会打一行「SubHD 按出口 IP 限流：下载间隔自适应调到 …」），
或者直接打开 `/healthz`：`{"rateLimit":{"cooldownMs":…,"intervalMs":…}}`，`cooldownMs` 大于 0
就说明还在冷却里。

Vercel 上这套只能缓解、不能根治 —— 限流是按**出口 IP** 算的，而 Vercel 的出口是共享的，
`/healthz` 里看到的冷却也多半是邻居带来的。想让这条路彻底不出现，办法只有自建（见上面的
「一键（Docker，推荐）」）：自己的出口 IP 上只有你一个人在下载。

## 让 SubHD 从别的网络出去（出口池）

站点按**出口 IP** 记账，默认情况下插件的出口就是它自己所在机器的 IP。给它一串代理，出口就
变成你可选的东西：

```bash
SUBHD_PROXIES=socks5://user:pass@node1:1080,http://node2:3128
```

写几个都行（逗号 / 分号 / 换行分隔；`host:port` 不带协议按 http 代理算），池子里的出口
**轮着用**：某个出口被站点拍回来、或者它自己连不上，插件就冷落它一段（90 秒起，连着被拍
翻倍，上限 30 分钟），换下一个再试，一次下载最多换 `SUBHD_PROXY_ATTEMPTS` 个（默认 3）。
真的一个可用的都没有，才把「下载频率过高」报给你。

只有「下载」那几步走池子（`prepare-download` → `/down` → `api/sub/down` → 取包）：搜索、
目录、作品页直连更快，也不该拿节点额度去翻页。同一个出口会贯穿整个下载 —— 站点可能把下载
凭据和 IP 绑在一起，中途换出口只会白拿一个 403。

**出口在站点眼里是谁**：`/debug/net?exits=1` 会把每个出口挨个拿去问一次「我现在的 IP 是多少」，
`/healthz` 的 `proxy` 段则能看到几个出口、几个在冷却、各被拍过几次。被限流的日志长这样：

```
[subhd-addon] 出口 socks5://user:***@node1:1080 被站点限流：冷落 90 秒，换下一个出口
```

（日志和 `/healthz` 里只出现用户名，密码不会写出来。`SUBHD_PROXIES` 用到的 `undici` 在
本仓库的 Docker 镜像里已经装好，而且只在真配了出口池时才加载 —— 不配的话插件还是零依赖。
直接 `node src/index.js` 跑的话先 `npm install`，并且要 Node ≥ 22.19（undici 8 的要求；
镜像用的 `node:22-alpine` 满足，Vercel 上项目若是 Node 20 就先升到 22。）

### 用客户端自己那条网络出去

`SUBHD_PROXIES` 里填的也可以是**你自己开的隧道** —— 插件还在云上，但去 SubHD 的那一跳是从
你手上这台设备所在的网络出去的。换网络（家里 Wi-Fi → 蜂窝）时隧道重连，出口 IP 跟着换：

```bash
# 客户端：本地已经有一个 socks5 出口（Clash 的混合端口、ssh -D、v2ray 都行，这里假设 7890），
# 把它挂到云主机上 —— 这一步由客户端发起，所以云主机不用知道你在哪、也不用改防火墙
ssh -N -R 1080:127.0.0.1:7890 user@你的云主机

# 云主机上给插件配上这条隧道
SUBHD_PROXIES=socks5://127.0.0.1:1080
```

这样「我用什么网络访问插件，SubHD 就从什么网络出去」。几点得说清楚：

- 隧道断了插件就退回直连（也就是云主机自己的 IP），日志和 `/healthz` 都看得出出口变了 ——
  别把它当成匿名的东西用。
- 插件跑在 **Docker 里**的话注意：容器的 `127.0.0.1` 是它自己，不是宿主机。compose 里已经
  加好 `extra_hosts: host.docker.internal:host-gateway`，配合 `ssh -R 0.0.0.0:1080:…`
  （服务端 sshd 需要 `GatewayPorts clientspecified`）写成 `socks5://host.docker.internal:1080`；
  或者干脆把 compose 里的 `network_mode: host` 打开、删掉 `ports`，那 `socks5://127.0.0.1:1080` 就通了。
- 同一时刻一条隧道只对应一个出口。手机和电脑各开一条时（本地端口分开，比如 1080 / 1081），
  它们都写进 `SUBHD_PROXIES` 就是**轮着用**，而不是「谁在看我这条就发给谁」；想按设备分流
  得给每台设备一个自己的入口，这个还没做。
- 这终究是绕开站点按 IP 的限流：节点也会有被拍完的时候。真到那一步，把 `PREFETCH_NEIGHBORS`
  调小或关掉能省不少额度，别拿它去批量抓。

## 接口

插件本身就是普通 HTTP 服务，Stremio 协议之外还提供几个方便自用的接口：

| 路径 | 说明 |
| --- | --- |
| `GET /manifest.json` | Stremio 插件清单 |
| `GET /catalog/{type}/{id}.json` | 目录。每个来源各一小组：`{subhd,thunder,assrt}-movie-search` / `{subhd,thunder,assrt}-series-search`，以及 `{subhd,assrt}-movie-latest` / `{subhd,assrt}-series-latest`（迅雷没有最新接口） |
| `GET /subtitles/{type}/{id}.json` | Stremio 字幕列表（SubHD，也就是老地址） |
| `GET /subtitles/{type}/{id}.json?source=thunder` | 调试用：只看某一个来源的字幕（不写 `source` 就是三个来源合并，客户端走的也是这个） |
| `GET /thunder/{base64url(直链)}.{srt,ass,ssa,vtt,sup}` | 迅雷：服务器去 CDN 取那一份文件并转成 UTF-8 |
| `GET /assrt/{编号}.{srt,ass,ssa,vtt,sup}?lang=zh&s=季&e=集` | 射手（伪）：取回整包 → 按语言/集号挑一份 → 转 UTF-8 |
| `GET /sub/{sid}.{srt,ass,vtt,sup}?s=季&e=集` | 取字幕正文（自动解压 + 转码），可直接丢给播放器；`.sup` 是图形字幕的原文件，不做文本转换 |
| `GET /raw/{sid}` | 下载站点原始文件（可能是 zip/rar/7z） |
| `GET /api/search?q=片名&page=1[&source=thunder\|assrt]` | 网页版搜索接口（不写 `source` 就是 SubHD） |
| `GET /api/entry/{sid}` | 单条字幕详情 |
| `GET /healthz` | 健康检查（含限流冷却、出口池，以及迅雷 / 射手(伪) 最近是否连不上：`sources`） |
| `GET /debug/net` | 排障用：函数所在机房、出口 IP、各 SubHD 镜像的响应状态码与 Cloudflare 特征头；`?exits=1` 再挨个问一遍每个出口的 IP |

## 实现要点

**搜索**：`GET /search/{关键词}`，关键词可以是片名，也可以直接是 IMDb ID。返回的每一条字幕都带
作品页 ID（`/d/{id}`）、字幕 ID（`/a/{hash}`）、语言、格式、字幕组、下载量、发布时间。

**剧集按集匹配**：先用 IMDb ID 搜索拿到候选作品页，按标题里的「第 N 季」挑出对应季。搜索结果是按
热度混排的，想看的这一季经常整季都不在前两页里，这时会抓一个其它季的作品页，顺着页内的其它季链接
（`/d/{id}` 互链）找到目标季。集号以文件名里的 `S01E08` / `1x08` / `第8集` 为准；站点把整季包
挂在「第 1 集」下面，这类条目被标成「整季」，链接里带上用户正在看的 `?s=季&e=集`，解压时再按集挑
出压缩包里的那一个文件。

**下载**：SubHD 的下载要三步 ——

1. `POST /api/sub/prepare-download {sid}` → 拿到 `/down/{sid}` 与一个临时 Cookie
2. `GET /down/{sid}` → 拿到放行 Cookie
3. `POST /api/sub/down {sid}` → 拿到 CDN 直链

插件在服务端完成这三步并缓存，浏览器/Stremio 只需要访问 `/sub/{sid}.srt`。

## 已知限制

- **SubHD 有下载频率限制（按 IP）**。短时间内大量下载会被临时封禁，返回
  「下载频率过高，请稍后再试」。插件已做串行化（默认 1.5 秒一次）+ 缓存 + 冷却重试，
  被限流后还会把间隔自动翻倍放慢（见上面「SubHD 的『下载频率过高』」一节），
  但仍然建议一次试一两条字幕；自建在家庭网络里基本不会触发。
- **`.7z` 且为 LZMA 压缩**的包在 Windows 自带的 `tar.exe` 上无法解压。
  装了 7-Zip（`7z` / `7zz` 在 PATH 里）、用本仓库的 Docker 镜像、或用 Vercel 部署（自带静态 7-Zip）都可以支持。
  也可以用 `SEVEN_ZIP_PATH` 指定自定义的 7-Zip 可执行文件。
- **图形字幕（SUP / PGS）**：插件把它当一条轨道列出来（行里标注「图形字幕」），但它是图片，
  Stremio 的文本渲染器画不出来 —— 网页版 / 手机版点了不会有字幕，只有 mpv 这类播放器放得出来。
  VobSub（`.idx` + `.sub`）和 MKS 仍然不进列表。这类字幕动辄上百 MB，超过 `MAX_ARCHIVE_BYTES`
  时错误信息里会写清楚是哪个文件、多大（例如「包里的 xxx.sup（94.3MB）超过体积上限 256.0MB」）。
- **「假字幕包」**：有些条目站上标着 SUP / SRT，下载下来却是个几百字节的压缩包，里面只有一份
  网盘分享说明（百度 / 阿里云盘链接，阿里云盘不支持 `.sup`，作者会把文件改名成 `.smi` 再分享）。
  这种包挑不出任何字幕，插件就把那份说明当成一条「字幕」发出去：播放器里会把链接显示在画面上
  （时间轴铺满整部片子，中途选也能看见），同时记住这一条，之后列表里它的第二行会写成
  「只有网盘分享链接：https://…」，照着去网盘拿就行。不这么做的话用户只会觉得「点了没反应」——
  Stremio 不显示失败的响应体，后台日志用户又是看不到的。
- 站点改版会导致解析失效，解析逻辑集中在 `src/parse.js`，改起来比较方便。

## 测试

```bash
npm test
```

测试使用 `test/fixtures/` 里真实抓取的页面快照，覆盖搜索页解析、作品页解析、季集匹配、
ASS↔SRT 转换和 ZIP 解压。

## 免责声明

本项目只做「把 SubHD 已有的公开页面和下载入口包装成 Stremio 插件」这件事，
不存储、不分发任何字幕文件，所有字幕版权归原作者与片方所有，请仅用于语言学习交流。
