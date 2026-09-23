Подробный план для исполнения более слабой моделью готов, он ниже. Сохранить его в файл я не смог: инструмента для создания плана в этой сессии нет, а в режиме планирования мне нельзя писать файлы. Когда выйдешь из режима планирования, могу положить его в `proxy/SERVICES_PLAN.md`.

Детально расписаны этап 0 (ядро) и этап 1 (Z-Image Turbo целиком плюс перевод Hermes), 13 шагов. Видео и 3D — только контуром в конце. Твои решения учтены: ComfyUI остаётся на месте, результаты пишутся в `~/hermes/outputs` и монтируются в Hermes только на чтение.

Что нашлось при разборе кода и повлияло на план:
- **Z-Image Turbo генерируется через два параллельных механизма.** Кроме `zgen` есть MCP-мост `tools/comfy_bridge.py` на порту 8005 с инструментом `trigger_z_image_generation`, и Hermes подключён к нему в `data/config.yaml`. Мост заменяется MCP прокси, а старое имя инструмента остаётся как алиас, чтобы Hermes не сломался.
- **Сейчас VRAM никто не защищает, пока идёт LLM-запрос.** Прокси только готовит модель перед запросом, и видеогенерация может выгрузить её посреди ответа. Поэтому локальные запросы получают «аренду» видеокарты на всё время ответа.
- **`self-photo.py` вызывает `zgen --width/--height`, а текущий `zgen` эти флаги молча игнорирует.** Новый клиент их поддерживает.
- **`self-photo.py`, видимо, пишет файл метаданных рядом с картинкой.** Каталог результатов в контейнере будет только на чтение, так что это нужно проверить (шаг 12).

---

# Локальные GPU-сервисы внутри proxy — план исполнения

## Общие правила для исполнителя

- Все пути прокси относительно `/home/harry/hermes/workspace/code/proxy`. Прокси: Express + TypeScript (CommonJS), Node 22, порт 5001. Запускается через `/home/harry/hermes/run.sh`, настройки берёт из `~/hermes/.env-proxy`.
- Новый код класть в `src/jobs/`. Не путать с существующим `src/services/`: там внутренние модули прокси.
- Стиль как в соседних файлах: `axios`, строгий TypeScript, логи вида `console.log(\`[${ts()}] ...\`)`.
- Не удалять и не менять поведение `src/services/gpu-resources.ts` и роутов `/v1/gpu/*`: их используют motion и videogen. Новый код только вызывает их экспортируемые функции.
- В `src/services/forward.ts` менять только то, что описано в шаге 8.
- После каждого шага: `npm run build` без ошибок, затем коммит в репозитории proxy.
- Пересоздавать контейнер Hermes (`docker compose up -d`) только после явного согласия пользователя.

## Шаг 1. Зависимости и конфиг

1. Поставить зависимости: `npm install better-sqlite3 yaml ajv @modelcontextprotocol/sdk` и `npm install -D @types/better-sqlite3 vue vue-router vite @vitejs/plugin-vue`.
2. В `src/config.ts` добавить в `appConfig` блок рядом с `gpu`:

```ts
services: {
  proxyRoot: path.resolve(__dirname, '..'),
  dir: path.resolve(__dirname, '..', env('SERVICES_DIR', 'services')),
  outputsRoot: env('SERVICES_OUTPUTS_ROOT', path.join(os.homedir(), 'hermes', 'outputs')),
  outputsContainerRoot: env('SERVICES_OUTPUTS_CONTAINER_ROOT', '/opt/host-resources/outputs'),
  dbPath: path.resolve(__dirname, '..', env('SERVICES_DB', 'store/services.sqlite')),
  settingsDir: path.resolve(__dirname, '..', 'store', 'services'),
  vramReserveMb: envNum('SERVICES_VRAM_RESERVE_MB', 700),
  ramReserveMb: envNum('SERVICES_RAM_RESERVE_MB', 8000),
  localLlmVramMb: envNum('LOCAL_LLM_VRAM_MB', 6500),
  localLlmMaxWaitSec: envNum('LOCAL_LLM_MAX_WAIT_SEC', 20),
  tickMs: envNum('SCHEDULER_TICK_MS', 2000),
},
```

   У скомпилированного файла `__dirname` — это `proxy/dist`, поэтому `'..'` указывает на корень proxy.

3. Добавить эти переменные с комментариями в `.env.example`.
4. Добавить в `.gitignore`: `store/*.sqlite*`, `store/services/`, `services/**/venv/`, `services/**/.venv/`, `services/_engines/`, `services/_models/`.
5. Создать каталоги `services/`, `services/_residents/` и `~/hermes/outputs/`.
6. В `package.json` добавить скрипт `"build:web": "vite build --config web/vite.config.ts"` и дописать `&& npm run build:web` в конец скрипта `build`.

## Шаг 2. Типы, манифесты, реестр сервисов

**`src/jobs/types.ts`:**

