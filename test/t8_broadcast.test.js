// T8 - Disparo/Broadcast: job em segundo plano, polling, opt-out, CSV, telefone curto, sends-report com ajuda em PT.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { authed, api, sb, uid, createTestAccount, deleteAccount, mockMessages, waitFor, sleep } from './helpers.mjs';

let acc;
before(async () => {
  acc = await createTestAccount();
  const r = await authed(`/api-oficial/accounts/${acc.id}/sync-templates`, { method: 'POST' });
  assert.equal(r.status, 200, 'sync templates pro teste: ' + JSON.stringify(r.body));
});
after(async () => { if (acc) await deleteAccount(acc.id); });

const phone = (suffix) => '5511' + String(Math.floor(10000 + Math.random() * 89999)) + (suffix ?? String(Math.floor(1000 + Math.random() * 8999)));
const csvOf = (rows) => rows.map((r) => r.join(',')).join('\n');
async function pollUntilDone(jobId, { timeout = 30000 } = {}) {
  return waitFor(async () => { const r = await authed(`/api-oficial/broadcast/${jobId}`); assert.equal(r.status, 200); return r.body.done ? r.body : null; }, { timeout, interval: 150, label: 'job done' });
}

test('T8: rotas exigem autenticacao e validam entrada', async () => {
  assert.equal((await api('/api-oficial/broadcast', { method: 'POST', body: {} })).status, 401);
  const r = await authed('/api-oficial/broadcast', { method: 'POST', body: { account_id: acc.id } });
  assert.equal(r.status, 400);
  const r2 = await authed('/api-oficial/broadcast', { method: 'POST', body: { account_id: acc.id, template: { name: 'hello_world', language: 'en_US' }, csv: '' } });
  assert.equal(r2.status, 400, JSON.stringify(r2.body));
  assert.equal((await authed('/api-oficial/broadcast/job-inexistente')).status, 404);
});

test('T8: POST /broadcast responde na hora com {job_id,total} e o job roda em segundo plano (percent avanca)', async () => {
  const rows = Array.from({ length: 25 }, (_, i) => [phone(), `Pessoa ${i}`]);
  const t0 = Date.now();
  const r = await authed('/api-oficial/broadcast', { method: 'POST', body: { account_id: acc.id, list_name: 'Lista Grande', template: { name: 'promo_botao', language: 'pt_BR' }, csv: 'telefone,nome\n' + csvOf(rows), rate_per_sec: 8 } });
  const elapsed = Date.now() - t0;
  assert.equal(r.status, 202, JSON.stringify(r.body));
  assert.ok(r.body.job_id, 'job_id');
  assert.equal(r.body.total, 25);
  assert.ok(elapsed < 1500, `respondeu em ${elapsed}ms (nao esperou o disparo)`);
  const p1 = await authed(`/api-oficial/broadcast/${r.body.job_id}`);
  assert.equal(p1.status, 200);
  for (const k of ['total', 'sent', 'failed', 'skipped', 'processed', 'percent', 'done']) assert.ok(k in p1.body, 'campo ' + k);
  assert.equal(p1.body.done, false, 'ainda rodando logo apos o POST');
  await sleep(700);
  const p2 = await authed(`/api-oficial/broadcast/${r.body.job_id}`);
  assert.ok(p2.body.percent > p1.body.percent, `percent avancou (${p1.body.percent} -> ${p2.body.percent})`);
  const done = await pollUntilDone(r.body.job_id);
  assert.equal(done.percent, 100);
  assert.equal(done.sent, 25); assert.equal(done.failed, 0); assert.equal(done.skipped, 0); assert.equal(done.processed, 25);
  const sent = await mockMessages({ phone_number_id: acc.phone_number_id });
  assert.ok(sent.filter((m) => m.type === 'template' && m.payload.template.name === 'promo_botao').length >= 25);
  const { data: sends } = await sb.from('whatsapp_api_sends').select('*').eq('job_id', r.body.job_id);
  assert.equal(sends.length, 25);
  assert.ok(sends.every((s) => s.status === 'sent' && s.wamid?.startsWith('wamid.MOCK') && s.list_name === 'Lista Grande' && s.template_name === 'promo_botao'));
  // nome da lista vira tag no contato; mensagem outbound registrada na conversa
  const { data: c } = await sb.from('wa_contacts').select('tags, name').eq('account_id', acc.id).eq('phone', rows[0][0]).single();
  assert.ok(c.tags.includes('Lista Grande'));
  assert.equal(c.name, 'Pessoa 0');
  const { data: msgs } = await sb.from('wa_messages').select('template_name, direction').eq('account_id', acc.id).eq('contact_id', (await sb.from('wa_contacts').select('id').eq('account_id', acc.id).eq('phone', rows[0][0]).single()).data.id);
  assert.equal(msgs[0].direction, 'out'); assert.equal(msgs[0].template_name, 'promo_botao');
});

