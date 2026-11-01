// Approved navigation/service answers, versioned independently of model prompts.
// Exact normalized aliases only: ambiguous, compound and personal requests go to AI.
const VERSION = '2026-10-31.2';
const SOURCE = 'Reviewed owner rules and Lease 1.4 EN';
const ANSWERS = {
  stop_conversation: { aliases: ["stop", "stop. не продолжай этот разговор", "не продолжай этот разговор"], ru: "Понял. Останавливаю разговор.", en: "Understood. I will stop here." },
  resolved_thanks: {aliases:["спасибо, вопрос решён", "спасибо, вопрос решен", "thanks, my question is resolved", "მადლობა, ჩემი კითხვა ამოწურულია"], ru:"Пожалуйста.", en:"You’re welcome.", ka:"არაფრის."},
  "service_choice": {
    "aliases": [
      "сервис",
      "service",
      "то"
    ],
    "ru": "Что нужно уточнить?\nВыберите адрес сервиса, отправку отчёта или вопрос сотруднику.",
    "en": "What do you need?\nChoose the service address, sending a report, or a question for a staff member.",
    "action": "service_choice"
  },
  "service_address": {
    "aliases": [
      "где сервис",
      "куда на то",
      "адрес мастерской",
      "куда ехать на сервис",
      "where is the service shop",
      "where to get service"
    ],
    "ru": "KRS Auto Doctor — основной сервис.\n2965 86th Street, Brooklyn, NY 11223\n(718) 891-6626\nБез записи. Удобнее приехать к открытию.\n\nИгорь — электрика и мелкий ремонт.\n2029 E 24th St, Brooklyn, NY\n(646) 420-7572\nПосле 10:00, по предварительной договорённости.\n\nПлатный ремонт за счёт компании сначала согласуйте с Prime Fusion.",
    "en": "KRS Auto Doctor — main service shop.\n2965 86th Street, Brooklyn, NY 11223\n(718) 891-6626\nNo appointment. Arriving at opening is recommended.\n\nIgor — electrical work and minor repairs.\n2029 E 24th St, Brooklyn, NY\n(646) 420-7572\nAfter 10 a.m., by prior arrangement.\n\nGet Prime Fusion approval before ordering paid repairs at the company’s expense.",
    "source": "Original RU Mobile handbook 2026-09-21, page 50"
  },
  "handbook": {
    "aliases": [
      "где скачать хендбук",
      "скачать хендбук",
      "где хендбук",
      "download handbook",
      "where can i download the handbook"
    ],
    "ru": "Актуальная русская версия хендбука — в разделе документов: https://primefusioncars.com/?lang=ru#docs",
    "en": "The current English handbook is in Documents: https://primefusioncars.com/?lang=en#docs",
    "action": "handbook",
    "source": "Owner decisions 2026-10-31; Lease 1.4 EN"
  },
  "service_report": {
    "aliases": [
      "как отправить отчет",
      "как отправить отчёт о сервисе",
      "как отправить чек",
      "how to send a report",
      "how do i send a service report"
    ],
    "ru": "Отправьте Алексу по рабочему каналу фото всей квитанции и общего одометра, не Trip. В квитанции должны читаться дата, автомобиль, работы и цена каждой позиции; для масла — марка, вязкость и количество. Бланк не нужен. Дождитесь подтверждения приёма отчёта.",
    "en": "Send Alex the complete receipt and total odometer photo through your established service channel, not a Trip reading. The receipt should show the date, vehicle, work and itemized prices, including oil brand, viscosity and quantity. No company form is required. Wait for confirmation that the report was accepted.",
    "source": "Owner decisions 2026-10-31; Lease 1.4 EN"
  },
  "service_filters": {
    "aliases": [
      "когда менять фильтры",
      "как часто менять фильтры",
      "когда менять воздушный и салонный фильтры",
      "фильтры при замене масла",
      "when to change the filters",
      "how often should the filters be changed"
    ],
    "ru": "Воздушный фильтр двигателя и салонный фильтр меняют при каждой второй замене масла. Проверяйте их и историю обслуживания на каждом ТО: механик может не знать, какая замена масла по счёту. Если история неясна, уточните в компании; не считайте текущую замену «второй» наугад.",
    "en": "Replace the engine air filter and cabin filter at every second oil change. Check the filters and service history at every visit, since the mechanic may not know which oil change this is. If the history is unclear, confirm it with the company.",
    "source": "Prime Fusion mobile handbook 2.2 (2026-10-01), page 58; owner clarification (2026-10-01)"
  },
  "service_interval": {
    "aliases": [
      "когда ехать на то",
      "когда менять масло",
      "через сколько миль делать то",
      "when should i get an oil change",
      "when is service due"
    ],
    "ru": "Планируйте ТО примерно через 6 000 миль после предыдущего обслуживания и пройдите его не позднее 7 000 миль. Если пробег с прошлого ТО неизвестен, проверьте историю обслуживания или уточните его в компании.",
    "en": "Plan service about 6,000 miles after the previous visit and complete it no later than 7,000 miles. If you do not know the mileage since the last service, check the service history or ask the company.",
    "source": "Prime Fusion mobile handbook 2.2 (2026-10-01), page 57"
  },
  "no_vehicle_transfer": {
    "aliases": [
      "может ли брат водить арендованную машину",
      "могу ли я передать машину другому водителю",
      "can my brother drive the rental car for one day if he has a tlc license",
      "can someone else drive my rental car"
    ],
    "ru": "До подтверждённого допуска не передавайте автомобиль другому водителю. По договору 1.4 второго водителя можно согласовать с компанией и, когда требуется, страховщиком. Родства или одной TLC-лицензии недостаточно.",
    "en": "Do not hand over the car before the additional driver is approved. Lease 1.4 allows a second driver with prior company approval and insurer approval when required. Being a relative or holding a TLC license alone is not enough.",
    "source": "Owner decisions 2026-10-31; Lease 1.4 EN"
  },
  "dmv_form": {
    "aliases": [
      "где взять бланк дмв",
      "где взять бланк dmv",
      "кому отдать бланк",
      "where do i get the dmv form",
      "where to get dmv form"
    ],
    "ru": "Бланки отменены — получать, печатать или передавать их механику не нужно. Официальная DMV-инспекция остаётся обязательной; после неё нужны фото четырёх сторон машины и общего одометра.",
    "en": "The company forms have been retired; you do not need to collect, print or give one to the mechanic. The official DMV inspection is still required. Afterwards, provide photos of all four sides of the car and the total odometer.",
    "source": "Owner decisions 2026-10-31; Lease 1.4 EN"
  },
  "inspection_photos": {
    "aliases": [
      "какие фото нужны после инспекции",
      "какие фото нужны для дмв",
      "какие фотографии нужно отправить после dmv-инспекции",
      "что отправить после dmv",
      "what photos are needed after inspection",
      "what should i send after dmv"
    ],
    "ru": "После DMV-инспекции нужны фото машины спереди, сзади, слева и справа, а также общего одометра. Бланк не требуется. Фотоотчёт сам по себе не подтверждает официальный результат инспекции.",
    "en": "After the DMV inspection, provide front, rear, left and right photos of the car and a total odometer photo. No company form is required. These photos alone do not confirm the official inspection result.",
    "source": "Owner decisions 2026-10-31; Lease 1.4 EN"
  },
  "dmv_status_from_report": {
    "aliases": [],
    "ru": "Внутренний фотоотчёт не подтверждает официальный результат DMV-инспекции. Я не могу по сообщению подтвердить, можно ли сейчас работать: сверьте официальный результат и срок машины с компанией. Бланк отменён; для отчёта нужны четыре стороны машины и общий одометр.",
    "en": "An internal photo report does not confirm the official DMV inspection result. I cannot confirm from a message whether you may work; check your vehicle’s official result and deadline with the company. The company form has been retired; report photos show all four sides and the total odometer.",
    "source": "Owner decisions 2026-10-31; Lease 1.4 EN"
  },
  "odometer": {
    "aliases": [
      "что такое одометр",
      "где найти пробег",
      "какой пробег фотографировать",
      "what is an odometer",
      "where is the odometer"
    ],
    "ru": "Одометр показывает общий пробег автомобиля на приборной панели. Сфотографируйте экран так, чтобы все цифры были видны. Нужен общий пробег, а не Trip A или Trip B.",
    "en": "The odometer shows the vehicle’s total mileage on the dashboard. Take a photo with all numbers visible. Use the total mileage, not Trip A or Trip B."
  },
  "payment": {
    "aliases": [
      "где посмотреть следующий платеж",
      "где посмотреть дату платежа",
      "where can i see my next payment"
    ],
    "ru": "Откройте «Мой кабинет». В разделе «Следующий платёж» указаны дата и сумма. Если платёж уже внесён, но данные не совпадают, напишите об этом — нужна проверка сотрудника.",
    "en": "Open “My account”. “Next payment” shows the date and amount. If you already paid and the details do not match, tell us so a staff member can check.",
    "action": "account"
  },
  "mileage": {
    "aliases": [
      "где посмотреть пробег и лимит",
      "где посмотреть лимит пробега",
      "where can i see my mileage limit"
    ],
    "ru": "Откройте «Мой кабинет». Там показаны пробег за месяц и лимит вашего тарифа.",
    "en": "Open “My account” to see your monthly mileage and your plan’s mileage limit.",
    "action": "account"
  },
  "dmv_under_one": {
    "aliases": [
      "у меня меньше года дмв",
      "у меня меньше года dmv можно подать заявку",
      "i have less than one year with dmv"
    ],
    "ru": "Для аренды нужен стаж по правам DMV не менее 1 года. Подайте заявку, когда стаж достигнет 1 года.",
    "en": "You need at least 1 year with a DMV driver license to apply. Apply when you reach 1 year."
  },
  "dmv_two": {
    "aliases": [
      "у меня два года дмв можно подать заявку",
      "у меня два года dmv",
      "i have two years with dmv"
    ],
    "ru": "Да. Выберите «От 1 года до 3 лет». Заявка пройдёт дальше. Окончательные условия обсудит с вами Prime Fusion.",
    "en": "Yes. Choose “1 to less than 3 years”. You can continue the application. Prime Fusion will discuss the final terms with you.",
    "action": "apply"
  },
  "no_accounts": {
    "aliases": [
      "нет убера и лифта",
      "нет uber и lyft заявка пройдет",
      "нет uber и lyft",
      "i have no uber or lyft account"
    ],
    "ru": "Даже без Uber и Lyft можно подать заявку. Ответьте «Нет» на оба вопроса. Нужен стаж DMV не менее 1 года.",
    "en": "You can apply without Uber or Lyft accounts. Answer “No” to both questions. At least 1 year with a DMV driver license is required.",
    "action": "apply"
  }
};

