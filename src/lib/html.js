// Escaping + tiny template helpers. Every value from the API goes through esc().
export const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const attr = esc;
export const join = (items, fn, sep = '') => (items || []).map(fn).join(sep);
export const when = (cond, fn) => (cond ? fn() : '');