```ts
export interface ResourceVector { vram_mb: number; ram_mb: number; cpu: number }
export type PriorityClass = 'interactive' | 'normal' | 'batch';
export type JobStatus = 'queued' | 'preparing' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface ServiceManifest {
  id: string;                 // ^[a-z][a-z0-9_]{2,63}$, совпадает с именем папки
  title: string;
  description: string;
  version: string;
  kind: 'exec';
  entry: string[];            // ["python3", "run.py"], cwd = папка сервиса
  timeout_sec: number;
  residents: { requires: string[]; evicts: string[] };   // ["*"] = любые простаивающие
  resources: ResourceVector & { min_free_vram_mb?: number };
  estimate: { duration_sec: number };
  priority_default: PriorityClass;
  input_schema: object;       // JSON Schema
  mcp?: { expose: boolean; default_wait_sec: number; legacy_tool_names?: string[] };
  dir: string;                // заполняет загрузчик
  settingsSchema: object | null;  // из settings.schema.json
  hasCustomUi: boolean;       // есть ли ui/Settings.vue
}

export interface ResidentManifest {
  id: 'comfyui' | 'lmstudio';
  title: string;
  idle_vram_mb: number;
  idle_ram_mb: number;
}
```

**`src/jobs/manifest.ts`.** Функция `loadServiceManifest(dir)` читает `service.yaml` пакетом `yaml` и проверяет:
- все обязательные поля на месте;
- `id` соответствует regex и совпадает с именем папки;
- `entry` — непустой массив.

Затем компилирует `input_schema` через `new Ajv({ useDefaults: true, coerceTypes: true })`. В тексте ошибок указывать имя файла.

**`src/jobs/registry.ts`.** Функция `loadRegistry()` сканирует каталог сервисов, пропускает папки, начинающиеся с `_`, и загружает каждую папку с `service.yaml`. Битый манифест логируется и пропускается, прокси при этом не падает. Экспортировать: `listServices()`, `getService(id)`, `reloadRegistry()`, `listResidents()`. Последняя читает `services/_residents/*/resident.yaml`.

Создать два описания «жильцов» (долгоживущих процессов, держащих модель в памяти):
- `services/_residents/comfyui/resident.yaml`: `id: comfyui`, `title: ComfyUI`, `idle_vram_mb: 3500`, `idle_ram_mb: 6000`.
- `services/_residents/lmstudio/resident.yaml`: `id: lmstudio`, `title: LM Studio`, `idle_vram_mb: 6500`, `idle_ram_mb: 2000`.

## Шаг 3. SQLite, настройки, каталоги результатов

**`src/jobs/db.ts`** (better-sqlite3, режим `journal_mode = WAL`):

```sql
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,               -- например j_20260923_223501_ab12cd
  service_id TEXT NOT NULL,
  status TEXT NOT NULL,
  priority_class TEXT NOT NULL,
  principal TEXT NOT NULL DEFAULT 'anonymous',
  input_json TEXT NOT NULL,
  resources_json TEXT NOT NULL,
  estimate_sec REAL NOT NULL,
  created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER,
  progress REAL, stage TEXT, message TEXT, wait_reason TEXT,
  result_json TEXT, error TEXT, outputs_dir TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_status_created ON jobs(status, created_at);
CREATE TABLE IF NOT EXISTS job_stats (
  job_id TEXT PRIMARY KEY, service_id TEXT NOT NULL, duration_sec REAL NOT NULL,
  peak_vram_mb INTEGER, peak_ram_mb INTEGER, finished_at INTEGER NOT NULL
);
```

Функции модуля:
- `insertJob`, `updateJob(id, patch)`, `getJob`, `listJobs({status, service, limit})`.
- `recoverOnStartup()`: переводит все задачи в статусах `preparing` и `running` в `failed` с ошибкой `proxy restarted` и возвращает список `queued` по времени создания.
- `insertStat`.
- `medianDuration(serviceId, 20)`: медиана длительности последних 20 успешных запусков или `null`.

LLM-аренды в базу не писать, только держать в памяти: их слишком много.

**`src/jobs/settings-store.ts`.** Настройки хранятся в `store/services/<id>.json`.
- `getSettings`: дефолты из `settingsSchema` (ajv с `useDefaults` на пустом объекте), поверх них сохранённые значения.
- `putSettings`: валидация через ajv. Ошибка → HTTP 400 с текстом `ajv.errorsText`. Запись атомарная: во временный файл, затем `rename`.

**`src/jobs/outputs.ts`:**
- `jobDir(serviceId, jobId)` = `<outputsRoot>/<serviceId>/<jobId>`, создаётся при необходимости.
- `toContainerPath(hostPath)`: заменяет префикс `outputsRoot` на `/opt/host-resources/outputs`.
- `resolveArtifact(job, relPath)`: `path.resolve` плюс проверка, что итоговый путь лежит внутри каталога задачи. Защищает от путей с `../`.

## Шаг 4. Ресурсы и жильцы