function normalize(text) {
  return String(text || '').normalize('NFKC').toLowerCase().replace(/ё/g, 'е')
    .replace(/[?!.,:;]+$/g, '').replace(/\s+/g, ' ').trim();
}
const INDEX = new Map();
for (const [id, answer] of Object.entries(ANSWERS)) {
  for (const alias of answer.aliases) INDEX.set(normalize(alias), id);
}

// The model previously reversed the owner's filter rule when a driver asked
// which oil change this was. Keep this narrow intent deterministic, while
// personal payments, faults and compound requests still go to the assistant.
function filterHistoryIntent(value) {
  const filter = /фильтр|\bfilters?\b/iu.test(value);
  const service = /масл|замен|\b(?:oil|change|service|mechanic)\b|механик/iu.test(value);
  const rule = /не зна|не помн|какая|какой|сколько|по сч[её]ту|истори|втор|кажд|когда|как часто|по состоянию|\b(?:unknown|know|which|second|every|history|condition)\b/iu.test(value);
  const otherIssue = /ремонт|полом|заглох|не завод|дым|авари|страхов|штраф|депозит|долг|оплат|стоим|цена|dmv|инспек|заяв|\b(?:repair|stalled|breakdown|accident|crash|claim|ticket|deposit|paid|payment|price|charge|refund|inspection)\b/iu.test(value);
  return filter && service && rule && !otherIssue;
}

