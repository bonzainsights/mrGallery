import './styles.css';
import {
  Check,
  Clock,
  Copy,
  ExternalLink,
  FileQuestion,
  Files,
  FolderCog,
  FolderOpen,
  FolderTree,
  Globe2,
  HardDrive,
  Image as ImageIcon,
  LayoutGrid,
  MapPinned,
  PanelRight,
  Plus,
  RefreshCcw,
  ScanSearch,
  Search,
  Star,
  Trash2,
  UserRound,
  UsersRound,
  Video,
  X,
  createIcons
} from 'lucide';
import { computeAverageHash, extractImageMetadata } from './lib/analysis';
import { buildDuplicateGroups, type DuplicateGroup } from './lib/duplicates';
import {
  buildFolderGroups,
  buildKindGroups,
  buildLocationGroups,
  buildPeopleGroups,
  buildTimelineGroups,
  formatBytes,
  formatDate,
  formatDuration,
  type MediaGroup,
  type MediaItem
} from './lib/media';
import {
  apiScanFolder,
  apiPickFolder,
  apiGetMedia,
  apiDeleteFiles,
  apiAnalyzeDuplicates,
  apiGetDuplicates,
  getFileUrl,
  getThumbnailUrl,
  apiGetPeople,
  apiAnalyzeFaces,
  apiFaceScanStatus,
  apiGetFolders,
  apiRemoveFolder,
  apiRenamePerson,
  type FolderStat
} from './lib/api';

type ViewMode = 'timeline' | 'folder' | 'kind' | 'location' | 'people' | 'duplicates' | 'manage-folders';
type KindFilter = 'all' | 'image' | 'video';



interface AppState {
  items: MediaItem[];
  activeId?: string;
  selectedIds: Set<string>;
  keepIds: Set<string>;
  viewMode: ViewMode;
  kindFilter: KindFilter;
  search: string;
  status: string;
  busy: boolean;
  duplicateGroups: DuplicateGroup[];
  analyzedAt?: number;
  skipped: number;
  folderStats: FolderStat[];
}

const PEOPLE_STORAGE_KEY = 'mr-gallery.people.v1';
const KEEP_STORAGE_KEY = 'mr-gallery.keeps.v1';
const SELECTED_STORAGE_KEY = 'mr-gallery.selected.v1';
const MAX_METADATA_BATCH = 400;
const THUMB_WIDTH = 200;
const THUMB_HEIGHT = 144;
const SEARCH_DEBOUNCE_MS = 150;

const rootElement = document.querySelector<HTMLDivElement>('#app');

if (!rootElement) {
  throw new Error('App root is missing.');
}

const app: HTMLDivElement = rootElement;



const peopleStore = loadPeopleStore();
const state: AppState = {
  items: [],
  selectedIds: new Set(),
  keepIds: loadStringSet(KEEP_STORAGE_KEY),
  viewMode: 'timeline',
  kindFilter: 'all',
  search: '',
  status: 'Connecting to local server...',
  busy: false,
  duplicateGroups: [],
  skipped: 0,
  folderStats: []
};

let prevViewMode: ViewMode = 'timeline';
let prevKindFilter: KindFilter = 'all';
let prevSearch = '';
let prevActiveId: string | undefined;
let prevItemCount = -1;
let prevDuplicateCount = -1;
let prevFolderStatsCount = -1;
let searchTimer: ReturnType<typeof setTimeout> | undefined;

const LUCIDE_ICONS = {
  Check,
  Clock,
  Copy,
  ExternalLink,
  FileQuestion,
  Files,
  FolderCog,
  FolderOpen,
  FolderTree,
  Globe2,
  HardDrive,
  Image: ImageIcon,
  LayoutGrid,
  MapPinned,
  PanelRight,
  Plus,
  RefreshCcw,
  ScanSearch,
  Search,
  Star,
  Trash2,
  UserRound,
  UsersRound,
  Video,
  X
};

fullRender();
bindGlobalDrop();

// ---------------------------------------------------------------------------
// Full render — only used on startup or structural layout changes
// ---------------------------------------------------------------------------

function fullRender(): void {
  const filteredItems = getFilteredItems();
  const activeItem = getActiveItem(filteredItems);
  const stats = getStats();
  const selectedItems = getSelectedItems();

  app.innerHTML = `
    <div class="shell">
      <aside class="sidebar">
        <div class="brand">
          <div class="brand-mark"><i data-lucide="layout-grid"></i></div>
          <div>
            <strong>Mr Gallery</strong>
            <span>python engine</span>
          </div>
        </div>

        <div class="primary-actions">
          <button class="button primary" data-action="add-folder">
            <i data-lucide="folder-open"></i>
            <span>Add folder</span>
          </button>
          <button class="button" data-action="add-files">
            <i data-lucide="files"></i>
            <span>Add files</span>
          </button>
        </div>

        <div class="stat-grid" id="stat-grid">
          <div><span id="stat-total">${stats.total}</span><small>Total</small></div>
          <div><span id="stat-images">${stats.images}</span><small>Images</small></div>
          <div><span id="stat-videos">${stats.videos}</span><small>Videos</small></div>
          <div><span id="stat-size">${formatBytes(stats.bytes)}</span><small>Size</small></div>
        </div>

        <nav class="view-nav" id="view-nav" aria-label="Views">
          ${viewButton('timeline', 'clock', 'Timeline')}
          ${viewButton('folder', 'folder-tree', 'Folders')}
          ${viewButton('kind', 'hard-drive', 'Media')}
          ${viewButton('location', 'map-pinned', 'Location')}
          ${viewButton('people', 'users-round', 'People')}
          ${viewButton('duplicates', 'scan-search', 'Duplicates')}
          ${viewButton('manage-folders', 'folder-cog', 'Manage Folders')}
        </nav>

        <div class="selection-panel" id="selection-panel">
          <div>
            <strong id="selection-count">${selectedItems.length}</strong>
            <span>selected</span>
          </div>
          <div class="selection-actions">
            <button class="icon-button" title="Copy selected" data-action="copy-selected" ${selectedItems.length === 0 ? 'disabled' : ''}>
              <i data-lucide="copy"></i>
            </button>
            <button class="icon-button danger" title="Delete selected files" data-action="delete-selected" ${selectedItems.length === 0 ? 'disabled' : ''}>
              <i data-lucide="trash-2"></i>
            </button>
          </div>
        </div>
      </aside>

      <main class="workspace">
        <header class="toolbar">
          <label class="search-box">
            <i data-lucide="search"></i>
            <input id="search-input" value="${escapeAttr(state.search)}" placeholder="Search names, folders, people" />
          </label>

          <div class="segmented" id="filter-group" role="group" aria-label="Media filter">
            ${filterButton('all', 'All')}
            ${filterButton('image', 'Images')}
            ${filterButton('video', 'Videos')}
          </div>

          <button class="button compact" data-action="analyze">
            <i data-lucide="scan-search"></i>
            <span>Analyze</span>
          </button>
          <button class="button compact" data-action="refresh-metadata" ${state.items.length === 0 ? 'disabled' : ''}>
            <i data-lucide="refresh-ccw"></i>
            <span>EXIF</span>
          </button>
        </header>

        <section class="content" id="content-area">
          ${renderContent(filteredItems)}
        </section>

        <footer class="statusbar ${state.busy ? 'is-busy' : ''}" id="statusbar">
          <span id="status-text">${escapeHtml(state.status)}</span>
          <span id="status-skipped">${state.skipped > 0 ? `${state.skipped} skipped` : ''}</span>
        </footer>

        <aside class="inspector ${state.activeId ? 'is-visible' : ''}" id="inspector-panel">
          <div class="inspector-drag" id="inspector-drag"></div>
          <div class="inspector-top-bar">
            <button class="icon-button" title="Open in system" data-action="open-active"><i data-lucide="external-link"></i></button>
            <button class="icon-button" title="Close panel" data-action="close-inspector"><i data-lucide="x"></i></button>
          </div>
          ${activeItem ? renderInspector(activeItem) : renderEmptyInspector()}
        </aside>
      </main>

      <input id="browser-file-input" class="hidden-input" type="file" accept="image/*,video/*" multiple />
      <input id="browser-folder-input" class="hidden-input" type="file" accept="image/*,video/*" multiple webkitdirectory />
    </div>
  `;

  wireEvents();
  renderIconsScoped(app);

  // Snapshot state
  prevActiveId = state.activeId;
  prevViewMode = state.viewMode;
  prevKindFilter = state.kindFilter;
  prevSearch = state.search;
  prevItemCount = state.items.length;
  prevDuplicateCount = state.duplicateGroups.length;

  if (activeItem && activeItem.kind === 'image' && !activeItem.width && !activeItem.location) {
    void enrichSingleItem(activeItem);
  }

  // Setup thumbnail caching on all grid images
  setupThumbCaching();
  setupInfiniteScroll();
}

