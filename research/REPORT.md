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

## Исправление: прокси доступен до завершения рестарта игрового сервера

Пользовательский лог выявил ошибку: PLAY SERVER_RESTART корректно запускал минутный reconnect, но следующий общий LOGIN Disconnect останавливал процесс, хотя прокси уже принимал TCP/Encryption Request, штатный join был принят, а игровой backend ещё не поднялся. Прежняя классификация считала любой неизвестный Disconnect окончательным независимо от состояния протокола.

Теперь классификатор получает LOGIN/PLAY. Неизвестный LOGIN refusal возвращает `SERVER_LOGIN_RETRY` и допускает неограниченные минутные повторы согласно обычной политике. Неизвестный PLAY kick остаётся терминальным; явные InvalidSession, неверные credentials, бан, AFK, whitelist, MFA/captcha и ошибки версии/hostname не обходятся. Временная недоступность сервера авторизации выделена отдельно. Исходные серверные строки по-прежнему не логируются. Исправлено вводящее в заблуждение сообщение интерфейса, предлагавшее повторный вход при любом завершении.

Итог: **57 автотестов проходят**, включая последовательность рестарт → 25 общих LOGIN отказов → восстановление, точные минутные паузы и сохранение остановки при реальном отказе сессии. Отдельный localhost TCP-сервер трижды возвращает общий LOGIN Disconnect, после чего возобновляет работу: цикл успешно продолжается и восстанавливается. Живое подключение к аккаунту пользователя и изменение файлов VPS при исправлении не выполнялись; обновление необходимо перенести на VPS.
# Постоянная работа и сохранение данных — 2026-10-16

После скрытого ввода пароля добавлено согласие `[y/N]`. При Y данные сохраняются только после принятого штатным launcher API входа. По умолчанию файл находится вне checkout: `~/.config/mcskill-afk/credentials.json`, Unix 0600, каталог 0700; Windows ACL текущего пользователя применяется до записи секрета. Запись через временный файл, fsync и rename. Пароль хранится открытым текстом, не включается в диагностику, архив и Git. Следующий запуск с сохранённым файлом не спрашивает данные. `--setup` заменяет данные, `--forget` удаляет локальный файл.

systemd переведён на `tools/login-and-afk.js --service`, приватные данные `/etc/mcskill-afk/credentials.json`; установщик копирует их с 0600 и правильным владельцем. Приложение повторяет сетевые ошибки и недоступность API раз в минуту. При AUTH_REJECTED или явном истечении сессии допускается один штатный повторный вход; повторный отказ свежей сессии останавливает цикл. Бан, AFK-kick, неверный пароль и MFA/TOTP не обходятся. Терминальные ошибки получают exit 78, исключённый из перезапуска. Аварии восстанавливаются через `Restart=on-failure`, `RestartSec=60`; enable обеспечивает запуск после загрузки VPS.

Проверено: 64 Node mock/unit/integration теста прошли на Windows, включая реальное применение Windows ACL к вымышленным данным; две Unix-проверки (0600 и отказ от symlink) пропущены на Windows. Bash smoke с setup/forget прошёл через Git Bash. Настройки перезапуска сверены с upstream systemd.service.xml. Секреты реального аккаунта не использовались, подключений к MCSkill в этом изменении не выполнялось. Полный запуск systemd, Linux-проверки и длительный прогон требуют Ubuntu VPS. Это обновление заменяет прежнее поведение с паролем только в памяти и Restart=no, описанное в исторических разделах ниже.
# Plugin message после входа в мир — 2026-10-16

По присланным владельцем логам Ubuntu: обновление и сохранение credentials прошли успешно, все 66 тестов прошли на Linux без пропусков; systemd получил world_ready. Затем packet id 63, bytes 33212 вызвал VarInt overflow. Сам пакет не предоставлен, поэтому точная схема его длины и канал не установлены. Удалён ненужный разбор внутренней длины для неизвестных plugin channels: содержимое этих каналов не используется, внешнее framing уже ограничено. FML|HS, REGISTER и UNREGISTER по-прежнему проверяются строго. Ошибка чтения имени канала теперь отдельно помечается в диагностике без вывода имени или содержимого.

Добавлены синтетический регрессионный тест неизвестного payload с ошибочной VarInt-длиной, фрагментацией TCP и следующим KeepAlive, а также тест сохранения строгих проверок FML/REGISTER. Это проверка проблемного пути, а не воспроизведение захваченных байтов сервера. Повторный живой прогон исправления остаётся на VPS.
# Восстановление после протокольного сбоя в мире — 2026-10-17

