'use strict';

/* global desk */
const $ = (sel, root = document) => root.querySelector(sel);
const h = (tag, attrs = {}, ...children) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'style') el.style.cssText = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null) el.append(c);
  return el;
};

const NOTE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" d="M6 3h9l4 4v14H6z"/><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M9 11h7M9 15h7M14 3v4h5"/></svg>';

// =============================================================================
// Barra lateral / abas
// =============================================================================
const ui = {
  tabs: [],
  active: null,
  states: {},
};

// Os botões são criados uma vez e depois só atualizados, para que o fundo da
// aba ativa (indicador) possa deslizar suavemente entre eles.
const tabEls = new Map(); // id -> { btn, fav, favKey }
let indicator = null;

function buildTabs() {
  const wrap = $('#tabs');
  wrap.textContent = '';
  indicator = h('div', { class: 'tab-indicator no-anim', 'aria-hidden': 'true' });
  wrap.append(indicator);
  for (const tab of ui.tabs) {
    const fav = h('span', { class: 'fav' });
    const btn = h('button', {
      class: 'tab',
      role: 'tab',
      'data-id': tab.id,
      onclick: () => selectTab(tab.id),
    }, h('span', { class: 'tab-inner' }, fav, h('span', { class: 'label', text: tab.name })));
    wrap.append(btn);
    tabEls.set(tab.id, { btn, fav, favKey: null });
  }
  // reposiciona sem animação quando a janela muda de tamanho
  new ResizeObserver(() => moveIndicator(false)).observe(wrap);
}

function setFavicon(tab, el, st) {
  const key = tab.kind === 'notes' ? 'notes' : (st.favicon || 'letter');
  if (el.favKey === key) return;
  el.favKey = key;
  const fav = el.fav;
  if (tab.kind === 'notes') {
    fav.innerHTML = NOTE_ICON;
  } else if (st.favicon) {
    const img = h('img', { src: st.favicon, alt: '' });
    img.addEventListener('error', () => { fav.replaceChildren(h('span', { class: 'letter', text: tab.name[0] })); });
    fav.replaceChildren(img);
  } else {
    fav.replaceChildren(h('span', { class: 'letter', text: tab.name[0] }));
  }
}

function moveIndicator(animate = true) {
  const el = tabEls.get(ui.active);
  if (!indicator || !el) return;
  indicator.classList.toggle('no-anim', !animate);
  indicator.style.height = `${el.btn.offsetHeight}px`;
  indicator.style.transform = `translateY(${el.btn.offsetTop}px)`;
  if (!animate) {
    void indicator.offsetHeight; // aplica sem transição
    indicator.classList.remove('no-anim');
  }
}

// move: 'animate' | 'instant' | null (null = não mexe no indicador)
function renderTabs(move = null) {
  for (const tab of ui.tabs) {
    const el = tabEls.get(tab.id);
    if (!el) continue;
    const st = ui.states[tab.id] || {};
    const isActive = ui.active === tab.id;
    setFavicon(tab, el, st);
    el.btn.classList.toggle('active', isActive);
    el.btn.classList.toggle('has-error', !!st.error);
    el.btn.setAttribute('aria-selected', String(isActive));
    el.btn.title = tab.name + (st.error ? ` — erro: ${st.error}` : '');
    let badge = el.btn.querySelector('.badge');
    if (st.unread > 0) {
      if (!badge) { badge = h('span', { class: 'badge' }); el.btn.append(badge); }
      badge.textContent = st.unread > 99 ? '99+' : String(st.unread);
    } else if (badge) {
      badge.remove();
    }
  }
  if (move) moveIndicator(move === 'animate');
  renderReload();
}

function renderReload() {
  const btn = $('#reload');
  const tab = ui.tabs.find((t) => t.id === ui.active);
  const st = ui.states[ui.active] || {};
  const isWeb = tab && tab.kind === 'web';
  btn.disabled = !isWeb;
  btn.classList.toggle('loading', !!(isWeb && st.loading));
  btn.classList.toggle('attention', !!(isWeb && st.error && !st.loading));
}

function selectTab(id) {
  if (id === ui.active) return;
  applyActive(id);
  desk.switchTab(id);
}