// ---------------------------------------------------------------------------
// Targeted update — called on most state changes instead of full re-render
// ---------------------------------------------------------------------------

function smartUpdate(): void {
  const needsGridRebuild =
    state.viewMode !== prevViewMode ||
    state.kindFilter !== prevKindFilter ||
    state.search !== prevSearch ||
    state.items.length !== prevItemCount ||
    state.duplicateGroups.length !== prevDuplicateCount ||
    state.folderStats.length !== prevFolderStatsCount;

  if (needsGridRebuild) {
    updateGrid();
  }

  updateCardStates();
  updateInspector();
  updateSidebar();
  updateStatusBar();

  // Snapshot state
  prevActiveId = state.activeId;
  prevViewMode = state.viewMode;
  prevKindFilter = state.kindFilter;
  prevSearch = state.search;
  prevItemCount = state.items.length;
  prevDuplicateCount = state.duplicateGroups.length;
  prevFolderStatsCount = state.folderStats.length;
}

// ---------------------------------------------------------------------------
// Grid updates — preserves scroll position
// ---------------------------------------------------------------------------

function updateGrid(): void {
  const contentEl = document.getElementById('content-area');
  if (!contentEl) return;

  // Preserve scroll
  const scrollTop = contentEl.scrollTop;

  const filteredItems = getFilteredItems();
  contentEl.innerHTML = renderContent(filteredItems);

  // Restore scroll
  requestAnimationFrame(() => {
    contentEl.scrollTop = scrollTop;
  });

  // Re-wire card events + render icons only in content area
  wireCardEvents(contentEl);
  renderIconsScoped(contentEl);
  setupThumbCaching();
}

// ---------------------------------------------------------------------------
// Update card classes (active, selected) without rebuilding DOM
// ---------------------------------------------------------------------------

function updateCardStates(): void {
  const cards = app.querySelectorAll<HTMLElement>('.media-card');
  cards.forEach((card) => {
    const id = card.dataset.id;
    if (!id) return;

    const isActive = id === state.activeId;
    const isSelected = state.selectedIds.has(id);

    card.classList.toggle('is-active', isActive);
    card.classList.toggle('is-selected', isSelected);

    // Update the select toggle icon
    const toggle = card.querySelector<HTMLElement>('.select-toggle i, .select-toggle svg');
    if (toggle) {
      const parent = toggle.parentElement;
      if (parent) {
        // Replace icon indicator
        const wantCheck = isSelected;
        const hasCheck = toggle.getAttribute('data-lucide') === 'check' ||
          parent.querySelector('[data-lucide="check"]') !== null;

        if (wantCheck !== hasCheck) {
          parent.innerHTML = `<i data-lucide="${isSelected ? 'check' : 'plus'}"></i>`;
          renderIconsScoped(parent);
        }
      }
    }

    // Update keep badge visibility
    const kept = state.keepIds.has(id);
    let keepBadge = card.querySelector<HTMLElement>('.keep-badge');
    if (kept && !keepBadge) {
      const badge = document.createElement('div');
      badge.className = 'keep-badge';
      badge.innerHTML = '<i data-lucide="star"></i>';
      card.appendChild(badge);
      renderIconsScoped(badge);
    } else if (!kept && keepBadge) {
      keepBadge.remove();
    }
  });
}

// ---------------------------------------------------------------------------
// Inspector — only replace when active item changes
// ---------------------------------------------------------------------------

function updateInspector(): void {
  const inspectorEl = document.getElementById('inspector-panel');
  if (!inspectorEl) return;

  // Toggle inspector panel visibility
  inspectorEl.classList.toggle('is-visible', Boolean(state.activeId));

  if (state.activeId === prevActiveId) return;

  const filteredItems = getFilteredItems();
  const activeItem = getActiveItem(filteredItems);

  // Preserve drag handle and top bar, replace inspector content
  const dragHandle = '<div class="inspector-drag" id="inspector-drag"></div>';
  const topBar = `
    <div class="inspector-top-bar">
      <button class="icon-button" title="Open in system" data-action="open-active"><i data-lucide="external-link"></i></button>
      <button class="icon-button" title="Close panel" data-action="close-inspector"><i data-lucide="x"></i></button>
    </div>
  `;
  inspectorEl.innerHTML = dragHandle + topBar + (activeItem ? renderInspector(activeItem) : renderEmptyInspector());

  wireInspectorEvents();
  renderIconsScoped(inspectorEl);

  if (activeItem && activeItem.kind === 'image' && !activeItem.width && !activeItem.location) {
    void enrichSingleItem(activeItem);
  }
}

function closeInspector(): void {
  state.activeId = undefined;
  prevActiveId = undefined;

  const inspectorEl = document.getElementById('inspector-panel');
  if (inspectorEl) {
    inspectorEl.classList.remove('is-visible');
  }

  updateCardStates();
  updateSidebar();
}

// ---------------------------------------------------------------------------
// Sidebar — update stats and selection count
// ---------------------------------------------------------------------------

