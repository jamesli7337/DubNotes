import { exportAll, importAll } from '../db';
import { IMPORT_ACCEPT, importFile } from '../import-file';
import { DEFAULT_PAPER } from '../const';
import { store, type FolderItem } from '../store';
import type { Backup, Divider, Folder, Notebook, NotebookCover, Paper, PaperColor, PaperSpacing, PaperTemplate } from '../types';
import { download, timestamp } from '../util';
import { COVER_COLORS, COVER_PATTERNS, coverBackground } from './covers';
import { alertDialog, confirmDialog, openAnchoredModal, openModal, textPrompt, type Modal } from './dialog';
import { el } from './dom';
import { icon, type IconName } from './icon';
import { lazyThumb } from './thumb';

/** Which folder rows are expanded in the tree (remembered per device). */
const OPEN_KEY = 'noteapp.folders.open';

/**
 * The library screen for one folder (`null` = the root): a folder tree at the
 * top, then that folder's notebooks and dividers in their manual order.
 */
export function mountLibrary(root: HTMLElement, folderId: string | null): void {
  const folder = folderId ? store.folders.get(folderId) ?? null : null;
  const wrap = el('div', { class: 'lib' });
  wrap.append(buildHeader(folder), buildMain(root, folder), buildFab(root, folder));
  root.replaceChildren(wrap);
}

const rerender = (root: HTMLElement, folder: Folder | null): void => mountLibrary(root, folder?.id ?? null);
const folderHash = (id: string | null): string => (id ? `#/f/${id}` : '#/');

// ------------------------------------------------------------------- header
function buildHeader(folder: Folder | null): HTMLElement {
  const header = el('header', { class: 'app-header' });

  const brand = el('div', { class: 'app-header__brand' });
  const mark = el('div', { class: 'app-header__mark' });
  mark.append(icon('book'));
  const titles = el('div', { class: 'app-header__titles' });
  titles.append(
    el('span', { class: 'app-header__title', text: folder ? folder.name : 'DubNotes' }),
    el('span', { class: 'app-header__sub', text: folder ? 'Folder' : 'Notes Library' })
  );
  brand.append(mark, titles);

  const actions = el('div', { class: 'app-header__actions' });

  const exportBtn = el('button', { class: 'lib-hdrbtn', title: 'Export backup', 'aria-label': 'Export backup' });
  exportBtn.append(icon('export'), el('span', { class: 'lib-hdrbtn__label', text: 'Export' }));
  exportBtn.addEventListener('click', async () => {
    const data = await exportAll();
    download(`noteapp-backup-${timestamp()}.json`, JSON.stringify(data));
  });

  const importInput = el('input', {
    type: 'file',
    accept: 'application/json,.json',
    style: 'display:none',
  }) as HTMLInputElement;
  const importBtn = el('button', { class: 'lib-hdrbtn', title: 'Import backup', 'aria-label': 'Import backup' });
  importBtn.append(icon('import'), el('span', { class: 'lib-hdrbtn__label', text: 'Restore' }));
  importBtn.addEventListener('click', () => importInput.click());
  importInput.addEventListener('change', async () => {
    const file = importInput.files?.[0];
    importInput.value = '';
    if (!file) return;
    try {
      const backup = JSON.parse(await file.text()) as Backup;
      const ok = await confirmDialog({
        title: 'Import backup?',
        message: 'This replaces all current notebooks.',
        confirmText: 'Import',
        danger: true,
      });
      if (!ok) return;
      await importAll(backup);
      location.hash = '#/';
      location.reload();
    } catch (err) {
      await alertDialog({ title: 'Import failed', message: (err as Error).message || undefined });
    }
  });

  // Import file: the native Files picker (Google Drive included when it's a Files
  // location) → a new notebook; a PDF becomes one page per PDF page. The same
  // path serves files shared into the app (see import-file.ts / sw.js).
  const fileInput = el('input', {
    type: 'file',
    accept: IMPORT_ACCEPT,
    style: 'display:none',
  }) as HTMLInputElement;
  const fileBtn = el('button', { class: 'lib-hdrbtn', title: 'Import file', 'aria-label': 'Import file' });
  fileBtn.append(icon('import'), el('span', { class: 'lib-hdrbtn__label', text: 'Import' }));
  fileBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    await importFile(file, folder?.id ?? null);
  });

  actions.append(fileBtn, exportBtn, importBtn, importInput, fileInput);
  header.append(brand, actions);
  return header;
}

