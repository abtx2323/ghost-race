// Bundles the app into one self-contained HTML file (fonts, styles and scripts
// inlined) at dist/ghost-race.html. Handy for sharing a single offline file.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

let css = read('css/ghost-race.css').replace(/url\("\.\.\/fonts\/([^"]+)"\)/g, (_, f) => {
  const b64 = readFileSync(join(root, 'fonts', f)).toString('base64');
  return `url("data:font/woff;base64,${b64}")`;
});

let html = read('index.html');
// The bundle inlines its scripts and styles, so the page's strict CSP can't
// apply as written. Hosts that serve the bundle (like a Claude artifact) set
// their own policy, so drop the meta tag here.
html = html.replace(/\s*<!-- No network access[^>]*-->\s*<meta http-equiv="Content-Security-Policy"[^>]*>/, '');
html = html.replace('<link rel="stylesheet" href="css/ghost-race.css">', () => `<style>\n${css}\n</style>`);
html = html.replace(/<script src="(src\/[^"]+)"><\/script>/g, (_, src) => `<script>\n${read(src).replace(/<\/script/gi, '<\\/script')}\n</script>`);

mkdirSync(join(root, 'dist'), { recursive: true });
writeFileSync(join(root, 'dist', 'ghost-race.html'), html);
console.log('wrote dist/ghost-race.html', Math.round(html.length / 1024) + ' KB');

