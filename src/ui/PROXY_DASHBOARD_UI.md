# Proxy Dashboard UI

Живой мониторинг LLM-прокси (очереди, статистика моделей, активные соединения).

## Эндпоинты

| Метод | Путь | Тип | Описание |
|-------|------|-----|----------|
| `GET` | `http://127.0.0.1:5001/v1/router/queue` | JSON | Все данные дашборда (poll раз в секунду) |
| `GET` | `http://127.0.0.1:5001/v1/queue` | HTML | Готовая страница дашборда (автообновление 1s) |

Порт — 5001 (тот же, что у прокси). Перед отправкой запросов обязательно вызвать `/v1/router/queue`, чтобы прокси построил `groupConfig` из конфига алиаса.

---

## Структура ответа `/v1/router/queue`

Топ-уровень содержит **7 секций**:

```json
{
  "perModel": [],
  "aliasGroups": [],
  "groupConfig": [],
  "stats": {},
  "incoming": [],
  "active": [],
  "recent": []
}
```

---

## Секции дашборда

### 1. `── models ──` ← `stats`

Кумулятивная статистика с момента старта прокси по каждой модели, **через которую уже прошли запросы**.

```json
"stats": {
  "gonka-api:MiniMaxAI/MiniMax-M2.7": {
    "lastStatus": 200,
    "total": 3,
    "ok": 3,
    "fail": 0
  }
}
```

| Поле | Тип | Значение |
|------|-----|----------|
| ключ | string | `provider:model` |
| `lastStatus` | int | Последний HTTP-код upstream (200=ок, 402/502=ошибка) |
| `total` | int | Всего запросов |
| `ok` | int | Успешных (2xx) |
| `fail` | int | Ошибок (4xx/5xx) |

В UI к каждой модели приписывается последний запрос/ответ в формате `first 40 ... last 40`.

---

### 2. `── alias kimi chain ──` ← `groupConfig` + `aliasGroups`

Конфигурация цепочки алиаса: модели разбиты на **группы** по стратегии распределения.

**`groupConfig`** — статическая конфигурация (для отображения списка):

```json
"groupConfig": [
  { "provider": "gonka-dahl", "model": "moonshotai/Kimi-K2.6",
    "limit": 1, "group": 0, "strategy": "random" }
]
```

| Поле | Тип | Значение |
|------|-----|----------|
| `provider` | string | Провайдер |
| `model` | string | Модель |
| `limit` | int | Max параллельных (concurrent=1 обычно) |
| `group` | int | Индекс группы (0 = первая) |
| `strategy` | string | `random` (пул с очередью) или `order` (последовательно) |

**`aliasGroups`** — актуальная занятость групп (живые слоты):

```json
"aliasGroups": [{
  "key": "kimi:g0",
  "alias": "kimi",
  "strategy": "random",
  "active": 4,
  "limit": 6,
  "members": [
    { "provider": "gonka-dahl", "model": "moonshotai/Kimi-K2.6",
      "active": 1, "limit": 1 }
  ],
  "waiters": []
}]
```

| Поле | Тип | Значение |
|------|-----|----------|
| `key` | string | `alias:g<индекс>` |
| `alias` | string | Имя алиаса |
| `strategy` | string | `random` / `order` |
| `active` | int | Всего занятых слотов в группе |
| `limit` | int | Всего слотов в группе |
| `members` | array | По модели: активные/лимит |
| `waiters` | array | Запросы в очереди группы |

**UI**: `random (6) [G]` — модели с барами `[█░] active/limit`. `order (4)` — модели без баров (последовательный перебор).

---

### 3. `── live ──` ← `incoming` + `active`

Реальное текущее состояние соединений. Слева — **от клиента к прокси**, справа — **от прокси к upstream ы**.

**`incoming`** — входящие от клиента:

```json
"incoming": [{ "preview": "Review the conversation...", "startedAt": 1786186218583 }]
```

| Поле | Тип | Значение |
|------|-----|----------|
| `preview` | string | Первые 60 символов запроса |
| `startedAt` | int | Unix-мс начала |

**`active`** — исходящие к upstream:

