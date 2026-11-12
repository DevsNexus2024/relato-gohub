'use strict';

const {
  app, BrowserWindow, WebContentsView, session, ipcMain, shell, Menu, dialog, nativeTheme,
} = require('electron');
const path = require('path');
const fs = require('fs');

// ---------------------------------------------------------------------------
// Configuração — edite aqui para trocar/adicionar sites
// ---------------------------------------------------------------------------
const SITES = [
  {
    id: 'gohub',
    name: 'GoHub',
    url: 'https://gohub.goritektools.com/',
    // Visual próprio aplicado por cima do site (src/skins). Pode ser desligado
    // no menu Exibir caso o site mude e algo fique estranho.
    skin: {
      host: 'gohub.goritektools.com',
      base: ['gohub.gen.css', 'gohub.css'],
      dark: ['gohub-dark.gen.css', 'gohub-dark.css'],
    },
  },
  {
    id: 'gmail',
    name: 'Gmail',
    url: 'https://mail.google.com/mail/u/0/#inbox',
    // Sem login, o Google às vezes manda para uma página de propaganda do Gmail.
    // Nesse caso vamos direto para a tela de login, na própria aba.
    signedOutPage: (u) => u.hostname === 'workspace.google.com' && /gmail/i.test(u.pathname),
    loginUrl: 'https://accounts.google.com/ServiceLogin?service=mail&passive=true&continue=https%3A%2F%2Fmail.google.com%2Fmail%2Fu%2F0%2F',
  },
];
const NOTES_TAB = { id: 'notes', name: 'Notas' };

// Uma única partição persistente para todas as abas: o login Google feito em
// uma aba vale para a outra, e os cookies ficam salvos em disco.
const PARTITION = 'persist:workspace';
const SIDEBAR_WIDTH = 44;
// Cookies de sessão (sem data de expiração) são convertidos em persistentes
// com essa validade, para não precisar logar de novo a cada abertura.
const SESSION_COOKIE_DAYS = 30;

const isMac = process.platform === 'darwin';
const APP_ID = 'internal.relato.app';
// Ícone usado ao rodar em desenvolvimento (npm start). No app compilado o
// ícone vem do próprio executável/pacote.
const DEV_ICON = path.join(__dirname, '..', 'build', 'icon.png');

// ---------------------------------------------------------------------------
// User-Agent: o Google bloqueia login em navegadores "embutidos" que se
// identificam como Electron. Usamos o UA de um Chrome comum, com a mesma
// versão do Chromium embarcado.
// ---------------------------------------------------------------------------
function chromeUserAgent() {
  const major = process.versions.chrome.split('.')[0];
  const platform = isMac
    ? 'Macintosh; Intel Mac OS X 10_15_7'
    : process.platform === 'win32'
      ? 'Windows NT 10.0; Win64; x64'
      : 'X11; Linux x86_64';
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}
app.userAgentFallback = chromeUserAgent();

// ---------------------------------------------------------------------------
// Instância única (duas cópias abertas brigariam pelo mesmo armazenamento)
// ---------------------------------------------------------------------------
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

let win = null;
let activeTab = SITES[0].id;
let isQuitting = false;
const views = new Map(); // id -> WebContentsView
const tabState = new Map(); // id -> { loading, title, favicon, unread }

const userData = () => app.getPath('userData');
const notesFile = () => path.join(userData(), 'notes.json');
const stateFile = () => path.join(userData(), 'window-state.json');
const settingsFile = () => path.join(userData(), 'settings.json');

