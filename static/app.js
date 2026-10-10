'use strict';

const state = { clients: [], clientId: '', period: '2026-09', workspace: null, status: null, view: 'overview', busy: false, editingClient: null, editingEvent: null, reviewer: '', assistantContext: null, scenarios: [], showLegacy: false, authRequired: false, user: null, csrfToken: '', taxRules: null };
const kinds = { sale: 'Продажа', return: 'Возврат', commission: 'Комиссия', logistics: 'Логистика', withholding: 'Удержание', payout: 'Выплата', bank_credit: 'Поступление в банк', bank_debit: 'Списание банка' };
const viewText = {
  overview: ['Результат месяца', 'Доход, удержания и выплаты — с привязкой к исходникам.'],
  finance: ['Финансы селлера', 'Выручка, расходы, взносы и налог — за квартал и весь год.'],
  documents: ['Документы месяца', 'Загрузите комплект, проверьте распознавание и перейдите к вопросам.'],
  operations: ['Операции', 'Продажи, возвраты, удержания и банковские операции.'],
  reconciliation: ['Сверка выплат', 'Сопоставление отчёта маркетплейса и поступлений в банк.'],
  review: ['Проверка бухгалтера', 'Вопросы, исправления и утверждение конкретной версии.'],
  history: ['История работы', 'Кто изменил данные, пересчитал и проверил результат.']
};
const resultLabels = { calculated: ['Рассчитано · черновик', 'neutral'], reviewed: ['Проверено бухгалтером', 'good'], approved: ['Черновик утверждён', 'good'], stale: ['Нужно пересчитать', 'warning'] };
const reconciliationLabels = { matched: ['Сопоставлено', 'good'], partial: ['Частичная выплата', 'warning'], missing: ['Нет поступления', 'warning'], overpaid: ['Поступило больше', 'warning'], next_period: ['Поступление позже', 'neutral'], unlinked: ['Нет связи', 'warning'] };
const historyLabels = { tax_profile_updated: 'Обновлены настройки года', finance_updated: 'Сохранена версия финансов', records_updated: 'Обновлены дополнительные операции', assessment_approved: 'Утверждено начисление', client_created: 'Создан профиль', profile_updated: 'Изменён профиль', file_imported: 'Загружен файл', file_failed: 'Ошибка загрузки', file_replaced: 'Заменён файл', event_updated: 'Исправлена операция', calculated: 'Рассчитан период', result_calculated: 'Рассчитан период', result_created: 'Сохранён расчёт', review: 'Проверено бухгалтером', approve: 'Утверждён черновик', reviewed: 'Проверено бухгалтером', approved: 'Утверждён черновик', result_reviewed: 'Проверено бухгалтером', result_approved: 'Утверждён черновик' };
const $ = (id) => document.getElementById(id);

