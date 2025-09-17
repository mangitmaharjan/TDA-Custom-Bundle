(function () {
  function $(sel, root) { return (root || document).querySelector(sel); }

  function parseIds(csv) {
    if (!csv) return [];
    return csv.split(',').map(s => parseInt(s.trim(), 10)).filter(n => Number.isInteger(n) && n > 0);
  }

  async function addToCart(variantIds, parentQty) {
    const items = variantIds.map(id => ({ id, quantity: parentQty > 0 ? parentQty : 1 }));
    const res = await fetch('/cart/add.js', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ items })
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(text || `Cart add failed (${res.status})`);
    }
    return res.json();
  }

  function bind(el) {
    const btn = el.querySelector('.bundle-add-button');
    if (!btn) return;
    if (btn._bundleBound) return;
    btn._bundleBound = true;

    const status = el.querySelector('.bundle-add-button__status');
    const ids = parseIds(btn.dataset.variantIds);
    const qtySel = btn.dataset.parentQtySelector || "[name='quantity']";
    const redirect = String(btn.dataset.redirect || "false") === "true";

    if (!ids.length) {
      btn.disabled = true;
      if (status) { status.hidden = false; status.textContent = 'No components configured.'; }
      return;
    }

    btn.addEventListener('click', async () => {
      try {
        btn.disabled = true;
        if (status) { status.hidden = false; status.textContent = 'Adding…'; }

        let parentQty = 1;
        const input = $(qtySel, el.closest('form') || document);
        if (input && input.value) {
          const q = parseInt(input.value, 10);
          if (Number.isFinite(q) && q > 0) parentQty = q;
        }

        await addToCart(ids, parentQty);

        if (status) { status.textContent = 'Added!'; }
        const evt = new CustomEvent('bundle:add', { detail: { variantIds: ids, quantity: parentQty } });
        document.dispatchEvent(evt);

        // Optional redirect
        if (redirect) window.location.href = '/cart';
      } catch (e) {
        if (status) { status.textContent = 'Error adding items.'; }
        console.error('[Bundle Add Button]', e);
      } finally {
        btn.disabled = false;
      }
    });
  }

  function init() {
    document.querySelectorAll('[data-app="bundle-add-button"]').forEach(bind);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // In Online Store editor (theme customizer), re-bind when blocks update
  document.addEventListener('shopify:section:load', init);
  document.addEventListener('shopify:section:select', init);
})();