Новые логи VPS уточнили причину остановки: после 104 минутных попыток сервер принял вход и Forge handshake, затем после world_ready получен пакет id 96 (0x60), frame bytes 12300. PROTOCOL завершал процесс с кодом 78. Пиковая память по systemd 81.4 MiB, работа процесса 20 ч 42 мин. Содержимое пакета отсутствует; соответствующий поддерживаемый формат в исследованных локальных классах не установлен. Пакет не объявляется поддержанным и не пропускается вслепую.

Теперь MinecraftConnection.close помечает ProtocolError как retryable только если текущая сессия уже получила world_ready. Поток TCP/AES закрывается; обычный reconnect создаёт полностью новое соединение через 60 секунд. Ошибки до готовности мира остаются терминальными; явные ограничения аккаунта и AFK-kick не меняются. Это восстановление после сбоя, а не реализация неизвестного пакета: постоянно повторяющийся формат по-прежнему требует исследования.

Проверено 68 тестов на Windows, две Linux-проверки пропущены. Новый TCP-тест выполняет RSA/AES, Forge, вход в мир, KeepAlive и инъекцию синтетического 0x60 с размером frame 12300, затем проверяет закрытие и retryable. Отдельный тест с виртуальным ожиданием моделирует 104 отказа, успешный вход с PROTOCOL и следующую успешную попытку, все интервалы ровно 60000 ms. На реальный сервер подключений не выполнялось.
# Зависшее соединение при продолжающихся исходящих пакетах — 2026-10-17

В логах владельца с 22:24 до 22:28 UTC счётчики packets=151465 и keepAlives=333 не менялись, но процесс продолжал печатать metrics. Это подтверждает отсутствие обработки новых полных пакетов, а не причину исчезновения персонажа. Найден дефект: использовался net.Socket.setTimeout, чья активность продлевается исходящими записями; игровой тик продолжал писать в сокет. Добавлена независимая проверка последнего полного входящего пакета в существующем 50 ms ticker, performance.now обеспечивает монотонное время. Порог MC_IDLE_TIMEOUT_MS по умолчанию 90 секунд. INBOUND_TIMEOUT закрывает TCP и запускает стандартный минутный reconnect; никаких дополнительных игровых пакетов watchdog не отправляет.

Новый TCP-тест держит удалённый сокет открытым, читает непрерывные исходящие пакеты клиента и ничего не отвечает; клиент всё равно завершает соединение с retryable INBOUND_TIMEOUT и очищает таймеры. Отдельно проверены продление таймаута входящим пакетом и отсутствие продления исходящими записями. Полный прогон: 70 прошли, 2 Linux-проверки пропущены на Windows, ошибок нет. Реальный повторный прогон на VPS требуется после установки обновления.
# Управляющая консоль для systemd — 2026-10-17

Добавлен ControlServer с локальным Unix-сокетом `/run/mcskill-afk/control.sock`. Unit создаёт RuntimeDirectory 0700, сокет ограничивается 0600; TCP-порт не открывается. Установщик переносит control.sh и tools/control.js в /opt вместе с модулями. По upstream systemd.exec.xml RuntimeDirectory принадлежит User/Group сервиса, доступен для записи при ProtectSystem и очищается при остановке; действующие пользовательские файлы при конфликте endpoint кодом не удаляются.

Каждому управляющему соединению соответствует отдельный ConsoleController без перехвата process logger. Команды исполняются на текущем MinecraftConnection; при его ended клиентам сбрасываются соединение и ожидающие подтверждения. :quit/Ctrl+C/EOF отсоединяют управляющего клиента, не останавливая бота. Подтверждение dropall привязано к одной управляющей консоли, закрытие не позволяет подтвердить его через другой однократный вызов. Сброс уже подтверждённого задания после отсоединения не откатывается. Данные входа через этот канал не передаются, строки команд сервером не логируются.

Протокол IPC: вход — UTF-8 строки до 1024 байт, выход — ограниченные JSON-lines output/done/hello. Максимум 4 клиента, 10 строк/сек на соединение, 256 KiB исходящей очереди. Недоступный Minecraft не создаёт очередь отложенных команд. ControlClient не повторяет запросы автоматически, отдельно ограничивает ответ и сроки соединения/подтверждения. --command возвращает локальный результат приёма команды, а не подтверждение выполнения серверной команды.

