
import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY;

console.info('[Supabase diagnostic]', {
  urlPresent: Boolean(url),
  keyPresent: Boolean(key),
  urlIsPlaceholder: Boolean(url?.includes('your-project')),
  keyIsPlaceholder: Boolean(key?.includes('your-supabase')),
  urlHasHttps: Boolean(url?.startsWith('https://')),
});

export const supabase =
  url &&
  key &&
  !url.includes('your-project') &&
  !key.includes('your-supabase')
    ? createClient(url, key)
    : null;
