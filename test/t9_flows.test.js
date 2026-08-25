// T9 - Fluxos por botao: CRUD, gatilho por QUICK_REPLY, URL/ligar nao dispara, delay, acoes, janela de 24h.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { authed, api, sb, uid, createTestAccount, deleteAccount, simulateInbound, waitFor, mockMessages, sleep } from './helpers.mjs';

let acc; const flows = [];
before(async () => {
  acc = await createTestAccount();
  const r = await authed(`/api-oficial/accounts/${acc.id}/sync-templates`, { method: 'POST' });
  assert.equal(r.status, 200);
});
after(async () => {
  for (const id of flows) await sb.from('wa_flows').delete().eq('id', id);
  if (acc) await deleteAccount(acc.id);
  setTimeout(() => process.exit(process.exitCode || 0), 1500).unref();
});

const phone = () => '5511' + String(Math.floor(100000000 + Math.random() * 899999999)).slice(0, 9);
const msgByWamid = (wamid) => sb.from('wa_messages').select('*').eq('wamid', wamid).maybeSingle().then((r) => r.data);
async function clearFlows() { if (flows.length) { await sb.from('wa_flows').delete().in('id', flows); flows.length = 0; } }
async function createFlow(body) {
  const r = await authed('/api-oficial/flows', { method: 'POST', body: { account_id: acc.id, active: true, ...body } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  flows.push(r.body.id);
  return r.body;
}
// abre conversa (inbound) e manda um template pelo inbox; retorna { conv, contact, from, tplWamid }
async function openWithTemplate(tplName, lang, from = phone(), name = 'Lead Fluxo') {
  const r = await simulateInbound({ phone_number_id: acc.phone_number_id, from, name, type: 'text', text: 'oi' });
  assert.equal(r.status, 200);
  const msg = await waitFor(() => msgByWamid(r.wamid), { label: 'inbound' });
  const t = await authed(`/api-oficial/conversations/${msg.conversation_id}/send`, { method: 'POST', body: { template: { name: tplName, language: lang } } });
  assert.equal(t.status, 200, JSON.stringify(t.body));
  return { convId: msg.conversation_id, contactId: msg.contact_id, from, tplWamid: t.body.wamid };
}
const flowMsgs = (convId) => sb.from('wa_messages').select('*').eq('conversation_id', convId).eq('is_flow', true).order('created_at').then((r) => r.data || []);

test('T9: CRUD de fluxos com validacao', async () => {
  assert.equal((await api('/api-oficial/flows')).status, 401);
  const bad = await authed('/api-oficial/flows', { method: 'POST', body: { name: 'sem gatilho', steps: [] } });
  assert.equal(bad.status, 400);
  const bad2 = await authed('/api-oficial/flows', { method: 'POST', body: { name: 'x', trigger_text: 'y', steps: [{ actions: [{ type: 'explodir' }] }] } });
  assert.equal(bad2.status, 400);
  const f = await createFlow({ name: 'Interesse', trigger_text: 'Quero saber mais', steps: [{ text: 'Legal!', delay_s: 0, actions: [{ type: 'add_tag', tag: 'interessado' }] }] });
  assert.equal(f.trigger_text, 'Quero saber mais');
  const list = await authed('/api-oficial/flows');
  assert.ok(list.body.some((x) => x.id === f.id));
  const up = await authed(`/api-oficial/flows/${f.id}`, { method: 'PUT', body: { name: 'Interesse v2', active: false } });
  assert.equal(up.status, 200); assert.equal(up.body.name, 'Interesse v2'); assert.equal(up.body.active, false);
  assert.equal(up.body.trigger_text, 'Quero saber mais', 'PUT parcial mantem o resto');
  const one = await authed(`/api-oficial/flows/${f.id}`);
  assert.equal(one.body.name, 'Interesse v2');
  const del = await authed(`/api-oficial/flows/${f.id}`, { method: 'DELETE' });
  assert.equal(del.status, 200);
  assert.equal((await authed(`/api-oficial/flows/${f.id}`)).status, 404);
});

test('T9: clique em QUICK_REPLY cujo texto casa o trigger_text dispara a resposta automatica (is_flow) e a acao add_tag', async () => {
  await clearFlows();
  const flow = await createFlow({ name: 'Interesse', trigger_text: 'quero saber MAIS  ', steps: [{ text: 'Otimo, {{nome}}! Vou te passar os detalhes.', actions: [{ type: 'add_tag', tag: 'interessado' }] }] });
  const { convId, contactId, from, tplWamid } = await openWithTemplate('promo_botao', 'pt_BR', phone(), 'Carla');
  const click = await simulateInbound({ phone_number_id: acc.phone_number_id, from, type: 'button', button_text: 'Quero saber mais', button_payload: 'Quero saber mais', context_wamid: tplWamid });
  assert.equal(click.status, 200);
  const sent = await waitFor(async () => { const l = await mockMessages({ to: from }); const m = l.find((x) => x.type === 'text'); return m || null; }, { label: 'resposta do fluxo no mock' });
  assert.equal(sent.body, 'Otimo, Carla! Vou te passar os detalhes.');
  const fm = await waitFor(async () => { const l = await flowMsgs(convId); return l.length ? l : null; }, { label: 'wa_messages is_flow' });
  assert.equal(fm[0].is_flow, true); assert.equal(fm[0].flow_id, flow.id); assert.equal(fm[0].direction, 'out'); assert.equal(fm[0].sent_by, null);
  assert.match(fm[0].wamid, /^wamid\.MOCK/);
  const { data: c } = await sb.from('wa_contacts').select('tags').eq('id', contactId).single();
  assert.ok(c.tags.includes('interessado'));
});

test('T9: clique em botao de URL/ligar NAO dispara fluxo; texto digitado igual ao gatilho tambem nao (so botao)', async () => {
  await clearFlows();
  await createFlow({ name: 'Nao deve disparar', trigger_text: 'Abrir site', steps: [{ text: 'NAO DEVERIA' }] });
  await createFlow({ name: 'So por botao', trigger_text: 'Quero saber mais', steps: [{ text: 'RESPOSTA BOTAO' }] });
  const { convId, from, tplWamid } = await openWithTemplate('aviso_link', 'pt_BR');
  // "clique" no botao URL do template aviso_link
  const r1 = await simulateInbound({ phone_number_id: acc.phone_number_id, from, type: 'button', button_text: 'Abrir site', button_payload: 'https://example.com/pedido', context_wamid: tplWamid });
  assert.equal(r1.status, 200);
  const r1b = await simulateInbound({ phone_number_id: acc.phone_number_id, from, type: 'button', button_text: 'Ligar', button_payload: '+5511999990000', context_wamid: tplWamid });
  assert.equal(r1b.status, 200);
  // texto digitado igual ao gatilho de outro fluxo
  const r2 = await simulateInbound({ phone_number_id: acc.phone_number_id, from, type: 'text', text: 'Quero saber mais' });
  assert.equal(r2.status, 200);
  await sleep(1200);
  assert.equal((await flowMsgs(convId)).length, 0, 'nenhuma resposta de fluxo');
  assert.equal((await mockMessages({ to: from })).filter((m) => m.type === 'text').length, 0);
});

test('T9: match_text=true permite disparar por texto digitado (ex.: SAIR)', async () => {
  await clearFlows();
  await createFlow({ name: 'Sair por texto', trigger_text: 'SAIR', match_text: true, steps: [{ text: 'Ok, removido.', actions: [{ type: 'opt_out' }] }] });
  const from = phone();
  const r = await simulateInbound({ phone_number_id: acc.phone_number_id, from, type: 'text', text: 'sair' });
  assert.equal(r.status, 200);
  const msg = await waitFor(() => msgByWamid(r.wamid), { label: 'inbound' });
  await waitFor(async () => (await flowMsgs(msg.conversation_id)).length === 1, { label: 'resposta' });
  const { data: c } = await sb.from('wa_contacts').select('opt_out').eq('id', msg.contact_id).single();
  assert.equal(c.opt_out, true);
});

test('T9: passo com delay respeita o atraso antes de enviar', async () => {
  await clearFlows();
  await createFlow({ name: 'Com delay', trigger_text: 'Quero saber mais', steps: [{ text: 'Passo A' }, { delay_s: 2, text: 'Passo B' }] });
  const { convId, from, tplWamid } = await openWithTemplate('promo_botao', 'pt_BR');
  const t0 = Date.now();
  await simulateInbound({ phone_number_id: acc.phone_number_id, from, type: 'button', button_text: 'Quero saber mais', context_wamid: tplWamid });
  await waitFor(async () => (await mockMessages({ to: from })).some((m) => m.body === 'Passo A'), { timeout: 3000, label: 'Passo A' });
  assert.ok(Date.now() - t0 < 1500, 'Passo A foi imediato');
  assert.ok(!(await mockMessages({ to: from })).some((m) => m.body === 'Passo B'), 'Passo B ainda nao');
  const b = await waitFor(async () => (await mockMessages({ to: from })).find((m) => m.body === 'Passo B'), { timeout: 6000, label: 'Passo B' });
  assert.ok(b.at - t0 >= 1900, `Passo B esperou o delay (${b.at - t0}ms)`);
  const fm = await flowMsgs(convId);
  assert.deepEqual(fm.map((m) => m.body), ['Passo A', 'Passo B']);
});

test('T9: acoes add_tag/remove_tag/opt_out/close alteram contato e conversa', async () => {
  await clearFlows();
  await createFlow({ name: 'Sem interesse', trigger_text: 'Nao tenho interesse', steps: [{ text: 'Tudo bem, nao vamos mais te incomodar.', actions: [{ type: 'remove_tag', tag: 'interessado' }, { type: 'add_tag', tag: 'descartado' }, { type: 'opt_out' }, { type: 'close' }] }] });
  const { convId, contactId, from, tplWamid } = await openWithTemplate('promo_botao', 'pt_BR');
  await sb.from('wa_contacts').update({ tags: ['interessado', 'lista-x'] }).eq('id', contactId);
  await simulateInbound({ phone_number_id: acc.phone_number_id, from, type: 'button', button_text: 'Nao tenho interesse', context_wamid: tplWamid });
  await waitFor(async () => (await flowMsgs(convId)).length === 1, { label: 'resposta' });
  const contact = await waitFor(async () => { const { data } = await sb.from('wa_contacts').select('*').eq('id', contactId).single(); return data.opt_out ? data : null; }, { label: 'opt_out' });
  assert.deepEqual(contact.tags.sort(), ['descartado', 'lista-x']);
  const { data: conv } = await sb.from('wa_conversations').select('status').eq('id', convId).single();
  assert.equal(conv.status, 'closed');
});

test('T9: resposta do fluxo respeita a janela de 24h (texto fora da janela nao vai; template vai)', async () => {
  await clearFlows();
  await createFlow({ name: 'Tardio', trigger_text: 'Quero saber mais', steps: [{ delay_s: 1.5, text: 'Texto tardio' }, { template: { name: 'hello_world', language: 'en_US' } }] });
  const { convId, from, tplWamid } = await openWithTemplate('promo_botao', 'pt_BR');
  await simulateInbound({ phone_number_id: acc.phone_number_id, from, type: 'button', button_text: 'Quero saber mais', context_wamid: tplWamid });
  await sleep(200);
  await sb.from('wa_conversations').update({ window_expires_at: new Date(Date.now() - 1000).toISOString() }).eq('id', convId);
  const fm = await waitFor(async () => { const l = await flowMsgs(convId); return l.length === 2 ? l : null; }, { timeout: 6000, label: '2 registros de fluxo' });
  assert.equal(fm[0].status, 'failed'); assert.equal(fm[0].error?.code, 'JANELA_FECHADA'); assert.equal(fm[0].body, 'Texto tardio');
  assert.equal(fm[1].type, 'template'); assert.equal(fm[1].status, 'accepted'); assert.equal(fm[1].template_name, 'hello_world');
  const sent = await mockMessages({ to: from });
  assert.ok(!sent.some((m) => m.body === 'Texto tardio'), 'texto nao foi pra Meta');
  assert.ok(sent.some((m) => m.type === 'template' && m.payload.template.name === 'hello_world'));
});

test('T9: fluxo inativo ou de outra conta nao dispara; fluxo global (account_id null) dispara', async () => {
  await clearFlows();
  const other = await createTestAccount();
  try {
    const inactive = await createFlow({ name: 'Inativo', trigger_text: 'Quero saber mais', active: false, steps: [{ text: 'INATIVO' }] });
    const foreign = await createFlow({ name: 'Outra conta', account_id: other.id, trigger_text: 'Quero saber mais', steps: [{ text: 'OUTRA' }] });
    const global = await createFlow({ name: 'Global', account_id: null, trigger_text: 'Quero saber mais', steps: [{ text: 'GLOBAL' }] });
    const { convId, from, tplWamid } = await openWithTemplate('promo_botao', 'pt_BR');
    await simulateInbound({ phone_number_id: acc.phone_number_id, from, type: 'button', button_text: 'Quero saber mais', context_wamid: tplWamid });
    await waitFor(async () => (await flowMsgs(convId)).length >= 1, { label: 'fluxo global' });
    await sleep(800);
    const bodies = (await flowMsgs(convId)).map((m) => m.body);
    assert.ok(bodies.includes('GLOBAL'));
    assert.ok(!bodies.includes('INATIVO') && !bodies.includes('OUTRA'));
    void inactive; void foreign; void global;
  } finally { await deleteAccount(other.id); }
});