function unverifiedDmvWorkIntent(value) {
  const inspection = /\bdmv\b|дмв|инспекц|inspection/iu.test(value);
  const evidence = /бланк|фото|снимк|отч[её]т|чек-?лист|документ|\b(?:photos?|reports?|checklists?|forms?)\b/iu.test(value);
  const workOrStatus = /можно|могу|разреш|ехать|ездить|работ|официальн|пройд|зачт|подтвержд|статус|\b(?:can|may|drive|work|operate|passed|approved|complete|confirmed|status)\b/iu.test(value);
  return inspection && evidence && workOrStatus;
}

function lookup({ text = '', topic = null, language = null, hasPhoto = false }) {
  if (hasPhoto) return null;
  const normalized = normalize(text);
  const id = topic && !normalized ? topic : INDEX.get(normalized) || (filterHistoryIntent(normalized) ? 'service_filters' : null) || (unverifiedDmvWorkIntent(normalized) ? 'dmv_status_from_report' : null);
  if (!id || !ANSWERS[id]) return null;
  const lang = /[\u10a0-\u10ff\u1c90-\u1cbf]/u.test(text) ? 'ka' : /[а-яё]/i.test(text) ? 'ru' : normalized ? 'en' : language;
  const answer = ANSWERS[id];
  if (!answer[lang]) return null;
  return { id, text: answer[lang], language: lang, action: answer.action || null, source: answer.source || SOURCE, version: VERSION };
}
module.exports = { lookup, normalize, ANSWERS, VERSION };
