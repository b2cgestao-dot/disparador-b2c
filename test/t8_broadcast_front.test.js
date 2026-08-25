// T8 (front) - Disparo e Relatorio no navegador: colar CSV, disparar, barra de progresso, relatorio com ajuda em PT.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { API, SEED, sb, seedAccount, authed } from './helpers.mjs';
import { launchBrowser } from './browser.mjs';

let browser, page, acc; const phones = [];
before(async () => {
  acc = await seedAccount();
  await authed(`/api-oficial/accounts/${acc.id}/sync-templates`, { method: 'POST' });
  browser = await launchBrowser();
  page = await browser.newPage();
  await page.goto(`${API}/#/apioficial/disparo`);
  await page.waitFor('window.App && App.ready', { label: 'App.ready' });
  await page.eval(`App.login(${JSON.stringify(SEED.user.email)}, ${JSON.stringify(SEED.user.password)})`);
  await page.waitFor('!!(App.state.user && App.state.tab === "disparo")', { label: 'aba disparo' });
});
after(async () => {
  await page?.close(); await browser?.close();
  for (const p of phones) await sb.from('wa_contacts').delete().eq('account_id', acc.id).eq('phone', p);
});

test('T8 front: colar CSV mostra a previa (validos/invalidos) e o seletor de template vem do cache', async () => {
  await page.waitFor(`document.querySelector('#bc-account') && document.querySelector('#bc-account').options.length > 0`, { label: 'select conta' });
  await page.eval(`(() => { const s = document.querySelector('#bc-account'); s.value = ${JSON.stringify(acc.id)}; s.dispatchEvent(new Event('change')); return true; })()`);
  await page.waitFor(`document.querySelector('#bc-template').options.length >= 4`, { timeout: 10000, label: 'templates no select' });
  const ok1 = '5511' + String(Math.floor(100000000 + Math.random() * 899999999)).slice(0, 9); const bad = '5511' + String(Math.floor(10000 + Math.random() * 89999)) + '0000';
  phones.push(ok1, bad);
  await page.type('#bc-list-name', 'Lista UI');
  await page.type('#bc-csv', `telefone,nome\n${ok1},"Ana, UI"\n${bad},Erro\n16,curto\n`);
  await page.waitFor(`document.querySelector('#bc-preview').textContent.includes('2 valido')`, { label: 'previa' });
  assert.ok((await page.eval(`document.querySelector('#bc-preview').textContent`)).includes('1 invalido'));
});

test('T8 front: Disparar mostra progresso ate 100% e o resumo; Relatorio explica o erro em PT', async () => {
  await page.eval(`(() => { const s = document.querySelector('#bc-template'); s.value = [...s.options].find(o => o.textContent.includes('hello_world')).value; s.dispatchEvent(new Event('change')); return true; })()`);
  await page.click('#bc-send');
  await page.waitFor(`App.bc.job && App.bc.job.done === true`, { timeout: 20000, label: 'job concluido na UI' });
  const bar = await page.eval(`document.querySelector('#bc-progress').style.width`);
  assert.equal(bar, '100%');
  const summary = await page.eval(`document.querySelector('#bc-summary').textContent`);
  assert.ok(summary.includes('1 enviad') && summary.includes('1 falh'), summary);
  await page.click('#bc-open-report');
  await page.waitFor(`App.state.tab === 'relatorio' && document.querySelector('#rep-rows').textContent.includes('131047')`, { timeout: 10000, label: 'relatorio' });
  const rep = await page.eval(`document.querySelector('#rep-rows').textContent`);
  assert.match(rep, /24 ?h|janela/i, 'motivo em PT no relatorio');
  assert.deepEqual(page.errors.filter((e) => !/favicon/.test((e.url || '') + (e.text || ''))), [], JSON.stringify(page.errors));
});
