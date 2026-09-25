/** Standalone review page. No device assignment, microphone, or engine lifecycle. */
import { RecordingsPanel } from './panel.js';

export function navigateReviewLink(event, path) {
  if (event.button > 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  // HA's SPA navigation keeps an already-running local satellite alive.
  window.history.pushState({}, '', path);
  window.dispatchEvent(new CustomEvent('location-changed', { composed: true }));
}

export class VoiceSatelliteRecordingsPage extends HTMLElement {
  constructor() {
    super();
    this._hass = null;
    this._narrow = false;
  }

  set hass(hass) {
    this._hass = hass;
    if (this.isConnected) this._mount();
    if (this._menu) this._menu.hass = hass;
    this._review?.update();
  }

  set narrow(narrow) {
    this._narrow = narrow;
    if (this._menu) this._menu.narrow = narrow;
  }

  set panel(_panel) {}
  set route(_route) {}

  connectedCallback() { this._mount(); }

  _mount() {
    if (this._review || !this._hass) return;
    const style = document.createElement('style');
    style.textContent = `voice-satellite-recordings-panel{display:block;height:100%;overflow:auto;background:var(--primary-background-color,#fafafa);color:var(--primary-text-color,#212121)}
      .vsr-toolbar{display:flex;align-items:center;gap:16px;min-height:64px;padding:0 16px;background:var(--app-header-background-color,#03a9f4);color:var(--app-header-text-color,#fff)}
      .vsr-toolbar h1{font-size:20px;font-weight:500;margin:0}.vsr-content{box-sizing:border-box;max-width:1050px;margin:auto;padding:24px 16px}
      .vsr-tabs{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 20px}.vsr-tabs a,.vsr-tabs span{padding:12px 16px;border-radius:8px;text-decoration:none;color:var(--primary-color,#0288d1);border:1px solid var(--divider-color,#ddd)}
      .vsr-tabs span{background:var(--secondary-background-color,#eee);color:var(--primary-text-color,#212121)}
      .vsr-inbox{padding:20px;background:var(--card-background-color,#fff);border-radius:12px;border:1px solid var(--divider-color,#ddd)}
      .vsr-inbox button,.vsr-inbox select,.vsr-inbox input{min-height:44px!important}.vsr-inbox article{padding:20px 0!important}
      @media(max-width:600px){.vsr-content{padding:16px 8px}.vsr-inbox{padding:16px 12px}.vsr-inbox select{max-width:100%}}`;
    const toolbar = document.createElement('header'); toolbar.className = 'vsr-toolbar';
    this._menu = document.createElement('ha-menu-button'); this._menu.hass = this._hass; this._menu.narrow = this._narrow;
    const title = document.createElement('h1'); title.textContent = 'Wake recordings';
    toolbar.append(this._menu, title);
    const content = document.createElement('main'); content.className = 'vsr-content';
    const navigation = document.createElement('nav'); navigation.className = 'vsr-tabs'; navigation.setAttribute('aria-label', 'Voice Satellite');
    const settings = document.createElement('a'); settings.href = '/voice-satellite'; settings.textContent = 'This device';
    settings.addEventListener('click', event => navigateReviewLink(event, '/voice-satellite'));
    const current = document.createElement('span'); current.textContent = 'Recordings review'; current.setAttribute('aria-current', 'page');
    navigation.append(settings, current);
    const host = document.createElement('section'); host.className = 'vsr-inbox';
    content.append(navigation, host); this.replaceChildren(style, toolbar, content);
    this._review = new RecordingsPanel({ host, getHass: () => this._hass, standalone: true,
      // Existing local playback protection is the only interaction with a runtime.
      getSession: () => window.__vsSession || null });
    this._review.mount();
  }

  disconnectedCallback() {
    this._review?.destroy(); this._review = null;
  }
}

if (!customElements.get('voice-satellite-recordings-panel')) {
  customElements.define('voice-satellite-recordings-panel', VoiceSatelliteRecordingsPage);
}