Пройдено 75 тестов на Windows, 3 Unix-проверки пропущены. IPC проверялся настоящими локальными named pipes на Windows, включая отдельный tools/control.js, закрытие консоли, приём чата, изоляцию и сброс подтверждений, лимиты ввода/подключений, отказ при отсутствии игрового соединения. Bash smoke проверяет control.sh и сохранение команды с пробелами. Unix 0600/0700 и полный запуск systemd требуют Ubuntu; в установщике Linux-тесты выполняются без Windows-пропусков. Проверки не подключались к живому аккаунту.
# Полный проход сброса без сверки предметов — 2026-10-17

По просьбе владельца убраны причины остановки задания по fingerprint/revision, отсутствию положительного S32 и обновления пустого слота, пятисекундному ожиданию и отказу отдельной транзакции. Команда после ручного подтверждения делает ровно один проход 1–44: сначала видимые занятые слоты, затем остальные, каждые 300 ms, C0E window=0/button=1/mode=4/clickedItem=null. NBT по-прежнему ограниченно пропускается, SHA256 больше не вычисляется. Не вводится вымышленная поддержка дополнительных модовых слотов.

Начальный пустой курсор/обычный контейнер/поддерживаемая схема и готовое соединение остаются условиями корректного адресования слотов. Открытие другого окна, появление предмета на курсоре, отмена и разрыв прекращают оставшуюся работу. Отрицательный Transaction по-прежнему получает протокольный C0F от GameSessionHandler, но не отменяет проход. Статус считает отправленные команды, не объявляет серверный сброс подтверждённым. Серверные запреты не обходятся и результат каждого слота не гарантируется. Подтверждение пользователя остаётся одноразовым на одной консоли и не переносится между соединениями.

Тесты обновлены для полного прохода по 44 уникальным слотам, сохранения 300 ms темпа без всплесков после задержки, отсутствия ACK/slot updates, отрицательного ACK, изменений содержимого и полной ресинхронизации инвентаря. Отдельно проверены ручная отмена, смена окна, курсор и reset. Зашифрованный TCP mock принимает сброс разных слотов и отвечает стандартными Transaction/SetSlot. Реальные предметы аккаунта во время разработки не выбрасывались.

?????? ?????? ????? ?????????: 76 ?????? ??????, 3 Unix-???????? ????????? ?? Windows; ?????? ???.
# Диагностика повторного прекращения входящего потока — 2026-10-17

Новые логи показывают быстрый повторный вход (TCP→world_ready около 1 s), затем отсутствие роста packets/keepAlives и INBOUND_TIMEOUT. Следующее соединение снова проходит авторизацию и Forge. Причина прекращения обработки пакетов по этим счётчикам не устанавливается; нет оснований объявлять виноватым systemd, TCPShield, неверный ключ AES или конкретный мод. Отдельная проверка tmux/сервиса с одинаковыми установленными файлами не выполнена.

Добавлены только скалярные поля для различения отсутствия входящего TCP и незавершённого кадра: rxBytes/txBytes, время последнего TCP и полного пакета, paused/writableLength и прогресс PacketCodec (ожидаемая длина, принятое количество, длина неполного заголовка, ID ожидаемого пакета при наличии). Не читается неинициализированная часть Buffer.allocUnsafe, содержимое/hex пакетов не пишутся. Перед закрытием watchdog пишет inbound_stalled. Также включён штатный TCP keepalive с initialDelay 30 s. Таймаут не отключён и не увеличен без подтверждения причин.

Read-only deploy/check-vps.sh теперь работает и при failed сервисе, сравнивает фиксированные исходники checkout с /opt, показывает счётчики systemd и TCP ss для dport 25565. Это позволяет проверить фактическую установленную версию и состояние сокета на VPS. Расширение протокола или устранение причины зависания этим изменением не объявляется.

Новые тесты проверяют скалярность прогресса без выдачи содержимого, 4096 кадров через непрерывный AES с разными псевдослучайными границами шифрования/TCP, а также настоящий TCP peer с неполным кадром и с продолжающимся потоком частей. Тесты проходят; потери границ на этих mock-данных не выявлено. На живой сервер подключений не выполнялось. Для дальнейшего вывода требуется inbound_stalled и TCP-статистика со следующего зависания VPS.

