const telegram = window.Telegram?.WebApp;
const state = { type: "", ticker: "", q: "", source: "", cursor: null, loading: false, seen: new Set(), searchOpen: false };

const $ = selector => document.querySelector(selector);
const feed = $("#feed");
const status = $("#status");
const statusText = status.querySelector("span");
const more = $("#more");
const template = $("#item-template");
const searchPanel = $("#search-panel");
const searchButton = $("#search-button");
const tweetDialog = $("#tweet-dialog");
const tweetDraft = $("#tweet-draft");
const tweetProgress = $("#tweet-progress");
const tweetMessage = $("#tweet-message");
const copyTweetButton = $("#copy-tweet");

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
  if (isBreaker) {
    const text = `${symbols.map(symbol => `#${symbol}`).join(" ")}\n\n${item.body}\n\n🔗 KAP:\n${item.url}`;
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
    const response = await fetch(`/api/feed?${params}`);
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
  state.type = type;
  state.cursor = null;
  state.searchOpen = false;
  searchPanel.hidden = true;
  searchButton.setAttribute("aria-expanded", "false");
  $("#section-title").textContent = labels[type] || labels[""];
  document.querySelectorAll(".bottom-nav [data-type]").forEach(button => button.classList.toggle("nav-active", button.dataset.type === type));
  searchButton.classList.remove("nav-active");
  load();
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
    const response = await fetch("/api/sources");
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
setInterval(() => { if (!state.loading && window.scrollY < 240) load(); }, 60_000);