// ---------------------------------------------------------------------------
// Utilidades de arquivo
// ---------------------------------------------------------------------------
function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJSONAtomic(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------------------
// Preferências (zoom por aba, tema do GoHub...)
// ---------------------------------------------------------------------------
let settings = null;
function getSettings() {
  if (!settings) settings = { zoom: {}, ...readJSON(settingsFile(), {}) };
  return settings;
}
function saveSettings() {
  try { writeJSONAtomic(settingsFile(), getSettings()); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Zoom (por aba, lembrado entre aberturas)
// ---------------------------------------------------------------------------
const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];

function tabIdOf(wc) {
  for (const [id, view] of views) if (view.webContents === wc) return id;
  return NOTES_TAB.id;
}

function applyZoom(id) {
  const view = views.get(id);
  // Notas: o zoom é aplicado pela própria interface (só na área da nota, não na barra lateral)
  if (!view || view.webContents.isDestroyed()) return;
  view.webContents.setZoomFactor(getSettings().zoom[id] || 1);
}

function updateTitle() {
  if (!win) return;
  const tab = SITES.find((s) => s.id === activeTab) || NOTES_TAB;
  const z = getSettings().zoom[activeTab] || 1;
  win.setTitle(`Relato — ${tab.name}${Math.abs(z - 1) > 0.001 ? `  ·  ${Math.round(z * 100)}%` : ''}`);
}

// dir: 1 = aumentar, -1 = diminuir, 0 = voltar a 100%
function zoomTab(id, dir) {
  const cur = getSettings().zoom[id] || 1;
  let next = 1;
  if (dir > 0) next = ZOOM_STEPS.find((z) => z > cur + 0.001) || ZOOM_STEPS[ZOOM_STEPS.length - 1];
  if (dir < 0) next = [...ZOOM_STEPS].reverse().find((z) => z < cur - 0.001) || ZOOM_STEPS[0];
  getSettings().zoom[id] = next;
  saveSettings();
  applyZoom(id);
  updateTitle();
  sendToUI('zoom', { id, factor: next });
}

function setupZoom(wc) {
  // Ctrl/⌘ + rolagem do mouse e gesto de pinça no trackpad
  wc.on('zoom-changed', (_e, direction) => zoomTab(tabIdOf(wc), direction === 'in' ? 1 : -1));
  // O Chromium reseta o zoom ao trocar de domínio; reaplica o da aba.
  wc.on('did-navigate', () => applyZoom(tabIdOf(wc)));
  wc.on('did-finish-load', () => applyZoom(tabIdOf(wc)));
}

// ---------------------------------------------------------------------------
// Visual próprio para sites (CSS injetado) + tema claro/escuro
// ---------------------------------------------------------------------------
const SKINS_DIR = path.join(__dirname, 'skins');
const skinKeys = new Map(); // webContents -> { base, dark }

function skinPrefs() {
  const st = getSettings();
  return {
    enabled: st.skinEnabled !== false,
    theme: st.skinTheme || (nativeTheme.shouldUseDarkColors ? 'dark' : 'light'),
  };
}

function readSkin(files) {
  return [].concat(files).map((file) => {
    try { return fs.readFileSync(path.join(SKINS_DIR, file), 'utf8'); } catch { return ''; }
  }).join('\n');
}

async function applySkin(site, wc) {
  if (!site.skin || wc.isDestroyed()) return;
  const keys = skinKeys.get(wc) || {};
  skinKeys.set(wc, keys);
  const prefs = skinPrefs();
  const onHost = hostOf(wc.getURL()) === site.skin.host;
  const want = { base: onHost && prefs.enabled, dark: onHost && prefs.enabled && prefs.theme === 'dark' };
  for (const part of ['base', 'dark']) {
    if (want[part] && !keys[part]) {
      const css = readSkin(site.skin[part]);
      if (css) keys[part] = await wc.insertCSS(css);
    } else if (!want[part] && keys[part]) {
      await wc.removeInsertedCSS(keys[part]).catch(() => {});
      keys[part] = null;
    }
  }
  const view = views.get(site.id);
  if (view) view.setBackgroundColor(want.dark ? '#0f1115' : '#ffffff');
}

function setupSkin(site, wc) {
  if (!site.skin) return;
  // Cada carregamento de página novo descarta o CSS injetado: reaplica.
  wc.on('dom-ready', () => { skinKeys.set(wc, {}); applySkin(site, wc); });
  wc.on('did-navigate-in-page', () => applySkin(site, wc));
}

function setSkinPrefs(patch) {
  Object.assign(getSettings(), patch);
  saveSettings();
  for (const site of SITES) {
    const view = views.get(site.id);
    if (view && site.skin) applySkin(site, view.webContents);
  }
  buildMenu();
  sendToUI('skin', skinPrefs());
}

function toggleSkinTheme() {
  setSkinPrefs({ skinTheme: skinPrefs().theme === 'dark' ? 'light' : 'dark' });
}

// ---------------------------------------------------------------------------
// Sessão compartilhada
// ---------------------------------------------------------------------------
function setupSession() {
  const ses = session.fromPartition(PARTITION);
  ses.setUserAgent(chromeUserAgent());

  const allowed = new Set([
    'notifications', 'clipboard-read', 'clipboard-sanitized-write',
    'fullscreen', 'pointerLock', 'media', 'openExternal', 'window-management',
  ]);
  ses.setPermissionRequestHandler((_wc, permission, cb) => cb(allowed.has(permission)));
  ses.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));

  // Converte cookies de sessão em persistentes (mantém o login entre aberturas).
  ses.cookies.on('changed', (_event, cookie, _cause, removed) => {
    if (removed || !cookie.session) return;
    const host = cookie.domain.replace(/^\./, '');
    const details = {
      url: `${cookie.secure ? 'https' : 'http'}://${host}${cookie.path || '/'}`,
      name: cookie.name,
      value: cookie.value,
      path: cookie.path,
      secure: cookie.secure,
      httpOnly: cookie.httpOnly,
      sameSite: cookie.sameSite,
      expirationDate: Math.floor(Date.now() / 1000) + SESSION_COOKIE_DAYS * 86400,
    };
    if (!cookie.hostOnly) details.domain = cookie.domain;
    ses.cookies.set(details).catch(() => { /* cookies particionados etc. */ });
  });

  return ses;
}

