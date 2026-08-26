import { SETTING_DEFS, getSetting, setSetting } from './settings.js';

// Built straight from SETTING_DEFS so adding a new experiment to settings.js is enough to
// give it a control here.
export function createOptionsPanel() {
  const panel = document.createElement('div');
  panel.className = 'options-panel';

  for (const def of SETTING_DEFS) {
    const group = document.createElement('div');
    group.className = 'options-group';

    const heading = document.createElement('div');
    heading.className = 'options-group__label';
    heading.textContent = def.label;
    group.appendChild(heading);

    if (def.help) {
      const help = document.createElement('p');
      help.className = 'options-group__help';
      help.textContent = def.help;
      group.appendChild(help);
    }

    const choices = document.createElement('div');
    choices.className = 'options-choices';

    for (const option of def.options) {
      const id = `opt-${def.key}-${option.value}`;
      const label = document.createElement('label');
      label.className = 'options-choice';
      label.htmlFor = id;
      if (option.help) label.title = option.help;

      const input = document.createElement('input');
      input.type = 'radio';
      input.name = def.key;
      input.id = id;
      input.value = option.value;
      input.checked = getSetting(def.key) === option.value;
      input.addEventListener('change', () => {
        if (input.checked) setSetting(def.key, option.value);
      });

      const text = document.createElement('span');
      text.textContent = option.label;

      label.append(input, text);
      choices.appendChild(label);
    }

    group.appendChild(choices);

    // The per-option help is the useful part when judging these, so surface the selected
    // option's note under the group rather than hiding all of it behind tooltips.
    const detail = document.createElement('p');
    detail.className = 'options-group__detail';
    const renderDetail = () => {
      const current = def.options.find((o) => o.value === getSetting(def.key));
      detail.textContent = current?.help ?? '';
    };
    renderDetail();
    choices.addEventListener('change', renderDetail);
    group.appendChild(detail);

    panel.appendChild(group);
  }

  return panel;
}
