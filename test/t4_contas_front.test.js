// T4 (front) - aba Contas no navegador real: lista, testar, criar via formulario.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { API, SEED, sb, uid } from './helpers.mjs';
import { launchBrowser } from './browser.mjs';

let browser, page; const createdPnids = [];
before(async () => {
  browser = await launchBrowser();
  page = await browser.newPage();
  await page.goto(`${API}/#/apioficial/contas`);
  await page.waitFor('window.App && App.ready', { label: 'App.ready' });
  await page.eval(`App.login(${JSON.stringify(SEED.user.email)}, ${JSON.stringify(SEED.user.password)})`);
  await page.waitFor('App.state.user && App.state.view === "apioficial" && App.state.tab === "contas"', { label: 'aba contas' });
});
after(async () => {
  await page?.close(); await browser?.close();
  for (const p of createdPnids) await sb.from('whatsapp_api_accounts').delete().eq('phone_number_id', p);
});

test('T4 front: a aba Contas lista a conta seed sem expor segredos', async () => {
  await page.waitFor('App.accounts.length > 0', { label: 'contas carregadas' });
  const html = await page.eval('document.querySelector("#acc-rows").innerHTML');
  assert.ok(html.includes(SEED.account.phone_number_id));
  assert.ok(!html.includes(SEED.account.access_token) && !html.includes(SEED.account.app_secret));
  const acc = await page.eval(`JSON.stringify(App.accounts.find(a => a.phone_number_id === ${JSON.stringify(SEED.account.phone_number_id)}))`);
  assert.ok(!('access_token' in JSON.parse(acc)), 'objeto no front nao tem access_token');
});

test('T4 front: botao Testar chama o backend e a conta fica "testada"', async () => {
  const id = await page.eval(`App.accounts.find(a => a.phone_number_id === ${JSON.stringify(SEED.account.phone_number_id)}).id`);
  await page.click(`tr[data-account-id="${id}"] button[data-act="test"]`);
  await page.waitFor(`!document.querySelector("#toast").hidden && document.querySelector("#toast").textContent.includes("Numero de Teste")`, { label: 'toast do teste' });
  await page.waitFor(`App.accounts.find(a => a.id === "${id}").last_test_ok === true`, { label: 'recarregou com last_test_ok' });
});

test('T4 front: criar conta pelo formulario persiste no banco', async () => {
  const pnid = `PNID-UI-${uid(3)}`; createdPnids.push(pnid);
  await page.click('#acc-new');
  await page.waitFor('document.querySelector("#acc-dialog").open', { label: 'dialog aberto' });
  await page.type('#acc-form [name=label]', 'Conta via UI');
  await page.type('#acc-form [name=phone_number_id]', pnid);
  await page.type('#acc-form [name=waba_id]', 'WABA-UI');
  await page.type('#acc-form [name=access_token]', 'TOKEN-UI');
  await page.type('#acc-form [name=app_secret]', 'SECRET-UI');
  await page.type('#acc-form [name=verify_token]', 'VERIFY-UI');
  await page.click('#acc-save');
  await page.waitFor(`App.accounts.some(a => a.phone_number_id === ${JSON.stringify(pnid)})`, { label: 'conta na lista' });
  const { data } = await sb.from('whatsapp_api_accounts').select('*').eq('phone_number_id', pnid).single();
  assert.equal(data.label, 'Conta via UI');
  assert.equal(data.access_token, 'TOKEN-UI');
  assert.equal(data.app_secret, 'SECRET-UI');
  assert.equal(await page.eval('document.querySelector("#acc-dialog").open'), false, 'dialog fechou');
  assert.deepEqual(page.errors.filter((e) => !/favicon/.test((e.url || '') + (e.text || ''))), [], JSON.stringify(page.errors));
});
