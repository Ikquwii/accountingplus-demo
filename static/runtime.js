/* Educational browser storage adapter. It never sends accounting data to a server. */
(() => {
  'use strict';
  const fixtureUrl = new URL('./fixtures.json', document.currentScript.src);
  const taxRulesUrl = new URL('./tax-rules.json', document.currentScript.src);
  const STORAGE_KEY = 'accountingplus-demo-v1';
  const PROFILE_FIELDS = ['name', 'inn', 'marketplace', 'region', 'usn_rate', 'vat_status', 'vat_effective_from', 'prior_year_income', 'ytd_income_before_period', 'income_data_complete', 'opening_balance', 'period', 'tax_regime', 'has_employees'];
  const TAX_PROFILE_FIELDS = ['region', 'tax_regime', 'usn_rate', 'has_employees', 'vat_status', 'vat_effective_from', 'prior_year_income', 'special_tax_cases'];
  const LEDGER_FIELDS = ['year', 'policy', 'policy_confirmed', 'additional_recognition', 'full_year_activity', 'fixed_override', 'fixed_override_reason', 'prior_additional_amount', 'prior_additional_used', 'prior_additional_confirmed', 'periods', 'payments'];
  const LEDGER_PERIOD_FIELDS = ['period', 'income_override', 'outside_income', 'tax_expenses', 'management_expenses', 'prior_advances', 'previous_deduction', 'income_confirmed', 'expenses_confirmed', 'income_note', 'expense_note'];
  const PAYMENT_FIELDS = ['id', 'kind', 'amount', 'date', 'liability_year', 'confirmed', 'source', 'note'];
  const EVENT_FIELDS = ['kind', 'tax_date', 'settlement_id', 'related_id', 'note'];
  const HEADERS = ['external_id', 'kind', 'date', 'amount', 'tax_date', 'settlement_id', 'related_id', 'note', 'vat_rate', 'vat_amount'];
  const RESULT_METADATA = new Set(['context', 'snapshot_status', 'is_stale', 'id', 'client_id', 'period', 'version', 'status', 'created_at', 'reviewer', '_demo_revision', '_demo_fingerprint']);
  const LABELS = { sales: 'Продажи', returns: 'Возвраты', usn_income: 'Доход для УСН по загруженным данным', commission: 'Комиссии', logistics: 'Логистика', withholding: 'Прочие удержания', expected_payout: 'К выплате после удержаний', declared_payouts: 'Выплаты по отчёту', bank_received: 'Связанные поступления банка, включая следующий период', payout_difference: 'Выплаты минус связанные поступления', closing_balance: 'Остаток расчётов с маркетплейсом', usn_tax_preliminary: 'Предварительный налог УСН до уменьшений' };
  const clone = value => JSON.parse(JSON.stringify(value));
  const now = () => new Date().toISOString();
  const id = () => crypto.randomUUID().replaceAll('-', '');
  const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const publicClone = value => JSON.parse(JSON.stringify(value, (key, item) => key.startsWith('_demo_') ? undefined : item));
  const stable = value => JSON.stringify(value, (_, item) => plain(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
  const unknownFields = (value, allowed, message) => {
    if (!plain(value)) throw new Error('Ожидается объект с полями.');
    if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error(message);
  };
  const periodValue = value => {
    if (typeof value !== 'string' || !/^20\d{2}-(0[1-9]|1[0-2])$/.test(value)) throw new Error('Некорректный календарный период: ожидается YYYY-MM.');
    return value;
  };
  function dateValue(value, nullable = false) {
    if (value === null || value === undefined || String(value).trim() === '') {
      if (nullable) return null;
      throw new Error('Дата: значение отсутствует.');
    }
    const text = String(value).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error('Дата: ожидается YYYY-MM-DD.');
    const parsed = new Date(`${text}T00:00:00Z`);
    if (Number(text.slice(0, 4)) < 1 || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) throw new Error('Некорректная календарная дата.');
    return text;
  }
  function moneyValue(value, nullable = false) {
    if (value === null || value === undefined || String(value).trim() === '') {
      if (nullable) return null;
      throw new Error('Сумма: значение отсутствует.');
    }
    if (typeof value === 'boolean') throw new Error('Сумма: ожидается число.');
    const text = String(value).trim().replace(/[ \u00a0]/g, '').replace(',', '.');
    if (!/^\d+(?:\.\d{1,2})?$/.test(text)) throw new Error('Сумма: требуется неотрицательное число максимум с двумя знаками после запятой.');
    const [whole, part = ''] = text.split('.');
    const cents = BigInt(whole) * 100n + BigInt(part.padEnd(2, '0'));
    if (cents > 100000000000000000n) throw new Error('Сумма превышает допустимый предел.');
    return `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
  }
  function validateProfile(profile) {
    const p = { ...profile };
    if (typeof p.name !== 'string' || !p.name.trim() || p.name.trim().length > 150) throw new Error('Укажите имя клиента (1–150 символов).');
    p.name = p.name.trim();
    if (typeof p.inn !== 'string') throw new Error('ИНН должен быть строкой из 12 цифр или пустым.');
    p.inn = p.inn.trim();
    if (p.inn && !/^\d{12}$/.test(p.inn)) throw new Error('Для ИП требуется ИНН из 12 цифр; для учебного примера поле можно оставить пустым.');
    if (!['wb', 'ozon'].includes(p.marketplace)) throw new Error('Выберите Wildberries или Ozon.');
    if (typeof p.region !== 'string' || p.region.length > 150) throw new Error('Регион должен быть текстом до 150 символов.');
    p.tax_regime ??= 'income';
    if (!['income', 'income_expenses'].includes(p.tax_regime)) throw new Error('Выберите УСН «Доходы» или «Доходы минус расходы».');
    p.has_employees ??= null;
    if (p.has_employees !== null && typeof p.has_employees !== 'boolean') throw new Error('Укажите наличие работников или оставьте статус неизвестным.');
    const regimeRules = taxRules.regimes[p.tax_regime];
    p.usn_rate = moneyValue(p.usn_rate === null || p.usn_rate === undefined || String(p.usn_rate).trim() === '' ? regimeRules.default_rate : p.usn_rate);
    if (Number(p.usn_rate) > Number(regimeRules.max_rate)) throw new Error(`Ставка выбранного режима УСН должна быть от 0 до ${regimeRules.max_rate}%.`);
    if (!['exempt', 'unknown', '5', '7'].includes(p.vat_status)) throw new Error('Некорректный статус НДС.');
    p.vat_effective_from = dateValue(p.vat_effective_from, true);
    p.prior_year_income = moneyValue(p.prior_year_income, true);
    p.ytd_income_before_period = moneyValue(p.ytd_income_before_period, true);
    if (p.opening_balance !== null && p.opening_balance !== undefined && String(p.opening_balance).trim() !== '') {
      const opening = String(p.opening_balance).trim(); const negative = opening.startsWith('-');
      p.opening_balance = `${negative ? '-' : ''}${moneyValue(negative ? opening.slice(1) : opening)}`;
    } else p.opening_balance = null;
    if (typeof p.income_data_complete !== 'boolean') throw new Error('Признак полноты доходов должен быть true или false.');
    p.period = periodValue(p.period);
    return p;
  }
  function resultContent(result) {
    const content = Object.fromEntries(Object.entries(result).filter(([key]) => !RESULT_METADATA.has(key) && key !== '_data_revision'));
    // Server snapshots nest the annual profile; browser results also expose it at the top level.
    const taxProfile = result.tax_profile ?? result.context?.tax_profile;
    if (taxProfile) content.tax_profile = taxProfile;
    return content;
  }
  function originalContent(event) {
    const fields = ['source', 'external_id', 'kind', 'original_kind', 'date', 'tax_date', 'amount', 'settlement_id', 'related_id', 'note', 'vat_rate', 'vat_amount', 'extra_fields'];
    if (event.adapter) {
      return Object.fromEntries([...fields.filter(key => key !== 'note'), 'adapter', 'adapter_version', 'account_id'].map(key => [key, event[key] ?? (key === 'extra_fields' ? {} : null)]));
    }
    return Object.fromEntries(fields.map(key => [key, event[key] ?? (key === 'extra_fields' ? {} : ['note', 'external_id'].includes(key) ? '' : null)]));
  }
  function makeBaseline(fixtures) {
    if (fixtures?.schema !== 1 || !Array.isArray(fixtures.workspaces) || !Array.isArray(fixtures.scenarios) || !plain(fixtures.originals)) throw new Error('Учебный набор имеет неподдерживаемый формат.');
    const db = { schema: 1, workspaces: clone(fixtures.workspaces), originals: clone(fixtures.originals) };
    for (const workspace of db.workspaces) {
      workspace.data_revision ??= workspace.client?._data_revision ?? 0;
      workspace.client._data_revision = workspace.data_revision;
      if (workspace.tax_profile) { workspace.tax_profiles = { [workspace.tax_profile.year]: clone(workspace.tax_profile) }; delete workspace.tax_profile; }
      if (workspace.events.every(event => Array.isArray(event.occurrences))) workspace.event_occurrences = workspace.events.flatMap(event => event.occurrences.map(occurrence => ({ event_id: event.id, file_id: occurrence.file_id, line: occurrence.line, original: originalContent(event) })));
      workspace.results = workspace.result ? [workspace.result] : [];
      delete workspace.result;
      for (const event of workspace.events) event._demo_original = originalContent(event);
      for (const result of workspace.results) {
        result._demo_revision = workspace.data_revision;
        result._demo_fingerprint = stable(resultContent(result));
      }
    }
    validateDatabase(db);
    return db;
  }
  function validateDatabase(value) {
    if (!plain(value) || value.schema !== 1 || !Array.isArray(value.workspaces) || !plain(value.originals) || value.workspaces.length > 100) throw new Error('Неподдерживаемый формат сохранённых данных.');
    const clientIds = new Set();
    for (const workspace of value.workspaces) {
      if (!plain(workspace) || typeof workspace.client?.id !== 'string' || clientIds.has(workspace.client.id) || !Number.isSafeInteger(workspace.data_revision) || workspace.data_revision < 0) throw new Error('Некорректное рабочее место.');
      clientIds.add(workspace.client.id);
      workspace.client = validateProfile(workspace.client);
      workspace.financial_drafts ??= {};
      workspace.financial_history ??= {};
      if (!plain(workspace.financial_drafts)) throw new Error('Некорректные годовые черновики.');
      for (const [year, draft] of Object.entries(workspace.financial_drafts)) {
        if (!/^20\d{2}$/.test(year) || !plain(draft) || !Number.isSafeInteger(draft.revision) || draft.revision < 0 || draft.ledger?.year !== Number(year)) throw new Error('Некорректный годовой черновик.');
        draft.ledger = userLedger(draft.ledger);
      }
      for (const key of ['files', 'events', 'history', 'results']) if (!Array.isArray(workspace[key])) throw new Error('Некорректные списки рабочего места.');
      if (workspace.events.length > 10000 || workspace.files.length > 1000 || workspace.history.length > 20000 || workspace.results.length > 1000) throw new Error('Слишком большой учебный набор.');
      if (workspace.files.some(file => !plain(file) || typeof file.id !== 'string' || file.client_id !== workspace.client.id)) throw new Error('Некорректные документы клиента.');
      if (workspace.events.some(event => !plain(event) || typeof event.id !== 'string' || event.client_id !== workspace.client.id || !workspace.files.some(file => file.id === event.file_id))) throw new Error('Некорректные операции клиента.');
      migrateIntegrity(workspace, value.originals);
      if (workspace.results.some(result => !plain(result) || typeof result.id !== 'string' || result.client_id !== workspace.client.id || !plain(result.metrics) || !Array.isArray(result.issues) || !Array.isArray(result.income_rows) || !Array.isArray(result.reconciliation))) throw new Error('Некорректный сохранённый расчёт.');
    }
    return value;
  }
  function profileFields(profile) { return Object.fromEntries(TAX_PROFILE_FIELDS.map(key => [key, key === 'special_tax_cases' ? profile[key] ?? 'unknown' : profile[key]])); }
  function unknownTaxProfile(year) { return { region: '', tax_regime: 'income', usn_rate: '6.00', has_employees: null, vat_status: 'unknown', vat_effective_from: `${year}-01-01`, prior_year_income: null, special_tax_cases: 'unknown' }; }
  function profileCanConfirm(profile) { return typeof profile.has_employees === 'boolean' && profile.vat_status !== 'unknown' && profile.prior_year_income !== null; }
  function annualProfile(workspace, year) {
    year = financeYear(year);
    return clone(workspace.tax_profiles?.[String(year)] || { year, revision: 0, confirmed: false, profile: unknownTaxProfile(year) });
  }
  function initializeNewWorkspace(workspace) {
    const year = Number(workspace.client.period.slice(0, 4));
    workspace.tax_profiles = { [year]: { year, revision: 1, confirmed: profileCanConfirm(workspace.client), profile: profileFields(workspace.client) } };
    workspace.event_occurrences = []; workspace.integrity_issues = []; workspace.financial_history = {};
    workspace.supplementary_records = {}; workspace.record_revisions = {}; workspace.assessments = {};
    return workspace;
  }
  function syncOccurrences(workspace) {
    for (const event of workspace.events) {
      const live = workspace.event_occurrences.filter(item => item.event_id === event.id && workspace.files.some(file => file.id === item.file_id && file.status === 'imported'));
      const active = live.length > 0;
      const occurrence = live.find(item => item.file_id === event.file_id) || live[0];
      if (event.active !== active || (occurrence && (event.file_id !== occurrence.file_id || event.line !== occurrence.line))) {
        event.version++; event.active = active;
        if (occurrence) { event.file_id = occurrence.file_id; event.line = occurrence.line; }
      }
    }
  }
  function migrateIntegrity(workspace, originals) {
    for (const event of workspace.events) {
      event.version ??= 0;
      if (!Number.isSafeInteger(event.version) || event.version < 0) throw new Error('Некорректная версия операции.');
    }
    if (!workspace.tax_profiles) {
      for (const result of workspace.results) result._demo_revision = -1;
      const year = Number(workspace.client.period.slice(0, 4));
      workspace.tax_profiles = { [year]: { year, revision: 1, confirmed: false, profile: profileFields(workspace.client), legacy_unverified: true } };
    }
    if (!plain(workspace.tax_profiles) || !plain(workspace.financial_history)) throw new Error('Некорректные годовые профили или история.');
    for (const [year, profile] of Object.entries(workspace.tax_profiles)) {
      if (Number(year) !== profile.year || !Number.isSafeInteger(profile.revision) || profile.revision < 0 || typeof profile.confirmed !== 'boolean') throw new Error('Некорректный годовой профиль.');
      unknownFields(profile.profile, TAX_PROFILE_FIELDS, 'Некорректные поля годового профиля.');
      if (!['unknown', 'none', 'present'].includes(profile.profile.special_tax_cases ?? 'unknown')) throw new Error('Некорректный статус особых налоговых случаев.');
      profile.profile = profileFields(validateProfile({ ...workspace.client, ...profile.profile }));
    }
    for (const [year, draft] of Object.entries(workspace.financial_drafts)) if (!workspace.financial_history[year]) {
      workspace.financial_history[year] = [{ year: Number(year), revision: draft.revision, ledger: clone(draft.ledger), profile: null, tax_profile: null, source_events: null, source_files: null, rules: null, result: null, sources: null, monthly: null, created_at: null, reviewer: null, actor_username: null, reason: 'Перенесён ранее сохранённый черновик. Исторический расчёт и профиль не были сохранены; требуется проверка.', legacy_unverified: true }];
    }
    workspace.supplementary_records ??= {}; workspace.record_revisions ??= {}; workspace.assessments ??= {};
    workspace.integrity_issues ??= [];
    if (!Array.isArray(workspace.event_occurrences)) {
      workspace.event_occurrences = [];
      for (const file of workspace.files.filter(item => ['imported', 'replaced'].includes(item.status))) {
        const owned = workspace.events.filter(event => event.file_id === file.id);
        for (const event of owned) workspace.event_occurrences.push({ event_id: event.id, file_id: file.id, line: event.line });
        try {
          if (typeof originals[file.id]?.text !== 'string') throw new Error('Исходный текст отсутствует.');
          for (const incoming of parseCsv(originals[file.id].text, file.source)) {
            if (owned.some(event => event.line === incoming.line || (incoming.external_id && event.external_id === incoming.external_id))) continue;
            const original = originalContent(incoming);
            let event = workspace.events.find(event => event.source === incoming.source && incoming.external_id && event.external_id === incoming.external_id && stable(event._demo_original || originalContent(event)) === stable(original));
            if (!event) { event = { ...incoming, id: id(), client_id: workspace.client.id, file_id: file.id, active: file.status === 'imported', version: 0, _demo_original: original }; workspace.events.push(event); }
            workspace.event_occurrences.push({ event_id: event.id, file_id: file.id, line: incoming.line });
          }
        } catch (error) {
          if (file.status === 'imported') workspace.integrity_issues.push({ code: 'legacy_source_unverified', severity: 'blocking', file_id: file.id, message: `Не удалось проверить все вхождения старого файла ${file.filename}. Загрузите его повторно с заменой: ${error.message}` });
        }
      }
      syncOccurrences(workspace);
      const known = new Map();
      for (const event of workspace.events.filter(event => event.active !== false && event.external_id)) {
        const key = stable([event.source, event.account_id ?? null, event.external_id]);
        if (known.has(key) && stable(known.get(key)._demo_original || originalContent(known.get(key))) !== stable(event._demo_original || originalContent(event))) workspace.integrity_issues.push({ code: 'legacy_sources_conflict', severity: 'blocking', file_id: event.file_id, message: `В старых источниках противоречат сведения операции ${event.external_id}. Проверьте и замените противоречащие документы.` });
        known.set(key, event);
      }
    }
    if (!Array.isArray(workspace.integrity_issues) || workspace.event_occurrences.some(item => !workspace.events.some(event => event.id === item.event_id) || !workspace.files.some(file => file.id === item.file_id))) throw new Error('Некорректные вхождения операций.');
  }
  function eventView(workspace, event) {
    return { ...event, occurrences: workspace.event_occurrences.filter(item => item.event_id === event.id).map(item => ({ file_id: item.file_id, line: item.line, active: workspace.files.some(file => file.id === item.file_id && file.status === 'imported') })) };
  }
  function activeEvents(workspace) { return workspace.events.filter(event => event.active !== false).map(event => eventView(workspace, event)); }
  function resultView(workspace, result) {
    if (!result) return null;
    return { ...result, snapshot_status: result.status, is_stale: result._demo_revision !== workspace.data_revision, status: result._demo_revision === workspace.data_revision ? result.status : 'stale' };
  }
  let fixtures, baseline, database, persistedText, taxRules;
  let queue = Promise.resolve();
  const blobUrls = new Map();
  const fixtureReady = (async () => {
    let response, rulesResponse;
    try { [response, rulesResponse] = await Promise.all([fetch(fixtureUrl), fetch(taxRulesUrl)]); }
    catch { throw new Error('Не удалось загрузить учебные примеры. Проверьте интернет и обновите страницу.'); }
    if (!response.ok) throw new Error('Учебные примеры временно недоступны. Обновите страницу позже.');
    if (!rulesResponse.ok) throw new Error('Справочник налоговых правил временно недоступен. Обновите страницу позже.');
    [fixtures, taxRules] = await Promise.all([response.json(), rulesResponse.json()]);
    if (!plain(taxRules) || !plain(taxRules.regimes) || !plain(taxRules.regimes.income) || !plain(taxRules.regimes.income_expenses) || !Array.isArray(taxRules.periods) || !plain(taxRules.years)) throw new Error('Справочник налоговых правил имеет неподдерживаемый формат.');
    baseline = makeBaseline(fixtures);
  })();
  function storageRead() {
    try { return localStorage.getItem(STORAGE_KEY); }
    catch { throw new Error('Браузер запретил доступ к сохранённым данным. Разрешите хранение данных этого сайта и обновите страницу.'); }
  }
  function loadSaved(text) {
    if (text === null) return clone(baseline);
    try { return validateDatabase(JSON.parse(text)); }
    catch {
      const error = new Error('Сохранённые учебные данные повреждены или несовместимы. Они не удалены. Используйте «Сбросить учебные правки», чтобы восстановить примеры.');
      error.code = 'DEMO_STORAGE_CORRUPT'; throw error;
    }
  }
  let ready = fixtureReady.then(() => { persistedText = storageRead(); database = loadSaved(persistedText); });
  // The frontend awaits `ready`; observing rejection here prevents a duplicate console rejection.
  ready.catch(() => {});
  function synchronize() {
    const latest = storageRead();
    if (latest !== persistedText) { database = loadSaved(latest); persistedText = latest; }
  }
  function exclusiveStorage(callback) {
    if (typeof window.navigator?.locks?.request !== 'function') throw new Error('Для сохранения учебных правок обновите браузер или используйте актуальный Chrome, Safari или Firefox. Просмотр примеров доступен без сохранения.');
    return window.navigator.locks.request(STORAGE_KEY, { mode: 'exclusive' }, callback);
  }
  function commit(candidate, expected) {
    if (storageRead() !== expected) throw new Error('Учебные данные изменились в другой вкладке. Обновите кабинет и повторите действие.');
    validateDatabase(candidate);
    const serialized = JSON.stringify(candidate);
    try { localStorage.setItem(STORAGE_KEY, serialized); }
    catch { throw new Error('Не удалось сохранить правку в браузере: хранилище заполнено или недоступно. Действие не применено. Освободите место или разрешите хранение данных.'); }
    database = candidate; persistedText = serialized;
  }
  function workspaceById(db, clientId) {
    const workspace = db.workspaces.find(item => item.client.id === clientId);
    if (!workspace) throw new Error('Учебный клиент не найден.');
    return workspace;
  }
  const latestResult = (workspace, period) => [...workspace.results].reverse().find(result => result.period === period) || null;
  function snapshot(workspace, period) {
    const taxProfile = annualProfile(workspace, Number(period.slice(0, 4)));
    const selectedClient = { ...workspace.client, ...taxProfile.profile };
    if (period !== workspace.client.period) Object.assign(selectedClient, { opening_balance: null, ytd_income_before_period: null, income_data_complete: false });
    return publicClone({ client: selectedClient, files: workspace.files, events: activeEvents(workspace), result: resultView(workspace, latestResult(workspace, periodValue(period))), tax_profile: annualProfile(workspace, Number(period.slice(0, 4))), integrity_issues: workspace.integrity_issues, history: workspace.history, data_revision: workspace.data_revision });
  }
  function journal(workspace, action, detail, reviewer = null, resultId = null) {
    workspace.history.unshift({ id: id(), client_id: workspace.client.id, action, created_at: now(), reviewer, detail, result_id: resultId, actor_username: null });
  }
  function invalidate(workspace) {
    workspace.data_revision++; workspace.client._data_revision = workspace.data_revision;
    for (const result of workspace.results) if (result._demo_revision === workspace.data_revision - 1) {
      journal(workspace, 'result_invalidated', 'Изменились учебные данные или профиль; требуется новый расчёт.', null, result.id);
    }
  }
  function jsonBody(options) {
    let body;
    try { body = typeof options.body === 'string' ? JSON.parse(options.body) : options.body ?? {}; }
    catch { throw new Error('Некорректный формат данных действия.'); }
    if (!plain(body)) throw new Error('Ожидается объект с полями.');
    return body;
  }
  function validateReviewer(reviewer, reason, reasonRequired = false) {
    if (typeof reviewer !== 'string' || !reviewer.trim() || reviewer.length > 150) throw new Error('Укажите имя проверяющего (до 150 символов).');
    if (typeof reason !== 'string' || reason.length > 5000 || (reasonRequired && !reason.trim())) throw new Error(reasonRequired ? 'Для исправления укажите причину (до 5000 символов).' : 'Комментарий должен быть текстом до 5000 символов.');
  }
  async function calculateResult(workspace, body) {
    unknownFields(body, ['period'], 'Неизвестные поля расчёта.');
    const period = periodValue(body.period || workspace.client.period);
    if (!window.AccountingPlusEngine?.calculate) throw new Error('Расчётный модуль ещё не загрузился. Обновите страницу.');
    const taxProfile = annualProfile(workspace, Number(period.slice(0, 4)));
    const profile = { ...workspace.client, ...taxProfile.profile };
    const content = await window.AccountingPlusEngine.calculate(publicClone(activeEvents(workspace)), publicClone(profile), period);
    if (!taxProfile.confirmed) content.issues.push({ code: 'annual_tax_profile_unconfirmed', severity: 'blocking', message: 'Подтвердите налоговые настройки выбранного года до утверждения.' });
    content.issues.push(...clone(workspace.integrity_issues));
    content.tax_profile = taxProfile;
    const fingerprint = stable(resultContent(content));
    const previous = latestResult(workspace, period);
    if (previous && previous._demo_revision === workspace.data_revision && previous._demo_fingerprint === fingerprint) return previous;
    const result = { ...content, context: { profile: clone(profile), tax_profile: clone(taxProfile), source_events: publicClone(activeEvents(workspace)), source_files: clone(workspace.files.filter(file => file.status === 'imported')), source_occurrences: clone(workspace.event_occurrences), rules: clone(taxRules) }, id: id(), client_id: workspace.client.id, period, version: (previous?.version || 0) + 1, status: 'calculated', created_at: now(), reviewer: null, _demo_revision: workspace.data_revision, _demo_fingerprint: fingerprint };
    workspace.results.push(result);
    journal(workspace, 'result_calculated', `Рассчитан учебный период ${period}, версия ${result.version}, правила ${result.rules_version}.`, null, result.id);
    return result;
  }
  function updateProfile(workspace, body) {
    unknownFields(body, [...PROFILE_FIELDS, '_data_revision'], 'Неизвестные поля профиля.');
    if (Object.hasOwn(body, '_data_revision') && (!Number.isSafeInteger(body._data_revision) || body._data_revision < 0 || body._data_revision !== workspace.data_revision)) {
      const error = new Error('Профиль устарел: исходные данные или профиль изменились. Обновите кабинет и повторите правку.'); error.status = 409; throw error;
    }
    const changes = Object.fromEntries(Object.entries(body).filter(([key]) => key !== '_data_revision'));
    const old = Object.fromEntries(PROFILE_FIELDS.map(key => [key, workspace.client[key]]));
    if (TAX_PROFILE_FIELDS.some(key => Object.hasOwn(changes, key) && stable(changes[key]) !== stable(old[key]))) throw new Error('Налоговые настройки меняются в профиле выбранного года. Откройте годовой налоговый профиль.');
    const combined = { ...old, ...changes };
    if (changes.tax_regime && changes.tax_regime !== old.tax_regime && !Object.hasOwn(changes, 'usn_rate')) combined.usn_rate = taxRules.regimes[changes.tax_regime]?.default_rate;
    const periodChanged = combined.period !== old.period;
    if (periodChanged) Object.assign(combined, { opening_balance: null, ytd_income_before_period: null, income_data_complete: false });
    const profile = validateProfile(combined);
    if (stable(old) === stable(profile)) return workspace.client;
    workspace.client = { ...profile, id: workspace.client.id, _data_revision: workspace.data_revision };
    invalidate(workspace);
    journal(workspace, 'profile_updated', `Изменён учебный профиль: ${Object.keys(changes).sort().join(', ')}.${periodChanged ? ' Начальный остаток и доходы до периода сброшены в неизвестные.' : ''}`);
    return workspace.client;
  }
  function updateEvent(workspace, eventId, body) {
    unknownFields(body, ['changes', 'expected_version', 'reviewer', 'reason'], 'Можно исправлять только классификацию, дату признания, связи и примечание; сумму и исходник менять нельзя.');
    validateReviewer(body.reviewer, body.reason, true);
    const event = workspace.events.find(item => item.id === eventId && item.active !== false);
    if (!event) throw new Error('Действующая операция этого учебного клиента не найдена.');
    if (!Number.isSafeInteger(body.expected_version) || body.expected_version < 0) throw new Error('Укажите ожидаемую версию операции.');
    if (body.expected_version !== event.version) { const error = new Error('Операция изменилась после открытия формы. Сравните актуальные данные и повторите правку.'); error.status = 409; error.current = publicClone(eventView(workspace, event)); throw error; }
    unknownFields(body.changes, EVENT_FIELDS, 'Можно исправлять только классификацию, дату признания, связи и примечание; сумму и исходник менять нельзя.');
    const changes = body.changes;
    const before = {};
    const updated = { ...event };
    for (const [key, value] of Object.entries(changes)) {
      before[key] = event[key] ?? null;
      if (key === 'tax_date') updated[key] = dateValue(value, true);
      else if (['settlement_id', 'related_id'].includes(key)) {
        if (value !== null && (typeof value !== 'string' || value.length > 5000)) throw new Error('Идентификаторы связей должны быть строками до 5000 символов.');
        updated[key] = value === null ? null : value.trim() || null;
      } else {
        if (typeof value !== 'string' || value.length > 5000 || (key === 'kind' && !value.trim())) throw new Error('Классификация и примечание должны быть текстом до 5000 символов.');
        updated[key] = value.trim();
      }
    }
    if (stable(event) === stable(updated)) return eventView(workspace, event);
    Object.assign(event, updated); event.version++; invalidate(workspace);
    journal(workspace, 'event_updated', { event_id: eventId, reason: body.reason.trim(), before, after: Object.fromEntries(Object.keys(changes).map(key => [key, event[key]])) }, body.reviewer.trim());
    return eventView(workspace, event);
  }
  function reviewResult(workspace, body) {
    unknownFields(body, ['result_id', 'reviewer', 'comment', 'action'], 'Неизвестные поля проверки.');
    validateReviewer(body.reviewer, body.comment);
    if (!['review', 'approve'].includes(body.action)) throw new Error('Действие должно быть review или approve.');
    const result = workspace.results.find(item => item.id === body.result_id);
    if (!result) throw new Error('Результат этого учебного клиента не найден.');
    if (result._demo_revision !== workspace.data_revision || result.status === 'stale' || latestResult(workspace, result.period)?.id !== result.id) throw new Error('Результат устарел: данные изменились или существует новая версия. Пересчитайте период.');
    if (body.action === 'approve' && (!annualProfile(workspace, Number(result.period.slice(0, 4))).confirmed || workspace.integrity_issues.length || result.issues.some(issue => issue.severity === 'blocking'))) throw new Error('Утверждение запрещено: сначала устраните блокирующие вопросы.');
    if (result.status === 'approved') throw new Error('Результат уже утверждён. Новая проверка требует изменения данных или нового расчёта.');
    result.status = body.action === 'approve' ? 'approved' : 'reviewed'; result.reviewer = body.reviewer.trim();
    journal(workspace, body.action === 'approve' ? 'result_approved' : 'result_reviewed', body.comment.trim(), result.reviewer, result.id);
    return result;
  }
  function currentResult(workspace, period) {
    const result = latestResult(workspace, periodValue(period));
    if (!result || result.status === 'stale' || result._demo_revision !== workspace.data_revision) throw new Error('Сначала выполните актуальный расчёт выбранного периода: прежний результат отсутствует или устарел.');
    return result;
  }
  function assistant(workspace, body) {
    unknownFields(body, ['question', 'period'], 'Неизвестные поля вопроса.');
    if (typeof body.question !== 'string' || !body.question.trim() || body.question.length > 2000) throw new Error('Введите вопрос длиной от 1 до 2000 символов.');
    const result = currentResult(workspace, body.period || workspace.client.period); const metrics = result.metrics;
    const value = key => metrics[key] === null || metrics[key] === undefined ? 'недостаточно данных' : `${metrics[key]} ₽`;
    const text = body.question.toLocaleLowerCase('ru-RU');
    const lines = ['Учебное пояснение по расчёту. Модель ИИ не подключена.'];
    if (['доход', 'налог', 'усн', 'комисс'].some(word => text.includes(word))) {
      if (workspace.client.tax_regime === 'income_expenses') lines.push(`Выбран режим УСН «Доходы минус расходы». Доход: ${value('usn_income')}.`, `Комиссии ${value('commission')} и логистика ${value('logistics')} уменьшают выплату; они учитываются в признанных налоговых расходах после проверки условий и документов бухгалтером.`, 'Налог рассчитывается нарастающим итогом в разделе «Финансы», с собственными взносами в расходах и годовым минимальным налогом. Банковское списание само по себе не подтверждает расход.');
      else lines.push(`Доход для УСН: ${value('usn_income')}. Предварительный налог до уменьшений: ${value('usn_tax_preliminary')}.`, `Комиссии ${value('commission')} и логистика ${value('logistics')} уменьшают ожидаемую выплату, но не базу УСН «Доходы».`, 'Возвраты и даты признания проверяйте по связанным операциям. Итоговый налог после взносов смотрите в разделе «Финансы».');
    }
    else if (['свер', 'расхожд', 'банк', 'выплат'].some(word => text.includes(word))) {
      lines.push(`Выплаты по отчёту: ${value('declared_payouts')}. Связанные поступления банка: ${value('bank_received')}. Разница: ${value('payout_difference')}.`, `Остаток расчётов с маркетплейсом: ${value('closing_balance')}. Сопоставление выполнено по идентификаторам выплат. Совпадение сумм само по себе не доказывает связь.`);
      for (const row of result.reconciliation.slice(0, 15)) lines.push(`${row.settlement_id || 'Без связи'}: ${row.status}, разница ${row.difference} ₽.`);
    } else lines.push(`Доход для УСН: ${value('usn_income')}; предварительный налог: ${value('usn_tax_preliminary')}; разница выплат с банком: ${value('payout_difference')}.`);
    if (workspace.client.tax_regime === 'income_expenses') lines.push('Для выбранного режима «Доходы минус расходы» расчёт налога находится в разделе «Финансы». Месячная сверка не заменяет годовой расчёт.');
    lines.push(`Вопросов для проверки: ${result.issues.length}, блокирующих: ${result.issues.filter(issue => issue.severity === 'blocking').length}.`);
    for (const issue of result.issues.slice(0, 20)) lines.push(`• ${issue.message}`);
    if (result.issues.length > 20) lines.push('Остальные вопросы доступны в разделе проверки.');
    const sources = [...result.income_rows, ...result.issues].flatMap(row => row.sources || []);
    const unique = new Map(sources.map(source => [stable(source), source]));
    return { mode: 'offline', provider: null, answer: lines.join('\n\n'), sources: [...unique.values()].slice(0, 100) };
  }
  function financeYear(value) {
    const year = typeof value === 'string' && /^20\d{2}$/.test(value) ? Number(value) : value;
    if (!Number.isInteger(year) || year < 2000 || year > 2099) throw new Error('Укажите финансовый год в формате YYYY.');
    return year;
  }
  function fiscalModule() {
    if (!window.AccountingPlusFiscal?.defaultLedger || !window.AccountingPlusFiscal?.validateLedger || !window.AccountingPlusFiscal?.calculateFiscalYear || !window.AccountingPlusFinanceData?.prepare) throw new Error('Модуль годовых финансов ещё не загрузился. Обновите страницу.');
    return window.AccountingPlusFiscal;
  }
  function userLedger(ledger) {
    unknownFields(ledger, LEDGER_FIELDS, 'Годовой черновик может содержать только введённые данные. Расчётные показатели изменять нельзя.');
    if (!Array.isArray(ledger.periods) || !Array.isArray(ledger.payments)) throw new Error('В годовом черновике нужны периоды и оплаты.');
    for (const period of ledger.periods) unknownFields(period, LEDGER_PERIOD_FIELDS, 'В периоде черновика можно сохранять только введённые суммы, подтверждения и пояснения.');
    for (const payment of ledger.payments) unknownFields(payment, PAYMENT_FIELDS, 'Неизвестные поля оплаты.');
    const validated = fiscalModule().validateLedger(clone(ledger));
    return { ...Object.fromEntries(LEDGER_FIELDS.filter(key => !['periods', 'payments'].includes(key)).map(key => [key, validated[key]])), periods: validated.periods.map(period => Object.fromEntries(LEDGER_PERIOD_FIELDS.map(key => [key, period[key]]))), payments: validated.payments.map(payment => Object.fromEntries(PAYMENT_FIELDS.map(key => [key, payment[key]]))) };
  }
  function saveTaxProfile(workspace, year, body) {
    year = financeYear(year);
    unknownFields(body, ['revision', 'profile', 'confirmed', 'reviewer', 'reason'], 'Неизвестные поля годового профиля.');
    validateReviewer(body.reviewer, body.reason, true);
    if (!Number.isSafeInteger(body.revision) || body.revision < 0) throw new Error('Укажите версию годового профиля.');
    const current = annualProfile(workspace, year);
    if (body.revision !== current.revision) { const error = new Error('Годовой профиль устарел. Обновите данные и повторите правку.'); error.status = 409; error.current = publicClone(current); throw error; }
    unknownFields(body.profile, TAX_PROFILE_FIELDS, 'Неизвестные поля налогового профиля.');
    if (typeof body.confirmed !== 'boolean') throw new Error('Укажите признак подтверждения налогового профиля.');
    if (!['unknown', 'none', 'present'].includes(body.profile.special_tax_cases ?? 'unknown')) throw new Error('Укажите статус особых налоговых случаев.');
    const profile = profileFields(validateProfile({ ...workspace.client, ...unknownTaxProfile(year), ...body.profile }));
    if (body.confirmed && !profileCanConfirm(profile)) throw new Error('Для подтверждения укажите работников, НДС и доход предыдущего года.');
    const updated = { year, revision: current.revision + 1, confirmed: body.confirmed, profile };
    if (stable(current.profile) === stable(profile) && current.confirmed === body.confirmed) return { ...current, finance_revision: workspace.financial_drafts[String(year)]?.revision || 0, client_revision: workspace.data_revision };
    workspace.tax_profiles[String(year)] = updated;
    if (Number(workspace.client.period.slice(0, 4)) === year) Object.assign(workspace.client, profile);
    invalidate(workspace);
    journal(workspace, 'tax_profile_updated', { year, revision: updated.revision, reason: body.reason.trim(), before: current, after: updated }, body.reviewer.trim());
    if (workspace.financial_drafts[String(year)]) saveFinanceRevision(workspace, year, workspace.financial_drafts[String(year)].ledger, body.reviewer.trim(), `Изменён годовой профиль: ${body.reason.trim()}`);
    return { ...updated, finance_revision: workspace.financial_drafts[String(year)]?.revision || 0, client_revision: workspace.data_revision };
  }
  function saveFinanceRevision(workspace, year, ledger, reviewer, reason) {
    const revision = (workspace.financial_drafts[String(year)]?.revision || 0) + 1;
    workspace.financial_drafts[String(year)] = { revision, ledger: clone(ledger) };
    const finance = financeSnapshot(workspace, year);
    const snapshot = { ...finance, created_at: now(), reviewer, actor_username: null, reason, profile: { ...clone(workspace.client), ...finance.tax_profile.profile, period: `${year}-12`, income_data_complete: finance.tax_profile.confirmed }, source_events: publicClone(activeEvents(workspace)), source_files: clone(workspace.files.filter(file => file.status === 'imported')), source_occurrences: clone(workspace.event_occurrences), rules: clone(taxRules) };
    (workspace.financial_history[String(year)] ??= []).push(snapshot);
    journal(workspace, 'finance_updated', { year, revision, reason }, reviewer);
    return finance;
  }
  function defaultRecords(year) { return { year, revision: 0, enabled: false, entries: [], months: Array.from({ length: 12 }, (_, index) => ({ month: `${year}-${String(index + 1).padStart(2, '0')}`, income_complete: false, management_complete: false, tax_complete: false })) }; }
  function recordsFor(workspace, year) { year = financeYear(year); return clone(workspace.supplementary_records[String(year)] || defaultRecords(year)); }
  function rejectManualTotals(ledger) {
    if (ledger.periods.some(period => ['income_override', 'outside_income', 'management_expenses', 'tax_expenses'].some(key => period[key] !== null))) throw new Error('В режиме реестра итоговые доходы и расходы рассчитываются автоматически. Удалите ручные итоговые суммы перед включением реестра.');
  }
  function validateRecords(body, year) {
    unknownFields(body, ['year', 'revision', 'enabled', 'entries', 'months', 'reviewer', 'reason'], 'Некорректные поля реестра дополнительных операций.');
    if (body.year !== year || !Number.isSafeInteger(body.revision) || body.revision < 0) throw new Error('Укажите год и ревизию реестра.');
    if (typeof body.enabled !== 'boolean') throw new Error('Подтвердите режим реестра.');
    if (!Array.isArray(body.entries) || body.entries.length > 10000) throw new Error('Укажите список дополнительных операций (до 10000).');
    const value = defaultRecords(year); value.enabled = body.enabled; value.revision = body.revision;
    const seen = new Set();
    value.entries = body.entries.map(entry => {
      const fields = ['id', 'kind', 'date', 'amount', 'source', 'note', 'tax_date', 'confirmed'];
      unknownFields(entry, fields, 'Некорректные поля дополнительной операции.');
      if (fields.some(key => !Object.hasOwn(entry, key))) throw new Error('Укажите все поля дополнительной операции.');
      if (typeof entry.id !== 'string' || !entry.id.trim() || entry.id.length > 128 || seen.has(entry.id)) throw new Error('Идентификаторы операций должны быть уникальными строками.');
      seen.add(entry.id);
      if (!['income', 'expense'].includes(entry.kind) || typeof entry.confirmed !== 'boolean') throw new Error('Укажите доход или расход и подтверждение операции.');
      for (const key of ['source', 'note']) if (typeof entry[key] !== 'string' || entry[key].length > 5000 || (key === 'source' && !entry[key].trim())) throw new Error('Укажите текст основания операции (до 5000 символов).');
      const date = dateValue(entry.date), tax_date = dateValue(entry.tax_date, true);
      if (!date.startsWith(`${year}-`) || (tax_date && !tax_date.startsWith(`${year}-`))) throw new Error('Дата операции и налоговая дата должны относиться к выбранному году; межгодовой перенос требует отдельной проверки.');
      if (tax_date && tax_date < date) throw new Error('Налоговая дата раньше операции требует отдельной проверки.');
      if (entry.kind === 'income' && entry.confirmed && !tax_date) throw new Error('Подтверждённому доходу нужна налоговая дата.');
      return { ...entry, date, tax_date, amount: moneyValue(entry.amount), source: entry.source.trim(), note: entry.note.trim() };
    });
    if (!Array.isArray(body.months) || body.months.length !== 12) throw new Error('Нужны подтверждения всех 12 месяцев, включая месяцы без деятельности.');
    const months = new Map();
    for (const month of body.months) {
      unknownFields(month, ['month', 'income_complete', 'management_complete', 'tax_complete'], 'Некорректное подтверждение месяца.');
      if (!value.months.some(item => item.month === month.month) || months.has(month.month)) throw new Error('Месяц не относится к году или повторяется.');
      for (const key of ['income_complete', 'management_complete', 'tax_complete']) if (typeof month[key] !== 'boolean') throw new Error('Подтверждения месяца должны быть true/false.');
      months.set(month.month, clone(month));
    }
    value.months = value.months.map(month => months.get(month.month)); return value;
  }
  function saveRecords(workspace, year, body) {
    year = financeYear(year); const value = validateRecords(body, year); validateReviewer(body.reviewer, body.reason, true);
    const current = recordsFor(workspace, year);
    if (current.revision !== value.revision) { const error = new Error('Реестр уже изменился. Сравните актуальную версию.'); error.status = 409; error.current = publicClone(current); throw error; }
    const draft = workspace.financial_drafts[String(year)];
    if (value.enabled && draft) rejectManualTotals(draft.ledger);
    value.revision++;
    workspace.supplementary_records[String(year)] = value;
    (workspace.record_revisions[String(year)] ??= []).push({ ...clone(value), created_at: now(), reviewer: body.reviewer.trim(), reason: body.reason.trim(), actor_username: null });
    invalidate(workspace); journal(workspace, 'records_updated', { year, revision: value.revision, reason: body.reason.trim() }, body.reviewer.trim());
    if (draft) saveFinanceRevision(workspace, year, draft.ledger, body.reviewer.trim(), `Изменён реестр: ${body.reason.trim()}`);
    return value;
  }
  const exactCents = value => { const text = String(value); const negative = text.startsWith('-'); const [whole, part = ''] = (negative ? text.slice(1) : text).split('.'); return (BigInt(whole) * 100n + BigInt(part.padEnd(2, '0'))) * (negative ? -1n : 1n); };
  const exactMoney = value => { const negative = value < 0n; const abs = negative ? -value : value; return `${negative ? '-' : ''}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`; };
  const entrySum = entries => entries.reduce((sum, entry) => sum + exactCents(entry.amount), 0n);
  function applyRecords(prepared, records) {
    if (!records.enabled) return prepared;
    for (const row of prepared.monthly) {
      const selected = records.entries.filter(entry => entry.confirmed && entry.date.slice(0, 7) === row.month);
      row.outside_revenue = exactMoney(entrySum(selected.filter(entry => entry.kind === 'income')));
      row.additional_expenses = exactMoney(entrySum(selected.filter(entry => entry.kind === 'expense')));
      row.outside_income = exactMoney(entrySum(records.entries.filter(entry => entry.confirmed && entry.kind === 'income' && entry.tax_date?.slice(0, 7) === row.month)));
      const month = records.months[Number(row.month.slice(5)) - 1];
      const relevant = records.entries.filter(entry => entry.date.slice(0, 7) === row.month);
      row.income_complete = month.income_complete && relevant.filter(entry => entry.kind === 'income').every(entry => entry.confirmed && entry.tax_date);
      row.management_complete = month.management_complete && relevant.filter(entry => entry.kind === 'expense').every(entry => entry.confirmed);
      row.tax_complete = month.tax_complete && relevant.filter(entry => entry.kind === 'expense').every(entry => entry.confirmed && entry.tax_date);
    }
    prepared.record_periods = [];
    taxRules.periods.forEach((definition, index) => {
      const cutoff = `${records.year}-${String(definition.months).padStart(2, '0')}-31`;
      const relevant = records.entries.filter(entry => entry.date <= cutoff);
      const recognized = relevant.filter(entry => entry.confirmed && entry.tax_date && entry.tax_date <= cutoff);
      const confirmations = records.months.slice(0, definition.months);
      const incomeComplete = confirmations.every(month => month.income_complete) && relevant.filter(entry => entry.kind === 'income').every(entry => entry.confirmed && entry.tax_date);
      const managementComplete = confirmations.every(month => month.management_complete) && relevant.filter(entry => entry.kind === 'expense').every(entry => entry.confirmed);
      const taxComplete = confirmations.every(month => month.tax_complete) && relevant.filter(entry => entry.kind === 'expense').every(entry => entry.confirmed && entry.tax_date);
      const row = prepared.ledger.periods[index], costs = exactCents(row.marketplace_costs);
      Object.assign(row, { income_override: null, outside_income: incomeComplete ? exactMoney(entrySum(recognized.filter(entry => entry.kind === 'income'))) : null,
        management_expenses: managementComplete ? exactMoney(costs + entrySum(relevant.filter(entry => entry.confirmed && entry.kind === 'expense'))) : null,
        tax_expenses: taxComplete ? exactMoney(costs + entrySum(recognized.filter(entry => entry.kind === 'expense'))) : null,
        income_confirmed: incomeComplete, expenses_confirmed: taxComplete });
      prepared.record_periods.push({ outside_revenue: exactMoney(entrySum(relevant.filter(entry => entry.confirmed && entry.kind === 'income'))), income_complete: incomeComplete, management_complete: managementComplete, management_expenses_known: exactMoney(costs + entrySum(relevant.filter(entry => entry.confirmed && entry.kind === 'expense'))) });
    }); return prepared;
  }
  function applyManagement(result, prepared) {
    if (!prepared.record_periods) return result;
    result.periods.forEach((row, index) => {
      const records = prepared.record_periods[index];
      row.management_expenses = records.management_expenses_known; row.management_expenses_complete = records.management_complete;
      if (!records.management_complete) for (const issue of row.issues || []) if (issue.code === 'management_expenses_incomplete') issue.message = 'Показана известная часть расходов: удержания маркетплейсов и подтверждённые дополнительные расходы. Полнота расходов не подтверждена; полная прибыль пока неизвестна.';
      if (!records.income_complete) { Object.assign(row, { management_revenue: null, profit_before_tax: null, profit_after_tax: null }); return; }
      const revenue = exactCents(prepared.ledger.periods[index].marketplace_revenue) + exactCents(records.outside_revenue);
      const profit = records.management_complete ? revenue - exactCents(row.management_expenses) : null;
      Object.assign(row, { management_revenue: exactMoney(revenue), profit_before_tax: profit === null ? null : exactMoney(profit), profit_after_tax: profit !== null && row.total_tax_and_contributions !== null ? exactMoney(profit - exactCents(row.total_tax_and_contributions)) : null });
    }); return result;
  }
  function applyAssessments(workspace, prepared, records, taxProfile) {
    const bases = {}; const latest = new Map();
    for (const assessment of [...(workspace.assessments[String(records.year)] || [])].reverse()) if (!latest.has(assessment.period)) latest.set(assessment.period, assessment);
    taxRules.periods.forEach((definition, index) => {
      const row = prepared.ledger.periods[index];
      if (index === 0 && records.enabled) Object.assign(row, { prior_advances: '0.00', previous_deduction: '0.00' });
      else if (index) {
        const previous = taxRules.periods[index - 1].period; const assessment = latest.get(previous);
        if (assessment && assessment.calculation_basis === bases[previous]) Object.assign(row, { prior_advances: assessment.result.tax_after_reduction, previous_deduction: assessment.result.contribution_applied });
        else if (assessment || (records.enabled && (row.prior_advances === null || row.previous_deduction === null || !row.income_note.trim()))) {
          Object.assign(row, { prior_advances: null, previous_deduction: null });
          (row.source_issues ??= []).push({ code: assessment ? 'prior_assessment_stale' : 'prior_assessment_missing', severity: 'blocking', message: assessment ? 'Исходные данные прошлого утверждённого периода изменились. Проверьте и утвердите его заново.' : 'Нет утверждённого прошлого периода. При старте посреди года укажите вступительные начисления и основание.' });
        }
      }
      const start = `${records.year}-01-01`, cutoff = `${records.year}-${String(definition.months).padStart(2, '0')}-31`;
      const relevant = item => ['date', 'tax_date'].some(key => item[key] && start <= item[key] && item[key] <= cutoff);
      // Compare full canonical data rather than a short non-cryptographic browser hash.
      bases[definition.period] = stable({ profile: taxProfile.profile, confirmed: taxProfile.confirmed, rules: taxRules,
        policy: Object.fromEntries(Object.entries(prepared.ledger).filter(([key]) => !['periods', 'payments'].includes(key))), period: row,
        payments: prepared.ledger.payments.filter(payment => start <= payment.date && payment.date <= cutoff),
        events: publicClone(activeEvents(workspace).filter(relevant)),
        records: { enabled: records.enabled, entries: records.entries.filter(relevant), months: records.months.slice(0, definition.months) } });
    }); return bases;
  }
  function approveAssessment(workspace, year, body) {
    year = financeYear(year); unknownFields(body, ['period', 'revision', 'client_revision', 'reviewer', 'reason'], 'Некорректные поля утверждения начисления.');
    validateReviewer(body.reviewer, body.reason, true);
    if (!taxRules.periods.some(item => item.period === body.period) || !Number.isSafeInteger(body.revision) || !Number.isSafeInteger(body.client_revision)) throw new Error('Укажите период и ревизии финансового расчёта.');
    const annual = financeSnapshot(workspace, year);
    if (annual.revision !== body.revision || annual.client_revision !== body.client_revision) { const error = new Error('Расчёт изменился. Повторно проверьте данные перед утверждением.'); error.status = 409; throw error; }
    const result = annual.result.periods.find(item => item.period === body.period);
    if (!result.ready) throw new Error('Утверждение запрещено: сначала устраните блокирующие вопросы периода.');
    const snapshot = { id: id(), year, period: body.period, finance_revision: annual.revision, client_revision: annual.client_revision, created_at: now(), reviewer: body.reviewer.trim(), actor_username: null, reason: body.reason.trim(), result: clone(result), calculation_basis: annual.assessment_bases[body.period], context: annual,
      source_events: publicClone(activeEvents(workspace)), source_files: clone(workspace.files.filter(file => file.status === 'imported')), rules: clone(taxRules), profile: { ...clone(workspace.client), ...annual.tax_profile.profile, period: `${year}-12`, income_data_complete: annual.tax_profile.confirmed } };
    (workspace.assessments[String(year)] ??= []).push(snapshot);
    invalidate(workspace); journal(workspace, 'assessment_approved', { year, period: body.period, assessment_id: snapshot.id, reason: snapshot.reason }, snapshot.reviewer);
    return snapshot;
  }
  function financeSnapshot(workspace, year) {
    year = financeYear(year);
    const fiscal = fiscalModule(); const draft = workspace.financial_drafts[String(year)];
    const ledger = draft ? clone(draft.ledger) : userLedger(fiscal.defaultLedger(year));
    const tax_profile = annualProfile(workspace, year);
    const profile = { ...workspace.client, ...tax_profile.profile, period: `${year}-12`, income_data_complete: tax_profile.confirmed };
    const records = recordsFor(workspace, year);
    const prepared = applyRecords(window.AccountingPlusFinanceData.prepare(publicClone({ ...workspace, client: profile }), ledger, taxRules), records);
    if (!tax_profile.confirmed) for (const period of prepared.ledger.periods) (period.source_issues ??= []).push({ code: 'annual_tax_profile_unconfirmed', severity: 'blocking', message: `Подтвердите налоговый профиль ${year} года.`, sources: [] });
    for (const period of prepared.ledger.periods) {
      (period.source_issues ??= []).push(...clone(workspace.integrity_issues));
      if (profile.tax_regime === 'income_expenses' && profile.special_tax_cases !== 'none') period.source_issues.push({ code: 'special_tax_cases_manual', severity: 'blocking', message: 'Для УСН Д−Р подтвердите отсутствие прошлых убытков, переходных и других особых случаев. Такие случаи требуют отдельной проверки.', sources: [] });
    }
    const assessment_bases = applyAssessments(workspace, prepared, records, tax_profile);
    const assessments = [...(workspace.assessments[String(year)] || [])].reverse().map(item => Object.fromEntries(Object.entries(item).filter(([key]) => !['context', 'source_events'].includes(key))));
    const source_totals = prepared.ledger.periods.map(period => Object.fromEntries(['period', 'marketplace_income', 'marketplace_revenue', 'marketplace_costs', 'bank_received', 'bank_debits'].map(key => [key, period[key] ?? null])));
    return { year, revision: draft?.revision || 0, client_revision: workspace.data_revision, tax_profile, profile_confirmed: tax_profile.confirmed, ledger, records, prepared_ledger: prepared.ledger, assessment_bases, assessments, result: applyManagement(fiscal.calculateFiscalYear(publicClone(profile), prepared.ledger, taxRules), prepared), sources: prepared.sources, monthly: prepared.monthly, source_totals };
  }
  function saveFinance(workspace, body) {
    unknownFields(body, ['year', 'revision', 'client_revision', 'ledger', 'reviewer', 'reason'], 'Неизвестные поля сохранения финансов.');
    const year = financeYear(body.year);
    validateReviewer(body.reviewer, body.reason, true);
    if (!Number.isSafeInteger(body.revision) || body.revision < 0 || !Number.isSafeInteger(body.client_revision) || body.client_revision < 0) throw new Error('Для сохранения финансов укажите версии годового черновика и исходных данных.');
    const current = workspace.financial_drafts[String(year)];
    if (body.revision !== (current?.revision || 0) || body.client_revision !== workspace.data_revision) {
      const error = new Error('Финансовый черновик устарел: профиль, исходные данные или годовой черновик изменились. Обновите финансы и повторите правку.'); error.status = 409; throw error;
    }
    const ledger = userLedger(body.ledger);
    if (ledger.year !== year) throw new Error('Год черновика не совпадает с выбранным финансовым годом.');
    if (recordsFor(workspace, year).enabled) rejectManualTotals(ledger);
    return saveFinanceRevision(workspace, year, ledger, body.reviewer.trim(), body.reason.trim());
  }
  function financeDemoData(scenario) {
    const expenseMode = scenario === 'expenses_min';
    if (!['income_5m', 'income_500k', 'expenses_min'].includes(scenario)) throw new Error('Финансовый учебный пример не найден.');
    const fiscal = fiscalModule(); const year = 2026; const ledger = fiscal.defaultLedger(year);
    const quarterly = scenario === 'income_500k' ? [125000, 125000, 125000, 125000] : [1000000, 1000000, 1000000, 2000000];
    const profile = { name: scenario === 'income_500k' ? 'Учебный год · Доходы 500 тыс. ₽' : expenseMode ? 'Учебный год · Д−Р и минимальный налог' : 'Учебный год · Доходы 5 млн ₽', inn: '', marketplace: 'wb', region: 'Учебный регион', tax_regime: expenseMode ? 'income_expenses' : 'income', has_employees: false, usn_rate: taxRules.regimes[expenseMode ? 'income_expenses' : 'income'].default_rate, vat_status: 'exempt', vat_effective_from: `${year}-01-01`, prior_year_income: '0.00', special_tax_cases: 'none', ytd_income_before_period: `${quarterly.slice(0, 3).reduce((sum, amount) => sum + amount, 0)}.00`, income_data_complete: true, opening_balance: '0.00', period: `${year}-12` };
    Object.assign(ledger, { policy: 'accrued', policy_confirmed: true, additional_recognition: 'current', full_year_activity: true, prior_additional_amount: '0.00', prior_additional_used: '0.00', prior_additional_confirmed: true });
    const priorAdvances = scenario === 'income_500k' ? ['0.00', '0.00', '0.00', '0.00'] : expenseMode ? ['0.00', '0.00', '3391.50', '9391.50'] : ['0.00', '0.00', '45610.00', '95610.00'];
    const previousDeductions = scenario === 'income_500k' ? ['0.00', '7500.00', '15000.00', '22500.00'] : expenseMode ? ['0.00', '57390.00', '57390.00', '57390.00'] : ['0.00', '60000.00', '74390.00', '84390.00'];
    let accumulated = 0; const marketplace = [], bank = [];
    quarterly.forEach((amount, index) => {
      accumulated += amount; const month = String((index + 1) * 3).padStart(2, '0'); const settlement = `FIN-${index + 1}`;
      marketplace.push({ external_id: `FIN-S-${index + 1}`, kind: 'sale', date: `${year}-${month}-15`, tax_date: `${year}-${month}-15`, amount: `${amount}.00`, settlement_id: settlement, note: 'Вымышленная продажа для годового учебного расчёта' },
        { external_id: `FIN-C-${index + 1}`, kind: 'commission', date: `${year}-${month}-20`, amount: `${amount / 10}.00`, settlement_id: settlement, note: 'Вымышленная комиссия' },
        { external_id: `FIN-L-${index + 1}`, kind: 'logistics', date: `${year}-${month}-20`, amount: `${amount / 20}.00`, settlement_id: settlement, note: 'Вымышленная логистика' },
        { external_id: `FIN-P-${index + 1}`, kind: 'payout', date: `${year}-${month}-25`, amount: `${amount * 85 / 100}.00`, settlement_id: settlement, note: 'Вымышленная выплата' });
      bank.push({ external_id: `FIN-B-${index + 1}`, kind: 'bank_credit', date: `${year}-${month}-26`, amount: `${amount * 85 / 100}.00`, settlement_id: settlement, note: 'Вымышленное поступление банка' },
        { external_id: `FIN-D-${index + 1}`, kind: 'bank_debit', date: `${year}-${month}-27`, amount: `${amount * (expenseMode ? 81 : 50) / 100}.00`, note: 'Вымышленный платёж поставщику; сам по себе не подтверждает налоговый расход' });
      Object.assign(ledger.periods[index], { income_override: null, outside_income: '0.00', tax_expenses: `${expenseMode ? accumulated * 96 / 100 : 0}.00`, management_expenses: `${accumulated * (expenseMode ? 96 : 65) / 100}.00`, prior_advances: priorAdvances[index], previous_deduction: previousDeductions[index], income_confirmed: true, expenses_confirmed: true, income_note: 'Доход подтверждён только для вымышленного учебного примера.', expense_note: 'Вымышленные расходы подтверждены для обучения; собственные взносы сюда не включены.' });
    });
    ledger.payments.push({ id: `finance-${scenario}-fixed`, kind: 'fixed', amount: taxRules.years[String(year)].fixed_contribution, date: `${year}-12-28`, liability_year: year, confirmed: true, source: 'Вымышленный учебный платёж взносов', note: 'Только синтетический пример' });
    if (scenario !== 'income_500k') {
      ledger.payments.push({ id: `finance-${scenario}-usn-h1`, kind: 'usn', amount: expenseMode ? '3391.50' : '45610.00', date: `${year}-06-28`, liability_year: year, confirmed: true, source: 'Вымышленный учебный платёж УСН', note: 'Пример подтверждённой оплаты, отдельно от начисленных авансов' },
        { id: `finance-${scenario}-usn-m9`, kind: 'usn', amount: expenseMode ? '6000.00' : '50000.00', date: `${year}-09-28`, liability_year: year, confirmed: true, source: 'Вымышленный учебный платёж УСН', note: 'Пример подтверждённой оплаты, отдельно от начисленных авансов' });
    }
    return { profile, ledger: userLedger(ledger), marketplace, bank };
  }
  async function createFinanceDemo(db, scenario) {
    const existing = db.workspaces.find(workspace => workspace._demo_finance_scenario === scenario);
    if (existing) return { client: existing.client, reused: true };
    if (db.workspaces.length >= 100) throw new Error('В учебной версии допускается максимум 100 клиентов.');
    const data = financeDemoData(scenario);
    const workspace = { client: { ...validateProfile(data.profile), id: id(), _data_revision: 0 }, data_revision: 0, files: [], events: [], history: [], results: [], financial_drafts: {}, _demo_finance_scenario: scenario };
    initializeNewWorkspace(workspace);
    db.workspaces.push(workspace); journal(workspace, 'client_created', 'Создан отдельный вымышленный финансовый пример. Рабочая политика других клиентов не изменена.');
    for (const source of ['marketplace', 'bank']) {
      const rows = source === 'marketplace' ? data.marketplace : data.bank;
      const text = csv([HEADERS, ...rows.map(row => HEADERS.map(key => row[key] || ''))]);
      const form = new FormData(); form.set('source', source); form.set('file', new Blob([text], { type: 'text/csv' }), `${scenario}-${source}.csv`);
      const imported = await importFile(db, workspace, form);
      if (imported._demo_import_error) throw new Error(imported._demo_import_error);
    }
    saveFinanceRevision(workspace, 2026, data.ledger, 'Учебный пример', 'Синтетические подтверждения и начисленные авансы для учебного примера.');
    await calculateResult(workspace, { period: workspace.client.period });
    return { client: workspace.client, reused: false };
  }
  function csvRows(text) {
    if (text.includes('\0')) throw new Error('CSV содержит недопустимые нулевые байты.');
    text = text.replace(/^\uFEFF/, '');
    const firstLine = text.split(/\r?\n/, 1)[0];
    const separator = (firstLine.match(/;/g)?.length || 0) > (firstLine.match(/,/g)?.length || 0) ? ';' : ',';
    const rows = []; let cells = [], cell = '', quoted = false, closedQuote = false, line = 1;
    const pushCell = () => { cells.push(cell); cell = ''; closedQuote = false; };
    const pushRow = () => { pushCell(); rows.push({ line, cells }); cells = []; };
    for (let index = 0; index < text.length; index++) {
      const char = text[index];
      if (quoted) {
        if (char === '"') {
          if (text[index + 1] === '"') { cell += '"'; index++; }
          else { quoted = false; closedQuote = true; }
        } else { cell += char; if (char === '\n') line++; }
      } else if (char === separator) pushCell();
      else if (char === '\n' || char === '\r') {
        pushRow(); if (char === '\r' && text[index + 1] === '\n') index++; line++;
      } else if (char === '"') {
        if (cell || closedQuote) throw new Error(`CSV: ошибка кавычек около строки ${line}.`);
        quoted = true;
      } else {
        if (closedQuote) throw new Error(`CSV: недопустимый текст после кавычек около строки ${line}.`);
        cell += char;
      }
      if (cell.length > 5000 || cells.length > 64 || rows.length > 2001) throw new Error('Учебный CSV превышает предел: 2000 операций, 64 колонки, 5000 символов в ячейке.');
    }
    if (quoted) throw new Error(`CSV: незакрытые кавычки около строки ${line}.`);
    if (cell || cells.length || closedQuote) pushRow();
    return rows;
  }
  function parseCsv(text, source) {
    const rows = csvRows(text); let headers = null; const events = [];
    const cellText = value => String(value ?? '').trim();
    for (const row of rows) {
      if (!row.cells.some(value => cellText(value))) continue;
      if (!headers) {
        headers = row.cells.map(cellText); while (headers.at(-1) === '') headers.pop();
        if (!headers.length || headers.some(value => !value) || new Set(headers).size !== headers.length) throw new Error('Заголовки колонок должны быть непустыми и не повторяться.');
        const missing = ['external_id', 'kind', 'date', 'amount'].filter(key => !headers.includes(key));
        if (missing.length) throw new Error(`Отсутствуют обязательные колонки: ${missing.join(', ')}.`);
        continue;
      }
      if (events.length >= 2000) throw new Error('В учебной версии допускается максимум 2000 операций в CSV.');
      if (row.cells.slice(headers.length).some(value => cellText(value))) throw new Error(`Строка ${row.line}: количество значений превышает количество колонок.`);
      const values = Object.fromEntries(headers.map((key, index) => [key, cellText(row.cells[index])]));
      try {
        if (!values.kind) throw new Error('Тип операции kind отсутствует.');
        if (values.currency && values.currency.toUpperCase() !== 'RUB') throw new Error('Поддерживаются только суммы в RUB.');
        const vatRate = moneyValue(values.vat_rate, true);
        if (vatRate !== null && Number(vatRate) > 100) throw new Error('Ставка НДС должна быть в пределах 0–100%.');
        events.push({ line: row.line, source, external_id: values.external_id, kind: values.kind, original_kind: values.kind, date: dateValue(values.date), tax_date: dateValue(values.tax_date, true), amount: moneyValue(values.amount), settlement_id: values.settlement_id || null, related_id: values.related_id || null, note: values.note || '', vat_rate: vatRate, vat_amount: moneyValue(values.vat_amount, true), extra_fields: Object.fromEntries(Object.entries(values).filter(([key]) => !HEADERS.includes(key))) });
      } catch (error) { throw new Error(`Строка ${row.line}: ${error.message}`); }
    }
    if (!events.length) throw new Error('Файл не содержит операций.');
    return events;
  }
  function bytesBase64(bytes) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let out = '';
    for (let i = 0; i < bytes.length; i += 3) {
      const n = (bytes[i] << 16) | ((bytes[i+1] || 0) << 8) | (bytes[i+2] || 0);
      out += alphabet[(n >>> 18) & 63] + alphabet[(n >>> 12) & 63] + (i+1 < bytes.length ? alphabet[(n >>> 6) & 63] : '=') + (i+2 < bytes.length ? alphabet[n & 63] : '=');
    }
    return out;
  }
  function base64Bytes(text) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const result = [];
    for (let i=0; i<text.length; i+=4) {
      const n = (alphabet.indexOf(text[i]) << 18) | (alphabet.indexOf(text[i+1]) << 12) | (Math.max(0,alphabet.indexOf(text[i+2])) << 6) | Math.max(0,alphabet.indexOf(text[i+3]));
      result.push((n >>> 16) & 255); if (text[i+2] !== '=') result.push((n >>> 8) & 255); if (text[i+3] !== '=') result.push(n & 255);
    }
    return new Uint8Array(result);
  }
  async function readUpload(form) {
    if (!(form instanceof FormData)) throw new Error('Для загрузки выберите файл.');
    const source = form.get('source') || 'auto', file = form.get('file'), accountId = form.get('account_id') || null;
    if (!['auto', 'marketplace', 'bank'].includes(source)) throw new Error('Выберите источник документа.');
    if (!file || typeof file.arrayBuffer !== 'function' || !file.size) throw new Error('Файл пуст или не выбран.');
    if (file.size > 1024 * 1024) throw new Error('В учебной версии файл должен быть не больше 1 МБ.');
    const filename = file.name.replaceAll('\\', '/').split('/').at(-1).replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 250) || 'file';
    return { source, accountId, filename, bytes: new Uint8Array(await file.arrayBuffer()) };
  }
  function proposeUpload(upload) {
    const detected = window.documentAdapters?.preview(upload.bytes, upload.filename, upload.source, upload.accountId);
    if (detected) return detected;
    if (!upload.filename.toLowerCase().endsWith('.csv')) throw new Error('Поддержаны WB JSON v1, банковский 1С TXT и внутренний CSV. XLSX доступен в серверной версии.');
    if (upload.source === 'auto') throw new Error('Внутренний CSV: выберите источник marketplace или bank.');
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(upload.bytes); }
    catch { throw new Error('CSV должен быть в кодировке UTF-8. Пересохраните файл.'); }
    const events = parseCsv(text, upload.source), dates = events.map(event => event.date).sort();
    return { source: upload.source, adapter: 'accountingplus-v1', adapter_version: '1', account_id: null,
      periods: [...new Set(dates.map(date => date.slice(0, 7)))], period_start: dates[0], period_end: dates.at(-1), events,
      warnings: ['Внутренний формат accountingplus-v1; источник указан пользователем.'] };
  }
  async function previewFile(form) {
    return proposeUpload(await readUpload(form));
  }
  function checkNativeSourceRows(workspace, incoming, replaces) {
    const known = new Map();
    const check = event => {
      const original = event?.provenance?.original;
      if (event?.adapter !== 'wb-sales-report-v1' || original?.rrdId === undefined) return;
      const key = stable([event.adapter, event.account_id, String(original.rrdId)]), content = stable(original);
      if (known.has(key) && known.get(key) !== content) throw new Error(`WB: исходная строка rrdId ${original.rrdId} противоречит другому действующему документу этого кабинета. Проверьте и явно замените противоречащий источник.`);
      known.set(key, content);
    };
    const importedFiles = new Set(workspace.files.filter(file => file.status === 'imported' && file.id !== replaces).map(file => file.id));
    const eventById = new Map(workspace.events.map(event => [event.id, event]));
    for (const occurrence of workspace.event_occurrences) if (importedFiles.has(occurrence.file_id)) check(occurrence.original?.provenance?.original ? occurrence.original : eventById.get(occurrence.event_id));
    for (const event of incoming) check(event);
  }
  async function importFile(db, workspace, form) {
    const upload = await readUpload(form), { bytes, filename } = upload;
    const replaces = form.get('replaces_file_id') || null;
    const replaced = replaces ? workspace.files.find(item => item.id === replaces) : null;
    if (replaces && (!replaced || replaced.status !== 'imported')) throw new Error('Заменить можно только действующий файл этого клиента.');
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
    const original = { filename, base64: bytesBase64(bytes) };
    const fileId = id(); const metadata = { id: fileId, client_id: workspace.client.id, filename, source: upload.source, sha256: digest, status: 'imported', created_at: now(), row_count: 0, error: null, replaces_file_id: replaces };
    try {
      const proposal = proposeUpload(upload), { source, events: incoming, ...details } = proposal;
      Object.assign(metadata, details, { source, row_count: incoming.length });
      if (replaced && (replaced.source !== source || (replaced.account_id || null) !== proposal.account_id)) throw new Error('Заменяемый файл должен относиться к тому же источнику и счёту/кабинету.');
      const duplicate = workspace.files.find(item => item.source === source && (item.account_id || null) === proposal.account_id && item.sha256 === digest && item.status === 'imported');
      if (duplicate && (!replaces || duplicate.id === replaces) && !workspace.integrity_issues.some(issue => issue.file_id === replaces)) return { file: duplicate, duplicate: true, imported_count: 0 };
      checkNativeSourceRows(workspace, incoming, replaces);
      const surviving = new Set(workspace.event_occurrences.filter(item => item.file_id !== replaces && workspace.files.some(file => file.id === item.file_id && file.status === 'imported')).map(item => item.event_id));
      const seen = new Map(workspace.events.filter(event => surviving.has(event.id) && event.source === source && event.external_id).map(event => [event.external_id, event]));
      const replaceable = new Map(workspace.events.filter(event => event.active !== false && event.source === source && event.external_id && !surviving.has(event.id) && workspace.event_occurrences.some(item => item.event_id === event.id && item.file_id === replaces)).map(event => [event.external_id, event]));
      const additions = [], occurrences = [];
      for (const incomingEvent of incoming) {
        const comparable = originalContent(incomingEvent);
        let event = incomingEvent.external_id ? seen.get(incomingEvent.external_id) : null;
        if (event && stable(comparable) !== stable(event._demo_original || originalContent(event))) throw new Error(`Строка ${incomingEvent.line}: идентификатор ${incomingEvent.external_id} уже существует с другими данными в действующем источнике. Проверьте противоречащие документы.`);
        if (!event && incomingEvent.external_id) {
          const previous = replaceable.get(incomingEvent.external_id);
          if (previous && stable(previous._demo_original || originalContent(previous)) === stable(comparable)) { event = previous; seen.set(event.external_id, event); }
        }
        if (!event) {
          event = { ...incomingEvent, id: id(), client_id: workspace.client.id, file_id: fileId, active: true, version: 0, _demo_original: comparable };
          additions.push(event);
          if (event.external_id) seen.set(event.external_id, event);
        }
        occurrences.push({ event_id: event.id, file_id: fileId, line: incomingEvent.line, original: clone(incomingEvent) });
      }
      if (replaced) replaced.status = 'replaced';
      workspace.events.push(...additions); workspace.files.unshift(metadata); workspace.event_occurrences.push(...occurrences); db.originals[fileId] = original;
      if (replaced) workspace.integrity_issues = workspace.integrity_issues.filter(issue => issue.file_id !== replaces);
      syncOccurrences(workspace);
      invalidate(workspace);
      journal(workspace, replaced ? 'file_replaced' : 'file_imported', `Документ ${filename}: строк ${incoming.length}, новых операций ${additions.length}.${replaced ? ` Заменён файл ${replaces}.` : ''}`);
      return { file: metadata, duplicate: false, imported_count: additions.length };
    } catch (error) {
      metadata.status = 'failed'; metadata.error = error.message; workspace.files.unshift(metadata); db.originals[fileId] = original;
      journal(workspace, 'import_failed', `Файл ${filename}: ${error.message}`);
      return { _demo_import_error: error.message };
    }
  }
  async function route(db, path, options) {
    if (typeof path !== 'string' || !path.startsWith('/api/') || path.includes('..')) throw new Error('Неизвестный адрес действия учебной версии.');
    const url = new URL(path, 'https://browser-demo.invalid'); const method = (options.method || 'GET').toUpperCase();
    if (url.pathname === '/api/auth/me' && method === 'GET') return { auth_required: false, user: null, csrf_token: null };
    if (url.pathname === '/api/status' && method === 'GET') return { mode: 'browser_demo', ai: { enabled: false, provider: null }, format: 'accountingplus-v1', rules_version: '2026.1' };
    if (url.pathname === '/api/tax-rules' && method === 'GET') return taxRules;
    if (url.pathname === '/api/finance/demo' && method === 'POST') {
      const body = jsonBody(options); unknownFields(body, ['scenario'], 'Неизвестные поля финансового учебного примера.');
      return createFinanceDemo(db, body.scenario);
    }
    if (url.pathname === '/api/demo-scenarios' && method === 'GET') return fixtures.scenarios;
    if (url.pathname === '/api/demo' && method === 'POST') {
      const body = jsonBody(options); unknownFields(body, ['scenario'], 'Неизвестные поля учебного примера.');
      const scenario = fixtures.scenarios.find(item => item.id === body.scenario);
      if (!scenario) throw new Error('Учебный пример не найден.');
      const original = baseline.workspaces.find(item => item.client.name === scenario.title);
      const existing = db.workspaces.find(item => item.client.id === original?.client.id);
      if (!existing) throw new Error('Этот учебный пример отсутствует в сохранённых данных. Сбросьте учебные правки, чтобы восстановить примеры.');
      return { client: existing.client, reused: true };
    }
    if (url.pathname === '/api/clients') {
      if (method === 'GET') return db.workspaces.map(workspace => workspace.client);
      if (method === 'POST') {
        const body = jsonBody(options); unknownFields(body, PROFILE_FIELDS, 'Неизвестные поля профиля.');
        if (db.workspaces.length >= 100) throw new Error('В учебной версии допускается максимум 100 клиентов.');
        const profile = validateProfile({ name: '', inn: '', marketplace: 'wb', region: '', usn_rate: null, vat_status: 'unknown', vat_effective_from: '2026-01-01', prior_year_income: null, ytd_income_before_period: null, income_data_complete: false, opening_balance: null, period: '2026-09', tax_regime: 'income', has_employees: null, ...body });
        const workspace = { client: { ...profile, id: id(), _data_revision: 0 }, data_revision: 0, files: [], events: [], history: [], results: [], financial_drafts: {} };
        initializeNewWorkspace(workspace);
        journal(workspace, 'client_created', 'Создан учебный профиль клиента в этом браузере.'); db.workspaces.push(workspace); return workspace.client;
      }
    }
    const match = url.pathname.match(/^\/api\/clients\/([^/]+)(?:\/(.*))?$/);
    if (!match) throw new Error('Это действие недоступно в учебной версии.');
    const workspace = workspaceById(db, decodeURIComponent(match[1])); const suffix = match[2] || '';
    if (method === 'GET' && !suffix) return workspace.client;
    if (method === 'PATCH' && !suffix) return updateProfile(workspace, jsonBody(options));
    const resultMatch = suffix.match(/^results\/([^/]+)$/);
    if (method === 'GET' && resultMatch) {
      const result = workspace.results.find(item => item.id === decodeURIComponent(resultMatch[1]));
      if (!result) throw new Error('Сохранённая версия расчёта этого клиента не найдена.');
      return { ...result, snapshot_status: result.status, is_stale: result._demo_revision !== workspace.data_revision };
    }
    if (method === 'GET' && suffix === 'workspace') return snapshot(workspace, url.searchParams.get('period') || workspace.client.period);
    const taxMatch = suffix.match(/^tax-profiles\/(20\d{2})$/);
    if (method === 'GET' && taxMatch) return annualProfile(workspace, taxMatch[1]);
    if (method === 'PUT' && taxMatch) return saveTaxProfile(workspace, taxMatch[1], jsonBody(options));
    const financeHistoryMatch = suffix.match(/^finance\/(20\d{2})\/history$/);
    if (method === 'GET' && financeHistoryMatch) return [...(workspace.financial_history[financeHistoryMatch[1]] || [])].reverse();
    const recordsMatch = suffix.match(/^records\/(20\d{2})(?:\/(history))?$/);
    if (method === 'GET' && recordsMatch) return recordsMatch[2] ? [...(workspace.record_revisions[recordsMatch[1]] || [])].reverse() : recordsFor(workspace, recordsMatch[1]);
    if (method === 'PUT' && recordsMatch && !recordsMatch[2]) return saveRecords(workspace, recordsMatch[1], jsonBody(options));
    const assessmentsMatch = suffix.match(/^finance\/(20\d{2})\/assessments$/);
    if (method === 'GET' && assessmentsMatch) return [...(workspace.assessments[assessmentsMatch[1]] || [])].reverse();
    if (method === 'POST' && assessmentsMatch) return approveAssessment(workspace, assessmentsMatch[1], jsonBody(options));
    if (method === 'GET' && suffix === 'finance') return financeSnapshot(workspace, url.searchParams.get('year') || workspace.client.period.slice(0, 4));
    if (method === 'PUT' && suffix === 'finance') return saveFinance(workspace, jsonBody(options));
    if (method === 'POST' && suffix === 'calculate') return calculateResult(workspace, jsonBody(options));
    if (method === 'POST' && suffix === 'review') return reviewResult(workspace, jsonBody(options));
    if (method === 'POST' && suffix === 'assistant') return assistant(workspace, jsonBody(options));
    if (method === 'POST' && suffix === 'files/preview') return previewFile(options.body);
    if (method === 'POST' && suffix === 'files') return importFile(db, workspace, options.body);
    const eventMatch = suffix.match(/^events\/([^/]+)$/);
    if (method === 'PATCH' && eventMatch) return updateEvent(workspace, decodeURIComponent(eventMatch[1]), jsonBody(options));
    throw new Error('Это действие недоступно в учебной версии.');
  }
  async function request(path, options = {}) {
    await ready;
    const method = (options.method || 'GET').toUpperCase();
    const isMutation = !['GET', 'HEAD'].includes(method) && !path.endsWith('/assistant') && !path.endsWith('/files/preview');
    if (!isMutation) { synchronize(); return publicClone(await route(database, path, options)); }
    const operation = queue.then(() => exclusiveStorage(async () => {
      synchronize(); const expected = persistedText; const candidate = clone(database);
      const result = await route(candidate, path, options);
      if (stable(candidate) !== stable(database)) commit(candidate, expected);
      if (result?._demo_import_error) throw new Error(result._demo_import_error);
      return publicClone(result);
    }));
    queue = operation.catch(() => {});
    return operation;
  }
  function cachedBlob(key, text, type = 'text/csv;charset=utf-8') {
    if (!blobUrls.has(key)) blobUrls.set(key, URL.createObjectURL(new Blob([text], { type })));
    return blobUrls.get(key);
  }
  function fileUrl(clientId, fileId) {
    if (!database) throw new Error('Учебные данные ещё загружаются.');
    const workspace = workspaceById(database, clientId);
    if (!workspace.files.some(file => file.id === fileId) || !Object.hasOwn(database.originals, fileId)) throw new Error('Исходный документ этого учебного клиента не найден.');
    const original = database.originals[fileId];
    return original.base64 ? cachedBlob(`file:${fileId}`, base64Bytes(original.base64), 'application/octet-stream') : cachedBlob(`file:${fileId}`, original.text);
  }
  function safeCell(value) {
    let text = String(value ?? '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\ud800-\udfff\ufffe\uffff]/g, '�');
    if (/^[\s]*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text)) text = `'${text}`;
    if (text.length > 32767) text = `${text.slice(0, 32740)} … [текст сокращён]`;
    return text;
  }
  const csvCell = value => `"${safeCell(value).replaceAll('"', '""')}"`;
  const csv = rows => '\uFEFF' + rows.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
  const sourceLabel = sources => (sources || []).map(source => `файл ${source.file_id || '?'}, строка ${source.line || '?'}, ${source.external_id || ''}`).join('; ');
  function templateUrl(source, format = 'csv') {
    if (!['marketplace', 'bank'].includes(source)) throw new Error('Некорректный источник шаблона.');
    if (format !== 'csv') throw new Error('В учебной версии доступен шаблон CSV.');
    const rows = [HEADERS, source === 'bank' ? ['B-001', 'bank_credit', '2026-09-25', '85000.00', '', 'PAY-SEP-01', '', 'Вымышленное поступление', '', ''] : ['S-001', 'sale', '2026-09-10', '100000.00', '2026-09-10', 'PAY-SEP-01', '', 'Вымышленная продажа', '', '']];
    return cachedBlob(`template:${source}`, csv(rows));
  }
  async function exportBlob(clientId, period, format = 'csv') {
    await ready; synchronize();
    const workspace = workspaceById(database, clientId); const result = currentResult(workspace, period);
    if (format === 'csv') {
      const rows = [['Учебные данные — правки только в этом браузере', 'Период', 'Версия', 'Статус', 'Предварительный расчёт до уменьшений', 'Дата дохода', 'Сумма', 'Операция', 'Источники']];
      for (const row of result.income_rows) rows.push(['Учебный черновик', result.period, result.version, result.status, 'да', row.tax_date, row.amount, row.event_id, sourceLabel(row.sources)]);
      return new Blob([csv(rows)], { type: 'text/csv;charset=utf-8' });
    }
    if (format !== 'report') throw new Error('В учебной версии доступны CSV и текстовый отчёт. XLSX доступен в серверной версии.');
    const lines = ['# accountingPLUS — учебный черновик проверки', '', 'Вымышленные данные. Исправления и имена проверяющих сохранены только в этом браузере; это не подтверждение личности.', '', `Клиент: ${workspace.client.name}`, `Период: ${result.period}`, `Версия: ${result.version}; правила: ${result.rules_version}`, `Статус: ${result.status}; проверивший: ${result.reviewer || 'не указан'}`, '', 'Предварительный расчёт по загруженным данным, до уменьшений налога. Не является декларацией, суммой к уплате или готовым импортом в 1С.', '', '## Расчёты', ''];
    for (const [key, value] of Object.entries(result.metrics)) lines.push(`- ${LABELS[key] || key}: ${value === null ? 'недостаточно данных' : `${value} ₽`}`);
    lines.push('', '## Вопросы', '');
    for (const issue of result.issues) { lines.push(`- [${issue.severity}] ${issue.message}`); if (issue.sources?.length) lines.push(`  Источники: ${sourceLabel(issue.sources)}`); }
    if (!result.issues.length) lines.push('Нет вопросов в пределах выполненных проверок.');
    lines.push('', '## Сверка', '');
    for (const row of result.reconciliation) lines.push(`- ${row.settlement_id || 'без связи'}: выплата ${row.expected}, банк ${row.received}, разница ${row.difference}, статус ${row.status}.`);
    lines.push('', '## Источники дохода', '');
    for (const row of result.income_rows) lines.push(`- ${row.tax_date || 'дата не подтверждена'}: ${row.amount} ₽; ${sourceLabel(row.sources)}`);
    lines.push('', '## История проверки', '');
    for (const row of workspace.history) if (row.result_id === result.id) lines.push(`- ${row.created_at}: ${row.action}; ${row.reviewer || ''}; ${typeof row.detail === 'string' ? row.detail : JSON.stringify(row.detail)}`);
    return new Blob([lines.join('\n') + '\n'], { type: 'text/markdown;charset=utf-8' });
  }
  async function reset() {
    await fixtureReady;
    const operation = queue.then(() => exclusiveStorage(() => {
      // A user-requested reset also recovers corrupt data, under the same lock.
      try { synchronize(); } catch (error) { if (error.code !== 'DEMO_STORAGE_CORRUPT') throw error; }
      const expected = storageRead(); commit(clone(baseline), expected);
      for (const value of blobUrls.values()) URL.revokeObjectURL(value); blobUrls.clear();
      ready = Promise.resolve(); return publicClone(database.workspaces.map(workspace => workspace.client));
    }));
    queue = operation.catch(() => {}); return operation;
  }
  window.AccountingPlusDemo = { get ready() { return ready; }, request, fileUrl, templateUrl, exportBlob, reset };
})();
