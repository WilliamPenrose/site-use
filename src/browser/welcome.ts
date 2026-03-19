import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import snarkdown from 'snarkdown';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WELCOME_MD = path.join(__dirname, '..', '..', 'docs', 'welcome', 'welcome.md');

/** Read docs/welcome/welcome.md and render to a full HTML page. */
export function buildWelcomeHTML(): string {
  const md = readFileSync(WELCOME_MD, 'utf-8');
  const body = snarkdown(md);
  return wrapHTML(body);
}

function wrapHTML(body: string): string {
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>site-use</title>
<style>
  :root { --bg: #0f1117; --fg: #e6edf3; --muted: #8b949e; --accent: #58a6ff; --border: #30363d; --card: #161b22; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
         background: var(--bg); color: var(--fg); line-height: 1.6; padding: 60px 24px; }
  .container { max-width: 720px; margin: 0 auto; }
  h1 { font-size: 2rem; margin-bottom: 8px; color: var(--accent); }
  h2 { font-size: 1.2rem; margin: 32px 0 12px; color: var(--accent); }
  p { margin: 8px 0; }
  ol, ul { margin: 8px 0 8px 24px; }
  li { margin: 6px 0; }
  code { background: var(--card); border: 1px solid var(--border); padding: 2px 6px; border-radius: 4px; font-size: 0.85rem; }
  pre { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 16px; margin: 12px 0; overflow-x: auto; }
  pre code { border: none; padding: 0; }
  strong { color: var(--fg); }
  em { color: var(--muted); }
  hr { border: none; border-top: 1px solid var(--border); margin: 32px 0; }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
</style>
</head>
<body>
<div class="container">
${body}
</div>
</body>
</html>`;
}