test('T8: contato com opt_out=true e contado em skipped e NAO e enviado', async () => {
  const optPhone = phone(); const okPhone = phone();
  await sb.from('wa_contacts').insert({ account_id: acc.id, phone: optPhone, name: 'Nao quero', opt_out: true });
  const r = await authed('/api-oficial/broadcast', { method: 'POST', body: { account_id: acc.id, list_name: 'optout', template: { name: 'hello_world', language: 'en_US' }, csv: csvOf([[optPhone, 'Nao quero'], [okPhone, 'Quero']]), rate_per_sec: 50 } });
  assert.equal(r.status, 202, JSON.stringify(r.body));
  assert.equal(r.body.total, 2);
  const done = await pollUntilDone(r.body.job_id);
  assert.equal(done.skipped, 1); assert.equal(done.sent, 1); assert.equal(done.processed, 2);
  assert.equal((await mockMessages({ to: optPhone })).length, 0, 'opt-out nao recebeu nada');
  assert.equal((await mockMessages({ to: okPhone })).length, 1);
  const { data: s } = await sb.from('whatsapp_api_sends').select('*').eq('job_id', r.body.job_id).eq('phone', optPhone).single();
  assert.equal(s.status, 'skipped'); assert.equal(s.skip_reason, 'opt_out');
});

test('T8: CSV com virgula dentro de aspas e parseado sem embaralhar colunas; variaveis por linha', async () => {
  const p1 = phone(); const p2 = phone();
  const csv = 'telefone,nome,var2\n' + `"${p1}","Silva, Maria","Loja ""Centro"""\n` + `${p2},Joao,Filial Norte\n`;
  const r = await authed('/api-oficial/broadcast', { method: 'POST', body: { account_id: acc.id, list_name: 'csv aspas', template: { name: 'promo_botao', language: 'pt_BR' }, csv, rate_per_sec: 50 } });
  assert.equal(r.status, 202, JSON.stringify(r.body));
  assert.equal(r.body.total, 2);
  const done = await pollUntilDone(r.body.job_id);
  assert.equal(done.sent, 2);
  const { data: s1 } = await sb.from('whatsapp_api_sends').select('*').eq('job_id', r.body.job_id).eq('phone', p1).single();
  assert.equal(s1.name, 'Silva, Maria');
  assert.deepEqual(s1.variables, ['Silva, Maria', 'Loja "Centro"']);
  const sent = (await mockMessages({ to: p1 }))[0];
  const bodyParams = sent.payload.template.components.find((c) => c.type === 'body').parameters.map((p) => p.text);
  assert.deepEqual(bodyParams, ['Silva, Maria'], 'promo_botao tem 1 variavel no corpo: nome');
  const headerParams = sent.payload.template.components.find((c) => c.type === 'header')?.parameters?.map((p) => p.text);
  assert.deepEqual(headerParams, ['Silva, Maria'], 'cabecalho "Oferta para {{1}}" tambem recebe a variavel 1');
  const { data: c } = await sb.from('wa_contacts').select('name').eq('account_id', acc.id).eq('phone', p1).single();
  assert.equal(c.name, 'Silva, Maria');
});

test('T8: telefone com menos de 10 digitos e descartado; 10/11 digitos ganham DDI 55; duplicados colapsam', async () => {
  const good = phone();
  const csv = csvOf([['16', 'Lixo'], ['11987654321', 'Sem DDI'], ['(11) 98765-4321', 'Duplicado formatado'], [good, 'Ok'], ['abc', 'Letras']]);
  const r = await authed('/api-oficial/broadcast', { method: 'POST', body: { account_id: acc.id, list_name: 'limpeza', template: { name: 'hello_world', language: 'en_US' }, csv, rate_per_sec: 50 } });
  assert.equal(r.status, 202, JSON.stringify(r.body));
  assert.equal(r.body.total, 2, 'so 2 validos e unicos');
  assert.equal(r.body.invalid, 2, '"16" e "abc" descartados');
  assert.equal(r.body.duplicates, 1);
  const done = await pollUntilDone(r.body.job_id);
  assert.equal(done.sent, 2);
  const { data: sends } = await sb.from('whatsapp_api_sends').select('phone, status').eq('job_id', r.body.job_id);
  assert.deepEqual(sends.map((x) => x.phone).sort(), ['5511987654321', good].sort(), 'ganhou DDI 55; "16"/"abc" nao entraram');
  assert.ok((await mockMessages({ to: '5511987654321' })).length >= 1);
  assert.equal((await mockMessages({ to: '16' })).length, 0);
});

