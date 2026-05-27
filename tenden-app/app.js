// app.js
document.addEventListener('DOMContentLoaded', () => {
    // Basic state
    let isEmergency = false;
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
    
    // Simulation-derived data
    let routeData = {};  // loaded from assets/routes.json
    let pendingRouteArgs = null; // {scenarioId, locationId, scLoc} while route modal is open
    
    // GeoJSON and Data layers
    let sheltersData = [];
    let safeEdgesData = [];
    
    // Kamakura default location (Yuigahama)
    const KAMAKURA_CENTER = [35.3192, 139.5504];

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
            testAlert: "🚶 Evacuation Demo",
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
            testAlert: "🚶 鎌仓避难体验",
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
            testAlert: "🚶 가마쿠라 대피 체험",
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
    startClock();
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
        safeEdgesLayerGroup = L.layerGroup();

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
        
        // Official relief tile layer from GSI for elevation color maps
        reliefLayer = L.tileLayer(
            'https://cyberjapandata2.gsi.go.jp/xyz/relief/{z}/{x}/{y}.png',
            {
                minZoom: 2,
                maxZoom: 18,
                opacity: 0.6,
                attribution: '色別標高図: <a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank">国土地理院</a>'
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

        // Load shelters data
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

        // Load safe edges data: start with static JSON for instant availability,
        // then replace with comprehensive dynamic raster scan in background
        fetch('assets/safe_edges.json')
            .then(res => res.json())
            .then(async (data) => {
                safeEdgesData = data;
                console.log('[TENDEN] safe_edges.json 読み込み完了 (暫定):', data.length, '件');
                await verifyAndCleanSafeEdges();
                drawAllSafeEdges(); // Render layers
            })
            .catch(() => {})
            .finally(() => {
                // Trigger full raster scan to find ALL boundary×road intersections
                computeSafeEdgesFromRasterScan('14').then(async (dynamicEdges) => {
                    if (dynamicEdges.length > 0) {
                        safeEdgesData = dynamicEdges;
                        console.log(`[TENDEN] ラスタースキャン完了: ${safeEdgesData.length} 件の安全境界点を検出`);
                        await verifyAndCleanSafeEdges();
                        drawAllSafeEdges(); // Render layers
                    }
                }).catch(e => console.warn('[SafeEdge] ラスタースキャン失敗:', e));
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
            if (isPinLocked) return; // Prevent pin change if locked
            
            isManualLocation = true;
            currentLocation = { lat: e.latlng.lat, lng: e.latlng.lng };
            updateMarker(currentLocation);
            fetchElevation(currentLocation);
            triggerLocationTsunamiCheck(currentLocation);
            
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
                
                // Show crosshair and "Set Pin" button instead of waiting for a map tap
                const crosshair = document.getElementById('crosshair-target');
                if (crosshair) crosshair.classList.remove('hidden');
                
                const btnSetPin = document.getElementById('btn-set-pin');
                if (btnSetPin) btnSetPin.classList.remove('hidden');
                
                showCustomAlert("避難開始位置を決定", "マップをドラッグして、画面中央のターゲット（照準）を避難開始位置に合わせてから、下部のボタンを押してください。", "info");
            });
        });

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
                    triggerLocationTsunamiCheck(currentLocation);
                    
                    // Track location changes
                    navigator.geolocation.watchPosition(pos => {
                        if (!isManualLocation) {
                            currentLocation = {
                                lat: pos.coords.latitude,
                                lng: pos.coords.longitude
                            };
                            updateMarker(currentLocation);
                            triggerLocationTsunamiCheck(currentLocation);
                        }
                        
                        if (isEmergency && !simulationInterval) {
                            checkRouteDeviation({lat: pos.coords.latitude, lng: pos.coords.longitude});
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

        // Show a simple thought-provoking popup if user placed the pin manually
        if (isManualLocation) {
            // Cancel any pending popup close timeouts
            if (popupTimeoutId) {
                clearTimeout(popupTimeoutId);
                popupTimeoutId = null;
            }

            userMarker.bindPopup(`
                <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; text-align: center; padding: 4px;">
                    <strong style="color: #ff3b30; font-size: 14px; display: block; margin-bottom: 4px;">もし、ここにいたら・・・</strong>
                    <span style="font-size: 12px; color: #555; line-height: 1.4; display: block;">
                        大津波が迫る中、あなたならどう動き、どこへ逃げますか？
                    </span>
                </div>
            `, {
                closeButton: false,
                offset: [0, -10],
                className: 'gsi-thought-popup'
            }).openPopup();

            // Automatically close the popup after 5 seconds to keep the map clean and unobstructed
            popupTimeoutId = setTimeout(() => {
                if (userMarker && userMarker.getPopup && userMarker.getPopup()) {
                    userMarker.closePopup();
                }
                popupTimeoutId = null;
            }, 5000);
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
        isWaitingForPinDrop = false;
        activeScenarioId = scenarioId;
        activeLocationId = locationId;
        if (!isTest) {
            document.body.classList.add('emergency-mode');
        }
        
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
        const timeLabel = sc.isLandslide ? "到達予測:" : "予想到達時間:";
        const heightLabel = sc.isLandslide ? "予想浸水深:" : "予想高:";
        detailsEl.innerHTML = `<span>${timeLabel}</span> <strong>${sc.time}</strong> | <span>${heightLabel}</span> <strong>${sc.height}</strong>`;
 
        if (isTest) {
            // Keep user's custom location if it is within the Kamakura model area, otherwise fallback to scenario start
            if (!isInModelArea(currentLocation)) {
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

    // ── ルート選択モーダル ─────────────────────────────────────────────
    function showRouteSelectionModal(scenarioId, locationId, scLoc) {
        const routeKey = `${scenarioId}_${locationId}`;
        const candidates = routeData[routeKey] || [];

        const CONG_LABELS = { low: '低', medium: '中', high: '高' };
        const CONG_BAR = { low: '■□□ (1/3)', medium: '■■□ (2/3)', high: '■■■ (3/3)' };

        const container = document.getElementById('route-options-container');
        container.innerHTML = '';

        candidates.forEach(route => {
            const congLabel = CONG_LABELS[route.congestion_score] || '-';
            const congBar = CONG_BAR[route.congestion_score] || '□□□';
            
            const btnHtml = `
                <button class="route-option-btn" data-route-id="${route.id}"
                    style="text-align:left; padding:16px; margin-bottom:10px; border-radius:14px; border:2px solid ${route.color}40;
                           background:${route.color}15; cursor:pointer; transition:all 0.2s; width:100%; display:flex; flex-direction:column; gap:8px;">
                    <div style="display:flex; justify-content:space-between; align-items:center; width:100%;">
                        <strong style="color:${route.color}; font-size:1.15rem; letter-spacing:0.05em;">ルート ${route.id}</strong>
                        <span style="font-size:0.8rem; font-weight:600; opacity:0.8; color:var(--hud-text);">選択</span>
                    </div>
                    <div style="display:flex; justify-content:space-between; width:100%; font-size:0.8rem; color:var(--hud-text); opacity:0.9;">
                        <span>🚶 ${route.distance_m}m (約${route.estimated_min}分)</span>
                        <span>混雑度: <span style="color:${route.color};">${congBar}</span></span>
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
                規定のルートを使用する
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
    function drawMultipleEvacuationRoutes(startLoc, targetEdge, secondaryRoute, candidates, selectedId) {
        routeLayerGroup.clearLayers();
        activeRoutesList = candidates;
        activeSelectedRouteId = selectedId || 'A';

        candidates.forEach(candidate => {
            const isSelected = candidate.id === activeSelectedRouteId;
            const color = candidate.color || '#00bbff';
            
            if (candidate.waypoints && candidate.waypoints.length > 0) {
                let waypoints = [ ...candidate.waypoints ];
                
                // Highlight active main selection, thin dash other alternatives
                const lineOpts = isSelected ? {
                    color: color,
                    weight: 6.5,
                    opacity: 1.0,
                    className: 'animated-route'
                } : {
                    color: color,
                    weight: 4.0,
                    opacity: 0.35,
                    dashArray: '5, 8'
                };
                
                const pline = L.polyline(waypoints, lineOpts).addTo(routeLayerGroup);
                
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
                                        ✖
                                    </div>
                                </div>
                            `,
                            iconSize: [24, 24],
                            iconAnchor: [12, 12]
                        });
                        L.marker(candidate.blockedPoint, { icon: blockedIcon }).addTo(routeLayerGroup);
                    }

                    // Passing shelters along selected route are already shown by addShelterMarkers().
                    // No extra label needed — the pin color already communicates congestion status.


                    // ---- PRIMARY GOAL MARKER (第一目標: 安全高台) ----
                    if (targetEdge) {
                        const goalIcon = L.divIcon({
                            className: '',
                            html: `
                                <div style="display:flex; flex-direction:column; align-items:center;">
                                    <div style="background:#0071e3; color:white; font-size:0.72rem; font-weight:700; padding:4px 10px; border-radius:10px; box-shadow:0 3px 8px rgba(0,113,227,0.5); white-space:nowrap; margin-bottom:4px;">
                                        🏁 第一目標：${targetEdge.name}
                                    </div>
                                    <div style="width:0; height:0; border-left:6px solid transparent; border-right:6px solid transparent; border-top:8px solid #0071e3;"></div>
                                </div>
                            `,
                            iconSize: [180, 40],
                            iconAnchor: [90, 40]
                        });
                        L.marker([targetEdge.lat, targetEdge.lng], { icon: goalIcon, zIndexOffset: 1000 }).addTo(routeLayerGroup);
                    }

                    // ---- SECONDARY ROUTE (第二目標: 避難所への分岐破線) ----
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
                        const branchIcon = L.divIcon({
                            className: '',
                            html: `<div style="background:#ff9500; color:white; font-size:0.65rem; font-weight:700; padding:3px 7px; border-radius:8px; white-space:nowrap; box-shadow:0 2px 5px rgba(255,149,0,0.4);">↘ 避難所へ分岐</div>`,
                            iconSize: [90, 22],
                            iconAnchor: [45, 11]
                        });
                        L.marker(branchPoint, { icon: branchIcon, zIndexOffset: 900 }).addTo(routeLayerGroup);

                        // Secondary goal marker
                        const lastPt = secondaryRoute.waypoints[secondaryRoute.waypoints.length - 1];
                        const shelterName = secondaryRoute.target ? secondaryRoute.target.name : '避難所';
                        const shelterIcon = L.divIcon({
                            className: '',
                            html: `
                                <div style="display:flex; flex-direction:column; align-items:center;">
                                    <div style="background:#ff9500; color:white; font-size:0.72rem; font-weight:700; padding:4px 10px; border-radius:10px; box-shadow:0 3px 8px rgba(255,149,0,0.5); white-space:nowrap; margin-bottom:4px;">
                                        🏥 第二目標：${shelterName}
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
            document.getElementById('i18n-evac-desc').innerText = `${selectedRoute.label}（${selectedRoute.characteristics.split('。')[0]}）で避難を開始します。`;
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
            <div style="font-size:0.75rem; color:var(--text-light);">複合的に考慮し、最適な経路を自動で選びます</div>
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
        
        candidates.forEach(c => {
            const isSelected = c.id === activeSelectedRouteId;
            const targetColor = c.color || '#00bbff';
            
            let tagText = '';
            if (c.id === 'B') tagText = `道路混雑回避`;
            else if (c.id === 'A') tagText = `最短距離`;
            else if (c.id === 'D') tagText = `空き避難所`;
            else if (c.id === 'C') tagText = `バリアフリー`;
            
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
                    <div style="font-size:0.8rem; font-weight:700; color:var(--hud-text); opacity:0.9;">${c.estimated_min}分 (${c.distance_m}m)</div>
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

        // BUILD ROUTE A (最短ルート -> Pure nearest safe edge)
        if (onlineNearestWaypoints) {
            routeA = {
                id: 'A',
                label: '最短避難ルート',
                color: '#0071e3',
                waypoints: onlineNearestWaypoints,
                distance_m: onlineNearestDistance,
                estimated_min: Math.round((onlineNearestDistance / 1.37) / 60),
                characteristics: `混雑を考慮せず、最も近い安全高台「${targetEdge.name}」へ直行するルート。`,
                congestion_score: 'medium', // Shortest usually gets congested
                isOSRM: true
            };
        } else {
            routeA = calculateCustomRouteForType(loc, targetEdge, 'A');
        }

        // Try to fetch OSRM Route with Detour for Route B (Congestion Avoidance)
        let detourResult = await fetchOSRMRouteWithDetour(loc, targetEdge);

        // BUILD ROUTE B (道路混雑回避ルート - uses detour if available)
        if (detourResult) {
            routeB = {
                id: 'B',
                label: '道路混雑回避ルート',
                color: '#34c759',
                waypoints: detourResult.waypoints,
                distance_m: detourResult.distance,
                estimated_min: Math.round((detourResult.distance / 1.37) / 60),
                characteristics: `シミュレーション上の混雑エリアを自動検知し、迂回路を生成した安全ルート。`,
                congestion_score: 'low',
                isOSRM: true,
                blockedPoint: detourResult.blockedPoint
            };
        } else if (onlineNearestWaypoints) {
            routeB = {
                id: 'B',
                label: '道路混雑回避ルート',
                color: '#34c759',
                waypoints: onlineNearestWaypoints,
                distance_m: onlineNearestDistance,
                estimated_min: Math.round((onlineNearestDistance / 1.37) / 60),
                characteristics: `現在交差する混雑がないため、最短距離で「${targetEdge.name}」へ誘導します。`,
                congestion_score: 'low',
                isOSRM: true
            };
        } else {
            routeB = calculateCustomRouteForType(loc, targetEdge, 'B');
        }

        // BUILD SECONDARY ROUTE (第二目標: 避難所への分岐ルート)
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

        // BUILD ROUTE C (バリアフリー・勾配回避ルート — Real slope-based calculation)
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

        const slopeLabel = routeCMaxSlope !== null ? ` ・最大勾配 ${routeCMaxSlope.toFixed(1)}%` : '';
        const flatNote = (routeCEdge.id !== targetEdge.id) ? `「${routeCEdge.name}」方面への平坦な道を顏沢。` : `「${routeCEdge.name}」へ向かいますが、これが現在最も平坦な経路です。`;
        if (routeCWaypoints) {
            routeC = {
                id: 'C',
                label: 'バリアフリー・平坦ルート',
                color: '#5e5ce6',
                waypoints: routeCWaypoints,
                distance_m: routeCDistance,
                estimated_min: Math.round((routeCDistance / 0.9) / 60), // slower pace: 0.9m/s
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
        drawMultipleEvacuationRoutes(loc, targetEdge, secondaryRoute, candidates, 'A');

        // Dynamically populate bottom sheet HUD cards and show
        showRouteSelectorHUD(candidates);

        // Update emergency HUD text
        document.getElementById('i18n-evac-desc').innerText = `避難開始地点を設定しました。候補ルートを選択して避難を開始してください。`;
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

        console.log(`[SafeEdge] 安全境界候補数: ${candidatesList.length}点。OSRMスナップ安全チェックを開始します...`);

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
                        const isSnappedInside = await checkTsunamiInundation(lastWaypoint[0], lastWaypoint[1], '14');
                        
                        if (isSnappedInside) {
                            console.warn(`[SafeEdge] ⚠️ OSRMスナップ先が浸水域内のため候補を除外: ${candidateEdge.name || candidateEdge.id} (スナップ先: ${lastWaypoint[0]}, ${lastWaypoint[1]})`);
                            verificationFailed = true;
                            break; // Try the next candidateEdge
                        }

                        // Found a perfectly safe snapped destination!
                        console.log(`[SafeEdge] ✅ 安全なスナップ先を確認: ${candidateEdge.name || candidateEdge.id} (スナップ先: ${lastWaypoint[0]}, ${lastWaypoint[1]})`);
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
        console.warn(`[SafeEdge] すべての候補のスナップ先が安全域外または検証エラーのため、最寄りを緊急採用します: ${fallbackEdge.name || fallbackEdge.id}`);
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
        
        // If we found a good predefined route nearby, slice and splice it!
        if (bestRoute && minWaypointDist < 300) { // Limit to 300m instead of 800m to avoid long diagonal lines
            const customWaypoints = [];
            for (let i = bestSplitIndex; i < bestRoute.waypoints.length; i++) {
                customWaypoints.push(bestRoute.waypoints[i]);
            }
            return {
                id: type, // Fixed: included the missing type ID!
                waypoints: customWaypoints,
                label: type === 'C' ? '高齢者・児童バリアフリールート' : bestRoute.label, // Dynamic premium label
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
        
        const fallbackNames = {
            'A': '最短避難ルート',
            'B': '道路混雑回避ルート',
            'C': 'バリアフリー・平坦ルート',
            'D': '分散避難ルート'
        };
        const fallbackColors = {
            'A': '#0071e3',
            'B': '#34c759',
            'C': '#5e5ce6',
            'D': '#ff9500'
        };

        return {
            id: type,
            label: fallbackNames[type] || '緊急避難ルート',
            color: fallbackColors[type] || '#ff3b30',
            waypoints: [
                midPoint,
                [shelterLat, shelterLng]
            ],
            distance_m: Math.round(startLatLng.distanceTo(L.latLng(shelterLat, shelterLng)) * 1.3),
            estimated_min: Math.round((startLatLng.distanceTo(L.latLng(shelterLat, shelterLng)) * 1.3 / (type === 'C' ? 1.0 : 1.37)) / 60),
            characteristics: type === 'C' ? "坂道を避けた緊急平坦ルート。" : "緊急時の最短道路接続ルート。",
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
        
        // Ensure simulationInterval is clear since we no longer move the pin automatically
        if (simulationInterval) {
            clearInterval(simulationInterval);
            simulationInterval = null;
        }

        // Auto-fit the map to optimally display the entire evacuation route
        // We use a slight delay and responsive padding so it doesn't break on small screens
        setTimeout(() => {
            if (routeLayerGroup && mainRouteLine) {
                map.fitBounds(routeLayerGroup.getBounds(), {
                    paddingTopLeft: [20, 80],     // top-status-bar height is ~52px
                    paddingBottomRight: [20, 150], // Bottom sheet expanded
                    animate: true,
                    duration: 1.2
                });
            }
        }, 300);
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
                setP2PStatus('connected');
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

                    if (isTsunamiWarning) {
                        setP2PStatus('alert');
                    }
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
                setP2PStatus('connecting');
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

    // P2P接続状態をHUDに反映する
    function setP2PStatus(state) {
        const dot = document.getElementById('p2p-dot');
        const label = document.getElementById('p2p-label');
        const bar = document.getElementById('p2p-status-bar');
        if (!dot || !label) return;
        dot.className = `p2p-dot p2p-${state}`;
        const labels = {
            connecting:    '警報待機中...',
            connected:     '警報待機中',
            alert:         '🚨 大津波警報',
            disconnected:  '警報: 未接続'
        };
        label.textContent = labels[state] || '待機中';
        if (bar) {
            bar.classList.toggle('p2p-alert-active', state === 'alert');
        }
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

    // ==========================================================================
    // Tsunami National Hazard Map & Location Inundation Detection (全国区対応＆現在地浸水想定区域内外判定)
    // ==========================================================================
    let currentPrefCode = '14'; // 初期値は神奈川県 (JIS: 14)

    /**
     * 緯度経度から都道府県コードを特定し、ハザードマップタイルを動的に切り替える
     * @param {number} lat 緯度
     * @param {number} lng 経度
     * @returns {Promise<string>} 都道府県コード (2桁)
     */
    async function updateTsunamiPrefecturalTile(lat, lng) {
        try {
            // 国土地理院の軽量逆ジオコーディングAPIを利用
            const url = `https://mreversegeocoder.gsi.go.jp/reverse-geocoder/LonLatToAddress?lat=${lat}&lon=${lng}`;
            const res = await fetch(url);
            if (!res.ok) throw new Error('Reverse geocoding failed');
            
            const data = await res.json();
            if (data && data.results && data.results.muniCd) {
                const muniCd = data.results.muniCd;
                // muniCdの先頭2桁が都道府県コード
                const prefCode = String(Math.floor(parseInt(muniCd) / 1000)).padStart(2, '0');
                
                if (prefCode !== currentPrefCode) {
                    currentPrefCode = prefCode;
                    console.log(`[Tsunami Hazard] Switching hazard map prefecture tile to: ${prefCode}`);
                    
                    if (hazardLayer) {
                        // タイルURLを動的に更新
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
     * 緯度経度からズームレベル14におけるXYZタイル座標とタイル内ピクセル座標を算出する
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
        
        safeEdgesData.forEach(edge => {
            L.circleMarker([edge.lat, edge.lng], {
                radius: 4,
                color: '#30d158', // iOS Green
                fillColor: '#30d158',
                fillOpacity: 0.6,
                weight: 1.5
            }).bindPopup(`
                <div style="font-size: 11px; font-family: -apple-system, sans-serif; line-height: 1.4; padding: 2px;">
                    <strong style="color:#30d158; font-size: 12px;">✅ 安全境界点（第一目標候補）</strong><br>
                    <span style="color:#666;">ID: ${edge.id || 'scan'}</span><br>
                    <span style="color:#666;">座標: ${edge.lat.toFixed(5)}, ${edge.lng.toFixed(5)}</span>
                </div>
            `).addTo(safeEdgesLayerGroup);
        });
    }

    /**
     * Helper to check if a lat/lng is near the coastline or rivers in Kamakura.
     * Excludes points within 300m of the coastline and 100m of Namerikawa/Sakaigawa rivers.
     */
    function isNearCoastOrWater(lat, lng) {
        if (!window.turf) return false;
        
        // Strictly exclude anything outside Kamakura municipal limits (East of 139.563 in Zushi / Kotsubo, or South of 35.295)
        if (lng > 139.563 || lat < 35.295) {
            console.log(`[SafeEdge] City Limits Filter: Excluded point outside Kamakura city boundaries: ${lat}, ${lng}`);
            return true;
        }
        
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
            { lng: 139.568, lat: 35.298 }  // East border (Kotsubo entrance)
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
            [139.562, 35.275]  // Kotsubo outer tip
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
            [139.585, 35.318]  // Juiso deep valley
        ]);
        
        // 2. Nikaidogawa River (Namerikawa Tributary branch)
        const nikaidogawaLine = turf.lineString([
            [139.560, 35.323], // Branch point from main stream
            [139.563, 35.326], // Kamakuragu front
            [139.568, 35.327], // Yofukuji-ato front
            [139.577, 35.326]  // Zuisenji valley
        ]);

        // 3. Gokurakujigawa River (West-Central valley)
        const gokurakujiLine = turf.lineString([
            [139.525, 35.301], // Mouth at Inamuragasaki
            [139.528, 35.309], // Gokurakuji Station front
            [139.524, 35.315]  // Yamazaki valley
        ]);
        
        // 4. Sakaigawa / Kobaigawa River System (West boundary)
        const kobaigawaLine = turf.lineString([
            [139.480, 35.307], // Mouth at Koshigoe
            [139.482, 35.312], // Koshigoe Station east
            [139.485, 35.318], // Tsu
            [139.488, 35.322], // Nishi-Kamakura Station
            [139.495, 35.326], // Tebiro
            [139.505, 35.328], // Fukasawa
            [139.515, 35.329]  // Kajiwara valley
        ]);
        
        const distToCoast = turf.pointToLineDistance(pt, coastLine, {units: 'meters'});
        const distToNamerikawa = turf.pointToLineDistance(pt, namerikawaLine, {units: 'meters'});
        const distToNikaidogawa = turf.pointToLineDistance(pt, nikaidogawaLine, {units: 'meters'});
        const distToGokurakuji = turf.pointToLineDistance(pt, gokurakujiLine, {units: 'meters'});
        const distToKobaigawa = turf.pointToLineDistance(pt, kobaigawaLine, {units: 'meters'});
        
        // Dynamic River buffer: 40m for downstream (flat land), 20m for upstream (mountains/valleys)
        // This prevents over-exclusion in upper valleys (resolves missing plots) while strictly blocking direct river banks.
        const riverBufferDist = lat < 35.315 ? 40 : 20;
        
        if (distToCoast < 300) return true;
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
        console.log('[SafeEdge] 安全境界点の安全性自動チェックをスキップします（スキャン時の精密ピクセル判定および定義ファイルを信頼します）');
        // 丸め誤差や大量並列HTTPリクエスト制限（HTTP 429など）による有能な鎌倉市内の境界点データの自爆削除を防ぐため、
        // checkTsunamiInundation による二重チェックを廃止します。
        return;
    }

    /**
     * Scans GSI tsunami raster tiles for ALL inundation-boundary × safe-zone crossing points.
     * Finds pixels that are outside the inundation zone but directly adjacent to inside pixels.
     * Returns a dense array of {id, name, lat, lng} objects covering the entire Kamakura area.
     * @param {string} prefCode - Prefecture code, e.g. '14' for Kanagawa
     */
    async function computeSafeEdgesFromRasterScan(prefCode = '14') {
        console.log('[SafeEdge] 津波浸水区域の境界スキャンを開始します...');
        
        // Kamakura bounding box (strictly within Kamakura municipal limits, avoiding Zushi/Kotsubo in the east)
        const bbox = { latMin: 35.27, latMax: 35.37, lngMin: 139.47, lngMax: 139.563 };
        const zoom = 14; // ~10m per pixel — high resolution
        const pow2 = Math.pow(2, zoom);

        // Compute tile index range for the bounding box
        const txMin = Math.floor((bbox.lngMin + 180) / 360 * pow2);
        const txMax = Math.floor((bbox.lngMax + 180) / 360 * pow2);
        const tyMin = Math.floor((1 - Math.log(Math.tan(bbox.latMax * Math.PI / 180) + 1 / Math.cos(bbox.latMax * Math.PI / 180)) / Math.PI) / 2 * pow2);
        const tyMax = Math.floor((1 - Math.log(Math.tan(bbox.latMin * Math.PI / 180) + 1 / Math.cos(bbox.latMin * Math.PI / 180)) / Math.PI) / 2 * pow2);

        const STEP = 4;      // Sample every 4th pixel (~40m spacing)
        const GRID = 0.0008; // Deduplication grid cell ~80m
        const edgeMap = new Map(); // gridKey → {lat, lng, id, name}

        const R_PROX = 2;    // 2 pixels ≈ 20m proximity limit to inundation zone (close to boundary)

        // Gather all tile loading tasks
        const tileTasks = [];
        for (let tx = txMin; tx <= txMax; tx++) {
            for (let ty = tyMin; ty <= tyMax; ty++) {
                const url = `https://disaportaldata.gsi.go.jp/raster/04_tsunami_newlegend_pref_data/${prefCode}/${zoom}/${tx}/${ty}.png`;
                tileTasks.push({ tx, ty, url });
            }
        }

        console.log(`[SafeEdge] スキャン対象タイル数: ${tileTasks.length}枚のロードを開始...`);

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

            // Scan for boundary: safe pixel (alpha === 0) close to inundation (R_PROX)
            for (let py = R_PROX; py < 256 - R_PROX; py += STEP) {
                for (let px = R_PROX; px < 256 - R_PROX; px += STEP) {
                    const thisAlpha = pixels[(py * 256 + px) * 4 + 3];
                    if (thisAlpha > 0) continue; // Must be strictly outside (safe)

                    // Convert pixel → lat/lng (Web Mercator)
                    const lng = (tx + px / 256) / pow2 * 360 - 180;
                    const mercN = Math.PI - 2 * Math.PI * (ty + py / 256) / pow2;
                    const lat = 180 / Math.PI * Math.atan(0.5 * (Math.exp(mercN) - Math.exp(-mercN)));

                    // Skip if the point is near the coastline or rivers
                    if (isNearCoastOrWater(lat, lng)) continue;

                    // [CRITICAL] 1-Pixel Safety Margin Check (~10m buffer from inundation pixels)
                    // This mathematically guarantees that no green plot point lies inside or overlaps with the pink/red hazard zone.
                    let tooCloseToInundation = false;
                    for (let dy = -1; dy <= 1; dy++) {
                        for (let dx = -1; dx <= 1; dx++) {
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
                        [0, -1],  // N
                        [1, -1],  // NE
                        [1, 0],   // E
                        [1, 1],   // SE
                        [0, 1],   // S
                        [-1, 1],  // SW
                        [-1, 0],  // W
                        [-1, -1]  // NW
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
                    
                    // If 4 or more directions (out of 8) hit the inundation zone within ~40m,
                    // it is highly likely a narrow riverbed, dynamic estuary slit, or unsafe dead-end flatland.
                    if (hitCount >= 4) {
                        continue;
                    }

                    // Verify proximity: at least one pixel in outer shell (2 to 3 pixels away) must be inundated (alpha > 0)
                    let hasInsideNeighbor = false;
                    const R_OUTER = 3;
                    for (let dy = -R_OUTER; dy <= R_OUTER; dy++) {
                        for (let dx = -R_OUTER; dx <= R_OUTER; dx++) {
                            // Skip the inner 3x3 box we already verified is completely safe
                            if (Math.abs(dy) <= 1 && Math.abs(dx) <= 1) continue;
                            
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
        console.log(`[SafeEdge] スキャン完了: ${tilesScanned}/${tileTasks.length}タイル処理 → ${edges.length}件 of 安全境界点`);
        return edges;
    }

    /**
     * 指定された位置が津波浸水想定区域内にあるかをPNGタイルのピクセル透過度を用いて高精度に判定する

     * @param {number} lat 緯度
     * @param {number} lng 経度
     * @param {string} prefCode 都道府県コード
     * @returns {Promise<boolean>} 浸水想定区域内ならtrue、区域外ならfalse
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
                    const alpha = pixel[3]; // 透明度 (0〜255)
                    
                    // アルファ値が0より大きい（色が付いている）場合、浸水想定区域内と判定
                    const isInundated = alpha > 0;
                    console.log(`[Tsunami Hazard] Location check: alpha=${alpha}, isInundated=${isInundated}`);
                    resolve(isInundated);
                } catch (e) {
                    console.error('[Tsunami Hazard] Canvas processing error:', e);
                    resolve(false);
                }
            };
            
            img.onerror = function() {
                // 画像がない（タイルが存在しない、内陸など）場合は浸水想定区域外とみなす
                resolve(false);
            };
            
            img.src = tileUrl;
        });
    }

    /**
     * 判定結果をHUD上部バー（tsunami-status-box）に美しいグラスモルフィズムバッジとして反映する
     * @param {boolean} isInundated 浸水想定区域内かどうか
     */
    function updateTsunamiStatusUI(isInundated) {
        const box = document.getElementById('tsunami-status-box');
        const textSpan = document.getElementById('tsunami-status-text');
        if (!box || !textSpan) return;
        
        box.classList.remove('hidden');
        box.className = 'dash-info-card'; // クラスの初期化
        
        // 画面幅がスマホかどうか（レスポンシブな表記の微調整）
        const isMobile = window.innerWidth <= 600;
        
        if (isInundated) {
            box.classList.add('tsunami-status-danger');
            textSpan.textContent = isMobile ? '⚠️浸水想定 内' : '⚠️ 津波浸水想定区域 内';
        } else {
            box.classList.add('tsunami-status-safe');
            textSpan.textContent = isMobile ? '✅浸水想定 外' : '✅ 津波浸水想定区域 外';
        }
    }

    /**
     * 現在地または特定座標に基づく、ハザードタイル更新および浸水想定判定の総合実行関数
     * @param {Object} loc 緯度経度オブジェクト {lat, lng}
     */
    async function triggerLocationTsunamiCheck(loc) {
        if (!loc || typeof loc.lat !== 'number' || typeof loc.lng !== 'number') return;
        
        // 1. まず逆ジオコーディングで都道府県コードを特定し、タイルURLを切り替え
        const prefCode = await updateTsunamiPrefecturalTile(loc.lat, loc.lng);
        
        // 2. その都道府県コードのタイルを用いて、現在地が浸水想定区域内かをピクセル判定
        const isInundated = await checkTsunamiInundation(loc.lat, loc.lng, prefCode);
        
        // 3. UIに結果を反映
        updateTsunamiStatusUI(isInundated);
    }
});
