/* One reusable modal host for the app. Works where window.prompt / window.confirm
 * are disabled (VS Code webview, some in-app browsers). A modal is a backdrop +
 * card appended to <body>; it closes on outside pointerdown, Escape, route
 * change, or an explicit close() call. By default the card is centred and the
 * backdrop dims + captures. Pass `anchor` for a light-dismiss popover positioned
 * next to an element (transparent, click-through backdrop). */

export interface Modal {
  close: () => void;
}

export function openModal(
  content: HTMLElement,
  opts: {
    onClose?: () => void;
    dismissable?: boolean;
    anchor?: HTMLElement;
    /** anchored only: called after each (re)position — at open and on viewport changes */
    onReposition?: () => void;
  } = {}
): Modal {
  const { onClose, dismissable = true, anchor, onReposition } = opts;

  const backdrop = document.createElement('div');
  backdrop.className = anchor ? 'modal-backdrop modal-backdrop--anchored' : 'modal-backdrop';
  const card = document.createElement('div');
  card.className = anchor ? 'modal-card modal-card--anchored' : 'modal-card';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  card.append(content);
  backdrop.append(card);

  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('pointerdown', onOutside, true);
    window.removeEventListener('hashchange', close);
    window.removeEventListener('resize', reflow);
    window.removeEventListener('orientationchange', reflow);
    backdrop.remove();
    onClose?.();
  };

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && dismissable) {
      e.stopPropagation();
      close();
    }
  };
  const onOutside = (e: Event): void => {
    if (dismissable && !card.contains(e.target as Node)) close();
  };
  const reflow = (): void => {
    if (closed || !anchor) return;
    placeByAnchor(card, anchor);
    onReposition?.();
  };

  if (anchor) {
    // click-through backdrop: dismiss via a document listener so the tap also
    // reaches whatever is underneath (e.g. a tool button).
    document.addEventListener('pointerdown', onOutside, true);
    window.addEventListener('resize', reflow);
    window.addEventListener('orientationchange', reflow);
  } else {
    backdrop.addEventListener('pointerdown', (e) => {
      if (e.target === backdrop && dismissable) close();
    });
  }
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('hashchange', close);
  document.body.append(backdrop);
  if (anchor) reflow();
  requestAnimationFrame(() =>
    card.querySelector<HTMLElement>('input, button, select, textarea')?.focus()
  );

  return { close };
}

/** Positions `card` (fixed) just below `anchor`, flipping above / clamping to the viewport. */
function placeByAnchor(card: HTMLElement, anchor: HTMLElement): void {
  const a = anchor.getBoundingClientRect();
  const m = 8;
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  const cw = card.offsetWidth;
  const ch = card.offsetHeight;

  let left = a.left + a.width / 2 - cw / 2;
  left = Math.max(m, Math.min(left, vw - cw - m));

  let top = a.bottom + m;
  if (top + ch > vh - m && a.top - m - ch >= m) top = a.top - m - ch;
  top = Math.max(m, Math.min(top, vh - ch - m));

  card.style.left = `${Math.round(left)}px`;
  card.style.top = `${Math.round(top)}px`;
}

/** Replacement for window.prompt(). Resolves to the entered string, or null if cancelled. */
export function textPrompt(opts: {
  title: string;
  label?: string;
  value?: string;
  placeholder?: string;
  confirmText?: string;
}): Promise<string | null> {
  return new Promise((resolve) => {
    const form = document.createElement('form');
    form.className = 'dlg';
    form.innerHTML = `
      <h2 class="dlg__title"></h2>
      <label class="dlg__label"></label>
      <input class="dlg__input" type="text" autocomplete="off" />
      <div class="dlg__row">
        <button type="button" class="dlg__cancel">Cancel</button>
        <button type="submit" class="primary dlg__ok"></button>
      </div>`;

    (form.querySelector('.dlg__title') as HTMLElement).textContent = opts.title;
    const labelEl = form.querySelector('.dlg__label') as HTMLElement;
    if (opts.label) labelEl.textContent = opts.label;
    else labelEl.remove();
    const input = form.querySelector('.dlg__input') as HTMLInputElement;
    input.value = opts.value ?? '';
    if (opts.placeholder) input.placeholder = opts.placeholder;
    (form.querySelector('.dlg__ok') as HTMLElement).textContent = opts.confirmText ?? 'OK';

    let settled = false;
    const finish = (v: string | null): void => {
      if (settled) return;
      settled = true;
      resolve(v);
      modal.close();
    };
    const modal = openModal(form, {
      onClose: () => {
        if (!settled) {
          settled = true;
          resolve(null);
        }
      },
    });

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      finish(input.value.trim());
    });
    (form.querySelector('.dlg__cancel') as HTMLElement).addEventListener('click', () => finish(null));
    requestAnimationFrame(() => {
      input.focus();
      input.select();
    });
  });
}

/** Replacement for window.confirm(). Resolves true only if the confirm button is pressed. */
export function confirmDialog(opts: {
  title: string;
  message?: string;
  confirmText?: string;
  danger?: boolean;
}): Promise<boolean> {
  return new Promise((resolve) => {
    const box = document.createElement('div');
    box.className = 'dlg';
    box.innerHTML = `
      <h2 class="dlg__title"></h2>
      <p class="dlg__msg"></p>
      <div class="dlg__row">
        <button type="button" class="dlg__cancel">Cancel</button>
        <button type="button" class="dlg__ok"></button>
      </div>`;

    (box.querySelector('.dlg__title') as HTMLElement).textContent = opts.title;
    const msg = box.querySelector('.dlg__msg') as HTMLElement;
    if (opts.message) msg.textContent = opts.message;
    else msg.remove();
    const ok = box.querySelector('.dlg__ok') as HTMLButtonElement;
    ok.textContent = opts.confirmText ?? 'OK';
    ok.classList.add(opts.danger ? 'danger' : 'primary');

    let settled = false;
    const finish = (v: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(v);
      modal.close();
    };
    const modal = openModal(box, {
      onClose: () => {
        if (!settled) {
          settled = true;
          resolve(false);
        }
      },
    });
    ok.addEventListener('click', () => finish(true));
    (box.querySelector('.dlg__cancel') as HTMLElement).addEventListener('click', () => finish(false));
  });
}

/** Replacement for window.alert(). Resolves when dismissed. */
export function alertDialog(opts: {
  title: string;
  message?: string;
  confirmText?: string;
}): Promise<void> {
  return new Promise((resolve) => {
    const box = document.createElement('div');
    box.className = 'dlg';
    box.innerHTML = `
      <h2 class="dlg__title"></h2>
      <p class="dlg__msg"></p>
      <div class="dlg__row">
        <button type="button" class="primary dlg__ok"></button>
      </div>`;

    (box.querySelector('.dlg__title') as HTMLElement).textContent = opts.title;
    const msg = box.querySelector('.dlg__msg') as HTMLElement;
    if (opts.message) msg.textContent = opts.message;
    else msg.remove();
    (box.querySelector('.dlg__ok') as HTMLElement).textContent = opts.confirmText ?? 'OK';

    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolve();
      modal.close();
    };
    const modal = openModal(box, { onClose: finish });
    (box.querySelector('.dlg__ok') as HTMLElement).addEventListener('click', finish);
  });
}