// ---------------------------------------------------------------------------
// Política de janelas/links
// ---------------------------------------------------------------------------
function hostMatches(host, domain) {
  return host === domain || host.endsWith(`.${domain}`);
}

function parseUrl(url) {
  try { return new URL(url); } catch { return null; }
}
function hostOf(url) {
  const u = parseUrl(url);
  return u ? u.hostname : '';
}
const matchesAny = (host, list) => list.some((d) => hostMatches(host, d));

// Páginas de login: quando um site tenta abri-las "em nova aba", carregamos na
// própria aba, para o login terminar onde o usuário está.
const LOGIN_HOSTS = ['accounts.google.com', 'cloudflareaccess.com'];
// Links "nova aba" destes domínios abrem numa janela do app (mesma sessão).
// Ex.: "abrir em nova janela" e impressão do Gmail, anexos.
const POPUP_HOSTS = ['goritektools.com', 'mail.google.com', 'googleusercontent.com'];

// Aba dona de uma URL (mesmo host do site configurado)
function siteForUrl(url) {
  const h = hostOf(url);
  return SITES.find((s) => hostOf(s.url) === h) || null;
}

// Links de redirecionamento do Gmail (google.com/url?q=...)
function unwrapGoogleRedirect(url) {
  try {
    const u = new URL(url);
    if (hostMatches(u.hostname, 'google.com') && u.pathname === '/url') {
      return u.searchParams.get('q') || u.searchParams.get('url') || url;
    }
  } catch { /* ignore */ }
  return url;
}

function openExternal(url) {
  if (/^(https?|mailto):/i.test(url)) shell.openExternal(url);
}

const POPUP_OPTIONS = {
  width: 540,
  height: 720,
  autoHideMenuBar: true,
  backgroundColor: '#ffffff',
  webPreferences: {
    partition: PARTITION,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
  },
};

function attachWindowPolicy(contents) {
  contents.setWindowOpenHandler(({ url, disposition }) => {
    const target = unwrapGoogleRedirect(url);
    if (target !== url) {
      openExternal(target);
      return { action: 'deny' };
    }
    const u = parseUrl(url);
    const host = u ? u.hostname : '';
    const isTabLink = disposition === 'foreground-tab' || disposition === 'background-tab';

    // Botões "Fazer login" que abririam nova aba: carrega na própria aba.
    if (isTabLink && matchesAny(host, LOGIN_HOSTS)) {
      contents.loadURL(url);
      return { action: 'deny' };
    }
    // Popups de verdade (OAuth com tamanho definido) e páginas em branco
    // (impressão do Gmail etc.) ficam numa janela do app.
    const blank = !u || u.protocol === 'about:' || u.protocol === 'blob:';
    if (disposition === 'new-window' || blank || (isTabLink && matchesAny(host, POPUP_HOSTS))) {
      return { action: 'allow', overrideBrowserWindowOptions: POPUP_OPTIONS };
    }
    // Todo o resto vai para o navegador padrão.
    openExternal(url);
    return { action: 'deny' };
  });

  contents.on('did-create-window', (child) => {
    attachWindowPolicy(child.webContents);
    watchLoginPopup(child);
  });
}