test('T8: sends-report traduz erros da Meta com help:{code,motivo,fix} em PT', async () => {
  const pJanela = phone('0000'); const pParams = phone('0001'); const pOk = phone();
  const r = await authed('/api-oficial/broadcast', { method: 'POST', body: { account_id: acc.id, list_name: 'com erros', template: { name: 'hello_world', language: 'en_US' }, csv: csvOf([[pJanela, 'A'], [pParams, 'B'], [pOk, 'C']]), rate_per_sec: 50 } });
  assert.equal(r.status, 202);
  const done = await pollUntilDone(r.body.job_id);
  assert.equal(done.failed, 2); assert.equal(done.sent, 1);
  assert.ok(done.errors.some((e) => e.code === 131047), 'erros no polling');
  const rep = await authed(`/api-oficial/sends-report?job_id=${r.body.job_id}`);
  assert.equal(rep.status, 200, JSON.stringify(rep.body));
  assert.equal(rep.body.summary.total, 3); assert.equal(rep.body.summary.failed, 2); assert.equal(rep.body.summary.sent, 1);
  const rowJ = rep.body.rows.find((x) => x.phone === pJanela);
  assert.equal(rowJ.status, 'failed'); assert.equal(rowJ.error_code, 131047);
  assert.equal(rowJ.help.code, 131047);
  assert.match(rowJ.help.motivo, /24 ?h|janela/i);
  assert.ok(rowJ.help.fix.length > 10);
  const rowP = rep.body.rows.find((x) => x.phone === pParams);
  assert.equal(rowP.help.code, 132000);
  assert.match(rowP.help.motivo, /vari[aá]ve|par[aâ]metro/i);
  const rowOk = rep.body.rows.find((x) => x.phone === pOk);
  assert.equal(rowOk.status, 'sent'); assert.equal(rowOk.help, null);
  const filtered = await authed(`/api-oficial/sends-report?job_id=${r.body.job_id}&status=failed`);
  assert.equal(filtered.body.rows.length, 2);
});

test('T8: template inexistente na Meta -> todos falham com 132001 e help; job termina', async () => {
  const r = await authed('/api-oficial/broadcast', { method: 'POST', body: { account_id: acc.id, list_name: 'tpl ruim', template: { name: 'nao_existe', language: 'pt_BR' }, csv: csvOf([[phone(), 'A']]), rate_per_sec: 50 } });
  assert.equal(r.status, 202);
  const done = await pollUntilDone(r.body.job_id);
  assert.equal(done.failed, 1);
  const rep = await authed(`/api-oficial/sends-report?job_id=${r.body.job_id}`);
  assert.equal(rep.body.rows[0].help.code, 132001);
});

test('T8: cancelar job interrompe o disparo', async () => {
  const rows = Array.from({ length: 30 }, (_, i) => [phone(), `P${i}`]);
  const r = await authed('/api-oficial/broadcast', { method: 'POST', body: { account_id: acc.id, list_name: 'cancelar', template: { name: 'hello_world', language: 'en_US' }, csv: csvOf(rows), rate_per_sec: 4 } });
  assert.equal(r.status, 202);
  await sleep(600);
  const c = await authed(`/api-oficial/broadcast/${r.body.job_id}/cancel`, { method: 'POST' });
  assert.equal(c.status, 200);
  const done = await pollUntilDone(r.body.job_id);
  assert.equal(done.cancelled, true);
  assert.ok(done.processed < 30, `parou antes do fim (${done.processed}/30)`);
  const list = await authed('/api-oficial/broadcast');
  assert.ok(list.body.some((j) => j.job_id === r.body.job_id));
});

test('T8: nao existe rota duplicada (/sends vs /sends-report); o processo sobe', async () => {
  assert.equal((await authed('/api-oficial/sends-report?limit=1')).status, 200);
  assert.equal((await authed('/api-oficial/sends')).status, 404, '/sends nao existe (evita conflito)');
  assert.equal((await api('/health')).status, 200);
});

