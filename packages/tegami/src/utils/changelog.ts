export function changelogFilename(disambiguator = 0): string {
  const date = new Date();
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hash = (Date.now() + disambiguator).toString(36);

  return `${yyyy}-${mm}-${dd}-${hash}.md`;
}