function applyActive(id, animate = true) {
  const changed = ui.active !== id;
  ui.active = id;
  const isNotes = id === 'notes';
  $('#notes').hidden = !isNotes;
  $('#web-placeholder').hidden = isNotes;
  renderTabs(changed ? (animate ? 'animate' : 'instant') : null);
  if (isNotes && notes.view === 'list') $('#search').focus({ preventScroll: true });
}

$('#reload').addEventListener('click', () => desk.reload());

// =============================================================================
// Notas
// =============================================================================
const COLORS = ['none', 'gray', 'brown', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'red'];
const COLOR_NAMES = {
  none: 'Sem cor', gray: 'Cinza', brown: 'Marrom', orange: 'Laranja', yellow: 'Amarelo',
  green: 'Verde', blue: 'Azul', purple: 'Roxo', pink: 'Rosa', red: 'Vermelho',
};
const colorVar = (c) => (c && c !== 'none' ? `var(--c-${c})` : 'transparent');

const notes = {
  list: [],
  view: 'list',
  currentId: null,
  query: '',
  tagFilter: null,
  saveTimer: null,
  dirty: false,
};

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const current = () => notes.list.find((n) => n.id === notes.currentId);

const rtf = new Intl.RelativeTimeFormat('pt-BR', { numeric: 'auto' });
const dtf = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'medium', timeStyle: 'short' });
function relTime(ts) {
  const diff = (ts - Date.now()) / 1000;
  const abs = Math.abs(diff);
  if (abs < 45) return 'agora mesmo';
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  if (abs < 86400 * 7) return rtf.format(Math.round(diff / 86400), 'day');
  return dtf.format(ts);
}

// ---------- persistência ----------
async function loadNotes() {
  const data = await desk.notes.load();
  notes.list = Array.isArray(data && data.notes) ? data.notes : [];
}

function scheduleSave() {
  notes.dirty = true;
  $('#save-state').textContent = 'Salvando…';
  clearTimeout(notes.saveTimer);
  notes.saveTimer = setTimeout(flushSave, 400);
}

async function flushSave() {
  clearTimeout(notes.saveTimer);
  if (!notes.dirty) return;
  notes.dirty = false;
  try {
    await desk.notes.save({ version: 1, savedAt: Date.now(), notes: notes.list });
    $('#save-state').textContent = 'Salvo';
  } catch (err) {
    notes.dirty = true;
    $('#save-state').textContent = 'Erro ao salvar!';
    console.error(err);
  }
}
window.addEventListener('beforeunload', () => {
  if (!notes.dirty) return;
  clearTimeout(notes.saveTimer);
  desk.notes.saveSync({ version: 1, savedAt: Date.now(), notes: notes.list });
  notes.dirty = false;
});

// ---------- lista ----------
function sortedNotes() {
  return [...notes.list].sort((a, b) => (b.pinned - a.pinned) || (b.updatedAt - a.updatedAt));
}

function matches(n) {
  if (notes.tagFilter && !(n.tags || []).includes(notes.tagFilter)) return false;
  const q = notes.query.trim().toLowerCase();
  if (!q) return true;
  return (n.title || '').toLowerCase().includes(q)
    || (n.text || '').toLowerCase().includes(q)
    || (n.tags || []).some((t) => t.toLowerCase().includes(q));
}

function allTags() {
  const set = new Set();
  for (const n of notes.list) for (const t of n.tags || []) set.add(t);
  return [...set].sort((a, b) => a.localeCompare(b, 'pt-BR'));
}

function firstImage(html) {
  const m = /<img[^>]+src="([^"]+)"/i.exec(html || '');
  return m ? m[1] : null;
}

