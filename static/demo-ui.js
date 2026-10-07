'use strict';
document.getElementById('reset-demo').addEventListener('click', async () => {
  if (!confirm('Вернуть все учебные примеры к исходному состоянию? Ваши исправления, клиенты и загруженные учебные файлы в этом браузере будут удалены.')) return;
  try {
    await window.AccountingPlusDemo.reset();
    location.reload();
  } catch (error) {
    document.getElementById('demo-storage-error').textContent = error.message;
    document.getElementById('demo-storage-error').hidden = false;
  }
});
