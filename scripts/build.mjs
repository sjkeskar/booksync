import * as esbuild from 'esbuild';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const watch = process.argv.includes('--watch');
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const cfg = existsSync('config.local.json') ? JSON.parse(readFileSync('config.local.json', 'utf8')) : {};
if (!cfg.manifestKey) console.warn('WARN: no manifest key — run `npm run keygen` so the extension ID is stable.');
if (!cfg.googleClientId) console.warn('WARN: googleClientId missing in config.local.json — Google Drive sign-in will not work.');

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist', { recursive: true });
cpSync('static', 'dist', { recursive: true });

const manifest = JSON.parse(readFileSync('static/manifest.json', 'utf8'));
manifest.version = pkg.version;
if (cfg.manifestKey) manifest.key = cfg.manifestKey;
writeFileSync('dist/manifest.json', JSON.stringify(manifest, null, 2));

const buildId = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
const opts = {
  entryPoints: { background: 'src/background/sw.ts', popup: 'src/ui/popup.ts', options: 'src/ui/options.ts' },
  bundle: true,
  format: 'esm',
  target: 'chrome110',
  outdir: 'dist',
  sourcemap: 'linked',
  define: {
    __GOOGLE_CLIENT_ID__: JSON.stringify(cfg.googleClientId ?? ''),
    __VERSION__: JSON.stringify(pkg.version),
    __BUILD_ID__: JSON.stringify(buildId),
  },
  logLevel: 'info',
};
if (watch) {
  const ctx = await esbuild.context(opts);
  await ctx.watch();
} else {
  await esbuild.build(opts);
  console.log(`Built v${pkg.version} (${buildId}) → dist/`);
}
