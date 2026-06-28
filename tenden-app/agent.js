/**
 * TENDEN Agent — アシスタント表示レイヤ
 * 開発者は assets/agent/manifest.json とアセットを差し替えるだけでアニメーションを統合できます。
 */
(function () {
  'use strict';

  const TENDEN_AGENT_STATES = Object.freeze({
    idle: 'idle',
    search: 'search',
    halt: 'halt',
    'route-plan': 'route-plan',
    navigate: 'navigate',
    broadcast: 'broadcast',
    destination: 'destination',
    'ar-demo': 'ar-demo',
    'evac-active': 'evac-active',
    directing: 'directing',
    'high-ground': 'high-ground',
    monitor: 'monitor',
    scout: 'scout',
    'safety-share': 'safety-share',
    urgent: 'urgent',
    synced: 'synced',
    'night-alert': 'night-alert',
    flood: 'flood',
    checkin: 'checkin',
    'watch-coast': 'watch-coast'
  });

  /** @deprecated 旧6状態名 → 新20状態への互換マップ */
  const LEGACY_STATE_ALIASES = Object.freeze({
    listening: 'search',
    thinking: 'route-plan',
    alert: 'broadcast',
    celebrate: 'synced',
    warn: 'navigate'
  });

  /** アプリ機能キー → エージェント状態ID */
  const AGENT_FEATURE_MAP = Object.freeze({
    default: 'idle',
    idle: 'idle',
    'app-init': 'idle',
    onboarding: 'idle',
    'onboarding-intro': 'idle',
    'onboarding-quake': 'broadcast',
    'onboarding-routes': 'route-plan',
    'onboarding-flow': 'evac-active',
    'onboarding-complete': 'synced',
    'onboarding-demo': 'ar-demo',
    'demo-mode': 'ar-demo',
    'model-preview': 'ar-demo',
    'location-fetch': 'search',
    'gps-acquiring': 'search',
    'p2p-connecting': 'search',
    'location-synced': 'synced',
    'p2p-connected': 'synced',
    'route-calc': 'route-plan',
    'route-loading': 'route-plan',
    'ai-route': 'route-plan',
    'tenden-loading': 'route-plan',
    'coast-dist': 'navigate',
    'model-area': 'navigate',
    compass: 'navigate',
    emergency: 'broadcast',
    'p2p-alert': 'broadcast',
    triggerEmergencyMode: 'broadcast',
    'emergency-active': 'urgent',
    'urgent-evac': 'urgent',
    'countdown-mode': 'urgent',
    'safe-zone': 'destination',
    'shelter-arrival': 'destination',
    'evac-complete': 'destination',
    'evac-active': 'evac-active',
    'evac-playback': 'evac-active',
    'route-guidance': 'directing',
    'nav-active': 'directing',
    elevation: 'high-ground',
    'tsunami-countdown': 'high-ground',
    'quake-panel': 'monitor',
    'hazard-watch': 'monitor',
    'coast-scout': 'scout',
    'hazard-survey': 'scout',
    'safety-share': 'safety-share',
    'share-status': 'safety-share',
    'night-alert': 'night-alert',
    'drill-mode': 'night-alert',
    'low-visibility': 'night-alert',
    'hazard-layer': 'flood',
    'flood-layer': 'flood',
    inundation: 'flood',
    'report-submit': 'checkin',
    checkin: 'checkin',
    'tsunami-map': 'watch-coast',
    'coast-watch': 'watch-coast',
    'jma-link': 'watch-coast',
    'danger-zone': 'halt',
    inundated: 'halt',
    'bubble-info': 'idle',
    'bubble-success': 'synced',
    'bubble-warning': 'halt',
    'bubble-error': 'halt',
    'bubble-copied': 'checkin'
  });

  const MANIFEST_URL = 'assets/agent/manifest.json';
  /** Cache-bust for sprite PNGs (bump with app.js / sw.js) */
  const AGENT_ASSET_BUST = 'v147';
  const DEFAULT_MANIFEST = {
    version: 3,
    defaultState: 'idle',
    size: { width: 84, height: 96 },
    states: {}
  };

  let manifest = DEFAULT_MANIFEST;
  let currentState = TENDEN_AGENT_STATES.idle;
  let currentFeature = 'default';
  let revertTimer = null;
  let bubbleHideTimer = null;
  let bubbleExitTimer = null;
  let assetNodes = {};
  let initialized = false;
  let reducedMotion = false;

  const BUBBLE_VISIBLE_MS = 4500;
  const BUBBLE_EXIT_MS = 350;

  function $(id) {
    return document.getElementById(id);
  }

  function getRoot() {
    return $('tenden-agent');
  }

  function getVisualHost() {
    return document.querySelector('#tenden-agent .tenden-agent-visual');
  }

  function getMessageEl() {
    return $('tenden-agent-message');
  }

  function getBubbleEl() {
    return $('tenden-agent-bubble');
  }

  function getBubbleTextEl() {
    return $('tenden-agent-bubble-text');
  }

  function getBubbleDismissEl() {
    return $('tenden-agent-bubble-dismiss');
  }

  function getBubbleActionsEl() {
    return $('tenden-agent-bubble-actions');
  }

  function resolveStateId(stateOrFeature) {
    if (!stateOrFeature) return null;
    if (AGENT_FEATURE_MAP[stateOrFeature]) return AGENT_FEATURE_MAP[stateOrFeature];
    if (LEGACY_STATE_ALIASES[stateOrFeature]) return LEGACY_STATE_ALIASES[stateOrFeature];
    if (TENDEN_AGENT_STATES[stateOrFeature]) return stateOrFeature;
    return null;
  }

  function clearBubbleTimers() {
    if (bubbleHideTimer) {
      clearTimeout(bubbleHideTimer);
      bubbleHideTimer = null;
    }
    if (bubbleExitTimer) {
      clearTimeout(bubbleExitTimer);
      bubbleExitTimer = null;
    }
  }

  function readReducedMotion() {
    reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const root = getRoot();
    if (root) root.classList.toggle('tenden-agent--reduced-motion', reducedMotion);
  }

  function stateClass(state) {
    return 'tenden-agent--' + state;
  }

  function clearRevertTimer() {
    if (revertTimer) {
      clearTimeout(revertTimer);
      revertTimer = null;
    }
  }

  function allStateClasses() {
    const ids = new Set(Object.keys(TENDEN_AGENT_STATES));
    Object.keys(LEGACY_STATE_ALIASES).forEach(function (k) { ids.add(k); });
    if (manifest && manifest.states) {
      Object.keys(manifest.states).forEach(function (k) { ids.add(k); });
    }
    return Array.from(ids).map(stateClass);
  }

  /**
   * @param {string} stateOrFeature 状態ID・機能キー・旧状態名
   * @param {string} [message]
   * @param {{ revertTo?: string, revertMs?: number, persist?: boolean, feature?: string }} [options]
   */
  function setAgentState(stateOrFeature, message, options) {
    const state = resolveStateId(stateOrFeature);
    if (!state) {
      console.warn('[TENDEN Agent] Unknown state or feature:', stateOrFeature);
      return;
    }

    const root = getRoot();
    if (!root) return;

    clearRevertTimer();
    currentState = state;
    if (options && options.feature) currentFeature = options.feature;

    root.classList.remove(...allStateClasses());
    root.classList.add(stateClass(state));
    root.dataset.agentState = state;

    applyStateAsset(state);

    const msgEl = getMessageEl();
    if (msgEl) {
      const text = message || manifest.states[state]?.message || '';
      msgEl.textContent = text;
    }

    const opts = options || {};
    if (!opts.persist && opts.revertTo && opts.revertMs > 0) {
      const revertTarget = opts.revertTo;
      revertTimer = setTimeout(function () {
        if (AGENT_FEATURE_MAP[revertTarget] || revertTarget === 'default') {
          setAgentForFeature(revertTarget, undefined, { persist: true });
        } else {
          setAgentState(revertTarget, undefined, { persist: true });
        }
      }, opts.revertMs);
    }
  }

  /**
   * アプリ機能に応じたポーズを設定
   * @param {string} featureKey AGENT_FEATURE_MAP のキー
   * @param {string} [message]
   * @param {{ revertTo?: string, revertMs?: number, persist?: boolean }} [options]
   */
  function setAgentForFeature(featureKey, message, options) {
    const state = resolveStateId(featureKey);
    if (!state) {
      console.warn('[TENDEN Agent] Unknown feature:', featureKey);
      return;
    }
    currentFeature = featureKey;
    const opts = Object.assign({ feature: featureKey }, options || {});
    setAgentState(state, message, opts);
  }

  /** @alias setAgentState */
  function updateTendenAgent(state, message, options) {
    setAgentState(state, message, options);
  }

  function removeAssetNodes() {
    Object.keys(assetNodes).forEach(function (key) {
      const node = assetNodes[key];
      if (node && node.parentNode) node.parentNode.removeChild(node);
    });
    assetNodes = {};
  }

  function showPlaceholder(show) {
    const host = getVisualHost();
    if (!host) return;
    const placeholder = host.querySelector('.tenden-agent-placeholder');
    if (placeholder) placeholder.classList.toggle('hidden', !show);
  }

  function bustAgentSrc(src) {
    if (!src) return src;
    if (src.indexOf('?') >= 0) return src;
    return src + '?v=' + AGENT_ASSET_BUST;
  }

  function applyStateAsset(state) {
    const host = getVisualHost();
    if (!host) return;

    const spec = manifest.states[state];
    if (!spec || !spec.src) {
      showPlaceholder(true);
      return;
    }

    showPlaceholder(false);
    const type = spec.type || inferAssetType(spec.src);
    let node = assetNodes[state];

    if (!node) {
      node = createAssetNode(type, spec, state);
      if (!node) {
        showPlaceholder(true);
        return;
      }
      assetNodes[state] = node;
      host.appendChild(node);
    } else if (type === 'image' && node.tagName === 'IMG') {
      const busted = bustAgentSrc(spec.src);
      if (node.getAttribute('src') !== busted) node.src = busted;
    }

    Object.keys(assetNodes).forEach(function (key) {
      assetNodes[key].classList.toggle('is-active', key === state);
    });

    if (type === 'lottie' && node.play) {
      try {
        if (reducedMotion && spec.staticFrame != null) node.goToAndStop(spec.staticFrame, true);
        else node.play();
      } catch (e) { /* noop */ }
    }
  }

  function inferAssetType(src) {
    if (/\.json$/i.test(src)) return 'lottie';
    if (/\.(webp|apng|png|gif)$/i.test(src)) return 'image';
    if (/\.svg$/i.test(src)) return 'svg';
    return 'css';
  }

  function createAssetNode(type, spec, state) {
    if (type === 'lottie') {
      if (typeof lottie === 'undefined') {
        console.info('[TENDEN Agent] Lottie player not loaded; using CSS placeholder for', state);
        return null;
      }
      const container = document.createElement('div');
      container.className = 'tenden-agent-asset tenden-agent-asset--lottie';
      container.dataset.state = state;
      const anim = lottie.loadAnimation({
        container: container,
        renderer: 'svg',
        loop: spec.loop !== false,
        autoplay: !reducedMotion,
        path: spec.src
      });
      container.__lottie = anim;
      container.play = function () { anim.play(); };
      container.goToAndStop = function (frame, isFrame) { anim.goToAndStop(frame, isFrame); };
      return container;
    }

    if (type === 'image') {
      const img = document.createElement('img');
      img.className = 'tenden-agent-asset tenden-agent-asset--image';
      img.dataset.state = state;
      img.src = bustAgentSrc(spec.src);
      img.alt = manifest.states[state]?.label || '';
      img.decoding = 'async';
      img.loading = 'eager';
      img.onerror = function () {
        const retry = bustAgentSrc(spec.src) + '&r=' + Date.now();
        if (img.src !== retry) img.src = retry;
      };
      return img;
    }

    if (type === 'svg') {
      const img = document.createElement('img');
      img.className = 'tenden-agent-asset tenden-agent-asset--svg';
      img.dataset.state = state;
      img.src = spec.src;
      img.alt = manifest.states[state]?.label || '';
      return img;
    }

    const div = document.createElement('div');
    div.className = 'tenden-agent-asset tenden-agent-asset--css';
    div.dataset.state = state;
    if (spec.className) div.classList.add(spec.className);
    return div;
  }

  async function loadManifest() {
    try {
      const res = await fetch(MANIFEST_URL + '?v=' + AGENT_ASSET_BUST, { cache: 'no-cache' });
      if (!res.ok) return;
      const data = await res.json();
      manifest = Object.assign({}, DEFAULT_MANIFEST, data);
      if (manifest.size) {
        const root = getRoot();
        if (root) {
          root.style.setProperty('--agent-width', (manifest.size.width || 72) + 'px');
          root.style.setProperty('--agent-height', (manifest.size.height || 72) + 'px');
        }
      }
    } catch (e) {
      console.info('[TENDEN Agent] Using built-in placeholder (manifest not found).');
    }
  }

  function isEmergencyContext() {
    return document.body.classList.contains('emergency-mode') ||
      document.body.classList.contains('tenden-nav-active');
  }

  function emergencyRevertFeature() {
    return document.body.classList.contains('tenden-nav-active') ? 'emergency-active' : 'emergency';
  }

  function bubbleFeatureForType(type) {
    const map = {
      info: 'bubble-info',
      success: 'bubble-success',
      warning: 'bubble-warning',
      error: 'bubble-error',
      copied: 'bubble-copied'
    };
    return map[type] || 'bubble-info';
  }

  function applyNotificationState(type, message, feature) {
    const featureKey = feature || bubbleFeatureForType(type);
    if (isEmergencyContext()) {
      if (type === 'error' || type === 'warning') {
        setAgentForFeature('danger-zone', message, {
          revertTo: emergencyRevertFeature(),
          revertMs: 5000
        });
      } else if (type === 'success' || type === 'copied') {
        setAgentForFeature(type === 'copied' ? 'checkin' : 'synced', message, {
          revertTo: emergencyRevertFeature(),
          revertMs: 3500
        });
      } else {
        setAgentForFeature('route-guidance', message, {
          revertTo: emergencyRevertFeature(),
          revertMs: 4500
        });
      }
      return;
    }
    const revertMs = {
      info: 4500,
      success: 3500,
      warning: 5000,
      error: 6000,
      copied: 2500
    };
    setAgentForFeature(featureKey, message, {
      revertTo: 'default',
      revertMs: revertMs[type] || 4500
    });
  }

  function dismissAgentBubble() {
    const root = getRoot();
    const bubble = getBubbleEl();
    if (!bubble || bubble.classList.contains('hidden')) return;

    bubble.classList.remove('tenden-agent-bubble--visible');
    bubble.classList.add('tenden-agent-bubble--exiting');
    bubble.dataset.bubbleMode = '';
    if (root) root.classList.remove('tenden-agent--interactive');

    bubbleExitTimer = setTimeout(function () {
      bubble.classList.add('hidden');
      bubble.classList.remove('tenden-agent-bubble--exiting');
      const dismissBtn = getBubbleDismissEl();
      const actionsEl = getBubbleActionsEl();
      if (dismissBtn) dismissBtn.classList.add('hidden');
      if (actionsEl) actionsEl.classList.add('hidden');
      bubbleExitTimer = null;
    }, BUBBLE_EXIT_MS);
  }

  function isAgentBubbleMode(mode) {
    const bubble = getBubbleEl();
    if (!bubble || bubble.classList.contains('hidden')) return false;
    return bubble.dataset.bubbleMode === mode;
  }

  /**
   * @param {string} message
   * @param {{ type?: string, duration?: number, syncState?: boolean, feature?: string, persist?: boolean, dismissible?: boolean, interactive?: boolean, mode?: string }} [options]
   */
  function showAgentBubble(message, options) {
    const root = getRoot();
    const bubble = getBubbleEl();
    const textEl = getBubbleTextEl();
    if (!root || !bubble || !textEl || !message) return;

    const opts = options || {};
    const type = opts.type || 'info';
    const persist = opts.persist === true;
    const duration = persist
      ? 0
      : (typeof opts.duration === 'number' ? opts.duration : BUBBLE_VISIBLE_MS);
    const syncState = opts.syncState !== false;
    const feature = opts.feature || bubbleFeatureForType(type);
    const dismissible = opts.dismissible === true;
    const interactive = opts.interactive === true;
    const mode = opts.mode || (interactive ? 'interactive' : 'toast');

    clearBubbleTimers();

    textEl.textContent = message;
    bubble.dataset.bubbleType = type;
    bubble.dataset.bubbleMode = mode;
    bubble.classList.remove('hidden', 'tenden-agent-bubble--exiting');
    bubble.classList.toggle('tenden-agent-bubble--interactive', interactive || dismissible);
    root.classList.toggle('tenden-agent--interactive', interactive || dismissible);

    const dismissBtn = getBubbleDismissEl();
    const actionsEl = getBubbleActionsEl();
    if (dismissBtn) dismissBtn.classList.toggle('hidden', !dismissible);
    if (actionsEl) actionsEl.classList.toggle('hidden', !interactive);

    const msgEl = getMessageEl();
    if (msgEl) msgEl.textContent = message;

    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        bubble.classList.add('tenden-agent-bubble--visible');
      });
    });

    if (syncState) {
      applyNotificationState(type, message, feature);
    } else if (opts.feature && AGENT_FEATURE_MAP[opts.feature]) {
      setAgentForFeature(opts.feature, message, { persist: true });
    }

    if (!persist && duration > 0) {
      bubbleHideTimer = setTimeout(function () {
        dismissAgentBubble();
        bubbleHideTimer = null;
      }, duration);
    }
  }

  /** @deprecated Use showAgentBubble — kept for backward compatibility */
  function syncAgentFromIsland(type, message) {
    showAgentBubble(message, { type: type });
  }

  function syncAgentFromP2P(p2pState) {
    if (p2pState === 'alert') {
      setAgentForFeature('p2p-alert', undefined, { persist: true });
    } else if (p2pState === 'connecting') {
      setAgentForFeature('p2p-connecting', undefined, { revertTo: 'default', revertMs: 4000 });
    } else if (p2pState === 'connected') {
      setAgentForFeature('p2p-connected', undefined, { persist: true });
    } else if (p2pState === 'disconnected') {
      setAgentForFeature('bubble-warning', undefined, { revertTo: 'default', revertMs: 5000 });
    }
  }

  function syncAgentEmergency(isEmergency) {
    if (isEmergency) {
      const isDrill = document.body.classList.contains('tenden-nav-active') &&
        !document.body.classList.contains('emergency-mode');
      setAgentForFeature(isDrill ? 'drill-mode' : 'emergency-active', undefined, { persist: true });
    } else {
      setAgentForFeature('default', undefined, { persist: true });
    }
  }

  function syncAgentSafeGuide(visible) {
    if (isEmergencyContext()) return;
    if (visible) {
      setAgentForFeature('safe-zone', undefined, { persist: true });
    } else if (currentFeature === 'safe-zone') {
      setAgentForFeature('default', undefined, { persist: true });
    }
  }

  function preloadAgentAssets() {
    if (!manifest || !manifest.states) return;
    Object.keys(manifest.states).forEach(function (key) {
      const spec = manifest.states[key];
      if (!spec || !spec.src || inferAssetType(spec.src) !== 'image') return;
      const img = new Image();
      img.src = bustAgentSrc(spec.src);
    });
  }

  async function initTendenAgent() {
    if (initialized) return;

    readReducedMotion();
    try {
      window.matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', readReducedMotion);
    } catch (e) { /* legacy */ }

    await loadManifest();
    initialized = true;
    preloadAgentAssets();
    removeAssetNodes();
    setAgentForFeature('app-init', undefined, { persist: true });

    const bubbleDismissBtn = getBubbleDismissEl();
    if (bubbleDismissBtn) {
      bubbleDismissBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        if (typeof window.onAgentBubbleDismiss === 'function') {
          window.onAgentBubbleDismiss();
        } else {
          dismissAgentBubble();
        }
      });
    }
  }

  window.TENDEN_AGENT_STATES = TENDEN_AGENT_STATES;
  window.AGENT_FEATURE_MAP = AGENT_FEATURE_MAP;
  window.setAgentState = setAgentState;
  window.setAgentForFeature = setAgentForFeature;
  window.updateTendenAgent = updateTendenAgent;
  window.initTendenAgent = initTendenAgent;
  window.showAgentBubble = showAgentBubble;
  window.dismissAgentBubble = dismissAgentBubble;
  window.isAgentBubbleMode = isAgentBubbleMode;
  window.syncAgentFromIsland = syncAgentFromIsland;
  window.syncAgentFromP2P = syncAgentFromP2P;
  window.syncAgentEmergency = syncAgentEmergency;
  window.syncAgentSafeGuide = syncAgentSafeGuide;
})();