**`src/jobs/resources.ts`:**
- `readGpu()`: `nvidia-smi --query-gpu=memory.total,memory.used,memory.free --format=csv,noheader,nounits` → `{ total_mb, used_mb, free_mb }`. Если nvidia-smi нет — `null`.
- `readMem()`: `MemTotal` и `MemAvailable` из `/proc/meminfo`.
- `capacity()` = `{ vram_mb: total - vramReserveMb, ram_mb: memTotal - ramReserveMb, cpu: os.cpus().length }`.
- `sampleProcessTree(pid)`: суммарный RSS дерева процессов, по разбору `ps -e -o pid=,ppid=,rss=`.
- Кешировать значения на 1 секунду.

**`src/jobs/residents.ts`** — обёртка над функциями `gpu-resources.ts`:

```ts
export interface ResidentState {
  key: string;            // 'comfyui' | 'lmstudio:<model_key>'
  family: 'comfyui' | 'lmstudio';
  up: boolean;
  idle_vram_mb: number; idle_ram_mb: number;
  last_used_at: number;   // в памяти модуля
}
export async function snapshotResidents(): Promise<ResidentState[]>;
export async function ensureUp(key: string, opts?: { contextLength?: number; contextSteps?: number[] }): Promise<void>;
export async function evict(key: string): Promise<void>;
export function residentKeyMatches(required: string, actual: string): boolean;
```

- `snapshotResidents()` берёт данные из `getGpuStatus()`. Если ComfyUI запущен — жилец `comfyui`. Каждая загруженная модель LM Studio — отдельный жилец `lmstudio:<model_key>`.
- `ensureUp('comfyui')` вызывает `startComfy()`. Если после этого API недоступен, бросить ошибку.
- `ensureUp('lmstudio:<модель>')` вызывает `ensureLocalModelReady({ model, context_length, contextSteps, exclusive: false })`. Выселять ComfyUI здесь не нужно: это решает планировщик.
- `evict('comfyui')` вызывает `stopComfy(false)`. Остановка мягкая: дожидается внутренней очереди ComfyUI, если кто-то пишет в неё в обход прокси.
- `evict('lmstudio:<модель>')` вызывает `unloadLmStudio(instance_id)` для подходящего инстанса.
- `residentKeyMatches` для ключей `lmstudio:*` сравнивает модели через существующую `modelKeysMatch`.
- Сколько VRAM держит простаивающая LLM: `gpuPrep.vramMb` из настроек модели (добавляется в шаге 8), иначе `localLlmVramMb`.

## Шаг 5. Допуск задач и планировщик

### 5a. `src/jobs/admission.ts` — чистая функция без ввода-вывода

```ts
export interface RunningItem { key: string; resources: ResourceVector; holds: string[]; shared: boolean; gpu: boolean; etaAt: number }
export interface AdmissionJob { resources: ResourceVector; requires: string[]; evicts: string[]; shared: boolean }
export interface AdmissionInput { capacity: ResourceVector; running: RunningItem[]; residents: ResidentState[]; job: AdmissionJob }
export type AdmissionDecision =
  | { ok: true; evict: string[]; absorbed: boolean }
  | { ok: false; reason: string };
export function admit(input: AdmissionInput): AdmissionDecision;
```

Алгоритм `admit`, строго по порядку:

1. **Разделяемые аренды.** Если у задачи `shared` и все нужные ей жильцы уже заняты разделяемыми запущенными элементами, вернуть `{ ok: true, evict: [], absorbed: true }`. Так второй чат-запрос к уже загруженной модели ничего не стоит.
2. **Одна модель LM Studio за раз.** Если задаче нужна модель A, а какой-то запущенный элемент держит другую модель B, вернуть отказ с причиной `lmstudio busy with another model`.
3. Сложить ресурсы всех запущенных элементов в `used` по трём измерениям.
4. Найти `idleOthers`: жильцов, которые запущены, не заняты ни одним запущенным элементом и не нужны этой задаче.
5. **Принудительное выселение.** Если задаче нужна модель LM Studio, а среди `idleOthers` есть другие модели LM Studio, положить их в `forcedEvict`: `ensureLocalModelReady` всё равно их выгрузит.
6. Остальных простаивающих назвать `kept`. Проверить, что `used` + ресурсы задачи + память, которую держат `kept`, не превышают ёмкость по всем трём измерениям. CPU считать только по запущенным элементам и самой задаче. Если помещается — вернуть `{ ok: true, evict: forcedEvict, absorbed: false }`.
7. **Добровольное выселение.** Из `kept` выбрать тех, кого задаче разрешено выселять (`evicts` содержит `'*'` или их имя/семейство). Отсортировать по давности использования, самые давние первыми. Выселять по одному, пересчитывая после каждого, пока задача не поместится. Если поместилась — вернуть успех со списком выселяемых.
8. Иначе вернуть отказ с конкретными числами: сколько нужно VRAM и RAM и сколько свободно.

**Unit-тест `tests/admission.test.js`.** Стиль как в `tests/ban.test.js`: подключить `../dist/jobs/admission.js`, проверять через `node:assert`. Кейсы:
- Пустая система, задача на 6000 МБ → допуск.
- ComfyUI простаивает, задаче нужна LLM → допуск с выселением `comfyui`.
- Идёт видеозадача на 7500 МБ, приходит LLM на 6500 МБ → отказ.
- Два LLM-запроса к одной модели → второй поглощается (`absorbed`).
- Модель B при занятой модели A → отказ.
- CPU-задача (`vram_mb: 0`) параллельно с GPU-задачей → допуск.

