import dns from 'node:dns';
import { startServer } from './server.js';

// 境外机房常见的坑：域名同时有 IPv4 / IPv6，Node 先连 IPv6，而那条路不通 —— 要卡好几秒才
// 回落到 IPv4。进程级先让 IPv4 优先（各请求里还有更细的 IPv4 优先 + 超时兜底，见 net.js / http.js）。
dns.setDefaultResultOrder('ipv4first');

startServer();
