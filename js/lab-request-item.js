/**
 * Lab Request Item Module
 * 
 * Manages item requisition submissions for authenticated laboratory accounts:
 * - Populates item dropdown from live store stock
 * - Enforces available quantity limits (prevents requesting > available)
 * - Inserts pending requisition records using authenticated profile identity
 * - NEVER deducts stock client-side (stock is deducted only upon Store Keeper approval)
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory(require('./config'), require('./supabase'), require('./auth'));
    } else {
        root.LabRequestItemModule = factory(root.APP_CONFIG, root.SupabaseService, root.Auth);
    }
}(typeof self !== 'undefined' ? self : this, function (config, supabaseService, auth) {

    let availableItems = [];
    let currentProfile = null;
    let isSubmitting = false;

    /**
     * Get initialized Supabase client
     */
    function getClient() {
        const client = supabaseService && supabaseService.getClient();
        if (!client) {
            throw new Error('Supabase client is not available.');
        }
        return client;
    }

    /**
     * Escape HTML string
     */
    function escapeHtml(str) {
        if (!str) return '';
        const div = document.createElement('div');
        div.textContent = String(str);
        return div.innerHTML;
    }

    /**
     * Fetch in-stock items from Supabase
     */
    async function fetchInStockItems() {
        const client = getClient();

        // 1. Try v_current_stock
        try {
            const { data, error } = await client
                .from('v_current_stock')
                .select('*')
                .order('item_name', { ascending: true });

            if (!error && Array.isArray(data)) {
                return data;
            }
        } catch (e) {
            console.warn('v_current_stock fetch failed:', e);
        }

        // 2. Fallback to inventory_items
        try {
            const { data, error } = await client
                .from('inventory_items')
                .select('*')
                .order('item_name', { ascending: true });

            if (!error && Array.isArray(data)) {
                return data;
            }
            if (error) throw error;
        } catch (err) {
            console.error('Failed to fetch in-stock items:', err);
            throw err;
        }

        return [];
    }

    /**
     * Populate the select dropdown with live stock items
     */
    function populateDropdown(items) {
        const select = document.getElementById('item_id');
        if (!select) return;

        select.innerHTML = '<option value="">-- Choose an item from store --</option>';

        items.forEach(item => {
            const availQty = (typeof item.available_quantity === 'number') 
                ? item.available_quantity 
                : (typeof item.quantity === 'number' ? item.quantity : (item.current_quantity || 0));
            
            const itemName = item.item_name || 'Item';
            const packages = item.packages || item.package || item.package_size || '';
            const pkgStr = packages ? ` (${packages})` : '';
            const itemId = item.id || item.item_id || itemName;

            const opt = document.createElement('option');
            opt.value = itemId;
            opt.dataset.itemName = itemName;
            opt.dataset.availableQty = availQty;
            opt.dataset.packages = packages;

            if (availQty > 0) {
                opt.textContent = `${itemName}${pkgStr} — Available: ${availQty} units`;
            } else {
                opt.textContent = `${itemName}${pkgStr} — Out of Stock (0 units)`;
                opt.disabled = true;
            }

            select.appendChild(opt);
        });

        // Pre-select if URL param present
        const urlParams = new URLSearchParams(window.location.search);
        const itemParam = urlParams.get('item');
        if (itemParam) {
            const lowerParam = itemParam.trim().toLowerCase();
            for (let i = 0; i < select.options.length; i++) {
                const opt = select.options[i];
                if (opt.dataset.itemName && opt.dataset.itemName.toLowerCase() === lowerParam) {
                    select.selectedIndex = i;
                    handleItemChange();
                    break;
                }
            }
        }
    }

    /**
     * Handle item dropdown selection change
     */
    function handleItemChange() {
        const select = document.getElementById('item_id');
        const qtyInput = document.getElementById('quantity');
        const hintEl = document.getElementById('itemStockHint');

        if (!select || !qtyInput) return;

        const selectedOption = select.options[select.selectedIndex];
        if (!selectedOption || !selectedOption.value) {
            qtyInput.removeAttribute('max');
            if (hintEl) hintEl.style.display = 'none';
            return;
        }

        const availQty = parseInt(selectedOption.dataset.availableQty, 10) || 0;
        const packages = selectedOption.dataset.packages || '';

        qtyInput.max = availQty;
        if (parseInt(qtyInput.value, 10) > availQty) {
            qtyInput.value = availQty > 0 ? availQty : 1;
        }

        if (hintEl) {
            let msg = `📦 Current Store Stock: <strong>${availQty} units</strong>`;
            if (packages) msg += ` | Package: <strong>${escapeHtml(packages)}</strong>`;
            hintEl.innerHTML = msg;
            hintEl.style.display = 'block';
        }
    }

    /**
     * Handle requisition form submission
     */
    async function handleFormSubmit(event) {
        if (event && event.preventDefault) {
            event.preventDefault();
        }

        const form = document.getElementById('requestItemForm');
        const submitBtn = form ? form.querySelector('button[type="submit"]') : null;
        const errorAlert = document.getElementById('requestError');
        const successAlert = document.getElementById('requestSuccess');
        const select = document.getElementById('item_id');
        const qtyInput = document.getElementById('quantity');

        if (errorAlert) {
            errorAlert.style.display = 'none';
            errorAlert.innerHTML = '';
        }
        if (successAlert) {
            successAlert.style.display = 'none';
            successAlert.innerHTML = '';
        }

        const selectedOpt = select?.options[select.selectedIndex];
        if (!selectedOpt || !selectedOpt.value) {
            if (errorAlert) {
                errorAlert.innerHTML = '<strong>⚠️ Selection Required:</strong> Please select an item to request.';
                errorAlert.style.display = 'block';
            }
            return;
        }

        const qty = parseInt(qtyInput?.value, 10);
        const availQty = parseInt(selectedOpt.dataset.availableQty, 10) || 0;
        const itemName = selectedOpt.dataset.itemName || selectedOpt.textContent;
        const itemId = selectedOpt.value;

        if (isNaN(qty) || qty < 1) {
            if (errorAlert) {
                errorAlert.innerHTML = '<strong>⚠️ Invalid Quantity:</strong> Please enter a quantity of at least 1.';
                errorAlert.style.display = 'block';
            }
            return;
        }

        if (availQty > 0 && qty > availQty) {
            if (errorAlert) {
                errorAlert.innerHTML = `<strong>⚠️ Exceeds Stock:</strong> You requested ${qty} unit(s), but only ${availQty} unit(s) are available in store.`;
                errorAlert.style.display = 'block';
            }
            return;
        }

        if (isSubmitting) return;

        // Disable submit button
        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.textContent = '⏳ Submitting Requisition...';
        }
        isSubmitting = true;

        try {
            const client = getClient();
            const session = await auth.getSession();
            const user = session?.user;
            if (!user) throw new Error('User is not authenticated.');

            const profile = currentProfile || await auth.getCurrentProfile(user);
            const labId = profile?.lab_id;

            if (!labId) {
                throw new Error('Your user account is not linked to an assigned vendor. Please contact the Store Admin.');
            }

            // 1. Insert requisition header into lab_requests table
            const headerPayload = {
                lab_id: labId,
                status: 'Pending',
                requested_by: user.id
            };

            const { data: headerData, error: headerErr } = await client
                .from('lab_requests')
                .insert([headerPayload])
                .select()
                .single();

            if (headerErr || !headerData) {
                throw (headerErr || new Error('Failed to create requisition request.'));
            }

            const reqId = headerData.id;

            // 2. Insert line item detail into lab_request_items table
            const { error: lineErr } = await client
                .from('lab_request_items')
                .insert([{
                    lab_request_id: reqId,
                    inventory_item_id: itemId,
                    count: qty,
                    status: 'Pending'
                }]);

            if (lineErr) {
                throw lineErr;
            }

            // Success feedback
            if (successAlert) {
                successAlert.innerHTML = `
                    <div style="display: flex; align-items: flex-start; justify-content: space-between; flex-wrap: wrap; gap: 10px;">
                        <div>
                            <strong>✅ Requisition Submitted Successfully!</strong>
                            <p style="margin-top: 4px; font-size: 0.92rem;">
                                Requested <strong>${qty} unit(s)</strong> of <strong>${escapeHtml(itemName)}</strong>. Awaiting Store Keeper approval.
                            </p>
                        </div>
                        <div style="display: flex; gap: 8px;">
                            <a href="request-history.html" class="btn" style="padding: 6px 14px; font-size: 13px; min-height: auto;">View Request History →</a>
                        </div>
                    </div>
                `;
                successAlert.style.display = 'block';
                successAlert.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }

            // Reset form
            form.reset();
            const hintEl = document.getElementById('itemStockHint');
            if (hintEl) hintEl.style.display = 'none';

        } catch (err) {
            console.error('Failed to submit requisition:', err);
            if (errorAlert) {
                const message = err.message || 'Failed to submit requisition. Please try again.';
                let detailsHtml = '';
                if (err && typeof err === 'object') {
                    const metaRows = [];
                    if (err.code) metaRows.push(`<div><strong>Code:</strong> <code>${escapeHtml(err.code)}</code></div>`);
                    if (err.details) metaRows.push(`<div><strong>Details:</strong> ${escapeHtml(err.details)}</div>`);
                    if (err.hint) metaRows.push(`<div><strong>Hint:</strong> ${escapeHtml(err.hint)}</div>`);
                    if (metaRows.length > 0) {
                        detailsHtml = `
                            <div style="margin-top: 10px; padding: 10px 14px; background: rgba(0, 0, 0, 0.05); border-left: 3px solid #dc3545; border-radius: 4px; font-size: 0.88rem; line-height: 1.6;">
                                ${metaRows.join('')}
                            </div>
                        `;
                    }
                }
                errorAlert.innerHTML = `<strong>❌ Requisition Error:</strong><p style="margin-top: 4px;">${escapeHtml(message)}</p>${detailsHtml}`;
                errorAlert.style.display = 'block';
                errorAlert.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
        } finally {
            isSubmitting = false;
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.textContent = '✓ Submit Request';
            }
        }
    }

    /**
     * Initialize Module
     */
    async function init(userAuth) {
        if (userAuth && userAuth.profile) {
            currentProfile = userAuth.profile;
            if (userAuth.profile.lab_name) {
                const titleEl = document.getElementById('labHeaderTitle');
                if (titleEl) {
                    titleEl.textContent = `📝 ${userAuth.profile.lab_name} Requisition Portal`;
                }
            }
        }

        const select = document.getElementById('item_id');
        if (select) {
            select.innerHTML = '<option value="">⏳ Loading stock items from store...</option>';
            select.addEventListener('change', handleItemChange);
        }

        const form = document.getElementById('requestItemForm');
        if (form) {
            form.addEventListener('submit', handleFormSubmit);
        }

        try {
            availableItems = await fetchInStockItems();
            populateDropdown(availableItems);
        } catch (err) {
            console.error('Failed to load stock items into dropdown:', err);
            if (select) {
                select.innerHTML = '<option value="">⚠️ Error loading store items</option>';
            }
        }
    }

    return {
        init,
        fetchInStockItems,
        handleItemChange,
        handleFormSubmit
    };
}));
