# iRIC 計算結果ビューア（WebAssembly + Zarr）

iRIC プロジェクト（`.ipro` = zip、または展開済みフォルダ）の CGNS 計算結果を **Zarr v2** に変換し、
ブラウザ上で **WebAssembly**（AssemblyScript）でラスタライズして可視化・分析するローカルアプリ。
複数プロジェクトの比較・統合解析と、**pptx レポート出力**に対応。
ブラウザ側は外部 JS ライブラリ不使用（Zarr リーダーも自前、zlib 展開はブラウザ標準の DecompressionStream）。

## 使い方

```bash
cd viz
pip install h5py zarr numcodecs numpy pyproj python-pptx   # 変換 + レポート
npm install && npm run build                               # AssemblyScript -> web/viz.wasm
python server.py 8765                                      # http://127.0.0.1:8765/
```

1. 画面上部の「プロジェクトフォルダ」に iRIC プロジェクトが入ったフォルダを入力（または「フォルダ選択…」でダイアログ）→「スキャン」
2. 一覧から 1 件選んで「表示」→ 単一プロジェクトのビューア（未変換なら自動で CGNS → Zarr 変換、`viz/cache/` にキャッシュ）
3. 2 件以上選んで「比較・統合解析」→ 比較ビュー
4. 各画面の「レポート (pptx)」でスライドを生成・ダウンロード

URL パラメータ `?folder=<path>&open=<name1>,<name2>` で直接開ける。

### テスト用データ

`python make_synthetic.py` は `../extracted`（aaaa.ipro の展開結果）から **合成ケース** を `../projects/` に作る
（`synthetic_low_x0.7`: 水深 ×0.7・流速 ×0.85、`synthetic_high_x1.3`: 水深 ×1.3・流速 ×1.1）。
実際の計算結果ではなく、比較機能の動作確認用。

## 構成

```
viz/
  server.py          ローカル API + 静的配信（標準ライブラリのみ）
  convert.py         .ipro / フォルダ / CGNS -> Zarr v2（project.xml から CRS・ソルバー情報を取得）
  report.py          JSON スペック -> pptx（python-pptx）
  make_synthetic.py  合成テストケース生成
  assembly/index.ts  wasm カーネル（ラスタライズ・カラーマップ・矢印・格子線・面積・湿潤統計・到達時間）
  web/
    index.html       シェル（フォルダ・プロジェクト一覧）+ 共通 CSS
    app.js           走査・変換・ビューア/比較の切替
    wasm.js          wasm 読込と共有バッファ
    zarr.js          依存なし Zarr v2 リーダー
    project.js       Project: Zarr 読込・wasm バッファ・解析（時系列/断面/全ステップ統計/到達時間）
    mapview.js       MapView: canvas 描画・地理院/OSM タイル・ズーム/パン・ホバー・クリック
    charts.js        canvas 折れ線グラフ
    viewer.js        単一プロジェクト UI
    compare.js       比較 UI（並列/差分/統合/統計）
    report.js        オフスクリーン画像化と pptx ダウンロード
    ui.js            DOM ヘルパー・タイムバー
  cache/<name>.zarr  変換キャッシュ（元ファイルの更新時刻で失効判定）
```

### API（server.py）

| メソッド | パス | 内容 |
|---|---|---|
| GET | `/api/projects?folder=` | フォルダ内の `*.ipro` と `project.xml` を含むフォルダを列挙 |
| POST | `/api/convert` `{path}` | 1 プロジェクトを変換（キャッシュ済みならスキップ） |
| POST | `/api/pick-folder` | サーバー側でフォルダ選択ダイアログを開く |
| POST | `/api/report` `{title, subtitle, sections:[...]}` | pptx を生成して返す |
| GET | `/data/<name>/...` | `cache/<name>.zarr` の配信 |

## Zarr レイアウト

