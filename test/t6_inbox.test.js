// T6 - Inbox multiagente: envio com janela de 24h, atribuir/liberar/lida/fechar, notas, Realtime.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { authed, api, sb, uid, createTestAccount, deleteAccount, simulateInbound, waitFor, mockMessages, anonClient, SEED, sleep } from './helpers.mjs';

let acc;
before(async () => { acc = await createTestAccount(); });
after(async () => { if (acc) await deleteAccount(acc.id); });

const phone = () => '5511' + String(Math.floor(100000000 + Math.random() * 899999999)).slice(0, 9);
const msgByWamid = (wamid) => sb.from('wa_messages').select('*').eq('wamid', wamid).maybeSingle().then((r) => r.data);
async function openConversation(from = phone(), text = 'oi') {
  const r = await simulateInbound({ phone_number_id: acc.phone_number_id, from, name: 'Lead ' + from.slice(-4), type: 'text', text });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const msg = await waitFor(() => msgByWamid(r.wamid), { label: 'inbound' });
  const { data: conv } = await sb.from('wa_conversations').select('*').eq('id', msg.conversation_id).single();
  return { conv, msg, from };
}

test('T6: rotas do inbox exigem autenticacao', async () => {
  assert.equal((await api('/api-oficial/conversations')).status, 401);
  assert.equal((await api('/api-oficial/conversations/x/send', { method: 'POST', body: { text: 'a' } })).status, 401);
});

test('T6: enviar DENTRO da janela grava outbound e chama o envio no mock-meta', async () => {
  const { conv, from } = await openConversation();
  const r = await authed(`/api-oficial/conversations/${conv.id}/send`, { method: 'POST', body: { text: 'Ola! Posso ajudar?' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.ok, true);
  assert.match(r.body.wamid, /^wamid\.MOCK-/);
  const sent = await mockMessages({ to: from });
  assert.equal(sent.length, 1, 'mock recebeu 1 envio');
  assert.equal(sent[0].type, 'text');
  assert.equal(sent[0].body, 'Ola! Posso ajudar?');
  assert.equal(sent[0].phone_number_id, acc.phone_number_id);
  const out = await msgByWamid(r.body.wamid);
  assert.equal(out.direction, 'out');
  assert.equal(out.conversation_id, conv.id);
  assert.equal(out.body, 'Ola! Posso ajudar?');
  assert.equal(out.sent_by_email, SEED.user.email);
  assert.equal(out.is_flow, false);
  const { data: c2 } = await sb.from('wa_conversations').select('*').eq('id', conv.id).single();
  assert.equal(c2.last_direction, 'out');
  assert.equal(c2.last_message_preview, 'Ola! Posso ajudar?');
  assert.equal(c2.window_expires_at, conv.window_expires_at, 'envio nao altera a janela');
});

test('T6: enviar FORA da janela retorna JANELA_FECHADA e nao envia texto livre; template pode', async () => {
  const { conv, from } = await openConversation();
  await sb.from('wa_conversations').update({ window_expires_at: new Date(Date.now() - 60e3).toISOString() }).eq('id', conv.id);
  const r = await authed(`/api-oficial/conversations/${conv.id}/send`, { method: 'POST', body: { text: 'texto livre' } });
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.error, 'JANELA_FECHADA');
  assert.ok(r.body.window_expires_at);
  assert.equal((await mockMessages({ to: from })).length, 0, 'nada enviado ao mock');
  const { data: outs } = await sb.from('wa_messages').select('id').eq('conversation_id', conv.id).eq('direction', 'out');
  assert.equal(outs.length, 0);
  // template e permitido fora da janela
  const t = await authed(`/api-oficial/conversations/${conv.id}/send`, { method: 'POST', body: { template: { name: 'hello_world', language: 'en_US' } } });
  assert.equal(t.status, 200, JSON.stringify(t.body));
  const sent = await mockMessages({ to: from });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'template');
  assert.equal(sent[0].payload.template.name, 'hello_world');
  const out = await msgByWamid(t.body.wamid);
  assert.equal(out.type, 'template');
  assert.equal(out.template_name, 'hello_world');
  // conversa sem janela nenhuma (nunca recebeu) tambem fecha o texto livre
  await sb.from('wa_conversations').update({ window_expires_at: null }).eq('id', conv.id);
  const r2 = await authed(`/api-oficial/conversations/${conv.id}/send`, { method: 'POST', body: { text: 'x' } });
  assert.equal(r2.status, 409);
  assert.equal(r2.body.error, 'JANELA_FECHADA');
});

