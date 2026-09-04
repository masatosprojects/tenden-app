// app.js

function applyTendenConfig() {
  const cfg = window.TENDEN_CONFIG || {};
  document.querySelectorAll('[data-config-href]').forEach(function (el) {
    const key = el.getAttribute('data-config-href');
    if (key && cfg[key]) el.href = cfg[key];
  });
  if (cfg.version) {
    const label = 'v' + cfg.version;
    document.querySelectorAll('[data-config-version]').forEach(function (el) {
      el.textContent = label;
    });
  }
  if (cfg.termsVersion) {
    document.querySelectorAll('[data-config-terms-version]').forEach(function (el) {
      el.textContent = cfg.termsVersion;
    });
  }
}

// ── オンボーディング定数（DOMContentLoaded 初回 boot より前に初期化）
var ONBOARDING_AGENT_CFG = [
  { feature: 'onboarding-intro', type: 'info' },
  { feature: 'onboarding-quake', type: 'warning' },
  { feature: 'onboarding-routes', type: 'info' },
  { feature: 'onboarding-flow', type: 'info' }
];
var ONBOARDING_AGENT_FALLBACKS = [
  '現在地の浸水リスクを確認し、避難先までの流れを安全に体験できます。',
  '地震が発生しました。津波の危険があります。すぐに避難を始めましょう。',
  '2つの避難ルートから選べます。あなたに合った道を、自分の判断で。',
  '歩く前に混雑を予習できます。準備ができたら、下のボタンではじめましょう！'
];
var _onboardingAgentParent = null;
var _onboardingAgentNext = null;
var _onboardingStartedThisLoad = false;