export async function initializeApp(): Promise<void> {
  // Spawn backend process if running in Neutralino standalone mode (built exe).
  // In dev mode this path doesn't exist and spawnProcess will fail silently —
  // that's fine, the Python uvicorn server is started separately in dev.
  // @ts-ignore
  if (typeof window.Neutralino !== 'undefined' && window.NL_MODE === 'window') {
    try {
      // spawnProcess launches a background process without blocking JS.
      // execCommand is blocking (waits for exit) — do NOT use it here.
      // @ts-ignore
      const backendPath = `${window.NL_PATH}/backend${window.NL_EXTENSION}`;
      // @ts-ignore
      await window.Neutralino.os.spawnProcess(backendPath);

      // @ts-ignore
      window.Neutralino.events.on('windowClose', async () => {
        try {
          await fetch('http://127.0.0.1:8000/api/shutdown', { method: 'POST' });
        } catch (e) {
          // ignore
        }
        // @ts-ignore
        window.Neutralino.app.exit();
      });
    } catch (e) {
      console.error('Failed to spawn backend:', e);
    }
  }

  // Draw initial shell immediately so the UI is always interactive
  fullRender();

  // On Windows the backend.exe needs a few seconds to start after being spawned.
  // Poll briefly (up to 10s) so we don't hit it before it's ready.
  // On Mac dev the backend is already running, so this resolves on the first try.
  const MAX_ATTEMPTS = 20; // 20 × 500ms = 10 seconds
  const RETRY_DELAY_MS = 500;

  state.status = 'Connecting to backend...';
  state.busy = true;
  updateStatusBar();

  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    try {
      const res = await fetch('http://127.0.0.1:8000/api/media?offset=0&limit=1');
      if (res.ok) {
        // Backend is up — proceed immediately
        break;
      }
    } catch {
      // not ready yet — keep waiting
    }
    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
  }

  state.busy = false;
  state.status = 'Ready.';
  updateStatusBar();

  // Always proceed regardless of polling outcome.
  // loadNextPage() handles backend-down gracefully with an error message.
  await refreshPeopleCache();
  void loadNextPage();
}



function updateSidebar(): void {
  const stats = getStats();
  const selectedItems = getSelectedItems();

  setText('#stat-total', String(stats.total));
  setText('#stat-images', String(stats.images));
  setText('#stat-videos', String(stats.videos));
  setText('#stat-size', formatBytes(stats.bytes));
  setText('#selection-count', String(selectedItems.length));

  // Update selection action buttons disabled state
  const copyBtn = app.querySelector<HTMLButtonElement>('[data-action="copy-selected"]');
  const removeBtn = app.querySelector<HTMLButtonElement>('[data-action="delete-selected"]');
  if (copyBtn) copyBtn.disabled = selectedItems.length === 0;
  if (removeBtn) removeBtn.disabled = selectedItems.length === 0;

  // Update EXIF button
  const exifBtn = app.querySelector<HTMLButtonElement>('[data-action="refresh-metadata"]');
  if (exifBtn) exifBtn.disabled = state.items.length === 0;

  // Update view nav active state
  const viewNav = document.getElementById('view-nav');
  if (viewNav) {
    viewNav.querySelectorAll<HTMLElement>('button[data-view]').forEach((btn) => {
      btn.classList.toggle('is-active', btn.dataset.view === state.viewMode);
    });
  }

  // Update filter active state
  const filterGroup = document.getElementById('filter-group');
  if (filterGroup) {
    filterGroup.querySelectorAll<HTMLElement>('button[data-filter]').forEach((btn) => {
      btn.classList.toggle('is-active', btn.dataset.filter === state.kindFilter);
    });
  }
}

// ---------------------------------------------------------------------------
// Status bar — lightweight text update
// ---------------------------------------------------------------------------

function updateStatusBar(): void {
  const statusbar = document.getElementById('statusbar');
  if (statusbar) {
    statusbar.classList.toggle('is-busy', state.busy);
  }
  setText('#status-text', escapeHtml(state.status));
  setText('#status-skipped', state.skipped > 0 ? `${state.skipped} skipped` : '');
}

function setText(selector: string, text: string): void {
  const el = app.querySelector(selector);
  if (el && el.innerHTML !== text) {
    el.innerHTML = text;
  }
}

// ---------------------------------------------------------------------------
// Intersection Observer for Thumbnails & Infinite Scroll
// ---------------------------------------------------------------------------

function setupThumbCaching(): void {
  const images = app.querySelectorAll<HTMLImageElement>('.thumb img');

  // Cancel previous observer
  if ((window as any)._thumbObserver) {
    (window as any)._thumbObserver.disconnect();
  }

  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        const img = entry.target as HTMLImageElement;
        const originalSrc = img.dataset.src;
        if (originalSrc) {
          img.src = originalSrc;
          observer.unobserve(img);
        }
      }
    }
  }, {
    rootMargin: '500px 0px'
  });

  (window as any)._thumbObserver = observer;

  images.forEach((img) => {
    observer.observe(img);
  });
}

function setupInfiniteScroll(): void {
  const scrollAnchor = document.getElementById('scroll-anchor');
  if (!scrollAnchor) return;

  if ((window as any)._scrollObserver) {
    (window as any)._scrollObserver.disconnect();
  }

  const observer = new IntersectionObserver((entries) => {
    if (entries[0].isIntersecting && hasMore && !isLoadingPage) {
      void loadNextPage();
    }
  }, { rootMargin: '400px' });

  (window as any)._scrollObserver = observer;
  observer.observe(scrollAnchor);
}

// ---------------------------------------------------------------------------
// Scoped icon rendering — only process new nodes
// ---------------------------------------------------------------------------

function renderIconsScoped(root: Element): void {
  createIcons({
    icons: LUCIDE_ICONS,
    attrs: {},
    nameAttr: 'data-lucide'
  });
}

// ---------------------------------------------------------------------------
// Content rendering (HTML generation — used by both full and grid updates)
// ---------------------------------------------------------------------------

function renderContent(items: MediaItem[]): string {
  if (state.items.length === 0) {
    return `
      <div class="empty-state">
        <i data-lucide="image"></i>
        <strong>No media loaded.</strong>
        <div class="empty-actions">
          <button class="button primary" data-action="add-folder"><i data-lucide="folder-open"></i><span>Add folder</span></button>
          <button class="button" data-action="add-files"><i data-lucide="files"></i><span>Add files</span></button>
        </div>
      </div>
    `;
  }

  if (items.length === 0) {
    return `
      <div class="empty-state">
        <i data-lucide="file-question"></i>
        <strong>No matches.</strong>
        <button class="button" data-action="clear-search"><i data-lucide="x"></i><span>Clear</span></button>
      </div>
    `;
  }

  if (state.viewMode === 'duplicates') {
    return renderDuplicateView();
  }

  if (state.viewMode === 'people') {
    return renderPeopleView(items);
  }

  if (state.viewMode === 'manage-folders') {
    return renderManageFoldersView();
  }

  return getGroupsForView(items)
    .map(
      (group) => `
        <section class="media-section">
          <header>
            <h2>${escapeHtml(group.label)}</h2>
            <span>${group.items.length}</span>
          </header>
          <div class="media-grid">
            ${group.items.map(renderMediaCard).join('')}
          </div>
        </section>
      `
    )
    .join('') + (hasMore ? `<div id="scroll-anchor" style="height: 20px;"></div>` : '');
}

