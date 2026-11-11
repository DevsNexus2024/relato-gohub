// Teste visual: abre o app com dados temporários, cria notas de exemplo e
// salva screenshots de cada aba em SNAP_DIR. Uso: SNAP_DIR=/tmp/x electron scripts/snapshot.js
const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const out = process.env.SNAP_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'desk-snap-'));
app.setPath('userData', path.join(out, 'userdata'));
fs.mkdirSync(app.getPath('userData'), { recursive: true });
const now = Date.now();
fs.writeFileSync(path.join(app.getPath('userData'), 'notes.json'), JSON.stringify({ version: 1, notes: [
  { id: 'a', title: 'Reunião de alinhamento — integração das empresas', html: '<p>Pontos discutidos com a diretoria.</p><ul class="checklist"><li data-checked>Mapear sistemas atuais</li><li>Documentar processos no GoHub</li></ul>', text: 'Pontos discutidos com a diretoria. Mapear sistemas atuais. Documentar processos no GoHub.', tags: ['reunião', 'integração'], color: 'blue', pinned: true, createdAt: now - 864e5 * 3, updatedAt: now - 36e5 * 2 },
  { id: 'b', title: 'Pendências da semana', html: '<h2>Para reportar</h2><ol><li>Migração do ERP</li><li>Ajuste de permissões</li></ol>', text: 'Para reportar\nMigração do ERP\nAjuste de permissões', tags: ['semanal'], color: 'orange', pinned: false, createdAt: now - 864e5, updatedAt: now - 6e5 },
  { id: 'c', title: '', html: '<p>Rascunho rápido sem título com um texto um pouco maior para ver como o card corta as linhas quando a anotação é longa demais e precisa de reticências no final.</p>', text: 'Rascunho rápido sem título com um texto um pouco maior para ver como o card corta as linhas quando a anotação é longa demais e precisa de reticências no final.', tags: [], color: 'none', pinned: false, createdAt: now - 864e5 * 9, updatedAt: now - 864e5 * 8 },
] }));

require('../src/main.js');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
app.whenReady().then(async () => {
  await wait(9000);
  const { views, switchTab, getWindow } = global.__desk;
  const win = getWindow();
  const ui = await win.webContents.capturePage();
  const save = (name, img) => fs.writeFileSync(path.join(out, name), img.toPNG());
  for (const [id, view] of views) {
    switchTab(id);
    await wait(800);
    save(`${id}-sidebar.png`, await win.webContents.capturePage());
    save(`${id}-page.png`, await view.webContents.capturePage());
    console.log(id, 'url=', view.webContents.getURL(), 'title=', view.webContents.getTitle());
  }
  console.log('UA=', views.values().next().value.webContents.getUserAgent());
  switchTab('notes');
  await wait(600);
  save('notes-list.png', await win.webContents.capturePage());
  await win.webContents.executeJavaScript("document.querySelector('.card').click()");
  await wait(600);
  save('notes-detail.png', await win.webContents.capturePage());
  console.log('snapshots em', out);
  app.exit(0);
});
