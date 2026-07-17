/**
 * Parsers for the browser fallback.
 *
 * The collector prefers structured local/API sources. These parsers only run
 * when those sources are unavailable, so keep them tolerant of translated
 * labels and optional reset captions instead of coupling them to one exact DOM
 * text order.
 */

export const CODEX_READY =
  /(Límite de uso de 5 horas|5[\s-]?hour usage limit|Límite de uso semanal|Weekly usage limit)[\s\S]*?\d+(?:[.,]\d+)?\s*%\s*(restante|remaining|usado|used)/i;

export const CLAUDE_READY =
  /(Sesión actual|Current session|Todos los modelos|All models)[\s\S]*?\d+(?:[.,]\d+)?\s*%\s*(usado|used|restante|remaining)/i;

const WEEKDAYS = {
  dom: 0, lun: 1, mar: 2, mié: 3, mie: 3, jue: 4, vie: 5, sáb: 6, sab: 6,
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

export function normalizeText(raw) {
  return String(raw ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n+/g, '\n')
    .trim()
    .replace(/\n/g, ' ');
}

function number(value) {
  if (value === undefined || value === null) return null;
  const parsed = Number(String(value).replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}

function parseClock(text) {
  const match = text.match(/(\d{1,2}):(\d{2})\s*([ap])\s*\.?\s*m/i) || text.match(/(\d{1,2}):(\d{2})/);
  if (!match) return null;
  let h = Number(match[1]);
  const m = Number(match[2]);
  if (match[3]) {
    const pm = /p/i.test(match[3]);
    if (pm && h < 12) h += 12;
    if (!pm && h === 12) h = 0;
  }
  return { h, m };
}

export function resetEpochSeconds(label, now = new Date()) {
  if (!label) return null;
  const text = String(label).trim();
  const nowSec = Math.round(now.getTime() / 1000);

  const duration = text.match(
    /^(?:en\s+|in\s+)?(?:(\d+)\s*(?:d|días?|dias?|days?)\s*)?(?:(\d+)\s*(?:h|hr|hrs|horas?|hours?)\s*)?(?:(\d+)\s*(?:min|mins?|minutos?)\s*)?$/i,
  );
  if (duration && (duration[1] || duration[2] || duration[3])) {
    const minutes = Number(duration[1] || 0) * 1440
      + Number(duration[2] || 0) * 60
      + Number(duration[3] || 0);
    return nowSec + minutes * 60;
  }

  if (/\d{4}/.test(text)) {
    const parsed = Date.parse(text);
    if (!Number.isNaN(parsed)) return Math.round(parsed / 1000);
  }

  const clock = parseClock(text);
  if (!clock) return null;

  const weekday = text.toLowerCase().match(/^(dom|lun|mar|mié|mie|jue|vie|sáb|sab|sun|mon|tue|wed|thu|fri|sat)/);
  const target = new Date(now);
  target.setHours(clock.h, clock.m, 0, 0);

  if (weekday) {
    let add = (WEEKDAYS[weekday[1]] - target.getDay() + 7) % 7;
    if (add === 0 && target.getTime() <= now.getTime()) add = 7;
    target.setDate(target.getDate() + add);
  } else if (target.getTime() <= now.getTime()) {
    target.setDate(target.getDate() + 1);
  }

  return Math.round(target.getTime() / 1000);
}

function section(text, startPattern, endPattern) {
  const match = text.match(new RegExp(`(?:${startPattern})\\s+([\\s\\S]*?)(?=${endPattern}|$)`, 'i'));
  return match?.[1]?.trim() ?? null;
}

function usageMetric(sectionText, mode) {
  if (!sectionText) return null;

  const percentMatch = sectionText.match(/(\d+(?:[.,]\d+)?)\s*%\s*(restante|remaining|usado|used)/i);
  if (!percentMatch) return null;

  const value = number(percentMatch[1]);
  const isRemaining = /restante|remaining/i.test(percentMatch[2]);
  const usedPercent = isRemaining ? 100 - value : value;
  const remainingPercent = isRemaining ? value : 100 - value;
  const resetMatch = sectionText.match(
    /(?:Se reinicia a las|Se restablece(?:\s+el|\s+en)?|Resets(?:\s+at|\s+on|\s+in)?)\s+(.+?)(?=\s+\d+(?:[.,]\d+)?\s*%|$)/i,
  );
  const resetLabel = resetMatch?.[1]?.trim() ?? null;

  return {
    used_percent: usedPercent,
    remaining_percent: remainingPercent,
    reset_label: resetLabel,
    reset_epoch: resetEpochSeconds(resetLabel),
    display_mode: mode,
  };
}

export function parseCodex(raw) {
  const text = normalizeText(raw);
  const fiveHourText = section(
    text,
    'Límite de uso de 5 horas|5[\\s-]?hour usage limit',
    'Límite de uso semanal|Weekly usage limit|Créditos restantes|Credits remaining|Recarga automática|Auto-reload',
  );
  const weeklyText = section(
    text,
    'Límite de uso semanal|Weekly usage limit',
    'Créditos restantes|Credits remaining|Recarga automática|Auto-reload|Desglose de uso|Usage breakdown',
  );
  const fiveHour = usageMetric(fiveHourText, 'remaining_percent');
  const weekly = usageMetric(weeklyText, 'remaining_percent');
  const credits = text.match(/(?:Créditos restantes|Credits remaining)\s+([\d.,]+)/i);

  if (!fiveHour && !weekly) {
    throw Object.assign(new Error('No pude parsear Codex usage.'), { code: 'page_changed' });
  }

  return {
    ok: true,
    source: 'web',
    updated_at: new Date().toISOString(),
    five_hour: fiveHour,
    weekly,
    credits_remaining: credits ? number(credits[1]) : null,
  };
}

function parseClaudeCredits(text) {
  if (!/(Créditos de uso|Usage credits)/i.test(text)) return null;

  const spent = text.match(/USD\s*([\d.,]+)\s*(?:gastado|spent)\b/i);
  const spentPercent = text.match(
    /USD\s*[\d.,]+\s*(?:gastado|spent)\b[\s\S]*?(\d+(?:[.,]\d+)?)\s*%\s*(?:usado|used)/i,
  );
  const reset = text.match(
    /(?:gastado|spent)\b[\s\S]*?(?:Se restablece(?:\s+el)?|Resets(?:\s+on)?)\s+(.+?)\s+(?:\d+(?:[.,]\d+)?\s*%|USD\b)/i,
  );
  const limit = text.match(
    /USD\s*([\d.,]+)(?:(?!USD)[\s\S]){0,50}?(?:Límite de gasto mensual|Monthly spending limit)/i,
  );
  const balance =
    text.match(/USD\s*([\d.,]+)(?:(?!USD)[\s\S]){0,50}?(?:Saldo actual|Current balance)/i)
    || text.match(/(?:Saldo actual|Current balance)(?:(?!USD)[\s\S]){0,70}?USD\s*([\d.,]+)/i);

  return {
    enabled: true,
    spent_usd: spent ? number(spent[1]) : null,
    spent_percent: spentPercent ? number(spentPercent[1]) : null,
    limit_usd: limit ? number(limit[1]) : null,
    balance_usd: balance ? number(balance[1]) : null,
    reset_label: reset?.[1]?.trim() ?? null,
  };
}

export function parseClaude(raw) {
  const text = normalizeText(raw);
  const sessionText = section(
    text,
    'Sesión actual|Current session',
    'Límites semanales|Weekly limits|Todos los modelos|All models|Créditos de uso|Usage credits',
  );
  const weeklyText = section(
    text,
    'Todos los modelos|All models',
    'Créditos de uso|Usage credits|Última actualización|Last updated',
  );
  const session = usageMetric(sessionText, 'used_percent');
  const weekly = usageMetric(weeklyText, 'used_percent');
  const routines = text.match(
    /(?:Ejecuciones de rutinas diarias incluidas|Daily routine executions included).*?(\d+)\s*\/\s*(\d+)/i,
  );

  if (!session && !weekly) {
    throw Object.assign(new Error('No pude parsear Claude usage.'), { code: 'page_changed' });
  }

  return {
    ok: true,
    source: 'web',
    updated_at: new Date().toISOString(),
    session,
    weekly,
    daily_routines: {
      used: routines ? number(routines[1]) : null,
      limit: routines ? number(routines[2]) : null,
    },
    credits: parseClaudeCredits(text),
  };
}