// Se um popup passou por uma tela de login e depois chegou em um dos nossos
// sites (ex.: terminou o login e abriu o Gmail), fecha o popup e leva o
// resultado para a aba correspondente.
function watchLoginPopup(child) {
  let sawLogin = false;
  child.webContents.on('did-navigate', (_e, url) => {
    if (matchesAny(hostOf(url), LOGIN_HOSTS)) {
      sawLogin = true;
      return;
    }
    const site = sawLogin && siteForUrl(url);
    if (!site || child.isDestroyed()) return;
    const view = views.get(site.id);
    if (!view) return;
    view.webContents.loadURL(url);
    switchTab(site.id);
    if (win) win.focus();
    child.close();
  });
}

// Página "deslogada" de um site (ex.: propaganda do Gmail) vai direto ao login.
function attachSignedOutRedirect(site, wc) {
  if (!site.signedOutPage || !site.loginUrl) return;
  const check = (event, url) => {
    const u = parseUrl(url);
    if (!u || !site.signedOutPage(u)) return false;
    if (event) event.preventDefault();
    setImmediate(() => wc.loadURL(site.loginUrl));
    return true;
  };
  wc.on('will-redirect', (e, url, _inPlace, isMainFrame) => { if (isMainFrame) check(e, url); });
  wc.on('will-navigate', (e, url) => check(e, url));
  wc.on('did-navigate', (_e, url) => check(null, url));
}

// ---------------------------------------------------------------------------
// Janela principal e abas
// ---------------------------------------------------------------------------
function sendToUI(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function pushTabState(id, patch) {
  const next = { ...(tabState.get(id) || {}), ...patch };
  tabState.set(id, next);
  sendToUI('tab:state', { id, ...next });
}

function layoutViews() {
  if (!win) return;
  const [width, height] = win.getContentSize();
  for (const view of views.values()) {
    view.setBounds({ x: SIDEBAR_WIDTH, y: 0, width: Math.max(0, width - SIDEBAR_WIDTH), height });
  }
}

function switchTab(id) {
  if (id !== NOTES_TAB.id && !views.has(id)) return;
  activeTab = id;
  for (const [vid, view] of views) view.setVisible(vid === id);
  layoutViews();
  const view = views.get(id);
  if (view) view.webContents.focus();
  else win.webContents.focus();
  updateTitle();
  sendToUI('tab:active', id);
}

function reloadActive(ignoreCache = false) {
  const view = views.get(activeTab);
  if (!view) return;
  if (ignoreCache) view.webContents.reloadIgnoringCache();
  else view.webContents.reload();
}

function activeContents() {
  const view = views.get(activeTab);
  return view ? view.webContents : win.webContents;
}

function createSiteView(site) {
  const view = new WebContentsView({
    webPreferences: {
      partition: PARTITION,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true,
      // Mantém timers/contadores (ex.: tempo do código 2FA) rodando em segundo plano.
      backgroundThrottling: false,
    },
  });
  view.setBackgroundColor('#ffffff');
  view.setVisible(false);
  const wc = view.webContents;

  attachWindowPolicy(wc);
  attachSignedOutRedirect(site, wc);
  setupZoom(wc);
  setupSkin(site, wc);
  // Só em desenvolvimento: salva a estrutura das páginas para criar o visual.
  if (process.env.RELATO_INSPECT_DIR) {
    try { require('../scripts/inspect-hook.js')(site, wc, process.env.RELATO_INSPECT_DIR, {
      setSkinPrefs,
      skinCss: () => {
        const prefs = skinPrefs();
        if (!prefs.enabled) return {};
        return { base: readSkin(site.skin.base), dark: prefs.theme === 'dark' ? readSkin(site.skin.dark) : '' };
      },
      reapplySkin: async () => {
        const keys = skinKeys.get(wc) || {};
        for (const k of Object.values(keys)) if (k) await wc.removeInsertedCSS(k).catch(() => {});
        skinKeys.set(wc, {});
        await applySkin(site, wc);
      },
    }); } catch (err) { console.error(err); }
  }

  wc.on('did-start-loading', () => pushTabState(site.id, { loading: true }));
  wc.on('did-stop-loading', () => pushTabState(site.id, { loading: false }));
  wc.on('page-favicon-updated', (_e, favicons) => {
    if (favicons && favicons[0]) pushTabState(site.id, { favicon: favicons[0] });
  });
  wc.on('page-title-updated', (_e, title) => {
    const m = /\((\d+)\)/.exec(title);
    pushTabState(site.id, { title, unread: m ? Number(m[1]) : 0 });
  });
  wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (isMainFrame && code !== -3) pushTabState(site.id, { loading: false, error: desc });
  });
  wc.on('did-finish-load', () => pushTabState(site.id, { error: null }));

  // Atalhos de teclado também funcionam quando o foco está dentro do site.
  wc.on('before-input-event', (event, input) => handleShortcut(event, input));

  win.contentView.addChildView(view);
  views.set(site.id, view);
  pushTabState(site.id, { loading: true });
  wc.loadURL(site.url);
}