function el(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined && content !== null) node.textContent = String(content);
  return node;
}
function clear(id) { const node = $(id); node.replaceChildren(); return node; }
function badge(text, style = 'neutral') { return el('span', `badge ${style}`, text); }
function money(value, emptyLabel = 'Неизвестно') {
  if (value === null || value === undefined || value === '') return emptyLabel;
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(String(value));
  if (!match) return String(value);
  const integer = match[2].replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0');
  return `${match[1] === '-' ? '−' : ''}${integer},${(match[3] || '').padEnd(2, '0')}\u00a0₽`;
}
function date(value, withTime = false) {
  if (!value) return 'Не указана';
  const parsed = new Date(withTime ? value : `${value}T12:00:00`);
  if (Number.isNaN(parsed.getTime())) return String(value);
  return parsed.toLocaleString('ru-RU', withTime ? { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' } : { day: '2-digit', month: '2-digit', year: 'numeric' });
}
function periodTitle(value) {
  const parsed = new Date(`${value}-01T12:00:00`);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' });
}
function notify(message, error = false) {
  if (!$('login-screen').hidden && error) { $('login-error').textContent = message; $('login-error').hidden = false; }
  $('notification-text').textContent = message;
  $('notification').classList.toggle('error', error);
  $('notification').hidden = false;
}
function updateControls() {
  document.querySelectorAll('[data-mutates]').forEach((node) => { node.disabled = state.busy; });
  const hasClient = Boolean(state.clientId && state.workspace);
  $('client-select').disabled = state.busy || !state.clients.length;
  $('period-select').disabled = state.busy || !hasClient;
  $('edit-profile').disabled = state.busy || !hasClient;
  $('calculate').disabled = state.busy || !hasClient;
  $('assistant-submit').disabled = state.busy || !hasClient;
  const result = state.workspace?.result;
  const current = result && result.status !== 'stale';
  $('review-button').disabled = state.busy || !current || result.status === 'approved';
  $('approve-button').disabled = state.busy || !current || result.status === 'approved' || (result.issues || []).some((issue) => issue.severity === 'blocking');
  document.querySelectorAll('[data-export]').forEach((node) => { node.disabled = state.busy || !current; });
  document.querySelectorAll('[data-question]').forEach((node) => { node.disabled = state.busy || !hasClient; });
  $('upload-source').disabled = state.busy;
  $('upload-replacement').disabled = state.busy;
  $('upload-file').disabled = state.busy; $('upload-confirm').disabled = state.busy;
  $('main').setAttribute('aria-busy', String(state.busy));
  if (state.user?.role === 'viewer') {
    document.querySelectorAll('[data-mutates]').forEach((node) => { if (!['client-select', 'period-select', 'refresh-button', 'logout-button', 'assistant-submit', 'login-submit'].includes(node.id)) node.disabled = true; });
    $('upload-source').disabled = true; $('upload-replacement').disabled = true; $('upload-file').disabled = true; $('upload-confirm').disabled = true;
  }
  window.AccountingPlusFinance?.setBusy(state.busy);
}
function applySession(info) {
  state.authRequired = Boolean(info.auth_required); state.user = info.user || null; state.csrfToken = info.csrf_token || '';
  $('login-screen').hidden = true; $('app-shell').hidden = false; $('login-password').value = ''; $('login-error').hidden = true;
  $('session-user').hidden = !state.user; $('logout-button').hidden = !state.user;
  if (state.user) { $('session-user').textContent = `${state.user.display_name} · ${state.user.role === 'viewer' ? 'просмотр' : 'редактирование'}`; state.reviewer = state.user.display_name; $('reviewer-name').value = state.reviewer; }
  $('reviewer-name').readOnly = Boolean(state.user); $('edit-reviewer').readOnly = Boolean(state.user);
}
function showLogin() {
  state.authRequired = true; state.user = null; state.csrfToken = ''; state.clientId = ''; state.clients = []; state.workspace = null; state.reviewer = '';
  state.editingClient = null; state.editingEvent = null; state.assistantContext = null;
  document.querySelectorAll('dialog').forEach(dialog => { if (dialog.open) dialog.close(); });
  ['profile-form', 'event-form', 'review-form', 'assistant-form'].forEach(id => $(id).reset());
  ['metrics', 'files-table', 'events-table', 'reconciliation-table', 'issues-list', 'history-list', 'assistant-answer', 'event-original', 'profile-flags', 'calculation-breakdown', 'calculation-explanation', 'issue-summary'].forEach(id => $(id).replaceChildren());
  renderClients(); $('notification').hidden = true;
  $('app-shell').hidden = true; $('login-screen').hidden = false; $('login-password').value = ''; $('login-username').focus();
}
async function api(path, options = {}) {
  if (window.AccountingPlusDemo) return window.AccountingPlusDemo.request(path, options);
  const headers = { 'X-AccountingPlus-Local': '1', ...options.headers };
  if (state.csrfToken) headers['X-CSRF-Token'] = state.csrfToken;
  if (options.body && !(options.body instanceof FormData)) headers['Content-Type'] = 'application/json';
  let response;
  try { response = await fetch(path, { ...options, headers }); }
  catch { throw new Error(location.hostname === '127.0.0.1' || location.hostname === 'localhost' ? 'Нет связи с кабинетом на этом компьютере. Сервер должен быть запущен; после запуска обновите страницу.' : 'Пропала связь с кабинетом. Обновите страницу через минуту. Если вы сохраняли изменения, проверьте историю перед повтором.'); }
  const contentType = response.headers.get('content-type') || '';
  if (!response.ok) {
    let current;
    let detail = [502, 503, 504].includes(response.status) ? 'Кабинет временно недоступен. Обновите страницу через минуту. Если вы сохраняли изменения, проверьте историю перед повтором.' : `Не удалось выполнить действие (код ${response.status}).`;
    if (contentType.includes('application/json')) {
      try { const body = await response.json(); if (typeof body.detail === 'string') detail = body.detail; current = body.current; }
      catch { /* The HTTP status remains available when the error body is not JSON. */ }
    }
    if (response.status === 401 && path !== '/api/auth/login') showLogin();
    const error = new Error(detail); error.status = response.status; error.current = current; throw error;
  }
  if (!contentType.includes('application/json')) throw new Error('Приложение вернуло неожиданный ответ. Повторите действие после проверки сервера.');
  return response.json();
}
async function task(work, success) {
  if (state.busy) return;
  state.busy = true; updateControls();
  try { await work(); if (success) notify(success); }
  catch (error) { notify(error.message || 'Не удалось выполнить действие.', true); }
  finally { state.busy = false; updateControls(); }
}
function clientUrl(suffix = '') { return `/api/clients/${encodeURIComponent(state.clientId)}${suffix}`; }
function fileUrl(fileId) {
  return window.AccountingPlusDemo ? window.AccountingPlusDemo.fileUrl(state.clientId, fileId) : clientUrl(`/files/${encodeURIComponent(fileId)}/download`);
}
function sourceLink(source) {
  const file = (state.workspace?.files || []).find((item) => item.id === source.file_id);
  const link = el('a', 'source-link', `${file?.filename || 'Исходник'} · строка ${source.line ?? '—'}`);
  link.href = fileUrl(source.file_id); link.download = file?.filename || '';
  return link;
}
function sourceList(sources) {
  const list = el('div', 'issue-sources');
  for (const source of sources || []) list.append(sourceLink(source));
  return list;
}
function table(headers, rows) {
  const wrapper = el('div', 'table-scroll');
  const node = el('table'); const head = el('thead'); const headRow = el('tr');
  headers.forEach((header) => { const cell = el('th', header.money ? 'money' : '', header.label || header); cell.scope = 'col'; headRow.append(cell); });
  head.append(headRow); node.append(head); const body = el('tbody');
  rows.forEach((cells) => { const row = el('tr'); cells.forEach((content) => { const cell = el('td', content?.className || ''); if (content?.node instanceof Node) cell.append(content.node); else cell.textContent = content?.text ?? String(content ?? ''); row.append(cell); }); body.append(row); });
  node.append(body); wrapper.append(node); return wrapper;
}
function showView(view) {
  state.view = view;
  document.querySelectorAll('[data-section]').forEach((section) => { section.hidden = section.dataset.section !== view; });
  document.querySelectorAll('[data-view]').forEach((button) => {
    const active = button.dataset.view === view; button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
  });
  $('page-title').textContent = viewText[view][0];
  $('page-description').textContent = viewText[view][1];
  const finance = view === 'finance';
  $('calculate').hidden = finance; $('result-status').hidden = finance; $('profile-flags').hidden = finance;
  document.querySelectorAll('.export-panel').forEach(node => { node.hidden = finance; });
  document.querySelector('.content-grid').classList.toggle('finance-view', finance);
  document.querySelector('.period-picker').hidden = finance;
  if (state.workspace) {
    const market = state.workspace.client.marketplace === 'ozon' ? 'Ozon' : 'Wildberries';
    $('page-eyebrow').textContent = finance ? `Годовой учёт · ${market}` : `${periodTitle(state.period)} · ${market}`;
    $('period-note').textContent = finance ? 'Год и накопительный период выбираются в разделе ниже. Каждая сумма включает данные с начала года.' : 'Выбор месяца меняет только просмотр. Сохранённые сведения и утверждённые версии остаются в истории.';
  }
  window.AccountingPlusFinance?.activate(finance);
  if (state.clientId) history.replaceState(null, '', `#${new URLSearchParams({ view, client: state.clientId })}`);
}
function isLegacyDemo(client) {
  return client.name.startsWith('Учебный ИП —') || (/^0[1-6] · /.test(client.name) && !state.scenarios.some(scenario => scenario.title === client.name));
}
function renderClients() {
  const select = clear('client-select');
  if (!state.clients.length) { const option = el('option', '', 'Нет выбранного клиента'); option.value = ''; select.append(option); }
  const legacy = state.clients.filter(client => isLegacyDemo(client));
  $('toggle-legacy').hidden = !legacy.length;
  $('toggle-legacy').textContent = `${state.showLegacy ? 'Скрыть' : 'Показать'} старые учебные копии (${legacy.length})`;
  state.clients.filter(client => state.showLegacy || !isLegacyDemo(client) || client.id === state.clientId).forEach((client) => { const option = el('option', '', isLegacyDemo(client) ? `Старая копия · ${client.name} · ${client.id.slice(0, 6)}` : client.name); option.value = client.id; select.append(option); });
  select.value = state.clientId;
}
async function loadWorkspace() {
  if (!state.clientId) { state.workspace = null; render(); return; }
  state.workspace = await api(clientUrl(`/workspace?period=${encodeURIComponent(state.period)}`));
  try { state.annual = await api(clientUrl(`/finance?year=${state.period.slice(0,4)}`)); } catch(error) { state.annual = null; notify(`Месяц открыт; годовой расчёт недоступен: ${error.message}`, true); }
  const index = state.clients.findIndex((client) => client.id === state.clientId);
  if (index >= 0) state.clients[index] = state.workspace.client;
  render();
}
async function chooseClient(client) {
  const period = client.period || '2026-09';
  const workspace = await api(`/api/clients/${encodeURIComponent(client.id)}/workspace?period=${encodeURIComponent(period)}`);
  state.clientId = client.id; state.period = period; state.workspace = workspace; state.annual = null;
  try { state.annual = await api(clientUrl(`/finance?year=${period.slice(0,4)}`)); } catch(error) { notify(`Годовой расчёт недоступен: ${error.message}`, true); }
  $('period-select').value = state.period;
  $('assistant-answer').hidden = true;
  $('review-comment').value = ''; $('event-search').value = ''; $('event-filter').value = '';
  render();
}
function renderFlags() {
  const node = clear('profile-flags'); const client = state.workspace.client; const result = state.workspace.result;
  if ((client.name || '').includes('Учебный')) node.append(el('div', 'notice info', 'Учебные данные: этот клиент и его операции вымышлены. Результат не предназначен для сдачи отчётности.'));
  const scenario = state.scenarios.find(item => item.title === client.name);
  if (scenario) {
    const help = el('div', 'notice info'); help.append(el('strong', '', `Учебная ситуация: ${scenario.title}`), el('p', '', scenario.description), el('p', '', `Что проверить: ${scenario.task}`)); node.append(help);
  }
  if (!state.workspace.files.some((file) => file.status === 'imported')) node.append(el('div', 'notice info', 'Исходники ещё не загружены. Начните с документов или откройте учебный набор.'));
  if (client.vat_status !== 'exempt') node.append(el('div', 'notice danger', client.vat_status === 'unknown' ? 'Статус НДС неизвестен. Подтвердите профиль перед утверждением расчёта.' : 'Расчёт НДС 5% и 7% пока не поддерживается. Операции такого профиля требуют отдельной проверки.'));
  if (result?.status === 'stale') node.append(el('div', 'notice warning', 'Данные изменились. Ниже показана прежняя версия; она неактуальна. Рассчитайте период заново.'));
  if (client.period !== state.period) node.append(el('div', 'notice warning', 'Начальный остаток и доход с начала года относятся к другому периоду. Проверьте профиль перед расчётом.'));
}
function renderMetrics() {
  const result = state.workspace.result; const node = clear('metrics');
  $('no-result').hidden = Boolean(result); $('calculation-content').hidden = !result;
  if (!result) return;
  const metrics = result.metrics || {};
  const cards = [
    ['Доход для УСН', metrics.usn_income, 'По датам признания; при вопросах — предварительно'],
    ['Ожидаемая выплата', metrics.expected_payout, 'Продажи − возвраты − удержания'],
    ['Поступило в банк за месяц', state.annual?.monthly?.find(row=>row.month===state.period)?.bank_received ?? null, 'Все поступления выписки; связь с выплатами проверяется отдельно'],
    ['Расхождение подтверждённых выплат', state.workspace.events.some(event=>event.kind==='payout'&&event.date?.startsWith(state.period)) ? metrics.payout_difference : null, 'Без документа о выплате расхождение не определено']
  ];
  cards.forEach(([label, amount, note], index) => { const card = el('div', `metric-card${index === 3 && amount !== '0.00' ? ' difference' : ''}`); card.append(el('div', 'metric-label', label), el('strong', 'metric-value', money(amount, 'Недостаточно данных')), el('p', 'micro', note)); node.append(card); });
  const expenses = state.workspace.client.tax_regime === 'income_expenses';
  $('tax-amount').textContent = 'В разделе «Финансы»';
  $('tax-description').textContent = expenses ? 'УСН «Доходы минус расходы»: подтвердите расходы в разделе «Финансы». Там рассчитываются взносы, накопительные авансы и годовой минимальный налог.' : 'Месяц показывает продажи и движение денег. Налог и взносы рассчитываются с начала года по отдельному профилю в разделе «Финансы».';
  const breakdown = clear('calculation-breakdown');
  [['Продажи', 'sales'], ['Возвраты', 'returns'], ['Комиссия маркетплейса', 'commission'], ['Логистика', 'logistics'], ['Прочие удержания', 'withholding'], ['Заявленные выплаты', 'declared_payouts'], ['Остаток расчётов с маркетплейсом', 'closing_balance']].forEach(([label, key]) => { const row = el('div', 'breakdown-row'); row.append(el('dt', '', label), el('dd', '', money(metrics[key], 'Недостаточно данных'))); breakdown.append(row); });
  $('rules-label').textContent = `Правила ${result.rules_version || '—'} · версия ${result.version}`;
  $('calculation-explanation').textContent = typeof result.explanation === 'string' ? result.explanation : JSON.stringify(result.explanation || '', null, 2);
  const incomeTable = clear('income-table');
  const incomeRows = result.income_rows || [];
  if (!incomeRows.length) incomeTable.append(el('p', 'empty-message', 'В выбранном периоде нет строк дохода для УСН.'));
  else incomeTable.append(table(['Дата дохода', 'Операция / источник', { label: 'Доход', money: true }], incomeRows.map((row) => {
    const event = state.workspace.events.find((item) => item.id === row.event_id);
    const source = el('div', '', event?.external_id || row.event_id || 'Операция');
    source.append(sourceList(row.sources?.length ? row.sources : event ? [event] : []));
    return [{ text: date(row.tax_date), className: 'nowrap' }, { node: source }, { text: money(row.amount), className: 'money' }];
  })));
  const summary = clear('issue-summary'); const issues = result.issues || [];
  if (!issues.length) { const good = el('div', 'all-clear', '✓ В расчёте не выявлены вопросы'); good.append(el('p', '', 'Проверьте суммы и источники с бухгалтером перед утверждением.')); summary.append(good); }
  issues.slice(0, 3).forEach((issue) => { const item = el('div', 'summary-issue'); item.append(badge(issue.severity === 'blocking' ? 'Нужно уточнить' : 'Обратите внимание', issue.severity === 'blocking' ? 'warning' : 'neutral'), el('p', '', issue.message)); summary.append(item); });
  if (issues.length > 3) summary.append(el('p', 'micro', `Ещё вопросов: ${issues.length - 3}. Откройте раздел проверки.`));
}
function renderFiles() {
  const files = state.workspace.files || []; const node = clear('files-table');
  $('file-count').textContent = `${files.length} файлов`;
  if (!files.length) node.append(el('p', 'empty-message', 'Пока нет файлов. Загрузите поддерживаемый комплект или начните с учебного месяца.'));
  else node.append(table(['Файл / источник', 'Строки', 'Состояние', 'Загружен'], files.map((file) => {
    const name = el('div'); const link = el('a', '', file.filename); link.href = fileUrl(file.id); link.download = file.filename; name.append(link, el('span', 'cell-subtitle', file.source === 'bank' ? 'Банк' : 'Маркетплейс'));
    const status = el('div'); status.append(badge({ imported: 'Загружен', failed: 'Ошибка', replaced: 'Заменён' }[file.status] || file.status, file.status === 'failed' ? 'danger' : file.status === 'imported' ? 'good' : 'neutral')); if (file.error) status.append(el('span', 'cell-subtitle', file.error));
    return [{ node: name }, { text: file.row_count ?? '—' }, { node: status }, { text: date(file.created_at, true), className: 'nowrap' }];
  })));
  renderReplacementOptions();
}
function renderReplacementOptions() {
  const previous = $('upload-replacement').value; const select = clear('upload-replacement');
  const base = el('option', '', 'Новая загрузка'); base.value = ''; select.append(base);
  const selectedSource = $('upload-source').value; const source = selectedSource === 'auto' ? 'marketplace' : selectedSource;
  for (const file of state.workspace?.files || []) if (file.status === 'imported' && (source === 'auto' || file.source === source)) { const option = el('option', '', file.filename); option.value = file.id; select.append(option); }
  if ([...select.options].some((option) => option.value === previous)) select.value = previous;
  $('template-csv').href = window.AccountingPlusDemo ? window.AccountingPlusDemo.templateUrl(source, 'csv') : `/api/templates/${encodeURIComponent(source)}?format=csv`;
  $('template-csv').download = `accountingPLUS-${source}.csv`;
  if (!window.AccountingPlusDemo) $('template-xlsx').href = `/api/templates/${encodeURIComponent(source)}?format=xlsx`;
}
function renderEvents() {
  const node = clear('events-table'); if (!state.workspace) return;
  const all = (state.workspace.events || []).filter((event) => event.active !== false);
  const search = $('event-search').value.trim().toLocaleLowerCase('ru-RU'); const filter = $('event-filter').value;
  const events = all.filter((event) => (!filter || (filter === 'unknown' ? !kinds[event.kind] : event.kind === filter)) && (!search || [event.external_id, event.note, event.settlement_id, event.related_id].some((value) => String(value || '').toLocaleLowerCase('ru-RU').includes(search))));
  $('event-count').textContent = `${events.length} из ${all.length} операций`;
  if (!events.length) { node.append(el('p', 'empty-message', all.length ? 'По выбранным фильтрам нет операций.' : 'Операции появятся после загрузки файла.')); return; }
  node.append(table(['Дата / идентификатор', 'Тип', { label: 'Сумма', money: true }, 'Доход признан', 'Связи / источник', ''], events.map((event) => {
    const identity = el('div', 'nowrap', date(event.date)); identity.append(el('span', 'cell-subtitle', event.external_id));
    const type = el('div'); type.append(badge(kinds[event.kind] || `Неизвестно: ${event.kind}`, kinds[event.kind] ? 'neutral' : 'warning')); if (event.note) type.append(el('span', 'cell-subtitle', event.note));
    const links = el('div'); links.append(sourceLink(event)); if (event.settlement_id) links.append(el('span', 'cell-subtitle', `Выплата: ${event.settlement_id}`)); if (event.related_id) links.append(el('span', 'cell-subtitle', `Продажа: ${event.related_id}`));
    const button = el('button', 'text-button', 'Проверить'); button.type = 'button'; button.dataset.mutates = ''; button.disabled = state.busy; button.addEventListener('click', () => openEvent(event));
    return [{ node: identity }, { node: type }, { text: money(event.amount), className: 'money' }, { text: event.tax_date ? date(event.tax_date) : ['sale', 'return'].includes(event.kind) ? 'Не указана' : '—', className: 'nowrap' }, { node: links }, { node: button }];
  })));
}
function eventSources(ids) {
  const sources = (ids || []).map((id) => state.workspace.events.find((event) => event.id === id)).filter(Boolean);
  return sourceList(sources);
}
function renderReconciliation() {
  const node = clear('reconciliation-table'); const result = state.workspace.result;
  if (!result) { node.append(el('p', 'empty-message', 'Сначала рассчитайте период — появятся группы выплат и поступлений.')); return; }
  const items = result.reconciliation || [];
  if (!items.length) { node.append(el('p', 'empty-message', 'В выбранном периоде нет выплат для сопоставления.')); return; }
  node.append(table(['Выплата / источники', { label: 'Заявлено', money: true }, { label: 'Банк', money: true }, { label: 'Расхождение', money: true }, 'Состояние'], items.map((item) => {
    const group = el('div', '', item.settlement_id || 'Без идентификатора'); const details = el('details'); details.append(el('summary', 'micro', 'Строки источников'), eventSources([...(item.payout_event_ids || []), ...(item.bank_event_ids || [])])); group.append(details);
    const label = reconciliationLabels[item.status] || [item.status, 'neutral'];
    return [{ node: group }, { text: money(item.expected), className: 'money' }, { text: money(item.received), className: 'money' }, { text: money(item.difference), className: 'money' }, { node: badge(...label) }];
  })));
}
function renderIssues() {
  const node = clear('issues-list'); const result = state.workspace.result; const issues = result?.issues || [];
  $('issue-count').textContent = result ? `${issues.length} вопросов` : '';
  $('nav-issue-count').textContent = String(issues.length); $('nav-issue-count').hidden = !issues.length;
  $('review-version').textContent = result ? `Версия ${result.version} · ${date(result.created_at, true)}` : 'Расчёт пока отсутствует';
  $('approval-help').textContent = !result ? 'Рассчитайте период перед проверкой.' : result.status === 'stale' ? 'Эта версия неактуальна. Сначала пересчитайте период.' : result.status === 'approved' ? `Утверждено: ${result.reviewer || 'специалист'}. Новые изменения потребуют повторной проверки.` : issues.some((issue) => issue.severity === 'blocking') ? 'Утверждение недоступно, пока есть вопросы, требующие уточнения. Исправьте данные или профиль и пересчитайте период.' : 'Утверждается только этот черновик. Для окончательного налога нужны все доходы и данные об уменьшениях.';
  if (!result) { node.append(el('p', 'empty-message', 'После расчёта здесь появятся вопросы и ссылки на исходные строки.')); return; }
  if (!issues.length) { node.append(el('p', 'all-clear', '✓ Автоматические проверки не выявили вопросов. Результат готов к проверке бухгалтером.')); return; }
  for (const issue of issues) {
    const item = el('article', 'issue-item'); item.append(badge(issue.severity === 'blocking' ? 'Требует уточнения' : 'Предупреждение', issue.severity === 'blocking' ? 'warning' : 'neutral'), el('p', '', issue.message), sourceList(issue.sources));
    if (issue.event_ids?.length) { const button = el('button', 'text-button', 'Открыть связанную операцию →'); button.addEventListener('click', () => { const event = state.workspace.events.find((entry) => entry.id === issue.event_ids[0]); if (event) { $('event-search').value = event.external_id; $('event-filter').value = ''; renderEvents(); showView('operations'); } }); item.append(button); }
    node.append(item);
  }
}
function renderHistory() {
  const node = clear('history-list'); const history = state.workspace.history || [];
  if (!history.length) { node.append(el('p', 'empty-message', 'История изменений пока пуста.')); return; }
  for (const entry of [...history].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))) {
    const item = el('div', 'history-item'); const content = el('div'); content.append(el('strong', '', historyLabels[entry.action] || 'Изменение в рабочем кабинете'));
    if (entry.detail) content.append(el('p', '', typeof entry.detail === 'string' ? entry.detail : entry.detail.reason || `Год ${entry.detail.year || '—'} · версия ${entry.detail.revision || '—'}`));
    if(entry.result_id){const button=el('button','text-button','Открыть сохранённый снимок расчёта');button.type='button';button.addEventListener('click',()=>task(async()=>{const snapshot=await api(clientUrl(`/results/${encodeURIComponent(entry.result_id)}`));const url=URL.createObjectURL(new Blob([JSON.stringify(snapshot,null,2)],{type:'application/json'}));const link=el('a');link.href=url;link.download=`accountingplus-${snapshot.period}-v${snapshot.version}.json`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}));content.append(button);}
    content.append(el('span', 'micro', `${date(entry.created_at, true)}${entry.reviewer ? ` · ${entry.reviewer}` : ''}`)); item.append(content); node.append(item);
  }
}
function renderNextStep(result) {
  if (!result) return;
  const approved = result.status === 'approved';
  const blocking = (result.issues || []).some(issue => issue.severity === 'blocking');
  const reviewed = result.status === 'reviewed';
  $('next-step-title').textContent = approved ? 'Черновик утверждён' : blocking ? 'Сначала уточните вопросы расчёта' : reviewed ? 'Осталось утвердить черновик' : 'Следующий шаг — проверить черновик';
  $('next-step-description').textContent = approved ? 'Сохраните выгрузку проверенной версии для ручного переноса в учёт.' : blocking ? 'Проверьте источники, исправьте данные и пересчитайте период.' : reviewed ? 'Откройте проверку и подтвердите текущую версию, если все данные верны.' : 'Сопоставьте суммы с источниками и ответьте на вопросы расчёта.';
  $('next-step-action').hidden = approved;
  $('next-step-action').firstChild.textContent = reviewed && !blocking ? 'К утверждению ' : 'К проверке ';
}


