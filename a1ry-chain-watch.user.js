// ==UserScript==
// @name         a1ry Chain Watch
// @namespace    https://github.com/ThSGM/a1ry-chain-watch
// @version      3.80
// @description  Movable Torn chain timer for desktop, mobile and TornPDA: local and API timers side by side, with an adjustable alert
// @author       ThSGM
// @homepageURL  https://github.com/ThSGM/a1ry-chain-watch
// @supportURL   https://github.com/ThSGM/a1ry-chain-watch/issues
// @match        https://www.torn.com/*
// @grant        none
// @license      MIT
// ==/UserScript==

// Based on "TornPDA Movable Chain Timer With Alert" by Yendor74 (MIT).
// Tap-for-a-random-target idea from "Random Target Finder" by Omanpx (MIT).

// -------------------------------------------------------------------
// Two independent timers, side by side:
//
//   LEFT  = local sources only (never uses the API)
//   RIGHT = Torn API only
//
// If they disagree, one of them has a problem. Each shows its source
// code underneath.
//
// LEFT source priority (checked every 1s, first match wins):
//
//   1. BAR      Sidebar chain bar time       a[class*="chainBar___"] (or old
//               chain-bar___): its barTimeLeft___ (or old bar-timeleft___)
//               element, else any element inside it whose text is M:SS or
//               (M:SS). Desktop width only: the mobile bar shows just the count.
//      COOL     The chain bar is in cooldown (its progress bar has a
//               cooldown___ class): no chain, so the cooldown time is ignored
//   2. ATK      Attack page header "<hits> (M:SS)" in [class*="labelTitle___"],
//               only on the attack page (sid=attack in the address)
//   3. SES      Torn's own sidebar data in sessionStorage "sidebarData<userID>",
//               chain.timestampToUpdate (end time, Unix seconds). Works on
//               desktop, mobile and PDA; 0 means no chain. Goes stale on pages
//               without the sidebar (e.g. the attack page).
//   4. DOM      Any element with "chain" in class/id holding a standalone
//               0:00-5:59 time, not part of HH:MM:SS (loose fallback)
//   5. MEM-<x>  Local expire time saved by this or another tab; <x> is the
//               code of the source that saved it (e.g. MEM-BAR, MEM-SES)
//   NONE        No local source and the saved time has run out
//
// RIGHT (API) codes:
//   API <n>s     faction/?selections=chain (Public key); <n> = age of the
//                data in seconds. Polled every 5s during a chain (30s
//                otherwise), shared across tabs.
//   API-ERR<n>   Torn API returned error code <n> (e.g. 2 bad key, 5 rate limit)
//   API-NET      API request failed (network / fetch error)
//   NO KEY       No API key set (OPT)
//
// The alert follows the left timer, or the right one when the left has
// nothing. Chain count (top-left, e.g. 5/10) comes from the API.
//
// Alarm (both times set in OPT):
//   At or below the warning time (default 2:30) it flashes and sounds.
//   ACK silences it until the panic time (default 2:00); from there it
//   can't be silenced. The acknowledgement is shared across tabs and page
//   loads, and a hit cancels it. Minimised (MIN) = no alarm at all.
//   OPT also sets the volume, the sound (Chime, Hi-lo, Yelp, Alarm clock,
//   Phone ring, Klaxon, SOS, Warble or Off; all made in the browser, no
//   sound files) and the screen-edge flash, which pulses faster from the
//   panic time.
//
// Keep screen on (OPT): while a chain is running and the box isn't
// minimised, the screen is kept from sleeping (Screen Wake Lock, where
// the browser supports it). The browser drops it while the tab is hidden;
// it is asked for again when the tab is back.
//
// Random targets (tap the timers): a random ID from the range chosen in
// OPT (3.0M-3.4M, 4.2M-4.55M or both), never one in excludedIDs. With
// "Block big targets" on, the attack page of a target picked this way shows
// its maximum health; above BIG_HEALTH it is flagged in purple and the
// Start fight / Join fight button is greyed out and does nothing (found by
// its text, as Torn's class names change). As a warning that doesn't need
// the button, the defender's panel also gets a purple outline and a banner
// shows at the top of the screen. Only the script's own picks
// (the same ID, picked in the last PICK_WINDOW) are checked, so attack
// pages opened any other way are left alone. To attack a blocked target
// anyway, turn the option off in OPT.
// -------------------------------------------------------------------

