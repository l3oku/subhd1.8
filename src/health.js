// 「这个来源现在还能不能用」的记账本。
//
// 为什么要它：迅雷的接口在国内很快，但从部分机房（典型是 Vercel 的 hkg1 香港节点）连过去
// 会 Connect Timeout。以前每次请求都要在那里干等满超时，客户端等不及就报「没有字幕」。
// 现在连续失败几次就先把那个来源冷落一会儿，直接跳过它 —— 过一阵再自动放回来。
import { config } from './config.js';
import { log } from './log.js';

const state = new Map();

function entry(name) {
  if (!state.has(name)) state.set(name, { failures: 0, blockedUntil: 0, lastError: '' });
  return state.get(name);
}

export function isSourceBlocked(name) {
  const item = entry(name);
  if (item.blockedUntil && item.blockedUntil > Date.now()) return true;
  if (item.blockedUntil && item.blockedUntil <= Date.now()) {
    // 冷却结束：清零，重新给机会
    item.blockedUntil = 0;
    item.failures = 0;
  }
  return false;
}

export function noteSourceSuccess(name) {
  const item = entry(name);
  item.failures = 0;
  item.blockedUntil = 0;
  item.lastError = '';
}

export function noteSourceFailure(name, error) {
  const item = entry(name);
  item.failures += 1;
  item.lastError = String(error?.message || error || '').slice(0, 200);
  if (item.failures >= config.sourceFailureThreshold) {
    item.blockedUntil = Date.now() + config.sourceCooldownMs;
    log('warn', `[${name}] 连续 ${item.failures} 次失败，先冷落 ${Math.round(config.sourceCooldownMs / 1000)} 秒：${item.lastError}`);
  }
}

export function sourcesHealth() {
  const report = {};
  for (const [name, item] of state) {
    report[name] = {
      failures: item.failures,
      blockedForMs: Math.max(0, item.blockedUntil - Date.now()),
      lastError: item.lastError || null,
    };
  }
  return report;
}

export function resetSourceHealth() {
  state.clear();
}