### 5b. `src/jobs/scheduler.ts`

Состояние в памяти:
- `queue` — список ожидающих: service-задачи из базы плюс LLM-аренды;
- `running` — запущенные элементы;
- флаг `gpuPreparing` — идёт подготовка GPU-задачи;
- EventEmitter с событиями `job` и `snapshot`.

```ts
interface QueueItem {
  key: string;                 // id задачи или 'llm_<n>'
  kind: 'service' | 'llm';
  serviceId: string;           // для LLM: 'llm_local'
  priorityClass: PriorityClass; principal: string;
  resources: ResourceVector; requires: string[]; evicts: string[]; shared: boolean;
  estimateSec: number; createdAt: number; notBefore?: number; preview: string;
  start: (evicted: string[]) => Promise<void>;
}
```

**Скоринг.** Больше — раньше. При равенстве раньше тот, кто пришёл раньше.

```ts
const CLASS = { interactive: 100, normal: 50, batch: 10 };
score = CLASS[item.priorityClass]
      + principalWeight(item.principal)            // store/principals.json, по умолчанию 0; файла может не быть
      + Math.floor((now - item.createdAt) / 30000)  // +1 за каждые 30 с ожидания
      + (allRequiredResidentsUp(item) ? 20 : 0);    // бонус за уже загруженного жильца
```

**`tick()`** вызывается при постановке в очередь, при завершении задачи, при освобождении аренды и по таймеру. Два `tick()` одновременно не выполнять: защитить флагом.

1. Если очередь пуста — выйти. Если идёт подготовка GPU, рассматривать только элементы с `vram_mb === 0`.
2. Получить состояние жильцов и ёмкость.
3. Отсортировать очередь по скору.
4. Для каждого элемента (пропуская те, у кого `notBefore` в будущем) вызвать `admit`:
   - **Отказ.** Если это первый отказ за проход, запомнить элемент как «голову» и время, к которому освободится ресурс: минимальное `etaAt` среди запущенных. Записать причину ожидания в `wait_reason`. Перейти к следующему элементу.
   - **Допуск, но есть заблокированная голова.** Если элементу нужна VRAM и он закончится позже, чем освободится ресурс для головы, пропустить его: обгон не должен задерживать голову.
   - **Иначе запустить.** Убрать из очереди, добавить в `running` (держит нужных жильцов, ожидаемое окончание = сейчас + оценка). Если элементу нужна VRAM и он не поглощён разделяемой арендой, выставить `gpuPreparing = true`. Вызвать `start` асинхронно; по окончании подготовки сбросить флаг и снова вызвать `tick()`. Цикл продолжить: CPU-задачи могут стартовать параллельно.

**Подготовка service-задачи (`start`):**
1. Выставить статус `preparing`.
2. Выселить жильцов из списка `evict`.
3. Поднять жильцов из `requires`.
4. Если задан `min_free_vram_mb`, а свободной видеопамяти меньше, опрашивать до 30 секунд. Если так и не освободилось, вернуть задачу в очередь с `notBefore` = сейчас + 30 с и причиной `external VRAM usage`, счётчик попыток увеличить. После 5 попыток — `failed`.
5. Запустить задачу раннером (шаг 6).

Ошибка подготовки переводит задачу в `failed`. При любом завершении задачи: убрать её из `running`, обновить время использования её жильцов, вызвать `tick()`.

**Функции модуля:**
- `startScheduler()`: восстановление после рестарта, загрузка очереди, запуск таймера.
- `submitJob(serviceId, { input, priority, principal })`: валидация ввода, запись в базу, создание каталога задачи с `input.json`, постановка в очередь.
- `waitForJob(id, sec)`: ждёт конечного статуса или таймаута.
- `cancelJob(id)`: ожидающая задача → `cancelled`; готовящаяся или запущенная → сигнал раннеру.
- `enqueueLlm(...)`: для шага 8.
- `snapshot()`: ёмкость, GPU, память, жильцы, запущенные, очередь со скором и причиной ожидания, последние 30 задач.
- `estimateFor(serviceId)`: медиана по истории, иначе оценка из манифеста.

## Шаг 6. Раннер процессов `src/jobs/runner-exec.ts`

Контракт сервиса (коротко описать его в `services/README.md`):

- **Запуск:** `spawn(entry[0], entry.slice(1), { cwd: папка сервиса, detached: true, stdio: ['ignore','pipe','pipe'], env })`.
- **Окружение:** весь `process.env`, плюс:
  - `JOB_ID`;
  - `JOB_DIR` — каталог результатов задачи;
  - `JOB_INPUT` = `JOB_DIR/input.json`;
  - `JOB_SETTINGS` = `JOB_DIR/settings.json` (раннер записывает туда текущие настройки);
  - `SERVICE_DIR`, `PROXY_URL`, `COMFY_API_URL`, `LMSTUDIO_URL`.
