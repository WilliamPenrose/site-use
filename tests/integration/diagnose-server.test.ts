import { describe, it, expect } from 'vitest';
// Import from dist/ because the server resolves static files relative to
// import.meta.url — checks.js only exists in dist/diagnose/ after build.
import { createDiagnoseServer } from '../../dist/diagnose/server.js';

describe('diagnose HTTP server', () => {
  it('starts on random port and serves index.html', async () => {
    const server = await createDiagnoseServer();
    try {
      expect(server.port).toBeGreaterThan(0);
      const res = await fetch(`http://localhost:${server.port}/`);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('Anti-Detection Diagnostic');
    } finally {
      await server.stop();
    }
  });

  it('serves checks.js', async () => {
    const server = await createDiagnoseServer();
    try {
      const res = await fetch(`http://localhost:${server.port}/checks.js`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('javascript');
    } finally {
      await server.stop();
    }
  });

  it('returns 404 for unknown paths', async () => {
    const server = await createDiagnoseServer();
    try {
      const res = await fetch(`http://localhost:${server.port}/nope`);
      expect(res.status).toBe(404);
    } finally {
      await server.stop();
    }
  });
});
