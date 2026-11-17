# Sendo のアイコン

「情報の流れ」と S を重ねたマーク。青緑の地と白いリボンは、採用したラフの形を引き継いでいる。

## 元画像と書き出し

`sendo-icon.png` は Imagegen の組み込みツールで採用案を整えた、1254 × 1254 px の不透明な元画像。画面には配信せず、`apps/web/public/` に書き出したものを使う。背景は端まで塗り、ホーム画面での角丸は OS に任せる。

| 用途 | 配信するファイル | 書き出し方 |
| --- | --- | --- |
| 通常の PWA | `icons/icon-192.png`、`icons/icon-512.png` | 元画像の中央 1024 × 1024 px を切り出し、192・512 px に縮小 |
| 切り抜きに対応する PWA | `icons/icon-maskable-512.png` | 元画像全体を 512 px に縮小 |
| iPhone・iPad のホーム画面 | `apple-touch-icon.png` | 通常版と同じ切り出しから 180 px に縮小 |
| ブラウザのタブ | `favicon.png` | 通常版と同じ切り出しから 32 px に縮小 |

maskable 版は、マークを中心から幅の 40% の半径の円内に収める。[Web アプリマニフェストの説明](https://web.dev/learn/pwa/web-app-manifest)にある安全領域に合わせて、通常版より余白を広くしている。iOS には [apple-touch-icon](https://developer.apple.com/library/archive/documentation/AppleApplications/Reference/SafariWebContent/ConfiguringWebApplications/ConfiguringWebApplications.html) も指定する。

## 元画像を仕上げたときの指示

入力は、会話中に採用された角丸タイルのラフ。形を作り直さず、外側の背景を取り除いてアイコン用に整えた。再制作するときも、現在の元画像のマークを維持する。

```text
Edit the supplied approved Sendo app icon into its final production asset. Preserve the exact distinctive flowing ivory S ribbon emblem, its sweeping silhouette, diagonal rhythm, proportions, direction, and deep teal palette. Change ONLY the presentation and finish: remove the outer cream presentation backdrop and the rounded tile corners, extending the deep teal field edge-to-edge across the entire square image. The result must be one opaque perfectly square icon asset with four square corners, no frame, no border, no external margin, no drop shadow. Keep the emblem centered and scale it so all ivory details and tips fit comfortably within a circle of radius 37 percent of image width, centered on the image (critical for maskable icons). The emblem should occupy roughly 62 percent of canvas height and 50 percent of canvas width while retaining its original aspect ratio. Make the teal field uniform flat color close to #0f766e. Preserve the subtle ribbon fold but reduce its shading to a quiet simple darker teal, clean the cream ribbon toward near-white. No new objects, no text, no new logo design, no glow, no texture, no phone mockup, no multiple variants. Output only the finished edge-to-edge square app-icon image, large enough to downsample to 512x512, 192x192 and 180x180.
```