- **События.** Stdout читается построчно. Строка, которая начинается с `{` и парсится как JSON, — событие:
  - `{"type":"progress","ratio":0.4,"stage":"sampling","message":"..."}` — обновить задачу и отправить событие;
  - `{"type":"log","message":"..."}`;
  - `{"type":"result","outputs":[{"path":"img_0.png","kind":"image/png"}],"data":{...}}`.

  Остальные строки считаются логом. Stdout и stderr дописываются в `JOB_DIR/job.log`.
- **Успех** = код выхода 0 и было событие `result`. Каждый путь из `outputs` проверяется через `resolveArtifact`. Итог записывается в базу и в `JOB_DIR/result.json`.
- **Неудача:** в `error` сохраняются последние 2000 символов stderr или текст `no result event`.
- **Отмена и таймаут** (`timeout_sec`): `process.kill(-pid, 'SIGTERM')`, через 10 секунд `SIGKILL`. Статус `cancelled` или `failed: timeout`.
- **Пики ресурсов:** каждые 2 секунды снимать занятую VRAM и RSS дерева процессов. После успешного завершения записать в статистику.

## Шаг 7. REST API

**`src/routes/services.ts`:**
- `GET /v1/services` — список: `id, title, description, version, resources, residents, estimate_sec, priority_default, input_schema, has_settings, has_custom_ui`.
- `GET /v1/services/:id`.
- `GET /v1/services/:id/settings` → `{ schema, values }`.
- `PUT /v1/services/:id/settings` → `{ values }` или 400.
- `POST /v1/services/:id/jobs`, тело `{ input, priority?, principal?, wait_sec? }`. Автор запроса берётся из `body.principal`, иначе из заголовка `X-Principal`, иначе `anonymous`. Если задан `wait_sec`, ждать завершения. Ответ: 200, если задача завершилась; иначе 202.
- `POST /v1/services/reload`.

**`src/routes/jobs.ts`:**
- `GET /v1/jobs?status=&service=&limit=`.
- `GET /v1/jobs/:id`.
- `DELETE /v1/jobs/:id` — отмена.
- `GET /v1/jobs/:id/events` — SSE: полный JSON задачи при каждом изменении; соединение закрывается на конечном статусе.
- `GET /v1/jobs/:id/artifacts/*` — отдать файл через `resolveArtifact`.

**`src/routes/scheduler.ts`:**
- `GET /v1/scheduler` — снимок.
- `GET /v1/scheduler/stream` — SSE: снимок при каждом событии (не чаще раза в 500 мс) и каждые 2 секунды.

Формат задачи в ответах (функция `serializeJob`):

```json
{ "id": "...", "service_id": "...", "status": "...", "priority": "normal", "principal": "...",
  "progress": 0.4, "stage": "...", "message": "...", "wait_reason": null,
  "created_at": "ISO", "started_at": null, "finished_at": null, "estimate_sec": 40,
  "input": {}, "error": null,
  "outputs": [{ "path": "img_0.png", "kind": "image/png",
               "host_path": "/home/harry/hermes/outputs/...",
               "container_path": "/opt/host-resources/outputs/...",
               "url": "/v1/jobs/ID/artifacts/img_0.png" }],
  "data": {} }
```

В `src/index.ts` подключить три роутера через `app.use('/v1', ...)`, а в колбэке `app.listen` вызвать `loadRegistry(); startScheduler();`.

## Шаг 8. Локальный LLM через общую очередь

1. В `src/types.ts` в объект `gpuPrep` добавить поле `vramMb?: number`. В `src/providers/metadata.ts` найти, где разбирается `gpuPrep`, и пробросить `vramMb` так же, как `exclusive`.

2. **`src/jobs/llm-lease.ts`:**

```ts
export type LlmLeaseResult =
  | { ok: true; release: () => void }
  | { ok: false; reason: 'gpu_busy' | 'client-closed'; etaSec?: number };
export async function acquireLocalLlmLease(opts: {
  model: string; preview: string; onClientClose: () => boolean; timeoutMs: number; principal?: string;
}): Promise<LlmLeaseResult>;
```

   - **Ресурсы аренды.** Если у модели `gpuPrep.exclusive`, она занимает всю карту. Иначе VRAM = `gpuPrep.vramMb`, а без него `localLlmVramMb`. Плюс 2000 МБ RAM и 1 ядро.
   - **Параметры в очереди:** нужен жилец `lmstudio:<модель>`, выселять можно любых простаивающих, аренда разделяемая, приоритет `interactive`, оценка 60 секунд.
   - **Запуск:** поднять модель с её длиной контекста и шагами контекста из настроек модели, затем вернуть `release`. `release` можно вызывать повторно без вреда: он убирает аренду из запущенных, обновляет время использования жильца и вызывает `tick()`.
   - **Быстрый отказ.** Если сразу допустить нельзя, а видеокарту держит не-LLM задача, которой осталось больше `localLlmMaxWaitSec`, вернуть `gpu_busy` с ETA, не вставая в очередь.
   - Иначе ждать в очереди до таймаута (`retryQueueWaitTimeout`), по таймауту вернуть `gpu_busy`. Если клиент отключился, снять из очереди и вернуть `client-closed`; проверять это на каждом `tick`.

