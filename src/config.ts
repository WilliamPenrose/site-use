import path from 'node:path';
import os from 'node:os';
import 'dotenv/config';

export interface ProxyConfig {
  server: string;
  username?: string;
  password?: string;
}

export type WebRTCPolicy =
  | 'disable_non_proxied_udp'
  | 'default_public_interface_only'
  | 'off';

export interface Config {
  dataDir: string;
  chromeProfileDir: string;
  chromeJsonPath: string;
  proxy?: ProxyConfig;
  proxySource?: string;
  webrtcPolicy: WebRTCPolicy;
}

export function getConfig(): Config {
  const dataDir =
    process.env.SITE_USE_DATA_DIR || path.join(os.homedir(), '.site-use');
  const chromeProfileDir = path.join(dataDir, 'chrome-profile');
  const chromeJsonPath = path.join(dataDir, 'chrome.json');

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

  const rawPolicy = process.env.SITE_USE_WEBRTC_POLICY ?? 'disable_non_proxied_udp';
  const webrtcPolicy: WebRTCPolicy =
    rawPolicy === 'default_public_interface_only' || rawPolicy === 'off'
      ? rawPolicy
      : 'disable_non_proxied_udp';

  return { dataDir, chromeProfileDir, chromeJsonPath, proxy, proxySource, webrtcPolicy };
}

export interface ClickEnhancementConfig {
  /** Bezier curve mouse trajectory before clicking. Default: true */
  trajectory: boolean;
  /** Random ±3px offset on click coordinates. Default: true */
  jitter: boolean;
  /** Check for element occlusion before clicking. Default: true */
  occlusionCheck: boolean;
}

function envBool(key: string, defaultValue: boolean): boolean {
  const val = process.env[key];
  if (val === undefined) return defaultValue;
  return val !== 'false' && val !== '0';
}

export function getClickEnhancementConfig(): ClickEnhancementConfig {
  return {
    trajectory: envBool('SITE_USE_CLICK_TRAJECTORY', true),
    jitter: envBool('SITE_USE_CLICK_JITTER', true),
    occlusionCheck: envBool('SITE_USE_CLICK_OCCLUSION', true),
  };
}