test('T6: erro da Meta no envio vira 502 META_ERROR e a mensagem fica gravada como failed', async () => {
  const from = '5511' + uid(2).replace(/\D/g, '').padEnd(5, '7') + '0000'; // termina em 0000 -> 131047 no mock
  const { conv } = await openConversation(from);
  const r = await authed(`/api-oficial/conversations/${conv.id}/send`, { method: 'POST', body: { text: 'vai falhar' } });
  assert.equal(r.status, 502, JSON.stringify(r.body));
  assert.equal(r.body.error, 'META_ERROR');
  assert.equal(r.body.code, 131047);
  const { data: outs } = await sb.from('wa_messages').select('*').eq('conversation_id', conv.id).eq('direction', 'out');
  assert.equal(outs.length, 1);
  assert.equal(outs[0].status, 'failed');
  assert.equal(outs[0].error?.code, 131047);
});

test('T6: atribuir/liberar/marcar lida/fechar/reabrir alteram o estado da conversa', async () => {
  const { conv } = await openConversation();
  assert.equal(conv.unread_count, 1);
  let r = await authed(`/api-oficial/conversations/${conv.id}/assign`, { method: 'POST', body: {} });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.assigned_email, SEED.user.email);
  assert.ok(r.body.assigned_to);
  r = await authed(`/api-oficial/conversations/${conv.id}/read`, { method: 'POST' });
  assert.equal(r.status, 200); assert.equal(r.body.unread_count, 0);
  r = await authed(`/api-oficial/conversations/${conv.id}/status`, { method: 'POST', body: { status: 'closed' } });
  assert.equal(r.status, 200); assert.equal(r.body.status, 'closed'); assert.ok(r.body.closed_at);
  r = await authed(`/api-oficial/conversations/${conv.id}/status`, { method: 'POST', body: { status: 'invalido' } });
  assert.equal(r.status, 400);
  r = await authed(`/api-oficial/conversations/${conv.id}/status`, { method: 'POST', body: { status: 'open' } });
  assert.equal(r.status, 200); assert.equal(r.body.status, 'open'); assert.equal(r.body.closed_at, null);
  r = await authed(`/api-oficial/conversations/${conv.id}/release`, { method: 'POST' });
  assert.equal(r.status, 200); assert.equal(r.body.assigned_to, null); assert.equal(r.body.assigned_email, null);
  const { data: db } = await sb.from('wa_conversations').select('*').eq('id', conv.id).single();
  assert.equal(db.assigned_to, null); assert.equal(db.unread_count, 0); assert.equal(db.status, 'open');
  assert.equal((await authed(`/api-oficial/conversations/00000000-0000-0000-0000-000000000000/read`, { method: 'POST' })).status, 404);
});