function exactMoneySum(values) {
  let total=0n;for(const value of values){if(value==null)return null;const match=String(value).match(/^(-?)(\d+)(?:\.(\d{1,2}))?$/);if(!match)return null;total+=(match[1]?-1n:1n)*(BigInt(match[2])*100n+BigInt((match[3]||'').padEnd(2,'0')));}
  const absolute=total<0n?-total:total;return `${total<0n?'-':''}${absolute/100n}.${String(absolute%100n).padStart(2,'0')}`;
}
function renderMonthlyProfit(){
  const node=clear('monthly-profit'),month=state.annual?.monthly?.find(row=>row.month===state.period);
  node.append(el('h2','','Продажи и прибыль месяца'));
  if(!month){node.append(el('p','','Для результата нужны доступные документы и годовой реестр.'));return;}
  const revenue=exactMoneySum([month.revenue,month.outside_revenue||'0.00']);
  const costs=exactMoneySum([month.costs,month.additional_expenses||'0.00']);
  const complete=month.income_complete===true&&month.management_complete===true;
  const profit=complete?exactMoneySum([revenue,costs==null?null:`-${costs}`]):null;
  const list=el('dl','calculation-breakdown');
  for(const [label,value]of [['Продажи после возвратов · из документов',month.revenue],['Удержания маркетплейса · из документов',month.costs],['Дополнительные расходы · из реестра',month.additional_expenses??null],['Прибыль до налогов',profit]]){const row=el('div','breakdown-row');row.append(el('dt','',label),el('dd','',money(value,'Нужно подтвердить полноту месяца')));list.append(row);}node.append(list);
  if(!complete)node.append(el('p','micro','Известные продажи и удержания показаны. Для полной прибыли подтвердите остальные доходы и расходы месяца в разделе «Финансы → Документы и дополнительные операции».'));
  const details=el('details'),summary=el('summary','','Посмотреть строки продаж и удержаний');details.append(summary);
  const events=state.workspace.events.filter(event=>event.source==='marketplace'&&event.date?.startsWith(state.period)&&['sale','return','commission','logistics','withholding'].includes(event.kind));
  details.append(table(['Операция','Сумма','Источник'],events.map(event=>[kinds[event.kind],{text:money(event.amount),className:'money'},{node:sourceLink(event)}])));node.append(details);
}
function renderWorkflow() {
  const files = state.workspace.files.filter(file => file.status === 'imported');
  const result = state.workspace.result;
  const missing = ['marketplace','bank'].filter(source => !files.some(file => file.source === source));
  const questions = (result?.issues || []).filter(issue => issue.severity === 'blocking').length;
  $('workflow-state').textContent = missing.length ? 'Нужны документы' : !result || result.status === 'stale' ? 'Нужен пересчёт' : questions ? `Есть вопросы: ${questions}` : ['reviewed','approved'].includes(result.status) ? 'Проверен' : 'Черновик рассчитан';
  $('workflow-next').textContent = missing.length ? `Добавьте ${missing.map(source=>source==='bank'?'выписку банка':'отчёт маркетплейса').join(' и ')}.` : questions ? 'Уточните вопросы со ссылками на исходники.' : 'Проверьте результат и подтвердите конкретную версию.';
}

