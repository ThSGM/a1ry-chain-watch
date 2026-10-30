// ==UserScript==
// @name         a1ry Chain Watch
// @namespace    https://github.com/ThSGM/a1ry-chain-watch
// @version      3.94
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
// nothing. Chain count (bar under the timers, e.g. 1,234) comes from the API.
//
// Health bar (the bar behind the chain count, 0-100, number on the right):
//   Scored from the left timer, no API. A hit shows up as the chain end
//   time jumping forward; the time left just before it gives the score:
//   over 3:00 +1, 2:00-3:00 -10, 1:00-2:00 -20, under 1:00 straight to 1
//   (the bar flashes red while at 1). Hits keep it between 1 and 100. Every
//   faction hit counts (the page can't tell whose it was), and only hits
//   seen by a visible, unminimised tab that read the time the second
//   before. 0 when the chain ends and at the start of each browser session
//   (a session cookie marks it); shared across tabs and page loads.
//
// Alarm (both times set in OPT):
//   At or below the warning time (default 2:30) it flashes and sounds.
//   ACK silences it until the panic time (default 2:00); from there it
//   can't be silenced. The panic time works on its own, even above the
//   warning time or with the warning Off. The acknowledgement is shared across tabs and page
//   loads, and a hit cancels it. Minimised (MIN) = no alarm at all.
//   OPT also sets the volume, the sound (Chime, Hi-lo, Yelp, Alarm clock,
//   Phone ring, Klaxon, SOS, 24 phone, FF7 battle, FF6 battle (the default) or Off; all made in the browser, no
//   sound files) and the screen-edge flash, which pulses faster from the
//   panic time.
//
// Keep screen on (OPT): while a chain is running and the box isn't
// minimised, the screen is kept from sleeping (Screen Wake Lock, where
// the browser supports it). The browser drops it while the tab is hidden;
// it is asked for again when the tab is back.
//
// Random targets (tap the timers): a random ID from the target range
// chosen in OPT (3.0M-3.4M, 4.2M-4.55M or both, the default), never one in
// excludedIDs. If a target picked this way has more maximum health than
// "Block targets with HP over" in OPT (a slider, 100-2000, default 1000,
// far left = off), its attack page shows a purple banner at the top, the
// box border and the defender's panel turn purple, and the Start fight /
// Join fight button is greyed out and does nothing (found by its text, as
// Torn's class names change). Only the script's own picks (the same ID,
// picked in the last PICK_WINDOW) are checked, so attack pages opened any
// other way are left alone. To attack a blocked target anyway, raise that
// limit, slide it to Off or untick "Block big targets" in OPT.
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
    // Default for "Block targets with HP over" (OPT): a picked target with more maximum health
    // than this is blocked
    const DEFAULT_BIG_HEALTH = 1000;
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
    // Health bar: the most it holds
    const HP_MAX = 100;
    // Keep in step with @version above (GM_info isn't available in every userscript host)
    const SCRIPT_VERSION = '3.94';
    // OPT's Update button: the script's Greasy Fork page, whose Install button updates it
    const UPDATE_URL = 'https://greasyfork.org/en/scripts/601300-a1ry-chain-watch';
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
        // The CTU phone in 24, measured from a recording: 2+2 quiet pips at 697 Hz, 4 loud at
        // 991 Hz, then 8 an octave down at 493 Hz, each about 33 ms on, 20 ms off. Twice the
        // recording's level: pips this short sound softer than the other sounds at the same level
        ctu: { cycle: 2, notes: [
            ...pips([0, 0.052, 0.221, 0.271], 0.03, 697, [[1, 0.42], [3, 0.94], [5, 0.16]]),
            ...pips([0.66, 0.708, 0.762, 0.817], 0.033, 991, [[1, 1.6], [3, 0.8]]),
            ...pips(Array.from({ length: 8 }, (_, i) => 0.872 + i * 0.0546), 0.035, 493,
                [[1, 0.7], [3, 0.7], [5, 0.7]])] },
        // Final Fantasy VII's battle theme, its opening bar from a MIDI of it, at 120 bpm (the
        // MIDI's 96 is a 2.5 s bar; whole seconds are needed): repeated F5 sixteenths with C5 on
        // every third and a run up to F#5, over F3+C4 chords
        ff7: { cycle: 2, notes: musicBar(
            [[0, 72], [0, 77], [1, 77], [2, 77], [3, 72], [3, 77], [4, 77], [5, 77], [6, 72], [6, 77],
                [7, 77], [8, 77], [9, 77], [10, 72], [11, 75], [12, 78], [13, 77], [14, 75], [15, 78]],
            [[0, 3, [53, 60]], [3, 1, [53, 60]], [6, 2, [53, 60]], [9, 3, [53, 60]], [12, 2, [53, 60]],
                [14, 2, [51, 58]]],
            1.4, 0.8) },
        // Final Fantasy VI's The Decisive Battle, bar 3 of a MIDI of it (its own 120 bpm): the
        // top line climbs E5 F5 F#5 F5 E5 over a C5 A4 figure, with an A2 bass in 3s
        ff6: { cycle: 2, notes: musicBar(
            [[0, 76], [1, 72], [2, 69], [3, 77], [4, 72], [5, 69], [6, 78], [7, 72], [8, 69], [9, 77],
                [10, 72], [11, 69], [12, 76], [13, 72], [14, 71], [15, 75]],
            [[0, 3, [45]], [3, 1, [45]], [6, 2, [45]], [9, 3, [45]], [12, 2, [45]], [14, 2, [43]]],
            1.9, 1.3) },
        off: { cycle: 1, notes: [] }
    };

    // Pitch in Hz of a MIDI note number (69 = A4 = 440 Hz)
    function midiHz(n) {
        return 440 * Math.pow(2, (n - 69) / 12);
    }

    // One 2 s bar of music in sixteenth steps (0.125 s, 120 bpm). right: [step, MIDI note], a
    // soft piano-like tone (the note with quieter 2nd and 3rd harmonics, fading out); left: [step,
    // length in steps, MIDI notes], low notes that fade over their length
    function musicBar(right, left, rightGain, leftGain) {
        return [
            ...right.flatMap(([s, n]) => [[1, 1], [2, 0.35], [3, 0.12]].map(([h, g]) =>
                ({ t: s * 0.125, len: 0.4, f: midiHz(n) * h, g: g * rightGain }))),
            ...left.flatMap(([s, l, ns]) => ns.map(n =>
                ({ t: s * 0.125, len: l * 0.125 + 0.1, f: midiHz(n), type: 'triangle', g: leftGain })))];
    }

    // Old UK phone ring: two tones together, switched on and off 20 times a second
    function ringBurst(start, length) {
        const notes = [];
        for (let t = 0; t < length - 0.01; t += 0.05) {
            for (const f of [400, 450]) notes.push({ t: start + t, len: 0.025, f, env: 'hold', g: 0.6 });
        }
        return notes;
    }

    // Buzzy pips starting at times (s), each len long: partials are [multiple of f, loudness]
    // pairs played together, which gives the tone its colour
    function pips(times, len, f, partials) {
        return times.flatMap(t => partials.map(([h, g]) => ({ t, len, f: f * h, env: 'hold', g })));
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
    // OPT settings. Read on load, and again when another tab saves them (main loop)
    let alertThreshold, criticalThreshold, volume, flashEnabled, beepPattern, wakeEnabled, idRange, blockEnabled, bigHealth, boxSize, apiKey;
    function loadSettings() {
        // 0 is a valid setting for both (Off: no alarm / ACK always works)
        const savedAlert = parseInt(localStorage.getItem('pda_chain_timer_alert_threshold'));
        const savedCritical = parseInt(localStorage.getItem('pda_chain_timer_critical_threshold'));
        alertThreshold = isNaN(savedAlert) ? 150 : savedAlert;
        criticalThreshold = isNaN(savedCritical) ? 120 : savedCritical;
        const savedVolume = parseInt(localStorage.getItem('pda_chain_timer_volume'));
        volume = isNaN(savedVolume) ? 20 : savedVolume; // percent; 0 is a valid (silent) setting
        flashEnabled = localStorage.getItem('pda_chain_timer_flash') !== 'false';
        beepPattern = localStorage.getItem('pda_chain_timer_beep');
        // Regular, Pulse and Rave (3.78), Warble and Sonic drowning (3.86) are gone; they and
        // anything unknown (or nothing saved yet) become FF6 battle, the default
        if (!ALARM_SOUNDS[beepPattern]) beepPattern = 'ff6';
        wakeEnabled = localStorage.getItem('pda_chain_timer_wake') !== 'false';
        idRange = localStorage.getItem('pda_chain_timer_id_range');
        if (!ID_RANGES[idRange]) idRange = 'both';
        // The Block big targets checkbox (3.89); unticked, nothing is blocked whatever the HP limit
        blockEnabled = localStorage.getItem('pda_chain_timer_block') !== 'false';
        // 0 = off. Before 3.81 this was an on/off checkbox (flag_big) with a fixed 500
        const savedBigHealth = parseInt(localStorage.getItem('pda_chain_timer_big_health'));
        bigHealth = !isNaN(savedBigHealth) ? savedBigHealth :
            localStorage.getItem('pda_chain_timer_flag_big') === 'false' ? 0 : DEFAULT_BIG_HEALTH;
        boxSize = parseInt(localStorage.getItem('pda_chain_timer_size')) || 100; // percent of the original size
        apiKey = localStorage.getItem('pda_chain_timer_api_key') || '';
    }
    loadSettings();
    localStorage.setItem('pda_chain_timer_critical_threshold', criticalThreshold);
    // Changes when any tab presses Save
    let settingsSeen = localStorage.getItem('pda_chain_timer_settings_saved');
    let alarmSeconds = 0;
    let wakeLock = null; // the screen wake lock while held
    let wakeLockPending = false;
    let wantWakeLock = false;
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
        #pda-update-btn { text-decoration: none; }
        .pda-timer-left { display: flex; align-items: center; gap: calc(3px * var(--hs)); min-width: 0; }
        #pda-timer-version { font-size: calc(7px * var(--hs)); font-weight: normal; text-transform: none; color: #777 !important; white-space: nowrap; overflow: hidden; }
        .pda-btn { background: #444 !important; border: none !important; color: #fff !important; font-size: calc(10px * var(--hs)); font-weight: bold; padding: 1px 6px; border-radius: calc(3px * var(--hs)); display: flex; align-items: center; justify-content: center; cursor: pointer; font-family: Arial, sans-serif; min-width: calc(22px * var(--hs)); }
        #pda-timer-ack-btn { background: #b32424 !important; }
        #pda-timer-ack-btn:disabled { opacity: 0.4; cursor: default; }
        #pda-timer-display { position: relative; flex: 1; display: flex; background-color: #111; color: #fff !important; }
        .pda-timer-half { position: relative; flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; font-weight: bold; font-family: 'Courier New', Courier, monospace; font-size: calc(17px * var(--s)); line-height: 1; }
        #pda-timer-half-api { border-left: 1px solid #333; }
        .pda-timer-source { margin-top: calc(2px * var(--s)); text-align: center; font-size: calc(7px * var(--s)); font-weight: normal; line-height: 1; color: #777 !important; font-family: Arial, sans-serif; pointer-events: none; white-space: nowrap; }
        #pda-timer-count { position: relative; flex-shrink: 0; background: #222 !important; border-top: 1px solid #333; text-align: center; font-size: calc(10px * var(--s)); font-weight: bold; line-height: calc(12px * var(--s)); color: #fff !important; font-family: 'Courier New', Courier, monospace; white-space: nowrap; }
        /* Health bar: the fill sits behind the chain count; its width and colour are set from
           the script. Effects animate only opacity and transform, so the page isn't repainted */
        #pda-hp-fill { position: absolute; top: 0; bottom: 0; left: 0; width: 0; transition: width 0.4s ease-out, background-color 0.4s; }
        #pda-timer-count-text { position: relative; text-shadow: 0 0 2px #000, 0 0 2px #000; }
        #pda-hp-text { position: absolute; right: calc(3px * var(--s)); top: 0; font-size: calc(7px * var(--s)); font-weight: normal; color: #ddd !important; font-family: Arial, sans-serif; text-shadow: 0 0 2px #000; }
        #pda-timer-count::after { content: ''; position: absolute; top: 0; left: 0; right: 0; bottom: 0; opacity: 0; pointer-events: none; }
        #pda-hp-pop { position: absolute; right: calc(3px * var(--s)); bottom: 100%; z-index: 1; opacity: 0; pointer-events: none; font-family: Arial, sans-serif; text-shadow: 0 0 3px #000; }
        #pda-timer-count.pda-hp-gain::after { background: #4f4; animation: pda-hp-flash 0.6s ease-out; }
        #pda-timer-count.pda-hp-loss::after { background: #f22; animation: pda-hp-flash 0.6s ease-out; }
        #pda-timer-count.pda-hp-loss { animation: pda-hp-shake 0.4s; }
        .pda-hp-gain #pda-hp-pop { color: #6f6 !important; animation: pda-hp-float 1s ease-out; }
        .pda-hp-loss #pda-hp-pop { color: #f66 !important; animation: pda-hp-float 1s ease-out; }
        /* At 1: the fill flashes red, 2.5 flashes/s like the fast screen flash */
        #pda-timer-count.pda-hp-low #pda-hp-fill { width: 100% !important; background: #ff2a2a !important; animation: pda-hp-low 0.4s infinite alternate; }
        @keyframes pda-hp-flash { from { opacity: 0.8; } to { opacity: 0; } }
        @keyframes pda-hp-shake { 0%, 100% { transform: none; } 25% { transform: translateX(-3px); } 75% { transform: translateX(3px); } }
        @keyframes pda-hp-float { from { opacity: 1; transform: translateY(4px); } to { opacity: 0; transform: translateY(-12px); } }
        @keyframes pda-hp-low { from { opacity: 0.15; } to { opacity: 0.8; } }
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
        .pda-settings-open #pda-timer-display, .pda-settings-open #pda-timer-count { display: none; }
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
            </div>
            <div class="pda-timer-half" id="pda-timer-half-api">
                <span id="pda-timer-text-api">--:--</span>
                <span class="pda-timer-source" id="pda-timer-source-api"></span>
            </div>
        </div>
        <div id="pda-timer-count"><div id="pda-hp-fill"></div><span id="pda-timer-count-text"></span><span id="pda-hp-text"></span><span id="pda-hp-pop"></span></div>

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
                    <option value="ctu">24 phone</option>
                    <option value="ff7">FF7 battle</option>
                    <option value="ff6">FF6 battle</option>
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
                <span title="ID range for the random target opened by tapping the timers">Target range:</span>
                <select id="pda-range-input">
                    <option value="low">3.0M-3.4M</option>
                    <option value="high">4.2M-4.55M</option>
                    <option value="both">Both</option>
                </select>
            </div>
            <div class="pda-setting-row">
                <span title="Block Start fight on random targets over the HP limit below">Block big targets:</span>
                <input type="checkbox" id="pda-block-input">
            </div>
            <div class="pda-setting-block">
                <div class="pda-setting-row">
                    <span title="On the attack page of a random target with more maximum health than this, Start fight is blocked. Far left = off">Block targets with HP over: <b class="pda-slider-value"></b></span>
                    <button class="pda-btn pda-default-btn" data-default="${DEFAULT_BIG_HEALTH}" title="Default: ${DEFAULT_BIG_HEALTH}">Default</button>
                </div>
                <input type="range" id="pda-flag-input" min="50" max="2000" step="50">
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
                <a class="pda-btn" id="pda-update-btn" href="${UPDATE_URL}" target="_blank" rel="noopener" title="Open the script's Greasy Fork page to install the latest version">Update</a>
            </div>
            <div id="pda-help">
                <p><b>Left timer</b> = read from page<br>
                <b>Right timer</b> = Torn API</p>
                <p>Click/tap timers for target</p>
                <p><b>Bottom bar</b> = chain count over health (0-100): hit over 3:00 +1, 2:00-3:00 -10, 1:00-2:00 -20, under 1:00 = 1. Resets when the chain ends or the browser closes</p>
                <p><b>MIN</b> = minimize<br>
                <b>OPT</b> = options<br>
                <b>DASH</b> = open dashboard</p>
                <p>Scrape info<br>
                <b>BAR</b> = sidebar<br>
                <b>ATK</b> = attack page header<br>
                <b>SES</b> = Torn saved sidebar info<br>
                <b>DOM</b> = other chain text on page<br>
                <b>MEM-x</b> = time saved from tab<br>
                <b>API-ERR2</b> = wrong API key<br>
                <b>NO KEY</b> = no API key set</p>
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
    const countBar = container.querySelector('#pda-timer-count');
    const countLabel = container.querySelector('#pda-timer-count-text');
    const hpFill = container.querySelector('#pda-hp-fill');
    const hpText = container.querySelector('#pda-hp-text');
    const hpPop = container.querySelector('#pda-hp-pop');
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
    const blockInput = container.querySelector('#pda-block-input');
    const flagInput = container.querySelector('#pda-flag-input');
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
        blockInput.checked = blockEnabled;
        flagInput.value = bigHealth || 50; // 50, the far left, shows as Off
        sizeInput.value = boxSize;
        apiInput.value = apiKey;
        for (const input of [thresholdInput, criticalInput, volumeInput, sizeInput, flagInput]) {
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
    // Health bar: scored from the local timer, never the API
    // -------------------------------------------------------------------
    // A session cookie (no expiry) is gone once the browser closes, so its absence means a new
    // session: health starts again from 0. localStorage alone would outlive the browser, and
    // sessionStorage isn't shared with new tabs
    if (!document.cookie.split('; ').includes('a1ry_hp_session=1')) {
        localStorage.setItem('pda_chain_timer_hp', 0);
        document.cookie = 'a1ry_hp_session=1; path=/; secure; samesite=lax';
    }
    // When this tab last read a time from the page (MEM doesn't count). A hit is only scored
    // when the tab read the time the second before, so the time left at the hit is known
    let lastPageRead = 0;
    let shownHp = -1;

    // Called with each time read from the page, before saveLocalExpire stores it. The saved end
    // time is the newest any tab has read, so the first tab to see a hit stores the new end
    // time and the others then see no jump: each hit is scored once.
    // zeroIsEnd: a 0 from this source means no chain (BAR, COOL, ATK, or SES with no end time;
    // not a stale SES that has run down, nor the loose DOM match)
    function updateHealth(seconds, zeroIsEnd) {
        const now = Date.now();
        const savedExpire = parseInt(localStorage.getItem('pda_chain_timer_local_expire')) || 0;
        const fresh = now - lastPageRead <= 3000;
        lastPageRead = now;
        const hp = parseInt(localStorage.getItem('pda_chain_timer_hp')) || 0;

        if (seconds === 0) {
            // Only once the known end time has passed, so a 00:00 shown while a page loads
            // mid-chain doesn't wipe it
            if (zeroIsEnd && hp && savedExpire < now + 3000) setHealth(0, null);
            return;
        }
        // A hit moves the end time forward by minutes; reading jitter is 1-2 s
        const left = (savedExpire - now) / 1000;
        if (!fresh || left <= 0 || now + seconds * 1000 - savedExpire <= 3000) return;

        let next, text;
        if (left > 180) { next = hp + 1; text = '+1'; }
        else if (left >= 120) { next = hp - 10; text = '\u221210'; }
        else if (left >= 60) { next = hp - 20; text = '\u221220'; }
        else { next = 1; text = '\u21921'; }
        setHealth(Math.min(HP_MAX, Math.max(1, next)), { text, gain: left > 180 });
    }

    // event: { text, gain } for the effect, saved so other tabs play it too; null for none
    function setHealth(hp, event) {
        localStorage.setItem('pda_chain_timer_hp', hp);
        if (!event) return;
        localStorage.setItem('pda_chain_timer_hp_event', JSON.stringify(event));
        playHealthEffect(event);
    }

    function playHealthEffect(event) {
        hpPop.textContent = event.text;
        countBar.classList.remove('pda-hp-gain', 'pda-hp-loss');
        void countBar.offsetWidth; // restarts the animation when the same class comes back
        countBar.classList.add(event.gain ? 'pda-hp-gain' : 'pda-hp-loss');
    }

    // Other tabs' hits. The storage event never fires in the tab that made the change
    window.addEventListener('storage', (e) => {
        if (e.key !== 'pda_chain_timer_hp_event' || !e.newValue) return;
        try { playHealthEffect(JSON.parse(e.newValue)); } catch (err) { /* not ours */ }
    });

    // Touches the page only when the value changed
    function renderHealth() {
        const hp = parseInt(localStorage.getItem('pda_chain_timer_hp')) || 0;
        if (hp === shownHp) return;
        shownHp = hp;
        hpFill.style.width = (hp / HP_MAX * 100) + '%';
        hpFill.style.backgroundColor = hp >= 60 ? '#2a7a2a' : hp >= 30 ? '#9a7400' : '#a82020';
        countBar.classList.toggle('pda-hp-low', hp === 1);
        setText(hpText, String(hp));
        countBar.title = `Health ${hp}/${HP_MAX}`;
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

    // The picked target's maximum health while on its attack page with blocking on, else
    // null (any other page, including one Torn reaches without a reload)
    function pickedTargetHealth() {
        if (pickedTargetID === null || !blockEnabled || !bigHealth) return null;
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

    // Above bigHealth: a banner with the picked target's maximum health, purple box border and
    // defender outline, and the fight button greyed out. Checked every tick, as Torn redraws the page
    // (a redrawn button or panel is a new element without the mark); marks are only written
    // where missing
    function updateTargetFlag() {
        const health = pickedTargetHealth();
        const big = health !== null && health > bigHealth;
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
                button.title = `Blocked by a1ry Chain Watch: max health ${health.toLocaleString()} is over ${bigHealth}`;
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
        if (health === null || health <= bigHealth) return;
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
    // OPT opens the settings; pressed again while they're open, it saves and closes like Save
    cfgBtn.addEventListener('click', () => {
        if (settingsPanel.style.display === 'flex') { closeSettingsBtn.click(); return; }
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
        blockEnabled = blockInput.checked;
        localStorage.setItem('pda_chain_timer_block', blockEnabled);
        // The far left of the slider (below 100) turns the block off
        const blockAt = parseInt(flagInput.value, 10);
        bigHealth = blockAt < 100 ? 0 : blockAt;
        localStorage.setItem('pda_chain_timer_big_health', bigHealth);
        boxSize = parseInt(sizeInput.value, 10);
        localStorage.setItem('pda_chain_timer_size', boxSize);
        apiKey = apiInput.value.trim();
        localStorage.setItem('pda_chain_timer_api_key', apiKey);
        localStorage.setItem('pda_chain_timer_settings_saved', Date.now());
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

    // Slider value shown next to each label: times as M:SS (0 = Off), health as a number (below
    // 100 = Off), the rest in percent
    function formatSliderValue(input) {
        const v = parseInt(input.value, 10);
        if (input === thresholdInput || input === criticalInput) {
            return v ? `${Math.floor(v / 60)}:${String(v % 60).padStart(2, '0')}` : 'Off';
        }
        if (input === flagInput) return v < 100 ? 'Off' : v.toLocaleString();
        return v + '%';
    }

    for (const input of [thresholdInput, criticalInput, volumeInput, sizeInput, flagInput]) {
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

    // Unlock audio on a tap anywhere on the page, so the alarm can sound after a page load.
    // On touch screens pointerdown doesn't count as a tap that may start audio (iOS and
    // TornPDA ignore it); pointerup, touchend and click do
    for (const type of ['pointerdown', 'pointerup', 'touchend', 'click', 'keydown']) {
        document.addEventListener(type, initAudioContext, true);
    }

    function initAudioContext() {
        try {
            if (!audioCtx) {
                const AudioContext = window.AudioContext || window.webkitAudioContext;
                if (AudioContext) audioCtx = new AudioContext();
                // iOS 17+: play like media, so the silent switch / silent mode doesn't mute it
                if (navigator.audioSession) navigator.audioSession.type = 'playback';
            }
            // iOS also leaves it 'interrupted' after a call or switching apps
            if (audioCtx && audioCtx.state !== 'running' && audioCtx.state !== 'closed') audioCtx.resume();
        } catch(e) { console.error("Audio block:", e); }
    }

    // Plays one cycle of an ALARM_SOUNDS sound. percent: volume, 0-100; bus: node to play
    // into (null: straight to the speakers, for the OPT test). Returns false if audio is locked
    function playSound(name, percent, bus) {
        try {
            initAudioContext();
            if (!audioCtx || audioCtx.state !== 'running') return false;
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
        // Panic counts on its own, so it still sounds when set above the warning time or with
        // the warning Off
        const critical = seconds > 0 && seconds <= criticalThreshold;
        const inAlert = critical || (seconds > 0 && seconds <= alertThreshold);
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
        let zeroIsEnd = true; // a 0 read here means the chain is over (see updateHealth)

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
                // Stale sidebar data runs down to 0 mid-chain; only no end time means no chain
                zeroIsEnd = chain.timestampToUpdate === 0;
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
            updateHealth(seconds, zeroIsEnd && src !== 'DOM');
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
                    localStorage.setItem('pda_chain_timer_count', data.chain.current.toLocaleString('en-US'));
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

            // Settings saved in another tab. An open OPT keeps what's typed in it
            const settingsSaved = localStorage.getItem('pda_chain_timer_settings_saved');
            if (settingsSaved !== settingsSeen) {
                settingsSeen = settingsSaved;
                loadSettings();
                if (settingsPanel.style.display !== 'flex') fillSettingInputs();
            }

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
        setText(countLabel, localStorage.getItem('pda_chain_timer_count') || '-');
        renderHealth();
        updateTargetFlag();

        // Alert follows the local timer; the API is the backup when the local one has nothing
        updateAlarm(localSeconds > 0 ? localSeconds : apiSeconds);
        updateWakeLock(wakeEnabled && (localSeconds > 0 || apiSeconds > 0));

    }, 1000);
})();
