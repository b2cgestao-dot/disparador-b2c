// T5 - Webhook da Meta: verificacao, inbound assinado (via mock), assinatura invalida,
// midia no Storage, janela de 24h, status de entrega, dedup por wamid.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { api, sb, uid, createTestAccount, deleteAccount, simulateInbound, waitFor, SUPABASE_URL } from './helpers.mjs';

let acc;
before(async () => { acc = await createTestAccount({ display_phone: '+55 11 98888-0001' }); });
after(async () => { if (acc) await deleteAccount(acc.id); });

const phone = () => '5511' + String(Math.floor(100000000 + Math.random() * 899999999)).slice(0, 9);
const msgByWamid = (wamid) => sb.from('wa_messages').select('*').eq('wamid', wamid).maybeSingle().then((r) => r.data);

test('T5: GET /whatsapp/webhook com verify_token certo ecoa o hub.challenge', async () => {
  const ch = 'desafio-' + uid(3);
  const r = await api(`/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(acc.verify_token)}&hub.challenge=${ch}`);
  assert.equal(r.status, 200);
  assert.equal(r.body, ch, 'corpo = challenge cru');
  const bad = await api(`/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=errado&hub.challenge=${ch}`);
  assert.equal(bad.status, 403);
  const noMode = await api(`/whatsapp/webhook?hub.verify_token=${encodeURIComponent(acc.verify_token)}&hub.challenge=${ch}`);
  assert.equal(noMode.status, 403);
});

test('T5: inbound de texto (assinado pelo mock) cria contato, conversa e mensagem; janela = +24h', async () => {
  const from = phone();
  const t0 = Date.now();
  const r = await simulateInbound({ phone_number_id: acc.phone_number_id, from, name: 'Maria Lead', type: 'text', text: 'Oi, quero saber mais' });
  assert.equal(r.delivered, true, JSON.stringify(r));
  assert.equal(r.status, 200, 'backend respondeu 200: ' + JSON.stringify(r.body));
  const msg = await waitFor(() => msgByWamid(r.wamid), { label: 'mensagem gravada' });
  assert.equal(msg.direction, 'in');
  assert.equal(msg.type, 'text');
  assert.equal(msg.body, 'Oi, quero saber mais');
  assert.equal(msg.account_id, acc.id);
  const { data: contact } = await sb.from('wa_contacts').select('*').eq('id', msg.contact_id).single();
  assert.equal(contact.phone, from);
  assert.equal(contact.name, 'Maria Lead');
  assert.ok(contact.last_inbound_at);
  const { data: conv } = await sb.from('wa_conversations').select('*').eq('id', msg.conversation_id).single();
  assert.equal(conv.status, 'open');
  assert.equal(conv.unread_count, 1);
  assert.equal(conv.last_direction, 'in');
  assert.equal(conv.last_message_preview, 'Oi, quero saber mais');
  const exp = new Date(conv.window_expires_at).getTime();
  assert.ok(Math.abs(exp - (t0 + 24 * 3600e3)) < 60e3, `window_expires_at ~ agora+24h (diff ${exp - t0 - 24 * 3600e3}ms)`);
  // segunda mensagem: mesma conversa, unread 2
  const r2 = await simulateInbound({ phone_number_id: acc.phone_number_id, from, type: 'text', text: 'alo?' });
  const msg2 = await waitFor(() => msgByWamid(r2.wamid), { label: 'segunda mensagem' });
  assert.equal(msg2.conversation_id, conv.id);
  const { data: conv2 } = await sb.from('wa_conversations').select('unread_count, last_message_preview').eq('id', conv.id).single();
  assert.equal(conv2.unread_count, 2);
  assert.equal(conv2.last_message_preview, 'alo?');
  // evento cru gravado
  const { data: ev } = await sb.from('wa_webhook_events').select('*').eq('account_id', acc.id).eq('signature_valid', true).order('created_at', { ascending: false }).limit(1).single();
  assert.equal(ev.event_type, 'messages');
  assert.equal(ev.phone_number_id, acc.phone_number_id);
});

test('T5: assinatura invalida e rejeitada (401) sem gravar mensagem', async () => {
  const from = phone();
  const r = await simulateInbound({ phone_number_id: acc.phone_number_id, from, type: 'text', text: 'hacker', bad_signature: true });
  assert.equal(r.delivered, true);
  assert.equal(r.status, 401, JSON.stringify(r.body));
  await new Promise((res) => setTimeout(res, 300));
  assert.equal(await msgByWamid(r.wamid), null, 'nenhuma mensagem gravada');
  const { data: c } = await sb.from('wa_contacts').select('id').eq('account_id', acc.id).eq('phone', from);
  assert.equal(c.length, 0, 'nenhum contato criado');
  const { data: ev } = await sb.from('wa_webhook_events').select('*').eq('account_id', acc.id).eq('signature_valid', false).limit(1);
  assert.equal(ev.length, 1, 'evento cru registrado como assinatura invalida');
});

test('T5: sem header de assinatura tambem e rejeitado; phone_number_id desconhecido nao derruba', async () => {
  const raw = Buffer.from(JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'x', changes: [{ field: 'messages', value: { metadata: { phone_number_id: acc.phone_number_id }, messages: [] } }] }] }));
  const r = await api('/whatsapp/webhook', { method: 'POST', raw, headers: { 'Content-Type': 'application/json' } });
  assert.equal(r.status, 401);
  const r2 = await simulateInbound({ phone_number_id: 'PNID-INEXISTENTE', from: phone(), type: 'text', text: 'oi', app_secret: 'qualquer' });
  assert.equal(r2.status, 404);
  const h = await api('/health');
  assert.equal(h.status, 200);
});

