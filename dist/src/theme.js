// Theme switch: dark (the original Pi look) and light (edulab colours). Loaded as a classic script
// before the module bundle, so <html data-theme> is set before first paint and the Pi terminal
// palette is swapped in place before the terminal is created (the bundle calls __applyPiTheme right
// after defining its palette objects, and exposes __piTerminal / __piTui for live switching).
(function () {
  "use strict";

  // ─── Constants ───
  const STORAGE_KEY = 'web-pi-theme';
  const THEME_COLOR = { dark: '#18181e', light: '#F5F3F0' };
  // Pi TUI palette for the light theme: edulab ink/stone; coloured text uses edulab hues darkened to >= 4.6:1 on stone #EAE6E0.
  const LIGHT_PI = {
    vars: {
      cyan: '#1E8FC2', blue: '#177AA8', green: '#06753B', red: '#C42722', yellow: '#935700',
      text: '#1C1917', gray: '#625B53', dimGray: '#6D655C', darkGray: '#C9C2B7', accent: '#146D97',
      selectedBg: '#EAE6E0', userMsgBg: '#F5F3F0', toolPendingBg: '#F5F3F0', toolSuccessBg: '#EDF5EF',
      toolErrorBg: '#FBEDEC', customMsgBg: '#F1EDF8',
    },
    colors: {
      customMessageLabel: '#7254B6', mdHeading: '#1C1917', mdLink: '#146D97',
      syntaxComment: '#526D48', syntaxKeyword: '#7254B6', syntaxFunction: '#7A4E00', syntaxVariable: '#0F5E85',
      syntaxString: '#A3361F', syntaxNumber: '#06753B', syntaxType: '#146D97', syntaxOperator: '#44403C',
      syntaxPunctuation: '#44403C', thinkingMinimal: '#6D655C', thinkingLow: '#3A6992', thinkingMedium: '#146D97',
      thinkingHigh: '#7254B6', thinkingXhigh: '#943CB8', thinkingMax: '#B0279E',
    },
    export: { pageBg: '#FFFFFF', cardBg: '#F5F3F0', infoBg: '#FFF4C2' },
    dg: { muted: '#625B53', toolOutput: '#44403C', thinkingText: '#625B53', dim: '#6D655C', mdLinkUrl: '#6D655C', mdCodeBlockBorder: '#C9C2B7', mdQuote: '#625B53' },
    ansi: { black: '#EAE6E0', brightBlack: '#625B53', white: '#44403C', brightWhite: '#1C1917' },
  };
  const DARK_ANSI = { black: '#18181e', brightBlack: '#9696a4', white: '#d4d4d4', brightWhite: '#f2f2f4' };

  // ─── State ───
  let current = initialTheme();
  let darkPi = null;   // snapshot of the bundle's own palette, taken before the first change
  let translation = null;   // inactive-palette colour -> active-palette colour, for baked terminal text

  // ─── Helpers ───
  function initialTheme() {
    let saved = null;
    try { saved = localStorage.getItem(STORAGE_KEY); } catch { /* storage blocked */ }
    if (saved === 'light' || saved === 'dark') return saved;
    return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }

  function snapshot({ ug, dg }) {
    return { vars: { ...ug.vars }, colors: { ...ug.colors }, export: { ...ug.export }, dg: { ...dg }, ansi: DARK_ANSI };
  }

  function applyPiTheme() {
    const pi = globalThis.__piTheme;
    if (!pi) return;
    darkPi ??= snapshot(pi);
    const source = current === 'light' ? LIGHT_PI : darkPi;
    Object.assign(pi.ug.vars, source.vars);
    Object.assign(pi.ug.colors, source.colors);
    Object.assign(pi.ug.export, source.export);
    Object.assign(pi.dg, source.dg);
  }

  // Resolve a Pi colour key the way the bundle's fg() does: dg first, then a var name, then a literal.
  function resolve(palette, key) {
    const value = palette.dg[key] ?? palette.vars[palette.colors[key]] ?? palette.colors[key] ?? palette.vars[key];
    return typeof value === 'string' && value.startsWith('#') ? value.slice(0, 7).toUpperCase() : null;
  }

  // Map every colour of one palette to its counterpart in the other (first mapping wins).
  function colourMap(from, to) {
    const map = new Map();
    const keys = [...Object.keys(from.dg), ...Object.keys(from.colors), ...Object.keys(from.vars), ...Object.keys(from.export)];
    for (const key of keys) {
      const a = resolve(from, key) ?? from.export[key]?.toUpperCase(), b = resolve(to, key) ?? to.export[key]?.toUpperCase();
      if (a && b && a !== b && !map.has(a)) map.set(a, b);
    }
    return map;
  }

  // Some Pi text is built once with its colour codes baked in; translate truecolor SGR codes on output.
  function hookTerminal(terminal) {
    if (terminal.__themeHooked) return;
    terminal.__themeHooked = true;
    const write = terminal.write.bind(terminal);
    const hex = n => Number(n).toString(16).padStart(2, '0').toUpperCase();
    terminal.write = (data, callback) => {
      if (typeof data === 'string' && translation) {
        data = data.replace(/\x1b\[(38|48);2;(\d+);(\d+);(\d+)m/g, (match, kind, r, g, b) => {
          const target = translation.get(`#${hex(r)}${hex(g)}${hex(b)}`);
          if (!target) return match;
          const [tr, tg, tb] = [1, 3, 5].map(i => parseInt(target.slice(i, i + 2), 16));
          return `\x1b[${kind};2;${tr};${tg};${tb}m`;
        });
      }
      return write(data, callback);
    };
  }

  function terminalTheme() {
    const { ug } = globalThis.__piTheme;
    return {
      background: ug.export.pageBg, foreground: ug.vars.text, cursor: ug.vars.accent, cursorAccent: ug.export.pageBg,
      selectionBackground: ug.vars.selectedBg, selectionForeground: ug.vars.text,
      ...(current === 'light' ? LIGHT_PI.ansi : DARK_ANSI),
    };
  }

  function setTheme(name) {
    current = name;
    try { localStorage.setItem(STORAGE_KEY, name); } catch { /* storage blocked */ }
    render();
    applyPiTheme();
    const terminal = globalThis.__piTerminal;
    if (terminal && globalThis.__piTheme) {
      const light = { ...LIGHT_PI, vars: { ...darkPi.vars, ...LIGHT_PI.vars }, colors: { ...darkPi.colors, ...LIGHT_PI.colors }, dg: { ...darkPi.dg, ...LIGHT_PI.dg } };
      translation = name === 'light' ? colourMap(darkPi, light) : colourMap(light, darkPi);
      hookTerminal(terminal);
      terminal.options.theme = terminalTheme();
    }
    globalThis.__piTui?.invalidate?.();         // components cache their coloured lines
    globalThis.__piTui?.requestRender(true);   // full repaint with the new palette
    window.dispatchEvent(new CustomEvent('themechange', { detail: { theme: name } }));
  }

  // ─── Render ───
  function render() {
    const root = document.documentElement;
    root.dataset.theme = current;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[current]);
    const button = document.querySelector('#theme-toggle');
    if (!button) return;
    const next = current === 'light' ? 'dark' : 'light';
    button.dataset.theme = current;
    button.setAttribute('aria-label', `Switch to ${next} theme`);
    button.title = `Switch to ${next} theme (Alt+Shift+T)`;
  }

  // ─── Listeners ───
  function toggle() { setTheme(current === 'light' ? 'dark' : 'light'); }
  document.addEventListener('click', event => { if (event.target.closest?.('#theme-toggle')) toggle(); });
  // Capture phase: the chat terminal would otherwise take the keystroke.
  window.addEventListener('keydown', event => {
    if (event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey && event.code === 'KeyT') {
      event.preventDefault();
      event.stopPropagation();
      toggle();
    }
  }, true);

  // ─── Init ───
  globalThis.__applyPiTheme = applyPiTheme;
  globalThis.__setTheme = setTheme;
  render();
  document.addEventListener('DOMContentLoaded', render);
})();
