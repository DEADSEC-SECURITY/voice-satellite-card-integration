/** Server-backed persistence for browser panel profiles. */

const CONFIG_KEY = 'vs-panel-config';
const DEBUG_OVERRIDE_KEY = 'vs-debug-override';

function debugEnabled() {
  try {
    if (localStorage.getItem(DEBUG_OVERRIDE_KEY) === 'true') return true;
    const raw = localStorage.getItem(CONFIG_KEY);
    if (!raw) return false;
    return JSON.parse(raw)?.debug === true;
  } catch (_) {
    return false;
  }
}

function debugLog(message, data) {
  if (!debugEnabled()) return;
  if (data !== undefined) {
    console.debug(`[VS][panel-profile] ${message}`, data);
  } else {
    console.debug(`[VS][panel-profile] ${message}`);
  }
}

export async function loadPanelConfig(hass, entityId) {
  if (!hass?.connection || !entityId) return { exists: false, config: {} };
  try {
    const result = await hass.connection.sendMessagePromise({
      type: 'voice_satellite/get_panel_settings',
      entity_id: entityId,
    });
    debugLog(
      result?.exists ? 'Hydrated profile from Home Assistant' : 'No Home Assistant profile found',
      {
        entity_id: entityId,
        keys: Object.keys(result?.config || {}).length,
      },
    );
    // Starting this browser is a local preference, even when it displays a
    // shared station profile. A laptop Stop/auto-start choice must not change
    // the tablet's startup behavior on its next reload.
    if (result?.config) {
      result.config = { ...result.config };
      delete result.config.auto_start;
    }
    return result;
  } catch (err) {
    debugLog('Failed to hydrate profile from Home Assistant', {
      entity_id: entityId,
      error: err?.message || String(err),
    });
    return { exists: false, config: {} };
  }
}

export async function savePanelConfig(hass, entityId, config) {
  if (!hass?.connection || !entityId || !config) return false;
  try {
    const shared = { ...config, satellite_entity: entityId };
    delete shared.auto_start;
    await hass.connection.sendMessagePromise({
      type: 'voice_satellite/save_panel_settings',
      entity_id: entityId,
      config: shared,
    });
    debugLog('Pushed profile to Home Assistant', {
      entity_id: entityId,
      keys: Object.keys(config || {}).length,
    });
    return true;
  } catch (err) {
    debugLog('Failed to push profile to Home Assistant', {
      entity_id: entityId,
      error: err?.message || String(err),
    });
    return false;
  }
}
