// Line icons (24 × 24, stroke = currentColor). Static, trusted markup only — never server data.

const PATHS = {
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  check: '<path d="M5 12.5 9.5 17 19 7.5"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 7.9v.1"/>',
  alert: '<path d="M10.3 4.6 3 17.5A2 2 0 0 0 4.7 20.5h14.6a2 2 0 0 0 1.7-3L13.7 4.6a2 2 0 0 0-3.4 0Z"/><path d="M12 9.5v4.5M12 17v.1"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  chevron: '<path d="m9.5 6 6 6-6 6"/>',
  down: '<path d="m6 9.5 6 6 6-6"/>',
  phone: '<path d="M6.6 3.5h2.6l1.4 4-1.9 1.3a11.5 11.5 0 0 0 6.5 6.5l1.3-1.9 4 1.4v2.6a2 2 0 0 1-2.2 2A16.5 16.5 0 0 1 4.6 5.7a2 2 0 0 1 2-2.2Z"/>',
  hangup: '<path d="M3.4 14.6c4.7-4.3 12.5-4.3 17.2 0 .7.6.7 1.6.1 2.3l-1.4 1.5c-.5.5-1.3.6-1.9.2l-2.2-1.4c-.5-.3-.7-.9-.6-1.4l.3-1.6a10.6 10.6 0 0 0-6 0l.3 1.6c.1.5-.1 1.1-.6 1.4l-2.2 1.4c-.6.4-1.4.3-1.9-.2l-1.4-1.5c-.6-.7-.6-1.7.3-2.3Z"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7"/>',
  keyboard: '<rect x="3" y="6" width="18" height="12" rx="2.5"/><path d="M7 10h.01M11 10h.01M15 10h.01M7 14h10"/>',
  car: '<path d="M5 16.5V12l1.8-4.6A2 2 0 0 1 8.7 6h6.6a2 2 0 0 1 1.9 1.4L19 12v4.5"/><path d="M3.5 16.5h17v1.5a1 1 0 0 1-1 1H17a1 1 0 0 1-1-1v-1M8 16.5v1.5a1 1 0 0 1-1 1H4.5a1 1 0 0 1-1-1v-1.5M5 12h14"/><circle cx="8" cy="14" r=".6"/><circle cx="16" cy="14" r=".6"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 8.5-8.5M16 7l2.5 2.5M14 9l2 2"/>',
  bed: '<path d="M3 18V7M3 14h18v4M21 14v-2.5A2.5 2.5 0 0 0 18.5 9H11v5"/><circle cx="7" cy="11" r="1.8"/>',
  hotel: '<path d="M4 20.5V5.5A1.5 1.5 0 0 1 5.5 4h9A1.5 1.5 0 0 1 16 5.5v15M16 10h2.5a1.5 1.5 0 0 1 1.5 1.5v9M2.5 20.5h19"/><path d="M8 8h1M11 8h1M8 11.5h1M11 11.5h1M8 15h1M11 15h1"/>',
  box: '<path d="M4 8.5 12 4l8 4.5v7L12 20l-8-4.5Z"/><path d="M4 8.5 12 13l8-4.5M12 13v7"/>',
  alarm: '<circle cx="12" cy="13" r="7"/><path d="M12 9.5V13l2.5 1.5M5 4 2.5 6.5M19 4l2.5 2.5"/>',
  dining: '<path d="M7 3v8M5 3v4a2 2 0 0 0 4 0V3M7 11v10M16.5 21V3c-2 1-3.5 3.5-3.5 7h3.5"/>',
  wifi: '<path d="M2.5 9a14 14 0 0 1 19 0M5.5 12.5a9.5 9.5 0 0 1 13 0M8.8 15.8a5 5 0 0 1 6.4 0"/><circle cx="12" cy="19" r=".9"/>',
  receipt: '<path d="M6 3h12v18l-2.5-1.5L13 21l-2.5-1.5L8 21l-2-1.2Z"/><path d="M9 8h6M9 12h6M9 16h3"/>',
  mail: '<rect x="3" y="5.5" width="18" height="13" rx="2"/><path d="m3.8 7 8.2 6 8.2-6"/>',
  card: '<rect x="2.5" y="5.5" width="19" height="13" rx="2.2"/><path d="M2.5 10h19M6 14.5h4"/>',
  contactless: '<path d="M8 8.6a4.6 4.6 0 0 1 0 6.8M11.4 6.2a8 8 0 0 1 0 11.6M14.8 3.8a11.4 11.4 0 0 1 0 16.4"/>',
  star: '<path d="m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9Z"/>',
  crown: '<path d="m3.5 8 4.5 4 4-6.5 4 6.5 4.5-4-2 10.5h-13Z"/>',
  pin: '<path d="M12 21s-6.5-5.8-6.5-11a6.5 6.5 0 0 1 13 0c0 5.2-6.5 11-6.5 11Z"/><circle cx="12" cy="10" r="2.3"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2"/><path d="M3.5 9.5h17M8 3v4M16 3v4"/>',
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V6A1.5 1.5 0 0 0 14 4.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5"/>',
  sparkle: '<path d="M12 3.5 13.8 9l5.7 1.8-5.7 1.9L12 18.5l-1.8-5.8-5.7-1.9L10.2 9Z"/><path d="M19 3.5v3M17.5 5h3"/>',
  route: '<circle cx="6" cy="6" r="2.2"/><circle cx="18" cy="18" r="2.2"/><path d="M8 7.5c4 2 7 0 8.5 3s-1 4.5-2 5"/>',
  list: '<path d="M9 6.5h11M9 12h11M9 17.5h11"/><circle cx="4.5" cy="6.5" r=".9"/><circle cx="4.5" cy="12" r=".9"/><circle cx="4.5" cy="17.5" r=".9"/>',
  plane: '<path d="M10.5 13.5 4 12l-1-1.5 1.5-1L10.5 11 15 5.5a2 2 0 0 1 3 3L12.5 13l1.5 6-1 1.5-1.5-1Z"/>',
  door: '<path d="M6 20.5V4.5A1.5 1.5 0 0 1 7.5 3h9A1.5 1.5 0 0 1 18 4.5v16M3.5 20.5h17"/><circle cx="14.5" cy="12" r=".9"/>',
  chart: '<path d="M3.5 20.5h17M6.5 17v-4.5M11.5 17V7M16.5 17v-8"/>',
  tag: '<path d="M3.5 12.6V4.5a1 1 0 0 1 1-1h8.1l8 8-9 9Z"/><circle cx="8.2" cy="8.2" r="1.4"/>',
  up: '<path d="M12 19V5.5M6.5 11 12 5.5l5.5 5.5"/>',
  down2: '<path d="M12 5v13.5M6.5 13l5.5 5.5 5.5-5.5"/>',
  broom: '<path d="M14.5 3.5 10 12M7 12.5h7l1.5 8h-10Z"/><path d="M9.5 16.5v4M12.5 16.5v4"/>',
  wrench: '<path d="M14.5 6.5a4 4 0 0 0 5 5L12 19a2.1 2.1 0 0 1-3-3l7.5-7.5a4 4 0 0 1-2-2Z"/>',
  paw: '<g fill="currentColor" stroke="none"><ellipse cx="12" cy="15.6" rx="5.2" ry="4.4"/><ellipse cx="5.6" cy="10.2" rx="2.1" ry="2.6"/>'
    + '<ellipse cx="9.6" cy="6.4" rx="2.2" ry="2.8"/><ellipse cx="14.4" cy="6.4" rx="2.2" ry="2.8"/><ellipse cx="18.4" cy="10.2" rx="2.1" ry="2.6"/></g>',
};

/** An inline SVG icon; unknown names give an empty icon. */
export function icon(name, cls = 'icon') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', cls);
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.9');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = PATHS[name] || '';
  return svg;
}
