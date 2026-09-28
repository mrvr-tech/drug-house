/**
 * Application Configuration
 * 
 * Provides Supabase Project URL and Anon/Publishable Key.
 * 
 * Supports:
 * 1. Runtime environment variables injected via window.__ENV__ (for Vercel/production)
 * 2. LocalStorage override (for local development/testing)
 * 3. Default fallback values
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.APP_CONFIG = factory();
    }
}(typeof self !== 'undefined' ? self : this, function () {
    const env = (typeof window !== 'undefined' && window.__ENV__) || {};
    const storage = (typeof window !== 'undefined' && window.localStorage) || null;

    // Supabase credentials (can be overridden via window.__ENV__ or localStorage)
    const SUPABASE_URL = 
        env.SUPABASE_URL ||
        env.NEXT_PUBLIC_SUPABASE_URL ||
        env.VITE_SUPABASE_URL ||
        (storage && storage.getItem('SUPABASE_URL')) ||
        'https://mvrnwffoichjorferigo.supabase.co';

    const SUPABASE_ANON_KEY = 
        env.SUPABASE_ANON_KEY ||
        env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
        env.VITE_SUPABASE_ANON_KEY ||
        (storage && storage.getItem('SUPABASE_ANON_KEY')) ||
        'sb_publishable_-bdULoXJ2P3KVMk5DPHZXw_S7sPL9JP';

    const DEFAULT_EMAIL_DOMAIN = env.DEFAULT_EMAIL_DOMAIN || 'pharmacy.com';
    const ADMIN_EMAIL = env.ADMIN_EMAIL || 'vedantpatil230406@gmail.com';

    return {
        SUPABASE_URL,
        SUPABASE_ANON_KEY,
        DEFAULT_EMAIL_DOMAIN,
        ADMIN_EMAIL,
        /**
         * Update credentials dynamically in local storage if needed
         */
        setCredentials(url, anonKey) {
            if (storage) {
                if (url) storage.setItem('SUPABASE_URL', url);
                if (anonKey) storage.setItem('SUPABASE_ANON_KEY', anonKey);
            }
        }
    };
}));
