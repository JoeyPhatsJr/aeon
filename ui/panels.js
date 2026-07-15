// ui/panels.js
// Manages the collapsible dockable panels and the icon rail. Only one panel is open at a time
// on the dock; toggling the active panel closes it. Keeps ARIA pressed-state on the rail in
// sync. Pure DOM; no sim coupling.

export class Panels {
  constructor(railEl, names) {
    this.rail = railEl;
    this.names = names; // e.g. ['life','world','chronicle','god']
    this.open = null;
    this.onOpen = null;
    railEl.querySelectorAll('button[data-panel]').forEach((btn) => {
      btn.addEventListener('click', () => this.toggle(btn.dataset.panel));
    });
  }

  toggle(name) {
    const section = document.getElementById('panel-' + name);
    if (this.open === name) {
      if (section) section.setAttribute('hidden', '');
      this.open = null;
    } else {
      // Hide all, show requested.
      for (let i = 0; i < this.names.length; i++) {
        const s = document.getElementById('panel-' + this.names[i]);
        if (s) s.setAttribute('hidden', '');
      }
      if (section) section.removeAttribute('hidden');
      this.open = name;
      if (this.onOpen) this.onOpen(name);
    }
    this._syncRail();
  }

  show(name) { if (this.open !== name) this.toggle(name); }

  _syncRail() {
    this.rail.querySelectorAll('button[data-panel]').forEach((btn) => {
      btn.setAttribute('aria-pressed', btn.dataset.panel === this.open ? 'true' : 'false');
    });
  }
}