test('T8: 9o digito BR - numero de 12 digitos no CSV vira canonico com 9 e nao duplica contato existente', async () => {
  const with9 = '5571' + '9' + String(6 + Math.floor(Math.random() * 4)) + String(Math.floor(1000000 + Math.random() * 8999999)); // 55 DDD 9 [6-9]XXXXXXX (celular)
  const without9 = with9.slice(0, 4) + with9.slice(5);
  const { data: c } = await sb.from('wa_contacts').insert({ account_id: acc.id, phone: with9, wa_id: without9, name: 'Ja existe' }).select('id').single();
  const r = await authed('/api-oficial/broadcast', { method: 'POST', body: { account_id: acc.id, list_name: 'nono digito', template: { name: 'hello_world', language: 'en_US' }, csv: `${without9},Sem Nove\n${with9.slice(2)},Sem DDI`, rate_per_sec: 50 } });
  assert.equal(r.status, 202, JSON.stringify(r.body));
  assert.equal(r.body.total, 1, 'os dois viram o mesmo numero canonico');
  assert.equal(r.body.duplicates, 1);
  const done = await pollUntilDone(r.body.job_id);
  assert.equal(done.sent, 1);
  assert.equal((await mockMessages({ to: with9 })).length, 1);
  const { data: contacts } = await sb.from('wa_contacts').select('id, tags').eq('account_id', acc.id).or(`phone.eq.${with9},phone.eq.${without9}`);
  assert.equal(contacts.length, 1, 'sem contato duplicado'); assert.equal(contacts[0].id, c.id);
  assert.ok(contacts[0].tags.includes('nono digito'));
});

test('T8: template com cabecalho de IMAGEM - sem midia recusa (400); com midia padrao envia header image; midia da campanha sobrepoe', async () => {
  const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  const { data: tpl } = await sb.from('wa_templates').select('*').eq('account_id', acc.id).eq('name', 'promo_imagem').single();
  await sb.from('wa_templates').update({ header_media_url: null, header_media_path: null }).eq('id', tpl.id);
  const p1 = phone();
  const semMidia = await authed('/api-oficial/broadcast', { method: 'POST', body: { account_id: acc.id, list_name: 'img', template: { name: 'promo_imagem', language: 'pt_BR' }, csv: `${p1},Ana`, rate_per_sec: 50 } });
  assert.equal(semMidia.status, 400, JSON.stringify(semMidia.body));
  assert.equal(semMidia.body.error, 'TEMPLATE_PRECISA_DE_MIDIA');
  // midia padrao definida na aba Templates
  const def = await authed(`/api-oficial/accounts/${acc.id}/templates/${tpl.id}/header-media`, { method: 'POST', body: { base64: TINY_PNG, mime: 'image/png', filename: 'padrao.png' } });
  assert.equal(def.status, 200);
  const r = await authed('/api-oficial/broadcast', { method: 'POST', body: { account_id: acc.id, list_name: 'img', template: { name: 'promo_imagem', language: 'pt_BR' }, csv: `${p1},Ana`, rate_per_sec: 50 } });
  assert.equal(r.status, 202, JSON.stringify(r.body));
  assert.equal(r.body.header_media_url, def.body.header_media_url);
  const done = await pollUntilDone(r.body.job_id);
  assert.equal(done.sent, 1, JSON.stringify(done.errors));
  const sent = (await mockMessages({ to: p1 }))[0];
  const header = sent.payload.template.components.find((c) => c.type === 'header');
  assert.equal(header.parameters[0].type, 'image');
  assert.equal(header.parameters[0].image.link, def.body.header_media_url);
  assert.deepEqual(sent.payload.template.components.find((c) => c.type === 'body').parameters.map((x) => x.text), ['Ana']);
  // midia especifica da campanha sobrepoe a padrao
  const p2 = phone();
  const r2 = await authed('/api-oficial/broadcast', { method: 'POST', body: { account_id: acc.id, list_name: 'img2', template: { name: 'promo_imagem', language: 'pt_BR' }, csv: `${p2},Bia`, rate_per_sec: 50, header_media: { base64: TINY_PNG, mime: 'image/png', filename: 'campanha.png' } } });
  assert.equal(r2.status, 202, JSON.stringify(r2.body));
  assert.ok(r2.body.header_media_url.includes('/wa-media/broadcast/'), r2.body.header_media_url);
  await pollUntilDone(r2.body.job_id);
  assert.equal((await mockMessages({ to: p2 }))[0].payload.template.components.find((c) => c.type === 'header').parameters[0].image.link, r2.body.header_media_url);
});
