# -*- coding: utf-8 -*-
"""残存文字化けの行単位修正（第2弾）"""

s = open('app.js', encoding='utf-8').read()
lines = s.split('\n')

line_fixes = {
    # console.warn SafeEdge fallback
    2354: " console.warn(`[SafeEdge] すべての候補のスナップ点が安全域外または検証エラーのため、最寄りを緊急採用します: ${fallbackEdge.name || fallbackEdge.id}`);",
    # P2P コメント
    2691: " // code 551 = 地震情報, code 556 = 地震速報",
    2718: " // code 551 = 震源発生情報「地震情報」, code 556 = 緊急地震速報（本震）",
    2720: " // 地震速報クラスを確認",
    2725: "  data.code === 551; // 地震情報が来た時点で緊急モード発動",
    # JSDoc コメント
    3060: "  * 緯度経度から都道府県コードを特定し、ハザードマップタイルを動的に切り替える",
    3063: "  * @returns {Promise<string>} 都道府県コード (2桁)",
    3067: "  // 国土地理院の逆ジオコーディングAPIを使用",
    3075: "  // muniCdの先頭2桁が都道府県コード",
    3096: "  * 緯度経度からズームレベル14におけるXYZタイル座標とタイル内ピクセル座標を算出する",
}

for idx, new_line in line_fixes.items():
    if idx < len(lines):
        lines[idx] = new_line

# さらにパターン置換で残りを処理
s2 = '\n'.join(lines)

