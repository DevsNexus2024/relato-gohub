// Gera build/icon.png (1024x1024) renderizando um SVG com o próprio Electron.
// Uso: npm run icon
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#6a5cff"/><stop offset=".55" stop-color="#3f6ff0"/><stop offset="1" stop-color="#1f47b8"/>
    </linearGradient>
    <linearGradient id="gloss" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity=".18"/><stop offset=".5" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="ok" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#34d399"/><stop offset="1" stop-color="#10a36b"/>
    </linearGradient>
    <filter id="sh" x="-30%" y="-30%" width="160%" height="160%">
      <feDropShadow dx="0" dy="18" stdDeviation="22" flood-color="#0b1440" flood-opacity=".35"/>
    </filter>
  </defs>
  <rect x="100" y="100" width="824" height="824" rx="190" fill="url(#bg)"/>
  <rect x="100" y="100" width="824" height="824" rx="190" fill="url(#gloss)"/>

  <!-- balão de relato (documento com "rabinho" de fala) -->
  <g filter="url(#sh)">
    <path fill="#ffffff" d="M322 262 H702 A72 72 0 0 1 774 334 V620 A72 72 0 0 1 702 692 H452
             L338 786 C322 799 300 788 304 768 L320 692
             A72 72 0 0 1 250 620 V334 A72 72 0 0 1 322 262 Z"/>
  </g>
  <rect x="320" y="348" width="250" height="44" rx="22" fill="#1f2a5c"/>
  <rect x="320" y="432" width="384" height="30" rx="15" fill="#cdd8f6"/>
  <rect x="320" y="494" width="330" height="30" rx="15" fill="#cdd8f6"/>
  <rect x="320" y="556" width="210" height="30" rx="15" fill="#cdd8f6"/>

  <!-- selo de concluído -->
  <g filter="url(#sh)">
    <circle cx="742" cy="296" r="104" fill="url(#ok)"/>
  </g>
  <circle cx="742" cy="296" r="104" fill="none" stroke="#ffffff" stroke-width="16"/>
  <path d="M694 298 l34 34 l64 -74" fill="none" stroke="#ffffff" stroke-width="26" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

app.whenReady().then(async () => {
  const w = new BrowserWindow({ width: 1024, height: 1024, show: false, frame: false, transparent: true,
    webPreferences: { offscreen: true } });
  await w.loadURL('data:text/html,' + encodeURIComponent(
    `<html><body style="margin:0;background:transparent">${svg}</body></html>`));
  await new Promise((r) => setTimeout(r, 400));
  const img = await w.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 });
  const out = path.join(__dirname, '..', 'build', 'icon.png');
  fs.writeFileSync(out, img.resize({ width: 1024, height: 1024 }).toPNG());
  console.log('ícone gerado em', out);
  app.quit();
});