3. **`src/services/forward.ts`:**
   - Переименовать существующую `forwardChatCompletionOnce` в `forwardChatCompletionOnceInner`, сигнатуру не менять.
   - Внутри неё удалить блок `if (adapter.id === 'local') { ... ensureLocalUpstreamReady ... }` (около строк 2121–2135).
   - Добавить обёртку с прежним именем:

```ts
async function forwardChatCompletionOnce(adapter, activeModel, body, incomingHeaders, res, endpointPrefix,
  fallbackFrom?, canRetry = true, markIncomingDone?, onceOpts?): Promise<void> {
  if (adapter.id !== 'local') {
    return forwardChatCompletionOnceInner(adapter, activeModel, body, incomingHeaders, res, endpointPrefix, fallbackFrom, canRetry, markIncomingDone, onceOpts);
  }
  const model = activeModel.trim() || adapter.resolveModel(body.model);
  const lease = await acquireLocalLlmLease({
    model, preview: captureRequestContext(body.messages).userRequestPreview ?? '',
    onClientClose: () => isClientGone(res), timeoutMs: appConfig.retryQueueWaitTimeout * 1000,
  });
  if (!lease.ok) {
    if (lease.reason === 'client-closed') throw new ClientClosedError();
    throwIfHedgeSuppressed(onceOpts?.suppressFallback, 'local-gpu-busy');
    const rerouted = await tryFallbackChainUnless(onceOpts?.suppressFallback, 'local-gpu-busy',
      adapter, model, body, incomingHeaders, res, endpointPrefix);
    if (rerouted) return;
    res.status(503).set('Retry-After', String(Math.ceil(lease.etaSec ?? 30)))
      .json({ error: { message: `Local GPU busy (eta ${Math.ceil(lease.etaSec ?? 0)}s)`, type: 'gpu_busy' } });
    return;
  }
  try {
    await refreshProviderLive('local');
    await forwardChatCompletionOnceInner(adapter, activeModel, body, incomingHeaders, res, endpointPrefix, fallbackFrom, canRetry, markIncomingDone, onceOpts);
  } finally {
    if (res.writableEnded || res.destroyed) lease.release();
    else res.once('close', lease.release);
  }
}
```

   Проверить по коду, что поле превью в `captureRequestContext` называется именно так; если нет, взять поле, которое использует `logIncoming`. Функции `isClientGone`, `ClientClosedError`, `throwIfHedgeSuppressed` и `tryFallbackChainUnless` уже есть в этом файле, около строк 267–320.

4. **`src/routes/chat.ts`:** удалить оба блока с `ensureLocalUpstreamReady` (около строк 75 и 149) и сам импорт. Перед этим через grep убедиться, что и основной путь, и путь через конкретного провайдера доходят до `forwardChatCompletionOnce`.

5. Роуты `/v1/gpu/*`, включая `/v1/gpu/local/ensure`, оставить как есть: это ручные админские действия в обход планировщика.

## Шаг 9. Сервис `image_t2i_zturbo_v1`

Файлы в `services/image_t2i_zturbo_v1/`:

- **`workflow.json`** — копия `/home/harry/hermes/image_z_image_turbo.json`. Оригинал не удалять: он смонтирован в docker.
- **`service.yaml`:**

```yaml
id: image_t2i_zturbo_v1
title: "Text to Image — Z-Image Turbo (ComfyUI)"
description: "Local Z-Image Turbo generation via ComfyUI workflow. Returns PNG files."
version: "1.0.0"
kind: exec
entry: ["python3", "run.py"]
timeout_sec: 600
residents: { requires: [comfyui], evicts: ["*"] }
resources: { vram_mb: 6000, ram_mb: 12000, cpu: 2, min_free_vram_mb: 1024 }
estimate: { duration_sec: 40 }
priority_default: normal
input_schema:
  type: object
  required: [prompt]
  additionalProperties: false
  properties:
    prompt: { type: string, minLength: 1, description: "English prompt" }
    width:  { type: integer, minimum: 256, maximum: 2048, default: 1024 }
    height: { type: integer, minimum: 256, maximum: 2048, default: 1024 }
    seed:   { type: integer, default: -1, description: "-1 = random" }
    steps:  { type: integer, minimum: 1, maximum: 50 }
    count:  { type: integer, minimum: 1, maximum: 4, default: 1 }
mcp: { expose: true, default_wait_sec: 240, legacy_tool_names: [trigger_z_image_generation] }
```

