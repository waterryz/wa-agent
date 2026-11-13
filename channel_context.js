'use strict';

const GENERIC_CHANNEL_INSTRUCTION =
  'Текущий канал связи не подтверждён. Не называй и не угадывай платформу текущего чата ' +
  'и не переноси правила конкретных платформ на этот диалог. ' +
  'Не заявляй о несуществующих возможностях и не выдумывай номера телефонов, ссылки и функции.';

const CHANNEL_INSTRUCTIONS = new Map([
  [
    'whatsapp',
    'Ты сейчас в WhatsApp: текущий чат — это чат в WhatsApp. ' +
      'Слова «здесь», «в этом чате», «отправь сюда» означают этот чат в WhatsApp. ' +
      'Цитаты и пересказ сообщений из Telegram не являются доказательством текущего канала. ' +
      'Не предлагай пользователю перейти в WhatsApp — он уже здесь. ' +
      'Подтверждённые внешние рабочие процессы компании через Telegram-бота можно называть явно, ' +
      'но всегда отличай их от текущего чата. ' +
      'Не заявляй о несуществующих возможностях (вложения, расшифровка голосовых, платежи, изменения аккаунта) ' +
      'и не выдумывай номера телефонов, ссылки и функции.',
  ],
  [
    'telegram',
    'Ты сейчас в Telegram: текущий чат — это чат в Telegram. ' +
      'Слова «здесь», «в этом чате», «отправь сюда» означают этот чат в Telegram. ' +
      'Цитаты и пересказ сообщений из других мессенджеров не являются доказательством текущего канала. ' +
      'Не предлагай пользователю перейти в Telegram — он уже здесь. ' +
      'Не заявляй о несуществующих возможностях и не выдумывай номера телефонов, ссылки и функции.',
  ],
  [
    'web',
    'Ты сейчас в веб-чате на сайте: текущий чат — этот веб-чат. ' +
      'Слова «здесь» и «в этом чате» означают текущий веб-чат. ' +
      'Не называй текущий канал мессенджером и не переноси правила мессенджеров на этот чат. ' +
      'Не заявляй о несуществующих возможностях и не выдумывай номера телефонов, ссылки и функции.',
  ],
]);

function buildChannelContext(channel) {
  if (typeof channel !== 'string') {
    return GENERIC_CHANNEL_INSTRUCTION;
  }
  return CHANNEL_INSTRUCTIONS.get(channel) || GENERIC_CHANNEL_INSTRUCTION;
}

function replyLanguage(language, question = '') {
  if (['ru', 'en', 'ka'].includes(language)) return language;
  if (/[\u10a0-\u10ff]/u.test(question)) return 'ka';
  return /[a-z]/i.test(question) && !/[а-яё]/i.test(question) ? 'en' : 'ru';
}

function waitForStaff(channel, language) {
  const messages = channel === 'web' ? {
    ru: 'Здесь у меня нет доступа к персональным записям. Сотрудник может проверить вопрос в вашем обычном рабочем чате с компанией.',
    en: 'I cannot check personal records on this website. A staff member can check in your usual chat with the company.',
    ka: 'ამ საიტზე პირად ჩანაწერებზე წვდომა არ მაქვს. საკითხის შემოწმება თანამშრომელს კომპანიასთან თქვენს ჩვეულ სამუშაო ჩატში შეუძლია.'
  } : {
    ru: 'Для проверки нужен сотрудник. Пожалуйста, дождитесь ответа в этом чате.',
    en: 'A staff member needs to check this. Please wait for a reply here in this chat.',
    ka: 'ეს საკითხი თანამშრომელმა უნდა შეამოწმოს. გთხოვთ, პასუხს ამავე ჩატში დაელოდოთ.'
  };
  return messages[language] || messages.ru;
}

// Catch the old referral wording if a generation repeats it from conversation history.
// The verified address may still be supplied when specifically requested.
function keepRoutineRequestInChat(reply, question, channel, language) {
  if (!reply || !/(?:e-?mail|почт|имейл|იმეილ|ფოსტ|info@primefusioncars\.com)/iu.test(reply)) return reply;
  const asksForAddress = /(?:what(?:’s|'s| is) (?:your|the company.s).*?(?:email|e-mail)|(?:email|e-mail) address|(?:which|what) (?:email|e-mail)|(?:куда|на как\S*|како[йеа]|дайте|подскажите|пришлите).{0,24}(?:почт|имейл|e-?mail)|(?:რა არის|რომელ|მომეცით).{0,35}(?:ფოსტ|იმეილ))/iu;
  if (asksForAddress.test(question) || /how (?:do|can) i e-?mail (?:you|the company)/iu.test(question)) return reply;
  const parts = reply.split(/(?<=[.!?;])\s+|\n+/u);
  const kept = parts.filter(part => !(
    (/(?:e-?mail (?:us|the (?:company|office|team))|(?:send|write) (?:us )?an? e-?mail|(?:напиш|обратит|отправ|свяж)\S*[^.!?]{0,35}(?:на почту|по (?:электронной )?почте|на e-?mail))/iu.test(part) ||
      (/info@primefusioncars\.com/i.test(part) &&
       /(?:e-?mail\b|write|contact|reach|send|напиш|пишит|обратит|отправ|почт|свяж|მიწერ|გაგზავნ|დაუკავშირ|ფოსტ)/iu.test(part))) &&
    !/\b911\b/u.test(part)
  ));
  if (kept.length === parts.length) return reply;
  kept.push(waitForStaff(channel, replyLanguage(language, question)));
  return kept.join(' ');
}

module.exports = { buildChannelContext, waitForStaff, replyLanguage, keepRoutineRequestInChat };
