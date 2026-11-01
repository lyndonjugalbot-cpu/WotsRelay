import { useEffect, useRef } from 'react';
import * as THREE from 'three';

interface Props {
  active: 'A' | 'B' | null;
  running: boolean;
  // Changes whenever a provider switch happens; triggers the baton exchange.
  handoffKey: string | null;
  handoffTo: 'A' | 'B' | null;
}

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// A small, on-demand WebGL scene: two route nodes on an arced filament. It renders only on
// state changes, while a run is live (slow breathing), and during a baton exchange.
export function RelayCore({ active, running, handoffKey, handoffTo }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const api = useRef<{ setState: (p: Props) => void; exchange: (to: 'A' | 'B') => void; dispose: () => void } | null>(null);

  useEffect(() => {
    const el = host.current!;
    const w = el.clientWidth || 228;
    const h = el.clientHeight || 112;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(w, h);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    el.appendChild(renderer.domElement);
    renderer.domElement.setAttribute('aria-hidden', 'true');

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(32, w / h, 0.1, 50);
    camera.position.set(0, 1.5, 5.6);
    camera.lookAt(0, 0.1, 0);

    scene.add(new THREE.HemisphereLight(0xffffff, 0x223344, 1.4));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(2, 4, 3);
    scene.add(key);

    const A = new THREE.Vector3(-1.75, 0, 0);
    const B = new THREE.Vector3(1.75, 0, 0);
    const curve = new THREE.CatmullRomCurve3([A, new THREE.Vector3(-0.9, 0.62, 0), new THREE.Vector3(0.9, 0.62, 0), B]);

    const filamentMat = new THREE.MeshStandardMaterial({ color: css('--hairline'), roughness: 0.5, metalness: 0.1, transparent: true, opacity: 0.9 });
    const filament = new THREE.Mesh(new THREE.TubeGeometry(curve, 64, 0.022, 8, false), filamentMat);
    scene.add(filament);

    // Soft radial glow used as an additive halo behind the active node.
    const haloTexture = (() => {
      const c = document.createElement('canvas');
      c.width = c.height = 128;
      const g = c.getContext('2d')!;
      const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
      grad.addColorStop(0, 'rgba(255,255,255,0.9)');
      grad.addColorStop(0.35, 'rgba(255,255,255,0.35)');
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grad;
      g.fillRect(0, 0, 128, 128);
      const t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.SRGBColorSpace;
      return t;
    })();
    const idleTint = new THREE.Color(css('--graphite'));

    const makeNode = (pos: THREE.Vector3, colorVar: string) => {
      const color = new THREE.Color(css(colorVar));
      const mat = new THREE.MeshPhysicalMaterial({ color, roughness: 0.28, metalness: 0.1, clearcoat: 1, clearcoatRoughness: 0.2, emissive: color, emissiveIntensity: 0.05 });
      const node = new THREE.Mesh(new THREE.IcosahedronGeometry(0.36, 4), mat);
      node.position.copy(pos);
      const haloMat = new THREE.SpriteMaterial({ map: haloTexture, color, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
      const halo = new THREE.Sprite(haloMat);
      halo.position.copy(pos);
      halo.scale.setScalar(1.9);
      const ringMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.0, side: THREE.DoubleSide, depthWrite: false });
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.5, 0.54, 64), ringMat);
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(pos.x, -0.42, pos.z);
      scene.add(halo, node, ring);
      return { node, mat, ring, ringMat, haloMat, base: color.clone() };
    };
    const nodeA = makeNode(A, '--lane-a');
    const nodeB = makeNode(B, '--lane-b');

    const batonMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.8, roughness: 0.2 });
    const baton = new THREE.Mesh(new THREE.CapsuleGeometry(0.07, 0.22, 6, 12), batonMat);
    baton.visible = false;
    scene.add(baton);

    let state: Props = { active: null, running: false, handoffKey: null, handoffTo: null };
    let raf = 0;
    let exchangeStart = -1;
    let exchangeTo: 'A' | 'B' = 'B';
    const EXCHANGE_MS = 1300;

    const applyLook = (t: number) => {
      for (const [id, n] of [['A', nodeA], ['B', nodeB]] as const) {
        const on = state.active === id || state.active === null;
        const breathe = state.active === id && state.running && !reducedMotion() ? 0.5 + 0.5 * Math.sin(t / 520) : 0;
        // The idle node recedes: desaturated toward graphite, smaller, no glow.
        n.mat.color.copy(n.base).lerp(idleTint, on ? 0 : 0.6);
        n.mat.emissive.copy(n.mat.color);
        n.mat.emissiveIntensity = state.active === id ? 0.45 + 0.25 * breathe : 0.03;
        n.haloMat.opacity = state.active === id ? 0.45 + 0.25 * breathe : 0;
        n.ringMat.opacity = state.active === id ? 0.6 : 0;
        n.node.scale.setScalar(state.active === id ? 1.08 : on ? 0.95 : 0.78);
      }
    };

    const frame = (t: number) => {
      raf = 0;
      applyLook(t);
      let keepGoing = state.running && !reducedMotion();
      if (exchangeStart >= 0) {
        const k = Math.min(1, (t - exchangeStart) / EXCHANGE_MS);
        const e = k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2; // easeInOutCubic
        const u = exchangeTo === 'B' ? e : 1 - e;
        const p = curve.getPointAt(u);
        const tangent = curve.getTangentAt(u);
        baton.position.copy(p);
        baton.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), tangent);
        baton.visible = true;
        filamentMat.color.set(css(exchangeTo === 'B' ? '--lane-b' : '--lane-a'));
        filamentMat.opacity = 0.6 + 0.4 * Math.sin(Math.PI * k);
        if (k >= 1) {
          exchangeStart = -1;
          baton.visible = false;
          filamentMat.color.set(css('--hairline'));
          filamentMat.opacity = 0.9;
        } else keepGoing = true;
      }
      renderer.render(scene, camera);
      if (keepGoing) raf = requestAnimationFrame(frame);
    };
    const kick = () => {
      if (!raf) raf = requestAnimationFrame(frame);
    };

    const onTheme = () => {
      for (const [n, v] of [[nodeA, '--lane-a'], [nodeB, '--lane-b']] as const) {
        n.base.set(css(v));
        n.ringMat.color.set(css(v));
        n.haloMat.color.set(css(v));
      }
      idleTint.set(css('--graphite'));
      filamentMat.color.set(css('--hairline'));
      kick();
    };
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', onTheme);
    const themeObserver = new MutationObserver(onTheme);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    api.current = {
      setState: (p) => {
        state = p;
        kick();
      },
      exchange: (to) => {
        exchangeTo = to;
        if (reducedMotion()) {
          state = { ...state, active: to };
          kick();
          return;
        }
        exchangeStart = performance.now();
        kick();
      },
      dispose: () => {
        cancelAnimationFrame(raf);
        mq.removeEventListener('change', onTheme);
        themeObserver.disconnect();
        renderer.dispose();
        haloTexture.dispose();
        scene.traverse((o) => {
          const m = o as THREE.Mesh;
          m.geometry?.dispose();
          (m.material as THREE.Material | undefined)?.dispose?.();
        });
        el.removeChild(renderer.domElement);
      },
    };
    kick();
    return () => api.current?.dispose();
  }, []);

  useEffect(() => {
    api.current?.setState({ active, running, handoffKey, handoffTo });
  }, [active, running, handoffKey, handoffTo]);

  const seen = useRef<string | null>(handoffKey);
  useEffect(() => {
    if (handoffKey && handoffKey !== seen.current && handoffTo) api.current?.exchange(handoffTo);
    seen.current = handoffKey;
  }, [handoffKey, handoffTo]);

  return <div className="relay-core" ref={host} />;
}
