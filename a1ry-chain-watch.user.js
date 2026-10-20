// ==UserScript==
// @name         a1ry Chain Watch
// @namespace    https://github.com/ThSGM/a1ry-chain-watch
// @version      3.62
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
//               chain-bar___), the element inside it whose text is M:SS.
//               Desktop width only: the mobile bar shows just the count.
//   2. ATK      Attack page header "(M:SS)"  [class*="labelTitle___"]
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
//                data in seconds. Polled every 10s, shared across tabs.
//   API-ERR<n>   Torn API returned error code <n> (e.g. 2 bad key, 5 rate limit)
//   API-NET      API request failed (network / fetch error)
//   NO KEY       No API key set (OPT)
//
// The alert follows the left timer, or the right one when the left has
// nothing. Chain count (top-left, e.g. 5/10) comes from the API.
// -------------------------------------------------------------------

(function() {
    'use strict';

    // Define requirements
    // These are user ID ranges that will be targeted when the timer is tapped
    const minID = 3000000;
    const maxID = 3400000;

    const API_INTERVAL = 10000;

    if (window.top !== window.self) return;
    if (document.getElementById('pda-chain-timer-container')) return;

    let audioCtx = null;
    let isDragging = false;
    let hasMoved = false;
    let pressedOnDisplay = false;
    let offsetX, offsetY;
    let startX, startY;

    let alertThreshold = parseInt(localStorage.getItem('pda_chain_timer_alert_threshold')) || 120;
    let apiKey = localStorage.getItem('pda_chain_timer_api_key') || '';
    let isPaused = localStorage.getItem('pda_chain_timer_is_paused') === 'true';

    // -------------------------------------------------------------------
    // Native CSS Anchor Setup
    // -------------------------------------------------------------------
    const container = document.createElement('div');
    container.id = 'pda-chain-timer-container';

    function applyNativeBounds() {
        if (!localStorage.getItem('pda_chain_timer_y_type')) {
            localStorage.setItem('pda_chain_timer_y_type', 'top');
            localStorage.setItem('pda_chain_timer_y_val', parseFloat(localStorage.getItem('pda_chain_timer_top')) || 60);
            localStorage.setItem('pda_chain_timer_x_type', 'left');
            localStorage.setItem('pda_chain_timer_x_val', parseFloat(localStorage.getItem('pda_chain_timer_left')) || 10);
        }

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

    applyNativeBounds();
    if (isPaused) container.classList.add('pda-minimized');

    const style = document.createElement('style');
    style.innerHTML = `
        #pda-chain-timer-container {
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
            width: 140px;
            height: 65px;
            box-sizing: border-box;
            touch-action: none;
            user-select: none;
            -webkit-user-select: none;
            transition: width 0.3s, height 0.3s, border-radius 0.3s;
        }

        #pda-chain-timer-container.pda-minimized {
            width: 45px !important;
            height: 45px !important;
            border-radius: 50% !important;
            align-items: center;
            justify-content: center;
            cursor: pointer;
        }

        #pda-chain-timer-container.pda-minimized > * { display: none !important; }
        #pda-chain-timer-container.pda-minimized::after { content: '>'; font-size: 20px; font-weight: bold; line-height: 1; }

        #pda-timer-header { background: #222 !important; padding: 3px 6px; font-size: 10px; text-transform: uppercase; font-weight: bold; color: #aaa !important; border-bottom: 1px solid #333; flex-shrink: 0; display: flex; justify-content: space-between; align-items: center; }
        .pda-timer-controls { display: flex; align-items: center; gap: 4px; }
        .pda-btn { background: #444 !important; border: none !important; color: #fff !important; font-size: 10px; font-weight: bold; padding: 1px 6px; border-radius: 3px; display: flex; align-items: center; justify-content: center; cursor: pointer; font-family: Arial, sans-serif; min-width: 22px; }
        #pda-timer-pause-btn.paused-state { background: #b32424 !important; }
        #pda-timer-display { position: relative; flex: 1; display: flex; background-color: #111; color: #fff !important; }
        .pda-timer-half { position: relative; flex: 1; display: flex; align-items: center; justify-content: center; font-weight: bold; font-family: 'Courier New', Courier, monospace; font-size: 17px; line-height: 1; }
        #pda-timer-half-api { border-left: 1px solid #333; }
        .pda-timer-source { position: absolute; left: 0; right: 0; bottom: 1px; text-align: center; font-size: 7px; font-weight: normal; line-height: 1; color: #777 !important; font-family: Arial, sans-serif; pointer-events: none; white-space: nowrap; }
        #pda-timer-count { position: absolute; left: 3px; top: 2px; font-size: 7px; font-weight: normal; line-height: 1; color: #777 !important; font-family: Arial, sans-serif; pointer-events: none; }
        #pda-settings-panel { position: absolute; top: 0; left: 0; right: 0; bottom: 0; background: rgba(17, 17, 17, 0.95) !important; display: none; flex-direction: column; padding: 4px 8px; z-index: 10; }
        .pda-setting-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; font-size: 9px; color: #ccc; }
        .pda-setting-row input { background: #333; border: 1px solid #555; color: #fff; font-size: 9px; padding: 1px 3px; width: 70px; }
        #pda-settings-close { background: #2a662a !important; margin-top: 2px; }

        .timer-warning-active { border-color: #ff2a2a !important; }
        .timer-warning-active #pda-timer-display { animation: pda-timer-flash 0.8s infinite alternate; }
        @keyframes pda-timer-flash { from { background-color: #111; } to { background-color: #b30000; } }
    `;
    document.head.appendChild(style);

    container.innerHTML = `
        <div id="pda-timer-header">
            <span>Chain</span>
            <div class="pda-timer-controls">
                <button class="pda-btn" id="pda-timer-cfg-btn" title="Settings">OPT</button>
                <button class="pda-btn" id="pda-timer-pause-btn" title="Pause/Resume">||</button>
            </div>
        </div>
        <div id="pda-timer-display">
            <div class="pda-timer-half" id="pda-timer-half-local">
                <span id="pda-timer-text-local">--:--</span>
                <span class="pda-timer-source" id="pda-timer-source-local"></span>
                <span id="pda-timer-count"></span>
            </div>
            <div class="pda-timer-half" id="pda-timer-half-api">
                <span id="pda-timer-text-api">--:--</span>
                <span class="pda-timer-source" id="pda-timer-source-api"></span>
            </div>
        </div>

        <div id="pda-settings-panel">
            <div class="pda-setting-row">
                <span>Alert (s):</span>
                <input type="number" id="pda-threshold-input" min="1" max="300">
            </div>
            <div class="pda-setting-row">
                <span>Public API:</span>
                <input type="password" id="pda-api-input" placeholder="key">
            </div>
            <button class="pda-btn" id="pda-settings-close">Save</button>
        </div>
    `;
    document.body.appendChild(container);

    const display = container.querySelector('#pda-timer-display');
    const localText = container.querySelector('#pda-timer-text-local');
    const localLabel = container.querySelector('#pda-timer-source-local');
    const apiText = container.querySelector('#pda-timer-text-api');
    const apiLabel = container.querySelector('#pda-timer-source-api');
    const countLabel = container.querySelector('#pda-timer-count');
    const pauseBtn = container.querySelector('#pda-timer-pause-btn');
    const cfgBtn = container.querySelector('#pda-timer-cfg-btn');
    const settingsPanel = container.querySelector('#pda-settings-panel');
    const closeSettingsBtn = container.querySelector('#pda-settings-close');
    const thresholdInput = container.querySelector('#pda-threshold-input');
    const apiInput = container.querySelector('#pda-api-input');

    thresholdInput.value = alertThreshold;
    apiInput.value = apiKey;

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
    function saveLocalExpire(seconds, src) {
        localStorage.setItem('pda_chain_timer_local_expire', Date.now() + (seconds * 1000));
        localStorage.setItem('pda_chain_timer_local_src', src);
    }

    function localMemorySource() {
        return 'MEM-' + (localStorage.getItem('pda_chain_timer_local_src') || '?');
    }

    // -------------------------------------------------------------------
    // 2. Drag Engine with Native Corner Resolution
    // -------------------------------------------------------------------
    // Pointer events cover mouse (desktop) and touch (PDA) alike
    container.addEventListener('pointerdown', (e) => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON' || settingsPanel.style.display === 'flex') return;
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

        initAudioContext();
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

    // Tap on the timer digits: jump to the attack page of a random player in the ID range
    function openRandomTarget() {
        const randID = Math.floor(Math.random() * (maxID - minID + 1)) + minID;
        window.location.href = `https://www.torn.com/page.php?sid=attack&user2ID=${randID}`;
    }

    document.addEventListener('pointerup', endDrag);
    document.addEventListener('pointercancel', endDrag);

    // -------------------------------------------------------------------
    // 3. UI Interaction Listeners
    // -------------------------------------------------------------------
    cfgBtn.addEventListener('click', () => settingsPanel.style.display = 'flex');

    closeSettingsBtn.addEventListener('click', () => {
        let val = parseInt(thresholdInput.value, 10);
        if (!isNaN(val) && val > 0) {
            alertThreshold = val;
            localStorage.setItem('pda_chain_timer_alert_threshold', alertThreshold);
        }
        apiKey = apiInput.value.trim();
        localStorage.setItem('pda_chain_timer_api_key', apiKey);
        settingsPanel.style.display = 'none';
    });

    function togglePauseMinimize() {
        isPaused = !isPaused;
        localStorage.setItem('pda_chain_timer_is_paused', isPaused);
        if (isPaused) container.classList.add('pda-minimized');
        else container.classList.remove('pda-minimized');
    }

    pauseBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        togglePauseMinimize();
    });

    function initAudioContext() {
        try {
            if (!audioCtx) {
                const AudioContext = window.AudioContext || window.webkitAudioContext;
                if (AudioContext) audioCtx = new AudioContext();
            }
            if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
        } catch(e) { console.error("Audio block:", e); }
    }

    function playQuietAlert() {
        try {
            initAudioContext();
            if (!audioCtx || audioCtx.state === 'suspended') return;
            const osc = audioCtx.createOscillator();
            const gainNode = audioCtx.createGain();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(587.33, audioCtx.currentTime);
            gainNode.gain.setValueAtTime(0.08, audioCtx.currentTime);
            gainNode.gain.exponentialRampToValueAtTime(0.00001, audioCtx.currentTime + 0.2);
            osc.connect(gainNode);
            gainNode.connect(audioCtx.destination);
            osc.start();
            osc.stop(audioCtx.currentTime + 0.2);
        } catch (e) {}
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

        // Priority 1: Sidebar chain bar. Torn renamed chain-bar___ to chainBar___, so accept both,
        // then take the element inside it whose whole text is a time (00:00 when no chain)
        const chainBar = document.querySelector('a[class*="chainBar___"], a[class*="chain-bar___"]');
        if (chainBar) {
            for (const el of chainBar.querySelectorAll('*')) {
                if (el.children.length) continue;
                const match = el.textContent.trim().match(/^(0?[0-5]:[0-5]\d)$/);
                if (match) { seconds = parseTimeStringToSeconds(match[1]); src = 'BAR'; break; }
            }
        }

        // Priority 2: Attack page header. Checked before SES because the attack page has no
        // sidebar, so Torn stops refreshing sidebarData there and SES goes stale
        if (seconds < 0) {
            const attackTimerContainers = document.querySelectorAll('[class*="labelTitle___"]');
            for (const item of attackTimerContainers) {
                const match = item.textContent.match(/\((\d{1,2}:\d{2})\)/);
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

        localText.textContent = formatSecondsToTimeString(seconds);
        localLabel.textContent = src;
        return seconds;
    }

    // -------------------------------------------------------------------
    // 5. API timer (right): Torn API only, polled every 10s and shared across tabs
    // -------------------------------------------------------------------
    function fetchApiChain() {
        localStorage.setItem('pda_chain_timer_api_last_call', Date.now());
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
            });
    }

    function updateApiTimer() {
        if (!apiKey) {
            apiText.textContent = '--:--';
            apiLabel.textContent = 'NO KEY';
            return 0;
        }

        const lastCall = parseInt(localStorage.getItem('pda_chain_timer_api_last_call')) || 0;
        if (Date.now() - lastCall > API_INTERVAL) fetchApiChain();

        const seconds = secondsUntil('pda_chain_timer_api_expire');
        const error = localStorage.getItem('pda_chain_timer_api_error');
        const fetchedAt = parseInt(localStorage.getItem('pda_chain_timer_api_time')) || 0;

        apiText.textContent = formatSecondsToTimeString(seconds);
        if (error) apiLabel.textContent = error;
        else if (fetchedAt) apiLabel.textContent = 'API ' + Math.round((Date.now() - fetchedAt) / 1000) + 's';
        else apiLabel.textContent = 'API ...';
        return seconds;
    }

    // -------------------------------------------------------------------
    // 6. Main loop
    // -------------------------------------------------------------------
    setInterval(() => {
        // Position & State Tab-Sync
        if (!isDragging) {
            let savedPaused = localStorage.getItem('pda_chain_timer_is_paused') === 'true';

            if (isPaused !== savedPaused) {
                isPaused = savedPaused;
                if (isPaused) container.classList.add('pda-minimized');
                else container.classList.remove('pda-minimized');
            }

            let xType = localStorage.getItem('pda_chain_timer_x_type');
            let xVal = localStorage.getItem('pda_chain_timer_x_val');
            let yType = localStorage.getItem('pda_chain_timer_y_type');
            let yVal = localStorage.getItem('pda_chain_timer_y_val');

            if (container.style[xType] !== xVal + 'px' || container.style[yType] !== yVal + 'px') {
                applyNativeBounds();
            }
        }

        if (isPaused || document.hidden) return;

        const localSeconds = updateLocalTimer();
        const apiSeconds = updateApiTimer();
        countLabel.textContent = localStorage.getItem('pda_chain_timer_count') || '';

        // Alert follows the local timer; the API is the backup when the local one has nothing
        const alertSeconds = localSeconds > 0 ? localSeconds : apiSeconds;
        if (alertSeconds > 0 && alertSeconds <= alertThreshold) {
            container.classList.add('timer-warning-active');
            playQuietAlert();
        } else {
            container.classList.remove('timer-warning-active');
        }

    }, 1000);
})();