- **`settings.schema.json`:** `workflow_file` (по умолчанию `"workflow.json"`), `default_steps` (8), `default_cfg` (1.0), `poll_timeout_sec` (300), `filename_prefix` (`"zturbo"`).
- **`run.py`** — только стандартная библиотека Python. Основа — логика из `workspace/tools/zgen` и `tools/comfy_bridge.py`. Никакой подготовки GPU: ComfyUI уже поднят планировщиком.
  1. Прочитать ввод и настройки, загрузить workflow.
  2. Для каждого из `count` изображений (seed `-1` означает случайный, для следующих картинок seed+i):
     - вставить промпт в узлы `CLIPTextEncode`;
     - в `KSampler` выставить seed, steps (из ввода или `default_steps`) и cfg;
     - размер записать в узел, у которого есть и `width`, и `height`;
     - в `SaveImage` задать `filename_prefix` = `<prefix>_<JOB_ID>`;
     - удалить поля `_meta`.
  3. Отправить `POST /prompt`. Печатать события прогресса. Опрашивать `/history/<id>` до `poll_timeout_sec`; при `status_str == "error"` выйти с кодом 1.
  4. Скачать каждое изображение через `GET /view?filename=&subfolder=&type=output` в `JOB_DIR/img_<i>.png`. Так результат не зависит от того, где установлен ComfyUI.
  5. Напечатать событие `result` с файлами и `data: { seeds, prompt, comfy_prompt_ids }`.

Проверка:

```bash
curl -s -XPOST localhost:5001/v1/services/image_t2i_zturbo_v1/jobs -H 'content-type: application/json' \
  -d '{"input":{"prompt":"a red fox in snow"},"wait_sec":300}' | jq
```

Ожидается `status: succeeded`, файл `~/hermes/outputs/image_t2i_zturbo_v1/<id>/img_0.png` и выгруженная модель LM Studio, если она была загружена.

## Шаг 10. MCP-сервер `src/mcp/server.ts`

- Использовать низкоуровневый `Server` из `@modelcontextprotocol/sdk/server/index.js`, а не `McpServer`: так схему можно отдать прямо из манифеста, без zod. Транспорт — `StreamableHTTPServerTransport` из `@modelcontextprotocol/sdk/server/streamableHttp.js`, без сессий.
- В `index.ts` зарегистрировать `app.post('/mcp', ...)`. На каждый запрос создавать новые сервер и транспорт (`sessionIdGenerator: undefined`), затем `await server.connect(transport); await transport.handleRequest(req, res, req.body)`. При закрытии ответа закрывать оба. На `GET` и `DELETE /mcp` отвечать 405.
- **Список инструментов:**
  - на каждый сервис с `mcp.expose` — инструмент с именем, равным id сервиса. Описание: заголовок, описание и фраза о том, что возвращается задача с путями, читаемыми из Hermes, или `job_id`, если задача ещё идёт. Схема = `input_schema` плюс поля `wait_sec`, `priority`, `principal`;
  - для каждого имени из `legacy_tool_names` — такой же инструмент с пометкой «deprecated alias»;
  - общие: `list_services`, `job_status(job_id)`, `job_result(job_id, wait_sec?)`, `job_cancel(job_id)`, `queue_snapshot`.
- **Вызов сервиса:** поставить задачу и дождаться её. Вернуть JSON задачи текстом; если задача упала, выставить `isError: true`. Для `trigger_z_image_generation` добавить в начало строку, как у старого моста: `Z-Image-Turbo finished. job_id=... Hermes: <путь>`. Автор по умолчанию — `hermes`.
- **Проверка без Hermes:** curl с JSON-RPC-запросами `initialize`, затем `tools/list`, затем `tools/call`, с заголовком `Accept: application/json, text/event-stream`.

## Шаг 11. Vue UI (`web/`)

- `web/vite.config.ts`: `root: __dirname`, `base: '/ui/'`, `build.outDir: '../dist/web'`, `emptyOutDir: true`, плагин vue, `server.fs.allow: ['..']`.
- `web/index.html`, `web/src/main.ts` (роутер с `createWebHistory('/ui/')`), `web/src/api.ts` (обёртки над REST и `EventSource` для SSE).
- Страницы:
  - **`QueueView.vue`** — по потоку `/v1/scheduler/stream`. Запущенные: прогресс, этап, сколько прошло и ETA. Ожидающие: скор, причина ожидания, кнопка отмены. Недавние: статус, ссылки на результаты, превью картинок.
  - **`ResourcesView.vue`** — видеопамять (занято/свободно/всего), RAM, CPU, жильцы (запущен, занят, простаивает, когда использовался).
  - **`ServicesView.vue`** — список сервисов с ресурсами и оценкой длительности.
  - **`ServiceView.vue`** — вкладки «Настройки» (чтение и сохранение), «Запуск» (форма по `input_schema` и переход в очередь), «История».
- **`web/src/components/SchemaForm.vue`** — форма по JSON Schema. Поддержать только строки (с `enum` — выпадающий список), числа, целые, булевы, подсказки из `description` и значения по умолчанию.
- **Кастомные страницы настроек:** `import.meta.glob('../../services/*/ui/Settings.vue')`. Если у сервиса есть свой компонент, показывать его во вкладке «Настройки» с props `{ schema, values }` и событием `save`.
- В `index.ts` раздавать `dist/web` на `/ui` через `express.static`, а для прочих путей `/ui/*` отдавать `index.html`.

## Шаг 12. Перевод Hermes