// --------------------------------------------------------------------- main
/** Below the header: a folder-navigation sidebar plus the scrolling content area. */
function buildMain(root: HTMLElement, folder: Folder | null): HTMLElement {
  const main = el('div', { class: 'lib-main' });
  main.append(buildSidebar(root, folder), buildContent(root, folder));
  return main;
}

function buildSidebar(root: HTMLElement, folder: Folder | null): HTMLElement {
  const sidebar = el('aside', { class: 'lib-sidebar' });
  sidebar.append(el('div', { class: 'section-label', text: 'Library' }), buildTree(root, folder));

  const persist = el('p', { class: 'lib-persist', text: 'Notes are stored on this device.' });
  navigator.storage
    ?.persisted?.()
    .then((p) => {
      persist.textContent = p
        ? 'Storage is persistent — the browser will not evict your notes.'
        : 'Storage is best-effort — add to Home Screen and keep JSON backups.';
    })
    .catch(() => persist.remove());
  sidebar.append(persist);

  return sidebar;
}

function buildContent(root: HTMLElement, folder: Folder | null): HTMLElement {
  const content = el('div', { class: 'lib-content' });

  const recent = store.notebookList()[0];
  if (!folder && recent) {
    // featured — most recently edited, anywhere
    const featSection = el('div');
    featSection.append(el('div', { class: 'section-label accent', text: 'Resume drawing' }));
    featSection.append(buildFeatured(recent));
    content.append(featSection);
  }

  const items = store.folderItems(folder?.id ?? null);
  const notebooks = items.filter((it): it is Extract<FolderItem, { kind: 'notebook' }> => it.kind === 'notebook');
  const grid = el('div', { class: 'nb-grid' });
  const head = el('div', { class: 'section-head' });
  head.append(
    el('h2', { text: folder ? 'Notebooks' : 'All notebooks' }),
    el('span', { class: 'count', text: `${notebooks.length}` })
  );
  grid.append(head);
  if (!items.length) {
    grid.append(
      el('p', {
        class: 'lib-empty',
        text: folder ? 'Nothing in this folder yet.' : 'No notebooks yet. Tap “New notebook” to start.',
      })
    );
  }
  for (const it of items) {
    grid.append(it.kind === 'notebook' ? buildCard(it.nb, root, folder) : buildDivider(it.divider, root, folder));
  }
  content.append(grid);

  return content;
}

// --------------------------------------------------------------------- tree
function openSet(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(OPEN_KEY) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}
function saveOpen(open: Set<string>): void {
  try {
    localStorage.setItem(OPEN_KEY, JSON.stringify([...open]));
  } catch {
    /* ignore */
  }
}

/** Folder tree: root row + nested folders. The path to the current folder is always expanded. */
function buildTree(root: HTMLElement, current: Folder | null): HTMLElement {
  const tree = el('nav', { class: 'tree', 'aria-label': 'Folders' });
  const open = openSet();
  for (const f of store.folderPath(current?.id ?? null)) open.add(f.id);

  const row = (f: Folder | null, depth: number): HTMLElement => {
    const id = f?.id ?? null;
    const children = store.folderList(id);
    const isOpen = f ? open.has(f.id) : true;
    const r = el('div', {
      class: 'tree__row' + ((current?.id ?? null) === id ? ' active' : ''),
      role: 'treeitem',
      'aria-expanded': children.length ? String(isOpen) : undefined,
      'aria-selected': String((current?.id ?? null) === id),
    });
    r.style.setProperty('--depth', String(depth));
    r.dataset.folderId = id ?? '';

    const toggle = el('button', {
      class: 'tree__toggle' + (isOpen ? ' open' : ''),
      'aria-label': isOpen ? 'Collapse' : 'Expand',
      style: children.length ? '' : 'visibility:hidden',
    });
    toggle.append(icon('chevron-right', 'sm'));
    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!f) return;
      if (open.has(f.id)) open.delete(f.id);
      else open.add(f.id);
      saveOpen(open);
      rerender(root, current);
    });

    const main = el('button', { class: 'tree__main' });
    main.append(
      icon(isOpen && children.length ? 'folder-open' : 'folder', 'sm'),
      el('span', { class: 'tree__name', text: f ? f.name : 'All notebooks' }),
      el('span', { class: 'tree__count', text: String(store.notebookCount(id)) })
    );
    main.addEventListener('click', () => {
      location.hash = folderHash(id);
    });

    const more = el('button', { class: 'iconbtn tree__more', title: 'Folder actions', 'aria-label': 'Folder actions' });
    more.append(icon('more'));
    more.addEventListener('click', () => openFolderMenu(more, f, root, current));

    r.append(toggle, main, more);
    return r;
  };

  const walk = (f: Folder | null, depth: number): void => {
    tree.append(row(f, depth));
    if (f && !open.has(f.id)) return;
    for (const child of store.folderList(f?.id ?? null)) walk(child, depth + 1);
  };
  walk(null, 0);
  return tree;
}

