/* Educational browser storage adapter. It never sends accounting data to a server. */
(() => {
  'use strict';
  const fixtureUrl = new URL('./fixtures.json', document.currentScript.src);
  const STORAGE_KEY = 'accountingplus-demo-v1';
  const PROFILE_FIELDS = ['name', 'inn', 'marketplace', 'region', 'usn_rate', 'vat_status', 'vat_effective_from', 'prior_year_income', 'ytd_income_before_period', 'income_data_complete', 'opening_balance', 'period'];
  const EVENT_FIELDS = ['kind', 'tax_date', 'settlement_id', 'related_id', 'note'];
  const HEADERS = ['external_id', 'kind', 'date', 'amount', 'tax_date', 'settlement_id', 'related_id', 'note', 'vat_rate', 'vat_amount'];
  const RESULT_METADATA = new Set(['id', 'client_id', 'period', 'version', 'status', 'created_at', 'reviewer', '_demo_revision', '_demo_fingerprint']);
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
    p.usn_rate = moneyValue(p.usn_rate);
    if (Number(p.usn_rate) > 6) throw new Error('Поддерживается УСН «Доходы» со ставкой 0–6%.');
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
    return Object.fromEntries(Object.entries(result).filter(([key]) => !RESULT_METADATA.has(key) && key !== '_data_revision'));
  }
  function originalContent(event) {
    const fields = ['source', 'external_id', 'kind', 'original_kind', 'date', 'tax_date', 'amount', 'settlement_id', 'related_id', 'note', 'vat_rate', 'vat_amount', 'extra_fields'];
    return Object.fromEntries(fields.map(key => [key, event[key] ?? (key === 'extra_fields' ? {} : ['note', 'external_id'].includes(key) ? '' : null)]));
  }
  function makeBaseline(fixtures) {
    if (fixtures?.schema !== 1 || !Array.isArray(fixtures.workspaces) || !Array.isArray(fixtures.scenarios) || !plain(fixtures.originals)) throw new Error('Учебный набор имеет неподдерживаемый формат.');
    const db = { schema: 1, workspaces: clone(fixtures.workspaces), originals: clone(fixtures.originals) };
    for (const workspace of db.workspaces) {
      workspace.data_revision ??= workspace.client?._data_revision ?? 0;
      workspace.client._data_revision = workspace.data_revision;
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
      validateProfile(workspace.client);
      for (const key of ['files', 'events', 'history', 'results']) if (!Array.isArray(workspace[key])) throw new Error('Некорректные списки рабочего места.');
      if (workspace.events.length > 10000 || workspace.files.length > 1000 || workspace.history.length > 20000 || workspace.results.length > 1000) throw new Error('Слишком большой учебный набор.');
      if (workspace.files.some(file => !plain(file) || typeof file.id !== 'string' || file.client_id !== workspace.client.id)) throw new Error('Некорректные документы клиента.');
      if (workspace.events.some(event => !plain(event) || typeof event.id !== 'string' || event.client_id !== workspace.client.id || !workspace.files.some(file => file.id === event.file_id))) throw new Error('Некорректные операции клиента.');
      if (workspace.results.some(result => !plain(result) || typeof result.id !== 'string' || result.client_id !== workspace.client.id || !plain(result.metrics) || !Array.isArray(result.issues) || !Array.isArray(result.income_rows) || !Array.isArray(result.reconciliation))) throw new Error('Некорректный сохранённый расчёт.');
    }
    return value;
  }
  let fixtures, baseline, database, persistedText;
  let queue = Promise.resolve();
  const blobUrls = new Map();
  const fixtureReady = (async () => {
    let response;
    try { response = await fetch(fixtureUrl); }
    catch { throw new Error('Не удалось загрузить учебные примеры. Проверьте интернет и обновите страницу.'); }
    if (!response.ok) throw new Error('Учебные примеры временно недоступны. Обновите страницу позже.');
    fixtures = await response.json(); baseline = makeBaseline(fixtures);
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
    return publicClone({ client: workspace.client, files: workspace.files, events: workspace.events.filter(event => event.active !== false), result: latestResult(workspace, periodValue(period)), history: workspace.history, data_revision: workspace.data_revision });
  }
  function journal(workspace, action, detail, reviewer = null, resultId = null) {
    workspace.history.unshift({ id: id(), client_id: workspace.client.id, action, created_at: now(), reviewer, detail, result_id: resultId, actor_username: null });
  }
  function invalidate(workspace) {
    workspace.data_revision++; workspace.client._data_revision = workspace.data_revision;
    for (const result of workspace.results) if (result.status !== 'stale') {
      result.status = 'stale';
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
    const content = await window.AccountingPlusEngine.calculate(publicClone(workspace.events), publicClone(workspace.client), period);
    const fingerprint = stable(resultContent(content));
    const previous = latestResult(workspace, period);
    if (previous && previous._demo_revision === workspace.data_revision && previous._demo_fingerprint === fingerprint) return previous;
    if (previous) previous.status = 'stale';
    const result = { ...content, id: id(), client_id: workspace.client.id, period, version: (previous?.version || 0) + 1, status: 'calculated', created_at: now(), reviewer: null, _demo_revision: workspace.data_revision, _demo_fingerprint: fingerprint };
    workspace.results.push(result);
    journal(workspace, 'result_calculated', `Рассчитан учебный период ${period}, версия ${result.version}, правила ${result.rules_version}.`, null, result.id);
    return result;
  }
  function updateProfile(workspace, body) {
    unknownFields(body, PROFILE_FIELDS, 'Неизвестные поля профиля.');
    const old = Object.fromEntries(PROFILE_FIELDS.map(key => [key, workspace.client[key]]));
    const combined = { ...old, ...body };
    const periodChanged = combined.period !== old.period;
    if (periodChanged) Object.assign(combined, { opening_balance: null, ytd_income_before_period: null, income_data_complete: false });
    const profile = validateProfile(combined);
    if (stable(old) === stable(profile)) return workspace.client;
    workspace.client = { ...profile, id: workspace.client.id, _data_revision: workspace.data_revision };
    invalidate(workspace);
    journal(workspace, 'profile_updated', `Изменён учебный профиль: ${Object.keys(body).sort().join(', ')}.${periodChanged ? ' Начальный остаток и доходы до периода сброшены в неизвестные.' : ''}`);
    return workspace.client;
  }
  function updateEvent(workspace, eventId, body) {
    unknownFields(body, [...EVENT_FIELDS, 'reviewer', 'reason'], 'Можно исправлять только классификацию, дату признания, связи и примечание; сумму и исходник менять нельзя.');
    validateReviewer(body.reviewer, body.reason, true);
    const event = workspace.events.find(item => item.id === eventId && item.active !== false);
    if (!event) throw new Error('Действующая операция этого учебного клиента не найдена.');
    const changes = Object.fromEntries(Object.entries(body).filter(([key]) => EVENT_FIELDS.includes(key)));
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
    if (stable(event) === stable(updated)) return event;
    Object.assign(event, updated); invalidate(workspace);
    journal(workspace, 'event_updated', { event_id: eventId, reason: body.reason.trim(), before, after: Object.fromEntries(Object.keys(changes).map(key => [key, event[key]])) }, body.reviewer.trim());
    return event;
  }
  function reviewResult(workspace, body) {
    unknownFields(body, ['result_id', 'reviewer', 'comment', 'action'], 'Неизвестные поля проверки.');
    validateReviewer(body.reviewer, body.comment);
    if (!['review', 'approve'].includes(body.action)) throw new Error('Действие должно быть review или approve.');
    const result = workspace.results.find(item => item.id === body.result_id);
    if (!result) throw new Error('Результат этого учебного клиента не найден.');
    if (result._demo_revision !== workspace.data_revision || result.status === 'stale' || latestResult(workspace, result.period)?.id !== result.id) throw new Error('Результат устарел: данные изменились или существует новая версия. Пересчитайте период.');
    if (body.action === 'approve' && result.issues.some(issue => issue.severity === 'blocking')) throw new Error('Утверждение запрещено: сначала устраните блокирующие вопросы.');
    if (body.action === 'review' && result.status === 'approved') throw new Error('Результат уже утверждён. Новая проверка требует изменения данных или нового расчёта.');
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
    if (['доход', 'налог', 'усн', 'комисс'].some(word => text.includes(word))) lines.push(`Доход для УСН: ${value('usn_income')}. Предварительный налог до уменьшений: ${value('usn_tax_preliminary')}.`, `Комиссии ${value('commission')} и логистика ${value('logistics')} уменьшают ожидаемую выплату, но не базу УСН «Доходы».`, 'Возвраты и даты признания проверяйте по связанным операциям. Это не окончательная сумма к уплате.');
    else if (['свер', 'расхожд', 'банк', 'выплат'].some(word => text.includes(word))) {
      lines.push(`Выплаты по отчёту: ${value('declared_payouts')}. Связанные поступления банка: ${value('bank_received')}. Разница: ${value('payout_difference')}.`, `Остаток расчётов с маркетплейсом: ${value('closing_balance')}. Сопоставление выполнено по идентификаторам выплат. Совпадение сумм само по себе не доказывает связь.`);
      for (const row of result.reconciliation.slice(0, 15)) lines.push(`${row.settlement_id || 'Без связи'}: ${row.status}, разница ${row.difference} ₽.`);
    } else lines.push(`Доход для УСН: ${value('usn_income')}; предварительный налог: ${value('usn_tax_preliminary')}; разница выплат с банком: ${value('payout_difference')}.`);
    lines.push(`Вопросов для проверки: ${result.issues.length}, блокирующих: ${result.issues.filter(issue => issue.severity === 'blocking').length}.`);
    for (const issue of result.issues.slice(0, 20)) lines.push(`• ${issue.message}`);
    if (result.issues.length > 20) lines.push('Остальные вопросы доступны в разделе проверки.');
    const sources = [...result.income_rows, ...result.issues].flatMap(row => row.sources || []);
    const unique = new Map(sources.map(source => [stable(source), source]));
    return { mode: 'offline', provider: null, answer: lines.join('\n\n'), sources: [...unique.values()].slice(0, 100) };
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
  async function importFile(db, workspace, form) {
    if (!(form instanceof FormData)) throw new Error('Для загрузки выберите CSV-файл.');
    const source = form.get('source'); const file = form.get('file'); const replaces = form.get('replaces_file_id') || null;
    if (!['marketplace', 'bank'].includes(source)) throw new Error('Выберите отчёт маркетплейса или выписку банка.');
    if (!file || typeof file.arrayBuffer !== 'function' || !file.size) throw new Error('Файл пуст или не выбран.');
    if (!file.name?.toLowerCase().endsWith('.csv')) throw new Error('В учебной версии поддерживается внутренний CSV. XLSX доступен в серверной версии.');
    if (file.size > 1024 * 1024) throw new Error('В учебной версии файл должен быть не больше 1 МБ.');
    const replaced = replaces ? workspace.files.find(item => item.id === replaces) : null;
    if (replaces && (!replaced || replaced.status !== 'imported' || replaced.source !== source)) throw new Error('Заменить можно только действующий файл этого клиента и того же источника.');
    const bytes = await file.arrayBuffer();
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
    const duplicate = workspace.files.find(item => item.source === source && item.sha256 === digest && item.status === 'imported');
    if (duplicate && (!replaces || duplicate.id === replaces)) return { file: duplicate, duplicate: true, imported_count: 0 };
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { throw new Error('CSV должен быть в кодировке UTF-8. Пересохраните файл.'); }
    const filename = file.name.replaceAll('\\', '/').split('/').at(-1).replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 250) || 'file.csv';
    const fileId = id(); const metadata = { id: fileId, client_id: workspace.client.id, filename, source, sha256: digest, status: 'imported', created_at: now(), row_count: 0, error: null, replaces_file_id: replaces };
    try {
      const incoming = parseCsv(text, source); metadata.row_count = incoming.length;
      const seen = new Map(workspace.events.filter(event => event.active !== false && event.source === source && event.external_id && event.file_id !== replaces).map(event => [event.external_id, event._demo_original || originalContent(event)]));
      const additions = [];
      for (const event of incoming) {
        const comparable = originalContent(event);
        if (event.external_id && seen.has(event.external_id)) {
          if (stable(comparable) !== stable(seen.get(event.external_id))) throw new Error(`Строка ${event.line}: идентификатор ${event.external_id} уже существует с другими данными. Укажите заменяемый файл.`);
          continue;
        }
        if (event.external_id) seen.set(event.external_id, comparable);
        additions.push({ ...event, id: id(), client_id: workspace.client.id, file_id: fileId, active: true, _demo_original: comparable });
      }
      if (replaced) { replaced.status = 'replaced'; for (const event of workspace.events) if (event.file_id === replaces) event.active = false; }
      workspace.events.push(...additions); workspace.files.unshift(metadata); db.originals[fileId] = { filename, text };
      if (additions.length || replaced) invalidate(workspace);
      journal(workspace, replaced ? 'file_replaced' : 'file_imported', `Учебный CSV ${filename}: строк ${incoming.length}, новых операций ${additions.length}.${replaced ? ` Заменён файл ${replaces}.` : ''}`);
      return { file: metadata, duplicate: false, imported_count: additions.length };
    } catch (error) {
      metadata.status = 'failed'; metadata.error = error.message; workspace.files.unshift(metadata); db.originals[fileId] = { filename, text };
      journal(workspace, 'import_failed', `Файл ${filename}: ${error.message}`);
      return { _demo_import_error: error.message };
    }
  }
  async function route(db, path, options) {
    if (typeof path !== 'string' || !path.startsWith('/api/') || path.includes('..')) throw new Error('Неизвестный адрес действия учебной версии.');
    const url = new URL(path, 'https://browser-demo.invalid'); const method = (options.method || 'GET').toUpperCase();
    if (url.pathname === '/api/auth/me' && method === 'GET') return { auth_required: false, user: null, csrf_token: null };
    if (url.pathname === '/api/status' && method === 'GET') return { mode: 'browser_demo', ai: { enabled: false, provider: null }, format: 'accountingplus-v1', rules_version: '2026.1' };
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
        const profile = validateProfile({ name: '', inn: '', marketplace: 'wb', region: '', usn_rate: '6.00', vat_status: 'unknown', vat_effective_from: '2026-01-01', prior_year_income: null, ytd_income_before_period: null, income_data_complete: false, opening_balance: null, period: '2026-09', ...body });
        const workspace = { client: { ...profile, id: id(), _data_revision: 0 }, data_revision: 0, files: [], events: [], history: [], results: [] };
        journal(workspace, 'client_created', 'Создан учебный профиль клиента в этом браузере.'); db.workspaces.push(workspace); return workspace.client;
      }
    }
    const match = url.pathname.match(/^\/api\/clients\/([^/]+)(?:\/(.*))?$/);
    if (!match) throw new Error('Это действие недоступно в учебной версии.');
    const workspace = workspaceById(db, decodeURIComponent(match[1])); const suffix = match[2] || '';
    if (method === 'GET' && !suffix) return workspace.client;
    if (method === 'PATCH' && !suffix) return updateProfile(workspace, jsonBody(options));
    if (method === 'GET' && suffix === 'workspace') return snapshot(workspace, url.searchParams.get('period') || workspace.client.period);
    if (method === 'POST' && suffix === 'calculate') return calculateResult(workspace, jsonBody(options));
    if (method === 'POST' && suffix === 'review') return reviewResult(workspace, jsonBody(options));
    if (method === 'POST' && suffix === 'assistant') return assistant(workspace, jsonBody(options));
    if (method === 'POST' && suffix === 'files') return importFile(db, workspace, options.body);
    const eventMatch = suffix.match(/^events\/([^/]+)$/);
    if (method === 'PATCH' && eventMatch) return updateEvent(workspace, decodeURIComponent(eventMatch[1]), jsonBody(options));
    throw new Error('Это действие недоступно в учебной версии.');
  }
  async function request(path, options = {}) {
    await ready;
    const method = (options.method || 'GET').toUpperCase();
    const isMutation = !['GET', 'HEAD'].includes(method) && !path.endsWith('/assistant');
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
    if (!workspace.files.some(file => file.id === fileId) || !Object.hasOwn(database.originals, fileId)) throw new Error('Исходный CSV этого учебного клиента не найден.');
    const original = database.originals[fileId];
    return cachedBlob(`file:${fileId}`, original.text);
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