function renderList() {
  const grid = $('#grid');
  const empty = $('#empty');
  const items = sortedNotes().filter(matches);
  $('#count').textContent = notes.list.length ? `${notes.list.length} ${notes.list.length === 1 ? 'nota' : 'notas'}` : '';

  // filtro por tag
  const tf = $('#tag-filter');
  tf.textContent = '';
  const tags = allTags();
  if (tags.length) {
    for (const t of tags) {
      tf.append(h('button', {
        class: `chip${notes.tagFilter === t ? ' on' : ''}`,
        text: `#${t}`,
        onclick: () => { notes.tagFilter = notes.tagFilter === t ? null : t; renderList(); },
      }));
    }
  }

  grid.textContent = '';
  for (const n of items) {
    const img = firstImage(n.html);
    const card = h('article', {
      class: 'card',
      tabindex: '0',
      style: `--strip:${colorVar(n.color)}`,
      onclick: () => openNote(n.id),
      onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openNote(n.id); } },
    },
    h('div', { class: 'strip' }),
    h('div', { class: 'card-body' },
      h('h3', { class: n.title ? '' : 'untitled', text: n.title || 'Sem título' }),
      img ? h('img', { class: 'thumb', src: img, alt: '' }) : null,
      n.text ? h('p', { class: 'snippet', text: n.text.slice(0, 400) }) : null,
      (n.tags || []).length ? h('div', { class: 'card-tags' }, n.tags.map((t) => h('span', { class: 'chip', text: `#${t}` }))) : null),
    h('footer', { text: `Editada ${relTime(n.updatedAt)}` }));
    if (n.pinned) {
      card.append(h('span', { class: 'pin', title: 'Fixada' }));
      card.lastChild.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M16 3l5 5-3 1-4 4 1 5-2 2-4-4-5 5-1-1 5-5-4-4 2-2 5 1 4-4z"/></svg>';
    }
    grid.append(card);
  }

  if (!notes.list.length) {
    empty.hidden = false;
    empty.replaceChildren(
      h('div', { class: 'big', text: '🗒️' }),
      h('h2', { text: 'Nenhuma nota ainda' }),
      h('p', { text: 'Guarde aqui o que foi feito, o que será feito, links e prints para reportar no GoHub.' }),
      h('button', { class: 'primary', text: '+ Criar primeira nota', onclick: newNote }),
    );
  } else if (!items.length) {
    empty.hidden = false;
    empty.replaceChildren(h('h2', { text: 'Nada encontrado' }), h('p', { text: 'Tente outra busca ou remova o filtro de tag.' }));
  } else {
    empty.hidden = true;
  }
}

$('#search').addEventListener('input', (e) => { notes.query = e.target.value; renderList(); });
$('#btn-new').addEventListener('click', () => newNote());
$('#btn-export').addEventListener('click', async () => {
  await flushSave();
  await desk.notes.exportAll({ version: 1, exportedAt: Date.now(), notes: notes.list });
});
$('#btn-import').addEventListener('click', async () => {
  const data = await desk.notes.importFile();
  if (!data || !Array.isArray(data.notes)) return;
  const byId = new Map(notes.list.map((n) => [n.id, n]));
  for (const n of data.notes) {
    if (!n || !n.id) continue;
    const mine = byId.get(n.id);
    if (!mine || (n.updatedAt || 0) > (mine.updatedAt || 0)) {
      byId.set(n.id, { ...n, html: sanitizeHTML(n.html || '') });
    }
  }
  notes.list = [...byId.values()];
  scheduleSave();
  renderList();
});

// ---------- detalhe ----------
const titleEl = $('#note-title');
const bodyEl = $('#note-body');

function newNote() {
  const now = Date.now();
  const n = {
    id: uid(), title: '', html: '', text: '', tags: [], color: 'none', pinned: false, createdAt: now, updatedAt: now,
  };
  notes.list.unshift(n);
  scheduleSave();
  openNote(n.id, true);
}

function openNote(id, focusTitle = false) {
  const n = notes.list.find((x) => x.id === id);
  if (!n) return;
  notes.currentId = id;
  notes.view = 'detail';
  $('#list-view').hidden = true;
  const dv = $('#detail-view');
  dv.hidden = false;
  dv.scrollTop = 0;
  dv.classList.remove('enter'); void dv.offsetWidth; dv.classList.add('enter');

  titleEl.value = n.title || '';
  autoGrow();
  bodyEl.innerHTML = n.html || '';
  updateBodyEmpty();
  renderDetailMeta();
  renderTagsEdit();
  resetDeleteBtn();
  $('#save-state').textContent = '';
  closeLinkBox();

  if (focusTitle || !n.title) titleEl.focus();
  else {
    bodyEl.focus();
    placeCaretAtEnd(bodyEl);
  }
}

