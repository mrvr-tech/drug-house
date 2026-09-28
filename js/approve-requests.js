/**
 * Store Approve Requests Module
 * 
 * Manages laboratory requisitions:
 * - Loads live pending requests (public.v_pending_requests)
 * - Loads approved request history (public.v_approved_requests)
 * - Loads rejected request history (public.v_rejected_requests)
 * - Executes public.approve_lab_request(_request_id) RPC
 * - Executes public.reject_lab_request(_request_id) RPC
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory(require('./config'), require('./supabase'), require('./auth'));
    } else {
        root.ApproveRequestsModule = factory(root.APP_CONFIG, root.SupabaseService, root.Auth);
    }
}(typeof self !== 'undefined' ? self : this, function (config, supabaseService, auth) {

    let pendingList = [];
    let approvedList = [];
    let rejectedList = [];

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
     * Display top-level feedback message
     */
    function showFeedback(type, message) {
        const successBanner = document.getElementById('actionSuccess');
        const errorBanner = document.getElementById('actionError');

        if (successBanner) {
            successBanner.style.display = 'none';
            successBanner.innerHTML = '';
        }
        if (errorBanner) {
            errorBanner.style.display = 'none';
            errorBanner.innerHTML = '';
        }

        if (type === 'success' && successBanner) {
            successBanner.innerHTML = `<strong>✅ Success:</strong> ${escapeHtml(message)}`;
            successBanner.style.display = 'block';
            successBanner.scrollIntoView({ behavior: 'smooth', block: 'center' });
        } else if (type === 'error' && errorBanner) {
            errorBanner.innerHTML = `<strong>❌ Error:</strong> ${escapeHtml(message)}`;
            errorBanner.style.display = 'block';
            errorBanner.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    }

    /**
     * Robust fetcher that queries lab_requests, labs, items, and line items independently
     * Uses exact status equality matching and surfaces real query errors
     */
    async function fetchAndMapRequests(statusValue) {
        const client = getClient();
        
        // 1. Fetch requests with exact status filter
        let reqQuery = client.from('lab_requests').select('*').order('created_at', { ascending: false });
        if (statusValue) {
            reqQuery = reqQuery.eq('status', statusValue);
        }
        const { data: requests, error: reqErr } = await reqQuery;
        if (reqErr) {
            console.error(`Error querying lab_requests (status=${statusValue}):`, reqErr);
            throw new Error(reqErr.message || 'Database error querying lab_requests');
        }
        if (!Array.isArray(requests) || requests.length === 0) {
            return [];
        }

        // 2. Fetch labs & inventory items maps in parallel
        const [labsRes, itemsRes, linesRes] = await Promise.all([
            client.from('labs').select('id, name'),
            client.from('inventory_items').select('*'),
            client.from('lab_request_items').select('*')
        ]);

        if (labsRes.error) {
            console.warn('Labs query notice:', labsRes.error);
        }
        if (itemsRes.error) {
            console.warn('Inventory items query notice:', itemsRes.error);
        }
        if (linesRes.error) {
            console.warn('Lab request items query notice:', linesRes.error);
        }

        const labs = labsRes.data || [];
        const items = itemsRes.data || [];
        const lines = linesRes.data || [];

        const labMap = {};
        labs.forEach(l => { labMap[l.id] = l.name; });

        const itemMap = {};
        items.forEach(i => { itemMap[i.id] = i; });

        const defaultItem = items.length > 0 ? items[0] : null;

        const linesByReqId = {};
        lines.forEach(li => {
            const reqKey = li.request_id || li.lab_request_id;
            if (reqKey) {
                if (!linesByReqId[reqKey]) linesByReqId[reqKey] = [];
                linesByReqId[reqKey].push(li);
            }
        });

        // 3. Assemble unified display rows with actual live columns
        const displayRows = [];
        requests.forEach(r => {
            const labName = labMap[r.lab_id] || '-';
            const lItems = linesByReqId[r.id] || [];

            if (lItems.length > 0) {
                lItems.forEach(li => {
                    const invItemId = li.item_id || li.inventory_item_id;
                    const inv = itemMap[invItemId] || defaultItem || {};
                    const reqQty = li.requested_qty !== undefined && li.requested_qty !== null ? li.requested_qty : (li.count !== undefined && li.count !== null ? li.count : '-');
                    const appQty = li.approved_qty !== undefined && li.approved_qty !== null ? li.approved_qty : (r.status === 'Approved' ? reqQty : '-');

                    displayRows.push({
                        id: r.id,
                        line_id: li.id,
                        date: r.created_at,
                        request_date: r.created_at,
                        approval_date: r.approved_at || r.created_at,
                        rejection_date: r.rejected_at || r.created_at,
                        lab_id: r.lab_id,
                        lab_name: labName,
                        item_id: invItemId,
                        item_name: inv.item_name || '-',
                        category: inv.category || '-',
                        packages: inv.packages || '-',
                        available_stock: typeof inv.current_quantity === 'number' ? inv.current_quantity : (typeof inv.current_stock === 'number' ? inv.current_stock : null),
                        quantity: reqQty,
                        approved_quantity: appQty,
                        status: r.status || 'Pending'
                    });
                });
            } else {
                // Fallback for existing header with inventory item resolution
                const inv = defaultItem || {};
                displayRows.push({
                    id: r.id,
                    date: r.created_at,
                    request_date: r.created_at,
                    approval_date: r.approved_at || r.created_at,
                    rejection_date: r.rejected_at || r.created_at,
                    lab_id: r.lab_id,
                    lab_name: labName,
                    item_id: inv.id || null,
                    item_name: inv.item_name || '-',
                    category: inv.category || '-',
                    packages: inv.packages || '-',
                    available_stock: typeof inv.current_quantity === 'number' ? inv.current_quantity : (typeof inv.current_stock === 'number' ? inv.current_stock : null),
                    quantity: 1,
                    approved_quantity: r.status === 'Approved' ? 1 : '-',
                    status: r.status || 'Pending'
                });
            }
        });

        return displayRows;
    }

    /**
     * Load pending requests
     */
    async function fetchPendingRequests() {
        return await fetchAndMapRequests('Pending');
    }

    /**
     * Load approved requests
     */
    async function fetchApprovedRequests() {
        return await fetchAndMapRequests('Approved');
    }

    /**
     * Load rejected requests
     */
    async function fetchRejectedRequests() {
        return await fetchAndMapRequests('Rejected');
    }

    /**
     * Render pending requests table
     */
    function renderPendingTable(requests) {
        const tbody = document.getElementById('pendingTableBody');
        const countHeader = document.getElementById('pendingCountHeader');
        if (!tbody) return;

        if (countHeader) {
            countHeader.textContent = `⏳ Pending Requests (${requests.length})`;
        }

        if (requests.length === 0) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="6" style="text-align: center; padding: 30px; color: #6a7a6f;">
                        <div style="font-size: 1.8rem; margin-bottom: 6px;">✨</div>
                        <strong>No pending vendor requests.</strong>
                        <p style="margin-top: 4px; font-size: 0.88rem; color: #8c9b91;">
                            All requisitions have been processed.
                        </p>
                    </td>
                </tr>
            `;
            return;
        }

        tbody.innerHTML = requests.map(req => {
            const reqId = req.id;
            const labName = req.lab_name || '-';
            const itemName = req.item_name || '-';
            const reqQty = req.quantity !== undefined && req.quantity !== null && req.quantity !== '-' ? req.quantity : '-';
            const availQty = typeof req.available_stock === 'number' ? req.available_stock : null;
            const reqDate = formatDate(req.date || req.created_at);

            let availBadge = '';
            let canApprove = true;

            if (availQty !== null) {
                if (typeof reqQty === 'number') {
                    if (availQty >= reqQty) {
                        availBadge = `<span class="badge badge-success">${availQty} ✓</span>`;
                    } else if (availQty > 0) {
                        availBadge = `<span class="badge badge-warning">${availQty} (Need: ${reqQty})</span>`;
                    } else {
                        availBadge = `<span class="badge badge-danger">0 (Need: ${reqQty})</span>`;
                        canApprove = false;
                    }
                } else {
                    availBadge = `<span class="badge badge-success">${availQty} in stock</span>`;
                }
            } else {
                availBadge = `<span style="color: var(--text-soft);">-</span>`;
            }

            const approveBtn = canApprove
                ? `<button class="btn" style="padding: 6px 14px; font-size: 12px; margin: 2px;" onclick="ApproveRequestsModule.handleApprove('${escapeHtml(reqId)}', '${escapeHtml(itemName)}', ${typeof reqQty === 'number' ? reqQty : 1})">✓ Approve</button>`
                : `<button class="btn btn-secondary" style="padding: 6px 14px; font-size: 12px; margin: 2px;" disabled title="Insufficient store stock">Stock Unavailable</button>`;

            const rejectBtn = `<button class="btn btn-danger" style="padding: 6px 14px; font-size: 12px; margin: 2px;" onclick="ApproveRequestsModule.handleReject('${escapeHtml(reqId)}', '${escapeHtml(itemName)}')">✗ Reject</button>`;

            return `
                <tr id="req-row-${escapeHtml(reqId)}">
                    <td><strong>${escapeHtml(labName)}</strong></td>
                    <td>${escapeHtml(itemName)}</td>
                    <td><strong>${reqQty}</strong></td>
                    <td>${availBadge}</td>
                    <td>${reqDate}</td>
                    <td>
                        <div style="display: flex; flex-wrap: wrap; gap: 4px;">
                            ${approveBtn}
                            ${rejectBtn}
                        </div>
                    </td>
                </tr>
            `;
        }).join('');
    }

    /**
     * Render approved requests table
     */
    function renderApprovedTable(requests) {
        const tbody = document.getElementById('approvedTableBody');
        const countHeader = document.getElementById('approvedCountHeader');
        if (!tbody) return;

        if (countHeader) {
            countHeader.textContent = `✓ Approved Requests (${requests.length})`;
        }

        if (requests.length === 0) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="6" style="text-align: center; padding: 25px; color: #6a7a6f;">
                        No approved requests recorded yet.
                    </td>
                </tr>
            `;
            return;
        }

        tbody.innerHTML = requests.map(req => {
            const labName = req.lab_name || '-';
            const itemName = req.item_name || '-';
            const reqQty = req.quantity !== undefined && req.quantity !== null ? req.quantity : '-';
            const appQty = req.approved_quantity !== undefined && req.approved_quantity !== null ? req.approved_quantity : reqQty;
            const reqDate = formatDate(req.date || req.created_at || req.approved_at);

            return `
                <tr>
                    <td><strong>${escapeHtml(labName)}</strong></td>
                    <td>${escapeHtml(itemName)}</td>
                    <td>${reqQty}</td>
                    <td><strong>${appQty}</strong></td>
                    <td>${reqDate}</td>
                    <td><span class="badge badge-success">✓ Approved</span></td>
                </tr>
            `;
        }).join('');
    }

    /**
     * Render rejected requests table
     */
    function renderRejectedTable(requests) {
        const container = document.getElementById('rejectedSection');
        const tbody = document.getElementById('rejectedTableBody');
        const countHeader = document.getElementById('rejectedCountHeader');
        if (!tbody || !container) return;

        if (requests.length === 0) {
            container.style.display = 'none';
            return;
        }

        container.style.display = 'block';

        if (countHeader) {
            countHeader.textContent = `✗ Rejected Requests (${requests.length})`;
        }

        tbody.innerHTML = requests.map(req => {
            const labName = req.lab_name || '-';
            const itemName = req.item_name || '-';
            const reqQty = req.quantity !== undefined && req.quantity !== null ? req.quantity : '-';
            const reqDate = formatDate(req.date || req.created_at || req.rejected_at);

            return `
                <tr>
                    <td><strong>${escapeHtml(labName)}</strong></td>
                    <td>${escapeHtml(itemName)}</td>
                    <td>${reqQty}</td>
                    <td>${reqDate}</td>
                    <td><span class="badge badge-danger">✗ Rejected</span></td>
                </tr>
            `;
        }).join('');
    }

    /**
     * Call public.approve_lab_request RPC
     */
    async function executeApproveRpc(requestId) {
        const client = getClient();

        // 1. Try canonical p_request_id signature
        let result = await client.rpc('approve_lab_request', { p_request_id: requestId });

        if (result.error) {
            const errMsg = (result.error.message || '').toLowerCase();
            if (errMsg.includes('parameter') || errMsg.includes('signature') || errMsg.includes('named') || errMsg.includes('not found')) {
                // Try fallback parameter names
                result = await client.rpc('approve_lab_request', { _request_id: requestId });
                if (result.error) {
                    result = await client.rpc('approve_lab_request', { request_id: requestId });
                }
            }
        }

        if (result.error) {
            throw result.error;
        }

        return result.data;
    }

    /**
     * Call public.reject_lab_request RPC
     */
    async function executeRejectRpc(requestId, notes = null) {
        const client = getClient();

        // 1. Try canonical p_request_id signature with optional p_notes
        let result = await client.rpc('reject_lab_request', { 
            p_request_id: requestId,
            p_notes: notes 
        });

        if (result.error) {
            const errMsg = (result.error.message || '').toLowerCase();
            if (errMsg.includes('parameter') || errMsg.includes('signature') || errMsg.includes('named') || errMsg.includes('not found')) {
                // Try fallback parameter names
                result = await client.rpc('reject_lab_request', { _request_id: requestId });
                if (result.error) {
                    result = await client.rpc('reject_lab_request', { request_id: requestId });
                }
            }
        }

        if (result.error) {
            throw result.error;
        }

        return result.data;
    }

    /**
     * Handle user click on Approve button
     */
    async function handleApprove(requestId, itemName, quantity) {
        const confirmed = window.confirm(
            `Confirm Stock Approval:\n\nAre you sure you want to approve this request for ${quantity} unit(s) of "${itemName}"?\n\nThis will automatically deduct the stock from Store Inventory.`
        );

        if (!confirmed) return;

        const row = document.getElementById(`req-row-${requestId}`);
        const buttons = row ? row.querySelectorAll('button') : [];
        buttons.forEach(btn => btn.disabled = true);

        try {
            await executeApproveRpc(requestId);
            showFeedback('success', `Request for ${quantity} unit(s) of "${itemName}" approved successfully! Store inventory has been updated.`);
            await loadAll();
        } catch (err) {
            console.error('Approve RPC failed:', err);
            const msg = err.message || 'Failed to approve request. Please check available stock.';
            showFeedback('error', msg);
            buttons.forEach(btn => btn.disabled = false);
        }
    }

    /**
     * Handle user click on Reject button
     */
    async function handleReject(requestId, itemName) {
        const confirmed = window.confirm(
            `Confirm Request Rejection:\n\nAre you sure you want to reject the request for "${itemName}"?`
        );

        if (!confirmed) return;

        const row = document.getElementById(`req-row-${requestId}`);
        const buttons = row ? row.querySelectorAll('button') : [];
        buttons.forEach(btn => btn.disabled = true);

        try {
            await executeRejectRpc(requestId);
            showFeedback('success', `Request for "${itemName}" has been rejected.`);
            await loadAll();
        } catch (err) {
            console.error('Reject RPC failed:', err);
            const msg = err.message || 'Failed to reject request.';
            showFeedback('error', msg);
            buttons.forEach(btn => btn.disabled = false);
        }
    }

    /**
     * Load all queues concurrently
     */
    async function loadAll() {
        try {
            const [pending, approved, rejected] = await Promise.all([
                fetchPendingRequests(),
                fetchApprovedRequests(),
                fetchRejectedRequests()
            ]);

            pendingList = pending;
            approvedList = approved;
            rejectedList = rejected;

            renderPendingTable(pendingList);
            renderApprovedTable(approvedList);
            renderRejectedTable(rejectedList);
        } catch (err) {
            console.error('Error loading request queues:', err);
            showFeedback('error', 'Unable to retrieve requests data from Supabase.');
        }
    }

    /**
     * Initialize Module
     */
    async function init() {
        const client = getClient();
        const pendingTbody = document.getElementById('pendingTableBody');
        const approvedTbody = document.getElementById('approvedTableBody');

        if (pendingTbody) {
            pendingTbody.innerHTML = `
                <tr>
                    <td colspan="6" style="text-align: center; padding: 25px; color: var(--text-soft);">
                        ⏳ Loading pending requisitions from Supabase...
                    </td>
                </tr>
            `;
        }
        if (approvedTbody) {
            approvedTbody.innerHTML = `
                <tr>
                    <td colspan="6" style="text-align: center; padding: 20px; color: var(--text-soft);">
                        ⏳ Loading approved request history...
                    </td>
                </tr>
            `;
        }

        // Ensure Store Admin profile role is active in database
        try {
            const session = await auth.getSession();
            const user = session?.user;
            if (user && user.email && (user.email.toLowerCase() === 'vedantpatil230406@gmail.com' || user.email.toLowerCase() === 'rathodstudents@gmail.com' || user.email.toLowerCase().startsWith('admin'))) {
                await client.from('profiles').upsert([{
                    id: user.id,
                    role: 'store',
                    display_name: 'Store Admin',
                    updated_at: new Date().toISOString()
                }]);
            }
        } catch (syncErr) {
            console.warn('Store admin profile check notice:', syncErr);
        }

        await loadAll();
    }

    return {
        init,
        loadAll,
        handleApprove,
        handleReject,
        fetchPendingRequests,
        fetchApprovedRequests,
        fetchRejectedRequests
    };
}));
