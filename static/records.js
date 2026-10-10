/* Additional records complement source documents; no bank debit is inferred as an expense. */
(() => {
  'use strict';
  let hooks, root, data, context='', draft=[], months=[], dirty=false, busy=false, loading=false, sequence=0;
  const clone=value=>JSON.parse(JSON.stringify(value));
  const node=(tag,text,className='')=>{const el=document.createElement(tag);el.textContent=text??'';el.className=className;return el;};
  const $=id=>root.querySelector(`#${id}`);
  const url=()=>`/api/clients/${encodeURIComponent(hooks.client())}/records/${hooks.year()}`;
  function error(message){$('records-message').textContent=message;$('records-message').hidden=false;}
  function mount(options){
    hooks=options;root=options.root;
    root.innerHTML=`<details class="finance-editor" id="records-editor"><summary><span><strong>Документы и дополнительные операции</strong><span class="micro">Суммы по месяцам — автоматически, без повторного ввода удержаний</span></span></summary><div class="finance-editor-body">
      <p>Комиссии и логистика берутся из документов. Здесь добавляются только остальные операции. Списание банка само по себе не подтверждает расход.</p>
      <div id="records-message" class="notice warning" role="status" hidden></div>
      <label class="finance-check"><input type="checkbox" id="records-enabled"><span>Считать год из документов и этого реестра</span></label>
      <p class="micro" id="records-migration-note" hidden>В этом году есть ручные итоговые суммы. Для перехода они сохранятся в истории, а текущие итоги будут очищены. Дополнительные операции потребуется внести в реестр по документам.</p><button type="button" class="button secondary" id="records-migrate" hidden>Очистить ручные итоги и перейти к реестру</button><div id="records-list"></div>
      <div class="finance-form-grid">
        <div class="field"><label for="record-kind">Операция</label><select id="record-kind"><option value="expense">Дополнительный расход</option><option value="income">Доход вне маркетплейса</option></select></div>
        <div class="field"><label for="record-date">Дата операции</label><input type="date" id="record-date"></div>
        <div class="field"><label for="record-amount">Сумма, ₽</label><input id="record-amount" inputmode="decimal"></div>
        <div class="field"><label for="record-tax-date">Дата налогового признания, если подтверждена</label><input type="date" id="record-tax-date"></div>
        <div class="field finance-full"><label for="record-source">Основание · документ и строка</label><input id="record-source" maxlength="1000" placeholder="Акт №… от… / строка…"></div>
        <div class="field finance-full"><label for="record-note">Пояснение</label><input id="record-note" maxlength="2000"></div>
      </div><label class="finance-check"><input type="checkbox" id="record-confirmed"><span>Операция и её основание проверены</span></label>
      <button type="button" class="button secondary" id="record-add">Добавить в черновик реестра</button>
      <h3>Полнота месяца</h3><p class="micro">Подтверждение относится к полному комплекту, включая месяц без операций. Непроверенные месяцы не становятся нулевыми.</p>
      <div class="field"><label for="records-month">Месяц</label><select id="records-month"></select></div>
      <label class="finance-check"><input type="checkbox" id="records-income"><span>Все доходы месяца и даты их признания проверены</span></label>
      <label class="finance-check"><input type="checkbox" id="records-management"><span>Все управленческие расходы месяца внесены</span></label>
      <label class="finance-check"><input type="checkbox" id="records-tax"><span>Для УСН Д−Р: налоговое признание всех удержаний из документов в этом месяце проверено</span></label>
      <p class="micro" id="records-completeness"></p>
      <div class="finance-form-grid"><div class="field"><label for="records-reviewer">Проверяющий</label><input id="records-reviewer" maxlength="100"></div><div class="field"><label for="records-reason">Основание изменения</label><input id="records-reason" maxlength="2000"></div></div>
      <button type="button" class="button primary" id="records-save">Сохранить реестр и пересчитать</button>
      <button type="button" class="text-button" id="records-reload">Загрузить сохранённую версию</button>
      <p class="micro" id="records-dirty"></p>
    </div></details>`;
    $('record-add').addEventListener('click',add);
    $('records-save').addEventListener('click',save);$('records-migrate').addEventListener('click',migrate);
    $('records-reload').addEventListener('click',()=>{if(dirty&&!confirm('Заменить несохранённый реестр сохранённой версией?'))return;dirty=false;load(true);});
    $('records-month').addEventListener('change',showMonth);
    for(const id of ['records-income','records-management','records-tax'])$(id).addEventListener('change',()=>{const month=months.find(row=>row.month===$('records-month').value);if(!month)return;month.income_complete=$('records-income').checked;month.management_complete=$('records-management').checked;month.tax_complete=$('records-tax').checked;mark();});
    $('records-enabled').addEventListener('change',mark);
  }
  function mark(){dirty=true;update();}
  function update(){
    $('records-dirty').textContent=dirty?'Есть несохранённые изменения; расчёт ещё относится к сохранённой версии.':'';
    const disabled=busy||loading||hooks.viewer();root.querySelectorAll('input,select,button').forEach(el=>el.disabled=disabled);
    $('records-save').disabled=disabled||!dirty;$('records-reviewer').readOnly=Boolean(hooks.author());
    $('records-completeness').textContent=`Проверено месяцев: доходы ${months.filter(m=>m.income_complete).length}/12; расходы ${months.filter(m=>m.management_complete).length}/12; налоговые удержания ${months.filter(m=>m.tax_complete).length}/12.`;
  }
  function renderList(){
    const list=$('records-list');list.replaceChildren();
    if(!draft.length)list.append(node('p','Дополнительных операций пока нет. Подтвердите полноту нужных месяцев, если иных доходов и расходов не было.','micro'));
    for(const entry of draft){const row=node('div','','history-item');row.append(node('p',`${entry.date} · ${entry.kind==='income'?'Доход':'Расход'} · ${entry.amount} ₽ · ${entry.source}${entry.confirmed?'':' · не подтверждено'}`));const remove=node('button','Убрать из черновика','text-button');remove.type='button';remove.addEventListener('click',()=>{draft=draft.filter(item=>item.id!==entry.id);renderList();mark();});row.append(remove);list.append(row);}
  }
  function showMonth(){const month=months.find(row=>row.month===$('records-month').value);for(const [id,key]of [['records-income','income_complete'],['records-management','management_complete'],['records-tax','tax_complete']])$(id).checked=month?.[key]===true;}
  async function load(force=false){
    if(!hooks.client())return;const next=`${hooks.client()}:${hooks.year()}`;
    if(context===next&&!force)return;
    if(context!==next&&dirty){error('Есть несохранённый реестр другого года. Сохраните его перед переключением или загрузите выбранный год.');return;}
    const request=++sequence;loading=true;update();
    try{const response=await hooks.api(url());if(request!==sequence||next!==`${hooks.client()}:${hooks.year()}`)return;context=next;data=response;draft=clone(response.entries);months=clone(response.months);dirty=false;$('records-enabled').checked=response.enabled;$('records-reviewer').value=hooks.author()||'';$('records-month').replaceChildren(...months.map(row=>{const option=node('option',new Date(`${row.month}-01T12:00:00`).toLocaleDateString('ru-RU',{month:'long',year:'numeric'}));option.value=row.month;return option;}));$('records-month').value=months.find(row=>row.month===hooks.month())?.month||months[0]?.month;showMonth();renderList();$('records-message').hidden=true;const hasManual=hooks.finance()?.ledger?.periods.some(row=>['income_override','outside_income','management_expenses','tax_expenses'].some(key=>row[key]!=null));$('records-migrate').hidden=!hasManual;$('records-migration-note').hidden=!hasManual;}
    catch(e){error(e.message);}finally{loading=false;update();}
  }
  function add(){
    try{const amount=$('record-amount').value.trim().replace(',','.');if(!/^\d+(?:\.\d{1,2})?$/.test(amount)||!$('record-date').value||!$('record-source').value.trim())throw new Error('Укажите дату, сумму и документ-основание.');
      if(!$('record-date').value.startsWith(`${hooks.year()}-`))throw new Error('Дата операции должна относиться к выбранному году.');
      draft.push({id:crypto.randomUUID(),kind:$('record-kind').value,date:$('record-date').value,amount,source:$('record-source').value.trim(),note:$('record-note').value.trim(),tax_date:$('record-tax-date').value||null,confirmed:$('record-confirmed').checked});
      for(const id of['record-amount','record-source','record-note'])$(id).value='';$('record-confirmed').checked=false;renderList();mark();
    }catch(e){error(e.message);}
  }
  async function migrate(){
    if(!hooks.canSwitch()){error('Сначала сохраните или отмените изменения в годовом расчёте.');return;}
    if(dirty){error('Сначала сохраните дополнительные операции с выключенным режимом реестра или загрузите сохранённую версию.');return;}
    await hooks.task(async()=>{
      const reviewer=$('records-reviewer').value.trim(),reason=$('records-reason').value.trim();if(!reviewer||!reason)throw new Error('Укажите проверяющего и основание перехода.');
      const base=`/api/clients/${encodeURIComponent(hooks.client())}`,finance=await hooks.api(`${base}/finance?year=${hooks.year()}`),ledger=clone(finance.ledger);
      for(const row of ledger.periods){for(const key of['income_override','outside_income','management_expenses','tax_expenses'])row[key]=null;row.income_confirmed=false;row.expenses_confirmed=false;}
      await hooks.api(`${base}/finance`,{method:'PUT',body:JSON.stringify({year:hooks.year(),revision:finance.revision,client_revision:finance.client_revision,ledger,reviewer,reason:`Переход к реестру; ручные итоги сохранены в истории. ${reason}`})});
      try{await hooks.api(url(),{method:'PUT',body:JSON.stringify({...data,enabled:true,reviewer,reason})});}
      catch(e){error(`Ручные итоги очищены с сохранением в истории, но реестр ещё не включён: ${e.message}`);await hooks.saved();throw e;}
      await hooks.saved();await load(true);
    },'Включён реестр. Проверьте дополнительные операции и полноту месяцев; прежние суммы доступны в истории.');
  }
  async function save(){
    if(!data||busy||loading||hooks.viewer())return;
    if(context!==`${hooks.client()}:${hooks.year()}`){error('Сначала вернитесь к году несохранённого реестра или загрузите выбранный год.');return;}
    await hooks.task(async()=>{
      const reviewer=$('records-reviewer').value.trim(),reason=$('records-reason').value.trim();if(!reviewer||!reason)throw new Error('Укажите проверяющего и основание изменения реестра.');
      try{await hooks.api(url(),{method:'PUT',body:JSON.stringify({year:hooks.year(),revision:data.revision,enabled:$('records-enabled').checked,entries:draft,months,reviewer,reason})});dirty=false;await load(true);await hooks.saved();}
      catch(e){error(e.message);throw e;}
    },'Реестр сохранён. Накопительные суммы пересчитаны из документов и дополнительных операций.');
  }
  window.AccountingPlusRecords={mount,load,setBusy(value){busy=value;if(root)update();}};
})();