async function backToList() {
  const n = current();
  // remove notas totalmente vazias ao sair
  if (n && !n.title.trim() && !n.text.trim() && !(n.tags || []).length && !/<img/i.test(n.html)) {
    notes.list = notes.list.filter((x) => x.id !== n.id);
    notes.dirty = true;
  }
  await flushSave();
  notes.view = 'list';
  notes.currentId = null;
  $('#detail-view').hidden = true;
  const lv = $('#list-view');
  lv.hidden = false;
  lv.classList.remove('enter'); void lv.offsetWidth; lv.classList.add('enter');
  renderList();
}
$('#btn-back').addEventListener('click', backToList);

function renderDetailMeta() {
  const n = current();
  if (!n) return;
  $('#crumb-title').textContent = n.title || 'Sem título';
  $('#prop-created').textContent = dtf.format(n.createdAt);
  $('#prop-updated').textContent = dtf.format(n.updatedAt);
  const cover = $('#cover');
  cover.style.setProperty('--strip', colorVar(n.color));
  cover.classList.toggle('has-color', !!n.color && n.color !== 'none');

  const cp = $('#color-picker');
  cp.textContent = '';
  for (const c of COLORS) {
    cp.append(h('button', {
      class: `color-dot${(n.color || 'none') === c ? ' on' : ''}`,
      'data-color': c,
      role: 'radio',
      'aria-checked': String((n.color || 'none') === c),
      title: COLOR_NAMES[c],
      style: `--dot:${colorVar(c)}`,
      onclick: () => { touch({ color: c }); renderDetailMeta(); },
    }));
  }

  const pin = $('#btn-pin');
  pin.classList.toggle('on', !!n.pinned);
  pin.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14"><path fill="${n.pinned ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" d="M16 3l5 5-3 1-4 4 1 5-2 2-4-4-5 5-1-1 5-5-4-4 2-2 5 1 4-4z"/></svg>${n.pinned ? 'Fixada' : 'Fixar'}`;
}

function touch(patch) {
  const n = current();
  if (!n) return;
  Object.assign(n, patch, { updatedAt: Date.now() });
  $('#prop-updated').textContent = dtf.format(n.updatedAt);
  scheduleSave();
}

$('#btn-pin').addEventListener('click', () => {
  const n = current();
  if (!n) return;
  touch({ pinned: !n.pinned });
  renderDetailMeta();
});

// Excluir com confirmação no próprio botão (sem popup)
let deleteTimer = null;
function resetDeleteBtn() {
  clearTimeout(deleteTimer);
  const b = $('#btn-delete');
  b.classList.remove('confirm');
  b.textContent = 'Excluir';
}
$('#btn-delete').addEventListener('click', async () => {
  const b = $('#btn-delete');
  if (!b.classList.contains('confirm')) {
    b.classList.add('confirm');
    b.textContent = 'Clique de novo para excluir';
    deleteTimer = setTimeout(resetDeleteBtn, 3500);
    return;
  }
  resetDeleteBtn();
  notes.list = notes.list.filter((x) => x.id !== notes.currentId);
  notes.dirty = true;
  notes.currentId = null;
  await backToList();
});

// título
function autoGrow() {
  titleEl.style.height = 'auto';
  titleEl.style.height = `${titleEl.scrollHeight}px`;
}
titleEl.addEventListener('input', () => {
  autoGrow();
  touch({ title: titleEl.value.replace(/\n/g, ' ') });
  $('#crumb-title').textContent = titleEl.value || 'Sem título';
});
titleEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || (e.key === 'ArrowDown' && titleEl.selectionStart === titleEl.value.length)) {
    e.preventDefault();
    bodyEl.focus();
    placeCaretAtStart(bodyEl);
  }
});

