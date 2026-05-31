# -*- coding: utf-8 -*-
"""app.jsの文字化けを一括修正し、2つのポップアップを復元する"""
import re, json

s = open('app.js', encoding='utf-8').read()

# ============================================================
# 1. 文字化け一括修正
# ============================================================
fixes = [
    # FALLBACK_SHELTERS 避難所名
    ('骼悟牙ｸょｽｹ謇', '鎌倉市役所'),
    ('貂・ｳ牙ｰ丞ｭｦ譬｡', '長谷小学校'),
    ('骼悟臥函豸ｯ蟄ｦ鄙偵そ繝ｳ繧ｿ繝ｼ', '鎌倉生涯学習センター'),
    # addShelterMarkers フォールバックテキスト
    ('驕ｿ髮｣謇', '避難所'),
    ('蟆丞ｭｦ譬｡', '小学校'),
    ('荳ｭ蟄ｦ譬｡', '中学校'),
    ('蠅・・', '境内'),
    ('蟄ｦ鄙偵そ繝ｳ繧ｿ繝ｼ', '学習センター'),
    ("'蜿主ｮｹ閭ｽ蜉・ {capacity}莠ｺ'", "'収容能力: {capacity}人'"),
    ("'蜈ｸ蝙句茜逕ｨ邇・ {occupancy}%'", "'典型利用率: {occupancy}%'"),
    ('窶ｻ繧ｷ繝溘Η繝ｬ繝ｼ繧ｷ繝ｧ繝ｳ邨ｱ險医↓蝓ｺ縺･縺丈ｺ域ｸｬ縲ゅΜ繧｢繝ｫ繧ｿ繧､繝繝・・繧ｿ縺ｧ縺ｯ縺ゅｊ縺ｾ縺帙ｓ',
     '※シミュレーション統計に基づく予測。リアルタイムデータではありません'),
    # share text
    ("'迴ｾ蝨ｨ縲∝ｮ牙・縺ｪ鬮伜床縺ｸ驕ｿ髮｣荳ｭ縺ｧ縺吶・n迴ｾ蝨ｨ蝨ｰ: '",
     "'現在、安全な高台へ避難中です。\\n現在地: '"),
    # DynamicIsland labels
    ('" 迴ｾ蝨ｨ蝨ｰ繧呈､懷・荳ｭ..."', '" 現在地を取得中..."'),
    ('" 迴ｾ蝨ｨ蝨ｰ繧貞酔譛溘＠縺ｾ縺励◆"', '" 現在地を同期しました"'),
    # scenario location names
    ('"蝨ｰ轤ｹA: 逕ｱ豈斐Ω豬懈ｵｷ蟯ｸ (譛蜊ｱ髯ｺ蝨ｰ蟶ｯ/豬ｷ謚・.4m)"',
     '"地点A: 由比ヶ浜海岸 (最危険地帯/海抜0.4m)"'),
    ('"髱偵＞繝ｫ繝ｼ繝医↓豐ｿ縺｣縺ｦ逶ｴ縺｡縺ｫ鬮伜床・亥ｾ｡謌仙ｰ丞ｭｦ譬｡・峨∈驕ｿ髮｣縺励※縺上□縺輔＞"',
     '"青いルートに沿って直ちに高台（御成小学校）へ避難してください"'),
    ('"蝨ｰ轤ｹB: 蜥檎伐蝪夐ｧ・ｻ倩ｿ・(蜀・匣荳ｭ髢灘慍蟶ｯ/豬ｷ謚・.8m)"',
     '"地点B: 和田塚駅周辺 (市街中間地帯/海抜0.8m)"'),
    ('"髱偵＞繝ｫ繝ｼ繝医↓豐ｿ縺｣縺ｦ譛蟇・ｊ縺ｮ鬮伜床・磯詞蛟牙ｸょｽｹ謇・峨∈驕ｿ髮｣縺励※縺上□縺輔＞"',
     '"青いルートに沿って最寄りの高台（鎌倉市役所）へ避難してください"'),
    ('"蝨ｰ轤ｹA: 荳・㈹繝ｶ豬懈ｵｷ蟯ｸ (譛蜊ｱ髯ｺ蝨ｰ蟶ｯ/豬ｷ謚・.1m)"',
     '"地点A: 七里ヶ浜海岸 (最危険地帯/海抜0.1m)"'),
    ('"髱偵＞驕ｿ髮｣繝ｫ繝ｼ繝医↓豐ｿ縺｣縺ｦ鬮伜床・磯詞蛟峨・繝ｪ繝ｳ繧ｹ繝帙ユ繝ｫ譁ｹ髱｢・峨∈驕ｿ髮｣縺励※縺上□縺輔＞"',
     '"青い避難ルートに沿って高台（鎌倉プリンスホテル方面）へ避難してください"'),
    ('"蝨ｰ轤ｹB: 荳・㈹繝ｶ豬憺ｧ・燕 (豎溘ヮ髮ｻ豐ｿ邱・豬ｷ謚・.0m)"',
     '"地点B: 七里ヶ浜駅前 (江ノ電沿線/海抜3.0m)"'),
    ('"髱偵＞驕ｿ髮｣繝ｫ繝ｼ繝医↓豐ｿ縺｣縺ｦ譛蟇・ｊ縺ｮ鬮伜床・井ｸ・㈹繧ｬ豬懈擲鬮伜床蜈ｬ蝨抵ｼ峨∈驕ｿ髮｣縺励※縺上□縺輔＞"',
     '"青い避難ルートに沿って最寄りの高台（七里ガ浜東高台公園）へ避難してください"'),
    # コメント類
    ('// 繧ｹ繝槭・迚ｹ蛹匁ｩ溯・縺ｮ蛻晄悄蛹・', '// スマホ特化機能の初期化'),
    ('"蛻ｰ驕比ｺ域ｸｬ:"', '"到達予測:"'),
    ('"莠域Φ蛻ｰ驕疲凾髢・"', '"予想到達時間"'),
    ('繝ｫ繝ｼ繝・${route.id}', 'ルート${route.id}'),
    ('驕ｸ謚・/span>', '選択</span>'),
    ('隕丞ｮ壹・繝ｫ繝ｼ繝医ｒ菴ｿ逕ｨ縺吶ｋ', '推奨のルートを使用する'),
    ('窶ｻ縺薙・繝ｫ繝ｼ繝医・縺ゅ￥縺ｾ縺ｧ蜿り・ュ蝣ｱ縺ｧ縺吶・br>螳滄圀縺ｮ驕ｿ髮｣譎ゅ・迴ｾ蝣ｴ縺ｮ迥ｶ豕・ｼ亥貞｣翫ｄ豬ｸ豌ｴ縺ｪ縺ｩ・峨ｒ蜆ｪ蜈医＠縺ｦ縺上□縺輔＞縲・',
     '※このルートはあくまで参考情報です。<br>実際の避難時は現場の状況（倒壊や浸水など）を優先してください。'),
    ('---- PRIMARY GOAL MARKER (隨ｬ荳逶ｮ讓・ 螳牙・鬮伜床) ----',
     '---- PRIMARY GOAL MARKER (第一目標: 安全高台) ----'),
    ('---- SECONDARY ROUTE (隨ｬ莠檎岼讓・ 驕ｿ髮｣謇縺ｸ縺ｮ蛻・ｲ千ｴ邱・ ----',
     '---- SECONDARY ROUTE (第二目標: 避難所への分岐ルート) ----'),
    ('// BUILD ROUTE A (譛遏ｭ繝ｫ繝ｼ繝・-> Pure nearest safe edge)',
     '// BUILD ROUTE A (最短ルート -> Pure nearest safe edge)'),
    ('// BUILD ROUTE B (驕楢ｷｭ豺ｷ髮大屓驕ｿ繝ｫ繝ｼ繝・- uses detour if available)',
     '// BUILD ROUTE B (道路混雑回避ルート - uses detour if available)'),
    ('// BUILD SECONDARY ROUTE (隨ｬ莠檎岼讓・ 驕ｿ髮｣謇縺ｸ縺ｮ蛻・ｲ舌Ν繝ｼ繝・',
     '// BUILD SECONDARY ROUTE (第二目標: 避難所への分岐ルート)'),
    ('// BUILD ROUTE C (繝舌Μ繧｢繝輔Μ繝ｼ繝ｻ蜍ｾ驟榊屓驕ｿ繝ｫ繝ｼ繝・窶・Real slope-based calculation)',
     '// BUILD ROUTE C (バリアフリー・勾配回避ルート - Real slope-based calculation)'),
    ("'繝ｻ譛螟ｧ蜍ｾ驟・{slope}%'", "'・最大勾配: {slope}%'"),
    (">譛驕ｩ繝ｫ繝ｼ繝医ｒ自動計箁E/div>", ">最適ルートを自動計算</div>"),
    (">隍・粋逧・↓閠・・縺励∵怙驕ｩ縺ｪ邨瑚ｷｯ繧定・蜍輔〒驕ｸ縺ｳ縺ｾ縺・/div>",
     ">総合的に判断し、最適な経路を自動で選びます</div>"),
    # SafeEdge ログ
    ('[SafeEdge] 螳牙・蠅・阜蛟呵｣懈焚:', '[SafeEdge] 安全境界候補数:'),
    ('OSRMスナップ点が浸水域内のため、この候補をスキップします:', '[SafeEdge] OSRMスナップ点が浸水域内のため、この候補をスキップします: '),
    ('[SafeEdge] 螳牙・縺ｪ繧ｹ繝翫ャ繝怜・繧堤｢ｺ隱・', '[SafeEdge] 安全なスナップ点を確認: '),
    ('[SafeEdge] 縺吶∋縺ｦ縺ｮ蛟呵｣懊・繧ｹ繝翫ャ繝怜・縺悟ｮ牙・蝓溷､悶∪縺溘・讀懆ｨｼ繧ｨ繝ｩ繝ｼ縺ｮ縺溘ａ縲∵怙蟇・ｊ繧堤ｷ頑･謗｡逕ｨ縺励∪縺・',
     '[SafeEdge] すべての候補のスナップ点が安全域外または検証エラーのため、最寄りを緊急採用します: '),
    # P2P
    ('// 菴ｿ逕ｨAPI: wss://api.p2pquake.net/v2/ws・・2P蝨ｰ髴・ュ蝣ｱ繝阪ャ繝医Ρ繝ｼ繧ｯ・・',
     '// 使用API: wss://api.p2pquake.net/v2/ws (P2P地震情報ネットワーク)'),
    ("'螟ｧ豢･豕｢隴ｦ蝣ｱ'", "'大地震速報'"),
    ("'豢･豕｢隴ｦ蝣ｱ'", "'地震速報'"),
    ('// code 551 = 豢･豕｢諠・ｱ, code 556 = 豢･豕｢隴ｦ蝣ｱ',
     '// code 551 = 地震情報, code 556 = 地震速報'),
    ('if (reconnectTimer) return; // 莠碁㍾莠育ｴ・ｒ髦ｲ縺・',
     'if (reconnectTimer) return; // 多重接続を防ぐ'),
    ('// P2P謗･邯夂憾諷九ｒHUD縺ｫ蜿肴丐縺吶ｋ', '// P2P接続状態をHUDに反映する'),
    ("|| '蠕・ｩ滉ｸｭ'", "|| '接続中'"),
    # SafeEdge scan
    ('[SafeEdge] 豢･豕｢豬ｸ豌ｴ蛹ｺ蝓溘・蠅・阜繧ｹ繧ｭ繝｣繝ｳ繧帝幕蟋九＠縺ｾ縺・..',
     '[SafeEdge] 地震浸水安全点の再スキャンを開始します..'),
    ('[SafeEdge] 繧ｹ繧ｭ繝｣繝ｳ蟇ｾ雎｡繧ｿ繧､繝ｫ謨ｰ:', '[SafeEdge] スキャン対象タイル数:'),
    ("'螳牙・蠅・阜轤ｹ'", "'安全境界点'"),
    # notification
    ('"騾夂衍險ｱ蜿ｯ縺梧怏蜉ｹ縺ｪ縺ｫ縺ｪ繧翫∪縺励◆"', '"通知許可が有効になりました"'),
    # shoreline
    ('豬ｷ蟯ｸ邱壹∪縺ｧ', '海岸線まで'),
    # canvas labels (onboarding animation)
    ("'讌ｵ讌ｽ蟇ｺ繝ｻHase譁ｹ髱｢'", "'長谷・Hase方面'"),
    ("'陦｣蠑ｵ螻ｱ譁ｹ髱｢'", "'北鎌倉方面'"),
    ("'逕ｱ豈斐Ω豬懈ｵｷ蟯ｸ'", "'由比ヶ浜海岸'"),
    ("'闍･螳ｮ螟ｧ霍ｯ'", "'若宮大路'"),
    # share emergency
    ('縲慎ENDEN繝槭う驕ｿ髮｣險育判縲', '【TENDENマイ避難計画】'),
    # comments
    ('Dynamically translate the prefix', 'Dynamically translate the prefix'),
    ('// 蝗ｽ蝨溷慍逅・劼縺ｮ霆ｽ驥城・ず繧ｪ繧ｳ繝ｼ繝・ぅ繝ｳ繧ｰAPI繧貞茜逕ｨ',
     '// 国土地理院の逆ジオコーディングAPIを使用'),
    ('// muniCd縺ｮ蜈磯ｭ2譯√′驛ｽ驕灘ｺ懃恁繧ｳ繝ｼ繝・',
     '// muniCdの先頭2桁が都道府県コード'),
    ('// 繧ｿ繧､繝ｫURL繧貞虚逧・↓譖ｴ譁ｰ', '// タイルURLを動的に更新'),
    ('// Central avenue (闍･螳ｮ螟ｧ霍ｯ)', '// Central avenue (若宮大路)'),
    ('// Draw Sand/Beach (Yuigahama 遐よｵ・', '// Draw Sand/Beach (Yuigahama 海岸)'),
    ("box.className = 'dash-info-card'; // 繧ｯ繝ｩ繧ｹ縺ｮ蛻晄悄蛹・",
     "box.className = 'dash-info-card'; // クラスの初期化"),
    ('// 逕ｻ髱｢蟷・′繧ｹ繝槭・縺九←縺・°・医Ξ繧ｹ繝昴Φ繧ｷ繝悶↑陦ｨ険倥・蠕ｮ隱ｿ謨ｴ・・',
     '// 画面幅がスマホかどうか（レスポンシブな表示の後調整）'),
    ('let currentPrefCode = \'14\'; // 蛻晄悄蛟､縺ｯ逾槫･亥ｷ晉恁 (JIS: 14)',
     "let currentPrefCode = '14'; // 初期値は神奈川県 (JIS: 14)"),
    ('// Tsunami National Hazard Map & Location Inundation Detection (蜈ｨ蝗ｽ蛹ｺ蟇ｾ蠢懶ｼ・樟蝨ｨ蝨ｰ豬ｸ豌ｴ諠ｳ螳壼玄蝓溷・螟門愛螳・',
     '// Tsunami National Hazard Map & Location Inundation Detection (全国対応、現在地浸水情報確認安全点特定)'),
]

