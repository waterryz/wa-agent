// Approved navigation/service answers, versioned independently of model prompts.
// Exact normalized aliases only: ambiguous, compound and personal requests go to AI.
const VERSION = '2026-10-01';
const SOURCE = 'Prime Fusion mobile handbook 2.2 (2026-10-01) and owner clarification (2026-10-01)';
const ANSWERS = {
  service_choice: {
    aliases: ['сервис', 'service', 'то'],
    ru: 'Что нужно уточнить?\nВыберите адрес сервиса, отправку отчёта или вопрос сотруднику.',
    en: 'What do you need?\nChoose the service address, sending a report, or a question for a staff member.',
    action: 'service_choice',
  },
  service_address: {
    aliases: ['где сервис', 'куда на то', 'адрес мастерской', 'куда ехать на сервис', 'where is the service shop', 'where to get service'],
    ru: 'KRS Auto Doctor — основной сервис.\n2965 86th Street, Brooklyn, NY 11223\n(718) 891-6626\nБез записи. Удобнее приехать к открытию.\n\nИгорь — электрика и мелкий ремонт.\n2029 E 24th St, Brooklyn, NY\n(646) 420-7572\nПосле 10:00, по предварительной договорённости.\n\nПлатный ремонт за счёт компании сначала согласуйте с Prime Fusion.',
    en: 'KRS Auto Doctor — main service shop.\n2965 86th Street, Brooklyn, NY 11223\n(718) 891-6626\nNo appointment. Arriving at opening is recommended.\n\nIgor — electrical work and minor repairs.\n2029 E 24th St, Brooklyn, NY\n(646) 420-7572\nAfter 10 a.m., by prior arrangement.\n\nGet Prime Fusion approval before ordering paid repairs at the company’s expense.',
    source: 'Original RU Mobile handbook 2026-09-21, page 50',
  },
  handbook: {
    aliases: ['где скачать хендбук', 'скачать хендбук', 'где хендбук', 'download handbook', 'where can i download the handbook'],
    ru: 'Хендбук можно открыть на primefusioncars.com в разделе «Документы для ознакомления». В Telegram-боте он также доступен через «Вопросы и помощь».',
    en: 'Open the handbook at primefusioncars.com under “Documents”. It is also available through “Questions and help” in the Telegram bot.',
    action: 'handbook',
  },
  service_report: {
    aliases: ['как отправить отчет', 'как отправить отчёт о сервисе', 'как отправить чек', 'how to send a report', 'how do i send a service report'],
    ru: 'Сфотографируйте весь ресит из сервиса так, чтобы читались дата, машина, работы и стоимость. Добавьте фото общего пробега. Отправьте их в Telegram-боте: «Сервис» → «Отправить фото после сервиса».',
    en: 'Photograph the full service receipt so the date, vehicle, work and cost are readable. Add a photo of the total odometer reading. In the Telegram bot, open “Service” → “Send photos after service”.',
    action: 'service',
  },
  service_filters: {
    aliases: ['когда менять фильтры', 'как часто менять фильтры', 'когда менять воздушный и салонный фильтры', 'фильтры при замене масла', 'when to change the filters', 'how often should the filters be changed'],
    ru: 'Воздушный фильтр двигателя и салонный фильтр меняют при каждой второй замене масла. Проверяйте их и историю обслуживания на каждом ТО: механик может не знать, какая замена масла по счёту. Если история неясна, уточните в компании; не считайте текущую замену «второй» наугад.',
    en: 'Replace the engine air filter and cabin filter at every second oil change. Check the filters and service history at every visit, since the mechanic may not know which oil change this is. If the history is unclear, confirm it with the company.',
    source: 'Prime Fusion mobile handbook 2.2 (2026-10-01), page 58; owner clarification (2026-10-01)',
  },
  service_interval: {
    aliases: ['когда ехать на то', 'когда менять масло', 'через сколько миль делать то', 'when should i get an oil change', 'when is service due'],
    ru: 'Планируйте ТО примерно через 6 000 миль после предыдущего обслуживания и пройдите его не позднее 7 000 миль. Если пробег с прошлого ТО неизвестен, проверьте историю обслуживания или уточните его в компании.',
    en: 'Plan service about 6,000 miles after the previous visit and complete it no later than 7,000 miles. If you do not know the mileage since the last service, check the service history or ask the company.',
    source: 'Prime Fusion mobile handbook 2.2 (2026-10-01), page 57',
  },
  dmv_form: {
    aliases: ['где взять бланк дмв', 'где взять бланк dmv', 'кому отдать бланк', 'where do i get the dmv form', 'where to get dmv form'],
    ru: 'Распечатайте бланк проверки и передайте его Алексу или Гарри в сервисе. Если нужны расходники компании, получите их заранее по договорённости. После DMV отправьте в Telegram-боте заполненный бланк, четыре стороны машины и общий пробег.',
    en: 'Print the inspection checklist and give it to Alex or Harry at the shop. Arrange to collect any company-provided supplies in advance. After DMV, send the completed checklist, photos of all four sides of the car and the total odometer reading through the Telegram bot.',
    action: 'dmv',
  },
  inspection_photos: {
    aliases: ['какие фото нужны после инспекции', 'какие фото нужны для дмв', 'what photos are needed after inspection'],
    ru: 'В Telegram-боте откройте «DMV-инспекция» → «Отправить фото после DMV». Нужны заполненный бланк проверки, фото машины спереди, сзади, слева и справа, а также общий пробег. Фото должны быть чёткими.',
    en: 'In the Telegram bot, open “DMV inspection” → “Send photos after DMV”. Send the completed checklist, photos of the front, rear, left and right sides of the car, and the total odometer reading. Make sure they are clear.',
    action: 'dmv',
  },
  odometer: {
    aliases: ['что такое одометр', 'где найти пробег', 'какой пробег фотографировать', 'what is an odometer', 'where is the odometer'],
    ru: 'Одометр показывает общий пробег автомобиля на приборной панели. Сфотографируйте экран так, чтобы все цифры были видны. Нужен общий пробег, а не Trip A или Trip B.',
    en: 'The odometer shows the vehicle’s total mileage on the dashboard. Take a photo with all numbers visible. Use the total mileage, not Trip A or Trip B.',
  },
  notes: {
    aliases: ['как оставить заметку', 'как оставить замечание к следующему то', 'how to add a service note'],
    ru: 'Откройте «Мой кабинет» → «К следующему сервису». Напишите, что нужно проверить, и нажмите «Сохранить заметку». Например: «При торможении слышен скрип».',
    en: 'Open “My account” → “Next service”. Describe what needs checking and tap “Save note”. Example: “There is a squeak when braking.”',
    action: 'account',
  },
  payment: {
    aliases: ['где посмотреть следующий платеж', 'где посмотреть дату платежа', 'where can i see my next payment'],
    ru: 'Откройте «Мой кабинет». В разделе «Следующий платёж» указаны дата и сумма. Если платёж уже внесён, но данные не совпадают, напишите об этом — нужна проверка сотрудника.',
    en: 'Open “My account”. “Next payment” shows the date and amount. If you already paid and the details do not match, tell us so a staff member can check.',
    action: 'account',
  },
  mileage: {
    aliases: ['где посмотреть пробег и лимит', 'где посмотреть лимит пробега', 'where can i see my mileage limit'],
    ru: 'Откройте «Мой кабинет». Там показаны пробег за месяц и лимит вашего тарифа.',
    en: 'Open “My account” to see your monthly mileage and your plan’s mileage limit.',
    action: 'account',
  },
  application: {
    aliases: ['как подать заявку', 'хочу подать заявку', 'how to apply', 'how do i apply'],
    ru: 'Нажмите «Подать заявку». Бот спросит имя, фамилию, телефон, email, стаж DMV и TLC, наличие аккаунтов Uber и Lyft.',
    en: 'Tap “Apply to rent”. The bot will ask for your name, phone, email, DMV and TLC experience, and whether you have Uber and Lyft accounts.',
    action: 'apply',
  },
  test_priority: {
    aliases: ['зачем проходить тест', 'зачем проходить тест после заявки', 'why take the test', 'why should i take the test'],
    ru: 'Заявки с пройденным тестом рассматриваются в первую очередь. Тест простой. Его можно пройти на любом языке. Нажмите «Пройти тест сейчас».',
    en: 'Applications with a completed test are reviewed first. The test is simple and can be taken in any language. Tap “Take the test now”.',
    action: 'test',
  },
  test_language: {
    aliases: ['на каком языке тест', 'на каком языке можно пройти тест', 'what languages is the test available in'],
    ru: 'На удобном вам языке. Нажмите «Пройти тест» и выберите язык. Если его нет в списке, укажите язык в поле выбора.',
    en: 'Choose your preferred language after opening “Take the test”. If it is not listed, enter your language in the language field.',
    action: 'test',
  },
  dmv_under_one: {
    aliases: ['у меня меньше года дмв', 'у меня меньше года dmv можно подать заявку', 'i have less than one year with dmv'],
    ru: 'Для аренды нужен стаж по правам DMV не менее 1 года. Подайте заявку, когда стаж достигнет 1 года.',
    en: 'You need at least 1 year with a DMV driver license to apply. Apply when you reach 1 year.',
  },
  dmv_two: {
    aliases: ['у меня два года дмв можно подать заявку', 'у меня два года dmv', 'i have two years with dmv'],
    ru: 'Да. Выберите «От 1 года до 3 лет». Заявка пройдёт дальше. Окончательные условия обсудит с вами Prime Fusion.',
    en: 'Yes. Choose “1 to less than 3 years”. You can continue the application. Prime Fusion will discuss the final terms with you.',
    action: 'apply',
  },
  no_accounts: {
    aliases: ['нет убера и лифта', 'нет uber и lyft заявка пройдет', 'нет uber и lyft', 'i have no uber or lyft account'],
    ru: 'Даже без Uber и Lyft можно подать заявку. Ответьте «Нет» на оба вопроса. Нужен стаж DMV не менее 1 года.',
    en: 'You can apply without Uber or Lyft accounts. Answer “No” to both questions. At least 1 year with a DMV driver license is required.',
    action: 'apply',
  },
  service_question: {
    aliases: ['как написать по машине', 'как задать вопрос по сервису', 'how to contact staff about my car'],
    ru: 'Нажмите «Вопрос по сервису» и опишите, что случилось. Ответ сотрудника придёт в этот чат.',
    en: 'Tap “Service question” and describe what happened. A staff member will reply in this chat.',
    action: 'service_question',
  },
};

function normalize(text) {
  return String(text || '').normalize('NFKC').toLowerCase().replace(/ё/g, 'е')
    .replace(/[?!.,:;]+$/g, '').replace(/\s+/g, ' ').trim();
}
const INDEX = new Map();
for (const [id, answer] of Object.entries(ANSWERS)) {
  for (const alias of answer.aliases) INDEX.set(normalize(alias), id);
}
function lookup({ text = '', topic = null, language = null, hasPhoto = false }) {
  if (hasPhoto) return null;
  const normalized = normalize(text);
  const id = topic && !normalized ? topic : INDEX.get(normalized);
  if (!id || !ANSWERS[id]) return null;
  const lang = /[\u10a0-\u10ff\u1c90-\u1cbf]/u.test(text) ? 'ka' : /[а-яё]/i.test(text) ? 'ru' : normalized ? 'en' : language;
  const answer = ANSWERS[id];
  if (!answer[lang]) return null;
  return { id, text: answer[lang], language: lang, action: answer.action || null, source: answer.source || SOURCE, version: VERSION };
}
module.exports = { lookup, normalize, ANSWERS, VERSION };
