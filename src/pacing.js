// SubHD 的下载接口按出口 IP 限流，而我们这边只知道「被拍回来过」。被拍一次就把下载间隔
// 翻倍（上限 maxIntervalMs），memoryMs 之内没再被拍就减半往默认值回收。
//
// 这么做是为了两头都不亏：默认不必为了少数被限流的情况把所有人拖慢（1.5 秒一条挺跟手），
// 真撞上了又能自己退开，不用等用户去翻环境变量。
//
// 冷却窗口也是一样：站点从「拍一次」到「放开」是以分钟计的（实测点了 6 分钟还没解封），
// 而每敲一次下载接口都可能把窗口续上 —— 所以连着被拍就把冷却翻倍（90s → 3min → 6min …），
// 敲得越勤反而等得越久。超过 repeatMs 没再被拍才算「这一波过去了」，冷却从默认值重新算。
export function createPacing({
  intervalMs,
  cooldownMs = 90_000,
  maxCooldownMs = 30 * 60 * 1000,
  maxIntervalMs = 15_000,
  memoryMs = 15 * 60 * 1000,
  repeatMs = 60 * 60 * 1000,
} = {}) {
  const base = Math.max(0, Number(intervalMs) || 0);
  const baseCooldown = Math.max(0, Number(cooldownMs) || 0);
  const state = { intervalMs: base, lastHitAt: 0, hits: 0, cooldownMs: baseCooldown, cooldownUntil: 0 };

  // 现在该用多大的间隔：先看要不要「忘掉」上一次被限流
  function current(now = Date.now()) {
    if (state.hits > 0 && now - state.lastHitAt > repeatMs) {
      state.hits = 0;
      state.cooldownMs = baseCooldown;
      state.cooldownUntil = 0;
    }
    if (state.intervalMs > base && now - state.lastHitAt > memoryMs) {
      state.intervalMs = Math.max(base, Math.round(state.intervalMs / 2));
      state.lastHitAt = now;
    }
    return state.intervalMs;
  }

  // 被限流了：间隔翻倍。返回是否真的调大了（没变说明已经到顶，别再刷日志）
  function hit(now = Date.now()) {
    state.hits = now - state.lastHitAt <= repeatMs ? state.hits + 1 : 1;
    state.cooldownMs = Math.min(maxCooldownMs, baseCooldown * 2 ** (state.hits - 1));
    state.cooldownUntil = Math.max(state.cooldownUntil, now + state.cooldownMs);
    state.lastHitAt = now;
    const from = Math.max(state.intervalMs, base);
    const next = Math.min(from > 0 ? from * 2 : 1000, maxIntervalMs);
    const grew = next > state.intervalMs;
    state.intervalMs = next;
    return grew;
  }

  // 现在还要躲多久：冷却期内别去敲站点，敲了大概率是把封禁续上
  function cooldownRemaining(now = Date.now()) {
    current(now);
    return Math.max(0, state.cooldownUntil - now);
  }

  return {
    current,
    hit,
    cooldownRemaining,
    get intervalMs() {
      return state.intervalMs;
    },
    get cooldownMs() {
      return state.cooldownMs;
    },
    get hits() {
      return state.hits;
    },
  };
}