???? ???????????????? ???????: 79 ?????? ??????, 3 Unix-???????? ????????? ?? Windows; Bash smoke ??????.
# Неизвестный ID 300741 после world_ready — 2026-10-17

Лог VPS показывает завершение Forge и world_ready, затем PROTOCOL с id=300741 и frame bytes=9248. Повтор через минуту работает, но источник неверного/неподдерживаемого ID не установлен. Такое значение совместимо с потерей границ кадра; это гипотеза, а не доказанный формат нового мода. Нельзя считать ошибку исправленной добавлением ID в allowlist.

Повторно исследованы локальные декомпилированные обработчики. Hodgepodge MixinMessageDeserializer2 меняет лимит заголовка с 3 на 5 байт; PacketCodec уже читает до 5. MetaDriveFixes MixinMinecraftDeserialization добавляет логирование exceptionCaught и не реализует отдельный формат пакетов. Поиск ChannelPipeline.addBefore/addAfter/addFirst в модах не выявил объяснения дополнительного сыро-потокового формата в изученных Meta/Lux модах. Фраза modifications were stuck найдена в локальных MTTweaker/MTMetaTweaker, сама по себе не доказывает причину сетевой ошибки.

При protocol_error теперь выводится TCP/decoder progress и история до 16 границ, состоящая только из числовых ID/длин. Внутренние данные, токены и текст сообщений не сохраняются. Отрицательные ID также явно отвергаются, вместо прежнего молчаливого пропуска. Добавлен тест размера 9248/ID 300741 и отсутствия payload в метаданных. Для дальнейшего анализа требуются новые packet_boundary и, при зависании, inbound_stalled с VPS. Исправление причины десинхронизации не объявляется.

???????? ??????? ??????: 80 ?????? ??????, 3 Unix-???????? ????????? ?? Windows; ?????? ???.


## CoFHCore UUID packet regression - 2026-10-17

The repeated ID -26 / frame bytes 21 is a supported pack extension, not evidence of lost framing. Local CFR inspection of CoFHCore-[1.7.10]3.1.4-329-client.jar confirms SecurityHelper.setup() registers Login.S__PacketSendUUID under clientbound PLAY ID -26. The inner class reads/writes two longs (16 bytes), is sent on PlayerLoggedInEvent and only updates SecurityHelper.cachedId on the client. Five-byte signed VarInt ID plus 16 bytes exactly matches the reported frame size.

Commit 10c8399 introduced the regression by rejecting all negative IDs; abb930d and its successors up to d31e302 discarded this extension implicitly. Add an explicit mcskill-only handler with exact body length validation. Keep rejection of every other unknown ID, including 300741: this finding does not explain that earlier failure. Regression coverage includes byte-fragmented framing followed by KeepAlive, invalid lengths, standard-profile rejection, and the extension in the encrypted TCP login test. No live account login is needed for these tests.


## Unhandled packet policy update - 2026-10-17

At the owner's request, discard all unhandled PLAY IDs in both profiles, including negative and large positive IDs. This supersedes the earlier CoFH-only handler and unknown-ID rejection policy. No arbitrary payload decoding or retention is added; outer frame bounds and validation of implemented packets remain unchanged. Regression tests cover signed ID extremes, arbitrary body lengths, fragmented frames followed by KeepAlive, and unknown IDs in an encrypted TCP session. Protocol-error tests now use malformed KeepAlive rather than unknown IDs.


## VarInt overflow after a large opaque frame - 2026-10-17

VPS log: after a 1404852-byte plugin frame, ID 97 / 109 bytes and ID 111 / 104 bytes, VarInt overflow is reported with no pending header/body and inboundIdleMs 224. receive() previously decoded the ID before updating metadata. Thus the reported ID/size/time may belong to the previous successful frame; an ID-decoding failure from a complete outer frame is consistent with this log. This does not establish why the stream contains these values or prove that framing is correct.

The requested permissive PLAY policy now also discards a complete frame if its ID VarInt is invalid. Only the ID read is caught; handled-packet body errors, LOGIN errors and outer framing errors remain strict. No byte scanning or stream/cipher resets are attempted. Frame metadata is updated before ID decoding; skipped frames have INVALID_PACKET_ID in bounded history, with payload-free notifications at count 1 and each 1024. Synthetic tests reproduce the large-frame size and following sequence over encrypted TCP, then assert KeepAlive recovery. No live VPS or account connection was used.