function openFolderMenu(anchor: HTMLElement, f: Folder | null, root: HTMLElement, current: Folder | null): void {
  const items: Array<{ icon: IconName; label: string; danger?: boolean; run: () => Promise<void> | void }> = [
    {
      icon: 'folder-plus',
      label: f ? 'New subfolder' : 'New folder',
      run: async () => {
        const name = await textPrompt({ title: 'New folder', placeholder: 'Folder name', confirmText: 'Create' });
        if (name == null) return;
        const made = store.createFolder(name, f?.id ?? null);
        const open = openSet();
        if (f) open.add(f.id);
        saveOpen(open);
        location.hash = folderHash(made.id);
        if (location.hash === folderHash(current?.id ?? null)) rerender(root, current);
      },
    },
  ];
  if (f) {
    items.push(
      {
        icon: 'rename',
        label: 'Rename',
        run: async () => {
          const name = await textPrompt({ title: 'Rename folder', value: f.name, confirmText: 'Rename' });
          if (name == null) return;
          store.renameFolder(f.id, name);
          rerender(root, current);
        },
      },
      {
        icon: 'delete',
        label: 'Delete folder',
        danger: true,
        run: async () => {
          const direct = store.folderItems(f.id).filter((it) => it.kind === 'notebook').length;
          const subs = store.folderList(f.id).length;
          const total = store.notebookCount(f.id);
          const parentName = f.parentId ? store.folders.get(f.parentId)?.name ?? 'its parent' : 'All notebooks';
          const n = (k: number, one: string): string => `${k} ${one}${k === 1 ? '' : 's'}`;
          const contents =
            direct === 0 && subs === 0
              ? 'It is empty.'
              : `It holds ${n(direct, 'notebook')} and ${n(subs, 'subfolder')}` +
                (total > direct ? ` (${n(total - direct, 'more notebook')} inside them)` : '') +
                `. Nothing will be deleted with it — everything moves up to “${parentName}”.`;
          const ok = await confirmDialog({
            title: `Delete folder “${f.name}”?`,
            message: contents,
            confirmText: 'Delete folder',
            danger: true,
          });
          if (!ok) return;
          const goTo = f.id === current?.id || store.folderPath(current?.id ?? null).some((p) => p.id === f.id);
          store.deleteFolder(f.id);
          if (goTo) location.hash = folderHash(f.parentId);
          else rerender(root, current);
        },
      }
    );
  }
  openActionMenu(anchor, items);
}

/** Anchored list of actions (icon + label); closes itself before running the picked one. */
function openActionMenu(
  anchor: HTMLElement,
  items: Array<{ icon: IconName; label: string; danger?: boolean; run: () => Promise<void> | void }>
): void {
  const menu = el('div', { class: 'menu', role: 'menu' });
  let modal: Modal | null = null;
  for (const it of items) {
    const b = el('button', { class: 'menu__item menu__item--icon' + (it.danger ? ' danger' : ''), role: 'menuitem' });
    b.append(icon(it.icon, 'sm'), el('span', { text: it.label }));
    b.addEventListener('click', () => {
      modal?.close();
      void it.run();
    });
    menu.append(b);
  }
  modal = openAnchoredModal(anchor, menu);
}

