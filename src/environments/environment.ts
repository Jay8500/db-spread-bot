// Public client config for THIS app's own control-plane Supabase project
// (never the Supabase projects it connects to — those credentials live in
// Vault, server-side only). The anon key is safe to ship; RLS protects it.
export const environment = {
  production: true,
  supabaseUrl: 'https://dxmgmfoufotcobvuhqrw.supabase.co',
  supabaseAnonKey: 'sb_publishable_qhzQPEYx-Q8PzSK7UGGJFw_4LllN8Wa',
  brand: {
    name: 'Spread Apps',
    product: 'DB Spread Bot',
    logo: '/brand/spreadapps-icon.png',
    website: 'https://spreadapps.in',
  },
};
