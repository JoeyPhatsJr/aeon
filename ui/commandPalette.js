// ui/commandPalette.js
// Searchable command palette (opened with /). Actions, plus dynamically-injected species and
// event entries. Keyboard-first: arrow keys to move, Enter to run, Escape to close. Fully ARIA
// (listbox/option). Consumes a command list; each command is { id, label, run }.

export class CommandPalette {
  constructor(overlayEl, inputEl, listEl) {
    this.overlay = overlayEl;
    this.input = inputEl;
    this.list = listEl;
    this.commands = [];
    this.dynamic = [];
    this.matches = [];
    this.sel = 0;

    this.input.addEventListener('input', () => this.render(this.input.value));
    this.overlay.addEventListener('click', (e) => { if (e.target === this.overlay) this.close(); });
  }

  setCommands(list) { this.commands = list; }
  setDynamic(list) { this.dynamic = list || []; }

  open() {
    this.overlay.classList.add('open');
    this.input.value = '';
    this.render('');
    this.input.focus();
  }
  close() { this.overlay.classList.remove('open'); }
  isOpen() { return this.overlay.classList.contains('open'); }

  render(query) {
    const q = (query || '').toLowerCase();
    const all = this.commands.concat(this.dynamic);
    this.matches = q ? all.filter((c) => c.label.toLowerCase().includes(q)) : all.slice(0, 30);
    this.sel = 0;
    this.list.innerHTML = '';
    for (let i = 0; i < this.matches.length; i++) {
      const c = this.matches[i];
      const li = document.createElement('li');
      li.textContent = c.label;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', i === 0 ? 'true' : 'false');
      li.addEventListener('click', () => { c.run(); this.close(); });
      this.list.appendChild(li);
    }
  }

  onKey(e) {
    if (!this.isOpen()) return false;
    if (e.key === 'Escape') { this.close(); e.preventDefault(); return true; }
    if (e.key === 'ArrowDown') { this.sel = Math.min(this.matches.length - 1, this.sel + 1); this._sync(); e.preventDefault(); return true; }
    if (e.key === 'ArrowUp') { this.sel = Math.max(0, this.sel - 1); this._sync(); e.preventDefault(); return true; }
    if (e.key === 'Enter') { if (this.matches[this.sel]) { this.matches[this.sel].run(); this.close(); } e.preventDefault(); return true; }
    return true; // swallow other keys while open
  }

  _sync() {
    const items = this.list.querySelectorAll('li');
    items.forEach((li, i) => {
      li.setAttribute('aria-selected', i === this.sel ? 'true' : 'false');
      if (i === this.sel) li.scrollIntoView({ block: 'nearest' });
    });
  }
}
