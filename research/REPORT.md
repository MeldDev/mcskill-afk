# Проверка реализации, 2026-10-14

Локальная сборка: `Industrial_1.7.10`. Секреты launcher args не включены в этот отчёт. В процессе исследования CFR 0.152 читает только классы библиотек; результаты декомпиляции и сам декомпилятор исключены из Git.

## Проверенные локальные библиотеки

| Файл | SHA-256 |
|---|---|
| `libraries/authlib-1.5.21.jar` | `21c54767b9f92047b0cebfe02aff749231e05db8c76b0041917dfa83de04cf72` |
| `forge.jar` | `81cd8028eef9aed6b15ccfa94f5b3215c9a282f25e3c074f1897e8a65c9a0a23` |
| `mods/metahandshakepatcher-1.0.0-client.jar` | `24cebff38993c71eb1cdc35d6c96e94480b1547ea6296d1365e1b4022c1ee055` |

Декомпиляция `YggdrasilMinecraftSessionService.joinServer` и `YggdrasilAuthenticationService.makeRequest` подтверждает POST JSON: `accessToken`, `selectedProfile` (UUID без дефисов через UUIDTypeAdapter), `serverId`. Современный endpoint `/join1710`; legacy `/joinserver1710.php` выбирается `authlib.legacy`. Проверка сервера: GET `/hasjoined1710?username=...&serverId=...` или legacy `/checkserver1710.php`; клиент не вызывает hasJoined вместо Minecraft-сервера. Свойство `minecraft.api.auth` в текущем launcher args задаёт `https://auth.mcskill.ru`, legacy не включён. Locale fallback может выбрать `.net`.

SHA-1 считается над Latin-1 serverId, 16-байтовым случайным shared secret и DER public key; hex — знаковое число two's complement как Java BigInteger. После успешного join публичный RSA-ключ сервера шифрует secret и verifyToken отдельно с PKCS#1 v1.5; Encryption Response передаётся открытым. Дальнейший TCP-поток шифруется AES-128-CFB8, IV=secret, независимые состояния для направлений, без сброса на границе пакета.

## Forge и сборочные отличия

