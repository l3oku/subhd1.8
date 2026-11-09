# 给「迅雷」加一个 Cloudflare 出口代理

> **为什么要它**：迅雷接口在国内网络很快（0.1~0.5 秒），但从部分机房连过去会 Connect Timeout。
> 实测同一时刻，Cloudflare 香港节点 **5/5 成功（0.4~1.0 秒）**，Vercel 机房经常超时。
> 所以做法是：**插件继续跑在 Vercel，只把「迅雷」这一路的请求改从 Cloudflare 出去**。
> SubHD、射手（伪）、解压字幕包这些都不变。

---

# ① 你需要的那一串密码：`PROXY_SECRET`

**它不是从 Cloudflare 哪里"拿"的，是你自己生成的一串随机字符。**
作用：让 Worker 只接受「带着正确钥匙」的请求，别人拿到地址也用不了你的额度。

生成 32 位，任选一条：

```bash
# macOS / Linux（最省事）
openssl rand -hex 16
# → 9f2c7a1e4b8d3560c1e9a7b2d4f61350

# 没有 openssl 的 Linux / Alpine
head -c 24 /dev/urandom | base64 | tr -d '/+=' | head -c 32
```

```powershell
# Windows PowerShell
-join ((48..57) + (97..122) | Get-Random -Count 32 | % {[char]$_})
```

也可以随手打 32 个字母数字（如 `mysubhdthunder2026secretkey123abc`）。

> ⚠️ **把这串抄下来。** 下面 Cloudflare 和 Vercel 两处都要填**同一串**，少一处就 401。

---

# ② 部署 Worker（三种方式，任选一种）

## 方式 A：一键部署按钮

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/l3oku/subhd1.8/tree/main/tools/cf-proxy)

点按钮后 Cloudflare 会让你登录并把这份代码复制到你自己的 GitHub 账号下，然后进入配置页：

1. **Worker 名称**：默认 `subhd-thunder-proxy`，不用改
2. **`PROXY_SECRET`**：粘贴第 ① 步生成的那串（配置页上会有这段说明）
3. 点 **Deploy**

几十秒后给你一个地址：

```
https://subhd-thunder-proxy.<你的子域>.workers.dev
```

> 如果按钮提示仓库不存在或无法访问，说明按钮指向的仓库还是私有的，
> 用下面的方式 B 或 C 手动部署，效果一样。

## 方式 B：Cloudflare 仪表盘（不需要装工具）

1. <https://dash.cloudflare.com/> → 左侧 **Compute (Workers)** → **Create** → **Worker**
2. 名字填 `subhd-thunder-proxy` → **Deploy** → 点 **Edit code**
3. 把本目录 `index.js` 的全部内容粘进去 → **Deploy**
4. 回到 Worker → **Settings** → **Variables and Secrets** → **Add**
   - **Type**: `Secret`
   - **Name**: `PROXY_SECRET`
   - **Value**: 第 ① 步那串
5. **Settings → Domains & Routes** 确认 `xxxx.workers.dev` 那一行是开启的

## 方式 C：命令行（wrangler）

```bash
cd tools/cf-proxy
npm install                 # 装 wrangler
npx wrangler login          # 浏览器一次性登录
npx wrangler secret put PROXY_SECRET   # 粘贴第 ① 步那串
npx wrangler deploy         # 用本目录的 wrangler.toml
```

部署成功会打印你的地址，同样是 `https://subhd-thunder-proxy.<你的子域>.workers.dev`。

---

# ③ 回到 Vercel 填两条变量

Vercel 项目 → **Settings → Environment Variables**，添加（**Production 和 Preview 都勾**）：

| Name | Value |
| --- | --- |
| `THUNDER_PROXY_URL` | `https://subhd-thunder-proxy.<你的子域>.workers.dev`（结尾不要斜杠） |
| `THUNDER_PROXY_SECRET` | 第 ① 步那串 `PROXY_SECRET`，**一模一样** |

保存后 → **Deployments → 最新一条 → Redeploy**，新变量才生效。

> 不填这两条 = 直连迅雷，行为和以前完全一样，不会出错。

---

# ④ 验证

**先单测 Worker 本身：**

```bash
curl -H "Authorization: Bearer <PROXY_SECRET>" \
  "https://subhd-thunder-proxy.<你的子域>.workers.dev/fetch?url=https%3A%2F%2Fapi-shoulei-ssl.xunlei.com%2Foracle%2Fsubtitle%3Fname%3D%25E6%25B2%2599%25E4%25B8%2598"
```

| 返回 | 含义 |
| --- | --- |
| `{"code":0,"data":[...]}` | ✅ Worker 正常 |
| `{"error":"unauthorized"}` | ❌ 密钥不一致（Worker 里的 `PROXY_SECRET` ≠ curl 用的） |
| `{"error":"host not allowed"}` | ❌ 目标域名不在白名单（见下方安全说明） |
| `401` / 超时 | Worker 没部署成功，或地址写错 |

响应头里的 `x-proxy-colo`（Cloudflare 机房）、`x-proxy-ms`（耗时）可以帮你看速度。

**再看插件：** 打开 `https://<你的域名>/healthz`，看 `sources.thunder`：

```json
"thunder": { "failures": 0, "blockedForMs": 0, "lastError": null }
```

三项都正常，就说明迅雷这一路通了。

---

# 常见问题

**Q：密钥丢了 / 想换新的？**
两边同时换成同一串新值，顺序无所谓：

1. Cloudflare Worker → Settings → Variables and Secrets → 编辑 `PROXY_SECRET`
2. Vercel → Environment Variables → 编辑 `THUNDER_PROXY_SECRET` → **Redeploy**

**Q：不设 `PROXY_SECRET` 行不行？**
行，但**任何人不带密钥都能用你的 Worker**（等于给别人白嫖流量），生产环境一定要设。

**Q：想彻底关掉？**
删掉 Vercel 里的 `THUNDER_PROXY_URL`，重新部署就回到直连。

**Q：能不能把整个插件都搬到 Worker？**
不行。插件依赖 `node:fs` / `node:child_process` 和仓库自带的 `7zzs`、`bsdtar` 来解压字幕包
（zip/rar/7z），Worker 没有文件系统、也不能跑本地程序。真要用 Cloudflare 跑全量，得用
**Cloudflare Containers**（可以直接用仓库根的 Dockerfile）。

---

# 本目录文件说明

| 文件 | 作用 |
| --- | --- |
| `index.js` | Worker 本体（唯一需要部署的代码） |
| `wrangler.toml` | Cloudflare 部署配置（名字 / 入口 / 兼容日期） |
| `package.json` | 含 `cloudflare.bindings`，**部署页面上关于 `PROXY_SECRET` 的说明就是这里来的** |
| `.dev.vars.example` | 本地调试用的密钥模板（复制成 `.dev.vars`，别提交） |

## 安全说明

- Worker 只转发这几个域名：`api-shoulei-ssl.xunlei.com`、`subtitle.v.geilijiasu.com`、
  SubHD 各镜像、`assrt.net` / `file0.assrt.net`。**别的地址一律 403**，不会被当成免费代理。
- 密钥只放在 Cloudflare 的 Secret 和 Vercel 的环境变量里，**不要写进仓库、不要截图外发**。