(function() {
    'use strict';

    // Define requirements
    // User ID ranges that are targeted when the timer is tapped, [min, max] inclusive; OPT
    // picks one, or both (every ID in either range equally likely)
    const ID_RANGES = {
        low: [[3000000, 3400000]],
        high: [[4200000, 4550000]], // the range of Advanced Target Finder's Chain Save
        both: [[3000000, 3400000], [4200000, 4550000]]
    };
    // User IDs in the ranges that are never picked
    const excludedIDs = [3133682, 3350281, 3134993, 3397129];
    // A picked target with more maximum health than this is flagged as big
    const BIG_HEALTH = 500;
    // An attack page is checked only if its target was picked this recently (ms)
    const PICK_WINDOW = 120000;

    // API calls are shared across tabs: every 5s during a chain, every 30s otherwise.
    // Torn allows 100 calls a minute per user in total
    const API_INTERVAL_CHAIN = 5000;
    const API_INTERVAL_IDLE = 30000;
    // An acknowledgement whose saved end time is further than this from the current one is
    // from before a hit (hits move it by minutes); the slack covers sources differing by 1-2 s
    const ACK_TOLERANCE = 10000;
    // Beep gain at 100% volume. 0.4 until 3.78 was far too loud at the top; 100% is now what
    // 25% was then, and the 20% default (0.02) a quarter of the old default
    const MAX_GAIN = 0.1;
    // Keep in step with @version above (GM_info isn't available in every userscript host)
    const SCRIPT_VERSION = '3.80';
    // Alarm sounds, repeated every cycle seconds (whole seconds: the alarm ticks every second).
    // A note: t start s, len length s, f pitch Hz, f2 pitch to glide to (optional), type waveform
    // (default sine), g loudness relative to the volume setting (default 1; buzzy waveforms
    // sound louder, so they get less), env 'pluck' (fades out from the start, the default) or
    // 'hold' (steady, with a short fade in and out)
    const ALARM_SOUNDS = {
        chime: { cycle: 1, notes: [
            { t: 0, len: 0.6, f: 1046.5 }, { t: 0.15, len: 0.6, f: 1318.5 }, { t: 0.3, len: 0.7, f: 1568 }] },
        hilo: { cycle: 1, notes: [
            { t: 0, len: 0.48, f: 950, type: 'triangle', env: 'hold', g: 0.8 },
            { t: 0.5, len: 0.48, f: 750, type: 'triangle', env: 'hold', g: 0.8 }] },
        yelp: { cycle: 1, notes: [0, 0.25, 0.5, 0.75].map(t =>
            ({ t, len: 0.23, f: 700, f2: 1400, type: 'triangle', env: 'hold', g: 0.8 })) },
        alarmclock: { cycle: 1, notes: [0, 0.12, 0.24, 0.36].map(t =>
            ({ t, len: 0.07, f: 2000, type: 'square', env: 'hold', g: 0.3 })) },
        phone: { cycle: 2, notes: [...ringBurst(0, 0.4), ...ringBurst(0.6, 0.4)] },
        klaxon: { cycle: 2, notes: [
            { t: 0, len: 0.55, f: 110, f2: 230, type: 'sawtooth', env: 'hold', g: 0.45 },
            { t: 0.62, len: 0.35, f: 230, f2: 200, type: 'sawtooth', env: 'hold', g: 0.45 }] },
        sos: { cycle: 4, notes: morseNotes('... --- ...', 0.1, 800) },
        warble: { cycle: 1, notes: Array.from({ length: 12 }, (_, i) =>
            ({ t: i * 0.07, len: 0.07, f: i % 2 ? 1100 : 800, env: 'hold' })) },
        off: { cycle: 1, notes: [] }
    };

    // Old UK phone ring: two tones together, switched on and off 20 times a second
    function ringBurst(start, length) {
        const notes = [];
        for (let t = 0; t < length - 0.01; t += 0.05) {
            for (const f of [400, 450]) notes.push({ t: start + t, len: 0.025, f, env: 'hold', g: 0.6 });
        }
        return notes;
    }

    // Morse: '.' is one unit, '-' three, a space a gap between letters
    function morseNotes(code, unit, f) {
        const notes = [];
        let t = 0;
        for (const c of code) {
            if (c === ' ') { t += unit * 2; continue; }
            const len = c === '.' ? unit : unit * 3;
            notes.push({ t, len, f, env: 'hold' });
            t += len + unit;
        }
        return notes;
    }

    if (window.top !== window.self) return;
    if (document.getElementById('pda-chain-timer-container')) return;

    let audioCtx = null;
    let alarmBus = null; // the alarm's sounds go through this, so stopping the alarm cuts them at once
    let alarmCycleEnd = 0; // audioCtx time when the playing sound's cycle ends
    let apiCallStarted = 0; // when the pending API call started, 0 if none
    let isDragging = false;
    let hasMoved = false;
    let pressedOnDisplay = false;
    let offsetX, offsetY;
    let startX, startY;

    // First run of 3.70 (no emergency time saved yet): move the old default alert time of
    // 120 s to the new default of 150 s. Any other saved value is kept
    if (!localStorage.getItem('pda_chain_timer_critical_threshold') &&
        localStorage.getItem('pda_chain_timer_alert_threshold') === '120') {
        localStorage.setItem('pda_chain_timer_alert_threshold', 150);
    }
    // 0 is a valid setting for both (Off: no alarm / ACK always works)
    const savedAlert = parseInt(localStorage.getItem('pda_chain_timer_alert_threshold'));
    const savedCritical = parseInt(localStorage.getItem('pda_chain_timer_critical_threshold'));
    let alertThreshold = isNaN(savedAlert) ? 150 : savedAlert;
    let criticalThreshold = isNaN(savedCritical) ? 120 : savedCritical;
    localStorage.setItem('pda_chain_timer_critical_threshold', criticalThreshold);
    let alarmSeconds = 0;
    const savedVolume = parseInt(localStorage.getItem('pda_chain_timer_volume'));
    let volume = isNaN(savedVolume) ? 20 : savedVolume; // percent; 0 is a valid (silent) setting
    let flashEnabled = localStorage.getItem('pda_chain_timer_flash') !== 'false';
    let beepPattern = localStorage.getItem('pda_chain_timer_beep');
    // Regular, Pulse and Rave (3.78) are gone; they and anything unknown become Chime
    if (!ALARM_SOUNDS[beepPattern]) beepPattern = 'chime';
    let wakeEnabled = localStorage.getItem('pda_chain_timer_wake') !== 'false';
    let idRange = localStorage.getItem('pda_chain_timer_id_range');
    if (!ID_RANGES[idRange]) idRange = 'low';
    let flagBig = localStorage.getItem('pda_chain_timer_flag_big') !== 'false';
    let wakeLock = null; // the screen wake lock while held
    let wakeLockPending = false;
    let wantWakeLock = false;
    let boxSize = parseInt(localStorage.getItem('pda_chain_timer_size')) || 100; // percent of the original size
    let apiKey = localStorage.getItem('pda_chain_timer_api_key') || '';
    let isPaused = localStorage.getItem('pda_chain_timer_is_paused') === 'true';

    // -------------------------------------------------------------------
    // Native CSS Anchor Setup
    // -------------------------------------------------------------------
    const container = document.createElement('div');
    container.id = 'pda-chain-timer-container';

    // First run: default position, or the one saved by the original script (top/left keys)
    if (!localStorage.getItem('pda_chain_timer_y_type')) {
        localStorage.setItem('pda_chain_timer_y_type', 'top');
        localStorage.setItem('pda_chain_timer_y_val', parseFloat(localStorage.getItem('pda_chain_timer_top')) || 60);
        localStorage.setItem('pda_chain_timer_x_type', 'left');
        localStorage.setItem('pda_chain_timer_x_val', parseFloat(localStorage.getItem('pda_chain_timer_left')) || 10);
    }

    function applyNativeBounds() {
        let xType = localStorage.getItem('pda_chain_timer_x_type');
        let xVal = localStorage.getItem('pda_chain_timer_x_val');
        let yType = localStorage.getItem('pda_chain_timer_y_type');
        let yVal = localStorage.getItem('pda_chain_timer_y_val');

        container.style.left = 'auto';
        container.style.right = 'auto';
        container.style.top = 'auto';
        container.style.bottom = 'auto';

        container.style[xType] = xVal + 'px';
        container.style[yType] = yVal + 'px';
    }

    // Capped at the largest size whose 140px-wide box still fits the screen with 20px to spare,
    // so a big Size on a phone stays on screen (e.g. about 250% at 375px wide)
    function applySize(percent) {
        const fitPercent = Math.floor((window.innerWidth - 20) / 1.4);
        container.style.setProperty('--s', Math.min(percent, fitPercent) / 100);
    }

    applyNativeBounds();
    applySize(boxSize);
    if (isPaused) container.classList.add('pda-minimized');

    const style = document.createElement('style');
    style.innerHTML = `
        /* --s is the Size setting (1 = 100%); the box's sizes are multiplied by it. The header
           (DASH/ACK/OPT/MIN) uses --hs instead: it shrinks with Size but never grows past 100% */
        #pda-chain-timer-container {
            --s: 1;
            --hs: min(1, var(--s));
            position: fixed;
            background-color: rgba(0, 0, 0, 0.9) !important;
            border: 2px solid #444 !important;
            border-radius: 6px;
            color: #fff !important;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            z-index: 999999;
            box-shadow: 0 4px 12px rgba(0,0,0,0.6) !important;
            display: flex;
            flex-direction: column;
            overflow: hidden;
            width: calc(140px * var(--s));
            height: calc(65px * var(--s));
            box-sizing: border-box;
            touch-action: none;
            user-select: none;
            -webkit-user-select: none;
            transition: width 0.3s, height 0.3s, border-radius 0.3s;
        }

        #pda-chain-timer-container.pda-minimized {
            width: calc(45px * var(--s)) !important;
            height: calc(45px * var(--s)) !important;
            border-radius: 50% !important;
            align-items: center;
            justify-content: center;
            cursor: pointer;
        }

        #pda-chain-timer-container.pda-minimized > * { display: none !important; }
        #pda-chain-timer-container.pda-minimized::after { content: '>'; font-size: calc(20px * var(--s)); font-weight: bold; line-height: 1; }

        #pda-timer-header { background: #222 !important; padding: calc(3px * var(--hs)) calc(4px * var(--hs)); font-size: calc(10px * var(--hs)); text-transform: uppercase; font-weight: bold; color: #aaa !important; border-bottom: 1px solid #333; flex-shrink: 0; display: flex; justify-content: space-between; align-items: center; gap: calc(3px * var(--hs)); }
        .pda-timer-controls { display: flex; align-items: center; gap: calc(3px * var(--hs)); }
        /* Narrower padding so DASH, ACK, OPT and MIN fit in the 140px box */
        #pda-timer-header .pda-btn { padding: calc(1px * var(--hs)) calc(4px * var(--hs)); }
        #pda-timer-dash-btn { text-decoration: none; flex-shrink: 0; }
        .pda-timer-left { display: flex; align-items: center; gap: calc(3px * var(--hs)); min-width: 0; }
        #pda-timer-version { font-size: calc(7px * var(--hs)); font-weight: normal; text-transform: none; color: #777 !important; white-space: nowrap; overflow: hidden; }
        .pda-btn { background: #444 !important; border: none !important; color: #fff !important; font-size: calc(10px * var(--hs)); font-weight: bold; padding: 1px 6px; border-radius: calc(3px * var(--hs)); display: flex; align-items: center; justify-content: center; cursor: pointer; font-family: Arial, sans-serif; min-width: calc(22px * var(--hs)); }
        #pda-timer-ack-btn { background: #b32424 !important; }
        #pda-timer-ack-btn:disabled { opacity: 0.4; cursor: default; }
        #pda-timer-display { position: relative; flex: 1; display: flex; background-color: #111; color: #fff !important; }
        .pda-timer-half { position: relative; flex: 1; display: flex; align-items: center; justify-content: center; font-weight: bold; font-family: 'Courier New', Courier, monospace; font-size: calc(17px * var(--s)); line-height: 1; }
        #pda-timer-half-api { border-left: 1px solid #333; }
        .pda-timer-source { position: absolute; left: 0; right: 0; bottom: calc(1px * var(--s)); text-align: center; font-size: calc(7px * var(--s)); font-weight: normal; line-height: 1; color: #777 !important; font-family: Arial, sans-serif; pointer-events: none; white-space: nowrap; }
        #pda-target-flag { display: none; position: absolute; right: calc(3px * var(--s)); top: calc(2px * var(--s)); font-size: calc(7px * var(--s)); font-weight: bold; line-height: 1; padding: calc(1px * var(--s)) calc(2px * var(--s)); border-radius: 2px; color: #999 !important; font-family: Arial, sans-serif; pointer-events: none; }
        #pda-target-flag.pda-flag-shown { display: block; }
        #pda-target-flag.pda-flag-big { background: #8a2be2 !important; color: #fff !important; }
        #pda-timer-count { position: absolute; left: calc(3px * var(--s)); top: calc(2px * var(--s)); font-size: calc(7px * var(--s)); font-weight: normal; line-height: 1; color: #777 !important; font-family: Arial, sans-serif; pointer-events: none; }
        #pda-settings-panel { position: absolute; top: 0; left: 0; right: 0; bottom: 0; background: rgba(17, 17, 17, 0.95) !important; display: none; flex-direction: column; padding: 4px 8px; z-index: 10; }
        .pda-setting-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; font-size: 9px; color: #ccc; }
        .pda-setting-row input { background: #333; border: 1px solid #555; color: #fff; font-size: 9px; padding: 1px 3px; width: 70px; }
        .pda-setting-row input[type="checkbox"] { width: auto; margin: 0; }
        .pda-setting-row select { background: #333; border: 1px solid #555; color: #fff; font-size: 9px; padding: 0 2px; }
        /* Slider / API blocks: a label row, then the input on its own full-width line */
        .pda-setting-block { margin-bottom: 4px; }
        .pda-setting-block .pda-setting-row { margin-bottom: 1px; }
        .pda-setting-block > input { display: block; box-sizing: border-box; width: 100%; margin: 0; background: #333; border: 1px solid #555; color: #fff; font-size: 9px; padding: 1px 3px; }
        .pda-slider-value { color: #fff; }
        #pda-api-status { font-size: 9px; margin-top: 2px; color: #999; }
        #pda-api-status:empty { display: none; }
        #pda-api-status.pda-api-ok { color: #6c6; }
        #pda-api-status.pda-api-bad { color: #f66; }
        /* Slim sliders: thin track, small round thumb (webkit = Chrome/Safari/PDA, moz = Firefox) */
        .pda-setting-block > input[type="range"] { -webkit-appearance: none; appearance: none; height: 14px; padding: 0; border: none; background: transparent; cursor: pointer; }
        .pda-setting-block > input[type="range"]::-webkit-slider-runnable-track { height: 3px; background: #555; border-radius: 2px; }
        .pda-setting-block > input[type="range"]::-webkit-slider-thumb { -webkit-appearance: none; width: 12px; height: 12px; margin-top: -4.5px; border-radius: 50%; background: #ddd; border: none; }
        .pda-setting-block > input[type="range"]::-moz-range-track { height: 3px; background: #555; border-radius: 2px; }
        .pda-setting-block > input[type="range"]::-moz-range-thumb { width: 12px; height: 12px; border-radius: 50%; background: #ddd; border: none; }
        .pda-setting-buttons { display: flex; gap: 4px; margin-top: 2px; }
        #pda-settings-close { background: #2a662a !important; flex: 1; }
        /* Help scrolls on its own; pan-y overrides the box's touch-action: none so it scrolls on touch */
        #pda-help { display: none; margin-top: 4px; max-height: 160px; overflow-y: auto; touch-action: pan-y; font-size: 8px; line-height: 1.3; color: #999; }
        #pda-help p { margin: 0 0 4px; }
        #pda-help b { color: #ddd; }
        /* While OPT is open the box grows to fit the panel, which replaces the timers. The panel
           has its own fixed sizes (not scaled by Size) and is 220px wide, but never wider than the
           screen. Sizes are set directly rather than with zoom/transform, which would also move
           the box or let it spill off the screen */
        #pda-chain-timer-container.pda-settings-open { height: auto; width: min(220px, calc(100vw - 20px)); }
        .pda-settings-open #pda-timer-display { display: none; }
        .pda-settings-open #pda-settings-panel { position: static; padding: 5px 8px; }
        .pda-settings-open .pda-setting-row { margin-bottom: 4px; font-size: 11px; }
        .pda-settings-open .pda-setting-block .pda-setting-row { margin-bottom: 0; }
        .pda-settings-open .pda-setting-row input[type="checkbox"] { width: 13px; height: 13px; }
        .pda-settings-open .pda-setting-row select { font-size: 11px; }
        .pda-settings-open .pda-setting-block > input[type="text"] { font-size: 11px; padding: 2px 4px; }
        .pda-settings-open #pda-settings-panel .pda-btn { font-size: 11px; padding: 2px 8px; min-width: 24px; }
        .pda-settings-open #pda-settings-panel .pda-default-btn { font-size: 9px; padding: 1px 5px; }
        .pda-settings-open #pda-help { font-size: 10px; max-height: 180px; }
        .pda-settings-open #pda-api-status { font-size: 10px; }

        /* Big target: purple border. Before the alarm rules so their colours win */
        #pda-chain-timer-container.pda-target-big { border-color: #8a2be2 !important; }
        /* Torn's fight button while blocked */
        button[data-a1ry-blocked] { opacity: 0.35 !important; filter: grayscale(1) !important; cursor: not-allowed !important; }
        /* Big target warnings that don't depend on finding the button: the defender's panel
           outlined, and a banner at the top that taps pass through */
        [data-a1ry-big] { outline: 4px solid #8a2be2 !important; outline-offset: -4px; }
        #pda-big-banner { display: none; position: fixed; top: 0; left: 50%; transform: translateX(-50%); z-index: 999997; max-width: calc(100vw - 20px); box-sizing: border-box; padding: 6px 14px; border-radius: 0 0 6px 6px; background: #8a2be2; color: #fff; font: bold 14px/1.3 Arial, sans-serif; text-align: center; pointer-events: none; box-shadow: 0 2px 8px rgba(0,0,0,0.5); }
        #pda-big-banner.pda-flag-shown { display: block; }

        /* Alarm colours: orange from the warning time, red from the panic time. Border rules
           carry the ID so they outrank the base border, which is also !important */
        #pda-chain-timer-container.timer-warning-active { border-color: #ff8c00 !important; }
        .timer-warning-active #pda-timer-display { animation: pda-timer-flash 0.8s infinite alternate; }
        #pda-chain-timer-container.timer-panic { border-color: #ff2a2a !important; }
        .timer-panic #pda-timer-display { animation-name: pda-timer-panic; }
        #pda-chain-timer-container.timer-acknowledged { border-color: #b36b00 !important; }
        @keyframes pda-timer-flash { from { background-color: #111; } to { background-color: #b35f00; } }
        @keyframes pda-timer-panic { from { background-color: #111; } to { background-color: #b30000; } }

        /* Screen-edge flash: the glow is drawn once and only its opacity is animated, so the
           browser doesn't repaint the page. Fast = 2.5 flashes/s, under the 3/s seizure guideline */
        #pda-chain-flash { position: fixed; top: 0; left: 0; right: 0; bottom: 0; pointer-events: none; z-index: 999998; box-shadow: inset 0 0 40px 12px rgba(255, 140, 0, 0.9); opacity: 0; display: none; }
        #pda-chain-flash.pda-flash-on { display: block; animation: pda-edge-flash 0.5s infinite alternate; }
        #pda-chain-flash.pda-flash-fast { animation-duration: 0.2s; box-shadow: inset 0 0 40px 12px rgba(255, 0, 0, 0.9); }
        @keyframes pda-edge-flash { from { opacity: 0; } to { opacity: 1; } }
    `;
    document.head.appendChild(style);

    container.innerHTML = `
        <div id="pda-timer-header">
            <div class="pda-timer-left">
                <a class="pda-btn" id="pda-timer-dash-btn" href="https://naughtybot.unifiedbot.net/" target="_blank" rel="noopener" title="Open the dashboard in a new tab">DASH</a>
                <span id="pda-timer-version">v${SCRIPT_VERSION}</span>
            </div>
            <div class="pda-timer-controls">
                <button class="pda-btn" id="pda-timer-ack-btn" title="Silence the alarm until the panic time" style="display: none;">ACK</button>
                <button class="pda-btn" id="pda-timer-cfg-btn" title="Settings">OPT</button>
                <button class="pda-btn" id="pda-timer-pause-btn" title="Minimise (turns the alarm off)">MIN</button>
            </div>
        </div>
        <div id="pda-timer-display">
            <div class="pda-timer-half" id="pda-timer-half-local">
                <span id="pda-timer-text-local">--:--</span>
                <span class="pda-timer-source" id="pda-timer-source-local"></span>
                <span id="pda-timer-count"></span>
                <span id="pda-target-flag"></span>
            </div>
            <div class="pda-timer-half" id="pda-timer-half-api">
                <span id="pda-timer-text-api">--:--</span>
                <span class="pda-timer-source" id="pda-timer-source-api"></span>
            </div>
        </div>

        <div id="pda-settings-panel">
            <div class="pda-setting-block">
                <div class="pda-setting-row">
                    <span title="Alarm starts here; ACK can silence it">Warn: <b class="pda-slider-value"></b></span>
                    <button class="pda-btn pda-default-btn" data-default="150" title="Default: 2:30">Default</button>
                </div>
                <input type="range" id="pda-threshold-input" min="0" max="300" step="5">
            </div>
            <div class="pda-setting-block">
                <div class="pda-setting-row">
                    <span title="Alarm comes back here and can't be silenced">Panic: <b class="pda-slider-value"></b></span>
                    <button class="pda-btn pda-default-btn" data-default="120" title="Default: 2:00">Default</button>
                </div>
                <input type="range" id="pda-critical-input" min="0" max="300" step="5">
            </div>
            <div class="pda-setting-block">
                <div class="pda-setting-row">
                    <span title="Alarm beep volume; plays a test beep when changed">Vol: <b class="pda-slider-value"></b></span>
                    <button class="pda-btn pda-default-btn" data-default="20" title="Default: 20%">Default</button>
                </div>
                <input type="range" id="pda-volume-input" min="0" max="100" step="5">
            </div>
            <div class="pda-setting-block">
                <div class="pda-setting-row">
                    <span title="Size of the timer box (OPT stays the same size)">Size: <b class="pda-slider-value"></b></span>
                    <button class="pda-btn pda-default-btn" data-default="100" title="Default: 100%">Default</button>
                </div>
                <input type="range" id="pda-size-input" min="75" max="400" step="5">
            </div>
            <div class="pda-setting-row">
                <span title="Alarm sound; plays a test when changed">Sound:</span>
                <select id="pda-beep-input">
                    <option value="chime">Chime</option>
                    <option value="hilo">Hi-lo</option>
                    <option value="yelp">Yelp</option>
                    <option value="alarmclock">Alarm clock</option>
                    <option value="phone">Phone ring</option>
                    <option value="klaxon">Klaxon</option>
                    <option value="sos">SOS</option>
                    <option value="warble">Warble</option>
                    <option value="off">Off</option>
                </select>
            </div>
            <div class="pda-setting-row">
                <span title="Flash the screen edges while the alarm sounds">Screen flash:</span>
                <input type="checkbox" id="pda-flash-input">
            </div>
            <div class="pda-setting-row">
                <span title="Stop the screen from sleeping while a chain is running">Keep screen on:</span>
                <input type="checkbox" id="pda-wake-input">
            </div>
            <div class="pda-setting-row">
                <span title="ID range for the random target opened by tapping the timers">Targets:</span>
                <select id="pda-range-input">
                    <option value="low">3.0M-3.4M</option>
                    <option value="high">4.2M-4.55M</option>
                    <option value="both">Both</option>
                </select>
            </div>
            <div class="pda-setting-row">
                <span title="On the attack page of a random target, show its health; above ${BIG_HEALTH} the fight button is blocked">Block big targets:</span>
                <input type="checkbox" id="pda-flag-input">
            </div>
            <div class="pda-setting-block">
                <div class="pda-setting-row">
                    <span>Public API key:</span>
                    <button class="pda-btn pda-default-btn" id="pda-api-check" title="Try the key in the box with the timer's API call">Check</button>
                </div>
                <input type="text" id="pda-api-input" placeholder="key" autocomplete="off" spellcheck="false">
                <div id="pda-api-status"></div>
            </div>
            <div class="pda-setting-buttons">
                <button class="pda-btn" id="pda-settings-close">Save</button>
                <button class="pda-btn" id="pda-help-btn" title="Help">?</button>
            </div>
            <div id="pda-help">
                <p><b>Left timer</b>: read from the page, no API. <b>Right timer</b>: Torn API.
                If they disagree, one has a problem. The code under each says where the time came from.</p>
                <p><b>BAR</b> sidebar chain bar<br>
                <b>COOL</b> chain bar in cooldown (no chain)<br>
                <b>ATK</b> attack page header<br>
                <b>SES</b> Torn's saved sidebar data<br>
                <b>DOM</b> other chain text on the page<br>
                <b>MEM-x</b> time saved earlier by a tab (x = where from)<br>
                <b>NONE</b> no local time found</p>
                <p><b>API 4s</b> API data, 4 s old<br>
                <b>API-ERR2</b> wrong key (5 = too many calls)<br>
                <b>API-NET</b> no connection to the API<br>
                <b>NO KEY</b> no API key set</p>
                <p><b>Alarm</b>: sounds and flashes orange from the Warning time, red from the Panic time. <b>ACK</b> silences it until the
                Panic time; after that it can't be silenced. A hit cancels ACK.
                <b>Sound</b> picks the alarm sound (Off = flash only). Phone ring and Klaxon repeat every 2 s, SOS every 4 s.</p>
                <p><b>Keep screen on</b> stops the screen sleeping while a chain runs (if the browser allows it).</p>
                <p><b>MIN</b> minimises the box and turns the alarm off. Tap the circle to bring it back.
                No alarm while this tab is in the background.</p>
                <p>Tap the timers to open the attack page of a random inactive target, from the <b>Targets</b> ID range.
                With <b>Block big targets</b> on, its health shows top right; above ${BIG_HEALTH} it turns purple and
                Start fight is blocked: tap again for another (or turn the option off to attack anyway).
                Attack pages you open yourself aren't checked. Drag the box to move it.
                <b>DASH</b> opens the dashboard in a new tab.</p>
                <p>After a page load, sound plays only once you've tapped the page.</p>
            </div>
        </div>
    `;
    document.body.appendChild(container);

    const flashOverlay = document.createElement('div');
    flashOverlay.id = 'pda-chain-flash';
    document.body.appendChild(flashOverlay);

    const bigBanner = document.createElement('div');
    bigBanner.id = 'pda-big-banner';
    document.body.appendChild(bigBanner);

    const display = container.querySelector('#pda-timer-display');
    const localText = container.querySelector('#pda-timer-text-local');
    const localLabel = container.querySelector('#pda-timer-source-local');
    const apiText = container.querySelector('#pda-timer-text-api');
    const apiLabel = container.querySelector('#pda-timer-source-api');
    const countLabel = container.querySelector('#pda-timer-count');
    const pauseBtn = container.querySelector('#pda-timer-pause-btn');
    const ackBtn = container.querySelector('#pda-timer-ack-btn');
    const cfgBtn = container.querySelector('#pda-timer-cfg-btn');
    const settingsPanel = container.querySelector('#pda-settings-panel');
    const closeSettingsBtn = container.querySelector('#pda-settings-close');
    const helpBtn = container.querySelector('#pda-help-btn');
    const helpPanel = container.querySelector('#pda-help');
    const thresholdInput = container.querySelector('#pda-threshold-input');
    const criticalInput = container.querySelector('#pda-critical-input');
    const volumeInput = container.querySelector('#pda-volume-input');
    const flashInput = container.querySelector('#pda-flash-input');
    const beepInput = container.querySelector('#pda-beep-input');
    const wakeInput = container.querySelector('#pda-wake-input');
    const rangeInput = container.querySelector('#pda-range-input');
    const flagInput = container.querySelector('#pda-flag-input');
    const targetFlag = container.querySelector('#pda-target-flag');
    const sizeInput = container.querySelector('#pda-size-input');
    const apiInput = container.querySelector('#pda-api-input');
    const apiCheckBtn = container.querySelector('#pda-api-check');
    const apiStatus = container.querySelector('#pda-api-status');

    // OPT inputs show the saved settings (on load, and when OPT is left without Save)
    function fillSettingInputs() {
        thresholdInput.value = alertThreshold;
        criticalInput.value = criticalThreshold;
        volumeInput.value = volume;
        flashInput.checked = flashEnabled;
        beepInput.value = beepPattern;
        wakeInput.checked = wakeEnabled;
        rangeInput.value = idRange;
        flagInput.checked = flagBig;
        sizeInput.value = boxSize;
        apiInput.value = apiKey;
        for (const input of [thresholdInput, criticalInput, volumeInput, sizeInput]) {
            input.closest('.pda-setting-block').querySelector('.pda-slider-value').textContent = formatSliderValue(input);
        }
        applySize(boxSize);
    }

    fillSettingInputs();

    // Writes text only when it changed: each write is a page change that Torn and other
    // scripts watching the page react to, and most labels stay the same from tick to tick
    function setText(el, text) {
        if (el.textContent !== text) el.textContent = text;
    }

    function formatSecondsToTimeString(totalSeconds) {
        if (totalSeconds <= 0) return "--:--";
        const m = Math.floor(totalSeconds / 60);
        const s = totalSeconds % 60;
        return `${m < 10 ? '0' : ''}${m}:${s < 10 ? '0' : ''}${s}`;
    }

    // Seconds left until a saved expire time (ms), 0 if missing or passed
    function secondsUntil(key) {
        const expireTime = parseInt(localStorage.getItem(key)) || 0;
        return Math.max(0, Math.floor((expireTime - Date.now()) / 1000));
    }

    // -------------------------------------------------------------------
    // Local timer storage (separate from the API's, so neither feeds the other)
    // -------------------------------------------------------------------
    // Only writes when the end time moves by more than 2s (a whole-second time read
    // each tick wobbles by up to 1s) or the source changes, not on every tick
    function saveLocalExpire(seconds, src) {
        const expire = Date.now() + (seconds * 1000);
        const saved = parseInt(localStorage.getItem('pda_chain_timer_local_expire')) || 0;
        if (Math.abs(expire - saved) > 2000 || localStorage.getItem('pda_chain_timer_local_src') !== src) {
            localStorage.setItem('pda_chain_timer_local_expire', expire);
            localStorage.setItem('pda_chain_timer_local_src', src);
        }
    }

    function localMemorySource() {
        return 'MEM-' + (localStorage.getItem('pda_chain_timer_local_src') || '?');
    }

    // -------------------------------------------------------------------
    // 2. Drag Engine with Native Corner Resolution
    // -------------------------------------------------------------------
    // Pointer events cover mouse (desktop) and touch (PDA) alike
    container.addEventListener('pointerdown', (e) => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON' || e.target.tagName === 'A' || settingsPanel.style.display === 'flex') return;
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        isDragging = true;
        hasMoved = false;
        pressedOnDisplay = display.contains(e.target);
        const rect = container.getBoundingClientRect();

        startX = e.clientX;
        startY = e.clientY;
        offsetX = e.clientX - rect.left;
        offsetY = e.clientY - rect.top;

        container.style.right = 'auto';
        container.style.bottom = 'auto';
        container.style.left = rect.left + 'px';
        container.style.top = rect.top + 'px';
    });

    document.addEventListener('pointermove', (e) => {
        if (!isDragging) return;
        // Ignore small jitter so a tap/click still counts as a tap
        if (!hasMoved && Math.abs(e.clientX - startX) < 4 && Math.abs(e.clientY - startY) < 4) return;
        hasMoved = true;

        let newX = e.clientX - offsetX;
        let newY = e.clientY - offsetY;

        newX = Math.max(0, Math.min(newX, window.innerWidth - container.offsetWidth));
        newY = Math.max(0, Math.min(newY, window.innerHeight - container.offsetHeight));

        container.style.left = newX + 'px';
        container.style.top = newY + 'px';
        if (e.cancelable) e.preventDefault();
    }, { passive: false });

    function endDrag() {
        if (isDragging) {
            isDragging = false;
            const rect = container.getBoundingClientRect();
            const winW = window.innerWidth;
            const winH = window.innerHeight;

            let xType = 'left';
            let xVal = rect.left;
            if (rect.left + (rect.width / 2) > winW / 2) {
                xType = 'right';
                xVal = winW - rect.right;
            }

            let yType = 'top';
            let yVal = rect.top;
            if (rect.top + (rect.height / 2) > winH / 2) {
                yType = 'bottom';
                yVal = winH - rect.bottom;
            }

            localStorage.setItem('pda_chain_timer_x_type', xType);
            localStorage.setItem('pda_chain_timer_x_val', Math.max(0, xVal));
            localStorage.setItem('pda_chain_timer_y_type', yType);
            localStorage.setItem('pda_chain_timer_y_val', Math.max(0, yVal));

            applyNativeBounds();

            if (!hasMoved) {
                if (isPaused) togglePauseMinimize();
                else if (pressedOnDisplay) openRandomTarget();
            }
        }
    }

    // The defender's maximum health on the attack page, null if not shown. The page has a
    // player___ block for each side; the defender's holds the defender_ weapon slots (the
    // second block, if that ever changes). Its screen-reader summary reads "Health 640 of 6393",
    // the visible entry "640 / 6,393"
    function findDefender() {
        const players = Array.from(document.querySelectorAll('[class*="player___"]'));
        return players.find(p => p.querySelector('[id^="defender_"], [class*="defender___"]')) ||
            (players.length === 2 ? players[1] : null);
    }

    function readDefenderMaxHealth() {
        const defender = findDefender();
        if (!defender) return null;
        const match = defender.textContent.replace(/,/g, '').match(/Health\s*(\d+)\s*(?:of|\/)\s*(\d+)/);
        return match ? parseInt(match[2], 10) : null;
    }

    // A random ID from the chosen range(s), each ID equally likely, never an excluded one
    function randomTargetID() {
        const ranges = ID_RANGES[idRange];
        const total = ranges.reduce((sum, [min, max]) => sum + max - min + 1, 0);
        let randID;
        do {
            let n = Math.floor(Math.random() * total);
            for (const [min, max] of ranges) {
                if (n <= max - min) { randID = min + n; break; }
                n -= max - min + 1;
            }
        } while (excludedIDs.includes(randID));
        return randID;
    }

    // Tap on the timer digits: jump to the attack page of a random player. The pick is saved
    // (shared across tabs) so the attack page can tell it apart from one opened another way
    function openRandomTarget() {
        const randID = randomTargetID();
        localStorage.setItem('pda_chain_timer_pick', JSON.stringify({ id: randID, time: Date.now() }));
        window.location.href = `https://www.torn.com/page.php?sid=attack&user2ID=${randID}`;
    }

    // The target ID if this page loaded as the attack page of a target the script picked in
    // the last PICK_WINDOW, else null. Decided once at load, so the flag stays while you fight
    function scriptPickOnLoad() {
        const params = new URLSearchParams(location.search);
        if (params.get('sid') !== 'attack') return null;
        try {
            const pick = JSON.parse(localStorage.getItem('pda_chain_timer_pick'));
            if (pick && String(pick.id) === params.get('user2ID') && Date.now() - pick.time < PICK_WINDOW) return String(pick.id);
        } catch (e) {}
        return null;
    }
    const pickedTargetID = scriptPickOnLoad();

    // The picked target's maximum health while on its attack page with the option on, else
    // null (any other page, including one Torn reaches without a reload)
    function pickedTargetHealth() {
        if (pickedTargetID === null || !flagBig) return null;
        const params = new URLSearchParams(location.search);
        const onPick = params.get('sid') === 'attack' && params.get('user2ID') === pickedTargetID;
        return onPick ? readDefenderMaxHealth() : null;
    }

    // Torn's fight button, found by its text since its class names change between builds
    function isFightButton(el) {
        return el.tagName === 'BUTTON' && /^\s*(start|join)\s+fight\s*$/i.test(el.textContent);
    }

    // Whether Torn's page currently carries our marks (defender outline, blocked button)
    let pageMarked = false;

    // Shows the picked target's maximum health, and above BIG_HEALTH flags it purple, outlines
    // the defender and greys out the fight button. Checked every tick, as Torn redraws the page
    // (a redrawn button or panel is a new element without the mark); marks are only written
    // where missing
    function updateTargetFlag() {
        const health = pickedTargetHealth();
        const big = health !== null && health > BIG_HEALTH;
        setText(targetFlag, health !== null ? `HP ${health.toLocaleString()}` : '');
        targetFlag.classList.toggle('pda-flag-shown', health !== null);
        targetFlag.classList.toggle('pda-flag-big', big);
        container.classList.toggle('pda-target-big', big);
        setText(bigBanner, big ? `BIG TARGET: HP ${health.toLocaleString()}, don't attack` : '');
        bigBanner.classList.toggle('pda-flag-shown', big);
        if (!big && !pageMarked) return;
        pageMarked = big;
        const defender = big ? findDefender() : null;
        for (const el of document.querySelectorAll('[data-a1ry-big]')) {
            if (el !== defender) el.removeAttribute('data-a1ry-big');
        }
        if (defender && !defender.hasAttribute('data-a1ry-big')) defender.setAttribute('data-a1ry-big', '');
        for (const button of document.querySelectorAll('button')) {
            const blocked = button.hasAttribute('data-a1ry-blocked');
            if (big && isFightButton(button)) {
                if (blocked) continue;
                button.setAttribute('data-a1ry-blocked', '');
                button.title = `Blocked by a1ry Chain Watch: max health ${health.toLocaleString()} is over ${BIG_HEALTH}`;
            } else if (blocked) {
                button.removeAttribute('data-a1ry-blocked');
                button.removeAttribute('title');
            }
        }
    }

    // Swallows clicks on the fight button of a big picked target before Torn's page sees them
    // (capture phase on window runs first). Checked on each click rather than taken from the
    // last tick, so a click straight after the page loads is caught too. Enter/Space on the
    // button arrive as clicks; submit covers the button being in a form
    function blockBigFight(e) {
        const button = e.type === 'submit' ? e.submitter : e.target.closest && e.target.closest('button');
        if (!button || !isFightButton(button)) return;
        const health = pickedTargetHealth();
        if (health === null || health <= BIG_HEALTH) return;
        e.preventDefault();
        e.stopImmediatePropagation();
    }
    window.addEventListener('click', blockBigFight, true);
    window.addEventListener('submit', blockBigFight, true);

    document.addEventListener('pointerup', endDrag);
    document.addEventListener('pointercancel', endDrag);

    // -------------------------------------------------------------------
    // 3. UI Interaction Listeners
    // -------------------------------------------------------------------
    cfgBtn.addEventListener('click', () => {
        settingsPanel.style.display = 'flex';
        container.classList.add('pda-settings-open');
    });

    closeSettingsBtn.addEventListener('click', () => {
        alertThreshold = parseInt(thresholdInput.value, 10);
        localStorage.setItem('pda_chain_timer_alert_threshold', alertThreshold);
        criticalThreshold = parseInt(criticalInput.value, 10);
        localStorage.setItem('pda_chain_timer_critical_threshold', criticalThreshold);
        volume = parseInt(volumeInput.value, 10);
        localStorage.setItem('pda_chain_timer_volume', volume);
        flashEnabled = flashInput.checked;
        localStorage.setItem('pda_chain_timer_flash', flashEnabled);
        beepPattern = beepInput.value;
        localStorage.setItem('pda_chain_timer_beep', beepPattern);
        wakeEnabled = wakeInput.checked;
        localStorage.setItem('pda_chain_timer_wake', wakeEnabled);
        idRange = rangeInput.value;
        localStorage.setItem('pda_chain_timer_id_range', idRange);
        flagBig = flagInput.checked;
        localStorage.setItem('pda_chain_timer_flag_big', flagBig);
        boxSize = parseInt(sizeInput.value, 10);
        localStorage.setItem('pda_chain_timer_size', boxSize);
        apiKey = apiInput.value.trim();
        localStorage.setItem('pda_chain_timer_api_key', apiKey);
        closeSettings();
    });

    function closeSettings() {
        settingsPanel.style.display = 'none';
        helpPanel.style.display = 'none';
        showApiStatus('', '');
        container.classList.remove('pda-settings-open');
    }

    // state: 'ok' (green), 'bad' (red) or '' (grey)
    function showApiStatus(text, state) {
        apiStatus.textContent = text;
        apiStatus.className = state ? 'pda-api-' + state : '';
    }

    // Check: the timer's own API call with the key in the box (saved or not), so a pass
    // means the right-hand timer will work with it. Torn's error text is shown as is
    apiCheckBtn.addEventListener('click', () => {
        const key = apiInput.value.trim();
        if (!key) { showApiStatus('Enter a key first', 'bad'); return; }
        showApiStatus('Checking...', '');
        fetch(`https://api.torn.com/faction/?selections=chain&key=${encodeURIComponent(key)}`)
            .then(response => response.json())
            .then(data => {
                if (data && data.chain && typeof data.chain.timeout === 'number') {
                    showApiStatus(`Key works: chain ${data.chain.current}/${data.chain.max}` + (key === apiKey ? '' : '. Press Save to use it'), 'ok');
                } else if (data && data.error) {
                    showApiStatus(`Error ${data.error.code}: ${data.error.error}`, 'bad');
                } else {
                    showApiStatus('Unexpected reply from the API', 'bad');
                }
            })
            .catch(() => showApiStatus('No connection to the API', 'bad'));
    });

    helpBtn.addEventListener('click', () => {
        helpPanel.style.display = helpPanel.style.display === 'block' ? 'none' : 'block';
    });

    // Minimising closes OPT without saving: while OPT is open the box ignores presses,
    // so the circle could never be tapped open again
    function setMinimized(minimized) {
        isPaused = minimized;
        container.classList.toggle('pda-minimized', minimized);
        if (!minimized) return;
        if (settingsPanel.style.display === 'flex') {
            closeSettings();
            fillSettingInputs();
        }
        updateAlarm(0);
    }

    function togglePauseMinimize() {
        setMinimized(!isPaused);
        localStorage.setItem('pda_chain_timer_is_paused', isPaused);
    }

    pauseBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        togglePauseMinimize();
    });

    ackBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (alarmSeconds <= criticalThreshold) return;
        localStorage.setItem('pda_chain_timer_ack_end', Date.now() + (alarmSeconds * 1000));
        updateAlarm(alarmSeconds);
    });

    // Slider value shown next to each label: times as M:SS (0 = Off), the rest in percent
    function formatSliderValue(input) {
        const v = parseInt(input.value, 10);
        if (input === thresholdInput || input === criticalInput) {
            return v ? `${Math.floor(v / 60)}:${String(v % 60).padStart(2, '0')}` : 'Off';
        }
        return v + '%';
    }

    for (const input of [thresholdInput, criticalInput, volumeInput, sizeInput]) {
        const block = input.closest('.pda-setting-block');
        const valueLabel = block.querySelector('.pda-slider-value');
        input.addEventListener('input', () => { valueLabel.textContent = formatSliderValue(input); });
        // Default: set the slider as if it were dragged there (so Size and the test beep follow)
        block.querySelector('.pda-default-btn').addEventListener('click', (e) => {
            input.value = e.currentTarget.dataset.default;
            input.dispatchEvent(new Event('input'));
            input.dispatchEvent(new Event('change'));
        });
    }

    // Size applies while dragging (the header shows it); Save keeps it
    sizeInput.addEventListener('input', () => applySize(parseInt(sizeInput.value, 10)));
    // Re-check the screen cap on resize / rotation (the slider holds the saved or previewed size)
    window.addEventListener('resize', () => applySize(parseInt(sizeInput.value, 10)));

    // Test sound at the chosen volume when the slider is released or the sound picked
    // (the tap also unlocks audio)
    const playTestSound = () => playSound(beepInput.value, parseInt(volumeInput.value, 10), null);
    volumeInput.addEventListener('change', playTestSound);
    beepInput.addEventListener('change', playTestSound);

    // Unlock audio on a tap anywhere on the page, so the alarm can sound after a page load
    document.addEventListener('pointerdown', initAudioContext, true);

    function initAudioContext() {
        try {
            if (!audioCtx) {
                const AudioContext = window.AudioContext || window.webkitAudioContext;
                if (AudioContext) audioCtx = new AudioContext();
            }
            if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
        } catch(e) { console.error("Audio block:", e); }
    }

    // Plays one cycle of an ALARM_SOUNDS sound. percent: volume, 0-100; bus: node to play
    // into (null: straight to the speakers, for the OPT test). Returns false if audio is locked
    function playSound(name, percent, bus) {
        try {
            initAudioContext();
            if (!audioCtx || audioCtx.state === 'suspended') return false;
            if (percent <= 0) return true;
            const peak = MAX_GAIN * percent / 100;
            const start = audioCtx.currentTime + 0.02;
            for (const n of (ALARM_SOUNDS[name] || ALARM_SOUNDS.chime).notes) {
                const t = start + n.t;
                const g = peak * (n.g || 1);
                const osc = audioCtx.createOscillator();
                const gainNode = audioCtx.createGain();
                osc.type = n.type || 'sine';
                osc.frequency.setValueAtTime(n.f, t);
                if (n.f2) osc.frequency.exponentialRampToValueAtTime(n.f2, t + n.len);
                if (n.env === 'hold') {
                    const fade = Math.min(0.01, n.len / 4);
                    gainNode.gain.setValueAtTime(0, t);
                    gainNode.gain.linearRampToValueAtTime(g, t + fade);
                    gainNode.gain.setValueAtTime(g, t + n.len - fade);
                    gainNode.gain.linearRampToValueAtTime(0, t + n.len);
                } else {
                    gainNode.gain.setValueAtTime(g, t);
                    gainNode.gain.exponentialRampToValueAtTime(0.00001, t + n.len);
                }
                osc.connect(gainNode);
                gainNode.connect(bus || audioCtx.destination);
                osc.start(t);
                osc.stop(t + n.len + 0.02);
            }
            return true;
        } catch (e) { return false; }
    }

    // Called every tick while the alarm sounds: starts the sound again once its cycle is
    // over (the 0.1 s slack covers ticks arriving a little early)
    function playAlarmSound() {
        initAudioContext();
        if (!audioCtx || audioCtx.currentTime < alarmCycleEnd - 0.1) return;
        if (!alarmBus) {
            alarmBus = audioCtx.createGain();
            alarmBus.connect(audioCtx.destination);
        }
        if (playSound(beepPattern, volume, alarmBus)) {
            alarmCycleEnd = audioCtx.currentTime + (ALARM_SOUNDS[beepPattern] || ALARM_SOUNDS.chime).cycle;
        }
    }

    // Cuts the alarm sound at once, including notes already queued (e.g. the rest of an SOS)
    function stopAlarmSound() {
        if (!alarmBus) return;
        alarmBus.disconnect();
        alarmBus = null;
        alarmCycleEnd = 0;
    }

    // Holds the screen wake lock while want is true, releases it otherwise. The browser
    // releases it by itself when the tab is hidden; the next call with want asks again
    function updateWakeLock(want) {
        wantWakeLock = want;
        if (!navigator.wakeLock) return;
        if (want && !wakeLock && !wakeLockPending) {
            wakeLockPending = true;
            navigator.wakeLock.request('screen')
                .then(lock => {
                    wakeLock = lock;
                    lock.addEventListener('release', () => { if (wakeLock === lock) wakeLock = null; });
                    // No longer wanted while the request was pending
                    if (!wantWakeLock) { wakeLock = null; lock.release(); }
                })
                .catch(() => {})
                .finally(() => { wakeLockPending = false; });
        } else if (!want && wakeLock) {
            const lock = wakeLock;
            wakeLock = null;
            lock.release().catch(() => {});
        }
    }

    // -------------------------------------------------------------------
    // Alarm: sounds at or below the warning time (alertThreshold) unless acknowledged; can't be
    // acknowledged at or below the panic time (criticalThreshold). 0 = no alarm (no chain, minimised)
    // -------------------------------------------------------------------
    // The acknowledgement is saved as the chain end time it was given for, so it
    // carries across tabs and page loads, and a hit (new end time) cancels it
    function isAcknowledged(seconds) {
        const ackEnd = parseInt(localStorage.getItem('pda_chain_timer_ack_end')) || 0;
        return Math.abs(Date.now() + (seconds * 1000) - ackEnd) <= ACK_TOLERANCE;
    }

    function updateAlarm(seconds) {
        alarmSeconds = seconds;
        const inAlert = seconds > 0 && seconds <= alertThreshold;
        const critical = inAlert && seconds <= criticalThreshold;
        const sounding = critical || (inAlert && !isAcknowledged(seconds));

        container.classList.toggle('timer-warning-active', sounding);
        container.classList.toggle('timer-panic', critical);
        container.classList.toggle('timer-acknowledged', inAlert && !sounding);
        ackBtn.style.display = sounding ? '' : 'none';
        ackBtn.disabled = critical;
        flashOverlay.classList.toggle('pda-flash-on', sounding && flashEnabled);
        flashOverlay.classList.toggle('pda-flash-fast', critical);
        if (sounding) playAlarmSound();
        else stopAlarmSound();
    }

    function parseTimeStringToSeconds(timeStr) {
        if (!timeStr) return 0;
        const parts = timeStr.split(':');
        return (parseInt(parts[0], 10) * 60) + parseInt(parts[1], 10);
    }

    // Torn's own sidebar data: sessionStorage "sidebarData<userID>" holds a chain entry
    // with timestampToUpdate = chain end time (Unix seconds), 0 when there is no chain
    function readSessionChain() {
        try {
            for (let i = 0; i < sessionStorage.length; i++) {
                const key = sessionStorage.key(i);
                if (!key || key.indexOf('sidebarData') !== 0) continue;
                const data = JSON.parse(sessionStorage.getItem(key));
                if (!data) continue;
                if (data.bars && data.bars.chain) return data.bars.chain;
                for (const k in data) {
                    if (data[k] && data[k].chain) return data[k].chain;
                }
            }
        } catch (e) {}
        return null;
    }

    // -------------------------------------------------------------------
    // 4. Local timer (left): page and Torn's own data, never the API
    // -------------------------------------------------------------------
    function updateLocalTimer() {
        let seconds = -1;
        let src = '';

        // Priority 1: Sidebar chain bar. Torn renamed chain-bar___ to chainBar___ (and
        // bar-timeleft___ to barTimeLeft___), so accept both. The time element by name first; if
        // that is renamed again, any element inside the bar whose whole text is a time, with or
        // without brackets (00:00 when no chain)
        const chainBar = document.querySelector('a[class*="chainBar___"], a[class*="chain-bar___"]');
        // In cooldown the bar counts down the cooldown, not a chain: no chain, so stop here
        // rather than let the cooldown time (or SES/DOM) be read as a chain time
        const progress = chainBar && chainBar.querySelector('[class*="progress___"]');
        if (progress && Array.from(progress.classList).some(name => name.startsWith('cooldown___'))) {
            seconds = 0;
            src = 'COOL';
        } else if (chainBar) {
            const timeLeft = chainBar.querySelector('[class*="barTimeLeft___"], [class*="bar-timeleft___"]');
            // Standalone M:SS only, as in the DOM fallback below
            const match = timeLeft && timeLeft.textContent.match(/(?:^|[^\d:])(0?[0-5]:[0-5]\d)(?![\d:])/);
            if (match) {
                seconds = parseTimeStringToSeconds(match[1]);
                src = 'BAR';
            } else {
                for (const el of chainBar.querySelectorAll('*')) {
                    if (el.children.length) continue;
                    const leafMatch = el.textContent.trim().match(/^\(?(0?[0-5]:[0-5]\d)\)?$/);
                    if (leafMatch) { seconds = parseTimeStringToSeconds(leafMatch[1]); src = 'BAR'; break; }
                }
            }
        }

        // Priority 2: Attack page header. Checked before SES because the attack page has no
        // sidebar, so Torn stops refreshing sidebarData there and SES goes stale. Only on the
        // attack page, and only as "<hits> (M:SS)": labelTitle___ is a generic class other pages
        // use too, and without the sidebar (mobile, PDA) this runs on every page
        if (seconds < 0 && new URLSearchParams(location.search).get('sid') === 'attack') {
            const attackTimerContainers = document.querySelectorAll('[class*="labelTitle___"]');
            for (const item of attackTimerContainers) {
                const match = item.textContent.replace(/,/g, '').match(/\d+\s*\(\s*(0?[0-5]:[0-5]\d)\s*\)/);
                if (match) { seconds = parseTimeStringToSeconds(match[1]); src = 'ATK'; break; }
            }
        }

        // Priority 3: Torn's sessionStorage sidebar data (works in the mobile layout and PDA)
        if (seconds < 0) {
            const chain = readSessionChain();
            if (chain && typeof chain.timestampToUpdate === 'number') {
                seconds = Math.max(0, chain.timestampToUpdate - Math.floor(Date.now() / 1000));
                src = 'SES';
            }
        }

        if (seconds < 0) {
            // Only class/id: aria-label/title carry free text (message previews, banners) mentioning "chain"
            const chainElements = document.querySelectorAll('[class*="chain" i], [id*="chain" i]');
            for (const el of chainElements) {
                if (el.id === 'pda-chain-timer-container' || el.closest('#pda-chain-timer-container')) continue;
                // Standalone M:SS only, so HH:MM:SS timestamps and DD:HH:MM:SS countdowns don't match
                const match = el.textContent.match(/(?:^|[^\d:])(0?[0-5]:[0-5]\d)(?![\d:])/);
                if (match) { seconds = parseTimeStringToSeconds(match[1]); src = 'DOM'; break; }
            }
        }

        if (seconds >= 0) {
            saveLocalExpire(seconds, src);
        } else {
            // Priority 5: local time saved by this or another tab
            seconds = secondsUntil('pda_chain_timer_local_expire');
            src = seconds > 0 ? localMemorySource() : 'NONE';
        }

        setText(localText, formatSecondsToTimeString(seconds));
        setText(localLabel, src);
        return seconds;
    }

    // -------------------------------------------------------------------
    // 5. API timer (right): Torn API only, polled every 5s during a chain (30s otherwise)
    //    and shared across tabs
    // -------------------------------------------------------------------
    function fetchApiChain() {
        localStorage.setItem('pda_chain_timer_api_last_call', Date.now());
        // One call at a time, so a slow reply can't overwrite a newer one
        apiCallStarted = Date.now();
        fetch(`https://api.torn.com/faction/?selections=chain&key=${apiKey}`)
            .then(response => response.json())
            .then(data => {
                if (data && data.chain && typeof data.chain.timeout === 'number') {
                    localStorage.setItem('pda_chain_timer_api_expire', Date.now() + (data.chain.timeout * 1000));
                    localStorage.setItem('pda_chain_timer_api_time', Date.now());
                    localStorage.setItem('pda_chain_timer_api_error', '');
                    localStorage.setItem('pda_chain_timer_count', `${data.chain.current}/${data.chain.max}`);
                } else {
                    // Torn returns {error: {code, error}} for bad keys, access level, rate limits
                    localStorage.setItem('pda_chain_timer_api_error', 'API-ERR' + (data && data.error ? data.error.code : '?'));
                    console.error('Chain timer API error:', data && data.error);
                }
            })
            .catch(err => {
                localStorage.setItem('pda_chain_timer_api_error', 'API-NET');
                console.error(err);
            })
            .finally(() => { apiCallStarted = 0; });
    }

    // chainActive: the local timer sees a chain, so switch to the faster polling
    // without waiting for the API to notice it
    function updateApiTimer(chainActive) {
        if (!apiKey) {
            setText(apiText, '--:--');
            setText(apiLabel, 'NO KEY');
            return 0;
        }

        const seconds = secondsUntil('pda_chain_timer_api_expire');
        const interval = (chainActive || seconds > 0) ? API_INTERVAL_CHAIN : API_INTERVAL_IDLE;
        const lastCall = parseInt(localStorage.getItem('pda_chain_timer_api_last_call')) || 0;
        // A call pending for over 15s is treated as lost, so a hung request can't block polling
        const pending = Date.now() - apiCallStarted < 15000;
        if (!pending && Date.now() - lastCall > interval) fetchApiChain();

        const error = localStorage.getItem('pda_chain_timer_api_error');
        const fetchedAt = parseInt(localStorage.getItem('pda_chain_timer_api_time')) || 0;

        setText(apiText, formatSecondsToTimeString(seconds));
        if (error) setText(apiLabel, error);
        else if (fetchedAt) setText(apiLabel, 'API ' + Math.round((Date.now() - fetchedAt) / 1000) + 's');
        else setText(apiLabel, 'API ...');
        return seconds;
    }

    // -------------------------------------------------------------------
    // 6. Main loop
    // -------------------------------------------------------------------
    setInterval(() => {
        // Position & State Tab-Sync
        if (!isDragging) {
            let savedPaused = localStorage.getItem('pda_chain_timer_is_paused') === 'true';

            if (isPaused !== savedPaused) setMinimized(savedPaused);

            let xType = localStorage.getItem('pda_chain_timer_x_type');
            let xVal = localStorage.getItem('pda_chain_timer_x_val');
            let yType = localStorage.getItem('pda_chain_timer_y_type');
            let yVal = localStorage.getItem('pda_chain_timer_y_val');

            if (container.style[xType] !== xVal + 'px' || container.style[yType] !== yVal + 'px') {
                applyNativeBounds();
            }
        }

        // Minimised means no alarm at all, even below the panic time
        if (isPaused || document.hidden) {
            updateAlarm(0);
            updateWakeLock(false);
            return;
        }

        const localSeconds = updateLocalTimer();
        const apiSeconds = updateApiTimer(localSeconds > 0);
        setText(countLabel, localStorage.getItem('pda_chain_timer_count') || '');
        updateTargetFlag();

        // Alert follows the local timer; the API is the backup when the local one has nothing
        updateAlarm(localSeconds > 0 ? localSeconds : apiSeconds);
        updateWakeLock(wakeEnabled && (localSeconds > 0 || apiSeconds > 0));

    }, 1000);
})();