| パス | 形状 | 型 | 備考 |
|---|---|---|---|
| `grid/x`, `grid/y` | (nj, ni) | f4 | 節点座標（プロジェクトの CRS） |
| `grid/x3857`, `grid/y3857` | (nj, ni) | f8 | Web メルカトル座標（CRS が分かる場合のみ） |
| `time` | (nt,) | f8 | 経過秒 |
| `results/<var>` | (nt, nj, ni) | f4 | chunks=(1, nj, ni), zlib level 6, fill=NaN |

ルート `.zattrs`: `ni, nj, nt, variables, bbox, bbox3857, crs, solver, solverVersion, project, source_mtime`。

## 単一ビューアの機能

- 変数・カラーマップ・レンジ・乾燥セル閾値・流速ベクトル・格子線・背景地図（地理院 淡色/標準/写真/陰影、OSM）・不透明度
- ズーム/パン、ホバーで節点値、PNG 保存
- 分析ツール: 地点時系列、横断面/縦断面（河床標高＋水位）、全ステップ解析（浸水面積・貯留量・最大水深・最大流速、到達時間・浸水継続時間マップ）、CSV
- グラフは再生に同期（カーソル・値マーカー・断面の再計算）
- レポート: 概要、表示中のグラフ、全ステップ統計（グラフ＋表）、到達時間・浸水継続時間マップ

## 比較ビューの機能

| タブ | 内容 |
|---|---|
| 並列表示 | 全ケースを同じレンジ・同じ時刻・同期ズームで並べる。クリック動作に応じて全ケースの地点時系列、または横断面/縦断面（河床標高＋各ケースの水位、選択変数）を重ね描き。断面は再生に同期し、断面位置は全マップに赤線で表示 |
| 差分 | A − B を発散カラーマップで表示。平均差・RMS・最大\|差\|・湿潤節点の一致率（IoU） |
| 統合解析 | 浸水頻度（浸水したケースの割合）、包絡最大水深、最小の最大水深、最早到達時間、到達時間の幅 |
| 統計比較 | 浸水面積・貯留量・最大水深・最大流速の時系列を重ね描き、要約表と基準ケースとの比 |

### レイアウト調整

- 比較ビューは「行 × 列」のパネルグリッド。「レイアウト」を開いて行数・列数（1〜4）、パネル高さ、各パネルの内容
  （各ケースの地図 / 差分マップ / 統合マップ / 地点時系列 / 断面比較 / 統計時系列 / 要約表 / 空）を選ぶ。
  タブ（並列表示・差分・統合解析・統計比較）はプリセット。設定は localStorage に保存され、同じケース数で開くと復元される。
- 地図パネルはすべて同期ズーム、グラフパネルは再生に同期。
- 単一ビューアは分析ツールの「配置」でグラフを地図の下 / 右に切り替え、「グラフ高さ」を指定できる。

差分・統合マップは全ケースが同一格子のときのみ（格子が異なる場合は統計比較のみ）。
レポート: ケース一覧表、並列表示、差分マップ、統合マップ、統計グラフ＋要約表、地点時系列。

## 定義

- 湿潤セル = 4 節点の平均水深 > 閾値（既定 0.01 m = Nays2D Flood の最小水深）。浸水面積は湿潤セルの面積和、貯留量は Σ(平均水深 × セル面積)。
- 到達時間 = 節点の水深が初めて閾値を超えた時刻 [min]、浸水継続時間 = 水深 > 閾値だった時間の合計 [min]。
- セル面積・断面距離は元の平面直角座標（メートル）で計算。表示は Web メルカトル（北緯 43 度で約 1.37 倍に伸びる）。
- 地理院タイルは出典明記が必要。OSM タイルは個人利用の閲覧程度に留める。

## Web 公開（静的ホスティング）とブラウザ内変換

`web/` フォルダをそのまま静的ホスティング（GitHub Pages、S3、社内 Web サーバーなど、HTTPS）に置くだけで動く。
サーバー API が無い環境では自動的に「静的モード」になり、**変換・解析・レポート生成をすべて利用者のブラウザ内**で行う。
計算結果ファイルは外部に送信されない。

