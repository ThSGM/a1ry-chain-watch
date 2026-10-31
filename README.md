# a1ry Chain Watch

A small, movable chain timer for [Torn](https://www.torn.com) that works at desktop width, in the
mobile layout and in TornPDA.

It shows two timers side by side, so you can tell straight away if one of them stops working:

- **Left: local.** Read from the page or Torn's own sidebar data, with no API calls.
- **Right: API.** From the Torn API (a Public key is enough), checked every 5 s during a chain
  (every 30 s otherwise).

The small grey text under each timer says where the time came from (e.g. `BAR`, `SES`, `API 12s`).
Tap **?** in **OPT** for what the codes mean; they're also listed at the top of the script.

## Features

- Flashes and beeps every second when the chain drops to your warning time (default 2:30).
  Tap **ACK** to silence it; from the panic time (default 2:00) it comes back and can't be
  silenced. Both times are set in **OPT**. A hit cancels the acknowledgement.
- The box and screen edges flash orange while the alarm sounds, then red and faster from the
  panic time. The beep
  volume, the screen flash and the box size (75-400 %) are set in **OPT**.
- Minimised, it gives no alarm at all.
- Shows the chain count and health in a bar under the timers (e.g. `Chain 1,234 | Health 90%`).
  The bar fills with your health (0-100%), worked out from the left timer with no API calls. A hit
  with over 3:00 left gives +1, 2:00-3:00 gives -20, 1:00-2:00 gives -50, and under 1:00 drops it
  to 1, where it flashes red.
  It goes to 0 when the chain ends and starts again from 0 each time you open the browser. Every
  faction hit counts, but only while a tab with the box is open and visible.
- **Right side** in **OPT** picks what the right half shows:
  - **Timer** (the default): the API timer.
  - **Flappy**: a tiny pixel Flappy Bird. Tap to flap, hold to keep flapping. It only runs while the
    chain timer is above 4:00, and every chain hit drops a coin onto the bird, which glows. Your
    best score is kept.
  - **Pet**: a little pixel cat to look after, Tamagotchi style. Each chain hit earns it a coin; a
    meal costs 20 coins and fills one of its 4 hearts, and a heart drains every hour. It poops after
    eating, gets sad when very hungry or messy (never sick), and falls asleep if left alone. It
    cheers when the chain timer passes 4:00 and panics at 3:00 until the next hit. Tap it to wake,
    clean, feed or play with it; hold to feed.
- Each hit can play a sound at the alarm volume: a soft marimba note for a +1 (Timer), a coin landing
  on the bird (Flappy) or a coin sound (Pet, which also cheers and panics out loud). It's off by default: tick **Hit sound** in **OPT**
  to turn it on.
- Drag the box anywhere. Tap the timers to open the attack page of a random target.
- Tap **DASH** to open the [dashboard](https://naughtybot.unifiedbot.net/) in a new tab.
- Tap **MIN** to minimise it; tap the circle to bring it back.
- Settings and position are shared across tabs.

## Install

- **Desktop:** install a userscript manager (e.g. Tampermonkey or Violentmonkey), then install the
  script from Greasy Fork or from
  [`a1ry-chain-watch.user.js`](https://github.com/ThSGM/a1ry-chain-watch/raw/main/a1ry-chain-watch.user.js).
- **TornPDA:** add it under the app's userscript settings, set to run on `torn.com`.

Then tap **OPT**, enter a Public API key for the right-hand timer, and set your warning and
panic times.

## Credits

Based on [TornPDA Movable Chain Timer With Alert](https://greasyfork.org/scripts/581230) by
Yendor74. The random-target idea comes from Random Target Finder by Omanpx. Both are MIT licensed.

## Licence

[MIT](LICENSE)