// ------------------------------------------------------------------- cards
function buildFeatured(nb: Notebook): HTMLElement {
  const card = el('div', { class: 'featured', role: 'button', tabindex: '0' });
  if (nb.cover) card.style.setProperty('--cover', nb.cover.color);

  const thumb = el('div', { class: 'featured__thumb' + (nb.cover ? ' has-cover' : '') });
  if (nb.cover) thumb.style.background = coverBackground(nb.cover);
  lazyThumb(thumb, nb);

  const inner = el('div', { class: 'featured__body' });
  const top = el('div', { class: 'nb-card__toprow' });
  top.append(
    el('span', { class: 'tag tag--tpl', text: firstTemplate(nb) }),
    el('span', { class: 'nb-card__pages', text: pageLabel(nb) })
  );
  inner.append(
    top,
    el('h3', { class: 'featured__title', text: nb.name }),
    el('span', { class: 'nb-card__date', text: `Edited ${relDate(nb.updatedAt)}` })
  );

  card.append(thumb, inner);
  const open = () => {
    location.hash = `#/nb/${nb.id}`;
  };
  card.addEventListener('click', open);
  card.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') open();
  });
  return card;
}

function buildCard(nb: Notebook, root: HTMLElement, folder: Folder | null): HTMLElement {
  const card = el('div', { class: 'nb-card' });
  card.dataset.notebookId = nb.id;
  const accent = el('div', { class: `nb-card__accent nb-card__accent--${firstTemplate(nb)}` });
  if (nb.cover) accent.style.background = nb.cover.color; // the cover colour wins over the template accent
  card.append(accent);

  const thumb = el('div', { class: 'nb-card__thumb' + (nb.cover ? ' has-cover' : '') });
  if (nb.cover) thumb.style.background = coverBackground(nb.cover);
  lazyThumb(thumb, nb);
  card.append(thumb);

  // the open button and the action buttons are siblings — nesting buttons makes
  // every action click bubble into "open notebook"
  const body = el('div', { class: 'nb-card__body' });
  const main = el('button', { class: 'nb-card__main' });
  const top = el('div', { class: 'nb-card__toprow' });
  top.append(
    el('span', { class: 'tag', text: firstTemplate(nb) }),
    el('span', { class: 'nb-card__pages', text: pageLabel(nb) })
  );

  const foot = el('div', { class: 'nb-card__foot' });
  foot.append(el('span', { class: 'nb-card__date', text: relDate(nb.updatedAt) }));

  main.append(top, el('span', { class: 'nb-card__title', text: nb.name }), foot);
  main.addEventListener('click', () => {
    location.hash = `#/nb/${nb.id}`;
  });

  const actions = el('div', { class: 'nb-card__actions' });
  const rename = el('button', { class: 'iconbtn', title: 'Rename', 'aria-label': 'Rename notebook' });
  rename.append(icon('rename'));
  rename.addEventListener('click', async () => {
    const name = await textPrompt({ title: 'Rename notebook', value: nb.name, confirmText: 'Rename' });
    if (name == null) return;
    store.renameNotebook(nb.id, name);
    rerender(root, folder);
  });
  const del = el('button', { class: 'iconbtn', title: 'Delete', 'aria-label': 'Delete notebook' });
  del.append(icon('delete'));
  del.addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: `Delete “${nb.name}”?`,
      message: 'All of its pages and drawings will be removed.',
      confirmText: 'Delete',
      danger: true,
    });
    if (!ok) return;
    store.deleteNotebook(nb.id);
    rerender(root, folder);
  });
  const more = el('button', { class: 'iconbtn', title: 'More', 'aria-label': 'Notebook actions' });
  more.append(icon('more'));
  more.addEventListener('click', () =>
    openActionMenu(more, [
      { icon: 'palette', label: 'Cover…', run: () => openCoverPicker(nb, root, folder) },
      { icon: 'move-to', label: 'Move to folder…', run: () => openMoveTo(nb, root, folder) },
      {
        icon: 'divider',
        label: 'Add divider above',
        run: async () => {
          const label = await textPrompt({ title: 'New divider', placeholder: 'Label', confirmText: 'Add' });
          if (label == null) return;
          store.createDivider(folder?.id ?? null, label, nb.id);
          rerender(root, folder);
        },
      },
      { icon: 'arrow-up', label: 'Move up', run: () => moveItem(nb.id, -1, root, folder) },
      { icon: 'arrow-down', label: 'Move down', run: () => moveItem(nb.id, 1, root, folder) },
    ])
  );
  actions.append(rename, del, more);

  body.append(main, actions);
  card.append(body);
  return card;
}

