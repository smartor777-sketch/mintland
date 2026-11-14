# Cinnamon, Muffin и порядок окон

> **Документ:** как Cinnamon и Muffin раскладывают окна рабочего стола и почему из-за этого иконки могут оказаться под сценой.
> **Дата:** 15.11.2026.
> **Зачем:** это знание добыто замерами и чтением исходников; без него следующая правка слоя снова превратится в угадывание.
> **Связанные документы:** [`SAFETY.md`](SAFETY.md) — контракт сосуществования с Nemo, [`IMPROVEMENTS.md`](IMPROVEMENTS.md).

---

## 0. Коротко

Mintland рисует сцену в окне того же типа, что и `nemo-desktop` (`_NET_WM_WINDOW_TYPE_DESKTOP`). Оба окна попадают **в один слой Muffin**, и порядок внутри слоя задаёт **не X11**, а собственный стек Muffin (`MetaStack`).

Отсюда три следствия, которые дорого стоили:

1. `XQueryTree` и `_NET_CLIENT_LIST_STACKING` показывают **не то**, что видно на экране.
2. `XRaiseWindow` (`deskwall -u`) на этот порядок **не влияет**.
3. `nemo-desktop` при старте **отказывается** вести рабочий стол, если уже существует чужое окно типа `DESKTOP`.

Поэтому «иконки не появляются» — это почти всегда не медленная загрузка, а перекрытие или отказ Nemo от роли.

---

## 1. Кто за что отвечает

| Компонент | Роль |
|---|---|
| **Cinnamon** | Оболочка: панели, апплеты, меню. Рабочий стол не рисует |
| **Muffin** | Композитор и оконный менеджер. Решает, какое окно выше, рисует тени и переходы |
| **nemo-desktop** | Отдельный процесс, который рисует иконки на рабочем столе |
| **csd-background** | Демон настроек: системные обои |
| **Mintland (`themehost.py`)** | Наше окно со сценой |

Важно: **Cinnamon не рисует рабочий стол**. Иконки — это `nemo-desktop`, обои — `csd-background`, порядок — Muffin. Три разных процесса, которые выглядят как одна картинка.

---

## 2. Слои Muffin

Из `src/meta/common.h`:

```c
typedef enum
{
  META_LAYER_DESKTOP           = 0,   /* самый нижний */
  META_LAYER_BOTTOM            = 1,
  META_LAYER_NORMAL            = 2,
  META_LAYER_TOP               = 4,   /* он же DOCK */
  META_LAYER_DOCK              = 4,
  META_LAYER_OVERRIDE_REDIRECT = 7,
  META_LAYER_LAST              = 8
} MetaStackLayer;
```

Чем больше число, тем выше окно. **`DESKTOP` — самый нижний слой**, а не «слой рабочего стола» в бытовом смысле.

### 2.1. Как окно попадает в слой

Из `src/x11/window-x11.c`:

```c
static MetaStackLayer
get_standalone_layer (MetaWindow *window)
{
  switch (window->type)
    {
    case META_WINDOW_DESKTOP:
      layer = META_LAYER_DESKTOP;      /* всегда, в обход флагов */
      break;
    case META_WINDOW_DOCK:
      if (window->wm_state_below || ...)
        layer = META_LAYER_BOTTOM;
      else
        layer = META_LAYER_DOCK;
      break;
    ...
    default:
      layer = meta_window_get_default_layer (window);
      break;
    }
}
```

Ключевой момент: **для типа `DESKTOP` слой назначается жёстко**, флаги `_NET_WM_STATE_BELOW`/`ABOVE` не учитываются.

А `meta_window_get_default_layer()` (для остальных типов) смотрит на флаги:

```c
MetaStackLayer
meta_window_get_default_layer (MetaWindow *window)
{
  if (window->wm_state_below)
    return META_LAYER_BOTTOM;
  else if (window->wm_state_above && !META_WINDOW_MAXIMIZED (window))
    return META_LAYER_TOP;
  else
    return META_LAYER_NORMAL;
}
```

Отсюда ловушка, в которую мы попали: если окну **снять** тип `DESKTOP`, но оставить `BELOW`, оно уедет в `META_LAYER_BOTTOM` — **выше** обоих DESKTOP-окон. Сцена окажется над иконками, хотя «мы же её опустили».

### 2.2. Порядок внутри слоя

Из `src/core/stack.c`:

```c
static int
compare_window_position (void *a, void *b)
{
  MetaWindow *window_a = a;
  MetaWindow *window_b = b;

  /* Go by layer, then stack_position */
  if (window_a->layer < window_b->layer)
    return 1;
  else if (window_a->layer > window_b->layer)
    return -1;
  else if (window_a->stack_position < window_b->stack_position)
    return 1;                      /* кто раньше — тот ниже */
  else if (window_a->stack_position > window_b->stack_position)
    return -1;
  ...
}
```

