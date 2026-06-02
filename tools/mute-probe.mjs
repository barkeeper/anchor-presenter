// mute-probe.mjs — verify the speaker button mutes voice + dance music and toggles the icon.
import { chromium } from 'playwright';
const url = process.argv[2] || 'http://127.0.0.1:5173/index.html';
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--autoplay-policy=no-user-gesture-required'] });
const p = await b.newPage({ viewport: { width: 1340, height: 820 } });
const errors = [];
p.on('pageerror', (e) => errors.push('PAGEERR ' + e.message));
await p.goto(url, { waitUntil: 'load' });
await p.waitForFunction(() => !!window.__face?.playRare, undefined, { timeout: 60000 });

const glyph = () => p.evaluate(() => document.querySelector('#muteBtn .muteglyph').dataset.muted);
const out = {};
out.initial = { icon: await glyph(), muted: await p.evaluate(() => window.__diag.muted()) };
await p.click('#muteBtn');                       // -> muted
out.afterMute = { icon: await glyph(), muted: await p.evaluate(() => window.__diag.muted()) };
await p.click('#danceBtn');                       // start a dance while muted
await p.waitForTimeout(1600);                     // past the 1.2s music delay
out.danceWhileMuted = await p.evaluate(() => window.__diag.dance());
await p.click('#muteBtn');                        // -> unmuted (dance still playing)
await p.waitForTimeout(200);
out.afterUnmute = { icon: await glyph(), muted: await p.evaluate(() => window.__diag.muted()), dance: await p.evaluate(() => window.__diag.dance()) };

const report = {
  url, ...out,
  verdict: {
    iconToggles: out.initial.icon === '0' && out.afterMute.icon === '1' && out.afterUnmute.icon === '0',
    danceMutedWhenMuted: out.danceWhileMuted?.muted === true,
    danceUnmutedAfter: out.afterUnmute.dance?.muted === false,
  },
  errors,
};
console.log(JSON.stringify(report, null, 2));
await b.close();
