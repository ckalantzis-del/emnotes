// ==UserScript==
// @name         WP CRM - S-Rides Ops Managers (City Highlighter + LiveOps Notes)
// @namespace    local.crm.highlighter
// @version      1.5
// @description  Highlights your own S-Rides cities (from the em-project sheet) + flags missing driver on the index page. Adds the LiveOps Notes + EM Project card and a "Copy ride info" button on order detail pages.
// @match        https://crm.welcomepickups.com/admin/tour_transfers/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_setClipboard
// @connect      script.google.com
// @connect      script.googleusercontent.com
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/ckalantzis-del/emnotes/main/ops-specialist.user.js
// @downloadURL  https://raw.githubusercontent.com/ckalantzis-del/emnotes/main/ops-specialist.user.js
// ==/UserScript==

(function () {
  'use strict';

  // ============================================================
  // CONFIG — edit this line
  // ============================================================
  const SHEET_WEBAPP_URL = 'https://script.google.com/a/macros/welcomepickups.com/s/AKfycbxi1hSJroLQ5hWRlowdoAMQ_-A61EKVio7EJYkYXZC6g6XFso4LGapHzbMMNt9CF5hr/exec';
  const AUTHOR_EMAIL_DOMAIN = 'welcomepickups.com'; // used if the CRM only shows a username, not a full email

  // Auto-detects the logged-in agent from the #current_user element in the
  // top bar (e.g. "ckalantzis"), and turns it into an email if it isn't one
  // already. Falls back to 'Unknown agent' if nothing can be found.
  function detectAuthor() {
    const currentUserEl = document.querySelector('#current_user a, #current_user');
    const raw = (currentUserEl?.textContent || '').trim();
    if (!raw) return 'Unknown agent';

    const emailMatch = raw.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
    if (emailMatch) return emailMatch[0];

    return `${raw}@${AUTHOR_EMAIL_DOMAIN}`;
  }

  const AUTHOR_NAME = detectAuthor();

  // Logged-in CRM email → name as written in the "City Owner" column of the
  // em-project tab. Matching is case-insensitive and partial, so "Stavros"
  // also matches an owner cell like "Stavros P." Add one line per person.
  const OWNER_BY_EMAIL = {
    'ckalantzis@welcomepickups.com': 'Christophoros',
    'sperros@welcomepickups.com': 'Stavros',
  };
  const MY_OWNER_NAME = OWNER_BY_EMAIL[AUTHOR_NAME.toLowerCase()] || null;

  // ============================================================
  // PART 1 — INDEX PAGE: city highlighter + smart driver alert
  // Cities come from the em-project tab (via the Apps Script `cities`
  // action), filtered to the logged-in person's own cities.
  // ============================================================
  function initIndexHighlighter() {

    function normalize(text) {
      return (text || '')
        .replace(/\u00A0/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
    }

    function visibleText(el) {
      return (el?.innerText || '')
        .replace(/\u00A0/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    }

    // Same as normalize, but also drops accents ("Medellín" → "medellin")
    // so owner names and city names match however they were typed.
    function fold(text) {
      return normalize(text).normalize('NFD').replace(/[̀-ͯ]/g, '');
    }

    // Keeps only the cities owned by MY_OWNER_NAME. Falls back to every city
    // in the tab if the person isn't in OWNER_BY_EMAIL or owns none, so the
    // highlighter never silently goes blank.
    function pickMyCities(rows) {
      const all = rows.map(r => r.city).filter(Boolean);
      if (!MY_OWNER_NAME) {
        console.warn(`[TM] ${AUTHOR_NAME} is not in OWNER_BY_EMAIL, highlighting all ${all.length} cities.`);
        return all;
      }
      const me = fold(MY_OWNER_NAME);
      const mine = rows.filter(r => fold(r.owner).includes(me)).map(r => r.city);
      if (!mine.length) {
        console.warn(`[TM] No cities in em-project with owner "${MY_OWNER_NAME}", highlighting all ${all.length} cities.`);
        return all;
      }
      console.log(`[TM] Highlighting ${mine.length} cities owned by ${MY_OWNER_NAME}.`);
      return mine;
    }

    let CITY_SET = new Set();
    function setCityRows(rows) {
      CITY_SET = new Set(pickMyCities(rows).map(fold));
    }

    // Start from the last list we fetched so highlighting is instant, then
    // refresh from the sheet in the background.
    const CACHE_KEY = 'emProjectCities';
    const cached = GM_getValue(CACHE_KEY, null);
    if (Array.isArray(cached) && cached.length) setCityRows(cached);

    apiRequest('GET', { action: 'cities' })
      .then((res) => {
        if (!Array.isArray(res?.cities) || !res.cities.length) return;
        GM_setValue(CACHE_KEY, res.cities);
        setCityRows(res.cities);
        scan();
      })
      .catch((err) => console.warn('[TM] Could not load cities from the sheet, using cached list.', err));

    function hasUnpaidMarker(cell) {
      const text = visibleText(cell);
      return text === 'U' || /\bU\b/.test(text);
    }

    function applyCityPill(cell) {
      if (!cell || cell.dataset.cityDone === '1') return;
      const text = visibleText(cell);
      cell.innerHTML = '';
      const pill = document.createElement('span');
      pill.textContent = text;
      Object.assign(pill.style, {
        display: 'inline-block', background: '#dcfce7', color: '#166534',
        fontWeight: '700', padding: '3px 10px', borderRadius: '999px', lineHeight: '1.2'
      });
      cell.appendChild(pill);
      cell.dataset.cityDone = '1';
    }

    function applyRowStyle(row, hasAlert) {
      if (!row) return;
      row.style.borderLeft = hasAlert ? '4px solid #ef4444' : '4px solid #22c55e';
      row.style.background = hasAlert ? 'rgba(239, 68, 68, 0.06)' : 'rgba(34, 197, 94, 0.05)';
    }

    function isMissingDriverCell(cell) {
      return !normalize(visibleText(cell));
    }

    function applyDriverAlert(cell) {
      if (!cell || cell.dataset.driverDone === '1') return;
      cell.innerHTML = '';
      const badge = document.createElement('span');
      badge.textContent = '🚨 NO DRIVER';
      Object.assign(badge.style, {
        display: 'inline-block', background: '#fee2e2', color: '#991b1b',
        fontWeight: '700', padding: '3px 10px', borderRadius: '999px',
        lineHeight: '1.2', whiteSpace: 'nowrap'
      });
      cell.appendChild(badge);
      cell.dataset.driverDone = '1';
    }

    function scan() {
      const rows = document.querySelectorAll('tr, [role="row"], .ant-table-row');
      rows.forEach(row => {
        const cells = Array.from(
          row.querySelectorAll('td, [role="cell"], [role="gridcell"], .ant-table-cell')
        );
        if (!cells.length) return;

        let cityCell = null;
        for (const cell of cells) {
          if (CITY_SET.has(fold(visibleText(cell)))) { cityCell = cell; break; }
        }
        if (!cityCell) return;

        applyCityPill(cityCell);

        const firstCell = cells[0];
        const driverCell = cells[cells.length - 1];
        if (!firstCell || !driverCell) return;

        if (hasUnpaidMarker(firstCell)) {
          applyRowStyle(row, false);
          return;
        }

        const missingDriver = isMissingDriverCell(driverCell);
        if (missingDriver) applyDriverAlert(driverCell);
        applyRowStyle(row, missingDriver);
      });
    }

    console.log('[TM] S-Rides index highlighter running...');
    scan();
    new MutationObserver(scan).observe(document.body, { childList: true, subtree: true });
    setInterval(scan, 2000);
  }

  // ============================================================
  // PART 2 — DETAIL PAGE: LiveOps Notes + EM Project card
  // ============================================================
  function getOrderId() {
    const pathMatch = location.pathname.match(/tour_transfers\/(\d{4,9})(?:[/?#]|$)/);
    if (pathMatch) return pathMatch[1];

    const bodyText = document.body.innerText || '';
    const headMatch = bodyText.match(/Transfer\s*#(\d{4,9})/i);
    if (headMatch) return headMatch[1];

    const looseMatch = bodyText.slice(0, 500).match(/#(\d{5,9})\b/);
    if (looseMatch) return looseMatch[1];

    return null;
  }

  function getCity() {
    const cityEl = document.getElementById('select2-tour_transfer_welcome_city_id-container');
    if (!cityEl) return null;
    return (cityEl.getAttribute('title') || cityEl.textContent || '')
      .replace(/[×✕]/g, '')
      .trim() || null;
  }

  function apiRequest(method, params, body) {
    return new Promise((resolve, reject) => {
      let url = SHEET_WEBAPP_URL;
      if (params) {
        const qs = new URLSearchParams(params).toString();
        url += (url.includes('?') ? '&' : '?') + qs;
      }
      GM_xmlhttpRequest({
        method,
        url,
        headers: { 'Content-Type': 'application/json' },
        data: body ? JSON.stringify(body) : undefined,
        onload: (res) => {
          try { resolve(JSON.parse(res.responseText)); }
          catch (e) { reject(e); }
        },
        onerror: reject,
        ontimeout: reject,
        timeout: 15000
      });
    });
  }

  // Welcome Pickups brand palette (see welcome-branding skill)
  const BRAND = {
    graphite: '#2E3B4D',
    turquoise: '#58C3BF',
    emerald: '#57BE8C',
    paleYellow: '#F8CF66',
    bg: '#F7F9FB',
    border: '#E4E8EE',
    font: '"Montserrat", "Helvetica Neue", Arial, -apple-system, BlinkMacSystemFont, sans-serif'
  };

  function findInsertionPoint() {
    // Preferred spot: right after the "DRIVER NOTE" field, found by its
    // visible label text.
    const labelEl = Array.from(document.querySelectorAll('label, dt, th, strong, b'))
      .find(el => /^\s*driver note\s*$/i.test(el.textContent || ''));
    if (labelEl) {
      let fieldWrapper = labelEl.closest('li, .input, .field, div');
      if (fieldWrapper && fieldWrapper.parentElement) {
        return { mode: 'after', target: fieldWrapper };
      }
    }

    // Fallback 1: the sidebar column, directly above the "Resend ..." buttons
    const resendEl = Array.from(document.querySelectorAll('a, button, input[type="submit"]'))
      .find(el => /resend/i.test(el.textContent || el.value || ''));
    if (resendEl) {
      const btnContainer = resendEl.closest('div') || resendEl.parentElement;
      if (btnContainer && btnContainer.parentElement) {
        return { mode: 'before', target: btnContainer };
      }
    }

    // Fallback 2: right below the "Back to Index" link
    const links = Array.from(document.querySelectorAll('a'));
    const backLink = links.find(a => /back to index/i.test(a.textContent || ''));
    if (backLink) {
      const container = backLink.closest('div, header, section') || backLink.parentElement;
      return { mode: 'after', target: container };
    }

    return null;
  }

  function buildNotepad(orderId) {
    const card = document.createElement('div');
    card.id = 'liveops-note-card';
    Object.assign(card.style, {
      fontFamily: BRAND.font, background: BRAND.bg, border: `1px solid ${BRAND.border}`,
      borderRadius: '8px', margin: '0 0 16px 0', overflow: 'hidden', width: '100%',
      boxSizing: 'border-box'
    });

    // --- header (click to collapse/expand) ---
    const header = document.createElement('div');
    Object.assign(header.style, {
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '10px 14px', cursor: 'pointer', userSelect: 'none',
      borderBottom: `1px solid ${BRAND.border}`
    });

    const title = document.createElement('span');
    title.textContent = `📋 LiveOps Notes — Order #${orderId}`;
    Object.assign(title.style, { color: BRAND.graphite, fontWeight: '700', fontSize: '14px' });

    const noteDot = document.createElement('span');
    Object.assign(noteDot.style, {
      display: 'none', width: '8px', height: '8px', borderRadius: '50%',
      background: BRAND.paleYellow, marginLeft: '8px'
    });
    title.appendChild(noteDot);

    const chevron = document.createElement('span');
    chevron.textContent = '▾';
    chevron.style.color = BRAND.graphite;

    // --- EM Project city info: hover button + card ---
    const cityInfoIcon = document.createElement('span');
    cityInfoIcon.textContent = 'EM Project Instructions';
    Object.assign(cityInfoIcon.style, {
      marginLeft: '10px', cursor: 'help', position: 'relative', display: 'inline-block',
      background: BRAND.paleYellow, color: BRAND.graphite, fontWeight: '700',
      fontSize: '11px', padding: '3px 10px', borderRadius: '999px'
    });
    cityInfoIcon.addEventListener('click', (e) => e.stopPropagation());

    const cityTooltip = document.createElement('div');
    Object.assign(cityTooltip.style, {
      display: 'none', position: 'absolute', top: '20px', left: '0',
      background: '#fff', border: `1px solid ${BRAND.border}`, borderRadius: '8px',
      boxShadow: '0 4px 12px rgba(0,0,0,0.15)', padding: '10px 12px', width: '260px',
      zIndex: 999999, fontSize: '12px', color: BRAND.graphite, fontFamily: BRAND.font,
      cursor: 'default'
    });
    cityInfoIcon.appendChild(cityTooltip);
    title.appendChild(cityInfoIcon);

    function renderCityInfo(data, city) {
      cityTooltip.innerHTML = '';
      const titleEl = document.createElement('div');
      titleEl.textContent = city || 'City info';
      Object.assign(titleEl.style, { fontWeight: '700', marginBottom: '6px' });
      cityTooltip.appendChild(titleEl);

      if (!data || !data.found) {
        const none = document.createElement('div');
        none.textContent = city ? 'No EM Project data for this city.' : 'Could not find the city on this page.';
        none.style.color = '#595959';
        cityTooltip.appendChild(none);
        return;
      }

      [['City Owner', data.cityOwner], ['Hero Driver', data.heroDriver], ['Notes', data.notes]]
        .forEach(([label, value]) => {
          const rowEl = document.createElement('div');
          rowEl.style.marginTop = '4px';
          const labelEl2 = document.createElement('span');
          labelEl2.textContent = label + ': ';
          labelEl2.style.fontWeight = '700';
          const valueEl = document.createElement('span');
          valueEl.textContent = value || '—';
          rowEl.appendChild(labelEl2);
          rowEl.appendChild(valueEl);
          cityTooltip.appendChild(rowEl);
        });
    }

    let cityInfoLoaded = false;
    cityInfoIcon.addEventListener('mouseenter', () => {
      cityTooltip.style.display = 'block';
      if (cityInfoLoaded) return;

      const city = getCity();
      if (!city) { renderCityInfo(null, null); return; }

      cityTooltip.innerHTML = '';
      const loading = document.createElement('div');
      loading.textContent = 'Loading city info...';
      cityTooltip.appendChild(loading);

      apiRequest('GET', { action: 'cityInfo', city })
        .then((res) => { cityInfoLoaded = true; renderCityInfo(res, city); })
        .catch(() => {
          cityTooltip.innerHTML = '';
          const err = document.createElement('div');
          err.textContent = 'Could not load city info.';
          cityTooltip.appendChild(err);
        });
    });
    cityInfoIcon.addEventListener('mouseleave', () => { cityTooltip.style.display = 'none'; });

    header.appendChild(title);
    header.appendChild(chevron);

    // --- body: task list + always-visible add row ---
    const body = document.createElement('div');
    Object.assign(body.style, { padding: '12px 14px' });

    const listEl = document.createElement('div');
    Object.assign(listEl.style, { display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '10px' });

    const loadingMsg = document.createElement('div');
    loadingMsg.textContent = 'Loading notes...';
    Object.assign(loadingMsg.style, { fontSize: '12px', color: '#595959' });
    listEl.appendChild(loadingMsg);

    // --- persistent add-note row (always at the bottom) ---
    const addRow = document.createElement('div');
    Object.assign(addRow.style, { borderTop: `1px solid ${BRAND.border}`, paddingTop: '10px' });

    const textarea = document.createElement('textarea');
    textarea.placeholder = 'Type a new LiveOps note...';
    Object.assign(textarea.style, {
      width: '100%', minHeight: '60px', border: `1px solid ${BRAND.border}`,
      borderRadius: '6px', padding: '8px 10px', fontSize: '13px',
      fontFamily: BRAND.font, color: BRAND.graphite, resize: 'vertical',
      boxSizing: 'border-box', outline: 'none', background: '#fff'
    });

    const addFooter = document.createElement('div');
    Object.assign(addFooter.style, {
      display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '8px'
    });

    const status = document.createElement('span');
    status.textContent = '';
    Object.assign(status.style, { fontSize: '12px', color: '#595959' });

    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.textContent = 'Save note';
    Object.assign(saveBtn.style, {
      background: BRAND.emerald, color: BRAND.graphite, border: 'none',
      borderRadius: '6px', padding: '7px 16px', fontSize: '13px',
      fontWeight: '700', fontFamily: BRAND.font, cursor: 'pointer'
    });

    addFooter.appendChild(status);
    addFooter.appendChild(saveBtn);
    addRow.appendChild(textarea);
    addRow.appendChild(addFooter);

    body.appendChild(listEl);
    body.appendChild(addRow);
    card.appendChild(header);
    card.appendChild(body);

    // --- insert into the page ---
    const anchor = findInsertionPoint();
    if (anchor && anchor.mode === 'before' && anchor.target && anchor.target.parentElement) {
      anchor.target.parentElement.insertBefore(card, anchor.target);
    } else if (anchor && anchor.mode === 'after' && anchor.target && anchor.target.parentElement) {
      anchor.target.parentElement.insertBefore(card, anchor.target.nextSibling);
    } else {
      document.body.prepend(card);
    }

    // --- collapse/expand ---
    header.addEventListener('click', () => {
      const collapsed = body.style.display === 'none';
      body.style.display = collapsed ? 'block' : 'none';
      chevron.textContent = collapsed ? '▾' : '▸';
    });

    // --- render one task row ---
    function renderTask(task) {
      const row = document.createElement('div');
      Object.assign(row.style, {
        display: 'flex', alignItems: 'flex-start', gap: '8px',
        background: '#fff', border: `1px solid ${BRAND.border}`,
        borderRadius: '6px', padding: '8px 10px'
      });

      const textWrap = document.createElement('div');
      Object.assign(textWrap.style, { flex: '1', minWidth: '0' });

      const noteText = document.createElement('div');
      noteText.textContent = task.note;
      Object.assign(noteText.style, { fontSize: '13px', color: BRAND.graphite, whiteSpace: 'pre-wrap', wordBreak: 'break-word' });

      const meta = document.createElement('div');
      meta.textContent = `${task.timestamp || ''}${task.timestamp && task.author ? ' — ' : ''}${task.author || ''}`;
      Object.assign(meta.style, { fontSize: '11px', color: '#8a8f98', marginTop: '4px' });

      textWrap.appendChild(noteText);
      textWrap.appendChild(meta);

      const deleteBtn = document.createElement('span');
      deleteBtn.textContent = '✕';
      Object.assign(deleteBtn.style, {
        color: '#E05252', cursor: 'pointer', fontWeight: '700', fontSize: '13px', flexShrink: '0'
      });
      deleteBtn.addEventListener('click', () => {
        deleteBtn.textContent = '…';
        apiRequest('POST', null, { action: 'delete', id: task.id })
          .then((res) => { if (res && res.ok) row.remove(); })
          .catch(() => { deleteBtn.textContent = '✕'; });
      });

      row.appendChild(textWrap);
      row.appendChild(deleteBtn);
      return row;
    }

    // --- load existing tasks ---
    function loadTasks() {
      apiRequest('GET', { action: 'list', orderId })
        .then((res) => {
          listEl.innerHTML = '';
          const tasks = (res && res.tasks) || [];
          if (!tasks.length) {
            noteDot.style.display = 'none';
            const empty = document.createElement('div');
            empty.textContent = 'No notes yet';
            Object.assign(empty.style, { fontSize: '12px', color: '#595959' });
            listEl.appendChild(empty);
            return;
          }
          noteDot.style.display = 'inline-block';
          tasks.forEach(task => listEl.appendChild(renderTask(task)));
        })
        .catch(() => {
          listEl.innerHTML = '';
          const err = document.createElement('div');
          err.textContent = 'Could not load (check Web App URL)';
          Object.assign(err.style, { fontSize: '12px', color: '#595959' });
          listEl.appendChild(err);
        });
    }

    loadTasks();

    // --- add a new note (always appends, never overwrites) ---
    saveBtn.addEventListener('click', (e) => {
      e.preventDefault();
      const note = textarea.value.trim();
      if (!note) return;
      status.textContent = 'Saving...';
      apiRequest('POST', null, { action: 'add', orderId, note, author: AUTHOR_NAME })
        .then(() => {
          textarea.value = '';
          status.textContent = 'Saved ✓ ' + new Date().toLocaleTimeString();
          loadTasks();
        })
        .catch(() => { status.textContent = 'Save failed — check Web App URL'; });
    });
  }

  function initNotepad() {
    const orderId = getOrderId();
    if (!orderId) {
      console.log('[TM] Notepad: no order ID found on this page.');
      return;
    }
    buildNotepad(orderId);

    let attempts = 0;
    const relocate = setInterval(() => {
      attempts++;
      const anchor = findInsertionPoint();
      if (anchor && anchor.mode === 'before' && anchor.target && anchor.target.parentElement) {
        const card = document.getElementById('liveops-note-card');
        if (card) {
          anchor.target.parentElement.insertBefore(card, anchor.target);
        }
        clearInterval(relocate);
      }
      if (attempts >= 10) clearInterval(relocate);
    }, 500);
  }

  // ============================================================
  // PART 3 — DETAIL PAGE: "Copy ride info" button
  // Reads Date / Time / From / To / Pax / Price (provider cost) from the
  // linked Welcome Order (green logo link) and copies it to the clipboard.
  // ============================================================
  function initRideInfoCopier() {
    const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    const CURRENCY = { EUR: '€', USD: '$', GBP: '£' };

    function readRow(doc, key) {
      const row = doc.querySelector('tr.row-' + key);
      if (!row || !row.children[1]) return '';
      const val = row.children[1].textContent.trim().replace(/\s+/g, ' ');
      return val === 'Empty' ? '' : val;
    }

    function extract(doc, duration) {
      // "October 11, 2026 05:00" -> "11/10/2026" + "05:00"
      const dt = readRow(doc, 'from_datetime');
      const m = dt.match(/^(\w+)\s+(\d{1,2}),\s*(\d{4})\s+(\d{1,2}:\d{2})$/);
      const pad = (n) => String(n).padStart(2, '0');
      const date = m && MONTHS.includes(m[1])
        ? pad(m[2]) + '/' + pad(MONTHS.indexOf(m[1]) + 1) + '/' + m[3]
        : dt;
      const time = m ? m[4] : '';

      const cost = readRow(doc, 'provider_cost');
      const cur = readRow(doc, 'currency_code');
      const price = cost ? String(parseFloat(cost)) + ' ' + (CURRENCY[cur] || cur || '€') : '';

      return [
        'Date: ' + date,
        'Time: ' + time,
        'Duration: ' + (duration || ''),
        'From: ' + (readRow(doc, 'from_address') || readRow(doc, 'from_location')),
        'To: ' + (readRow(doc, 'to_address') || readRow(doc, 'service') || readRow(doc, 'title')),
        'Pax: ' + readRow(doc, 'number_of_passengers'),
        'Price ' + price,
      ].join('\n');
    }

    // The Accept header is required: without it the CRM redirects background requests to the Dashboard
    const FETCH_OPTS = { credentials: 'same-origin', headers: { Accept: 'text/html,application/xhtml+xml' } };

    async function getText() {
      const link = document.querySelector('#page_title a[href*="/admin/welcome_orders/"]');
      if (!link) throw new Error('Could not find the Welcome Order link on this page.');
      const res = await fetch(link.href, FETCH_OPTS);
      if (!res.ok) throw new Error('Could not open the order (HTTP ' + res.status + ')');
      const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
      if (!doc.querySelector('tr.row-from_datetime')) {
        throw new Error('The order page did not load correctly (got "' + doc.title + '"). Try reloading the page.');
      }

      // Duration lives on the Service page (the "Service" link on the order page)
      let duration = '';
      const serviceLink = doc.querySelector('tr.row-service a[href]');
      if (serviceLink) {
        try {
          const sRes = await fetch(new URL(serviceLink.getAttribute('href'), location.origin).href, FETCH_OPTS);
          const sDoc = new DOMParser().parseFromString(await sRes.text(), 'text/html');
          duration = readRow(sDoc, 'duration');
        } catch (e) { /* leave duration empty if the service page fails */ }
      }
      return extract(doc, duration);
    }

    function showPanel(text) {
      let box = document.getElementById('wp-ride-info-box');
      if (!box) {
        box = document.createElement('div');
        box.id = 'wp-ride-info-box';
        Object.assign(box.style, {
          position: 'fixed', bottom: '20px', right: '20px', zIndex: 99999,
          background: '#fff', border: `2px solid ${BRAND.emerald}`, borderRadius: '8px',
          padding: '12px 14px', fontFamily: BRAND.font, fontSize: '13px', lineHeight: '1.5',
          color: BRAND.graphite, boxShadow: '0 4px 16px rgba(0,0,0,.15)',
          maxWidth: '420px', whiteSpace: 'pre-wrap'
        });
        document.body.appendChild(box);
      }
      box.textContent = text;
      const foot = document.createElement('div');
      Object.assign(foot.style, { marginTop: '8px', textAlign: 'right', whiteSpace: 'normal' });
      foot.innerHTML = `<span style="color:${BRAND.emerald}">✓ copied</span> &nbsp; <a href="#">close</a>`;
      foot.querySelector('a').onclick = (e) => { e.preventDefault(); box.remove(); };
      box.appendChild(foot);
    }

    const pageTitle = document.getElementById('page_title');
    if (!pageTitle || document.getElementById('wp-ride-info-btn')) return;

    const btn = document.createElement('button');
    btn.id = 'wp-ride-info-btn';
    btn.type = 'button';
    btn.textContent = 'Copy ride info';
    Object.assign(btn.style, {
      marginLeft: '10px', padding: '4px 10px', background: BRAND.emerald, color: BRAND.graphite,
      border: 'none', borderRadius: '6px', fontSize: '13px', fontWeight: '700',
      fontFamily: BRAND.font, cursor: 'pointer', verticalAlign: 'middle'
    });
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      btn.textContent = 'Loading…';
      try {
        const text = await getText();
        GM_setClipboard(text, 'text');
        showPanel(text);
      } catch (err) {
        alert(err.message);
      }
      btn.textContent = 'Copy ride info';
    });
    pageTitle.appendChild(btn);
  }

  // ============================================================
  // ROUTER
  // ============================================================
  const isIndexPage = /tour_transfers\/index_v2/.test(location.href);
  if (isIndexPage) {
    initIndexHighlighter();
  } else {
    initNotepad();
    initRideInfoCopier();
  }
})();
