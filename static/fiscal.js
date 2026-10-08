/* Cumulative fiscal draft calculator. Fiscal constants come only from tax_rules.json. */
(function (root) {
  'use strict';
  const PERIODS = ['q1', 'h1', 'm9', 'year'];
  const PERIOD_MONEY = ['income_override', 'outside_income', 'tax_expenses', 'management_expenses', 'prior_advances', 'previous_deduction'];
  const PREPARED_MONEY = ['marketplace_income', 'marketplace_revenue', 'marketplace_costs', 'bank_received', 'bank_debits'];
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const clone = value => JSON.parse(JSON.stringify(value));
  const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
  const get = (value, key, fallback = null) => own(value, key) ? value[key] : fallback;
  const sum = values => values.reduce((total, item) => total + item, 0n);
  const min = (...values) => values.reduce((total, item) => item < total ? item : total);
  const max = (...values) => values.reduce((total, item) => item > total ? item : total);
  const positive = value => max(0n, value);
  const power = scale => 10n ** BigInt(scale);
  const textLength = value => Array.from(value).length;
  const pyString = value => value === null ? 'None' : value === true ? 'True' : value === false ? 'False' : String(value);

  function decimal(value) {
    const match = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/.exec(pyString(value).trim());
    if (!match) throw Error('Некорректное число.');
    const fraction = match[3] || match[4] || '';
    const exponent = Number(match[5] || 0);
    if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 10000) throw Error('Некорректное число.');
    let n = BigInt((match[2] || '0') + fraction), scale = fraction.length - exponent;
    if (match[1] === '-') n = -n;
    if (scale < 0) { n *= power(-scale); scale = 0; }
    return { n, scale };
  }

  function compare(a, b) {
    const scale = Math.max(a.scale, b.scale);
    const delta = a.n * power(scale - a.scale) - b.n * power(scale - b.scale);
    return delta < 0n ? -1 : delta > 0n ? 1 : 0;
  }

  function roundFraction(n, denominator) {
    const absolute = n < 0n ? -n : n;
    const rounded = absolute / denominator + (absolute % denominator * 2n >= denominator ? 1n : 0n);
    return n < 0n ? -rounded : rounded;
  }

  function decimalCents(value) {
    return value.scale <= 2 ? value.n * power(2 - value.scale) : roundFraction(value.n, power(value.scale - 2));
  }

  function money(value) {
    if (value === null) return null;
    const negative = value < 0n, absolute = negative ? -value : value;
    return (negative ? '-' : '') + (absolute / 100n).toString() + '.' + (absolute % 100n).toString().padStart(2, '0');
  }

  const percent = (base, rate) => roundFraction(base * rate.n, 100n * power(rate.scale));
  const cash = value => value === null ? null : decimalCents(decimal(value));

  function yearValue(value, label = 'year') {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1900 || value > 9998) throw Error(`${label}: ожидается целый календарный год 1900–9998.`);
    return value;
  }

  function amount(value, label, signed = false) {
    if (value === null || value === '') return null;
    if (typeof value !== 'string' && typeof value !== 'number') throw Error(`${label}: ожидается денежная сумма.`);
    const text = pyString(value).trim().replace(/[\u00a0 ]/g, '').replace(/,/g, '.');
    const pattern = signed ? /^-?\d+(?:\.\d{1,2})?$/ : /^\d+(?:\.\d{1,2})?$/;
    if (!pattern.test(text)) throw Error(`${label}: ожидается сумма максимум с двумя знаками после запятой.`);
    const result = cash(text);
    if (result > 100000000000000000n || result < -100000000000000000n) throw Error(`${label}: сумма превышает допустимый предел.`);
    return money(result);
  }

  function boolean(value, label, nullable = false) {
    if (nullable && value === null) return null;
    if (typeof value !== 'boolean') throw Error(`${label}: ожидается логическое true/false.`);
    return value;
  }

  function textValue(value, label, limit = 5000) {
    if (typeof value !== 'string' || textLength(value) > limit) throw Error(`${label}: ожидается текст до ${limit} символов.`);
    return value.trim();
  }

  function keys(value, allowed, label) {
    const unknown = Object.keys(value).filter(key => !allowed.includes(key)).sort();
    if (unknown.length) throw Error(`${label}: неизвестные поля: ${unknown.join(', ')}.`);
  }

  function validDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [year, month, day] = value.split('-').map(Number);
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const lengths = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    return year >= 1 && year <= 9999 && month >= 1 && month <= 12 && day >= 1 && day <= lengths[month - 1];
  }

  function defaultLedger(year) {
    yearValue(year);
    return { year, policy: 'unconfirmed', policy_confirmed: false, additional_recognition: 'unconfirmed',
      full_year_activity: null, fixed_override: null, fixed_override_reason: '', prior_additional_amount: null,
      prior_additional_used: null, prior_additional_confirmed: false,
      periods: PERIODS.map(period => {
        const row = { period };
        for (const key of PERIOD_MONEY) row[key] = null;
        return { ...row, income_confirmed: false, expenses_confirmed: false, income_note: '', expense_note: '' };
      }), payments: [] };
  }

  function validateLedger(ledger) {
    if (!object(ledger)) throw Error('ledger: ожидается объект.');
    keys(ledger, ['year', 'policy', 'policy_confirmed', 'additional_recognition', 'full_year_activity',
      'fixed_override', 'fixed_override_reason', 'prior_additional_amount', 'prior_additional_used',
      'prior_additional_confirmed', 'periods', 'payments'], 'ledger');
    const value = defaultLedger(get(ledger, 'year'));
    for (const [key, allowed] of [['policy', ['unconfirmed', 'accrued', 'paid']], ['additional_recognition', ['unconfirmed', 'current', 'next']]]) {
      const choice = get(ledger, key, value[key]);
      if (typeof choice !== 'string' || !allowed.includes(choice)) throw Error(`${key}: неподдерживаемое значение.`);
      value[key] = choice;
    }
    for (const key of ['policy_confirmed', 'prior_additional_confirmed']) value[key] = boolean(get(ledger, key, false), key);
    value.full_year_activity = boolean(get(ledger, 'full_year_activity'), 'full_year_activity', true);
    for (const key of ['fixed_override', 'prior_additional_amount', 'prior_additional_used']) value[key] = amount(get(ledger, key), key);
    value.fixed_override_reason = textValue(get(ledger, 'fixed_override_reason', ''), 'fixed_override_reason');
    if (value.prior_additional_amount !== null && value.prior_additional_used !== null && cash(value.prior_additional_used) > cash(value.prior_additional_amount)) throw Error('prior_additional_used: ранее признанная сумма превышает начисленный взнос.');
    const rows = get(ledger, 'periods', []);
    if (!Array.isArray(rows) || rows.length > PERIODS.length) throw Error('periods: ожидается список не более четырёх периодов.');
    const seen = new Set();
    const byPeriod = new Map(value.periods.map(row => [row.period, row]));
    for (const row of rows) {
      if (!object(row) || typeof row.period !== 'string' || !PERIODS.includes(row.period)) throw Error('periods: неподдерживаемый период.');
      keys(row, ['period', 'income_confirmed', 'expenses_confirmed', 'income_note', 'expense_note',
        'source_issues', ...PERIOD_MONEY, ...PREPARED_MONEY], 'period');
      const period = row.period;
      if (seen.has(period)) throw Error('periods: периоды не должны повторяться.');
      seen.add(period);
      const target = byPeriod.get(period);
      for (const key of PERIOD_MONEY) target[key] = amount(get(row, key), `${period}.${key}`, key === 'income_override');
      for (const key of ['income_confirmed', 'expenses_confirmed']) target[key] = boolean(get(row, key, false), `${period}.${key}`);
      for (const key of ['income_note', 'expense_note']) target[key] = textValue(get(row, key, ''), `${period}.${key}`);
      for (const key of PREPARED_MONEY) if (own(row, key)) target[key] = amount(row[key], `${period}.${key}`, ['marketplace_income', 'marketplace_revenue'].includes(key));
      if (own(row, 'source_issues')) {
        if (!Array.isArray(row.source_issues) || row.source_issues.length > 1000) throw Error(`${period}.source_issues: ожидается список вопросов.`);
        target.source_issues = [];
        for (const issue of row.source_issues) {
          if (!object(issue) || !['blocking', 'warning', 'info'].includes(issue.severity)) throw Error(`${period}.source_issues: некорректный вопрос.`);
          const cleaned = { code: textValue(get(issue, 'code', ''), 'source_issue.code', 128), severity: issue.severity, message: textValue(get(issue, 'message', ''), 'source_issue.message') };
          if (own(issue, 'sources')) {
            if (!Array.isArray(issue.sources)) throw Error('source_issue.sources: ожидается список.');
            cleaned.sources = clone(issue.sources);
          }
          target.source_issues.push(cleaned);
        }
      }
    }
    const payments = get(ledger, 'payments', []);
    if (!Array.isArray(payments) || payments.length > 1000) throw Error('payments: ожидается список не более 1000 оплат.');
    const ids = new Set();
    for (const payment of payments) {
      if (!object(payment)) throw Error('payments: ожидается объект оплаты.');
      keys(payment, ['id', 'kind', 'amount', 'date', 'liability_year', 'confirmed', 'source', 'note'], 'payment');
      const identifier = textValue(get(payment, 'id', ''), 'payment.id', 128);
      if (!identifier || ids.has(identifier)) throw Error('payment.id: идентификатор отсутствует или повторяется.');
      ids.add(identifier);
      const kind = get(payment, 'kind');
      if (!['usn', 'fixed', 'additional', 'ens_topup'].includes(kind)) throw Error('payment.kind: неподдерживаемый вид оплаты.');
      const paymentAmount = amount(get(payment, 'amount'), 'payment.amount');
      if (paymentAmount === null) throw Error('payment.amount: сумма обязательна.');
      const date = get(payment, 'date');
      if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw Error('payment.date: ожидается дата YYYY-MM-DD.');
      if (!validDate(date)) throw Error('payment.date: некорректная календарная дата.');
      const liabilityYear = get(payment, 'liability_year');
      if (kind !== 'ens_topup' || liabilityYear !== null) {
        yearValue(liabilityYear, 'payment.liability_year');
        if (![value.year - 1, value.year].includes(liabilityYear)) throw Error('payment.liability_year: поддерживаются обязательства выбранного и предыдущего года.');
        if (Number(date.slice(0, 4)) < liabilityYear) throw Error('payment.date: оплата раньше года обязательства не подтверждает его погашение.');
      }
      value.payments.push({ id: identifier, kind, amount: paymentAmount, date, liability_year: liabilityYear,
        confirmed: boolean(get(payment, 'confirmed', false), 'payment.confirmed'),
        source: textValue(get(payment, 'source', ''), 'payment.source'), note: textValue(get(payment, 'note', ''), 'payment.note') });
    }
    return value;
  }

  function calculateFiscalYear(profile, ledger, config) {
    const value = validateLedger(ledger);
    if (!object(profile) || !object(config)) throw Error('Профиль и справочник правил должны быть объектами.');
    const year = value.year, yearRules = get(config.years || {}, String(year));
    const regime = get(profile, 'tax_regime', 'income'), regimeRules = typeof regime === 'string' ? get(config.regimes || {}, regime) : null;
    const common = [];
    function question(target, code, message, severity = 'blocking') {
      if (!target.some(item => item.code === code)) target.push({ code, severity, message });
    }
    if (yearRules === null) question(common, 'fiscal_year_unsupported', 'Для выбранного года нет проверенного справочника налогов и взносов.');
    if (regimeRules === null) question(common, 'tax_regime_unsupported', 'Поддерживаются только УСН «Доходы» и «Доходы минус расходы».');
    let rate = null;
    if (regimeRules !== null) {
      try {
        const inputRate = get(profile, 'usn_rate');
        rate = decimal(inputRate !== null && inputRate !== '' ? inputRate : regimeRules.default_rate);
        if (compare(rate, decimal('0')) < 0 || compare(rate, decimal(regimeRules.max_rate)) > 0) throw Error('Недопустимая ставка.');
      } catch (_) {
        rate = null;
        question(common, 'fiscal_rate_invalid', 'Ставка УСН не входит в поддерживаемый диапазон выбранного режима.');
      }
      if (rate !== null && rate.n === 0n) question(common, 'zero_rate_manual', 'Нулевая льготная ставка требует ручной проверки права и правил минимального налога.');
    }
    const employees = get(profile, 'has_employees');
    if (typeof employees !== 'boolean') question(common, 'employees_unknown', 'Подтвердите, есть ли у ИП работники.');
    else if (employees) question(common, 'employees_manual', 'Есть работники: показан предел уменьшения 50%, но расходы и взносы за работников требуют ручной проверки.');
    if (value.policy === 'unconfirmed' || !value.policy_confirmed) question(common, 'contribution_policy_unconfirmed', 'Способ признания собственных взносов ещё не подтверждён бухгалтером.');
    if (value.additional_recognition === 'unconfirmed') question(common, 'additional_recognition_unconfirmed', 'Не выбран год однократного признания текущего дополнительного взноса: текущий или следующий.');

    let fixed = null;
    if (yearRules !== null) {
      const standardFixed = cash(yearRules.fixed_contribution);
      if (value.full_year_activity === true && value.fixed_override === null) fixed = standardFixed;
      else if (value.fixed_override !== null && value.fixed_override_reason && value.full_year_activity !== null) {
        fixed = cash(value.fixed_override);
        if (fixed > standardFixed) question(common, 'fixed_override_exceeds_standard', 'Введённая сумма собственных фиксированных взносов превышает стандарт за год. Проверьте основание.');
        question(common, 'fixed_override_manual', 'Использована вручную подтверждённая сумма фиксированных взносов и её основание.', 'warning');
      } else question(common, 'fixed_activity_unconfirmed', 'Подтвердите полный год деятельности либо укажите сумму взносов за неполный год и основание. Автоматическое пропорциональное начисление не выполняется.');
    }
    const priorAmount = cash(value.prior_additional_amount), priorUsed = cash(value.prior_additional_used);
    const priorRemaining = priorAmount !== null && priorUsed !== null ? priorAmount - priorUsed : null;
    const priorYearRules = config.years?.[String(year - 1)];
    if (priorAmount !== null && priorAmount > 0n) {
      if (!priorYearRules) question(common, 'prior_additional_cap_unknown', 'Для года прошлого дополнительного взноса нет проверенного предела. Требуется ручная проверка справочника.');
      else if (priorAmount > cash(priorYearRules.additional_cap)) question(common, 'prior_additional_above_cap', 'Начисленный дополнительный взнос прошлого года превышает годовой предел из справочника. Исправьте сумму или проверьте год обязательства.');
    }
    if (priorRemaining === null) question(common, 'prior_additional_unknown', 'Укажите начисленный дополнительный взнос прошлого года и уже признанную сумму, в том числе подтверждённые нули.');
    if (!value.prior_additional_confirmed) question(common, 'prior_additional_unconfirmed', 'Остаток дополнительного взноса прошлого года требует подтверждения, чтобы не признать его дважды.');
    if (regime === 'income_expenses' && year < config.expenses_accrual_available_from && value.policy === 'accrued') question(common, 'expenses_accrual_unsupported', 'Для этого года не поддерживается признание собственных взносов в расходах без оплаты.');
    if (regime === 'income_expenses' && yearRules !== null && !yearRules.additional_expenses_base_supported) question(common, 'historical_additional_rule_manual', 'Историческая база дополнительного взноса для УСН «Доходы минус расходы» требует отдельной проверки. Формула 2026 года автоматически не применяется.');
    let priorYearIncome = null;
    try {
      priorYearIncome = decimal(get(profile, 'prior_year_income'));
      if (priorYearIncome.n < 0n) throw Error('Некорректный доход.');
    } catch (_) {
      priorYearIncome = null;
      question(common, 'fiscal_vat_prior_income_missing', 'Для проверки освобождения от НДС подтвердите полный доход предыдущего календарного года.');
    }
    if (get(profile, 'income_data_complete') !== true) question(common, 'fiscal_vat_evidence_incomplete', 'В профиле не подтверждена полнота сведений о доходах для освобождения от НДС.');
    if (get(profile, 'period') && pyString(profile.period).slice(0, 4) !== String(year)) question(common, 'fiscal_vat_evidence_year', 'Доход предыдущего года в профиле относится к другому расчётному году. Уточните профиль.');
    if (get(profile, 'vat_status') !== 'exempt') question(common, 'fiscal_vat_unsupported', 'Годовой модуль поддерживает только подтверждённое освобождение от НДС. НДС нужно проверить отдельно.');
    else {
      const effective = get(profile, 'vat_effective_from');
      if (!validDate(effective) || effective > `${year}-01-01`) question(common, 'fiscal_vat_effective_date', 'Освобождение от НДС не подтверждено на начало выбранного года; требуется проверка периода деятельности.');
    }
    if (yearRules !== null && priorYearIncome !== null && compare(priorYearIncome, decimal(yearRules.vat_exemption_threshold)) > 0) question(common, 'fiscal_vat_required', 'Доход предыдущего года превышает порог освобождения от НДС для выбранного года.');
    question(common, 'fiscal_draft', 'Это накопительный черновик в рублях и копейках. Уведомление и декларацию формирует и проверяет бухгалтер; оплаты не выполняются.', 'info');

    const resultRows = [];
    const periodsConfig = new Map(config.periods.map(item => [item.period, item]));
    for (const row of value.periods) {
      const period = row.period, details = periodsConfig.get(period);
      const end = `${year + (details.months === 12 ? 1 : 0)}-${String(details.months % 12 + 1).padStart(2, '0')}-01`;
      const start = `${year}-01-01`, issues = clone(common);
      for (const sourceIssue of row.source_issues || []) issues.push(clone(sourceIssue));
      const number = key => cash(get(row, key));
      const override = number('income_override'), outside = number('outside_income');
      const marketIncome = number('marketplace_income'), marketRevenue = number('marketplace_revenue');
      const income = override !== null ? override : marketIncome !== null && outside !== null ? marketIncome + outside : null;
      if (income === null) question(issues, 'fiscal_income_missing', 'Нужен полный накопительный доход: либо ручной итог, либо доход маркетплейсов плюс подтверждённый доход вне них.');
      if (!row.income_confirmed) question(issues, 'fiscal_income_unconfirmed', 'Полнота дохода и налоговые даты за накопительный период не подтверждены.');
      if (income !== null && income < 0n) question(issues, 'fiscal_income_negative', 'Накопительный доход отрицателен. Возвраты и переносы требуют ручного подтверждения; налоговая база ограничена нулём.');
      if (yearRules !== null && income !== null && income > cash(yearRules.vat_exemption_threshold)) question(issues, 'fiscal_vat_threshold_crossed', 'Накопительный доход превысил порог освобождения от НДС. Проверьте месяц превышения и переход со следующего месяца.');
      if (yearRules !== null && resultRows.some(p => p.income !== null && cash(p.income) > cash(yearRules.vat_exemption_threshold))) question(issues, 'fiscal_vat_previously_crossed', 'В более раннем накопительном периоде уже превышен порог НДС. Последующие возвраты не восстанавливают освобождение; проверьте дату перехода.');
      let managementExpenses = number('management_expenses');
      const managementComplete = managementExpenses !== null;
      if (managementExpenses === null) {
        managementExpenses = number('marketplace_costs');
        question(issues, 'management_expenses_incomplete', 'В управленческих расходах показаны только известные удержания маркетплейсов; себестоимость и остальные расходы не подтверждены.', 'warning');
      }
      const managementRevenue = marketRevenue !== null && outside !== null ? marketRevenue + outside : income;
      if (marketRevenue === null || outside === null) question(issues, 'management_revenue_tax_basis', 'Для прибыли используется приближение по налоговому доходу. Выручка по датам событий и вне маркетплейсов ещё не подтверждена.', 'warning');
      const profit = managementRevenue !== null && managementExpenses !== null ? managementRevenue - managementExpenses : null;
      const expenses = number('tax_expenses');
      if (regime === 'income_expenses') {
        if (expenses === null) question(issues, 'fiscal_expenses_missing', 'Укажите накопительные признанные налоговые расходы без собственных взносов ИП.');
        if (!row.expenses_confirmed) question(issues, 'fiscal_expenses_unconfirmed', 'Условия признания налоговых расходов не подтверждены бухгалтером.');
      }
      let contributionBase = regime === 'income' ? income : regime === 'income_expenses' && income !== null && expenses !== null ? income - expenses : null;
      if (regime === 'income_expenses' && yearRules !== null && !yearRules.additional_expenses_base_supported) contributionBase = null;
      let additional = null;
      if (income !== null && contributionBase !== null && yearRules !== null) additional = min(percent(positive(contributionBase - cash(config.additional_threshold)), decimal(config.additional_rate)), cash(yearRules.additional_cap));
      const applicable = value.payments.filter(payment => payment.confirmed && start <= payment.date && payment.date < end);
      const paid = (kind, liabilityYear) => sum(applicable.filter(payment => payment.kind === kind && payment.liability_year === liabilityYear).map(payment => cash(payment.amount)));
      const fixedPaid = paid('fixed', year), additionalPaid = paid('additional', year), priorPaid = paid('additional', year - 1), usnPaid = paid('usn', year);
      const contributionsPaid = fixedPaid + additionalPaid;
      if (applicable.some(payment => payment.kind === 'ens_topup')) question(issues, 'ens_not_contribution_payment', 'Пополнение ЕНС показано отдельно: оно само по себе не подтверждает уплату конкретных взносов или УСН.', 'info');
      let eligible = null;
      if (fixed !== null && priorRemaining !== null && value.policy !== 'unconfirmed' && value.additional_recognition !== 'unconfirmed') {
        let currentFixed, recognizedPrior, recognizedAdditional;
        if (value.policy === 'accrued') {
          currentFixed = fixed; recognizedPrior = priorRemaining;
          recognizedAdditional = value.additional_recognition === 'current' ? additional : 0n;
        } else {
          currentFixed = min(fixed, fixedPaid); recognizedPrior = min(priorRemaining, priorPaid);
          recognizedAdditional = value.additional_recognition === 'next' ? 0n : additional !== null ? min(additional, additionalPaid) : null;
        }
        if (recognizedAdditional !== null) eligible = currentFixed + recognizedPrior + recognizedAdditional;
      }
      let taxableBase = null, taxAssessed = null, minimumTax = null, after = null, applied = null, unused = null;
      if (regime === 'income' && income !== null) {
        taxableBase = positive(income);
        if (rate !== null) taxAssessed = percent(taxableBase, rate);
        if (taxAssessed !== null && eligible !== null && typeof employees === 'boolean') {
          const limitRate = decimal(config.employees_reduction_limit);
          const limit = employees ? taxAssessed * limitRate.n / (100n * power(limitRate.scale)) : taxAssessed;
          applied = min(eligible, taxAssessed, limit);
          unused = eligible - applied; after = taxAssessed - applied;
        }
      } else if (regime === 'income_expenses' && income !== null && expenses !== null) {
        if (eligible !== null) { applied = eligible; unused = 0n; taxableBase = positive(income - expenses - eligible); }
        if (rate !== null && taxableBase !== null) taxAssessed = percent(taxableBase, rate);
        if (period === 'year') minimumTax = percent(positive(income), decimal(config.minimum_tax_rate));
        if (taxAssessed !== null) after = minimumTax !== null ? max(taxAssessed, minimumTax) : taxAssessed;
      }
      const previousAdvances = number('prior_advances'), previousDeduction = number('previous_deduction');
      if (previousAdvances === null) question(issues, 'prior_advances_unknown', 'Укажите ранее начисленные авансы за этот год. Оплаты и пополнение ЕНС не заменяют начисления.');
      if (previousDeduction === null) question(issues, 'previous_deduction_unknown', 'Для проверки истории укажите ранее использованные взносы. Накопительный вычет не уменьшается на них второй раз.', 'warning');
      else if (applied !== null && previousDeduction > applied) question(issues, 'previous_deduction_recheck', 'Ранее применённые взносы больше текущего накопительного уменьшения. Проверьте перерасчёт прошлых авансов.', 'warning');
      if (period !== 'q1' && previousDeduction === 0n && previousAdvances !== null && previousAdvances > 0n && applied !== null && applied > 0n) question(issues, 'prior_contributions_not_used', 'В истории прошлых авансов взносы не учтены: возможны завышение налога и переплата. Сверьте начисления, оплаты и необходимость уточнённой декларации с бухгалтером.', 'warning');
      if (fixed !== null && fixedPaid > fixed || additional !== null && additionalPaid > additional) question(issues, 'contribution_payment_excess', 'Подтверждённые оплаты превышают расчёт конкретного взноса. Это возможная переплата, а не автоматический возврат.', 'warning');
      const ready = !issues.some(issue => issue.severity === 'blocking');
      const difference = after !== null && previousAdvances !== null ? after - previousAdvances : null;
      const accrued = fixed !== null && additional !== null ? fixed + additional : null;
      const usnBalanceDraft = after !== null ? after - usnPaid : null;
      const contributionsBalanceDraft = accrued !== null ? accrued - contributionsPaid : null;
      const total = after !== null && accrued !== null ? after + accrued : null;
      resultRows.push({ period, label: details.label, income: money(income), management_revenue: money(managementRevenue),
        management_expenses: money(managementExpenses), management_expenses_complete: managementComplete,
        profit_before_tax: money(profit), profit_after_tax: money(profit !== null && total !== null ? profit - total : null), tax_expenses: money(expenses), additional_contribution: money(additional), fixed_contribution: money(fixed),
        prior_additional_remaining: money(priorRemaining), contribution_eligible: money(eligible), contribution_applied: money(applied),
        unused_contribution: money(unused), taxable_base: money(taxableBase), tax_assessed: money(taxAssessed), minimum_tax: money(minimumTax),
        tax_after_reduction: money(after), prior_advances: money(previousAdvances), previous_deduction: money(previousDeduction),
        advance_to_pay: ready && difference !== null ? money(positive(difference)) : null,
        advance_to_decrease: ready && difference !== null ? money(positive(-difference)) : null,
        usn_paid: money(usnPaid), usn_balance: ready ? money(usnBalanceDraft) : null, usn_balance_draft: money(usnBalanceDraft),
        contributions_paid: money(contributionsPaid), prior_additional_paid: money(priorPaid), contributions_accrued: money(accrued),
        contributions_balance: ready ? money(contributionsBalanceDraft) : null, contributions_balance_draft: money(contributionsBalanceDraft),
        total_tax_and_contributions: money(total), ready, issues });
    }
    return { year, regime, rate: rate === null ? null : money(decimalCents(rate)), rules_version: get(config, 'rules_version'), issues: common, periods: resultRows };
  }

  const api = Object.freeze({ calculateFiscalYear, validateLedger, defaultLedger });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.AccountingPlusFiscal = api;
})(typeof window !== 'undefined' ? window : typeof globalThis !== 'undefined' ? globalThis : null);