count = 0
for old, new in fixes:
    if old in s:
        s = s.replace(old, new)
        count += 1

# ============================================================
# 2. 2つのポップアップを btnTestAlert のコールバック内に復元
#    (map.once('moveend') 内、spBtn表示の直後)
# ============================================================
popup_target = """  // btn-set-pin を表示（リスナーはすでに下で登録済み）
  const spBtn = document.getElementById('btn-set-pin');
  if (spBtn) spBtn.classList.remove('hidden');

  const dict = i18nDict[getLanguageCode()] || i18nDict['ja'] || {};

 // Set Pin button listener for Crosshair mode"""

popup_replacement = """  // btn-set-pin を表示（リスナーはすでに下で登録済み）
  const spBtn = document.getElementById('btn-set-pin');
  if (spBtn) spBtn.classList.remove('hidden');

  const dict = i18nDict[getLanguageCode()] || i18nDict['ja'] || {};

  // ── 学術紹介ポップアップ（クリーンな日本語・ポータルリンク付き）──
  const portalUrl = 'https://masatosprojects.github.io/kamakura-sim/';
  const introTitle = '鎌倉市由比ヶ浜における避難行動シミュレーションについて';
  const introDesc =
    '本エリア（鎌倉市由比ヶ浜周辺）は、高校生研究者である開発者が学術的な' +
    '避難行動シミュレーション研究を実施した対象地域です。<br><br>' +
    '本アプリ「TENDEN」には、研究の成果である<b>道路混雑の動的シミュレーション統計</b>および' +
    '<b>時間変化する避難所負荷モデル</b>がリアルタイムに結合されています。<br><br>' +
    '<a href="' + portalUrl + '" target="_blank" ' +
    'style="display:inline-flex;align-items:center;text-decoration:none;' +
    'background:#007aff;color:#fff;padding:10px 16px;border-radius:10px;' +
    'font-weight:700;font-size:0.88rem;gap:8px;margin-top:10px;">' +
    '公式研究ポータルを見る →</a>';

  showCustomAlert(introTitle, introDesc, 'info', () => {
    // ─ 避難開始位置の設定ポップアップ ─
    showCustomAlert(
      dict.alertLocationTitle || '避難開始位置を設定してください',
      dict.alertLocationDesc  || 'マップをドラッグして画面中央のターゲット（＋印）を避難開始位置に合わせてから、下部のボタンをタップしてください。',
      'info'
    );
  });

 // Set Pin button listener for Crosshair mode"""