function handleShortcut(event, input) {
  if (input.type !== 'keyDown') return;
  const mod = isMac ? input.meta : input.control;
  if (!mod || input.alt) return;
  const key = input.key.toLowerCase();
  const tabs = [...SITES.map((s) => s.id), NOTES_TAB.id];
  if (/^[1-9]$/.test(key) && tabs[Number(key) - 1]) {
    event.preventDefault();
    switchTab(tabs[Number(key) - 1]);
  } else if (key === 'r') {
    event.preventDefault();
    reloadActive(input.shift);
  } else if (key === '=' || key === '+' || input.code === 'NumpadAdd') {
    event.preventDefault();
    zoomTab(activeTab, 1);
  } else if (key === '-' || key === '_' || input.code === 'NumpadSubtract') {
    event.preventDefault();
    zoomTab(activeTab, -1);
  } else if (key === '0' || input.code === 'Numpad0') {
    event.preventDefault();
    zoomTab(activeTab, 0);
  }
}

function loadWindowState() {
  const s = readJSON(stateFile(), {});
  return {
    width: s.width || 1360,
    height: s.height || 860,
    x: s.x,
    y: s.y,
    maximized: !!s.maximized,
  };
}

function saveWindowState() {
  if (!win || win.isDestroyed()) return;
  try {
    const b = win.getNormalBounds();
    writeJSONAtomic(stateFile(), { ...b, maximized: win.isMaximized() });
  } catch { /* ignore */ }
}

function createWindow() {
  const st = loadWindowState();
  win = new BrowserWindow({
    width: st.width,
    height: st.height,
    x: st.x,
    y: st.y,
    minWidth: 720,
    minHeight: 480,
    title: 'Relato',
    icon: !app.isPackaged && fs.existsSync(DEV_ICON) ? DEV_ICON : undefined,
    backgroundColor: '#f7f7f5',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  });
  if (st.maximized) win.maximize();

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());

  // A própria interface (barra lateral/notas) não navega para fora.
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('before-input-event', (event, input) => handleShortcut(event, input));
  setupZoom(win.webContents);

  for (const site of SITES) createSiteView(site);
  switchTab(activeTab);

  win.on('resize', layoutViews);
  win.on('resized', saveWindowState);
  win.on('moved', saveWindowState);
  win.on('maximize', layoutViews);
  win.on('unmaximize', layoutViews);
  win.on('enter-full-screen', layoutViews);
  win.on('leave-full-screen', layoutViews);

  // No macOS, fechar a janela só esconde (as abas continuam como estavam).
  win.on('close', (e) => {
    saveWindowState();
    if (isMac && !isQuitting) {
      e.preventDefault();
      win.hide();
    }
  });
  win.on('closed', () => { win = null; });
}

