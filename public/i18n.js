// UI strings in English and Japanese. The viewer's choice is kept in localStorage;
// otherwise flow.json's `lang` (from the config) decides.
const STRINGS = {
  en: {
    flow: 'Flow',
    legend: 'Legend',
    legendIntro: 'A mark is "where", a line is "data flowing". Only the loop you pick gets colour.',
    kind_web: 'External service',
    kind_script: 'Script',
    kind_file: 'Note or data file',
    kind_repo: 'Repository',
    kind_section: 'Hub item (section, content)',
    step_ai: 'AI step',
    step_human: 'Your step',
    step_other: 'Step by someone else (visitor, CI)',
    group: 'Things with the same role',
    edge_trace: 'Recorded by running the script',
    edge_declared: 'Declared by hand (human and AI steps)',
    edge_guess: 'Guessed from code (section hubs)',
    origin: 'Origin (nothing flows into it)',
    list_loops: 'Loops',
    list_sections: 'Sections',
    list_items: 'Items',
    unnamed: 'Unnamed loop',
    missing: 'Declared but not found: {list} (a step changed and the loop broke?)',
    hideList: 'Hide the list',
    showList: 'Show the list',
    resetZoom: 'Reset the view',
    generated: 'built {time}',
    stepOf: '{actor} step',
    originSuffix: ', origin',
    d_location: 'Location',
    d_files: 'Files read or written',
    d_frame: 'Frame',
    d_folded: 'Folded reads',
    d_urls: 'Fetched from (examples)',
    d_more: '{n} more',
    d_count: '{n} files',
    d_evidence: 'Evidence',
    d_loops: 'Loops through here',
    how_trace: 'recorded',
    how_declared: 'declared',
    how_guess: 'guessed',
    how_unknown: 'unknown',
    dir_write: 'writes',
    dir_read: 'reads',
    ev_hub: '{flow} / {node} {dir} ({how})',
    ev_side: '{dir} {target} ({how})',
    edgeTitle: '{from} → {to} ({how}{extra})',
    extra_call: ', call',
    extra_back: ', feedback',
    lang: '日本語',
    theme_auto: 'Auto',
    theme_light: 'Light',
    theme_dark: 'Dark',
    themeTitle: 'Theme: {name} (click to change)',
  },
  ja: {
    flow: '流れ',
    legend: '凡例',
    legendIntro: '点は「どこ」、線は「データの流れ」。色が付くのは選んだ輪だけ。',
    kind_web: '外のサービス',
    kind_script: 'スクリプト',
    kind_file: 'ノート・データ',
    kind_repo: 'リポジトリ',
    kind_section: '中心に置いたもの（節・コンテンツ）',
    step_ai: 'AI の段',
    step_human: '人の段',
    step_other: 'その他の担い手の段（訪問者・CI）',
    group: '同じ役割のもの',
    edge_trace: '動かして記録した流れ',
    edge_declared: '手で宣言した流れ（人・AI の作業）',
    edge_guess: 'コードから推定した流れ（節の中心図）',
    origin: '起点（どこからも流れ込まない）',
    list_loops: '輪',
    list_sections: '節',
    list_items: '中身',
    unnamed: '名前のない輪',
    missing: '宣言したのに見つからない輪: {list}（手順を変えて輪が切れた合図）',
    hideList: '一覧を隠す',
    showList: '一覧を出す',
    resetZoom: '表示を元に戻す',
    generated: '{time} 時点',
    stepOf: '{actor} の段',
    originSuffix: '・起点',
    d_location: '場所',
    d_files: '読み書きしたファイル',
    d_frame: '枠',
    d_folded: '畳んだ読み',
    d_urls: '取得先の例',
    d_more: 'ほか {n} 件',
    d_count: '{n} 件',
    d_evidence: '根拠',
    d_loops: '通っている輪',
    how_trace: '記録',
    how_declared: '宣言',
    how_guess: '推定',
    how_unknown: '不明',
    dir_write: '書く',
    dir_read: '読む',
    ev_hub: '{flow} / {node} が{dir}（{how}）',
    ev_side: '{target} を{dir}（{how}）',
    edgeTitle: '{from} → {to}（{how}{extra}）',
    extra_call: '・呼び出し',
    extra_back: '・戻り',
    lang: 'English',
    theme_auto: '自動',
    theme_light: 'ライト',
    theme_dark: 'ダーク',
    themeTitle: '配色: {name}（押すと切り替え）',
  },
};

const LANG_KEY = 'loopfinder:lang';
let LANG = 'en';

function pickLang(fallback) {
  let saved = null;
  try { saved = localStorage.getItem(LANG_KEY); } catch { /* storage unavailable */ }
  LANG = STRINGS[saved] ? saved : STRINGS[fallback] ? fallback : 'en';
  document.documentElement.lang = LANG;
  return LANG;
}

function setLang(lang) {
  LANG = STRINGS[lang] ? lang : 'en';
  try { localStorage.setItem(LANG_KEY, LANG); } catch { /* storage unavailable */ }
  document.documentElement.lang = LANG;
}

function t(key, vars = {}) {
  const s = STRINGS[LANG][key] ?? STRINGS.en[key] ?? key;
  return s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
}

// Fills every element that has data-i18n (text) or data-i18n-title (title and aria-label).
function applyStaticText() {
  document.querySelectorAll('[data-i18n]').forEach(e => { e.textContent = t(e.dataset.i18n); });
  document.querySelectorAll('[data-i18n-label]').forEach(e => {
    const s = t(e.dataset.i18nLabel);
    e.title = s;
    e.setAttribute('aria-label', s);
  });
}