/** A labelled marker between notebooks; purely visual, with rename / reorder / delete. */
function buildDivider(d: Divider, root: HTMLElement, folder: Folder | null): HTMLElement {
  const row = el('div', { class: 'lib-divider', role: 'separator', 'aria-label': d.label });
  row.dataset.dividerId = d.id;
  row.append(el('span', { class: 'lib-divider__label', text: d.label }));
  const more = el('button', { class: 'iconbtn', title: 'Divider actions', 'aria-label': 'Divider actions' });
  more.append(icon('more'));
  more.addEventListener('click', () =>
    openActionMenu(more, [
      {
        icon: 'rename',
        label: 'Rename',
        run: async () => {
          const label = await textPrompt({ title: 'Rename divider', value: d.label, confirmText: 'Rename' });
          if (label == null) return;
          store.renameDivider(d.id, label);
          rerender(root, folder);
        },
      },
      { icon: 'arrow-up', label: 'Move up', run: () => moveItem(d.id, -1, root, folder) },
      { icon: 'arrow-down', label: 'Move down', run: () => moveItem(d.id, 1, root, folder) },
      {
        icon: 'delete',
        label: 'Delete divider',
        danger: true,
        run: () => {
          store.deleteDivider(d.id);
          rerender(root, folder);
        },
      },
    ])
  );
  row.append(more);
  return row;
}

function moveItem(id: string, dir: -1 | 1, root: HTMLElement, folder: Folder | null): void {
  if (store.moveItem(id, dir)) rerender(root, folder);
}

/** Modal listing every folder as an indented tree; picking one moves the notebook there. */
function openMoveTo(nb: Notebook, root: HTMLElement, folder: Folder | null): void {
  const box = el('div', { class: 'dlg' });
  box.append(el('h2', { class: 'dlg__title', text: `Move “${nb.name}” to` }));
  const list = el('div', { class: 'menu move-list' });
  let modal: Modal | null = null;
  const add = (f: Folder | null, depth: number): void => {
    const id = f?.id ?? null;
    const b = el('button', {
      class: 'menu__item menu__item--icon' + (nb.folderId === id ? ' active' : ''),
      'aria-current': nb.folderId === id ? 'true' : undefined,
    });
    b.style.setProperty('--depth', String(depth));
    b.append(icon('folder', 'sm'), el('span', { text: f ? f.name : 'All notebooks' }));
    b.addEventListener('click', () => {
      modal?.close();
      store.moveNotebook(nb.id, id);
      rerender(root, folder);
    });
    list.append(b);
    for (const child of store.folderList(id)) add(child, depth + 1);
  };
  add(null, 0);
  box.append(list);
  modal = openModal(box);
}

