// Builds public/art/nana.riv: Nana the capybara for the Rive runtime, from the same drawing as public/pet.js.
//   node tools/build-pet-riv.mjs        writes the file (run it after changing the drawing or the animations)
//   buildPetRiv()                       the bytes (test/pet-riv.test.js checks the committed file is current)
//
// A .riv file (format: https://github.com/rive-app/rive-runtime, MIT) is a header, then a flat list of objects:
// a type key, (property key, value) pairs, and a 0. Components name their parent by index within their artboard
// (the artboard is 0); keyed objects, animation states, transitions and conditions point at components, animations,
// states and inputs by index too. Shapes listed earlier are drawn on top.
//
// Artboards: Head (header and reply avatars), Body (welcome screen), Onsen (the sticker after a booking). Head and
// Body have the state machine "pet" with inputs mood (number: the index in PET_MOODS) and poke (trigger), and three
// layers: mood (a loop per mood, 250 ms crossfades), life (blinks, the orange bobbing, ear twitches, breathing) and
// poke (the orange falls off and goes back on). Onsen just soaks.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { petMarkup, PET_ARTBOARDS, PET_MOODS } from '../public/pet.js';

const OUT = fileURLToPath(new URL('../public/art/nana.riv', import.meta.url));
const FPS = 60;
const DEG = Math.PI / 180;
const TAU = Math.PI * 2;

// ---------------------------------------------------------------------------------------------------------
// Binary format (type and property keys from rive-runtime's include/rive/generated/*_base.hpp)
// ---------------------------------------------------------------------------------------------------------

const TYPE = {
  Backboard: 23, Artboard: 1, Node: 2, Shape: 3, Ellipse: 4, PointsPath: 16, CubicDetachedVertex: 6,
  Fill: 20, Stroke: 24, SolidColor: 18,
  LinearAnimation: 31, KeyedObject: 25, KeyedProperty: 26, KeyFrameDouble: 30,
  StateMachine: 53, StateMachineNumber: 56, StateMachineTrigger: 58, StateMachineLayer: 57,
  EntryState: 63, AnyState: 62, ExitState: 64, AnimationState: 61, StateTransition: 65,
  TransitionNumberCondition: 70, TransitionTriggerCondition: 68,
};

const PROP = {
  name: [4, 'string'], parentId: [5, 'uint'],
  width: [7, 'double'], height: [8, 'double'], originX: [11, 'double'], originY: [12, 'double'],
  x: [13, 'double'], y: [14, 'double'], rotation: [15, 'double'], scaleX: [16, 'double'], scaleY: [17, 'double'],
  opacity: [18, 'double'],
  pathWidth: [20, 'double'], pathHeight: [21, 'double'], isClosed: [32, 'bool'],
  vx: [24, 'double'], vy: [25, 'double'],
  inRotation: [84, 'double'], inDistance: [85, 'double'], outRotation: [86, 'double'], outDistance: [87, 'double'],
  fillRule: [40, 'uint'], thickness: [47, 'double'], cap: [48, 'uint'], join: [49, 'uint'],
  colorValue: [37, 'color'],
  animName: [55, 'string'], fps: [56, 'uint'], duration: [57, 'uint'], speed: [58, 'double'], loopValue: [59, 'uint'],
  objectId: [51, 'uint'], propertyKey: [53, 'uint'],
  frame: [67, 'uint'], interpolationType: [68, 'uint'], value: [70, 'double'],
  inputName: [138, 'string'], numberValue: [140, 'double'],
  animationId: [149, 'uint'], stateToId: [151, 'uint'], flags: [152, 'uint'], mixMs: [158, 'uint'], exitTime: [160, 'uint'],
  inputId: [155, 'uint'], opValue: [156, 'uint'], conditionValue: [157, 'double'],
};

// Properties an animation can key.
const KEYABLE = { x: 13, y: 14, rotation: 15, scaleX: 16, scaleY: 17, opacity: 18 };
const LINEAR = 1;
const LOOP = 1;
const ONE_SHOT = 0;
const EXIT_AT_END = { flags: 4 | 8, exitTime: 100 }; // EnableExitTime | ExitTimeIsPercentage, at 100%
const ROUND = 1;

class Bytes {
  constructor() {
    this.out = [];
    this.scratch = new DataView(new ArrayBuffer(4));
  }

  byte(b) {
    this.out.push(b & 0xff);
  }

  varuint(n) {
    let v = Math.max(0, Math.floor(n));
    do {
      let b = v % 128;
      v = Math.floor(v / 128);
      if (v) b |= 0x80;
      this.byte(b);
    } while (v);
  }

  float32(v) {
    this.scratch.setFloat32(0, v, true);
    for (let i = 0; i < 4; i += 1) this.byte(this.scratch.getUint8(i));
  }