function renderPeopleView(items: MediaItem[]): string {
  const groups = getGroupsForView(items);
  const hasAnyPeople = groups.some(g => g.id !== 'Unassigned');

  const scanBtnHtml = `
    <div class="people-toolbar" style="display: flex; align-items: center; gap: 12px; padding: 12px 16px; border-bottom: 1px solid var(--line);">
      <button class="button primary" data-action="scan-faces" id="scan-faces-btn">
        <i data-lucide="scan-face"></i><span>Scan Faces</span>
      </button>
      <div id="face-scan-progress" style="flex: 1; display: none;">
        <div style="display: flex; justify-content: space-between; font-size: 12px; margin-bottom: 4px;">
          <span id="face-scan-label">Scanning...</span>
          <span id="face-scan-count"></span>
        </div>
        <div style="height: 4px; border-radius: 2px; background: var(--line); overflow: hidden;">
          <div id="face-scan-bar" style="height: 100%; width: 0%; background: var(--accent-strong); transition: width 0.3s;"></div>
        </div>
      </div>
    </div>
  `;

  if (!hasAnyPeople) {
    return scanBtnHtml + `
      <div class="empty-state">
        <i data-lucide="user-round-search"></i>
        <strong>No faces detected yet.</strong>
        <p style="color: var(--muted); max-width: 360px; text-align: center;">Click "Scan Faces" to analyze your photos and videos for people. This runs in the background and won't slow down your machine.</p>
      </div>
    `;
  }

  return scanBtnHtml + groups
    .map(
      (group) => {
        const images = group.items.filter((i) => i.kind === 'image');
        const videos = group.items.filter((i) => i.kind === 'video');
        
        let html = `
          <section class="media-section">
            <header style="margin-bottom: 0;">
              <h2><i data-lucide="user-round" style="width:16px;height:16px;margin-right:6px;"></i>${escapeHtml(group.label)}</h2>
              <span>${group.items.length} total</span>
            </header>
        `;

        if (images.length > 0) {
          html += `
            <div style="padding: 12px 16px 8px; font-size: 12px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px;">Photos (${images.length})</div>
            <div class="media-grid">
              ${images.map(renderMediaCard).join('')}
            </div>
          `;
        }

        if (videos.length > 0) {
          html += `
            <div style="padding: 12px 16px 8px; font-size: 12px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px;">Videos (${videos.length})</div>
            <div class="media-grid">
              ${videos.map(renderMediaCard).join('')}
            </div>
          `;
        }

        html += `</section>`;
        return html;
      }
    )
    .join('');
}

function renderDuplicateView(): string {
  if (state.duplicateGroups.length === 0) {
    return `
      <div class="empty-state">
        <i data-lucide="scan-search"></i>
        <strong>No duplicate analysis yet.</strong>
        <button class="button primary" data-action="analyze"><i data-lucide="scan-search"></i><span>Analyze</span></button>
      </div>
    `;
  }

  return state.duplicateGroups
    .map((group, index) => {
      const label = group.reason === 'exact' ? `Exact set ${index + 1}` : `Similar set ${index + 1}`;
      const items = group.items
        .map((source) => state.items.find((item) => item.id === source.id))
        .filter((item): item is MediaItem => Boolean(item));

      return `
        <section class="media-section duplicate-section">
          <header>
            <h2>${label}</h2>
            <span>${items.length}</span>
          </header>
          <div class="media-grid">
            ${items.map(renderMediaCard).join('')}
          </div>
        </section>
      `;
    })
    .join('');
}

