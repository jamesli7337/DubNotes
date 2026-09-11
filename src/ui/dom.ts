type Attrs = Record<string, unknown>;

/** Tiny hyperscript helper. `class`/`text` are special; `onX` attaches a listener. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = String(v);
    else if (k === 'text') node.textContent = String(v);
    else if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2), v as EventListener);
    } else {
      node.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const c of children) node.append(c);
  return node;
}

/** Suppresses iOS callout / selection / pinch-zoom gestures on a surface. */
export function blockGestures(target: HTMLElement): void {
  const stop = (e: Event) => e.preventDefault();
  target.addEventListener('contextmenu', stop);
  target.addEventListener('gesturestart', stop);
  target.addEventListener('gesturechange', stop);
}
