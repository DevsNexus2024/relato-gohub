// Ferramenta de desenvolvimento: só é carregada quando RELATO_INSPECT_DIR está
// definido. A cada tela aberta no GoHub, salva screenshot, estrutura do HTML,
// tamanhos de fonte, containers com largura limitada e o CSS do site, para
// servir de base ao visual em src/skins/.
const fs = require('fs');
const path = require('path');

const COLLECT = `(() => {
  const outline = (el, d) => {
    if (d > 14) return '';
    let o = '';
    for (const c of el.children) {
      if (['SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT', 'path', 'g', 'defs'].includes(c.tagName)) continue;
      const cls = (typeof c.className === 'string' ? c.className : (c.getAttribute('class') || '')).trim().slice(0, 220);
      const txt = c.children.length ? '' : (c.textContent || '').trim().slice(0, 30);
      const attrs = ['role', 'type', 'data-state', 'aria-label', 'data-slot'].map((a) => (c.getAttribute(a) ? '[' + a + '=' + c.getAttribute(a).slice(0, 24) + ']' : '')).join('');
      o += '  '.repeat(d) + c.tagName.toLowerCase() + (c.id ? '#' + c.id : '') + attrs + (cls ? ' .' + cls.replace(/\\s+/g, '.') : '') + (txt ? '  "' + txt + '"' : '') + '\\n';
      o += outline(c, d + 1);
    }
    return o;
  };
  const fonts = {};
  for (const el of document.body.querySelectorAll('*')) {
    if (!el.childNodes.length || ![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
    const fs = getComputedStyle(el).fontSize;
    fonts[fs] = (fonts[fs] || 0) + 1;
  }
  const limited = [];
  for (const el of document.body.querySelectorAll('div, main, section, form, header')) {
    const st = getComputedStyle(el);
    if (st.maxWidth !== 'none' && el.offsetWidth > 300) {
      limited.push({ tag: el.tagName.toLowerCase(), cls: String(el.className).slice(0, 200), maxWidth: st.maxWidth, width: el.offsetWidth, margin: st.margin });
    }
  }
  let css = '';
  for (const sh of document.styleSheets) {
    try { for (const r of sh.cssRules) css += r.cssText + '\\n'; } catch (e) { css += '/* cross-origin: ' + sh.href + ' */\\n'; }
  }
  const rootVars = {};
  const cs = getComputedStyle(document.documentElement);
  for (let i = 0; i < cs.length; i++) { const p = cs[i]; if (p.startsWith('--')) rootVars[p] = cs.getPropertyValue(p).trim(); }
  return {
    url: location.href,
    title: document.title,
    viewport: innerWidth + 'x' + innerHeight,
    htmlClass: document.documentElement.className,
    htmlAttrs: [...document.documentElement.attributes].map((a) => a.name + '=' + a.value).join(' '),
    bodyClass: document.body.className,
    bodyFont: getComputedStyle(document.body).fontFamily + ' ' + getComputedStyle(document.body).fontSize,
    fonts,
    limited: limited.slice(0, 40),
    rootVars,
    sheets: [...document.styleSheets].map((s) => s.href || 'inline'),
    outline: outline(document.body, 0),
    css,
  };
})()`;

