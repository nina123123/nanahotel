// Nana, NanaHotel's mascot: a calm capybara with an orange on its head. Static, trusted SVG markup only (never server
// data). Each part has a class so style.css can animate it; the mood is a data-mood attribute on the <svg>
// (one of PET_MOODS) and a poke is the .is-poked class. tools/build-pet-riv.mjs turns this same drawing into
// public/art/nana.riv, the animated Rive version the app plays when it can.

/** The pet's moods, in the order of the Rive state machine's `mood` input values. */
export const PET_MOODS = ['idle', 'listening', 'thinking', 'talking', 'happy', 'sleepy', 'oops'];

/**
 * The Rive artboards and the SVG view each one stands in for. Boxes are in drawing units (x, y, width, height):
 * a little bigger than the SVG views, which let bubbles, the Zzz and the falling orange overflow.
 */
export const PET_ARTBOARDS = {
  Head: { view: 'head', box: [-52, -80, 118, 120] },
  Body: { view: 'body', box: [-62, -86, 124, 158] },
  Onsen: { view: 'onsen', box: [-80, -72, 160, 140] },
};

const C = {
  fur: '#C98F5E',
  furShade: '#B27848',
  line: '#5C3A23',
  ear: '#9C6440',
  earIn: '#74472A',
  muzzle: '#B37A4B',
  nose: '#47301F',
  eye: '#2B1E17',
  blush: '#FF8A78',
  orange: '#FFA030',
  orangeLine: '#D9701E',
  orangeHl: '#FFD9A0',
  leaf: '#5DB35E',
  leafLine: '#3F8C45',
  water: '#58C6AE',
  waterDeep: '#2E9A84',
  waterHl: '#B5EDDF',
  sweat: '#8FD0FF',
};

const stroke = (color, width) => `stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"`;

function orange(cls = 'pet-orange') {
  return `<g class="${cls}">`
    + `<circle r="11" fill="${C.orange}" ${stroke(C.orangeLine, 2)}/>`
    + `<ellipse cx="-4.2" cy="-3.8" rx="3.4" ry="2.2" fill="${C.orangeHl}" transform="rotate(-35 -4.2 -3.8)"/>`
    + `<circle cx="0.4" cy="-10.6" r="1.4" fill="${C.leafLine}"/>`
    + `<path d="M0.8 -10.8c1.8-6 7.6-8.4 12.2-6.4c-1.8 5.4-7.2 7.8-12.2 6.4z" fill="${C.leaf}" ${stroke(C.leafLine, 1.5)}/>`
    + '</g>';
}

/** The head in local coordinates: a loaf about 76 × 67 around (0, 0), wider at the snout, the orange on top. */
function head() {
  const eye = (x) => `<g class="pet-eye"><ellipse cx="${x}" cy="-13" rx="3.6" ry="4.3" fill="${C.eye}"/>`
    + `<circle cx="${x + 1.4}" cy="-14.9" r="1.3" fill="#fff"/></g>`;
  const ear = (side, x) => `<g class="pet-ear pet-ear-${side}"><ellipse cx="${x}" cy="-31.5" rx="7.6" ry="6.6" fill="${C.ear}" ${stroke(C.line, 2.4)}/>`
    + `<ellipse cx="${x * 0.98}" cy="-30.5" rx="3.8" ry="3.2" fill="${C.earIn}"/></g>`;
  const arc = (d) => `<path d="${d}" fill="none" ${stroke(C.eye, 2.5)}/>`;
  return '<g class="pet-head">'
    + ear('l', -25) + ear('r', 25)
    + `<path class="pet-face" d="M0 -34H21Q33 -34 34.5 -21L37.5 12Q39 32.5 19 33H-19Q-39 32.5 -37.5 12L-34.5 -21Q-33 -34 -21 -34Z" fill="${C.fur}" ${stroke(C.line, 2.6)}/>`
    + `<ellipse cx="0" cy="13" rx="27" ry="17.5" fill="${C.muzzle}"/>`
    + `<ellipse class="pet-blush" cx="-28.5" cy="-2" rx="5.2" ry="3.2" fill="${C.blush}"/>`
    + `<ellipse class="pet-blush" cx="28.5" cy="-2" rx="5.2" ry="3.2" fill="${C.blush}"/>`
    + `<g class="pet-eyes">${eye(-16)}${eye(16)}</g>`
    + `<g class="pet-eyes-happy">${arc('M-20 -12q4-5 8 0')}${arc('M12 -12q4-5 8 0')}</g>`
    + `<g class="pet-eyes-sleep">${arc('M-20 -13q4 3.2 8 0')}${arc('M12 -13q4 3.2 8 0')}</g>`
    + `<g class="pet-eyes-squeeze">${arc('M-19.5 -16.5l6.5 3.4-6.5 3.4')}${arc('M19.5 -16.5l-6.5 3.4 6.5 3.4')}</g>`
    + `<ellipse cx="-7.6" cy="4.6" rx="2.7" ry="3.8" fill="${C.nose}" transform="rotate(-22 -7.6 4.6)"/>`
    + `<ellipse cx="7.6" cy="4.6" rx="2.7" ry="3.8" fill="${C.nose}" transform="rotate(22 7.6 4.6)"/>`
    + `<path class="pet-mouth" d="M-5.6 15q2.8 2.8 5.6 0q2.8 2.8 5.6 0" fill="none" ${stroke(C.nose, 2)}/>`
    + `<path class="pet-sweat" d="M37 -25c-3.2 4.4-3.6 7.6 0 8.6c3.6-1 3.2-4.2 0-8.6z" fill="${C.sweat}"/>`
    + `<g transform="translate(4 -37)">${orange()}</g>`
    + '<g class="pet-bubbles">'
    + `<circle class="pet-bubble" cx="31" cy="-40" r="2.6" fill="#fff" ${stroke(C.line, 1.5)}/>`
    + `<circle class="pet-bubble" cx="38.5" cy="-50" r="3.6" fill="#fff" ${stroke(C.line, 1.5)}/>`
    + `<circle class="pet-bubble" cx="47.5" cy="-62" r="5" fill="#fff" ${stroke(C.line, 1.5)}/>`
    + '</g>'
    + '<g class="pet-zzz" fill="currentColor" font-family="-apple-system, sans-serif" font-weight="800">'
    + '<text class="pet-z" x="33" y="-33" font-size="9">z</text>'
    + '<text class="pet-z" x="40" y="-43" font-size="11">z</text>'
    + '<text class="pet-z" x="48" y="-55" font-size="14">Z</text>'
    + '</g>'
    + '</g>';
}