// tags
function renderTagsEdit() {
  const n = current();
  const box = $('#tags-edit');
  const input = $('#tag-input');
  box.querySelectorAll('.chip').forEach((c) => c.remove());
  for (const t of n.tags || []) {
    box.insertBefore(h('span', { class: 'chip' }, `#${t}`, h('button', {
      class: 'x',
      title: 'Remover tag',
      text: '×',
      onclick: () => { touch({ tags: n.tags.filter((x) => x !== t) }); renderTagsEdit(); },
    })), input);
  }
  input.value = '';
}
$('#tag-input').addEventListener('keydown', (e) => {
  const n = current();
  const input = e.target;
  if ((e.key === 'Enter' || e.key === ',') && input.value.trim()) {
    e.preventDefault();
    const t = input.value.trim().replace(/^#/, '').replace(/,/g, '');
    if (t && !(n.tags || []).includes(t)) touch({ tags: [...(n.tags || []), t] });
    renderTagsEdit();
  } else if (e.key === 'Backspace' && !input.value && (n.tags || []).length) {
    touch({ tags: n.tags.slice(0, -1) });
    renderTagsEdit();
  }
});
$('#tag-input').addEventListener('blur', (e) => {
  const n = current();
  const t = e.target.value.trim().replace(/^#/, '').replace(/,/g, '');
  if (n && t && !(n.tags || []).includes(t)) { touch({ tags: [...(n.tags || []), t] }); renderTagsEdit(); }
});

// ---------- editor ----------
document.execCommand('defaultParagraphSeparator', false, 'p');

function updateBodyEmpty() {
  const empty = !bodyEl.textContent.trim() && !bodyEl.querySelector('img,hr,li,table');
  bodyEl.classList.toggle('is-empty', empty);
}

function syncBody() {
  updateBodyEmpty();
  touch({ html: bodyEl.innerHTML, text: bodyEl.innerText.replace(/\n{3,}/g, '\n\n').trim() });
}
bodyEl.addEventListener('input', syncBody);

function placeCaretAtEnd(el) {
  const r = document.createRange();
  r.selectNodeContents(el);
  r.collapse(false);
  const s = getSelection(); s.removeAllRanges(); s.addRange(r);
}
function placeCaretAtStart(el) {
  const r = document.createRange();
  r.selectNodeContents(el);
  r.collapse(true);
  const s = getSelection(); s.removeAllRanges(); s.addRange(r);
}

const BLOCKS = /^(P|DIV|H1|H2|H3|LI|BLOCKQUOTE|PRE)$/;
function currentBlock() {
  const sel = getSelection();
  if (!sel.rangeCount) return null;
  let n = sel.anchorNode;
  while (n && n !== bodyEl) {
    if (n.nodeType === 1 && BLOCKS.test(n.nodeName)) return n;
    n = n.parentNode;
  }
  return null;
}
function currentList() {
  const sel = getSelection();
  let n = sel.rangeCount ? sel.anchorNode : null;
  while (n && n !== bodyEl) {
    if (n.nodeName === 'UL' || n.nodeName === 'OL') return n;
    n = n.parentNode;
  }
  return null;
}

function applyCmd(cmd) {
  bodyEl.focus();
  const block = currentBlock();
  switch (cmd) {
    case 'h1': case 'h2': case 'h3':
      document.execCommand('formatBlock', false, block && block.nodeName === cmd.toUpperCase() ? 'p' : cmd);
      break;
    case 'p': document.execCommand('formatBlock', false, 'p'); break;
    case 'quote':
      document.execCommand('formatBlock', false, block && block.closest('blockquote') ? 'p' : 'blockquote');
      break;
    case 'ul': {
      const l = currentList();
      if (l && l.classList.contains('checklist')) { l.classList.remove('checklist'); break; }
      document.execCommand('insertUnorderedList');
      break;
    }
    case 'ol': document.execCommand('insertOrderedList'); break;
    case 'check': {
      const l = currentList();
      if (l && l.nodeName === 'UL' && l.classList.contains('checklist')) {
        document.execCommand('insertUnorderedList'); // remove a lista
      } else {
        if (!l || l.nodeName !== 'UL') document.execCommand('insertUnorderedList');
        const nl = currentList();
        if (nl) nl.classList.add('checklist');
      }
      break;
    }
    case 'hr': document.execCommand('insertHorizontalRule'); break;
    case 'code': {
      const sel = getSelection();
      const text = sel.toString();
      if (text.includes('\n')) document.execCommand('insertHTML', false, `<pre><code>${escapeHTML(text)}</code></pre><p><br></p>`);
      else if (text) document.execCommand('insertHTML', false, `<code>${escapeHTML(text)}</code>&#8203;`);
      else document.execCommand('insertHTML', false, '<pre><code>​</code></pre><p><br></p>');
      break;
    }
    case 'link': openLinkBox(); return;
    default: document.execCommand(cmd);
  }
  syncBody();
}

$('#toolbar').addEventListener('mousedown', (e) => {
  // não tirar o foco/seleção do editor ao clicar nos botões
  if (e.target.closest('button')) e.preventDefault();
});
$('#toolbar').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-cmd]');
  if (b) applyCmd(b.dataset.cmd);
});