extra = [
    # 残存文字化けパターン
    ("// 豌苓ｱ｡蠎∫匱陦ｨ縲梧ｴ･豕｢諠・ｱ縲・ code 556",
     "// 震源発生情報「地震情報」 code 556"),
    ("'豢･豕｢隴ｦ蝣ｱ'", "'地震速報'"),
    ("'螟ｧ豢･豕｢隴ｦ蝣ｱ'", "'大地震速報'"),
    ("data.code === 551; // 豢･豕｢", "data.code === 551; // 地震"),
    ("if (reconnectTimer) return; // 莠碁㍾", "if (reconnectTimer) return; // 多重"),
    ("// P2P謗･邯夂憾諷九ｒHUD", "// P2P接続状態をHUD"),
    ("|| '蠕・ｩ滉ｸｭ'", "|| '接続中'"),
    # JSDoc
    ("* 邱ｯ蠎ｦ邨悟ｺｦ縺九ｉ驛ｽ驕灘ｺ懃恁繧ｳ繝ｼ繝峨ｒ迚ｹ螳壹＠縲√ﾜ繝ｼ繝峨・繝・・繧ｿ繧､繝ｫ繧貞虚逧・↓蛻・ｊ譖ｿ縺医ｋ",
     "* 緯度経度から都道府県コードを特定し、ハザードマップタイルを動的に切り替える"),
    ("* @returns {Promise<string>} 驛ｽ驕灘ｺ懃恁繧ｳ繝ｼ繝・(2譯・",
     "* @returns {Promise<string>} 都道府県コード (2桁)"),
    ("// 蝗ｽ蝨溷慍逅・劼縺ｮ霆ｽ驥城・ず繧ｪ繧ｳ繝ｼ繝・ぅ繝ｳ繧ｰAPI繧貞茜逕ｨ",
     "// 国土地理院の逆ジオコーディングAPIを使用"),
    ("// muniCd縺ｮ蜈磯ｭ2譯√′驛ｽ驕灘ｺ懃恁繧ｳ繝ｼ繝・",
     "// muniCdの先頭2桁が都道府県コード"),
    ("// 繧ｿ繧､繝ｫURL繧貞虚逧・↓譖ｴ譁ｰ", "// タイルURLを動的に更新"),
    ("* 邱ｯ蠎ｦ邨悟ｺｦ縺九ｉ繧ｺ繝ｼ繝繝ｬ繝吶Ν14縺ｫ縺翫￠繧宜YZ繧ｿ繧､繝ｫ蠎ｧ讓吶→繧ｿ繧､繝ｫ蜀・ヴ繧ｯ繧ｻ繝ｫ蠎ｧ讓吶ｒ邂怜・縺吶ｋ",
     "* 緯度経度からズームレベル14におけるXYZタイル座標とタイル内ピクセル座標を算出する"),
    ("* 迴ｾ蝨ｨ蝨ｰ縺ｾ縺溘・迚ｹ螳壼ｺｧ讓吶↓蝓ｺ縺･縺上√ﾜ繝ｼ繝峨・繝・・繧ｿ繧､繝ｫ譖ｴ譁ｰ縺翫ｈ縺ｳ豬ｸ豌ｴ諠ｳ螳壼愛螳壹・邱丞粋螳溯｡碁未謨ｰ",
     "* 現在地または指定座標に基づく、ハザードマップタイル更新および浸水情報確認の統合関数"),
    ("* @param {Object} loc 邱ｯ蠎ｦ邨悟ｺｦ繧ｪ繝悶ず繧ｧ繧ｯ繝・{lat, lng}",
     "* @param {Object} loc 緯度経度オブジェクト {lat, lng}"),
    ("// 1. 縺ｾ縺夐・ず繧ｪ繧ｳ繝ｼ繝・ぅ繝ｳ繧ｰ縺ｧ驛ｽ驕灘ｺ懃恁繧ｳ繝ｼ繝峨ｒ迚ｹ螳壹＠縲√ち繧､繝ｫURL繧貞・繧頑崛縺・",
     "// 1. まず逆ジオコーディングで都道府県コードを特定し、タイルURLを書き換える"),
    ("// 2. 縺昴・驛ｽ驕灘ｺ懃恁繧ｳ繝ｼ繝峨・繧ｿ繧､繝ｫ繧堤畑縺・※縲∫樟蝨ｨ蝨ｰ縺梧ｵｸ豌ｴ諠ｳ螳壼玄蝓溷・縺九ｒ繝斐け繧ｻ繝ｫ蛻､螳・",
     "// 2. その都道府県コードのタイルを用いて、現在地が浸水情報確認点かをピクセル判定"),
    ("// 3. UI縺ｫ邨先棡繧貞渚譏", "// 3. UIに結果を反映"),
    ("* 蛻､螳夂ｵ先棡繧辿UD荳企Κ繝舌・・・sunami-status-box",
     "* 判定結果をHUD上部バー（tsunami-status-box"),
    ("* @param {boolean} isInundated 豬ｸ豌ｴ諠ｳ螳壼玄蝓溷・縺九←縺・°",
     "* @param {boolean} isInundated 浸水情報確認点かどうか"),
    # SafeEdge scan log
    ("[SafeEdge] 繧ｹ繧ｭ繝｣繝ｳ螳御ｺ・", "[SafeEdge] スキャン完了: "),
    # Pixel description comments
    ("// 騾乗・蠎ｦ (0縲・55)", "// 透明度 (0-255)"),
    ("// 繧｢繝ｫ繝輔ぃ蛟､縺・繧医ｊ螟ｧ縺阪＞・郁牡縺御ｻ倥＞縺ｦ縺・ｋ・牙ｴ蜷医∵ｵｸ豌ｴ諠ｳ螳壼玄蝓溷・縺ｨ蛻､螳・",
     "// アルファ値が十分大きい（色が塗られている）場合、浸水情報確認点と判定"),
    ("// 逕ｻ蜒上′縺ｪ縺・ｼ医ち繧､繝ｫ縺悟ｭ伜惠縺励↑縺・∝・髯ｸ縺ｪ縺ｩ・牙ｴ蜷医・豬ｸ豌ｴ諠ｳ螳壼玄蝓溷､悶→縺ｿ縺ｪ縺・",
     "// 画像がない（タイルが存在しない、海上など）場合は浸水情報確認点外とみなす"),
    # verifyAndClean
    ("[SafeEdge] verifyAndClean: 豬ｷ豢九∪縺溘・豌ｴ邉ｻ霑大ｍ縺ｮ縺溘ａ髯､螟・",
     "[SafeEdge] verifyAndClean: 遠すぎまたは陸地外のため除外: "),
    ("[SafeEdge] verifyAndClean: 豬ｸ豌ｴ蝓溷・縺ｮ縺溘ａ髯､螟・",
     "[SafeEdge] verifyAndClean: 浸水域内のため除外: "),
    ("[SafeEdge] verifyAndClean: 豬ｸ豌ｴ螳牙・繝舌ャ繝輔ぃ(80m)荳崎ｶｳ縺ｮ縺溘ａ髯､螟・",
     "[SafeEdge] verifyAndClean: 浸水安全バッファ(80m)未満のため除外: "),
    # 残余
    ("'骼悟臥函豸ｯ蟄ｦ鄙偵そ繝ｳ繧ｿ繝ｼ'", "'鎌倉生涯学習センター'"),
    # canvas labels残り
    ("ctx.fillText('讌ｵ讌ｽ蟇ｺ繝ｻHase譁ｹ髱｢'", "ctx.fillText('長谷・Hase方面'"),
    ("ctx.fillText('陦｣蠑ｵ螻ｱ譁ｹ髱｢'", "ctx.fillText('北鎌倉方面'"),
    ("ctx.fillText('逕ｱ豈斐Ω豬懈ｵｷ蟯ｸ'", "ctx.fillText('由比ヶ浜海岸'"),
    ("ctx.fillText('闍･螳ｮ螟ｧ霍ｯ'", "ctx.fillText('若宮大路'"),
]

count = 0
for old, new in extra:
    if old in s2:
        s2 = s2.replace(old, new)
        count += 1

open('app.js', 'w', encoding='utf-8', newline='').write(s2)

moji_chars = set('縺繧繝逕隱謌莉縲竏蝓謦謚逋讀繻遶蝙豢遐蠕螳謖驕陦釜蜍')
remaining = [(i+1, l) for i,l in enumerate(s2.split('\n')) if any(c in moji_chars for c in l)]
print(f'Extra fixed: {count}')
print(f'Final remaining mojibake lines: {len(remaining)}')
for ln, txt in remaining[:10]:
    print(f'  {ln}: {txt[:100]}')
