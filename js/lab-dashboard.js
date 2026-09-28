/**
 * Lab Portal Dashboard Module
 * 
 * Loads real stock availability for laboratory users, implements real-time search,
 * dynamic stock badges, and item requisition links.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory(require('./config'), require('./supabase'), require('./auth'));
    } else {
        root.LabDashboardModule = factory(root.APP_CONFIG, root.SupabaseService, root.Auth);
    }
}(typeof self !== 'undefined' ? self : this, function (config, supabaseService, auth) {

    let allItems = [];
    let filteredItems = [];

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
     * Format a date string (YYYY-MM-DD or ISO) to DD/MM/YYYY
     */
    function formatDate(dateStr) {
        if (!dateStr) return '-';
        try {
            const d = new Date(dateStr);
            if (isNaN(d.getTime())) return dateStr;
            const day = String(d.getDate()).padStart(2, '0');
            const month = String(d.getMonth() + 1).padStart(2, '0');
            const year = d.getFullYear();
            return `${day}/${month}/${year}`;
        } catch (e) {
            return dateStr;
        }
    }

    /**
     * Fetch available items from v_current_stock or inventory_items
     */
    async function fetchAvailableItems() {
        const client = getClient();

        // 1. Try v_current_stock view
        try {
            const { data, error } = await client
                .from('v_current_stock')
                .select('*')
                .order('item_name', { ascending: true });

            if (!error && Array.isArray(data)) {
                return data;
            }
        } catch (e) {
            console.warn('v_current_stock view query failed, falling back to inventory_items:', e);
        }

        // 2. Fallback to inventory_items table
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
            console.error('Failed to fetch inventory for Lab portal:', err);
            throw err;
        }

        return [];
    }

    /**
     * Render item cards in the grid
     */
    function renderItemsGrid(items) {
        const grid = document.querySelector('.items-grid');
        if (!grid) return;

        if (items.length === 0) {
            grid.innerHTML = `
                <div style="grid-column: 1 / -1; text-align: center; padding: 45px; background: #ffffff; border-radius: var(--radius-lg); border: 1px solid var(--line);">
                    <div style="font-size: 2.2rem; margin-bottom: 10px;">📦</div>
                    <h3 style="color: var(--brand-deep); margin-bottom: 6px;">No items found</h3>
                    <p style="color: var(--text-soft);">There are currently no matching items in the store stock.</p>
                </div>
            `;
            return;
        }

        const cardsHtml = items.map(item => {
            const itemName = item.item_name || 'Unnamed Item';
            const packages = item.packages || item.package || item.package_size || 'N/A';
            const totalStock = (typeof item.total_quantity === 'number') 
                ? item.total_quantity 
                : (typeof item.quantity === 'number' ? item.quantity : (item.current_quantity || 0));
            const availQty = (typeof item.available_quantity === 'number') 
                ? item.available_quantity 
                : (typeof item.quantity === 'number' ? item.quantity : (item.current_quantity || 0));
            const price = parseFloat(item.price || 0).toFixed(2);
            const vendor = item.vendor_name || 'Store Central';
            const expiryFormatted = formatDate(item.expiry_date);

            // Expiry check
            let expiryBadge = `✓ ${expiryFormatted}`;
            if (item.expiry_date) {
                const today = new Date();
                today.setHours(0, 0, 0, 0);
                const exp = new Date(item.expiry_date);
                exp.setHours(0, 0, 0, 0);
                if (!isNaN(exp.getTime())) {
                    const thirtyDays = new Date(today);
                    thirtyDays.setDate(today.getDate() + 30);
                    if (exp <= today) {
                        expiryBadge = `⚠️ Expired (${expiryFormatted})`;
                    } else if (exp <= thirtyDays) {
                        expiryBadge = `⚠️ ${expiryFormatted}`;
                    }
                }
            }

            // Availability Badge & Action Button
            let availHtml = '';
            let actionHtml = '';

            if (availQty > 5) {
                availHtml = `<div class="availability available">✓ Available: ${availQty} units</div>`;
                actionHtml = `<a href="request-item.html?item=${encodeURIComponent(itemName)}" class="btn" style="width: 100%;">📝 Request Item</a>`;
            } else if (availQty > 0) {
                availHtml = `<div class="availability low">⚠️ Low Stock: ${availQty} units</div>`;
                actionHtml = `<a href="request-item.html?item=${encodeURIComponent(itemName)}" class="btn" style="width: 100%;">📝 Request Item</a>`;
            } else {
                availHtml = `<div class="availability unavailable">❌ Out of Stock</div>`;
                actionHtml = `<div style="padding: 10px; background-color: #f8d7da; color: #721c24; border-radius: 8px; text-align: center; font-size: 13px; font-weight: 600;">Item not available right now</div>`;
            }

            return `
                <div class="item-card">
                    <div>
                        <h3>${escapeHtml(itemName)}</h3>
                        <div class="item-info">
                            <strong>Package:</strong> ${escapeHtml(packages)}<br>
                            <strong>Total Store Stock:</strong> ${totalStock} units<br>
                            <strong>Expiry Date:</strong> ${expiryBadge}<br>
                            <strong>Price:</strong> ₹${price}<br>
                            <strong>Supplier:</strong> ${escapeHtml(vendor)}
                        </div>
                        ${availHtml}
                    </div>
                    ${actionHtml}
                </div>
            `;
        }).join('');

        grid.innerHTML = cardsHtml;
    }

    /**
     * Filter items locally by search query
     */
    function applySearch() {
        const searchInput = document.getElementById('labSearchInput');
        const query = (searchInput?.value || '').trim().toLowerCase();

        if (!query) {
            filteredItems = [...allItems];
        } else {
            filteredItems = allItems.filter(item => {
                const name = (item.item_name || '').toLowerCase();
                const category = (item.category || '').toLowerCase();
                const vendor = (item.vendor_name || '').toLowerCase();
                return name.includes(query) || category.includes(query) || vendor.includes(query);
            });
        }

        renderItemsGrid(filteredItems);
    }

    /**
     * Initialize Lab Dashboard
     */
    async function init(userAuth) {
        if (userAuth && userAuth.profile && userAuth.profile.lab_name) {
            const titleEl = document.getElementById('labHeaderTitle');
            if (titleEl) {
                titleEl.textContent = `🏢 ${userAuth.profile.lab_name} Dashboard`;
            }
        }

        const grid = document.querySelector('.items-grid');
        if (grid) {
            grid.innerHTML = `
                <div style="grid-column: 1 / -1; text-align: center; padding: 40px; color: var(--text-soft);">
                    <div style="font-size: 1.8rem; margin-bottom: 8px;">⏳</div>
                    <strong>Loading available items from central store...</strong>
                </div>
            `;
        }

        try {
            allItems = await fetchAvailableItems();
            filteredItems = [...allItems];
            renderItemsGrid(filteredItems);

            const searchForm = document.getElementById('labSearchForm');
            const searchInput = document.getElementById('labSearchInput');

            if (searchForm) {
                searchForm.addEventListener('submit', function(e) {
                    e.preventDefault();
                    applySearch();
                });
            }

            if (searchInput) {
                searchInput.addEventListener('input', applySearch);
            }
        } catch (err) {
            console.error('Failed to load lab dashboard stock:', err);
            if (grid) {
                grid.innerHTML = `
                    <div style="grid-column: 1 / -1; text-align: center; padding: 40px; color: #a4332b;">
                        <div style="font-size: 1.8rem; margin-bottom: 8px;">⚠️</div>
                        <strong>Unable to load inventory data from Supabase.</strong>
                        <p style="margin-top: 6px; font-size: 0.88rem; color: #721c24;">
                            ${escapeHtml(err.message || 'Please verify database connection.')}
                        </p>
                    </div>
                `;
            }
        }
    }

    return {
        init,
        fetchAvailableItems,
        applySearch,
        renderItemsGrid
    };
}));
