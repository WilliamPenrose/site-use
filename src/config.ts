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

export interface ClickEnhancementConfig {
  /** Bezier curve mouse trajectory before clicking. Default: true */
  trajectory: boolean;
  /** Fix MouseEvent screenX/screenY to match real events. Default: true */
  coordFix: boolean;
  /** Random ±3px offset on click coordinates. Default: true */
  jitter: boolean;
  /** Check for element occlusion before clicking. Default: true */
  occlusionCheck: boolean;
  /** Wait for element position to stabilize (CSS animations). Default: true */
  stabilityWait: boolean;
}

function envBool(key: string, defaultValue: boolean): boolean {
  const val = process.env[key];
  if (val === undefined) return defaultValue;
  return val !== 'false' && val !== '0';
}

export function getClickEnhancementConfig(): ClickEnhancementConfig {
  return {
    trajectory: envBool('SITE_USE_CLICK_TRAJECTORY', true),
    coordFix: envBool('SITE_USE_CLICK_COORD_FIX', true),
    jitter: envBool('SITE_USE_CLICK_JITTER', true),
    occlusionCheck: envBool('SITE_USE_CLICK_OCCLUSION', true),
    stabilityWait: envBool('SITE_USE_CLICK_STABILITY', true),
  };
}

export interface ScrollEnhancementConfig {
  /** Enable humanized scrolling (step jitter + random delays). Default: true */
  humanize: boolean;
}

export function getScrollEnhancementConfig(): ScrollEnhancementConfig {
  return {
    humanize: envBool('SITE_USE_SCROLL_HUMANIZE', true),
  };
}
