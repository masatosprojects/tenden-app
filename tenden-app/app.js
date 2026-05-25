// app.js
document.addEventListener('DOMContentLoaded', () => {
    // Basic state
    let isEmergency = false;
    let map, userMarker, routeLayerGroup, hazardLayer, sheltersLayerGroup, congestionLayer;
    let currentLocation = null; // {lat, lng}
    let simulationInterval = null;
    let mainRouteLine = null;
    let activeScenarioId = 1;
    let activeLocationId = 'a';
    let sheltersData = [];
    // Simulation-derived data
    let routeData = {};  // loaded from assets/routes.json
    let pendingRouteArgs = null; // {scenarioId, locationId, scLoc} while route modal is open
    
    // Kamakura default location (Yuigahama)
    const KAMAKURA_CENTER = [35.3111, 139.5467];

    // Dictionary for i18n
    const i18nDict = {
        'en': {
            onboardingTitle: "We will guide you to the nearest<br>safe location.",
            onboardingDesc: "Please allow location access to check your daily preparation and clear routes.",
            okBtn: "OK",
            errorTitle: "Location Unavailable",
            errorDesc: "Please move the map to set a pin at your location.",
            errorBtn: "Set Manually",
            elevationLabel: "Current Elevation",
            testAlert: "Test Alert",
            evacTitle: "Evacuation Order Issued",
            evacDesc: "Follow the blue route to higher ground",
            shareBtn: "Share Status",
            settingsTitle: "Settings",
            langLabel: "Language",
            langAuto: "Auto",
            dataLabel: "Data Management",
            clearCacheBtn: "Clear Offline Data",
            estTime: "Est. Arrival:",
            estHeight: "Est. Height:",
            scenarioTitle: "Select Simulation Scenario",
            scenarioDesc: "Please select a demonstration disaster scenario.",
            resetAlert: "End Drill"
        },
        'zh': {
            onboardingTitle: "我们将引导您前往最近的<br>安全地点。",
            onboardingDesc: "请允许访问位置信息，以检查您的日常准备和明确的路线。",
            okBtn: "确定",
            errorTitle: "无法获取位置信息",
            errorDesc: "请移动地图并在您所在的位置设置图钉。",
            errorBtn: "手动设置",
            elevationLabel: "当前海拔",
            testAlert: "测试警报",
            evacTitle: "避难指示已发布",
            evacDesc: "请沿着蓝色路线向高处避难",
            shareBtn: "分享状态",
            settingsTitle: "设置",
            langLabel: "语言",
            langAuto: "自动",
            dataLabel: "数据管理",
            clearCacheBtn: "清除离线数据",
            estTime: "预计到达时间:",
            estHeight: "预计高度:",
            scenarioTitle: "选择模拟防灾演练",
            scenarioDesc: "请选择演示用的灾害场景。",
            resetAlert: "结束演练"
        },
        'ko': {
            onboardingTitle: "가장 가까운 안전한 장소로<br>안내해 드립니다.",
            onboardingDesc: "위치 정보 액세스를 허용하여 일상적인 준비와 대피 경로를 확인하십시오.",
            okBtn: "확인",
            errorTitle: "위치 정보를 사용할 수 없음",
            errorDesc: "지도를 이동하여 현재 위치에 핀을 설정하십시오.",
            errorBtn: "수동으로 설정",
            elevationLabel: "현재 해발",
            testAlert: "테스트 경보",
            evacTitle: "대피 지시 발령됨",
            evacDesc: "파란색 경로를 따라 고지대로 대피하십시오",
            shareBtn: "안부 공유",
            settingsTitle: "설정",
            langLabel: "언어",
            langAuto: "자동",
            dataLabel: "데이터 관리",
            clearCacheBtn: "오프ライン 데이터 삭제",
            estTime: "예상 도착 시간:",
            estHeight: "예상 높이:",
            scenarioTitle: "대피 시뮬레이션 선택",
            scenarioDesc: "데모용 재해 시나리오를 선택하십시오.",
            resetAlert: "훈련 종료"
        }
    };

    // Initialize Map
    initMap();
    initUI();
    updateDate();
    initI18n();
    connectP2PQuake();

    // Load simulation-derived route data
    fetch('assets/routes.json')
        .then(res => res.json())
        .then(data => { routeData = data; console.log('[TENDEN] routes.json 読み込み完了'); })
        .catch(e => console.log('[TENDEN] routes.json なし (fallback to static routes)', e));

    // Remove Splash Screen after initial load (1000ms animation + 500ms wait = 1500ms total)
    setTimeout(() => {
        const splash = document.getElementById('splash-screen');
        if (splash) {
            splash.style.opacity = '0';
            setTimeout(() => splash.style.display = 'none', 500);
        }
    }, 1500);

    // Register Service Worker
    if ('serviceWorker' in navigator) {
        window.addEventListener('load', () => {
            navigator.serviceWorker.register('sw.js').catch(err => {
                console.log('SW registration failed: ', err);
            });
        });
    }

    function initMap() {
        map = L.map('map', {
            zoomControl: false,
            attributionControl: false
        }).setView(KAMAKURA_CENTER, 14);

        // OSM Light style for Normal mode
        L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
            maxZoom: 19
        }).addTo(map);

        L.control.attribution({
            position: 'bottomleft',
            prefix: '出典: <a href="https://disaportal.gsi.go.jp/" target="_blank">ハザードマップポータルサイト</a> (国土地理院) | Leaflet'
        }).addTo(map);

        routeLayerGroup = L.layerGroup().addTo(map);

        // Official tsunami inundation tile layer (ハザードマップポータルサイト, 国土地理院)
        // Source: https://disaportal.gsi.go.jp/
        // Kanagawa pref. code = 14, zoom range 2–17
        hazardLayer = L.tileLayer(
            'https://disaportaldata.gsi.go.jp/raster/04_tsunami_newlegend_pref_data/14/{z}/{x}/{y}.png',
            {
                minZoom: 2,
                maxZoom: 17,
                opacity: 0.65,
                attribution: '津波浸水想定: <a href="https://disaportal.gsi.go.jp/" target="_blank">ハザードマップポータルサイト</a>'
            }
        );
        // Note: tile layer is instantiated but not added to map until toggle button is activated

        // Initialize Shelter markers — dynamic load from simulation data
        sheltersLayerGroup = L.layerGroup();
        const LOAD_COLORS = { low: '#00a63e', medium: '#f5a623', high: '#c0392b' };
        const LOAD_LABELS = { low: '● 混雑少', medium: '●● やや混雑', high: '●●● 混雑予測' };
        const FALLBACK_SHELTERS = [
            { name: "御成小学校", lat: 35.3190, lng: 139.5510, predicted_load: 'low', capacity: 910, typical_occupancy_pct: 4.7 },
            { name: "鎌倉市役所", lat: 35.3180, lng: 139.5400, predicted_load: 'low', capacity: 1000, typical_occupancy_pct: 0 },
            { name: "甘縄神明宮", lat: 35.3142, lng: 139.5332, predicted_load: 'low', capacity: 500, typical_occupancy_pct: 0 },
            { name: "八幡宮境内", lat: 35.3252, lng: 139.5562, predicted_load: 'low', capacity: 800, typical_occupancy_pct: 0 },
            { name: "清泉小学校", lat: 35.3258, lng: 139.5605, predicted_load: 'low', capacity: 600, typical_occupancy_pct: 0 },
            { name: "鎌倉生涯学習センター", lat: 35.3195, lng: 139.5570, predicted_load: 'low', capacity: 400, typical_occupancy_pct: 0 }
        ];

        function addShelterMarkers(shelterList) {
            shelterList.forEach(s => {
                const load = s.predicted_load || 'low';
                const color = LOAD_COLORS[load] || '#888';
                const label = LOAD_LABELS[load] || '';
                const icon = L.divIcon({
                    className: `shelter-marker shelter-${load}`,
                    html: `<div class="shelter-marker-inner" style="background:${color};border-color:${color}"></div>`,
                    iconSize: [24, 24],
                    iconAnchor: [12, 12]
                });
                const occupancyNote = s.typical_occupancy_pct > 0
                    ? `<br><span style="color:${color};font-size:0.85em">${label} (典型利用率 ${s.typical_occupancy_pct}%)</span>`
                    : '';
                const disclaimer = '<br><em style="font-size:0.78em;opacity:0.7">※シミュレーション統計に基づく予測。リアルタイムデータではありません</em>';
                L.marker([s.lat, s.lng], { icon })
                    .bindPopup(`<strong>${s.name}</strong> (収容 ${s.capacity}人)${occupancyNote}${disclaimer}`)
                    .addTo(sheltersLayerGroup);
            });
        }

        fetch('assets/shelters.json')
            .then(res => res.json())
            .then(data => {
                sheltersData = data;
                addShelterMarkers(data);
                console.log('[TENDEN] shelters.json 読み込み完了:', data.length, '件');
            })
            .catch(() => {
                sheltersData = FALLBACK_SHELTERS;
                addShelterMarkers(FALLBACK_SHELTERS);
                console.log('[TENDEN] shelters.json なし → fallback 使用');
            });

        // Load congestion heatmap from simulation data
        fetch('assets/congestion.geojson')
            .then(res => res.json())
            .then(data => {
                congestionLayer = L.geoJSON(data, {
                    style: f => ({
                        color: LOAD_COLORS[f.properties.level] || '#888888',
                        weight: f.properties.level === 'high' ? 5 : (f.properties.level === 'medium' ? 4 : 2),
                        opacity: f.properties.level === 'high' ? 0.85 : (f.properties.level === 'medium' ? 0.65 : 0.35)
                    })
                });
                const btnToggleLayers = document.getElementById('btn-toggle-layers');
                if (btnToggleLayers && btnToggleLayers.classList.contains('active')) {
                    congestionLayer.addTo(map);
                }
                console.log('[TENDEN] congestion.geojson 読み込み完了:', data.features.length, '件');
            })
            .catch(e => console.log('[TENDEN] congestion.geojson なし', e));

        // Initialize Device Orientation for Compass
        if (window.DeviceOrientationEvent) {
            window.addEventListener('deviceorientationabsolute', handleOrientation, true);
            // Fallback for non-absolute
            window.addEventListener('deviceorientation', handleOrientation, true);
        }

        // Map Click Listener to set custom starting point
        map.on('click', (e) => {
            currentLocation = { lat: e.latlng.lat, lng: e.latlng.lng };
            updateMarker(currentLocation);
            fetchElevation(currentLocation);
            
            // If already in emergency mode, instantly recalculate the evacuation route
            if (isEmergency) {
                recalculateRouteFromLocation(currentLocation);
            }
        });
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
            // Instantly transition to Emergency Mode (Tsunami Evacuation)
            isEmergency = true;
            activeScenarioId = 1;
            activeLocationId = 'a';
            document.body.classList.add('emergency-mode');
            
            document.getElementById('btn-test-alert').classList.add('hidden');
            document.getElementById('btn-sos').classList.remove('hidden');
            document.getElementById('btn-share').classList.remove('hidden');
            document.getElementById('btn-reset-alert').classList.remove('hidden');
            
            // Show the evacuation banner with custom instructions
            const banner = document.getElementById('evacuation-banner');
            banner.classList.remove('hidden');
            
            document.getElementById('i18n-evac-title').innerText = "避難指示（大津波警報）";
            document.getElementById('i18n-evac-desc').innerText = "【ピン打ち待機中】地図上をタップして避難開始位置を設定してください。最寄りの避難所へ誘導します。";
            
            const detailsEl = document.getElementById('disaster-details');
            detailsEl.style.display = 'block';
            detailsEl.innerHTML = `<span>予想到達時間:</span> <strong>15分</strong> | <span>予想高:</span> <strong>10m</strong>`;
            
            // Clear any old route layers & active simulations
            if (routeLayerGroup) routeLayerGroup.clearLayers();
            if (simulationInterval) {
                clearInterval(simulationInterval);
                simulationInterval = null;
            }
            
            showCustomAlert("避難開始地点を選択してください", "「発災避難モード」になりました。\n\n地図上の任意の場所（路地や海岸など）をタップしてピンを打ってください。そこから最も近い避難所への経路を自動計算し、シミュレーションを開始します！", "info");
        });

        // Handle drill reset (End Drill)
        const btnResetAlert = document.getElementById('btn-reset-alert');
        if (btnResetAlert) {
            btnResetAlert.addEventListener('click', () => {
                resetEmergencyMode();
            });
        }

        btnSos.addEventListener('click', () => {
            const flash = document.getElementById('flash-overlay');
            flash.classList.toggle('hidden');
            flash.classList.toggle('flashing');
        });

        btnShare.addEventListener('click', () => {
            if (navigator.share && currentLocation) {
                navigator.share({
                    title: '安否情報 - TENDEN',
                    text: `現在、安全な高台へ避難中です。\n現在地: https://maps.google.com/?q=${currentLocation.lat},${currentLocation.lng}`
                }).catch(console.error);
            } else if (currentLocation) {
                showCustomAlert("安否情報 (現在地)", `コピーして家族や友人に送信してください：\n\nhttps://maps.google.com/?q=${currentLocation.lat},${currentLocation.lng}`, "success");
            } else {
                showCustomAlert("安否情報", "現在地を取得できませんでした。まず地図上をタップして現在地を設定してください。", "warning");
            }
        });

        // Default layers state to active
        btnToggleLayers.classList.add('active');
        if (hazardLayer) hazardLayer.addTo(map);      // official tsunami inundation tiles
        if (sheltersLayerGroup) sheltersLayerGroup.addTo(map);

        btnToggleLayers.addEventListener('click', () => {
            btnToggleLayers.classList.toggle('active');
            const isActive = btnToggleLayers.classList.contains('active');
            if (isActive) {
                if (hazardLayer) hazardLayer.addTo(map);
                if (sheltersLayerGroup) sheltersLayerGroup.addTo(map);
                if (congestionLayer) congestionLayer.addTo(map);
            } else {
                if (hazardLayer) map.removeLayer(hazardLayer);
                if (sheltersLayerGroup) map.removeLayer(sheltersLayerGroup);
                if (congestionLayer) map.removeLayer(congestionLayer);
            }
        });

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
        });

        btnClearCache.addEventListener('click', async () => {
            if ('caches' in window) {
                const keys = await caches.keys();
                for (let key of keys) {
                    await caches.delete(key);
                }
                showCustomAlert("キャッシュ削除完了", "オフラインキャッシュを正常に削除しました。", "success");
            }
        });

        btnScreenshot.addEventListener('click', () => {
            takeScreenshot();
        });

        const btnDevReset = document.getElementById('btn-dev-reset');
        if (btnDevReset) {
            btnDevReset.addEventListener('click', async () => {
                if (confirm('【開発者用】PWAキャッシュとサービスワーカーを完全に削除して再起動しますか？\n(次回読み込み時に最新のコードが強制適用されます)')) {
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
                    
                    showCustomAlert("システムリセット完了", "キャッシュとサービスワーカーのクリアを完了しました。ページを再起動します。", "success", () => {
                        window.location.reload(true);
                    });
                }
            });
        }
    }

    function requestLocation() {
        if ("geolocation" in navigator) {
            navigator.geolocation.getCurrentPosition(
                position => {
                    currentLocation = {
                        lat: position.coords.latitude,
                        lng: position.coords.longitude
                    };
                    map.setView([currentLocation.lat, currentLocation.lng], 16);
                    updateMarker(currentLocation);
                    fetchElevation(currentLocation);
                    
                    // Track location changes
                    navigator.geolocation.watchPosition(pos => {
                        if (isEmergency && !simulationInterval) {
                            currentLocation = {
                                lat: pos.coords.latitude,
                                lng: pos.coords.longitude
                            };
                            updateMarker(currentLocation);
                            checkRouteDeviation(currentLocation);
                        }
                    });
                },
                error => {
                    console.error("Location error:", error);
                    const overlay = document.getElementById('error-overlay');
                    overlay.classList.remove('hidden');
                    setTimeout(() => overlay.classList.add('active'), 10);
                },
                { enableHighAccuracy: true, timeout: 5000 }
            );
        } else {
            const overlay = document.getElementById('error-overlay');
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
            title: "避難指示（大津波警報）",
            time: "15分（15:30）",
            height: "10m",
            locations: {
                'a': {
                    name: "地点A: 由比ヶ浜海岸 (最危険地帯/海抜2.4m)",
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
                    name: "地点B: 和田塚駅付近 (内陸中間地帯/海抜5.8m)",
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
            title: "避難勧告（津波警報）",
            time: "30分（15:45）",
            height: "3m",
            locations: {
                'a': {
                    name: "地点A: 七里ヶ浜海岸 (最危険地帯/海抜3.1m)",
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
                    name: "地点B: 七里ヶ浜駅前 (江ノ電沿線/海抜4.0m)",
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
        activeScenarioId = scenarioId;
        activeLocationId = locationId;
        document.body.classList.add('emergency-mode');
        
        document.getElementById('btn-test-alert').classList.add('hidden');
        document.getElementById('btn-sos').classList.remove('hidden');
        document.getElementById('btn-share').classList.remove('hidden');
        document.getElementById('btn-reset-alert').classList.remove('hidden');
        document.getElementById('evacuation-banner').classList.remove('hidden');
        document.getElementById('disaster-details').style.display = 'block';
 
        // Load scenario parameters
        const sc = SCENARIOS[scenarioId] || SCENARIOS[1];
        const scLoc = sc.locations[locationId] || sc.locations['a'];
        
        // Dynamically update banner content
        document.getElementById('i18n-evac-title').innerText = sc.title;
        document.getElementById('i18n-evac-desc').innerText = scLoc.desc;
        
        const detailsEl = document.getElementById('disaster-details');
        const timeLabel = sc.isLandslide ? "到達予測:" : "予想到達時間:";
        const heightLabel = sc.isLandslide ? "予想浸水深:" : "予想高:";
        detailsEl.innerHTML = `<span>${timeLabel}</span> <strong>${sc.time}</strong> | <span>${heightLabel}</span> <strong>${sc.height}</strong>`;
 
        if (isTest) {
            // Keep user's custom location if it is within the Kamakura model area, otherwise fallback to scenario start
            if (!isInModelArea(currentLocation)) {
                currentLocation = { lat: scLoc.start.lat, lng: scLoc.start.lng };
            }
            map.setView([currentLocation.lat, currentLocation.lng], 16);
            updateMarker(currentLocation);
            // Show route selection modal if route data is available
            const routeKey = `${scenarioId}_${locationId}`;
            const candidates = routeData[routeKey];
            if (candidates && candidates.length > 0) {
                showRouteSelectionModal(scenarioId, locationId, scLoc);
            } else {
                // Fallback to static routes
                drawEvacuationRoutes(currentLocation, scLoc, null);
                simulateEvacuation();
            }
        } else {
            // Real emergency: use Route B (congestion-avoidance) automatically
            const routeKey = `${scenarioId}_${locationId}`;
            const candidates = routeData[routeKey];
            const routeB = candidates ? candidates.find(r => r.id === 'B') : null;
            drawEvacuationRoutes(currentLocation, scLoc, routeB);
        }
 
        if ("vibrate" in navigator && !isTest) {
            navigator.vibrate([200, 100, 200]);
        }
    }

    function resetEmergencyMode() {
        isEmergency = false;

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
        document.getElementById('btn-test-alert').classList.remove('hidden');
        document.getElementById('btn-share').classList.add('hidden');
        document.getElementById('btn-sos').classList.add('hidden');
        document.getElementById('btn-reset-alert').classList.add('hidden');
        document.getElementById('evacuation-banner').classList.add('hidden');

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
    }

    // ── ルート選択モーダル ─────────────────────────────────────────────
    function showRouteSelectionModal(scenarioId, locationId, scLoc) {
        const routeKey = `${scenarioId}_${locationId}`;
        const candidates = routeData[routeKey] || [];

        const CONG_DOTS = { low: '●○○', medium: '●●○', high: '●●●' };
        const CONG_LABELS = { low: '低', medium: '中', high: '高' };
        const CONG_COLORS = { low: '#00a63e', medium: '#f5a623', high: '#c0392b' };

        const container = document.getElementById('route-options-container');
        container.innerHTML = '';

        candidates.forEach(route => {
            const congColor = CONG_COLORS[route.congestion_score] || '#888';
            const congDots = CONG_DOTS[route.congestion_score] || '○○○';
            const congLabel = CONG_LABELS[route.congestion_score] || '-';
            const isElderly = route.recommended_for && (route.recommended_for.includes('elderly') || route.recommended_for.includes('child'));
            const elderlyBadge = isElderly
                ? `<span class="route-badge elderly-badge">♿ 高齢者・お子様向け推奨</span>`
                : '';

            const btnHtml = `
                <button class="route-option-btn" data-route-id="${route.id}"
                    style="text-align:left; padding:13px 14px; border-radius:12px; border:2px solid ${route.color}20;
                           background:${route.color}12; cursor:pointer; transition:all 0.2s; width:100%;">
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:5px;">
                        <strong style="color:${route.color}; font-size:0.95rem;">[${route.id}] ${route.label}</strong>
                        <span style="font-size:0.8rem; background:var(--glass-bg); border-radius:6px; padding:2px 7px;">
                            🚶 ${route.distance_m}m · ${route.estimated_min}分
                        </span>
                    </div>
                    <div style="margin-bottom:5px;">
                        <span style="font-size:0.82rem; color:${congColor}; font-weight:600;">
                            ${congDots} 混雑リスク ${congLabel}
                        </span>
                        ${elderlyBadge}
                    </div>
                    <p style="font-size:0.8rem; opacity:0.8; line-height:1.4; margin:0;">${route.characteristics}</p>
                </button>
            `;
            container.insertAdjacentHTML('beforeend', btnHtml);
        });

        // Add fallback option
        container.insertAdjacentHTML('beforeend', `
            <button class="route-option-btn" data-route-id="fallback"
                style="text-align:center; padding:10px; border-radius:10px; border:1px solid var(--glass-border);
                       background:var(--glass-bg); cursor:pointer; font-size:0.82rem; opacity:0.75; width:100%;">
                既定ルートを使用
            </button>
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
            
            // Smart Snap Connector:
            // If the start location is significantly far from the first route point (e.g. > 15m),
            // we insert a smart Manhattan L-shaped mid-point to avoid cutting through buildings diagonally.
            // If it's already OSRM and we have snapped, or if distance is tiny, a direct connection is fine.
            if (dist > 15 && !routeCandidate.isOSRM) {
                const midPt = [startLoc.lat, firstPt[1]];
                waypoints = [ [startLoc.lat, startLoc.lng], midPt, ...routeCandidate.waypoints ];
            } else {
                waypoints = [ [startLoc.lat, startLoc.lng], ...routeCandidate.waypoints ];
            }
            
            mainRouteLine = L.polyline(waypoints, {
                color: routeCandidate.color || '#00bbff',
                weight: 6,
                opacity: 1,
                className: 'animated-route'
            }).addTo(routeLayerGroup);

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
                weight: 6,
                opacity: 1,
                className: 'animated-route'
            }).addTo(routeLayerGroup);

            const subWaypoints = [ [startLoc.lat, startLoc.lng], ...scLoc.subRoute ];
            L.polyline(subWaypoints, {
                color: '#888888',
                weight: 3,
                opacity: 0.8,
                dashArray: '5, 10'
            }).addTo(routeLayerGroup);
        }
    }

    async function recalculateRouteFromLocation(loc) {
        if (!isEmergency) return;
        
        // Stop current evacuation simulation interval
        if (simulationInterval) {
            clearInterval(simulationInterval);
            simulationInterval = null;
        }

        // Find nearest shelter
        const nearestShelter = findNearestShelter(loc);
        if (nearestShelter) {
            let customRoute = null;

            // Try OSRM Online Walking Routing API first with dual fallback servers and 3s timeouts
            const osrmUrls = [
                `https://routing.openstreetmap.de/routed-foot/route/v1/foot/${loc.lng},${loc.lat};${nearestShelter.lng},${nearestShelter.lat}?overview=full&geometries=geojson`,
                `https://router.project-osrm.org/route/v1/foot/${loc.lng},${loc.lat};${nearestShelter.lng},${nearestShelter.lat}?overview=full&geometries=geojson`
            ];

            for (let url of osrmUrls) {
                try {
                    const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
                    const data = await response.json();
                    
                    if (data.code === 'Ok' && data.routes && data.routes.length > 0) {
                        const route = data.routes[0];
                        // OSRM returns [longitude, latitude] coordinates; Leaflet expects [latitude, longitude]
                        const waypoints = route.geometry.coordinates.map(c => [c[1], c[0]]);
                        
                        customRoute = {
                            waypoints: waypoints,
                            label: "避難歩行ルート",
                            color: "#0a84ff", // Apple-style Cyan/Blue for emergency
                            distance_m: Math.round(route.distance),
                            characteristics: "歩行者用の安全な避難経路",
                            congestion_score: "low",
                            isOSRM: true
                        };
                        console.log(`[TENDEN] OSRM Online Route fetched successfully from: ${url}`);
                        break;
                    }
                } catch (e) {
                    console.warn(`[TENDEN] OSRM routing failed or offline for ${url}. Trying next...`, e);
                }
            }

            // Fallback to offline local path approximation if OSRM is offline
            if (!customRoute) {
                customRoute = calculateCustomRoute(loc, nearestShelter);
            }
            
            // Draw the evacuation route
            drawEvacuationRoutes(loc, nearestShelter, customRoute);
            
            // Update HUD banner description
            document.getElementById('i18n-evac-desc').innerText = `避難開始地点を設定しました。最寄りの「${nearestShelter.name}」へ避難を開始します。`;
            
            // Restart evacuation simulation from this new custom location
            simulateEvacuation();
        } else {
            console.warn("No nearest shelter found");
        }
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

    function calculateCustomRoute(startLoc, shelter) {
        let bestRoute = null;
        let minWaypointDist = Infinity;
        let bestSplitIndex = 0;
        
        const startLatLng = L.latLng(startLoc.lat, startLoc.lng);
        
        // Loop through all scenario routes in routeData
        Object.keys(routeData).forEach(key => {
            const candidates = routeData[key] || [];
            candidates.forEach(route => {
                if (!route.waypoints || route.waypoints.length < 2) return;
                
                // Check if this route ends near our target shelter
                const lastPt = route.waypoints[route.waypoints.length - 1];
                const destDist = L.latLng(lastPt[0], lastPt[1]).distanceTo(L.latLng(shelter.lat, shelter.lng));
                
                // If it ends within 150m of the shelter, it's a good candidate route
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
        
        // If we found a good predefined route nearby, slice and splice it!
        if (bestRoute && minWaypointDist < 300) { // Limit to 300m instead of 800m to avoid long diagonal lines
            const customWaypoints = [];
            for (let i = bestSplitIndex; i < bestRoute.waypoints.length; i++) {
                customWaypoints.push(bestRoute.waypoints[i]);
            }
            return {
                waypoints: customWaypoints,
                label: bestRoute.label,
                color: bestRoute.color,
                distance_m: Math.round(minWaypointDist + bestRoute.distance_m * (1 - bestSplitIndex / bestRoute.waypoints.length)),
                characteristics: bestRoute.characteristics,
                congestion_score: bestRoute.congestion_score,
                isOSRM: false
            };
        }
        
        // Absolute fallback: draw a simulated L-shaped (Manhattan) route or straight line to the shelter
        const shelterLat = shelter.lat;
        const shelterLng = shelter.lng;
        const midPoint = [startLoc.lat, shelterLng]; // corner turn to simulate streets
        return {
            waypoints: [
                midPoint,
                [shelterLat, shelterLng]
            ],
            label: "緊急避難ルート",
            color: "#ff3b30", // Bright warning red
            distance_m: Math.round(startLatLng.distanceTo(L.latLng(shelterLat, shelterLng)) * 1.3),
            characteristics: "緊急時の最短道路接続ルート",
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
        
        const hideAlert = () => {
            overlay.classList.remove('active');
            setTimeout(() => overlay.classList.add('hidden'), 300);
            btnOk.removeEventListener('click', hideAlert);
            if (callback) callback();
        };
        
        btnOk.addEventListener('click', hideAlert);
        
        overlay.classList.remove('hidden');
        setTimeout(() => overlay.classList.add('active'), 10);
    }

    function checkRouteDeviation(loc) {
        if (!mainRouteLine) return;
        
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
            document.getElementById('i18n-evac-desc').innerText = "ルートから外れています！青い線に戻ってください。";
            document.getElementById('i18n-evac-desc').style.color = 'var(--danger)';
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
        const pts = mainRouteLine.getLatLngs();
        let currentPtIndex = 0;
        let progress = 0;

        simulationInterval = setInterval(() => {
            if (currentPtIndex >= pts.length - 1) {
                clearInterval(simulationInterval);
                return;
            }
            
            const p1 = pts[currentPtIndex];
            const p2 = pts[currentPtIndex + 1];
            
            progress += 0.05;
            if (progress >= 1) {
                progress = 0;
                currentPtIndex++;
                if (currentPtIndex >= pts.length - 1) {
                    clearInterval(simulationInterval);
                    return;
                }
            }
            
            // Interpolate
            const lat = p1.lat + (p2.lat - p1.lat) * progress;
            const lng = p1.lng + (p2.lng - p1.lng) * progress;
            
            const newLoc = { lat, lng };
            updateMarker(newLoc);
            map.panTo([lat, lng]);
            fetchElevation(newLoc);
            
        }, 500); // update every 500ms
    }

    function takeScreenshot() {
        const uiLayer = document.getElementById('ui-layer');
        document.querySelector('.hud-controls').style.display = 'none';
        
        html2canvas(document.body, {
            useCORS: true,
            allowTaint: true,
            ignoreElements: (el) => el.id === 'onboarding-overlay' || el.id === 'error-overlay'
        }).then(canvas => {
            const link = document.createElement('a');
            link.download = `tenden_backup_${new Date().toISOString().split('T')[0]}.png`;
            link.href = canvas.toDataURL();
            link.click();
            document.querySelector('.hud-controls').style.display = 'flex';
        }).catch(err => {
            console.error("Screenshot failed:", err);
            document.querySelector('.hud-controls').style.display = 'flex';
        });
    }

    // ── P2P地震情報 WebSocket接続 ─────────────────────────────────────
    // 使用API: wss://api.p2pquake.net/v2/ws（P2P地震情報ネットワーク）
    // code 551 = 津波情報, code 556 = 津波警報
    function connectP2PQuake() {
        let ws;
        let reconnectTimer = null;

        function connect() {
            try {
                ws = new WebSocket('wss://api.p2pquake.net/v2/ws');
            } catch (e) {
                console.warn('[P2P] WebSocket 接続失敗（オフライン?）:', e);
                scheduleReconnect();
                return;
            }

            ws.onopen = () => {
                console.log('[P2P] WebSocket 接続完了 (api.p2pquake.net)');
            };

            ws.onmessage = (e) => {
                let data;
                try {
                    data = JSON.parse(e.data);
                } catch (_) {
                    return;
                }

                // code 551 = 気象庁発表「津波情報」, code 556 = 緊急地震速報（予報）
                if (data.code === 551 || data.code === 556) {
                    // 津波警報クラスを確認
                    const forecasts = data?.tsunami?.comments?.forecast?.text ?? '';
                    const isTsunamiWarning =
                        forecasts.includes('大津波警報') ||
                        forecasts.includes('津波警報') ||
                        data.code === 551; // 津波情報が届いた時点で緊急モード発動

                    if (isTsunamiWarning && !isEmergency) {
                        console.warn('[P2P] 津波警報受信 → 緊急モード発動');
                        // 実際の緊急アラートとして起動（isTest=false）
                        triggerEmergencyMode(false, 1, 'a');
                        // バイブレーション（Vibration API）
                        if ('vibrate' in navigator) {
                            navigator.vibrate([300, 100, 300, 100, 300]);
                        }
                    }
                }
            };

            ws.onerror = (err) => {
                console.warn('[P2P] WebSocket エラー:', err);
            };

            ws.onclose = () => {
                console.log('[P2P] WebSocket 切断 → 5秒後に再接続');
                scheduleReconnect();
            };
        }

        function scheduleReconnect() {
            if (reconnectTimer) return; // 二重予約を防ぐ
            reconnectTimer = setTimeout(() => {
                reconnectTimer = null;
                connect();
            }, 5000);
        }

        connect();
    }

    function updateDate() {
        const d = new Date();
        document.getElementById('current-date').innerText = d.toLocaleDateString();
    }

    function initI18n() {
        const savedLang = localStorage.getItem('tenden-lang') || 'auto';
        let langCode = 'ja';
        
        if (savedLang !== 'auto') {
            langCode = savedLang;
        } else {
            langCode = (navigator.language || navigator.userLanguage).split('-')[0];
        }

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
});
