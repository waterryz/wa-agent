'use strict';
// Conservative first actions for explicit acute hazards. No diagnosis, legal
// assessment, remote vehicle action, or permission to continue driving.
function acuteSafety(text, language='ru') {
  const t=String(text||'').trim();
  if (!['ru','en'].includes(language) || !t || t.length>1800 || /(?:^|\n)\s*[АБВABC][).]/m.test(t)) return null;
  // Questions about scheduled maintenance or past events remain in normal RAG.
  if (/(?:вчера|прошлой неделе|раньше|уже почин|уже устран|не теч|не кров|нет запах|не пахнет|yesterday|last week|already fixed|no smell|not bleeding)/i.test(t)) return null;
  let id,ru,en;
  if (/(?:засыпаю|клюю носом|проваливаюсь в сон|засыпать за рул|falling asleep|nodding off)/i.test(t)) {
    id='drowsy';ru='Безопасно остановитесь в разрешённом месте и прекратите поездку — не пытайтесь сначала довезти пассажира. Сообщите пассажиру и поддержке платформы, что продолжать небезопасно, организуйте дальнейшую поездку. Отдохните; не возвращайтесь за руль, пока сонливость не прошла. Кофе и открытое окно не заменяют отдых.';
    en='Pull over safely in a permitted location and stop driving; do not try to finish the ride first. Tell the passenger and platform support that continuing is unsafe and arrange onward transport. Rest and do not resume until you are alert. Coffee or an open window does not replace rest.';
  } else if (/(?:кров|bleed)/i.test(t)&&/(?:сильн|не останав|ль[её]т|хлещ|обильно|severe|heavily|won.t stop)/i.test(t)) {
    id='bleeding';ru='При сильном кровотечении вызовите911 сейчас. Если вы за рулём — сначала безопасно остановитесь. Прижмите рану чистой тканью и удерживайте постоянное прямое давление; по возможности используйте перчатки. Не ждите десять минут перед вызовом помощи и следуйте указаниям диспетчера. Не продолжайте работу.';
    en='Call911 now for severe bleeding. If driving, stop safely first. Apply firm, continuous direct pressure with a clean cloth; use gloves if available. Do not wait ten minutes before calling for help. Follow the dispatcher’s instructions and do not continue working.';
  } else if (/(?:красн.*(?:масл|давлен)|(?:масл|давлен).*красн|red.*oil|oil pressure.*(?:light|warning))/i.test(t)) {
    id='oil_pressure';ru='Безопасно остановитесь и выключите двигатель. Красный индикатор давления масла — не плановое напоминание оТО. Не оставляйте мотор работать на холостом ходу и не едьте в сервис своим ходом. Сообщите компании и согласуйте техническую помощь или эвакуацию.';
    en='Stop safely and switch off the engine. A red oil-pressure warning is not a scheduled-service reminder. Do not let the engine idle or drive to a shop. Contact the company to arrange technical help or towing.';
  } else if (/(?:тормоз|тормож|brak)/i.test(t)&&/(?:сильн.*скреж|скреж|провали|не работа|пропал|grind|fail|not working)/i.test(t)) {
    id='brakes';ru='Безопасно остановитесь и прекратите эксплуатацию. При скрежете или отказе тормозов нельзя обещать, что до сервиса можно доехать. Не проверяйте тормоза резким разгоном; сообщите компании и согласуйте осмотр на месте или эвакуацию. Если остановиться безопасно не удаётся или есть непосредственная опасность —911.';
    en='Stop as safely as possible and take the vehicle out of service. Grinding or failing brakes are not permission to drive to a shop. Do not accelerate to test them. Contact the company for an on-site assessment or towing; call911 if you cannot stop safely or face immediate danger.';
  } else if (/(?:шин|колес|tyre|tire)/i.test(t)&&/(?:теря.*давлен|спуска|утеч|losing pressure|deflat|leak)/i.test(t)) {
    id='tire';ru='Остановитесь безопасно и оцените состояние шины, не продолжая перевозку. С потерей давления нельзя гарантировать безопасную поездку в сервис или назначать универсальную скорость. Сообщите компании; согласуйте помощь на месте, замену или эвакуацию. Повреждённую или спущенную шину нельзя считать исправной после одной подкачки.';
    en='Stop safely and assess the tire without continuing the ride. A pressure leak does not justify driving to a shop at an invented “safe” speed. Contact the company to arrange on-site help, replacement or towing. Inflating a damaged tire does not establish that it is safe.';
  } else if (/(?:рамп|ramp)/i.test(t)&&/(?:не поднима|не фикс|не закры|застрял|won.t (?:close|raise|lock)|stuck|not secured)/i.test(t)) {
    id='ramp';ru='Не двигайтесь с опущенной или ненадёжно зафиксированной рампой и не используйте неисправное оборудование. Уточните у пассажира, какая помощь нужна, обеспечьте его безопасность без рискованного ручного перемещения. Свяжитесь с компанией и организуйте безопасную помощь или другую подходящую машину.';
    en='Do not move with the ramp lowered or unsecured, and do not use faulty equipment. Ask the passenger what assistance they need and keep them safe without risky manual lifting. Contact the company and arrange safe assistance or another suitable vehicle.';
  } else if (/(?:запах.*(?:гар|бензин|топлив)|пахнет.*(?:гар|бензин|топлив)|burning smell|smell.*(?:fuel|gasoline)|fuel.*smell)/i.test(t)) {
    id='fire_risk';ru='Безопасно остановитесь, выключите двигатель и выведите людей в безопасное место подальше от движения. Не продолжайте поездку даже без видимого дыма, не курите и не ищите утечку с огнём. При дыме, возгорании, утечке топлива или иной непосредственной опасности вызовите911. Сообщите компании и согласуйте помощь.';
    en='Stop safely, switch off the engine and move everyone to a safe place away from traffic. Do not finish the ride even if there is no visible smoke. Avoid flames and smoking. Call911 for smoke, fire, a fuel leak or immediate danger. Contact the company to arrange help.';
  } else if (/(?:птиц|birds)/i.test(t)&&/(?:окруж|не дают|перед машин|surround|blocking|in front)/i.test(t)) {
    id='birds';ru='Подождите, пока путь освободится. Не трогайтесь в расчёте на то, что птицы обязательно разлетятся, и не пытайтесь их давить или пугать. Если они не уходят, выберите безопасный свободный выезд либо попросите помощь.';
    en='Wait for a clear path. Do not drive toward the birds assuming they will fly away, or try to harm or frighten them. If they stay, use a safe, clear exit or seek assistance.';
  }
  return id?{id:'acute_'+id,text:language==='en'?en:ru,source:'Conservative acute-safety protocols; NHTSA/RedCross/vehicle safety guidance, reviewed2026-11-12',version:'2026-11-12.2',action:null}:null;
}
module.exports={acuteSafety};