Внутри одного слоя решает `stack_position` — внутренний счётчик Muffin. Он **не связан** с порядком окон в X11.

---

## 3. Почему X11 врёт

X11-порядок (`XQueryTree`, `_NET_CLIENT_LIST_STACKING`) отражает то, что Muffin отправил серверу **последним**. Но композитор рисует не по этому порядку, а по своему `MetaStack`.

Наблюдение с этой машины (оба окна — `DESKTOP`):

```text
XQueryTree (снизу вверх):
  80  themehost.py      2560x1440 viewable
  81  nemo-desktop      2560x1360 viewable     ← Nemo «выше»

_NET_CLIENT_LIST_STACKING:
  1: 0x460000d (наша сцена)
  2: 0x3e0001b (Рабочий стол)                  ← Nemo «выше»

А на экране: сцена поверх иконок.
```

Это не баг X11 и не баг Muffin. Это два разных представления: серверу сказали одно, рисуется другое.

**Практический вывод:** проверять порядок слоёв по `xprop`/`xwininfo` для DESKTOP-окон бессмысленно. Проверять надо **экран**.

---

## 4. Почему Nemo отказывается рисовать иконки

Из `src/nemo-desktop-application.c` (Nemo):

```c
static gboolean
desktop_already_managed (void)
{
  windows = gdk_screen_get_window_stack (screen);

  for (iter = windows; iter != NULL; iter = iter->next) {
      GdkWindow *window = GDK_WINDOW (iter->data);

      if (gdk_window_get_type_hint (window) == GDK_WINDOW_TYPE_HINT_DESKTOP) {
          gchar **ignored = g_settings_get_strv (desktop_preferences,
                            NEMO_PREFERENCES_DESKTOP_IGNORED_DESKTOP_HANDLERS);
          if (!desktop_handler_is_ignored (window, ignored)) {
              ret = TRUE;
          }
          break;
      }
  }
  ...
}
```

и в `local_command_line`:

```c
if (desktop_already_managed ()) {
    goto out;      /* просто выходим, ничего не рисуем */
}
```

Терминальное сообщение:

```text
Nemo-WARNING: Desktop already managed by another application, skipping desktop setup.
To change this, modify org.nemo.desktop 'ignored-desktop-handlers'.
```

Смысл: Nemo ищет **любое** окно с типом `DESKTOP` и, найдя, **не создаёт окно с иконками вообще**. Не «рисует медленно», а не рисует никогда — сколько ни жди.

### 4.1. Что считается «игнорируемым»

Список `org.nemo.desktop ignored-desktop-handlers` на этой машине:

```bash
$ gsettings get org.nemo.desktop ignored-desktop-handlers
['conky', 'csd-background']
```

Проверка идёт по `WM_CLASS` окна (регистронезависимо, подстрокой). Наш класс — `themehost.py`, в список не входит, поэтому Nemo сдаётся.

> **Важно по контракту `SAFETY.md`:** добавлять себя в этот список мы **не будем** — это правка чужих настроек через `gsettings`, что прямо запрещено. Правильный путь — порядок запуска, описанный ниже.

---

## 5. Рабочая схема

### 5.1. Порядок запуска

```text
1. nemo-desktop запущен и УЖЕ владеет рабочим столом
   (окно «Рабочий стол» существует)
2. Mintland создаёт своё окно типа DESKTOP
3. Muffin кладёт его в тот же слой DESKTOP
4. Один remap окна Nemo  →  Muffin ставит его выше нашей сцены
```

Нарушение шага 1 — самая частая причина «иконок нет»: если сцена появится раньше, Nemo откажется от роли.

### 5.2. Проверять окно, а не процесс

Процесс может быть жив, но роль не взять. Правильная проверка:

```bash
wmctrl -l | grep -q "Рабочий стол"
```

а не `pgrep -x nemo-desktop`. У нас этот баг был в `wall-on.sh`.

### 5.3. Один remap вместо raise

Единственное из проверенных средств, которое ставит Nemo выше сцены внутри слоя:

```python
# libX11 через ctypes — без внешних утилит
lib.XUnmapWindow(display, xid)
lib.XSync(display, 0)
time.sleep(0.3)
lib.XMapWindow(display, xid)
lib.XSync(display, 0)
```

Muffin воспринимает это как появление окна и кладёт его выше.

---

## 6. Что не работает (проверено замерами)

Все способы ниже **оставляли иконки под сценой**:

