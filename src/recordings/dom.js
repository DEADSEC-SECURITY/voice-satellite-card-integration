/** Small DOM helpers for the recording review controls. */
export function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) {
    node.textContent = text;
  }
  if (className) {
    node.className = className;
  }
  return node;
}

export function button(text, action) {
  const node = element('button', text);
  node.type = 'button';
  node.addEventListener('click', action);
  return node;
}

export function select(label, choices, selected) {
  const node = element('select');
  node.setAttribute('aria-label', label);
  for (const [value, text] of choices) {
    const option = element('option', text);
    option.value = value;
    node.appendChild(option);
  }
  node.value = selected;
  return node;
}