function render() {
  if (state.assistantContext && state.assistantContext !== assistantContext()) {
    $('assistant-answer').hidden = true; state.assistantContext = null;
  }
  renderClients(); $('period-select').value = state.period;
  $('empty-state').hidden = Boolean(state.workspace); $('client-content').hidden = !state.workspace;
  if (state.workspace) {
    const client = state.workspace.client; const result = state.workspace.result; const label = result ? resultLabels[result.status] || [result.status, 'neutral'] : ['Не рассчитано', 'neutral'];
    $('page-eyebrow').textContent = `${periodTitle(state.period)} · ${client.marketplace === 'ozon' ? 'Ozon' : 'Wildberries'}`;
    $('period-note').textContent = 'Выбор месяца меняет только просмотр. Сохранённые сведения и утверждённые версии остаются в истории.';
    $('result-status').textContent = label[0]; $('result-status').className = `badge ${label[1]}`;
    $('client-content').classList.toggle('stale-result', result?.status === 'stale');
    renderWorkflow(); renderMonthlyProfit(); renderNextStep(result); renderFlags(); renderMetrics(); renderFiles(); renderEvents(); renderReconciliation(); renderIssues(); renderHistory();
  }
  window.AccountingPlusFinance?.render();
  showView(state.view); updateControls();
}
function decimal(value, name, nullable = false, signed = false) {
  const normalized = String(value || '').trim().replace(',', '.');
  if (!normalized && nullable) return null;
  const expression = signed ? /^-?\d+(?:\.\d{1,2})?$/ : /^\d+(?:\.\d{1,2})?$/;
  if (!expression.test(normalized)) throw new Error(`${name}: укажите сумму с максимум двумя знаками после запятой.`);
  const [integer, fraction = ''] = normalized.split('.'); return `${integer}.${fraction.padEnd(2, '0')}`;
}
function openProfile(client = null) {
  if (state.busy) return;
  state.editingClient = client; $('profile-form').reset();
  $('profile-dialog-title').textContent = client ? 'Профиль ИП' : 'Новый клиент';
  const defaults = { name: '', inn: '', marketplace: 'wb', region: '', period: state.period, usn_rate: '6.00', tax_regime: 'income', has_employees: '', vat_status: 'unknown', vat_effective_from: '', prior_year_income: '', ytd_income_before_period: '', opening_balance: '' };
  defaults.usn_rate = state.taxRules?.regimes?.income?.default_rate || '';
  for (const [name, fallback] of Object.entries(defaults)) $('profile-form').elements.namedItem(name).value = client?.[name] ?? fallback;
  $('profile-complete').checked = client?.income_data_complete || false;
  $('profile-details').open = Boolean(client);
  for(const id of ['profile-region','profile-regime','profile-rate','profile-employees','profile-vat','profile-vat-date','profile-prior-income'])$(id).closest('.field').hidden=true;
  $('profile-dialog').showModal(); $('profile-name').focus();
}
function openEvent(event) {
  if (state.busy) return;
  state.editingEvent = event; $('event-conflict').replaceChildren(); $('event-conflict').hidden = true; $('event-form').reset(); $('event-dialog-title').textContent = event.external_id;
  const original = clear('event-original'); original.append(el('strong', '', `${money(event.amount)} · ${date(event.date)}`), el('p', '', `Исходный тип: ${event.original_kind || event.kind}. Сумма и файл сохраняются.`), sourceLink(event));
  const select = clear('edit-kind'); const supported = event.source === 'bank' ? ['bank_credit', 'bank_debit'] : ['sale', 'return', 'commission', 'logistics', 'withholding', 'payout'];
  if (!supported.includes(event.kind)) supported.unshift(event.kind);
  supported.forEach((kind) => { const option = el('option', '', kinds[kind] || `Неизвестно: ${kind}`); option.value = kind; select.append(option); }); select.value = event.kind;
  for (const key of ['tax_date', 'settlement_id', 'related_id', 'note']) $('event-form').elements.namedItem(key).value = event[key] || '';
  $('edit-reviewer').value = state.reviewer || $('reviewer-name').value;
  $('event-dialog').showModal(); $('edit-kind').focus();
}
async function exportFile(format) {
  await task(async () => {
    let blob;
    if (window.AccountingPlusDemo) {
      blob = await window.AccountingPlusDemo.exportBlob(state.clientId, state.period, format);
    } else {
      let response;
      try { response = await fetch(clientUrl(`/export?format=${encodeURIComponent(format)}&period=${encodeURIComponent(state.period)}`), { headers: { 'X-AccountingPlus-Local': '1' } }); }
      catch { throw new Error('Не удалось связаться с приложением для выгрузки.'); }
      if (!response.ok) { let message = 'Не удалось выгрузить черновик.'; try { const body = await response.json(); if (typeof body.detail === 'string') message = body.detail; } catch { /* Preserve the download error if the server has no JSON body. */ } throw new Error(message); }
      blob = await response.blob();
    }
    const url = URL.createObjectURL(blob); const link = el('a'); link.href = url;
    link.download = `accountingPLUS-${state.period}.${format === 'report' ? 'md' : format}`; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000);
  }, 'Черновик подготовлен к скачиванию.');
}
async function askAssistant(question) {
  if (!state.clientId || state.busy) return;
  $('assistant-answer').hidden = true;
  await task(async () => {
    const result = await api(clientUrl('/assistant'), { method: 'POST', body: JSON.stringify({ question, period: state.period }) });
    const node = clear('assistant-answer'); node.hidden = false;
    node.append(badge(result.mode === 'model' ? `Модель · ${result.provider || 'провайдер'}` : 'Локальное пояснение · без ИИ', 'neutral'), el('div', 'answer-text', result.answer), sourceList(result.sources));
    state.assistantContext = assistantContext();
  });
}
function assistantContext() {
  const workspace = state.workspace;
  return JSON.stringify([state.clientId, state.period, workspace?.data_revision ?? workspace?.client?._data_revision ?? null, workspace?.result?.id ?? null, workspace?.result?.status ?? null]);
}

