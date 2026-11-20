const MAX_DATA = 1_200_000;
export function visualFormat(data) {
  if (typeof data !== 'string' || data.length > MAX_DATA) return null;
  if (/^data:image\/png;base64,iVBORw0KGgo[\dA-Za-z+/=]*$/.test(data)) return 'png';
  if (!/^data:image\/svg\+xml;base64,[\dA-Za-z+/=]+$/.test(data)) return null;
  let svg;
  try { svg = atob(data.split(',')[1]); } catch { return null; }
  if (!svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" ') || !svg.endsWith('</foreignObject></svg>') || !svg.includes('<foreignObject width="100%" height="100%">')) return null;
  if (/<!DOCTYPE|<!ENTITY|<(?:script|style|iframe|object|embed|link|meta|video|audio|animate|set)\b|<[^>]*\son[\w-]+\s*=/i.test(svg)) return null;
  for (const match of svg.matchAll(/\s(?:src|href|xlink:href)\s*=\s*(["'])(.*?)\1/gi)) if (!/^#[\w:.-]+$/.test(match[2]) && !/^data:image\/png;base64,[\dA-Za-z+/=]+$/.test(match[2])) return null;
  for (const match of svg.matchAll(/url\(([^)]*)\)/gi)) {
    const target = match[1].replace(/&quot;|&#34;/g, '"').replace(/&apos;|&#39;/g, "'").trim().replace(/^['"]|['"]$/g, '');
    if (!/^#[\w:.-]+$/.test(target)) return null;
  }
  return 'svg';
}
