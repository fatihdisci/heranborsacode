// Telegram's header back button and the in-page controls share one modal stack.
// The page controls remain available in browsers and older Telegram clients.
export function connectTelegramBack(telegram, dialogs) {
  const supported = Boolean(telegram?.initData && telegram?.isVersionAtLeast?.('6.1') && telegram?.BackButton);
  const top = () => [...dialogs].reverse().find(dialog => dialog.open);
  function sync() {
    if (!supported) return;
    try { telegram.BackButton[top() ? 'show' : 'hide'](); } catch { /* retain in-page navigation */ }
  }
  function back() { top()?.close(); sync(); }
  if (supported) {
    try { telegram.BackButton.onClick(back); } catch { /* retain in-page navigation */ }
  }
  dialogs.forEach(dialog => {
    dialog.addEventListener('close', sync);
    dialog.addEventListener('toggle', sync);
  });
  sync();
  return { sync, back };
}

export function restoreFeedPosition(win, doc, scrollY) {
  doc.body.classList.remove('reading');
  doc.body.style.top = '';
  // Override the page's smooth scrolling; otherwise iOS visibly jumps from top.
  win.scrollTo({ top: scrollY, left: 0, behavior: 'instant' });
}