document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => showView(button.dataset.view)));
document.querySelectorAll('[data-go]').forEach((button) => button.addEventListener('click', () => showView(button.dataset.go)));
document.querySelectorAll('[data-close]').forEach((button) => button.addEventListener('click', () => { if (!state.busy) $(button.dataset.close).close(); }));
document.querySelectorAll('dialog').forEach((dialog) => dialog.addEventListener('cancel', (event) => { if (state.busy) event.preventDefault(); }));
function renderExamples() {
  const cards = clear('example-cards');
  state.scenarios.forEach(scenario => {
    const card = el('article', 'example-card');
    card.append(el('h3', '', scenario.title), el('p', '', scenario.description), el('p', 'micro', `Что проверить: ${scenario.task}`));
    const button = el('button', 'button secondary', 'Открыть пример'); button.dataset.demo = scenario.id; button.dataset.mutates = ''; card.append(button); cards.append(card);
  });
}
$('open-examples').addEventListener('click', () => { renderExamples(); $('examples-dialog').showModal(); });
$('toggle-legacy').addEventListener('click', () => { state.showLegacy = !state.showLegacy; renderClients(); });
document.addEventListener('click', event => {
  const button = event.target.closest('[data-demo]'); if (!button || state.busy || (state.authRequired && state.user?.role === 'viewer')) return;
  task(async () => {
    const response = await api('/api/demo', { method: 'POST', body: JSON.stringify({ scenario: button.dataset.demo }) });
    state.clients = await api('/api/clients'); await chooseClient(response.client); showView('overview'); $('examples-dialog').close();
  }, 'Учебный набор открыт. Повторное открытие сохраняет исправления. Все данные вымышлены.');
});
$('dismiss-notification').addEventListener('click', () => { $('notification').hidden = true; });
$('new-client').addEventListener('click', () => openProfile());
$('edit-profile').addEventListener('click', () => openProfile(state.workspace.client));
$('client-select').addEventListener('change', () => task(async () => {
  const client = state.clients.find((entry) => entry.id === $('client-select').value); if (client) await chooseClient(client);
}).finally(renderClients));
$('period-select').addEventListener('change', () => {
  const selected = $('period-select').value; if (!selected || selected === state.period || !state.clientId) return;
  task(async () => {
    state.period = selected; $('assistant-answer').hidden = true; await loadWorkspace();
  }, 'Открыт выбранный месяц. Сохранённые данные не изменены.').finally(() => { $('period-select').value = state.period; });
});
$('calculate').addEventListener('click', () => task(async () => {
  await api(clientUrl('/calculate'), { method: 'POST', body: JSON.stringify({ period: state.period }) }); await loadWorkspace();
}, 'Расчёт сохранён. Проверьте вопросы и исходные строки.'));
$('upload-source').addEventListener('change', renderReplacementOptions);
let uploadPreview = [];
function resetUploadPreview(){uploadPreview=[];$('upload-preview').replaceChildren();$('upload-confirm').hidden=true;}
$('upload-file').addEventListener('change',resetUploadPreview);
$('upload-source').addEventListener('change',resetUploadPreview);
$('upload-account').addEventListener('input',resetUploadPreview);
$('upload-replacement').addEventListener('change',resetUploadPreview);
$('upload-form').addEventListener('submit', event => {
  event.preventDefault(); if(!state.clientId)return;
  task(async()=>{
    resetUploadPreview();
    const files=[...$('upload-file').files];if(!files.length)throw new Error('Выберите файлы комплекта.');
    if(files.length>20)throw new Error('За один раз можно проверить до 20 файлов.');
    const replacement=$('upload-replacement').value;
    if(replacement&&files.length!==1)throw new Error('Исправленный документ заменяется отдельно. Выберите один файл.');
    const proposals=[];
    for(const file of files){
      const form=new FormData();form.set('file',file);form.set('source',$('upload-source').value);if((await file.slice(0,128).text()).trim().startsWith('['))form.set('account_id',$('upload-account').value.trim());
      const proposal=await api(clientUrl('/files/preview'),{method:'POST',body:form});
      proposals.push({file,proposal,replacement});
    }
    uploadPreview=proposals;
    const node=$('upload-preview');
    for(const {file,proposal} of proposals){const item=el('article','notice info');item.append(el('strong','',file.name),el('p','',`${proposal.source==='bank'?'Банк':'Маркетплейс'} · ${proposal.adapter} · ${proposal.events.length} операций · ${(proposal.periods||[]).map(periodTitle).join(', ')||'Период не определён'}`));
      if(proposal.account_id)item.append(el('p','micro',`Кабинет / счёт: ${proposal.account_id}`));
      for(const warning of proposal.warnings||[])item.append(el('p','',typeof warning==='string'?warning:warning.message||String(warning)));
      const details=el('details'),summary=el('summary','','Первые строки распознанного документа');details.append(summary);
      details.append(table(['Дата','Операция','Сумма'],proposal.events.slice(0,10).map(row=>[date(row.date),kinds[row.kind]||row.kind,{text:money(row.amount),className:'money'}])));item.append(details);node.append(item);
    }
    $('upload-confirm').hidden=false;notify('Комплект распознан. Проверьте сведения и подтвердите загрузку. Данные пока не изменены.');
  });
});
$('upload-confirm').addEventListener('click',()=>task(async()=>{
  if(!uploadPreview.length)throw new Error('Сначала проверьте комплект.');
  const batch=uploadPreview.slice(),results=[];
  for(const {file,proposal,replacement} of batch){
    const form=new FormData();form.set('file',file);form.set('source',proposal.source);if(proposal.account_id)form.set('account_id',proposal.account_id);if(replacement)form.set('replaces_file_id',replacement);
    try{const response=await api(clientUrl('/files'),{method:'POST',body:form});results.push(`${file.name}: ${response.duplicate?'уже загружен':`${response.imported_count} операций`}`);}
    catch(error){await loadWorkspace();throw new Error(`${results.length?`Сохранено файлов: ${results.length}. `:''}${file.name}: ${error.message} Остальные файлы не загружены; повторная проверка комплекта безопасна.`);}
  }
  await api(clientUrl('/calculate'),{method:'POST',body:JSON.stringify({period:state.period})});
  resetUploadPreview();$('upload-file').value='';await loadWorkspace();showView('review');
  notify(`Файлы загружены, черновик пересчитан. ${results.join('; ')}`);
}));
$('event-search').addEventListener('input', renderEvents); $('event-filter').addEventListener('change', renderEvents);
$('profile-period').addEventListener('change', () => {
  if (state.editingClient && $('profile-period').value !== state.editingClient.period) {
    $('profile-opening').value = ''; $('profile-ytd').value = ''; $('profile-complete').checked = false;
  }
});
$('profile-regime').addEventListener('change', () => {
  const regime = $('profile-regime').value;
  $('profile-rate').value = state.taxRules?.regimes?.[regime]?.default_rate || '';
});
$('profile-form').addEventListener('submit', (event) => {
  event.preventDefault();
  task(async () => {
    const data = new FormData($('profile-form')); const profile = {};
    for (const key of ['name', 'inn', 'marketplace', 'region', 'period', 'vat_status', 'vat_effective_from']) profile[key] = String(data.get(key) || '').trim();
    if (!profile.name) throw new Error('Укажите название клиента.');
    profile.usn_rate = decimal(data.get('usn_rate'), 'Ставка УСН');
    profile.tax_regime = String(data.get('tax_regime') || 'income');
    profile.has_employees = data.get('has_employees') === '' ? null : data.get('has_employees') === 'true';
    const maxRate = state.taxRules?.regimes?.[profile.tax_regime]?.max_rate;
    if (maxRate === undefined || Number(profile.usn_rate) < 0 || Number(profile.usn_rate) > Number(maxRate)) throw new Error('Ставка УСН превышает предел выбранного режима или справочник правил недоступен.');
    for (const key of ['prior_year_income', 'ytd_income_before_period']) profile[key] = decimal(data.get(key), key === 'prior_year_income' ? 'Доход предыдущего года' : 'Доход с начала года', true);
    profile.opening_balance = decimal(data.get('opening_balance'), 'Начальный остаток', true, true);
    profile.income_data_complete = data.has('income_data_complete');
    if (state.editingClient) { profile._data_revision = state.editingClient._data_revision; for(const key of ['region','tax_regime','usn_rate','has_employees','vat_status','vat_effective_from','prior_year_income'])delete profile[key]; }
    const saved = await api(state.editingClient ? `/api/clients/${encodeURIComponent(state.editingClient.id)}` : '/api/clients', { method: state.editingClient ? 'PATCH' : 'POST', body: JSON.stringify(profile) });
    state.clients = await api('/api/clients'); await chooseClient(saved); $('profile-dialog').close(); showView('documents');
  }, 'Профиль сохранён. Проверьте расчёт на актуальных данных.');
});
$('event-form').addEventListener('submit', (event) => {
  event.preventDefault(); if (!state.editingEvent) return;
  task(async () => {
    const data = new FormData($('event-form')); const payload = {};
    for (const key of ['kind', 'tax_date', 'settlement_id', 'related_id', 'note', 'reviewer', 'reason']) payload[key] = String(data.get(key) || '').trim();
    if (!payload.reviewer || !payload.reason) throw new Error('Укажите специалиста и основание исправления.');
    payload.tax_date ||= null; payload.settlement_id ||= null; payload.related_id ||= null;
    const changes = Object.fromEntries(['kind', 'tax_date', 'settlement_id', 'related_id', 'note'].filter(key => payload[key] !== (state.editingEvent[key] ?? (key === 'note' ? '' : null))).map(key => [key, payload[key]]));
    if (!Object.keys(changes).length) throw new Error('В операции нет изменённых полей.');
    try {
      await api(clientUrl(`/events/${encodeURIComponent(state.editingEvent.id)}`), { method: 'PATCH', body: JSON.stringify({expected_version: state.editingEvent.version, changes, reviewer: payload.reviewer, reason: payload.reason}) });
    } catch (error) {
      if (error.status === 409 && error.current) {
        const current = error.current; const box = clear('event-conflict'); box.hidden = false;
        box.append(el('strong', '', 'Операцию уже изменили. Ваша правка ещё не сохранена.'));
        const labels = {kind:'Тип',tax_date:'Дата дохода',settlement_id:'Выплата',related_id:'Связанная продажа',note:'Пояснение'};
        for (const key of Object.keys(labels)) if (current[key] !== state.editingEvent[key] || Object.hasOwn(changes,key)) {
          box.append(el('p', '', `${labels[key]}: сейчас «${current[key] ?? 'не указано'}»${Object.hasOwn(changes,key) ? `; ваша правка «${changes[key] ?? 'не указано'}»` : '; это поле вы не меняли'}.`));
        }
        const retry = el('button', 'button secondary', 'Сверено — перенести мою правку в новую версию'); retry.type = 'button';
        retry.addEventListener('click', () => { state.editingEvent = current; for (const key of Object.keys(labels)) $('event-form').elements.namedItem(key).value = (Object.hasOwn(changes,key) ? changes[key] : current[key]) ?? ''; box.replaceChildren(el('p','','Правка подготовлена на новой версии. Проверьте форму и нажмите «Сохранить исправление».')); });
        box.append(retry);
      }
      throw error;
    }
    state.reviewer = payload.reviewer; $('reviewer-name').value = payload.reviewer;
    await api(clientUrl('/calculate'), {method:'POST', body:JSON.stringify({period:state.period})});
    await loadWorkspace(); $('event-dialog').close();
  }, 'Исправление сохранено с автором и основанием. Черновик пересчитан.');
});
$('review-form').addEventListener('submit', (event) => {
  event.preventDefault(); const action = event.submitter?.value || 'review'; const result = state.workspace?.result; if (!result) return;
  task(async () => {
    const reviewer = $('reviewer-name').value.trim(); if (!reviewer) throw new Error('Укажите проверившего специалиста.');
    await api(clientUrl('/review'), { method: 'POST', body: JSON.stringify({ result_id: result.id, reviewer, comment: $('review-comment').value.trim(), action }) });
    state.reviewer = reviewer; await loadWorkspace();
  }, action === 'approve' ? 'Текущая версия черновика утверждена.' : 'Проверка текущей версии записана в историю.');
});
document.querySelectorAll('[data-export]').forEach((button) => button.addEventListener('click', () => exportFile(button.dataset.export)));
$('assistant-form').addEventListener('submit', (event) => { event.preventDefault(); const question = $('assistant-question').value.trim(); if (question) askAssistant(question); });
document.querySelectorAll('[data-question]').forEach((button) => button.addEventListener('click', () => { $('assistant-question').value = button.dataset.question; askAssistant(button.dataset.question); }));

