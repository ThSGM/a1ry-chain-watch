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
  volume, the screen flash and the box size (75-200 %) are set in **OPT**.
- Minimised, it gives no alarm at all.
- Shows the chain count (e.g. `5/10`) in the top-left corner.
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