// link inline (sem popup)
let savedRange = null;
function openLinkBox() {
  const sel = getSelection();
  if (!sel.rangeCount || sel.isCollapsed) {
    $('#save-state').textContent = 'Selecione um texto para virar link';
    return;
  }
  savedRange = sel.getRangeAt(0).cloneRange();
  const box = $('#link-box');
  box.hidden = false;
  const input = $('#link-input');
  input.value = '';
  input.focus();
}
function closeLinkBox() { $('#link-box').hidden = true; savedRange = null; }
$('#link-input').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeLinkBox(); bodyEl.focus(); return; }
  if (e.key !== 'Enter') return;
  e.preventDefault();
  let url = e.target.value.trim();
  if (url && !/^(https?:|mailto:)/i.test(url)) url = `https://${url}`;
  const range = savedRange;
  closeLinkBox();
  bodyEl.focus();
  if (range) { const s = getSelection(); s.removeAllRanges(); s.addRange(range); }
  if (url) document.execCommand('createLink', false, url);
  syncBody();
});
$('#link-input').addEventListener('blur', () => setTimeout(closeLinkBox, 150));

// links: Ctrl/⌘ + clique abre no navegador padrão
bodyEl.addEventListener('click', (e) => {
  const a = e.target.closest('a[href]');
  if (a && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    window.open(a.href, '_blank');
    return;
  }
  // marcar/desmarcar item de checklist ao clicar na caixinha
  const li = e.target.closest('ul.checklist > li');
  if (li && e.target === li && e.offsetX < 24) {
    e.preventDefault();
    li.toggleAttribute('data-checked');
    syncBody();
  }
});
bodyEl.addEventListener('mouseover', (e) => {
  const a = e.target.closest('a[href]');
  if (a) a.title = `${a.href}\n(Ctrl/⌘ + clique para abrir)`;
});

// atalhos markdown estilo Notion: "# ", "## ", "- ", "1. ", "[] ", "> "
const MD = {
  '#': 'h1', '##': 'h2', '###': 'h3', '-': 'ul', '*': 'ul', '1.': 'ol', '[]': 'check', '[ ]': 'check', '>': 'quote',
};
bodyEl.addEventListener('keydown', (e) => {
  if (e.key === ' ' && !e.metaKey && !e.ctrlKey) {
    const sel = getSelection();
    if (!sel.rangeCount || !sel.isCollapsed) return;
    let block = currentBlock();
    if (!block) {
      document.execCommand('formatBlock', false, 'p');
      block = currentBlock();
      if (!block) return;
    }
    if (block.nodeName === 'LI' || block.nodeName === 'PRE') return;
    const r = sel.getRangeAt(0);
    const pre = document.createRange();
    pre.selectNodeContents(block);
    pre.setEnd(r.endContainer, r.endOffset);
    const marker = pre.toString();
    const cmd = MD[marker];
    if (!cmd) return;
    e.preventDefault();
    pre.deleteContents();
    if (!block.textContent) block.innerHTML = '<br>';
    placeCaretAtStart(block);
    applyCmd(cmd);
    return;
  }
  if (e.key === 'Enter') {
    const list = currentList();
    if (list && list.classList.contains('checklist')) {
      // item novo de checklist nasce desmarcado
      setTimeout(() => {
        const li = currentBlock();
        if (li && li.nodeName === 'LI') li.removeAttribute('data-checked');
      });
    }
  }
  if (e.key === 'Tab') {
    if (currentList()) {
      e.preventDefault();
      document.execCommand(e.shiftKey ? 'outdent' : 'indent');
      syncBody();
    }
  }
});

// ---------- colar / arrastar (prints, HTML limpo) ----------
const ALLOWED = new Set(['P', 'BR', 'H1', 'H2', 'H3', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'DEL',
  'UL', 'OL', 'LI', 'BLOCKQUOTE', 'PRE', 'CODE', 'A', 'IMG', 'HR', 'DIV', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH']);
const DROP = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'META', 'LINK', 'TITLE', 'HEAD', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'FORM', 'INPUT', 'BUTTON', 'SELECT', 'TEXTAREA']);

