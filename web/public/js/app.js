/*
 * The shell: one router, two front doors.
 *
 * Foxers is two apps sharing a domain. A customer never signs in — they
 * arrive, search, book or ask, and afterwards hold a job link that is its own
 * credential. A foxer signs in and gets the console: requests, quotes, the
 * calendar, and the money. Both are served from this one file so a link from
 * either side lands in the right place without a page load.
 */

import { session, whoami, whoamiCustomer, logout, customerLogout, meta } from './api.js';
import * as customer from './customer.js';
import * as pro from './pro.js';
import { el, clear, notice } from './ui.js';

/*
 * Order is significant: the first pattern that matches wins, so anything
 * with a literal first segment must be listed before "/pro/:slug", which
 * would otherwise swallow it.
 */
const ROUTES = [
  ['/', customer.home],
  ['/find', customer.find],
  ['/ask', customer.ask],
  ['/book/:slug/:serviceId', customer.book],
  ['/j/:ref', customer.job],

  ['/signin', customer.signin],
  ['/join', customer.join],
  ['/me', customer.myJobsView, { customer: true }],
  ['/me/account', customer.account, { customer: true }],

  ['/login', pro.login],
  ['/signup', pro.signup],

  ['/dash', pro.dashboard, { auth: true }],
  ['/dash/requests', pro.requests, { auth: true }],
  ['/dash/quote', pro.quoteBuilder, { auth: true }],
  ['/dash/quotes', pro.quotes, { auth: true }],
  ['/dash/calendar', pro.calendar, { auth: true }],
  ['/dash/services', pro.services, { auth: true }],
  ['/dash/hours', pro.hours, { auth: true }],
  ['/dash/money', pro.money, { auth: true }],
  ['/dash/profile', pro.settings, { auth: true }],

  ['/pro/:slug', customer.profile],
];

const compiled = ROUTES.map(([pattern, view, opts = {}]) => ({
  view,
  opts,
  rx: new RegExp('^' + pattern
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/:([a-zA-Z]+)/g, '(?<$1>[^/]+)') + '/?$'),
}));

function resolve(pathname) {
  for (const r of compiled) {
    const m = r.rx.exec(pathname);
    if (m) return { ...r, params: m.groups || {} };
  }
  return null;
}

const mount = document.getElementById('app');
const navBar = document.getElementById('nav');

export function navigate(to, { replace = false } = {}) {
  const url = new URL(to, location.origin);
  if (url.origin !== location.origin) { location.href = to; return; }
  history[replace ? 'replaceState' : 'pushState']({}, '', url);
  render();
}

/*
 * One listener on the document rather than one per link: views build their
 * markup with plain <a href>, which keeps them readable and keeps middle
 * click, open-in-new-tab and copy-link working exactly as a user expects.
 */
