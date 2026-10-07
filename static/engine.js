/* Browser counterpart of accountingplus/engine.py. Amounts never use floating point. */
(function (root) {
  'use strict';

  const RULES_VERSION = '2026.1';
  const MARKET_KINDS = new Set(['sale', 'return', 'commission', 'logistics', 'withholding', 'payout']);
  const BANK_KINDS = new Set(['bank_credit', 'bank_debit']);
  const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
  const get = (value, key, fallback = null) => own(value, key) ? value[key] : fallback;
  const truth = value => Boolean(value) && !(Array.isArray(value) && !value.length) &&
    !(value && typeof value === 'object' && !Array.isArray(value) && !Object.keys(value).length);
  const pyString = value => value == null ? 'None' : value === true ? 'True' : value === false ? 'False' : String(value);
  const sum = values => values.reduce((total, value) => total + value, 0n);
  const cents = value => ({ n: value, scale: 2 });
  const power = value => 10n ** BigInt(value);
  const lex = (a, b) => {
    const left = Array.from(a), right = Array.from(b);
    for (let index = 0; index < Math.min(left.length, right.length); index++) {
      const delta = left[index].codePointAt(0) - right[index].codePointAt(0);
      if (delta) return delta;
    }
    return left.length - right.length;
  };

  function decimal(value) {
    const text = pyString(value).trim();
    const match = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/.exec(text);
    if (!match) throw new Error('Некорректное число.');
    const fractional = match[3] || match[4] || '';
    const exponent = Number(match[5] || 0);
    if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 10000) throw new Error('Некорректное число.');
    let n = BigInt((match[2] || '0') + fractional);
    if (match[1] === '-') n = -n;
    let scale = fractional.length - exponent;
    if (scale < 0) { n *= power(-scale); scale = 0; }
    return { n, scale, negative: match[1] === '-' };
  }

  function add(a, b) {
    const scale = Math.max(a.scale, b.scale);
    return { n: a.n * power(scale - a.scale) + b.n * power(scale - b.scale), scale };
  }

  function compare(a, b) {
    const difference = add(a, { n: -b.n, scale: b.scale }).n;
    return difference < 0n ? -1 : difference > 0n ? 1 : 0;
  }

  function round(value, scale = 2) {
    if (value.scale <= scale) return value.n * power(scale - value.scale);
    const divisor = power(value.scale - scale);
    const absolute = value.n < 0n ? -value.n : value.n;
    const rounded = absolute / divisor + (absolute % divisor * 2n >= divisor ? 1n : 0n);
    return value.n < 0n ? -rounded : rounded;
  }

  function money(value) {
    const negative = value < 0n;
    const absolute = negative ? -value : value;
    return (negative ? '-' : '') + (absolute / 100n).toString() + '.' + (absolute % 100n).toString().padStart(2, '0');
  }

  function decimalMoney(value) {
    const rounded = round(value);
    // Decimal.quantize uses Python's default 28-digit coefficient precision.
    if ((rounded < 0n ? -rounded : rounded).toString().length > 28) throw new Error('Сумма превышает точность расчёта.');
    if (rounded === 0n && (value.n < 0n || value.negative)) return '-0.00';
    return money(rounded);
  }

  function moneyValue(value) {
    if (value == null || typeof value === 'boolean') throw new Error('Некорректная сумма.');
    const text = pyString(value).trim().replace(/[\u00a0 ]/g, '').replace(/,/g, '.');
    if (!/^\d+(?:\.\d{1,2})?$/.test(text)) throw new Error('Некорректная сумма.');
    const parts = text.split('.');
    const amount = BigInt(parts[0]) * 100n + BigInt((parts[1] || '').padEnd(2, '0'));
    if (amount > 100000000000000000n) throw new Error('Сумма превышает допустимый предел.');
    return amount;
  }

  function dateValue(value) {
    const text = pyString(value).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error('Некорректная дата.');
    const [year, month, day] = text.split('-').map(Number);
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const lengths = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1 || day > lengths[month - 1]) throw new Error('Некорректная дата.');
    return text;
  }

  function periodBounds(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}$/.test(value)) throw new Error('Период должен иметь формат YYYY-MM.');
    try {
      const start = dateValue(value + '-01');
      const [year, month] = value.split('-').map(Number);
      const nextYear = year + (month === 12 ? 1 : 0);
      const end = dateValue(String(nextYear).padStart(4, '0') + '-' + String(month % 12 + 1).padStart(2, '0') + '-01');
      return { start, end, year };
    } catch (_) {
      throw new Error('Некорректный календарный период.');
    }
  }

  function calculate(events, profile, period) {
    const { start, end, year } = periodBounds(period);
    const inPeriod = value => start <= value && value < end;
    const clientId = get(profile, 'id');
    const active = events.filter(event => truth(get(event, 'active', true)));
    if (active.some(event => get(event, 'client_id') !== null && get(event, 'client_id') !== clientId)) throw new Error('В расчёт переданы операции другого клиента.');
    const issues = [], seenIssues = new Set();
    const source = event => ({ file_id: get(event, 'file_id'), line: get(event, 'line'), external_id: get(event, 'external_id', '') });
    function issue(code, message, eventList = [], severity = 'blocking') {
      const key = JSON.stringify([code, eventList.map(event => get(event, 'id', JSON.stringify(source(event))))]);
      if (seenIssues.has(key)) return;
      seenIssues.add(key);
      issues.push({ code, severity, message, event_ids: eventList.filter(event => truth(get(event, 'id'))).map(event => event.id), sources: eventList.map(source) });
    }

    const prepared = [];
    for (const original of active) {
      const event = { ...original };
      try {
        event._date = dateValue(get(event, 'date'));
        event._amount = moneyValue(get(event, 'amount'));
        event._tax_date = truth(get(event, 'tax_date')) ? dateValue(event.tax_date) : null;
      } catch (_) {
        issue('invalid_event', 'Операция содержит некорректную дату или сумму. Исправьте источник.', [event]);
        continue;
      }
      prepared.push(event);
    }
    const selected = prepared.filter(event => inPeriod(event._date));
    const relevantIds = new Set(selected.map(event => get(event, 'id')));
    for (const event of prepared) if (event._tax_date && inPeriod(event._tax_date)) relevantIds.add(get(event, 'id'));
    const currentSettlements = new Set(selected.filter(event => event.source === 'marketplace' && event.kind === 'payout' && truth(get(event, 'settlement_id'))).map(event => event.settlement_id));
    for (const event of prepared) if (event.source === 'bank' && currentSettlements.has(get(event, 'settlement_id'))) relevantIds.add(get(event, 'id'));
    const relevant = prepared.filter(event => relevantIds.has(get(event, 'id')));
    if (!selected.some(event => event.source === 'marketplace')) issue('marketplace_data_missing', 'За выбранный период нет операций маркетплейса. Подтвердите отсутствие операций или загрузите отчёт.');
    for (const event of relevant) {
      if (!truth(get(event, 'external_id'))) issue('missing_external_id', 'Нет внешнего идентификатора операции. Повторный учёт нельзя надёжно исключить.', [event]);
      if (truth(get(event, 'extra_fields'))) {
        const columns = Array.isArray(event.extra_fields) ? event.extra_fields : typeof event.extra_fields === 'string' ? Array.from(event.extra_fields) : Object.keys(event.extra_fields);
        issue('unknown_columns', 'Неизвестные колонки сохранены, но не участвуют в расчёте: ' + columns.join(', ') + '.', [event]);
      }
      const kind = get(event, 'kind');
      const allowed = event.source === 'marketplace' ? MARKET_KINDS : event.source === 'bank' ? BANK_KINDS : new Set();
      if (!allowed.has(kind)) issue('unknown_kind', `Операция «${pyString(kind)}» не классифицирована для источника ${pyString(get(event, 'source'))}. Её сумма не включена в показатели.`, [event]);
      if (event.source === 'marketplace' && ['sale', 'return'].includes(kind)) {
        let sellerVat;
        try {
          const positive = value => {
            const text = pyString(value).trim();
            if (/^[+]?Infinity$/i.test(text)) return true;
            if (/^-Infinity$/i.test(text)) return false;
            return compare(decimal(value), cents(0n)) > 0;
          };
          sellerVat = positive(get(event, 'vat_amount') || '0') || positive(get(event, 'vat_rate') || '0');
        } catch (_) { sellerVat = true; }
        if (sellerVat) issue('seller_vat_unsupported', 'В продаже/возврате указан НДС продавца. Этот модуль поддерживает только освобождение от НДС.', [event]);
      }
    }

    const financial = {};
    for (const kind of MARKET_KINDS) financial[kind] = sum(selected.filter(event => event.source === 'marketplace' && event.kind === kind).map(event => event._amount));
    const expectedPayout = financial.sale - financial.return - financial.commission - financial.logistics - financial.withholding;
    const incomeRows = [];
    let income = 0n;
    const saleIndex = new Map(prepared.filter(event => event.source === 'marketplace' && event.kind === 'sale' && truth(get(event, 'external_id'))).map(event => [event.external_id, event]));
    const refunds = new Map();
    for (const event of prepared) {
      if (event.kind === 'return' && event.source === 'marketplace' && event._date < end) {
        const related = get(event, 'related_id');
        if (!refunds.has(related)) refunds.set(related, []);
        refunds.get(related).push(event);
      }
    }
    for (const event of prepared) {
      if (event.source !== 'marketplace' || !['sale', 'return'].includes(event.kind)) continue;
      const taxDate = event._tax_date || event._date;
      if (!inPeriod(taxDate)) continue;
      if (event._tax_date === null) issue('missing_tax_date', 'Не подтверждена дата признания дохода/возврата. В черновике временно использована дата события.', [event]);
      if (taxDate < event._date) issue('tax_date_before_event', 'Дата признания дохода раньше даты события. Подтвердите основание или исправьте дату.', [event]);
      let refundProvisional = false;
      if (event.kind === 'return') {
        const linkedSale = saleIndex.get(get(event, 'related_id'));
        if (!linkedSale) {
          issue('refund_without_sale', 'Возврат не связан с продажей в загруженных данных. Загрузите исходную продажу или уточните связь.', [event]);
          refundProvisional = true;
        } else if (linkedSale._date > event._date) {
          issue('refund_before_sale', 'Возврат датирован раньше связанной продажи.', [event, linkedSale]);
          refundProvisional = true;
        } else if (sum((refunds.get(get(event, 'related_id')) || []).map(refund => refund._amount)) > linkedSale._amount) {
          issue('refund_exceeds_sale', 'Сумма связанных возвратов превышает сумму продажи.', [linkedSale, ...refunds.get(get(event, 'related_id'))]);
          refundProvisional = true;
        }
        if (linkedSale) {
          if (linkedSale._tax_date === null) {
            issue('refund_sale_tax_date_missing', 'Не подтверждено, когда связанная продажа была включена в доход УСН. Уменьшение на возврат требует проверки.', [event, linkedSale]);
            refundProvisional = true;
          } else if (taxDate < linkedSale._tax_date) {
            issue('refund_before_tax_recognition', 'Возврат уменьшает доход раньше подтверждённой даты признания связанной продажи. Исправьте даты или основание.', [event, linkedSale]);
            refundProvisional = true;
          }
        }
      }
      const signed = event.kind === 'return' ? -event._amount : event._amount;
      income += signed;
      incomeRows.push({ event_id: get(event, 'id'), external_id: get(event, 'external_id', ''), kind: event.kind, amount: money(signed), tax_date: taxDate, provisional: event._tax_date === null || refundProvisional, sources: [source(event)] });
    }
    incomeRows.sort((a, b) => lex(a.tax_date, b.tax_date) || lex(a.event_id || '', b.event_id || ''));

    const payouts = selected.filter(event => event.source === 'marketplace' && event.kind === 'payout');
    const payoutGroups = new Map();
    for (const event of payouts) {
      const settlement = get(event, 'settlement_id');
      if (!payoutGroups.has(settlement)) payoutGroups.set(settlement, []);
      payoutGroups.get(settlement).push(event);
    }
    let bankReceived = 0n;
    const reconciliation = [], usedBankIds = new Set();
    for (const [settlementId, group] of [...payoutGroups.entries()].sort((a, b) => lex(a[0] || '', b[0] || ''))) {
      const amountExpected = sum(group.map(event => event._amount));
      const banks = prepared.filter(event => event.source === 'bank' && event.kind === 'bank_credit' && truth(settlementId) && get(event, 'settlement_id') === settlementId);
      const amountReceived = sum(banks.map(event => event._amount));
      const difference = amountExpected - amountReceived;
      bankReceived += amountReceived;
      for (const event of banks) usedBankIds.add(get(event, 'id'));
      let status;
      if (!truth(settlementId)) {
        status = 'unlinked';
        issue('unlinked_payout', 'У выплаты нет settlement_id. Совпадения суммы недостаточно для сверки.', group);
      } else if (!banks.length) {
        status = 'missing';
        issue('payout_missing', `Нет поступлений банка для выплаты ${settlementId}.`, group);
      } else if (difference > 0n) {
        status = 'partial';
        issue('payout_partial', `Выплата ${settlementId} поступила частично: не хватает ${money(difference)} ₽.`, [...group, ...banks]);
      } else if (difference < 0n) {
        status = 'overpaid';
        issue('payout_overpaid', `По выплате ${settlementId} поступило больше на ${money(-difference)} ₽.`, [...group, ...banks]);
      } else if (banks.some(event => event._date >= end)) {
        status = 'next_period';
        issue('next_period_receipt', `Выплата ${settlementId} полностью поступила с переносом в следующий период.`, [...group, ...banks], 'warning');
      } else status = 'matched';
      const otherPeriod = prepared.filter(event => event.source === 'marketplace' && event.kind === 'payout' && truth(settlementId) && get(event, 'settlement_id') === settlementId && !inPeriod(event._date));
      if (otherPeriod.length) issue('settlement_cross_period', 'Один settlement_id используется выплатами разных периодов. Требуется уточнить распределение банка.', [...group, ...otherPeriod, ...banks]);
      const earliestPayout = group.map(event => event._date).sort()[0];
      if (banks.some(event => event._date < earliestPayout)) issue('receipt_before_payout', 'Банк датирован раньше соответствующей выплаты. Проверьте связь операций.', [...group, ...banks]);
      reconciliation.push({ settlement_id: settlementId, expected: money(amountExpected), received: money(amountReceived), difference: money(difference), status, payout_event_ids: group.filter(event => truth(get(event, 'id'))).map(event => event.id), bank_event_ids: banks.filter(event => truth(get(event, 'id'))).map(event => event.id) });
    }
    const allSettlementIds = new Set(prepared.filter(event => event.source === 'marketplace' && event.kind === 'payout' && truth(get(event, 'settlement_id'))).map(event => event.settlement_id));
    for (const event of selected) {
      if (event.source !== 'bank' || usedBankIds.has(get(event, 'id'))) continue;
      if (event.kind === 'bank_credit' && !allSettlementIds.has(get(event, 'settlement_id'))) {
        issue('unlinked_bank_credit', 'Поступление банка не связано с загруженной выплатой. Оно не включено в доход УСН автоматически.', [event]);
        reconciliation.push({ settlement_id: get(event, 'settlement_id'), expected: '0.00', received: money(event._amount), difference: money(-event._amount), status: 'unlinked', payout_event_ids: [], bank_event_ids: truth(get(event, 'id')) ? [event.id] : [] });
      } else if (event.kind === 'bank_debit') issue('bank_debit_review', 'Списание банка сохранено для проверки. На УСН «Доходы» оно не уменьшает базу.', [event], 'warning');
    }
    const bankPeriodPresent = selected.some(event => event.source === 'bank');
    const matchedBankPresent = reconciliation.some(row => row.bank_event_ids.length && ['matched', 'next_period'].includes(row.status));
    if (!bankPeriodPresent && !matchedBankPresent) issue('bank_data_missing', 'Нет банковской выписки за выбранный период и подтверждённых поступлений по его выплатам. Загрузите банковские данные; отсутствие выплат само по себе не доказывает отсутствие операций.');

    const profilePeriodMatches = get(profile, 'period') === period;
    const opening = profilePeriodMatches ? get(profile, 'opening_balance') : null;
    let closing;
    if (opening === null) {
      issue('opening_balance_unknown', 'Начальный остаток расчётов с маркетплейсом для периода неизвестен. Конечный остаток не рассчитан.');
      closing = null;
    } else {
      try { closing = decimalMoney(add(decimal(opening), cents(expectedPayout - financial.payout))); }
      catch (_) { issue('opening_balance_invalid', 'Некорректный начальный остаток.'); closing = null; }
    }
    if (expectedPayout < 0n) issue('negative_expected_payout', 'Удержания и возвраты превышают продажи периода. Проверьте переносы и начальный остаток.', selected, 'warning');
    if (income < 0n) issue('negative_period_income', 'Возвраты превышают доход периода. Черновой налог за этот месяц показан как 0; годовой расчёт требует накопленных данных.', [], 'warning');
    let tax;
    try {
      const rate = decimal(get(profile, 'usn_rate', '6.00'));
      if (compare(rate, cents(0n)) < 0 || compare(rate, cents(600n)) > 0) throw new Error('Некорректная ставка.');
      tax = decimalMoney({ n: (income > 0n ? income : 0n) * rate.n, scale: rate.scale + 4, negative: rate.negative });
    } catch (_) { issue('usn_rate_invalid', 'Не задана допустимая ставка УСН «Доходы» (0–6%).'); tax = null; }
    issue('tax_preliminary', 'Налог — предварительное начисление по доходу периода до уменьшений. Это не сумма к уплате за квартал/год.', [], 'warning');

    const vatStatus = get(profile, 'vat_status', 'unknown');
    const effective = get(profile, 'vat_effective_from');
    if (vatStatus === 'unknown') issue('vat_unknown', 'Статус НДС не определён. Подтвердите освобождение для выбранного периода.');
    else if (['5', '7'].includes(vatStatus)) {
      if (!truth(effective) || effective < end) issue('vat_unsupported', 'Клиент применяет НДС 5%/7%. Расчёт этого режима ещё не поддерживается.');
      else issue('vat_future', 'В профиле указан будущий переход на НДС. Проверьте дату и подготовьте следующий модуль.', [], 'warning');
    } else if (vatStatus !== 'exempt') issue('vat_unknown', 'Неподдерживаемый статус НДС.');
    if (vatStatus === 'exempt' && (!truth(effective) || effective > start)) issue('vat_status_date', 'Освобождение от НДС не подтверждено на начало периода.');
    const thresholds = { 2026: decimal('20000000'), 2027: decimal('15000000') };
    const threshold = thresholds[year];
    const prior = get(profile, 'prior_year_income');
    const ytd = profilePeriodMatches ? get(profile, 'ytd_income_before_period') : null;
    const complete = get(profile, 'income_data_complete') === true;
    if (!threshold) issue('rules_period_unsupported', 'Для выбранного года нет проверенной версии правил порога НДС.');
    else if (prior === null || ytd === null || !complete) issue('vat_evidence_missing', 'Для проверки освобождения нужны доходы предыдущего года, текущего года до периода и подтверждение полноты всех доходов.');
    else {
      try {
        const priorValue = decimal(prior), ytdValue = decimal(ytd);
        if (compare(priorValue, cents(0n)) < 0 || compare(ytdValue, cents(0n)) < 0) throw new Error('Некорректный доход.');
        if (compare(priorValue, threshold) > 0 || compare(ytdValue, threshold) > 0) issue('vat_required', 'Доходы превышают порог освобождения от НДС. Профиль без НДС не покрывает выбранный период.');
        else {
          const dailyIncome = new Map(), dailySales = new Map();
          for (const row of incomeRows) {
            const amount = round(decimal(row.amount));
            dailyIncome.set(row.tax_date, (dailyIncome.get(row.tax_date) || 0n) + amount);
            if (row.kind === 'sale') dailySales.set(row.tax_date, (dailySales.get(row.tax_date) || 0n) + amount);
          }
          let running = ytdValue, crossed = false, possibleIntraday = false;
          for (const day of [...dailyIncome.keys()].sort()) {
            possibleIntraday = possibleIntraday || compare(add(running, cents(dailySales.get(day) || 0n)), threshold) > 0;
            running = add(running, cents(dailyIncome.get(day)));
            crossed = crossed || compare(running, threshold) > 0;
          }
          if (crossed) issue('vat_threshold_crossed', 'В этом периоде превышен порог НДС: переход требуется с начала следующего месяца. Более поздний возврат не отменяет установленное превышение; уточните полный доход и дату.', [], 'warning');
          else if (possibleIntraday) issue('vat_threshold_possible', 'Продажи и возвраты в один день могли пересечь порог НДС. Требуется проверить последовательность признания доходов.', [], 'warning');
        }
      } catch (_) { issue('vat_evidence_invalid', 'Некорректные сведения о доходах для проверки НДС.'); }
    }

    const metrics = { sales: money(financial.sale), returns: money(financial.return), usn_income: money(income), commission: money(financial.commission), logistics: money(financial.logistics), withholding: money(financial.withholding), expected_payout: money(expectedPayout), declared_payouts: money(financial.payout), bank_received: money(bankReceived), payout_difference: money(financial.payout - bankReceived), closing_balance: closing, usn_tax_preliminary: tax };
    const blockingCount = issues.filter(item => item.severity === 'blocking').length;
    const explanation = `Доход УСН за ${period}: ${metrics.usn_income} ₽. Комиссия, логистика и прочие удержания не уменьшают базу УСН «Доходы». Предварительный налог до уменьшений: ${tax || 'не рассчитан'} ₽. Поступления банка учитываются в сверке только по settlement_id, включая следующий период. Блокирующих вопросов: ${blockingCount}. Каждая сумма прослеживается до строк исходных файлов.`;
    return { metrics, issues, reconciliation, income_rows: incomeRows, explanation, rules_version: RULES_VERSION };
  }

  const api = Object.freeze({ calculate });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.AccountingPlusEngine = api;
})(typeof window !== 'undefined' ? window : typeof globalThis !== 'undefined' ? globalThis : null);
