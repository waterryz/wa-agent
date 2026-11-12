const test=require('node:test'),assert=require('node:assert/strict');
const {acuteSafety}=require('./acute_safety');
test('explicit hazards stop unsafe continuation and preserve emergency priority',()=>{
 for(const t of ['Я засыпаю за рулём, но пассажир ещё в машине','У меня сильное кровотечение','Загорелся красный индикатор давления масла','При торможении сильный скрежет','Шина теряет давление','Рампа не поднимается','Запах гари в салоне','Птицы окружили машину и не дают выехать']){
  const a=acuteSafety(t);assert(a,t);assert.equal(a.action,null);assert(a.text.length>80);
 }
 assert.match(acuteSafety('У меня сильное кровотечение').text,/911 сейчас/);
 assert.match(acuteSafety('Красный индикатор масла').text,/выключите двигатель/);
 assert.match(acuteSafety('I am falling asleep while driving','en').text,/do not try to finish/);
 assert.match(acuteSafety('The tire is losing pressure','en').text,/Stop safely/);
  assert.match(acuteSafety('У меня паническая атака с пассажиром в машине').text,/боль в груди/);
  assert.match(acuteSafety('I am having a panic attack','en').text,/Call911 now/);
});
test('routine, negated, historic and unrelated content does not trigger an acute response',()=>{
 for(const t of ['Какое масло использовать?','Когда менять шины?','Кровь уже не течёт','Нет запаха бензина','Вчера шина спускала, уже починили','Сколько стоит аренда?','Плановый сервис через6000миль','Я на пароме, это морские мили?']) assert.equal(acuteSafety(t),null,t);
 assert.equal(acuteSafety('У меня сильное кровотечение','ka'),null);
 assert.equal(acuteSafety('Что делать при крови?\nА)911\nБ)Ждать'),null);
});
