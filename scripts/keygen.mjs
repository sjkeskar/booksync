// Generates a stable extension key so the extension ID is identical on every PC.
// Writes extension-key.pem (keep private, do not commit) and config.local.json (manifest key + id).
import { generateKeyPairSync, createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const CONFIG = 'config.local.json';
const cfg = existsSync(CONFIG) ? JSON.parse(readFileSync(CONFIG, 'utf8')) : {};
if (cfg.manifestKey && !process.argv.includes('--force')) {
  console.log(`Key already exists. Extension ID: ${cfg.extensionId}  (use --force to regenerate)`);
  process.exit(0);
}
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const der = publicKey.export({ type: 'spki', format: 'der' });
const hex = createHash('sha256').update(der).digest('hex').slice(0, 32);
const extensionId = [...hex].map((h) => String.fromCharCode(97 + parseInt(h, 16))).join('');
writeFileSync('extension-key.pem', privateKey.export({ type: 'pkcs8', format: 'pem' }));
cfg.manifestKey = der.toString('base64');
cfg.extensionId = extensionId;
cfg.googleClientId ??= '';
writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + '\n');
console.log(`Extension ID: ${extensionId}`);
console.log(`OAuth redirect URI: https://${extensionId}.chromiumapp.org/`);