test('T6: nota interna e gravada em wa_internal_notes com autor', async () => {
  const { conv } = await openConversation();
  const bad = await authed(`/api-oficial/conversations/${conv.id}/notes`, { method: 'POST', body: { body: '   ' } });
  assert.equal(bad.status, 400);
  const r = await authed(`/api-oficial/conversations/${conv.id}/notes`, { method: 'POST', body: { body: 'Cliente pediu orcamento' } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.author_email, SEED.user.email);
  const { data } = await sb.from('wa_internal_notes').select('*').eq('conversation_id', conv.id);
  assert.equal(data.length, 1);
  assert.equal(data[0].body, 'Cliente pediu orcamento');
  const list = await authed(`/api-oficial/conversations/${conv.id}/notes`);
  assert.equal(list.status, 200); assert.equal(list.body.length, 1);
});

test('T6: listar conversas (com contato) e mensagens da conversa', async () => {
  const { conv, from } = await openConversation(phone(), 'quero orcamento');
  await authed(`/api-oficial/conversations/${conv.id}/send`, { method: 'POST', body: { text: 'claro!' } });
  const list = await authed(`/api-oficial/conversations?account_id=${acc.id}&status=open`);
  assert.equal(list.status, 200);
  const item = list.body.find((c) => c.id === conv.id);
  assert.ok(item, 'conversa na lista');
  assert.equal(item.contact.phone, from);
  assert.equal(item.contact.name, 'Lead ' + from.slice(-4));
  assert.equal(item.last_message_preview, 'claro!');
  const msgs = await authed(`/api-oficial/conversations/${conv.id}/messages`);
  assert.equal(msgs.status, 200);
  assert.deepEqual(msgs.body.map((m) => m.direction), ['in', 'out']);
  const mine = await authed(`/api-oficial/conversations?account_id=${acc.id}&assigned=me`);
  assert.ok(!mine.body.some((c) => c.id === conv.id), 'nao atribuida nao aparece em "minhas"');
  await authed(`/api-oficial/conversations/${conv.id}/assign`, { method: 'POST', body: {} });
  const mine2 = await authed(`/api-oficial/conversations?account_id=${acc.id}&assigned=me`);
  assert.ok(mine2.body.some((c) => c.id === conv.id));
});

test('T6: contato: editar nome/tags/opt_out pelo backend', async () => {
  const { msg } = await openConversation();
  const r = await authed(`/api-oficial/contacts/${msg.contact_id}`, { method: 'PATCH', body: { name: 'Joao Renomeado', tags: ['vip', 'sp'], opt_out: true } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const { data } = await sb.from('wa_contacts').select('*').eq('id', msg.contact_id).single();
  assert.equal(data.name, 'Joao Renomeado'); assert.deepEqual(data.tags, ['vip', 'sp']); assert.equal(data.opt_out, true);
});

test('T6: nova mensagem inbound (via mock) chega pelo Realtime num cliente autenticado', async () => {
  const c = anonClient();
  const { data: auth, error } = await c.auth.signInWithPassword({ email: SEED.user.email, password: SEED.user.password });
  assert.equal(error, null);
  c.realtime.setAuth(auth.session.access_token);
  const received = [];
  const channel = c.channel('t6-inbox-' + uid(3))
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'wa_messages' }, (p) => received.push(p.new));
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout subscribe realtime')), 10000);
    channel.subscribe((status, err) => { if (status === 'SUBSCRIBED') { clearTimeout(t); resolve(); } if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') { clearTimeout(t); reject(new Error('realtime: ' + status + ' ' + (err?.message || ''))); } });
  });
  await sleep(1500); // realtime local demora um pouco pra ligar a replicacao (mais logo apos subir)
  const from = phone();
  const r = await simulateInbound({ phone_number_id: acc.phone_number_id, from, type: 'text', text: 'realtime?' });
  assert.equal(r.status, 200);
  const ev = await waitFor(() => received.find((m) => m.wamid === r.wamid), { timeout: 15000, label: 'evento realtime' });
  assert.equal(ev.body, 'realtime?');
  assert.equal(ev.direction, 'in');
  await c.removeChannel(channel);
  c.realtime.disconnect();
  await c.auth.signOut();
});

// o cliente realtime mantem o event loop vivo; garante que o processo do teste termina
after(() => { setTimeout(() => process.exit(process.exitCode || 0), 1500).unref(); });

test('T6: 9o digito BR - envio vai pro numero COM 9, guarda o wa_id sem 9 e a resposta cai na mesma conversa', async () => {
  const with9 = '5575' + '9' + String(6 + Math.floor(Math.random() * 4)) + String(Math.floor(1000000 + Math.random() * 8999999)); // 55 DDD 9 [6-9]XXXXXXX (celular)
  const without9 = with9.slice(0, 4) + with9.slice(5);
  const { conv, msg } = await openConversation(with9, 'oi');
  const r = await authed(`/api-oficial/conversations/${conv.id}/send`, { method: 'POST', body: { text: 'ola' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const sent = await mockMessages({ to: with9 });
  assert.equal(sent.length, 1, 'enviado pro formato com 9');
  const { data: c } = await sb.from('wa_contacts').select('phone, wa_id').eq('id', msg.contact_id).single();
  assert.equal(c.phone, with9); assert.equal(c.wa_id, without9, 'wa_id vindo da resposta da Meta (mock)');
  const back = await simulateInbound({ phone_number_id: acc.phone_number_id, from: without9, type: 'text', text: 'voltei sem o 9' });
  const m2 = await waitFor(() => msgByWamid(back.wamid), { label: 'resposta' });
  assert.equal(m2.conversation_id, conv.id, 'mesma conversa');
  const r2 = await authed(`/api-oficial/conversations/${conv.id}/send`, { method: 'POST', body: { text: 'de novo' } });
  assert.equal(r2.status, 200);
  assert.equal((await mockMessages({ to: with9 })).length, 2, 'resposta tambem vai pro formato com 9');
});
