import { connectTelegramBack, restoreFeedPosition } from './navigation.js';
import { createCommandCenter } from './commands.js';
const telegram = window.Telegram?.WebApp;
const telegramHeaders = () => ({ 'x-telegram-init-data': telegram?.initData || '' });
const accessScreen = document.querySelector('#access-screen');
if (telegram?.initData) {
  document.title = 'Heran Borsa';
  document.body.classList.remove('auth-pending');
  accessScreen?.remove();
} else {
  document.body.classList.add('auth-denied');
}
const state = { type: "", ticker: "", q: "", source: "", cursor: null, loading: false, seen: new Set(), searchOpen: false, view: 'feed' };

const $ = selector => document.querySelector(selector);
const feed = $("#feed");
const status = $("#status");
const statusText = status.querySelector("span");
const more = $("#more");
const template = $("#item-template");
const searchPanel = $("#search-panel");
const searchButton = $("#search-button");
const commandButton = $('#commands-button');
const streamHead = $('.stream-head');
const tweetDialog = $("#tweet-dialog");
const tweetDraft = $("#tweet-draft");
const tweetProgress = $("#tweet-progress");
const tweetMessage = $("#tweet-message");
const copyTweetButton = $("#copy-tweet");
const readerDialog = $('#reader-dialog');
const commandResultsDialog = $('#command-results-dialog');
const navigation = connectTelegramBack(telegram, [readerDialog, commandResultsDialog, tweetDialog]);
const commandCenter = createCommandCenter(telegram);
let readerAbort;
let readerItem;
let readerScrollY = 0;

function showReaderBlocks(blocks) {
  const body = $('#reader-body'); body.replaceChildren();
  for (const block of blocks) {
    if (block.type === 'table') {
      const wrapper = document.createElement('div'); wrapper.className = 'reader-table';
      wrapper.tabIndex = 0; wrapper.setAttribute('role', 'region'); wrapper.setAttribute('aria-label', 'Bildirim tablosu; yatay kaydırılabilir');
      const table = document.createElement('table');
      for (const row of block.rows) {
        const tr = document.createElement('tr');
        for (const data of row) {
          const cell = document.createElement(data.header ? 'th' : 'td'); cell.textContent = data.text;
          cell.rowSpan = data.rowSpan; cell.colSpan = data.colSpan; tr.append(cell);
        }
        table.append(tr);
      }
      wrapper.append(table); body.append(wrapper);
    } else {
      const p = document.createElement(block.type === 'heading' ? 'h3' : 'p'); p.textContent = block.text; body.append(p);
    }
  }
}

async function loadReader(item) {
  readerAbort?.abort(); const controller = new AbortController(); readerAbort = controller;
  const notice = $('#reader-notice'), progress = $('#reader-status'), retry = $('#reader-retry');
  progress.hidden = false; progress.textContent = 'Kaynak metni yükleniyor…';
  notice.hidden = retry.hidden = true; $('#reader-attachments').hidden = true;
  showReaderBlocks(item.body ? [{type:'paragraph', text:item.body}] : []);
  try {
    let data;
    for (let attempt = 0; attempt < 16; attempt++) {
      const response = await fetch(`/api/content?id=${item.id}`, {signal:controller.signal, headers:telegramHeaders()});
      if (response.status === 202) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        if (controller.signal.aborted) return;
        continue;
      }
      if (!response.ok) throw new Error('unavailable');
      data = await response.json(); break;
    }
    if (!data) throw new Error('timeout');
    if (controller.signal.aborted) return;
    showReaderBlocks(data.blocks);
    progress.textContent = data.status === 'summary' ? 'Yalnızca özet' : 'Kaynak metni';
    notice.textContent = data.notice || ''; notice.hidden = !data.notice;
    const files = $('#reader-files'); files.replaceChildren();
    for (const file of data.attachments || []) {
      const link = document.createElement('a'); link.textContent = `${file.filename} ↗`; link.href = file.url;
      link.target = '_blank'; link.rel = 'noopener noreferrer'; files.append(link);
    }
    $('#reader-attachments').hidden = !files.childElementCount;
  } catch {
    if (controller.signal.aborted) return;
    progress.textContent = 'İçerik yüklenemedi';
    notice.textContent = 'Varsa kayıtlı özet gösteriliyor. Yeniden deneyebilir veya kaynağı açabilirsin.';
    notice.hidden = retry.hidden = false;
  }
}

function openReader(item) {
  readerItem = item;
  $('#reader-title').textContent = item.title;
  $('#reader-kind').textContent = item.type === 'kap' ? 'KAP bildirimi' : 'Haber';
  $('#reader-meta').textContent = `${item.source} · ${formatTime(item.published_at || item.created_at)}`;
  $('#reader-symbols').textContent = JSON.parse(item.tickers_json || '[]').map(s => `#${s}`).join(' ');
  $('#reader-source').href = item.url;
  readerScrollY = window.scrollY;
  document.body.style.top = `-${readerScrollY}px`;
  document.body.classList.add('reading');
  readerDialog.showModal();
  navigation.sync();
  $('.reader-scroll').scrollTop = 0;
  loadReader(item);
}
$('#reader-close').onclick = () => readerDialog.close();
$('#reader-retry').onclick = () => readerItem && loadReader(readerItem);
readerDialog.addEventListener('close', () => {
  readerAbort?.abort(); readerItem = null;
  restoreFeedPosition(window, document, readerScrollY);
});

