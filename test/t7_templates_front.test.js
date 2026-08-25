// T7 (front) - aba Templates: sincronizar pela UI, listar; o cache alimenta o seletor de template.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { API, SEED, sb, seedAccount, simulateInbound, waitFor } from './helpers.mjs';
import { launchBrowser } from './browser.mjs';

let browser, page, acc, from, convId;
before(async () => {
  acc = await seedAccount();
  await sb.from('wa_templates').delete().eq('account_id', acc.id);
  browser = await launchBrowser();
  page = await browser.newPage();
  await page.goto(`${API}/#/apioficial/templates`);
  await page.waitFor('window.App && App.ready', { label: 'App.ready' });
  await page.eval(`App.login(${JSON.stringify(SEED.user.email)}, ${JSON.stringify(SEED.user.password)})`);
  await page.waitFor('!!(App.state.user && App.state.tab === "templates")', { label: 'aba templates' });
});
after(async () => {
  await page?.close(); await browser?.close();
  if (convId) await sb.from('wa_conversations').delete().eq('id', convId);
  if (from) await sb.from('wa_contacts').delete().eq('account_id', acc.id).eq('phone', from);
});

test('T7 front: Sincronizar pela UI popula a tabela de templates', async () => {
  await page.waitFor(`document.querySelector('#tpl-account') && document.querySelector('#tpl-account').options.length > 0`, { label: 'select de conta' });
  await page.eval(`(() => { const s = document.querySelector('#tpl-account'); s.value = ${JSON.stringify(acc.id)}; s.dispatchEvent(new Event('change')); return true; })()`);
  await page.click('#tpl-sync');
  await page.waitFor(`document.querySelector('#tpl-rows').textContent.includes('promo_botao')`, { timeout: 10000, label: 'tabela com templates' });
  const html = await page.eval(`document.querySelector('#tpl-rows').innerHTML`);
  assert.ok(html.includes('hello_world') && html.includes('QUICK_REPLY'));
  const { data } = await sb.from('wa_templates').select('name').eq('account_id', acc.id);
  assert.ok(data.length >= 4);
});

test('T7 front: o cache alimenta o seletor de template (App.templateOptions e composer do inbox)', async () => {
  const opts = await page.eval(`App.templateOptions(${JSON.stringify(acc.id)}).then(l => JSON.stringify(l.map(t => t.name)))`);
  assert.ok(JSON.parse(opts).includes('promo_botao'));
  // conversa com janela fechada -> composer mostra o seletor com os templates do cache
  from = '5511' + String(Math.floor(100000000 + Math.random() * 899999999)).slice(0, 9);
  const r = await simulateInbound({ phone_number_id: acc.phone_number_id, from, name: 'Lead T7', type: 'text', text: 'oi' });
  assert.equal(r.status, 200);
  const msg = await waitFor(async () => (await sb.from('wa_messages').select('conversation_id').eq('wamid', r.wamid).maybeSingle()).data, { label: 'msg' });
  convId = msg.conversation_id;
  await sb.from('wa_conversations').update({ window_expires_at: new Date(Date.now() - 1000).toISOString() }).eq('id', convId);
  await page.eval(`App.showView('apioficial', 'inbox')`);
  await page.waitFor('!!(App.inbox && App.inbox.channel)', { label: 'inbox' });
  await page.eval(`App.inboxOpen(${JSON.stringify(convId)})`);
  await page.waitFor(`document.querySelector('#composer-template').options.length >= 4`, { timeout: 10000, label: 'seletor de template populado' });
  assert.equal(await page.visible('#composer-closed'), true);
  const names = await page.eval(`[...document.querySelector('#composer-template').options].map(o => o.textContent).join('|')`);
  assert.ok(names.includes('hello_world'));
  assert.deepEqual(page.errors.filter((e) => !/favicon/.test((e.url || '') + (e.text || ''))), [], JSON.stringify(page.errors));
});
