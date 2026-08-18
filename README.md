# Burst Clicker

A Chrome extension that clicks where you tell it to, at an exact wall-clock time you type,
in a rapid burst — for the moment a booking window, drop, or release opens.

- **An exact instant, never a countdown.** You type a time; it resolves to one fixed
  millisecond and fires there. See [Why a time, not a timer](#why-a-time-not-a-timer).
- **Markers** — click anywhere on the page to drop numbered click points. Drag to move,
  right-click to delete. Saved per page URL, so they survive a reload.
- **Any number of tabs at once**, each with its own time, its own markers, and its own
  burst. An armed tab does **not** need to be active or on screen.
- **Burst** — N clicks per marker at a chosen gap, round-robin or marker-by-marker, with an
  optional *sustain* window that keeps re-firing (for when the thing you're clicking takes
  a moment to appear).
- **Two click engines** — synthetic DOM events (default), or real trusted browser input via
  the DevTools protocol for sites that check `event.isTrusted`.

## Quick start

Chrome cannot install an extension from a command line, so this is two commands plus
three clicks. Nothing is downloaded or built — the repo *is* the extension.

```bash
git clone https://github.com/Ayush-Puri/burst-clicker.git
cd burst-clicker && pwd          # copy this path for step 3
```

1. Open `chrome://extensions` in Chrome.
2. Turn on **Developer mode** (toggle, top right).
3. Click **Load unpacked** and select the `burst-clicker` folder — the one containing
   `manifest.json`. On macOS press `⌘⇧G` in the dialog and paste the path from above.
4. Click the puzzle-piece icon in the toolbar and **pin** Burst Clicker.

Handy for step 3 — reveal the folder in your file manager:

```bash
open .            # macOS
xdg-open .        # Linux
explorer.exe .    # Windows (WSL: explorer.exe $(wslpath -w .))
```

Prefer not to use git? Use **Code → Download ZIP** on GitHub, unzip it, and load that
folder instead. Chrome needs an unzipped folder; it cannot load a `.zip`.

### Updating

```bash
cd burst-clicker && git pull
```

Then click the reload arrow ⟳ on the Burst Clicker card in `chrome://extensions`.
Unpacked extensions do not auto-update. Your markers and settings survive a reload.

## Use it

1. Open the page you want to click on, sized the way you will leave it.
2. Toolbar icon → **Place markers**, then click the page wherever you want a click to fire.
   Numbered rings appear. Drag to move, right-click to delete, `Esc` to exit.
3. Set **Fire at**. Default is **1:00 pm**. Type it however you like — see
   [Time input](#time-input).
4. Set **Clicks per marker** and **Gap between clicks**.
5. **Arm this tab.** Repeat on as many tabs as you like — the popup lists every armed tab
   with its own countdown. Then leave them open and go do something else.

Keyboard: `⌥⇧M` panel · `⌥⇧P` place mode · `⌥⇧A` arm/disarm.

## Development

Requires Node 22 or newer (the test harness uses the built-in `WebSocket`) and Google
Chrome. There are no dependencies to install — no `npm install`, no build step.

```bash
node test/e2e.mjs               # full end-to-end suite in headless Chrome (~2.5 min)
node test/e2e.mjs input         # one suite: input | visible | hidden | multi | evict
./package.sh                    # build a shareable zip into ~/Downloads
python3 icons/make_icons.py     # regenerate the PNG icons
```

Point the suite at a packaged copy instead of the working tree with
`BURST_EXT_DIR=/path/to/unzipped node test/e2e.mjs`. See
[What the tests cover](#what-the-tests-cover).

## Why a time, not a timer

A countdown accumulates error: every tick that arrives a few milliseconds late pushes the
end further out, and a hidden tab's timer can be a whole second (or minute) coarse.

This never counts down. Arming resolves your text to one absolute epoch millisecond, and
the wait loop re-reads the system clock every pass — `target - Date.now()` — sleeping most
of the way, then busy-spinning the last few milliseconds onto the target. A late wake-up
corrects itself instead of compounding, because nothing is ever measured relative to the
previous tick. The countdown you see on screen is only a readout.

The stored schedule is the absolute instant too, so a page reload, a browser tab shuffle,
or the service worker being evicted and revived cannot shift it.

## Time input

The **Fire at** field takes whatever is natural, and normalises to `HH:MM:SS.mmm` as soon
as you commit it, so you can see what it understood:

| You type | It fires at |
|---|---|
| `1pm`, `1 pm`, `1 p.m.` | 13:00:00.000 |
| `1:05 PM` | 13:05:00.000 |
| `13:00` | 13:00:00.000 |
| `13:00:00.250` | 13:00:00.250 (millisecond precision) |
| `9:30` | 09:30:00.000 |
| `12am` / `12pm` | 00:00:00.000 / 12:00:00.000 |

A bare hour with no am/pm is read as 24-hour (`1` → 01:00). A time already past today rolls
to tomorrow. Unreadable input is rejected out loud rather than guessed at.

### Fields

| Field | What it does |
|---|---|
| Fire at | The exact local instant. Default 1:00 pm. |
| Clock offset | Shifts the target. `-150` fires 150ms early — use it to compensate for a server clock that runs ahead of yours. |
| Start delay | Waits this long *after* the target before the first click. |
| Clicks per marker | How many clicks each marker gets. |
| Gap between clicks | Milliseconds between consecutive clicks. `0` fires them in one tick. |
| Order | Round-robin (`1,2,3,1,2,3`) or per marker (`1,1,1,2,2,2`). |
| Keep bursting for | Repeats the whole burst for this many ms after the first round. |
| Gap between rounds | Pause between repeats while sustaining. |

Total clicks are capped at 5000 per run.

## Multiple tabs, and background tabs

Arm as many tabs as you want. Each schedule is a **snapshot** taken when you armed it, so
editing the fields afterwards only affects the *next* tab you arm — an armed tab keeps the
time it was armed with. The popup's **Armed tabs** list shows every one with its own
countdown, and a ✕ to disarm it.

The tab does not need to be focused, on screen, or in the front window. That works because
the **service worker owns the clock**, not the page: Chrome throttles page timers to once a
second in a hidden tab (once a minute after five minutes), which would make a background
tab fire wildly late. Instead the worker times everything and drives each tab:

- **Trusted mode** — the worker dispatches the input itself, so the page is not involved in
  timing at all.
- **Synthetic mode** — the worker hands the page each burst in chunks of ≤250 ms, a little
  ahead of time, and the page *spins* (rather than sleeping) to the instant and between
  clicks. Spinning is not throttled; the chunks are short so it never blocks the page for
  long.

Armed tabs are also marked `autoDiscardable: false` so Chrome's Memory Saver cannot drop
them while they wait, and the flag is released when the burst is done.

## Measured accuracy

From `test/e2e.mjs` on Chrome 151, macOS — drift of the first click from the target instant:

| Scenario | Typical | Worst seen |
|---|---|---|
| Visible tab, synthetic | 0.3–3 ms | 3 ms |
| Background tab, synthetic | 1–2 ms | 2 ms |
| Background tab, trusted | 2 ms | 28 ms |
| After the worker was evicted mid-wait | 2–20 ms | 20 ms |

Accuracy is against *your system clock*. If the site's server clock differs, that
difference is yours to absorb with **Clock offset**.

Trusted mode carries a little extra jitter because it goes through Chrome's debugger IPC.

## Trusted clicks

Some sites ignore synthetic events. Trusted mode dispatches real input through
`chrome.debugger` (`Input.dispatchMouseEvent`), which is indistinguishable from a mouse
click as far as the page is concerned.

Turn it on **before placing markers**: Chrome shows a "Burst Clicker started debugging this
browser" banner while attached, and that banner shifts the page down — markers placed
before the banner appears would point at the wrong spot. The extension attaches when you
enable the toggle and detaches after the burst.

## How markers behave

Markers are **viewport coordinates**, like a desktop auto-clicker pointed at a spot on
screen — not references to a particular element. If the page scrolls, the marker stays at
the same place on screen and hits whatever ends up there. Don't scroll or resize after
placing.

Markers are keyed by URL (origin + path), so two tabs on the same page share the same click
points — but each tab still keeps its own time and its own schedule.

The extension's own panel is made click-through for the duration of a burst, and it slides
to a clear corner when you arm if a marker is underneath it, so it can never eat a click.

## Reliability notes

- **Leave the tab open.** It can be backgrounded, in another window, or behind a full-screen
  app. Closing the tab, or navigating it to a different URL, cancels that tab's schedule.
- The worker keeps itself alive with a 20-second heartbeat, and if it is evicted anyway
  (memory pressure, a crash) two alarms bring it back: a 1/minute heartbeat and a one-shot
  five seconds before each target, so it returns in time to do the precise wait itself.
- **Schedules do not survive a browser restart** — Chrome reassigns tab ids, so everything
  is cleared on startup. Re-arm after restarting.
- **If the machine sleeps through the target**, the burst fires when it wakes, late. Nothing
  in the browser can fix that; keep the Mac awake if the target matters.
- A reload mid-countdown is fine; the schedule lives in the worker, not the page.

## What the tests cover

The harness launches a throwaway headless Chrome profile, installs the unpacked extension
over CDP, drives the real UI, and asserts: default 1 pm and every accepted/rejected time
format; click counts, ordering, coordinates and drift; `isTrusted`; that the tab reported
`visibilityState === 'hidden'` when it fired; two tabs firing at their own instants 1.5 s
apart while both are off screen; Memory-Saver protection set and released; schedules
dropped when a tab closes; and a burst still landing on time after the service worker is
force-terminated mid-wait. **58 checks.**

Chrome 151 ignores `--load-extension`, so the harness installs via the browser-level CDP
command `Extensions.loadUnpacked`, which needs `--enable-unsafe-extension-debugging` and a
profile with `extensions.ui.developer_mode` seeded to true. Suites that exercise trusted
mode never attach a debugger to the page (only one client may attach); they drive the
extension from its service-worker target and read results back out of `document.title`.

## Layout

```
manifest.json          MV3 manifest, <all_urls> content script
lib/time.js            time parsing + formatting, shared by worker/popup/panel
lib/plan.js            burst plan maths + chunking, shared
service-worker.js      the scheduler: owns every schedule, clock, CDP engine, alarms
content/content.js     overlay + markers + panel; executes burst chunks by spinning
popup/                 popup UI, incl. the armed-tabs list
icons/make_icons.py    regenerates the PNG icons (no dependencies)
test/e2e.mjs           end-to-end CDP harness
test/page.html         click target page for the harness
package.sh             builds a shareable zip into ~/Downloads
INSTALL.txt            plain-text install steps, for people you send the zip to
GUIDE.html             illustrated guide, opens in any browser
```

## License

MIT — see [LICENSE](LICENSE).

Automating clicks may be against some sites' terms of service — that call is yours.
