// T3 - Front esqueleto + Auth (Chrome headless real via CDP).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { API, SEED, SUPABASE_URL } from './helpers.mjs';
import { launchBrowser } from './browser.mjs';

let browser, page;
before(async () => {
  browser = await launchBrowser();
  page = await browser.newPage();
  await page.goto(`${API}/`);
  await page.waitFor('window.App && window.App.ready === true', { label: 'App.ready' });
});
after(async () => { await page?.close(); await browser?.close(); });

const realErrors = () => page.errors.filter((e) => !/favicon/i.test((e.text || '') + (e.url || '')));

test('T3: a pagina carrega sem erro de console', async () => {
  assert.deepEqual(realErrors(), [], 'erros: ' + JSON.stringify(page.errors));
  const cfg = await page.eval('JSON.stringify(App.config)');
  const c = JSON.parse(cfg);
  assert.equal(c.API_URL, '/api');
  assert.match(c.SUPABASE_URL, /^https?:\/\//);
  assert.equal(c.SUPABASE_URL, SUPABASE_URL, 'backend injeta SUPABASE_PUBLIC_URL/ANON_KEY do ambiente no index.html');
  assert.ok(await page.eval('typeof sb === "object" && !!sb.auth'), 'cliente supabase (sb) existe');
});

test('T3: sem login, so a tela de login aparece', async () => {
  assert.equal(await page.visible('#login-screen'), true);
  assert.equal(await page.visible('#app'), false);
  assert.equal(await page.eval('App.state.user'), null);
});

test('T3: senha errada mostra erro e continua na tela de login', async () => {
  await page.type('#login-email', SEED.user.email);
  await page.type('#login-password', 'senha-errada');
  await page.click('#login-btn');
  await page.waitFor('!document.querySelector("#login-error").hidden', { label: 'mensagem de erro' });
  assert.equal(await page.visible('#app'), false);
});

test('T3: login com o usuario seed autentica via Supabase local e mostra o app', async () => {
  page.errors.length = 0; // o 400 do teste anterior (senha errada) e esperado
  await page.type('#login-email', SEED.user.email);
  await page.type('#login-password', SEED.user.password);
  await page.click('#login-btn');
  await page.waitFor('App.state.user && App.state.user.email', { label: 'login' });
  assert.equal(await page.eval('App.state.user.email'), SEED.user.email);
  assert.equal(await page.visible('#app'), true);
  assert.equal(await page.visible('#login-screen'), false);
  const jwt = await page.eval('App.state.session.access_token');
  assert.match(jwt, /^eyJ/, 'sessao tem JWT do Supabase');
  assert.equal(await page.eval('document.querySelector("#user-email").textContent'), SEED.user.email);
});

test('T3: trocar de item no menu troca a view (inicio, apioficial, config)', async () => {
  for (const view of ['apioficial', 'config', 'inicio']) {
    await page.click(`[data-view="${view}"]`);
    assert.equal(await page.eval('App.state.view'), view);
    assert.equal(await page.visible(`[data-view-panel="${view}"]`), true, `${view} visivel`);
    for (const other of ['inicio', 'apioficial', 'config'].filter((v) => v !== view)) {
      assert.equal(await page.visible(`[data-view-panel="${other}"]`), false, `${other} escondida`);
    }
    assert.equal(await page.eval(`document.querySelector('.nav-item[data-view="${view}"]').classList.contains('active')`), true);
    assert.ok((await page.eval('location.hash')).startsWith('#/' + view));
  }
});

test('T3: abas da view apioficial trocam o painel', async () => {
  await page.click('[data-view="apioficial"]');
  for (const tab of ['inbox', 'templates', 'contas']) {
    await page.click(`[data-tab="${tab}"]`);
    assert.equal(await page.eval('App.state.tab'), tab);
    assert.equal(await page.visible(`[data-tab-panel="${tab}"]`), true);
  }
});

test('T3: a view config mostra o backend no ar (via API_URL=/api)', async () => {
  await page.click('[data-view="config"]');
  await page.waitFor('document.querySelector("#cfg-backend").textContent.startsWith("ok")', { label: 'health via /api' });
  assert.match(await page.eval('document.querySelector("#cfg-meta").textContent'), /mock-meta/);
});

test('T3: sair volta pra tela de login', async () => {
  await page.click('#logout-btn');
  await page.waitFor('App.state.user === null', { label: 'logout' });
  assert.equal(await page.visible('#login-screen'), true);
  assert.equal(await page.visible('#app'), false);
  assert.deepEqual(realErrors(), [], 'erros durante o fluxo: ' + JSON.stringify(page.errors));
});
