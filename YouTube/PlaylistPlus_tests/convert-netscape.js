/**
 * Convert a Netscape-format cookie jar (the kind yt-dlp exports) into
 * Playwright's storageState JSON. Run once:
 *   node convert-netscape.js <netscape.txt> [out.json]
 *
 * Default out: .auth/youtube.json
 */
const fs = require('node:fs');
const path = require('node:path');

const src = process.argv[2];
const out = process.argv[3] || path.resolve(__dirname, '.auth/youtube.json');

if (!src || !fs.existsSync(src)) {
  console.error('usage: node convert-netscape.js <netscape-cookies.txt> [out.json]');
  process.exit(1);
}

// Cookies the userscript reads from document.cookie (must be non-HttpOnly
// so the in-page JS can access them). Everything else we mark HttpOnly,
// which doesn't affect whether the cookie is sent on requests.
const NON_HTTPONLY = new Set([
  'SAPISID',
  '__Secure-3PAPISID',
  '__Secure-1PAPISID',
  'YSC',
  'VISITOR_INFO1_LIVE',
  'VISITOR_PRIVACY_METADATA',
  'PREF',
]);

const lines = fs.readFileSync(src, 'utf8').split(/\r?\n/);
const cookies = [];
for (let raw of lines) {
  if (!raw) continue;
  let httpOnly = false;
  if (raw.startsWith('#HttpOnly_')) {
    httpOnly = true;
    raw = raw.slice('#HttpOnly_'.length);
  } else if (raw.startsWith('#')) {
    continue;
  }
  const fields = raw.split('\t');
  if (fields.length < 7) continue;
  const [domain, , cookiePath, secureFlag, expires, name, ...rest] = fields;
  const value = rest.join('\t'); // tolerate tabs in values (unlikely)

  cookies.push({
    name,
    value,
    domain,
    path: cookiePath,
    expires: parseInt(expires, 10) || -1,
    httpOnly: httpOnly || (NON_HTTPONLY.has(name) ? false : true),
    secure: secureFlag === 'TRUE',
    sameSite: name.startsWith('__Secure-3P') ? 'None' : 'Lax',
  });
}

// Override: for the critical JS-read names, force httpOnly false regardless
// of the Netscape export's hint.
for (const c of cookies) {
  if (NON_HTTPONLY.has(c.name)) c.httpOnly = false;
}

const storageState = { cookies, origins: [] };

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(storageState, null, 2));

console.log(`wrote ${cookies.length} cookies → ${out}`);
const critical = ['SAPISID', '__Secure-3PAPISID', 'SID', 'HSID', 'SSID'];
for (const n of critical) {
  const hit = cookies.find((c) => c.name === n);
  console.log(`  ${hit ? '✓' : '✗'} ${n}`);
}