function renderManageFoldersView(): string {
  if (state.folderStats.length === 0) {
    return `
      <div class="empty-state">
        <i data-lucide="folder-search"></i>
        <strong>No folders scanned.</strong>
        <p style="color: var(--muted); max-width: 360px; text-align: center;">You have not added any folders yet. Click the "Add folder" button to start.</p>
        <button class="button primary" data-action="add-folder"><i data-lucide="folder-open"></i><span>Add folder</span></button>
      </div>
    `;
  }

  return `
    <div class="folders-view" style="padding: 24px;">
      <h2 style="margin-bottom: 16px; font-size: 20px; font-weight: 500;">Manage Folders</h2>
      <div style="display: flex; gap: 12px; margin-bottom: 24px;">
        <button class="button primary" data-action="add-folder"><i data-lucide="folder-open"></i><span>Add new folder</span></button>
      </div>
      <div class="folder-list" style="display: flex; flex-direction: column; gap: 12px;">
        ${state.folderStats.map(stat => `
          <div class="folder-row" style="display: flex; align-items: center; justify-content: space-between; padding: 16px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg-surface);">
            <div style="display: flex; align-items: center; gap: 12px; overflow: hidden;">
              <i data-lucide="folder" style="color: var(--accent);"></i>
              <div style="display: flex; flex-direction: column; overflow: hidden;">
                <strong style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${escapeAttr(stat.path)}">${escapeHtml(stat.path)}</strong>
                <span style="font-size: 13px; color: var(--muted);">${stat.count} media items</span>
              </div>
            </div>
            <button class="button remove-folder-btn" data-action="remove-folder" data-folder="${escapeAttr(stat.path)}" style="color: var(--error);">
              <i data-lucide="trash-2"></i><span>Remove</span>
            </button>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

function renderMediaCard(item: MediaItem): string {
  const selected = state.selectedIds.has(item.id);
  const active = state.activeId === item.id;
  const kept = state.keepIds.has(item.id);

  return `
    <article class="media-card ${selected ? 'is-selected' : ''} ${active ? 'is-active' : ''}" data-id="${escapeAttr(item.id)}" draggable="true">
      <button class="select-toggle" title="Select" data-action="toggle-select" data-id="${escapeAttr(item.id)}">
        <i data-lucide="${selected ? 'check' : 'plus'}"></i>
      </button>
      ${kept ? '<div class="keep-badge"><i data-lucide="star"></i></div>' : ''}
      <div class="thumb">
        ${renderThumb(item)}
      </div>
      <div class="card-meta">
        <strong title="${escapeAttr(item.name)}">${escapeHtml(item.name)}</strong>
        <span>${item.kind} ${item.kind === 'video' && item.duration ? `· ${formatDuration(item.duration)} ` : ''}· ${formatBytes(item.size)}</span>
      </div>
    </article>
  `;
}

function renderThumb(item: MediaItem): string {
  if (item.previewSupport === 'native' && item.previewUrl) {
    return `
      <div style="position: relative; width: 100%; height: 100%;">
        <img loading="lazy" data-src="${escapeAttr(item.previewUrl)}" alt="${escapeAttr(item.name)}" />
        ${item.kind === 'video' ? `<div class="video-badge"><i data-lucide="play-circle"></i>${item.duration ? `<span style="margin-left: 4px; font-size: 11px; font-weight: bold; font-family: monospace;">${formatDuration(item.duration)}</span>` : ''}</div>` : ''}
      </div>
    `;
  }

  return `
    <div class="thumb-fallback">
      <i data-lucide="${item.kind === 'video' ? 'video' : 'file-question'}"></i>
      <span>${escapeHtml(item.extension.toUpperCase())}</span>
      ${item.kind === 'video' && item.duration ? `<div class="video-duration">${formatDuration(item.duration)}</div>` : ''}
    </div>
  `;
}

function renderInspector(item: MediaItem): string {
  const people = item.people ?? [];
  const selected = state.selectedIds.has(item.id);
  const kept = state.keepIds.has(item.id);

  return `
    <header class="inspector-header">
      <div>
        <span>${item.kind}</span>
        <h2 title="${escapeAttr(item.name)}">${escapeHtml(item.name)}</h2>
      </div>
    </header>

    <div class="preview-pane">
      ${renderLargePreview(item)}
    </div>

    <div class="inspector-actions">
      <button class="button ${selected ? 'primary' : ''}" data-action="toggle-active-select">
        <i data-lucide="${selected ? 'check' : 'panel-right'}"></i>
        <span>${selected ? 'Selected' : 'Select'}</span>
      </button>
      <button class="button ${kept ? 'primary' : ''}" data-action="toggle-keep">
        <i data-lucide="star"></i>
        <span>${kept ? 'Kept' : 'Keep'}</span>
      </button>
      <button class="button danger" data-action="delete-active">
        <i data-lucide="trash-2"></i>
        <span>Delete</span>
      </button>
    </div>

    <dl class="metadata">
      <div><dt>Folder</dt><dd title="${escapeAttr(item.folder)}">${escapeHtml(item.folder)}</dd></div>
      <div><dt>Date</dt><dd>${formatDate(item.takenAt ?? item.createdAt ?? item.modifiedAt)}</dd></div>
      <div><dt>Size</dt><dd>${formatBytes(item.size)}</dd></div>
      <div><dt>Format</dt><dd>${escapeHtml(item.extension.toUpperCase())}</dd></div>
      ${item.kind === 'video' && item.duration ? `<div><dt>Duration</dt><dd>${formatDuration(item.duration)}</dd></div>` : ''}
      <div><dt>Dimensions</dt><dd>${item.width && item.height ? `${item.width} × ${item.height}` : 'Unknown'}</dd></div>
      <div><dt>Location</dt><dd>${item.location ? formatCoords(item.location.latitude, item.location.longitude) : 'No GPS'}</dd></div>
    </dl>

    <section class="people-editor">
      <header><i data-lucide="user-round"></i><strong>People</strong></header>
      <div class="tag-row">
        ${people.map((person) => `
          <div class="tag" style="display:inline-flex; align-items:center; gap:4px;">
            <span style="cursor:pointer" title="Click to rename" data-action="rename-person" data-person="${escapeAttr(person)}">${escapeHtml(person)}</span>
            <span style="cursor:pointer; opacity:0.6" title="Remove" data-action="remove-person" data-person="${escapeAttr(person)}">×</span>
          </div>
        `).join('') || '<span class="muted">Unassigned</span>'}
      </div>
      <div class="inline-form">
        <input id="person-input" placeholder="Name" />
        <button class="icon-button" title="Add person" data-action="add-person"><i data-lucide="check"></i></button>
      </div>
    </section>

    <section class="mini-map">
      <div class="globe ${item.location ? 'has-location' : ''}">
        <i data-lucide="globe-2"></i>
      </div>
      <div>
        <strong>${item.location ? 'GPS tagged' : 'No GPS metadata'}</strong>
        <span>${item.location ? formatCoords(item.location.latitude, item.location.longitude) : 'Location view will group tagged media.'}</span>
      </div>
    </section>
  `;
}

function renderLargePreview(item: MediaItem): string {
  if (item.previewSupport === 'native' && item.previewUrl) {
    if (item.kind === 'image') {
      return `<img src="${escapeAttr(item.previewUrl)}" alt="${escapeAttr(item.name)}" />`;
    }

    return `<video src="${escapeAttr(item.objectUrl || '')}" controls preload="metadata"></video>`;
  }

  return `
    <div class="large-fallback">
      <i data-lucide="${item.kind === 'video' ? 'video' : 'file-question'}"></i>
      <strong>${escapeHtml(item.extension.toUpperCase())}</strong>
      <button class="button" data-action="open-active"><i data-lucide="external-link"></i><span>Open</span></button>
    </div>
  `;
}

function renderEmptyInspector(): string {
  return `
    <div class="empty-inspector">
      <i data-lucide="panel-right"></i>
      <strong>No selection.</strong>
    </div>
  `;
}

function viewButton(mode: ViewMode, icon: string, label: string): string {
  return `
    <button class="${state.viewMode === mode ? 'is-active' : ''}" data-action="set-view" data-view="${mode}">
      <i data-lucide="${icon}"></i>
      <span>${label}</span>
    </button>
  `;
}

function filterButton(filter: KindFilter, label: string): string {
  return `
    <button class="${state.kindFilter === filter ? 'is-active' : ''}" data-action="set-filter" data-filter="${filter}">
      ${label}
    </button>
  `;
}

// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------

function wireEvents(): void {
  // Sidebar actions — these are stable, wired once on full render
  app.querySelector('[data-action="add-folder"]')?.addEventListener('click', () => void addFolder());
  app.querySelector('[data-action="add-files"]')?.addEventListener('click', () => void addFiles());

  app.querySelectorAll('[data-action="set-view"]').forEach((button) => {
    button.addEventListener('click', async () => {
      const newView = (button as HTMLElement).dataset.view as ViewMode;
      if (state.viewMode !== newView) {
        if (newView === 'people') {
          setBusy('Loading people...');
          await refreshPeopleCache();
          for (const item of state.items) {
            const manualPeople = peopleStore[item.path] ?? [];
            const aiPeopleList = aiPeopleMap.get(item.id) ?? [];
            item.people = Array.from(new Set([...manualPeople, ...aiPeopleList]));
          }
          setReady('Done.');
        } else if (newView === 'manage-folders') {
          setBusy('Loading folders...');
          try {
            state.folderStats = await apiGetFolders();
            setReady('Done.');
          } catch (err) {
            console.error(err);
            setReady('Failed to load folders.');
          }
        }
        state.viewMode = newView;
        smartUpdate();
        
        // If switching to people view and a scan is running, auto-resume polling
        if (newView === 'people' && !_faceScanPollTimer) {
          try {
            const status = await apiFaceScanStatus();
            if (status.running) {
              void startFaceScan(); // will start polling
            }
          } catch { /* ignore */ }
        }
      }
    });
  });

  app.querySelectorAll('[data-action="set-filter"]').forEach((button) => {
    button.addEventListener('click', () => {
      const newFilter = (button as HTMLElement).dataset.filter as KindFilter;
      if (state.kindFilter !== newFilter) {
        state.kindFilter = newFilter;
        smartUpdate();
      }
    });
  });

  // Debounced search
  app.querySelector('#search-input')?.addEventListener('input', (event) => {
    const value = (event.target as HTMLInputElement).value;
    if (searchTimer !== undefined) {
      clearTimeout(searchTimer);
    }
    searchTimer = setTimeout(() => {
      state.search = value;
      smartUpdate();
      // Re-focus the search input after update
      const input = app.querySelector<HTMLInputElement>('#search-input');
      if (input) {
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      }
    }, SEARCH_DEBOUNCE_MS);
  });

  app.querySelector('[data-action="clear-search"]')?.addEventListener('click', () => {
    state.search = '';
    smartUpdate();
  });

  app.querySelector('[data-action="analyze"]')?.addEventListener('click', () => void analyzeDuplicates());
  app.querySelector('[data-action="refresh-metadata"]')?.addEventListener('click', () => void enrichMetadataBatch(state.items));
  app.querySelector('[data-action="copy-selected"]')?.addEventListener('click', () => void copySelected());
  app.querySelector('[data-action="delete-selected"]')?.addEventListener('click', () => void deleteSelected());

  wireInspectorEvents();
  wireInspectorDrag();

  // Content area card events
  const contentEl = document.getElementById('content-area');
  if (contentEl) {
    wireCardEvents(contentEl);
  }

  // Browser file inputs
  const fileInput = app.querySelector<HTMLInputElement>('#browser-file-input');
  fileInput?.addEventListener('change', () => {
    if (fileInput.files) {
      addBrowserFiles([...fileInput.files]);
    }
  });

  const folderInput = app.querySelector<HTMLInputElement>('#browser-folder-input');
  folderInput?.addEventListener('change', () => {
    if (folderInput.files) {
      addBrowserFiles([...folderInput.files]);
    }
  });

  // Empty state buttons inside content area
  wireContentEmptyActions();
}

function wireInspectorEvents(): void {
  const inspector = document.getElementById('inspector-panel');
  if (!inspector) return;

  inspector.querySelector('[data-action="close-inspector"]')?.addEventListener('click', closeInspector);
  inspector.querySelector('[data-action="open-active"]')?.addEventListener('click', () => void openActive());
  inspector.querySelector('[data-action="toggle-active-select"]')?.addEventListener('click', toggleActiveSelection);
  inspector.querySelector('[data-action="toggle-keep"]')?.addEventListener('click', toggleKeep);
  inspector.querySelector('[data-action="delete-active"]')?.addEventListener('click', () => void deleteActive());
  inspector.querySelectorAll('[data-action="add-person"]')?.forEach((button) => {
    button.addEventListener('click', addPerson);
  });

  inspector.querySelectorAll('[data-action="remove-person"]').forEach((button) => {
    button.addEventListener('click', () => removePerson((button as HTMLElement).dataset.person ?? ''));
  });

  inspector.querySelectorAll('[data-action="rename-person"]').forEach((span) => {
    span.addEventListener('click', () => promptRenamePerson((span as HTMLElement).dataset.person ?? ''));
  });
}

function wireInspectorDrag(): void {
  const dragHandle = document.getElementById('inspector-drag');
  const inspectorPanel = document.getElementById('inspector-panel');
  if (!dragHandle || !inspectorPanel) return;

  let isDragging = false;
  let startX = 0;
  let startWidth = 0;

  dragHandle.addEventListener('mousedown', (e) => {
    isDragging = true;
    startX = e.clientX;
    startWidth = inspectorPanel.getBoundingClientRect().width;
    dragHandle.classList.add('is-dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none'; // Prevent text selection during drag
  });

  window.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const deltaX = startX - e.clientX;
    const newWidth = startWidth + deltaX;
    
    // Limits are handled mostly by CSS min-width/max-width, 
    // but we can set the custom property directly.
    app.style.setProperty('--inspector-w', `${newWidth}px`);
  });

  window.addEventListener('mouseup', () => {
    if (isDragging) {
      isDragging = false;
      dragHandle.classList.remove('is-dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
  });
}

function wireCardEvents(container: Element): void {
  container.querySelectorAll<HTMLElement>('[data-action="toggle-select"]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      const id = button.dataset.id;
      if (id) {
        toggleSelection(id);
      }
    });
  });

  container.querySelectorAll<HTMLElement>('.media-card').forEach((card) => {
    card.addEventListener('click', () => {
      if (state.activeId !== card.dataset.id) {
        state.activeId = card.dataset.id;
        smartUpdate();
      }
    });
    card.addEventListener('dragstart', (event) => {
      const item = state.items.find((entry) => entry.id === card.dataset.id);
      if (!item || !event.dataTransfer) {
        return;
      }
      event.dataTransfer.setData('text/plain', item.path);
      event.dataTransfer.setData('text/uri-list', item.previewUrl ?? item.path);
      event.dataTransfer.effectAllowed = 'copy';
    });
  });

  // Wire empty-state action buttons inside content
  wireContentEmptyActions();
}

