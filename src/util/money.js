// US dollar amounts in text. Data holds plain numbers (USD); text shows whole dollars from $100 up ('$1,108') and
// cents below ('$23.50'), as the page does.

/** 1108 → '$1,108', 23.5 → '$23.50', -5 → '-$5.00'. */
export function formatUsd(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '$0.00';
  const sign = v < 0 ? '-' : '';
  const a = Math.abs(v);
  if (a >= 100) return `${sign}$${Math.round(a).toLocaleString('en-US')}`;
  return `${sign}$${a.toFixed(2)}`;
}

/** Rounds to cents, so sums of amounts do not drift (0.1 + 0.2). */
export function cents(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}