async function loadApplication() {
    const selectedRoute = new URLSearchParams(location.hash.slice(1));
    const [status, clients, scenarios, taxRules] = await Promise.all([api('/api/status'), api('/api/clients'), api('/api/demo-scenarios'), api('/api/tax-rules')]); state.status = status; state.clients = clients; state.scenarios = scenarios; state.taxRules = taxRules;
    $('connection-status').textContent = status.mode === 'browser_demo' ? 'Учебная версия' : status.mode === 'shared' ? 'Кабинет команды' : 'Локальный стенд'; $('connection-status').className = 'badge good';
    if (status.ai?.enabled) { $('assistant-mode').textContent = `Модель: ${status.ai.provider || 'подключена'}`; $('assistant-notice').textContent = 'Ответы модели требуют проверки бухгалтером. Расчёты выполняет отдельный модуль, исходники остаются доступны.'; }
    if (Object.hasOwn(viewText, selectedRoute.get('view'))) state.view = selectedRoute.get('view');
    if (clients.length) await chooseClient(clients.find(client => client.id === selectedRoute.get('client')) || clients.find(client => !isLegacyDemo(client)) || clients[0]); else render();
}
$('login-form').addEventListener('submit', event => {
  event.preventDefault();
  task(async () => {
    const session = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: $('login-username').value.trim(), password: $('login-password').value }) });
    applySession(session); $('notification').hidden = true; await loadApplication();
  });
});
$('logout-button').addEventListener('click', () => task(async () => {
  await api('/api/auth/logout', { method: 'POST', body: JSON.stringify({}) }); showLogin();
}));
$('refresh-button').addEventListener('click', () => task(async () => {
  state.clients = await api('/api/clients');
  if (state.clientId) await loadWorkspace(); else if (state.clients.length) await chooseClient(state.clients[0]); else render();
}, window.AccountingPlusDemo ? 'Показаны данные, сохранённые в этом браузере.' : 'Данные обновлены. Показаны последние изменения команды.'));
async function initialize() {
  await task(async () => {
    let session;
    try { session = await api('/api/auth/me'); }
    catch (error) {
      if (error.status === 401) { $('login-error').hidden = true; $('notification').hidden = true; return; }
      throw error;
    }
    applySession(session); $('notification').hidden = true; await loadApplication();
  });
  if (!$('login-screen').hidden) return;
  if (!state.status) { $('connection-status').textContent = window.AccountingPlusDemo ? 'Учебная версия не открылась' : 'Нет связи с сервером'; $('connection-status').className = 'badge danger'; render(); }
}
window.AccountingPlusFinance?.mount({ api, task, getState: () => state,
  refresh: async () => { state.clients = await api('/api/clients'); await loadWorkspace(); },
  chooseClient: async client => { state.clients = await api('/api/clients'); await chooseClient(client); showView('finance'); }
});
initialize();
