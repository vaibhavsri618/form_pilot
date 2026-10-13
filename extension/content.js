// Injected into every frame of the target tab (isolated world). Exposes
// window.__formPilot with find/fill/click helpers that the runner calls.
(() => {
  if (window.__formPilot) return;

  const FIELD = [
    'input:not([type=hidden]):not([type=button]):not([type=submit]):not([type=reset]):not([type=image])',
    'select', 'textarea', '[contenteditable=""]', '[contenteditable=true]',
    '[role=combobox]', '[role=textbox]', '[role=checkbox]', '[role=radio]', '[role=switch]',
    '[role=spinbutton]',
  ].join(',');
  const CLICKABLE = 'button,a,[role=button],[role=link],[role=tab],[role=menuitem],[role=option],' +
    'input[type=submit],input[type=button],input[type=reset],summary,label';

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  // Drops required/optional markers: "Legal Name * (required)" -> "Legal Name".
  const tidy = (s) => clean(s).replace(/\s*\((required|optional)\)\s*$/i, '').replace(/^[*\s]+|[\s*:]+$/g, '');
  const norm = (s) => tidy(s).toLowerCase();

  const isVisible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none';
  };
  // Checkboxes/radios/file inputs are often hidden behind styled replacements.
  const usable = (el) => ['checkbox', 'radio', 'file'].includes(el.type) || isVisible(el);

  // ------------------------------------------------------------- names

  // A label's own words, without the text of controls nested in it (e.g. a wrapped <select>'s options).
  const labelText = (l) => {
    if (!l.querySelector('select,textarea,[role=listbox],[role=combobox]')) return l.innerText;
    const copy = l.cloneNode(true);
    copy.querySelectorAll('select,textarea,[role=listbox],[role=combobox]').forEach((c) => c.remove());
    return copy.textContent;
  };

  const labelNames = (el) => {
    const out = [];
    const ids = el.getAttribute('aria-labelledby');
    if (ids) out.push(ids.split(/\s+/).map((id) => document.getElementById(id)?.innerText || '').join(' '));
    if (el.getAttribute('aria-label')) out.push(el.getAttribute('aria-label'));
    if (el.labels) for (const l of el.labels) out.push(labelText(l));
    const wrap = el.closest('label');
    if (wrap) out.push(labelText(wrap));
    return out.map(clean).filter(Boolean);
  };

  // Text just before an unlabelled control, e.g. <div>Mobile</div><div><input></div>.
  const CTRL = 'input,select,textarea,button,[role=combobox],[role=textbox]';
  const nearText = (el) => {
    for (let a = el, depth = 0; a && depth < 2; a = a.parentElement, depth += 1) {
      const p = a.previousElementSibling;
      if (!p) continue;
      if (p.matches(CTRL) || p.querySelector(CTRL)) return '';
      const t = clean(p.innerText);
      if (t && t.length <= 60) return t;
    }
    return '';
  };

  // A hidden <input type=file> is usually driven by an "Upload …" button beside it.
  const uploadButtonText = (el) => {
    if (el.type !== 'file') return '';
    const btn = el.parentElement?.querySelector('button,[role=button],label');
    return btn ? clean(btn.innerText) : '';
  };

  const fieldName = (el) => labelNames(el)[0] || clean(el.placeholder) || clean(el.title) ||
    nearText(el) || uploadButtonText(el) || clean(el.getAttribute('name') || el.id);

  const role = (el) => {
    const r = el.getAttribute('role');
    if (r) return r;
    const tag = el.tagName.toLowerCase();
    if (tag === 'select') return el.multiple ? 'listbox' : 'select';
    if (tag === 'textarea' || el.isContentEditable) return 'textbox';
    const t = (el.type || 'text').toLowerCase();
    if (['checkbox', 'radio', 'file', 'date', 'datetime-local', 'time', 'month', 'number'].includes(t)) return t;
    return 'textbox';
  };

  // ----------------------------------------------------------- locating

  const byPrefix = (key) => {
    if (key.startsWith('css:')) return document.querySelector(key.slice(4));
    if (key.startsWith('xpath:')) {
      return document.evaluate(key.slice(6), document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
    }
    return undefined;
  };

  // Finds the control that follows a piece of visible text, for apps whose
  // <label> is not wired to its input.
  const byNearbyText = (want, partial = false) => {
    const texts = [...document.querySelectorAll('label,legend,span,p,div,th,td,dt,strong,b,h4,h5,h6')]
      .filter((el) => el.children.length <= 3 && (partial ? norm(el.innerText).includes(want) : norm(el.innerText) === want))
      .sort((a, b) => (partial ? a.innerText.length - b.innerText.length : 0));
    for (const t of texts) {
      let anc = t;
      for (let depth = 0; anc && depth < 5; depth += 1, anc = anc.parentElement) {
        const hit = [...anc.querySelectorAll(FIELD)].find(
          (c) => usable(c) && (t.contains(c) || (t.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING)));
        if (hit) return hit;
      }
    }
    return null;
  };

  const findField = (key) => {
    const pref = byPrefix(key);
    if (pref !== undefined) return pref;
    const want = norm(key);
    const fields = [...document.querySelectorAll(FIELD)].filter(usable);
    const passes = [
      (el) => labelNames(el).some((n) => norm(n) === want),
      (el) => norm(el.placeholder) === want,
      (el) => ['name', 'id', 'formcontrolname'].some((a) => norm(el.getAttribute(a)) === want),
    ];
    for (const test of passes) {
      const hit = fields.find(test);
      if (hit) return hit;
    }
    const near = byNearbyText(want);
    if (near) return near;
    const partial = fields.find((el) => labelNames(el).some((n) => norm(n).includes(want)) ||
      norm(el.placeholder).includes(want));
    if (partial) return partial;
    const nearPartial = byNearbyText(want, true);
    if (nearPartial) return nearPartial;
    // e.g. an "Upload Certificate" button sitting next to a hidden <input type=file>
    return findClickable(key, true);
  };

  const clickName = (el) => clean(el.getAttribute('aria-label') || el.innerText || el.value || el.title);

  function findClickable(label, exactOnly = false) {
    const pref = byPrefix(label);
    if (pref !== undefined) return pref;
    if (label.startsWith('text:')) label = label.slice(5);
    const want = norm(label);
    const els = [...document.querySelectorAll(CLICKABLE)].filter(isVisible);
    let hit = els.find((el) => norm(clickName(el)) === want);
    if (hit || exactOnly) return hit || null;
    // Any visible element whose own text is exactly the label.
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (norm(n.textContent) === want && n.parentElement && isVisible(n.parentElement)) return n.parentElement;
    }
    hit = els.find((el) => el.matches('button,[role=button],input') && norm(clickName(el)).includes(want));
    return hit || null;
  }

  // ------------------------------------------------------------ actions

  const press = (el) => {
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    const o = { bubbles: true, cancelable: true, composed: true, button: 0, view: window };
    el.dispatchEvent(new PointerEvent('pointerdown', o));
    el.dispatchEvent(new MouseEvent('mousedown', o));
    el.focus?.();
    el.dispatchEvent(new PointerEvent('pointerup', o));
    el.dispatchEvent(new MouseEvent('mouseup', o));
    el.click();
  };

  const setNativeValue = (el, v) => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };

  const truthy = (v) => (typeof v === 'string'
    ? ['1', 'true', 'yes', 'y', 'on', 'checked', 'x'].includes(v.trim().toLowerCase()) : !!v);

  const waitFor = async (fn, ms) => {
    const end = Date.now() + ms;
    for (;;) {
      const r = fn();
      if (r || Date.now() > end) return r;
      await sleep(100);
    }
  };

  const fillText = (el, value) => {
    el.focus();
    if (el.isContentEditable) {
      document.execCommand('selectAll');
      document.execCommand('insertText', false, String(value));
    } else {
      setNativeValue(el, String(value));
    }
    el.blur();
    return `filled ${JSON.stringify(String(value).slice(0, 40))}`;
  };

  const fillSelect = (el, value) => {
    const wants = (Array.isArray(value) ? value : [value]).map(String);
    const opts = [...el.options];
    const pick = (w) => opts.find((o) => clean(o.label) === w || o.value === w)
      || opts.find((o) => norm(o.label) === norm(w))
      || opts.find((o) => norm(o.label).includes(norm(w)));
    const chosen = wants.map((w) => {
      const o = pick(w);
      if (!o) throw new Error(`No option like "${w}"; options: ${opts.map((x) => clean(x.label)).join(' | ')}`);
      return o;
    });
    if (el.multiple) {
      opts.forEach((o) => { o.selected = chosen.includes(o); });
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      setNativeValue(el, chosen[0].value);
    }
    return `selected ${chosen.map((o) => JSON.stringify(clean(o.label))).join(', ')}`;
  };

  const radioLabel = (r) => clean((r.labels && r.labels[0] && r.labels[0].innerText) || r.getAttribute('aria-label')
    || r.closest('label')?.innerText || (r.getAttribute('role') ? r.innerText : '')
    || r.nextElementSibling?.innerText || r.value);

  const fillRadio = (el, value) => {
    if (typeof value === 'boolean') {
      if (value && !isChecked(el)) press(el);
      return value ? 'checked' : 'left as is (radios cannot be unchecked)';
    }
    let group;
    if (el.name) group = [...document.querySelectorAll(`input[type=radio][name="${CSS.escape(el.name)}"]`)];
    else {
      const box = el.closest('[role=radiogroup],fieldset') || el.parentElement?.parentElement || document;
      group = [...box.querySelectorAll('input[type=radio],[role=radio]')];
    }
    const v = norm(String(value));
    const hit = group.find((r) => norm(radioLabel(r)) === v || norm(r.value) === v)
      || group.find((r) => norm(radioLabel(r)).includes(v));
    if (!hit) throw new Error(`No radio option "${value}"; choices: ${group.map(radioLabel).join(' | ')}`);
    if (!isChecked(hit)) press(hit);
    return `picked ${JSON.stringify(String(value))}`;
  };

  const radioGroupName = (el) => {
    const legend = el.closest('fieldset')?.querySelector('legend');
    if (legend) return tidy(legend.innerText);
    const rg = el.closest('[role=radiogroup]');
    return rg ? tidy(labelNames(rg)[0] || '') : '';
  };

  const isChecked = (el) => ('checked' in el ? el.checked : el.getAttribute('aria-checked') === 'true');

  const fillCheckbox = (el, value) => {
    const want = truthy(value);
    if (isChecked(el) !== want) press(el);
    return want ? 'checked' : 'unchecked';
  };

  const OPTION = '[role=option],mat-option,.ant-select-item-option,.dropdown-item,.select__option,li';
  const findOption = (v) => {
    const opts = [...document.querySelectorAll(OPTION)].filter(isVisible);
    const w = norm(v);
    return opts.find((o) => norm(o.innerText) === w) || opts.find((o) => norm(o.innerText).includes(w));
  };

  // MUI / AntD / Angular Material / react-select style dropdowns.
  const fillCombo = async (el, value) => {
    const values = (Array.isArray(value) ? value : [value]).map(String);
    for (const v of values) {
      press(el);
      let typed = false;
      if (el.tagName === 'INPUT' && !el.readOnly) {
        setNativeValue(el, v);
        typed = true;
      }
      const opt = await waitFor(() => findOption(v), 2500);
      if (opt) press(opt);
      else if (typed) {
        for (const type of ['keydown', 'keyup']) {
          el.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
        }
      } else throw new Error(`Dropdown opened but no option "${v}" appeared.`);
      await sleep(200);
    }
    return `chose ${values.map((v) => JSON.stringify(v)).join(', ')}`;
  };

  const b64ToFile = ({ name, type, b64 }) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], name, { type: type || 'application/octet-stream' });
  };

  const fileInputFor = (el) => {
    if (el.type === 'file') return el;
    for (let a = el, depth = 0; a && depth < 4; a = a.parentElement, depth += 1) {
      const inp = a.querySelector('input[type=file]');
      if (inp) return inp;
    }
    return null;
  };

  const fillFiles = (el, files) => {
    const input = fileInputFor(el);
    if (!input) throw new Error('No file input next to this field.');
    const dt = new DataTransfer();
    files.forEach((f) => dt.items.add(b64ToFile(f)));
    input.files = dt.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return `attached ${files.map((f) => f.name).join(', ')}`;
  };

  // ------------------------------------------------------- dummy values

  const digits = (n) => Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join('');
  const letters = (n) => Array.from({ length: n }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('');
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const pad2 = (n) => String(n).padStart(2, '0');
  const thisYear = new Date().getFullYear();

  // Produces a string that matches an HTML pattern="" (common subset of regex syntax).
  function sampleRegex(src) {
    try {
      const s = src.replace(/^\^/, '').replace(/\$$/, '');
      let i = 0;
      const span = (a, b) => Array.from({ length: b.charCodeAt(0) - a.charCodeAt(0) + 1 }, (_, k) => String.fromCharCode(a.charCodeAt(0) + k));
      const DIG = span('0', '9');
      const UP = span('A', 'Z');
      const LO = span('a', 'z');
      const W = [...UP, ...LO, ...DIG];
      const esc = (c) => ({ d: DIG, w: W, s: [' '], D: ['A'], W: ['-'], S: ['x'] }[c] || [c]);
      const parseClass = () => {
        let neg = false;
        if (s[i] === '^') { neg = true; i += 1; }
        const set = [];
        let first = true;
        while (i < s.length && (s[i] !== ']' || first)) {
          first = false;
          const c = s[i++];
          if (c === '\\') { set.push(...esc(s[i++])); continue; }
          if (s[i] === '-' && s[i + 1] && s[i + 1] !== ']') { set.push(...span(c, s[i + 1])); i += 2; } else set.push(c);
        }
        i += 1;
        const pool = neg ? W.filter((x) => !set.includes(x)) : set;
        return () => pick(pool.length ? pool : ['x']);
      };
      const lazy = () => { if (s[i] === '?') i += 1; };
      const parseQuant = () => {
        const c = s[i];
        if (c === '*') { i += 1; lazy(); return [0, 2]; }
        if (c === '+') { i += 1; lazy(); return [1, 3]; }
        if (c === '?') { i += 1; lazy(); return [0, 1]; }
        const m = c === '{' && /^\{(\d+)(,(\d*))?\}/.exec(s.slice(i));
        if (m) {
          i += m[0].length;
          lazy();
          const a = Number(m[1]);
          return [a, m[2] ? (m[3] ? Number(m[3]) : a + 2) : a];
        }
        return [1, 1];
      };
      let parseAlt;
      const parseAtom = () => {
        const c = s[i++];
        if (c === '(') {
          if (s[i] === '?') i += 2; // (?: … )
          const f = parseAlt();
          i += 1;
          return f;
        }
        if (c === '[') return parseClass();
        if (c === '\\') { const set = esc(s[i++]); return () => pick(set); }
        if (c === '.') return () => pick(LO);
        return () => c;
      };
      const parseSeq = () => {
        const items = [];
        while (i < s.length && s[i] !== '|' && s[i] !== ')') {
          const atom = parseAtom();
          const [min, max] = parseQuant();
          items.push(() => {
            let out = '';
            const n = min + Math.floor(Math.random() * (max - min + 1));
            for (let k = 0; k < n; k += 1) out += atom();
            return out;
          });
        }
        return () => items.map((f) => f()).join('');
      };
      parseAlt = () => {
        const branches = [parseSeq()];
        while (s[i] === '|') { i += 1; branches.push(parseSeq()); }
        return () => pick(branches)();
      };
      const gen = parseAlt();
      const re = new RegExp(`^(?:${src})$`);
      for (let t = 0; t < 25; t += 1) {
        const out = gen();
        if (re.test(out)) return out;
      }
    } catch {
      // unsupported syntax
    }
    return null;
  }

  const dateFor = (hint) => {
    const d = new Date();
    if (/birth|dob/.test(hint)) return new Date(1990, 4, 17);
    if (/expir|valid|till|until|end|due|renew|complet|launch|propos|plan|future|to date|deadline/.test(hint)) {
      d.setFullYear(d.getFullYear() + 1);
    } else {
      d.setFullYear(d.getFullYear() - 3);
    }
    return d;
  };

  const fmtDate = (d, placeholder) => {
    const [y, m, day] = [d.getFullYear(), pad2(d.getMonth() + 1), pad2(d.getDate())];
    const ph = (placeholder || '').toLowerCase();
    const sep = (/[/.-]/.exec(ph) || ['/'])[0];
    if (/^y/.test(ph)) return `${y}${sep}${m}${sep}${day}`;
    if (/^mm/.test(ph)) return `${m}${sep}${day}${sep}${y}`;
    return `${day}${sep}${m}${sep}${y}`; // dd/mm/yyyy, the usual Indian format
  };

  const sentence = (label) => {
    const topic = tidy(label).replace(/\(.*?\)/g, '').trim().toLowerCase().slice(0, 70);
    return `This is dummy text entered for testing${topic ? ` the "${topic}" field` : ''}. ` +
      'It is only sample content and can be replaced with real details later.';
  };

  const MONEY = /amount|cost|price|fee|turnover|revenue|capital|budget|salary|income|worth|\binr\b|\brs\b|rupee|lakh|crore/;
  const COUNT = /number of|no\.? of|count|quantity|how many|employees|staff|members/;

  function numberFor(el, hint) {
    let v = /year/.test(hint) ? thisYear - 3 : /percent|%|share|stake/.test(hint) ? 51
      : MONEY.test(hint) ? 1000000 : /latitude/.test(hint) ? 12.97 : /longitude/.test(hint) ? 77.59
        : /\bage\b/.test(hint) ? 35 : 10;
    const min = el.min !== '' && el.min != null ? Number(el.min) : null;
    const max = el.max !== '' && el.max != null ? Number(el.max) : null;
    if (min !== null && v < min) v = min;
    if (max !== null && v > max) v = max;
    const step = el.step && el.step !== 'any' ? Number(el.step) : null;
    if (step && min !== null) v = min + Math.round((v - min) / step) * step;
    return String(v);
  }

  /** A believable value for a text-like field, from its label/name/type. */
  function guessText(el, label) {
    const hint = norm([label, el.name, el.id, el.placeholder, el.getAttribute('autocomplete')].join(' '));
    const has = (re) => re.test(hint);
    const type = (el.type || '').toLowerCase();
    if (type === 'number' || el.getAttribute('role') === 'spinbutton') return numberFor(el, hint);
    if (type === 'email' || has(/e-?mail/)) return `test.user${digits(3)}@example.com`;
    if (type === 'url' || has(/website|\burl\b|domain|weblink/)) return 'https://www.example.com';
    if (type === 'password' || has(/password/)) return 'Dummy@12345';
    if (type === 'date' || type === 'datetime-local' || type === 'month' || type === 'week' || type === 'time') {
      const d = dateFor(hint);
      const iso = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
      return { date: iso, 'datetime-local': `${iso}T10:30`, month: iso.slice(0, 7), week: `${d.getFullYear()}-W10`, time: '10:30' }[type];
    }
    if (type === 'color') return '#3366cc';
    if (has(/\bpan\b/)) return `${letters(5)}${digits(4)}${letters(1)}`;
    if (has(/gst/)) return `29${letters(5)}${digits(4)}${letters(1)}1Z${digits(1)}`;
    if (has(/\bcin\b|corporate identi/)) return `U${digits(5)}KA${thisYear - 3}PTC${digits(6)}`;
    if (has(/llpin/)) return `AAA-${digits(4)}`;
    if (has(/aadh?aar/)) return `${2 + Math.floor(Math.random() * 8)}${digits(11)}`;
    if (has(/ifsc/)) return `SBIN0${digits(6)}`;
    if (has(/account (no|number)|bank account/)) return digits(12);
    if (has(/pin ?code|postal|zip|\bpin\b/)) return '560001';
    if (type === 'tel' || has(/mobile|phone|contact (no|number)|telephone|whatsapp|\bfax\b|\btel\b/)) return `9${digits(9)}`;
    if (has(/latitude/)) return '12.9716';
    if (has(/longitude/)) return '77.5946';
    if (has(/line ?2|landmark/)) return 'Near Metro Station';
    if (has(/address|street|line ?1|locality|premises/)) return '12, Test Street, Indiranagar';
    if (has(/\bcity\b|\btown\b|district|village|\bplace\b/)) return 'Bengaluru';
    if (has(/\bstate\b|province/)) return 'Karnataka';
    if (has(/compan|organi[sz]ation|entity|legal name|\bfirm\b|institut|employer|trade name|business name|applicant name|name of (the )?applicant/)) {
      return 'Dummy Technologies Pvt Ltd';
    }
    if (has(/brand/)) return 'DummyBrand';
    if (has(/first name|given name|\bfname\b/)) return 'Test';
    if (has(/last name|surname|family name|\blname\b/)) return 'User';
    if (has(/middle name/)) return 'Kumar';
    if (has(/father|mother|spouse|guardian/)) return 'Test Parent';
    if (has(/nationality|citizenship/)) return 'Indian';
    if (has(/country/)) return 'India';
    if (has(/name of (the )?(satellite|constellation|mission|project|payload|station|spacecraft|system)|(satellite|mission|project|constellation) name/)) return `DUMMYSAT-${digits(2)}`;
    if (has(/designation|job title|\bposition\b|\brole\b|occupation/)) return 'Director';
    if (has(/\bname\b|signatory|contact person|authori[sz]ed person|director|nominee/)) return 'Test User';
    if (has(/frequenc/)) return '14.25';
    // Technical quantities (satellite/engineering forms): plain numbers the form can validate.
    const MEASURES = [
      [/apogee.*perigee|perigee.*apogee/, '560, 540'], [/inclination/, '97.6'], [/eccentricity/, '0.001'],
      [/\bangle\b|phase angle|raan|argument of|longitude of/, '45'], [/apogee|perigee|altitude|orbit(al)? height/, '550'],
      [/propellant|fuel/, '40'], [/dry mass|wet mass|\bmass\b|weight/, '250'], [/power|\bwatt/, '1500'],
      [/dimension|\bsize\b/, '1.2 x 1.0 x 0.8 m'], [/diameter|length|width|height/, '1.5'],
      [/orbital period|\bperiod\b/, '95'], [/life ?time|\blife\b|duration/, '5'],
      [/bandwidth/, '36'], [/data rate|bit rate|throughput/, '100'], [/eirp|\bgain\b|g\/t/, '45'],
      [/temperature/, '25'], [/velocity|speed/, '7.6'], [/no\.? of planes|number of planes|\bplanes?\b/, '4'],
    ];
    const measure = !has(/\btype\b|\bwhether\b|\bname\b|describe|details/) && MEASURES.find(([re]) => has(re));
    if (measure) return measure[1];
    if (has(/year/)) return String(thisYear - 3);
    if (has(/\bage\b/)) return '35';
    if (has(/percent|%|share ?holding|stake/)) return '51';
    if (has(MONEY)) return '1000000';
    if (has(COUNT)) return '10';
    if (has(/date|dob/)) return fmtDate(dateFor(hint), el.placeholder);
    if (el.tagName === 'TEXTAREA' || el.isContentEditable ||
      has(/descri|detail|profile|remark|comment|purpose|justif|summary|brief|explain|reason|note|objective|scope|plan|experience/)) {
      return sentence(label);
    }
    if (has(/registration|licen[cs]e|certificate|reference|\bref\b|\bid\b|number|\bno\b/)) return `TEST${digits(6)}`;
    const short = tidy(label);
    return short && short.length <= 30 ? `Test ${short}` : 'Test value';
  }

  /** Set a text value, then bend it to maxlength/minlength/pattern/inputmode until the browser accepts it. */
  function setFitted(el, value) {
    let v = String(value);
    const numeric = /numeric|decimal|tel/.test(el.inputMode || '') && el.type !== 'email';
    if (numeric && /[^\d.]/.test(v)) v = digits(Math.min(10, el.maxLength > 0 ? el.maxLength : 10));
    if (el.maxLength > 0 && v.length > el.maxLength) v = v.slice(0, el.maxLength);
    if (el.minLength > 0 && v.length < el.minLength) v = v.padEnd(el.minLength, /^\d+$/.test(v) ? '0' : 'x');
    el.focus?.();
    if (el.isContentEditable) {
      document.execCommand('selectAll');
      document.execCommand('insertText', false, v);
    } else {
      setNativeValue(el, v);
      if (el.validity && !el.validity.valid && el.pattern) {
        const sample = sampleRegex(el.pattern);
        if (sample !== null) { v = sample; setNativeValue(el, v); }
      }
    }
    el.blur?.();
    return v;
  }

  const PLACEHOLDER_OPT = /^(select|choose|--|please|none selected|pick)/i;
  const OTHER_OPT = /^(\(\w\)\s*)?others?\b/i;
  // Prefer a regular answer over "Other(s)", which usually opens extra required fields.
  const preferRegular = (items, text) => {
    const regular = items.filter((x) => !OTHER_OPT.test(text(x)));
    return pick(regular.length ? regular : items);
  };

  const SKIP_ZONE = 'header,nav,footer,[role=search],[role=navigation],[role=banner],[role=contentinfo],[aria-hidden=true]';
  const SKIP_LABEL = /captcha|\botp\b|one[- ]time|search|feedback|newsletter|subscribe|marketing|promotion|remember me/i;

  const isEmptyField = (el) => {
    if (el.type === 'file') return !(el.files && el.files.length);
    if (el.tagName === 'SELECT') {
      const o = el.selectedOptions[0];
      return !o || o.value === '' || PLACEHOLDER_OPT.test(clean(o.label));
    }
    if (el.getAttribute('role') === 'combobox' && !('value' in el && el.tagName === 'INPUT')) {
      const t = clean(el.innerText);
      return !t || PLACEHOLDER_OPT.test(t);
    }
    if (el.isContentEditable) return !clean(el.innerText);
    return !String(el.value ?? '').trim();
  };

  const radioGroupOf = (el) => {
    if (el.name) return [...document.querySelectorAll(`input[type=radio][name="${CSS.escape(el.name)}"]`)];
    const box = el.closest('[role=radiogroup],fieldset') || el.parentElement?.parentElement || document;
    return [...box.querySelectorAll('input[type=radio],[role=radio]')];
  };

  const checkboxGroupOf = (el) => (el.name && el.type === 'checkbox'
    ? [...document.querySelectorAll(`input[type=checkbox][name="${CSS.escape(el.name)}"]`)] : [el]);

  async function pickFirstOption(el) {
    press(el);
    const opt = await waitFor(() => {
      const opts = [...document.querySelectorAll(OPTION)].filter((o) => isVisible(o) && !o.closest(SKIP_ZONE)
        && o.getAttribute('aria-disabled') !== 'true' && clean(o.innerText) && !PLACEHOLDER_OPT.test(clean(o.innerText)));
      return opts.length ? preferRegular(opts.slice(0, 8), (o) => clean(o.innerText)) : null;
    }, 2500);
    if (!opt) {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      throw new Error('dropdown showed no options');
    }
    const text = clean(opt.innerText);
    press(opt);
    await sleep(150);
    return text;
  }

  const EMPTY_TABLE = /^no (entries|rows|records|items|data|members|directors|details)( added| yet| found| available)?\.?$/i;
  const ADD_BTN = /^\+?\s*(add( a| new| another| one)?( row| entry| item| record| more| member| director| detail[s]?)?|new row|add more)$/i;

  /** For repeatable tables that are still empty ("No entries added"), click their Add button once. */
  function addFirstRows(root, clicked) {
    let n = 0;
    const empties = [...root.querySelectorAll('p,div,span,td,li,em')]
      .filter((e) => e.children.length <= 1 && EMPTY_TABLE.test(clean(e.innerText)) && isVisible(e));
    for (const e of empties) {
      for (let a = e.parentElement, depth = 0; a && a !== root.parentElement && depth < 5; a = a.parentElement, depth += 1) {
        const btn = [...a.querySelectorAll('button,[role=button]')]
          .find((b) => isVisible(b) && !b.disabled && ADD_BTN.test(clickName(b)) && !NEVER_BTN.test(clickName(b)));
        if (btn) {
          if (!clicked.has(btn)) { clicked.add(btn); press(btn); n += 1; }
          break;
        }
      }
    }
    return n;
  }

  /** Fill every empty field on the page with dummy data. File inputs are only tagged; the runner supplies files. */
  async function autofill({ overwrite = false } = {}) {
    const root = document.querySelector('main,[role=main]') || document.body;
    const handled = new Set();
    const filled = [];
    const files = [];
    const errors = [];
    const addClicked = new Set();
    for (let pass = 0; pass < 4; pass += 1) {
      let changed = 0;
      if (addFirstRows(root, addClicked)) {
        changed += 1;
        await sleep(300);
      }
      const els = [...root.querySelectorAll(FIELD)].filter((el) => !handled.has(el) && usable(el) && !el.disabled
        && !el.readOnly && !el.closest(SKIP_ZONE) && !el.closest('[role=listbox]'));
      for (const el of els) {
        if (handled.has(el)) continue;
        handled.add(el);
        const r = role(el);
        const label = tidy(r === 'radio' ? (radioGroupName(el) || fieldName(el)) : fieldName(el));
        if (SKIP_LABEL.test(`${label} ${el.name || ''} ${el.id || ''}`)) continue;
        try {
          if (r === 'file') {
            if (!overwrite && el.files && el.files.length) continue;
            el.dataset.fpFile = String(files.length);
            files.push({ k: files.length, accept: el.accept || '', multiple: el.multiple, label: label || 'Attachment' });
            continue;
          }
          if (r === 'radio') {
            const group = radioGroupOf(el);
            group.forEach((g) => handled.add(g));
            if (!overwrite && group.some(isChecked)) continue;
            const choice = preferRegular(group, radioLabel);
            press(choice);
            const groupName = radioGroupName(el);
            filled.push(groupName ? { key: groupName, value: radioLabel(choice) } : { key: radioLabel(choice), value: true });
            changed += 1;
            continue;
          }
          if (r === 'checkbox' || r === 'switch') {
            const group = checkboxGroupOf(el);
            group.forEach((g) => handled.add(g));
            if (group.some(isChecked)) continue;
            press(group[0]);
            filled.push({ key: tidy(fieldName(group[0])) || label, value: true });
            changed += 1;
            continue;
          }
          if (!overwrite && !isEmptyField(el)) continue;
          let value;
          if (el.tagName === 'SELECT') {
            const opts = [...el.options].filter((o) => !o.disabled && o.value !== '' && !PLACEHOLDER_OPT.test(clean(o.label)));
            if (!opts.length) continue;
            const o = preferRegular(opts, (x) => clean(x.label));
            if (el.multiple) {
              o.selected = true;
              el.dispatchEvent(new Event('change', { bubbles: true }));
            } else setNativeValue(el, o.value);
            value = clean(o.label);
          } else if (r === 'combobox' || r === 'listbox') {
            value = await pickFirstOption(el);
          } else {
            value = setFitted(el, guessText(el, label));
          }
          filled.push({ key: label || el.name || el.id || '(unlabelled)', value });
          changed += 1;
        } catch (e) {
          errors.push(`${label || el.name || 'field'}: ${e.message}`);
        }
      }
      if (!changed && pass > 0) break;
      await sleep(400); // let conditional fields ("If yes, give details") render
    }
    return { found: true, ok: true, filled, files, errors };
  }

  const NEXT_BTN = /^(next|continue|save (and|&) (continue|next|proceed)|proceed|next step|go to next|save and next)\b/i;
  const NEVER_BTN = /submit|\bpay\b|delete|remove|cancel|final|sign ?out|log ?out|discard|reset|preview/i;

  // ----------------------------------------------------------- public API

  window.__formPilot = {
    // files: attachments already resolved by the runner, or null
    async fill(key, value, files) {
      const el = findField(key);
      if (!el) return { found: false };
      try {
        if (value === null || value === undefined) return { found: true, ok: true, msg: 'skipped (empty)' };
        if (files) return { found: true, ok: true, msg: fillFiles(el, files) };
        const r = role(el);
        let msg;
        if (r === 'file') throw new Error('This is a file input; give the name of an attachment.');
        else if (el.tagName === 'SELECT') msg = fillSelect(el, value);
        else if (r === 'radio') msg = fillRadio(el, value);
        else if (r === 'checkbox' || r === 'switch') msg = fillCheckbox(el, value);
        else if (r === 'combobox' || r === 'listbox') msg = await fillCombo(el, value);
        else if (el.matches('input,textarea') || el.isContentEditable || r === 'textbox' || r === 'spinbutton') {
          msg = fillText(el, value);
        } else throw new Error(`Don't know how to fill <${el.tagName.toLowerCase()} role=${r}>.`);
        return { found: true, ok: true, msg };
      } catch (e) {
        return { found: true, ok: false, msg: e.message };
      }
    },

    click(label) {
      const el = findClickable(label);
      if (!el) return { found: false };
      press(el);
      return { found: true, ok: true, msg: `clicked ${JSON.stringify(clickName(el).slice(0, 40))}` };
    },

    press(key) {
      const el = document.activeElement || document.body;
      const o = { key, code: key, bubbles: true, cancelable: true, keyCode: key === 'Enter' ? 13 : 0 };
      const go = el.dispatchEvent(new KeyboardEvent('keydown', o));
      el.dispatchEvent(new KeyboardEvent('keyup', o));
      // Synthetic keys have no default action; emulate the one that matters.
      if (go && key === 'Enter' && el.form && el.tagName === 'INPUT') el.form.requestSubmit();
      return { found: true, ok: true, msg: `pressed ${key}` };
    },

    autofill,

    setFiles(k, files) {
      const input = document.querySelector(`input[data-fp-file="${k}"]`);
      if (!input) return { found: false };
      return { found: true, ok: true, msg: fillFiles(input, files) };
    },

    /** Click the step's Next / Continue / Save and continue button, never Submit. */
    clickNext() {
      const btn = [...document.querySelectorAll('button,[role=button],input[type=submit],input[type=button],a')]
        .filter((el) => isVisible(el) && !el.disabled && el.getAttribute('aria-disabled') !== 'true')
        .find((el) => NEXT_BTN.test(clickName(el)) && !NEVER_BTN.test(clickName(el)));
      if (!btn) return { found: false };
      press(btn);
      return { found: true, ok: true, msg: clickName(btn) };
    },

    /** Enough of the page to tell whether a step changed, plus any visible error messages. */
    pageState() {
      const heads = [...document.querySelectorAll('h1,h2,h3,legend,[aria-current=step],[aria-current=true]')]
        .filter(isVisible).slice(0, 12).map((h) => clean(h.innerText)).join('|');
      const errs = [...document.querySelectorAll('[role=alert],[aria-invalid=true],.error,.invalid-feedback,.field-error,.ant-form-item-explain-error,.Mui-error')]
        .filter(isVisible).map((e) => clean(e.innerText || e.getAttribute('aria-label') || '')).filter(Boolean);
      return { found: true, sig: `${location.href}|${heads}`, errors: [...new Set(errs)].slice(0, 5) };
    },

    hasText(text) {
      return document.body ? document.body.innerText.includes(text) : false;
    },

    // Form fields on the page, for building a profile template.
    describe() {
      const items = [];
      for (const el of document.querySelectorAll(`h1,h2,h3,h4,legend,${FIELD}`)) {
        if (/^(H[1-4]|LEGEND)$/.test(el.tagName)) {
          if (isVisible(el) && el.tagName !== 'LEGEND') items.push({ role: 'heading', name: clean(el.innerText) });
          continue;
        }
        if (!usable(el) || el.disabled || el.readOnly || el.closest('[role=listbox]')) continue;
        items.push({
          role: role(el),
          name: tidy(fieldName(el)),
          attrName: el.getAttribute('name') || '',
          id: el.id || '',
          required: el.required || el.getAttribute('aria-required') === 'true',
          options: el.tagName === 'SELECT' ? [...el.options].map((o) => clean(o.label)).filter(Boolean) : [],
          radioLabel: role(el) === 'radio' ? radioLabel(el) : '',
          group: role(el) === 'radio' ? radioGroupName(el) : '',
        });
      }
      return { title: document.title, url: location.href, items };
    },
  };
})();
