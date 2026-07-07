// getElementById that throws instead of returning null. Every id lives in
// our own index.html, so a miss is a startup bug: failing fast beats
// null-checking thirty-five lookups.
export function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node as T;
}
