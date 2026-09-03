# iRIC 計算結果ビューア（WebAssembly + Zarr）

iRIC（Nays2D Flood など）の計算結果を、ブラウザだけで可視化・比較・分析し、pptx レポートまで作るツールです。
Zarr 形式のデータを自前のリーダーで読み、AssemblyScript 製 WebAssembly でラスタライズします。
静的ホスティングでは .ipro / CGNS の変換もブラウザ内（h5wasm）で行うため、計算結果ファイルは利用者の PC から外に出ません。

- Web 版（GitHub Pages）: `https://riverlink.github.io/iric-wasm-zarr-viewer/`
- 詳細な使い方・構成・MCP サーバー: [viz/README.md](viz/README.md)

## 主な機能

- 単一ケース: 地図（地理院タイル / OSM）上の水深・水位・流速表示、地点時系列、横断面 / 縦断面、全ステップ解析（浸水面積・貯留量・到達時間・浸水継続時間）
- 複数ケース: 並列表示、差分マップ、統合解析（浸水頻度・包絡最大水深・最早到達時間）、統計比較、断面比較、行 × 列で自由に組めるダッシュボード
- レポート: pptx をブラウザ内（PptxGenJS）または Python（python-pptx）で生成
- LLM 連携: `viz/mcp_server.py` が同じ機能を MCP ツールとして公開

## ローカルで動かす

```bash
cd viz
pip install h5py zarr numcodecs numpy pyproj python-pptx mcp matplotlib pillow
npm install && npm run build      # AssemblyScript -> web/viz.wasm
python server.py 8765             # http://127.0.0.1:8765/
```

## リポジトリ構成

```
viz/assembly/   wasm カーネル（AssemblyScript）
viz/web/        Web アプリ（静的サイト。GitHub Pages に自動デプロイ）
viz/*.py        変換・解析・レポート・ローカル API サーバー・MCP サーバー
.github/        Pages デプロイ用ワークフロー
```

計算データ（.ipro, CGNS, 変換キャッシュ）はリポジトリに含めていません。

## ライセンス・出典

背景地図は地理院タイル（出典明記が必要）および © OpenStreetMap contributors を利用します。