1. [x] **`workspace/tools/zgen`** переписать в тонкий клиент на стандартной библиотеке.
   - Аргументы: промпт, `--seed`, `--width`, `--height`, `--steps`, `--dry-run`.
   - Адрес: `GPU_PROXY_URL`, по умолчанию `http://host.docker.internal:5001`.
   - Запрос `POST /v1/services/image_t2i_zturbo_v1/jobs` с `wait_sec: 300` и заголовком `X-Principal: hermes`.
   - Вывод — одна JSON-строка в прежнем формате: `{"status":"success","prompt_id":<job_id>,"job_id":...,"seed":...,"files":[пути в контейнере],"host_files":[...]}`. При ошибке — `{"status":"error","error":...}` и код выхода 1.
   - `--dry-run` запрашивает `/v1/scheduler` и печатает длину очереди и состояние жильцов.
   - Импорт `gpu_prep` убрать.
2. [x] **`docker-compose.yml`:** в volumes добавить `- /home/harry/hermes/outputs:/opt/host-resources/outputs:ro`.
3. [x] **`data/config.yaml`:**
   - в `mcp_servers` заменить `comfy-z-turbo` на `local-services: { enabled: true, url: http://host.docker.internal:5001/mcp, timeout: 600 }`;
   - поправить текст около строки 28, где упоминаются MCP :8005 и `ComfyUI/output`;
   - в список путей около строки 612 добавить `/opt/host-resources/outputs`;
   - проверить `data/profiles/*/config.yaml` на `comfy-z-turbo` и `8005` и поправить так же.
4. [x] **Документация Hermes.** zgen skill, `gpu-pipelines/SOUL.md`, HOST_MOUNT_HANDOFF, vision skills — proxy :5001; мост :8005 deprecated.
5. [x] **`self-photo.py` / persona-roulette** — zgen/proxy, без Comfy gpu_prep.
6. **`run.sh`.** [x] `start all` не поднимает мост; `stop_comfy_stack` без bridge; `start_comfy_bridge` — no-op без `COMFY_BRIDGE_LEGACY=1`; `mkdir -p outputs` в `start all`.
7. [x] Мост deprecated (`tools/comfy_bridge.py`, `:8005`); MCP — `local-services` :5001.
8. Спросить пользователя и только после согласия выполнить `docker compose up -d`.

## Шаг 13. Сквозная проверка

- [x] Сборка без ошибок, `node tests/admission.test.js` проходит. (`tests/run.sh`: единственный FAIL — отсутствует алиас `kimi` в `/v1/models`, к сервисам GPU не относится.)
- [x] `GET /v1/services` показывает `image_t2i_zturbo_v1`. Чтение и сохранение настроек работают, невалидное значение даёт 400.
- [x] Генерация через REST кладёт PNG в `~/hermes/outputs`, а URL результата отдаёт файл (проверено ранее E2E + zgen).
- [ ] Модель LM Studio загружена → Z-задача выгружает её и поднимает ComfyUI. Следующий чат к локальному алиасу выселяет ComfyUI и загружает модель. *(ручная проверка на живой GPU)*
- [ ] Пока идёт Z-задача (оценка 600 с в манифесте), чат `gemma-4-12b` → облако + `local-gpu-busy`; прямой `/local/v1/chat/completions` → 503 или ожидание. *(ручная)*
- [ ] Две Z-задачи и LLM: LLM выше в `/v1/scheduler`. *(ручная)*
- [ ] После рестарта прокси queued остаётся, running → `failed: proxy restarted`. *(ручная / по коду `recoverOnStartup`)*
- [x] Отмена ожидающей задачи (`DELETE /v1/jobs/:id` → `cancelled`). Отмена running — по коду раннера; при необходимости перепроверить под нагрузкой.
- [x] MCP: `initialize` + tools; сервис и `trigger_z_image_generation` в списке; генерация через REST/zgen.
- [x] Из контейнера `zgen` → `/opt/host-resources/outputs/...`, файл на месте. Telegram — не автоматизировали.
- [x] UI `/ui/`: Queue (SSE), Services → ServiceView (настройки/запуск/история), SchemaForm.

## Следующие этапы (контур)

- **Этап 2 — видео.** [x] REST-сервисы `video_*_v1`, `video_exec_v1`, очередь videogen (`VIDEOGEN_USE_PROXY_QUEUE`). [ ] Перенос Wan2GP в `services/_engines/wan2gp/` (см. `_engines/README.md`). [ ] JSON-прогресс из Wan2GP в stdout. [ ] `scene_cinematic` как цепочка подзадач. [ ] Убрать `videogen_check_gpu_headroom` при proxy-only.
- **Этап 3 — 3D и motion.** [x] `motion_*_v1`, motion server `USE_PROXY_GPU_QUEUE`, vision через `/v1/chat/completions`. [ ] gem-x в `_engines/`. [ ] Удалить legacy spawn при `USE_PROXY_GPU_QUEUE=0` когда больше не нужен.
- **Этап 4.** [ ] Веса авторов, HTTP-воркеры, удалить `comfy_bridge.py`, LLM-дашборд в Vue, auth на `/v1/services` и `/mcp`. [x] Документ контракта: `docs/adding-a-gpu-service.md` + skill `proxy-gpu-service`.