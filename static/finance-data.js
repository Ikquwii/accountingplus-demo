/* Annual source preparation: tax recognition, management revenue and bank cash stay separate. */
(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('./engine.js') : root.AccountingPlusEngine);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AccountingPlusFinanceData = api;
})(typeof window !== 'undefined' ? window : globalThis, function (engine) {
  'use strict';
  const SOURCE_CODES = new Set(['invalid_event', 'missing_external_id', 'unknown_columns', 'unknown_kind', 'seller_vat_unsupported', 'missing_tax_date', 'tax_date_before_event', 'refund_without_sale', 'refund_before_sale', 'refund_exceeds_sale', 'refund_sale_tax_date_missing', 'refund_before_tax_recognition', 'negative_period_income', 'fiscal_vat_threshold_ever_crossed']);
  const clone = value => JSON.parse(JSON.stringify(value));
  function cents(value) {
    const text = String(value ?? '');
    if (!/^-?\d+(?:\.\d{1,2})?$/.test(text)) throw new Error('Некорректная сумма исходной операции.');
    const negative = text.startsWith('-'); const [whole, fraction = ''] = (negative ? text.slice(1) : text).split('.');
    const amount = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
    return negative ? -amount : amount;
  }
  function money(value) {
    const negative = value < 0n; const absolute = negative ? -value : value;
    return `${negative ? '-' : ''}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`;
  }
  function validDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const parsed = new Date(`${value}T00:00:00Z`);
    return Number(value.slice(0, 4)) >= 1 && Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }
  const source = event => ({ file_id: event.file_id ?? null, line: event.line ?? null, external_id: event.external_id || '' });
  const inYear = (date, year) => validDate(date) && date.startsWith(`${year}-`);
  function relevantMonth(event, year) {
    const dates = [event.date, event.tax_date].filter(date => inYear(date, year));
    if (dates.length) return Math.min(...dates.map(date => Number(date.slice(5, 7))));
    if (!validDate(event.date) && !validDate(event.tax_date)) return 1;
    return null;
  }
  function prepare(workspace, ledger, config) {
    if (!engine?.calculate) throw new Error('Расчётный модуль исходных данных недоступен.');
    if (!Number.isInteger(ledger?.year) || ledger.year < 2000 || ledger.year > 2099) throw new Error('Некорректный финансовый год.');
    const year = ledger.year; const prepared = clone(ledger);
    const events = workspace.events.filter(event => event.active !== false);
    const monthly = Array.from({ length: 12 }, (_, index) => ({ month: `${year}-${String(index + 1).padStart(2, '0')}`, revenue: 0n, costs: 0n, bank_received: 0n, bank_debits: 0n, income: 0n }));
    const issues = new Map(); const incomeRows = new Map();
    const eventMap = new Map(events.map(event => [event.id, event]));
    function addIssue(issue, fallbackMonth = 1) {
      if (!SOURCE_CODES.has(issue.code) && issue.code !== 'refund_sale_outside_year') return;
      const related = (issue.event_ids || []).map(eventId => eventMap.get(eventId)).filter(Boolean);
      let month = fallbackMonth;
      // The monthly engine identifies the affected period. Related sources
      // explain the issue, but an earlier sale must not backdate a refund error.
      // Invalid events alone are emitted in every month and need date scoping.
      if (issue.code === 'invalid_event' && related.length) {
        const relevant = related.map(event => relevantMonth(event, year)).filter(value => value !== null);
        if (!relevant.length) return;
        month = Math.min(...relevant);
      }
      const value = { code: issue.code, severity: issue.severity, message: issue.message, sources: clone(issue.sources || []) };
      const key = JSON.stringify([value.code, value.sources]);
      const previous = issues.get(key);
      if (!previous || month < previous.month) issues.set(key, { month, value });
    }
    for (let index = 0; index < 12; index++) {
      const period = monthly[index].month;
      const profile = { ...workspace.client, tax_regime: 'income', usn_rate: '6.00', vat_status: 'exempt', vat_effective_from: `${year}-01-01`, prior_year_income: '0.00', ytd_income_before_period: '0.00', income_data_complete: true, opening_balance: '0.00', period };
      const result = engine.calculate(events, profile, period);
      for (const row of result.income_rows || []) if (inYear(row.tax_date, year)) {
        const key = row.event_id || JSON.stringify([row.tax_date, row.external_id, row.sources]);
        if (!incomeRows.has(key)) {
          incomeRows.set(key, clone(row));
          monthly[Number(row.tax_date.slice(5, 7)) - 1].income += cents(row.amount);
        }
      }
      for (const issue of result.issues || []) addIssue(issue, index + 1);
    }
    const threshold = config.years?.[String(year)]?.vat_exemption_threshold;
    if (threshold !== null && threshold !== undefined) {
      const days = new Map();
      for (const row of incomeRows.values()) {
        const day = days.get(row.tax_date) || { income: 0n, sales: 0n, sources: [] };
        const amount = cents(row.amount); day.income += amount;
        if (row.kind === 'sale') day.sales += amount;
        day.sources.push(...(row.sources || [])); days.set(row.tax_date, day);
      }
      let running = 0n;
      for (const [date, day] of [...days.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        if (running + day.income > cents(threshold) || running + day.sales > cents(threshold)) {
          addIssue({ code: 'fiscal_vat_threshold_ever_crossed', severity: 'blocking', message: 'В течение периода доход мог превысить порог НДС. Более поздние возвраты не отменяют превышение; проверьте дату перехода со следующего месяца.', sources: day.sources }, Number(date.slice(5, 7)));
          break;
        }
        running += day.income;
      }
    }
    const saleIndex = new Map(events.filter(event => event.source === 'marketplace' && event.kind === 'sale' && event.external_id).map(event => [event.external_id, event]));
    for (const event of events) {
      if (event.source === 'marketplace' && event.kind === 'return' && inYear(event.tax_date || event.date, year)) {
        const sale = saleIndex.get(event.related_id);
        if (sale && validDate(sale.tax_date) && !inYear(sale.tax_date, year)) addIssue({ code: 'refund_sale_outside_year', severity: 'blocking', message: 'Возврат связан с продажей, признанной в другом налоговом году. Подтвердите год и основание уменьшения дохода.', event_ids: [event.id], sources: [source(event)] }, Number((event.tax_date || event.date).slice(5, 7)));
      }
      if (!inYear(event.date, year)) continue;
      let amount;
      try { amount = cents(event.amount); if (amount < 0n || amount > 100000000000000000n) continue; } catch { continue; }
      const month = monthly[Number(event.date.slice(5, 7)) - 1];
      if (event.source === 'marketplace') {
        if (event.kind === 'sale') month.revenue += amount;
        if (event.kind === 'return') month.revenue -= amount;
        if (['commission', 'logistics', 'withholding'].includes(event.kind)) month.costs += amount;
      } else if (event.source === 'bank') {
        if (event.kind === 'bank_credit') month.bank_received += amount;
        if (event.kind === 'bank_debit') month.bank_debits += amount;
      }
    }
    const monthsByPeriod = new Map((config.periods || []).map(period => [period.period, period.months]));
    for (const period of prepared.periods) {
      const months = monthsByPeriod.get(period.period);
      if (![3, 6, 9, 12].includes(months)) throw new Error('Некорректная конфигурация отчётных периодов.');
      const selected = monthly.slice(0, months);
      for (const [target, field] of [['marketplace_income', 'income'], ['marketplace_revenue', 'revenue'], ['marketplace_costs', 'costs'], ['bank_received', 'bank_received'], ['bank_debits', 'bank_debits']]) period[target] = money(selected.reduce((sum, month) => sum + month[field], 0n));
      period.source_issues = [...issues.values()].filter(issue => issue.month <= months).map(issue => clone(issue.value));
    }
    const sources = events.filter(event => {
      if (!validDate(event.date) || (!inYear(event.date, year) && !inYear(event.tax_date, year))) return false;
      try { const amount = cents(event.amount); return amount >= 0n && amount <= 100000000000000000n; } catch { return false; }
    }).map(event => ({ ...source(event), event_id: event.id ?? null, kind: event.kind, date: event.date, tax_date: event.tax_date ?? null, amount: money(cents(event.amount)) }));
    return { ledger: prepared, sources, monthly: monthly.map(month => ({ month: month.month, revenue: money(month.revenue), costs: money(month.costs), bank_received: money(month.bank_received), bank_debits: money(month.bank_debits) })) };
  }
  return { prepare };
});
