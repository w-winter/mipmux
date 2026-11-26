/** The first nonblank line of a discovery template section, so tests can find a rendered section without fixing its wording. */
export function templateSectionLine(template: string, section: string): string {
  const body = template.split(`<!-- mipmux:section ${section} -->\n`)[1]?.split('<!-- mipmux:end -->')[0];
  const line = body?.split('\n').find(text => text.trim() !== '');
  if (line === undefined) throw new Error(`Template section ${section} has no text`);
  return line;
}
