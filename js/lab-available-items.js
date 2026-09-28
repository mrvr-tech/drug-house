/**
 * Lab Available Items Catalog Module
 * 
 * Manages store stock catalog table for Lab users with category filtering and search.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory(require('./config'), require('./supabase'), require('./auth'));
    } else {
        root.LabAvailableItemsModule = factory(root.APP_CONFIG, root.SupabaseService, root.Auth);
    }
}(typeof self !== 'undefined' ? self : this, function (config, supabaseService, auth) {

    const CATEGORY_MAP = {
        'chemicals': 'Chemicals',
        'glassware': 'Glassware',
        'instruments': 'Instruments',
        'computer': 'Computer Store',
        'other': 'Other'
    };

    let allItems = [];
    let currentFiltered = [];

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
     * Format date
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
     * Fetch catalog from Supabase
     */
    async function fetchCatalog() {
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
            console.warn('v_current_stock query failed:', e);
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
            console.error('Failed to query inventory items for lab catalog:', err);
            throw err;
        }

        return [];
    }

    /**
     * Render catalog table rows
     */
    function renderTable(items) {
        const tbody = document.querySelector('tbody');
        if (!tbody) return;

        if (items.length === 0) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="7" style="text-align: center; padding: 35px; color: #6a7a6f;">
                        <div style="font-size: 1.8rem; margin-bottom: 6px;">📦</div>
                        <strong>No items found matching your filter criteria.</strong>
                    </td>
                </tr>
            `;
            return;
        }

        const rowsHtml = items.map(item => {
            const rawCategory = (item.category || 'other').toLowerCase();
            const categoryLabel = CATEGORY_MAP[rawCategory] || (item.category || 'Other');
            const itemName = item.item_name || 'Unnamed Item';
            const packages = item.packages || item.package || item.package_size || 'N/A';
            const availQty = (typeof item.available_quantity === 'number') 
                ? item.available_quantity 
                : (typeof item.quantity === 'number' ? item.quantity : (item.current_quantity || 0));
            const expiryFormatted = formatDate(item.expiry_date);

            let statusBadge = `<span class="badge badge-success">In Stock</span>`;
            let qtyBadge = `<span class="badge badge-success">${availQty} units</span>`;
            let actionBtn = `<a href="request-item.html?item=${encodeURIComponent(itemName)}" class="btn" style="padding: 6px 14px; font-size: 12px;">Request</a>`;

            if (availQty <= 0) {
                statusBadge = `<span class="badge badge-danger">Out of Stock</span>`;
                qtyBadge = `<span class="badge badge-danger">0 units</span>`;
                actionBtn = `<button class="btn btn-secondary" disabled style="padding: 6px 14px; font-size: 12px;">Unavailable</button>`;
            } else if (availQty < 5) {
                statusBadge = `<span class="badge badge-danger">Low Stock</span>`;
                qtyBadge = `<span class="badge badge-warning">${availQty} units</span>`;
            }

            return `
                <tr>
                    <td>${escapeHtml(categoryLabel)}</td>
                    <td><strong>${escapeHtml(itemName)}</strong></td>
                    <td>${escapeHtml(packages)}</td>
                    <td>${qtyBadge}</td>
                    <td>${expiryFormatted}</td>
                    <td>${statusBadge}</td>
                    <td>${actionBtn}</td>
                </tr>
            `;
        }).join('');

        tbody.innerHTML = rowsHtml;
    }

    /**
     * Apply search and category filter
     */
    function applyFilters() {
        const searchInput = document.querySelector('input[type="text"]');
        const categorySelect = document.querySelector('select');

        const query = (searchInput?.value || '').trim().toLowerCase();
        const selectedCategory = (categorySelect?.value || '').trim().toLowerCase();

        currentFiltered = allItems.filter(item => {
            const name = (item.item_name || '').toLowerCase();
            const category = (item.category || '').toLowerCase();

            const matchesQuery = !query || name.includes(query);
            const matchesCategory = !selectedCategory || category === selectedCategory;

            return matchesQuery && matchesCategory;
        });

        renderTable(currentFiltered);
    }

    /**
     * Initialize Module
     */
    async function init(userAuth) {
        if (userAuth && userAuth.profile && userAuth.profile.lab_name) {
            const titleEl = document.getElementById('labHeaderTitle');
            if (titleEl) {
                titleEl.textContent = `🏢 ${userAuth.profile.lab_name} Catalog`;
            }
        }

        const tbody = document.querySelector('tbody');
        if (tbody) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="7" style="text-align: center; padding: 25px; color: var(--text-soft);">
                        ⏳ Loading store catalog...
                    </td>
                </tr>
            `;
        }

        try {
            allItems = await fetchCatalog();
            currentFiltered = [...allItems];
            renderTable(currentFiltered);

            const searchForm = document.getElementById('searchForm');
            const searchInput = document.querySelector('input[type="text"]');
            const categorySelect = document.querySelector('select');

            if (searchForm) {
                searchForm.addEventListener('submit', function(e) {
                    e.preventDefault();
                    applyFilters();
                });
            }

            if (searchInput) {
                searchInput.addEventListener('input', applyFilters);
            }

            if (categorySelect) {
                categorySelect.addEventListener('change', applyFilters);
            }
        } catch (err) {
            console.error('Failed to load lab catalog:', err);
            if (tbody) {
                tbody.innerHTML = `
                    <tr>
                        <td colspan="7" style="text-align: center; padding: 25px; color: #a4332b;">
                            ⚠️ Unable to retrieve inventory data from Supabase.
                        </td>
                    </tr>
                `;
            }
        }
    }

    return {
        init,
        fetchCatalog,
        applyFilters,
        renderTable
    };
}));
