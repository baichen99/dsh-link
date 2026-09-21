import { build } from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const root = resolve(dirname(require.resolve('@deepseek-ai/dsh-web-frontend/package.json')), 'dist');
const html = await readFile(resolve(root, 'index.html'), 'utf8');
const entry = html.match(/<script[^>]*type="module"[^>]*src="([^"]+)"/)[1];
const css = [...html.matchAll(/<link[^>]*href="([^"]+\.css)"/g)].map(match => resolve(root, match[1]));
await mkdir('dist', { recursive: true });
await build({
  stdin: { contents: ['import "./src/viewer.js";', ...css.map(path => `import ${JSON.stringify(path)};`)].join('\n'), resolveDir: process.cwd() },
  bundle: true, format: 'iife', outfile: 'dist/viewer.js', minify: true,
  alias: { '__DSH_NATIVE_ENTRY__': resolve(root, entry) },
  loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl', '.svg': 'dataurl', '.png': 'dataurl' },
  define: { 'process.env.NODE_ENV': '"production"' },
});
const client = await build({ entryPoints: ['src/client.js'], bundle: true, format: 'cjs', external: ['react'], write: false });
await writeFile('dist/client.js', `window.__ModuleLoader__.load({id:"dsh-agentlink",factory(require){const module={exports:{}};const exports=module.exports;\n${client.outputFiles[0].text}\nreturn module.exports;}});\n`);
await build({ entryPoints: ['src/browser.js'], bundle: true, format: 'esm', outfile: 'dist/browser.js', banner: { js: '// Generated from baichen99/dsh-agentlink 0.1.0 (MIT). See source repository; do not edit.' } });
