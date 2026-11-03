// The page script AutoLogin puts into the company sign-in page (taken from AutoLogin.java), run on a copy of that
// page's form in Chromium: fills and sends once; a form that comes back only counts as a refused password when the
// page says so. node tests/autologin.test.mjs
import { createRequire } from 'node:module';
import fs from 'node:fs';
const { chromium } = createRequire(import.meta.url)('playwright');
const java = fs.readFileSync(new URL('../src/ba/polica/AutoLogin.java', import.meta.url), 'utf8');
const expr = java.slice(java.indexOf('String js = ') + 12, java.indexOf('+ JSONObject.quote(cred[0])')).trim();
const src = new Function(`return ${expr};`)(); // Java string literals joined with + are valid JS
const FORM = (err) => `<html><body>${err ? '<div class="err">The username or password is not correct.</div>' : ''}
<form id="auth_form" action="about:blank" onsubmit="window.sent=1;return false"><label>Username</label><input type="text" name="username" id="input_1">
<label>Password</label><input type="password" name="password" id="input_2"><input type="submit" value="Logon"></form></body></html>`;
const b = await chromium.launch();
const p = await b.newPage();
const run = (recent, strict) => p.evaluate(`${src}"294641","tajna",${recent},${strict})`);
let bad = 0;
const expect = (name, got, want) => { const ok = got === want; if (!ok) bad++; console.log(ok ? 'ok  ' : 'FAIL', name, got); };
await p.setContent(FORM(false));
expect('fills and sends', await run(false, false), 'sent');
expect('user filled', await p.inputValue('#input_1'), '294641');
expect('submitted', await p.evaluate('window.sent'), 1);
await p.setContent(FORM(false));
expect('form back without error: retry', await run(true, false), 'again');
await p.setContent(FORM(true));
expect('form back with error text: refused', await run(true, false), 'again-bad');
await p.setContent('<html><body><p>Hello</p></body></html>');
expect('ordinary page on system host: nothing', await run(false, true), 'none');
await b.close();
process.exit(bad ? 1 : 0);
