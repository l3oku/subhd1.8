# 用 Cloudflare Worker 给迅雷做出口代理（可选）

## 为什么要它

迅雷的接口在国内网络很快（0.1~0.5 秒），但从**部分机房**连过去会 Connect Timeout：
Vercel 的机房就经常被卡住，表现是 `/healthz` 里 `sources.thunder.lastError` 一直报
`超时`，Stremio 里迅雷那几行时有时无。

实测对比（同一时间，同一目标 `api-shoulei-ssl.xunlei.com`）：

| 出口 | 结果 |
| --- | --- |
| Cloudflare 香港（HKG） | **5 / 5 成功**（https 0.4~1.0 秒，http 0.4~0.6 秒） |
| Vercel 机房 | 经常 Connect Timeout |

所以做法是：**项目继续跑在 Vercel，只把「迅雷」这一路的请求改走 Cloudflare**。
SubHD、射手（伪）、解压字幕包、图形字幕等等全都不变。

---

## 第一步：生成一个密钥（PROXY_SECRET）

这个密钥是你自己编的**任意一串随机字符**，不是你从 Cloudflare 哪里"拿"的。
它只干一件事：让 Worker 只接受「带着正确密钥」的请求，别人拿不到这个地址就用不了。

任选一种方式生成 32 位：

```bash
# macOS / Linux
openssl rand -hex 16        # 得到 32 位十六进制，例：9f2c7a1e4b8d3560c1e9a7b2d4f61350
```

```bash
# 任何 Linux / Alpine
head -c 24 /dev/urandom | base64 | tr -d '/+=' | head -c 32
```

```powershell
# Windows PowerShell
-join ((48..57) + (97..122) | Get-Random -Count 32 | % {[char]$_})
```

或者随手打 32 个字符合法（字母数字都行），例如 `mysubhdthunderproxy2026secretkey`。

**把它抄下来，下面 Cloudflare 和 Vercel 两处都要填同一串。**
建议用密码管理器存一份——丢了就得两边同时换新（见文末「密钥丢了怎么办」）。

---

## 第二步：部署 Worker

### 方式 A：Cloudflare 仪表盘（不需要装任何东西）

1. 打开 <https://dash.cloudflare.com/> → 左侧 **Compute (Workers)** → **Create** → **Worker**
2. 名字填 `subhd-thunder-proxy` → **Deploy** → 点 **Edit code**
3. 把本目录 `worker.js` 的全部内容粘进去，覆盖编辑器里的模板 → **Deploy**
4. 回到这个 Worker → **Settings** → **Variables and Secrets** → **Add**：
   - **Type**: `Secret`
   - **Variable name**: `PROXY_SECRET`
   - **Value**: 第一步生成的那串
   - 保存
5. **Settings → Domains & Routes**，确认 `xxxx.workers.dev` 那一行是开启的

记下你的地址，形如：

```
https://subhd-thunder-proxy.<你的子域>.workers.dev
```

（`<你的子域>` 是你在 Cloudflare 的 workers.dev 子域名，Worker 页面顶部能看到。）

### 方式 B：命令行（wrangler）

```bash
# 1) 登录
npx wrangler login

# 2) 设置密钥（会提示你粘贴第一步生成的那串，不会写进任何文件）
npx wrangler secret put PROXY_SECRET --name subhd-thunder-proxy

# 3) 部署（在这个 README 所在的目录执行）
npx wrangler deploy worker.js --name subhd-thunder-proxy --compatibility-date 2024-11-01

# 4) 确认 workers.dev 地址已开启
npx wrangler deployments list --name subhd-thunder-proxy
```

部署完成后 wrangler 会打印你的地址，同样是
`https://subhd-thunder-proxy.<你的子域>.workers.dev`。

---

## 第三步：在 Vercel 里填两条变量

Vercel 项目 → **Settings → Environment Variables** → 添加两条
（**Production 和 Preview 都勾上**）：

| Name | Value |
| --- | --- |
| `THUNDER_PROXY_URL` | `https://subhd-thunder-proxy.<你的子域>.workers.dev`（不带结尾斜杠） |
| `THUNDER_PROXY_SECRET` | 第一步生成的那串 `PROXY_SECRET` |

保存后 **Deployments → 最新一条 → Redeploy**，新变量才会生效。

> 不填这两条 = 直连迅雷，行为和以前完全一样。填错了也不会坏，只是迅雷那几行走直连。

---

## 第四步：验证

**① 先单测 Worker 本身**

```bash
curl -H "Authorization: Bearer <PROXY_SECRET>" \
  "https://subhd-thunder-proxy.<你的子域>.workers.dev/fetch?url=https%3A%2F%2Fapi-shoulei-ssl.xunlei.com%2Foracle%2Fsubtitle%3Fname%3D%25E6%25B2%2599%25E4%25B8%2598"
```

- 返回一段 `{"code":0,"data":[...]}` → Worker 正常
- 返回 `401 unauthorized` → 密钥不对（Worker 里的 `PROXY_SECRET` 和 curl 用的不一致）
- 返回 `{"error":"host not allowed"}` → 目标域名不在白名单里

响应头里还有 `x-proxy-colo`（Cloudflare 机房）、`x-proxy-ms`（耗时）方便排查。

**② 再看插件**

```
https://<你的域名>/healthz
```

看 `sources.thunder`：`lastError` 是 `null`、`blockedForMs` 是 `0` 就说明通了。
再看任意一部片的字幕列表，应该有「迅雷 ·」开头的行。

---

## 密钥丢了怎么办

两边同时换成同一串新值即可，顺序无所谓：

1. Cloudflare Worker → Settings → Variables and Secrets → 编辑 `PROXY_SECRET` → 保存
2. Vercel → Environment Variables → 编辑 `THUNDER_PROXY_SECRET` → 保存 → **Redeploy**

## 安全说明

- Worker 只允许转发这几个域名：`api-shoulei-ssl.xunlei.com`、`subtitle.v.geilijiasu.com`、
  SubHD 各镜像、`assrt.net` / `file0.assrt.net`。别的地址一律 403 —— 不会被当成免费代理用。
- **不设 `PROXY_SECRET` 时任何人不带密钥也能用**（会被人蹭），所以生产环境一定要设。
- 密钥只放在 Cloudflare 的 Secret 和 Vercel 的环境变量里，**不要写进仓库、不要截图发人**。
- 想关掉：删掉 Vercel 里的 `THUNDER_PROXY_URL`，下一次部署就回到直连。

## 顺带说明：为什么不能把整个项目搬到 Worker

项目依赖 `node:fs` / `node:http` / `node:child_process` 和仓库自带的 `7zzs`、`bsdtar`
二进制来解压字幕包（zip / rar / 7z）。Cloudflare Worker 没有文件系统、也不能运行本地程序，
SubHD 那条「下载 → 解压 → 挑文件 → 转码」的链路在 Worker 上跑不了。
真要用 Cloudflare 跑全量，得用 **Cloudflare Containers**（可以直接用本仓库的 Dockerfile）。