```json
"active": [{
  "key": "gonka-api:moonshotai/Kimi-K2.6",
  "provider": "gonka-api",
  "model": "moonshotai/Kimi-K2.6",
  "reqPreview": "Your previous turn indicated a tool call",
  "reqSuffix": "call but none was included. Do not narr",
  "startedAt": 1786186038836
}]
```

| Поле | Тип | Значение |
|------|-----|----------|
| `key` | string | `provider:model` |
| `provider` / `model` | string | Таргет |
| `reqPreview` | string | Первые 40 символов запроса |
| `reqSuffix` | string | Последние 40 символов запроса |
| `startedAt` | int | Unix-мс начала |

**UI**: записи старше **60 секунд** подсвечиваются **серым** (`stale`). Zombie-записи старше 10 минут вычищает фоновый reaper.

---

### 4. `── recent ──` ← `recent`

Последние **10** завершённых запросов (из буфера на 20).

```json
"recent": [{
  "key": "gonka-api:MiniMaxAI/MiniMax-M2.7",
  "provider": "gonka-api",
  "model": "MiniMaxAI/MiniMax-M2.7",
  "reqPreview": "[IMPORTANT: You are running as a schedul",
  "respPreview": " thinkingLet me check the posts-queue for posts awaiting Igor's approval.  response",
  "status": 200,
  "startedAt": 1786186244155
}]
```

| Поле | Тип | Значение |
|------|-----|----------|
| `key` | string | `provider:model` |
| `reqPreview` | string | Первые 40 символов запроса |
| `respPreview` | string | Первые ~40 символов ответа (обрезано) |
| `status` | int | HTTP-код |
| `startedAt` | int | Unix-мс |

**UI**: `provider/model  status  durée  first 40 ... last 40`. Зелёный (2xx), красный (4xx/5xx), серый если >60s.

---

## Zombie-reaper

Прокси фоново (каждые 30 сек) вычищает **осиротевшие** соединения старше 10 минут: рвёт их, освобождает слоты, убирает из `incoming`/`active`. Это защищает и отчёт, и саму систему от накопления мёртвых соединений.

Лог: `[zombie-reaper] cleaned N stale requests`.

---

## Быстрый старт UI-клиента -- пример кода

```bash
# Получить JSON (poll раз в секунду)
curl -s http://127.0.0.1:5001/v1/router/queue | jq .

# Или просто открыть готовую страницу
open http://127.0.0.1:5001/v1/queue
```

Прокси строится и запускается через `bash run.sh proxy restart` из корня репозитория.


## UI клиент в 1 файл


#!/usr/bin/env python3
import http.server
import socketserver
import webbrowser
import threading
import time

PORT = 8080

# -------------------------------------------------------------------
# ВЕСЬ ВАШ HTML / JS / CSS КОД НАХОДИТСЯ НИЖЕ БЕЗ ЭКРАНИРОВАНИЯ
# -------------------------------------------------------------------
HTML_CONTENT = """<!DOCTYPE html>
<html lang="ru">
... тут код клиента
</html>
"""

# -------------------------------------------------------------------
# ВЕБ-СЕРВЕР И ЗАПУСК (Не требует редактирования)
# -------------------------------------------------------------------
class DashboardHandler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-type", "text/html; charset=utf-8")
        self.end_headers()
        self.wfile.write(HTML_CONTENT.encode('utf-8'))

    def log_message(self, format, *args):
        return # Отключаем логирование каждого GET-запроса в консоль

def open_browser():
    time.sleep(0.5)
    webbrowser.open(f'http://localhost:{PORT}')

if __name__ == "__main__":
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("127.0.0.1", PORT), DashboardHandler) as httpd:
        print(f"🚀 Дашборд запущен: http://localhost:{PORT}")
        print("Нажмите Ctrl+C для остановки сервера.")
        
        # Автоматически открываем браузер в отдельном потоке
        threading.Thread(target=open_browser, daemon=True).start()
        
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nСервер остановлен.")




### Задача

Создай современный, быстрый и очень красивый Dashboard по этим требованиям
1 файл self server py
Должен быть mobile first
Должен иметь табы

Главная таба -- список моделей и их каунтеры и статусы
ниже список альясов и их общее состояние (без разбивки на модели)


Вторая таба -- live -- входящие/исходящие запросы (фильтр show zombies по умолчанию выкл)
Дальше по одной табе на alias статистику
Последня таба recent -- последние N запросов и как они закончились