const labels = { "": "Tüm gelişmeler", kap: "KAP bildirimleri", spk: "SPK bültenleri", news: "Piyasa haberleri" };
const badges = { kap: "KAP", spk: "SPK", news: "Haber" };
const icons = { kap: "K", spk: "S", news: "●" };

function setStatus(message, stateName = "ready") {
  statusText.textContent = message;
  status.dataset.state = stateName;
}

function formatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(+date)) return "—";
  const sameDay = date.toDateString() === new Date().toDateString();
  const options = sameDay ? { hour: "2-digit", minute: "2-digit" } : { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" };
  return new Intl.DateTimeFormat("tr-TR", options).format(date);
}

function updateClock() {
  $("#clock").textContent = new Intl.DateTimeFormat("tr-TR", { hour: "2-digit", minute: "2-digit" }).format(new Date());
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    telegram?.HapticFeedback?.notificationOccurred("success");
    setStatus("Panoya kopyalandı");
    return true;
  } catch {
    setStatus("Panoya kopyalama desteklenmiyor", "error");
    return false;
  }
}

function openTweetDialog() {
  tweetProgress.hidden = false;
  tweetMessage.hidden = true;
  tweetDraft.hidden = true;
  copyTweetButton.disabled = true;
  if (typeof tweetDialog.showModal === "function" && !tweetDialog.open) tweetDialog.showModal();
  else tweetDialog.setAttribute("open", "");
  navigation.sync();
}

function showTweetError(message) {
  tweetProgress.hidden = true;
  tweetDraft.hidden = true;
  tweetMessage.textContent = message;
  tweetMessage.hidden = false;
  copyTweetButton.disabled = true;
}

async function createTweet(item, button) {
  button.disabled = true;
  button.innerHTML = "<span>✦</span> Hazırlanıyor";
  setStatus("Tweet hazırlanıyor");
  openTweetDialog();
  try {
    const response = await fetch("/api/tweet-draft", {
      method: "POST",
      headers: { "content-type": "application/json", "x-telegram-init-data": telegram?.initData || "" },
      body: JSON.stringify({ feedItemId: item.id }),
    });
    let data = {};
    try { data = await response.json(); } catch { /* non-JSON gateway response */ }
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    tweetProgress.hidden = true;
    tweetMessage.hidden = true;
    tweetDraft.value = data.tweet || "";
    tweetDraft.hidden = false;
    copyTweetButton.disabled = !tweetDraft.value;
    setStatus(data.cached ? "Hazır taslak açıldı" : "Tweet taslağı hazır");
    telegram?.HapticFeedback?.notificationOccurred("success");
  } catch (error) {
    const code = error instanceof Error ? error.message : "tweet_generation_failed";
    const message = code === "unauthorized"
      ? "Telegram oturumu doğrulanamadı. Mini App’i kapatıp bot sohbetinden yeniden açın."
      : code === "openai_not_configured"
        ? "OpenAI bağlantısı yapılandırılmamış."
        : "Tweet şu anda oluşturulamadı. Kaynağa erişilememiş olabilir; biraz sonra tekrar deneyin.";
    showTweetError(message);
    setStatus("Tweet oluşturulamadı", "error");
    telegram?.HapticFeedback?.notificationOccurred("error");
  } finally {
    button.disabled = false;
    button.innerHTML = "<span>✦</span> Tweet oluştur";
  }
}

function render(item) {
  const node = template.content.cloneNode(true);
  const article = node.querySelector(".feed-item");
  const open = node.querySelector(".item-open");
  const icon = node.querySelector(".source-icon");
  const badge = node.querySelector(".badge");
  const time = node.querySelector("time");
  const title = node.querySelector(".item-title");
  const summary = node.querySelector(".item-summary");
  const tickers = node.querySelector(".tickers");
  const tweet = node.querySelector(".tweet");
  const symbols = JSON.parse(item.tickers_json || "[]");

  article.dataset.type = item.type;
  open.href = item.url;
  icon.textContent = icons[item.type] || "●";
  icon.classList.add(item.type);
  badge.textContent = `${badges[item.type] || item.type} · ${item.source}`;
  badge.classList.add(item.type);
  time.textContent = formatTime(item.published_at || item.created_at);
  title.textContent = item.title;
  summary.textContent = item.body || "";
  tickers.textContent = symbols.map(symbol => `#${symbol}`).join("  ");

  const isBreaker = item.type === "kap" && /devre kesici/i.test(item.title) && item.body;
  if (item.type === 'news' || (item.type === 'kap' && !isBreaker)) {
    open.removeAttribute('target');
    open.setAttribute('aria-haspopup', 'dialog');
    open.onclick = event => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault(); openReader(item);
    };
  }
  if (isBreaker) {
    const text = `${symbols.map(symbol => `#${symbol}`).join(" ")}\n\nDevre kesici uygulandı. Sürekli işleme ara verildi.`;
    tweet.innerHTML = "<span>✓</span> Tweeti kopyala";
    tweet.onclick = () => copy(text);
  } else {
    tweet.onclick = () => createTweet(item, tweet);
  }
  return node;
}

