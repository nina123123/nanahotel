// The animated pet: 小宿 as a Rive animation (public/art/xiaosu.riv, built by tools/build-pet-riv.mjs from pet.js's
// drawing), played by the Rive web runtime vendored in public/vendor/rive (@rive-app/canvas-lite, MIT), so nothing
// comes from a CDN. Loading starts once the page is up. Until it is ready, and wherever it cannot run (no
// WebAssembly, reduced motion, a load error), the SVG pet from pet.js stays, so the page never depends on it.
import { PET_ARTBOARDS, PET_MOODS } from './pet.js';

const BASE = new URL('./', import.meta.url);

let loading = null;
let loaded = null;

/** Loads the runtime and the file once; resolves true when Rive pets can be mounted, false when they cannot. */
export function loadRivePet() {
  if (!loading) {
    loading = load().then((value) => {
      loaded = value;
      return true;
    }, () => false);
  }
  return loading;
}

export const rivePetReady = () => loaded !== null;

async function load() {
  if (typeof WebAssembly !== 'object' || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    throw new Error('the SVG pet is enough here');
  }
  await loadScript(new URL('vendor/rive/rive.js', BASE).href);
  const { rive } = globalThis;
  rive.RuntimeLoader.setWasmUrl(new URL('vendor/rive/rive.wasm', BASE).href);
  rive.RuntimeLoader.setWasmFallbackUrl(new URL('vendor/rive/rive_fallback.wasm', BASE).href);
  rive.Rive.suppressDeprecationWarnings = ['state-machine-inputs'];
  const res = await fetch(new URL('art/xiaosu.riv', BASE));
  if (!res.ok) throw new Error(`xiaosu.riv: ${res.status}`);
  const file = new rive.RiveFile({ buffer: await res.arrayBuffer() });
  await file.init();
  return { rive, file };
}

function loadScript(src) {
  if (globalThis.rive) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    el.async = true;
    el.onload = () => resolve();
    el.onerror = () => reject(new Error(`could not load ${src}`));
    document.head.append(el);
  });
}

/**
 * Plays an artboard (Head, Body or Onsen) in a canvas laid exactly over the SVG pet inside `host`: same scale, same
 * spot, just more room around it. The SVG hides once the canvas shows (not before `showAfter` ms, so an SVG
 * entrance can finish first) and comes back if the canvas goes. Returns a controller, kept as host.petRive, or
 * null when Rive is not ready.
 */
export function mountRivePet(host, artboard, { mood = 'idle', showAfter = 0 } = {}) {
  if (host.petRive) return host.petRive;
  const svg = host.querySelector('svg.pet');
  if (!loaded || !svg) return null;
  const { rive, file } = loaded;
  let frame = svg.parentElement;
  if (!frame.classList.contains('pet-frame')) {
    frame = document.createElement('span');
    frame.className = 'pet-frame';
    svg.replaceWith(frame);
    frame.append(svg);
  }
  const canvas = document.createElement('canvas');
  canvas.className = 'pet-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  frame.append(canvas);

  // Where the SVG draws its units (contain fit, centered) → where the artboard's box goes, in px within the frame.
  const place = () => {
    const style = getComputedStyle(svg);
    const w = parseFloat(style.width);
    const h = parseFloat(style.height);
    const vb = svg.viewBox.baseVal;
    if (!(w > 0 && h > 0 && vb.width > 0)) return;
    const scale = Math.min(w / vb.width, h / vb.height);
    const ox = (w - vb.width * scale) / 2 - vb.x * scale;
    const oy = (h - vb.height * scale) / 2 - vb.y * scale;
    const [bx, by, bw, bh] = PET_ARTBOARDS[artboard].box;
    Object.assign(canvas.style, { left: `${ox + bx * scale}px`, top: `${oy + by * scale}px`, width: `${bw * scale}px`, height: `${bh * scale}px` });
  };
  place();

  let inputs = {};
  let wanted = mood;
  let dead = false;
  let loadedAt = 0;
  const shownAt = performance.now() + showAfter;
  const show = () => {
    if (!dead) frame.classList.add('has-rive');
  };
  const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(() => {
    place();
    if (loadedAt) instance.resizeDrawingSurfaceToCanvas();
  }) : null;
  resize?.observe(frame);

  const ctl = {
    artboard,
    mood(name) {
      wanted = name;
      const value = PET_MOODS.indexOf(name);
      if (inputs.mood && value >= 0) inputs.mood.value = value;
    },
    moodValue: () => (inputs.mood ? inputs.mood.value : null),
    shown: () => frame.classList.contains('has-rive'),
    poke() {
      inputs.poke?.fire();
    },
    pause() {
      if (!dead) instance.pause();
    },
    destroy() {
      if (dead) return;
      dead = true;
      resize?.disconnect();
      try {
        instance.cleanup();
      } catch {
        // already gone
      }
      canvas.remove();
      frame.classList.remove('has-rive');
      if (host.petRive === ctl) host.petRive = null;
    },
  };
  const instance = new rive.Rive({
    riveFile: file,
    canvas,
    artboard,
    stateMachine: 'pet',
    autoplay: true,
    shouldDisableRiveListeners: true,
    isTouchScrollEnabled: true,
    layout: new rive.Layout({ fit: rive.Fit.Contain, alignment: rive.Alignment.Center }),
    onLoad: () => {
      if (dead) return;
      loadedAt = performance.now();
      place();
      instance.resizeDrawingSurfaceToCanvas();
      inputs = Object.fromEntries((instance.stateMachineInputs('pet') || []).map((i) => [i.name, i]));
      ctl.mood(wanted);
      setTimeout(show, Math.max(0, shownAt - loadedAt));
    },
    onLoadError: () => ctl.destroy(),
  });
  host.petRive = ctl;
  return ctl;
}
