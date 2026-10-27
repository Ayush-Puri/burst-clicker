# Burst Clicker

A Chrome extension that clicks where you tell it to, at an exact wall-clock time you type,
in a rapid burst — for the moment a booking window, drop, or release opens.

- **Auto-click "Yes" — no markers, turn it on once.** On by default: at the instant it finds
  the Yes button on the page by its label and clicks it, once — then re-arms for the next day. See [Auto-Yes](#auto-yes-and-the-weekly-schedule).
- **1 pm on weekdays, 10 am on weekends** by default, timed to the website's own clock.
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

## Install

Chrome only installs an extension like this from a folder on your computer ("unpacked"),
so installing is: get the folder, then point Chrome at it. Takes about a minute.

### 1. Get the folder

**Option A — download the zip (no tools needed).**
Go to [Releases](https://github.com/Ayush-Puri/burst-clicker/releases/latest), download
`burst-clicker-vX.Y.Z.zip`, and **unzip it**. You get a folder called `burst-clicker`
that contains `manifest.json`. Move it somewhere permanent first — e.g. your Documents
folder — because Chrome loads it from that exact place every time it starts. Don't load it
from Downloads and then delete it.

**Option B — git** (easiest to update later):

```bash
git clone https://github.com/Ayush-Puri/burst-clicker.git
cd burst-clicker && pwd          # copy this path for step 2
```

### 2. Load it into Chrome

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (toggle, top right).
3. Click **Load unpacked** and pick the `burst-clicker` folder — the one that directly
   contains `manifest.json`. (On macOS, press `⌘⇧G` in the dialog and paste the path.)
4. Click the puzzle-piece icon in the toolbar and **pin** Burst Clicker.

Chrome now and then shows "Disable developer mode extensions" — that's normal for any
extension not from the Web Store. Choose to keep it.

## Update

Keep the **same folder** and Chrome keeps your settings and enabled pages.

- **Zip install:** download the new zip from
  [Releases](https://github.com/Ayush-Puri/burst-clicker/releases/latest), unzip it, and
  replace the *contents* of your existing `burst-clicker` folder with the new files (same
  folder, same place).
- **Git install:** `cd burst-clicker && git pull`

Then open `chrome://extensions` and click the reload arrow ⟳ on the Burst Clicker card.
Unpacked extensions never update on their own. After a reload, tabs that were turned on arm
themselves again.

Don't "Remove" the extension and load a folder from a different place to update — Chrome
treats that as a new extension and your settings start fresh.

## Use it — auto-click "Yes" (the default)

1. Open the page that shows the **Yes** button for a lead. Leave it open; it can sit in a
   background tab or another window.
2. Click the Burst Clicker icon → **Turn on for this tab**.

That's all. It clicks **Yes** at **1:00 pm Monday–Friday** and **10:00 am Saturday–Sunday**,
on the website's own clock, every day, until you turn it off. Nothing to place, nothing to
re-arm.

**You can see what it found.** While the tab is on, the Yes button it will click has a
pulsing **green ring** around it with the label *"✓ Burst Clicker will click this · 13:00:00
today"*. The ring follows the button if it moves. If there's no Yes on screen, an **amber
notice** in the top-right corner says so — at fire time it will keep looking for one. The
popup says the same: *✓ "Yes" button found on this page* or *✗ no "Yes" button on screen
right now*, even before you turn it on. The ring is click-through; it never gets in the way.

**Several lead pages at once?** Open (inspect) all of them, then click the icon once →
**Turn on for every tab with a Yes**. Every open tab showing a Yes is turned on; tabs
without one are left alone. They all fire on the same instant — measured with six background
tabs: all six within 0–1 ms.

**Yes disabled until 1 pm?** That's fine: the ring turns **amber** with *"Found, but disabled
right now — will click it the moment it enables"*, and at the instant it clicks as soon as the
button becomes clickable (measured: 11 ms after it enabled).

The popup shows the countdown to the next click and, about 20 seconds before each one, how
far the website's clock is from yours. **Armed tabs** lists every tab that's on.

- **Turn off:** icon → **Turn off for this tab**, or close the tab.
- **Back to 1 pm / 10 am** after changing the times: **⟳ Reset to schedule**.
- **Try it right now:** with a Yes on screen, press **Test now** — it clicks it in ~1 second,
  once, and doesn't change the daily schedule.
- **Keep the computer awake** at those times — a sleeping computer can't click (see
  [below](#auto-yes-and-the-weekly-schedule)).

The rest of this README covers how it works, and the older marker mode (turn off
**Auto-click "Yes"** to use it).

## Use it — markers (advanced)

1. Turn off **Auto-click "Yes"** and **Weekday / weekend schedule** in the popup.
2. Open the page you want to click on, sized the way you will leave it.
3. Toolbar icon → **Place markers**, then click the page wherever you want a click to fire.
   Numbered rings appear — **green** means the marker locked onto the button under it and
   will follow that button; red means it is a bare coordinate. Drag to move, right-click to
   delete, `Esc` to exit.
4. Set **Fire at** — see [Time input](#time-input) — and **Clicks per marker** / **Gap between
   clicks**.
5. **Arm this tab.** Repeat on as many tabs as you like. Marker mode fires once per arming.

Keyboard: `⌥⇧M` panel · `⌥⇧P` place mode · `⌥⇧A` turn on / off.

## Auto-Yes and the weekly schedule

The default setup, for picking up a lead the moment the window opens. **One click, once:**

1. Open the page that shows the **Yes** button.
2. Toolbar icon → **Turn on for this tab**.

From then on it clicks **Yes** at **1:00 pm Monday–Friday** and **10:00 am Saturday–Sunday**,
every day, without being touched again:

- **It re-arms itself** after every fire, for the next weekday/weekend instant.
- **The tab can be in the background**, in another window, and can reload or navigate —
  it stays on. Only the tab being closed, or **Turn off for this tab**, stops it.
- **It survives a browser restart and an extension update**: the page is remembered, and any
  tab showing it arms itself again. Opening the page in a new tab does the same.
- **It fires on the website's clock, not your computer's.** ~20 s before each fire it
  measures how far the site's clock is from yours (to a few ms, from the site's `Date`
  header) and moves the instant to the site's 1 pm. The result shows under the countdown.
  If the site's clock cannot be read cleanly, it falls back to your **Clock offset**.

At fire time the page is scanned for a visible, enabled element whose whole label is `Yes`
(case-insensitive; buttons and links first, then plain text). If there are several, the
top-most one wins. Exactly **one** click is sent. If no Yes is on the page at the instant, it
keeps looking every 10ms for **Keep looking for** (default 3 s) and clicks the moment one
appears.

**⟳ Reset to schedule** puts both times back to 1 pm / 10 am and re-arms the tab.

| Field | What it does |
|---|---|
| Auto-click "Yes" | On by default. Off = use placed markers instead (one-shot, as before). |
| Weekday / weekend schedule | On by default. Off = the single **Fire at** time, daily. |
| Match the website's clock | On by default. Off = use **Clock offset** as typed. |
| Weekday time / Weekend time | 13:00 and 10:00 by default. |
| Button text to click | The label to look for. Default `Yes`. |
| Keep looking for (ms) | How long after the instant to keep hunting for the button. |

**Keep the computer awake at those times.** A sleeping Mac cannot click; the click goes out
late, when it wakes. To wake it a few minutes early every day:

```bash
sudo pmset repeat wakeorpoweron MTWRF 12:55:00     # weekdays; weekends need their own schedule
```

### One exact click on a dialog button

The common case — a confirm dialog is open and its **Yes** must be clicked at 1 pm exactly,
once:

1. Open the dialog so the button is on screen.
2. **Place markers** → click the middle of the button. The ring turns green: locked.
3. Leave **Lock markers to the element** and **Stop as soon as the click lands** on.
4. **1 pm** (the default) → **⟳ sync to server clock** → **Arm this tab**.

Leave *Clicks per marker* at a few: the first click fires on the instant, and the rest are
only spent if the dialog is still there. The moment the button is gone the burst stops, so
a retry can never land on the page behind a dialog that just closed.

## Development

Requires Node 22 or newer (the test harness uses the built-in `WebSocket`) and Google
Chrome. There are no dependencies to install — no `npm install`, no build step.

```bash
node test/e2e.mjs               # full end-to-end suite in headless Chrome (~2.5 min)
node test/e2e.mjs input         # one suite: input | visible | anchor | auto | hidden | multi | evict
CHROME_BIN=/path/to/chromium node test/e2e.mjs   # use another Chromium browser (e.g. Brave)
./package.sh                    # build a shareable zip into ~/Downloads
python3 icons/make_icons.py     # regenerate the PNG icons
```

Point the suite at a packaged copy instead of the working tree with
`BURST_EXT_DIR=/path/to/unzipped node test/e2e.mjs`. See
[What the tests cover](#what-the-tests-cover).

## Getting the click out as early as possible

Everything that does not have to happen at the instant is done before it:

- the worker resolves the schedule to one absolute epoch ms at arm time, and re-reads
  `target - Date.now()` on every pass of the wait, so a late wake-up self-corrects;
- 1.5s out, the worker starts the fire sequence, so storage and tab lookups are out of the way;
- ~900ms out, the page resolves every marker (or finds the Yes) to its element, caches it, and
  sends the hover half of the click (`pointerover`, `mouseover`, `pointermove`, `mousemove`),
  so hover handlers and the hit-test are already paid for;
- 400ms out, the extension's own panel goes click-through;
- 150ms out, the page is handed the click and **spins** to the instant — hidden-tab timers
  are throttled to 1/s, a synchronous spin is not, and a message to a hidden tab can take
  60–90ms to arrive;
- for its last 400ms of any wait the worker does not trust timers at all: in a background
  browser the OS coalesces them and `setTimeout` was measured waking 60–90ms late. It spins
  cooperatively (MessageChannel hops) instead, so replies from the page still get through;
- at the instant the page has only `pointerdown → mousedown → pointerup → mouseup → click`
  left to dispatch, on an element it already holds.

Trusted mode is the same story from the worker's side: the debugger is attached at arm time,
the cursor is parked on the target ahead of the instant, the first click's coordinates are
re-resolved at ~60ms out (which is what catches a dialog that only opens in the last
second), and the CDP commands are pipelined rather than awaited one by one.

Each run's log (`lastrun:` in storage) records how far ahead of the instant every stage
happened (`stages`, `timing`) — a negative number there means that step was late.

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
| Clock offset | Shifts the target. `-150` fires 150ms early. **⟳ sync to server clock** measures it for you: it samples the site's `Date` header until it ticks over, brackets the moment the server crossed a second, and writes the difference here. |
| Start delay | Waits this long *after* the target before the first click. |
| Clicks per marker | How many clicks each marker gets. |
| Gap between clicks | Milliseconds between consecutive clicks. `0` fires them in one tick. |
| Order | Round-robin (`1,2,3,1,2,3`) or per marker (`1,1,1,2,2,2`). |
| Keep bursting for | Repeats the whole burst for this many ms after the first round. |
| Gap between rounds | Pause between repeats while sustaining. |
| Lock markers to the element | On by default. A marker remembers the button it was dropped on and clicks wherever that button is at fire time. |
| Stop as soon as the click lands | On by default (for locked markers). Ends the burst the moment the target is gone. |

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

From `test/e2e.mjs` on Chrome 151, macOS — drift of the first click from the target instant
(v1.3, headless Brave on macOS: 0–6ms in every scenario, 3–12ms after an eviction):

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

A marker remembers two things: the **viewport coordinate** you dropped it on, and — with
**Lock markers to the element** on — the **element** that was under it. The lock stores the
element's selector, its visible text, and where inside its box you clicked, so at fire time
the click goes wherever that button is *now*. A centred dialog that moves because the window
was resized, because the DevTools banner appeared, or because it re-rendered, still gets
hit. Only if the element cannot be found does the marker fall back to its stored pixel.

Turn the lock off and a marker is a plain coordinate, like a desktop auto-clicker pointed at
a spot on screen: it hits whatever ends up there. Then don't scroll or resize after placing.

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
- **Marker schedules do not survive a browser restart** — Chrome reassigns tab ids. Auto-Yes
  tabs do: their page is remembered and re-armed on startup.
- **If the machine sleeps through the target**, the burst fires when it wakes, late. Nothing
  in the browser can fix that; keep the Mac awake if the target matters.
- A reload mid-countdown is fine; the schedule lives in the worker, not the page.

## What the tests cover

The harness launches a throwaway headless Chrome profile, installs the unpacked extension
over CDP, drives the real UI, and asserts: default 1 pm and every accepted/rejected time
format; click counts, ordering, coordinates and drift; `isTrusted`; that the tab reported
`visibilityState === 'hidden'` when it fired; two tabs firing at their own instants 1.5 s
apart while both are off screen; Memory-Saver protection set and released; schedules
dropped when a tab closes; a burst still landing on time after the service worker is
force-terminated mid-wait; and — against a stand-in confirm dialog — a locked marker
following its button 150px after arming, one click ending the burst with nothing leaking
onto the page behind the closed dialog, the same thing with real trusted input in a hidden
tab, and a dialog that only opens 450ms before the instant still being hit; and for auto-Yes:
finding and clicking Yes with no markers in synthetic and trusted mode, a Yes that only
appears after the instant, re-arming for the next day, staying on through navigation,
restart recovery, firing on a site clock that runs 700ms ahead, the on-page ring, and six
background tabs turned on with one click firing together. **121 checks.**

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