function wireContentEmptyActions(): void {
  const contentEl = document.getElementById('content-area');
  if (!contentEl) return;

  contentEl.querySelector('[data-action="add-folder"]')?.addEventListener('click', () => void addFolder());
  contentEl.querySelector('[data-action="add-files"]')?.addEventListener('click', () => void addFiles());
  contentEl.querySelector('[data-action="clear-search"]')?.addEventListener('click', () => {
    state.search = '';
    smartUpdate();
  });
  contentEl.querySelector('[data-action="analyze"]')?.addEventListener('click', () => void analyzeDuplicates());
  contentEl.querySelector('[data-action="scan-faces"]')?.addEventListener('click', () => void startFaceScan());
  
  contentEl.querySelectorAll<HTMLButtonElement>('.remove-folder-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      e.preventDefault();
      
      const folder = btn.dataset.folder;
      if (!folder) {
        setReady('Error: missing folder attribute on button.');
        return;
      }
      
      try {
        setBusy('Removing folder...');
        btn.disabled = true;
        await apiRemoveFolder(folder);
        
        // Refresh folder list
        state.folderStats = await apiGetFolders();
        setReady('Folder removed.');
        smartUpdate();
        
        // Also fully reload items to remove the items from timeline
        currentPage = 0;
        hasMore = true;
        await loadNextPage();
      } catch (err) {
        console.error(err);
        setReady('Failed to remove folder.');
        btn.disabled = false;
      }
    });
  });
}

let _faceScanPollTimer: ReturnType<typeof setInterval> | null = null;