Изучены [node-minecraft-protocol](https://github.com/PrismarineJS/node-minecraft-protocol), [forge-плагин](https://github.com/PrismarineJS/node-minecraft-protocol-forge), [FML 1.7.10 message definitions](https://github.com/MinecraftForge/FML/blob/1.7.10/src/main/java/cpw/mods/fml/common/network/handshake/FMLHandshakeMessage.java), [client states](https://github.com/MinecraftForge/FML/blob/1.7.10/src/main/java/cpw/mods/fml/common/network/handshake/FMLHandshakeClientState.java) и [Crucible](https://github.com/CrucibleMC/Crucible). Форматы protocol 5 сверены с [minecraft-data 1.7](https://github.com/PrismarineJS/minecraft-data/blob/master/data/pc/1.7/protocol.json) и локальными классами Minecraft.

PrismarineJS forge-плагин разбирает discriminator 3 как `RegistryData` с `hasMore`, тогда как установленный FML 1.7.10 использует `ModIdData`: count, пары string/VarInt, block substitutions, item substitutions. Плагин не выбран runtime-зависимостью; слепая установка последней версии не решает совместимость данной сборки.

Локально подтверждено по байткоду:

- `MetaHandshakePatcher` перед `ClientHello` version пишет int snapshot identifier. Клиент отправляет 0: нет кэшированного snapshot, требуется полная карта.
- `MetaLib 2.1.3` дописывает полный int dimension в конец Join Game. Байтовое поле vanilla остаётся на месте.
- Forge S3F custom payload использует VarShort: младшие 15 бит + условный старший байт. Hodgepodge расширяет sentinel `0x7fffff` дополнительным VarInt. Это необходимо для большого `ModIdData`.
- Vanilla `bjb`/`fu`/`jf`: S08 содержит Y позиции игрока (eye height); ответ C06 передаёт boundingBox.minY, затем posY. Клиент использует feetY=receivedY−1.62, stanceY=receivedY. Teleport Confirm из новых протоколов не отправляется.
- FML hello, клиентский ModList, Ack 2, ModIdData, Ack 3, сервер Ack 2, Ack 4, сервер Ack 3, Ack 5. Поддержан HandshakeReset для переподключений между мирами.

Включён manifest из 174 наблюдавшихся локально записей FML state report. Сервер на тесте прислал 153 мода и принял этот manifest. Число записей manifest не означает, что клиент запускает код этих модов. Неизвестные модовые сообщения не исполняются и не получают выдуманных подтверждений.

## Проверки

Автотесты: 26 сценариев, включая реальный localhost TCP c RSA/AES login, Forge, Join Game, position, KeepAlive, abort и переподключение. Тестовые токены вымышленные. NIST AES-CFB8 vector и стандартные signed SHA1 vectors проверены. На Windows sandbox применён `node --test --test-isolation=none`: child-process isolation этой среды запрещает spawn.

Живой тест: штатная пользовательская сессия, один аккаунт, без обхода 2FA. Подтверждены Encryption Request → официальный join → зашифрованный Login Success → FML complete → Join Game → позиция → KeepAlive. Во время разработки несколько разовых входов завершались при диагностике неподдержанных форматов; после исследования VarShort и MetaLib формат исправлен.

Устойчивая сессия: **20:33:54–20:43:54 UTC, 10 минут**. Проверка завершилась `PASSED`, получено **106763 пакета**, обработано **292 KeepAlive**. Минутные замеры RSS: **52–53 MiB**, heap **6–7 MiB**; роста удерживаемой памяти за этот интервал не обнаружено. Это измерение Windows/Node 24.13.1, а не обещание расхода памяти на любой VPS.

Дополнительная живая проверка `tools/verify-live-reconnect.js` на окончательном коде: в **20:44:18 UTC** закрыт собственный TCP-сокет; после **13959 ms** backoff клиент повторно прошёл официальный join, Login Success и весь Forge handshake. В **20:44:35 UTC** снова получен `world_ready`; следующая минута прошла с 28 KeepAlive. Итог — `live_reconnect_passed`, exit 0, оба тестовых соединения закрыты. RSS **53 MiB**. Суммарное CPU-время процесса **422 ms** за **94.288 s** wall time (около **0.45% одного ядра** на этой Windows-машине; VPS CPU этим не измерен).

Ubuntu/systemd не запущены: текущая среда Windows, WSL-дистрибутива нет, доступа к VPS в сессии нет. Подготовлены unit, установщик, ограничения памяти и воспроизводимые команды. Проверка нового IP, SIGTERM от Linux service manager, cgroup MemoryMax, CPU и работа сутками остаются проверками VPS. Механизм остановки/очистки ресурсов проверен через AbortSignal в тестах, ОС-сигналы подключены к нему в CLI.

## Дополнение: отдельный аккаунт с логином и паролем

Найден официальный `AppData/Roaming/MCSkill/updates/Launcher.jar`. В нём включены исходные protobuf-схемы `launcher/auth.proto` и `launcher/common.proto`: `launcher.AuthService/Login`, поля username=1, password=2, totp=3; результат session_data=3, mfa_required=4, totp=5. Session содержит id=1 и profile=2; PlayerProfile — uuid=1, username=2. Декомпилированный AuthRepository и преобразователь LoginResponse подтверждают эту последовательность. LaunchGameUseCase передаёт полученный Session.id как Minecraft `--accessToken` для 1.7.10.

Проверенные в байткоде маршруты: `launchernew.mcskill.ru:443` (ru) и `launchernew.mcskill.net:443` (eu), TLS включён. Новый `src/launcher-auth.js` использует HTTP/2/gRPC по этим двум разрешённым адресам, без перенаправлений и автоматических повторов пароля. Ошибки и ответы сервера не выводятся целиком. При MFA/TOTP выполняется остановка, без обхода проверки.

`START-BOT.cmd` запускает интерактивный `tools/login-and-afk.js`: скрытый ввод пароля, получение отдельной сессии в память и запуск AFK. Существующий `session.json` и токен из окружения не используются и не меняются; пароль и новая сессия в файлы не записываются. Первый аккаунт для этих проверок не подключался.

После дополнения проходят **32 автотеста**, включая protobuf, challenge branches, проверку разрешённых origin, очистку буфера запроса и настоящий локальный HTTP/2/gRPC обмен с фрагментацией и trailers. Пароль второго аккаунта не предоставлен, поэтому реальный вход новым способом и интерактивный ввод в окне пользователя ещё не проверены. Первый живой тест второго аккаунта выполняется пользователем через `START-BOT.cmd`.

## Дополнение: минутный цикл переподключений

По запросу пользователя стандартная политика изменена: fixed delay 60000 ms после сетевого сбоя или завершения неудачной попытки, `MC_MAX_RETRIES=-1` — неограниченное количество повторов. Jitter в стандартном режиме отсутствует. При живом соединении периодического выхода/входа нет. Прежний backoff сохранён как явно выбираемый режим.

Добавлена ограниченная классификация серверного Disconnect: сообщения о рестарте, технических работах, заполненном/недоступном сервере допускают повтор, а отказ авторизации, AFK, бан и неизвестные отключения остаются терминальными. Исходный текст сервера не логируется. Проверены 25 последовательных повторов с точной паузой 60000 ms через управляемый таймер, конечный лимит, прерывание реального ожидания AbortSignal и рестартовый Disconnect на localhost TCP. Итог: **39 автотестов проходят**. Для этой правки реальные аккаунты не подключались.

## Дополнение: чат и подтверждаемый сброс инвентаря

Добавлены `src/chat.js`, `src/console.js`, `src/inventory.js`. S02 chat преобразуется из JSON/legacy-кодов в безопасный обычный текст. C01 chat принимает сообщения/команды до 100 символов, только в готовом мире, не чаще раза в секунду. Readline сохраняет набираемую строку при появлении чата и диагностик; очередь вывода ограничена, при медленном stdout строки пропускаются. История ввода не ведётся. `MC_CHAT=0` отключает показ сообщений; при systemd они иначе попадают в journal.

Обычный инвентарь синхронизируется по S30/S2F: максимум 45 сохраняемых записей (ID/count/damage/SHA-256 fingerprint), без распаковки/сохранения compressed NBT. Форматы сверены с minecraft-data protocol 5 и локальным `LuxinfinePacketUnlimitter` для short=32767 с последующим int+bytes. Иные окна не используются для действий; после открытия стороннего контейнера требуется свежий полный снимок.

Локальная декомпиляция Minecraft `zs` (Container) подтверждает: slotClick mode=4/button=1 выбрасывает весь стак при пустом курсоре и возвращает null. Используется C0E window=0, slot=1..44, button=1, action=short, mode=4, clickedItem=-1. Слот 0 с производным результатом крафта исключён; броня/крафт/хотбар включены в явное предупреждение. После каждого пакета обязательны положительный S32 и обновление слота до пустого; между стаками минимум 300 ms, таймаут 5 секунд. Нет массовой отправки пакетов, распаковки рюкзаков, автоповтора или продолжения сброса после reconnect.

Для запуска требуется `:dropall` с конкретным списком стаков, затем `:confirm` с одноразовым кодом в течение 30 секунд. Сам просмотр инвентаря и подготовка подтверждения пакеты действий не отправляют. При изменении данных, отказе, таймауте или закрытии сессии очередь сброса отменяется. Сообщения сервера никогда не интерпретируются как локальные команды. `:cancel` отменяет только ещё не выполненные действия.

Итог: **52 автотеста проходят**, включая JSON-chat/control-sequence sanitization, ограничения отправки, сохранение редактируемой строки, ограничение вывода, подтверждение/истечение кода, форматы инвентаря/NBT, очередность Transaction/SetSlot, timeout/reject/cancel. Зашифрованный localhost TCP mock дополнен приёмом/отправкой чата и одним подтверждённым сбросом тестового стака. На живых аккаунтах сообщения и команды не отправлялись, вещи не выбрасывались; окончательная совместимость новых функций с серверными модами остаётся проверкой пользователя.

## Дополнение: установка Ubuntu одной командой

Добавлены `install-ubuntu.sh` и `start.sh`: целевая Ubuntu 22.04+ x86_64, Ubuntu-пакеты через apt, приватный Node.js из официального latest-v24.x с проверкой SHA256, npm ci/test и shell smoke. Приватный runtime исключён из Git и не заменяет системный Node.js. Официальный manifest проверен HTTPS-запросом из текущей среды; найден ровно один подходящий Linux x64 `.tar.xz` (`node-v24.22.0-linux-x64.tar.xz` на момент проверки). Это проверка manifest, не установка Linux binary на Windows.

Запуск: `./start.sh` — ввод логина/пароля отдельного аккаунта; `--tmux` — постоянная интерактивная консоль с повторным присоединением; `--session` — ранее подтверждённый session.json; `--probe` — проверка без credentials. `--service` у установщика подготавливает unit и отдельную копию Node binary в `/opt/mcskill-afk/runtime/node`, не запускает сервис и не копирует токены из рабочего каталога. Активный сервис необходимо остановить перед заменой binary. Полный systemd запуск по-прежнему требует приватную подтверждённую сессию владельца сервиса.

Через Git Bash успешно выполнены `bash -n` и `test/deploy-smoke.sh`: real start.sh с подставным runtime, запуск вне корня checkout, пробелы в пути, login/session/probe, неверные параметры, неподдерживаемая версия Node, help. Тест не запускает apt, не устанавливает системные программы и не подключается к Minecraft. Временный каталог перед рекурсивной очисткой проверяется по разрешённому абсолютному префиксу внутри `.runtime`. В архив добавлены shell-файлы и `.gitattributes` для LF endings. Полную установку apt, исполнение Linux Node binary и service manager на Ubuntu в текущей Windows-среде выполнить невозможно.
