import type { CheckMeta, CheckResult } from '../types.js';

export const meta: CheckMeta & { runtime: 'browser' } = {
  id: 'webrtc-leak',
  name: 'WebRTC IP leak',
  description:
    'WebRTC STUN request should not reveal a different IP than the page request',
  runtime: 'browser',
  expected: 'no leak / WebRTC disabled',
};

export async function run(): Promise<CheckResult> {
  if (typeof RTCPeerConnection === 'undefined') {
    return { pass: true, actual: 'RTCPeerConnection unavailable' };
  }

  const ips = new Set<string>();
  const TIMEOUT_MS = 5_000;

  try {
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    });

    const done = new Promise<void>((resolve) => {
      const timer = setTimeout(() => resolve(), TIMEOUT_MS);

      pc.onicecandidate = (e) => {
        if (!e.candidate) {
          clearTimeout(timer);
          resolve();
          return;
        }
        const parts = e.candidate.candidate.split(' ');
        // ICE candidate format: ... <ip> <port> ...
        // IP is at index 4
        const ip = parts[4];
        if (ip && !ip.endsWith('.local')) {
          // Include both IPv4 and IPv6 — IPv6 STUN leaks are common
          ips.add(ip);
        }
      };
    });

    pc.createDataChannel('');
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await done;
    pc.close();
  } catch {
    return { pass: true, actual: 'STUN request failed (blocked)' };
  }

  if (ips.size === 0) {
    return {
      pass: true,
      actual: 'no public IP exposed',
      detail: 'WebRTC did not reveal any public IP address',
    };
  }

  const ipList = [...ips].join(', ');
  return {
    pass: false,
    actual: ipList,
    detail:
      `WebRTC exposed ${ips.size} public IP(s) via STUN. ` +
      'Use --force-webrtc-ip-handling-policy=default_public_interface_only to mitigate.',
  };
}
