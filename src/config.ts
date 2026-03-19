import path from 'node:path';
import os from 'node:os';
import 'dotenv/config';

export interface ProxyConfig {
  server: string;
  username?: string;
  password?: string;
}

export interface Config {
  dataDir: string;
  chromeProfileDir: string;
  proxy?: ProxyConfig;
}

export function getConfig(): Config {
  const dataDir =
    process.env.SITE_USE_DATA_DIR || path.join(os.homedir(), '.site-use');
  const chromeProfileDir = path.join(dataDir, 'chrome-profile');

  let proxy: ProxyConfig | undefined;
  const proxyServer = process.env.SITE_USE_PROXY;
  if (proxyServer) {
    proxy = { server: proxyServer };
    const username = process.env.SITE_USE_PROXY_USER;
    const password = process.env.SITE_USE_PROXY_PASS;
    if (username) {
      proxy.username = username;
    }
    if (password) {
      proxy.password = password;
    }
  }

  return { dataDir, chromeProfileDir, proxy };
}
