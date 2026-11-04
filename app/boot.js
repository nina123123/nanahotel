// Starts the in-page server, then brings in the chat page from public/ (its markup is not duplicated here).
// ?view=merchant opens the hotel's console (public/merchant.html) instead, on the same in-page server and data.
import './globals.js';

const ROOT = new URL('../', import.meta.url);

function fail(message) {
  const text = document.getElementById('boot-text');
  if (text) text.textContent = message;
}

async function start() {
  // Dynamic, so the globals above exist before any server module is evaluated.
  const { startLocalServer } = await import('./local-server.js');
  await startLocalServer();

  const merchant = new URLSearchParams(location.search).get('view') === 'merchant';
  const html = await (await fetch(new URL(merchant ? 'public/merchant.html' : 'public/index.html', ROOT))).text();
  const page = new DOMParser().parseFromString(html, 'text/html');
  // public/index.html uses paths relative to the site root (public/…); here that root is one level up.
  for (const el of page.body.querySelectorAll('[src], [href]')) {
    for (const attr of ['src', 'href']) {
      const value = el.getAttribute(attr);
      if (value && !/^(?:[a-z]+:|#|\/)/i.test(value)) el.setAttribute(attr, new URL(value, ROOT).href);
    }
  }
  for (const s of page.body.querySelectorAll('script')) s.remove();
  document.body.replaceChildren(...[...page.body.childNodes].map((n) => document.importNode(n, true)));
  document.body.className = page.body.className;
  if (merchant) {
    // The console has its own stylesheet and colours.
    for (const link of page.head.querySelectorAll('link[rel="stylesheet"]')) {
      document.head.append(Object.assign(document.createElement('link'), { rel: 'stylesheet', href: new URL(link.getAttribute('href'), ROOT).href }));
    }
    for (const old of document.head.querySelectorAll('link[rel="stylesheet"][href$="style.css"]')) old.remove();
    document.title = page.title;
    document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', 'dark');
    await import('../public/merchant.js');
  } else {
    await import('../public/app.js');
  }
}

start().catch((err) => {
  console.error('[nanahotel] Could not start', err);
  fail("NanaHotel couldn't start. This browser may be too old: update your iPhone to iOS 16.4 or later, or update Android System WebView, then try again.");
});
