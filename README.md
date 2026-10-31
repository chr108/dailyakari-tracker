# Daily Akari Tracker（非公式）

[Daily Akari](https://dailyakari.com/) のクリア状況とクリアタイムを記録する、**非公式**の補助ツールです。**Daily Akari の作者とは関係ありません。**

- 難易度別のクリア状況（🌟／🎯）の集計表示
- 問題番号の一覧からの問題選択（難易度・クリア状況・作問者で絞り込み）
- クリアタイムの自動記録と自己ベストの管理

ブックマークレットから起動し、Daily Akari のページの中だけで動きます。

## 使い方

導入ページ（GitHub Pages）の案内に従ってください。

`https://chr108.github.io/dailyakari-tracker/`

## データの扱い

- 記録は Daily Akari のオリジンの localStorage（キーの接頭辞 `dat.`）にだけ保存します。外部へは送信しません。
- 通信するのは、本体（`tracker.js`）の読み込みと、Daily Akari の API（問題一覧の取得）だけです。
- Daily Akari 本体の保存データは読み取るだけで、書き換えません。

## 構成

```
docs/          GitHub Pages の公開対象（Settings → Pages → main ブランチ /docs）
  index.html   導入ページ
  tracker.js   本体（外部ライブラリなし、圧縮なしの 1 ファイル）
  .nojekyll
```

## 開発

- ビルドやテストの仕組みはありません。`docs/tracker.js` を直接編集します。
- Daily Akari の localStorage・API・ゲームからの通知に依存するため、動作確認は dailyakari.com の上で行います（CSP がないので、開発者ツールのコンソールに `tracker.js` の中身を貼り付けても動きます）。
- Daily Akari の内部仕様は非公開で、変わることがあります。
