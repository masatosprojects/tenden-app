// app.js
document.addEventListener('DOMContentLoaded', () => {

 // ── デモ強制リセット（新バージョン起動時に必ずオンボーディングを表示）
 (function() {
   try {
     var ver = 'v62';
     if (localStorage.getItem('tenden-pwa-ver') !== ver) {
       localStorage.removeItem('tenden-demo-seen');
       localStorage.setItem('tenden-pwa-ver', ver);
     }
   } catch(e) {}
 })();

 // ── 言語初期化（i18n.json ロード前に必ず日本語で表示開始）
 (function() {
   try {
     // localStorage に言語設定がなければデフォルトで日本語
     var saved = localStorage.getItem('tenden-lang');
     if (!saved || saved === 'auto') {
       // ブラウザ言語が日本語か判定し、それ以外はそのまま
       var bl = (navigator.language || 'ja').split('-')[0];
       var forceLang = (bl === 'ja') ? 'ja' : bl;
       // body に lang クラスを設定
       document.body.classList.remove('lang-en','lang-zh','lang-ko','lang-es','lang-fr');
       document.body.classList.add('lang-' + forceLang);
     } else {
       document.body.classList.remove('lang-ja','lang-en','lang-zh','lang-ko','lang-es','lang-fr');
       document.body.classList.add('lang-' + saved);
     }
   } catch(e) {}
 })();

 // Basic state
 let isEmergency = false;
  let coastalProximityLine = null;
  let coastalMarker = null;
 let map, userMarker, routeLayerGroup, hazardLayer, reliefLayer, sheltersLayerGroup, congestionLayer, safeEdgesLayerGroup;
 let congestionGeojsonData = null;
 let currentLocation = null; // {lat, lng}
 let isManualLocation = false;
 // Emergency route tracking state
 let isPinLocked = false;
 let isWaitingForPinDrop = false;
 let activeRoutesList = [];
 let activeSelectedRouteId = 'A';
 let activeSecondaryRoute = null; // Cached secondary (shelter) route for redraw
 let simulationInterval = null;
 let popupTimeoutId = null; // Timeout ID for auto-closing manual pin thought popup
 let mainRouteLine = null;
 let activeScenarioId = 1;
 let activeLocationId = 'a';
 
 // Premium features state variables
 let lastOffCourseSpeakTime = 0;
 let isEvacuationCompleted = false;
 let dynamicIslandTimer = null;
 
 // Simulation-derived data
 let routeData = {}; // loaded from assets/routes.json
 let pendingRouteArgs = null; // {scenarioId, locationId, scLoc} while route modal is open
 
 // GeoJSON and Data layers
 let sheltersData = [];
 let safeEdgesData = [];
 let staticSafeEdges = [];
 
 // Smartphone-specific state variables
 let wakeLock = null;
 let lastInundationNotificationTime = 0;
 let lastDeviationNotificationTime = 0;
 let hasWarnedLowBattery = false;
 let lastHeading = 0;
 let lastScanCenter = null;
 
 // Kamakura default location (Yuigahama)
 const KAMAKURA_CENTER = [35.3192, 139.5504];

    console.log('[TENDEN] i18n.json 30-languages dictionary loaded successfully');
 let i18nDict = {};

 // Initialize (各関数をtry/catchで保護 — どれかがエラーでもスプラッシュは消える)
 try { initMap(); } catch(e) { console.error('[TENDEN] initMap error:', e); }
 try { initUI(); } catch(e) { console.error('[TENDEN] initUI error:', e); }
 try { startClock(); } catch(e) {}
 try { connectP2PQuake(); } catch(e) {}
 try { startOnboardingDemo(); } catch(e) { console.error('[TENDEN] onboarding error:', e); }
 try { wireOnboardingButtons(); } catch(e) {}


 // Load 30-languages localization dictionary from external JSON file (PWA cache optimized)
 fetch('assets/i18n.json')
 .then(res => res.json())
 .then(data => {
 i18nDict = data;
 initI18n();
    console.log('[TENDEN] i18n.json 30-languages dictionary loaded successfully');
 })
 .catch(e => {
    console.warn('[i18n] Failed to load external dictionary. Falling back.', e);
 initI18n();
 });

 // Load simulation-derived route data
 fetch('assets/routes.json')
 .then(res => res.json())
  .then(data => { routeData = data; console.log('[TENDEN] routes.json loaded'); })
  .catch(e => console.log('[TENDEN] routes.json not found (fallback to static routes)', e));



  // Register Service Worker (DISABLED FOR DEV CACHE BYPASS)
  /*
   if ('serviceWorker' in navigator) {
   window.addEventListener('load', () => {
   navigator.serviceWorker.register('sw.js').catch(err => {
   console.log('SW registration failed: ', err);
   });
   });
   }
  */
  // Force unregister existing Service Workers to clear caching issues immediately
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations().then(registrations => {
      for (let r of registrations) {
        r.unregister().then(() => {
          console.log('[TENDEN] Active Service Worker successfully unregistered to bypass cache.');
        });
      }
    });
  }

 function initMap() {
 map = L.map('map', {
  zoomControl: false,
  attributionControl: false
  }).setView(KAMAKURA_CENTER, 14);

  // Try to dynamically center on user's live position on load!
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const userLoc = [position.coords.latitude, position.coords.longitude];
        map.setView(userLoc, 14);
        console.log(`[TENDEN] Geolocation centered map at: ${userLoc}`);
        currentLocation = { lat: position.coords.latitude, lng: position.coords.longitude };
        updateMarker(currentLocation);
        fetchElevation(currentLocation);
        triggerLocationTsunamiCheck(currentLocation);
        generalizeFirstTargets(currentLocation);
  drawProximityToCoastline(currentLocation);
      },
      () => {
        console.log('[TENDEN] Geolocation failed or permission denied on load, using default Kamakura center.');
      },
      { timeout: 5000 }
    );
  }

 // OSM Light style for Normal mode
 L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
 maxZoom: 19
 }).addTo(map);

 L.control.attribution({
 position: 'bottomleft',
    prefix: 'Source: GSI Hazard Map Portal (GSI Japan) | Leaflet',
 }).addTo(map);

 routeLayerGroup = L.layerGroup().addTo(map);
 safeEdgesLayerGroup = L.layerGroup();

 // Official tsunami inundation tile layer (繝上じ繝ｼ繝峨・繝・・繝昴・繧ｿ繝ｫ繧ｵ繧､繝・ 蝗ｽ蝨溷慍逅・劼)
 // Source: https://disaportal.gsi.go.jp/
 // Kanagawa pref. code = 14, zoom range 2窶・7
 hazardLayer = L.tileLayer(
 'https://disaportaldata.gsi.go.jp/raster/04_tsunami_newlegend_pref_data/14/{z}/{x}/{y}.png',
 {
 minZoom: 2,
 maxZoom: 17,
 opacity: 0.65,
    attribution: 'Tsunami Inundation: GSI Hazard Map Portal (GSI Japan)',
 }
 );
 
 // Official relief tile layer from GSI for elevation color maps
 reliefLayer = L.tileLayer(
 'https://cyberjapandata.gsi.go.jp/xyz/relief/{z}/{x}/{y}.png',
 {
 minZoom: 2,
 maxZoom: 18,
 opacity: 0.6,
    attribution: 'Elevation: GSI Japan'
 }
 );
 // Note: tile layer is instantiated but not added to map until toggle button is activated

 // Initialize Shelter markers 窶・dynamic load from simulation data
 sheltersLayerGroup = L.layerGroup();
 const LOAD_COLORS = { low: '#00a63e', medium: '#f5a623', high: '#c0392b' };
  const LOAD_LABELS = { low: 'o Low', medium: '! Medium', high: 'x High' };
 const FALLBACK_SHELTERS = [
 { name: "御成小学校", lat: 35.3190, lng: 139.5510, predicted_load: 'low', capacity: 910, typical_occupancy_pct: 4.7 },
 { name: "骼悟牙ｸょｽｹ謇", lat: 35.3180, lng: 139.5400, predicted_load: 'low', capacity: 1000, typical_occupancy_pct: 0 },
 { name: "甘縄神明宮", lat: 35.3142, lng: 139.5332, predicted_load: 'low', capacity: 500, typical_occupancy_pct: 0 },
 { name: "八幡宮境内", lat: 35.3252, lng: 139.5562, predicted_load: 'low', capacity: 800, typical_occupancy_pct: 0 },
 { name: "貂・ｳ牙ｰ丞ｭｦ譬｡", lat: 35.3258, lng: 139.5605, predicted_load: 'low', capacity: 600, typical_occupancy_pct: 0 },
 { name: "鎌倉生涯学習センター", lat: 35.3195, lng: 139.5570, predicted_load: 'low', capacity: 400, typical_occupancy_pct: 0 },
 ];

 function addShelterMarkers(shelterList) {
 const lang = getLanguageCode();
 const dict = i18nDict[lang] || i18nDict['ja'] || {};
 
 shelterList.forEach(s => {
 const load = s.predicted_load || 'low';
 const color = LOAD_COLORS[load] || '#888';
 
 // Translate predicted load labels based on language
 let label = '';
 if (load === 'low') label = dict.loadLow || '低混雑';
 else if (load === 'medium') label = dict.loadMedium || 'やや混雑';
 else if (load === 'high') label = dict.loadHigh || '高混雑';

 const icon = L.divIcon({
 className: `shelter-marker shelter-${load}`,
 html: `<div class="shelter-marker-inner" style="background:${color};border-color:${color}"></div>`,
 iconSize: [24, 24],
 iconAnchor: [12, 12]
 });
 
 // Dynamically translate the prefix '驕ｿ髮｣謇' in names to local equivalents like 'Shelter'
 const shelterWord = dict.shelterWord || 'Shelter';
 let localizedName = s.name.replace('避難所', shelterWord);

 // Translate other suffixes dynamically
 if (dict.elementarySchool) localizedName = localizedName.replace('小学校', dict.elementarySchool);
 if (dict.juniorHighSchool) localizedName = localizedName.replace('中学校', dict.juniorHighSchool);
 if (dict.shrinePrecincts) localizedName = localizedName.replace('境内', dict.shrinePrecincts);
 if (dict.learningCenter) localizedName = localizedName.replace('学習センター', dict.learningCenter);

 // Format multi-language strings with placeholders
 let capText = dict.shelterCapacity || '蜿主ｮｹ閭ｽ蜉・ {capacity}莠ｺ';
 capText = capText.replace('{capacity}', s.capacity);
 
 let occNote = '';
 if (s.typical_occupancy_pct > 0) {
 let occText = dict.shelterOccupancy || '典型利用率: {occupancy}%';
 occText = occText.replace('{occupancy}', s.typical_occupancy_pct);
 occNote = `<br><span style="color:${color};font-size:0.85em">${label} (${occText})</span>`;
 }
 
 const disclaimerText = dict.shelterDisclaimer || '※シミュレーション統計に基づく予測。リアルタイムデータではありません';
 const disclaimer = `<br><em style="font-size:0.78em;opacity:0.7">${disclaimerText}</em>`;
 
 L.marker([s.lat, s.lng], { icon })
 .bindPopup(`<strong>${localizedName}</strong> (${capText})${occNote}${disclaimer}`)
 .addTo(sheltersLayerGroup);
 });
 }

 // Load shelters data
 fetch('assets/shelters.json')
 .then(res => res.json())
 .then(data => {
 sheltersData = data;
 addShelterMarkers(data);
    console.log('[TENDEN] shelters.json loaded', data.length);
 })
 .catch(() => {
 sheltersData = FALLBACK_SHELTERS;
 addShelterMarkers(FALLBACK_SHELTERS);
    console.log('[TENDEN] shelters.json not found, using fallback');
 });

 // Load safe edges data: start with static JSON for instant availability,
 // then replace with comprehensive dynamic raster scan in background
 fetch('assets/safe_edges.json')
 .then(res => res.json())
 .then(async (data) => {
 staticSafeEdges = data;
 safeEdgesData = data;
    console.log('[TENDEN] safe_edges.json loaded:', data.length);
 await verifyAndCleanSafeEdges();
 drawAllSafeEdges(); // Render layers
 })
 .catch(() => {})
 .finally(() => {
 // Trigger full raster scan to find ALL boundaryﾃ羊oad intersections
 computeSafeEdgesFromRasterScan('14').then(async (dynamicEdges) => {
 if (dynamicEdges.length > 0) {
 // Merge static curated edges with dynamically scanned edges to prevent high-altitude fallbacks from disappearing
 const mergedEdges = [...staticSafeEdges];
 dynamicEdges.forEach(dyn => {
 // Check if a very close point already exists (within 50 meters) to avoid visual clutter
 const isDuplicate = mergedEdges.some(st => {
 const dist = L.latLng(st.lat, st.lng).distanceTo(L.latLng(dyn.lat, dyn.lng));
 return dist < 50;
 });
 if (!isDuplicate) {
 mergedEdges.push(dyn);
 }
 });
 safeEdgesData = mergedEdges;
    console.log(`[TENDEN] Raster scan finished. Scanned ${safeEdgesData.length} edges (static: ${staticSafeEdges.length}, dynamic: ${dynamicEdges.length})`);
 await verifyAndCleanSafeEdges();
 drawAllSafeEdges(); // Render layers
 }
  }).catch(e => console.warn('[SafeEdge] Raster scan failed', e));
 });

 // Load congestion heatmap from simulation data
 fetch('assets/congestion.geojson')
 .then(res => res.json())
 .then(data => {
 congestionGeojsonData = data; // Store globally for Turf.js calculations
 congestionLayer = L.geoJSON(data, {
 style: f => ({
 color: LOAD_COLORS[f.properties.level] || '#888888',
 weight: f.properties.level === 'high' ? 5 : (f.properties.level === 'medium' ? 4 : 2),
 opacity: f.properties.level === 'high' ? 0.85 : (f.properties.level === 'medium' ? 0.65 : 0.35)
 })
 });
 const chkToggle = document.getElementById('toggle-congestion');
 if (chkToggle && chkToggle.checked) {
 congestionLayer.addTo(map);
 }
  console.log('[TENDEN] congestion.geojson loaded', data.features.length);
 })
  .catch(e => console.log('[TENDEN] congestion.geojson not found', e));

 // Initialize Device Orientation for Compass
 if (window.DeviceOrientationEvent) {
 window.addEventListener('deviceorientationabsolute', handleOrientation, true);
 // Fallback for non-absolute
 window.addEventListener('deviceorientation', handleOrientation, true);
 }

 // Map Click Listener to set custom starting point
 map.on('click', (e) => {
 if (isPinLocked) return; // Prevent pin change if locked
 
 isManualLocation = true;
 currentLocation = { lat: e.latlng.lat, lng: e.latlng.lng };
 updateMarker(currentLocation);
 fetchElevation(currentLocation);
 triggerLocationTsunamiCheck(currentLocation);
 generalizeFirstTargets(currentLocation);
 
 if (isEmergency) {
 // If already in emergency mode, instantly recalculate the evacuation route
 recalculateRouteFromLocation(currentLocation);
 }
 });

 // Map drag/move listener to dynamically update tsunami map based on displayed region
 map.on('moveend', () => {
 const center = map.getCenter();
 updateTsunamiPrefecturalTile(center.lat, center.lng);
 });

 // Banner Toggle Logic
 const bannerToggle = document.getElementById('banner-toggle');
 const bannerContent = document.getElementById('banner-content-expanded');
 const bannerChevron = document.getElementById('banner-chevron');
 if (bannerToggle && bannerContent) {
 bannerToggle.addEventListener('click', () => {
 if (bannerContent.style.display === 'none') {
 bannerContent.style.display = 'block';
 bannerChevron.style.transform = 'rotate(180deg)';
 } else {
 bannerContent.style.display = 'none';
 bannerChevron.style.transform = 'rotate(0deg)';
 }
 });
 }
 }

 function handleOrientation(event) {
 let heading = null;
 if (event.webkitCompassHeading) {
 heading = event.webkitCompassHeading;
 } else if (event.alpha !== null) {
 heading = 360 - event.alpha;
 }
 if (heading !== null) {
 document.documentElement.style.setProperty('--compass-heading', `${heading}deg`);
 }
 }

 function initUI() {
 const btnOnboarding = document.getElementById('btn-onboarding-ok');
 const btnErrorOk = document.getElementById('btn-error-ok');
 const btnTestAlert = document.getElementById('btn-test-alert');
 const btnSos = document.getElementById('btn-sos');
 const btnScreenshot = document.getElementById('btn-screenshot');
 const btnToggleLayers = document.getElementById('btn-toggle-layers');
 const btnSettings = document.getElementById('btn-settings');
 const btnSettingsClose = document.getElementById('btn-settings-close');
 const langSelect = document.getElementById('lang-select');
 const btnClearCache = document.getElementById('btn-clear-cache');
 const btnShare = document.getElementById('btn-share');
 
 // Bind settings elements & load from localStorage
 const walkSpeedSelect = document.getElementById('walk-speed-select');
 const toggleP2PAuto = document.getElementById('toggle-p2p-auto');
 const toggleDeviationAlert = document.getElementById('toggle-deviation-alert');
 const toggleVoiceNav = document.getElementById('toggle-voice-nav');
 const toggleEmergencyForce = document.getElementById('toggle-emergency-force');

 // Evacuation Guide Overlay triggers
 const btnOpenGuide = document.getElementById('btn-open-guide');
 const btnGuideClose = document.getElementById('btn-guide-close');
 const btnGuideCloseBottom = document.getElementById('btn-guide-close-bottom');
 const guideOverlay = document.getElementById('guide-overlay');

 if (btnOpenGuide && guideOverlay) {
 btnOpenGuide.addEventListener('click', () => {
 guideOverlay.classList.remove('hidden');
 setTimeout(() => guideOverlay.classList.add('active'), 10);
 });
 }

 const closeGuideFunc = () => {
 if (guideOverlay) {
 guideOverlay.classList.remove('active');
 setTimeout(() => guideOverlay.classList.add('hidden'), 300);
 }
 };

 if (btnGuideClose) btnGuideClose.addEventListener('click', closeGuideFunc);
 if (btnGuideCloseBottom) btnGuideCloseBottom.addEventListener('click', closeGuideFunc);

 // Network Status initialization & listeners
 window.addEventListener('online', updateNetworkStatusHUD);
 window.addEventListener('offline', updateNetworkStatusHUD);
 updateNetworkStatusHUD(); // Initial call

 // Preload Web Speech API voices
 if ('speechSynthesis' in window) {
 window.speechSynthesis.getVoices();
 }

 if (toggleVoiceNav) {
 toggleVoiceNav.checked = localStorage.getItem('tenden-voice-nav') === 'true';
 toggleVoiceNav.addEventListener('change', (e) => {
 localStorage.setItem('tenden-voice-nav', e.target.checked);
 const statusText = e.target.checked ? "ON" : "OFF";
 const dict = i18nDict[getLanguageCode()] || i18nDict['ja'] || {};
  triggerDynamicIsland((dict.voiceNavLabel || "Voice Navigation") + ": " + statusText, "info");
 if (e.target.checked) {
 speakI18n('voiceNavLabel');
 }
 });
 }

 if (walkSpeedSelect) {
 walkSpeedSelect.value = localStorage.getItem('tenden-walk-speed') || '4.0';
 walkSpeedSelect.addEventListener('change', (e) => {
 localStorage.setItem('tenden-walk-speed', e.target.value);
 const dict = i18nDict[getLanguageCode()] || i18nDict['ja'] || {};
 const speedText = walkSpeedSelect.options[walkSpeedSelect.selectedIndex].text;
  triggerDynamicIsland((dict.walkSpeedLabel || "Evacuation Walk Speed") + ": " + speedText, "info");
 // Dynamically recalculate route evacuation times if active location exists
 if (currentLocation) {
 recalculateRouteFromLocation(currentLocation);
 }
 });
 }
 if (toggleP2PAuto) {
 toggleP2PAuto.checked = localStorage.getItem('tenden-p2p-auto') !== 'false';
 toggleP2PAuto.addEventListener('change', (e) => {
 localStorage.setItem('tenden-p2p-auto', e.target.checked);
 const statusText = e.target.checked ? "ON" : "OFF";
 const dict = i18nDict[getLanguageCode()] || i18nDict['ja'] || {};
  triggerDynamicIsland((dict.p2pAutoLabel || "P2P Auto Detection") + ": " + statusText, "info");
 });
 }
 if (toggleDeviationAlert) {
 toggleDeviationAlert.checked = localStorage.getItem('tenden-deviation-alert') !== 'false';
 toggleDeviationAlert.addEventListener('change', (e) => {
 localStorage.setItem('tenden-deviation-alert', e.target.checked);
 const statusText = e.target.checked ? "ON" : "OFF";
 const dict = i18nDict[getLanguageCode()] || i18nDict['ja'] || {};
  triggerDynamicIsland((dict.deviationAlertLabel || "Route Deviation Warning") + ": " + statusText, "info");
 });
 }
 if (toggleEmergencyForce) {
 toggleEmergencyForce.checked = isEmergency;
 toggleEmergencyForce.addEventListener('change', (e) => {
 if (e.target.checked) {
 // Trigger emergency mode for demonstration
 triggerEmergencyMode(true, 1, 'a');
 } else {
 // Turn off emergency mode
 isEmergency = false;
 isPinLocked = false;
 isWaitingForPinDrop = false;
 resetEmergencyMode();
 }
 });
 }

 const toggleWakeLock = document.getElementById('toggle-wake-lock');
 const toggleSystemNotification = document.getElementById('toggle-system-notification');
 const toggleSmartCompass = document.getElementById('toggle-smart-compass');

 if (toggleWakeLock) {
 toggleWakeLock.checked = localStorage.getItem('tenden-wake-lock') !== 'false';
 toggleWakeLock.addEventListener('change', (e) => {
 localStorage.setItem('tenden-wake-lock', e.target.checked);
 const statusText = e.target.checked ? "ON" : "OFF";
 const dict = i18nDict[getLanguageCode()] || i18nDict['ja'] || {};
  triggerDynamicIsland((dict.wakeLockLabel || "Screen Wake Lock") + ": " + statusText, "info");
 triggerHapticTick();
 if (e.target.checked && isEmergency) {
 requestWakeLock();
 } else {
 releaseWakeLock();
 }
 });
 }

 if (toggleSystemNotification) {
 toggleSystemNotification.checked = localStorage.getItem('tenden-system-notification') !== 'false';
 toggleSystemNotification.addEventListener('change', (e) => {
 localStorage.setItem('tenden-system-notification', e.target.checked);
 const statusText = e.target.checked ? "ON" : "OFF";
 const dict = i18nDict[getLanguageCode()] || i18nDict['ja'] || {};
  triggerDynamicIsland((dict.systemNotificationLabel || "System Notifications") + ": " + statusText, "info");
 triggerHapticTick();
 if (e.target.checked) {
 requestNotificationPermission();
 }
 });
 }

 if (toggleSmartCompass) {
 toggleSmartCompass.checked = localStorage.getItem('tenden-smart-compass') !== 'false';
 toggleSmartCompass.addEventListener('change', (e) => {
 localStorage.setItem('tenden-smart-compass', e.target.checked);
 const statusText = e.target.checked ? "ON" : "OFF";
 const dict = i18nDict[getLanguageCode()] || i18nDict['ja'] || {};
  triggerDynamicIsland((dict.smartCompassLabel || "Smart Compass") + ": " + statusText, "info");
 triggerHapticTick();
 
 const arrow = document.querySelector('.user-marker-arrow');
 if (arrow) {
 arrow.style.display = (e.target.checked && lastHeading !== 0) ? 'block' : 'none';
 }
 
 if (e.target.checked) {
 requestOrientationPermission();
 }
 });
 }

 // Global haptic feedback on clicking any actionable buttons
 document.addEventListener('click', (e) => {
 const btn = e.target.closest('.fab-btn, .action-btn, .close-btn, .switch-container');
 if (btn) {
 triggerHapticTick();
 }
 });

 // Start Low Battery Life Watcher
 initBatteryWatcher();

 // Bind Evacuation Share Dialog close, LINE, System Share and Copy buttons
 const btnShareDialogClose = document.getElementById('btn-share-dialog-close');
 if (btnShareDialogClose) {
 btnShareDialogClose.addEventListener('click', () => {
 const shareOverlay = document.getElementById('share-overlay');
 shareOverlay.classList.remove('active');
 setTimeout(() => shareOverlay.classList.add('hidden'), 300);
 });
 }
 const btnShareLine = document.getElementById('btn-share-line');
 if (btnShareLine) {
 btnShareLine.addEventListener('click', () => {
 const shareTextArea = document.getElementById('share-text-area');
 if (shareTextArea) {
 const text = encodeURIComponent(shareTextArea.value);
 window.open(`https://line.me/R/share?text=${text}`, '_blank');
 }
 });
 }
 const btnShareSystem = document.getElementById('btn-share-system');
 if (btnShareSystem) {
 btnShareSystem.addEventListener('click', async () => {
 const shareTextArea = document.getElementById('share-text-area');
 if (shareTextArea && navigator.share) {
 try {
 const dict = i18nDict[getLanguageCode()] || i18nDict['ja'] || {};
 await navigator.share({
  title: dict.shareDialogTitle || 'Save & Share Evacuation Plan',
 text: shareTextArea.value
 });
 } catch (e) {
 console.log("Web Share API failed or cancelled:", e);
 }
 } else {
 const btnCopy = document.getElementById('btn-share-copy');
 if (btnCopy) btnCopy.click();
 }
 });
 }
 const btnShareCopy = document.getElementById('btn-share-copy');
 if (btnShareCopy) {
 btnShareCopy.addEventListener('click', () => {
 const shareTextArea = document.getElementById('share-text-area');
 if (shareTextArea) {
 shareTextArea.select();
 document.execCommand('copy');
 
 const dict = i18nDict[getLanguageCode()] || i18nDict['ja'] || {};
 const originalText = btnShareCopy.innerText;
  btnShareCopy.innerText = dict.copiedLabel || 'Copied!';
  triggerDynamicIsland(dict.copiedLabel || 'Copied!', 'copied');
 setTimeout(() => {
 btnShareCopy.innerText = originalText;
 }, 2000);
 }
 });
 }

 btnOnboarding.addEventListener('click', () => {
 const overlay = document.getElementById('onboarding-overlay');
 overlay.classList.remove('active');
 setTimeout(() => overlay.classList.add('hidden'), 300);
 requestLocation();
 });

 btnErrorOk.addEventListener('click', () => {
 const overlay = document.getElementById('error-overlay');
 overlay.classList.remove('active');
 setTimeout(() => overlay.classList.add('hidden'), 300);
 
 isManualLocation = true;
 currentLocation = { lat: map.getCenter().lat, lng: map.getCenter().lng };
 updateMarker(currentLocation);
 fetchElevation(currentLocation);
 
 map.on('moveend', () => {
 if(!isEmergency) {
 currentLocation = { lat: map.getCenter().lat, lng: map.getCenter().lng };
 updateMarker(currentLocation);
 fetchElevation(currentLocation);
 }
 });
 });

 btnTestAlert.addEventListener('click', () => {
 document.getElementById('btn-test-alert').classList.add('hidden');
 
 // Clear any old route layers & active simulations
 if (routeLayerGroup) routeLayerGroup.clearLayers();
 if (simulationInterval) {
 clearInterval(simulationInterval);
 simulationInterval = null;
 }
 
 // Fly to Kamakura first
 map.flyTo(KAMAKURA_CENTER, 15, {
 duration: 1.5,
 easeLinearity: 0.25
 });
 
 map.once('moveend', () => {
  isWaitingForPinDrop = true;
  
  const crosshair = document.getElementById('crosshair-target');
  if (crosshair) crosshair.classList.remove('hidden');
  
  // btn-set-pin を表示（リスナーはすでに下で登録済み）
  const spBtn = document.getElementById('btn-set-pin');
  if (spBtn) spBtn.classList.remove('hidden');

  // i18n 辞書を取得
  const dict_popup = i18nDict[getLanguageCode()] || i18nDict['ja'] || {};

  // ── 学術紹介ポップアップ ──────────────────────────────────────
  const _portalUrl = 'https://masatosprojects.github.io/kamakura-sim/';
  const _introTitle = '鎌倉市由比ヶ浜における避難行動シミュレーションについて';
  const _introDesc =
    '本エリア（鎌倉市由比ヶ浜周辺）は、高校生研究者が学術的な避難行動' +
    'シミュレーション研究を実施した対象地域です。<br><br>' +
    '本アプリ「TENDEN」には、研究の成果である<b>道路混雑の動的シミュレーション統計</b>と' +
    '<b>時間変化する避難所負荷モデル</b>がリアルタイムに結合されています。<br><br>' +
    '<a href="' + _portalUrl + '" target="_blank" ' +
    'style="display:inline-flex;align-items:center;text-decoration:none;' +
    'background:#007aff;color:#fff;padding:10px 16px;border-radius:10px;' +
    'font-weight:700;font-size:0.88rem;margin-top:10px;">' +
    '公式研究ポータルを見る →</a>';

  showCustomAlert(_introTitle, _introDesc, 'info', function() {
    showCustomAlert(
      dict_popup.alertLocationTitle || '避難開始位置を設定してください',
      dict_popup.alertLocationDesc  || 'マップをドラッグして画面中央のターゲット（＋印）を避難開始位置に合わせてから、下部のボタンをタップしてください。',
      'info'
    );
  });

  }); // Close map.once!
  }); // Close btnTestAlert!
  const dict = i18nDict[getLanguageCode()] || i18nDict['ja'] || {};
  
 // Set Pin button listener for Crosshair mode
 const btnSetPin = document.getElementById('btn-set-pin');
 if (btnSetPin) {
 btnSetPin.addEventListener('click', () => {
 if (!isWaitingForPinDrop) return;
 isWaitingForPinDrop = false;
 isPinLocked = true; // Lock pin position
 
 // Hide crosshair and button
 document.getElementById('crosshair-target').classList.add('hidden');
 btnSetPin.classList.add('hidden');
 
 // If there's an instruction element, hide it
 const instr = document.getElementById('hud-pin-instruction');
 if (instr) instr.style.display = 'none';
 
 // Get center of map as the pin location
 const center = map.getCenter();
 isManualLocation = true;
 currentLocation = { lat: center.lat, lng: center.lng };
 updateMarker(currentLocation);
 fetchElevation(currentLocation);
 triggerLocationTsunamiCheck(currentLocation);
 updateGPSAccuracyHUD(null);
 
 // Start emergency mode and show routes
 triggerEmergencyMode(true, 1, 'a');
 });
 }

 // UNLOCK PIN Logic
 const btnUnlockPin = document.getElementById('btn-unlock-pin');
 if (btnUnlockPin) {
 btnUnlockPin.addEventListener('click', () => {
 isPinLocked = false;
 isWaitingForPinDrop = true; // Re-enable crosshair pin drop
 
 // Stop simulation and clear routes
 if (simulationInterval) {
 clearInterval(simulationInterval);
 simulationInterval = null;
 }
 routeLayerGroup.clearLayers();
 
 // Show crosshair
 const crosshair = document.getElementById('crosshair-target');
 if (crosshair) crosshair.classList.remove('hidden');
 
 // Hide HUD banner and restore instruction UI
 document.getElementById('evacuation-banner').classList.add('hidden');
 document.getElementById('btn-test-alert').classList.add('hidden');
 
 const btnSetPin = document.getElementById('btn-set-pin');
 if (btnSetPin) {
 btnSetPin.classList.remove('hidden');
 btnSetPin.style.display = 'block';
 }
 
 const instr = document.getElementById('hud-pin-instruction');
 if (instr) instr.style.display = 'block';
 
 document.getElementById('bottom-normal-actions').classList.remove('hidden');
 });
 }

 // Handle drill reset (End Drill)
 const btnResetAlert = document.getElementById('btn-reset-alert');
 if (btnResetAlert) {
 btnResetAlert.addEventListener('click', () => {
 isEmergency = false;
 isPinLocked = false;
 isWaitingForPinDrop = false;
 resetEmergencyMode();
 });
 }

 btnSos.addEventListener('click', () => {
 const flash = document.getElementById('flash-overlay');
 flash.classList.toggle('hidden');
 flash.classList.toggle('flashing');
 });

 btnShare.addEventListener('click', () => {
 const dict = i18nDict[getLanguageCode()] || i18nDict['ja'] || {};
 const lang = getLanguageCode();
 if (navigator.share && currentLocation) {
  const shareTitle = dict.alertSosTitle || '安否情報 (現在地)';
 const shareTextDefault = lang === 'ja' ? '現在、安全な高台へ避難中です。\n現在地: ' : 'I am currently evacuating to safe high ground.\nMy location: ';
 const shareText = (dict.shareText || shareTextDefault) + `https://maps.google.com/?q=${currentLocation.lat},${currentLocation.lng}`;
 navigator.share({
 title: shareTitle,
 text: shareText
 }).catch(console.error);
 } else if (currentLocation) {
  const shareTitle = dict.alertSosTitle || '安否情報 (現在地)';
  const shareDescPrefix = dict.alertSosDesc || "Please copy and send to family and friends:\n\n";
 showCustomAlert(shareTitle, `${shareDescPrefix}https://maps.google.com/?q=${currentLocation.lat},${currentLocation.lng}`, "success");
 } else {
  showCustomAlert(dict.alertSosTitle || "Safety Status", dict.alertSosError || "Failed to get current location. Please tap the map to set a location.", "warning");
 }
 });

 // Default layers state to active
 if (hazardLayer) hazardLayer.addTo(map);
 if (sheltersLayerGroup) sheltersLayerGroup.addTo(map);

 btnToggleLayers.addEventListener('click', () => {
 const overlay = document.getElementById('layers-overlay');
 overlay.classList.remove('hidden');
 setTimeout(() => overlay.classList.add('active'), 10);
 });

 // Layer Dialog Listeners
 document.getElementById('btn-layers-close').addEventListener('click', () => {
 const overlay = document.getElementById('layers-overlay');
 overlay.classList.remove('active');
 setTimeout(() => overlay.classList.add('hidden'), 300);
 });

 document.getElementById('toggle-shelters').addEventListener('change', (e) => {
 if (e.target.checked) {
 if (sheltersLayerGroup) sheltersLayerGroup.addTo(map);
 } else {
 if (sheltersLayerGroup) map.removeLayer(sheltersLayerGroup);
 }
 });

 document.getElementById('toggle-hazard').addEventListener('change', (e) => {
 if (e.target.checked) {
 if (hazardLayer) hazardLayer.addTo(map);
 } else {
 if (hazardLayer) map.removeLayer(hazardLayer);
 }
 });

 document.getElementById('toggle-congestion').addEventListener('change', (e) => {
 if (e.target.checked) {
 if (congestionLayer) congestionLayer.addTo(map);
 } else {
 if (congestionLayer) map.removeLayer(congestionLayer);
 }
 });

 document.getElementById('toggle-relief').addEventListener('change', (e) => {
 if (e.target.checked) {
 if (reliefLayer) reliefLayer.addTo(map);
 } else {
 if (reliefLayer) map.removeLayer(reliefLayer);
 }
 });

 const toggleSafeEdges = document.getElementById('toggle-safe-edges');
 if (toggleSafeEdges) {
 toggleSafeEdges.addEventListener('change', (e) => {
 if (e.target.checked) {
 drawAllSafeEdges();
 if (safeEdgesLayerGroup) safeEdgesLayerGroup.addTo(map);
 } else {
 if (safeEdgesLayerGroup) map.removeLayer(safeEdgesLayerGroup);
 }
 });
 }

 const btnGpsLocation = document.getElementById('btn-gps-location');
 if (btnGpsLocation) {
 btnGpsLocation.addEventListener('click', () => {
 isManualLocation = false;
 requestLocation();
 requestOrientationPermission();
 requestNotificationPermission();
 triggerHapticTick();
 });
 }

 const btnFocusModel = document.getElementById('btn-focus-model');
 if (btnFocusModel) {
 btnFocusModel.addEventListener('click', () => {
 const targetLat = KAMAKURA_CENTER[0];
 const targetLng = KAMAKURA_CENTER[1];
 currentLocation = { lat: targetLat, lng: targetLng };
 
 // Smooth fly animation to the model area (Yuigahama)
 map.flyTo(KAMAKURA_CENTER, 15, {
 duration: 1.5,
 easeLinearity: 0.25
 });
 
 updateMarker(currentLocation);
 fetchElevation(currentLocation);
 });
 }

 btnSettings.addEventListener('click', () => {
 const overlay = document.getElementById('settings-overlay');
 overlay.classList.remove('hidden');
 setTimeout(() => overlay.classList.add('active'), 10);
 });

 btnSettingsClose.addEventListener('click', () => {
 const overlay = document.getElementById('settings-overlay');
 overlay.classList.remove('active');
 setTimeout(() => overlay.classList.add('hidden'), 300);
 });

 // Initialize Lang Select
 const savedLang = localStorage.getItem('tenden-lang') || 'auto';
 langSelect.value = savedLang;

 langSelect.addEventListener('change', (e) => {
 localStorage.setItem('tenden-lang', e.target.value);
 initI18n();
 
 // 1. Re-render all shelter pins to update popup texts
 if (sheltersLayerGroup && sheltersData && sheltersData.length > 0) {
 sheltersLayerGroup.clearLayers();
 addShelterMarkers(sheltersData);
 }
 
 // 2. Re-render safe edges to update their popup texts
 if (safeEdgesLayerGroup && safeEdgesData && safeEdgesData.length > 0) {
 drawAllSafeEdges();
 }
 
 // 3. Update manual location popup if active
 if (!isEmergency && isManualLocation && userMarker && currentLocation) {
 updateMarker(currentLocation);
 }
 
 // 4. Update evacuation routes, HUD summaries, and intermediate map badges in real-time
 if (isEmergency && currentLocation) {
 recalculateRouteFromLocation(currentLocation);
 }
 });

 btnClearCache.addEventListener('click', async () => {
 const dict = i18nDict[getLanguageCode()] || i18nDict['ja'] || {};
 if ('caches' in window) {
 const keys = await caches.keys();
 for (let key of keys) {
 await caches.delete(key);
 }
  triggerDynamicIsland(dict.alertCacheTitle || "Cache Cleared", "success");
 }
 });

 btnScreenshot.addEventListener('click', () => {
 takeScreenshot();
 });

 const btnDevReset = document.getElementById('btn-dev-reset');
 if (btnDevReset) {
 btnDevReset.addEventListener('click', async () => {
 const dict = i18nDict[getLanguageCode()] || i18nDict['ja'] || {};
  const confirmMsg = dict.confirmDevReset || 'Reset PWA Cache and Service Worker?';
 if (confirm(confirmMsg)) {
 // 1. Clear Cache Storage
 if ('caches' in window) {
 const keys = await caches.keys();
 for (let key of keys) {
 await caches.delete(key);
 }
 }
 // 2. Unregister Service Workers
 if ('serviceWorker' in navigator) {
 const registrations = await navigator.serviceWorker.getRegistrations();
 for (let registration of registrations) {
 await registration.unregister();
 }
 }
 
    showCustomAlert(dict.alertResetTitle || "System Reset Complete", dict.alertResetDesc || "Cache cleared successfully", "success", () => {
 window.location.reload(true);
 });
 }
 });
 }

 const btnChangeRoute = document.getElementById('btn-change-route');
 if (btnChangeRoute) {
 btnChangeRoute.addEventListener('click', () => {
 if (activeRoutesList && activeRoutesList.length > 0) {
 showRouteSelectorHUD(activeRoutesList);
 } else if (currentLocation) {
 recalculateRouteFromLocation(currentLocation);
 }
 });
 }

 // Banner collapsible toggle
 const bannerToggle = document.getElementById('banner-toggle');
 const bannerContent = document.getElementById('banner-content-body');
 const bannerChevron = document.getElementById('banner-chevron');
 if (bannerToggle && bannerContent && bannerChevron) {
 bannerToggle.addEventListener('click', () => {
 if (bannerContent.style.display === 'none') {
 bannerContent.style.display = 'block';
 bannerChevron.style.transform = 'rotate(0deg)';
 } else {
 bannerContent.style.display = 'none';
 bannerChevron.style.transform = 'rotate(180deg)';
 }
 });
 }

 // FAB text labels click delegation to activate their corresponding button
 document.querySelectorAll('.fab-label').forEach(label => {
 label.addEventListener('click', () => {
 const btn = label.previousElementSibling;
 if (btn && btn.classList.contains('fab-btn')) {
 btn.click();
 }
 });
 });
 }

 function requestLocation() {
 if ("geolocation" in navigator) {
 const dict = i18nDict[getLanguageCode()] || i18nDict['ja'] || {};
 triggerDynamicIsland(dict.fetchingLocationLabel || " 現在地を取得中...", "info");

 const options = { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 };
 navigator.geolocation.getCurrentPosition(
 position => {
 handleLocationSuccess(position);
 },
 error => {
 console.warn("High accuracy geolocation failed, trying standard accuracy (IP/Wi-Fi)...", error);
 // Fallback to standard accuracy (which is faster and works indoors/desktops)
 navigator.geolocation.getCurrentPosition(
 position => {
 handleLocationSuccess(position);
 },
 fallbackError => {
 console.error("Standard accuracy geolocation also failed:", fallbackError);
 showLocationErrorOverlay();
 },
 { enableHighAccuracy: false, timeout: 10000 }
 );
 },
 options
 );
 } else {
 showLocationErrorOverlay();
 }
 }

 function handleLocationSuccess(position) {
 updateGPSAccuracyHUD(position.coords.accuracy);
 currentLocation = {
 lat: position.coords.latitude,
 lng: position.coords.longitude
 };
 map.setView([currentLocation.lat, currentLocation.lng], 16);
 updateMarker(currentLocation);
 fetchElevation(currentLocation);
 triggerLocationTsunamiCheck(currentLocation);
 generalizeFirstTargets(currentLocation);
 
 const dict = i18nDict[getLanguageCode()] || i18nDict['ja'] || {};
 triggerDynamicIsland(dict.locationAcquiredLabel || " 現在地を同期しました", "success");

 // Track location changes
 navigator.geolocation.watchPosition(pos => {
 updateGPSAccuracyHUD(pos.coords.accuracy);
 if (!isManualLocation) {
 currentLocation = {
 lat: pos.coords.latitude,
 lng: pos.coords.longitude
 };
 updateMarker(currentLocation);
 triggerLocationTsunamiCheck(currentLocation);
 generalizeFirstTargets(currentLocation);
 }
 
 if (isEmergency && !simulationInterval) {
 checkRouteDeviation({lat: pos.coords.latitude, lng: pos.coords.longitude});
 checkShelterArrival({lat: pos.coords.latitude, lng: pos.coords.longitude});
 }
 }, err => console.warn("Watch position error:", err), { enableHighAccuracy: false, timeout: 10000 });
 }

 function showLocationErrorOverlay() {
 updateGPSAccuracyHUD(null);
 const overlay = document.getElementById('error-overlay');
 if (overlay) {
 overlay.classList.remove('hidden');
 setTimeout(() => overlay.classList.add('active'), 10);
 }
 }

 function updateMarker(loc) {
 if (userMarker) {
 userMarker.setLatLng([loc.lat, loc.lng]);
 } else {
 const userIcon = L.divIcon({
 className: 'user-marker-container',
 html: '<div class="user-marker-inner"><div class="user-marker-arrow"></div></div>',
 iconSize: [26, 26],
 iconAnchor: [13, 13]
 });
 userMarker = L.marker([loc.lat, loc.lng], { icon: userIcon }).addTo(map);
 }

 // Keep compass arrow rotated and visible
 const arrow = document.querySelector('.user-marker-arrow');
 if (arrow) {
 const isCompassEnabled = localStorage.getItem('tenden-smart-compass') !== 'false';
 arrow.style.display = (isCompassEnabled && lastHeading !== 0) ? 'block' : 'none';
 if (lastHeading !== 0) {
 arrow.style.transform = `rotate(${lastHeading}deg)`;
 }
 }

 // Show a simple thought-provoking popup if user placed the pin manually
 if (isManualLocation) {
 // Cancel any pending popup close timeouts
 if (popupTimeoutId) {
 clearTimeout(popupTimeoutId);
 popupTimeoutId = null;
 }

 const dict = i18nDict[getLanguageCode()] || i18nDict['ja'] || {};
 // Extremely concise: a single horizontal query phrase to prevent awkward wrapping
  const queryText = dict.manualPinPopupText || 'How would you evacuate from here?';

 userMarker.bindPopup(`
 <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; text-align: center; white-space: nowrap; padding: 2px 4px; font-size: 11px; font-weight: 600; color: #ff3b30;">
 ${queryText}
 </div>
 `, {
 closeButton: false,
 offset: [0, -10],
 className: 'gsi-thought-popup'
 }).openPopup();

 // Automatically close the popup after 3 seconds to keep the map clean and unobstructed
 popupTimeoutId = setTimeout(() => {
 if (userMarker && userMarker.getPopup && userMarker.getPopup()) {
 userMarker.closePopup();
 }
 popupTimeoutId = null;
 }, 3000);
 } else {
 // Cancel timeout and close safely
 if (popupTimeoutId) {
 clearTimeout(popupTimeoutId);
 popupTimeoutId = null;
 }
 // Leaflet unbindPopup/closePopup can throw errors if no popup is currently bound.
 // Safely check using getPopup() first to prevent TypeError app crash!
 if (userMarker.getPopup && userMarker.getPopup()) {
 userMarker.closePopup();
 userMarker.unbindPopup();
 }
 }
 }

 async function fetchElevation(loc) {
 try {
 const url = `https://cyberjapandata2.gsi.go.jp/general/dem/scripts/getelevation.php?lon=${loc.lng}&lat=${loc.lat}&outtype=JSON`;
 const response = await fetch(url);
 const data = await response.json();
 const el = data.elevation;
 if (el !== undefined && el !== null && el !== '-----') {
 document.getElementById('elevation-m').innerText = Math.round(el * 10) / 10;
 } else {
 document.getElementById('elevation-m').innerText = '0.0';
 }
 } catch (e) {
 console.error("Elevation API failed", e);
 }
 }

 const SCENARIOS = {
 1: {
  title: "大津波警報・避難指示",
  time: "15分後（15:30）",
 height: "10m",
 locations: {
 'a': {
 name: "地点A: 由比ヶ浜海岸 (最危険地帯/海抜0.4m)",
 desc: "青いルートに沿って直ちに高台（御成小学校）へ避難してください",
 start: { lat: 35.3111, lng: 139.5467 }, // Yuigahama Beach
 goal: { lat: 35.3190, lng: 139.5510 }, // Onari Elementary
 goal2: { lat: 35.3180, lng: 139.5400 }, // Kamakura City Hall
 mainRoute: [
 [35.3111, 139.5467],
 [35.3150, 139.5480],
 [35.3190, 139.5510]
 ],
 subRoute: [
 [35.3111, 139.5467],
 [35.3140, 139.5420],
 [35.3180, 139.5400]
 ]
 },
 'b': {
 name: "地点B: 和田塚駅周辺 (市街中間地帯/海抜0.8m)",
 desc: "青いルートに沿って最寄りの高台（鎌倉市役所）へ避難してください",
 start: { lat: 35.3135, lng: 139.5448 }, // Wadazuka Station
 goal: { lat: 35.3180, lng: 139.5400 }, // Kamakura City Hall
 goal2: { lat: 35.3190, lng: 139.5510 }, // Onari Elementary
 mainRoute: [
 [35.3135, 139.5448],
 [35.3155, 139.5415],
 [35.3180, 139.5400]
 ],
 subRoute: [
 [35.3135, 139.5448],
 [35.3145, 139.5480],
 [35.3190, 139.5510]
 ]
 }
 }
 },
 2: {
  title: "津波警報・避難推奨",
  time: "30分後（15:45）",
 height: "3m",
 locations: {
 'a': {
 name: "地点A: 七里ヶ浜海岸 (最危険地帯/海抜0.1m)",
 desc: "青い避難ルートに沿って高台（鎌倉プリンスホテル方面）へ避難してください",
 start: { lat: 35.3050, lng: 139.5100 }, // Shichirigahama Beach Parking
 goal: { lat: 35.3102, lng: 139.5173 }, // Kamakura Prince Hotel high ground
 goal2: { lat: 35.3085, lng: 139.5100 }, // Sub high ground
 mainRoute: [
 [35.3050, 139.5100],
 [35.3080, 139.5135],
 [35.3102, 139.5173]
 ],
 subRoute: [
 [35.3050, 139.5100],
 [35.3075, 139.5105],
 [35.3085, 139.5100]
 ]
 },
 'b': {
 name: "地点B: 七里ヶ浜駅前 (江ノ電沿線/海抜3.0m)",
 desc: "青い避難ルートに沿って最寄りの高台（七里ガ浜東高台公園）へ避難してください",
 start: { lat: 35.3065, lng: 139.5165 }, // Shichirigahama Station
 goal: { lat: 35.3125, lng: 139.5135 }, // Shichirigahama Higashi Park
 goal2: { lat: 35.3102, lng: 139.5173 }, // Kamakura Prince Hotel
 mainRoute: [
 [35.3065, 139.5165],
 [35.3100, 139.5155],
 [35.3125, 139.5135]
 ],
 subRoute: [
 [35.3065, 139.5165],
 [35.3080, 139.5162],
 [35.3102, 139.5173]
 ]
 }
 }
 }
 };

 function triggerEmergencyMode(isTest = false, scenarioId = 1, locationId = 'a') {
 isEmergency = true;
 isWaitingForPinDrop = false;
 isEvacuationCompleted = false; // Reset completed status
 activeScenarioId = scenarioId;
 activeLocationId = locationId;
 if (!isTest) {
 document.body.classList.add('emergency-mode');
 }

 // 繧ｹ繝槭・迚ｹ蛹匁ｩ溯・縺ｮ蛻晄悄蛹・
 requestWakeLock();
 requestNotificationPermission();
 requestOrientationPermission();
 
 document.getElementById('bottom-normal-actions').classList.add('hidden');
 document.getElementById('btn-test-alert').classList.add('hidden');
 document.getElementById('evacuation-banner').classList.remove('hidden');
 document.getElementById('disaster-details').style.display = 'block';
 
 // Load scenario parameters
 const sc = SCENARIOS[scenarioId] || SCENARIOS[1];
 const scLoc = sc.locations[locationId] || sc.locations['a'];
 
 // Dynamically update banner content
 document.getElementById('i18n-evac-title').innerText = sc.title;
 document.getElementById('i18n-evac-desc').innerText = scLoc.desc;
 
 const detailsEl = document.getElementById('disaster-details');
 const timeLabel = sc.isLandslide ? "到達予測:" : "予想到達時間";
 const heightLabel = sc.isLandslide ? "土砂到達予測:" : "予想津波高さ:";
 detailsEl.innerHTML = `<span>${timeLabel}</span> <strong>${sc.time}</strong> | <span>${heightLabel}</span> <strong>${sc.height}</strong>`;
 
 // Trigger speech synthesis evac start instruction
 speakI18n('speechEvacStart');
 triggerDynamicIsland(`${sc.title}: ${scLoc.desc}`, 'warning');
 
 // Dynamically update banner content based on whether the drill is inside the Kamakura research model area
  let localizedDesc = scLoc.desc;
  const isKamakura = isInModelArea(currentLocation);
  if (!isKamakura) {
    const lang = getLanguageCode();
    const generalDescs = {
      'ja': '直ちに最寄りの安全な高台（第一目標）へ避難してください。',
      'en': 'Evacuate immediately to the nearest safe highland (First Goal).',
      'zh': 'Evacuate immediately to nearby safe high ground.',
      'ko': 'Evacuate immediately to nearby safe high ground.',
    };
    localizedDesc = generalDescs[lang] || generalDescs['en'];
  }
  document.getElementById('i18n-evac-desc').innerText = localizedDesc;

  if (isTest) {
  // If we are outside Kamakura, keep the user's custom location! DO NOT fallback to Kamakura scLoc.start!
  if (!currentLocation) {
  isManualLocation = true;
  currentLocation = { lat: scLoc.start.lat, lng: scLoc.start.lng };
  }
  map.setView([currentLocation.lat, currentLocation.lng], 16);
  updateMarker(currentLocation);
  
  // Generate dynamic routes from the pin location and show the modern bottom-sheet selector
  recalculateRouteFromLocation(currentLocation);
  } else {
 // Real emergency: calculate routes automatically and default to B
 recalculateRouteFromLocation(currentLocation);
 }
 
 if ("vibrate" in navigator && !isTest) {
 navigator.vibrate([200, 100, 200]);
 }
 }

 function resetEmergencyMode() {
 isEmergency = false;
 isEvacuationCompleted = false;
 releaseWakeLock();

 // Close route selection modal if open
 const routeOverlay = document.getElementById('route-overlay');
 if (routeOverlay) {
 routeOverlay.classList.remove('active');
 routeOverlay.classList.add('hidden');
 }
 pendingRouteArgs = null;

 // Stop evacuation simulation interval
 if (simulationInterval) {
 clearInterval(simulationInterval);
 simulationInterval = null;
 }

 // Clear evacuation route layer
 if (routeLayerGroup) {
 routeLayerGroup.clearLayers();
 }

 // Remove emergency dark class
 document.body.classList.remove('emergency-mode');

 // Toggle UI visibility
 document.getElementById('bottom-normal-actions').classList.remove('hidden');
 document.getElementById('btn-test-alert').classList.remove('hidden');
 document.getElementById('evacuation-banner').classList.add('hidden');
 document.getElementById('banner-content-expanded').style.display = 'none';
 document.getElementById('banner-chevron').style.transform = 'rotate(0deg)';

 // Reset visual style of banner in case deviation error triggered it
 const banner = document.getElementById('evacuation-banner');
 banner.style.borderLeftColor = 'var(--primary)';
 
 // Reset marker to current location (or default if null)
 if (currentLocation) {
 map.setView([currentLocation.lat, currentLocation.lng], 15);
 updateMarker(currentLocation);
 fetchElevation(currentLocation);
 } else {
 map.setView(KAMAKURA_CENTER, 14);
 if (userMarker) {
 map.removeLayer(userMarker);
 userMarker = null;
 }
 document.getElementById('elevation-m').innerText = '--';
 }

 // Restart location tracking
 requestLocation();
 isPinLocked = false; // Reset lock on full reset
 }

 // 笏笏 繝ｫ繝ｼ繝磯∈謚槭Δ繝ｼ繝繝ｫ 笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏
 function showRouteSelectionModal(scenarioId, locationId, scLoc) {
 const routeKey = `${scenarioId}_${locationId}`;
 const candidates = routeData[routeKey] || [];

 const CONG_LABELS = { low: 'Low', medium: 'Medium', high: 'High' };
 const CONG_BAR = { low: '笆笆｡笆｡ (1/3)', medium: '笆笆笆｡ (2/3)', high: '笆笆笆 (3/3)' };

 const container = document.getElementById('route-options-container');
 container.innerHTML = '';

 candidates.forEach(route => {
 const congLabel = CONG_LABELS[route.congestion_score] || '-';
 const congBar = CONG_BAR[route.congestion_score] || '笆｡笆｡笆｡';
 
 const btnHtml = `
 <button class="route-option-btn" data-route-id="${route.id}"
 style="text-align:left; padding:16px; margin-bottom:10px; border-radius:14px; border:2px solid ${route.color}40;
 background:${route.color}15; cursor:pointer; transition:all 0.2s; width:100%; display:flex; flex-direction:column; gap:8px;">
 <div style="display:flex; justify-content:space-between; align-items:center; width:100%;">
 <strong style="color:${route.color}; font-size:1.15rem; letter-spacing:0.05em;">ルート${route.id}</strong>
 <span style="font-size:0.8rem; font-weight:600; opacity:0.8; color:var(--hud-text);">選択</span>
 </div>
 <div style="display:flex; justify-content:space-between; width:100%; font-size:0.8rem; color:var(--hud-text); opacity:0.9;">
 <span> ${route.distance_m}m (約${route.estimated_min}分)</span>
 <span>豺ｷ髮大ｺｦ: <span style="color:${route.color};">${congBar}</span></span>
 </div>
 </button>
 `;
 container.insertAdjacentHTML('beforeend', btnHtml);
 });

 // Add fallback option and disclaimer
 container.insertAdjacentHTML('beforeend', `
 <button class="route-option-btn" data-route-id="fallback"
 style="text-align:center; padding:14px; border-radius:12px; border:1px solid rgba(255,255,255,0.2);
 background:rgba(255,255,255,0.05); cursor:pointer; font-size:0.95rem; font-weight:600; width:100%; margin-top:6px; color:var(--hud-text);">
 推奨のルートを使用する
 </button>
 <div style="margin-top:16px; text-align:center; font-size:0.75rem; opacity:0.6; color:var(--hud-text); line-height:1.4;">
 ※このルートはあくまで参考情報です。<br>実際の避難時は現場の状況（倒壊や浸水など）を優先してください。
 </div>
 `);

 // Bind events
 container.querySelectorAll('.route-option-btn').forEach(btn => {
 btn.addEventListener('click', () => {
 const routeId = btn.getAttribute('data-route-id');
 // Close modal
 const overlay = document.getElementById('route-overlay');
 overlay.classList.remove('active');
 setTimeout(() => overlay.classList.add('hidden'), 300);

 // Draw selected route
 const selected = routeId === 'fallback' ? null : candidates.find(r => r.id === routeId);
 drawEvacuationRoutes(currentLocation, scLoc, selected);
 simulateEvacuation();
 });
 });

 // Show modal
 const overlay = document.getElementById('route-overlay');
 overlay.classList.remove('hidden');
 setTimeout(() => overlay.classList.add('active'), 10);
 }

 function drawEvacuationRoutes(startLoc, scLoc, routeCandidate) {
 routeLayerGroup.clearLayers();

 if (!scLoc) {
 scLoc = SCENARIOS[1].locations['a'];
 }

 // If valid route candidate
 if (routeCandidate && routeCandidate.waypoints && routeCandidate.waypoints.length > 0) {
 let waypoints = [];
 const firstPt = routeCandidate.waypoints[0];
 const dist = L.latLng(startLoc.lat, startLoc.lng).distanceTo(L.latLng(firstPt[0], firstPt[1]));
 
 // Do not snap back to the raw pin coordinate to prevent cutting through terrain
 waypoints = [ ...routeCandidate.waypoints ];
 
 // Multiglow neon route base line (broad pulse)
 mainRouteLine = L.polyline(waypoints, {
 color: routeCandidate.color || '#00bbff',
 className: 'route-glow-base'
 }).addTo(routeLayerGroup);

 // Multiglow neon route core line (dashed flow)
 L.polyline(waypoints, {
 color: '#ffffff', // High brightness white core for absolute neon aesthetics
 className: 'route-glow-core'
 }).addTo(routeLayerGroup);

 // Set custom route color custom property for dropping shadows dynamically in CSS!
 mainRouteLine.getElement().style.color = routeCandidate.color || '#00bbff';

 // Route type label on the map
 const midIdx = Math.floor(waypoints.length / 2);
 if (midIdx < waypoints.length) {
 const midPt = waypoints[midIdx];
 const labelIcon = L.divIcon({
 className: 'route-label-container',
 html: `<div class="route-label-pill" style="background:${routeCandidate.color || '#00bbff'}">${routeCandidate.label}</div>`,
 iconSize: [110, 22],
 iconAnchor: [55, 11]
 });
 L.marker(midPt, { icon: labelIcon }).addTo(routeLayerGroup);
 }
 } else {
 // Fallback: draw from static SCENARIOS waypoints
 const mainWaypoints = [ [startLoc.lat, startLoc.lng], ...scLoc.mainRoute ];
 mainRouteLine = L.polyline(mainWaypoints, {
 color: '#00bbff',
 className: 'route-glow-base'
 }).addTo(routeLayerGroup);

 L.polyline(mainWaypoints, {
 color: '#ffffff',
 className: 'route-glow-core'
 }).addTo(routeLayerGroup);

 mainRouteLine.getElement().style.color = '#00bbff';

 const subWaypoints = [ [startLoc.lat, startLoc.lng], ...scLoc.subRoute ];
 L.polyline(subWaypoints, {
 color: '#888888',
 weight: 3,
 opacity: 0.8,
 dashArray: '5, 10'
 }).addTo(routeLayerGroup);
 }
 }
 function drawMultipleEvacuationRoutes(startLoc, targetEdge, secondaryRoute, candidates, selectedId) {
 routeLayerGroup.clearLayers();
 activeRoutesList = candidates;
 activeSelectedRouteId = selectedId || 'A';

 candidates.forEach(candidate => {
 const isSelected = candidate.id === activeSelectedRouteId;
 const color = candidate.color || '#00bbff';
 
 if (candidate.waypoints && candidate.waypoints.length > 0) {
 let waypoints = [ ...candidate.waypoints ];
 
 let pline;
 if (isSelected) {
 // Draw dual glowing polylines for the selected active neon-luminous route
 pline = L.polyline(waypoints, {
 color: color,
 className: 'route-glow-base'
 }).addTo(routeLayerGroup);

 L.polyline(waypoints, {
 color: '#ffffff', // bright center core
 className: 'route-glow-core'
 }).addTo(routeLayerGroup);

 // Set route color property dynamically
 pline.getElement().style.color = color;
 } else {
 // Inactive alternatives are rendered as thin semi-transparent dashed lines
 pline = L.polyline(waypoints, {
 color: color,
 weight: 4.0,
 opacity: 0.35,
 dashArray: '5, 8'
 }).addTo(routeLayerGroup);
 }
 
 // Direct on-map line clicking toggles route choice!
 pline.on('click', (e) => {
 L.DomEvent.stopPropagation(e);
 selectEvacuationRoute(candidate.id);
 });

 if (isSelected) {
 mainRouteLine = pline;
 
 // Render selected route badge label at midpoint
 const midIdx = Math.floor(waypoints.length / 2);
 if (midIdx < waypoints.length) {
 const midPt = waypoints[midIdx];
 const labelIcon = L.divIcon({
 className: 'route-label-container',
 html: `<div class="route-label-pill active" style="background:${color}">${candidate.label}</div>`,
 iconSize: [120, 24],
 iconAnchor: [60, 12]
 });
 L.marker(midPt, { icon: labelIcon }).addTo(routeLayerGroup);
 }
 
 // Render X marker at blocked intersection if exists
 if (candidate.blockedPoint) {
 const blockedIcon = L.divIcon({
 className: 'blocked-point-container',
 html: `
 <div style="display:flex; flex-direction:column; align-items:center;">
 <div style="background:#ff3b30; color:white; font-size:1.2rem; line-height:1; padding:2px; border-radius:50%; box-shadow:0 2px 4px rgba(0,0,0,0.5); width:24px; height:24px; display:flex; justify-content:center; align-items:center;">
 
 </div>
 </div>
 `,
 iconSize: [24, 24],
 iconAnchor: [12, 12]
 });
 L.marker(candidate.blockedPoint, { icon: blockedIcon }).addTo(routeLayerGroup);
 }

 // Passing shelters along selected route are already shown by addShelterMarkers().
 // No extra label needed 窶・the pin color already communicates congestion status.


 // ---- PRIMARY GOAL MARKER (隨ｬ荳逶ｮ讓・ 螳牙・鬮伜床) ----
 if (targetEdge) {
 const dict = i18nDict[getLanguageCode()] || i18nDict['ja'] || {};
  const primaryGoalLabel = dict.primaryGoal || 'First Goal';
 let edgeName = targetEdge.name;
 if (dict.elementarySchool) edgeName = edgeName.replace('小学校', dict.elementarySchool);
 if (dict.juniorHighSchool) edgeName = edgeName.replace('中学校', dict.juniorHighSchool);
 if (dict.shrinePrecincts) edgeName = edgeName.replace('境内', dict.shrinePrecincts);
 if (dict.learningCenter) edgeName = edgeName.replace('学習センター', dict.learningCenter);

 const goalIcon = L.divIcon({
 className: '',
 html: `
 <div style="display:flex; flex-direction:column; align-items:center;">
 <div style="background:#0071e3; color:white; font-size:0.72rem; font-weight:700; padding:4px 10px; border-radius:10px; box-shadow:0 3px 8px rgba(0,113,227,0.5); white-space:nowrap; margin-bottom:4px;">
 ${primaryGoalLabel}・・{edgeName}
 </div>
 <div style="width:0; height:0; border-left:6px solid transparent; border-right:6px solid transparent; border-top:8px solid #0071e3;"></div>
 </div>
 `,
 iconSize: [180, 40],
 iconAnchor: [90, 40]
 });
 L.marker([targetEdge.lat, targetEdge.lng], { icon: goalIcon, zIndexOffset: 1000 }).addTo(routeLayerGroup);
 }

 // ---- SECONDARY ROUTE (隨ｬ莠檎岼讓・ 驕ｿ髮｣謇縺ｸ縺ｮ蛻・ｲ千ｴ邱・ ----
 if (secondaryRoute && secondaryRoute.waypoints && secondaryRoute.waypoints.length > 0) {
 // Find the true branching point:
 // Walk backward from the shelter towards the start location along the secondary route,
 // and find the first waypoint that is extremely close (within 20m) to the primary route.
 let branchMainIdx = 0;
 let branchSecIdx = 0;
 let foundBranch = false;

 for (let i = secondaryRoute.waypoints.length - 1; i >= 0; i--) {
 const secPt = L.latLng(secondaryRoute.waypoints[i][0], secondaryRoute.waypoints[i][1]);
 let minD = Infinity;
 let minIdx = 0;

 waypoints.forEach((wp, idx) => {
 const d = secPt.distanceTo(L.latLng(wp[0], wp[1]));
 if (d < minD) {
 minD = d;
 minIdx = idx;
 }
 });

 // 20 meters threshold for street matching (allow for OSRM grid deviations)
 if (minD < 20.0) {
 branchMainIdx = minIdx;
 branchSecIdx = i;
 foundBranch = true;
 break;
 }
 }

 const branchPoint = waypoints[branchMainIdx];
 const secondaryWaypoints = [branchPoint, ...secondaryRoute.waypoints.slice(branchSecIdx)];

 L.polyline(secondaryWaypoints, {
 color: '#ff9500',
 weight: 6.5,
 opacity: 0.8,
 dashArray: '10, 10'
 }).addTo(routeLayerGroup);

 // Branch divergence label
 const dict = i18nDict[getLanguageCode()] || i18nDict['ja'] || {};
  const branchToShelterLabel = dict.branchToShelter || 'Branch to Shelter';
 const branchIcon = L.divIcon({
 className: '',
 html: `<div style="background:#ff9500; color:white; font-size:0.65rem; font-weight:700; padding:3px 7px; border-radius:8px; white-space:nowrap; box-shadow:0 2px 5px rgba(255,149,0,0.4);">竊・${branchToShelterLabel}</div>`,
 iconSize: [110, 22],
 iconAnchor: [55, 11]
 });
 L.marker(branchPoint, { icon: branchIcon, zIndexOffset: 900 }).addTo(routeLayerGroup);

 // Secondary goal marker
 const lastPt = secondaryRoute.waypoints[secondaryRoute.waypoints.length - 1];
 const shelterName = secondaryRoute.target ? secondaryRoute.target.name : '避難所';
  const secondaryGoalLabel = dict.secondaryGoal || 'Second Goal';
 
 let localizedShelterName = shelterName;
 if (dict.shelterWord) localizedShelterName = localizedShelterName.replace('避難所', dict.shelterWord);
 if (dict.elementarySchool) localizedShelterName = localizedShelterName.replace('小学校', dict.elementarySchool);
 if (dict.juniorHighSchool) localizedShelterName = localizedShelterName.replace('中学校', dict.juniorHighSchool);
 if (dict.shrinePrecincts) localizedShelterName = localizedShelterName.replace('境内', dict.shrinePrecincts);
 if (dict.learningCenter) localizedShelterName = localizedShelterName.replace('学習センター', dict.learningCenter);

 const shelterIcon = L.divIcon({
 className: '',
 html: `
 <div style="display:flex; flex-direction:column; align-items:center;">
 <div style="background:#ff9500; color:white; font-size:0.72rem; font-weight:700; padding:4px 10px; border-radius:10px; box-shadow:0 3px 8px rgba(255,149,0,0.5); white-space:nowrap; margin-bottom:4px;">
 ${secondaryGoalLabel}・・{localizedShelterName}
 </div>
 <div style="width:0; height:0; border-left:6px solid transparent; border-right:6px solid transparent; border-top:8px solid #ff9500;"></div>
 </div>
 `,
 iconSize: [200, 40],
 iconAnchor: [100, 40]
 });
 L.marker(lastPt, { icon: shelterIcon, zIndexOffset: 900 }).addTo(routeLayerGroup);
 }
 }
 }
 });
 }

 async function selectEvacuationRoute(routeId) {
 if (!currentLocation) return;
 
 // Stop current evacuation simulation interval
 if (simulationInterval) {
 clearInterval(simulationInterval);
 simulationInterval = null;
 }

 const targetEdge = await findNearestSafeEdge(currentLocation);
 
 activeSelectedRouteId = routeId;
 
 // Redraw multiple routes with new active selection
 drawMultipleEvacuationRoutes(currentLocation, targetEdge, activeSecondaryRoute, activeRoutesList, activeSelectedRouteId);
 
 // Highlight active card in HUD bottom sheet
 updateRouteSelectorUI(activeSelectedRouteId);

 // Update emergency HUD banner description with chosen destination
 const selectedRoute = activeRoutesList.find(r => r.id === activeSelectedRouteId);
 if (selectedRoute) {
 const dict = i18nDict[getLanguageCode()] || i18nDict['ja'] || {};
  const summaryTemplate = dict.evacStartSummary || 'Starting evacuation via {routeLabel} ({routeCharacteristics})';
  const characteristicsPart = selectedRoute.characteristics.split(',')[0];
 const summaryText = summaryTemplate
 .replace('{routeLabel}', selectedRoute.label)
 .replace('{routeCharacteristics}', characteristicsPart);
 document.getElementById('i18n-evac-desc').innerText = summaryText;

 // Voice Navigation speech for route choice
 speakI18n('speechRouteSelect', { routeLabel: selectedRoute.label });
  triggerDynamicIsland((dict.routeSelectSuccess || 'Selected Route {routeLabel}').replace('{routeLabel}', selectedRoute.label), 'success');
 }

 // Restart simulation along new selected path
 simulateEvacuation();

 // Safe auto-close bottom sheet to return to the interactive map
 hideRouteSelectorHUD();
 }

 function getAutoBestRouteId(candidates) {
 // Priority 1: If there's a blocked intersection, we must detour (Route B)
 if (candidates.some(c => c.id === 'B' && c.blockedPoint)) return 'B';
 // Priority 2: Otherwise shortest route is safe
 return 'A';
 }

 function hideRouteSelectorHUD() {
 const overlay = document.getElementById('route-overlay');
 if (overlay) {
 overlay.classList.remove('active');
 setTimeout(() => overlay.classList.add('hidden'), 350);
 }

 // Restore header/bottom HUD panel visibility on mobile vertically
 const hudBottom = document.querySelector('.hud-bottom');
 if (hudBottom) hudBottom.classList.remove('hidden-for-route');

 const banner = document.getElementById('evacuation-banner');
 if (banner) banner.classList.remove('hidden-for-route');
 }

 function updateRouteSelectorUI(selectedId) {
 const container = document.getElementById('route-options-container');
 if (!container) return;
 
 container.querySelectorAll('.route-option-btn.compact-route-btn').forEach(btn => {
 const btnId = btn.getAttribute('data-route-id');
 const targetColor = btn.getAttribute('data-color');
 if (btnId === selectedId) {
 btn.classList.add('active');
 btn.style.borderColor = targetColor;
 btn.style.boxShadow = `0 4px 16px ${targetColor}44`;
 btn.style.opacity = '1';
 btn.style.transform = 'scale(1.02)';
 } else {
 btn.classList.remove('active');
 btn.style.borderColor = 'transparent';
 btn.style.boxShadow = 'none';
 btn.style.opacity = '0.7';
 btn.style.transform = 'scale(1)';
 }
 });
 }

 function showRouteSelectorHUD(candidates) {
 const container = document.getElementById('route-options-container');
 if (!container) return;
 
 // Temporarily fade out background emergency controls & banners
 const hudBottom = document.querySelector('.hud-bottom');
 if (hudBottom) hudBottom.classList.add('hidden-for-route');

 const banner = document.getElementById('evacuation-banner');
 if (banner) banner.classList.add('hidden-for-route');

 container.innerHTML = '';
 
 // --- 1. Auto-Apply Button ---
 const bestRouteId = getAutoBestRouteId(candidates);
 const autoBtn = document.createElement('button');
 autoBtn.className = 'route-option-btn auto-best-btn';
 autoBtn.innerHTML = `
 <div style="font-size:1.1rem; font-weight:800; color:var(--primary); margin-bottom:2px;">最適ルートを自動計算</div>
 <div style="font-size:0.75rem; color:var(--text-light);">総合的に判断し、最適な経路を自動で選びます</div>
 `;
 autoBtn.style.border = '2px solid var(--primary)';
 autoBtn.style.background = 'linear-gradient(135deg, rgba(0, 113, 227, 0.1) 0%, rgba(52, 199, 89, 0.1) 100%)';
 autoBtn.style.borderRadius = '12px';
 autoBtn.style.padding = '14px';
 autoBtn.style.cursor = 'pointer';
 autoBtn.style.width = '100%';
 autoBtn.addEventListener('click', () => {
 selectEvacuationRoute(bestRouteId);
 });
 container.appendChild(autoBtn);
 
 // --- 2. Compact Route Options ---
 const optionsWrapper = document.createElement('div');
 optionsWrapper.style.display = 'flex';
 optionsWrapper.style.flexDirection = 'column';
 optionsWrapper.style.gap = '8px';
 optionsWrapper.style.marginTop = '12px';
 
 const dict = i18nDict[getLanguageCode()] || i18nDict['ja'] || {};
 candidates.forEach(c => {
 const isSelected = c.id === activeSelectedRouteId;
 const targetColor = c.color || '#00bbff';
 
 let tagText = '';
  if (c.id === 'B') tagText = dict.routeAvoid || 'Avoid Congestion';
  else if (c.id === 'A') tagText = dict.routeShortest || 'Shortest Distance';
  else if (c.id === 'D') tagText = dict.routeDispersal || 'Dispersed Evacuation';
  else if (c.id === 'C') tagText = dict.routeBarrier || 'Barrier-Free / Accessible';
 
 const btn = document.createElement('button');
 btn.className = `route-option-btn compact-route-btn ${isSelected ? 'active' : ''}`;
 btn.setAttribute('data-route-id', c.id);
 btn.setAttribute('data-color', targetColor);
 
 // Simple styling
 btn.style.padding = '12px 16px';
 btn.style.display = 'flex';
 btn.style.justifyContent = 'space-between';
 btn.style.alignItems = 'center';
 btn.style.borderRadius = '12px';
 btn.style.border = '2px solid transparent';
 btn.style.background = 'var(--glass-bg)';
 btn.style.cursor = 'pointer';
 btn.style.width = '100%';
 btn.style.transition = 'all 0.25s ease';
 
 if (isSelected) {
 btn.style.borderColor = targetColor;
 btn.style.boxShadow = `0 4px 16px ${targetColor}44`;
 btn.style.opacity = '1';
 btn.style.transform = 'scale(1.02)';
 } else {
 btn.style.opacity = '0.7';
 }
 
 btn.innerHTML = `
 <div style="display:flex; align-items:center; gap:12px;">
 <div style="width:16px; height:16px; border-radius:50%; background:${targetColor};"></div>
 <div style="font-size:0.95rem; font-weight:700; color:var(--hud-text); text-align:left;">${c.label}</div>
 </div>
 <div style="display:flex; flex-direction:column; align-items:flex-end;">
 <span style="font-size:0.7rem; padding:2px 6px; border-radius:4px; font-weight:600; background:${targetColor}22; color:${targetColor}; margin-bottom:4px;">${tagText}</span>
 <div style="font-size:0.8rem; font-weight:700; color:var(--hud-text); opacity:0.9;">${c.estimated_min}分</div>
 </div>
 `;
 
 btn.addEventListener('click', () => {
 selectEvacuationRoute(c.id);
 });
 optionsWrapper.appendChild(btn);
 });
 
 container.appendChild(optionsWrapper);

 // Show overlay with animation
 const overlay = document.getElementById('route-overlay');
 if (overlay) {
 overlay.classList.remove('hidden');
 setTimeout(() => overlay.classList.add('active'), 10);
 }
 }

 // --- DYNAMIC DETOUR ROUTING (Turf.js) ---
 async function fetchOSRMRouteWithDetour(startLoc, endLoc) {
 if (!window.turf || !congestionGeojsonData) return null;
 
 // 1. Fetch straight (shortest) OSRM route
 let directUrl = `https://routing.openstreetmap.de/routed-foot/route/v1/foot/${startLoc.lng},${startLoc.lat};${endLoc.lng},${endLoc.lat}?overview=full&geometries=geojson`;
 let directData = null;
 try {
 const res = await fetch(directUrl);
 directData = await res.json();
 } catch (e) { return null; }
 
 if (!directData || directData.code !== 'Ok' || !directData.routes || directData.routes.length === 0) return null;
 
 const directRouteCoords = directData.routes[0].geometry.coordinates; // [lng, lat]
 const directLine = turf.lineString(directRouteCoords);
 
 // 2. Filter congestion polygons for high/medium
 const dangerousFeatures = congestionGeojsonData.features.filter(f => 
 f.properties && (f.properties.level === 'high' || f.properties.level === 'medium')
 );
 
 if (dangerousFeatures.length === 0) return null; // No need for detour
 
 let intersects = false;
 let intersectPoint = null;
 
 for (const feat of dangerousFeatures) {
 if (feat.geometry.type === 'LineString' || feat.geometry.type === 'MultiLineString') {
 const intersection = turf.lineIntersect(directLine, feat);
 if (intersection.features.length > 0) {
 intersects = true;
 intersectPoint = intersection.features[0].geometry.coordinates;
 break;
 }
 } else if (feat.geometry.type === 'Polygon' || feat.geometry.type === 'MultiPolygon') {
 // If congestion is represented as polygons
 const intersection = turf.lineIntersect(directLine, feat);
 if (intersection.features.length > 0) {
 intersects = true;
 intersectPoint = intersection.features[0].geometry.coordinates;
 break;
 }
 }
 }
 
 if (!intersects || !intersectPoint) return null;
 
 // 3. Calculate a safe detour point (via)
 const startPt = turf.point([startLoc.lng, startLoc.lat]);
 const endPt = turf.point([endLoc.lng, endLoc.lat]);
 const intersectPt = turf.point(intersectPoint);
 
 const currentBearing = turf.bearing(startPt, endPt);
 // Orthogonal offset (90 degrees), 250 meters away
 const detourBearing = currentBearing + 90;
 const detourDistance = 0.25; // 250m in km
 const detourPoint = turf.destination(intersectPt, detourDistance, detourBearing, {units: 'kilometers'});
 const dCoords = detourPoint.geometry.coordinates;
 
 // 4. Request new route with via point
 let detourUrl = `https://routing.openstreetmap.de/routed-foot/route/v1/foot/${startLoc.lng},${startLoc.lat};${dCoords[0]},${dCoords[1]};${endLoc.lng},${endLoc.lat}?overview=full&geometries=geojson`;
 try {
 const res = await fetch(detourUrl);
 const dData = await res.json();
 if (dData.code === 'Ok' && dData.routes && dData.routes.length > 0) {
 return {
 waypoints: dData.routes[0].geometry.coordinates.map(c => [c[1], c[0]]),
 distance: Math.round(dData.routes[0].distance),
 blockedPoint: [intersectPoint[1], intersectPoint[0]] // [lat, lng] of the intersection
 };
 }
 } catch (e) {
 console.warn("Detour fetch failed", e);
 }
 
 return null;
 }

 async function recalculateRouteFromLocation(loc) {
 if (!isEmergency) return;
 
 // Stop current evacuation simulation interval
 if (simulationInterval) {
 clearInterval(simulationInterval);
 simulationInterval = null;
 }

 const targetEdge = await findNearestSafeEdge(loc);
 const bestShelter = findBestShelter(loc); // We keep this to show the best shelter if we want, but our main destination is targetEdge.
 
 if (!targetEdge) {
 console.warn("No safe edge found");
 return;
 }

 // We will generate 3 candidate routes (A, B, C)
 let candidates = [];
 
 // Calculate Pin-to-Approach slope in % (dynamic calculation)
 let startElevation = 0;
 const elevationEl = document.getElementById('elevation-m');
 if (elevationEl && elevationEl.innerText !== '--') {
 startElevation = parseFloat(elevationEl.innerText);
 }

 // 1. Fetch routes online if available via OSRM, otherwise fallback locally
 let routeB = null; // Candidate B (Congestion-avoidance)
 let routeA = null; // Candidate A (Load-balanced shelter)
 let routeC = null; // Candidate C (Flat/Physical)
 
 // Try OSRM Online for nearest safe edge
 const osrmUrls = {
 nearest: [
 `https://routing.openstreetmap.de/routed-foot/route/v1/foot/${loc.lng},${loc.lat};${targetEdge.lng},${targetEdge.lat}?overview=full&geometries=geojson`,
 `https://router.project-osrm.org/route/v1/foot/${loc.lng},${loc.lat};${targetEdge.lng},${targetEdge.lat}?overview=full&geometries=geojson`
 ]
 };

 // Try to fetch OSRM Route for nearest shelter (used for Route B basic snapping online)
 let onlineNearestWaypoints = null;
 let onlineNearestDistance = 0;
 for (let url of osrmUrls.nearest) {
 try {
 // Safe cross-browser timeout
 const controller = new AbortController();
 const timeoutId = setTimeout(() => controller.abort(), 2500);
 const response = await fetch(url, { signal: controller.signal });
 clearTimeout(timeoutId);
 const data = await response.json();
 if (data.code === 'Ok' && data.routes && data.routes.length > 0) {
 onlineNearestWaypoints = data.routes[0].geometry.coordinates.map(c => [c[1], c[0]]);
 onlineNearestDistance = Math.round(data.routes[0].distance);
 break;
 }
 } catch (e) {
 console.warn("OSRM failed for nearest shelter", e);
 }
 }

 // Try to fetch OSRM Route for another safe edge (load-balanced) if we want to provide Route D
 // For now, let's just use the best shelter as the alternative destination for Route D if we need it.
 let onlineBestWaypoints = null;
 let onlineBestDistance = 0;
 if (bestShelter && targetEdge && bestShelter.id !== targetEdge.id) {
 const bestUrls = [
 `https://routing.openstreetmap.de/routed-foot/route/v1/foot/${loc.lng},${loc.lat};${bestShelter.lng},${bestShelter.lat}?overview=full&geometries=geojson`,
 `https://router.project-osrm.org/route/v1/foot/${loc.lng},${loc.lat};${bestShelter.lng},${bestShelter.lat}?overview=full&geometries=geojson`
 ];
 for (let url of bestUrls) {
 try {
 const controller = new AbortController();
 const timeoutId = setTimeout(() => controller.abort(), 2500);
 const response = await fetch(url, { signal: controller.signal });
 clearTimeout(timeoutId);
 const data = await response.json();
 if (data.code === 'Ok' && data.routes && data.routes.length > 0) {
 onlineBestWaypoints = data.routes[0].geometry.coordinates.map(c => [c[1], c[0]]);
 onlineBestDistance = Math.round(data.routes[0].distance);
 break;
 }
 } catch (e) {
 console.warn("OSRM failed for alternative route", e);
 }
 }
 }

 const dict = i18nDict[getLanguageCode()] || i18nDict['ja'] || {};
 let localizedTargetEdgeName = targetEdge.name;
 if (dict.elementarySchool) localizedTargetEdgeName = localizedTargetEdgeName.replace('小学校', dict.elementarySchool);
 if (dict.juniorHighSchool) localizedTargetEdgeName = localizedTargetEdgeName.replace('中学校', dict.juniorHighSchool);
 if (dict.shrinePrecincts) localizedTargetEdgeName = localizedTargetEdgeName.replace('境内', dict.shrinePrecincts);
 if (dict.learningCenter) localizedTargetEdgeName = localizedTargetEdgeName.replace('学習センター', dict.learningCenter);

 // BUILD ROUTE A (譛遏ｭ繝ｫ繝ｼ繝・-> Pure nearest safe edge)
 if (onlineNearestWaypoints) {
 routeA = {
 id: 'A',
  label: dict.routeShortestLabel || '最短ルート',
 color: '#0071e3',
 waypoints: onlineNearestWaypoints,
 distance_m: onlineNearestDistance,
 estimated_min: Math.max(1, Math.round((onlineNearestDistance / getEvacuationSpeed()) / 60)),
  characteristics: (dict.routeShortestDesc || 'Direct route to the nearest safe high ground {target}').replace('{target}', localizedTargetEdgeName),
 congestion_score: 'medium', // Shortest usually gets congested
 isOSRM: true
 };
 } else {
 routeA = calculateCustomRouteForType(loc, targetEdge, 'A');
 }

 // Try to fetch OSRM Route with Detour for Route B (Congestion Avoidance)
 let detourResult = await fetchOSRMRouteWithDetour(loc, targetEdge);

 // BUILD ROUTE B (驕楢ｷｯ豺ｷ髮大屓驕ｿ繝ｫ繝ｼ繝・- uses detour if available)
 if (detourResult) {
 routeB = {
 id: 'B',
  label: dict.routeAvoidLabel || '混雑回避ルート',
 color: '#34c759',
 waypoints: detourResult.waypoints,
 distance_m: detourResult.distance,
 estimated_min: Math.max(1, Math.round((detourResult.distance / getEvacuationSpeed()) / 60)),
  characteristics: (dict.routeAvoidDesc || 'Dynamically avoids heavy simulated traffic to ensure a safe route to {target}').replace('{target}', localizedShelterName),
 congestion_score: 'low',
 isOSRM: true,
 blockedPoint: detourResult.blockedPoint
 };
 } else if (onlineNearestWaypoints) {
  const noCongestionDesc = dict.routeAvoidNoCongestionDesc || 'No heavy simulated traffic detected. Directing to {target} via the shortest route.';
 routeB = {
 id: 'B',
  label: dict.routeAvoidLabel || '混雑回避ルート',
 color: '#34c759',
 waypoints: onlineNearestWaypoints,
 distance_m: onlineNearestDistance,
 estimated_min: Math.max(1, Math.round((onlineNearestDistance / getEvacuationSpeed()) / 60)),
 characteristics: noCongestionDesc.replace('{target}', localizedTargetEdgeName),
 congestion_score: 'low',
 isOSRM: true
 };
 } else {
 routeB = calculateCustomRouteForType(loc, targetEdge, 'B');
 }

 // BUILD SECONDARY ROUTE (隨ｬ莠檎岼讓・ 驕ｿ髮｣謇縺ｸ縺ｮ蛻・ｲ舌Ν繝ｼ繝・
 let secondaryRoute = null;
 if (onlineBestWaypoints) {
 secondaryRoute = {
 target: bestShelter,
 waypoints: onlineBestWaypoints,
 distance_m: onlineBestDistance
 };
 } else {
 const fallbackWaypoints = calculateCustomRouteForType(loc, bestShelter, 'D').waypoints;
 secondaryRoute = {
 target: bestShelter,
 waypoints: fallbackWaypoints,
 distance_m: 0
 };
 }

 // BUILD ROUTE C (繝舌Μ繧｢繝輔Μ繝ｼ繝ｻ蜍ｾ驟榊屓驕ｿ繝ｫ繝ｼ繝・窶・Real slope-based calculation)
 // Try to find a flatter safe edge alternative by querying elevations along Route A
 let routeCEdge = targetEdge; // Default to same target as A
 let routeCWaypoints = onlineNearestWaypoints;
 let routeCDistance = onlineNearestDistance;
 let routeCMaxSlope = null;

 try {
 if (onlineNearestWaypoints && onlineNearestWaypoints.length >= 2) {
 // Sample up to 8 evenly-spaced points along Route A
 const sampleCount = Math.min(8, onlineNearestWaypoints.length);
 const step = Math.floor(onlineNearestWaypoints.length / sampleCount);
 const samplePts = [];
 for (let i = 0; i < sampleCount; i++) {
 const wp = onlineNearestWaypoints[i * step];
 samplePts.push({ lat: wp[0], lng: wp[1] });
 }

 const elevations = await getElevationsForWaypoints(samplePts);
 if (elevations && elevations.length === samplePts.length) {
 const maxSlope = calculateMaxSlope(samplePts, elevations);
 routeCMaxSlope = maxSlope;

 // If slope exceeds 8%, try to find a flatter safe edge nearby
 if (maxSlope > 8) {
 const startLLng = L.latLng(loc.lat, loc.lng);
 // Sort all safe edges by distance, then try each to find one with lower slope
 const sortedEdges = [...safeEdgesData]
 .map(e => ({ ...e, dist: startLLng.distanceTo(L.latLng(e.lat, e.lng)) }))
 .filter(e => e.id !== targetEdge.id && e.dist < targetEdge.dist * 1.6)
 .sort((a, b) => a.dist - b.dist);

 for (const altEdge of sortedEdges.slice(0, 5)) {
 const altUrl = `https://routing.openstreetmap.de/routed-foot/route/v1/foot/${loc.lng},${loc.lat};${altEdge.lng},${altEdge.lat}?overview=full&geometries=geojson`;
 try {
 const ctrl = new AbortController();
 setTimeout(() => ctrl.abort(), 3000);
 const altRes = await fetch(altUrl, { signal: ctrl.signal });
 const altData = await altRes.json();
 if (altData.code === 'Ok' && altData.routes && altData.routes.length > 0) {
 const altWps = altData.routes[0].geometry.coordinates.map(c => [c[1], c[0]]);
 // Sample elevation for this alternative route
 const altSampleCount = Math.min(8, altWps.length);
 const altStep = Math.floor(altWps.length / altSampleCount);
 const altPts = [];
 for (let i = 0; i < altSampleCount; i++) {
 const wp = altWps[i * altStep];
 altPts.push({ lat: wp[0], lng: wp[1] });
 }
 const altElevs = await getElevationsForWaypoints(altPts);
 if (altElevs && altElevs.length === altPts.length) {
 const altSlope = calculateMaxSlope(altPts, altElevs);
 if (altSlope < maxSlope - 2) { // Meaningfully flatter
 routeCEdge = altEdge;
 routeCWaypoints = altWps;
 routeCDistance = Math.round(altData.routes[0].distance);
 routeCMaxSlope = altSlope;
 break;
 }
 }
 }
 } catch (e) {
 // Skip unreachable edges
 }
 }
 }
 }
 }
 } catch (e) {
 console.warn('[RouteC] Elevation-based slope calculation failed:', e);
 }

 const slopeText = dict.routeSlopeText || '・最大勾配: {slope}%';
 const slopeLabel = routeCMaxSlope !== null ? slopeText.replace('{slope}', routeCMaxSlope.toFixed(1)) : '';
 
 let routeCEdgeName = routeCEdge.name;
 if (dict.elementarySchool) routeCEdgeName = routeCEdgeName.replace('小学校', dict.elementarySchool);
 if (dict.juniorHighSchool) routeCEdgeName = routeCEdgeName.replace('中学校', dict.juniorHighSchool);
 if (dict.shrinePrecincts) routeCEdgeName = routeCEdgeName.replace('境内', dict.shrinePrecincts);
 if (dict.learningCenter) routeCEdgeName = routeCEdgeName.replace('学習センター', dict.learningCenter);

 let flatNote = '';
 if (routeCEdge.id !== targetEdge.id) {
  flatNote = (dict.routeBarrierDesc1 || 'Prioritizing flat paths toward {target}').replace('{target}', routeCEdgeName);
 } else {
  flatNote = (dict.routeBarrierDesc2 || 'Heading to {target}, currently the flattest route').replace('{target}', routeCEdgeName);
 }

 if (routeCWaypoints) {
 routeC = {
 id: 'C',
  label: dict.routeBarrierLabel || 'バリアフリールート',
 color: '#5e5ce6',
 waypoints: routeCWaypoints,
 distance_m: routeCDistance,
 estimated_min: Math.max(1, Math.round((routeCDistance / getEvacuationSpeed()) / 60)),
 characteristics: `${flatNote}${slopeLabel}`,
 congestion_score: 'low',
 isOSRM: true
 };
 } else {
 routeC = calculateCustomRouteForType(loc, routeCEdge, 'C');
 }

 candidates = [routeA, routeB, routeC]; // Removed Route D, only A, B, C as primary choices

 // Calculate and attach passing shelters to candidates
 candidates.forEach(c => {
 if (c && c.waypoints && c.waypoints.length > 0) {
 c.passingShelters = findSheltersAlongRoute(c.waypoints);
 }
 });

 // Draw multiple routes with default selection 'A' and secondary route
 activeSecondaryRoute = secondaryRoute; // Cache for re-use when route is switched
 drawMultipleEvacuationRoutes(loc, targetEdge, secondaryRoute, candidates, activeSelectedRouteId || 'A');

 // Dynamically populate bottom sheet HUD cards and show
 showRouteSelectorHUD(candidates);

 // Update emergency HUD text
  document.getElementById('i18n-evac-desc').innerText = dict.routeStartPrompt || '避難開始位置を設定しました。ルートを選んで避難を開始してください。';
 }

 /**
 * Fetches elevation for an array of {lat,lng} points using the GSI elevation API.
 * Returns array of elevation values in metres (null for failures).
 */
 async function getElevationsForWaypoints(points) {
 // GSI elevation API does NOT support batch request with positions.
 // We fetch individual coordinates in parallel using Promise.all for maximum performance!
 const fetchPromises = points.map(async (p) => {
 const url = `https://cyberjapandata2.gsi.go.jp/general/dem/scripts/getelevation.php?lon=${p.lng}&lat=${p.lat}&outtype=JSON`;
 try {
 const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
 const json = await response.json();
 if (json && json.elevation !== undefined && json.elevation !== null) {
 return json.elevation;
 }
 } catch (e) {
 // skip
 }
 return null;
 });

 return Promise.all(fetchPromises);
 }

 /**
 * Calculates the maximum slope (in %) across consecutive waypoint segments.
 * @param {Array<{lat,lng}>} points - array of {lat, lng} objects
 * @param {Array<number|null>} elevations - parallel array of elevations in metres
 * @returns {number} maximum slope percentage
 */
 function calculateMaxSlope(points, elevations) {
 let maxSlope = 0;
 for (let i = 1; i < points.length; i++) {
 if (elevations[i] === null || elevations[i - 1] === null) continue;
 const elevDiff = Math.abs(elevations[i] - elevations[i - 1]);
 const horizDist = L.latLng(points[i - 1].lat, points[i - 1].lng)
 .distanceTo(L.latLng(points[i].lat, points[i].lng));
 if (horizDist > 5) {
 const slope = (elevDiff / horizDist) * 100;
 if (slope > maxSlope) maxSlope = slope;
 }
 }
 return Math.round(maxSlope * 10) / 10;
 }

 async function findNearestSafeEdgeCandidates(loc) {
 const startLatLng = L.latLng(loc.lat, loc.lng);
 
 // 1. Sort all safe edges by distance
 const sortedEdges = [...safeEdgesData]
 .map(e => ({
 edge: e,
 dist: startLatLng.distanceTo(L.latLng(e.lat, e.lng))
 }))
 .sort((a, b) => a.dist - b.dist);

 if (sortedEdges.length === 0) return [];

 // 2. Take the top 10 closest safe edges for OSRM routing verification (instantly without API delays)
 return sortedEdges.slice(0, 10).map(x => x.edge);
 }

 async function findNearestSafeEdge(loc) {
 const candidatesList = await findNearestSafeEdgeCandidates(loc);
 if (candidatesList.length === 0) return null;

 console.log(`[SafeEdge] 螳牙・蠅・阜蛟呵｣懈焚: ${candidatesList.length}轤ｹ縲０SRM繧ｹ繝翫ャ繝怜ｮ牙・繝√ぉ繝・け繧帝幕蟋九＠縺ｾ縺・..`);

 // Loop through candidates list to find the first one that has a safe OSRM snapped destination!
 for (let i = 0; i < Math.min(candidatesList.length, 6); i++) {
 const candidateEdge = candidatesList[i];
 
 const osrmUrls = [
 `https://routing.openstreetmap.de/routed-foot/route/v1/foot/${loc.lng},${loc.lat};${candidateEdge.lng},${candidateEdge.lat}?overview=full&geometries=geojson`,
 `https://router.project-osrm.org/route/v1/foot/${loc.lng},${loc.lat};${candidateEdge.lng},${candidateEdge.lat}?overview=full&geometries=geojson`
 ];

 let verificationFailed = false;
 for (let url of osrmUrls) {
 try {
 const controller = new AbortController();
 const timeoutId = setTimeout(() => controller.abort(), 2000);
 const response = await fetch(url, { signal: controller.signal });
 clearTimeout(timeoutId);
 const data = await response.json();
 
 if (data.code === 'Ok' && data.routes && data.routes.length > 0) {
 const routeData = data.routes[0];
 const waypoints = routeData.geometry.coordinates.map(c => [c[1], c[0]]); // [lat, lng]
 const lastWaypoint = waypoints[waypoints.length - 1];
 
 // Check if the OSRM snapped last waypoint is inside the inundation zone!
 const isSnappedInside = await checkTsunamiInundation(lastWaypoint[0], lastWaypoint[1], currentPrefCode || '14');
 
  if (isSnappedInside) {
  console.warn(`[SafeEdge] OSRM繧ｹ繝翫ャ繝怜・縺梧ｵｸ豌ｴ蝓溷・縺ｮ縺溘ａ縲√％縺ｮ蛟呵｣懊ｒ繧ｹ繧ｭ繝・・縺励∪縺・ ${candidateEdge.name || candidateEdge.id} (繧ｹ繝翫ャ繝怜・: ${lastWaypoint[0]}, ${lastWaypoint[1]})`);
  verificationFailed = true;
  break;
  }
  // Check if the snap distance is too far (indicates ocean or inaccessible area)
  const snapDistance = L.latLng(candidateEdge.lat, candidateEdge.lng).distanceTo(L.latLng(lastWaypoint[0], lastWaypoint[1]));
  if (snapDistance > 100) {
  console.warn(`[SafeEdge] OSRM繧ｹ繝翫ャ繝怜・縺碁□縺吶℃縺ｾ縺・(${snapDistance.toFixed(1)}m > 100m)縲る％霍ｯ縺後↑縺・°豬ｷ荳翫・縺溘ａ繧ｹ繧ｭ繝・・縺励∪縺・ ${candidateEdge.name || candidateEdge.id} (繧ｹ繝翫ャ繝怜・: ${lastWaypoint[0]}, ${lastWaypoint[1]})`);
  verificationFailed = true;
  break;
  }
  
 console.log(`[SafeEdge] 螳牙・縺ｪ繧ｹ繝翫ャ繝怜・繧堤｢ｺ隱・ ${candidateEdge.name || candidateEdge.id} (繧ｹ繝翫ャ繝怜・: ${lastWaypoint[0]}, ${lastWaypoint[1]})`);
 return candidateEdge;
 }
 } catch (e) {
 // skip URL and try fallback URL
 }
 }

 // If we aborted because the snapped target is inside, continue to next candidate
 if (verificationFailed) continue;
 }

 // Fallback: If all candidates failed OSRM safety checks or API was offline, return the first candidate
 const fallbackEdge = candidatesList[0];
 console.warn(`[SafeEdge] 縺吶∋縺ｦ縺ｮ蛟呵｣懊・繧ｹ繝翫ャ繝怜・縺悟ｮ牙・蝓溷､悶∪縺溘・讀懆ｨｼ繧ｨ繝ｩ繝ｼ縺ｮ縺溘ａ縲∵怙蟇・ｊ繧堤ｷ頑･謗｡逕ｨ縺励∪縺・ ${fallbackEdge.name || fallbackEdge.id}`);
 return fallbackEdge;
 }

 function findSheltersAlongRoute(waypoints) {
 if (!window.turf || waypoints.length < 2) return [];
 const routeLine = turf.lineString(waypoints.map(c => [c[1], c[0]])); // [lng, lat]
 const passing = [];
 
 sheltersData.forEach(s => {
 const pt = turf.point([s.lng, s.lat]);
 const dist = turf.pointToLineDistance(pt, routeLine, {units: 'meters'});
 if (dist <= 60) { // If within 60 meters of the route
 passing.push(s);
 }
 });
 return passing;
 }

 function findNearestShelter(loc) {
 let nearest = null;
 let minDist = Infinity;
 const startLatLng = L.latLng(loc.lat, loc.lng);
 
 sheltersData.forEach(s => {
 const dist = startLatLng.distanceTo(L.latLng(s.lat, s.lng));
 if (dist < minDist) {
 minDist = dist;
 nearest = s;
 }
 });
 
 return nearest;
 }

 function findBestShelter(loc) {
 let best = null;
 let minDist = Infinity;
 const startLatLng = L.latLng(loc.lat, loc.lng);
 
 // First try to find a shelter that is NOT high load
 sheltersData.forEach(s => {
 const load = s.predicted_load || 'low';
 if (load !== 'high') {
 const dist = startLatLng.distanceTo(L.latLng(s.lat, s.lng));
 if (dist < minDist) {
 minDist = dist;
 best = s;
 }
 }
 });
 
 // If all surrounding shelters are high load, fallback to absolute nearest
 if (!best) {
 minDist = Infinity;
 sheltersData.forEach(s => {
 const dist = startLatLng.distanceTo(L.latLng(s.lat, s.lng));
 if (dist < minDist) {
 minDist = dist;
 best = s;
 }
 });
 }
 return best;
 }

 function calculateCustomRouteForType(startLoc, shelter, type) {
 let bestRoute = null;
 let minWaypointDist = Infinity;
 let bestSplitIndex = 0;
 
 const startLatLng = L.latLng(startLoc.lat, startLoc.lng);
 
 // Loop through all scenario routes in routeData
 Object.keys(routeData).forEach(key => {
 const candidates = routeData[key] || [];
 candidates.forEach(route => {
 if (!route.waypoints || route.waypoints.length < 2) return;
 
 // Match the specific route candidate type (A, B, or C)
 if (route.id !== type) return;
 
 // Check if this route ends near our target shelter
 const lastPt = route.waypoints[route.waypoints.length - 1];
 const destDist = L.latLng(lastPt[0], lastPt[1]).distanceTo(L.latLng(shelter.lat, shelter.lng));
 
 if (destDist < 150) {
 // Find the closest waypoint along this route to our startLoc
 route.waypoints.forEach((pt, idx) => {
 const dist = startLatLng.distanceTo(L.latLng(pt[0], pt[1]));
 if (dist < minWaypointDist) {
 minWaypointDist = dist;
 bestRoute = route;
 bestSplitIndex = idx;
 }
 });
 }
 });
 });
 
 const dict = i18nDict[getLanguageCode()] || i18nDict['ja'] || {};

 // If we found a good predefined route nearby, slice and splice it!
 if (bestRoute && minWaypointDist < 300) { // Limit to 300m instead of 800m to avoid long diagonal lines
 const customWaypoints = [];
 for (let i = bestSplitIndex; i < bestRoute.waypoints.length; i++) {
 customWaypoints.push(bestRoute.waypoints[i]);
 }
 
 let label = bestRoute.label;
 let characteristics = bestRoute.characteristics;
 
 const shelterName = shelter.name;
 let localizedShelterName = shelterName;
 if (dict.shelterWord) localizedShelterName = localizedShelterName.replace('避難所', dict.shelterWord);
 if (dict.elementarySchool) localizedShelterName = localizedShelterName.replace('小学校', dict.elementarySchool);
 if (dict.juniorHighSchool) localizedShelterName = localizedShelterName.replace('中学校', dict.juniorHighSchool);
 if (dict.shrinePrecincts) localizedShelterName = localizedShelterName.replace('境内', dict.shrinePrecincts);
 if (dict.learningCenter) localizedShelterName = localizedShelterName.replace('学習センター', dict.learningCenter);

 if (type === 'A') {
  label = dict.routeShortestLabel || '最短ルート';
  characteristics = (dict.routeShortestDesc || 'Direct route to the nearest safe high ground {target}').replace('{target}', localizedShelterName);
 } else if (type === 'B') {
  label = dict.routeAvoidLabel || '混雑回避ルート';
  characteristics = (dict.routeAvoidDesc || 'Avoids simulated traffic and congestion to ensure a safe route to {target}').replace('{target}', localizedShelterName);
 } else if (type === 'C') {
  label = dict.routeBarrierLabel || 'バリアフリールート';
  characteristics = (dict.routeBarrierDesc2 || 'Accessible and relatively flat route heading to {target}').replace('{target}', localizedShelterName);
 }
 
 if (dict.elementarySchool) characteristics = characteristics.replace('小学校', dict.elementarySchool);
 if (dict.juniorHighSchool) characteristics = characteristics.replace('中学校', dict.juniorHighSchool);
 if (dict.shrinePrecincts) characteristics = characteristics.replace('境内', dict.shrinePrecincts);
 if (dict.learningCenter) characteristics = characteristics.replace('学習センター', dict.learningCenter);

 const customDistance = Math.round(minWaypointDist + bestRoute.distance_m * (1 - bestSplitIndex / bestRoute.waypoints.length));
 return {
 id: type, // Fixed: included the missing type ID!
 waypoints: customWaypoints,
 label: label,
 color: bestRoute.color,
 distance_m: customDistance,
 estimated_min: Math.max(1, Math.round((customDistance / getEvacuationSpeed()) / 60)),
 characteristics: characteristics,
 congestion_score: bestRoute.congestion_score,
 isOSRM: false
 };
 }
 
 // Absolute fallback: draw a simulated L-shaped (Manhattan) route or straight line to the shelter
 const shelterLat = shelter.lat;
 const shelterLng = shelter.lng;
 const midPoint = [startLoc.lat, shelterLng]; // corner turn to simulate streets
 
 const fallbackNames = {
  'A': dict.routeShortestLabel || '最短ルート',
  'B': dict.routeAvoidLabel || '混雑回避ルート',
  'C': dict.routeBarrierLabel || 'バリアフリールート',
  'D': dict.routeDispersal || 'Dispersed Route'
 };
 const fallbackColors = {
 'A': '#0071e3',
 'B': '#34c759',
 'C': '#5e5ce6',
 'D': '#ff9500'
 };

 return {
 id: type,
  label: fallbackNames[type] || 'Emergency Evacuation Route',
 color: fallbackColors[type] || '#ff3b30',
 waypoints: [
 midPoint,
 [shelterLat, shelterLng]
 ],
 distance_m: Math.round(startLatLng.distanceTo(L.latLng(shelterLat, shelterLng)) * 1.3),
 estimated_min: Math.max(1, Math.round((startLatLng.distanceTo(L.latLng(shelterLat, shelterLng)) * 1.3 / getEvacuationSpeed()) / 60)),
  characteristics: type === 'C' ? 'Flat route avoiding steep slopes (Fallback)' : 'Shortest direct route (Fallback)',
 congestion_score: "low",
 isOSRM: false
 };
 }

 function isInModelArea(loc) {
 if (!loc) return false;
 // Kamakura model area bounding box: Yuigahama, Shichirigahama, Zaimokuza
 return (loc.lat >= 35.28 && loc.lat <= 35.34 && loc.lng >= 139.48 && loc.lng <= 139.58);
 }

 function showCustomAlert(title, message, iconType = 'info', callback = null) {
 const overlay = document.getElementById('alert-overlay');
 const titleEl = document.getElementById('alert-title');
 const descEl = document.getElementById('alert-desc');
 const iconContainer = document.getElementById('alert-icon');
 const btnOk = document.getElementById('btn-alert-ok');
 
 titleEl.innerText = title;
 descEl.innerHTML = message.replace(/\n/g, '<br>');
 
 // Dynamic icons mapping
 let iconColor = 'var(--primary)';
 let iconHtml = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="48" height="48"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>`;
 
 if (iconType === 'success') {
 iconColor = '#34c759'; // Apple green
 iconHtml = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="48" height="48"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>`;
 } else if (iconType === 'warning') {
 iconColor = 'var(--danger)'; // CUD Orange
 iconHtml = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="48" height="48"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>`;
 } else if (iconType === 'error') {
 iconColor = '#ff3b30'; // Apple red
 iconHtml = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="48" height="48"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>`;
 }
 
 iconContainer.style.color = iconColor;
 iconContainer.innerHTML = iconHtml;
 
 const hideAlert = (e) => { if(e) e.stopPropagation();
 overlay.classList.remove('active');
 setTimeout(() => overlay.classList.add('hidden'), 300);
 btnOk.removeEventListener('click', hideAlert);
 if (callback) setTimeout(callback, 50);
 };
 
 btnOk.addEventListener('click', hideAlert);
 
 overlay.classList.remove('hidden');
 setTimeout(() => overlay.classList.add('active'), 10);
 }

 function checkRouteDeviation(loc) {
  if (!mainRouteLine || isManualLocation) return;
 
 const isAlertEnabled = localStorage.getItem('tenden-deviation-alert') !== 'false';
 if (!isAlertEnabled) {
 const labelDesc = document.getElementById('i18n-evac-desc');
 if (labelDesc) {
 labelDesc.style.color = 'var(--text-color)';
 }
 return;
 }
 
 // Simple distance check from the route line
 const latlng = L.latLng(loc.lat, loc.lng);
 // Leaflet doesn't have point-to-line distance natively without geometry libs,
 // so we approximate by checking distance to nearest route vertex for this demo.
 const latlngs = mainRouteLine.getLatLngs();
 let minDistance = Infinity;
 for (let pt of latlngs) {
 let d = latlng.distanceTo(pt);
 if (d < minDistance) minDistance = d;
 }

 // If distance > 100m, trigger warning
 if (minDistance > 100) {
 console.log("Route deviation detected");
 const dict = i18nDict[getLanguageCode()] || i18nDict['ja'] || {};
  document.getElementById('i18n-evac-desc').innerText = dict.routeOffCourse || '避難経路から外れています。元のルートに戻ってください。';
 document.getElementById('i18n-evac-desc').style.color = 'var(--danger)';
 
 // Speak deviation alert rate-limited to every 12s to avoid overlap
 const now = Date.now();
 if (now - lastOffCourseSpeakTime > 12000) {
 speakI18n('speechOffCourse');
  triggerDynamicIsland(dict.routeOffCourse || '避難経路から外れています。元のルートに戻ってください。', 'error');
 
 // Smartphone Background Notification
 sendSystemNotification(
  dict.routeOffCourse || '避難経路から外れています。元のルートに戻ってください。',
 "deviation-alert"
 );
 
 lastOffCourseSpeakTime = now;
 }

 if ("vibrate" in navigator) {
 navigator.vibrate([500, 200, 500]);
 } else {
 // iOS visual fallback
 const banner = document.getElementById('evacuation-banner');
 banner.style.borderLeftColor = 'var(--danger)';
 setTimeout(() => banner.style.borderLeftColor = 'var(--primary)', 500);
 }
 }
 }

 function simulateEvacuation() {
 if (!mainRouteLine) return;
 
 // Ensure simulationInterval is clear since we no longer move the pin automatically
 if (simulationInterval) {
 clearInterval(simulationInterval);
 simulationInterval = null;
 }

 // Auto-fit the map to optimally display the entire evacuation route
 // We use a slight delay and responsive padding so it doesn't break on small screens
 setTimeout(() => {
 if (routeLayerGroup && mainRouteLine) {
 map.fitBounds(mainRouteLine.getBounds(), {
 paddingTopLeft: [20, 80], // top-status-bar height is ~52px
 paddingBottomRight: [20, 150], // Bottom sheet expanded
 animate: true,
 duration: 1.2
 });
 }
 }, 300);
 }

 function takeScreenshot() {
 const hudControls = document.querySelector('.hud-controls');
 if (hudControls) hudControls.style.display = 'none';
 
 html2canvas(document.body, {
 useCORS: true,
 allowTaint: true,
 ignoreElements: (el) => el.id === 'onboarding-overlay' || el.id === 'error-overlay' || el.id === 'share-overlay' || el.id === 'settings-overlay' || el.id === 'layers-overlay'
 }).then(canvas => {
 const link = document.createElement('a');
 link.download = `tenden_backup_${new Date().toISOString().split('T')[0]}.png`;
 link.href = canvas.toDataURL();
 link.click();
 if (hudControls) hudControls.style.display = 'flex';
 
 // Launch dynamic evacuation plan share dialog!
 showShareEvacuationPlanDialog();
 }).catch(err => {
 console.error("Screenshot failed:", err);
 if (hudControls) hudControls.style.display = 'flex';
 // Show share dialog anyway as fallback
 showShareEvacuationPlanDialog();
 });
 }

 // 笏笏 P2P蝨ｰ髴・ュ蝣ｱ WebSocket謗･邯・笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏
 // 菴ｿ逕ｨAPI: wss://api.p2pquake.net/v2/ws・・2P蝨ｰ髴・ュ蝣ｱ繝阪ャ繝医Ρ繝ｼ繧ｯ・・
 // code 551 = 豢･豕｢諠・ｱ, code 556 = 豢･豕｢隴ｦ蝣ｱ
 function connectP2PQuake() {
 let ws;
 let reconnectTimer = null;

 function connect() {
 try {
  ws = new WebSocket('wss://api.p2pquake.net/v2/ws');
 } catch (e) {
  console.warn('[P2P] WebSocket connection failed (offline?):', e);
 scheduleReconnect();
 return;
 }

 ws.onopen = () => {
  console.log('[P2P] WebSocket connected (api.p2pquake.net)');
 setP2PStatus('connected');
 };

 ws.onmessage = (e) => {
 let data;
 try {
 data = JSON.parse(e.data);
 } catch (_) {
 return;
 }

 // code 551 = 豌苓ｱ｡蠎∫匱陦ｨ縲梧ｴ･豕｢諠・ｱ縲・ code 556 = 邱頑･蝨ｰ髴・溷ｱ・井ｺ亥ｱ・・
 if (data.code === 551 || data.code === 556) {
 // 豢･豕｢隴ｦ蝣ｱ繧ｯ繝ｩ繧ｹ繧堤｢ｺ隱・
 const forecasts = data?.tsunami?.comments?.forecast?.text ?? '';
 const isTsunamiWarning =
 forecasts.includes('大地震速報') ||
 forecasts.includes('地震速報') ||
 data.code === 551; // 地震情報が来た時点で緊急モード発動

 if (isTsunamiWarning) {
 setP2PStatus('alert');
 }
 if (isTsunamiWarning && !isEmergency) {
  console.warn('[P2P] Tsunami warning received -> Triggering auto-evacuation check...');
 const p2pAuto = localStorage.getItem('tenden-p2p-auto') !== 'false';
 if (p2pAuto) {
 triggerEmergencyMode(false, 1, 'a');
 if ('vibrate' in navigator) {
 navigator.vibrate([300, 100, 300, 100, 300]);
 }
 }
 }
 }
 };

 ws.onerror = (err) => {
  console.warn('[P2P] WebSocket error:', err);
 };

 ws.onclose = () => {
  console.log('[P2P] WebSocket disconnected, reconnecting in 5s...');
 setP2PStatus('connecting');
 scheduleReconnect();
 };
 }

 function scheduleReconnect() {
 if (reconnectTimer) return; // 多重接続を防ぐ
 reconnectTimer = setTimeout(() => {
 reconnectTimer = null;
 connect();
 }, 5000);
 }

 connect();
 }

 function startClock() {
 function tick() {
 const d = new Date();
 const timeEl = document.getElementById('current-time');
 const dateEl = document.getElementById('current-date');
 if (timeEl) {
 timeEl.innerText = d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
 }
 if (dateEl) {
 dateEl.innerText = d.toLocaleDateString('ja-JP', { month: 'short', day: 'numeric', weekday: 'short' });
 }
 }
 tick();
 setInterval(tick, 1000);
 }

 // P2P謗･邯夂憾諷九ｒHUD縺ｫ蜿肴丐縺吶ｋ
 function setP2PStatus(state) {
 const dot = document.getElementById('p2p-dot');
 const label = document.getElementById('p2p-label');
 const bar = document.getElementById('p2p-status-bar');
 if (!dot || !label) return;
 dot.className = `p2p-dot p2p-${state}`;
 
 const dict = i18nDict[getLanguageCode()] || i18nDict['ja'] || {};
 const labels = {
  connecting: dict.p2pConnecting || 'P2P Reconnecting...',
  connected: dict.p2pConnected || 'P2P Connected (Monitoring)',
  alert: dict.p2pAlert || 'Tsunami Warning Active!',
  disconnected: dict.p2pDisconnected || '警報: 未接続'
 };
 label.textContent = labels[state] || '接続中';
 if (bar) {
 bar.classList.toggle('p2p-alert-active', state === 'alert');
 }
 }

 function getLanguageCode() {
 const savedLang = localStorage.getItem('tenden-lang') || 'auto';
 if (savedLang !== 'auto') {
 return savedLang;
 }
 const browserLang = (navigator.language || navigator.userLanguage).split('-')[0];
 return i18nDict[browserLang] ? browserLang : 'ja';
 }

 function initI18n() {
 const langCode = getLanguageCode();

 // Reset to original Japanese if not in dict
 if (!i18nDict[langCode]) {
 // Usually we'd fetch original html content, but for this demo, 
 // if we need to reset we can just reload or assume Japanese is default
 if (langCode === 'ja') return;
 }

 if (i18nDict[langCode]) {
 const dict = i18nDict[langCode];
 document.querySelectorAll('[data-i18n]').forEach(el => {
 const key = el.getAttribute('data-i18n');
 if (dict[key]) {
 el.innerHTML = dict[key];
 }
 });
 }
 }

 function triggerDynamicIsland(message, type = 'info') {
 const island = document.getElementById('dynamic-island');
 const iconEl = document.getElementById('island-icon');
 const textEl = document.getElementById('island-text');
 if (!island || !iconEl || !textEl) return;

 // Reset state & clear active timers to handle rapid triggers elegantly
 if (dynamicIslandTimer) {
 clearTimeout(dynamicIslandTimer);
 dynamicIslandTimer = null;
 }

 const icons = {
 info: 'ℹ️',
 success: '',
 warning: '',
 error: '',
 copied: ''
 };
 iconEl.innerText = icons[type] || 'ℹ️';
 textEl.innerText = message;

 island.classList.remove('hidden');
 island.className = 'dynamic-island-collapsed';

 // Force browser repaint to trigger slide down animation
 setTimeout(() => {
 island.className = 'dynamic-island-expanded';
 }, 30);

 // Retract after 3.8 seconds
 dynamicIslandTimer = setTimeout(() => {
 island.className = 'dynamic-island-collapsed';
 dynamicIslandTimer = setTimeout(() => {
 island.classList.add('hidden');
 dynamicIslandTimer = null;
 }, 650);
 }, 3800);
 }

 function updateGPSAccuracyHUD(accuracy) {
 const accuracyEl = document.getElementById('gps-accuracy');
 const box = document.getElementById('gps-accuracy-box');
 if (!accuracyEl || !box) return;

 const dict = i18nDict[getLanguageCode()] || i18nDict['ja'] || {};

 if (accuracy === null || accuracy === undefined) {
 // Manual pin or mock high accuracy
 if (isManualLocation) {
 accuracyEl.innerText = `GPS: ±3m`;
 box.className = 'status-badge gps-badge';
 } else {
 accuracyEl.innerText = 'GPS: --';
 box.className = 'status-badge gps-badge';
 }
 return;
 }

 const formattedAccuracy = Math.round(accuracy);
 if (accuracy < 15) {
 accuracyEl.innerText = `GPS: ±${formattedAccuracy}m`;
 box.className = 'status-badge gps-badge';
 } else {
  const warningText = dict.gpsLowAccuracy || '(Outdoor Use Recommended)';
 accuracyEl.innerText = `GPS: ±${formattedAccuracy}m ${warningText}`;
 box.className = 'status-badge gps-badge gps-low-accuracy';
 }
 }

 function updateNetworkStatusHUD() {
 const netText = document.getElementById('network-text');
 const netBox = document.getElementById('network-status');
 if (!netText || !netBox) return;

 const dict = i18nDict[getLanguageCode()] || i18nDict['ja'] || {};

 if (navigator.onLine) {
 netText.innerText = dict.onlineBadge || 'Online';
 netBox.className = 'status-badge network-badge';
 } else {
 netText.innerText = dict.offlineBadge || 'Offline (PWA)';
 netBox.className = 'status-badge network-badge network-offline';
 }
 }

 function speakI18n(key, templates = {}) {
 const voiceEnabled = localStorage.getItem('tenden-voice-nav') === 'true';
 if (!voiceEnabled) return;

 if (!('speechSynthesis' in window)) {
 console.warn('[Speech] Browser does not support speechSynthesis');
 return;
 }

 const lang = getLanguageCode();
 const dict = i18nDict[lang] || i18nDict['ja'] || {};
 let text = dict[key] || '';
 
 if (!text) {
 const fallbackDict = i18nDict['ja'] || {};
 text = fallbackDict[key] || '';
 }

 if (!text) return;

 // Apply templates (e.g. {routeLabel}, {shelterName})
 for (const [k, v] of Object.entries(templates)) {
 text = text.replace(new RegExp(`\\{${k}\\}`, 'g'), v);
 }

 // Strip HTML if any
 const tempDiv = document.createElement('div');
 tempDiv.innerHTML = text;
 const plainText = tempDiv.textContent || tempDiv.innerText || '';

 try {
 window.speechSynthesis.cancel(); // Terminate preceding speech

 const utterance = new SpeechSynthesisUtterance(plainText);
 
 // Map ISO 639-1 language codes to Speech synthesis locales
 const voiceLangMap = {
 'ja': 'ja-JP',
 'en': 'en-US',
 'zh': 'zh-CN',
 'zh-tw': 'zh-TW',
 'ko': 'ko-KR',
 'fr': 'fr-FR',
 'es': 'es-ES',
 'de': 'de-DE',
 'it': 'it-IT',
 'pt': 'pt-PT',
 'ru': 'ru-RU',
 'vi': 'vi-VN',
 'th': 'th-TH',
 'id': 'id-ID',
 'tl': 'fil-PH',
 'ms': 'ms-MY',
 'hi': 'hi-IN',
 'bn': 'bn-IN',
 'ar': 'ar-AE',
 'fa': 'fa-IR',
 'tr': 'tr-TR',
 'nl': 'nl-NL',
 'sv': 'sv-SE',
 'no': 'no-NO',
 'fi': 'fi-FI',
 'da': 'da-DK',
 'pl': 'pl-PL',
 'uk': 'uk-UA',
 'el': 'el-GR',
 'he': 'he-IL'
 };

 const targetLang = voiceLangMap[lang] || 'ja-JP';
 utterance.lang = targetLang;

 // Find matching voice locale
 const voices = window.speechSynthesis.getVoices();
 const voice = voices.find(v => v.lang === targetLang || v.lang.startsWith(targetLang.split('-')[0]));
 if (voice) {
 utterance.voice = voice;
 }

 utterance.rate = 1.0;
 utterance.pitch = 1.0;

 window.speechSynthesis.speak(utterance);
 } catch (e) {
 console.error('[Speech] Error speaking text:', e);
 }
 }

 function checkShelterArrival(loc) {
 if (!isEmergency || isEvacuationCompleted) return;

 let destLatLng = null;
 
 if (activeSecondaryRoute && activeSecondaryRoute.target) {
 destLatLng = L.latLng(activeSecondaryRoute.target.lat, activeSecondaryRoute.target.lng);
 } else if (mainRouteLine) {
 const wps = mainRouteLine.getLatLngs();
 if (wps && wps.length > 0) {
 destLatLng = wps[wps.length - 1];
 }
 }

 if (!destLatLng) return;

 const distance = L.latLng(loc.lat, loc.lng).distanceTo(destLatLng);
 if (distance < 25) { // Within 25 meters (Apple GPS standard margin)
 isEvacuationCompleted = true;
 
 // Speak arrival
 speakI18n('speechArrived');

 // Smartphone Background Notification & Celebration Vibration
 const dict = i18nDict[getLanguageCode()] || i18nDict['ja'] || {};
 sendSystemNotification(
  dict.arrivalTitle || "Evacuation Completed!",
      dict.arrivalDesc || 'You have successfully reached a safe location. Please remain here.',
 "arrival-alert"
 );
 if ('vibrate' in navigator) {
 navigator.vibrate([100, 50, 100, 50, 200]);
 }
 releaseWakeLock();

 // Trigger beautiful completion alert popup
 showCustomAlert(
  dict.arrivalTitle || "Evacuation Completed!",
      dict.arrivalDesc || 'You have successfully reached a safe location. Please remain here.',
 "success",
 () => {
 // Automatically trigger the beautiful evacuation plan card screenshot & share overlay!
 takeScreenshot();
 }
 );
 }
 }

 // ==========================================================================
 // Tsunami National Hazard Map & Location Inundation Detection (蜈ｨ蝗ｽ蛹ｺ蟇ｾ蠢懶ｼ・樟蝨ｨ蝨ｰ豬ｸ豌ｴ諠ｳ螳壼玄蝓溷・螟門愛螳・
 // ==========================================================================
 let currentPrefCode = '14'; // 初期値は神奈川県 (JIS: 14)

 /**
 * 邱ｯ蠎ｦ邨悟ｺｦ縺九ｉ驛ｽ驕灘ｺ懃恁繧ｳ繝ｼ繝峨ｒ迚ｹ螳壹＠縲√ワ繧ｶ繝ｼ繝峨・繝・・繧ｿ繧､繝ｫ繧貞虚逧・↓蛻・ｊ譖ｿ縺医ｋ
 * @param {number} lat 邱ｯ蠎ｦ
 * @param {number} lng 邨悟ｺｦ
 * @returns {Promise<string>} 驛ｽ驕灘ｺ懃恁繧ｳ繝ｼ繝・(2譯・
 */
 async function updateTsunamiPrefecturalTile(lat, lng) {
 try {
 // 蝗ｽ蝨溷慍逅・劼縺ｮ霆ｽ驥城・ず繧ｪ繧ｳ繝ｼ繝・ぅ繝ｳ繧ｰAPI繧貞茜逕ｨ
 const url = `https://mreversegeocoder.gsi.go.jp/reverse-geocoder/LonLatToAddress?lat=${lat}&lon=${lng}`;
 const res = await fetch(url);
 if (!res.ok) throw new Error('Reverse geocoding failed');
 
 const data = await res.json();
 if (data && data.results && data.results.muniCd) {
 const muniCd = data.results.muniCd;
 // muniCd縺ｮ蜈磯ｭ2譯√′驛ｽ驕灘ｺ懃恁繧ｳ繝ｼ繝・
 const prefCode = String(Math.floor(parseInt(muniCd) / 1000)).padStart(2, '0');
 
 if (prefCode !== currentPrefCode) {
 currentPrefCode = prefCode;
 console.log(`[Tsunami Hazard] Switching hazard map prefecture tile to: ${prefCode}`);
 
 if (hazardLayer) {
 // 繧ｿ繧､繝ｫURL繧貞虚逧・↓譖ｴ譁ｰ
 hazardLayer.setUrl(`https://disaportaldata.gsi.go.jp/raster/04_tsunami_newlegend_pref_data/${prefCode}/{z}/{x}/{y}.png`);
 }
 }
 return prefCode;
 }
 } catch (err) {
 console.warn('[Tsunami Hazard] Failed to auto-switch prefectural tile:', err);
 }
 return currentPrefCode;
 }

 /**
 * 邱ｯ蠎ｦ邨悟ｺｦ縺九ｉ繧ｺ繝ｼ繝繝ｬ繝吶Ν14縺ｫ縺翫￠繧宜YZ繧ｿ繧､繝ｫ蠎ｧ讓吶→繧ｿ繧､繝ｫ蜀・ヴ繧ｯ繧ｻ繝ｫ蠎ｧ讓吶ｒ邂怜・縺吶ｋ
 */
 function getTileCoords(lat, lng, zoom = 14) {
 const latRad = lat * Math.PI / 180;
 const n = Math.pow(2, zoom);
 const x = ((lng + 180) / 360) * n;
 const y = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
 
 const tileX = Math.floor(x);
 const tileY = Math.floor(y);
 
 const px = Math.floor((x - tileX) * 256);
 const py = Math.floor((y - tileY) * 256);
 
 return { x: tileX, y: tileY, px: px, py: py };
 }

 /**
 * Loads a raster tile PNG and returns its full pixel data (Uint8ClampedArray, RGBA).
 * Returns null if the tile cannot be loaded or CORS blocks canvas access.
 */
 function loadTilePixelData(tileUrl) {
 return new Promise((resolve) => {
 const img = new Image();
 img.crossOrigin = 'anonymous';
 img.onload = () => {
 try {
 const canvas = document.createElement('canvas');
 canvas.width = 256; canvas.height = 256;
 const ctx = canvas.getContext('2d');
 ctx.drawImage(img, 0, 0);
 resolve(ctx.getImageData(0, 0, 256, 256).data);
 } catch (e) { resolve(null); }
 };
 img.onerror = () => resolve(null);
 img.src = tileUrl;
 });
 }

 /**
 * Renders all safe edges as green circle marker dots on a Leaflet layer group for debugging / visualization.
 */
 function drawAllSafeEdges() {
 if (!safeEdgesLayerGroup) return;
 safeEdgesLayerGroup.clearLayers();
 
 const dict = i18nDict[getLanguageCode()] || i18nDict['ja'] || {};
  const title = dict.safeEdgeTitle || 'Safe Boundary Point (First Goal Candidate)';
  const coordLabel = dict.coordinateLabel || 'Coordinates';
 
 safeEdgesData.forEach(edge => {
 L.circleMarker([edge.lat, edge.lng], {
 radius: 4,
 color: '#30d158', // iOS Green
 fillColor: '#30d158',
 fillOpacity: 0.6,
 weight: 1.5
 }).bindPopup(`
 <div style="font-size: 11px; font-family: -apple-system, sans-serif; line-height: 1.4; padding: 2px;">
 <strong style="color:#30d158; font-size: 12px;">${title}</strong><br>
 <span style="color:#666;">ID: ${edge.id || 'scan'}</span><br>
 <span style="color:#666;">${coordLabel} ${edge.lat.toFixed(5)}, ${edge.lng.toFixed(5)}</span>
 </div>
 `).addTo(safeEdgesLayerGroup);
 });
 }

 /**
 * Helper to check if a lat/lng is near the coastline or rivers in Kamakura.
 * Excludes points within 300m of the coastline and 100m of Namerikawa/Sakaigawa rivers.
 */
 function isNearCoastOrWater(lat, lng) {
  // (Moved window.turf check below)
 
 
 
 // [CRITICAL] Mathematical Ocean Exclusion:
 // Coastline coordinates from West to East in Kamakura city limits
  const coastPts = [
  { lng: 139.460, lat: 35.310 }, // Far West border
  { lng: 139.470, lat: 35.309 }, // West border
  { lng: 139.485, lat: 35.307 }, // Koshigoe
  { lng: 139.500, lat: 35.304 }, // Shichirigahama
  { lng: 139.515, lat: 35.302 },
  { lng: 139.525, lat: 35.301 }, // Inamuragasaki
  { lng: 139.535, lat: 35.310 }, // Yuigahama West
  { lng: 139.545, lat: 35.310 }, // Yuigahama Center
  { lng: 139.553, lat: 35.308 }, // Namerikawa mouth
  { lng: 139.560, lat: 35.302 }, // Zaimokuza Beach
  { lng: 139.568, lat: 35.298 }, // East border (Kotsubo entrance)
  { lng: 139.575, lat: 35.292 }, // Zushi Marina / Kotsubo
  { lng: 139.585, lat: 35.290 }  // Zushi Beach / East border
  ];

 // Find the exact coastline latitude at the point's longitude using linear interpolation
 let coastLat = null;
 for (let i = 0; i < coastPts.length - 1; i++) {
 const p1 = coastPts[i];
 const p2 = coastPts[i+1];
 if (lng >= p1.lng && lng <= p2.lng) {
 const ratio = (lng - p1.lng) / (p2.lng - p1.lng);
 coastLat = p1.lat + (p2.lat - p1.lat) * ratio;
 break;
 }
 }

 // If the point is south of the interpolated coastline (ocean / sea), strictly exclude it!
 if (coastLat !== null && lat < coastLat) {
 console.log(`[SafeEdge] Ocean Exclusion: Point is south of the coastline (in the sea): ${lat}, ${lng} (Coast Lat: ${coastLat})`);
 return true;
 }

  if (!window.turf) return false;
   const pt = turf.point([lng, lat]);
 
 // Coastline coordinates from West to East (covers Kamakura entire coast and Kotsubo peninsula)
 const coastLine = turf.lineString([
 [139.460, 35.310], // Far West border
 [139.470, 35.309], // West border
 [139.485, 35.307], // Koshigoe
 [139.500, 35.304], // Shichirigahama
 [139.515, 35.302],
 [139.525, 35.301], // Inamuragasaki
 [139.535, 35.310], // Yuigahama West
 [139.545, 35.310], // Yuigahama Center
 [139.553, 35.308], // Namerikawa mouth
 [139.560, 35.302], // Zaimokuza Beach
 [139.568, 35.298], // East border (Kotsubo entrance)
 [139.565, 35.292], // Kotsubo coast south
 [139.563, 35.285], // Kotsubo outer coast
 [139.562, 35.275] // Kotsubo outer tip
 ]);
 
 // -------------------------------------------------------------
 // [ENHANCED GEOPROXIMITY FENCING] Comprehensive River network definitions
 // -------------------------------------------------------------
 
 // 1. Namerikawa River System (Main stream: Mouth -> Kamakura Center -> Jomyoji -> Juiso)
 const namerikawaLine = turf.lineString([
 [139.553, 35.308], // Mouth
 [139.554, 35.311],
 [139.556, 35.315],
 [139.558, 35.319],
 [139.560, 35.323], // Branch point (to Nikaidogawa)
 [139.564, 35.321], // Jomyoji / Hokokuji front
 [139.569, 35.320], // Jomyoji East
 [139.576, 35.320], // Juiso
 [139.585, 35.318] // Juiso deep valley
 ]);
 
 // 2. Nikaidogawa River (Namerikawa Tributary branch)
 const nikaidogawaLine = turf.lineString([
 [139.560, 35.323], // Branch point from main stream
 [139.563, 35.326], // Kamakuragu front
 [139.568, 35.327], // Yofukuji-ato front
 [139.577, 35.326] // Zuisenji valley
 ]);

 // 3. Gokurakujigawa River (West-Central valley)
 const gokurakujiLine = turf.lineString([
 [139.525, 35.301], // Mouth at Inamuragasaki
 [139.528, 35.309], // Gokurakuji Station front
 [139.524, 35.315] // Yamazaki valley
 ]);
 
 // 4. Sakaigawa / Kobaigawa River System (West boundary)
 const kobaigawaLine = turf.lineString([
 [139.480, 35.307], // Mouth at Koshigoe
 [139.482, 35.312], // Koshigoe Station east
 [139.485, 35.318], // Tsu
 [139.488, 35.322], // Nishi-Kamakura Station
 [139.495, 35.326], // Tebiro
 [139.505, 35.328], // Fukasawa
 [139.515, 35.329] // Kajiwara valley
 ]);
 
 const distToCoast = turf.pointToLineDistance(pt, coastLine, {units: 'meters'});
 const distToNamerikawa = turf.pointToLineDistance(pt, namerikawaLine, {units: 'meters'});
 const distToNikaidogawa = turf.pointToLineDistance(pt, nikaidogawaLine, {units: 'meters'});
 const distToGokurakuji = turf.pointToLineDistance(pt, gokurakujiLine, {units: 'meters'});
 const distToKobaigawa = turf.pointToLineDistance(pt, kobaigawaLine, {units: 'meters'});
 
 // Dynamic River buffer: 40m for downstream (flat land), 20m for upstream (mountains/valleys)
 // This prevents over-exclusion in upper valleys (resolves missing plots) while strictly blocking direct river banks.
 const riverBufferDist = lat < 35.315 ? 40 : 20;
 
 if (distToCoast < 50) return true;
 if (distToNamerikawa < riverBufferDist) return true;
 if (distToNikaidogawa < riverBufferDist) return true;
 if (distToGokurakuji < riverBufferDist) return true;
 if (distToKobaigawa < riverBufferDist) return true;
 
 return false;
 }

 /**
 * Dynamically verifies that all safe edges in safeEdgesData are strictly outside the inundation zone.
 * Removes any points that are determined to be inside (alpha > 0) or too close to coast/rivers.
 */
  async function verifyAndCleanSafeEdges() {
  if (safeEdgesData.length === 0) return;
  console.log(`[SafeEdge] 螳牙・蠅・阜轤ｹ ${safeEdgesData.length} 莉ｶ縺ｮ蜍慕噪繝舌ャ繝∵､懆ｨｼ・域ｵｷ豢句愛螳壹♀繧医・豢･豕｢豬ｸ豌ｴR_SAFE螳牙・讀懆ｨｼ・峨ｒ髢句ｧ九＠縺ｾ縺・..`);
  
  const zoom = 14;
  const prefCode = currentPrefCode || '14';
  
  // 1. Group points by tile coordinate (x, y) to load each PNG tile only once (extremely fast & efficient!)
  const tileGroups = {};
  safeEdgesData.forEach(edge => {
  const coords = getTileCoords(edge.lat, edge.lng, zoom);
  const key = `${coords.x}_${coords.y}`;
  if (!tileGroups[key]) {
  tileGroups[key] = { x: coords.x, y: coords.y, edges: [] };
  }
  tileGroups[key].edges.push({ edge, coords });
  });
  
  // 2. Load and verify each unique tile in parallel
  const verifiedEdges = [];
  const tileKeys = Object.keys(tileGroups);
  
  await Promise.all(tileKeys.map(async (key) => {
  const group = tileGroups[key];
  const url = `https://disaportaldata.gsi.go.jp/raster/04_tsunami_newlegend_pref_data/${prefCode}/${zoom}/${group.x}/${group.y}.png`;
  const pixels = await loadTilePixelData(url);
  
  group.edges.forEach(({ edge, coords }) => {
  // A. Strictly verify ocean boundary (using generalizable linear interpolation)
  if (isNearCoastOrWater(edge.lat, edge.lng)) {
  console.log(`[SafeEdge] verifyAndClean: 豬ｷ豢九∪縺溘・豌ｴ邉ｻ霑大ｍ縺ｮ縺溘ａ髯､螟・ ${edge.name || edge.id} (${edge.lat}, ${edge.lng})`);
  return;
  }
  
  // B. If tsunami tile is found, strictly verify pixels
  if (pixels) {
  const px = coords.px;
  const py = coords.py;
  
  // Check if own pixel is inundated
  if (pixels[(py * 256 + px) * 4 + 3] > 0) {
  console.log(`[SafeEdge] verifyAndClean: 豬ｸ豌ｴ蝓溷・縺ｮ縺溘ａ髯､螟・ ${edge.name || edge.id} (${edge.lat}, ${edge.lng})`);
  return;
  }
  
  // Dynamic generalizable riverbank anomaly sandwich check
  let isSandwiched = false;
  const OPPOSITE_PAIRS = [
    [[0, -1], [0, 1]],   // West - East
    [[-1, 0], [1, 0]],   // North - South
    [[-1, -1], [1, 1]],  // Northwest - Southeast
    [[-1, 1], [1, -1]]   // Northeast - Southwest
  ];
  const MAX_RIVER_WIDTH_PX = 10;
  
  for (const [dir1, dir2] of OPPOSITE_PAIRS) {
    let hit1 = false;
    let hit2 = false;
    
    for (let d = 1; d <= MAX_RIVER_WIDTH_PX; d++) {
      const nx = px + dir1[0] * d;
      const ny = py + dir1[1] * d;
      if (nx >= 0 && nx < 256 && ny >= 0 && ny < 256) {
        if (pixels[(ny * 256 + nx) * 4 + 3] > 0) {
          hit1 = true;
          break;
        }
      }
    }
    
    for (let d = 1; d <= MAX_RIVER_WIDTH_PX; d++) {
      const nx = px + dir2[0] * d;
      const ny = py + dir2[1] * d;
      if (nx >= 0 && nx < 256 && ny >= 0 && ny < 256) {
        if (pixels[(ny * 256 + nx) * 4 + 3] > 0) {
          hit2 = true;
          break;
        }
      }
    }
    
    if (hit1 && hit2) {
      isSandwiched = true;
      break;
    }
  }
  
  if (isSandwiched) {
    console.log(`[SafeEdge] verifyAndClean: Excluded sandwiched riverbed/riverbank anomaly: ${edge.name || edge.id} (${edge.lat}, ${edge.lng})`);
    return;
  }
  
  // Check safety buffer R_SAFE (80m)
  const R_SAFE = 8;
  let tooClose = false;
  for (let dy = -R_SAFE; dy <= R_SAFE; dy++) {
  for (let dx = -R_SAFE; dx <= R_SAFE; dx++) {
  const ny = py + dy;
  const nx = px + dx;
  if (ny >= 0 && ny < 256 && nx >= 0 && nx < 256) {
  if (pixels[(ny * 256 + nx) * 4 + 3] > 0) {
  tooClose = true;
  break;
  }
  }
  }
  if (tooClose) break;
  }
  if (tooClose) {
  console.log(`[SafeEdge] verifyAndClean: 豬ｸ豌ｴ螳牙・繝舌ャ繝輔ぃ(80m)荳崎ｶｳ縺ｮ縺溘ａ髯､螟・ ${edge.name || edge.id} (${edge.lat}, ${edge.lng})`);
  return;
  }
  }
  
  // Passed all safety checks!
  verifiedEdges.push(edge);
  });
  }));

  // Passed all local tile/coastal checks, now do generalizable ocean filter via GSI Elevation API in batches
  console.log(`[SafeEdge] Local verification passed. Performing generalizable GSI Elevation ocean filter on ${verifiedEdges.length} points...`);
  
  const finalVerifiedEdges = [];
  const BATCH_SIZE = 15;
  for (let i = 0; i < verifiedEdges.length; i += BATCH_SIZE) {
    const chunk = verifiedEdges.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(chunk.map(async (edge) => {
      try {
        const url = `https://cyberjapandata2.gsi.go.jp/general/dem/scripts/getelevation.php?lon=${edge.lng}&lat=${edge.lat}&outtype=JSON`;
        const res = await fetch(url);
        const data = await res.json();
        if (data && data.elevation === '-----') {
          console.log(`[SafeEdge] Ocean Detected by GSI Elevation API (Excluded): ${edge.name || edge.id} at ${edge.lat}, ${edge.lng}`);
          return null;
        }
        return edge;
      } catch (err) {
        return edge;
      }
    }));
    results.forEach(r => {
      if (r !== null) finalVerifiedEdges.push(r);
    });
  }

  console.log(`[SafeEdge] GSI Ocean filter complete. Verified: ${finalVerifiedEdges.length} / ${verifiedEdges.length}`);
  safeEdgesData = finalVerifiedEdges;
  }

 /**
 * Scans GSI tsunami raster tiles for ALL inundation-boundary ﾃ・safe-zone crossing points.
 * Finds pixels that are outside the inundation zone but directly adjacent to inside pixels.
 * Returns a dense array of {id, name, lat, lng} objects covering the entire Kamakura area.
 * @param {string} prefCode - Prefecture code, e.g. '14' for Kanagawa
 */
 async function computeSafeEdgesFromRasterScan(prefCode = '14') {
 console.log('[SafeEdge] 豢･豕｢豬ｸ豌ｴ蛹ｺ蝓溘・蠅・阜繧ｹ繧ｭ繝｣繝ｳ繧帝幕蟋九＠縺ｾ縺・..');
 
 // Dynamic Bounding Box calculation based on currentLocation to generalize to any location in Japan!
 let bbox = { latMin: 35.27, latMax: 35.37, lngMin: 139.47, lngMax: 139.585 };
  
  if (currentLocation && currentLocation.lat && currentLocation.lng) {
  bbox = {
  latMin: currentLocation.lat - 0.05,
  latMax: currentLocation.lat + 0.05,
  lngMin: currentLocation.lng - 0.06,
  lngMax: currentLocation.lng + 0.06
  };
  console.log(`[SafeEdge] Dynamic Bounding Box generated centered at currentLocation: ${currentLocation.lat}, ${currentLocation.lng}`);
  } else if (map) {
  const bounds = map.getBounds();
  bbox = {
  latMin: bounds.getSouth(),
  latMax: bounds.getNorth(),
  lngMin: bounds.getWest(),
  lngMax: bounds.getEast()
  };
  console.log(`[SafeEdge] Dynamic Bounding Box generated from active map view bounds.`);
  }
 const zoom = 14; // ~10m per pixel 窶・high resolution
 const pow2 = Math.pow(2, zoom);

 // Compute tile index range for the bounding box
 const txMin = Math.floor((bbox.lngMin + 180) / 360 * pow2);
 const txMax = Math.floor((bbox.lngMax + 180) / 360 * pow2);
 const tyMin = Math.floor((1 - Math.log(Math.tan(bbox.latMax * Math.PI / 180) + 1 / Math.cos(bbox.latMax * Math.PI / 180)) / Math.PI) / 2 * pow2);
 const tyMax = Math.floor((1 - Math.log(Math.tan(bbox.latMin * Math.PI / 180) + 1 / Math.cos(bbox.latMin * Math.PI / 180)) / Math.PI) / 2 * pow2);

 const STEP = 4; // Sample every 4th pixel (~40m spacing)
 const GRID = 0.0008; // Deduplication grid cell ~80m
 const edgeMap = new Map(); // gridKey 竊・{lat, lng, id, name}

 const R_SAFE = 8;   // 8 pixels 竕・80m safety margin buffer from inundation zone
 const R_OUTER = 12; // 12 pixels 竕・120m proximity search limit to inundation zone

 // Gather all tile loading tasks
 const tileTasks = [];
 for (let tx = txMin; tx <= txMax; tx++) {
 for (let ty = tyMin; ty <= tyMax; ty++) {
 const url = `https://disaportaldata.gsi.go.jp/raster/04_tsunami_newlegend_pref_data/${prefCode}/${zoom}/${tx}/${ty}.png`;
 tileTasks.push({ tx, ty, url });
 }
 }

 console.log(`[SafeEdge] 繧ｹ繧ｭ繝｣繝ｳ蟇ｾ雎｡繧ｿ繧､繝ｫ謨ｰ: ${tileTasks.length}譫壹・繝ｭ繝ｼ繝峨ｒ髢句ｧ・..`);

 // Load all tiles in parallel (dramatically faster)
 const loadedTiles = await Promise.all(tileTasks.map(async (task) => {
 const pixels = await loadTilePixelData(task.url);
 return { tx: task.tx, ty: task.ty, pixels };
 }));

 let tilesScanned = 0;
 for (const tile of loadedTiles) {
 if (!tile.pixels) continue;
 tilesScanned++;

 const pixels = tile.pixels;
 const tx = tile.tx;
 const ty = tile.ty;

 // Scan for boundary: safe pixel (alpha === 0) close to inundation (R_OUTER)
 for (let py = R_OUTER; py < 256 - R_OUTER; py += STEP) {
 for (let px = R_OUTER; px < 256 - R_OUTER; px += STEP) {
 const thisAlpha = pixels[(py * 256 + px) * 4 + 3];
 if (thisAlpha > 0) continue; // Must be strictly outside (safe)

 // Convert pixel 竊・lat/lng (Web Mercator)
 const lng = (tx + px / 256) / pow2 * 360 - 180;
 const mercN = Math.PI - 2 * Math.PI * (ty + py / 256) / pow2;
 const lat = 180 / Math.PI * Math.atan(0.5 * (Math.exp(mercN) - Math.exp(-mercN)));

 // Skip if the point is near the coastline or rivers
 if (isNearCoastOrWater(lat, lng)) continue;

  // [GENERALIZED APPROACH C] Topological Opposite-Ray-Casting River/Estuary Filter
  // This mathematically detects narrow riverbeds, riverbanks, and dynamic estuary slits
  // by verifying if a transparent (safe) pixel is sandwiched between inundated (colored) pixels
  // in any opposite direction pair. Check up to 10 pixels (~100m) in 4 directions.
  let isSandwiched = false;
  const OPPOSITE_PAIRS = [
    [[0, -1], [0, 1]],   // West - East
    [[-1, 0], [1, 0]],   // North - South
    [[-1, -1], [1, 1]],  // Northwest - Southeast
    [[-1, 1], [1, -1]]   // Northeast - Southwest
  ];
  const MAX_RIVER_WIDTH_PX = 10;
  
  for (const [dir1, dir2] of OPPOSITE_PAIRS) {
    let hit1 = false;
    let hit2 = false;
    
    // Cast ray in direction 1
    for (let d = 1; d <= MAX_RIVER_WIDTH_PX; d++) {
      const nx = px + dir1[0] * d;
      const ny = py + dir1[1] * d;
      if (nx >= 0 && nx < 256 && ny >= 0 && ny < 256) {
        if (pixels[(ny * 256 + nx) * 4 + 3] > 0) {
          hit1 = true;
          break;
        }
      }
    }
    
    // Cast ray in direction 2 (opposite)
    for (let d = 1; d <= MAX_RIVER_WIDTH_PX; d++) {
      const nx = px + dir2[0] * d;
      const ny = py + dir2[1] * d;
      if (nx >= 0 && nx < 256 && ny >= 0 && ny < 256) {
        if (pixels[(ny * 256 + nx) * 4 + 3] > 0) {
          hit2 = true;
          break;
        }
      }
    }
    
    if (hit1 && hit2) {
      isSandwiched = true;
      break;
    }
  }
  
  if (isSandwiched) {
    console.log(`[SafeEdge] Excluded point inside sandwiched riverbed/riverbank anomaly at ${lat.toFixed(5)}, ${lng.toFixed(5)}`);
    continue;
  }

  // [CRITICAL] R_SAFE Safety Margin Check (8 pixels 竕・80m buffer from inundation pixels)
 // This mathematically guarantees that no green plot point lies inside or overlaps with the pink/red hazard zone.
 let tooCloseToInundation = false;
  for (let dy = -R_SAFE; dy <= R_SAFE; dy++) {
   for (let dx = -R_SAFE; dx <= R_SAFE; dx++) {
 if (pixels[((py + dy) * 256 + (px + dx)) * 4 + 3] > 0) {
 tooCloseToInundation = true;
 break;
 }
 }
 if (tooCloseToInundation) break;
 }
 if (tooCloseToInundation) continue; // Skip if it's too close to the hazard edge

 // [GENERALIZED APPROACH B] Topological Ray-Casting River/Slit Filter
 // Cast rays in 8 directions up to 4 pixels (~40m) to check if this point is 
 // trapped in a narrow riverbed or a flood-prone slit (surrounded by inundation on 4+ sides).
 // This mathematically detects water channels and riverbeds generally, without hardcoding coordinates.
 let hitCount = 0;
 const dirs = [
 [0, -1], // N
 [1, -1], // NE
 [1, 0], // E
 [1, 1], // SE
 [0, 1], // S
 [-1, 1], // SW
 [-1, 0], // W
 [-1, -1] // NW
 ];
 const RAY_DIST = 4; // Check up to 4 pixels (~40m)
 
 for (const [dx, dy] of dirs) {
 let hitInundation = false;
 for (let d = 1; d <= RAY_DIST; d++) {
 const nx = px + dx * d;
 const ny = py + dy * d;
 // Ensure we stay inside the 256x256 tile pixel grid
 if (nx >= 0 && nx < 256 && ny >= 0 && ny < 256) {
 if (pixels[(ny * 256 + nx) * 4 + 3] > 0) {
 hitInundation = true;
 break;
 }
 }
 }
 if (hitInundation) {
 hitCount++;
 }
 }
 
 // If 6 or more directions (out of 8) hit the inundation zone within ~40m,
 // it is highly likely a narrow riverbed, dynamic estuary slit, or unsafe dead-end flatland.
 if (hitCount >= 6) {
 continue;
 }

  // Verify proximity: at least one pixel in outer shell (R_SAFE + 1 to R_OUTER pixels away) must be inundated (alpha > 0)
 let hasInsideNeighbor = false;
  // (Reusing global const R_OUTER)
  for (let dy = -R_OUTER; dy <= R_OUTER; dy++) {
   for (let dx = -R_OUTER; dx <= R_OUTER; dx++) {
 // Skip the inner 3x3 box we already verified is completely safe
    // Skip the inner R_SAFE box we already verified is completely safe
    if (Math.abs(dy) <= R_SAFE && Math.abs(dx) <= R_SAFE) continue;
 const ny = py + dy;
 const nx = px + dx;
 if (pixels[(ny * 256 + nx) * 4 + 3] > 0) {
 hasInsideNeighbor = true;
 break;
 }
 }
 if (hasInsideNeighbor) break;
 }
 if (!hasInsideNeighbor) continue; // Too far from the boundary

 // Deduplicate to GRID resolution
 const gk = `${Math.round(lat / GRID)}_${Math.round(lng / GRID)}`;
 if (!edgeMap.has(gk)) {
 edgeMap.set(gk, {
 id: `scan_${edgeMap.size}`,
 name: '安全境界点',
 lat: Math.round(lat * 100000) / 100000,
 lng: Math.round(lng * 100000) / 100000
 });
 }
 }
 }
 }

 const edges = Array.from(edgeMap.values());
 console.log(`[SafeEdge] 繧ｹ繧ｭ繝｣繝ｳ螳御ｺ・ ${tilesScanned}/${tileTasks.length}繧ｿ繧､繝ｫ蜃ｦ逅・竊・${edges.length}莉ｶ of 螳牙・蠅・阜轤ｹ`);
 return edges;
 }

 /**
 * 謖・ｮ壹＆繧後◆菴咲ｽｮ縺梧ｴ･豕｢豬ｸ豌ｴ諠ｳ螳壼玄蝓溷・縺ｫ縺ゅｋ縺九ｒPNG繧ｿ繧､繝ｫ縺ｮ繝斐け繧ｻ繝ｫ騾城℃蠎ｦ繧堤畑縺・※鬮倡ｲｾ蠎ｦ縺ｫ蛻､螳壹☆繧・

 * @param {number} lat 邱ｯ蠎ｦ
 * @param {number} lng 邨悟ｺｦ
 * @param {string} prefCode 驛ｽ驕灘ｺ懃恁繧ｳ繝ｼ繝・
 * @returns {Promise<boolean>} 豬ｸ豌ｴ諠ｳ螳壼玄蝓溷・縺ｪ繧液rue縲∝玄蝓溷､悶↑繧映alse
 */
 function checkTsunamiInundation(lat, lng, prefCode) {
 return new Promise((resolve) => {
 const zoom = 14;
 const coords = getTileCoords(lat, lng, zoom);
 const tileUrl = `https://disaportaldata.gsi.go.jp/raster/04_tsunami_newlegend_pref_data/${prefCode}/${zoom}/${coords.x}/${coords.y}.png`;
 
 const img = new Image();
 img.crossOrigin = "anonymous";
 
 img.onload = function() {
 try {
 const canvas = document.createElement('canvas');
 canvas.width = 256;
 canvas.height = 256;
 const ctx = canvas.getContext('2d');
 ctx.drawImage(img, 0, 0);
 
 const pixel = ctx.getImageData(coords.px, coords.py, 1, 1).data;
 const alpha = pixel[3]; // 透明度 (0-255)
 
 // 繧｢繝ｫ繝輔ぃ蛟､縺・繧医ｊ螟ｧ縺阪＞・郁牡縺御ｻ倥＞縺ｦ縺・ｋ・牙ｴ蜷医∵ｵｸ豌ｴ諠ｳ螳壼玄蝓溷・縺ｨ蛻､螳・
 const isInundated = alpha > 0;
 console.log(`[Tsunami Hazard] Location check: alpha=${alpha}, isInundated=${isInundated}`);
 resolve(isInundated);
 } catch (e) {
 console.error('[Tsunami Hazard] Canvas processing error:', e);
 resolve(false);
 }
 };
 
 img.onerror = function() {
 // 逕ｻ蜒上′縺ｪ縺・ｼ医ち繧､繝ｫ縺悟ｭ伜惠縺励↑縺・∝・髯ｸ縺ｪ縺ｩ・牙ｴ蜷医・豬ｸ豌ｴ諠ｳ螳壼玄蝓溷､悶→縺ｿ縺ｪ縺・
 resolve(false);
 };
 
 img.src = tileUrl;
 });
 }

 /**
 * 蛻､螳夂ｵ先棡繧辿UD荳企Κ繝舌・・・sunami-status-box・峨↓鄒弱＠縺・げ繝ｩ繧ｹ繝｢繝ｫ繝輔ぅ繧ｺ繝繝舌ャ繧ｸ縺ｨ縺励※蜿肴丐縺吶ｋ
 * @param {boolean} isInundated 豬ｸ豌ｴ諠ｳ螳壼玄蝓溷・縺九←縺・°
 */
 function updateTsunamiStatusUI(isInundated) {
 const box = document.getElementById('tsunami-status-box');
 const textSpan = document.getElementById('tsunami-status-text');
 if (!box || !textSpan) return;
 
 box.classList.remove('hidden');
 box.className = 'dash-info-card'; // クラスの初期化
 
 // 逕ｻ髱｢蟷・′繧ｹ繝槭・縺九←縺・°・医Ξ繧ｹ繝昴Φ繧ｷ繝悶↑陦ｨ險倥・蠕ｮ隱ｿ謨ｴ・・
 const isMobile = window.innerWidth <= 600;
 const dict = i18nDict[getLanguageCode()] || i18nDict['ja'] || {};
 
 if (isInundated) {
 box.classList.add('tsunami-status-danger');
 textSpan.textContent = isMobile 
  ? (dict.tsunamiStatusDangerMobile || 'Inside Inundation Zone') 
  : (dict.tsunamiStatusDangerDesktop || 'Inside Tsunami Inundation Zone');
 
 // Smartphone Background System Notification & Warning Vibration for Ingress
 if (isEmergency && !isEvacuationCompleted) {
 const now = Date.now();
 if (now - lastInundationNotificationTime > 12000) {
 sendSystemNotification(
  dict.tsunamiWarningTitle || 'Tsunami Hazard Warning',
  dict.tsunamiWarningDesc || 'Warning: Entered tsunami inundation zone. Please move to higher ground immediately.',
 "inundation-alert"
 );
 if ('vibrate' in navigator) {
 navigator.vibrate([400, 100, 400, 100, 400]);
 }
 lastInundationNotificationTime = now;
 }
 }
 } else {
 box.classList.add('tsunami-status-safe');
 textSpan.textContent = isMobile 
  ? (dict.tsunamiStatusSafeMobile || 'Outside Inundation Zone') 
  : (dict.tsunamiStatusSafeDesktop || 'Outside Tsunami Inundation Zone');
 }
 }

 /**
 * 迴ｾ蝨ｨ蝨ｰ縺ｾ縺溘・迚ｹ螳壼ｺｧ讓吶↓蝓ｺ縺･縺上√ワ繧ｶ繝ｼ繝峨ち繧､繝ｫ譖ｴ譁ｰ縺翫ｈ縺ｳ豬ｸ豌ｴ諠ｳ螳壼愛螳壹・邱丞粋螳溯｡碁未謨ｰ
 * @param {Object} loc 邱ｯ蠎ｦ邨悟ｺｦ繧ｪ繝悶ず繧ｧ繧ｯ繝・{lat, lng}
 */
 async function triggerLocationTsunamiCheck(loc) {
 if (!loc || typeof loc.lat !== 'number' || typeof loc.lng !== 'number') return;
 
 // 1. 縺ｾ縺夐・ず繧ｪ繧ｳ繝ｼ繝・ぅ繝ｳ繧ｰ縺ｧ驛ｽ驕灘ｺ懃恁繧ｳ繝ｼ繝峨ｒ迚ｹ螳壹＠縲√ち繧､繝ｫURL繧貞・繧頑崛縺・
 const prefCode = await updateTsunamiPrefecturalTile(loc.lat, loc.lng);
 
 // 2. 縺昴・驛ｽ驕灘ｺ懃恁繧ｳ繝ｼ繝峨・繧ｿ繧､繝ｫ繧堤畑縺・※縲∫樟蝨ｨ蝨ｰ縺梧ｵｸ豌ｴ諠ｳ螳壼玄蝓溷・縺九ｒ繝斐け繧ｻ繝ｫ蛻､螳・
 const isInundated = await checkTsunamiInundation(loc.lat, loc.lng, prefCode);
 
 // 3. UI縺ｫ邨先棡繧貞渚譏
 updateTsunamiStatusUI(isInundated);
 }

 function getEvacuationSpeed() {
 const speedKmh = parseFloat(localStorage.getItem('tenden-walk-speed') || '4.0');
 return speedKmh / 3.6; // Convert km/h to m/s
 }

 function showShareEvacuationPlanDialog() {
 const dict = i18nDict[getLanguageCode()] || i18nDict['ja'] || {};
 
 const selectedRoute = activeRoutesList ? activeRoutesList.find(r => r.id === activeSelectedRouteId) : null;
 
 let routeLabel = '';
 if (selectedRoute) {
 routeLabel = selectedRoute.label;
 } else {
 const fallbackNames = {
  'A': dict.routeShortestLabel || '最短ルート',
  'B': dict.routeAvoidLabel || '混雑回避ルート',
  'C': dict.routeBarrierLabel || 'バリアフリールート',
  'D': dict.routeDispersal || 'Dispersed Route'
 };
 routeLabel = fallbackNames[activeSelectedRouteId] || fallbackNames['A'];
 }
 
 const destination = activeSecondaryRoute && activeSecondaryRoute.shelter ? activeSecondaryRoute.shelter.name : (activeSafeEdge ? activeSafeEdge.name : '安全な高台');
 
 let localizedDest = destination;
 const currentLang = getLanguageCode();
 if (currentLang !== 'ja') {
 const replacements = [
  { jp: 'PrimarySchool', en: ' Primary School', zh: 'Primary School', ko: 'Primary School' },
  { jp: 'MiddleSchool', en: ' Middle School', zh: 'Middle School', ko: 'Middle School' },
  { jp: 'TemplePrecincts', en: ' Temple Precincts', zh: 'Temple Precincts', ko: 'Temple Precincts' },
  { jp: 'LearningCenter', en: ' Community Learning Center', zh: 'Learning Center', ko: 'Learning Center' }
 ];
 for (const rep of replacements) {
 if (destination.endsWith(rep.jp)) {
 localizedDest = destination.replace(rep.jp, rep[currentLang] || rep['en']);
 break;
 }
 }
 }
 
 const speed = parseFloat(localStorage.getItem('tenden-walk-speed') || '4.0');
 const distance_m = selectedRoute ? selectedRoute.distance_m : (activeSecondaryRoute ? activeSecondaryRoute.distance_m : 600);
 const duration_min = Math.max(1, Math.round((distance_m / (speed * 1000 / 60))));
 
 let shareText = '';
 if (currentLang === 'ja') {
 shareText = `【TENDENマイ避難計画】\n大地震発生時、私の第一目標（浸水安全境界）を完了し次第避難所「${localizedDest}」へ向かいます。`;
 } else {
 shareText = `[TENDEN Personal Evacuation Plan]\nIn the event of a tsunami, I will evacuate to the designated shelter "${localizedDest}" via the 1st safe boundary.\n- Evacuation Route: ${routeLabel}\n- Estimated Time: approx. ${duration_min} min (Speed: ${speed} km/h)\nCheck your own evacuation route now using the offline-first PWA app "TENDEN"!\nApp Link: https://masatosprojects.github.io/tenden-app/`;
 }
 
 const shareTextArea = document.getElementById('share-text-area');
 if (shareTextArea) {
 shareTextArea.value = shareText;
 }
 
 const shareOverlay = document.getElementById('share-overlay');
 if (shareOverlay) {
 shareOverlay.classList.remove('hidden');
 setTimeout(() => shareOverlay.classList.add('active'), 50);
 }
 }

 // ==========================================================================
 // Smartphone Premium Features Core Logic (Wake Lock, Compass, Native Notifications, Haptics, Battery Status)
 // ==========================================================================

 function triggerHapticTick() {
 if ('vibrate' in navigator) {
 navigator.vibrate([15]);
 }
 }

 async function requestWakeLock() {
 const isWakeLockEnabled = localStorage.getItem('tenden-wake-lock') !== 'false';
 if (!isWakeLockEnabled || wakeLock) return;

 try {
 if ('wakeLock' in navigator) {
 wakeLock = await navigator.wakeLock.request('screen');
 console.log('[WakeLock] Screen Wake Lock acquired!');
 
 // Clear wakeLock object on release so it can be re-acquired on visibility focus
 wakeLock.addEventListener('release', () => {
 wakeLock = null;
 console.log('[WakeLock] Screen Wake Lock was released.');
 });
 }
 } catch (err) {
 console.warn('[WakeLock] Failed to acquire Screen Wake Lock:', err);
 }
 }

 function releaseWakeLock() {
 if (wakeLock) {
 wakeLock.release().then(() => {
 wakeLock = null;
 console.log('[WakeLock] Screen Wake Lock released.');
 });
 }
 }

 // Handle visibility changes for Wake Lock
 document.addEventListener('visibilitychange', async () => {
 if (document.visibilityState === 'visible' && isEmergency) {
 await requestWakeLock();
 }
 });

 async function requestNotificationPermission() {
 const isNotificationEnabled = localStorage.getItem('tenden-system-notification') !== 'false';
 if (!isNotificationEnabled) return;

 if ('Notification' in window) {
 if (Notification.permission === 'default') {
 const permission = await Notification.requestPermission();
 if (permission === 'granted') {
 console.log('[Notification] Notification permission granted!');
 const dict = i18nDict[getLanguageCode()] || i18nDict['ja'] || {};
 triggerDynamicIsland(dict.notificationGranted || "通知許可が有効になりました", "success");
 }
 }
 }
 }

 function sendSystemNotification(title, body, tag = 'tenden-drill') {
 const isNotificationEnabled = localStorage.getItem('tenden-system-notification') !== 'false';
 if (!isNotificationEnabled || !('Notification' in window) || Notification.permission !== 'granted') return;

 if (navigator.serviceWorker && navigator.serviceWorker.ready) {
 navigator.serviceWorker.ready.then(registration => {
 registration.showNotification(title, {
 body: body,
 icon: 'assets/icons/icon.svg',
 vibrate: [500, 100, 500],
 tag: tag,
 renotify: true
 });
 });
 } else {
 try {
 new Notification(title, {
 body: body,
 icon: 'assets/icons/icon.svg',
 tag: tag
 });
 } catch (e) {
 console.warn('[Notification] Fallback standard Notification failed:', e);
 }
 }
 }

 async function requestOrientationPermission() {
 const isCompassEnabled = localStorage.getItem('tenden-smart-compass') !== 'false';
 if (!isCompassEnabled) return;

 if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
 try {
 const permissionState = await DeviceOrientationEvent.requestPermission();
 if (permissionState === 'granted') {
 console.log('[Compass] DeviceOrientation permission granted!');
 window.addEventListener('deviceorientation', handleOrientation, true);
 }
 } catch (error) {
 console.warn('[Compass] DeviceOrientation permission request failed:', error);
 }
 } else {
 // Support absolute orientation for Android to prevent double event firing and reduce battery drain
 if ('ondeviceorientationabsolute' in window) {
 window.addEventListener('deviceorientationabsolute', handleOrientation, true);
 } else {
 window.addEventListener('deviceorientation', handleOrientation, true);
 }
 }
 }

 function handleOrientation(event) {
 const isCompassEnabled = localStorage.getItem('tenden-smart-compass') !== 'false';
 if (!isCompassEnabled) {
 const arrow = document.querySelector('.user-marker-arrow');
 if (arrow) arrow.style.display = 'none';
 return;
 }

 let heading = null;
 if (event.webkitCompassHeading) {
 heading = event.webkitCompassHeading;
 } else if (event.absolute && event.alpha) {
 heading = 360 - event.alpha;
 } else if (event.alpha) {
 heading = 360 - event.alpha;
 }

 if (heading !== null) {
 lastHeading = heading;
 const arrow = document.querySelector('.user-marker-arrow');
 if (arrow) {
 arrow.style.display = 'block';
 arrow.style.transform = `rotate(${heading}deg)`;
 }
 }
 }

 function initBatteryWatcher() {
 if ('getBattery' in navigator) {
 navigator.getBattery().then(battery => {
 const checkBattery = () => {
 if (battery.level <= 0.20 && !battery.charging && !hasWarnedLowBattery) {
 hasWarnedLowBattery = true;
 if ('vibrate' in navigator) {
 navigator.vibrate([100, 100, 100]);
 }
 const dict = i18nDict[getLanguageCode()] || i18nDict['ja'] || {};
  const alertMsg = dict.lowBatteryWarning || 'Battery level below 20%: Please lower brightness to conserve GPS tracking.';
 triggerDynamicIsland(alertMsg, "warning");
  sendSystemNotification('TENDEN Low Battery Warning', alertMsg, 'battery-alert');
 } else if (battery.level > 0.20 || battery.charging) {
 hasWarnedLowBattery = false;
 }
 };

 checkBattery();
 battery.addEventListener('levelchange', checkBattery);
 battery.addEventListener('chargingchange', checkBattery);
 });
 }
 }

 async function getPrefectureCode(lat, lng) {
 // 1. Try free open reverse-geocoding API first (supports any place in Japan dynamically)
 try {
 const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=10`);
 const data = await res.json();
 if (data && data.address) {
 const state = data.address.state || '';
 const prefMap = {
            'Hokkaido': '01', 'Aomori': '02', 'Iwate': '03', 'Miyagi': '04', 'Akita': '05', 'Yamagata': '06', 'Fukushima': '07',
            'Ibaraki': '08', 'Tochigi': '09', 'Gunma': '10', 'Saitama': '11', 'Chiba': '12', 'Tokyo': '13', 'Kanagawa': '14',
            'Niigata': '15', 'Toyama': '16', 'Ishikawa': '17', 'Fukui': '18', 'Yamanashi': '19', 'Nagano': '20', 'Gifu': '21',
            'Shizuoka': '22', 'Aichi': '23', 'Mie': '24', 'Shiga': '25', 'Kyoto': '26', 'Osaka': '27', 'Hyogo': '28',
            'Nara': '29', 'Wakayama': '30', 'Tottori': '31', 'Shimane': '32', 'Okayama': '33', 'Hiroshima': '34', 'Yamaguchi': '35',
            'Tokushima': '36', 'Kagawa': '37', 'Ehime': '38', 'Kochi': '39', 'Fukuoka': '40', 'Saga': '41', 'Nagasaki': '42',
            'Kumamoto': '43', 'Oita': '44', 'Miyazaki': '45', 'Kagoshima': '46', 'Okinawa': '47'
 };
 for (const key in prefMap) {
 if (state.includes(key)) return prefMap[key];
 }
 }
 } catch (e) {
 console.warn('[Generalization] Reverse geocoding failed, falling back to proximity check...');
 }

 // 2. High-performance offline coordinate proximity fallback for coastal Japan prefectures (no internet required!)
 const centroids = [
 { code: '01', lat: 43.06, lng: 141.34 }, // Hokkaido
 { code: '02', lat: 40.82, lng: 140.74 }, // Aomori
 { code: '03', lat: 39.70, lng: 141.15 }, // Iwate
 { code: '04', lat: 38.26, lng: 140.87 }, // Miyagi
 { code: '12', lat: 35.60, lng: 140.12 }, // Chiba
 { code: '13', lat: 35.68, lng: 139.69 }, // Tokyo
 { code: '14', lat: 35.44, lng: 139.64 }, // Kanagawa
 { code: '22', lat: 34.97, lng: 138.38 }, // Shizuoka
 { code: '23', lat: 35.18, lng: 136.90 }, // Aichi
 { code: '28', lat: 34.69, lng: 135.19 }, // Hyogo
 { code: '30', lat: 34.22, lng: 135.16 }, // Wakayama
 { code: '39', lat: 33.55, lng: 133.53 }, // Kochi
 { code: '40', lat: 33.60, lng: 130.41 }, // Fukuoka
 { code: '47', lat: 26.21, lng: 127.67 } // Okinawa
 ];
 
 let minD = Infinity;
 let bestCode = '14';
 for (const c of centroids) {
 const d = Math.pow(lat - c.lat, 2) + Math.pow(lng - c.lng, 2);
 if (d < minD) {
 minD = d;
 bestCode = c.code;
 }
 }
 return bestCode;
 }

 async function generalizeFirstTargets(loc) {
 if (!loc || typeof loc.lat !== 'number' || typeof loc.lng !== 'number') return;
 
 // Rate-limit scan calls: only scan if center has shifted by > 3km
 if (lastScanCenter) {
 const dist = L.latLng(loc.lat, loc.lng).distanceTo(L.latLng(lastScanCenter.lat, lastScanCenter.lng));
 if (dist < 3000) {
 console.log('[Generalization] Shift is under 3km, skipping new raster scan.');
 return;
 }
 }
 lastScanCenter = { lat: loc.lat, lng: loc.lng };
 
 console.log('[Generalization] Target area changed -> reverse geocoding prefecture...');
 const prefCode = await getPrefectureCode(loc.lat, loc.lng);
 console.log(`[Generalization] Location reverse geocoded to Prefecture Code: ${prefCode}`);
 
 // Trigger background scan in the new BBox region dynamically
 computeSafeEdgesFromRasterScan(prefCode).then(async (dynamicEdges) => {
 if (dynamicEdges.length > 0) {
 // If we are outside Kamakura, we don't have safe_edges.json curated points,
 // so we just use dynamicEdges directly!
 const isKamakura = isInModelArea(loc);
 if (isKamakura) {
 const mergedEdges = [...staticSafeEdges];
 dynamicEdges.forEach(dyn => {
 const isDuplicate = mergedEdges.some(st => {
 const dist = L.latLng(st.lat, st.lng).distanceTo(L.latLng(dyn.lat, dyn.lng));
 return dist < 50;
 });
 if (!isDuplicate) {
 mergedEdges.push(dyn);
 }
 });
 safeEdgesData = mergedEdges;
 } else {
 safeEdgesData = dynamicEdges;
 }
   console.log(`[Generalization] Dynamic targets scanned successfully: ${safeEdgesData.length} points. Verifying safety...`);
  await verifyAndCleanSafeEdges();
  console.log(`[Generalization] Dynamic targets scanned and verified successfully: ${safeEdgesData.length} points remaining.`);
  drawAllSafeEdges();
 }
 }).catch(e => console.warn('[Generalization] Dynamic raster scan failed:', e));
 }

// 笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武
// ONBOARDING DEMO 窶・Cinematic 4-step scenario animation
// 笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武
  // 笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武
  // DYNAMIC COASTLINE PROXIMITY VECTOR AND SHORELINE ALIGNMENT
  // 笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武
  async function findNearestCoastline(loc) {
    if (window.turf) {
      const pt = turf.point([loc.lng, loc.lat]);
      const coastLine = turf.lineString([
        [139.460, 35.310], [139.470, 35.309], [139.485, 35.307],
        [139.500, 35.304], [139.515, 35.302], [139.525, 35.301],
        [139.535, 35.310], [139.545, 35.310], [139.553, 35.308],
        [139.560, 35.302], [139.568, 35.298], [139.565, 35.292],
        [139.563, 35.285], [139.562, 35.275]
      ]);
      const dist = turf.pointToLineDistance(pt, coastLine, {units: 'meters'});
      if (dist < 5000) {
        const nearest = turf.nearestPointOnLine(coastLine, pt);
        return {
          lat: nearest.geometry.coordinates[1],
          lng: nearest.geometry.coordinates[0],
          distance: dist,
          source: 'Kamakura Local Database'
        };
      }
    }

    // Fallback A: OpenStreetMap Overpass API (Generalizable globally)
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3000);
      const overpassUrl = `https://overpass-api.de/api/interpreter?data=[out:json];node(around:6000)["natural"="coastline"];out;`;
      const res = await fetch(overpassUrl, { signal: controller.signal });
      clearTimeout(timeoutId);
      const data = await res.json();
      
      if (data && data.elements && data.elements.length > 0) {
        let nearestNode = null;
        let minD = Infinity;
        data.elements.forEach(node => {
          const d = L.latLng(loc.lat, loc.lng).distanceTo(L.latLng(node.lat, node.lon));
          if (d < minD) {
            minD = d;
            nearestNode = node;
          }
        });
        if (nearestNode) {
          return {
            lat: nearestNode.lat,
            lng: nearestNode.lon,
            distance: minD,
            source: 'OpenStreetMap Overpass API'
          };
        }
      }
    } catch (e) {
      // ignore and try raycasting fallback
    }

    // Fallback B: Dynamic GSI Raycasting elevation transition check (Japan-wide)
    try {
      const dirs = [
        [0, -1], [0.5, -0.866], [0.866, -0.5], [1, 0], [0.866, 0.5], [0.5, 0.866],
        [0, 1], [-0.5, 0.866], [-0.866, 0.5], [-1, 0], [-0.866, -0.5], [-0.5, -0.866]
      ];
      const distances = [200, 500, 1000, 1800, 2600];
      const results = await Promise.all(dirs.map(async ([dx, dy]) => {
        for (const d of distances) {
          const dLat = (dy * d) / 111320;
          const dLng = (dx * d) / (40075000 * Math.cos(loc.lat * Math.PI / 180) / 360);
          const testLat = loc.lat + dLat;
          const testLng = loc.lng + dLng;
          try {
            const elUrl = `https://cyberjapandata2.gsi.go.jp/general/dem/scripts/getelevation.php?lon=${testLng}&lat=${testLat}&outtype=JSON`;
            const elRes = await fetch(elUrl);
            const elData = await elRes.json();
            if (elData && elData.elevation === '-----') {
              return { lat: testLat, lng: testLng, distance: d };
            }
          } catch (err) {}
        }
        return null;
      }));
      let nearestResult = null;
      let minD = Infinity;
      results.forEach(r => {
        if (r && r.distance < minD) {
          minD = r.distance;
          nearestResult = r;
        }
      });
      if (nearestResult) {
        return {
          lat: nearestResult.lat,
          lng: nearestResult.lng,
          distance: minD,
          source: 'GSI Raycasting'
        };
      }
    } catch (err) {}
    return null;
  }

  async function drawProximityToCoastline(loc) {
    const coast = await findNearestCoastline(loc);
    if (!coast) return;
    
    console.log(`[TENDEN] Coastline found at distance ${coast.distance.toFixed(1)}m via ${coast.source}`);
    
    if (coastalProximityLine) map.removeLayer(coastalProximityLine);
    if (coastalMarker) map.removeLayer(coastalMarker);
    
    const startLatLng = [loc.lat, loc.lng];
    const endLatLng = [coast.lat, coast.lng];
    
    coastalProximityLine = L.polyline([startLatLng, endLatLng], {
      color: '#ff2d55',
      dashArray: '8, 8',
      weight: 3,
      opacity: 0.8,
      className: 'coastal-proximity-line'
    }).addTo(map);
    
    const shorelineIcon = L.divIcon({
      className: 'shoreline-icon-container',
      html: `<div class="shoreline-pulse"></div><div class="shoreline-badge">海岸線まで ${Math.round(coast.distance)}m</div>`,
      iconSize: [120, 24],
      iconAnchor: [60, 12]
    });
    coastalMarker = L.marker(endLatLng, { icon: shorelineIcon }).addTo(map);
    
    const dict = i18nDict[getLanguageCode()] || i18nDict['ja'] || {};
    let alertTitle = dict.coastProximityTitle || 'Coast Proximity Alert';
    let alertDesc = dict.coastProximityDesc || "Near coastline. If a tsunami warning is active, please move inland and to higher ground immediately.";
    
    const elevationEl = document.getElementById('elevation-m');
    const elevationVal = elevationEl ? elevationEl.innerText : '--';
    alertDesc = alertDesc.replace('{elevation}', elevationVal);
    
    showCustomAlert(alertTitle, alertDesc, 'info');
    
    setTimeout(() => {
      if (coastalProximityLine) {
        let op = 0.8;
        const fadeInterval = setInterval(() => {
          op -= 0.05;
          if (op <= 0) {
            clearInterval(fadeInterval);
            if (coastalProximityLine) map.removeLayer(coastalProximityLine);
            if (coastalMarker) map.removeLayer(coastalMarker);
          } else {
            if (coastalProximityLine) coastalProximityLine.setStyle({ opacity: op });
          }
        }, 50);
      }
    }, 15000);
  }



