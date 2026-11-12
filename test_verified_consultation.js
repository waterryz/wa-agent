const test=require('node:test'),assert=require('node:assert/strict');
const {consultation,chooseLiteralOption}=require('./verified_consultation');
test('public guidance distinguishes weekly rates, scope, uncertain outcomes and safe assistance',()=>{
 const cases=[['Как выбрать тариф по месячному пробегу?',/В НЕДЕЛЮ/],['У вас наверняка скрытые платежи',/лимите ущерба\$5000/],['Анкета зависла после отправки, отправьте ещё раз',/не доказывает фишинг/],['Пассажир предлагает наличные за поездку',/лицензированной базу|лицензированную базу/],['Ребёнок один, можно везти?',/Не оставляйте ребёнка/],['Помощь с посадкой клиента с коляской',/получите согласие/],['После поездки разбито окно',/само по себе не доказывает/],['Другой водитель после столкновения уехал',/Не преследуйте/]];
 for(const [q,re]of cases){const v=consultation(q);assert(v,q);assert.match(v.text,re,q);assert.equal(v.action,null);}
 assert.equal(consultation('Можно сменить тариф в моём подписанном договоре?'),null);
 assert.equal(consultation('Пассажир предлагает наличные за поездку','en'),null);
});
test('multiple-choice label is reconciled only against a unique literal option, never an answer key',()=>{
 const q='Когда?\nА)Завтра.\nБ)Уведомить компанию минимум за три дня.\nВ)Задним числом.';
 assert.match(chooseLiteralOption(q,'В) Уведомить компанию минимум за три календарных дня.\nПояснение.'),/^Б\)/);
 assert.equal(chooseLiteralOption(q,'В) Задним числом.'),'В) Задним числом.');
 assert.match(chooseLiteralOption(q,'В. Уведомить компанию минимум за три календарных дня. Переход с первого числа.'),/^Б\./);
 assert.equal(chooseLiteralOption(q,'Не уверен.'),'Не уверен.');
 assert.equal(chooseLiteralOption('Без вариантов','А) Да'),'А) Да');
});
test('ambiguous warning and onboarding never grant unsafe movement or invent submission',()=>{
 assert.match(consultation('Автомобиль сказал, что хочет пить').text,/без диагноза/);
 assert.match(consultation('Какие предупреждения на приборной панели нельзя путать с сервисным напоминанием?').text,/нельзя разрешать движение/);
 assert.match(consultation('Компания запрещает эксплуатацию из-за погоды').text,/не продолжайте до конца заказа/);
 assert.match(consultation('Я впервые у вас на сайте, с чего начать?').text,/На каком языке/);
 assert.match(consultation('Хочу оставить заявку').text,/заявку не отправлял/);
});
