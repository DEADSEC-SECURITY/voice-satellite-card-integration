/** Scoped styles shared by the production UI and local previews. */

export const RECORDINGS_PANEL_STYLES = /* css */ `
.vsp-recordings .row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin: 12px 0;
}
.vsp-recordings button,
.vsp-recordings select,
.vsp-recordings input {
  min-height: 38px;
  font: inherit;
  border: 1px solid var(--divider-color, #ccc);
  border-radius: 6px;
  padding: 6px 10px;
  color: var(--primary-text-color);
  background: var(--card-background-color);
}
.vsp-recordings button {
  cursor: pointer;
}
.vsp-recordings button:disabled {
  opacity: 0.5;
  cursor: default;
}
.vsp-recordings article {
  border-top: 1px solid var(--divider-color, #ddd);
  padding: 12px 0;
}
.vsp-recordings .hint {
  font-size: 13px;
  color: var(--secondary-text-color);
  line-height: 1.5;
}
.vsp-recordings .error {
  color: var(--error-color, #b00);
}
.vsp-recordings audio {
  width: 100%;
  margin-top: 8px;
}
.vsp-recordings input {
  width: 80px;
}
.vsp-recordings h3 {
  margin: 0 0 10px;
  font-size: 18px;
}
.vsp-recordings .review-fields {
  display: flex;
  flex-wrap: wrap;
  align-items: end;
  gap: 12px;
  margin: 12px 0;
}
.vsp-recordings .review-fields label {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.vsp-recordings .review-fields select {
  max-width: 100%;
  min-height: 44px;
}
.vsp-recordings .review-save {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin: 8px 0;
}
.vsp-recordings .review-save button {
  min-height: 44px;
  font-weight: 600;
}
.vsp-recordings .review-status {
  overflow-wrap: anywhere;
}
.vsp-recordings .short-clip {
  margin-top: 6px;
  font-weight: 600;
}
`;

export const RECORDINGS_PAGE_STYLES = /* css */ `
voice-satellite-recordings-panel {
  display: block;
  height: 100%;
  overflow: auto;
  background: var(--primary-background-color, #fafafa);
  color: var(--primary-text-color, #212121);
}
.vsr-toolbar {
  display: flex;
  align-items: center;
  gap: 16px;
  min-height: 64px;
  padding: 0 16px;
  background: var(--app-header-background-color, #03a9f4);
  color: var(--app-header-text-color, #fff);
}
.vsr-toolbar h1 {
  font-size: 20px;
  font-weight: 500;
  margin: 0;
}
.vsr-content {
  box-sizing: border-box;
  max-width: 1050px;
  margin: auto;
  padding: 24px 16px;
}
.vsr-tabs {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin: 0 0 20px;
}
.vsr-tabs a,
.vsr-tabs span {
  padding: 12px 16px;
  border-radius: 8px;
  text-decoration: none;
  color: var(--primary-color, #0288d1);
  border: 1px solid var(--divider-color, #ddd);
}
.vsr-tabs span {
  background: var(--secondary-background-color, #eee);
  color: var(--primary-text-color, #212121);
}
.vsr-inbox {
  padding: 20px;
  background: var(--card-background-color, #fff);
  border-radius: 12px;
  border: 1px solid var(--divider-color, #ddd);
}
.vsr-inbox button,
.vsr-inbox select,
.vsr-inbox input {
  min-height: 44px !important;
}
.vsr-inbox article {
  padding: 20px 0 !important;
}
@media (max-width: 600px) {
  .vsr-content {
    padding: 16px 8px;
  }
  .vsr-inbox {
    padding: 16px 12px;
  }
  .vsr-inbox select {
    max-width: 100%;
  }
}
`;

// A bottom card without a backdrop or focus trap leaves the next voice turn available.
export const RECORDING_FEEDBACK_STYLES = /* css */ `
.vsr-feedback {
  position: fixed;
  left: 50%;
  transform: translateX(-50%);
  bottom: max(12px, env(safe-area-inset-bottom));
  z-index: 10005;
  width: min(520px, calc(100% - 24px));
  max-height: calc(100vh - 24px);
  max-height: calc(100dvh - 24px);
  overflow: auto;
  box-sizing: border-box;
  padding: 20px;
  border: 1px solid var(--divider-color, #d7e1e8);
  border-radius: 24px;
  background: var(--card-background-color, #fff);
  color: var(--primary-text-color, #222);
  box-shadow: 0 8px 40px #0005;
  font: 16px/1.4 var(--paper-font-body1_-_font-family, Arial, sans-serif);
}
.vsr-feedback .vsr-feedback-button {
  min-height: 56px;
  box-sizing: border-box;
  padding: 12px 16px;
  border: 2px solid var(--divider-color, #c8d4dd);
  border-radius: 14px;
  background: var(--card-background-color, #fff);
  color: var(--primary-text-color, #222);
  font: inherit;
  font-weight: 600;
  line-height: 1.35;
  cursor: pointer;
  touch-action: manipulation;
}
.vsr-feedback .vsr-feedback-button.primary {
  padding: 12px;
  border-color: var(--primary-color, #0288d1);
  background: var(--primary-color, #0288d1);
  color: var(--text-primary-color, #fff);
}
.vsr-feedback .vsr-feedback-button:disabled {
  opacity: 0.55;
}
.vsr-feedback .vsr-feedback-button[aria-pressed='true'] {
  border-color: var(--primary-color, #0288d1);
  box-shadow: inset 0 0 0 1px var(--primary-color, #0288d1);
}
.vsr-feedback .vsr-feedback-button.later {
  width: 100%;
  margin-top: 10px;
  border-color: transparent;
  background: transparent;
  color: var(--secondary-text-color, #526573);
}
.vsr-feedback .vsr-feedback-progress {
  margin: 0 0 8px;
  color: var(--secondary-text-color, #526573);
  font-size: 14px;
  font-weight: 600;
}
.vsr-feedback h2 {
  margin: 0 0 8px;
  font-size: 24px;
  line-height: 1.25;
}
.vsr-feedback .vsr-feedback-hint {
  margin: 0 0 20px;
  color: var(--secondary-text-color, #526573);
}
.vsr-feedback .vsr-feedback-choices {
  display: grid;
  gap: 10px;
}
.vsr-feedback .vsr-feedback-actions {
  display: grid;
  grid-template-columns: 1fr 2fr;
  gap: 10px;
  margin-top: 20px;
}
.vsr-feedback .vsr-feedback-status {
  color: var(--error-color, #b42318);
  overflow-wrap: anywhere;
}
`;
