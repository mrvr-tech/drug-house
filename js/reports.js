/**
 * Store Reports Module
 * 
 * Fetches real data from Supabase views:
 * - public.v_purchase_entry_history (Detailed non-aggregated purchase entries)
 * - public.v_lab_usage / public.v_lab_request_report (Laboratory consumption audit)
 * - public.v_current_stock (Consolidated inventory balances)
 * 
 * Implements:
 * - Live search across all reports
 * - Client-side Excel (.csv) export with UTF-8 BOM
 * - Client-side PDF print export with official college header
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory(require('./config'), require('./supabase'), require('./auth'));
    } else {
        root.ReportsModule = factory(root.APP_CONFIG, root.SupabaseService, root.Auth);
    }
}(typeof self !== 'undefined' ? self : this, function (config, supabaseService, auth) {

    let purchaseEntries = [];
    let labUsageEntries = [];
    let stockEntries = [];

    let filteredPurchase = [];
    let filteredLabUsage = [];
    let filteredStock = [];

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
     * 1. Fetch Purchase Entry History (non-aggregated entries)
     */
    async function fetchPurchaseHistory() {
        const client = getClient();

        // 1. Try v_purchase_entry_history view
        try {
            const { data, error } = await client
                .from('v_purchase_entry_history')
                .select('*')
                .order('date', { ascending: false });

            if (!error && Array.isArray(data)) {
                return data;
            }
        } catch (e) {
            console.warn('v_purchase_entry_history query failed:', e);
        }

        // 2. Fallback to inventory_entries
        try {
            const { data, error } = await client
                .from('inventory_entries')
                .select('*')
                .order('date', { ascending: false });

            if (!error && Array.isArray(data)) {
                return data;
            }
        } catch (e) {
            console.warn('inventory_entries query failed:', e);
        }

        // 3. Fallback to inventory_items
        try {
            const { data, error } = await client
                .from('inventory_items')
                .select('*')
                .order('date', { ascending: false });

            if (!error && Array.isArray(data)) {
                return data;
            }
            if (error) throw error;
        } catch (err) {
            console.error('Failed to fetch purchase history:', err);
        }

        return [];
    }

    /**
     * 2. Fetch Lab Usage Report (Approved laboratory consumption)
     */
    async function fetchLabUsage() {
        const client = getClient();

        // 1. Primary: Query approved requisitions and map details
        try {
            const { data: requests, error: reqErr } = await client
                .from('lab_requests')
                .select('id, lab_id, status, approved_at, created_at')
                .eq('status', 'Approved')
                .order('created_at', { ascending: false });

            if (!reqErr && Array.isArray(requests) && requests.length > 0) {
                const [labsRes, itemsRes, linesRes] = await Promise.all([
                    client.from('labs').select('id, name'),
                    client.from('inventory_items').select('id, item_name, category'),
                    client.from('lab_request_items').select('*')
                ]);

                const labMap = {};
                (labsRes.data || []).forEach(l => { labMap[l.id] = l.name; });

                const itemMap = {};
                (itemsRes.data || []).forEach(i => { itemMap[i.id] = i; });

                const linesByReqId = {};
                (linesRes.data || []).forEach(li => {
                    const reqKey = li.lab_request_id || li.request_id;
                    if (reqKey) {
                        if (!linesByReqId[reqKey]) linesByReqId[reqKey] = [];
                        linesByReqId[reqKey].push(li);
                    }
                });

                const usageRows = [];
                requests.forEach(r => {
                    const labName = labMap[r.lab_id] || '-';
                    const items = linesByReqId[r.id] || [];

                    if (items.length > 0) {
                        items.forEach(li => {
                            const invItemId = li.inventory_item_id || li.item_id;
                            const inv = itemMap[invItemId] || {};
                            const reqQty = li.requested_qty !== undefined && li.requested_qty !== null ? li.requested_qty : (li.count !== undefined && li.count !== null ? li.count : '-');
                            const appQty = li.approved_qty !== undefined && li.approved_qty !== null ? li.approved_qty : (reqQty !== '-' ? reqQty : '-');

                            usageRows.push({
                                id: r.id,
                                lab_name: labName,
                                item_name: inv.item_name || '-',
                                category: inv.category || '-',
                                packages: '-',
                                requested_qty: reqQty,
                                approved_qty: appQty,
                                date: r.approved_at || r.created_at,
                                status: 'Approved'
                            });
                        });
                    }
                });

                return usageRows;
            }
        } catch (e) {
            console.warn('Lab usage query notice:', e);
        }

        // 2. View fallback: v_lab_usage
        try {
            const { data, error } = await client
                .from('v_lab_usage')
                .select('*');

            if (!error && Array.isArray(data) && data.length > 0) {
                return data.map(item => ({
                    lab_name: item.lab_name || '-',
                    item_name: item.item_name || '-',
                    category: item.category || '-',
                    packages: '-',
                    requested_qty: item.count !== undefined ? item.count : '-',
                    approved_qty: item.count !== undefined ? item.count : '-',
                    date: null,
                    status: 'Approved'
                }));
            }
        } catch (e) {
            console.warn('v_lab_usage query notice:', e);
        }

        return [];
    }

    /**
     * 3. Fetch Consolidated Current Stock
     */
    async function fetchCurrentStock() {
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
            console.error('Failed to fetch current stock report:', err);
        }

        return [];
    }

    /**
     * Render Purchase Report Table
     */
    function renderPurchaseTable(items) {
        const tbody = document.getElementById('purchaseReportTableBody');
        if (!tbody) return;

        if (items.length === 0) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="10" style="text-align: center; padding: 25px; color: #6a7a6f;">
                        No purchase records found matching search criteria.
                    </td>
                </tr>
            `;
            return;
        }

        tbody.innerHTML = items.map((item, idx) => {
            const srNo = idx + 1;
            const itemName = item.item_name || '-';
            const packages = item.packages || item.package || item.package_size || '-';
            const qty = item.quantity !== undefined && item.quantity !== null ? item.quantity : '-';
            const price = item.price !== undefined && item.price !== null ? parseFloat(item.price).toFixed(2) : '-';
            const tax = item.tax !== undefined && item.tax !== null ? parseFloat(item.tax).toFixed(2) : '-';
            const billNo = item.bill_no || '-';
            const date = formatDate(item.date || item.created_at);
            const expFormatted = formatDate(item.expiry_date);
            const vendor = item.vendor_name || '-';

            // Expiry badge
            let expiryBadge = `<span class="badge badge-success">${expFormatted}</span>`;
            if (item.expiry_date) {
                const today = new Date();
                today.setHours(0, 0, 0, 0);
                const exp = new Date(item.expiry_date);
                exp.setHours(0, 0, 0, 0);
                if (!isNaN(exp.getTime())) {
                    if (exp <= today) {
                        expiryBadge = `<span class="badge badge-danger">${expFormatted} (Expired)</span>`;
                    } else if (exp <= new Date(today.getTime() + 30 * 86400000)) {
                        expiryBadge = `<span class="badge badge-warning">${expFormatted} (Expiring)</span>`;
                    }
                }
            }

            return `
                <tr>
                    <td>${srNo}</td>
                    <td><strong>${escapeHtml(itemName)}</strong></td>
                    <td>${escapeHtml(packages)}</td>
                    <td><strong>${qty}</strong></td>
                    <td>${price !== '-' ? `₹${price}` : '-'}</td>
                    <td>${tax !== '-' ? `₹${tax}` : '-'}</td>
                    <td>${escapeHtml(billNo)}</td>
                    <td>${date}</td>
                    <td>${expiryBadge}</td>
                    <td>${escapeHtml(vendor)}</td>
                </tr>
            `;
        }).join('');
    }

    /**
     * Render Lab Usage Table (Only Approved Issues)
     */
    function renderLabUsageTable(items) {
        const tbody = document.getElementById('labUsageTableBody');
        if (!tbody) return;

        if (items.length === 0) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="7" style="text-align: center; padding: 25px; color: #6a7a6f;">
                        No vendor consumption records recorded yet.
                    </td>
                </tr>
            `;
            return;
        }

        tbody.innerHTML = items.map(item => {
            const labName = item.lab_name || '-';
            const itemName = item.item_name || '-';
            const packages = item.packages || '-';
            const reqQty = item.requested_qty !== undefined && item.requested_qty !== null ? item.requested_qty : '-';
            const appQty = item.approved_qty !== undefined && item.approved_qty !== null ? item.approved_qty : (item.approved_quantity !== undefined && item.approved_quantity !== null ? item.approved_quantity : reqQty);
            const date = formatDate(item.date || item.approved_at || item.created_at);

            return `
                <tr>
                    <td><strong>${escapeHtml(labName)}</strong></td>
                    <td>${escapeHtml(itemName)}</td>
                    <td>${escapeHtml(packages)}</td>
                    <td>${reqQty}</td>
                    <td><strong>${appQty}</strong></td>
                    <td>${date}</td>
                    <td><span class="badge badge-success">✓ Approved</span></td>
                </tr>
            `;
        }).join('');
    }

    /**
     * Render Current Stock Table
     */
    function renderStockTable(items) {
        const tbody = document.getElementById('stockReportTableBody');
        if (!tbody) return;

        if (items.length === 0) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="7" style="text-align: center; padding: 25px; color: #6a7a6f;">
                        No stock records found matching search criteria.
                    </td>
                </tr>
            `;
            return;
        }

        tbody.innerHTML = items.map(item => {
            const itemName = item.item_name || '-';
            const packages = item.packages || item.package || item.package_size || '-';
            const availQty = typeof item.current_quantity === 'number'
                ? item.current_quantity
                : (typeof item.quantity === 'number' ? item.quantity : (typeof item.available_quantity === 'number' ? item.available_quantity : 0));
            const usedQty = typeof item.used_quantity === 'number' ? item.used_quantity : 0;
            const totalQty = typeof item.total_quantity === 'number' ? item.total_quantity : (availQty + usedQty);
            const expFormatted = formatDate(item.expiry_date);

            let statusBadge = `<span class="badge badge-success">In Stock</span>`;
            let qtyBadge = `<span class="badge badge-success">${availQty}</span>`;

            if (availQty <= 0) {
                statusBadge = `<span class="badge badge-danger">Out of Stock</span>`;
                qtyBadge = `<span class="badge badge-danger">0</span>`;
            } else if (availQty < 5) {
                statusBadge = `<span class="badge badge-danger">Low Stock</span>`;
                qtyBadge = `<span class="badge badge-warning">${availQty}</span>`;
            }

            return `
                <tr>
                    <td><strong>${escapeHtml(itemName)}</strong></td>
                    <td>${escapeHtml(item.category || '-')}</td>
                    <td>${escapeHtml(packages)}</td>
                    <td>${qtyBadge}</td>
                    <td>${usedQty}</td>
                    <td><strong>${totalQty}</strong></td>
                    <td>${statusBadge}</td>
                </tr>
            `;
        }).join('');
    }

    /**
     * Apply live search across all 3 reports
     */
    function applySearch() {
        const searchInput = document.getElementById('reportSearchInput');
        const query = (searchInput?.value || '').trim().toLowerCase();

        if (!query) {
            filteredPurchase = [...purchaseEntries];
            filteredLabUsage = [...labUsageEntries];
            filteredStock = [...stockEntries];
        } else {
            filteredPurchase = purchaseEntries.filter(item => {
                const name = (item.item_name || '').toLowerCase();
                const vendor = (item.vendor_name || '').toLowerCase();
                const bill = (item.bill_no || '').toLowerCase();
                return name.includes(query) || vendor.includes(query) || bill.includes(query);
            });

            filteredLabUsage = labUsageEntries.filter(item => {
                const name = (item.item_name || '').toLowerCase();
                const lab = (item.lab_name || '').toLowerCase();
                return name.includes(query) || lab.includes(query);
            });

            filteredStock = stockEntries.filter(item => {
                const name = (item.item_name || '').toLowerCase();
                return name.includes(query);
            });
        }

        renderPurchaseTable(filteredPurchase);
        renderLabUsageTable(filteredLabUsage);
        renderStockTable(filteredStock);
    }

    /**
     * Client-Side Excel / CSV Export
     */
    function exportToExcel(reportType) {
        let title = '';
        let headers = [];
        let rows = [];

        const todayStr = new Date().toISOString().split('T')[0];

        if (reportType === 'purchase') {
            title = 'Store_Purchase_Report';
            headers = ['Sr No', 'Item Name', 'Package', 'Quantity', 'Price (INR)', 'Tax (INR)', 'Bill No', 'Date', 'Expiry Date', 'Supplier Name'];
            rows = filteredPurchase.map((item, idx) => [
                idx + 1,
                item.item_name || '',
                item.packages || item.package || '',
                item.quantity || 0,
                parseFloat(item.price || 0).toFixed(2),
                parseFloat(item.tax || 0).toFixed(2),
                item.bill_no || '',
                formatDate(item.date || item.created_at),
                formatDate(item.expiry_date),
                item.vendor_name || ''
            ]);
        } else if (reportType === 'lab_usage') {
            title = 'Vendor_Usage_Report';
            headers = ['Vendor Name', 'Item Name', 'Package', 'Requested Qty', 'Approved Qty', 'Date', 'Status'];
            rows = filteredLabUsage.map(item => [
                item.lab_name || item.lab || '',
                item.item_name || item.item || '',
                item.packages || item.package || '',
                item.quantity || item.requested_quantity || 1,
                item.approved_quantity !== undefined ? item.approved_quantity : (item.status === 'Approved' ? (item.quantity || 1) : 0),
                formatDate(item.date || item.created_at),
                item.status || 'Pending'
            ]);
        } else if (reportType === 'stock') {
            title = 'Current_Stock_Report';
            headers = ['Item Name', 'Package', 'Total Qty', 'Used Qty', 'Available Qty', 'Expiry Date', 'Status'];
            rows = filteredStock.map(item => {
                const avail = (typeof item.available_quantity === 'number') 
                    ? item.available_quantity 
                    : (typeof item.quantity === 'number' ? item.quantity : (item.current_quantity || 0));
                const used = item.used_quantity || 0;
                const total = item.total_quantity || (avail + used);
                const status = avail <= 0 ? 'Out of Stock' : (avail < 5 ? 'Low Stock' : 'In Stock');
                return [
                    item.item_name || '',
                    item.packages || item.package || '',
                    total,
                    used,
                    avail,
                    formatDate(item.expiry_date),
                    status
                ];
            });
        }

        // Build CSV with UTF-8 BOM
        const csvContent = '\uFEFF' + [
            headers.map(h => `"${String(h).replace(/"/g, '""')}"`).join(','),
            ...rows.map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
        ].join('\r\n');

        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.setAttribute('href', url);
        link.setAttribute('download', `${title}_${todayStr}.csv`);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    }

    /**
     * Client-Side PDF Export (Print-ready document)
     */
    function exportToPdf(reportType) {
        let reportTitle = '';
        let tableHtml = '';

        if (reportType === 'purchase') {
            reportTitle = 'Store Purchase Report';
            const table = document.querySelector('#purchaseReportTableBody')?.closest('table');
            if (table) tableHtml = table.outerHTML;
        } else if (reportType === 'lab_usage') {
            reportTitle = 'Vendor Usage Report';
            const table = document.querySelector('#labUsageTableBody')?.closest('table');
            if (table) tableHtml = table.outerHTML;
        } else if (reportType === 'stock') {
            reportTitle = 'Current Stock Report';
            const table = document.querySelector('#stockReportTableBody')?.closest('table');
            if (table) tableHtml = table.outerHTML;
        }

        const nowStr = new Date().toLocaleString('en-GB');

        const printWindow = window.open('', '_blank');
        if (!printWindow) {
            alert('Please allow popups to export the PDF report.');
            return;
        }

        printWindow.document.write(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>${escapeHtml(reportTitle)} - Siddheshwar Drug House</title>
                <style>
                    body { font-family: 'Segoe UI', Arial, sans-serif; margin: 30px; color: #1b2b20; }
                    .header { text-align: center; border-bottom: 2px solid #1f7a4d; padding-bottom: 12px; margin-bottom: 20px; }
                    .header h1 { margin: 0; font-size: 20px; color: #123d24; }
                    .header p { margin: 4px 0 0; font-size: 13px; color: #526257; }
                    .report-title { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 15px; }
                    .report-title h2 { margin: 0; font-size: 16px; color: #1f7a4d; }
                    .report-title span { font-size: 12px; color: #666; }
                    table { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 12px; }
                    th, td { border: 1px solid #d9e2db; padding: 8px 10px; text-align: left; }
                    th { background-color: #eaf4ed; color: #123d24; font-weight: bold; }
                    tr:nth-child(even) { background-color: #f9fbf9; }
                    .badge { font-weight: bold; }
                    @media print {
                        body { margin: 15mm; }
                        button { display: none; }
                    }
                </style>
            </head>
            <body>
                <div class="header">
                    <h1>Siddheshwar Drug House</h1>
                    <p>Medical Wholesale &bull; Behind The Market Yard, Mangalwedha, Solapur &bull; Tel: 9860326328</p>
                </div>
                <div class="report-title">
                    <h2>${escapeHtml(reportTitle)}</h2>
                    <span>Generated on: ${nowStr}</span>
                </div>
                ${tableHtml}
                <script>
                    window.onload = function() {
                        window.print();
                    };
                </script>
            </body>
            </html>
        `);
        printWindow.document.close();
    }

    /**
     * Initialize Module
     */
    async function init() {
        const purchaseTbody = document.getElementById('purchaseReportTableBody');
        const labUsageTbody = document.getElementById('labUsageTableBody');
        const stockTbody = document.getElementById('stockReportTableBody');

        if (purchaseTbody) purchaseTbody.innerHTML = '<tr><td colspan="10" style="text-align: center; padding: 25px; color: var(--text-soft);">⏳ Loading store purchase report...</td></tr>';
        if (labUsageTbody) labUsageTbody.innerHTML = '<tr><td colspan="7" style="text-align: center; padding: 25px; color: var(--text-soft);">⏳ Loading lab usage report...</td></tr>';
        if (stockTbody) stockTbody.innerHTML = '<tr><td colspan="7" style="text-align: center; padding: 25px; color: var(--text-soft);">⏳ Loading current stock report...</td></tr>';

        // Update timestamp
        const timestampEl = document.getElementById('reportsTimestamp');
        if (timestampEl) {
            const now = new Date();
            timestampEl.textContent = `📅 Last Updated: ${now.toLocaleDateString('en-GB')} ${now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
        }

        try {
            const [purchase, labUsage, stock] = await Promise.all([
                fetchPurchaseHistory(),
                fetchLabUsage(),
                fetchCurrentStock()
            ]);

            purchaseEntries = purchase;
            labUsageEntries = labUsage;
            stockEntries = stock;

            filteredPurchase = [...purchaseEntries];
            filteredLabUsage = [...labUsageEntries];
            filteredStock = [...stockEntries];

            renderPurchaseTable(filteredPurchase);
            renderLabUsageTable(filteredLabUsage);
            renderStockTable(filteredStock);

            // Hook up Search Input
            const searchForm = document.getElementById('reportSearchForm');
            const searchInput = document.getElementById('reportSearchInput');

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
            console.error('Error loading store reports:', err);
        }
    }

    return {
        init,
        fetchPurchaseHistory,
        fetchLabUsage,
        fetchCurrentStock,
        applySearch,
        exportToExcel,
        exportToPdf
    };
}));
