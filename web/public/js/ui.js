/* DOM and formatting helpers. Small on purpose — no framework to install. */

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

export const frag = (...children) => {
  const f = document.createDocumentFragment();
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    f.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return f;
};

export function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); return node; }

/*
 * Append children to an existing node, skipping the absent ones.
 *
 * `node.append(null)` does NOT skip — DOM append stringifies anything that is
 * not a Node, so a `cond ? el(…) : null` argument renders the literal text
 * "null" on the page. Views build children conditionally everywhere, so they
 * append through this rather than calling `.append` directly.
 */
export function put(node, ...children) {
  node.append(frag(...children));
  return node;
}

/* Currency follows the pro's region rather than the viewer's locale — the
 * invoice is a legal document and must say what was actually charged. */
export function money(n, region = 'IE') {
  const currency = region === 'UK' ? 'GBP' : 'EUR';
  return new Intl.NumberFormat(region === 'UK' ? 'en-GB' : 'en-IE',
    { style: 'currency', currency }).format(Number(n) || 0);
}

export function dateTime(iso, opts = {}) {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('en-IE', {
    weekday: 'short', day: 'numeric', month: 'short',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', ...opts,
  }).format(new Date(iso));
}

export function dateOnly(iso) {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('en-IE', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso));
}

export function relative(iso) {
  if (!iso) return '';
  const diff = Date.parse(iso) - Date.now();
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat('en-IE', { numeric: 'auto' });
  const units = [['day', 86400000], ['hour', 3600000], ['minute', 60000]];
  for (const [unit, ms] of units) {
    if (abs >= ms || unit === 'minute') return rtf.format(Math.round(diff / ms), unit);
  }
  return '';
}

export function stars(avg) {
  if (avg == null) return el('span', { class: 'muted' }, 'No reviews yet');
  const full = Math.round(avg);
  return el('span', { class: 'stars' }, '★'.repeat(full) + '☆'.repeat(5 - full));
}

export function notice(kind, message) {
  return el('div', { class: `notice ${kind}` }, message);
}

export function loading(label = 'Loading') {
  return el('div', { class: 'empty' }, el('span', { class: 'spinner' }), ' ', label);
}

export function empty(message, action) {
  return el('div', { class: 'empty' }, el('p', {}, message), action || null);
}

export function field(label, input, hint) {
  return el('div', { class: 'field' },
    el('label', { for: input.id || null }, label),
    input,
    hint ? el('small', {}, hint) : null);
}

export function input(attrs = {}) { return el('input', attrs); }

export function select(attrs, options, selected) {
  const s = el('select', attrs);
  for (const o of options) {
    s.append(el('option', { value: o.value, selected: o.value === selected }, o.label));
  }
  return s;
}

/* A form's values without wiring up a listener per input. */
export function values(form) {
  const out = {};
  for (const el of form.querySelectorAll('input,select,textarea')) {
    if (!el.name) continue;
    if (el.type === 'checkbox') out[el.name] = el.checked;
    else if (el.type === 'number') out[el.name] = el.value === '' ? null : Number(el.value);
    else out[el.name] = el.value;
  }
  return out;
}

export function statusChip(status) {
  const map = {
    open: 'amber', quoted: 'amber', sent: 'amber', confirmed: 'good', scheduled: 'good',
    accepted: 'good', done: 'good', paid: 'good', issued: 'amber',
    declined: 'bad', cancelled: 'bad', expired: 'bad',
  };
  return el('span', { class: `chip ${map[status] || ''}` }, status);
}

/* WhatsApp first: it is free, and it is where the conversation already is.
 * SMS at €0.04–0.07 a message would be the biggest line in cost of goods. */
export function whatsappLink(phone, text) {
  const digits = String(phone || '').replace(/\D/g, '');
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}

export function copyButton(text, label = 'Copy link') {
  const btn = el('button', { class: 'btn sm ghost', type: 'button' }, label);
  btn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = 'Copied';
    } catch {
      // Clipboard access is denied outside a secure context; showing the
      // value is more use than an error the user cannot act on.
      btn.textContent = text;
    }
    setTimeout(() => { btn.textContent = label; }, 2000);
  });
  return btn;
}

/*
 * The money block under a quote or an invoice. It lives here rather than in
 * either client because the customer and the pro must be looking at exactly
 * the same arithmetic — a total that differs between the two screens is the
 * one bug this app cannot afford.
 */
export function totalsBlock(t, region) {
  return el('div', { class: 'totals' },
    el('div', { class: 'line' }, el('span', {}, 'Labour'), el('span', { class: 'mono' }, money(t.netLabour, region))),
    t.netMaterials ? el('div', { class: 'line' }, el('span', {}, 'Materials'), el('span', { class: 'mono' }, money(t.netMaterials, region))) : null,
    el('div', { class: 'line' }, el('span', {}, 'Net'), el('span', { class: 'mono' }, money(t.net, region))),
    t.reverseCharge
      ? el('div', { class: 'line muted' }, el('span', {}, 'VAT — reverse charge'), el('span', { class: 'mono' }, money(0, region)))
      : t.vatBreakdown.map((b) => el('div', { class: 'line' },
          el('span', {}, b.label), el('span', { class: 'mono' }, money(b.vat, region)))),
    el('div', { class: 'line sum' }, el('span', {}, 'Total'), el('span', { class: 'mono' }, money(t.gross, region))),
    t.withholding.amount ? frag(
      el('div', { class: 'line withheld' },
        el('span', {}, `${t.withholding.scheme} ${t.withholding.rate}% withheld`),
        el('span', { class: 'mono' }, `− ${money(t.withholding.amount, region)}`)),
      el('div', { class: 'line sum' }, el('span', {}, 'You pay'), el('span', { class: 'mono' }, money(t.payable, region)))) : null,
    t.reverseChargeNote ? el('small', { class: 'muted', style: 'display:block;margin-top:.5rem' }, t.reverseChargeNote) : null);
}
