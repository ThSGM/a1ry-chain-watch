# a1ry Chain Watch: notes for resuming work

A single userscript, `a1ry-chain-watch.user.js` (`@grant none`), for Torn chain timers: desktop,
mobile layout and TornPDA (iPad included). The README is the user-facing description; the comment
block at the top of the script lists the timer source codes and every feature in detail.

## Conventions

- **Every change bumps the version in two places**: `// @version` in the header and
  `SCRIPT_VERSION` (GM_info isn't available in every host). One commit per version, with the message
  `3.xx: Short summary`.
- When behaviour changes, also update: the comment block at the top of the script, the help panel
  text in OPT (`#pda-help`), and the README.
- Commit and push only when the user asks. They usually test the change first, sometimes on a
  standalone HTML test page (see Testing).
- Greasy Fork may not sync from GitHub automatically, so TornPDA only gets a version once the
  user updates it there.
- Keep it light: no extra API calls, no new timers or observers. Everything runs from the one 1 s
  main loop (section 6). Canvas animations use `requestAnimationFrame` only while something moves.
  Page writes go through `setText` (it only writes when the text changed).
- Settings and state live in `localStorage`, under keys starting `pda_chain_timer_` (the prefix is
  left from the script this was based on). They are shared across tabs.
- Sounds are synthesised with Web Audio (`playSound`, with the note format described above
  `ALARM_SOUNDS`). There are no sound files. The user dislikes high-pitched sounds, apart from the
  Mario-style coin.

## Layout of the script

| Where | What |
|---|---|
| Top constants | `TARGET_RANGES`, `excludedIDs`, API intervals, `HP_MAX`, `HIT_TICK`, `GAME_SOUNDS`, `DIGITS`, `ALARM_SOUNDS` |
| `loadSettings` | Every OPT setting; it runs again when another tab saves (`pda_chain_timer_settings_saved`) |
| CSS / markup | One `<style>` block, then `container.innerHTML` (header, two timer halves with the canvases, the count/health bar, the OPT panel and help) |
| Local timer storage | `saveLocalExpire` (writes only when the end time moves by more than 2 s) |
| Health bar | `updateHealth`, `setHealth`, `playHealthEffect`, `renderHealth`, and the session cookie |
| Right side | `createFlappy` (48x24), the pet (`loadPet`/`savePet`/`petNow`/`petEarn`, `createPet`, 56x28), `fillPx`, `drawNumber` |
| 2. Drag | Pointer drag; a tap on the display opens a random target |
| 3. UI listeners | OPT save (`closeSettingsBtn`), help, ACK, MIN, audio unlock, `renderApiHelp` |
| 4. Local timer | `updateLocalTimer`: sources BAR / COOL, then ATK, SES, DOM, MEM |
| 5. API timer | `fetchApiChain` / `updateApiTimer`: one call at a time, shared across tabs |
| 6. Main loop | 1 s `setInterval`. It returns early when minimised or the tab is hidden |

## Fragile areas and known bugs

These are listed roughly by how often they have caused trouble.

### 1. Hit detection (health bar, hit sounds, Flappy, pet coins)
No API is used, so a "hit" is inferred from the local timer going back up. This has needed fixing
twice.
- **3.93-3.97** compared chain end times, and any forward jump of more than 3 s counted as a hit.
  On the attack page this fired a hit (and its sound) every few seconds. The cause was never
  confirmed. It was either the ATK header time standing still (the computed end time then creeps
  forward), or switching between ATK and stale SES data.
- **3.98** counts a hit only when the *same source* reads a higher time than this tab read
  under 3 s earlier (`lastSeconds`, `lastSrc`, `lastPageRead`). The saved end time
  (`pda_chain_timer_local_expire`) is the cross-tab check that stops a hit counting twice: the
  scoring tab writes it straight away, and a hit needs it to move by more than 1.5 s.
- **Still open:** the 3.98 fix hasn't been confirmed on the real attack page. Ask the user what
  the left timer's source label (`ATK`?) does there.
- **Known limits:** every faction hit counts, not only the user's (whose hit it was can't be
  seen without the API). Hits are only seen by a visible, unminimised tab. A hit within about 1 s
  of the previous one may not register, as times are read in whole seconds.
- **Scoring:** over 3:00 left gives +1; 2:00-3:00 gives -20; 1:00-2:00 gives -50; under 1:00 sets
  health to 1. Health stays within 1-100 after a hit. It is 0 when the chain ends, and at the start
  of a browser session.
- **Chain end:** health resets only when a trusted source reads 0 (`zeroIsEnd`) *and* the saved
  end time has passed. Without that check, a stale SES running down, or the loose DOM match, could
  wipe health mid-chain.

### 2. Local timer sources (Torn's markup changes)
- Elements are found by partial class names (`chainBar___`, `barTimeLeft___`, `labelTitle___`,
  `progress___`/`cooldown___`), plus older names. Torn renames these from time to time.
- BAR only works at desktop width; the mobile bar shows just the count.
- SES (`sessionStorage` `sidebarData<userID>`) goes stale on pages without the sidebar, such as
  the attack page. It's unknown whether it updates live on mobile and PDA. If it doesn't, hits
  won't register there.
- DOM is a loose fallback (any class or id containing "chain" with an M:SS time).

