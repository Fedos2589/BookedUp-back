---
name: back-api-contract
description: Используй при написании схем запросов и ответов об ошибках: zod, часовой пояс, длины строк, 400 и 409 в Swagger.
---

# Ввод на границе API и ответы об ошибках

Часть правил из `AGENTS.md`, вынесена в скилл, чтобы читаться только когда работа её касается.

- Часовой пояс бизнеса приводится в zod-схеме запроса к каноническому имени: `canonicalTimeZone` (`src/common/time-zone.ts`) берёт `resolvedOptions().timeZone` у `Intl.DateTimeFormat` (`europe/moscow` → `Europe/Moscow`) и отвергает смещения. `+03:00` Intl принимает, а Postgres читает как POSIX с обратным знаком: `AT TIME ZONE '+03:00'` уедет на 6 часов. Не `Intl.supportedValuesOf('timeZone')`: там только канонические имена, без `UTC` и старых алиасов. В базе CHECK не ставим — он зависел бы от версии tzdata на сервере.
- У каждой строки в схеме есть верхний предел длины. Слишком длинное значение — это 400 из схемы, а не 500 из уникального индекса Postgres. Пароль ограничен и в байтах после NFKC (4096): иначе `PasswordHasher.hash` бросит исключение.
- Email и slug приводятся к нижнему регистру до записи; CHECK в базе — страховка, а не основная проверка.
- 400 — тело не прошло zod-схему (`StandardSchemaValidationPipe`, подключён как `APP_PIPE` в `AppModule`, а не в `main.ts`, чтобы его получал любой запуск, включая тесты): `message` — массив строк вида `business.timeZone: Unknown IANA time zone`, путь поля перед двоеточием.
- 409 — занято уникальное значение: `{ statusCode, error, message, field }`, `field` — имя поля формы. Ошибку P2002 сопоставляем по имени ограничения (`users_email_key` → `email`, хелпер `src/prisma/unique-violation.ts`), не по тексту: адаптер pg сообщает индекс, а не колонки.
- У 400 и 409 в Swagger есть схема тела (`validationErrorSchema`, `conflictErrorSchema` из `src/common/api-errors.ts`), чтобы Orval сгенерировал фронту тип `field`.
- Регистрация сообщает, что email занят: обычный компромисс ради удобства. Вход (sign-in) так не делает: на неверный email и неверный пароль один и тот же ответ.
