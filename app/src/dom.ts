// getElementById that throws instead of returning null. Every id lives in
// our own index.html, so a miss is a startup bug: failing fast beats
// null-checking thirty-five lookups.
export function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node as T;
}

/**
 * Look up an inline SVG by id. Separate from {@link el} because SVG roots are
 * SVGSVGElement, not HTMLElement.
 *
 * @param id - Element id from index.html
 * @returns The SVG root element
 * @throws If the id is missing or not an SVGSVGElement
 */
export function svgEl(id: string): SVGSVGElement {
  const node = document.getElementById(id);
  if (!(node instanceof SVGSVGElement)) throw new Error(`Missing SVG #${id}`);
  return node;
}