if popup_target in s:
    s = s.replace(popup_target, popup_replacement, 1)
    print('Popups restored: OK')
else:
    print('WARNING: popup insertion target not found')

# ============================================================
# 3. localStorage の tenden-demo-seen フラグを起動時に1回リセット
#    （onboarding が初回から必ず表示されるよう）
# ============================================================
reset_target = " // Initialize (各関数をtry/catchで保護 — どれかがエラーでもスプラッシュは消える)"
reset_insert = """ // ── 初回デモ強制リセット（新バージョン起動時に必ずオンボーディングを表示）──
 (function resetDemoFlag() {
   try {
     var ver = 'v59';
     if (localStorage.getItem('tenden-pwa-ver') !== ver) {
       localStorage.removeItem('tenden-demo-seen');
       localStorage.setItem('tenden-pwa-ver', ver);
     }
   } catch(e) {}
 })();

 // Initialize (各関数をtry/catchで保護 — どれかがエラーでもスプラッシュは消える)"""

if reset_target in s:
    s = s.replace(reset_target, reset_insert, 1)
    print('Demo reset logic: OK')
else:
    print('WARNING: demo reset target not found')

open('app.js', 'w', encoding='utf-8', newline='').write(s)

# 結果確認
moji_chars = set('縺繧繝逕隱謌莉縲竏蝓謦謚逋讀繻遶蝙豢遐蠕螳謖驕陦釜蜍')
remaining = [(i+1, l) for i,l in enumerate(s.split('\n')) if any(c in moji_chars for c in l)]
print(f'Fixed {count}/{len(fixes)} patterns')
print(f'Remaining mojibake lines: {len(remaining)}')
for ln, txt in remaining[:10]:
    print(f'  {ln}: {txt[:90]}')
