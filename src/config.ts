import fs from 'node:fs';
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

export interface PluginsConfig {
  plugins: string[];
  resolvedPluginPaths: string[];
}

export function getPluginsConfig(configDir: string): PluginsConfig {
  const configPath = path.join(configDir, 'config.json');

  if (!fs.existsSync(configPath)) {
    return { plugins: [], resolvedPluginPaths: [] };
  }

  let raw: string;
  try {
    raw = fs.readFileSync(configPath, 'utf-8');
  } catch {
    return { plugins: [], resolvedPluginPaths: [] };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `Failed to parse config.json at ${configPath}: ${(err as Error).message}`,
    );
  }

  const plugins = Array.isArray(parsed.plugins)
    ? (parsed.plugins as string[])
    : [];

  const resolvedPluginPaths = plugins.map((spec) => {
    if (spec.startsWith('./') || spec.startsWith('../')) {
      return path.join(configDir, spec);
    }
    return spec;
  });

  return { plugins, resolvedPluginPaths };
}

export function getClickEnhancementConfig(): ClickEnhancementConfig {
  return {
    trajectory: envBool('SITE_USE_CLICK_TRAJECTORY', true),
    jitter: envBool('SITE_USE_CLICK_JITTER', true),
    occlusionCheck: envBool('SITE_USE_CLICK_OCCLUSION', true),
  };
}