module.exports = function inspect(site, wc, dir, api = {}) {
  if (!site.skin) return;
  fs.mkdirSync(dir, { recursive: true });
  let n = 0;
  let timer = null;
  const onHost = () => { try { return new URL(wc.getURL()).hostname === site.skin.host; } catch { return false; } };
  // Print feito numa janela invisível (offscreen) com a mesma sessão, para
  // funcionar mesmo com a janela do app encoberta e sem mexer na tela do usuário.
  let shotUrl = null;
  const shot = async (name, url) => {
    const { BrowserWindow } = require('electron');
    const w = new BrowserWindow({
      width: 1600, height: 1000, show: false,
      webPreferences: { offscreen: true, partition: wc.session === undefined ? undefined : 'persist:workspace', sandbox: true },
    });
    try {
      w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      await w.loadURL(url || shotUrl || wc.getURL());
      await new Promise((r) => setTimeout(r, 3500));
      if (api.skinCss) {
        const css = api.skinCss();
        if (css.base) await w.webContents.insertCSS(css.base);
        if (css.dark) await w.webContents.insertCSS(css.dark);
        await new Promise((r) => setTimeout(r, 700));
      }
      if (api.prep) await w.webContents.executeJavaScript(api.prep).catch(() => {});
      const full = await w.webContents.executeJavaScript('Math.min(document.querySelector(".main-content") ? document.querySelector(".main-content").scrollHeight : document.body.scrollHeight, 3000)');
      w.setContentSize(1600, Math.max(1000, full));
      await new Promise((r) => setTimeout(r, 600));
      fs.writeFileSync(path.join(dir, `${name}.png`), (await w.webContents.capturePage()).toPNG());
      console.log('[inspect] print', name);
    } finally {
      w.destroy();
    }
  };
  const capture = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      try {
        if (!onHost()) return;
        const data = await wc.executeJavaScript(COLLECT);
        n += 1;
        const slug = `${String(n).padStart(2, '0')}-${new URL(data.url).pathname.replace(/[^a-z0-9]+/gi, '_').slice(0, 40) || 'root'}`;
        const { outline, css, ...meta } = data;
        fs.writeFileSync(path.join(dir, `${slug}.json`), JSON.stringify(meta, null, 2));
        fs.writeFileSync(path.join(dir, `${slug}.outline.txt`), outline);
        fs.writeFileSync(path.join(dir, 'site.css'), css);
        await shot(slug).catch((e) => console.error('[inspect] print', e.message));
      } catch (err) {
        console.error('[inspect]', err.message);
      }
    }, 3000);
  };
  wc.on('did-finish-load', capture);
  wc.on('did-navigate-in-page', capture);

  // Recarrega o visual automaticamente quando os arquivos de src/skins mudam.
  const skinsDir = path.join(__dirname, '..', 'src', 'skins');
  let reloadTimer = null;
  fs.watch(skinsDir, () => {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(async () => {
      if (!api.reapplySkin) return;
      await api.reapplySkin();
      shot('live').catch((e) => console.error('[inspect] print', e.message));
    }, 300);
  });

  // Comandos de desenvolvimento: escreva no arquivo <dir>/cmd.txt, uma linha:
  //   goto /caminho | theme dark|light | skin on|off | shot nome | eval <js>
  const cmdFile = path.join(dir, 'cmd.txt');
  fs.writeFileSync(cmdFile, '');
  fs.watchFile(cmdFile, { interval: 400 }, async () => {
    const line = fs.readFileSync(cmdFile, 'utf8').trim();
    if (!line) return;
    fs.writeFileSync(cmdFile, '');
    const [cmd, ...rest] = line.split(' ');
    const arg = rest.join(' ');
    try {
      if (cmd === 'goto') wc.loadURL(new URL(arg, `https://${site.skin.host}`).href);
      else if (cmd === 'theme') api.setSkinPrefs({ skinTheme: arg });
      else if (cmd === 'skin') api.setSkinPrefs({ skinEnabled: arg === 'on' });
      else if (cmd === 'shot') { const [nm, u] = arg.split(' '); await shot(nm || 'shot', u ? new URL(u, `https://${site.skin.host}`).href : undefined); }
      else if (cmd === 'url') shotUrl = arg ? new URL(arg, `https://${site.skin.host}`).href : null;
      else if (cmd === 'eval') {
        const out = await wc.executeJavaScript(arg);
        fs.writeFileSync(path.join(dir, 'eval.json'), JSON.stringify(out, null, 2));
        console.log('[inspect] eval ok');
      }
    } catch (err) {
      fs.writeFileSync(path.join(dir, 'eval.json'), JSON.stringify({ error: err.message }));
      console.error('[inspect] cmd', err.message);
    }
  });
};
