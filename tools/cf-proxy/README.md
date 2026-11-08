# 用 Cloudflare Worker 给迅雷做出口代理（可选）

## 为什么要它

迅雷的接口在国内网络很快（0.1~0.5 秒），但从**部分机房**连过去会 Connect Timeout：
Vercel 的新加坡 / 东京节点就经常被卡住，表现是 `/healthz` 里 `sources.thunder.lastError`
一直报 `超时`，Stremio 里迅雷那几行时有时无。

实测对比（同一时间，同一目标 `api-shoulei-ssl.xunlei.com`）：

| 出口 | 结果 |
| --- | --- |
| Cloudflare 香港（HKG） | **5 / 5 成功**（https 0.4~1.0 秒，http 0.4~0.6 秒） |
| Vercel 机房 | 经常 Connect Timeout |

所以做法是：**项目继续跑在 Vercel，只把「迅雷」这一路的请求改走 Cloudflare**。
SubHD、射手（伪）、解压字幕包、图形字幕等等全都不变。

## 部署这个 Worker（1 分钟）

### 方式 A：Cloudflare 仪表盘

1. 打开 <https://dash.cloudflare.com/> → **Workers & Pages** → **Create** → **Worker**
2. 名字随便（例如 `subhd-thunder-proxy`），**Deploy** 之后点 **Edit code**
3. 把本目录的 `worker.js` 内容整个粘进去 → **Deploy**
4. 回到 Worker 页面 → **Settings** → **Variables and Secrets** → 添加：
   - 类型 **Secret**，名字 `PROXY_SECRET`，值随便一串 32 位随机字符（**记下来，Vercel 要用**）
5. 确认 **Settings → Domains & Routes** 里已经开启了 `xxxx.workers.dev` 子域

你的代理地址就是：`https://subhd-thunder-proxy.<你的子域>.workers.dev`

### 方式 B：命令行

```bash
# 一次性设置密钥（别把它提交进仓库）
npx wrangler secret put PROXY_SECRET --name subhd-thunder-proxy

npx wrangler deploy tools/cf-proxy/worker.js --name subhd-thunder-proxy \
  --compatibility-date 2024-11-01
```

## 在 Vercel 里打开它

项目 → **Settings → Environment Variables**，加两条（Production / Preview 都勾上）：

| 变量 | 值 |
| --- | --- |
| `THUNDER_PROXY_URL` | `https://subhd-thunder-proxy.<你的子域>.workers.dev` |
| `THUNDER_PROXY_SECRET` | 刚才设置的那串 `PROXY_SECRET` |

然后 **Redeploy**。不配这两条就还是直连迅雷，行为与之前完全一样。

## 验证

```
https://<你的域名>/healthz
```

`sources.thunder.lastError` 是 `null`、`blockedForMs` 是 `0` 就说明通了。
单测一个地址：

```bash
curl -H "Authorization: Bearer <PROXY_SECRET>" \
  "https://subhd-thunder-proxy.<子域>.workers.dev/fetch?url=https%3A%2F%2Fapi-shoulei-ssl.xunlei.com%2Foracle%2Fsubtitle%3Fname%3D%25E6%25B2%2599%25E4%25B8%2598"
```

## 安全说明

- Worker 只允许转发这几个域名：`api-shoulei-ssl.xunlei.com`、`subtitle.v.geilijiasu.com`、
  SubHD 各镜像、`assrt.net` / `file0.assrt.net`，**别的地址一律拒绝** —— 不会被当成免费代理用。
- 没设 `PROXY_SECRET` 时任何人不带密钥也能用（容易被人蹭），所以生产环境务必设置。
- 密钥只放在 Cloudflare 的 Secret 和 Vercel 的环境变量里，不要写进仓库或截图。
- 想关掉：删掉 Vercel 里的 `THUNDER_PROXY_URL` 即可，下一次部署就回到直连。

## 顺带说明：为什么不能把整个项目搬到 Worker

项目依赖 `node:fs` / `node:http` / `node:child_process` 和仓库自带的
`7zzs`、`bsdtar` 二进制来解压字幕包（zip / rar / 7z）。Cloudflare Worker 没有文件系统、
也不能运行本地程序，SubHD 那条「下载 → 解压 → 挑文件 → 转码」的链路在 Worker 上跑不了。
真要用 Cloudflare 跑全量，得用 **Cloudflare Containers**（可以直接用本仓库的 Dockerfile）。
