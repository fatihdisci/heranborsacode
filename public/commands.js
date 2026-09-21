const $ = selector => document.querySelector(selector);

export function createCommandCenter(telegram, onShowFeed) {
  const state = { bots: [], symbols: [], bot: null, selected: new Set(), steps: [], templates: [], jobs: [], visible: false };
  const authHeaders = (json = false) => ({ ...(json ? { 'content-type': 'application/json' } : {}), 'x-telegram-init-data': telegram?.initData || '' });
  const message = (text, error = false) => { const node = $('#command-message'); node.textContent = text; node.classList.toggle('error', error); };

  async function api(path, options = {}) {
    const response = await fetch(path, { ...options, headers: { ...authHeaders(Boolean(options.body)), ...(options.headers || {}) } });
    let value = {}; try { value = await response.json(); } catch { /* handled below */ }
    if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
    return value;
  }

  function renderBots() {
    const root = $('#command-bots'); root.replaceChildren();
    state.bots.forEach(bot => {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = bot.label;
      button.className = bot.username === state.bot?.username ? 'selected' : '';
      button.onclick = () => { state.bot = bot; state.selected.clear(); renderBots(); renderActions(); renderSelected(); };
      root.append(button);
    });
  }

  function renderActions() {
    const select = $('#command-action'); select.replaceChildren();
    for (const command of state.bot?.commands || []) {
      const option = document.createElement('option'); option.value = command.id; option.textContent = command.label; select.append(option);
    }
    const custom = document.createElement('option'); custom.value = '__custom'; custom.textContent = 'Özel komut'; select.append(custom);
    if (!state.bot?.commands?.length) select.value = '__custom';
    $('#custom-command-row').hidden = select.value !== '__custom';
  }

  function renderSelected() {
    const root = $('#selected-symbols'); root.replaceChildren();
    for (const symbol of state.selected) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = `${symbol} ×`;
      button.onclick = () => { state.selected.delete(symbol); renderSelected(); };
      root.append(button);
    }
  }

  function showSuggestions(query) {
    const root = $('#symbol-suggestions'); root.replaceChildren();
    const normalized = query.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!normalized) { root.hidden = true; return; }
    const matches = state.symbols.filter(symbol => symbol.includes(normalized) && !state.selected.has(symbol)).slice(0, 24);
    for (const symbol of matches) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = symbol;
      button.onclick = () => { if (state.selected.size < 40) state.selected.add(symbol); $('#symbol-search').value = ''; root.hidden = true; renderSelected(); };
      root.append(button);
    }
    root.hidden = !matches.length;
  }

  function renderSteps() {
    const root = $('#command-steps'); root.replaceChildren();
    if (!state.steps.length) { const empty = document.createElement('li'); empty.className = 'empty-step'; empty.textContent = 'Henüz komut eklenmedi.'; root.append(empty); return; }
    state.steps.forEach((step, index) => {
      const row = document.createElement('li');
      const copy = document.createElement('div'); const bot = document.createElement('small'); const command = document.createElement('code');
      bot.textContent = `@${step.botUsername}`; command.textContent = step.command; copy.append(bot, command);
      const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '×'; remove.setAttribute('aria-label', 'Komutu kaldır');
      remove.onclick = () => { state.steps.splice(index, 1); renderSteps(); };
      row.append(copy, remove); root.append(row);
    });
  }

  function selectedDefinition() { return state.bot?.commands.find(item => item.id === $('#command-action').value); }

  function addCommands() {
    const definition = selectedDefinition();
    const pattern = definition?.pattern || $('#custom-command').value.trim();
    if (!pattern.startsWith('/')) return message('Komut / işaretiyle başlamalı.', true);
    const needsSymbol = definition?.needsSymbol || pattern.includes('{HISSE}');
    if (needsSymbol && !state.selected.size) return message('En az bir hisse seç.', true);
    const symbols = needsSymbol ? [...state.selected] : [null];
    const additions = symbols.map(symbol => ({ botUsername: state.bot.username, command: symbol ? pattern.replaceAll('{HISSE}', symbol) : pattern, delaySeconds: 4 }));
    if (state.steps.length + additions.length > 80) return message('Bir akışta en fazla 80 komut olabilir.', true);
    state.steps.push(...additions); state.selected.clear(); renderSelected(); renderSteps(); message(`${additions.length} komut akışa eklendi.`);
  }

  function templateCard(template) {
    const card = document.createElement('article');
    const copy = document.createElement('div'); const title = document.createElement('strong'); const detail = document.createElement('small');
    title.textContent = template.name; detail.textContent = `${template.steps.length} komut`; copy.append(title, detail);
    const actions = document.createElement('div');
    const run = document.createElement('button'); run.type = 'button'; run.textContent = 'Çalıştır'; run.onclick = () => runJob({ templateId: template.id });
    const edit = document.createElement('button'); edit.type = 'button'; edit.textContent = 'Düzenle'; edit.onclick = () => { state.steps = structuredClone(template.steps); $('#flow-name').value = template.name; renderSteps(); window.scrollTo({ top: 0, behavior: 'smooth' }); };
    const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'Sil'; remove.onclick = async () => { await api(`/api/commands/templates/${template.id}`, { method: 'DELETE' }); await loadTemplates(); };
    actions.append(run, edit, remove); card.append(copy, actions); return card;
  }

  async function loadTemplates() {
    const data = await api('/api/commands/templates'); state.templates = data.templates || [];
    const root = $('#template-list'); root.replaceChildren();
    if (!state.templates.length) { root.textContent = 'Henüz şablon yok.'; return; }
    state.templates.forEach(template => root.append(templateCard(template)));
  }

  async function saveTemplate() {
    const name = $('#flow-name').value.trim();
    if (name.length < 2 || !state.steps.length) return message('Akış adı ve en az bir komut gerekli.', true);
    await api('/api/commands/templates', { method: 'POST', body: JSON.stringify({ name, steps: state.steps }) });
    message('Şablon kaydedildi.'); telegram?.HapticFeedback?.notificationOccurred('success'); await loadTemplates();
  }

  async function runJob(payload = null) {
    if (!payload && !state.steps.length) return message('Önce akışa komut ekle.', true);
    const value = payload || { name: $('#flow-name').value.trim() || 'Tek seferlik komut', steps: state.steps };
    await api('/api/commands/jobs', { method: 'POST', body: JSON.stringify(value) });
    message('İş kuyruğa alındı. Mac mini bağlandığında otomatik çalışacak.'); telegram?.HapticFeedback?.notificationOccurred('success'); await loadJobs();
  }

  function jobCard(job) {
    const labels = { queued: 'Bekliyor', leased: 'Çalışıyor', completed: 'Tamamlandı', failed: 'Hata', cancelled: 'İptal' };
    const card = document.createElement('article'); card.dataset.status = job.status;
    const copy = document.createElement('div'); const title = document.createElement('strong'); const detail = document.createElement('small');
    title.textContent = job.name; detail.textContent = `${job.steps.length} komut · ${new Intl.DateTimeFormat('tr-TR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(job.created_at + (job.created_at.endsWith('Z') ? '' : 'Z')))}`; copy.append(title, detail);
    const status = document.createElement('span'); status.textContent = labels[job.status] || job.status; card.append(copy, status); return card;
  }

  async function loadJobs() {
    const data = await api('/api/commands/jobs'); state.jobs = data.jobs || [];
    const root = $('#job-list'); root.replaceChildren();
    if (!state.jobs.length) { root.textContent = 'Henüz çalıştırılmış iş yok.'; $('#agent-state').textContent = 'Kuyruk hazır'; return; }
    state.jobs.forEach(job => root.append(jobCard(job)));
    const active = state.jobs.find(job => ['queued', 'leased'].includes(job.status));
    $('#agent-state').textContent = active ? (active.status === 'leased' ? 'Mac mini çalışıyor' : 'Kuyrukta bekliyor') : 'Kuyruk hazır';
  }

  async function initialize() {
    if (state.bots.length) return;
    try {
      const [catalog, symbols] = await Promise.all([api('/api/commands/catalog'), api('/api/commands/symbols')]);
      state.bots = catalog.bots || []; state.symbols = symbols.symbols || []; state.bot = state.bots[0];
      renderBots(); renderActions(); renderSelected(); renderSteps(); await Promise.all([loadTemplates(), loadJobs()]);
    } catch (error) { message(error.message === 'unauthorized' ? 'Mini App’i bot sohbetinden yeniden aç.' : 'Komut Merkezi yüklenemedi.', true); }
  }

  $('#command-action').onchange = () => { $('#custom-command-row').hidden = $('#command-action').value !== '__custom'; };
  $('#symbol-search').oninput = event => showSuggestions(event.target.value);
  $('#add-command').onclick = addCommands;
  $('#clear-steps').onclick = () => { state.steps = []; renderSteps(); };
  $('#save-template').onclick = () => saveTemplate().catch(error => message(error.message, true));
  $('#run-commands').onclick = () => runJob().catch(error => message(error.message, true));
  $('#refresh-jobs').onclick = () => loadJobs().catch(error => message(error.message, true));

  return {
    async show() { state.visible = true; $('#command-center').hidden = false; await initialize(); await loadJobs().catch(() => {}); },
    hide() { state.visible = false; $('#command-center').hidden = true; },
    onShowFeed,
  };
}