test('T5: mensagem de midia salva o arquivo no bucket wa-media e grava a URL', async () => {
  const from = phone();
  const r = await simulateInbound({ phone_number_id: acc.phone_number_id, from, type: 'image', caption: 'foto do produto' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const msg = await waitFor(() => msgByWamid(r.wamid), { label: 'mensagem de midia' });
  assert.equal(msg.type, 'image');
  assert.equal(msg.body, 'foto do produto');
  assert.equal(msg.media_mime, 'image/png');
  assert.ok(msg.media_url?.includes('/storage/v1/object/public/wa-media/'), 'media_url aponta pro bucket: ' + msg.media_url);
  assert.ok(msg.media_url.startsWith(SUPABASE_URL), 'URL publica usa o host visivel pelo navegador');
  assert.ok(msg.media_path?.startsWith(acc.id + '/'), 'media_path por conta');
  const { data: obj, error } = await sb.storage.from('wa-media').download(msg.media_path);
  assert.equal(error, null, error?.message);
  assert.ok(obj.size > 0, 'arquivo no bucket');
  const pub = await fetch(msg.media_url);
  assert.equal(pub.status, 200);
  assert.match(pub.headers.get('content-type') || '', /image\/png/);
});

test('T5: clique em botao de template chega como type=button com o texto no body', async () => {
  const from = phone();
  const r = await simulateInbound({ phone_number_id: acc.phone_number_id, from, type: 'button', button_text: 'Quero saber mais', button_payload: 'Quero saber mais', context_wamid: 'wamid.MOCK-tpl-1' });
  assert.equal(r.status, 200);
  const msg = await waitFor(() => msgByWamid(r.wamid), { label: 'botao' });
  assert.equal(msg.type, 'button');
  assert.equal(msg.body, 'Quero saber mais');
  assert.equal(msg.payload?.button?.payload, 'Quero saber mais');
  assert.equal(msg.payload?.context?.id, 'wamid.MOCK-tpl-1');
});

test('T5: status de entrega (delivered/read/failed) atualiza a mensagem outbound pelo wamid', async () => {
  const from = phone();
  const first = await simulateInbound({ phone_number_id: acc.phone_number_id, from, type: 'text', text: 'oi' });
  const inMsg = await waitFor(() => msgByWamid(first.wamid), { label: 'inbound' });
  const wamid = 'wamid.MOCK-out-' + uid(4);
  await sb.from('wa_messages').insert({ conversation_id: inMsg.conversation_id, account_id: acc.id, contact_id: inMsg.contact_id, direction: 'out', type: 'text', body: 'resposta', wamid, status: 'sent' });
  await sb.from('whatsapp_api_sends').insert({ account_id: acc.id, job_id: 'job-' + uid(3), phone: from, status: 'sent', wamid });
  for (const st of ['delivered', 'read']) {
    const r = await simulateInbound({ phone_number_id: acc.phone_number_id, from, type: 'status', wamid, status: st });
    assert.equal(r.status, 200);
    await waitFor(async () => (await msgByWamid(wamid)).status === st, { label: 'status ' + st });
  }
  const f = await simulateInbound({ phone_number_id: acc.phone_number_id, from, type: 'status', wamid, status: 'failed', errors: [{ code: 131047, title: 'Re-engagement message' }] });
  assert.equal(f.status, 200);
  const failed = await waitFor(async () => { const m = await msgByWamid(wamid); return m.status === 'failed' ? m : null; }, { label: 'failed' });
  assert.equal(failed.error?.[0]?.code, 131047);
  const { data: send } = await sb.from('whatsapp_api_sends').select('status, error_code').eq('wamid', wamid).single();
  assert.equal(send.status, 'failed');
  assert.equal(send.error_code, 131047);
});

test('T5: reenvio do mesmo wamid (retry da Meta) nao duplica a mensagem', async () => {
  const from = phone();
  const wamid = 'wamid.MOCK-dup-' + uid(4);
  const a = await simulateInbound({ phone_number_id: acc.phone_number_id, from, type: 'text', text: 'uma vez', wamid });
  const b = await simulateInbound({ phone_number_id: acc.phone_number_id, from, type: 'text', text: 'uma vez', wamid });
  assert.equal(a.status, 200); assert.equal(b.status, 200);
  await waitFor(() => msgByWamid(wamid), { label: 'msg' });
  const { data } = await sb.from('wa_messages').select('id').eq('wamid', wamid);
  assert.equal(data.length, 1);
  const { data: conv } = await sb.from('wa_conversations').select('unread_count').eq('account_id', acc.id).eq('id', (await msgByWamid(wamid)).conversation_id).single();
  assert.equal(conv.unread_count, 1, 'retry nao incrementa unread');
});

test('T5: conversa fechada reabre quando chega mensagem nova', async () => {
  const from = phone();
  const r = await simulateInbound({ phone_number_id: acc.phone_number_id, from, type: 'text', text: 'primeira' });
  const msg = await waitFor(() => msgByWamid(r.wamid), { label: 'msg' });
  await sb.from('wa_conversations').update({ status: 'closed', closed_at: new Date().toISOString(), unread_count: 0 }).eq('id', msg.conversation_id);
  const r2 = await simulateInbound({ phone_number_id: acc.phone_number_id, from, type: 'text', text: 'voltei' });
  await waitFor(() => msgByWamid(r2.wamid), { label: 'msg2' });
  const { data: conv } = await sb.from('wa_conversations').select('status, unread_count, closed_at').eq('id', msg.conversation_id).single();
  assert.equal(conv.status, 'open');
  assert.equal(conv.unread_count, 1);
  assert.equal(conv.closed_at, null);
});