| Способ | Почему не помогает |
|---|---|
| `deskwall -u` / `XRaiseWindow` | Меняет X11-порядок, а не `MetaStack` |
| `deskwall -r` (положить ниже Nemo) | То же: правит X, а рисует Muffin |
| Смена типа `NORMAL` ↔ `DESKTOP` | Тип DESKTOP всё равно даёт `META_LAYER_DESKTOP`, а NORMAL+`BELOW` уходит в `BOTTOM` — выше |
| Снятие `_NET_WM_STATE_BELOW` | Для DESKTOP флаг игнорируется (`get_standalone_layer`) |
| Снятие `_NET_WM_STATE_DEMANDS_ATTENTION` | Флаг не влияет на слой, только на «внимание» |
| Ожидание «пока догрузится» | Иконок не будет вообще — Nemo вышел |

Отдельно стоит запомнить: **флаг `BELOW` опасен**. Для окна типа `DESKTOP` он игнорируется, а для любого другого — поднимает окно в `META_LAYER_BOTTOM`, то есть выше рабочего стола.

---

## 7. Как это отлаживать

### 7.1. Посмотреть типы и флаги

```bash
# наши окна
for w in $(wmctrl -l | awk '{print $1}'); do
    echo "$w $(xprop -id $w _NET_WM_WINDOW_TYPE | grep -o 'WINDOW_TYPE_[A-Z]*')"
done
```

Ожидаемо: и `Рабочий стол`, и `mintland-wall` — `WINDOW_TYPE_DESKTOP`.

### 7.2. Проверить, не отказался ли Nemo

```bash
nemo-desktop 2>&1 | head -5
```

Если видно `Desktop already managed by another application` — это оно.

### 7.3. Проверить по экрану, а не по X11

Единственный надёжный способ:

```bash
wmctrl -k on                      # показать рабочий стол
sleep 1
gnome-screenshot -f /tmp/desk.png
wmctrl -k off                     # вернуть окна
```

И смотреть на картинку. Ловушки, на которые я наступил:

- **Скринсейвер.** Если экран заблокирован, на снимке будет заставка, а не рабочий стол. Проверка: `gdbus call --session --dest org.cinnamon.ScreenSaver --object-path /org/cinnamon/ScreenSaver --method org.cinnamon.ScreenSaver.GetActive`.
- **Чужие окна.** `wmctrl -k on` не сворачивает окна, помеченные «always on top». Проверять надо, что в области иконок нет других окон.
- **Светлый фон темы.** Детектор «белые пиксели = иконки» ломается на светлых темах вроде Пляжа: песок тоже светлый. Надёжнее искать текст подписи — светлый пиксель рядом с тёмным (обводка).

### 7.4. Отладка самого Muffin

В исходниках есть темы отладки, включая `META_DEBUG_STACK` — она печатает стек «Bottom to top» с номером слоя и `stack_position` каждого окна:

```c
meta_topic (META_DEBUG_STACK, "%u:%d - %s ",
            w->layer, w->stack_position, w->desc);
```

Включается переменной `MUFFIN_DEBUG=1` (см. `src/core/main.c`), но работает только если композитор собран с `WITH_VERBOSE_MODE`. В дистрибутивной сборке Linux Mint эта поддержка, как правило, выключена, поэтому на практике остаётся проверка по экрану.

---

## 8. Чем это отличается от Wayland

На Wayland слои задаёт протокол, а не догадки:

| | X11 (сейчас) | Wayland (план) |
|---|---|---|
| Кто решает порядок | `MetaStack` Muffin, по `stack_position` | Протокол `wlr-layer-shell`: `BACKGROUND` / `BOTTOM` / `TOP` / `OVERLAY` |
| Порядок между DESKTOP-окнами | не определён, зависит от истории | `nemo-desktop` — `BOTTOM`, Mintland — `BACKGROUND` |
| Как проверить | только по экрану | протокол задаёт явно |
| `deskwall -u` | нужен (и не помогает) | не нужен и бессмысленен |

То есть на Wayland этой путаницы не будет по построению — подробности в [`WAYLAND.md`](WAYLAND.md).

---

## 9. Итоговая памятка

- **Cinnamon не рисует рабочий стол.** Иконки — `nemo-desktop`, обои — `csd-background`.
- **`META_LAYER_DESKTOP = 0` — самый нижний слой.** Внутри него порядок задаёт `stack_position`, а не X11.
- **X11-стек врёт** для окон одного типа. Проверять только по экрану.
- **`BELOW` для не-DESKTOP окна поднимает его выше рабочего стола.** Не ставить «на всякий случай».
- **Nemo отказывается от роли**, если видит чужое DESKTOP-окно. Порядок запуска критичен, и проверять надо окно, а не процесс.
- **Единственное, что ставит Nemo выше сцены** — короткий unmap/map его окна. Один раз; больше — иконки мигают.
