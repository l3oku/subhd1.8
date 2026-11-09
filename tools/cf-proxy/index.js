// Cloudflare Worker：迅雷出口代理
//
// 解决的问题：Vercel 的机房（新加坡 / 东京等）连迅雷接口经常 Connect Timeout，
// 而 Cloudflare 香港节点实测很稳（5/5 成功，0.4~1 秒）。这个 Worker 只做一件事：
// 把请求从 Cloudflare 网络发出去，再把结果原样带回。
//
// 用法：GET /fetch?url=<encodeURIComponent(目标地址)>
//   请求头：Authorization: Bearer <PROXY_SECRET>（在 Worker 的环境变量里设置）
//   返回：目标站的状态码 + 正文；在响应头里带 x-proxy-upstream / x-proxy-ms 方便排查
//
// 白名单：只允许转发下面这些域名，别的地址一律拒绝 —— 免得这个 Worker 被人拿去当免费代理。
// 部署：见 tools/cf-proxy/README.md（一条命令，或直接在 Cloudflare 仪表盘粘贴本文件）。

const ALLOWED_HOSTS = [
  'api-shoulei-ssl.xunlei.com',
  'subtitle.v.geilijiasu.com',
  'subhd.tv', 'subhd.me', 'subhd.one', 'subhd.top', 'subhd.cc', 'subhd.com',
  'assrt.net', '2.assrt.net', 'file0.assrt.net',
];

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...CORS },
  });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    if (url.pathname === '/' || url.pathname === '/health') {
      return json({ ok: true, service: 'subhd-thunder-proxy', allowed: ALLOWED_HOSTS });
    }

    if (url.pathname !== '/fetch') return json({ error: 'not found' }, 404);

    // 鉴权：设置了 PROXY_SECRET 就必须带对
    if (env.PROXY_SECRET) {
      const auth = request.headers.get('authorization') || '';
      if (auth !== `Bearer ${env.PROXY_SECRET}`) return json({ error: 'unauthorized' }, 401);
    }

    const target = url.searchParams.get('url');
    if (!target) return json({ error: 'missing url' }, 400);

    let parsed;
    try {
      parsed = new URL(target);
    } catch {
      return json({ error: 'invalid url' }, 400);
    }
    if (!ALLOWED_HOSTS.includes(parsed.hostname)) {
      return json({ error: 'host not allowed', host: parsed.hostname }, 403);
    }

    const started = Date.now();
    try {
      const upstream = await fetch(parsed.toString(), {
        method: 'GET',
        redirect: 'follow',
        headers: {
          'user-agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          accept: request.headers.get('accept') || '*/*',
          'accept-language': 'zh-CN,zh;q=0.9,en;q=0.6',
          referer: `https://${parsed.hostname}/`,
        },
      });
      const buffer = await upstream.arrayBuffer();
      return new Response(buffer, {
        status: upstream.status,
        headers: {
          'content-type': upstream.headers.get('content-type') || 'application/octet-stream',
          'cache-control': 'no-store',
          'x-proxy-upstream': String(upstream.status),
          'x-proxy-ms': String(Date.now() - started),
          'x-proxy-colo': request.cf?.colo || '',
          ...CORS,
        },
      });
    } catch (error) {
      return json({ error: String(error?.message || error), ms: Date.now() - started }, 502);
    }
  },
};