// ── オンボーディングボタンの安全な直接配線 ──────────────────────────
// startOnboardingDemo 内でエラーが起きても必ずボタンが機能するフォールバック。
function wireOnboardingButtons() {
  var ov = document.getElementById('onboarding-overlay');
  function closeFB() {
    if (ov) {
      ov.classList.remove('active');
      setTimeout(function() { ov.classList.add('hidden'); }, 300);
    }
    try { localStorage.setItem('tenden-demo-seen', 'true'); } catch(e) {}
  }
  function goFB(step) {
    document.querySelectorAll('.demo-step').forEach(function(el) { el.classList.remove('active'); });
    var t = document.getElementById('demo-step-' + step);
    if (t) t.classList.add('active');
    document.querySelectorAll('.demo-dot').forEach(function(d, i) { d.classList.toggle('active', i === step); });
    // canvasアニメーションを起動（startOnboardingDemo の goToStep と同じ）
    if (step === 1) setTimeout(function() {
      try { animateMapCanvas(); } catch(e) {}
    }, 200);
    if (step === 2) setTimeout(function() {
      try { animateRoutesCanvas(); } catch(e) {}
    }, 200);
    if (step === 3) setTimeout(function() {
      try { animateFlowCanvas(); } catch(e) {}
    }, 200);
  }
  [
    ['btn-demo-next-0', function() { goFB(1); }],
    ['btn-demo-skip-0', function() { closeFB(); requestLocation(); }],
    ['btn-demo-next-1', function() { goFB(2); }],
    ['btn-demo-skip-1', function() { closeFB(); requestLocation(); }],
    ['btn-demo-next-2', function() { goFB(3); }],
    ['btn-demo-skip-2', function() { closeFB(); requestLocation(); }],
    ['btn-demo-use-here', function() { closeFB(); requestLocation(); }],
    ['btn-demo-replay', function() { goFB(0); }],
  ].forEach(function(pair) {
    var el = document.getElementById(pair[0]);
    if (!el) return;
    var fresh = el.cloneNode(true);
    el.parentNode.replaceChild(fresh, el);
    fresh.addEventListener('click', pair[1]);
    fresh.addEventListener('touchend', function(e) { e.preventDefault(); pair[1](); });
  });
}

