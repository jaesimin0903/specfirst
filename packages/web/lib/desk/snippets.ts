/* Embed and API snippets shown next to results. Pure, so pages and tests build the same text. */

export function badgeMarkdown(origin: string, badgePath: string, vaultPath: string): string {
  return `[![Specfirst ERC-4626 check](${origin}${badgePath})](${origin}${vaultPath})`;
}

export function badgeHtml(origin: string, badgePath: string, vaultPath: string): string {
  return `<a href="${origin}${vaultPath}"><img src="${origin}${badgePath}" alt="Specfirst ERC-4626 check" height="20"></a>`;
}

export function apiCurl(origin: string, apiPath: string): string {
  return `curl -s ${origin}${apiPath} | jq '{status: .report.status, maxHonored, compliant: .attestation.isCompliant}'`;
}
