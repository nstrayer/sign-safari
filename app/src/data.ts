// Data files live under BASE_URL (Vite copies app/public/data/ into the
// build), so the app works at any deploy subpath. BASE_URL is "./" here,
// which resolves against the page URL like the old hand-written paths did.
export function dataUrl(name: string): string {
  return `${import.meta.env.BASE_URL}data/${name}`;
}