document.addEventListener('click', (ev) => {
  if (ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
  const a = ev.target.closest('a[href]');
  if (!a || a.target === '_blank' || a.hasAttribute('download')) return;
  const url = new URL(a.getAttribute('href'), location.href);
  if (url.origin !== location.origin) return;
  ev.preventDefault();
  if (url.href === location.href) return;
  navigate(url.pathname + url.search);
});

window.addEventListener('popstate', () => render());

/* ---- chrome ---------------------------------------------------------- */

const CONSOLE_TABS = [
  ['/dash', 'Today'],
  ['/dash/requests', 'Requests'],
  ['/dash/quotes', 'Quotes'],
  ['/dash/calendar', 'Diary'],
  ['/dash/money', 'Money'],
  ['/dash/services', 'Services'],
  ['/dash/hours', 'Hours'],
  ['/dash/profile', 'Business'],
];

/*
 * Three states, not two. Somebody can be signed in as a foxer, as a customer,
 * or as both — a tradesperson books a plumber like anyone else — so the bar
 * shows whichever sides of the app they actually have open to them.
 */
function renderNav(path) {
  const inConsole = path === '/dash' || path.startsWith('/dash/');
  const inAccount = path === '/me' || path.startsWith('/me/');
  clear(navBar);

  navBar.append(el('a', {
    href: '/find', class: path.startsWith('/find') ? 'active' : '',
  }, 'Find a tradesperson'));

  if (session.customer) {
    navBar.append(el('a', { href: '/me', class: inAccount ? 'active' : '' }, 'My jobs'));
  }
  if (session.pro) {
    navBar.append(
      el('a', { href: '/dash', class: inConsole ? 'active' : '' }, 'My work'),
      el('a', { href: `/pro/${session.pro.slug}` }, 'My public page'));
  }

  if (!session.pro && !session.customer) {
    navBar.append(
      el('a', { href: '/signup' }, 'List your business'),
      el('a', { href: '/signin', class: path === '/signin' ? 'active' : '' }, 'Sign in'));
    return;
  }

  navBar.append(el('a', {
    href: '/',
    onclick: async (ev) => {
      ev.preventDefault();
      await Promise.all([session.pro ? logout() : null, session.customer ? customerLogout() : null]);
      navigate('/');
    },
  }, 'Sign out'));
}

/*
 * The console's own tab strip. It is rendered by the shell rather than by
 * each view so that every screen in the console agrees on where it is.
 */
function consoleTabs(path) {
  return el('nav', { class: 'tabs' }, CONSOLE_TABS.map(([href, label]) =>
    el('a', { href, class: href === path ? 'active' : '' }, label)));
}

/* ---- render ---------------------------------------------------------- */

let renderToken = 0;

async function render() {
  const token = ++renderToken;
  const path = location.pathname.replace(/\/+$/, '') || '/';
  const query = new URLSearchParams(location.search);
  const hit = resolve(path);

  renderNav(path);
  window.scrollTo(0, 0);

  if (!hit) {
    clear(mount).append(
      el('h1', {}, 'Nothing here'),
      el('p', { class: 'muted' }, 'That address does not match anything on Foxers.'),
      el('a', { class: 'btn primary', href: '/' }, 'Back to the start'));
    return;
  }

  if (hit.opts.auth && !session.pro) {
    return navigate(`/login?next=${encodeURIComponent(path + location.search)}`, { replace: true });
  }
  if (hit.opts.customer && !session.customer) {
    return navigate(`/signin?next=${encodeURIComponent(path + location.search)}`, { replace: true });
  }

  const inConsole = path === '/dash' || path.startsWith('/dash/');
  clear(mount);
  if (inConsole) mount.append(consoleTabs(path));

  const target = inConsole ? el('div') : mount;
  if (inConsole) mount.append(target);

  try {
    await hit.view(target, { params: hit.params, query, navigate, path });
  } catch (err) {
    // A view that throws would otherwise leave the spinner spinning forever.
    if (token !== renderToken) return;
    console.error('[foxers]', path, err);
    clear(target).append(
      notice('err', err.message || 'Something went wrong drawing this page.'),
      el('a', { class: 'btn', href: '/' }, 'Back to the start'));
  }
}

/*
 * Ask who we are before the first paint. A signed-in foxer landing on "/"
 * should see the console nav immediately rather than watch it appear a
 * moment later, and a stale token should be cleared before any view uses it.
 */
/*
 * The version, in the footer. Read from the server rather than baked into the
 * page, so a browser holding a cached shell still reports what it is actually
 * talking to — which is the only number worth having when someone says "it is
 * doing something odd".
 */
async function showVersion() {
  const slot = document.getElementById('version');
  if (!slot) return;
  try {
    const m = await meta();
    if (m.version) slot.textContent = `v${m.version}`;
  } catch { /* offline — better to show nothing than a stale number */ }
}

(async () => {
  showVersion();
  await Promise.all([
    session.token ? whoami().catch(() => null) : null,
    session.customerToken ? whoamiCustomer().catch(() => null) : null,
  ]);
  render();
})();
