/* Versioned file adapters. Keep contract and fixtures in parity with document_adapters.py. */
(function(root) {
  'use strict';
  const VERSION = '2026-10-10.1', WB = 'wb-sales-report-v1', BANK = '1c-client-bank-1.03';
  const MAX_BYTES = 10 * 1024 * 1024, MAX_ROWS = 50000;
  const WB_REQUIRED = new Set(["currency", "dateFrom", "dateTo", "reportId", "rrDate", "rrdId", "sellerOperName"]);
  const WB_ALLOW = new Set(["acceptance", "acquiringBank", "acquiringFee", "acquiringPercent", "additionalPayment", "assemblyId", "bonusTypeName", "brandName", "cashbackAmount", "cashbackCommissionChange", "cashbackDiscount", "commissionPercent", "country", "createDate", "currency", "dateFrom", "dateTo", "declarationNumber", "deduction", "deliveryAmount", "deliveryMethod", "deliveryService", "dlvPrc", "docTypeName", "fixTariffDateFrom", "fixTariffDateTo", "forPay", "giBoxTypeName", "giId", "installmentCofinancingAmount", "isKgvpV2", "isLegalEntity", "kvw", "kvwBase", "nmId", "officeName", "orderDt", "orderUid", "paymentProcessing", "paymentSchedule", "penalty", "ppvzOfficeId", "ppvzOfficeName", "ppvzReward", "ppvzSalesCommission", "ppvzSupplierInn", "ppvzSupplierName", "productDiscountForReport", "quantity", "rebillLogisticCost", "rebillLogisticOrg", "reportId", "reportType", "retailAmount", "retailPrice", "retailPriceWithDisc", "returnAmount", "rrDate", "rrdId", "saleDt", "salePercent", "sellerOperName", "sellerPromo", "shkId", "sku", "spp", "srid", "srvDbs", "stickerId", "storageFee", "subjectName", "supRatingUp", "techSize", "title", "trbxId", "vendorCode", "vw", "vwNds"]);
  const WB_MONEY = new Set(["acceptance", "acquiringFee", "additionalPayment", "cashbackAmount", "cashbackCommissionChange", "cashbackDiscount", "deduction", "deliveryService", "forPay", "installmentCofinancingAmount", "penalty", "ppvzReward", "ppvzSalesCommission", "rebillLogisticCost", "retailAmount", "retailPriceWithDisc", "storageFee", "vw", "vwNds"]);
  const BANK_HEADER = new Set(["ВерсияФормата", "ВремяСоздания", "ДатаКонца", "ДатаНачала", "ДатаСоздания", "Документ", "Кодировка", "Отправитель", "Получатель", "РасчСчет"]);
  const BANK_BALANCE = new Set(["ВсегоПоступило", "ВсегоСписано", "ДатаКонца", "ДатаНачала", "КонечныйОстаток", "НачальныйОстаток", "РасчСчет"]);
  const BANK_DOC = new Set(["ВидОплаты", "ВидПлатежа", "Дата", "ДатаПоступило", "ДатаСписано", "КвитанцияВремя", "КвитанцияДата", "КвитанцияСодержание", "Код", "КодНазПлатежа", "НазначениеПлатежа", "НазначениеПлатежа1", "НазначениеПлатежа2", "НазначениеПлатежа3", "НазначениеПлатежа4", "НазначениеПлатежа5", "НазначениеПлатежа6", "Номер", "ОКАТО", "ОчередностьПлатежа", "Плательщик", "Плательщик1", "Плательщик2", "Плательщик3", "Плательщик4", "ПлательщикБИК", "ПлательщикБанк1", "ПлательщикБанк2", "ПлательщикИНН", "ПлательщикКПП", "ПлательщикКорсчет", "ПлательщикРасчСчет", "ПлательщикСчет", "ПоказательДаты", "ПоказательКБК", "ПоказательНомера", "ПоказательОснования", "ПоказательПериода", "ПоказательТипа", "Получатель", "Получатель1", "Получатель2", "Получатель3", "Получатель4", "ПолучательБИК", "ПолучательБанк1", "ПолучательБанк2", "ПолучательИНН", "ПолучательКПП", "ПолучательКорсчет", "ПолучательРасчСчет", "ПолучательСчет", "СрокПлатежа", "СтатусСоставителя", "Сумма", "УИН"]);
  const fail = message => { throw new Error(message); };
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  function day(v) {
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) fail('Ожидается календарная дата YYYY-MM-DD.');
    const d = new Date(v + 'T00:00:00Z');
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0,10) !== v || v.slice(0,4) === '0000') fail('Некорректная календарная дата.');
    return v;
  }
  function bankDay(v) {
    if (typeof v !== 'string' || !/^\d{2}\.\d{2}\.\d{4}$/.test(v)) fail('Ожидается календарная дата ДД.ММ.ГГГГ.');
    return day(v.slice(6) + '-' + v.slice(3,5) + '-' + v.slice(0,2));
  }
  function money(v) {
    if (typeof v !== 'string' || !/^\d+(?:\.\d{1,2})?$/.test(v)) fail('Денежное поле: нужна неотрицательная строка с точностью до копеек.');
    const [whole, fract = ''] = v.split('.'), cents = BigInt(whole) * 100n + BigInt(fract.padEnd(2,'0'));
    if (cents > 100000000000000000n) fail('Денежное поле превышает допустимый предел.');
    return cents;
  }
  const fmt = n => `${n / 100n}.${String(n % 100n).padStart(2,'0')}`;
  function identifier(v) {
    if (!['string','number'].includes(typeof v) || !/^[A-Za-z0-9._-]{1,120}$/.test(String(v)) || (typeof v === 'number' && !Number.isSafeInteger(v))) fail('Нужен непустой стабильный идентификатор: латиница, цифры, точка, дефис или подчёркивание (до 120).');
    return String(v);
  }
  const clone = v => JSON.parse(JSON.stringify(v));
  function event(adapter, account, line, id, kind, when, amount, original, fields) {
    return {line, source: adapter === BANK ? 'bank' : 'marketplace', external_id:id, kind, original_kind:kind,
      date:when, tax_date:null, amount:fmt(amount), settlement_id:null, related_id:null,
      note:adapter, vat_rate:null, vat_amount:null, extra_fields:{},
      adapter, adapter_version:VERSION, account_id:account, provenance:{row:line, fields, original:clone(original)}};
  }
  function proposal(adapter, account, events, warnings, start, end) {
    return {source:events[0].source, adapter, adapter_version:VERSION, account_id:account,
      periods:[...new Set(events.map(e=>e.date.slice(0,7)))].sort(), period_start:start, period_end:end, events, warnings};
  }
  // JSON.parse silently overwrites duplicate keys; reject them before any accounting.
  function strictJSON(text) {
    let i = 0;
    const ws = () => { while (/\s/.test(text[i] || '') && i < text.length) i++; };
    const str = () => {
      const start = i++;
      while (i < text.length) {
        if (text[i] === '\\') { i += 2; continue; }
        if (text[i++] === '"') return JSON.parse(text.slice(start,i));
      }
      fail('Повреждённый JSON.');
    };
    function val(depth) {
      if (depth > 16) fail('Повреждённый JSON.');
      ws();
      if (text[i] === '"') return str();
      if (text[i] === '{') {
        i++; const o = Object.create(null); ws(); if (text[i] === '}') { i++; return o; }
        for (;;) {
          ws(); if (text[i] !== '"') fail('Повреждённый JSON.');
          const k = str(); if (has(o,k)) fail('JSON содержит повторяющееся поле: ' + k);
          ws(); if (text[i++] !== ':') fail('Повреждённый JSON.');
          o[k] = val(depth+1); ws(); const ch = text[i++];
          if (ch === '}') return o; if (ch !== ',') fail('Повреждённый JSON.');
        }
      }
      if (text[i] === '[') {
        i++; const a = []; ws(); if (text[i] === ']') { i++; return a; }
        for (;;) { a.push(val(depth+1)); ws(); const ch = text[i++]; if (ch === ']') return a; if (ch !== ',') fail('Повреждённый JSON.'); }
      }
      const m = /^(?:true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(i));
      if (!m) fail('Повреждённый JSON.'); i += m[0].length; return JSON.parse(m[0]);
    }
    const out = val(0); ws(); if (i !== text.length) fail('Повреждённый JSON.'); return out;
  }
  function wb(text, accountId) {
    const account = identifier(accountId), rows = strictJSON(text);
    if (!Array.isArray(rows) || !rows.length || rows.length > MAX_ROWS) fail('WB: ожидается массив из 1–50 000 строк детализации.');
    const events = [], seen = new Set(), starts = [], ends = [];
    rows.forEach((row,index)=>{
      const line = index+1;
      try {
        if (!row || Array.isArray(row) || typeof row !== 'object' || [...WB_REQUIRED].some(k=>!has(row,k))) fail('Не распознана детализация WB sales-reports v1 (camelCase). Старый v5 не поддержан.');
        const unknown = Object.keys(row).filter(k=>!WB_ALLOW.has(k)).sort();
        if (unknown.length) fail('Неподдержанные поля WB: ' + unknown.join(', '));
        if (Object.values(row).some(v=>(v !== null && typeof v === 'object') || String(v).length > 5000)) fail('WB: вложенные или слишком длинные значения не поддержаны.');
        if (row.srid != null && typeof row.srid !== 'string') fail('WB: srid должен быть строкой.');
        const report = identifier(row.reportId), rowId = identifier(row.rrdId);
        if (seen.has(rowId)) fail('Повторяющийся rrdId внутри файла.'); seen.add(rowId);
        if (row.currency !== 'RUB') fail('Поддержаны только RUB.');
        const start = day(row.dateFrom), end = day(row.dateTo), when = day(row.rrDate);
        if (!(start <= when && when <= end)) fail('Дата rrDate вне периода отчёта.');
        starts.push(start); ends.push(end);
        const m = Object.fromEntries(Object.entries(row).filter(([k])=>WB_MONEY.has(k)).map(([k,v])=>[k,money(v)]));
        const operation = row.sellerOperName, prefix = `wb:${account}:rrd:${rowId}`, components = [];
        let allowed;
        if (operation === 'Продажа' || operation === 'Возврат') {
          allowed = new Set(['retailAmount','retailPriceWithDisc','ppvzSalesCommission','forPay']);
          if ([...allowed].some(k=>!has(m,k)) || !Number.isInteger(row.quantity) || row.quantity !== 1) fail('WB: поддержана только строка одного товара со всеми суммами продажи/возврата.');
          if (row.docTypeName !== operation) fail('Тип документа противоречит операции WB.');
          const amount = m.retailAmount, commission = m.ppvzSalesCommission, payable = m.forPay;
          if (m.retailPriceWithDisc !== amount || amount - commission !== payable) fail('WB: скидки/вознаграждение требуют неподдержанного расчёта; импорт заблокирован.');
          if (operation === 'Возврат' && commission) fail('WB: возврат вознаграждения требует отдельной классификации.');
          components.push([operation === 'Продажа' ? 'sale' : 'return', amount, ['retailAmount']]);
          if (commission) components.push(['commission',commission,['ppvzSalesCommission']]);
        } else if (operation === 'Логистика') {
          allowed = new Set(['deliveryService']);
          if (!has(m,'deliveryService') || m.deliveryService <= 0n) fail('WB: отсутствует положительная сумма логистики.');
          components.push(['logistics',m.deliveryService,['deliveryService']]);
        } else fail(`Неподдержанная финансовая операция WB: ${operation}.`);
        if (Object.entries(m).some(([k,v])=>!allowed.has(k) && v !== 0n)) fail('WB: дополнительные финансовые поля требуют классификации; импорт заблокирован.');
        for (const [kind,amount,fields] of components) {
          const e = event(WB, account, line, `${prefix}:${kind}`, kind, when, amount,row,fields);
          Object.assign(e.provenance,{json_pointer:`/${index}`,report_id:report}); events.push(e);
        }
      } catch(e) { fail(`Строка WB ${line}: ${e.message}`); }
    });
    return proposal(WB,account,events,['WB: налоговые даты требуют подтверждения бухгалтера.',
      'WB: связь возврата с продажей требует проверки; srid сохранён в исходной строке.',
      'WB: forPay — начислено к перечислению, не факт выплаты; связь с банком не создана.',
      'WB: полнота API-выгрузки и периода должна быть подтверждена; файл может содержать часть отчёта.'],starts.sort()[0],ends.sort().at(-1));
  }
  function bank(text, accountId) {
    const lines = text.split(/\r\n|\n|\r/), header = {}, balances = [], docs = [];
    let current = header, section = 'header', sectionLine = 1, ended = false;
    lines.slice(1).forEach((raw,index)=>{
      const line = index+2; raw = raw.trim(); if (!raw) return;
      if (raw.length > 5000) fail(`Строка ${line}: слишком длинное значение.`);
      if (ended) fail('После КонецФайла обнаружены данные.');
      if (raw === 'КонецФайла') { if (section !== 'header') fail('Незакрытая секция банковской выписки.'); ended = true; return; }
      if (raw === 'СекцияРасчСчет' || raw.startsWith('СекцияДокумент=')) {
        if (section !== 'header') fail('Вложенные банковские секции не поддержаны.');
        section = raw === 'СекцияРасчСчет' ? 'balance' : 'document'; sectionLine = line;
        current = section === 'balance' ? {} : {type:raw.slice(raw.indexOf('=')+1)}; return;
      }
      if (raw === 'КонецРасчСчет' || raw === 'КонецДокумента') {
        if ((raw === 'КонецРасчСчет' && section !== 'balance') || (raw === 'КонецДокумента' && section !== 'document')) fail('Нарушен порядок секций банковского файла.');
        (section === 'balance' ? balances : docs).push([sectionLine,current]); current=header; section='header'; return;
      }
      const sep = raw.indexOf('='); if (sep < 0) fail(`Строка ${line}: неизвестная строка банковского файла.`);
      const key=raw.slice(0,sep), value=raw.slice(sep+1), allowed=section==='header'?BANK_HEADER:section==='balance'?BANK_BALANCE:BANK_DOC;
      if (!allowed.has(key) || has(current,key)) fail(`Строка ${line}: неизвестное или повторное поле ${key}.`);
      current[key]=value;
    });
    if (!ended || section !== 'header' || balances.length !== 1 || !docs.length || docs.length > MAX_ROWS) fail('Нужна полная выписка с одной секцией счёта, документами и КонецФайла.');
    if (header.ВерсияФормата !== '1.03' || !['Windows','UTF-8'].includes(header.Кодировка)) fail('Поддержан 1CClientBankExchange 1.03 Windows (или текст UTF-8).');
    const account=header.РасчСчет||'';
    if (!/^\d{20}$/.test(account) || !['810','643'].includes(account.slice(5,8))) fail('Нужен один рублёвый расчётный счёт из 20 цифр.');
    if (accountId && String(accountId)!==account) fail('Указанный счёт не совпадает со счётом выписки.');
    const start=bankDay(header.ДатаНачала), end=bankDay(header.ДатаКонца), balance=balances[0][1];
    if (balance.РасчСчет!==account || bankDay(balance.ДатаНачала)!==start || bankDay(balance.ДатаКонца)!==end || start>end) fail('Счёт/период секции остатков расходится с заголовком.');
    const events=[], seen=new Set();
    for (const [line,row] of docs) {
      try {
        if (row.type!=='Платежное поручение') fail('Поддержаны только проведённые платёжные поручения.');
        const payer=row.ПлательщикСчет||'', recipient=row.ПолучательСчет||'';
        if (!/^\d{20}$/.test(payer) || !/^\d{20}$/.test(recipient)) fail('Отсутствуют счета плательщика/получателя.');
        const incoming=recipient===account, outgoing=payer===account;
        if (incoming===outgoing) fail('Неоднозначное направление документа относительно счёта.');
        const kind=incoming?'bank_credit':'bank_debit', dateField=incoming?'ДатаПоступило':'ДатаСписано', when=bankDay(row[dateField]), documentDay=bankDay(row.Дата);
        if (!(start<=when && when<=end)) fail('Дата проведения документа вне периода выписки.');
        const number=row.Номер||''; if (!number || number.length>120) fail('Отсутствует номер документа.');
        const escaped=encodeURIComponent(number).replace(/[!'()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase());
        const id=`bank:${account}:${payer}:payment-order:${documentDay}:${escaped}`;
        if (seen.has(id)) fail('Повторный идентификатор банковского документа.'); seen.add(id);
        const e=event(BANK,account,line,id,kind,when,money(row.Сумма),row,['Сумма',dateField]);
        e.note=row.НазначениеПлатежа||''; events.push(e);
      } catch(e) { fail(`Строка банка ${line}: ${e.message}`); }
    }
    const total=kind=>events.filter(e=>e.kind===kind).reduce((n,e)=>n+money(e.amount),0n), credit=total('bank_credit'), debit=total('bank_debit');
    if (money(balance.ВсегоПоступило)!==credit || money(balance.ВсегоСписано)!==debit) fail('Обороты секции счёта не совпадают с документами: выписка неполна или формат не поддержан.');
    if (money(balance.НачальныйОстаток)+credit-debit!==money(balance.КонечныйОстаток)) fail('Остатки банковской выписки не сходятся.');
    return proposal(BANK,account,events,['Банк: назначения платежей не задают налоговую классификацию или связь с выплатой маркетплейса.'],start,end);
  }
  function decode(data) {
    if (typeof data==='string') { if (!data || new TextEncoder().encode(data).length>MAX_BYTES) fail('Пустой файл или превышен размер 10 МБ.'); if (data.includes('\0')) fail('Недопустимые нулевые байты.'); return data; }
    const bytes=data instanceof Uint8Array?data:new Uint8Array(data);
    if (!bytes.length || bytes.length>MAX_BYTES) fail('Пустой файл или превышен размер 10 МБ.');
    let text;
    try { text=new TextDecoder('utf-8',{fatal:true}).decode(bytes); }
    catch(e) {
      if (new TextDecoder('ascii').decode(bytes.slice(0,20))!=='1CClientBankExchange') fail('Документ должен быть в UTF-8; банковский 1С также поддерживает Windows-1251.');
      if (bytes.includes(0x98)) fail('Некорректная кодировка банковского документа.');
      text=new TextDecoder('windows-1251',{fatal:true}).decode(bytes);
    }
    if (text.includes('\0')) fail('Недопустимые нулевые байты.'); return text;
  }
  function preview(data, filename, source='auto', accountId=null) {
    if (!['auto','marketplace','bank'].includes(source)) fail('Неверный источник.');
    if (typeof data!=='string' && new Uint8Array(data.buffer||data,data.byteOffset||0,Math.min(data.byteLength||0,2))[0]===80 && new Uint8Array(data.buffer||data,data.byteOffset||0,Math.min(data.byteLength||0,2))[1]===75) return null;
    const text=decode(data).replace(/^\uFEFF+/,'');
    if (text.startsWith('1CClientBankExchange')) {
      if (text.split(/\r\n|\n|\r/)[0]!=='1CClientBankExchange') fail('Неверный заголовок банковской выписки.');
      if (!['auto','bank'].includes(source)) fail('Документ распознан как банковская выписка; выбран другой источник.');
      return bank(text,accountId);
    }
    if (/^\s*[\[{]/.test(text) || filename.toLowerCase().endsWith('.json')) {
      if (!['auto','marketplace'].includes(source)) fail('Документ распознан как отчёт WB; выбран другой источник.');
      return wb(text,accountId);
    }
    return null;
  }
  root.documentAdapters={preview,decode,VERSION};
  if (typeof module!=='undefined' && module.exports) module.exports=root.documentAdapters;
})(typeof globalThis!=='undefined'?globalThis:window);
