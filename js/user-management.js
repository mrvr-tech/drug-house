/**
 * User & Lab Management Module (Store Admin)
 * 
 * Handles client-side management of application users and laboratories
 * via secure Supabase Edge Function (admin-management).
 * 
 * Capabilities strictly limited to:
 * 1. Add User (Store / Lab)
 * 2. Remove User
 * 3. Add Lab
 * 4. Remove Lab
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory(require('./config'), require('./supabase'), require('./auth'));
    } else {
        root.UserManagementModule = factory(root.APP_CONFIG, root.SupabaseService, root.Auth);
    }
}(typeof self !== 'undefined' ? self : this, function (config, supabaseService, auth) {

    let cachedUsers = [];
    let cachedLabs = [];
    let currentTab = 'users';

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
     * Escape HTML string to prevent XSS
     */
    function escapeHtml(str) {
        if (!str) return '';
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    /**
     * Format ISO timestamp to readable date/time
     */
    function formatDateTime(isoStr) {
        if (!isoStr) return '-';
        try {
            const d = new Date(isoStr);
            if (isNaN(d.getTime())) return isoStr;
            return d.toLocaleDateString('en-GB', {
                day: '2-digit',
                month: 'short',
                year: 'numeric'
            });
        } catch {
            return isoStr;
        }
    }

    /**
     * Invoke Admin Management Edge Function with Caller's Auth Token
     */
    async function invokeAdminFunction(action, payload = {}) {
        const client = getClient();
        const { data: { session } } = await client.auth.getSession();

        if (!session || !session.access_token) {
            throw new Error('Unauthorized: You must be logged in as Store Admin to perform this action.');
        }

        const bodyData = { action, ...payload };

        // 1. Try supabase.functions.invoke first
        if (client.functions && typeof client.functions.invoke === 'function') {
            try {
                const { data, error } = await client.functions.invoke('admin-management', {
                    body: bodyData,
                    headers: {
                        Authorization: `Bearer ${session.access_token}`
                    }
                });

                if (!error && data && data.success) {
                    return data;
                }
                if (error || (data && data.error)) {
                    const msg = (data && data.error) || (error && error.message) || 'Operation failed.';
                    throw new Error(msg);
                }
            } catch (err) {
                // If functions.invoke failed due to network / local endpoint, fallback to direct fetch
                console.warn('functions.invoke warning, falling back to direct Edge Function fetch:', err.message);
            }
        }

        // 2. Direct fetch fallback to Edge Function URL
        const edgeFunctionUrl = `${config.SUPABASE_URL}/functions/v1/admin-management`;
        const res = await fetch(edgeFunctionUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${session.access_token}`,
                'apikey': config.SUPABASE_ANON_KEY
            },
            body: JSON.stringify(bodyData)
        });

        const json = await res.json().catch(() => ({}));
        if (!res.ok || json.error) {
            throw new Error(json.error || `Server responded with status ${res.status}`);
        }

        return json;
    }

    /**
     * Load Users and Labs from backend
     */
    async function loadData() {
        const client = getClient();
        const alertBox = document.getElementById('managementAlert');
        if (alertBox) alertBox.style.display = 'none';

        try {
            // Attempt loading via Edge Function list-users-and-labs
            let users = [];
            let labs = [];

            try {
                const result = await invokeAdminFunction('list-users-and-labs');
                if (result && result.users && result.labs) {
                    users = result.users;
                    labs = result.labs;
                }
            } catch (e) {
                console.warn('Edge Function list query fallback to direct client query:', e.message);
                
                // Fallback direct queries for profiles and labs
                const [profilesRes, labsRes] = await Promise.all([
                    client.from('profiles').select('*').order('created_at', { ascending: false }),
                    client.from('labs').select('*').order('created_at', { ascending: true })
                ]);

                labs = labsRes.data || [];
                const labMap = new Map();
                labs.forEach(l => {
                    const name = l.name || l.lab_name || `Lab ${l.id}`;
                    labMap.set(l.id, name);
                });

                const defaultAdminEmail = (window.APP_CONFIG && window.APP_CONFIG.ADMIN_EMAIL) || 'vedantpatil230406@gmail.com';
                users = (profilesRes.data || []).map(p => ({
                    id: p.id,
                    email: p.role === 'store' ? defaultAdminEmail : (p.display_name ? `${p.display_name.toLowerCase().replace(/\s+/g, '')}@pharmacy.com` : '-'),
                    display_name: p.display_name || (p.role === 'store' ? 'Store Keeper' : 'Vendor User'),
                    role: p.role,
                    lab_id: p.lab_id,
                    lab_name: p.lab_id ? (labMap.get(p.lab_id) || 'Assigned Vendor') : null,
                    created_at: p.created_at
                }));
            }

            cachedUsers = users;
            cachedLabs = labs;

            renderUsersTable(users);
            renderLabsTable(labs);
            populateLabDropdown(labs);

            // Update stats badge
            const userCountEl = document.getElementById('totalUsersCount');
            if (userCountEl) userCountEl.textContent = users.length;

            const labCountEl = document.getElementById('totalLabsCount');
            if (labCountEl) labCountEl.textContent = labs.length;

        } catch (err) {
            console.error('Error loading management data:', err);
            showAlert('error', 'Failed to load user and vendor records: ' + (err.message || err));
        }
    }

    /**
     * Render Users Table
     */
    function renderUsersTable(users) {
        const tbody = document.getElementById('usersTableBody');
        if (!tbody) return;

        if (!users || users.length === 0) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="5" style="text-align: center; padding: 30px; color: #6a7a6f;">
                        👥 No application users found.
                    </td>
                </tr>
            `;
            return;
        }

        tbody.innerHTML = users.map(user => {
            const roleBadge = user.role === 'store'
                ? '<span class="badge badge-success">Store Admin</span>'
                : '<span class="badge badge-warning">Vendor User</span>';

            const labDisplay = user.role === 'store' 
                ? '<em style="color: #8c9b91;">N/A (Store Admin)</em>'
                : `<strong>${escapeHtml(user.lab_name || 'Vendor')}</strong>`;

            return `
                <tr>
                    <td><strong>${escapeHtml(user.display_name || 'User')}</strong></td>
                    <td>${escapeHtml(user.email || '-')}</td>
                    <td>${roleBadge}</td>
                    <td>${labDisplay}</td>
                    <td>
                        <button type="button" class="btn-danger-sm" onclick="UserManagementModule.handleRemoveUser('${user.id}', '${escapeHtml(user.display_name)}')">
                            🗑️ Remove
                        </button>
                    </td>
                </tr>
            `;
        }).join('');
    }

    /**
     * Render Labs Table
     */
    function renderLabsTable(labs) {
        const tbody = document.getElementById('labsTableBody');
        if (!tbody) return;

        if (!labs || labs.length === 0) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="3" style="text-align: center; padding: 30px; color: #6a7a6f;">
                        🏢 No vendors configured.
                    </td>
                </tr>
            `;
            return;
        }

        tbody.innerHTML = labs.map(lab => {
            const labName = lab.name || lab.lab_name || `Vendor ${lab.id}`;
            const createdAt = formatDateTime(lab.created_at);

            return `
                <tr>
                    <td><strong>${escapeHtml(labName)}</strong></td>
                    <td>${createdAt}</td>
                    <td>
                        <button type="button" class="btn-danger-sm" onclick="UserManagementModule.handleRemoveLab('${lab.id}', '${escapeHtml(labName)}')">
                            🗑️ Remove Vendor
                        </button>
                    </td>
                </tr>
            `;
        }).join('');
    }

    /**
     * Create a Laboratory with Edge Function first and direct database insert fallback
     */
    async function createLabDirect(labName) {
        const cleanName = (labName || '').trim();
        if (!cleanName) throw new Error('Vendor name is required.');

        try {
            const result = await invokeAdminFunction('create-lab', { name: cleanName });
            return result.lab || { name: cleanName };
        } catch (edgeErr) {
            console.warn('Edge function create-lab failed, attempting direct table insert:', edgeErr.message);
            const client = getClient();
            const { data, error } = await client
                .from('labs')
                .insert([{ name: cleanName }])
                .select()
                .single();

            if (error) {
                if (error.code === '42501' || (error.message && error.message.includes('row-level security'))) {
                    throw new Error('Database permission error: Table "labs" requires an RLS insert policy for authenticated users. Please run the SQL setup script in Supabase.');
                }
                throw new Error(error.message || edgeErr.message);
            }
            return data;
        }
    }

    /**
     * Populate Lab Selection dropdown inside Add User Modal
     */
    function populateLabDropdown(labs) {
        const select = document.getElementById('userLabSelect');
        const noLabsNotice = document.getElementById('noLabsNotice');
        if (!select) return;

        if (!labs || labs.length === 0) {
            select.innerHTML = '<option value="">-- No Vendors Found (Add a vendor first) --</option>';
            if (noLabsNotice) noLabsNotice.style.display = 'block';
            return;
        }

        if (noLabsNotice) noLabsNotice.style.display = 'none';
        select.innerHTML = '<option value="">-- Select Vendor --</option>' +
            labs.map(lab => {
                const name = lab.name || `Vendor ${lab.id}`;
                return `<option value="${lab.id}">${escapeHtml(name)}</option>`;
            }).join('');
    }

    /**
     * Quick Add Lab Prompt
     */
    async function quickAddLabPrompt() {
        const defaultName = `Vendor ${(cachedLabs ? cachedLabs.length : 0) + 1}`;
        const inputName = prompt('Enter New Vendor Name (e.g. Vendor 1, Wholesale Client A):', defaultName);
        if (!inputName || !inputName.trim()) return;

        try {
            showAlert('success', `⏳ Creating vendor "${inputName.trim()}"...`);
            const newLab = await createLabDirect(inputName.trim());
            showAlert('success', `Vendor "${inputName.trim()}" added successfully!`);
            await loadData();
            
            // Auto-select newly created lab in dropdown
            const select = document.getElementById('userLabSelect');
            if (select && newLab && newLab.id) {
                select.value = newLab.id;
            }
        } catch (err) {
            console.error('Quick Add Vendor error:', err);
            showAlert('error', err.message || 'Failed to add vendor.');
        }
    }

    /**
     * Seed Standard Vendors (1 to 10)
     */
    async function seedStandardLabs() {
        const standardNames = [
            'Vendor 1 - Wholesale',
            'Vendor 2 - General Pharmacy',
            'Vendor 3 - City Drug House',
            'Vendor 4 - MedPlus Store',
            'Vendor 5 - Apollo Partner',
            'Vendor 6 - Care Pharmacy',
            'Vendor 7 - LifeLine Medicals',
            'Vendor 8 - Sanjeevani Store',
            'Vendor 9 - HealthFirst Pharma',
            'Vendor 10 - Standard Chemists'
        ];

        if (!confirm(`Do you want to initialize all ${standardNames.length} standard vendors?\n\nThis will add standard vendors (Vendor 1 to Vendor 10) to the database.`)) {
            return;
        }

        showAlert('success', `⏳ Provisioning standard vendors...`);

        try {
            const client = getClient();
            const existingNames = new Set(
                (cachedLabs || []).map(l => (l.name || '').toLowerCase().trim())
            );

            const toInsert = standardNames
                .filter(name => !existingNames.has(name.toLowerCase().trim()))
                .map(name => ({ name }));

            if (toInsert.length === 0) {
                showAlert('success', 'All standard vendors are already configured in the database.');
                return;
            }

            // Batch insert directly into labs table
            const { error: insertErr } = await client.from('labs').insert(toInsert);

            if (insertErr) {
                if (insertErr.code === '42501' || (insertErr.message && insertErr.message.includes('row-level security'))) {
                    throw new Error('Database permission error: Table "labs" requires an RLS insert policy for authenticated users. Please run the SQL setup script in Supabase.');
                }
                throw insertErr;
            }

            showAlert('success', `✅ Successfully initialized ${toInsert.length} vendors!`);
            await loadData();

        } catch (err) {
            console.error('Seed Standard Vendors error:', err);
            showAlert('error', err.message || 'Failed to seed vendors.');
        }
    }

    /**
     * Alert Banner Helper
     */
    function showAlert(type, message) {
        const alertBox = document.getElementById('managementAlert');
        if (!alertBox) return;

        alertBox.className = `alert alert-${type === 'success' ? 'success' : 'danger'}`;
        alertBox.innerHTML = `<strong>${type === 'success' ? '✅' : '❌'}</strong> ${escapeHtml(message)}`;
        alertBox.style.display = 'block';
        alertBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    /**
     * Modal Helpers
     */
    function openModal(modalId) {
        const modal = document.getElementById(modalId);
        if (modal) modal.classList.add('is-active');
    }

    function closeModal(modalId) {
        const modal = document.getElementById(modalId);
        if (modal) modal.classList.remove('is-active');
    }

    /**
     * Handle Add User Submission
     */
    async function handleAddUserSubmit(e) {
        if (e && e.preventDefault) e.preventDefault();

        const form = document.getElementById('addUserForm');
        const submitBtn = document.getElementById('addUserSubmitBtn');
        const errorEl = document.getElementById('addUserError');

        if (errorEl) errorEl.style.display = 'none';

        const displayName = document.getElementById('userDisplayName')?.value.trim();
        const email = document.getElementById('userEmail')?.value.trim();
        const userType = document.getElementById('userTypeSelect')?.value;
        const labId = document.getElementById('userLabSelect')?.value;
        const password = document.getElementById('userPassword')?.value;

        if (!displayName || !email || !password || !userType) {
            if (errorEl) {
                errorEl.textContent = 'Please fill out all required fields.';
                errorEl.style.display = 'block';
            }
            return;
        }

        if (userType === 'lab' && !labId) {
            if (errorEl) {
                errorEl.textContent = (cachedLabs.length === 0)
                    ? 'No vendors exist. Click "+ Quick Add Vendor" above to create one first.'
                    : 'Please select an assigned vendor for this Vendor user.';
                errorEl.style.display = 'block';
            }
            return;
        }

        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.textContent = '⏳ Creating User...';
        }

        const client = getClient();

        try {
            let result;
            try {
                result = await invokeAdminFunction('create-user', {
                    display_name: displayName,
                    email: email,
                    password: password,
                    user_type: userType,
                    lab_id: userType === 'lab' ? labId : null
                });
            } catch (edgeErr) {
                console.warn('Edge function create-user failed, attempting direct signup & profile creation fallback:', edgeErr.message);
                
                // Fallback: Supabase signUp and profile insert
                const { data: signUpData, error: signUpErr } = await client.auth.signUp({
                    email: email,
                    password: password,
                    options: {
                        data: {
                            role: userType,
                            display_name: displayName,
                            lab_id: userType === 'lab' ? labId : null
                        }
                    }
                });

                if (signUpErr || !signUpData.user) {
                    throw new Error(signUpErr?.message || edgeErr.message);
                }

                // Insert into public.profiles
                await client.from('profiles').upsert({
                    id: signUpData.user.id,
                    role: userType,
                    lab_id: userType === 'lab' ? labId : null,
                    display_name: displayName
                });

                result = {
                    message: `User "${displayName}" created successfully!`
                };
            }

            closeModal('addUserModal');
            if (form) form.reset();
            showAlert('success', result.message || `User "${displayName}" created successfully!`);
            await loadData();

        } catch (err) {
            console.error('Create User error:', err);
            if (errorEl) {
                errorEl.textContent = err.message || 'Failed to create user.';
                errorEl.style.display = 'block';
            }
        } finally {
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.textContent = 'Create User';
            }
        }
    }

    /**
     * Handle Remove User Action
     */
    async function handleRemoveUser(userId, displayName) {
        if (!confirm(`Are you sure you want to remove user "${displayName}"?\n\nThis will remove the user account permanently.`)) {
            return;
        }

        try {
            const result = await invokeAdminFunction('delete-user', { user_id: userId });
            showAlert('success', result.message || `User "${displayName}" removed successfully.`);
            await loadData();
        } catch (err) {
            console.error('Delete User error:', err);
            showAlert('error', err.message || 'Failed to remove user.');
        }
    }

    /**
     * Handle Add Lab Submission
     */
    async function handleAddLabSubmit(e) {
        if (e && e.preventDefault) e.preventDefault();

        const form = document.getElementById('addLabForm');
        const submitBtn = document.getElementById('addLabSubmitBtn');
        const errorEl = document.getElementById('addLabError');

        if (errorEl) errorEl.style.display = 'none';

        const labName = document.getElementById('labNameInput')?.value.trim();

        if (!labName) {
            if (errorEl) {
                errorEl.textContent = 'Vendor name is required.';
                errorEl.style.display = 'block';
            }
            return;
        }

        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.textContent = '⏳ Creating Vendor...';
        }

        try {
            await createLabDirect(labName);
            closeModal('addLabModal');
            if (form) form.reset();
            showAlert('success', `Vendor "${labName}" created successfully!`);
            await loadData();

        } catch (err) {
            console.error('Create Vendor error:', err);
            if (errorEl) {
                errorEl.textContent = err.message || 'Failed to create vendor.';
                errorEl.style.display = 'block';
            }
        } finally {
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.textContent = 'Create Vendor';
            }
        }
    }

    /**
     * Handle Remove Lab Action
     */
    async function handleRemoveLab(labId, labName) {
        if (!confirm(`Are you sure you want to remove vendor "${labName}"?\n\nThis operation will only succeed if no active users or requisition history depend on this vendor.`)) {
            return;
        }

        try {
            const result = await invokeAdminFunction('delete-lab', { lab_id: labId });
            showAlert('success', result.message || `Vendor "${labName}" removed successfully.`);
            await loadData();
        } catch (err) {
            console.error('Delete Vendor error:', err);
            showAlert('error', err.message || 'Failed to remove vendor.');
        }
    }

    /**
     * Toggle between Users and Labs tabs
     */
    function switchTab(tab) {
        currentTab = tab;
        const usersSection = document.getElementById('usersSection');
        const labsSection = document.getElementById('labsSection');
        const tabUsersBtn = document.getElementById('tabUsersBtn');
        const tabLabsBtn = document.getElementById('tabLabsBtn');

        if (tab === 'users') {
            if (usersSection) usersSection.style.display = 'block';
            if (labsSection) labsSection.style.display = 'none';
            if (tabUsersBtn) tabUsersBtn.classList.add('is-active');
            if (tabLabsBtn) tabLabsBtn.classList.remove('is-active');
        } else {
            if (usersSection) usersSection.style.display = 'none';
            if (labsSection) labsSection.style.display = 'block';
            if (tabUsersBtn) tabUsersBtn.classList.remove('is-active');
            if (tabLabsBtn) tabLabsBtn.classList.add('is-active');
        }
    }

    /**
     * User Type Change Listener (Toggles Lab selection visibility)
     */
    function handleUserTypeChange() {
        const typeSelect = document.getElementById('userTypeSelect');
        const labGroup = document.getElementById('userLabGroup');
        const labSelect = document.getElementById('userLabSelect');

        if (typeSelect && labGroup && labSelect) {
            if (typeSelect.value === 'lab') {
                labGroup.style.display = 'block';
                labSelect.required = true;
            } else {
                labGroup.style.display = 'none';
                labSelect.required = false;
                labSelect.value = '';
            }
        }
    }

    /**
     * Initialize Module
     */
    function init() {
        // Form event listeners
        const addUserForm = document.getElementById('addUserForm');
        if (addUserForm) addUserForm.addEventListener('submit', handleAddUserSubmit);

        const addLabForm = document.getElementById('addLabForm');
        if (addLabForm) addLabForm.addEventListener('submit', handleAddLabSubmit);

        const userTypeSelect = document.getElementById('userTypeSelect');
        if (userTypeSelect) userTypeSelect.addEventListener('change', handleUserTypeChange);

        // Load initial table records
        loadData();
    }

    return {
        init,
        loadData,
        switchTab,
        openModal,
        closeModal,
        handleAddUserSubmit,
        handleRemoveUser,
        handleAddLabSubmit,
        handleRemoveLab,
        createLabDirect,
        quickAddLabPrompt,
        seedStandardLabs,
        invokeAdminFunction
    };
}));
