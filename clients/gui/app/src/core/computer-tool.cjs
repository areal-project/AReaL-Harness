'use strict';

const operations = Object.freeze({
  describe: [],
  list_apps: [],
  list_windows: ['app_ref'],
  get_app_state: ['app_ref', 'include_screenshot', 'disable_diffing', 'tree_shown_to_model'],
  left_click: ['app_ref', 'target', 'state_id', 'mouse_button', 'click_count', 'modifiers', 'strategy', 'return_state'],
  left_click_drag: ['app_ref', 'from_target', 'to', 'state_id', 'modifiers', 'return_state'],
  scroll: ['app_ref', 'target', 'state_id', 'scroll_direction', 'scroll_amount', 'strategy', 'return_state'],
  type: ['app_ref', 'target', 'state_id', 'text', 'strategy', 'return_state'],
  set_value: ['app_ref', 'target', 'state_id', 'value', 'strategy', 'return_state'],
  select_text: ['app_ref', 'target', 'state_id', 'text_range', 'return_state'],
  key: ['app_ref', 'text', 'repeat', 'hold_seconds', 'strategy', 'return_state'],
  perform_action: ['app_ref', 'target', 'state_id', 'action', 'return_state'],
  paste: ['app_ref', 'text', 'format', 'return_state'],
  request_access: ['capabilities'],
  stop_computer_control: ['reason'],
});
const definition = Object.freeze({
  name: 'computer_v1',
  description: 'Control authorized local desktop applications. Call describe first. Get fresh app state before acting. OS permissions must be granted by the user in Computer control settings. Never replay an action whose dispatch is unknown.',
  inputSchema: { type: 'object', properties: { operation: { type: 'string' }, parameters: { type: 'object' } },
    required: ['operation', 'parameters'], additionalProperties: false },
});
function validComputerInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['operation', 'parameters'].includes(key))
    || !Object.hasOwn(operations, value.operation)
    || !value.parameters || typeof value.parameters !== 'object' || Array.isArray(value.parameters)
    || Object.keys(value.parameters).some(key => !operations[value.operation].includes(key))) return false;
  try { return Buffer.byteLength(JSON.stringify(value)) <= 1024 * 1024; } catch { return false; }
}
module.exports = { definition, operations, validComputerInput };
