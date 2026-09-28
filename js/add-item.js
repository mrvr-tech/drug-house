/**
 * Add Item Service Module
 * 
 * Handles client-side validation and executes public.add_inventory_entry(...) RPC
 * on Supabase to record new purchase entries and automatically update consolidated stock.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory(require('./config'), require('./supabase'), require('./auth'));
    } else {
        root.AddItemModule = factory(root.APP_CONFIG, root.SupabaseService, root.Auth);
    }
}(typeof self !== 'undefined' ? self : this, function (config, supabaseService, auth) {

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
        div.textContent = str;
        return div.innerHTML;
    }

    /**
     * Validate form data
     * @param {Object} formData 
     * @returns {{ valid: boolean, errors: string[] }}
     */
    function validateForm(formData) {
        const errors = [];

        if (!formData.category) {
            errors.push('Category is required.');
        }

        if (!formData.item_name || !formData.item_name.trim()) {
            errors.push('Item Name is required.');
        }

        const qty = parseInt(formData.quantity, 10);
        if (isNaN(qty) || qty < 1) {
            errors.push('Quantity must be a positive number (minimum 1).');
        }

        const price = parseFloat(formData.price);
        if (isNaN(price) || price < 0) {
            errors.push('Price must be a valid non-negative number.');
        }

        const tax = parseFloat(formData.tax);
        if (isNaN(tax) || tax < 0) {
            errors.push('Tax must be a valid non-negative number.');
        }

        if (!formData.bill_no || !formData.bill_no.trim()) {
            errors.push('Bill / Invoice Number is required.');
        }

        if (!formData.date) {
            errors.push('Purchase Date is required.');
        }

        if (!formData.expiry_date) {
            errors.push('Expiry Date is required.');
        }

        if (!formData.vendor_name || !formData.vendor_name.trim()) {
            errors.push('Vendor Name is required.');
        }

        if (!formData.vendor_address || !formData.vendor_address.trim()) {
            errors.push('Vendor Address is required.');
        }

        if (!formData.vendor_pan || !formData.vendor_pan.trim()) {
            errors.push('Vendor PAN is required.');
        }

        return {
            valid: errors.length === 0,
            errors
        };
    }

    /**
     * Format category to exact PostgreSQL inventory_category_enum casing
     */
    function formatCategoryForEnum(cat) {
        if (!cat) return 'Other';
        const lower = cat.trim().toLowerCase();
        if (lower === 'chemicals' || lower === 'chemical') return 'Chemicals';
        if (lower === 'glassware' || lower === 'glass') return 'Glassware';
        if (lower === 'instruments' || lower === 'instrument' || lower === 'equipment' || lower === 'equipments' || lower === 'computer') return 'Instruments';
        return 'Other';
    }

    /**
     * Fetch the next serial number (sr_no) from inventory_entries
     * Auto-increments MAX(sr_no) + 1, or defaults to 1 if empty.
     */
    async function fetchNextSrNo() {
        const client = getClient();
        try {
            const { data, error } = await client
                .from('inventory_entries')
                .select('sr_no')
                .order('sr_no', { ascending: false })
                .limit(1);

            if (!error && Array.isArray(data) && data.length > 0) {
                const max = parseInt(data[0].sr_no, 10);
                if (!isNaN(max) && max >= 1) {
                    return max + 1;
                }
            }
        } catch (e) {
            console.warn('Could not query max sr_no, defaulting to 1:', e);
        }
        return 1;
    }

    /**
     * Update the auto-generated Sr. No. input field on the form
     */
    async function updateSrNoField() {
        const srNoInput = document.getElementById('sr_no');
        if (!srNoInput) return;
        try {
            const nextSr = await fetchNextSrNo();
            srNoInput.value = nextSr;
        } catch {
            srNoInput.value = 1;
        }
    }

    /**
     * Call public.add_inventory_entry RPC on Supabase
     * Supports both p_ prefixed parameter signatures and standard naming.
     */
    async function submitInventoryEntry(formData) {
        const client = getClient();

        const category = formatCategoryForEnum(formData.category);
        const itemName = (formData.item_name || '').trim();
        const packages = (formData.packages && formData.packages.trim()) ? formData.packages.trim() : null;
        const quantity = parseInt(formData.quantity, 10);
        const price = parseFloat(formData.price) || 0;
        const tax = parseFloat(formData.tax) || 0;
        const billNo = (formData.bill_no || '').trim();
        const date = formData.date;
        const expiryDate = formData.expiry_date;
        const vendorName = (formData.vendor_name || '').trim();
        const vendorAddress = (formData.vendor_address || '').trim();
        const vendorPan = (formData.vendor_pan || '').trim().toUpperCase();

        // Auto-fetch or calculate next valid Sr. No.
        let srNo = parseInt(formData.sr_no, 10);
        if (isNaN(srNo) || srNo < 1) {
            srNo = await fetchNextSrNo();
        }

        // 1. Invoke canonical database RPC (exact live schema signature with _ prefix)
        const payloadUnderscore = {
            _bill_no: billNo,
            _category: category,
            _date: date,
            _expiry_date: expiryDate,
            _item_name: itemName,
            _packages: packages,
            _price: price,
            _quantity: quantity,
            _sr_no: srNo,
            _tax: tax,
            _vendor_address: vendorAddress,
            _vendor_name: vendorName,
            _vendor_pan: vendorPan
        };

        const result = await client.rpc('add_inventory_entry', payloadUnderscore);

        if (result.error) {
            throw result.error;
        }

        return result.data;
    }

    /**
     * Handle form submission event
     */
    async function handleFormSubmit(event) {
        if (event && event.preventDefault) {
            event.preventDefault();
        }

        const form = document.getElementById('addItemForm');
        const submitBtn = form ? form.querySelector('button[type="submit"]') : null;
        const errorAlert = document.getElementById('formError');
        const successAlert = document.getElementById('formSuccess');

        // Hide prior alerts
        if (errorAlert) {
            errorAlert.style.display = 'none';
            errorAlert.innerHTML = '';
        }
        if (successAlert) {
            successAlert.style.display = 'none';
            successAlert.innerHTML = '';
        }

        // Collect form data
        const formData = {
            sr_no: document.getElementById('sr_no')?.value || '',
            category: document.getElementById('category')?.value || '',
            item_name: document.getElementById('item_name')?.value || '',
            packages: document.getElementById('packages')?.value || '',
            quantity: document.getElementById('quantity')?.value || '',
            price: document.getElementById('price')?.value || '',
            tax: document.getElementById('tax')?.value || '',
            bill_no: document.getElementById('bill_no')?.value || '',
            date: document.getElementById('date')?.value || '',
            expiry_date: document.getElementById('expiry_date')?.value || '',
            vendor_name: document.getElementById('vendor_name')?.value || '',
            vendor_address: document.getElementById('vendor_address')?.value || '',
            vendor_pan: document.getElementById('vendor_pan')?.value || ''
        };

        // Client-side Validation
        const validation = validateForm(formData);
        if (!validation.valid) {
            if (errorAlert) {
                errorAlert.innerHTML = `<strong>⚠️ Please correct the following:</strong><ul style="margin: 8px 0 0 18px;">${validation.errors.map(err => `<li>${escapeHtml(err)}</li>`).join('')}</ul>`;
                errorAlert.style.display = 'block';
                errorAlert.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
            return;
        }

        // Prevent double submission
        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.textContent = '⏳ Saving Item to Database...';
        }

        try {
            await submitInventoryEntry(formData);

            // Display Success Feedback
            if (successAlert) {
                successAlert.innerHTML = `
                    <div style="display: flex; align-items: flex-start; justify-content: space-between; flex-wrap: wrap; gap: 10px;">
                        <div>
                            <strong>✅ Item Saved Successfully!</strong>
                            <p style="margin-top: 4px; font-size: 0.92rem;">
                                Added <strong>${escapeHtml(formData.quantity)} unit(s)</strong> of <strong>${escapeHtml(formData.item_name)}</strong> (Sr. No. #${escapeHtml(formData.sr_no || '1')}) to store inventory.
                            </p>
                        </div>
                        <div style="display: flex; gap: 8px;">
                            <a href="inventory.html" class="btn" style="padding: 6px 14px; font-size: 13px; min-height: auto;">View Inventory Table →</a>
                        </div>
                    </div>
                `;
                successAlert.style.display = 'block';
                successAlert.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }

            // Reset form for next entry & auto-fetch new Sr. No.
            resetForm();
            await updateSrNoField();

        } catch (err) {
            console.error('RPC Error executing add_inventory_entry:', err);

            if (errorAlert) {
                const message = err.message || 'Failed to save inventory entry in database.';
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
                errorAlert.innerHTML = `<strong>❌ Error Adding Item:</strong><p style="margin-top: 4px;">${escapeHtml(message)}</p>${detailsHtml}`;
                errorAlert.style.display = 'block';
                errorAlert.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
        } finally {
            // Restore button state
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.textContent = 'Add Item';
            }
        }
    }

    /**
     * Reset form fields to clean state
     */
    function resetForm() {
        const form = document.getElementById('addItemForm');
        if (!form) return;

        form.reset();

        // Set default date to today
        const dateInput = document.getElementById('date');
        if (dateInput) {
            const today = new Date().toISOString().split('T')[0];
            dateInput.value = today;
        }

        // Set default expiry date to 2 years from today
        const expiryInput = document.getElementById('expiry_date');
        if (expiryInput) {
            const future = new Date();
            future.setFullYear(future.getFullYear() + 2);
            expiryInput.value = future.toISOString().split('T')[0];
        }

        // Set default quantity and tax
        const qtyInput = document.getElementById('quantity');
        if (qtyInput) qtyInput.value = '1';

        const taxInput = document.getElementById('tax');
        if (taxInput) taxInput.value = '0';
    }

    /**
     * Initialize the Add Item form
     */
    function init() {
        const form = document.getElementById('addItemForm');
        if (form) {
            form.addEventListener('submit', handleFormSubmit);
        }

        // Set initial dates if empty
        const dateInput = document.getElementById('date');
        if (dateInput && !dateInput.value) {
            dateInput.value = new Date().toISOString().split('T')[0];
        }

        const expiryInput = document.getElementById('expiry_date');
        if (expiryInput && !expiryInput.value) {
            const future = new Date();
            future.setFullYear(future.getFullYear() + 2);
            expiryInput.value = future.toISOString().split('T')[0];
        }

        // Automatically fetch and show next Sr. No.
        updateSrNoField();
    }

    return {
        init,
        fetchNextSrNo,
        updateSrNoField,
        submitInventoryEntry,
        handleFormSubmit,
        validateForm,
        resetForm
    };
}));
