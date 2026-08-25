// T11 - Fechamento: todas as tarefas DONE/BLOCKED e o relatorio final existe com o passo a passo mock -> producao.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('T11: todas as tarefas T0..T10 estao DONE ([x]) ou BLOCKED ([!]) em TASKS.md', () => {
  const tasks = fs.readFileSync('TASKS.md', 'utf8');
  const headers = [...tasks.matchAll(/^## \[(.)\] (T\d+) - /gm)].map((m) => ({ mark: m[1], id: m[2] }));
  assert.equal(headers.length, 12, 'T0..T11 presentes');
  for (const h of headers.filter((x) => x.id !== 'T11')) assert.ok(['x', '!'].includes(h.mark), `${h.id} esta [${h.mark}]`);
  assert.ok(['x', '~'].includes(headers.find((x) => x.id === 'T11').mark));
  assert.ok(!/^- \[ \]/m.test(tasks.split('## [!] T10')[0]), 'nenhum criterio de aceitacao pendente ate T9');
});

test('T11: RELATORIO-FINAL.md existe com modulos, cobertura, mocks, credenciais e passo a passo mock -> producao', () => {
  assert.ok(fs.existsSync('RELATORIO-FINAL.md'));
  const r = fs.readFileSync('RELATORIO-FINAL.md', 'utf8');
  for (const sec of ['Modulos concluidos', 'Cobertura de testes', 'mock', 'CREDENTIALS-TODO', 'mock -> producao', 'graph.facebook.com', 'schema.sql', 'PLUG-KEY']) {
    assert.ok(r.includes(sec), 'relatorio menciona: ' + sec);
  }
  assert.match(r, /T10[^\n]*BLOCKED/);
});

test('T11: PROGRESS.md nao tem tarefa TODO nem IN_PROGRESS alem da T11', () => {
  const p = fs.readFileSync('PROGRESS.md', 'utf8');
  const log = p.split('## Log')[1].split('## Blockers')[0];
  const pend = [...log.matchAll(/^- (T\d+)\s*\|\s*(TODO|IN_PROGRESS)/gm)].map((m) => m[1]).filter((id) => id !== 'T11');
  assert.deepEqual(pend, []);
});
