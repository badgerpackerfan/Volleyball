// Installable offline app shell. sw.js sits beside the HTML entry points, so
// relative registration also works when the app is hosted below a domain root.
export function registerApp() {
  if ('serviceWorker' in navigator && window.isSecureContext)
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  // Ask the browser not to evict saved matches. Only in the installed app, where no prompt appears.
  const installed = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  if (installed) navigator.storage?.persist?.().catch(() => {});
}

// Keep the screen on while a set is being scored; the browser drops the lock
// when the page is hidden, so it is requested again on return.
let lock = null;
export async function keepAwake(wanted) {
  if (!('wakeLock' in navigator)) return;
  if (!wanted || document.visibilityState !== 'visible') { await lock?.release().catch(() => {}); lock = null; return; }
  if (lock) return;
  try { lock = await navigator.wakeLock.request('screen'); lock.addEventListener('release', () => { lock = null; }); }
  catch { lock = null; }
}
