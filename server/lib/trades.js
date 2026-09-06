'use strict';
/*
 * The trade taxonomy, and the reason this app can be Booksy at all.
 *
 * A haircut is bookable because it has a known duration and a known price.
 * Most trade work has neither — but SOME of it does, and that subset is
 * bigger than it first looks. Every trade below carries a starter list of
 * genuinely fixed-scope jobs (`bookable`) alongside the open-ended work that
 * can only ever be quoted (`quoteOnly`).
 *
 * A pro publishes whichever of these they actually offer. Instant booking is
 * offered on the fixed ones; everything else routes to a callout request.
 * That split is the product.
 */

const TRADES = [
  {
    key: 'electrician', name: 'Electrician', icon: '⚡',
    bookable: [
      { name: 'EV charger site survey', minutes: 45 },
      { name: 'Fuse board / consumer unit inspection', minutes: 60 },
      { name: 'PAT testing (up to 20 items)', minutes: 90 },
      { name: 'Socket or light fitting install', minutes: 60 },
      { name: 'Smoke alarm install (per unit)', minutes: 30 },
      { name: 'Periodic inspection report', minutes: 180 },
    ],
    quoteOnly: ['Full rewire', 'New build first fix', 'Fault finding', 'Board upgrade'],
  },
  {
    key: 'plumber', name: 'Plumber', icon: '🔧',
    bookable: [
      { name: 'Annual boiler service', minutes: 60 },
      { name: 'Radiator power flush (per rad)', minutes: 45 },
      { name: 'Tap or mixer replacement', minutes: 45 },
      { name: 'Toilet / cistern repair', minutes: 60 },
      { name: 'Outside tap install', minutes: 60 },
    ],
    quoteOnly: ['Leak — emergency', 'Bathroom refit', 'Full heating system', 'Boiler replacement'],
  },
  {
    key: 'gas', name: 'Gas engineer (RGI)', icon: '🔥',
    bookable: [
      { name: 'Gas boiler service + cert', minutes: 75 },
      { name: 'Gas safety inspection (landlord)', minutes: 60 },
      { name: 'Gas hob install', minutes: 90 },
    ],
    quoteOnly: ['Boiler replacement', 'Gas leak — emergency', 'New gas run'],
  },
  {
    key: 'carpenter', name: 'Carpenter / joiner', icon: '🪚',
    bookable: [
      { name: 'Internal door hang (per door)', minutes: 90 },
      { name: 'Flat-pack assembly (per hour)', minutes: 60 },
      { name: 'Shelving install', minutes: 120 },
      { name: 'Loft hatch and ladder', minutes: 180 },
    ],
    quoteOnly: ['Fitted wardrobes', 'Kitchen fitting', 'Staircase', 'Decking'],
  },
  {
    key: 'painter', name: 'Painter / decorator', icon: '🎨',
    bookable: [
      { name: 'Colour consultation and measure', minutes: 45 },
      { name: 'Single room repaint — quote visit', minutes: 30 },
    ],
    quoteOnly: ['Whole house interior', 'Exterior', 'Wallpapering', 'Commercial'],
  },
  {
    key: 'tiler', name: 'Tiler', icon: '🧱',
    bookable: [{ name: 'Regrout and reseal — small bathroom', minutes: 180 }],
    quoteOnly: ['Bathroom tiling', 'Kitchen splashback', 'Floor tiling'],
  },
  {
    key: 'roofer', name: 'Roofer', icon: '🏠',
    bookable: [
      { name: 'Roof inspection and report', minutes: 60 },
      { name: 'Gutter clean (semi-d)', minutes: 90 },
      { name: 'Slate / tile replacement (up to 5)', minutes: 120 },
    ],
    quoteOnly: ['Full re-roof', 'Storm damage — emergency', 'Flat roof replacement', 'Chimney'],
  },
  {
    key: 'plasterer', name: 'Plasterer', icon: '🪣',
    bookable: [{ name: 'Patch repair — single wall', minutes: 180 }],
    quoteOnly: ['Full room skim', 'External render', 'Ceiling replacement'],
  },
  {
    key: 'landscaper', name: 'Landscaper / groundworks', icon: '🌿',
    bookable: [
      { name: 'Garden tidy — half day', minutes: 240 },
      { name: 'Hedge cutting (per hour)', minutes: 60 },
      { name: 'Lawn treatment', minutes: 60 },
    ],
    quoteOnly: ['Patio or paving', 'Full garden redesign', 'Drainage', 'Driveway'],
  },
  {
    key: 'locksmith', name: 'Locksmith', icon: '🔑',
    bookable: [
      { name: 'Lock change (per door)', minutes: 45 },
      { name: 'Window lock service', minutes: 60 },
    ],
    quoteOnly: ['Lockout — emergency', 'Full house security upgrade'],
  },
  {
    key: 'appliance', name: 'Appliance repair', icon: '🔌',
    bookable: [
      { name: 'Washing machine diagnostic', minutes: 60 },
      { name: 'Dishwasher install', minutes: 60 },
      { name: 'Oven / hob diagnostic', minutes: 60 },
    ],
    quoteOnly: ['Integrated appliance replacement'],
  },
  {
    key: 'window', name: 'Windows & doors', icon: '🪟',
    bookable: [
      { name: 'Measure and quote visit', minutes: 45 },
      { name: 'Window seal / hinge repair', minutes: 60 },
    ],
    quoteOnly: ['Full window replacement', 'Composite door install'],
  },
];

