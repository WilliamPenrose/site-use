import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface DiagnoseServer {
  port: number;
  stop(): Promise<void>;
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

/**
 * Create a local HTTP server serving the diagnose static files from dist/diagnose/.
 * Binds to 127.0.0.1 on a random port.
 */
export async function createDiagnoseServer(): Promise<DiagnoseServer> {
  // __dirname equivalent for ESM — resolves to dist/diagnose/ after compilation
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', `http://localhost`);
    let reqPath = url.pathname;

    // Default to index.html
    if (reqPath === '/') reqPath = '/index.html';

    // Path traversal prevention: resolve and ensure it stays within __dirname
    const filePath = path.resolve(path.join(__dirname, reqPath));
    if (!filePath.startsWith(path.resolve(__dirname))) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    const ext = path.extname(filePath);
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end('Not Found');
        return;
      }
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(data);
    });
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('Failed to get server address'));
        return;
      }
      resolve({
        port: addr.port,
        stop() {
          return new Promise<void>((res, rej) => {
            server.close((err) => (err ? rej(err) : res()));
          });
        },
      });
    });
  });
}