### 3. The API timer
- The user reports that the API timer "isn't working". The cause is unknown.
  **3.99 (not pushed at the time of writing)** saves the full outcome of each call to
  `pda_chain_timer_api_detail` and shows it at the top of the OPT **?** help. Torn errors, HTTP
  errors, network errors and "no key" are all reported, and the key is never shown. Next step: get
  that line from the user.
- Also check: with Right side set to **Flappy** or **Pet**, the API timer is hidden on purpose.
- Polling is every 5 s during a chain and every 30 s otherwise, shared across tabs through
  `pda_chain_timer_api_last_call`. A call pending for over 15 s is treated as lost.

### 4. Audio on iOS / TornPDA
- Audio needs a tap before it can start. `pointerdown` doesn't count as a tap for this on touch
  screens, so 3.94 also unlocks on `pointerup`, `touchend`, `click` and `keydown`. It also resumes
  the `interrupted` state, and sets `navigator.audioSession.type = 'playback'` (iOS 17+) so silent
  mode doesn't mute it.
- The user said sound didn't work on iPad TornPDA. After 3.94 there was no confirmation either
  way.

### 5. Session reset of health
- Health resets when the session cookie `a1ry_hp_session` is missing; it has no expiry, so the
  browser deletes it on close. In TornPDA the cookie may survive backgrounding until the app is
  fully closed.

### 6. Right side modes (`data-right` on the container: timer / flappy / pet)
- **Flappy:** the canvas stops `pointerdown`, so the right half can't start a drag or open a target.
  It is active only while the chain time (local, else API) is above 240 s, and not when minimised,
  hidden or in OPT. If paused mid-flight, it waits for a tap. The best score is in
  `pda_chain_timer_game_best`.
- **Pet (4.00):** state in `pda_chain_timer_pet` (`coins`, `hunger` + `hungerAt`, `poops` +
  `poopAt` due times, `touchAt`), shared across tabs; hunger and poop are derived from timestamps in
  `petNow`, never by a timer. Tuning constants at the top: `PET_FEED_COST` 20, `PET_HUNGER_STEP` 1 h,
  `PET_POOP_DELAY` 10 min, `PET_NAP` 10 min. A meal fills 1 heart (user's choice). Coins come from
  `petEarn()` in `playHealthEffect` for every hit the tab sees, in any Right side mode. The 4:00 cheer
  and 3:00 panic fire when the chain time crosses the mark between two ticks of a tab showing the pet
  (`prevChain`); worried while 0 < time <= 180; the panic wakes it. Animation is 2 fps: the main
  loop's `petGame.tick()` plus one 500 ms timeout (1 fps asleep); `tick(null)` stops it. The canvas
  stops `pointerdown` (tap = wake/clean/feed/play, 500 ms hold = feed). Sad only, never sick (user's
  choice). Interaction sounds always play; cheer/panic/hit sounds follow Hit sound.
- **Coins mode** (3.95-3.99) was removed in 4.00 as unpopular; a saved `coins` falls back to Timer.
- Hit sounds play only in the tab that saw the hit (`playHealthEffect(event, local)`). Other tabs
  get the effect through the `storage` event on `pda_chain_timer_hp_event`. The **Hit sound**
  setting is off by default (since 3.99) and stored as `pda_chain_timer_hit_sound`; the old
  `pda_chain_timer_hit_tick` key (on by default) is no longer read.

### 7. The count/health bar
- It reads `Chain 100,000 | Health 100%` at most: 27 characters of 8px Courier New, about 130px,
  in a 136px inner width at 100% Size. Anything longer will be clipped.

### 8. Big-target blocking
- The fight button is found by its text (`Start fight` / `Join fight`), and maximum health by the
  text `Health X / Y` in the defender's panel. Only the script's own random picks are checked.

## Open threads

- Flappy faction leaderboard: the options offered were a share-to-clipboard button, or a Google
  Sheet + Apps Script web app (opt-in, trust-based). The user hasn't chosen yet.
- Confirm the 3.98 attack-page fix and the 3.94 iPad audio fix.
- Diagnose the API timer using the 3.99 help line.

## Testing

There is no test suite in the repo. What has worked so far (in a scratch folder, not committed):

- **Syntax:** `node --check a1ry-chain-watch.user.js`.
- **Load test:** run the whole script in jsdom (`npm i jsdom`). Load it with
  `url: 'https://www.torn.com/index.php'`, `runScripts: 'outside-only'` and
  `pretendToBeVisual: true`. Stub `HTMLCanvasElement.prototype.getContext` and `fetch`, and add a
  fake `a.chainBar___x > span.barTimeLeft___y` whose text you change to simulate the timer. Wait
  more than 1 s per tick, then check `localStorage` and the DOM.
- **Logic simulation:** take the health section out of the file (from `function saveLocalExpire` to
  the `storage` listener) and `eval` it with mocked `localStorage` and `Date.now`, and stub
  elements. That makes it quick to test hit and burst scenarios, frozen or flickering sources, and
  two tabs.
- **Visual check:** a standalone HTML page with a copy of the box, a fake chain timer, a "Chain
  hit" button and auto hits. The game code is copied between it and the script, re-indented from
  2 to 4 spaces. Rebuild it if you need it.
- **Real-device checks** (attack page, iPad audio, API) can only be done by the user.