  uint32(v) {
    this.scratch.setUint32(0, v >>> 0, true);
    for (let i = 0; i < 4; i += 1) this.byte(this.scratch.getUint8(i));
  }

  string(s) {
    const bytes = new TextEncoder().encode(s);
    this.varuint(bytes.length);
    for (const b of bytes) this.byte(b);
  }
}

function encode(objects) {
  const w = new Bytes();
  for (const c of 'RIVE') w.byte(c.charCodeAt(0));
  w.varuint(7); // major version
  w.varuint(0); // minor version
  w.varuint(0); // file id
  w.varuint(0); // empty property table: the runtime knows every property used here
  for (const { type, props } of objects) {
    w.varuint(TYPE[type]);
    for (const [name, value] of Object.entries(props)) {
      if (value === undefined || value === null) continue;
      const [key, kind] = PROP[name];
      w.varuint(key);
      if (kind === 'uint') w.varuint(value);
      else if (kind === 'double') w.float32(value);
      else if (kind === 'bool') w.byte(value ? 1 : 0);
      else if (kind === 'color') w.uint32(value);
      else w.string(value);
    }
    w.varuint(0);
  }
  return Uint8Array.from(w.out);
}

// ---------------------------------------------------------------------------------------------------------
// pet.js markup → tree
// ---------------------------------------------------------------------------------------------------------

