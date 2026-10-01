// Approved navigation/service answers, versioned independently of model prompts.
// Exact normalized aliases only: ambiguous, compound and personal requests go to AI.
const VERSION = '2026-10-01';
const SOURCE = 'Prime Fusion mobile handbook 2.2 and owner clarification, 2026-10-01';
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
    ru: 'Хендбук доступен на primefusioncars.com в разделе «Документы для ознакомления» и в Telegram-боте через «Вопросы и помощь».',
    en: 'Open the handbook on primefusioncars.com under “Documents”, or in the Telegram bot under “Questions and help”.',
    action: 'handbook',
  },
  service_report: {
    aliases: ['как отправить отчет', 'как отправить отчёт о сервисе', 'как отправить чек', 'how to send a report', 'how do i send a service report'],
    ru: 'Сфотографируйте ресит из сервиса целиком, чтобы читались дата, машина, работы и стоимость. Добавьте фото общего пробега. Для отчёта откройте в Telegram-боте «Сервис» → «Отправить фото после сервиса».',
    en: 'Photograph the full service receipt so its date, vehicle, work and cost are readable. Add a photo of the total odometer reading. For a report, open “Service” → “Send photos after service” in the Telegram bot.',
    action: 'service',
  },
  service_filters: {
    aliases: ['когда менять фильтры', 'как часто менять фильтры', 'когда менять воздушный и салонный фильтры', 'фильтры при замене масла', 'when to change the filters', 'how often should the filters be changed'],
    ru: 'Воздушный фильтр двигателя и салонный фильтр меняют при каждой второй замене масла. Проверяйте фильтры и историю на каждом ТО: механик может не знать, какая замена масла по счёту. Если история неясна, уточните её в компании.',
    en: 'Replace the engine air filter and cabin filter at every second oil change. Check the filters and service history at each visit; the mechanic may not know which oil change this is. If the history is unclear, confirm it with the company.',
    source: 'Prime Fusion mobile handbook 2.2, page 58; owner clarification 2026-09-30',
  },
  service_interval: {
    aliases: ['когда ехать на то', 'когда менять масло', 'через сколько миль делать то', 'when should i get an oil change', 'when is service due'],
    ru: 'Планируйте ТО примерно через 6 000 миль после предыдущего обслуживания и пройдите его не позднее 7 000 миль. Если пробег с прошлого ТО неизвестен, проверьте историю или уточните его в компании.',
    en: 'Plan service about 6,000 miles after the previous visit and complete it no later than 7,000 miles. If the mileage since the last service is unknown, check the history or ask the company.',
    source: 'Prime Fusion mobile handbook 2.2, page 57',
  },
  no_vehicle_transfer: {
    aliases: ['может ли брат водить арендованную машину', 'могу ли я передать машину другому водителю', 'can my brother drive the rental car for one day if he has a tlc license', 'can someone else drive my rental car'],
    ru: 'Нет. Не передавайте арендованный автомобиль другому человеку, даже родственнику с TLC-лицензией и даже на один день. При особой ситуации напишите компании; до ответа машину не передавайте.',
    en: 'No. Do not let anyone else drive the rental car, even a relative with a TLC license for one day. Contact the company about a special situation; do not hand over the car while waiting.',
    source: 'Owner-confirmed renter rule: no transfer of the vehicle',
  },
  dmv_form: {
    aliases: ['где взять бланк дмв', 'где взять бланк dmv', 'кому отдать бланк', 'where do i get the dmv form', 'where to get dmv form'],
    ru: 'Возьмите бланк проверки в компании или распечатайте его и передайте в сервисе лично Гарри или Алексу. Расходники компании получите заранее по договорённости. После DMV отправьте в Telegram-боте заполненный бланк, четыре стороны машины и общий пробег.',
    en: 'Pick up or print the checklist and hand it directly to Harry or Alex at the shop. Arrange to collect any company-provided supplies in advance. After DMV, send the completed checklist, photos of all four sides of the car and the total odometer reading through the Telegram bot.',
    action: 'dmv',
  },
  inspection_photos: {
    aliases: ['какие фото нужны после инспекции', 'какие фото нужны для дмв', 'what photos are needed after inspection'],
    ru: 'После DMV отправьте заполненный бланк проверки, фото машины спереди, сзади, слева и справа и фото общего пробега. Откройте в Telegram-боте «DMV-инспекция» → «Отправить фото после DMV».',
    en: 'After DMV, send the completed checklist, photos of the front, rear, left and right sides of the car, and the total odometer reading. Open “DMV inspection” → “Send photos after DMV” in the Telegram bot.',
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
    aliases: ['как подать заявку', 'хочу подать заявку', 'хочу арендовать машину', 'ищу машину', 'how to apply', 'how do i apply', 'i want to rent a car'],
    ru: 'Нажмите «Подать заявку» и ответьте на вопросы. Заявка не гарантирует получение машины и не является бронированием. Возможность, условия и время выдачи Prime Fusion подтверждает отдельно.',
    en: 'Tap “Apply to rent” and answer the questions. An application does not guarantee a car or reserve one. Prime Fusion separately confirms availability, terms and pickup time.',
    action: 'apply',
  },
  availability: {
    aliases: ['есть свободные машины', 'какие машины есть в наличии', 'машина забронирована после заявки', 'do you have cars available', 'does my application reserve a car'],
    ru: 'Актуальное наличие нужно подтвердить в Prime Fusion. Подайте заявку: возможность, условия и время выдачи компания согласует отдельно. Заявка не гарантирует машину и не является бронированием.',
    en: 'Prime Fusion needs to confirm current availability. Submit an application; the company will confirm availability, terms and pickup time separately. Applying does not guarantee or reserve a car.',
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
    aliases: ['нет убера и лифта', 'нет uber и lyft заявка пройдет', 'нет uber и lyft', 'i have no uber or lyft account', 'can i apply without uber or lyft'],
    ru: 'Даже без Uber и Lyft можно подать заявку. Ответьте «Нет» на оба вопроса. Нужен стаж DMV не менее 1 года.',
    en: 'You can apply without Uber or Lyft accounts. Answer “No” to both questions. At least 1 year with a DMV driver license is required.',
    action: 'apply',
  },
  application_requirements: {
    aliases: ['какие требования к стажу dmv', 'какие требования к стажу дмв', 'какие требования для аренды', 'what are the requirements to apply', 'what dmv experience do i need'],
    ru: 'Для заявки нужен стаж по правам DMV не менее 1 года. Отсутствие Uber или Lyft не мешает подать заявку. Бот также спросит о стаже TLC. Окончательные условия и возможность выдачи подтверждает Prime Fusion. Нажмите «Подать заявку».',
    en: 'You need at least 1 year with a DMV driver license to apply. You can apply without Uber or Lyft accounts. The bot will also ask about your TLC experience. Prime Fusion confirms the final terms and whether a vehicle can be provided. Tap “Apply to rent”.',
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
  return String(text || '').normalize('NFKC').toLowerCase().replace(/ё/g, 'е').trim()
    .replace(/[?!.,:;]+$/g, '').replace(/\s+/g, ' ').trim();
}
// Strip only standalone greeting/courtesy phrases at the edges. Never use fuzzy
// substring matching: a compound question or personal dispute must go to AI.
function withoutCourtesy(text) {
  let value = normalize(text);
  const prefix = /^(?:(?:здравствуйте|добрый день|привет|подскажите|скажите|пожалуйста|hello|hi|please|could you tell me|can you tell me)(?:[\s,!:;.]+))+/iu;
  const suffix = /(?:[\s,!:;.]+(?:пожалуйста|спасибо|заранее спасибо|please|thanks|thank you))+$/iu;
  return normalize(value.replace(prefix, '').replace(suffix, ''));
}
const INDEX = new Map();
for (const [id, answer] of Object.entries(ANSWERS)) {
  for (const alias of answer.aliases) INDEX.set(normalize(alias), id);
}
function lookup({ text = '', topic = null, language = null, hasPhoto = false }) {
  if (hasPhoto) return null;
  const normalized = normalize(text);
  const id = topic && !normalized ? topic : INDEX.get(normalized) || INDEX.get(withoutCourtesy(text));
  if (!id || !ANSWERS[id]) return null;
  const lang = /[\u10a0-\u10ff\u1c90-\u1cbf]/u.test(text) ? 'ka' : /[а-яё]/i.test(text) ? 'ru' : normalized ? 'en' : language;
  const answer = ANSWERS[id];
  if (!answer[lang]) return null;
  return { id, text: answer[lang], language: lang, action: answer.action || null, source: answer.source || SOURCE, version: VERSION };
}
module.exports = { lookup, normalize, withoutCourtesy, ANSWERS, VERSION };