- 「.ipro / .cgn を選択」または「フォルダを選択」でローカルの iRIC プロジェクトを読み込む
  （.ipro は zip をブラウザ標準の DecompressionStream で展開、CGNS は h5wasm（HDF5 の WebAssembly 版、jsDelivr から読込）で読む）
- 変換結果は IndexedDB にキャッシュされ、同じファイルは次回から即時に開く（「キャッシュ削除」で消去）
- 座標変換は `proj.js` に実装（平面直角座標系 I〜XIX の JGD2000/JGD2011、UTM、EPSG:4326/3857）。pyproj と cm 単位で一致
- pptx は PptxGenJS（jsDelivr）でブラウザ内生成。サーバーがある場合も同じ経路を使い、失敗時のみサーバーにフォールバック
- サーバー（server.py）がある環境ではフォルダ走査とサーバー側変換も併用できる

公開手順の例（GitHub Pages）: リポジトリの `docs/` に `web/` の中身（index.html, *.js, viz.wasm）をコピーして Pages を有効化。
`data.zarr` や `cache/` は不要。外部ライブラリは h5wasm と PptxGenJS のみで、必要時に CDN から読み込む。
静的動作の自動テスト: `python test_static.py`（API の無い http.server で web/ を配信し、.ipro をブラウザ内で開く）。

## MCP サーバー（LLM から利用する）

`mcp_server.py` は同じ機能を MCP（Model Context Protocol, stdio）で公開する。解析は `analysis.py`（numpy、ブラウザ側 wasm と同じ定義）、
画像は `render.py`（matplotlib + 地理院/OSM タイル）、pptx は `report.py` を使う。

```bash
pip install mcp matplotlib pillow   # 追加依存
python mcp_server.py                # stdio で待ち受け（通常はクライアントが起動する）
python test_mcp.py                  # 全ツールを MCP クライアント経由で実行するテスト
```

登録:
- Claude Code: ワークスペース直下の `.mcp.json` に登録済み（`python viz/mcp_server.py`）。または `claude mcp add iric -- python <path>/viz/mcp_server.py`
- Claude Desktop: `claude_desktop_config.json` に `{"mcpServers": {"iric": {"command": "python", "args": ["<path>/viz/mcp_server.py"]}}}`

| ツール | 内容 |
|---|---|
| `list_projects(folder)` | フォルダ内の iRIC プロジェクト一覧（変換済みか含む） |
| `convert_project(path)` | .ipro / フォルダ / CGNS を Zarr キャッシュへ変換 |
| `project_info(name)` | 格子・ステップ・座標系・変数と全ステップの min/max |
| `field_stats(name, variable, step, threshold)` | 1 ステップの統計（湿潤節点の min/max/mean、浸水面積、貯留量、最大値の位置） |
| `point_timeseries(name, i, j, variables)` | 節点の時系列 |
| `section(name, i, j, mode, step, variable)` | 横断面（xs）/ 縦断面（ls）の河床標高・水位・水深 |
| `analyze(name, threshold, series_stride)` | 全ステップ解析の要約と時系列 |
| `compare(names, variable, step, threshold)` | 複数ケースの要約・差分統計（平均差、RMS、最大差、湿潤範囲の IoU）・基準との比 |
| `ensemble(names, metric, threshold)` | 統合統計（freq / envmax / envmin / arrmin / arrspread） |
| `render_map` / `render_diff_map` / `render_ensemble_map` | 地図画像（背景地図付き PNG を保存し、縮小 JPEG を返す） |
| `render_timeseries` / `render_section` / `render_stats` | グラフ画像 |
| `make_report(names, …)` | pptx レポート（単一 / 比較）。パスとスライド一覧を返す |
| `open_viewer(names, folder)` | Web ビューア（server.py）を起動して URL を返す |

規約: i, j は 1 始まり、step は 0 始まり（負数は末尾から）、変数は安全名（`Depth`）でも iRIC の名前（`Velocity(ms-1)X`）でも可。
出力ファイルは既定で `viz/out/`、`out_path` で指定可。モデルに返す画像は幅 1000 px の JPEG（環境変数 `IRIC_MCP_PREVIEW_PX` で変更）。
