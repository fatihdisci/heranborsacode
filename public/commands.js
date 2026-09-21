const $ = selector => document.querySelector(selector);

export function createCommandCenter(telegram, onShowFeed) {
  const state = { bots: [], symbols: [], bot: null, selected: new Set(), steps: [], templates: [], jobs: [], visible: false, resultJob: null, results: [] };
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
    const created = await api('/api/commands/jobs', { method: 'POST', body: JSON.stringify(value) });
    message('İş kuyruğa alındı. Mac mini bağlandığında otomatik çalışacak.'); telegram?.HapticFeedback?.notificationOccurred('success'); await loadJobs();
    await openResults(created.id);
  }

  function resultText(result) {
    const heading = `@${result.bot_username} · ${result.command}`;
    const content = String(result.response_text || '').trim();
    return content ? `${heading}\n${content}` : heading;
  }

  function renderResults() {
    const root = $('#command-result-list'); root.replaceChildren();
    const job = state.resultJob; const results = state.results;
    $('#command-results-title').textContent = job?.name || 'Komut sonucu';
    const labels = { queued: 'Kuyrukta bekliyor', leased: 'Mac mini çalışıyor', completed: 'Tamamlandı', failed: 'Tamamlanamadı', cancelled: 'İptal edildi' };
    $('#command-results-state').textContent = labels[job?.status] || 'Sonuçlar yükleniyor…';
    $('#command-results-count').textContent = results.length ? `${results.length} yanıt` : '';
    $('#copy-command-texts').disabled = !results.some(result => String(result.response_text || '').trim());
    $('#download-command-pdf').disabled = !results.some(result => result.response_kind === 'image' && result.media_url);
    if (!results.length) {
      const empty = document.createElement('p'); empty.className = 'command-results-empty';
      empty.textContent = job?.status === 'failed' ? (job.error || 'Komut tamamlanamadı.') : 'Yanıt bekleniyor. Bu ekran otomatik güncellenecek.';
      root.append(empty); return;
    }
    results.forEach((result, index) => {
      const card = document.createElement('article'); card.className = 'command-result-card';
      const meta = document.createElement('div'); meta.className = 'command-result-meta';
      const bot = document.createElement('strong'); bot.textContent = `@${result.bot_username}`;
      const command = document.createElement('code'); command.textContent = result.command; meta.append(bot, command); card.append(meta);
      if (result.media_url && result.response_kind === 'image') {
        const link = document.createElement('a'); link.href = result.media_url; link.target = '_blank'; link.rel = 'noopener noreferrer';
        const image = document.createElement('img'); image.src = result.media_url; image.alt = `${result.command} sonucu ${index + 1}`; image.loading = 'lazy'; link.append(image); card.append(link);
      } else if (result.media_url) {
        const link = document.createElement('a'); link.className = 'command-file'; link.href = result.media_url; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = `${result.file_name || 'Dosya'} indir ↗`; card.append(link);
      }
      if (String(result.response_text || '').trim()) {
        const text = document.createElement('pre'); text.textContent = result.response_text; card.append(text);
      }
      root.append(card);
    });
  }

  async function loadResults(jobId) {
    const data = await api(`/api/commands/jobs/${jobId}`);
    if (state.resultJob?.id && state.resultJob.id !== jobId) return;
    state.resultJob = data.job; state.results = data.results || []; renderResults();
  }

  async function openResults(jobId) {
    state.resultJob = { id: jobId, name: 'Komut sonucu', status: 'queued' }; state.results = []; renderResults();
    const dialog = $('#command-results-dialog'); if (!dialog.open) dialog.showModal();
    await loadResults(jobId).catch(error => { $('#command-results-message').textContent = error.message; });
  }

  async function copyAllTexts() {
    const text = state.results.filter(result => String(result.response_text || '').trim()).map(resultText).join('\n\n');
    if (!text) return;
    await navigator.clipboard.writeText(text); telegram?.HapticFeedback?.notificationOccurred('success');
    $('#command-results-message').textContent = 'Tüm metinler panoya kopyalandı.';
  }

  function safeFileName(value) {
    return String(value || 'komut-sonuclari').toLocaleLowerCase('tr-TR').replace(/[^a-z0-9çğıöşü]+/gi, '-').replace(/^-|-$/g, '').slice(0, 70) || 'komut-sonuclari';
  }

  async function downloadImagesPdf() {
    const button = $('#download-command-pdf'); const original = button.textContent; button.disabled = true; button.textContent = 'PDF hazırlanıyor…';
    $('#command-results-message').textContent = '';
    try {
      const images = state.results.filter(result => result.response_kind === 'image' && result.media_url);
      const { PDFDocument } = await import('/vendor/pdf-lib.esm.min.js');
      const pdf = await PDFDocument.create(); let added = 0;
      for (const result of images) {
        const response = await fetch(result.media_url); if (!response.ok) continue;
        const bytes = await response.arrayBuffer(); const type = response.headers.get('content-type') || '';
        let embedded;
        try { embedded = type.includes('png') ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes); } catch { continue; }
        const pageWidth = 595.28, pageHeight = 841.89, margin = 24;
        const scale = Math.min((pageWidth - margin * 2) / embedded.width, (pageHeight - margin * 2) / embedded.height, 1);
        const width = embedded.width * scale, height = embedded.height * scale; const page = pdf.addPage([pageWidth, pageHeight]);
        page.drawImage(embedded, { x: (pageWidth - width) / 2, y: (pageHeight - height) / 2, width, height }); added++;
      }
      if (!added) throw new Error('PDF’e eklenebilecek görsel bulunamadı.');
      const bytes = await pdf.save(); const blob = new Blob([bytes], { type: 'application/pdf' }); const url = URL.createObjectURL(blob);
      const link = document.createElement('a'); link.href = url; link.download = `${safeFileName(state.resultJob?.name)}.pdf`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      telegram?.HapticFeedback?.notificationOccurred('success'); $('#command-results-message').textContent = `${added} görsel tek PDF olarak hazırlandı.`;
    } catch (error) { $('#command-results-message').textContent = error.message || 'PDF hazırlanamadı.'; }
    finally { button.textContent = original; button.disabled = !state.results.some(result => result.response_kind === 'image' && result.media_url); }
  }

  function jobCard(job) {
    const labels = { queued: 'Bekliyor', leased: 'Çalışıyor', completed: 'Tamamlandı', failed: 'Hata', cancelled: 'İptal' };
    const card = document.createElement('article'); card.dataset.status = job.status;
    const copy = document.createElement('div'); const title = document.createElement('strong'); const detail = document.createElement('small');
    title.textContent = job.name; detail.textContent = `${job.steps.length} komut · ${new Intl.DateTimeFormat('tr-TR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(job.created_at + (job.created_at.endsWith('Z') ? '' : 'Z')))}`; copy.append(title, detail);
    const side = document.createElement('div'); side.className = 'job-side';
    const status = document.createElement('span'); status.textContent = labels[job.status] || job.status;
    const open = document.createElement('button'); open.type = 'button'; open.textContent = 'Sonuçları aç'; open.onclick = () => openResults(job.id);
    side.append(status, open); card.append(copy, side); return card;
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
  $('#command-results-close').onclick = () => $('#command-results-dialog').close();
  $('#copy-command-texts').onclick = () => copyAllTexts().catch(() => { $('#command-results-message').textContent = 'Metinler kopyalanamadı.'; });
  $('#download-command-pdf').onclick = downloadImagesPdf;
  $('#command-results-dialog').addEventListener('close', () => { state.resultJob = null; state.results = []; });
  window.setInterval(() => {
    if (!state.visible || document.hidden) return;
    loadJobs().catch(() => {});
    if (state.resultJob?.id && ['queued', 'leased'].includes(state.resultJob.status)) loadResults(state.resultJob.id).catch(() => {});
  }, 4000);

  return {
    async show() { state.visible = true; $('#command-center').hidden = false; await initialize(); await loadJobs().catch(() => {}); },
    hide() { state.visible = false; $('#command-center').hidden = true; },
    onShowFeed,
  };
}