document.addEventListener('DOMContentLoaded', () => {
 applyTendenConfig();

 // ── デモ強制リセット（新バージョン起動時に必ずオンボーディングを表示）
 (function() {
   try {
     var cfgVer = (window.TENDEN_CONFIG && window.TENDEN_CONFIG.version) || '7.12';
     var ver = 'v' + cfgVer;
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
       Array.from(document.body.classList).filter(function(c) { return c.indexOf('lang-') === 0; }).forEach(function(c) { document.body.classList.remove(c); });
       document.body.classList.add('lang-' + forceLang);
     } else {
       Array.from(document.body.classList).filter(function(c) { return c.indexOf('lang-') === 0; }).forEach(function(c) { document.body.classList.remove(c); });
       document.body.classList.add('lang-' + saved);
     }
   } catch(e) {}
 })();

 // Basic state
 let isEmergency = false;
 let map, userMarker, routeLayerGroup, hazardLayer, reliefLayer, sheltersLayerGroup, congestionLayer, safeEdgesLayerGroup;
 let coastDistLayerGroup = null, _coastDistActive = false;
 let congestionGeojsonData = null;
 let aiPolicyData = null;          // 学習済みRLモデルの方策ベクトル場（緊急モード時に遅延ロード）
 let aiAccessibleData = null;      // 要配慮者向け学習済み方策（緩勾配優先・遅延ロード）
 let aiAccessibleLoading = null;
 let aiPolicyLoading = null;       // ロード中Promise（多重フェッチ防止）
 let aiTimeaware = null;           // 時間依存の混雑迂回override（任意・小さい。{bucket_seconds, overrides}）
 let congestionTimeseriesData = null; // 60秒バケットの時系列密度（緊急モード時に遅延ロード）
 let emergencyStartTimeMs = null; // 緊急モード開始時刻（時系列バケット算出の基準）
 let currentLocation = null; // {lat, lng}
 let isManualLocation = false;
 // Emergency route tracking state
 let isPinLocked = false;
 let isWaitingForPinDrop = false;
 let isDrillMode = true; // true=鎌倉で避難体験(予習) / false=本番モード
 let activeRoutesList = [];
 let activeSelectedRouteId = null; // ユーザーが明示選択するまで null（AI等の自動選択なし）
 let pendingEvacPlayback = false;  // 予習再生ボタン押下後、ルート選択待ち
 let activeSecondaryRoute = null; // Cached secondary (shelter) route for redraw
 let simulationInterval = null;
 let popupTimeoutId = null; // Timeout ID for auto-closing manual pin thought popup
 // オンボーディングデモ（startOnboardingDemo より前に宣言 — TDZ 回避）
 let mapAnimFrame = null;
 let routesAnimFrame = null;
 let flowAnimFrame = null;
 let demoQuakeMap = null;
 // 平時ガイド（initSafeZoneGuide より前に宣言 — TDZ 回避）
 const SAFE_GUIDE_SESSION_KEY = 'safe-guide-dismissed';
 const SAFE_GUIDE_BUBBLE_MODE = 'safe-guide';
 let mainRouteLine = null;
 let activeScenarioId = 1;
 let activeLocationId = 'a';
 
 // Premium features state variables
 let lastOffCourseSpeakTime = 0;
 let isEvacuationCompleted = false;
 
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
 let lastTsunamiIsInundated = null; // null=未判定, true=浸水区域内, false=区域外
 let _hudTsunamiKind = 'checking'; // checking|safe|watch|danger
 let _hudTsunamiPollTimer = null;
 let hasWarnedLowBattery = false;
 let lastHeading = 0;
 let deviceHeadingTs = 0;
 let gpsMovementHeading = null;
 let prevTrackLocation = null;
 let movementHeading = null;
 let isModelAreaDemo = false;
 let lastScanCenter = null;
 
 // 地域設定（将来の複数地域対応のための抽象化）
 // 新しい地域を追加する際は REGIONS にエントリを追加し、assets/regions.json を同期させる。
 // 現在は kamakura のみ定義。既存コードは KAMAKURA_CENTER エイリアス経由で変更なく動作する。
 const REGIONS = {
   kamakura: {
     center: [35.3192, 139.5504],
     bbox: { latMin: 35.28, latMax: 35.34, lngMin: 139.48, lngMax: 139.58 },
     prefCode: '14',
     assets: {
       shelters: 'assets/shelters.json',
       routes: 'assets/routes.json',
       safeEdges: 'assets/safe_edges.json',
       congestionEdges: 'assets/congestion_edges.json',
       congestionTimeseries: 'assets/congestion_timeseries_baseline.json'
     }
   }
 };
 const KAMAKURA_CENTER = REGIONS.kamakura.center; // 後方互換エイリアス
const KAMAKURA_DEMO_PIN = [35.3069, 139.5518]; // 由比ヶ浜海岸（デモ開始ピン・浸水想定区域内）
const DEMO_QUAKE_FLOOD_POINT = KAMAKURA_DEMO_PIN; // オンボーディング Step1：現在地＝浸水リスク地点
const KAMAKURA_BOUNDS = [[35.278, 139.525], [35.342, 139.578]]; // モデル地区全域
const GSI_PALE_TILE_URL = 'https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png';

 // ── Developer Announcements ───────────────────────────────────────────────
 // status: 'active' = 現在有効  |  'resolved' = 対応済み・過去のもの
 const DEV_ANNOUNCEMENTS = [
   {
     id: 'pwa-opt-in',
     date: '2026-06-16',
     status: 'active',
     category: 'お知らせ',
     title: 'オフライン緊急モードを手動で有効化できます',
     body: '設定から「オフライン緊急モード」をONにすると、事前に保存したアプリ資産を通信断時にも表示できる場合があります。経路探索・標高取得・速報など外部通信を必要とする機能や未取得データは利用できない場合があります。オンラインに戻るとアプリ本体は更新されます。',
   },
   {
     id: 'community-reports',
     date: '2026-06-16',
     status: 'active',
     category: '新機能',
     title: 'コミュニティ危険レポート機能を追加しました',
     body: 'サイドパネル（右端ボタン）の「危険レポート」から、危険な場所・倒木・混雑などを匿名で報告できます。みなさんの報告が地域の減災に役立ちます。',
   },
 ];

 function renderAnnouncementsList() {
   const list = document.getElementById('dev-ann-list');
   if (!list) return;
   const LABEL = { active: '公開中', resolved: '終了' };
   list.innerHTML = DEV_ANNOUNCEMENTS.map(a => `
     <div class="ann-item ${a.status}">
       <div class="ann-item-head">
         <span class="ann-badge ${a.status}">${LABEL[a.status] || a.status}</span>
         <span class="ann-cat">${a.category}</span>
         <span class="ann-date">${a.date}</span>
       </div>
       <div class="ann-title">${a.title}</div>
       <div class="ann-body">${a.body}</div>
     </div>`).join('');
 }

 let _startupNoticeDismissed = false;

 function showStartupNoticeIfNeeded() {
   if (_startupNoticeDismissed) return;
   if (sessionStorage.getItem('sn-dismissed') === '1') return;
   const active = DEV_ANNOUNCEMENTS.filter(a => a.status === 'active');
   if (!active.length) return;
   // 内容が変わった時だけ起動時に表示（毎回出さない）。署名=有効お知らせのid+date。
   const sig = active.map(a => a.id + ':' + a.date).join('|');
   try { if (localStorage.getItem('tenden-notice-seen') === sig) return; } catch (e) {}
   window._tendenNoticeSig = sig;
   const body = document.getElementById('sn-body');
   if (body) {
     body.innerHTML = active.map(a => `
       <div class="sn-item">
         <div class="sn-item-cat">${a.category}</div>
         <div class="sn-item-title">${a.title}</div>
         <div class="sn-item-body">${a.body}</div>
       </div>`).join('');
   }
   const notice = document.getElementById('startup-notice');
   if (notice) notice.classList.remove('hidden');
 }

 function openAnnouncementsOverlay() {
   renderAnnouncementsList();
   const ov = document.getElementById('dev-ann-overlay');
   if (!ov) return;
   ov.classList.remove('hidden');
   requestAnimationFrame(() => ov.classList.add('active'));
 }

 function closeAnnouncementsOverlay() {
   const ov = document.getElementById('dev-ann-overlay');
   if (!ov) return;
   ov.classList.remove('active');
   setTimeout(() => ov.classList.add('hidden'), 260);
 }

 // ── Firebase Community Reports ────────────────────────────────────────────
 const FIREBASE_CONFIG = {
   apiKey: "AIzaSyBqKe0mVDGqMZFV2PFP9WE55xeyo7MGa1o",
   authDomain: "tenden-reports-2690e.firebaseapp.com",
   projectId: "tenden-reports-2690e",
   storageBucket: "tenden-reports-2690e.firebasestorage.app",
   messagingSenderId: "864707138820",
   appId: "1:864707138820:web:2976f53b15c7be23b46c51"
 };
 let firestoreDB = null;
 let communityReportLayer = null;
 let communityReportsVisible = false;
 let isReportLocationMode = false;
 let reportPendingLocation = null;
 let selectedReportCategory = null;

 function initFirebase() {
   try {
     if (typeof firebase === 'undefined') return;
     if (!firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);
     firestoreDB = firebase.firestore();
   } catch (e) { console.warn('[Firebase] init failed:', e); }
 }

 function toReportGrid(val) {
   return Math.round(val * 1000) / 1000; // ~100m anonymization
 }

 async function submitCommunityReport(category, comment) {
   if (!firestoreDB) {
     initFirebase();
     if (!firestoreDB) return 'no_db';
   }
   const loc = reportPendingLocation || currentLocation;
   if (!loc) return 'no_location';
   const now = Date.now();
   const last = parseInt(localStorage.getItem('tenden-last-report') || '0');
   if (now - last < 60000) return 'rate_limited';
   try {
     await firestoreDB.collection('reports').add({
       gridLat: toReportGrid(loc.lat),
       gridLng: toReportGrid(loc.lng),
       category: category,
       comment: (comment || '').trim().substring(0, 140),
       ts: firebase.firestore.FieldValue.serverTimestamp()
     });
     localStorage.setItem('tenden-last-report', String(now));
     reportPendingLocation = null;
     selectedReportCategory = null;
     return 'ok';
   } catch (e) {
     console.error('[Firebase] report submit failed:', e.code, e.message);
     return e.code === 'permission-denied' ? 'permission_denied' : 'error';
   }
 }

 async function loadCommunityReports() {
   if (!firestoreDB) return;
   if (!communityReportLayer) {
     communityReportLayer = L.layerGroup().addTo(map);
   } else {
     communityReportLayer.clearLayers();
   }
   const COLORS = { danger:'#ff3b30', sign_needed:'#ff9f0a', crowded:'#5e5ce6', shelter_info:'#34c759', other:'#636366' };
   const LABELS = { danger:'危険', sign_needed:'看板必要', crowded:'混雑', shelter_info:'避難所情報', other:'その他' };
   try {
     const snap = await firestoreDB.collection('reports').orderBy('ts','desc').limit(300).get();
     const grid = {};
     snap.forEach(doc => {
       const d = doc.data();
       const k = `${d.gridLat}_${d.gridLng}_${d.category}`;
       if (!grid[k]) grid[k] = { lat: d.gridLat, lng: d.gridLng, cat: d.category, comments: [] };
       if (d.comment && d.comment.trim()) grid[k].comments.push(d.comment.trim());
     });
     Object.values(grid).forEach(entry => {
       const { lat, lng, cat, comments } = entry;
       const count = comments.length || 1;
       const commentHtml = comments.length
         ? '<hr style="margin:6px 0;opacity:0.3">' + comments.map(c => `<div style="margin:3px 0;font-size:0.88em">・${c}</div>`).join('')
         : '';
       const mk = L.circleMarker([lat, lng], {
         radius: Math.min(7 + count * 2, 20),
         fillColor: COLORS[cat] || '#636366',
         color: 'white', weight: 2,
         fillOpacity: 0.82, opacity: 1
       }).bindPopup(`<div style="min-width:140px"><b>${LABELS[cat] || cat}</b><br><span style="font-size:0.82em;opacity:0.7">報告数: ${count}件</span>${commentHtml}</div>`).addTo(communityReportLayer);
       // タップしなくても種別・件数が分かるよう常設ラベルを表示（詳細コメントはタップで）
       mk.bindTooltip(`${LABELS[cat] || cat} ${count}`, {
         permanent: true, direction: 'top', offset: [0, -4],
         className: 'report-tip report-tip-' + cat
       });
     });
   } catch (e) { console.error('[Firebase] load reports failed:', e); }
 }

 function toggleCommunityReportsLayer(visible) {
   communityReportsVisible = visible;
   const legend = document.getElementById('report-legend');
   if (visible) {
     loadCommunityReports();
     if (legend) legend.classList.remove('hidden');
     document.body.classList.add('report-legend-visible');
     // 避難所アイコンがあると報告位置が見づらいので、閲覧中は一時的に避難所を隠す
     try { if (sheltersLayerGroup && map.hasLayer(sheltersLayerGroup)) { map.removeLayer(sheltersLayerGroup); _sheltersHiddenForReports = true; } } catch (e) {}
   } else {
     if (communityReportLayer) communityReportLayer.clearLayers();
     if (legend) legend.classList.add('hidden');
     document.body.classList.remove('report-legend-visible');
     // 避難所表示を元に戻す
     try { if (_sheltersHiddenForReports && sheltersLayerGroup) { sheltersLayerGroup.addTo(map); _sheltersHiddenForReports = false; } } catch (e) {}
   }
 }
 let _sheltersHiddenForReports = false;

    console.log('[TENDEN] i18n.json 30-languages dictionary loaded successfully');
 let i18nDict = {};

 // Initialize (各関数をtry/catchで保護 — どれかがエラーでもスプラッシュは消える)
 try { initFirebase(); } catch(e) { console.warn('[TENDEN] Firebase init error:', e); }
 try { initMap(); } catch(e) { console.error('[TENDEN] initMap error:', e); }
  try { initUI(); } catch(e) { console.error('[TENDEN] initUI error:', e); }
  // Keep the primary bottom navigation independent from the large initUI
  // routine. A missing optional control must never disable every trunk.
  try { initDockTrunks(); } catch(e) { console.error('[TENDEN] dock init error:', e); }
 try { startClock(); } catch(e) {}
 try { connectP2PQuake(); } catch(e) {}
 try { initHudTsunamiPolling(); } catch(e) {}
 try { wireEndDrillButton(); } catch(e) {}
 try { wireShareSafetyNavButton(); } catch(e) {}
 try { wireTosGate(); } catch(e) {}
 try { wirePrivacyPolicyOverlay(); } catch(e) {}


 // Load 30-languages localization dictionary from external JSON file (PWA cache optimized)
 fetch('assets/i18n.json?v=20260904')
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



  // PWAオフラインモード — ユーザーが設定でONにした場合のみSWを登録
  const _pwaEnabled = localStorage.getItem('tenden-pwa-enabled') === '1';
  if ('serviceWorker' in navigator) {
    if (_pwaEnabled) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js?v=177', { updateViaCache: 'none' })
          .then(registration => registration.update())
          .catch(() => {});
      });
      let refreshing = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!refreshing) {
          refreshing = true;
          window.location.reload();
        }
      });
    } else {
      navigator.serviceWorker.getRegistrations().then(rs => rs.forEach(r => r.unregister()));
      caches.keys().then(keys => keys.forEach(k => caches.delete(k)));
    }
  }

 function initMap() {
 map = L.map('map', {
  zoomControl: false,
  attributionControl: false
  }).setView(KAMAKURA_CENTER, 14);

  // 位置情報の許可はオンボーディング完了後に行う
  // requestLocation() は onboarding の「スキップ」「使ってみる」で呼ばれる

 // 国土地理院の淡色地図。APIキー不要で日本全国を表示する。
 L.tileLayer(GSI_PALE_TILE_URL, {
 maxNativeZoom: 18,
 maxZoom: 19,
 attribution: '地理院タイル（淡色地図）'
 }).addTo(map);

 L.control.attribution({
 position: 'bottomleft',
    prefix: '地図: 国土地理院 | Leaflet',
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
 // 種別で見分ける: 津波避難ビル(垂直避難)=四角・藍 / 高台の避難空地=丸・緑
 const isBuilding = (s.vertical_evacuation === true) || (s.type === '津波避難建築物');
 const typeColor = isBuilding ? '#5e5ce6' : '#00a63e';

 // 種別ごとのカスタムアイコン画像（青丸＋白絵を丸く切り抜き済み）。
 //   津波避難建築物 → 津波避難ビル / 避難空地 → 高台。
 //   ※マウンド・タワーのアイコンも用意済(assets/shelter_icons/)だが、現データは
 //     建築物/空地の2種別のみで区別情報が無いため未割当（データ拡充時に使用可能）。
 const iconFile = isBuilding ? 'building' : 'takadai';
 const icon = L.divIcon({
 className: `shelter-marker ${isBuilding ? 'shelter-building' : 'shelter-space'}`,
 html: `<img class="shelter-marker-img" src="assets/shelter_icons/${iconFile}.png" alt="" />`,
 iconSize: [34, 34],
 iconAnchor: [17, 17]
 });
 
 // Dynamically translate the prefix '驕ｿ髮｣謇' in names to local equivalents like 'Shelter'
 const shelterWord = dict.shelterWord || 'Shelter';
 let localizedName = s.name.replace('避難所', shelterWord);

 // Translate other suffixes dynamically
 if (dict.elementarySchool) localizedName = localizedName.replace('小学校', dict.elementarySchool);
 if (dict.juniorHighSchool) localizedName = localizedName.replace('中学校', dict.juniorHighSchool);
 if (dict.shrinePrecincts) localizedName = localizedName.replace('境内', dict.shrinePrecincts);
 if (dict.learningCenter) localizedName = localizedName.replace('学習センター', dict.learningCenter);

 // 種別ラベル（津波避難ビル＝上階へ垂直避難 / 高台＝そのまま安全）
 const typeLabel = isBuilding
   ? (dict.shelterBuildingLabel || '津波避難ビル（上階へ垂直避難）')
   : (dict.shelterHighGroundLabel || '高台の避難場所');
 const typeBadge = `<div style="display:inline-block;margin:3px 0;padding:1px 7px;border-radius:6px;font-size:0.74em;font-weight:700;color:#fff;background:${typeColor}">${typeLabel}</div>`;

 let capText = dict.shelterCapacity || '収容可能 {capacity}人';
 capText = capText.replace('{capacity}', s.capacity);
 const capLine = (s.capacity && s.capacity > 0) ? `<br><span style="font-size:0.85em;opacity:0.85">${capText}</span>` : '';
 const addrLine = s.address ? `<br><span style="font-size:0.8em;opacity:0.7">${s.address}</span>` : '';

 const disclaimerText = dict.shelterSourceNote || '出典：鎌倉市公式オープンデータ';
 const disclaimer = `<br><em style="font-size:0.74em;opacity:0.6">${disclaimerText}</em>`;

 L.marker([s.lat, s.lng], { icon })
 .bindPopup(`<strong>${localizedName}</strong><br>${typeBadge}${capLine}${addrLine}${disclaimer}`)
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
 fetch('assets/congestion_edges.json')
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
  console.log('[TENDEN] congestion_edges.json loaded', data.features.length);
 })
  .catch(e => console.log('[TENDEN] congestion_edges.json not found', e));

 // Compass: deviceorientation listeners are registered via requestOrientationPermission()

 // NOTE: map click-to-move-pin removed — location is set via GPS watchPosition,
 // the evacuation demo button, or the model-area button only.

 // Map drag/move listener to dynamically update tsunami map based on displayed region
 map.on('moveend', () => {
 const center = map.getCenter();
 updateTsunamiPrefecturalTile(center.lat, center.lng);
 });

 // 警報バナーは展開なしの常時表示ヘッダーに変更（チェブロン/展開機能は撤去）
 }

 function isLeafletMapReady() {
 return !!(map && typeof map.setView === 'function' && typeof window.L !== 'undefined');
 }

 let _drillFlyMoveHandler = null;

 function clearDrillFlyHandler() {
   if (_drillFlyMoveHandler && map) {
     map.off('moveend', _drillFlyMoveHandler);
     _drillFlyMoveHandler = null;
   }
 }

 function endDrillTraining() {
   if (window._endDrillRunning) return;
   window._endDrillRunning = true;
   try {
     isEmergency = false;
     isPinLocked = false;
     isWaitingForPinDrop = false;
     clearDrillFlyHandler();
     pendingEvacPlayback = false;
     try { stopEvacuationPlayback(); } catch (e) {}
     try { hideTendenLoading(); } catch (e) {}
     try { hideRouteCalcLoading(); } catch (e) {}
     try { hideRouteSelectorHUD(); } catch (e) {}
     var rov = document.getElementById('route-overlay');
     if (rov) { rov.classList.remove('active'); rov.classList.add('hidden'); }
     ['onboarding-overlay', 'research-intro-overlay', 'real-mode-confirm', 'ep-branch-choice'].forEach(function (id) {
       var el = document.getElementById(id);
       if (el) { el.classList.remove('active'); el.classList.add('hidden'); }
     });
     resetEmergencyMode();
     if (typeof triggerHapticTick === 'function') triggerHapticTick();
   } catch (err) {
     console.error('[TENDEN] endDrillTraining error:', err);
     try {
       document.body.classList.remove('ep-mode', 'tenden-nav-active', 'emergency-mode');
       document.getElementById('evacuation-banner')?.classList.add('hidden');
       document.getElementById('evac-playback')?.classList.add('hidden');
       document.getElementById('bottom-normal-actions')?.classList.remove('hidden');
       document.getElementById('btn-test-alert')?.classList.remove('hidden');
       document.getElementById('btn-real-mode')?.classList.remove('hidden');
     } catch (e2) {}
   } finally {
     window._endDrillRunning = false;
   }
 }

 function startDrillExperienceFlow() {
   if (!map) return;
   clearDrillFlyHandler();
   try { hideTendenLoading(); } catch (e) {}
   try { hideRouteCalcLoading(); } catch (e) {}

   document.getElementById('btn-test-alert')?.classList.add('hidden');
   document.getElementById('btn-real-mode')?.classList.add('hidden');

   if (routeLayerGroup) routeLayerGroup.clearLayers();
   clearRouteDestinationHighlights();
   if (simulationInterval) {
     clearInterval(simulationInterval);
     simulationInterval = null;
   }

   try { showTendenLoading('鎌倉のモデル地区へ移動中…', 8000); } catch (e) {}

   map.flyTo([35.308, 139.551], 14, { duration: 1.6, easeLinearity: 0.25 });

   const onMoveEnd = function () {
     clearDrillFlyHandler();
     try { hideTendenLoading(); } catch (e) {}
     const ov = document.getElementById('research-intro-overlay');
     if (ov) {
       ov.classList.remove('hidden');
       setTimeout(function () { ov.classList.add('active'); }, 10);
     } else {
       startDrillPinDrop();
     }
   };
   _drillFlyMoveHandler = onMoveEnd;
   map.once('moveend', onMoveEnd);
   setTimeout(function () {
     if (_drillFlyMoveHandler === onMoveEnd) onMoveEnd();
   }, 2200);
 }

 function startDrillPinDrop() {
   const ov = document.getElementById('research-intro-overlay');
   if (ov) { ov.classList.remove('active'); ov.classList.add('hidden'); }
   isDrillMode = true;
   isWaitingForPinDrop = true;
   isPinLocked = false;
   document.getElementById('btn-test-alert')?.classList.add('hidden');
   document.getElementById('btn-real-mode')?.classList.add('hidden');
   document.getElementById('crosshair-target')?.classList.remove('hidden');
   document.getElementById('btn-set-pin')?.classList.remove('hidden');
   const instr = document.getElementById('hud-pin-instruction');
   if (instr) instr.style.display = '';
   try { triggerDynamicIsland('避難を体験したい出発地点を、地図を動かして十字に合わせ「ここにピンを打つ」を押しましょう', 'info'); } catch (e) {}
 }

 function initUI() {
 const btnOnboarding = document.getElementById('btn-onboarding-ok');
 const btnErrorOk = document.getElementById('btn-error-ok');
 const btnTestAlert = document.getElementById('btn-test-alert');
 const btnSos = document.getElementById('btn-sos');
 const btnCoastDist = document.getElementById('btn-coastline-dist');
  if (btnCoastDist) {
    btnCoastDist.addEventListener('click', () => toggleCoastDistDisplay());
  }
  document.getElementById('coast-dist-dismiss-chip')?.addEventListener('click', () => {
    if (_coastDistActive) clearCoastDistOverlay();
    if (typeof triggerHapticTick === 'function') triggerHapticTick();
  });

  // ── AI Learning Model Guide Overlay ───────────────────────────────────
  const aiGuideOverlay = document.getElementById('ai-guide-overlay');
  const openAiGuide = () => {
    if (aiGuideOverlay) {
      aiGuideOverlay.classList.remove('hidden');
      setTimeout(() => aiGuideOverlay.classList.add('active'), 10);
    }
  };
  const closeAiGuide = () => {
    if (aiGuideOverlay) {
      aiGuideOverlay.classList.remove('active');
      setTimeout(() => aiGuideOverlay.classList.add('hidden'), 300);
    }
  };
  document.getElementById('btn-open-ai-guide')?.addEventListener('click', openAiGuide);
  document.getElementById('btn-ai-guide-close')?.addEventListener('click', closeAiGuide);
  document.getElementById('btn-ai-guide-close-bottom')?.addEventListener('click', closeAiGuide);
  document.getElementById('sp-ai-card')?.addEventListener('click', () => {
    const sp = document.getElementById('side-panel');
    if (sp) { sp.classList.remove('active'); setTimeout(() => sp.classList.add('hidden'), 300); }
    openAiGuide();
  });

  const btnScreenshot = document.getElementById('btn-screenshot');
 const btnToggleLayers = document.getElementById('btn-toggle-layers');
 const btnSettings = document.getElementById('btn-settings');
 const btnSettingsClose = document.getElementById('btn-settings-close');
 const langSelect = document.getElementById('lang-select');
 const btnClearCache = document.getElementById('btn-clear-cache');
 
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

 // 学ぶドック: オンボーディングデモ再生（初回以外でも常に配線）
 document.getElementById('btn-replay-demo')?.addEventListener('click', replayOnboardingDemo);

 // Network Status initialization & listeners
 window.addEventListener('online', updateNetworkStatusHUD);
 window.addEventListener('offline', updateNetworkStatusHUD);
 updateNetworkStatusHUD(); // Initial call

 (function initHudCompactResize() {
  const appEl = document.getElementById('app-container');
  if (!appEl || typeof ResizeObserver === 'undefined') return;
  let hudResizeTimer = null;
  const refreshHudLabels = function () {
   if (lastTsunamiIsInundated === null) return;
   updateTsunamiStatusUI(lastTsunamiIsInundated);
  };
  const observer = new ResizeObserver(function () {
   clearTimeout(hudResizeTimer);
   hudResizeTimer = setTimeout(refreshHudLabels, 120);
  });
  observer.observe(appEl);
  window.addEventListener('orientationchange', refreshHudLabels);
 })();

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

 applyCompassDisplay();

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

 btnOnboarding?.addEventListener('click', () => {
 const overlay = document.getElementById('onboarding-overlay');
 if (!overlay) return;
 overlay.classList.remove('active');
 setTimeout(() => overlay.classList.add('hidden'), 300);
 // いきなりOS許可ダイアログを出さず、用途・プライバシー説明を挟んでから要求（他導線と統一）
 showLocationExplanation(requestLocation);
 });

 btnErrorOk?.addEventListener('click', () => {
 const overlay = document.getElementById('error-overlay');
 if (!overlay) return;
 overlay.classList.remove('active');
 setTimeout(() => overlay.classList.add('hidden'), 300);
 
 isManualLocation = true;
 currentLocation = { lat: map.getCenter().lat, lng: map.getCenter().lng };
 updateMarker(currentLocation);
 fetchElevation(currentLocation);
 triggerLocationTsunamiCheck(currentLocation);
 
 // GPS error fallback: track map center once so user can pan to their location,
 // but stop after first move to avoid following every pan.
 map.once('moveend', () => {
 if(!isEmergency && !isPinLocked) {
 currentLocation = { lat: map.getCenter().lat, lng: map.getCenter().lng };
 updateMarker(currentLocation);
 fetchElevation(currentLocation);
 triggerLocationTsunamiCheck(currentLocation);
 }
 });
 });

 // ── コミュニティレポート ────────────────────────────────────────────────
 function openReportLocationMode() {
   isReportLocationMode = true;
   document.getElementById('crosshair-target')?.classList.remove('hidden');
   document.getElementById('report-confirm-bar')?.classList.remove('hidden');
   document.getElementById('main-bottom-sheet')?.classList.add('hidden');
 }
 function closeReportLocationMode() {
   isReportLocationMode = false;
   document.getElementById('crosshair-target')?.classList.add('hidden');
   document.getElementById('report-confirm-bar')?.classList.add('hidden');
   document.getElementById('main-bottom-sheet')?.classList.remove('hidden');
 }
 function openReportModal() {
   selectedReportCategory = null;
   document.querySelectorAll('.report-cat-btn').forEach(b => b.classList.remove('selected'));
   const submitBtn = document.getElementById('btn-report-submit');
   if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'カテゴリを選んでください'; }
   const ta = document.getElementById('report-comment');
   if (ta) ta.value = '';
   const overlay = document.getElementById('report-overlay');
   if (overlay) { overlay.classList.remove('hidden'); setTimeout(() => overlay.classList.add('active'), 10); }
 }
 function closeReportModal() {
   const overlay = document.getElementById('report-overlay');
   if (overlay) { overlay.classList.remove('active'); setTimeout(() => overlay.classList.add('hidden'), 300); }
 }

 // Report button — show intro (first time) or go straight to location mode
 document.getElementById('btn-report')?.addEventListener('click', () => {
   if (!localStorage.getItem('tenden-report-intro-seen')) {
     const intro = document.getElementById('report-intro-overlay');
     if (intro) { intro.classList.remove('hidden'); setTimeout(() => intro.classList.add('active'), 10); }
   } else {
     openReportLocationMode();
   }
 });

 // Intro overlay actions
 document.getElementById('btn-report-intro-ok')?.addEventListener('click', () => {
   localStorage.setItem('tenden-report-intro-seen', '1');
   const intro = document.getElementById('report-intro-overlay');
   if (intro) { intro.classList.remove('active'); setTimeout(() => intro.classList.add('hidden'), 300); }
   openReportLocationMode();
 });
 document.getElementById('btn-report-intro-skip')?.addEventListener('click', () => {
   const intro = document.getElementById('report-intro-overlay');
   if (intro) { intro.classList.remove('active'); setTimeout(() => intro.classList.add('hidden'), 300); }
 });

 // Location confirm bar
 document.getElementById('btn-report-location-confirm')?.addEventListener('click', () => {
   reportPendingLocation = { lat: map.getCenter().lat, lng: map.getCenter().lng };
   closeReportLocationMode();
   openReportModal();
 });
 document.getElementById('btn-report-location-cancel')?.addEventListener('click', closeReportLocationMode);

 // Category selection (radio-style)
 document.querySelectorAll('.report-cat-btn').forEach(btn => {
   btn.addEventListener('click', () => {
     document.querySelectorAll('.report-cat-btn').forEach(b => b.classList.remove('selected'));
     btn.classList.add('selected');
     selectedReportCategory = btn.dataset.cat;
     const submitBtn = document.getElementById('btn-report-submit');
     if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = '送信する'; }
   });
 });

 // Report close
 document.getElementById('btn-report-close')?.addEventListener('click', closeReportModal);

 // Submit
 document.getElementById('btn-report-submit')?.addEventListener('click', async () => {
   if (!selectedReportCategory) return;
   const comment = document.getElementById('report-comment')?.value || '';
   const submitBtn = document.getElementById('btn-report-submit');
   if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = '送信中…'; }
   const result = await submitCommunityReport(selectedReportCategory, comment);
   closeReportModal();
   if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = '送信する'; }
   if (result === 'ok') {
     triggerDynamicIsland('レポートを送信しました', 'success');
     if (communityReportsVisible) loadCommunityReports();
   } else if (result === 'rate_limited') {
     showCustomAlert('送信制限', '連続投稿を防ぐため1分間に1件のみ送信できます。', 'warning');
   } else if (result === 'no_location') {
     showCustomAlert('位置情報なし', '現在地を取得してから再試行してください。', 'warning');
   } else if (result === 'no_db') {
     showCustomAlert('初期化エラー', 'データベースへの接続に失敗しました。ページを再読み込みしてください。', 'error');
   } else if (result === 'permission_denied') {
     showCustomAlert('送信拒否', 'セキュリティルールにより送信が拒否されました。開発者に連絡してください。', 'error');
   } else {
     showCustomAlert('送信失敗', 'サーバーへの送信に失敗しました。しばらく経ってから再試行してください。', 'error');
   }
 });

 document.getElementById('toggle-community-reports')?.addEventListener('change', function() {
   toggleCommunityReportsLayer(this.checked);
 });

 btnTestAlert?.addEventListener('click', () => {
   startDrillExperienceFlow();
 });

 document.getElementById('btn-research-intro-start')?.addEventListener('click', () => {
   startDrillPinDrop();
   if (typeof triggerHapticTick === 'function') triggerHapticTick();
 });

 // ── 本番モード（実際の津波時）──────────────────────────────────────────
 document.getElementById('btn-real-mode')?.addEventListener('click', () => {
   const ov = document.getElementById('real-mode-confirm');
   if (ov) { ov.classList.remove('hidden'); setTimeout(() => ov.classList.add('active'), 10); }
   if (typeof triggerHapticTick === 'function') triggerHapticTick();
 });
 document.getElementById('btn-real-cancel')?.addEventListener('click', () => {
   const ov = document.getElementById('real-mode-confirm');
   if (ov) { ov.classList.remove('active'); setTimeout(() => ov.classList.add('hidden'), 250); }
 });
 document.getElementById('btn-real-confirm')?.addEventListener('click', () => {
   const ov = document.getElementById('real-mode-confirm');
   if (ov) { ov.classList.remove('active'); ov.classList.add('hidden'); }
   startRealMode();
 });
 function startRealMode() {
   if (!currentLocation) {
     showCustomAlert('現在地が取得できていません', '画面右側の「現在地」ボタンで位置情報を取得してから、もう一度お試しください。', 'info');
     return;
   }
   isDrillMode = false;
   document.getElementById('btn-test-alert')?.classList.add('hidden');
   document.getElementById('btn-real-mode')?.classList.add('hidden');
   if (routeLayerGroup) routeLayerGroup.clearLayers();
   clearRouteDestinationHighlights();
   isManualLocation = false;
   updateMarker(currentLocation);
   try { map.setView([currentLocation.lat, currentLocation.lng], 16); } catch (e) {}
   triggerEmergencyMode(false, 1, 'a');
 }

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
 // 予習再生中にこのボタンを押した場合、再生を確実に終了してから戻る。
 // (再生画面を閉じないと#evac-playbackが残り続け、下のピン設置ボタンが隠れて機能しなくなる)
 try { if (typeof stopEvacuationPlayback === 'function') stopEvacuationPlayback(); } catch (e) {}
 isPinLocked = false;
 isWaitingForPinDrop = true; // Re-enable crosshair pin drop

 // Stop simulation and clear routes
 if (simulationInterval) {
 clearInterval(simulationInterval);
 simulationInterval = null;
 }
 routeLayerGroup.clearLayers();
 clearRouteDestinationHighlights();
 
 // Show crosshair
 const crosshair = document.getElementById('crosshair-target');
 if (crosshair) crosshair.classList.remove('hidden');
 
 // Hide HUD banner and restore instruction UI
 document.getElementById('evacuation-banner').classList.add('hidden');
 document.body.classList.remove('tenden-nav-active');
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

 // 訓練終了: wireEndDrillButton() で document 委譲（重複配線を避ける）

 if (btnSos) btnSos.addEventListener('click', () => {
 const flash = document.getElementById('flash-overlay');
 flash.classList.toggle('hidden');
 flash.classList.toggle('flash');
 });

 // #btn-share: wireShareSafetyNavButton() で document 委譲（避難ナビ中のタップを確実に捕捉）

 // Default layers state to active
 if (hazardLayer) hazardLayer.addTo(map);
 if (sheltersLayerGroup) sheltersLayerGroup.addTo(map);
 syncDockHazardToggle();

 btnToggleLayers?.addEventListener('click', () => {
 const overlay = document.getElementById('layers-overlay');
 if (!overlay) return;
 overlay.classList.remove('hidden');
 setTimeout(() => overlay.classList.add('active'), 10);
 });

 // Layer Dialog Listeners
 document.getElementById('btn-layers-close')?.addEventListener('click', () => {
 const overlay = document.getElementById('layers-overlay');
 if (!overlay) return;
 overlay.classList.remove('active');
 setTimeout(() => overlay.classList.add('hidden'), 300);
 });

 document.getElementById('toggle-shelters')?.addEventListener('change', (e) => {
 if (e.target.checked) {
 if (sheltersLayerGroup) sheltersLayerGroup.addTo(map);
 } else {
 if (sheltersLayerGroup) map.removeLayer(sheltersLayerGroup);
 }
 });

 document.getElementById('toggle-hazard')?.addEventListener('change', (e) => {
 setHazardLayerVisible(!!e.target.checked);
 });

 function setHazardLayerVisible(visible) {
 const toggle = document.getElementById('toggle-hazard');
 if (toggle && toggle.checked !== visible) toggle.checked = visible;
 if (map && hazardLayer) {
 if (visible) hazardLayer.addTo(map);
 else map.removeLayer(hazardLayer);
 }
 syncDockHazardToggle();
 if (typeof setAgentForFeature === 'function') {
   if (visible) setAgentForFeature('hazard-layer', undefined, { persist: true });
   else if (!isEmergency && !document.body.classList.contains('tenden-nav-active')) {
     setAgentForFeature('default', undefined, { persist: true });
   }
 }
 }

 function syncDockHazardToggle() {
 const toggle = document.getElementById('toggle-hazard');
 const dock = document.getElementById('dock-hazard-toggle');
 if (!toggle || !dock) return;
 const on = toggle.checked;
 dock.setAttribute('aria-pressed', on ? 'true' : 'false');
 dock.classList.toggle('dock-toggle-active', on);
 }

 document.getElementById('toggle-congestion')?.addEventListener('change', (e) => {
 if (e.target.checked) {
 if (congestionLayer) congestionLayer.addTo(map);
 } else {
 if (congestionLayer) map.removeLayer(congestionLayer);
 }
 });

 document.getElementById('toggle-relief')?.addEventListener('change', (e) => {
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

 // (SW toggle removed — PWA permanently disabled during development)

 const btnGpsLocation = document.getElementById('btn-gps-location');
 if (btnGpsLocation) {
 btnGpsLocation.addEventListener('click', () => {
 if (isModelAreaDemo) {
   exitModelAreaDemo();
 } else {
   isManualLocation = false;
   requestLocation();
 }
 requestOrientationPermission();
 requestNotificationPermission();
 triggerHapticTick();
 });
 }

 // FAB: みんなのレポート → 選択画面を開く
 const btnToggleReportsFab = document.getElementById('btn-toggle-reports-fab');
 if (btnToggleReportsFab) {
   btnToggleReportsFab.addEventListener('click', () => {
     const overlay = document.getElementById('report-choice-overlay');
     if (overlay) { overlay.classList.remove('hidden'); setTimeout(() => overlay.classList.add('active'), 10); }
   });
 }

 const btnFocusModel = document.getElementById('btn-focus-model');
 if (btnFocusModel) {
 btnFocusModel.addEventListener('click', () => {
 if (typeof resetModelAreaMorePanel === 'function') resetModelAreaMorePanel();
 const overlay = document.getElementById('model-area-overlay');
 overlay.classList.remove('hidden');
 setTimeout(() => overlay.classList.add('active'), 10);
 if (typeof setAgentForFeature === 'function') setAgentForFeature('model-area', undefined, { persist: true });
 });
 }

 // ── サイドパネル ────────────────────────────────────────────────────────
 function openSidePanel() {
   const backdrop = document.getElementById('side-panel-backdrop');
   const panel = document.getElementById('side-panel');
   if (!backdrop || !panel) return;
   backdrop.classList.remove('hidden');
   panel.classList.remove('hidden');
   requestAnimationFrame(() => { backdrop.classList.add('open'); panel.classList.add('open'); });
   triggerHapticTick();
 }
 function closeSidePanel() {
   const backdrop = document.getElementById('side-panel-backdrop');
   const panel = document.getElementById('side-panel');
   if (!backdrop || !panel) return;
   backdrop.classList.remove('open');
   panel.classList.remove('open');
   setTimeout(() => { backdrop.classList.add('hidden'); panel.classList.add('hidden'); }, 420);
 }

 // ── 地震・津波情報オーバーレイ ───────────────────────────────────────────
 let _eqPollTimer = null;
 let _quakeOverlayFocus = 'all';

 function _applyQuakeOverlayFocus(focus) {
   const f = (focus === 'tsunami' || focus === 'earthquake') ? focus : 'all';
   _quakeOverlayFocus = f;
   const ov = document.getElementById('quake-overlay');
   if (ov) ov.dataset.focus = f;
   const titleEl = document.getElementById('quake-sheet-title-text');
   if (titleEl) {
     const titleKey = f === 'tsunami' ? 'quakeOverlayTitleTsunami'
       : f === 'earthquake' ? 'quakeOverlayTitleEarthquake'
       : 'trunkQuakeTitle';
     titleEl.setAttribute('data-i18n', titleKey);
     titleEl.textContent = _quakeT(titleKey, f === 'tsunami' ? '津波情報' : f === 'earthquake' ? '地震情報' : '地震・津波情報');
   }
 }

 function openQuakeOverlay(focus) {
   closeSidePanel();
   const ov = document.getElementById('quake-overlay');
   if (!ov) return;
   _applyQuakeOverlayFocus(focus);
   ov.classList.remove('hidden');
   requestAnimationFrame(() => ov.classList.add('active'));
   loadQuakeTsunamiPanel();
   if (!_eqPollTimer) _eqPollTimer = setInterval(loadQuakeTsunamiPanel, 120000);
   if (typeof setAgentForFeature === 'function') {
     const agentFeature = _quakeOverlayFocus === 'tsunami' ? 'tsunami-panel'
       : _quakeOverlayFocus === 'earthquake' ? 'earthquake-panel'
       : 'quake-panel';
     setAgentForFeature(agentFeature, undefined, { persist: true });
   }
   triggerHapticTick();
 }
 function closeQuakeOverlay() {
   const ov = document.getElementById('quake-overlay');
   if (!ov) return;
   ov.classList.remove('active');
   setTimeout(() => ov.classList.add('hidden'), 380);
   if (_eqPollTimer) { clearInterval(_eqPollTimer); _eqPollTimer = null; }
   if (typeof setAgentForFeature === 'function') {
     if (isEmergency || document.body.classList.contains('tenden-nav-active')) {
       setAgentForFeature('emergency-active', undefined, { persist: true });
     } else {
       setAgentForFeature('default', undefined, { persist: true });
     }
   }
 }

 // 津波の危険性を大きく明示する状態ヘッダーを更新（色＋アイコン＋文言の多重表現）
 const JMA_TSUNAMI_MAP_URL = 'https://www.jma.go.jp/bosai/map.html#contents=tsunami';
 const _TS_GRADE_ORDER = { MajorWarning: 3, Warning: 2, Watch: 1, Unknown: 0 };
 const _TS_GRADE_KEYS = { MajorWarning: 'quakeGradeMajorWarning', Warning: 'quakeGradeWarning', Watch: 'quakeGradeWatch', Unknown: 'quakeGradeUnknown' };
 const _TS_GRADE_CLS  = { MajorWarning: 'ts-grade-major', Warning: 'ts-grade-warning', Watch: 'ts-grade-watch', Unknown: 'ts-grade-unknown' };

 function _quakeT(key, fallback, vars) {
   const dict = i18nDict[getLanguageCode()] || i18nDict['ja'] || {};
   let text = dict[key] || fallback || '';
   if (vars) Object.entries(vars).forEach(([k, v]) => { text = text.replace(`{${k}}`, v); });
   return text;
 }

 function _eqFormatTime(str) {
   if (!str) return '';
   const d = new Date(str.replace(/\//g, '-').replace(' ', 'T') + '+09:00');
   if (isNaN(d.getTime())) return str.slice(0, 16);
   return d.toLocaleString(getLanguageCode() === 'ja' ? 'ja-JP' : undefined, {
     month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
   });
 }

 function _eqTsunamiGradeLabel(grade) {
   return _quakeT(_TS_GRADE_KEYS[grade] || 'quakeGradeUnknown', grade || '不明');
 }

 function _eqDomesticTsunamiText(dt) {
   const keyMap = {
     None: 'quakeDomesticNone', Unknown: 'quakeDomesticUnknown', Checking: 'quakeDomesticChecking',
     NonEffective: 'quakeDomesticNonEffective', Watch: 'quakeDomesticWatch', Warning: 'quakeDomesticWarning'
   };
   return _quakeT(keyMap[dt] || 'quakeDomesticUnknown', _eqTsunamiLabel(dt) || dt || '—');
 }

 function _renderTsunamiAreaList(activeTsunami, eqList) {
   const listEl = document.getElementById('quake-ts-area-list');
   const issueEl = document.getElementById('quake-ts-issue-time');
   if (!listEl) return;

   if (activeTsunami && activeTsunami.areas?.length) {
     const issueTime = activeTsunami.issue?.time || activeTsunami.time || '';
     if (issueEl) {
       issueEl.textContent = issueTime
         ? `${_quakeT('quakeTsunamiUpdated', '発表')}: ${_eqFormatTime(issueTime)}`
         : '';
     }
     const sorted = [...activeTsunami.areas].sort((a, b) =>
       (_TS_GRADE_ORDER[b.grade] || 0) - (_TS_GRADE_ORDER[a.grade] || 0));
     listEl.innerHTML = sorted.map(area => {
       const grade = area.grade || 'Unknown';
       const gradeCls = _TS_GRADE_CLS[grade] || 'ts-grade-unknown';
       const meta = [];
       const maxH = area.maxHeight?.description;
       if (maxH) meta.push(`${_quakeT('quakeTsunamiAreaHeight', '予想高さ')}: ${maxH}`);
       const arrival = area.firstHeight?.arrivalTime || area.firstHeight?.condition;
       if (arrival) meta.push(`${_quakeT('quakeTsunamiAreaArrival', '到達予想')}: ${arrival}`);
       if (area.immediate) meta.push(_quakeT('quakeTsunamiImmediate', '直ちに来襲の可能性'));
       return `<div class="quake-ts-area-item ${gradeCls}" role="listitem">
         <span class="quake-ts-area-grade">${_eqTsunamiGradeLabel(grade)}</span>
         <div class="quake-ts-area-body">
           <div class="quake-ts-area-name">${area.name || '—'}</div>
           ${meta.length ? `<div class="quake-ts-area-meta">${meta.join(' · ')}</div>` : ''}
         </div>
       </div>`;
     }).join('');
     return;
   }

   if (issueEl) issueEl.textContent = '';
   const recentTs = eqList.find(eq => {
     const dt = eq.earthquake?.domesticTsunami;
     return dt === 'Warning' || dt === 'Watch';
   });
   if (recentTs) {
     const e = recentTs.earthquake || {};
     const h = e.hypocenter || {};
     listEl.innerHTML = `<div class="quake-ts-area-item ts-grade-watch ts-from-eq" role="listitem">
       <span class="quake-ts-area-grade">${_eqDomesticTsunamiText(e.domesticTsunami)}</span>
       <div class="quake-ts-area-body">
         <div class="quake-ts-area-name">${h.name || '—'}</div>
         <div class="quake-ts-area-meta">${_quakeT('quakeTsFromEqNote', '地震情報より（公式発表待ち）')}</div>
       </div>
     </div>`;
   } else {
     listEl.innerHTML = `<div class="quake-ts-area-empty">${_quakeT('quakeTsunamiNoAlert', '津波警報・注意報は発表されていません')}</div>`;
   }
 }

 function _renderEarthquakeList(eqList) {
   const listEl = document.getElementById('quake-eq-list');
   if (!listEl) return;
   if (!eqList.length) {
     listEl.innerHTML = `<div class="sp-eq-placeholder">${_quakeT('quakeNoData', 'データなし')}</div>`;
     return;
   }
   listEl.innerHTML = eqList.map(eq => {
     const e = eq.earthquake || {};
     const h = e.hypocenter || {};
     const mag = h.magnitude != null ? h.magnitude : '?';
     const place = h.name || '—';
     const depth = h.depth != null && h.depth >= 0
       ? _quakeT('quakeDepthFmt', '{depth}km', { depth: h.depth }) : '';
     const scaleLabel = _eqScaleToLabel(e.maxScale);
     const occurTime = _eqFormatTime(e.time || eq.time);
     const relTime = _eqRelativeTime(eq.time || e.time);
     const coords = (h.latitude != null && h.longitude != null)
       ? `${h.latitude.toFixed(1)}°N ${h.longitude.toFixed(1)}°E` : '';
     const magColor = mag >= 6 ? '#ff453a' : mag >= 5 ? '#ff9f0a' : mag >= 3 ? '#ffd60a' : '#8ed0ff';
     const dt = e.domesticTsunami;
     const tsState = (dt === 'Warning' || dt === 'Watch') ? 'danger'
                   : (dt === 'NonEffective') ? 'minor' : 'none';
     const tsText = _eqDomesticTsunamiText(dt);
     const tsCls  = tsState === 'danger' ? 'eq-ts-danger' : tsState === 'minor' ? 'eq-ts-minor' : 'eq-ts-none';
     const fields = [
       [_quakeT('quakeFieldOccurrence', '発生時刻'), `${occurTime}${relTime ? ` (${relTime})` : ''}`],
       [_quakeT('quakeFieldHypocenter', '震源'), place],
       [_quakeT('quakeFieldMagnitude', 'マグニチュード'), `M${mag}`],
       scaleLabel ? [_quakeT('quakeFieldIntensity', '最大震度'), scaleLabel] : null,
       depth ? [_quakeT('quakeFieldDepth', '深さ'), depth] : null,
       coords ? [_quakeT('quakeFieldCoords', '位置'), coords] : null,
       dt ? [_quakeT('quakeFieldDomesticTsunami', '津波の見通し'), tsText] : null,
     ].filter(Boolean);
     return `<div class="eq-card ${tsCls}">
       <div class="eq-card-mag" style="color:${magColor}"><span class="eq-mag-num">M${mag}</span></div>
       <div class="eq-card-body">
         <div class="eq-card-place">${place}</div>
         <dl class="eq-card-fields">${fields.map(([lbl, val]) =>
           `<div class="eq-field-row"><dt>${lbl}</dt><dd>${val}</dd></div>`
         ).join('')}</dl>
         <div class="eq-card-ts"><span class="eq-ts-dot"></span>${tsText}</div>
       </div>
       <div class="eq-card-time">${relTime}</div>
     </div>`;
   }).join('');
 }

 function _setTsunamiStatus(kind, main, sub) {
   const el = document.getElementById('quake-tsunami-status');
   if (!el) return;
   el.className = 'quake-ts-status quake-ts-' + kind;
   const icons = {
     safe: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" width="24" height="24" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
     watch: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" width="24" height="24" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
     danger: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" width="24" height="24" stroke-linecap="round"><path d="M2 7c2 0 2 1.8 4 1.8S8 7 10 7s2 1.8 4 1.8S16 7 18 7s2 1.8 4 1.8"/><path d="M2 13c2 0 2 1.8 4 1.8s2-1.8 4-1.8 2 1.8 4 1.8 2-1.8 4-1.8 2 1.8 4 1.8"/><path d="M2 19c2 0 2 1.8 4 1.8s2-1.8 4-1.8 2 1.8 4 1.8 2-1.8 4-1.8 2 1.8 4 1.8"/></svg>'
   };
   const ic = el.querySelector('.quake-ts-icon'); if (ic) ic.innerHTML = icons[kind] || icons.safe;
   const m = el.querySelector('.quake-ts-main'); if (m) m.textContent = main;
   const s = el.querySelector('.quake-ts-sub');  if (s) s.textContent = sub || '';
   const mapBtn = document.getElementById('btn-quake-tsunami-map');
   if (mapBtn) {
     const showMap = kind !== 'safe';
     mapBtn.classList.toggle('hidden', !showMap);
     mapBtn.href = JMA_TSUNAMI_MAP_URL;
   }
 }

 function _resolveHudTsunamiKindFromApi(activeTsunami, eqList) {
   if (activeTsunami) {
     const maxGrade = activeTsunami.areas.reduce((best, a) =>
       (_TS_GRADE_ORDER[a.grade] || 0) > (_TS_GRADE_ORDER[best] || 0) ? a.grade : best, 'Watch');
     return maxGrade === 'Watch' ? 'watch' : 'danger';
   }
   const recentTs = eqList.find(eq => {
     const dt = (eq.earthquake && eq.earthquake.domesticTsunami);
     return dt === 'Warning' || dt === 'Watch';
   });
   return recentTs ? 'watch' : 'safe';
 }

 function _updateHudTsunamiChip(kind) {
   _hudTsunamiKind = kind || 'checking';
   const chip = document.getElementById('hud-tsunami-chip');
   const textEl = document.getElementById('hud-tsunami-chip-text');
   if (!chip || !textEl) return;
   const dict = i18nDict[getLanguageCode()] || i18nDict['ja'] || {};
   const labels = {
     checking: dict.hudTsunamiChipChecking || '津波: …',
     safe: dict.hudTsunamiChipSafe || '津波: なし',
     watch: dict.hudTsunamiChipWatch || '津波: 注意',
     danger: dict.hudTsunamiChipDanger || '津波: 警報'
   };
   chip.className = 'status-badge hud-tsunami-chip hud-tsunami-chip--' + (_hudTsunamiKind === 'checking' ? 'checking' : _hudTsunamiKind);
   textEl.textContent = labels[_hudTsunamiKind] || labels.checking;
   if (dict.hudTsunamiChipAria) chip.setAttribute('aria-label', dict.hudTsunamiChipAria);
   if (typeof updateHudTimeWarning === 'function') updateHudTimeWarning();
 }

 async function refreshHudTsunamiStatus() {
   _updateHudTsunamiChip('checking');
   try {
     const [eqRes, tsRes] = await Promise.all([
       fetch('https://api.p2pquake.net/v2/history?codes=551&limit=5', { signal: AbortSignal.timeout(8000) }),
       fetch('https://api.p2pquake.net/v2/history?codes=552&limit=5',  { signal: AbortSignal.timeout(8000) })
     ]);
     const eqList = (eqRes.ok ? await eqRes.json() : []).slice(0, 5);
     const tsList = tsRes.ok ? await tsRes.json() : [];
     const activeTsunami = tsList.find(ts => !ts.cancelled && ts.areas?.length) || null;
     _updateHudTsunamiChip(_resolveHudTsunamiKindFromApi(activeTsunami, eqList));
   } catch (err) {
     console.warn('[HudTsunami]', err);
     _updateHudTsunamiChip('safe');
   }
 }

 function initHudTsunamiPolling() {
   refreshHudTsunamiStatus();
   if (!_hudTsunamiPollTimer) {
     _hudTsunamiPollTimer = setInterval(refreshHudTsunamiStatus, 120000);
   }
   document.getElementById('hud-tsunami-chip')?.addEventListener('click', () => openQuakeOverlay('tsunami'));
 }

 async function loadQuakeTsunamiPanel() {
   const listEl  = document.getElementById('quake-eq-list');
   const updEl   = document.getElementById('quake-updated');
   const tsListEl = document.getElementById('quake-ts-area-list');
   if (!listEl) return;
   listEl.innerHTML = `<div class="sp-eq-placeholder">${_quakeT('quakeLoading', '読み込み中…')}</div>`;
   if (tsListEl) tsListEl.innerHTML = `<div class="quake-ts-area-empty">${_quakeT('quakeLoading', '読み込み中…')}</div>`;
   _setTsunamiStatus('safe', _quakeT('quakeTsStatusChecking', '確認中…'), '');
   _updateHudTsunamiChip('checking');
   try {
     const [eqRes, tsRes] = await Promise.all([
       fetch('https://api.p2pquake.net/v2/history?codes=551&limit=5', { signal: AbortSignal.timeout(8000) }),
       fetch('https://api.p2pquake.net/v2/history?codes=552&limit=5',  { signal: AbortSignal.timeout(8000) })
     ]);
     const eqList = (eqRes.ok ? await eqRes.json() : []).slice(0, 5);
     const tsList = tsRes.ok ? await tsRes.json() : [];

     const activeTsunami = tsList.find(ts => !ts.cancelled && ts.areas?.length) || null;
     const hudKind = _resolveHudTsunamiKindFromApi(activeTsunami, eqList);
     _updateHudTsunamiChip(hudKind);
     if (activeTsunami) {
       const maxGrade = activeTsunami.areas.reduce((best, a) =>
         (_TS_GRADE_ORDER[a.grade] || 0) > (_TS_GRADE_ORDER[best] || 0) ? a.grade : best, 'Watch');
       const kind = maxGrade === 'Watch' ? 'watch' : 'danger';
       const gradeLabel = _eqTsunamiGradeLabel(maxGrade);
       const count = activeTsunami.areas.length;
       _setTsunamiStatus(
         kind,
         _quakeT('quakeTsStatusActive', '{grade} 発令中', { grade: gradeLabel }),
         _quakeT('quakeTsStatusActiveSub', '対象 {count} 区／直ちに高台へ避難してください', { count: String(count) })
       );
     } else {
       const recentTs = eqList.find(eq => {
         const dt = (eq.earthquake && eq.earthquake.domesticTsunami);
         return dt === 'Warning' || dt === 'Watch';
       });
       if (recentTs) {
         _setTsunamiStatus(
           'watch',
           _quakeT('quakeTsStatusWatchEq', '津波情報に注意'),
           _quakeT('quakeTsStatusWatchEqSub', '直近の地震で津波の可能性が伝えられています。最新の発表を確認してください')
         );
       } else {
         _setTsunamiStatus(
           'safe',
           _quakeT('quakeTsStatusSafe', '津波の心配はありません'),
           _quakeT('quakeTsStatusSafeSub', '現在、津波警報・注意報は発表されていません')
         );
       }
     }

     _renderTsunamiAreaList(activeTsunami, eqList);
     _renderEarthquakeList(eqList);

     if (updEl) {
       const now = new Date().toLocaleTimeString(getLanguageCode() === 'ja' ? 'ja-JP' : undefined, { hour:'2-digit', minute:'2-digit' });
       updEl.textContent = `${now} ${_quakeT('quakeUpdatedSuffix', '更新')}`;
     }
   } catch (err) {
     listEl.innerHTML = `<div class="sp-eq-placeholder">${_quakeT('quakeFetchError', '取得に失敗しました（通信環境をご確認ください）')}</div>`;
     const tsListEl2 = document.getElementById('quake-ts-area-list');
     if (tsListEl2) tsListEl2.innerHTML = '';
     const issueEl = document.getElementById('quake-ts-issue-time');
     if (issueEl) issueEl.textContent = '';
     _setTsunamiStatus(
       'safe',
       _quakeT('quakeTsStatusFetchError', '情報を取得できませんでした'),
       _quakeT('quakeTsStatusFetchErrorSub', '通信環境をご確認のうえ再読み込みしてください')
     );
     console.warn('[QuakePanel]', err);
   }
 }

 function _eqScaleToLabel(s) {
   return { 10:'1', 20:'2', 30:'3', 40:'4', 45:'5弱', 50:'5強', 55:'6弱', 60:'6強', 70:'7' }[s] || (s === -1 ? '不明' : '');
 }
 function _eqTsunamiLabel(t) {
   return { None:'', Unknown:'調査中', Checking:'調査中', NonEffective:'海面変動あり', Watch:'注意報', Warning:'警報発令' }[t] || '';
 }
 function _eqRelativeTime(str) {
   if (!str) return '';
   const d = new Date(str.replace(/\//g, '-').replace(' ', 'T') + '+09:00');
   const diff = Math.floor((Date.now() - d.getTime()) / 60000);
   if (isNaN(diff) || diff < 0) return str.slice(5, 16);
   if (diff < 1) return 'たった今';
   if (diff < 60) return `${diff}分前`;
   if (diff < 1440) return `${Math.floor(diff / 60)}時間前`;
   return `${Math.floor(diff / 1440)}日前`;
 }

 document.getElementById('btn-open-side-panel')?.addEventListener('click', openSidePanel);
 document.getElementById('btn-side-panel-close')?.addEventListener('click', closeSidePanel);
 document.getElementById('side-panel-backdrop')?.addEventListener('click', closeSidePanel);
 document.getElementById('sp-quake-card')?.addEventListener('click', () => openQuakeOverlay('all'));
 document.getElementById('btn-quake-close')?.addEventListener('click', closeQuakeOverlay);
 document.getElementById('btn-quake-tsunami-map')?.addEventListener('click', () => {
   if (typeof setAgentForFeature === 'function') setAgentForFeature('tsunami-map', undefined, { persist: true });
 });
 document.getElementById('btn-quake-refresh')?.addEventListener('click', loadQuakeTsunamiPanel);
 document.getElementById('dock-quake-tsunami')?.addEventListener('click', () => openQuakeOverlay('tsunami'));
 document.getElementById('dock-quake-earthquake')?.addEventListener('click', () => openQuakeOverlay('earthquake'));
 document.getElementById('btn-quake-open-guide')?.addEventListener('click', () => {
   closeQuakeOverlay();
   const guideOverlay = document.getElementById('guide-overlay');
   if (!guideOverlay) return;
   guideOverlay.classList.remove('hidden');
   setTimeout(() => guideOverlay.classList.add('active'), 10);
 });
 document.getElementById('quake-overlay')?.addEventListener('click', e => {
   if (e.target === document.getElementById('quake-overlay')) closeQuakeOverlay();
 });

 // カード → 対応ボタンをトリガー
 document.querySelectorAll('.sp-card[data-trigger]').forEach(card => {
   card.addEventListener('click', () => {
     closeSidePanel();
     const target = document.getElementById(card.dataset.trigger);
     if (target) setTimeout(() => target.click(), 220);
   });
 });

 // ボトムドック → 対応ボタン / サイドパネルカードをトリガー
 document.querySelectorAll('.dock-item[data-trigger]').forEach(item => {
   item.addEventListener('click', () => {
     const target = document.getElementById(item.dataset.trigger);
     if (target) target.click();
   });
 });
 [
   ['dock-report-card', 'sp-report-card'],
   ['dock-announcements-card', 'sp-announcements-card'],
 ].forEach(([dockId, spId]) => {
   document.getElementById(dockId)?.addEventListener('click', () => {
     document.getElementById(spId)?.click();
   });
 });
 document.getElementById('dock-share-card')?.addEventListener('click', () => {
   shareSafetyStatus({ closeDock: true });
 });
 document.getElementById('dock-app-share')?.addEventListener('click', () => {
   openAppShareOverlay({ closeDock: true });
 });

 function _isLocalDevHost() {
   const h = location.hostname;
   return h === 'localhost' || h === '127.0.0.1' || /^192\.168\./.test(h) || h.endsWith('.local');
 }

 function getAppShareUrl() {
   const cfgUrl = window.TENDEN_CONFIG?.appUrl?.trim();
   if (cfgUrl && !_isLocalDevHost()) return cfgUrl;
   const canonical = document.querySelector('link[rel="canonical"]')?.href?.trim();
   if (canonical && !_isLocalDevHost()) return canonical;
   let path = location.pathname || '/';
   if (path.endsWith('/index.html')) path = path.slice(0, -'/index.html'.length) || '/';
   if (!path.endsWith('/')) path += '/';
   return location.origin + path;
 }

 function renderAppShareQr(url) {
   const container = document.getElementById('app-share-qr');
   if (!container || typeof qrcode !== 'function') return;
   container.innerHTML = '';
   try {
     const qr = qrcode(0, 'M');
     qr.addData(url, 'Byte');
     qr.make();
     const dict = i18nDict[getLanguageCode()] || i18nDict.ja || {};
     const ariaLabel = dict.appShareQrAria || 'TENDEN app share QR code';
     container.innerHTML = qr.createSvgTag({
       cellSize: 5,
       margin: 2,
       scalable: true,
       title: ariaLabel,
     });
     const svg = container.querySelector('svg');
     if (svg) {
       svg.setAttribute('role', 'img');
       svg.setAttribute('aria-label', ariaLabel);
     }
   } catch (e) {
     console.warn('[app-share] QR render failed', e);
     container.textContent = url;
   }
 }

 function openAppShareOverlay(options = {}) {
   const overlay = document.getElementById('app-share-overlay');
   if (!overlay) return;
   const url = getAppShareUrl();
   renderAppShareQr(url);
   const urlEl = document.getElementById('app-share-url');
   if (urlEl) urlEl.textContent = url;
   if (options.closeDock && typeof window.closeDockSub === 'function') window.closeDockSub();
   overlay.classList.remove('hidden');
   setTimeout(() => overlay.classList.add('active'), 10);
   document.getElementById('btn-app-share-close')?.focus();
 }

 function closeAppShareOverlay() {
   const overlay = document.getElementById('app-share-overlay');
   if (!overlay) return;
   overlay.classList.remove('active');
   setTimeout(() => overlay.classList.add('hidden'), 300);
 }

 document.getElementById('btn-app-share-close')?.addEventListener('click', closeAppShareOverlay);
 document.getElementById('app-share-overlay')?.addEventListener('click', function(e) {
   if (e.target === this) closeAppShareOverlay();
 });
 document.getElementById('btn-app-share-copy')?.addEventListener('click', async () => {
   const dict = i18nDict[getLanguageCode()] || i18nDict.ja || {};
   const url = getAppShareUrl();
   try {
     if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(url);
     else throw new Error('clipboard unavailable');
     triggerDynamicIsland(dict.appShareCopied || dict.copiedLabel || 'Copied', 'copied');
   } catch (_) {
     triggerDynamicIsland(dict.appShareError || 'Could not copy', 'warning');
   }
 });
 document.getElementById('btn-app-share-system')?.addEventListener('click', async () => {
   const dict = i18nDict[getLanguageCode()] || i18nDict.ja || {};
   const url = getAppShareUrl();
   const title = dict.appShareTitle || 'Share TENDEN';
   const text = dict.appShareDesc || '';
   const payloads = [{ title, text, url }, { title, text }, { text, url }, { url }];
   if (navigator.share && window.isSecureContext) {
     for (const data of payloads) {
       if (navigator.canShare && !navigator.canShare(data)) continue;
       try {
         await navigator.share(data);
         triggerDynamicIsland(dict.appShareShared || dict.sharedLabel || 'Shared', 'success');
         return;
       } catch (e) {
         if (e?.name === 'AbortError') return;
       }
     }
   }
   document.getElementById('btn-app-share-copy')?.click();
 });

 function _bindDockCheckboxToggle(dockId, checkboxId) {
   const dock = document.getElementById(dockId);
   const toggle = document.getElementById(checkboxId);
   if (!dock || !toggle) return;
   function sync() {
     const on = toggle.checked;
     dock.setAttribute('aria-pressed', on ? 'true' : 'false');
     dock.classList.toggle('dock-toggle-active', on);
   }
   dock.addEventListener('click', () => {
     toggle.checked = !toggle.checked;
     toggle.dispatchEvent(new Event('change', { bubbles: true }));
     sync();
     triggerHapticTick();
   });
   toggle.addEventListener('change', sync);
   sync();
 }
 _bindDockCheckboxToggle('dock-p2p-toggle', 'toggle-p2p-auto');
 document.getElementById('dock-hazard-toggle')?.addEventListener('click', () => {
   const toggle = document.getElementById('toggle-hazard');
   if (!toggle) return;
   setHazardLayerVisible(!toggle.checked);
   triggerHapticTick();
 });

 // レポートカード（サイドパネル内）— 選択画面を表示
 document.getElementById('sp-report-card')?.addEventListener('click', () => {
   closeSidePanel();
   const overlay = document.getElementById('report-choice-overlay');
   if (overlay) { overlay.classList.remove('hidden'); setTimeout(() => overlay.classList.add('active'), 10); }
 });

 function closeReportChoice() {
   const overlay = document.getElementById('report-choice-overlay');
   if (overlay) { overlay.classList.remove('active'); setTimeout(() => overlay.classList.add('hidden'), 300); }
 }

 function showReportChoiceHint(key, feature) {
   const dict = i18nDict[getLanguageCode()] || i18nDict['ja'] || {};
   const msg = dict[key];
   if (!msg || typeof showAgentBubble !== 'function') return;
   setTimeout(() => showAgentBubble(msg, { type: 'info', duration: 5000, feature }), 350);
 }

 document.getElementById('btn-report-choice-close')?.addEventListener('click', closeReportChoice);

 // 凡例の×ボタン — レイヤーごとOFF
 document.getElementById('btn-report-legend-close')?.addEventListener('click', () => {
   toggleCommunityReportsLayer(false);
   const layerToggle = document.getElementById('toggle-community-reports');
   if (layerToggle) layerToggle.checked = false;
   const fab = document.getElementById('btn-toggle-reports-fab');
   if (fab) { fab.classList.remove('fab-active'); fab.setAttribute('aria-pressed', 'false'); }
 });

 // 「みんなのレポートを見る」
 document.getElementById('btn-view-reports-choice')?.addEventListener('click', () => {
   closeReportChoice();
   if (!firestoreDB) initFirebase();
   const layerToggle = document.getElementById('toggle-community-reports');
   if (layerToggle && !layerToggle.checked) {
     layerToggle.checked = true;
     toggleCommunityReportsLayer(true);
   }
   const fab = document.getElementById('btn-toggle-reports-fab');
   if (fab) { fab.classList.add('fab-active'); fab.setAttribute('aria-pressed', 'true'); }
   showReportChoiceHint('reportChoiceHintView', 'report-view');
 });

 // 「危険な場所を報告する」
 document.getElementById('btn-submit-report-choice')?.addEventListener('click', () => {
   closeReportChoice();
   setTimeout(() => document.getElementById('btn-report')?.click(), 320);
   showReportChoiceHint('reportChoiceHintSubmit', 'report-submit');
 });

 // 友達に安全情報を送る（安否共有）
 document.getElementById('sp-share-card')?.addEventListener('click', () => {
   closeSidePanel();
   shareSafetyStatus();
 });

 // 開発者からの連絡
 document.getElementById('sp-announcements-card')?.addEventListener('click', () => {
   closeSidePanel();
   setTimeout(openAnnouncementsOverlay, 260);
 });
 document.getElementById('btn-ann-close')?.addEventListener('click', closeAnnouncementsOverlay);
 document.getElementById('dev-ann-overlay')?.addEventListener('click', function(e) {
   if (e.target === this) closeAnnouncementsOverlay();
 });
 document.getElementById('btn-startup-notice-close')?.addEventListener('click', () => {
   _startupNoticeDismissed = true;
   const n = document.getElementById('startup-notice');
   if (n) n.classList.add('hidden');
 });

 // サイドパネルバッジ更新
 const activeCount = DEV_ANNOUNCEMENTS.filter(a => a.status === 'active').length;
 const annBadge = document.getElementById('sp-ann-badge');
 const dockAnnBadge = document.getElementById('dock-ann-badge');
 if (annBadge && activeCount > 0) {
   annBadge.textContent = `${activeCount}`;  // 角の通知バッジは件数のみ（カードラベルで文脈は明確）
   annBadge.classList.remove('hidden');
 }
 if (dockAnnBadge && activeCount > 0) {
   dockAnnBadge.textContent = `${activeCount}`;
   dockAnnBadge.classList.remove('hidden');
 }

 // 起動時ポップアップはオンボーディング完了後 or すでに見た場合は即時（後述）

 function setModelAreaDismissChipVisible(visible) {
 const chip = document.getElementById('model-area-dismiss-chip');
 if (!chip) return;
 chip.classList.toggle('hidden', !visible);
 if (visible) {
   const dict = i18nDict[getLanguageCode()] || i18nDict['ja'] || {};
   const span = chip.querySelector('[data-i18n="modelAreaDismissChip"]');
   if (span && dict.modelAreaDismissChip) span.textContent = dict.modelAreaDismissChip;
   if (dict.modelAreaDismissAria) chip.setAttribute('aria-label', dict.modelAreaDismissAria);
 }
 }

 function exitModelAreaDemo() {
 if (!isModelAreaDemo) return;
 isManualLocation = false;
 isModelAreaDemo = false;
 document.body.classList.remove('model-area-demo');
 prevTrackLocation = null;
 movementHeading = null;
 setModelAreaDismissChipVisible(false);
 applyCompassDisplay();
 if (typeof setAgentForFeature === 'function' && !isEmergency && !document.body.classList.contains('tenden-nav-active')) {
   setAgentForFeature('default', undefined, { persist: true });
 }
 requestLocation();
 if (typeof triggerHapticTick === 'function') triggerHapticTick();
 }

 function resetModelAreaMorePanel() {
 const btn = document.getElementById('btn-model-area-more');
 const panel = document.getElementById('model-area-more-panel');
 if (panel) panel.classList.remove('expanded');
 if (btn) btn.setAttribute('aria-expanded', 'false');
 }

 function closeModelAreaOverlay() {
 const overlay = document.getElementById('model-area-overlay');
 if (!overlay) return;
 overlay.classList.remove('active');
 setTimeout(() => overlay.classList.add('hidden'), 300);
 resetModelAreaMorePanel();
 if (typeof setAgentForFeature === 'function' && !isEmergency && !document.body.classList.contains('tenden-nav-active')) {
   setAgentForFeature('default', undefined, { persist: true });
 }
 }

 const btnModelAreaClose = document.getElementById('btn-model-area-close');
 if (btnModelAreaClose) btnModelAreaClose.addEventListener('click', closeModelAreaOverlay);

 const btnModelAreaCancel = document.getElementById('btn-model-area-cancel');
 if (btnModelAreaCancel) btnModelAreaCancel.addEventListener('click', closeModelAreaOverlay);

 const btnModelAreaMore = document.getElementById('btn-model-area-more');
 const modelAreaMorePanel = document.getElementById('model-area-more-panel');
 if (btnModelAreaMore && modelAreaMorePanel) {
 btnModelAreaMore.addEventListener('click', () => {
 const expanded = modelAreaMorePanel.classList.toggle('expanded');
 btnModelAreaMore.setAttribute('aria-expanded', expanded ? 'true' : 'false');
 triggerHapticTick();
 });
 }

 const btnModelAreaConfirm = document.getElementById('btn-model-area-confirm');
 if (btnModelAreaConfirm) {
 btnModelAreaConfirm.addEventListener('click', () => {
 closeModelAreaOverlay();

 // モデル地区全域を表示してピンを由比ヶ浜に設定
 isManualLocation = true;
 isModelAreaDemo = true;
 document.body.classList.add('model-area-demo');
 prevTrackLocation = null;
 movementHeading = null;
 currentLocation = { lat: KAMAKURA_DEMO_PIN[0], lng: KAMAKURA_DEMO_PIN[1] };

 map.flyTo([35.308, 139.551], 13, { duration: 1.8, easeLinearity: 0.25 });

 updateMarker(currentLocation);
 fetchElevation(currentLocation);
 triggerLocationTsunamiCheck(currentLocation);
 recordLocationForCompass(currentLocation);
 requestOrientationPermission();
 applyCompassDisplay();

 setModelAreaDismissChipVisible(true);
 if (typeof setAgentForFeature === 'function') setAgentForFeature('model-area', undefined, { persist: true });
 const dict = i18nDict[getLanguageCode()] || i18nDict['ja'] || {};
 if (typeof showAgentBubble === 'function') {
   showAgentBubble(dict.modelAreaBubbleHint || '鎌倉モデル地区でデモ表示中です', {
     type: 'warning',
     duration: 4500,
     syncState: false
   });
 }
 if (typeof updateSafeZoneGuideVisibility === 'function') updateSafeZoneGuideVisibility();
 });
 }

 document.getElementById('model-area-dismiss-chip')?.addEventListener('click', exitModelAreaDemo);

 btnSettings?.addEventListener('click', () => {
 const overlay = document.getElementById('settings-overlay');
 if (!overlay) return;
 overlay.classList.remove('hidden');
 setTimeout(() => overlay.classList.add('active'), 10);
 });

 btnSettingsClose?.addEventListener('click', () => {
 const overlay = document.getElementById('settings-overlay');
 if (!overlay) return;
 overlay.classList.remove('active');
 setTimeout(() => overlay.classList.add('hidden'), 300);
 });

 const btnOpenAbout = document.getElementById('btn-open-about');
 const btnAboutClose = document.getElementById('btn-about-close');
 const aboutOverlay = document.getElementById('about-overlay');

 function openAboutOverlay(options = {}) {
   if (!aboutOverlay) return;
   applyTendenConfig();
   aboutOverlay.classList.remove('hidden');
   setTimeout(() => aboutOverlay.classList.add('active'), 10);
   if (options.closeDock && typeof window.closeDockSub === 'function') window.closeDockSub();
   btnAboutClose?.focus();
 }

 function closeAboutOverlay() {
   if (!aboutOverlay) return;
   aboutOverlay.classList.remove('active');
   setTimeout(() => aboutOverlay.classList.add('hidden'), 300);
 }

 btnOpenAbout?.addEventListener('click', () => openAboutOverlay({ closeDock: true }));
 btnAboutClose?.addEventListener('click', closeAboutOverlay);
 aboutOverlay?.addEventListener('click', (e) => {
   if (e.target === aboutOverlay) closeAboutOverlay();
 });
 document.getElementById('btn-about-view-tos')?.addEventListener('click', () => {
   closeAboutOverlay();
   setTimeout(() => { if (typeof showTosGateReadOnly === 'function') showTosGateReadOnly(); }, 260);
 });
 document.getElementById('btn-about-view-privacy')?.addEventListener('click', () => {
   closeAboutOverlay();
   setTimeout(() => { if (typeof openPrivacyPolicyOverlay === 'function') openPrivacyPolicyOverlay(); }, 260);
 });

 // Initialize Lang Select
 const savedLang = localStorage.getItem('tenden-lang') || 'auto';
 if (langSelect) langSelect.value = savedLang;

 langSelect?.addEventListener('change', (e) => {
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

 btnClearCache?.addEventListener('click', async () => {
 const dict = i18nDict[getLanguageCode()] || i18nDict['ja'] || {};
 if ('caches' in window) {
 const keys = await caches.keys();
 for (let key of keys) {
 await caches.delete(key);
 }
  triggerDynamicIsland(dict.alertCacheTitle || "Cache Cleared", "success");
 }
 });

 btnScreenshot?.addEventListener('click', () => {
 takeScreenshot();
 });

 // PWAオフラインモードトグル
 const pwaOfflineToggle = document.getElementById('pwa-offline-toggle');
 if (pwaOfflineToggle) {
   const _pwaOn = localStorage.getItem('tenden-pwa-enabled') === '1';
   pwaOfflineToggle.checked = _pwaOn;
   const _statusEl = document.getElementById('pwa-toggle-status');
   if (_statusEl) _statusEl.textContent = _pwaOn ? 'オフラインモード：ON（保存済み範囲のみ）' : 'オフラインモード：OFF（自動更新あり）';
   pwaOfflineToggle.addEventListener('change', () => {
     const enabling = pwaOfflineToggle.checked;
     localStorage.setItem('tenden-pwa-enabled', enabling ? '1' : '0');
     const statusEl = document.getElementById('pwa-toggle-status');
     if (statusEl) statusEl.textContent = enabling ? 'オフラインモード：ON（保存済み範囲のみ）' : 'オフラインモード：OFF（自動更新あり）';
     if (enabling) {
       if (confirm('オフライン緊急モードを有効にします。\n\n事前に閲覧した地図タイルやアプリ本体はキャッシュされ、通信がなくても表示できます。\nただし、経路探索(OSRM)・標高取得・地震/津波速報(P2P)等は通信断時に利用できません。保存済みの情報が古くなる場合もあります。\nオンラインに戻るとアプリ本体を更新します。\n\n有効にしますか？')) {
         location.reload();
       } else {
         pwaOfflineToggle.checked = false;
         localStorage.setItem('tenden-pwa-enabled', '0');
         if (statusEl) statusEl.textContent = 'オフラインモード：OFF（自動更新あり）';
       }
     } else {
       navigator.serviceWorker && navigator.serviceWorker.getRegistrations().then(rs => rs.forEach(r => r.unregister()));
       caches.keys && caches.keys().then(keys => keys.forEach(k => caches.delete(k)));
     }
   });
 }

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

 // Evacuation panel: primary CTA focuses the map on the active route
 const btnEvacPrimary = document.getElementById('btn-evac-primary');
 if (btnEvacPrimary) {
 btnEvacPrimary.addEventListener('click', () => {
 if (mainRouteLine) {
 map.fitBounds(mainRouteLine.getBounds(), {
 paddingTopLeft: [20, 80],
 paddingBottomRight: [20, 150],
 animate: true,
 duration: 0.8
 });
 }
 triggerHapticTick();
 });
 }

 // 事前避難体験（追体験）プレイバックの入口と操作
 document.getElementById('btn-evac-playback')?.addEventListener('click', () => {
   if (!currentLocation || !isEmergency) {
     triggerDynamicIsland('先に避難開始地点（ピン）を設定してください。', 'warning');
     triggerHapticTick();
     return;
   }
   pendingEvacPlayback = true;
   triggerHapticTick();
   const hasRoutes = (activeRoutesList || []).some(function (r) { return r && r.waypoints && r.waypoints.length > 0; });
   if (hasRoutes) {
     // 計算済みでもユーザー自身に選ばせる（AIルートの自動適用・自動再生はしない）
     try { showRouteSelectorHUD(activeRoutesList); } catch (e) {}
     triggerDynamicIsland('避難ルートを選んでから再生を開始します', 'info');
     return;
   }
   triggerDynamicIsland('ルートを計算中…', 'info');
   recalculateRouteFromLocation(currentLocation).catch(function () {
     pendingEvacPlayback = false;
     triggerDynamicIsland('ルート計算に失敗しました。', 'error');
   });
 });
 document.getElementById('ep-play')?.addEventListener('click', () => {
   if (!_ep) return;
   if (_ep.playing) _epPause(); else _epPlay();
 });
 document.getElementById('ep-scrub')?.addEventListener('input', (e) => {
   if (!_ep) return;
   _epPause();
   _epRender((parseInt(e.target.value, 10) / 1000) * _ep.evacTotalSec);
 });
 document.getElementById('ep-close')?.addEventListener('click', () => stopEvacuationPlayback());
 // 最初に戻る（開始地点へ巻き戻して一時停止）
 document.getElementById('ep-restart')?.addEventListener('click', () => {
   if (!_ep) return;
   _epPause(); _ep.lastBucket = -1; _ep.lastInfoKey = null; _epRender(0);
   try { triggerHapticTick(); } catch (e) {}
 });
 // 視点を戻す（自分でドラッグ/ズームして外した追従カメラを、再生中の自分の位置へ戻す）
 document.getElementById('ep-recenter')?.addEventListener('click', () => {
   if (!_ep) return;
   _ep.followCam = true;
   try { map.panTo(_ep.lastLL, { animate: true, duration: 0.4 }); } catch (e) {}
   document.getElementById('ep-recenter')?.classList.add('hidden');
   try { triggerHapticTick(); } catch (e) {}
 });
 // ルート変更（予習を閉じてルート選択へ戻る）
 document.getElementById('ep-change-route')?.addEventListener('click', () => {
   const rl = activeRoutesList;
   stopEvacuationPlayback();
   try { if (typeof showRouteSelectorHUD === 'function' && rl) showRouteSelectorHUD(rl); } catch (e) {}
   try { triggerHapticTick(); } catch (e) {}
 });
 document.getElementById('ep-branch-highland')?.addEventListener('click', () => { _epChooseBranch('highland'); triggerHapticTick(); });
 document.getElementById('ep-branch-shelter')?.addEventListener('click', () => { _epChooseBranch('shelter'); triggerHapticTick(); });

 // Evacuation panel: "その他の操作" springs open the secondary action menu
 const btnPanelMoreToggle = document.getElementById('btn-panel-more-toggle');
 const panelMoreMenu = document.getElementById('panel-more-menu');
 if (btnPanelMoreToggle && panelMoreMenu) {
 btnPanelMoreToggle.addEventListener('click', () => {
 const expanded = panelMoreMenu.classList.toggle('expanded');
 btnPanelMoreToggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
 triggerHapticTick();
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

 if (typeof initTendenAgent === 'function') initTendenAgent();
 initSafeZoneGuide();
 }

 // This status updater is used by both initUI-local code and global polling/state
 // routines, so it must remain in the application scope rather than initUI scope.
 function updateHudTimeWarning() {
  const wrap = document.getElementById('status-time-wrap');
  if (!wrap) return;
  const dict = i18nDict[getLanguageCode()] || i18nDict['ja'] || {};
  const p2pDot = document.getElementById('p2p-dot');
  const p2pAlert = p2pDot && p2pDot.classList.contains('p2p-alert');
  let level = 'safe';
  let ariaKey = 'hudTimeAriaSafe';
  if (isEmergency) {
   level = 'emergency';
   ariaKey = 'hudTimeAriaEmergency';
  } else if (_hudTsunamiKind === 'danger' || lastTsunamiIsInundated === true) {
   level = 'danger';
   ariaKey = 'hudTimeAriaDanger';
  } else if (_hudTsunamiKind === 'watch' || p2pAlert) {
   level = 'watch';
   ariaKey = 'hudTimeAriaWatch';
  }
  wrap.classList.remove('hud-time--watch', 'hud-time--danger', 'hud-time--emergency');
  if (level !== 'safe') wrap.classList.add('hud-time--' + level);
  if (dict[ariaKey]) wrap.setAttribute('aria-label', dict[ariaKey]);
 }

 // Wire the six primary dock categories separately from initUI. This keeps the
 // main navigation usable even when an optional control is absent in an older
 // cached HTML document.
 function initDockTrunks() {
  const root = document.documentElement;
  if (root.dataset.dockTrunksWired === '1') return;
  root.dataset.dockTrunksWired = '1';
  const subSheet = document.getElementById('dock-sub-sheet');
  const subTitle = document.getElementById('dock-sub-title');
  const trunkItems = document.querySelectorAll('.trunk-item');
  const trunkTitleKeys = { evac: 'trunkEvac', quake: 'trunkQuake', map: 'trunkMap', community: 'trunkCommunityTitle', learn: 'trunkLearn', more: 'trunkMore' };
  let activeTrunk = null;

  function closeDockSub() {
   subSheet?.classList.add('hidden');
   subSheet?.setAttribute('aria-hidden', 'true');
   trunkItems.forEach(t => {
    t.classList.remove('active');
    t.setAttribute('aria-expanded', 'false');
   });
   document.querySelectorAll('.dock-sub-panel').forEach(p => { p.hidden = true; });
   activeTrunk = null;
  }

  function openDockSub(trunkId) {
   if (activeTrunk === trunkId) { closeDockSub(); return; }
   activeTrunk = trunkId;
   trunkItems.forEach(t => {
    const isActive = t.dataset.trunk === trunkId;
    t.classList.toggle('active', isActive);
    t.setAttribute('aria-expanded', isActive ? 'true' : 'false');
   });
   document.querySelectorAll('.dock-sub-panel').forEach(p => {
    p.hidden = p.dataset.trunk !== trunkId;
   });
   const key = trunkTitleKeys[trunkId];
   if (subTitle && key) {
    subTitle.setAttribute('data-i18n', key);
    const lang = typeof getLanguageCode === 'function' ? getLanguageCode() : 'ja';
    const dict = i18nDict[lang] || i18nDict.ja;
    const trunkLabel = document.querySelector(`.trunk-item[data-trunk="${trunkId}"] .trunk-label`);
    if (dict?.[key]) subTitle.textContent = dict[key];
    else if (trunkLabel) subTitle.textContent = trunkLabel.textContent;
   }
   subSheet?.classList.remove('hidden');
   subSheet?.setAttribute('aria-hidden', 'false');
   if (subSheet) {
    subSheet.classList.add('dock-sub-guard');
    clearTimeout(subSheet._guardTimer);
    subSheet._guardTimer = setTimeout(() => subSheet.classList.remove('dock-sub-guard'), 450);
   }
  }

  trunkItems.forEach(trunk => {
   trunk.addEventListener('click', e => {
    e.stopPropagation();
    openDockSub(trunk.dataset.trunk);
   });
  });
  document.getElementById('dock-sub-close')?.addEventListener('click', closeDockSub);
  document.querySelectorAll('.dock-sub-panel .dock-item').forEach(item => {
   item.addEventListener('click', () => {
    if (item.classList.contains('dock-toggle-p2p') || item.classList.contains('dock-toggle-hazard')) return;
    if (item.dataset.trigger === 'btn-coastline-dist') return;
    setTimeout(closeDockSub, 80);
   });
  });
  document.addEventListener('click', e => {
   if (activeTrunk && !e.target.closest('.bottom-dock-wrap')) {
    if (_coastDistActive && activeTrunk === 'map') return;
    closeDockSub();
   }
  });
  window.closeDockSub = closeDockSub;
 }


 // ── 位置情報許可の前に説明ポップアップを表示 ─────────────────────────────────
 function showLocationExplanation(callback) {
   // 一度説明済みなら直接許可ダイアログへ
   var alreadyExplained = localStorage.getItem('tenden-location-explained') === 'true';
   if (alreadyExplained) {
     if (callback) callback();
     return;
   }
   var dict = i18nDict[getLanguageCode()] || i18nDict['ja'] || {};
   var title = dict.locationExplTitle || '位置情報について';
   var desc =
     (dict.locationExplReasons || '') +
     (dict.locationExplPrivacy || '') +
     (dict.locationExplFooter || '');
   var overlay = document.getElementById('alert-overlay');
   var dialogEl = overlay ? overlay.querySelector('.dialog') : null;
   if (dialogEl) dialogEl.classList.add('dialog-compact');
   showCustomAlert(title, desc, 'info', function() {
     if (dialogEl) dialogEl.classList.remove('dialog-compact');
     try { localStorage.setItem('tenden-location-explained', 'true'); } catch(e) {}
     if (callback) setTimeout(function() { if (callback) callback(); }, 200);
   });
 }

 function requestLocation() {
 if ("geolocation" in navigator) {
 const dict = i18nDict[getLanguageCode()] || i18nDict['ja'] || {};
 if (typeof setAgentForFeature === 'function') setAgentForFeature('location-fetch', dict.fetchingLocationLabel || '現在地を取得中...', { revertTo: 'default', revertMs: 15000 });
 else if (typeof setAgentState === 'function') setAgentState('listening', dict.fetchingLocationLabel || '現在地を取得中...', { revertTo: 'idle', revertMs: 15000 });
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
 if (typeof position.coords.heading === 'number' && !isNaN(position.coords.heading) && position.coords.heading >= 0) {
   gpsMovementHeading = position.coords.heading;
 }
  currentLocation = {
  lat: position.coords.latitude,
  lng: position.coords.longitude
  };
  const mapReady = isLeafletMapReady();
  if (mapReady) {
  map.setView([currentLocation.lat, currentLocation.lng], 16);
  updateMarker(currentLocation);
  } else {
  console.warn('[TENDEN] Location acquired before the map library became available.');
  }
  fetchElevation(currentLocation);
  triggerLocationTsunamiCheck(currentLocation);
  if (mapReady) generalizeFirstTargets(currentLocation);
 
 const dict = i18nDict[getLanguageCode()] || i18nDict['ja'] || {};
 if (typeof setAgentForFeature === 'function') setAgentForFeature('location-synced', dict.locationAcquiredLabel || '現在地を同期しました', { revertTo: 'default', revertMs: 3500 });
 else if (typeof setAgentState === 'function') setAgentState('celebrate', dict.locationAcquiredLabel || '現在地を同期しました', { revertTo: 'idle', revertMs: 3500 });
 triggerDynamicIsland(dict.locationAcquiredLabel || " 現在地を同期しました", "success");

 // 初回のみ海岸線距離をポップアップで表示
 if (!window._coastlineShownOnce) {
   window._coastlineShownOnce = true;
   updateCoastDistBar(currentLocation);
 }

 // Track location changes
 navigator.geolocation.watchPosition(pos => {
 updateGPSAccuracyHUD(pos.coords.accuracy);
 if (typeof pos.coords.heading === 'number' && !isNaN(pos.coords.heading) && pos.coords.heading >= 0) {
   gpsMovementHeading = pos.coords.heading;
   if (!isManualLocation && !_ep) applyCompassDisplay();
 }
 if (!isManualLocation) {
  currentLocation = {
  lat: pos.coords.latitude,
  lng: pos.coords.longitude
  };
  const locationMapReady = isLeafletMapReady();
  if (locationMapReady) updateMarker(currentLocation);
  triggerLocationTsunamiCheck(currentLocation);
  if (locationMapReady) generalizeFirstTargets(currentLocation);
 updateCoastDistBar(currentLocation);
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
 // 予習再生中は仮想歩行者(ep-walker)のみ表示。現在地ピンは非表示のまま。
 if (document.body.classList.contains('ep-mode')) return;
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

 recordLocationForCompass(loc);
 syncUserMarkerArrow();

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
 desc: "青い参考ルートに沿って、設定した候補地点（市役所付近）を確認してください。現地の指示を最優先にしてください",
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

 // Reflects isEmergency on the persistent UI shell (top-bar slot + agent)
 // without swapping layouts: same elements, different content/rhythm.
 function applyAppState(isEmergency) {
 if (typeof syncAgentEmergency === 'function') syncAgentEmergency(isEmergency);

 const elevDisplay = document.getElementById('elev-display');
 const etaDisplay = document.getElementById('eta-display');
 if (elevDisplay && etaDisplay) {
 elevDisplay.classList.toggle('hidden', isEmergency);
 etaDisplay.classList.toggle('hidden', !isEmergency);
 }
 const elevBadgeSlot = document.getElementById('elev-badge-slot');
 if (elevBadgeSlot) {
 const dict = i18nDict[getLanguageCode()] || i18nDict['ja'] || {};
 elevBadgeSlot.setAttribute('aria-label', isEmergency
   ? (dict.etaLabel || '津波到達までのモデル参考時間')
   : (dict.hudElevationAria || '現在地の海抜（標高）'));
 }

 // Emergency mode: highlight the coastline-distance FAB inside the "more" menu
 const fabCoastline = document.getElementById('fab-coastline-container');
 if (fabCoastline) {
 fabCoastline.classList.toggle('fab-highlight', isEmergency);
 }

 // Let the bottom sheet rubber-stretch to make room for the evacuation panel
 const bottomSheet = document.getElementById('main-bottom-sheet');
 if (bottomSheet) {
 bottomSheet.classList.toggle('panel-expanded', isEmergency);
 }
 updateHudTimeWarning();
 }

 function triggerEmergencyMode(isTest = false, scenarioId = 1, locationId = 'a') {
 isEmergency = true;
 isWaitingForPinDrop = false;
 isEvacuationCompleted = false; // Reset completed status
 activeScenarioId = scenarioId;
 activeLocationId = locationId;
 emergencyStartTimeMs = Date.now();
 loadCongestionTimeseries(); // 緊急モード中のみ時系列混雑データを遅延ロード
 loadAiPolicy();             // 強化学習ルート用の方策データを先読み
 loadAccessiblePolicy();     // 要配慮者ルート用の方策データを先読み
 if (!isTest) {
 document.body.classList.add('emergency-mode');
 }
 isDrillMode = isTest;
 // モード別ボタン表示：体験=予習(再生)のみ / 本番=ルートに従って進む
 const _btnPrimary = document.getElementById('btn-evac-primary');
 const _btnPlayback = document.getElementById('btn-evac-playback');
 if (_btnPrimary) _btnPrimary.classList.toggle('hidden', isTest);
 if (_btnPlayback) _btnPlayback.classList.toggle('hidden', !isTest);

 // スマホ特化機能の初期化
 requestWakeLock();
 requestNotificationPermission();
 // 動作・方向(コンパス)の許可は実際に進行方向が意味を持つ本番モードのみ求める。
 // 体験モード(予習・ピン設置)では不要なため、毎回許可を求めないようにする。
 // ただしモデル地区デモ中は仮想位置の方位表示のため許可を求める。
 if (!isTest || isModelAreaDemo) requestOrientationPermission();

 document.getElementById('bottom-normal-actions').classList.add('hidden');
 document.getElementById('btn-test-alert').classList.add('hidden');
 document.getElementById('evacuation-banner').classList.remove('hidden');
 document.body.classList.add('tenden-nav-active');
 document.getElementById('disaster-details').style.display = 'block';
 
 // Load scenario parameters
 const sc = SCENARIOS[scenarioId] || SCENARIOS[1];
 const scLoc = sc.locations[locationId] || sc.locations['a'];
 
 // Dynamically update banner content
 document.getElementById('i18n-evac-title').innerText = sc.title;
 document.getElementById('i18n-evac-desc').innerText = scLoc.desc;
 
 // disaster-details は HTML 固定文（「鎌倉には最短で8〜14分」）をそのまま使用

 // Switch the status orb to "alert" rhythm and morph the top-bar elevation slot into a time-to-arrival slot
 applyAppState(true);
 dismissSafeZoneGuide();
 // 津波到達までのカウントダウン（シナリオの予測到達時間から1秒ごとに減算）。
 // 静的な「15分」固定ではつじつまが合わないため、時系列で減らす。
 const etaMatch = sc.time.match(/^(\d+)分/);
 const tsunamiMin = etaMatch ? parseInt(etaMatch[1], 10) : 15;
 startTsunamiCountdown(tsunamiMin * 60);
 
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
 isDrillMode = true;
 isEvacuationCompleted = false;
 emergencyStartTimeMs = null;
 releaseWakeLock();
 // モード間が干渉しないよう、再生・各オーバーレイを必ず閉じてクリーンにする
 try { stopEvacuationPlayback(); } catch (e) {}
 try { hideRouteCalcLoading(); } catch (e) {}
 ['research-intro-overlay','real-mode-confirm','ep-branch-choice'].forEach(id => {
   const el = document.getElementById(id); if (el) { el.classList.remove('active'); el.classList.add('hidden'); }
 });
 isWaitingForPinDrop = false;
 document.getElementById('crosshair-target')?.classList.add('hidden');
 document.getElementById('btn-set-pin')?.classList.add('hidden');

 // Restore the agent calm state and the elevation slot
 applyAppState(false);
 updateSafeZoneGuideVisibility();

 // Close route selection modal if open
 const routeOverlay = document.getElementById('route-overlay');
 if (routeOverlay) {
 routeOverlay.classList.remove('active');
 routeOverlay.classList.add('hidden');
 }
 pendingRouteArgs = null;
 pendingEvacPlayback = false;
 activeSelectedRouteId = null;

 // Stop evacuation simulation interval
 if (simulationInterval) {
 clearInterval(simulationInterval);
 simulationInterval = null;
 }

 // Clear evacuation route layer
 if (routeLayerGroup) {
 routeLayerGroup.clearLayers();
 clearRouteDestinationHighlights();
 }

 // Remove emergency dark class
 document.body.classList.remove('emergency-mode');

 // Toggle UI visibility
 document.getElementById('bottom-normal-actions').classList.remove('hidden');
 document.getElementById('btn-test-alert').classList.remove('hidden');
 document.getElementById('btn-real-mode')?.classList.remove('hidden');
 document.getElementById('evacuation-banner').classList.add('hidden');
 document.body.classList.remove('tenden-nav-active');

 // Collapse the secondary action menu for the next evacuation
 const panelMoreMenu = document.getElementById('panel-more-menu');
 const btnPanelMoreToggle = document.getElementById('btn-panel-more-toggle');
 if (panelMoreMenu) panelMoreMenu.classList.remove('expanded');
 if (btnPanelMoreToggle) btnPanelMoreToggle.setAttribute('aria-expanded', 'false');

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
 clearRouteDestinationHighlights();

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
 const _routeCoreLine = L.polyline(waypoints, {
 color: '#ffffff', // High brightness white core for absolute neon aesthetics
 className: 'route-glow-core'
 }).addTo(routeLayerGroup);

 // Set custom route color custom property for dropping shadows dynamically in CSS!
 mainRouteLine.getElement().style.color = routeCandidate.color || '#00bbff';

 // [2026-06-20] ネットワークの直線エッジを実道路に沿わせる（オンライン時のみ）。
 //   ノードは実道路上(OSRMで0〜6m)なので、wpsをOSRMにスナップすると道路沿いの折れ線になる。
 //   失敗・オフライン時は直線のまま（フォールバック＝安全）。
 snapWaypointsToRoads(waypoints).then(snapped => {
   if (snapped && snapped.length > 1 && mainRouteLine && routeLayerGroup.hasLayer(mainRouteLine)) {
     mainRouteLine.setLatLngs(snapped);
     _routeCoreLine.setLatLngs(snapped);
   }
 }).catch(() => {});

 // [2026-06-21] ルート上の常設ラベルは廃止（道に重なり視認性を落とすため）。
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

 // ルートのノード列(直線)を実道路にスナップして道路沿いの折れ線を返す（オンライン時のみ）。
 //   ノードは実道路上なので、OSRM foot route に通すと道路に沿ったジオメトリが得られる。
 //   waypointが多い場合は均等間引き(最大24点)してOSRMの上限内に収める。失敗時は null。
 let _snapCache = {};
 async function snapWaypointsToRoads(wps) {
   // [2026-06-21] OSRMスナップを無効化（蛇行バグの原因）。
   //   公開OSRMに「間引いた最大24点を順に経由せよ」と要求すると、各点を必須経由地として
   //   大きく迂回し、実測でAIルート約560mが1285m(2.3倍)へ膨張、海岸沿いに大蛇行していた。
   //   方策ノードは元々実道路上にあり、生の経由点を直線で結ぶだけで道なりの折れ線になるため、
   //   スナップは不要かつ有害。raw waypoints をそのまま描画する（呼び出し側は null で生経路を維持）。
   return null;
   try {  // eslint-disable-line no-unreachable
     if (!wps || wps.length < 3) return null;
     // 均等間引き（先頭・末尾は必ず残す）
     const MAXN = 24;
     let pts = wps;
     if (wps.length > MAXN) {
       pts = [];
       const step = (wps.length - 1) / (MAXN - 1);
       for (let i = 0; i < MAXN; i++) pts.push(wps[Math.round(i * step)]);
     }
     const key = pts.map(p => p[0].toFixed(5) + ',' + p[1].toFixed(5)).join(';');
     if (_snapCache[key]) return _snapCache[key];
     const coords = pts.map(p => `${p[1]},${p[0]}`).join(';');  // OSRMは lon,lat
     const url = `https://router.project-osrm.org/route/v1/foot/${coords}?overview=full&geometries=geojson`;
     const ctrl = new AbortController();
     const tid = setTimeout(() => ctrl.abort(), 6000);
     const res = await fetch(url, { signal: ctrl.signal });
     clearTimeout(tid);
     if (!res.ok) return null;
     const data = await res.json();
     const g = data && data.routes && data.routes[0] && data.routes[0].geometry;
     if (!g || !g.coordinates || g.coordinates.length < 2) return null;
     const snapped = g.coordinates.map(c => [c[1], c[0]]);  // geojson lon,lat → lat,lon
     _snapCache[key] = snapped;
     return snapped;
   } catch (e) {
     return null;  // オフライン・失敗時は直線のまま
   }
 }

 function _coordsNearMarker(ll, dest, thresholdM) {
  if (!dest || dest.lat == null || dest.lng == null) return false;
  try {
   return L.latLng(ll.lat, ll.lng).distanceTo(L.latLng(dest.lat, dest.lng)) < (thresholdM || 45);
  } catch (e) { return false; }
 }

 function clearRouteDestinationHighlights() {
  if (!sheltersLayerGroup) return;
  sheltersLayerGroup.eachLayer(function (marker) {
   const el = marker.getElement && marker.getElement();
   if (el) {
    el.classList.remove('shelter-marker-destination', 'shelter-marker-destination-primary', 'shelter-marker-destination-secondary');
   }
   if (marker.setZIndexOffset) marker.setZIndexOffset(0);
  });
 }

 function updateRouteDestinationHighlights(primaryDest, secondaryDest) {
  clearRouteDestinationHighlights();
  if (!sheltersLayerGroup) return;
  sheltersLayerGroup.eachLayer(function (marker) {
   const ll = marker.getLatLng();
   const el = marker.getElement && marker.getElement();
   if (!el) return;
   let role = null;
   if (_coordsNearMarker(ll, secondaryDest)) role = 'secondary';
   else if (_coordsNearMarker(ll, primaryDest)) role = 'primary';
   if (!role) return;
   el.classList.add('shelter-marker-destination');
   el.classList.add(role === 'secondary' ? 'shelter-marker-destination-secondary' : 'shelter-marker-destination-primary');
   if (marker.setZIndexOffset) marker.setZIndexOffset(850);
  });
 }

 function drawMultipleEvacuationRoutes(startLoc, targetEdge, secondaryRoute, candidates, selectedId) {
 routeLayerGroup.clearLayers();
 clearRouteDestinationHighlights();
 activeRoutesList = candidates;
 // selectedId === undefined: 既存の activeSelectedRouteId を維持
 // selectedId === null: 未選択（選択UI表示時・自動ハイライトなし）
 // それ以外: 明示的なルート ID
 if (selectedId !== undefined) activeSelectedRouteId = selectedId;
 // targetEdge をキャッシュ
 if (targetEdge) window._cachedTargetEdge = targetEdge;

 candidates.forEach(candidate => {
 const isSelected = activeSelectedRouteId != null && candidate.id === activeSelectedRouteId;
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

 const _coreLine = L.polyline(waypoints, {
 color: '#ffffff', // bright center core
 className: 'route-glow-core'
 }).addTo(routeLayerGroup);

 // Set route color property dynamically
 try { var el=pline.getElement(); if(el) el.style.setProperty("--route-color",color); } catch(e) {}

 // [2026-06-20] 直線エッジを実道路に沿わせる（オンライン時のみ・失敗時は直線のまま）
 snapWaypointsToRoads(waypoints).then(snapped => {
   if (snapped && snapped.length > 1 && routeLayerGroup.hasLayer(pline)) {
     pline.setLatLngs(snapped);
     if (routeLayerGroup.hasLayer(_coreLine)) _coreLine.setLatLngs(snapped);
   }
 }).catch(() => {});
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
 // [2026-06-21] ルート上に常設のラベル（強化学習ルート等）を置くのをやめた。
 //   道の上に重なって視認性を落とすため。選択した旨は selectEvacuationRoute() 側で
 //   showAgentBubble() の一時トースト（約4.5秒で自動的に消える）に一本化。

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
 className: 'route-dest-label',
 html: `
 <div style="display:flex; flex-direction:column; align-items:center;">
 <div style="background:#0071e3; color:white; font-size:0.72rem; font-weight:700; padding:4px 10px; border-radius:10px; box-shadow:0 3px 8px rgba(0,113,227,0.5); white-space:nowrap; margin-bottom:4px;">
 ${primaryGoalLabel} → ${edgeName || ""}
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
 // 分岐点はテキストでなく一目で分かる小さなマーク（道が分かれます画面のフォークアイコンとは
 // 別の見た目にし、『ルート変更』ボタンとの混同を避ける）。
 const branchIcon = L.divIcon({
 className: 'route-branch-marker',
 html: `<div style="width:22px;height:22px;border-radius:50%;background:#ff9500;border:2.5px solid #fff;box-shadow:0 2px 6px rgba(255,149,0,0.5);display:flex;align-items:center;justify-content:center;" title="${branchToShelterLabel}"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="2"/><path d="M12 2v6M5 20l5.5-6M19 20l-5.5-6"/></svg></div>`,
 iconSize: [22, 22],
 iconAnchor: [11, 11]
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
 className: 'route-dest-label',
 html: `
 <div style="display:flex; flex-direction:column; align-items:center;">
 <div style="background:#ff9500; color:white; font-size:0.72rem; font-weight:700; padding:4px 10px; border-radius:10px; box-shadow:0 3px 8px rgba(255,149,0,0.5); white-space:nowrap; margin-bottom:4px;">
 ${secondaryGoalLabel} → ${localizedShelterName || ""}
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

  // [2026-06-21] ここに「第二ルート（避難所への分岐）」を描く重複ブロックがあったが削除。
  //   forEach内(isSelected時)の「SECONDARY ROUTE」ブロックと完全に同じ内容(分岐線+避難所ラベル)を
  //   二重に描いており、ラベル同士が重なって避難所アイコンが見えなくなる不具合の原因だった。

  // 選択中ルートの目的地に対応する避難所ピンをハイライト（第一目標=青 / 第二目標=橙）
  try {
   const selCandidate = candidates.find(function (c) { return c && c.id === activeSelectedRouteId; });
   if (selCandidate) {
    const primaryDest = (selCandidate.goal) ? selCandidate.goal : targetEdge;
    const secondaryDest = (secondaryRoute && secondaryRoute.target) ? secondaryRoute.target : null;
    updateRouteDestinationHighlights(primaryDest, secondaryDest);
   } else {
    clearRouteDestinationHighlights();
   }
  } catch (e) {}

 }

 async function selectEvacuationRoute(routeId) {
 if (!currentLocation) return;
 console.log('[TENDEN] selectEvacuationRoute called:', routeId);
 
 // Stop current evacuation simulation interval
 if (simulationInterval) {
 clearInterval(simulationInterval);
 simulationInterval = null;
 }

 // キャッシュ済みのターゲットを使う（AIルートは自身の到達高台をゴールにする）
  const _selForTarget = (activeRoutesList || []).find(r => r && r.id === routeId);
  const targetEdge = (_selForTarget && _selForTarget.goal)
    ? { id: 'ai-goal', name: _selForTarget.goal.name, lat: _selForTarget.goal.lat, lng: _selForTarget.goal.lng }
    : (window._cachedTargetEdge || activeSafeEdge || { id: 'fallback', name: '御成小学校（高台）', lat: 35.3190, lng: 139.5510 });

  activeSelectedRouteId = routeId;
 
 // Redraw multiple routes with new active selection
 try { drawMultipleEvacuationRoutes(currentLocation, targetEdge, activeSecondaryRoute, activeRoutesList, activeSelectedRouteId); } catch(e) { console.error("[route draw]", e); }
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

 // 予習再生待ち: 選択後にプレイバック開始（simulateEvacuation はスキップ）
 if (pendingEvacPlayback) {
   pendingEvacPlayback = false;
   hideRouteSelectorHUD();
   if (selectedRoute && selectedRoute.waypoints && selectedRoute.waypoints.length > 1) {
     startEvacuationPlayback(selectedRoute);
   }
   return;
 }

 // Restart simulation along new selected path
 try { simulateEvacuation(); } catch(e) {}

 // 選択したルートが地図上に見えるように fitBounds
 const selRoute = activeRoutesList.find(function(r){ return r && r.id === routeId; });
 if (selRoute && selRoute.waypoints && selRoute.waypoints.length > 0) {
   try {
     var pts = selRoute.waypoints.map(function(wp){ return L.latLng(wp[0], wp[1]); });
     if (currentLocation) pts.push(L.latLng(currentLocation.lat, currentLocation.lng));
     var bounds = L.latLngBounds(pts);
     setTimeout(function(){
       map.fitBounds(bounds, { padding: [80, 80], maxZoom: 16, animate: true, duration: 0.8 });
     }, 100);
   } catch(e) {}
 }

 // HUDを閉じる（地図が見える状態に）
 // ルート選択後すぐにHUDを閉じて地図でルートを確認
 hideRouteSelectorHUD();
 }

 function getAutoBestRouteId(candidates) {
 // 学習済みAIモデル推奨ルートを最優先
 if (candidates.some(c => c.id === 'AI')) return 'AI';
 // Fallback: 迂回が必要なら混雑回避(B)、それ以外は先頭/最短
 if (candidates.some(c => c.id === 'B' && c.blockedPoint)) return 'B';
 return candidates[0] ? candidates[0].id : 'A';
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

 container.querySelectorAll('.route-option-btn').forEach(btn => {
 const btnId = btn.getAttribute('data-route-id');
 const isHero = btn.classList.contains('ai-route-btn')
   || btn.classList.contains('acc-route-btn')
   || btn.classList.contains('short-route-btn')
   || btn.classList.contains('avoid-route-btn');
 if (isHero) {
   btn.classList.toggle('active', btnId === selectedId);
   return;
 }
 if (!btn.classList.contains('compact-route-btn')) return;
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


 // 直線フォールバックルートを生成（全APIが失敗した場合のみ使用）
 function buildDirectFallbackRoute(startLoc) {
   if (!startLoc) return null;
   const goal = window._cachedTargetEdge || { lat: 35.3190, lng: 139.5510, name: '御成小学校（高台）' };
   // 中間点を1つ作って3点のルートにする
   const midLat = (startLoc.lat + goal.lat) / 2;
   const midLng = (startLoc.lng + goal.lng) / 2;
   const dist = L.latLng(startLoc.lat, startLoc.lng).distanceTo(L.latLng(goal.lat, goal.lng));
   const speed = typeof getEvacuationSpeed === 'function' ? getEvacuationSpeed() : 1.2;
   return {
     id: 'A',
     label: '最短ルート（推定）',
     color: '#0071e3',
     waypoints: [[startLoc.lat, startLoc.lng], [midLat, midLng], [goal.lat, goal.lng]],
     distance_m: Math.round(dist),
     estimated_min: Math.max(1, Math.round(dist / (speed * 60))),
     characteristics: `${goal.name || '安全な高台'}へ向かう推定ルートです。`,
     congestion_score: 'low',
     isOSRM: false,
     isFallback: true
   };
 }

 // ─────────────────────────────────────────────────────────────────────
 // AIモデル推奨ルート（学習済み強化学習モデルの方策ベクトル場を辿る）
 //   assets/ai_evac_policy.json: 鎌倉モデル地区の全ノードについて、学習済み
 //   Q学習モデル（線形関数近似・7次元特徴量・生存率74%）が選ぶ「次の一手」を
 //   事前計算したもの。ユーザー現在地→最近傍ノード→next[]を安全ノードまで辿る
 //   ことで、モデルが提案する避難経路を再構築する。
 // ─────────────────────────────────────────────────────────────────────
 function loadAiPolicy() {
   if (aiPolicyData) return Promise.resolve(aiPolicyData);
   if (aiPolicyLoading) return aiPolicyLoading;
   aiPolicyLoading = fetch('assets/ai_evac_policy.json')
     .then(res => res.json())
     .then(data => {
       aiPolicyData = data;
       console.log('[TENDEN] ai_evac_policy.json loaded:', data.count, 'nodes, survival', data.model_info && data.model_info.final_survival_rate);
       // 時間依存の混雑迂回override（任意・小さい。失敗しても基本場で動作）
       fetch('assets/ai_evac_policy_timeaware.json').then(r => r.json())
         .then(t => { aiTimeaware = t; console.log('[TENDEN] time-aware overrides:', t.model_info && t.model_info.total_overrides); })
         .catch(() => {});
       return data;
     })
     .catch(e => { console.warn('[TENDEN] ai_evac_policy load failed', e); aiPolicyLoading = null; return null; });
   return aiPolicyLoading;
 }

 // 分散避難（てんでんこ）レベル1：端末ごとに固定の擬似ランダム種を持ち、
 // 分岐ノードでは決定論的な単一最適経路ではなく上位候補から確率的に選ぶ。
 // 通信なしで端末ごとに独立サンプリングするだけで、人口全体としては
 // 集団追従（同じ道への集中）を避け自然に分散できる（てんでんこの考え方）。
 // 種は端末に保存し再計算のたびに同じ経路になるよう固定する（毎回変わると混乱するため）。
 function _getDeviceDisperseSeed() {
   try {
     let s = localStorage.getItem('tenden-disperse-seed');
     if (!s) {
       s = String((Math.random() * 4294967295) >>> 0);
       localStorage.setItem('tenden-disperse-seed', s);
     }
     return parseInt(s, 10) >>> 0;
   } catch (e) { return 1; }
 }
 function _mulberry32(seed) {
   let a = seed >>> 0;
   return function () {
     a |= 0; a = (a + 0x6D2B79F5) | 0;
     let t = Math.imul(a ^ (a >>> 15), 1 | a);
     t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
     return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
   };
 }
 // 分散方策場（d.disperse）があれば、現在ノードの上位候補から rng() に従って1つ選ぶ。
 // 該当データが無い・分岐がないノードは null を返し、呼び出し側は d.next[cur] を使う。
 function _sampleDispersedNext(d, cur, rng) {
   const disp = d.disperse;
   if (!disp) return null;
   const alt = disp.alt[String(cur)];
   const prob = disp.prob[String(cur)];
   if (!alt || !prob) return null;
   const r = rng();
   let acc = 0;
   for (let i = 0; i < alt.length; i++) {
     acc += prob[i];
     if (r < acc) return alt[i];
   }
   return alt[alt.length - 1];
 }

 function _nearestPolicyNode(lat, lng, d) {
   let best = -1, bestD = Infinity;
   const La = d.lat, Lo = d.lon, N = d.count;
   for (let i = 0; i < N; i++) {
     const dla = La[i] - lat, dlo = Lo[i] - lng;
     const dd = dla * dla + dlo * dlo;
     if (dd < bestD) { bestD = dd; best = i; }
   }
   return { idx: best, dist2: bestD };
 }

 // 学習済みモデルの方策に従って現在地から高台までの経路を構築して返す。
 // 返り値は他のルート候補と同じ形式のオブジェクト（id:'AI'）。失敗時 null。
 function computeAiRoute(loc) {
   const d = aiPolicyData;
   if (!d || !loc) return null;
   const near = _nearestPolicyNode(loc.lat, loc.lng, d);
   let cur = near.idx;
   if (cur < 0) return null;
   // 最近傍ノードが遠すぎる（モデル地区外）場合は提案しない（約1.2km超）
   if (near.dist2 > 0.00012) return null;
   // 既に安全な高台にいる場合
   if (d.safe[cur]) return { id: 'AI', alreadySafe: true };

   const speed = (typeof getEvacuationSpeed === 'function') ? getEvacuationSpeed() : 1.2;
   const wps = [[loc.lat, loc.lng]];
   const meta = [{ elev: null, arrival: -1, safe: false }];   // 追体験の注意点生成用
   const seen = new Set();
   let guard = 0, endIdx = cur, cumTime = 0;
   const ta = (aiTimeaware && aiTimeaware.overrides) ? aiTimeaware : null;
   // 端末固定の擬似ランダム種で初期化：同じ端末では毎回同じ経路になる（再計算で経路が
   // ぶれて混乱しないため）が、端末ごとには独立なので人口全体では分散する。
   const disperseRng = _mulberry32(_getDeviceDisperseSeed());
   while (cur !== -1 && cur !== undefined && !seen.has(cur) && guard < 3000) {
     seen.add(cur);
     wps.push([d.lat[cur], d.lon[cur]]);
     meta.push({ elev: d.elev[cur], arrival: (d.tsunami_arrival ? d.tsunami_arrival[cur] : -1), safe: !!d.safe[cur] });
     endIdx = cur;
     if (d.safe[cur]) break;
     const dispersed = _sampleDispersedNext(d, cur, disperseRng);
     let nx = (dispersed !== null) ? dispersed : d.next[cur];
     // 時間依存：その時刻にその近傍が実際に混雑する場合のみ迂回（過剰迂回を回避）
     if (ta) {
       const b = Math.floor(cumTime / (ta.bucket_seconds || 60));
       const bov = ta.overrides[b] || ta.overrides[String(b)];
       if (bov) {
         const alt = (bov[cur] !== undefined) ? bov[cur] : bov[String(cur)];
         if (alt !== undefined && alt >= 0) nx = alt;
       }
     }
     if (nx === undefined || nx < 0) break;
     // 累積到達時刻を更新（次エッジの所要時間を加算）
     cumTime += L.latLng(d.lat[cur], d.lon[cur]).distanceTo(L.latLng(d.lat[nx], d.lon[nx])) / Math.max(0.3, speed);
     cur = nx;
     guard++;
   }
   // 安全ノードに到達できなかった（到達不能ノード等）→ 提案しない
   if (!(endIdx >= 0 && d.safe[endIdx])) return null;
   if (wps.length < 2) return null;

   let dist = 0;
   for (let i = 1; i < wps.length; i++) {
     dist += L.latLng(wps[i - 1][0], wps[i - 1][1]).distanceTo(L.latLng(wps[i][0], wps[i][1]));
   }
   const est = Math.max(1, Math.round(dist / (speed * 60)));
   const goalElev = d.elev[endIdx];
   const dict = i18nDict[getLanguageCode()] || i18nDict['ja'] || {};
   // 切り捨て表示（100%への切り上げを避け、過大主張を防ぐ）。シミュレーション上の指標。
   const survival = d.model_info && d.model_info.final_survival_rate
     ? Math.min(99, Math.floor(d.model_info.final_survival_rate * 100)) : 99;
   return {
     id: 'AI',
     label: dict.routeAiLabel || '強化学習ルート',
     color: '#ff6b00',
     waypoints: wps,
     distance_m: Math.round(dist),
     estimated_min: est,
     characteristics: (dict.routeAiDesc || '事前計算した方策に基づく参考経路。現地の混雑・通行可能性・安全性は未確認')
       .replace('{rate}', survival),
     congestion_score: 'ai',
     isAI: true,
     survival: survival,
     meta: meta,
     goal: { lat: d.lat[endIdx], lng: d.lon[endIdx], elev: goalElev,
             name: (dict.routeAiGoal || '安全な高台（海抜{elev}m）').replace('{elev}', Math.round(goalElev)) }
   };
 }

 // 要配慮者向け学習済み方策（緩勾配優先）を遅延ロード
 function loadAccessiblePolicy() {
   if (aiAccessibleData) return Promise.resolve(aiAccessibleData);
   if (aiAccessibleLoading) return aiAccessibleLoading;
   aiAccessibleLoading = fetch('assets/ai_evac_policy_accessible.json')
     .then(res => res.json())
     .then(data => {
       aiAccessibleData = data;
       console.log('[TENDEN] accessible policy loaded:', data.count, 'nodes');
       return data;
     })
     .catch(e => { console.warn('[TENDEN] accessible policy load failed', e); aiAccessibleLoading = null; return null; });
   return aiAccessibleLoading;
 }

 // 要配慮者モデルの方策に従って現在地から高台までの経路を構築（id:'C'）。失敗時 null。
 function computeAccessibleRoute(loc) {
   const d = aiAccessibleData;
   if (!d || !loc) return null;
   const near = _nearestPolicyNode(loc.lat, loc.lng, d);
   let cur = near.idx;
   if (cur < 0 || near.dist2 > 0.00012) return null;
   if (d.safe[cur]) return { id: 'C', alreadySafe: true };

   const speed = (typeof getEvacuationSpeed === 'function') ? getEvacuationSpeed() : 1.2;
   const wps = [[loc.lat, loc.lng]];
   const meta = [{ elev: null, arrival: -1, safe: false }];
   const seen = new Set();
   let guard = 0, endIdx = cur;
   while (cur !== -1 && cur !== undefined && !seen.has(cur) && guard < 3000) {
     seen.add(cur);
     wps.push([d.lat[cur], d.lon[cur]]);
     meta.push({ elev: d.elev[cur], arrival: (d.tsunami_arrival ? d.tsunami_arrival[cur] : -1), safe: !!d.safe[cur] });
     endIdx = cur;
     if (d.safe[cur]) break;
     let nx = d.next[cur];
     if (nx === undefined || nx < 0) break;
     cur = nx; guard++;
   }
   if (!(endIdx >= 0 && d.safe[endIdx])) return null;
   if (wps.length < 2) return null;

   let dist = 0;
   for (let i = 1; i < wps.length; i++) {
     dist += L.latLng(wps[i - 1][0], wps[i - 1][1]).distanceTo(L.latLng(wps[i][0], wps[i][1]));
   }
   const est = Math.max(1, Math.round(dist / (speed * 60)));
   const goalElev = d.elev[endIdx];
   const dict = i18nDict[getLanguageCode()] || i18nDict['ja'] || {};
   return {
     id: 'C',
     label: dict.routeAccessibleLabel || '要配慮者ルート（緩やか）',
     color: '#5e5ce6',
     waypoints: wps,
     distance_m: Math.round(dist),
     estimated_min: est,
     characteristics: '急な坂や狭い道を避け、緩やかで通りやすい道を優先するよう最適化された要配慮者向けの経路',
     congestion_score: 'low',
     isAccessibleAI: true,
     meta: meta,
     goal: { lat: d.lat[endIdx], lng: d.lon[endIdx], elev: goalElev,
             name: '安全な高台（海抜' + Math.round(goalElev) + 'm）' }
   };
 }

 // ─────────────────────────────────────────────────────────────────────
 // 事前避難体験（追体験）プレイバック
 //   提示ルートを「歩いているかのように」タイムラプス再生し、各時刻・地点の
 //   注意点を提示する。実際に歩くのではなく、減災のための予習・追体験。
 // ─────────────────────────────────────────────────────────────────────
 let _ep = null;  // 再生状態
 let _epUserMarkerWasOnMap = false;  // 再生開始前に現在地ピンが地図上にあったか

 function _epFmt(sec) {
   sec = Math.max(0, Math.round(sec));
   const m = Math.floor(sec / 60), s = sec % 60;
   return m + ':' + String(s).padStart(2, '0');
 }

 // 各ウェイポイントの注意点を事前計算（標高・津波到達・海岸近接・終点）
 function _epBuildCautions(route) {
   const wps = route.waypoints, meta = route.meta || [];
   const n = wps.length;
   const cautions = new Array(n);
   for (let i = 0; i < n; i++) {
     const m = meta[i] || {};
     let level = 'safe', head = '移動中', body = 'ルートに沿って高台へ進みます。';
     if (i === 0) {
       level = 'danger'; head = '避難開始';
       body = '大津波警報。直ちに出発し、立ち止まらず高台を目指します。';
     } else if (m.safe) {
       level = 'safe'; head = '避難完了';
       body = '安全な高台に到達しました。海面の変化に注意し、警報解除まで待機してください。';
     } else if (typeof m.elev === 'number' && m.elev < 5) {
       level = 'danger'; head = '低地・浸水想定';
       body = '海抜' + Math.round(m.elev) + 'm の低い土地です。津波が早く到達します。速度を落とさず通過してください。';
     } else if (typeof m.elev === 'number' && m.elev < 10) {
       level = 'warning'; head = '上り坂・高台へ';
       body = '海抜' + Math.round(m.elev) + 'm。さらに高い場所へ。後ろを振り返らず進みます。';
     } else if (typeof m.elev === 'number') {
       level = 'safe'; head = '高台に接近';
       body = '海抜' + Math.round(m.elev) + 'm。安全圏が近づいています。';
     }
     cautions[i] = { level, head, body };
   }
   return cautions;
 }

 function startEvacuationPlayback(route) {
   if (!route || !route.waypoints || route.waypoints.length < 2 || !map) return;
   if (typeof setAgentForFeature === 'function') setAgentForFeature('evac-playback', undefined, { persist: true });
   stopEvacuationPlayback();

   try {
     if (currentLocation && routeLayerGroup && routeLayerGroup.getLayers().length === 0) {
       drawMultipleEvacuationRoutes(currentLocation, window._cachedTargetEdge, activeSecondaryRoute, activeRoutesList || [route], route.id || activeSelectedRouteId);
     }
   } catch (e) { console.warn('[TENDEN] playback route redraw:', e); }

   const wps = route.waypoints.map(w => [w[0], w[1]]);
   // 累積距離
   const cum = [0];
   for (let i = 1; i < wps.length; i++) {
     cum[i] = cum[i - 1] + L.latLng(wps[i - 1]).distanceTo(L.latLng(wps[i]));
   }
   const totalDist = cum[cum.length - 1];
   const speed = (typeof getEvacuationSpeed === 'function') ? getEvacuationSpeed() : 1.2;
   const evacTotalSec = totalDist / Math.max(0.4, speed);   // 避難に要する時間（時系列の総尺）
   const PLAYBACK_WALLCLOCK = Math.min(28, Math.max(14, evacTotalSec / 22)); // 再生は14〜28秒の要約

   const walkerIcon = L.divIcon({
     className: 'ep-walker-icon',
     html: '<div class="ep-walker"><div class="ep-walker-cone"></div><div class="ep-walker-dot"></div></div>',
     iconSize: [40, 40], iconAnchor: [20, 20]
   });
   const marker = L.marker(wps[0], { icon: walkerIcon, zIndexOffset: 2000, interactive: false }).addTo(routeLayerGroup);

   // 時系列混雑の可視化準備：エッジID→座標 のマップを構築し、専用レイヤーを用意
   const congGeom = {};
   try {
     if (congestionGeojsonData && congestionGeojsonData.features) {
       congestionGeojsonData.features.forEach(f => {
         const id = f.properties && f.properties.id;
         if (id && f.geometry && f.geometry.coordinates) {
           congGeom[id] = f.geometry.coordinates.map(c => [c[1], c[0]]); // [lng,lat]→[lat,lng]
         }
       });
     }
   } catch (e) {}
   if (typeof loadCongestionTimeseries === 'function') { try { loadCongestionTimeseries(); } catch (e) {} }
   // [2026-06-21] 再生中も「シミュレーションで実際に使った」ネットワーク混雑表示を消さない。
   //   以前は時刻別の表示と二重にしないため静的ヒートマップを退避していたが、これにより再生中に
   //   混雑表示が消えてしまうとの指摘があったため、常に表示したままにする（時刻別の強調表示は上に重ねる）。
   const staticCongWasOn = !!(congestionLayer && map.hasLayer(congestionLayer));
   const congLayer = L.layerGroup().addTo(map);
   const bubbleLayer = L.layerGroup().addTo(map);  // 混雑ポイントの吹き出し

   // 分岐点（高台 vs 避難所）の検出：第二ルート（避難所）が主ルートから分かれる地点を探す
   let branch = null;
   try {
     const sec = activeSecondaryRoute;
     if (sec && sec.waypoints && sec.waypoints.length > 1) {
       let bMain = -1, bSec = -1;
       for (let i = sec.waypoints.length - 1; i >= 0; i--) {
         const sp = L.latLng(sec.waypoints[i][0], sec.waypoints[i][1]);
         let minD = Infinity, minIdx = 0;
         for (let j = 0; j < wps.length; j++) {
           const d = sp.distanceTo(L.latLng(wps[j]));
           if (d < minD) { minD = d; minIdx = j; }
         }
         if (minD < 20.0) { bMain = minIdx; bSec = i; break; }
       }
       if (bMain >= 0 && bMain < wps.length - 1) {
         const branchDist = cum[bMain];
         // 避難所ルートに十分な残りがあり、分岐が終点付近でなければ「選べる分岐」とする
         // （AI高台ルートと避難所ルートは多くの場合スタート地点で分かれる→出発時に選択を提示）
         if (branchDist < totalDist - 25 && bSec < sec.waypoints.length - 1) {
           branch = {
             dist: branchDist, mainIdx: bMain,
             atStart: branchDist < 30,
             secWps: sec.waypoints.slice(bSec).map(w => [w[0], w[1]]),
             shelterName: (sec.target && sec.target.name) || '指定避難所',
             decided: false, prompting: false
           };
         }
       }
     }
   } catch (e) {}

   _ep = {
     route, wps, cum, totalDist, speed, evacTotalSec,
     wallclock: PLAYBACK_WALLCLOCK,
     cautions: _epBuildCautions(route),
     marker, congGeom, congLayer, bubbleLayer, staticCongWasOn, lastBucket: -1,
     congActive: [], lastInfoKey: null,
     branch,
     t: 0, playing: false, raf: null, lastTs: 0, lastCautionIdx: -1,
     followCam: true, lastLL: wps[0]
   };
   // Googleマップ風ナビ: 進行方向の矢印(前方ハイライト)＋目的地までの点線。
   //   混雑(赤/橙)と色が干渉しないよう、ナビ経路は青で統一する。
   try {
     const navColor = '#1a73e8';
     _ep.dottedLine = L.polyline([], { color: navColor, weight: 4, opacity: 0.6, dashArray: '1 11', lineCap: 'round' }).addTo(map);
     _ep.aheadCasing = L.polyline([], { color: '#ffffff', weight: 11, opacity: 0.95, lineCap: 'round', lineJoin: 'round' }).addTo(map);
     _ep.aheadLine = L.polyline([], { color: navColor, weight: 7, opacity: 1, lineCap: 'round', lineJoin: 'round' }).addTo(map);
   } catch (e) {}
   // 目的地の名前だけを、ピンを覆わない位置（上に少しオフセット）に表示。
   // 「第一目標／第二目標」のような表記はユーザーに不要なため出さない。必要最小限の名前のみ。
   _epUpdateDestLabel();
   try { document.getElementById('ep-branch-choice')?.classList.add('hidden'); } catch (e) {}
   try { document.getElementById('ep-cong-legend')?.classList.add('hidden'); } catch (e) {}

   // ルート選択シートが残っていれば閉じる（再生を遮らない）
   try { if (typeof hideRouteSelectorHUD === 'function') hideRouteSelectorHUD(); } catch (e) {}
   const rov = document.getElementById('route-overlay');
   if (rov) { rov.classList.remove('active'); rov.classList.add('hidden'); }

   const ov = document.getElementById('evac-playback');
   if (ov) ov.classList.remove('hidden');
   const total = document.getElementById('ep-total');
   if (total) total.textContent = _epFmt(evacTotalSec);
   // 再生中はボトムシート（緊急バナー）を隠してマップを広く
   document.body.classList.add('ep-mode');

   // 再生中は現在地ピン(userMarker)を隠す。仮想歩行者(ep-walker)のみ表示。
   _epUserMarkerWasOnMap = false;
   if (userMarker && map.hasLayer(userMarker)) {
     _epUserMarkerWasOnMap = true;
     if (popupTimeoutId) { clearTimeout(popupTimeoutId); popupTimeoutId = null; }
     try {
       if (userMarker.getPopup && userMarker.getPopup()) {
         userMarker.closePopup();
         userMarker.unbindPopup();
       }
     } catch (e) {}
     try { map.removeLayer(userMarker); } catch (e) {}
   }

   try { map.setView(wps[0], 16, { animate: true, duration: 0.6 }); } catch (e) {}
   // 自分中心の追従表示が既定だが、ユーザーが地図を自分でドラッグ/ズームしたら追従を解除し
   // 周囲を自由に確認できるようにする（「視点を戻す」ボタンで再追従）。
   // ※直前のsetViewによる自動移動を「ユーザー操作」と誤検知しないよう、setView完了後に登録する。
   setTimeout(() => {
     if (!_ep) return;
     _ep.onUserMapMove = () => {
       if (_ep && _ep.followCam) {
         _ep.followCam = false;
         document.getElementById('ep-recenter')?.classList.remove('hidden');
       }
     };
     map.on('dragstart', _ep.onUserMapMove);
     map.on('zoomstart', _ep.onUserMapMove);
   }, 700);
   // [2026-06-21] 予習中のコンパスは仮想の歩行者の進行方向を示すだけなので、
   //   実機の方位許可は不要（体験モードでは求めない）。本番モードのみ triggerEmergencyMode 側で要求する。
   _epRender(0);
   // スタート地点で高台/避難所が分かれる場合は、歩き出す前に行き先を選ばせる
   if (_ep.branch && _ep.branch.atStart && !_ep.branch.decided) {
     _ep.branch.prompting = true;
     _epShowBranch();
   } else {
     _epPlay();
   }
 }

 // 津波到達までのカウントダウン表示（上部バー）。1秒ごとに mm:ss で減算、0で「到達」。
 // 予習再生中は実時間ではなく再生の時系列(_ep.t)に同期させる（_epRenderが上書き）。
 let _tsunamiCdTimer = null;
 let _tsunamiTotalSec = 0;
 function _fmtTsunamiEta(rem) {
   const el = document.getElementById('eta-value');
   if (!el) return;
   if (rem <= 0) el.textContent = '到達';
   else { const m = Math.floor(rem / 60), s = Math.round(rem) % 60; el.textContent = m + ':' + String(s).padStart(2, '0'); }
 }
 function startTsunamiCountdown(totalSec) {
   _tsunamiTotalSec = totalSec;
   if (typeof setAgentForFeature === 'function') setAgentForFeature('tsunami-countdown', undefined, { persist: true });
   if (_tsunamiCdTimer) { clearInterval(_tsunamiCdTimer); _tsunamiCdTimer = null; }
   const end = Date.now() + totalSec * 1000;
   const el = document.getElementById('eta-value');
   function tick() {
     const rem = Math.max(0, Math.round((end - Date.now()) / 1000));
     if (el) {
       if (rem <= 0) el.textContent = '到達';
       else { const m = Math.floor(rem / 60), s = rem % 60; el.textContent = m + ':' + String(s).padStart(2, '0'); }
     }
     if (rem <= 0 && _tsunamiCdTimer) { clearInterval(_tsunamiCdTimer); _tsunamiCdTimer = null; }
   }
   tick();
   _tsunamiCdTimer = setInterval(tick, 1000);
 }

 // 目的地名のミニラベル（「第一目標／第二目標」等の表記はしない・ピンの直上を避けてオフセット表示）
 function _epUpdateDestLabel() {
   if (!_ep || !map) return;
   const name = _ep.chosenShelter && _ep.branch ? _ep.branch.shelterName
     : ((_ep.route && _ep.route.goal && _ep.route.goal.name) || '');
   const dest = _ep.wps[_ep.wps.length - 1];
   if (!name || !dest) return;
   if (_ep.destMarker) { try { map.removeLayer(_ep.destMarker); } catch (e) {} }
   const icon = L.divIcon({
     className: 'route-dest-mini',
     html: '<div class="route-dest-mini-pill">' + name + '</div>'
   });
   _ep.destMarker = L.marker(dest, { icon, zIndexOffset: 950, interactive: false }).addTo(map);
 }

 // 現在地(d0)から d1 までのルート上の点列（端点は補間）。ナビの矢印/点線描画用。
 function _epPath(d0, d1) {
   const { wps, cum } = _ep;
   const end = cum[cum.length - 1];
   d0 = Math.max(0, Math.min(end, d0)); d1 = Math.max(0, Math.min(end, d1));
   if (d1 <= d0) return [];
   const pts = [_epPosAt(d0).ll];
   for (let i = 1; i < cum.length; i++) { if (cum[i] > d0 && cum[i] < d1) pts.push(wps[i]); }
   pts.push(_epPosAt(d1).ll);
   return pts;
 }

 function _epPosAt(distMeters) {
   const { wps, cum } = _ep;
   if (distMeters <= 0) return { ll: wps[0], heading: 0, seg: 0 };
   if (distMeters >= cum[cum.length - 1]) return { ll: wps[wps.length - 1], heading: 0, seg: wps.length - 1 };
   let i = 1;
   while (i < cum.length && cum[i] < distMeters) i++;
   const segLen = cum[i] - cum[i - 1] || 1;
   const r = (distMeters - cum[i - 1]) / segLen;
   const a = wps[i - 1], b = wps[i];
   const ll = [a[0] + (b[0] - a[0]) * r, a[1] + (b[1] - a[1]) * r];
   const heading = (typeof turf !== 'undefined') ? turf.bearing(turf.point([a[1], a[0]]), turf.point([b[1], b[0]])) : 0;
   return { ll, heading, seg: i };
 }

 function _epRender(t) {
   if (!_ep) return;
   _ep.t = Math.max(0, Math.min(_ep.evacTotalSec, t));
   let dist = (_ep.t / _ep.evacTotalSec) * _ep.totalDist;
   // 分岐ゲート：未決定なら分岐点で歩行を止め、選択を促す
   if (_ep.branch && !_ep.branch.decided) {
     if (dist >= _ep.branch.dist) {
       dist = _ep.branch.dist;
       _ep.t = (dist / _ep.totalDist) * _ep.evacTotalSec;
       if (!_ep.branch.prompting) {
         _ep.branch.prompting = true;
         _epPause();
         _epShowBranch();
       }
     } else if (_ep.branch.prompting && dist < _ep.branch.dist - 1) {
       // 分岐手前まで巻き戻したら選択カードを引っ込める
       _ep.branch.prompting = false;
       document.getElementById('ep-branch-choice')?.classList.add('hidden');
     }
   }
   const { ll, heading, seg } = _epPosAt(dist);
   try { _ep.marker.setLatLng(ll); } catch (e) {}
   // ナビ誘導線：前方約50mを矢印(太線)、その先〜目的地を点線で描く
   try {
     const AHEAD = 50;
     const aheadPts = _epPath(dist, dist + AHEAD);
     if (_ep.aheadCasing) _ep.aheadCasing.setLatLngs(aheadPts);
     if (_ep.aheadLine) _ep.aheadLine.setLatLngs(aheadPts);
     if (_ep.dottedLine) _ep.dottedLine.setLatLngs(_epPath(dist + AHEAD, _ep.totalDist));
   } catch (e) {}
   // 進行方向コーンを回転
   try {
     const cone = _ep.marker.getElement()?.querySelector('.ep-walker-cone');
     if (cone) cone.style.transform = 'translate(-50%, -56%) rotate(' + heading + 'deg)';
   } catch (e) {}
   // 追従カメラ（中央維持）：ユーザーが手動でドラッグ/ズームした後は追従を止め、
   // 「視点を戻す」ボタンを押すまで自由に周囲を確認できるようにする。
   _ep.lastLL = ll;
   if (_ep.followCam) { try { map.panTo(ll, { animate: false }); } catch (e) {} }
   // コンパス：予習中は実機の向きでなく、仮想の歩行者(白丸＋矢印)が今向いている進行方向を示す。
   // 地図は北固定のため、歩行者アイコンのコーン回転と同じ heading をそのまま使う。
   try {
     const needle = document.querySelector('#ep-compass .ep-compass-needle');
     if (needle) needle.style.transform = 'rotate(' + heading + 'deg)';
   } catch (e) {}
   // スクラブ＆時刻
   const frac = _ep.t / _ep.evacTotalSec;
   const scrub = document.getElementById('ep-scrub');
   if (scrub && document.activeElement !== scrub) scrub.value = Math.round(frac * 1000);
   const tEl = document.getElementById('ep-time'); if (tEl) tEl.textContent = _epFmt(_ep.t);
   // 津波到達カウントダウンを再生の時系列(_ep.t)に同期（実時間タイマーは止める）
   if (_tsunamiTotalSec > 0) { if (_tsunamiCdTimer) { clearInterval(_tsunamiCdTimer); _tsunamiCdTimer = null; } _fmtTsunamiEta(_tsunamiTotalSec - _ep.t); }
   // ナビ情報：避難先まで残り距離・避難完了までの時間（Googleマップ風の実用表示）
   const navi = document.getElementById('ep-navinfo');
   if (navi) {
     navi.classList.remove('hidden');
     const remM = Math.max(0, _ep.totalDist - dist);
     const remT = Math.max(0, _ep.evacTotalSec - _ep.t);
     const dEl = document.getElementById('ep-nav-dist');
     if (dEl) dEl.textContent = remM >= 1000 ? (remM / 1000).toFixed(1) + ' km' : Math.round(remM) + ' m';
     const eEl = document.getElementById('ep-nav-eta');
     if (eEl) eEl.textContent = _epFmt(remT);
   }
   // 時系列混雑：現在時刻のバケットが変わったら混雑エッジを描き直す
   const ts = congestionTimeseriesData;
   let bucket = 0;
   if (ts && ts.edges && _ep.congLayer) {
     const bsec = ts.bucket_seconds || 60;
     bucket = Math.min((ts.num_buckets || 1) - 1, Math.floor(_ep.t / bsec));
     if (bucket !== _ep.lastBucket) {
       _ep.lastBucket = bucket;
       _epDrawCongestion(bucket);
     }
   }
   // 注意点パネル：踏んでいる道(セグメント)が変わるか、時刻(バケット)が進むたびに更新
   const ci = Math.min(seg, _ep.cautions.length - 1);
   const infoKey = ci + ':' + bucket;
   if (infoKey !== _ep.lastInfoKey) {
     _ep.lastInfoKey = infoKey;
     _epUpdateCautionPanel(ci, bucket, ll);
   }
 }

 // 定型ボード：フェーズ／その地点のメモ／今いる道の状況（情報を絞る）
 function _epUpdateCautionPanel(ci, bucket, ll) {
   if (!_ep) return;
   const c = _ep.cautions[ci]; if (!c) return;
   const here = L.latLng(ll[0], ll[1]);
   // 今いる道の混雑（最も近い混雑エッジが至近にあるか）
   let nearestD = Infinity, nearestDensity = 0;
   (_ep.congActive || []).forEach(e => {
     const d = here.distanceTo(L.latLng(e.mid[0], e.mid[1]));
     if (d < nearestD) { nearestD = d; nearestDensity = e.density; }
   });
   let hereStatus, hereClass;
   const dict = i18nDict[getLanguageCode()] || i18nDict['ja'] || {};
   if (nearestD <= 28 && nearestDensity >= 2.0) { hereStatus = dict.epNavCongHi || '激しい混雑'; hereClass = 'hi'; }
   else if (nearestD <= 28 && nearestDensity >= 0.8) { hereStatus = dict.epNavCongMid || 'やや混雑'; hereClass = 'mid'; }
   else { hereStatus = dict.epNavCongOk || '順調'; hereClass = 'ok'; }
   // シミュ由来の一言インサイト：この時刻の周辺混雑本数を実データで示し、AI分散の意義に結ぶ
   const congN = (_ep.congActive || []).length;
   let insight;
   if (hereClass === 'hi') insight = 'この道は人が集中しています。AIは混雑を避ける道を選び、端末ごとに経路を分散させています。';
   else if (hereClass === 'mid') insight = '少し混んできました。落ち着いて、AIが分散させた経路のまま進みましょう。';
   else if (congN > 0) insight = 'この時刻、周辺で約' + congN + '本の道が混雑。あなたの経路は混雑を避けています。';
   else insight = '周囲は順調です。立ち止まらず、まっすぐ高台へ。';
   const box = document.getElementById('ep-caution');
   if (box) {
     box.className = 'ep-caution board level-' + c.level;
     // 長文(c.body)は廃止し、フェーズ見出し＋青いインサイトの一言に集約（コンパクト化）
     box.innerHTML =
         '<div class="ep-board-phase"><span class="ep-dot"></span>' + c.head + '</div>'
       + '<div class="ep-board-insight">' + insight + '</div>';
   }
   // 今いる道の混雑は上部チップ(避難先まで○m の横)、現在地標高は(目的地まで約 の横)に表示
   const congEl = document.getElementById('ep-nav-cong');
   if (congEl) congEl.textContent = '・' + hereStatus;
   const elevEl = document.getElementById('ep-nav-elev');
   if (elevEl) {
     const mElev = ((_ep.route && _ep.route.meta && _ep.route.meta[ci]) || {}).elev;
     elevEl.textContent = (typeof mElev === 'number')
       ? (dict.epNavCurrentElev || '現在地 海抜{elev}m').replace('{elev}', Math.round(mElev))
       : '';
   }
   const ph = document.getElementById('ep-phase'); if (ph) ph.textContent = c.head;
   // [2026-06-21] 吹き出し提示を廃止。混雑はネットワークグラフ(道路エッジ)を時刻ごとに
   //   色分け描画する _epDrawCongestion に一本化（_epRenderのバケット更新で呼ばれる）。
 }

 // 地図に見えている混雑ポイントを吹き出し表示（最大3件・密度の高い順）
 function _epDrawBubbles(here) {
   if (!_ep || !_ep.bubbleLayer || !map) return;
   _ep.bubbleLayer.clearLayers();
   let bounds; try { bounds = map.getBounds().pad(-0.06); } catch (e) { return; }
   const cand = (_ep.congActive || [])
     .map(e => ({ e, ll: L.latLng(e.mid[0], e.mid[1]), d: here.distanceTo(L.latLng(e.mid[0], e.mid[1])) }))
     .filter(x => x.d > 18 && bounds.contains(x.ll))   // 画面内・足元すぐは除く
     .sort((a, b) => b.e.density - a.e.density);
   // 近接する吹き出しを間引き（80m以内は重複とみなす）、密度の高い順に最大3件
   const picked = [];
   for (const x of cand) {
     if (picked.length >= 3) break;
     if (picked.some(p => p.ll.distanceTo(x.ll) < 80)) continue;
     picked.push(x);
   }
   picked.forEach(({ e }) => {
     const high = e.high;
     const label = high ? '混雑ポイント' : 'やや混雑';
     const note = high ? '人が集中し歩きにくい' : '人がやや多い';
     const icon = L.divIcon({
       className: '',
       html: '<div class="ep-bubble ' + (high ? 'hi' : 'mid') + '"><b>' + label + '</b><span>' + note + '</span></div>',
       iconSize: [120, 44], iconAnchor: [60, 50]
     });
     L.marker(e.mid, { icon, interactive: false, zIndexOffset: 1500 }).addTo(_ep.bubbleLayer);
   });
 }

 // 指定バケットで混雑しているエッジを地図に描画（赤=高/橙=中）＋ライブ凡例を更新
 function _epDrawCongestion(bucket) {
   if (!_ep || !_ep.congLayer) return;
   _ep.congLayer.clearLayers();
   const ts = congestionTimeseriesData;
   if (!ts || !ts.edges) return;
   const geom = _ep.congGeom || {};
   let nMid = 0, nHigh = 0;
   _ep.congActive = [];   // 現在バケットで混雑中のエッジ（中点・密度）を保持し注意点パネルで分析
   for (const id in ts.edges) {
     const series = ts.edges[id];
     if (!series || bucket >= series.length) continue;
     const density = series[bucket] / 10.0;          // ×10量子化を戻す
     if (density < 0.8) continue;                     // 低混雑は描かない
     const coords = geom[id];
     if (!coords || coords.length < 2) continue;
     const high = density >= 2.0;
     if (high) nHigh++; else nMid++;
     L.polyline(coords, { color: high ? '#ff3b30' : '#ff9f0a', weight: high ? 6 : 4, opacity: 0.7, lineCap: 'round' }).addTo(_ep.congLayer);
     _ep.congActive.push({ mid: coords[Math.floor(coords.length / 2)], density, high });
   }
   _ep.lastInfoKey = null;  // 混雑が変わったので注意点パネルを更新させる
   _epUpdateCongLegend(nMid, nHigh);
 }

 // この時刻に混雑している道路の本数を凡例として表示（混雑ゼロなら隠す）
 function _epUpdateCongLegend(nMid, nHigh) {
   const el = document.getElementById('ep-cong-legend');
   if (!el) return;
   if (nMid + nHigh === 0) { el.classList.add('hidden'); el.innerHTML = ''; return; }
   el.innerHTML = '<span class="epl-title">この時刻の道路混雑</span>'
     + '<span class="epl-item"><span class="epl-dot epl-mid"></span>中 <span class="epl-num">' + nMid + '</span></span>'
     + '<span class="epl-item"><span class="epl-dot epl-high"></span>高 <span class="epl-num">' + nHigh + '</span></span>';
   el.classList.remove('hidden');
 }

 // 分岐選択カードを表示（避難所名を反映）
 function _epShowBranch() {
   if (!_ep || !_ep.branch) return;
   const sd = document.getElementById('ep-branch-shelter-desc');
   if (sd) sd.textContent = _ep.branch.shelterName + '。屋内退避・情報・物資が得られます。';
   const card = document.getElementById('ep-branch-choice');
   if (card) card.classList.remove('hidden');
 }

 // 分岐の選択：'highland'＝高台へ継続 / 'shelter'＝避難所ルートへ差し替え
 function _epChooseBranch(which) {
   if (!_ep || !_ep.branch) return;
   const b = _ep.branch;
   document.getElementById('ep-branch-choice')?.classList.add('hidden');

   if (which === 'shelter') {
     // 分岐点まで（主ルート）＋ 避難所への続き でルートを組み替える
     const keep = _ep.wps.slice(0, b.mainIdx + 1);
     const newWps = keep.concat(b.secWps);
     const newCum = [0];
     for (let i = 1; i < newWps.length; i++) {
       newCum[i] = newCum[i - 1] + L.latLng(newWps[i - 1]).distanceTo(L.latLng(newWps[i]));
     }
     // 注意点を作り直す（分岐前は既存、分岐後は避難所向けの汎用ガイド）
     const oldC = _ep.cautions;
     const nc = new Array(newWps.length);
     for (let i = 0; i < newWps.length; i++) {
       if (i <= b.mainIdx && oldC[i]) nc[i] = oldC[i];
       else if (i === newWps.length - 1) nc[i] = { level: 'safe', head: '避難完了（避難所）', body: b.shelterName + 'に到達しました。係員の指示に従い、屋内のより高い階へ移動してください。' };
       else nc[i] = { level: 'warning', head: '避難所へ移動', body: b.shelterName + 'へ向かっています。屋内のより高い階まで上がれるのが避難ビルの強み。沿道の混雑・落下物に注意。' };
     }
     _ep.wps = newWps; _ep.cum = newCum;
     _ep.totalDist = newCum[newCum.length - 1];
     _ep.evacTotalSec = _ep.totalDist / Math.max(0.4, _ep.speed);
     _ep.cautions = nc;
     _ep.chosenShelter = true;
     const totalEl = document.getElementById('ep-total');
     if (totalEl) totalEl.textContent = _epFmt(_ep.evacTotalSec);
   }
   _epUpdateDestLabel();

   b.decided = true; b.prompting = false;
   _ep.lastInfoKey = null;  // 注意点パネルを即時更新させる
   // 現在地（分岐点）に対応する時刻に合わせて再生を再開
   _ep.t = (b.dist / _ep.totalDist) * _ep.evacTotalSec;
   _epRender(_ep.t);
   _epPlay();
 }

 function _epTick(ts) {
   if (!_ep || !_ep.playing) return;
   if (!_ep.lastTs) _ep.lastTs = ts;
   const dtWall = (ts - _ep.lastTs) / 1000;
   _ep.lastTs = ts;
   const rate = _ep.evacTotalSec / _ep.wallclock;  // 時系列秒 / 実時間秒
   let nt = _ep.t + dtWall * rate;
   if (nt >= _ep.evacTotalSec) {
     _epRender(_ep.evacTotalSec);
     _epPause();
     return;
   }
   _epRender(nt);
   _ep.raf = requestAnimationFrame(_epTick);
 }

 function _epPlay() {
   if (!_ep) return;
   if (_ep.t >= _ep.evacTotalSec) { _ep.t = 0; }  // 終端なら頭出し
   _ep.playing = true; _ep.lastTs = 0;
   document.getElementById('ep-play-icon')?.classList.add('hidden');
   document.getElementById('ep-pause-icon')?.classList.remove('hidden');
   _ep.raf = requestAnimationFrame(_epTick);
 }

 function _epPause() {
   if (!_ep) return;
   _ep.playing = false;
   if (_ep.raf) cancelAnimationFrame(_ep.raf);
   _ep.raf = null;
   document.getElementById('ep-play-icon')?.classList.remove('hidden');
   document.getElementById('ep-pause-icon')?.classList.add('hidden');
 }

 function stopEvacuationPlayback() {
   if (_ep) {
     if (_ep.raf) cancelAnimationFrame(_ep.raf);
     try { routeLayerGroup.removeLayer(_ep.marker); } catch (e) {}
     try { if (_ep.congLayer) map.removeLayer(_ep.congLayer); } catch (e) {}
     try { if (_ep.bubbleLayer) map.removeLayer(_ep.bubbleLayer); } catch (e) {}
     try { [_ep.dottedLine, _ep.aheadCasing, _ep.aheadLine, _ep.destMarker].forEach(l => { if (l) map.removeLayer(l); }); } catch (e) {}
     // 自由パン検知の後始末
     try { if (_ep.onUserMapMove) { map.off('dragstart', _ep.onUserMapMove); map.off('zoomstart', _ep.onUserMapMove); } } catch (e) {}
     _ep = null;
   }
   document.getElementById('evac-playback')?.classList.add('hidden');
   document.getElementById('ep-branch-choice')?.classList.add('hidden');
   document.getElementById('ep-cong-legend')?.classList.add('hidden');
   document.getElementById('ep-recenter')?.classList.add('hidden');
   document.body.classList.remove('ep-mode');
   // 再生前に表示していた現在地ピンを復元
   if (_epUserMarkerWasOnMap && userMarker && currentLocation && map) {
     try {
       userMarker.setLatLng([currentLocation.lat, currentLocation.lng]);
       if (!map.hasLayer(userMarker)) userMarker.addTo(map);
       syncUserMarkerArrow();
     } catch (e) {}
   }
   _epUserMarkerWasOnMap = false;
 }

 function _appendHeroRouteOption(wrapper, c, opts) {
   const dict = i18nDict[getLanguageCode()] || i18nDict['ja'] || {};
   const btn = document.createElement('button');
   btn.className = `route-option-btn ${opts.className} ${opts.isSelected ? 'active' : ''}`;
   btn.setAttribute('data-route-id', c.id);
   btn.setAttribute('data-color', c.color || '#00bbff');
   btn.innerHTML = `
     <div class="ai-route-glow"></div>
     <div class="route-card-row">
       <div class="ai-route-icon">${opts.iconSvg}</div>
       <div class="route-card-text">
         <div class="route-card-name">${c.label}</div>
         <div class="route-card-kw">${opts.badgeText}</div>
       </div>
       <div class="route-card-time">${c.estimated_min}<small>${(dict.minutesSuffix || '分')}</small></div>
     </div>`;
   btn.addEventListener('click', () => { opts.onSelect(); });
   btn.addEventListener('touchstart', function(){ btn.classList.add('pressed'); }, {passive:true});
   btn.addEventListener('touchend', function(){ setTimeout(function(){ btn.classList.remove('pressed'); }, 150); }, {passive:true});
   wrapper.appendChild(btn);
 }

 function showRouteSelectorHUD(candidates) {
 const container = document.getElementById('route-options-container');
 if (!container) return;
 // 学習済みAIモデルの推奨ルートを最優先候補として先頭に差し込む
 try {
   if (aiPolicyData && currentLocation) {
     const already = (candidates || []).some(c => c && c.id === 'AI');
     if (!already) {
       const aiRoute = computeAiRoute(currentLocation);
       if (aiRoute && !aiRoute.alreadySafe && aiRoute.waypoints) {
         candidates = [aiRoute, ...(candidates || [])];
       }
     }
   } else if (!aiPolicyData) {
     // まだ未ロードなら読み込み、完了後にオーバーレイが開いていれば再描画
     loadAiPolicy().then(d => {
       const ov = document.getElementById('route-overlay');
       if (d && ov && ov.classList.contains('active') && currentLocation) {
         showRouteSelectorHUD(activeRoutesList || []);
       }
     });
   }
 } catch (e) { console.warn('[TENDEN] AI route inject failed', e); }
 // 要配慮者ルートも学習済み方策（緩勾配優先）があればそれを優先（OSRMヒューリスティック版を置換）
 try {
   if (aiAccessibleData && currentLocation) {
     const accRoute = computeAccessibleRoute(currentLocation);
     if (accRoute && !accRoute.alreadySafe && accRoute.waypoints) {
       candidates = (candidates || []).filter(c => c && c.id !== 'C');
       candidates.push(accRoute);
     }
   } else if (!aiAccessibleData) {
     loadAccessiblePolicy().then(d => {
       const ov = document.getElementById('route-overlay');
       if (d && ov && ov.classList.contains('active') && currentLocation) showRouteSelectorHUD(activeRoutesList || []);
     });
   }
 } catch (e) { console.warn('[TENDEN] accessible route inject failed', e); }
 // ルート提示を「AIモデル推奨」＋「要配慮者(バリアフリー)」の2本に集約。
 // AIが最短・混雑回避・高台を統合最適化するため最短(A)/混雑回避(B)カードは撤去。
 // バリアフリー(C)は緩勾配・要介助という別目的のため残す。AI未取得時は従来通り。
 try {
   const _ai = (candidates || []).filter(c => c && c.isAI);
   if (_ai.length) {
     const _dict = i18nDict[getLanguageCode()] || i18nDict['ja'] || {};
     const _acc = (candidates || []).filter(c => c && c.id === 'C').map(c =>
       Object.assign({}, c, { color: '#5e5ce6', label: _dict.routeAccessibleLabel || '要配慮者ルート（緩やか）' }));
     candidates = [..._ai, ..._acc];
   }
 } catch (e) { console.warn('[TENDEN] route consolidation failed', e); }
  // nullルートをフィルタ
  var _valid = (candidates||[]).filter(function(c){return c&&c.waypoints&&c.waypoints.length>0;});
  if (_valid.length === 0) {
    var fb = buildDirectFallbackRoute(currentLocation);
    if (fb) { candidates = [fb]; }
    else {
      container.innerHTML = '<div style="display:flex;flex-direction:column;align-items:center;gap:10px;padding:20px;"><img class="tenden-loader sm" src="assets/loading.gif" alt="" aria-hidden="true" /><span style="opacity:0.75;font-size:0.85rem;">ルートを計算中…</span></div>';
      var _ov=document.getElementById('route-overlay');
      if(_ov){_ov.classList.remove('hidden');setTimeout(function(){_ov.classList.add('active');},10);}
      setTimeout(function(){if(currentLocation)recalculateRouteFromLocation(currentLocation);},3000);
      return;
    }
  } else { candidates = _valid; }
  // フィルタ後の candidates で activeRoutesList を更新
  activeRoutesList = candidates;
  hideRouteCalcLoading();  // 経路が確定したのでローディングを閉じる

  // AI学習済みルートが候補に含まれるか（フォールバックUI切替の判定）
  const hasAiRoute = (candidates || []).some(c => c && c.isAI);

  // 選択画面が開いた時点で、確定後の候補（AI＋要配慮者）を地図に描き直す。
  // ここより前（recalculateRouteFromLocation）の描画はAI/要配慮者への集約前の
  // 暫定候補のままなので、カードと地図の表示が食い違っていた。
  try {
    // 自動選択せず全候補を同列表示（AI/smart ルートもユーザーがタップするまで適用しない）
    drawMultipleEvacuationRoutes(currentLocation, window._cachedTargetEdge, activeSecondaryRoute, candidates, null);
  } catch (e) { console.error('[TENDEN] drawMultipleEvacuationRoutes error (selector):', e); }

 // Temporarily fade out background emergency controls & banners
 const hudBottom = document.querySelector('.hud-bottom');
 if (hudBottom) hudBottom.classList.add('hidden-for-route');

 const banner = document.getElementById('evacuation-banner');
 if (banner) banner.classList.add('hidden-for-route');

 container.innerHTML = '';

 // --- 1. 案内見出し（自動選択はせず、ユーザー自身に判断してもらう） ---
 const _hd = i18nDict[getLanguageCode()] || i18nDict['ja'] || {};
 const guideHead = document.createElement('div');
 guideHead.style.cssText = 'padding:2px 2px 4px; text-align:left;';
 guideHead.innerHTML = `
 <div style="font-size:1.0rem; font-weight:800; color:var(--text-color); margin-bottom:3px;">${_hd.routeSelectHead || '避難ルートを選んでください'}</div>
 <div style="font-size:0.76rem; color:var(--text-muted); line-height:1.5;">${_hd.routeSelectTendenkoGuide || '正解はありません。今すぐ合う方を選んで進みましょう。'}</div>
 `;
 container.appendChild(guideHead);

 // --- 2. Compact Route Options ---
 const optionsWrapper = document.createElement('div');
 optionsWrapper.style.display = 'flex';
 optionsWrapper.style.flexDirection = 'column';
 optionsWrapper.style.gap = '8px';
 optionsWrapper.style.marginTop = '6px';
 
 const dict = i18nDict[getLanguageCode()] || i18nDict['ja'] || {};
 const _heroIconShort = '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" width="22" height="22" stroke-linecap="round" stroke-linejoin="round"><polygon points="3 11 22 2 13 21 11 13 3 11"/></svg>';
 const _heroIconAvoid = '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" width="22" height="22" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>';
 const _heroIconAcc = '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" width="22" height="22" stroke-linecap="round" stroke-linejoin="round"><circle cx="16" cy="4" r="1"/><path d="m18 19 1-7-6 1"/><path d="m5 8 3-3 5.5 3-2.36 3.5"/><path d="M4.24 14.5a5 5 0 0 0 6.88 6"/><path d="M13.76 17.5a5 5 0 0 0-6.88-6"/></svg>';
 candidates.forEach(c => {
 const isSelected = activeSelectedRouteId != null && c.id === activeSelectedRouteId;
 const targetColor = c.color || '#00bbff';

 // ── AIモデル推奨ルート: 専用のヒーローカード ──
 if (c.isAI) {
   const aiBtn = document.createElement('button');
   aiBtn.className = `route-option-btn ai-route-btn ${isSelected ? 'active' : ''}`;
   aiBtn.setAttribute('data-route-id', 'AI');
   aiBtn.setAttribute('data-color', targetColor);
   aiBtn.innerHTML = `
     <div class="ai-route-glow"></div>
     <div class="route-card-row">
       <div class="ai-route-icon">
         <svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" width="22" height="22" stroke-linecap="round" stroke-linejoin="round"><path d="M9.94 15.5A2 2 0 0 0 8.5 14.06l-6.14-1.58a.5.5 0 0 1 0-.96L8.5 9.94A2 2 0 0 0 9.94 8.5l1.58-6.14a.5.5 0 0 1 .96 0L14.06 8.5A2 2 0 0 0 15.5 9.94l6.14 1.58a.5.5 0 0 1 0 .96L15.5 14.06a2 2 0 0 0-1.44 1.44l-1.58 6.14a.5.5 0 0 1-.96 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/><path d="M4 17v2"/><path d="M5 18H3"/></svg>
       </div>
       <div class="route-card-text">
         <div class="route-card-name">${c.label}</div>
         <div class="route-card-kw">${(dict.routeAiBadge || 'AI参考ルート')}</div>
       </div>
       <div class="route-card-time">${c.estimated_min}<small>${(dict.minutesSuffix || '分')}</small></div>
     </div>`;
   aiBtn.addEventListener('click', () => { selectEvacuationRoute('AI'); });
   aiBtn.addEventListener('touchstart', function(){ aiBtn.classList.add('pressed'); }, {passive:true});
   aiBtn.addEventListener('touchend', function(){ setTimeout(function(){ aiBtn.classList.remove('pressed'); }, 150); }, {passive:true});
   optionsWrapper.appendChild(aiBtn);
   return;
 }

 // ── 要配慮者ルート（AI学習済み時のみ）: ヒーローカード ──
 if (c.isAccessibleAI || (hasAiRoute && c.id === 'C')) {
   const accBtn = document.createElement('button');
   accBtn.className = `route-option-btn acc-route-btn ${isSelected ? 'active' : ''}`;
   accBtn.setAttribute('data-route-id', c.id);
   accBtn.setAttribute('data-color', targetColor);
   accBtn.innerHTML = `
     <div class="ai-route-glow"></div>
     <div class="route-card-row">
       <div class="ai-route-icon">
         <svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" width="22" height="22" stroke-linecap="round" stroke-linejoin="round"><circle cx="16" cy="4" r="1"/><path d="m18 19 1-7-6 1"/><path d="m5 8 3-3 5.5 3-2.36 3.5"/><path d="M4.24 14.5a5 5 0 0 0 6.88 6"/><path d="M13.76 17.5a5 5 0 0 0-6.88-6"/></svg>
       </div>
       <div class="route-card-text">
         <div class="route-card-name">${c.label}</div>
         <div class="route-card-kw">${(dict.routeAccessibleBadge || 'やさしい道')}</div>
       </div>
       <div class="route-card-time">${c.estimated_min}<small>${(dict.minutesSuffix || '分')}</small></div>
     </div>`;
   accBtn.addEventListener('click', () => { selectEvacuationRoute(c.id); });
   accBtn.addEventListener('touchstart', function(){ accBtn.classList.add('pressed'); }, {passive:true});
   accBtn.addEventListener('touchend', function(){ setTimeout(function(){ accBtn.classList.remove('pressed'); }, 150); }, {passive:true});
   optionsWrapper.appendChild(accBtn);
   return;
 }

 // ── フォールバック時（AI未取得）: A/B/C を同格のヒーローカードで表示 ──
 if (!hasAiRoute && (c.id === 'A' || c.id === 'B' || c.id === 'C')) {
   const fallbackHero = {
     A: { className: 'short-route-btn', badge: dict.routeShortest || '最短距離', icon: _heroIconShort },
     B: { className: 'avoid-route-btn', badge: dict.routeAvoid || '混雑回避', icon: _heroIconAvoid },
     C: { className: 'acc-route-btn', badge: dict.routeAccessibleBadge || dict.routeBarrier || 'やさしい道', icon: _heroIconAcc }
   };
   const cfg = fallbackHero[c.id];
   _appendHeroRouteOption(optionsWrapper, c, {
     className: cfg.className,
     badgeText: cfg.badge,
     iconSvg: cfg.icon,
     isSelected,
     onSelect: () => { selectEvacuationRoute(c.id); }
   });
   return;
 }

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
 // タップアニメーション（iOS Safari での:active 遅延を回避）
 btn.addEventListener('touchstart', function(){ btn.classList.add('pressed'); }, {passive:true});
 btn.addEventListener('touchend', function(){ setTimeout(function(){ btn.classList.remove('pressed'); }, 150); }, {passive:true});
 btn.addEventListener('touchcancel', function(){ btn.classList.remove('pressed'); }, {passive:true});
 optionsWrapper.appendChild(btn);
 });
 
 container.appendChild(optionsWrapper);

 // Show overlay with animation
 const overlay = document.getElementById('route-overlay');
 if (overlay) {
 const sheet = overlay.querySelector('.route-bottom-sheet');
 if (sheet) sheet.classList.toggle('route-fallback-mode', !hasAiRoute);
 overlay.classList.remove('hidden');
 setTimeout(() => overlay.classList.add('active'), 10);
 }
 }

 // --- TIME-SERIES CONGESTION (Phase 1: Baseline) ---
 let congestionTimeseriesLoading = null;

 // 緊急モード中のみ遅延フェッチする時系列混雑データ（60秒バケット x 25）
 function loadCongestionTimeseries() {
 if (congestionTimeseriesData) return Promise.resolve(congestionTimeseriesData);
 if (congestionTimeseriesLoading) return congestionTimeseriesLoading;
 congestionTimeseriesLoading = fetch('assets/congestion_timeseries_baseline.json')
 .then(res => res.json())
 .then(data => {
 congestionTimeseriesData = data;
 console.log('[TENDEN] congestion_timeseries_baseline.json loaded', Object.keys(data.edges || {}).length, 'edges');
 return data;
 })
 .catch(e => {
 console.log('[TENDEN] congestion_timeseries_baseline.json not found', e);
 return null;
 });
 return congestionTimeseriesLoading;
 }

 // 緊急モード開始からの経過時間に基づき、現在の60秒バケットのインデックスを返す
 function getCurrentCongestionBucket() {
 if (!emergencyStartTimeMs || !congestionTimeseriesData) return 0;
 const elapsedSec = (Date.now() - emergencyStartTimeMs) / 1000;
 const bucket = Math.floor(elapsedSec / congestionTimeseriesData.bucket_seconds);
 return Math.max(0, Math.min(congestionTimeseriesData.num_buckets - 1, bucket));
 }

 // 指定エッジ・バケットの density_per_sqm を返す。データなしの場合は null
 function getEdgeDensity(edgeId, bucketIdx) {
 if (!congestionTimeseriesData) return null;
 const series = congestionTimeseriesData.edges[edgeId];
 if (!series) return null;
 return (series[bucketIdx] || 0) / 10;
 }

 // density_per_sqm -> 混雑レベル（gen_congestion_geojson.py と同じ閾値）
 function densityToLevel(density) {
 if (density >= 2.0) return 'high';
 if (density >= 0.5) return 'medium';
 return 'low';
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
 
 // 2. Filter congestion edges for high/medium.
 // 緊急モード開始からの経過時間バケットの動的密度が分かる場合はそれを優先し、
 // データ未ロード・該当エッジ無しの場合は静的レベル(level)にフォールバックする。
 const currentBucket = getCurrentCongestionBucket();
 const dangerousFeatures = congestionGeojsonData.features.filter(f => {
 if (!f.properties) return false;
 const density = congestionTimeseriesData ? getEdgeDensity(f.properties.id, currentBucket) : null;
 const level = density !== null ? densityToLevel(density) : f.properties.level;
 return level === 'high' || level === 'medium';
 });
 
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

 let _routeLoadingTimer = null;
 function showRouteCalcLoading() {
   const el = document.getElementById('route-loading');
   if (el) el.classList.remove('hidden');
   if (_routeLoadingTimer) clearTimeout(_routeLoadingTimer);
   _routeLoadingTimer = setTimeout(hideRouteCalcLoading, 15000); // 安全策：長すぎる場合は自動で閉じる
   if (typeof setAgentForFeature === 'function') setAgentForFeature('route-calc', undefined, { persist: true });
   else if (typeof setAgentState === 'function') setAgentState('thinking', undefined, { persist: true });
 }
 function hideRouteCalcLoading() {
   const el = document.getElementById('route-loading');
   if (el) el.classList.add('hidden');
   if (_routeLoadingTimer) { clearTimeout(_routeLoadingTimer); _routeLoadingTimer = null; }
   if (typeof syncAgentEmergency === 'function') syncAgentEmergency(!!isEmergency);
   else if (typeof setAgentState === 'function') setAgentState(isEmergency ? 'alert' : 'idle', undefined, { persist: true });
 }

 // ── TENDEN 共通ローディング表示 ─────────────────────────────────────────
 // 今後ローディング（重い処理・体験開始の待ち等）が必要になった箇所は、必ずこの
 // showTendenLoading()/hideTendenLoading() を使い、ブランドGIF(assets/loading.gif)を表示する。
 // ※起動時スプラッシュ(#splash-screen)とは別物。スプラッシュは差し替えない。
 let _tendenLoadingTimer = null;
 function showTendenLoading(message, autoHideMs) {
   let ov = document.getElementById('tenden-loading');
   if (!ov) {
     ov = document.createElement('div');
     ov.id = 'tenden-loading';
     ov.className = 'tenden-loading-overlay';
     ov.innerHTML = '<img class="tenden-loader" src="assets/loading.gif" alt="" aria-hidden="true" /><div class="tenden-loader-msg"></div>';
     document.body.appendChild(ov);
   }
   const msg = ov.querySelector('.tenden-loader-msg');
   if (msg) msg.textContent = message || '読み込み中…';
   ov.classList.remove('hidden');
   if (_tendenLoadingTimer) clearTimeout(_tendenLoadingTimer);
   _tendenLoadingTimer = setTimeout(hideTendenLoading, autoHideMs || 15000); // 安全策：閉じ忘れ防止
   if (typeof setAgentForFeature === 'function') setAgentForFeature('tenden-loading', undefined, { persist: true });
 }
 function hideTendenLoading() {
   const ov = document.getElementById('tenden-loading');
   if (ov) ov.classList.add('hidden');
   if (_tendenLoadingTimer) { clearTimeout(_tendenLoadingTimer); _tendenLoadingTimer = null; }
   if (typeof syncAgentEmergency === 'function' && (isEmergency || document.body.classList.contains('tenden-nav-active'))) {
     syncAgentEmergency(true);
   } else if (typeof setAgentForFeature === 'function') {
     setAgentForFeature('default', undefined, { persist: true });
   }
 }
 try { window.showTendenLoading = showTendenLoading; window.hideTendenLoading = hideTendenLoading; } catch (e) {}

 async function recalculateRouteFromLocation(loc) {
 if (!isEmergency) return;
 showRouteCalcLoading();

 // Stop current evacuation simulation interval
 if (simulationInterval) {
 clearInterval(simulationInterval);
 simulationInterval = null;
 }

 const targetEdge = await findNearestSafeEdge(loc);
 const bestShelter = findBestShelter(loc); // We keep this to show the best shelter if we want, but our main destination is targetEdge.
 
   if (!targetEdge) {
  console.warn('[TENDEN] No safe edge found - using fallback for demo');
  // デモ・訓練モードでは鎌倉デフォルト安全地点（御成小学校）を使用
  targetEdge = {
    id: 'fallback_onari',
    name: '御成小学校（高台）',
    lat: 35.3190,
    lng: 139.5510
  };
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

   // null をフィルタして有効なルートだけ残す
  var rawCandidates = [routeA, routeB, routeC];
  candidates = rawCandidates.filter(function(c){ return c && c.waypoints && c.waypoints.length > 0; });

  // 有効ルートが0本の場合: フォールバックルートを3本生成
  if (candidates.length === 0) {
    console.warn('[TENDEN] All OSRM routes failed, generating fallback routes');
    var fbEdge = targetEdge || {lat:35.3190, lng:139.5510, name:'御成小学校（高台）'};
    var speed = typeof getEvacuationSpeed === 'function' ? getEvacuationSpeed() : 1.2;
    var distFB = L.latLng(loc.lat,loc.lng).distanceTo(L.latLng(fbEdge.lat,fbEdge.lng));
    var midLat=(loc.lat+fbEdge.lat)/2, midLng=(loc.lng+fbEdge.lng)/2;
    // 3本のルート（微妙に異なる中間点）
    var offsets=[[0,0],[0.001,-0.0005],[-0.001,-0.0005]];
    var labels=['最短ルート','混雑回避ルート','バリアフリールート'];
    var colors=['#0071e3','#34c759','#5e5ce6'];
    var ids=['A','B','C'];
    candidates = ids.map(function(id,idx){
      var off=offsets[idx];
      return {
        id:id, label:labels[idx], color:colors[idx],
        waypoints:[[loc.lat,loc.lng],[midLat+off[0],midLng+off[1]],[fbEdge.lat,fbEdge.lng]],
        distance_m:Math.round(distFB*(1+idx*0.05)),
        estimated_min:Math.max(1,Math.round(distFB*(1+idx*0.05)/(speed*60))),
        characteristics:(fbEdge.name||'安全な高台')+'へ向かうルートです（推定）',
        congestion_score:idx===0?'medium':'low', isOSRM:false, isFallback:true
      };
    });
  }

  // シェルター情報を付加
  candidates.forEach(function(c){
    if (c && c.waypoints && c.waypoints.length > 0 && typeof findSheltersAlongRoute === 'function') {
      try { c.passingShelters = findSheltersAlongRoute(c.waypoints); } catch(e) {}
    }
  });

  // Draw multiple routes without pre-selecting (showRouteSelectorHUD で選択 UI を開く)
  activeSecondaryRoute = secondaryRoute;
  try {
    drawMultipleEvacuationRoutes(loc, targetEdge, secondaryRoute, candidates, null);
  } catch(e) { console.error('[TENDEN] drawMultipleEvacuationRoutes error:', e); }

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
 const bb = REGIONS.kamakura.bbox;
 return (loc.lat >= bb.latMin && loc.lat <= bb.latMax && loc.lng >= bb.lngMin && loc.lng <= bb.lngMax);
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
 if (callback) setTimeout(callback, 400);
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
 ignoreElements: (el) => el.id === 'onboarding-overlay' || el.id === 'error-overlay' || el.id === 'share-overlay' || el.id === 'app-share-overlay' || el.id === 'settings-overlay' || el.id === 'about-overlay' || el.id === 'layers-overlay'
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
 if (data.code === 551 || data.code === 552 || data.code === 556) {
   // 地震・津波オーバーレイが開いていれば即時更新
   const qov = document.getElementById('quake-overlay');
   if (qov && qov.classList.contains('active')) loadQuakeTsunamiPanel();
   else if (data.code === 552 || data.code === 551) refreshHudTsunamiStatus();

   if (data.code === 552) {
     // 津波警報 (code 552)
     if (!data.cancelled) {
       _updateHudTsunamiChip('danger');
       setP2PStatus('alert');
       const p2pAuto = localStorage.getItem('tenden-p2p-auto') !== 'false';
       if (p2pAuto && !isEmergency) {
         triggerEmergencyMode(false, 1, 'a');
         if ('vibrate' in navigator) navigator.vibrate([300, 100, 300, 100, 300]);
       }
     }
   }

   if (data.code === 551 || data.code === 556) {
     const forecasts = data?.tsunami?.comments?.forecast?.text ?? '';
     const isTsunamiWarning =
       forecasts.includes('大地震速報') ||
       forecasts.includes('地震速報') ||
       data.code === 551;
     if (isTsunamiWarning) setP2PStatus('alert');
     if (isTsunamiWarning && !isEmergency) {
       console.warn('[P2P] Tsunami warning received -> Triggering auto-evacuation check...');
       const p2pAuto = localStorage.getItem('tenden-p2p-auto') !== 'false';
       if (p2pAuto) {
         triggerEmergencyMode(false, 1, 'a');
         if ('vibrate' in navigator) navigator.vibrate([300, 100, 300, 100, 300]);
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
 if (typeof updateHudTimeWarning === 'function') updateHudTimeWarning();
 }
 tick();
 setInterval(tick, 1000);
 }

 // P2P接続状態をHUDに反映する
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
 if (typeof syncAgentFromP2P === 'function') syncAgentFromP2P(state);
 if (typeof updateHudTimeWarning === 'function') updateHudTimeWarning();
 }

 function getLanguageCode() {
 const savedLang = localStorage.getItem('tenden-lang') || 'auto';
 if (savedLang !== 'auto') {
 return savedLang;
 }
 const raw = String(navigator.language || navigator.userLanguage || 'ja').toLowerCase().replace('_', '-');
 let browserLang = raw.split('-')[0];
 if (browserLang === 'zh') {
   browserLang = /(^|-)tw($|-)|(^|-)hk($|-)|(^|-)mo($|-)|hant/.test(raw) ? 'zh-tw' : 'zh';
 }
 const aliases = { nb: 'no', nn: 'no', fil: 'tl', iw: 'he' };
 browserLang = aliases[browserLang] || browserLang;
 return i18nDict[browserLang] ? browserLang : 'ja';
 }

 /** 安否共有 — タップ直後に Web Share API、非対応時のみクリップボード＋トースト */
 async function shareSafetyStatus(options = {}) {
 const dict = i18nDict[getLanguageCode()] || i18nDict['ja'] || {};
 const lang = getLanguageCode();
 if (!currentLocation) {
  showCustomAlert(
   dict.alertSosTitle || '安否情報 (現在地)',
   dict.alertSosError || '現在地を取得できませんでした。まず地図上をタップして現在地を設定してください。',
   'warning'
  );
  return;
 }
 const mapsUrl = `https://maps.google.com/?q=${currentLocation.lat},${currentLocation.lng}`;
 const shareTextDefault = lang === 'ja'
  ? '現在、安全な高台へ避難中です。\n現在地: '
  : 'I am currently evacuating to safe high ground.\nMy location: ';
 const text = (dict.shareText || shareTextDefault) + mapsUrl;
 const title = dict.alertSosTitle || '安否情報 (現在地)';
 const sharePayloads = [
  { title, text, url: mapsUrl },
  { title, text },
  { text },
 ];
 if (navigator.share && window.isSecureContext) {
  for (const data of sharePayloads) {
   if (navigator.canShare && !navigator.canShare(data)) continue;
   try {
    if (options.closeDock && typeof window.closeDockSub === 'function') window.closeDockSub();
    await navigator.share(data);
    if (typeof setAgentForFeature === 'function') setAgentForFeature('safety-share', undefined, { persist: true });
    triggerDynamicIsland(dict.sharedLabel || '共有しました', 'success');
    return;
   } catch (e) {
    if (e?.name === 'AbortError') {
     if (options.closeDock && typeof window.closeDockSub === 'function') window.closeDockSub();
     return;
    }
   }
  }
 }
 if (options.closeDock && typeof window.closeDockSub === 'function') window.closeDockSub();
 if (typeof setAgentForFeature === 'function') setAgentForFeature('safety-share', undefined, { persist: true });
 if (navigator.clipboard?.writeText) {
  try {
   await navigator.clipboard.writeText(text);
   triggerDynamicIsland(dict.copiedLabel || 'コピーしました', 'copied');
   return;
  } catch (_) { /* fall through */ }
 }
 try {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.left = '-9999px';
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  document.body.removeChild(ta);
  triggerDynamicIsland(dict.copiedLabel || 'コピーしました', 'copied');
 } catch (_) {
  triggerDynamicIsland(dict.alertSosError || '共有できませんでした', 'warning');
 }
 }

 function syncBodyLangClass(langCode) {
 Array.from(document.body.classList).filter(c => c.startsWith('lang-')).forEach(c => document.body.classList.remove(c));
 document.body.classList.add('lang-' + langCode);
 document.documentElement.lang = langCode === 'zh-tw' ? 'zh-Hant' : langCode;
 document.documentElement.dir = ['ar', 'fa', 'he'].includes(langCode) ? 'rtl' : 'ltr';
 }

 const _hardcodedTextSources = new WeakMap();
 const _hardcodedAttrSources = new WeakMap();
 let _hardcodedI18nObserver = null;

 function _normalizeI18nSource(value) {
   return String(value || '').replace(/\s+/g, ' ').trim();
 }

 function _hardcodedReverseMap() {
   const reverse = new Map();
   const ja = i18nDict['ja'] || {};
   Object.entries(ja).forEach(([key, value]) => {
     if (typeof value !== 'string' || value.includes('<')) return;
     const normalized = _normalizeI18nSource(value);
     if (normalized) reverse.set(normalized, key);
   });
   return reverse;
 }

 function translateHardcodedDom(root, langCode) {
   if (!root || !i18nDict[langCode] || !i18nDict['ja']) return;
   const dict = { ...i18nDict['ja'], ...i18nDict[langCode] };
   const reverse = _hardcodedReverseMap();
   const container = root.nodeType === Node.TEXT_NODE ? root.parentElement : root;
   if (!container) return;

   const translateTextNode = node => {
     const parent = node.parentElement;
     if (!parent || parent.closest('script, style') || parent.hasAttribute('data-i18n')) return;
     let source = _hardcodedTextSources.get(node);
     const current = _normalizeI18nSource(node.nodeValue);
     if (!source && reverse.has(current)) {
       source = current;
       _hardcodedTextSources.set(node, source);
     }
     const key = source && reverse.get(source);
     const translated = key && dict[key];
     if (!translated || typeof translated !== 'string') return;
     const leading = (node.nodeValue.match(/^\s*/) || [''])[0];
     const trailing = (node.nodeValue.match(/\s*$/) || [''])[0];
     const next = leading + translated + trailing;
     if (node.nodeValue !== next) node.nodeValue = next;
   };

   if (root.nodeType === Node.TEXT_NODE) {
     translateTextNode(root);
   } else {
     const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
     let textNode;
     while ((textNode = walker.nextNode())) translateTextNode(textNode);
   }

   const elements = root.nodeType === Node.ELEMENT_NODE
     ? [root, ...root.querySelectorAll('*')]
     : [...container.querySelectorAll('*')];
   elements.forEach(el => {
     const sources = _hardcodedAttrSources.get(el) || {};
     ['aria-label', 'title', 'placeholder'].forEach(attr => {
       if (attr === 'aria-label' && el.hasAttribute('data-i18n-aria')) return;
       const currentValue = el.getAttribute(attr);
       if (!currentValue) return;
       const current = _normalizeI18nSource(currentValue);
       if (!sources[attr] && reverse.has(current)) sources[attr] = current;
       const key = sources[attr] && reverse.get(sources[attr]);
       const translated = key && dict[key];
       if (translated && el.getAttribute(attr) !== translated) el.setAttribute(attr, translated);
     });
     if (Object.keys(sources).length) _hardcodedAttrSources.set(el, sources);
   });
 }

 function installHardcodedI18nObserver() {
   if (_hardcodedI18nObserver || !document.body) return;
   _hardcodedI18nObserver = new MutationObserver(mutations => {
     const langCode = getLanguageCode();
     mutations.forEach(mutation => {
       if (mutation.type === 'characterData') translateHardcodedDom(mutation.target, langCode);
       if (mutation.type === 'attributes') translateHardcodedDom(mutation.target, langCode);
       mutation.addedNodes?.forEach(node => translateHardcodedDom(node, langCode));
     });
   });
   _hardcodedI18nObserver.observe(document.body, {
     subtree: true,
     childList: true,
     characterData: true,
     attributes: true,
     attributeFilter: ['aria-label', 'title', 'placeholder'],
   });
 }

 function initI18n() {
 const langCode = getLanguageCode();
 syncBodyLangClass(langCode);

 // Reset to original Japanese if not in dict
 if (!i18nDict[langCode]) {
 // Usually we'd fetch original html content, but for this demo, 
 // if we need to reset we can just reload or assume Japanese is default
 if (langCode === 'ja') return;
 }

 if (i18nDict[langCode]) {
 const dict = { ...(i18nDict['ja'] || {}), ...i18nDict[langCode] };
 document.querySelectorAll('[data-i18n]').forEach(el => {
 const key = el.getAttribute('data-i18n');
 if (dict[key] !== undefined && dict[key] !== null) {
 el.innerHTML = dict[key];
 }
 });
 document.querySelectorAll('[data-i18n-aria]').forEach(el => {
 const key = el.getAttribute('data-i18n-aria');
 if (dict[key] !== undefined && dict[key] !== null) el.setAttribute('aria-label', dict[key]);
 });
 if (_coastDistActive && typeof updateCoastDistDockLabels === 'function') {
   updateCoastDistDockLabels(true);
 }
 if (_coastDistActive && typeof setCoastDistDismissChipVisible === 'function') {
   setCoastDistDismissChipVisible(true);
 }
 if (isModelAreaDemo && typeof setModelAreaDismissChipVisible === 'function') {
   setModelAreaDismissChipVisible(true);
 }
 if (typeof _updateHudTsunamiChip === 'function') _updateHudTsunamiChip(_hudTsunamiKind);
 if (typeof updateHudTimeWarning === 'function') updateHudTimeWarning();
 if (typeof updateSafeZoneGuideVisibility === 'function') updateSafeZoneGuideVisibility();
 // 日本語は翻訳元そのものなのでハードコードDOM翻訳・監視は不要。
 // このMutationObserverはbody全体のあらゆる変更（class切替・秒更新等）で
 // 発火し辞書逆引きマップの再構築とDOM全走査を行うため、常時起動すると
 // 時計更新やアニメーションのたびに重い処理が走り、日本語ユーザーの
 // メインスレッドを圧迫してタップ等の操作が効かなくなる原因になっていた。
 if (langCode !== 'ja') {
 translateHardcodedDom(document.body, langCode);
 installHardcodedI18nObserver();
 }
 }
 }

 function triggerDynamicIsland(message, type = 'info') {
 if (typeof showAgentBubble === 'function') {
 showAgentBubble(message, { type: type });
 return;
 }
 if (typeof syncAgentFromIsland === 'function') syncAgentFromIsland(type, message);
 }

 function updateGPSAccuracyHUD(accuracy) {
 const accuracyEl = document.getElementById('gps-accuracy');
 const box = document.getElementById('gps-accuracy-box');
 if (!accuracyEl || !box) return;

 const dict = i18nDict[getLanguageCode()] || i18nDict['ja'] || {};

 if (accuracy === null || accuracy === undefined) {
 // Manual pin or mock high accuracy
 if (isManualLocation) {
 accuracyEl.innerText = '±3m';
 box.className = 'status-badge gps-badge';
 box.setAttribute('aria-label', (dict.gpsAccuracyAria || 'GPS精度 {accuracy}').replace('{accuracy}', '±3m'));
 } else {
 accuracyEl.innerText = '--';
 box.className = 'status-badge gps-badge';
 box.setAttribute('aria-label', dict.gpsAccuracyAriaUnknown || 'GPS精度 未取得');
 }
 return;
 }

 const formattedAccuracy = Math.round(accuracy);
 // 低精度でも長い警告文は付けない（上部バーの他項目=海岸距離/津波到達 を押し出すため）。
 // 低精度は色(gps-low-accuracy)で示すのみに留める。
 const accuracyText = `±${formattedAccuracy}m`;
 accuracyEl.innerText = accuracyText;
 box.className = accuracy < 15 ? 'status-badge gps-badge' : 'status-badge gps-badge gps-low-accuracy';
 box.setAttribute('aria-label', (dict.gpsAccuracyAria || 'GPS精度 {accuracy}').replace('{accuracy}', accuracyText));
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
 if (typeof setAgentForFeature === 'function') setAgentForFeature('evac-complete', undefined, { persist: true });
 
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

 /** GSI 津波浸水想定（新）タイル色 → 浸水深区分 */
 const _GSI_TSUNAMI_DEPTH_COLORS = [
   { rgb: [255, 255, 190], key: 'hudDepthLt03' },
   { rgb: [255, 255, 128], key: 'hudDepth03_05' },
   { rgb: [255, 255, 0], key: 'hudDepth05_3' },
   { rgb: [255, 192, 0], key: 'hudDepth3_5' },
   { rgb: [255, 128, 0], key: 'hudDepth5_10' },
   { rgb: [255, 0, 0], key: 'hudDepth10_20' },
   { rgb: [170, 0, 0], key: 'hudDepth20plus' }
 ];

 function _matchGsiTsunamiDepthLabel(r, g, b) {
   let best = null;
   let bestDist = Infinity;
   for (const entry of _GSI_TSUNAMI_DEPTH_COLORS) {
     const d = Math.sqrt(
       Math.pow(r - entry.rgb[0], 2) +
       Math.pow(g - entry.rgb[1], 2) +
       Math.pow(b - entry.rgb[2], 2)
     );
     if (d < bestDist) { bestDist = d; best = entry; }
   }
   return (best && bestDist < 90) ? best.key : 'hudDepthUnknown';
 }

 /** 浸水深バッジ: 区域外(inZone=false)→「—」、区域内→GSIタイル色から深さ区分を表示 */
 function _setInundationDepthHUD(inZone, depthKey) {
   const valEl = document.getElementById('inundation-depth-value');
   const badge = document.getElementById('inundation-depth-badge');
   if (!valEl || !badge) return;
   const dict = i18nDict[getLanguageCode()] || i18nDict['ja'] || {};
   badge.classList.toggle('depth-outside', !inZone);
   badge.classList.toggle('depth-in-zone', !!inZone);
   if (!inZone) {
     valEl.textContent = dict.hudDepthOutside || '—';
     return;
   }
   valEl.textContent = dict[depthKey] || dict.hudDepthUnknown || '?';
 }

 async function updateInundationDepthHUD(loc, prefCode) {
   if (!loc || typeof loc.lat !== 'number' || typeof loc.lng !== 'number') return;
   const code = prefCode || await updateTsunamiPrefecturalTile(loc.lat, loc.lng);
   const zoom = 14;
   const coords = getTileCoords(loc.lat, loc.lng, zoom);
   const tileUrl = `https://disaportaldata.gsi.go.jp/raster/04_tsunami_newlegend_pref_data/${code}/${zoom}/${coords.x}/${coords.y}.png`;
   return new Promise((resolve) => {
     const img = new Image();
     img.crossOrigin = 'anonymous';
     img.onload = function() {
       try {
         const canvas = document.createElement('canvas');
         canvas.width = 256;
         canvas.height = 256;
         const ctx = canvas.getContext('2d');
         ctx.drawImage(img, 0, 0);
         const pixel = ctx.getImageData(coords.px, coords.py, 1, 1).data;
         const alpha = pixel[3];
         if (alpha <= 0) {
           _setInundationDepthHUD(false, null);
           resolve(false);
           return;
         }
         const depthKey = _matchGsiTsunamiDepthLabel(pixel[0], pixel[1], pixel[2]);
         _setInundationDepthHUD(true, depthKey);
         resolve(true);
       } catch (e) {
         console.warn('[InundationDepthHUD]', e);
         _setInundationDepthHUD(false, null);
         resolve(false);
       }
     };
     img.onerror = function() {
       _setInundationDepthHUD(false, null);
       resolve(false);
     };
     img.src = tileUrl;
   });
 }

 /**
 * 平時ガイド — 浸水区域外かつ平時モードでエージェント吹き出し表示
 */
 function isSafeGuideDismissed() {
 try { return sessionStorage.getItem(SAFE_GUIDE_SESSION_KEY) === '1'; } catch (e) { return false; }
 }

 function getSafeGuideBubbleMessage() {
 const dict = i18nDict[getLanguageCode()] || i18nDict['ja'] || {};
 return dict.safeGuideBubble || 'いまの場所は安全です。避難の流れを体験してみましょう。';
 }

 function hideSafeZoneGuideBubble() {
 if (typeof isAgentBubbleMode === 'function' && isAgentBubbleMode(SAFE_GUIDE_BUBBLE_MODE)) {
 if (typeof dismissAgentBubble === 'function') dismissAgentBubble();
 }
 if (typeof syncAgentSafeGuide === 'function') syncAgentSafeGuide(false);
 }

 function dismissSafeZoneGuide() {
 document.body.classList.remove('safe-zone-guide-visible');
 hideSafeZoneGuideBubble();
 try { sessionStorage.setItem(SAFE_GUIDE_SESSION_KEY, '1'); } catch (e) {}
 }

 function showSafeZoneGuideBubble() {
 if (typeof showAgentBubble !== 'function') return;
 showAgentBubble(getSafeGuideBubbleMessage(), {
 type: 'success',
 persist: true,
 dismissible: true,
 interactive: true,
 mode: SAFE_GUIDE_BUBBLE_MODE,
 syncState: false
 });
 if (typeof syncAgentSafeGuide === 'function') syncAgentSafeGuide(true);
 }

 function shouldShowSafeZoneGuide() {
 if (isEmergency || document.body.classList.contains('emergency-mode') || document.body.classList.contains('tenden-nav-active')) return false;
 if (isSafeGuideDismissed()) return false;
 if (lastTsunamiIsInundated !== false) return false;
 if (isWaitingForPinDrop) return false;
 const onboarding = document.getElementById('onboarding-overlay');
 if (onboarding && !onboarding.classList.contains('hidden')) return false;
 const startupNotice = document.getElementById('startup-notice');
 if (startupNotice && !startupNotice.classList.contains('hidden')) return false;
 const modelBadge = document.getElementById('model-area-dismiss-chip');
 if (isModelAreaDemo || (modelBadge && !modelBadge.classList.contains('hidden'))) return false;
 const crosshair = document.getElementById('crosshair-target');
 if (crosshair && !crosshair.classList.contains('hidden')) return false;
 return true;
 }

 function updateSafeZoneGuideVisibility() {
 const visible = shouldShowSafeZoneGuide();
 document.body.classList.toggle('safe-zone-guide-visible', visible);
 if (visible) {
 if (typeof isAgentBubbleMode === 'function' && isAgentBubbleMode(SAFE_GUIDE_BUBBLE_MODE)) {
 const textEl = document.getElementById('tenden-agent-bubble-text');
 if (textEl) textEl.textContent = getSafeGuideBubbleMessage();
 if (typeof syncAgentSafeGuide === 'function') syncAgentSafeGuide(true);
 return;
 }
 showSafeZoneGuideBubble();
 } else {
 hideSafeZoneGuideBubble();
 }
 }

 function initSafeZoneGuide() {
 window.onAgentBubbleDismiss = function () {
 if (typeof isAgentBubbleMode === 'function' && isAgentBubbleMode(SAFE_GUIDE_BUBBLE_MODE)) {
 dismissSafeZoneGuide();
 if (typeof triggerHapticTick === 'function') triggerHapticTick();
 return;
 }
 if (typeof dismissAgentBubble === 'function') dismissAgentBubble();
 };

 const drillBtn = document.getElementById('safe-guide-btn-drill');
 if (drillBtn) {
 drillBtn.addEventListener('click', (e) => {
 e.stopPropagation();
 dismissSafeZoneGuide();
 startDrillExperienceFlow();
 if (typeof triggerHapticTick === 'function') triggerHapticTick();
 });
 }
 if (map) {
 map.on('click', () => {
 if (typeof isAgentBubbleMode === 'function' && isAgentBubbleMode(SAFE_GUIDE_BUBBLE_MODE)) {
 dismissSafeZoneGuide();
 }
 });
 }
 const snClose = document.getElementById('btn-startup-notice-close');
 if (snClose) {
 snClose.addEventListener('click', () => setTimeout(updateSafeZoneGuideVisibility, 400));
 }
 updateSafeZoneGuideVisibility();
 }

 /**
 * 蛻､螳夂ｵ先棡繧辿UD荳企Κ繝舌・・・sunami-status-box・峨↓鄒弱＠縺・げ繝ｩ繧ｹ繝｢繝ｫ繝輔ぅ繧ｺ繝繝舌ャ繧ｸ縺ｨ縺励※蜿肴丐縺吶ｋ
 * @param {boolean} isInundated 豬ｸ豌ｴ諠ｳ螳壼玄蝓溷・縺九←縺・°
 */
 function updateTsunamiStatusUI(isInundated) {
 lastTsunamiIsInundated = isInundated;
 const box = document.getElementById('tsunami-status-box');
 const textSpan = document.getElementById('tsunami-status-text');
 if (!box || !textSpan) {
 updateSafeZoneGuideVisibility();
 return;
 }
 
 box.classList.remove('hidden');
 box.className = 'dash-info-card'; // クラスの初期化
 
 // コンパクトHUD幅（実機・PCモック枠の #app-container 幅で判定）
 const appEl = document.getElementById('app-container');
 const hudWidth = appEl ? appEl.clientWidth : window.innerWidth;
 const isMobile = hudWidth <= 768;
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
 updateSafeZoneGuideVisibility();
 updateHudTimeWarning();
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
 updateInundationDepthHUD(loc, prefCode);
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
 shareText = `[TENDEN Personal Evacuation Plan]\nIn the event of a tsunami, I will evacuate to the designated shelter "${localizedDest}" via the 1st safe boundary.\n- Evacuation Route: ${routeLabel}\n- Estimated Time: approx. ${duration_min} min (Speed: ${speed} km/h)\nCheck your own evacuation route now using the offline-first PWA app "TENDEN"!\nApp Link: ${(window.TENDEN_CONFIG && window.TENDEN_CONFIG.appUrl) || 'https://masatosprojects.github.io/tenden-app/'}`;
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

 function isVirtualLocationMode() {
   return isModelAreaDemo || (isManualLocation && currentLocation && isInModelArea(currentLocation));
 }

 function bearingBetweenLocations(from, to) {
   if (!from || !to) return null;
   if (Math.abs(from.lat - to.lat) < 1e-8 && Math.abs(from.lng - to.lng) < 1e-8) return null;
   if (typeof turf !== 'undefined') {
     return turf.bearing(turf.point([from.lng, from.lat]), turf.point([to.lng, to.lat]));
   }
   const dLng = (to.lng - from.lng) * Math.PI / 180;
   const lat1 = from.lat * Math.PI / 180;
   const lat2 = to.lat * Math.PI / 180;
   const y = Math.sin(dLng) * Math.cos(lat2);
   const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
   return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
 }

 function recordLocationForCompass(newLoc) {
   if (!newLoc) return;
   const moved = prevTrackLocation &&
     (Math.abs(prevTrackLocation.lat - newLoc.lat) > 1e-7 || Math.abs(prevTrackLocation.lng - newLoc.lng) > 1e-7);
   if (moved) {
     const bearing = bearingBetweenLocations(prevTrackLocation, newLoc);
     if (bearing !== null) movementHeading = bearing;
   }
   prevTrackLocation = { lat: newLoc.lat, lng: newLoc.lng };
   if (!_ep) applyCompassDisplay();
 }

 function getActiveCompassHeading() {
   const isCompassEnabled = localStorage.getItem('tenden-smart-compass') !== 'false';
   if (!isCompassEnabled) return null;

   const deviceFresh = lastHeading !== 0 && (Date.now() - deviceHeadingTs) < 2500;
   const virtualMode = isVirtualLocationMode();

   if (virtualMode) {
     if (movementHeading !== null) return { heading: movementHeading, invert: false, source: 'virtual-move' };
     if (deviceFresh) return { heading: lastHeading, invert: true, source: 'device' };
     return { heading: 0, invert: false, source: 'north' };
   }

   if (deviceFresh) return { heading: lastHeading, invert: true, source: 'device' };
   if (gpsMovementHeading !== null) return { heading: gpsMovementHeading, invert: true, source: 'gps' };
   if (movementHeading !== null) return { heading: movementHeading, invert: false, source: 'move' };
   return { heading: 0, invert: false, source: 'north' };
 }

 function applyCompassDisplay() {
   if (_ep) return;
   const result = getActiveCompassHeading();
   const needle = document.querySelector('#ep-compass .ep-compass-needle');
   const compass = document.getElementById('ep-compass');
   if (!needle) return;

   if (!result) {
     needle.style.transform = '';
     syncUserMarkerArrow();
     return;
   }

   const rot = result.invert ? -result.heading : result.heading;
   needle.style.transform = 'rotate(' + rot + 'deg)';
   document.documentElement.style.setProperty('--compass-heading', result.heading + 'deg');

   if (compass) {
     compass.dataset.headingSource = result.source;
     const virtualMode = isVirtualLocationMode();
     compass.setAttribute('aria-label', virtualMode
       ? '方位（仮想位置・' + Math.round(result.heading) + '°）'
       : '方位（' + Math.round(result.heading) + '°）');
   }
   syncUserMarkerArrow();
 }

 function syncUserMarkerArrow() {
   const arrow = document.querySelector('.user-marker-arrow');
   if (!arrow) return;
   const isCompassEnabled = localStorage.getItem('tenden-smart-compass') !== 'false';
   const result = getActiveCompassHeading();
   if (!isCompassEnabled || !result || result.source === 'north') {
     arrow.style.display = 'none';
     return;
   }
   arrow.style.display = 'block';
   arrow.style.transform = 'rotate(' + result.heading + 'deg)';
 }

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
 icon: 'assets/icons/TENDEN.gif',
 vibrate: [500, 100, 500],
 tag: tag,
 renotify: true
 });
 });
 } else {
 try {
 new Notification(title, {
 body: body,
 icon: 'assets/icons/TENDEN.gif',
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
 syncUserMarkerArrow();
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
 deviceHeadingTs = Date.now();
 if (!_ep) applyCompassDisplay();
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
    // 線分上の最近傍点（パラメータt: 0〜1）
    // nearestPtOnSeg: 線分上の最近傍点
    // 引数: point=(px=lat,py=lng), segA=(ax=lat,ay=lng), segB=(bx=lat,by=lng)
    function nearestPtOnSeg(px,py,ax,ay,bx,by){
      var dx=bx-ax, dy=by-ay, len2=dx*dx+dy*dy;
      if(len2===0) return {lat:ax, lng:ay};
      // 正しい射影公式: t = ((P-A)・(B-A)) / |B-A|²
      var t=Math.max(0,Math.min(1,((px-ax)*dx+(py-ay)*dy)/len2));
      return {lat:ax+t*dx, lng:ay+t*dy};
    }
    function haversine(la1,lo1,la2,lo2){
      var R=6371000,dLa=(la2-la1)*Math.PI/180,dLo=(lo2-lo1)*Math.PI/180;
      var a=Math.sin(dLa/2)**2+Math.cos(la1*Math.PI/180)*Math.cos(la2*Math.PI/180)*Math.sin(dLo/2)**2;
      return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
    }

    // 指定半径内のOpenStreetMap海岸線データから最近傍点を探す
    async function queryOverpassCoastline(radius, timeoutMs) {
      try {
        var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
        var timeoutId = controller ? setTimeout(function(){ controller.abort(); }, timeoutMs) : null;
        var q = '[out:json][timeout:' + Math.ceil(timeoutMs/1000) + '];(way["natural"="coastline"](around:' + radius + ',' + loc.lat + ',' + loc.lng + '););out geom;';
        var fetchOpts = controller ? { signal: controller.signal } : {};
        var res = await fetch('https://overpass-api.de/api/interpreter?data=' + encodeURIComponent(q), fetchOpts);
        if (timeoutId) clearTimeout(timeoutId);
        if (!res.ok) return null;
        var data = await res.json();
        if (!data || !data.elements || data.elements.length === 0) return null;
        var bestDist = Infinity, bestLat, bestLng;
        data.elements.forEach(function(way) {
          if (!way.geometry || way.geometry.length < 2) return;
          for (var i = 0; i < way.geometry.length - 1; i++) {
            var a = way.geometry[i], b = way.geometry[i+1];
            var np = nearestPtOnSeg(loc.lat, loc.lng, a.lat, a.lon, b.lat, b.lon);
            var d = haversine(loc.lat, loc.lng, np.lat, np.lng);
            if (d < bestDist) { bestDist = d; bestLat = np.lat; bestLng = np.lng; }
          }
        });
        if (bestLat === undefined) return null;
        return { lat: bestLat, lng: bestLng, distance: bestDist, source: 'OpenStreetMap Overpass' };
      } catch(e) {
        return null; // API失敗 → 次の半径 or フォールバックへ
      }
    }

    // 鎌倉・湘南エリア境界（詳細海岸線座標）
    var COAST = [
      [35.3098,139.4632],[35.3060,139.4880],[35.3060,139.5000],
      [35.3063,139.5180],[35.3052,139.5380],[35.3052,139.5500],
      [35.3062,139.5600],[35.3083,139.5660],[35.3108,139.5660],
      [35.3105,139.5690],[35.3078,139.5780],[35.3065,139.5800],
    ];
    function localCoastResult() {
      var bestD=Infinity, bestP=null;
      for(var i=0;i<COAST.length-1;i++){
        var a=COAST[i],b=COAST[i+1];
        var np=nearestPtOnSeg(loc.lat,loc.lng,a[0],a[1],b[0],b[1]);
        var d=haversine(loc.lat,loc.lng,np.lat,np.lng);
        if(d<bestD){bestD=d;bestP=np;}
      }
      return (bestP && bestD < 35000) ? {lat:bestP.lat,lng:bestP.lng,distance:bestD,source:'Kamakura Local'} : null;
    }

    // ── 方法1: 鎌倉エリア内なら即座にローカルデータを使用（応答 < 1ms）──
    const inKamakuraArea = loc.lat >= 35.26 && loc.lat <= 35.42 && loc.lng >= 139.43 && loc.lng <= 139.62;
    if (inKamakuraArea) {
      const local = localCoastResult();
      if (local) return local;
    }

    // ── 方法2: エリア外はOverpass API（タイムアウト短縮: 5秒1回のみ）──
    const found = await queryOverpassCoastline(30000, 5000);
    if (found) return found;

    // ── 方法3: フォールバック（ローカル座標・鎌倉エリア外でも試みる）──
    return localCoastResult();
  }

  // 海岸距離をステータスバーに常時表示（スロットル: 120秒 or 200m移動）
  let _coastLastLoc = null, _coastLastMs = 0;
  async function updateCoastDistBar(loc) {
    if (!loc) return;
    const now = Date.now();
    if (_coastLastLoc && now - _coastLastMs < 120000) {
      try {
        const moved = turf.distance(turf.point([loc.lng, loc.lat]), turf.point([_coastLastLoc.lng, _coastLastLoc.lat]), { units: 'meters' });
        if (moved < 200) return;
      } catch(e) {}
    }
    _coastLastLoc = { lat: loc.lat, lng: loc.lng };
    _coastLastMs = now;
    const coast = await findNearestCoastline(loc);
    const val = document.getElementById('coast-dist-value');
    if (!val) return;
    if (!coast) { val.textContent = '--'; return; }
    const d = Math.round(coast.distance);
    val.textContent = d >= 1000 ? `${(d / 1000).toFixed(1)}km` : `${d}m`;
  }

  function updateCoastDistDockLabels(active) {
    const dict = i18nDict[getLanguageCode()] || i18nDict['ja'] || {};
    const labelKey = active ? 'dockCoastActive' : 'dockCoast';
    const ariaKey = active ? 'dockCoastActiveAria' : 'dockCoastAria';
    const hint = dict.coastDistLineTapHint || '';
    document.querySelectorAll('[data-trigger="btn-coastline-dist"]').forEach(function (el) {
      const label = el.querySelector('[data-i18n="dockCoast"], [data-i18n="dockCoastActive"]');
      if (label) {
        label.setAttribute('data-i18n', labelKey);
        if (dict[labelKey]) label.textContent = dict[labelKey];
      }
      if (label && label.classList.contains('dock-label')) {
        if (active && hint) label.setAttribute('data-coast-hint', hint);
        else label.removeAttribute('data-coast-hint');
      }
      if (dict[ariaKey]) el.setAttribute('aria-label', dict[ariaKey]);
    });
  }

  function setCoastDistDismissChipVisible(visible) {
    const chip = document.getElementById('coast-dist-dismiss-chip');
    if (!chip) return;
    chip.classList.toggle('hidden', !visible);
    if (visible) {
      const dict = i18nDict[getLanguageCode()] || i18nDict['ja'] || {};
      const span = chip.querySelector('[data-i18n="coastDistDismissChip"]');
      if (span && dict.coastDistDismissChip) span.textContent = dict.coastDistDismissChip;
      if (dict.coastDistDismissAria) chip.setAttribute('aria-label', dict.coastDistDismissAria);
    }
  }

  function clearCoastDistOverlay() {
    if (coastDistLayerGroup && map) {
      try { map.removeLayer(coastDistLayerGroup); } catch (e) {}
      coastDistLayerGroup = null;
    }
    _coastDistActive = false;
    document.querySelectorAll('[data-trigger="btn-coastline-dist"]').forEach(function (el) {
      el.classList.remove('dock-coast-active');
      el.setAttribute('aria-pressed', 'false');
    });
    updateCoastDistDockLabels(false);
    setCoastDistDismissChipVisible(false);
    if (typeof setAgentForFeature === 'function' && !isEmergency && !document.body.classList.contains('tenden-nav-active')) {
      setAgentForFeature('default', undefined, { persist: true });
    }
  }

  async function toggleCoastDistDisplay() {
    const dict = i18nDict[getLanguageCode()] || i18nDict['ja'] || {};
    if (!currentLocation) {
      showCustomAlert(
        dict.coastDistNoLocationTitle || '現在地が未取得',
        dict.coastDistNoLocationDesc || '「現在地」ボタンで位置情報を取得してから再度お試しください。',
        'info'
      );
      return;
    }
    if (_coastDistActive) {
      clearCoastDistOverlay();
      return;
    }
    try { showTendenLoading(dict.coastLoadingMsg || '海岸距離を計算中…', 60000); } catch (e) {}
    try {
      await drawProximityToCoastline(currentLocation);
    } finally {
      try { hideTendenLoading(); } catch (e) {}
    }
  }

  async function drawProximityToCoastline(loc) {
    clearCoastDistOverlay();
    const coast = await findNearestCoastline(loc);
    const dict = i18nDict[getLanguageCode()] || i18nDict['ja'] || {};
    if (!coast) {
      showCustomAlert(
        dict.coastDistNoDataTitle || '海岸線データ未取得',
        dict.coastDistNoDataDesc || '現在地付近の海岸線データを取得できませんでした。オンライン環境で再度お試しください。',
        'info'
      );
      return null;
    }
    if (!map) return coast;

    const distM = Math.round(coast.distance);
    const distText = distM >= 1000 ? `${(distM / 1000).toFixed(1)}km` : `${distM}m`;
    const startLatLng = [loc.lat, loc.lng];
    const endLatLng = [coast.lat, coast.lng];

    coastDistLayerGroup = L.layerGroup().addTo(map);

    const line = L.polyline([startLatLng, endLatLng], {
      color: '#ff2d55',
      dashArray: '8, 8',
      weight: 4,
      opacity: 0.85,
      className: 'coastal-proximity-line'
    }).addTo(coastDistLayerGroup);
    line.on('click', clearCoastDistOverlay);

    const badgeTpl = dict.coastDistLineBadge || '海岸線 {dist}';
    const shorelineIcon = L.divIcon({
      className: 'shoreline-icon-container',
      html: '<div class="shoreline-badge">' + badgeTpl.replace('{dist}', distText) + '</div>',
      iconSize: [140, 24],
      iconAnchor: [70, 12]
    });
    L.marker(endLatLng, { icon: shorelineIcon, interactive: false }).addTo(coastDistLayerGroup);

    L.circleMarker(startLatLng, {
      radius: 6,
      color: '#fff',
      weight: 2,
      fillColor: '#007aff',
      fillOpacity: 1,
      interactive: true
    }).addTo(coastDistLayerGroup).on('click', onLineDismiss);

    try {
      map.fitBounds(L.latLngBounds([startLatLng, endLatLng]), {
        padding: [80, 80],
        maxZoom: 16,
        animate: true,
        duration: 0.8
      });
    } catch (e) {}

    _coastDistActive = true;
    document.querySelectorAll('[data-trigger="btn-coastline-dist"]').forEach(function (el) {
      el.classList.add('dock-coast-active');
      el.setAttribute('aria-pressed', 'true');
    });
    updateCoastDistDockLabels(true);
    setCoastDistDismissChipVisible(true);
    if (typeof setAgentForFeature === 'function') setAgentForFeature('coast-dist', undefined, { persist: true });

    const islandMsg = (dict.coastDistIslandMsg || '海岸線まで {dist}').replace('{dist}', distText);
    triggerDynamicIsland(islandMsg, distM < 500 ? 'warning' : 'info');

    const dismissHint = dict.coastDistDismissHint || 'もう一度タップで解除';
    setTimeout(function () {
      if (!_coastDistActive) return;
      if (typeof showAgentBubble === 'function') {
        showAgentBubble(dismissHint, { type: 'info', duration: 7000, feature: 'coast-dist' });
      }
    }, 4800);

    return coast;
  }



function resolveDemoLangDict() {
  try {
    var lang = (localStorage.getItem('tenden-lang') === 'auto' || !localStorage.getItem('tenden-lang'))
      ? (navigator.language || 'ja').split('-')[0]
      : localStorage.getItem('tenden-lang');
    return (typeof i18nDict !== 'undefined' && i18nDict[lang]) || {};
  } catch (e) { return {}; }
}

function getOnboardingAgentText(step) {
  var dict = resolveDemoLangDict();
  var key = 'onboardingAgentStep' + step;
  return dict[key] || ONBOARDING_AGENT_FALLBACKS[step] || ONBOARDING_AGENT_FALLBACKS[0];
}

function getAgentHomeContainer() {
  return document.getElementById('app-container');
}

function reparentAgentToMainApp(agent) {
  var home = getAgentHomeContainer();
  if (!agent || !home) return false;
  var anchor = document.getElementById('crosshair-target');
  if (_onboardingAgentParent && _onboardingAgentParent !== agent.parentNode && _onboardingAgentParent.id === 'app-container') {
    try {
      if (_onboardingAgentNext && _onboardingAgentNext.parentNode === _onboardingAgentParent) {
        _onboardingAgentParent.insertBefore(agent, _onboardingAgentNext);
      } else {
        _onboardingAgentParent.appendChild(agent);
      }
      return true;
    } catch (e) { /* fall through to anchor insert */ }
  }
  if (anchor && anchor.parentNode === home) {
    home.insertBefore(agent, anchor);
  } else {
    home.appendChild(agent);
  }
  return true;
}

function resetAgentMainAppStyles(agent) {
  if (!agent) return;
  ['transform', 'top', 'right', 'bottom', 'left', 'opacity', 'visibility'].forEach(function (prop) {
    agent.style.removeProperty(prop);
  });
}

function setOnboardingDemoActive(active) {
  document.body.classList.toggle('onboarding-demo-active', !!active);
  if (active) {
    dockAgentForOnboarding();
  } else {
    undockAgentFromOnboarding();
  }
}

function dockAgentForOnboarding() {
  var agent = document.getElementById('tenden-agent');
  var overlay = document.getElementById('onboarding-overlay');
  if (!agent || !overlay || agent.dataset.onboardingDocked === '1') return;
  _onboardingAgentParent = agent.parentNode;
  _onboardingAgentNext = agent.nextSibling;
  overlay.appendChild(agent);
  agent.dataset.onboardingDocked = '1';
  agent.classList.add('tenden-agent--onboarding');
}

function undockAgentFromOnboarding() {
  var agent = document.getElementById('tenden-agent');
  var overlay = document.getElementById('onboarding-overlay');
  if (!agent) return;
  var inOverlay = !!(overlay && agent.parentNode === overlay);
  var wasDocked = agent.dataset.onboardingDocked === '1';
  if (!inOverlay && !wasDocked) return;

  agent.classList.remove('tenden-agent--onboarding');
  if (inOverlay) {
    reparentAgentToMainApp(agent);
  } else if (_onboardingAgentParent) {
    try {
      if (_onboardingAgentNext && _onboardingAgentNext.parentNode === _onboardingAgentParent) {
        _onboardingAgentParent.insertBefore(agent, _onboardingAgentNext);
      } else {
        _onboardingAgentParent.appendChild(agent);
      }
    } catch (e) {
      reparentAgentToMainApp(agent);
    }
  }
  resetAgentMainAppStyles(agent);
  delete agent.dataset.onboardingDocked;
  _onboardingAgentParent = null;
  _onboardingAgentNext = null;
}

function applyOnboardingAgentStep(step) {
  var cfg = ONBOARDING_AGENT_CFG[step];
  if (!cfg) return;
  setOnboardingDemoActive(true);
  var msg = getOnboardingAgentText(step);
  if (typeof showAgentBubble === 'function') {
    showAgentBubble(msg, { type: cfg.type, persist: true, feature: cfg.feature, syncState: false });
  }
  if (typeof setAgentForFeature === 'function') {
    setAgentForFeature(cfg.feature, msg, { persist: true });
  }
}

function teardownOnboardingAgent() {
  setOnboardingDemoActive(false);
  undockAgentFromOnboarding();
  if (typeof dismissAgentBubble === 'function') dismissAgentBubble();
  if (typeof setAgentForFeature === 'function') {
    setAgentForFeature('default', undefined, { persist: true });
  }
}

function finishOnboardingDemo() {
  teardownOnboardingAgent();
  var overlay = document.getElementById('onboarding-overlay');
  if (overlay) {
    overlay.classList.remove('active');
    setTimeout(function () {
      undockAgentFromOnboarding();
      overlay.classList.add('hidden');
    }, 300);
  }
  try {
    localStorage.setItem('tenden-demo-seen', 'true');
  } catch (e) {}
  setTimeout(function () {
    try { showStartupNoticeIfNeeded(); } catch (e) {}
    try {
      if (typeof updateSafeZoneGuideVisibility === 'function') updateSafeZoneGuideVisibility();
    } catch (e) {}
  }, 600);
}

// ── 学ぶドックからデモを再再生 ───────────────────────────────────────
function replayOnboardingDemo() {
  teardownOnboardingAgent();
  try { localStorage.removeItem('tenden-demo-seen'); } catch (e) {}
  try { sessionStorage.removeItem('tenden-demo-skipped'); } catch (e) {}
  if (typeof window.closeDockSub === 'function') window.closeDockSub();
  document.querySelectorAll('.overlay').forEach(function (el) {
    if (el.id !== 'onboarding-overlay') {
      el.classList.remove('active');
      el.classList.add('hidden');
    }
  });
  var demoOv = document.getElementById('onboarding-overlay');
  if (!demoOv) { console.error('[TENDEN] onboarding-overlay not found'); return; }
  document.querySelectorAll('.demo-step').forEach(function (el) { el.classList.remove('active'); });
  var s0 = document.getElementById('demo-step-0');
  if (s0) s0.classList.add('active');
  document.querySelectorAll('.demo-dot').forEach(function (d, i) { d.classList.toggle('active', i === 0); });
  demoOv.style.zIndex = '99998';
  demoOv.classList.remove('hidden');
  demoOv.classList.remove('active');
  setTimeout(function () {
    demoOv.classList.add('active');
    applyOnboardingAgentStep(0);
    if (typeof initDemoQuakeMap === 'function') {
      setTimeout(function () { initDemoQuakeMap(); }, 400);
    }
  }, 50);
}

// ── 避難ナビ安否共有（#btn-share）── document 委譲で Web Share を確実に起動
function wireShareSafetyNavButton() {
  if (document.documentElement.dataset.navShareDelegated === '1') return;
  document.documentElement.dataset.navShareDelegated = '1';

  function onNavShare(e) {
    var btn = e.target && e.target.closest ? e.target.closest('#btn-share') : null;
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    if (typeof triggerHapticTick === 'function') triggerHapticTick();
    shareSafetyStatus();
  }

  document.addEventListener('click', onNavShare, true);
  document.addEventListener('touchend', function (e) {
    var btn = e.target && e.target.closest ? e.target.closest('#btn-share') : null;
    if (!btn) return;
    e.preventDefault();
    onNavShare(e);
  }, { capture: true, passive: false });
}

// ── 訓練終了ボタン（#btn-reset-alert / #ep-end-drill）── document 委譲で確実に動作
function wireEndDrillButton() {
  if (document.documentElement.dataset.endDrillDelegated === '1') return;
  document.documentElement.dataset.endDrillDelegated = '1';

  function onEndDrill(e) {
    var btn = e.target && e.target.closest ? e.target.closest('#btn-reset-alert, #ep-end-drill') : null;
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    endDrillTraining();
  }

  document.addEventListener('click', onEndDrill, true);
  document.addEventListener('touchend', function (e) {
    var btn = e.target && e.target.closest ? e.target.closest('#btn-reset-alert, #ep-end-drill') : null;
    if (!btn) return;
    e.preventDefault();
    onEndDrill(e);
  }, { capture: true, passive: false });

  ['btn-reset-alert', 'ep-end-drill'].forEach(function (id) {
    var el = document.getElementById(id);
    if (el) el.dataset.endDrillWired = '1';
  });
}

// ── 利用規約 同意ゲート ──────────────────────────────────────────────
// オンボーディング序盤（step0の次）に挟む必須関門。同意済みでない限り、
// requireTosThen() でラップされた遷移は必ずこのゲートで止まる。
// 一度同意すればlocalStorageに記録され、以後の再訪問では再表示しない。
var _tosGatePendingAction = null;
var TOS_VERSION = (window.TENDEN_CONFIG && window.TENDEN_CONFIG.termsVersion) || '1.0';

function isTosAgreed() {
  try {
    if (localStorage.getItem('tenden-tos-agreed') !== '1') return false;
    var agreedVersion = localStorage.getItem('tenden-tos-agreed-version');
    // Existing v1.0 users already agreed to the same text before versioned
    // metadata was introduced. Migrate them without showing the gate again.
    if (!agreedVersion) {
      localStorage.setItem('tenden-tos-agreed-version', TOS_VERSION);
      localStorage.setItem('tenden-tos-agreement-migrated', '1');
      return true;
    }
    return agreedVersion === TOS_VERSION;
  } catch (e) { return false; }
}

function markTosAgreed() {
  try {
    localStorage.setItem('tenden-tos-agreed', '1');
    localStorage.setItem('tenden-tos-agreed-version', TOS_VERSION);
    localStorage.setItem('tenden-tos-agreed-at', new Date().toISOString());
    localStorage.removeItem('tenden-tos-agreement-migrated');
  } catch (e) {}
}

function syncTosGateScrollCue() {
  var body = document.getElementById('tos-gate-body');
  var cue = document.getElementById('tos-gate-scroll-cue');
  if (!body || !cue) return;
  var hasMore = body.scrollHeight > body.clientHeight + 8 && body.scrollTop + body.clientHeight < body.scrollHeight - 12;
  cue.classList.toggle('is-complete', !hasMore);
}

function _resetTosGateInteractiveState() {
  document.querySelectorAll('.tos-gate-item-check').forEach(function (el) {
    el.checked = false;
    el.disabled = false;
  });
  var cb = document.getElementById('tos-gate-checkbox');
  if (cb) { cb.checked = false; cb.disabled = true; }
  var declineBtn = document.getElementById('tos-gate-decline');
  if (declineBtn) declineBtn.style.display = '';
  var agreeBtn = document.getElementById('tos-gate-agree');
  if (agreeBtn) { agreeBtn.textContent = '同意してTENDENを開始する'; agreeBtn.disabled = true; agreeBtn.style.opacity = '0.5'; }
}

function showTosGate(onAgree) {
  var ov = document.getElementById('tos-gate-overlay');
  if (!ov) { if (onAgree) onAgree(); return; } // ゲートDOMが無い場合は素通りさせる（安全側フォールバック）
  _tosGatePendingAction = onAgree;
  _resetTosGateInteractiveState();
  var body = document.getElementById('tos-gate-body');
  if (body) body.scrollTop = 0;
  document.getElementById('tos-gate-decline-panel')?.classList.add('hidden');
  ov.classList.remove('hidden');
  setTimeout(function () { ov.classList.add('active'); syncTosGateScrollCue(); }, 10);
}

// 既に同意済みの利用者が「設定」から規約を読み返すための閲覧専用モード。
// 同意操作としては扱わない（すべてチェック済み・操作不可で表示するだけ）。
function showTosGateReadOnly() {
  var ov = document.getElementById('tos-gate-overlay');
  if (!ov) return;
  _tosGatePendingAction = null;
  var body = document.getElementById('tos-gate-body');
  if (body) body.scrollTop = 0;
  document.querySelectorAll('.tos-gate-item-check').forEach(function (el) {
    el.checked = true;
    el.disabled = true;
  });
  var cb = document.getElementById('tos-gate-checkbox');
  if (cb) { cb.checked = true; cb.disabled = true; }
  var declineBtn = document.getElementById('tos-gate-decline');
  if (declineBtn) declineBtn.style.display = 'none';
  var agreeBtn = document.getElementById('tos-gate-agree');
  if (agreeBtn) { agreeBtn.textContent = '閉じる'; agreeBtn.disabled = false; agreeBtn.style.opacity = '1'; }
  document.getElementById('tos-gate-decline-panel')?.classList.add('hidden');
  ov.classList.remove('hidden');
  setTimeout(function () { ov.classList.add('active'); syncTosGateScrollCue(); }, 10);
}

// 同意済みならそのまま action() を実行、未同意ならゲートを表示して待つ。
// オンボーディングの遷移（次へ／スキップ／ドット）はすべてこれ経由にする。
function requireTosThen(action) {
  if (isTosAgreed()) { action(); return; }
  showTosGate(action);
}

function wireTosGate() {
  var ov = document.getElementById('tos-gate-overlay');
  var itemChecks = document.querySelectorAll('.tos-gate-item-check');
  var cb = document.getElementById('tos-gate-checkbox');
  var agreeBtn = document.getElementById('tos-gate-agree');
  var declineBtn = document.getElementById('tos-gate-decline');
  var declinePanel = document.getElementById('tos-gate-decline-panel');
  var closeTabBtn = document.getElementById('tos-gate-close-tab');
  var openPrivacyBtn = document.getElementById('tos-gate-open-privacy');
  var privacyLink = document.getElementById('tos-gate-privacy-link');
  var scrollBody = document.getElementById('tos-gate-body');
  var scrollCue = document.getElementById('tos-gate-scroll-cue');
  if (!ov || !cb || !agreeBtn) return;

  if (scrollBody) scrollBody.addEventListener('scroll', syncTosGateScrollCue, { passive: true });
  if (scrollCue && scrollBody) scrollCue.addEventListener('click', function () {
    scrollBody.scrollBy({ top: Math.max(180, scrollBody.clientHeight * 0.72), behavior: 'smooth' });
    setTimeout(syncTosGateScrollCue, 360);
  });
  ov.querySelectorAll('details').forEach(function (details) {
    details.addEventListener('toggle', function () { setTimeout(syncTosGateScrollCue, 20); });
  });

  function allItemsChecked() {
    for (var i = 0; i < itemChecks.length; i++) {
      if (!itemChecks[i].checked) return false;
    }
    return true;
  }

  // 6項目すべてにチェックが入るまで、最終確認チェックボックス自体を操作不能にする。
  itemChecks.forEach(function (item) {
    item.addEventListener('change', function () {
      var ready = allItemsChecked();
      cb.disabled = !ready;
      if (!ready) {
        cb.checked = false;
        agreeBtn.disabled = true;
        agreeBtn.style.opacity = '0.5';
      }
    });
  });

  cb.addEventListener('change', function () {
    agreeBtn.disabled = !cb.checked;
    agreeBtn.style.opacity = cb.checked ? '1' : '0.5';
  });

  agreeBtn.addEventListener('click', function () {
    if (!cb.checked || !allItemsChecked()) return;
    markTosAgreed();
    ov.classList.remove('active');
    setTimeout(function () { ov.classList.add('hidden'); }, 300);
    var action = _tosGatePendingAction;
    _tosGatePendingAction = null;
    if (typeof action === 'function') action();
  });

  if (declineBtn) declineBtn.addEventListener('click', function () {
    if (declinePanel) declinePanel.classList.remove('hidden');
  });

  if (closeTabBtn) closeTabBtn.addEventListener('click', function () {
    // window.close() はスクリプトで開いたタブにしか効かないブラウザが多く、
    // 通常のタブでは何も起きないことがある（declinePanel の案内文で代替）。
    window.close();
  });

  if (openPrivacyBtn) openPrivacyBtn.addEventListener('click', function () {
    openPrivacyPolicyOverlay();
  });
  if (privacyLink) privacyLink.addEventListener('click', function (e) {
    e.preventDefault();
    openPrivacyPolicyOverlay();
  });
}

function openPrivacyPolicyOverlay() {
  var ov = document.getElementById('privacy-policy-overlay');
  if (!ov) return;
  ov.classList.remove('hidden');
  setTimeout(function () { ov.classList.add('active'); }, 10);
}

function closePrivacyPolicyOverlay() {
  var ov = document.getElementById('privacy-policy-overlay');
  if (!ov) return;
  ov.classList.remove('active');
  setTimeout(function () { ov.classList.add('hidden'); }, 300);
}

function wirePrivacyPolicyOverlay() {
  var closeBtn = document.getElementById('btn-privacy-policy-close');
  if (closeBtn) closeBtn.addEventListener('click', closePrivacyPolicyOverlay);
  var ov = document.getElementById('privacy-policy-overlay');
  if (ov) ov.addEventListener('click', function (e) {
    if (e.target === ov) closePrivacyPolicyOverlay();
  });
}

// ── オンボーディングボタンの安全な直接配線 ──────────────────────────
// startOnboardingDemo 内でエラーが起きても必ずボタンが機能するフォールバック。
function wireOnboardingButtons() {
  function closeFB() {
    finishOnboardingDemo();
  }
  function goFB(step) {
    document.querySelectorAll('.demo-step').forEach(function(el) { el.classList.remove('active'); });
    var t = document.getElementById('demo-step-' + step);
    if (t) t.classList.add('active');
    document.querySelectorAll('.demo-dot').forEach(function(d, i) { d.classList.toggle('active', i === step); });
    applyOnboardingAgentStep(step);
    if (step === 1 && typeof initDemoQuakeMap === 'function') {
      requestAnimationFrame(function() { initDemoQuakeMap(); });
    } else if (step !== 1 && typeof destroyDemoQuakeMap === 'function') {
      destroyDemoQuakeMap();
    }
  }
  [
    ['btn-demo-next-0', function() { requireTosThen(function(){ goFB(1); }); }],
    ['btn-demo-skip-0', function() { requireTosThen(function(){ closeFB(); showLocationExplanation(requestLocation); }); }],
    ['btn-demo-next-1', function() { goFB(2); }],
    ['btn-demo-skip-1', function() { closeFB(); showLocationExplanation(requestLocation); }],
    ['btn-demo-next-2', function() { goFB(3); }],
    ['btn-demo-skip-2', function() { closeFB(); showLocationExplanation(requestLocation); }],
    ['btn-demo-use-here', function() { closeFB(); showLocationExplanation(requestLocation); }],
    ['btn-demo-replay', function() { goFB(0); }],
  ].forEach(function(pair) {
    var el = document.getElementById(pair[0]);
    if (!el) return;
    // startOnboardingDemo() が正常に配線済みなら、cloneNode で
    // 正規ハンドラ（アニメーション後始末等を含む）を消さずそのまま使う。
    if (el.dataset.onboardingWired === '1') return;
    var fresh = el.cloneNode(true);
    el.parentNode.replaceChild(fresh, el);
    fresh.addEventListener('click', pair[1]);
    fresh.addEventListener('touchend', function(e) { e.preventDefault(); pair[1](); });
  });
}

 function destroyDemoQuakeMap() {
  if (demoQuakeMap) {
   demoQuakeMap.remove();
   demoQuakeMap = null;
  }
 }

 function initDemoQuakeMap() {
  const container = document.getElementById('demo-quake-map');
  if (!container) return;
  if (typeof window.L === 'undefined') {
   container.classList.add('demo-quake-map--fallback');
   container.textContent = '地図を読み込めませんでした。案内はそのまま続けられます。';
   return;
  }
  container.classList.remove('demo-quake-map--fallback');
  container.textContent = '';
  if (demoQuakeMap) {
   requestAnimationFrame(() => {
    if (!demoQuakeMap) return;
    demoQuakeMap.invalidateSize();
    demoQuakeMap.setView(DEMO_QUAKE_FLOOD_POINT, 14, { animate: false });
   });
   return;
  }

  demoQuakeMap = L.map(container, {
   zoomControl: false,
   attributionControl: false,
   dragging: false,
   scrollWheelZoom: false,
   doubleClickZoom: false,
   boxZoom: false,
   keyboard: false,
   touchZoom: false
  }).setView(DEMO_QUAKE_FLOOD_POINT, 13);

  L.tileLayer(GSI_PALE_TILE_URL, {
   maxNativeZoom: 18,
   maxZoom: 19,
   attribution: '地理院タイル（淡色地図）'
  }).addTo(demoQuakeMap);

  const icon = L.divIcon({
   className: 'demo-quake-marker',
   html: `<div class="demo-flood-marker">
    <div class="flood-ring flood-ring-1"></div>
    <div class="flood-ring flood-ring-2"></div>
    <div class="flood-pin"></div>
   </div>`,
   iconSize: [56, 56],
   iconAnchor: [28, 28]
  });
  L.marker(DEMO_QUAKE_FLOOD_POINT, { icon, interactive: false }).addTo(demoQuakeMap);

  requestAnimationFrame(() => {
   if (!demoQuakeMap) return;
   demoQuakeMap.invalidateSize();
   demoQuakeMap.setView(DEMO_QUAKE_FLOOD_POINT, 14, { animate: true });
  });
 }


 // ─── canvasアニメーション関数（DOMContentLoaded スコープ）───────────────
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


function startOnboardingDemo() {
 const overlay = document.getElementById('onboarding-overlay');
 if (!overlay) return;

 // Show agent-guided intro on every page load/reload (returning users included).
 // tenden-demo-seen remains for replay/settings only.
 // In-memory guard prevents duplicate init if startOnboardingDemo runs twice on same load.
 try { sessionStorage.removeItem('tenden-demo-skipped'); } catch (e) {}
 if (_onboardingStartedThisLoad) return;
 _onboardingStartedThisLoad = true;

 overlay.classList.remove('hidden');
 overlay.classList.add('active');
 setOnboardingDemoActive(true);

 let currentStep = 0;
 const totalSteps = 4;

 // 笏笏 i18n helper (uses global i18nDict once loaded)
 function getDemoText(key, fallback) {
 try {
 const lang = (localStorage.getItem('tenden-lang') === 'auto' || !localStorage.getItem('tenden-lang'))
 ? (navigator.language || 'ja').split('-')[0]
 : localStorage.getItem('tenden-lang');
 const dict = (typeof i18nDict !== 'undefined' && i18nDict[lang]) || {};
 if (dict[key]) return dict[key];

 return fallback;
 } catch (e) { return fallback; }
 }

 // 笏笏 Apply i18n to all demo text nodes
 function applyDemoI18n() {
 const elStep0Title = document.getElementById('demo-title-0');
 const elStep0Sub = document.getElementById('demo-sub-0');
 const elStep1Title = document.getElementById('demo-title-1');
 const elStep1DrillNotice = document.getElementById('demo-drill-notice-1');
 const elStep1Desc = document.getElementById('demo-desc-1');
 const elStep2Title = document.getElementById('demo-title-2');
 const elStep2Desc = document.getElementById('demo-desc-2');
 const elStep3Title = document.getElementById('demo-title-3');
 const elStep3Desc = document.getElementById('demo-desc-3');

  if (elStep0Title) elStep0Title.textContent = getDemoText('demoStep0Title', '津波から命を守るために');
  if (elStep0Sub) elStep0Sub.textContent = getDemoText('demoStep0Sub', '日本全国の沿岸エリアで使える避難支援アプリ');
  if (elStep1Title) elStep1Title.textContent = getDemoText('demoStep1Title', '地震が発生しました');
  if (elStep1DrillNotice) elStep1DrillNotice.textContent = getDemoText('demoStep1DrillNotice', '※これは訓練です。架空のシナリオです。');
  if (elStep1Desc) elStep1Desc.textContent = getDemoText('demoStep1Desc', '津波の危険があります。今すぐ避難を開始してください。');
  if (elStep2Title) elStep2Title.textContent = getDemoText('demoStep2Title', '2つの避難ルートから選べます');
  if (elStep2Desc) elStep2Desc.textContent = getDemoText('demoStep2Desc', '高台へ向かう経路と、坂のゆるやかな要配慮者向けの経路。正解は押し付けず、あなたが選びます。');
  if (elStep3Title) elStep3Title.textContent = getDemoText('demoStep3Title', '混雑も、歩く前に予習できます');
  if (elStep3Desc) elStep3Desc.textContent = getDemoText('demoStep3Desc', '時間とともに変わる人の流れと道路の混雑を追体験。各地点で気をつけることまで学べます。');

 // Next/skip buttons
 document.querySelectorAll('[data-i18n="demoBtnSkip"]').forEach(el => {
    el.textContent = getDemoText('demoBtnSkip', 'スキップ');
 });
  const useHereSpan = document.querySelector('[data-i18n="demoBtnUseHere"]');
  const replaySpan = document.querySelector('[data-i18n="demoBtnReplay"]');
  if (useHereSpan) useHereSpan.textContent = getDemoText('demoBtnUseHere', '今いる場所で使ってみる');
  if (replaySpan) replaySpan.textContent = getDemoText('demoBtnReplay', 'もう一度見る');

  const etaEl = document.getElementById('demo-quake-eta');
  if (etaEl) {
   const etaLabel = getDemoText('etaLabel', 'モデル参考時間(到達まで):').replace(/:$/, '');
   etaEl.innerHTML = `${etaLabel} <strong>約15分</strong>`;
  }
 }

 // Apply i18n immediately (may use fallbacks), then re-apply when i18n loads
 applyDemoI18n();
 // Re-apply after 1s to catch i18n async load
 setTimeout(applyDemoI18n, 1200);


 // 笏笏 Step navigation
 function goToStep(step) {
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

 if (step === 1) {
  requestAnimationFrame(() => initDemoQuakeMap());
 } else {
  destroyDemoQuakeMap();
 }
 // Update dots
 document.querySelectorAll('.demo-dot').forEach((dot, i) => {
 dot.classList.toggle('active', i === step);
 });

 currentStep = step;

 applyOnboardingAgentStep(step);

 // Canvas animations removed — visuals are now CSS/SVG driven
 }

 function closeDemo() {
 if (mapAnimFrame) { cancelAnimationFrame(mapAnimFrame); mapAnimFrame = null; }
 if (routesAnimFrame) { cancelAnimationFrame(routesAnimFrame); routesAnimFrame = null; }
 if (flowAnimFrame) { cancelAnimationFrame(flowAnimFrame); flowAnimFrame = null; }
 destroyDemoQuakeMap();
 finishOnboardingDemo();
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

 if (btn0Next) btn0Next.addEventListener('click', () => requireTosThen(() => goToStep(1)));
 if (btn0Skip) btn0Skip.addEventListener('click', () => requireTosThen(() => { closeDemo(); showLocationExplanation(requestLocation); }));
 if (btn1Next) btn1Next.addEventListener('click', () => goToStep(2));
 if (btn1Skip) btn1Skip.addEventListener('click', () => { closeDemo(); showLocationExplanation(requestLocation); });
 if (btn2Next) btn2Next.addEventListener('click', () => goToStep(3));
 if (btn2Skip) btn2Skip.addEventListener('click', () => { closeDemo(); showLocationExplanation(requestLocation); });
 if (btnReplay) btnReplay.addEventListener('click', () => goToStep(0));
 if (btnUse) btnUse.addEventListener('click', () => { closeDemo(); showLocationExplanation(requestLocation); });

 // wireOnboardingButtons()（フォールバック配線）がこの正規ハンドラを
 // cloneNode で silently 上書きしないよう、配線済みを明示しておく。
 [btn0Next, btn0Skip, btn1Next, btn1Skip, btn2Next, btn2Skip, btnUse, btnReplay].forEach(function (el) {
   if (el) el.dataset.onboardingWired = '1';
 });

 // Dot clicks
 document.querySelectorAll('.demo-dot').forEach(dot => {
 dot.addEventListener('click', () => {
 const step = parseInt(dot.dataset.step);
 if (isNaN(step)) return;
 if (step > 0) requireTosThen(() => goToStep(step));
 else goToStep(step);
 });
 });

 // 笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏
 // STEP 1: Map Canvas 窶・zoom-in effect + earthquake epicenter
 // 笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏

 // Start on step 0 — user taps primary CTA to advance each step
 goToStep(0);

 console.log('[TENDEN] Onboarding demo started (manual advance).');
}

 try { startOnboardingDemo(); } catch(e) { console.error('[TENDEN] onboarding error:', e); }
 try { wireOnboardingButtons(); } catch(e) {}

  // --- HOME SCREEN ADD GUIDE (manual, no auto-prompt) ---
  setupHomeGuide();

  function setupHomeGuide() {
    const modal = document.getElementById('home-guide-modal');
    const btnShow = document.getElementById('btn-show-home-guide');
    const btnClose = document.getElementById('btn-home-guide-close');

    if (btnShow) {
      btnShow.addEventListener('click', () => {
        // 設定パネルを閉じてからガイドを表示
        const settingsOverlay = document.getElementById('settings-overlay');
        if (settingsOverlay) {
          settingsOverlay.classList.remove('active');
          setTimeout(() => settingsOverlay.classList.add('hidden'), 300);
        }
        setTimeout(() => {
          if (typeof window.tendenShowInstallGuide === 'function') {
            window.tendenShowInstallGuide();
          } else {
            // fallback: モーダルを直接表示
            const m = document.getElementById('ios-guide-modal');
            if (m) m.classList.add('active');
          }
        }, 350);
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
