/*!
 * forge-feedback.js v1.0.0
 * Renders the "Connect → Forge" pricing feedback form and records the answer via Google Tag Manager.
 * No dependencies. Works as a plain <script> (window.ForgeFeedback) or CommonJS module.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.ForgeFeedback = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var TESTING = false; // Set to true to test in a non-Connect iframe (fakes 50 users)
  var VERSION = '1.0.0';
  var instanceCounter = 0;
  var stylesInjected = false;
  var domain = "";

  /* ------------------------------------------------------------------ */
  /* Defaults                                                            */
  /* ------------------------------------------------------------------ */

  var DEFAULTS = {
    container: null,              // Element or CSS selector (required)
    pricePerUser: 9,              // USD per user per month
    currency: 'USD',
    locale: undefined,            // e.g. 'en-US'; undefined = browser default
    percentages: [4, 2, 1, 0],    // Preset options, shown after the custom "X%" option
    allowCustom: true,
    customMin: 0,
    customMax: 100,
    showComment: false,           // Optional free-text field
    commentMaxLength: 500,

    // Google Tag Manager / gtag
    transport: 'gtag',       // 'dataLayer' (GTM) or 'gtag' (gtag.js only)
    eventName: 'forge_migration_feedback',
    eventTimeout: 2000,           // ms to wait for GTM's callback before resolving anyway
    metadata: {},                 // Extra fields merged into the pushed payload

    // User counting
    usersPageSize: 50,
    cacheUserCountMinutes: 60,    // sessionStorage cache; 0 disables

    // Submission memory
    rememberSubmission: true,
    storageKey: 'forge_feedback_submitted_v9' ,

    // Callbacks
    onSubmit: null,               // (payload) => void, after the event was sent
    onError: null,                // (error) => void

    texts: {}
  };

  var DEFAULT_TEXTS = {
    title: '',
    intro: [
      'Due to Connect apps being sunset, we are forced to move this app to Forge.',
      'It cannot run without costs there.'
    ],
    question: 'Would you be willing to pay only a small fraction of your Atlassian cost to support us?',
    customSuffix: '% of Atlassian cost',
    percentLabel: '{p}% of Atlassian cost',
    zeroLabel: '0 - not willing to pay',
    perMonth: '~ {amount} / month',
    calculating: 'Calculating your Atlassian cost…',
    costSummary: 'Based on {users} users ~ {price} per user per month = {total} per month.',
    descriptionTitle: 'What the new app will look like',
    description: 'The new app will be a custom field, added in the same view as the issue context. ' +
      'It comes with an admin panel to specify the projects where you need it. ' +
      'When clicked, it displays the duration for all columns.',
    featuresTitle: 'Other features',
    features: [
      'A reporting page where you can build reports from the automatic metrics we create, such as ' +
        'durations of issues in each status, time members spent in each status, entrance counts, transitions and more.',
      'Dashboards built from the reports you create.',
      'Per-report calendars, working hours and holidays.'
    ],
    more: 'Much more will come.',
    commentLabel: 'Anything else you would like to tell us? (optional)',
    submit: 'Send feedback',
    sending: 'Sending…',
    thanks: 'Thank you! Your feedback has been recorded.',
    alreadySubmitted: 'Thank you, you have already sent your feedback.',
    invalidCustom: 'Please enter a percentage between {min} and {max}.',
    sendError: 'Something went wrong while sending your feedback. Please try again.'
  };

  /* ------------------------------------------------------------------ */
  /* Small helpers                                                       */
  /* ------------------------------------------------------------------ */

  function fmt(str, vars) {
    return String(str).replace(/\{(\w+)\}/g, function (m, k) {
      return vars && vars[k] != null ? vars[k] : m;
    });
  }

  function round2(n) { return Math.round(n * 100) / 100; }

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v == null || v === false) return;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k.indexOf('on') === 0) node.addEventListener(k.slice(2), v);
        else node.setAttribute(k, v === true ? '' : v);
      });
    }
    (children || []).forEach(function (c) {
      if (c == null) return;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return node;
  }

  function safeStorage(type) {
    try {
      var s = window[type];
      var probe = '__ff_probe__';
      s.setItem(probe, '1'); s.removeItem(probe);
      return s;
    } catch (e) { return null; } // Storage can be blocked in third-party iframes
  }

  /* ------------------------------------------------------------------ */
  /* Atlassian API: count billable human users                           */
  /* ------------------------------------------------------------------ */

  // Uses AP.request inside a Connect iframe; falls back to same-origin fetch otherwise.
  function getJson(url) {
    if (window.AP && typeof window.AP.request === 'function') {
      return new Promise(function (resolve, reject) {
        window.AP.request({
          url: url,
          type: 'GET',
          contentType: 'application/json',
          headers: { Accept: 'application/json' },
          success: function (body) {
            try { resolve(typeof body === 'string' ? JSON.parse(body) : body); }
            catch (e) { reject(e); }
          },
          error: function (xhr, status, err) {
            reject(new Error('AP.request failed (' + (xhr && xhr.status) + '): ' + (err || status || 'unknown')));
          }
        });
      });
    }
    return TESTING ? new Promise(function (resolve) { resolve([{username:'a',accountType:'atlassian', active:true }]); }) : fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + url);
        return r.json();
      });
  }

  function canShowFeedback() {
    if(TESTING)
      return new Promise(function (resolve, reject) {resolve(true);});
    return new Promise(function (resolve, reject) {
      if (!window.AP || !window.AP.user || typeof window.AP.user.getCurrentUser !== 'function') {
        reject(new Error('AP.user.getCurrentUser is not available'));
        return;
      }

      try {
        window.AP.user.getCurrentUser(function (user) {
          if (!user || !user.atlassianAccountId) {
            reject(new Error('Could not get the current Atlassian account ID'));
            return;
          }

          getJson('/rest/api/3/user/groups?accountId=' + encodeURIComponent(user.atlassianAccountId))
            .then(function (groups) {
              if (!Array.isArray(groups)) {
                reject(new Error('Invalid response when getting the current user groups'));
                return;
              }

              resolve(groups.some(function (group) {
                if (!group || typeof group.name !== 'string') return false;
                var tmpRes1= group.name === 'org-admins' ||
                  group.name === 'site-admins' ||
                  group.name === 'administrators' ||
                  group.name === 'jira-administrators' ||
                  group.name === 'jira-project-managers' ||
                  (group.name.indexOf('jira-admins-') === 0 && group.name.length > 'jira-admins-'.length);
                return tmpRes1;
              }));
            }, reject);
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  // accountType: 'atlassian' = human; 'app' = bots, integrations and AI agents (e.g. Rovo);
  // 'customer' = JSM portal customers (not billed). Inactive users are not billed either.
  function isBillableHuman(u) {
    return !!u && u.accountType === 'atlassian' && u.active !== false;
  }

  function countBillableUsers(pageSize) {
    var total = 0, startAt = 0, page = 0;
    function next() {
      var url = '/rest/api/3/user/search?query=&startAt=' + startAt + '&maxResults=' + pageSize;
      return getJson(url).then(function (users) {
        if (!Array.isArray(users) || users.length === 0) return total;
        for (var i = 0; i < users.length; i++) {
           domain = users[i].self;
           if (isBillableHuman(users[i])) 
            total++;
        }
        startAt += users.length;
        page++;
        // Keep going until an empty page: this endpoint can return short pages before the end.
        return users.length === pageSize ? next() : total;
      });
    }
    return next();
  }

  function getUserCount(cfg) {
    var cacheKey = DEFAULTS.storageKey;
    var store = cfg.cacheUserCountMinutes > 0 ? safeStorage('sessionStorage') : null;
    if (store) {
      try {
        var cached = JSON.parse(store.getItem(cacheKey) || 'null');
        if (cached && Date.now() - cached.ts < cfg.cacheUserCountMinutes * 60000) {
          return Promise.resolve(cached.count);
        }
      } catch (e) { /* ignore corrupt cache */ }
    }
    var p = countBillableUsers(cfg.usersPageSize);
    return p.then(function (count) {
      count = Number(count);
      if (!isFinite(count) || count < 0) throw new Error('Invalid user count: ' + count);
      if (store) store.setItem(cacheKey, JSON.stringify({ count: count, ts: Date.now() }));
      return count;
    });
  }

  /* ------------------------------------------------------------------ */
  /* Google Tag Manager / gtag                                           */
  /* ------------------------------------------------------------------ */

  function sendToGoogle(cfg, payload) {
    return new Promise(function (resolve) {
      var done = false;
      function finish() { if (!done) { done = true; resolve(); } }
      setTimeout(finish, cfg.eventTimeout); // Don't hang if GTM is blocked or slow

      if (cfg.transport === 'gtag') {
        if (typeof window.gtag !== 'function') throw new Error('gtag() is not available on the page');
        window.gtag('event', cfg.eventName, Object.assign({}, payload, {
          event_callback: finish,
          event_timeout: cfg.eventTimeout
        }));
      } else {
        window.dataLayer = window.dataLayer || [];
        window.dataLayer.push(Object.assign({ event: cfg.eventName }, payload, {
          eventCallback: finish,
          eventTimeout: cfg.eventTimeout
        }));
      }
    });
  }

  /* ------------------------------------------------------------------ */
  /* Styles (scoped under .ff)                                           */
  /* ------------------------------------------------------------------ */

  var CSS = [
    '.ff-overlay{position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;',
    'padding:20px;background:rgba(9,30,66,.55);}',
    '.ff{position:relative;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;',
    'color:#172B4D;font-size:14px;line-height:1.5;width:100%;max-width:720px;max-height:100%;overflow-y:auto;',
    'padding:48px 24px 24px;background:#fff;border-radius:8px;box-shadow:0 8px 32px rgba(9,30,66,.3);box-sizing:border-box}',
    '.ff *{box-sizing:border-box}',
    '.ff-close{position:absolute;top:12px;right:12px;width:32px;height:32px;padding:0;border:0;border-radius:4px;',
    'background:transparent;color:#44546F;font:24px/1 Arial,sans-serif;cursor:pointer}',
    '.ff-close:hover{background:#F1F2F4;color:#172B4D}',
    '.ff-close:focus-visible{outline:2px solid #388BFF;outline-offset:2px}',
    '.ff-launcher{position:fixed;right:20px;bottom:20px;z-index:9999;width:25px;height:25px;padding:0;',
    'border:0;border-radius:50%;background:#FFAB00;color:#172B4D;font:bold 15px/25px Arial,sans-serif;',
    'text-align:center;cursor:pointer;box-shadow:0 4px 12px rgba(9,30,66,.3)}',
    '.ff-launcher:hover{background:#FFC400;transform:scale(1.06)}',
    '.ff-launcher:focus-visible{outline:3px solid #0C66E4;outline-offset:3px}',
    '.ff h2{font-size:20px;margin:0 0 12px}',
    '.ff h3{font-size:15px;margin:20px 0 6px}',
    '.ff p{margin:0 0 8px}',
    '.ff-question{font-weight:600;margin-top:16px}',
    '.ff-cost{color:#626F86;font-size:12px;margin:2px 0 10px;min-height:18px}',
    '.ff-options{display:flex;flex-wrap:wrap;gap:8px;border:0;padding:0;margin:0}',
    '.ff-option{flex:1 1 140px;display:flex;flex-direction:column;gap:2px;padding:10px 12px;',
    'border:2px solid #DCDFE4;border-radius:6px;cursor:pointer;background:#fff;transition:border-color .15s,background .15s}',
    '.ff-option:hover{border-color:#8590A2}',
    '.ff-option.is-selected{border-color:#0C66E4;background:#E9F2FF}',
    '.ff-option input[type=radio]{position:absolute;opacity:0;pointer-events:none}',
    '.ff-option:focus-within{outline:2px solid #388BFF;outline-offset:2px}',
    '.ff-option-title{font-weight:600;display:flex;align-items:center;gap:4px;flex-wrap:wrap}',
    '.ff-option-amount{color:#44546F;font-size:12px;min-height:18px}',
    '.ff-custom-input{width:64px;padding:3px 6px;border:1px solid #8590A2;border-radius:4px;font:inherit}',
    '.ff-error{color:#AE2E24;font-size:12px;margin-top:6px;min-height:18px}',
    '.ff ul{margin:4px 0 8px;padding-left:20px}',
    '.ff li{margin-bottom:4px}',
    '.ff textarea{width:100%;min-height:72px;padding:8px;border:1px solid #8590A2;border-radius:4px;font:inherit;resize:vertical}',
    '.ff-submit{margin-top:16px;padding:8px 16px;border:0;border-radius:4px;background:#0C66E4;color:#fff;',
    'font:inherit;font-weight:600;cursor:pointer}',
    '.ff-submit:hover:not(:disabled){background:#0055CC}',
    '.ff-submit:disabled{background:#DCDFE4;color:#8590A2;cursor:not-allowed}',
    '.ff-done{padding:16px;border-radius:6px;background:#DCFFF1;color:#164B35;font-weight:600}'
  ].join('');

  function injectStyles() {
    if (stylesInjected) return;
    document.head.appendChild(el('style', { 'data-forge-feedback': VERSION, text: CSS }));
    stylesInjected = true;
  }

  /* ------------------------------------------------------------------ */
  /* Form                                                                */
  /* ------------------------------------------------------------------ */

  function create(options) {
    options = options || {};
    var instance = null;
    var destroyed = false;
    var ready = canShowFeedback().then(function (allowed) {
      if (!allowed || destroyed) return null;
      instance = createAuthorized(options);
      return instance;
    }).catch(function (err) {
      if (typeof options.onError === 'function') options.onError(err);
      else if (window.console) console.error('[ForgeFeedback] Could not verify feedback access:', err);
      return null;
    });

    return {
      version: VERSION,
      ready: ready,
      getState: function () {
        return instance ? instance.getState() : {
          userCount: null,
          monthlyCost: null,
          loadingCost: true,
          selected: null,
          customValue: ''
        };
      },
      refreshUserCount: function () {
        return ready.then(function (api) {
          return api ? api.refreshUserCount() : undefined;
        });
      },
      destroy: function () {
        destroyed = true;
        if (instance) instance.destroy();
      }
    };
  }

  function createAuthorized(options) {
    options = options || {};
    var cfg = Object.assign({}, DEFAULTS, options);
    var t = Object.assign({}, DEFAULT_TEXTS, options.texts || {});
    var container = typeof cfg.container === 'string' ? document.querySelector(cfg.container) : cfg.container;
    if (!container) throw new Error('ForgeFeedback: container not found');

    injectStyles();

    var uid = 'ff' + (++instanceCounter);
    var localStore = cfg.rememberSubmission ? safeStorage('localStorage') : null;
    var dismissedStore = safeStorage('localStorage') || safeStorage('sessionStorage');
    var dismissedKey = cfg.storageKey + '_dismissed';
    var state = { userCount: null, monthlyCost: null, loadingCost: true, selected: null, customValue: '' };
    var money = new Intl.NumberFormat(cfg.locale, { style: 'currency', currency: cfg.currency });
    var content = el('div');
    var root = el('div', {
      class: 'ff',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': t.title || 'Feedback form',
      tabindex: '-1'
    }, [
      el('button', {
        type: 'button',
        class: 'ff-close',
        'aria-label': 'Close feedback form',
        title: 'Close',
        onclick: function () { closeOverlay(true); }
      }, ['x']),
      content
    ]);
    var overlay = el('div', { class: 'ff-overlay' }, [root]);
    var launcher = null;
    var previousMinHeights = null;

    function closeOverlay(saveDismissal) {
      if (saveDismissal !== false && dismissedStore) {
        try { dismissedStore.setItem(dismissedKey, String(Date.now())); }
        catch (e) {
          if (window.console) console.warn('[ForgeFeedback] Could not save dismissed state:', e);
        }
      }
      overlay.removeEventListener('click', onBackdropClick);
      document.removeEventListener('keydown', onKeyDown);
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      if (previousMinHeights) {
        document.documentElement.style.minHeight = previousMinHeights.html;
        document.body.style.minHeight = previousMinHeights.body;
        previousMinHeights = null;
      }
    }

    function openOverlay() {
      if (overlay.parentNode) return;
      previousMinHeights = {
        html: document.documentElement.style.minHeight,
        body: document.body.style.minHeight
      };
      document.documentElement.style.minHeight = '450px';
      document.body.style.minHeight = '450px';
      document.body.appendChild(overlay);
      overlay.addEventListener('click', onBackdropClick);
      document.addEventListener('keydown', onKeyDown);
    }

    function onBackdropClick(e) {
      if (e.target === overlay) closeOverlay(true);
    }

    function onKeyDown(e) {
      if (e.key === 'Escape') closeOverlay(true);
    }

    // Already answered on this browser?
    if (localStore && localStore.getItem(cfg.storageKey)) {
      return publicApi();
    }

    launcher = el('button', {
      type: 'button',
      class: 'ff-launcher',
      'aria-label': 'Open feedback form',
      title: 'Your feedback is important to us',
      onclick: openOverlay
    }, ['!']);
    document.body.appendChild(launcher);

    /* ---- Build the DOM ---- */
    var amountNodes = {};
    var optionLabels = [];
    var costNode = el('div', { class: 'ff-cost', 'aria-live': 'polite', text: t.calculating });
    var errorNode = el('div', { class: 'ff-error', 'aria-live': 'polite' });
    var submitBtn = el('button', { type: 'submit', class: 'ff-submit', disabled: true, text: t.submit });
    var commentNode = cfg.showComment
      ? el('textarea', { id: uid + '-comment', maxlength: String(cfg.commentMaxLength) })
      : null;

    function makeOption(key, titleChildren) {
      var radio = el('input', { type: 'radio', name: uid + '-choice', value: key, onchange: onSelect });
      var amount = el('span', { class: 'ff-option-amount' });
      amountNodes[key] = amount;
      var label = el('label', { class: 'ff-option' }, [
        radio,
        el('span', { class: 'ff-option-title' }, titleChildren),
        amount
      ]);
      label._radio = radio;
      optionLabels.push(label);
      return label;
    }

    var customInput = null;
    var optionsSet = el('fieldset', { class: 'ff-options' }, [el('legend', { class: 'ff-question', text: t.question })]);
    // Legend renders oddly inside a flex fieldset in some browsers, so show the question separately.
    optionsSet.firstChild.style.cssText = 'position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)';

    if (cfg.allowCustom) {
      customInput = el('input', {
        type: 'number', class: 'ff-custom-input', min: String(cfg.customMin), max: String(cfg.customMax),
        step: '0.5', placeholder: 'X', 'aria-label': 'Custom percentage',
        onfocus: function () { selectKey('custom'); },
        oninput: function () { state.customValue = customInput.value; selectKey('custom'); refresh(); }
      });
      optionsSet.appendChild(makeOption('custom', [customInput, t.customSuffix]));
    }
    cfg.percentages.forEach(function (p) {
      optionsSet.appendChild(makeOption(String(p), [p === 0 ? t.zeroLabel : fmt(t.percentLabel, { p: p })]));
    });

    var form = el('form', { novalidate: true, onsubmit: onSubmit }, [
      t.title ? el('h2', { text: t.title }) : null,
      el('div', null, t.intro.map(function (line) { return el('p', { text: line }); })),
      el('p', { class: 'ff-question', text: t.question }),
      costNode,
      optionsSet,
      errorNode,
      el('h3', { text: t.descriptionTitle }),
      el('p', { text: t.description }),
      el('h3', { text: t.featuresTitle }),
      el('ul', null, t.features.map(function (f) { return el('li', { text: f }); })),
      el('p', { text: t.more }),
      commentNode ? el('label', { for: uid + '-comment' }, [el('h3', { text: t.commentLabel })]) : null,
      commentNode,
      submitBtn
    ]);
    content.appendChild(form);

    /* ---- Behaviour ---- */
    function selectKey(key) {
      state.selected = key;
      optionLabels.forEach(function (l) {
        var on = l._radio.value === key;
        l._radio.checked = on;
        l.classList.toggle('is-selected', on);
      });
      refresh();
    }

    function onSelect(e) {
      selectKey(e.target.value);
      if (e.target.value === 'custom' && customInput) customInput.focus();
    }

    function customPercent() {
      if (state.customValue === '') return null;
      var v = Number(state.customValue);
      return isFinite(v) && v >= cfg.customMin && v <= cfg.customMax ? v : NaN;
    }

    function selectedPercent() {
      if (state.selected == null) return null;
      if (state.selected === 'custom') {
        var v = customPercent();
        return v == null || isNaN(v) ? null : v;
      }
      return Number(state.selected);
    }

    function amountText(p) {
      if (state.monthlyCost == null || p == null || isNaN(p) || p === 0) return '';
      return fmt(t.perMonth, { amount: money.format(round2(state.monthlyCost * p / 100)) });
    }

    function refresh() {
      Object.keys(amountNodes).forEach(function (key) {
        var p = key === 'custom' ? customPercent() : Number(key);
        amountNodes[key].textContent = amountText(p);
      });

      if (state.loadingCost) costNode.textContent = t.calculating;
      else if (state.monthlyCost != null) {
        costNode.textContent = fmt(t.costSummary, {
          users: state.userCount.toLocaleString(cfg.locale),
          price: money.format(cfg.pricePerUser),
          total: money.format(state.monthlyCost)
        });
      } else costNode.textContent = '';

      var badCustom = state.selected === 'custom' && isNaN(customPercent());
      errorNode.textContent = badCustom ? fmt(t.invalidCustom, { min: cfg.customMin, max: cfg.customMax }) : '';
      submitBtn.disabled = selectedPercent() == null;
    }

    function loadCost() {
      state.loadingCost = true;
      refresh();
      return getUserCount(cfg).then(function (count) {
        state.userCount = count;
        state.monthlyCost = round2(count * cfg.pricePerUser);
      }).catch(function (err) {
        // The form still works without amounts; only the dollar values are hidden.
        state.userCount = null;
        state.monthlyCost = null;
        if (typeof cfg.onError === 'function') cfg.onError(err);
        else if (window.console) console.warn('[ForgeFeedback] Could not calculate Atlassian cost:', err);
      }).then(function () {
        state.loadingCost = false;
        refresh();
      });
    }

    function buildPayload(pct) {
      var choice = state.selected === 'custom' ? 'custom' : (pct === 0 ? 'decline' : 'preset');
      var tmpComment = commentNode ? commentNode.value.trim() : '';
      tmpComment = domain + " " + tmpComment;
      return Object.assign({
        feedback_choice: choice,
        feedback_percent: pct,
        feedback_monthly_amount: state.monthlyCost == null ? null : round2(state.monthlyCost * pct / 100),
        feedback_currency: cfg.currency,
        feedback_user_count: state.userCount,
        feedback_atlassian_monthly_cost: state.monthlyCost,
        feedback_price_per_user: cfg.pricePerUser,
        feedback_comment: tmpComment,
        feedback_form_version: VERSION
      }, cfg.metadata || {});
    }

    function onSubmit(e) {
      e.preventDefault();
      var pct = selectedPercent();
      if (pct == null) { refresh(); return; }

      var payload = buildPayload(pct);
      submitBtn.disabled = true;
      submitBtn.textContent = t.sending;

      Promise.resolve()
        .then(function () { return sendToGoogle(cfg, payload); })
        .then(function () {
          if (localStore) localStore.setItem(cfg.storageKey, String(Date.now()));
          if (launcher && launcher.parentNode) launcher.parentNode.removeChild(launcher);
          content.innerHTML = '';
          content.appendChild(el('div', { class: 'ff-done', role: 'status', text: t.thanks }));
          if (typeof cfg.onSubmit === 'function') cfg.onSubmit(payload);
        })
        .catch(function (err) {
          submitBtn.textContent = t.submit;
          submitBtn.disabled = false;
          errorNode.textContent = t.sendError;
          if (typeof cfg.onError === 'function') cfg.onError(err);
          else if (window.console) console.error('[ForgeFeedback] Send failed:', err);
        });
    }

    if (!dismissedStore || !dismissedStore.getItem(dismissedKey)) openOverlay();
    loadCost();
    return publicApi();

    function publicApi() {
      return {
        version: VERSION,
        getState: function () { return Object.assign({}, state); },
        refreshUserCount: function () {
          var s = safeStorage('sessionStorage');
          if (s) s.removeItem('forge_feedback_user_count_v1');
          return typeof loadCost === 'function' ? loadCost() : Promise.resolve();
        },
        destroy: function () {
          closeOverlay(false);
          if (launcher && launcher.parentNode) launcher.parentNode.removeChild(launcher);
        }
      };
    }
  }

  return {
    version: VERSION,
    create: create,
    countBillableUsers: countBillableUsers, // exposed for testing / reuse
    isBillableHuman: isBillableHuman,
    resetSubmission: function (key) {
      var s = safeStorage('localStorage');
      if (s) {
        var storageKey = key || DEFAULTS.storageKey;
        s.removeItem(storageKey);
        s.removeItem(storageKey + '_dismissed');
      }
    }
  };
});

ForgeFeedback.create({
  container: '#forge-feedback',
  showComment: true,
  transport: 'gtag',
  metadata: { feedback_app: 'time-in-status' } // anything you want to segment by
});
