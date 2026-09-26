/** Standalone review page. No device assignment, microphone, or engine lifecycle. */
import { RecordingsPanel } from './panel.js';
import { RECORDINGS_PAGE_STYLES } from './styles.js';

export function navigateReviewLink(event, path) {
  if (event.button > 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) {
    return;
  }
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
    if (this.isConnected) {
      this._mount();
    }
    if (this._menu) {
      this._menu.hass = hass;
    }
    this._review?.update();
  }

  set narrow(narrow) {
    this._narrow = narrow;
    if (this._menu) {
      this._menu.narrow = narrow;
    }
  }

  set panel(_panel) {}

  set route(_route) {}

  connectedCallback() {
    this._mount();
  }

  _mount() {
    if (this._review || !this._hass) {
      return;
    }
    const style = document.createElement('style');
    style.textContent = RECORDINGS_PAGE_STYLES;
    const toolbar = document.createElement('header');
    toolbar.className = 'vsr-toolbar';
    this._menu = document.createElement('ha-menu-button');
    this._menu.hass = this._hass;
    this._menu.narrow = this._narrow;
    const title = document.createElement('h1');
    title.textContent = 'Wake recordings';
    toolbar.append(this._menu, title);
    const content = document.createElement('main');
    content.className = 'vsr-content';
    const navigation = document.createElement('nav');
    navigation.className = 'vsr-tabs';
    navigation.setAttribute('aria-label', 'Voice Satellite');
    const settings = document.createElement('a');
    settings.href = '/voice-satellite';
    settings.textContent = 'This device';
    settings.addEventListener('click', (event) => navigateReviewLink(event, '/voice-satellite'));
    const current = document.createElement('span');
    current.textContent = 'Recordings review';
    current.setAttribute('aria-current', 'page');
    navigation.append(settings, current);
    const host = document.createElement('section');
    host.className = 'vsr-inbox';
    content.append(navigation, host);
    this.replaceChildren(style, toolbar, content);
    this._review = new RecordingsPanel({
      host,
      getHass: () => this._hass,
      standalone: true,
      // Existing local playback protection is the only interaction with a runtime.
      getSession: () => window.__vsSession || null,
    });
    this._review.mount();
  }

  disconnectedCallback() {
    this._review?.destroy();
    this._review = null;
  }
}
if (!customElements.get('voice-satellite-recordings-panel')) {
  customElements.define('voice-satellite-recordings-panel', VoiceSatelliteRecordingsPage);
}
