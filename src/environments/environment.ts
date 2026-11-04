// Public client config for THIS app's own control-plane Supabase project
// (never the Supabase projects it connects to — those credentials live in
// Vault, server-side only). The anon key is safe to ship; RLS protects it.
export const environment = {
  production: true,
  supabaseUrl: 'REPLACE_WITH_NEW_CONTROL_PLANE_SUPABASE_URL',
  supabaseAnonKey: 'REPLACE_WITH_NEW_CONTROL_PLANE_SUPABASE_ANON_KEY',
  brand: {
    name: 'Spread Apps',
    product: 'DB Spread Bot',
    logo: '/brand/spreadapps-icon.png',
    website: 'https://spreadapps.in',
  },
};
