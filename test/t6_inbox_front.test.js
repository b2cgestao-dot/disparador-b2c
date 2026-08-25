// T6 (front) - Inbox no navegador real: lista via Realtime, thread, envio, resposta chega ao vivo, fechar.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { API, SEED, sb, seedAccount, simulateInbound, mockMessages, waitFor } from './helpers.mjs';
import { launchBrowser } from './browser.mjs';

let browser, page, acc, from, convId;
before(async () => {
  acc = await seedAccount();
  from = '5511' + String(Math.floor(100000000 + Math.random() * 899999999)).slice(0, 9);
  browser = await launchBrowser();
  page = await browser.newPage();
  await page.goto(`${API}/#/apioficial/inbox`);
  await page.waitFor('window.App && App.ready', { label: 'App.ready' });
  await page.eval(`App.login(${JSON.stringify(SEED.user.email)}, ${JSON.stringify(SEED.user.password)})`);
  await page.waitFor('!!(App.state.user && App.state.tab === "inbox" && App.inbox.channel)', { label: 'aba inbox' });
  await new Promise((r) => setTimeout(r, 800));
});
after(async () => {
  await page?.close(); await browser?.close();
  if (convId) await sb.from('wa_conversations').delete().eq('id', convId);
  await sb.from('wa_contacts').delete().eq('account_id', acc.id).eq('phone', from);
});

test('T6 front: inbound novo aparece na lista sem recarregar (Realtime)', async () => {
  const r = await simulateInbound({ phone_number_id: acc.phone_number_id, from, name: 'Lead UI', type: 'text', text: 'Oi pela UI' });
  assert.equal(r.status, 200);
  await page.waitFor(`document.querySelector('#inbox-list').textContent.includes('Lead UI')`, { timeout: 8000, label: 'conversa na lista' });
  convId = await page.eval(`App.inbox.list.find(c => c.contact && c.contact.phone === ${JSON.stringify(from)}).id`);
  assert.ok(convId);
});

test('T6 front: abrir a conversa mostra a mensagem e zera nao-lidas', async () => {
  await page.click(`[data-conv-id="${convId}"]`);
  await page.waitFor(`App.inbox.current && App.inbox.current.id === "${convId}"`, { label: 'conversa aberta' });
  await page.waitFor(`document.querySelector('#thread-messages').textContent.includes('Oi pela UI')`, { label: 'mensagem na thread' });
  assert.equal(await page.visible('#composer-open'), true, 'janela aberta: composer de texto visivel');
  await waitFor(async () => (await sb.from('wa_conversations').select('unread_count').eq('id', convId).single()).data.unread_count === 0, { label: 'unread zerado' });
});

test('T6 front: enviar resposta grava outbound e chega no mock', async () => {
  await page.type('#composer-text', 'Resposta pela UI');
  await page.click('#composer-send');
  await page.waitFor(`document.querySelector('#thread-messages').textContent.includes('Resposta pela UI')`, { label: 'bolha outbound' });
  const sent = await waitFor(async () => { const l = await mockMessages({ to: from }); return l.length ? l : null; }, { label: 'mock recebeu' });
  assert.equal(sent[0].body, 'Resposta pela UI');
});

test('T6 front: nova mensagem do lead aparece na thread ao vivo', async () => {
  const r = await simulateInbound({ phone_number_id: acc.phone_number_id, from, type: 'text', text: 'Chegou ao vivo?' });
  assert.equal(r.status, 200);
  await page.waitFor(`document.querySelector('#thread-messages').textContent.includes('Chegou ao vivo?')`, { timeout: 8000, label: 'realtime na thread' });
});

test('T6 front: assumir, nota interna e fechar conversa', async () => {
  await page.click('#th-assign');
  await page.waitFor(`document.querySelector('#thread-assigned').textContent.includes(${JSON.stringify(SEED.user.email)})`, { label: 'assumida' });
  await page.type('#side-note-text', 'nota pela UI');
  await page.click('#side-note-add');
  await page.waitFor(`document.querySelector('#side-notes').textContent.includes('nota pela UI')`, { label: 'nota' });
  await page.click('#th-close');
  await waitFor(async () => (await sb.from('wa_conversations').select('status').eq('id', convId).single()).data.status === 'closed', { label: 'fechada' });
  assert.deepEqual(page.errors.filter((e) => !/favicon/.test((e.url || '') + (e.text || ''))), [], JSON.stringify(page.errors));
});