function startOnboardingDemo() {
 const overlay = document.getElementById('onboarding-overlay');
 if (!overlay) return;

 // Show demo always on first load (localStorage tracks if demo was ever completed)
 // If user has seen it, skip onboarding and immediately request location tracking
 const hasSeen = localStorage.getItem('tenden-demo-seen') === 'true';
 if (hasSeen) {
 overlay.classList.remove('active');
 overlay.classList.add('hidden');
 requestLocation();
 return;
 }

 overlay.classList.remove('hidden');
 overlay.classList.add('active');

 let currentStep = 0;
 const totalSteps = 4;

 // Canvas animation handles
 let mapAnimFrame = null;
 let routesAnimFrame = null;
 let flowAnimFrame = null;

 // Automatic slideshow timer
 let slideshowTimeout = null;

 function stopAutoSlideshow() {
 if (slideshowTimeout) {
 clearTimeout(slideshowTimeout);
 slideshowTimeout = null;
 }
 }

 function startAutoSlideshow() {
 stopAutoSlideshow();
 goToStep(0, true);
 }

 // 笏笏 i18n helper (uses global i18nDict once loaded)
 function getDemoText(key, fallback) {
 try {
 const lang = (localStorage.getItem('tenden-lang') === 'auto' || !localStorage.getItem('tenden-lang'))
 ? (navigator.language || 'ja').split('-')[0]
 : localStorage.getItem('tenden-lang');
 const dict = (typeof i18nDict !== 'undefined' && i18nDict[lang]) || {};
 if (dict[key]) return dict[key];

 // Safety Warning Multilingual fallback
   if (key === 'demoSimWarning') {
    // 日本語の防災アプリのため、警告は常に日本語を優先
    const jaText = ' これは訓練用のシミュレーション画面です。実際の災害ではありません。';
    // i18n.jsonが読み込まれていれば優先使用
    if (typeof i18nDict !== 'undefined' && i18nDict['ja'] && i18nDict['ja'][key]) {
      return i18nDict['ja'][key];
    }
    return jaText;
  }
 return fallback;
 } catch (e) { return fallback; }
 }

 // 笏笏 Apply i18n to all demo text nodes
 function applyDemoI18n() {
 const elStep0Title = document.getElementById('demo-title-0');
 const elStep0Sub = document.getElementById('demo-sub-0');
 const elStep1Title = document.getElementById('demo-title-1');
 const elStep1Desc = document.getElementById('demo-desc-1');
 const elStep2Title = document.getElementById('demo-title-2');
 const elStep2Desc = document.getElementById('demo-desc-2');
 const elStep3Title = document.getElementById('demo-title-3');
 const elStep3Desc = document.getElementById('demo-desc-3');
 const elSimWarning = document.getElementById('demo-sim-warning');

  if (elStep0Title) elStep0Title.textContent = getDemoText('demoStep0Title', '津波から命を守るために');
  if (elStep0Sub) elStep0Sub.textContent = getDemoText('demoStep0Sub', '日本全国の沿岸エリアで使える避難支援アプリ');
  if (elStep1Title) elStep1Title.textContent = getDemoText('demoStep1Title', '地震が発生しました');
  if (elStep1Desc) elStep1Desc.textContent = getDemoText('demoStep1Desc', '津波の危険があります。今すぐ避難を開始してください。');
  if (elStep2Title) elStep2Title.textContent = getDemoText('demoStep2Title', '3つの避難ルートを提示します');
  if (elStep2Desc) elStep2Desc.textContent = getDemoText('demoStep2Desc', '最短・混雑回避・急坂回避の3ルートを同時表示。あなたが選びます。');
  if (elStep3Title) elStep3Title.textContent = getDemoText('demoStep3Title', 'TENDENは、あなたに選択肢を渡します');
  if (elStep3Desc) elStep3Desc.textContent = getDemoText('demoStep3Desc', 'その土地を知らない観光客も、外国語話者も、迷わず逃げ出せる支援を。');
  if (elSimWarning) elSimWarning.textContent = getDemoText('demoSimWarning', ' これは訓練用のシミュレーション画面です。実際の災害ではありません。');

 // Next/skip buttons
 document.querySelectorAll('[data-i18n="demoBtnSkip"]').forEach(el => {
    el.textContent = getDemoText('demoBtnSkip', 'スキップ');
 });
  if (useHereSpan) useHereSpan.textContent = getDemoText('demoBtnUseHere', '今いる場所で使ってみる');
  if (replaySpan) replaySpan.textContent = getDemoText('demoBtnReplay', 'もう一度見る');
  if (settingsDemoSpan) settingsDemoSpan.textContent = getDemoText('settingsDemoBtn', 'オンボーディングデモを起動する');
 }

 // Apply i18n immediately (may use fallbacks), then re-apply when i18n loads
 applyDemoI18n();
 // Re-apply after 1s to catch i18n async load
 setTimeout(applyDemoI18n, 1200);

 // 笏笏 Step navigation
 function goToStep(step, isAutoFlow = false) {
 // Stop any running animations
 if (mapAnimFrame) { cancelAnimationFrame(mapAnimFrame); mapAnimFrame = null; }
 if (routesAnimFrame) { cancelAnimationFrame(routesAnimFrame); routesAnimFrame = null; }
 if (flowAnimFrame) { cancelAnimationFrame(flowAnimFrame); flowAnimFrame = null; }

 // Hide all steps
 document.querySelectorAll('.demo-step').forEach(el => el.classList.remove('active'));
 // Show target step
 const target = document.getElementById(`demo-step-${step}`);
 if (target) {
 target.classList.add('active');
 }
 // Update dots
 document.querySelectorAll('.demo-dot').forEach((dot, i) => {
 dot.classList.toggle('active', i === step);
 });

 currentStep = step;

 // Trigger canvas animations for steps
 if (step === 1) setTimeout(animateMapCanvas, 200);
 if (step === 2) setTimeout(animateRoutesCanvas, 200);
 if (step === 3) setTimeout(animateFlowCanvas, 200);

 // Handle auto slideshow transitions
 stopAutoSlideshow();
 if (isAutoFlow) {
 if (step === 0) {
 slideshowTimeout = setTimeout(() => goToStep(1, true), 3800);
 } else if (step === 1) {
 slideshowTimeout = setTimeout(() => goToStep(2, true), 4800);
 } else if (step === 2) {
 slideshowTimeout = setTimeout(() => goToStep(3, true), 5800);
 }
 }
 }

 function closeDemo() {
 stopAutoSlideshow();
 if (mapAnimFrame) { cancelAnimationFrame(mapAnimFrame); mapAnimFrame = null; }
 if (routesAnimFrame) { cancelAnimationFrame(routesAnimFrame); routesAnimFrame = null; }
 if (flowAnimFrame) { cancelAnimationFrame(flowAnimFrame); flowAnimFrame = null; }
 overlay.classList.remove('active');
 setTimeout(() => overlay.classList.add('hidden'), 300);
 localStorage.setItem('tenden-demo-seen', 'true');
 }

 // 笏笏 Button wiring
 const btn0Next = document.getElementById('btn-demo-next-0');
 const btn0Skip = document.getElementById('btn-demo-skip-0');
 const btn1Next = document.getElementById('btn-demo-next-1');
 const btn1Skip = document.getElementById('btn-demo-skip-1');
 const btn2Next = document.getElementById('btn-demo-next-2');
 const btn2Skip = document.getElementById('btn-demo-skip-2');
 const btnUse = document.getElementById('btn-demo-use-here');
 const btnReplay = document.getElementById('btn-demo-replay');

 if (btn0Next) btn0Next.addEventListener('click', () => { stopAutoSlideshow(); goToStep(1); });
 if (btn0Skip) btn0Skip.addEventListener('click', () => { stopAutoSlideshow(); closeDemo(); requestLocation(); });
 if (btn1Next) btn1Next.addEventListener('click', () => { stopAutoSlideshow(); goToStep(2); });
 if (btn1Skip) btn1Skip.addEventListener('click', () => { stopAutoSlideshow(); closeDemo(); requestLocation(); });
 if (btn2Next) btn2Next.addEventListener('click', () => { stopAutoSlideshow(); goToStep(3); });
 if (btn2Skip) btn2Skip.addEventListener('click', () => { stopAutoSlideshow(); closeDemo(); requestLocation(); });
 if (btnReplay) btnReplay.addEventListener('click', () => { startAutoSlideshow(); });
 if (btnUse) btnUse.addEventListener('click', () => { stopAutoSlideshow(); closeDemo(); requestLocation(); });

 // Dot clicks
 document.querySelectorAll('.demo-dot').forEach(dot => {
 dot.addEventListener('click', () => {
 stopAutoSlideshow();
 const step = parseInt(dot.dataset.step);
 if (!isNaN(step)) goToStep(step);
 });
 });

 // Settings panel replay button
 const btnReplaySettings = document.getElementById('btn-replay-demo');
 if (btnReplaySettings) {
 btnReplaySettings.addEventListener('click', () => {
 // Close settings panel first
 const settingsOverlay = document.getElementById('settings-overlay');
 if (settingsOverlay) {
 settingsOverlay.classList.remove('active');
 setTimeout(() => settingsOverlay.classList.add('hidden'), 300);
 }
 // Show demo again
 setTimeout(() => {
 overlay.classList.remove('hidden');
 setTimeout(() => overlay.classList.add('active'), 10);
 startAutoSlideshow();
 }, 350);
 });
 }

 // 笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏
 // STEP 1: Map Canvas 窶・zoom-in effect + earthquake epicenter
 // 笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏
 function animateMapCanvas() {
 const canvas = document.getElementById('demo-map-canvas');
 if (!canvas) return;
 const ctx = canvas.getContext('2d');
 const W = canvas.width, H = canvas.height;

 // Kamakura coastline approximate points (simplified, normalized to canvas)
 // These represent the shape of Yuigahama beach area
 const coast = [
 [0, 0.7], [0.1, 0.65], [0.25, 0.62], [0.4, 0.60],
 [0.55, 0.58], [0.65, 0.60], [0.75, 0.62], [0.85, 0.65], [1.0, 0.68]
 ];

 // Land grid (roads approx)
 const roads = [
 { x1:0.1, y1:0.62, x2:0.3, y2:0.3 },
 { x1:0.3, y1:0.3, x2:0.6, y2:0.25 },
 { x1:0.6, y1:0.25, x2:0.85, y2:0.2 },
 { x1:0.15, y1:0.62, x2:0.5, y2:0.55 },
 { x1:0.5, y1:0.55, x2:0.75, y2:0.50 },
 ];

 // Epicenter dot position
 const epicX = 0.2 * W, epicY = 0.85 * H;

 let zoom = 0.6;
 let targetZoom = 1.0;
 let opacity = 0;
 let waveRadius = 0;
 let startTime = null;

 function frame(ts) {
 if (!startTime) startTime = ts;
 const elapsed = ts - startTime;

 zoom = Math.min(targetZoom, 0.6 + (elapsed / 1200) * 0.4);
 opacity = Math.min(1, elapsed / 600);
 waveRadius = Math.min(W * 0.7, (elapsed / 2000) * W * 1.2);

 ctx.clearRect(0, 0, W, H);
 ctx.save();
 ctx.globalAlpha = opacity;

 // Background (ocean)
 ctx.fillStyle = '#bce0f5';
 ctx.fillRect(0, 0, W, H);

 // Apply zoom from center
 const cx = W * 0.5, cy = H * 0.5;
 ctx.translate(cx, cy);
 ctx.scale(zoom, zoom);
 ctx.translate(-cx, -cy);

 // Land background (above coast line)
 ctx.beginPath();
 ctx.moveTo(0, 0);
 ctx.lineTo(W, 0);
 ctx.lineTo(W, coast[coast.length-1][1]*H);
 for (let i = coast.length - 1; i >= 0; i--) {
 ctx.lineTo(coast[i][0]*W, coast[i][1]*H);
 }
 ctx.lineTo(0, coast[0][1]*H);
 ctx.closePath();
 ctx.fillStyle = '#e8efe8';
 ctx.fill();

 // Draw Green Mountains / Hills (Kamakura terrain) in Zoomed Map
 // Left (Western Hills - Gokurakuji/Hase side)
 ctx.fillStyle = '#bad4ba';
 ctx.beginPath();
 ctx.moveTo(0, 0);
 ctx.lineTo(0.18 * W, 0);
 ctx.quadraticCurveTo(0.20 * W, 0.25 * H, 0.12 * W, 0.5 * H);
 ctx.lineTo(0, 0.6 * H);
 ctx.closePath();
 ctx.fill();

 // Right (Eastern Hills - Zaimokuza/Kohaiza side)
 ctx.beginPath();
 ctx.moveTo(W, 0);
 ctx.lineTo(0.70 * W, 0);
 ctx.quadraticCurveTo(0.68 * W, 0.25 * H, 0.80 * W, 0.55 * H);
 ctx.lineTo(W, 0.65 * H);
 ctx.closePath();
 ctx.fill();

 // Central avenue (闍･螳ｮ螟ｧ霍ｯ)
 ctx.beginPath();
 ctx.moveTo(0.50 * W, 0.60 * H);
 ctx.lineTo(0.51 * W, 0.45 * H);
 ctx.lineTo(0.52 * W, 0.30 * H);
 ctx.lineTo(0.53 * W, 0.10 * H);
 ctx.strokeStyle = '#d0d5d0';
 ctx.lineWidth = 8;
 ctx.lineCap = 'round';
 ctx.lineJoin = 'round';
 ctx.stroke();
 ctx.strokeStyle = '#ffffff';
 ctx.lineWidth = 1.5;
 ctx.stroke();

 // Draw Sand/Beach (Yuigahama 遐よｵ・
 ctx.beginPath();
 coast.forEach((p, i) => {
 if (i === 0) ctx.moveTo(p[0]*W, p[1]*H);
 else ctx.lineTo(p[0]*W, p[1]*H);
 });
 for (let i = coast.length - 1; i >= 0; i--) {
 ctx.lineTo(coast[i][0]*W, (coast[i][1] - 0.04)*H);
 }
 ctx.closePath();
 ctx.fillStyle = '#e8d7b3'; // Sand
 ctx.fill();

 // Coastline stroke
 ctx.beginPath();
 coast.forEach((p, i) => {
 if (i === 0) ctx.moveTo(p[0]*W, p[1]*H);
 else ctx.lineTo(p[0]*W, p[1]*H);
 });
 ctx.strokeStyle = '#71a3c7';
 ctx.lineWidth = 2.5;
 ctx.stroke();

 // Landmark Text Labels
 ctx.fillStyle = '#657d65';
 ctx.font = 'bold 8px "Helvetica Neue", Arial, sans-serif';
 ctx.textAlign = 'left';
 ctx.fillText('長谷・Hase方面', 0.02 * W, 0.3 * H);
 ctx.textAlign = 'right';
 ctx.fillText('北鎌倉方面', 0.98 * W, 0.3 * H);
 
 ctx.fillStyle = '#6c757d';
 ctx.save();
 ctx.translate(0.57 * W, 0.38 * H);
 ctx.rotate(Math.PI / 2.1);
 ctx.fillText('若宮大路', 0, 0);
 ctx.restore();

 ctx.restore();
 ctx.save();
 ctx.globalAlpha = opacity;

 // Tsunami wave rings from ocean
 if (waveRadius > 0) {
 for (let i = 0; i < 3; i++) {
 const r = Math.max(0, waveRadius - i * 40);
 if (r <= 0) continue;
 ctx.beginPath();
 ctx.arc(epicX, epicY, r, 0, Math.PI * 2);
 ctx.strokeStyle = `rgba(255, 59, 48, ${0.3 - i * 0.08})`;
 ctx.lineWidth = 2 - i * 0.5;
 ctx.stroke();
 }
 }

 // Epicenter dot
 ctx.beginPath();
 ctx.arc(epicX, epicY, 5, 0, Math.PI * 2);
 ctx.fillStyle = '#ff3b30';
 ctx.fill();

 // Warning text
 if (elapsed > 500) {
 ctx.font = 'bold 11px Inter, sans-serif';
 ctx.fillStyle = '#ff3b30';
 ctx.textAlign = 'center';
  ctx.fillText('Epicenter', epicX, epicY - 12);
 ctx.fillStyle = '#1c1c1e';
 ctx.font = '10px Inter, sans-serif';
  ctx.fillText('Yuigahama Beach, Kamakura', W * 0.5, 18);
 }

 ctx.restore();

 if (elapsed < 3000) {
 mapAnimFrame = requestAnimationFrame(frame);
 }
 }
 mapAnimFrame = requestAnimationFrame(frame);
 }

 // 笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏
 // STEP 2: Routes Canvas 窶・3 routes drawn sequentially
 // 笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏
 function animateRoutesCanvas() {
 const canvas = document.getElementById('demo-routes-canvas');
 if (!canvas) return;
 const ctx = canvas.getContext('2d');
 const W = canvas.width, H = canvas.height;

 // Starting point (beach) 竊・3 different safe highlands
 const start = [0.2, 0.82];

 // Route A: shortest straight-ish path
 const routeA = [
 [0.2, 0.82], [0.22, 0.72], [0.28, 0.62], [0.36, 0.52],
 [0.44, 0.42], [0.50, 0.32], [0.52, 0.22]
 ];
 // Route B: wider detour avoiding center
 const routeB = [
 [0.2, 0.82], [0.18, 0.70], [0.14, 0.58], [0.16, 0.46],
 [0.24, 0.38], [0.35, 0.30], [0.46, 0.25], [0.54, 0.20]
 ];
 // Route C: slope-friendly, goes around
 const routeC = [
 [0.2, 0.82], [0.30, 0.78], [0.42, 0.72], [0.56, 0.65],
 [0.68, 0.56], [0.74, 0.45], [0.76, 0.34], [0.73, 0.24]
 ];

 const routes = [
 { pts: routeA, color: '#34c759', label: 'ルートA' },
 { pts: routeB, color: '#007aff', label: 'ルートB' },
 { pts: routeC, color: '#5e5ce6', label: 'ルートC' }
 ];

 // Coastline
 const coast = [
 [0, 0.88], [0.15, 0.85], [0.35, 0.83],
 [0.55, 0.82], [0.75, 0.84], [0.9, 0.87], [1.0, 0.90]
 ];

 let startTime = null;
 const ROUTE_DRAW_MS = 1200; // ms per route
 const GAP_MS = 200;
 const totalDuration = (ROUTE_DRAW_MS + GAP_MS) * 3 + 500;

 function drawBase() {
 ctx.clearRect(0, 0, W, H);
 // Land background (light warm gray/green)
 ctx.fillStyle = '#e8efe8';
 ctx.fillRect(0, 0, W, H);

 // Draw Green Mountains / Hills (Kamakura terrain)
 // Left (Western Hills - Gokurakuji/Hase side)
 ctx.fillStyle = '#bad4ba';
 ctx.beginPath();
 ctx.moveTo(0, 0);
 ctx.lineTo(0.15 * W, 0);
 ctx.quadraticCurveTo(0.18 * W, 0.3 * H, 0.12 * W, 0.6 * H);
 ctx.lineTo(0, 0.8 * H);
 ctx.closePath();
 ctx.fill();

 // Right (Eastern Hills - Zaimokuza side)
 ctx.beginPath();
 ctx.moveTo(W, 0);
 ctx.lineTo(0.72 * W, 0);
 ctx.quadraticCurveTo(0.70 * W, 0.3 * H, 0.78 * W, 0.7 * H);
 ctx.lineTo(W, 0.85 * H);
 ctx.closePath();
 ctx.fill();

 // Add some hill details/ridges
 ctx.strokeStyle = '#a4c2a4';
 ctx.lineWidth = 1.5;
 ctx.beginPath();
 ctx.moveTo(0.05 * W, 0.1 * H);
 ctx.quadraticCurveTo(0.08 * W, 0.3 * H, 0.04 * W, 0.5 * H);
 ctx.moveTo(0.85 * W, 0.1 * H);
 ctx.quadraticCurveTo(0.80 * W, 0.4 * H, 0.88 * W, 0.6 * H);
 ctx.stroke();

 // Draw major roads in Kamakura (Wakamiya Oji, etc. as faint gray basemaps)
 // Central road (闍･螳ｮ螟ｧ霍ｯ)
 ctx.beginPath();
 ctx.moveTo(0.20 * W, 0.82 * H);
 ctx.lineTo(0.22 * W, 0.72 * H);
 ctx.lineTo(0.28 * W, 0.62 * H);
 ctx.lineTo(0.36 * W, 0.52 * H);
 ctx.lineTo(0.44 * W, 0.42 * H);
 ctx.lineTo(0.50 * W, 0.32 * H);
 ctx.lineTo(0.52 * W, 0.22 * H);
 ctx.strokeStyle = '#d2dcd2';
 ctx.lineWidth = 10;
 ctx.lineCap = 'round';
 ctx.lineJoin = 'round';
 ctx.stroke();
 ctx.strokeStyle = '#ffffff';
 ctx.lineWidth = 2;
 ctx.stroke();

 // Parallel roads
 ctx.beginPath();
 ctx.moveTo(0.20 * W, 0.82 * H);
 ctx.lineTo(0.18 * W, 0.70 * H);
 ctx.lineTo(0.14 * W, 0.58 * H);
 ctx.lineTo(0.16 * W, 0.46 * H);
 ctx.lineTo(0.24 * W, 0.38 * H);
 ctx.lineTo(0.35 * W, 0.30 * H);
 ctx.lineTo(0.46 * W, 0.25 * H);
 ctx.lineTo(0.54 * W, 0.20 * H);
 ctx.strokeStyle = '#d6dbd6';
 ctx.lineWidth = 5;
 ctx.stroke();

 ctx.beginPath();
 ctx.moveTo(0.20 * W, 0.82 * H);
 ctx.lineTo(0.30 * W, 0.78 * H);
 ctx.lineTo(0.42 * W, 0.72 * H);
 ctx.lineTo(0.56 * W, 0.65 * H);
 ctx.lineTo(0.68 * W, 0.56 * H);
 ctx.lineTo(0.74 * W, 0.45 * H);
 ctx.lineTo(0.76 * W, 0.34 * H);
 ctx.lineTo(0.73 * W, 0.24 * H);
 ctx.strokeStyle = '#d6dbd6';
 ctx.lineWidth = 5;
 ctx.stroke();

 // Draw Sand/Beach (Yuigahama 遐よｵ・
 ctx.beginPath();
 coast.forEach((p, i) => {
 if (i === 0) ctx.moveTo(p[0]*W, p[1]*H);
 else ctx.lineTo(p[0]*W, p[1]*H);
 });
 for (let i = coast.length - 1; i >= 0; i--) {
 ctx.lineTo(coast[i][0]*W, (coast[i][1] - 0.05)*H);
 }
 ctx.closePath();
 ctx.fillStyle = '#e8d7b3'; // Sand color
 ctx.fill();

 // Ocean (below coast)
 ctx.beginPath();
 coast.forEach((p, i) => {
 if (i === 0) ctx.moveTo(p[0]*W, p[1]*H);
 else ctx.lineTo(p[0]*W, p[1]*H);
 });
 ctx.lineTo(W, H); ctx.lineTo(0, H); ctx.closePath();
 ctx.fillStyle = '#bce0f5'; // Vibrant ocean blue
 ctx.fill();

 // Coastline stroke
 ctx.beginPath();
 coast.forEach((p, i) => {
 if (i === 0) ctx.moveTo(p[0]*W, p[1]*H);
 else ctx.lineTo(p[0]*W, p[1]*H);
 });
 ctx.strokeStyle = '#71a3c7';
 ctx.lineWidth = 2.5;
 ctx.stroke();

 // Hazard hatch overlay on coast/beach area
 ctx.fillStyle = 'rgba(255,59,48,0.08)';
 ctx.beginPath();
 coast.forEach((p, i) => {
 if (i === 0) ctx.moveTo(p[0]*W, p[1]*H);
 else ctx.lineTo(p[0]*W, p[1]*H);
 });
 ctx.lineTo(W, H); ctx.lineTo(0, H); ctx.closePath();
 ctx.fill();

 // Landmark Text Labels
 ctx.fillStyle = '#657d65';
 ctx.font = 'bold 9px "Helvetica Neue", Arial, sans-serif';
 ctx.textAlign = 'left';
 ctx.fillText('貅先ｰ丞ｱｱ譁ｹ髱｢', 0.02 * W, 0.4 * H);
 ctx.textAlign = 'right';
 ctx.fillText('北鎌倉方面', 0.98 * W, 0.4 * H);

 ctx.fillStyle = '#8f7a63';
 ctx.textAlign = 'center';
 ctx.fillText('由比ヶ浜海岸', 0.5 * W, 0.81 * H);
 
 ctx.fillStyle = '#6c757d';
 ctx.save();
 ctx.translate(0.33 * W, 0.58 * H);
 ctx.rotate(-Math.PI / 4.5);
 ctx.fillText('若宮大路', 0, 0);
 ctx.restore();
 }

 function drawRoutePartial(pts, color, progress) {
 if (pts.length < 2) return;
 const totalSegs = pts.length - 1;
 const segsToFill = progress * totalSegs;
 const fullSegs = Math.floor(segsToFill);
 const partial = segsToFill - fullSegs;

 ctx.beginPath();
 ctx.moveTo(pts[0][0]*W, pts[0][1]*H);
 for (let i = 0; i < fullSegs && i < totalSegs; i++) {
 ctx.lineTo(pts[i+1][0]*W, pts[i+1][1]*H);
 }
 if (fullSegs < totalSegs) {
 const x1 = pts[fullSegs][0]*W, y1 = pts[fullSegs][1]*H;
 const x2 = pts[fullSegs+1][0]*W, y2 = pts[fullSegs+1][1]*H;
 ctx.lineTo(x1 + (x2-x1)*partial, y1 + (y2-y1)*partial);
 }
 ctx.strokeStyle = color;
 ctx.lineWidth = 4;
 ctx.lineCap = 'round';
 ctx.lineJoin = 'round';
 ctx.stroke();
 }

 function frame(ts) {
 if (!startTime) startTime = ts;
 const elapsed = ts - startTime;

 drawBase();

 routes.forEach((route, ri) => {
 const routeStart = ri * (ROUTE_DRAW_MS + GAP_MS);
 const routeElapsed = Math.max(0, elapsed - routeStart);
 const progress = Math.min(1, routeElapsed / ROUTE_DRAW_MS);
 if (progress > 0) {
 drawRoutePartial(route.pts, route.color, progress);
 // Label at end
 if (progress >= 1) {
 const end = route.pts[route.pts.length - 1];
 ctx.font = 'bold 10px Inter, sans-serif';
 ctx.fillStyle = route.color;
 ctx.textAlign = 'center';
 ctx.fillText(route.label, end[0]*W, end[1]*H - 8);
 }
 }
 });

 // Start marker
 ctx.beginPath();
 ctx.arc(start[0]*W, start[1]*H, 7, 0, Math.PI*2);
 ctx.fillStyle = '#ff3b30';
 ctx.fill();
 ctx.font = 'bold 9px Inter, sans-serif';
 ctx.fillStyle = '#ff3b30';
 ctx.textAlign = 'center';
 ctx.fillText('迴ｾ蝨ｨ蝨ｰ', start[0]*W, start[1]*H - 10);

 if (elapsed < totalDuration + 1000) {
 routesAnimFrame = requestAnimationFrame(frame);
 }
 }
 routesAnimFrame = requestAnimationFrame(frame);
 }

 // 笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏
 // STEP 3: Flow Canvas 窶・people dots dispersing on 3 routes
 // 笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏
 function animateFlowCanvas() {
 const canvas = document.getElementById('demo-flow-canvas');
 if (!canvas) return;
 const ctx = canvas.getContext('2d');
 const W = canvas.width, H = canvas.height;

 const routeGroups = [
 { color: '#34c759', pts: [[0.2, 0.82], [0.22, 0.72], [0.28, 0.62], [0.36, 0.52], [0.44, 0.42], [0.50, 0.32], [0.52, 0.22]] },
 { color: '#007aff', pts: [[0.2, 0.82], [0.18, 0.70], [0.14, 0.58], [0.16, 0.46], [0.24, 0.38], [0.35, 0.30], [0.46, 0.25], [0.54, 0.20]] },
 { color: '#5e5ce6', pts: [[0.2, 0.82], [0.30, 0.78], [0.42, 0.72], [0.56, 0.65], [0.68, 0.56], [0.74, 0.45], [0.76, 0.34], [0.73, 0.24]] }
 ];

 // Create 45 people dots spread across 3 routes
 const dots = [];
 for (let ri = 0; ri < 3; ri++) {
 for (let di = 0; di < 15; di++) {
 dots.push({
 routeIdx: ri,
 progress: -di * 0.07, // staggered start
 speed: 0.004 + Math.random() * 0.003,
 opacity: 0
 });
 }
 }

 const coast = [
 [0, 0.88], [0.15, 0.85], [0.35, 0.83],
 [0.55, 0.82], [0.75, 0.84], [0.9, 0.87], [1.0, 0.90]
 ];

 let startTime = null;

 function drawBase() {
 ctx.clearRect(0, 0, W, H);
 // Land background (light warm gray/green)
 ctx.fillStyle = '#e8efe8';
 ctx.fillRect(0, 0, W, H);

 // Draw Green Mountains / Hills (Kamakura terrain)
 // Left (Western Hills - Gokurakuji/Hase side)
 ctx.fillStyle = '#bad4ba';
 ctx.beginPath();
 ctx.moveTo(0, 0);
 ctx.lineTo(0.15 * W, 0);
 ctx.quadraticCurveTo(0.18 * W, 0.3 * H, 0.12 * W, 0.6 * H);
 ctx.lineTo(0, 0.8 * H);
 ctx.closePath();
 ctx.fill();

 // Right (Eastern Hills - Zaimokuza side)
 ctx.beginPath();
 ctx.moveTo(W, 0);
 ctx.lineTo(0.72 * W, 0);
 ctx.quadraticCurveTo(0.70 * W, 0.3 * H, 0.78 * W, 0.7 * H);
 ctx.lineTo(W, 0.85 * H);
 ctx.closePath();
 ctx.fill();

 // Add some hill details/ridges
 ctx.strokeStyle = '#a4c2a4';
 ctx.lineWidth = 1.5;
 ctx.beginPath();
 ctx.moveTo(0.05 * W, 0.1 * H);
 ctx.quadraticCurveTo(0.08 * W, 0.3 * H, 0.04 * W, 0.5 * H);
 ctx.moveTo(0.85 * W, 0.1 * H);
 ctx.quadraticCurveTo(0.80 * W, 0.4 * H, 0.88 * W, 0.6 * H);
 ctx.stroke();

 // Draw major roads in Kamakura (Wakamiya Oji, etc. as faint gray basemaps)
 // Central road (闍･螳ｮ螟ｧ霍ｯ)
 ctx.beginPath();
 ctx.moveTo(0.20 * W, 0.82 * H);
 ctx.lineTo(0.22 * W, 0.72 * H);
 ctx.lineTo(0.28 * W, 0.62 * H);
 ctx.lineTo(0.36 * W, 0.52 * H);
 ctx.lineTo(0.44 * W, 0.42 * H);
 ctx.lineTo(0.50 * W, 0.32 * H);
 ctx.lineTo(0.52 * W, 0.22 * H);
 ctx.strokeStyle = '#d2dcd2';
 ctx.lineWidth = 10;
 ctx.lineCap = 'round';
 ctx.lineJoin = 'round';
 ctx.stroke();
 ctx.strokeStyle = '#ffffff';
 ctx.lineWidth = 2;
 ctx.stroke();

 // Parallel roads
 ctx.beginPath();
 ctx.moveTo(0.20 * W, 0.82 * H);
 ctx.lineTo(0.18 * W, 0.70 * H);
 ctx.lineTo(0.14 * W, 0.58 * H);
 ctx.lineTo(0.16 * W, 0.46 * H);
 ctx.lineTo(0.24 * W, 0.38 * H);
 ctx.lineTo(0.35 * W, 0.30 * H);
 ctx.lineTo(0.46 * W, 0.25 * H);
 ctx.lineTo(0.54 * W, 0.20 * H);
 ctx.strokeStyle = '#d6dbd6';
 ctx.lineWidth = 5;
 ctx.stroke();

 ctx.beginPath();
 ctx.moveTo(0.20 * W, 0.82 * H);
 ctx.lineTo(0.30 * W, 0.78 * H);
 ctx.lineTo(0.42 * W, 0.72 * H);
 ctx.lineTo(0.56 * W, 0.65 * H);
 ctx.lineTo(0.68 * W, 0.56 * H);
 ctx.lineTo(0.74 * W, 0.45 * H);
 ctx.lineTo(0.76 * W, 0.34 * H);
 ctx.lineTo(0.73 * W, 0.24 * H);
 ctx.strokeStyle = '#d6dbd6';
 ctx.lineWidth = 5;
 ctx.stroke();

 // Draw Sand/Beach (Yuigahama 遐よｵ・
 ctx.beginPath();
 coast.forEach((p, i) => {
 if (i === 0) ctx.moveTo(p[0]*W, p[1]*H);
 else ctx.lineTo(p[0]*W, p[1]*H);
 });
 for (let i = coast.length - 1; i >= 0; i--) {
 ctx.lineTo(coast[i][0]*W, (coast[i][1] - 0.05)*H);
 }
 ctx.closePath();
 ctx.fillStyle = '#e8d7b3'; // Sand color
 ctx.fill();

 // Ocean (below coast)
 ctx.beginPath();
 coast.forEach((p, i) => {
 if (i === 0) ctx.moveTo(p[0]*W, p[1]*H);
 else ctx.lineTo(p[0]*W, p[1]*H);
 });
 ctx.lineTo(W, H); ctx.lineTo(0, H); ctx.closePath();
 ctx.fillStyle = '#bce0f5'; // Vibrant ocean blue
 ctx.fill();

 // Coastline stroke
 ctx.beginPath();
 coast.forEach((p, i) => {
 if (i === 0) ctx.moveTo(p[0]*W, p[1]*H);
 else ctx.lineTo(p[0]*W, p[1]*H);
 });
 ctx.strokeStyle = '#71a3c7';
 ctx.lineWidth = 2.5;
 ctx.stroke();

 // Hazard hatch overlay on coast/beach area
 ctx.fillStyle = 'rgba(255,59,48,0.08)';
 ctx.beginPath();
 coast.forEach((p, i) => {
 if (i === 0) ctx.moveTo(p[0]*W, p[1]*H);
 else ctx.lineTo(p[0]*W, p[1]*H);
 });
 ctx.lineTo(W, H); ctx.lineTo(0, H); ctx.closePath();
 ctx.fill();

 // Landmark Text Labels
 ctx.fillStyle = '#657d65';
 ctx.font = 'bold 9px "Helvetica Neue", Arial, sans-serif';
 ctx.textAlign = 'left';
 ctx.fillText('貅先ｰ丞ｱｱ譁ｹ髱｢', 0.02 * W, 0.4 * H);
 ctx.textAlign = 'right';
 ctx.fillText('北鎌倉方面', 0.98 * W, 0.4 * H);

 ctx.fillStyle = '#8f7a63';
 ctx.textAlign = 'center';
 ctx.fillText('由比ヶ浜海岸', 0.5 * W, 0.81 * H);
 
 ctx.fillStyle = '#6c757d';
 ctx.save();
 ctx.translate(0.33 * W, 0.58 * H);
 ctx.rotate(-Math.PI / 4.5);
 ctx.fillText('若宮大路', 0, 0);
 ctx.restore();
 }

 function getPointOnRoute(pts, progress) {
 const p = Math.max(0, Math.min(1, progress));
 const totalSegs = pts.length - 1;
 const seg = p * totalSegs;
 const si = Math.min(Math.floor(seg), totalSegs - 1);
 const t = seg - si;
 return [
 pts[si][0] + (pts[si+1][0] - pts[si][0]) * t,
 pts[si][1] + (pts[si+1][1] - pts[si][1]) * t
 ];
 }

 function frame(ts) {
 if (!startTime) startTime = ts;

 ctx.clearRect(0, 0, W, H);

 // Background
 drawBase();

 // Draw faint route lines
 routeGroups.forEach(rg => {
 ctx.beginPath();
 rg.pts.forEach((p, i) => {
 if (i === 0) ctx.moveTo(p[0]*W, p[1]*H);
 else ctx.lineTo(p[0]*W, p[1]*H);
 });
 ctx.strokeStyle = rg.color + '44';
 ctx.lineWidth = 3;
 ctx.stroke();
 });

 // Move and draw dots
 dots.forEach(dot => {
 dot.progress += dot.speed;
 dot.opacity = Math.min(1, (dot.progress + 0.1) * 5);

 if (dot.progress < 0 || dot.progress > 1.1) return;

 const rg = routeGroups[dot.routeIdx];
 const [px, py] = getPointOnRoute(rg.pts, dot.progress);

 ctx.beginPath();
 ctx.arc(px * W, py * H, 4, 0, Math.PI * 2);
 ctx.fillStyle = rg.color;
 ctx.globalAlpha = dot.opacity * 0.85;
 ctx.fill();
 ctx.globalAlpha = 1;
 });

 // Origin pulse
 const ox = 0.2 * W, oy = 0.82 * H;
 ctx.beginPath();
 ctx.arc(ox, oy, 7, 0, Math.PI * 2);
 ctx.fillStyle = '#ff3b30';
 ctx.fill();

 // Legend overlay
 ctx.font = 'bold 10px Inter, sans-serif';
 ctx.textAlign = 'left';
 routeGroups.forEach((rg, i) => {
 ctx.fillStyle = rg.color;
 ctx.fillText(['A', 'B', 'C'][i], W * 0.85, 18 + i * 15);
 });

 flowAnimFrame = requestAnimationFrame(frame);
 }
 flowAnimFrame = requestAnimationFrame(frame);
 }

 // Start automatic slideshow
 startAutoSlideshow();

 console.log('[TENDEN] Onboarding demo started.');
}

  // --- HOME SCREEN ADD GUIDE (manual, no auto-prompt) ---
  setupHomeGuide();

  function setupHomeGuide() {
    const modal = document.getElementById('home-guide-modal');
    const btnShow = document.getElementById('btn-show-home-guide');
    const btnClose = document.getElementById('btn-home-guide-close');

    if (btnShow && modal) {
      btnShow.addEventListener('click', () => {
        modal.classList.remove('hidden');
        // Close settings overlay first for cleaner UX
        const settingsOverlay = document.getElementById('settings-overlay');
        if (settingsOverlay) settingsOverlay.classList.add('hidden');
      });
    }

    if (btnClose && modal) {
      btnClose.addEventListener('click', () => {
        modal.classList.add('hidden');
      });
    }

    // Also close on overlay backdrop tap
    if (modal) {
      modal.addEventListener('click', (e) => {
        if (e.target === modal) modal.classList.add('hidden');
      });
    }
  }


});

