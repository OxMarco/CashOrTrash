/* CashOrTrash admin portal. No build step and no framework on purpose: this is
   one operator's page, and a toolchain would outweigh it. */
(() => {
  const TOKEN_KEY = 'cashortrash.admin.token';
  const $ = (id) => document.getElementById(id);
  let token = null;
  let themes = [];

  try {
    token = localStorage.getItem(TOKEN_KEY);
  } catch {
    token = null;
  }

  function notice(message, kind = 'error') {
    $('notice').innerHTML = message
      ? `<div class="note ${kind}">${escapeHtml(message)}</div>`
      : '';
  }

  function escapeHtml(value) {
    return String(value).replace(
      /[&<>"']/g,
      (c) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );
  }

  async function api(path, options = {}) {
    const response = await fetch(`/admin/api${path}`, {
      ...options,
      headers: {
        ...(options.headers ?? {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
    if (response.status === 401) {
      signOut();
      throw new Error('Session expired — sign in again.');
    }
    const body = response.headers
      .get('content-type')
      ?.includes('application/json')
      ? await response.json()
      : null;
    if (!response.ok) {
      throw new Error(body?.message ?? `Request failed (${response.status})`);
    }
    return body;
  }

  // --- session ---------------------------------------------------------------

  async function signIn() {
    const password = $('password').value;
    if (!password) return;
    $('signin').disabled = true;
    try {
      const body = await fetch('/admin/api/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password }),
      }).then(async (r) => {
        const json = await r.json().catch(() => null);
        if (!r.ok) throw new Error(json?.message ?? 'Sign-in failed');
        return json;
      });
      token = body.token;
      try {
        localStorage.setItem(TOKEN_KEY, token);
      } catch {
        /* a private window still works for this session */
      }
      $('password').value = '';
      await start();
    } catch (error) {
      notice(error.message);
      $('login').classList.remove('hidden');
      $('app').classList.add('hidden');
    } finally {
      $('signin').disabled = false;
    }
  }

  function signOut() {
    token = null;
    try {
      localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* nothing to clear */
    }
    $('app').classList.add('hidden');
    $('login').classList.remove('hidden');
  }

  // --- categories ------------------------------------------------------------

  async function loadCategories() {
    themes = await api('/categories');
    $('categories').innerHTML = themes
      .map(
        (theme) => `
        <tr>
          <td>${escapeHtml(theme.name)}</td>
          <td><code>${escapeHtml(theme.slug)}</code></td>
          <td>${theme.itemCount}</td>
          <td>${theme.pendingCopy ? `<span class="pill pending">${theme.pendingCopy} queued</span>` : '—'}</td>
          <td><button class="ghost" data-theme-toggle="${theme.id}" data-active="${theme.active}">
            ${theme.active ? 'Disable' : 'Enable'}
          </button></td>
        </tr>`,
      )
      .join('');

    const options = themes
      .map((t) => `<option value="${t.id}">${escapeHtml(t.name)}</option>`)
      .join('');
    const picker = $('item-theme');
    const previous = picker.value;
    picker.innerHTML = options;
    if (previous) picker.value = previous;

    document.querySelectorAll('[data-theme-toggle]').forEach((button) => {
      button.onclick = async () => {
        await api(`/categories/${button.dataset.themeToggle}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ active: button.dataset.active !== 'true' }),
        });
        await loadCategories();
      };
    });
  }

  async function createCategory() {
    try {
      await api('/categories', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: $('cat-name').value,
          iconName: $('cat-icon').value,
          sortOrder: Number($('cat-order').value) || 0,
        }),
      });
      $('cat-name').value = '';
      notice('Category created.', 'ok');
      await loadCategories();
    } catch (error) {
      notice(error.message);
    }
  }

  // --- items -----------------------------------------------------------------

  async function loadItems() {
    const themeId = $('item-theme').value;
    if (!themeId) {
      $('items').innerHTML = '';
      return;
    }
    const items = await api(`/categories/${themeId}/items`);
    $('items').innerHTML = items
      .map(
        (item) => `
        <tr>
          <td><img src="${escapeHtml(item.photoUrl)}" alt="" /></td>
          <td>${escapeHtml(item.title)}</td>
          <td>${escapeHtml(item.conditionLine || '—')}</td>
          <td>$${(item.truePriceCents / 100).toLocaleString()}</td>
          <td>
            ${item.copyPending ? '<span class="pill pending">writing copy</span>' : ''}
            ${item.active ? '' : '<span class="pill off">retired</span>'}
          </td>
          <td>
            <button class="ghost" data-requeue="${item.id}">Rewrite</button>
            <button class="ghost" data-item-toggle="${item.id}" data-active="${item.active}">
              ${item.active ? 'Retire' : 'Restore'}
            </button>
          </td>
        </tr>`,
      )
      .join('');

    document.querySelectorAll('[data-item-toggle]').forEach((button) => {
      button.onclick = async () => {
        await api(`/items/${button.dataset.itemToggle}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ active: button.dataset.active !== 'true' }),
        });
        await refresh();
      };
    });
    document.querySelectorAll('[data-requeue]').forEach((button) => {
      button.onclick = async () => {
        await api(`/items/${button.dataset.requeue}/copy`, { method: 'POST' });
        notice('Queued for a rewrite.', 'ok');
        await refresh();
      };
    });
  }

  /**
   * One editable row per dropped file. The name and price are pre-filled from
   * the filename when it carries them, so a well-named batch is drop-and-save
   * and a badly-named one is still correctable before anything is written.
   */
  function queueFiles(files) {
    const container = $('queue');
    for (const file of files) {
      const parsed = parseName(file.name);
      const row = document.createElement('fieldset');
      row.innerHTML = `
        <legend>${escapeHtml(file.name)}</legend>
        <div class="row">
          <div><label>Name</label><input data-field="title" value="${escapeHtml(parsed.title)}" /></div>
          <div><label>Condition</label><input data-field="condition" value="${escapeHtml(parsed.condition)}" placeholder="2019, Near Mint…" /></div>
          <div><label>Price (USD)</label><input data-field="price" type="number" step="0.01" value="${parsed.price ?? ''}" /></div>
        </div>
        <label>Price source (optional)</label>
        <input data-field="source" placeholder="https://…" />
        <div class="actions">
          <button data-save>Save item</button>
          <button class="ghost" data-discard>Discard</button>
          <span data-status></span>
        </div>`;
      container.append(row);

      row.querySelector('[data-discard]').onclick = () => row.remove();
      row.querySelector('[data-save]').onclick = async () => {
        const value = (field) =>
          row.querySelector(`[data-field="${field}"]`).value.trim();
        const price = Number(value('price'));
        const status = row.querySelector('[data-status]');
        if (!value('title') || !Number.isFinite(price) || price <= 0) {
          status.textContent = 'A name and a positive price are required.';
          return;
        }

        const form = new FormData();
        form.append('photo', file);
        form.append('themeId', $('item-theme').value);
        form.append('title', value('title'));
        form.append('conditionLine', value('condition'));
        form.append('priceCents', String(Math.round(price * 100)));
        if (value('source')) form.append('sourceUrl', value('source'));

        row.querySelector('[data-save]').disabled = true;
        status.textContent = 'Uploading…';
        try {
          await api('/items', { method: 'POST', body: form });
          row.remove();
          notice('Item added. The model is writing its description.', 'ok');
          await refresh();
        } catch (error) {
          status.textContent = error.message;
          row.querySelector('[data-save]').disabled = false;
        }
      };
    }
  }

  /**
   * The server owns this format, and this is a convenience copy of it: the
   * upload is validated server-side regardless of what the form was pre-filled
   * with. Splits on the LAST underscore so `cessna 150_1967_82500` prices at
   * 82500 rather than failing on `1967_82500`.
   */
  function parseName(filename) {
    const base = filename.replace(/\.[^.]+$/, '');
    const cut = base.lastIndexOf('_');
    if (cut <= 0) return { title: base.replace(/_/g, ' ').trim(), condition: '', price: null };

    const price = Number(base.slice(cut + 1));
    const text = base.slice(0, cut).replace(/_/g, ' ').trim();
    if (!Number.isFinite(price) || price <= 0) {
      return { title: base.replace(/_/g, ' ').trim(), condition: '', price: null };
    }

    // A trailing four-digit year is a condition, not part of the name.
    const year = /\s(19|20)\d{2}$/.exec(text);
    return {
      title: year ? text.slice(0, year.index).trim() : text,
      condition: year ? year[0].trim() : '',
      price,
    };
  }

  // --- wiring ----------------------------------------------------------------

  async function refresh() {
    await loadCategories();
    await loadItems();
  }

  async function start() {
    $('login').classList.add('hidden');
    $('app').classList.remove('hidden');
    notice('');
    const icons = await api('/icons');
    $('cat-icon').innerHTML = icons
      .map((icon) => `<option value="${icon}">${icon}</option>`)
      .join('');
    await refresh();
  }

  $('signin').onclick = signIn;
  $('password').onkeydown = (event) => {
    if (event.key === 'Enter') signIn();
  };
  $('signout').onclick = signOut;
  $('cat-create').onclick = createCategory;
  $('item-theme').onchange = loadItems;

  const drop = $('drop');
  drop.onclick = () => $('file').click();
  $('file').onchange = (event) => {
    queueFiles(event.target.files);
    event.target.value = '';
  };
  drop.ondragover = (event) => {
    event.preventDefault();
    drop.classList.add('over');
  };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = (event) => {
    event.preventDefault();
    drop.classList.remove('over');
    queueFiles(event.dataTransfer.files);
  };

  if (token) {
    start().catch(() => signOut());
  }
})();
