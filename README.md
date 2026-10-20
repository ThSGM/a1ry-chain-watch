# a1ry Chain Watch

A small, movable chain timer for [Torn](https://www.torn.com) that works at desktop width, in the
mobile layout and in TornPDA.

It shows two timers side by side, so you can tell straight away if one of them stops working:

- **Left: local.** Read from the page or Torn's own sidebar data, with no API calls.
- **Right: API.** From the Torn API (a Public key is enough), checked every 10 s.

The small grey text under each timer says where the time came from (e.g. `BAR`, `SES`, `API 12s`).
The codes are listed at the top of the script.

## Features

- Flashes and beeps when the chain drops below your alert time (set in **OPT**).
- Shows the chain count (e.g. `5/10`) in the top-left corner.
- Drag the box anywhere. Tap the timers to open the attack page of a random target.
- Tap **||** to minimise it; tap the circle to bring it back.
- Settings and position are shared across tabs.

## Install

- **Desktop:** install a userscript manager (e.g. Tampermonkey or Violentmonkey), then install the
  script from Greasy Fork or from
  [`a1ry-chain-watch.user.js`](https://github.com/ThSGM/a1ry-chain-watch/raw/main/a1ry-chain-watch.user.js).
- **TornPDA:** add it under the app's userscript settings, set to run on `torn.com`.

Then tap **OPT**, enter a Public API key for the right-hand timer, and set your alert time.

## Credits

Based on [TornPDA Movable Chain Timer With Alert](https://greasyfork.org/scripts/581230) by
Yendor74. The random-target idea comes from Random Target Finder by Omanpx. Both are MIT licensed.

## Licence

[MIT](LICENSE)
