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
  proxySource?: string;
}

export function getConfig(): Config {
  const dataDir =
    process.env.SITE_USE_DATA_DIR || path.join(os.homedir(), '.site-use');
  const chromeProfileDir = path.join(dataDir, 'chrome-profile');

  let proxy: ProxyConfig | undefined;
  let proxySource: string | undefined;

  // Fallback chain: SITE_USE_PROXY → HTTPS_PROXY → HTTP_PROXY
  const proxyEntries: [string, string | undefined][] = [
    ['SITE_USE_PROXY', process.env.SITE_USE_PROXY],
    ['HTTPS_PROXY', process.env.HTTPS_PROXY],
    ['HTTP_PROXY', process.env.HTTP_PROXY],
  ];

  for (const [envName, envValue] of proxyEntries) {
    if (envValue) {
      proxy = { server: envValue };
      proxySource = envName;
      break;
    }
  }

  if (proxy) {
    const username = process.env.SITE_USE_PROXY_USER;
    const password = process.env.SITE_USE_PROXY_PASS;
    if (username) {
      proxy.username = username;
    }
    if (password) {
      proxy.password = password;
    }
  }

  return { dataDir, chromeProfileDir, proxy, proxySource };
}
