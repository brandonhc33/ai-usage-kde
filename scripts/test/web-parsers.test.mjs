import assert from 'node:assert/strict';
import test from 'node:test';
import { parseClaude, parseCodex } from '../lib/web-parsers.mjs';

test('parses the current weekly-only Codex web page', () => {
  const result = parseCodex(`
    Usage
    Codex usage draws from your shared agentic usage limit
    Weekly usage limit
    84%
    remaining
    Resets Jul 22, 2026 1:48 AM
    Credits remaining
    0
    Usage breakdown
  `);

  assert.equal(result.five_hour, null);
  assert.equal(result.weekly.used_percent, 16);
  assert.equal(result.weekly.remaining_percent, 84);
  assert.equal(result.weekly.reset_label, 'Jul 22, 2026 1:48 AM');
  assert.equal(result.credits_remaining, 0);
});

test('parses current Spanish Claude page sections and credits', () => {
  const result = parseClaude(`
    Límites de uso del plan
    Pro
    Sesión actual
    Se restablece en 1 h 28 min
    92% usado
    Límites semanales
    Todos los modelos
    Se restablece en 21 h 8 min
    13% usado
    Última actualización: justo ahora
    Créditos de uso
    USD 4.40 gastado
    Se restablece el Aug 1
    22% usado
    USD 20.00
    Límite de gasto mensual
    USD 0.00
    Saldo actual
  `);

  assert.equal(result.session.used_percent, 92);
  assert.equal(result.session.reset_label, '1 h 28 min');
  assert.equal(result.weekly.used_percent, 13);
  assert.equal(result.credits.spent_usd, 4.4);
  assert.equal(result.credits.spent_percent, 22);
  assert.equal(result.credits.limit_usd, 20);
  assert.equal(result.credits.balance_usd, 0);
});

test('keeps working when Claude omits reset captions', () => {
  const result = parseClaude(`
    Current session 50% used
    Weekly limits All models 25% used
    Last updated just now
  `);

  assert.equal(result.session.used_percent, 50);
  assert.equal(result.session.reset_epoch, null);
  assert.equal(result.weekly.used_percent, 25);
});

test('derives the normalized billing block from the Claude web page', () => {
  const result = parseClaude(`
    Sesión actual 0% usado
    Todos los modelos Se restablece en 21 h 8 min 13% usado
    Créditos de uso
    USD 4.40 gastado
    22% usado
    USD 20.00
    Límite de gasto mensual
  `);

  assert.equal(result.session.state, 'idle');
  assert.equal(result.weekly.state, 'active');
  // No balance on the page: the remaining limit is not money.
  assert.equal(result.billing.available, null);
  assert.equal(result.billing.limit_remaining, 15.6);
  assert.equal(result.billing.percent, 22);
});

test('parses the current Claude credits layout (balance and monthly limit)', () => {
  const result = parseClaude(`
    Sesión actual Se restablece en 3 h 58 min 75% usado
    Todos los modelos Se restablece en 5 d 10 h 14% usado
    Créditos de uso USD 4.71
    Disponibles para cualquier tarea. Los créditos promocionales se usan antes que los créditos comprados.
    Límite de gasto mensual
    USD 0.29 de USD 100 este mes · Recarga automática desactivada
  `);

  assert.equal(result.credits.balance_usd, 4.71);
  assert.equal(result.credits.spent_usd, 0.29);
  assert.equal(result.credits.limit_usd, 100);
  assert.equal(result.billing.available, 4.71);
});