/** Cover picker: palette colours × built-in patterns, applied immediately. */
function openCoverPicker(nb: Notebook, root: HTMLElement, folder: Folder | null): void {
  const box = el('div', { class: 'dlg cover-picker' });
  box.append(el('h2', { class: 'dlg__title', text: 'Notebook cover' }));
  let cover: NotebookCover | undefined = nb.cover ? { ...nb.cover } : undefined;

  const preview = el('div', { class: 'cover-picker__preview' });
  const colors = el('div', { class: 'cover-picker__row' });
  const patterns = el('div', { class: 'cover-picker__row' });

  const paint = (): void => {
    preview.style.background = cover ? coverBackground(cover) : '';
    preview.classList.toggle('none', !cover);
    for (const b of colors.querySelectorAll<HTMLElement>('.swatch')) {
      b.classList.toggle('active', b.dataset.color === (cover?.color ?? ''));
    }
    for (const b of patterns.querySelectorAll<HTMLElement>('.cover-tile')) {
      b.classList.toggle('active', (b.dataset.pattern ?? '') === (cover?.pattern ?? ''));
    }
    store.setCover(nb.id, cover);
  };

  const none = el('button', { class: 'swatch swatch--none', title: 'No cover', 'aria-label': 'No cover', 'data-color': '' });
  none.addEventListener('click', () => {
    cover = undefined;
    paint();
  });
  colors.append(none);
  for (const c of COVER_COLORS) {
    const b = el('button', { class: 'swatch', style: `background:${c}`, title: c, 'aria-label': `Cover ${c}`, 'data-color': c });
    b.addEventListener('click', () => {
      cover = { color: c, pattern: cover?.pattern };
      paint();
    });
    colors.append(b);
  }
  const plain = el('button', { class: 'cover-tile', title: 'Plain', 'aria-label': 'Plain cover', 'data-pattern': '' });
  plain.append(el('span', { text: 'Plain' }));
  plain.addEventListener('click', () => {
    if (cover) cover = { color: cover.color };
    paint();
  });
  patterns.append(plain);
  for (const p of COVER_PATTERNS) {
    const b = el('button', { class: 'cover-tile', title: p, 'aria-label': `${p} pattern`, 'data-pattern': p });
    b.style.background = coverBackground({ color: cover?.color ?? COVER_COLORS[0], pattern: p });
    b.addEventListener('click', () => {
      cover = { color: cover?.color ?? COVER_COLORS[0], pattern: p };
      for (const t of patterns.querySelectorAll<HTMLElement>('.cover-tile[data-pattern]')) {
        const pat = t.dataset.pattern as NotebookCover['pattern'] | '';
        if (pat) t.style.background = coverBackground({ color: cover.color, pattern: pat });
      }
      paint();
    });
    patterns.append(b);
  }

  box.append(preview, field('Colour', colors), field('Pattern', patterns));
  paint();
  openModal(box, { onClose: () => rerender(root, folder) });
}

function field(label: string, control: HTMLElement): HTMLElement {
  const f = el('div', { class: 'dlg__field' });
  f.append(el('span', { class: 'dlg__flabel', text: label }), control);
  return f;
}

/** A row of mutually-exclusive pill buttons; calls `onPick` with the chosen index. Duplicated from notebook.ts's own copy — the two UI modules don't share these small dialog-building helpers (see field() above, likewise duplicated). */
function segmented(labels: string[], activeIndex: number, onPick: (i: number) => void): HTMLElement {
  const row = el('div', { class: 'seg' });
  const btns: HTMLButtonElement[] = [];
  labels.forEach((label, i) => {
    const b = el('button', {
      type: 'button',
      class: 'seg__btn' + (i === activeIndex ? ' active' : ''),
      text: label,
    }) as HTMLButtonElement;
    b.addEventListener('click', () => {
      for (const x of btns) x.classList.remove('active');
      b.classList.add('active');
      onPick(i);
    });
    btns.push(b);
    row.append(b);
  });
  return row;
}

/** Dims a `segmented()` row without removing it — its buttons pick up the shared button:disabled style. */
function setSegmentedDisabled(row: HTMLElement, disabled: boolean): void {
  for (const b of row.querySelectorAll<HTMLButtonElement>('.seg__btn')) b.disabled = disabled;
}

/**
 * "New notebook": name plus the same paper controls as the in-notebook paper
 * menu (see notebook.ts's openPaperMenu) — Template / Line spacing / Paper
 * color, minus its "Apply to" scope (there's only ever the one starting page
 * yet). The chosen paper becomes that first page's paper; every later page
 * inherits from whichever page precedes it (see store.addPage), so this is
 * really "set the notebook's starting paper" rather than a separate stored
 * per-notebook default.
 */
