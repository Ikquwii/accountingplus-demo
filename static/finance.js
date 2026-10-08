/* Annual finance workspace. The server or demo runtime owns the fiscal rules. */
(() => {
  'use strict';
  const PERIODS = [{id:'q1',label:'I квартал',range:'январь–март'},{id:'h1',label:'Полугодие',range:'январь–июнь'},{id:'m9',label:'9 месяцев',range:'январь–сентябрь'},{id:'year',label:'Год',range:'январь–декабрь'}];
  const PAYMENT_LABELS = {usn:'Налог УСН',fixed:'Фиксированные взносы',additional:'Дополнительные взносы 1%',ens_topup:'Пополнение ЕНС'};
  const AMOUNT_LABELS = {income_override:'полный доход',outside_income:'другие доходы',tax_expenses:'налоговые расходы',management_expenses:'управленческие расходы',prior_advances:'ранее начисленные авансы',previous_deduction:'ранее использованные взносы'};
  let hooks, section, active=false, busy=false, loading=false, year=2026, period='year', data=null, contextKey='', requestNumber=0, dirty=false, draftPayments=[];
  const caches=new Map();
  const $=id=>section.querySelector(`#${id}`);
  const clone=value=>JSON.parse(JSON.stringify(value));
  const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const state=()=>hooks.getState();
  const profile=()=>state().workspace?.client||state().clients?.find(client=>client.id===state().clientId)||{};
  const key=()=>`${state().clientId||''}:${year}`;
  const sourceKey=()=>JSON.stringify([key(),state().workspace?.data_revision??profile()._data_revision??null,state().workspace?.result?.id??null,profile().tax_regime,profile().usn_rate,profile().has_employees]);
  const viewer=()=>state().user?.role==='viewer';
  const money=value=>{
    if(value===null||value===undefined||value==='')return 'Нужно уточнить';
    const match=String(value).match(/^(-?)(\d+)(?:\.(\d+))?$/);if(!match)return 'Нужно уточнить';
    const units=match[2].replace(/\B(?=(\d{3})+(?!\d))/g,'\u00a0');return `${match[1]}${units},${(match[3]||'').padEnd(2,'0').slice(0,2)}\u00a0₽`;
  };
  const cents=value=>{if(value==null)return null;const match=String(value).match(/^(-?)(\d+)(?:\.(\d{1,2}))?$/);return match?BigInt(match[1]+'1')*(BigInt(match[2])*100n+BigInt((match[3]||'').padEnd(2,'0'))):null;};
  const sum=(a,b)=>{const x=cents(a),y=cents(b);if(x===null||y===null)return null;const total=x+y,absolute=total<0n?-total:total;return `${total<0n?'-':''}${absolute/100n}.${String(absolute%100n).padStart(2,'0')}`;};
  const hasPositive=value=>{const amount=cents(value);return amount!==null&&amount>0n;};
  function control(id,label,type='text',value='',options={}){
    const attrs=options.attrs||'';const help=options.help?`<p class="finance-field-help">${esc(options.help)}</p>`:'';
    const input=type==='textarea'?`<textarea id="${id}" ${attrs}>${esc(value)}</textarea>`:`<input id="${id}" type="${type}" value="${esc(value)}" ${attrs}>`;
    return `<div class="field ${options.className||''}"><label for="${id}">${esc(label)}</label>${input}${help}</div>`;
  }
  function select(id,label,choices,value,help=''){
    return `<div class="field"><label for="${id}">${esc(label)}</label><select id="${id}">${choices.map(([v,text])=>`<option value="${esc(v)}" ${String(value??'')===v?'selected':''}>${esc(text)}</option>`).join('')}</select>${help?`<p class="finance-field-help">${esc(help)}</p>`:''}</div>`;
  }
  const check=(id,label,checked=false)=>`<label class="finance-check"><input id="${id}" type="checkbox" ${checked?'checked':''}><span>${esc(label)}</span></label>`;
  function reviewerName(){return state().user?.display_name||state().reviewer||'';}
  function shell(){
    section.innerHTML=`<div class="finance-toolbar"><div><h2>Финансовый результат</h2><p>Доход, прибыль и обязательства ИП за выбранный год.</p></div><div class="finance-period-controls">${control('finance-year','Год','number',year,{attrs:'min="2000" max="2099" inputmode="numeric"'})}${select('finance-period','Накопительный период',PERIODS.map(item=>[item.id,item.label]),period)}</div></div>
      <div id="finance-error" class="notice danger finance-error" role="alert" hidden><span id="finance-error-text"></span><button class="text-button" id="finance-retry" type="button">Повторить загрузку</button></div>
      <div id="finance-loading" class="finance-skeleton" role="status" hidden><span>Загружаем годовой черновик…</span><div></div><div></div></div>
      <div id="finance-empty" class="panel finance-empty" hidden><h3>Выберите клиента или учебную ситуацию</h3><p>Для годового расчёта нужны доходы, расходы и подтверждённое правило учёта взносов.</p></div>
      <div id="finance-body" hidden><div id="finance-results"></div><div id="finance-tax-detail" class="finance-tax-detail"></div><details id="finance-issues" class="finance-issues"><summary>Что нужно уточнить <span id="finance-issue-count"></span></summary><div id="finance-issue-list"></div></details>
      <div class="panel finance-ytd"><div class="panel-heading"><h3>Как меняется расчёт в течение года</h3><span class="micro">Нарастающим итогом</span></div><p class="finance-field-help">Каждая строка включает месяцы с января. Доходы и взносы по строкам не складываются.</p><div id="finance-ytd-table"></div></div>
      <div class="panel finance-obligations"><div class="panel-heading"><h3>Начисления и оплаты</h3><span class="badge neutral">Отдельно от авансов</span></div><div id="finance-obligations-table"></div><p class="finance-field-help">Отрицательный остаток означает возможную переплату. Пополнение ЕНС само по себе не подтверждает уплату конкретного налога или взноса.</p></div>
      <form id="finance-form"><details id="finance-editor" class="finance-editor"><summary><span><strong>Данные и правила расчёта</strong><span class="micro">Доходы, расходы, режим УСН и признание взносов</span></span><span aria-hidden="true">+</span></summary><div class="finance-editor-body"><div id="finance-policy-fields"></div><div id="finance-period-fields"></div></div></details>
      <details id="finance-payments" class="finance-editor"><summary><span><strong>Оплаты и пополнения ЕНС</strong><span id="finance-payment-count" class="micro"></span></span><span aria-hidden="true">+</span></summary><div class="finance-editor-body"><div id="finance-payments-table"></div><div id="finance-payment-entry" class="finance-payment-entry"><h3>Добавить запись об оплате</h3><p class="finance-field-help">Сначала добавьте запись в черновик. Затем сохраните все изменения с основанием.</p><div class="finance-form-grid">${select('finance-payment-kind','Назначение',Object.entries(PAYMENT_LABELS),'usn')}${control('finance-payment-date','Дата оплаты','date','')}${control('finance-payment-amount','Сумма, ₽','text','',{attrs:'inputmode="decimal" placeholder="Например, 10000"'})}${control('finance-payment-year','Год обязательства','number',year,{attrs:'min="2000" max="2099"'})}${control('finance-payment-source','Источник подтверждения','text','',{attrs:'maxlength="1000" placeholder="Выписка / справка о принадлежности сумм"',className:'finance-full'})}${control('finance-payment-note','Комментарий','text','',{attrs:'maxlength="2000"',className:'finance-full'})}</div>${check('finance-payment-confirmed','Оплата и назначение подтверждены по источнику')}<button id="finance-add-payment" class="button secondary" type="button" data-finance-write>Добавить в черновик</button></div></div></details>
      <div id="finance-dirty" class="finance-dirty" role="status" hidden>Есть несохранённые изменения. Показанные суммы относятся к сохранённой версии.</div><div id="finance-savebar" class="finance-savebar"><div class="finance-form-grid">${control('finance-reviewer','Проверяющий специалист','text',reviewerName(),{attrs:'maxlength="100" required'})}${control('finance-reason','Основание изменения','text','',{attrs:'maxlength="2000" required placeholder="Какие сведения проверены или уточнены"'})}</div><button id="finance-save" class="button primary" type="submit" data-finance-write>Сохранить и пересчитать</button><p id="finance-save-help" class="finance-field-help">Сохраняются все введённые данные года и история изменения. Это черновик, а не отправка отчётности.</p></div></form>
      <div class="finance-export"><div><strong>Годовой черновик</strong><p class="micro">Для проверки бухгалтером. Уведомления и декларации не отправляются.</p></div><div><button id="finance-export-csv" class="button secondary" type="button">CSV расчёта</button><button id="finance-export-report" class="button secondary" type="button">Пояснение</button></div></div></div>
      <details class="finance-demo"><summary>Посмотреть на учебных данных</summary><p>Три отдельные вымышленные ситуации. Текущий клиент сохраняется; примеры не устанавливают его правила учёта.</p><div><button class="button secondary" type="button" data-finance-demo="income_5m" data-finance-write>5 млн дохода · УСН 6%</button><button class="button secondary" type="button" data-finance-demo="income_500k" data-finance-write>500 тыс. · налог и взносы</button><button class="button secondary" type="button" data-finance-demo="expenses_min" data-finance-write>Доходы − расходы · минимум</button></div></details>`;
  }
  function mount(options){
    if(hooks)return;hooks=options;section=document.getElementById('finance-section');if(!section)throw new Error('Не найден раздел финансов для подключения компонента.');
    year=Number(String(state().period||'2026-09').slice(0,4))||2026;shell();
    section.addEventListener('input',onInput);section.addEventListener('change',onChange);section.addEventListener('click',onClick);$('finance-form').addEventListener('submit',event=>{event.preventDefault();save();});setBusy(false);
  }
  function showError(error){$('finance-error-text').textContent=error.message||String(error);$('finance-error').hidden=false;}
  function clearError(){$('finance-error').hidden=true;$('finance-error-text').textContent='';}
  function capture(){
    if(!data||!contextKey)return;const values={};$('finance-form').querySelectorAll('input,select,textarea').forEach(input=>{values[input.id]=input.type==='checkbox'?input.checked:input.value;});
    caches.set(contextKey,{data,values,dirty,payments:clone(draftPayments)});
  }
  function restoreValues(values){for(const[id,value]of Object.entries(values||{})){const input=$(id);if(!input)continue;if(input.type==='checkbox')input.checked=Boolean(value);else input.value=value??'';}}
  async function load(force=false){
    if(!active||!hooks)return;const clientId=state().clientId;const nextKey=key(),nextSource=sourceKey();
    if(!clientId){requestNumber++;loading=false;data=null;$('finance-body').hidden=true;$('finance-empty').hidden=false;$('finance-loading').hidden=true;setBusy(busy);return;}
    if(!force&&contextKey===nextKey&&section.dataset.sourceKey===nextSource&&data)return;
    if(!force&&loading&&section.dataset.pendingSource===nextSource)return;
    if(contextKey&&contextKey!==nextKey)capture();
    const number=++requestNumber;loading=true;section.dataset.pendingSource=nextSource;clearError();$('finance-loading').hidden=false;$('finance-empty').hidden=true;
    if(contextKey!==nextKey){data=null;$('finance-body').hidden=true;dirty=false;}
    setBusy(busy);
    try{
      const response=await hooks.api(`/api/clients/${encodeURIComponent(clientId)}/finance?year=${year}`);
      if(number!==requestNumber||!active||key()!==nextKey||sourceKey()!==nextSource)return;
      if(!response?.ledger||!response?.result||!Array.isArray(response.result.periods))throw new Error('Годовой расчёт вернул неполные данные. Обновите кабинет.');
      const cached=caches.get(nextKey);contextKey=nextKey;section.dataset.sourceKey=nextSource;
      if(cached?.dirty){data=cached.data;dirty=true;draftPayments=clone(cached.payments);buildEditor();restoreValues(cached.values);if(response.revision!==data.revision||response.client_revision!==data.client_revision)showError(new Error('Сохранённая версия изменилась. Ваши введённые данные оставлены в форме. Сверьте их с новой версией перед сохранением.'));}
      else{data=response;dirty=false;draftPayments=clone(response.ledger.payments||[]);buildEditor();}
      $('finance-body').hidden=false;renderResults();renderPayments();updateDirty();
    }catch(error){
      if(number!==requestNumber||!active||key()!==nextKey)return;showError(error);
    }finally{
      if(number===requestNumber){loading=false;$('finance-loading').hidden=true;setBusy(busy);}
    }
  }
  function render(){if(!hooks)return;load();}
  function activate(value){if(!hooks)return;active=Boolean(value);if(!active){capture();requestNumber++;loading=false;$('finance-loading').hidden=true;return;}load(true);}
  function setBusy(value){
    busy=Boolean(value);if(!section)return;const locked=busy||loading;section.querySelectorAll('input,select,textarea').forEach(input=>{input.disabled=locked||viewer();});
    section.querySelectorAll('[data-finance-write]').forEach(button=>{button.disabled=locked||viewer();});
    for(const id of['finance-year','finance-period'])$(id).disabled=locked;
    $('finance-retry').disabled=busy;
    for(const id of['finance-export-csv','finance-export-report'])$(id).disabled=locked||dirty||!data;
    $('finance-save').disabled=locked||viewer()||!dirty;
    $('finance-reviewer').readOnly=Boolean(state().user);
    $('finance-save-help').textContent=viewer()?'У вас доступ для просмотра. Изменить данные может редактор команды.':'Сохраняются все введённые данные года и история изменения. Это черновик, а не отправка отчётности.';
  }
  function buildEditor(){
    const ledger=data.ledger,p=profile();
    $('finance-policy-fields').innerHTML=`<h3>Режим УСН и взносы</h3><div class="finance-form-grid">${select('finance-regime','Объект УСН',[['income','Доходы'],['income_expenses','Доходы минус расходы']],data.result.regime||p.tax_regime||'income')}${control('finance-rate','Ставка УСН, %','text',data.result.rate??p.usn_rate??'',{attrs:'inputmode="decimal" required',help:'Подтвердите ставку для режима и региона. Она не меняется автоматически при смене объекта.'})}${select('finance-employees','Есть работники?',[['','Не подтверждено'],['false','Нет'],['true','Да']],p.has_employees===true?'true':p.has_employees===false?'false':'')}${select('finance-policy','Признание собственных взносов',[['unconfirmed','Правило не выбрано'],['accrued','Подлежащие уплате'],['paid','Фактически уплаченные']],ledger.policy,'Выбор требует подтверждения бухгалтером. Начисление и уплата показаны отдельно.')}</div>${check('finance-policy-confirmed','Правило признания взносов согласовано и подтверждено',ledger.policy_confirmed)}<div class="finance-form-grid finance-policy-extra">${select('finance-additional-recognition',`Дополнительный 1% за ${year} год`,[['unconfirmed','Год признания не выбран'],['current',`Учесть в ${year} году`],['next',`Учесть в ${year+1} году`]],ledger.additional_recognition,'Один и тот же взнос признаётся однократно.')}${select('finance-full-year','ИП действовал весь год?',[['','Не подтверждено'],['true','Да, весь год'],['false','Нет, нужен отдельный расчёт']],ledger.full_year_activity===true?'true':ledger.full_year_activity===false?'false':'')}${control('finance-fixed-override','Фиксированные взносы в особом случае, ₽','text',ledger.fixed_override,{attrs:'inputmode="decimal"',help:'Для неполного года или подтверждённого исключения. Пустое поле не означает ноль.'})}${control('finance-fixed-reason','Основание особой суммы','text',ledger.fixed_override_reason,{attrs:'maxlength="2000"'})}</div><details class="finance-previous"><summary>Остаток дополнительного 1% за ${year-1} год</summary><div class="finance-form-grid">${control('finance-prior-additional','Начислено за предыдущий год, ₽','text',ledger.prior_additional_amount,{attrs:'inputmode="decimal"'})}${control('finance-prior-used','Уже использовано в прошлых периодах, ₽','text',ledger.prior_additional_used,{attrs:'inputmode="decimal"'})}</div>${check('finance-prior-confirmed','Прошлогодняя сумма и использованный остаток подтверждены',ledger.prior_additional_confirmed)}</details>`;
    $('finance-period-fields').innerHTML=`<div class="finance-period-intro"><h3>Данные нарастающим итогом</h3><p>За полугодие вводите январь–июнь, за год — январь–декабрь. Пустая сумма означает «неизвестно».</p></div>${PERIODS.map(item=>periodEditor(item,(ledger.periods||[]).find(row=>row.period===item.id)||{})).join('')}`;
    $('finance-reviewer').value=reviewerName();$('finance-reason').value='';updateRegime();
  }
  function periodEditor(item,row){
    const imported=(data.source_totals||[]).find(total=>total.period===item.id)||{};
    const id=name=>`finance-${item.id}-${name}`;const amount=(name,label,help='',className='')=>control(id(name),label,'text',row[name],{attrs:'inputmode="decimal"',help,className});
    return `<details class="finance-period-editor" data-period-editor="${item.id}"><summary><strong>${item.label}</strong><span>${item.range}</span></summary><div class="finance-period-editor-body"><p class="finance-imported">Из документов маркетплейса: доход для УСН ${money(imported.marketplace_income)}, известные удержания ${money(imported.marketplace_costs)}.</p><div class="finance-form-grid">${amount('income_override','Полный доход для УСН, ₽','Если заполнено, заменяет доход маркетплейса и другие доходы целиком. Не вводите только выплату в банк.')}${amount('outside_income','Другие доходы вне маркетплейса, ₽','Добавляются только если полный доход выше не задан. Подтверждённое отсутствие: введите 0.')}${amount('management_expenses','Все управленческие расходы, ₽','Все затраты бизнеса без собственного УСН и взносов ИП. Комиссии и логистика уже включены: повторно их не вычитайте.')}${amount('tax_expenses','Признанные налоговые расходы без своих взносов, ₽','Без собственных взносов ИП: они учитываются отдельно. Для УСН «Доходы минус расходы» нужны подтверждённые условия признания; списание банка само по себе их не доказывает.','finance-tax-only')}${amount('prior_advances','Ранее начисленные авансы УСН, ₽','Начисленные за предыдущие отчётные периоды этого года, независимо от оплаты.')}${amount('previous_deduction','Уже использовано взносов в предыдущих периодах, ₽','По проверенной истории уменьшений. Не вычитайте одну и ту же сумму дважды.')}</div><div class="finance-confirmations">${check(id('income_confirmed'),'Полнота доходов и даты признания проверены',row.income_confirmed)}<div class="finance-tax-only">${check(id('expenses_confirmed'),'Расходы и условия признания подтверждены',row.expenses_confirmed)}</div></div><div class="finance-form-grid">${control(id('income_note'),'Пояснение к доходам','textarea',row.income_note,{attrs:'rows="2" maxlength="2000"'})}${control(id('expense_note'),'Пояснение к расходам','textarea',row.expense_note,{attrs:'rows="2" maxlength="2000"'})}</div></div></details>`;
  }
  function updateRegime(){const expenses=$('finance-regime')?.value==='income_expenses';section.querySelectorAll('.finance-tax-only').forEach(node=>{node.hidden=!expenses;});}
  function chosenResult(){return data?.result?.periods.find(row=>row.period===period);}
  function table(headers,rows){return `<div class="table-scroll"><table><thead><tr>${headers.map((header,index)=>`<th class="${index?'money':''}">${esc(header)}</th>`).join('')}</tr></thead><tbody>${rows.map(cells=>`<tr>${cells.map((cell,index)=>`<td class="${index?'money':''}">${cell}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;}
  function renderResults(){
    if(!data)return;const result=chosenResult();if(!result){showError(new Error('Нет расчёта выбранного периода.'));return;}
    const expenseComplete=result.management_expenses_complete!==false&&result.management_expenses!=null;
    const decrease=result.ready&&hasPositive(result.advance_to_decrease);const tax=result.ready?(decrease?result.advance_to_decrease:result.advance_to_pay):null;
    const cards=[['income','Доход для УСН',result.income,'Полный доход по подтверждённым датам признания'],['expenses',expenseComplete?'Управленческие расходы':'Известные расходы',result.management_expenses,expenseComplete?'Полная введённая сумма расходов':'Показаны известные удержания; расходы неполны'],['profit',expenseComplete?'Прибыль до налогов':'Прибыль по известным данным',result.profit_before_tax,'Управленческий результат, отдельно от базы УСН'],['tax',decrease?'Начисление к уменьшению':period==='year'?'Налог к доплате':'Аванс к доплате',tax,decrease?'Уменьшение ранее начисленных авансов':result.ready?'За вычетом ранее начисленных авансов':'Подтвердите данные и правило учёта взносов']];
    $('finance-results').innerHTML=`<div class="finance-result-heading"><span class="badge ${result.ready?'good':'warning'}">${result.ready?'Расчёт готов к проверке':'Есть неподтверждённые данные'}</span><span class="micro">${esc(PERIODS.find(item=>item.id===period).label)} ${year} · ${data.result.regime==='income_expenses'?'УСН «Доходы минус расходы»':'УСН «Доходы»'} ${esc(data.result.rate)}%</span></div><div class="finance-cards">${cards.map(([name,label,amount,note])=>`<article class="finance-card ${name==='tax'?'finance-card-tax':''}"><span>${esc(label)}</span><strong data-finance-metric="${name}" class="${amount==null?'finance-unknown':''}">${money(amount)}</strong><p>${esc(note)}</p>${name==='profit'?`<div class="finance-net"><span>После УСН и взносов · черновик</span><strong data-finance-metric="netprofit">${money(result.ready?result.profit_after_tax:null)}</strong></div>`:''}</article>`).join('')}</div>`;
    const dr=data.result.regime==='income_expenses';const appliedText=dr?'Взносы включены в признанные расходы':'Налог уменьшен на взносы';
    $('finance-tax-detail').innerHTML=`<div><h3>${dr?'Налоговая база и минимальный налог':'Как взносы уменьшают налог'}</h3><dl><div><dt>${dr?'Обычный налог по ставке':'Начислено до уменьшения'}</dt><dd>${money(result.tax_assessed)}</dd></div><div><dt>${appliedText}</dt><dd>${money(result.contribution_applied)}</dd></div>${dr?`<div><dt>${period==='year'?'Минимальный налог по итогам года':'Минимальный налог проверяется по итогам года'}</dt><dd>${period==='year'?money(result.minimum_tax):'—'}</dd></div>`:''}<div><dt>Налог после учёта взносов${dr?' и годового минимума':''}</dt><dd>${money(result.tax_after_reduction)}</dd></div><div><dt>Неиспользованные взносы</dt><dd>${money(result.unused_contribution)}</dd></div></dl><p>${dr?'Взносы уменьшают налоговую базу, а не налог рубль в рубль. Годовой налог сравнивается с минимумом 1% дохода.':'Вычет зависит от выбранного правила и наличия работников. Неиспользованные взносы не означают автоматический возврат.'}</p></div><div class="finance-source-note"><strong>Доход, прибыль и деньги в банке различаются</strong><p>Перечисление маркетплейса не заменяет полный доход для УСН. Налоговые расходы вводятся отдельно от управленческих.</p>${result.management_revenue!=null?`<p>Выручка для прибыли: ${money(result.management_revenue)}.</p>`:''}<p class="micro">Правила ${esc(data.result.rules_version||'не указаны')} · данные версии ${esc(data.revision)}</p></div>`;
    const issues=[...(data.result.issues||[]),...(result.issues||[])];const unique=issues.filter((issue,index,list)=>index===list.findIndex(other=>other.code===issue.code&&other.message===issue.message));
    $('finance-issue-count').textContent=unique.length?String(unique.length):'нет';$('finance-issue-list').innerHTML=unique.length?unique.map(issue=>`<div class="finance-issue"><span class="badge ${issue.severity==='blocking'?'warning':'neutral'}">${issue.severity==='blocking'?'Нужно уточнить':'Для проверки'}</span><p>${esc(issue.message||issue.code)}</p></div>`).join(''):'<p class="micro">Неподтверждённых данных не выявлено. Бухгалтер проверяет источники и результат.</p>';
    $('finance-issues').open=unique.some(issue=>issue.severity==='blocking');
    $('finance-ytd-table').innerHTML=table(['Период','Доход для УСН','Налог после взносов','Ранее начислено','К доплате','К уменьшению'],data.result.periods.map(row=>[`<strong>${esc(PERIODS.find(item=>item.id===row.period)?.label||row.label||row.period)}</strong>`,money(row.income),money(row.tax_after_reduction),money(row.prior_advances),row.ready?money(row.advance_to_pay):'Нужно уточнить',row.ready?money(row.advance_to_decrease):'Нужно уточнить']));
    $('finance-obligations-table').innerHTML=table(['Обязательство','Начислено','Подтверждено уплачено','Остаток'],[['УСН',money(result.tax_after_reduction),money(result.usn_paid),money(result.usn_balance)],['Собственные взносы ИП',money(sum(result.fixed_contribution,result.additional_contribution)),money(result.contributions_paid),money(result.contributions_balance)]]);
    updateDirty();
  }
  function renderPayments(){
    $('finance-payment-count').textContent=`${draftPayments.length} записей · включаются только подтверждённые назначения`;
    $('finance-payments-table').innerHTML=draftPayments.length?`<div class="table-scroll"><table><thead><tr><th>Назначение / источник</th><th>Дата</th><th>Год</th><th class="money">Сумма</th><th>Статус</th><th>Действие</th></tr></thead><tbody>${draftPayments.map(payment=>`<tr><td><strong>${esc(PAYMENT_LABELS[payment.kind]||payment.kind)}</strong><span class="cell-subtitle">${esc(payment.source||'Источник не указан')}</span>${payment.note?`<span class="cell-subtitle">${esc(payment.note)}</span>`:''}</td><td class="nowrap">${esc(payment.date)}</td><td>${esc(payment.liability_year)}</td><td class="money">${money(payment.amount)}</td><td><span class="badge ${payment.confirmed?'good':'warning'}">${payment.confirmed?'Подтверждено':'Не подтверждено'}</span>${payment.kind==='ens_topup'?'<span class="cell-subtitle">Не доказывает оплату конкретного обязательства</span>':''}</td><td><button class="text-button" type="button" data-finance-remove="${esc(payment.id)}" data-finance-write>Удалить</button></td></tr>`).join('')}</tbody></table></div>`:'<p class="empty-message">Записей об оплате пока нет. Начисление взносов и налога не означает, что они уже уплачены.</p>';setBusy(busy);
  }
  function updateDirty(){
    if(!section)return;$('finance-dirty').hidden=!dirty;section.classList.toggle('finance-stale',dirty);$('finance-savebar').hidden=viewer()||!dirty;
    const badge=section.querySelector('.finance-result-heading > .badge'),result=chosenResult();
    if(badge&&result){badge.textContent=dirty?'Суммы до ваших изменений':result.ready?'Расчёт готов к проверке':'Есть неподтверждённые данные';badge.className=`badge ${dirty||!result.ready?'warning':'good'}`;}
    setBusy(busy);
  }
  function markDirty(){dirty=true;capture();updateDirty();}
  function amount(id,label,signed=false){const raw=$(id).value.trim().replace(/[\s\u00a0]/g,'').replace(',','.');if(!raw)return null;if(!(signed?/^-?\d+(?:\.\d{1,2})?$/:/^\d+(?:\.\d{1,2})?$/).test(raw))throw new Error(`${label}: введите ${signed?'сумму':'неотрицательную сумму'} с максимум двумя знаками после запятой.`);return raw;}
  function collectLedger(){
    const original={},field=id=>$(id).value.trim(),flag=id=>$(id).checked;
    original.year=year;original.policy=field('finance-policy');original.policy_confirmed=flag('finance-policy-confirmed');original.additional_recognition=field('finance-additional-recognition');original.full_year_activity=field('finance-full-year')===''?null:field('finance-full-year')==='true';
    original.fixed_override=amount('finance-fixed-override','Фиксированные взносы');original.fixed_override_reason=field('finance-fixed-reason');original.prior_additional_amount=amount('finance-prior-additional','Прошлогодний 1%');original.prior_additional_used=amount('finance-prior-used','Использованный прошлогодний 1%');original.prior_additional_confirmed=flag('finance-prior-confirmed');
    original.periods=PERIODS.map(item=>{const row={period:item.id};for(const name of['income_override','outside_income','tax_expenses','management_expenses','prior_advances','previous_deduction'])row[name]=amount(`finance-${item.id}-${name}`,`${item.label}, ${AMOUNT_LABELS[name]}`,name==='income_override');for(const name of['income_confirmed','expenses_confirmed'])row[name]=flag(`finance-${item.id}-${name}`);for(const name of['income_note','expense_note'])row[name]=field(`finance-${item.id}-${name}`);return row;});
    original.payments=clone(draftPayments);return original;
  }
  function wantedProfile(){const employees=$('finance-employees').value;return{tax_regime:$('finance-regime').value,usn_rate:amount('finance-rate','Ставка УСН'),has_employees:employees===''?null:employees==='true'};}
  function profileChanged(wanted){const p=profile();return wanted.tax_regime!==(p.tax_regime||'income')||cents(wanted.usn_rate)!==cents(p.usn_rate)||wanted.has_employees!==(p.has_employees??null);}
  async function save(){
    if(viewer()||busy||loading||!dirty)return;
    await hooks.task(async()=>{
      clearError();const clientId=state().clientId,saveYear=year,saveKey=key(),ledger=collectLedger(),wanted=wantedProfile(),reviewer=$('finance-reviewer').value.trim(),reason=$('finance-reason').value.trim();
      if(!reviewer||!reason)throw new Error('Укажите проверяющего специалиста и основание изменения.');if(wanted.usn_rate==null)throw new Error('Подтвердите ставку УСН.');
      let revision=data.revision,clientRevision=data.client_revision,profileSaved=false;
      try{
        if(profileChanged(wanted)){
          const before=await hooks.api(`/api/clients/${encodeURIComponent(clientId)}/finance?year=${saveYear}`);
          if(before.revision!==revision||before.client_revision!==clientRevision)throw new Error('Версия клиента или годового черновика изменилась у коллеги. Обновите данные и сверьте введённые значения.');
          const savedProfile=await hooks.api(`/api/clients/${encodeURIComponent(clientId)}`,{method:'PATCH',body:JSON.stringify({...wanted,_data_revision:clientRevision})});profileSaved=true;
          const fresh=await hooks.api(`/api/clients/${encodeURIComponent(clientId)}/finance?year=${saveYear}`);
          if(fresh.revision!==revision||fresh.client_revision!==savedProfile?._data_revision)throw new Error('Годовой черновик или источники изменились в другой вкладке или у коллеги. Перезагрузите версию и сверьте введённые данные.');clientRevision=fresh.client_revision;
        }
        await hooks.api(`/api/clients/${encodeURIComponent(clientId)}/finance`,{method:'PUT',body:JSON.stringify({year:saveYear,revision,client_revision:clientRevision,ledger,reviewer,reason})});
        caches.delete(saveKey);if(key()===saveKey){dirty=false;data=null;section.dataset.sourceKey='';updateDirty();}
        await hooks.refresh();if(active&&key()===saveKey)await load(true);
      }catch(error){if(key()===saveKey)showError(new Error(`${profileSaved?'Профиль УСН обновлён, но годовые данные не сохранены. ':''}${error.message}`));throw error;}
    },'Годовые данные сохранены. Расчёт готов к проверке.');
  }
  async function addPayment(){
    if(viewer()||busy||loading)return;await hooks.task(async()=>{
      const payment={id:globalThis.crypto?.randomUUID?.()||`payment-${Date.now()}-${Math.random().toString(36).slice(2)}`,kind:$('finance-payment-kind').value,date:$('finance-payment-date').value,amount:amount('finance-payment-amount','Оплата'),liability_year:Number($('finance-payment-year').value),confirmed:$('finance-payment-confirmed').checked,source:$('finance-payment-source').value.trim(),note:$('finance-payment-note').value.trim()};
      if(!payment.date||payment.amount===null||!Number.isInteger(payment.liability_year)||payment.liability_year<2000||payment.liability_year>2099)throw new Error('Для оплаты укажите дату, сумму и год обязательства.');
      if(payment.confirmed&&!payment.source)throw new Error('Для подтверждённой оплаты укажите источник.');
      draftPayments.push(payment);for(const id of['finance-payment-date','finance-payment-amount','finance-payment-source','finance-payment-note'])$(id).value='';$('finance-payment-confirmed').checked=false;markDirty();renderPayments();
    },'Оплата добавлена в черновик. Сохраните изменения года.');
  }
  async function openDemo(scenario){
    if(viewer()||busy||loading)return;if(dirty&&!window.confirm('Есть несохранённые данные. Открыть отдельный учебный клиент? Введённые данные останутся в черновике текущего клиента.'))return;capture();
    await hooks.task(async()=>{const response=await hooks.api('/api/finance/demo',{method:'POST',body:JSON.stringify({scenario})});if(!response?.client)throw new Error('Учебная ситуация не вернула клиента.');year=Number(String(response.client.period||2026).slice(0,4));period='year';$('finance-year').value=year;$('finance-period').value=period;contextKey='';section.dataset.sourceKey='';await hooks.chooseClient(response.client);if(active)await load(true);},'Открыт отдельный учебный год. Все данные вымышлены.');
  }
  function onInput(event){const input=event.target;if(!input.closest('#finance-form')||input.id.startsWith('finance-payment-'))return;if(input.id==='finance-reason'||input.id==='finance-reviewer'){capture();return;}markDirty();}
  function onChange(event){const input=event.target;
    if(input.id==='finance-year'){
      const next=Number(input.value);if(!Number.isInteger(next)||next<2000||next>2099){input.value=year;showError(new Error('Введите год от 2000 до 2099.'));return;}if(next===year)return;capture();year=next;data=null;contextKey='';section.dataset.sourceKey='';load(true);return;
    }
    if(input.id==='finance-period'){period=input.value;renderResults();return;}
    if(input.closest('#finance-form')&&!input.id.startsWith('finance-payment-')){if(['finance-policy','finance-regime'].includes(input.id))$('finance-policy-confirmed').checked=false;markDirty();if(input.id==='finance-regime')updateRegime();}
  }
  function onClick(event){const button=event.target.closest('button');if(!button)return;
    if(button.id==='finance-retry'){if(dirty&&window.confirm('Загрузить сохранённую версию заново? Несохранённые изменения этого года будут заменены.')){caches.delete(key());dirty=false;}else if(dirty)return;load(true);}
    if(button.id==='finance-add-payment')addPayment();
    if(button.dataset.financeDemo)openDemo(button.dataset.financeDemo);
    if(button.dataset.financeRemove&&!viewer()&&!busy&&!loading){draftPayments=draftPayments.filter(payment=>payment.id!==button.dataset.financeRemove);markDirty();renderPayments();}
    if(button.id==='finance-export-csv')exportDraft('csv');if(button.id==='finance-export-report')exportDraft('report');
  }
  function csvCell(value){let text=String(value??'');if(/^[=+@\-\t\r]/.test(text))text="'"+text;return `"${text.replace(/"/g,'""')}"`;}
  function exportDraft(format){
    if(!data||dirty||busy||loading)return;const result=data.result;
    let content,type,extension;
    if(format==='csv'){
      const fields=['period','income','management_expenses','profit_before_tax','profit_after_tax','tax_expenses','fixed_contribution','additional_contribution','contribution_applied','tax_assessed','minimum_tax','tax_after_reduction','prior_advances','advance_to_pay','advance_to_decrease','usn_paid','usn_balance','contributions_paid','contributions_balance','ready'];
      const rows=[['Черновик для проверки бухгалтером. Не декларация и не уведомление.'],['Год',year,'Режим',result.regime,'Ставка',result.rate],fields,...result.periods.map(row=>fields.map(field=>!row.ready&&['advance_to_pay','advance_to_decrease','profit_after_tax'].includes(field)?'Не подтверждено':row[field]??'Не подтверждено'))];content='\uFEFF'+rows.map(row=>row.map(csvCell).join(';')).join('\r\n');type='text/csv;charset=utf-8';extension='csv';
    }else{
      content=`accountingPLUS — годовой черновик ${year}\nДля проверки бухгалтером. Не декларация и не уведомление.\nКлиент: ${profile().name||'ИП'}\nОбъект УСН: ${result.regime==='income_expenses'?'Доходы минус расходы':'Доходы'}, ставка ${result.rate}%\nПравила: ${result.rules_version||'не указаны'}\n\n`;
      for(const row of result.periods){content+=`${PERIODS.find(item=>item.id===row.period)?.label||row.period}\nДоход для УСН: ${money(row.income)}\nУправленческие расходы: ${money(row.management_expenses)}\nПрибыль до налогов: ${money(row.profit_before_tax)}\nПосле УСН и взносов (черновик): ${money(row.ready?row.profit_after_tax:null)}\nНалог после взносов: ${money(row.tax_after_reduction)}\nРанее начисленные авансы: ${money(row.prior_advances)}\nК доплате: ${row.ready?money(row.advance_to_pay):'Не подтверждено'}\nК уменьшению: ${row.ready?money(row.advance_to_decrease):'Не подтверждено'}\nУплачено УСН: ${money(row.usn_paid)}\nОстаток УСН: ${money(row.usn_balance)}\nОплачено взносов: ${money(row.contributions_paid)}\nОстаток взносов: ${money(row.contributions_balance)}\n${(row.issues||[]).map(issue=>`• ${issue.message||issue.code}`).join('\n')}\n\n`;}
      content+='Суммы периодов нарастающим итогом не складываются. Уплата и признание взносов различаются. Уведомления и декларации не отправлены.\n';type='text/plain;charset=utf-8';extension='txt';
    }
    const url=URL.createObjectURL(new Blob([content],{type})),link=document.createElement('a');link.href=url;link.download=`accountingplus-finance-${year}-draft.${extension}`;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  window.AccountingPlusFinance={mount,render,setBusy,activate};
})();
