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

### 大容量対応（第 1 段階）

- **ストリーミング変換**: CGNS を 1 ステップずつ読んで Zarr チャンクに書くため、メモリ使用量はステップ数に依存しない（格子 1 ステップ分）
- **時間不変の変数は 1 回だけ保存**: 標高など全ステップで同一の変数は shape (1, nj, ni) で保存（`static: true`）
- **解析の事前計算**: 変換時に浸水面積・貯留量・最大水深・最大流速の時系列、到達時間・浸水継続時間・最大水深マップを計算し `analysis/thr_0.01/` に同梱。ブラウザは結果を読むだけ
- **時系列・解析はサーバー API**: サーバーモードの地点時系列と全ステップ解析は `/api/timeseries` `/api/analyze` が Zarr をディスクから読んで返す。閾値を変えた解析もサーバーがステップ単位で計算し、結果を Zarr に追記する
- **ブラウザ側 LRU キャッシュ**: 展開済みチャンクの保持量に上限（約 400 MB）
- ブラウザ内変換（静的モード）は目安 1.5 GB まで。超える場合は注意を表示し、サーバーモードを推奨
- 規模試験: `python make_big.py 5` で格子を補間で 5×5 に細分化した合成 CGNS を `../projects_big/` に作れる。実測（このリポジトリの開発 PC）:

| ケース | 節点 | 元 CGNS | Zarr | 変換 | サーバー RSS | 再解析（閾値変更） | 時系列 API | 表示（67k セル） |
|---|---|---|---|---|---|---|---|---|
| aaaa | 7.7k | 108 MB | 22 MB | 14 s | — | 0.1 s | — | 6 ms |
| big_r3 | 68k | 0.74 GB | 125 MB | 35 s | 100 MB | 5.5 s | 0.4 s | 36 ms |
| big_r5 | 189k | 2.0 GB | 341 MB | 70 s | 105 MB | 7.3 s | 0.3 s | — |

変換時間は元データ量にほぼ比例し（約 30 MB/s）、10 GB で 6 分程度、サーバーのメモリはステップ数によらず 100 MB 前後。

### 多数ケースの運用（第 2 段階）

- **登録フォルダ（ルート）とカタログ**: 「データ」でフォルダを登録すると、その中の iRIC プロジェクトが SQLite カタログ（`cache/catalog.sqlite`）に載る。一覧は検索（名前・ソルバー・タグ）と並べ替え（名前・更新日・ステップ数・サイズ・最大水深・浸水面積・最近開いた）ができ、変換済みケースは解析要約（最大水深など）を一覧に表示する
- **変換ジョブキュー**: 「変換」「すべて変換」でバックグラウンドの変換キューに入る（同時実行数は「設定」で変更、既定 2）。各行に進捗（展開 / 変換 xx% / 仕上げ）と中止ボタンが出る。未変換のケースを「表示」した場合も自動でキューに入り、完了後に開く
- **キャッシュ容量管理**: 「設定」のキャッシュ上限（既定 50 GB）を超えると、最近開いていないケースの Zarr から順に削除する（カタログには残り、再変換できる）。空き容量が少ないと一覧に警告
- **変数名の正規化**: Nays2D Flood の `Depth` / Nays2DH・CTIE-2D の `Depth(m)` `WaterSurf(m)` `Elevation(m)` などを共通キーに揃える（`analysis.ALIASES`）。水深のないケース（流速のみ）は表示のみで解析は付かない
- **Windows 対策**: 属性ファイルの書き込みはウイルス対策などによる一時的なアクセス拒否を再試行する。「.」を含むフォルダ名のケースも正しく扱う
- MCP: `catalog_projects` / `register_root` / `queue_conversions` を追加

### API（server.py）

| メソッド | パス | 内容 |
|---|---|---|
| GET | `/api/projects?folder=` | フォルダ内の `*.ipro` と `project.xml` を含むフォルダを列挙 |
| GET/POST | `/api/roots`, `/api/roots/remove` | 登録フォルダの一覧・追加（スキャン付き）・解除 |
| POST | `/api/scan` | 登録フォルダを再スキャン |
| GET | `/api/catalog?q=&sort=&desc=` | カタログ（変換状態・解析要約・ジョブ進捗） |
| POST/GET | `/api/jobs`, `/api/jobs/cancel` | 変換キュー（投入・一覧・中止） |
| GET | `/api/storage`, GET/POST `/api/config` | キャッシュ容量・空き、上限と同時実行数 |
| POST | `/api/convert` `{path}` | 1 プロジェクトを同期変換（キューに入れて完了まで待つ。MCP 用） |
| GET | `/api/convert/status?name=` | 変換の進捗 |
| GET | `/api/analyze?name=&thr=` | 全ステップ解析（事前計算済みなら即時） |
| GET | `/api/timeseries?name=&var=&i=&j=` | 節点の時系列 |
| GET | `/api/section?name=&i=&j=&mode=&t=` | 横断面 / 縦断面 |
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

## 画面構成（レイアウト A）

- **左サイドバー**（≡ で折りたたみ）: 作業順に「データ → 表示 → 解析 → レイアウト（比較時） → 出力」のアコーディオン。開閉状態は保存される
- **ステージ**: 地図が全面。凡例・座標読み取り・全体表示 / ズームボタン・出典は地図内オーバーレイ
- **タイムライン**: 地図直下に固定。再生 / 停止、コマ送り、ステップ番号入力、再生速度（0.5〜4×）。キーボードは ← → でコマ送り（Shift で 10 ステップ）、Space で再生 / 停止、Home / End
- **ドロワー**（単一ビュー）: 地図の下（または右）に時系列 / 断面 / 統計のタブ。ヘッダーをドラッグして高さ（右配置では幅）を変更、× で閉じると地図が全高
- **比較ビュー**: ステージ全体が行 × 列のパネルグリッド。設定はサイドバーに集約

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
- 単一ビューアは「解析」グループの「グラフの配置」でドロワーを下 / 右に切り替えられる。

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

- 「.ipro / .cgn を選択」または「フォルダを選択」でローカルの iRIC プロジェクトを読み込む。フォルダは次の 3 通りを認識する
  1. .ipro ファイルが入ったフォルダ
  2. .ipro を展開した（または iRIC がフォルダ形式で保存した）プロジェクトフォルダそのもの（project.xml + Case1.cgn などを含む）
  3. 2 のプロジェクトフォルダを複数含む親フォルダ（一括で一覧に追加。2 階層下まで探索）
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
