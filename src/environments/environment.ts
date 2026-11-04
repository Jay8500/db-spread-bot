// Public client config for THIS app's own control-plane Supabase project
// (never the Supabase projects it connects to — those credentials live in
// Vault, server-side only). The anon key is safe to ship; RLS protects it.
export const environment = {
  production: true,
  supabaseUrl: 'https://dxmgmfoufotcobvuhqrw.supabase.co',
  supabaseAnonKey: 'sb_publishable_qhzQPEYx-Q8PzSK7UGGJFw_4LllN8Wa',
  // "Connect with Supabase" OAuth app (org settings → OAuth Apps). The client
  // ID is public; the secret lives only in the edge function's secrets.
  supabaseOAuthClientId: '1e4e6bcb-1f3f-4a77-ac5f-bc796587a567',
  brand: {
    name: 'Spread Apps',
    product: 'DB Spread Bot',
    logo: '/brand/spreadapps-icon.png', // parent company — "Powered by" only
    productLogo: '/brand/dbbot-icon.svg', // this product's own icon
    website: 'https://spreadapps.in',
  },
};