function sanitizeHTML(html) {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  const walk = (node) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === 8) { child.remove(); continue; }
      if (child.nodeType !== 1) continue;
      const tag = child.nodeName;
      if (DROP.has(tag)) { child.remove(); continue; }
      walk(child);
      if (!ALLOWED.has(tag)) {
        if (tag === 'H4' || tag === 'H5' || tag === 'H6') {
          const h3 = doc.createElement('h3');
          h3.append(...child.childNodes);
          child.replaceWith(h3);
        } else {
          child.replaceWith(...child.childNodes);
        }
        continue;
      }
      const keep = {};
      if (tag === 'A') {
        const href = child.getAttribute('href') || '';
        if (/^(https?:|mailto:)/i.test(href)) keep.href = href;
      }
      if (tag === 'IMG') {
        const src = child.getAttribute('src') || '';
        if (/^(https:|data:image\/)/i.test(src)) keep.src = src;
        else { child.remove(); continue; }
      }
      if (tag === 'UL' && child.classList.contains('checklist')) keep.class = 'checklist';
      if (tag === 'LI' && child.hasAttribute('data-checked')) keep['data-checked'] = '';
      for (const attr of [...child.attributes]) child.removeAttribute(attr.name);
      for (const [k, v] of Object.entries(keep)) child.setAttribute(k, v);
    }
  };
  walk(doc.body);
  return doc.body.innerHTML;
}

function escapeHTML(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fileToDataURL(file, maxW = 1600) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, maxW / img.naturalWidth);
      const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * scale);
      c.height = Math.round(img.naturalHeight * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      resolve(c.toDataURL('image/webp', 0.9));
    };
    img.onerror = (e) => { URL.revokeObjectURL(url); reject(e); };
    img.src = url;
  });
}

async function insertImages(files) {
  for (const f of files) {
    try {
      const src = await fileToDataURL(f);
      document.execCommand('insertHTML', false, `<img src="${src}" alt=""><p><br></p>`);
    } catch (err) { console.error(err); }
  }
  syncBody();
}

bodyEl.addEventListener('paste', (e) => {
  const cd = e.clipboardData;
  const images = [...cd.files].filter((f) => f.type.startsWith('image/'));
  if (images.length) {
    e.preventDefault();
    insertImages(images);
    return;
  }
  const html = cd.getData('text/html');
  e.preventDefault();
  if (html) {
    document.execCommand('insertHTML', false, sanitizeHTML(html));
  } else {
    const text = cd.getData('text/plain');
    document.execCommand('insertText', false, text);
  }
  syncBody();
});
bodyEl.addEventListener('dragover', (e) => {
  if ([...e.dataTransfer.items].some((i) => i.kind === 'file')) e.preventDefault();
});
bodyEl.addEventListener('drop', (e) => {
  const images = [...e.dataTransfer.files].filter((f) => f.type.startsWith('image/'));
  if (!images.length) return;
  e.preventDefault();
  const pos = document.caretRangeFromPoint(e.clientX, e.clientY);
  if (pos) { const s = getSelection(); s.removeAllRanges(); s.addRange(pos); }
  insertImages(images);
});
// impede que arrastar arquivo para fora do editor "navegue" a janela
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

// ---------- teclado global da tela de notas ----------
document.addEventListener('keydown', (e) => {
  if (ui.active !== 'notes') return;
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 'n') { e.preventDefault(); newNote(); return; }
  if (mod && e.key.toLowerCase() === 'f' && notes.view === 'list') { e.preventDefault(); $('#search').focus(); return; }
  if (e.key === 'Escape' && notes.view === 'detail' && $('#link-box').hidden) { e.preventDefault(); backToList(); }
});

// atualiza "editada há X" de tempos em tempos
setInterval(() => { if (ui.active === 'notes' && notes.view === 'list') renderList(); }, 60_000);

// =============================================================================
// Inicialização
// =============================================================================
(async function init() {
  const info = await desk.info();
  ui.tabs = info.tabs;
  ui.states = info.states || {};
  document.documentElement.dataset.platform = info.platform;

  desk.onTabState((s) => {
    const { id, ...rest } = s;
    ui.states[id] = { ...(ui.states[id] || {}), ...rest };
    renderTabs();
  });
  desk.onActiveTab((id) => { if (id !== ui.active) applyActive(id); });

  await loadNotes();
  buildTabs();
  renderList();
  applyActive(info.active, false);
}());