function newNotebookDialog(): Promise<{ name: string; paper: Paper } | null> {
  return new Promise((resolve) => {
    const TEMPLATES: PaperTemplate[] = ['blank', 'ruled', 'grid', 'dot'];
    const SPACINGS: PaperSpacing[] = ['narrow', 'medium', 'wide'];
    const COLORS: PaperColor[] = ['white', 'cream', 'dark'];
    let draft: Paper = { ...DEFAULT_PAPER };

    const form = document.createElement('form');
    form.className = 'dlg';

    const input = el('input', {
      class: 'dlg__input',
      type: 'text',
      autocomplete: 'off',
      placeholder: 'Notebook name',
    }) as HTMLInputElement;

    const spacingRow = segmented(['Narrow', 'Medium', 'Wide'], SPACINGS.indexOf(draft.spacing), (i) => {
      draft = { ...draft, spacing: SPACINGS[i] };
    });
    setSegmentedDisabled(spacingRow, draft.template === 'blank');

    const templateRow = segmented(['Blank', 'Ruled', 'Grid', 'Dot'], TEMPLATES.indexOf(draft.template), (i) => {
      draft = { ...draft, template: TEMPLATES[i] };
      setSegmentedDisabled(spacingRow, TEMPLATES[i] === 'blank');
    });

    const colorRow = segmented(['White', 'Cream', 'Dark'], COLORS.indexOf(draft.color), (i) => {
      draft = { ...draft, color: COLORS[i] };
    });

    const cancelBtn = el('button', { type: 'button', class: 'dlg__cancel', text: 'Cancel' });
    const okBtn = el('button', { type: 'submit', class: 'primary dlg__ok', text: 'Create' });
    const row = el('div', { class: 'dlg__row' });
    row.append(cancelBtn, okBtn);

    form.append(
      el('h2', { class: 'dlg__title', text: 'New notebook' }),
      el('label', { class: 'dlg__label', text: 'Notebook name' }),
      input,
      field('Template', templateRow),
      field('Line spacing', spacingRow),
      field('Paper color', colorRow),
      row
    );

    let settled = false;
    const finish = (v: { name: string; paper: Paper } | null): void => {
      if (settled) return;
      settled = true;
      resolve(v);
      modal.close();
    };
    const modal = openModal(form, {
      dismissable: false,
      onClose: () => {
        if (!settled) {
          settled = true;
          resolve(null);
        }
      },
    });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      finish({ name: input.value.trim(), paper: draft });
    });
    cancelBtn.addEventListener('click', () => finish(null));
    requestAnimationFrame(() => {
      input.focus();
      input.select();
    });
  });
}

// ---------------------------------------------------------------------- fab
function buildFab(root: HTMLElement, folder: Folder | null): HTMLElement {
  const dock = el('div', { class: 'fab-dock' });
  const newBtn = el('button', { class: 'primary', text: 'New notebook' });
  newBtn.prepend(icon('plus'));
  newBtn.addEventListener('click', async () => {
    const result = await newNotebookDialog();
    if (!result) return;
    const nb = store.createNotebook(result.name, folder?.id ?? null, result.paper);
    location.hash = `#/nb/${nb.id}`;
  });
  const folderBtn = el('button', { text: 'New folder', title: 'New folder' });
  folderBtn.prepend(icon('folder-plus'));
  folderBtn.addEventListener('click', async () => {
    const name = await textPrompt({ title: 'New folder', placeholder: 'Folder name', confirmText: 'Create' });
    if (name == null) return;
    const made = store.createFolder(name, folder?.id ?? null);
    if (folder) {
      const open = openSet();
      open.add(folder.id);
      saveOpen(open);
    }
    location.hash = folderHash(made.id);
  });
  dock.append(newBtn, folderBtn);
  void root;
  return dock;
}

// ------------------------------------------------------------------- helpers
/** Paper template of the notebook's first page, for the card accent + tag. */
function firstTemplate(nb: Notebook): PaperTemplate {
  return store.pagesOf(nb.id)[0]?.paper.template ?? 'blank';
}

/** Page count excluding the automatic trailing blank page (always at least 1). */
function pageCount(nb: Notebook): number {
  const pages = store.pagesOf(nb.id);
  let n = pages.length;
  if (n > 1 && store.isBlankPage(pages[n - 1].id)) n -= 1;
  return Math.max(n, 1);
}

function pageLabel(nb: Notebook): string {
  const n = pageCount(nb);
  return `${n} page${n === 1 ? '' : 's'}`;
}

function relDate(ts: number): string {
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const time = new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (ts >= startToday) return `today, ${time}`;
  if (ts >= startToday - 86400000) return `yesterday, ${time}`;
  return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' });
}