async function startFaceScan(): Promise<void> {
  const btn = document.getElementById('scan-faces-btn') as HTMLButtonElement | null;
  if (btn) btn.disabled = true;

  try {
    const result = await apiAnalyzeFaces();
    if (result.status === 'already_running') {
      // Already running — just start polling
    }
    
    // Show progress bar
    const progressEl = document.getElementById('face-scan-progress');
    if (progressEl) progressEl.style.display = 'block';
    
    // Start polling for progress
    if (_faceScanPollTimer) clearInterval(_faceScanPollTimer);
    _faceScanPollTimer = setInterval(async () => {
      try {
        const status = await apiFaceScanStatus();
        const bar = document.getElementById('face-scan-bar');
        const label = document.getElementById('face-scan-label');
        const count = document.getElementById('face-scan-count');
        
        if (bar && status.total > 0) {
          bar.style.width = `${Math.round((status.done / status.total) * 100)}%`;
        }
        if (label) {
          label.textContent = status.running
            ? `Scanning ${status.current_file}...`
            : 'Scan complete!';
        }
        if (count && status.total > 0) {
          count.textContent = `${status.done} / ${status.total}`;
        }
        
        if (!status.running) {
          if (_faceScanPollTimer) clearInterval(_faceScanPollTimer);
          _faceScanPollTimer = null;
          
          // Refresh people data and re-render
          await refreshPeopleCache();
          for (const item of state.items) {
            const manualPeople = peopleStore[item.path] ?? [];
            const aiPeopleList = aiPeopleMap.get(item.id) ?? [];
            item.people = Array.from(new Set([...manualPeople, ...aiPeopleList]));
          }
          
          if (btn) btn.disabled = false;
          setReady('Face scan complete.');
          smartUpdate();
        }
      } catch (e) {
        console.error('Face scan poll error', e);
      }
    }, 1500);
  } catch (e) {
    console.error('Failed to start face scan', e);
    if (btn) btn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

let currentPage = 0;
const PAGE_SIZE = 50000;
let hasMore = true;
let isLoadingPage = false;

async function loadNextPage(): Promise<void> {
  if (isLoadingPage || !hasMore) return;
  isLoadingPage = true;
  setBusy('Loading media...');
  
  try {
    const data = await apiGetMedia(currentPage * PAGE_SIZE, PAGE_SIZE, state.kindFilter);
    if (currentPage === 0) {
      state.items = data.items;
    } else {
      state.items = [...state.items, ...data.items];
    }
    
    hasMore = state.items.length < data.total;
    currentPage += 1;
    
    // Auto-load metadata/people placeholders if needed
    for (const item of data.items) {
      const manualPeople = peopleStore[item.path] ?? [];
      const aiPeopleList = aiPeopleMap.get(item.id) ?? [];
      item.people = Array.from(new Set([...manualPeople, ...aiPeopleList]));
    }
    
    setReady(`Showing ${state.items.length} of ${data.total}`);
    fullRender();
  } catch (err) {
    setReady('Error connecting to backend');
  } finally {
    isLoadingPage = false;
  }
}

async function addFolder(): Promise<void> {
  let folder: string | null = null;

  // 1. Prefer Neutralino native folder dialog — works on all platforms (Windows,
  //    macOS, Linux) without requiring the backend to be running.
  // @ts-ignore
  if (typeof window.Neutralino !== 'undefined') {
    try {
      // @ts-ignore
      const result = await window.Neutralino.os.showFolderDialog('Select a folder to scan');
      folder = result ?? null;
    } catch (e) {
      console.warn('Neutralino folder dialog failed, falling back to backend API', e);
    }
  }

  // 2. Fallback: ask the backend to open a system dialog (macOS / Linux zenity)
  if (!folder) {
    folder = await apiPickFolder();
  }

  // No selection made (user cancelled or both APIs unavailable)
  if (!folder) return;

  try {
    setBusy(`Scanning ${folder}...`);
    const addedCount = await apiScanFolder(folder);
    setReady(`Added ${addedCount} media files.`);
    
    // Reset and reload
    currentPage = 0;
    hasMore = true;
    await loadNextPage();
    
    if (state.viewMode === 'manage-folders') {
      state.folderStats = await apiGetFolders();
      smartUpdate();
    }
  } catch (error) {
    setReady('Failed to scan folder.');
  }
}

async function addFiles(): Promise<void> {
  alert('Please use "Add folder" to scan server directories instead.');
}

function addBrowserFiles(files: File[]): void {
  alert('Browser upload not implemented in API version yet. Use Add Folder.');
}

function mergeItems(items: MediaItem[]): void {
  // Deprecated in favor of backend API logic
}

async function enrichMetadataBatch(items: MediaItem[]): Promise<void> {
  const candidates = items
    .filter((item) => item.kind === 'image' && item.previewUrl)
    .slice(0, MAX_METADATA_BATCH);

  if (candidates.length === 0) {
    return;
  }

  setBusy(`Reading EXIF 0/${candidates.length}`);

  let completed = 0;
  await runWithLimit(candidates, 4, async (item) => {
    const metadata = await extractImageMetadata(item);
    Object.assign(item, metadata);
    completed += 1;

    if (completed % 25 === 0 || completed === candidates.length) {
      state.status = `Reading EXIF ${completed}/${candidates.length}`;
      updateStatusBar();
    }
  });

  setReady(`EXIF updated for ${completed} files.`);
}

async function enrichSingleItem(item: MediaItem): Promise<void> {
  const metadata = await extractImageMetadata(item);
  if (Object.keys(metadata).length > 0) {
    Object.assign(item, metadata);
    // Force inspector refresh by resetting prevActiveId
    prevActiveId = undefined;
    updateInspector();
  }
}

async function analyzeDuplicates(): Promise<void> {
  try {
    setBusy('Analyzing duplicates on backend...');
    await apiAnalyzeDuplicates();
    
    setBusy('Fetching duplicate groups...');
    const rawGroups = await apiGetDuplicates();
    
    // Map MediaItem[][] to DuplicateGroup[]
    state.duplicateGroups = rawGroups.map((items, index) => {
      // Also add these items to state.items if they aren't there so they can be rendered
      items.forEach(item => {
        if (!state.items.find(i => i.id === item.id)) {
          state.items.push(item);
        }
      });
      
      return {
        id: `group-${index}`,
        reason: 'similar',
        items: items
      };
    });
    
    // Switch to duplicates view
    state.viewMode = 'duplicates';
    updateGrid();
    updateSidebar();
    
    setReady(`Found ${state.duplicateGroups.length} groups of duplicates.`);
  } catch (error) {
    setReady('Failed to analyze duplicates.');
    console.error(error);
  }
}

async function copySelected(): Promise<void> {
  alert('Copy functionality is not yet implemented on the Python backend.');
}

async function openActive(): Promise<void> {
  const active = getActiveItem(state.items);
  if (active) {
    window.open(getFileUrl(active.id), '_blank', 'noopener,noreferrer');
  }
}

function toggleActiveSelection(): void {
  const active = getActiveItem(state.items);
  if (active) {
    toggleSelection(active.id);
  }
}

function toggleSelection(id: string): void {
  if (state.selectedIds.has(id)) {
    state.selectedIds.delete(id);
  } else {
    state.selectedIds.add(id);
  }
  smartUpdate();
}

function toggleKeep(): void {
  const active = getActiveItem(state.items);
  if (!active) {
    return;
  }

  if (state.keepIds.has(active.id)) {
    state.keepIds.delete(active.id);
  } else {
    state.keepIds.add(active.id);
  }

  saveStringSet(KEEP_STORAGE_KEY, state.keepIds);

  // Force inspector refresh
  prevActiveId = undefined;
  smartUpdate();
}

// ---------------------------------------------------------------------------
// Deletion
// ---------------------------------------------------------------------------

async function deleteActive(): Promise<void> {
  const active = getActiveItem(state.items);
  if (active) {
    await deleteFiles(new Set([active.id]));
  }
}

async function deleteSelected(): Promise<void> {
  await deleteFiles(state.selectedIds);
}

async function deleteFiles(ids: Set<string>): Promise<void> {
  if (ids.size === 0) {
    return;
  }

  const count = ids.size;
  const firstConfirm = confirm(`Are you sure you want to permanently delete these ${count} file(s) from your disk? This cannot be undone.`);
  if (!firstConfirm) return;

  const secondConfirm = confirm(`FINAL WARNING: These ${count} file(s) will be permanently deleted from your computer. Proceed?`);
  if (!secondConfirm) return;

  const toDelete = state.items.filter((item) => ids.has(item.id));
  const paths = toDelete.map((item) => item.path);

  setBusy(`Deleting ${count} files...`);
  const deletedCount = await apiDeleteFiles(paths);

  if (deletedCount > 0) {

    state.items = state.items.filter((item) => !ids.has(item.id));
    for (const id of ids) {
      state.selectedIds.delete(id);
      state.keepIds.delete(id);
    }

    saveStringSet(SELECTED_STORAGE_KEY, state.selectedIds);
    saveStringSet(KEEP_STORAGE_KEY, state.keepIds);

    // If deleting active item, close inspector
    if (state.activeId && ids.has(state.activeId)) {
      state.activeId = undefined;
    }

    setReady(`Successfully deleted ${deletedCount} file(s).`);
    smartUpdate();
  } else {
    setReady('Failed to delete files.');
  }
}

function addPerson(): void {
  const active = getActiveItem(state.items);
  const input = app.querySelector<HTMLInputElement>('#person-input');
  const person = input?.value.trim();

  if (!active || !person) {
    return;
  }

  const people = new Set(active.people ?? []);
  people.add(person);
  active.people = [...people].sort((left, right) => left.localeCompare(right));
  peopleStore[active.path] = active.people;
  savePeopleStore();

  // Force inspector refresh
  prevActiveId = undefined;
  smartUpdate();
}

function removePerson(person: string): void {
  const active = getActiveItem(state.items);
  if (!active || !active.people) return;

  active.people = active.people.filter((p) => p !== person);
  peopleStore[active.path] = active.people;
  savePeopleStore();

  prevActiveId = undefined;
  smartUpdate();
}

async function promptRenamePerson(oldName: string): Promise<void> {
  const newName = prompt(`Rename "${oldName}" to:`, oldName);
  if (!newName || newName.trim() === '' || newName === oldName) return;
  
  try {
    setBusy(`Renaming ${oldName}...`);
    await apiRenamePerson(oldName, newName);
    
    // Update local state
    for (const item of state.items) {
      if (item.people?.includes(oldName)) {
        item.people = item.people.map((p) => (p === oldName ? newName : p));
      }
    }
    
    // Also update peopleStore to persist manual tags
    for (const [path, tags] of Object.entries(peopleStore)) {
      if (tags.includes(oldName)) {
        peopleStore[path] = tags.map((t) => (t === oldName ? newName : t));
      }
    }
    savePeopleStore();
    
    // Refresh ai cache
    await refreshPeopleCache();
    
    setReady('Renamed successfully.');
    prevActiveId = undefined;
    smartUpdate();
  } catch (e) {
    console.error(e);
    setReady('Failed to rename person.');
  }
}

// ---------------------------------------------------------------------------
// View helpers
// ---------------------------------------------------------------------------

function getGroupsForView(items: MediaItem[]): MediaGroup[] {
  switch (state.viewMode) {
    case 'folder':
      return buildFolderGroups(items);
    case 'kind':
      return buildKindGroups(items);
    case 'location':
      return buildLocationGroups(items);
    case 'people':
      return buildPeopleGroups(items);
    case 'timeline':
    default:
      return buildTimelineGroups(items);
  }
}

function getFilteredItems(): MediaItem[] {
  const query = state.search.trim().toLowerCase();

  return state.items.filter((item) => {
    if (state.kindFilter !== 'all' && item.kind !== state.kindFilter) {
      return false;
    }

    if (!query) {
      return true;
    }

    const people = item.people?.join(' ') ?? '';
    return `${item.name} ${item.folder} ${people}`.toLowerCase().includes(query);
  });
}

function getSelectedItems(): MediaItem[] {
  return state.items.filter((item) => state.selectedIds.has(item.id));
}

function getActiveItem(scope: MediaItem[]): MediaItem | undefined {
  if (!state.activeId) return undefined;
  return scope.find((item) => item.id === state.activeId);
}

function getStats(): { total: number; images: number; videos: number; bytes: number } {
  return state.items.reduce(
    (stats, item) => ({
      total: stats.total + 1,
      images: stats.images + (item.kind === 'image' ? 1 : 0),
      videos: stats.videos + (item.kind === 'video' ? 1 : 0),
      bytes: stats.bytes + item.size
    }),
    { total: 0, images: 0, videos: 0, bytes: 0 }
  );
}

function updateProgress(progress: any): void {
  setBusy(`${progress.label} (${progress.current}/${progress.total})`);
}

function setBusy(status: string): void {
  state.status = status;
  state.busy = true;
  updateStatusBar();
}

let aiPeopleMap: Map<string, string[]> = new Map();

async function refreshPeopleCache(): Promise<void> {
  try {
    const aiPeople = await apiGetPeople();
    const map = new Map<string, Set<string>>();
    for (const [name, faces] of Object.entries(aiPeople)) {
        for (const face of faces) {
           if (!map.has(face.item_id)) map.set(face.item_id, new Set());
           map.get(face.item_id)!.add(name);
        }
    }
    aiPeopleMap = new Map();
    for (const [itemId, names] of map.entries()) {
        aiPeopleMap.set(itemId, Array.from(names));
    }
  } catch (e) {
    console.error("Failed to fetch AI people", e);
  }
}

function setReady(status: string): void {
  state.status = status;
  state.busy = false;
  updateStatusBar();
}

function bindGlobalDrop(): void {
  window.addEventListener('dragover', (event) => {
    event.preventDefault();
  });

  window.addEventListener('drop', (event) => {
    event.preventDefault();
    const files = event.dataTransfer?.files;
    if (files?.length) {
      addBrowserFiles([...files]);
    }
  });
}

async function runWithLimit<T>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<void>
): Promise<void> {
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      await task(items[index]);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker())
  );
}

function formatCoords(latitude: number, longitude: number): string {
  return `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
}

function loadPeopleStore(): Record<string, string[]> {
  try {
    return JSON.parse(localStorage.getItem(PEOPLE_STORAGE_KEY) ?? '{}') as Record<string, string[]>;
  } catch {
    return {};
  }
}

function savePeopleStore(): void {
  localStorage.setItem(PEOPLE_STORAGE_KEY, JSON.stringify(peopleStore));
}

function loadStringSet(key: string): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(key) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

function saveStringSet(key: string, values: Set<string>): void {
  localStorage.setItem(key, JSON.stringify([...values]));
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function escapeAttr(value: string): string {
  return escapeHtml(value);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === 'object' && error && 'message' in error) {
    return String((error as { message: unknown }).message);
  }

  return String(error);
}

initializeApp();
