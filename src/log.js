import { config } from './config.js';

// 一行日志，前缀和 server.js 保持一致，方便 `docker logs | grep subhd-addon`
export function log(...args) {
  if (config.logLevel === 'silent') return;
  console.log('[subhd-addon]', ...args);
}