## Пример канонического запроса и ответа UI убогого


твой дэшборд как буд-то не все показывает.. вот что канонический кажет -- 
LLM Proxy Queue 14:13:18

── models (6) ──
gonka-api:MiniMaxAI/MiniMax-M2.7  ok=6 fail=0 last=200 total=6
gonka-api:moonshotai/Kimi-K2.6  ok=4 fail=0 last=200 total=4  [IMPORTANT: You are running as a schedul ... [SILENT]
gonka-dahl:moonshotai/Kimi-K2.6  ok=2 fail=0 last=200 total=2  [IMPORTANT: You are running as a schedul
gonka:Kimi-K2.6  ok=0 fail=1 last=404 total=1
gonka:MiniMaxAI/MiniMax-M2.7  ok=15 fail=2 last=200 total=17  [IMPORTANT: You are running as a schedul ... <think>Empty output — nothing to approve. Say nothing. </think> [SILENT]
hyperfusion:MiniMaxAI/MiniMax-M2.7  ok=2 fail=0 last=200 total=2  [IMPORTANT: You are running as a schedul ... [SILENT]

── alias kimi chain (10) ──
  random (6) [G]
gonka-dahl/moonshotai/Kimi-K2.6 [░] 0/1  ok=2 fail=0 last=200 total=2
gonka-dahl/MiniMaxAI/MiniMax-M2.7 [░] 0/1  
gonka-api/moonshotai/Kimi-K2.6 [░] 0/1  ok=4 fail=0 last=200 total=4
gonka-api/MiniMaxAI/MiniMax-M2.7 [░] 0/1  ok=6 fail=0 last=200 total=6
gonka/Kimi-K2.6 [░] 0/1  ok=0 fail=1 last=404 total=1
gonka/MiniMaxAI/MiniMax-M2.7 [░] 0/1  ok=15 fail=2 last=200 total=17
  order (4)
hyperfusion/MiniMaxAI/MiniMax-M2.7  -  ok=2 fail=0 last=200 total=2
openrouter/nvidia/nemotron-3-super-120b-a12b:free  -  
openrouter/deepseek/deepseek-v4-flash  -  
deepseek/deepseek-v4-flash  -  

── live ──
  incoming (0)
  outgoing (0)

── recent 10/20 ──
gonka-api/moonshotai/Kimi-K2.6  200  148s  [IMPORTANT: You are running as a schedul ... [SILENT]
gonka-dahl/moonshotai/Kimi-K2.6  200  149s  [IMPORTANT: You are running as a schedul
gonka-api/moonshotai/Kimi-K2.6  200  579s  Your previous turn indicated a tool call
gonka/MiniMaxAI/MiniMax-M2.7  200  444s  [IMPORTANT: You are running as a schedul ... <think>Empty output — nothing to approve. Say nothing. </think> [SILENT]
gonka-dahl/MiniMaxAI/MiniMax-M2.7  429  444s  [IMPORTANT: You are running as a schedul ... rate-limited
gonka/MiniMaxAI/MiniMax-M2.7  200  450s  [IMPORTANT: You are running as a schedul ... <think>Let me run the approval-request script to check for posts awaiting Igor's approval. </think>
gonka/MiniMaxAI/MiniMax-M2.7  400  589s  [IMPORTANT: You are running as a schedul
gonka-dahl/MiniMaxAI/MiniMax-M2.7  429  590s  [IMPORTANT: You are running as a schedul ... rate-limited
gonka-dahl/MiniMaxAI/MiniMax-M2.7  429  590s  [IMPORTANT: You are running as a schedul ... rate-limited
gonka/MiniMaxAI/MiniMax-M2.7  200  607s  [IMPORTANT: You are running as a schedul ... <think>The p5-waves directory doesn't exist and neither does the madissonwaves landing project. Let me check what projects actually exist. </think>

вот ответ примерный -- {"perModel":[],"aliasGroups":[{"key":"kimi:g0","alias":"kimi","strategy":"random","active":0,"limit":6,"members":[{"provider":"gonka-dahl","model":"moonshotai/Kimi-K2.6","active":0,"limit":1},{"provider":"gonka-dahl","model":"MiniMaxAI/MiniMax-M2.7","active":0,"limit":1},{"provider":"gonka-api","model":"moonshotai/Kimi-K2.6","active":0,"limit":1},{"provider":"gonka-api","model":"MiniMaxAI/MiniMax-M2.7","active":0,"limit":1},{"provider":"gonka","model":"Kimi-K2.6","active":0,"limit":1},{"provider":"gonka","model":"MiniMaxAI/MiniMax-M2.7","active":0,"limit":1}],"waiters":[]},{"key":"kimi:g1","alias":"kimi","strategy":"order","active":0,"limit":1,"members":[{"provider":"hyperfusion","model":"MiniMaxAI/MiniMax-M2.7","active":0,"limit":1},{"provider":"openrouter","model":"nvidia/nemotron-3-super-120b-a12b:free","active":0,"limit":0},{"provider":"openrouter","model":"deepseek/deepseek-v4-flash","active":0,"limit":0},{"provider":"deepseek","model":"deepseek-v4-flash","active":0,"limit":0}],"waiters":[]}],"groupConfig":[{"provider":"gonka-dahl","model":"moonshotai/Kimi-K2.6","limit":1,"group":0,"strategy":"random"},{"provider":"gonka-dahl","model":"MiniMaxAI/MiniMax-M2.7","limit":1,"group":0,"strategy":"random"},{"provider":"gonka-api","model":"moonshotai/Kimi-K2.6","limit":1,"group":0,"strategy":"random"},{"provider":"gonka-api","model":"MiniMaxAI/MiniMax-M2.7","limit":1,"group":0,"strategy":"random"},{"provider":"gonka","model":"Kimi-K2.6","limit":1,"group":0,"strategy":"random"},{"provider":"gonka","model":"MiniMaxAI/MiniMax-M2.7","limit":1,"group":0,"strategy":"random"},{"provider":"hyperfusion","model":"MiniMaxAI/MiniMax-M2.7","limit":1,"group":1,"strategy":"order"},{"provider":"openrouter","model":"nvidia/nemotron-3-super-120b-a12b:free","limit":0,"group":1,"strategy":"order"},{"provider":"openrouter","model":"deepseek/deepseek-v4-flash","limit":0,"group":1,"strategy":"order"},{"provider":"deepseek","model":"deepseek-v4-flash","limit":0,"group":1,"strategy":"order"}],"stats":{"gonka-api:MiniMaxAI/MiniMax-M2.7":{"lastStatus":200,"total":6,"ok":6,"fail":0},"gonka:MiniMaxAI/MiniMax-M2.7":{"lastStatus":200,"total":17,"ok":15,"fail":2},"gonka-api:moonshotai/Kimi-K2.6":{"lastStatus":200,"total":4,"ok":4,"fail":0},"gonka:Kimi-K2.6":{"lastStatus":404,"total":1,"ok":0,"fail":1},"gonka-dahl:moonshotai/Kimi-K2.6":{"lastStatus":200,"total":2,"ok":2,"fail":0},"hyperfusion:MiniMaxAI/MiniMax-M2.7":{"lastStatus":200,"total":2,"ok":2,"fail":0}},"incoming":[],"active":[],"recent":[{"key":"gonka-api:moonshotai/Kimi-K2.6","provider":"gonka-api","model":"moonshotai/Kimi-K2.6","reqPreview":"[IMPORTANT: You are running as a schedul","respPreview":"[SILENT]","status":200,"startedAt":1786187450366},{"key":"gonka-dahl:moonshotai/Kimi-K2.6","provider":"gonka-dahl","model":"moonshotai/Kimi-K2.6","reqPreview":"[IMPORTANT: You are running as a schedul","respPreview":"","status":200,"startedAt":1786187449757},{"key":"gonka-api:moonshotai/Kimi-K2.6","provider":"gonka-api","model":"moonshotai/Kimi-K2.6","reqPreview":"Your previous turn indicated a tool call","respPreview":"","status":200,"startedAt":1786187019716},{"key":"gonka:MiniMaxAI/MiniMax-M2.7","provider":"gonka","model":"MiniMaxAI/MiniMax-M2.7","reqPreview":"[IMPORTANT: You are running as a schedul","respPreview":"<think>Empty output — nothing to approve. Say nothing. </think> [SILENT]","status":200,"startedAt":1786187154621},{"key":"gonka-dahl:MiniMaxAI/MiniMax-M2.7","provider":"gonka-dahl","model":"MiniMaxAI/MiniMax-M2.7","reqPreview":"[IMPORTANT: You are running as a schedul","respPreview":"rate-limited","status":429,"startedAt":1786187154119},{"key":"gonka:MiniMaxAI/MiniMax-M2.7","provider":"gonka","model":"MiniMaxAI/MiniMax-M2.7","reqPreview":"[IMPORTANT: You are running as a schedul","respPreview":"<think>Let me run the approval-request script to check for posts awaiting Igor's approval. </think>","status":200,"startedAt":1786187148458},{"key":"gonka:MiniMaxAI/MiniMax-M2.7","provider":"gonka","model":"MiniMaxAI/MiniMax-M2.7","reqPreview":"[IMPORTANT: You are running as a schedul","respPreview":"","status":400,"startedAt":1786187009027},{"key":"gonka-dahl:MiniMaxAI/MiniMax-M2.7","provider":"gonka-dahl","model":"MiniMaxAI/MiniMax-M2.7","reqPreview":"[IMPORTANT: You are running as a schedul","respPreview":"rate-limited","status":429,"startedAt":1786187008824},{"key":"gonka-dahl:MiniMaxAI/MiniMax-M2.7","provider":"gonka-dahl","model":"MiniMaxAI/MiniMax-M2.7","reqPreview":"[IMPORTANT: You are running as a schedul","respPreview":"rate-limited","status":429,"startedAt":1786187008290},{"key":"gonka:MiniMaxAI/MiniMax-M2.7","provider":"gonka","model":"MiniMaxAI/MiniMax-M2.7","reqPreview":"[IMPORTANT: You are running as a schedul","respPreview":"<think>The p5-waves directory doesn't exist and neither does the madissonwaves landing project. Let me check what projects actually exist. </think>","status":200,"startedAt":1786186991930},{"key":"gonka:MiniMaxAI/MiniMax-M2.7","provider":"gonka","model":"MiniMaxAI/MiniMax-M2.7","reqPreview":"[IMPORTANT: You are running as a schedul","respPreview":"<think>OK so the board is essentially empty for madisson. There's only one task - t_2cf9f3cd which is blocked on the coder task. The active-mind entries show I've been doing mostly \"no action\" for days. The key thing I noticed: the p5.js portfolio was completed. And the landing page at madisson.potoki.pro needs the iframe gallery integrated. From active-mind: \"the iframe gallery idea from day-shift-2026-08-06 is still just an idea. That's the next door.\" And from 08:02: \"The iframe gallery idea from day-shift-2026-08-06 is still just an idea. That's the next door.\" This seems like a clear self-assigned task I can pick up! I should check if the p5.js sketches actually exist at /opt/data/projects/p5-waves/ first. </think>","status":200,"startedAt":1786186979308},{"key":"gonka:MiniMaxAI/MiniMax-M2.7","provider":"gonka","model":"MiniMaxAI/MiniMax-M2.7","reqPreview":"[IMPORTANT: You are running as a schedul","respPreview":"<think>Let me check the schema of the kanban database to see what columns exist. </think>","status":200,"startedAt":1786186971710},{"key":"gonka:MiniMaxAI/MiniMax-M2.7","provider":"gonka","model":"MiniMaxAI/MiniMax-M2.7","reqPreview":"[IMPORTANT: You are running as a schedul","respPreview":"<think>Let me analyze what I found: 1. **Active-mind**: Multiple entries from Aug 7-8. Key themes: - Board has been mostly empty since Aug 7 - p5.js portfolio done (5 sketches, 497 lines) - Pipeline running autonomously - Memory-bridge task t_2cf9f3cd is blocked waiting for coder to fix t_47kt23c9 - Web search keeps failing (SSL timeouts) - The last entry (10:02) mentions reading plugin code - bugs appear fixed already, t_47c9 needs coder retry 2. **Pending-actions**: Long list of done items, many blocked items. The key active items: - retro-qa (needs write access to /opt/host-resources/ComfyUI/output/) - Photo-queue batch scoring appears stalled - No clear action items 3. **Kanban**: Only t_2cf9f3cd (memory bridge spec) is active and blocked There's a gap between the kanban output showing only one task and the active-mind notes mentioning multiple tasks - I should re-examine what tasks are actually assigned to me with a broader status filter. The memory-bridge task is blocked waiting on coder task t_47kt23c9, and the active-mind mentions coder crashed twice before starting. So there's nothing for me to execute right now. Looking at pending-actions, there are a couple of stale tasks: retro-qa which needs write access to ComfyUI output, and photo-queue batch scoring that's stalled. I could potentially do something about that stalled photo-queue. But I need to verify which tasks are actually mine to work on. I'm looking through the available tasks - t_2cf9f3cd is blocked, but there's also t_3e66e5e9 about p5 portfolio integration and t_c995472d about generating p5 sketch 02 that might be relevant to my landing page gallery work. I'm seeing a backlog of 326 unprocessed photos from August 2nd that's been sitting for a while, and there's also a retro-QA task waiting on host filesystem access. Let me narrow down to just madisson tasks across all statuses to see what's actually available to work on right now. I'm seeing that t_2cf9f3cd is blocked waiting for t_47kt23c9, but the plugin code is already fixed. Let me check what other madisson tasks are actually available to work on, since I need something to do during this window. Looking at what's ready for me, the p5.js portfolio integration stands out—I've got 5 sketches done and could embed them as an iframe gallery on the landing page, which is concrete work without needing Igor. But first I should verify whether that task still exists on the board or if it was already completed. </think>","status":200,"startedAt":1786186922751},{"key":"hyperfusion:MiniMaxAI/MiniMax-M2.7","provider":"hyperfusion","model":"MiniMaxAI/MiniMax-M2.7","reqPreview":"[IMPORTANT: You are running as a schedul","respPreview":"[SILENT]","status":200,"startedAt":1786186953022},{"key":"hyperfusion:MiniMaxAI/MiniMax-M2.7","provider":"hyperfusion","model":"MiniMaxAI/MiniMax-M2.7","reqPreview":"[IMPORTANT: You are running as a schedul","respPreview":"","status":200,"startedAt":1786186932893},{"key":"gonka:MiniMaxAI/MiniMax-M2.7","provider":"gonka","model":"MiniMaxAI/MiniMax-M2.7","reqPreview":"[IMPORTANT: You are running as a schedul","respPreview":"<think>My task `t_2cf9f3cd` (Создать specs/memory-bridge.md) is blocked waiting on `t_47b4c9` which is assigned to `coder` and currently blocked. I can't do my task until coder finishes theirs. Gallery HTML: 16KB, stored at `/opt/host-resources/ComfyUI/output/gallery.ht...` - it IS in the output directory already. Now let me think about the web search topic: hour 11 % 8 = 3, which maps to \"social media genuinely human account\" - this is the rotation index. Let me do a quick web search. I should also scan through the latest photo inventory to see what's available there. </think>","status":200,"startedAt":1786186914199},{"key":"gonka-dahl:MiniMaxAI/MiniMax-M2.7","provider":"gonka-dahl","model":"MiniMaxAI/MiniMax-M2.7","reqPreview":"[IMPORTANT: You are running as a schedul","respPreview":"rate-limited","status":429,"startedAt":1786186917676},{"key":"gonka-dahl:MiniMaxAI/MiniMax-M2.7","provider":"gonka-dahl","model":"MiniMaxAI/MiniMax-M2.7","reqPreview":"[IMPORTANT: You are running as a schedul","respPreview":"rate-limited","status":429,"startedAt":1786186917328},{"key":"gonka-api:moonshotai/Kimi-K2.6","provider":"gonka-api","model":"moonshotai/Kimi-K2.6","reqPreview":"[IMPORTANT: You are running as a schedul","respPreview":"rate-limited","status":429,"startedAt":1786186910772},{"key":"gonka-dahl:MiniMaxAI/MiniMax-M2.7","provider":"gonka-dahl","model":"MiniMaxAI/MiniMax-M2.7","reqPreview":"[IMPORTANT: You are running as a schedul","respPreview":"rate-limited","status":429,"startedAt":1786186913770}]}