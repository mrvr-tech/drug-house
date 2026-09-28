/**
 * Authentication and Session Management Service
 * 
 * Handles:
 * - Supabase Email/Password login with username resolution
 * - Profile retrieval and role detection ('store' vs 'lab')
 * - Page & route protection
 * - Dynamic user chip rendering in navigation
 * - Logout handling across Store and Lab portals
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory(require('./config'), require('./supabase'));
    } else {
        root.Auth = factory(root.APP_CONFIG, root.SupabaseService);
    }
}(typeof self !== 'undefined' ? self : this, function (config, supabaseService) {

    /**
     * Get the initialized Supabase client
     * @returns {import('@supabase/supabase-js').SupabaseClient}
     */
    function getClient() {
        const client = supabaseService && supabaseService.getClient();
        if (!client) {
            throw new Error('Supabase client is not available. Check script imports.');
        }
        return client;
    }

    /**
     * Resolve email from username or email string
     * e.g. "admin" -> "admin@pharmacy.com", "lab1" -> "lab1@pharmacy.com"
     */
    function resolveEmail(identifier) {
        if (!identifier) return '';
        const trimmed = identifier.trim();
        if (trimmed.includes('@')) {
            return trimmed;
        }
        const lower = trimmed.toLowerCase();
        if (lower === 'admin') {
            return (config && config.ADMIN_EMAIL) || 'vedantpatil230406@gmail.com';
        }
        const domain = (config && config.DEFAULT_EMAIL_DOMAIN) || 'pharmacy.com';
        return `${lower}@${domain}`;
    }

    /**
     * Determine the correct relative path to login.html based on current URL
     */
    function getLoginPath() {
        const path = window.location.pathname;
        if (path.includes('/store/') || path.includes('/lab/')) {
            return '../login.html';
        }
        return 'login.html';
    }

    /**
     * Determine the correct dashboard URL for a given role
     */
    function getDashboardUrl(role) {
        const path = window.location.pathname;
        const isInSubdir = path.includes('/store/') || path.includes('/lab/');
        
        if (role === 'store') {
            return isInSubdir ? '../store/dashboard.html' : 'store/dashboard.html';
        } else if (role === 'lab') {
            return isInSubdir ? '../lab/dashboard.html' : 'lab/dashboard.html';
        }
        return getLoginPath();
    }

    /**
     * Fetch user profile record from public.profiles table
     */
    async function fetchProfile(userId) {
        if (!userId) return null;
        const client = getClient();
        
        try {
            const { data, error } = await client
                .from('profiles')
                .select('*')
                .eq('id', userId)
                .single();

            if (error) {
                console.warn('Profile fetch warning:', error.message);
                return null;
            }
            return data;
        } catch (err) {
            console.error('Error fetching profile from Supabase:', err);
            return null;
        }
    }

    /**
     * Get the cached profile or fetch from database
     */
    async function getCurrentProfile(user) {
        if (!user && !user?.id) {
            const session = await getSession();
            user = session?.user;
        }
        if (!user) return null;

        // Check sessionStorage cache
        const cached = sessionStorage.getItem('pharmacy_user_profile');
        if (cached) {
            try {
                const parsed = JSON.parse(cached);
                if (parsed && parsed.id === user.id) {
                    return parsed;
                }
            } catch (e) {
                sessionStorage.removeItem('pharmacy_user_profile');
            }
        }

        // Fetch fresh profile from Supabase
        const profile = await fetchProfile(user.id);
        if (profile) {
            // Attach email for UI display purposes
            profile.email = user.email || '';
            sessionStorage.setItem('pharmacy_user_profile', JSON.stringify(profile));
            return profile;
        }

        // Do not infer or promote an admin role from email alone.
        // The live public.profiles record is authoritative.
        console.warn(`No authoritative profile record found in public.profiles for user ID: ${user.id}`);
        return null;
    }

    /**
     * Get active Supabase session
     */
    async function getSession() {
        const client = getClient();
        const { data: { session }, error } = await client.auth.getSession();
        if (error) {
            console.error('Error getting session:', error);
            return null;
        }
        return session;
    }

    /**
     * Authenticate user with Supabase Auth
     * 
     * @param {string} identifier - Username or email
     * @param {string} password - Password
     * @returns {Promise<{ user: Object, profile: Object, session: Object, redirectUrl: string }>}
     */
    async function login(identifier, password) {
        const client = getClient();
        const email = resolveEmail(identifier);

        if (!email || !password) {
            throw new Error('Please enter both username/email and password.');
        }

        const { data, error } = await client.auth.signInWithPassword({
            email: email,
            password: password
        });

        if (error) {
            throw new Error(error.message || 'Invalid username or password.');
        }

        if (!data || !data.user) {
            throw new Error('Login failed: No user returned from authentication server.');
        }

        // Fetch user profile from Supabase profiles table
        const profile = await getCurrentProfile(data.user);
        if (!profile || !profile.role) {
            await client.auth.signOut();
            sessionStorage.removeItem('pharmacy_user_profile');
            throw new Error('Access denied: No profile record found for this account. Please contact Store Administration.');
        }
        const role = profile.role;
        const redirectUrl = getDashboardUrl(role);

        return {
            user: data.user,
            profile: profile,
            session: data.session,
            redirectUrl: redirectUrl
        };
    }

    /**
     * Sign out current user and redirect to login
     */
    async function logout(event) {
        if (event && event.preventDefault) {
            event.preventDefault();
        }

        try {
            const client = getClient();
            await client.auth.signOut();
        } catch (err) {
            console.warn('Sign out error:', err);
        } finally {
            sessionStorage.removeItem('pharmacy_user_profile');
            window.location.href = getLoginPath();
        }
    }

    /**
     * Update the navigation user chip and bind logout handlers
     */
    function updateNavbar(profile) {
        if (!profile) return;

        // Update user chip in navbar
        const userChip = document.querySelector('.user-chip');
        if (userChip) {
            if (profile.role === 'store') {
                const displayName = profile.display_name || profile.full_name || profile.username || 'Store Keeper';
                userChip.textContent = `Store Admin: ${displayName}`;
            } else if (profile.role === 'lab') {
                const displayName = profile.display_name || profile.lab_name || profile.full_name || profile.username || 'Vendor User';
                userChip.textContent = `Vendor User: ${displayName}`;
            }
        }

        // Attach logout event listeners to all logout buttons/links
        const logoutLinks = document.querySelectorAll('a[href*="logout"], a[href*="login.html"], [data-action="logout"]');
        logoutLinks.forEach(link => {
            if (link.textContent.toLowerCase().includes('logout') || link.getAttribute('data-action') === 'logout') {
                link.addEventListener('click', logout);
            }
        });
    }

    /**
     * Page protection helper
     * Ensures user is authenticated and possesses the required role.
     * 
     * @param {'store' | 'lab'} expectedRole
     */
    async function requireAuth(expectedRole) {
        const client = getClient();
        
        try {
            const { data: { session }, error } = await client.auth.getSession();

            if (error || !session || !session.user) {
                console.warn('Unauthorized: No active session. Redirecting to login.');
                window.location.href = getLoginPath();
                return null;
            }

            const profile = await getCurrentProfile(session.user);

            if (!profile) {
                console.warn('Unauthorized: Unable to load profile. Redirecting to login.');
                window.location.href = getLoginPath();
                return null;
            }

            // Check if user has the expected role for this page
            if (expectedRole && profile.role !== expectedRole) {
                console.warn(`Forbidden: User role "${profile.role}" does not match required role "${expectedRole}". Redirecting to login.`);
                window.location.href = getLoginPath();
                return null;
            }

            // User is authenticated and authorized
            updateNavbar(profile);

            return {
                user: session.user,
                profile: profile,
                session: session
            };
        } catch (err) {
            console.error('Error in requireAuth:', err);
            window.location.href = getLoginPath();
            return null;
        }
    }

    /**
     * Auto-redirect from login page if already authenticated
     */
    async function redirectIfAuthenticated() {
        try {
            const client = getClient();
            const { data: { session } } = await client.auth.getSession();

            if (session && session.user) {
                const profile = await getCurrentProfile(session.user);
                if (profile && profile.role) {
                    window.location.href = getDashboardUrl(profile.role);
                }
            }
        } catch (err) {
            console.warn('Session check on public page:', err);
        }
    }

    return {
        login,
        logout,
        getSession,
        getCurrentProfile,
        requireAuth,
        redirectIfAuthenticated,
        resolveEmail,
        getDashboardUrl
    };
}));