// ---------------------------------------------------------------------------
// Menu (necessário no macOS para copiar/colar funcionar)
// ---------------------------------------------------------------------------
function buildMenu() {
  const tabs = [...SITES, NOTES_TAB];
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'Arquivo',
      submenu: [
        { label: 'Recarregar aba', accelerator: 'CmdOrCtrl+R', click: () => reloadActive(false) },
        { label: 'Recarregar sem cache', accelerator: 'CmdOrCtrl+Shift+R', click: () => reloadActive(true) },
        { type: 'separator' },
        {
          label: 'Abrir pasta de dados',
          click: () => shell.openPath(userData()),
        },
        { type: 'separator' },
        isMac ? { role: 'close', label: 'Fechar janela' } : { role: 'quit', label: 'Sair' },
      ],
    },
    { role: 'editMenu', label: 'Editar' },
    {
      label: 'Ir',
      submenu: tabs.map((t, i) => ({
        label: t.name,
        accelerator: `CmdOrCtrl+${i + 1}`,
        click: () => switchTab(t.id),
      })),
    },
    {
      label: 'Exibir',
      submenu: [
        {
          label: 'Aumentar zoom',
          accelerator: 'CmdOrCtrl+=',
          click: () => zoomTab(activeTab, 1),
        },
        {
          label: 'Diminuir zoom',
          accelerator: 'CmdOrCtrl+-',
          click: () => zoomTab(activeTab, -1),
        },
        { label: 'Zoom normal (100%)', accelerator: 'CmdOrCtrl+0', click: () => zoomTab(activeTab, 0) },
        { type: 'separator' },
        { type: 'separator' },
        {
          label: 'GoHub: visual melhorado',
          type: 'checkbox',
          checked: skinPrefs().enabled,
          click: () => setSkinPrefs({ skinEnabled: !skinPrefs().enabled }),
        },
        {
          label: 'GoHub: tema escuro',
          type: 'checkbox',
          accelerator: 'CmdOrCtrl+Shift+L',
          checked: skinPrefs().theme === 'dark',
          enabled: skinPrefs().enabled,
          click: toggleSkinTheme,
        },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Tela cheia' },
        {
          label: 'Ferramentas de desenvolvedor',
          accelerator: isMac ? 'Alt+Cmd+I' : 'Ctrl+Shift+I',
          click: () => activeContents().toggleDevTools(),
        },
      ],
    },
    { role: 'windowMenu', label: 'Janela' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
function setupIPC() {
  ipcMain.handle('app:info', () => ({
    tabs: [...SITES.map(({ id, name }) => ({ id, name, kind: 'web' })), { ...NOTES_TAB, kind: 'notes' }],
    active: activeTab,
    states: Object.fromEntries(tabState),
    platform: process.platform,
    version: app.getVersion(),
    zoom: getSettings().zoom,
    skin: skinPrefs(),
    skinTabs: SITES.filter((x) => x.skin).map((x) => x.id),
  }));
  ipcMain.on('tab:switch', (_e, id) => switchTab(id));
  ipcMain.on('tab:reload', () => reloadActive(false));
  ipcMain.on('skin:toggle-theme', () => toggleSkinTheme());

  ipcMain.handle('notes:load', () => readJSON(notesFile(), { notes: [] }));
  ipcMain.handle('notes:save', (_e, data) => {
    writeJSONAtomic(notesFile(), data);
    return true;
  });
  ipcMain.on('notes:save-sync', (e, data) => {
    try { writeJSONAtomic(notesFile(), data); e.returnValue = true; } catch { e.returnValue = false; }
  });
  ipcMain.handle('notes:export', async (_e, data) => {
    const stamp = new Date().toISOString().slice(0, 10);
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: 'Exportar notas',
      defaultPath: `notas-${stamp}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (canceled || !filePath) return false;
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    return true;
  });
  ipcMain.handle('notes:import', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: 'Importar notas',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile'],
    });
    if (canceled || !filePaths[0]) return null;
    return readJSON(filePaths[0], null);
  });
}

// ---------------------------------------------------------------------------
// Ciclo de vida
// ---------------------------------------------------------------------------
app.on('second-instance', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});

app.on('before-quit', () => {
  isQuitting = true;
  saveWindowState();
  session.fromPartition(PARTITION).cookies.flushStore().catch(() => {});
});

app.on('activate', () => {
  if (win) win.show();
  else createWindow();
});

app.on('window-all-closed', () => {
  if (!isMac) app.quit();
});

// Usado apenas pelos scripts de teste/screenshot.
global.__desk = { views, switchTab, getWindow: () => win };

if (process.platform === 'win32') app.setAppUserModelId(APP_ID);
app.setAboutPanelOptions({
  applicationName: 'Relato',
  applicationVersion: app.getVersion(),
  copyright: 'Uso interno',
});

app.whenReady().then(() => {
  if (isMac && !app.isPackaged && fs.existsSync(DEV_ICON)) app.dock.setIcon(DEV_ICON);
  setupSession();
  setupIPC();
  buildMenu();
  createWindow();
});
