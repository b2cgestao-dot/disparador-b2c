// T9 (front) - aba Fluxos: criar pelo formulario, listar, desativar, excluir.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { API, SEED, sb, uid } from './helpers.mjs';
import { launchBrowser } from './browser.mjs';

let browser, page; const name = 'Fluxo UI ' + uid(2);
before(async () => {
  browser = await launchBrowser();
  page = await browser.newPage();
  await page.goto(`${API}/#/apioficial/fluxos`);
  await page.waitFor('window.App && App.ready', { label: 'App.ready' });
  await page.eval(`App.login(${JSON.stringify(SEED.user.email)}, ${JSON.stringify(SEED.user.password)})`);
  await page.waitFor('!!(App.state.user && App.state.tab === "fluxos")', { label: 'aba fluxos' });
});
after(async () => { await page?.close(); await browser?.close(); await sb.from('wa_flows').delete().eq('name', name); });

test('T9 front: criar fluxo com 2 passos (delay + acoes) pelo formulario', async () => {
  await page.click('#flow-new');
  await page.waitFor('document.querySelector("#flow-dialog").open', { label: 'dialog' });
  await page.type('#flow-form [name=name]', name);
  await page.type('#flow-form [name=trigger_text]', 'Quero saber mais');
  await page.type('#flow-step-text-0', 'Oi {{nome}}, obrigado pelo interesse!');
  await page.type('#flow-step-actions-0', 'add_tag:interessado');
  await page.click('#flow-add-step');
  await page.waitFor('!!document.querySelector("#flow-step-text-1")', { label: 'passo 2' });
  await page.type('#flow-step-delay-1', '30');
  await page.type('#flow-step-text-1', 'Posso te ligar?');
  await page.click('#flow-save');
  await page.waitFor(`document.querySelector('#flow-rows').textContent.includes(${JSON.stringify(name)})`, { label: 'fluxo na lista' });
  const { data } = await sb.from('wa_flows').select('*').eq('name', name).single();
  assert.equal(data.trigger_text, 'Quero saber mais');
  assert.equal(data.steps.length, 2);
  assert.equal(data.steps[0].text, 'Oi {{nome}}, obrigado pelo interesse!');
  assert.deepEqual(data.steps[0].actions, [{ type: 'add_tag', tag: 'interessado' }]);
  assert.equal(data.steps[1].delay_s, 30);
  assert.equal(data.active, true);
});

test('T9 front: desativar e excluir pela lista', async () => {
  const { data } = await sb.from('wa_flows').select('id').eq('name', name).single();
  await page.click(`tr[data-flow-id="${data.id}"] button[data-act="toggle"]`);
  await page.waitFor(`App.flows.list.find(f => f.id === "${data.id}").active === false`, { label: 'desativado' });
  await page.eval('window.confirm = () => true');
  await page.click(`tr[data-flow-id="${data.id}"] button[data-act="delete"]`);
  await page.waitFor(`!App.flows.list.some(f => f.id === "${data.id}")`, { label: 'excluido' });
  const { data: gone } = await sb.from('wa_flows').select('id').eq('id', data.id);
  assert.equal(gone.length, 0);
  assert.deepEqual(page.errors.filter((e) => !/favicon/.test((e.url || '') + (e.text || ''))), [], JSON.stringify(page.errors));
});