async function load(append = false) {
  if (state.loading) return;
  state.loading = true;
  setStatus(append ? "Eski kayıtlar yükleniyor" : "Akış güncelleniyor");
  const params = new URLSearchParams({ limit: "30" });
  for (const [key, value] of Object.entries({ type: state.type, ticker: state.ticker, q: state.q, source: state.source })) if (value) params.set(key, value);
  if (append && state.cursor) params.set("cursor", state.cursor);
  try {
    const response = await fetch(`/api/feed?${params}`, {headers:telegramHeaders()});
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (!append) { feed.replaceChildren(); state.seen.clear(); }
    const fresh = data.items.filter(item => !state.seen.has(item.id));
    fresh.forEach(item => { state.seen.add(item.id); feed.append(render(item)); });
    state.cursor = data.nextCursor;
    more.hidden = !state.cursor || fresh.length === 0;
    setStatus(state.seen.size ? `${state.seen.size} kayıt` : "Bu filtrede kayıt yok");
  } catch {
    setStatus("Akış yüklenemedi", "error");
  } finally {
    state.loading = false;
  }
}

function setType(type) {
  state.view = 'feed';
  commandCenter.hide();
  streamHead.hidden = feed.hidden = false;
  state.type = type;
  state.cursor = null;
  state.searchOpen = false;
  searchPanel.hidden = true;
  searchButton.setAttribute("aria-expanded", "false");
  $("#section-title").textContent = labels[type] || labels[""];
  document.querySelectorAll(".bottom-nav [data-type]").forEach(button => button.classList.toggle("nav-active", button.dataset.type === type));
  commandButton.classList.remove('nav-active');
  load();
}

async function showCommands() {
  state.view = 'commands';
  state.searchOpen = false; searchPanel.hidden = true; searchButton.setAttribute('aria-expanded', 'false');
  streamHead.hidden = feed.hidden = more.hidden = true;
  document.querySelectorAll('.bottom-nav button').forEach(button => button.classList.remove('nav-active'));
  commandButton.classList.add('nav-active');
  await commandCenter.show();
}

function toggleSearch(force) {
  state.searchOpen = typeof force === "boolean" ? force : !state.searchOpen;
  searchPanel.hidden = !state.searchOpen;
  searchButton.setAttribute("aria-expanded", String(state.searchOpen));
  searchButton.classList.toggle("nav-active", state.searchOpen);
  if (state.searchOpen) setTimeout(() => $("#query").focus(), 80);
}

let searchTimer;
function scheduleSearch() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.ticker = $("#ticker").value.trim().toUpperCase();
    state.q = $("#query").value.trim();
    state.cursor = null;
    load();
  }, 320);
}

async function loadSources() {
  try {
    const response = await fetch("/api/sources", {headers:telegramHeaders()});
    const data = await response.json();
    const select = $("#source");
    data.sources.forEach(source => {
      const option = document.createElement("option");
      option.value = option.textContent = source;
      select.append(option);
    });
  } catch { /* source filter is optional */ }
}

document.querySelectorAll("[data-type]").forEach(button => { button.onclick = () => setType(button.dataset.type); });
searchButton.onclick = () => toggleSearch();
commandButton.onclick = showCommands;
$("#query").oninput = scheduleSearch;
$("#ticker").oninput = scheduleSearch;
$("#source").onchange = event => { state.source = event.target.value; state.cursor = null; load(); };
$("#clear-filters").onclick = () => {
  $("#query").value = "";
  $("#ticker").value = "";
  $("#source").value = "";
  state.q = state.ticker = state.source = "";
  state.cursor = null;
  load();
};
copyTweetButton.onclick = async () => {
  if (await copy(tweetDraft.value)) {
    copyTweetButton.textContent = "Kopyalandı";
    setTimeout(() => { copyTweetButton.textContent = "Tweeti kopyala"; }, 1400);
  }
};
more.onclick = () => load(true);

telegram?.ready();
telegram?.expand();
telegram?.setHeaderColor?.("#080b10");
telegram?.setBackgroundColor?.("#080b10");
updateClock();
setInterval(updateClock, 1000);
loadSources();
load();
setInterval(() => { if (state.view === 'feed' && !state.loading && !readerDialog.open && !tweetDialog.open && window.scrollY < 240) load(); }, 60_000);