const BY_KEY = new Map(TRADES.map((t) => [t.key, t]));

/*
 * Irish counties plus the UK nations, because the deck's own open-risks slide
 * says design for both from day one rather than retrofitting the UK later.
 */
const AREAS = [
  { key: 'dublin', name: 'Dublin', region: 'IE' },
  { key: 'wicklow', name: 'Wicklow', region: 'IE' },
  { key: 'kildare', name: 'Kildare', region: 'IE' },
  { key: 'meath', name: 'Meath', region: 'IE' },
  { key: 'louth', name: 'Louth', region: 'IE' },
  { key: 'cork', name: 'Cork', region: 'IE' },
  { key: 'kerry', name: 'Kerry', region: 'IE' },
  { key: 'limerick', name: 'Limerick', region: 'IE' },
  { key: 'clare', name: 'Clare', region: 'IE' },
  { key: 'galway', name: 'Galway', region: 'IE' },
  { key: 'mayo', name: 'Mayo', region: 'IE' },
  { key: 'sligo', name: 'Sligo', region: 'IE' },
  { key: 'donegal', name: 'Donegal', region: 'IE' },
  { key: 'waterford', name: 'Waterford', region: 'IE' },
  { key: 'wexford', name: 'Wexford', region: 'IE' },
  { key: 'kilkenny', name: 'Kilkenny', region: 'IE' },
  { key: 'tipperary', name: 'Tipperary', region: 'IE' },
  { key: 'westmeath', name: 'Westmeath', region: 'IE' },
  { key: 'offaly', name: 'Offaly', region: 'IE' },
  { key: 'laois', name: 'Laois', region: 'IE' },
  { key: 'carlow', name: 'Carlow', region: 'IE' },
  { key: 'longford', name: 'Longford', region: 'IE' },
  { key: 'leitrim', name: 'Leitrim', region: 'IE' },
  { key: 'roscommon', name: 'Roscommon', region: 'IE' },
  { key: 'cavan', name: 'Cavan', region: 'IE' },
  { key: 'monaghan', name: 'Monaghan', region: 'IE' },
  { key: 'belfast', name: 'Belfast', region: 'UK' },
  { key: 'antrim', name: 'Antrim', region: 'UK' },
  { key: 'down', name: 'Down', region: 'UK' },
  { key: 'derry', name: 'Derry / Londonderry', region: 'UK' },
  { key: 'armagh', name: 'Armagh', region: 'UK' },
  { key: 'tyrone', name: 'Tyrone', region: 'UK' },
  { key: 'fermanagh', name: 'Fermanagh', region: 'UK' },
];

const AREA_BY_KEY = new Map(AREAS.map((a) => [a.key, a]));

/* Urgency drives the whole customer experience and the pro's sort order. */
const URGENCY = [
  { key: 'emergency', name: 'Emergency — today', note: 'Water, gas, electrics, security', rank: 0 },
  { key: 'week', name: 'Within the week', note: 'Broken but not dangerous', rank: 1 },
  { key: 'flexible', name: "I'm flexible", note: 'Planned work', rank: 2 },
  { key: 'planning', name: 'Just planning', note: 'Budgeting, no date yet', rank: 3 },
];

const URGENCY_BY_KEY = new Map(URGENCY.map((u) => [u.key, u]));

module.exports = { TRADES, BY_KEY, AREAS, AREA_BY_KEY, URGENCY, URGENCY_BY_KEY };