function body() {
  return '<g class="pet-body">'
    + '<ellipse cx="0" cy="66" rx="40" ry="4.5" fill="#000" opacity=".08"/>'
    + `<path d="M-44 63c-5-30 11-50 44-50s49 20 44 50z" fill="${C.fur}" ${stroke(C.line, 2.6)}/>`
    + `<ellipse cx="-15" cy="61.5" rx="8.5" ry="5.6" fill="${C.furShade}" ${stroke(C.line, 2.2)}/>`
    + `<ellipse cx="15" cy="61.5" rx="8.5" ry="5.6" fill="${C.furShade}" ${stroke(C.line, 2.2)}/>`
    + '</g>';
}

function pool() {
  const wave = 'M-76 33q9.5-4.6 19 0t19 0t19 0t19 0t19 0t19 0t19 0t19 0';
  return {
    back: `<ellipse cx="0" cy="34" rx="76" ry="13" fill="${C.waterDeep}"/>`,
    front: '<g class="pet-water">'
      + `<path d="${wave}V54q0 11-12 11H-64q-12 0-12-11z" fill="${C.water}"/>`
      + `<path d="M-52 44h16M-14 50h22M30 44h14" fill="none" ${stroke(C.waterHl, 2.4)}/>`
      + '</g>'
      + `<g transform="translate(-48 33) scale(.62)">${orange('pet-float')}</g>`
      + `<g transform="translate(50 37) scale(.55) rotate(40)">${orange('pet-float pet-float-2')}</g>`,
    steam: '<g class="pet-steam" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round">'
      + '<path d="M-58 14c-6-6 6-11 0-17s6-11 0-17"/>'
      + '<path d="M58 10c-6-6 6-11 0-17s6-11 0-17"/>'
      + '<path d="M68 22c-5-5 5-9 0-14s5-9 0-14"/>'
      + '</g>',
  };
}

const VIEWS = {
  // A head for avatars: room above for the orange, beside for bubbles.
  head: { box: '-46 -60 92 96', art: () => head() },
  // Sitting, for the welcome screen.
  body: { box: '-62 -86 124 158', art: () => body() + `<g transform="translate(0 -12)">${head()}</g>` },
  // Peeking over the top edge of a card: ears, eyes, orange and two paws on the edge.
  peek: {
    box: '-46 -60 92 56',
    art: () => head()
      + `<ellipse cx="-27" cy="-5" rx="7.4" ry="4.8" fill="${C.furShade}" ${stroke(C.line, 2.2)}/>`
      + `<ellipse cx="27" cy="-5" rx="7.4" ry="4.8" fill="${C.furShade}" ${stroke(C.line, 2.2)}/>`,
  },
  // Soaking in a hot spring with floating oranges: the sticker after a booking is paid.
  onsen: {
    box: '-80 -72 160 140',
    art: () => {
      const p = pool();
      return p.steam + p.back + `<g transform="translate(0 4)">${head()}</g>` + p.front;
    },
  },
};

/** SVG markup for one view of the pet; `mood` sets the starting expression. */
export function petMarkup(view = 'head', { mood = 'idle', label = '' } = {}) {
  const v = VIEWS[view] || VIEWS.head;
  const a11y = label ? `role="img" aria-label="${label}"` : 'aria-hidden="true" focusable="false"';
  return `<svg class="pet pet-${view}" viewBox="${v.box}" data-mood="${mood}" ${a11y} xmlns="http://www.w3.org/2000/svg">${v.art()}</svg>`;
}

/** The pet as a DOM node. */
export function petNode(view, options) {
  const tpl = document.createElement('template');
  tpl.innerHTML = petMarkup(view, options);
  return tpl.content.firstElementChild;
}