function parseSvg(markup) {
  const root = { tag: '#root', attrs: {}, children: [] };
  const stack = [root];
  for (const m of markup.matchAll(/<(\/?)([a-zA-Z]+)((?:\s+[\w:-]+="[^"]*")*)\s*(\/?)>|([^<]+)/g)) {
    const top = stack[stack.length - 1];
    if (m[5] !== undefined) {
      if (top.tag === 'text') top.text = m[5].trim();
      continue;
    }
    if (m[1]) {
      stack.pop();
      continue;
    }
    const attrs = Object.fromEntries([...m[3].matchAll(/([\w:-]+)="([^"]*)"/g)].map((a) => [a[1], a[2]]));
    const node = { tag: m[2], attrs, children: [] };
    top.children.push(node);
    if (!m[4]) stack.push(node);
  }
  return root.children[0];
}

function parseTransform(t = '') {
  const out = { x: 0, y: 0, rotation: 0, scale: 1 };
  for (const [, fn, args] of t.matchAll(/(\w+)\(([^)]*)\)/g)) {
    const n = args.split(/[\s,]+/).filter(Boolean).map(Number);
    if (fn === 'translate') {
      out.x += n[0];
      out.y += n[1] || 0;
    } else if (fn === 'scale') out.scale *= n[0];
    else if (fn === 'rotate') out.rotation += n[0] * DEG;
  }
  return out;
}

/** SVG path data → contours of anchors with absolute in/out control points (everything as cubics). */
function pathContours(d) {
  const tokens = d.match(/[MmLlHhVvCcSsQqTtZz]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g) || [];
  const contours = [];
  let i = 0;
  let cmd = null;
  let cur = { x: 0, y: 0 };
  let start = cur;
  let contour = null;
  let lastC = null;
  let lastQ = null;
  const num = () => Number(tokens[i++]);
  const isNum = () => i < tokens.length && !/^[A-Za-z]$/.test(tokens[i]);
  const anchor = (p) => ({ x: p.x, y: p.y, inX: p.x, inY: p.y, outX: p.x, outY: p.y });
  const cubic = (c1, c2, p) => {
    const last = contour.points[contour.points.length - 1];
    last.outX = c1.x;
    last.outY = c1.y;
    contour.points.push({ ...anchor(p), inX: c2.x, inY: c2.y });
    cur = p;
  };
  const toward = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  const mirror = (c, about) => ({ x: 2 * about.x - c.x, y: 2 * about.y - c.y });
  while (i < tokens.length) {
    if (!isNum()) cmd = tokens[i++];
    const rel = cmd === cmd.toLowerCase();
    const base = rel ? cur : { x: 0, y: 0 };
    const pt = () => ({ x: base.x + num(), y: base.y + num() });
    switch (cmd.toUpperCase()) {
      case 'M': {
        const p = pt();
        contour = { closed: false, points: [anchor(p)] };
        contours.push(contour);
        start = cur = p;
        cmd = rel ? 'l' : 'L';
        lastC = lastQ = null;
        break;
      }
      case 'L': {
        const p = pt();
        cubic(cur, p, p);
        lastC = lastQ = null;
        break;
      }
      case 'H': {
        const p = { x: (rel ? cur.x : 0) + num(), y: cur.y };
        cubic(cur, p, p);
        lastC = lastQ = null;
        break;
      }
      case 'V': {
        const p = { x: cur.x, y: (rel ? cur.y : 0) + num() };
        cubic(cur, p, p);
        lastC = lastQ = null;
        break;
      }
      case 'C': {
        const c1 = pt();
        const c2 = pt();
        const p = pt();
        cubic(c1, c2, p);
        lastC = c2;
        lastQ = null;
        break;
      }
      case 'S': {
        const c1 = lastC ? mirror(lastC, cur) : cur;
        const c2 = pt();
        const p = pt();
        cubic(c1, c2, p);
        lastC = c2;
        lastQ = null;
        break;
      }
      case 'Q': {
        const from = cur;
        const q = pt();
        const p = pt();
        cubic(toward(from, q, 2 / 3), toward(p, q, 2 / 3), p);
        lastQ = q;
        lastC = null;
        break;
      }
      case 'T': {
        const from = cur;
        const q = lastQ ? mirror(lastQ, from) : from;
        const p = pt();
        cubic(toward(from, q, 2 / 3), toward(p, q, 2 / 3), p);
        lastQ = q;
        lastC = null;
        break;
      }
      case 'Z': {
        contour.closed = true;
        const first = contour.points[0];
        const last = contour.points[contour.points.length - 1];
        if (contour.points.length > 1 && Math.hypot(last.x - first.x, last.y - first.y) < 1e-6) {
          first.inX = last.inX;
          first.inY = last.inY;
          contour.points.pop();
        }
        cur = start;
        lastC = lastQ = null;
        break;
      }
      default:
        throw new Error(`unsupported path command ${cmd}`);
    }
  }
  return contours;
}

/** A Z (the sleepy 'z' text) as an open polyline, baseline at (x, y). */
function zContour(x, y, size) {
  const w = size * 0.58;
  const h = size * 0.68;
  const pts = [[x, y - h], [x + w, y - h], [x, y], [x + w, y]];
  return [{ closed: false, points: pts.map(([px, py]) => ({ x: px, y: py, inX: px, inY: py, outX: px, outY: py })) }];
}

function hex(c) {
  let h = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c || '')?.[1];
  if (!h) return null;
  if (h.length === 3) h = h.replace(/./g, (d) => d + d);
  return (0xff000000 | parseInt(h, 16)) >>> 0;
}

// ---------------------------------------------------------------------------------------------------------
// Tree → components
// ---------------------------------------------------------------------------------------------------------

const FUR = '#C98F5E';
const CURRENT_COLOR = { 'pet-zzz': '#8A9196', 'pet-steam': '#AEB8B6' };
// Hidden until a mood shows them (style.css hides the same parts).
const HIDDEN = new Set(['pet-eyes-happy', 'pet-eyes-sleep', 'pet-eyes-squeeze', 'pet-bubbles', 'pet-zzz', 'pet-sweat']);
const SETUP_OPACITY = { 'pet-blush': 0.4, 'pet-steam': 0.55 };
// Parts that move get a node at their pivot (style.css: transform-box fill-box, origin center).
const MOVES = new Set(['pet-head', 'pet-eyes', 'pet-eye', 'pet-ear-l', 'pet-ear-r', 'pet-mouth', 'pet-orange', 'pet-bubble',
  'pet-z', 'pet-sweat', 'pet-blush', 'pet-float', 'pet-float-2', 'pet-body', 'pet-steam-path']);

function bbox(el, hiddenToo = false) {
  const box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  const add = (x, y) => {
    box.x0 = Math.min(box.x0, x);
    box.y0 = Math.min(box.y0, y);
    box.x1 = Math.max(box.x1, x);
    box.y1 = Math.max(box.y1, y);
  };
  const walk = (node, t) => {
    const cls = classOf(node);
    if (!hiddenToo && HIDDEN.has(cls)) return;
    const a = node.attrs;
    const map = (x, y) => [t.x + x * t.scale, t.y + y * t.scale];
    if (node.tag === 'g') {
      const own = parseTransform(a.transform);
      const next = { x: t.x + own.x * t.scale, y: t.y + own.y * t.scale, scale: t.scale * own.scale };
      for (const c of node.children) walk(c, next);
    } else if (node.tag === 'ellipse' || node.tag === 'circle') {
      const cx = Number(a.cx || 0);
      const cy = Number(a.cy || 0);
      const rx = Number(a.rx ?? a.r);
      const ry = Number(a.ry ?? a.r);
      add(...map(cx - rx, cy - ry));
      add(...map(cx + rx, cy + ry));
    } else if (node.tag === 'path') {
      for (const c of pathContours(a.d)) for (const p of c.points) add(...map(p.x, p.y));
    } else if (node.tag === 'text') {
      for (const c of zContour(Number(a.x), Number(a.y), Number(a['font-size']))) for (const p of c.points) add(...map(p.x, p.y));
    }
  };
  walk(el, { x: 0, y: 0, scale: 1 });
  return box;
}

function classOf(el) {
  const list = (el.attrs.class || '').split(/\s+/).filter(Boolean);
  return list[list.length - 1] || '';
}

function pivotOf(el, cls) {
  const b = bbox(el, true);
  const cx = (b.x0 + b.x1) / 2;
  if (cls === 'pet-ear-l' || cls === 'pet-ear-r') return { x: cx, y: b.y0 + (b.y1 - b.y0) * 0.9 };
  if (cls === 'pet-body') return { x: cx, y: b.y1 };
  if (cls === 'pet-head') return { x: 0, y: 33 }; // the chin: squash, doze and wiggle from the bottom of the face
  return { x: cx, y: (b.y0 + b.y1) / 2 };
}

class ArtboardBuilder {
  constructor(name, width, height, objects) {
    this.objects = objects;
    this.count = 0;
    this.nodes = new Map();
    this.names = new Map();
    this.animations = [];
    this.add('Artboard', { name, width, height, originX: 0, originY: 0 });
  }

  add(type, props) {
    this.objects.push({ type, props });
    return this.count++;
  }

  unique(name) {
    const n = (this.names.get(name) || 0) + 1;
    this.names.set(name, n);
    return n === 1 ? name : `${name}-${n}`;
  }

  node(name, parentId, setup) {
    const props = { name, parentId, x: setup.x || 0, y: setup.y || 0, rotation: setup.rotation || undefined,
      scaleX: setup.scale !== undefined && setup.scale !== 1 ? setup.scale : undefined,
      scaleY: setup.scale !== undefined && setup.scale !== 1 ? setup.scale : undefined,
      opacity: setup.opacity !== undefined && setup.opacity !== 1 ? setup.opacity : undefined };
    const index = this.add('Node', props);
    this.nodes.set(name, { index, x: props.x, y: props.y, rotation: setup.rotation || 0, scale: setup.scale ?? 1, opacity: setup.opacity ?? 1 });
    return index;
  }

  shape(parentId, { x = 0, y = 0, rotation = 0, opacity = 1 }, geometry, paint) {
    const shape = this.add('Shape', { parentId, x, y, rotation: rotation || undefined, opacity: opacity !== 1 ? opacity : undefined });
    if (geometry.ellipse) {
      this.add('Ellipse', { parentId: shape, pathWidth: geometry.ellipse.w, pathHeight: geometry.ellipse.h });
    } else {
      for (const c of geometry.contours) {
        const pathId = this.add('PointsPath', { parentId: shape, isClosed: c.closed });
        for (const p of c.points) {
          const vin = { x: p.inX - p.x, y: p.inY - p.y };
          const vout = { x: p.outX - p.x, y: p.outY - p.y };
          this.add('CubicDetachedVertex', { parentId: pathId, vx: p.x, vy: p.y,
            inRotation: Math.atan2(vin.y, vin.x), inDistance: Math.hypot(vin.x, vin.y),
            outRotation: Math.atan2(vout.y, vout.x), outDistance: Math.hypot(vout.x, vout.y) });
        }
      }
    }
    if (paint.fill !== null) {
      const fill = this.add('Fill', { parentId: shape, fillRule: 0 });
      this.add('SolidColor', { parentId: fill, colorValue: paint.fill });
    }
    if (paint.stroke !== null) {
      const stroke = this.add('Stroke', { parentId: shape, thickness: paint.width, cap: ROUND, join: ROUND });
      this.add('SolidColor', { parentId: stroke, colorValue: paint.stroke });
    }
  }

  /** Emits an SVG element under `parentId`; `shift` is where the Rive parent's origin sits in the element's coordinates. */
  emit(el, parentId, shift, inherited, overrides) {
    const a = el.attrs;
    const style = { ...inherited };
    for (const k of ['fill', 'stroke', 'stroke-width', 'font-size']) if (a[k] !== undefined) style[k] = a[k];
    let cls = classOf(el);
    if (!cls && inherited.parentClass === 'pet-steam' && el.tag === 'path') cls = 'pet-steam-path';
    if (cls && CURRENT_COLOR[cls]) style.currentColor = CURRENT_COLOR[cls];
    style.parentClass = cls || inherited.parentClass;
    const opacity = overrides[cls] ?? (HIDDEN.has(cls) ? 0 : SETUP_OPACITY[cls] ?? (a.opacity !== undefined ? Number(a.opacity) : 1));

    if (el.tag === 'g') {
      let setup;
      let childShift;
      if (a.transform) {
        const t = parseTransform(a.transform);
        setup = { x: t.x - shift.x, y: t.y - shift.y, rotation: t.rotation, scale: t.scale };
        childShift = { x: 0, y: 0 };
      } else if (MOVES.has(cls)) {
        const p = pivotOf(el, cls);
        setup = { x: p.x - shift.x, y: p.y - shift.y };
        childShift = p;
      } else {
        setup = { x: 0, y: 0 };
        childShift = shift;
      }
      const id = this.node(this.unique(cls || 'group'), parentId, { ...setup, opacity });
      // Shapes listed first are drawn on top, so children go in reverse.
      for (const child of [...el.children].reverse()) this.emit(child, id, childShift, style, overrides);
      return;
    }

    const color = (v) => (v === 'currentColor' ? hex(style.currentColor) : hex(v));
    const paint = {
      fill: style.fill === undefined ? hex('#000000') : color(style.fill),
      stroke: style.stroke ? color(style.stroke) : null,
      width: Number(style['stroke-width'] || 1),
    };
    let geometry;
    let center;
    let rotation = 0;
    if (el.tag === 'ellipse' || el.tag === 'circle') {
      center = { x: Number(a.cx || 0), y: Number(a.cy || 0) };
      geometry = { ellipse: { w: 2 * Number(a.rx ?? a.r), h: 2 * Number(a.ry ?? a.r) } };
      rotation = parseTransform(a.transform).rotation; // always rotate(angle cx cy) about the center in pet.js
    } else if (el.tag === 'path') {
      geometry = { contours: pathContours(a.d) };
    } else if (el.tag === 'text') {
      geometry = { contours: zContour(Number(a.x), Number(a.y), Number(style['font-size'])) };
      paint.stroke = paint.fill;
      paint.width = Number(style['font-size']) * 0.17;
      paint.fill = null;
    } else {
      return;
    }

    let shapeParent = parentId;
    let origin = shift;
    if (MOVES.has(cls)) {
      const b = bbox(el, true);
      const p = center || { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 };
      shapeParent = this.node(this.unique(cls), parentId, { x: p.x - shift.x, y: p.y - shift.y, opacity });
      origin = p;
    }
    const local = (pt) => ({ x: pt.x - origin.x, y: pt.y - origin.y });
    if (geometry.contours) {
      geometry.contours = geometry.contours.map((c) => ({ closed: c.closed, points: c.points.map((p) => ({
        ...local(p), inX: p.inX - origin.x, inY: p.inY - origin.y, outX: p.outX - origin.x, outY: p.outY - origin.y })) }));
      this.shape(shapeParent, { opacity: shapeParent === parentId ? opacity : 1 }, geometry, paint);
    } else {
      const at = local(center);
      this.shape(shapeParent, { x: at.x, y: at.y, rotation, opacity: shapeParent === parentId ? opacity : 1 }, geometry, paint);
    }
  }

  base(name) {
    const n = this.nodes.get(name);
    if (!n) throw new Error(`no node ${name}`);
    return n;
  }
}

/** The squint (> <) covers whatever eyes the mood shows with two fur-coloured patches under it. */
function addEyePatches(tree) {
  const walk = (el) => {
    if (classOf(el) === 'pet-eyes-squeeze') {
      el.children.unshift(...[-16, 16].map((x) => ({ tag: 'ellipse', attrs: { cx: String(x), cy: '-12.5', rx: '6.4', ry: '6.8', fill: FUR }, children: [] })));
    }
    el.children.forEach(walk);
  };
  walk(tree);
  return tree;
}

// ---------------------------------------------------------------------------------------------------------
// Animations (baked: linear keyframes every few frames, so easing needs no interpolator objects)
// ---------------------------------------------------------------------------------------------------------

const ease = {
  linear: (t) => t,
  inOut: (t) => 0.5 - Math.cos(Math.PI * t) / 2,
  out: (t) => 1 - (1 - t) ** 3,
  in: (t) => t ** 3,
};
const bump = (t, period) => (1 - Math.cos((TAU * t) / period)) / 2; // 0 → 1 → 0 over a period

class Anim {
  constructor(ab, name, seconds, loop = LOOP) {
    this.ab = ab;
    this.name = name;
    this.frames = Math.round(seconds * FPS);
    this.loop = loop;
    this.tracks = new Map();
  }

  track(node, prop) {
    const key = `${node}\u0000${prop}`;
    if (!this.tracks.has(key)) this.tracks.set(key, { node, prop, keys: [] });
    return this.tracks.get(key).keys;
  }

  /** A constant. */
  hold(node, prop, value) {
    this.ab.base(node);
    this.track(node, prop).push([0, value]);
    return this;
  }

  /** Keys at times (seconds) with an easing per segment, sampled every 3 frames. */
  keys(node, prop, points, easing = ease.inOut) {
    this.ab.base(node);
    const out = this.track(node, prop);
    for (let i = 0; i < points.length; i += 1) {
      const [t, v] = points[i];
      const f = Math.round(t * FPS);
      out.push([f, v]);
      const next = points[i + 1];
      if (!next) break;
      const f1 = Math.round(next[0] * FPS);
      const e = Array.isArray(easing) ? easing[i] : easing;
      for (let g = f + 3; g < f1 - 1; g += 3) out.push([g, v + (next[1] - v) * e((g - f) / (f1 - f))]);
    }
    return this;
  }

  /** A function of time (seconds) sampled every 4 frames (15 a second) over the whole animation. */
  wave(node, prop, fn) {
    this.ab.base(node);
    const out = this.track(node, prop);
    for (let f = 0; f <= this.frames; f += 4) out.push([f, fn(f / FPS)]);
    if (this.frames % 4) out.push([this.frames, fn(this.frames / FPS)]);
    return this;
  }
}

const MOOD_SECONDS = { idle: 2, listening: 2, thinking: 1.8, talking: 0.9, happy: 1.8, sleepy: 3.2, oops: 1.6 };

/** One loop per mood. Every loop keys every part a mood changes, so switching moods always lands cleanly. */
function moodAnim(ab, mood) {
  const a = new Anim(ab, mood, MOOD_SECONDS[mood]);
  const on = (yes) => (yes ? 1 : 0);
  a.hold('pet-eyes', 'opacity', on(!['happy', 'sleepy'].includes(mood)));
  a.hold('pet-eyes-happy', 'opacity', on(mood === 'happy'));
  a.hold('pet-eyes-sleep', 'opacity', on(mood === 'sleepy'));
  a.hold('pet-bubbles', 'opacity', on(mood === 'thinking'));
  a.hold('pet-zzz', 'opacity', on(mood === 'sleepy'));
  for (const blush of ['pet-blush', 'pet-blush-2']) a.hold(blush, 'opacity', mood === 'happy' ? 0.75 : 0.4);

  const eyes = ab.base('pet-eyes');
  const [lookX, lookY] = { thinking: [1.5, -2.5], listening: [0.5, 2] }[mood] || [0, 0];
  a.hold('pet-eyes', 'x', eyes.x + lookX).hold('pet-eyes', 'y', eyes.y + lookY);

  const head = ab.base('pet-head');
  const tilt = { listening: 4, thinking: -3 }[mood] || 0;
  if (mood === 'happy') {
    a.wave('pet-head', 'rotation', (t) => 5 * DEG * Math.sin((TAU * t) / 0.9));
    a.wave('pet-head', 'y', (t) => head.y - 1.4 * Math.abs(Math.sin((TAU * t) / 0.9)));
  } else if (mood === 'sleepy') {
    a.wave('pet-head', 'rotation', (t) => -2 * DEG * bump(t, 3.2));
    a.wave('pet-head', 'y', (t) => head.y + 1.5 * bump(t, 3.2));
  } else if (mood === 'talking') {
    a.hold('pet-head', 'rotation', 0);
    a.wave('pet-head', 'y', (t) => head.y - 0.6 * bump(t, 0.9));
  } else {
    a.hold('pet-head', 'rotation', tilt * DEG).hold('pet-head', 'y', head.y);
  }

  if (mood === 'talking') a.wave('pet-mouth', 'scaleY', (t) => 1 + 0.7 * bump(t, 0.9));
  else a.hold('pet-mouth', 'scaleY', 1);

  const sweat = ab.base('pet-sweat');
  if (mood === 'oops') {
    a.wave('pet-sweat', 'opacity', (t) => { const p = t / 1.6; return p < 0.3 ? p / 0.3 : 1 - (p - 0.3) / 0.7; });
    a.wave('pet-sweat', 'y', (t) => sweat.y - 2 + 7 * ease.in(t / 1.6));
  } else {
    a.hold('pet-sweat', 'opacity', 0).hold('pet-sweat', 'y', sweat.y);
  }

  if (mood === 'thinking') {
    // Parts are named in drawing order front to back, so the smallest bubble (nearest the head) is the last one.
    ['pet-bubble-3', 'pet-bubble-2', 'pet-bubble'].forEach((name, k) => {
      const b = ab.base(name);
      const phase = (t) => ((((t - k * 0.3) % 1.8) + 1.8) % 1.8) / 1.8;
      a.wave(name, 'opacity', (t) => { const p = phase(t); return p < 0.3 ? p / 0.3 : p < 0.75 ? 1 : 1 - (p - 0.75) / 0.25; });
      a.wave(name, 'scaleX', (t) => { const p = phase(t); return p < 0.3 ? 0.3 + 0.7 * ease.out(p / 0.3) : 1 + 0.05 * Math.max(0, (p - 0.75) / 0.25); });
      a.wave(name, 'scaleY', (t) => { const p = phase(t); return p < 0.3 ? 0.3 + 0.7 * ease.out(p / 0.3) : 1 + 0.05 * Math.max(0, (p - 0.75) / 0.25); });
      a.wave(name, 'y', (t) => b.y - 3 * Math.max(0, (phase(t) - 0.75) / 0.25));
    });
  }
  if (mood === 'sleepy') {
    ['pet-z-3', 'pet-z-2', 'pet-z'].forEach((name, k) => {
      const z = ab.base(name);
      const phase = (t) => ((((t - k * 1.07) % 3.2) + 3.2) % 3.2) / 3.2;
      a.wave(name, 'opacity', (t) => { const p = phase(t); return p < 0.3 ? p / 0.3 : 1 - (p - 0.3) / 0.7; });
      a.wave(name, 'x', (t) => z.x - 2 + 6 * phase(t));
      a.wave(name, 'y', (t) => z.y + 3 - 9 * phase(t));
    });
  }
  return a;
}

/** Always on: two blinks, the orange bobbing, an ear twitch each side; the welcome capybara also breathes. */
function lifeAnim(ab, { breathe = false } = {}) {
  const a = new Anim(ab, 'life', 7);
  for (const eye of ['pet-eye', 'pet-eye-2']) {
    a.keys(eye, 'scaleY', [[0, 1], [2.15, 1], [2.22, 0.1], [2.3, 1], [5.55, 1], [5.62, 0.1], [5.7, 1], [7, 1]], ease.linear);
  }
  const orange = ab.base('pet-orange');
  a.wave('pet-orange', 'y', (t) => orange.y - 1.6 * bump(t, 3.5));
  a.wave('pet-orange', 'rotation', (t) => -7 * DEG * bump(t, 3.5));
  const twitch = (at, dir) => [[0, 0], [at, 0], [at + 0.08, -16 * dir * DEG], [at + 0.15, 4 * dir * DEG], [at + 0.22, -8 * dir * DEG], [at + 0.3, 0], [7, 0]];
  a.keys('pet-ear-r', 'rotation', twitch(6.3, 1), ease.linear);
  a.keys('pet-ear-l', 'rotation', twitch(3.4, -1), ease.linear);
  if (breathe) a.wave('pet-body', 'scaleY', (t) => 1 + 0.015 * bump(t, 3.5));
  return a;
}

/** A tap: it squashes, the orange pops off, falls beside it, and hops back on; > < while it happens. */
function pokeAnim(ab) {
  const a = new Anim(ab, 'poke', 1.5, ONE_SHOT);
  const o = ab.base('pet-orange');
  const at = [0, 0.21, 0.6, 0.87, 1.17, 1.35, 1.5];
  const segEase = [ease.out, ease.in, ease.linear, ease.out, ease.inOut, ease.inOut];
  const dx = [0, 3, 30, 30, 6, 0, 0];
  const dy = [0, -12, 42, 42, -16, 2, 0];
  const rot = [0, 30, 200, 200, 20, -6, 0];
  a.keys('pet-orange', 'x', at.map((t, i) => [t, o.x + dx[i]]), segEase);
  a.keys('pet-orange', 'y', at.map((t, i) => [t, o.y + dy[i]]), segEase);
  a.keys('pet-orange', 'rotation', at.map((t, i) => [t, rot[i] * DEG]), segEase);
  a.keys('pet-eyes-squeeze', 'opacity', [[0, 0], [0.08, 1], [0.78, 1], [0.86, 0], [1.5, 0]], ease.linear);
  a.keys('pet-head', 'scaleX', [[0, 1], [0.16, 1.06], [0.32, 0.98], [0.45, 1], [1.5, 1]]);
  a.keys('pet-head', 'scaleY', [[0, 1], [0.16, 0.92], [0.32, 1.03], [0.45, 1], [1.5, 1]]);
  return a;
}

/** The hot spring: steam rising, the oranges bobbing, Nana soaking. */
function soakAnim(ab) {
  const a = new Anim(ab, 'soak', 3.4);
  const head = ab.base('pet-head');
  a.wave('pet-head', 'y', (t) => head.y + 2 * bump(t, 3.4));
  ['pet-steam-path', 'pet-steam-path-2', 'pet-steam-path-3'].forEach((name, k) => {
    const s = ab.base(name);
    const phase = (t) => ((((t - k * 1.13) % 3.4) + 3.4) % 3.4) / 3.4;
    a.wave(name, 'y', (t) => s.y + 6 - 16 * phase(t));
    a.wave(name, 'opacity', (t) => { const p = phase(t); return p < 0.3 ? 0.9 * (p / 0.3) : 0.9 * (1 - (p - 0.3) / 0.7); });
  });
  ['pet-float', 'pet-float-2'].forEach((name, k) => {
    const f = ab.base(name);
    a.wave(name, 'y', (t) => f.y - 2 * bump(t + k * 0.85, 1.7));
    a.wave(name, 'rotation', (t) => 8 * DEG * bump(t + k * 0.85, 1.7));
  });
  return a;
}

function emitAnimation(ab, anim) {
  ab.objects.push({ type: 'LinearAnimation', props: { animName: anim.name, fps: FPS, duration: anim.frames, speed: 1, loopValue: anim.loop } });
  const byNode = new Map();
  for (const t of anim.tracks.values()) {
    if (!byNode.has(t.node)) byNode.set(t.node, []);
    byNode.get(t.node).push(t);
  }
  for (const [node, tracks] of byNode) {
    ab.objects.push({ type: 'KeyedObject', props: { objectId: ab.base(node).index } });
    for (const t of tracks) {
      ab.objects.push({ type: 'KeyedProperty', props: { propertyKey: KEYABLE[t.prop] } });
      const keys = [...t.keys].sort((p, q) => p[0] - q[0]).filter((k, i, all) => i === 0 || k[0] !== all[i - 1][0]);
      for (const [frame, v] of keys) {
        ab.objects.push({ type: 'KeyFrameDouble', props: { frame: Math.min(frame, anim.frames), interpolationType: LINEAR, value: v } });
      }
    }
  }
  ab.animations.push(anim.name);
}

/**
 * State machine "pet": inputs mood (0) and poke (1). Each layer lists entry, any, exit, then its animation states;
 * a transition follows its state and a condition its transition.
 */
function emitStateMachine(ab, layers) {
  const objects = ab.objects;
  const anim = (name) => ab.animations.indexOf(name);
  objects.push({ type: 'StateMachine', props: { animName: 'pet' } });
  objects.push({ type: 'StateMachineNumber', props: { inputName: 'mood', numberValue: 0 } });
  objects.push({ type: 'StateMachineTrigger', props: { inputName: 'poke' } });
  for (const layer of layers) {
    const stateIndex = (name) => 3 + layer.states.indexOf(name);
    objects.push({ type: 'StateMachineLayer', props: { inputName: layer.name } });
    objects.push({ type: 'EntryState', props: {} });
    objects.push({ type: 'StateTransition', props: { stateToId: stateIndex(layer.entry) } });
    objects.push({ type: 'AnyState', props: {} });
    for (const t of layer.fromAny || []) {
      objects.push({ type: 'StateTransition', props: { stateToId: stateIndex(t.to), mixMs: t.mixMs } });
      objects.push({ type: 'TransitionNumberCondition', props: { inputId: 0, opValue: 0, conditionValue: t.mood } });
    }
    objects.push({ type: 'ExitState', props: {} });
    for (const name of layer.states) {
      objects.push({ type: 'AnimationState', props: { animationId: anim(name) } });
      for (const t of (layer.transitions || []).filter((x) => x.from === name)) {
        objects.push({ type: 'StateTransition', props: { stateToId: stateIndex(t.to), ...(t.atEnd ? EXIT_AT_END : {}) } });
        if (t.trigger) objects.push({ type: 'TransitionTriggerCondition', props: { inputId: 1 } });
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------------------
// Artboards
// ---------------------------------------------------------------------------------------------------------

function buildArtboard(objects, name, { overrides = {}, kind }) {
  const { view, box } = PET_ARTBOARDS[name];
  const [x0, y0, w, h] = box;
  const ab = new ArtboardBuilder(name, w, h, objects);
  const tree = addEyePatches(parseSvg(petMarkup(view)));
  const root = ab.node('pet', 0, { x: -x0, y: -y0 });
  for (const child of [...tree.children].reverse()) ab.emit(child, root, { x: 0, y: 0 }, {}, overrides);

  if (kind === 'onsen') {
    emitAnimation(ab, soakAnim(ab));
    emitStateMachine(ab, [{ name: 'soak', entry: 'soak', states: ['soak'] }]);
    return;
  }
  const rest = new Anim(ab, 'rest', 1);
  for (const mood of PET_MOODS) emitAnimation(ab, moodAnim(ab, mood));
  emitAnimation(ab, lifeAnim(ab, { breathe: kind === 'body' }));
  emitAnimation(ab, rest);
  emitAnimation(ab, pokeAnim(ab));
  emitStateMachine(ab, [
    { name: 'mood', entry: 'idle', states: PET_MOODS, fromAny: PET_MOODS.map((m, i) => ({ to: m, mood: i, mixMs: 250 })) },
    { name: 'life', entry: 'life', states: ['life'] },
    { name: 'poke', entry: 'rest', states: ['rest', 'poke'],
      transitions: [{ from: 'rest', to: 'poke', trigger: true }, { from: 'poke', to: 'rest', atEnd: true }] },
  ]);
}

/** The whole file. */
export function buildPetRiv() {
  const objects = [{ type: 'Backboard', props: {} }];
  buildArtboard(objects, 'Head', { kind: 'head' });
  buildArtboard(objects, 'Body', { kind: 'body' });
  buildArtboard(objects, 'Onsen', { kind: 'onsen', overrides: { 'pet-eyes': 0, 'pet-eyes-happy': 1, 'pet-blush': 0.75 } });
  return encode(objects);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const bytes = buildPetRiv();
  await mkdir(path.dirname(OUT), { recursive: true });
  await writeFile(OUT, bytes);
  console.log(`${path.relative(process.cwd(), OUT)}: ${bytes.length} bytes`);
}
