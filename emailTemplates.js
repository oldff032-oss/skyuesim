const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;',
}[char]));

function absoluteUrl(path = '/') {
  const base = String(process.env.FRONTEND_URL || 'https://skyesim.netlify.app').replace(/\/$/, '');
  if (/^https?:\/\//i.test(path)) return path;
  return `${base}/${String(path).replace(/^\//, '')}`;
}

function layout({ eyebrow = 'КОМАНДА СИГНАЛ', title, intro = '', content = '', action = null, footer = '' }) {
  const actionHtml = action?.url ? `<div style="margin:28px 0"><a href="${escapeHtml(absoluteUrl(action.url))}" style="display:inline-block;background:linear-gradient(135deg,#2563eb,#7c3aed);color:#fff;text-decoration:none;font-weight:700;padding:13px 22px;border-radius:12px">${escapeHtml(action.label || 'Відкрити')}</a></div>` : '';
  return `<!doctype html><html lang="uk"><body style="margin:0;background:#f3f6fb;color:#172033;font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif"><div style="padding:28px 12px"><div style="max-width:600px;margin:auto;background:#fff;border:1px solid #e5eaf2;border-radius:20px;overflow:hidden;box-shadow:0 14px 36px rgba(27,39,68,.10)"><div style="padding:25px 30px;background:linear-gradient(135deg,#071426,#10294d)"><div style="font-size:21px;font-weight:800;color:#fff;letter-spacing:.2px">◉ Сигнал</div><div style="margin-top:4px;color:#9fb7d8;font-size:12px">Глобальний eSIM-сервіс</div></div><div style="padding:32px 30px"><div style="font-size:11px;letter-spacing:1.5px;color:#6d5ce7;font-weight:800">${escapeHtml(eyebrow)}</div><h1 style="font-size:25px;line-height:1.25;margin:9px 0 14px;color:#111a2c">${escapeHtml(title)}</h1>${intro ? `<p style="font-size:15px;line-height:1.7;color:#526078;margin:0 0 22px">${escapeHtml(intro)}</p>` : ''}${content}${actionHtml}<p style="margin:28px 0 0;padding-top:20px;border-top:1px solid #edf0f5;color:#78859a;font-size:12px;line-height:1.6">${footer || 'З повагою,<br><strong>Команда Сигнал</strong><br>Це автоматичний службовий лист.'}</p></div></div></div></body></html>`;
}

function supportReply({ ticketId, subject, message }) {
  const safeMessage = escapeHtml(message).replace(/\n/g, '<br>');
  return layout({ eyebrow:`ПІДТРИМКА · ЗВЕРНЕННЯ #${ticketId}`, title:'Маємо нову відповідь для вас', intro:subject, content:`<div style="background:#f6f8fc;border-left:4px solid #635bff;border-radius:10px;padding:18px 20px;color:#26344c;font-size:15px;line-height:1.7">${safeMessage}</div>`, action:{label:'Відкрити звернення',url:`/ticket.html?id=${ticketId}`}, footer:`Ви можете відповісти на цей лист — повідомлення буде додано до звернення #${escapeHtml(ticketId)}.<br><br>З повагою,<br><strong>Команда Сигнал</strong>` });
}

function ticketAssignment({ ticketId, customerEmail, subject }) {
  return layout({ eyebrow:'АДМІН-ПАНЕЛЬ · НОВЕ ПРИЗНАЧЕННЯ', title:`Вам призначено звернення #${ticketId}`, intro:'Super Admin передав вам звернення для подальшої роботи.', content:`<div style="background:#f6f8fc;border-radius:12px;padding:17px 19px;font-size:14px;line-height:1.8"><strong>Користувач:</strong> ${escapeHtml(customerEmail)}<br><strong>Тема:</strong> ${escapeHtml(subject)}</div>`, action:{label:'Перейти до звернення',url:`/admin-ticket.html?id=${ticketId}`} });
}

function purchaseReceipt({ purchase, receiptUrl, fulfillmentStatus }) {
  const amount = purchase.amountCents == null ? '—' : `${(Number(purchase.amountCents)/100).toFixed(2)} ${String(purchase.currency || '').toUpperCase()}`;
  const plan = purchase.packageName || purchase.plan || 'eSIM-пакет';
  const detail = [purchase.location, purchase.dataLimitGb == null ? null : `${purchase.dataLimitGb} ГБ`, purchase.durationDays ? `${purchase.durationDays} днів` : null].filter(Boolean).join(' · ');
  const provision = fulfillmentStatus === 'provisioned' ? 'eSIM успішно видано' : fulfillmentStatus === 'failed' ? 'Оплату прийнято; підтримка бачить проблему з видачею eSIM' : 'Оплату успішно прийнято';
  return layout({ eyebrow:'ПІДТВЕРДЖЕННЯ ОПЛАТИ', title:'Дякуємо за покупку!', intro:'Оплату успішно проведено. Чек збережено у вашому акаунті.', content:`<div style="background:#f6f8fc;border-radius:12px;padding:18px 20px;font-size:14px;line-height:1.85"><strong>Покупка:</strong> ${escapeHtml(plan)}<br>${detail ? `<strong>Пакет:</strong> ${escapeHtml(detail)}<br>` : ''}<strong>Сума:</strong> ${escapeHtml(amount)}<br><strong>Дата:</strong> ${escapeHtml(new Date(purchase.paidAt || Date.now()).toLocaleString('uk-UA'))}<br><strong>Номер:</strong> ${escapeHtml(purchase.id)}<br><strong>Статус:</strong> ${escapeHtml(provision)}</div>`, action:{label:receiptUrl ? 'Відкрити чек Stripe' : 'Переглянути історію оплат',url:receiptUrl || '/payments.html'}, footer:'Чек також доступний у застосунку: Профіль → Історія оплат.<br><br>З повагою,<br><strong>Команда Сигнал</strong>' });
}

module.exports = { escapeHtml, layout, supportReply, ticketAssignment, purchaseReceipt };
